/**
 * Colour maths for the themes.
 *
 * A theme is a skin that the user looks at for hours. The accent colour of
 * a skin is a brand colour - it is chosen for its character, not for its
 * contrast. The problem is that a brand colour is often unreadable as text:
 * a bright amber on a light background is a typical example.
 *
 * Two derived values solve this without changing the character of a skin:
 *
 *   - `--accent-contrast` is the text colour on an accent surface. White and
 *     black are the candidates; the one with the better contrast wins.
 *   - `--accent-text` is the accent colour itself, darkened or lightened
 *     until it can be read on the background of the skin.
 *
 * Both are computed here so that every skin - the built-in ones and the ones
 * a user installs - gets the same guarantee.
 */

export type Rgb = [number, number, number];

/** The contrast ratio that is required for normal text (WCAG AA). */
export const MINIMUM_CONTRAST = 4.5;

/** Parse a hex or rgb colour. */
export function parseColour(value: string): Rgb | undefined {
  const trimmed = value.trim();
  if (trimmed.startsWith('#')) {
    const hex = trimmed.slice(1);
    const full = hex.length === 3 ? hex.split('').map((c) => c + c).join('') : hex;
    if (full.length < 6) return undefined;
    const channels = [0, 2, 4].map((index) => parseInt(full.slice(index, index + 2), 16));
    if (channels.some((channel) => Number.isNaN(channel))) return undefined;
    return channels as Rgb;
  }
  const match = trimmed.match(/rgba?\(([^)]+)\)/i);
  if (!match) return undefined;
  const parts = match[1]!.split(',').map((part) => parseFloat(part.trim()));
  if (parts.length < 3 || parts.some((part) => Number.isNaN(part))) return undefined;
  return [parts[0]!, parts[1]!, parts[2]!];
}

/** The relative luminance of a colour. */
export function relativeLuminance([r, g, b]: Rgb): number {
  const channel = (value: number): number => {
    const scaled = value / 255;
    return scaled <= 0.03928 ? scaled / 12.92 : Math.pow((scaled + 0.055) / 1.055, 2.4);
  };
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

/** The contrast ratio between two colours. */
export function contrastRatio(first: Rgb, second: Rgb): number {
  const a = relativeLuminance(first);
  const b = relativeLuminance(second);
  const lighter = Math.max(a, b);
  const darker = Math.min(a, b);
  return (lighter + 0.05) / (darker + 0.05);
}

/** The contrast ratio between two colour strings. */
export function contrastOf(first: string, second: string): number {
  const a = parseColour(first);
  const b = parseColour(second);
  if (!a || !b) return Number.NaN;
  return contrastRatio(a, b);
}

/**
 * The text colour for a surface.
 *
 * White and black are the only candidates - a third colour would have to be
 * chosen by hand for every theme, and the result would drift.
 */
export function readableForeground(background: string): string {
  const base = parseColour(background);
  if (!base) return '#ffffff';
  const onWhite = contrastRatio([255, 255, 255], base);
  const onBlack = contrastRatio([0, 0, 0], base);
  return onWhite >= onBlack ? '#ffffff' : '#000000';
}

/** Convert a colour to hue, saturation and lightness. */
function toHsl([r, g, b]: Rgb): [number, number, number] {
  const red = r / 255;
  const green = g / 255;
  const blue = b / 255;
  const max = Math.max(red, green, blue);
  const min = Math.min(red, green, blue);
  const lightness = (max + min) / 2;
  if (max === min) return [0, 0, lightness];
  const delta = max - min;
  const saturation =
    lightness > 0.5 ? delta / (2 - max - min) : delta / (max + min);
  let hue: number;
  if (max === red) hue = ((green - blue) / delta + (green < blue ? 6 : 0)) / 6;
  else if (max === green) hue = ((blue - red) / delta + 2) / 6;
  else hue = ((red - green) / delta + 4) / 6;
  return [hue, saturation, lightness];
}

/** Convert hue, saturation and lightness back to a colour. */
function fromHsl([hue, saturation, lightness]: [number, number, number]): Rgb {
  if (saturation === 0) {
    const value = Math.round(lightness * 255);
    return [value, value, value];
  }
  const hueToChannel = (p: number, q: number, t: number): number => {
    let temp = t;
    if (temp < 0) temp += 1;
    if (temp > 1) temp -= 1;
    if (temp < 1 / 6) return p + (q - p) * 6 * temp;
    if (temp < 1 / 2) return q;
    if (temp < 2 / 3) return p + (q - p) * (2 / 3 - temp) * 6;
    return p;
  };
  const q =
    lightness < 0.5
      ? lightness * (1 + saturation)
      : lightness + saturation - lightness * saturation;
  const p = 2 * lightness - q;
  return [
    Math.round(hueToChannel(p, q, hue + 1 / 3) * 255),
    Math.round(hueToChannel(p, q, hue) * 255),
    Math.round(hueToChannel(p, q, hue - 1 / 3) * 255),
  ];
}

/**
 * A variant of the colour that can be read on the background.
 *
 * The colour keeps its hue and its saturation; only the lightness moves -
 * downwards on a light background, upwards on a dark one - until the
 * contrast is reached against every background that is given.
 */
export function readableVariant(colour: string, backgrounds: string | string[]): string {
  const base = parseColour(colour);
  const surfaces = (Array.isArray(backgrounds) ? backgrounds : [backgrounds])
    .map((value) => parseColour(value))
    .filter((value): value is Rgb => Boolean(value));
  if (!base || surfaces.length === 0) return colour;

  const [hue, saturation, lightness] = toHsl(base);
  const averageLuminance =
    surfaces.reduce((sum, surface) => sum + relativeLuminance(surface), 0) / surfaces.length;
  const surfaceIsLight = averageLuminance > 0.4;
  const step = surfaceIsLight ? -0.02 : 0.02;

  let candidate = base;
  for (let index = 0; index < 50; index += 1) {
    const next = lightness + step * index;
    if (next < 0 || next > 1) break;
    candidate = fromHsl([hue, saturation, next]);
    if (surfaces.every((surface) => contrastRatio(candidate, surface) >= MINIMUM_CONTRAST)) {
      return toHex(candidate);
    }
  }

  // The hue cannot reach the ratio on its own. The extreme of the direction
  // is the best that can be done.
  const extreme = surfaceIsLight ? 0 : 1;
  return toHex(fromHsl([hue, saturation, extreme]));
}

/** A colour as a hex string. */
export function toHex([r, g, b]: Rgb): string {
  const part = (value: number): string =>
    Math.max(0, Math.min(255, Math.round(value))).toString(16).padStart(2, '0');
  return `#${part(r)}${part(g)}${part(b)}`;
}
