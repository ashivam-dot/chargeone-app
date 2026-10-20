import type { Station } from '../data/model.ts';
import type { Place, PlacesData } from '../data/places.ts';
import { liveState } from '../shared/status.ts';
import { RouteIndex, type Coord, type RouteGeometry } from './geometry.ts';
import { chargeOption, planTrip, type ChargeMode, type PlanInput, type TripPlan } from './planner.ts';

export interface NearbyPlace {
  place: Place;
  metres: number;
}

export interface Overnight {
  station: Station;
  /** Distance along the whole route, km. */
  alongKm: number;
  mode: ChargeMode;
  powerKw: number;
  /** Hours to charge from arrival to 100% on this charger. */
  hoursToFull: number;
  stays: NearbyPlace[];
  food: NearbyPlace[];
}

export interface DayPlan {
  /** Where this day starts along the whole route, km. Stop `alongKm` values are relative to it. */
  startKm: number;
  endKm: number;
  plan: TripPlan;
  startSocPct: number;
  /** Where the day ends when it isn't the last one. */
  overnight: Overnight | null;
}

export interface Journey {
  days: DayPlan[];
  feasible: boolean;
  distanceKm: number;
  driveMinutes: number;
  chargeMinutes: number;
  costInr: number;
  arrivalSocPct: number;
  stopCount: number;
  warnings: string[];
}

export interface JourneyInput extends PlanInput {
  /** Driving plus charging per day, in hours. 0 means no limit. */
  dailyHours: number;
  places: PlacesData | null;
}

const OVERNIGHT_CORRIDOR_KM = 6;
/** Part of each day kept free for charging stops and breaks. */
const DAY_BUFFER = 0.85;
const MAX_DAYS = 7;

export function nearbyPlaces(places: PlacesData | null, stationId: string, cat: 'f' | 's'): NearbyPlace[] {
  const refs = places?.near[stationId]?.[cat] ?? [];
  return refs.map(([i, metres]) => ({ place: places!.places[i], metres })).filter((n) => n.place);
}

/** Stays sorted so a charger on site comes first, then by distance. */
export function sortStays(stays: NearbyPlace[]): NearbyPlace[] {
  return [...stays].sort((a, b) => Number(Boolean(b.place.chargerOnSite)) - Number(Boolean(a.place.chargerOnSite)) || a.metres - b.metres);
}

function sliceRoute(index: RouteIndex, fromKm: number, toKm: number, route: RouteGeometry): RouteGeometry {
  const { coords, cumKm } = index;
  const out: Coord[] = [index.pointAt(fromKm)];
  for (let i = 0; i < coords.length; i++) {
    if (cumKm[i] > fromKm && cumKm[i] < toKm) out.push(coords[i]);
  }
  out.push(index.pointAt(toKm));
  const km = toKm - fromKm;
  const total = index.lengthKm || route.distanceKm;
  return { coords: out, distanceKm: km, durationMin: (route.durationMin * km) / total };
}

interface OvernightCandidate {
  station: Station;
  alongKm: number;
  detourKm: number;
  mode: ChargeMode;
  powerKw: number;
  stays: NearbyPlace[];
}

function overnightCandidates(index: RouteIndex, input: JourneyInput): OvernightCandidate[] {
  const out: OvernightCandidate[] = [];
  for (const station of input.stations) {
    const option = chargeOption(station, input.vehicle);
    if (!option) continue;
    if (liveState(input.statuses.get(station.id), input.now) === 'problem') continue;
    const p = index.project(station.lng, station.lat, OVERNIGHT_CORRIDOR_KM);
    if (!p) continue;
    out.push({
      station,
      alongKm: p.alongKm,
      detourKm: p.offKm * 1.4,
      mode: option.mode,
      powerKw: option.powerKw,
      stays: sortStays(nearbyPlaces(input.places, station.id, 's')),
    });
  }
  return out.sort((a, b) => a.alongKm - b.alongKm);
}

/**
 * Picks where to spend the night: a charger near the end of the day's driving, preferring one with
 * a stay that has its own charger, then any stays nearby, then the latest point in the day.
 */
export function chooseOvernight(candidates: OvernightCandidate[], fromKm: number, targetKm: number): OvernightCandidate | null {
  const span = targetKm - fromKm;
  // A night with a hotel beats a slightly longer first day; a much shorter day only if nothing else fits.
  const passes: Array<[needStays: boolean, lowFraction: number]> = [
    [true, 0.6],
    [true, 0.45],
    [false, 0.6],
    [false, 0.35],
  ];
  for (const [needStays, lowFraction] of passes) {
    const inWindow = candidates.filter(
      (c) => c.alongKm >= fromKm + lowFraction * span && c.alongKm <= targetKm && (!needStays || c.stays.length > 0),
    );
    if (!inWindow.length) continue;
    const score = (c: OvernightCandidate) =>
      (c.stays.length ? 0 : 400) - (c.stays[0]?.place.chargerOnSite ? 120 : 0) - Math.min(c.stays.length, 5) * 8 + (targetKm - c.alongKm) + c.detourKm * 4;
    return inWindow.reduce((best, c) => (score(c) < score(best) ? c : best));
  }
  return null;
}

