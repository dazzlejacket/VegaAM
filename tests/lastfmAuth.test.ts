/**
 * Cross-platform regression tests for the Last.fm repair.
 *
 * Every test in this file runs unchanged on Windows, macOS and Linux: the
 * failures these tests guard against were platform independent (a missing
 * credential pair, a state broadcast that overwrote the typed value, a
 * session that was never restored) and they must not come back on any
 * platform.
 */

import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { LASTFM_ERROR, LastFmService } from '../src/core/scrobble/lastfm';
import { resolveLastFmCredentials } from '../src/core/scrobble/lastfmCredentials';
import type { HttpClient } from '../src/core/scrobble/types';
import { classifySecretBackend, describeSecretStorage } from '../src/core/secrets/storage';
import { DraftFieldRegistry } from '../src/core/settings/draftFields';
import { SettingsStore } from '../src/main/settingsStore';
import { startLoopbackAuthServer } from '../src/main/lastfmAuthServer';

const tempDirs: string[] = [];

function makeTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'vegaam-lastfm-'));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tempDirs.length) {
    const dir = tempDirs.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

function mockHttp(
  responses: { status?: number; body: string }[],
): { http: HttpClient; bodies: URLSearchParams[] } {
  const bodies: URLSearchParams[] = [];
  let index = 0;
  const http: HttpClient = async (_url, init) => {
    bodies.push(new URLSearchParams(init?.body));
    const response = responses[Math.min(index, responses.length - 1)] ?? { body: '{}' };
    index += 1;
    return {
      ok: (response.status ?? 200) < 400,
      status: response.status ?? 200,
      text: async () => response.body,
    };
  };
  return { http, bodies };
}

describe('Last.fm credential resolution', () => {
  it('uses the built-in application credentials when the user supplied nothing', () => {
    const resolved = resolveLastFmCredentials({
      buildApiKey: 'built-in-key',
      buildApiSecret: 'built-in-secret',
    });
    expect(resolved).toMatchObject({
      apiKey: 'built-in-key',
      apiSecret: 'built-in-secret',
      source: 'build',
      usable: true,
    });
  });

  it('prefers a complete user supplied key pair', () => {
    const resolved = resolveLastFmCredentials({
      userApiKey: 'user-key',
      userApiSecret: 'user-secret',
      buildApiKey: 'built-in-key',
      buildApiSecret: 'built-in-secret',
    });
    expect(resolved).toMatchObject({
      apiKey: 'user-key',
      apiSecret: 'user-secret',
      source: 'user',
    });
  });

  it('falls back to the built-in pair when the user key pair is incomplete', () => {
    // A half configured pair would break every signed request.
    const resolved = resolveLastFmCredentials({
      userApiKey: 'user-key',
      buildApiKey: 'built-in-key',
      buildApiSecret: 'built-in-secret',
    });
    expect(resolved.source).toBe('build');
    expect(resolved.apiKey).toBe('built-in-key');
  });

  it('reports that no credentials are available instead of failing later', () => {
    const resolved = resolveLastFmCredentials({});
    expect(resolved.usable).toBe(false);
    expect(resolved.source).toBe('none');
  });

  it('ignores surrounding whitespace in the stored credentials', () => {
    const resolved = resolveLastFmCredentials({
      userApiKey: '  user-key ',
      userApiSecret: ' user-secret  ',
    });
    expect(resolved.apiKey).toBe('user-key');
    expect(resolved.apiSecret).toBe('user-secret');
  });
});

describe('Last.fm desktop authorization', () => {
  it('builds an authorization URL that returns to the application', () => {
    const service = new LastFmService({ apiKey: 'key', apiSecret: 'secret' });
    const url = new URL(service.getAuthUrl('token-123', 'http://127.0.0.1:5321/callback'));
    expect(url.origin + url.pathname).toBe('https://www.last.fm/api/auth/');
    expect(url.searchParams.get('api_key')).toBe('key');
    expect(url.searchParams.get('token')).toBe('token-123');
    expect(url.searchParams.get('cb')).toBe('http://127.0.0.1:5321/callback');
  });

  it('stores the session and exposes the connected account name', async () => {
    const { http } = mockHttp([
      { body: JSON.stringify({ session: { key: 'session-key', name: 'listener' } }) },
    ]);
    const service = new LastFmService({ apiKey: 'key', apiSecret: 'secret', http });
    const result = await service.getSession('token');
    expect(result.ok).toBe(true);
    expect(service.session).toBe('session-key');
    expect(service.username).toBe('listener');
  });

  it('reports the real account name when the stored session is verified', async () => {
    const { http } = mockHttp([{ body: JSON.stringify({ user: { name: 'real-user' } }) }]);
    const service = new LastFmService({
      apiKey: 'key',
      apiSecret: 'secret',
      sessionKey: 'session-key',
      http,
    });
    const status = await service.verify();
    expect(status.authorized).toBe(true);
    expect(status.account).toBe('real-user');
  });

  it('surfaces the Last.fm error code when the session was rejected', async () => {
    const { http } = mockHttp([
      { body: JSON.stringify({ error: LASTFM_ERROR.invalidSessionKey, message: 'Invalid session key' }) },
    ]);
    const service = new LastFmService({
      apiKey: 'key',
      apiSecret: 'secret',
      sessionKey: 'dead-session',
      http,
    });
    const status = await service.verify();
    expect(status.authorized).toBe(false);
    expect(status.errorCode).toBe(LASTFM_ERROR.invalidSessionKey);
    expect(status.lastError).toBe('Invalid session key');
  });

  it('never signs an authorization call with a session key', async () => {
    const { http, bodies } = mockHttp([
      { body: JSON.stringify({ token: 'request-token' }) },
      { body: JSON.stringify({ session: { key: 'session-key', name: 'listener' } }) },
    ]);
    const service = new LastFmService({ apiKey: 'key', apiSecret: 'secret', http });
    await service.getToken();
    await service.getSession('request-token');
    expect(bodies.every((body) => !body.has('sk'))).toBe(true);
  });
});

describe('Last.fm loopback callback', () => {
  it('receives the approved token from the browser redirect', async () => {
    const server = await startLoopbackAuthServer();
    try {
      expect(server.url.startsWith('http://127.0.0.1:')).toBe(true);
      const response = await fetch(`${server.url}?token=approved-token`);
      expect(response.status).toBe(200);
      await expect(server.waitForToken(5000)).resolves.toBe('approved-token');
    } finally {
      await server.close();
    }
  });

  it('rejects when the user denied the request', async () => {
    const server = await startLoopbackAuthServer();
    try {
      await fetch(`${server.url}?error=denied`);
      await expect(server.waitForToken(5000)).rejects.toThrow(/denied/i);
    } finally {
      await server.close();
    }
  });

  it('ignores a callback without a valid token and keeps waiting', async () => {
    const server = await startLoopbackAuthServer();
    try {
      // A browser prefetch, a security scanner or a stray tab must not kill a
      // pending authorization.
      const stray = await fetch(`${server.url}`);
      expect(stray.status).toBe(400);
      const malformed = await fetch(`${server.url}?token=%3Cnot-a-token%3E`);
      expect(malformed.status).toBe(400);

      const pending = server.waitForToken(5000);
      const state = await Promise.race([
        pending.then(
          () => 'resolved' as const,
          () => 'rejected' as const,
        ),
        new Promise<'pending'>((resolve) => setTimeout(() => resolve('pending'), 400)),
      ]);
      expect(state).toBe('pending');

      // The real approval still arrives afterwards.
      const approved = await fetch(`${server.url}?token=approved-token`);
      expect(approved.status).toBe(200);
      await expect(pending).resolves.toBe('approved-token');
    } finally {
      await server.close();
    }
  });

  it('rejects when the authorization is cancelled', async () => {
    const server = await startLoopbackAuthServer();
    await server.close();
    await expect(server.waitForToken(5000)).rejects.toThrow(/cancelled/i);
  });
});

describe('settings persistence for the Last.fm API key', () => {
  it('keeps the typed API key across a restart', async () => {
    const dir = makeTempDir();
    const first = new SettingsStore(dir);
    await first.load();
    await first.patch({ lastfmApiKey: 'typed-api-key' });

    // A restart: a completely new store reads the same profile.
    const second = new SettingsStore(dir);
    const settings = await second.load();
    expect(settings.lastfmApiKey).toBe('typed-api-key');
  });

  it('writes the API key to the profile file instead of keeping it in memory', async () => {
    const dir = makeTempDir();
    const store = new SettingsStore(dir);
    await store.load();
    await store.patch({ lastfmApiKey: 'persisted-key' });
    const raw = JSON.parse(readFileSync(join(dir, 'settings.json'), 'utf8'));
    expect(raw.lastfmApiKey).toBe('persisted-key');
  });

  it('keeps the shared secret out of the settings file', async () => {
    const dir = makeTempDir();
    const store = new SettingsStore(dir);
    await store.load();
    await store.patch({ lastfmApiKey: 'public-key' });
    const raw = JSON.parse(readFileSync(join(dir, 'settings.json'), 'utf8'));
    // The legacy field may still exist, but it must never carry secret
    // material - the shared secret belongs in the encrypted secret store.
    expect(raw.lastfmApiSecret ?? '').toBe('');
  });
});

describe('draft fields survive the state broadcast', () => {
  it('does not let a remote update overwrite what the user is typing', () => {
    const registry = new DraftFieldRegistry();
    registry.type('acc-lfm-key', 'half-typed');
    expect(registry.blocksRemote('acc-lfm-key')).toBe(true);
    expect(registry.display('acc-lfm-key', 'stored-key')).toBe('half-typed');
  });

  it('returns the typed value when the field is committed', () => {
    const registry = new DraftFieldRegistry();
    registry.type('acc-lfm-key', 'typed-key');
    expect(registry.commit('acc-lfm-key')).toBe('typed-key');
    // The save is still in flight, so a remote update must not overwrite it.
    expect(registry.blocksRemote('acc-lfm-key')).toBe(true);
    registry.confirm('acc-lfm-key', 'typed-key');
    expect(registry.blocksRemote('acc-lfm-key')).toBe(false);
  });

  it('does not save the same value twice', () => {
    const registry = new DraftFieldRegistry();
    registry.type('acc-lfm-key', 'typed-key');
    registry.commit('acc-lfm-key');
    registry.confirm('acc-lfm-key', 'typed-key');
    registry.type('acc-lfm-key', 'typed-key');
    expect(registry.commit('acc-lfm-key')).toBeNull();
  });

  it('keeps the typed text when the save failed', () => {
    const registry = new DraftFieldRegistry();
    registry.type('acc-lfm-key', 'typed-key');
    registry.commit('acc-lfm-key');
    registry.reject('acc-lfm-key');
    expect(registry.display('acc-lfm-key', 'old-key')).toBe('typed-key');
    expect(registry.commit('acc-lfm-key')).toBe('typed-key');
  });

  it('accepts the remote value again once the field is untouched', () => {
    const registry = new DraftFieldRegistry();
    expect(registry.blocksRemote('acc-lfm-key')).toBe(false);
    expect(registry.display('acc-lfm-key', 'stored-key')).toBe('stored-key');
  });
});

describe('credential storage diagnostics per platform', () => {
  it('reports DPAPI on Windows', () => {
    expect(classifySecretBackend('win32', null)).toBe('dpapi');
  });

  it('reports the Keychain on macOS', () => {
    expect(classifySecretBackend('darwin', null)).toBe('keychain');
  });

  it('reports the Linux key ring backends', () => {
    expect(classifySecretBackend('linux', 'gnome_libsecret')).toBe('gnome_libsecret');
    expect(classifySecretBackend('linux', 'kwallet')).toBe('kwallet');
    expect(classifySecretBackend('linux', 'basic_text')).toBe('basic_text');
    expect(classifySecretBackend('linux', null)).toBe('unknown');
  });

  it('marks the weak Linux fallback as not strong but still persistent', () => {
    const status = describeSecretStorage({ available: true, backend: 'basic_text' });
    expect(status.strong).toBe(false);
    expect(status.persistent).toBe(true);
    expect(status.detail).toMatch(/key ring/i);
  });

  it('marks the macOS Keychain as strong and persistent', () => {
    const status = describeSecretStorage({ available: true, backend: 'keychain' });
    expect(status.strong).toBe(true);
    expect(status.persistent).toBe(true);
    expect(status.detail).toMatch(/keychain/i);
  });

  it('reports that secrets do not survive a restart without encryption', () => {
    const status = describeSecretStorage({ available: false, backend: 'unknown' });
    expect(status.persistent).toBe(false);
    expect(status.detail).toMatch(/memory only/i);
  });
});
