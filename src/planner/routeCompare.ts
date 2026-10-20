import type { Station } from '../data/model.ts';
import type { PlacesData } from '../data/places.ts';
import { liveState, type StationStatus } from '../shared/status.ts';
import { RouteIndex, haversineKm, type Coord } from './geometry.ts';
import type { Journey } from './journey.ts';

export type RouteTag = 'fastest' | 'fewest_stops' | 'safest' | 'cheapest' | 'flattest';

export const TAG_LABEL: Record<RouteTag, string> = {
  fastest: 'Fastest',
  fewest_stops: 'Fewest stops',
  safest: 'Most chargers',
  cheapest: 'Cheapest',
  flattest: 'Flattest',
};

export interface RouteCandidate {
  coords: Coord[];
  distanceKm: number;
  durationMin: number;
  journey: Journey;
  /** Where an alternative was steered through; null for the main route. */
  via: { lat: number; lng: number } | null;
}

export interface RouteAnalysis {
  /** "Main route" or "via Salem". */
  label: string;
  distanceKm: number;
  totalMinutes: number;
  stops: number;
  chargeMinutes: number;
  costInr: number;
  arrivalSocPct: number;
  feasible: boolean;
  /** DC fast chargers within CORRIDOR_KM of the road. */
  dcChargers: number;
  /** Of those, how many drivers reported working in the last day. */
  dcWorking: number;
  /** The longest stretch of road with no DC charger near it, km. */
  longestDcGapKm: number;
  /** Charging stops with somewhere to eat within walking distance. */
  stopsWithFood: number;
  climbM: number | null;
  tags: RouteTag[];
  /** Short plain-language reasons this route is a good choice, compared with the others. */
  pros: string[];
  cons: string[];
}

const CORRIDOR_KM = 2;

function climbOf(coords: Coord[]): number | null {
  if (coords.length < 2 || coords[0].length < 3) return null;
  let up = 0;
  // Elevation from the router is noisy point to point; smooth over a few points before summing.
  let prev = coords[0][2] ?? 0;
  for (let i = 1; i < coords.length; i++) {
    const z = coords[i][2];
    if (z === undefined) return null;
    const smooth = prev + (z - prev) * 0.35;
    if (smooth > prev) up += smooth - prev;
    prev = smooth;
  }
  return Math.round(up);
}

function townNear(via: { lat: number; lng: number }, stations: Station[], places: PlacesData | null): string | null {
  if (!places) return null;
  let best: Station | null = null;
  let bestKm = 25;
  const p: Coord = [via.lng, via.lat];
  for (const s of stations) {
    if (Math.abs(s.lat - via.lat) > 0.3 || Math.abs(s.lng - via.lng) > 0.3) continue;
    const km = haversineKm(p, [s.lng, s.lat]);
    if (km < bestKm && places.area[s.id]) {
      best = s;
      bestKm = km;
    }
  }
  return best ? places.area[best.id] : null;
}

function hm(minutes: number): string {
  const h = Math.floor(minutes / 60);
  const m = Math.round(minutes % 60);
  return h ? `${h} h ${m.toString().padStart(2, '0')} min` : `${m} min`;
}

function measure(c: RouteCandidate, stations: Station[], statuses: Map<string, StationStatus>, places: PlacesData | null, now: Date) {
  const index = new RouteIndex(c.coords);
  const dcAlong: number[] = [];
  let working = 0;
  const [minX, minY, maxX, maxY] = index.bbox;
  for (const s of stations) {
    if (s.speed !== 'dc' || s.lng < minX - 0.05 || s.lng > maxX + 0.05 || s.lat < minY - 0.05 || s.lat > maxY + 0.05) continue;
    const pr = index.project(s.lng, s.lat, CORRIDOR_KM);
    if (!pr || pr.offKm > CORRIDOR_KM) continue;
    dcAlong.push(pr.alongKm);
    const st = liveState(statuses.get(s.id), now);
    if (st === 'working' || st === 'in_use') working++;
  }
  dcAlong.sort((a, b) => a - b);
  let gap = 0;
  let last = 0;
  for (const km of dcAlong) {
    gap = Math.max(gap, km - last);
    last = km;
  }
  gap = Math.max(gap, index.lengthKm - last);
  const stopIds = c.journey.days.flatMap((d) => d.plan.stops.map((s) => s.station.id));
  const stopsWithFood = stopIds.filter((id) => (places?.near[id]?.f.length ?? 0) > 0).length;
  return { dcChargers: dcAlong.length, dcWorking: working, longestDcGapKm: Math.round(gap), stopsWithFood, climbM: climbOf(c.coords) };
}

