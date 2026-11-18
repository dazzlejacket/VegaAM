/**
 * Small helpers for persisting JSON documents safely.
 *
 * Writes are atomic (temporary file + rename) so that a crash can never
 * leave a half written settings or history file behind.
 */

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

export class JsonFile<T> {
  private readonly filePath: string;
  private readonly fallback: T;
  private cache: T | undefined;
  private writeChain: Promise<void> = Promise.resolve();

  constructor(filePath: string, fallback: T) {
    this.filePath = filePath;
    this.fallback = fallback;
  }

  get path(): string {
    return this.filePath;
  }

  /** Read the document, falling back to the default value. */
  async read(): Promise<T> {
    if (this.cache !== undefined) return this.cache;
    try {
      const raw = await readFile(this.filePath, 'utf8');
      this.cache = JSON.parse(raw) as T;
    } catch {
      this.cache = this.fallback;
    }
    return this.cache;
  }

  /** Write the document atomically. */
  async write(value: T): Promise<void> {
    this.cache = value;
    const serialized = JSON.stringify(value, null, 2);
    this.writeChain = this.writeChain.catch(() => undefined).then(async () => {
      await mkdir(dirname(this.filePath), { recursive: true });
      const tmp = join(dirname(this.filePath), `.${Date.now()}-${Math.random().toString(36).slice(2)}.tmp`);
      await writeFile(tmp, serialized, 'utf8');
      await rename(tmp, this.filePath);
    });
    await this.writeChain;
  }

  /** Update the document with a mutation function. */
  async update(mutator: (current: T) => T): Promise<T> {
    const current = await this.read();
    const next = mutator(current);
    await this.write(next);
    return next;
  }
}
