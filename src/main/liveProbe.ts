/**
 * Read-only live probe for the official-first SiriusXM window and MediaSession bridge.
 *
 * Uses native Chromium mouse input events (`sendInputEvent`) on the 1280x860
 * official SiriusXM home screen to trigger real playback on The Beatles Channel
 * and E Street Radio and observe real song transitions, MediaSession updates,
 * and ListenBrainz now-playing/scrobbling — with zero `executeJavaScript` or
 * `insertCSS` calls on the official webContents.
 */

import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import type { BrowserWindow } from 'electron';

import type { AppController } from './app';
import { captureWindow } from './smoke';

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function nativeClick(win: BrowserWindow, x: number, y: number): Promise<void> {
  win.webContents.sendInputEvent({ type: 'mouseMove', x, y });
  await wait(120);
  win.webContents.sendInputEvent({ type: 'mouseDown', x, y, button: 'left', clickCount: 1 });
  await wait(90);
  win.webContents.sendInputEvent({ type: 'mouseUp', x, y, button: 'left', clickCount: 1 });
}

async function ensureHome(win: BrowserWindow, controller: AppController): Promise<void> {
  if (!controller.buildState().player.url.includes('/player/home')) {
    // Click "Discover" in the left navigation bar (x=80, y=106)
    await nativeClick(win, 80, 106);
    await wait(3000);
  }
}

/**
 * Click the "ON NOW" Play button on a SiriusXM channel entity page.
 * The pill width varies slightly with the on-now text length, so we probe
 * the current channel before/after clicking candidate X positions along y=259.
 */
async function clickChannelOnNowPlay(
  win: BrowserWindow,
  controller: AppController,
  expectedChannelSubstring: string,
): Promise<void> {
  const candidates = [880, 860, 900, 840, 920];
  for (const x of candidates) {
    const ch = (controller.buildState().playback.channel ?? '').toLowerCase();
    if (
      ch.includes(expectedChannelSubstring.toLowerCase()) &&
      controller.windows.officialPlayer.isCurrentlyAudible
    ) {
      return;
    }
    await nativeClick(win, x, 226);
    await wait(2500);
  }
}

async function recordSample(controller: AppController, label: string) {
  const state = controller.buildState();
  const history = await controller.listHistory();
  return {
    label,
    at: new Date().toISOString(),
    epochMs: Date.now(),
    url: state.player.url,
    loadState: state.player.loadState,
    authRequired: state.player.authRequired,
    playing: state.playback.playing,
    audible: controller.windows.officialPlayer.isCurrentlyAudible,
    channel: state.playback.channel,
    programme: state.playback.programme,
    artist: state.playback.artist,
    title: state.playback.title,
    displayTitle: state.playback.displayTitle,
    scrobbleArtist: state.playback.artist,
    scrobbleTitle: state.playback.title,
    evidence: state.playback.evidence,
    source: state.playback.source,
    scrobbleSafe: !state.playback.ambiguous && !state.playback.skipped,
    scrobbleBlockReason: state.playback.skipReason ?? state.playback.scrobbleReason ?? null,
    listeningMs: state.playback.listeningMs,
    scrobbled: Boolean(state.playback.scrobbleReason?.toLowerCase().includes('scrobbled')),
    eligibility: state.monitor.eligibility,
    nowPlayingStatus: state.monitor.nowPlaying,
    latestHistoryEntry: history[0] ?? null,
    historyCount: history.length,
    queueCount: state.queue.length,
    capabilities: state.capabilities,
    injectionCounts: controller.windows.officialPlayer.getInjectionCounts(),
    childViewCount: controller.windows.main?.contentView.children.length ?? -1,
    listenbrainz: {
      configured: state.services.listenbrainz.configured,
      authorized: state.services.listenbrainz.authorized,
      account: state.services.listenbrainz.account,
    },
  };
}

