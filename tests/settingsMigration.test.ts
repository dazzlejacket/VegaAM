import { describe, expect, it } from 'vitest';

import { SETTINGS_VERSION, mergeSettings } from '../src/core/settings/defaults';
import { isShippedSeedMapping, migrateChannelMappingsToV3, needsV3Migration } from '../src/core/settings/migrations';

describe('v1/v2 -> v3 settings migration', () => {
  it('identifies v1 and v2 settings objects that need v3 migration', () => {
    expect(needsV3Migration({ settingsVersion: 1 })).toBe(true);
    expect(needsV3Migration({ settingsVersion: 2 })).toBe(true);
    expect(needsV3Migration({})).toBe(true);
    expect(needsV3Migration({ settingsVersion: 3 })).toBe(false);
  });

  it('recognizes unmodified shipped v1/v2 seed mappings and preserves user-created mappings', () => {
    expect(
      isShippedSeedMapping({ channel: 'Dave Matthews Band Radio', artist: 'Dave Matthews Band' }),
    ).toBe(true);
    expect(
      isShippedSeedMapping({ channel: 'E Street Radio', artist: 'Bruce Springsteen' }),
    ).toBe(true);
    expect(
      isShippedSeedMapping({ channel: 'E Street Radio', artist: 'Bruce Springsteen & The E Street Band' }),
    ).toBe(false);
    expect(
      isShippedSeedMapping({ channel: 'Underground Garage', artist: 'Little Steven' }),
    ).toBe(false);

    const migrated = migrateChannelMappingsToV3([
      { channel: 'Dave Matthews Band Radio', artist: 'Dave Matthews Band' },
      { channel: 'Pearl Jam Radio', artist: 'Pearl Jam' },
      { channel: 'Underground Garage', artist: 'Little Steven' },
    ]);
    expect(migrated).toEqual([{ channel: 'Underground Garage', artist: 'Little Steven' }]);
  });

  it('migrates real v2 user settings while preserving manualCorrections, rules, aliases, and window bounds', () => {
    const v2Profile = {
      settingsVersion: 2,
      theme: 'bluebird-classic',
      colorMode: 'light',
      accentColor: '#3d7eff',
      miniPlayerBounds: { x: 80, y: 90, width: 420, height: 152 },
      windowBounds: { x: 100, y: 120, width: 1296, height: 876 },
      alwaysOnTop: true,
      favoriteChannels: ['The Beatles Channel', 'E Street Radio'],
      mutedChannels: ['SiriusXM Comedy'],
      thresholds: {
        ratio: 0.5,
        maxMs: 240000,
        minTrackMs: 30000,
        radioMinListenMs: 120000,
        radioRequiresBoundary: false,
        metadataDebounceMs: 3000,
      },
      metadata: {
        channelMappings: [
          { channel: 'Dave Matthews Band Radio', artist: 'Dave Matthews Band' },
          { channel: 'E Street Radio', artist: 'Bruce Springsteen' },
          { channel: 'My Favorite Station', artist: 'Custom Artist' },
        ],
        manualCorrections: {
          'custom raw track': { artist: 'Corrected Artist', title: 'Corrected Title' },
        },
        correctionRules: [
          { id: 'rule-1', pattern: '^Foo', replacement: 'Bar', enabled: true },
        ],
        artistAliases: { 'bruce': 'Bruce Springsteen' },
        concertInScrobbleTitle: 'never',
      },
    };

    const migrated = mergeSettings(v2Profile);

    expect(migrated.settingsVersion).toBe(SETTINGS_VERSION);
    expect(migrated.skinId).toBe('bluebird-classic');
    expect(migrated.colorMode).toBe('light');
    expect(migrated.alwaysOnTop).toBe(true);
    expect(migrated.scrobbleMutedChannels).toEqual(['SiriusXM Comedy']);
    expect(migrated.windowState.main).toEqual({
      x: 100,
      y: 120,
      width: 1296,
      height: 876,
    });
    expect(migrated.windowState.compact).toEqual({
      x: 80,
      y: 90,
      width: 420,
      height: 152,
    });
    // The 3.0/3.1 build forced the radio floor up to 150,000 ms, so a stored
    // 120,000 ms could never have been honoured. The hotfix rewrites it to the
    // new fallback floor.
    expect(migrated.thresholds.radioMinListenMs).toBe(90000);
    // Shipped seeds removed, user mapping preserved
    expect(migrated.metadata.channelMappings).toEqual([
      { channel: 'My Favorite Station', artist: 'Custom Artist' },
    ]);
    // Manual corrections, rules, and aliases preserved
    expect(migrated.metadata.manualCorrections).toEqual({
      'custom raw track': { artist: 'Corrected Artist', title: 'Corrected Title' },
    });
    expect(migrated.metadata.correctionRules).toHaveLength(1);
    expect(migrated.metadata.artistAliases).toEqual({ bruce: 'Bruce Springsteen' });
    // Legacy favoriteChannels dropped
    expect('favoriteChannels' in (migrated as unknown as Record<string, unknown>)).toBe(false);
    // v4 surface theme defaults
    expect(migrated.surfaceThemeId).toBeNull();
    expect(migrated.surfaceThemeAccent).toBeNull();
    expect(migrated.surfaceThemeConsent).toBe(false);
    expect(migrated.surfaceThemeSnapshot).toBe('2026-11-05');
    expect(migrated.quickPanelEnabled).toBe(true);
  });

  it('migrates v3 settings to v4 with opt-in surface theme defaults and sanitizes surface fields', () => {
    const v3Profile = {
      settingsVersion: 3,
      theme: 'modern',
      skinId: 'retro-amp',
      colorMode: 'dark',
      lastfmEnabled: true,
      listenbrainzEnabled: true,
      scrobbleMutedChannels: ['Howard 100'],
    };

    const migrated = mergeSettings(v3Profile);
    expect(migrated.settingsVersion).toBe(4);
    expect(migrated.skinId).toBe('retro-amp');
    expect(migrated.lastfmEnabled).toBe(true);
    expect(migrated.listenbrainzEnabled).toBe(true);
    expect(migrated.surfaceThemeId).toBeNull();
    expect(migrated.surfaceThemeAccent).toBeNull();
    expect(migrated.surfaceThemeConsent).toBe(false);
    expect(migrated.quickPanelEnabled).toBe(true);

    // Unconsented surfaceThemeId is cleared to null
    const unconsented = mergeSettings({
      settingsVersion: 4,
      surfaceThemeConsent: false,
      surfaceThemeId: 'dracula',
      surfaceThemeAccent: '#ff79c6',
    });
    expect(unconsented.surfaceThemeConsent).toBe(false);
    expect(unconsented.surfaceThemeId).toBeNull();
    expect(unconsented.surfaceThemeAccent).toBe('#FF79C6');

    // Consented valid surfaceThemeId and accent are preserved
    const consented = mergeSettings({
      settingsVersion: 4,
      surfaceThemeConsent: true,
      surfaceThemeId: 'catppuccin',
      surfaceThemeAccent: '#cba6f7',
      quickPanelEnabled: false,
    });
    expect(consented.surfaceThemeConsent).toBe(true);
    expect(consented.surfaceThemeId).toBe('catppuccin');
    expect(consented.surfaceThemeAccent).toBe('#CBA6F7');
    expect(consented.quickPanelEnabled).toBe(false);

    // Invalid theme ID or injection attempt in accent is rejected
    const invalid = mergeSettings({
      settingsVersion: 4,
      surfaceThemeConsent: true,
      surfaceThemeId: 'evil-theme',
      surfaceThemeAccent: 'red; background:url(https://evil.example)',
    });
    expect(invalid.surfaceThemeId).toBeNull();
    expect(invalid.surfaceThemeAccent).toBeNull();
  });
});
