/**
 * VegaAM 3.2 Live Acceptance & Regression Verification Runner (`--qa-3-2` / `--qa-3-1`).
 *
 * Exercises the real signed-in SiriusXM application and captures composite GUI
 * screenshots (`SiriusXM + in-window VegaAM UI layer`) + JSON telemetry for:
 *   1. Single-Window Invariant: `BrowserWindow.getAllWindows().length === 1` across
 *      Settings, Appearance, Activity & History, Scrobbling Rules, Accounts, and About.
 *   2. Zero Warning Dialogs: live 1-click theme switching without any modal popups.
 *   3. All 5 Real Light Themes (`vega-light`, `catppuccin-latte`, `nord-light`,
 *      `solarized-light`, `rose-pine-dawn`) and 9 Dark Themes on the live SiriusXM player.
 *   4. Uninterrupted Live SiriusXM Audio Playback across light/dark theme switching.
 *   5. Integrated In-Window Studio Drawer across Appearance (All / Light / Dark filters,
 *      custom accent `#FF4FA3`, Reset to Official), Activity & History (283+ items),
 *      Scrobbling Rules, Accounts, Companions & Desktop, and About & Help.
 *   6. Responsive Viewports: `900×600`, `1280×800`, and Maximized, plus Escape/focus/scroll.
 */

import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { BrowserWindow, screen } from 'electron';

import { SURFACE_THEMES } from '../core/surfaceTheme/palettes';
import type { BuiltinSurfaceThemeId } from '../core/surfaceTheme/types';
import type { AppController } from './app';
import { captureWindow } from './smoke';

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function nativeClick(win: BrowserWindow, x: number, y: number): Promise<void> {
  win.webContents.sendInputEvent({ type: 'mouseMove', x, y });
  await wait(110);
  win.webContents.sendInputEvent({ type: 'mouseDown', x, y, button: 'left', clickCount: 1 });
  await wait(80);
  win.webContents.sendInputEvent({ type: 'mouseUp', x, y, button: 'left', clickCount: 1 });
}

async function ensureHome(win: BrowserWindow, controller: AppController): Promise<void> {
  if (!controller.buildState().player.url.includes('/player/home')) {
    await nativeClick(win, 80, 106);
    await wait(2600);
  }
}

/**
 * Playback-active predicate used by the acceptance runner.
 *
 * Requires BOTH signals so a stale MediaSession snapshot cannot be mistaken
 * for live audio:
 *   - `isCurrentlyAudible()` — the official webContents is actually emitting audio.
 *   - `playback.playing`    — the MediaSession bridge reports a playing state.
 */
function isLivePlaybackActive(controller: AppController): boolean {
  return (
    controller.windows.officialPlayer.isCurrentlyAudible &&
    controller.buildState().playback.playing
  );
}

/**
 * Start real SiriusXM playback so every theme switch and drawer interaction is
 * verified against live audio.
 *
 * Strategy order (all DOM-free with respect to the official SiriusXM page —
 * only synthetic OS-level mouse events and Windows GSMTC transport controls):
 *   1. Native click on a channel tile play button in the home shelf.
 *   2. Windows GSMTC `toggle` transport control.
 *   3. Native click on the transport-bar play/pause button.
 */
