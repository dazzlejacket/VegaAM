/**
 * Regression tests for the tagging quality defects:
 *
 *   1. A manual correction that the user typed from the interface (the names
 *      they see) must apply to the broadcast - including the case where the
 *      player published a date/location in the artist field.
 *   2. A channel mapping must also match a decorated channel name such as
 *      "Bruce Springsteen / E Street Radio".
 *   3. The album the player publishes must survive into the scrobble.
 *   4. An artist alias must rename the artist that is scrobbled.
 *   5. The album-label form (`From "The Rising" - My City Of Ruins`) must
 *      never be scrobbled as an artist.
 */

import { describe, expect, it } from 'vitest';

import { findChannelMapping } from '../src/core/metadata/channelFallback';
import {
  resolveProviderMetadata,
  type ProviderMetadataSnapshot,
} from '../src/core/metadata/mediaSession';
import { withManualCorrection } from '../src/core/metadata/manualCorrections';
import { normalizeMetadata } from '../src/core/metadata/normalizer';
import { DEFAULT_METADATA_CONFIG } from '../src/core/settings/defaults';
import type { MetadataConfig, RawMetadata } from '../src/core/metadata/types';

function config(overrides: Partial<MetadataConfig> = {}): MetadataConfig {
  return { ...DEFAULT_METADATA_CONFIG, ...overrides };
}

/** Run the whole chain, exactly like the application does. */
function pipeline(snapshot: ProviderMetadataSnapshot, cfg: MetadataConfig = config()) {
  const resolved = resolveProviderMetadata(snapshot);
  const raw: RawMetadata = {
    channel: resolved.channel,
    artist: resolved.artist,
    title: resolved.rawTitleField ?? snapshot.sessionArtist ?? null,
    album: resolved.album,
    origin: 'media-session',
    receivedAt: 0,
    evidence: resolved.evidence,
    reasons: resolved.reasons,
    scrobbleSafe: resolved.scrobbleSafe,
    scrobbleBlockReason: resolved.scrobbleBlockReason,
  };
  return { resolved, raw, normalized: normalizeMetadata(raw, cfg) };
}

/** The concert broadcast of E Street Radio, as the player publishes it. */
const CONCERT_BROADCAST: ProviderMetadataSnapshot = {
  sessionTitle: 'Bruce Springsteen Concerts · E Street Radio',
  sessionArtist: '2/14/23 Houston, TX - Badlands',
};

const E_STREET_MAPPING = [{ channel: 'E Street Radio', artist: 'Bruce Springsteen' }];

/**
 * The album-label broadcast of E Street Radio, exactly as the official player
 * published it: the album stands where the artist would be.
 */
const ALBUM_LABEL_BROADCAST: ProviderMetadataSnapshot = {
  sessionTitle: 'Bruce Springsteen Concerts · E Street Radio',
  sessionArtist: 'From "The Rising" — My City Of Ruins',
};

describe('E Street Radio tagging', () => {
  it('uses the channel mapping when the artist field carries a date and location', () => {
    const { normalized } = pipeline(
      CONCERT_BROADCAST,
      config({ channelMappings: E_STREET_MAPPING }),
    );

    expect(normalized.scrobbleArtist).toBe('Bruce Springsteen');
    expect(normalized.scrobbleTitle).toBe('Badlands');
    expect(normalized.source).toBe('channel-fallback');
    expect(normalized.scrobbleSafe).toBe(true);
  });

  it('matches a mapping when the player publishes a decorated channel name', () => {
    const mapping = findChannelMapping('Bruce Springsteen / E Street Radio', E_STREET_MAPPING);
    expect(mapping?.artist).toBe('Bruce Springsteen');
  });

  it('matches a mapping the user typed with a longer channel name', () => {
    // The player publishes "E Street Radio", the user mapped the decorated
    // name they saw in the interface.
    const mapping = findChannelMapping('E Street Radio', [
      { channel: 'Bruce Springsteen / E Street Radio', artist: 'Bruce Springsteen' },
    ]);
    expect(mapping?.artist).toBe('Bruce Springsteen');
  });

  it('prefers the most specific mapping', () => {
    const mapping = findChannelMapping('Bruce Springsteen / E Street Radio', [
      { channel: 'E Street Radio', artist: 'Bruce Springsteen' },
      { channel: 'Bruce Springsteen / E Street Radio', artist: 'Bruce Springsteen & The E Street Band' },
    ]);
    expect(mapping?.artist).toBe('Bruce Springsteen & The E Street Band');
  });
});

