import { FREE_TRIP_KM, MAX_REPLANS_PER_TRIP, PLANS, REPLAN_WINDOW_HOURS, decideTrip, type TripDecision } from '../src/shared/plans.ts';
import type { RouteAlternativeWire } from '../src/shared/contracts.ts';
import type { Coord } from '../src/planner/geometry.ts';
import { alternativeRoutes } from './alternatives.ts';
import type { User } from './auth.ts';
import { currentPlan, quotaWindows, usageCounts } from './entitlements.ts';
import { isDev, type Env } from './env.ts';
import { HttpError, claimSlot, clientKey, enforceRateLimit, indianDayStart, latLngInIndia, readJson, releaseSlot, str, type LatLng } from './http.ts';
import { distanceMetres } from './stations.ts';
import { BUSY, NO_ROUTE, parseValhalla, type RouteResult } from './valhalla.ts';

export { decodePolyline, parseValhalla, type RouteResult, type RouteSource, type ValhallaLeg } from './valhalla.ts';

const ORS_URL = 'https://api.heigit.org/openrouteservice/v2/directions/driving-car/geojson';
const OSRM_DEMO_URL = 'https://router.project-osrm.org/route/v1/driving';
/**
 * FOSSGIS e.V.'s public Valhalla server, used only while no openrouteservice key is set. Its terms
 * (fossgis.de/arbeitsgruppen/osm-server/nutzungsbedingungen) ask for an identifying User-Agent, the
 * site as Referer, at most one request a second, low volume, and OpenStreetMap attribution with a
 * "report error" link (shown under every planned trip).
 */
const VALHALLA_URL = 'https://valhalla1.openstreetmap.de/route';
const PUBLIC_USER_AGENT = 'ChargeOne/0.2 (+https://chargeone.akshshivam5.workers.dev; EV trip planner for India)';
/** Routing calls a day to the public server, across everyone; well under its "no heavy usage" rule. */
export const PUBLIC_ROUTES_PER_DAY = 800;
export const PUBLIC_ROUTE_DAY_SLOT = 'public-route:day';
/** Per network (hashed IP) a day, so one script can't use up everyone's share. */
export const PUBLIC_ROUTES_PER_IP_PER_DAY = 25;
/** Identical requests (same points to ~10 m) are answered from the edge cache for this long. */
const PUBLIC_CACHE_SECONDS = 3 * 86400;
const PUBLIC_TIMEOUT_MS = 15_000;
const SAME_DESTINATION_M = 2000;
/** Detours after a failed charger can add some distance to the remaining route. */
const REPLAN_DISTANCE_SLACK = 0.15;
const REPLAN_DISTANCE_EXTRA_KM = 10;
/** A request for the same trip (destination to ~1 km, road length to 0.5 km) this soon after is a retry. */
const REPEAT_WINDOW_MS = 10 * 60_000;
const REPEAT_DISTANCE_KM = 0.5;

/** Computes a road route through the points in order (start, any via points, destination). */
export type RouteFn = (points: LatLng[], signal?: AbortSignal) => Promise<RouteResult>;

/** Who is asking, for the public router's per-network cap and Referer. */
export interface RouteCaller {
  /** Hashed client IP (clientKey). */
  ip: string;
  origin: string;
}

/** A deadline for one call, together with the caller's own signal when there is one. */
const deadline = (signal?: AbortSignal) =>
  signal ? AbortSignal.any([signal, AbortSignal.timeout(PUBLIC_TIMEOUT_MS)]) : AbortSignal.timeout(PUBLIC_TIMEOUT_MS);

async function routeWithOrs(apiKey: string, points: LatLng[], signal?: AbortSignal): Promise<RouteResult> {
  let data: {
    features?: Array<{ geometry: { coordinates: Coord[] }; properties: { summary: { distance?: number; duration?: number } } }>;
  };
  try {
    const res = await fetch(ORS_URL, {
      method: 'POST',
      headers: { Authorization: apiKey, 'Content-Type': 'application/json', Accept: 'application/geo+json' },
      body: JSON.stringify({
        coordinates: points.map((p) => [p.lng, p.lat]),
        elevation: true,
        instructions: false,
        preference: 'fastest',
      }),
      signal: deadline(signal),
    });
    if (res.status === 404 || res.status === 400) throw NO_ROUTE();
    if (!res.ok) throw BUSY();
    data = (await res.json()) as typeof data;
  } catch (err) {
    // A network error, a timeout or a body that isn't JSON: busy, so the public fallback can answer.
    if (err instanceof HttpError) throw err;
    throw BUSY();
  }
  const f = data.features?.[0];
  if (!f) throw NO_ROUTE();
  return {
    coords: f.geometry.coordinates,
    distanceKm: (f.properties.summary.distance ?? 0) / 1000,
    durationMin: (f.properties.summary.duration ?? 0) / 60,
    hasElevation: f.geometry.coordinates[0]?.length === 3,
    source: 'ors',
  };
}

