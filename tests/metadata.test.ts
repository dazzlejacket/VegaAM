import { describe, expect, it } from 'vitest';

import { normalizeMetadata } from '../src/core/metadata/normalizer';
import { DEFAULT_METADATA_CONFIG } from '../src/core/settings/defaults';
import type { MetadataConfig, RawMetadata } from '../src/core/metadata/types';

function config(overrides: Partial<MetadataConfig> = {}): MetadataConfig {
  return {
    ...DEFAULT_METADATA_CONFIG,
    channelMappings: [
      { channel: 'Dave Matthews Band Radio', artist: 'Dave Matthews Band' },
    ],
    artistAliases: {},
    manualCorrections: {},
    correctionRules: [],
    ...overrides,
  };
}

function raw(partial: RawMetadata): RawMetadata {
  return { channel: null, artist: null, title: null, ...partial };
}

describe('acceptance test - Dave Matthews Band Radio', () => {
  it('never submits the concert information as the artist', () => {
    const result = normalizeMetadata(
      raw({ channel: 'Dave Matthews Band Radio', title: 'Cry - October 1 Boston MA 2020' }),
      config(),
    );

    expect(result.artist).toBe('Dave Matthews Band');
    expect(result.scrobbleArtist).toBe('Dave Matthews Band');
    expect(result.title).toBe('Cry');
    expect(result.scrobbleTitle).toBe('Cry (October 1, 2020 – Boston, MA)');
    expect(result.scrobbleArtist).not.toBe('October 1 Boston MA 2020');
    expect(result.concert?.date).toBe('2020-10-01');
    expect(result.concert?.dateText).toBe('October 1, 2020');
    expect(result.concert?.location).toBe('Boston, MA');
    expect(result.source).toBe('channel-fallback');
    expect(result.skip).toBeFalsy();
  });

  it('keeps the concert details in the title by default', () => {
    const result = normalizeMetadata(
      raw({ channel: 'Dave Matthews Band Radio', title: 'Cry - October 1 Boston MA 2020' }),
      config(),
    );
    expect(result.displayTitle).toContain('October 1, 2020');
    expect(result.displayTitle).toContain('Boston, MA');
  });

  it('can keep the concert details out of the scrobble title', () => {
    const result = normalizeMetadata(
      raw({ channel: 'Dave Matthews Band Radio', title: 'Cry - October 1 Boston MA 2020' }),
      config({ concertInScrobbleTitle: 'never' }),
    );
    expect(result.scrobbleTitle).toBe('Cry');
    expect(result.concert?.date).toBe('2020-10-01');
  });
});

describe('concert metadata patterns', () => {
  const cases: { title: string; expected: string; date?: string; location?: string }[] = [
    { title: 'Cry - 10/01/2020 Boston MA', expected: 'Cry (October 1, 2020 – Boston, MA)', date: '2020-10-01', location: 'Boston, MA' },
    { title: 'Cry - Boston MA 2020', expected: 'Cry (2020 – Boston, MA)', location: 'Boston, MA' },
    { title: 'Cry (Live at Boston, MA, 2020)', expected: 'Cry (Live – 2020 – Boston, MA)', location: 'Boston, MA' },
    { title: 'Cry - Live in Boston - October 1 2020', expected: 'Cry (Live – October 1, 2020 – Boston)', date: '2020-10-01', location: 'Boston' },
    { title: 'Cry - 10.01.20 - Boston, MA', expected: 'Cry (October 1, 2020 – Boston, MA)', date: '2020-10-01', location: 'Boston, MA' },
    { title: 'Cry [Boston MA, 2020]', expected: 'Cry (2020 – Boston, MA)', location: 'Boston, MA' },
  ];

  for (const testCase of cases) {
    it(`parses "${testCase.title}"`, () => {
      const result = normalizeMetadata(
        raw({ channel: 'Dave Matthews Band Radio', title: testCase.title }),
        config(),
      );
      expect(result.title).toBe('Cry');
      expect(result.displayTitle).toBe(testCase.expected);
      expect(result.artist).toBe('Dave Matthews Band');
      if (testCase.date) expect(result.concert?.date).toBe(testCase.date);
      if (testCase.location) expect(result.concert?.location).toBe(testCase.location);
    });
  }

  it('handles "Cry - Boston 2020 - Dave Matthews Band"', () => {
    const result = normalizeMetadata(
      raw({ channel: 'Dave Matthews Band Radio', title: 'Cry - Boston 2020 - Dave Matthews Band' }),
      config(),
    );
    expect(result.artist).toBe('Dave Matthews Band');
    expect(result.title).toBe('Cry');
    expect(result.concert?.location).toBe('Boston');
    expect(result.concert?.year).toBe(2020);
  });

  it('detects a venue when the metadata contains one', () => {
    const result = normalizeMetadata(
      raw({ channel: 'Dave Matthews Band Radio', title: 'Cry - October 1 2020 at Fenway Park' }),
      config(),
    );
    expect(result.concert?.date).toBe('2020-10-01');
    expect(result.concert?.venue).toBe('Fenway Park');
  });
});

