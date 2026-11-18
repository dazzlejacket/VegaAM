import { describe, expect, it, vi } from 'vitest';
import type { BrowserWindow, IpcMainInvokeEvent } from 'electron';

import type { SurfaceThemeId, SurfaceThemeState } from '../src/core/surfaceTheme/types';
import {
  createSurfaceThemeIpcHandlers,
  isAuthorizedSurfaceThemeSender,
} from '../src/main/surfaceThemeIpc';
import {
  SurfaceThemeService,
  isThemeableSiriusXmUrl,
} from '../src/main/surfaceThemeService';

function createFakeOfficialWindow(initialUrl = 'https://www.siriusxm.com/player/home') {
  let currentUrl = initialUrl;
  let keyCounter = 0;
  const events: string[] = [];

  const insertCSS = vi.fn(async (_css: string, options?: { cssOrigin?: string }) => {
    keyCounter += 1;
    const key = `css-key-${keyCounter}`;
    events.push(`insert:${key}:${options?.cssOrigin ?? 'author'}`);
    return key;
  });

  const removeInsertedCSS = vi.fn(async (key: string) => {
    events.push(`remove:${key}`);
  });

  const executeJavaScript = vi.fn();
  const loadURL = vi.fn();
  const reload = vi.fn();
  const setAudioMuted = vi.fn();

  const webContents = {
    getURL: () => currentUrl,
    insertCSS,
    removeInsertedCSS,
    executeJavaScript,
    loadURL,
    reload,
    setAudioMuted,
  };

  const win = {
    isDestroyed: () => false,
    webContents,
  } as unknown as BrowserWindow;

  return {
    win,
    webContents,
    events,
    setUrl: (url: string) => {
      currentUrl = url;
    },
  };
}

