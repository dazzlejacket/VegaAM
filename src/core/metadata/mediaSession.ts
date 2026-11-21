/**
 * Pure MediaSession metadata parser for the official SiriusXM web player.
 *
 * The official SiriusXM web player publishes two combined strings through the
 * standard W3C Media Session API:
 *
 *   navigator.mediaSession.metadata.title  ->  "<programme> · <channel>"
 *   navigator.mediaSession.metadata.artist ->  "<artist> - <song>"
 *
 * This module resolves those strings into role-correct metadata without
 * reading the DOM, without hardcoded channel catalogs, and without mutating
 * provider spelling (e.g. "Folllow That Dream" stays intact).
 */

import { matchAlbumLabel } from './albumLabel';
import { detectNonMusicMetadata } from './filters';
import { isClearlyNotAnArtist } from './normalizer';

/** Separator used by SiriusXM between programme and channel. */
const PROGRAMME_SEPARATOR = '\u00b7'; // ·

/** Separators used between artist and song title. */
const TRACK_SEPARATORS = [' - ', ' \u2013 ', ' \u2014 ', '- '];

/** Trailing short numeric tag appended by SiriusXM, e.g. "(67)". */
const QUALIFIER_RE = /\s*(\(\d{1,4}\))\s*$/;

/** Hashtag-only programme/social tag, e.g. "#FromMeToYou" or "#FabFourum". */
const HASHTAG_ONLY_RE = /^#[A-Za-z0-9_]+$/;

/** Phone number pattern used on call-in shows, e.g. "844.999.2328". */
const PHONE_NUMBER_RE = /\b\d{3}[-.\s]\d{3}[-.\s]\d{4}\b/;

/** How the roles of the published fields were determined. */
export type MetadataEvidence =
  | 'verified'
  | 'split'
  | 'inferred'
  | 'manual'
  | 'none';

/** Read-only snapshot from the isolated MediaSession preload bridge. */
export interface MediaSessionSnapshot {
  /** "<programme> · <channel>" as published by navigator.mediaSession.metadata.title. */
  sessionTitle?: string | null;
  /** "<artist> - <song>" as published by navigator.mediaSession.metadata.artist. */
  sessionArtist?: string | null;
  sessionAlbum?: string | null;
  artwork?: string | null;
  playing?: boolean;
  positionMs?: number | null;
}

export type ProviderMetadataSnapshot = MediaSessionSnapshot;

/** Role-resolved metadata ready for normalization and scrobble eligibility checks. */
export interface ResolvedMetadata {
  channel: string | null;
  channelNumber: string | null;
  programme: string | null;
  artist: string | null;
  title: string | null;
  /** Album as published by the player (null when it publishes none). */
  album: string | null;
  qualifier: string | null;
  rawArtistField: string | null;
  rawTitleField: string | null;
  evidence: MetadataEvidence;
  reasons: string[];
  scrobbleSafe: boolean;
  scrobbleBlockReason?: string;
}

/**
 * Normalize UTF-8/Latin-1 mojibake separators that Chromium/SiriusXM
 * occasionally emit in MediaSession strings while preserving artist/title spelling.
 */