describe('standard metadata', () => {
  it('parses "Artist - Title"', () => {
    const result = normalizeMetadata(
      raw({ channel: 'SiriusXM Hits 1', artist: 'Coldplay', title: 'Viva La Vida' }),
      config(),
    );
    expect(result.artist).toBe('Coldplay');
    expect(result.title).toBe('Viva La Vida');
    expect(result.source).toBe('provider-split');
    // There is no numeric confidence: the evidence describes how the roles
    // were determined.
    expect(result.evidence).toBe('split');
  });

  it('keeps a parenthetical version', () => {
    const result = normalizeMetadata(
      raw({ channel: 'SiriusXM Hits 1', artist: 'Kanye West', title: 'Stronger (Remix)' }),
      config(),
    );
    expect(result.artist).toBe('Kanye West');
    expect(result.title).toBe('Stronger');
    expect(result.version).toBe('Remix');
    expect(result.displayTitle).toBe('Stronger (Remix)');
  });

  it('extracts featured artists', () => {
    const result = normalizeMetadata(
      raw({ channel: 'SiriusXM Hits 1', artist: 'Nelly Furtado feat. Timbaland', title: 'Promiscuous' }),
      config(),
    );
    expect(result.artist).toBe('Nelly Furtado');
    expect(result.featured).toContain('Timbaland');
    expect(result.scrobbleArtist).toBe('Nelly Furtado feat. Timbaland');
  });

  it('keeps unicode titles and artists intact', () => {
    const result = normalizeMetadata(
      raw({ channel: 'SiriusXM Hits 1', artist: 'Zoé', title: 'Soñé' }),
      config(),
    );
    expect(result.artist).toBe('Zoé');
    expect(result.title).toBe('Soñé');
  });

  it('normalises curly quotes and dashes', () => {
    const result = normalizeMetadata(
      raw({ channel: 'SiriusXM Hits 1', artist: 'Artful Dodger', title: 'It’s a Fine Day — Remix' }),
      config(),
    );
    expect(result.artist).toBe('Artful Dodger');
    expect(result.title).toBe("It's a Fine Day");
    expect(result.version).toBe('Remix');
  });

  it('detects reversed artist/title metadata when the artist is known', () => {
    const result = normalizeMetadata(
      raw({ channel: 'The Groove', title: 'Voodoo Child - The Rolling Stones' }),
      config({ artistAliases: { 'the rolling stones': 'The Rolling Stones' } }),
    );
    expect(result.artist).toBe('The Rolling Stones');
    expect(result.title).toBe('Voodoo Child');
  });

  it('handles multiple dashes without losing the title', () => {
    const result = normalizeMetadata(
      raw({ channel: 'SiriusXM Hits 1', artist: 'Green Day', title: 'Boulevard of Broken Dreams - Radio Edit' }),
      config(),
    );
    expect(result.artist).toBe('Green Day');
    expect(result.title).toBe('Boulevard of Broken Dreams');
    expect(result.version).toBe('Radio Edit');
  });
});

