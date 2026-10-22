import { describe, expect, it } from 'vitest';
import { DEFAULT_FILTERS, EMPTY_FILTERS, activeFilterCount, filterStations, hiddenBySettings, operatorsByCount } from './filters.ts';
import type { Station } from './model.ts';

function station(over: Partial<Station>): Station {
  return {
    id: 'x',
    name: 'X',
    operator: null,
    lat: 0,
    lng: 0,
    connectors: [],
    points: null,
    maxKw: null,
    speed: 'unknown',
    vehicles: [],
    batterySwap: false,
    hours: null,
    is24x7: false,
    price: null,
    access: 'unknown',
    address: null,
    website: null,
    sources: [],
    ...over,
  };
}

const dc = station({ id: 'dc', operator: 'Statiq', speed: 'dc', maxKw: 60, connectors: [{ type: 'CCS2', count: 1, kw: 60 }], vehicles: ['car'], is24x7: true });
const ac = station({ id: 'ac', operator: 'Tata Power EZ Charge', speed: 'ac', maxKw: 7.4, connectors: [{ type: 'Type 2', count: 1, kw: 7.4 }], vehicles: ['car'] });
const twoWheeler = station({ id: '2w', operator: 'Ather Grid', vehicles: ['2w'] });
const unknown = station({ id: 'unknown' });
const all = [dc, ac, twoWheeler, unknown];

describe('filterStations', () => {
  it('returns everything without filters', () => {
    expect(filterStations(all, EMPTY_FILTERS)).toBe(all);
    expect(activeFilterCount(EMPTY_FILTERS)).toBe(0);
  });

  it('filters by speed, connector, hours, operator and power', () => {
    const ids = (f: Partial<typeof EMPTY_FILTERS>) => filterStations(all, { ...EMPTY_FILTERS, ...f }).map((s) => s.id);
    expect(ids({ dcOnly: true })).toEqual(['dc']);
    expect(ids({ connectors: ['Type 2'] })).toEqual(['ac']);
    expect(ids({ open24x7: true })).toEqual(['dc']);
    expect(ids({ operator: 'Statiq' })).toEqual(['dc']);
    expect(ids({ minKw: 25 })).toEqual(['dc']);
  });

  it('keeps stations with unknown vehicle types when filtering by vehicle', () => {
    const ids = filterStations(all, { ...EMPTY_FILTERS, vehicle: 'car' }).map((s) => s.id);
    expect(ids).toEqual(['dc', 'ac', 'unknown']);
  });
});

describe('car-first defaults', () => {
  const ather = station({ id: 'ather', operator: 'Ather Grid', vehicleClass: '2w', vehicles: ['2w'], connectors: [{ type: 'LECCS', count: 1, kw: 3 }] });
  const hotel = station({ id: 'hotel', speed: 'ac', access: 'customers', vehicleClass: 'car', vehicles: ['car'] });
  const mixed = station({ id: 'mixed', vehicleClass: 'mixed', vehicles: ['car', '2w'] });
  const bharatAc = station({ id: 'bac', vehicleClass: 'car', vehicles: ['car'], connectors: [{ type: 'Bharat AC', count: 3, kw: 3.3 }] });
  const dcCar = { ...dc, vehicleClass: 'car' as const };
  const list = [dcCar, ather, hotel, mixed, bharatAc, unknown];
  const ids = (f: typeof EMPTY_FILTERS) => filterStations(list, f).map((s) => s.id);

  it('hides 2-wheeler-only and customers-only chargers for a car', () => {
    expect(ids(DEFAULT_FILTERS)).toEqual(['dc', 'mixed', 'bac', 'unknown']);
    expect(hiddenBySettings(list, DEFAULT_FILTERS)).toBe(2);
    expect(ids({ ...DEFAULT_FILTERS, showRestricted: true })).toContain('hotel');
  });

  it('2-wheeler mode keeps scooter points and car chargers with sockets a scooter can use', () => {
    expect(ids({ ...DEFAULT_FILTERS, mode: '2w' })).toEqual(['ather', 'mixed', 'bac', 'unknown']);
  });

  it('falls back to the vehicles list on older data without a vehicle class', () => {
    expect(filterStations([twoWheeler, unknown], DEFAULT_FILTERS).map((s) => s.id)).toEqual(['unknown']);
  });

  it('filters by every Indian plug type', () => {
    expect(ids({ ...EMPTY_FILTERS, connectors: ['LECCS'] })).toEqual(['ather']);
    expect(ids({ ...EMPTY_FILTERS, connectors: ['Bharat AC'] })).toEqual(['bac']);
    expect(activeFilterCount(DEFAULT_FILTERS)).toBe(0);
  });
});

it('lists operators by station count', () => {
  expect(operatorsByCount([dc, dc, ac])).toEqual([
    { name: 'Statiq', count: 2 },
    { name: 'Tata Power EZ Charge', count: 1 },
  ]);
});
