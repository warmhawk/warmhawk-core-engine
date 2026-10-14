/**
 * A lead's own time zone, for campaigns that send "in each lead's time zone" (10-14-26). Read from
 * whatever columns the lead's CSV had — they land in `Lead.customFields` under their own headers —
 * in this order:
 *
 *   1. A time zone column ("Time zone", "timezone", "tz"): an IANA name, or a common
 *      abbreviation such as EST, PT, CET or IST.
 *   2. Country plus State/Region/Province, for the countries that span several zones (US, Canada,
 *      Australia, and a default for Brazil, Mexico, Russia and Indonesia).
 *   3. Country alone, for single-zone countries.
 *   4. A well-known city on its own.
 *
 * Returns null when nothing matches; the caller falls back to the campaign's own zone. Pure lookup,
 * no I/O.
 */
import { isValidTimezone } from './sendSchedule';

/** Header spellings that hold each kind of value, after `normalizeKey`. */
const TIMEZONE_KEYS = ['timezone', 'tz', 'timezonename', 'leadtimezone', 'tzname'];
const COUNTRY_KEYS = ['country', 'countrycode', 'countryname', 'companycountry', 'locationcountry'];
const STATE_KEYS = [
  'state',
  'statecode',
  'stateprovince',
  'province',
  'region',
  'companystate',
  'locationstate',
];
const CITY_KEYS = ['city', 'companycity', 'locationcity', 'town'];

function normalizeKey(key: string): string {
  return key.toLowerCase().replace(/[^a-z0-9]/g, '');
}

function normalizeValue(value: string): string {
  return value
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '');
}

const ABBREVIATIONS: Record<string, string> = {
  est: 'America/New_York',
  edt: 'America/New_York',
  et: 'America/New_York',
  eastern: 'America/New_York',
  easterntime: 'America/New_York',
  cst: 'America/Chicago',
  cdt: 'America/Chicago',
  ct: 'America/Chicago',
  central: 'America/Chicago',
  centraltime: 'America/Chicago',
  mst: 'America/Denver',
  mdt: 'America/Denver',
  mt: 'America/Denver',
  mountain: 'America/Denver',
  mountaintime: 'America/Denver',
  pst: 'America/Los_Angeles',
  pdt: 'America/Los_Angeles',
  pt: 'America/Los_Angeles',
  pacific: 'America/Los_Angeles',
  pacifictime: 'America/Los_Angeles',
  akst: 'America/Anchorage',
  akdt: 'America/Anchorage',
  hst: 'Pacific/Honolulu',
  ast: 'America/Halifax',
  adt: 'America/Halifax',
  nst: 'America/St_Johns',
  gmt: 'Europe/London',
  bst: 'Europe/London',
  utc: 'UTC',
  wet: 'Europe/Lisbon',
  cet: 'Europe/Paris',
  cest: 'Europe/Paris',
  eet: 'Europe/Athens',
  eest: 'Europe/Athens',
  msk: 'Europe/Moscow',
  ist: 'Asia/Kolkata',
  pkt: 'Asia/Karachi',
  sgt: 'Asia/Singapore',
  hkt: 'Asia/Hong_Kong',
  jst: 'Asia/Tokyo',
  kst: 'Asia/Seoul',
  aest: 'Australia/Sydney',
  aedt: 'Australia/Sydney',
  acst: 'Australia/Adelaide',
  awst: 'Australia/Perth',
  nzst: 'Pacific/Auckland',
  nzdt: 'Pacific/Auckland',
  sast: 'Africa/Johannesburg',
  brt: 'America/Sao_Paulo',
};

/**
 * Countries: ISO code, then the zone (the most populous one for countries with several), then
 * names it goes by. Countries whose zone needs a state are in `REGIONS` too.
 */
