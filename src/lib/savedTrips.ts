// Plus members can keep planned trips on the phone and reopen them without signal or a new trip plan.
import { haversineKm, type Coord } from '../planner/geometry.ts';
import type { RouteResponse } from './api.ts';
import { isObject, loadJson, saveJson } from './storage.ts';

export interface SavedPoint {
  name: string;
  lat: number;
  lng: number;
}

export interface SavedTrip {
  id: string;
  savedAt: string;
  from: SavedPoint;
  to: SavedPoint;
  response: RouteResponse;
}

const KEY = 'saved-trips';
/** Route points closer than this to the last kept one are dropped, which keeps a 500 km trip near 40 KB. */
const MIN_GAP_KM = 0.25;

const isPoint = (v: unknown): v is SavedPoint => isObject(v) && typeof v.name === 'string' && typeof v.lat === 'number' && typeof v.lng === 'number';

function isSavedTrip(v: unknown): v is SavedTrip {
  if (!isObject(v) || typeof v.id !== 'string' || typeof v.savedAt !== 'string' || !isPoint(v.from) || !isPoint(v.to)) return false;
  const r = v.response;
  if (!isObject(r) || !isObject(r.route)) return false;
  const { coords, distanceKm, durationMin } = r.route;
  return Array.isArray(coords) && coords.length >= 2 && typeof distanceKm === 'number' && typeof durationMin === 'number';
}

const isList = (v: unknown): v is SavedTrip[] => Array.isArray(v) && v.every(isSavedTrip);

export function thinRoute(coords: Coord[]): Coord[] {
  if (coords.length <= 2) return coords;
  const out: Coord[] = [coords[0]];
  for (let i = 1; i < coords.length - 1; i++) {
    if (haversineKm(out[out.length - 1], coords[i]) >= MIN_GAP_KM) out.push(coords[i]);
  }
  out.push(coords[coords.length - 1]);
  return out;
}

export function loadSavedTrips(): SavedTrip[] {
  return loadJson(KEY, [], isList);
}

export function saveTrip(from: SavedPoint, to: SavedPoint, response: RouteResponse, max: number): SavedTrip[] {
  const trip: SavedTrip = {
    id: response.tripId,
    savedAt: new Date().toISOString(),
    from: { name: from.name, lat: from.lat, lng: from.lng },
    to: { name: to.name, lat: to.lat, lng: to.lng },
    response: { ...response, route: { ...response.route, coords: thinRoute(response.route.coords) } },
  };
  const list = [trip, ...loadSavedTrips().filter((t) => t.id !== trip.id)].slice(0, max);
  saveJson(KEY, list);
  return list;
}

export function removeSavedTrip(id: string): SavedTrip[] {
  const list = loadSavedTrips().filter((t) => t.id !== id);
  saveJson(KEY, list);
  return list;
}
