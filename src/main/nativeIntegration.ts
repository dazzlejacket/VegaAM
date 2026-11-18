/**
 * Native desktop integration.
 *
 * Everything in this file talks to the operating system: desktop
 * notifications, the Windows taskbar, the macOS dock menu and the login
 * item. The application controller only describes *what* is playing - this
 * module decides how that is presented natively.
 *
 * Every call is guarded: a platform that does not support a feature must
 * never break the application.
 */

import { join } from 'node:path';

import { app, BrowserWindow, Menu, nativeImage, Notification } from 'electron';

/** The playback state that is presented to the operating system. */
export interface NativePlaybackState {
  playing: boolean;
  buffering: boolean;
  title: string;
  artist: string | null;
  channel: string | null;
  artwork: string | null;
  durationMs: number | null;
  positionMs: number | null;
}

/** The commands the operating system may ask the application to run. */
export interface NativeActions {
  showMain: () => void;
  openNowPlaying: () => void;
  togglePlayback: () => void;
  next: () => void;
  previous: () => void;
  toggleMini: () => void;
  quit: () => void;
}

/** The user preferences that control the native integration. */
export interface NativeSettings {
  notificationsEnabled: boolean;
  notifyOnScrobble: boolean;
  startAtLogin: boolean;
}

const DEFAULT_SETTINGS: NativeSettings = {
  notificationsEnabled: true,
  notifyOnScrobble: true,
  startAtLogin: false,
};

/**
 * The login item needs the executable path. While the application runs from
 * the sources (development mode) Windows needs the script path as an
 * argument, a packaged application does not.
 */
function loginItemOptions(openAtLogin: boolean): Electron.Settings {
  const options: Electron.Settings = {
    openAtLogin,
    name: 'VegaAM',
  };
  if (process.platform === 'win32' && process.defaultApp && process.argv[1]) {
    options.path = process.execPath;
    options.args = [process.argv[1]];
  }
  return options;
}

export class NativeIntegration {
  private window: BrowserWindow | undefined;
  private settings: NativeSettings = { ...DEFAULT_SETTINGS };
  private lastOverlay: 'playing' | 'paused' | 'none' = 'none';
  private lastProgressMode: string | undefined;
  private lastNowPlayingKey: string | undefined;

  constructor(private readonly actions: NativeActions) {}

  /** Attach the window that represents the application in the taskbar. */
  attachWindow(window: BrowserWindow | undefined): void {
    this.window = window;
  }

  /** Apply the user preferences. */
  applySettings(settings: Partial<NativeSettings>): void {
    this.settings = { ...this.settings, ...settings };
    this.applyLoginItem(this.settings.startAtLogin);
    this.applyDockMenu();
  }

  /** The current login item state (for the settings view). */
  loginItemEnabled(): boolean {
    try {
      return app.getLoginItemSettings().openAtLogin;
    } catch {
      return false;
    }
  }

  // ------------------------------------------------------------------
  // Notifications
  // ------------------------------------------------------------------

  /** True when the operating system can show notifications. */
  get notificationsSupported(): boolean {
    try {
      return Notification.isSupported();
    } catch {
      return false;
    }
  }

  /**
   * Show a desktop notification.
   *
   * Returns false when notifications are disabled or unsupported, so that
   * the caller can report the real reason instead of pretending.
   */
  notify(title: string, body: string): boolean {
    if (!this.settings.notificationsEnabled) return false;
    if (!this.notificationsSupported) return false;
    try {
      const notification = new Notification({
        title,
        body,
        icon: this.iconPath('icon-256.png'),
        silent: false,
      });
      notification.on('click', () => this.actions.openNowPlaying());
      notification.show();
      return true;
    } catch {
      return false;
    }
  }

  /** Announce a new track. */
  announceNowPlaying(state: NativePlaybackState): boolean {
    if (!state.title && !state.artist) return false;
    const key = `${state.artist ?? ''}|${state.title}`;
    if (key === this.lastNowPlayingKey) return false;
    this.lastNowPlayingKey = key;
    const body = state.artist
      ? `${state.artist}${state.channel ? ` - ${state.channel}` : ''}`
      : (state.channel ?? '');
    return this.notify('Now playing', body);
  }

  /** Announce a successful scrobble. */
  announceScrobble(artist: string, title: string, services: string[]): boolean {
    if (!this.settings.notifyOnScrobble) return false;
    const target = services.length > 0 ? services.join(', ') : 'the scrobbling service';
    return this.notify('Scrobbled', `${artist} - ${title} (${target})`);
  }

  // ------------------------------------------------------------------
  // Windows taskbar
  // ------------------------------------------------------------------

  /** Update the taskbar (overlay icon, progress) and the jump list. */
  updatePlayback(state: NativePlaybackState): void {
    this.updateOverlay(state);
    this.updateProgress(state);
    this.updateJumpList(state);
  }

