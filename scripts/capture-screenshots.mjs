/**
 * Documentation screenshot generator.
 *
 * Renders VegaAM's OWN interface - the integrated studio drawer, the skinned
 * companion and the compact mini-player - with mocked state, so the README
 * images can be regenerated on any machine **without** a SiriusXM account and
 * without touching the official player.
 *
 * This is a documentation helper, not part of the shipped product. It never
 * loads siriusxm.com, never opens a network connection and never reads a user
 * profile.
 *
 * Usage:
 *
 *   npm run build
 *   npx electron scripts/capture-screenshots.mjs
 *
 * Output: assets/screenshots/*.png
 */

import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { app, BrowserWindow } from 'electron';
import * as esbuild from 'esbuild';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const dist = join(root, 'dist', 'renderer');
const outDir = join(root, 'assets', 'screenshots');

/**
 * Bundle the pure core modules so the mock can use the *real* palettes,
 * skins and theme CSS instead of a hand-written copy.
 */
async function loadCore() {
  const entry = join(tmpdir(), `vegaam-shot-core-${process.pid}.mjs`);
  const source = `
    export { SURFACE_THEMES } from ${JSON.stringify(join(root, 'src', 'core', 'surfaceTheme', 'palettes.ts'))};
    export { builtinThemes, themeToCss, summarise } from ${JSON.stringify(join(root, 'src', 'core', 'theme', 'engine.ts'))};
  `;
  const shim = join(tmpdir(), `vegaam-shot-entry-${process.pid}.ts`);
  writeFileSync(shim, source, 'utf8');
  await esbuild.build({
    entryPoints: [shim],
    outfile: entry,
    bundle: true,
    format: 'esm',
    platform: 'node',
    target: 'node20',
    logLevel: 'error',
  });
  return import(`file://${entry.replace(/\\/g, '/')}`);
}

