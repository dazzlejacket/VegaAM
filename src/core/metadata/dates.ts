/**
 * Date extraction helpers.
 *
 * SiriusXM concert broadcasts use a wide range of date notations:
 *   "October 1 Boston MA 2020", "10/01/2020", "10.01.20", "1 Oct 2020",
 *   "October 2020", "2020-10-01".
 *
 * The parser never invents a date: when only a year is known the result keeps
 * `precision: 'year'` and no ISO date is produced.
 */

export type DatePrecision = 'day' | 'month' | 'year' | 'none';

export interface DateParts {
  year?: number;
  month?: number;
  day?: number;
  precision: DatePrecision;
  /** ISO date when day precision is known. */
  iso?: string;
  /** Human readable US formatted date, e.g. "October 1, 2020". */
  text?: string;
}

const MONTHS: Record<string, number> = {
  january: 1, jan: 1,
  february: 2, feb: 2,
  march: 3, mar: 3,
  april: 4, apr: 4,
  may: 5,
  june: 6, jun: 6,
  july: 7, jul: 7,
  august: 8, aug: 8,
  september: 9, sep: 9, sept: 9,
  october: 10, oct: 10,
  november: 11, nov: 11,
  december: 12, dec: 12,
};

export const MONTH_NAMES = Object.keys(MONTHS).filter((m) => m.length === 3 || m.length > 4);

const MONTH_ALT = MONTH_NAMES.join('|');

const RE_ISO = /\b(\d{4})[-/](\d{1,2})[-/](\d{1,2})\b/;
const RE_SLASH = /\b(\d{1,2})\/(\d{1,2})\/(\d{2,4})\b/;
const RE_DOTTED = /\b(\d{1,2})\.(\d{1,2})\.(\d{2,4})\b/;
const RE_MONTH_DAY_YEAR = new RegExp(
  `\\b(${MONTH_ALT})\\.?\\s+(\\d{1,2})(?:st|nd|rd|th)?(?:,?\\s+(\\d{4}))?\\b`,
  'i',
);
const RE_DAY_MONTH_YEAR = new RegExp(
  `\\b(\\d{1,2})(?:st|nd|rd|th)?\\s+(${MONTH_ALT})\\.?(?:,?\\s+(\\d{4}))?\\b`,
  'i',
);
const RE_MONTH_YEAR = new RegExp(`\\b(${MONTH_ALT})\\.?\\s+(\\d{4})\\b`, 'i');
const RE_YEAR = /\b(19\d{2}|20\d{2})\b/;

function validDate(year: number, month: number, day: number): boolean {
  if (month < 1 || month > 12 || day < 1 || day > 31) return false;
  const d = new Date(Date.UTC(year, month - 1, day));
  return (
    d.getUTCFullYear() === year && d.getUTCMonth() === month - 1 && d.getUTCDate() === day
  );
}

/** Expand a two digit year ("20" -> 2020, "99" -> 1999). */
function expandYear(raw: string): number {
  const n = Number(raw);
  if (raw.length === 4) return n;
  return n < 70 ? 2000 + n : 1900 + n;
}

/** Format parts as a US style date string: "October 1, 2020". */
export function formatDateUS(parts: {
  year?: number;
  month?: number;
  day?: number;
}): string | undefined {
  if (!parts.month) return parts.year ? String(parts.year) : undefined;
  const monthName = new Date(Date.UTC(2000, parts.month - 1, 1)).toLocaleString('en-US', {
    month: 'long',
    timeZone: 'UTC',
  });
  if (!parts.day) return parts.year ? `${monthName} ${parts.year}` : monthName;
  if (!parts.year) return `${monthName} ${parts.day}`;
  return `${monthName} ${parts.day}, ${parts.year}`;
}

/** ISO date string for day-precision dates. */
export function toIso(parts: { year?: number; month?: number; day?: number }): string | undefined {
  if (!parts.year || !parts.month || !parts.day) return undefined;
  return `${String(parts.year).padStart(4, '0')}-${String(parts.month).padStart(2, '0')}-${String(
    parts.day,
  ).padStart(2, '0')}`;
}

export interface DateExtraction {
  parts: DateParts;
  /** The primary substring that produced the date. */
  matched: string;
  /**
   * All substrings that have to be removed from the working text.
   * A month/day pair may borrow a year that is located elsewhere in the
   * fragment ("October 1 Boston MA 2020"), therefore several substrings can
   * contribute to a single date.
   */
  matchedParts: string[];
}

/**
 * Find and remove a date from `text`.
 *
 * The month/day forms may carry their own year, otherwise a standalone year
 * later in the text is used ("October 1 Boston MA 2020").
 */
