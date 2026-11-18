/**
 * Thin wrapper around `src/core/theme/contrast.ts` for surface palettes.
 * Avoids duplicating colour-maths primitives across VegaAM.
 */

import {
  MINIMUM_CONTRAST,
  contrastOf,
  contrastRatio,
  parseColour,
  readableForeground,
  readableVariant,
  relativeLuminance,
  toHex,
  type Rgb,
} from '../theme/contrast';
import type { SurfacePalette } from './types';

export {
  MINIMUM_CONTRAST,
  contrastOf,
  contrastRatio,
  parseColour,
  readableForeground,
  readableVariant,
  relativeLuminance,
  toHex,
  type Rgb,
};

export interface PaletteContrastReport {
  textOnBg: number;
  mutedOnBg: number;
  accentContrastOnAccent: number;
  accentOnBg: number;
  dangerOnBg: number;
  passes: boolean;
}

/**
 * Evaluate WCAG contrast gates for a dark surface palette.
 */
export function evaluatePaletteContrast(palette: SurfacePalette): PaletteContrastReport {
  const textOnBg = contrastOf(palette.text, palette.bg);
  const mutedOnBg = contrastOf(palette.muted, palette.bg);
  const accentContrastOnAccent = contrastOf(palette.accentContrast, palette.accent);
  const accentOnBg = contrastOf(palette.accent, palette.bg);
  const dangerOnBg = contrastOf(palette.danger, palette.bg);

  const passes =
    textOnBg >= 4.5 &&
    mutedOnBg >= 4.5 &&
    accentContrastOnAccent >= 4.5 &&
    accentOnBg >= 3.0 &&
    dangerOnBg >= 3.0;

  return {
    textOnBg,
    mutedOnBg,
    accentContrastOnAccent,
    accentOnBg,
    dangerOnBg,
    passes,
  };
}
