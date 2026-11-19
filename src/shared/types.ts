/**
 * Types shared between the main process and the VegaAM-owned renderer windows
 * (Settings, Activity, Compact Companion, Skinned Companion, and Quick Panel).
 *
 * The renderer never receives secrets: the service status only reports
 * whether a service is configured and authorized.
 */

import type { ConcertInfo, MetadataConfig, MetadataEvidence } from '../core/metadata/types';
import type { QueueItem } from '../core/scrobble/queue';
import type { ServiceStatus } from '../core/scrobble/types';
import type { ScrobbleThresholds, WindowStateMap } from '../core/settings/defaults';
import type {
  SurfaceThemeDiagnostics,
  SurfaceThemeId,
  SurfaceThemeState,
  SurfaceThemeSummary,
} from '../core/surfaceTheme/types';
import type { ThemeSummary } from '../core/theme/types';

export type {
  SurfaceThemeDiagnostics,
  SurfaceThemeId,
  SurfaceThemeState,
  SurfaceThemeSummary,
};

export interface PlaybackCapabilities {
  canPlayPause: boolean;
  canNext: boolean;
  canPrevious: boolean;
  canMute: boolean;
  isMuted: boolean;
  controlSource: 'gsmtc' | 'mpris' | 'webcontents-mute' | 'none';
}

export interface PlaybackView {
  channel: string | null;
  channelNumber: string | null;
  programme: string | null;
  qualifier: string | null;
  rawArtist: string | null;
  rawTitle: string | null;
  artist: string | null;
  title: string;
  displayTitle: string;
  concert: ConcertInfo | null;
  playing: boolean;
  buffering: boolean;
  muted: boolean;
  positionMs: number | null;
  durationMs: number | null;
  artwork: string | null;
  source: string;
  evidence: MetadataEvidence;
  evidenceReasons: string[];
  ambiguous: boolean;
  skipped: boolean;
  skipReason?: string;
  scrobbleReason?: string;
  listeningMs: number;
  /**
   * The listening time currently required before this track is submitted, in
   * milliseconds.
   *
   * SiriusXM publishes no track duration, so this is derived from the song
   * lengths VegaAM has observed on the channel. The UI always shows this
   * value instead of a fixed radio floor.
   */
  thresholdMs: number;
  /** Estimated length of a song on the current channel, in milliseconds. */
  songEstimateMs: number;
  /** Number of songs observed end-to-end on the current channel. */
  observedSongCount: number;
  /** True once enough songs have been observed for the estimate to be used. */
  songEstimateTrusted: boolean;
  pending: boolean;
}

export interface PlayerView {
  url: string;
  loadState: 'idle' | 'loading' | 'ready' | 'failed' | 'crashed';
  authRequired: boolean;
  reachable: boolean;
  failureReason?: string;
  lastError?: string;
}

export interface IconIdentityDiagnostics {
  exePath: string;
  aumid: string;
  iconPath: string;
  iconSize: string;
  legacyInstallFound: boolean;
  legacyInstallDir: string | null;
  legacyUninstallerPath: string | null;
  legacyStartMenuShortcutFound: boolean;
  legacyDesktopShortcutFound: boolean;
  electronDevShortcutFound: boolean;
  /** IconUri currently registered for the AppUserModelId (null when unregistered). */
  aumidIconUri: string | null;
  /** True when the AppUserModelId is registered in the per-user registry. */
  aumidRegistered: boolean;
  /**
   * Shortcuts that advertise the VegaAM AppUserModelId while pointing at an
   * Electron binary. They make Windows draw the stock nucleus in the taskbar.
   */
  identitySquatters: string[];
}

export interface CredentialStorageDiagnostics {
  /** True when the operating system offers an encrypted storage backend. */
  available: boolean;
  /** The encryption backend Electron selected. */
  backend: 'dpapi' | 'keychain' | 'gnome_libsecret' | 'kwallet' | 'basic_text' | 'unknown';
  /** True when the backend is a real operating system key store. */
  strong: boolean;
  /** True when the secrets survive an application restart. */
  persistent: boolean;
  /** Human readable explanation for the diagnostics view. */
  detail: string;
}

export interface SettingsView {
  settingsVersion: number;
  surfaceThemeId: string | null;
  surfaceThemeAccent: string | null;
  surfaceThemeConsent: boolean;
  surfaceThemeSnapshot: string;
  quickPanelEnabled: boolean;
  theme: string;
  skinId: string;
  colorMode: 'dark' | 'light' | 'system';
  accentColor: string | null;
  artworkTint: boolean;
  volume: number;
  alwaysOnTop: boolean;
  compactPlayerEnabled: boolean;
  miniPlayerEnabled: boolean;
  skinWindowEnabled: boolean;
  closeToTray: boolean;
  mediaBridgeConsent: boolean;
  lastfmEnabled: boolean;
  listenbrainzEnabled: boolean;
  scrobbleMutedChannels: string[];
  mutedChannels: string[];
  thresholds: ScrobbleThresholds;
  metadata: MetadataConfig;
  lastfmApiKey: string;
  onboardingDismissed: boolean;
  notificationsEnabled: boolean;
  notifyOnScrobble: boolean;
  startAtLogin: boolean;
  mprisEnabled: boolean;
  windowState: WindowStateMap;
}

