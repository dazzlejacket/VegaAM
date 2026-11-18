/**
 * Last.fm scrobbling client.
 *
 * The official Last.fm API requires an application API key pair. VegaAM ships
 * with the VegaFM application credentials (injected at build time, see
 * `buildCredentials.ts`), so a normal user never has to create an API account.
 * A user supplied key pair still wins when both halves are present, which
 * keeps the "bring your own account" path alive for power users.
 *
 * The session key returned by the authorization handshake is a *user*
 * credential and is stored in the encrypted secret store - never in the
 * settings file and never in the renderer.
 *
 * Reference: https://www.last.fm/api/authspec
 */

import { createHash } from 'node:crypto';

import {
  defaultHttp,
  type HttpClient,
  type ScrobblePayload,
  type ScrobbleService,
  type ServiceId,
  type ServiceResult,
  type ServiceStatus,
} from './types';

const API_BASE = 'https://ws.audioscrobbler.com/2.0/';
const AUTH_BASE = 'https://www.last.fm/api/auth/';

/** Documented Last.fm API error codes that VegaAM reacts to. */
export const LASTFM_ERROR = {
  /** Invalid session key - the stored session has to be replaced. */
  invalidSessionKey: 9,
  /** Invalid API key - the application credentials are wrong. */
  invalidApiKey: 10,
  /** Invalid method signature - the shared secret does not match the key. */
  invalidMethodSignature: 13,
  /** The request token has not been authorized (yet). */
  tokenNotAuthorized: 14,
  /**
   * The request token is unknown to the service - it expired.
   *
   * Last.fm invalidates a request token after a short while, so a user who
   * needs to sign in first can easily outlive it.
   */
  tokenExpired: 4,
  /** The service rejected the request for a permanent reason. */
  invalidResource: 6,
} as const;

export interface LastFmOptions {
  apiKey?: string;
  apiSecret?: string;
  sessionKey?: string;
  http?: HttpClient;
}

export class LastFmService implements ScrobbleService {
  readonly id: ServiceId = 'lastfm';

  private apiKey: string;
  private apiSecret: string;
  private sessionKey?: string;
  private account?: string;
  private lastError?: string;
  private checkedAt?: number;
  private readonly http: HttpClient;

  constructor(options: LastFmOptions = {}) {
    this.apiKey = options.apiKey ?? '';
    this.apiSecret = options.apiSecret ?? '';
    this.sessionKey = options.sessionKey;
    this.http = options.http ?? defaultHttp;
  }

  /** True when the API key pair is present (a session is not required yet). */
  hasCredentials(): boolean {
    return Boolean(this.apiKey && this.apiSecret);
  }

  /** True when the service is ready to submit (credentials *and* session). */
  isConfigured(): boolean {
    return this.hasCredentials() && Boolean(this.sessionKey);
  }

  /**
   * Desktop authorization uses a request token, never a manually entered
   * session. When a callback URL is supplied, Last.fm redirects the browser
   * back to the application with the approved token.
   */
  getAuthUrl(token: string, callbackUrl?: string): string {
    const params = new URLSearchParams({ api_key: this.apiKey, token });
    if (callbackUrl) params.set('cb', callbackUrl);
    return `${AUTH_BASE}?${params.toString()}`;
  }

  async getToken(): Promise<ServiceResult> {
    return this.call({ method: 'auth.getToken', format: 'json' });
  }

  /** Exchange the token from the redirect for a session key. */
  async getSession(token: string): Promise<ServiceResult> {
    if (!this.apiKey || !this.apiSecret) {
      return { ok: false, error: 'A Last.fm API key and secret are required.' };
    }
    const params: Record<string, string> = {
      method: 'auth.getSession',
      api_key: this.apiKey,
      token,
      format: 'json',
    };
    const response = await this.call(params);
    if (response.ok && response.response && typeof response.response === 'object') {
      const session = (response.response as { session?: { key?: string; name?: string } }).session;
      if (session?.key) {
        this.sessionKey = session.key;
        this.account = session.name;
        this.lastError = undefined;
        this.checkedAt = Date.now();
        return { ok: true, response: response.response };
      }
    }
    return response.ok ? { ok: false, error: 'Last.fm returned no session.' } : response;
  }

  async nowPlaying(payload: ScrobblePayload): Promise<ServiceResult> {
    const params: Record<string, string> = {
      method: 'track.updateNowPlaying',
      artist: payload.artist,
      track: payload.title,
      format: 'json',
    };
    if (payload.album) params.album = payload.album;
    if (payload.durationMs) params.duration = String(Math.round(payload.durationMs / 1000));
    return this.call(params);
  }

  async scrobble(payload: ScrobblePayload): Promise<ServiceResult> {
    const params: Record<string, string> = {
      method: 'track.scrobble',
      artist: payload.artist,
      track: payload.title,
      timestamp: String(payload.timestamp),
      format: 'json',
    };
    if (payload.album) params.album = payload.album;
    if (payload.durationMs) params.duration = String(Math.round(payload.durationMs / 1000));
    return this.call(params);
  }

