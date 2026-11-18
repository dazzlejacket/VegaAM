/**
 * Global media keys.
 *
 * `globalShortcut` with the `Media*` accelerators works on Windows and on
 * Linux desktops that forward media keys to the session bus. macOS handles
 * media keys itself and does not expose them to applications.
 */

import { globalShortcut } from 'electron';

export type MediaCommand = 'play' | 'pause' | 'toggle' | 'next' | 'previous' | 'stop';

const ACCELERATORS: { accelerator: string; command: MediaCommand }[] = [
  { accelerator: 'MediaPlayPause', command: 'toggle' },
  { accelerator: 'MediaNextTrack', command: 'next' },
  { accelerator: 'MediaPreviousTrack', command: 'previous' },
  { accelerator: 'MediaStop', command: 'stop' },
];

export class ShortcutManager {
  private registered: string[] = [];

  /** Register the media keys. */
  register(handler: (command: MediaCommand) => void): string[] {
    this.unregister();
    for (const { accelerator, command } of ACCELERATORS) {
      try {
        const ok = globalShortcut.register(accelerator, () => handler(command));
        if (ok) this.registered.push(accelerator);
      } catch {
        // The accelerator may already be taken by another application.
      }
    }
    return this.registered;
  }

  /** Remove all registered shortcuts. */
  unregister(): void {
    for (const accelerator of this.registered) {
      try {
        globalShortcut.unregister(accelerator);
      } catch {
        /* ignore */
      }
    }
    this.registered = [];
  }

  get registeredAccelerators(): string[] {
    return [...this.registered];
  }
}
