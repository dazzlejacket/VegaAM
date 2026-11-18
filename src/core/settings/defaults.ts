/**
 * Default application settings (v4 schema for VegaAM 3.1) and migration-aware
 * settings merger.
 */

import type { MetadataConfig } from '../metadata/types';
import { isBuiltinSurfaceThemeId } from '../surfaceTheme/palettes';
import { SXM_TOKEN_SNAPSHOT } from '../surfaceTheme/tokens';
import { sanitizeHexAccent } from '../surfaceTheme/validate';
import { migrateChannelMappingsToV3 } from './migrations';

/** Listening thresholds. */
export interface ScrobbleThresholds {
  /** Fraction of a known track duration required before scrobbling (50%). */
  ratio: number;
  /** Upper bound for known-duration threshold in milliseconds (4 minutes). */
  maxMs: number;
  /** Lower bound for known-duration threshold in milliseconds (30 seconds). */
  minMs: number;
  /**
   * Radio fallback floor: accumulated playback time required when the song
   * length is unknown and the adaptive estimate is switched off.
   *
   * SiriusXM never reports a track duration, so this is only a stand-in for
   * the song length. VegaAM 3.2.1 derives the real threshold from the song
   * lengths it observes (see `radioAdaptiveEstimate`) and additionally submits
   * a song that ends while it is still shorter than the threshold.
   */
  radioMinListenMs: number;
  /**
   * Derive the radio threshold from the observed song length of the current
   * channel instead of using a fixed floor.
   *
   * When enabled (default), VegaAM estimates the typical song length of the
   * channel from the songs it has already heard end-to-end and applies the
   * normal "50% of the track" rule to that estimate. A song that ends while it
   * is still shorter than the threshold is submitted when it ends, so short
   * songs (Beatles, punk, jingles) are never silently dropped.
   *
   * Switch this off to fall back to the flat `radioMinListenMs` floor.
   */
  radioAdaptiveEstimate: boolean;
  /** Whether a radio track also requires a confirmed song boundary. */
  radioRequiresBoundary: boolean;
  /** Debounce window in milliseconds before accepting a new metadata string. */
  metadataDebounceMs: number;
  /** Window in milliseconds within which the same track is not scrobbled twice. */
  duplicateWindowMs: number;
}

export interface StoredWindowBounds {
  x?: number;
  y?: number;
  width: number;
  height: number;
  maximized?: boolean;
}

export interface WindowStateMap {
  main?: StoredWindowBounds | null;
  compact?: StoredWindowBounds | null;
  skin?: StoredWindowBounds | null;
  settings?: StoredWindowBounds | null;
  activity?: StoredWindowBounds | null;
}

export interface AppSettings {
  /** Version of the settings schema (4 for VegaAM 3.1). */
  settingsVersion: number;
  /** Selected SiriusXM surface theme id (`null` = official stock appearance). */
  surfaceThemeId: string | null;
  /** Custom hex accent override (`#RRGGBB`) for the active SiriusXM surface theme. */
  surfaceThemeAccent: string | null;
  /** Explicit opt-in consent for SiriusXM surface CSS theming (default `false`). */
  surfaceThemeConsent: boolean;
  /** Token snapshot date for the surface theme pack (`'2026-11-05'`). */
  surfaceThemeSnapshot: string;
  /** Whether the top-right 44x44 settings orb & quick panel are enabled. */
  quickPanelEnabled: boolean;
  /** Selected theme id for VegaAM-owned windows. */
  theme: string;
  /** Selected skin id for the Skinned Companion window. */
  skinId: string;
  /** Colour mode used on top of the VegaAM window theme. */
  colorMode: 'dark' | 'light' | 'system';
  /** Accent colour override (hex) for VegaAM-owned windows. */
  accentColor?: string | null;
  /** Extract a colour palette from the current artwork. */
  artworkTint: boolean;
  /** Playback volume (0..1). */
  volume: number;
  /** Keep companion windows on top of other windows. */
  alwaysOnTop: boolean;
  /** Whether the Compact Companion player is enabled. */
  compactPlayerEnabled: boolean;
  /** Legacy alias kept in sync with compactPlayerEnabled. */
  miniPlayerEnabled: boolean;
  /** Legacy start-in-mini flag. */
  miniPlayer: boolean;
  /** Whether the Skinned Companion window is open/enabled. */
  skinWindowEnabled: boolean;
  /** Keep the official player running in the tray when the main window is closed. */
  closeToTray: boolean;
  /** Consent for the read-only MediaSession bridge (required for scrobbling/companions). */
  mediaBridgeConsent: boolean;
  /** Scrobble to Last.fm. */
  lastfmEnabled: boolean;
  /** Scrobble to ListenBrainz. */
  listenbrainzEnabled: boolean;
  /** Channels excluded from scrobbling. */
  scrobbleMutedChannels: string[];
  /** Legacy alias kept in sync with scrobbleMutedChannels. */
  mutedChannels: string[];
  /** Playback detection thresholds. */
  thresholds: ScrobbleThresholds;
  /** Metadata normalisation configuration (user-configured rules only). */
  metadata: MetadataConfig;
  /** Last.fm API key (public) supplied by the user. */
  lastfmApiKey?: string;
  /** Legacy field cleared after migrating to SecretStore. */
  lastfmApiSecret?: string;
  /** Legacy field cleared after migrating to SecretStore. */
  listenbrainzToken?: string;
  /** Legacy main window bounds (kept in sync with windowState.main). */
  windowBounds?: StoredWindowBounds | null;
  /** Per-window persisted bounds. */
  windowState: WindowStateMap;
  /** Whether the first-run notice was dismissed. */
  onboardingDismissed: boolean;
  /** Show desktop notifications on track change. */
  notificationsEnabled: boolean;
  /** Show a desktop notification when a track is scrobbled. */
  notifyOnScrobble: boolean;
  /** Start the application when the user logs in. */
  startAtLogin: boolean;
  /** Publish the MPRIS interface on Linux desktops. */
  mprisEnabled: boolean;
}

