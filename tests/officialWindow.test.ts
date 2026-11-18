import { mkdtempSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { BrowserWindow, IpcMainEvent } from 'electron';

import {
  OFFICIAL_PLAYER_URL,
  isAllowedSiriusXmUrl,
  isAuthUrl,
  isErrorUrl,
} from '../src/main/officialPlayer';
import { isThemeableSiriusXmUrl } from '../src/main/surfaceThemeService';
import {
  VEGAAM_AUMID,
  cleanupLegacyShortcuts,
  getWindowsLegacyPaths,
} from '../src/main/legacyInstall';
import {
  MediaBridgeReceiver,
  validatePayload,
  type MediaBridgeSnapshot,
} from '../src/main/mediaBridge';

describe('official SiriusXM URL allowlist and state classification', () => {
  it('defines the official SiriusXM player entry URL', () => {
    expect(OFFICIAL_PLAYER_URL).toBe('https://www.siriusxm.com/player');
  });

  it('allows SiriusXM player and authentication HTTPS origins', () => {
    expect(isAllowedSiriusXmUrl('https://www.siriusxm.com/player')).toBe(true);
    expect(isAllowedSiriusXmUrl('https://www.siriusxm.com/player/home')).toBe(true);
    expect(isAllowedSiriusXmUrl('https://player.siriusxm.com/home')).toBe(true);
    expect(isAllowedSiriusXmUrl('https://login.siriusxm.com/oauth')).toBe(true);
    expect(isAllowedSiriusXmUrl('https://auth.siriusxm.com/signin')).toBe(true);
    expect(isAllowedSiriusXmUrl('https://streaming.siriusxm.com/stream')).toBe(true);
  });

  it('rejects non-HTTPS, non-SiriusXM, and malformed URLs', () => {
    expect(isAllowedSiriusXmUrl('http://www.siriusxm.com/player')).toBe(false);
    expect(isAllowedSiriusXmUrl('https://siriusxm.com.evil.example/player')).toBe(false);
    expect(isAllowedSiriusXmUrl('https://example.com')).toBe(false);
    expect(isAllowedSiriusXmUrl('javascript:alert(1)')).toBe(false);
    expect(isAllowedSiriusXmUrl('not a url')).toBe(false);
  });

  it('classifies authentication and error URLs accurately', () => {
    expect(isAuthUrl('https://login.siriusxm.com/authorize')).toBe(true);
    expect(isAuthUrl('https://www.siriusxm.com/signin')).toBe(true);
    expect(isAuthUrl('https://www.siriusxm.com/player/home')).toBe(false);
    expect(isErrorUrl('chrome-error://chromewebdata/')).toBe(true);
    expect(isErrorUrl('https://www.siriusxm.com/player')).toBe(false);
  });

  it('restricts surface CSS theming strictly to non-auth SiriusXM player routes', () => {
    expect(isThemeableSiriusXmUrl('https://www.siriusxm.com/player')).toBe(true);
    expect(isThemeableSiriusXmUrl('https://www.siriusxm.com/player/home')).toBe(true);
    expect(isThemeableSiriusXmUrl('https://www.siriusxm.com/player/channel-linear/entity/123')).toBe(true);
    expect(isThemeableSiriusXmUrl('https://www.siriusxm.com/player/login')).toBe(false);
    expect(isThemeableSiriusXmUrl('https://www.siriusxm.com/player/welcome')).toBe(false);
    expect(isThemeableSiriusXmUrl('https://www.siriusxm.com/player/account')).toBe(false);
    expect(isThemeableSiriusXmUrl('https://www.siriusxm.com/player/checkout')).toBe(false);
    expect(isThemeableSiriusXmUrl('https://login.siriusxm.com/oauth')).toBe(false);
  });

  it('resolves legacy SiriusXM Desktop paths and cleans up only obsolete .lnk shortcuts', () => {
    expect(VEGAAM_AUMID).toBe('app.vegaam.desktop');
    const tempDir = mkdtempSync(join(tmpdir(), 'vegaam-legacy-test-'));
    try {
      const fakeEnv = {
        LOCALAPPDATA: join(tempDir, 'Local'),
        APPDATA: join(tempDir, 'Roaming'),
        USERPROFILE: join(tempDir, 'Profile'),
      };
      const paths = getWindowsLegacyPaths(fakeEnv);
      expect(paths.exePath).toContain('SiriusXM Desktop.exe');
      expect(paths.startMenuShortcut).toContain('SiriusXM Desktop.lnk');
      expect(paths.desktopShortcut).toContain('SiriusXM Desktop.lnk');

      if (process.platform === 'win32') {
        const desktopDir = join(tempDir, 'Profile', 'Desktop');
        const profileDataFile = join(tempDir, 'Roaming', 'SiriusXM Desktop', 'settings.json');
        const { mkdirSync } = require('node:fs');
        mkdirSync(desktopDir, { recursive: true });
        mkdirSync(join(tempDir, 'Roaming', 'SiriusXM Desktop'), { recursive: true });
        writeFileSync(paths.desktopShortcut, 'dummy-lnk');
        writeFileSync(profileDataFile, '{"preserve":true}');

        const cleaned = cleanupLegacyShortcuts(fakeEnv);
        expect(cleaned.ok).toBe(true);
        expect(cleaned.removed).toContain(paths.desktopShortcut);
        expect(existsSync(paths.desktopShortcut)).toBe(false);
        // Must NEVER touch %APPDATA%\SiriusXM Desktop user profile!
        expect(existsSync(profileDataFile)).toBe(true);
      }
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });
});

describe('mediaBridge payload validation and staleness guard', () => {
  it('validates and sanitizes incoming MediaBridgeSnapshot objects', () => {
    const valid = validatePayload(
      {
        sessionTitle: 'The Beatles Channel · The Beatles Channel',
        sessionArtist: "The Beatles - Mother Nature's Son",
        sessionAlbum: '',
        artworkUrl: 'https://imgs.siriusxm.com/art.jpg',
        playbackState: 'playing',
      },
      1700000000500,
    );

    expect(valid).toEqual({
      sessionTitle: 'The Beatles Channel · The Beatles Channel',
      sessionArtist: "The Beatles - Mother Nature's Son",
      sessionAlbum: null,
      artworkUrl: 'https://imgs.siriusxm.com/art.jpg',
      playbackState: 'playing',
      observedAt: 1700000000500,
    });
  });

  it('rejects non-HTTPS artwork URLs and truncates strings to 512 chars', () => {
    const longTitle = 'A'.repeat(600);
    const validated = validatePayload(
      {
        sessionTitle: longTitle,
        sessionArtist: 'Artist - Song',
        artworkUrl: 'http://insecure.example.com/art.jpg',
        playbackState: 'invalid-state',
      },
      1000,
    );

    expect(validated?.sessionTitle?.length).toBe(512);
    expect(validated?.artworkUrl).toBeNull();
    expect(validated?.playbackState).toBe('none');
  });

  it('rejects non-object payloads', () => {
    expect(validatePayload(null)).toBeNull();
    expect(validatePayload('string')).toBeNull();
    expect(validatePayload(42)).toBeNull();
  });

  it('enforces sender/frame/URL verification, rate limiting, deduplication, and staleness timeout', () => {
    let clock = 10_000;
    const emitted: { snapshot: MediaBridgeSnapshot; changed: boolean }[] = [];
    let staleCount = 0;

    const fakeMainFrame = { url: 'https://www.siriusxm.com/player' };
    const fakeWebContents = { mainFrame: fakeMainFrame };
    const fakeWin = {
      isDestroyed: () => false,
      webContents: fakeWebContents,
    } as unknown as BrowserWindow;

    const receiver = new MediaBridgeReceiver({
      now: () => clock,
      getWindow: () => fakeWin,
      onSnapshot: (snapshot, changed) => emitted.push({ snapshot, changed }),
      onStale: () => {
        staleCount += 1;
      },
    });

    const sample = {
      sessionTitle: 'E Street Radio · E Street Radio',
      sessionArtist: 'Bruce Springsteen - Atlantic City',
      playbackState: 'playing',
    };

    const makeEvent = (sender: unknown, senderFrame: unknown): IpcMainEvent =>
      ({ sender, senderFrame } as unknown as IpcMainEvent);

    // Rejects wrong sender or wrong frame or disallowed URL
    expect(receiver.handleIpcEvent(makeEvent({}, fakeMainFrame), sample)).toBe(false);
    expect(receiver.handleIpcEvent(makeEvent(fakeWebContents, { url: 'https://www.siriusxm.com/player' }), sample)).toBe(false);
    fakeMainFrame.url = 'https://evil.example.com';
    expect(receiver.handleIpcEvent(makeEvent(fakeWebContents, fakeMainFrame), sample)).toBe(false);

    // Accepts valid sender, mainFrame, and allowed URL
    fakeMainFrame.url = 'https://www.siriusxm.com/player';
    expect(receiver.handleIpcEvent(makeEvent(fakeWebContents, fakeMainFrame), sample)).toBe(true);
    expect(emitted).toHaveLength(1);
    expect(emitted[0]?.changed).toBe(true);

    // Rate-limits payloads arriving within 500 ms
    clock += 200;
    expect(receiver.handleIpcEvent(makeEvent(fakeWebContents, fakeMainFrame), sample)).toBe(false);

    // Marks identical semantic payloads as changed === false
    clock += 500;
    expect(receiver.handleIpcEvent(makeEvent(fakeWebContents, fakeMainFrame), sample)).toBe(true);
    expect(emitted).toHaveLength(2);
    expect(emitted[1]?.changed).toBe(false);

    // Clears and calls onStale when stale timeout (10,000 ms) expires
    clock += 11_000;
    receiver.checkStaleness();
    expect(staleCount).toBe(1);
    expect(receiver.getLatest()).toBeNull();
  });
});
