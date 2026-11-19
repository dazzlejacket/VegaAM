/**
 * The VegaAM 3.0 application controller (Official-First Architecture).
 *
 * Owns settings, encrypted secrets, the pure MediaSession metadata pipeline,
 * the TrackStateEngine, the persistent ScrobbleQueue, the official-first main
 * window, and the VegaAM-owned secondary windows (Settings, Activity, Compact
 * Companion, Skinned Companion).
 */

import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { app, clipboard, dialog, ipcMain, nativeTheme, shell } from 'electron';

import { MprisService, type MprisCommand } from '../core/mpris/mpris';
import { channelKey } from '../core/metadata/channelFallback';
import {
  manualCorrectionKey,
  withManualCorrection,
} from '../core/metadata/manualCorrections';
import {
  resolveMediaSessionMetadata,
  type ResolvedMetadata,
} from '../core/metadata/mediaSession';
import type {
  CorrectionRule,
  MetadataConfig,
  NormalizedTrack,
  RawMetadata,
} from '../core/metadata/types';
import { TrackStateEngine, scrobbleKey, type TrackState } from '../core/playback/trackState';
import { LASTFM_ERROR, LastFmService } from '../core/scrobble/lastfm';
import { runAuthorizationHandshake } from '../core/scrobble/authorization';
import {
  resolveLastFmCredentials,
  type ResolvedLastFmCredentials,
} from '../core/scrobble/lastfmCredentials';
import { ListenBrainzService } from '../core/scrobble/listenbrainz';
import { ScrobbleQueue, type QueueItem } from '../core/scrobble/queue';
import type { ScrobbleService, ServiceId, ServiceResult, ServiceStatus } from '../core/scrobble/types';
import { DEFAULT_THRESHOLDS, type AppSettings } from '../core/settings/defaults';
import {
  isBuiltinSurfaceThemeId,
  normalizeSurfaceThemeId,
} from '../core/surfaceTheme/palettes';
import { sanitizeHexAccent } from '../core/surfaceTheme/validate';
import type { ThemeSummary } from '../core/theme/types';
import {
  IPC,
  type AppState,
  type PlaybackCapabilities,
  type PlaybackView,
  type PlayerView,
  type SettingsView,
} from '../shared/types';
import { isAllowedExternalUrl } from './externalLinks';
import { buildPlaybackCapabilities, GsmtcController } from './gsmtcController';
import { HistoryStore, type HistoryEntry } from './historyStore';
import { JsonFile } from './jsonFile';
import {
  lastFmAuthorizationTimeoutMs,
  startLoopbackAuthServer,
  type LoopbackAuthServer,
} from './lastfmAuthServer';
import {
  cleanupLegacyShortcuts,
  inspectIconIdentity,
  launchLegacyUninstallerInteractive,
  openLegacyInstallFolder,
  refreshWindowsIconCache,
} from './legacyInstall';
import { MediaBridgeReceiver, type MediaBridgeSnapshot } from './mediaBridge';
import { installAppMenu } from './menu';
import { NativeIntegration } from './nativeIntegration';
import { SecretStore, type Secrets } from './secretStore';
import { SettingsStore } from './settingsStore';
import { ShortcutManager } from './shortcuts';
import { registerSurfaceThemeIpc } from './surfaceThemeIpc';
import { SurfaceThemeService } from './surfaceThemeService';
import { ThemeService } from './themeService';
import { TrayController } from './tray';
import { WindowManager } from './windowManager';

const ENGINE_TICK_MS = 1000;
const QUEUE_INTERVAL_MS = 30_000;

/** The name a scrobbling service is shown with in the UI. */
function serviceLabel(id: ServiceId): string {
  return id === 'lastfm' ? 'Last.fm' : 'ListenBrainz';
}

export class AppController {
  readonly settingsStore: SettingsStore;
  readonly secretStore: SecretStore;
  readonly historyStore: HistoryStore;
  readonly themeService: ThemeService;
  readonly surfaceTheme: SurfaceThemeService;
  readonly windows: WindowManager;
  readonly shortcuts = new ShortcutManager();
  readonly native: NativeIntegration;
  readonly gsmtc = new GsmtcController();

  private readonly rendererDir: string;
  private settings: AppSettings;
  private secrets: Secrets = {};
  private engine!: TrackStateEngine;
  private queue!: ScrobbleQueue;
  private lastfm!: LastFmService;
  private lastfmCredentials: ResolvedLastFmCredentials = {
    apiKey: '',
    apiSecret: '',
    source: 'none',
    usable: false,
  };
  private lastfmAuthServer: LoopbackAuthServer | undefined;
  private listenbrainz!: ListenBrainzService;
  private mediaBridge!: MediaBridgeReceiver;
  private tray: TrayController | undefined;
  private mpris: MprisService | undefined;
  private unregisterSurfaceThemeIpc: (() => void) | undefined;

  private latestSnapshot: MediaBridgeSnapshot | null = null;
  private resolved: ResolvedMetadata | undefined;
  private lastChannel: string | null = null;
  private lastRaw: RawMetadata = { channel: null, artist: null, title: null };
  private lastPlaying = false;
  private lastBuffering = false;
  private playerLoadState: PlayerView['loadState'] = 'idle';
  private authRequired = false;
  private playerFailureReason = '';
  private lastError: string | undefined;
  private serviceStatus: { lastfm: ServiceStatus; listenbrainz: ServiceStatus } = {
    lastfm: { id: 'lastfm', configured: false, authorized: false },
    listenbrainz: { id: 'listenbrainz', configured: false, authorized: false },
  };
  private authTimer: NodeJS.Timeout | undefined;
  private authGeneration = 0;
  private nowPlayingStatus = 'No verified track submitted';
  private tickTimer: NodeJS.Timeout | undefined;
  private queueTimer: NodeJS.Timeout | undefined;
  private stateBroadcastTimer: NodeJS.Timeout | undefined;
  private pendingBroadcast = false;
  private duplicateKeys = new Set<string>();
  /** The raw result of the last submission attempt per service. */
  private lastServiceResults = new Map<ServiceId, ServiceResult>();

  constructor(userDataPath: string, rendererDir: string) {
    this.rendererDir = rendererDir;
    this.settingsStore = new SettingsStore(userDataPath);
    this.settings = { ...this.settingsStore.get() };
    this.secretStore = new SecretStore(
      userDataPath,
      app.isPackaged ? 'production' : 'development',
    );
    this.historyStore = new HistoryStore(userDataPath);
    this.themeService = new ThemeService({ userDataPath });
    this.windows = new WindowManager(rendererDir);
    this.surfaceTheme = new SurfaceThemeService({
      getWindow: () => this.windows.main,
      getConsent: () => Boolean(this.settings.surfaceThemeConsent),
      getSettings: () => ({
        id: normalizeSurfaceThemeId(this.settings.surfaceThemeId),
        accent: this.settings.surfaceThemeAccent,
      }),
      onStateChange: (state) => {
        this.windows.broadcast(IPC.surfaceThemeState, state);
        this.scheduleBroadcast();
      },
    });
    this.native = new NativeIntegration({
      showMain: () => this.showMainWindow(),
      openNowPlaying: () => this.showMainWindow(),
      togglePlayback: () => void this.runPlayerCommand('toggle'),
      next: () => void this.runPlayerCommand('next'),
      previous: () => void this.runPlayerCommand('previous'),
      toggleMini: () => this.windows.toggleCompact(),
      quit: () => {
        this.shutdown();
        app.quit();
      },
    });
  }

  /** Boot the application. */
  async init(): Promise<void> {
    this.settings = await this.settingsStore.load();
    this.secrets = await this.secretStore.load();
    if (this.settings.lastfmApiSecret && this.secretStore.available) {
      await this.secretStore.patch({
        lastfmApiSecret: this.secrets.lastfmApiSecret || this.settings.lastfmApiSecret,
      });
      this.secrets = this.secretStore.get();
      this.settings = await this.settingsStore.patch({ lastfmApiSecret: '' });
    }

    await this.themeService.load();

    const credentials = this.resolveLastFmCredentials();
    this.lastfm = new LastFmService({
      apiKey: credentials.apiKey,
      apiSecret: credentials.apiSecret,
      sessionKey: this.secrets.lastfmSessionKey,
    });
    this.listenbrainz = new ListenBrainzService({
      token: this.secrets.listenbrainzToken,
    });

    this.engine = new TrackStateEngine({
      thresholds: this.settings.thresholds,
      config: this.settings.metadata,
      now: () => Date.now(),
      maxAccrualGapMs: 5000,
      onScrobble: (candidate) => void this.handleScrobble(candidate),
      onTrackChange: (state) => {
        this.scheduleBroadcast();
        void this.handleTrackChange(state);
      },
      onFinalize: (state, reason) => void this.recordHistory(state, reason),
      isDuplicate: (key) => this.duplicateKeys.has(key),
    });

    const queueStore = new JsonFile<QueueItem[]>(join(app.getPath('userData'), 'queue.json'), []);
    this.queue = new ScrobbleQueue({
      store: {
        read: async () => (await queueStore.read()) ?? [],
        write: async (items) => queueStore.write(items),
      },
      services: new Map<ServiceId, ScrobbleService>([
        ['lastfm', this.lastfm],
        ['listenbrainz', this.listenbrainz],
      ]),
      isDuplicate: (key) => this.duplicateKeys.has(key),
      onChange: () => this.scheduleBroadcast(),
      onResult: (item, result) => {
        this.lastServiceResults.set(item.service, result);
      },
    });
    await this.queue.load();

    this.windows.setSavedWindowState(this.settings.windowState ?? {});
    this.windows.setCloseToTray(this.settings.closeToTray);
    this.windows.setAlwaysOnTop(this.settings.alwaysOnTop);
    this.windows.setQuickPanelEnabled(this.settings.quickPanelEnabled);

    this.windows.officialPlayer.setEvents({
      onLoadState: (state, reason) => {
        this.playerLoadState = state;
        this.playerFailureReason = reason;
        if (state === 'failed' || state === 'crashed') {
          this.mediaBridge?.clear();
        }
        this.scheduleBroadcast();
      },
      onNavigation: (_url, authRequired) => {
        this.authRequired = authRequired;
        if (authRequired) {
          this.mediaBridge?.clear();
        }
        this.scheduleBroadcast();
      },
      onDocumentReplaced: () => {
        this.surfaceTheme.onDocumentReplaced();
      },
      onDomReady: (url) => {
        void this.surfaceTheme.onDomReady(url);
      },
      onInPageNavigate: (url) => {
        void this.surfaceTheme.onInPageNavigate(url);
      },
      onOpenSettings: () => {
        this.windows.openSettings();
      },
      onQuitRequest: () => {
        this.shutdown();
        app.quit();
      },
      shouldPreventClose: () => this.windows.shouldPreventMainClose(),
      onCloseToBackground: () => {
        this.scheduleBroadcast();
      },
    });

    this.mediaBridge = new MediaBridgeReceiver({
      getWindow: () => this.windows.main,
      onSnapshot: (snapshot) => {
        this.onMediaSnapshot(snapshot);
      },
      onStale: () => {
        this.latestSnapshot = null;
        this.resolved = undefined;
        this.lastPlaying = false;
        this.engine.handle({ type: 'state', playing: false, buffering: false, at: Date.now() });
        this.scheduleBroadcast();
      },
    });
    this.mediaBridge.start();

    const mainWindow = this.windows.createMain(
      this.settings.windowState?.main ?? this.settings.windowBounds,
    );
    mainWindow.on('resize', () => this.scheduleBroadcast());
    mainWindow.on('move', () => this.scheduleBroadcast());

    this.native.attachWindow(mainWindow);
    this.native.applySettings({
      notificationsEnabled: this.settings.notificationsEnabled,
      notifyOnScrobble: this.settings.notifyOnScrobble,
      startAtLogin: this.settings.startAtLogin,
    });

    this.registerIpc();
    this.installMenu();
    this.createTray();
    this.shortcuts.register((command) => void this.handleMediaKey(command));

    this.tickTimer = setInterval(() => void this.onEngineTick(), ENGINE_TICK_MS);
    this.queueTimer = setInterval(() => void this.processQueue(), QUEUE_INTERVAL_MS);

    await this.refreshServiceStatus();
    await this.refreshDuplicateKeys();
    nativeTheme.on('updated', () => this.scheduleBroadcast());
    await this.startMpris();

    if (this.settings.compactPlayerEnabled) {
      this.windows.openCompact();
    }
    if (this.settings.skinWindowEnabled) {
      this.windows.openSkin();
    }

    this.scheduleBroadcast();
  }

