import { beforeEach, describe, expect, it } from 'vitest';

import { DEFAULT_METADATA_CONFIG, DEFAULT_THRESHOLDS } from '../src/core/settings/defaults';
import {
  DEFAULT_RADIO_SONG_ESTIMATE_MS,
  TrackStateEngine,
  computeThreshold,
  scrobbleKey,
  type ScrobbleCandidate,
} from '../src/core/playback/trackState';
import type { MetadataConfig, RawMetadata } from '../src/core/metadata/types';

function config(overrides: Partial<MetadataConfig> = {}): MetadataConfig {
  return {
    ...DEFAULT_METADATA_CONFIG,
    channelMappings: [{ channel: 'Dave Matthews Band Radio', artist: 'Dave Matthews Band' }],
    artistAliases: {},
    manualCorrections: {},
    correctionRules: [],
    ...overrides,
  };
}

function thresholds(overrides: Partial<typeof DEFAULT_THRESHOLDS> = {}) {
  return { ...DEFAULT_THRESHOLDS, ...overrides };
}

class Clock {
  now = 1_700_000_000_000;
  advance(ms: number): number {
    this.now += ms;
    return this.now;
  }
}

interface Harness {
  engine: TrackStateEngine;
  clock: Clock;
  scrobbles: ScrobbleCandidate[];
  finalised: { reason: string; title: string; artist: string | null; scrobbled: boolean }[];
}

function harness(options: {
  thresholdOverrides?: Partial<typeof DEFAULT_THRESHOLDS>;
  config?: Partial<MetadataConfig>;
  duplicates?: Set<string>;
} = {}): Harness {
  const clock = new Clock();
  const scrobbles: ScrobbleCandidate[] = [];
  const finalised: { reason: string; title: string; artist: string | null; scrobbled: boolean }[] = [];

  const engine = new TrackStateEngine({
    thresholds: thresholds(options.thresholdOverrides),
    config: config(options.config),
    now: () => clock.now,
    onScrobble: (candidate) => scrobbles.push(candidate),
    onFinalize: (state, reason) =>
      finalised.push({
        reason,
        title: state.normalized.scrobbleTitle,
        artist: state.normalized.scrobbleArtist,
        scrobbled: state.scrobbled,
      }),
    isDuplicate: (key) => options.duplicates?.has(key) ?? false,
  });

  return { engine, clock, scrobbles, finalised };
}

/** Feed a metadata change and let the debounce window expire. */
function changeMetadata(
  harnessRef: Harness,
  raw: RawMetadata,
  options: { debounce?: number } = {},
): void {
  const debounce = options.debounce ?? DEFAULT_THRESHOLDS.metadataDebounceMs;
  harnessRef.engine.handle({ type: 'metadata', raw, at: harnessRef.clock.now });
  harnessRef.clock.advance(debounce + 10);
  harnessRef.engine.handle({ type: 'tick', at: harnessRef.clock.now });
}

/** A radio track of a channel that plays short songs. */
function song(title: string, channel = 'The Beatles Channel'): RawMetadata {
  return { channel, artist: 'The Beatles', title };
}

/** A filtered announcement: it occupies a slot but is not a song. */
function advertisement(): RawMetadata {
  return {
    channel: 'The Beatles Channel',
    artist: 'Advertisement',
    title: 'Call now 1-800-555-1234',
  };
}

/**
 * Play one song until the next song takes over.
 *
 * `lengthMs` is the time the song plays before the next metadata arrives. The
 * playback state is reported first, exactly like the real player does, so the
 * length the engine measures is the real length of the song.
 */
function playSong(harnessRef: Harness, raw: RawMetadata, lengthMs: number): void {
  harnessRef.engine.handle({ type: 'state', playing: true, buffering: false, at: harnessRef.clock.now });
  changeMetadata(harnessRef, raw);
  harnessRef.clock.advance(
    Math.max(0, lengthMs - DEFAULT_THRESHOLDS.metadataDebounceMs - 10),
  );
}

