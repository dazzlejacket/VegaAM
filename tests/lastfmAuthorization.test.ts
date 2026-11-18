/**
 * The Last.fm desktop authorization handshake - platform independent.
 *
 * These tests never touch the network and never touch Electron: the state
 * machine lives in `src/core/scrobble/authorization.ts` exactly so that the
 * same behaviour is proven on Windows, macOS and Linux.
 */

import { describe, expect, it } from 'vitest';

import {
  LASTFM_TOKEN_EXPIRED,
  LASTFM_TOKEN_NOT_AUTHORIZED,
  runAuthorizationHandshake,
  type AuthorizationDependencies,
  type SessionCheckResult,
} from '../src/core/scrobble/authorization';
import { startLoopbackAuthServer } from '../src/main/lastfmAuthServer';

interface Harness {
  deps: AuthorizationDependencies;
  calls: {
    tokens: number;
    checked: string[];
    exchanged: string[];
  };
  /** The predicate the handshake uses to accept a callback token. */
  accepted(): (token: string) => boolean;
}

function harness(options: {
  /** The answers `checkSession` gives, in order; the last one repeats. */
  sessionResults?: SessionCheckResult[];
  tokens?: string[];
  callback?: 'pending' | 'delivered' | 'failed';
  callbackToken?: string;
} = {}): Harness {
  const tokens = options.tokens ?? ['token-1', 'token-2', 'token-3', 'token-4'];
  const calls: { tokens: number; checked: string[]; exchanged: string[] } = {
    tokens: 0,
    checked: [],
    exchanged: [],
  };
  const gate: { deliver?: (token: string) => void; fail?: (error: Error) => void } = {};
  let accept: (token: string) => boolean = () => true;

  const callbackPromise = new Promise<string>((resolve, reject) => {
    gate.deliver = resolve;
    gate.fail = reject;
  });
  if (options.callback === 'delivered') {
    queueMicrotask(() => gate.deliver?.(options.callbackToken ?? 'token-1'));
  } else if (options.callback === 'failed') {
    queueMicrotask(() => gate.fail?.(new Error('The user denied the request.')));
  }

  const deps: AuthorizationDependencies = {
    initialToken: tokens[0] ?? 'token-1',
    requestToken: async () => {
      calls.tokens += 1;
      return { ok: true, token: tokens[Math.min(calls.tokens, tokens.length - 1)] };
    },
    checkSession: async (token) => {
      calls.checked.push(token);
      const results = options.sessionResults ?? [];
      if (!results.length) {
        return { ok: false, errorCode: LASTFM_TOKEN_NOT_AUTHORIZED };
      }
      const result = results[Math.min(calls.checked.length - 1, results.length - 1)];
      if (!result) {
        return { ok: false, errorCode: LASTFM_TOKEN_NOT_AUTHORIZED };
      }
      // A Last.fm request token is single use: the check hands the session on.
      return result.ok
        ? { ok: true, sessionKey: 'session-key', account: 'the-user' }
        : result;
    },
    exchangeSession: async (token) => {
      calls.exchanged.push(token);
      return { ok: true, sessionKey: 'session-key', account: 'the-user' };
    },
    waitForCallback: (predicate) => {
      accept = predicate;
      return callbackPromise;
    },
  };

  return { deps, calls, accepted: () => accept };
}

