/**
 * The metadata normalisation engine.
 *
 * Goal: turn the raw strings the official SiriusXM player reports into a
 * trustworthy artist/title pair (plus optional concert information) without
 * ever inventing facts.
 *
 * The engine is deliberately conservative. When the metadata cannot be parsed
 * with confidence the raw value is preserved, the evidence drops to a lower
 * level and the caller (the track state engine) refuses to scrobble
 * automatically.
 *
 * There is no numeric confidence value. A percentage cannot be calibrated
 * against a third party player, and showing one implied a certainty the
 * application never had.
 */

import { isCapitalized, lookupKey, normalizeText, tidy, words } from '../util/text';
import {
  classifyFragment,
  containsLiveDescriptor,
  formatConcertSuffix,
  looksLikeLocation,
  parseConcertFragment,
} from './concert';
import { findChannelMapping, resolveChannelArtist } from './channelFallback';
import { detectNonMusicMetadata } from './filters';
import { applyRules, compileRules } from './rules';
import type {
  ConcertInfo,
  MetadataConfig,
  MetadataEvidence,
  NormalizedTrack,
  RawMetadata,
} from './types';

/** Words that mark a remix / version descriptor. */
export const VERSION_MARKERS = [
  'remix',
  'remixed',
  'acoustic',
  'unplugged',
  'instrumental',
  'radio edit',
  'radio version',
  'single version',
  'album version',
  'extended version',
  'extended mix',
  'extended',
  'edit',
  'club mix',
  'dub',
  'karaoke',
  'stripped',
  'reprise',
  'remaster',
  'remastered',
  'demo',
  'slowed',
  'sped up',
  'mono',
  'stereo',
  'reverb',
  'live version',
  'live session',
  'session',
];

/** Featured artist markers. */
export const FEATURE_RE = /\b(feat\.?|ft\.?|featuring|with)\s+/i;

/** Separator between two metadata fields. */
const SEPARATOR_RE = /\s+(?:-|\||\u2013|\u2014)\s+/g;

interface Bracket {
  raw: string;
  content: string;
  kind: 'featured' | 'version' | 'concert' | 'qualifier' | 'keep';
}

interface ParsedTitle {
  title: string;
  version?: string;
  featured: string[];
  concert?: ConcertInfo;
  segments: string[];
  /** Trailing numeric tag that the official player appends, e.g. "(67)". */
  qualifier?: string;
}

/** True when the text contains a remix/version descriptor. */
export function containsVersionMarker(text: string): boolean {
  const lower = text.toLowerCase();
  return VERSION_MARKERS.some((marker) => lower.includes(marker));
}

/** Split "Artist feat. Guest" into the main artist and the featured artists. */
export function splitFeatured(artist: string): { main: string; featured: string[] } {
  const match = FEATURE_RE.exec(artist);
  if (!match) return { main: artist.trim(), featured: [] };

  const main = artist.slice(0, match.index).trim().replace(/[\s,\-–—]+$/, '');
  const rest = artist.slice(match.index + match[0].length).trim();
  const featured = rest
    .split(/\s*(?:,|&|\band\b|\bx\b)\s*/i)
    .map((f) => f.trim())
    .filter(Boolean);

  return { main: main || artist.trim(), featured };
}

/**
 * Extract the bracketed groups of a string and classify them.
 *
 * A trailing group that only contains a short number (e.g. "(67)") is the
 * tag the official player appends to a song title. Its meaning is not
 * established, so it is kept verbatim in the raw metadata but never merged
 * into the title.
 */
function extractBrackets(text: string): { brackets: Bracket[]; rest: string } {
  const brackets: Bracket[] = [];
  const rest = text.replace(/[\(\[]([^\)\]]*)[\)\]]/g, (full, content: string) => {
    const trimmed = content.trim();
    if (!trimmed) return ' ';
    let kind: Bracket['kind'] = 'keep';
    if (FEATURE_RE.test(trimmed)) kind = 'featured';
    else if (containsVersionMarker(trimmed) && !/\blive at\b|\blive in\b|\blive from\b/i.test(trimmed))
      kind = 'version';
    else if (classifyFragment(trimmed).isConcert) kind = 'concert';
    brackets.push({ raw: full, content: trimmed, kind });
    return ' ';
  });

  // Only a trailing numeric group is the tag the official player appends.
  const last = brackets[brackets.length - 1];
  if (last && /^\d{1,4}$/.test(last.content)) last.kind = 'qualifier';

  return { brackets, rest: rest.replace(/\s{2,}/g, ' ').trim() };
}

