// Route shapes and the Valhalla reply parser. Pure (no Cloudflare types), so scripts/trip-benchmark.ts can
// parse cached replies exactly as the worker does; routing.ts re-exports everything here.
import type { Coord } from '../src/planner/geometry.ts';
import { realisticMinutes, type ValhallaManeuver } from './driveTime.ts';
import { HttpError } from './errors.ts';

export type RouteSource = 'ors' | 'valhalla' | 'osrm';

export interface RouteResult {
  coords: Coord[];
  distanceKm: number;
  durationMin: number;
  hasElevation: boolean;
  /** Which router drew it; the app shows the matching attribution. */
  source?: RouteSource;
}

export const BUSY = () => new HttpError(502, 'routing_unavailable', 'The route service is busy. Please try again in a minute.');
export const NO_ROUTE = () => new HttpError(422, 'no_route', 'No road route found between these places.');

/** Decodes an encoded polyline (Valhalla uses 6 decimal places) to [lng, lat] pairs. */
export function decodePolyline(encoded: string, precision = 6): Coord[] {
  const factor = 10 ** precision;
  const out: Coord[] = [];
  let i = 0, lat = 0, lng = 0;
  while (i < encoded.length) {
    for (const axis of [0, 1]) {
      let shift = 0, result = 0, byte: number;
      do {
        byte = encoded.charCodeAt(i++) - 63;
        result |= (byte & 0x1f) << shift;
        shift += 5;
      } while (byte >= 0x20);
      const delta = result & 1 ? ~(result >> 1) : result >> 1;
      if (axis === 0) lat += delta;
      else lng += delta;
    }
    out.push([lng / factor, lat / factor]);
  }
  return out;
}

export interface ValhallaLeg {
  shape?: string;
  summary?: { length?: number; time?: number };
  maneuvers?: ValhallaManeuver[];
}

interface ValhallaReply {
  trip?: { status?: number; summary?: { length?: number; time?: number }; legs?: ValhallaLeg[] };
  error_code?: number;
}

/**
 * Turns a Valhalla /route reply into a route. Valhalla has no elevation on /route, so plans assume flat roads.
 * Its highway times are far too slow for India, so the duration is corrected stretch by stretch
 * from the maneuvers (see driveTime.ts); a reply without maneuvers keeps Valhalla's own time.
 */
export function parseValhalla(status: number, body: unknown): RouteResult {
  const data = (body ?? {}) as ValhallaReply;
  // 4xx carries an error_code: 442 no path, 171 no road near a point, 154 too long for the server.
  if (status === 400 || status === 404) throw NO_ROUTE();
  if (status !== 200 || !data.trip || data.trip.status !== 0) throw BUSY();
  const coords: Coord[] = [];
  const legs = data.trip.legs ?? [];
  const shapes = legs.map((leg) => decodePolyline(leg.shape ?? ''));
  for (const pts of shapes) {
    // Each leg starts where the last one ended.
    coords.push(...(coords.length ? pts.slice(1) : pts));
  }
  const km = data.trip.summary?.length;
  if (coords.length < 2 || typeof km !== 'number') throw NO_ROUTE();
  const withManeuvers = legs.length > 0 && legs.every((leg) => leg.maneuvers?.length);
  const durationMin = withManeuvers ? realisticMinutes(legs, shapes) : (data.trip.summary?.time ?? 0) / 60;
  return { coords, distanceKm: km, durationMin, hasElevation: false, source: 'valhalla' };
}
