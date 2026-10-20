import type { Station } from '../data/model.ts';
import { RouteIndex, haversineKm, type Coord } from '../planner/geometry.ts';
import { DEFAULT_OPTIONS, chargeOption, cumulativeEnergy, type ChargeMode, type PlanOptions } from '../planner/planner.ts';
import type { LiveState } from '../shared/status.ts';
import type { MyVehicle } from '../shared/vehicles.ts';
import { Ewma } from '../vehicle/energy.ts';
import type { Telemetry } from '../vehicle/types.ts';

export interface PlannedStop {
  stationId: string;
  name: string;
  alongKm: number;
  plannedArriveSocPct: number;
  lat: number;
  lng: number;
  powerKw: number;
  /** Planned minutes on the charger, added to the ETA while the stop is ahead. */
  chargeMinutes?: number;
}

export interface DriveInput {
  route: Coord[];
  stops: PlannedStop[];
  /** Charge the plan expects on arrival at the destination, %. */
  plannedArrivalSocPct: number;
  vehicle: MyVehicle;
  /** Usable battery, kWh; defaults to the vehicle's. */
  batteryKwh?: number;
  /** Average Wh/km the plan assumed; defaults to the planner's figure for this route. */
  plannedWhPerKm?: number;
  /** Options the trip was planned with, for the route energy profile. */
  planOptions?: PlanOptions;
  stopReservePct?: number;
  arriveReservePct?: number;
  stations: Station[];
  routeDurationMin?: number;
}

export type AlertKind = 'range_drop' | 'stop_problem' | 'cant_reach' | 'off_route' | 'arrived';
export type AlertSeverity = 'info' | 'warn' | 'critical';

export interface Suggestion {
  stationId: string;
  name: string;
  lat: number;
  lng: number;
  alongKm: number;
  kmAway: number;
  projectedArriveSocPct: number;
  powerKw: number;
  mode: ChargeMode;
  liveState: LiveState;
}

export interface DriveAlert {
  id: string;
  kind: AlertKind;
  severity: AlertSeverity;
  title: string;
  body: string;
  suggestion?: Suggestion;
  at: number;
}

export interface NextStopInfo {
  stationId: string;
  name: string;
  lat: number;
  lng: number;
  alongKm: number;
  kmAway: number;
  powerKw: number;
  plannedArriveSocPct: number;
  liveState: LiveState;
}

export interface DriveState {
  kmDone: number;
  kmLeft: number;
  /** Minutes to the destination: driving at the recent average speed plus planned charging still ahead. */
  etaMin: number;
  socPct: number | null;
  liveWhPerKm: number | null;
  plannedWhPerKm: number;
  /** Live consumption against the plan, % (positive = using more). */
  consumptionDeltaPct: number | null;
  projectedSocAtNextStopPct: number | null;
  /** Arrival charge if the remaining stops charge as planned (or, with none left, driving straight there). */
  projectedSocAtDestinationPct: number | null;
  nextStop: NextStopInfo | null;
  /** Distance from the planned route, km; null without a position. */
  offRouteKm: number | null;
  /** Alerts raised by this update only. */
  alerts: DriveAlert[];
}

export interface DriveSession {
  update(t: Telemetry, nowMs: number, liveStates?: ReadonlyMap<string, LiveState>): DriveState;
  /** The driver dismissed or accepted an alert; its suggested station isn't suggested again. */
  acknowledge(alertId: string): void;
  /** Makes the suggested station the next stop. */
  switchTo(suggestion: Suggestion): void;
  readonly stops: readonly PlannedStop[];
}

