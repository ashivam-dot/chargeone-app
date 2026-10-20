import { BASIC, FREE_TRIP_KM, PLANS, TRIAL_DAYS, type UsageCounts } from '../src/shared/plans.ts';
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
} from './http.ts';
import { compactCoords, router } from './routing.ts';
import { distanceMetres } from './stations.ts';

/** Phones on one Wi-Fi or carrier IP share this many Basic trips a day. */
export const BASIC_TRIPS_PER_IP = 3;
const ROUTES_PER_IP_PER_HOUR = 20;
const MAX_KM = BASIC.maxTripKm ?? FREE_TRIP_KM;

const deviceSlot = (device: string) => `basic-dev:${device}`;
const ipSlot = (ip: string) => `basic-ip:${ip}`;

/** Basic trips planned today on this device. */
export async function basicTripsToday(env: Env, device: string, now = new Date()): Promise<number> {
  return slotCount(env.DB, deviceSlot(device), indianDayStart(now));
}

const usage = (n: number): UsageCounts => ({ shortToday: n, longInWindow: 0 });

function tooLong(): HttpError {
  return new HttpError(
    402,
    'sign_in_required',
    `Basic plans trips up to ${MAX_KM} km. Sign in free for longer trips, or try Plus free for ${TRIAL_DAYS} days.`,
    { tier: 'basic' },
  );
}

function dailyLimit(used: number): HttpError {
  return new HttpError(
    402,
    'daily_limit',
    `Basic includes ${BASIC.shortTripsPerDay} trip plan a day. Sign in free for ${PLANS.free.shortTripsPerDay} a day.`,
    { tier: 'basic', plan: 'free', usage: usage(used) },
  );
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
  if (straightKm > MAX_KM) throw tooLong();

  const day = indianDayStart();
  const [used, ipUsed] = await Promise.all([slotCount(env.DB, deviceSlot(device), day), slotCount(env.DB, ipSlot(ip), day)]);
  if (used >= BASIC.shortTripsPerDay || ipUsed >= BASIC_TRIPS_PER_IP) throw dailyLimit(used);

  const route = await router(env)([from, to]);
  if (route.distanceKm > MAX_KM) throw tooLong();

  const count = await claimSlot(env.DB, deviceSlot(device), BASIC.shortTripsPerDay, day);
  if (count === null) throw dailyLimit(BASIC.shortTripsPerDay);
  if ((await claimSlot(env.DB, ipSlot(ip), BASIC_TRIPS_PER_IP, day)) === null) {
    await releaseSlot(env.DB, deviceSlot(device), day);
    throw dailyLimit(count - 1);
  }
  return {
    tripId: crypto.randomUUID(),
    counted: 'short' as const,
    route: { ...route, coords: compactCoords(route.coords) },
    plan: 'free' as const,
    usage: usage(count),
  };
}
