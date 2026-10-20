import { FREE_TRIP_KM, MAX_REPLANS_PER_TRIP, PLANS, REPLAN_WINDOW_HOURS, decideTrip } from '../src/shared/plans.ts';
import type { RouteAlternativeWire } from '../src/shared/contracts.ts';
import type { Coord } from '../src/planner/geometry.ts';
import { alternativeRoutes } from './alternatives.ts';
import type { User } from './auth.ts';
import { currentPlan, quotaWindows, usageCounts } from './entitlements.ts';
import { isDev, type Env } from './env.ts';
import { HttpError, enforceRateLimit, latLngInIndia, readJson, str, type LatLng } from './http.ts';
import { distanceMetres } from './stations.ts';

const ORS_URL = 'https://api.heigit.org/openrouteservice/v2/directions/driving-car/geojson';
const OSRM_DEMO_URL = 'https://router.project-osrm.org/route/v1/driving';
const SAME_DESTINATION_M = 2000;
/** Detours after a failed charger can add some distance to the remaining route. */
const REPLAN_DISTANCE_SLACK = 0.15;
const REPLAN_DISTANCE_EXTRA_KM = 10;

export interface RouteResult {
  coords: Coord[];
  distanceKm: number;
  durationMin: number;
  hasElevation: boolean;
}

/** Computes a road route through the points in order (start, any via points, destination). */
export type RouteFn = (points: LatLng[], signal?: AbortSignal) => Promise<RouteResult>;

async function routeWithOrs(apiKey: string, points: LatLng[], signal?: AbortSignal): Promise<RouteResult> {
  const res = await fetch(ORS_URL, {
    method: 'POST',
    headers: { Authorization: apiKey, 'Content-Type': 'application/json', Accept: 'application/geo+json' },
    body: JSON.stringify({
      coordinates: points.map((p) => [p.lng, p.lat]),
      elevation: true,
      instructions: false,
      preference: 'fastest',
    }),
    signal,
  });
  if (res.status === 404 || res.status === 400) {
    throw new HttpError(422, 'no_route', 'No road route found between these places.');
  }
  if (!res.ok) throw new HttpError(502, 'routing_unavailable', 'Route service is busy. Please try again shortly.');
  const data = (await res.json()) as {
    features?: Array<{ geometry: { coordinates: Coord[] }; properties: { summary: { distance?: number; duration?: number } } }>;
  };
  const f = data.features?.[0];
  if (!f) throw new HttpError(422, 'no_route', 'No road route found between these places.');
  return {
    coords: f.geometry.coordinates,
    distanceKm: (f.properties.summary.distance ?? 0) / 1000,
    durationMin: (f.properties.summary.duration ?? 0) / 60,
    hasElevation: f.geometry.coordinates[0]?.length === 3,
  };
}

/** The public OSRM demo server is for development only (its usage policy forbids production use). */
async function routeWithOsrmDemo(points: LatLng[], signal?: AbortSignal): Promise<RouteResult> {
  const url = `${OSRM_DEMO_URL}/${points.map((p) => `${p.lng},${p.lat}`).join(';')}?overview=full&geometries=geojson`;
  const res = await fetch(url, { headers: { 'User-Agent': 'ChargeOne-dev/0.1' }, signal });
  if (!res.ok) throw new HttpError(502, 'routing_unavailable', 'Route service is busy. Please try again shortly.');
  const data = (await res.json()) as {
    code: string;
    routes?: Array<{ distance: number; duration: number; geometry: { coordinates: Coord[] } }>;
  };
  const r = data.routes?.[0];
  if (data.code !== 'Ok' || !r) throw new HttpError(422, 'no_route', 'No road route found between these places.');
  return { coords: r.geometry.coordinates, distanceKm: r.distance / 1000, durationMin: r.duration / 60, hasElevation: false };
}

export function router(env: Env): RouteFn {
  const key = env.ORS_API_KEY;
  if (key) return (points, signal) => routeWithOrs(key, points, signal);
  if (isDev(env)) return routeWithOsrmDemo;
  return async () => {
    throw new HttpError(503, 'not_configured', 'Trip planning is not configured yet.');
  };
}

/** Rounds coordinates to ~1 m and drops consecutive duplicates to keep responses small. */
export function compactCoords(coords: Coord[]): Coord[] {
  const out: Coord[] = [];
  let prev = '';
  for (const c of coords) {
    const r: Coord = c.length === 3
      ? [Math.round(c[0] * 1e5) / 1e5, Math.round(c[1] * 1e5) / 1e5, Math.round(c[2])]
      : [Math.round(c[0] * 1e5) / 1e5, Math.round(c[1] * 1e5) / 1e5];
    const key = `${r[0]},${r[1]}`;
    if (key !== prev) out.push(r);
    prev = key;
  }
  return out;
}

const TRIP_ID = /^[0-9a-f-]{36}$/;

