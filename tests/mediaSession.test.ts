import { describe, expect, it } from 'vitest';

import {
  normalizeMojibake,
  resolveMediaSessionMetadata,
  splitChannelProgramme,
  splitCombinedArtistSong,
} from '../src/core/metadata/mediaSession';
import { normalizeMetadata } from '../src/core/metadata/normalizer';
import { DEFAULT_METADATA_CONFIG } from '../src/core/settings/defaults';
import type { MetadataConfig, RawMetadata } from '../src/core/metadata/types';

function runFull(sessionTitle: string | null, sessionArtist: string | null, overrides: Partial<MetadataConfig> = {}) {
  const resolved = resolveMediaSessionMetadata({ sessionTitle, sessionArtist });
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
  const cfg: MetadataConfig = {
    ...DEFAULT_METADATA_CONFIG,
    ...overrides,
  };
  const normalized = normalizeMetadata(raw, cfg);
  return { resolved, normalized };
}

describe('MediaSession metadata bridge parser (live SiriusXM formats)', () => {
  it('parses The Beatles Channel live format and strips year qualifier', () => {
    const { resolved, normalized } = runFull(
      'The Beatles Channel · The Beatles Channel',
      "The Beatles - Mother Nature's Son",
    );

    expect(resolved.channel).toBe('The Beatles Channel');
    expect(resolved.programme).toBeNull();
    expect(resolved.artist).toBe('The Beatles');
    expect(resolved.title).toBe("Mother Nature's Son");
    expect(resolved.scrobbleSafe).toBe(true);
    expect(normalized.scrobbleArtist).toBe('The Beatles');
    expect(normalized.scrobbleTitle).toBe("Mother Nature's Son");
  });

  it('preserves exact provider spelling on E Street Radio ("Folllow That Dream")', () => {
    const { resolved, normalized } = runFull(
      'E Street Radio · E Street Radio',
      'Bruce Springsteen - Folllow That Dream',
    );

    expect(resolved.channel).toBe('E Street Radio');
    expect(resolved.artist).toBe('Bruce Springsteen');
    expect(resolved.title).toBe('Folllow That Dream');
    expect(resolved.scrobbleSafe).toBe(true);
    expect(normalized.scrobbleArtist).toBe('Bruce Springsteen');
    expect(normalized.scrobbleTitle).toBe('Folllow That Dream');
  });

  it('normalizes mojibake middle-dot separators (Â· and â€¢)', () => {
    expect(normalizeMojibake('The Beatles Channel Â· The Beatles Channel')).toBe(
      'The Beatles Channel · The Beatles Channel',
    );
    expect(splitChannelProgramme('Bruce Springsteen Concerts Â· E Street Radio')).toEqual({
      channel: 'E Street Radio',
      programme: 'Bruce Springsteen Concerts',
    });
  });

  it('blocks hashtags, phone numbers, and show promos from scrobbling', () => {
    const hashtag = runFull(
      'Fab Fourum · The Beatles Channel',
      '#FabFourum - 844.999.2328',
    );
    expect(hashtag.resolved.scrobbleSafe).toBe(false);
    expect(hashtag.normalized.scrobbleSafe).toBe(false);

    const hostHashtag = runFull(
      'Peter Asher: From Me To You · The Beatles Channel',
      'Peter Asher - #FromMeToYou',
    );
    expect(hostHashtag.resolved.scrobbleSafe).toBe(false);
    expect(hostHashtag.normalized.scrobbleSafe).toBe(false);

    const promo = runFull(
      'The Beatles Channel · The Beatles Channel',
      'Zoey Deutch - Beatlemania!!',
    );
    expect(promo.resolved.scrobbleSafe).toBe(false);
  });

  it('blocks concert date/city prefix when no user channel mapping is configured', () => {
    const unmapped = runFull(
      'Bruce Springsteen Concerts · E Street Radio',
      '12/13/92 Boston, MA - Bobby Jean',
    );
    expect(unmapped.resolved.scrobbleSafe).toBe(false);
    expect(unmapped.normalized.scrobbleSafe).toBe(false);
    expect(unmapped.normalized.scrobbleArtist).toBeNull();
  });

  it('resolves concert date/city prefix when the user configures a channel artist mapping', () => {
    const mapped = runFull(
      'Bruce Springsteen Concerts · E Street Radio',
      '12/13/92 Boston, MA - Bobby Jean',
      {
        channelMappings: [{ channel: 'E Street Radio', artist: 'Bruce Springsteen' }],
      },
    );
    expect(mapped.normalized.scrobbleSafe).toBe(true);
    expect(mapped.normalized.scrobbleArtist).toBe('Bruce Springsteen');
    expect(mapped.normalized.scrobbleTitle).toBe('Bobby Jean');
  });

  it('splits combined artist and song only on the first dash', () => {
    expect(splitCombinedArtistSong('Paul McCartney & Wings - Band on the Run - Live')).toEqual({
      artist: 'Paul McCartney & Wings',
      song: 'Band on the Run - Live',
    });
  });
});
