// Overture Maps Places (https://overturemaps.org): places with category `ev_charging_station` in India,
// from the free public release on anonymous S3 (no account, no key, no scraping). The extract is made by
// pipeline/overture-extract.py (DuckDB) into data-cache/overture/places-ev-<release>.json; this adapter
// only reads that file.
//
// Places is CDLA Permissive 2.0, and each record names the datasets behind it with their own licence
// (Microsoft, Meta, Uberall, ... CDLA; Foursquare Apache-2.0; AllThePlaces CC0-1.0). The record keeps the
// licence and dataset (`origin`) of its primary source; a record with any source outside that list, or a
// licence we don't know, is refused. Attribution: licences.ts OVERTURE_ATTRIBUTION, the CDLA text and the
// Foursquare NOTICE ship with the ODbL dump (outputs.ts).
//
// It is a list of places, not of chargers: no plugs, no power, no status beyond "closed". So the adapter
// keeps only listings of a known car charging network, and drops Bolt.Earth (light-EV and AC points),
// Ather and other two-wheeler networks, battery swapping, and anything named AC-only. Records are
// location-only (LISTED_SOURCES): unverified, never planned through, and dropped where OSM, OCM or the
// TGREDCO list already place the charger (resolve.ts listedDuplicates). Never uploaded to OpenStreetMap.
import { existsSync } from 'node:fs';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { CACHE_DIR } from '../config.ts';
import { LICENCES, OVERTURE_CDLA_CONTRIBUTORS } from '../licences.ts';
import { round6 } from '../lib/geo.ts';
import { groupNearby, LISTED_MERGE_METRES } from '../lib/listed.ts';
import { knownOperator, SWAP_OPERATORS, TWO_WHEELER_OPERATORS } from '../lib/operators.ts';
import { canonicalState } from '../lib/states.ts';
import { inferVehicles, NO_VEHICLE_FLAGS } from '../lib/vehicle.ts';
import type { Adapter, AdapterResult, HealthReport, LicenceId, Rejection, SourceRecord } from '../types.ts';

export const overtureDir = () => join(CACHE_DIR, 'overture');

/** The record link: Overture has no page per place, so its Places guide. */
export const OVERTURE_PLACES_URL = 'https://docs.overturemaps.org/guides/places/';
/** Fewer places than this means a broken extract (388 in release 2026-10-21.0). */
export const OVERTURE_MIN_RAW = 250;
/** India with a margin; the extract already filters on country IN. */
const INDIA_BBOX = { minLat: 6, maxLat: 37.5, minLng: 68, maxLng: 97.5 };

export interface OvertureSource {
  property: string;
  dataset: string;
  license: string | null;
  record_id: string | null;
  update_time: string | null;
}

export interface OverturePlace {
  id: string;
  name: string | null;
  category: string | null;
  basic_category: string | null;
  confidence: number | null;
  operating_status: string | null;
  brand: string | null;
  websites: string[];
  address: string | null;
  locality: string | null;
  region: string | null;
  postcode: string | null;
  country: string | null;
  sources: OvertureSource[];
  lat: number;
  lng: number;
}

export interface OvertureRaw {
  file: string;
  release: string;
  places: OverturePlace[];
}

/** Datasets Overture credits for Places and the licences each may carry. Anything else is refused. */
const DATASET_LICENCES: ReadonlyMap<string, ReadonlySet<LicenceId>> = new Map<string, ReadonlySet<LicenceId>>([
  ...OVERTURE_CDLA_CONTRIBUTORS.map((d) => [d, new Set<LicenceId>(['CDLA-Permissive-2.0'])] as const),
  ['Overture', new Set<LicenceId>(['CDLA-Permissive-2.0'])],
  ['Foursquare', new Set<LicenceId>(['Apache-2.0'])],
  ['AllThePlaces', new Set<LicenceId>(['CC0-1.0'])],
]);

const LICENCE_IDS: Record<string, LicenceId> = {
  'CDLA-Permissive-2.0': 'CDLA-Permissive-2.0',
  'CC0-1.0': 'CC0-1.0',
  'Apache-2.0': 'Apache-2.0',
};