  private updateOverlay(state: NativePlaybackState): void {
    if (process.platform !== 'win32') return;
    const window = this.window;
    if (!window || window.isDestroyed()) return;

    const wanted: 'playing' | 'paused' | 'none' = state.playing
      ? 'playing'
      : state.title
        ? 'paused'
        : 'none';
    if (wanted === this.lastOverlay) return;
    this.lastOverlay = wanted;

    try {
      if (wanted === 'none') {
        window.setOverlayIcon(nativeImage.createEmpty(), '');
        return;
      }
      const image = nativeImage.createFromPath(this.iconPath(`overlay-${wanted}.png`));
      if (image.isEmpty()) return;
      window.setOverlayIcon(image, wanted === 'playing' ? 'Playing' : 'Paused');
    } catch {
      /* the overlay is optional */
    }
  }

  private updateProgress(state: NativePlaybackState): void {
    if (process.platform !== 'win32') return;
    const window = this.window;
    if (!window || window.isDestroyed()) return;

    const mode = state.buffering
      ? 'indeterminate'
      : state.playing
        ? 'normal'
        : 'paused';
    const duration = state.durationMs ?? 0;
    const position = state.positionMs ?? 0;
    const fraction = duration > 0 ? Math.min(1, Math.max(0, position / duration)) : 0;

    if (mode === 'normal' && duration <= 0) {
      // A live stream has no position - no progress bar is shown.
      if (this.lastProgressMode === 'none') return;
      this.lastProgressMode = 'none';
      try {
        window.setProgressBar(-1, { mode: 'none' });
      } catch {
        /* ignore */
      }
      return;
    }

    if (this.lastProgressMode === mode) return;
    this.lastProgressMode = mode;

    try {
      if (mode === 'indeterminate') {
        window.setProgressBar(2, { mode: 'indeterminate' });
      } else if (mode === 'paused') {
        window.setProgressBar(fraction, { mode: 'paused' });
      } else {
        window.setProgressBar(fraction, { mode: 'normal' });
      }
    } catch {
      /* the progress bar is optional */
    }
  }

  private updateJumpList(state: NativePlaybackState): void {
    if (process.platform !== 'win32') return;
    try {
      app.setUserTasks([
        {
          program: process.execPath,
          arguments: '',
          iconIndex: 0,
          iconPath: process.execPath,
          title: state.title
            ? `${state.artist ? `${state.artist} - ` : ''}${state.title}`
            : 'VegaAM',
          description: state.channel ?? '',
        },
        {
          program: process.execPath,
          arguments: '',
          iconIndex: 0,
          iconPath: process.execPath,
          title: 'Mini player',
          description: 'Open the compact player',
        },
      ]);
    } catch {
      /* the jump list is optional */
    }
  }

  // ------------------------------------------------------------------
  // macOS dock menu
  // ------------------------------------------------------------------

  /** Install the macOS dock menu. */
  applyDockMenu(): void {
    if (process.platform !== 'darwin') return;
    try {
      const menu = Menu.buildFromTemplate([
        { label: 'Open VegaAM', click: () => this.actions.showMain() },
        { label: 'Now Playing', click: () => this.actions.openNowPlaying() },
        { type: 'separator' },
        { label: 'Play / Pause', click: () => this.actions.togglePlayback() },
        { label: 'Next', click: () => this.actions.next() },
        { label: 'Previous', click: () => this.actions.previous() },
        { type: 'separator' },
        { label: 'Mini player', click: () => this.actions.toggleMini() },
        { type: 'separator' },
        { label: 'Quit', click: () => this.actions.quit() },
      ]);
      app.dock?.setMenu(menu);
    } catch {
      /* the dock menu is optional */
    }
  }

  // ------------------------------------------------------------------
  // Login item
  // ------------------------------------------------------------------

  /** Start the application when the user logs in. */
  private applyLoginItem(enabled: boolean): void {
    try {
      app.setLoginItemSettings(loginItemOptions(enabled));
    } catch {
      /* the login item is optional */
    }
  }

  /** Register (or unregister) the login item. */
  setStartAtLogin(enabled: boolean): boolean {
    this.settings.startAtLogin = enabled;
    this.applyLoginItem(enabled);
    return this.loginItemEnabled();
  }

  private iconPath(name: string): string {
    return join(__dirname, '..', 'icons', name);
  }

  /** Release the resources. */
  dispose(): void {
    if (process.platform === 'win32') {
      try {
        this.window?.setOverlayIcon(nativeImage.createEmpty(), '');
        this.window?.setProgressBar(-1, { mode: 'none' });
      } catch {
        /* ignore */
      }
    }
    this.window = undefined;
  }
}