  /**
   * Resolve the Last.fm credential pair that is actually used for API calls.
   *
   * A user supplied pair wins when both halves are present; otherwise the
   * built-in VegaFM application credentials (injected at build time) are used
   * so a normal user never has to supply anything.
   */
  private resolveLastFmCredentials(): ResolvedLastFmCredentials {
    this.lastfmCredentials = resolveLastFmCredentials({
      userApiKey: this.settings.lastfmApiKey,
      userApiSecret: this.secrets.lastfmApiSecret,
    });
    return this.lastfmCredentials;
  }

  /** Stop the loopback callback server of a pending Last.fm authorization. */
  private async closeLastFmAuthServer(): Promise<void> {
    const server = this.lastfmAuthServer;
    this.lastfmAuthServer = undefined;
    if (!server) return;
    await server.close().catch(() => undefined);
  }

  /**
   * Finish the Last.fm authorization handshake in the background.
   *
   * The approved request token is exchanged for a session key, the session is
   * stored in the encrypted secret store and the connected account name is
   * resolved so the UI can show who is connected.
   */
  private async finishLastFmConnect(
    generation: number,
    credentials: { apiKey: string; apiSecret: string },
    token: string,
    server: LoopbackAuthServer,
  ): Promise<void> {
    try {
      const authClient = new LastFmService(credentials);
      const approved = await this.completeLastFmAuthorization(authClient, token, server);
      if (generation !== this.authGeneration) return;

      this.lastfm.setCredentials({
        apiKey: credentials.apiKey,
        apiSecret: credentials.apiSecret,
        sessionKey: approved.sessionKey,
      });
      await this.secretStore.patch({ lastfmSessionKey: approved.sessionKey });
      this.secrets = this.secretStore.get();
      await this.patchSettings({ lastfmEnabled: true });
      await this.refreshServiceStatus();
      this.serviceStatus.lastfm.connectionState = 'connected';
      this.serviceStatus.lastfm.authUrl = undefined;
      if (!this.serviceStatus.lastfm.account && approved.account) {
        this.serviceStatus.lastfm.account = approved.account;
      }
    } catch (error) {
      if (generation !== this.authGeneration) return;
      console.error(
        '[lastfm] the authorization failed:',
        error instanceof Error ? error.message : String(error),
      );
      this.serviceStatus.lastfm = {
        id: 'lastfm',
        configured: this.lastfmCredentials.usable,
        authorized: false,
        connectionState: 'authentication-failed',
        lastError: error instanceof Error ? error.message : 'Authorization failed.',
      };
    } finally {
      await this.closeLastFmAuthServer();
      this.scheduleBroadcast();
    }
  }

  /**
   * Complete the Last.fm authorization handshake.
   *
   * Two sources are used in parallel:
   *   * the loopback callback - the browser returns to VegaAM by itself once
   *     the user approved the request;
   *   * a slow polling fallback for browsers that do not follow the callback
   *     redirect.
   *
   * The approved request token is exchanged for a session key, which is the
   * only credential that is stored for the user.
   */
  private async completeLastFmAuthorization(
    authClient: LastFmService,
    token: string,
    server: LoopbackAuthServer,
    timeoutMs = lastFmAuthorizationTimeoutMs(),
  ): Promise<{ sessionKey: string; account?: string }> {
    const outcome = await runAuthorizationHandshake(
      {
        initialToken: token,
        requestToken: async () => {
          const result = await authClient.getToken();
          const renewed = (result.response as { token?: string })?.token;
          return {
            ok: Boolean(result.ok && renewed),
            token: renewed,
            error: result.error,
            errorCode: result.errorCode,
          };
        },
        checkSession: async (candidate) => {
          const result = await authClient.getSession(candidate);
          if (!result.ok) {
            console.log(
              `[lastfm] the request token is not approved yet (error ${result.errorCode ?? 'none'}).`,
            );
          }
          return {
            ok: Boolean(result.ok && authClient.session),
            sessionKey: authClient.session,
            account: authClient.username,
            error: result.error,
            errorCode: result.errorCode,
          };
        },
        exchangeSession: async (approved) => {
          // A Last.fm request token is single use. When the polling fallback
          // already exchanged it, the session is reused instead of asking the
          // service a second time.
          if (authClient.session) {
            return {
              ok: true,
              sessionKey: authClient.session,
              account: authClient.username,
            };
          }
          console.log('[lastfm] exchanging the approved token for a session key.');
          const result = await authClient.getSession(approved);
          return {
            ok: Boolean(result.ok && authClient.session),
            sessionKey: authClient.session,
            account: authClient.username,
            error: result.error,
            errorCode: result.errorCode,
          };
        },
        waitForCallback: (accept) => server.waitForToken(timeoutMs, accept),
      },
      {
        timeoutMs,
        onTokenRenewed: (renewed) => {
          // The request token expired before the user approved it. Publish the
          // new authorization URL so the drawer can offer the fresh page.
          this.serviceStatus.lastfm.authUrl = authClient.getAuthUrl(renewed, server.url);
          this.serviceStatus.lastfm.lastError = undefined;
          this.scheduleBroadcast();
          console.log(
            '[lastfm] the request token expired; a fresh authorization page was issued.',
          );
        },
      },
    );

    if (!outcome.ok || !outcome.sessionKey) {
      throw new Error(outcome.error ?? 'The Last.fm authorization failed.');
    }
    return { sessionKey: outcome.sessionKey, account: outcome.account };
  }

  /** Install the native application menu and its keyboard accelerators. */
  private installMenu(): void {
    installAppMenu({
      showMain: () => this.showMainWindow(),
      openSettings: () => {
        this.windows.openSettings();
      },
      toggleQuickPanel: () => {
        this.windows.toggleQuickPanel();
      },
      resetSurfaceAppearance: () => {
        void this.patchSettings({
          surfaceThemeId: null,
          surfaceThemeAccent: null,
        }).then(() => this.surfaceTheme.revert('menu-reset'));
      },
      openActivity: () => {
        this.windows.openActivity();
      },
      toggleCompact: () => {
        const visible = this.windows.toggleCompact();
        void this.patchSettings({ compactPlayerEnabled: visible, miniPlayerEnabled: visible });
      },
      toggleSkin: () => {
        const visible = this.windows.toggleSkin();
        void this.patchSettings({ skinWindowEnabled: visible });
      },
      openSkinWithId: (skinId) => {
        void this.patchSettings({ skinId, skinWindowEnabled: true }).then(() => {
          this.windows.openSkin();
        });
      },
      setColorMode: (mode) => {
        void this.patchSettings({ colorMode: mode });
      },
      reloadPlayer: () => {
        this.windows.officialPlayer.reload();
      },
      goBack: () => {
        this.windows.officialPlayer.goBack();
      },
      goForward: () => {
        this.windows.officialPlayer.goForward();
      },
      toggleMute: () => {
        this.windows.officialPlayer.toggleMute();
        this.scheduleBroadcast();
      },
      toggleAlwaysOnTop: () => {
        void this.patchSettings({ alwaysOnTop: !this.settings.alwaysOnTop });
      },
      clearSession: () => {
        void this.windows.officialPlayer.clearSession();
      },
      quit: () => {
        this.shutdown();
        app.quit();
      },
    });
  }

  /** Receive a validated snapshot from the isolated MediaSession preload bridge. */
  public ingestMediaSnapshot(snapshot: MediaBridgeSnapshot): void {
    this.onMediaSnapshot(snapshot);
  }

