// Telangana's government list of EV charging stations: TGREDCO's CSV on the Telangana Open Data Portal
// (data.telangana.gov.in, Government Open Data License - India, data as of April 2024). Free, no key, no
// scraping: the portal's DKAN API gives the file's download URL.
//
// It is a list of where chargers are, typed in by hand, so the adapter:
// - repairs coordinates: "17.59," and "78. 43287", "17.30509N", DMS ("17°20'43.5\"N"), degrees and
//   decimal minutes ("17°28.673'N") and the D.MMSS form some rows use ("17.2417.0N" = 17°24'17.0");
//   swapped latitude and longitude are put back;
// - keeps only points inside Telangana's bounding box (a typo can put a row in another state);
// - drops two- and three-wheeler, battery-swap, bus-depot and metro rows, and chargers at homes or listed
//   under a person (the owner column is never published, and a station name is shown only when it reads
//   like a business or a place: a host's own name is not);
// - merges rows of one operator within LISTED_MERGE_METRES: the list has one row per charge point
//   ("Hotel X (C1)", "Hotel X (C2)");
// - says nothing it can't know: no connectors, vehicle class only from the name or a stated kW, status
//   unknown, never verified. Confidence keeps such listings under the planner's line (confidence.ts).
// The data is never uploaded to OpenStreetMap.
import { existsSync } from 'node:fs';
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { CACHE_DIR, USER_AGENT } from '../config.ts';
import { LICENCES, TGREDCO_DATASET_URL } from '../licences.ts';
import { round6 } from '../lib/geo.ts';
import { groupNearby, LISTED_MERGE_METRES } from '../lib/listed.ts';
import { knownOperator, SWAP_OPERATORS, TWO_WHEELER_OPERATORS } from '../lib/operators.ts';
import { inferVehicles, NO_VEHICLE_FLAGS } from '../lib/vehicle.ts';
import type { Adapter, AdapterResult, HealthReport, Rejection, SourceRecord } from '../types.ts';

export const TGREDCO_DATASET_ID = 'dc299957-9d16-4345-957e-ee93a31b6011';
const METASTORE = `https://data.telangana.gov.in/api/1/metastore/schemas/dataset/items/${TGREDCO_DATASET_ID}`;
export const tgredcoDir = () => join(CACHE_DIR, 'tgredco');

/** The data is "as on April 2024" (the dataset's `modified`). */
export const TGREDCO_AS_OF = '2024-04-01T00:00:00Z';
/** Fewer rows than this means a broken or truncated download (551 in the April 2024 file). */
export const TGREDCO_MIN_RAW = 400;
export { LISTED_MERGE_METRES };
/** Telangana's extent with a small margin. Points outside are typos (the state is assigned from shapes later). */
export const TELANGANA_BBOX = { minLat: 15.75, maxLat: 20.0, minLng: 77.1, maxLng: 81.4 };

export interface TgredcoRaw {
  file: string;
  csv: string;
}

/** RFC 4180 CSV: quoted fields may hold commas, newlines and doubled quotes. */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  const s = text.replace(/^﻿/, '');
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (quoted) {
      if (ch === '"' && s[i + 1] === '"') {
        field += '"';
        i++;
      } else if (ch === '"') quoted = false;
      else field += ch;
    } else if (ch === '"' && field === '') quoted = true;
    else if (ch === ',') {
      row.push(field);
      field = '';
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && s[i + 1] === '\n') i++;
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else field += ch;
  }
  if (field !== '' || row.length) {
    row.push(field);
    rows.push(row);
  }
  return rows.filter((r) => r.some((f) => f.trim() !== ''));
}

/**
 * One coordinate from the list's many hand-typed forms, in decimal degrees, or null when it can't be read.
 * Degrees-minutes-seconds and degrees-decimal-minutes need the degree sign; "17.2417.0" (two dots) is
 * D.MMSS.s. A bare decimal may carry stray spaces, commas, quotes or a hemisphere letter.
 */