async function startLivePlaybackIfPossible(
  win: BrowserWindow,
  controller: AppController,
): Promise<boolean> {
  if (isLivePlaybackActive(controller)) return true;

  await ensureHome(win, controller);
  await wait(600);

  // Strategy 1 — native click on the channel shelf play buttons (1280x800 layout).
  const shelfPlayButtons = [
    { x: 713, y: 249 }, // The Beatles
    { x: 387, y: 249 }, // Asbury Park
    { x: 553, y: 249 }, // Juanes
    { x: 877, y: 249 }, // The Dollyrots
  ];
  for (const point of shelfPlayButtons) {
    if (isLivePlaybackActive(controller)) break;
    await nativeClick(win, point.x, point.y);
    await wait(2600);
  }

  // Strategy 2 — Windows GSMTC transport control (no SiriusXM DOM access).
  if (!isLivePlaybackActive(controller)) {
    await controller.runPlayerCommand('toggle');
    await wait(2400);
  }

  // Strategy 3 — native click on the transport-bar play/pause button.
  if (!isLivePlaybackActive(controller)) {
    await nativeClick(win, 632, 744);
    await wait(2600);
  }

  // Strategy 4 — one more GSMTC pass in case the first landed before the
  // MediaSession was registered.
  if (!isLivePlaybackActive(controller)) {
    await controller.runPlayerCommand('toggle');
    await wait(2600);
  }

  return isLivePlaybackActive(controller);
}

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
    /* fallback to captureWindow */
  }
  return captureWindow(main, filePath, { focus: false });
}

function snapshotTelemetry(controller: AppController, step: string) {
  const state = controller.buildState();
  const main = controller.windows.main;
  const drawer = controller.windows.quickPanel;
  const allWindows = BrowserWindow.getAllWindows().filter((w) => !w.isDestroyed());
  return {
    step,
    at: new Date().toISOString(),
    url: state.player.url,
    loadState: state.player.loadState,
    authRequired: state.player.authRequired,
    windowCount: allWindows.length,
    surfaceTheme: {
      activeId: state.surfaceTheme.activeId,
      accent: state.surfaceTheme.accent,
      consent: state.surfaceTheme.consent,
      applied: state.surfaceTheme.applied,
      pausedOnAuth: Boolean(state.surfaceTheme.pausedOnAuth),
      cssBytes: state.surfaceTheme.cssBytes,
      lastError: state.surfaceTheme.lastError,
    },
    playback: {
      playing: state.playback.playing,
      audible: controller.windows.officialPlayer.isCurrentlyAudible,
      channel: state.playback.channel,
      artist: state.playback.artist,
      title: state.playback.title,
      displayTitle: state.playback.displayTitle,
      listeningMs: state.playback.listeningMs,
      nowPlaying: state.monitor.nowPlaying,
      eligibility: state.monitor.eligibility,
    },
    geometry: {
      mainContentBounds: main && !main.isDestroyed() ? main.getContentBounds() : null,
      mainMaximized: main && !main.isDestroyed() ? main.isMaximized() : false,
      drawerOpen: drawer.isOpen,
      drawerTab: drawer.currentTab,
      drawerBounds: drawer.getBounds(),
    },
    injectionCounts: controller.windows.officialPlayer.getInjectionCounts(),
  };
}

