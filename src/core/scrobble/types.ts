/** Shared scrobbling types. */

export type ServiceId = 'lastfm' | 'listenbrainz';

export interface ScrobblePayload {
  artist: string;
  title: string;
  /** Unix epoch seconds. */
  timestamp: number;
  durationMs?: number;
  album?: string | null;
}

export interface ServiceResult {
  ok: boolean;
  errorCode?: number;
  permanent?: boolean;
  /** HTTP status code when available. */
  status?: number;
  /** Error message for the diagnostics view. */
  error?: string;
  /** Raw service response (already parsed when possible). */
  response?: unknown;
}

export interface ServiceStatus {
  id: ServiceId;
  connectionState?: 'not-configured' | 'awaiting-authorization' | 'connected' | 'authentication-failed' | 'session-invalid';
  /** True when the service has everything it needs to submit. */
  configured: boolean;
  /** True when the service is currently authorized. */
  authorized: boolean;
  /** Last error message. */
  lastError?: string;
  /** The API error code the service reported (Last.fm documents these). */
  errorCode?: number;
  /**
   * The authorization URL of a pending desktop authorization.
   *
   * It contains a short lived request token and is only shown when the
   * browser could not be opened automatically.
   */
  authUrl?: string;
  /** Account name when known. */
  account?: string;
  /**
   * Which credential pair the service uses.
   *
   * `build` is the built-in application credentials, `user` is a key pair the
   * user supplied, `none` means there is no usable pair.
   */
  credentialSource?: 'user' | 'build' | 'none';
  /** When the status was last checked. */
  checkedAt?: number;
}

export interface ScrobbleService {
  readonly id: ServiceId;
  /** True when the service can be used (credentials present). */
  isConfigured(): boolean;
  /** Submit a "now playing" notification. */
  nowPlaying(payload: ScrobblePayload): Promise<ServiceResult>;
  /** Submit a completed listen. */
  scrobble(payload: ScrobblePayload): Promise<ServiceResult>;
  /** Verify the stored credentials against the live service. */
  verify(): Promise<ServiceStatus>;
  /** Forget the stored credentials. */
  disconnect(): Promise<void>;
}

/** Minimal HTTP interface so the services can be tested without network. */
export interface HttpResponse {
  ok: boolean;
  status: number;
  text(): Promise<string>;
}

export interface HttpClient {
  (url: string, init?: {
    method?: string;
    headers?: Record<string, string>;
    body?: string;
  }): Promise<HttpResponse>;
}

/** Default HTTP client based on the global fetch implementation. */
export const defaultHttp: HttpClient = async (url, init) => {
  const response = await fetch(url, { ...init, signal: AbortSignal.timeout(20_000) });
  return {
    ok: response.ok,
    status: response.status,
    text: () => response.text(),
  };
};
