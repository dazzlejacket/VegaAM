/**
 * The Last.fm desktop authorization handshake - as a pure module.
 *
 * The Last.fm API has no grant flow: the user approves the request in a
 * browser, and the application exchanges the approved request token for a
 * session key. Two facts shape this implementation:
 *
 *   1. The browser answers through the **loopback callback**, which is the
 *      fast path. The **polling fallback** exists for browsers that ignore
 *      the callback redirect.
 *   2. A Last.fm **request token expires** (the service then answers with
 *      error `4` - "this token has not been issued"). A user who has to sign
 *      in first can easily take longer than that, so the handshake **renews
 *      the request token** instead of failing with a cryptic message.
 *
 * The module is deliberately free of Electron and of the network so the whole
 * state machine is regression tested on every platform.
 */

import { LASTFM_ERROR } from './lastfm';

/** Last.fm error code: the request token is valid but was not approved yet. */
export const LASTFM_TOKEN_NOT_AUTHORIZED = LASTFM_ERROR.tokenNotAuthorized;

/** Last.fm error code: the request token is unknown - it expired. */
export const LASTFM_TOKEN_EXPIRED = LASTFM_ERROR.tokenExpired;

export interface TokenResult {
  ok: boolean;
  token?: string;
  error?: string;
  errorCode?: number;
}

export interface SessionCheckResult {
  ok: boolean;
  /**
   * The session key, when the request token was approved.
   *
   * A Last.fm request token is **single use**: `auth.getSession` consumes it.
   * The check therefore hands the session on directly, so the handshake never
   * exchanges the same token twice.
   */
  sessionKey?: string;
  account?: string;
  error?: string;
  errorCode?: number;
}

export interface SessionExchangeResult {
  ok: boolean;
  sessionKey?: string;
  account?: string;
  error?: string;
  errorCode?: number;
}

export interface AuthorizationDependencies {
  /**
   * The request token that was already issued for this attempt.
   *
   * The caller owns the first request: asking Last.fm for a second token
   * would make the first one invalid, so the handshake only renews the token
   * when it actually expired.
   */
  initialToken: string;
  /** Ask Last.fm for a fresh request token (used to renew an expired one). */
  requestToken(): Promise<TokenResult>;
  /** Ask Last.fm whether the request token has been approved. */
  checkSession(token: string): Promise<SessionCheckResult>;
  /** Exchange an approved request token for a session key. */
  exchangeSession(token: string): Promise<SessionExchangeResult>;
  /**
   * Wait for the token the browser returned through the loopback callback.
   *
   * The callback may deliver a **stale** token - the user can still have an
   * old page open from a previous attempt. Such a token must be ignored, so
   * the handshake passes an `accept` predicate.
   */
  waitForCallback(accept: (token: string) => boolean): Promise<string>;
}

export interface AuthorizationOptions {
  /** How long the whole handshake may take. */
  timeoutMs: number;
  /** How often the fallback polls Last.fm. */
  pollIntervalMs?: number;
  /** How often an expired request token may be renewed. */
  maxRefreshes?: number;
  /** Called whenever the request token had to be renewed. */
  onTokenRenewed?: (token: string) => void;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

export interface AuthorizationOutcome {
  ok: boolean;
  /** The approved request token, when the handshake succeeded. */
  token?: string;
  sessionKey?: string;
  account?: string;
  error?: string;
  errorCode?: number;
  /** True when the request token had to be renewed during the handshake. */
  renewed: boolean;
  /** How often the request token was renewed. */
  renewals: number;
}

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Run the handshake until it succeeds, the token expires for good or the
 * timeout is reached.
 */
export async function runAuthorizationHandshake(
  deps: AuthorizationDependencies,
  options: AuthorizationOptions,
): Promise<AuthorizationOutcome> {
  const now = options.now ?? (() => Date.now());
  const sleep = options.sleep ?? defaultSleep;
  const pollIntervalMs = options.pollIntervalMs ?? 5_000;
  const maxRefreshes = options.maxRefreshes ?? 3;
  const deadline = now() + options.timeoutMs;

  let renewals = 0;
  let renewed = false;

  let currentToken = deps.initialToken;

  // The callback may deliver a token from an older attempt - it is only
  // accepted when it is the token that is currently pending.
  let callbackToken: string | undefined;
  let callbackError: Error | undefined;
  void deps
    .waitForCallback((token) => token === currentToken)
    .then(
      (token) => {
        callbackToken = token;
      },
      (error: Error) => {
        callbackError = error;
      },
    );

  const exchange = async (token: string): Promise<AuthorizationOutcome> => {
    // The polling fallback may already have exchanged the token. A Last.fm
    // request token is single use, so it must never be exchanged twice.
    const session = await deps.exchangeSession(token);
    if (!session.ok || !session.sessionKey) {
      return {
        ok: false,
        error: session.error ?? 'Last.fm did not authorize the request.',
        errorCode: session.errorCode,
        renewed,
        renewals,
      };
    }
    return {
      ok: true,
      token,
      sessionKey: session.sessionKey,
      account: session.account,
      renewed,
      renewals,
    };
  };

  while (now() < deadline) {
    if (callbackToken) return exchange(callbackToken);
    if (callbackError) {
      return {
        ok: false,
        error: callbackError.message,
        renewed,
        renewals,
      };
    }

    const polled = await deps.checkSession(currentToken);
    if (polled.ok && polled.sessionKey) {
      // The token was approved: the session it returned is the result.
      return {
        ok: true,
        token: currentToken,
        sessionKey: polled.sessionKey,
        account: polled.account,
        renewed,
        renewals,
      };
    }

    if (polled.errorCode === LASTFM_TOKEN_EXPIRED) {
      // The request token expired before the user approved it. A fresh token
      // keeps the flow alive instead of failing with "not been issued".
      if (renewals >= maxRefreshes) {
        return {
          ok: false,
          error:
            'The Last.fm authorization request expired before it was approved. Connect again.',
          errorCode: polled.errorCode,
          renewed,
          renewals,
        };
      }
      const refreshed = await deps.requestToken();
      if (!refreshed.ok || !refreshed.token) {
        return {
          ok: false,
          error:
            refreshed.error ??
            'The Last.fm authorization request expired before it was approved. Connect again.',
          errorCode: refreshed.errorCode ?? polled.errorCode,
          renewed,
          renewals,
        };
      }
      renewals += 1;
      renewed = true;
      currentToken = refreshed.token;
      options.onTokenRenewed?.(currentToken);
      continue;
    }

    if (
      polled.errorCode !== undefined &&
      polled.errorCode !== LASTFM_TOKEN_NOT_AUTHORIZED
    ) {
      return {
        ok: false,
        error: polled.error ?? 'Last.fm rejected the authorization request.',
        errorCode: polled.errorCode,
        renewed,
        renewals,
      };
    }

    await sleep(pollIntervalMs);
  }

  if (callbackToken) return exchange(callbackToken);
  if (callbackError) {
    return { ok: false, error: callbackError.message, renewed, renewals };
  }

  return {
    ok: false,
    error: 'The Last.fm authorization timed out. Connect again and approve the request in the browser.',
    renewed,
    renewals,
  };
}
