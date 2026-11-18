import { describe, it, expect } from 'vitest';
import recorded from './fixtures/recorded-metadata.json';
import live from './fixtures/live-2026-11-04.json';
import { LastFmService } from '../src/core/scrobble/lastfm';
import { ScrobbleQueue, type QueueItem } from '../src/core/scrobble/queue';
import type { HttpClient, ScrobbleService } from '../src/core/scrobble/types';
import { TrackStateEngine } from '../src/core/playback/trackState';
import { DEFAULT_METADATA_CONFIG, DEFAULT_THRESHOLDS, SETTINGS_VERSION, mergeSettings } from '../src/core/settings/defaults';
import { resolveProviderMetadata } from '../src/core/metadata/providerRoles';
import { builtinThemes, themeToCss } from '../src/core/theme/engine';

// Synthetic protocol responses and event sequences, not claimed as live account evidence.
function lastfm(responses: unknown[]) {
  const calls: URLSearchParams[] = [];
  const http: HttpClient = async (_url, init) => {
    calls.push(new URLSearchParams(init?.body));
    return { ok: true, status: 200, text: async () => JSON.stringify(responses.shift() ?? {}) };
  };
  return { calls, client: new LastFmService({ apiKey: 'test', apiSecret: 'test-secret', http }) };
}

describe('desktop authentication and acknowledgements', () => {
  it('requests a signed token and exchanges it without an existing session', async () => {
    const { client, calls } = lastfm([{ token: 'request-token' }, { session: { key: 'session', name: 'tester' } }]);
    expect((await client.getToken()).ok).toBe(true);
    expect((await client.getSession('request-token')).ok).toBe(true);
    expect(client.session).toBe('session');
    expect(client.username).toBe('tester');
    for (const call of calls) { expect(call.has('sk')).toBe(false); expect(call.get('api_sig')).toMatch(/^[a-f0-9]{32}$/); }
    expect(calls[1]?.get('token')).toBe('request-token');
  });
  it('does not treat a successful HTTP response without a session as authentication', async () => {
    const { client } = lastfm([{}]);
    expect((await client.getSession('token')).ok).toBe(false);
  });
  it('keeps unauthorized tokens pending and recognizes invalid sessions', async () => {
    const { client } = lastfm([{ error: 14, message: 'Token not authorized' }, { error: 9, message: 'Invalid session key' }]);
    expect((await client.getSession('token')).errorCode).toBe(14);
    client.setCredentials({ sessionKey: 'session' });
    expect((await client.scrobble({ artist: 'A', title: 'B', timestamp: 1 })).errorCode).toBe(9);
    await client.disconnect(); expect(client.session).toBeUndefined();
  });
  it('distinguishes accepted and ignored submissions even with HTTP 200', async () => {
    const { client } = lastfm([
      { scrobbles: { '@attr': { accepted: 0, ignored: 1 }, scrobble: { ignoredMessage: { code: '3', '#text': 'Timestamp too old' } } } },
      { scrobbles: { '@attr': { accepted: 1, ignored: 0 }, scrobble: { ignoredMessage: { code: '0', '#text': '' } } } },
    ]);
    client.setCredentials({ sessionKey: 'session' });
    expect(await client.scrobble({ artist: 'A', title: 'B', timestamp: 1 })).toMatchObject({ ok: false, permanent: true });
    expect((await client.scrobble({ artist: 'A', title: 'B', timestamp: 2 })).ok).toBe(true);
  });
});

function engineHarness() {
  const submitted: unknown[] = [];
  const engine = new TrackStateEngine({ thresholds: { ...DEFAULT_THRESHOLDS, metadataDebounceMs: 1000 }, config: DEFAULT_METADATA_CONFIG, onScrobble: c => submitted.push(c) });
  const metadata = (title: string, at: number, extras = {}) => engine.handle({ type: 'metadata', at, raw: { channel: 'Music', artist: 'Artist', title, ...extras } });
  const tick = (at: number) => engine.handle({ type: 'tick', at });
  engine.handle({ type: 'state', at: 0, playing: true, buffering: false });
  metadata('Song', 0); tick(1000);
  return { engine, metadata, tick, submitted };
}

