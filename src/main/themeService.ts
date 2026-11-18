/**
 * Theme service.
 *
 * Loads the built-in skins plus the user installed themes from the user data
 * directory and produces the CSS that is applied in the renderer.
 */

import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import {
  builtinThemes,
  exportTheme,
  getBuiltinTheme,
  importTheme,
  themePreviewCss,
  themeToCss,
} from '../core/theme/engine';
import { toSummary, validateTheme } from '../core/theme/schema';
import type { ThemeDefinition, ThemeSummary } from '../core/theme/types';

export interface ThemeServiceOptions {
  userDataPath: string;
  /** Called whenever the available themes change. */
  onChange?: (themes: ThemeSummary[]) => void;
}

export class ThemeService {
  private readonly userThemesPath: string;
  private userThemes: ThemeDefinition[] = [];
  private readonly onChange?: (themes: ThemeSummary[]) => void;

  constructor(options: ThemeServiceOptions) {
    this.userThemesPath = join(options.userDataPath, 'themes');
    this.onChange = options.onChange;
  }

  /** Load the user themes from disk. */
  async load(): Promise<ThemeSummary[]> {
    await mkdir(this.userThemesPath, { recursive: true });
    const themes: ThemeDefinition[] = [];
    let files: string[] = [];
    try {
      files = await readdir(this.userThemesPath);
    } catch {
      files = [];
    }
    for (const file of files) {
      if (!file.endsWith('.json')) continue;
      try {
        const raw = await readFile(join(this.userThemesPath, file), 'utf8');
        const result = validateTheme(JSON.parse(raw));
        if (result.ok && result.theme) themes.push(result.theme);
      } catch (error) {
        console.warn(`[themes] ignoring invalid theme file "${file}":`, error);
      }
    }
    this.userThemes = themes;
    const summaries = this.summaries();
    this.onChange?.(summaries);
    return summaries;
  }

  /** All available themes. */
  summaries(): ThemeSummary[] {
    const builtinIds = new Set(builtinThemes().map((t) => t.id));
    return [...builtinThemes(), ...this.userThemes].map((theme) => toSummary(theme, builtinIds.has(theme.id)));
  }

  /** Find a theme by id. */
  get(id: string): ThemeDefinition | undefined {
    return getBuiltinTheme(id) ?? this.userThemes.find((theme) => theme.id === id);
  }

  /** The CSS custom properties for a theme. */
  css(
    id: string,
    options: { mode?: 'dark' | 'light'; accentColor?: string | null; artworkTint?: boolean } = {},
  ): string {
    const theme = this.get(id) ?? builtinThemes()[0]!;
    return themeToCss(theme, options);
  }

  /**
   * The CSS for the theme preview in the settings.
   *
   * The variables are scoped to the preview element so that the preview can
   * never override the theme that is currently active.
   *
   * The preview resolves with the live colour mode, the accent colour and the
   * artwork tint, so it shows the theme as it will really look like.
   */
  previewCss(
    id: string,
    options: { mode?: 'dark' | 'light'; accentColor?: string | null; artworkTint?: boolean } = {},
  ): string {
    const theme = this.get(id) ?? builtinThemes()[0]!;
    return themePreviewCss(theme, options);
  }

  /** Export a theme as JSON. */
  export(id: string): string | undefined {
    const theme = this.get(id);
    return theme ? exportTheme(theme) : undefined;
  }

  /**
   * Import a theme from a JSON string.
   *
   * The theme is validated before it is written; invalid themes are rejected
   * with a readable error.
   */
  async import(json: string): Promise<{ ok: boolean; theme?: ThemeSummary; errors: string[] }> {
    const result = importTheme(json);
    if (!result.ok || !result.theme) {
      return { ok: false, errors: result.errors };
    }
    const theme = result.theme;
    await mkdir(this.userThemesPath, { recursive: true });
    await writeFile(
      join(this.userThemesPath, `${theme.id}.json`),
      JSON.stringify(theme, null, 2),
      'utf8',
    );
    await this.load();
    return { ok: true, theme: toSummary(theme, false), errors: [] };
  }

  /** The directory the user themes are stored in. */
  get directory(): string {
    return this.userThemesPath;
  }
}
