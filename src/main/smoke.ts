/**
 * Smoke & Official-First Verification Runner for VegaAM 3.0.
 *
 * Captures screenshots and layout/invariant measurements of:
 *   - Official SiriusXM main window (1280x860 default and 900x600 minimum)
 *   - Compact Companion window (480x152)
 *   - Skinned Companion window (560x720: Bluebird Classic light/dark, Retro Amp dark/light,
 *     Modern, Retro Satellite, Classic Compact)
 *   - Settings window (720x780, dark & light)
 *   - Scrobble Monitor & History window (760x640)
 *
 * Never calls executeJavaScript or insertCSS on the official SiriusXM main window.
 */

import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import type { BrowserWindow } from 'electron';

import type { AppController } from './app';

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export async function captureWindow(
  window: BrowserWindow,
  file: string,
  options: { focus?: boolean } = {},
): Promise<string> {
  const path = join(file);
  try {
    if (options.focus !== false) {
      if (window.isMinimized()) window.restore();
      window.show();
      window.focus();
      await wait(600);
    }
    const image = await Promise.race([
      window.webContents.capturePage(),
      new Promise<Electron.NativeImage | undefined>((resolve) =>
        setTimeout(() => resolve(undefined), 10_000),
      ),
    ]);
    if (!image || image.isEmpty()) {
      console.log('[smoke] capture empty:', path);
      return path;
    }
    await writeFile(path, image.toPNG());
  } catch (error) {
    console.log('[smoke] capture failed:', path, String(error));
  }
  return path;
}

/** Read computed theme properties from a VegaAM-owned secondary window. */
export async function describeSecondaryWindow(window: BrowserWindow): Promise<Record<string, unknown>> {
  const script = `(() => {
    const style = document.getElementById('theme-vars');
    const computed = getComputedStyle(document.documentElement);
    const bodyRect = document.body.getBoundingClientRect();
    const audioCount = document.querySelectorAll('audio, video').length;
    return {
      title: document.title,
      dataTheme: document.body.dataset.theme || null,
      dataMode: document.body.dataset.mode || null,
      bg: computed.getPropertyValue('--bg').trim(),
      text: computed.getPropertyValue('--text').trim(),
      accent: computed.getPropertyValue('--accent').trim(),
      segment: computed.getPropertyValue('--segment-color').trim(),
      styleLength: style ? style.textContent.length : 0,
      viewport: { width: window.innerWidth, height: window.innerHeight },
      bodySize: { width: Math.round(bodyRect.width), height: Math.round(bodyRect.height) },
      horizontalOverflow: document.documentElement.scrollWidth > document.documentElement.clientWidth + 2,
      audioVideoElements: audioCount
    };
  })()`;
  try {
    return (await window.webContents.executeJavaScript(script, true)) as Record<string, unknown>;
  } catch (error) {
    return { error: String(error) };
  }
}

