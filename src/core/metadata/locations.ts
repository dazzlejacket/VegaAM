/**
 * Location parsing for concert metadata.
 *
 * SiriusXM concert strings usually look like "Boston MA", "Boston, MA",
 * "New York NY", "Los Angeles CA 2020" or "at Fenway Park, Boston MA".
 */

const US_STATES: Record<string, string> = {
  AL: 'Alabama', AK: 'Alaska', AZ: 'Arizona', AR: 'Arkansas', CA: 'California',
  CO: 'Colorado', CT: 'Connecticut', DE: 'Delaware', FL: 'Florida', GA: 'Georgia',
  HI: 'Hawaii', ID: 'Idaho', IL: 'Illinois', IN: 'Indiana', IA: 'Iowa',
  KS: 'Kansas', KY: 'Kentucky', LA: 'Louisiana', ME: 'Maine', MD: 'Maryland',
  MA: 'Massachusetts', MI: 'Michigan', MN: 'Minnesota', MS: 'Mississippi',
  MO: 'Missouri', MT: 'Montana', NE: 'Nebraska', NV: 'Nevada', NH: 'New Hampshire',
  NJ: 'New Jersey', NM: 'New Mexico', NY: 'New York', NC: 'North Carolina',
  ND: 'North Dakota', OH: 'Ohio', OK: 'Oklahoma', OR: 'Oregon', PA: 'Pennsylvania',
  RI: 'Rhode Island', SC: 'South Carolina', SD: 'South Dakota', TN: 'Tennessee',
  TX: 'Texas', UT: 'Utah', VT: 'Vermont', VA: 'Virginia', WA: 'Washington',
  WV: 'West Virginia', WI: 'Wisconsin', WY: 'Wyoming', DC: 'District of Columbia',
};

const CANADA: Record<string, string> = {
  AB: 'Alberta', BC: 'British Columbia', MB: 'Manitoba', NB: 'New Brunswick',
  NL: 'Newfoundland and Labrador', NS: 'Nova Scotia', NT: 'Northwest Territories',
  NU: 'Nunavut', ON: 'Ontario', PE: 'Prince Edward Island', QC: 'Quebec',
  SK: 'Saskatchewan', YT: 'Yukon',
};

export const STATE_CODES = new Set([...Object.keys(US_STATES), ...Object.keys(CANADA)]);

const STATE_NAME_LOOKUP = new Map<string, string>();
for (const [code, name] of Object.entries(US_STATES)) STATE_NAME_LOOKUP.set(name.toLowerCase(), code);
for (const [code, name] of Object.entries(CANADA)) STATE_NAME_LOOKUP.set(name.toLowerCase(), code);

/** Common US city names that appear in SiriusXM concert metadata. */
export const KNOWN_CITIES = [
  'New York', 'Los Angeles', 'Chicago', 'Houston', 'Phoenix', 'Philadelphia',
  'San Antonio', 'San Diego', 'Dallas', 'San Jose', 'Austin', 'Jacksonville',
  'San Francisco', 'Seattle', 'Denver', 'Boston', 'Nashville', 'Portland',
  'Las Vegas', 'Detroit', 'Memphis', 'Baltimore', 'Milwaukee', 'Albuquerque',
  'Tucson', 'Fresno', 'Sacramento', 'Kansas City', 'Atlanta', 'Miami',
  'Cleveland', 'Pittsburgh', 'St. Louis', 'Cincinnati', 'Charlotte', 'Orlando',
  'Indianapolis', 'Columbus', 'Newark', 'Buffalo', 'Brooklyn',
  'Queens', 'Honolulu', 'Anchorage', 'Minneapolis', 'Salt Lake City', 'Omaha',
  'Raleigh', 'Richmond', 'Louisville', 'Tampa', 'New Orleans', 'Salt Lake',
];

export interface LocationParts {
  city?: string;
  region?: string;
  venue?: string;
  raw: string;
}

const RE_AT = new RegExp('(?:^|\\s)(?:at|@)\\s+(.+)$', 'i');
const RE_STATE_SUFFIX = new RegExp('^(.*),\\s*([A-Z]{2})$');

/**
 * Parse a location fragment.
 *
 * The fragment should already have dates and live descriptors removed.
 */
export function parseLocation(fragment: string): LocationParts {
  const raw = fragment.trim();
  let work = raw.replace(/\s+/g, ' ').trim();
  if (!work) return { raw };

  let venue: string | undefined;

  // "at Fenway Park" / "@ The Fillmore"
  const atMatch = RE_AT.exec(work);
  if (atMatch && atMatch[1]) {
    venue = atMatch[1].trim().replace(/[,\s]+$/, '');
    work = work.slice(0, atMatch.index).trim().replace(/[,\s]+$/, '');
  }

  // Remove trailing state name / code.
  let region: string | undefined;
  const parts = work.split(/[,\s]+/).filter(Boolean);

  if (parts.length > 0) {
    const last = parts[parts.length - 1]!;
    const lastUpper = last.toUpperCase();
    if (STATE_CODES.has(lastUpper)) {
      region = lastUpper;
      parts.pop();
    } else {
      const byName = STATE_NAME_LOOKUP.get(last.toLowerCase());
      if (byName) {
        region = byName;
        parts.pop();
      }
    }
  }

  let city = parts.join(' ').replace(/[,\s]+$/, '').trim();
  city = city.replace(/^[,-\s]+/, '').trim();

  // A venue may itself be "City, REGION" ("Live at Boston, MA").
  if (venue) {
    const suffix = RE_STATE_SUFFIX.exec(venue);
    if (suffix) {
      const venueCity = suffix[1]!.trim();
      const venueRegion = suffix[2]!.toUpperCase();
      if (!city) {
        city = venueCity;
        region = region ?? venueRegion;
        venue = undefined;
      }
    }
  }

  // Remove street-like noise ("123 Main St") - keep venue-like names.
  if (!venue && /\d{1,5}\s+[A-Z]/.test(city)) {
    venue = city;
    city = '';
  }

  if (!city) return { raw, ...(venue ? { venue } : {}), ...(region ? { region } : {}) };
  return { raw, city, ...(venue ? { venue } : {}), ...(region ? { region } : {}) };
}

/** Format location parts the way they are displayed / scrobbled. */
export function formatLocation(parts: LocationParts): string | undefined {
  if (parts.venue && !parts.city) return parts.venue;
  if (parts.city && parts.region) return `${parts.city}, ${parts.region}`;
  if (parts.city) return parts.city;
  return parts.venue;
}
