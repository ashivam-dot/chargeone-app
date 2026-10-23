import { describe, expect, it } from 'vitest';
import type { Station } from '../data/model.ts';
import type { DayPlan, Journey } from '../planner/journey.ts';
import type { Stop, TripPlan } from '../planner/planner.ts';
import { myVehicleFromModel, VEHICLES } from '../shared/vehicles.ts';
import { buildAgentContext, MAX_CONTEXT_BYTES, summarizePlan } from './agentContext.ts';

const station = (name: string, lat = 27.123456, lng = 76.654321): Station => ({
  id: name,
  name,
  operator: null,
  lat,
  lng,
  connectors: [],
  points: null,
  maxKw: 60,
  speed: 'dc',
  vehicles: ['car'],
  batterySwap: false,
  hours: null,
  is24x7: true,
  price: null,
  access: 'public',
  address: null,
  website: null,
  sources: [],
});

const stop = (name: string, alongKm: number): Stop => ({
  station: station(name),
  lat: 27.123456,
  lng: 76.654321,
  alongKm,
  detourKm: 0.4,
  arriveSocPct: 18.4,
  departSocPct: 80,
  chargeMinutes: 41.6,
  energyKwh: 30,
  costInr: 660,
  powerKw: 59.7,
  mode: 'dc',
  live: 'working',
  confidence: 'high',
  trusted: true,
  notes: [],
  backups: [],
});

const plan = (stops: Stop[], over: Partial<TripPlan> = {}): TripPlan => ({
  feasible: true,
  distanceKm: 281.4,
  driveMinutes: 300.2,
  chargeMinutes: stops.reduce((a, s) => a + s.chargeMinutes, 0),
  arrivalSocPct: 32.4,
  totalEnergyKwh: 30,
  totalCostInr: 660,
  stops,
  warnings: [],
  gapAtKm: null,
  extras: [],
  extrasFeasible: false,
  ...over,
});

const day = (startKm: number, endKm: number, p: TripPlan, overnightName: string | null): DayPlan => ({
  startKm,
  endKm,
  plan: p,
  startSocPct: 80,
  overnight: overnightName
    ? { station: station(overnightName), alongKm: endKm, mode: 'ac', powerKw: 7.4, hoursToFull: 6, morningSocPct: 95, trusted: true, speedUnknown: false, stays: [], food: [] }
    : null,
});

const journey = (days: DayPlan[]): Journey => ({
  days,
  feasible: true,
  distanceKm: days[days.length - 1].endKm,
  driveMinutes: 900,
  chargeMinutes: 120,
  costInr: 2000,
  arrivalSocPct: 40,
  stopCount: days.reduce((a, d) => a + d.plan.stops.length, 0),
  tooLong: false,
  warnings: [],
});

const nexon = myVehicleFromModel(VEHICLES.find((v) => v.id === 'tata-nexon-ev-45')!);
const size = (v: unknown) => new TextEncoder().encode(JSON.stringify(v)).length;