const CONSUMPTION_ALERT_PCT = 15;
const SUSTAINED_KM = 4;
const STOP_MARGIN_PCT = 3;
const SUGGEST_MIN_ARRIVE_PCT = 6;
const CANT_REACH_PCT = 3;
const SUGGEST_FROM_KM = 2;
const CORRIDOR_KM = 3;
const ALTERNATIVE_RADIUS_KM = 15;
const OFF_ROUTE_KM = 1.5;
const OFF_ROUTE_UPDATES = 2;
/** Driving to or from a charger off the route isn't "off route". */
const NEAR_STOP_KM = 4;
const PROJECT_MAX_KM = 25;
const ARRIVED_KM = 0.3;
const PASSED_STOP_KM = 1;
const COOLDOWN_MS = 10 * 60_000;
const LIVE_HALF_LIFE_KM = 5;
const MIN_OWN_OBSERVED_KM = 2;
const SPEED_HALF_LIFE_MIN = 10;
const MIN_SPEED_OBSERVED_MIN = 3;
const NEAREST_WINDOW_KM = 5;
/** Road detour is longer than the straight line; same circuity factor as the planner. */
const CIRCUITY = 1.4;
const SEVERITY_RANK: Record<AlertSeverity, number> = { info: 0, warn: 1, critical: 2 };
const LIVE_RANK: Record<LiveState, number> = { working: 0, in_use: 1, unknown: 2, problem: 3 };

interface Candidate {
  station: Station;
  alongKm: number;
  offKm: number;
  detourKm: number;
  mode: ChargeMode;
  powerKw: number;
}

interface Stop extends PlannedStop {
  detourKm: number;
}

const NO_LIVE: ReadonlyMap<string, LiveState> = new Map();

export function createDriveSession(input: DriveInput): DriveSession {
  return new Session(input);
}

class Session implements DriveSession {
  private readonly index: RouteIndex;
  private readonly cumKwh: number[];
  private readonly lengthKm: number;
  private readonly batteryKwh: number;
  private readonly plannedWh: number;
  /** Converts the route energy profile (planner model) into kWh at the planned consumption. */
  private readonly profileWh: number;
  private readonly stopReserve: number;
  private readonly arriveReserve: number;
  private readonly candidates: Candidate[];
  private readonly stopList: Stop[];
  private readonly ownEwma = new Ewma(LIVE_HALF_LIFE_KM);
  private readonly speedEwma = new Ewma(SPEED_HALF_LIFE_MIN);
  private readonly fired = new Map<string, { at: number; severity: AlertSeverity }>();
  private readonly suggested = new Map<string, string>();
  private readonly rejected = new Set<string>();
  private live: ReadonlyMap<string, LiveState> = NO_LIVE;

  private kmDone = 0;
  private nextIdx = 0;
  private lastNow: number | null = null;
  private lastOdo: number | null = null;
  private socAnchor: { soc: number; km: number } | null = null;
  private highKm = 0;
  private offCount = 0;
  private arrived = false;
  private seq = 0;

  constructor(private readonly input: DriveInput) {
    this.index = new RouteIndex(input.route);
    this.lengthKm = this.index.lengthKm;
    this.cumKwh = cumulativeEnergy(this.index, input.route, input.vehicle, input.planOptions ?? DEFAULT_OPTIONS);
    this.batteryKwh = input.batteryKwh ?? input.vehicle.batteryKwh;
    const total = this.cumKwh[this.cumKwh.length - 1] ?? 0;
    this.profileWh = this.lengthKm > 0 && total > 0 ? (total * 1000) / this.lengthKm : 150;
    this.plannedWh = input.plannedWhPerKm ?? this.profileWh;
    this.stopReserve = input.stopReservePct ?? 12;
    this.arriveReserve = input.arriveReservePct ?? 15;
    this.candidates = this.findCandidates(input.stations);
    this.stopList = input.stops.map((s) => this.toStop(s)).sort((a, b) => a.alongKm - b.alongKm);
  }

  get stops(): readonly PlannedStop[] {
    return this.stopList;
  }

  private findCandidates(stations: Station[]): Candidate[] {
    const out: Candidate[] = [];
    for (const station of stations) {
      const option = chargeOption(station, this.input.vehicle);
      if (!option) continue;
      const p = this.index.project(station.lng, station.lat, ALTERNATIVE_RADIUS_KM);
      if (!p) continue;
      out.push({ station, alongKm: p.alongKm, offKm: p.offKm, detourKm: p.offKm * CIRCUITY, mode: option.mode, powerKw: option.powerKw });
    }
    return out.sort((a, b) => a.alongKm - b.alongKm);
  }