const COUNTRIES: Array<[string, string, string[]]> = [
  ['US', 'America/New_York', ['usa', 'unitedstates', 'unitedstatesofamerica', 'america', 'us']],
  ['CA', 'America/Toronto', ['canada']],
  ['AU', 'Australia/Sydney', ['australia']],
  ['BR', 'America/Sao_Paulo', ['brazil', 'brasil']],
  ['MX', 'America/Mexico_City', ['mexico']],
  ['RU', 'Europe/Moscow', ['russia', 'russianfederation']],
  ['ID', 'Asia/Jakarta', ['indonesia']],
  [
    'GB',
    'Europe/London',
    [
      'uk',
      'unitedkingdom',
      'greatbritain',
      'england',
      'scotland',
      'wales',
      'northernireland',
      'britain',
    ],
  ],
  ['IE', 'Europe/Dublin', ['ireland']],
  ['PT', 'Europe/Lisbon', ['portugal']],
  ['ES', 'Europe/Madrid', ['spain', 'espana']],
  ['FR', 'Europe/Paris', ['france']],
  ['DE', 'Europe/Berlin', ['germany', 'deutschland']],
  ['NL', 'Europe/Amsterdam', ['netherlands', 'holland', 'thenetherlands']],
  ['BE', 'Europe/Brussels', ['belgium']],
  ['LU', 'Europe/Luxembourg', ['luxembourg']],
  ['CH', 'Europe/Zurich', ['switzerland']],
  ['AT', 'Europe/Vienna', ['austria']],
  ['IT', 'Europe/Rome', ['italy', 'italia']],
  ['DK', 'Europe/Copenhagen', ['denmark']],
  ['NO', 'Europe/Oslo', ['norway']],
  ['SE', 'Europe/Stockholm', ['sweden']],
  ['FI', 'Europe/Helsinki', ['finland']],
  ['IS', 'Atlantic/Reykjavik', ['iceland']],
  ['PL', 'Europe/Warsaw', ['poland']],
  ['CZ', 'Europe/Prague', ['czechia', 'czechrepublic']],
  ['SK', 'Europe/Bratislava', ['slovakia']],
  ['HU', 'Europe/Budapest', ['hungary']],
  ['SI', 'Europe/Ljubljana', ['slovenia']],
  ['HR', 'Europe/Zagreb', ['croatia']],
  ['RS', 'Europe/Belgrade', ['serbia']],
  ['RO', 'Europe/Bucharest', ['romania']],
  ['BG', 'Europe/Sofia', ['bulgaria']],
  ['GR', 'Europe/Athens', ['greece']],
  ['CY', 'Asia/Nicosia', ['cyprus']],
  ['MT', 'Europe/Malta', ['malta']],
  ['EE', 'Europe/Tallinn', ['estonia']],
  ['LV', 'Europe/Riga', ['latvia']],
  ['LT', 'Europe/Vilnius', ['lithuania']],
  ['UA', 'Europe/Kyiv', ['ukraine']],
  ['TR', 'Europe/Istanbul', ['turkey', 'turkiye']],
  ['IL', 'Asia/Jerusalem', ['israel']],
  ['AE', 'Asia/Dubai', ['uae', 'unitedarabemirates']],
  ['SA', 'Asia/Riyadh', ['saudiarabia', 'ksa']],
  ['QA', 'Asia/Qatar', ['qatar']],
  ['KW', 'Asia/Kuwait', ['kuwait']],
  ['BH', 'Asia/Bahrain', ['bahrain']],
  ['OM', 'Asia/Muscat', ['oman']],
  ['EG', 'Africa/Cairo', ['egypt']],
  ['MA', 'Africa/Casablanca', ['morocco']],
  ['NG', 'Africa/Lagos', ['nigeria']],
  ['GH', 'Africa/Accra', ['ghana']],
  ['KE', 'Africa/Nairobi', ['kenya']],
  ['ZA', 'Africa/Johannesburg', ['southafrica']],
  ['IN', 'Asia/Kolkata', ['india']],
  ['PK', 'Asia/Karachi', ['pakistan']],
  ['BD', 'Asia/Dhaka', ['bangladesh']],
  ['LK', 'Asia/Colombo', ['srilanka']],
  ['NP', 'Asia/Kathmandu', ['nepal']],
  ['CN', 'Asia/Shanghai', ['china', 'prc']],
  ['HK', 'Asia/Hong_Kong', ['hongkong']],
  ['TW', 'Asia/Taipei', ['taiwan']],
  ['JP', 'Asia/Tokyo', ['japan']],
  ['KR', 'Asia/Seoul', ['southkorea', 'korea', 'republicofkorea']],
  ['SG', 'Asia/Singapore', ['singapore']],
  ['MY', 'Asia/Kuala_Lumpur', ['malaysia']],
  ['TH', 'Asia/Bangkok', ['thailand']],
  ['VN', 'Asia/Ho_Chi_Minh', ['vietnam']],
  ['PH', 'Asia/Manila', ['philippines']],
  ['NZ', 'Pacific/Auckland', ['newzealand']],
  ['AR', 'America/Argentina/Buenos_Aires', ['argentina']],
  ['CL', 'America/Santiago', ['chile']],
  ['CO', 'America/Bogota', ['colombia']],
  ['PE', 'America/Lima', ['peru']],
  ['EC', 'America/Guayaquil', ['ecuador']],
  ['VE', 'America/Caracas', ['venezuela']],
  ['UY', 'America/Montevideo', ['uruguay']],
  ['PY', 'America/Asuncion', ['paraguay']],
  ['BO', 'America/La_Paz', ['bolivia']],
  ['CR', 'America/Costa_Rica', ['costarica']],
  ['PA', 'America/Panama', ['panama']],
  ['GT', 'America/Guatemala', ['guatemala']],
  ['DO', 'America/Santo_Domingo', ['dominicanrepublic']],
  ['PR', 'America/Puerto_Rico', ['puertorico']],
  ['JM', 'America/Jamaica', ['jamaica']],
];

