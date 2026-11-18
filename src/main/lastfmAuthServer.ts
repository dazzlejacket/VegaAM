/**
 * Loopback callback server for the Last.fm desktop authorization handshake.
 *
 * The official Last.fm authentication flow redirects the browser back to the
 * application once the user approved the request. Desktop applications
 * therefore register a `cb` (callback) URL that points at a short lived HTTP
 * server on the loopback interface.
 *
 * The server only ever binds to `127.0.0.1`, answers a single request and
 * shuts down again, so it is not reachable from the network.
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { AddressInfo } from 'node:net';

export interface LoopbackAuthServer {
  /** The callback URL that has to be handed to Last.fm. */
  readonly url: string;
  /** The port the server listens on. */
  readonly port: number;
  /**
   * Wait for the approved request token.
   *
   * Resolves with the token, or rejects when the user denied the request, the
   * timeout expired or the server was closed.
   *
   * @param timeoutMs How long to wait for the token.
   * @param accept Optional predicate: a token that is not accepted is kept and
   *   does not end the wait. The handshake uses it to ignore a **stale**
   *   token from an older browser tab.
   */
  waitForToken(timeoutMs?: number, accept?: (token: string) => boolean): Promise<string>;
  /** Stop the server. */
  close(): Promise<void>;
}

/** Last.fm request tokens are short opaque strings. */
const TOKEN_PATTERN = /^[A-Za-z0-9._-]{4,128}$/;

/** Default time the application waits for the browser approval. */
export const LASTFM_AUTHORIZATION_TIMEOUT_MS = 13 * 60_000;

/**
 * The approval is the one human step of the handshake: the browser may have
 * to sign in to Last.fm first, which takes longer than a plain click.
 *
 * The timeout can therefore be raised with an environment variable, which the
 * acceptance harness uses while a human approves the request.
 */
export function lastFmAuthorizationTimeoutMs(): number {
  const raw = Number(process.env.VEGAAM_LASTFM_AUTH_TIMEOUT_MS);
  return Number.isFinite(raw) && raw > 0 ? raw : LASTFM_AUTHORIZATION_TIMEOUT_MS;
}

const SUCCESS_PAGE = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>VegaAM &middot; Last.fm connected</title>
    <style>
      body {
        margin: 0;
        min-height: 100vh;
        display: grid;
        place-items: center;
        background: #0d1016;
        color: #e8ecf4;
        font-family: system-ui, -apple-system, "Segoe UI", sans-serif;
      }
      main { text-align: center; padding: 2rem; }
      h1 { font-size: 1.4rem; margin: 0 0 0.5rem; }
      p { margin: 0; color: #98a2b8; }
      .mark { font-size: 2rem; color: #5b8cff; }
    </style>
  </head>
  <body>
    <main>
      <div class="mark">&#10022;</div>
      <h1>VegaAM is connected to Last.fm</h1>
      <p>You can close this tab and return to VegaAM.</p>
    </main>
  </body>
</html>`;

const FAILURE_PAGE = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <title>VegaAM &middot; Last.fm authorization failed</title>
    <style>
      body {
        margin: 0;
        min-height: 100vh;
        display: grid;
        place-items: center;
        background: #0d1016;
        color: #e8ecf4;
        font-family: system-ui, -apple-system, "Segoe UI", sans-serif;
      }
      main { text-align: center; padding: 2rem; }
      h1 { font-size: 1.4rem; margin: 0 0 0.5rem; }
      p { margin: 0; color: #98a2b8; }
      .mark { font-size: 2rem; color: #ff6b6b; }
    </style>
  </head>
  <body>
    <main>
      <div class="mark">&#10022;</div>
      <h1>Last.fm authorization was not completed</h1>
      <p>Return to VegaAM and try again.</p>
    </main>
  </body>
</html>`;

function respond(response: ServerResponse, status: number, body: string): void {
  response.writeHead(status, {
    'Content-Type': 'text/html; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  response.end(body);
}

/**
 * Start the loopback callback server.
 *
 * The server resolves once - with the approved token - and can then be
 * closed.
 */
export async function startLoopbackAuthServer(): Promise<LoopbackAuthServer> {
  // Tokens that arrived while nobody was waiting for them.
  const received: string[] = [];
  const waiters: Array<{
    accept?: (token: string) => boolean;
    resolve: (token: string) => void;
    reject: (error: Error) => void;
    timer: NodeJS.Timeout;
  }> = [];
  let failure: Error | undefined;

  const deliver = (token: string): void => {
    for (const waiter of waiters) {
      if (waiter.accept && !waiter.accept(token)) continue;
      waiters.splice(waiters.indexOf(waiter), 1);
      clearTimeout(waiter.timer);
      waiter.resolve(token);
      return;
    }
    received.push(token);
  };

  const fail = (error: Error): void => {
    if (failure) return;
    failure = error;
    for (const waiter of waiters.splice(0)) {
      clearTimeout(waiter.timer);
      waiter.reject(error);
    }
  };

  const server: Server = createServer((request: IncomingMessage, response: ServerResponse) => {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1');
    const token = url.searchParams.get('token');
    const error = url.searchParams.get('error');

    // An explicit denial from Last.fm ends the handshake.
    if (error) {
      respond(response, 400, FAILURE_PAGE);
      fail(new Error(error));
      return;
    }

    // Only a well formed token is an approval.
    if (token && TOKEN_PATTERN.test(token)) {
      respond(response, 200, SUCCESS_PAGE);
      deliver(token);
      return;
    }

    // Everything else - a browser prefetch, a security scanner, a stray tab
    // that happens to hit the port - is ignored on purpose: a pending
    // authorization must not be killed by a request that carries no approval.
    respond(response, 400, FAILURE_PAGE);
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });

  const address = server.address() as AddressInfo | null;
  const port = address?.port ?? 0;
  const url = `http://127.0.0.1:${port}/callback`;

  return {
    url,
    port,
    async waitForToken(
      timeoutMs = 5 * 60_000,
      accept?: (token: string) => boolean,
    ): Promise<string> {
      // A token that already arrived may satisfy this waiter.
      const index = received.findIndex((token) => !accept || accept(token));
      if (index >= 0) {
        const [token] = received.splice(index, 1);
        if (token) return token;
      }
      if (failure) throw failure;

      return new Promise<string>((resolve, reject) => {
        const waiter = {
          accept,
          resolve,
          reject,
          timer: setTimeout(() => {
            const at = waiters.indexOf(waiter);
            if (at >= 0) waiters.splice(at, 1);
            reject(
              new Error(
                'The Last.fm authorization timed out. Connect again and approve the request in the browser.',
              ),
            );
          }, timeoutMs),
        };
        waiters.push(waiter);
      });
    },
    async close(): Promise<void> {
      fail(new Error('The Last.fm authorization was cancelled.'));
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections?.();
      });
    },
  };
}
