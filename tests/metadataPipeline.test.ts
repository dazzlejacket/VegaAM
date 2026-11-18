/**
 * Full pipeline regression tests.
 *
 * Every test drives the same chain the application uses at runtime:
 *
 *   MediaSession snapshot -> semantic resolution -> normalisation
 *     -> playback view -> scrobble payload
 */

import { describe, expect, it } from 'vitest';

import {
  resolveProviderMetadata,
  splitChannelProgramme,
  splitCombinedArtistSong,
  splitTrailingQualifier,
  stripChannelNumberPrefix,
  type ProviderMetadataSnapshot,
} from '../src/core/metadata/providerRoles';
import { normalizeMetadata } from '../src/core/metadata/normalizer';
import { TrackStateEngine, type ScrobbleCandidate } from '../src/core/playback/trackState';
import { DEFAULT_METADATA_CONFIG, DEFAULT_THRESHOLDS, mergeSettings } from '../src/core/settings/defaults';
import type { MetadataConfig, RawMetadata } from '../src/core/metadata/types';

function config(overrides: Partial<MetadataConfig> = {}): MetadataConfig {
  return {
    ...DEFAULT_METADATA_CONFIG,
    channelMappings: DEFAULT_METADATA_CONFIG.channelMappings.map((m) => ({ ...m })),
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

describe('field separation - the roles the official player publishes', () => {
  it('splits "<programme> · <channel>" and drops a repeated channel', () => {
    expect(splitChannelProgramme('The Beatles Channel · The Beatles Channel')).toEqual({
      channel: 'The Beatles Channel',
      programme: null,
    });
    expect(splitChannelProgramme('Deep Tracks · Deep Tracks')).toEqual({
      channel: 'Deep Tracks',
      programme: null,
    });
    // Observed on the live player: the programme comes first.
    expect(splitChannelProgramme('Bruce Springsteen Concerts · E Street Radio')).toEqual({
      channel: 'E Street Radio',
      programme: 'Bruce Springsteen Concerts',
    });
  });

  it('splits "<artist> - <song>" on the first separator only', () => {
    expect(splitCombinedArtistSong('The Beatles - When I\'m Sixty-Four (67)')).toEqual({
      artist: 'The Beatles',
      song: 'When I\'m Sixty-Four (67)',
    });
    expect(splitCombinedArtistSong('Moby Grape - Trucking Man')).toEqual({
      artist: 'Moby Grape',
      song: 'Trucking Man',
    });
    // A song that contains a dash keeps its own dash.
    expect(splitCombinedArtistSong('XTC - Letter to Jane - Live')).toEqual({
      artist: 'XTC',
      song: 'Letter to Jane - Live',
    });
  });

  it('separates a trailing numeric tag without losing it', () => {
    expect(splitTrailingQualifier('When I\'m Sixty-Four (67)')).toEqual({
      title: 'When I\'m Sixty-Four',
      qualifier: '(67)',
    });
    expect(splitTrailingQualifier('Unbelievable (91)')).toEqual({
      title: 'Unbelievable',
      qualifier: '(91)',
    });
    // A version marker is not a tag.
    expect(splitTrailingQualifier('Stronger (Remix)')).toEqual({
      title: 'Stronger (Remix)',
      qualifier: null,
    });
  });
});

describe('full pipeline - live observations', () => {
  it('The Beatles Channel - The Beatles - When I\'m Sixty-Four', () => {
    const { resolved, normalized } = pipeline({
      sessionTitle: 'The Beatles Channel · The Beatles Channel',
      sessionArtist: "The Beatles - When I'm Sixty-Four (67)",
      sessionAlbum: '',
    });

    expect(resolved.channel).toBe('The Beatles Channel');
    expect(resolved.artist).toBe('The Beatles');
    expect(resolved.title).toBe("When I'm Sixty-Four");
    // The raw suffix is preserved, not destroyed.
    expect(resolved.rawTitleField).toBe("When I'm Sixty-Four (67)");
    expect(resolved.qualifier).toBe('(67)');

    expect(normalized.artist).toBe('The Beatles');
    expect(normalized.title).toBe("When I'm Sixty-Four");
    expect(normalized.scrobbleArtist).toBe('The Beatles');
    expect(normalized.scrobbleTitle).toBe("When I'm Sixty-Four");
    expect(resolved.scrobbleSafe).toBe(true);
  });

  it('Deep Tracks - Fat Mattress - Mr. Moonshine', () => {
    const { resolved, normalized } = pipeline({
      sessionTitle: 'Deep Tracks · Deep Tracks',
      sessionArtist: 'Fat Mattress - Mr. Moonshine',
    });

    expect(resolved.channel).toBe('Deep Tracks');
    expect(resolved.artist).toBe('Fat Mattress');
    expect(resolved.title).toBe('Mr. Moonshine');
    expect(normalized.scrobbleArtist).toBe('Fat Mattress');
    expect(normalized.scrobbleTitle).toBe('Mr. Moonshine');
  });

  it('Deep Tracks - The Who - My Wife', () => {
    const { resolved, normalized } = pipeline({
      sessionTitle: 'Deep Tracks · Deep Tracks',
      sessionArtist: 'The Who - My Wife',
    });

    expect(resolved.channel).toBe('Deep Tracks');
    expect(resolved.artist).toBe('The Who');
    expect(resolved.title).toBe('My Wife');
    expect(normalized.scrobbleArtist).toBe('The Who');
    expect(normalized.scrobbleTitle).toBe('My Wife');
  });

  it('E Street Radio - Bruce Springsteen - Atlantic City', () => {
    const { resolved, normalized } = pipeline({
      sessionTitle: 'E Street Radio · E Street Radio',
      sessionArtist: 'Bruce Springsteen - Atlantic City',
    });

    expect(resolved.channel).toBe('E Street Radio');
    expect(resolved.artist).toBe('Bruce Springsteen');
    expect(resolved.title).toBe('Atlantic City');
    expect(normalized.scrobbleArtist).toBe('Bruce Springsteen');
    expect(normalized.scrobbleTitle).toBe('Atlantic City');
  });

  it('never uses the channel as the artist or the song', () => {
    const { resolved } = pipeline({
      sessionTitle: 'Deep Tracks · Deep Tracks',
      sessionArtist: 'Deep Tracks - Deep Tracks',
    });

    expect(resolved.artist).toBeNull();
    expect(resolved.title).toBeNull();
    expect(resolved.scrobbleSafe).toBe(false);
  });
});

describe('full pipeline - artist channel with concert metadata', () => {
  it('keeps the artist of an artist branded channel', () => {
    const { resolved, normalized } = pipeline({
      sessionTitle: 'Bruce Springsteen · Bruce Springsteen',
      sessionArtist: 'Bruce Springsteen - Born To Run',
    });

    expect(resolved.channel).toBe('Bruce Springsteen');
    expect(resolved.artist).toBe('Bruce Springsteen');
    expect(resolved.title).toBe('Born To Run');
    expect(normalized.scrobbleArtist).toBe('Bruce Springsteen');
  });

  it('reads the concert broadcast of an artist channel', () => {
    // Observed live on E Street Radio.
    const { resolved } = pipeline({
      sessionTitle: 'Bruce Springsteen Concerts · E Street Radio',
      sessionArtist: '12/13/92 Boston, MA - Bobby Jean',
    });

    expect(resolved.channel).toBe('E Street Radio');
    expect(resolved.programme).toBe('Bruce Springsteen Concerts');
    // The first half is a date and a location, not an artist.
    expect(resolved.artist).toBe('12/13/92 Boston, MA');
    expect(resolved.scrobbleSafe).toBe(false);
  });

  it('extracts the concert information instead of using it as the artist', () => {
    const { resolved, normalized } = pipeline({
      sessionTitle: 'Dave Matthews Band Radio · Dave Matthews Band Radio',
      sessionArtist: 'Dave Matthews Band - Cry - October 1 Boston MA 2020',
    });

    expect(resolved.channel).toBe('Dave Matthews Band Radio');
    expect(resolved.artist).toBe('Dave Matthews Band');
    expect(normalized.concert?.date).toBe('2020-10-01');
    expect(normalized.concert?.location).toBe('Boston, MA');
    expect(normalized.scrobbleArtist).toBe('Dave Matthews Band');
  });
});

describe('full pipeline - programme only metadata', () => {
  it('does not invent an artist when the player publishes a programme', () => {
    const { resolved, normalized } = pipeline({
      sessionTitle: 'Opie and Anthony · SiriusXM Comedy',
      sessionArtist: 'Opie and Anthony - Opie and Anthony',
    });

    // The "song" repeats the programme, so it is not a song.
    expect(resolved.title).toBeNull();
    expect(resolved.scrobbleSafe).toBe(false);
    expect(normalized.scrobbleArtist).toBeNull();
  });

  it('does not invent an artist when nothing is published at all', () => {
    const { resolved, normalized } = pipeline({
      sessionTitle: null,
      sessionArtist: null,
    });

    expect(resolved.artist).toBeNull();
    expect(resolved.title).toBeNull();
    expect(resolved.evidence).toBe('none');
    expect(normalized.skip).toBe(true);
  });
});

describe('channel number stripping helper', () => {
  it('removes the channel number of a structured header', () => {
    for (const header of [
      'Ch 18 · The Beatles Channel',
      'Ch 18 • The Beatles Channel',
      'Ch 18 - The Beatles Channel',
      'Ch 18 – The Beatles Channel',
      'Ch 18: The Beatles Channel',
    ]) {
      expect(stripChannelNumberPrefix(header)).toBe('The Beatles Channel');
    }
  });

  it('keeps a name that only looks like a channel number', () => {
    expect(stripChannelNumberPrefix('Channel 43')).toBe('Channel 43');
    expect(stripChannelNumberPrefix(null)).toBeNull();
  });
});

describe('scrobble payload', () => {
  function runEngine(snapshot: ProviderMetadataSnapshot, cfg = config()) {
    const candidates: ScrobbleCandidate[] = [];
    const engine = new TrackStateEngine({
      thresholds: {
        ...DEFAULT_THRESHOLDS,
        metadataDebounceMs: 0,
        radioMinListenMs: 1000,
        radioAdaptiveEstimate: false,
        radioRequiresBoundary: false,
      },
      config: cfg,
      now: () => clock,
      onScrobble: (candidate) => candidates.push(candidate),
    });
    let clock = 1000;
    const resolved = resolveProviderMetadata(snapshot);
    const raw: RawMetadata = {
      channel: resolved.channel,
      artist: resolved.artist,
      title: resolved.rawTitleField,
      evidence: resolved.evidence,
      scrobbleSafe: resolved.scrobbleSafe,
      scrobbleBlockReason: resolved.scrobbleBlockReason,
    };
    engine.handle({ type: 'metadata', raw, at: clock });
    engine.handle({ type: 'state', playing: true, buffering: false, at: clock });
    clock = 5000;
    engine.handle({ type: 'tick', at: clock });
    return { engine, candidates, resolved };
  }

  it('submits the corrected artist and title', () => {
    const { candidates } = runEngine({
      sessionTitle: 'The Beatles Channel · The Beatles Channel',
      sessionArtist: "The Beatles - When I'm Sixty-Four (67)",
    });

    expect(candidates).toHaveLength(1);
    expect(candidates[0]?.artist).toBe('The Beatles');
    expect(candidates[0]?.title).toBe("When I'm Sixty-Four");
  });

  it('never submits a malformed artist/title pair', () => {
    const { candidates, resolved } = runEngine({
      sessionTitle: 'Deep Tracks · Deep Tracks',
      sessionArtist: 'Deep Tracks - Deep Tracks',
    });

    expect(resolved.scrobbleSafe).toBe(false);
    expect(candidates).toHaveLength(0);
  });
});

describe('state continuity', () => {
  it('keeps the track and the listening progress when a setting changes', () => {
    let clock = 1000;
    const scrobbled: ScrobbleCandidate[] = [];
    const engine = new TrackStateEngine({
      thresholds: {
        ...DEFAULT_THRESHOLDS,
        metadataDebounceMs: 0,
        radioMinListenMs: 1000,
        radioAdaptiveEstimate: false,
        radioRequiresBoundary: false,
      },
      config: config(),
      now: () => clock,
      onScrobble: (candidate) => scrobbled.push(candidate),
    });

    const resolved = resolveProviderMetadata({
      sessionTitle: 'The Beatles Channel · The Beatles Channel',
      sessionArtist: "The Beatles - When I'm Sixty-Four (67)",
    });
    engine.handle({
      type: 'metadata',
      at: clock,
      raw: {
        channel: resolved.channel,
        artist: resolved.artist,
        title: resolved.rawTitleField,
        evidence: resolved.evidence,
        scrobbleSafe: resolved.scrobbleSafe,
      },
    });
    engine.handle({ type: 'state', playing: true, buffering: false, at: clock });

    clock = 4000;
    engine.handle({ type: 'tick', at: clock });
    const listeningBefore = engine.state?.listeningMs ?? 0;
    expect(listeningBefore).toBeGreaterThan(0);

    // A colour mode change must not interrupt the listen.
    engine.configure({ config: config({ concertInScrobbleTitle: 'never' }) });

    expect(engine.state?.raw.artist).toBe('The Beatles');
    expect(engine.state?.listeningMs).toBe(listeningBefore);

    clock = 6000;
    engine.handle({ type: 'tick', at: clock });
    expect(scrobbled).toHaveLength(1);
    expect(scrobbled[0]?.artist).toBe('The Beatles');
    expect(scrobbled[0]?.title).toBe("When I'm Sixty-Four");
  });

  it('applies a manual correction to the track that is about to be submitted', () => {
    let clock = 1000;
    const scrobbled: ScrobbleCandidate[] = [];
    const engine = new TrackStateEngine({
      thresholds: {
        ...DEFAULT_THRESHOLDS,
        metadataDebounceMs: 0,
        radioMinListenMs: 1000,
        radioAdaptiveEstimate: false,
        radioRequiresBoundary: false,
      },
      config: config(),
      now: () => clock,
      onScrobble: (candidate) => scrobbled.push(candidate),
    });

    const raw: RawMetadata = {
      channel: 'Deep Tracks',
      artist: 'Fat Mattress',
      title: 'Mr. Moonshine',
      evidence: 'split',
      scrobbleSafe: true,
    };
    engine.handle({ type: 'metadata', raw, at: clock });
    engine.handle({ type: 'state', playing: true, buffering: false, at: clock });

    // The user remembers a correction for this track.
    const corrections = {
      'fat mattress mr moonshine': { artist: 'Fat Mattress', title: 'Mr. Moonshine (Remastered)' },
    };
    engine.configure({ config: config({ manualCorrections: corrections }) });
    engine.reapplyConfig();

    expect(engine.state?.normalized.scrobbleTitle).toBe('Mr. Moonshine (Remastered)');

    clock = 4000;
    engine.handle({ type: 'tick', at: clock });
    expect(scrobbled).toHaveLength(1);
    expect(scrobbled[0]?.title).toBe('Mr. Moonshine (Remastered)');
  });
});

describe('settings migration - the removed numeric confidence threshold', () => {
  it('drops a legacy confidence threshold instead of translating it', () => {
    const merged = mergeSettings({
      theme: 'modern',
      colorMode: 'light',
      metadata: {
        ...DEFAULT_METADATA_CONFIG,
        // A settings file written by the old build.
        minConfidence: 0.55,
      },
    });

    expect('minConfidence' in (merged.metadata as unknown as Record<string, unknown>)).toBe(false);
    expect(merged.metadata.requireVerifiedMetadata).toBe(false);
  });

  it('keeps every value the user set while migrating v2 keys to v3', () => {
    const merged = mergeSettings({
      theme: 'classic',
      colorMode: 'light',
      volume: 0.45,
      favoriteChannels: ['Deep Tracks'],
      mutedChannels: ['E Street Radio'],
      windowBounds: { x: 130, y: 40, width: 1180, height: 780 },
      metadata: {
        ...DEFAULT_METADATA_CONFIG,
        minConfidence: 0.55,
        concertInScrobbleTitle: 'never',
      },
    });

    expect(merged.skinId).toBe('classic-compact');
    expect(merged.colorMode).toBe('light');
    expect(merged.scrobbleMutedChannels).toEqual(['E Street Radio']);
    expect(merged.windowState.main).toEqual({ x: 130, y: 40, width: 1180, height: 780 });
    expect(merged.metadata.concertInScrobbleTitle).toBe('never');
    expect('minConfidence' in (merged.metadata as unknown as Record<string, unknown>)).toBe(false);
    expect('favoriteChannels' in (merged as unknown as Record<string, unknown>)).toBe(false);
  });

  it('leaves a settings file without the legacy key untouched', () => {
    const merged = mergeSettings({ theme: 'modern', colorMode: 'dark' });
    expect('minConfidence' in (merged.metadata as unknown as Record<string, unknown>)).toBe(false);
    expect(merged.metadata.requireVerifiedMetadata).toBe(false);
  });
});
