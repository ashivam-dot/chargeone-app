// Plus members can keep planned trips on the phone and reopen them without signal or a new trip plan.
import { haversineKm, type Coord } from '../planner/geometry.ts';
import type { RouteResponse } from './api.ts';
import { isObject, loadJson, removeJson, saveJson } from './storage.ts';

export interface SavedPoint {
  name: string;
  lat: number;
  lng: number;
}

export interface SavedTrip {
  id: string;
  savedAt: string;
  /** When the trip was first planned, which starts its free re-plan window. */
  plannedAt: string;
  from: SavedPoint;
  to: SavedPoint;
  response: RouteResponse;
}

const KEY = 'saved-trips';
/** Route points closer than this to the last kept one are dropped, which keeps a 500 km trip near 40 KB. */
const MIN_GAP_KM = 0.25;

const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const isDate = (v: unknown): v is string => typeof v === 'string' && !Number.isNaN(Date.parse(v));
const isPoint = (v: unknown): v is SavedPoint =>
  isObject(v) && typeof v.name === 'string' && finite(v.lat) && finite(v.lng) && Math.abs(v.lat) <= 90 && Math.abs(v.lng) <= 180;
const isCoord = (v: unknown): v is Coord => Array.isArray(v) && v.length >= 2 && v.length <= 3 && v.every(finite);

function isSavedTrip(v: unknown): v is SavedTrip {
  if (!isObject(v) || typeof v.id !== 'string' || !isDate(v.savedAt) || !isDate(v.plannedAt) || !isPoint(v.from) || !isPoint(v.to)) return false;
  const r = v.response;
  if (!isObject(r) || typeof r.tripId !== 'string' || !isObject(r.route)) return false;
  const { coords, distanceKm, durationMin } = r.route;
  return Array.isArray(coords) && coords.length >= 2 && coords.every(isCoord) && finite(distanceKm) && finite(durationMin);
}

export function thinRoute(coords: Coord[]): Coord[] {
  if (coords.length <= 2) return coords;
  const out: Coord[] = [coords[0]];
  for (let i = 1; i < coords.length - 1; i++) {
    if (haversineKm(out[out.length - 1], coords[i]) >= MIN_GAP_KM) out.push(coords[i]);
  }
  out.push(coords[coords.length - 1]);
  return out;
}

/** Damaged entries are skipped rather than discarding the whole list. */
export function loadSavedTrips(): SavedTrip[] {
  return loadJson(KEY, [], (v): v is unknown[] => Array.isArray(v)).filter(isSavedTrip);
}

/** Returns the new list, or null when the phone's storage is full or blocked. */
export function saveTrip(from: SavedPoint, to: SavedPoint, response: RouteResponse, plannedAt: Date, max: number): SavedTrip[] | null {
  const trip: SavedTrip = {
    id: response.tripId,
    savedAt: new Date().toISOString(),
    plannedAt: plannedAt.toISOString(),
    from: { name: from.name, lat: from.lat, lng: from.lng },
    to: { name: to.name, lat: to.lat, lng: to.lng },
    response: { ...response, route: { ...response.route, coords: thinRoute(response.route.coords) } },
  };
  const list = [trip, ...loadSavedTrips().filter((t) => t.id !== trip.id)].slice(0, max);
  return saveJson(KEY, list) ? list : null;
}

export function removeSavedTrip(id: string): SavedTrip[] {
  const list = loadSavedTrips().filter((t) => t.id !== id);
  saveJson(KEY, list);
  return list;
}

/** Saved trips can include an exact start point, so they don't outlive the signed-in account. */
export function clearSavedTrips(): void {
  removeJson(KEY);
}
