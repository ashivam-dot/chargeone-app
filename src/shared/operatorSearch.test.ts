import { describe, expect, it } from 'vitest';
import type { Station } from '../data/model.ts';
import { BRANDS, brandsFor, operatorBounds, operatorsNamed, searchChargers, words } from './operatorSearch.ts';

function station(id: string, name: string, operator: string | null, lat = 12.9, lng = 77.6): Station {
  return {
    id,
    name,
    operator,
    lat,
    lng,
    connectors: [],
    points: null,
    maxKw: null,
    speed: 'unknown',
    vehicles: [],
    batterySwap: false,
    hours: null,
    is24x7: null,
    price: null,
    access: 'public',
    address: null,
    website: null,
    sources: [],
  };
}

const OPERATORS = ['HPCL', 'BPCL', 'Jio-bp pulse', 'IndianOil', 'Statiq', 'Tata Power EZ Charge', 'Shell Recharge', 'Nayara', 'ChargeZone', 'chargeMOD', 'Shapoorji Pallonji', 'Electric Vehicle Charging Station', 'Volttic'];
const named = (q: string) => operatorsNamed(q, OPERATORS).sort();

describe('words', () => {
  it('splits on punctuation and drops case and accents', () => {
    expect(words('Jio-bp pulse')).toEqual(['jio', 'bp', 'pulse']);
    expect(words('Mahindra Charge_iN')).toEqual(['mahindra', 'charge', 'in']);
    expect(words('Électricité de France')).toEqual(['electricite', 'de', 'france']);
  });
});

describe('operator aliases', () => {
  it('maps forecourt brands to the operators in the data', () => {
    expect(named('HP')).toEqual(['HPCL']);
    expect(named('hpcl')).toEqual(['HPCL']);
    expect(named('Hindustan Petroleum')).toEqual(['HPCL']);
    expect(named('hindustan pet')).toEqual(['HPCL']);
    expect(named('BP')).toEqual(['BPCL', 'Jio-bp pulse']);
    expect(named('Bharat Petroleum')).toEqual(['BPCL']);
    expect(named('jio')).toEqual(['Jio-bp pulse']);
    expect(named('Jio BP')).toEqual(['Jio-bp pulse']);
    expect(named('IOCL')).toEqual(['IndianOil']);
    expect(named('indian oil')).toEqual(['IndianOil']);
    expect(named('statiq')).toEqual(['Statiq']);
    expect(named('stati')).toEqual(['Statiq']);
    expect(named('tata')).toEqual(['Tata Power EZ Charge']);
    expect(named('EZ')).toEqual(['Tata Power EZ Charge']);
    expect(named('SHELL')).toEqual(['Shell Recharge']);
    expect(named('charge zone')).toEqual(['ChargeZone']);
    expect(named('chargemod')).toEqual(['chargeMOD']);
    expect(named('volttic')).toEqual(['Volttic']);
  });

  it('matches whole words, not letters inside a word', () => {
    expect(named('hp')).not.toContain('Shapoorji Pallonji');
    expect(named('ha')).toEqual([]);
    // Two letters must be a whole alias; "in" is not the start of "indian oil".
    expect(named('in')).toEqual([]);
  });

  it("doesn't pick an operator for generic words", () => {
    expect(named('charging station')).toEqual([]);
    expect(named('ev')).toEqual([]);
    expect(named('charge')).toEqual([]);
  });

  it('every brand names at least one alias and operator', () => {
    for (const b of BRANDS) {
      expect(b.operators.length).toBeGreaterThan(0);
      expect(b.aliases.every((a) => a === a.toLowerCase())).toBe(true);
    }
    expect(brandsFor('bp').map((b) => b.operators[0])).toEqual(['BPCL', 'Jio-bp pulse']);
  });
});

describe('searchChargers', () => {
  const hpcl = station('h1', 'Highway Fuel Station', 'HPCL', 13.0, 77.6);
  const forecourt = station('h2', 'HPCL Shoolagiri', 'Relux Electric', 12.6, 77.9);
  const shapoorji = station('s1', 'Shapoorji Park', 'Shapoorji Pallonji', 12.91, 77.61);
  const statiqs = Array.from({ length: 6 }, (_, i) => station(`q${i}`, 'Statiq Charging Station', 'Statiq', 10 + i, 77));
  const jio = station('j1', 'Jio-BP pulse Kamadod', 'Jio-bp pulse');
  const bpcl = station('b1', 'Bharat Petroleum Outlet', 'BPCL');
  const all = [hpcl, forecourt, shapoorji, ...statiqs, jio, bpcl];

  it('finds an operator\'s chargers by alias, and brand names on other operators\' chargers', () => {
    const r = searchChargers(all, 'HP');
    expect(r.stations.map((s) => s.id).sort()).toEqual(['h1', 'h2']);
    expect(r.operators).toEqual([{ name: 'HPCL', count: 1 }]);
  });

  it('never matches inside a word', () => {
    expect(searchChargers(all, 'hp').stations.map((s) => s.id)).not.toContain('s1');
    expect(searchChargers(all, 'oorji').stations).toEqual([]);
  });

  it('offers every operator a brand covers, biggest first', () => {
    const r = searchChargers(all, 'bp');
    expect(r.operators.map((o) => o.name)).toEqual(['BPCL', 'Jio-bp pulse']);
    expect(r.stations.map((s) => s.id).sort()).toEqual(['b1', 'j1']);
    // "Bharat Petroleum" means BPCL only: a "Jio-BP" name is not a Bharat Petroleum pump.
    expect(searchChargers(all, 'Bharat Petroleum').stations.map((s) => s.id)).toEqual(['b1']);
  });

  it('counts all of an operator\'s chargers and returns the nearest few', () => {
    const r = searchChargers(all, 'Statiq', { near: { lat: 14.2, lng: 77 } });
    expect(r.operators).toEqual([{ name: 'Statiq', count: 6 }]);
    expect(r.stations.map((s) => s.id)).toEqual(['q4', 'q5', 'q3']);
  });

  it('still finds chargers by name, case-insensitive, while typing', () => {
    expect(searchChargers(all, 'highway fu').stations.map((s) => s.id)).toEqual(['h1']);
    expect(searchChargers(all, 'SHOOLAGIRI').stations.map((s) => s.id)).toEqual(['h2']);
    expect(searchChargers(all, 'x').stations).toEqual([]);
  });

  it('fits the map around an operator', () => {
    const b = operatorBounds(all, 'Statiq')!;
    expect(b[1]).toBeLessThan(10);
    expect(b[3]).toBeGreaterThan(15);
    expect(operatorBounds(all, 'Nobody')).toBeNull();
  });
});