  async verify(): Promise<ServiceStatus> {
    if (!this.apiKey || !this.apiSecret || !this.sessionKey) {
      return {
        id: this.id,
        configured: this.hasCredentials(),
        authorized: false,
        lastError: this.lastError ?? 'Last.fm is not connected.',
        checkedAt: Date.now(),
      };
    }
    const response = await this.call({
      method: 'user.getInfo',
      format: 'json',
    });
    const user = (response.response as { user?: { name?: string } } | undefined)?.user;
    if (response.ok && user?.name) {
      this.account = user.name;
      this.lastError = undefined;
      this.checkedAt = Date.now();
      return {
        id: this.id,
        configured: true,
        authorized: true,
        account: this.account,
        checkedAt: this.checkedAt,
      };
    }
    this.lastError = response.error ?? 'Could not verify the Last.fm session.';
    this.checkedAt = Date.now();
    return {
      id: this.id,
      configured: true,
      authorized: false,
      lastError: this.lastError,
      errorCode: response.errorCode,
      checkedAt: this.checkedAt,
    };
  }

  async disconnect(): Promise<void> {
    this.sessionKey = undefined;
    this.account = undefined;
  }

  get session(): string | undefined {
    return this.sessionKey;
  }

  get username(): string | undefined {
    return this.account;
  }

  /** The API key currently in use (never the secret). */
  get key(): string {
    return this.apiKey;
  }

  /**
   * Set the credentials (used when the user saves the settings or when the
   * built-in application credentials are resolved at start-up).
   */
  setCredentials(options: { apiKey?: string; apiSecret?: string; sessionKey?: string }): void {
    if (options.apiKey !== undefined) this.apiKey = options.apiKey;
    if (options.apiSecret !== undefined) this.apiSecret = options.apiSecret;
    if (options.sessionKey !== undefined) this.sessionKey = options.sessionKey;
  }

  /** Store an authorized session key (used after the callback handshake). */
  setSession(sessionKey: string, account?: string): void {
    this.sessionKey = sessionKey;
    if (account) this.account = account;
  }

  /** Sign and send an API call. */
  private async call(params: Record<string, string>): Promise<ServiceResult> {
    if (!this.apiKey || !this.apiSecret) {
      return { ok: false, error: 'A Last.fm API key and secret are required.' };
    }
    const authCall = params.method === 'auth.getToken' || params.method === 'auth.getSession';
    if (!authCall && !this.sessionKey) {
      return { ok: false, error: 'The Last.fm session is not authorized yet.' };
    }

    const signed: Record<string, string> = { ...params, api_key: this.apiKey };
    if (!authCall && this.sessionKey) signed.sk = this.sessionKey;
    signed.api_sig = this.sign(signed);

    const body = new URLSearchParams(signed).toString();
    let text: string;
    let status = 0;
    try {
      const response = await this.http(API_BASE, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body,
      });
      status = response.status;
      text = await response.text();
    } catch (error) {
      this.lastError = 'Network request to Last.fm failed. Retry when connected.';
      return { ok: false, error: this.lastError, status };
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = text;
    }

    const errorCode = (parsed as { error?: number })?.error;
    const errorMessage = (parsed as { message?: string })?.message;
    if (errorCode) {
      this.lastError = errorMessage ?? `Last.fm error ${errorCode}`;
      return { ok: false, status, error: this.lastError, errorCode, response: parsed };
    }
    if (status >= 400) {
      this.lastError = errorMessage ?? `Last.fm responded with HTTP ${status}`;
      return { ok: false, status, error: this.lastError, response: parsed };
    }

    if (params.method === 'track.scrobble') {
      const scrobbles = (parsed as any)?.scrobbles;
      const track = Array.isArray(scrobbles?.scrobble) ? scrobbles.scrobble[0] : scrobbles?.scrobble;
      const accepted = Number(scrobbles?.['@attr']?.accepted);
      const ignoredCode = Number(track?.ignoredMessage?.code ?? 0);
      if (accepted !== 1 || ignoredCode !== 0) {
        return {
          ok: false,
          status,
          error:
            track?.ignoredMessage?.['#text'] ||
            'Last.fm did not acknowledge this scrobble.',
          permanent: true,
          response: parsed,
        };
      }
    }
    this.lastError = undefined;
    this.checkedAt = Date.now();
    return { ok: true, status, response: parsed };
  }

  /** Last.fm signature: md5 of the sorted parameters plus the secret. */
  private sign(params: Record<string, string>): string {
    const keys = Object.keys(params)
      .filter((k) => k !== 'format' && k !== 'api_sig')
      .sort();
    const signature = keys.map((k) => `${k}${params[k]}`).join('') + this.apiSecret;
    return createHash('md5').update(signature, 'utf8').digest('hex');
  }
}