describe('live radio regressions', () => {
  it('does not commit a transient metadata change after it reverts', () => {
    const h = engineHarness(); h.metadata('Transient', 2000); h.metadata('Song', 2500); h.tick(6000);
    expect(h.engine.state?.normalized.title).toBe('Song'); expect(h.engine.state?.startedAt).toBe(0);
  });
  it('uses the first stable observation timestamp and excludes verification delay from listening', () => {
    const h = engineHarness(); expect(h.engine.state?.startedAt).toBe(0); expect(h.engine.state?.listeningMs).toBe(0);
    h.tick(2000); expect(h.engine.state?.listeningMs).toBe(1000);
  });
  it('does not submit filtered metadata at a known-duration threshold before finalization', () => {
    const h = engineHarness(); h.metadata('Advertisement', 2000); h.tick(3000); h.engine.setDuration(60000); h.tick(90000);
    expect(h.submitted).toHaveLength(0);
  });
  it('excludes tracks of 30 seconds or less', () => {
    const h = engineHarness(); h.engine.setDuration(30000); h.tick(90000);
    expect(h.submitted).toHaveLength(0); expect(h.engine.state?.scrobbleReason).toContain('30 seconds');
  });
  it('does not use a channel switch to submit a track below the radio threshold', () => {
    const h = engineHarness(); h.tick(60000); h.engine.handle({ type: 'channel', channel: 'Other', at: 61000 });
    expect(h.submitted).toHaveLength(0); expect(h.engine.state).toBeUndefined();
  });
  it('does not submit a radio track twice when the channel changes after the threshold', () => {
    const h = engineHarness(); h.tick(200000);
    // The floor was reached, so the track was already submitted by the tick.
    expect(h.submitted).toHaveLength(1);
    h.engine.handle({ type: 'channel', channel: 'Other', at: 201000 });
    expect(h.submitted).toHaveLength(1); expect(h.engine.state).toBeUndefined();
  });
  it('can submit the same song again after actual intervening transitions', () => {
    const h = engineHarness(); h.tick(200000); h.metadata('Other', 201000); h.tick(202000);
    h.tick(402000); h.metadata('Song', 403000); h.tick(404000);
    h.tick(604000); h.metadata('Final', 605000); h.tick(606000);
    expect(h.submitted).toHaveLength(3);
  });
  it('resolves active MediaSession metadata without any page DOM fields', () => {
    const r = resolveProviderMetadata({ sessionTitle: 'Playing · Playing', sessionArtist: 'Artist - Song' });
    expect(r.channel).toBe('Playing'); expect(r.artist).toBe('Artist');
  });
  it('does not scrobble an empty MediaSession snapshot', () => {
    const r = resolveProviderMetadata({});
    expect(r.scrobbleSafe).toBe(false);
  });
});

describe('durable retry queue', () => {
  it('handles thrown network errors, retries, and suppresses acknowledged duplicates', async () => {
    let stored: QueueItem[] = []; let fail = true;
    const service = { id: 'lastfm', scrobble: async () => { if (fail) throw new Error('offline'); return { ok: true }; } } as unknown as ScrobbleService;
    const queue = new ScrobbleQueue({ store: { read: async () => stored, write: async i => { stored = i; } }, services: new Map([['lastfm',service]]), backoffMs: [0] });
    await queue.load(); const payload = { artist: 'A', title: 'B', timestamp: 1 };
    await queue.enqueue(payload, ['lastfm']); await queue.process(); expect(queue.list()[0]?.state).toBe('pending');
    fail = false; await queue.process(); expect(queue.list()[0]?.state).toBe('done');
    expect(await queue.enqueue(payload, ['lastfm'])).toHaveLength(0);
    expect(await queue.retry(queue.list()[0]!.id)).toBe(false);
  });
  it('retains an invalid-session failure for explicit reconnection and retry', async () => {
    let stored: QueueItem[] = [];
    const service = { id: 'lastfm', scrobble: async () => ({ ok: false, errorCode: 9, error: 'Invalid session' }) } as unknown as ScrobbleService;
    const queue = new ScrobbleQueue({ store: { read: async () => stored, write: async i => { stored = i; } }, services: new Map([['lastfm',service]]) });
    await queue.enqueue({ artist: 'A', title: 'B', timestamp: 1 }, ['lastfm']); await queue.load(); await queue.process();
    expect(queue.list()[0]?.state).toBe('failed'); expect(queue.list()[0]?.lastError).toContain('Invalid session');
  });
});

