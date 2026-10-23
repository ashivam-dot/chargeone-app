import { BASIC, type UsageCounts } from '../src/shared/plans.ts';
import type { Env } from './env.ts';
import {
  HttpError,
  claimSlot,
  clientKey,
  enforceRateLimit,
  indianDayStart,
  latLngInIndia,
  readJson,
  releaseSlot,
  requireDevice,
  slotCount,
  type LatLng,
} from './http.ts';
import { compactCoords, router, type RouteResult } from './routing.ts';
import { distanceMetres } from './stations.ts';

/** Phones on one Wi-Fi or carrier IP share this many Basic trips a day. */
export const BASIC_TRIPS_PER_IP = 3;
const ROUTES_PER_IP_PER_HOUR = 20;
/**
 * Routing calls a network may make for Basic a day: its trips plus a few that find no road or turn
 * out too long. Those use the shared keyless router without counting as a trip, so without this a
 * guest could spend the network's whole public-router share on them.
 */
export const BASIC_ROUTINGS_PER_IP = BASIC_TRIPS_PER_IP + 5;
/** Longest Basic trip; null = any distance. */
const MAX_KM: number | null = BASIC.maxTripKm;

const deviceSlot = (device: string) => `basic-dev:${device}`;
const ipSlot = (ip: string) => `basic-ip:${ip}`;
const routingSlot = (ip: string) => `basic-route-ip:${ip}`;

/** Basic trips planned today on this device. */
export async function basicTripsToday(env: Env, device: string, now = new Date()): Promise<number> {
  return slotCount(env.DB, deviceSlot(device), indianDayStart(now));
}

const usage = (n: number): UsageCounts => ({ shortToday: n, longInWindow: 0 });

const COVERS = `Basic covers ${BASIC.shortTripsPerDay} trip${MAX_KM === null ? '' : ` up to ${MAX_KM} km`} a day`;

/** km is the road distance, or the straight line (which the road can only exceed) before routing. */
function tooLong(km: number, straightLine: boolean): HttpError {
  const rounded = Math.round(km);
  return new HttpError(402, 'too_long', `${COVERS}; this trip is ${straightLine ? 'at least ' : ''}${rounded} km.`, {
    tier: 'basic',
    limitKm: MAX_KM,
    distanceKm: rounded,
    straightLine,
  });
}

function dailyLimit(used: number, scope: 'device' | 'network'): HttpError {
  const why =
    scope === 'device'
      ? "and this phone has used today's trip"
      : `and phones on this network have used today's ${BASIC_TRIPS_PER_IP} between them`;
  return new HttpError(402, 'daily_limit', `${COVERS}, ${why}. It resets at midnight, India time.`, {
    tier: 'basic',
    scope,
    usage: usage(used),
  });
}

/**
 * A trip without signing in. There is no account, so trips are counted per install (the device
 * header) and per network, and only a successful routing uses one. No re-plans or alternatives.
 */
export async function planBasicRoute(req: Request, env: Env) {
  const device = await requireDevice(req);
  const body = await readJson(req, 2048);
  const from = latLngInIndia(body, 'from');
  const to = latLngInIndia(body, 'to');
  const ip = await clientKey(req);
  await enforceRateLimit(env.DB, `route-ip:${ip}`, ROUTES_PER_IP_PER_HOUR, 3600);

  const straightKm = distanceMetres(from, to) / 1000;
  if (straightKm < 0.5) throw new HttpError(400, 'too_short', 'Start and destination are the same place.');
  if (MAX_KM !== null && straightKm > MAX_KM) throw tooLong(straightKm, true);

  const day = indianDayStart();
  // The same trip again today (a retry after the answer was lost on a weak signal, or the planner
  // reopened) is the trip already counted, so it is routed again without using another one.
  const sameTrip = tripSlot(device, from, to);
  if ((await slotCount(env.DB, sameTrip, day)) > 0) {
    const route = await routeOnce(req, env, ip, day, from, to);
    return answer(route, await slotCount(env.DB, deviceSlot(device), day));
  }
  const [used, ipUsed] = await Promise.all([slotCount(env.DB, deviceSlot(device), day), slotCount(env.DB, ipSlot(ip), day)]);
  if (used >= BASIC.shortTripsPerDay) throw dailyLimit(used, 'device');
  if (ipUsed >= BASIC_TRIPS_PER_IP) throw dailyLimit(used, 'network');

  const route = await routeOnce(req, env, ip, day, from, to);

  const count = await claimSlot(env.DB, deviceSlot(device), BASIC.shortTripsPerDay, day);
  if (count === null) throw dailyLimit(BASIC.shortTripsPerDay, 'device');
  if ((await claimSlot(env.DB, ipSlot(ip), BASIC_TRIPS_PER_IP, day)) === null) {
    await releaseSlot(env.DB, deviceSlot(device), day);
    throw dailyLimit(count - 1, 'network');
  }
  await claimSlot(env.DB, sameTrip, 1, day);
  return answer(route, count);
}

/** The trip's two ends to ~10 m, so a retry of the same request matches and a different trip doesn't. */
const tripSlot = (device: string, from: LatLng, to: LatLng) =>
  `basic-trip:${device}:${[from, to].map((p) => `${p.lat.toFixed(4)},${p.lng.toFixed(4)}`).join(';')}`;

/** One routing call for Basic, held against the network's daily share unless no answer came back. */
async function routeOnce(req: Request, env: Env, ip: string, day: number, from: LatLng, to: LatLng): Promise<RouteResult> {
  if ((await claimSlot(env.DB, routingSlot(ip), BASIC_ROUTINGS_PER_IP, day)) === null) {
    throw new HttpError(429, 'rate_limited', "This network has tried a lot of routes today that Basic doesn't cover. Please try again tomorrow.");
  }
  let route;
  try {
    route = await router(env, { ip, origin: new URL(req.url).origin })([from, to]);
  } catch (err) {
    // Busy or out of capacity: no answer came back, so the attempt isn't held against the network.
    if (!(err instanceof HttpError) || err.status === 429 || err.status >= 500) await releaseSlot(env.DB, routingSlot(ip), day);
    throw err;
  }
  if (MAX_KM !== null && route.distanceKm > MAX_KM) throw tooLong(route.distanceKm, false);
  return route;
}

const answer = (route: RouteResult, count: number) => ({
  tripId: crypto.randomUUID(),
  counted: 'short' as const,
  route: { ...route, coords: compactCoords(route.coords) },
  plan: 'free' as const,
  usage: usage(count),
});