/** Networks whose public points are light-EV / AC (Bolt.Earth): no use to a car driver planning a trip. */
const AC_NETWORKS: ReadonlySet<string> = new Set(['Bolt.Earth']);
const TWO_WHEELER = /\bather\b|\btwo[\s-]*wheel|\b2[\s-]*w(heeler)?\b|\bscooter|\be-?bike|\bev\s*cycle/i;
const THREE_WHEELER = /\b(three|3)[\s-]*w(heeler)?\b|\be-?auto\b|rickshaw/i;
const SWAP = /\bswap(ping)?\b|battery\s*smart|sun\s*mobility/i;
const AC_ONLY = /\bAC\s*(only|charg)|\b(3\.3|7\.2|7\.4|11|22)\s*kw\b/i;
const CLOSED = /^(closed|permanently_closed)$/i;

const hostOf = (url: string): string | null => {
  try {
    return new URL(url).hostname;
  } catch {
    return null;
  }
};

/** The operator's site without tracking parameters, or null. */
function cleanWebsite(urls: string[]): string | null {
  for (const raw of urls) {
    try {
      const u = new URL(raw);
      if (u.protocol !== 'https:' && u.protocol !== 'http:') continue;
      u.search = '';
      u.hash = '';
      return u.toString().slice(0, 200);
    } catch {
      continue;
    }
  }
  return null;
}

/** The network: the website's host first (most reliable), then the brand, then the name. */
export function overtureOperator(p: Pick<OverturePlace, 'websites' | 'brand' | 'name'>): string | null {
  for (const w of p.websites) {
    const op = knownOperator(hostOf(w)?.replace(/\./g, ' '));
    if (op) return op;
  }
  return knownOperator(p.brand) ?? knownOperator(p.name);
}

/** The primary source (the one for the whole record) and its licence, or why the record is refused. */
function provenance(p: OverturePlace): { dataset: string; licence: LicenceId; updated: string | null } | null {
  if (!p.sources.length) return null;
  for (const s of p.sources) {
    const licence = s.license ? LICENCE_IDS[s.license] : undefined;
    if (!licence || !DATASET_LICENCES.get(s.dataset)?.has(licence)) return null;
  }
  const primary = p.sources.find((s) => s.property === '' && s.dataset !== 'Overture') ?? p.sources.find((s) => s.property === '') ?? p.sources[0];
  return { dataset: primary.dataset, licence: LICENCE_IDS[primary.license!], updated: primary.update_time };
}

/** Why a place is not a public car charger we may list, or null when it may be one. */
function dropReason(p: OverturePlace, operator: string | null): Rejection['reason'] | null {
  const text = [p.name, p.brand].filter(Boolean).join(' | ');
  if ((operator && SWAP_OPERATORS.has(operator)) || SWAP.test(text)) return 'battery-swap';
  if ((operator && TWO_WHEELER_OPERATORS.has(operator)) || TWO_WHEELER.test(text) || THREE_WHEELER.test(text)) return 'not-car';
  if ((operator && AC_NETWORKS.has(operator)) || AC_ONLY.test(text)) return 'ac-only';
  if (!operator) return 'car-unknown';
  return null;
}

const isoDate = (s: string | null): string | null => (s && Number.isFinite(Date.parse(s)) ? new Date(s).toISOString() : null);

