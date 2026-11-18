/**
 * Live Last.fm acceptance runner (`--lastfm-acceptance`).
 *
 * It drives the *real* Windows application:
 *
 *   1. opens the integrated studio drawer on the Accounts tab,
 *   2. takes a screenshot of the Last.fm card before the connection,
 *   3. clicks the real "Connect Last.fm" button with a native mouse event,
 *   4. waits until the browser approval came back through the loopback
 *      callback and the session was stored,
 *   5. takes a screenshot of the connected account,
 *   6. submits a real scrobble through the real submission queue and records
 *      the Last.fm acknowledgement,
 *   7. writes the evidence as JSON.
 *
 * The restore check (`--lastfm-restore-check`) starts the application again
 * with the same profile and proves that the session survived the restart.
 */

import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { app } from 'electron';

import type { AppController } from './app';
import { lastFmAuthorizationTimeoutMs } from './lastfmAuthServer';

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export interface LastFmAcceptanceResult {
  mode: string;
  ok: boolean;
  at: string;
  platform: string;
  arch: string;
  electron: string;
  appVersion: string;
  credentialSource?: string;
  authUrl?: string;
  connected?: boolean;
  account?: string;
  connectionState?: string;
  lastError?: string;
  scrobble?: {
    artist: string;
    title: string;
    ok: boolean;
    service: string;
    error?: string;
    response?: unknown;
  };
  screenshots: string[];
  notes?: string[];
}

async function saveResult(
  outputDir: string,
  name: string,
  result: LastFmAcceptanceResult,
): Promise<string> {
  await mkdir(outputDir, { recursive: true });
  const file = join(outputDir, `${name}.json`);
  await writeFile(file, JSON.stringify(result, null, 2), 'utf8');
  return file;
}

/**
 * Capture the main window *including* the integrated drawer.
 *
 * The drawer is a `WebContentsView`, so `webContents.capturePage()` alone
 * would only show the official SiriusXM player.
 */
async function captureComposite(
  controller: AppController,
  file: string,
): Promise<string | undefined> {
  const image = await controller.windows.quickPanel.captureCompositePage();
  if (!image || image.isEmpty()) return undefined;
  await writeFile(file, image.toPNG());
  return file;
}

/** Find the centre of a drawer button so a real mouse click can hit it. */
async function findButtonCenter(
  controller: AppController,
  selector: string,
): Promise<{ x: number; y: number } | null> {
  const wc = controller.windows.quickPanel.webContents;
  if (!wc) return null;
  const rect = (await wc.executeJavaScript(
    `(() => {
       const el = document.querySelector(${JSON.stringify(selector)});
       if (!el) return null;
       el.scrollIntoView({ block: 'center' });
       const r = el.getBoundingClientRect();
       return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
     })()`,
  )) as { x: number; y: number } | null;
  return rect ?? null;
}

/** Click a point inside the drawer with a real mouse event. */
async function clickDrawer(controller: AppController, x: number, y: number): Promise<void> {
  const wc = controller.windows.quickPanel.webContents;
  if (!wc) return;
  wc.sendInputEvent({ type: 'mouseMove', x, y });
  await wait(140);
  wc.sendInputEvent({ type: 'mouseDown', x, y, button: 'left', clickCount: 1 });
  await wait(90);
  wc.sendInputEvent({ type: 'mouseUp', x, y, button: 'left', clickCount: 1 });
}

/**
 * Run the live acceptance.
 *
 * The browser approval is the only step a human performs: VegaAM opens the
 * authorization page, the user approves it and the browser returns to the
 * loopback callback on its own.
 */
