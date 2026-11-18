/**
 * Settings storage with non-destructive v2 -> v3 backup.
 *
 * The settings are plain JSON in the user data directory. Secrets are *not*
 * stored here - they live in the encrypted secret store.
 */

import { existsSync } from 'node:fs';
import { copyFile } from 'node:fs/promises';
import { join } from 'node:path';

import { mergeSettings, SETTINGS_VERSION, type AppSettings } from '../core/settings/defaults';
import { needsV3Migration } from '../core/settings/migrations';
import { JsonFile } from './jsonFile';

export class SettingsStore {
  private readonly settingsPath: string;
  private readonly backupPath: string;
  private readonly file: JsonFile<AppSettings>;
  private settings: AppSettings;

  constructor(userDataPath: string) {
    this.settingsPath = join(userDataPath, 'settings.json');
    this.backupPath = join(userDataPath, 'settings.v2.backup.json');
    this.file = new JsonFile<AppSettings>(this.settingsPath, mergeSettings({}));
    this.settings = mergeSettings({});
  }

  /** Load the settings from disk, backing up v1/v2 settings before migration. */
  async load(): Promise<AppSettings> {
    const stored = await this.file.read();
    this.settings = mergeSettings(stored);
    await this.rewriteWhenStale(stored);
    return this.settings;
  }

  /**
   * Rewrite the stored document when it requires migration to the current
   * schema version, creating a non-destructive `settings.v2.backup.json` first.
   */
  private async rewriteWhenStale(stored: unknown): Promise<void> {
    const storedVersion = Number((stored as { settingsVersion?: unknown } | null)?.settingsVersion);
    const requiresMigration =
      needsV3Migration(stored) ||
      !Number.isFinite(storedVersion) ||
      storedVersion < SETTINGS_VERSION;

    if (!requiresMigration) return;

    if (existsSync(this.settingsPath) && !existsSync(this.backupPath)) {
      try {
        await copyFile(this.settingsPath, this.backupPath);
      } catch {
        /* ignore backup error on read-only test fixtures */
      }
    }

    await this.file.write(this.settings);
  }

  /** The current settings. */
  get(): AppSettings {
    return this.settings;
  }

  /** Persist a patch and return the merged settings. */
  async patch(patch: Partial<AppSettings>): Promise<AppSettings> {
    const nextInput: Record<string, unknown> = { ...this.settings, ...patch };
    if ('scrobbleMutedChannels' in patch && !('mutedChannels' in patch)) {
      nextInput.mutedChannels = patch.scrobbleMutedChannels;
    } else if ('mutedChannels' in patch && !('scrobbleMutedChannels' in patch)) {
      nextInput.scrobbleMutedChannels = patch.mutedChannels;
    }
    if ('compactPlayerEnabled' in patch && !('miniPlayerEnabled' in patch)) {
      nextInput.miniPlayerEnabled = patch.compactPlayerEnabled;
    } else if ('miniPlayerEnabled' in patch && !('compactPlayerEnabled' in patch)) {
      nextInput.compactPlayerEnabled = patch.miniPlayerEnabled;
    }
    this.settings = mergeSettings(nextInput);
    await this.file.write(this.settings);
    return this.settings;
  }

  /** Persist the current settings. */
  async save(): Promise<void> {
    await this.file.write(this.settings);
  }
}
