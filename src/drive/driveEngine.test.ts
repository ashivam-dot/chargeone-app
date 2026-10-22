import { describe, expect, it } from 'vitest';
import type { Station } from '../data/model.ts';
import type { Coord } from '../planner/geometry.ts';
import { DEFAULT_OPTIONS, planTrip, type TripPlan } from '../planner/planner.ts';
import type { LiveState } from '../shared/status.ts';
import { VEHICLES, myVehicleFromModel } from '../shared/vehicles.ts';
import { DemoCarSource, type DemoScenario } from '../vehicle/demoCar.ts';
import type { Telemetry } from '../vehicle/types.ts';
import { createDriveSession, type DriveAlert, type DriveInput, type DriveSession, type DriveState } from './driveEngine.ts';

const KM_PER_DEG_LAT = 111.2;
const LNG = 77;
const START_LAT = 20;
const ROUTE_KM = 300;
const nexon = myVehicleFromModel(VEHICLES.find((v) => v.id === 'tata-nexon-ev-45')!);

function route(km: number): Coord[] {
  const coords: Coord[] = [];
  for (let d = 0; d <= km; d += 5) coords.push([LNG, START_LAT + d / KM_PER_DEG_LAT]);
  return coords;
}

function dcStation(id: string, atKm: number, over: Partial<Station> = {}): Station {
  return {
    id,
    name: `Charger ${id}`,
    operator: 'Test',
    lat: START_LAT + atKm / KM_PER_DEG_LAT,
    lng: LNG + 0.003,
    connectors: [{ type: 'CCS2', count: 1, kw: 60 }],
    points: 1,
    maxKw: 60,
    speed: 'dc',
    vehicles: ['car'],
    batterySwap: false,
    hours: '24/7',
    is24x7: true,
    price: null,
    access: 'public',
    address: null,
    website: null,
    sources: [],
    confidence: 0.8,
    ...over,
  };
}

/** A DC charger every 30 km. */
const corridor = Array.from({ length: 9 }, (_, i) => dcStation(`km${(i + 1) * 30}`, (i + 1) * 30));
const coords = route(ROUTE_KM);

function plan(): TripPlan {
  return planTrip({
    route: { coords, distanceKm: ROUTE_KM, durationMin: 240 },
    stations: corridor,
    statuses: new Map(),
    vehicle: nexon,
    options: DEFAULT_OPTIONS,
    now: new Date('2026-10-20T04:00:00Z'),
  });
}

function sessionInput(p: TripPlan, stations: Station[] = corridor): DriveInput {
  return {
    route: coords,
    stops: p.stops.map((s) => ({
      stationId: s.station.id,
      name: s.station.name,
      alongKm: s.alongKm,
      plannedArriveSocPct: s.arriveSocPct,
      lat: s.lat,
      lng: s.lng,
      powerKw: s.powerKw,
      chargeMinutes: s.chargeMinutes,
    })),
    plannedArrivalSocPct: p.arrivalSocPct,
    vehicle: nexon,
    stations,
    routeDurationMin: 240,
  };
}

interface Run {
  alerts: Array<DriveAlert & { kmDone: number }>;
  states: DriveState[];
  car: DemoCarSource;
  session: DriveSession;
}

function drive(
  scenario: DemoScenario,
  opts: {
    chargeAtPlannedStops?: boolean;
    untilKm?: number;
    seed?: number;
    stations?: Station[];
    onAlert?: (a: DriveAlert, s: DriveSession) => void;
    live?: (kmDone: number) => ReadonlyMap<string, LiveState> | undefined;
  } = {},
): Run {
  const p = plan();
  const session = createDriveSession(sessionInput(p, opts.stations));
  const car = new DemoCarSource({
    vehicle: nexon,
    route: coords,
    startSocPct: DEFAULT_OPTIONS.startSocPct,
    scenario,
    seed: opts.seed ?? 1,
    startAtMs: 0,
    chargeStops: opts.chargeAtPlannedStops ? p.stops.map((s) => ({ alongKm: s.alongKm, toPct: s.departSocPct, powerKw: s.powerKw })) : [],
  });
  const run: Run = { alerts: [], states: [], car, session };
  let t: Telemetry = car.reading();
  while (!car.finished && car.kmDone < (opts.untilKm ?? Infinity)) {
    t = car.step(2);
    const state = session.update(t, t.at, opts.live?.(car.kmDone));
    run.states.push(state);
    for (const a of state.alerts) {
      run.alerts.push({ ...a, kmDone: state.kmDone });
      opts.onAlert?.(a, session);
    }
  }
  if (car.finished) {
    const state = session.update(t, t.at + 2000);
    run.states.push(state);
    for (const a of state.alerts) run.alerts.push({ ...a, kmDone: state.kmDone });
  }
  return run;
}