  private onMediaSnapshot(snapshot: MediaBridgeSnapshot): void {
    if (!this.settings.mediaBridgeConsent) {
      this.latestSnapshot = null;
      this.resolved = undefined;
      this.nowPlayingStatus = 'MediaSession bridge disabled in Settings';
      this.scheduleBroadcast();
      return;
    }

    this.latestSnapshot = snapshot;
    const audible = this.windows.officialPlayer.isCurrentlyAudible;
    const playing =
      snapshot.playbackState === 'playing' ||
      (snapshot.playbackState !== 'paused' && audible);

    const resolved = resolveMediaSessionMetadata(
      {
        sessionTitle: snapshot.sessionTitle,
        sessionArtist: snapshot.sessionArtist,
        sessionAlbum: snapshot.sessionAlbum,
        artwork: snapshot.artworkUrl,
        playing,
      },
      {
        knownChannels: this.settings.metadata.channelMappings.map((m) => m.channel),
      },
    );
    this.resolved = resolved;

    const combined = snapshot.sessionArtist ?? null;

    const raw: RawMetadata = {
      channel: resolved.channel,
      artist: resolved.artist,
      title: resolved.rawTitleField ?? combined,
      album: resolved.album,
      origin: 'media-session',
      receivedAt: snapshot.observedAt,
      qualifier: resolved.qualifier,
      programme: resolved.programme,
      channelNumber: resolved.channelNumber,
      evidence: resolved.evidence,
      reasons: resolved.reasons,
      scrobbleSafe: resolved.scrobbleSafe,
      scrobbleBlockReason: resolved.scrobbleBlockReason,
    };

    if (resolved.channel !== this.lastChannel) {
      this.lastChannel = resolved.channel;
      this.engine.handle({ type: 'channel', channel: resolved.channel, at: snapshot.observedAt });
    }

    this.lastRaw = raw;
    this.engine.handle({ type: 'metadata', raw, at: snapshot.observedAt });

    if (playing !== this.lastPlaying) {
      this.lastPlaying = playing;
      this.lastBuffering = false;
      this.engine.handle({
        type: 'state',
        playing,
        buffering: false,
        at: snapshot.observedAt,
      });
      if (playing && this.engine.state) {
        void this.handleTrackChange(this.engine.state);
      }
    }

    this.engine.setDuration(undefined);
    this.engine.handle({ type: 'tick', at: snapshot.observedAt });
    this.scheduleBroadcast();
  }

  private async onEngineTick(): Promise<void> {
    const now = Date.now();
    if (this.latestSnapshot && this.settings.mediaBridgeConsent) {
      const audible = this.windows.officialPlayer.isCurrentlyAudible;
      const playing =
        this.latestSnapshot.playbackState === 'playing' ||
        (this.latestSnapshot.playbackState !== 'paused' && audible);
      if (playing !== this.lastPlaying) {
        this.lastPlaying = playing;
        this.engine.handle({
          type: 'state',
          playing,
          buffering: false,
          at: now,
        });
        if (playing && this.engine.state) {
          void this.handleTrackChange(this.engine.state);
        }
      }
    }
    this.engine.handle({ type: 'tick', at: now });
    this.scheduleBroadcast();
  }

  private async startMpris(): Promise<void> {
    if (process.platform !== 'linux') return;
    if (!this.settings.mprisEnabled) return;
    try {
      const service = new MprisService({
        identity: 'VegaAM',
        desktopEntry: 'vegaam',
        onCommand: (command) => void this.handleMprisCommand(command),
      });
      await service.start();
      this.mpris = service;
    } catch {
      this.mpris = undefined;
    }
  }

  private async handleMprisCommand(command: MprisCommand): Promise<void> {
    switch (command.type) {
      case 'play':
        await this.runPlayerCommand('play');
        break;
      case 'pause':
        await this.runPlayerCommand('pause');
        break;
      case 'playPause':
        await this.runPlayerCommand('toggle');
        break;
      case 'next':
        await this.runPlayerCommand('next');
        break;
      case 'previous':
        await this.runPlayerCommand('previous');
        break;
      case 'raise':
        this.showMainWindow();
        break;
      case 'quit':
        this.shutdown();
        app.quit();
        break;
      default:
        break;
    }
  }

  public showMainWindow(): void {
    this.windows.showMain();
  }

  public async listHistory(): Promise<HistoryEntry[]> {
    return this.historyStore.list();
  }

  private async refreshDuplicateKeys(): Promise<void> {
    const entries = await this.historyStore.list();
    this.duplicateKeys.clear();
    for (const entry of entries) {
      if (!entry.scrobbled || !entry.artist) continue;
      this.duplicateKeys.add(scrobbleKey(entry.artist, entry.title, entry.startedAt));
    }
  }

  private async handleTrackChange(state: TrackState | undefined): Promise<void> {
    if (!state?.normalized || !this.engine.isPlaying || this.lastBuffering) return;
    const normalized = state.normalized;
    if (normalized.skip || normalized.ambiguous || normalized.scrobbleSafe === false) {
      this.nowPlayingStatus =
        normalized.skipReason || normalized.scrobbleBlockReason || 'Ambiguous metadata';
      return;
    }
    const artist = normalized.scrobbleArtist;
    const title = normalized.scrobbleTitle;
    if (!artist || !title) return;

    this.native.announceNowPlaying({
      playing: this.lastPlaying,
      buffering: this.lastBuffering,
      title,
      artist,
      channel: state.raw.channel ?? null,
      artwork: this.latestSnapshot?.artworkUrl ?? null,
      durationMs: state.durationMs ?? null,
      positionMs: null,
    });

    // Probe Windows GSMTC capabilities in the background when a track is playing.
    void this.gsmtc.probe(this.latestSnapshot?.sessionTitle ?? title).then(() => {
      this.scheduleBroadcast();
    });

    const services = this.enabledServices();
    if (services.length === 0) {
      this.nowPlayingStatus = 'No scrobbling service is connected';
      this.scheduleBroadcast();
      return;
    }
    const payload = {
      artist,
      title,
      timestamp: Math.floor(state.startedAt / 1000),
      durationMs: state.durationMs,
      album: normalized.album ?? null,
    };
    const statuses: string[] = [];
    for (const id of services) {
      const service = id === 'lastfm' ? this.lastfm : this.listenbrainz;
      try {
        const result = await service.nowPlaying(payload);
        statuses.push(
          `${serviceLabel(id)}: ${result.ok ? 'Now playing acknowledged' : result.error || 'Failed'}`,
        );
      } catch (error) {
        statuses.push(
          `${serviceLabel(id)}: ${error instanceof Error ? error.message : 'Failed'}`,
        );
      }
    }
    if (statuses.length > 0) {
      this.nowPlayingStatus = statuses.join(' · ');
      this.scheduleBroadcast();
    }
  }

  private async handleMediaKey(command: string): Promise<void> {
    const result = await this.runPlayerCommand(command);
    this.notify('media-key', result);
  }

  /**
   * Execute a capability-gated playback command without ever touching the
   * official SiriusXM DOM.
   */
  async runPlayerCommand(command: string): Promise<{ ok: boolean; detail: string }> {
    switch (command) {
      case 'back': {
        const ok = this.windows.officialPlayer.goBack();
        return {
          ok,
          detail: ok ? 'Navigated back.' : 'No navigation history in that direction.',
        };
      }
      case 'forward': {
        const ok = this.windows.officialPlayer.goForward();
        return {
          ok,
          detail: ok ? 'Navigated forward.' : 'No navigation history in that direction.',
        };
      }
      case 'mute': {
        const isMuted = this.windows.officialPlayer.toggleMute();
        this.scheduleBroadcast();
        return {
          ok: true,
          detail: isMuted ? 'Official player audio muted.' : 'Official player audio unmuted.',
        };
      }
      case 'play':
      case 'pause':
      case 'toggle':
      case 'next':
      case 'previous': {
        const hint = this.latestSnapshot?.sessionTitle ?? this.resolved?.title ?? undefined;
        const res = await this.gsmtc.invoke(command, hint);
        this.scheduleBroadcast();
        return res;
      }
      default:
        return {
          ok: false,
          detail: `Unsupported command "${command}". Use the official SiriusXM player window.`,
        };
    }
  }

  private enabledServices(): ServiceId[] {
    const services: ServiceId[] = [];
    if (this.settings.lastfmEnabled && this.lastfm.isConfigured()) services.push('lastfm');
    if (this.settings.listenbrainzEnabled && this.listenbrainz.isConfigured()) {
      services.push('listenbrainz');
    }
    return services;
  }

  private isChannelMuted(channel: string | null): boolean {
    if (!channel) return false;
    const target = channelKey(channel);
    const list = this.settings.scrobbleMutedChannels ?? this.settings.mutedChannels ?? [];
    return list.some((entry) => channelKey(entry) === target);
  }

  private async handleScrobble(candidate: {
    artist: string;
    title: string;
    timestamp: number;
    durationMs?: number;
    album?: string | null;
    track: NormalizedTrack;
    reason: string;
  }): Promise<void> {
    if (!this.settings.mediaBridgeConsent) {
      await this.recordHistoryEntry(
        candidate,
        'MediaSession bridge consent is disabled in Settings.',
      );
      return;
    }
    const channel = candidate.track?.raw?.channel ?? null;
    if (this.isChannelMuted(channel)) {
      await this.recordHistoryEntry(
        candidate,
        `The channel "${channel}" is muted — the track was not scrobbled.`,
      );
      return;
    }
    const services = this.enabledServices();
    if (services.length === 0) {
      await this.recordHistoryEntry(candidate, 'No scrobbling service is enabled.');
      return;
    }

    let items: QueueItem[];
    try {
      items = await this.queue.enqueue(
        {
          artist: candidate.artist,
          title: candidate.title,
          timestamp: candidate.timestamp,
          durationMs: candidate.durationMs,
          album: candidate.album ?? null,
        },
        services,
      );
    } catch {
      await this.recordHistoryEntry(
        candidate,
        'Submission queue full: retry this track from History after clearing old failures.',
      );
      return;
    }
    await this.recordHistoryEntry(
      candidate,
      items.length
        ? `Queued for ${items.map((i) => i.service).join(', ')}.`
        : 'Duplicate already queued or acknowledged.',
    );
    await this.processQueue();
  }

