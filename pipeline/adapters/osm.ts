// OpenStreetMap (ODbL). Today through Overpass, for occasional manual runs only: public Overpass refuses
// automated use, so this tries each endpoint once with an identifying User-Agent and otherwise keeps the
// cache. Scheduled runs should use the Geofabrik adapter (geofabrik.ts), which yields the same elements.
import type { ConnectorType } from '../../src/data/model.ts';
import { osmSocketType, parsePowerKw, safeUrl } from '../../src/data/normalize.ts';
import { cachedJson, USER_AGENT } from '../config.ts';
import { impliedPowerType } from '../lib/connectors.ts';
import { denied } from '../lib/denylist.ts';
import { inIndia, round6 } from '../lib/geo.ts';
import { canonicalOperator, knownOperator } from '../lib/operators.ts';
import { canonicalState } from '../lib/states.ts';
import { inferSwap, inferVehicles } from '../lib/vehicle.ts';
import { LICENCES } from '../licences.ts';
import type { Access, Adapter, AdapterResult, CanonicalEvse, HealthReport, Rejection, SourceRecord, Tri, VehicleFlags } from '../types.ts';

export interface OsmElement {
  type: 'node' | 'way' | 'relation';
  id: number;
  lat?: number;
  lon?: number;
  center?: { lat: number; lon: number };
  timestamp?: string;
  tags?: Record<string, string>;
}

export interface OsmRaw {
  /** OSM data timestamp reported by Overpass (`osm3s.timestamp_osm_base`), when known. */
  snapshotAt: string | null;
  fetchedAt: string | null;
  endpoint: string | null;
  elements: OsmElement[];
}

export const OVERPASS_ENDPOINTS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.private.coffee/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
];

export const OVERPASS_QUERY = `[out:json][timeout:180];
area["ISO3166-1"="IN"][admin_level=2]->.in;
nwr["amenity"="charging_station"](area.in);
out tags center meta;`;

/** Mapper names and ids aren't needed and are personal data: they are dropped before caching. */
function stripMeta(el: OsmElement & Record<string, unknown>): OsmElement {
  const { type, id, lat, lon, center, timestamp, tags } = el;
  return { type, id, lat, lon, center, timestamp, tags };
}

/**
 * Tries each endpoint once. A mirror can answer from a stale or partial database (one returned 200
 * objects from a July snapshot in Oct 2026), so a short answer counts as a failure and the next
 * endpoint is tried; the adapter health gate checks again before anything is published.
 */
