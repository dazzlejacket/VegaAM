/**
 * Official-first SiriusXM main window controller.
 *
 * The main BrowserWindow loads https://www.siriusxm.com/player directly as its
 * top-level document inside the persistent `persist:siriusxm` partition.
 *
 * Invariants:
 *   - No WebContentsView or child views (`window.contentView.children.length === 0`)
 *   - Zero executeJavaScript calls on the official webContents
 *   - Reversible CSS-only surface themes use `insertCSS(..., { cssOrigin: 'user' })` and `removeInsertedCSS(key)`
 *   - Read-only MediaSession bridge runs in an isolated preload context
 */

import { join } from 'node:path';

import {
  BrowserWindow,
  dialog,
  nativeImage,
  session,
  shell,
  type WebContents,
} from 'electron';

import { ALLOWED_PERMISSIONS, isAllowedExternalUrl } from './externalLinks';

export const OFFICIAL_PLAYER_URL = 'https://www.siriusxm.com/player';
export const OFFICIAL_PARTITION = 'persist:siriusxm';

/** Hosts allowed to load inside the official SiriusXM window. */
export const ALLOWED_SXM_HOSTS: readonly string[] = Object.freeze([
  'siriusxm.com',
  'www.siriusxm.com',
  'player.siriusxm.com',
  'care.siriusxm.com',
]);

export type OfficialLoadState = 'idle' | 'loading' | 'ready' | 'failed' | 'crashed';

export interface OfficialPlayerEvents {
  onLoadState?: (state: OfficialLoadState, reason: string) => void;
  onNavigation?: (url: string, authRequired: boolean) => void;
  onDocumentReplaced?: (url: string) => void;
  onDomReady?: (url: string) => void;
  onInPageNavigate?: (url: string) => void;
  onOpenSettings?: () => void;
  onQuitRequest?: () => void;
  shouldPreventClose?: () => boolean;
  onCloseToBackground?: () => void;
}

export interface WindowBounds {
  x?: number;
  y?: number;
  width: number;
  height: number;
  maximized?: boolean;
}

/**
 * True when a URL belongs to an official SiriusXM HTTPS host allowed in the main window.
 */
export function isAllowedSiriusXmUrl(url: string): boolean {
  if (typeof url !== 'string' || !url.trim()) return false;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (parsed.protocol !== 'https:') return false;
  const host = parsed.hostname.toLowerCase();
  return ALLOWED_SXM_HOSTS.includes(host) || host.endsWith('.siriusxm.com');
}

/**
 * True when the URL indicates an authentication / sign-in flow.
 */
export function isAuthUrl(url: string): boolean {
  if (!url) return false;
  return /\/(login|signin|sign-in|welcome|authenticate)\b/i.test(url);
}

/**
 * True when the URL is a Chromium internal error or crash page.
 */
export function isErrorUrl(url: string): boolean {
  if (!url) return false;
  return (
    url.startsWith('chrome-error://') ||
    url.startsWith('chrome://crash') ||
    url === 'about:blank'
  );
}

function isAutomatedMode(): boolean {
  return (
    process.argv.includes('--smoke') ||
    process.argv.includes('--verify-official-first') ||
    process.argv.includes('--live-probe') ||
    process.argv.includes('--qa-3-1') ||
    process.argv.includes('--qa-threshold') ||
    process.env.VEGAAM_NONINTERACTIVE === '1'
  );
}

export class OfficialPlayerController {
  private window: BrowserWindow | undefined;
  private events: OfficialPlayerEvents = {};
  private loadState: OfficialLoadState = 'idle';
  private failureReason = '';
  private lastUrl = OFFICIAL_PLAYER_URL;
  private authRequired = false;
  private executeJavaScriptCount = 0;
  private insertCSSCount = 0;
  private removeInsertedCSSCount = 0;
  private errorDialogOpen = false;

  setEvents(events: OfficialPlayerEvents): void {
    this.events = events;
  }