export function normalizeMojibake(value: string | null | undefined): string | null {
  if (typeof value !== 'string') return null;
  const normalized = value
    .replace(/\u00c2\u00b7/g, '\u00b7')
    .replace(/\u00e2\u20ac\u201c/g, '\u2013')
    .replace(/\u00e2\u20ac\u201d/g, '\u2014')
    .replace(/\u00e2\u20ac\u2122/g, "'")
    .replace(/\u00e2\u20ac\u02dc/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
  return normalized.length > 0 ? normalized : null;
}

function key(value: string | null | undefined): string {
  return (value ?? '').toLowerCase().replace(/[^a-z0-9]+/g, '');
}

/**
 * Split the MediaSession title ("<programme> · <channel>") into programme and channel.
 *
 * When both halves are identical ("The Beatles Channel · The Beatles Channel"),
 * the duplicate programme is dropped (`programme: null`).
 */
export function splitChannelProgramme(
  value: string | null | undefined,
  knownChannels?: string[] | null,
): { channel: string | null; programme: string | null } {
  const text = normalizeMojibake(value);
  if (!text) return { channel: null, programme: null };

  const index = text.indexOf(PROGRAMME_SEPARATOR);
  if (index < 0) {
    return { channel: text, programme: null };
  }

  const first = normalizeMojibake(text.slice(0, index));
  const second = normalizeMojibake(text.slice(index + PROGRAMME_SEPARATOR.length));
  if (!second) return { channel: first, programme: null };
  if (!first) return { channel: second, programme: null };

  if (key(second) === key(first)) {
    return { channel: second, programme: null };
  }

  const known = (knownChannels ?? []).map((name) => key(name));
  const firstIsChannel = known.includes(key(first));
  const secondIsChannel = known.includes(key(second));
  if (firstIsChannel && !secondIsChannel) {
    return { channel: first, programme: second };
  }
  return { channel: second, programme: first };
}

/**
 * The roles of the combined "<artist> - <song>" field.
 */
export interface CombinedTrack {
  /**
   * The artist credit.
   *
   * When the player published an album label instead of an artist (the
   * album-label form), the published label is kept here so that the
   * diagnostics stay truthful. The normalisation engine reads it as an album
   * and never as an artist.
   */
  artist: string | null;
  /** The song title. */
  song: string | null;
  /** The album recovered from an album label. */
  album: string | null;
}

/**
 * Split the combined "<artist> - <song>" field into its roles.
 *
 * The album-label form (`From "The Rising" - My City Of Ruins`) is recognised
 * first: the label is an album and not an artist credit, and the text behind
 * it is the song. That text is never split again, so a song with a dash in
 * its title survives the split.
 */
export function splitCombinedTrack(value: string | null | undefined): CombinedTrack {
  const text = normalizeMojibake(value);
  if (!text) return { artist: null, song: null, album: null };

  const label = matchAlbumLabel(text);
  if (label) {
    return { artist: label.label, song: label.rest || null, album: label.album };
  }

  for (const separator of TRACK_SEPARATORS) {
    const index = text.indexOf(separator);
    if (index <= 0) continue;
    const artist = normalizeMojibake(text.slice(0, index));
    const song = normalizeMojibake(text.slice(index + separator.length));
    if (artist && song) return { artist, song, album: null };
  }

  return { artist: null, song: null, album: null };
}

/**
 * Split the combined "<artist> - <song>" field on the first separator only.
 */
export function splitCombinedArtistSong(
  value: string | null | undefined,
): { artist: string | null; song: string | null } {
  const track = splitCombinedTrack(value);
  return { artist: track.artist, song: track.song };
}

/**
 * Separate a trailing numeric qualifier such as "(67)" from a song title.
 */
export function splitTrailingQualifier(
  value: string | null | undefined,
): { title: string | null; qualifier: string | null } {
  const text = normalizeMojibake(value);
  if (!text) return { title: null, qualifier: null };
  const match = QUALIFIER_RE.exec(text);
  if (!match) return { title: text, qualifier: null };
  const title = normalizeMojibake(text.slice(0, match.index));
  if (!title) return { title: text, qualifier: null };
  return { title, qualifier: match[1] ?? null };
}

/**
 * Strip a leading "Ch 18 · " prefix when present.
 */
export function stripChannelNumberPrefix(value: string | null | undefined): string | null {
  const text = normalizeMojibake(value);
  if (!text) return null;
  return normalizeMojibake(text.replace(/^\s*ch\s*\d+\s*[^A-Za-z0-9]{0,4}\s*/i, ''));
}

/**
 * Resolve MediaSession fields into role-correct metadata.
 */
export function resolveMediaSessionMetadata(
  snapshot: MediaSessionSnapshot,
  options: {
    knownChannels?: string[] | null;
  } = {},
): ResolvedMetadata {
  const reasons: string[] = [];

  const sessionTitle = normalizeMojibake(snapshot.sessionTitle);
  const sessionArtist = normalizeMojibake(snapshot.sessionArtist);
  const sessionAlbum = normalizeMojibake(snapshot.sessionAlbum);

  const known = (options.knownChannels ?? []).map((name) => key(name));
  const isKnownChannel = (value: string | null | undefined): boolean =>
    !!value && known.includes(key(value));

  const fromTitle = splitChannelProgramme(sessionTitle, options.knownChannels);
  const sessionTrack = splitCombinedTrack(sessionArtist);

  const channel = fromTitle.channel;
  let programme = fromTitle.programme;
  let artist: string | null = sessionTrack.artist;
  let song: string | null = sessionTrack.song;
  let evidence: MetadataEvidence = 'none';

  if (sessionTitle) {
    reasons.push(`The official player published the channel as "${sessionTitle}".`);
  }
  if (channel) {
    reasons.push(`The media session named the channel "${channel}".`);
  }
  if (sessionAlbum) {
    reasons.push(`The official player published the album "${sessionAlbum}".`);
  }
  if (sessionTrack.album) {
    reasons.push(
      `The official player published the album "${sessionTrack.album}" in place of an artist.`,
    );
  }

  if (sessionTrack.artist && sessionTrack.song) {
    evidence = 'split';
    reasons.push(
      'The artist and the song were separated from the combined field the official player publishes.',
    );
  } else if (sessionArtist) {
    reasons.push(
      `The official player published "${sessionArtist}", which does not contain a separable artist and song.`,
    );
  }

  // A "song" that repeats the channel or the programme is not a song (e.g. host/programme bumper).
  if (song && (key(song) === key(channel ?? '') || key(song) === key(programme ?? ''))) {
    reasons.push(
      'The published song field repeats the channel or the programme and was not treated as a song title.',
    );
    artist = null;
    song = null;
    if (programme === null && channel) programme = channel;
    evidence = 'none';
  } else if (programme && key(programme) === key(song ?? '')) {
    reasons.push('The programme repeats the song title and was dropped.');
    programme = null;
  }

  const withQualifier = splitTrailingQualifier(song);
  const qualifier = withQualifier.qualifier;
  const title = withQualifier.title;
  if (qualifier) {
    reasons.push(
      `The trailing qualifier "${qualifier}" was kept in the raw metadata and separated from the title.`,
    );
  }

  let scrobbleSafe = false;
  let scrobbleBlockReason: string | undefined;
  if (!artist || !title) {
    scrobbleBlockReason =
      !artist && !title
        ? 'The official player did not publish a separable artist and song.'
        : !artist
          ? 'The official player did not publish an artist.'
          : 'The official player did not publish a song title.';
  } else if (!sessionTrack.artist || !sessionTrack.song) {
    scrobbleBlockReason = 'The media session did not publish a separable artist and song.';
  } else if (isKnownChannel(artist) || key(artist) === key(channel ?? '')) {
    scrobbleBlockReason = 'The artist field is a channel name.';
  } else if (key(artist) === key(programme ?? '')) {
    scrobbleBlockReason = 'The artist field repeats the programme name.';
  } else if (key(artist) === key(title)) {
    scrobbleBlockReason = 'The artist and the song title are identical.';
  } else if (key(title) === key(channel ?? '')) {
    scrobbleBlockReason = 'The song title is the channel name.';
  } else if (HASHTAG_ONLY_RE.test(title) || HASHTAG_ONLY_RE.test(artist)) {
    scrobbleBlockReason = 'The published metadata contains a programme hashtag instead of a song.';
  } else if (PHONE_NUMBER_RE.test(artist) || PHONE_NUMBER_RE.test(title)) {
    scrobbleBlockReason = 'The published metadata contains a call-in phone number.';
  } else if (isClearlyNotAnArtist(artist) && !sessionTrack.album) {
    // An album label is not a date, even when the album name carries a year
    // ("From "1975 Live""). It is handled as an album further down.
    scrobbleBlockReason =
      'The published artist field contains a date or a location, not an artist.';
  } else {
    const filterCheck = detectNonMusicMetadata(`${artist} - ${title}`);
    if (filterCheck.skip) {
      scrobbleBlockReason =
        filterCheck.reason ?? 'The published metadata matches a non-music programme filter.';
    } else {
      scrobbleSafe = true;
    }
  }

  return {
    channel,
    channelNumber: null,
    programme,
    artist,
    title,
    album: sessionAlbum ?? sessionTrack.album,
    qualifier,
    rawArtistField: artist,
    rawTitleField: song,
    evidence,
    reasons,
    scrobbleSafe,
    scrobbleBlockReason,
  };
}

export const resolveProviderMetadata = resolveMediaSessionMetadata;
