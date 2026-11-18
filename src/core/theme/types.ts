/** Theme definition types. */

/** The CSS custom properties a theme may define. */
export interface ThemeTokens {
  [token: string]: string;
}

export interface ThemeDefinition {
  id: string;
  name: string;
  version: string;
  author?: string;
  description?: string;
  /** Preferred colour mode of the theme. */
  mode: 'dark' | 'light';
  /** Tokens (CSS custom properties) provided by the theme. */
  tokens: ThemeTokens;
  /**
   * Optional safe custom properties. They are validated against the same
   * token list - arbitrary CSS is never accepted.
   */
  customProperties?: ThemeTokens;
  /** Optional local graphic references (relative to the theme folder). */
  assets?: Record<string, string>;
  /** Built-in themes only; user themes may not select a different layout. */
  layout?: string;
  /** Whether the theme can be used in light mode as well. */
  supportsLight?: boolean;
}

export interface ThemeSummary {
  id: string;
  name: string;
  version: string;
  author?: string;
  description?: string;
  mode: 'dark' | 'light';
  layout?: string;
  builtin: boolean;
  /**
   * Whether the theme can be used in light mode as well. A theme that cannot
   * keeps the colour mode it was designed for.
   */
  supportsLight?: boolean;
  /** Where the theme came from. */
  source: 'builtin' | 'user';
  /** True when the theme file failed validation. */
  invalid?: boolean;
  errors?: string[];
}
