/**
 * Pure Windows path helpers for the legacy SiriusXM Desktop installation and
 * the obsolete shortcuts that used to advertise the VegaAM identity.
 *
 * The module deliberately has no Electron dependency so the behaviour can be
 * asserted in tests without a running Electron process.
 */

import { homedir } from 'node:os';
import { join } from 'node:path';

export interface LegacyPaths {
  installDir: string;
  exePath: string;
  uninstallerPath: string;
  startMenuShortcut: string;
  desktopShortcut: string;
  electronDevShortcut: string;
}

/**
 * Resolve the legacy install paths and the shortcut locations of the current
 * user.
 */
export function getWindowsLegacyPaths(env: NodeJS.ProcessEnv = process.env): LegacyPaths {
  const localAppData = env.LOCALAPPDATA || join(homedir(), 'AppData', 'Local');
  const appData = env.APPDATA || join(homedir(), 'AppData', 'Roaming');
  const userProfile = env.USERPROFILE || homedir();

  const installDir = join(localAppData, 'Programs', 'SiriusXM Desktop');
  return {
    installDir,
    exePath: join(installDir, 'SiriusXM Desktop.exe'),
    uninstallerPath: join(installDir, 'Uninstall SiriusXM Desktop.exe'),
    startMenuShortcut: join(
      appData,
      'Microsoft',
      'Windows',
      'Start Menu',
      'Programs',
      'SiriusXM Desktop.lnk',
    ),
    desktopShortcut: join(userProfile, 'Desktop', 'SiriusXM Desktop.lnk'),
    electronDevShortcut: join(
      appData,
      'Microsoft',
      'Windows',
      'Start Menu',
      'Programs',
      'Electron.lnk',
    ),
  };
}

/**
 * The shortcut files that the cleanup routine is allowed to delete.
 *
 * Kept as a pure function so the behaviour can be asserted in tests without
 * touching the real file system.
 */
export function getShortcutCleanupTargets(paths: LegacyPaths): string[] {
  return [paths.startMenuShortcut, paths.desktopShortcut, paths.electronDevShortcut];
}