  /**
   * Submit a scrobble through the real submission queue.
   *
   * The live acceptance runner uses it to prove that a completed listen is
   * acknowledged by the service: the payload travels through the same queue,
   * the same duplicate window and the same service instance that the normal
   * playback path uses.
   */
  async submitScrobble(payload: {
    artist: string;
    title: string;
    timestamp?: number;
    album?: string | null;
    durationMs?: number;
  }): Promise<
    { service: string; ok: boolean; error?: string; response?: unknown }[]
  > {
    const services = this.enabledServices();
    if (services.length === 0) {
      return [
        { service: 'none', ok: false, error: 'No scrobbling service is connected.' },
      ];
    }

    const timestamp = payload.timestamp ?? Math.floor(Date.now() / 1000);
    const items = await this.queue.enqueue(
      {
        artist: payload.artist,
        title: payload.title,
        timestamp,
        durationMs: payload.durationMs,
        album: payload.album ?? null,
      },
      services,
      { ignoreDuplicate: true },
    );
    await this.processQueue();

    const results: { service: string; ok: boolean; error?: string; response?: unknown }[] = [];
    for (const item of items) {
      const current = this.queue.list().find((entry) => entry.id === item.id);
      const raw = this.lastServiceResults.get(item.service);
      results.push({
        service: item.service,
        ok: current?.state === 'done',
        error: current?.lastError ?? raw?.error,
        response: raw?.response,
      });
    }
    return results;
  }

  async retryHistoryEntry(id: string): Promise<{ ok: boolean; detail: string }> {
    const entries = await this.historyStore.list();
    const entry = entries.find((item) => item.id === id);
    if (!entry) return { ok: false, detail: 'That entry is not in the history any more.' };
    if (!entry.artist) {
      return { ok: false, detail: 'The entry has no artist, so it cannot be submitted.' };
    }

    const connected = this.enabledServices();
    if (connected.length === 0) {
      return { ok: false, detail: 'No scrobbling service is connected.' };
    }

    const accepted = new Set(entry.services.filter((s) => s.ok).map((s) => s.service));
    const targets = connected.filter((service) => !accepted.has(service));
    if (targets.length === 0) {
      return { ok: false, detail: 'Every connected service already accepted this track.' };
    }

    const timestamp = Math.floor(entry.startedAt / 1000);
    const payload = {
      artist: entry.artist,
      title: entry.title,
      timestamp,
      album: entry.normalized?.concert?.venue ?? null,
    };

    const queued = this.queue
      .list()
      .filter(
        (item) =>
          item.artist === payload.artist &&
          item.title === payload.title &&
          item.timestamp === timestamp &&
          targets.includes(item.service),
      );
    let count = 0;
    for (const item of queued) {
      if (await this.queue.retry(item.id)) count += 1;
    }

    const missing = targets.filter((service) => !queued.some((item) => item.service === service));
    if (missing.length > 0) {
      try {
        const created = await this.queue.enqueue(payload, missing, { ignoreDuplicate: true });
        count += created.length;
      } catch {
        return {
          ok: false,
          detail: 'The submission queue is full. Clear the failed submissions first.',
        };
      }
    }

    if (count === 0) {
      return { ok: false, detail: 'The track is already queued - nothing to retry.' };
    }

    await this.processQueue();
    return {
      ok: true,
      detail: `Queued "${entry.artist} — ${entry.title}" for ${targets.join(', ')}.`,
    };
  }

  private async processQueue(): Promise<void> {
    const doneBefore = new Set(
      this.queue
        .list()
        .filter((item) => item.state === 'done')
        .map((item) => item.id),
    );
    const result = await this.queue.process();
    if (result.sent > 0 || result.failed > 0) {
      for (const item of this.queue.list()) {
        if (item.state === 'done' || item.lastError) {
          const entry = await this.findHistoryEntry(item.artist, item.title, item.timestamp);
          if (entry) {
            await this.historyStore.recordService(entry.id, {
              service: item.service,
              ok: item.state === 'done',
              error: item.lastError,
              at: Date.now(),
            });
          }
        }
      }
      await this.refreshDuplicateKeys();

      const submitted = this.queue
        .list()
        .filter((item) => item.state === 'done' && !doneBefore.has(item.id));
      if (submitted.length > 0) {
        const first = submitted[0];
        this.native.announceScrobble(
          first?.artist ?? '',
          first?.title ?? '',
          submitted.map((item) => item.service),
        );
      }
    }
    // A rejected session is detected by the documented Last.fm error code,
    // not by a substring of the error message.
    const lastfmResult = this.lastServiceResults.get('lastfm');
    if (
      lastfmResult &&
      !lastfmResult.ok &&
      lastfmResult.errorCode === LASTFM_ERROR.invalidSessionKey
    ) {
      this.serviceStatus.lastfm.authorized = false;
      this.serviceStatus.lastfm.connectionState = 'session-invalid';
      this.serviceStatus.lastfm.lastError =
        'Last.fm rejected the session. Connect Last.fm again in Accounts.';
    }
    this.scheduleBroadcast();
  }

  private async findHistoryEntry(
    artist: string,
    title: string,
    timestamp: number,
  ): Promise<HistoryEntry | undefined> {
    const entries = await this.historyStore.list();
    return entries.find(
      (entry) =>
        entry.artist?.toLowerCase() === artist.toLowerCase() &&
        entry.title.toLowerCase() === title.toLowerCase() &&
        Math.floor(entry.startedAt / 1000) === timestamp,
    );
  }

  private async recordHistory(
    state: {
      raw: RawMetadata;
      normalized: NormalizedTrack;
      startedAt: number;
      scrobbled: boolean;
      scrobbleReason?: string;
    },
    reason: string,
  ): Promise<void> {
    const normalized = state.normalized;
    const id = normalized.scrobbleArtist
      ? scrobbleKey(normalized.scrobbleArtist, normalized.scrobbleTitle, state.startedAt)
      : `track-${state.startedAt}`;

    const entry: HistoryEntry = {
      id,
      startedAt: Math.floor(state.startedAt / 1000) * 1000,
      at: Date.now(),
      artist: normalized.scrobbleArtist,
      title: normalized.scrobbleTitle,
      channel: state.raw.channel ?? null,
      rawArtist: state.raw.artist ?? null,
      rawTitle: state.raw.title ?? null,
      normalized,
      scrobbled: false,
      services: [],
      reason: state.scrobbleReason ?? reason,
    };
    await this.historyStore.upsert(entry);
    await this.refreshDuplicateKeys();
    this.scheduleBroadcast();
  }

  private async recordHistoryEntry(
    candidate: {
      artist: string;
      title: string;
      timestamp: number;
      durationMs?: number;
      album?: string | null;
      track: NormalizedTrack;
      reason: string;
    },
    reason: string,
  ): Promise<void> {
    const normalized = candidate.track;
    const id = scrobbleKey(candidate.artist, candidate.title, candidate.timestamp * 1000);
    const entry: HistoryEntry = {
      id,
      startedAt: candidate.timestamp * 1000,
      at: Date.now(),
      artist: candidate.artist,
      title: candidate.title,
      channel: normalized?.raw?.channel ?? null,
      rawArtist: normalized?.raw?.artist ?? null,
      rawTitle: normalized?.raw?.title ?? null,
      normalized,
      scrobbled: false,
      services: [],
      reason,
    };
    await this.historyStore.upsert(entry);
    this.scheduleBroadcast();
  }

  async refreshServiceStatus(): Promise<void> {
    const lastfm = await this.lastfm.verify();
    const listenbrainz = await this.listenbrainz.verify();
    lastfm.connectionState = lastfm.authorized
      ? 'connected'
      : this.lastfm.session
        ? 'session-invalid'
        : 'not-configured';
    lastfm.credentialSource = this.lastfmCredentials.source;

    // A session the service rejected is dead weight: drop it so the retry
    // queue does not keep hammering an invalid session and the user is asked
    // to connect again.
    if (
      lastfm.errorCode === LASTFM_ERROR.invalidSessionKey &&
      this.secrets.lastfmSessionKey
    ) {
      await this.secretStore.patch({ lastfmSessionKey: '' });
      this.secrets = this.secretStore.get();
      await this.lastfm.disconnect();
      lastfm.connectionState = 'session-invalid';
    }

    this.serviceStatus = { lastfm, listenbrainz };
    this.scheduleBroadcast();
  }

  private capabilitiesView(): PlaybackCapabilities {
    return buildPlaybackCapabilities({
      isMuted: this.windows.officialPlayer.isMuted,
      gsmtc: this.gsmtc.state,
      mprisActive: Boolean(this.mpris),
    });
  }

  private playbackView(): PlaybackView {
    const state = this.engine?.state;
    const normalized = state?.normalized;
    const resolved = this.resolved;
    return {
      channel: state?.raw.channel ?? resolved?.channel ?? null,
      channelNumber: resolved?.channelNumber ?? state?.raw.channelNumber ?? null,
      programme: resolved?.programme ?? state?.raw.programme ?? null,
      qualifier: normalized?.qualifier ?? state?.raw.qualifier ?? null,
      rawArtist: state?.raw.artist ?? null,
      rawTitle: state?.raw.title ?? null,
      artist: normalized?.artist ?? null,
      title: normalized?.title ?? '',
      displayTitle: normalized?.displayTitle ?? '',
      concert: normalized?.concert ?? null,
      playing: this.lastPlaying,
      buffering: this.lastBuffering,
      muted: this.windows.officialPlayer.isMuted,
      positionMs: null,
      durationMs: state?.durationMs ?? null,
      artwork: this.latestSnapshot?.artworkUrl ?? null,
      source: normalized?.source ?? 'unknown',
      evidence: normalized?.evidence ?? 'none',
      evidenceReasons: normalized?.evidenceReasons ?? [],
      ambiguous: normalized?.ambiguous ?? true,
      skipped: normalized?.skip ?? false,
      skipReason: normalized?.skipReason,
      scrobbleReason: state?.scrobbleReason,
      listeningMs: state?.listeningMs ?? 0,
      thresholdMs: this.engine?.effectiveThresholdMs ?? this.settings.thresholds.radioMinListenMs,
      songEstimateMs: this.engine?.songEstimateMs ?? 0,
      observedSongCount: this.engine?.observedSongCount ?? 0,
      songEstimateTrusted: this.engine?.songEstimateTrusted ?? false,
      pending: !state && Boolean(this.lastRaw.title),
    };
  }

