/**
 * User-configured channel derived artist fallback.
 *
 * When a user explicitly maps an artist-branded channel in Settings (for
 * example during concert broadcasts where the stream reports a date/location
 * in the artist field), that user-created mapping can supply the artist.
 *
 * No channel catalog or seed list is shipped in the application.
 */

import { lookupKey } from '../util/text';
import type { ChannelArtistMapping, MetadataConfig } from './types';

export interface ChannelFallbackResult {
  artist: string | null;
  /** The user-configured mapping that was used. */
  mapping?: ChannelArtistMapping;
  /** Why the fallback did (not) apply. */
  reason: string;
}

/** Normalise a channel name for lookups: lowercase, punctuation free. */
export function channelKey(channel: string | null | undefined): string {
  return lookupKey(channel);
}

/**
 * Remove trailing "Radio"/"Channel" decoration so user mappings match
 * consistently.
 */
export function stripChannelDecoration(channel: string): string {
  return channel
    .replace(/\s+(radio|channel|station|fm|hd)\s*$/i, '')
    .replace(/\s*[/|]\s*.*$/, '')
    .trim();
}

/**
 * Find a user-configured mapping for a channel. Exact (normalised) matches win,
 * then matches that only differ by the "Radio" decoration.
 */
export function findChannelMapping(
  channel: string | null | undefined,
  mappings: ChannelArtistMapping[],
): ChannelArtistMapping | undefined {
  if (!channel) return undefined;
  const key = channelKey(channel);
  if (!key) return undefined;

  const exact = mappings.find((m) => !m.disabled && channelKey(m.channel) === key);
  if (exact) return exact;

  const stripped = channelKey(stripChannelDecoration(channel));
  const loose = mappings.find(
    (m) => !m.disabled && channelKey(stripChannelDecoration(m.channel)) === stripped,
  );
  return loose;
}

/**
 * True when the channel is explicitly excluded from artist fallback.
 */
export function isNeverFallbackChannel(
  channel: string | null | undefined,
  excluded: string[],
): boolean {
  if (!channel) return false;
  const key = channelKey(channel);
  return excluded.some((c) => channelKey(c) === key);
}

/**
 * Resolve the artist for a channel using user-configured mappings.
 *
 * `explicitArtist` is the artist extracted from the metadata itself. When it
 * is present and plausible the fallback never overrides it.
 */
export function resolveChannelArtist(
  channel: string | null | undefined,
  explicitArtist: string | null,
  config: MetadataConfig,
): ChannelFallbackResult {
  if (!channel) {
    return { artist: explicitArtist, reason: 'No channel information available.' };
  }

  if (isNeverFallbackChannel(channel, config.neverFallbackChannels ?? [])) {
    return {
      artist: explicitArtist,
      reason: `Channel "${channel}" is excluded from channel derived artists.`,
    };
  }

  const mapping = findChannelMapping(channel, config.channelMappings ?? []);
  if (!mapping) {
    return {
      artist: explicitArtist,
      reason: `No artist mapping configured for "${channel}".`,
    };
  }

  if (explicitArtist) {
    return {
      artist: explicitArtist,
      mapping,
      reason: `Kept the explicitly credited artist instead of the channel artist "${mapping.artist}".`,
    };
  }

  return {
    artist: mapping.artist,
    mapping,
    reason: `Used the channel artist "${mapping.artist}" for "${channel}".`,
  };
}
