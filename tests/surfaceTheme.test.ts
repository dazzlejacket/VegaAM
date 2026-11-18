import { describe, expect, it } from 'vitest';

import {
  contrastRatio,
  evaluatePaletteContrast,
  parseColour,
  relativeLuminance,
  type Rgb,
} from '../src/core/surfaceTheme/contrast';
import {
  MAX_SURFACE_CSS_BYTES,
  TARGETED_OVERRIDE_COUNT,
  alphaSafeTextColour,
  generateSurfaceCss,
  resolveEffectivePalette,
} from '../src/core/surfaceTheme/engine';
import {
  SURFACE_THEMES,
  getSurfaceTheme,
  listSurfaceThemeSummaries,
  normalizeSurfaceThemeId,
} from '../src/core/surfaceTheme/palettes';
import { SXM_TOKENS, SXM_TOKEN_SNAPSHOT, SOURCE_VALUE_MAP } from '../src/core/surfaceTheme/tokens';
import {
  isValidHexAccent,
  sanitizeHexAccent,
  validateSurfaceCss,
} from '../src/core/surfaceTheme/validate';

/** CSS sRGB compositing of `colour` over `background` at `alpha`. */
function composite(colour: Rgb, background: Rgb, alpha: number): Rgb {
  return [
    colour[0] * alpha + background[0] * (1 - alpha),
    colour[1] * alpha + background[1] * (1 - alpha),
    colour[2] * alpha + background[2] * (1 - alpha),
  ];
}

