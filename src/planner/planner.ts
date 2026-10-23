import type { Station } from '../data/model.ts';
import { PLAN_MIN_CONFIDENCE, trustScore } from '../data/trust.ts';
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
  /**
   * Also plan stops at chargers we're not sure of (trust below PLAN_MIN_CONFIDENCE, plug not confirmed,
   * or AC when the car takes DC). Off by default: the driver opts in after seeing the extra options.
   */
  allowUnverified?: boolean;
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
  /** One day of a longer trip: names its ends and the km offset of its start in the warnings. */
  leg?: { offsetKm: number; startName: string; endName: string };
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
  /** trustScore: pipeline confidence plus recent driver reports. */
  trust: number;
  /** Good enough to plan a stop at: see isTrusted. */
  trusted: boolean;
}

export interface Backup {
  station: Station;
  alongKm: number;
  arriveSocPct: number;
  powerKw: number;
  mode: ChargeMode;
  live: LiveState;
  trusted: boolean;
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
  /** A charger we're fairly sure of. False only when the driver allowed unverified stops. */
  trusted: boolean;
  /** The first stop after a gap: planned as if the driver got past it on the stop reserve. */
  afterGap?: boolean;
  notes: string[];
  backups: Backup[];
}

/** A stretch with no charger we're sure of in reach. Planning carries on after it. */
export interface ChargeGap {
  /** Km along this plan's route where the confirmed chargers run out: the last stop, or the start. */
  fromKm: number;
  /** The next confirmed charger after the gap, or the destination when there is none. */
  toKm: number;
  /** Null for the start of the trip. */
  fromName: string | null;
  /** Null when no confirmed charger follows: the gap runs to the destination. */
  toName: string | null;
  toStationId: string | null;
  /** Chargers inside the gap we can't vouch for (location only, unverified, or plug not confirmed). */
  unconfirmed: Array<{
    station: Station;
    alongKm: number;
    mode: ChargeMode;
    powerKw: number;
  }>;
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
  /** Where the confirmed chargers first run out when the plan isn't feasible. */
  gapAtKm: number | null;
  /** Every stretch without a confirmed charger in reach, in driving order; the plan continues past each. */
  gaps: ChargeGap[];
  /** Compatible chargers near this road: ones we'd plan a stop at, and ones we can't vouch for. */
  coverage: { confirmed: number; unconfirmed: number };
  /**
   * When chargers we're sure of can't cover the trip: the unverified chargers a plan would also need.
   * Shown as "extra options" only; never planned unless the driver sets allowUnverified.
   */
  extras: Stop[];
  /** Whether the trip works once the extra options are allowed. */
  extrasFeasible: boolean;
}

const CORRIDOR_KM = 3;
const WIDE_CORRIDOR_KM = 8;
const DEFAULT_DC_KW = 30;
const DEFAULT_AC_KW = 7.4;
const PRICE_PER_KWH: Record<ChargeMode, number> = { dc: 22, ac: 14 };
const CHARGING_LOSS = 0.9;
const STOP_OVERHEAD_MIN = 5;
const STYLE_FACTOR: Record<DrivingStyle, number> = {
  eco: 0.92,
  normal: 1,
  fast: 1.15,
};
const PASSENGER_KG = 75;
const DRIVETRAIN_EFFICIENCY = 0.9;
const REGEN_EFFICIENCY = 0.6;