  private toStop(s: PlannedStop): Stop {
    const p = this.index.project(s.lng, s.lat, ALTERNATIVE_RADIUS_KM);
    return { ...s, detourKm: p ? p.offKm * CIRCUITY : 0 };
  }

  update(t: Telemetry, nowMs: number, liveStates?: ReadonlyMap<string, LiveState>): DriveState {
    if (liveStates) this.live = liveStates;
    const prevKm = this.kmDone;
    const offRouteKm = this.locate(t);
    const dKm = this.kmDone - prevKm;
    const dtMin = this.lastNow === null ? 0 : (nowMs - this.lastNow) / 60_000;
    this.lastNow = nowMs;

    while (this.nextIdx < this.stopList.length && this.kmDone > this.stopList[this.nextIdx].alongKm + PASSED_STOP_KM) this.nextIdx++;
    const next = this.stopList[this.nextIdx] ?? null;

    const liveWh = this.trackConsumption(t, dKm);
    const delta = liveWh === null ? null : (liveWh / this.plannedWh - 1) * 100;
    if (!t.charging && dKm > 0 && delta !== null) this.highKm = delta >= CONSUMPTION_ALERT_PCT ? this.highKm + dKm : 0;
    if (!t.charging && dtMin > 0) {
      const v = t.speedKmh ?? (dKm / dtMin) * 60;
      if (v >= 3) this.speedEwma.push(v, dtMin);
    }

    const whNow = liveWh ?? this.plannedWh;
    const soc = t.socPct;
    const projNext = soc !== null && next ? this.arriveSoc(soc, next.alongKm, next.detourKm, whNow) : null;
    const projDest = soc === null ? null : this.destinationSoc(soc, whNow);
    const kmLeft = Math.max(0, this.lengthKm - this.kmDone);

    const alerts: DriveAlert[] = [];
    if (!this.arrived) {
      if (kmLeft < ARRIVED_KM) {
        this.arrived = true;
        alerts.push(this.alert('arrived', 'info', "You've arrived", soc === null ? 'Trip complete.' : `Trip complete with ${Math.round(soc)}% battery.`, nowMs));
      } else {
        this.checkOffRoute(t, offRouteKm, nowMs, alerts);
        this.checkStopProblem(soc, next, whNow, nowMs, alerts);
        if (soc !== null && !t.charging && (!next || next.alongKm - this.kmDone > PASSED_STOP_KM)) {
          this.checkRange(soc, next, next ? projNext! : projDest!, delta, whNow, nowMs, alerts);
        }
      }
    }

    return {
      kmDone: round1(this.kmDone),
      kmLeft: round1(kmLeft),
      etaMin: this.eta(kmLeft),
      socPct: soc,
      liveWhPerKm: liveWh === null ? null : Math.round(liveWh),
      plannedWhPerKm: Math.round(this.plannedWh),
      consumptionDeltaPct: delta === null ? null : round1(delta),
      projectedSocAtNextStopPct: projNext === null ? null : round1(projNext),
      projectedSocAtDestinationPct: projDest === null ? null : round1(projDest),
      nextStop: next && {
        stationId: next.stationId,
        name: next.name,
        lat: next.lat,
        lng: next.lng,
        alongKm: round1(next.alongKm),
        kmAway: round1(Math.max(0, next.alongKm - this.kmDone) + next.detourKm),
        powerKw: next.powerKw,
        plannedArriveSocPct: next.plannedArriveSocPct,
        liveState: this.liveOf(next.stationId),
      },
      offRouteKm: offRouteKm === null ? null : Math.round(offRouteKm * 100) / 100,
      alerts,
    };
  }

  acknowledge(alertId: string): void {
    const stationId = this.suggested.get(alertId);
    if (stationId) this.rejected.add(stationId);
  }

