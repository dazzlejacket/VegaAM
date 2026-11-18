/**
 * Theme engine.
 *
 * Built-in skins provide the layout, user themes may only override design
 * tokens. That keeps third party themes safe: they cannot execute code and
 * they cannot reference remote resources.
 */

import bluebirdClassic from './builtin/bluebird-classic.json';
import classicCompact from './builtin/classic-compact.json';
import modern from './builtin/modern.json';
import retroAmp from './builtin/retro-amp.json';
import retroSatellite from './builtin/retro-satellite.json';
import { TOKENS, validateTheme, type ValidationResult } from './schema';
import { readableForeground, readableVariant } from './contrast';
import type { ThemeDefinition, ThemeSummary } from './types';

const BUILTIN_SOURCES: unknown[] = [
  modern,
  retroSatellite,
  classicCompact,
  bluebirdClassic,
  retroAmp,
];

let builtinCache: ThemeDefinition[] | undefined;

/** All built-in themes. */
export function builtinThemes(): ThemeDefinition[] {
  if (!builtinCache) {
    builtinCache = BUILTIN_SOURCES.map((source) => {
      const result = validateTheme(source);
      if (!result.ok || !result.theme) {
        throw new Error(`Invalid built-in theme: ${result.errors.join(', ')}`);
      }
      return result.theme;
    });
  }
  return builtinCache;
}

/** Look up a built-in theme by id. */
export function getBuiltinTheme(id: string): ThemeDefinition | undefined {
  return builtinThemes().find((theme) => theme.id === id);
}

/**
 * The palette that is used when a light colour mode is requested.
 *
 * Only the neutral surfaces are replaced - the accent colours of a theme stay
 * untouched so that the character of a skin is preserved.
 */
const LIGHT_OVERRIDES: Record<string, string> = {
  '--bg': '#f2f5fa',
  '--bg-elevated': '#ffffff',
  '--bg-sunken': '#e6ebf3',
  '--surface': '#ffffff',
  '--surface-2': '#eef2f8',
  '--border': '#d3dae6',
  '--text': '#101722',
  '--text-muted': '#5b6579',
  '--shadow': '#0b122033',
  '--segment-off': '#e3e6ec',
  '--bezel': '#dfe4ec',
  '--bezel-shadow': '#0b122033',
};

const DARK_OVERRIDES: Record<string, string> = {
  '--bg': '#171e29', '--bg-elevated': '#252f3f', '--bg-sunken': '#101720',
  '--surface': '#222d3d', '--surface-2': '#2e3b4e', '--border': '#53647b',
  '--text': '#f0f4fc', '--text-muted': '#b9c7db', '--shadow': '#00000066',
  '--bezel': '#35445b', '--bezel-shadow': '#00000099', '--segment-off': '#304159',
};

export interface ThemeCssOptions {
  /** Force a colour mode instead of using the theme default. */
  mode?: 'dark' | 'light';
  /** User accent colour override. */
  accentColor?: string | null;
  /** Enable the artwork derived palette. */
  artworkTint?: boolean;
  /** Additional tokens applied on top of the theme. */
  overrides?: Record<string, string>;
}

/**
 * The tokens that describe a look instead of a value.
 *
 * They are translated by {@link themeToCss} into the concrete custom
 * properties that the stylesheet consumes, so they have no consumer in the
 * stylesheet itself. Every other token of the schema is used by the
 * stylesheet directly.
 */
export const ENGINE_TOKENS: readonly string[] = Object.freeze([
  '--display-style',
  '--transport-style',
]);

/**
 * Build the CSS custom property block for a theme.
 */