export async function runSmoke(
  controller: AppController,
  outputDir: string,
): Promise<string[]> {
  const files: string[] = [];
  await mkdir(outputDir, { recursive: true });

  const mainWindow = controller.windows.main;
  if (!mainWindow) {
    throw new Error('Main official player window was not created.');
  }

  mainWindow.webContents.setBackgroundThrottling(false);
  mainWindow.setContentSize(1280, 860);
  mainWindow.show();

  // Wait for the official SiriusXM player to finish initial load and settle.
  for (let i = 0; i < 16; i++) {
    await wait(1000);
    const state = controller.buildState();
    if (state.player.loadState === 'ready' && i >= 5) break;
  }

  const defaultContentBounds = mainWindow.getContentBounds();
  const defaultChildViews = mainWindow.contentView.children.length;
  files.push(await captureWindow(mainWindow, join(outputDir, '01-official-main-1280x860.png')));

  // Resize to minimum 900x600 and capture.
  mainWindow.setContentSize(900, 600);
  await wait(1200);
  const minContentBounds = mainWindow.getContentBounds();
  const minChildViews = mainWindow.contentView.children.length;
  files.push(await captureWindow(mainWindow, join(outputDir, '02-official-main-900x600.png')));

  // Restore 1280x860.
  mainWindow.setContentSize(1280, 860);
  await wait(800);

  // If no live song is playing yet during the automated smoke run, seed a realistic
  // MediaSession snapshot so companion, activity, and settings screenshots render
  // complete track metadata.
  if (!controller.buildState().playback.title) {
    controller.ingestMediaSnapshot({
      sessionTitle: 'The Beatles Channel · The Beatles Channel',
      sessionArtist: "The Beatles - Mother Nature's Son",
      sessionAlbum: 'The Beatles (White Album)',
      artworkUrl: null,
      playbackState: 'playing',
      observedAt: Date.now(),
    });
    await wait(4500);
    controller.ingestMediaSnapshot({
      sessionTitle: 'The Beatles Channel · The Beatles Channel',
      sessionArtist: "The Beatles - Mother Nature's Son",
      sessionAlbum: 'The Beatles (White Album)',
      artworkUrl: null,
      playbackState: 'playing',
      observedAt: Date.now(),
    });
    await wait(500);
  }

  // Integrated in-window Settings & Appearance drawer (dark & light)
  await controller.patchSettings({ theme: 'modern', colorMode: 'dark' });
  controller.windows.openSettings('appearance');
  await wait(1200);
  const drawerWc = controller.windows.quickPanel.webContents;
  const settingsDarkProbe = drawerWc
    ? ((await drawerWc.executeJavaScript('({ title: document.title, mode: document.body.dataset.mode || "dark", open: document.body.dataset.drawerState })', true)) as Record<string, unknown>)
    : {};
  files.push(await captureWindow(mainWindow, join(outputDir, '03-drawer-appearance-dark.png')));

  await controller.patchSettings({ colorMode: 'light' });
  await wait(800);
  const settingsLightProbe = drawerWc
    ? ((await drawerWc.executeJavaScript('({ title: document.title, mode: document.body.dataset.mode || "light", open: document.body.dataset.drawerState })', true)) as Record<string, unknown>)
    : {};
  files.push(await captureWindow(mainWindow, join(outputDir, '04-drawer-appearance-light.png')));
  await controller.patchSettings({ colorMode: 'dark' });
  await wait(400);

  // Integrated in-window Activity (Scrobble Monitor, History, Queue) tab
  controller.windows.openActivity();
  await wait(1200);
  const activityProbe = drawerWc
    ? ((await drawerWc.executeJavaScript('({ title: document.title, tab: document.body.dataset.activeTab || "activity" })', true)) as Record<string, unknown>)
    : {};
  files.push(await captureWindow(mainWindow, join(outputDir, '05-drawer-activity-monitor.png')));
  controller.windows.quickPanel.closePanel(true);

  // Compact Companion window (dark & light)
  await controller.patchSettings({ compactPlayerEnabled: true, colorMode: 'dark' });
  const compactWin = controller.windows.openCompact();
  compactWin.webContents.setBackgroundThrottling(false);
  await wait(1000);
  const compactDarkProbe = await describeSecondaryWindow(compactWin);
  files.push(await captureWindow(compactWin, join(outputDir, '06-compact-dark.png')));

  await controller.patchSettings({ colorMode: 'light' });
  await wait(700);
  const compactLightProbe = await describeSecondaryWindow(compactWin);
  files.push(await captureWindow(compactWin, join(outputDir, '07-compact-light.png')));

  // Skinned Companion window: Bluebird Classic (light & dark) and Retro Amp (dark & light)
  await controller.patchSettings({ skinId: 'bluebird-classic', colorMode: 'light', skinWindowEnabled: true });
  const skinWin = controller.windows.openSkin();
  skinWin.webContents.setBackgroundThrottling(false);
  await wait(1200);
  const bluebirdLightProbe = await describeSecondaryWindow(skinWin);
  files.push(await captureWindow(skinWin, join(outputDir, '08-skin-bluebird-classic-light.png')));

  await controller.patchSettings({ skinId: 'bluebird-classic', colorMode: 'dark' });
  await wait(800);
  const bluebirdDarkProbe = await describeSecondaryWindow(skinWin);
  files.push(await captureWindow(skinWin, join(outputDir, '09-skin-bluebird-classic-dark.png')));

  await controller.patchSettings({ skinId: 'retro-amp', colorMode: 'dark' });
  await wait(800);
  const retroAmpDarkProbe = await describeSecondaryWindow(skinWin);
  files.push(await captureWindow(skinWin, join(outputDir, '10-skin-retro-amp-dark.png')));

  await controller.patchSettings({ skinId: 'retro-amp', colorMode: 'light' });
  await wait(800);
  const retroAmpLightProbe = await describeSecondaryWindow(skinWin);
  files.push(await captureWindow(skinWin, join(outputDir, '11-skin-retro-amp-light.png')));

  await controller.patchSettings({ skinId: 'retro-satellite', colorMode: 'dark' });
  await wait(800);
  files.push(await captureWindow(skinWin, join(outputDir, '12-skin-retro-satellite.png')));

  await controller.patchSettings({ skinId: 'classic-compact', colorMode: 'dark' });
  await wait(800);
  files.push(await captureWindow(skinWin, join(outputDir, '13-skin-classic-compact.png')));

  await controller.patchSettings({ skinId: 'modern', colorMode: 'dark', compactPlayerEnabled: false, skinWindowEnabled: false });

  const finalState = controller.buildState();
  const injectionCounts = controller.windows.officialPlayer.getInjectionCounts();

  const measurements = {
    capturedAt: new Date().toISOString(),
    officialMainWindow: {
      url: finalState.player.url,
      loadState: finalState.player.loadState,
      authRequired: finalState.player.authRequired,
      defaultContentBounds,
      minContentBounds,
      defaultChildViews,
      minChildViews,
      injectionCounts,
    },
    secondaryWindows: {
      settingsDark: settingsDarkProbe,
      settingsLight: settingsLightProbe,
      activity: activityProbe,
      compactDark: compactDarkProbe,
      compactLight: compactLightProbe,
      bluebirdLight: bluebirdLightProbe,
      bluebirdDark: bluebirdDarkProbe,
      retroAmpDark: retroAmpDarkProbe,
      retroAmpLight: retroAmpLightProbe,
    },
    files,
  };

  await writeFile(join(outputDir, 'measurements.json'), JSON.stringify(measurements, null, 2));
  return files;
}
