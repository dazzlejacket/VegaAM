/**
 * Platform independent description of the credential storage.
 *
 * Electron's `safeStorage` picks a different backend per operating system:
 * DPAPI on Windows, the Keychain on macOS and libsecret / kwallet / the weak
 * `basic_text` fallback on Linux.
 *
 * The classification lives in a pure module so the rules are regression
 * tested on every platform - a Windows test run proves the macOS and Linux
 * behaviour, and the Linux CI job proves it again on the real backend.
 */

/** The encryption backend Electron selected for this platform. */
export type SecretBackend =
  | 'dpapi'
  | 'keychain'
  | 'gnome_libsecret'
  | 'kwallet'
  | 'basic_text'
  | 'unknown';

export interface SecretStorageStatus {
  /** True when the operating system offers an encrypted storage backend. */
  available: boolean;
  /** The backend Electron selected. */
  backend: SecretBackend;
  /** True when the backend is a real operating system key store. */
  strong: boolean;
  /** True when the secrets survive an application restart. */
  persistent: boolean;
  /** Human readable explanation for the diagnostics view. */
  detail: string;
}

/**
 * Classify the backend for a platform.
 *
 * @param platform `process.platform` of the running system.
 * @param selectedBackend The backend Electron reported (Linux only).
 */
export function classifySecretBackend(
  platform: string,
  selectedBackend: string | null | undefined,
): SecretBackend {
  if (platform === 'win32') return 'dpapi';
  if (platform === 'darwin') return 'keychain';
  if (platform === 'linux') {
    if (
      selectedBackend === 'gnome_libsecret' ||
      selectedBackend === 'kwallet' ||
      selectedBackend === 'basic_text'
    ) {
      return selectedBackend;
    }
  }
  return 'unknown';
}

/**
 * Describe how the credentials are protected on this platform.
 *
 * The wording is used in the diagnostics view, so it explains what the user
 * can expect rather than naming an internal API.
 */
export function describeSecretStorage(input: {
  available: boolean;
  backend: SecretBackend;
}): SecretStorageStatus {
  const { available, backend } = input;
  const strong = available && backend !== 'basic_text' && backend !== 'unknown';
  const persistent = available;

  let detail: string;
  if (!available) {
    detail =
      'This system cannot encrypt credentials, so VegaAM keeps them in memory only. ' +
      'The Last.fm session has to be reconnected after every restart.';
  } else if (backend === 'basic_text') {
    detail =
      'No system key ring was found, so VegaAM uses the weak Linux fallback encryption. ' +
      'Install gnome-keyring or kwallet to protect the session with the operating system key store.';
  } else if (backend === 'keychain') {
    detail =
      'The Last.fm session is stored in the macOS Keychain (Electron Safe Storage). ' +
      'macOS asks for permission again when the application signature changes.';
  } else if (backend === 'dpapi') {
    detail = 'The Last.fm session is stored with Windows DPAPI, bound to this Windows user.';
  } else if (backend === 'gnome_libsecret') {
    detail = 'The Last.fm session is stored in the GNOME key ring (libsecret).';
  } else if (backend === 'kwallet') {
    detail = 'The Last.fm session is stored in the KDE wallet.';
  } else {
    detail = 'The Last.fm session is stored with the operating system encryption service.';
  }

  return { available, backend, strong, persistent, detail };
}
