import { RouteIndex } from '../src/planner/geometry.ts';
import type { Env } from './env.ts';
import type { LatLng } from './http.ts';
import type { RouteFn, RouteResult } from './routing.ts';
import { distanceMetres, stationsNear } from './stations.ts';

// Public routers only return their own alternatives for short trips (ORS caps them at 100 km), so
// other routes are found by steering through a point to one side of the first route.
const VIA_FRACTIONS = [0.35, 0.5, 0.65];
const OFFSET_SHARE = 0.18;
const MIN_OFFSET_KM = 20;
const MAX_OFFSET_KM = 120;
/** Via points move to a nearby DC charger, so the route passes somewhere a driver can charge. */
const SNAP_KM = 30;
const SAME_VIA_KM = 5;
const MAX_DETOUR = 1.35;
const MAX_SHARED_WITH_PRIMARY = 0.7;
const MAX_SHARED_WITH_OTHER = 0.8;
const SAMPLE_KM = 2;
const ON_ROUTE_KM = 1.5;
const MAX_ALTERNATIVES = 2;
export const ALTERNATIVES_BUDGET_MS = 8000;

const toRad = (d: number) => (d * Math.PI) / 180;
const kmPerLng = (lat: number) => Math.cos(toRad(lat)) * 111.32;
const KM_PER_LAT = 110.57;
const inIndia = (p: LatLng) => p.lat >= 5.5 && p.lat <= 37.5 && p.lng >= 67.5 && p.lng <= 98;

export interface AlternativeRoute extends RouteResult {
  via: LatLng;
}

/** Points on the primary route at fixed fractions, pushed sideways from the overall direction. */
export function viaCandidates(from: LatLng, to: LatLng, primary: RouteIndex): LatLng[] {
  const offsetKm = Math.min(MAX_OFFSET_KM, Math.max(MIN_OFFSET_KM, (distanceMetres(from, to) / 1000) * OFFSET_SHARE));
  const midLat = (from.lat + to.lat) / 2;
  const dx = (to.lng - from.lng) * kmPerLng(midLat);
  const dy = (to.lat - from.lat) * KM_PER_LAT;
  const len = Math.hypot(dx, dy) || 1;
  const [px, py] = [-dy / len, dx / len];
  const out: LatLng[] = [];
  for (const f of VIA_FRACTIONS) {
    const [lng, lat] = primary.pointAt(f * primary.lengthKm);
    for (const side of [1, -1]) {
      out.push({ lat: lat + (side * py * offsetKm) / KM_PER_LAT, lng: lng + (side * px * offsetKm) / kmPerLng(lat) });
    }
  }
  return out.filter(inIndia);
}

/** Share of `route` (sampled every ~2 km) that runs within 1.5 km of `other`. */
export function sharedShare(route: RouteIndex, other: RouteIndex): number {
  const n = Math.max(1, Math.round(route.lengthKm / SAMPLE_KM));
  let shared = 0;
  for (let i = 0; i <= n; i++) {
    const [lng, lat] = route.pointAt((i * route.lengthKm) / n);
    if (other.project(lng, lat, ON_ROUTE_KM)) shared++;
  }
  return shared / (n + 1);
}

async function snapToChargers(env: Env, points: LatLng[]): Promise<LatLng[]> {
  const out: LatLng[] = [];
  for (const p of points) {
    const station = (await stationsNear(env, p, SNAP_KM, true))[0];
    const via = station ? { lat: station.lat, lng: station.lng } : p;
    if (!out.some((o) => distanceMetres(o, via) < SAME_VIA_KM * 1000)) out.push(via);
  }
  return out;
}

/**
 * Up to two other routes between the same places. Candidates are routed together within the time
 * budget; any that fail, run late, detour too far or mostly repeat another route are dropped.
 */
export async function alternativeRoutes(
  env: Env,
  from: LatLng,
  to: LatLng,
  primary: RouteResult,
  route: RouteFn,
  budgetMs = ALTERNATIVES_BUDGET_MS,
): Promise<AlternativeRoute[]> {
  if (primary.coords.length < 2) return [];
  const primaryIndex = new RouteIndex(primary.coords);
  const vias = await snapToChargers(env, viaCandidates(from, to, primaryIndex));

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), budgetMs);
  const deadline = new Promise<never>((_, reject) => {
    controller.signal.addEventListener('abort', () => reject(new Error('alternatives timed out')));
  });
  const settled = await Promise.allSettled(
    vias.map((via) => Promise.race([route([from, via, to], controller.signal).then((r) => ({ ...r, via })), deadline])),
  );
  clearTimeout(timer);

  const candidates = settled
    .flatMap((s) => (s.status === 'fulfilled' ? [s.value] : []))
    .filter((r) => r.coords.length >= 2 && r.distanceKm <= primary.distanceKm * MAX_DETOUR)
    .map((r) => ({ route: r, index: new RouteIndex(r.coords) }))
    .filter((c) => sharedShare(c.index, primaryIndex) <= MAX_SHARED_WITH_PRIMARY)
    .sort((a, b) => a.route.durationMin - b.route.durationMin);

  const kept: typeof candidates = [];
  for (const c of candidates) {
    if (kept.length >= MAX_ALTERNATIVES) break;
    const duplicate = kept.some((k) => Math.max(sharedShare(c.index, k.index), sharedShare(k.index, c.index)) > MAX_SHARED_WITH_OTHER);
    if (!duplicate) kept.push(c);
  }
  return kept.map((k) => k.route);
}
