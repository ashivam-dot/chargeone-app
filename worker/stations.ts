import { DC_THRESHOLD_KW, DC_TYPES, type ConnectorType, type Dataset } from '../src/data/model.ts';
import type { Env } from './env.ts';

export interface StationPoint {
  id: string;
  lat: number;
  lng: number;
  name: string;
  operator: string | null;
  maxKw: number | null;
  connectors: ConnectorType[];
  /** Has DC fast charging, judged the way the app's data import does. */
  dc: boolean;
}

let cache: { map: Map<string, StationPoint>; loadedAt: number } | null = null;
const TTL_MS = 10 * 60 * 1000;

/** Stations, read from the same static dataset the app ships. */
export async function stationIndex(env: Env): Promise<Map<string, StationPoint>> {
  if (cache && Date.now() - cache.loadedAt < TTL_MS) return cache.map;
  const res = await env.ASSETS.fetch(new Request('https://assets.local/data/stations.json'));
  if (!res.ok) throw new Error(`stations.json unavailable (${res.status})`);
  const data = (await res.json()) as Dataset;
  const map = new Map<string, StationPoint>();
  for (const s of data.stations) {
    const connectors = [...new Set(s.connectors.map((c) => c.type))];
    map.set(s.id, {
      id: s.id,
      lat: s.lat,
      lng: s.lng,
      name: s.name,
      operator: s.operator,
      maxKw: s.maxKw,
      connectors,
      dc: s.speed === 'dc' || connectors.some((c) => DC_TYPES.has(c)) || (s.maxKw ?? 0) > DC_THRESHOLD_KW,
    });
  }
  cache = { map, loadedAt: Date.now() };
  return map;
}

/** Stations within radiusKm of a point, nearest first. */
export async function stationsNear(env: Env, at: { lat: number; lng: number }, radiusKm: number, dcOnly: boolean): Promise<Array<StationPoint & { km: number }>> {
  const out: Array<StationPoint & { km: number }> = [];
  for (const s of (await stationIndex(env)).values()) {
    if (dcOnly && !s.dc) continue;
    const km = distanceMetres(at, s) / 1000;
    if (km <= radiusKm) out.push({ ...s, km });
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
