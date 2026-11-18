/**
 * Local scrobble history and metadata diagnostics.
 *
 * Everything stays on the machine. The history explains *why* a track was or
 * was not scrobbled, which is the single most useful piece of information
 * when the metadata parser misbehaves.
 */

import { join } from 'node:path';

import type { NormalizedTrack } from '../core/metadata/types';
import { JsonFile } from './jsonFile';

export interface ServiceOutcome {
  service: 'lastfm' | 'listenbrainz';
  ok: boolean;
  error?: string;
  at: number;
}

export interface HistoryEntry {
  id: string;
  /** Epoch ms when the track started playing. */
  startedAt: number;
  /** Epoch ms when the entry was written. */
  at: number;
  artist: string | null;
  title: string;
  channel: string | null;
  /** The raw strings exactly as the player reported them. */
  rawArtist: string | null;
  rawTitle: string | null;
  /** The normalised metadata including the decision trail. */
  normalized: NormalizedTrack;
  /** True when the track was submitted to at least one service. */
  scrobbled: boolean;
  /** Per service results. */
  services: ServiceOutcome[];
  /** Why the track was (not) scrobbled. */
  reason: string;
}

export interface HistoryFile {
  entries: HistoryEntry[];
}

const MAX_ENTRIES = 500;

export class HistoryStore {
  private readonly file: JsonFile<HistoryFile>;

  constructor(userDataPath: string) {
    this.file = new JsonFile<HistoryFile>(join(userDataPath, 'history.json'), { entries: [] });
  }

  async load(): Promise<HistoryEntry[]> {
    const data = await this.file.read();
    return data.entries ?? [];
  }

  /** All entries, newest first. */
  async list(): Promise<HistoryEntry[]> {
    const entries = await this.load();
    return [...entries].sort((a, b) => b.at - a.at);
  }

  /** Add or update an entry (identified by id). */
  async upsert(entry: HistoryEntry): Promise<HistoryEntry> {
    const data = await this.file.read();
    const entries = data.entries ?? [];
    const index = entries.findIndex((e) => e.id === entry.id);
    if (index >= 0) {
      const existing = entries[index]!;
      entry.services = existing.services;
      entry.scrobbled = existing.services.some(s => s.ok);
      entries[index] = entry;
    }
    else entries.push(entry);
    if (entries.length > MAX_ENTRIES) entries.splice(0, entries.length - MAX_ENTRIES);
    await this.file.write({ entries });
    return entry;
  }

  /** Update the service results of an entry. */
  async recordService(id: string, outcome: ServiceOutcome): Promise<void> {
    const data = await this.file.read();
    const entries = data.entries ?? [];
    const entry = entries.find((e) => e.id === id);
    if (!entry) return;
    entry.services = entry.services.filter((s) => s.service !== outcome.service);
    entry.services.push(outcome);
    entry.scrobbled = entry.services.some((s) => s.ok);
    await this.file.write({ entries });
  }

  /** True when the same track was scrobbled within the given window. */
  async isDuplicate(artist: string, title: string, windowMs: number): Promise<boolean> {
    const entries = await this.load();
    const now = Date.now();
    return entries.some(
      (entry) =>
        entry.scrobbled &&
        entry.artist?.toLowerCase() === artist.toLowerCase() &&
        entry.title.toLowerCase() === title.toLowerCase() &&
        now - entry.startedAt < windowMs,
    );
  }

  /** Remove every entry. */
  async clear(): Promise<void> {
    await this.file.write({ entries: [] });
  }
}
