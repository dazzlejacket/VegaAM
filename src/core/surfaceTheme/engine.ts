/**
 * SiriusXM surface theme CSS generator.
 *
 * Maps the 1,288 static `--color-*` tokens of the SiriusXM v7.x dark UI toolkit
 * to a semantic dark palette and adds targeted overrides for controls that the
 * upstream player colours white by default (play button, footer progress bar).
 *
 * Invariants:
 *   - Pure function: never reads the DOM or executes JavaScript.
 *   - `official` returns an empty string (no CSS injected).
 *   - Every generated declaration ends with `!important`.
 *   - Output is capped at 256 KB (`MAX_SURFACE_CSS_BYTES`).
 */

import {
  contrastOf,
  contrastRatio,
  parseColour,
  readableForeground,
  readableVariant,
  relativeLuminance,
  toHex,
  type Rgb,
} from './contrast';
import { getSurfaceTheme, normalizeSurfaceThemeId } from './palettes';
import { SOURCE_VALUE_MAP, SXM_TOKENS } from './tokens';
import type {
  SurfacePalette,
  SurfacePaletteRole,
  SurfaceThemeDefinition,
  SurfaceThemeId,
} from './types';
import { isValidHexAccent } from './validate';

export const MAX_SURFACE_CSS_BYTES = 256 * 1024;
export const TARGETED_OVERRIDE_COUNT = 45;

/**
 * Palette roles that can be painted as *text* by the upstream player.
 *
 * SiriusXM renders a number of its secondary-text tokens translucently
 * (`rgba(128, 153, 168, 0.8)` and friends). A role colour that passes WCAG AA
 * at full opacity can still fail once it is composited over the page
 * background, which is exactly how the first light themes made 12px
 * secondary text unreadable. These roles are therefore corrected per token,
 * using that token's own alpha, so the *composited* result is readable.
 */
const TEXT_BEARING_ROLES: ReadonlySet<SurfacePaletteRole> = new Set<SurfacePaletteRole>([
  'text',
  'muted',
  'accentSoft',
  'accent2',
  'warning',
  'danger',
  'danger2',
]);

export interface GenerateSurfaceCssOptions {
  accent?: string | null;
}

function hexToRgb(hex: string): [number, number, number] {
  const parsed = parseColour(hex);
  return parsed ?? [255, 255, 255];
}

