/**
 * Narrow IPC handlers and sender validation for SiriusXM surface themes.
 *
 * Only VegaAM-owned local `file://` renderer windows (Settings, Quick Panel, Orb)
 * are allowed to invoke surface theme IPC channels. Any message from the official
 * SiriusXM `https://` webContents or an unknown frame is rejected.
 */

import { ipcMain, type BrowserWindow, type IpcMainInvokeEvent, type WebContents } from 'electron';

import {
  isBuiltinSurfaceThemeId,
  normalizeSurfaceThemeId,
} from '../core/surfaceTheme/palettes';
import type {
  SurfaceThemeDiagnostics,
  SurfaceThemeId,
  SurfaceThemeState,
} from '../core/surfaceTheme/types';
import { isValidHexAccent, sanitizeHexAccent } from '../core/surfaceTheme/validate';
import type { SurfaceThemeService } from './surfaceThemeService';

export const SURFACE_THEME_IPC = Object.freeze({
  get: 'surfaceTheme:get',
  apply: 'surfaceTheme:apply',
  revert: 'surfaceTheme:revert',
  accent: 'surfaceTheme:accent',
  consent: 'surfaceTheme:consent',
  diagnostics: 'surfaceTheme:diagnostics',
  stateUpdate: 'surfaceTheme:state',
});

export interface SurfaceThemeIpcDependencies {
  service: SurfaceThemeService;
  getAllowedWindows: () => (BrowserWindow | undefined)[];
  getAllowedWebContents?: () => (WebContents | undefined)[];
  getOfficialWindow?: () => BrowserWindow | undefined;
  getConsent: () => boolean;
  getSettings: () => { id: SurfaceThemeId; accent: string | null };
  saveSurfaceSettings: (patch: {
    surfaceThemeId?: string | null;
    surfaceThemeAccent?: string | null;
    surfaceThemeConsent?: boolean;
  }) => Promise<void>;
  getDiagnosticsMeta: () => { appVersion: string; platform?: string; url?: string };
  promptConsent?: (parentWindow?: BrowserWindow) => Promise<boolean>;
}

/**
 * Verify that an IPC invocation originates from the main frame of a known
 * VegaAM-owned local `file://` view/window and never from the official SiriusXM webContents.
 */
export function isAuthorizedSurfaceThemeSender(
  event: Pick<IpcMainInvokeEvent, 'sender' | 'senderFrame'>,
  allowedWindows: (BrowserWindow | undefined)[],
  officialWindow?: BrowserWindow | undefined,
  allowedWebContents: (WebContents | undefined)[] = [],
): boolean {
  const sender: WebContents | undefined = event.sender;
  if (!sender) return false;

  if (officialWindow && !officialWindow.isDestroyed() && officialWindow.webContents === sender) {
    return false;
  }

  const matchedWindow = allowedWindows.find(
    (win) => win && !win.isDestroyed() && win.webContents === sender,
  );
  const matchedContents = allowedWebContents.find(
    (wc) => wc && !wc.isDestroyed() && wc === sender,
  );
  if (!matchedWindow && !matchedContents) return false;

  const frameUrl = event.senderFrame?.url ?? '';
  if (!frameUrl.startsWith('file://')) return false;

  if (sender.mainFrame && event.senderFrame && event.senderFrame !== sender.mainFrame) {
    return false;
  }

  return true;
}

/**
 * Create a testable handler map for the `surfaceTheme:*` IPC channels.
 *
 * In VegaAM 3.2, selecting a theme or custom accent in the integrated Appearance view
 * (which displays a concise inline opt-in notice and one-click Reset to Official)
 * records user consent directly without interrupting playback with a modal OS dialog.
 */
