/**
 * Text normalisation helpers shared by the metadata engine.
 *
 * SiriusXM metadata is frequently inconsistent: mixed dashes, curly quotes,
 * non-breaking spaces, stray control characters and duplicated whitespace.
 * Everything is normalised *before* parsing so that the pattern matchers only
 * have to deal with one canonical shape.
 */

/** Characters that are treated as a "separator dash" between fields. */
const DASHES = /[\u2010-\u2015\u2212\uFF0D]/g;

const QUOTES_LEFT = /[\u2018\u201B\u2039\u00AB]/g;
const QUOTES_RIGHT = /[\u2019\u201A\u203A\u00BB]/g;
const DOUBLE_QUOTES_LEFT = /[\u201C\u201E\u201F]/g;
const DOUBLE_QUOTES_RIGHT = /[\u201D\u201D\u201D]/g;

/** Zero-width / formatting characters that carry no meaning for parsing. */
const INVISIBLE = /[\u200B-\u200F\u202A-\u202E\u2060-\u2064\uFEFF]/g;

/** Control characters other than tab/newline. */
const CONTROL = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g;

/**
 * Normalise unicode and whitespace without destroying meaningful characters
 * (accented letters, non-latin scripts, emoji in titles, ...).
 */
export function normalizeText(input: string | null | undefined): string {
  if (!input) return '';
  let out = input.normalize('NFKC');
  out = out.replace(INVISIBLE, '');
  out = out.replace(CONTROL, ' ');
  out = out.replace(DASHES, '-');
  out = out.replace(DOUBLE_QUOTES_LEFT, '"');
  out = out.replace(DOUBLE_QUOTES_RIGHT, '"');
  out = out.replace(QUOTES_LEFT, "'");
  out = out.replace(QUOTES_RIGHT, "'");
  out = out.replace(/\u2026/g, '...');
  out = out.replace(/\u00A0/g, ' ');
  out = out.replace(/[ \t]+/g, ' ');
  out = out.replace(/\s*\n\s*/g, ' ');
  return out.trim();
}

/** Collapse repeated separators and trim dangling punctuation. */
export function tidy(input: string): string {
  return input
    .replace(/\s{2,}/g, ' ')
    .replace(/\s+([,;:])/g, '$1')
    .replace(/\(\s+/g, '(')
    .replace(/\s+\)/g, ')')
    .replace(/\[\s+/g, '[')
    .replace(/\s+\]/g, ']')
    .replace(/\s*-\s*$/g, '')
    .replace(/^[\s\-:|]+/, '')
    .trim();
}

/** Title-case aware word count (used by the artist/title heuristics). */
export function words(input: string): string[] {
  return input
    .split(/[\s/]+/)
    .map((w) => w.trim())
    .filter((w) => w.length > 0);
}

/** True when the string contains at least one letter from any script. */
export function hasLetter(input: string): boolean {
  return /\p{L}/u.test(input);
}

/**
 * A token is "capitalised" when it starts with an upper-case letter or is
 * written in all caps. Handles accented and non-latin scripts.
 */
export function isCapitalized(token: string): boolean {
  if (!token) return false;
  const letters = token.match(/\p{L}+/gu);
  if (!letters || letters.length === 0) return false;
  const first = letters[0]!;
  if (first === first.toUpperCase() && first !== first.toLowerCase()) return true;
  return token === token.toUpperCase() && /\p{L}/u.test(token);
}

/** Remove a trailing/leading whitespace and quotes. */
export function stripQuotes(input: string): string {
  return input.replace(/^["'\s]+|["'\s]+$/g, '');
}

/** Uppercase, punctuation-free key used for lookups (channel names, aliases). */
export function lookupKey(input: string | null | undefined): string {
  if (!input) return '';
  return normalizeText(input)
    .toLowerCase()
    .replace(/[^a-z0-9\u00C0-\uFFFF]+/g, ' ')
    .trim();
}