  get mainWindow(): BrowserWindow | undefined {
    return this.window && !this.window.isDestroyed() ? this.window : undefined;
  }

  get webContents(): WebContents | undefined {
    return this.mainWindow?.webContents;
  }

  get state(): OfficialLoadState {
    return this.loadState;
  }

  get reason(): string {
    return this.failureReason;
  }

  get url(): string {
    return this.lastUrl;
  }

  get isAuthRequired(): boolean {
    return this.authRequired;
  }

  get isMuted(): boolean {
    try {
      return this.webContents?.isAudioMuted() ?? false;
    } catch {
      return false;
    }
  }

  get isCurrentlyAudible(): boolean {
    try {
      return this.webContents?.isCurrentlyAudible() ?? false;
    } catch {
      return false;
    }
  }

  /** Runtime verification counters proving zero script injection and tracking CSS token operations. */
  getInjectionCounts(): {
    executeJavaScriptCount: number;
    insertCSSCount: number;
    removeInsertedCSSCount: number;
  } {
    return {
      executeJavaScriptCount: this.executeJavaScriptCount,
      insertCSSCount: this.insertCSSCount,
      removeInsertedCSSCount: this.removeInsertedCSSCount,
    };
  }

  /**
   * Create the primary BrowserWindow and load the official SiriusXM web player directly.
   */
  createWindow(bounds?: WindowBounds | null): BrowserWindow {
    if (this.window && !this.window.isDestroyed()) return this.window;

    this.configurePartitionPermissions();

    const iconFile = join(__dirname, '..', 'icons', 'icon-256.png');
    const win = new BrowserWindow({
      width: bounds?.width && bounds.width >= 900 ? bounds.width : 1280,
      height: bounds?.height && bounds.height >= 600 ? bounds.height : 860,
      x: bounds?.x,
      y: bounds?.y,
      minWidth: 900,
      minHeight: 600,
      show: false,
      autoHideMenuBar: true,
      backgroundColor: '#000000',
      title: 'VegaAM',
      icon: iconFile,
      webPreferences: {
        preload: join(__dirname, '..', 'preload', 'mediaBridge.js'),
        partition: OFFICIAL_PARTITION,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        webviewTag: false,
        spellcheck: false,
        backgroundThrottling: false,
      },
    });

    try {
      const iconImg = nativeImage.createFromPath(iconFile);
      if (!iconImg.isEmpty()) {
        win.setIcon(iconImg);
      }
    } catch {
      /* ignore icon assignment error on unsupported platforms */
    }

    if (bounds?.maximized) {
      win.maximize();
    }

    win.webContents.setBackgroundThrottling(false);

    // Instrument executeJavaScript, insertCSS, and removeInsertedCSS for verification assertions.
    const origExec = win.webContents.executeJavaScript.bind(win.webContents);
    win.webContents.executeJavaScript = ((code: string, userGesture?: boolean) => {
      this.executeJavaScriptCount += 1;
      return origExec(code, userGesture);
    }) as typeof win.webContents.executeJavaScript;

    const origInsertCss = win.webContents.insertCSS.bind(win.webContents);
    win.webContents.insertCSS = ((css: string, options?: Electron.InsertCSSOptions) => {
      this.insertCSSCount += 1;
      return origInsertCss(css, options);
    }) as typeof win.webContents.insertCSS;

    const origRemoveCss = win.webContents.removeInsertedCSS.bind(win.webContents);
    win.webContents.removeInsertedCSS = ((key: string) => {
      this.removeInsertedCSSCount += 1;
      return origRemoveCss(key);
    }) as typeof win.webContents.removeInsertedCSS;

    win.once('ready-to-show', () => {
      if (!win.isDestroyed()) win.show();
    });

    win.on('close', (event) => {
      if (this.events.shouldPreventClose?.()) {
        event.preventDefault();
        win.hide();
        this.events.onCloseToBackground?.();
      }
    });

    win.on('closed', () => {
      this.window = undefined;
    });

    // External popups open in the system browser; never spawn untrusted child BrowserWindows.
    win.webContents.setWindowOpenHandler(({ url }) => {
      if (isAllowedSiriusXmUrl(url)) {
        void win.loadURL(url).catch(() => undefined);
        return { action: 'deny' };
      }
      if (isAllowedExternalUrl(url)) {
        void shell.openExternal(url);
      } else {
        console.warn('[officialPlayer] blocked popup for untrusted URL:', url);
      }
      return { action: 'deny' };
    });

    // Enforce top-level navigation allowlist.
    win.webContents.on('will-navigate', (event, url) => {
      if (!isAllowedSiriusXmUrl(url)) {
        event.preventDefault();
        if (isAllowedExternalUrl(url)) {
          void shell.openExternal(url);
        } else {
          console.warn('[officialPlayer] blocked top-level navigation to untrusted URL:', url);
        }
      }
    });

    win.webContents.on('did-start-navigation', (_event, url, isInPlace, isMainFrame) => {
      if (!isMainFrame) return;
      this.lastUrl = url || this.lastUrl;
      this.authRequired = isAuthUrl(url);
      if (!isInPlace) {
        this.setLoadState('loading', '');
      }
    });

    win.webContents.on('dom-ready', () => {
      const url = win.webContents.getURL();
      if (isErrorUrl(url)) {
        this.setLoadState('failed', 'The official SiriusXM player could not be reached.');
        return;
      }
      this.lastUrl = url;
      this.authRequired = isAuthUrl(url);
      this.setLoadState('ready', '');
      this.events.onDomReady?.(url);
    });

    win.webContents.on('did-finish-load', () => {
      const url = win.webContents.getURL();
      if (isErrorUrl(url)) {
        this.setLoadState('failed', 'The official SiriusXM player could not be reached.');
        return;
      }
      this.lastUrl = url;
      this.authRequired = isAuthUrl(url);
      this.setLoadState('ready', '');
      this.events.onNavigation?.(url, this.authRequired);
    });

    win.webContents.on('did-navigate', (_event, url) => {
      this.lastUrl = url;
      this.authRequired = isAuthUrl(url);
      this.events.onDocumentReplaced?.(url);
      this.events.onNavigation?.(url, this.authRequired);
    });

    win.webContents.on('did-navigate-in-page', (_event, url, isMainFrame) => {
      if (!isMainFrame) return;
      this.lastUrl = url;
      this.authRequired = isAuthUrl(url);
      this.events.onInPageNavigate?.(url);
      this.events.onNavigation?.(url, this.authRequired);
    });

    win.webContents.on(
      'did-fail-load',
      (_event, errorCode, errorDescription, validatedURL, isMainFrame) => {
        // -3 is ERR_ABORTED, which fires normally on client-side redirects.
        if (!isMainFrame || errorCode === -3) return;
        const message = `Could not load ${validatedURL || OFFICIAL_PLAYER_URL}: ${errorDescription} (${errorCode})`;
        console.warn('[officialPlayer] did-fail-load:', message);
        this.setLoadState('failed', errorDescription || 'Network error');
        void this.promptRecoveryDialog(
          'SiriusXM Could Not Be Reached',
          'VegaAM could not load the official SiriusXM web player. Check your internet connection and try again.',
          message,
        );
      },
    );

    win.webContents.on('render-process-gone', (_event, details) => {
      const reason = details.reason || 'crashed';
      console.warn('[officialPlayer] render-process-gone:', reason);
      this.setLoadState('crashed', `Renderer process exited (${reason})`);
      void this.promptRecoveryDialog(
        'SiriusXM Player Stopped Responding',
        'The official SiriusXM player process stopped unexpectedly.',
        `Reason: ${reason}`,
      );
    });

    this.window = win;
    this.setLoadState('loading', '');
    void win.loadURL(OFFICIAL_PLAYER_URL).catch((error) => {
      const detail = error instanceof Error ? error.message : String(error);
      console.warn('[officialPlayer] initial loadURL error:', detail);
      this.setLoadState('failed', detail);
    });

    return win;
  }

