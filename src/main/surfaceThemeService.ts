/**
 * Main-process service managing reversible SiriusXM surface CSS themes.
 *
 * Engineering safety invariants:
 *   - Uses ONLY `webContents.insertCSS(css, { cssOrigin: 'user' })` and `removeInsertedCSS(key)`.
 *   - Never calls `executeJavaScript`, `loadURL`, `reload`, or mutates audio state.
 *   - Serializes all CSS mutations through a single promise queue (`this.op`).
 *   - Guards against document replacement with a monotonic `documentGeneration` counter.
 *   - Automatically pauses/removes theming on login, welcome, account, and checkout routes.
 */

import type { BrowserWindow, WebContents } from 'electron';

import { generateSurfaceCss } from '../core/surfaceTheme/engine';
import {
  listSurfaceThemeSummaries,
  normalizeSurfaceThemeId,
} from '../core/surfaceTheme/palettes';
import { SXM_TOKEN_SNAPSHOT } from '../core/surfaceTheme/tokens';
import type {
  SurfaceThemeDiagnostics,
  SurfaceThemeId,
  SurfaceThemeState,
} from '../core/surfaceTheme/types';
import { sanitizeHexAccent, validateSurfaceCss } from '../core/surfaceTheme/validate';

const EXCLUDED_PATH_SEGMENT_RE =
  /(?:^|\/)(login|signin|sign-in|welcome|authenticate|auth|oauth|account|accounts|checkout|payment|billing|subscribe|signup|register)(?:\/|$|\?)/i;

const THEMEABLE_HOSTS = new Set(['www.siriusxm.com', 'siriusxm.com', 'player.siriusxm.com']);

/**
 * True only when `url` is a SiriusXM player route that is safe to theme
 * (never login, welcome, account, checkout, or non-player hosts).
 */
export function isThemeableSiriusXmUrl(url: string): boolean {
  if (typeof url !== 'string' || !url.trim()) return false;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (parsed.protocol !== 'https:') return false;
  const host = parsed.hostname.toLowerCase();
  if (!THEMEABLE_HOSTS.has(host)) return false;

  const path = parsed.pathname.toLowerCase();
  if (host !== 'player.siriusxm.com') {
    if (path !== '/player' && !path.startsWith('/player/')) {
      return false;
    }
  }

  if (EXCLUDED_PATH_SEGMENT_RE.test(path)) {
    return false;
  }

  return true;
}

export interface SurfaceThemeServiceOptions {
  getWindow: () => BrowserWindow | undefined;
  getConsent: () => boolean;
  getSettings: () => { id: SurfaceThemeId; accent: string | null };
  onStateChange?: (state: SurfaceThemeState) => void;
  now?: () => number;
}

export class SurfaceThemeService {
  private activeId: SurfaceThemeId = 'official';
  private accent: string | null = null;
  private cssKey: string | null = null;
  private applied = false;
  private pausedOnAuth = false;
  private lastError: string | null = null;
  private cssBytes = 0;
  private appliedAt: number | null = null;
  private documentGeneration = 0;
  private disposed = false;
  private op: Promise<void> = Promise.resolve();
  private readonly now: () => number;

  constructor(private readonly options: SurfaceThemeServiceOptions) {
    this.now = options.now ?? (() => Date.now());
    const initial = options.getSettings();
    this.activeId = normalizeSurfaceThemeId(initial.id);
    this.accent = sanitizeHexAccent(initial.accent);
  }

  private getWebContents(): WebContents | undefined {
    const win = this.options.getWindow();
    if (!win || win.isDestroyed()) return undefined;
    return win.webContents;
  }

  private getCurrentUrl(): string {
    try {
      return this.getWebContents()?.getURL() ?? '';
    } catch {
      return '';
    }
  }

  getState(): SurfaceThemeState {
    const consent = this.options.getConsent();
    return {
      activeId: consent ? this.activeId : 'official',
      accent: this.accent,
      consent,
      applied: consent ? this.applied : false,
      pausedOnAuth: this.pausedOnAuth,
      lastError: this.lastError,
      cssBytes: consent && this.applied ? this.cssBytes : 0,
      appliedAt: this.appliedAt,
      snapshot: SXM_TOKEN_SNAPSHOT,
      themes: listSurfaceThemeSummaries(),
    };
  }

  getDiagnostics(meta: { appVersion: string; platform?: string; url?: string }): SurfaceThemeDiagnostics {
    const state = this.getState();
    return {
      appVersion: meta.appVersion,
      platform: meta.platform ?? process.platform,
      url: meta.url ?? this.getCurrentUrl(),
      activeId: state.activeId,
      accent: state.accent,
      consent: state.consent,
      applied: state.applied,
      pausedOnAuth: Boolean(state.pausedOnAuth),
      cssBytes: state.cssBytes,
      appliedAt: state.appliedAt,
      lastError: state.lastError,
      snapshot: state.snapshot,
    };
  }

  private emitState(): void {
    if (this.disposed) return;
    this.options.onStateChange?.(this.getState());
  }

  private enqueue(task: () => Promise<void>): Promise<SurfaceThemeState> {
    const next = this.op.then(task, task);
    this.op = next.catch(() => undefined);
    return next.then(() => this.getState());
  }