describe('channel fallback rules', () => {
  it('does not use the channel name as artist on general stations', () => {
    for (const channel of ['SiriusXMU', 'Classic Rewind', 'The Spectrum', 'Alt Nation']) {
      const result = normalizeMetadata(
        raw({ channel, title: 'Cry - October 1 Boston MA 2020' }),
        config(),
      );
      expect(result.artist).toBeNull();
      expect(result.scrobbleArtist).toBeNull();
      expect(result.source).not.toBe('channel-fallback');
    }
  });

  it('does not use an unmapped channel as artist source', () => {
    const result = normalizeMetadata(
      raw({ channel: 'Some Generic Rock Channel', title: 'Cry - October 1 Boston MA 2020' }),
      config(),
    );
    expect(result.artist).toBeNull();
  });

  it('keeps a valid explicit artist on an artist-branded channel', () => {
    const result = normalizeMetadata(
      raw({ channel: 'Dave Matthews Band Radio', artist: 'Tim McGraw', title: 'Cry' }),
      config(),
    );
    expect(result.artist).toBe('Tim McGraw');
    expect(result.source).toBe('provider-split');
  });

  it('does not replace a guest performer credit with the channel artist', () => {
    const result = normalizeMetadata(
      raw({ channel: 'Dave Matthews Band Radio', title: 'Cry - Dave Matthews Band' }),
      config(),
    );
    expect(result.artist).toBe('Dave Matthews Band');
    expect(result.source).toBe('parsed-artist');
  });

  it('respects a disabled mapping', () => {
    const result = normalizeMetadata(
      raw({ channel: 'Dave Matthews Band Radio', title: 'Cry - October 1 Boston MA 2020' }),
      config({
        channelMappings: [
          { channel: 'Dave Matthews Band Radio', artist: 'Dave Matthews Band', disabled: true },
        ],
      }),
    );
    expect(result.artist).toBeNull();
  });

  it('supports user defined mappings', () => {
    const result = normalizeMetadata(
      raw({ channel: 'My Artist Channel', title: 'Song - 01/02/2021 Chicago IL' }),
      config({
        channelMappings: [{ channel: 'My Artist Channel', artist: 'The Test Artist' }],
      }),
    );
    expect(result.artist).toBe('The Test Artist');
    expect(result.concert?.date).toBe('2021-01-02');
  });
});

describe('filtering and edge cases', () => {
  it('skips advertisement metadata', () => {
    const result = normalizeMetadata(
      raw({ channel: 'SiriusXM Hits 1', artist: 'Advertisement', title: 'Call now 1-800-555-1234' }),
      config(),
    );
    expect(result.skip).toBe(true);
    expect(result.skipReason).toBeTruthy();
  });

  it('skips DJ commentary', () => {
    const result = normalizeMetadata(
      raw({ channel: 'SiriusXM Hits 1', artist: 'Welcome back to SiriusXM Hits 1', title: "You're listening to SiriusXM" }),
      config(),
    );
    expect(result.skip).toBe(true);
  });

  it('returns an empty result for missing metadata', () => {
    const result = normalizeMetadata(raw({ channel: 'SiriusXM Hits 1' }), config());
    expect(result.skip).toBe(true);
    expect(result.evidence).toBe('none');
  });

  it('ignores an artist field that only contains a date', () => {
    const result = normalizeMetadata(
      raw({ channel: 'Dave Matthews Band Radio', artist: 'October 1 Boston MA 2020', title: 'Cry' }),
      config(),
    );
    expect(result.artist).toBe('Dave Matthews Band');
  });

  it('flags ambiguous metadata instead of inventing facts', () => {
    const result = normalizeMetadata(
      raw({ channel: 'SiriusXMU', title: 'Unknown Concert 2020' }),
      config(),
    );
    expect(result.ambiguous).toBe(true);
    expect(result.concert?.date).toBeUndefined();
  });

  it('applies a user correction rule', () => {
    const result = normalizeMetadata(
      raw({ channel: 'SiriusXM Hits 1', title: 'DMB - Cry' }),
      config({
        correctionRules: [
          { id: 'dmb', pattern: '^DMB\\s*-\\s*', replacement: 'Dave Matthews Band - ', enabled: true },
        ],
      }),
    );
    expect(result.artist).toBe('Dave Matthews Band');
    expect(result.corrections).toContain('dmb');
  });

  it('applies a remembered manual correction', () => {
    const result = normalizeMetadata(
      raw({ channel: 'SiriusXM Hits 1', title: 'weird song' }),
      config({ manualCorrections: { 'weird song': { artist: 'Real Artist', title: 'Real Title' } } }),
    );
    expect(result.scrobbleArtist).toBe('Real Artist');
    expect(result.scrobbleTitle).toBe('Real Title');
    expect(result.source).toBe('manual');
  });

  it('applies an artist alias', () => {
    const result = normalizeMetadata(
      raw({ channel: 'SiriusXM Hits 1', artist: 'Beyonce', title: 'Halo' }),
      config({ artistAliases: { beyonce: 'Beyoncé' } }),
    );
    expect(result.artist).toBe('Beyoncé');
  });
});
