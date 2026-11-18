/**
 * The allowlist of external links and permissions.
 *
 * The application may hand a link to the system browser, but only when the
 * link belongs to a host that is known to belong to SiriusXM or to one of the
 * scrobbling services.
 */

/** The hosts that may be opened in the system browser. */
export const ALLOWED_EXTERNAL_HOSTS: readonly string[] = Object.freeze([
  'siriusxm.com',
  'last.fm',
  'listenbrainz.org',
  'metalmatrix.com',
]);

/**
 * True when the URL may be opened in the system browser.
 */
export function isAllowedExternalUrl(url: string): boolean {
  if (typeof url !== 'string' || !url.trim()) return false;

  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }

  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return false;

  const host = parsed.hostname.toLowerCase();
  if (!host) return false;

  return ALLOWED_EXTERNAL_HOSTS.some(
    (allowed) => host === allowed || host.endsWith(`.${allowed}`),
  );
}

/**
 * The permissions the official player is allowed to ask for.
 *
 * Everything else (camera, microphone, geolocation, notifications) is denied.
 */
export const ALLOWED_PERMISSIONS: readonly string[] = Object.freeze([
  'fullscreen',
  'clipboard-sanitized-write',
  'clipboard-read',
  'mediaKeySystem',
]);
