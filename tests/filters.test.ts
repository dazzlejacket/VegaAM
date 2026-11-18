/**
 * Regression tests for the non-music metadata filter.
 *
 * The fixtures are the real SiriusXM strings observed during the deep dive
 * audit (P2-17): talk / interview programme identities that must never be
 * scrobbled, and ordinary song titles that must keep being scrobbled.
 */

import { describe, expect, it } from 'vitest';

import { detectNonMusicMetadata, listFilterRules } from '../src/core/metadata/filters';

describe('talk and interview programme metadata', () => {
  it('skips the "#FabFourum" programme hashtag', () => {
    const result = detectNonMusicMetadata('#FabFourum');
    expect(result.skip).toBe(true);
    expect(result.rule).toBe('programme:hashtag');
  });

  it('skips the "844.999.2328" talk line number', () => {
    const result = detectNonMusicMetadata('844.999.2328');
    expect(result.skip).toBe(true);
    expect(result.rule).toBe('programme:talkline');
  });

  it('skips the "On Air — Your Stories" programming banner', () => {
    const result = detectNonMusicMetadata('On Air — Your Stories');
    expect(result.skip).toBe(true);
    expect(result.rule).toBe('programme:banner');
  });

  it('skips the "Zoey Deutch — Beatlemania!!" interview programme', () => {
    const result = detectNonMusicMetadata('Zoey Deutch — Beatlemania!!');
    expect(result.skip).toBe(true);
    expect(result.rule).toBe('programme:interview');
  });

  it('skips the live requests segment of the Beatles channel', () => {
    const result = detectNonMusicMetadata(
      '#FabFourum Your Requests! 844.999.2328 The Beatles Channel',
    );
    expect(result.skip).toBe(true);
    expect(result.rule).toBe('programme:hashtag');
  });

  it('tolerates the alternative programme separators', () => {
    for (const text of [
      'On Air – Your Stories',
      'On Air - Your Stories',
      'On Air: Your Stories',
      'Zoey Deutch – Beatlemania!!',
      'Zoey Deutch - Beatlemania!!',
      'Zoey Deutch: Beatlemania!!',
    ]) {
      expect(detectNonMusicMetadata(text).skip, text).toBe(true);
    }
  });
});

describe('ordinary song titles are never skipped', () => {
  const songs = [
    'Coldplay - Viva La Vida',
    'Bob Dylan - Like a Rolling Stone',
    'The Beatles - Yesterday',
    'Bruce Springsteen - Thunder Road',
  ];

  for (const song of songs) {
    it(`keeps "${song}" scrobble safe`, () => {
      const result = detectNonMusicMetadata(song);
      expect(result.skip).toBe(false);
      expect(result.rule).toBeUndefined();
    });
  }

  it('keeps a Zoey Deutch song that is not the interview programme', () => {
    const result = detectNonMusicMetadata('Zoey Deutch - Shining');
    expect(result.skip).toBe(false);
    expect(result.rule).toBeUndefined();
  });

  it('keeps a title that only mentions Beatlemania', () => {
    const result = detectNonMusicMetadata('Beatlemania');
    expect(result.skip).toBe(false);
    expect(result.rule).toBeUndefined();
  });

  it('keeps the banner halves as individual song titles', () => {
    for (const song of ['On Air', 'Your Stories']) {
      const result = detectNonMusicMetadata(song);
      expect(result.skip, song).toBe(false);
      expect(result.rule, song).toBeUndefined();
    }
  });

  it('keeps a song title that carries a hashtag', () => {
    // The hashtag rule matches the exact programme token only, so a title
    // that merely contains a hashtag is still scrobbled.
    const result = detectNonMusicMetadata('#Delicate');
    expect(result.skip).toBe(false);
    expect(result.rule).toBeUndefined();
  });

  it('keeps a dotted date that is not a telephone number', () => {
    const result = detectNonMusicMetadata('Live 01.02.2024');
    expect(result.skip).toBe(false);
    expect(result.rule).toBeUndefined();
  });
});

describe('existing rules still apply', () => {
  it('skips an advertisement phone number', () => {
    const result = detectNonMusicMetadata('SiriusXM 1-800-555-0100');
    expect(result.skip).toBe(true);
    expect(result.rule).toBe('ad:phone');
  });

  it('skips a sponsor mention', () => {
    const result = detectNonMusicMetadata('presented by Acme');
    expect(result.skip).toBe(true);
    expect(result.rule).toBe('ad:brand');
  });

  it('skips a DJ intro', () => {
    const result = detectNonMusicMetadata('Welcome back to SiriusXM Hits 1');
    expect(result.skip).toBe(true);
    expect(result.rule).toBe('dj:welcome');
  });

  it('does not skip a plain song title', () => {
    const result = detectNonMusicMetadata('Coldplay - Viva La Vida');
    expect(result.skip).toBe(false);
  });

  it('does not skip empty metadata', () => {
    const result = detectNonMusicMetadata('   ');
    expect(result.skip).toBe(false);
  });
});

describe('listFilterRules', () => {
  it('lists the programme rules', () => {
    const ids = listFilterRules().map((rule) => rule.id);
    expect(ids).toContain('programme:hashtag');
    expect(ids).toContain('programme:talkline');
    expect(ids).toContain('programme:banner');
    expect(ids).toContain('programme:interview');
  });

  it('derives the kind from the rule id', () => {
    for (const rule of listFilterRules()) {
      expect(rule.kind).toBe(rule.id.split(':')[0]);
      expect(rule.label).toBeTruthy();
    }
  });
});
