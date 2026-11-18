/**
 * Preload script for the integrated in-window VegaAM drawer (`panel.html`).
 *
 * Exposes both `window.sxm` (full Settings, Activity, Scrobbling, Accounts,
 * Companions, and Surface Theme API) and `window.vegaQuick` (in-window drawer
 * open/close/tab controls).
 *
 * Context isolation and sandbox remain enabled; no Node globals are exposed.
 */

import { contextBridge, ipcRenderer } from 'electron';

import type {
  SurfaceThemeDiagnostics,
  SurfaceThemeId,
  SurfaceThemeState,
} from '../core/surfaceTheme/types';
import { IPC, type AppState, type HistoryEntryView } from '../shared/types';

export type VegaDrawerTab =
  | 'appearance'
  | 'activity'
  | 'scrobbling'
  | 'accounts'
  | 'companions'
  | 'about'
  | 'themes'
  | 'quick';

export interface VegaDrawerState {
  open: boolean;
  tab: 'appearance' | 'activity' | 'scrobbling' | 'accounts' | 'companions' | 'about';
}

const sxmApi = {
  getState: (): Promise<AppState> => ipcRenderer.invoke(IPC.stateGet),

  onState: (callback: (state: AppState) => void): (() => void) => {
    const listener = (_event: unknown, state: AppState) => callback(state);
    ipcRenderer.on(IPC.stateUpdate, listener);
    return () => ipcRenderer.removeListener(IPC.stateUpdate, listener);
  },

  onNotify: (callback: (payload: { kind: string; payload: unknown }) => void): (() => void) => {
    const listener = (_event: unknown, payload: { kind: string; payload: unknown }) =>
      callback(payload);
    ipcRenderer.on('app:notify', listener);
    return () => ipcRenderer.removeListener('app:notify', listener);
  },

  patchSettings: (patch: unknown) => ipcRenderer.invoke(IPC.settingsPatch, patch),

  history: () => ipcRenderer.invoke(IPC.historyList) as Promise<HistoryEntryView[]>,
  clearHistory: () => ipcRenderer.invoke(IPC.historyClear),
  retryHistory: (id: string) => ipcRenderer.invoke(IPC.historyRetry, id),

  getSurfaceTheme: (): Promise<SurfaceThemeState> => ipcRenderer.invoke(IPC.surfaceThemeGet),
  onSurfaceThemeState: (callback: (state: SurfaceThemeState) => void): (() => void) => {
    const listener = (_event: unknown, state: SurfaceThemeState) => callback(state);
    ipcRenderer.on(IPC.surfaceThemeState, listener);
    return () => ipcRenderer.removeListener(IPC.surfaceThemeState, listener);
  },
  applySurfaceTheme: (id: SurfaceThemeId | string): Promise<SurfaceThemeState> =>
    ipcRenderer.invoke(IPC.surfaceThemeApply, id),
  revertSurfaceTheme: (): Promise<SurfaceThemeState> => ipcRenderer.invoke(IPC.surfaceThemeRevert),
  applySurfaceAccent: (
    id: SurfaceThemeId | string,
    accent: string | null,
  ): Promise<SurfaceThemeState> => ipcRenderer.invoke(IPC.surfaceThemeAccent, { id, accent }),
  setSurfaceConsent: (consent: boolean): Promise<SurfaceThemeState> =>
    ipcRenderer.invoke(IPC.surfaceThemeConsent, consent),
  getSurfaceDiagnostics: (): Promise<SurfaceThemeDiagnostics> =>
    ipcRenderer.invoke(IPC.surfaceThemeDiagnostics),

  listThemes: () => ipcRenderer.invoke(IPC.themeList),
  selectTheme: (id: string) => ipcRenderer.invoke(IPC.themeSelect, id),
  selectSkin: (id: string) => ipcRenderer.invoke(IPC.skinSelect, id),
  importTheme: (json: string) => ipcRenderer.invoke(IPC.themeImport, json),
  exportTheme: (id: string) => ipcRenderer.invoke(IPC.themeExport, id),
  importThemeFile: () => ipcRenderer.invoke(IPC.themeImportFile),
  exportThemeFile: (id: string) => ipcRenderer.invoke(IPC.themeExportFile, id),
  previewTheme: (
    id: string,
    options?: { mode?: 'dark' | 'light'; accentColor?: string | null; artworkTint?: boolean },
  ) => ipcRenderer.invoke(IPC.themePreview, id, options),

  toggleMuted: (name: string) => ipcRenderer.invoke(IPC.channelToggleMuted, name),

  correctMetadata: (payload: {
    artist?: string;
    title?: string;
    rawArtist?: string | null;
    rawTitle?: string | null;
    remove?: boolean;
    key?: string;
  }) => ipcRenderer.invoke(IPC.metadataCorrect, payload),
  listCorrections: () => ipcRenderer.invoke(IPC.metadataCorrectList),

  playerCommand: (command: string) => ipcRenderer.invoke(IPC.playerCommand, command),
  setVolume: (volume: number) => ipcRenderer.invoke(IPC.playerVolume, volume),
  reloadPlayer: () => ipcRenderer.invoke(IPC.playerReload),
  clearPlayerSession: () => ipcRenderer.invoke(IPC.playerClearSession),
  playerSnapshot: () => ipcRenderer.invoke(IPC.playerSnapshot),

  serviceStatus: () => ipcRenderer.invoke(IPC.servicesStatus),
  connectLastfm: (payload?: { apiKey?: string; apiSecret?: string }) =>
    ipcRenderer.invoke(IPC.lastfmConnect, payload ?? {}),
  saveLastfmCredentials: (payload: { apiKey?: string; apiSecret?: string }) =>
    ipcRenderer.invoke(IPC.lastfmCredentialsSave, payload),
  disconnectLastfm: () => ipcRenderer.invoke(IPC.lastfmDisconnect),
  connectListenbrainz: (token: string) => ipcRenderer.invoke(IPC.listenbrainzConnect, token),
  disconnectListenbrainz: () => ipcRenderer.invoke(IPC.listenbrainzDisconnect),
  testServices: () => ipcRenderer.invoke(IPC.servicesTest),

  listQueue: () => ipcRenderer.invoke(IPC.queueList),
  retryQueueItem: (id: string) => ipcRenderer.invoke(IPC.queueRetry, id),
  removeQueueItem: (id: string) => ipcRenderer.invoke(IPC.queueRemove, id),

  showMainWindow: () => ipcRenderer.invoke(IPC.windowShowMain),
  toggleMiniPlayer: () => ipcRenderer.invoke(IPC.windowCompact),
  toggleCompactPlayer: () => ipcRenderer.invoke(IPC.windowCompact),
  toggleSkinWindow: (skinId?: string) => ipcRenderer.invoke(IPC.windowSkin, skinId),
  openSettingsWindow: (tab?: VegaDrawerTab) => ipcRenderer.invoke(IPC.windowSettings, tab),
  openActivityWindow: () => ipcRenderer.invoke(IPC.windowActivity),
  toggleQuickPanel: (tab?: VegaDrawerTab) => ipcRenderer.invoke(IPC.windowQuickPanel, tab),
  setAlwaysOnTop: (value: boolean) => ipcRenderer.invoke(IPC.windowAlwaysOnTop, value),
  minimizeWindow: () => ipcRenderer.invoke(IPC.windowMinimize),
  maximizeWindow: () => ipcRenderer.invoke(IPC.windowMaximize),
  closeWindow: () => ipcRenderer.invoke(IPC.windowClose),

  cleanupLegacyShortcuts: (): Promise<{ ok: boolean; removed: string[]; errors: string[] }> =>
    ipcRenderer.invoke(IPC.legacyCleanupShortcuts),
  openLegacyFolder: (): Promise<boolean> => ipcRenderer.invoke(IPC.legacyOpenFolder),
  launchLegacyUninstaller: (): Promise<boolean> => ipcRenderer.invoke(IPC.legacyUninstall),
  refreshIconCache: (): Promise<boolean> => ipcRenderer.invoke(IPC.legacyRefreshIconCache),

  openExternal: (url: string) => ipcRenderer.invoke(IPC.openExternal, url),
};