  switchTo(s: Suggestion): void {
    const stop = this.toStop({
      stationId: s.stationId,
      name: s.name,
      alongKm: s.alongKm,
      plannedArriveSocPct: s.projectedArriveSocPct,
      lat: s.lat,
      lng: s.lng,
      powerKw: s.powerKw,
    });
    if (this.nextIdx < this.stopList.length) this.stopList[this.nextIdx] = stop;
    else this.stopList.push(stop);
    const ahead = this.stopList.splice(this.nextIdx).sort((a, b) => a.alongKm - b.alongKm);
    this.stopList.push(...ahead);
  }

  /** Updates kmDone from the position (or odometer) and returns the distance from the route. */
  private locate(t: Telemetry): number | null {
    if (t.lat !== null && t.lng !== null) {
      if (t.odometerKm !== null) this.lastOdo = t.odometerKm;
      const p = this.index.project(t.lng, t.lat, OFF_ROUTE_KM) ?? this.index.project(t.lng, t.lat, PROJECT_MAX_KM);
      if (!p) return this.nearestVertexKm(t.lng, t.lat);
      this.kmDone = Math.max(0, Math.min(this.lengthKm, p.alongKm));
      return p.offKm;
    }
    if (t.odometerKm !== null) {
      if (this.lastOdo !== null) this.kmDone = Math.min(this.lengthKm, this.kmDone + Math.max(0, t.odometerKm - this.lastOdo));
      this.lastOdo = t.odometerKm;
    }
    return null;
  }

  private nearestVertexKm(lng: number, lat: number): number {
    let best = Infinity;
    for (const c of this.index.coords) best = Math.min(best, haversineKm(c, [lng, lat]));
    return best;
  }

  /** Live Wh/km: the source's rolling figure when it has one, else from battery % drops over distance. */
  private trackConsumption(t: Telemetry, dKm: number): number | null {
    if (t.whPerKm !== null && t.whPerKm > 0) return t.whPerKm;
    const soc = t.socPct;
    if (soc !== null && !t.charging) {
      const a = this.socAnchor;
      if (!a || soc > a.soc + 0.5) this.socAnchor = { soc, km: this.kmDone };
      else if (this.kmDone - a.km >= 1 && a.soc - soc >= 0.5) {
        const km = this.kmDone - a.km;
        this.ownEwma.push((((a.soc - soc) / 100) * this.batteryKwh * 1000) / km, km);
        this.socAnchor = { soc, km: this.kmDone };
      }
    } else if (t.charging || dKm < 0) {
      this.socAnchor = null;
    }
    return this.ownEwma.observed >= MIN_OWN_OBSERVED_KM ? this.ownEwma.value : null;
  }