describe('the Last.fm authorization handshake', () => {
  it('exchanges the approved token for a session key', async () => {
    const h = harness({ callback: 'delivered', callbackToken: 'token-1' });
    const outcome = await runAuthorizationHandshake(h.deps, {
      timeoutMs: 60_000,
      pollIntervalMs: 1,
    });

    expect(outcome.ok).toBe(true);
    expect(outcome.sessionKey).toBe('session-key');
    expect(outcome.account).toBe('the-user');
    expect(h.calls.exchanged).toContain('token-1');
  });

  it('exchanges the approved token only once', async () => {
    // A Last.fm request token is single use. When the polling fallback
    // already exchanged it, the handshake must not ask the service again -
    // the second call would answer "this token has not been issued".
    const h = harness({
      sessionResults: [{ ok: false, errorCode: LASTFM_TOKEN_NOT_AUTHORIZED }, { ok: true }],
    });

    const outcome = await runAuthorizationHandshake(h.deps, {
      timeoutMs: 60_000,
      pollIntervalMs: 1,
    });

    expect(outcome.ok).toBe(true);
    expect(outcome.sessionKey).toBe('session-key');
    // The token was never exchanged a second time.
    expect(h.calls.exchanged).toHaveLength(0);
  });

  it('keeps waiting while the token is valid but not approved yet', async () => {
    const h = harness({
      sessionResults: [
        { ok: false, errorCode: LASTFM_TOKEN_NOT_AUTHORIZED },
        { ok: false, errorCode: LASTFM_TOKEN_NOT_AUTHORIZED },
        { ok: true },
      ],
    });

    const outcome = await runAuthorizationHandshake(h.deps, {
      timeoutMs: 60_000,
      pollIntervalMs: 1,
    });

    expect(h.calls.checked).toHaveLength(3);
    expect(outcome.ok).toBe(true);
    expect(outcome.sessionKey).toBe('session-key');
  });

  it('renews the request token when Last.fm reports that it expired', async () => {
    const h = harness({
      tokens: ['token-1', 'token-2'],
      sessionResults: [
        { ok: false, errorCode: LASTFM_TOKEN_EXPIRED, error: 'has not been issued' },
        { ok: true },
      ],
    });
    const renewed: string[] = [];

    const outcome = await runAuthorizationHandshake(h.deps, {
      timeoutMs: 60_000,
      pollIntervalMs: 1,
      onTokenRenewed: (token) => renewed.push(token),
    });

    expect(outcome.ok).toBe(true);
    expect(outcome.renewed).toBe(true);
    expect(outcome.renewals).toBe(1);
    expect(renewed).toEqual(['token-2']);
    // The renewed token is the one that is checked, and its session is the
    // result - the token is never exchanged a second time.
    expect(h.calls.checked).toEqual(['token-1', 'token-2']);
    expect(h.calls.exchanged).toHaveLength(0);
  });

  it('accepts only the token that is currently pending', async () => {
    const h = harness({ tokens: ['token-1', 'token-2'] });
    await runAuthorizationHandshake(h.deps, {
      timeoutMs: 50,
      pollIntervalMs: 1,
      now: (() => {
        let clock = 0;
        return () => (clock += 10);
      })(),
      sleep: async () => undefined,
    });

    // The token of the current attempt is accepted, an older one is not.
    expect(h.accepted()('token-1')).toBe(true);
    expect(h.accepted()('token-0')).toBe(false);
  });

  it('gives up with an actionable message when the token keeps expiring', async () => {
    const h = harness({
      sessionResults: [
        { ok: false, errorCode: LASTFM_TOKEN_EXPIRED, error: 'has not been issued' },
      ],
    });

    const outcome = await runAuthorizationHandshake(h.deps, {
      timeoutMs: 60_000,
      pollIntervalMs: 1,
      maxRefreshes: 2,
    });

    expect(outcome.ok).toBe(false);
    expect(outcome.error).toMatch(/expired/i);
    expect(outcome.renewals).toBe(2);
  });

  it('reports the service error for a permanent rejection', async () => {
    const h = harness({
      sessionResults: [
        {
          ok: false,
          errorCode: 10,
          error: 'Invalid API key - You must be granted a valid API key',
        },
      ],
    });

    const outcome = await runAuthorizationHandshake(h.deps, {
      timeoutMs: 60_000,
      pollIntervalMs: 1,
    });

    expect(outcome.ok).toBe(false);
    expect(outcome.error).toMatch(/Invalid API key/);
    expect(outcome.errorCode).toBe(10);
  });

  it('reports a denial from the browser', async () => {
    const h = harness({ callback: 'failed' });
    const outcome = await runAuthorizationHandshake(h.deps, {
      timeoutMs: 60_000,
      pollIntervalMs: 1,
    });

    expect(outcome.ok).toBe(false);
    expect(outcome.error).toMatch(/denied/i);
  });

  it('times out with an actionable message', async () => {
    const h = harness();
    let clock = 0;
    const outcome = await runAuthorizationHandshake(h.deps, {
      timeoutMs: 1_000,
      pollIntervalMs: 100,
      now: () => clock,
      sleep: async (ms) => {
        clock += ms;
      },
    });

    expect(outcome.ok).toBe(false);
    expect(outcome.error).toMatch(/timed out/i);
  });
});

describe('the loopback callback and stale tokens', () => {
  it('keeps a token the caller does not accept and delivers the accepted one', async () => {
    const server = await startLoopbackAuthServer();
    try {
      const stale = await fetch(`${server.url}?token=stale-token`);
      expect(stale.status).toBe(200);

      const pending = server.waitForToken(5_000, (token) => token === 'fresh-token');

      // The waiter is still waiting for the token it accepts.
      const raced = await Promise.race([
        pending.then(
          () => 'resolved' as const,
          () => 'rejected' as const,
        ),
        new Promise<'pending'>((resolve) => setTimeout(() => resolve('pending'), 300)),
      ]);
      expect(raced).toBe('pending');

      const fresh = await fetch(`${server.url}?token=fresh-token`);
      expect(fresh.status).toBe(200);
      await expect(pending).resolves.toBe('fresh-token');
    } finally {
      await server.close();
    }
  });

  it('delivers a token that arrived before anybody waited for it', async () => {
    const server = await startLoopbackAuthServer();
    try {
      await fetch(`${server.url}?token=early-token`);
      await expect(server.waitForToken(5_000)).resolves.toBe('early-token');
    } finally {
      await server.close();
    }
  });
});
