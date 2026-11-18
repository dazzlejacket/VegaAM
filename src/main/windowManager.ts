/**
 * Window and in-window view coordinator for VegaAM 3.2.
 *
 * Coordinates:
 *   1. Official SiriusXM Main Window (`OfficialPlayerController`)
 *   2. Integrated In-Window Drawer & Launcher Pill (`QuickPanelController` — `WebContentsView` inside `mainWindow.contentView`)
 *   3. Optional Compact Companion (`CompanionWindowsController.compact`)
 *   4. Optional Skinned Companion (`CompanionWindowsController.skin`)
 *
 * Normal Settings, Appearance, Scrobbling, Activity, Accounts, and About navigation
 * occurs entirely inside the single main window (`mainWindow`) with zero popup windows.
 */

import type { BrowserWindow, WebContents } from 'electron';

import type { StoredWindowBounds, WindowStateMap } from '../core/settings/defaults';
import { CompanionWindowsController } from './companionWindows';
import { OfficialPlayerController } from './officialPlayer';
import { QuickPanelController, type DrawerTab } from './quickPanel';

export class WindowManager {
  readonly officialPlayer = new OfficialPlayerController();
  readonly quickPanel: QuickPanelController;
  readonly companions: CompanionWindowsController;

  private quitting = false;
  private closeToTray = true;
  private savedWindowState: WindowStateMap = {};

  constructor(rendererDir: string) {
    this.quickPanel = new QuickPanelController(rendererDir);
    this.companions = new CompanionWindowsController(rendererDir);
  }

  get main(): BrowserWindow | undefined {
    return this.officialPlayer.mainWindow;
  }

  get mini(): BrowserWindow | undefined {
    return this.companions.compact;
  }

  get compact(): BrowserWindow | undefined {
    return this.companions.compact;
  }

  get skin(): BrowserWindow | undefined {
    return this.companions.skin;
  }

  setSavedWindowState(state: WindowStateMap): void {
    this.savedWindowState = { ...state };
  }

  setCloseToTray(enabled: boolean): void {
    this.closeToTray = enabled;
  }

  shouldPreventMainClose(): boolean {
    if (this.quitting) return false;
    if (this.closeToTray) return true;
    const compactVisible = Boolean(this.companions.compact?.isVisible());
    const skinVisible = Boolean(this.companions.skin?.isVisible());
    return compactVisible || skinVisible;
  }

  /** Create the primary official SiriusXM BrowserWindow and attach the integrated in-window drawer. */
  createMain(bounds?: StoredWindowBounds | null): BrowserWindow {
    const win = this.officialPlayer.createWindow(bounds ?? this.savedWindowState.main);
    this.quickPanel.attach(win);
    return win;
  }

  /** Restore, show, and focus the official SiriusXM main window. */
  showMain(): void {
    const win = this.main;
    if (!win) return;
    if (win.isMinimized()) win.restore();
    win.show();
    win.focus();
    this.quickPanel.syncVisibilityAndPosition();
  }

  /**
   * Open the integrated in-window Settings / Appearance drawer inside `mainWindow`
   * without spawning any floating popup window.
   */
  openSettings(tab: DrawerTab | string = 'appearance'): boolean {
    return this.quickPanel.openPanel(tab);
  }

  /**
   * Open the integrated in-window Activity & History tab inside `mainWindow`
   * without spawning any floating popup window.
   */
  openActivity(): boolean {
    return this.quickPanel.openPanel('activity');
  }

  /** Open the integrated in-window drawer to a specific tab. */
  openQuickPanel(tab: DrawerTab | string = 'appearance'): boolean {
    return this.quickPanel.openPanel(tab);
  }

  /** Toggle the integrated in-window drawer. */
  toggleQuickPanel(tab?: DrawerTab | string): boolean {
    return this.quickPanel.togglePanel(tab);
  }

  setQuickPanelEnabled(enabled: boolean): void {
    this.quickPanel.setEnabled(enabled);
  }

  /** Open or show the Compact Companion window. */
  createMini(): BrowserWindow {
    return this.companions.openCompact(this.savedWindowState.compact);
  }

  openCompact(): BrowserWindow {
    return this.companions.openCompact(this.savedWindowState.compact);
  }

  /** Toggle the Compact Companion window. */
  toggleMini(): boolean {
    return this.companions.toggleCompact(this.savedWindowState.compact);
  }

  toggleCompact(): boolean {
    return this.companions.toggleCompact(this.savedWindowState.compact);
  }

  /** Open or show the Skinned Companion window. */
  openSkin(): BrowserWindow {
    return this.companions.openSkin(this.savedWindowState.skin);
  }

  /** Toggle the Skinned Companion window. */
  toggleSkin(): boolean {
    return this.companions.toggleSkin(this.savedWindowState.skin);
  }

  setMiniPlayerEnabled(enabled: boolean): void {
    if (!enabled) {
      this.companions.closeCompact();
    }
  }

  setCompactPlayerEnabled(enabled: boolean): void {
    if (!enabled) {
      this.companions.closeCompact();
    }
  }

  setAlwaysOnTop(value: boolean): void {
    this.companions.setAlwaysOnTop(value);
  }

  get isAlwaysOnTop(): boolean {
    return this.companions.isAlwaysOnTop;
  }

  allowClose(): void {
    this.quitting = true;
  }

  /**
   * All active VegaAM-owned local renderer windows (used for sender validation).
   *
   * The integrated drawer is NOT listed here because it lives inside the main
   * window as a `WebContentsView` — see `getVegaWebContents()`.
   */
  getVegaWindows(): (BrowserWindow | undefined)[] {
    return [this.companions.compact, this.companions.skin];
  }

  /**
   * All active VegaAM-owned local `WebContents` (including the in-window drawer).
   */
  getVegaWebContents(): (WebContents | undefined)[] {
    return [
      this.quickPanel.webContents,
      this.companions.compact?.webContents,
      this.companions.skin?.webContents,
    ];
  }

  /**
   * Send an IPC event to the integrated in-window drawer and any active companion windows.
   * Never sends custom IPC to the official SiriusXM webContents.
   */
  broadcast(channel: string, payload: unknown): void {
    const targets = this.getVegaWebContents();
    for (const wc of targets) {
      if (wc && !wc.isDestroyed()) {
        wc.send(channel, payload);
      }
    }
  }

  getMainBounds(): StoredWindowBounds | null {
    const win = this.main;
    if (!win) return this.savedWindowState.main ?? null;
    const bounds = win.getBounds();
    return {
      ...bounds,
      maximized: win.isMaximized(),
    };
  }

  getWindowState(): WindowStateMap {
    return {
      main: this.getMainBounds() ?? this.savedWindowState.main ?? null,
      compact: this.companions.getCompactBounds() ?? this.savedWindowState.compact ?? null,
      skin: this.companions.getSkinBounds() ?? this.savedWindowState.skin ?? null,
      settings: this.savedWindowState.settings ?? null,
      activity: this.savedWindowState.activity ?? null,
    };
  }
}
