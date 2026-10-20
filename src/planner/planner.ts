import type { Station } from '../data/model.ts';
import { liveState, timeAgo, type LiveState, type StationStatus } from '../shared/status.ts';
import { baseWhPerKm, type MyVehicle } from '../shared/vehicles.ts';
import { RouteIndex, type Coord, type RouteGeometry } from './geometry.ts';

export type DrivingStyle = 'eco' | 'normal' | 'fast';

export interface PlanOptions {
  startSocPct: number;
  /** Minimum charge on arrival at the destination. */
  arriveReservePct: number;
  /** Minimum charge on arrival at a charging stop. */
  stopReservePct: number;
  /** Normal charge target at a stop; the planner only goes above it to bridge a gap. */
  chargeToPct: number;
  acOn: boolean;
  extraPassengers: number;
  style: DrivingStyle;
}

export const DEFAULT_OPTIONS: PlanOptions = {
  startSocPct: 80,
  arriveReservePct: 15,
  stopReservePct: 10,
  chargeToPct: 80,
  acOn: true,
  extraPassengers: 1,
  style: 'normal',
};

export interface PlanInput {
  route: RouteGeometry;
  stations: Station[];
  statuses: Map<string, StationStatus>;
  vehicle: MyVehicle;
  options: PlanOptions;
  now: Date;
}

export type ChargeMode = 'dc' | 'ac';
export type Confidence = 'high' | 'medium' | 'low';

export interface Candidate {
  station: Station;
  alongKm: number;
  detourKm: number;
  mode: ChargeMode;
  powerKw: number;
  connectorVerified: boolean;
  live: LiveState;
  tier: 1 | 2 | 3;
}

export interface Backup {
  station: Station;
  alongKm: number;
  arriveSocPct: number;
  powerKw: number;
  mode: ChargeMode;
  live: LiveState;
}

export interface Stop {
  station: Station;
  lng: number;
  lat: number;
  alongKm: number;
  detourKm: number;
  arriveSocPct: number;
  departSocPct: number;
  chargeMinutes: number;
  energyKwh: number;
  costInr: number;
  powerKw: number;
  mode: ChargeMode;
  live: LiveState;
  confidence: Confidence;
  notes: string[];
  backups: Backup[];
}

export interface TripPlan {
  feasible: boolean;
  distanceKm: number;
  driveMinutes: number;
  chargeMinutes: number;
  arrivalSocPct: number;
  totalEnergyKwh: number;
  totalCostInr: number;
  stops: Stop[];
  warnings: string[];
  /** Where the car would run below reserve when the plan isn't feasible. */
  gapAtKm: number | null;
}

const CORRIDOR_KM = 3;
const WIDE_CORRIDOR_KM = 8;
const DEFAULT_DC_KW = 30;
const DEFAULT_AC_KW = 7.4;
const PRICE_PER_KWH: Record<ChargeMode, number> = { dc: 22, ac: 14 };
const CHARGING_LOSS = 0.9;
const STOP_OVERHEAD_MIN = 5;
const STYLE_FACTOR: Record<DrivingStyle, number> = { eco: 0.92, normal: 1, fast: 1.15 };
const PASSENGER_KG = 75;
const DRIVETRAIN_EFFICIENCY = 0.9;
const REGEN_EFFICIENCY = 0.6;

/** Cumulative kWh used from the start of the route to each vertex. */
export function cumulativeEnergy(
  index: RouteIndex,
  coords: Coord[],
  vehicle: MyVehicle,
  options: PlanOptions,
): number[] {
  const whPerKm =
    baseWhPerKm(vehicle) *
    STYLE_FACTOR[options.style] *
    (options.acOn ? 1 : 0.95) *
    (1 + 0.015 * options.extraPassengers);
  const massKg = vehicle.massKg + PASSENGER_KG * options.extraPassengers;
  const out = new Array<number>(coords.length);
  out[0] = 0;
  for (let i = 1; i < coords.length; i++) {
    const km = index.cumKm[i] - index.cumKm[i - 1];
    let kwh = (km * whPerKm) / 1000;
    const a = coords[i - 1][2];
    const b = coords[i][2];
    if (a !== undefined && b !== undefined) {
      const climbKwh = (massKg * 9.81 * (b - a)) / 3.6e6;
      kwh += climbKwh > 0 ? climbKwh / DRIVETRAIN_EFFICIENCY : climbKwh * REGEN_EFFICIENCY;
    }
    out[i] = out[i - 1] + Math.max(kwh, 0);
  }
  return out;
}

