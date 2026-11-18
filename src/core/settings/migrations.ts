/**
 * Settings schema migration from v1/v2 to v3 (Official-First Architecture).
 *
 * Responsibilities:
 *   - Drop obsolete `favoriteChannels` (SiriusXM manages favorites natively)
 *   - Strip shipped v2 seed `channelMappings` (identified by the seed note)
 *     while preserving any user-created or user-modified channel mappings
 *   - Migrate `mutedChannels` -> `scrobbleMutedChannels`
 *   - Migrate `miniPlayerEnabled` -> `compactPlayerEnabled`
 *   - Migrate `windowBounds` -> `windowState.main`
 *   - Preserve all scrobbling settings, thresholds (clamped to >=150s radio floor),
 *     manualCorrections, correctionRules, artistAliases, and desktop preferences
 */

import { channelKey } from '../metadata/channelFallback';
import type { ChannelArtistMapping } from '../metadata/types';

export const SEED_MAPPING_NOTE = 'Seed mapping - edit or remove in Settings > Channels.';

const LEGACY_SEED_PAIRS: ReadonlyArray<{ channel: string; artist: string }> = Object.freeze([
  { channel: 'Dave Matthews Band Radio', artist: 'Dave Matthews Band' },
  { channel: 'Pearl Jam Radio', artist: 'Pearl Jam' },
  { channel: 'Bruce Springsteen / E Street Radio', artist: 'Bruce Springsteen' },
  { channel: 'E Street Radio', artist: 'Bruce Springsteen' },
]);

/**
 * True when a channel mapping entry is an unmodified v2 shipped seed mapping.
 * User-created mappings (or seed mappings where the user changed the artist,
 * disabled state, or note) are preserved.
 */
export function isShippedSeedMapping(mapping: ChannelArtistMapping): boolean {
  if (!mapping || typeof mapping !== 'object') return false;
  if (mapping.disabled) return false;
  if (mapping.note === SEED_MAPPING_NOTE) return true;
  if (mapping.note && mapping.note.trim().length > 0) return false;
  const cKey = channelKey(mapping.channel ?? '');
  const aKey = (mapping.artist ?? '').trim().toLowerCase();
  return LEGACY_SEED_PAIRS.some(
    (seed) => channelKey(seed.channel) === cKey && seed.artist.toLowerCase() === aKey,
  );
}

/**
 * Filter a stored channelMappings list, removing unmodified v2 seed mappings
 * and deduplicating user-created entries.
 */
export function migrateChannelMappingsToV3(
  stored: unknown,
  stripShippedSeeds: boolean = true,
): ChannelArtistMapping[] {
  if (!Array.isArray(stored)) return [];
  const result: ChannelArtistMapping[] = [];
  const seen = new Set<string>();

  for (const entry of stored) {
    if (!entry || typeof entry !== 'object') continue;
    const mapping = entry as ChannelArtistMapping;
    if (typeof mapping.channel !== 'string' || typeof mapping.artist !== 'string') continue;
    const channel = mapping.channel.trim();
    const artist = mapping.artist.trim();
    if (!channel || !artist) continue;
    if (stripShippedSeeds && isShippedSeedMapping(mapping)) continue;

    const key = channelKey(channel);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    const cleaned: ChannelArtistMapping = { channel, artist };
    if (mapping.disabled) cleaned.disabled = true;
    if (typeof mapping.note === 'string' && mapping.note.trim()) {
      cleaned.note = mapping.note.trim();
    }
    result.push(cleaned);
  }

  return result;
}

/**
 * Check whether a raw stored settings object requires migration to v3.
 */
export function needsV3Migration(stored: unknown): boolean {
  if (!stored || typeof stored !== 'object') return false;
  const record = stored as Record<string, unknown>;
  const version = Number(record.settingsVersion);
  if (!Number.isFinite(version) || version < 3) return true;
  if ('favoriteChannels' in record) return true;
  const metadata = record.metadata as Record<string, unknown> | undefined;
  if (metadata && 'minConfidence' in metadata) return true;
  return false;
}

export { LEGACY_SEED_PAIRS };