/** Cumulative kWh used from the start of the route to each vertex. */
export function cumulativeEnergy(index: RouteIndex, coords: Coord[], vehicle: MyVehicle, options: PlanOptions): number[] {
  const whPerKm = baseWhPerKm(vehicle) * STYLE_FACTOR[options.style] * (options.acOn ? 1 : 0.95) * (1 + 0.015 * options.extraPassengers);
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
  let lo = 0,
    hi = cum.length - 1;
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

export function chargeOption(station: Station, vehicle: MyVehicle): { mode: ChargeMode; powerKw: number; verified: boolean } | null {
  if (station.batterySwap) return null;
  if (station.vehicles.length > 0 && !station.vehicles.includes('car')) return null;

  if (vehicle.dcConnector && vehicle.maxDcKw) {
    const dc = station.connectors.find((c) => c.type === vehicle.dcConnector);
    if (dc)
      return {
        mode: 'dc',
        powerKw: Math.min(dc.kw ?? station.maxKw ?? DEFAULT_DC_KW, vehicle.maxDcKw),
        verified: true,
      };
    if (station.connectors.length === 0 && station.speed === 'dc') {
      return {
        mode: 'dc',
        powerKw: Math.min(station.maxKw ?? DEFAULT_DC_KW, vehicle.maxDcKw),
        verified: false,
      };
    }
  }
  const ac = station.connectors.find((c) => c.type === 'Type 2');
  if (ac)
    return {
      mode: 'ac',
      powerKw: Math.min(ac.kw ?? DEFAULT_AC_KW, vehicle.maxAcKw),
      verified: true,
    };
  if (station.connectors.length === 0 && station.speed !== 'dc') {
    return {
      mode: 'ac',
      powerKw: Math.min(station.maxKw ?? DEFAULT_AC_KW, vehicle.maxAcKw),
      verified: false,
    };
  }
  return null;
}

/**
 * A charger we'd plan a stop at: trusted (PLAN_MIN_CONFIDENCE), the car's plug confirmed, no recent
 * problem, open to the public (a hotel's or showroom's own charger may turn a passing driver away),
 * and DC, unless the car can only charge on AC.
 */
export function isTrusted(
  mode: ChargeMode,
  verified: boolean,
  live: LiveState,
  trust: number,
  vehicle: MyVehicle,
  access: Station['access'] = 'unknown',
): boolean {
  if (live === 'problem' || !verified || trust < PLAN_MIN_CONFIDENCE || access === 'customers') return false;
  return mode === 'dc' || !(vehicle.dcConnector && vehicle.maxDcKw);
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
    const status = input.statuses.get(station.id);
    const live = liveState(status, input.now);
    const trust = trustScore(station, status, input.now);
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
      trust,
      trusted: isTrusted(option.mode, option.verified, live, trust, input.vehicle, station.access),
    });
  }
  return out.sort((a, b) => a.alongKm - b.alongKm);
}

/** Minutes to add energy between two charge levels; DC tapers sharply above 80%. */
export function chargeMinutes(fromPct: number, toPct: number, batteryKwh: number, powerKw: number, mode: ChargeMode): number {
  if (toPct <= fromPct) return 0;
  const lowEnd = Math.min(toPct, 80);
  const lowKwh = (Math.max(0, lowEnd - fromPct) / 100) * batteryKwh;
  const highKwh = (Math.max(0, toPct - Math.max(fromPct, 80)) / 100) * batteryKwh;
  const lowRate = mode === 'dc' ? powerKw * 0.8 : powerKw * 0.95;
  const highRate = mode === 'dc' ? powerKw * 0.35 : powerKw * 0.9;
  return ((lowKwh / lowRate + highKwh / highRate) * 60) / CHARGING_LOSS + STOP_OVERHEAD_MIN;
}

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

/** Minutes a stop costs beyond charging: parking, plugging in, paying. Makes the search prefer fewer stops. */
const STOP_PENALTY_MIN = 10;
/** A small pull towards a later final stop, in minutes per km along the route. */
const LAST_STOP_BIAS_MIN_PER_KM = 0.03;
/** Minutes per km of detour to a charger off the route (about 40 km/h on side roads), each way. */
const DETOUR_MIN_PER_KM = 1.5;
/** Most charging stops a plan may hold, across every gap. */
const MAX_STOPS = 40;

/** One way to arrive at and leave a charger in the stop search. */
interface Label {
  i: number;
  /** Minutes spent stopping so far (charging, detours, the per-stop cost): what the search minimises. */
  cost: number;
  stops: number;
  arriveKwh: number;
  departPct: number;
  /** Charge back on the route after the stop. */
  socKwh: number;
  kind: 'dest' | 'to' | 'full';
  prev: Label | null;
}

interface Pass {
  stops: Stop[];
  gaps: ChargeGap[];
  reached: boolean;
  posKm: number;
  posEnergy: number;
  socKwh: number;
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
  const strict = !options.allowUnverified;
  const detourKwhOf = (c: Candidate) => (c.detourKm * baseWhPerKm(vehicle)) / 1000;

  let candidates = findCandidates(index, input, CORRIDOR_KM);
  const warnings: string[] = [];
  const usable = (list: Candidate[]) => list.filter((c) => (strict ? c.trusted : c.tier < 3));
  const needsCharge = kwhOf(options.startSocPct) - destEnergy < kwhOf(options.arriveReservePct);
  if (needsCharge && usable(candidates).length < Math.max(1, Math.floor(totalKm / 250))) {
    const wide = findCandidates(index, input, WIDE_CORRIDOR_KM);
    if (usable(wide).length > usable(candidates).length) {
      candidates = wide;
      warnings.push('Few chargers sit right on this route, so some stops need a detour of a few km.');
    }
  }

