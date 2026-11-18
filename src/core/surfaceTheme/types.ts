/**
 * Types for the VegaAM 3.2 SiriusXM surface theme engine.
 *
 * Surface themes recolour the official SiriusXM web player (`sxm-player-web`)
 * using reversible CSS custom-property (`--color-*`) overrides via
 * `webContents.insertCSS(css, { cssOrigin: 'user' })`.
 */

export type SurfaceThemeMode = 'dark' | 'light';

export type SurfaceThemeId =
  | 'official'
  | 'vega'
  | 'catppuccin'
  | 'dracula'
  | 'nord'
  | 'gruvbox'
  | 'tokyo-night'
  | 'rose-pine'
  | 'solarized'
  | 'oled'
  | 'vega-light'
  | 'catppuccin-latte'
  | 'nord-light'
  | 'solarized-light'
  | 'rose-pine-dawn';

export type BuiltinSurfaceThemeId = Exclude<SurfaceThemeId, 'official'>;

export type SurfacePaletteRole =
  | 'bg'
  | 'mantle'
  | 'crust'
  | 'surface'
  | 'surface2'
  | 'overlay'
  | 'muted'
  | 'text'
  | 'accent'
  | 'accentHover'
  | 'accent2'
  | 'accentSoft'
  | 'accentContrast'
  | 'danger'
  | 'danger2'
  | 'warning';

export type SurfacePalette = Record<SurfacePaletteRole, string>;

export interface SurfaceThemeSummary {
  id: BuiltinSurfaceThemeId;
  name: string;
  family: string;
  mode: SurfaceThemeMode;
  description: string;
  accent: string;
  bg: string;
  mantle: string;
  surface: string;
  text: string;
}

export interface SurfaceThemeDefinition extends SurfaceThemeSummary {
  palette: SurfacePalette;
}

export interface SurfaceTokenSnapshotMeta {
  site: 'sxm-player-web';
  capturedAt: '2026-11-05';
  tokenCount: 1288;
  distinctValues: 83;
  stylesheet: 'index-BtyGMKGL.css';
}

export interface SurfaceThemeState {
  activeId: SurfaceThemeId;
  accent: string | null;
  consent: boolean;
  applied: boolean;
  pausedOnAuth?: boolean;
  lastError: string | null;
  cssBytes: number;
  appliedAt: number | null;
  snapshot: SurfaceTokenSnapshotMeta;
  themes: SurfaceThemeSummary[];
}

export interface SurfaceThemeDiagnostics {
  appVersion: string;
  platform: string;
  url: string;
  activeId: SurfaceThemeId;
  accent: string | null;
  consent: boolean;
  applied: boolean;
  pausedOnAuth: boolean;
  cssBytes: number;
  appliedAt: number | null;
  lastError: string | null;
  snapshot: SurfaceTokenSnapshotMeta;
}