/** The public OSRM demo server is for development only (its usage policy forbids production use). */
async function routeWithOsrmDemo(points: LatLng[], signal?: AbortSignal): Promise<RouteResult> {
  const url = `${OSRM_DEMO_URL}/${points.map((p) => `${p.lng},${p.lat}`).join(';')}?overview=full&geometries=geojson`;
  let data: { code: string; routes?: Array<{ distance: number; duration: number; geometry: { coordinates: Coord[] } }> };
  try {
    const res = await fetch(url, { headers: { 'User-Agent': 'ChargeOne-dev/0.1' }, signal: deadline(signal) });
    if (!res.ok) throw BUSY();
    data = (await res.json()) as typeof data;
  } catch {
    // A dropped connection, timeout or broken reply means "try again", not a server error.
    throw BUSY();
  }
  const r = data.routes?.[0];
  if (data.code !== 'Ok' || !r) throw NO_ROUTE();
  return { coords: r.geometry.coordinates, distanceKm: r.distance / 1000, durationMin: r.duration / 60, hasElevation: false, source: 'osrm' };
}

/** The edge cache exists only on Cloudflare; tests and Node run without it. */
const edgeCache = (): Cache | null => (typeof caches === 'undefined' ? null : caches.default);
// v2: durations are corrected from maneuvers, so routes cached before that are not reused.
const cacheKey = (points: LatLng[]) =>
  `https://chargeone.internal/route/valhalla/v2/${points.map((p) => `${p.lat.toFixed(4)},${p.lng.toFixed(4)}`).join(';')}`;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Gives back a day's public routing call that got no answer (network error, timeout, 5xx, 429, or
 * no free second), so an outage doesn't leave routing "at today's limit" once the server is back.
 */
async function releasePublic(env: Env, caller: RouteCaller | undefined, day: number): Promise<void> {
  await releaseSlot(env.DB, PUBLIC_ROUTE_DAY_SLOT, day);
  if (caller) await releaseSlot(env.DB, `public-route-ip:${caller.ip}`, day);
}

/** Takes one of the day's public routing calls and waits for this second's single slot. */
async function publicSlot(env: Env, caller: RouteCaller | undefined, day: number): Promise<void> {
  const ipKey = caller ? `public-route-ip:${caller.ip}` : null;
  if (ipKey && (await claimSlot(env.DB, ipKey, PUBLIC_ROUTES_PER_IP_PER_DAY, day)) === null) {
    throw new HttpError(429, 'rate_limited', 'This network has planned a lot of routes today. Please try again tomorrow.');
  }
  if ((await claimSlot(env.DB, PUBLIC_ROUTE_DAY_SLOT, PUBLIC_ROUTES_PER_DAY, day)) === null) {
    if (ipKey) await releaseSlot(env.DB, ipKey, day);
    throw new HttpError(503, 'routing_unavailable', "Free route planning has reached today's limit for everyone. Please try again tomorrow.");
  }
  for (let tries = 0; tries < 4; tries++) {
    if ((await claimSlot(env.DB, 'public-route:second', 1, Math.floor(Date.now() / 1000))) !== null) return;
    await sleep(1000 - (Date.now() % 1000) + 20);
  }
  // Nothing was sent, so nothing is counted.
  await releasePublic(env, caller, day);
  throw BUSY();
}

async function routeWithValhalla(env: Env, points: LatLng[], caller: RouteCaller | undefined, signal?: AbortSignal): Promise<RouteResult> {
  const cache = edgeCache();
  const key = cacheKey(points);
  const hit = await cache?.match(key);
  if (hit) return (await hit.json()) as RouteResult;

  const day = indianDayStart();
  await publicSlot(env, caller, day);
  let res: Response;
  try {
    res = await fetch(VALHALLA_URL, {
      method: 'POST',
      headers: {
        'User-Agent': PUBLIC_USER_AGENT,
        'Content-Type': 'application/json',
        ...(caller ? { Referer: `${caller.origin}/` } : {}),
      },
      body: JSON.stringify({
        locations: points.map((p) => ({ lat: p.lat, lon: p.lng, type: 'break' })),
        costing: 'auto',
        units: 'kilometers',
        // Maneuvers (no text) carry each stretch's road name and length for the drive-time correction.
        directions_type: 'maneuvers',
        shape_format: 'polyline6',
      }),
      signal: deadline(signal),
    });
  } catch {
    await releasePublic(env, caller, day);
    throw BUSY();
  }
  if (res.status === 429 || res.status >= 500) await releasePublic(env, caller, day);
  const route = parseValhalla(res.status, await res.json().catch(() => null));
  await cache?.put(key, Response.json(route, { headers: { 'Cache-Control': `public, max-age=${PUBLIC_CACHE_SECONDS}` } }));
  return route;
}