describe('computeThreshold', () => {
  it('uses half of a known duration, capped at the maximum', () => {
    const short = computeThreshold(3 * 60 * 1000, DEFAULT_THRESHOLDS);
    expect(short.thresholdMs).toBe(90_000);
    expect(short.needsBoundary).toBe(false);

    const long = computeThreshold(60 * 60 * 1000, DEFAULT_THRESHOLDS);
    expect(long.thresholdMs).toBe(DEFAULT_THRESHOLDS.maxMs);
  });

  it('falls back to the radio threshold when the duration is unknown', () => {
    const radio = computeThreshold(undefined, DEFAULT_THRESHOLDS);
    expect(radio.thresholdMs).toBe(DEFAULT_THRESHOLDS.radioMinListenMs);
    // The radio floor is the criterion by default. SiriusXM never publishes a
    // reliable duration, so requiring a confirmed song boundary meant that a
    // song the user listened to for minutes was never submitted.
    expect(radio.needsBoundary).toBe(false);

    // The strict policy stays available as an explicit choice.
    const strict = computeThreshold(undefined, thresholds({ radioRequiresBoundary: true }));
    expect(strict.thresholdMs).toBe(DEFAULT_THRESHOLDS.radioMinListenMs);
    expect(strict.needsBoundary).toBe(true);
  });

  it('derives the radio threshold from the observed song length', () => {
    // 50% of the observed song length, exactly like a known duration.
    expect(computeThreshold(undefined, DEFAULT_THRESHOLDS, 80_000).thresholdMs).toBe(40_000);
    expect(computeThreshold(undefined, DEFAULT_THRESHOLDS, 180_000).thresholdMs).toBe(90_000);

    // The absolute floor still applies: a song is never submitted after a
    // couple of seconds of playback.
    expect(computeThreshold(undefined, DEFAULT_THRESHOLDS, 20_000).thresholdMs).toBe(
      DEFAULT_THRESHOLDS.minMs,
    );

    // Without the adaptive estimate the flat floor is used.
    expect(
      computeThreshold(undefined, thresholds({ radioAdaptiveEstimate: false }), 80_000).thresholdMs,
    ).toBe(DEFAULT_THRESHOLDS.radioMinListenMs);
  });
});

