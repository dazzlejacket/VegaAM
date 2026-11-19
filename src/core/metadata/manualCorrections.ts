/**
 * Remembered manual corrections.
 *
 * A correction is stored under the key of the *raw* metadata that produced
 * the wrong result. The key is built the same way in the normalizer and in
 * the user interface, so a correction saved in the interface is found again
 * when the same raw string is broadcast again.
 */

import { lookupKey } from '../util/text';

/** A correction of the artist and/or the title of a track. */
export interface ManualCorrection {
  artist?: string;
  title?: string;
  album?: string;
}

/** The map of remembered corrections. */
export type ManualCorrections = Record<string, ManualCorrection>;

/**
 * The key under which a correction for the given raw metadata is stored.
 *
 * Empty values are ignored so that a metadata string that only carries an
 * artist ("Cry") and one that carries an artist and a title ("Cry - Live")
 * do not silently share a correction.
 */
export function manualCorrectionKey(
  artist: string | null | undefined,
  title: string | null | undefined,
): string {
  return lookupKey([artist, title].filter((value) => Boolean(value)).join(' - '));
}

/**
 * A candidate the correction lookup may match.
 *
 * `kind` describes where the candidate came from. It is only used to explain
 * the match in the diagnostics view.
 */
export interface ManualCorrectionCandidate {
  artist?: string | null;
  title?: string | null;
  kind: 'raw-pair' | 'display-pair' | 'raw-title' | 'display-title' | 'raw-artist' | 'display-artist';
}

/** A correction that applies to the metadata that was looked up. */
export interface ManualCorrectionMatch {
  /** The key the correction was stored under. */
  key: string;
  /** The stored correction. */
  correction: ManualCorrection;
  /** Which candidate matched. */
  kind: ManualCorrectionCandidate['kind'];
}

/**
 * Find the correction that applies to a piece of metadata.
 *
 * The user cannot be expected to reproduce the exact strings the official
 * player published, and the interface never shows them as a pair. A
 * correction is therefore looked up with an ordered list of candidates:
 *
 *   1. the raw artist/title pair the player published,
 *   2. the artist/title pair the user sees in the interface,
 *   3. the raw song title on its own,
 *   4. the song title the user sees, on its own,
 *   5. the raw artist on its own,
 *   6. the artist the user sees, on its own.
 *
 * The first candidate that carries a stored correction wins, so the most
 * specific rule is always the one that applies.
 */
export function findManualCorrection(
  corrections: ManualCorrections | undefined,
  candidates: ManualCorrectionCandidate[],
): ManualCorrectionMatch | undefined {
  if (!corrections) return undefined;

  for (const candidate of candidates) {
    const hasArtist = Boolean(candidate.artist);
    const hasTitle = Boolean(candidate.title);
    if (!hasArtist && !hasTitle) continue;

    const key = manualCorrectionKey(candidate.artist, candidate.title);
    if (!key) continue;

    const correction = corrections[key];
    if (correction) {
      return { key, correction, kind: candidate.kind };
    }
  }

  return undefined;
}

/**
 * Store a correction for the given raw metadata.
 *
 * Returns a new map - the input is never modified.
 */
export function withManualCorrection(
  corrections: ManualCorrections | undefined,
  rawArtist: string | null | undefined,
  rawTitle: string | null | undefined,
  correction: ManualCorrection,
): ManualCorrections {
  const key = manualCorrectionKey(rawArtist, rawTitle);
  if (!key) return { ...(corrections ?? {}) };
  const next: ManualCorrections = { ...(corrections ?? {}) };
  const existing = next[key] ?? {};
  const artist = correction.artist?.trim();
  const title = correction.title?.trim();
  const album = correction.album?.trim();
  if (artist) existing.artist = artist;
  if (title) existing.title = title;
  if (album) existing.album = album;
  if (!existing.artist && !existing.title && !existing.album) return next;
  next[key] = existing;
  return next;
}

/** Remove the correction that belongs to the given raw metadata. */
export function withoutManualCorrection(
  corrections: ManualCorrections | undefined,
  rawArtist: string | null | undefined,
  rawTitle: string | null | undefined,
): ManualCorrections {
  const key = manualCorrectionKey(rawArtist, rawTitle);
  if (!key || !corrections) return { ...(corrections ?? {}) };
  const next: ManualCorrections = { ...corrections };
  delete next[key];
  return next;
}