function energyAt(index: RouteIndex, cumKwh: number[], alongKm: number): number {
  const cum = index.cumKm;
  let lo = 0, hi = cum.length - 1;
  if (alongKm >= cum[hi]) return cumKwh[hi];
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (cum[mid] <= alongKm) lo = mid;
    else hi = mid;
  }
  const seg = cum[hi] - cum[lo];
  const t = seg === 0 ? 0 : (alongKm - cum[lo]) / seg;
  return cumKwh[lo] + t * (cumKwh[hi] - cumKwh[lo]);
}

export function chargeOption(
  station: Station,
  vehicle: MyVehicle,
): { mode: ChargeMode; powerKw: number; verified: boolean } | null {
  if (station.batterySwap) return null;
  if (station.vehicles.length > 0 && !station.vehicles.includes('car')) return null;

  if (vehicle.dcConnector && vehicle.maxDcKw) {
    const dc = station.connectors.find((c) => c.type === vehicle.dcConnector);
    if (dc) return { mode: 'dc', powerKw: Math.min(dc.kw ?? station.maxKw ?? DEFAULT_DC_KW, vehicle.maxDcKw), verified: true };
    if (station.connectors.length === 0 && station.speed === 'dc') {
      return { mode: 'dc', powerKw: Math.min(station.maxKw ?? DEFAULT_DC_KW, vehicle.maxDcKw), verified: false };
    }
  }
  const ac = station.connectors.find((c) => c.type === 'Type 2');
  if (ac) return { mode: 'ac', powerKw: Math.min(ac.kw ?? DEFAULT_AC_KW, vehicle.maxAcKw), verified: true };
  if (station.connectors.length === 0 && station.speed !== 'dc') {
    return { mode: 'ac', powerKw: Math.min(station.maxKw ?? DEFAULT_AC_KW, vehicle.maxAcKw), verified: false };
  }
  return null;
}

function tierFor(mode: ChargeMode, verified: boolean, live: LiveState): 1 | 2 | 3 {
  if (live === 'problem') return 3;
  if (mode === 'dc' && (verified || live === 'working')) return 1;
  if (mode === 'dc') return 2;
  return 3;
}

export function findCandidates(index: RouteIndex, input: PlanInput, maxOffKm: number): Candidate[] {
  const out: Candidate[] = [];
  for (const station of input.stations) {
    const option = chargeOption(station, input.vehicle);
    if (!option) continue;
    const p = index.project(station.lng, station.lat, maxOffKm);
    if (!p) continue;
    const live = liveState(input.statuses.get(station.id), input.now);
    out.push({
      station,
      alongKm: p.alongKm,
      // Road detour is longer than the straight line; 1.4 is a common circuity factor.
      detourKm: p.offKm * 1.4,
      mode: option.mode,
      powerKw: option.powerKw,
      connectorVerified: option.verified,
      live,
      tier: tierFor(option.mode, option.verified, live),
    });
  }
  return out.sort((a, b) => a.alongKm - b.alongKm);
}

/** Minutes to add energy between two charge levels; DC tapers sharply above 80%. */
export function chargeMinutes(
  fromPct: number,
  toPct: number,
  batteryKwh: number,
  powerKw: number,
  mode: ChargeMode,
): number {
  if (toPct <= fromPct) return 0;
  const lowEnd = Math.min(toPct, 80);
  const lowKwh = Math.max(0, lowEnd - fromPct) / 100 * batteryKwh;
  const highKwh = Math.max(0, toPct - Math.max(fromPct, 80)) / 100 * batteryKwh;
  const lowRate = mode === 'dc' ? powerKw * 0.8 : powerKw * 0.95;
  const highRate = mode === 'dc' ? powerKw * 0.35 : powerKw * 0.9;
  return ((lowKwh / lowRate + highKwh / highRate) * 60) / CHARGING_LOSS + STOP_OVERHEAD_MIN;
}

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