export interface AppState {
  monitor: {
    observedAt: number | null;
    metadataSource: string;
    nowPlaying: string;
    eligibility: string;
  };
  playback: PlaybackView;
  capabilities: PlaybackCapabilities;
  player: PlayerView;
  services: {
    lastfm: ServiceStatus;
    listenbrainz: ServiceStatus;
  };
  settings: SettingsView;
  surfaceTheme: SurfaceThemeState;
  iconIdentity: IconIdentityDiagnostics;
  credentials: CredentialStorageDiagnostics;
  theme: ThemeSummary & { css: string };
  skinTheme: ThemeSummary & { css: string };
  themes: ThemeSummary[];
  queue: QueueItem[];
  ready: true;
}

export type PlayerCommand = 'play' | 'pause' | 'toggle' | 'next' | 'previous' | 'stop' | 'mute';

export type ThemeColorMode = 'dark' | 'light' | 'system';

export interface HistoryEntryView {
  id: string;
  startedAt: number;
  at: number;
  artist: string | null;
  title: string;
  channel: string | null;
  rawArtist: string | null;
  rawTitle: string | null;
  scrobbled: boolean;
  services: { service: string; ok: boolean; error?: string; at: number }[];
  reason: string;
  source: string;
  evidence: MetadataEvidence;
  evidenceReasons: string[];
  notes: string[];
  corrections: string[];
  concert: ConcertInfo | null;
}

export const IPC = {
  stateGet: 'state:get',
  stateUpdate: 'state:update',
  settingsGet: 'settings:get',
  settingsPatch: 'settings:patch',
  historyList: 'history:list',
  historyClear: 'history:clear',
  historyRetry: 'history:retry',
  themeList: 'theme:list',
  themeSelect: 'theme:select',
  skinSelect: 'skin:select',
  themeImport: 'theme:import',
  themeExport: 'theme:export',
  themeImportFile: 'theme:import-file',
  themeExportFile: 'theme:export-file',
  themePreview: 'theme:preview',
  surfaceThemeGet: 'surfaceTheme:get',
  surfaceThemeApply: 'surfaceTheme:apply',
  surfaceThemeRevert: 'surfaceTheme:revert',
  surfaceThemeAccent: 'surfaceTheme:accent',
  surfaceThemeConsent: 'surfaceTheme:consent',
  surfaceThemeDiagnostics: 'surfaceTheme:diagnostics',
  surfaceThemeState: 'surfaceTheme:state',
  channelToggleMuted: 'channel:muted',
  metadataCorrect: 'metadata:correct',
  metadataCorrectList: 'metadata:corrections',
  playerCommand: 'player:command',
  playerVolume: 'player:volume',
  playerReload: 'player:reload',
  playerClearSession: 'player:clear-session',
  playerSnapshot: 'player:snapshot',
  servicesStatus: 'services:status',
  lastfmConnect: 'services:lastfm-connect',
  lastfmDisconnect: 'services:lastfm-disconnect',
  lastfmCredentialsSave: 'services:lastfm-credentials-save',
  listenbrainzConnect: 'services:listenbrainz-connect',
  listenbrainzDisconnect: 'services:listenbrainz-disconnect',
  servicesTest: 'services:test',
  windowShowMain: 'window:show-main',
  windowMini: 'window:mini',
  windowCompact: 'window:compact',
  windowSkin: 'window:skin',
  windowSettings: 'window:settings',
  windowActivity: 'window:activity',
  windowQuickPanel: 'window:quick-panel',
  windowAlwaysOnTop: 'window:always-on-top',
  windowMinimize: 'window:minimize',
  windowMaximize: 'window:maximize',
  windowClose: 'window:close',
  queueList: 'queue:list',
  queueRetry: 'queue:retry',
  queueRemove: 'queue:remove',
  openExternal: 'shell:open-external',
  playerMediaState: 'media:state',
  logs: 'diagnostics:logs',
  legacyCleanupShortcuts: 'legacy:cleanup-shortcuts',
  legacyOpenFolder: 'legacy:open-folder',
  legacyUninstall: 'legacy:uninstall',
  legacyRefreshIconCache: 'legacy:refresh-icon-cache',
  clipboardRead: 'clipboard:read',
} as const;