describe('adaptive radio threshold', () => {
  it('trusts the observed song length only after three complete songs', () => {
    const h = harness();

    // The first song may have been joined half-way, so it is never learned.
    playSong(h, song('One'), 80_000);
    playSong(h, song('Two'), 80_000);
    playSong(h, song('Three'), 80_000);
    expect(h.engine.observedSongCount).toBe(1);
    expect(h.engine.songEstimateTrusted).toBe(false);
    expect(h.engine.songEstimateMs).toBe(DEFAULT_RADIO_SONG_ESTIMATE_MS);
    expect(h.engine.effectiveThresholdMs).toBe(90_000);

    playSong(h, song('Four'), 80_000);
    playSong(h, song('Five'), 80_000);
    expect(h.engine.observedSongCount).toBe(3);
    expect(h.engine.songEstimateTrusted).toBe(true);
    expect(h.engine.songEstimateMs).toBe(80_000);
    // A channel of 80 s songs needs 40 s of playback.
    expect(h.engine.effectiveThresholdMs).toBe(40_000);
  });

  it('submits a short song that ends before the threshold is reached', () => {
    const h = harness();

    playSong(h, song('One'), 40_000);
    playSong(h, song('Two'), 60_000);
    playSong(h, song('Three'), 120_000);

    // The 60 s song never reached the 90 s channel threshold while it was
    // playing, but it was heard completely, so it is submitted when it ends.
    expect(h.scrobbles.map((entry) => entry.title)).toEqual(['Two']);
  });

  it('does not submit a song that was joined half-way through', () => {
    const h = harness();

    // Only 40 s of this song were left when the application started, so its
    // length is unknown and the channel threshold applies.
    playSong(h, song('One'), 40_000);
    playSong(h, song('Two'), 60_000);

    expect(h.scrobbles).toHaveLength(0);
  });

  it('does not submit a song that was skipped after a few seconds', () => {
    const h = harness();

    playSong(h, song('One'), 60_000);
    playSong(h, song('Two'), 5_000); // the user skips almost immediately
    playSong(h, song('Three'), 60_000);

    expect(h.scrobbles).toHaveLength(0);
  });

  it('does not use a channel switch to submit a short song', () => {
    const h = harness();

    playSong(h, song('One'), 60_000);
    playSong(h, song('Two'), 60_000);

    // A channel switch is not a song boundary: the song that was cut off is
    // not submitted by the song-end rule.
    h.engine.handle({ type: 'channel', channel: 'Deep Tracks', at: h.clock.now });
    expect(h.scrobbles).toHaveLength(0);
  });

  it('does not let a pause inflate the measured length of a song', () => {
    const h = harness();

    playSong(h, song('One'), 60_000);

    // Song two plays for 60 s, is paused for five minutes and then ends.
    h.engine.handle({ type: 'state', playing: true, buffering: false, at: h.clock.now });
    changeMetadata(h, song('Two'));
    h.clock.advance(60_000);
    h.engine.handle({ type: 'state', playing: false, buffering: false, at: h.clock.now });
    h.clock.advance(300_000);
    h.engine.handle({ type: 'state', playing: true, buffering: false, at: h.clock.now });
    changeMetadata(h, song('Three'));

    // The song is 60 s of audio, not the six minutes the wall clock spent on
    // it, so the 50% rule (30 s) applies and the song is submitted.
    expect(h.scrobbles.map((entry) => entry.title)).toEqual(['Two']);
  });

  it('does not learn the song length from filtered metadata', () => {
    const h = harness();

    playSong(h, song('Real one'), 200_000);
    playSong(h, advertisement(), 50_000);
    playSong(h, advertisement(), 50_000);
    playSong(h, advertisement(), 50_000);
    playSong(h, song('Real two'), 200_000);
    playSong(h, song('Real three'), 200_000);
    playSong(h, song('Real four'), 200_000);
    playSong(h, song('Real five'), 200_000);

    // Only the three real songs teach the channel. The announcements would
    // otherwise pull the median down to 125 s.
    expect(h.engine.observedSongCount).toBe(3);
    expect(h.engine.songEstimateMs).toBe(200_000);
    expect(h.engine.effectiveThresholdMs).toBe(100_000);
  });

  it('uses the flat floor when the adaptive estimate is switched off', () => {
    const h = harness({
      thresholdOverrides: { radioAdaptiveEstimate: false, radioMinListenMs: 150_000 },
    });

    playSong(h, song('One'), 60_000);
    playSong(h, song('Two'), 60_000);
    playSong(h, song('Three'), 60_000);

    expect(h.engine.effectiveThresholdMs).toBe(150_000);
    // The song-end rule is part of the adaptive estimate, so the flat floor
    // decides here and the short songs are not submitted.
    expect(h.scrobbles).toHaveLength(0);
  });
});