/** The mock state, shaped exactly like `AppState`. */
function buildState(core, { skinId = 'retro-amp', colorMode = 'dark' } = {}) {
  const surfaceThemes = core.SURFACE_THEMES.map((theme) => ({
    id: theme.id,
    name: theme.name,
    family: theme.family,
    mode: theme.mode,
    description: theme.description,
    accent: theme.accent,
    bg: theme.bg,
    mantle: theme.mantle,
    surface: theme.surface,
    text: theme.text,
  }));

  const skins = core.builtinThemes();
  const skinIds = new Set(skins.map((skin) => skin.id));
  const skinSummaries = core.summarise(skins, skinIds);
  const activeSkin = skins.find((skin) => skin.id === skinId) ?? skins[0];
  const activeSkinSummary = skinSummaries.find((skin) => skin.id === activeSkin.id);

  const surfaceState = {
    activeId: 'vega',
    accent: null,
    consent: true,
    applied: true,
    pausedOnAuth: false,
    lastError: null,
    cssBytes: 0,
    appliedAt: Date.now(),
    snapshot: {
      site: 'sxm-player-web',
      capturedAt: '2026-11-05',
      tokenCount: 1288,
      distinctValues: 83,
      stylesheet: 'index-BtyGMKGL.css',
    },
    themes: surfaceThemes,
  };

  const settings = {
    settingsVersion: 3,
    surfaceThemeId: 'vega',
    surfaceThemeAccent: null,
    surfaceThemeConsent: true,
    surfaceThemeSnapshot: '1288 tokens',
    quickPanelEnabled: true,
    theme: activeSkin.id,
    skinId: activeSkin.id,
    colorMode,
    accentColor: null,
    artworkTint: false,
    volume: 0.8,
    alwaysOnTop: false,
    compactPlayerEnabled: true,
    miniPlayerEnabled: true,
    skinWindowEnabled: true,
    closeToTray: false,
    mediaBridgeConsent: true,
    lastfmEnabled: true,
    listenbrainzEnabled: true,
    scrobbleMutedChannels: [],
    mutedChannels: [],
    thresholds: {
      radioFloorMs: 150000,
      radioAdaptiveEstimate: true,
      radioRequiresBoundary: false,
      minMs: 30000,
    },
    metadata: {
      channelMappings: [],
      correctionRules: [],
      artistAliases: {},
      manualCorrections: {},
      concertInScrobbleTitle: 'always',
      includeFeaturedInScrobbleArtist: true,
      requireVerifiedMetadata: false,
      dateOrder: 'MDY',
      neverFallbackChannels: [],
      removedChannelMappings: [],
    },
    lastfmApiKey: '',
    onboardingDismissed: true,
    notificationsEnabled: true,
    notifyOnScrobble: true,
    startAtLogin: false,
    mprisEnabled: true,
    windowState: {},
  };

  return {
    state: {
      monitor: {
        observedAt: Date.now(),
        metadataSource: 'MediaSession',
        nowPlaying: 'The Beatles — Ask Me Why',
        eligibility: 'eligible',
      },
      playback: {
        channel: 'The Beatles Channel',
        channelNumber: null,
        programme: 'The Beatles Channel',
        qualifier: null,
        rawArtist: 'The Beatles',
        rawTitle: 'Ask Me Why',
        artist: 'The Beatles',
        title: 'Ask Me Why',
        displayTitle: 'Ask Me Why',
        concert: null,
        playing: true,
        buffering: false,
        muted: false,
        positionMs: 62000,
        durationMs: null,
        artwork: null,
        source: 'MediaSession',
        evidence: 'split',
        evidenceReasons: [],
        ambiguous: false,
        skipped: false,
        listeningMs: 62000,
        thresholdMs: 91500,
        songEstimateMs: 183000,
        observedSongCount: 7,
        songEstimateTrusted: true,
        pending: false,
      },
      capabilities: {
        canPlayPause: true,
        canNext: true,
        canPrevious: true,
        canMute: true,
        isMuted: false,
        controlSource: 'gsmtc',
      },
      player: {
        url: 'https://www.siriusxm.com/player',
        loadState: 'ready',
        authRequired: false,
        reachable: true,
      },
      services: {
        lastfm: {
          id: 'lastfm',
          connectionState: 'connected',
          configured: true,
          authorized: true,
          accountName: 'listener',
        },
        listenbrainz: {
          id: 'listenbrainz',
          connectionState: 'connected',
          configured: true,
          authorized: true,
          accountName: 'listener',
        },
      },
      settings,
      surfaceTheme: surfaceState,
      iconIdentity: {
        exePath: '',
        aumid: 'app.vegaam.desktop',
        iconPath: '',
        iconSize: '256x256',
        legacyInstallFound: false,
        legacyInstallDir: null,
        legacyUninstallerPath: null,
        legacyStartMenuShortcutFound: false,
        legacyDesktopShortcutFound: false,
        electronDevShortcutFound: false,
        aumidIconUri: null,
        aumidRegistered: true,
        identitySquatters: [],
      },
      credentials: {
        available: true,
        backend: 'dpapi',
        strong: true,
        persistent: true,
        detail: 'Secrets are encrypted with the operating system key store.',
      },
      theme: { ...activeSkinSummary, css: core.themeToCss(activeSkin, { mode: colorMode }) },
      skinTheme: {
        ...activeSkinSummary,
        css: core.themeToCss(activeSkin, { mode: colorMode }),
      },
      themes: skinSummaries,
      queue: [],
      ready: true,
    },
    surfaceState,
  };
}

/**
 * Write a preload that exposes the mocked `window.sxm` / `window.vegaQuick`
 * APIs. The renderer code is the *real* production bundle - only the data
 * behind the bridge is mocked.
 */