export function createSurfaceThemeIpcHandlers(deps: SurfaceThemeIpcDependencies) {
  const assertAuthorized = (
    event: Pick<IpcMainInvokeEvent, 'sender' | 'senderFrame'>,
  ): BrowserWindow | undefined => {
    const allowed = deps.getAllowedWindows();
    const allowedWc = deps.getAllowedWebContents?.() ?? [];
    const official = deps.getOfficialWindow?.();
    if (!isAuthorizedSurfaceThemeSender(event, allowed, official, allowedWc)) {
      throw new Error('Unauthorized surfaceTheme IPC sender.');
    }
    return allowed.find((win) => win && !win.isDestroyed() && win.webContents === event.sender);
  };

  const ensureConsent = async (senderWin?: BrowserWindow): Promise<boolean> => {
    if (deps.getConsent()) return true;
    const accepted = deps.promptConsent
      ? await deps.promptConsent(senderWin ?? deps.getOfficialWindow?.())
      : true;
    if (accepted) {
      await deps.saveSurfaceSettings({ surfaceThemeConsent: true });
      return true;
    }
    return false;
  };

  return {
    get: async (
      event: Pick<IpcMainInvokeEvent, 'sender' | 'senderFrame'>,
    ): Promise<SurfaceThemeState> => {
      assertAuthorized(event);
      return deps.service.getState();
    },

    apply: async (
      event: Pick<IpcMainInvokeEvent, 'sender' | 'senderFrame'>,
      rawId: unknown,
    ): Promise<SurfaceThemeState> => {
      const senderWin = assertAuthorized(event);
      if (rawId === 'official' || rawId === null || rawId === '') {
        await deps.saveSurfaceSettings({ surfaceThemeId: null });
        return deps.service.setActive('official');
      }
      if (!isBuiltinSurfaceThemeId(rawId)) {
        await deps.saveSurfaceSettings({ surfaceThemeId: null });
        return deps.service.revert('unknown-theme-id');
      }

      const consented = await ensureConsent(senderWin);
      if (!consented) {
        return deps.service.getState();
      }

      await deps.saveSurfaceSettings({ surfaceThemeId: rawId });
      const state = await deps.service.setActive(rawId, {
        accent: deps.getSettings().accent,
      });
      if (state.lastError) {
        await deps.saveSurfaceSettings({ surfaceThemeId: null });
      }
      return state;
    },

    revert: async (
      event: Pick<IpcMainInvokeEvent, 'sender' | 'senderFrame'>,
    ): Promise<SurfaceThemeState> => {
      assertAuthorized(event);
      await deps.saveSurfaceSettings({
        surfaceThemeId: null,
        surfaceThemeAccent: null,
      });
      return deps.service.revert('user-reset');
    },

    accent: async (
      event: Pick<IpcMainInvokeEvent, 'sender' | 'senderFrame'>,
      payload: unknown,
    ): Promise<SurfaceThemeState> => {
      const senderWin = assertAuthorized(event);
      const data = (payload && typeof payload === 'object' ? payload : {}) as {
        id?: unknown;
        accent?: unknown;
      };

      const rawAccent = data.accent;
      if (rawAccent !== null && rawAccent !== undefined && rawAccent !== '' && !isValidHexAccent(rawAccent)) {
        throw new Error('Invalid custom accent hex colour.');
      }
      const cleanAccent = sanitizeHexAccent(rawAccent);
      const currentSettings = deps.getSettings();
      const targetId: SurfaceThemeId = isBuiltinSurfaceThemeId(data.id)
        ? data.id
        : currentSettings.id !== 'official'
          ? currentSettings.id
          : 'vega';

      const consented = await ensureConsent(senderWin);
      if (!consented) {
        return deps.service.getState();
      }

      await deps.saveSurfaceSettings({
        surfaceThemeId: targetId,
        surfaceThemeAccent: cleanAccent,
      });
      return deps.service.setActive(normalizeSurfaceThemeId(targetId), { accent: cleanAccent });
    },

    consent: async (
      event: Pick<IpcMainInvokeEvent, 'sender' | 'senderFrame'>,
      rawConsent: unknown,
    ): Promise<SurfaceThemeState> => {
      assertAuthorized(event);
      const enabled = Boolean(rawConsent);
      if (!enabled) {
        await deps.saveSurfaceSettings({
          surfaceThemeConsent: false,
          surfaceThemeId: null,
        });
        return deps.service.revert('consent-revoked');
      }
      await deps.saveSurfaceSettings({ surfaceThemeConsent: true });
      const current = deps.getSettings();
      if (current.id !== 'official') {
        return deps.service.setActive(current.id, { accent: current.accent });
      }
      return deps.service.getState();
    },

    diagnostics: async (
      event: Pick<IpcMainInvokeEvent, 'sender' | 'senderFrame'>,
    ): Promise<SurfaceThemeDiagnostics> => {
      assertAuthorized(event);
      return deps.service.getDiagnostics(deps.getDiagnosticsMeta());
    },
  };
}

/**
 * Register the `surfaceTheme:*` IPC handlers on `ipcMain`.
 */
export function registerSurfaceThemeIpc(deps: SurfaceThemeIpcDependencies): () => void {
  const handlers = createSurfaceThemeIpcHandlers(deps);
  const channels = [
    [SURFACE_THEME_IPC.get, handlers.get],
    [SURFACE_THEME_IPC.apply, handlers.apply],
    [SURFACE_THEME_IPC.revert, handlers.revert],
    [SURFACE_THEME_IPC.accent, handlers.accent],
    [SURFACE_THEME_IPC.consent, handlers.consent],
    [SURFACE_THEME_IPC.diagnostics, handlers.diagnostics],
  ] as const;

  for (const [channel, fn] of channels) {
    ipcMain.removeHandler(channel);
    ipcMain.handle(channel, fn as Parameters<typeof ipcMain.handle>[1]);
  }

  return () => {
    for (const [channel] of channels) {
      ipcMain.removeHandler(channel);
    }
  };
}
