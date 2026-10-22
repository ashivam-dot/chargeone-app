import { FREE_TRIP_KM, MAX_REPLANS_PER_TRIP, PLANS, REPLAN_WINDOW_HOURS, decideTrip } from '../src/shared/plans.ts';
import type { RouteAlternativeWire } from '../src/shared/contracts.ts';
import type { Coord } from '../src/planner/geometry.ts';
import { alternativeRoutes } from './alternatives.ts';
import type { User } from './auth.ts';
import { currentPlan, quotaWindows, usageCounts } from './entitlements.ts';
import { isDev, type Env } from './env.ts';
import { HttpError, claimSlot, clientKey, enforceRateLimit, indianDayStart, latLngInIndia, readJson, releaseSlot, str, type LatLng } from './http.ts';
import { distanceMetres } from './stations.ts';

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
/** Per network (hashed IP) a day, so one script can't use up everyone's share. */
export const PUBLIC_ROUTES_PER_IP_PER_DAY = 25;
/** Identical requests (same points to ~10 m) are answered from the edge cache for this long. */
const PUBLIC_CACHE_SECONDS = 3 * 86400;
const PUBLIC_TIMEOUT_MS = 15_000;
const SAME_DESTINATION_M = 2000;
/** Detours after a failed charger can add some distance to the remaining route. */
const REPLAN_DISTANCE_SLACK = 0.15;
const REPLAN_DISTANCE_EXTRA_KM = 10;

export type RouteSource = 'ors' | 'valhalla' | 'osrm';

export interface RouteResult {
  coords: Coord[];
  distanceKm: number;
  durationMin: number;
  hasElevation: boolean;
  /** Which router drew it; the app shows the matching attribution. */
  source?: RouteSource;
}

/** Computes a road route through the points in order (start, any via points, destination). */
export type RouteFn = (points: LatLng[], signal?: AbortSignal) => Promise<RouteResult>;

/** Who is asking, for the public router's per-network cap and Referer. */
export interface RouteCaller {
  /** Hashed client IP (clientKey). */
  ip: string;
  origin: string;
}

const BUSY = () => new HttpError(502, 'routing_unavailable', 'The route service is busy. Please try again in a minute.');
const NO_ROUTE = () => new HttpError(422, 'no_route', 'No road route found between these places.');

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
  if (res.status === 404 || res.status === 400) throw NO_ROUTE();
  if (!res.ok) throw BUSY();
  const data = (await res.json()) as {
    features?: Array<{ geometry: { coordinates: Coord[] }; properties: { summary: { distance?: number; duration?: number } } }>;
  };
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
  const res = await fetch(url, { headers: { 'User-Agent': 'ChargeOne-dev/0.1' }, signal });
  if (!res.ok) throw BUSY();
  const data = (await res.json()) as {
    code: string;
    routes?: Array<{ distance: number; duration: number; geometry: { coordinates: Coord[] } }>;
  };
  const r = data.routes?.[0];
  if (data.code !== 'Ok' || !r) throw NO_ROUTE();
  return { coords: r.geometry.coordinates, distanceKm: r.distance / 1000, durationMin: r.duration / 60, hasElevation: false, source: 'osrm' };
}

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

interface ValhallaReply {
  trip?: { status?: number; summary?: { length?: number; time?: number }; legs?: Array<{ shape?: string }> };
  error_code?: number;
}

/** Turns a Valhalla /route reply into a route. Valhalla has no elevation on /route, so plans assume flat roads. */
export function parseValhalla(status: number, body: unknown): RouteResult {
  const data = (body ?? {}) as ValhallaReply;
  // 4xx carries an error_code: 442 no path, 171 no road near a point, 154 too long for the server.
  if (status === 400 || status === 404) throw NO_ROUTE();
  if (status !== 200 || !data.trip || data.trip.status !== 0) throw BUSY();
  const coords: Coord[] = [];
  for (const leg of data.trip.legs ?? []) {
    const pts = decodePolyline(leg.shape ?? '');
    // Each leg starts where the last one ended.
    coords.push(...(coords.length ? pts.slice(1) : pts));
  }
  const km = data.trip.summary?.length;
  if (coords.length < 2 || typeof km !== 'number') throw NO_ROUTE();
  return { coords, distanceKm: km, durationMin: (data.trip.summary?.time ?? 0) / 60, hasElevation: false, source: 'valhalla' };
}

/** The edge cache exists only on Cloudflare; tests and Node run without it. */
const edgeCache = (): Cache | null => (typeof caches === 'undefined' ? null : caches.default);
const cacheKey = (points: LatLng[]) =>
  `https://chargeone.internal/route/valhalla/${points.map((p) => `${p.lat.toFixed(4)},${p.lng.toFixed(4)}`).join(';')}`;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Takes one of the day's public routing calls and waits for this second's single slot. */
async function publicSlot(env: Env, caller: RouteCaller | undefined): Promise<void> {
  const day = indianDayStart();
  const ipKey = caller ? `public-route-ip:${caller.ip}` : null;
  if (ipKey && (await claimSlot(env.DB, ipKey, PUBLIC_ROUTES_PER_IP_PER_DAY, day)) === null) {
    throw new HttpError(429, 'rate_limited', 'This network has planned a lot of routes today. Please try again tomorrow.');
  }
  if ((await claimSlot(env.DB, 'public-route:day', PUBLIC_ROUTES_PER_DAY, day)) === null) {
    if (ipKey) await releaseSlot(env.DB, ipKey, day);
    throw new HttpError(503, 'routing_unavailable', "Free route planning has reached today's limit for everyone. Please try again tomorrow.");
  }
  for (let tries = 0; tries < 4; tries++) {
    if ((await claimSlot(env.DB, 'public-route:second', 1, Math.floor(Date.now() / 1000))) !== null) return;
    await sleep(1000 - (Date.now() % 1000) + 20);
  }
  throw BUSY();
}

async function routeWithValhalla(env: Env, points: LatLng[], caller: RouteCaller | undefined, signal?: AbortSignal): Promise<RouteResult> {
  const cache = edgeCache();
  const key = cacheKey(points);
  const hit = await cache?.match(key);
  if (hit) return (await hit.json()) as RouteResult;

  await publicSlot(env, caller);
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
        directions_type: 'none',
        shape_format: 'polyline6',
      }),
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(PUBLIC_TIMEOUT_MS)]) : AbortSignal.timeout(PUBLIC_TIMEOUT_MS),
    });
  } catch {
    throw BUSY();
  }
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
  const early = decideTrip(planId, straightKm, usage, isReplan(straightKm), true);
  if (!early.allowed) throw new HttpError(402, early.reason, early.message, { plan: planId, usage });

  const routeFn = router(env, await routeCaller(req));
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