  // Backups come from every compatible charger without a recent problem, ours-to-trust first.
  const backupPool = candidates.filter((c) => c.live !== 'problem' && (c.trusted || c.tier <= 2));
  // A charger a driver just reported broken is never a stop, even among the extra options: it is
  // only ever shown as a warning on the map.
  const plannable = candidates.filter((c) => c.live !== 'problem');
  const mainPool = strict ? plannable.filter((c) => c.trusted) : plannable;
  const main = search(mainPool);
  let extras: Stop[] = [];
  let extrasFeasible = false;
  if (strict && (!main.reached || main.gaps.length > 0)) {
    const loose = search(plannable);
    extras = loose.stops.filter((s) => !s.trusted);
    extrasFeasible = loose.reached && loose.gaps.length === 0;
  }
  return finish(main);

  /**
   * The quickest set of stops: a search over every charger in reach and a few charge levels at each
   * (just enough for the destination, the usual target, or full), minimising time spent stopping.
   * Where no charger in the pool is in reach, the gap is recorded and the search starts again at the
   * next charger after it, so the rest of the trip is still planned.
   */
  function search(pool: Candidate[]): Pass {
    const energyOf = pool.map((c) => energyAt(index, cumKwh, c.alongKm));
    const detourKwh = pool.map(detourKwhOf);
    const reserveKwh = kwhOf(options.stopReservePct);
    const destOk = (socKwh: number, energy: number) => socKwh - (destEnergy - energy) >= kwhOf(options.arriveReservePct);
    const stops: Stop[] = [];
    const gaps: ChargeGap[] = [];
    let origin = {
      km: 0,
      energy: 0,
      socKwh: kwhOf(options.startSocPct),
      name: null as string | null,
    };
    let forced: { i: number; arriveKwh: number } | null = null;

    for (let segment = 0; segment < 20; segment++) {
      if (!forced && destOk(origin.socKwh, origin.energy))
        return {
          stops,
          gaps,
          reached: true,
          posKm: origin.km,
          posEnergy: origin.energy,
          socKwh: origin.socKwh,
        };
      const labels: Label[][] = pool.map(() => []);
      const expand = (i: number, arriveKwh: number, prev: Label | null) => {
        const c = pool[i];
        const arrivePct = pct(arriveKwh);
        const needForDest = destEnergy - energyOf[i] + detourKwh[i] + kwhOf(options.arriveReservePct) + kwhOf(5);
        const choices: Array<[Label['kind'], number]> = [];
        if (needForDest <= kwhOf(100)) choices.push(['dest', Math.max(pct(needForDest), arrivePct + 10, 40)]);
        if (needForDest > kwhOf(options.chargeToPct)) choices.push(['to', options.chargeToPct], ['full', 100]);
        for (const [kind, raw] of choices) {
          const departPct = Math.min(100, Math.ceil(raw / 5) * 5);
          if (departPct <= arrivePct + 1) continue;
          const cost =
            (prev?.cost ?? 0) +
            chargeMinutes(arrivePct, departPct, cap, c.powerKw, c.mode) +
            c.detourKm * 2 * DETOUR_MIN_PER_KM +
            STOP_PENALTY_MIN +
            (c.tier - 1) * 10 +
            (c.live === 'in_use' ? 10 : 0) -
            (c.live === 'working' ? 3 : 0) -
            // Near-ties go to the later last stop: the chargers passed on the way are its backups.
            (kind === 'dest' ? LAST_STOP_BIAS_MIN_PER_KM * (c.alongKm - (prev ? pool[prev.i].alongKm : origin.km)) : 0);
          const label: Label = {
            i,
            cost,
            stops: (prev?.stops ?? 0) + 1,
            arriveKwh,
            departPct,
            socKwh: kwhOf(departPct) - detourKwh[i],
            kind,
            prev,
          };
          const at = labels[i].findIndex((l) => l.kind === kind);
          if (at < 0) labels[i].push(label);
          else if (cost < labels[i][at].cost) labels[i][at] = label;
        }
      };
      for (let i = 0; i < pool.length; i++) {
        if (pool[i].alongKm <= origin.km + 1 && !(forced && forced.i === i)) continue;
        if (forced) {
          if (forced.i === i) expand(i, forced.arriveKwh, null);
        } else {
          const arrive = origin.socKwh - (energyOf[i] - origin.energy) - detourKwh[i];
          if (arrive >= reserveKwh) expand(i, arrive, null);
        }
        for (let j = i - 1; j >= 0; j--) {
          if (energyOf[i] - energyOf[j] > cap) break;
          if (pool[i].alongKm <= pool[j].alongKm + 1) continue;
          for (const l of labels[j]) {
            const arrive = l.socKwh - (energyOf[i] - energyOf[j]) - detourKwh[i];
            if (arrive >= reserveKwh) expand(i, arrive, l);
          }
        }
      }

      let best: Label | null = null;
      for (const list of labels) {
        for (const l of list) {
          if (destOk(l.socKwh, energyOf[l.i]) && (!best || l.cost < best.cost || (l.cost === best.cost && l.stops < best.stops))) best = l;
        }
      }
      if (best) {
        const last = emit(best);
        return { stops, gaps, reached: true, ...last };
      }

      // No way to the destination on this pool: go as far as the chargers allow, then record the gap.
      let far: Label | null = null;
      for (let i = labels.length - 1; i >= 0 && !far; i--) {
        for (const l of labels[i]) if (!far || l.socKwh > far.socKwh || (l.socKwh === far.socKwh && l.cost < far.cost)) far = l;
      }
      const at = far ? emit(far) : { posKm: origin.km, posEnergy: origin.energy, socKwh: origin.socKwh };
      const fromName = far ? pool[far.i].station.name : origin.name;
      const next = pool.findIndex((c, k) => c.alongKm > at.posKm + 1 && (!far || k > far.i));
      const toKm = next >= 0 ? pool[next].alongKm : totalKm;
      gaps.push({
        fromKm: round1(at.posKm),
        toKm: round1(toKm),
        fromName,
        toName: next >= 0 ? pool[next].station.name : null,
        toStationId: next >= 0 ? pool[next].station.id : null,
        unconfirmed: plannable
          .filter((c) => !pool.includes(c) && c.alongKm > at.posKm && c.alongKm < toKm)
          .slice(0, 6)
          .map((c) => ({
            station: c.station,
            alongKm: round1(c.alongKm),
            mode: c.mode,
            powerKw: Math.round(c.powerKw),
          })),
      });
      if (next < 0 || stops.length >= MAX_STOPS) return { stops, gaps, reached: false, ...at };
      // Planning carries on from the next charger after the gap, as if the driver gets there on the stop reserve.
      origin = {
        km: at.posKm,
        energy: at.posEnergy,
        socKwh: at.socKwh,
        name: fromName,
      };
      forced = { i: next, arriveKwh: reserveKwh };
    }
    return {
      stops,
      gaps,
      reached: false,
      posKm: origin.km,
      posEnergy: origin.energy,
      socKwh: origin.socKwh,
    };

    /** Turns a chain of labels into stops, in driving order; returns where the car is after the last one. */
    function emit(end: Label) {
      const chain: Label[] = [];
      for (let l: Label | null = end; l; l = l.prev) chain.unshift(l);
      let posKm = origin.km;
      let posEnergy = origin.energy;
      let socKwh = origin.socKwh;
      const afterGap = forced !== null;
      chain.forEach((l, k) => {
        const c = pool[l.i];
        stops.push(makeStop(c, l.arriveKwh, l.departPct, posKm, posEnergy, socKwh, afterGap && k === 0));
        posKm = c.alongKm;
        posEnergy = energyOf[l.i];
        socKwh = l.socKwh;
      });
      forced = null;
      return { posKm, posEnergy, socKwh };
    }
  }