  private settingsView(): SettingsView {
    return {
      settingsVersion: this.settings.settingsVersion,
      theme: this.settings.theme,
      skinId: this.settings.skinId,
      colorMode: this.settings.colorMode,
      accentColor: this.settings.accentColor ?? null,
      artworkTint: this.settings.artworkTint,
      surfaceThemeId: this.settings.surfaceThemeId ?? null,
      surfaceThemeAccent: this.settings.surfaceThemeAccent ?? null,
      surfaceThemeConsent: Boolean(this.settings.surfaceThemeConsent),
      surfaceThemeSnapshot: this.settings.surfaceThemeSnapshot ?? '2026-11-05',
      quickPanelEnabled: this.settings.quickPanelEnabled !== false,
      volume: this.settings.volume,
      alwaysOnTop: this.settings.alwaysOnTop,
      compactPlayerEnabled: this.settings.compactPlayerEnabled,
      miniPlayerEnabled: this.settings.compactPlayerEnabled,
      skinWindowEnabled: this.settings.skinWindowEnabled,
      closeToTray: this.settings.closeToTray,
      mediaBridgeConsent: this.settings.mediaBridgeConsent,
      lastfmEnabled: this.settings.lastfmEnabled,
      listenbrainzEnabled: this.settings.listenbrainzEnabled,
      scrobbleMutedChannels: this.settings.scrobbleMutedChannels,
      mutedChannels: this.settings.scrobbleMutedChannels,
      thresholds: this.settings.thresholds,
      metadata: this.settings.metadata,
      lastfmApiKey: this.settings.lastfmApiKey ?? '',
      onboardingDismissed: this.settings.onboardingDismissed,
      notificationsEnabled: this.settings.notificationsEnabled,
      notifyOnScrobble: this.settings.notifyOnScrobble,
      startAtLogin: this.settings.startAtLogin,
      mprisEnabled: this.settings.mprisEnabled,
      windowState: this.settings.windowState ?? {},
    };
  }

  private resolveThemeBlock(themeId: string): ThemeSummary & { css: string } {
    const theme = this.themeService.get(themeId) ?? this.themeService.get('modern');
    const mode =
      this.settings.colorMode === 'system'
        ? nativeTheme.shouldUseDarkColors
          ? 'dark'
          : 'light'
        : this.settings.colorMode;
    const themeCss = this.themeService.css(theme?.id ?? 'modern', {
      mode,
      accentColor: this.settings.accentColor,
      artworkTint: this.settings.artworkTint,
    });
    return {
      id: theme?.id ?? 'modern',
      name: theme?.name ?? 'Modern',
      version: theme?.version ?? '1.0.0',
      author: theme?.author,
      description: theme?.description,
      mode: theme?.mode ?? 'dark',
      layout: theme?.layout,
      builtin: !theme || theme.layout !== undefined,
      supportsLight: theme?.supportsLight !== false,
      source: 'builtin',
      css: themeCss,
    };
  }

  buildState(): AppState {
    const themeBlock = this.resolveThemeBlock(this.settings.theme);
    const skinThemeBlock = this.resolveThemeBlock(this.settings.skinId || this.settings.theme);

    return {
      monitor: {
        observedAt: this.latestSnapshot?.observedAt ?? null,
        metadataSource: this.settings.mediaBridgeConsent
          ? 'Official MediaSession (read-only preload bridge)'
          : 'Disabled (MediaSession bridge consent off)',
        nowPlaying: this.nowPlayingStatus,
        eligibility:
          this.engine?.state?.scrobbleReason ??
          (this.engine?.state?.normalized.skip
            ? this.engine.state.normalized.skipReason ?? 'Filtered metadata'
            : this.engine?.state?.normalized.scrobbleBlockReason ??
              `Waiting for listening threshold (${Math.round(
                (this.engine?.effectiveThresholdMs ?? this.settings.thresholds.radioMinListenMs) / 1000,
              )}s adaptive)`),
      },
      playback: this.playbackView(),
      capabilities: this.capabilitiesView(),
      player: {
        url: this.windows.officialPlayer.url,
        loadState: this.playerLoadState,
        authRequired: this.authRequired,
        reachable: this.playerLoadState === 'ready',
        failureReason: this.playerFailureReason || undefined,
        lastError: this.lastError,
      },
      services: this.serviceStatus,
      settings: this.settingsView(),
      theme: themeBlock,
      skinTheme: skinThemeBlock,
      themes: this.themeService.summaries(),
      surfaceTheme: this.surfaceTheme.getState(),
      iconIdentity: inspectIconIdentity(join(this.rendererDir, '..', 'icons')),
      credentials: this.secretStore.status(),
      queue: this.queue ? this.queue.list() : [],
      ready: true,
    };
  }

  scheduleBroadcast(): void {
    if (this.pendingBroadcast) return;
    this.pendingBroadcast = true;
    this.stateBroadcastTimer = setTimeout(() => {
      this.pendingBroadcast = false;
      const state = this.buildState();
      this.windows.broadcast(IPC.stateUpdate, state);
      const playback = state.playback;
      this.native.updatePlayback({
        playing: playback.playing,
        buffering: playback.buffering,
        title: playback.displayTitle,
        artist: playback.artist,
        channel: playback.channel,
        artwork: playback.artwork,
        durationMs: playback.durationMs,
        positionMs: playback.positionMs,
      });
      this.tray?.update({
        alwaysOnTop: this.settings.alwaysOnTop,
        playing: this.lastPlaying,
        muted: playback.muted,
        canPlayPause: state.capabilities.canPlayPause,
        title: playback.displayTitle,
      });
      this.updateMpris(playback);
    }, 150);
  }

  notify(kind: string, payload: unknown): void {
    this.windows.broadcast('app:notify', { kind, payload });
  }

  private updateMpris(playback: PlaybackView): void {
    const service = this.mpris;
    if (!service) return;
    try {
      service.setPlaybackStatus(playback.playing ? 'Playing' : 'Paused');
      service.setVolume(this.settings.volume);
      service.setMetadata({
        title: playback.displayTitle || playback.title,
        artist: playback.artist ? [playback.artist] : [],
        album: playback.concert?.dateText ?? undefined,
        artUrl: playback.artwork ?? undefined,
        lengthUs: playback.durationMs ? playback.durationMs * 1000 : undefined,
      });
    } catch {
      /* ignore */
    }
  }

  async patchSettings(
    patch: Partial<AppSettings>,
    options?: { fromSurfaceIpc?: boolean },
  ): Promise<AppSettings> {
    const previous = this.settings;
    this.settings = await this.settingsStore.patch(this.applyMappingTombstones(previous, patch));
    this.engine.configure({
      thresholds: this.settings.thresholds,
      config: this.settings.metadata,
    });
    if (
      previous.metadata.correctionRules !== this.settings.metadata.correctionRules ||
      previous.metadata.manualCorrections !== this.settings.metadata.manualCorrections ||
      previous.metadata.artistAliases !== this.settings.metadata.artistAliases ||
      previous.metadata.channelMappings !== this.settings.metadata.channelMappings
    ) {
      this.engine.reapplyConfig();
    }
    this.windows.setAlwaysOnTop(this.settings.alwaysOnTop);
    this.windows.setCompactPlayerEnabled(this.settings.compactPlayerEnabled);
    this.windows.setCloseToTray(this.settings.closeToTray);
    this.windows.setQuickPanelEnabled(this.settings.quickPanelEnabled);
    if (!this.settings.skinWindowEnabled && previous.skinWindowEnabled) {
      this.windows.companions.closeSkin();
    }
    if (!options?.fromSurfaceIpc) {
      const surfaceChanged =
        previous.surfaceThemeId !== this.settings.surfaceThemeId ||
        previous.surfaceThemeAccent !== this.settings.surfaceThemeAccent ||
        previous.surfaceThemeConsent !== this.settings.surfaceThemeConsent;
      if (surfaceChanged) {
        if (!this.settings.surfaceThemeConsent || !this.settings.surfaceThemeId) {
          void this.surfaceTheme.revert('settings-patch');
        } else {
          void this.surfaceTheme.setActive(
            normalizeSurfaceThemeId(this.settings.surfaceThemeId),
            { accent: this.settings.surfaceThemeAccent },
          );
        }
      }
    }
    if (process.platform === 'linux') {
      if (this.settings.mprisEnabled && !this.mpris) void this.startMpris();
      if (!this.settings.mprisEnabled && this.mpris) {
        void this.mpris.stop().catch(() => undefined);
        this.mpris = undefined;
      }
    }
    this.native.applySettings({
      notificationsEnabled: this.settings.notificationsEnabled,
      notifyOnScrobble: this.settings.notifyOnScrobble,
      startAtLogin: this.settings.startAtLogin,
    });
    this.scheduleBroadcast();
    return this.settings;
  }

  private applyMappingTombstones(
    previous: AppSettings,
    patch: Partial<AppSettings>,
  ): Partial<AppSettings> {
    const incoming = patch.metadata?.channelMappings;
    if (!Array.isArray(incoming)) return patch;

    const kept = new Set(incoming.map((m) => channelKey(m.channel)).filter(Boolean));
    const tombstones = new Set(previous.metadata.removedChannelMappings ?? []);
    for (const mapping of previous.metadata.channelMappings) {
      if (!kept.has(channelKey(mapping.channel))) tombstones.add(mapping.channel);
    }

    return {
      ...patch,
      metadata: {
        ...(patch.metadata ?? previous.metadata),
        removedChannelMappings: [...tombstones],
      },
    };
  }

  private createTray(): void {
    this.tray = new TrayController({
      showMain: () => this.showMainWindow(),
      toggleMini: () => {
        const visible = this.windows.toggleCompact();
        void this.patchSettings({ compactPlayerEnabled: visible, miniPlayerEnabled: visible });
        return visible;
      },
      openSkinWithId: (skinId) => {
        void this.patchSettings({ skinId, skinWindowEnabled: true }).then(() => {
          this.windows.openSkin();
        });
      },
      openActivity: () => {
        this.windows.openActivity();
      },
      openSettings: () => {
        this.windows.openSettings();
      },
      openQuickPanel: () => {
        this.windows.openQuickPanel();
      },
      resetSurfaceAppearance: () => {
        void this.patchSettings({
          surfaceThemeId: null,
          surfaceThemeAccent: null,
        }).then(() => this.surfaceTheme.revert('tray-reset'));
      },
      togglePlayback: () => void this.runPlayerCommand('toggle'),
      toggleMute: () => {
        this.windows.officialPlayer.toggleMute();
        this.scheduleBroadcast();
      },
      setAlwaysOnTop: (value) => void this.patchSettings({ alwaysOnTop: value }),
      quit: () => {
        this.shutdown();
        app.quit();
      },
    });
    this.tray.create();
  }

