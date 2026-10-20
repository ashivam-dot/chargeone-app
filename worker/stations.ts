import type { Dataset } from '../src/data/model.ts';
import type { Env } from './env.ts';

export interface StationPoint {
  lat: number;
  lng: number;
  name: string;
}

let cache: { map: Map<string, StationPoint>; loadedAt: number } | null = null;
const TTL_MS = 10 * 60 * 1000;

/** Station coordinates, read from the same static dataset the app ships. */
export async function stationIndex(env: Env): Promise<Map<string, StationPoint>> {
  if (cache && Date.now() - cache.loadedAt < TTL_MS) return cache.map;
  const res = await env.ASSETS.fetch(new Request('https://assets.local/data/stations.json'));
  if (!res.ok) throw new Error(`stations.json unavailable (${res.status})`);
  const data = (await res.json()) as Dataset;
  const map = new Map<string, StationPoint>();
  for (const s of data.stations) map.set(s.id, { lat: s.lat, lng: s.lng, name: s.name });
  cache = { map, loadedAt: Date.now() };
  return map;
}

export function distanceMetres(a: { lat: number; lng: number }, b: { lat: number; lng: number }): number {
  const R = 6371000;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}
