/**
 * ListenBrainz scrobbling client.
 *
 * ListenBrainz uses a user token that the user creates in their account
 * settings. The token is stored encrypted by the application.
 *
 * Reference: https://listenbrainz.readthedocs.io/en/latest/dev/api/
 */

import {
  defaultHttp,
  type HttpClient,
  type ScrobblePayload,
  type ScrobbleService,
  type ServiceId,
  type ServiceResult,
  type ServiceStatus,
} from './types';

const API_BASE = 'https://api.listenbrainz.org/1/';

export interface ListenBrainzOptions {
  token?: string;
  http?: HttpClient;
  /** Reported to the service so submissions can be identified. */
  client?: string;
}

export class ListenBrainzService implements ScrobbleService {
  readonly id: ServiceId = 'listenbrainz';

  private token?: string;
  private account?: string;
  private lastError?: string;
  private checkedAt?: number;
  private readonly http: HttpClient;
  private readonly client: string;

  constructor(options: ListenBrainzOptions = {}) {
    this.token = options.token;
    this.http = options.http ?? defaultHttp;
    this.client = options.client ?? 'VegaAM';
  }

  isConfigured(): boolean {
    return Boolean(this.token);
  }

  setToken(token: string | undefined): void {
    this.token = token;
  }

  /** Verify the token against the live service. */
  async verify(): Promise<ServiceStatus> {
    if (!this.token) {
      return {
        id: this.id,
        configured: false,
        authorized: false,
        lastError: 'No ListenBrainz token configured.',
        checkedAt: Date.now(),
      };
    }
    try {
      const response = await this.http(`${API_BASE}validate-token`, {
        method: 'GET',
        headers: { Authorization: `Token ${this.token}` },
      });
      const text = await response.text();
      let parsed: unknown;
      try {
        parsed = JSON.parse(text);
      } catch {
        parsed = text;
      }
      const code = (parsed as { code?: string | number })?.code;
      const message = (parsed as { message?: string })?.message;
      // The endpoint answers with HTTP 200 even for an invalid token, the
      // `valid` flag carries the actual result.
      const valid = (parsed as { valid?: boolean })?.valid;
      const userName = (parsed as { user_name?: string })?.user_name;
      const accepted =
        response.ok &&
        valid !== false &&
        (valid === true || String(code) === '200') &&
        Boolean(userName);

      if (accepted) {
        this.account = userName;
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
      this.lastError = message ?? `ListenBrainz rejected the token (HTTP ${response.status}).`;
      this.checkedAt = Date.now();
      return {
        id: this.id,
        configured: true,
        authorized: false,
        lastError: this.lastError,
        checkedAt: this.checkedAt,
      };
    } catch (error) {
      this.lastError = error instanceof Error ? error.message : String(error);
      this.checkedAt = Date.now();
      return {
        id: this.id,
        configured: true,
        authorized: false,
        lastError: this.lastError,
        checkedAt: this.checkedAt,
      };
    }
  }

  /**
   * Submit a "playing now" notification.
   *
   * ListenBrainz uses a different schema for the ephemeral "now playing"
   * state than for a completed listen:
   *
   *   - the listen type is `playing_now` (not `playing`),
   *   - the payload wrapper is `track_metadata` (not `metadata`),
   *   - `listened_at` is not allowed - a now playing entry has no end time.
   *
   * Sending the completed-listen shape here was rejected with HTTP 400.
   */
  async nowPlaying(payload: ScrobblePayload): Promise<ServiceResult> {
    if (!this.token) return { ok: false, error: 'No ListenBrainz token configured.' };
    const body = {
      listen_type: 'playing_now',
      payload: [
        {
          track_metadata: {
            artist_name: payload.artist,
            track_name: payload.title,
            release_name: payload.album ?? undefined,
            additional_info: this.additionalInfo(payload),
          },
        },
      ],
    };
    return this.submit(body);
  }

  /** Submit a completed listen. */
  async scrobble(payload: ScrobblePayload): Promise<ServiceResult> {
    if (!this.token) return { ok: false, error: 'No ListenBrainz token configured.' };
    const body = {
      listen_type: 'single',
      payload: [
        {
          listened_at: payload.timestamp,
          track_metadata: {
            artist_name: payload.artist,
            track_name: payload.title,
            release_name: payload.album ?? undefined,
            additional_info: this.additionalInfo(payload),
          },
        },
      ],
    };
    return this.submit(body);
  }

  async disconnect(): Promise<void> {
    this.token = undefined;
    this.account = undefined;
  }

  private additionalInfo(payload: ScrobblePayload): Record<string, unknown> | undefined {
    const info: Record<string, unknown> = {
      media_player: 'VegaAM',
      submission_client: this.client,
      // ListenBrainz expects the music service as a domain, not as a
      // display name.
      music_service: 'siriusxm.com',
    };
    if (payload.durationMs) info.duration_ms = Math.round(payload.durationMs);
    if (Object.keys(info).length === 0) return undefined;
    return info;
  }

  private async submit(body: unknown): Promise<ServiceResult> {
    try {
      const response = await this.http(`${API_BASE}submit-listens`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Token ${this.token}`,
        },
        body: JSON.stringify(body),
      });
      const text = await response.text();
      let parsed: unknown;
      try {
        parsed = JSON.parse(text);
      } catch {
        parsed = text;
      }
      if (!response.ok) {
        const message =
          (parsed as { message?: string })?.message ?? `ListenBrainz responded with HTTP ${response.status}.`;
        this.lastError = message;
        return { ok: false, status: response.status, error: message, response: parsed };
      }
      this.lastError = undefined;
      this.checkedAt = Date.now();
      return { ok: true, status: response.status, response: parsed };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.lastError = message;
      return { ok: false, error: message };
    }
  }
}