/** Split a string into separator delimited segments. */
export function splitSegments(text: string): string[] {
  return text
    .split(SEPARATOR_RE)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/**
 * True when a segment only carries a version descriptor, e.g. "Remix",
 * "Radio Edit" or "Acoustic Version".
 */
export function isVersionOnlyFragment(segment: string): boolean {
  const trimmed = segment.trim();
  if (!trimmed) return false;
  if (trimmed.length > 32) return false;
  const tokens = words(trimmed);
  if (tokens.length > 4) return false;
  if (!containsVersionMarker(trimmed)) return false;
  // "Remix of Cry" is not a version-only fragment.
  return !/\b(of|from|in)\b/i.test(trimmed);
}

/** Merge two concert fragments, keeping the first known value of each field. */
function mergeConcert(target: ConcertInfo, source: ConcertInfo): ConcertInfo {
  const merged: ConcertInfo = { ...target };
  if (source.isLive) merged.isLive = true;
  if (!merged.date && source.date) merged.date = source.date;
  if (!merged.dateText && source.dateText) merged.dateText = source.dateText;
  if (merged.year === undefined && source.year !== undefined) merged.year = source.year;
  if (merged.month === undefined && source.month !== undefined) merged.month = source.month;
  if (merged.day === undefined && source.day !== undefined) merged.day = source.day;
  if (!merged.location && source.location) merged.location = source.location;
  if (!merged.city && source.city) merged.city = source.city;
  if (!merged.region && source.region) merged.region = source.region;
  if (!merged.venue && source.venue) merged.venue = source.venue;
  if (!merged.raw && source.raw) merged.raw = source.raw;
  return merged;
}

/**
 * Parse a title field into title, version, featured artists and concert data.
 */
function parseTitleField(raw: string, dateOrder: 'MDY' | 'DMY'): ParsedTitle {
  const { brackets, rest } = extractBrackets(raw);

  const featured: string[] = [];
  let version: string | undefined;
  let concert: ConcertInfo | undefined;
  let qualifier: string | undefined;
  const kept: string[] = [];

  for (const bracket of brackets) {
    switch (bracket.kind) {
      case 'featured': {
        const { featured: names } = splitFeatured(bracket.content);
        featured.push(...names);
        break;
      }
      case 'version':
        version = version ? `${version} ${bracket.content}` : bracket.content;
        break;
      case 'concert': {
        const parsed = parseConcertFragment(bracket.content, dateOrder);
        if (parsed) concert = concert ? mergeConcert(concert, parsed) : parsed;
        else kept.push(bracket.raw);
        break;
      }
      case 'qualifier':
        // Kept out of the title, but never thrown away: it is carried
        // separately and stays visible in the raw metadata.
        qualifier = bracket.raw.trim();
        break;
      case 'keep':
      default:
        kept.push(bracket.raw);
        break;
    }
  }

  const segments = splitSegments(rest);
  const contentSegments: string[] = [];
  for (const segment of segments) {
    const classification = classifyFragment(segment);
    if (classification.isConcert) {
      const parsed = parseConcertFragment(segment, dateOrder);
      if (parsed) {
        concert = concert ? mergeConcert(concert, parsed) : parsed;
        continue;
      }
    }
    // A segment that only carries a version descriptor ("Remix", "Radio Edit")
    // is not part of the title.
    if (contentSegments.length > 0 && isVersionOnlyFragment(segment)) {
      version = version ? `${version} ${segment}` : segment;
      continue;
    }
    // A location fragment ("Boston, MA") belongs to the concert information as
    // soon as it does not start the metadata.
    if (contentSegments.length > 0 && looksLikeLocation(segment)) {
      const parsed = parseConcertFragment(segment, dateOrder);
      if (parsed) {
        concert = concert ? mergeConcert(concert, parsed) : parsed;
        continue;
      }
    }
    contentSegments.push(segment);
  }

  let title = contentSegments.join(' - ');
  for (const keptBracket of kept) {
    title = title ? `${title} ${keptBracket}` : keptBracket;
  }

  return {
    title: tidy(title),
    version,
    featured,
    concert,
    segments: contentSegments,
    qualifier,
  };
}

/** Heuristic score how much a segment looks like an artist name. */
export function artistScore(segment: string): number {
  let score = 0;
  const tokens = words(segment);
  if (tokens.length === 0) return -10;

  const capitalized = tokens.filter((t) => isCapitalized(t)).length;
  if (capitalized === tokens.length) score += 2;
  else score -= 1;
  if (tokens.length >= 2) score += 1;
  if (tokens.length > 5) score -= 2;
  if (FEATURE_RE.test(segment)) score += 2;
  if (/\s&\s|\sand\s/i.test(segment)) score += 1;
  if (containsVersionMarker(segment)) score -= 4;
  if (/\b(radio|channel|station|fm)\b/i.test(segment)) score -= 3;
  if (classifyFragment(segment).isConcert) score -= 4;
  return score;
}

/** Heuristic score how much a segment looks like a song title. */
export function titleScore(segment: string): number {
  let score = 1;
  const tokens = words(segment);
  if (tokens.length === 0) return -10;
  if (tokens.length === 1) score += 1;
  if (/[\(\[]/.test(segment)) score += 2;
  if (FEATURE_RE.test(segment)) score += 1;
  if (/\b(at|in|from|on)\b/i.test(segment)) score += 1;
  if (tokens.length >= 2) {
    const capitalized = tokens.filter((t) => isCapitalized(t)).length;
    if (capitalized === tokens.length) score -= 1.5;
  }
  if (classifyFragment(segment).isConcert) score -= 4;
  return score;
}

/** True when the segment looks like a date/location and not like an artist. */
export function isClearlyNotAnArtist(segment: string): boolean {
  const trimmed = segment.trim();
  if (!trimmed) return true;
  const classification = classifyFragment(trimmed);
  if (classification.hasDate) return true;
  if (classification.hasLive) return true;
  if (/\b(19|20)\d{2}\b/.test(trimmed)) return true;
  if (/^\d+$/.test(trimmed)) return true;
  if (/^\+?\d[\d.\-()\s]{6,}$/.test(trimmed)) return true;
  return false;
}

/** Apply the configured artist aliases. */
function applyAlias(artist: string, config: MetadataConfig): { artist: string; applied: boolean } {
  const key = lookupKey(artist);
  const alias = config.artistAliases?.[key];
  if (alias && lookupKey(alias) !== key) return { artist: alias, applied: true };
  return { artist, applied: false };
}

/** True when the segment matches a known artist (alias or channel mapping). */
function matchesKnownArtist(segment: string, config: MetadataConfig, channel?: string | null): boolean {
  const key = lookupKey(segment);
  if (!key) return false;
  for (const alias of Object.keys(config.artistAliases ?? {})) {
    if (lookupKey(alias) === key) return true;
  }
  const mapping = findChannelMapping(channel, config.channelMappings);
  if (mapping && lookupKey(mapping.artist) === key) return true;
  return false;
}

interface ArtistDecision {
  artist: string | null;
  title: string;
  reversed: boolean;
  evidence: MetadataEvidence;
  reasons: string[];
  ambiguous: boolean;
}

/**
 * Decide which segment is the artist and which one is the title.
 *
 * SiriusXM's dominant convention is "Artist - Title", so the default order is
 * kept. A reversal is only detected when there is corroborating evidence:
 *   - the segment matches a configured artist alias,
 *   - the segment matches the artist configured for the channel,
 *   - the segment carries a featured-artist marker the other one lacks,
 *   - the other segment carries a version marker (it is therefore a title).
 */
function decideArtistAndTitle(
  contentSegments: string[],
  options: {
    config: MetadataConfig;
    channel?: string | null;
  },
): ArtistDecision {
  const { config, channel } = options;
  const reasons: string[] = [];

  if (contentSegments.length === 0) {
    return {
      artist: null,
      title: '',
      reversed: false,
      evidence: 'none',
      reasons: ['No usable metadata segments.'],
      ambiguous: true,
    };
  }

  if (contentSegments.length === 1) {
    return {
      artist: null,
      title: contentSegments[0]!,
      reversed: false,
      evidence: 'inferred',
      reasons: ['Only one metadata segment - the artist could not be determined.'],
      ambiguous: true,
    };
  }

  const left = contentSegments[0]!;
  const right = contentSegments[1]!;

  const reversedSignals: string[] = [];
  if (matchesKnownArtist(right, config, channel) && !matchesKnownArtist(left, config, channel)) {
    reversedSignals.push('the second segment matches a known artist');
  }
  if (FEATURE_RE.test(right) && !FEATURE_RE.test(left)) {
    reversedSignals.push('the second segment carries a featured-artist credit');
  }
  if (containsVersionMarker(left) && !containsVersionMarker(right)) {
    reversedSignals.push('the first segment carries a version marker');
  }

  if (reversedSignals.length > 0) {
    reasons.push(`Reversed artist/title detected: ${reversedSignals.join('; ')}.`);
    return {
      artist: right,
      title: [left, ...contentSegments.slice(2)].join(' - '),
      reversed: true,
      evidence: 'split',
      reasons,
      ambiguous: false,
    };
  }

  reasons.push('Standard "Artist - Title" order assumed.');
  return {
    artist: left,
    title: [right, ...contentSegments.slice(2)].join(' - '),
    reversed: false,
    evidence: 'split',
    reasons,
    ambiguous: false,
  };
}

/**
 * Build the display title and the submitted title.
 *
 * The two differ on purpose:
 *
 *   - `displayTitle` always carries the concert information that is known, so
 *     the user can see that a concert broadcast is playing.
 *   - `scrobbleTitle` only carries it when the user asked for it via
 *     `concertInScrobbleTitle`, and never when the information was recovered
 *     from the artist field (that string was published in the wrong field and
 *     is stripped from the submitted title).
 */
function buildTitle(
  baseTitle: string,
  version: string | undefined,
  concert: ConcertInfo | undefined,
  mode: 'always' | 'when-known' | 'never',
  options: { displayOnly?: boolean } = {},
): { displayTitle: string; scrobbleTitle: string; suffix: string } {
  const concertSuffix = concert ? formatConcertSuffix(concert) : '';

  const displayParts: string[] = [];
  if (version) displayParts.push(version);
  if (concertSuffix) displayParts.push(concertSuffix);
  const displaySuffix = displayParts.join(' \u2013 ');
  const displayTitle = displaySuffix ? `${baseTitle} (${displaySuffix})` : baseTitle;

  const scrobbleParts: string[] = [];
  if (version) scrobbleParts.push(version);
  if (concertSuffix && !options.displayOnly && mode !== 'never' && concert) {
    const hasKnownDetail =
      mode === 'always' ||
      !!concert.date ||
      !!concert.dateText ||
      !!concert.location ||
      !!concert.venue ||
      (concert.year !== undefined && mode === 'when-known');
    if (hasKnownDetail) scrobbleParts.push(concertSuffix);
  }
  const scrobbleSuffix = scrobbleParts.join(' \u2013 ');
  const scrobbleTitle = scrobbleSuffix ? `${baseTitle} (${scrobbleSuffix})` : baseTitle;

  return { displayTitle, scrobbleTitle, suffix: displaySuffix };
}

/**
 * Normalise raw player metadata.
 */
export function normalizeMetadata(raw: RawMetadata, config: MetadataConfig): NormalizedTrack {
  const corrections: string[] = [];
  const notes: string[] = [];
  const evidenceReasons: string[] = [...(raw.reasons ?? [])];

  const rawArtist = normalizeText(raw.artist);
  const rawTitle = normalizeText(raw.title);
  const channel = normalizeText(raw.channel) || null;
  const combinedRaw = [rawArtist, rawTitle].filter(Boolean).join(' - ');

  const compiled = compileRules(config.correctionRules ?? []);

  // 1. Correction rules (raw scope) run over the combined string.
  let artistField = rawArtist;
  let titleField = rawTitle;

  if (compiled.rules.length > 0) {
    const rawScope = applyRules(combinedRaw, compiled.rules, 'raw', channel);
    if (rawScope.applied.length > 0) {
      corrections.push(...rawScope.applied);
      const parts = splitSegments(rawScope.text);
      if (parts.length >= 2 && !rawArtist) {
        titleField = parts.slice(1).join(' - ');
        artistField = parts[0]!;
      } else if (parts.length === 1) {
        titleField = parts[0]!;
      } else {
        titleField = rawScope.text;
      }
    }

    const artistScope = applyRules(artistField, compiled.rules, 'artist', channel);
    if (artistScope.applied.length > 0) {
      corrections.push(...artistScope.applied);
      artistField = artistScope.text;
    }

    const titleScope = applyRules(titleField, compiled.rules, 'title', channel);
    if (titleScope.applied.length > 0) {
      corrections.push(...titleScope.applied);
      titleField = titleScope.text;
    }
  }

  artistField = tidy(artistField);
  titleField = tidy(titleField);

  // 2. Parse the title field.
  const parsed = parseTitleField(titleField, config.dateOrder ?? 'MDY');

  let artist: string | null = null;
  let source: NormalizedTrack['source'] = 'unknown';
  // The evidence describes *how* the roles were determined. There is
  // deliberately no numeric confidence: an arbitrary percentage cannot be
  // calibrated against a third party player and used to be shown as if it
  // could be.
  let evidence: MetadataEvidence = raw.evidence ?? 'none';
  let ambiguous = true;
  let reversed = false;

  // 3. Explicit artist field.
  const explicitArtist = artistField.trim();
  // True when the published artist field carries a date/location instead of
  // an artist (e.g. "12/13/92 Boston, MA"). The provider blocks such a pair;
  // a user-confirmed channel mapping may still supply a trustworthy artist.
  let artistFieldIsDateLike = false;
  if (explicitArtist) {
    if (isClearlyNotAnArtist(explicitArtist)) {
      artistFieldIsDateLike = true;
      notes.push(
        `The artist field "${explicitArtist}" contains date/location information and was ignored.`,
      );
    } else {
      artist = explicitArtist;
      source = 'provider-split';
      if (evidence === 'none') evidence = 'split';
      ambiguous = false;
      evidenceReasons.push(
        'The official player published the artist in its own field, so the artist needs no further interpretation.',
      );
    }
  }

  // 4. Derive the artist from the title field.
  let title = parsed.title;
  if (!artist && parsed.segments.length >= 2) {
    const decision = decideArtistAndTitle(parsed.segments, {
      config,
      channel,
    });
    if (decision.artist && !isClearlyNotAnArtist(decision.artist)) {
      artist = decision.artist;
      title = decision.title;
      source = 'parsed-artist';
      evidence = decision.evidence;
      ambiguous = decision.ambiguous;
      reversed = decision.reversed;
      evidenceReasons.push(...decision.reasons);
    }
  } else if (!artist && parsed.segments.length === 1) {
    title = parsed.segments[0]!;
  }

  // 5. Featured artists.
  const featured = [...parsed.featured];
  if (artist) {
    const split = splitFeatured(artist);
    if (split.featured.length > 0) {
      featured.push(...split.featured);
      artist = split.main;
      evidenceReasons.push(`Featured artists detected: ${split.featured.join(', ')}.`);
    }
  }

  // 6. Artist aliases.
  if (artist) {
    const alias = applyAlias(artist, config);
    if (alias.applied) {
      notes.push(`Artist alias applied: "${artist}" -> "${alias.artist}".`);
      artist = alias.artist;
    }
  }

  // The concert information can also be recovered from the artist field (see
  // step 7), so it is kept in a mutable variable.
  let concert = parsed.concert;
  // True when the concert information was recovered from the artist field. It
  // is then shown in the UI but never submitted as part of the title.
  let concertIsDisplayOnly = false;

  // 7. Channel derived artist fallback.
  const fallback = resolveChannelArtist(channel, artist, config);
  // True when a user-confirmed channel mapping supplied the artist because the
  // published artist field carried a date/location instead of a name.
  let channelMappingClearedBlock = false;
  if (!artist && fallback.artist) {
    artist = fallback.artist;
    source = 'channel-fallback';
    evidence = 'inferred';
    ambiguous = false;
    evidenceReasons.push(fallback.reason);
    if (artistFieldIsDateLike && fallback.mapping) {
      // The published string was a date/location, not an artist. It is
      // concert information and must not end up in the submitted title.
      // The mapping is an explicit, user-confirmed source for the artist, so
      // the provider's "this is not an artist" block no longer applies to the
      // pair that is actually submitted.
      channelMappingClearedBlock = true;
      const concertFromArtistField = parseConcertFragment(
        explicitArtist,
        config.dateOrder ?? 'MDY',
      );
      if (concertFromArtistField && !concert) {
        concert = concertFromArtistField;
        concertIsDisplayOnly = true;
        notes.push(
          `The date/location "${explicitArtist}" was read as concert information instead of an artist.`,
        );
      }
      evidenceReasons.push(
        `The artist "${artist}" comes from the channel mapping for "${channel}", so the published date/location does not block the submission.`,
      );
    }
  } else if (artist) {
    evidenceReasons.push(fallback.reason);
  }

  // 8. Titles.
  const { displayTitle, scrobbleTitle } = buildTitle(
    title,
    parsed.version,
    concert,
    config.concertInScrobbleTitle ?? 'always',
    { displayOnly: concertIsDisplayOnly },
  );

  const scrobbleArtist = artist
    ? config.includeFeaturedInScrobbleArtist === false && featured.length > 0
      ? artist
      : [artist, ...(featured.length > 0 ? [featured.join(' & ')] : [])].join(' feat. ')
    : null;

  // 9. Manual corrections have the final word.
  const manualKey = lookupKey([rawArtist, rawTitle].filter(Boolean).join(' - '));
  const manual = config.manualCorrections?.[manualKey];
  let finalArtist = scrobbleArtist;
  let finalDisplayTitle = displayTitle;
  let finalScrobbleTitle = scrobbleTitle;
  if (manual) {
    if (manual.artist) finalArtist = manual.artist;
    if (manual.title) {
      finalDisplayTitle = manual.title;
      finalScrobbleTitle = manual.title;
    }
    source = 'manual';
    evidence = 'manual';
    ambiguous = false;
    evidenceReasons.push('A remembered manual correction was applied.');
    corrections.push('manual-correction');
  }

  // 10. Advertisement / DJ filtering.
  const filter = detectNonMusicMetadata(
    [rawArtist, rawTitle, channel].filter(Boolean).join(' '),
  );

  if (!title && !finalArtist) {
    return {
      raw: { artist: rawArtist || null, title: rawTitle || null, channel, combined: combinedRaw },
      artist: null,
      title: '',
      displayTitle: '',
      scrobbleTitle: '',
      scrobbleArtist: null,
      featured: [],
      concert: concert ?? null,
      qualifier: parsed.qualifier ?? null,
      source,
      evidence: 'none',
      evidenceReasons: ['No metadata was reported by the player.'],
      ambiguous: true,
      corrections,
      notes,
      skip: true,
      skipReason: 'No metadata available.',
      scrobbleSafe: false,
      scrobbleBlockReason: 'No metadata available.',
    };
  }

  if (filter.skip) {
    ambiguous = true;
  }

  const result: NormalizedTrack = {
    raw: { artist: rawArtist || null, title: rawTitle || null, channel, combined: combinedRaw },
    artist: artist ?? null,
    title,
    displayTitle: finalDisplayTitle,
    scrobbleTitle: finalScrobbleTitle,
    scrobbleArtist: finalArtist,
    featured,
    version: parsed.version ?? null,
    qualifier: parsed.qualifier ?? raw.qualifier ?? null,
    concert: concert ?? null,
    source,
    evidence,
    evidenceReasons,
    ambiguous,
    corrections,
    notes,
    scrobbleSafe: raw.scrobbleSafe ?? true,
    scrobbleBlockReason: raw.scrobbleBlockReason,
  };

  if (reversed) result.notes.push('The artist and title were swapped compared to the raw metadata.');
  if (filter.skip) {
    result.skip = true;
    result.skipReason = filter.reason;
    result.scrobbleSafe = false;
  }
  if (config.requireVerifiedMetadata && evidence !== 'verified' && evidence !== 'manual') {
    result.ambiguous = true;
    result.scrobbleSafe = false;
    result.scrobbleBlockReason =
      'Only metadata that the official player confirmed on two surfaces is submitted automatically.';
  }

  // A user-confirmed channel mapping replaced the date/location that the
  // provider published in the artist field. The pair that is actually
  // submitted is well formed, so the provider's block must not survive.
  if (channelMappingClearedBlock && !result.skip) {
    result.scrobbleSafe = true;
    result.scrobbleBlockReason = undefined;
  }

  return result;
}
