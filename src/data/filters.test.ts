import { describe, expect, it } from 'vitest';
import { EMPTY_FILTERS, activeFilterCount, filterStations, operatorsByCount } from './filters.ts';
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

it('lists operators by station count', () => {
  expect(operatorsByCount([dc, dc, ac])).toEqual([
    { name: 'Statiq', count: 2 },
    { name: 'Tata Power EZ Charge', count: 1 },
  ]);
});