/** State/province → zone, per country. Keys are normalized codes and names. */
const REGIONS: Record<string, Record<string, string>> = {
  US: regionTable({
    'America/New_York':
      'CT connecticut DE delaware FL florida GA georgia KY kentucky ME maine MD maryland MA massachusetts NH newhampshire NJ newjersey NY newyork NC northcarolina OH ohio PA pennsylvania RI rhodeisland SC southcarolina VT vermont VA virginia WV westvirginia DC districtofcolumbia washingtondc',
    'America/Detroit': 'MI michigan',
    'America/Indiana/Indianapolis': 'IN indiana',
    'America/Chicago':
      'AL alabama AR arkansas IL illinois IA iowa KS kansas LA louisiana MN minnesota MS mississippi MO missouri NE nebraska ND northdakota OK oklahoma SD southdakota TN tennessee TX texas WI wisconsin',
    'America/Denver': 'CO colorado MT montana NM newmexico UT utah WY wyoming',
    'America/Boise': 'ID idaho',
    'America/Phoenix': 'AZ arizona',
    'America/Los_Angeles': 'CA california NV nevada OR oregon WA washington',
    'America/Anchorage': 'AK alaska',
    'Pacific/Honolulu': 'HI hawaii',
    'America/Puerto_Rico': 'PR puertorico',
  }),
  CA: regionTable({
    'America/Vancouver': 'BC britishcolumbia',
    'America/Edmonton': 'AB alberta',
    'America/Regina': 'SK saskatchewan',
    'America/Winnipeg': 'MB manitoba',
    'America/Toronto': 'ON ontario QC quebec',
    'America/Moncton': 'NB newbrunswick',
    'America/Halifax': 'NS novascotia PE princeedwardisland pei',
    'America/St_Johns': 'NL newfoundland newfoundlandandlabrador',
    'America/Whitehorse': 'YT yukon',
    'America/Yellowknife': 'NT northwestterritories',
    'America/Iqaluit': 'NU nunavut',
  }),
  AU: regionTable({
    'Australia/Sydney': 'NSW newsouthwales ACT australiancapitalterritory',
    'Australia/Melbourne': 'VIC victoria',
    'Australia/Brisbane': 'QLD queensland',
    'Australia/Adelaide': 'SA southaustralia',
    'Australia/Perth': 'WA westernaustralia',
    'Australia/Hobart': 'TAS tasmania',
    'Australia/Darwin': 'NT northernterritory',
  }),
  MX: regionTable({
    'America/Tijuana': 'BC bajacalifornia',
    'America/Hermosillo': 'SON sonora',
    'America/Mazatlan': 'SIN sinaloa BCS bajacaliforniasur NAY nayarit',
    'America/Cancun': 'ROO quintanaroo',
  }),
  BR: regionTable({
    'America/Manaus': 'AM amazonas RR roraima RO rondonia',
    'America/Cuiaba': 'MT matogrosso MS matogrossodosul',
    'America/Rio_Branco': 'AC acre',
  }),
};

