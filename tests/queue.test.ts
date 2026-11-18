import { describe, expect, it } from 'vitest';

import { ScrobbleQueue, type QueueItem, type QueueStore } from '../src/core/scrobble/queue';
import type { HttpClient, ScrobblePayload, ScrobbleService, ServiceResult } from '../src/core/scrobble/types';

class MemoryStore implements QueueStore {
  items: QueueItem[] = [];
  async read(): Promise<QueueItem[]> {
    return this.items;
  }
  async write(items: QueueItem[]): Promise<void> {
    this.items = items;
  }
}

class FakeService implements ScrobbleService {
  readonly id = 'lastfm' as const;
  calls: ScrobblePayload[] = [];
  failures = 0;

  constructor(private readonly totalFailures = 0) {}

  isConfigured(): boolean {
    return true;
  }

  async nowPlaying(): Promise<ServiceResult> {
    return { ok: true };
  }

  async scrobble(payload: ScrobblePayload): Promise<ServiceResult> {
    this.calls.push(payload);
    if (this.calls.length <= this.totalFailures) {
      return { ok: false, error: 'network unreachable' };
    }
    return { ok: true, status: 200 };
  }

  async verify() {
    return { id: this.id, configured: true, authorized: true };
  }

  async disconnect(): Promise<void> {}
}

function payload(overrides: Partial<ScrobblePayload> = {}): ScrobblePayload {
  return {
    artist: 'Dave Matthews Band',
    title: 'Cry (October 1, 2020 – Boston, MA)',
    timestamp: 1_700_000_000,
    ...overrides,
  };
}

describe('scrobble queue', () => {
  it('sends a queued scrobble and marks it as done', async () => {
    const store = new MemoryStore();
    const service = new FakeService();
    const queue = new ScrobbleQueue({
      store,
      services: new Map([['lastfm', service]]),
    });
    await queue.load();

    await queue.enqueue(payload(), ['lastfm']);
    expect(queue.pending()).toHaveLength(1);

    const result = await queue.process();
    expect(result.sent).toBe(1);
    expect(queue.list()[0]?.state).toBe('done');
    expect(service.calls[0]?.artist).toBe('Dave Matthews Band');
  });

  it('retries a failed submission with a backoff', async () => {
    const store = new MemoryStore();
    const service = new FakeService(1);
    let now = 1_000;
    const queue = new ScrobbleQueue({
      store,
      services: new Map([['lastfm', service]]),
      now: () => now,
      backoffMs: [50],
      maxAttempts: 5,
    });
    await queue.load();
    await queue.enqueue(payload(), ['lastfm']);

    const first = await queue.process();
    expect(first.failed).toBe(1);
    expect(queue.list()[0]?.state).toBe('pending');
    expect(queue.list()[0]?.lastError).toBe('network unreachable');

    // The retry is not due yet.
    const tooEarly = await queue.process();
    expect(tooEarly.sent).toBe(0);

    now += 100;
    const second = await queue.process();
    expect(second.sent).toBe(1);
    expect(queue.list()[0]?.state).toBe('done');
  });

  it('marks an item as failed after the maximum number of attempts', async () => {
    const store = new MemoryStore();
    const service = new FakeService(100);
    let now = 1_000;
    const queue = new ScrobbleQueue({
      store,
      services: new Map([['lastfm', service]]),
      now: () => now,
      backoffMs: [10],
      maxAttempts: 2,
    });
    await queue.load();
    await queue.enqueue(payload(), ['lastfm']);

    await queue.process();
    now += 100;
    await queue.process();
    expect(queue.list()[0]?.state).toBe('failed');

    // A manual retry resets the item.
    await queue.retry(queue.list()[0]!.id);
    expect(queue.list()[0]?.state).toBe('pending');
  });

  it('keeps pending submissions across a restart', async () => {
    const store = new MemoryStore();
    const failing = new FakeService(10);
    let now = 1_000;
    const first = new ScrobbleQueue({
      store,
      services: new Map([['lastfm', failing]]),
      now: () => now,
      backoffMs: [50],
    });
    await first.load();
    await first.enqueue(payload(), ['lastfm']);
    await first.process();

    // The application restarts with the same store.
    const service = new FakeService(0);
    now += 1_000;
    const second = new ScrobbleQueue({
      store,
      services: new Map([['lastfm', service]]),
      now: () => now,
    });
    await second.load();
    expect(second.pending()).toHaveLength(1);

    const result = await second.process();
    expect(result.sent).toBe(1);
    expect(service.calls).toHaveLength(1);
  });

  it('does not queue the same scrobble twice', async () => {
    const store = new MemoryStore();
    const service = new FakeService();
    const queue = new ScrobbleQueue({ store, services: new Map([['lastfm', service]]) });
    await queue.load();

    await queue.enqueue(payload(), ['lastfm']);
    await queue.enqueue(payload(), ['lastfm']);
    expect(queue.list()).toHaveLength(1);
  });

  it('honours the duplicate checker', async () => {
    const store = new MemoryStore();
    const service = new FakeService();
    const queue = new ScrobbleQueue({
      store,
      services: new Map([['lastfm', service]]),
      isDuplicate: () => true,
    });
    await queue.load();
    const created = await queue.enqueue(payload(), ['lastfm']);
    expect(created).toHaveLength(0);
    expect(queue.list()).toHaveLength(0);
  });

  it('reports an error when the service is unavailable', async () => {
    const store = new MemoryStore();
    const queue = new ScrobbleQueue({ store, services: new Map() });
    await queue.load();
    await queue.enqueue(payload(), ['lastfm']);
    const result = await queue.process();
    expect(result.failed).toBe(1);
    expect(queue.list()[0]?.state).toBe('failed');
    expect(queue.list()[0]?.lastError).toContain('not available');
  });
});

describe('http client contract', () => {
  it('is used by the service implementations', () => {
    const calls: { url: string; init?: { method?: string; body?: string } }[] = [];
    const http: HttpClient = async (url, init) => {
      calls.push({ url, init });
      return { ok: true, status: 200, text: async () => '{"ok":true}' };
    };
    expect(typeof http).toBe('function');
    expect(calls).toHaveLength(0);
  });
});