describe('buildAgentContext', () => {
  it('describes the car with its charge and the range that leaves', () => {
    expect(buildAgentContext({ vehicle: { vehicle: { ...nexon, realRangeKm: 300 }, socPct: 49.6 } }).vehicle).toEqual({
      name: 'Tata Nexon EV 45',
      batteryKwh: 45,
      rangeKm: 150,
      socPct: 50,
    });
    expect(buildAgentContext({ vehicle: { vehicle: nexon, socPct: 50, rangeKm: 141.7 } }).vehicle?.rangeKm).toBe(142);
    expect(buildAgentContext({ vehicle: { vehicle: nexon } }).vehicle).toMatchObject({ rangeKm: null, socPct: null });
  });

  it('takes the charge from the live drive when the car entry has none', () => {
    const ctx = buildAgentContext({ vehicle: { vehicle: nexon }, live: { socPct: 61.2, kmDone: 10, lat: 1, lng: 2 } });
    expect(ctx.vehicle?.socPct).toBe(61);
  });

  it('takes a one-day plan as the planner returns it', () => {
    const ctx = buildAgentContext({ trip: { from: 'Delhi', to: 'Jaipur', plan: plan([stop('Tata Power Behror', 131.46)]) } });
    expect(ctx.trip).toEqual({
      from: 'Delhi',
      to: 'Jaipur',
      distanceKm: 281,
      totalMinutes: 342,
      arrivalSocPct: 32,
      stops: [
        { name: 'Tata Power Behror', km: 131, arriveSocPct: 18, departSocPct: 80, chargeMinutes: 42, powerKw: 60, status: 'working', lat: 27.1235, lng: 76.6543 },
      ],
      nights: [],
    });
  });

  it('measures journey stops from the start of the trip and lists the nights', () => {
    const j = journey([day(0, 300, plan([stop('Day 1 stop', 150)]), 'Night A'), day(300, 600, plan([stop('Day 2 stop', 50)]), null)]);
    const trip = buildAgentContext({ trip: { from: 'Delhi', to: 'Udaipur', plan: j } }).trip!;
    expect(trip.stops.map((s) => [s.name, s.km])).toEqual([
      ['Day 1 stop', 150],
      ['Day 2 stop', 350],
    ]);
    expect(trip.nights).toEqual([{ name: 'Night A', km: 300, morningSocPct: 95 }]);
    expect(trip.totalMinutes).toBe(1020);
  });

  it('keeps at most 12 stops and 4 nights', () => {
    const days = Array.from({ length: 6 }, (_, d) =>
      day(d * 400, (d + 1) * 400, plan(Array.from({ length: 4 }, (_, i) => stop(`S${d}-${i}`, i * 90 + 10))), d < 5 ? `N${d}` : null),
    );
    const trip = buildAgentContext({ trip: { from: 'A', to: 'B', plan: journey(days) } }).trip!;
    expect(trip.stops).toHaveLength(12);
    expect(trip.stops[0].name).toBe('S0-0');
    expect(trip.nights).toHaveLength(4);
  });

  it('on the road, keeps the last stop passed and the ones ahead', () => {
    const stops = Array.from({ length: 20 }, (_, i) => stop(`S${i}`, i * 50 + 25));
    const ctx = buildAgentContext({ trip: { from: 'A', to: 'B', plan: plan(stops) }, live: { socPct: 50, kmDone: 300, lat: 1, lng: 2 } });
    expect(ctx.trip!.stops.map((s) => s.name)).toEqual(['S5', 'S6', 'S7', 'S8', 'S9', 'S10', 'S11', 'S12', 'S13', 'S14', 'S15', 'S16']);
  });

  it('rounds the live drive and drops numbers that are not numbers', () => {
    const ctx = buildAgentContext({
      live: { socPct: 44.6, speedKmh: Number.NaN, whPerKm: 152.4, kmDone: 123.456, projectedArrivalSocPct: 12.5, lat: 26.912345, lng: 75.787654 },
      position: { lat: 26.912345, lng: Number.POSITIVE_INFINITY },
    });
    expect(ctx).toEqual({
      live: { socPct: 45, speedKmh: null, whPerKm: 152, kmDone: 123.5, projectedArrivalSocPct: 13, lat: 26.9123, lng: 75.7877 },
    });
  });

  it('shortens very long names', () => {
    const ctx = buildAgentContext({ trip: { from: 'x'.repeat(500), to: 'Goa', plan: plan([stop('चार्जर'.repeat(100), 10)]) } });
    expect([...ctx.trip!.from]).toHaveLength(60);
    expect([...ctx.trip!.stops[0].name]).toHaveLength(60);
  });

  it('stays within 8 KB with the most it can carry', () => {
    const longName = 'बहुत लंबे नाम वाला चार्जिंग स्टेशन 🚗'.repeat(10);
    const days = Array.from({ length: 6 }, (_, d) =>
      day(d * 400, (d + 1) * 400, plan(Array.from({ length: 5 }, (_, i) => stop(longName, i * 70 + 5))), d < 5 ? longName : null),
    );
    const ctx = buildAgentContext({
      vehicle: { vehicle: { ...nexon, name: longName }, socPct: 80 },
      trip: { from: longName, to: longName, plan: journey(days) },
      live: { socPct: 50, speedKmh: 80, whPerKm: 150, kmDone: 10, projectedArrivalSocPct: 20, lat: 1, lng: 2 },
      position: { lat: 1, lng: 2 },
    });
    expect(size(ctx)).toBeLessThanOrEqual(MAX_CONTEXT_BYTES);
    expect(ctx.trip!.stops).toHaveLength(12);
  });

  it('trims stops, then nights, to fit a smaller limit and keeps the car', () => {
    const days = [day(0, 300, plan(Array.from({ length: 10 }, (_, i) => stop(`Charger number ${i}`, i * 25))), 'Night A'), day(300, 600, plan([]), null)];
    const input = { vehicle: { vehicle: nexon, socPct: 80 }, trip: { from: 'Delhi', to: 'Udaipur', plan: journey(days) } };
    const full = buildAgentContext(input);
    const trimmed = buildAgentContext(input, 1200);
    expect(size(full)).toBeGreaterThan(1200);
    expect(size(trimmed)).toBeLessThanOrEqual(1200);
    expect(trimmed.trip!.stops.length).toBeLessThan(10);
    expect(trimmed.trip!.stops.map((s) => s.name)).toEqual(full.trip!.stops.slice(0, trimmed.trip!.stops.length).map((s) => s.name));
    expect(trimmed.vehicle).toEqual(full.vehicle);
    expect(size(buildAgentContext(input, 150))).toBeLessThanOrEqual(150);
  });
});

describe('summarizePlan', () => {
  it('sums a journey across days', () => {
    const j = journey([day(0, 300, plan([stop('First', 150)]), 'Night A'), day(300, 600, plan([stop('Second', 50)]), null)]);
    expect(summarizePlan(j)).toEqual({ feasible: true, distanceKm: 600, totalMinutes: 1020, arrivalSocPct: 40, stopCount: 2, firstStopName: 'First', nights: 1 });
  });

  it('handles a plan with no stops', () => {
    expect(summarizePlan(plan([]))).toMatchObject({ stopCount: 0, firstStopName: null, nights: 0, totalMinutes: 300 });
  });
});