describe('track state engine', () => {
  let harnessRef: Harness;

  beforeEach(() => {
    harnessRef = harness();
  });

  it('accepts a track after the metadata debounce window', () => {
    changeMetadata(harnessRef, { channel: 'SiriusXM Hits 1', artist: 'Coldplay', title: 'Viva La Vida' });
    expect(harnessRef.engine.state?.normalized.scrobbleArtist).toBe('Coldplay');
    expect(harnessRef.engine.state?.normalized.scrobbleTitle).toBe('Viva La Vida');
  });

  it('ignores repeated metadata', () => {
    changeMetadata(harnessRef, { channel: 'SiriusXM Hits 1', artist: 'Coldplay', title: 'Viva La Vida' });
    const startedAt = harnessRef.engine.state?.startedAt;
    changeMetadata(harnessRef, { channel: 'SiriusXM Hits 1', artist: 'Coldplay', title: 'Viva La Vida' });
    expect(harnessRef.engine.state?.startedAt).toBe(startedAt);
  });

  it('does not count paused time as listening', () => {
    changeMetadata(harnessRef, { channel: 'SiriusXM Hits 1', artist: 'Coldplay', title: 'Viva La Vida' });
    harnessRef.engine.handle({ type: 'state', playing: true, buffering: false, at: harnessRef.clock.now });
    harnessRef.clock.advance(10_000);
    harnessRef.engine.handle({ type: 'tick', at: harnessRef.clock.now });

    harnessRef.engine.handle({ type: 'state', playing: false, buffering: false, at: harnessRef.clock.now });
    harnessRef.clock.advance(60_000);
    harnessRef.engine.handle({ type: 'tick', at: harnessRef.clock.now });

    expect(harnessRef.engine.state?.listeningMs).toBe(10_000);
  });

  it('does not count buffering time as listening', () => {
    changeMetadata(harnessRef, { channel: 'SiriusXM Hits 1', artist: 'Coldplay', title: 'Viva La Vida' });
    harnessRef.engine.handle({ type: 'state', playing: true, buffering: true, at: harnessRef.clock.now });
    harnessRef.clock.advance(60_000);
    harnessRef.engine.handle({ type: 'tick', at: harnessRef.clock.now });
    expect(harnessRef.engine.state?.listeningMs).toBe(0);
  });

  it('scrobbles when the known duration threshold is reached', () => {
    harnessRef = harness();
    changeMetadata(harnessRef, { channel: 'SiriusXM Hits 1', artist: 'Coldplay', title: 'Viva La Vida' });
    harnessRef.engine.setDuration(180_000);
    harnessRef.engine.handle({ type: 'state', playing: true, buffering: false, at: harnessRef.clock.now });
    harnessRef.clock.advance(95_000);
    harnessRef.engine.handle({ type: 'tick', at: harnessRef.clock.now });

    expect(harnessRef.scrobbles).toHaveLength(1);
    expect(harnessRef.scrobbles[0]?.artist).toBe('Coldplay');
    expect(harnessRef.scrobbles[0]?.title).toBe('Viva La Vida');
    expect(harnessRef.scrobbles[0]?.timestamp).toBe(
      Math.floor((harnessRef.engine.state?.startedAt ?? 0) / 1000),
    );
  });

  it('submits a radio track once the radio floor is reached', () => {
    harnessRef = harness();
    changeMetadata(harnessRef, { channel: 'Dave Matthews Band Radio', title: 'Cry - October 1 Boston MA 2020' });
    harnessRef.engine.handle({ type: 'state', playing: true, buffering: false, at: harnessRef.clock.now });
    harnessRef.clock.advance(200_000);
    harnessRef.engine.handle({ type: 'tick', at: harnessRef.clock.now });

    // SiriusXM never publishes a song duration, so the radio floor (150 s of
    // actual playback) is the criterion. The track is submitted without
    // waiting for a song boundary.
    expect(harnessRef.scrobbles).toHaveLength(1);
    expect(harnessRef.scrobbles[0]?.artist).toBe('Dave Matthews Band');
    expect(harnessRef.scrobbles[0]?.title).toBe('Cry (October 1, 2020 – Boston, MA)');
  });

  it('requires a confirmed song boundary when the radio policy is set to strict', () => {
    harnessRef = harness({ thresholdOverrides: { radioRequiresBoundary: true } });
    changeMetadata(harnessRef, { channel: 'Dave Matthews Band Radio', title: 'Cry - October 1 Boston MA 2020' });
    harnessRef.engine.handle({ type: 'state', playing: true, buffering: false, at: harnessRef.clock.now });
    harnessRef.clock.advance(200_000);
    harnessRef.engine.handle({ type: 'tick', at: harnessRef.clock.now });

    // No song boundary yet: the radio track must not be scrobbled.
    expect(harnessRef.scrobbles).toHaveLength(0);

    // The next track confirms the boundary and the previous track is submitted.
    changeMetadata(harnessRef, { channel: 'Dave Matthews Band Radio', title: 'Something Else' });
    expect(harnessRef.scrobbles).toHaveLength(1);
    expect(harnessRef.scrobbles[0]?.artist).toBe('Dave Matthews Band');
    expect(harnessRef.scrobbles[0]?.title).toBe('Cry (October 1, 2020 – Boston, MA)');
  });

  it('does not scrobble advertisements or DJ talk', () => {
    harnessRef = harness();
    changeMetadata(harnessRef, {
      channel: 'SiriusXM Hits 1',
      artist: 'Advertisement',
      title: 'Call now 1-800-555-1234',
    });
    harnessRef.engine.handle({ type: 'state', playing: true, buffering: false, at: harnessRef.clock.now });
    harnessRef.clock.advance(200_000);
    harnessRef.engine.handle({ type: 'tick', at: harnessRef.clock.now });
    changeMetadata(harnessRef, { channel: 'SiriusXM Hits 1', artist: 'Coldplay', title: 'Viva La Vida' });

    expect(harnessRef.scrobbles).toHaveLength(0);
    expect(harnessRef.finalised.some((entry) => entry.artist === 'Advertisement')).toBe(true);
  });

  it('protects against duplicates across sessions', () => {
    // Derive the duplicate key from a first, identical run so that the key
    // really matches the one the engine computes. A hard coded key would not
    // have matched the track start time and the test would have passed
    // without ever reaching the duplicate check.
    const first = harness();
    changeMetadata(first, { channel: 'SiriusXM Hits 1', artist: 'Coldplay', title: 'Viva La Vida' });
    first.engine.handle({ type: 'state', playing: true, buffering: false, at: first.clock.now });
    const key = scrobbleKey('Coldplay', 'Viva La Vida', first.engine.state?.startedAt ?? 0);

    harnessRef = harness({ duplicates: new Set([key]) });
    changeMetadata(harnessRef, { channel: 'SiriusXM Hits 1', artist: 'Coldplay', title: 'Viva La Vida' });
    harnessRef.engine.handle({ type: 'state', playing: true, buffering: false, at: harnessRef.clock.now });
    harnessRef.clock.advance(200_000);
    harnessRef.engine.handle({ type: 'tick', at: harnessRef.clock.now });

    expect(harnessRef.scrobbles).toHaveLength(0);
    expect(harnessRef.engine.state?.scrobbleReason).toContain('Duplicate');
  });

  it('submits a radio track that reached the threshold when the channel changes', () => {
    changeMetadata(harnessRef, { channel: 'SiriusXM Hits 1', artist: 'Coldplay', title: 'Viva La Vida' });
    harnessRef.engine.handle({ type: 'state', playing: true, buffering: false, at: harnessRef.clock.now });
    harnessRef.clock.advance(85_000);
    harnessRef.engine.handle({ type: 'tick', at: harnessRef.clock.now });

    // Below the adaptive threshold: nothing is submitted yet.
    expect(harnessRef.scrobbles).toHaveLength(0);

    harnessRef.clock.advance(10_000);
    harnessRef.engine.handle({ type: 'channel', channel: 'Classic Rewind', at: harnessRef.clock.now });

    // The channel switch is the finalisation point for a track that reached
    // the threshold but had no tick before the switch.
    expect(harnessRef.scrobbles).toHaveLength(1);
    expect(harnessRef.engine.state).toBeUndefined();
    expect(harnessRef.finalised).toHaveLength(1);
  });

  it('does not submit a radio track below the threshold when the channel changes', () => {
    changeMetadata(harnessRef, { channel: 'SiriusXM Hits 1', artist: 'Coldplay', title: 'Viva La Vida' });
    harnessRef.engine.handle({ type: 'state', playing: true, buffering: false, at: harnessRef.clock.now });
    harnessRef.clock.advance(60_000);
    harnessRef.engine.handle({ type: 'tick', at: harnessRef.clock.now });
    harnessRef.engine.handle({ type: 'channel', channel: 'Classic Rewind', at: harnessRef.clock.now });

    expect(harnessRef.scrobbles).toHaveLength(0);
    expect(harnessRef.engine.state).toBeUndefined();
    expect(harnessRef.finalised).toHaveLength(1);
  });

  it('does not scrobble ambiguous metadata', () => {
    harnessRef = harness();
    changeMetadata(harnessRef, { channel: 'SiriusXMU', title: 'Unknown Concert 2020' });
    harnessRef.engine.handle({ type: 'state', playing: true, buffering: false, at: harnessRef.clock.now });
    harnessRef.clock.advance(200_000);
    harnessRef.engine.handle({ type: 'tick', at: harnessRef.clock.now });
    changeMetadata(harnessRef, { channel: 'SiriusXMU', title: 'Another Song' });
    expect(harnessRef.scrobbles).toHaveLength(0);
  });
});
