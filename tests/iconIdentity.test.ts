import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  VEGAAM_AUMID,
  containsUtf16Le,
  findAumidSquatters,
  getShortcutSearchDirs,
  isAumidSquatter,
  removeAumidSquatters,
} from '../src/main/iconIdentity';
import { getShortcutCleanupTargets, getWindowsLegacyPaths } from '../src/main/windowsShortcuts';

const tempDirs: string[] = [];

function makeTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'vegaam-icon-'));
  tempDirs.push(dir);
  return dir;
}

/**
 * Build a byte buffer that mimics a Windows shell link: the strings are stored
 * as UTF-16LE and may start on an odd byte offset.
 */
function fakeShellLink(strings: string[], oddOffset = false): Buffer {
  const parts: Buffer[] = [];
  for (const value of strings) parts.push(Buffer.from(value, 'utf16le'));
  let buffer = Buffer.concat(parts);
  if (oddOffset) {
    const shifted = Buffer.alloc(buffer.length + 1);
    buffer.copy(shifted, 1);
    buffer = shifted;
  }
  return buffer;
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

describe('VegaAM 3.2.2 Windows icon identity', () => {
  it('detects a shortcut that squats the VegaAM AUMID with an Electron binary', () => {
    const squatter = fakeShellLink([
      'C:\\repo\\node_modules\\electron\\dist\\electron.exe',
      VEGAAM_AUMID,
    ]);
    expect(isAumidSquatter(squatter)).toBe(true);
  });

  it('detects the squatter even when the strings are stored on an odd offset', () => {
    const squatter = fakeShellLink(
      ['C:\\repo\\node_modules\\electron\\dist\\electron.exe', VEGAAM_AUMID],
      true,
    );
    expect(isAumidSquatter(squatter)).toBe(true);
  });

  it('is case insensitive about the AUMID and the target binary', () => {
    const squatter = fakeShellLink([
      'C:\\REPO\\Node_Modules\\Electron\\Dist\\ELECTRON.EXE',
      VEGAAM_AUMID.toUpperCase(),
    ]);
    expect(isAumidSquatter(squatter)).toBe(true);
  });

  it('keeps a legitimate VegaAM shortcut', () => {
    const legit = fakeShellLink([
      'C:\\Users\\example\\AppData\\Local\\Programs\\VegaAM\\VegaAM.exe',
      VEGAAM_AUMID,
    ]);
    expect(isAumidSquatter(legit)).toBe(false);
  });

  it('ignores Electron shortcuts that do not advertise the VegaAM AUMID', () => {
    const other = fakeShellLink(['C:\\repo\\node_modules\\electron\\dist\\electron.exe']);
    expect(isAumidSquatter(other)).toBe(false);
  });

  it('ignores empty and unrelated buffers', () => {
    expect(isAumidSquatter(Buffer.alloc(0))).toBe(false);
    expect(isAumidSquatter(Buffer.from('plain text', 'utf8'))).toBe(false);
  });

  it('finds UTF-16LE text at any alignment', () => {
    expect(containsUtf16Le(fakeShellLink(['hello'], true), 'hello')).toBe(true);
    expect(containsUtf16Le(fakeShellLink(['hello']), 'hello')).toBe(true);
    expect(containsUtf16Le(fakeShellLink(['hello']), 'nope')).toBe(false);
  });

  it('removes a squatting shortcut but keeps a legitimate one on disk', () => {
    const dir = makeTempDir();
    const squatter = join(dir, 'Electron.lnk');
    const legit = join(dir, 'VegaAM.lnk');
    writeFileSync(
      squatter,
      fakeShellLink(['C:\\repo\\node_modules\\electron\\dist\\electron.exe', VEGAAM_AUMID]),
    );
    writeFileSync(
      legit,
      fakeShellLink(['C:\\Users\\example\\AppData\\Local\\Programs\\VegaAM\\VegaAM.exe', VEGAAM_AUMID]),
    );

    expect(findAumidSquatters([dir])).toEqual([squatter]);

    const result = removeAumidSquatters([dir]);
    expect(result.errors).toEqual([]);
    expect(result.removed).toEqual([squatter]);
    expect(readFileSync(legit).length).toBeGreaterThan(0);
  });

  it('searches the Start Menu Programs folder and the Desktop for shortcuts', () => {
    const dirs = getShortcutSearchDirs({
      APPDATA: 'C:\\Users\\example\\AppData\\Roaming',
      USERPROFILE: 'C:\\Users\\example',
      PUBLIC: 'C:\\Users\\Public',
    });
    expect(dirs).toContain(
      join('C:\\Users\\example\\AppData\\Roaming', 'Microsoft', 'Windows', 'Start Menu', 'Programs'),
    );
    expect(dirs).toContain(join('C:\\Users\\example', 'Desktop'));
  });

  it('includes the development Electron shortcut in the cleanup targets', () => {
    const paths = getWindowsLegacyPaths({
      LOCALAPPDATA: 'C:\\Users\\example\\AppData\\Local',
      APPDATA: 'C:\\Users\\example\\AppData\\Roaming',
      USERPROFILE: 'C:\\Users\\example',
    });
    const targets = getShortcutCleanupTargets(paths);
    expect(targets).toContain(paths.startMenuShortcut);
    expect(targets).toContain(paths.desktopShortcut);
    expect(targets).toContain(paths.electronDevShortcut);
    expect(paths.electronDevShortcut.endsWith('Electron.lnk')).toBe(true);
  });
});
