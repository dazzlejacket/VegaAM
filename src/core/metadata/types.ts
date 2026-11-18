/** Shared types for the metadata normalisation engine. */

import type { MetadataEvidence } from './providerRoles';

export type { MetadataEvidence };

/** Raw metadata as observed from the official player (read-only bridge). */
export interface RawMetadata {
  /** Channel / station name, e.g. "Dave Matthews Band Radio". */
  channel?: string | null;
  /** SiriusXM channel id when the page exposes one, e.g. "211". */
  channelId?: string | null;
  /** Artist field exactly as the player reports it (may be empty). */
  artist?: string | null;
  /** Song/title field exactly as the player reports it. */
  title?: string | null;
  /** Where the raw string came from. */
  origin?: 'media-session' | 'dom' | 'page-bridge' | 'manual' | 'unknown';
  /** Epoch ms the metadata was observed. */
  receivedAt?: number;
  /** Trailing qualifier separated from the title, e.g. "(67)". */
  qualifier?: string | null;
  /** Programme (show) that is on air on the channel. */
  programme?: string | null;
  /** SiriusXM channel number when the official player publishes one. */
  channelNumber?: string | null;
  /** How the roles of the published fields were determined. */
  evidence?: MetadataEvidence;
  /** Why the roles were determined that way. */
  reasons?: string[];
  /** True when the artist/title pair is well formed enough to be submitted. */
  scrobbleSafe?: boolean;
  /** Why the pair must not be submitted. */
  scrobbleBlockReason?: string;
}

/** Concert / live-broadcast information extracted from song metadata. */
export interface ConcertInfo {
  /** ISO date (yyyy-mm-dd) when day precision is known. */
  date?: string;
  /** Human readable date, e.g. "October 1, 2020". */
  dateText?: string;
  year?: number;
  month?: number;
  day?: number;
  /** "Boston, MA" */
  location?: string;
  city?: string;
  /** Two-letter state / province code, e.g. "MA". */
  region?: string;
  /** Venue name when the metadata contains one. */
  venue?: string;
  /** True when the metadata carried a live-performance descriptor. */
  isLive: boolean;
  /** The fragment the information was extracted from. */
  raw?: string;
}

export type MetadataSource =
  | 'provider-split'
  | 'parsed-artist'
  | 'channel-fallback'
  | 'manual'
  | 'unknown';

/** Result of normalising one piece of raw player metadata. */
export interface NormalizedTrack {
  /** Untouched original values. */
  raw: {
    artist: string | null;
    title: string | null;
    channel: string | null;
    /** `artist - title` (or just title) as received. */
    combined: string;
  };
  /** Best guess artist (may be null when nothing could be determined). */
  artist: string | null;
  /** Clean song title without any concert suffix. */
  title: string;
  /** Title used for display, concert details appended when appropriate. */
  displayTitle: string;
  /** Title submitted to scrobbling services. */
  scrobbleTitle: string;
  /** Artist submitted to scrobbling services (may be null). */
  scrobbleArtist: string | null;
  album?: string | null;
  /** Featured artists detected in the metadata. */
  featured: string[];
  /** Remix / version / edit descriptor ("Remix", "Live", "Acoustic", ...). */
  version?: string | null;
  /** Trailing qualifier separated from the title, e.g. "(67)". */
  qualifier?: string | null;
  /** Concert information, when present. */
  concert?: ConcertInfo | null;
  /** How the artist was determined. */
  source: MetadataSource;
  /** How the roles of the published fields were determined. */
  evidence: MetadataEvidence;
  /** Human readable reasons behind the evidence value. */
  evidenceReasons: string[];
  /** True when the parse is not trustworthy enough to auto-scrobble. */
  ambiguous: boolean;
  /** Identifiers of the correction rules that were applied. */
  corrections: string[];
  /** Additional notes for the diagnostics view. */
  notes: string[];
  /** True when the metadata must not be scrobbled (ad, DJ talk, ...). */
  skip?: boolean;
  /** Why the metadata is skipped. */
  skipReason?: string;
  /** True when the artist/title pair may be submitted to a service. */
  scrobbleSafe?: boolean;
  /** Why the pair must not be submitted. */
  scrobbleBlockReason?: string;
}

/** A user-configurable regex correction rule. */
export interface CorrectionRule {
  id: string;
  /** Human readable label shown in the UI. */
  label?: string;
  /** Regular expression source. Invalid expressions are rejected at load time. */
  pattern: string;
  /** Replacement string (supports $1 style groups). */
  replacement: string;
  /** Restrict the rule to a single channel (optional). */
  channel?: string;
  /** Apply the rule to the raw combined string before parsing (default). */
  scope?: 'raw' | 'artist' | 'title';
  enabled: boolean;
}

/** Channel -> artist mapping used for artist-branded channels. */
export interface ChannelArtistMapping {
  /** Channel name as shown by SiriusXM, e.g. "Dave Matthews Band Radio". */
  channel: string;
  /** Artist to use as fallback, e.g. "Dave Matthews Band". */
  artist: string;
  /** Never use this mapping as an artist fallback. */
  disabled?: boolean;
  /** Optional note explaining why the mapping exists. */
  note?: string;
}

/** Settings that influence parsing. */
export interface MetadataConfig {
  channelMappings: ChannelArtistMapping[];
  correctionRules: CorrectionRule[];
  /** Artist aliases: normalised alias -> canonical artist. */
  artistAliases: Record<string, string>;
  /** Remembered manual corrections keyed by the normalised raw string. */
  manualCorrections: Record<string, { artist?: string; title?: string }>;
  /** How concert details are rendered in the scrobble title. */
  concertInScrobbleTitle: 'always' | 'when-known' | 'never';
  /** Whether "feat." credits are kept in the submitted artist field. */
  includeFeaturedInScrobbleArtist: boolean;
  /**
   * Only submit metadata that two surfaces of the official player confirmed.
   * When disabled, metadata recovered from a combined field is submitted too,
   * as long as the artist/title pair is well formed.
   */
  requireVerifiedMetadata: boolean;
  /** Day/month order for numeric dates. SiriusXM is a US service by default. */
  dateOrder: 'MDY' | 'DMY';
  /** Channels that must never be used as an artist source. */
  neverFallbackChannels: string[];
  /**
   * Channel mappings the user deliberately removed.
   *
   * A migration may add newly shipped default mappings, but it must never
   * resurrect an entry the user deleted on purpose. The removed channel names
   * are remembered here as tombstones.
   */
  removedChannelMappings: string[];
}