function writeStubPreload(dir, state, surfaceState, tab) {
  const file = join(dir, `screenshot-preload-${tab}.cjs`);
  const payload = JSON.stringify({ state, surfaceState, tab });
  writeFileSync(
    file,
    `const { contextBridge } = require('electron');
const mock = ${payload};
const noop = () => () => {};
const subscribe = (cb) => { setTimeout(() => cb(mock.state), 0); return () => {}; };
const api = {
  getState: async () => mock.state,
  onState: subscribe,
  onNotify: noop,
  patchSettings: async () => mock.state,
  history: async () => [],
  clearHistory: async () => true,
  retryHistory: async () => true,
  getSurfaceTheme: async () => mock.surfaceState,
  onSurfaceThemeState: subscribe,
  applySurfaceTheme: async () => mock.surfaceState,
  revertSurfaceTheme: async () => mock.surfaceState,
  applySurfaceAccent: async () => mock.surfaceState,
  setSurfaceConsent: async () => mock.surfaceState,
  getSurfaceDiagnostics: async () => ({}),
  listThemes: async () => mock.state.themes,
  selectTheme: async () => true,
  selectSkin: async () => true,
  importTheme: async () => true,
  exportTheme: async () => '',
  importThemeFile: async () => true,
  exportThemeFile: async () => true,
  previewTheme: async () => true,
  toggleMuted: async () => true,
  correctMetadata: async () => true,
  listCorrections: async () => [],
  playerCommand: async () => true,
  setVolume: async () => true,
  reloadPlayer: async () => true,
  clearPlayerSession: async () => true,
  playerSnapshot: async () => ({}),
  serviceStatus: async () => mock.state.services,
  connectLastfm: async () => true,
  saveLastfmCredentials: async () => true,
  disconnectLastfm: async () => true,
  connectListenbrainz: async () => true,
  disconnectListenbrainz: async () => true,
  testServices: async () => ({}),
  listQueue: async () => [],
  retryQueueItem: async () => true,
  removeQueueItem: async () => true,
  showMainWindow: async () => true,
  toggleMiniPlayer: async () => true,
  toggleCompactPlayer: async () => true,
  toggleSkinWindow: async () => true,
  openSettingsWindow: async () => true,
  openActivityWindow: async () => true,
  toggleQuickPanel: async () => true,
  setAlwaysOnTop: async () => true,
  minimizeWindow: async () => true,
  maximizeWindow: async () => true,
  closeWindow: async () => true,
  cleanupLegacyShortcuts: async () => ({ ok: true, removed: [], errors: [] }),
  openLegacyFolder: async () => true,
  launchLegacyUninstaller: async () => true,
  refreshIconCache: async () => true,
  openExternal: async () => true,
};
const quick = {
  getState: api.getState,
  onState: api.onState,
  getSurfaceTheme: api.getSurfaceTheme,
  onSurfaceTheme: api.onSurfaceThemeState,
  applySurfaceTheme: api.applySurfaceTheme,
  applyCustomAccent: api.applySurfaceAccent,
  revertSurfaceTheme: api.revertSurfaceTheme,
  setSurfaceConsent: api.setSurfaceConsent,
  getSurfaceDiagnostics: api.getSurfaceDiagnostics,
  getDrawerState: async () => ({ open: true, tab: mock.tab }),
  onDrawerState: noop,
  openPanel: async () => true,
  togglePanel: async () => true,
  closePanel: async () => true,
  onTab: noop,
  onFilter: noop,
  openSettings: async () => true,
  toggleCompact: api.toggleCompactPlayer,
  toggleSkin: api.toggleSkinWindow,
  openActivity: async () => true,
  showMain: api.showMainWindow,
};
contextBridge.exposeInMainWorld('sxm', api);
contextBridge.exposeInMainWorld('vegaQuick', quick);
`,
    'utf8',
  );
  return file;
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function capture(win, file) {
  const image = await win.webContents.capturePage();
  writeFileSync(file, image.toPNG());
  const size = image.toPNG().length;
  console.log(`[screenshots] wrote ${file.replace(root + '\\', '')} (${size} bytes)`);
  if (size < 5000) {
    throw new Error(`The screenshot ${file} looks empty (${size} bytes).`);
  }
}

async function shoot({ name, file, width, height, preload, page, prepare }) {
  const win = new BrowserWindow({
    width,
    height,
    show: false,
    backgroundColor: '#0B1020',
    webPreferences: {
      preload,
      contextIsolation: true,
      sandbox: true,
      backgroundThrottling: false,
    },
  });

  win.webContents.on('render-process-gone', (_event, details) => {
    console.error(`[screenshots] ${name}: renderer gone`, JSON.stringify(details));
  });
  win.webContents.on('console-message', (_event, level, message) => {
    if (level >= 2) console.error(`[screenshots] ${name}: ${message}`);
  });

  // A file:// load can transiently fail right after the previous window was
  // torn down, so give it a couple of attempts.
  let loaded = false;
  for (let attempt = 1; attempt <= 3 && !loaded; attempt += 1) {
    try {
      await win.loadFile(page);
      loaded = true;
    } catch (error) {
      console.warn(`[screenshots] ${name}: load attempt ${attempt} failed (${error.message})`);
      await wait(800);
    }
  }
  if (!loaded) throw new Error(`Could not load ${page}`);

  await wait(900);
  if (prepare) await prepare(win);
  await wait(500);
  await capture(win, join(outDir, file));
  win.destroy();
  await wait(400);
}

async function main() {
  mkdirSync(outDir, { recursive: true });
  const core = await loadCore();
  const { state, surfaceState } = buildState(core);
  const stubDir = mkdtempSync(join(tmpdir(), 'vegaam-shot-'));

  const appearancePreload = writeStubPreload(stubDir, state, surfaceState, 'appearance');
  const scrobblingPreload = writeStubPreload(stubDir, state, surfaceState, 'scrobbling');
  const aboutPreload = writeStubPreload(stubDir, state, surfaceState, 'about');

  // 1. The integrated studio drawer, Appearance tab (all 14 surface themes).
  await shoot({
    name: 'studio-drawer',
    file: 'studio-drawer.png',
    width: 700,
    height: 940,
    preload: appearancePreload,
    page: join(dist, 'quick', 'panel.html'),
  });

  // 2. The Scrobbling Rules tab.
  await shoot({
    name: 'scrobbling-rules',
    file: 'scrobbling-rules.png',
    width: 700,
    height: 940,
    preload: scrobblingPreload,
    page: join(dist, 'quick', 'panel.html'),
  });

  // 3. The About & Help tab, with the unofficial-project notice.
  await shoot({
    name: 'about-disclaimer',
    file: 'about-disclaimer.png',
    width: 700,
    height: 940,
    preload: aboutPreload,
    page: join(dist, 'quick', 'panel.html'),
  });

  // 4. The Skinned Companion (Retro Amp).
  const retroAmp = buildState(core, { skinId: 'retro-amp' });
  const retroPreload = writeStubPreload(stubDir, retroAmp.state, retroAmp.surfaceState, 'appearance');
  await shoot({
    name: 'skin-retro-amp',
    file: 'skin-retro-amp.png',
    width: 560,
    height: 720,
    preload: retroPreload,
    page: join(dist, 'skin.html'),
  });

  // 5. The Compact mini-player.
  await shoot({
    name: 'compact-miniplayer',
    file: 'compact-miniplayer.png',
    // The window itself is 480x152; the documentation shot is a little taller
    // so the whole mini-player is visible in the README.
    width: 480,
    height: 196,
    preload: appearancePreload,
    page: join(dist, 'compact.html'),
  });

  console.log('[screenshots] done');
}

// Each screenshot opens and closes its own window. Without this handler
// Electron quits the app as soon as the last window is gone.
app.on('window-all-closed', () => {});

app.whenReady().then(() => {
  main()
    .then(() => app.quit())
    .catch((error) => {
      console.error(error);
      app.exit(1);
    });
});