function rgba(hex: string, alpha: string | number): string {
  const [r, g, b] = hexToRgb(hex);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

interface RoleTarget {
  role: SurfacePaletteRole;
  colour: string;
}

function buildRoleMap(palette: SurfacePalette): Map<string, RoleTarget> {
  const map = new Map<string, RoleTarget>();
  for (const [sourceRgb, role] of SOURCE_VALUE_MAP) {
    map.set(sourceRgb, { role, colour: palette[role] });
  }
  return map;
}

/**
 * Composite `colour` over `bg` at `alpha` (sRGB, matching CSS compositing).
 */
function compositeOver(colour: Rgb, bg: Rgb, alpha: number): Rgb {
  return [
    colour[0] * alpha + bg[0] * (1 - alpha),
    colour[1] * alpha + bg[1] * (1 - alpha),
    colour[2] * alpha + bg[2] * (1 - alpha),
  ];
}

/**
 * Adjust a text-bearing role colour so that it still meets WCAG AA (4.5:1)
 * against every surface it could be painted on *after* being composited at
 * `alpha`.
 *
 * On light backgrounds the colour is darkened; on dark backgrounds it is
 * lightened. The hue is preserved by moving every channel by the same step.
 * Returns the original colour when it already passes everywhere.
 */
export function alphaSafeTextColour(
  colour: string,
  backgrounds: string | string[],
  alpha: number,
  required = 4.5,
): string {
  const base = parseColour(colour);
  const surfaces = (Array.isArray(backgrounds) ? backgrounds : [backgrounds])
    .map((value) => parseColour(value))
    .filter((value): value is Rgb => Boolean(value));
  if (!base || surfaces.length === 0 || alpha >= 1) return colour;

  const averageLuminance =
    surfaces.reduce((sum, surface) => sum + relativeLuminance(surface), 0) / surfaces.length;
  const backgroundIsLight = averageLuminance > 0.4;
  // One channel step at a time so the best achievable result is reached
  // exactly rather than overshot.
  const step = backgroundIsLight ? -1 : 1;
  let candidate = base;

  for (let index = 0; index <= 255; index += 1) {
    const passesEverywhere = surfaces.every((surface) => {
      const composited = compositeOver(candidate, surface, alpha);
      return contrastRatio(composited, surface) >= required;
    });
    if (passesEverywhere) {
      return toHex(candidate);
    }
    const next: Rgb = [
      Math.max(0, Math.min(255, candidate[0] + step)),
      Math.max(0, Math.min(255, candidate[1] + step)),
      Math.max(0, Math.min(255, candidate[2] + step)),
    ];
    if (next[0] === candidate[0] && next[1] === candidate[1] && next[2] === candidate[2]) {
      break;
    }
    candidate = next;
  }
  // The extreme is the best that can be done when the alpha makes the ratio
  // mathematically unreachable (e.g. 50% white text on a mid-dark surface).
  return toHex(candidate);
}

function nearestTargetHex(map: Map<string, RoleTarget>, r: number, g: number, b: number): RoleTarget {
  const exactKey = `${r},${g},${b}`;
  const exact = map.get(exactKey);
  if (exact) return exact;

  let best: RoleTarget | null = null;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (const [source, target] of map) {
    const parts = source.split(',');
    const sr = Number(parts[0]);
    const sg = Number(parts[1]);
    const sb = Number(parts[2]);
    const distance = (sr - r) ** 2 + (sg - g) ** 2 + (sb - b) ** 2;
    if (distance < bestDistance) {
      bestDistance = distance;
      best = target;
    }
  }
  return best ?? { role: 'text', colour: '#FFFFFF' };
}

function mapTokenValue(
  map: Map<string, RoleTarget>,
  value: string,
  surfaces: string[],
): string {
  if (value === 'transparent' || value === 'currentColor') return value;
  if (/^\d+(\.\d+)?%$/.test(value)) return value;
  return value.replace(
    /rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*(?:,\s*([\d.]+)\s*)?\)/g,
    (_match, r, g, b, alpha: string | undefined) => {
      const target = nearestTargetHex(map, Number(r), Number(g), Number(b));
      const resolvedAlpha = alpha === undefined ? 1 : Number(alpha);
      const colour =
        resolvedAlpha < 1 && TEXT_BEARING_ROLES.has(target.role)
          ? alphaSafeTextColour(target.colour, surfaces, resolvedAlpha)
          : target.colour;
      return rgba(colour, resolvedAlpha);
    },
  );
}

/**
 * Derive an effective palette with an optional user hex accent override.
 * Throws if `options.accent` is non-empty and not a valid `#rrggbb` string.
 */
export function resolveEffectivePalette(
  theme: SurfaceThemeDefinition,
  options: GenerateSurfaceCssOptions = {},
): SurfacePalette {
  const palette: SurfacePalette = { ...theme.palette };
  if (options.accent !== undefined && options.accent !== null && options.accent !== '') {
    if (!isValidHexAccent(options.accent)) {
      throw new Error(`Invalid custom accent hex colour: "${String(options.accent)}"`);
    }
    const normalized = options.accent.trim();
    const parsed = parseColour(normalized);
    const hexUpper = parsed ? toHex(parsed).toUpperCase() : normalized.toUpperCase();
    const soft =
      contrastOf(hexUpper, palette.bg) >= 4.5 ? hexUpper : readableVariant(hexUpper, palette.bg);
    const fg = readableForeground(hexUpper);
    const onThemeContrast =
      theme.mode === 'dark' && contrastOf(palette.crust, hexUpper) >= 4.5 ? palette.crust : fg;

    palette.accent = hexUpper;
    palette.accentHover = hexUpper;
    palette.accentSoft = soft.toUpperCase();
    palette.accentContrast = onThemeContrast;
  }
  return palette;
}

/**
 * Generate the reversible CSS stylesheet for a surface theme.
 * Returns `""` when the theme is `'official'`.
 */
