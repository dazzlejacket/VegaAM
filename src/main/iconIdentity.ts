/**
 * Windows icon-identity repair for VegaAM.
 *
 * ## Why this module exists
 *
 * VegaAM 3.2.2 hotfix. A running VegaAM window showed the **stock Electron
 * "nucleus"** in the Windows taskbar even though every artifact carried the
 * V-star:
 *
 * - the packaged executable embeds the V-star (`build/icon.ico` via rcedit),
 * - the window itself reports the V-star through `WM_GETICON`,
 * - the AUMID registry entry points `IconUri` at the V-star executable.
 *
 * ### Root cause
 *
 * When a process sets an explicit `AppUserModelId`, Windows resolves the
 * taskbar button of that process by looking for **shortcuts that advertise the
 * same AUMID**. A leftover development shortcut
 *
 *   `%APPDATA%\Microsoft\Windows\Start Menu\Programs\Electron.lnk`
 *
 * carried `System.AppUserModel.ID = app.vegaam.desktop` while targeting
 * `node_modules\electron\dist\electron.exe`. The shell resolved our AUMID to
 * that shortcut and used the Electron atom as the taskbar icon. Clearing the
 * icon cache or restarting Explorer did **not** help, because the stale
 * shortcut itself carried the identity and the atom.
 *
 * ### What the repair does
 *
 * 1. Removes shortcuts that squat *our* AUMID while targeting an Electron
 *    binary. Legitimate VegaAM shortcuts are never touched: they point at
 *    `VegaAM.exe`.
 * 2. (Re)registers `HKCU\Software\Classes\AppUserModelId\app.vegaam.desktop`
 *    with a real icon path so toast notifications and the shell agree on the
 *    identity even before an installer runs.
 * 3. Refreshes the Windows shell icon cache.
 *
 * Safety invariants:
 *   - Only files inside the Start Menu `Programs` folder and the user's
 *     Desktop are ever considered.
 *   - A shortcut is only removed when it advertises *our* AUMID **and**
 *     references an `electron.exe` binary **and** does not reference our own
 *     `VegaAM.exe`.
 *   - No user data, no installed application and no uninstall entry is ever
 *     touched.
 */

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, unlinkSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export const VEGAAM_AUMID = 'app.vegaam.desktop';

/** Registry root that holds the per-user AppUserModelId registrations. */
export const AUMID_KEY_ROOT = 'HKCU\\Software\\Classes\\AppUserModelId';

/** Shortcut file extension used by the Windows shell. */
const LNK_EXTENSION = '.lnk';

/** A shortcut that references one of these is an Electron development artifact. */
const ELECTRON_TARGET_MARKERS = ['electron.exe'];

/** A shortcut that references our own executable is legitimate and never removed. */
const OWN_TARGET_MARKERS = ['vegaam.exe'];

export interface IconIdentityRepair {
  /** The AppUserModelId Windows is asked to use for this application. */
  aumid: string;
  /** The `IconUri` currently registered for the AUMID. */
  iconUri: string | null;
  /** True when the AUMID registry entry exists. */
  aumidRegistered: boolean;
  /** True when this run changed the registry entry. */
  aumidRepaired: boolean;
  /** Shortcut files that were removed because they squatted the AUMID. */
  removedSquatters: string[];
  /** True when the Windows shell icon cache was refreshed. */
  shellNotified: boolean;
  /** Human readable failures; the repair never throws. */
  errors: string[];
}

/**
 * Decode a buffer as UTF-16LE at both byte alignments.
 *
 * Shell link files store their strings without a fixed alignment, so a search
 * has to look at both an even and an odd starting offset.
 */
function utf16Views(buffer: Buffer): string[] {
  const views: string[] = [];
  for (const offset of [0, 1]) {
    if (buffer.length - offset < 2) break;
    views.push(buffer.subarray(offset).toString('utf16le').toLowerCase());
  }
  return views;
}

/** True when the buffer contains the given text encoded as UTF-16LE. */
export function containsUtf16Le(buffer: Buffer, needle: string): boolean {
  const target = needle.toLowerCase();
  return utf16Views(buffer).some((view) => view.includes(target));
}

/**
 * Decide whether a shell link squats the VegaAM AppUserModelId.
 *
 * A squatter advertises `app.vegaam.desktop` (so the shell groups and icons
 * our running process through it) while pointing at an Electron binary that
 * carries the stock nucleus icon.
 */
export function isAumidSquatter(
  buffer: Buffer,
  aumid: string = VEGAAM_AUMID,
  options: { electronMarkers?: string[]; ownMarkers?: string[] } = {},
): boolean {
  const electronMarkers = options.electronMarkers ?? ELECTRON_TARGET_MARKERS;
  const ownMarkers = options.ownMarkers ?? OWN_TARGET_MARKERS;

  if (!containsUtf16Le(buffer, aumid)) return false;

  const views = utf16Views(buffer);
  const referencesElectron = electronMarkers.some((marker) =>
    views.some((view) => view.includes(marker.toLowerCase())),
  );
  if (!referencesElectron) return false;

  const referencesOwnExe = ownMarkers.some((marker) =>
    views.some((view) => view.includes(marker.toLowerCase())),
  );
  return !referencesOwnExe;
}

/**
 * Folders that may contain shortcuts claiming the VegaAM identity.
 */
