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
  if (artist) existing.artist = artist;
  if (title) existing.title = title;
  if (!existing.artist && !existing.title) return next;
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