export async function fetchOverpass(fetchImpl: typeof fetch = fetch, minElements = OSM_MIN_RAW): Promise<OsmRaw> {
  const problems: string[] = [];
  for (const endpoint of OVERPASS_ENDPOINTS) {
    try {
      const res = await fetchImpl(endpoint, {
        method: 'POST',
        headers: { 'User-Agent': USER_AGENT, 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
        body: new URLSearchParams({ data: OVERPASS_QUERY }),
        signal: AbortSignal.timeout(240_000),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = (await res.json()) as { elements?: Array<OsmElement & Record<string, unknown>>; osm3s?: { timestamp_osm_base?: string } };
      if (!Array.isArray(json.elements)) throw new Error('response has no elements array');
      if (json.elements.length < minElements) {
        throw new Error(`only ${json.elements.length} objects (snapshot ${json.osm3s?.timestamp_osm_base ?? 'unknown'})`);
      }
      return {
        snapshotAt: json.osm3s?.timestamp_osm_base ?? null,
        fetchedAt: new Date().toISOString(),
        endpoint,
        elements: json.elements.map(stripMeta),
      };
    } catch (err) {
      problems.push(`${endpoint}: ${String(err)}`);
    }
  }
  throw new Error(`All Overpass endpoints failed:\n  ${problems.join('\n  ')}`);
}

/** Accepts the current cache shape and the bare array the old importer wrote. */
export function readOsmCache(data: OsmRaw | OsmElement[]): OsmRaw {
  if (Array.isArray(data)) {
    const latest = data.reduce<string | null>((acc, e) => (e.timestamp && (!acc || e.timestamp > acc) ? e.timestamp : acc), null);
    return { snapshotAt: latest, fetchedAt: null, endpoint: null, elements: data.map((e) => stripMeta(e as OsmElement & Record<string, unknown>)) };
  }
  return data;
}

const yesNo = (v: string | undefined): Tri => {
  if (v === undefined) return null;
  if (v === 'yes' || v === 'designated') return true;
  if (v === 'no') return false;
  return null;
};

const anyOf = (...vals: Tri[]): Tri => (vals.includes(true) ? true : vals.includes(false) ? false : null);

function explicitVehicles(tags: Record<string, string>): VehicleFlags {
  return {
    car: yesNo(tags.motorcar),
    twoWheeler: anyOf(yesNo(tags.motorcycle), yesNo(tags.scooter), yesNo(tags.moped)),
    threeWheeler: anyOf(yesNo(tags.motor_rickshaw), yesNo(tags.auto_rickshaw)),
    bus: yesNo(tags.bus),
  };
}

/** `charging_station:battery_swapping=yes` (or the bare `battery_swapping`) marks a swap station. */
export function explicitSwap(tags: Record<string, string>): Tri {
  return anyOf(yesNo(tags['charging_station:battery_swapping']), yesNo(tags.battery_swapping));
}

function parseCount(raw: string | undefined): number | null {
  if (!raw || !/^\s*\d+\s*$/.test(raw)) return null;
  const n = Number.parseInt(raw, 10);
  return n > 0 && n < 1000 ? n : null;
}

/** `socket:<type>=<count>` and `socket:<type>:output=<power>`; power written in the count field is accepted. */
export function osmEvses(sourceId: string, tags: Record<string, string>): CanonicalEvse[] {
  const ids = new Set<string>();
  for (const key of Object.keys(tags)) {
    const m = key.match(/^socket:([a-z0-9_]+)(?::output)?$/i);
    if (m && m[1].toLowerCase() !== 'type') ids.add(m[1].toLowerCase());
  }
  const evses: CanonicalEvse[] = [];
  for (const id of [...ids].sort()) {
    const value = tags[`socket:${id}`];
    if (value === 'no' || value === '0') continue;
    const valueAsPower = value && !/^\s*\d+\s*$/.test(value) ? parsePowerKw(value) : null;
    const standard: ConnectorType = osmSocketType(id);
    evses.push({
      uid: `${sourceId}:${id}`,
      connectors: [
        {
          standard,
          powerType: impliedPowerType(standard),
          maxKw: parsePowerKw(tags[`socket:${id}:output`]) ?? valueAsPower,
          count: parseCount(value),
        },
      ],
    });
  }
  return evses;
}

/** A survey date beats an edit date: `check_date`, `survey:date`, or the newest `check_date:*`. */
export function osmObservedAt(tags: Record<string, string>, timestamp: string | undefined): { observedAt: string | null; verified: boolean } {
  const dates = Object.entries(tags)
    .filter(([k]) => k === 'check_date' || k === 'survey:date' || k.startsWith('check_date:'))
    .map(([, v]) => v.trim())
    .filter((v) => /^\d{4}-\d{2}(-\d{2})?$/.test(v))
    .sort();
  const survey = dates.at(-1);
  if (survey) return { observedAt: survey.length === 7 ? `${survey}-01` : survey, verified: true };
  return { observedAt: timestamp ?? null, verified: false };
}

function osmAccess(access: string): Access {
  if (access === 'customers' || access === 'permit') return 'customers';
  if (access === 'yes' || access === 'public' || access === 'designated' || access === 'permissive') return 'public';
  return 'unknown';
}

export function osmRecord(el: OsmElement): SourceRecord | Rejection {
  const sourceId = `osm-${el.type[0]}${el.id}`;
  const tags = el.tags ?? {};
  const lat = el.lat ?? el.center?.lat;
  const lng = el.lon ?? el.center?.lon;
  if (lat === undefined || lng === undefined) return { sourceId, reason: 'no-coordinates', quarantine: false };
  if (!inIndia(lat, lng)) return { sourceId, reason: 'outside-india', quarantine: false };
  const access = (tags.access ?? '').toLowerCase();
  if (access === 'private' || access === 'no') return { sourceId, reason: 'private', quarantine: false };
  // A node tagged from PlugShare or Google Maps (`operator=Plug Share`) may be copied from a closed
  // database: quarantined like OCM's Google-derived records (lib/denylist.ts; the build gate checks again).
  if (Object.values(tags).some((v) => denied(v))) return { sourceId, reason: 'denylisted-text', quarantine: true };

  const name = tags.name?.trim() || null;
  const mapped = canonicalOperator(tags.operator ?? tags.brand ?? tags.network);
  const inferred = mapped ? null : knownOperator(name);
  const operator = mapped ?? inferred;
  const evses = osmEvses(sourceId, tags);
  const stationKw = parsePowerKw(tags['charging_station:output']);
  const { observedAt, verified } = osmObservedAt(tags, el.timestamp);
  const addressParts = [
    [tags['addr:housenumber'], tags['addr:street']].filter(Boolean).join(' '),
    tags['addr:place'],
    tags['addr:suburb'],
    tags['addr:city'],
    tags['addr:state'],
    tags['addr:postcode'],
  ].filter((p): p is string => Boolean(p && p.trim()));
  const osmPath = `${el.type}/${el.id}`;
  const connectors = evses.flatMap((e) => e.connectors);
  const flags: string[] = [];
  if (!verified) flags.push('edit-date-only');

  return {
    source: 'osm',
    sourceId,
    url: `https://www.openstreetmap.org/${osmPath}`,
    editUrl: `https://www.openstreetmap.org/edit?${el.type}=${el.id}`,
    licence: 'ODbL-1.0',
    observedAt,
    verified,
    lat: round6(lat),
    lng: round6(lng),
    name,
    operator,
    operatorMethod: mapped ? 'mapped' : inferred ? 'inferred' : null,
    evses,
    points: parseCount(tags.capacity),
    stationKw,
    hours: tags.opening_hours?.trim() || null,
    price: tags.charge?.trim() || (tags.fee === 'no' ? 'Free' : null),
    access: osmAccess(access),
    membershipRequired: null,
    address: addressParts.length ? addressParts.join(', ') : null,
    stateHint: canonicalState(tags['addr:state']),
    website: safeUrl(tags.website ?? tags['contact:website'] ?? tags['operator:website']),
    vehicles: inferVehicles({ explicit: explicitVehicles(tags), connectors, operator, name, stationKw }),
    batterySwap: inferSwap(operator, name, explicitSwap(tags)),
    status: 'unknown',
    flags,
  };
}

export function osmToCanonical(raw: OsmRaw): AdapterResult {
  const records: SourceRecord[] = [];
  const rejected: Rejection[] = [];
  for (const el of raw.elements) {
    const r = osmRecord(el);
    if ('reason' in r) rejected.push(r);
    else records.push({ ...r, snapshotAt: raw.snapshotAt });
  }
  return { records, rejected, rawCount: raw.elements.length, snapshotAt: raw.snapshotAt };
}

/** India had 608 mapped charging stations in Oct 2026; far fewer means a broken download. */
export const OSM_MIN_RAW = 300;

export function osmHealth(result: AdapterResult): HealthReport {
  const problems: string[] = [];
  if (result.rawCount < OSM_MIN_RAW) problems.push(`only ${result.rawCount} OSM objects (expected at least ${OSM_MIN_RAW})`);
  const noCoords = result.rejected.filter((r) => r.reason === 'no-coordinates').length;
  if (result.rawCount > 0 && noCoords / result.rawCount > 0.05) problems.push(`${noCoords} OSM objects have no coordinates`);
  return { ok: problems.length === 0, problems };
}

export const OSM_CACHE = 'osm.json';

export const osmAdapter: Adapter<OsmRaw> = {
  key: 'osm',
  name: 'OpenStreetMap',
  licence: LICENCES['ODbL-1.0'],
  async fetchRaw({ refresh }) {
    try {
      return readOsmCache(await cachedJson<OsmRaw | OsmElement[]>(OSM_CACHE, refresh, () => fetchOverpass()));
    } catch (err) {
      if (!refresh) throw err;
      console.warn(`  Overpass refresh failed, keeping the cache: ${String(err)}`);
      return readOsmCache(await cachedJson<OsmRaw | OsmElement[]>(OSM_CACHE, false, () => fetchOverpass()));
    }
  },
  toCanonical: osmToCanonical,
  health: osmHealth,
};
