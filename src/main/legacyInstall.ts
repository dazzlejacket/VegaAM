/**
 * Legacy SiriusXM Desktop 0.1.0 detection, safe shortcut cleanup, and
 * Windows icon-identity diagnostics for VegaAM.
 *
 * Safety invariants:
 *   - NEVER deletes or modifies `%APPDATA%\SiriusXM Desktop` (which holds the persistent login partition).
 *   - NEVER silently uninstalls `SiriusXM Desktop 0.1.0` or deletes unrelated applications.
 *   - Only removes obsolete `SiriusXM Desktop.lnk` and development `Electron.lnk`
 *     shortcuts when explicitly requested by the user or installer.
 */

import { spawn } from 'node:child_process';
import { existsSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';

import { nativeImage, shell } from 'electron';

import type { IconIdentityDiagnostics } from '../shared/types';

import {
  VEGAAM_AUMID,
  findAumidSquatters,
  getShortcutSearchDirs,
  readRegisteredIconUri,
  refreshWindowsIconCache,
  removeAumidSquatters,
} from './iconIdentity';
import {
  getShortcutCleanupTargets,
  getWindowsLegacyPaths,
  type LegacyPaths,
} from './windowsShortcuts';

export { VEGAAM_AUMID, refreshWindowsIconCache, getShortcutCleanupTargets, getWindowsLegacyPaths };
export type { LegacyPaths };

/**
 * Inspect the current VegaAM icon identity and check whether legacy
 * `SiriusXM Desktop 0.1.0` installations or shortcuts exist on disk.
 */
export function inspectIconIdentity(iconDir: string): IconIdentityDiagnostics {
  const iconPath = join(iconDir, 'icon-256.png');
  let iconSize = 'missing';
  try {
    if (existsSync(iconPath)) {
      const img = nativeImage.createFromPath(iconPath);
      if (!img.isEmpty()) {
        const sz = img.getSize();
        iconSize = `${sz.width}×${sz.height}`;
      }
    }
  } catch {
    iconSize = '256×256';
  }

  if (process.platform !== 'win32') {
    return {
      exePath: process.execPath,
      aumid: VEGAAM_AUMID,
      iconPath,
      iconSize,
      legacyInstallFound: false,
      legacyInstallDir: null,
      legacyUninstallerPath: null,
      legacyStartMenuShortcutFound: false,
      legacyDesktopShortcutFound: false,
      electronDevShortcutFound: false,
      aumidIconUri: null,
      aumidRegistered: false,
      identitySquatters: [],
    };
  }

  const paths = getWindowsLegacyPaths();
  const legacyExeExists = existsSync(paths.exePath);
  const legacyUninstallExists = existsSync(paths.uninstallerPath);
  const legacyInstallFound = legacyExeExists || legacyUninstallExists;
  const aumidIconUri = readRegisteredIconUri(VEGAAM_AUMID);

  return {
    exePath: process.execPath,
    aumid: VEGAAM_AUMID,
    iconPath,
    iconSize,
    legacyInstallFound,
    legacyInstallDir: legacyInstallFound ? paths.installDir : null,
    legacyUninstallerPath: legacyUninstallExists ? paths.uninstallerPath : null,
    legacyStartMenuShortcutFound: existsSync(paths.startMenuShortcut),
    legacyDesktopShortcutFound: existsSync(paths.desktopShortcut),
    electronDevShortcutFound: existsSync(paths.electronDevShortcut),
    aumidIconUri,
    aumidRegistered: aumidIconUri !== null,
    identitySquatters: findAumidSquatters(getShortcutSearchDirs()),
  };
}

/**
 * Safely remove obsolete shortcuts from the current user's Start Menu and
 * Desktop without touching user data or any installed binaries.
 *
 * Removed shortcuts:
 *   - `SiriusXM Desktop.lnk` (legacy 0.1.0 install, old ring icon),
 *   - `Electron.lnk` (development leftover that advertises the VegaAM
 *     AppUserModelId while pointing at `node_modules\electron\dist\electron.exe`
 *     - the reason Windows drew the stock nucleus in the taskbar),
 *   - any further shortcut that squats the VegaAM AppUserModelId.
 */
export function cleanupLegacyShortcuts(env: NodeJS.ProcessEnv = process.env): {
  ok: boolean;
  removed: string[];
  errors: string[];
} {
  if (process.platform !== 'win32') {
    return { ok: true, removed: [], errors: [] };
  }
  const paths = getWindowsLegacyPaths(env);
  const removed: string[] = [];
  const errors: string[] = [];

  for (const target of getShortcutCleanupTargets(paths)) {
    if (!existsSync(target)) continue;
    try {
      unlinkSync(target);
      removed.push(target);
    } catch (error) {
      errors.push(
        `Could not remove ${target}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  // Any remaining shortcut that squats the VegaAM identity is removed as well.
  const squatters = removeAumidSquatters(getShortcutSearchDirs(env), VEGAAM_AUMID);
  removed.push(...squatters.removed);
  errors.push(...squatters.errors);

  refreshWindowsIconCache();
  return {
    ok: errors.length === 0,
    removed,
    errors,
  };
}

/**
 * Open the legacy `SiriusXM Desktop` installation folder in Explorer so the user can inspect it.
 */
export async function openLegacyInstallFolder(): Promise<boolean> {
  if (process.platform !== 'win32') return false;
  const paths = getWindowsLegacyPaths();
  if (!existsSync(paths.installDir)) return false;
  const err = await shell.openPath(paths.installDir);
  return err === '';
}

/**
 * Launch the interactive uninstaller for `SiriusXM Desktop 0.1.0` (never silent).
 */
export function launchLegacyUninstallerInteractive(): boolean {
  if (process.platform !== 'win32') return false;
  const paths = getWindowsLegacyPaths();
  if (!existsSync(paths.uninstallerPath)) return false;
  try {
    const child = spawn(paths.uninstallerPath, ['/currentuser'], {
      detached: true,
      stdio: 'ignore',
    });
    child.unref();
    return true;
  } catch {
    return false;
  }
}