export function parseCoordinate(raw: string | null | undefined): number | null {
  if (raw == null) return null;
  let s = raw.replace(/[′’]/g, "'").replace(/[″”]/g, '"').trim();
  if (!s || /^(na|n\/a|nil|-+|0)$/i.test(s)) return null;
  const hemi = s.match(/([NSEW])\W*$/i)?.[1]?.toUpperCase();
  const sign = hemi === 'S' || hemi === 'W' ? -1 : 1;
  let value: number | null = null;
  if (s.includes('°')) {
    const nums = s.match(/\d+(?:\.\d+)?/g)?.map(Number) ?? [];
    const [deg, min = 0, sec = 0] = nums;
    if (deg === undefined || nums.length > 3 || min >= 60 || sec >= 60) return null;
    value = deg + min / 60 + sec / 3600;
  } else {
    s = s.replace(/[NSEW]\W*$/i, '').replace(/['",;]+/g, ' ').replace(/(\d)\s*\.\s*(\d)/g, '$1.$2').trim();
    const twoDots = s.match(/^(\d{1,3})\.(\d{2})(\d{2})\.(\d+)$/);
    if (twoDots) {
      const [, d, m, sec, frac] = twoDots;
      if (Number(m) >= 60 || Number(sec) >= 60) return null;
      value = Number(d) + Number(m) / 60 + Number(`${sec}.${frac}`) / 3600;
    } else if (/^\d{1,3}(\.\d+)?$/.test(s)) value = Number(s);
    else return null;
  }
  return value === null || !Number.isFinite(value) ? null : sign * value;
}

const inBox = (lat: number, lng: number) =>
  lat >= TELANGANA_BBOX.minLat && lat <= TELANGANA_BBOX.maxLat && lng >= TELANGANA_BBOX.minLng && lng <= TELANGANA_BBOX.maxLng;

/** A latitude/longitude pair inside Telangana, putting back a swapped pair; null when either is unreadable. */
export function telanganaPoint(latRaw: string, lngRaw: string): { lat: number; lng: number } | 'outside' | null {
  const a = parseCoordinate(latRaw);
  const b = parseCoordinate(lngRaw);
  if (a === null || b === null) return null;
  if (inBox(a, b)) return { lat: round6(a), lng: round6(b) };
  if (inBox(b, a)) return { lat: round6(b), lng: round6(a) };
  return 'outside';
}

// Chargers a car can't use, or that aren't public stations at all. Checked on the name and the owner.
const TWO_WHEELER = /\bather\b|\btwo[\s-]*wheel|\b2[\s-]*w(heeler)?\b|\bscooter|\be-?bike/i;
const THREE_WHEELER = /\beto\s*motors\b|\bexponent\s*energy\b|\b(three|3)[\s-]*w(heeler)?\b|\be-?auto\b|rickshaw/i;
const SWAP = /\bsun\s*mobility\b|\bswap(ping)?\b|battery\s*smart|\byuma\b/i;
const BUS = /\b(ts|tg|tgs)?\s*rtc\b|\bbus\s*(depot|stand|station)\b|\bdepot\b|\bfresh\s*bus\b|\bjubil?lee\s*bus/i;
const METRO = /\bmetro\b/i;
/** A charger at a home, or listed under a person ("Mr. X", "Smt. Y", "(Individual)", "(Domestic)"). */
const PERSON = /\b(domestic|individual|residence\s+of|house\s+of)\b|(^|[\s,(])(mr|mrs|ms|smt|shri|dr)\.?\s+[a-z]/i;
/** Places named after a person ("Dr. AS Rao Nagar", "Dr. BR Ambedkar Road") are not a person. */
const NAMED_PLACE = /\b(mr|mrs|ms|smt|shri|dr)\.?\s+(?:[a-z.]+\s+){0,3}?(nagar|road|rd|marg|colony|street|circle|chowk|hospital|bhavan|statue|university|college)\b/gi;
const PRIVATE_PERSON = { test: (text: string) => PERSON.test(text.replace(NAMED_PLACE, ' ')) };

/**
 * Words that make a station name a business or a place (a fuel station, hotel, mall, railway station,
 * office). Names without one may be the host's own name: those stay unnamed.
 */
const PLACE_NAME =
  /\b(fs|f\s*s|filling|fills|fuels?|petro\w*|service\s*station|bp|iocl?|bpcl|hpcl|indian\s*oil|bharat|hindustan|motors?|cars?|auto|autolines|automotive|auto\s*mobiles?|hyundai|honda|maruti|kia|mahindra|showroom|hotels?|resorts?|restaurant|dhaba|food|court|cafe|mall|market|bazaa?r|plaza|complex|centre|center|convention|stadium|hospital|college|university|school|institut\w*|office|rta|bhavan|bhawan|building|park|parking|railway|station|substation|junction|airport|metro|temple|ashra?m\w*|club|tower|hub|ltd|limited|pvt|corporation|enterprises|carriers|estates?|township|works|croma|silks|marriott|fairfield|green\s*drive|westside|tgredco|tsiic|tsird|ghmc|hmda|nh\s*\d+|highway|road|x\s*roads?|circle|chowk|bridge|toll|residency|inn|lodge|suites?|gardens?|colony|nagar)\b/i;
/** "B. Brahmaiah & Co.", "P. Narasimha Reddy & Sons": a business named after its owner still names a person. */
const OWNER_NAMED = /\b[A-Z]\.\s?(?!(?:Nagar|Filling|Road|Colony|Station)\b)[A-Z][a-z]{2,}|&\s*sons\b/;
/** Short all-capital names are organisations ("NSIC", "ESCI", "TUFIDC"). */
const ACRONYM = /^[A-Z]{3,8}$/;

const words = (s: string) => s.toLowerCase().match(/\p{L}{3,}/gu) ?? [];

/**
 * The station name when it names a business or a place, else null (the app then shows "<operator>
 * charger"). A name that is only the locality ("Begumpet", every word also in the address) is a place.
 */
function shownName(name: string, where: string): string | null {
  const n = name.replace(/\s+/g, ' ').trim();
  if (!n || PRIVATE_PERSON.test(n) || OWNER_NAMED.test(n)) return null;
  const local = new Set(words(where));
  const onlyLocality = words(n).length > 0 && words(n).every((w) => local.has(w));
  if (!PLACE_NAME.test(n) && !ACRONYM.test(n) && !onlyLocality) return null;
  return n.slice(0, 120);
}

function shownAddress(address: string): string | null {
  const a = address.replace(/\s+/g, ' ').replace(/(,\s*)+/g, ', ').replace(/^[,\s]+|[,\s]+$/g, '').trim();
  if (!a || PRIVATE_PERSON.test(a)) return null;
  return a.slice(0, 240);
}

/** "120 KW", "DC 30 KW" in the station name. */
function statedKw(name: string): number | null {
  const m = name.match(/(\d{1,3}(?:\.\d+)?)\s*kw\b/i);
  const kw = m ? Number(m[1]) : null;
  return kw !== null && kw > 0 && kw <= 600 ? kw : null;
}

interface Row {
  sno: string;
  name: string;
  district: string;
  address: string;
  lat: string;
  lng: string;
  owner: string;
}

function rowsOf(csv: string): Row[] {
  const [header, ...rows] = parseCsv(csv);
  const col = (re: RegExp) => header.findIndex((h) => re.test(h));
  const at = {
    sno: col(/^s\.?\s*no/i),
    name: col(/^name of the ev/i),
    district: col(/^district/i),
    address: col(/^address/i),
    lat: col(/^lat/i),
    lng: col(/^lon/i),
    owner: col(/owning/i),
  };
  if (Object.values(at).some((i) => i < 0)) throw new Error(`TGREDCO CSV: unexpected header ${JSON.stringify(header)}`);
  return rows.map((r) => {
    const get = (i: number) => (r[i] ?? '').trim();
    return { sno: get(at.sno), name: get(at.name), district: get(at.district), address: get(at.address), lat: get(at.lat), lng: get(at.lng), owner: get(at.owner) };
  });
}

/** Why a row is not a public car charger, or null when it may be one. */
function dropReason(row: Row): Rejection['reason'] | null {
  const text = `${row.name} | ${row.owner}`;
  const op = knownOperator(row.owner);
  if (PRIVATE_PERSON.test(text)) return 'private-individual';
  if ((op && SWAP_OPERATORS.has(op)) || SWAP.test(text)) return 'battery-swap';
  if ((op && TWO_WHEELER_OPERATORS.has(op)) || TWO_WHEELER.test(text)) return 'not-car';
  if (THREE_WHEELER.test(text)) return 'not-car';
  if (BUS.test(text)) return 'bus';
  if (METRO.test(row.owner)) return 'metro';
  return null;
}

export function tgredcoToCanonical(raw: TgredcoRaw): AdapterResult {
  const rows = rowsOf(raw.csv);
  const rejected: Rejection[] = [];
  const kept: Array<{ row: Row; id: string; lat: number; lng: number; operator: string | null }> = [];
  const seen = new Set<string>();
  rows.forEach((row, i) => {
    const id = `tg-${/^\d+$/.test(row.sno) && !seen.has(row.sno) ? row.sno : `r${i + 1}`}`;
    seen.add(row.sno);
    const reason = dropReason(row);
    if (reason) return void rejected.push({ sourceId: id, reason, quarantine: false });
    const point = telanganaPoint(row.lat, row.lng);
    if (point === null) return void rejected.push({ sourceId: id, reason: 'no-coordinates', quarantine: false });
    if (point === 'outside') return void rejected.push({ sourceId: id, reason: 'outside-state', quarantine: false });
    kept.push({ row, id, ...point, operator: knownOperator(row.owner) });
  });

  // One station per operator within LISTED_MERGE_METRES (rows are charge points). Unknown operators only
  // join other unknown-operator rows: null is not a wildcard.
  const records: SourceRecord[] = [];
  for (const group of groupNearby(kept, LISTED_MERGE_METRES)) {
    const [first, ...rest] = group;
    for (const r of rest) rejected.push({ sourceId: r.id, reason: 'duplicate-listing', quarantine: false });
    const name = group.map((g) => shownName(g.row.name, `${g.row.address} ${g.row.district}`)).find((n) => n !== null) ?? null;
    const stationKw = group.reduce<number | null>((acc, g) => {
      const kw = statedKw(g.row.name);
      return kw === null ? acc : Math.max(acc ?? 0, kw);
    }, null);
    const flags = ['govt-listed', 'location-only'];
    if (group.length > 1) flags.push(`listed-${group.length}-times`);
    records.push({
      source: 'tgredco',
      sourceId: first.id,
      url: TGREDCO_DATASET_URL,
      licence: 'GODL-India',
      observedAt: TGREDCO_AS_OF,
      verified: false,
      lat: first.lat,
      lng: first.lng,
      name,
      operator: first.operator,
      operatorMethod: first.operator ? 'mapped' : null,
      evses: [],
      points: null,
      stationKw,
      hours: null,
      price: null,
      access: 'unknown',
      membershipRequired: null,
      address: shownAddress(first.row.address),
      stateHint: 'Telangana',
      website: null,
      vehicles: inferVehicles({ explicit: NO_VEHICLE_FLAGS, connectors: [], operator: first.operator, name: group.map((g) => g.row.name).join(' / '), stationKw }),
      batterySwap: null,
      status: 'unknown',
      flags,
      snapshotAt: TGREDCO_AS_OF,
    });
  }
  records.sort((a, b) => a.sourceId.localeCompare(b.sourceId, 'en', { numeric: true }));
  return { records, rejected, rawCount: rows.length, snapshotAt: TGREDCO_AS_OF };
}

export function tgredcoHealth(result: AdapterResult): HealthReport {
  const problems: string[] = [];
  if (result.rawCount < TGREDCO_MIN_RAW) problems.push(`only ${result.rawCount} rows (expected at least ${TGREDCO_MIN_RAW})`);
  if (result.records.length < result.rawCount * 0.3) problems.push(`only ${result.records.length} of ${result.rawCount} rows usable`);
  if (result.records.some((r) => r.verified || r.licence !== 'GODL-India')) problems.push('a record claims verification or another licence');
  return { ok: problems.length === 0, problems };
}

/** The newest cached CSV, or a new download through the portal's DKAN metastore (no key, no scraping). */
async function fetchTgredco(refresh: boolean): Promise<TgredcoRaw> {
  const dir = tgredcoDir();
  const cached = existsSync(dir) ? (await readdir(dir)).filter((f) => f.toLowerCase().endsWith('.csv')).sort() : [];
  if (!refresh && cached.length) {
    const file = cached.at(-1)!;
    return { file, csv: await readFile(join(dir, file), 'utf8') };
  }
  if (!refresh) throw new Error(`No cached TGREDCO CSV in ${dir}; run with --refresh=tgredco to download it`);
  const meta = (await (await fetch(METASTORE, { headers: { 'User-Agent': USER_AGENT } })).json()) as {
    license?: string;
    distribution?: Array<{ downloadURL?: string }>;
  };
  if (!/government open data licen[cs]e/i.test(meta.license ?? '')) throw new Error(`TGREDCO dataset licence changed: ${meta.license}`);
  const url = meta.distribution?.find((d) => d.downloadURL?.toLowerCase().endsWith('.csv'))?.downloadURL;
  if (!url || !url.startsWith('https://data.telangana.gov.in/')) throw new Error('TGREDCO dataset has no CSV on data.telangana.gov.in');
  const res = await fetch(url, { headers: { 'User-Agent': USER_AGENT } });
  if (!res.ok) throw new Error(`TGREDCO CSV: HTTP ${res.status}`);
  const csv = await res.text();
  const file = decodeURIComponent(url.split('/').pop()!).replace(/[^\w.-]/g, '_');
  await mkdir(dir, { recursive: true });
  // Only adds files: an older download stays in the cache.
  if (!existsSync(join(dir, file))) await writeFile(join(dir, file), csv);
  return { file, csv };
}

export const tgredcoAdapter: Adapter<TgredcoRaw> = {
  key: 'tgredco',
  name: 'Telangana Open Data Portal (TGREDCO)',
  licence: LICENCES['GODL-India'],
  fetchRaw: ({ refresh }) => fetchTgredco(refresh),
  toCanonical: tgredcoToCanonical,
  health: tgredcoHealth,
};
