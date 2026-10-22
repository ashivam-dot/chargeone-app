import { describe, expect, it } from 'vitest';
import type { Station } from '../data/model.ts';
import type { StationStatus } from '../shared/status.ts';
import { VEHICLES, myVehicleFromModel } from '../shared/vehicles.ts';
import { RouteIndex, type Coord } from './geometry.ts';
import { DEFAULT_OPTIONS, chargeMinutes, cumulativeEnergy, navigationUrl, planTrip, type PlanInput } from './planner.ts';

const KM_PER_DEG_LAT = 111.2;
const LNG = 77;
const START_LAT = 20;
const now = new Date('2026-10-20T10:00:00Z');

/** A straight north-bound route with a vertex every 5 km. */
function route(km: number): PlanInput['route'] {
  const coords: Coord[] = [];
  for (let d = 0; d <= km; d += 5) coords.push([LNG, START_LAT + d / KM_PER_DEG_LAT]);
  return { coords, distanceKm: km, durationMin: km };
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
    ...over,
  };
}

const nexon = myVehicleFromModel(VEHICLES.find((v) => v.id === 'tata-nexon-ev-45')!);

function plan(km: number, stations: Station[], statuses = new Map<string, StationStatus>(), vehicle = nexon) {
  return planTrip({ route: route(km), stations, statuses, vehicle, options: DEFAULT_OPTIONS, now });
}

describe('RouteIndex', () => {
  it('projects a nearby point onto the route', () => {
    const index = new RouteIndex(route(100).coords);
    const p = index.project(LNG + 0.02, START_LAT + 50 / KM_PER_DEG_LAT, 5)!;
    expect(p.alongKm).toBeCloseTo(50, 0);
    expect(p.offKm).toBeCloseTo(2.05, 1);
    expect(index.project(LNG + 1, START_LAT, 5)).toBeNull();
  });

  it('finds points beside long straight segments', () => {
    const index = new RouteIndex([[LNG, START_LAT], [LNG, START_LAT + 1]]);
    expect(index.project(LNG + 0.01, START_LAT + 0.5, 3)?.alongKm).toBeCloseTo(55.6, 0);
  });
});

describe('planTrip', () => {
  it('needs no stop for a short trip', () => {
    const p = plan(100, [dcStation('a', 50)]);
    expect(p.feasible).toBe(true);
    expect(p.stops).toHaveLength(0);
    expect(p.arrivalSocPct).toBeGreaterThan(40);
    expect(p.arrivalSocPct).toBeLessThan(50);
  });

  it('picks the farthest good charger in reach and only charges what is needed', () => {
    const p = plan(400, [dcStation('a', 120), dcStation('b', 190), dcStation('c', 300)]);
    expect(p.feasible).toBe(true);
    expect(p.stops.map((s) => s.station.id)).toEqual(['b', 'c']);
    expect(p.stops[0].departSocPct).toBe(80);
    expect(p.stops[1].departSocPct).toBeLessThan(80);
    expect(p.stops[0].arriveSocPct).toBeGreaterThanOrEqual(DEFAULT_OPTIONS.stopReservePct);
    expect(p.arrivalSocPct).toBeGreaterThanOrEqual(DEFAULT_OPTIONS.arriveReservePct);
    expect(p.stops[0].backups.map((b) => b.station.id)).toContain('a');
  });

  it('prefers a charger reported working over one with a recent problem', () => {
    const statuses = new Map<string, StationStatus>([
      ['bad', { stationId: 'bad', lastWorkedAt: null, lastWorkedKw: null, lastWorkedVehicle: null, inUseSince: null, queueAt: null, problemAt: '2026-10-20T08:00:00Z', problemKind: 'broken', problemReports: 2, reports7d: 2 }],
      ['good', { stationId: 'good', lastWorkedAt: '2026-10-20T07:00:00Z', lastWorkedKw: 55, lastWorkedVehicle: 'Nexon EV', inUseSince: null, queueAt: null, problemAt: null, problemKind: null, problemReports: 0, reports7d: 1 }],
    ]);
    const p = plan(300, [dcStation('good', 170), dcStation('bad', 185)], statuses);
    expect(p.stops[0].station.id).toBe('good');
    expect(p.stops[0].confidence).toBe('high');
    expect(p.stops[0].notes.join(' ')).toMatch(/Last charged fine 3 h ago/);
  });

  it('reports a gap when no charger is in reach', () => {
    const p = plan(600, [dcStation('a', 50), dcStation('b', 500)]);
    expect(p.feasible).toBe(false);
    expect(p.gapAtKm).not.toBeNull();
    expect(p.warnings[0]).toMatch(/Not safe to drive as planned/);
  });

  it('skips 2-wheeler-only and battery-swap stations', () => {
    const p = plan(300, [dcStation('ather', 150, { vehicles: ['2w'] }), dcStation('swap', 160, { batterySwap: true })]);
    expect(p.feasible).toBe(false);
  });

  it('uses AC chargers for cars without DC charging', () => {
    const comet = myVehicleFromModel(VEHICLES.find((v) => v.id === 'mg-comet')!);
    const ac = dcStation('ac', 80, { connectors: [{ type: 'Type 2', count: 1, kw: 7.4 }], speed: 'ac', maxKw: 7.4 });
    const p = plan(170, [dcStation('dc', 70), ac], new Map(), comet);
    expect(p.stops.map((s) => s.station.id)).toEqual(['ac']);
    expect(p.stops[0].mode).toBe('ac');
    expect(p.stops[0].chargeMinutes).toBeGreaterThan(60);
  });

  it('honours the driver’s real highway range', () => {
    const shortRange = { ...nexon, realRangeKm: 200 };
    const p = plan(180, [dcStation('a', 90)], new Map(), shortRange);
    expect(p.stops).toHaveLength(1);
  });
});

describe('chargeMinutes', () => {
  it('tapers DC charging above 80%', () => {
    const to80 = chargeMinutes(10, 80, 45, 60, 'dc');
    const to100 = chargeMinutes(10, 100, 45, 60, 'dc');
    expect(to80).toBeGreaterThan(40);
    expect(to80).toBeLessThan(60);
    expect(to100 - to80).toBeGreaterThan(20);
    expect(chargeMinutes(50, 40, 45, 60, 'dc')).toBe(0);
  });
});

it('builds a Google Maps link with stops as waypoints', () => {
  const p = plan(400, [dcStation('b', 190), dcStation('c', 300)]);
  const url = new URL(navigationUrl({ lat: 20, lng: 77 }, { lat: 23.6, lng: 77 }, p.stops));
  expect(url.searchParams.get('waypoints')?.split('|')).toHaveLength(2);
  expect(url.searchParams.get('destination')).toBe('23.6,77');
});

describe('routes without elevation', () => {
  it('plans 2-D routes (the keyless routers send none) as flat roads', () => {
    const vehicle = myVehicleFromModel(VEHICLES[0]);
    const flat = route(100).coords;
    const level = flat.map(([lng, lat]) => [lng, lat, 900] as Coord);
    const a = cumulativeEnergy(new RouteIndex(flat), flat, vehicle, DEFAULT_OPTIONS);
    const b = cumulativeEnergy(new RouteIndex(level), level, vehicle, DEFAULT_OPTIONS);
    expect(a.every(Number.isFinite)).toBe(true);
    expect(a.at(-1)).toBeGreaterThan(0);
    expect(a.at(-1)).toBeCloseTo(b.at(-1)!, 9);
  });
});