export function planTrip(input: PlanInput): TripPlan {
  const { route, vehicle, options } = input;
  const index = new RouteIndex(route.coords);
  const cumKwh = cumulativeEnergy(index, route.coords, vehicle, options);
  const totalKm = index.lengthKm || route.distanceKm;
  const destEnergy = cumKwh[cumKwh.length - 1] ?? 0;
  const cap = vehicle.batteryKwh;
  const pct = (kwh: number) => (kwh / cap) * 100;
  const kwhOf = (p: number) => (p / 100) * cap;

  let candidates = findCandidates(index, input, CORRIDOR_KM);
  const warnings: string[] = [];
  if (candidates.filter((c) => c.tier < 3).length < Math.floor(totalKm / 250)) {
    candidates = findCandidates(index, input, WIDE_CORRIDOR_KM);
    if (candidates.length) warnings.push('Few chargers sit right on this route, so some stops need a detour of a few km.');
  }

  const stops: Stop[] = [];
  let posKm = 0;
  let posEnergy = 0;
  let socKwh = kwhOf(options.startSocPct);
  let gapAtKm: number | null = null;
  const used = new Set<string>();

  const arrival = (c: Candidate, fromEnergy: number, fromSoc: number) => {
    const need = energyAt(index, cumKwh, c.alongKm) - fromEnergy + (c.detourKm * baseWhPerKm(vehicle)) / 1000;
    return fromSoc - need;
  };

  for (let guard = 0; guard < 40; guard++) {
    const toDest = destEnergy - posEnergy;
    if (socKwh - toDest >= kwhOf(options.arriveReservePct)) break;

    const reachable = candidates.filter(
      (c) => c.alongKm > posKm + 1 && !used.has(c.station.id) && arrival(c, posEnergy, socKwh) >= kwhOf(options.stopReservePct),
    );
    if (reachable.length === 0) {
      gapAtKm = posKm;
      break;
    }
    const farthest = reachable[reachable.length - 1].alongKm;
    let choice: Candidate | undefined;
    for (const tier of [1, 2, 3] as const) {
      const inTier = reachable.filter((c) => c.tier === tier);
      const best = inTier[inTier.length - 1];
      if (best && best.alongKm - posKm >= 0.5 * (farthest - posKm)) {
        choice = best;
        break;
      }
    }
    choice ??= reachable[reachable.length - 1];

    const arriveKwh = arrival(choice, posEnergy, socKwh);
    const stopEnergy = energyAt(index, cumKwh, choice.alongKm);
    const remaining = destEnergy - stopEnergy + (choice.detourKm * baseWhPerKm(vehicle)) / 1000;
    const needForDest = remaining + kwhOf(options.arriveReservePct) + kwhOf(5);

    let departPct: number;
    if (needForDest <= kwhOf(options.chargeToPct)) {
      departPct = Math.max(pct(needForDest), pct(arriveKwh) + 10, 40);
    } else {
      departPct = options.chargeToPct;
      const nextReachable = candidates.some(
        (c) => c.alongKm > choice.alongKm + 1 && arrival(c, stopEnergy, kwhOf(departPct)) >= kwhOf(options.stopReservePct),
      );
      if (!nextReachable) departPct = 100;
    }
    departPct = Math.min(100, Math.ceil(departPct / 5) * 5);
    const arrivePct = pct(arriveKwh);
    const minutes = chargeMinutes(arrivePct, departPct, cap, choice.powerKw, choice.mode);
    const energyKwh = kwhOf(departPct - arrivePct) / CHARGING_LOSS;
    const status = input.statuses.get(choice.station.id);

    const notes: string[] = [];
    if (choice.mode === 'dc') notes.push(`DC ${Math.round(choice.powerKw)} kW for your car`);
    else notes.push(`AC only (${round1(choice.powerKw)} kW), slow`);
    if (!choice.connectorVerified) notes.push('Connector type not confirmed on the map');
    if (status?.lastWorkedAt) notes.push(`Last charged fine ${timeAgo(status.lastWorkedAt, input.now)}`);
    if (choice.live === 'problem') notes.push('A problem was reported recently, so check the backup');
    if (choice.live === 'in_use') notes.push('Reported in use recently, so you may have to wait');
    if (departPct > options.chargeToPct) notes.push(`Charge to ${departPct}% to reach the next charger`);
    if (choice.detourKm >= 1) notes.push(`${round1(choice.detourKm)} km off the route`);

    const confidence: Confidence =
      choice.tier === 1 && (choice.live === 'working' || choice.live === 'in_use')
        ? 'high'
        : choice.tier === 1 || (choice.tier === 2 && choice.live !== 'problem')
          ? 'medium'
          : 'low';

    const backups: Backup[] = candidates
      .filter((c) => c.station.id !== choice.station.id && c.alongKm > posKm + 1 && c.tier <= 2)
      .map((c) => ({ c, arrive: arrival(c, posEnergy, socKwh) }))
      .filter(({ arrive }) => arrive >= kwhOf(5))
      .sort((a, b) => a.c.tier - b.c.tier || Math.abs(a.c.alongKm - choice.alongKm) - Math.abs(b.c.alongKm - choice.alongKm))
      .slice(0, 2)
      .map(({ c, arrive }) => ({
        station: c.station,
        alongKm: round1(c.alongKm),
        arriveSocPct: Math.round(pct(arrive)),
        powerKw: Math.round(c.powerKw),
        mode: c.mode,
        live: c.live,
      }));
    if (backups.length === 0) notes.push('No backup charger within reach. Charge a little extra at the previous stop.');

    stops.push({
      station: choice.station,
      lng: choice.station.lng,
      lat: choice.station.lat,
      alongKm: round1(choice.alongKm),
      detourKm: round1(choice.detourKm),
      arriveSocPct: Math.round(arrivePct),
      departSocPct: departPct,
      chargeMinutes: Math.round(minutes),
      energyKwh: round1(energyKwh),
      costInr: Math.round(energyKwh * PRICE_PER_KWH[choice.mode]),
      powerKw: Math.round(choice.powerKw),
      mode: choice.mode,
      live: choice.live,
      confidence,
      notes,
      backups,
    });
    used.add(choice.station.id);
    posKm = choice.alongKm;
    posEnergy = stopEnergy;
    socKwh = kwhOf(departPct);
  }

  const arrivalKwh = socKwh - (destEnergy - posEnergy);
  const feasible = gapAtKm === null && arrivalKwh >= kwhOf(Math.min(options.arriveReservePct, 5));
  if (!feasible) {
    const at = gapAtKm ?? posKm;
    warnings.unshift(
      `Not safe to drive as planned: there's no known compatible charger in reach after km ${Math.round(at)}. ` +
        'Start with more charge, pick a different route, or add a charger you know on this route.',
    );
  } else if (arrivalKwh < kwhOf(options.arriveReservePct)) {
    warnings.push(`You'd arrive with about ${Math.round(pct(arrivalKwh))}%, below your ${options.arriveReservePct}% reserve.`);
  }
  const lowStops = stops.filter((s) => s.confidence === 'low');
  if (lowStops.length) {
    warnings.push(
      lowStops.some((s) => s.backups.length > 0)
        ? 'Some stops have little or poor recent data. Keep the backup chargers in mind.'
        : 'Some stops have little recent data and no backup nearby. Check recent reports or call the operator before relying on them.',
    );
  }

  const chargeMins = stops.reduce((a, s) => a + s.chargeMinutes, 0);
  const totalEnergy = stops.reduce((a, s) => a + s.energyKwh, 0);
  return {
    feasible,
    distanceKm: round1(totalKm),
    driveMinutes: Math.round(route.durationMin),
    chargeMinutes: chargeMins,
    arrivalSocPct: Math.round(pct(arrivalKwh)),
    totalEnergyKwh: round1(totalEnergy),
    totalCostInr: stops.reduce((a, s) => a + s.costInr, 0),
    stops,
    warnings,
    gapAtKm: feasible ? null : Math.round(gapAtKm ?? posKm),
  };
}

/** Google Maps directions with charging stops as waypoints (the URL API allows up to 9). */
export function navigationUrl(from: { lat: number; lng: number }, to: { lat: number; lng: number }, stops: Stop[]): string {
  const params = new URLSearchParams({
    api: '1',
    origin: `${from.lat},${from.lng}`,
    destination: `${to.lat},${to.lng}`,
    travelmode: 'driving',
  });
  if (stops.length) params.set('waypoints', stops.slice(0, 9).map((s) => `${s.lat},${s.lng}`).join('|'));
  return `https://www.google.com/maps/dir/?${params}`;
}