  private configurePartitionPermissions(): void {
    const playerSession = session.fromPartition(OFFICIAL_PARTITION);
    playerSession.setPermissionRequestHandler((_contents, permission, callback) => {
      const allowed = ALLOWED_PERMISSIONS.includes(permission);
      if (!allowed) {
        console.warn('[officialPlayer] permission denied:', permission);
      }
      callback(allowed);
    });
    playerSession.setPermissionCheckHandler((_contents, permission) =>
      ALLOWED_PERMISSIONS.includes(permission),
    );
  }

  private setLoadState(state: OfficialLoadState, reason: string): void {
    if (this.loadState === state && this.failureReason === reason) return;
    this.loadState = state;
    this.failureReason = reason;
    this.events.onLoadState?.(state, reason);
  }

  private async promptRecoveryDialog(
    title: string,
    message: string,
    detail: string,
  ): Promise<void> {
    if (isAutomatedMode() || this.errorDialogOpen) return;
    const win = this.mainWindow;
    if (!win) return;
    this.errorDialogOpen = true;
    try {
      const response = await dialog.showMessageBox(win, {
        type: 'warning',
        title,
        message,
        detail,
        buttons: ['Retry', 'Open Settings', 'Quit'],
        defaultId: 0,
        cancelId: 1,
      });
      if (response.response === 0) {
        this.reload();
      } else if (response.response === 1) {
        this.events.onOpenSettings?.();
      } else if (response.response === 2) {
        this.events.onQuitRequest?.();
      }
    } catch {
      /* ignore dialog errors during shutdown */
    } finally {
      this.errorDialogOpen = false;
    }
  }