export const SETTINGS_VERSION = 4;

export const DEFAULT_THRESHOLDS: ScrobbleThresholds = {
  ratio: 0.5,
  maxMs: 4 * 60 * 1000,
  minMs: 30 * 1000,
  radioMinListenMs: 90 * 1000,
  radioAdaptiveEstimate: true,
  radioRequiresBoundary: false,
  metadataDebounceMs: 4000,
  duplicateWindowMs: 30 * 60 * 1000,
};

export const DEFAULT_METADATA_CONFIG: MetadataConfig = {
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
};

export const DEFAULT_SETTINGS: AppSettings = {
  settingsVersion: SETTINGS_VERSION,
  surfaceThemeId: null,
  surfaceThemeAccent: null,
  surfaceThemeConsent: false,
  surfaceThemeSnapshot: SXM_TOKEN_SNAPSHOT.capturedAt,
  quickPanelEnabled: true,
  theme: 'modern',
  skinId: 'bluebird-classic',
  colorMode: 'system',
  accentColor: null,
  artworkTint: true,
  volume: 0.8,
  alwaysOnTop: false,
  compactPlayerEnabled: false,
  miniPlayerEnabled: false,
  miniPlayer: false,
  skinWindowEnabled: false,
  closeToTray: true,
  mediaBridgeConsent: true,
  lastfmEnabled: false,
  listenbrainzEnabled: false,
  scrobbleMutedChannels: [],
  mutedChannels: [],
  thresholds: { ...DEFAULT_THRESHOLDS },
  metadata: {
    ...DEFAULT_METADATA_CONFIG,
    channelMappings: [],
    neverFallbackChannels: [],
    removedChannelMappings: [],
  },
  lastfmApiKey: '',
  lastfmApiSecret: '',
  listenbrainzToken: '',
  windowBounds: null,
  windowState: {},
  onboardingDismissed: false,
  notificationsEnabled: true,
  notifyOnScrobble: true,
  startAtLogin: false,
  mprisEnabled: true,
};

/** Deep clone helper used when merging user settings with the defaults. */
export function cloneSettings(settings: AppSettings): AppSettings {
  return JSON.parse(JSON.stringify(settings)) as AppSettings;
}

function asBoolean(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback;
}

function asString(value: unknown, fallback: string): string {
  return typeof value === 'string' ? value : fallback;
}

function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((entry): entry is string => typeof entry === 'string' && entry.trim().length > 0);
}

function asNumber(value: unknown, fallback: number, min: number, max: number): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, parsed));
}

function sanitizeBounds(value: unknown): StoredWindowBounds | null {
  if (!value || typeof value !== 'object') return null;
  const raw = value as Record<string, unknown>;
  const width = Number(raw.width);
  const height = Number(raw.height);
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
    return null;
  }
  const bounds: StoredWindowBounds = {
    width: Math.round(width),
    height: Math.round(height),
  };
  if (typeof raw.x === 'number' && Number.isFinite(raw.x)) bounds.x = Math.round(raw.x);
  if (typeof raw.y === 'number' && Number.isFinite(raw.y)) bounds.y = Math.round(raw.y);
  if (typeof raw.maximized === 'boolean') bounds.maximized = raw.maximized;
  return bounds;
}

/**
 * Merge stored settings with the v4 defaults, migrating v1/v2/v3 profiles cleanly.
 */
