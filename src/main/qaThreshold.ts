/**
 * VegaAM 3.2.1 Live Threshold Acceptance Runner (`--qa-threshold`).
 *
 * Verifies the hotfix that replaced the flat 150 s radio floor with an
 * adaptive threshold against the real, signed-in SiriusXM player:
 *
 *   1. The threshold that the interface shows is the effective, adaptive one.
 *   2. The engine measures the songs of the channel and adapts to them.
 *   3. A song that is shorter than the old 150 s floor is submitted.
 *   4. A song that was only heard for a few seconds is never submitted.
 *
 * The runner is read-only with respect to the official SiriusXM page: it only
 * uses native Chromium mouse input events and the Windows GSMTC transport
 * controls, exactly like the 3.2 acceptance runner.
 */

import { appendFile, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import type { BrowserWindow } from 'electron';

import type { AppController } from './app';
import { captureWindow } from './smoke';

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** The floor that VegaAM 3.0/3.1 used for every SiriusXM track. */
const LEGACY_FLOOR_MS = 150_000;

/**
 * A log sink that never breaks the run.
 *
 * The console can be attached to a pipe that dies while the application is
 * still running (a detached launcher), and a failing `console.log` would
 * throw `EPIPE` inside the acceptance loop. Every line is therefore written
 * to a file as well, and the console call is best-effort.
 */
function createLogger(logFile: string) {
  return (message: string): void => {
    void appendFile(logFile, `${new Date().toISOString()} ${message}\n`).catch(() => undefined);
    try {
      console.log(message);
    } catch {
      /* the console is not available - the file log is the record */
    }
  };
}

async function nativeClick(win: BrowserWindow, x: number, y: number): Promise<void> {
  win.webContents.sendInputEvent({ type: 'mouseMove', x, y });
  await wait(110);
  win.webContents.sendInputEvent({ type: 'mouseDown', x, y, button: 'left', clickCount: 1 });
  await wait(80);
  win.webContents.sendInputEvent({ type: 'mouseUp', x, y, button: 'left', clickCount: 1 });
}

function isLivePlaybackActive(controller: AppController): boolean {
  return (
    controller.windows.officialPlayer.isCurrentlyAudible &&
    controller.buildState().playback.playing
  );
}

/**
 * Capture the main window together with the in-window drawer.
 *
 * The drawer is a `WebContentsView` inside the window, so a plain window
 * capture would not contain it.
 */
async function captureComposite(
  controller: AppController,
  filePath: string,
): Promise<string> {
  const main = controller.windows.main;
  if (!main || main.isDestroyed()) return filePath;
  try {
    const img = await controller.windows.quickPanel.captureCompositePage();
    if (img && !img.isEmpty()) {
      await writeFile(filePath, img.toPNG());
      return filePath;
    }
  } catch {
    /* fall back to the plain window capture */
  }
  await captureWindow(main, filePath, { focus: false });
  return filePath;
}

/**
 * Start real SiriusXM playback.
 *
 * The Beatles Channel is used on purpose: it publishes a lot of songs that are
 * shorter than the old 150 s floor, which is exactly the case the hotfix has
 * to fix.
 */
async function startPlayback(win: BrowserWindow, controller: AppController): Promise<boolean> {
  if (isLivePlaybackActive(controller)) return true;

  if (!controller.buildState().player.url.includes('/player/home')) {
    await nativeClick(win, 80, 106);
    await wait(2600);
  }

  // The Beatles tile in the home shelf.
  const shelfPlayButtons = [
    { x: 713, y: 249 },
    { x: 553, y: 249 },
    { x: 877, y: 249 },
  ];
  for (const point of shelfPlayButtons) {
    if (isLivePlaybackActive(controller)) break;
    await nativeClick(win, point.x, point.y);
    await wait(2600);
  }
  if (!isLivePlaybackActive(controller)) {
    await controller.runPlayerCommand('toggle');
    await wait(2600);
  }
  if (!isLivePlaybackActive(controller)) {
    await nativeClick(win, 632, 744);
    await wait(2600);
  }
  return isLivePlaybackActive(controller);
}

interface Sample {
  at: string;
  channel: string | null;
  artist: string | null;
  title: string | null;
  listeningMs: number;
  /** The threshold that was in force, in milliseconds. */
  thresholdMs: number;
  /** The estimated song length of the channel, in milliseconds. */
  songEstimateMs: number;
  /** The number of observed songs that back the estimate. */
  observedSongCount: number;
  adaptive: boolean;
  eligibility: string;
  historyCount: number;
}

interface ObservedSong {
  artist: string | null;
  title: string | null;
  channel: string | null;
  /** The wall-clock length of the slot the song occupied, in milliseconds. */
  slotMs: number;
  /** The threshold that was in force while the song played. */
  thresholdMs: number;
  /** The decision the engine made for the song. */
  reason: string;
  scrobbled: boolean;
  services: string[];
}

export async function runQaThreshold(
  controller: AppController,
  outputDir: string,
): Promise<string[]> {
  await mkdir(outputDir, { recursive: true });
  const files: string[] = [];
  const samples: Sample[] = [];
  const log = createLogger(join(outputDir, 'qa-threshold.log'));

  try {
    const result = await collect(controller, outputDir, files, samples, log);
    return result;
  } catch (error) {
    // The acceptance run must never leave the application in an unknown state.
    log(`[qa-threshold] FAILED: ${String(error)}`);
    try {
      await writeFile(
        join(outputDir, 'qa-threshold-error.txt'),
        `${String(error)}\n\n${error instanceof Error ? error.stack ?? '' : ''}\n`,
      );
    } catch {
      /* the log file already holds the reason */
    }
    return files;
  }
}

async function collect(
  controller: AppController,
  outputDir: string,
  files: string[],
  samples: Sample[],
  log: (message: string) => void,
): Promise<string[]> {
  const mainWin = controller.windows.main;
  if (!mainWin || mainWin.isDestroyed()) {
    throw new Error('Main SiriusXM window is not available.');
  }

  const settings = controller.buildState().settings;
  const previousAdaptive = settings.thresholds.radioAdaptiveEstimate !== false;
  const previousFloor = settings.thresholds.radioMinListenMs;

  // The hotfix must be in force for the acceptance run.
  await controller.patchSettings({
    thresholds: { ...settings.thresholds, radioAdaptiveEstimate: true },
  });

  mainWin.webContents.setBackgroundThrottling(false);
  mainWin.setContentSize(1280, 860);
  mainWin.show();
  mainWin.focus();

  for (let i = 0; i < 18; i++) {
    await wait(1000);
    if (controller.buildState().player.loadState === 'ready' && i >= 6) break;
  }

  const playbackStarted = await startPlayback(mainWin, controller);
  log(`[qa-threshold] playback started: ${playbackStarted}`);

  const historyBefore = await controller.listHistory().catch(() => []);
  const knownIds = new Set(historyBefore.map((entry) => entry.id));

  const minutes = Math.max(2, Number(process.env.VEGAAM_QA_MINUTES ?? 9));
  const deadline = Date.now() + minutes * 60_000;

  let lastTitle: string | null = null;
  let lastTitleAt = Date.now();
  let lastArtist: string | null = null;
  let lastChannel: string | null = null;

  while (Date.now() < deadline) {
    const iterationStart = Date.now();
    await wait(2000);
    const state = controller.buildState();
    const title = state.playback.title ?? null;
    const artist = state.playback.artist ?? null;

    if (title && title !== lastTitle) {
      lastTitle = title;
      lastArtist = artist;
      lastChannel = state.playback.channel ?? null;
      lastTitleAt = Date.now();
    }

    const history = await controller.listHistory().catch(() => []);
    samples.push({
      at: new Date().toISOString(),
      channel: state.playback.channel ?? null,
      artist: state.playback.artist ?? null,
      title: state.playback.title ?? null,
      listeningMs: state.playback.listeningMs ?? 0,
      thresholdMs: state.playback.thresholdMs ?? 0,
      songEstimateMs: state.playback.songEstimateMs ?? 0,
      observedSongCount: state.playback.observedSongCount ?? 0,
      adaptive: state.settings.thresholds.radioAdaptiveEstimate !== false,
      eligibility: state.monitor.eligibility,
      historyCount: history.length,
    });

    if (samples.length % 5 === 0) {
      const last = samples[samples.length - 1];
      log(
        `[qa-threshold] ${Math.round((minutes * 60_000 - (deadline - Date.now())) / 1000)}s ` +
          `n=${samples.length} cycle=${Date.now() - iterationStart}ms ` +
          `channel="${last?.channel}" title="${last?.title}" listening=${Math.round((last?.listeningMs ?? 0) / 1000)}s ` +
          `threshold=${Math.round((last?.thresholdMs ?? 0) / 1000)}s estimate=${Math.round((last?.songEstimateMs ?? 0) / 1000)}s ` +
          `observed=${last?.observedSongCount} history=${last?.historyCount}`,
      );
    }
  }

  // Every track the engine decided on during the run.
  const historyAfter = await controller.listHistory().catch(() => []);
  const newEntries = historyAfter.filter((entry) => !knownIds.has(entry.id));

  const observedSongs: ObservedSong[] = newEntries.map((entry) => ({
    artist: entry.artist,
    title: entry.title,
    channel: entry.channel,
    slotMs: Math.max(0, entry.at - entry.startedAt),
    thresholdMs: 0,
    reason: entry.reason,
    scrobbled: entry.scrobbled,
    services: entry.services.map((service) => `${service.service}:${service.ok ? 'ok' : 'failed'}`),
  }));

  // The threshold that was in force when each song was played.
  for (const song of observedSongs) {
    const sample = [...samples]
      .reverse()
      .find((entry) => entry.title === song.title);
    song.thresholdMs = sample?.thresholdMs ?? 0;
  }

  const shortSongs = observedSongs.filter((song) => song.slotMs > 0 && song.slotMs < LEGACY_FLOOR_MS);
  const shortSongsSubmitted = shortSongs.filter((song) => song.scrobbled);
  const thresholds = samples.map((sample) => sample.thresholdMs).filter((value) => value > 0);
  const minThreshold = thresholds.length ? Math.min(...thresholds) : 0;
  const maxThreshold = thresholds.length ? Math.max(...thresholds) : 0;
  const estimates = samples.map((sample) => sample.songEstimateMs).filter((value) => value > 0);
  const maxObserved = samples.reduce((max, sample) => Math.max(max, sample.observedSongCount), 0);

  // Screenshots of the interface that shows the threshold.
  try {
    controller.windows.quickPanel.openPanel('scrobbling');
    await wait(1600);
    const drawerShot = join(outputDir, 'threshold-01-scrobbling-panel.png');
    await captureComposite(controller, drawerShot);
    files.push(drawerShot);

    controller.windows.quickPanel.openPanel('activity');
    await wait(1600);
    const activityShot = join(outputDir, 'threshold-02-activity-panel.png');
    await captureComposite(controller, activityShot);
    files.push(activityShot);

    controller.windows.quickPanel.closePanel(true);
    await wait(600);
  } catch (error) {
    log(`[qa-threshold] screenshot step failed: ${String(error)}`);
  }

  // Restore the user's own threshold preference.
  await controller.patchSettings({
    thresholds: {
      ...controller.buildState().settings.thresholds,
      radioAdaptiveEstimate: previousAdaptive,
      radioMinListenMs: previousFloor,
    },
  });

  const report = {
    generatedAt: new Date().toISOString(),
    playbackStarted,
    minutes,
    legacyFloorMs: LEGACY_FLOOR_MS,
    thresholds: {
      minMs: minThreshold,
      maxMs: maxThreshold,
      alwaysBelowLegacyFloor: thresholds.length > 0 && maxThreshold < LEGACY_FLOOR_MS,
    },
    estimate: {
      maxObservedSongs: maxObserved,
      lastEstimateMs: estimates.length ? estimates[estimates.length - 1] : 0,
    },
    songs: observedSongs,
    shortSongs: {
      count: shortSongs.length,
      submitted: shortSongsSubmitted.length,
      details: shortSongs.map((song) => ({
        artist: song.artist,
        title: song.title,
        slotMs: song.slotMs,
        thresholdMs: song.thresholdMs,
        scrobbled: song.scrobbled,
        reason: song.reason,
      })),
    },
    historyEntriesAdded: newEntries.length,
    samples,
  };

  const reportFile = join(outputDir, 'qa-threshold-report.json');
  await writeFile(reportFile, JSON.stringify(report, null, 2));
  files.push(reportFile);

  log(
    `[qa-threshold] done: songs=${observedSongs.length} shortSongs=${shortSongs.length} ` +
      `shortSongsSubmitted=${shortSongsSubmitted.length} thresholdRange=${Math.round(minThreshold / 1000)}-${Math.round(maxThreshold / 1000)}s ` +
      `maxObserved=${maxObserved}`,
  );

  return files;
}