  private registerIpc(): void {
    this.unregisterSurfaceThemeIpc = registerSurfaceThemeIpc({
      service: this.surfaceTheme,
      getAllowedWindows: () => this.windows.getVegaWindows(),
      getAllowedWebContents: () => this.windows.getVegaWebContents(),
      getOfficialWindow: () => this.windows.main,
      getConsent: () => Boolean(this.settings.surfaceThemeConsent),
      getSettings: () => ({
        id: normalizeSurfaceThemeId(this.settings.surfaceThemeId),
        accent: this.settings.surfaceThemeAccent,
      }),
      saveSurfaceSettings: async (patch) => {
        await this.patchSettings(patch, { fromSurfaceIpc: true });
      },
      getDiagnosticsMeta: () => ({
        appVersion: app.getVersion(),
        platform: process.platform,
        url: this.windows.officialPlayer.url,
      }),
    });

    ipcMain.handle(IPC.stateGet, () => this.buildState());

    /**
     * Read the system clipboard.
     *
     * The account fields hold a token, an API key and a shared secret. A
     * keyboard paste is not always available inside the drawer (a custom
     * application menu can take the native clipboard accelerator with it), so
     * the fields also offer an explicit "Paste" button that reads the
     * clipboard through the main process.
     */
    ipcMain.handle(IPC.clipboardRead, () => {
      try {
        return clipboard.readText();
      } catch {
        return '';
      }
    });

    ipcMain.handle(IPC.settingsPatch, async (_event, patch: unknown) => {
      const safe = sanitizeSettingsPatch(patch);
      return this.patchSettings(safe);
    });

    ipcMain.handle(IPC.historyList, async () => {
      const entries = await this.historyStore.list();
      return entries.map((entry) => ({
        id: entry.id,
        startedAt: entry.startedAt,
        at: entry.at,
        artist: entry.artist,
        title: entry.title,
        channel: entry.channel,
        rawArtist: entry.rawArtist,
        rawTitle: entry.rawTitle,
        scrobbled: entry.scrobbled,
        services: entry.services,
        reason: entry.reason,
        source: entry.normalized?.source ?? 'unknown',
        evidence: entry.normalized?.evidence ?? 'none',
        evidenceReasons: entry.normalized?.evidenceReasons ?? [],
        notes: entry.normalized?.notes ?? [],
        corrections: entry.normalized?.corrections ?? [],
        concert: entry.normalized?.concert ?? null,
      }));
    });

    ipcMain.handle(IPC.historyClear, async () => {
      await this.historyStore.clear();
      await this.refreshDuplicateKeys();
      this.scheduleBroadcast();
      return true;
    });

    ipcMain.handle(IPC.historyRetry, async (_event, id: unknown) => {
      if (typeof id !== 'string' || !id) {
        return { ok: false, detail: 'Invalid history entry.' };
      }
      return this.retryHistoryEntry(id);
    });

    ipcMain.handle(IPC.themeList, () => this.themeService.summaries());
    ipcMain.handle(IPC.themeSelect, async (_event, id: unknown) => {
      if (typeof id !== 'string') return false;
      if (!this.themeService.get(id)) return false;
      await this.patchSettings({ theme: id, skinId: id });
      return true;
    });
    ipcMain.handle(IPC.skinSelect, async (_event, id: unknown) => {
      if (typeof id !== 'string') return false;
      if (!this.themeService.get(id)) return false;
      await this.patchSettings({ skinId: id });
      return true;
    });
    ipcMain.handle(IPC.themeImport, async (_event, json: unknown) => {
      if (typeof json !== 'string') return { ok: false, errors: ['Invalid theme payload.'] };
      const result = await this.themeService.import(json);
      this.scheduleBroadcast();
      return result;
    });
    ipcMain.handle(IPC.themeExport, (_event, id: unknown) => {
      if (typeof id !== 'string') return undefined;
      return this.themeService.export(id);
    });
    ipcMain.handle(IPC.themePreview, (_event, id: unknown, options: unknown) => {
      if (typeof id !== 'string') return '';
      const raw = (options ?? {}) as Record<string, unknown>;
      return this.themeService.previewCss(id, {
        mode: raw.mode === 'light' || raw.mode === 'dark' ? raw.mode : undefined,
        accentColor: typeof raw.accentColor === 'string' ? raw.accentColor : undefined,
        artworkTint: typeof raw.artworkTint === 'boolean' ? raw.artworkTint : undefined,
      });
    });

    ipcMain.handle(IPC.themeImportFile, async () => {
      const window = this.windows.main;
      const options = {
        title: 'Import a theme',
        filters: [{ name: 'Theme', extensions: ['json'] }],
        properties: ['openFile' as const],
      };
      const selection = window
        ? await dialog.showOpenDialog(window, options)
        : await dialog.showOpenDialog(options);
      if (selection.canceled || selection.filePaths.length === 0) {
        return { ok: false, canceled: true, errors: [] };
      }
      try {
        const json = await readFile(selection.filePaths[0] as string, 'utf8');
        const result = await this.themeService.import(json);
        this.scheduleBroadcast();
        return { ...result, canceled: false };
      } catch (error) {
        return {
          ok: false,
          canceled: false,
          errors: [error instanceof Error ? error.message : 'The theme file could not be read.'],
        };
      }
    });

    ipcMain.handle(IPC.themeExportFile, async (_event, id: unknown) => {
      if (typeof id !== 'string') return { ok: false, canceled: true, errors: [] };
      const theme = this.themeService.get(id);
      if (!theme) return { ok: false, canceled: false, errors: ['Unknown theme.'] };
      const json = this.themeService.export(id);
      if (!json) return { ok: false, canceled: false, errors: ['The theme could not be exported.'] };
      const window = this.windows.main;
      const options = {
        title: 'Export the theme',
        defaultPath: `${theme.name || theme.id}.sxmtheme.json`,
        filters: [{ name: 'Theme', extensions: ['json'] }],
      };
      const selection = window
        ? await dialog.showSaveDialog(window, options)
        : await dialog.showSaveDialog(options);
      if (selection.canceled || !selection.filePath) {
        return { ok: false, canceled: true, errors: [] };
      }
      try {
        await writeFile(selection.filePath, json, 'utf8');
        return { ok: true, canceled: false, errors: [], path: selection.filePath };
      } catch (error) {
        return {
          ok: false,
          canceled: false,
          errors: [error instanceof Error ? error.message : 'The theme file could not be written.'],
        };
      }
    });

    ipcMain.handle(IPC.metadataCorrect, async (_event, payload: unknown) => {
      const data = (payload ?? {}) as {
        artist?: string;
        title?: string;
        album?: string;
        rawArtist?: string | null;
        rawTitle?: string | null;
        remove?: boolean;
        key?: string;
      };
      const raw = this.engine?.state?.raw;
      // The raw artist/title describe the broadcast the correction is about.
      // The user may leave the artist empty on purpose ("every artist for
      // this song"), so the current track is only used as a fallback when
      // nothing at all was typed.
      const typedArtist = typeof data.rawArtist === 'string' ? data.rawArtist.trim() : '';
      const typedTitle = typeof data.rawTitle === 'string' ? data.rawTitle.trim() : '';
      const rawArtist = typedArtist || (typedTitle ? '' : (raw?.artist ?? null));
      const rawTitle = typedTitle || (typedArtist ? '' : (raw?.title ?? null));

      if (data.remove) {
        const key = data.key ?? manualCorrectionKey(rawArtist, rawTitle);
        const corrections = { ...(this.settings.metadata.manualCorrections ?? {}) };
        delete corrections[key];
        await this.patchSettings({
          metadata: { ...this.settings.metadata, manualCorrections: corrections },
        });
        return { ok: true, detail: 'The correction was removed.', key };
      }

      const artist = typeof data.artist === 'string' ? data.artist.trim() : '';
      const title = typeof data.title === 'string' ? data.title.trim() : '';
      const album = typeof data.album === 'string' ? data.album.trim() : '';
      if (!artist && !title && !album) {
        return { ok: false, detail: 'Enter an artist or a title.' };
      }
      const corrections = withManualCorrection(
        this.settings.metadata.manualCorrections,
        rawArtist,
        rawTitle,
        {
          artist: artist || undefined,
          title: title || undefined,
          album: album || undefined,
        },
      );
      await this.patchSettings({
        metadata: { ...this.settings.metadata, manualCorrections: corrections },
      });

      // Say exactly what the correction is keyed on, so the confirmation is
      // true instead of promising a match that can never happen.
      const scope = typedArtist && typedTitle
        ? `"${typedArtist} - ${typedTitle}"`
        : typedTitle
          ? `"${typedTitle}" (any artist)`
          : `"${typedArtist}"`;
      return {
        ok: true,
        detail: `Saved. The correction is used whenever ${scope} is broadcast again.`,
        key: manualCorrectionKey(rawArtist, rawTitle),
      };
    });

    ipcMain.handle(IPC.metadataCorrectList, () => this.settings.metadata.manualCorrections ?? {});

    ipcMain.handle(IPC.playerVolume, async (_event, volume: unknown) => {
      const value = typeof volume === 'number' && Number.isFinite(volume) ? volume : 0;
      const clamped = Math.max(0, Math.min(1, value));
      await this.patchSettings({ volume: clamped });
      return { ok: true, detail: 'Volume updated.' };
    });

    ipcMain.handle(IPC.channelToggleMuted, async (_event, name: unknown) => {
      if (typeof name !== 'string' || !name.trim()) return this.settings.scrobbleMutedChannels;
      const trimmed = name.trim();
      const muted = new Set(this.settings.scrobbleMutedChannels);
      if (muted.has(trimmed)) muted.delete(trimmed);
      else muted.add(trimmed);
      const list = [...muted];
      const result = await this.patchSettings({
        scrobbleMutedChannels: list,
        mutedChannels: list,
      });
      this.scheduleBroadcast();
      return result.scrobbleMutedChannels;
    });

    ipcMain.handle(IPC.playerCommand, async (_event, command: unknown) => {
      if (typeof command !== 'string') return { ok: false, detail: 'Invalid command.' };
      return this.runPlayerCommand(command);
    });

    ipcMain.handle(IPC.playerReload, () => {
      this.windows.officialPlayer.reload();
      return true;
    });

    ipcMain.handle(IPC.playerClearSession, async () => {
      await this.windows.officialPlayer.clearSession();
      this.scheduleBroadcast();
      return true;
    });

    ipcMain.handle(IPC.playerSnapshot, () => {
      return this.latestSnapshot ?? null;
    });

    ipcMain.handle(IPC.servicesStatus, async () => {
      await this.refreshServiceStatus();
      return this.serviceStatus;
    });

    ipcMain.handle(IPC.lastfmConnect, async (_event, payload: unknown) => {
      const data = (payload ?? {}) as { apiKey?: string; apiSecret?: string };
      const generation = ++this.authGeneration;
      if (this.authTimer) clearTimeout(this.authTimer);
      await this.closeLastFmAuthServer();

      try {
        if (!(await this.secretStore.ensureAvailable())) {
          throw new Error(
            'OS credential storage is unavailable. Enable your system keychain before connecting.',
          );
        }

        // A user supplied key pair is optional. When both halves are present
        // they win, otherwise the built-in VegaFM application credentials are
        // used - a normal user never has to supply anything.
        const userApiKey = data.apiKey?.trim();
        const userApiSecret = data.apiSecret?.trim();
        if (userApiSecret) {
          await this.secretStore.patch({ lastfmApiSecret: userApiSecret });
          this.secrets = this.secretStore.get();
        }
        if (userApiKey && userApiKey !== this.settings.lastfmApiKey) {
          await this.patchSettings({ lastfmApiKey: userApiKey });
        }

        const credentials = this.resolveLastFmCredentials();
        if (!credentials.usable) {
          throw new Error(
            'This build carries no Last.fm application credentials. Enter your own API key and shared secret in Advanced.',
          );
        }

        await this.lastfm.disconnect();
        await this.secretStore.patch({ lastfmSessionKey: '' });
        this.secrets = this.secretStore.get();
        this.lastfm.setCredentials(credentials);

        const authClient = new LastFmService(credentials);
        const result = await authClient.getToken();
        const token = (result.response as { token?: string })?.token;
        if (!result.ok || !token) {
          throw new Error(result.error || 'Last.fm returned no request token.');
        }

        // Register a loopback callback so the browser returns to VegaAM by
        // itself: no manual session key, no manual token copy.
        const server = await startLoopbackAuthServer();
        this.lastfmAuthServer = server;
        const authUrl = authClient.getAuthUrl(token, server.url);

        this.serviceStatus.lastfm = {
          id: 'lastfm',
          configured: true,
          authorized: false,
          connectionState: 'awaiting-authorization',
          authUrl,
          lastError: undefined,
        };
        this.scheduleBroadcast();

        try {
          await shell.openExternal(authUrl);
        } catch (error) {
          console.warn('[lastfm] the authorization browser could not be opened:', error);
        }

        // The handshake continues in the background: the drawer stays
        // responsive and the status is broadcast as soon as it finishes.
        console.log(
          `[lastfm] authorization opened in the browser; waiting for the approval (${server.port}).`,
        );
        void this.finishLastFmConnect(generation, credentials, token, server);
      } catch (error) {
        this.serviceStatus.lastfm = {
          id: 'lastfm',
          configured: this.lastfmCredentials.usable,
          authorized: false,
          connectionState: 'authentication-failed',
          lastError: error instanceof Error ? error.message : 'Authorization failed.',
        };
        await this.closeLastFmAuthServer();
      }
      this.scheduleBroadcast();
      return this.serviceStatus.lastfm;
    });

    ipcMain.handle(IPC.lastfmCredentialsSave, async (_event, payload: unknown) => {
      const data = (payload ?? {}) as { apiKey?: string; apiSecret?: string };
      const apiKey = data.apiKey?.trim() ?? '';
      const apiSecret = data.apiSecret?.trim() ?? '';

      if (apiSecret) {
        await this.secretStore.patch({ lastfmApiSecret: apiSecret });
        this.secrets = this.secretStore.get();
      }
      if (typeof data.apiKey === 'string') {
        await this.patchSettings({ lastfmApiKey: apiKey });
      }

      const credentials = this.resolveLastFmCredentials();
      this.lastfm.setCredentials({
        apiKey: credentials.apiKey,
        apiSecret: credentials.apiSecret,
      });
      this.serviceStatus.lastfm.configured = credentials.usable;
      this.scheduleBroadcast();
      return {
        ok: credentials.usable,
        source: credentials.source,
        apiKey: credentials.apiKey,
      };
    });

    ipcMain.handle(IPC.lastfmDisconnect, async () => {
      ++this.authGeneration;
      if (this.authTimer) clearTimeout(this.authTimer);
      await this.lastfm.disconnect();
      await this.secretStore.patch({ lastfmSessionKey: '' });
      this.secrets = this.secretStore.get();
      await this.refreshServiceStatus();
      this.serviceStatus.lastfm.connectionState = 'not-configured';
      return this.serviceStatus.lastfm;
    });

    ipcMain.handle(IPC.listenbrainzConnect, async (_event, token: unknown) => {
      if (typeof token !== 'string') return this.serviceStatus.listenbrainz;
      await this.secretStore.patch({ listenbrainzToken: token });
      this.secrets = this.secretStore.get();
      this.listenbrainz.setToken(token);
      await this.refreshServiceStatus();
      return this.serviceStatus.listenbrainz;
    });

    ipcMain.handle(IPC.listenbrainzDisconnect, async () => {
      await this.listenbrainz.disconnect();
      await this.secretStore.patch({ listenbrainzToken: '' });
      this.secrets = this.secretStore.get();
      await this.refreshServiceStatus();
      return this.serviceStatus.listenbrainz;
    });

    ipcMain.handle(IPC.servicesTest, async () => {
      await this.refreshServiceStatus();
      return this.serviceStatus;
    });

    ipcMain.handle(IPC.queueList, () => (this.queue ? this.queue.list() : []));
    ipcMain.handle(IPC.queueRetry, async (_event, id: unknown) => {
      if (typeof id !== 'string') return false;
      const ok = await this.queue.retry(id);
      await this.processQueue();
      return ok;
    });
    ipcMain.handle(IPC.queueRemove, async (_event, id: unknown) => {
      if (typeof id !== 'string') return false;
      return this.queue.remove(id);
    });

    ipcMain.handle(IPC.windowShowMain, () => {
      this.showMainWindow();
      return true;
    });
    ipcMain.handle(IPC.windowMini, async () => {
      const visible = this.windows.toggleCompact();
      await this.patchSettings({ compactPlayerEnabled: visible, miniPlayerEnabled: visible });
      return visible;
    });
    ipcMain.handle(IPC.windowCompact, async () => {
      const visible = this.windows.toggleCompact();
      await this.patchSettings({ compactPlayerEnabled: visible, miniPlayerEnabled: visible });
      return visible;
    });
    ipcMain.handle(IPC.windowSkin, async (_event, skinId: unknown) => {
      if (typeof skinId === 'string' && this.themeService.get(skinId)) {
        await this.patchSettings({ skinId, skinWindowEnabled: true });
        this.windows.openSkin();
        return true;
      }
      const visible = this.windows.toggleSkin();
      await this.patchSettings({ skinWindowEnabled: visible });
      return visible;
    });
    ipcMain.handle(IPC.windowSettings, (_event, tab: unknown) => {
      return this.windows.openSettings(typeof tab === 'string' ? tab : 'appearance');
    });
    ipcMain.handle(IPC.windowActivity, () => {
      return this.windows.openActivity();
    });
    ipcMain.handle(IPC.windowQuickPanel, (_event, tab: unknown) => {
      return this.windows.toggleQuickPanel(typeof tab === 'string' ? tab : undefined);
    });
    ipcMain.handle(IPC.legacyCleanupShortcuts, () => {
      const res = cleanupLegacyShortcuts();
      this.scheduleBroadcast();
      return res;
    });
    ipcMain.handle(IPC.legacyOpenFolder, async () => {
      return openLegacyInstallFolder();
    });
    ipcMain.handle(IPC.legacyUninstall, () => {
      return launchLegacyUninstallerInteractive();
    });
    ipcMain.handle(IPC.legacyRefreshIconCache, () => {
      return refreshWindowsIconCache();
    });
    ipcMain.handle(IPC.windowAlwaysOnTop, async (_event, value: unknown) => {
      const enabled = Boolean(value);
      await this.patchSettings({ alwaysOnTop: enabled });
      return enabled;
    });
    ipcMain.handle(IPC.windowMinimize, (event) => {
      const senderWin = [
        this.windows.skin,
        this.windows.compact,
        this.windows.main,
      ].find((w) => w && !w.isDestroyed() && w.webContents === event.sender);
      (senderWin ?? this.windows.main)?.minimize();
      return true;
    });
    ipcMain.handle(IPC.windowMaximize, (event) => {
      const senderWin = [
        this.windows.skin,
        this.windows.main,
      ].find((w) => w && !w.isDestroyed() && w.webContents === event.sender);
      const window = senderWin ?? this.windows.main;
      if (!window) return false;
      if (window.isMaximized()) window.unmaximize();
      else window.maximize();
      return window.isMaximized();
    });
    ipcMain.handle(IPC.windowClose, (event) => {
      if (this.windows.compact && this.windows.compact.webContents === event.sender) {
        this.windows.compact.hide();
        void this.patchSettings({ compactPlayerEnabled: false, miniPlayerEnabled: false });
        return true;
      }
      if (this.windows.skin && this.windows.skin.webContents === event.sender) {
        this.windows.skin.hide();
        void this.patchSettings({ skinWindowEnabled: false });
        return true;
      }
      if (this.windows.quickPanel.webContents && this.windows.quickPanel.webContents === event.sender) {
        this.windows.quickPanel.closePanel(true);
        return true;
      }
      this.windows.main?.hide();
      return true;
    });

    ipcMain.handle(IPC.openExternal, async (_event, url: unknown) => {
      if (typeof url !== 'string') return false;
      if (!isAllowedExternalUrl(url)) {
        console.warn('[main] blocked an external link for an unknown host:', url);
        return false;
      }
      await shell.openExternal(url);
      return true;
    });
  }

