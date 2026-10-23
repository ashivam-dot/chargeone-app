import { placesAlongRoute, type CorridorPlace, type PlaceOnRoute } from '../data/corridor.ts';
import type { Station } from '../data/model.ts';
import { PLAN_MIN_CONFIDENCE, speedUnknown, trustScore } from '../data/trust.ts';
import type { FoodKind, Place, PlacesData, StayKind } from '../data/places.ts';
import { liveState } from '../shared/status.ts';
import { RouteIndex, type Coord, type RouteGeometry } from './geometry.ts';
import { dayClock, kmAtTime, sameTimeLater, timeOnDay, type DayClock, type ItineraryItem } from './itinerary.ts';
import { chargeOption, findCandidates, planTrip, type ChargeGap, type ChargeMode, type PlanInput, type Stop, type TripPlan } from './planner.ts';

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
  /** Battery after a night on this charger; below 100 on slow AC. */
  morningSocPct: number;
  /** A charger we're fairly sure of; false only when the driver allowed unverified stops. */
  trusted: boolean;
  /** No source gives this charger's speed, so powerKw, hoursToFull and morningSocPct are guesses. */
  speedUnknown: boolean;
  stays: NearbyPlace[];
  food: NearbyPlace[];
}

/** Where a day ends when it isn't the last: at a charger, at a roadside stay, or (with neither mapped) around a km mark. */
export interface NightStop {
  kind: 'charger' | 'stay' | 'roadside';
  name: string;
  alongKm: number;
  lat: number;
  lng: number;
  arriveSocPct: number;
  morningSocPct: number;
  /** Stays to sleep at, nearest first (a charger on site first). */
  stays: NearbyPlace[];
  food: NearbyPlace[];
}

export interface DayPlan {
  /** Where this day starts along the whole route, km. Stop `alongKm` values are relative to it. */
  startKm: number;
  endKm: number;
  plan: TripPlan;
  startSocPct: number;
  /** The night's charger, when the day ends at one. */
  overnight: Overnight | null;
  /** Where the day ends when it isn't the last one (charger, stay or roadside). */
  night: NightStop | null;
  departAt: number;
  arriveAt: number;
  /** Minutes at the wheel. */
  driveMinutes: number;
  /** The day on the clock: leave, charge, rest, eat, gaps, night or arrival. */
  items: ItineraryItem[];
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
  /** The trip needs more than MAX_DAYS at the chosen daily limit. */
  tooLong: boolean;
  warnings: string[];
  departAt: number;
  arriveAt: number;
  /** Every stretch with no confirmed charger in reach, in whole-route km. */
  gaps: ChargeGap[];
  /** Compatible chargers within a few km of the road: confirmed ones, and ones we can't vouch for. */
  coverage: { confirmed: number; unconfirmed: number };
  /** Roadside rest, fuel, food and stay data was available for this road. */
  hasCorridor: boolean;
}

export interface JourneyInput extends PlanInput {
  /** Driving per day, in hours ("Drive per day" in the planner). 0 means no limit. */
  dailyHours: number;
  places: PlacesData | null;
  /** When the driver leaves, ms or a Date; default 06:00 on the day of `now`. */
  departAt?: number | Date;
  /** Roadside places near the national highways (corridor data), when loaded. */
  corridor?: CorridorPlace[] | null;
}

const OVERNIGHT_CORRIDOR_KM = 6;
const MAX_DAYS = 7;
/** Hours on the charger between arriving in the evening and leaving in the morning. */
const NIGHT_HOURS = 10;
/** Below this an AC charger can't refill most cars overnight. */
const SLOW_AC_KW = 6;
/** Arrive for the night by this local time. */
export const NIGHT_BY: [number, number] = [21, 30];
/** A day ends no earlier than this share of the day's reach, unless nothing else works. */
const MIN_DAY_SHARE = 0.5;
/** Night candidates checked in full per day, best first. */
const NIGHT_TRIES = 8;
/** A single day of more than this many hours at the wheel gets a warning. */
const LONG_DAY_H = 12;

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
  return {
    coords: out,
    distanceKm: km,
    durationMin: (route.durationMin * km) / total,
  };
}

