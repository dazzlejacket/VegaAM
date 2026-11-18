/**
 * Concert / live-broadcast metadata parsing.
 *
 * SiriusXM artist channels frequently report concert broadcasts in the song
 * title field, e.g.
 *
 *   "Cry - October 1 Boston MA 2020"
 *   "Cry (Live at Boston, MA, 2020)"
 *   "Cry - Boston 2020 - Dave Matthews Band"
 *
 * This module extracts the concert information from such a fragment. It never
 * invents information: when only a year is known no ISO date is produced, and
 * when nothing at all is recognised the fragment is reported as "not concert
 * information" so the caller can treat it as an artist or a title instead.
 */

import { containsDate, containsYear, extractDate, extractYear } from './dates';
import { formatLocation, KNOWN_CITIES, parseLocation, STATE_CODES } from './locations';
import type { ConcertInfo } from './types';

/** Strong live-performance markers. */
export const LIVE_DESCRIPTORS = [
  'live at',
  'live in',
  'live from',
  'live on stage',
  'on stage',
  'in concert',
  'concert',
  'recorded live',
  'live performance',
  'live broadcast',
  'live event',
  'live session',
];

/** Weak live markers: only meaningful together with a date or a location. */
const WEAK_LIVE_DESCRIPTORS = ['live'];

/** Descriptors that describe a version instead of a live performance. */
const VERSION_ONLY_DESCRIPTORS = [
  'unplugged',
  'acoustic',
  'remix',
  'radio edit',
  'acoustic session',
  'session',
];

export interface FragmentClassification {
  hasDate: boolean;
  hasYear: boolean;
  hasLive: boolean;
  hasLocation: boolean;
  /** True when the fragment carries concert information. */
  isConcert: boolean;
}

/** True when the text contains a live-performance descriptor. */
export function containsLiveDescriptor(text: string): boolean {
  const lower = text.toLowerCase();
  for (const descriptor of LIVE_DESCRIPTORS) {
    if (new RegExp(`\\b${descriptor}\\b`).test(lower)) return true;
  }
  // A bare "live" only counts when the fragment also carries a date or a
  // place, otherwise song titles such as "Live and Let Die" are misdetected.
  for (const descriptor of WEAK_LIVE_DESCRIPTORS) {
    if (new RegExp(`\\b${descriptor}\\b`).test(lower)) {
      return containsDate(text) || containsYear(text) || looksLikeLocation(text);
    }
  }
  return false;
}

/**
 * True when the fragment looks like a place rather than an artist or title.
 *
 * Years and dates are removed first: "Boston 2020" is a place plus a year.
 */
export function looksLikeLocation(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed) return false;

  const withoutDates = trimmed
    .replace(/\b(19|20)\d{2}\b/g, ' ')
    .replace(/\b\d{1,2}[/-]\d{1,2}([/-]\d{2,4})?\b/g, ' ')
    .trim();
  if (!withoutDates) return false;

  const tokens = withoutDates.split(/[,\s]+/).filter(Boolean);
  if (tokens.length === 0 || tokens.length > 5) return false;

  // "Boston MA", "Boston, MA", "New York NY"
  if (tokens.some((t) => STATE_CODES.has(t.toUpperCase()))) return true;

  // Known city names.
  const lower = withoutDates.toLowerCase();
  if (KNOWN_CITIES.some((c) => lower.includes(c.toLowerCase()))) return true;

  // Deliberately no generic "capitalised words" heuristic here: artist names
  // such as "Dave Matthews Band" would be mistaken for a place.
  return false;
}

/** Classify a single separator-delimited fragment. */
export function classifyFragment(text: string): FragmentClassification {
  const hasDate = containsDate(text);
  const hasYear = !hasDate && containsYear(text);
  const hasLive = containsLiveDescriptor(text);
  const hasLocation = looksLikeLocation(text);
  return {
    hasDate,
    hasYear,
    hasLive,
    hasLocation,
    isConcert: hasDate || hasLive || (hasYear && hasLocation),
  };
}

/**
 * Parse concert information out of a fragment.
 *
 * Returns `undefined` when the fragment carries no concert information.
 */
export function parseConcertFragment(
  fragment: string,
  dateOrder: 'MDY' | 'DMY' = 'MDY',
): ConcertInfo | undefined {
  const raw = fragment.trim();
  if (!raw) return undefined;

  let work = raw;
  let isLive = false;

  // 1. Live descriptors.
  for (const descriptor of LIVE_DESCRIPTORS) {
    const re = new RegExp(`\\b${descriptor}\\b`, 'i');
    if (re.test(work)) {
      if (!VERSION_ONLY_DESCRIPTORS.includes(descriptor.toLowerCase())) {
        isLive = true;
        work = work.replace(re, ' ');
      }
    }
  }
  if (!isLive) {
    for (const descriptor of WEAK_LIVE_DESCRIPTORS) {
      const re = new RegExp(`\\b${descriptor}\\b`, 'i');
      if (re.test(work) && (containsDate(work) || containsYear(work) || looksLikeLocation(work))) {
        isLive = true;
        work = work.replace(re, ' ');
        break;
      }
    }
  }

  // 2. Date (may borrow a year that appears later in the fragment).
  const dateMatch = extractDate(work, dateOrder);
  let date: string | undefined;
  let dateText: string | undefined;
  let year: number | undefined;
  let month: number | undefined;
  let day: number | undefined;
  const removals: string[] = [];

  if (dateMatch) {
    removals.push(...dateMatch.matchedParts);
    year = dateMatch.parts.year;
    month = dateMatch.parts.month;
    day = dateMatch.parts.day;
    if (dateMatch.parts.precision === 'day') {
      date = dateMatch.parts.iso;
      dateText = dateMatch.parts.text;
    } else if (dateMatch.parts.precision === 'month') {
      dateText = dateMatch.parts.text;
    }
  } else {
    const y = extractYear(work);
    if (y.year) {
      year = y.year;
      if (y.matched) removals.push(y.matched);
    }
  }

  for (const removal of removals) {
    work = work.replace(removal, ' ');
  }

  // 3. Location / venue.
  work = work
    .replace(/\b(recorded|filmed|performed|concert|broadcast|taped)\b/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  const loc = parseLocation(work);
  const location = formatLocation(loc);

  const hasAnything =
    isLive ||
    date !== undefined ||
    dateText !== undefined ||
    year !== undefined ||
    !!location;

  if (!hasAnything) return undefined;

  const info: ConcertInfo = { isLive };
  if (date) info.date = date;
  if (dateText) info.dateText = dateText;
  if (year !== undefined) info.year = year;
  if (month !== undefined) info.month = month;
  if (day !== undefined) info.day = day;
  if (location) info.location = location;
  if (loc.city) info.city = loc.city;
  if (loc.region) info.region = loc.region;
  if (loc.venue) info.venue = loc.venue;
  info.raw = raw;
  return info;
}

/**
 * Build the human readable concert suffix used in titles, e.g.
 * "October 1, 2020 - Boston, MA" or "Live - October 1, 2020 - Boston, MA".
 */
export function formatConcertSuffix(concert: ConcertInfo): string {
  const parts: string[] = [];
  if (concert.isLive) parts.push('Live');
  if (concert.dateText) parts.push(concert.dateText);
  else if (concert.year) parts.push(String(concert.year));
  if (concert.location) parts.push(concert.location);
  else if (concert.venue) parts.push(concert.venue);
  if (parts.length === 0) return '';
  return parts.join(' \u2013 ');
}