export function mergeSettings(stored: unknown): AppSettings {
  const base = cloneSettings(DEFAULT_SETTINGS);
  if (!stored || typeof stored !== 'object') return base;
  const input = stored as Partial<AppSettings> & Record<string, unknown>;

  const rawVersion = Number(input.settingsVersion);
  const storedVersion =
    Number.isFinite(rawVersion) && rawVersion >= 1 ? Math.floor(rawVersion) : 1;

  const metadataInput = (input.metadata ?? {}) as Partial<MetadataConfig> & Record<string, unknown>;
  const thresholdsInput = (input.thresholds ?? {}) as Partial<ScrobbleThresholds> &
    Record<string, unknown>;

  const removedChannelMappings = asStringArray(metadataInput.removedChannelMappings);

  // Resolve scrobbleMutedChannels from either v3 `scrobbleMutedChannels` or v2 `mutedChannels`.
  let mutedList: string[] = [];
  if (Array.isArray(input.scrobbleMutedChannels)) {
    mutedList = asStringArray(input.scrobbleMutedChannels);
  } else if (Array.isArray(input.mutedChannels)) {
    if (storedVersion >= 2 || Array.isArray(input.favoriteChannels)) {
      mutedList = asStringArray(input.mutedChannels);
    }
  }

  const compactEnabled =
    typeof input.compactPlayerEnabled === 'boolean'
      ? input.compactPlayerEnabled
      : storedVersion >= 3 && typeof input.miniPlayerEnabled === 'boolean'
        ? input.miniPlayerEnabled
        : base.compactPlayerEnabled;

  const mainBounds =
    sanitizeBounds((input.windowState as WindowStateMap | undefined)?.main) ??
    sanitizeBounds(input.windowBounds);

  const windowStateInput =
    input.windowState && typeof input.windowState === 'object'
      ? (input.windowState as Record<string, unknown>)
      : {};

  const windowState: WindowStateMap = {
    main: mainBounds,
    compact:
      sanitizeBounds(windowStateInput.compact) ??
      sanitizeBounds(input.miniPlayerBounds) ??
      sanitizeBounds(input.miniBounds),
    skin: sanitizeBounds(windowStateInput.skin),
    settings: sanitizeBounds(windowStateInput.settings),
    activity: sanitizeBounds(windowStateInput.activity),
  };

  const theme = asString(input.theme, base.theme);
  const mappedThemeSkin =
    theme === 'classic' ? 'classic-compact' : theme !== 'modern' ? theme : base.skinId;
  const skinId = asString(input.skinId, mappedThemeSkin);

  const surfaceThemeConsent = asBoolean(input.surfaceThemeConsent, false);
  const surfaceThemeId =
    surfaceThemeConsent && isBuiltinSurfaceThemeId(input.surfaceThemeId)
      ? input.surfaceThemeId
      : null;
  const surfaceThemeAccent = sanitizeHexAccent(input.surfaceThemeAccent);
  const surfaceThemeSnapshot =
    typeof input.surfaceThemeSnapshot === 'string' && input.surfaceThemeSnapshot.trim()
      ? input.surfaceThemeSnapshot.trim()
      : SXM_TOKEN_SNAPSHOT.capturedAt;
  const quickPanelEnabled = asBoolean(input.quickPanelEnabled, base.quickPanelEnabled);

  const merged: AppSettings = {
    ...base,
    settingsVersion: SETTINGS_VERSION,
    surfaceThemeId,
    surfaceThemeAccent,
    surfaceThemeConsent,
    surfaceThemeSnapshot,
    quickPanelEnabled,
    theme,
    skinId,
    colorMode:
      input.colorMode === 'light' || input.colorMode === 'dark' || input.colorMode === 'system'
        ? input.colorMode
        : base.colorMode,
    accentColor: typeof input.accentColor === 'string' ? input.accentColor : null,
    artworkTint: asBoolean(input.artworkTint, base.artworkTint),
    volume: asNumber(input.volume, base.volume, 0, 1),
    alwaysOnTop: asBoolean(input.alwaysOnTop, base.alwaysOnTop),
    compactPlayerEnabled: compactEnabled,
    miniPlayerEnabled: compactEnabled,
    miniPlayer: asBoolean(input.miniPlayer, base.miniPlayer),
    skinWindowEnabled: asBoolean(input.skinWindowEnabled, base.skinWindowEnabled),
    closeToTray: asBoolean(input.closeToTray, base.closeToTray),
    mediaBridgeConsent: asBoolean(input.mediaBridgeConsent, base.mediaBridgeConsent),
    lastfmEnabled: asBoolean(input.lastfmEnabled, base.lastfmEnabled),
    listenbrainzEnabled: asBoolean(input.listenbrainzEnabled, base.listenbrainzEnabled),
    scrobbleMutedChannels: mutedList,
    mutedChannels: [...mutedList],
    thresholds: {
      ratio: asNumber(thresholdsInput.ratio, base.thresholds.ratio, 0.5, 1),
      maxMs: asNumber(thresholdsInput.maxMs, base.thresholds.maxMs, 240000, 24 * 60 * 60 * 1000),
      minMs: asNumber(thresholdsInput.minMs, base.thresholds.minMs, 0, 60 * 60 * 1000),
      radioMinListenMs: (() => {
        // VegaAM 3.0/3.1 forced the radio floor to at least 150,000 ms, so a
        // stored value at or below that was never a deliberate choice: it was
        // either the shipped default or a value the old build ignored. Such a
        // value is rewritten to the new fallback, so the hotfix also applies to
        // existing installations.
        const storedFloor = Number(thresholdsInput.radioMinListenMs);
        const deliberateFloor = Number.isFinite(storedFloor) && storedFloor > 150000;
        return asNumber(
          deliberateFloor ? storedFloor : undefined,
          base.thresholds.radioMinListenMs,
          30000,
          60 * 60 * 1000,
        );
      })(),
      radioAdaptiveEstimate: (() => {
        if (typeof thresholdsInput.radioAdaptiveEstimate === 'boolean') {
          return thresholdsInput.radioAdaptiveEstimate;
        }
        // A floor that was raised above the old enforced minimum is a
        // deliberate choice. The adaptive estimate replaces the flat floor,
        // so it is switched off for such a profile to keep that floor
        // effective.
        const storedFloor = Number(thresholdsInput.radioMinListenMs);
        if (Number.isFinite(storedFloor) && storedFloor > 150000) return false;
        return base.thresholds.radioAdaptiveEstimate;
      })(),
      radioRequiresBoundary:
        storedVersion < 2
          ? DEFAULT_THRESHOLDS.radioRequiresBoundary
          : asBoolean(
              thresholdsInput.radioRequiresBoundary,
              base.thresholds.radioRequiresBoundary,
            ),
      metadataDebounceMs: asNumber(
        thresholdsInput.metadataDebounceMs,
        base.thresholds.metadataDebounceMs,
        1000,
        60 * 1000,
      ),
      duplicateWindowMs: asNumber(
        thresholdsInput.duplicateWindowMs,
        base.thresholds.duplicateWindowMs,
        60 * 1000,
        24 * 60 * 60 * 1000,
      ),
    },
    metadata: {
      channelMappings: migrateChannelMappingsToV3(
        metadataInput.channelMappings,
        storedVersion < 3,
      ),
      correctionRules: Array.isArray(metadataInput.correctionRules)
        ? metadataInput.correctionRules
        : [],
      artistAliases:
        metadataInput.artistAliases && typeof metadataInput.artistAliases === 'object'
          ? (metadataInput.artistAliases as Record<string, string>)
          : {},
      manualCorrections:
        metadataInput.manualCorrections && typeof metadataInput.manualCorrections === 'object'
          ? (metadataInput.manualCorrections as MetadataConfig['manualCorrections'])
          : {},
      concertInScrobbleTitle:
        metadataInput.concertInScrobbleTitle === 'never' ||
        metadataInput.concertInScrobbleTitle === 'when-known' ||
        metadataInput.concertInScrobbleTitle === 'always'
          ? metadataInput.concertInScrobbleTitle
          : base.metadata.concertInScrobbleTitle,
      includeFeaturedInScrobbleArtist: asBoolean(
        metadataInput.includeFeaturedInScrobbleArtist,
        base.metadata.includeFeaturedInScrobbleArtist,
      ),
      requireVerifiedMetadata: asBoolean(
        metadataInput.requireVerifiedMetadata,
        base.metadata.requireVerifiedMetadata,
      ),
      dateOrder: metadataInput.dateOrder === 'DMY' ? 'DMY' : base.metadata.dateOrder,
      neverFallbackChannels:
        storedVersion < 3 ? [] : asStringArray(metadataInput.neverFallbackChannels),
      removedChannelMappings,
    },
    lastfmApiKey: asString(input.lastfmApiKey, ''),
    lastfmApiSecret: asString(input.lastfmApiSecret, ''),
    listenbrainzToken: asString(input.listenbrainzToken, ''),
    windowBounds: mainBounds,
    windowState,
    onboardingDismissed: asBoolean(input.onboardingDismissed, base.onboardingDismissed),
    notificationsEnabled: asBoolean(input.notificationsEnabled, base.notificationsEnabled),
    notifyOnScrobble: asBoolean(input.notifyOnScrobble, base.notifyOnScrobble),
    startAtLogin: asBoolean(input.startAtLogin, base.startAtLogin),
    mprisEnabled: asBoolean(input.mprisEnabled, base.mprisEnabled),
  };

  delete (merged.metadata as unknown as Record<string, unknown>).minConfidence;
  delete (merged as unknown as Record<string, unknown>).favoriteChannels;

  return merged;
}