/** A corridor place as a Place the stay and food lists can show. */
function corridorAsPlace(p: CorridorPlace): Place | null {
  if (p.cat === 'stay')
    return {
      id: p.id,
      cat: 'stay',
      kind: p.kind as StayKind,
      name: p.name,
      lat: p.lat,
      lng: p.lng,
    };
  if (p.cat === 'food')
    return {
      id: p.id,
      cat: 'food',
      kind: p.kind as FoodKind,
      name: p.name,
      lat: p.lat,
      lng: p.lng,
      ...(p.pureVeg ? { veg: 'pure' as const } : {}),
    };
  return null;
}

function metresBetween(a: { lat: number; lng: number }, b: { lat: number; lng: number }): number {
  const kx = Math.cos((a.lat * Math.PI) / 180) * 111.32;
  return Math.round(Math.hypot((a.lng - b.lng) * kx, (a.lat - b.lat) * 110.57) * 1000);
}

/** Merges places.json and corridor places near a point, nearest first, without duplicates. */
function mergeNearby(base: NearbyPlace[], pois: PlaceOnRoute[], cat: 'stay' | 'food', near: { lat: number; lng: number }, maxM: number): NearbyPlace[] {
  const seen = new Set(base.map((n) => n.place.id));
  const out = [...base];
  for (const p of pois) {
    if (p.place.cat !== cat || seen.has(p.place.id)) continue;
    const metres = metresBetween(near, p.place);
    if (metres > maxM) continue;
    const place = corridorAsPlace(p.place);
    if (!place) continue;
    seen.add(place.id);
    out.push({ place, metres });
  }
  return cat === 'stay' ? sortStays(out) : out.sort((a, b) => a.metres - b.metres);
}

interface NightCandidate {
  kind: 'charger' | 'stay';
  alongKm: number;
  detourKm: number;
  lat: number;
  lng: number;
  name: string;
  station: Station | null;
  mode: ChargeMode;
  powerKw: number;
  trusted: boolean;
  stays: NearbyPlace[];
}

function nightCandidates(index: RouteIndex, input: JourneyInput, pois: PlaceOnRoute[]): NightCandidate[] {
  const out: NightCandidate[] = [];
  for (const station of input.stations) {
    const option = chargeOption(station, input.vehicle);
    if (!option) continue;
    const status = input.statuses.get(station.id);
    if (liveState(status, input.now) === 'problem') continue;
    // A night's charge is the whole next day's range: the same bar as a charging stop (AC is fine overnight),
    // unless the driver allowed unverified chargers.
    const trusted = option.verified && trustScore(station, status, input.now) >= PLAN_MIN_CONFIDENCE && station.access !== 'customers';
    if (!trusted && !input.options.allowUnverified) continue;
    const p = index.project(station.lng, station.lat, OVERNIGHT_CORRIDOR_KM);
    if (!p) continue;
    const stays = mergeNearby(nearbyPlaces(input.places, station.id, 's'), pois, 'stay', station, 2000);
    out.push({
      kind: 'charger',
      alongKm: p.alongKm,
      detourKm: p.offKm * 1.4,
      lat: station.lat,
      lng: station.lng,
      name: station.name,
      station,
      mode: option.mode,
      powerKw: option.powerKw,
      trusted,
      stays,
    });
  }
  // A roadside hotel with no charger: fine for the night when the car arrives with enough charge for the morning.
  for (const p of pois) {
    if (p.place.cat !== 'stay' || !p.place.named) continue;
    const place = corridorAsPlace(p.place)!;
    out.push({
      kind: 'stay',
      alongKm: p.alongKm,
      detourKm: p.offKm * 1.4,
      lat: p.place.lat,
      lng: p.place.lng,
      name: p.place.name,
      station: null,
      mode: 'ac',
      powerKw: 0,
      trusted: true,
      stays: [{ place, metres: 0 }],
    });
  }
  return out.sort((a, b) => a.alongKm - b.alongKm);
}