  function makeStop(choice: Candidate, arriveKwh: number, departPct: number, fromKm: number, fromEnergy: number, fromSoc: number, afterGap: boolean): Stop {
    const arrivePct = pct(arriveKwh);
    const minutes = chargeMinutes(arrivePct, departPct, cap, choice.powerKw, choice.mode);
    const energyKwh = kwhOf(departPct - arrivePct) / CHARGING_LOSS;
    const status = input.statuses.get(choice.station.id);

    const notes: string[] = [];
    if (afterGap) notes.push(`After the gap: this plan assumes you reach here with about ${Math.round(arrivePct)}%`);
    if (choice.mode === 'dc') notes.push(`DC ${Math.round(choice.powerKw)} kW for your car`);
    else notes.push(`AC only (${round1(choice.powerKw)} kW), slow`);
    if (!choice.trusted) notes.push('Unverified: nobody has confirmed this charger recently, so check before you rely on it');
    if (!choice.connectorVerified) notes.push('Connector type not confirmed on the map');
    if (status?.lastWorkedAt) notes.push(`Last charged fine ${timeAgo(status.lastWorkedAt, input.now)}`);
    if (choice.live === 'problem') notes.push('A problem was reported recently, so check the backup');
    if (choice.live === 'in_use') notes.push('Reported in use recently, so you may have to wait');
    if (departPct > options.chargeToPct) notes.push(`Charge to ${departPct}% to reach the next charger`);
    if (choice.detourKm >= 1) notes.push(`${round1(choice.detourKm)} km off the route`);
    if (choice.station.access === 'customers') notes.push('Customers only: the site may charge only its own guests or buyers, so call ahead');

    const confidence: Confidence = !choice.trusted
      ? 'low'
      : choice.tier === 1 && (choice.live === 'working' || choice.live === 'in_use')
        ? 'high'
        : choice.tier === 1 || (choice.tier === 2 && choice.live !== 'problem')
          ? 'medium'
          : 'low';

    const arrival = (c: Candidate) => fromSoc - (energyAt(index, cumKwh, c.alongKm) - fromEnergy + detourKwhOf(c));
    const backups: Backup[] = backupPool
      .filter((c) => c.station.id !== choice.station.id && c.alongKm > fromKm + 1)
      .map((c) => ({ c, arrive: arrival(c) }))
      .filter(({ arrive }) => arrive >= kwhOf(5))
      .sort(
        (a, b) =>
          Number(b.c.trusted) - Number(a.c.trusted) || a.c.tier - b.c.tier || Math.abs(a.c.alongKm - choice.alongKm) - Math.abs(b.c.alongKm - choice.alongKm),
      )
      .slice(0, 2)
      .map(({ c, arrive }) => ({
        station: c.station,
        alongKm: round1(c.alongKm),
        arriveSocPct: Math.round(pct(arrive)),
        powerKw: Math.round(c.powerKw),
        mode: c.mode,
        live: c.live,
        trusted: c.trusted,
      }));
    if (backups.length === 0) notes.push('No backup charger within reach. Charge a little extra at the previous stop.');

    return {
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
      trusted: choice.trusted,
      afterGap,
      notes,
      backups,
    };
  }

