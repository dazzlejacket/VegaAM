/**
 * Companion player windows:
 *   1. Compact Companion (`compact.html`, 480x152, frameless, always-on-top capable)
 *   2. Skinned Companion (`skin.html`, 560x720, frameless, supports Bluebird Classic,
 *      Retro Amp, Modern, Retro Satellite, and Classic Compact in light and dark modes)
 *
 * Neither companion window ever creates an <audio> or <video> element; the
 * official SiriusXM main window is the sole audio engine.
 */

import { join } from 'node:path';

import { BrowserWindow, shell } from 'electron';

import type { StoredWindowBounds } from '../core/settings/defaults';
import { isAllowedExternalUrl } from './externalLinks';

export class CompanionWindowsController {
  private compactWindow: BrowserWindow | undefined;
  private skinWindow: BrowserWindow | undefined;
  private alwaysOnTop = false;

  constructor(private readonly rendererDir: string) {}

  get compact(): BrowserWindow | undefined {
    return this.compactWindow && !this.compactWindow.isDestroyed() ? this.compactWindow : undefined;
  }

  get skin(): BrowserWindow | undefined {
    return this.skinWindow && !this.skinWindow.isDestroyed() ? this.skinWindow : undefined;
  }

  /** Create or show the Compact Companion window (480x152). */
  openCompact(bounds?: StoredWindowBounds | null): BrowserWindow {
    if (this.compactWindow && !this.compactWindow.isDestroyed()) {
      this.compactWindow.show();
      this.compactWindow.focus();
      return this.compactWindow;
    }

    const iconPath = join(__dirname, '..', 'icons', 'icon-256.png');
    const win = new BrowserWindow({
      width: 480,
      height: 152,
      x: bounds?.x,
      y: bounds?.y,
      frame: false,
      resizable: false,
      movable: true,
      skipTaskbar: true,
      alwaysOnTop: this.alwaysOnTop,
      transparent: false,
      backgroundColor: '#11141b',
      title: 'VegaAM — Compact Player',
      icon: iconPath,
      webPreferences: {
        preload: join(__dirname, '..', 'preload', 'app.js'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        webviewTag: false,
        spellcheck: false,
      },
    });
    if (process.platform === 'win32' || process.platform === 'linux') {
      try {
        win.setIcon(iconPath);
      } catch {
        /* ignore */
      }
    }

    win.setMenuBarVisibility(false);
    win.once('ready-to-show', () => {
      if (!win.isDestroyed()) win.show();
    });
    win.on('closed', () => {
      this.compactWindow = undefined;
    });

    win.webContents.setWindowOpenHandler(({ url }) => {
      if (isAllowedExternalUrl(url)) void shell.openExternal(url);
      return { action: 'deny' };
    });

    void win.loadFile(join(this.rendererDir, 'compact.html'));
    this.compactWindow = win;
    return win;
  }

  /** Toggle the Compact Companion window visibility. */
  toggleCompact(bounds?: StoredWindowBounds | null): boolean {
    if (!this.compactWindow || this.compactWindow.isDestroyed()) {
      this.openCompact(bounds);
      return true;
    }
    if (this.compactWindow.isVisible()) {
      this.compactWindow.hide();
      return false;
    }
    this.compactWindow.show();
    this.compactWindow.focus();
    return true;
  }

  closeCompact(): void {
    if (this.compactWindow && !this.compactWindow.isDestroyed()) {
      this.compactWindow.close();
    }
    this.compactWindow = undefined;
  }

  /** Create or show the Skinned Companion window (560x720). */
  openSkin(bounds?: StoredWindowBounds | null): BrowserWindow {
    if (this.skinWindow && !this.skinWindow.isDestroyed()) {
      if (this.skinWindow.isMinimized()) this.skinWindow.restore();
      this.skinWindow.show();
      this.skinWindow.focus();
      return this.skinWindow;
    }

    const iconPath = join(__dirname, '..', 'icons', 'icon-256.png');
    const win = new BrowserWindow({
      width: bounds?.width && bounds.width >= 480 ? bounds.width : 560,
      height: bounds?.height && bounds.height >= 620 ? bounds.height : 720,
      x: bounds?.x,
      y: bounds?.y,
      minWidth: 480,
      minHeight: 620,
      frame: false,
      resizable: true,
      movable: true,
      alwaysOnTop: this.alwaysOnTop,
      transparent: false,
      backgroundColor: '#11141b',
      title: 'VegaAM — Skinned Companion',
      icon: iconPath,
      webPreferences: {
        preload: join(__dirname, '..', 'preload', 'app.js'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        webviewTag: false,
        spellcheck: false,
      },
    });
    if (process.platform === 'win32' || process.platform === 'linux') {
      try {
        win.setIcon(iconPath);
      } catch {
        /* ignore */
      }
    }

    win.setMenuBarVisibility(false);
    win.once('ready-to-show', () => {
      if (!win.isDestroyed()) win.show();
    });
    win.on('closed', () => {
      this.skinWindow = undefined;
    });

    win.webContents.setWindowOpenHandler(({ url }) => {
      if (isAllowedExternalUrl(url)) void shell.openExternal(url);
      return { action: 'deny' };
    });

    void win.loadFile(join(this.rendererDir, 'skin.html'));
    this.skinWindow = win;
    return win;
  }

  /** Toggle the Skinned Companion window visibility. */
  toggleSkin(bounds?: StoredWindowBounds | null): boolean {
    if (!this.skinWindow || this.skinWindow.isDestroyed()) {
      this.openSkin(bounds);
      return true;
    }
    if (this.skinWindow.isVisible()) {
      this.skinWindow.hide();
      return false;
    }
    this.skinWindow.show();
    this.skinWindow.focus();
    return true;
  }

  closeSkin(): void {
    if (this.skinWindow && !this.skinWindow.isDestroyed()) {
      this.skinWindow.close();
    }
    this.skinWindow = undefined;
  }

  setAlwaysOnTop(value: boolean): void {
    this.alwaysOnTop = value;
    this.compactWindow?.setAlwaysOnTop(value, 'floating');
    this.skinWindow?.setAlwaysOnTop(value, 'floating');
  }

  get isAlwaysOnTop(): boolean {
    return this.alwaysOnTop;
  }

  getCompactBounds(): StoredWindowBounds | null {
    if (!this.compactWindow || this.compactWindow.isDestroyed()) return null;
    return this.compactWindow.getBounds();
  }

  getSkinBounds(): StoredWindowBounds | null {
    if (!this.skinWindow || this.skinWindow.isDestroyed()) return null;
    return this.skinWindow.getBounds();
  }
}