/** Average kWh per hour into the battery for a full charge, including taper and losses. */
function fullChargeRate(mode: ChargeMode, powerKw: number): number {
  return (mode === 'dc' ? powerKw * 0.5 : powerKw * 0.9) * 0.9;
}

function hoursToFull(fromPct: number, batteryKwh: number, mode: ChargeMode, powerKw: number): number {
  const kwh = (Math.max(0, 100 - fromPct) / 100) * batteryKwh;
  return Math.round((kwh / fullChargeRate(mode, powerKw)) * 10) / 10;
}

export function morningSoc(fromPct: number, batteryKwh: number, mode: ChargeMode, powerKw: number): number {
  const pct = Math.max(0, fromPct) + ((fullChargeRate(mode, powerKw) * NIGHT_HOURS) / batteryKwh) * 100;
  return pct >= 100 ? 100 : Math.floor(pct / 5) * 5;
}

/** Lower is better: a night late in the day's reach, with a stay (ideally with its own charger) and a charger. */
function nightScore(c: NightCandidate, reachKm: number): number {
  return (
    reachKm -
    c.alongKm +
    (c.stays.length ? 0 : 300) -
    (c.stays[0]?.place.chargerOnSite ? 120 : 0) -
    Math.min(c.stays.length, 5) * 8 +
    (c.kind === 'stay' ? 80 : 0) +
    c.detourKm * 4 +
    (c.kind === 'charger' && c.mode === 'ac' && c.powerKw < SLOW_AC_KW ? 60 : 0)
  );
}

/**
 * Plans a trip as one or more days on the clock. Each day drives as far as the daily limit and the
 * night window (arrive by NIGHT_BY) allow; the night is the best stop the car can actually reach in
 * that time: a charger with a stay nearby, a roadside hotel when the car arrives with enough charge
 * for the morning, or, with neither mapped, a plain "stop around km X". A day with a gap in the
 * chargers doesn't end the plan: the next days are planned as if the driver gets past it.
 */
