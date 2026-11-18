/**
 * Integrated in-window VegaAM UI layer (`WebContentsView` inside `mainWindow.contentView`).
 *
 * Replaces all floating popup windows (`orbWindow`, `panelWindow`, `SettingsWindow`,
 * `ActivityWindow`) with a single in-window view hosted inside the main SiriusXM
 * `BrowserWindow`:
 *   - When collapsed (`open === false`), occupies only a compact 128×38 top-right
 *     launcher pill in the open SiriusXM header area so 99.6% of the player receives
 *     direct pointer and wheel events.
 *   - When expanded (`open === true`), slides open as an integrated right-side
 *     drawer inside `mainWindow` containing Appearance, Activity & History,
 *     Scrobbling Rules, Accounts, Companions & Desktop, and About & Help.
 *   - Spawns ZERO additional OS `BrowserWindow`s (`BrowserWindow.getAllWindows().length === 1`).
 *   - Injects ZERO navigation controls or scripts into the SiriusXM DOM.
 */

import { join } from 'node:path';

import {
  ipcMain,
  nativeImage,
  screen,
  WebContentsView,
  type BrowserWindow,
  type IpcMainInvokeEvent,
  type NativeImage,
  type Rectangle,
  type WebContents,
} from 'electron';

export const ORB_WIDTH = 128;
export const ORB_HEIGHT = 38;
export const ORB_RIGHT_MARGIN = 18;
export const ORB_TOP_MARGIN = 13;
export const PANEL_WIDTH = 700;
export const PANEL_HEIGHT = 760;
export const PANEL_MIN_WIDTH = 480;
export const PANEL_MIN_HEIGHT = 360;
export const PANEL_EDGE_PADDING = 12;

export type DrawerTab =
  | 'appearance'
  | 'activity'
  | 'scrobbling'
  | 'accounts'
  | 'companions'
  | 'about';

export interface DrawerState {
  open: boolean;
  tab: DrawerTab;
}

export const QUICK_PANEL_IPC = Object.freeze({
  getState: 'quick:get-state',
  drawerState: 'quick:drawer-state',
  openPanel: 'quick:open-panel',
  closePanel: 'quick:close-panel',
  togglePanel: 'quick:toggle-panel',
  tab: 'quick:tab',
  filter: 'quick:filter',
});

export function normalizeDrawerTab(raw: unknown, fallback: DrawerTab = 'appearance'): DrawerTab {
  if (typeof raw !== 'string') return fallback;
  switch (raw.trim().toLowerCase()) {
    case 'appearance':
    case 'themes':
    case 'settings':
      return 'appearance';
    case 'activity':
    case 'history':
    case 'monitor':
      return 'activity';
    case 'scrobbling':
    case 'rules':
    case 'metadata':
      return 'scrobbling';
    case 'accounts':
    case 'services':
      return 'accounts';
    case 'companions':
    case 'quick':
    case 'desktop':
      return 'companions';
    case 'about':
    case 'help':
    case 'diagnostics':
      return 'about';
    default:
      return fallback;
  }
}

/**
 * Compute the compact top-right launcher pill bounds inside the main window's content area,
 * optionally clamped to a display workArea.
 */
export function computeOrbBounds(
  contentBounds: Rectangle,
  workArea?: Rectangle | null,
): Rectangle {
  let x = contentBounds.x + contentBounds.width - ORB_WIDTH - ORB_RIGHT_MARGIN;
  let y = contentBounds.y + ORB_TOP_MARGIN;

  if (workArea) {
    const minX = workArea.x + 4;
    const maxX = workArea.x + workArea.width - ORB_WIDTH - 4;
    const minY = workArea.y + 4;
    const maxY = workArea.y + workArea.height - ORB_HEIGHT - 4;
    if (maxX >= minX) x = Math.max(minX, Math.min(maxX, x));
    if (maxY >= minY) y = Math.max(minY, Math.min(maxY, y));
  }

  return {
    x: Math.round(x),
    y: Math.round(y),
    width: ORB_WIDTH,
    height: ORB_HEIGHT,
  };
}

