/**
 * Regression tests for the scrobbling policy decisions of the v2/v3 architecture.
 *
 *   - P1-06  ListenBrainz "now playing" uses the documented schema.
 *   - P1-07  E Street concert broadcasts: a user-confirmed channel mapping is
 *            an allowed artist source, the date/location is stripped from the
 *            submitted title and kept for display, and the v3 settings
 *            migration strips shipped seed mappings while keeping user-created
 *            mappings.
 *   - P2-09  Radio tracks are submitted at the radio floor.
 */

import { describe, expect, it } from 'vitest';

import { resolveProviderMetadata, type ProviderMetadataSnapshot } from '../src/core/metadata/providerRoles';
import { normalizeMetadata } from '../src/core/metadata/normalizer';
import { TrackStateEngine, type ScrobbleCandidate } from '../src/core/playback/trackState';
import {
  DEFAULT_METADATA_CONFIG,
  DEFAULT_THRESHOLDS,
  SETTINGS_VERSION,
  mergeSettings,
} from '../src/core/settings/defaults';
import type { MetadataConfig, RawMetadata } from '../src/core/metadata/types';

function config(overrides: Partial<MetadataConfig> = {}): MetadataConfig {
  return {
    ...DEFAULT_METADATA_CONFIG,
    channelMappings: [
      { channel: 'E Street Radio', artist: 'Bruce Springsteen' },
      { channel: 'Dave Matthews Band Radio', artist: 'Dave Matthews Band' },
    ],
    artistAliases: {},
    manualCorrections: {},
    correctionRules: [],
    ...overrides,
  };
}

/** Run the whole chain and return what the application would show and submit. */
function pipeline(snapshot: ProviderMetadataSnapshot, cfg: MetadataConfig = config()) {
  const resolved = resolveProviderMetadata(snapshot);
  const raw: RawMetadata = {
    channel: resolved.channel,
    artist: resolved.artist,
    title: resolved.rawTitleField,
    origin: 'media-session',
    qualifier: resolved.qualifier,
    programme: resolved.programme,
    channelNumber: resolved.channelNumber,
    evidence: resolved.evidence,
    reasons: resolved.reasons,
    scrobbleSafe: resolved.scrobbleSafe,
    scrobbleBlockReason: resolved.scrobbleBlockReason,
  };
  const normalized = normalizeMetadata(raw, cfg);
  return { resolved, raw, normalized };
}

/** The concert broadcast that was observed live on E Street Radio. */
const E_STREET_CONCERT: ProviderMetadataSnapshot = {
  sessionTitle: 'Bruce Springsteen Concerts · E Street Radio',
  sessionArtist: '12/13/92 Boston, MA - Thunder Road',
};

describe('P1-07 - E Street concert broadcasts', () => {
  it('uses a user-confirmed channel mapping as the artist source', () => {
    const { normalized } = pipeline(E_STREET_CONCERT);

    expect(normalized.scrobbleArtist).toBe('Bruce Springsteen');
    expect(normalized.source).toBe('channel-fallback');
    // The artist was derived, not published - the UI has to be able to say so.
    expect(normalized.evidence).toBe('inferred');
    expect(normalized.ambiguous).toBe(false);
  });

  it('clears the provider block once the mapping supplied the artist', () => {
    const { resolved, normalized } = pipeline(E_STREET_CONCERT);

    // The provider blocks the published artist, because it is a date.
    expect(resolved.scrobbleSafe).toBe(false);
    // The submitted pair is well formed, so it must not stay blocked.
    expect(normalized.scrobbleSafe).toBe(true);
    expect(normalized.scrobbleBlockReason).toBeUndefined();
  });

  it('strips the date and location from the submitted title', () => {
    const { normalized } = pipeline(E_STREET_CONCERT);

    expect(normalized.scrobbleTitle).toBe('Thunder Road');
    expect(normalized.scrobbleTitle).not.toContain('Boston');
    expect(normalized.scrobbleTitle).not.toContain('12/13/92');
  });

  it('keeps the concert information for display only', () => {
    const { normalized } = pipeline(E_STREET_CONCERT);

    expect(normalized.concert?.location).toBe('Boston, MA');
    expect(normalized.concert?.date).toBe('1992-12-13');
    expect(normalized.displayTitle).toContain('Boston, MA');
    expect(normalized.displayTitle).not.toBe(normalized.scrobbleTitle);
  });

  it('does not use an arbitrary channel as an artist source', () => {
    // The same broadcast on a channel the user never mapped stays blocked.
    const { normalized } = pipeline(
      { sessionTitle: 'Some Mix · SiriusXMU 33', sessionArtist: '12/13/92 Boston, MA - Thunder Road' },
      config({ channelMappings: [] }),
    );

    expect(normalized.scrobbleArtist).toBeNull();
    expect(normalized.scrobbleSafe).toBe(false);
    expect(normalized.ambiguous).toBe(true);
  });

  it('leaves a normal E Street record alone', () => {
    const { resolved, normalized } = pipeline({
      sessionTitle: 'E Street Radio · E Street Radio',
      sessionArtist: 'Bruce Springsteen - Atlantic City',
    });

    expect(resolved.scrobbleSafe).toBe(true);
    expect(normalized.scrobbleArtist).toBe('Bruce Springsteen');
    expect(normalized.scrobbleTitle).toBe('Atlantic City');
    expect(normalized.scrobbleSafe).toBe(true);
  });

  it('leaves the Beatles record alone', () => {
    const { normalized } = pipeline({
      sessionTitle: 'The Beatles Channel · The Beatles Channel',
      sessionArtist: "The Beatles - When I'm Sixty-Four",
    });

    expect(normalized.scrobbleArtist).toBe('The Beatles');
    expect(normalized.scrobbleTitle).toBe("When I'm Sixty-Four");
    expect(normalized.scrobbleSafe).toBe(true);
  });
});