  private energyAt(alongKm: number): number {
    const cum = this.index.cumKm;
    let lo = 0, hi = cum.length - 1;
    if (hi < 1) return 0;
    if (alongKm >= cum[hi]) return this.cumKwh[hi];
    if (alongKm <= 0) return 0;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (cum[mid] <= alongKm) lo = mid;
      else hi = mid;
    }
    const seg = cum[hi] - cum[lo];
    const t = seg === 0 ? 0 : (alongKm - cum[lo]) / seg;
    return this.cumKwh[lo] + t * (this.cumKwh[hi] - this.cumKwh[lo]);
  }

  /** kWh from one point on the route to another at a given consumption, hills included. */
  private kwhBetween(fromKm: number, toKm: number, whPerKm: number): number {
    return Math.max(0, this.energyAt(toKm) - this.energyAt(fromKm)) * (whPerKm / this.profileWh);
  }

  private pct(kwh: number): number {
    return (kwh / this.batteryKwh) * 100;
  }

  private arriveSoc(soc: number, alongKm: number, detourKm: number, whPerKm: number): number {
    return soc - this.pct(this.kwhBetween(this.kmDone, alongKm, whPerKm) + (detourKm * whPerKm) / 1000);
  }

  private destinationSoc(soc: number, whPerKm: number): number {
    if (this.nextIdx >= this.stopList.length) return this.arriveSoc(soc, this.lengthKm, 0, whPerKm);
    const last = this.stopList[this.stopList.length - 1];
    const plannedKwh = this.kwhBetween(last.alongKm, this.lengthKm, this.plannedWh);
    return this.input.plannedArrivalSocPct - this.pct(plannedKwh * (whPerKm / this.plannedWh - 1));
  }

  private eta(kmLeft: number): number {
    const avg = this.speedEwma.observed >= MIN_SPEED_OBSERVED_MIN ? this.speedEwma.value : null;
    let minutes =
      avg && avg > 0
        ? (kmLeft / avg) * 60
        : this.input.routeDurationMin && this.lengthKm > 0
          ? (this.input.routeDurationMin * kmLeft) / this.lengthKm
          : kmLeft;
    for (let i = this.nextIdx; i < this.stopList.length; i++) minutes += this.stopList[i].chargeMinutes ?? 0;
    return Math.round(minutes);
  }

  private liveOf(stationId: string): LiveState {
    return this.live.get(stationId) ?? 'unknown';
  }

  private checkOffRoute(t: Telemetry, offKm: number | null, nowMs: number, alerts: DriveAlert[]): void {
    const off = offKm !== null && offKm > OFF_ROUTE_KM && !t.charging && !this.nearStop(t);
    this.offCount = off ? this.offCount + 1 : 0;
    if (this.offCount < OFF_ROUTE_UPDATES || offKm === null) return;
    const km = offKm >= 10 ? Math.round(offKm) : round1(offKm);
    this.fire(alerts, 'off_route', 'off_route', 'warn', nowMs, "You're off the planned route",
      `You're about ${km} km from the planned route, so charge estimates may be off. Head back to the route or plan again from here.`);
  }

  private nearStop(t: Telemetry): boolean {
    if (t.lat === null || t.lng === null) return false;
    const a = this.stopList[this.nextIdx];
    const b = this.stopList[this.nextIdx - 1];
    return (
      (a !== undefined && haversineKm([a.lng, a.lat], [t.lng, t.lat]) < NEAR_STOP_KM) ||
      (b !== undefined && haversineKm([b.lng, b.lat], [t.lng, t.lat]) < NEAR_STOP_KM)
    );
  }

  private checkStopProblem(soc: number | null, next: Stop | null, whNow: number, nowMs: number, alerts: DriveAlert[]): void {
    if (!next || this.liveOf(next.stationId) !== 'problem') return;
    const alt = soc === null ? null : this.bestNear(next, soc, whNow);
    const body = alt
      ? `Drivers reported a problem at ${next.name} recently. ${alt.name} is ${round1(haversineKm([alt.lng, alt.lat], [next.lng, next.lat]))} km from it` +
        `${alt.liveState === 'working' ? ' and charged fine recently' : ''}; you'd arrive with about ${alt.projectedArriveSocPct}%.`
      : `Drivers reported a problem at ${next.name} recently, and no other compatible charger within ${ALTERNATIVE_RADIUS_KM} km of it is in reach. Check recent reports or call the operator before relying on it.`;
    // Once per stop: repeating a problem report every few minutes only adds noise.
    this.fire(alerts, 'stop_problem', `stop_problem:${next.stationId}`, alt ? 'warn' : 'critical', nowMs,
      `Problem reported at ${next.name}`, body, alt ?? undefined, Infinity);
  }

  private checkRange(soc: number, next: Stop | null, projTarget: number, delta: number | null, whNow: number, nowMs: number, alerts: DriveAlert[]): void {
    const targetKm = next ? next.alongKm : this.lengthKm;
    const targetName = next ? next.name : 'your destination';
    if (projTarget < CANT_REACH_PCT) {
      const nearest = this.nearestAhead(soc, whNow, next ? projTarget : -Infinity, false);
      if (!nearest || nearest.projectedArriveSocPct < CANT_REACH_PCT) {
        const body = nearest
          ? `Even the nearest charger, ${nearest.name} (${nearest.kmAway} km), is out of safe reach: about ${nearest.projectedArriveSocPct}% on arrival at this rate. ` +
            'Slow to 60–70 km/h and switch the AC off to stretch your range.'
          : 'No compatible charger ahead is within reach at this rate. Slow to 60–70 km/h, switch the AC off and look for a charger or a 3-pin socket nearby.';
        const suggestion = nearest && !this.rejected.has(nearest.stationId) ? nearest : undefined;
        this.fire(alerts, 'cant_reach', 'cant_reach', 'critical', nowMs, 'You may not reach a charger', body, suggestion);
        return;
      }
    }
    const threshold = next ? this.stopReserve + STOP_MARGIN_PCT : this.arriveReserve / 2;
    const consumptionHigh = delta !== null && delta >= CONSUMPTION_ALERT_PCT && this.highKm >= SUSTAINED_KM;
    if (projTarget >= threshold || (!consumptionHigh && projTarget >= CANT_REACH_PCT)) return;

    let suggestion = this.bestOnRoute(this.kmDone + SUGGEST_FROM_KM, targetKm, next?.stationId ?? null, soc, whNow);
    let severity: AlertSeverity = projTarget < CANT_REACH_PCT ? 'critical' : 'warn';
    if (!suggestion) {
      suggestion = this.nearestAhead(soc, whNow, -Infinity, true);
      if (suggestion) severity = 'critical';
    }
    const reach = projTarget <= 0 ? `you may not make it to ${targetName}` : `you'd reach ${targetName} with about ${Math.round(projTarget)}%`;
    const advice = suggestion
      ? ` Charge earlier at ${suggestion.name}, ${suggestion.kmAway} km ahead (about ${suggestion.projectedArriveSocPct}% on arrival).`
      : ' Slow down a little and switch the AC off to stretch your range.';
    const [title, cause] = consumptionHigh
      ? ['Using more charge than planned', `You're using about ${Math.round(delta!)}% more energy than planned. At this rate`]
      : ['Charge earlier than planned', 'With the charge you have now,'];
    this.fire(alerts, 'range_drop', 'range_drop', severity, nowMs, title, `${cause} ${reach}.${advice}`, suggestion ?? undefined);
  }

  /** Best charger on the route between two points that's reachable with a safe margin. */
  private bestOnRoute(fromKm: number, toKm: number, excludeId: string | null, soc: number, whNow: number): Suggestion | null {
    let best: Candidate | null = null;
    let bestScore = Infinity;
    let bestArrive = 0;
    for (let i = this.lowerBound(fromKm); i < this.candidates.length; i++) {
      const c = this.candidates[i];
      if (c.alongKm >= toKm) break;
      if (c.offKm > CORRIDOR_KM || c.station.id === excludeId || this.rejected.has(c.station.id)) continue;
      const live = this.liveOf(c.station.id);
      if (live === 'problem') continue;
      const arrive = this.arriveSoc(soc, c.alongKm, c.detourKm, whNow);
      if (arrive < SUGGEST_MIN_ARRIVE_PCT) continue;
      // Losing the least distance means charging as close to the original stop as possible.
      const score = rank(live, c) + Math.min(0.999, (toKm - c.alongKm) / 1000);
      if (score < bestScore) {
        best = c;
        bestScore = score;
        bestArrive = arrive;
      }
    }
    return best && this.suggestion(best, bestArrive);
  }

  /** Best alternative within reach of a planned stop that has a problem. */
  private bestNear(stop: Stop, soc: number, whNow: number): Suggestion | null {
    let best: Candidate | null = null;
    let bestScore = Infinity;
    let bestArrive = 0;
    const from = Math.max(this.kmDone + PASSED_STOP_KM / 2, stop.alongKm - 2 * ALTERNATIVE_RADIUS_KM);
    for (let i = this.lowerBound(from); i < this.candidates.length; i++) {
      const c = this.candidates[i];
      if (c.alongKm > stop.alongKm + 2 * ALTERNATIVE_RADIUS_KM) break;
      if (c.station.id === stop.stationId || this.rejected.has(c.station.id)) continue;
      const live = this.liveOf(c.station.id);
      if (live === 'problem') continue;
      const dist = haversineKm([c.station.lng, c.station.lat], [stop.lng, stop.lat]);
      if (dist > ALTERNATIVE_RADIUS_KM) continue;
      const arrive = this.arriveSoc(soc, c.alongKm, c.detourKm, whNow);
      if (arrive < SUGGEST_MIN_ARRIVE_PCT) continue;
      const score = rank(live, c) + dist / 100;
      if (score < bestScore) {
        best = c;
        bestScore = score;
        bestArrive = arrive;
      }
    }
    return best && this.suggestion(best, bestArrive);
  }

  /** The charger ahead with the most charge left on arrival among the first few km of chargers. */
  private nearestAhead(soc: number, whNow: number, nextStopArrive: number, skipRejected: boolean): Suggestion | null {
    let best: Candidate | null = null;
    let bestArrive = -Infinity;
    let windowEnd = Infinity;
    for (let i = this.lowerBound(this.kmDone); i < this.candidates.length; i++) {
      const c = this.candidates[i];
      if (c.alongKm > windowEnd) break;
      if (c.offKm > CORRIDOR_KM || this.liveOf(c.station.id) === 'problem') continue;
      if (skipRejected && this.rejected.has(c.station.id)) continue;
      if (windowEnd === Infinity) windowEnd = c.alongKm + NEAREST_WINDOW_KM;
      const arrive = this.arriveSoc(soc, c.alongKm, c.detourKm, whNow);
      if (arrive > bestArrive) {
        best = c;
        bestArrive = arrive;
      }
    }
    const next = this.stopList[this.nextIdx];
    if (next && nextStopArrive > bestArrive && !(skipRejected && this.rejected.has(next.stationId))) {
      const c = this.candidates.find((x) => x.station.id === next.stationId);
      if (c) return this.suggestion(c, nextStopArrive);
    }
    return best && this.suggestion(best, bestArrive);
  }

  private lowerBound(km: number): number {
    let lo = 0, hi = this.candidates.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (this.candidates[mid].alongKm < km) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  }

  private suggestion(c: Candidate, arrive: number): Suggestion {
    return {
      stationId: c.station.id,
      name: c.station.name,
      lat: c.station.lat,
      lng: c.station.lng,
      alongKm: round1(c.alongKm),
      kmAway: round1(Math.max(0, c.alongKm - this.kmDone) + c.detourKm),
      projectedArriveSocPct: Math.round(arrive),
      powerKw: Math.round(c.powerKw),
      mode: c.mode,
      liveState: this.liveOf(c.station.id),
    };
  }

  private alert(kind: AlertKind, severity: AlertSeverity, title: string, body: string, at: number, suggestion?: Suggestion): DriveAlert {
    const id = `${kind}-${++this.seq}`;
    if (suggestion) this.suggested.set(id, suggestion.stationId);
    return suggestion ? { id, kind, severity, title, body, suggestion, at } : { id, kind, severity, title, body, at };
  }

  /** Raises an alert unless the same one went out within the cooldown at the same or a higher severity. */
  private fire(
    alerts: DriveAlert[],
    kind: AlertKind,
    key: string,
    severity: AlertSeverity,
    nowMs: number,
    title: string,
    body: string,
    suggestion?: Suggestion,
    cooldownMs = COOLDOWN_MS,
  ): void {
    const last = this.fired.get(key);
    if (last && nowMs - last.at < cooldownMs && SEVERITY_RANK[severity] <= SEVERITY_RANK[last.severity]) return;
    this.fired.set(key, { at: nowMs, severity });
    alerts.push(this.alert(kind, severity, title, body, nowMs, suggestion));
  }
}

/** Lower is better: reported working, then DC, then power class. */
function rank(live: LiveState, c: Candidate): number {
  const powerClass = c.powerKw >= 50 ? 0 : c.powerKw >= 25 ? 1 : 2;
  return LIVE_RANK[live] * 100 + (c.mode === 'dc' ? 0 : 10) + powerClass;
}

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}