describe('SiriusXM surface theme core (VegaAM 3.2)', () => {
  it('ships all 14 built-in surface themes (9 dark + 5 light) plus official', () => {
    const ids = SURFACE_THEMES.map((t) => t.id);
    expect(ids).toEqual([
      'vega',
      'catppuccin',
      'dracula',
      'nord',
      'gruvbox',
      'tokyo-night',
      'rose-pine',
      'solarized',
      'oled',
      'vega-light',
      'catppuccin-latte',
      'nord-light',
      'solarized-light',
      'rose-pine-dawn',
    ]);
    const summaries = listSurfaceThemeSummaries();
    expect(summaries).toHaveLength(14);
    expect(summaries.filter((t) => t.mode === 'dark')).toHaveLength(9);
    expect(summaries.filter((t) => t.mode === 'light')).toHaveLength(5);
    expect(normalizeSurfaceThemeId(null)).toBe('official');
    expect(normalizeSurfaceThemeId(undefined)).toBe('official');
    expect(normalizeSurfaceThemeId('unknown-theme')).toBe('official');
    expect(normalizeSurfaceThemeId('catppuccin')).toBe('catppuccin');
    expect(normalizeSurfaceThemeId('catppuccin-latte')).toBe('catppuccin-latte');
    expect(normalizeSurfaceThemeId('vega-light')).toBe('vega-light');
  });

  it('matches the 1,288-token SiriusXM v7.x snapshot metadata', () => {
    expect(SXM_TOKEN_SNAPSHOT.site).toBe('sxm-player-web');
    expect(SXM_TOKEN_SNAPSHOT.capturedAt).toBe('2026-11-05');
    expect(SXM_TOKEN_SNAPSHOT.tokenCount).toBe(1288);
    expect(Object.keys(SXM_TOKENS)).toHaveLength(SXM_TOKEN_SNAPSHOT.tokenCount);
  });

  it('generates empty CSS for the official stock theme', () => {
    const css = generateSurfaceCss('official');
    expect(css).toBe('');
    const validation = validateSurfaceCss(css);
    expect(validation.ok).toBe(true);
    expect(validation.byteLength).toBe(0);
  });

  it('generates valid, < 256 KB, !important-only CSS for every built-in dark and light theme', () => {
    for (const theme of SURFACE_THEMES) {
      const css = generateSurfaceCss(theme.id);
      const validation = validateSurfaceCss(css);

      expect(validation.ok).toBe(true);
      expect(validation.errors).toEqual([]);
      expect(validation.byteLength).toBeGreaterThan(80_000);
      expect(validation.byteLength).toBeLessThan(MAX_SURFACE_CSS_BYTES);
      expect(validation.tokenDeclarationCount).toBe(
        SXM_TOKEN_SNAPSHOT.tokenCount + TARGETED_OVERRIDE_COUNT,
      );
      expect(css).toContain(
        `body { background-color: ${theme.palette.bg} !important; color: ${theme.palette.text} !important; }`,
      );
      expect(css).toContain(`color-scheme: ${theme.mode} !important;`);
      expect(css).toContain(`--color-button-play-surface: ${theme.palette.accent} !important;`);
      expect(css).toContain(
        `--color-button-brand-primary-contrast: ${theme.palette.accentContrast} !important;`,
      );
    }
  });

  it('rejects forbidden constructs and layout properties in validateSurfaceCss', () => {
    const valid = generateSurfaceCss('vega');
    expect(validateSurfaceCss(`${valid}\nbody { background: url(https://evil.example/x.png) !important; }`).ok).toBe(false);
    expect(validateSurfaceCss(`@import "https://evil.example/a.css";\n${valid}`).ok).toBe(false);
    expect(validateSurfaceCss(`${valid}\nbody { display: none !important; }`).ok).toBe(false);
    expect(validateSurfaceCss(`${valid}\nbody { pointer-events: none !important; }`).ok).toBe(false);
    expect(validateSurfaceCss(`${valid}\nbody { position: fixed !important; }`).ok).toBe(false);
    expect(validateSurfaceCss(`${valid}\nbody { z-index: 9999 !important; }`).ok).toBe(false);
    expect(validateSurfaceCss(`${valid}\n:root { --color-background: #000000; }`).ok).toBe(false);
  });

  it('applies and contrast-checks custom hex accents and rejects invalid accents', () => {
    expect(isValidHexAccent('#FF4FA3')).toBe(true);
    expect(isValidHexAccent('#5b8cff')).toBe(true);
    expect(isValidHexAccent('red')).toBe(false);
    expect(isValidHexAccent('#12345')).toBe(false);
    expect(isValidHexAccent('url(javascript:alert(1))')).toBe(false);
    expect(sanitizeHexAccent('#ff4fa3')).toBe('#FF4FA3');
    expect(sanitizeHexAccent('not-a-hex')).toBeNull();

    const vega = getSurfaceTheme('vega')!;
    const effective = resolveEffectivePalette(vega, { accent: '#FF4FA3' });
    expect(effective.accent).toBe('#FF4FA3');

    const css = generateSurfaceCss('vega', { accent: '#FF4FA3' });
    expect(css).toContain('--color-surface-accent: #FF4FA3 !important;');
    expect(css).toContain('--color-button-play-surface: #FF4FA3 !important;');
    expect(validateSurfaceCss(css).ok).toBe(true);

    // Very dark accent still derives a readable accentSoft on the dark background
    const darkAccentPalette = resolveEffectivePalette(vega, { accent: '#091020' });
    const contrast = evaluatePaletteContrast({
      ...darkAccentPalette,
      accent: darkAccentPalette.accentSoft,
      accentContrast: '#070B16',
    });
    expect(contrast.accentOnBg).toBeGreaterThanOrEqual(4.5);

    expect(() => generateSurfaceCss('vega', { accent: 'invalid-hex' })).toThrow();
    expect(() => generateSurfaceCss('official', { accent: 'invalid-hex' })).toThrow();
  });

  it('satisfies WCAG contrast gates across all nine built-in palettes', () => {
    for (const theme of SURFACE_THEMES) {
      const report = evaluatePaletteContrast(theme.palette);
      expect(report.textOnBg, `${theme.id} text/bg`).toBeGreaterThanOrEqual(4.5);
      expect(report.mutedOnBg, `${theme.id} muted/bg`).toBeGreaterThanOrEqual(4.5);
      expect(report.accentContrastOnAccent, `${theme.id} accentContrast/accent`).toBeGreaterThanOrEqual(4.5);
      expect(report.accentOnBg, `${theme.id} accent/bg`).toBeGreaterThanOrEqual(3.0);
      expect(report.dangerOnBg, `${theme.id} danger/bg`).toBeGreaterThanOrEqual(3.0);
      expect(report.passes, `${theme.id} passes`).toBe(true);
    }
  });

  it('keeps translucent secondary text readable in every light theme', () => {
    // SiriusXM paints secondary labels with translucent tokens such as
    // `rgba(128, 153, 168, .8)`. The role colour must still be readable once
    // that alpha is composited over the page surface.
    for (const theme of SURFACE_THEMES.filter((t) => t.mode === 'light')) {
      const surfaces = [theme.palette.bg, theme.palette.mantle, theme.palette.surface];

      for (const alpha of [0.6, 0.7, 0.8, 0.9]) {
        const corrected = alphaSafeTextColour(theme.palette.muted, surfaces, alpha);
        for (const surface of surfaces) {
          const composited = composite(
            parseColour(corrected)!,
            parseColour(surface)!,
            alpha,
          );
          expect(
            contrastRatio(composited, parseColour(surface)!),
            `${theme.id} muted @${alpha} on ${surface}`,
          ).toBeGreaterThanOrEqual(4.5);
        }
      }
    }
  });

  it('emits alpha-corrected text tokens for every translucent source value', () => {
    // Every token whose upstream value is translucent AND carries a
    // text-bearing role must still be readable after compositing.
    const roleBySource = new Map(
      SOURCE_VALUE_MAP.map(([source, role]) => [source, role] as const),
    );
    const textRoles = new Set([
      'text',
      'muted',
      'accentSoft',
      'accent2',
      'warning',
      'danger',
      'danger2',
    ]);

    for (const theme of SURFACE_THEMES) {
      const css = generateSurfaceCss(theme.id);
      const surfaces = (
        theme.mode === 'light'
          ? [theme.palette.bg, theme.palette.mantle, theme.palette.surface]
          : [theme.palette.bg, theme.palette.crust, theme.palette.surface]
      ).map((value) => parseColour(value)!);

      // Generated declarations, keyed by token name.
      const generated = new Map<string, { rgb: Rgb; alpha: number }>();
      for (const match of css.matchAll(
        /(--color-[A-Za-z0-9_-]+): rgba\((\d+), (\d+), (\d+), ([\d.]+)\)/g,
      )) {
        generated.set(match[1]!, {
          rgb: [Number(match[2]), Number(match[3]), Number(match[4])],
          alpha: Number(match[5]),
        });
      }

      let checked = 0;
      for (const [token, originalValue] of Object.entries(SXM_TOKENS)) {
        const original = originalValue.match(
          /^rgba\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*,\s*([\d.]+)\s*\)$/,
        );
        if (!original) continue;
        const alpha = Number(original[4]);
        if (alpha >= 1) continue;

        // Only tokens that actually paint text are held to the AA gate.
        // WCAG exempts disabled controls, and the upstream player uses the
        // same colour roles for borders, surfaces and dividers.
        if (token.includes('disabled')) continue;
        if (/(border|surface|divider|outline|shadow|fill|track)/.test(token)) continue;

        const role = roleBySource.get(
          `${original[1]},${original[2]},${original[3]}`,
        );
        if (!role || !textRoles.has(role)) continue;

        const value = generated.get(token);
        expect(value, `${theme.id} ${token} must be generated`).toBeDefined();
        expect(value!.alpha, `${theme.id} ${token} must keep its alpha`).toBeCloseTo(alpha, 5);

        for (const surface of surfaces) {
          const composited = composite(value!.rgb, surface, value!.alpha);
          const achieved = contrastRatio(composited, surface);

          // Some combinations are mathematically unreachable (50% white text on
          // a mid-dark surface can never reach 4.5:1). In that case the engine
          // must still deliver the best achievable ratio.
          const extreme: Rgb =
            relativeLuminance(surface) > 0.4 ? [0, 0, 0] : [255, 255, 255];
          const bestAchievable = contrastRatio(composite(extreme, surface, value!.alpha), surface);
          const target = Math.min(4.5, bestAchievable);

          expect(
            achieved,
            `${theme.id} ${token} (${role}) @${alpha} on rgb(${surface.join(',')}) ` +
              `(best achievable ${bestAchievable.toFixed(2)})`,
          ).toBeGreaterThanOrEqual(target - 0.02);
        }
        checked += 1;
      }

      expect(checked, `${theme.id} must contain translucent text tokens`).toBeGreaterThan(0);
    }
  });
});