  shutdown(): void {
    ++this.authGeneration;
    if (this.authTimer) clearTimeout(this.authTimer);
    const windowState = this.windows.getWindowState();
    const mainBounds = windowState.main ?? this.settings.windowBounds ?? null;
    this.windows.allowClose();
    if (this.tickTimer) clearInterval(this.tickTimer);
    if (this.queueTimer) clearInterval(this.queueTimer);
    if (this.stateBroadcastTimer) clearTimeout(this.stateBroadcastTimer);
    this.unregisterSurfaceThemeIpc?.();
    this.unregisterSurfaceThemeIpc = undefined;
    this.surfaceTheme.dispose();
    this.mediaBridge?.stop();
    this.shortcuts.unregister();
    this.tray?.destroy();
    this.native.dispose();
    void this.mpris?.stop().catch(() => undefined);
    this.mpris = undefined;
    this.windows.quickPanel.destroy();
    this.windows.officialPlayer.destroy();
    void this.settingsStore
      .patch({ windowBounds: mainBounds, windowState })
      .catch(() => undefined);
  }
}

/** Validate and sanitise a settings patch coming from a VegaAM renderer. */
function sanitizeSettingsPatch(patch: unknown): Partial<AppSettings> {
  if (!patch || typeof patch !== 'object') return {};
  const input = patch as Record<string, unknown>;
  const result: Record<string, unknown> = {};

  if (typeof input.theme === 'string') result.theme = input.theme;
  if (typeof input.skinId === 'string') result.skinId = input.skinId;
  if (input.colorMode === 'dark' || input.colorMode === 'light' || input.colorMode === 'system') {
    result.colorMode = input.colorMode;
  }
  if (typeof input.accentColor === 'string' || input.accentColor === null) {
    result.accentColor = input.accentColor;
  }
  if (typeof input.artworkTint === 'boolean') result.artworkTint = input.artworkTint;
  if (
    input.surfaceThemeId === null ||
    input.surfaceThemeId === 'official' ||
    input.surfaceThemeId === ''
  ) {
    result.surfaceThemeId = null;
  } else if (isBuiltinSurfaceThemeId(input.surfaceThemeId)) {
    result.surfaceThemeId = input.surfaceThemeId;
  }
  if ('surfaceThemeAccent' in input) {
    result.surfaceThemeAccent = sanitizeHexAccent(input.surfaceThemeAccent);
  }
  if (typeof input.surfaceThemeConsent === 'boolean') {
    result.surfaceThemeConsent = input.surfaceThemeConsent;
    if (!input.surfaceThemeConsent) {
      result.surfaceThemeId = null;
    }
  }
  if (typeof input.quickPanelEnabled === 'boolean') {
    result.quickPanelEnabled = input.quickPanelEnabled;
  }
  if (typeof input.volume === 'number' && input.volume >= 0 && input.volume <= 1) {
    result.volume = input.volume;
  }
  if (typeof input.alwaysOnTop === 'boolean') result.alwaysOnTop = input.alwaysOnTop;
  if (typeof input.compactPlayerEnabled === 'boolean') {
    result.compactPlayerEnabled = input.compactPlayerEnabled;
    result.miniPlayerEnabled = input.compactPlayerEnabled;
  } else if (typeof input.miniPlayerEnabled === 'boolean') {
    result.compactPlayerEnabled = input.miniPlayerEnabled;
    result.miniPlayerEnabled = input.miniPlayerEnabled;
  }
  if (typeof input.skinWindowEnabled === 'boolean') {
    result.skinWindowEnabled = input.skinWindowEnabled;
  }
  if (typeof input.closeToTray === 'boolean') {
    result.closeToTray = input.closeToTray;
  }
  if (typeof input.mediaBridgeConsent === 'boolean') {
    result.mediaBridgeConsent = input.mediaBridgeConsent;
  }
  if (typeof input.lastfmEnabled === 'boolean') result.lastfmEnabled = input.lastfmEnabled;
  if (typeof input.listenbrainzEnabled === 'boolean') {
    result.listenbrainzEnabled = input.listenbrainzEnabled;
  }
  if (typeof input.lastfmApiKey === 'string') result.lastfmApiKey = input.lastfmApiKey;
  if (typeof input.onboardingDismissed === 'boolean') {
    result.onboardingDismissed = input.onboardingDismissed;
  }
  if (Array.isArray(input.scrobbleMutedChannels)) {
    const list = input.scrobbleMutedChannels.filter((c): c is string => typeof c === 'string');
    result.scrobbleMutedChannels = list;
    result.mutedChannels = list;
  } else if (Array.isArray(input.mutedChannels)) {
    const list = input.mutedChannels.filter((c): c is string => typeof c === 'string');
    result.scrobbleMutedChannels = list;
    result.mutedChannels = list;
  }
  if (typeof input.notificationsEnabled === 'boolean') {
    result.notificationsEnabled = input.notificationsEnabled;
  }
  if (typeof input.notifyOnScrobble === 'boolean') {
    result.notifyOnScrobble = input.notifyOnScrobble;
  }
  if (typeof input.startAtLogin === 'boolean') result.startAtLogin = input.startAtLogin;
  if (typeof input.mprisEnabled === 'boolean') result.mprisEnabled = input.mprisEnabled;
  if (input.thresholds && typeof input.thresholds === 'object') {
    const thresholds = { ...DEFAULT_THRESHOLDS };
    const t = input.thresholds as Record<string, unknown>;
    for (const key of Object.keys(thresholds)) {
      const value = t[key];
      if (typeof value === 'number' && Number.isFinite(value)) {
        (thresholds as Record<string, unknown>)[key] = value;
      } else if (typeof value === 'boolean') {
        (thresholds as Record<string, unknown>)[key] = value;
      }
    }
    result.thresholds = thresholds;
  }
  if (input.metadata && typeof input.metadata === 'object') {
    result.metadata = sanitizeMetadataConfig(input.metadata);
  }

  return result as Partial<AppSettings>;
}

