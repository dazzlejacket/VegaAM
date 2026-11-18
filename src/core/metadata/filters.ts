/**
 * Detection of metadata that must never be scrobbled: advertisements, station
 * promos, DJ/talk segments, station identifiers and talk/interview programme
 * identities.
 *
 * The detector is intentionally conservative and always reports *why* a piece
 * of metadata was skipped so the user can override it in the diagnostics view.
 * Rejecting a real song is worse than missing a talk segment, so every rule
 * is anchored on the complete token(s) that identify a programme.
 */

export interface FilterResult {
  skip: boolean;
  reason?: string;
  /** Machine readable identifier of the rule that matched. */
  rule?: string;
}

interface FilterRule {
  id: string;
  label: string;
  pattern: RegExp;
}

const AD_RULES: FilterRule[] = [
  { id: 'ad:explicit', label: 'advertisement', pattern: /\b(advertisement|advertorial|commercial break|paid advertisement)\b/i },
  { id: 'ad:phone', label: 'phone number', pattern: /\b1[-\s]?8(?:00|44|66|77|88)[-\s]?\d{3}[-\s]?\d{4}\b/ },
  { id: 'ad:cta', label: 'call to action', pattern: /\b(call (now|today|1-800)|text \w+ to \d{5,}|your number here|subscribe now|free trial|sign up now)\b/i },
  { id: 'ad:brand', label: 'sponsor or promo', pattern: /\b(presented by|sponsored by|brought to you by|exclusive to siriusxm|only on siriusxm|trial code|promo code)\b/i },
  { id: 'ad:web', label: 'promo url', pattern: /\b(siriusxm\.com|sxm\.com|sxm\.link)\b/i },
];

const DJ_RULES: FilterRule[] = [
  { id: 'dj:welcome', label: 'DJ intro', pattern: /\b(welcome (back )?to|you'?re listening to|you are listening to|glad you'?re (here|tuned in))\b/i },
  { id: 'dj:host', label: 'host commentary', pattern: /\b(this is|i'?m|my name is) [A-Z][\p{L}\d'.-]{1,20} (here )?(on|with) /u },
  { id: 'dj:segment', label: 'talk segment', pattern: /\b(coming up on|stay tuned|we'?ll be right back|don'?t go anywhere|thanks for listening|great to be with you)\b/i },
  { id: 'dj:station', label: 'station identifier', pattern: /\b(siriusxm|sxm)\s*(hit|channel|ch)?\s*\d{1,3}\b/i },
  { id: 'dj:show', label: 'show bumper', pattern: /\bthis (is|has been) (a )?(siriusxm|the) (show|program|celebration)\b/i },
];

/**
 * SiriusXM talk / interview programme identities.
 *
 * These are programme markers rather than DJ speech: a channel hashtag, a
 * call-in telephone number, a programming banner and an artist/programme
 * pairing. Every pattern requires the complete programme token(s), so an
 * ordinary song title is never rejected.
 */
const PROGRAMME_RULES: FilterRule[] = [
  {
    id: 'programme:hashtag',
    label: 'programme hashtag',
    // The Beatles interview channel publishes its requests as the artist
    // "#FabFourum". Only that exact token is matched: a generic "#word" rule
    // would also reject real songs whose title carries a hashtag
    // (e.g. "#Delicate"), which is worse than having no rule at all.
    pattern: /(?<![\w#])#fabfourum\b/i,
  },
  {
    id: 'programme:talkline',
    label: 'talk line number',
    // "844.999.2328" is the show call-in line and must be matched as one
    // number, not as three separate words. The pattern only accepts a
    // numeric 3-3-4 grouping (optionally hyphenated); no song title uses
    // that shape.
    pattern: /\b[2-9]\d{2}(?:\.\d{3}\.\d{4}|-\d{3}-\d{4})\b/,
  },
  {
    id: 'programme:banner',
    label: 'programming banner',
    // "On Air — Your Stories" is a SiriusXM programming banner. Both halves
    // are mandatory, so the plausible song titles "On Air" and "Your Stories"
    // stay scrobble safe on their own. The separator may be an em dash, en
    // dash, hyphen, colon or plain whitespace.
    pattern: /\bon\s+air\b\s*(?:[-—–:]\s*)?your\s+stories\b/i,
  },
  {
    id: 'programme:interview',
    label: 'interview programme',
    // "Zoey Deutch — Beatlemania!!" is an interview programme. The artist name
    // is mandatory, so a track that merely contains the word "Beatlemania"
    // (without the artist) is unaffected. The separator may be an em dash, en
    // dash, hyphen, colon or plain whitespace.
    pattern: /\bzoey\s+deutch\b\s*(?:[-—–:]\s*)?beatlemania\b/i,
  },
];

const ALL_RULES: FilterRule[] = [...AD_RULES, ...DJ_RULES, ...PROGRAMME_RULES];

/**
 * Check a piece of metadata for advertisement / talk content.
 *
 * The complete raw string (artist + title + channel) is checked so that
 * station identifiers in the channel name are detected as well.
 */
export function detectNonMusicMetadata(text: string): FilterResult {
  if (!text || !text.trim()) return { skip: false };

  for (const rule of ALL_RULES) {
    if (rule.pattern.test(text)) {
      return { skip: true, reason: `Matched ${rule.label}`, rule: rule.id };
    }
  }
  return { skip: false };
}

/** All filter rule identifiers (used by the settings UI). */
export function listFilterRules(): { id: string; label: string; kind: string }[] {
  return ALL_RULES.map((r) => ({
    id: r.id,
    label: r.label,
    kind: r.id.split(':')[0] ?? 'other',
  }));
}
