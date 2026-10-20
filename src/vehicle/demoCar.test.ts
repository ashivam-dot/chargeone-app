import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Coord } from '../planner/geometry.ts';
import { VEHICLES, myVehicleFromModel } from '../shared/vehicles.ts';
import { DemoCarSource, taperedChargeKw, type DemoCarOptions } from './demoCar.ts';
import { flatWhPerKm } from './energy.ts';
import type { Telemetry } from './types.ts';

const KM_PER_DEG_LAT = 111.2;
const nexon = myVehicleFromModel(VEHICLES.find((v) => v.id === 'tata-nexon-ev-45')!);

function route(km: number): Coord[] {
  const coords: Coord[] = [];
  for (let d = 0; d <= km; d += 5) coords.push([77, 20 + d / KM_PER_DEG_LAT]);
  return coords;
}

function car(over: Partial<DemoCarOptions> = {}): DemoCarSource {
  return new DemoCarSource({ vehicle: nexon, route: route(300), startSocPct: 80, startAtMs: 0, ...over });
}

function driveTo(c: DemoCarSource, km: number, step = 5): Telemetry {
  let t = c.reading();
  while (c.kmDone < km && !c.finished) t = c.step(step);
  return t;
}

afterEach(() => {
  vi.useRealTimers();
});

describe('DemoCarSource', () => {
  it('drives the route at plausible highway speeds', () => {
    const c = car();
    const speeds: number[] = [];
    for (let s = 0; s < 3600; s += 10) speeds.push(c.step(10).speedKmh!);
    const avg = c.kmDone;
    expect(avg).toBeGreaterThan(60);
    expect(avg).toBeLessThan(90);
    expect(Math.max(...speeds)).toBeLessThanOrEqual(100);
    expect(speeds.filter((v) => v >= 60).length / speeds.length).toBeGreaterThan(0.75);
    expect(speeds.some((v) => v < 50)).toBe(true);
  });

  it('reports a full, labelled reading on the route', () => {
    const t = driveTo(car(), 50);
    expect(t.source).toBe('demo');
    expect(t.socMeasured).toBe(true);
    expect(t.sohPct).toBe(96);
    expect(t.lng).toBeCloseTo(77, 6);
    expect(t.lat).toBeCloseTo(20 + 50 / KM_PER_DEG_LAT, 1);
    expect(t.headingDeg).toBe(0);
    expect(t.batteryTempC).toBeGreaterThanOrEqual(28);
    expect(t.batteryTempC).toBeLessThanOrEqual(38);
    expect(t.powerKw).toBeGreaterThan(0);
    expect(t.odometerKm).toBeCloseTo(12480 + 50, 0);
    expect(t.rangeKm).toBeGreaterThan(150);
    expect(t.at).toBeGreaterThan(30 * 60_000);
  });

  it('uses about the planned energy in the normal scenario', () => {
    const c = car();
    const t = driveTo(c, 100);
    const usedWhPerKm = (((80 - t.socPct!) / 100) * nexon.batteryKwh * 1000) / c.kmDone;
    expect(usedWhPerKm / flatWhPerKm(nexon)).toBeGreaterThan(0.9);
    expect(usedWhPerKm / flatWhPerKm(nexon)).toBeLessThan(1.1);
    expect(t.whPerKm! / flatWhPerKm(nexon)).toBeLessThan(1.15);
  });

  it('uses about 40% more after 12% of the route in the range_drop scenario', () => {
    const normal = driveTo(car(), 100);
    const drop = driveTo(car({ scenario: 'range_drop' }), 100);
    expect(drop.whPerKm! / normal.whPerKm!).toBeGreaterThan(1.3);
    expect(drop.whPerKm! / normal.whPerKm!).toBeLessThan(1.5);
    const early = driveTo(car({ scenario: 'range_drop' }), 30);
    expect(early.whPerKm! / flatWhPerKm(nexon)).toBeLessThan(1.15);
  });

  it('stops and charges with a taper at a charge stop, then drives on', () => {
    const c = car({ chargeStops: [{ alongKm: 150, toPct: 90, powerKw: 50 }] });
    let t = driveTo(c, 150);
    expect(c.kmDone).toBeCloseTo(150, 6);
    const arriveSoc = t.socPct!;
    t = c.step(5);
    expect(t.charging).toBe(true);
    expect(t.speedKmh).toBe(0);
    expect(t.powerKw).toBeLessThan(-40);
    const temps: number[] = [];
    while (c.reading().charging) temps.push(c.step(30).batteryTempC!);
    t = c.reading();
    expect(t.socPct).toBeGreaterThanOrEqual(90);
    expect(t.socPct).toBeGreaterThan(arriveSoc);
    expect(Math.max(...temps)).toBeLessThanOrEqual(38);
    expect(taperedChargeKw(85, 50)).toBeLessThan(taperedChargeKw(45, 50));
    t = c.step(60);
    expect(t.charging).toBe(false);
    expect(c.kmDone).toBeGreaterThan(150);
    driveTo(c, 400);
    expect(c.finished).toBe(true);
    expect(c.kmDone).toBeCloseTo(300, 0);
    expect(c.step(10).speedKmh).toBe(0);
  });

  it('is deterministic for a seed', () => {
    const a = driveTo(car({ seed: 7 }), 80);
    const b = driveTo(car({ seed: 7 }), 80);
    expect(a).toEqual(b);
  });

  it('runs on a timer between connect and disconnect', async () => {
    vi.useFakeTimers();
    const c = car({ speedup: 60, tickMs: 500 });
    const seen: Telemetry[] = [];
    c.subscribe((t) => seen.push(t));
    await c.connect();
    expect(seen).toHaveLength(1);
    vi.advanceTimersByTime(5000);
    expect(seen).toHaveLength(11);
    expect(seen.at(-1)!.at).toBe(300_000);
    await c.disconnect();
    vi.advanceTimersByTime(5000);
    expect(seen).toHaveLength(11);
  });

  it('takes a battery figure from the driver', () => {
    const c = car();
    c.setBatteryPct(55);
    expect(c.reading().socPct).toBe(55);
  });
});