it('renders distinct readable light and dark neutral palettes for every builtin skin', () => {
  for (const theme of builtinThemes()) {
    const light = themeToCss(theme, { mode: 'light' }); const dark = themeToCss(theme, { mode: 'dark' });
    expect(light).not.toBe(dark);
    const bg = (css: string) => [...css.matchAll(/--bg: ([^;]+);/g)].at(-1)?.[1];
    expect(bg(light)).not.toBe(bg(dark));
  }
});

it('resolves the retained historical captures without channel-specific parser branches', () => {
  for (const fixture of recorded.records) {
    const result = resolveProviderMetadata(fixture.snapshot);
    expect(result.artist).toBe('The Beatles');
    expect(result.scrobbleSafe).toBe(true);
  }
});

it('enforces conservative production thresholds when loading or saving settings', () => {
  const settings = mergeSettings({ thresholds: { ratio: .1, maxMs: 100, radioMinListenMs: 0 } });
  expect(settings.thresholds.ratio).toBe(.5); expect(settings.thresholds.maxMs).toBe(240000);
  // A stored radio floor that the old build would have forced up to 150,000 ms
  // was never a deliberate choice, so the hotfix rewrites it to the new
  // fallback floor and keeps the adaptive estimate enabled.
  expect(settings.thresholds.radioMinListenMs).toBe(90000);
  expect(settings.thresholds.radioAdaptiveEstimate).toBe(true);
});

it('keeps a radio floor that was deliberately raised and switches the adaptive estimate off', () => {
  const settings = mergeSettings({ thresholds: { radioMinListenMs: 200000 } });
  expect(settings.thresholds.radioMinListenMs).toBe(200000);
  expect(settings.thresholds.radioAdaptiveEstimate).toBe(false);
});

it('migrates a legacy profile to the radio policy that submits at the radio floor', () => {
  // A settings file without a version stamp was written by version 1, which
  // forced the boundary requirement on every load.
  const legacy = mergeSettings({ thresholds: { radioRequiresBoundary: true } });
  expect(legacy.thresholds.radioRequiresBoundary).toBe(false);
  expect(legacy.settingsVersion).toBe(SETTINGS_VERSION);
});

it('respects the radio policy the user chose in the current version', () => {
  const chosen = mergeSettings({
    settingsVersion: SETTINGS_VERSION,
    thresholds: { radioRequiresBoundary: true },
  });
  expect(chosen.thresholds.radioRequiresBoundary).toBe(true);
});

it('does not count a system-suspend gap as observed listening', () => {
  const engine = new TrackStateEngine({ thresholds: { ...DEFAULT_THRESHOLDS, metadataDebounceMs: 0 }, config: DEFAULT_METADATA_CONFIG, maxAccrualGapMs: 5000 });
  engine.handle({ type: 'state', playing: true, buffering: false, at: 0 });
  engine.handle({ type: 'metadata', at: 0, raw: { channel: 'Music', artist: 'Artist', title: 'Song' } });
  engine.handle({ type: 'tick', at: 1000 }); engine.handle({ type: 'tick', at: 61000 });
  expect(engine.state?.listeningMs).toBe(1000);
});

it('resolves the actual Beatles and E Street playback samples through the same general parser', () => {
  for (const record of live.records) {
    const resolved = resolveProviderMetadata(record.snapshot);
    expect(record.playing).toBe(true); expect(record.buffering).toBe(false);
    expect(resolved.artist).toBe(record.observedArtist); expect(resolved.title).toBe(record.observedTitle);
    expect(resolved.channel).toBe(record.requestedChannel); expect(resolved.scrobbleSafe).toBe(true);
  }
});