/**
 * The keyless router: FOSSGIS Valhalla in production, the OSRM demo in development (its policy
 * rules out production). PUBLIC_ROUTER can pick one explicitly, or 'off'.
 */
function publicRouter(env: Env, caller?: RouteCaller): RouteFn | null {
  const choice = publicRouterName(env);
  if (choice === 'valhalla') return (points, signal) => routeWithValhalla(env, points, caller, signal);
  if (choice === 'osrm-demo') return routeWithOsrmDemo;
  return null;
}

/** Which keyless router publicRouter() would use, or null when it is off. */
export function publicRouterName(env: Env): 'valhalla' | 'osrm-demo' | null {
  const choice = env.PUBLIC_ROUTER ?? (isDev(env) ? 'osrm-demo' : 'valhalla');
  if (choice === 'valhalla') return 'valhalla';
  if (choice === 'osrm-demo' && isDev(env)) return 'osrm-demo';
  return null;
}

/** openrouteservice when its key is set (falling back to the public router when it's busy), else the public router. */
export function router(env: Env, caller?: RouteCaller, publicFallback = true): RouteFn {
  const key = env.ORS_API_KEY;
  const fallback = publicFallback || !key ? publicRouter(env, caller) : null;
  if (key) {
    return async (points, signal) => {
      try {
        return await routeWithOrs(key, points, signal);
      } catch (err) {
        if (fallback && err instanceof HttpError && err.code === 'routing_unavailable') return fallback(points, signal);
        throw err;
      }
    };
  }
  if (fallback) return fallback;
  return async () => {
    throw new HttpError(503, 'not_configured', 'Trip planning is not switched on yet. The charger map still works.');
  };
}

/** Who is asking, from the request. */
export async function routeCaller(req: Request): Promise<RouteCaller> {
  return { ip: await clientKey(req), origin: new URL(req.url).origin };
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
  // The same trip asked for again within a few minutes (a retry after the answer was lost on a weak
  // signal) is the trip already counted, not a new one.
  const toLat = Math.round(to.lat * 100) / 100;
  const toLng = Math.round(to.lng * 100) / 100;
  const recent = original
    ? null
    : await env.DB.prepare(
        'SELECT id, counts, distance_km FROM trips WHERE user_id = ?1 AND to_lat = ?2 AND to_lng = ?3 AND created_at >= ?4 ORDER BY created_at DESC LIMIT 1',
      )
        .bind(user.id, toLat, toLng, new Date(now.getTime() - REPEAT_WINDOW_MS).toISOString())
        .first<{ id: string; counts: 'short' | 'long'; distance_km: number }>();
  const early = decideTrip(planId, straightKm, usage, isReplan(straightKm), true);
  if (!early.allowed && !recent) throw new HttpError(402, early.reason, early.message, { plan: planId, usage });

  const routeFn = router(env, await routeCaller(req));
  const route = await routeFn([from, to]);
  const repeat = recent && Math.abs(recent.distance_km - route.distanceKm) <= REPEAT_DISTANCE_KM ? recent : null;
  if (!early.allowed && !repeat) throw new HttpError(402, early.reason, early.message, { plan: planId, usage });
  const decision: TripDecision = repeat
    ? { allowed: true, counts: repeat.counts }
    : decideTrip(planId, route.distanceKm, usage, isReplan(route.distanceKm));
  if (!decision.allowed) {
    throw new HttpError(402, decision.reason, decision.message, { plan: planId, usage, distanceKm: Math.round(route.distanceKm) });
  }

  let id: string;
  if (repeat) {
    id = repeat.id;
  } else if (decision.counts === 'replan') {
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
      .bind(id, user.id, decision.counts, route.distanceKm, toLat, toLng, now.toISOString(), since, limit)
      .run();
    if ((res.meta.changes ?? 0) === 0) {
      const latest = await usageCounts(env, user.id, planId, now);
      const again = decideTrip(planId, route.distanceKm, latest, false);
      throw new HttpError(402, again.allowed ? 'long_quota_used' : again.reason, again.allowed ? 'Trip limit reached.' : again.message, { plan: planId, usage: latest });
    }
  }

  const [after, alts] = await Promise.all([
    usageCounts(env, user.id, planId, now),
    // Alternatives take up to six more routings each, too many to ask of the public server.
    body.alternatives === true && PLANS[planId].routeCompare && route.source !== 'valhalla' ? alternativeRoutes(env, from, to, route, router(env, undefined, false)) : null,
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