describe('manual corrections reach the track they were made for', () => {
  it('applies a correction that was typed from the interface', () => {
    // The user sees "Bruce Springsteen" and "Badlands" in the interface and
    // corrects the artist. The broadcast published "2/14/23 Houston, TX" in
    // the artist field, so the correction must be found by the displayed pair.
    const corrections = withManualCorrection({}, 'Bruce Springsteen', 'Badlands', {
      artist: 'Bruce Springsteen',
      title: 'Badlands',
    });

    const { normalized } = pipeline(
      CONCERT_BROADCAST,
      config({ channelMappings: E_STREET_MAPPING, manualCorrections: corrections }),
    );

    expect(normalized.scrobbleArtist).toBe('Bruce Springsteen');
    expect(normalized.scrobbleTitle).toBe('Badlands');
    expect(normalized.source).toBe('manual');
  });

  it('applies a correction that was saved for the song title alone', () => {
    const corrections = withManualCorrection({}, null, 'Badlands', {
      artist: 'Bruce Springsteen',
      title: 'Badlands',
    });

    const { normalized } = pipeline(
      CONCERT_BROADCAST,
      config({ channelMappings: E_STREET_MAPPING, manualCorrections: corrections }),
    );

    expect(normalized.scrobbleArtist).toBe('Bruce Springsteen');
    expect(normalized.scrobbleTitle).toBe('Badlands');
    expect(normalized.source).toBe('manual');
  });

  it('applies a correction that was saved for the raw broadcast pair', () => {
    const corrections = withManualCorrection({}, '2/14/23 Houston, TX', 'Badlands', {
      artist: 'Bruce Springsteen',
      title: 'Badlands',
    });

    const { normalized } = pipeline(
      CONCERT_BROADCAST,
      config({ manualCorrections: corrections }),
    );

    expect(normalized.scrobbleArtist).toBe('Bruce Springsteen');
    expect(normalized.scrobbleTitle).toBe('Badlands');
    expect(normalized.source).toBe('manual');
  });

  it('does not apply a correction that belongs to another song', () => {
    const corrections = withManualCorrection({}, null, 'Another Song', {
      artist: 'Someone Else',
      title: 'Another Song',
    });

    const { normalized } = pipeline(
      CONCERT_BROADCAST,
      config({ channelMappings: E_STREET_MAPPING, manualCorrections: corrections }),
    );

    expect(normalized.source).not.toBe('manual');
    expect(normalized.scrobbleArtist).toBe('Bruce Springsteen');
  });
});

describe('scrobble tag quality', () => {
  it('keeps the album the player published', () => {
    const { resolved, normalized } = pipeline({
      sessionTitle: 'E Street Radio',
      sessionArtist: 'Bruce Springsteen - Born To Run',
      sessionAlbum: 'Born To Run',
    });

    expect(resolved.album).toBe('Born To Run');
    expect(normalized.album).toBe('Born To Run');
  });

  it('renames the artist with an alias', () => {
    const { normalized } = pipeline(
      {
        sessionTitle: 'E Street Radio',
        sessionArtist: 'Bruce Springsteen & The E Street Band - Born To Run',
      },
      config({
        // The alias key is the normalised broadcast name, exactly as the
        // settings interface stores it.
        artistAliases: { 'bruce springsteen the e street band': 'Bruce Springsteen' },
      }),
    );

    expect(normalized.scrobbleArtist).toBe('Bruce Springsteen');
  });
});

describe('the album-label form of the official player', () => {
  it('reads the album label as the album and never as the artist', () => {
    const { resolved, normalized } = pipeline(
      ALBUM_LABEL_BROADCAST,
      config({ channelMappings: E_STREET_MAPPING }),
    );

    // The album label is the album.
    expect(resolved.album).toBe('The Rising');
    expect(normalized.album).toBe('The Rising');
    // The artist comes from the channel mapping, not from the label.
    expect(normalized.scrobbleArtist).toBe('Bruce Springsteen');
    expect(normalized.scrobbleTitle).toBe('My City Of Ruins');
    expect(normalized.source).toBe('channel-fallback');
    expect(normalized.scrobbleSafe).toBe(true);
    // The published string stays visible in the diagnostics.
    expect(normalized.raw.artist).toBe('From "The Rising"');
  });

  it('keeps the song title intact when it carries a dash', () => {
    const { normalized } = pipeline(
      {
        sessionTitle: 'Bruce Springsteen Concerts · E Street Radio',
        sessionArtist: 'From "The Rising" — Thunder Road - Live',
      },
      config({ channelMappings: E_STREET_MAPPING }),
    );

    expect(normalized.scrobbleArtist).toBe('Bruce Springsteen');
    expect(normalized.scrobbleTitle).toBe('Thunder Road - Live');
  });

  it('keeps the bracket that belongs to the song title', () => {
    // "Further On (Up The Road)" is the song. The bracket is part of the
    // title and must not be dropped because the artist is unknown.
    const { normalized } = pipeline(
      {
        sessionTitle: 'Bruce Springsteen Concerts · E Street Radio',
        sessionArtist: 'From "The Rising" — Further On (Up The Road)',
      },
      config({ channelMappings: E_STREET_MAPPING }),
    );

    expect(normalized.scrobbleArtist).toBe('Bruce Springsteen');
    expect(normalized.scrobbleTitle).toBe('Further On (Up The Road)');
  });

  it('never scrobbles the album label as an artist', () => {
    // Without a channel mapping the artist stays unknown - the album label
    // must not become the artist of the scrobble.
    const { normalized } = pipeline(ALBUM_LABEL_BROADCAST);

    expect(normalized.scrobbleArtist).toBeNull();
    expect(normalized.scrobbleTitle).toBe('My City Of Ruins');
    expect(normalized.album).toBe('The Rising');
  });

  it('does not mistake a song that starts with "From" for an album label', () => {
    // "From Me To You" is a song title, not an album label: the album name
    // has to be quoted.
    const { resolved } = pipeline({
      sessionTitle: 'The Beatles Channel · The Beatles Channel',
      sessionArtist: 'The Beatles - From Me To You',
    });

    expect(resolved.artist).toBe('The Beatles');
    expect(resolved.title).toBe('From Me To You');
    expect(resolved.album).toBeNull();
  });
});
