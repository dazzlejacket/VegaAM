/**
 * Validation and safety invariants for SiriusXM surface theme CSS and inputs.
 *
 * Ensures generated stylesheets:
 *   - never exceed 256 KB
 *   - contain zero external resource or script constructs (`url(`, `@import`, etc.)
 *   - contain zero layout or visibility properties (`display`, `position`, `pointer-events`, etc.)
 *   - end every property declaration with `!important`
 *   - match the expected token snapshot + targeted override declaration count
 */

import { evaluatePaletteContrast } from './contrast';
import { MAX_SURFACE_CSS_BYTES, TARGETED_OVERRIDE_COUNT } from './engine';
import { SXM_TOKEN_SNAPSHOT } from './tokens';
import type { SurfacePalette } from './types';

const FORBIDDEN_PATTERNS: readonly { label: string; regex: RegExp }[] = Object.freeze([
  { label: 'url(', regex: /url\s*\(/i },
  { label: '@import', regex: /@import\b/i },
  { label: '@font-face', regex: /@font-face\b/i },
  { label: 'expression(', regex: /expression\s*\(/i },
  { label: 'behavior', regex: /\bbehavior\s*:/i },
  { label: '-moz-binding', regex: /-moz-binding\s*:/i },
  { label: 'javascript:', regex: /javascript\s*:/i },
  { label: 'image-set(', regex: /image-set\s*\(/i },
  { label: 'cursor:', regex: /(?:^|[;{]\s*)cursor\s*:/im },
  { label: 'content:', regex: /(?:^|[;{]\s*)content\s*:/im },
]);

const FORBIDDEN_LAYOUT_PROPERTIES: readonly string[] = Object.freeze([
  'display',
  'position',
  'pointer-events',
  'width',
  'height',
  'min-width',
  'min-height',
  'max-width',
  'max-height',
  'overflow',
  'overflow-x',
  'overflow-y',
  'z-index',
  'transform',
  'margin',
  'padding',
  'visibility',
  'opacity',
]);

export interface SurfaceCssValidationResult {
  ok: boolean;
  errors: string[];
  byteLength: number;
  tokenDeclarationCount: number;
}

/**
 * Validate a custom hex accent colour (`#rrggbb`, case-insensitive).
 */
export function isValidHexAccent(accent: unknown): accent is string {
  return typeof accent === 'string' && /^#[0-9a-f]{6}$/i.test(accent.trim());
}

/**
 * Normalize a custom hex accent to uppercase `#RRGGBB`, or return `null` if invalid/empty.
 */
export function sanitizeHexAccent(accent: unknown): string | null {
  if (accent === null || accent === undefined || accent === '') return null;
  if (!isValidHexAccent(accent)) return null;
  return accent.trim().toUpperCase();
}

/**
 * Validate a generated surface CSS string against all VegaAM 3.1 safety invariants.
 */
export function validateSurfaceCss(css: string): SurfaceCssValidationResult {
  const errors: string[] = [];
  const byteLength = Buffer.byteLength(css, 'utf8');

  if (byteLength === 0) {
    return {
      ok: true,
      errors: [],
      byteLength: 0,
      tokenDeclarationCount: 0,
    };
  }

  if (byteLength > MAX_SURFACE_CSS_BYTES) {
    errors.push(`CSS size ${byteLength} exceeds maximum ${MAX_SURFACE_CSS_BYTES} bytes.`);
  }

  // Strip comments before scanning declarations.
  const withoutComments = css.replace(/\/\*[\s\S]*?\*\//g, '');

  for (const { label, regex } of FORBIDDEN_PATTERNS) {
    if (regex.test(withoutComments)) {
      errors.push(`Forbidden CSS construct detected: ${label}`);
    }
  }

  // Extract property declarations (`prop: value;`) inside rule blocks.
  const blockMatches = withoutComments.match(/\{([^}]*)\}/g) ?? [];
  let tokenDeclarationCount = 0;
  let totalDeclarations = 0;

  for (const block of blockMatches) {
    const inner = block.slice(1, -1);
    const statements = inner
      .split(';')
      .map((s) => s.trim())
      .filter(Boolean);

    for (const stmt of statements) {
      const colonIdx = stmt.indexOf(':');
      if (colonIdx === -1) {
        errors.push(`Malformed declaration: "${stmt}"`);
        continue;
      }
      totalDeclarations += 1;
      const prop = stmt.slice(0, colonIdx).trim().toLowerCase();
      const val = stmt.slice(colonIdx + 1).trim();

      if (FORBIDDEN_LAYOUT_PROPERTIES.includes(prop)) {
        errors.push(`Forbidden layout property in surface CSS: "${prop}"`);
      }

      if (prop.startsWith('--color-')) {
        tokenDeclarationCount += 1;
      } else if (prop !== 'color-scheme' && prop !== 'background-color' && prop !== 'color') {
        errors.push(`Disallowed non-token property in surface CSS: "${prop}"`);
      }

      if (!/!important$/i.test(val)) {
        errors.push(`Declaration for "${prop}" does not end with !important.`);
      }
    }
  }

  const expectedTokenCount = SXM_TOKEN_SNAPSHOT.tokenCount + TARGETED_OVERRIDE_COUNT;
  if (tokenDeclarationCount !== expectedTokenCount) {
    errors.push(
      `Expected ${expectedTokenCount} --color-* declarations (${SXM_TOKEN_SNAPSHOT.tokenCount} snapshot + ${TARGETED_OVERRIDE_COUNT} targeted), got ${tokenDeclarationCount}.`,
    );
  }

  if (totalDeclarations === 0) {
    errors.push('Generated CSS contains zero property declarations.');
  }

  return {
    ok: errors.length === 0,
    errors,
    byteLength,
    tokenDeclarationCount,
  };
}

/**
 * Validate a palette's contrast ratios.
 */
export function validateSurfacePaletteContrast(palette: SurfacePalette): {
  ok: boolean;
  report: ReturnType<typeof evaluatePaletteContrast>;
} {
  const report = evaluatePaletteContrast(palette);
  return { ok: report.passes, report };
}