const quickApi = {
  getState: sxmApi.getState,
  onState: sxmApi.onState,
  getSurfaceTheme: sxmApi.getSurfaceTheme,
  onSurfaceTheme: sxmApi.onSurfaceThemeState,
  applySurfaceTheme: sxmApi.applySurfaceTheme,
  applyCustomAccent: sxmApi.applySurfaceAccent,
  revertSurfaceTheme: sxmApi.revertSurfaceTheme,
  setSurfaceConsent: sxmApi.setSurfaceConsent,
  getSurfaceDiagnostics: sxmApi.getSurfaceDiagnostics,

  getDrawerState: (): Promise<VegaDrawerState> => ipcRenderer.invoke('quick:get-state'),

  onDrawerState: (callback: (state: VegaDrawerState) => void): (() => void) => {
    const listener = (_event: unknown, state: VegaDrawerState) => callback(state);
    ipcRenderer.on('quick:drawer-state', listener);
    return () => ipcRenderer.removeListener('quick:drawer-state', listener);
  },

  openPanel: (tab: VegaDrawerTab = 'appearance'): Promise<boolean> =>
    ipcRenderer.invoke('quick:open-panel', tab),

  togglePanel: (tab?: VegaDrawerTab): Promise<boolean> =>
    ipcRenderer.invoke('quick:toggle-panel', tab),

  closePanel: (): Promise<boolean> => ipcRenderer.invoke('quick:close-panel'),

  onTab: (callback: (tab: VegaDrawerState['tab']) => void): (() => void) => {
    const listener = (_event: unknown, tab: VegaDrawerState['tab']) => callback(tab);
    ipcRenderer.on('quick:tab', listener);
    return () => ipcRenderer.removeListener('quick:tab', listener);
  },

  onFilter: (callback: (filter: 'all' | 'light' | 'dark') => void): (() => void) => {
    const listener = (_event: unknown, filter: 'all' | 'light' | 'dark') => callback(filter);
    ipcRenderer.on('quick:filter', listener);
    return () => ipcRenderer.removeListener('quick:filter', listener);
  },

  openSettings: (tab: VegaDrawerTab = 'appearance'): Promise<boolean> =>
    ipcRenderer.invoke('quick:open-panel', tab),
  toggleCompact: sxmApi.toggleCompactPlayer,
  toggleSkin: sxmApi.toggleSkinWindow,
  openActivity: (): Promise<boolean> => ipcRenderer.invoke('quick:open-panel', 'activity'),
  showMain: sxmApi.showMainWindow,
};

export type VegaQuickApi = typeof quickApi;

contextBridge.exposeInMainWorld('sxm', sxmApi);
contextBridge.exposeInMainWorld('vegaQuick', quickApi);
