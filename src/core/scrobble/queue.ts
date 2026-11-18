/**
 * Persistent scrobble queue.
 *
 * Submissions are stored before they are sent, retried with a backoff and
 * kept until the service confirmed them. That way a restart, a temporary
 * network failure or an offline period never loses a scrobble.
 */

import { scrobbleKey } from '../playback/trackState';
import type { ScrobblePayload, ScrobbleService, ServiceId, ServiceResult } from './types';

export type QueueItemState = 'pending' | 'sending' | 'failed' | 'done';

export interface QueueItem {
  id: string;
  service: ServiceId;
  artist: string;
  title: string;
  /** Unix epoch seconds. */
  timestamp: number;
  durationMs?: number;
  album?: string | null;
  state: QueueItemState;
  attempts: number;
  lastError?: string;
  createdAt: number;
  updatedAt: number;
  /** Epoch ms when the next attempt is allowed. */
  nextAttemptAt: number;
}

export interface QueueStore {
  read(): Promise<QueueItem[]>;
  write(items: QueueItem[]): Promise<void>;
}

export interface ScrobbleQueueOptions {
  store: QueueStore;
  services: Map<ServiceId, ScrobbleService>;
  now?: () => number;
  /** Backoff in milliseconds, the last entry is repeated. */
  backoffMs?: number[];
  maxAttempts?: number;
  /** Returns true when the same track was already scrobbled before. */
  isDuplicate?: (key: string) => boolean;
  onChange?: (items: QueueItem[]) => void;
  onError?: (error: unknown, item: QueueItem) => void;
  /** Called with the raw service result of every submission attempt. */
  onResult?: (item: QueueItem, result: ServiceResult) => void;
}

const DEFAULT_BACKOFF = [
  5_000,
  15_000,
  60_000,
  5 * 60_000,
  15 * 60_000,
  60 * 60_000,
];

export class ScrobbleQueue {
  private readonly options: ScrobbleQueueOptions;
  private readonly now: () => number;
  private items: QueueItem[] = [];
  private loaded = false;
  private processing = false;

  constructor(options: ScrobbleQueueOptions) {
    this.options = options;
    this.now = options.now ?? (() => Date.now());
  }

  /** Load the persisted items. */
  async load(): Promise<QueueItem[]> {
    const stored = await this.options.store.read();
    this.items = (stored ?? []).map((item) =>
      item.state === 'sending' ? { ...item, state: 'pending' as QueueItemState } : item,
    );
    this.loaded = true;
    return this.items;
  }

  /** All known items (newest first). */
  list(): QueueItem[] {
    return [...this.items].sort((a, b) => b.createdAt - a.createdAt);
  }

  /** Items that still have to be submitted. */
  pending(): QueueItem[] {
    return this.items.filter((item) => item.state === 'pending');
  }

  /**
   * Add a scrobble for the given services.
   *
   * `ignoreDuplicate` is used by an explicit retry from the history: the
   * track is already known to the duplicate window (it was submitted to
   * another service), but the service that failed still has to receive it.
   */
  async enqueue(
    payload: ScrobblePayload,
    services: ServiceId[],
    options: { ignoreDuplicate?: boolean } = {},
  ): Promise<QueueItem[]> {
    const now = this.now();
    const created: QueueItem[] = [];

    for (const service of services) {
      const key = scrobbleKey(payload.artist, payload.title, payload.timestamp * 1000);
      if (!options.ignoreDuplicate && this.options.isDuplicate?.(key)) continue;

      const existing = this.items.find(
        (item) =>
          item.service === service &&
          item.artist === payload.artist &&
          item.title === payload.title &&
          item.timestamp === payload.timestamp,
      );
      if (existing) continue;

      if (this.items.filter(i => i.state !== 'done').length >= 1000) throw new Error('Submission queue capacity reached (1000 outstanding).');
      const item: QueueItem = {
        id: `${service}-${now}-${Math.random().toString(36).slice(2, 10)}`,
        service,
        artist: payload.artist,
        title: payload.title,
        timestamp: payload.timestamp,
        durationMs: payload.durationMs,
        album: payload.album ?? null,
        state: 'pending',
        attempts: 0,
        createdAt: now,
        updatedAt: now,
        nextAttemptAt: now,
      };
      this.items.push(item);
      created.push(item);
    }

    if (created.length > 0) await this.persist();
    return created;
  }

  /**
   * Try to submit every item that is due.
   *
   * Failed submissions are retried with a backoff until the maximum number of
   * attempts is reached, after which the item is marked as failed and can be
   * retried manually.
   */
  async process(): Promise<{ sent: number; failed: number }> {
    if (this.processing) return { sent: 0, failed: 0 };
    if (!this.loaded) await this.load();
    this.processing = true;

    let sent = 0;
    let failed = 0;

    try {
      const now = this.now();
      const due = this.items.filter(
        (item) => item.state === 'pending' && item.nextAttemptAt <= now,
      );

      for (const item of due) {
        const service = this.options.services.get(item.service);
        if (!service) {
          item.lastError = `The service "${item.service}" is not available.`;
          item.state = 'failed';
          failed += 1;
          continue;
        }

        item.attempts += 1;
        item.updatedAt = now;
        const result = await service.scrobble({
          artist: item.artist,
          title: item.title,
          timestamp: item.timestamp,
          durationMs: item.durationMs,
          album: item.album ?? null,
        }).catch(() => ({ ok: false, error: 'Submission network request failed.', permanent: false, errorCode: undefined }));

        if (result.ok) {
          item.state = 'done';
          item.lastError = undefined;
          sent += 1;
        } else {
          item.lastError = result.error ?? 'Unknown error';
          const backoff = this.options.backoffMs ?? DEFAULT_BACKOFF;
          const delay = backoff[Math.min(item.attempts - 1, backoff.length - 1)] ?? 60_000;
          item.nextAttemptAt = this.now() + delay;
          if (result.permanent || result.errorCode === 9 || item.attempts >= (this.options.maxAttempts ?? 12)) {
            item.state = 'failed';
          }
          failed += 1;
          this.options.onError?.(result.error, item);
        }
        this.options.onResult?.(item, result);
      }

      await this.persist();
    } finally {
      this.processing = false;
    }

    return { sent, failed };
  }

  /** Retry an item manually. */
  async retry(id: string): Promise<boolean> {
    const item = this.items.find((entry) => entry.id === id);
    if (!item || item.state === 'done') return false;
    item.state = 'pending';
    item.attempts = 0;
    item.lastError = undefined;
    item.nextAttemptAt = this.now();
    await this.persist();
    return true;
  }

  /** Remove an item from the queue. */
  async remove(id: string): Promise<boolean> {
    const index = this.items.findIndex((entry) => entry.id === id);
    if (index === -1) return false;
    this.items.splice(index, 1);
    await this.persist();
    return true;
  }

  /** Remove all finished items. */
  async clearFinished(): Promise<number> {
    const before = this.items.length;
    this.items = this.items.filter((item) => item.state !== 'done');
    const removed = before - this.items.length;
    if (removed > 0) await this.persist();
    return removed;
  }

  private async persist(): Promise<void> {
    // Bound acknowledged history without dropping unsubmitted listens.
    const done = this.items.filter(i => i.state === 'done').sort((a,b) => b.updatedAt - a.updatedAt);
    const retained = new Set(done.slice(0, 500).map(i => i.id));
    this.items = this.items.filter(i => i.state !== 'done' || retained.has(i.id));
    await this.options.store.write(this.items);
    this.options.onChange?.(this.list());
  }
}