/**
 * Compute the integrated right-side drawer bounds inside the main window's content area,
 * keeping the left portion of the SiriusXM player visible at 900×600, 1280×800, and maximized.
 */
export function computePanelBounds(
  contentBounds: Rectangle,
  workArea?: Rectangle | null,
): Rectangle {
  const proportionalWidth = Math.floor(contentBounds.width * 0.56);
  const maxAllowedWidth = Math.max(PANEL_MIN_WIDTH, contentBounds.width - 240);
  const width = Math.min(
    PANEL_WIDTH,
    maxAllowedWidth,
    Math.max(PANEL_MIN_WIDTH, proportionalWidth),
  );
  const height = Math.max(PANEL_MIN_HEIGHT, contentBounds.height - PANEL_EDGE_PADDING * 2);

  let x = Math.max(
    contentBounds.x + PANEL_EDGE_PADDING,
    contentBounds.x + contentBounds.width - width - PANEL_EDGE_PADDING,
  );
  let y = contentBounds.y + PANEL_EDGE_PADDING;

  if (workArea) {
    const minX = workArea.x + PANEL_EDGE_PADDING;
    const maxX = workArea.x + workArea.width - width - PANEL_EDGE_PADDING;
    const minY = workArea.y + PANEL_EDGE_PADDING;
    const maxY = workArea.y + workArea.height - height - PANEL_EDGE_PADDING;
    if (maxX >= minX) x = Math.max(minX, Math.min(maxX, x));
    if (maxY >= minY) y = Math.max(minY, Math.min(maxY, y));
  }

  return {
    x: Math.round(x),
    y: Math.round(y),
    width: Math.round(width),
    height: Math.round(height),
  };
}

export class QuickPanelController {
  private mainWindow: BrowserWindow | undefined;
  private drawerView: WebContentsView | undefined;
  private enabled = true;
  private viewReady = false;
  private openState = false;
  private activeTab: DrawerTab = 'appearance';

  constructor(private readonly rendererDir: string) {}

  get view(): WebContentsView | undefined {
    return this.drawerView && !this.drawerView.webContents.isDestroyed()
      ? this.drawerView
      : undefined;
  }

  get webContents(): WebContents | undefined {
    return this.view?.webContents;
  }

  get isOpen(): boolean {
    return this.openState;
  }

  get currentTab(): DrawerTab {
    return this.activeTab;
  }

  getState(): DrawerState {
    return {
      open: this.openState,
      tab: this.activeTab,
    };
  }

  getBounds(): Rectangle | null {
    const view = this.view;
    if (!view) return null;
    return view.getBounds();
  }

  /**
   * Attach the integrated in-window `WebContentsView` to the main SiriusXM BrowserWindow.
   */
  attach(main: BrowserWindow): void {
    this.mainWindow = main;
    this.createDrawerView(main);
    this.wireMainEvents(main);
    this.registerIpc();
  }