function telemetry(lat: number, lng: number, over: Partial<Telemetry> = {}): Telemetry {
  return {
    at: 0,
    source: 'demo',
    socPct: 70,
    socMeasured: true,
    rangeKm: null,
    speedKmh: 80,
    powerKw: null,
    whPerKm: null,
    batteryTempC: null,
    sohPct: null,
    odometerKm: null,
    charging: false,
    lat,
    lng,
    headingDeg: null,
    ...over,
  };
}

const latAt = (km: number) => START_LAT + km / KM_PER_DEG_LAT;

describe('drive engine fixture', () => {
  it('plans one stop at km 180 on the test corridor', () => {
    const p = plan();
    expect(p.feasible).toBe(true);
    expect(p.stops.map((s) => s.station.id)).toEqual(['km180']);
  });
});

describe('createDriveSession', () => {
  it('tracks progress, consumption and projections on a normal drive without false alarms', () => {
    for (const seed of [1, 2, 3, 4, 5]) {
      const run = drive('normal', { chargeAtPlannedStops: true, seed });
      const kinds = run.alerts.map((a) => a.kind);
      expect(kinds, `seed ${seed}`).toEqual(['arrived']);
      expect(run.alerts[0].kmDone).toBeGreaterThanOrEqual(ROUTE_KM - 0.3);
    }
    const run = drive('normal', { untilKm: 100 });
    const s = run.states.at(-1)!;
    expect(s.kmDone).toBeCloseTo(100, 0);
    expect(s.kmLeft).toBeCloseTo(200, 0);
    expect(Math.abs(s.consumptionDeltaPct!)).toBeLessThan(15);
    expect(s.nextStop).toMatchObject({ stationId: 'km180', liveState: 'unknown' });
    expect(s.nextStop!.kmAway).toBeCloseTo(80.4, 0);
    expect(Math.abs(s.projectedSocAtNextStopPct! - plan().stops[0].arriveSocPct)).toBeLessThan(6);
    expect(s.projectedSocAtDestinationPct).toBeGreaterThan(15);
    expect(s.offRouteKm).toBeLessThan(0.01);
    // 200 km at the recent 60–100 km/h, plus the planned charge.
    expect(s.etaMin).toBeGreaterThan(120 + plan().chargeMinutes);
    expect(s.etaMin).toBeLessThan(200 + plan().chargeMinutes);
  });

  it('warns about a range drop before the first stop and suggests a reachable earlier charger', () => {
    const run = drive('range_drop', { untilKm: 180 });
    const first = run.alerts.find((a) => a.kind === 'range_drop')!;
    expect(first).toBeDefined();
    expect(first.kmDone).toBeLessThan(80);
    expect(first.kmDone).toBeGreaterThan(ROUTE_KM * 0.12);
    expect(first.title).toBe('Using more charge than planned');
    const s = first.suggestion!;
    expect(s.alongKm).toBeLessThan(180);
    expect(s.alongKm).toBeGreaterThan(first.kmDone + 2);
    expect(s.projectedArriveSocPct).toBeGreaterThanOrEqual(6);
    expect(run.alerts.some((a) => a.kind === 'cant_reach' && a.kmDone < s.alongKm)).toBe(false);

    // The suggestion holds up: the car really gets there with charge to spare...
    const check = drive('range_drop', { untilKm: s.alongKm });
    expect(check.car.socPct).toBeGreaterThan(6);
    // ...whereas the planned stop would have been out of reach.
    expect(run.car.socPct).toBeLessThan(3);
    // Driving past every earlier charger leaves nothing in reach, and the engine says so.
    expect(run.alerts.find((a) => a.kind === 'cant_reach')?.severity).toBe('critical');
  });

  it('prefers a charger reported working, and never one with a problem', () => {
    const live = new Map<string, LiveState>([
      ['km150', 'problem'],
      ['km90', 'working'],
    ]);
    const run = drive('range_drop', { untilKm: 120, live: () => live });
    const first = run.alerts.find((a) => a.kind === 'range_drop')!;
    expect(first.suggestion!.stationId).toBe('km90');
    expect(first.suggestion!.liveState).toBe('working');
  });

  it('escalates but does not repeat within the cooldown, and drops acknowledged suggestions', () => {
    const acked = new Set<string>();
    const run = drive('range_drop', {
      untilKm: 179,
      onAlert: (a, s) => {
        if (a.kind === 'range_drop' && a.suggestion) {
          acked.add(a.suggestion.stationId);
          s.acknowledge(a.id);
        }
      },
    });
    const drops = run.alerts.filter((a) => a.kind === 'range_drop');
    expect(drops.length).toBeGreaterThanOrEqual(2);
    const rank = { info: 0, warn: 1, critical: 2 };
    for (let i = 1; i < drops.length; i++) {
      const gap = drops[i].at - drops[i - 1].at;
      expect(gap >= 10 * 60_000 || rank[drops[i].severity] > rank[drops[i - 1].severity]).toBe(true);
    }
    const suggested = drops.map((a) => a.suggestion?.stationId).filter(Boolean);
    expect(new Set(suggested).size).toBe(suggested.length);
    expect(new Set(run.alerts.map((a) => a.id)).size).toBe(run.alerts.length);
  });

  it('switches the next stop to an accepted suggestion', () => {
    let switched = false;
    const run = drive('range_drop', {
      untilKm: 120,
      onAlert: (a, s) => {
        if (!switched && a.kind === 'range_drop' && a.suggestion) {
          s.switchTo(a.suggestion);
          s.acknowledge(a.id);
          switched = true;
        }
      },
    });
    const suggestion = run.alerts.find((a) => a.kind === 'range_drop')!.suggestion!;
    expect(run.session.stops.map((s) => s.stationId)).toEqual([suggestion.stationId]);
    const s = run.states.at(-1)!;
    expect(s.nextStop!.stationId).toBe(suggestion.stationId);
    expect(s.projectedSocAtNextStopPct).toBeGreaterThan(3);
  });

  it('suggests a nearby alternative when the next stop gets a problem report', () => {
    const stations = [...corridor, dcStation('near-unknown', 172), dcStation('near-working', 188), dcStation('near-bad', 176)];
    const live = (km: number) =>
      km < 100
        ? undefined
        : new Map<string, LiveState>([
            ['km180', 'problem'],
            ['near-working', 'working'],
            ['near-bad', 'problem'],
          ]);
    const run = drive('normal', { untilKm: 140, stations, live });
    const problems = run.alerts.filter((a) => a.kind === 'stop_problem');
    expect(problems).toHaveLength(1);
    expect(problems[0].kmDone).toBeGreaterThanOrEqual(100);
    expect(problems[0].suggestion).toMatchObject({ stationId: 'near-working', liveState: 'working' });
    expect(problems[0].title).toBe('Problem reported at Charger km180');
    expect(run.states.at(-1)!.nextStop!.liveState).toBe('problem');
  });

  it('raises a critical alert when no charger ahead is within reach', () => {
    const session = createDriveSession(sessionInput(plan()));
    const s = session.update(telemetry(latAt(40), LNG, { socPct: 4, whPerKm: 160 }), 0);
    expect(s.alerts.map((a) => [a.kind, a.severity])).toEqual([['cant_reach', 'critical']]);
    expect(s.alerts[0].suggestion?.stationId).toBe('km60');
    expect(s.alerts[0].body).toMatch(/Slow to 60–70 km\/h/);
  });

  it('flags leaving the route after two updates, but not near a charging stop', () => {
    const session = createDriveSession(sessionInput(plan()));
    const off = (km: number) => telemetry(latAt(km), LNG + 0.03);
    expect(session.update(off(50), 0).alerts).toEqual([]);
    const s = session.update(off(50.5), 2000);
    expect(s.offRouteKm).toBeGreaterThan(3);
    expect(s.kmDone).toBeCloseTo(50.5, 0);
    expect(s.alerts.map((a) => a.kind)).toEqual(['off_route']);
    expect(session.update(off(51), 4000).alerts).toEqual([]);
    session.update(telemetry(latAt(52), LNG), 6000);
    expect(session.update(off(53), 8000).alerts).toEqual([]);
    expect(session.update(off(53.5), 10_000).alerts).toEqual([]);

    const nearStop = createDriveSession(sessionInput(plan()));
    nearStop.update(telemetry(latAt(179), LNG + 0.025), 0);
    expect(nearStop.update(telemetry(latAt(179.5), LNG + 0.025), 2000).alerts).toEqual([]);
  });

  it('works out progress from the odometer when there is no position', () => {
    const session = createDriveSession(sessionInput(plan()));
    session.update(telemetry(latAt(10), LNG, { odometerKm: 5000 }), 0);
    const s = session.update(telemetry(0, 0, { lat: null, lng: null, odometerKm: 5012 }), 60_000);
    expect(s.kmDone).toBeCloseTo(22, 0);
    expect(s.offRouteKm).toBeNull();
  });

  it('estimates consumption from battery % when the source gives no Wh/km', () => {
    const session = createDriveSession(sessionInput(plan()));
    let s: DriveState | null = null;
    for (let km = 0; km <= 20; km += 0.5) {
      const soc = 80 - ((km * 200) / 45_000) * 100;
      s = session.update(telemetry(latAt(km), LNG, { socPct: soc }), km * 45_000);
    }
    expect(s!.liveWhPerKm).toBeGreaterThan(185);
    expect(s!.liveWhPerKm).toBeLessThan(215);
    expect(s!.consumptionDeltaPct).toBeGreaterThan(20);
  });

  it('announces arrival once', () => {
    const session = createDriveSession(sessionInput(plan()));
    const end = telemetry(latAt(ROUTE_KM - 0.1), LNG, { socPct: 22 });
    const s = session.update(end, 0);
    expect(s.alerts.map((a) => [a.kind, a.severity, a.body])).toEqual([['arrived', 'info', 'Trip complete with 22% battery.']]);
    expect(session.update(end, 2000).alerts).toEqual([]);
  });
});