function hoursToFull(fromPct: number, batteryKwh: number, mode: ChargeMode, powerKw: number): number {
  const kwh = (Math.max(0, 100 - fromPct) / 100) * batteryKwh;
  const rate = mode === 'dc' ? powerKw * 0.5 : powerKw * 0.9;
  return Math.round((kwh / rate / 0.9) * 10) / 10;
}

/** Plans a trip as one or more days, with overnight stops at chargers that have stays nearby. */
export function planJourney(input: JourneyInput): Journey {
  const index = new RouteIndex(input.route.coords);
  const totalKm = index.lengthKm || input.route.distanceKm;
  const warnings: string[] = [];
  const days: DayPlan[] = [];
  const dailyMin = input.dailyHours > 0 ? input.dailyHours * 60 * DAY_BUFFER : Infinity;
  const kmPerMin = totalKm / Math.max(1, input.route.durationMin);
  const candidates = Number.isFinite(dailyMin) && input.route.durationMin > dailyMin ? overnightCandidates(index, input) : [];

  let fromKm = 0;
  let soc = input.options.startSocPct;
  for (let day = 0; day < MAX_DAYS; day++) {
    const remainingMin = (totalKm - fromKm) / kmPerMin;
    let overnight: OvernightCandidate | null = null;
    if (remainingMin > dailyMin) {
      overnight = chooseOvernight(candidates, fromKm + 5, fromKm + dailyMin * kmPerMin);
      if (!overnight) {
        warnings.push(
          `No charger near the end of day ${day + 1}'s driving, so that day runs longer than ${input.dailyHours} h. ` +
            'Consider a hotel with a 3-pin socket for slow overnight charging.',
        );
      }
    }
    const endKm = overnight ? overnight.alongKm : totalKm;
    const leg = sliceRoute(index, fromKm, endKm, input.route);
    const options = overnight
      ? { ...input.options, startSocPct: soc, arriveReservePct: Math.max(input.options.stopReservePct + 5, 10) }
      : { ...input.options, startSocPct: soc };
    const plan = planTrip({ ...input, route: leg, options });
    days.push({
      startKm: fromKm,
      endKm,
      plan,
      startSocPct: soc,
      overnight: overnight && {
        station: overnight.station,
        alongKm: Math.round(overnight.alongKm * 10) / 10,
        mode: overnight.mode,
        powerKw: Math.round(overnight.powerKw * 10) / 10,
        hoursToFull: hoursToFull(plan.arrivalSocPct, input.vehicle.batteryKwh, overnight.mode, overnight.powerKw),
        stays: overnight.stays,
        food: nearbyPlaces(input.places, overnight.station.id, 'f'),
      },
    });
    if (!overnight || !plan.feasible) break;
    fromKm = overnight.alongKm;
    soc = 100;
  }

  const last = days[days.length - 1];
  const feasible = days.every((d) => d.plan.feasible) && last.endKm >= totalKm - 0.5;
  if (days.length === MAX_DAYS && last.endKm < totalKm - 0.5) warnings.push(`This trip needs more than ${MAX_DAYS} days at your daily limit.`);
  return {
    days,
    feasible,
    distanceKm: Math.round(totalKm * 10) / 10,
    driveMinutes: days.reduce((a, d) => a + d.plan.driveMinutes, 0),
    chargeMinutes: days.reduce((a, d) => a + d.plan.chargeMinutes, 0),
    costInr: days.reduce((a, d) => a + d.plan.totalCostInr, 0),
    arrivalSocPct: last.plan.arrivalSocPct,
    stopCount: days.reduce((a, d) => a + d.plan.stops.length, 0),
    warnings: [...warnings, ...new Set(days.flatMap((d) => d.plan.warnings))],
  };
}

/** Stays within reach of the destination that have a charger on site or nearby. */
export function staysNearDestination(input: Pick<JourneyInput, 'stations' | 'places'>, to: { lat: number; lng: number }, maxKm = 15): NearbyPlace[] {
  if (!input.places) return [];
  const seen = new Set<string>();
  const out: NearbyPlace[] = [];
  const kx = Math.cos((to.lat * Math.PI) / 180) * 111.32;
  for (const s of input.stations) {
    const d = Math.hypot((s.lng - to.lng) * kx, (s.lat - to.lat) * 110.57);
    if (d > maxKm) continue;
    for (const n of nearbyPlaces(input.places, s.id, 's')) {
      if (seen.has(n.place.id)) continue;
      seen.add(n.place.id);
      const fromDest = Math.hypot((n.place.lng - to.lng) * kx, (n.place.lat - to.lat) * 110.57) * 1000;
      out.push({ place: n.place, metres: Math.round(fromDest) });
    }
  }
  return sortStays(out).slice(0, 6);
}
