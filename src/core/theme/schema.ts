/**
 * Theme validation.
 *
 * Themes are user installable, therefore they are treated as untrusted input:
 * only a fixed list of design tokens with a strict value format is accepted.
 * No scripts, no arbitrary CSS, no remote resources - a theme can only
 * change colours, fonts, radii and spacing.
 */

import type { ThemeDefinition, ThemeSummary, ThemeTokens } from './types';

export type TokenType = 'color' | 'length' | 'number' | 'font' | 'enum';

export interface TokenDefinition {
  name: string;
  type: TokenType;
  description: string;
  default?: string;
  /** Allowed values for enum tokens. */
  values?: string[];
}

export const TOKENS: TokenDefinition[] = [
  { name: '--bg', type: 'color', description: 'Main background', default: '#0b0d12' },
  { name: '--bg-elevated', type: 'color', description: 'Elevated surfaces', default: '#141821' },
  { name: '--bg-sunken', type: 'color', description: 'Recessed surfaces', default: '#070910' },
  { name: '--surface', type: 'color', description: 'Cards and panels', default: '#171c26' },
  { name: '--surface-2', type: 'color', description: 'Secondary surfaces', default: '#1e2431' },
  { name: '--border', type: 'color', description: 'Borders and separators', default: '#2a3140' },
  { name: '--text', type: 'color', description: 'Primary text', default: '#e8ecf4' },
  { name: '--text-muted', type: 'color', description: 'Secondary text', default: '#8b93a7' },
  { name: '--accent', type: 'color', description: 'Primary accent colour', default: '#4c8dff' },
  { name: '--accent-2', type: 'color', description: 'Secondary accent colour', default: '#9a6bff' },
  { name: '--accent-contrast', type: 'color', description: 'Text on accent surfaces', default: '#ffffff' },
  { name: '--success', type: 'color', description: 'Success colour', default: '#3ecf8e' },
  { name: '--warning', type: 'color', description: 'Warning colour', default: '#f5a524' },
  { name: '--danger', type: 'color', description: 'Error colour', default: '#f2545b' },
  { name: '--shadow', type: 'color', description: 'Shadow colour', default: '#00000066' },
  { name: '--radius', type: 'length', description: 'Corner radius', default: '12px' },
  { name: '--radius-lg', type: 'length', description: 'Large corner radius', default: '20px' },
  { name: '--radius-sm', type: 'length', description: 'Small corner radius', default: '6px' },
  { name: '--blur', type: 'length', description: 'Backdrop blur radius', default: '18px' },
  { name: '--font-family', type: 'font', description: 'UI font stack', default: 'system-ui, sans-serif' },
  { name: '--font-size', type: 'length', description: 'Base font size', default: '14px' },
  { name: '--font-size-display', type: 'length', description: 'Display font size', default: '30px' },
  { name: '--sidebar-width', type: 'length', description: 'Sidebar width', default: '236px' },
  { name: '--artwork-radius', type: 'length', description: 'Artwork corner radius', default: '18px' },
  { name: '--artwork-size', type: 'length', description: 'Artwork size in the now playing view', default: '280px' },
  { name: '--player-padding', type: 'length', description: 'Padding of the player panel', default: '24px' },
  { name: '--opacity-artwork', type: 'number', description: 'Artwork backdrop opacity', default: '0.35' },
  { name: '--opacity-grid', type: 'number', description: 'Background grid opacity', default: '0.06' },
  { name: '--display-style', type: 'enum', description: 'Segmented display style', default: 'none', values: ['none', 'lcd', 'vfd', 'seven-segment'] },
  { name: '--bezel', type: 'color', description: 'Hardware bezel colour', default: '#1b1f27' },
  { name: '--bezel-shadow', type: 'color', description: 'Bezel shadow colour', default: '#00000080' },
  { name: '--knob', type: 'color', description: 'Knob / dial colour', default: '#c9d1e0' },
  { name: '--meter-color', type: 'color', description: 'Level meter colour', default: '#3ecf8e' },
  { name: '--segment-color', type: 'color', description: 'Display segment colour', default: '#ffb347' },
  { name: '--segment-off', type: 'color', description: 'Inactive display segment colour', default: '#3a2f1d' },
  { name: '--transport-style', type: 'enum', description: 'Transport button style', default: 'flat', values: ['flat', 'tactile', 'inset', 'classic'] },
  { name: '--window-radius', type: 'length', description: 'Window corner radius', default: '12px' },
];

const TOKEN_MAP = new Map(TOKENS.map((t) => [t.name, t]));