export async function planRoute(req: Request, env: Env, user: User) {
  const body = await readJson(req, 2048);
  const from = latLngInIndia(body, 'from');
  const to = latLngInIndia(body, 'to');
  const tripId = str(body, 'tripId', { max: 36, pattern: TRIP_ID, optional: true });
  if (body.alternatives !== undefined && typeof body.alternatives !== 'boolean') throw new HttpError(400, 'invalid', 'Invalid alternatives.');
  await enforceRateLimit(env.DB, `route:${user.id}`, 20, 3600);

  const now = new Date();
  const planId = await currentPlan(env, user.id, now);

  let original: { id: string; counts: 'short' | 'long'; distance_km: number } | null = null;
  if (tripId) {
    const since = new Date(now.getTime() - REPLAN_WINDOW_HOURS * 3600_000).toISOString();
    const trip = await env.DB.prepare(
      'SELECT id, counts, distance_km, to_lat, to_lng, replans FROM trips WHERE id = ?1 AND user_id = ?2 AND created_at >= ?3',
    )
      .bind(tripId, user.id, since)
      .first<{ id: string; counts: 'short' | 'long'; distance_km: number; to_lat: number; to_lng: number; replans: number }>();
    if (trip && trip.replans < MAX_REPLANS_PER_TRIP && distanceMetres(to, { lat: trip.to_lat, lng: trip.to_lng }) <= SAME_DESTINATION_M) {
      original = trip;
    }
  }
  // A re-plan is free only for the same journey: a driver on the way is closer, not further,
  // and a short trip can't become a long one.
  const isReplan = (km: number) =>
    original !== null &&
    km <= original.distance_km * (1 + REPLAN_DISTANCE_SLACK) + REPLAN_DISTANCE_EXTRA_KM &&
    !(original.counts === 'short' && km > FREE_TRIP_KM);

  const straightKm = distanceMetres(from, to) / 1000;
  if (straightKm < 0.5) throw new HttpError(400, 'too_short', 'Start and destination are the same place.');
  const usage = await usageCounts(env, user.id, planId, now);
  // A road is never shorter than the straight line, so this refuses obviously-too-long trips
  // without spending a routing call.
  const early = decideTrip(planId, straightKm, usage, isReplan(straightKm), true);
  if (!early.allowed) throw new HttpError(402, early.reason, early.message, { plan: planId, usage });

  const routeFn = router(env);
  const route = await routeFn([from, to]);
  const decision = decideTrip(planId, route.distanceKm, usage, isReplan(route.distanceKm));
  if (!decision.allowed) {
    throw new HttpError(402, decision.reason, decision.message, { plan: planId, usage, distanceKm: Math.round(route.distanceKm) });
  }

  let id: string;
  if (decision.counts === 'replan') {
    id = original!.id;
    const res = await env.DB.prepare('UPDATE trips SET replans = replans + 1 WHERE id = ?1 AND replans < ?2')
      .bind(id, MAX_REPLANS_PER_TRIP)
      .run();
    if ((res.meta.changes ?? 0) === 0) throw new HttpError(429, 'too_many_replans', 'This trip has been re-planned too many times. Start a new trip.');
  } else {
    id = crypto.randomUUID();
    const plan = PLANS[planId];
    const windows = await quotaWindows(env, user.id, planId, now);
    const [since, limit] = decision.counts === 'short' ? [windows.dayStart, plan.shortTripsPerDay] : [windows.longStart, plan.longTripQuota];
    // The quota check and the insert are one statement, so parallel requests can't overshoot it.
    const res = await env.DB.prepare(
      `INSERT INTO trips (id, user_id, counts, distance_km, to_lat, to_lng, created_at)
       SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7
       WHERE (SELECT COUNT(*) FROM trips WHERE user_id = ?2 AND counts = ?3 AND created_at >= ?8) < ?9`,
    )
      // Only the destination area (~1 km) is kept, which is enough to recognise a re-plan.
      .bind(id, user.id, decision.counts, route.distanceKm, Math.round(to.lat * 100) / 100, Math.round(to.lng * 100) / 100, now.toISOString(), since, limit)
      .run();
    if ((res.meta.changes ?? 0) === 0) {
      const latest = await usageCounts(env, user.id, planId, now);
      const again = decideTrip(planId, route.distanceKm, latest, false);
      throw new HttpError(402, again.allowed ? 'long_quota_used' : again.reason, again.allowed ? 'Trip limit reached.' : again.message, { plan: planId, usage: latest });
    }
  }

  const [after, alts] = await Promise.all([
    usageCounts(env, user.id, planId, now),
    body.alternatives === true && PLANS[planId].routeCompare ? alternativeRoutes(env, from, to, route, routeFn) : null,
  ]);
  return {
    tripId: id,
    counted: decision.counts,
    route: { ...route, coords: compactCoords(route.coords) },
    plan: planId,
    usage: after,
    ...(alts ? { alternatives: alts.map((a) => ({ ...a, coords: compactCoords(a.coords) })) satisfies RouteAlternativeWire[] } : {}),
  };
}
