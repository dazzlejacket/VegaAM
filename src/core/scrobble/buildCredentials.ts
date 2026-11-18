/**
 * Build-time injected credentials.
 *
 * VegaAM ships with the VegaFM Last.fm application credentials so that a
 * normal user never has to create a Last.fm API account and paste a key pair
 * into the settings. The pair is injected by the build script
 * (`build/build.mjs`) from the environment:
 *
 *   VEGAAM_LASTFM_API_KEY     - public half of the application key pair
 *   VEGAAM_LASTFM_API_SECRET  - private half of the application key pair
 *
 * The values are embedded in the packaged main-process bundle, therefore:
 *
 *   * they are NEVER written to the repository, a log file or a screenshot;
 *   * they are NOT a secret in the cryptographic sense - anyone with the
 *     installed application can extract them (see `docs/SECURITY.md`);
 *   * a release build refuses to run with a shared secret that was already
 *     exposed publicly (see `build/revokedSecrets.mjs`).
 *
 * The identifiers below are replaced by esbuild at build time. When the code
 * runs outside a build (unit tests, `tsx`, the raw TypeScript sources) the
 * identifiers are simply undefined and every built-in credential is empty.
 */

declare const __VEGAAM_LASTFM_API_KEY__: string;
declare const __VEGAAM_LASTFM_API_SECRET__: string;

/** Read a build-time injected constant without throwing when it is absent. */
function injected(value: string | undefined): string {
  return typeof value === 'string' ? value.trim() : '';
}

/** The public half of the built-in Last.fm application key pair. */
export const BUILT_IN_LASTFM_API_KEY = injected(
  typeof __VEGAAM_LASTFM_API_KEY__ === 'undefined' ? undefined : __VEGAAM_LASTFM_API_KEY__,
);

/** The private half of the built-in Last.fm application key pair. */
export const BUILT_IN_LASTFM_API_SECRET = injected(
  typeof __VEGAAM_LASTFM_API_SECRET__ === 'undefined' ? undefined : __VEGAAM_LASTFM_API_SECRET__,
);

/** True when the build carries a usable built-in Last.fm application key pair. */
export function hasBuiltInLastFmCredentials(): boolean {
  return Boolean(BUILT_IN_LASTFM_API_KEY && BUILT_IN_LASTFM_API_SECRET);
}
