// Charger lookups for the API, read from the same static files the app ships.
//
// First choice is the sharded layout the data pipeline writes: aliases.json maps any id (legacy osm-/ocm-
// ids and retired c1_ ids) to the current stable c1_ id and that id to its geohash cell, and
// cells/<cell>.json lists the cell's chargers in a few fields. A lookup reads one or a few small cell
// files instead of all of stations.json. Deployments without those files fall back to stations.json.
import type { CellFile, CellRow } from '../src/data/compact.ts';
import { DC_THRESHOLD_KW, DC_TYPES, type ConnectorType, type Dataset } from '../src/data/model.ts';
import { boundsAround, cellsCovering } from '../src/shared/geohash.ts';
import type { Env } from './env.ts';

export interface StationPoint {
  /** The id the app uses for this charger (an osm-/ocm- id in stations.json). */
  id: string;
  /** Stable ChargeOne id; reports are stored against it. Equal to `id` on the stations.json fallback. */
  c1Id: string;
  lat: number;
  lng: number;
  name: string;
  operator: string | null;
  maxKw: number | null;
  connectors: ConnectorType[];
  /** Has DC fast charging, judged the way the app's data import does. */
  dc: boolean;
}

/** Ids the API accepts: stable c1_ ids and the legacy OpenStreetMap / Open Charge Map ids. */
export const STATION_ID = /^(c1_[a-z2-7]{12}|osm-[nwr]\d{1,15}|ocm-\d{1,10})$/;

interface AliasFile {
  version: string;
  aliases: Record<string, string>;
  legacy: Record<string, string>;
  cells: Record<string, string>;
}

interface Sharded {
  cells: string[];
  aliases: AliasFile;
}

const TTL_MS = 10 * 60 * 1000;
let legacyCache: { map: Map<string, StationPoint>; loadedAt: number } | null = null;
let shardedCache: { value: Sharded | null; loadedAt: number } | null = null;
const cellCache = new Map<string, { points: StationPoint[]; loadedAt: number }>();

const fresh = (c: { loadedAt: number } | null | undefined) => c !== null && c !== undefined && Date.now() - c.loadedAt < TTL_MS;

/** A static data file, or null when this deployment doesn't have it. */
async function asset<T>(env: Env, path: string): Promise<T | null> {
  const res = await env.ASSETS.fetch(new Request(`https://assets.local${path}`));
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`${path} unavailable (${res.status})`);
  return (await res.json()) as T;
}

/** Test hook: forget everything read so far. */
export function clearStationCaches(): void {
  legacyCache = null;
  shardedCache = null;
  cellCache.clear();
}

async function sharded(env: Env): Promise<Sharded | null> {
  if (fresh(shardedCache)) return shardedCache!.value;
  const [manifest, aliases] = await Promise.all([
    asset<{ shards?: Array<{ cell: string }> }>(env, '/data/manifest.json').catch(() => null),
    asset<AliasFile>(env, '/data/aliases.json').catch(() => null),
  ]);
  const value = manifest?.shards?.length && aliases?.cells && aliases.aliases ? { cells: manifest.shards.map((s) => s.cell), aliases } : null;
  shardedCache = { value, loadedAt: Date.now() };
  return value;
}

const fromCellRow = ([c1Id, id, lat, lng, name, operator, maxKw, connectors, dc]: CellRow): StationPoint => ({
  id,
  c1Id,
  lat,
  lng,
  name,
  operator,
  maxKw,
  connectors,
  dc: dc === 1,
});

async function cellPoints(env: Env, cell: string): Promise<StationPoint[]> {
  const cached = cellCache.get(cell);
  if (fresh(cached)) return cached!.points;
  const file = await asset<CellFile>(env, `/data/cells/${encodeURIComponent(cell)}.json`);
  if (!file) throw new Error(`cells/${cell}.json missing`);
  const points = file.rows.map(fromCellRow);
  cellCache.set(cell, { points, loadedAt: Date.now() });
  return points;
}

/** Every station from stations.json, by its id. The fallback, and what older deployments use. */
export async function stationIndex(env: Env): Promise<Map<string, StationPoint>> {
  if (fresh(legacyCache)) return legacyCache!.map;
  const data = await asset<Dataset>(env, '/data/stations.json');
  if (!data) throw new Error('stations.json unavailable (404)');
  const map = new Map<string, StationPoint>();
  for (const s of data.stations) {
    const connectors = [...new Set(s.connectors.map((c) => c.type))];
    map.set(s.id, {
      id: s.id,
      c1Id: s.id,
      lat: s.lat,
      lng: s.lng,
      name: s.name,
      operator: s.operator,
      maxKw: s.maxKw,
      connectors,
      dc: s.speed === 'dc' || connectors.some((c) => DC_TYPES.has(c)) || (s.maxKw ?? 0) > DC_THRESHOLD_KW,
    });
  }
  legacyCache = { map, loadedAt: Date.now() };
  return map;
}

/**
 * The current stable id for any id a client may send: a c1_ id, a retired c1_ id, or a legacy
 * osm-/ocm- id. Null when no charger has it. On the stations.json fallback, ids map to themselves.
 */
export async function resolveStationId(env: Env, id: string): Promise<string | null> {
  const s = await sharded(env);
  if (s) {
    const current = s.aliases.aliases[id] ?? id;
    return s.aliases.cells[current] ? current : null;
  }
  return (await stationIndex(env)).has(id) ? id : null;
}

/** One charger by any of its ids. */
export async function stationById(env: Env, id: string): Promise<StationPoint | null> {
  const s = await sharded(env);
  if (!s) return (await stationIndex(env)).get(id) ?? null;
  const current = s.aliases.aliases[id] ?? id;
  const cell = s.aliases.cells[current];
  if (!cell) return null;
  return (await cellPoints(env, cell)).find((p) => p.c1Id === current) ?? null;
}

/** Several chargers by id (for lists of reports); ids nobody has are left out. */
export async function stationsByIds(env: Env, ids: Iterable<string>): Promise<Map<string, StationPoint>> {
  const out = new Map<string, StationPoint>();
  for (const id of new Set(ids)) {
    const p = await stationById(env, id);
    if (p) out.set(id, p);
  }
  return out;
}

/** Stations within radiusKm of a point, nearest first. Reads only the cells the circle touches. */
export async function stationsNear(env: Env, at: { lat: number; lng: number }, radiusKm: number, dcOnly: boolean): Promise<Array<StationPoint & { km: number }>> {
  const s = await sharded(env);
  const pool = s
    ? (await Promise.all(cellsCovering(s.cells, boundsAround(at, radiusKm)).map((c) => cellPoints(env, c)))).flat()
    : (await stationIndex(env)).values();
  const out: Array<StationPoint & { km: number }> = [];
  for (const p of pool) {
    if (dcOnly && !p.dc) continue;
    const km = distanceMetres(at, p) / 1000;
    if (km <= radiusKm) out.push({ ...p, km });
  }
  return out.sort((a, b) => a.km - b.km);
}

export function distanceMetres(a: { lat: number; lng: number }, b: { lat: number; lng: number }): number {
  const R = 6371000;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}
