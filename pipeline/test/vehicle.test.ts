import { describe, expect, it } from 'vitest';
import { inferSwap, inferVehicles, NO_VEHICLE_FLAGS, vehicleClass, vehicleConflict } from '../lib/vehicle.ts';
import { speedOf } from '../lib/connectors.ts';
import { osmSocketType } from '../../src/data/normalize.ts';
import { ccs2, leccs, threePin, type2 } from './helpers.ts';

const infer = (over: Partial<Parameters<typeof inferVehicles>[0]>) =>
  inferVehicles({ explicit: NO_VEHICLE_FLAGS, connectors: [], operator: null, name: null, stationKw: null, ...over });

describe('vehicle-class inference', () => {
  it('socket:type7 is LECCS, not Other', () => {
    expect(osmSocketType('type7')).toBe('LECCS');
  });

  it('LECCS without a car connector is two-wheeler only', () => {
    const f = infer({ connectors: [leccs()] });
    expect(f).toMatchObject({ twoWheeler: true, car: false });
    expect(vehicleClass(f)).toBe('2w');
  });

  it('3.3 kW or less with no car connector is two-wheeler', () => {
    expect(vehicleClass(infer({ connectors: [{ standard: 'Other', powerType: null, maxKw: 3.3, count: 1 }] }))).toBe('2w');
    expect(vehicleClass(infer({ stationKw: 2.5 }))).toBe('2w');
  });

  it('a 15 A 3-pin socket serves two-wheelers but does not rule out a car', () => {
    const f = infer({ connectors: [threePin()] });
    expect(f.twoWheeler).toBe(true);
    expect(f.car).toBeNull();
  });

  it('Ather Grid is a two-wheeler network whatever the hardware', () => {
    expect(infer({ operator: 'Ather Grid' })).toMatchObject({ twoWheeler: true, car: false });
  });

  it('car connectors make a car charger; both kinds make it mixed', () => {
    expect(vehicleClass(infer({ connectors: [ccs2()] }))).toBe('car');
    expect(vehicleClass(infer({ connectors: [type2(), leccs()] }))).toBe('mixed');
  });

  it('no evidence stays unknown, never car', () => {
    const f = infer({ name: 'EV charging station' });
    expect(f).toEqual(NO_VEHICLE_FLAGS);
    expect(vehicleClass(f)).toBe('unknown');
  });

  it('explicit source statements win', () => {
    expect(infer({ explicit: { ...NO_VEHICLE_FLAGS, car: true }, connectors: [leccs()] }).car).toBe(true);
  });

  it('a scooter point conflicts with a car charger, unknown conflicts with nothing', () => {
    expect(vehicleConflict('2w', 'car')).toBe(true);
    expect(vehicleConflict('mixed', 'car')).toBe(false);
    expect(vehicleConflict('unknown', '2w')).toBe(false);
  });

  it('battery swapping is inferred from the network or name, else unknown', () => {
    expect(inferSwap('Honda e:Swap', null)).toBe(true);
    expect(inferSwap(null, 'Battery Smart swap station')).toBe(true);
    expect(inferSwap('Statiq', 'Statiq Charging Station')).toBeNull();
  });
});

describe('speed', () => {
  it('is unknown without kW or connector evidence', () => {
    expect(speedOf([], null)).toBe('unknown');
    expect(speedOf([{ standard: 'Other', powerType: null, maxKw: null, count: null }], null)).toBe('unknown');
  });
  it('DC from a DC connector or more than 22 kW; AC from an AC connector or kW', () => {
    expect(speedOf([ccs2(null)], null)).toBe('dc');
    expect(speedOf([], 30)).toBe('dc');
    expect(speedOf([type2(null)], null)).toBe('ac');
    expect(speedOf([], 7)).toBe('ac');
  });
});