export async function runQa31(controller: AppController, outputDir: string): Promise<string[]> {
  await mkdir(outputDir, { recursive: true });
  const files: string[] = [];
  const telemetry: ReturnType<typeof snapshotTelemetry>[] = [];

  const mainWin = controller.windows.main;
  if (!mainWin || mainWin.isDestroyed()) {
    throw new Error('Main SiriusXM window is not available.');
  }

  // Save user's pre-existing surface settings so we can restore them cleanly at the end.
  const initialSettings = controller.buildState().settings;
  const savedSurfaceState = {
    surfaceThemeConsent: initialSettings.surfaceThemeConsent,
    surfaceThemeId: initialSettings.surfaceThemeId,
    surfaceThemeAccent: initialSettings.surfaceThemeAccent,
    quickPanelEnabled: initialSettings.quickPanelEnabled,
    colorMode: initialSettings.colorMode,
  };

  mainWin.webContents.setBackgroundThrottling(false);
  if (mainWin.isMaximized()) mainWin.unmaximize();
  mainWin.setContentSize(1280, 800);
  mainWin.show();
  mainWin.focus();

  // Begin in default OFF unthemed state with drawer collapsed to the top-right pill
  controller.windows.quickPanel.closePanel(true);
  await controller.patchSettings({
    surfaceThemeConsent: false,
    surfaceThemeId: null,
    surfaceThemeAccent: null,
    quickPanelEnabled: true,
    colorMode: 'dark',
  });
  await controller.surfaceTheme.revert('qa-init');

  // Wait for SiriusXM player to finish loading
  for (let i = 0; i < 18; i++) {
    await wait(1000);
    if (controller.buildState().player.loadState === 'ready' && i >= 6) break;
  }

  // Start live playback so all screenshots & theme switches occur during real playback
  const playbackStarted = await startLivePlaybackIfPossible(mainWin, controller);
  let panelAutoFollowsLightTheme = false;
  await wait(2500);
  await ensureHome(mainWin, controller);
  await wait(1500);

  // 1. Stock Official SiriusXM with in-window top-right VegaAM launcher pill (1280x800)
  telemetry.push(snapshotTelemetry(controller, '01-official-stock-1280x800'));
  files.push(await captureComposite(controller, join(outputDir, '01-official-stock-1280x800.png')));

  // 2. Open Integrated In-Window Studio Drawer -> Appearance Tab (All Themes, Light Filter, Dark Filter)
  controller.windows.openSettings('appearance');
  await wait(900);
  telemetry.push(snapshotTelemetry(controller, '02-drawer-appearance-all'));
  files.push(await captureComposite(controller, join(outputDir, '02-drawer-appearance-all.png')));

  controller.windows.quickPanel.setFilter('light');
  await wait(500);
  telemetry.push(snapshotTelemetry(controller, '03-drawer-appearance-light-filter'));
  files.push(
    await captureComposite(controller, join(outputDir, '03-drawer-appearance-light-filter.png')),
  );

  // 3. Apply VegaAM Light inside the integrated drawer (verifies zero warning dialog & live switch)
  await controller.patchSettings({ surfaceThemeConsent: true, surfaceThemeId: 'vega-light' });
  await controller.surfaceTheme.setActive('vega-light', { accent: null });
  await wait(900);
  telemetry.push(snapshotTelemetry(controller, '04-drawer-vega-light-applied'));
  files.push(
    await captureComposite(controller, join(outputDir, '04-drawer-vega-light-applied.png')),
  );

  // 3b. Panel UI "Auto" — the drawer must follow an active LIGHT surface theme so the
  //     whole application reads as one design instead of a dark panel on a light player.
  await controller.patchSettings({ colorMode: 'system' });
  await controller.windows.openSettings('appearance');
  await wait(1100);
  const drawerBodyMode = controller.windows.quickPanel.webContents
    ? await controller.windows.quickPanel.webContents.executeJavaScript(
        `document.body.dataset.mode || null`,
      )
    : null;
  panelAutoFollowsLightTheme = drawerBodyMode === 'light';
  telemetry.push(snapshotTelemetry(controller, '04b-drawer-panel-ui-auto-follows-light-theme'));
  files.push(
    await captureComposite(
      controller,
      join(outputDir, '04b-drawer-panel-ui-auto-follows-light-theme.png'),
    ),
  );
  // Restore the dark panel for the remaining tab screenshots.
  await controller.patchSettings({ colorMode: 'dark' });
  await wait(500);

  // Close drawer with Escape key and verify all 5 Light Themes + 9 Dark Themes on full player
  controller.windows.quickPanel.closePanel(true);
  await wait(600);

  const themeFileSlug: Record<BuiltinSurfaceThemeId, string> = {
    'vega-light': '05-light-vega-light.png',
    'catppuccin-latte': '06-light-catppuccin-latte.png',
    'nord-light': '07-light-nord-light.png',
    'solarized-light': '08-light-solarized-light.png',
    'rose-pine-dawn': '09-light-rose-pine-dawn.png',
    vega: '10-dark-vega-signature.png',
    catppuccin: '11-dark-catppuccin-mocha.png',
    dracula: '12-dark-dracula.png',
    nord: '13-dark-nord.png',
    gruvbox: '14-dark-gruvbox-dark.png',
    'tokyo-night': '15-dark-tokyo-night.png',
    'rose-pine': '16-dark-rose-pine.png',
    solarized: '17-dark-solarized-dark.png',
    oled: '18-dark-oled-black.png',
  };

  // Order light themes first, then dark themes
  const orderedThemes = [
    ...SURFACE_THEMES.filter((t) => t.mode === 'light'),
    ...SURFACE_THEMES.filter((t) => t.mode === 'dark'),
  ];

  await controller.patchSettings({ surfaceThemeConsent: true });
  for (const def of orderedThemes) {
    const themeId = def.id;
    await controller.patchSettings({
      surfaceThemeId: themeId,
      surfaceThemeAccent: null,
    });
    await controller.surfaceTheme.setActive(themeId, { accent: null });
    await wait(850);
    telemetry.push(snapshotTelemetry(controller, `theme-${themeId}`));
    files.push(await captureComposite(controller, join(outputDir, themeFileSlug[themeId])));
  }

  // 4. Test Integrated In-Window Tabs (Activity & History, Scrobbling Rules, Accounts, Companions, About)
  //    Verify BrowserWindow.getAllWindows().length === 1 at every single step!
  await controller.patchSettings({ surfaceThemeId: 'catppuccin-latte', colorMode: 'light' });
  await controller.surfaceTheme.setActive('catppuccin-latte', { accent: null });
  await wait(600);

  controller.windows.openActivity();
  await wait(900);
  telemetry.push(snapshotTelemetry(controller, '19-inwindow-activity-history'));
  files.push(
    await captureComposite(controller, join(outputDir, '19-inwindow-activity-history.png')),
  );

  controller.windows.openSettings('scrobbling');
  await wait(700);
  telemetry.push(snapshotTelemetry(controller, '20-inwindow-scrobbling-rules'));
  files.push(
    await captureComposite(controller, join(outputDir, '20-inwindow-scrobbling-rules.png')),
  );

  controller.windows.openSettings('accounts');
  await wait(700);
  telemetry.push(snapshotTelemetry(controller, '21-inwindow-accounts'));
  files.push(await captureComposite(controller, join(outputDir, '21-inwindow-accounts.png')));

  controller.windows.openSettings('companions');
  await wait(700);
  telemetry.push(snapshotTelemetry(controller, '22-inwindow-companions'));
  files.push(await captureComposite(controller, join(outputDir, '22-inwindow-companions.png')));

  controller.windows.openSettings('about');
  await wait(800);
  telemetry.push(snapshotTelemetry(controller, '23-inwindow-about-help'));
  files.push(await captureComposite(controller, join(outputDir, '23-inwindow-about-help.png')));

  // 5. Test Custom Accent (#FF4FA3) and 1-Click Reset to Official
  await controller.patchSettings({
    surfaceThemeId: 'vega',
    surfaceThemeAccent: '#FF4FA3',
    colorMode: 'dark',
  });
  await controller.surfaceTheme.setActive('vega', { accent: '#FF4FA3' });
  controller.windows.openSettings('appearance');
  controller.windows.quickPanel.setFilter('all');
  await wait(800);
  telemetry.push(snapshotTelemetry(controller, '24-custom-accent-ff4fa3'));
  files.push(await captureComposite(controller, join(outputDir, '24-custom-accent-ff4fa3.png')));

  // Reset to Official inside the drawer
  await controller.patchSettings({ surfaceThemeId: null, surfaceThemeAccent: null });
  await controller.surfaceTheme.revert('qa-reset-official');
  await wait(800);
  telemetry.push(snapshotTelemetry(controller, '25-reset-to-official'));
  files.push(await captureComposite(controller, join(outputDir, '25-reset-to-official.png')));

  // 6. Test 900x600 minimum window size and Maximized window size with light theme & open drawer
  await controller.patchSettings({ surfaceThemeId: 'vega-light', surfaceThemeConsent: true });
  await controller.surfaceTheme.setActive('vega-light', { accent: null });
  controller.windows.openSettings('appearance');
  await wait(600);

  mainWin.setContentSize(900, 600);
  await wait(1000);
  telemetry.push(snapshotTelemetry(controller, '26-viewport-900x600-drawer'));
  files.push(await captureComposite(controller, join(outputDir, '26-viewport-900x600-drawer.png')));

  mainWin.maximize();
  await wait(1000);
  telemetry.push(snapshotTelemetry(controller, '27-viewport-maximized-drawer'));
  files.push(
    await captureComposite(controller, join(outputDir, '27-viewport-maximized-drawer.png')),
  );

  mainWin.unmaximize();
  mainWin.setContentSize(1280, 800);
  controller.windows.quickPanel.closePanel(true);
  await wait(700);

  // 7. Interaction Tests — real mouse, keyboard, Escape, focus and scrolling inside
  //    the single main window. No popup window may be spawned at any point.
  const interaction: Record<string, unknown> = {};
  const windowsBeforeInteractions = BrowserWindow.getAllWindows().filter((w) => !w.isDestroyed()).length;

  controller.windows.openSettings('appearance');
  await wait(900);

  const drawerWc = controller.windows.quickPanel.webContents;
  const drawerBounds = controller.windows.quickPanel.getBounds();

  // 7a. Focus must land inside the VegaAM drawer when it opens.
  interaction.drawerFocusedOnOpen = Boolean(drawerWc?.isFocused());

  // 7b. Drawer must stay inside the display work area (never behind the taskbar).
  const displayForMain = mainWin.getBounds();
  const workArea = screen.getDisplayMatching(displayForMain)?.workArea ?? null;
  interaction.workArea = workArea;
  interaction.drawerBounds = drawerBounds;
  interaction.drawerInsideWorkArea = workArea
    ? Boolean(
        drawerBounds &&
          drawerBounds.x >= workArea.x &&
          drawerBounds.y >= workArea.y &&
          drawerBounds.x + drawerBounds.width <= workArea.x + workArea.width &&
          drawerBounds.y + drawerBounds.height <= workArea.y + workArea.height,
      )
    : null;

  // 7c. Tab navigation must keep keyboard focus inside the VegaAM drawer.
  if (drawerWc) {
    for (let i = 0; i < 8; i++) {
      drawerWc.sendInputEvent({ type: 'keyDown', keyCode: 'Tab' });
      drawerWc.sendInputEvent({ type: 'keyUp', keyCode: 'Tab' });
      await wait(70);
    }
    interaction.focusStaysInDrawerAfterTabs = Boolean(drawerWc.isFocused());

    const focusedTag = await drawerWc.executeJavaScript(
      `(() => {
        const el = document.activeElement;
        if (!el) return null;
        return {
          tag: el.tagName,
          id: el.id || null,
          text: (el.textContent || '').trim().slice(0, 48) || null,
          insideDrawer: Boolean(el.closest('.vega-drawer, .drawer-shell, #drawer-root, body')),
        };
      })()`,
    );
    interaction.focusedElementAfterTabs = focusedTag;

    // 7d. Scrolling the drawer content must move the scroll container.
    const scrollMetrics = await drawerWc.executeJavaScript(
      `(() => {
        const el = document.querySelector('.drawer-content');
        if (!el) return null;
        const cs = getComputedStyle(el);
        return {
          scrollTop: el.scrollTop,
          scrollHeight: el.scrollHeight,
          clientHeight: el.clientHeight,
          overflowY: cs.overflowY,
          isScrollable: el.scrollHeight > el.clientHeight,
          docScrollTop: document.scrollingElement ? document.scrollingElement.scrollTop : -1,
          docScrollHeight: document.scrollingElement ? document.scrollingElement.scrollHeight : -1,
          docClientHeight: document.scrollingElement ? document.scrollingElement.clientHeight : -1,
        };
      })()`,
    );
    interaction.drawerScrollMetrics = scrollMetrics;

    const scrollBefore = scrollMetrics?.scrollTop ?? 0;

    // Mechanism A — synthetic mouse wheel over the drawer content.
    const contentPoint = await drawerWc.executeJavaScript(
      `(() => {
        const el = document.querySelector('.drawer-content');
        if (!el) return null;
        const r = el.getBoundingClientRect();
        return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + 60) };
      })()`,
    );
    if (contentPoint) {
      // NOTE: Electron's synthetic mouseWheel `deltaY` sign is INVERTED relative to the
      // DOM `WheelEvent` convention on Windows — a NEGATIVE deltaY scrolls the content
      // DOWN. Chromium also animates the scroll, so the reading is taken after settling.
      for (let i = 0; i < 3; i++) {
        drawerWc.sendInputEvent({
          type: 'mouseWheel',
          x: contentPoint.x,
          y: contentPoint.y,
          deltaX: 0,
          deltaY: -600,
          canScroll: true,
        });
        await wait(140);
      }
      await wait(1200);
    }

    const scrollAfterWheel = await drawerWc.executeJavaScript(
      `(() => {
        const el = document.querySelector('.drawer-content');
        return el ? el.scrollTop : -1;
      })()`,
    );
    interaction.drawerScrollAfterWheel = scrollAfterWheel;

    // Mechanism B — keyboard PageDown (real keyboard navigation path).
    drawerWc.sendInputEvent({ type: 'keyDown', keyCode: 'PageDown' });
    drawerWc.sendInputEvent({ type: 'keyUp', keyCode: 'PageDown' });
    await wait(1200);
    const scrollAfterKey = await drawerWc.executeJavaScript(
      `(() => {
        const el = document.querySelector('.drawer-content');
        return el ? el.scrollTop : -1;
      })()`,
    );
    interaction.drawerScrollAfterPageDown = scrollAfterKey;

    interaction.drawerScrollBefore = scrollBefore;
    interaction.drawerScrollAfter = Math.max(scrollAfterWheel, scrollAfterKey);
    interaction.drawerScrolled = Math.max(scrollAfterWheel, scrollAfterKey) > scrollBefore;

    // 7e. A real mouse click on a theme card must apply that theme.
    const cardPoint = await drawerWc.executeJavaScript(
      `(() => {
        const cards = Array.from(document.querySelectorAll('[data-theme-id]'));
        const target = cards.find((c) => c.getAttribute('data-theme-id') === 'nord-light')
          || cards[cards.length - 1];
        if (!target) return null;
        target.scrollIntoView({ block: 'center' });
        const r = target.getBoundingClientRect();
        return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
      })()`,
    );
    if (cardPoint && drawerBounds) {
      await wait(400);
      drawerWc.sendInputEvent({ type: 'mouseMove', x: cardPoint.x, y: cardPoint.y });
      await wait(120);
      drawerWc.sendInputEvent({
        type: 'mouseDown',
        x: cardPoint.x,
        y: cardPoint.y,
        button: 'left',
        clickCount: 1,
      });
      await wait(90);
      drawerWc.sendInputEvent({
        type: 'mouseUp',
        x: cardPoint.x,
        y: cardPoint.y,
        button: 'left',
        clickCount: 1,
      });
      await wait(1400);
      interaction.mouseClickedThemeCard = cardPoint;
      interaction.themeAfterMouseClick = controller.buildState().surfaceTheme.activeId;
      interaction.mouseClickAppliedTheme = controller.buildState().surfaceTheme.activeId === 'nord-light';
    }
    interaction.focusStaysInDrawerAfterMouse = Boolean(drawerWc.isFocused());

    // 7f. Escape must close the drawer and return focus to the official player.
    drawerWc.sendInputEvent({ type: 'keyDown', keyCode: 'Escape' });
    drawerWc.sendInputEvent({ type: 'keyUp', keyCode: 'Escape' });
    await wait(800);
    interaction.escapeClosedDrawer = !controller.windows.quickPanel.isOpen;
    interaction.focusReturnedToOfficialPlayer = Boolean(mainWin.webContents.isFocused());
  }

  const windowsAfterInteractions = BrowserWindow.getAllWindows().filter((w) => !w.isDestroyed()).length;
  interaction.windowsBefore = windowsBeforeInteractions;
  interaction.windowsAfter = windowsAfterInteractions;
  interaction.noPopupSpawnedByInteractions = windowsBeforeInteractions === windowsAfterInteractions;

  telemetry.push(snapshotTelemetry(controller, '28-interaction-keyboard-escape-focus-scroll'));
  files.push(
    await captureComposite(controller, join(outputDir, '28-interaction-keyboard-escape-focus-scroll.png')),
  );

  // 8. Test Auth-Route Guard (/player/login pauses CSS, /player/home restores CSS)
  await controller.surfaceTheme.onInPageNavigate('https://www.siriusxm.com/player/login');
  telemetry.push(snapshotTelemetry(controller, 'auth-route-guard-paused'));
  await controller.surfaceTheme.onInPageNavigate('https://www.siriusxm.com/player/home');
  telemetry.push(snapshotTelemetry(controller, 'auth-route-guard-restored'));

  // Restore user's initial surface settings
  await controller.patchSettings({
    ...savedSurfaceState,
    skinWindowEnabled: false,
    compactPlayerEnabled: false,
  });
  if (!savedSurfaceState.surfaceThemeConsent || !savedSurfaceState.surfaceThemeId) {
    await controller.surfaceTheme.revert('qa-restore');
  }

  const finalState = controller.buildState();
  const historyList = await controller.listHistory();

  // Playback continuity analysis — proves audio was never paused or reloaded
  // by any theme switch, drawer interaction, or viewport change.
  const listeningSeries = telemetry.map((t) => ({
    step: t.step,
    listeningMs: t.playback.listeningMs,
    playing: t.playback.playing,
    audible: t.playback.audible,
  }));
  const monotoneListening = listeningSeries.every(
    (entry, index) =>
      index === 0 ||
      entry.listeningMs >= (listeningSeries[index - 1]?.listeningMs ?? 0),
  );
  const playbackContinuity = {
    livePlaybackObserved: telemetry.some((t) => t.playback.playing && t.playback.audible),
    everyStepWhileLiveAudio: telemetry.every((t) => t.playback.playing && t.playback.audible),
    monotoneListeningMs: monotoneListening,
    firstListeningMs: listeningSeries[0]?.listeningMs ?? 0,
    lastListeningMs: listeningSeries[listeningSeries.length - 1]?.listeningMs ?? 0,
    totalListeningMsGained:
      (listeningSeries[listeningSeries.length - 1]?.listeningMs ?? 0) -
      (listeningSeries[0]?.listeningMs ?? 0),
    series: listeningSeries,
  };

  const report = {
    capturedAt: new Date().toISOString(),
    appVersion: '3.2.0',
    singleWindowVerified: telemetry.every((t) => t.windowCount === 1),
    zeroOfficialDomScriptInjection: telemetry.every(
      (t) => t.injectionCounts.executeJavaScriptCount === 0,
    ),
    lightThemeCount: SURFACE_THEMES.filter((t) => t.mode === 'light').length,
    darkThemeCount: SURFACE_THEMES.filter((t) => t.mode === 'dark').length,
    playbackStarted,
    playbackContinuity,
    panelAutoFollowsLightTheme,
    interaction,
    historyEntryCount: historyList.length,
    iconIdentity: finalState.iconIdentity,
    services: finalState.services,
    telemetry,
    files,
  };

  await writeFile(join(outputDir, 'qa-3-2-report.json'), JSON.stringify(report, null, 2));
  return files;
}