describe('P1-07 - the v3 settings migration', () => {
  it('strips unmodified shipped v1/v2 seed mappings while preserving user-created mappings', () => {
    const stored = {
      settingsVersion: 2,
      metadata: {
        channelMappings: [
          { channel: 'Dave Matthews Band Radio', artist: 'Dave Matthews Band' },
          { channel: 'Pearl Jam Radio', artist: 'Pearl Jam' },
          { channel: 'E Street Radio', artist: 'Bruce Springsteen' },
          { channel: 'My Custom Artist Radio', artist: 'My Custom Artist' },
        ],
      },
    };

    const merged = mergeSettings(stored);
    const channels = merged.metadata.channelMappings.map((m) => m.channel);

    expect(channels).toEqual(['My Custom Artist Radio']);
  });

  it('preserves mappings once migrated to v3', () => {
    const stored = {
      settingsVersion: SETTINGS_VERSION,
      metadata: {
        channelMappings: [
          { channel: 'E Street Radio', artist: 'Bruce Springsteen' },
        ],
      },
    };

    const merged = mergeSettings(stored);
    const channels = merged.metadata.channelMappings.map((m) => m.channel);

    expect(channels).toEqual(['E Street Radio']);
  });

  it('records the version so the migration runs only once', () => {
    const merged = mergeSettings({ settingsVersion: 1 });
    expect(merged.settingsVersion).toBe(SETTINGS_VERSION);
  });

  it('respects a radio policy the user chose in the current version', () => {
    const merged = mergeSettings({
      settingsVersion: SETTINGS_VERSION,
      thresholds: { radioRequiresBoundary: true },
    });
    expect(merged.thresholds.radioRequiresBoundary).toBe(true);
  });
});

describe('P2-09 - radio eligibility', () => {
  it('submits an E Street concert track once the adaptive radio threshold is reached', () => {
    const scrobbles: ScrobbleCandidate[] = [];
    let now = 1_700_000_000_000;
    const engine = new TrackStateEngine({
      thresholds: { ...DEFAULT_THRESHOLDS, metadataDebounceMs: 1000 },
      config: config(),
      now: () => now,
      onScrobble: (candidate) => scrobbles.push(candidate),
    });

    const resolved = resolveProviderMetadata(E_STREET_CONCERT);
    engine.handle({
      type: 'metadata',
      at: now,
      raw: {
        channel: resolved.channel,
        artist: resolved.artist,
        title: resolved.rawTitleField,
        scrobbleSafe: resolved.scrobbleSafe,
        scrobbleBlockReason: resolved.scrobbleBlockReason,
      },
    });
    engine.handle({ type: 'state', playing: true, buffering: false, at: now });

    now += 1000;
    engine.handle({ type: 'tick', at: now });
    now += 88_000;
    engine.handle({ type: 'tick', at: now });
    // 88 s of playback is still below the adaptive threshold (50% of the
    // 180 s song length that is assumed before a channel has been observed).
    expect(scrobbles).toHaveLength(0);

    now += 2_000;
    engine.handle({ type: 'tick', at: now });

    expect(scrobbles).toHaveLength(1);
    expect(scrobbles[0]?.artist).toBe('Bruce Springsteen');
    expect(scrobbles[0]?.title).toBe('Thunder Road');
  });
});
