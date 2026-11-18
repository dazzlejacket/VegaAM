/**
 * Rotation guard for the Last.fm application credentials.
 *
 * The shared secret of the VegaFM Last.fm application was published in a
 * public issue tracker. A shared secret that is known to the world is a
 * compromised secret: it has to be rotated at Last.fm before the application
 * is shipped again.
 *
 * This module lets the build detect that exact secret without storing it.
 * Only the SHA-256 digest of the exposed secret is kept, so the repository
 * never contains the secret itself - a digest of a 128 bit random secret
 * cannot be reversed into it.
 */

import { createHash } from 'node:crypto';

/** SHA-256 digests of shared secrets that must never be shipped. */
export const REVOKED_LASTFM_SECRET_DIGESTS = [
  // The VegaFM Last.fm shared secret that was published in the issue tracker.
  '9887b256dedbc0e6c2040eae164c9d95816e2306a18bfd7d2d527e12a6b87f37',
];

/** The digest of a secret, used for the comparison. */
export function secretDigest(secret) {
  return createHash('sha256').update(secret, 'utf8').digest('hex');
}

/**
 * True when the secret is one of the revoked (already exposed) secrets.
 */
export function isRevokedLastFmSecret(secret, digests = REVOKED_LASTFM_SECRET_DIGESTS) {
  if (!secret) return false;
  return digests.includes(secretDigest(secret));
}
