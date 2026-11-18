import { describe, expect, it } from 'vitest';

import {
  manualCorrectionKey,
  withManualCorrection,
  withoutManualCorrection,
} from '../src/core/metadata/manualCorrections';
import { normalizeMetadata } from '../src/core/metadata/normalizer';
import { DEFAULT_METADATA_CONFIG, mergeSettings } from '../src/core/settings/defaults';
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

function raw(partial: RawMetadata): RawMetadata {
  return { channel: null, artist: null, title: null, ...partial };
}

describe('remembered manual corrections', () => {
  it('builds the same key for the same raw metadata', () => {
    expect(manualCorrectionKey('Cry', 'October 1 Boston MA 2020')).toBe(
      manualCorrectionKey('cry', 'october 1 boston ma 2020'),
    );
  });

  it('ignores empty parts of the raw metadata', () => {
    expect(manualCorrectionKey(null, 'Cry')).toBe(manualCorrectionKey('', 'Cry'));
  });

  it('stores a correction without changing the original map', () => {
    const original = {};
    const next = withManualCorrection(original, 'Cry', 'Live', { artist: 'Dave Matthews Band' });
    expect(original).toEqual({});
    expect(next[manualCorrectionKey('Cry', 'Live')]).toEqual({ artist: 'Dave Matthews Band' });
  });

  it('removes a correction', () => {
    const corrections = withManualCorrection({}, 'Cry', 'Live', { artist: 'Dave Matthews Band' });
    const cleared = withoutManualCorrection(corrections, 'Cry', 'Live');
    expect(cleared).toEqual({});
  });

  it('applies the remembered correction to the next broadcast of the same metadata', () => {
    const corrections = withManualCorrection(
      {},
      null,
      'Cry - October 1 Boston MA 2020',
      { artist: 'Dave Matthews Band', title: 'Cry' },
    );

    const result = normalizeMetadata(
      raw({ channel: 'Dave Matthews Band Radio', title: 'Cry - October 1 Boston MA 2020' }),
      config({ manualCorrections: corrections }),
    );

    expect(result.scrobbleArtist).toBe('Dave Matthews Band');
    expect(result.scrobbleTitle).toBe('Cry');
    expect(result.source).toBe('manual');
  });
});

describe('settings migration', () => {
  it('migrates legacy mutedChannels into scrobbleMutedChannels and drops favoriteChannels', () => {
    const merged = mergeSettings({
      mutedChannels: ['SiriusXMU'],
      favoriteChannels: ['Pearl Jam Radio'],
    });
    expect(merged.scrobbleMutedChannels).toEqual(['SiriusXMU']);
    expect(merged.mutedChannels).toEqual(['SiriusXMU']);
    expect('favoriteChannels' in (merged as unknown as Record<string, unknown>)).toBe(false);
  });

  it('provides the desktop integration defaults', () => {
    const merged = mergeSettings({});
    expect(merged.notificationsEnabled).toBe(true);
    expect(merged.notifyOnScrobble).toBe(true);
    expect(merged.startAtLogin).toBe(false);
    expect(merged.mprisEnabled).toBe(true);
    expect(merged.mediaBridgeConsent).toBe(true);
  });
});
