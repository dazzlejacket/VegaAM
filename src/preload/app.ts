/**
 * Preload script for VegaAM-owned secondary windows (Settings, Activity,
 * Compact Companion, and Skinned Companion).
 *
 * The official SiriusXM main window does NOT load this preload; it loads
 * `mediaBridge.js` instead.
 */

import { contextBridge, ipcRenderer } from 'electron';

import {
  IPC,
  type AppState,
  type HistoryEntryView,
  type SurfaceThemeDiagnostics,
  type SurfaceThemeId,
  type SurfaceThemeState,
} from '../shared/types';

const api = {
  /** The current application state. */
  getState: (): Promise<AppState> => ipcRenderer.invoke(IPC.stateGet),

  /** Subscribe to state updates. */
  onState: (callback: (state: AppState) => void): (() => void) => {
    const listener = (_event: unknown, state: AppState) => callback(state);
    ipcRenderer.on(IPC.stateUpdate, listener);
    return () => ipcRenderer.removeListener(IPC.stateUpdate, listener);
  },

  /** Subscribe to notifications (toasts). */
  onNotify: (callback: (payload: { kind: string; payload: unknown }) => void): (() => void) => {
    const listener = (_event: unknown, payload: { kind: string; payload: unknown }) =>
      callback(payload);
    ipcRenderer.on('app:notify', listener);
    return () => ipcRenderer.removeListener('app:notify', listener);
  },

  /** Update the settings. */
  patchSettings: (patch: unknown) => ipcRenderer.invoke(IPC.settingsPatch, patch),

  /** The local scrobble history. */
  history: () => ipcRenderer.invoke(IPC.historyList) as Promise<HistoryEntryView[]>,
  clearHistory: () => ipcRenderer.invoke(IPC.historyClear),
  retryHistory: (id: string) => ipcRenderer.invoke(IPC.historyRetry, id),

  /** SiriusXM surface themes (reversible CSS tokens). */
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

  /** VegaAM window themes & companion skins. */
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

  /** Scrobble channel muting. */
  toggleMuted: (name: string) => ipcRenderer.invoke(IPC.channelToggleMuted, name),

  /** Metadata corrections. */
  correctMetadata: (payload: {
    artist?: string;
    title?: string;
    rawArtist?: string | null;
    rawTitle?: string | null;
    remove?: boolean;
    key?: string;
  }) => ipcRenderer.invoke(IPC.metadataCorrect, payload),
  listCorrections: () => ipcRenderer.invoke(IPC.metadataCorrectList),

  /** Official player transport / session actions. */
  playerCommand: (command: string) => ipcRenderer.invoke(IPC.playerCommand, command),
  setVolume: (volume: number) => ipcRenderer.invoke(IPC.playerVolume, volume),
  reloadPlayer: () => ipcRenderer.invoke(IPC.playerReload),
  clearPlayerSession: () => ipcRenderer.invoke(IPC.playerClearSession),
  playerSnapshot: () => ipcRenderer.invoke(IPC.playerSnapshot),

  /** Scrobbling services. */
  serviceStatus: () => ipcRenderer.invoke(IPC.servicesStatus),
  connectLastfm: (payload?: { apiKey?: string; apiSecret?: string }) =>
    ipcRenderer.invoke(IPC.lastfmConnect, payload ?? {}),
  saveLastfmCredentials: (payload: { apiKey?: string; apiSecret?: string }) =>
    ipcRenderer.invoke(IPC.lastfmCredentialsSave, payload),
  disconnectLastfm: () => ipcRenderer.invoke(IPC.lastfmDisconnect),
  connectListenbrainz: (token: string) => ipcRenderer.invoke(IPC.listenbrainzConnect, token),
  disconnectListenbrainz: () => ipcRenderer.invoke(IPC.listenbrainzDisconnect),
  testServices: () => ipcRenderer.invoke(IPC.servicesTest),

  /** The offline retry queue. */
  listQueue: () => ipcRenderer.invoke(IPC.queueList),
  retryQueueItem: (id: string) => ipcRenderer.invoke(IPC.queueRetry, id),
  removeQueueItem: (id: string) => ipcRenderer.invoke(IPC.queueRemove, id),

  /** Window management. */
  showMainWindow: () => ipcRenderer.invoke(IPC.windowShowMain),
  toggleMiniPlayer: () => ipcRenderer.invoke(IPC.windowCompact),
  toggleCompactPlayer: () => ipcRenderer.invoke(IPC.windowCompact),
  toggleSkinWindow: (skinId?: string) => ipcRenderer.invoke(IPC.windowSkin, skinId),
  openSettingsWindow: () => ipcRenderer.invoke(IPC.windowSettings),
  openActivityWindow: () => ipcRenderer.invoke(IPC.windowActivity),
  toggleQuickPanel: () => ipcRenderer.invoke(IPC.windowQuickPanel),
  setAlwaysOnTop: (value: boolean) => ipcRenderer.invoke(IPC.windowAlwaysOnTop, value),
  minimizeWindow: () => ipcRenderer.invoke(IPC.windowMinimize),
  maximizeWindow: () => ipcRenderer.invoke(IPC.windowMaximize),
  closeWindow: () => ipcRenderer.invoke(IPC.windowClose),

  /** Legacy SiriusXM Desktop & icon cache maintenance. */
  cleanupLegacyShortcuts: (): Promise<{ ok: boolean; removed: string[]; errors: string[] }> =>
    ipcRenderer.invoke(IPC.legacyCleanupShortcuts),
  openLegacyFolder: (): Promise<boolean> => ipcRenderer.invoke(IPC.legacyOpenFolder),
  launchLegacyUninstaller: (): Promise<boolean> => ipcRenderer.invoke(IPC.legacyUninstall),
  refreshIconCache: (): Promise<boolean> => ipcRenderer.invoke(IPC.legacyRefreshIconCache),

  /** Open a link in the system browser. */
  openExternal: (url: string) => ipcRenderer.invoke(IPC.openExternal, url),
};

export type SxmApi = typeof api;

contextBridge.exposeInMainWorld('sxm', api);