/** Major cities, for leads with only a City column. */
const CITIES = regionTable({
  'America/New_York': 'newyork newyorkcity nyc boston philadelphia atlanta miami washington',
  'America/Chicago': 'chicago dallas houston austin sanantonio minneapolis nashville neworleans',
  'America/Denver': 'denver saltlakecity',
  'America/Phoenix': 'phoenix',
  'America/Los_Angeles': 'losangeles sanfrancisco sandiego seattle portland lasvegas sanjose',
  'America/Toronto': 'toronto montreal ottawa',
  'America/Vancouver': 'vancouver',
  'Europe/London': 'london manchester birmingham edinburgh glasgow',
  'Europe/Dublin': 'dublin',
  'Europe/Paris': 'paris',
  'Europe/Berlin': 'berlin munich hamburg frankfurt',
  'Europe/Amsterdam': 'amsterdam',
  'Europe/Madrid': 'madrid barcelona',
  'Europe/Rome': 'rome milan',
  'Europe/Stockholm': 'stockholm',
  'Asia/Dubai': 'dubai abudhabi',
  'Asia/Kolkata': 'mumbai delhi newdelhi bangalore bengaluru hyderabad chennai pune kolkata',
  'Asia/Singapore': 'singapore',
  'Asia/Tokyo': 'tokyo osaka',
  'Asia/Shanghai': 'shanghai beijing shenzhen',
  'Asia/Hong_Kong': 'hongkong',
  'Australia/Sydney': 'sydney canberra',
  'Australia/Melbourne': 'melbourne',
  'Australia/Brisbane': 'brisbane',
  'Australia/Perth': 'perth',
  'Pacific/Auckland': 'auckland wellington',
  'America/Sao_Paulo': 'saopaulo riodejaneiro',
  'America/Mexico_City': 'mexicocity',
});

function regionTable(byZone: Record<string, string>): Record<string, string> {
  const table: Record<string, string> = {};
  for (const [zone, names] of Object.entries(byZone)) {
    for (const name of names.split(' ')) table[normalizeValue(name)] = zone;
  }
  return table;
}

const COUNTRY_BY_NAME = new Map<string, { code: string; zone: string }>();
for (const [code, zone, names] of COUNTRIES) {
  COUNTRY_BY_NAME.set(normalizeValue(code), { code, zone });
  for (const name of names) COUNTRY_BY_NAME.set(name, { code, zone });
}

/** The first non-empty string among `keys` in `fields`. */
function pick(fields: Map<string, string>, keys: string[]): string | null {
  for (const key of keys) {
    const value = fields.get(key);
    if (value) return value;
  }
  return null;
}

/** An IANA name or a known abbreviation, as a zone; null otherwise. */
export function parseTimezoneValue(raw: string): string | null {
  const value = raw.trim();
  if (value.includes('/') && isValidTimezone(value)) return value;
  if (value.toUpperCase() === 'UTC') return 'UTC';
  return ABBREVIATIONS[normalizeValue(value)] ?? null;
}

/** The lead's own zone from its CSV columns, or null when it can't be told. */
export function detectLeadTimezone(customFields: unknown): string | null {
  if (!customFields || typeof customFields !== 'object' || Array.isArray(customFields)) return null;
  const fields = new Map<string, string>();
  for (const [key, value] of Object.entries(customFields as Record<string, unknown>)) {
    if (typeof value === 'string' && value.trim()) fields.set(normalizeKey(key), value.trim());
  }

  const zoneValue = pick(fields, TIMEZONE_KEYS);
  if (zoneValue) {
    const zone = parseTimezoneValue(zoneValue);
    if (zone) return zone;
  }

  const countryValue = pick(fields, COUNTRY_KEYS);
  const country = countryValue ? COUNTRY_BY_NAME.get(normalizeValue(countryValue)) : undefined;
  const stateValue = pick(fields, STATE_KEYS);
  const state = stateValue ? normalizeValue(stateValue) : null;

  if (country) {
    const regional = state ? REGIONS[country.code]?.[state] : undefined;
    if (regional) return regional;
    // A country that spans several zones, without a state that says which: the city may.
    if (REGIONS[country.code] && !['MX', 'BR'].includes(country.code)) {
      const city = pick(fields, CITY_KEYS);
      const cityZone = city ? CITIES[normalizeValue(city)] : undefined;
      return cityZone ?? null;
    }
    return country.zone;
  }

  // No country column: a US, Canadian or Australian state on its own, in that order.
  if (state) {
    for (const code of ['US', 'CA', 'AU']) {
      const regional = REGIONS[code][state];
      if (regional) return regional;
    }
  }

  const city = pick(fields, CITY_KEYS);
  return city ? (CITIES[normalizeValue(city)] ?? null) : null;
}