const RE_COLOR = /^(#[0-9a-fA-F]{3,8}|rgba?\(\s*[\d.]+\s*,\s*[\d.]+\s*,\s*[\d.]+\s*(,\s*[\d.]+\s*)?\)|hsla?\(\s*[\d.]+\s*,\s*[\d.]+%\s*,\s*[\d.]+%\s*(,\s*[\d.]+\s*)?\))$/;
const RE_LENGTH = /^-?\d+(\.\d+)?(px|rem|em|%|vh|vw|ch|pt)$/;
const RE_NUMBER = /^-?\d+(\.\d+)?$/;
const RE_FONT = /^[A-Za-z0-9 ,'"_\-]+$/;

/** Maximum size of an imported theme file. */
export const MAX_THEME_BYTES = 256 * 1024;

export interface ValidationResult {
  ok: boolean;
  theme?: ThemeDefinition;
  errors: string[];
}

/**
 * Validate a single token value.
 */
export function validateToken(name: string, value: unknown): string | undefined {
  const definition = TOKEN_MAP.get(name);
  if (!definition) return `Unknown design token "${name}".`;
  if (typeof value !== 'string') return `Token "${name}" must be a string.`;
  const trimmed = value.trim();
  if (!trimmed) return `Token "${name}" must not be empty.`;
  if (/url\s*\(|expression\s*\(|javascript:/i.test(trimmed)) {
    return `Token "${name}" must not contain urls or expressions.`;
  }

  switch (definition.type) {
    case 'color':
      if (!RE_COLOR.test(trimmed)) return `Token "${name}" is not a valid colour.`;
      return undefined;
    case 'length':
      if (!RE_LENGTH.test(trimmed)) return `Token "${name}" is not a valid length.`;
      return undefined;
    case 'number':
      if (!RE_NUMBER.test(trimmed)) return `Token "${name}" is not a valid number.`;
      return undefined;
    case 'font':
      if (!RE_FONT.test(trimmed)) return `Token "${name}" is not a valid font stack.`;
      return undefined;
    case 'enum':
      if (!definition.values?.includes(trimmed)) {
        return `Token "${name}" must be one of: ${definition.values?.join(', ')}.`;
      }
      return undefined;
    default:
      return undefined;
  }
}

/**
 * Validate a whole theme definition.
 */
export function validateTheme(input: unknown): ValidationResult {
  const errors: string[] = [];
  if (!input || typeof input !== 'object') {
    return { ok: false, errors: ['The theme file is not a valid JSON object.'] };
  }
  const raw = input as Record<string, unknown>;

  const id = typeof raw.id === 'string' ? raw.id.trim() : '';
  if (!/^[a-z0-9][a-z0-9\-_]{1,48}$/i.test(id)) {
    errors.push('The theme id must consist of letters, digits, "-" or "_".');
  }

  const name = typeof raw.name === 'string' ? raw.name.trim() : '';
  if (!name || name.length > 64) errors.push('The theme name is missing or too long.');

  const version = typeof raw.version === 'string' ? raw.version.trim() : '1.0.0';
  if (!/^\d+(\.\d+){0,3}$/.test(version)) errors.push('The theme version is invalid.');

  const mode = raw.mode === 'light' ? 'light' : 'dark';

  const tokens: ThemeTokens = {};
  const rawTokens = raw.tokens;
  if (rawTokens && typeof rawTokens === 'object') {
    for (const [key, value] of Object.entries(rawTokens as Record<string, unknown>)) {
      const error = validateToken(key, value);
      if (error) errors.push(error);
      else tokens[key] = String(value).trim();
    }
  }

  const customProperties: ThemeTokens = {};
  const rawCustom = raw.customProperties;
  if (rawCustom && typeof rawCustom === 'object') {
    for (const [key, value] of Object.entries(rawCustom as Record<string, unknown>)) {
      const error = validateToken(key, value);
      if (error) errors.push(error);
      else customProperties[key] = String(value).trim();
    }
  }

  const assets: Record<string, string> = {};
  const rawAssets = raw.assets;
  if (rawAssets && typeof rawAssets === 'object') {
    for (const [key, value] of Object.entries(rawAssets as Record<string, unknown>)) {
      if (typeof value !== 'string') {
        errors.push(`Asset "${key}" must be a string path.`);
        continue;
      }
      if (/^[a-z0-9][a-z0-9\-_./]*$/i.test(value) && !value.includes('..')) {
        assets[key] = value;
      } else {
        errors.push(`Asset "${key}" contains an unsafe path.`);
      }
    }
  }

  if (errors.length > 0) return { ok: false, errors };

  const theme: ThemeDefinition = {
    id,
    name,
    version,
    mode,
    tokens,
    supportsLight: raw.supportsLight !== false,
  };
  if (typeof raw.author === 'string') theme.author = raw.author.slice(0, 64);
  if (typeof raw.description === 'string') theme.description = raw.description.slice(0, 280);
  if (Object.keys(customProperties).length > 0) theme.customProperties = customProperties;
  if (Object.keys(assets).length > 0) theme.assets = assets;
  if (typeof raw.layout === 'string' && /^[a-z0-9\-_]{1,32}$/i.test(raw.layout)) {
    theme.layout = raw.layout;
  }

  return { ok: true, theme, errors: [] };
}

/** Build the summary used in the theme picker. */
export function toSummary(theme: ThemeDefinition, builtin: boolean): ThemeSummary {
  return {
    id: theme.id,
    name: theme.name,
    version: theme.version,
    author: theme.author,
    description: theme.description,
    mode: theme.mode,
    layout: theme.layout,
    builtin,
    supportsLight: theme.supportsLight !== false,
    source: builtin ? 'builtin' : 'user',
  };
}