export function extractDate(
  text: string,
  order: 'MDY' | 'DMY' = 'MDY',
): DateExtraction | undefined {
  let work = text;

  // 1. Fully qualified dates: 2020-10-01
  const iso = RE_ISO.exec(work);
  if (iso) {
    const year = Number(iso[1]);
    const month = Number(iso[2]);
    const day = Number(iso[3]);
    if (validDate(year, month, day)) {
      return {
        parts: {
          year,
          month,
          day,
          precision: 'day',
          iso: toIso({ year, month, day }),
          text: formatDateUS({ year, month, day }),
        },
        matched: iso[0],
        matchedParts: [iso[0]],
      };
    }
  }

  // 2. Slash dates: 10/01/2020 or 1/10/2020
  const slash = RE_SLASH.exec(work);
  if (slash) {
    const a = Number(slash[1]);
    const b = Number(slash[2]);
    const year = expandYear(slash[3]!);
    const [month, day] = order === 'MDY' ? [a, b] : [b, a];
    if (validDate(year, month, day)) {
      return {
        parts: {
          year,
          month,
          day,
          precision: 'day',
          iso: toIso({ year, month, day }),
          text: formatDateUS({ year, month, day }),
        },
        matched: slash[0],
        matchedParts: [slash[0]],
      };
    }
    // Fall back to the other order when the preferred one is impossible.
    const [m2, d2] = order === 'MDY' ? [b, a] : [a, b];
    if (validDate(year, m2, d2)) {
      return {
        parts: {
          year,
          month: m2,
          day: d2,
          precision: 'day',
          iso: toIso({ year, month: m2, day: d2 }),
          text: formatDateUS({ year, month: m2, day: d2 }),
        },
        matched: slash[0],
        matchedParts: [slash[0]],
      };
    }
  }

  // 3. Dotted dates: 10.01.20
  const dotted = RE_DOTTED.exec(work);
  if (dotted) {
    const a = Number(dotted[1]);
    const b = Number(dotted[2]);
    const year = expandYear(dotted[3]!);
    const [month, day] = order === 'MDY' ? [a, b] : [b, a];
    if (validDate(year, month, day)) {
      return {
        parts: {
          year,
          month,
          day,
          precision: 'day',
          iso: toIso({ year, month, day }),
          text: formatDateUS({ year, month, day }),
        },
        matched: dotted[0],
        matchedParts: [dotted[0]],
      };
    }
  }

  // 4. "October 1 2020" / "October 1" (+ possibly a detached year)
  const mdy = RE_MONTH_DAY_YEAR.exec(work);
  const dmy = RE_DAY_MONTH_YEAR.exec(work);
  const monthFirst = mdy && (!dmy || (mdy.index ?? 0) <= (dmy.index ?? 0));

  if (monthFirst && mdy) {
    const month = MONTHS[mdy[1]!.toLowerCase().replace(/\.$/, '')];
    const day = Number(mdy[2]);
    let year = mdy[3] ? Number(mdy[3]) : undefined;
    let matched = mdy[0];
    const matchedParts: string[] = [mdy[0]];
    if (!year) {
      const rest = work.slice((mdy.index ?? 0) + mdy[0].length);
      const y = RE_YEAR.exec(rest);
      if (y) {
        year = Number(y[1]);
        matched = `${matched} ${y[0]}`;
        matchedParts.push(y[0]);
      }
    }
    if (month && day >= 1 && day <= 31 && (!year || validDate(year, month, day))) {
      const precision: DatePrecision = year ? 'day' : 'month';
      return {
        parts: {
          ...(year ? { year } : {}),
          month,
          day,
          precision,
          ...(year ? { iso: toIso({ year, month, day }) } : {}),
          text: formatDateUS({ ...(year ? { year } : {}), month, day }),
        },
        matched,
        matchedParts,
      };
    }
  }

  if (dmy && !monthFirst) {
    const day = Number(dmy[1]);
    const month = MONTHS[dmy[2]!.toLowerCase().replace(/\.$/, '')];
    let year = dmy[3] ? Number(dmy[3]) : undefined;
    let matched = dmy[0];
    const matchedParts: string[] = [dmy[0]];
    if (!year) {
      const rest = work.slice((dmy.index ?? 0) + dmy[0].length);
      const y = RE_YEAR.exec(rest);
      if (y) {
        year = Number(y[1]);
        matched = `${matched} ${y[0]}`;
        matchedParts.push(y[0]);
      }
    }
    if (month && day >= 1 && day <= 31 && (!year || validDate(year, month, day))) {
      const precision: DatePrecision = year ? 'day' : 'month';
      return {
        parts: {
          ...(year ? { year } : {}),
          month,
          day,
          precision,
          ...(year ? { iso: toIso({ year, month, day }) } : {}),
          text: formatDateUS({ ...(year ? { year } : {}), month, day }),
        },
        matched,
        matchedParts,
      };
    }
  }

  // 5. "October 2020" (month precision)
  const my = RE_MONTH_YEAR.exec(work);
  if (my) {
    const month = MONTHS[my[1]!.toLowerCase().replace(/\.$/, '')];
    const year = Number(my[2]);
    if (month && validDate(year, month, 1)) {
      return {
        parts: { year, month, precision: 'month', text: formatDateUS({ year, month }) },
        matched: my[0],
        matchedParts: [my[0]],
      };
    }
  }

  return undefined;
}

/** Find a standalone year and remove it from the text. */
export function extractYear(text: string): { year?: number; matched?: string } {
  const m = RE_YEAR.exec(text);
  if (!m) return {};
  return { year: Number(m[1]), matched: m[0] };
}

/** True when the string contains something that looks like a year. */
export function containsYear(text: string): boolean {
  return RE_YEAR.test(text);
}

/** True when the string contains something that looks like a calendar date. */
export function containsDate(text: string): boolean {
  return (
    RE_ISO.test(text) ||
    RE_SLASH.test(text) ||
    RE_DOTTED.test(text) ||
    RE_MONTH_DAY_YEAR.test(text) ||
    RE_DAY_MONTH_YEAR.test(text) ||
    RE_MONTH_YEAR.test(text)
  );
}

export { MONTHS };
