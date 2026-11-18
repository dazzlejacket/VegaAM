/**
 * Encrypted secret storage.
 *
 * Electron's `safeStorage` uses the operating system key store (DPAPI on
 * Windows, the Keychain on macOS, libsecret/kwallet on Linux). Secrets are
 * encrypted before they are written to disk and are never exposed to the
 * renderer - only the main process can read them.
 *
 * The rules that keep the storage predictable on every platform:
 *
 *   1. Secrets are never written in plain text. When the operating system
 *      cannot encrypt at all, the secrets stay in memory and the application
 *      reports that they do not survive a restart.
 *   2. The file is only rewritten when its content actually changed. Every
 *      write encrypts the payload, and on macOS every encryption touches the
 *      Keychain - a stable file means a stable number of Keychain prompts.
 *   3. The asynchronous Electron API is used (`encryptStringAsync`,
 *      `decryptStringAsync`). It survives a rotated key (the Keychain key is
 *      replaced from time to time) and it never blocks the main thread.
 *   4. The development build keeps its own file. The operating system key
 *      store entry of an unpackaged development run is a *different* entry
 *      than the one of the signed release build, so the two must never fight
 *      over the same encrypted file.
 */

import { existsSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { safeStorage } from 'electron';

import {
  classifySecretBackend,
  describeSecretStorage,
  type SecretBackend,
  type SecretStorageStatus,
} from '../core/secrets/storage';

export interface Secrets {
  /** Last.fm session key. */
  lastfmSessionKey?: string;
  /** ListenBrainz user token. */
  listenbrainzToken?: string;
  /** Last.fm API secret (private part of a user supplied API key pair). */
  lastfmApiSecret?: string;
}

export type { SecretBackend, SecretStorageStatus };

/**
 * The build variant the secret store belongs to.
 *
 * `production` is the packaged application, `development` is an unpackaged
 * run. Both share the same profile directory, but they use different
 * operating system key store entries and therefore different files.
 */
export type SecretStoreVariant = 'production' | 'development';

export class SecretStore {
  private readonly filePath: string;
  private secrets: Secrets = {};
  private lastWritten: string | undefined;
  private availableFlag = false;
  private probed = false;
  private backendValue: SecretBackend = 'unknown';

  constructor(userDataPath: string, variant: SecretStoreVariant = 'production') {
    this.filePath = join(
      userDataPath,
      variant === 'development' ? 'secrets.dev.enc' : 'secrets.enc',
    );
  }

  /** The file the encrypted secrets are stored in. */
  get path(): string {
    return this.filePath;
  }

  /**
   * True when the operating system offers an encrypted storage backend.
   *
   * The value is filled in by `load()` / `ensureAvailable()`. Use
   * `ensureAvailable()` when the value has to be current.
   */
  get available(): boolean {
    return this.availableFlag;
  }

  /** The encryption backend Electron selected for this platform. */
  get backend(): SecretBackend {
    return this.backendValue;
  }

  /** Probe the operating system key store and cache the result. */
  async ensureAvailable(): Promise<boolean> {
    if (this.probed) return this.availableFlag;
    this.probed = true;
    try {
      this.availableFlag = await safeStorage.isAsyncEncryptionAvailable();
    } catch {
      this.availableFlag = false;
    }
    try {
      const selected =
        process.platform === 'linux' ? safeStorage.getSelectedStorageBackend() : null;
      this.backendValue = classifySecretBackend(process.platform, selected);
    } catch {
      this.backendValue = 'unknown';
    }
    return this.availableFlag;
  }

  /** The current state of the encrypted storage. */
  status(): SecretStorageStatus {
    return describeSecretStorage({
      available: this.availableFlag,
      backend: this.backendValue,
    });
  }

  /** Load and decrypt the secrets. */
  async load(): Promise<Secrets> {
    this.secrets = {};
    this.lastWritten = undefined;
    await this.ensureAvailable();
    if (!existsSync(this.filePath)) return this.secrets;
    try {
      const raw = await readFile(this.filePath, 'utf8');
      if (!this.availableFlag) return this.secrets;
      const { result, shouldReEncrypt } = await safeStorage.decryptStringAsync(
        Buffer.from(raw, 'base64'),
      );
      this.secrets = JSON.parse(result) as Secrets;
      this.lastWritten = raw;

      // The operating system rotated its key (this happens on macOS and on
      // Linux key rings). Re-encrypt with the current key so the next start
      // does not lose the session.
      if (shouldReEncrypt) {
        await this.save(this.secrets);
      }
    } catch (error) {
      console.warn('[secrets] could not decrypt the secret store:', error);
      this.secrets = {};
    }
    return this.secrets;
  }

  /**
   * Encrypt and persist the secrets.
   *
   * Returns true when the secrets are on disk. The file is only written when
   * the payload changed, so an unchanged secret never touches the operating
   * system key store again.
   */
  async save(secrets: Secrets): Promise<boolean> {
    this.secrets = secrets;
    if (!(await this.ensureAvailable())) {
      console.warn('[secrets] no OS encryption available - secrets are kept in memory only.');
      return false;
    }
    const payload = JSON.stringify(secrets);
    const encrypted = (await safeStorage.encryptStringAsync(payload)).toString('base64');
    if (encrypted === this.lastWritten && existsSync(this.filePath)) {
      // Nothing changed - do not touch the key store again.
      return true;
    }
    await writeFile(this.filePath, encrypted, 'utf8');
    this.lastWritten = encrypted;
    return true;
  }

  /** Merge a patch into the secrets. */
  async patch(patch: Partial<Secrets>): Promise<void> {
    const next = { ...this.secrets, ...patch };
    const changed = (Object.keys(next) as (keyof Secrets)[]).some(
      (key) => !sameSecretValue(next[key], this.secrets[key]),
    );
    if (!changed) return;
    await this.save(next);
  }

  /** Forget every stored secret. */
  async clear(): Promise<void> {
    this.secrets = {};
    if (existsSync(this.filePath)) {
      // Overwrite with an empty encrypted payload instead of deleting the file
      // so that no recoverable secret material stays on disk.
      try {
        const encrypted = (await safeStorage.encryptStringAsync('{}')).toString('base64');
        await writeFile(this.filePath, encrypted, 'utf8');
        this.lastWritten = encrypted;
      } catch {
        /* ignore */
      }
    }
  }

  /** The decrypted secrets (main process only). */
  get(): Secrets {
    return this.secrets;
  }
}

/**
 * An empty secret and a missing secret mean the same thing.
 *
 * Treating them as equal keeps the store from writing an unchanged file -
 * which matters on macOS, where every write encrypts and every encryption
 * touches the Keychain.
 */
function sameSecretValue(a: string | undefined, b: string | undefined): boolean {
  const left = (a ?? '').trim();
  const right = (b ?? '').trim();
  return left === right;
}
