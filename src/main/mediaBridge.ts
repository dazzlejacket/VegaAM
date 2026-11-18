/**
 * Main-process receiver and validator for the isolated MediaSession preload bridge.
 *
 * Security & Reliability Controls:
 *   - Sender verification: event.sender === officialWindow.webContents
 *   - Frame verification: event.senderFrame === officialWindow.webContents.mainFrame
 *   - URL allowlist verification: isAllowedSiriusXmUrl(event.senderFrame.url)
 *   - Payload schema validation: 512-char string cap, HTTPS-only artwork URL
 *   - Rate limit: at most 1 processed message per 500 ms
 *   - Staleness guard: clears metadata if no heartbeat arrives for 10,000 ms
 */

import { ipcMain, type BrowserWindow, type IpcMainEvent } from 'electron';

import { isAllowedSiriusXmUrl } from './officialPlayer';

export const MEDIA_STATE_CHANNEL = 'media:state';
export const MAX_STRING_LEN = 512;
export const RATE_LIMIT_MS = 500;
export const STALE_AFTER_MS = 10_000;

export interface MediaBridgeSnapshot {
  sessionTitle: string | null;
  sessionArtist: string | null;
  sessionAlbum: string | null;
  artworkUrl: string | null;
  playbackState: 'none' | 'paused' | 'playing';
  observedAt: number;
}

function sanitizeField(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.replace(/\s+/g, ' ').trim();
  if (!trimmed) return null;
  return trimmed.length > MAX_STRING_LEN ? trimmed.slice(0, MAX_STRING_LEN) : trimmed;
}

function sanitizeHttpsUrl(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > MAX_STRING_LEN) return null;
  try {
    const parsed = new URL(trimmed);
    return parsed.protocol === 'https:' ? parsed.toString() : null;
  } catch {
    return null;
  }
}

/**
 * Pure validator for incoming `media:state` IPC payloads.
 */
export function validatePayload(
  raw: unknown,
  now: number = Date.now(),
): MediaBridgeSnapshot | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const record = raw as Record<string, unknown>;

  const playbackState: MediaBridgeSnapshot['playbackState'] =
    record.playbackState === 'playing' || record.playbackState === 'paused'
      ? record.playbackState
      : 'none';

  return {
    sessionTitle: sanitizeField(record.sessionTitle),
    sessionArtist: sanitizeField(record.sessionArtist),
    sessionAlbum: sanitizeField(record.sessionAlbum),
    artworkUrl: sanitizeHttpsUrl(record.artworkUrl),
    playbackState,
    observedAt: now,
  };
}

export function snapshotFingerprint(snapshot: MediaBridgeSnapshot | null): string {
  if (!snapshot) return '';
  return [
    snapshot.sessionTitle ?? '',
    snapshot.sessionArtist ?? '',
    snapshot.sessionAlbum ?? '',
    snapshot.artworkUrl ?? '',
    snapshot.playbackState,
  ].join('\u0000');
}

export interface MediaBridgeReceiverOptions {
  getWindow: () => BrowserWindow | undefined;
  onSnapshot: (snapshot: MediaBridgeSnapshot, changed: boolean) => void;
  onStale?: () => void;
  now?: () => number;
}

export class MediaBridgeReceiver {
  private readonly options: MediaBridgeReceiverOptions;
  private readonly now: () => number;
  private latest: MediaBridgeSnapshot | null = null;
  private lastFingerprint = '';
  private lastAcceptedAt = 0;
  private lastHeartbeatAt = 0;
  private staleTimer: NodeJS.Timeout | undefined;
  private boundListener: ((event: IpcMainEvent, raw: unknown) => void) | undefined;

  constructor(options: MediaBridgeReceiverOptions) {
    this.options = options;
    this.now = options.now ?? (() => Date.now());
  }

  /** Register the IPC listener and start the staleness watchdog. */
  start(): void {
    if (this.boundListener) return;
    this.boundListener = (event: IpcMainEvent, raw: unknown) => {
      this.handleIpcEvent(event, raw);
    };
    ipcMain.on(MEDIA_STATE_CHANNEL, this.boundListener);
    this.staleTimer = setInterval(() => this.checkStaleness(), 2000);
  }

  /** Stop the IPC listener and staleness watchdog. */
  stop(): void {
    if (this.boundListener) {
      ipcMain.removeListener(MEDIA_STATE_CHANNEL, this.boundListener);
      this.boundListener = undefined;
    }
    if (this.staleTimer) {
      clearInterval(this.staleTimer);
      this.staleTimer = undefined;
    }
  }

  /** Clear the cached snapshot (e.g. on top-level navigation or crash). */
  clear(): void {
    this.latest = null;
    this.lastFingerprint = '';
    this.options.onStale?.();
  }

  getLatest(): MediaBridgeSnapshot | null {
    return this.latest;
  }

  /** Handle an incoming IPC event from the official window preload. */
  handleIpcEvent(event: IpcMainEvent, raw: unknown): boolean {
    const win = this.options.getWindow();
    if (!win || win.isDestroyed()) return false;

    // 1. Verify sender WebContents matches the official player window.
    if (event.sender !== win.webContents) {
      return false;
    }

    // 2. Verify sender frame is the top-level mainFrame.
    const senderFrame = event.senderFrame;
    if (!senderFrame || senderFrame !== win.webContents.mainFrame) {
      return false;
    }

    // 3. Verify sender frame URL is an allowed SiriusXM HTTPS URL.
    if (!isAllowedSiriusXmUrl(senderFrame.url)) {
      return false;
    }

    // 4. Rate limit to at most 1 message per RATE_LIMIT_MS.
    const now = this.now();
    if (this.lastAcceptedAt > 0 && now - this.lastAcceptedAt < RATE_LIMIT_MS) {
      return false;
    }

    // 5. Validate payload schema.
    const validated = validatePayload(raw, now);
    if (!validated) return false;

    this.lastAcceptedAt = now;
    this.lastHeartbeatAt = now;

    const fp = snapshotFingerprint(validated);
    const changed = fp !== this.lastFingerprint;
    this.lastFingerprint = fp;
    this.latest = validated;

    this.options.onSnapshot(validated, changed);
    return true;
  }

  checkStaleness(): void {
    if (!this.latest || this.lastHeartbeatAt === 0) return;
    const now = this.now();
    if (now - this.lastHeartbeatAt > STALE_AFTER_MS) {
      this.clear();
    }
  }
}