export function overtureToCanonical(raw: OvertureRaw): AdapterResult {
  const snapshotAt = /^\d{4}-\d{2}-\d{2}/.test(raw.release) ? `${raw.release.slice(0, 10)}T00:00:00.000Z` : null;
  const rejected: Rejection[] = [];
  const kept: Array<{ place: OverturePlace; id: string; lat: number; lng: number; operator: string | null; prov: NonNullable<ReturnType<typeof provenance>> }> = [];
  const seen = new Set<string>();
  for (const place of raw.places) {
    const id = `ovt-${place.id}`;
    if (seen.has(id)) continue;
    seen.add(id);
    const prov = provenance(place);
    if (!prov) {
      rejected.push({ sourceId: id, reason: 'other-licence', quarantine: false });
      continue;
    }
    const { lat, lng } = place;
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
      rejected.push({ sourceId: id, reason: 'no-coordinates', quarantine: false });
      continue;
    }
    if (place.country !== 'IN' || lat < INDIA_BBOX.minLat || lat > INDIA_BBOX.maxLat || lng < INDIA_BBOX.minLng || lng > INDIA_BBOX.maxLng) {
      rejected.push({ sourceId: id, reason: 'outside-india', quarantine: false });
      continue;
    }
    if (place.operating_status && CLOSED.test(place.operating_status)) {
      rejected.push({ sourceId: id, reason: 'removed', quarantine: false });
      continue;
    }
    const operator = overtureOperator(place);
    const reason = dropReason(place, operator);
    if (reason) {
      rejected.push({ sourceId: id, reason, quarantine: false });
      continue;
    }
    kept.push({ place, id, lat: round6(lat), lng: round6(lng), operator, prov });
  }

  const records: SourceRecord[] = [];
  for (const group of groupNearby(kept, LISTED_MERGE_METRES)) {
    const [first, ...rest] = group;
    for (const r of rest) rejected.push({ sourceId: r.id, reason: 'duplicate-listing', quarantine: false });
    const p = first.place;
    const flags = ['places-listed', 'location-only'];
    if (group.length > 1) flags.push(`listed-${group.length}-times`);
    const observed = isoDate(first.prov.updated);
    const address = [p.address, p.locality, p.postcode].filter((x): x is string => Boolean(x?.trim())).join(', ');
    records.push({
      source: 'overture',
      sourceId: first.id,
      url: OVERTURE_PLACES_URL,
      licence: first.prov.licence,
      origin: first.prov.dataset,
      // Never later than the release: a source date can't postdate the snapshot holding it.
      observedAt: observed && snapshotAt && observed > snapshotAt ? snapshotAt : (observed ?? snapshotAt),
      verified: false,
      lat: first.lat,
      lng: first.lng,
      name: p.name?.replace(/\s+/g, ' ').trim().slice(0, 120) || null,
      operator: first.operator,
      operatorMethod: 'mapped',
      evses: [],
      points: null,
      stationKw: null,
      hours: null,
      price: null,
      access: 'unknown',
      membershipRequired: null,
      address: address ? address.slice(0, 240) : null,
      stateHint: canonicalState(p.region ?? ''),
      website: cleanWebsite(p.websites),
      vehicles: inferVehicles({ explicit: NO_VEHICLE_FLAGS, connectors: [], operator: first.operator, name: p.name, stationKw: null }),
      batterySwap: null,
      status: p.operating_status === 'temporarily_closed' ? 'temporarily_unavailable' : 'unknown',
      flags,
      snapshotAt,
    });
  }
  records.sort((a, b) => a.sourceId.localeCompare(b.sourceId));
  return { records, rejected, rawCount: raw.places.length, snapshotAt };
}

export function overtureHealth(result: AdapterResult): HealthReport {
  const problems: string[] = [];
  if (result.rawCount < OVERTURE_MIN_RAW) problems.push(`only ${result.rawCount} places (expected at least ${OVERTURE_MIN_RAW})`);
  if (result.records.length < result.rawCount * 0.2) problems.push(`only ${result.records.length} of ${result.rawCount} places usable`);
  const allowed = new Set<string>(['CDLA-Permissive-2.0', 'CC0-1.0', 'Apache-2.0']);
  if (result.records.some((r) => r.verified || !allowed.has(r.licence) || !r.origin)) problems.push('a record claims verification, another licence or no origin');
  return { ok: problems.length === 0, problems };
}

/** The newest cached extract. A new one comes from pipeline/overture-extract.py, never from here. */
async function fetchOverture(refresh: boolean): Promise<OvertureRaw> {
  const dir = overtureDir();
  const files = existsSync(dir) ? (await readdir(dir)).filter((f) => /^places-ev-.+\.json$/.test(f)).sort() : [];
  if (!files.length || refresh) {
    const how = 'uv run --with duckdb python -I pipeline/overture-extract.py';
    if (!files.length) throw new Error(`No Overture extract in ${dir}; make one with: ${how}`);
    console.warn(`  Overture is refreshed by ${how}; using the newest extract`);
  }
  const file = files.at(-1)!;
  const json = JSON.parse(await readFile(join(dir, file), 'utf8')) as { release: string; places: OverturePlace[] };
  return { file, release: json.release, places: json.places };
}

export const overtureAdapter: Adapter<OvertureRaw> = {
  key: 'overture',
  name: 'Overture Maps Places',
  licence: LICENCES['CDLA-Permissive-2.0'],
  fetchRaw: ({ refresh }) => fetchOverture(refresh),
  toCanonical: overtureToCanonical,
  health: overtureHealth,
};