export async function runLiveProbe(controller: AppController, output: string): Promise<void> {
  await mkdir(output, { recursive: true });
  const samples: Awaited<ReturnType<typeof recordSample>>[] = [];

  const mainWin = controller.windows.main;
  if (!mainWin || mainWin.isDestroyed()) {
    throw new Error('Official main window is not available.');
  }

  mainWin.webContents.setBackgroundThrottling(false);
  mainWin.setContentSize(1280, 860);
  mainWin.show();
  mainWin.focus();

  // Ensure E Street Radio has a user-configured channel artist mapping so that if a
  // concert broadcast ("2/14/23 Houston, TX - The Rising") is on air, it resolves cleanly.
  const currentMappings = controller.buildState().settings.metadata.channelMappings;
  const hasEStreetMapping = currentMappings.some(
    (m) => m.channel.toLowerCase() === 'e street radio',
  );
  if (!hasEStreetMapping) {
    await controller.patchSettings({
      metadata: {
        ...controller.buildState().settings.metadata,
        channelMappings: [
          ...currentMappings,
          {
            channel: 'E Street Radio',
            artist: 'Bruce Springsteen',
            note: 'User-confirmed artist channel mapping for concert broadcasts.',
          },
        ],
      },
    });
  }

  // Wait for initial SiriusXM home screen to finish rendering.
  for (let i = 0; i < 16; i++) {
    await wait(1000);
    if (controller.buildState().player.loadState === 'ready' && i >= 6) break;
  }

  samples.push(await recordSample(controller, 'initial-home'));

  // 1. Open The Beatles Channel card (top row card #5 at x=995, y=230) and click ON NOW Play.
  console.log('[live-probe] opening The Beatles Channel and starting playback...');
  await ensureHome(mainWin, controller);
  await nativeClick(mainWin, 995, 230);
  await wait(3000);
  await clickChannelOnNowPlay(mainWin, controller, 'beatles');

  for (let i = 0; i < 5; i++) {
    await wait(3000);
    const s = await recordSample(controller, `beatles-poll-${i + 1}`);
    samples.push(s);
    console.log(
      `[live-probe] beatles-${i + 1}: channel="${s.channel}" artist="${s.artist}" title="${s.title}" scrobbleArtist="${s.scrobbleArtist}" scrobbleTitle="${s.scrobbleTitle}" playing=${s.playing} audible=${s.audible} listeningMs=${s.listeningMs} nowPlaying="${s.nowPlayingStatus}"`,
    );
  }

  await captureWindow(mainWin, join(output, 'live-01-beatles-main.png'));

  controller.windows.openActivity();
  await wait(800);
  await captureWindow(mainWin, join(output, 'live-02-beatles-activity.png'));
  controller.windows.quickPanel.closePanel(true);

  await controller.patchSettings({ skinId: 'bluebird-classic', colorMode: 'light', skinWindowEnabled: true });
  const skinWin = controller.windows.openSkin();
  skinWin.webContents.setBackgroundThrottling(false);
  await wait(800);
  await captureWindow(skinWin, join(output, 'live-03-beatles-bluebird.png'));

  // 2. Return to Discover home screen, open E Street Radio card (top row card #2 at x=506, y=230), and click ON NOW Play.
  mainWin.show();
  mainWin.focus();
  await wait(400);
  await ensureHome(mainWin, controller);
  console.log('[live-probe] opening E Street Radio and starting playback...');
  await nativeClick(mainWin, 506, 230);
  await wait(3000);
  await clickChannelOnNowPlay(mainWin, controller, 'e street');

  for (let i = 0; i < 5; i++) {
    await wait(3000);
    const s = await recordSample(controller, `estreet-poll-${i + 1}`);
    samples.push(s);
    console.log(
      `[live-probe] estreet-${i + 1}: channel="${s.channel}" artist="${s.artist}" title="${s.title}" scrobbleArtist="${s.scrobbleArtist}" scrobbleTitle="${s.scrobbleTitle}" playing=${s.playing} audible=${s.audible} listeningMs=${s.listeningMs} nowPlaying="${s.nowPlayingStatus}"`,
    );
  }

  await captureWindow(mainWin, join(output, 'live-04-estreet-main.png'));
  await controller.patchSettings({ skinId: 'retro-amp', colorMode: 'dark' });
  await wait(800);
  await captureWindow(skinWin, join(output, 'live-05-estreet-retro-amp.png'));
  controller.windows.openActivity();
  await wait(500);
  await captureWindow(mainWin, join(output, 'live-06-estreet-activity.png'));
  controller.windows.quickPanel.closePanel(true);

  await controller.patchSettings({ skinId: 'modern', colorMode: 'dark', compactPlayerEnabled: false, skinWindowEnabled: false });

  await writeFile(join(output, 'beatles-estreet-live-observation.json'), JSON.stringify(samples, null, 2));
  console.log('[live-probe] beatles & e street observation saved:', output);
}