export function getShortcutSearchDirs(env: NodeJS.ProcessEnv = process.env): string[] {
  const appData = env.APPDATA || join(homedir(), 'AppData', 'Roaming');
  const userProfile = env.USERPROFILE || homedir();
  const publicProfile = env.PUBLIC || join(homedir(), '..', 'Public');

  return [
    join(appData, 'Microsoft', 'Windows', 'Start Menu', 'Programs'),
    join(userProfile, 'Desktop'),
    join(publicProfile, 'Desktop'),
  ];
}

/**
 * Find every shell link that squats the given AppUserModelId.
 */
export function findAumidSquatters(
  dirs: string[],
  aumid: string = VEGAAM_AUMID,
): string[] {
  const found: string[] = [];
  for (const dir of dirs) {
    let entries: string[];
    try {
      if (!existsSync(dir)) continue;
      entries = readdirSync(dir);
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.toLowerCase().endsWith(LNK_EXTENSION)) continue;
      const file = join(dir, entry);
      try {
        if (!existsSync(file)) continue;
        const buffer = readFileSync(file);
        if (isAumidSquatter(buffer, aumid)) found.push(file);
      } catch {
        /* an unreadable shortcut is simply not a candidate */
      }
    }
  }
  return found;
}

/**
 * Remove every shell link that squats the given AppUserModelId.
 */
export function removeAumidSquatters(
  dirs: string[],
  aumid: string = VEGAAM_AUMID,
): { removed: string[]; errors: string[] } {
  const removed: string[] = [];
  const errors: string[] = [];
  for (const file of findAumidSquatters(dirs, aumid)) {
    try {
      unlinkSync(file);
      removed.push(file);
    } catch (error) {
      errors.push(
        `Could not remove ${file}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  return { removed, errors };
}

/**
 * Read the `IconUri` currently registered for an AppUserModelId.
 */
export function readRegisteredIconUri(aumid: string = VEGAAM_AUMID): string | null {
  if (process.platform !== 'win32') return null;
  try {
    const out = execFileSync(
      'reg.exe',
      ['query', `${AUMID_KEY_ROOT}\\${aumid}`, '/v', 'IconUri'],
      { encoding: 'utf8', timeout: 5000, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] },
    );
    const match = /IconUri\s+REG_(?:SZ|EXPAND_SZ)\s+(.+)/i.exec(out);
    const value = match?.[1];
    return value ? value.trim() : null;
  } catch {
    return null;
  }
}

/**
 * Register (or correct) the AppUserModelId entry for this application.
 *
 * The values match the ones written by `build/installer.nsh` so that the
 * runtime repair and the installer produce the same identity.
 */
export function registerAumid(
  iconUri: string,
  aumid: string = VEGAAM_AUMID,
): { ok: boolean; changed: boolean; iconUri: string | null; errors: string[] } {
  const errors: string[] = [];
  if (process.platform !== 'win32') {
    return { ok: true, changed: false, iconUri: null, errors };
  }

  const key = `${AUMID_KEY_ROOT}\\${aumid}`;
  const current = readRegisteredIconUri(aumid);
  if (current && current.toLowerCase() === iconUri.toLowerCase()) {
    return { ok: true, changed: false, iconUri: current, errors };
  }

  const writes: Array<[string, string]> = [
    ['DisplayName', 'VegaAM'],
    ['IconUri', iconUri],
    ['IconBackgroundColor', 'FF090D1A'],
  ];

  let changed = false;
  for (const [name, value] of writes) {
    try {
      execFileSync(
        'reg.exe',
        ['add', key, '/v', name, '/t', 'REG_SZ', '/d', value, '/f'],
        { encoding: 'utf8', timeout: 5000, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] },
      );
      changed = true;
    } catch (error) {
      errors.push(
        `Could not write ${name}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  return { ok: errors.length === 0, changed, iconUri: readRegisteredIconUri(aumid), errors };
}

/**
 * Notify the Windows shell that icon associations changed (`ie4uinit.exe -show`).
 */
export function refreshWindowsIconCache(): boolean {
  if (process.platform !== 'win32') return false;
  try {
    const child = execFileSync('ie4uinit.exe', ['-show'], {
      encoding: 'utf8',
      timeout: 5000,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    void child;
    return true;
  } catch {
    return false;
  }
}

/**
 * Repair the Windows icon identity of VegaAM.
 *
 * Safe to call on every start: it only removes shortcuts that squat our own
 * AppUserModelId and only writes our own registry entry.
 */
export function repairWindowsIconIdentity(
  options: {
    iconUri?: string;
    aumid?: string;
    dirs?: string[];
    env?: NodeJS.ProcessEnv;
  } = {},
): IconIdentityRepair {
  const aumid = options.aumid ?? VEGAAM_AUMID;
  const dirs = options.dirs ?? getShortcutSearchDirs(options.env ?? process.env);
  const errors: string[] = [];

  const { removed, errors: removeErrors } = removeAumidSquatters(dirs, aumid);
  errors.push(...removeErrors);

  let iconUri: string | null = null;
  let aumidRepaired = false;
  if (options.iconUri) {
    const registration = registerAumid(options.iconUri, aumid);
    iconUri = registration.iconUri;
    aumidRepaired = registration.changed;
    errors.push(...registration.errors);
  } else {
    iconUri = readRegisteredIconUri(aumid);
  }

  const shellNotified = removed.length > 0 ? refreshWindowsIconCache() : false;

  return {
    aumid,
    iconUri,
    aumidRegistered: iconUri !== null,
    aumidRepaired,
    removedSquatters: removed,
    shellNotified,
    errors,
  };
}
