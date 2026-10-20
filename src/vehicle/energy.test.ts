import { describe, expect, it } from 'vitest';
import { RouteIndex, type Coord } from '../planner/geometry.ts';
import { DEFAULT_OPTIONS, cumulativeEnergy } from '../planner/planner.ts';
import { VEHICLES, baseWhPerKm, myVehicleFromModel } from '../shared/vehicles.ts';
import {
  Ewma,
  climbWh,
  flatWhPerKm,
  rangeKm,
  routeWhPerKm,
  segmentWh,
  segmentWhPerKm,
  speedFactor,
  temperatureFactor,
} from './energy.ts';

const nexon = myVehicleFromModel(VEHICLES.find((v) => v.id === 'tata-nexon-ev-45')!);
const KM_PER_DEG_LAT = 111.2;

function hillyRoute(): Coord[] {
  const coords: Coord[] = [];
  for (let d = 0; d <= 100; d += 5) coords.push([77, 20 + d / KM_PER_DEG_LAT, 500 + 300 * Math.sin(d / 15)]);
  return coords;
}

describe('energy model', () => {
  it('is neutral at the reference speed and grows with speed', () => {
    expect(speedFactor(80)).toBeCloseTo(1, 10);
    expect(speedFactor(60)).toBeLessThan(0.9);
    expect(speedFactor(100)).toBeGreaterThan(1.15);
    expect(speedFactor(100)).toBeLessThan(1.3);
    expect(speedFactor(120)).toBeGreaterThan(speedFactor(100));
    expect(speedFactor(2)).toBe(speedFactor(20));
  });

  it('matches the planner on flat ground at 80 km/h', () => {
    const flat: Coord[] = [[77, 20], [77, 21]];
    expect(segmentWhPerKm(nexon, 10, { speedKmh: 80 })).toBeCloseTo(flatWhPerKm(nexon), 6);
    expect(flatWhPerKm(nexon)).toBeCloseTo(baseWhPerKm(nexon) * 1.015, 6);
    expect(routeWhPerKm(flat, nexon)).toBeCloseTo(flatWhPerKm(nexon), 6);
  });

  it('matches planner.cumulativeEnergy on a hilly route', () => {
    const coords = hillyRoute();
    const index = new RouteIndex(coords);
    const plannerKwh = cumulativeEnergy(index, coords, nexon, DEFAULT_OPTIONS).at(-1)!;
    let liveWh = 0;
    for (let i = 1; i < coords.length; i++) {
      liveWh += segmentWh(nexon, index.cumKm[i] - index.cumKm[i - 1], { speedKmh: 80, climbM: coords[i][2]! - coords[i - 1][2]! });
    }
    expect(liveWh / 1000).toBeCloseTo(plannerKwh, 6);
    expect(routeWhPerKm(coords, nexon)).toBeCloseTo((plannerKwh * 1000) / index.lengthKm, 6);
  });

  it('charges hills with drivetrain losses and gives back part of descents', () => {
    const mass = nexon.massKg + 75;
    expect(climbWh(mass, 100)).toBeCloseTo((mass * 9.81 * 100) / 3600 / 0.9, 6);
    expect(climbWh(mass, -100)).toBeCloseTo((-mass * 9.81 * 100) / 3600 * 0.6, 6);
    expect(segmentWh(nexon, 1, { speedKmh: 80, climbM: 50 })).toBeGreaterThan(segmentWh(nexon, 1, { speedKmh: 80 }));
    expect(segmentWh(nexon, 1, { speedKmh: 80, climbM: -200 })).toBe(0);
    expect(segmentWh(nexon, 0, { speedKmh: 80 })).toBe(0);
  });

  it('adds load in heat and cold only', () => {
    expect(temperatureFactor(null)).toBe(1);
    expect(temperatureFactor(25)).toBe(1);
    expect(temperatureFactor(42)).toBeCloseTo(1.06, 6);
    expect(temperatureFactor(5)).toBeCloseTo(1.12, 6);
  });

  it('computes range above a reserve', () => {
    expect(rangeKm(80, 45, 150)).toBeCloseTo(240, 6);
    expect(rangeKm(80, 45, 150, 10)).toBeCloseTo(210, 6);
    expect(rangeKm(5, 45, 150, 10)).toBe(0);
    expect(rangeKm(50, 45, 0)).toBe(0);
  });
});

describe('Ewma', () => {
  it('starts at the first sample and halves the weight of samples one half-life back', () => {
    const e = new Ewma(5);
    expect(e.value).toBeNull();
    e.push(100, 5);
    expect(e.value).toBe(100);
    e.push(200, 5);
    // Old: 100 × 5 km × 0.5, new: 200 × 5 km.
    expect(e.value).toBeCloseTo((100 * 2.5 + 200 * 5) / 7.5, 6);
    expect(e.observed).toBe(10);
  });

  it('ignores empty or invalid samples and can reset', () => {
    const e = new Ewma(5);
    e.push(150, 0);
    e.push(Number.NaN, 1);
    expect(e.value).toBeNull();
    for (let i = 0; i < 100; i++) e.push(150, 0.1);
    expect(e.value).toBeCloseTo(150, 6);
    e.reset();
    expect(e.value).toBeNull();
    expect(e.observed).toBe(0);
  });
});