export async function runLastFmAcceptance(
  controller: AppController,
  outputDir: string,
  options: { timeoutMs?: number } = {},
): Promise<LastFmAcceptanceResult> {
  // The runner waits a little longer than the application itself so the
  // application can report its own timeout.
  const timeoutMs = options.timeoutMs ?? lastFmAuthorizationTimeoutMs() + 2 * 60_000;
  const screenshots: string[] = [];
  const notes: string[] = [];

  const result: LastFmAcceptanceResult = {
    mode: 'connect',
    ok: false,
    at: new Date().toISOString(),
    platform: process.platform,
    arch: process.arch,
    electron: process.versions.electron,
    appVersion: app.getVersion(),
    screenshots,
  };

  await mkdir(outputDir, { recursive: true });

  // 1. Show the Accounts tab of the integrated drawer.
  controller.windows.openSettings('accounts');
  await wait(2500);

  const before = await captureComposite(controller, join(outputDir, 'lastfm-01-before.png'));
  if (before) screenshots.push(before);

  // 2. Click the real "Connect Last.fm" button.
  const button = await findButtonCenter(controller, '#acc-lfm-connect-btn');
  if (!button) {
    result.lastError = 'The "Connect Last.fm" button was not found in the drawer.';
    await saveResult(outputDir, 'lastfm-acceptance', result);
    return result;
  }
  await clickDrawer(controller, button.x, button.y);

  // 3. Wait for the approval that comes back through the loopback callback.
  const deadline = Date.now() + timeoutMs;
  let connected = false;
  let announcedUrl = false;
  while (Date.now() < deadline) {
    await wait(1000);
    const status = controller.buildState().services.lastfm;
    result.connectionState = status.connectionState;
    result.lastError = status.lastError;
    result.credentialSource = status.credentialSource;

    // Publish the authorization URL as soon as it exists: the approval is the
    // only step a human performs, so the URL has to be reachable without
    // reading the application log.
    if (!announcedUrl && status.authUrl) {
      announcedUrl = true;
      result.authUrl = status.authUrl;
      await writeFile(join(outputDir, 'lastfm-auth-url.txt'), status.authUrl, 'utf8');
      await writeFile(
        join(outputDir, 'lastfm-acceptance-live.json'),
        JSON.stringify({ ...result, state: status.connectionState }, null, 2),
        'utf8',
      );
      console.log(`[lastfm-acceptance] authorize at: ${status.authUrl}`);
    }

    if (status.authorized) {
      connected = true;
      result.account = status.account;
      break;
    }
    if (status.connectionState === 'authentication-failed') {
      notes.push('The authorization failed before the timeout.');
      break;
    }
  }

  result.connected = connected;

  const connectedShot = await captureComposite(
    controller,
    join(outputDir, 'lastfm-02-connected.png'),
  );
  if (connectedShot) screenshots.push(connectedShot);

  if (!connected) {
    result.lastError = result.lastError ?? 'The Last.fm authorization did not complete in time.';
    await saveResult(outputDir, 'lastfm-acceptance', result);
    return result;
  }

  // 4. Submit a real scrobble through the real submission queue.
  const artist = process.env.VEGAAM_LIVE_ARTIST ?? 'The Beatles';
  const title = process.env.VEGAAM_LIVE_TITLE ?? 'VegaAM Live Acceptance';
  const submitted = await controller.submitScrobble({ artist, title });
  const first = submitted[0];
  result.scrobble = {
    artist,
    title,
    ok: Boolean(first?.ok),
    service: first?.service ?? 'none',
    error: first?.error,
    response: first?.response,
  };

  result.ok = Boolean(first?.ok);
  await saveResult(outputDir, 'lastfm-acceptance', result);
  return result;
}

/**
 * Prove that the stored session survives a restart.
 *
 * The application is started again with the same profile: the session key is
 * read from the encrypted secret store and the account name is resolved from
 * the live service.
 */
export async function runLastFmRestoreCheck(
  controller: AppController,
  outputDir: string,
): Promise<LastFmAcceptanceResult> {
  const screenshots: string[] = [];
  const result: LastFmAcceptanceResult = {
    mode: 'restore',
    ok: false,
    at: new Date().toISOString(),
    platform: process.platform,
    arch: process.arch,
    electron: process.versions.electron,
    appVersion: app.getVersion(),
    screenshots,
  };

  await mkdir(outputDir, { recursive: true });
  controller.windows.openSettings('accounts');
  await wait(2500);

  const status = controller.buildState().services.lastfm;
  result.connectionState = status.connectionState;
  result.account = status.account;
  result.lastError = status.lastError;
  result.connected = status.authorized;
  result.ok = status.authorized;

  const restored = await captureComposite(
    controller,
    join(outputDir, 'lastfm-03-restored.png'),
  );
  if (restored) screenshots.push(restored);

  await saveResult(outputDir, 'lastfm-restore-check', result);
  return result;
}