  function finish({ stops, gaps, reached, posEnergy, socKwh }: Pass): TripPlan {
    const arrivalKwh = socKwh - (destEnergy - posEnergy);
    const feasible = reached && gaps.length === 0;
    if (!feasible && gaps.length) {
      const g = gaps[0];
      const leg = input.leg;
      const span =
        `no confirmed car charger for ${Math.round(g.toKm - g.fromKm)} km between ${g.fromName ?? leg?.startName ?? 'the start'} ` +
        `(km ${Math.round(g.fromKm + (leg?.offsetKm ?? 0))}) and ${g.toName ?? leg?.endName ?? 'the destination'}`;
      warnings.unshift(
        extrasFeasible
          ? `We can't plan this trip only on chargers we're sure of: ${span}. ` +
              'The extra options below would get you there, but nobody has confirmed them recently.'
          : `Not safe to drive as planned: ${span}. ` +
              (g.toName ? 'The rest of the plan assumes you get past it. ' : '') +
              'Start with more charge, pick a different route, or add a charger you know on this route.',
      );
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
      gapAtKm: feasible ? null : Math.round(gaps[0]?.fromKm ?? 0),
      gaps,
      extras,
      extrasFeasible,
      coverage: {
        confirmed: plannable.filter((c) => c.trusted).length,
        unconfirmed: plannable.filter((c) => !c.trusted).length,
      },
    };
  }
}

/** Google Maps directions with charging stops as waypoints (the URL API allows up to 9). */
export function navigationUrl(from: { lat: number; lng: number }, to: { lat: number; lng: number }, stops: Stop[]): string {
  const params = new URLSearchParams({
    api: '1',
    origin: `${from.lat},${from.lng}`,
    destination: `${to.lat},${to.lng}`,
    travelmode: 'driving',
  });
  if (stops.length)
    params.set(
      'waypoints',
      stops
        .slice(0, 9)
        .map((s) => `${s.lat},${s.lng}`)
        .join('|'),
    );
  return `https://www.google.com/maps/dir/?${params}`;
}
