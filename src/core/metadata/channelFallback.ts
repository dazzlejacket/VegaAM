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
 * Minimum length of a channel name that may be matched as a substring.
 *
 * Short names ("HQ", "XM") would match far too many channels, so a partial
 * match is only allowed for names that actually identify a station.
 */
const MIN_PARTIAL_MATCH_LENGTH = 4;

/**
 * Find a user-configured mapping for a channel.
 *
 * The player does not publish one canonical channel name. Depending on the
 * station and the broadcast it may report "E Street Radio",
 * "Bruce Springsteen / E Street Radio" or "Bruce Springsteen Concerts".
 * The lookup therefore tries, in order:
 *
 *   1. an exact (normalised) match,
 *   2. a match that only differs by the "Radio"/"Channel" decoration,
 *   3. a partial match: the published channel contains the mapped channel, or
 *      the mapped channel contains the published channel.
 *
 * The longest partial match wins, so a specific mapping is never shadowed by
 * a shorter one.
 */
export function findChannelMapping(
  channel: string | null | undefined,
  mappings: ChannelArtistMapping[],
): ChannelArtistMapping | undefined {
  if (!channel) return undefined;
  const key = channelKey(channel);
  if (!key) return undefined;

  const active = mappings.filter((m) => !m.disabled);
  if (active.length === 0) return undefined;

  const exact = active.find((m) => channelKey(m.channel) === key);
  if (exact) return exact;

  const stripped = channelKey(stripChannelDecoration(channel));
  const loose = active.find((m) => channelKey(stripChannelDecoration(m.channel)) === stripped);
  if (loose) return loose;

  // Partial match: the published channel carries the mapped name (or the
  // other way round). The longest match is the most specific one.
  let best: { mapping: ChannelArtistMapping; length: number } | undefined;
  for (const mapping of active) {
    const mapped = channelKey(mapping.channel);
    if (mapped.length < MIN_PARTIAL_MATCH_LENGTH) continue;
    if (!key.includes(mapped) && !mapped.includes(key)) continue;
    if (!best || mapped.length > best.length) {
      best = { mapping, length: mapped.length };
    }
  }
  return best?.mapping;
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
