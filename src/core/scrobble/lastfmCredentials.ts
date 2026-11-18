/**
 * Resolution of the effective Last.fm API credential pair.
 *
 * VegaAM prefers a credential pair the user supplied themselves (they may own
 * their own Last.fm API account) and falls back to the built-in VegaFM
 * application credentials that are injected at build time. A normal user
 * therefore never has to supply credentials at all.
 *
 * The resolution is kept in a pure module so that the same rules run on
 * Windows, macOS and Linux and can be regression tested without Electron.
 */

import { BUILT_IN_LASTFM_API_KEY, BUILT_IN_LASTFM_API_SECRET } from './buildCredentials';

export type LastFmCredentialSource = 'user' | 'build' | 'none';

export interface LastFmCredentialInput {
  /** The API key the user typed into the settings. */
  userApiKey?: string | null;
  /** The shared secret the user typed into the settings. */
  userApiSecret?: string | null;
  /** The public half of the built-in application key pair. */
  buildApiKey?: string | null;
  /** The private half of the built-in application key pair. */
  buildApiSecret?: string | null;
}

export interface ResolvedLastFmCredentials {
  apiKey: string;
  apiSecret: string;
  source: LastFmCredentialSource;
  /** True when both halves of the pair are present. */
  usable: boolean;
}

function trim(value: string | null | undefined): string {
  return typeof value === 'string' ? value.trim() : '';
}

/**
 * Resolve the credential pair that is actually used for API calls.
 *
 * A user supplied key only wins when the matching secret is present as well -
 * a half configured pair would break every signed request, so the built-in
 * pair is used instead in that case.
 */
export function resolveLastFmCredentials(
  input: LastFmCredentialInput = {},
): ResolvedLastFmCredentials {
  const userApiKey = trim(input.userApiKey);
  const userApiSecret = trim(input.userApiSecret);
  if (userApiKey && userApiSecret) {
    return { apiKey: userApiKey, apiSecret: userApiSecret, source: 'user', usable: true };
  }

  const buildApiKey = trim(input.buildApiKey ?? BUILT_IN_LASTFM_API_KEY);
  const buildApiSecret = trim(input.buildApiSecret ?? BUILT_IN_LASTFM_API_SECRET);
  if (buildApiKey && buildApiSecret) {
    return {
      apiKey: buildApiKey,
      apiSecret: buildApiSecret,
      source: 'build',
      usable: true,
    };
  }

  return { apiKey: '', apiSecret: '', source: 'none', usable: false };
}