/** Validate the metadata configuration coming from a VegaAM renderer. */
function sanitizeMetadataConfig(input: unknown): AppSettings['metadata'] {
  const raw = (input ?? {}) as Record<string, unknown>;
  const config: MetadataConfig = {
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

  if (Array.isArray(raw.channelMappings)) {
    config.channelMappings = raw.channelMappings
      .filter((m): m is Record<string, unknown> => Boolean(m) && typeof m === 'object')
      .map((m) => ({
        channel: String(m.channel ?? ''),
        artist: String(m.artist ?? ''),
        disabled: Boolean(m.disabled),
        note: typeof m.note === 'string' ? m.note : undefined,
      }))
      .filter((m) => m.channel.length > 0 && m.artist.length > 0);
  }
  if (Array.isArray(raw.correctionRules)) {
    config.correctionRules = raw.correctionRules
      .filter((r): r is Record<string, unknown> => Boolean(r) && typeof r === 'object')
      .map((r) => ({
        id: String(r.id ?? ''),
        label: typeof r.label === 'string' ? r.label : undefined,
        pattern: String(r.pattern ?? ''),
        replacement: String(r.replacement ?? ''),
        channel: typeof r.channel === 'string' ? r.channel : undefined,
        scope: (
          r.scope === 'artist' || r.scope === 'title' ? r.scope : 'raw'
        ) as CorrectionRule['scope'],
        enabled: r.enabled !== false,
      }))
      .filter((r) => r.id.length > 0);
  }
  if (raw.artistAliases && typeof raw.artistAliases === 'object') {
    const aliases: Record<string, string> = {};
    for (const [key, value] of Object.entries(raw.artistAliases as Record<string, unknown>)) {
      if (typeof value === 'string') aliases[key] = value;
    }
    config.artistAliases = aliases;
  }
  if (raw.manualCorrections && typeof raw.manualCorrections === 'object') {
    const corrections: Record<string, { artist?: string; title?: string; album?: string }> = {};
    for (const [key, value] of Object.entries(raw.manualCorrections as Record<string, unknown>)) {
      if (!value || typeof value !== 'object') continue;
      const entry = value as Record<string, unknown>;
      const artist = typeof entry.artist === 'string' ? entry.artist : undefined;
      const title = typeof entry.title === 'string' ? entry.title : undefined;
      const album = typeof entry.album === 'string' ? entry.album : undefined;
      if (!artist && !title && !album) continue;
      corrections[key] = {
        ...(artist ? { artist } : {}),
        ...(title ? { title } : {}),
        ...(album ? { album } : {}),
      };
    }
    config.manualCorrections = corrections;
  }
  if (raw.concertInScrobbleTitle === 'always' || raw.concertInScrobbleTitle === 'when-known') {
    config.concertInScrobbleTitle = raw.concertInScrobbleTitle;
  } else if (raw.concertInScrobbleTitle === 'never') {
    config.concertInScrobbleTitle = 'never';
  }
  if (typeof raw.includeFeaturedInScrobbleArtist === 'boolean') {
    config.includeFeaturedInScrobbleArtist = raw.includeFeaturedInScrobbleArtist;
  }
  if (typeof raw.requireVerifiedMetadata === 'boolean') {
    config.requireVerifiedMetadata = raw.requireVerifiedMetadata;
  }
  if (raw.dateOrder === 'DMY' || raw.dateOrder === 'MDY') config.dateOrder = raw.dateOrder;
  if (Array.isArray(raw.neverFallbackChannels)) {
    config.neverFallbackChannels = raw.neverFallbackChannels.filter(
      (c): c is string => typeof c === 'string',
    );
  }
  if (Array.isArray(raw.removedChannelMappings)) {
    config.removedChannelMappings = raw.removedChannelMappings.filter(
      (c): c is string => typeof c === 'string',
    );
  }
  return config;
}