export function planJourney(input: JourneyInput): Journey {
  const index = new RouteIndex(input.route.coords);
  const totalKm = index.lengthKm || input.route.distanceKm;
  const minPerKm = input.route.durationMin / Math.max(0.1, totalKm);
  const warnings: string[] = [];
  const days: DayPlan[] = [];
  const limitMin = input.dailyHours > 0 ? input.dailyHours * 60 : Infinity;
  const pois = input.corridor?.length ? placesAlongRoute(index, input.corridor, 1.5) : [];
  const candidates = input.route.durationMin > limitMin ? nightCandidates(index, input, pois) : [];
  const departAt = input.departAt === undefined ? timeOnDay(input.now.getTime(), [6, 0]) : new Date(input.departAt).getTime();
  const placeIds = new Set(input.places?.places.map((p) => p.id) ?? []);

  const foodNear = (startKm: number) => (s: Stop) =>
    nearbyPlaces(input.places, s.station.id, 'f').length +
    pois.filter((p) => p.place.cat === 'food' && Math.abs(p.alongKm - (startKm + s.alongKm)) <= 1 && !placeIds.has(p.place.id)).length;
  const planLeg = (fromKm: number, toKm: number, soc: number, arriveReservePct: number, skip: string | null) =>
    planTrip({
      ...input,
      stations: skip ? input.stations.filter((s) => s.id !== skip) : input.stations,
      route: sliceRoute(index, fromKm, toKm, input.route),
      options: { ...input.options, startSocPct: soc, arriveReservePct },
    });
  const clock = (fromKm: number, toKm: number, plan: TripPlan, depart: number, end: 'night' | 'arrive'): DayClock =>
    dayClock({
      startKm: fromKm,
      endKm: toKm,
      departAt: depart,
      minPerKm,
      stops: plan.stops,
      gaps: plan.gaps,
      pois,
      foodNear: foodNear(fromKm),
      end,
    });

  let fromKm = 0;
  let soc = input.options.startSocPct;
  let depart = departAt;
  for (let day = 0; day < MAX_DAYS; day++) {
    const rest = planLeg(fromKm, totalKm, soc, input.options.arriveReservePct, null);
    const restClock = clock(fromKm, totalKm, rest, depart, 'arrive');
    const nightBy = Math.max(timeOnDay(depart, NIGHT_BY), depart + 3 * 3600_000);
    const fits = restClock.driveMinutes <= limitMin && (limitMin === Infinity || restClock.endAt <= nightBy);
    if (fits || day === MAX_DAYS - 1) {
      days.push(dayOf(fromKm, totalKm, rest, restClock, soc, depart, null, null));
      break;
    }

    // How far today can go: the driving limit or the night window, whichever comes first.
    const reachKm = Math.min(fromKm + limitMin / minPerKm, kmAtTime(restClock, nightBy, minPerKm), totalKm - 1);
    const lowKm = fromKm + MIN_DAY_SHARE * (reachKm - fromKm);
    const tries = candidates
      .filter((c) => c.alongKm >= lowKm && c.alongKm <= reachKm)
      .sort((a, b) => nightScore(a, reachKm) - nightScore(b, reachKm))
      .slice(0, NIGHT_TRIES);

    let chosen: {
      c: NightCandidate | null;
      km: number;
      plan: TripPlan;
      clock: DayClock;
    } | null = null;
    for (const c of tries) {
      let reserve = input.options.stopReservePct;
      if (c.kind === 'stay') {
        // No charger for the night: arrive with enough to reach the next charger (or the end) in the morning.
        const morning = planLeg(c.alongKm, totalKm, 100, input.options.arriveReservePct, null);
        if (morning.gaps.some((g) => g.fromKm < 1 && g.fromName === null)) continue;
        const first = morning.stops[0];
        const spare = first ? first.arriveSocPct - input.options.stopReservePct : morning.arrivalSocPct - input.options.arriveReservePct;
        reserve = Math.min(95, Math.max(reserve, 100 - spare + 5));
      }
      const plan = planLeg(fromKm, c.alongKm, soc, reserve, c.station?.id ?? null);
      if (!plan.feasible && rest.feasible) continue;
      const dayClockNow = clock(fromKm, c.alongKm, plan, depart, 'night');
      if (dayClockNow.driveMinutes > limitMin + 10 || dayClockNow.endAt > nightBy + 15 * 60_000) continue;
      chosen = { c, km: c.alongKm, plan, clock: dayClockNow };
      break;
    }
    if (!chosen) {
      // Nothing mapped in reach: stop the day around the reach point anyway rather than drive on all night.
      const km = Math.max(fromKm + 1, reachKm);
      const plan = planLeg(fromKm, km, soc, input.options.stopReservePct, null);
      chosen = {
        c: null,
        km,
        plan,
        clock: clock(fromKm, km, plan, depart, 'night'),
      };
      warnings.push(
        `No mapped charger or hotel near the end of day ${day + 1}'s driving. Plan to stop for the night around km ${Math.round(km)}, ` +
          'and ask a hotel about a 3-pin socket for slow overnight charging.',
      );
    }

    const { c, km, plan } = chosen;
    const arrive = plan.arrivalSocPct;
    let overnight: Overnight | null = null;
    let morning = Math.max(0, arrive);
    if (c?.kind === 'charger' && c.station) {
      morning = morningSoc(arrive, input.vehicle.batteryKwh, c.mode, c.powerKw);
      overnight = {
        station: c.station,
        alongKm: Math.round(c.alongKm * 10) / 10,
        mode: c.mode,
        powerKw: Math.round(c.powerKw * 10) / 10,
        hoursToFull: hoursToFull(arrive, input.vehicle.batteryKwh, c.mode, c.powerKw),
        morningSocPct: morning,
        trusted: c.trusted,
        speedUnknown: speedUnknown(c.station),
        stays: c.stays,
        food: mergeNearby(nearbyPlaces(input.places, c.station.id, 'f'), pois, 'food', c.station, 1500),
      };
    }
    const [lng, lat] = c ? [c.lng, c.lat] : index.pointAt(km);
    const night: NightStop = {
      kind: c?.kind ?? 'roadside',
      name: c ? c.name : `Around km ${Math.round(km)}`,
      alongKm: Math.round(km * 10) / 10,
      lat,
      lng,
      arriveSocPct: arrive,
      morningSocPct: morning,
      stays: c ? c.stays : mergeNearby([], pois, 'stay', { lat, lng }, 15_000).slice(0, 6),
      food: overnight ? overnight.food : mergeNearby([], pois, 'food', { lat, lng }, c ? 1500 : 15_000).slice(0, 6),
    };
    days.push(dayOf(fromKm, km, plan, chosen.clock, soc, depart, overnight, night));
    fromKm = km;
    soc = morning;
    depart = sameTimeLater(depart, 1);
  }

  const last = days[days.length - 1];
  const reached = last.endKm >= totalKm - 0.5 && last.night === null;
  const tooLong = !reached || (days.length === MAX_DAYS && limitMin !== Infinity && last.driveMinutes > limitMin + 10);
  const feasible = days.every((d) => d.plan.feasible) && !tooLong;
  if (tooLong) warnings.push(`This trip needs more than ${MAX_DAYS} days at your daily limit. Allow more driving per day, or plan it in parts.`);
  if (limitMin === Infinity && last.driveMinutes > LONG_DAY_H * 60) {
    warnings.push(`That's about ${Math.round(last.driveMinutes / 60)} h at the wheel in one go. Set a daily driving limit to plan a night on the way.`);
  }
  const gaps = days.flatMap((d) =>
    d.plan.gaps.map((g) => ({
      ...g,
      fromKm: Math.round((d.startKm + g.fromKm) * 10) / 10,
      toKm: Math.round((d.startKm + g.toKm) * 10) / 10,
    })),
  );
  const strictCandidates = findCandidates(index, input, 3).filter((c) => c.live !== 'problem');
  return {
    days,
    feasible,
    distanceKm: Math.round(totalKm * 10) / 10,
    driveMinutes: days.reduce((a, d) => a + d.plan.driveMinutes, 0),
    chargeMinutes: days.reduce((a, d) => a + d.plan.chargeMinutes, 0),
    costInr: days.reduce((a, d) => a + d.plan.totalCostInr, 0),
    arrivalSocPct: last.plan.arrivalSocPct,
    stopCount: days.reduce((a, d) => a + d.plan.stops.length, 0),
    tooLong,
    warnings: [...warnings, ...new Set(days.flatMap((d) => d.plan.warnings))],
    departAt,
    arriveAt: last.arriveAt,
    gaps,
    coverage: {
      confirmed: strictCandidates.filter((c) => c.trusted).length,
      unconfirmed: strictCandidates.filter((c) => !c.trusted).length,
    },
    hasCorridor: pois.length > 0,
  };

  function dayOf(
    startKm: number,
    endKm: number,
    plan: TripPlan,
    dc: DayClock,
    startSoc: number,
    dep: number,
    overnight: Overnight | null,
    night: NightStop | null,
  ): DayPlan {
    return {
      startKm,
      endKm,
      plan,
      startSocPct: startSoc,
      overnight,
      night,
      departAt: dep,
      arriveAt: dc.endAt,
      driveMinutes: Math.round(dc.driveMinutes),
      items: dc.items,
    };
  }
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