  private createDrawerView(main: BrowserWindow): void {
    if (this.view) return;

    const view = new WebContentsView({
      webPreferences: {
        preload: join(__dirname, '..', 'preload', 'quick.js'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        webviewTag: false,
        spellcheck: false,
      },
    });

    view.setBackgroundColor('#00000000');
    main.contentView.addChildView(view);
    this.drawerView = view;

    view.webContents.once('did-finish-load', () => {
      this.viewReady = true;
      this.syncVisibilityAndPosition();
      this.emitDrawerState();
    });

    view.webContents.on('before-input-event', (_event, input) => {
      if (input.type === 'keyDown' && input.key === 'Escape' && this.openState) {
        this.closePanel(true);
      }
    });

    main.webContents.on('before-input-event', (_event, input) => {
      if (input.type === 'keyDown' && input.key === 'Escape' && this.openState) {
        this.closePanel(true);
      }
    });

    this.reposition();
    void view.webContents.loadFile(join(this.rendererDir, 'quick', 'panel.html'));
  }

  private wireMainEvents(main: BrowserWindow): void {
    const onGeometry = () => this.reposition();
    main.on('move', onGeometry);
    main.on('resize', onGeometry);
    main.on('maximize', onGeometry);
    main.on('unmaximize', onGeometry);

    main.on('restore', () => {
      this.syncVisibilityAndPosition();
    });
    main.on('show', () => {
      this.syncVisibilityAndPosition();
    });
    main.on('enter-full-screen', () => {
      this.syncVisibilityAndPosition();
    });
    main.on('leave-full-screen', () => {
      this.syncVisibilityAndPosition();
    });
    main.on('closed', () => {
      this.destroy();
    });
  }

  private emitDrawerState(): void {
    const wc = this.webContents;
    if (!wc) return;
    wc.send(QUICK_PANEL_IPC.drawerState, this.getState());
    wc.send(QUICK_PANEL_IPC.tab, this.activeTab);
  }

  private registerIpc(): void {
    const isDrawerSender = (event: IpcMainInvokeEvent): boolean => {
      const wc = this.webContents;
      return Boolean(wc && wc === event.sender);
    };

    ipcMain.removeHandler(QUICK_PANEL_IPC.getState);
    ipcMain.handle(QUICK_PANEL_IPC.getState, (event) => {
      if (!isDrawerSender(event)) return this.getState();
      return this.getState();
    });

    ipcMain.removeHandler(QUICK_PANEL_IPC.openPanel);
    ipcMain.handle(QUICK_PANEL_IPC.openPanel, (event, tab: unknown) => {
      if (!isDrawerSender(event)) return false;
      return this.openPanel(tab);
    });

    ipcMain.removeHandler(QUICK_PANEL_IPC.closePanel);
    ipcMain.handle(QUICK_PANEL_IPC.closePanel, (event) => {
      if (!isDrawerSender(event)) return false;
      this.closePanel(true);
      return true;
    });

    ipcMain.removeHandler(QUICK_PANEL_IPC.togglePanel);
    ipcMain.handle(QUICK_PANEL_IPC.togglePanel, (event, tab: unknown) => {
      if (!isDrawerSender(event)) return false;
      return this.togglePanel(tab);
    });
  }

  setEnabled(enabled: boolean): void {
    this.enabled = enabled;
    if (!enabled && this.openState) {
      this.openState = false;
    }
    this.syncVisibilityAndPosition();
  }

  reposition(): void {
    const main = this.mainWindow;
    const view = this.view;
    if (!main || main.isDestroyed() || !view) return;

    const content = main.getContentBounds();
    const localContent: Rectangle = {
      x: 0,
      y: 0,
      width: Math.max(320, content.width),
      height: Math.max(240, content.height),
    };

    const nextBounds = this.openState
      ? computePanelBounds(localContent)
      : computeOrbBounds(localContent);
    view.setBounds(nextBounds);
  }

  syncVisibilityAndPosition(): void {
    const main = this.mainWindow;
    const view = this.view;
    if (!main || main.isDestroyed() || !view) return;

    const shouldBeVisible =
      (this.enabled || this.openState) &&
      this.viewReady &&
      !main.isFullScreen();

    view.setVisible(shouldBeVisible);
    this.reposition();
  }

  openPanel(rawTab?: unknown): boolean {
    const main = this.mainWindow;
    const view = this.view;
    if (!main || main.isDestroyed() || !view) return false;
    if (!main.isVisible()) {
      main.show();
    }
    this.activeTab = normalizeDrawerTab(rawTab, this.activeTab);
    this.openState = true;
    this.syncVisibilityAndPosition();
    this.emitDrawerState();
    view.webContents.focus();
    return true;
  }

  togglePanel(rawTab?: unknown): boolean {
    if (this.openState) {
      if (rawTab !== undefined && rawTab !== null && rawTab !== '') {
        const requested = normalizeDrawerTab(rawTab, this.activeTab);
        if (requested !== this.activeTab) {
          return this.openPanel(requested);
        }
      }
      this.closePanel(true);
      return false;
    }
    return this.openPanel(rawTab);
  }

  closePanel(returnFocus = true): void {
    this.openState = false;
    this.syncVisibilityAndPosition();
    this.emitDrawerState();
    if (
      returnFocus &&
      this.mainWindow &&
      !this.mainWindow.isDestroyed() &&
      this.mainWindow.isVisible()
    ) {
      this.mainWindow.webContents.focus();
    }
  }

  setFilter(filter: 'all' | 'light' | 'dark'): void {
    const wc = this.webContents;
    if (!wc) return;
    wc.send(QUICK_PANEL_IPC.filter, filter);
  }

  hideAll(): void {
    this.openState = false;
    this.view?.setVisible(false);
  }

  /**
   * Capture a pixel-accurate composite screenshot of the main window (`SiriusXM` +
   * the integrated in-window VegaAM launcher pill or drawer).
   */
  async captureCompositePage(): Promise<NativeImage | undefined> {
    const main = this.mainWindow;
    const view = this.view;
    if (!main || main.isDestroyed()) return undefined;

    const baseImage = await main.webContents.capturePage();
    if (!view || !this.viewReady || baseImage.isEmpty()) {
      return baseImage;
    }

    try {
      const content = main.getContentBounds();
      const targetWidth = Math.max(1, content.width);
      const targetHeight = Math.max(1, content.height);
      const baseResized = baseImage.resize({ width: targetWidth, height: targetHeight });
      const baseBuf = Buffer.from(baseResized.toBitmap());

      const viewBounds = view.getBounds();
      if (viewBounds.width <= 0 || viewBounds.height <= 0) {
        return baseResized;
      }

      const overlayImage = await view.webContents.capturePage();
      if (overlayImage.isEmpty()) {
        return baseResized;
      }

      const overlayResized = overlayImage.resize({
        width: viewBounds.width,
        height: viewBounds.height,
      });
      const overlayBuf = overlayResized.toBitmap();

      for (let oy = 0; oy < viewBounds.height; oy++) {
        const dy = viewBounds.y + oy;
        if (dy < 0 || dy >= targetHeight) continue;
        for (let ox = 0; ox < viewBounds.width; ox++) {
          const dx = viewBounds.x + ox;
          if (dx < 0 || dx >= targetWidth) continue;

          const sIdx = (oy * viewBounds.width + ox) * 4;
          const dIdx = (dy * targetWidth + dx) * 4;

          const sa = (overlayBuf[sIdx + 3] ?? 0) / 255;
          if (sa <= 0) continue;
          const invA = 1 - sa;

          baseBuf[dIdx] = Math.round((overlayBuf[sIdx] ?? 0) * sa + (baseBuf[dIdx] ?? 0) * invA);
          baseBuf[dIdx + 1] = Math.round(
            (overlayBuf[sIdx + 1] ?? 0) * sa + (baseBuf[dIdx + 1] ?? 0) * invA,
          );
          baseBuf[dIdx + 2] = Math.round(
            (overlayBuf[sIdx + 2] ?? 0) * sa + (baseBuf[dIdx + 2] ?? 0) * invA,
          );
          baseBuf[dIdx + 3] = 255;
        }
      }

      return nativeImage.createFromBitmap(baseBuf, {
        width: targetWidth,
        height: targetHeight,
      });
    } catch {
      return baseImage;
    }
  }

  destroy(): void {
    ipcMain.removeHandler(QUICK_PANEL_IPC.getState);
    ipcMain.removeHandler(QUICK_PANEL_IPC.openPanel);
    ipcMain.removeHandler(QUICK_PANEL_IPC.closePanel);
    ipcMain.removeHandler(QUICK_PANEL_IPC.togglePanel);
    if (this.drawerView && this.mainWindow && !this.mainWindow.isDestroyed()) {
      try {
        this.mainWindow.contentView.removeChildView(this.drawerView);
      } catch {
        /* ignore */
      }
    }
    if (this.drawerView && !this.drawerView.webContents.isDestroyed()) {
      this.drawerView.webContents.close();
    }
    this.drawerView = undefined;
    this.mainWindow = undefined;
    this.viewReady = false;
    this.openState = false;
  }
}
