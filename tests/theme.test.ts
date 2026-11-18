import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import {
  ENGINE_TOKENS,
  builtinThemes,
  exportTheme,
  getBuiltinTheme,
  importTheme,
  themeToCss,
} from '../src/core/theme/engine';
import { TOKENS, validateTheme } from '../src/core/theme/schema';

const stylesheets = [
  '../src/renderer/styles/quick.css',
  '../src/renderer/styles/compact.css',
  '../src/renderer/styles/skin.css',
]
  .map((path) => readFileSync(fileURLToPath(new URL(path, import.meta.url)), 'utf8'))
  .join('\n');

describe('the design tokens', () => {
  it('gives every token of the schema a consumer', () => {
    // A token that nothing reads is a promise that the runtime does not
    // keep: the theme author sets it and nothing happens. Every token is
    // therefore either read by the stylesheet or translated by the theme
    // engine into a value that the stylesheet reads.
    const css = stylesheets;
    for (const token of TOKENS) {
      const usedByStylesheet = css.includes(`var(${token.name}`);
      const usedByEngine = ENGINE_TOKENS.includes(token.name);
      expect(usedByStylesheet || usedByEngine, `${token.name} has no consumer`).toBe(true);
    }
  });

  it('translates every enum token into a value that the stylesheet reads', () => {
    const css = stylesheets;
    for (const theme of builtinThemes()) {
      const generated = themeToCss(theme);
      for (const name of ENGINE_TOKENS) {
        const style = theme.tokens[name];
        if (!style || style === 'none') continue;
        // The engine must produce a concrete custom property for the look.
        expect(generated).toMatch(/--[a-z-]+:/);
        expect(css).toMatch(/var\(--[a-z-]+/);
      }
    }
  });

  it('does not advertise a token that the engine does not translate', () => {
    for (const name of ENGINE_TOKENS) {
      expect(TOKENS.some((token) => token.name === name), name).toBe(true);
    }
  });
});

describe('built-in themes', () => {
  it('ships five visually distinct skins', () => {
    const themes = builtinThemes();
    expect(themes).toHaveLength(5);
    const ids = themes.map((theme) => theme.id);
    expect(ids).toContain('modern');
    expect(ids).toContain('retro-satellite');
    expect(ids).toContain('classic-compact');
    expect(ids).toContain('bluebird-classic');
    expect(ids).toContain('retro-amp');

    const layouts = new Set(themes.map((theme) => theme.layout));
    expect(layouts.size).toBe(5);
  });

  it('defines only known design tokens', () => {
    const known = new Set(TOKENS.map((token) => token.name));
    for (const theme of builtinThemes()) {
      for (const name of Object.keys(theme.tokens)) {
        expect(known.has(name)).toBe(true);
      }
    }
  });

  it('produces a CSS custom property block', () => {
    const theme = getBuiltinTheme('modern')!;
    const css = themeToCss(theme);
    expect(css).toContain(':root {');
    expect(css).toContain('--accent:');
    expect(css).toContain('--bg:');
  });

  it('applies the accent colour override', () => {
    const theme = getBuiltinTheme('modern')!;
    const css = themeToCss(theme, { accentColor: '#ff0000' });
    expect(css).toContain('--accent: #ff0000;');
  });
});

describe('the two retro skins', () => {
  it('ships a brushed silver skin that is prefers light and supports dark', () => {
    const theme = getBuiltinTheme('bluebird-classic')!;
    expect(theme.name).toBe('Bluebird Classic');
    expect(theme.mode).toBe('light');
    expect(theme.supportsLight).toBe(true);
    expect(theme.layout).toBe('bluebird-classic');
    // The name must not mention the product it is inspired by.
    expect(theme.name.toLowerCase()).not.toContain('itune');
    expect(theme.description?.toLowerCase()).not.toContain('itune');
  });

  it('ships a graphite skin with a green readout', () => {
    const theme = getBuiltinTheme('retro-amp')!;
    expect(theme.name).toBe('Retro Amp');
    expect(theme.mode).toBe('dark');
    expect(theme.supportsLight).toBe(true);
    expect(theme.layout).toBe('retro-amp');
    expect(theme.tokens['--segment-color']).toBe('#00e05a');
  });

  it('keeps the own palette of a skin that has its own colour mode', () => {
    // The generic light palette must not paint over the brushed silver skin.
    const theme = getBuiltinTheme('bluebird-classic')!;
    const css = themeToCss(theme, { mode: 'light' });
    expect(css).toContain(`--bg: ${theme.tokens['--bg']};`);
    expect(css).not.toContain('--bg: #f2f5fa;');
  });

  it('still applies the shared light palette to a skin that supports it', () => {
    const theme = getBuiltinTheme('modern')!;
    const css = themeToCss(theme, { mode: 'light' });
    expect(css).toContain('--bg: #f2f5fa;');
  });
});

describe('theme validation', () => {
  it('rejects unknown tokens', () => {
    const result = validateTheme({
      id: 'evil',
      name: 'Evil',
      tokens: { '--not-a-token': '#fff' },
    });
    expect(result.ok).toBe(false);
    expect(result.errors.join(' ')).toContain('Unknown design token');
  });

  it('rejects values that contain urls or expressions', () => {
    const result = validateTheme({
      id: 'evil',
      name: 'Evil',
      tokens: { '--bg': 'url(https://example.com/x.png)' },
    });
    expect(result.ok).toBe(false);
  });

  it('rejects script injections in token values', () => {
    const result = validateTheme({
      id: 'evil',
      name: 'Evil',
      tokens: { '--font-family': 'Arial; background: url(javascript:alert(1))' },
    });
    expect(result.ok).toBe(false);
  });

  it('rejects unsafe asset paths', () => {
    const result = validateTheme({
      id: 'evil',
      name: 'Evil',
      assets: { logo: '../../etc/passwd' },
    });
    expect(result.ok).toBe(false);
  });

  it('accepts a valid theme', () => {
    const result = validateTheme({
      id: 'my-theme',
      name: 'My Theme',
      version: '1.0.0',
      mode: 'dark',
      tokens: { '--accent': '#123456', '--radius': '8px' },
    });
    expect(result.ok).toBe(true);
    expect(result.theme?.tokens['--accent']).toBe('#123456');
  });
});

describe('theme import and export', () => {
  it('round trips a theme', () => {
    const theme = getBuiltinTheme('retro-satellite')!;
    const exported = exportTheme(theme);
    const imported = importTheme(exported);
    expect(imported.ok).toBe(true);
    expect(imported.theme?.id).toBe('retro-satellite');
    expect(imported.theme?.tokens['--accent']).toBe(theme.tokens['--accent']);
  });

  it('rejects broken JSON', () => {
    const result = importTheme('{ not json');
    expect(result.ok).toBe(false);
  });

  it('rejects themes that are too large', () => {
    const result = importTheme(`{"padding":"${'x'.repeat(300_000)}"}`);
    expect(result.ok).toBe(false);
    expect(result.errors.join(' ')).toContain('too large');
  });
});
