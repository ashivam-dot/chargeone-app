import { describe, expect, it } from 'vitest';
import type { Station } from '../data/model.ts';
import type { StationStatus } from '../shared/status.ts';
import { VEHICLES, baseWhPerKm, myVehicleFromModel } from '../shared/vehicles.ts';
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
    confidence: 0.8,
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

describe('trusted stops only', () => {
  const worked = (id: string): StationStatus => ({
    stationId: id,
    lastWorkedAt: '2026-10-19T10:00:00Z',
    lastWorkedKw: 50,
    lastWorkedVehicle: 'Nexon EV',
    inUseSince: null,
    queueAt: null,
    problemAt: null,
    problemKind: null,
    problemReports: 0,
    reports7d: 1,
  });

  it('never plans a stop below the confidence line, and lists it as an extra option', () => {
    const p = plan(400, [dcStation('b', 190, { confidence: 0.3 }), dcStation('c', 300)]);
    expect(p.stops.map((s) => s.station.id)).not.toContain('b');
    expect(p.stops.every((s) => s.trusted)).toBe(true);
    expect(p.feasible).toBe(false);
    expect(p.extras.map((s) => s.station.id)).toContain('b');
    expect(p.extrasFeasible).toBe(true);
    expect(p.warnings[0]).toMatch(/only on chargers we're sure of/);
  });

  it('plans unverified chargers only when the driver allows them, and says so', () => {
    const stations = [dcStation('b', 190, { confidence: 0.3 }), dcStation('c', 300)];
    const p = planTrip({ route: route(400), stations, statuses: new Map(), vehicle: nexon, options: { ...DEFAULT_OPTIONS, allowUnverified: true }, now });
    expect(p.feasible).toBe(true);
    const b = p.stops.find((s) => s.station.id === 'b')!;
    expect(b.trusted).toBe(false);
    expect(b.confidence).toBe('low');
    expect(b.notes.join(' ')).toMatch(/Unverified/);
    expect(p.extras).toHaveLength(0);
  });

  it('counts a recent "charged fine" report towards trust', () => {
    const p = plan(400, [dcStation('b', 190, { confidence: 0.3 }), dcStation('c', 300)], new Map([['b', worked('b')]]));
    expect(p.feasible).toBe(true);
    expect(p.stops.map((s) => s.station.id)).toEqual(['b', 'c']);
  });

  it('never plans a stop at a DC charger whose plug is not confirmed', () => {
    const p = plan(400, [dcStation('b', 190, { connectors: [] }), dcStation('c', 300)]);
    expect(p.stops.map((s) => s.station.id)).not.toContain('b');
    expect(p.extras.map((s) => s.station.id)).toContain('b');
  });

  it('plans only DC stops for a DC car even when trusted AC is on the way', () => {
    const ac = dcStation('ac', 190, { connectors: [{ type: 'Type 2', count: 1, kw: 7.4 }], speed: 'ac', maxKw: 7.4 });
    const p = plan(400, [ac, dcStation('c', 300)]);
    expect(p.stops.map((s) => s.station.id)).not.toContain('ac');
    expect(p.stops.every((s) => s.mode === 'dc')).toBe(true);
  });

  it('gives every planned stop a backup within the remaining range', () => {
    const p = plan(400, [dcStation('a', 150), dcStation('b', 190), dcStation('b2', 175), dcStation('c', 300), dcStation('c2', 285)]);
    expect(p.feasible).toBe(true);
    for (const s of p.stops) {
      expect(s.backups.length).toBeGreaterThan(0);
      for (const b of s.backups) expect(b.arriveSocPct).toBeGreaterThanOrEqual(5);
    }
  });

  it('offers an unverified backup when no trusted one is in range, marked as such', () => {
    const p = plan(400, [dcStation('b', 190), dcStation('b2', 170, { confidence: 0.2 }), dcStation('c', 300)]);
    const b = p.stops.find((s) => s.station.id === 'b')!;
    expect(b.backups.map((x) => x.station.id)).toContain('b2');
    expect(b.backups.find((x) => x.station.id === 'b2')!.trusted).toBe(false);
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

describe('stops the planner must not count on', () => {
  const broken = (id: string): StationStatus => ({
    stationId: id,
    lastWorkedAt: null,
    lastWorkedKw: null,
    lastWorkedVehicle: null,
    inUseSince: null,
    queueAt: null,
    problemAt: '2026-10-20T08:00:00Z',
    problemKind: 'broken',
    problemReports: 2,
    reports7d: 2,
  });
  const loose = { ...DEFAULT_OPTIONS, allowUnverified: true };

  it('never plans a charger reported broken, even with unverified stops allowed or as an extra option', () => {
    const stations = [dcStation('bad', 190, { confidence: 0.3 }), dcStation('c', 300)];
    const statuses = new Map([['bad', broken('bad')]]);
    const strict = plan(400, stations, statuses);
    expect(strict.stops.map((s) => s.station.id)).not.toContain('bad');
    expect(strict.extras.map((s) => s.station.id)).not.toContain('bad');
    const p = planTrip({ route: route(400), stations, statuses, vehicle: nexon, options: loose, now });
    expect(p.stops.map((s) => s.station.id)).not.toContain('bad');
    expect(p.feasible).toBe(false);
  });

  it('treats a customers-only charger as unverified: an extra option, with a note when allowed', () => {
    const stations = [dcStation('hotel', 190, { access: 'customers' }), dcStation('c', 300)];
    const strict = plan(400, stations);
    expect(strict.stops.map((s) => s.station.id)).not.toContain('hotel');
    expect(strict.extras.map((s) => s.station.id)).toContain('hotel');
    const p = planTrip({ route: route(400), stations, statuses: new Map(), vehicle: nexon, options: loose, now });
    const hotel = p.stops.find((s) => s.station.id === 'hotel')!;
    expect(hotel.trusted).toBe(false);
    expect(hotel.notes.join(' ')).toMatch(/Customers only/);
  });

  it('takes the drive back to the route out of the charge you leave a charger with', () => {
    // The same trip with the only charger beside the road and ~4 km off it; both stops charge to 100%.
    const near = plan(450, [dcStation('a', 190)]);
    const far = plan(450, [dcStation('a', 190, { lng: LNG + 0.028 })]);
    expect(near.stops[0].departSocPct).toBe(far.stops[0].departSocPct);
    const backPct = ((far.stops[0].detourKm - near.stops[0].detourKm) * baseWhPerKm(nexon)) / 1000 / nexon.batteryKwh * 100;
    expect(backPct).toBeGreaterThan(1);
    expect(near.arrivalSocPct - far.arrivalSocPct).toBeCloseTo(backPct, 0);
  });
});
