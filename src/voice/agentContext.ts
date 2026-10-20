// Packs what the phone knows (car, plan on screen, live drive) into the agent's context, within its size limit.
import type { AgentContext } from '../shared/contracts.ts';
import type { Journey } from '../planner/journey.ts';
import type { Stop, TripPlan } from '../planner/planner.ts';
import { baseWhPerKm, type MyVehicle } from '../shared/vehicles.ts';

export const MAX_CONTEXT_BYTES = 8000;
const MAX_STOPS = 12;
const MAX_NIGHTS = 4;
const MAX_NAME = 60;

type ContextTrip = NonNullable<AgentContext['trip']>;
type ContextStop = ContextTrip['stops'][number];
type ContextNight = ContextTrip['nights'][number];

export interface AgentContextInput {
  vehicle?: { vehicle: MyVehicle; socPct?: number | null; rangeKm?: number | null } | null;
  /** The plan on screen: a single-day plan or a multi-day journey, with the place names it joins. */
  trip?: { from: string; to: string; plan: TripPlan | Journey } | null;
  live?: {
    socPct: number;
    speedKmh?: number | null;
    whPerKm?: number | null;
    kmDone: number;
    projectedArrivalSocPct?: number | null;
    lat: number;
    lng: number;
  } | null;
  position?: { lat: number; lng: number } | null;
}

/** The headline numbers of a plan, for speech and the agent alike. */
export interface PlanSummary {
  feasible: boolean;
  distanceKm: number;
  /** Driving plus charging. */
  totalMinutes: number;
  arrivalSocPct: number;
  stopCount: number;
  firstStopName: string | null;
  nights: number;
}

const isJourney = (plan: TripPlan | Journey): plan is Journey => 'days' in plan;

const finite = (n: number | null | undefined): n is number => typeof n === 'number' && Number.isFinite(n);
const round = Math.round;
const round1 = (n: number) => Math.round(n * 10) / 10;
const coord = (n: number) => Math.round(n * 1e4) / 1e4;
const pct = (n: number) => Math.min(100, Math.max(0, Math.round(n)));
const cut = (s: string, max: number) => {
  const chars = [...s.trim()];
  return chars.length > max ? `${chars.slice(0, max - 1).join('')}…` : chars.join('');
};

/** Every stop on the plan with its distance from the start of the whole trip. */
function allStops(plan: TripPlan | Journey): Array<{ stop: Stop; km: number }> {
  if (!isJourney(plan)) return plan.stops.map((stop) => ({ stop, km: stop.alongKm }));
  return plan.days.flatMap((d) => d.plan.stops.map((stop) => ({ stop, km: d.startKm + stop.alongKm })));
}

export function summarizePlan(plan: TripPlan | Journey): PlanSummary {
  const stops = allStops(plan);
  return {
    feasible: plan.feasible,
    distanceKm: round(plan.distanceKm),
    totalMinutes: round(plan.driveMinutes + plan.chargeMinutes),
    arrivalSocPct: pct(plan.arrivalSocPct),
    stopCount: stops.length,
    firstStopName: stops[0] ? cut(stops[0].stop.station.name, MAX_NAME) : null,
    nights: isJourney(plan) ? plan.days.filter((d) => d.overnight).length : 0,
  };
}

function tripContext(trip: NonNullable<AgentContextInput['trip']>, kmDone: number | null): ContextTrip {
  const { plan } = trip;
  const stops: ContextStop[] = allStops(plan).map(({ stop, km }) => ({
    name: cut(stop.station.name, MAX_NAME),
    km: round(km),
    arriveSocPct: pct(stop.arriveSocPct),
    departSocPct: pct(stop.departSocPct),
    chargeMinutes: round(stop.chargeMinutes),
    powerKw: round(stop.powerKw),
    status: stop.live,
    lat: coord(stop.lat),
    lng: coord(stop.lng),
  }));
  // On the road, keep the last stop passed and the ones ahead.
  const ahead = kmDone === null ? 0 : stops.findIndex((s) => s.km >= kmDone);
  const start = ahead < 0 ? Math.max(0, stops.length - MAX_STOPS) : Math.max(0, ahead - 1);
  const nights: ContextNight[] = isJourney(plan)
    ? plan.days.flatMap((d) =>
        d.overnight ? [{ name: cut(d.overnight.station.name, MAX_NAME), km: round(d.overnight.alongKm), morningSocPct: pct(d.overnight.morningSocPct) }] : [],
      )
    : [];
  const summary = summarizePlan(plan);
  return {
    from: cut(trip.from, MAX_NAME),
    to: cut(trip.to, MAX_NAME),
    distanceKm: summary.distanceKm,
    totalMinutes: summary.totalMinutes,
    arrivalSocPct: summary.arrivalSocPct,
    stops: stops.slice(start, start + MAX_STOPS),
    nights: nights.slice(0, MAX_NIGHTS),
  };
}

const bytes = (ctx: AgentContext) => new TextEncoder().encode(JSON.stringify(ctx)).length;

export function buildAgentContext(input: AgentContextInput, maxBytes = MAX_CONTEXT_BYTES): AgentContext {
  const ctx: AgentContext = {};
  const { vehicle, trip, live, position } = input;
  if (vehicle) {
    const v = vehicle.vehicle;
    const soc = finite(vehicle.socPct) ? pct(vehicle.socPct) : finite(live?.socPct) ? pct(live.socPct) : null;
    const fullRangeKm = v.realRangeKm && v.realRangeKm > 0 ? v.realRangeKm : (v.batteryKwh * 1000) / baseWhPerKm(v);
    ctx.vehicle = {
      name: cut(v.name, MAX_NAME),
      batteryKwh: round1(v.batteryKwh),
      rangeKm: finite(vehicle.rangeKm) ? round(Math.max(0, vehicle.rangeKm)) : soc === null ? null : round((fullRangeKm * soc) / 100),
      socPct: soc,
    };
  }
  if (trip) ctx.trip = tripContext(trip, finite(live?.kmDone) ? live.kmDone : null);
  if (live && finite(live.socPct) && finite(live.lat) && finite(live.lng)) {
    ctx.live = {
      socPct: pct(live.socPct),
      speedKmh: finite(live.speedKmh) ? round(Math.max(0, live.speedKmh)) : null,
      whPerKm: finite(live.whPerKm) ? round(live.whPerKm) : null,
      kmDone: finite(live.kmDone) ? round1(Math.max(0, live.kmDone)) : 0,
      projectedArrivalSocPct: finite(live.projectedArrivalSocPct) ? Math.round(live.projectedArrivalSocPct) : null,
      lat: coord(live.lat),
      lng: coord(live.lng),
    };
  }
  if (position && finite(position.lat) && finite(position.lng)) ctx.position = { lat: coord(position.lat), lng: coord(position.lng) };

  // Over the limit only with very long names; give up the least useful detail first.
  while (bytes(ctx) > maxBytes) {
    const t = ctx.trip;
    if (t && t.nights.length > 1) t.nights.pop();
    else if (t && t.stops.length > 1) t.stops.pop();
    else if (t && (t.nights.length || t.stops.length)) {
      t.nights = [];
      t.stops = [];
    } else if (ctx.position && ctx.live) delete ctx.position;
    else if (t) delete ctx.trip;
    else if (ctx.position) delete ctx.position;
    else if (ctx.live) delete ctx.live;
    else if (ctx.vehicle) delete ctx.vehicle;
    else break;
  }
  return ctx;
}