/** Compares road routes between the same places so the driver can pick one. The first candidate is the main route. */
export function compareRoutes(
  candidates: RouteCandidate[],
  stations: Station[],
  statuses: Map<string, StationStatus>,
  places: PlacesData | null,
  now = new Date(),
): RouteAnalysis[] {
  const rows: RouteAnalysis[] = candidates.map((c, i) => {
    const j = c.journey;
    const town = c.via ? townNear(c.via, stations, places) : null;
    return {
      label: i === 0 ? 'Main route' : town ? `Via ${town}` : `Route ${i + 1}`,
      distanceKm: Math.round(j.distanceKm),
      totalMinutes: Math.round(j.driveMinutes + j.chargeMinutes),
      stops: j.stopCount,
      chargeMinutes: Math.round(j.chargeMinutes),
      costInr: j.costInr,
      arrivalSocPct: Math.max(0, j.arrivalSocPct),
      feasible: j.feasible && !j.tooLong,
      ...measure(c, stations, statuses, places, now),
      tags: [],
      pros: [],
      cons: [],
    };
  });
  if (rows.length < 2) return rows;

  const ok = rows.filter((r) => r.feasible);
  const pool = ok.length ? ok : rows;
  const best = <K extends keyof RouteAnalysis>(key: K, dir: 1 | -1) =>
    pool.reduce((a, b) => ((b[key] as number) * dir < (a[key] as number) * dir ? b : a));
  const tag = (r: RouteAnalysis, t: RouteTag) => {
    if (!r.tags.includes(t)) r.tags.push(t);
  };
  const fastest = best('totalMinutes', 1);
  tag(fastest, 'fastest');
  const fewest = best('stops', 1);
  if (pool.filter((r) => r.stops === fewest.stops).length < pool.length) tag(fewest, 'fewest_stops');
  const safest = pool.reduce((a, b) => (b.longestDcGapKm < a.longestDcGapKm || (b.longestDcGapKm === a.longestDcGapKm && b.dcWorking > a.dcWorking) ? b : a));
  tag(safest, 'safest');
  const cheapest = best('costInr', 1);
  if (pool.filter((r) => r.costInr === cheapest.costInr).length < pool.length) tag(cheapest, 'cheapest');
  const climbs = pool.filter((r) => r.climbM !== null);
  if (climbs.length === pool.length) {
    const flat = climbs.reduce((a, b) => (b.climbM! < a.climbM! ? b : a));
    const steep = climbs.reduce((a, b) => (b.climbM! > a.climbM! ? b : a));
    if (steep.climbM! - flat.climbM! >= 150) tag(flat, 'flattest');
  }

  for (const r of rows) {
    if (!r.feasible) r.cons.push('Not safe as planned with your battery');
    const others = rows.filter((o) => o !== r);
    const minOther = (f: (o: RouteAnalysis) => number) => Math.min(...others.map(f));
    const maxOther = (f: (o: RouteAnalysis) => number) => Math.max(...others.map(f));
    // An unsafe route is only quick and cheap because it skips charging the car needs, so time, stops and cost
    // are compared among safe routes.
    const rivals = others.filter((o) => o.feasible);
    const minRival = (f: (o: RouteAnalysis) => number) => Math.min(...rivals.map(f));
    if (r.feasible && rivals.length) {
      const faster = minRival((o) => o.totalMinutes) - r.totalMinutes;
      if (faster >= 5) r.pros.push(`${hm(faster)} faster`);
      else if (faster <= -10) r.cons.push(`${hm(-faster)} slower`);
      const fewer = minRival((o) => o.stops) - r.stops;
      if (fewer > 0) r.pros.push(`${fewer} fewer charging stop${fewer > 1 ? 's' : ''}`);
      const cheaper = minRival((o) => o.costInr) - r.costInr;
      if (cheaper >= 30) r.pros.push(`About ₹${cheaper} cheaper`);
    }
    if (r.dcChargers > 0) r.pros.push(`DC chargers at most ${r.longestDcGapKm} km apart`);
    if (r.longestDcGapKm > maxOther((o) => o.longestDcGapKm) && r.longestDcGapKm > 80) r.cons.push(`${r.longestDcGapKm} km with no fast charger`);
    if (r.dcWorking > 0) r.pros.push(`${r.dcWorking} charger${r.dcWorking > 1 ? 's' : ''} reported working today`);
    if (r.stops > 0 && r.stopsWithFood === r.stops) r.pros.push('Food at every stop');
    if (r.climbM !== null && others.every((o) => o.climbM !== null)) {
      const less = minOther((o) => o.climbM!) - r.climbM;
      if (less >= 150) r.pros.push(`${less} m less climbing, easier on battery`);
    }
    const longer = r.distanceKm - minOther((o) => o.distanceKm);
    if (longer >= 10) r.cons.push(`${longer} km longer`);
  }
  return rows;
}