export function themeToCss(theme: ThemeDefinition, options: ThemeCssOptions = {}): string {
  const mode = options.mode ?? theme.mode;
  const declarations: string[] = [];
  // The value that every property has at the end of the build. The derived
  // colours are computed from these.
  const values = new Map<string, string>();
  const set = (name: string, value: string): void => {
    values.set(name, value);
    declarations.push(`  ${name}: ${value};`);
  };

  // Defaults first so that a theme only has to override what it changes.
  for (const token of TOKENS) {
    if (token.default) set(token.name, token.default);
  }

  for (const [name, value] of Object.entries(theme.tokens ?? {})) {
    set(name, value);
  }

  for (const [name, value] of Object.entries(theme.customProperties ?? {})) {
    set(name, value);
  }

  for (const [name, value] of Object.entries(options.overrides ?? {})) {
    set(name, value);
  }

  /*
   * The enum tokens describe a look, not a colour, so the CSS cannot use
   * them directly. They are translated here into the concrete values that
   * the stylesheet consumes.
   *
   * A theme that does not set them keeps the neutral defaults, so the
   * translation has to be done for every theme - not only for the ones
   * that use a segmented display.
   */
  const displayStyle = theme.tokens?.['--display-style'] ?? 'none';
  if (displayStyle !== 'none') {
    // A hardware display glows in the colour of its segments and shows the
    // text in a monospaced face.
    set('--display-glow', 'var(--segment-color)');
    set('--display-off', 'var(--segment-off)');
    set('--display-face', "'Consolas', 'DejaVu Sans Mono', monospace");
  }

  const transportStyle = theme.tokens?.['--transport-style'] ?? 'flat';
  const transportShadow =
    transportStyle === 'tactile'
      ? '0 2px 0 var(--bezel-shadow)'
      : transportStyle === 'inset'
        ? 'inset 0 1px 2px rgb(0 0 0 / 40%)'
        : transportStyle === 'classic'
          ? '0 0 0 1px var(--bezel), 0 1px 0 var(--bezel-shadow)'
          : 'none';
  set('--transport-shadow', transportShadow);

  // The shared light palette replaces the neutral surfaces of the theme.
  // A skin that defines its own colour mode keeps its own palette - otherwise
  // a brushed silver skin would be painted over with a generic light grey.
  if (mode === 'light' && theme.mode !== 'light') {
    for (const [name, value] of Object.entries(LIGHT_OVERRIDES)) {
      set(name, value);
    }
  }

  if (mode === 'dark' && theme.mode === 'light') {
    for (const [name, value] of Object.entries(DARK_OVERRIDES)) set(name, value);
  }
  if (theme.id === 'retro-amp' && mode === 'light') {
    set('--accent', '#007a32');
    set('--accent-2', '#006c75');
    set('--segment-color', '#007a32');
    set('--meter-color', '#007a32');
    set('--danger', '#b12424');
    set('--success', '#237c3a');
  }

  if (options.accentColor) {
    set('--accent', options.accentColor);
  }

  /*
   * The derived colours.
   *
   * The accent of a skin is a brand colour. It is used as the background of
   * the primary button and as a border, and it is read as text in a few
   * places. Both uses have to work:
   *
   *   - `--accent-contrast` is the label on an accent surface. It is
   *     computed, because a theme that pairs a bright accent with white
   *     text produces a button whose label cannot be read.
   *   - `--accent-text` is the accent as text. It keeps the hue and the
   *     saturation of the brand colour and only moves the lightness until
   *     the text can be read on the background of the skin.
   *
   * The same holds for the status colours and for the secondary text: a
   * theme that was designed for a dark background is often unreadable on a
   * light one, and the runtime corrects it instead of shipping a skin that
   * cannot be read.
   */
  const accent = values.get('--accent') ?? '#4c8dff';
  const background = values.get('--bg') ?? '#0b0d12';
  const surfaces = ['--bg', '--surface', '--surface-2', '--bg-elevated', '--bg-sunken']
    .map((name) => values.get(name))
    .filter((value): value is string => Boolean(value));

  set('--accent-contrast', readableForeground(accent));
  set('--accent-text', readableVariant(accent, surfaces.length > 0 ? surfaces : background));

  const muted = values.get('--text-muted');
  if (muted) set('--text-muted', readableVariant(muted, surfaces));

  const badgeSurface = values.get('--surface-2') ?? background;
  for (const [name, derived] of [
    ['--success', '--success-text'],
    ['--warning', '--warning-text'],
    ['--danger', '--danger-text'],
  ] as const) {
    const value = values.get(name);
    // The status colours are used as text on a badge and as the colour of a
    // small dot. Both have to be visible, so the variant is computed against
    // every surface they can appear on.
    if (value) set(derived, readableVariant(value, surfaces.length > 0 ? surfaces : badgeSurface));
  }

  set('--color-mode', mode);
  set('--artwork-tint', options.artworkTint === false ? '0' : '1');

  return `:root {\n${declarations.join('\n')}\n}`;
}

/**
 * A small CSS snippet that renders a preview of the theme.
 *
 * The variables are scoped to the preview element - a global `:root` block
 * would override the theme that is currently active in the application.
 *
 * The preview resolves with the live colour mode, the accent colour and the
 * artwork tint, so it shows what the theme really looks like. A preview that
 * ignores the settings of the user is a lie.
 */
export function themePreviewCss(
  theme: ThemeDefinition,
  options: { mode?: 'dark' | 'light'; accentColor?: string | null; artworkTint?: boolean } = {},
): string {
  const css = themeToCss(theme, options).replace(/:root\s*\{/, '.theme-preview {');
  return `${css}\n.theme-preview { background: var(--bg); color: var(--text); border: 1px solid var(--border); border-radius: var(--radius); padding: 12px; font-family: var(--font-family); }\n.theme-preview .preview-canvas { display: flex; flex-direction: column; }\n.theme-preview .bar { height: 8px; border-radius: 999px; background: var(--accent); width: 60%; }\n.theme-preview .bar.secondary { background: var(--accent-2); width: 35%; margin-top: 6px; }\n.theme-preview .panel { margin-top: 10px; height: 42px; border-radius: var(--radius-sm); background: var(--surface); border: 1px solid var(--border); }`;
}

/** Serialise a theme for export. */
export function exportTheme(theme: ThemeDefinition): string {
  const exportable = {
    id: theme.id,
    name: theme.name,
    version: theme.version,
    author: theme.author,
    description: theme.description,
    mode: theme.mode,
    supportsLight: theme.supportsLight,
    tokens: theme.tokens,
    customProperties: theme.customProperties,
  };
  return JSON.stringify(exportable, null, 2);
}

/**
 * Validate an imported theme.
 *
 * The function only accepts data - it never evaluates or executes anything.
 */
export function importTheme(json: string): ValidationResult {
  if (json.length > 256 * 1024) {
    return { ok: false, errors: ['The theme file is too large (max 256 KB).'] };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch (error) {
    return {
      ok: false,
      errors: [`The theme file is not valid JSON: ${(error as Error).message}`],
    };
  }
  return validateTheme(parsed);
}

/** Summarise a list of themes for the picker. */
export function summarise(themes: ThemeDefinition[], builtinIds: Set<string>): ThemeSummary[] {
  return themes.map((theme) => ({
    id: theme.id,
    name: theme.name,
    version: theme.version,
    author: theme.author,
    description: theme.description,
    mode: theme.mode,
    layout: theme.layout,
    builtin: builtinIds.has(theme.id),
    source: builtinIds.has(theme.id) ? 'builtin' : 'user',
  }));
}
