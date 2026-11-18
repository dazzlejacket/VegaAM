/**
 * Isolated read-only MediaSession bridge preload for the official SiriusXM window.
 *
 * Security & Architecture Invariants:
 *   - Runs with contextIsolation: true, sandbox: true, nodeIntegration: false
 *   - Does NOT call contextBridge.exposeInMainWorld (page sees zero custom globals)
 *   - Reads ONLY navigator.mediaSession.metadata and navigator.mediaSession.playbackState
 *   - Zero DOM access, zero CSS changes, zero synthetic input events
 */

import { ipcRenderer } from 'electron';

export interface MediaBridgePayload {
  sessionTitle: string | null;
  sessionArtist: string | null;
  sessionAlbum: string | null;
  artworkUrl: string | null;
  playbackState: 'none' | 'paused' | 'playing';
  observedAt: number;
}

const POLL_INTERVAL_MS = 1000;
const HEARTBEAT_INTERVAL_MS = 3000;
const MAX_STRING_LEN = 512;

function sanitizeText(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.replace(/\s+/g, ' ').trim();
  if (!trimmed) return null;
  return trimmed.length > MAX_STRING_LEN ? trimmed.slice(0, MAX_STRING_LEN) : trimmed;
}

function selectArtworkUrl(artwork: ReadonlyArray<MediaImage> | undefined): string | null {
  if (!Array.isArray(artwork) || artwork.length === 0) return null;
  for (let i = artwork.length - 1; i >= 0; i -= 1) {
    const candidate = artwork[i]?.src;
    if (typeof candidate === 'string' && candidate.startsWith('https://')) {
      return candidate.length > MAX_STRING_LEN ? null : candidate;
    }
  }
  return null;
}

function normalizePlaybackState(state: unknown): 'none' | 'paused' | 'playing' {
  if (state === 'playing' || state === 'paused') return state;
  return 'none';
}

function readMediaSession(): MediaBridgePayload {
  const nav = typeof navigator !== 'undefined' ? navigator : undefined;
  const session = nav && 'mediaSession' in nav ? nav.mediaSession : undefined;
  const meta = session?.metadata ?? null;

  return {
    sessionTitle: sanitizeText(meta?.title),
    sessionArtist: sanitizeText(meta?.artist),
    sessionAlbum: sanitizeText(meta?.album),
    artworkUrl: selectArtworkUrl(meta?.artwork),
    playbackState: normalizePlaybackState(session?.playbackState),
    observedAt: Date.now(),
  };
}

function fingerprint(payload: MediaBridgePayload): string {
  return [
    payload.sessionTitle ?? '',
    payload.sessionArtist ?? '',
    payload.sessionAlbum ?? '',
    payload.artworkUrl ?? '',
    payload.playbackState,
  ].join('\u0000');
}

function startBridge(): void {
  if (typeof window === 'undefined' || typeof navigator === 'undefined') return;

  let lastKey = '';
  let lastSentAt = 0;

  const tick = (): void => {
    try {
      const payload = readMediaSession();
      const key = fingerprint(payload);
      const now = payload.observedAt;
      if (key !== lastKey || now - lastSentAt >= HEARTBEAT_INTERVAL_MS) {
        lastKey = key;
        lastSentAt = now;
        ipcRenderer.send('media:state', payload);
      }
    } catch {
      /* never disrupt the host context */
    }
  };

  setInterval(tick, POLL_INTERVAL_MS);
  tick();
}

startBridge();