  /**
   * Apply a surface theme (or `'official'` to remove all injected CSS).
   */
  setActive(
    id: SurfaceThemeId,
    options?: { accent?: string | null },
  ): Promise<SurfaceThemeState> {
    return this.enqueue(async () => {
      if (this.disposed) return;

      const normalizedId = normalizeSurfaceThemeId(id);
      const nextAccent =
        options && 'accent' in options ? sanitizeHexAccent(options.accent) : this.accent;

      if (normalizedId === 'official') {
        await this.removeCurrentKey();
        this.activeId = 'official';
        this.accent = nextAccent;
        this.applied = false;
        this.pausedOnAuth = false;
        this.cssBytes = 0;
        this.lastError = null;
        this.emitState();
        return;
      }

      if (!this.options.getConsent()) {
        await this.removeCurrentKey();
        this.activeId = 'official';
        this.applied = false;
        this.pausedOnAuth = false;
        this.cssBytes = 0;
        this.emitState();
        return;
      }

      this.activeId = normalizedId;
      this.accent = nextAccent;

      await this.applyCurrentToDocument(this.documentGeneration);
      this.emitState();
    });
  }

  /**
   * Revert to the official SiriusXM appearance immediately.
   */
  revert(_reason = 'user-revert'): Promise<SurfaceThemeState> {
    return this.enqueue(async () => {
      if (this.disposed) return;
      await this.removeCurrentKey();
      this.activeId = 'official';
      this.accent = null;
      this.applied = false;
      this.pausedOnAuth = false;
      this.cssBytes = 0;
      this.lastError = null;
      this.emitState();
    });
  }

  /**
   * Called on `did-navigate` when the top-level document has been replaced.
   * Advances `documentGeneration` and clears `cssKey` without calling `removeInsertedCSS`
   * on the destroyed document.
   */
  onDocumentReplaced(): void {
    if (this.disposed) return;
    this.documentGeneration += 1;
    this.cssKey = null;
    this.applied = false;
    this.emitState();
  }

  /**
   * Called on `dom-ready` (or `did-navigate-in-page`) to re-apply or pause theming
   * depending on whether the current route is a themeable SiriusXM player URL.
   */
  async onDomReady(url: string): Promise<void> {
    await this.enqueue(async () => {
      if (this.disposed) return;
      const stored = this.options.getSettings();
      this.activeId = normalizeSurfaceThemeId(stored.id);
      this.accent = sanitizeHexAccent(stored.accent);

      if (!this.options.getConsent() || this.activeId === 'official') {
        await this.removeCurrentKey();
        this.applied = false;
        this.pausedOnAuth = false;
        this.cssBytes = 0;
        this.emitState();
        return;
      }

      if (!isThemeableSiriusXmUrl(url)) {
        await this.removeCurrentKey();
        this.applied = false;
        this.pausedOnAuth = true;
        this.cssBytes = 0;
        this.emitState();
        return;
      }

      await this.applyCurrentToDocument(this.documentGeneration, url);
      this.emitState();
    });
  }

  /**
   * Called on in-page SPA route transitions (`did-navigate-in-page`).
   * Keeps the existing stylesheet on player routes without re-inserting,
   * or removes it immediately if the SPA enters an auth/account route.
   */
  async onInPageNavigate(url: string): Promise<void> {
    await this.enqueue(async () => {
      if (this.disposed) return;
      if (!this.options.getConsent() || this.activeId === 'official') return;

      if (!isThemeableSiriusXmUrl(url)) {
        await this.removeCurrentKey();
        this.applied = false;
        this.pausedOnAuth = true;
        this.cssBytes = 0;
        this.emitState();
        return;
      }

      if (!this.applied || !this.cssKey) {
        await this.applyCurrentToDocument(this.documentGeneration, url);
        this.emitState();
      }
    });
  }

  private async applyCurrentToDocument(expectedGen: number, urlOverride?: string): Promise<void> {
    if (expectedGen !== this.documentGeneration) return;

    const contents = this.getWebContents();
    if (!contents) {
      this.applied = false;
      this.cssBytes = 0;
      return;
    }

    const currentUrl = urlOverride ?? this.getCurrentUrl();
    if (currentUrl && !isThemeableSiriusXmUrl(currentUrl)) {
      await this.removeCurrentKey();
      this.applied = false;
      this.pausedOnAuth = true;
      this.cssBytes = 0;
      return;
    }

    try {
      const css = generateSurfaceCss(this.activeId, { accent: this.accent });
      const validation = validateSurfaceCss(css);
      if (!validation.ok) {
        throw new Error(validation.errors.join(' ') || 'Surface CSS failed validation.');
      }

      const newKey = await contents.insertCSS(css, { cssOrigin: 'user' });
      if (expectedGen !== this.documentGeneration) {
        // Document was replaced while insertCSS was in flight; do not touch the new document.
        return;
      }

      const previousKey = this.cssKey;
      this.cssKey = newKey;
      this.applied = true;
      this.pausedOnAuth = false;
      this.cssBytes = validation.byteLength;
      this.appliedAt = this.now();
      this.lastError = null;

      if (previousKey && previousKey !== newKey) {
        try {
          await contents.removeInsertedCSS(previousKey);
        } catch {
          /* ignore if previous key already invalid */
        }
      }
    } catch (error) {
      const message =
        error instanceof Error
          ? error.message
          : 'SiriusXM appearance could not be applied.';
      await this.removeCurrentKey();
      this.activeId = 'official';
      this.applied = false;
      this.pausedOnAuth = false;
      this.cssBytes = 0;
      this.lastError = message;
    }
  }

  private async removeCurrentKey(): Promise<void> {
    const key = this.cssKey;
    this.cssKey = null;
    if (!key) return;
    const contents = this.getWebContents();
    if (!contents) return;
    try {
      await contents.removeInsertedCSS(key);
    } catch {
      /* ignore key from a replaced document */
    }
  }

  dispose(): void {
    this.disposed = true;
    void this.removeCurrentKey();
    this.applied = false;
    this.cssBytes = 0;
  }
}