describe('SurfaceThemeService & IPC (M2)', () => {
  it('accurately classifies themeable player URLs vs excluded login/account/checkout URLs', () => {
    expect(isThemeableSiriusXmUrl('https://www.siriusxm.com/player')).toBe(true);
    expect(isThemeableSiriusXmUrl('https://www.siriusxm.com/player/home')).toBe(true);
    expect(isThemeableSiriusXmUrl('https://www.siriusxm.com/player/music')).toBe(true);
    expect(isThemeableSiriusXmUrl('https://player.siriusxm.com/home')).toBe(true);

    // Excluded routes
    expect(isThemeableSiriusXmUrl('https://www.siriusxm.com/player/login')).toBe(false);
    expect(isThemeableSiriusXmUrl('https://www.siriusxm.com/player/welcome')).toBe(false);
    expect(isThemeableSiriusXmUrl('https://www.siriusxm.com/player/signin')).toBe(false);
    expect(isThemeableSiriusXmUrl('https://www.siriusxm.com/account')).toBe(false);
    expect(isThemeableSiriusXmUrl('https://www.siriusxm.com/checkout')).toBe(false);
    expect(isThemeableSiriusXmUrl('https://login.siriusxm.com/oauth')).toBe(false);
    expect(isThemeableSiriusXmUrl('https://care.siriusxm.com/billing')).toBe(false);
    expect(isThemeableSiriusXmUrl('http://www.siriusxm.com/player')).toBe(false);
    expect(isThemeableSiriusXmUrl('https://evil.example.com/player')).toBe(false);
  });

  it('inserts with cssOrigin:user, inserts new before removing old key, and never calls executeJavaScript/reload', async () => {
    const fake = createFakeOfficialWindow();
    const states: SurfaceThemeState[] = [];
    let storedId: SurfaceThemeId = 'official';
    let storedAccent: string | null = null;

    const service = new SurfaceThemeService({
      getWindow: () => fake.win,
      getConsent: () => true,
      getSettings: () => ({ id: storedId, accent: storedAccent }),
      onStateChange: (state) => states.push(state),
      now: () => 1700000000000,
    });

    storedId = 'catppuccin';
    const state1 = await service.setActive('catppuccin');
    expect(state1.activeId).toBe('catppuccin');
    expect(state1.applied).toBe(true);
    expect(state1.cssBytes).toBeGreaterThan(80_000);
    expect(fake.webContents.insertCSS).toHaveBeenCalledTimes(1);

    // Switch to gruvbox: must insert key 2 BEFORE removing key 1
    storedId = 'gruvbox';
    const state2 = await service.setActive('gruvbox');
    expect(state2.activeId).toBe('gruvbox');
    expect(state2.applied).toBe(true);
    expect(fake.events).toEqual([
      'insert:css-key-1:user',
      'insert:css-key-2:user',
      'remove:css-key-1',
    ]);

    // Revert removes key 2
    storedId = 'official';
    const reverted = await service.revert('test');
    expect(reverted.activeId).toBe('official');
    expect(reverted.applied).toBe(false);
    expect(fake.events).toEqual([
      'insert:css-key-1:user',
      'insert:css-key-2:user',
      'remove:css-key-1',
      'remove:css-key-2',
    ]);

    // Invariant spies
    expect(fake.webContents.executeJavaScript).not.toHaveBeenCalled();
    expect(fake.webContents.loadURL).not.toHaveBeenCalled();
    expect(fake.webContents.reload).not.toHaveBeenCalled();
    expect(fake.webContents.setAudioMuted).not.toHaveBeenCalled();
  });

  it('clears key on did-navigate without calling removeInsertedCSS, and re-applies on dom-ready', async () => {
    const fake = createFakeOfficialWindow();
    let storedId: SurfaceThemeId = 'dracula';

    const service = new SurfaceThemeService({
      getWindow: () => fake.win,
      getConsent: () => true,
      getSettings: () => ({ id: storedId, accent: null }),
    });

    await service.setActive('dracula');
    expect(fake.events).toEqual(['insert:css-key-1:user']);

    // Full navigation replaces document
    service.onDocumentReplaced();
    expect(service.getState().applied).toBe(false);
    expect(fake.webContents.removeInsertedCSS).not.toHaveBeenCalled();

    // dom-ready re-applies
    await service.onDomReady('https://www.siriusxm.com/player/home');
    expect(service.getState().applied).toBe(true);
    expect(service.getState().activeId).toBe('dracula');
    expect(fake.events).toEqual([
      'insert:css-key-1:user',
      'insert:css-key-2:user',
    ]);
  });

  it('skips and pauses theming on auth/login/welcome routes and resumes on player routes', async () => {
    const fake = createFakeOfficialWindow('https://www.siriusxm.com/player/home');
    const service = new SurfaceThemeService({
      getWindow: () => fake.win,
      getConsent: () => true,
      getSettings: () => ({ id: 'nord', accent: null }),
    });

    await service.setActive('nord');
    expect(service.getState().applied).toBe(true);

    // In-page redirect to /player/login removes CSS and marks pausedOnAuth
    fake.setUrl('https://www.siriusxm.com/player/login');
    await service.onInPageNavigate('https://www.siriusxm.com/player/login');
    expect(service.getState().applied).toBe(false);
    expect(service.getState().pausedOnAuth).toBe(true);
    expect(fake.events).toContain('remove:css-key-1');

    // Returning to /player/home re-applies automatically
    fake.setUrl('https://www.siriusxm.com/player/home');
    await service.onInPageNavigate('https://www.siriusxm.com/player/home');
    expect(service.getState().applied).toBe(true);
    expect(service.getState().pausedOnAuth).toBe(false);
  });

  it('reverts to Official and reports lastError if insertCSS fails', async () => {
    const fake = createFakeOfficialWindow();
    fake.webContents.insertCSS.mockRejectedValueOnce(new Error('Simulated Chromium CSS failure'));

    const service = new SurfaceThemeService({
      getWindow: () => fake.win,
      getConsent: () => true,
      getSettings: () => ({ id: 'vega', accent: null }),
    });

    const state = await service.setActive('vega');
    expect(state.activeId).toBe('official');
    expect(state.applied).toBe(false);
    expect(state.lastError).toContain('Simulated Chromium CSS failure');
  });

  it('validates IPC senders and enforces the one-time consent dialog gate', async () => {
    const fakeOfficial = createFakeOfficialWindow();
    const fakeSettingsMainFrame = { url: 'file:///C:/app/dist/renderer/settings.html' };
    const fakeSettingsContents = { mainFrame: fakeSettingsMainFrame };
    const fakeSettingsWin = {
      isDestroyed: () => false,
      webContents: fakeSettingsContents,
    } as unknown as BrowserWindow;

    expect(
      isAuthorizedSurfaceThemeSender(
        { sender: fakeSettingsContents, senderFrame: fakeSettingsMainFrame } as unknown as IpcMainInvokeEvent,
        [fakeSettingsWin],
        fakeOfficial.win,
      ),
    ).toBe(true);

    // Reject official window sender
    expect(
      isAuthorizedSurfaceThemeSender(
        {
          sender: fakeOfficial.webContents,
          senderFrame: { url: 'https://www.siriusxm.com/player' },
        } as unknown as IpcMainInvokeEvent,
        [fakeSettingsWin],
        fakeOfficial.win,
      ),
    ).toBe(false);

    // Reject non-file:// sender
    expect(
      isAuthorizedSurfaceThemeSender(
        {
          sender: fakeSettingsContents,
          senderFrame: { url: 'https://evil.example/settings.html' },
        } as unknown as IpcMainInvokeEvent,
        [fakeSettingsWin],
        fakeOfficial.win,
      ),
    ).toBe(false);

    let consent = false;
    let storedId: SurfaceThemeId = 'official';
    let storedAccent: string | null = null;
    let promptResult = false;

    const service = new SurfaceThemeService({
      getWindow: () => fakeOfficial.win,
      getConsent: () => consent,
      getSettings: () => ({ id: storedId, accent: storedAccent }),
    });

    const handlers = createSurfaceThemeIpcHandlers({
      service,
      getAllowedWindows: () => [fakeSettingsWin],
      getOfficialWindow: () => fakeOfficial.win,
      getConsent: () => consent,
      getSettings: () => ({ id: storedId, accent: storedAccent }),
      saveSurfaceSettings: async (patch) => {
        if ('surfaceThemeConsent' in patch && typeof patch.surfaceThemeConsent === 'boolean') {
          consent = patch.surfaceThemeConsent;
        }
        if ('surfaceThemeId' in patch) {
          storedId = (patch.surfaceThemeId as SurfaceThemeId | null) ?? 'official';
        }
        if ('surfaceThemeAccent' in patch) {
          storedAccent = patch.surfaceThemeAccent ?? null;
        }
      },
      getDiagnosticsMeta: () => ({ appVersion: '3.1.0', platform: 'win32' }),
      promptConsent: async () => promptResult,
    });

    const validEvent = {
      sender: fakeSettingsContents,
      senderFrame: fakeSettingsMainFrame,
    } as unknown as IpcMainInvokeEvent;

    // 1. User declines consent -> stays Official, no CSS inserted
    promptResult = false;
    const declinedState = await handlers.apply(validEvent, 'catppuccin');
    expect(declinedState.activeId).toBe('official');
    expect(declinedState.consent).toBe(false);
    expect(fakeOfficial.webContents.insertCSS).not.toHaveBeenCalled();

    // 2. User accepts consent -> persists consent and applies Catppuccin
    promptResult = true;
    const acceptedState = await handlers.apply(validEvent, 'catppuccin');
    expect(acceptedState.consent).toBe(true);
    expect(acceptedState.activeId).toBe('catppuccin');
    expect(acceptedState.applied).toBe(true);

    // 3. Apply custom accent
    const accentedState = await handlers.accent(validEvent, { id: 'catppuccin', accent: '#FF4FA3' });
    expect(accentedState.accent).toBe('#FF4FA3');
    expect(accentedState.applied).toBe(true);

    // 4. Revoke consent -> reverts to Official
    const revokedState = await handlers.consent(validEvent, false);
    expect(revokedState.consent).toBe(false);
    expect(revokedState.activeId).toBe('official');
    expect(revokedState.applied).toBe(false);

    // 5. VegaAM 3.2 default (no blocking popup modal): selecting a theme in the integrated
    //    WebContentsView drawer grants consent and applies immediately without dialog.showMessageBox
    const fakeDrawerContents = {
      isDestroyed: () => false,
      mainFrame: fakeSettingsMainFrame,
    };
    const handlersNoPopup = createSurfaceThemeIpcHandlers({
      service,
      getAllowedWindows: () => [],
      getAllowedWebContents: () => [fakeDrawerContents as unknown as Electron.WebContents],
      getOfficialWindow: () => fakeOfficial.win,
      getConsent: () => consent,
      getSettings: () => ({ id: storedId, accent: storedAccent }),
      saveSurfaceSettings: async (patch) => {
        if ('surfaceThemeConsent' in patch && typeof patch.surfaceThemeConsent === 'boolean') {
          consent = patch.surfaceThemeConsent;
        }
        if ('surfaceThemeId' in patch) {
          storedId = (patch.surfaceThemeId as SurfaceThemeId | null) ?? 'official';
        }
      },
      getDiagnosticsMeta: () => ({ appVersion: '3.2.0', platform: 'win32' }),
    });

    const drawerEvent = {
      sender: fakeDrawerContents,
      senderFrame: fakeSettingsMainFrame,
    } as unknown as IpcMainInvokeEvent;

    const directState = await handlersNoPopup.apply(drawerEvent, 'catppuccin-latte');
    expect(directState.consent).toBe(true);
    expect(directState.activeId).toBe('catppuccin-latte');
    expect(directState.applied).toBe(true);
  });
});