  /** Reload the official SiriusXM player (or load OFFICIAL_PLAYER_URL if on an error page). */
  reload(): void {
    const win = this.mainWindow;
    if (!win) return;
    const currentUrl = win.webContents.getURL();
    if (!currentUrl || isErrorUrl(currentUrl) || !isAllowedSiriusXmUrl(currentUrl)) {
      void win.loadURL(OFFICIAL_PLAYER_URL).catch(() => undefined);
    } else {
      win.webContents.reload();
    }
  }

  /** Navigate back in the official player history. */
  goBack(): boolean {
    const nav = this.webContents?.navigationHistory;
    if (nav?.canGoBack()) {
      nav.goBack();
      return true;
    }
    return false;
  }

  /** Navigate forward in the official player history. */
  goForward(): boolean {
    const nav = this.webContents?.navigationHistory;
    if (nav?.canGoForward()) {
      nav.goForward();
      return true;
    }
    return false;
  }

  /** Mute or unmute the official player's audio output via Electron WebContents. */
  setMuted(muted: boolean): boolean {
    const contents = this.webContents;
    if (!contents) return false;
    contents.setAudioMuted(Boolean(muted));
    return contents.isAudioMuted();
  }

  /** Toggle audio mute on the official player's WebContents. */
  toggleMute(): boolean {
    return this.setMuted(!this.isMuted);
  }

  /** Clear the SiriusXM session partition storage and reload the player. */
  async clearSession(): Promise<void> {
    const playerSession = session.fromPartition(OFFICIAL_PARTITION);
    await playerSession.clearStorageData();
    await playerSession.clearCache();
    this.authRequired = true;
    const win = this.mainWindow;
    if (win) {
      await win.loadURL(OFFICIAL_PLAYER_URL).catch(() => undefined);
    }
  }

  destroy(): void {
    if (this.window && !this.window.isDestroyed()) {
      this.window.destroy();
    }
    this.window = undefined;
  }
}
