import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const root = fileURLToPath(new URL('..', import.meta.url));
const srcDir = join(root, 'src');

function collectFiles(dir: string, predicate: (path: string) => boolean): string[] {
  const results: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const stat = statSync(full);
    if (stat.isDirectory()) {
      results.push(...collectFiles(full, predicate));
    } else if (predicate(full)) {
      results.push(full);
    }
  }
  return results;
}

function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');
}

/**
 * Read-only verification harnesses. These may script their OWN VegaAM-owned
 * surfaces (the in-window drawer) to measure UI state. They must never script
 * the official SiriusXM player page.
 */
const VERIFICATION_HARNESS_FILES = [
  'smoke.ts',
  'qa31.ts',
  'lastfmAcceptance.ts',
] as const;

describe('VegaAM 3.0 official-first static guardrails', () => {
  it('deletes the fake channel catalog and obsolete v2 custom shell files', () => {
    const obsoletePaths = [
      'src/core/channels/directory.ts',
      'src/shared/routes.ts',
      'src/main/playerHost.ts',
      'src/main/playerSnapshot.ts',
      'src/main/playerCommands.ts',
      'src/main/repairQa.ts',
      'src/preload/player.ts',
      'src/renderer/index.html',
      'src/renderer/app.ts',
      'src/renderer/styles/app.css',
      'src/renderer/mediaSession.ts',
      'src/renderer/mini.html',
      'src/renderer/mini.ts',
      'src/renderer/styles/mini.css',
    ];
    for (const rel of obsoletePaths) {
      expect(existsSync(join(root, rel)), `${rel} must not exist`).toBe(false);
    }
  });

  it('deletes the standalone Settings and Activity popup windows', () => {
    // VegaAM 3.2 keeps ALL normal navigation inside the single main window via
    // the integrated in-window studio drawer. The separate Settings and
    // Scrobble Monitor windows must never come back.
    const removedPopupPaths = [
      'src/main/settingsWindow.ts',
      'src/main/activityWindow.ts',
      'src/renderer/settings.html',
      'src/renderer/settings.ts',
      'src/renderer/activity.html',
      'src/renderer/activity.ts',
      'src/renderer/styles/settings.css',
      'src/renderer/styles/activity.css',
    ];
    for (const rel of removedPopupPaths) {
      expect(existsSync(join(root, rel)), `${rel} must not exist`).toBe(false);
    }

    // No source file may construct a Settings/Activity BrowserWindow.
    const tsFiles = collectFiles(srcDir, (p) => p.endsWith('.ts'));
    for (const file of tsFiles) {
      const code = stripComments(readFileSync(file, 'utf8'));
      expect(code, file).not.toContain('SettingsWindowController');
      expect(code, file).not.toContain('ActivityWindowController');
    }
  });

  it('contains no CHANNEL_DIRECTORY or WebContentsView code in src/', () => {
    const tsFiles = collectFiles(srcDir, (p) => p.endsWith('.ts'));
    for (const file of tsFiles) {
      const code = stripComments(readFileSync(file, 'utf8'));
      expect(code, file).not.toContain('CHANNEL_DIRECTORY');
      if (!file.endsWith('quickPanel.ts')) {
        expect(code, file).not.toContain('WebContentsView');
      }
      if (!file.endsWith('surfaceThemeService.ts') && !file.endsWith('officialPlayer.ts')) {
        expect(code, file).not.toContain('insertCSS(');
      }
      if (!VERIFICATION_HARNESS_FILES.some((harness) => file.endsWith(harness))) {
        expect(code, file).not.toContain('executeJavaScript(');
      }
    }
  });

  it('never executes JavaScript in product code — only in read-only verification harnesses', () => {
    // The official SiriusXM player page DOM must never be scripted. The only
    // `executeJavaScript(` call sites allowed anywhere in `src/` are the
    // read-only acceptance harnesses, and even those may only inspect
    // VegaAM-owned surfaces (never the official SiriusXM webContents).
    const tsFiles = collectFiles(srcDir, (p) => p.endsWith('.ts'));
    const productFiles = tsFiles.filter(
      (file) => !VERIFICATION_HARNESS_FILES.some((harness) => file.endsWith(harness)),
    );
    expect(productFiles.length).toBeGreaterThan(0);
    for (const file of productFiles) {
      const code = stripComments(readFileSync(file, 'utf8'));
      expect(code, `${file} must not script any webContents`).not.toContain('executeJavaScript(');
    }

    // In the harness, scripting must be limited to the VegaAM-owned drawer view.
    for (const harness of VERIFICATION_HARNESS_FILES) {
      const harnessCode = stripComments(readFileSync(join(srcDir, 'main', harness), 'utf8'));
      expect(harnessCode, harness).not.toContain('mainWin.webContents.executeJavaScript');
      expect(harnessCode, harness).not.toContain('officialPlayer.webContents.executeJavaScript');
      expect(harnessCode, harness).not.toContain('windows.main?.webContents.executeJavaScript');
    }
  });

  it('keeps src/preload/mediaBridge.ts strictly read-only and DOM-free', () => {
    const bridgeCode = stripComments(readFileSync(join(srcDir, 'preload', 'mediaBridge.ts'), 'utf8'));
    const forbiddenTokens = [
      'querySelector',
      'querySelectorAll',
      'getElementById',
      'getElementsBy',
      'MutationObserver',
      'insertCSS',
      '.click(',
      'dispatchEvent',
      'innerHTML',
      'textContent',
      'innerText',
      'contextBridge',
      'exposeInMainWorld',
    ];
    for (const token of forbiddenTokens) {
      expect(bridgeCode).not.toContain(token);
    }
  });

  it('creates no <audio> or <video> elements in VegaAM-owned secondary windows', () => {
    const htmlFiles = collectFiles(join(srcDir, 'renderer'), (p) => p.endsWith('.html'));
    expect(htmlFiles.length).toBeGreaterThanOrEqual(4);
    for (const file of htmlFiles) {
      const html = readFileSync(file, 'utf8');
      expect(html, file).not.toMatch(/<audio\b/i);
      expect(html, file).not.toMatch(/<video\b/i);
    }
  });
});
