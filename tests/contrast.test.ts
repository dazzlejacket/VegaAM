/**
 * The contrast of the text on its surfaces.
 *
 * The audit found several combinations of a text colour and a surface that
 * were hard to read. A theme is a skin that the user looks at for hours, so
 * every documented pair has to reach the contrast ratio of the WCAG AA for
 * normal text (4.5:1).
 *
 * The pairs are the ones the stylesheet really uses.
 */

import { describe, expect, it } from 'vitest';

import { builtinThemes, themeToCss } from '../src/core/theme/engine';
import type { ThemeDefinition } from '../src/core/theme/types';

/**
 * The combinations of a text colour and a surface that the shell uses.
 *
 * The pairs follow the stylesheet: the badge of a status sits on
 * `--surface-2`, the track title on `--bg`, the label of a primary button on
 * the accent.
 */
const TEXT_PAIRS: ReadonlyArray<readonly [string, string]> = [
  ['--text', '--bg'],
  ['--text', '--surface'],
  ['--text', '--bg-elevated'],
  ['--text', '--bg-sunken'],
  ['--text-muted', '--bg'],
  ['--text-muted', '--surface'],
  ['--text-muted', '--surface-2'],
  ['--text-muted', '--bg-elevated'],
  ['--text-muted', '--bg-sunken'],
  // The readable variant of the accent is what the shell uses as text.
  ['--accent-text', '--bg'],
  ['--accent-text', '--surface'],
  // The label on an accent surface.
  ['--accent-contrast', '--accent'],
  // The status badges.
  ['--success-text', '--surface-2'],
  ['--warning-text', '--surface-2'],
  ['--danger-text', '--surface-2'],
];

/**
 * The pairs that only carry a graphic.
 *
 * A coloured icon or a coloured border is not text. WCAG asks for 3:1 for
 * those, not for the 4.5:1 of a paragraph. The shell uses the readable
 * variant of the status colours for them, so they are measured here too.
 */
const ICON_PAIRS: ReadonlyArray<readonly [string, string]> = [
  ['--danger-text', '--surface'],
  ['--success-text', '--bg'],
  ['--warning-text', '--bg'],
];

/** The contrast ratio that is required for normal text. */
const MINIMUM = 4.5;

/** The contrast ratio that is required for a graphic. */
const MINIMUM_ICON = 3;

type Rgb = [number, number, number];

function toRgb(value: string): Rgb | undefined {
  const trimmed = value.trim();
  if (trimmed.startsWith('#')) {
    const hex = trimmed.slice(1);
    const full = hex.length === 3 ? hex.split('').map((c) => c + c).join('') : hex;
    if (full.length < 6) return undefined;
    return [0, 2, 4].map((i) => parseInt(full.slice(i, i + 2), 16)) as Rgb;
  }
  const match = trimmed.match(/rgba?\(([^)]+)\)/i);
  if (!match) return undefined;
  const parts = match[1]!.split(',').map((part) => parseFloat(part.trim()));
  if (parts.length < 3 || parts.some((part) => Number.isNaN(part))) return undefined;
  return [parts[0]!, parts[1]!, parts[2]!];
}

function luminance([r, g, b]: Rgb): number {
  const channel = (value: number): number => {
    const scaled = value / 255;
    return scaled <= 0.03928 ? scaled / 12.92 : Math.pow((scaled + 0.055) / 1.055, 2.4);
  };
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

/** The contrast ratio between two colours. */
export function contrastRatio(foreground: string, background: string): number {
  const a = toRgb(foreground);
  const b = toRgb(background);
  if (!a || !b) return Number.NaN;
  const first = luminance(a);
  const second = luminance(b);
  const lighter = Math.max(first, second);
  const darker = Math.min(first, second);
  return (lighter + 0.05) / (darker + 0.05);
}

/** The custom properties of a theme in a colour mode. */
function properties(theme: ThemeDefinition, mode: 'dark' | 'light'): Map<string, string> {
  const css = themeToCss(theme, { mode });
  const map = new Map<string, string>();
  for (const match of css.matchAll(/(--[a-z0-9-]+):\s*([^;]+);/g)) {
    map.set(match[1]!, match[2]!.trim());
  }
  return map;
}

describe('the contrast of the built-in skins', () => {
  const failures: string[] = [];

  for (const theme of builtinThemes()) {
    const modes: Array<'dark' | 'light'> = theme.supportsLight ? ['dark', 'light'] : [theme.mode];
    for (const mode of modes) {
      const tokens = properties(theme, mode);
      for (const [foreground, background] of TEXT_PAIRS) {
        const fg = tokens.get(foreground);
        const bg = tokens.get(background);
        if (!fg || !bg) continue;
        const ratio = contrastRatio(fg, bg);
        if (Number.isNaN(ratio)) continue;
        if (ratio < MINIMUM) {
          failures.push(
            `${theme.id}/${mode}: ${foreground} (${fg}) on ${background} (${bg}) is ${ratio.toFixed(2)}:1`,
          );
        }
      }
      for (const [foreground, background] of ICON_PAIRS) {
        const fg = tokens.get(foreground);
        const bg = tokens.get(background);
        if (!fg || !bg) continue;
        const ratio = contrastRatio(fg, bg);
        if (Number.isNaN(ratio)) continue;
        if (ratio < MINIMUM_ICON) {
          failures.push(
            `${theme.id}/${mode}: ${foreground} (${fg}) on ${background} (${bg}) is ${ratio.toFixed(2)}:1`,
          );
        }
      }
    }
  }

  it('reaches 4.5:1 for every text on a surface pair', () => {
    expect(failures, failures.join('\n')).toEqual([]);
  });

  it('measures every documented pair', () => {
    // The measurement must not silently skip a pair because of a parsing
    // mistake.
    for (const theme of builtinThemes()) {
      const tokens = properties(theme, theme.mode);
      for (const [foreground, background] of [...TEXT_PAIRS, ...ICON_PAIRS]) {
        expect(tokens.has(foreground), `${theme.id} is missing ${foreground}`).toBe(true);
        expect(tokens.has(background), `${theme.id} is missing ${background}`).toBe(true);
      }
    }
  });
});

describe('the contrast calculation', () => {
  it('knows the extremes', () => {
    expect(contrastRatio('#000000', '#ffffff')).toBeCloseTo(21, 1);
    expect(contrastRatio('#ffffff', '#ffffff')).toBeCloseTo(1, 5);
  });

  it('ignores the order of the colours', () => {
    expect(contrastRatio('#4c8dff', '#0b0d12')).toBeCloseTo(
      contrastRatio('#0b0d12', '#4c8dff'),
      5,
    );
  });
});