export function generateSurfaceCss(
  themeOrId: SurfaceThemeDefinition | SurfaceThemeId,
  options: GenerateSurfaceCssOptions = {},
): string {
  const resolvedTheme: SurfaceThemeDefinition | null =
    typeof themeOrId === 'string'
      ? getSurfaceTheme(normalizeSurfaceThemeId(themeOrId))
      : themeOrId;

  if (!resolvedTheme) {
    if (options.accent !== undefined && options.accent !== null && options.accent !== '') {
      if (!isValidHexAccent(options.accent)) {
        throw new Error(`Invalid custom accent hex colour: "${String(options.accent)}"`);
      }
    }
    return '';
  }

  const palette = resolveEffectivePalette(resolvedTheme, options);
  const map = buildRoleMap(palette);
  const declarations: string[] = [];
  const isLight = resolvedTheme.mode === 'light';

  // The surfaces a label can be painted on. Text-bearing roles are corrected
  // against all of them so translucent secondary text stays readable wherever
  // the upstream player places it.
  const textSurfaces = isLight
    ? [palette.bg, palette.mantle, palette.surface]
    : [palette.bg, palette.crust, palette.surface, palette.surface2];

  for (const [token, value] of Object.entries(SXM_TOKENS)) {
    declarations.push(`  ${token}: ${mapTokenValue(map, value, textSurfaces)} !important;`);
  }

  const targeted: Record<string, string> = {
    '--color-button-play-surface': palette.accent,
    '--color-button-play-surface-hover': palette.accentHover,
    '--color-button-play-surface-pressed': palette.accentHover,
    '--color-button-play-surface-focused': palette.accentHover,
    '--color-button-play-contrast': palette.accentContrast,
    '--color-button-play-contrast-hover': palette.accentContrast,
    '--color-button-play-contrast-pressed': palette.accentContrast,
    '--color-button-play-contrast-focused': palette.accentContrast,
    '--color-overlay-button-play-surface': palette.accent,
    '--color-overlay-button-play-contrast': palette.accentContrast,
    '--color-overlay-progress-bar-surface': palette.accent,
    '--color-overlay-progress-bar-surface-subtle': rgba(palette.accent, isLight ? 0.24 : 0.2),
    '--color-overlay-progress-bar-contrast': palette.accentContrast,
    '--color-surface-accent': palette.accent,
    '--color-contrast-accent': palette.accentSoft,
    '--color-border-accent': palette.accent,
    '--color-focus-ring-outer': palette.accent,
    '--color-selection-control-surface-selected': palette.accent,
    '--color-selection-control-border-selected': palette.accent,
    '--color-button-brand-primary-contrast': palette.accentContrast,
    '--color-button-brand-primary-contrast-hover': palette.accentContrast,
    '--color-button-brand-primary-contrast-pressed': palette.accentContrast,
    '--color-button-brand-primary-contrast-focused': palette.accentContrast,
    '--color-button-branded-contrast': palette.accentContrast,
    '--color-button-branded-contrast-hover': palette.accentContrast,
    '--color-button-branded-contrast-pressed': palette.accentContrast,
    '--color-button-branded-contrast-focused': palette.accentContrast,
    '--color-button-selectable-brand-contrast-selected': palette.accentContrast,
    '--color-button-selectable-brand-contrast-selected-hover': palette.accentContrast,
    '--color-button-selectable-brand-contrast-selected-pressed': palette.accentContrast,
    '--color-button-selectable-brand-contrast-selected-focused': palette.accentContrast,
    '--color-selection-control-contrast-selected': palette.accentContrast,
    '--color-selection-control-contrast-selected-hover': palette.accentContrast,
    '--color-selection-control-contrast-selected-pressed': palette.accentContrast,
    '--color-selection-control-contrast-selected-focused': palette.accentContrast,
    '--color-message-brand-contrast': palette.accentContrast,
    '--color-overlay-button-brand-primary-contrast': palette.accentContrast,
    '--color-overlay-button-branded-contrast': palette.accentContrast,
    '--color-navigation-bar-surface': rgba(palette.mantle, isLight ? 0.92 : 0.78),
    '--color-media-controls-surface': palette.mantle,
    '--color-card-default-surface': palette.surface,
    '--color-card-default-surface-hover': palette.surface2,
    '--color-input-default-surface': palette.surface,
    '--color-border-subtle': rgba(palette.text, isLight ? 0.14 : 0.1),
    '--color-border': rgba(palette.text, isLight ? 0.24 : 0.2),
  };

  for (const [token, value] of Object.entries(targeted)) {
    declarations.push(`  ${token}: ${value} !important;`);
  }

  const css = [
    `/* VegaAM surface theme (${resolvedTheme.id} / ${resolvedTheme.mode}): unofficial, reversible, CSS-only. */`,
    ':root, [data-uitk-theme] {',
    ...declarations,
    `  color-scheme: ${resolvedTheme.mode} !important;`,
    '}',
    `body { background-color: ${palette.bg} !important; color: ${palette.text} !important; }`,
    '',
  ].join('\n');

  const byteLength = Buffer.byteLength(css, 'utf8');
  if (byteLength > MAX_SURFACE_CSS_BYTES) {
    throw new Error(`Generated surface CSS exceeds 256 KB cap (${byteLength} bytes).`);
  }

  return css;
}
