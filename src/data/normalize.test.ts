import { describe, expect, it } from 'vitest';
import {
  dedupeStations,
  normaliseOperator,
  ocmToStation,
  osmConnectors,
  osmToStation,
  parsePowerKw,
} from './normalize.ts';

describe('parsePowerKw', () => {
  it.each([
    ['60 kW', 60],
    ['7.4kW', 7.4],
    ['3300 W', 3.3],
    ['22', 22],
    ['7 kW;22 kW', 22],
    ['50kw', 50],
    ['fast', null],
    ['', null],
    [undefined, null],
  ])('%s -> %s', (raw, expected) => {
    expect(parsePowerKw(raw)).toBe(expected);
  });
});

describe('normaliseOperator', () => {
  it('maps spelling variants to one name', () => {
    expect(normaliseOperator('Tata power')).toBe('Tata Power EZ Charge');
    expect(normaliseOperator('tata power')).toBe('Tata Power EZ Charge');
    expect(normaliseOperator('Zeon Network')).toBe('Zeon Charging');
    expect(normaliseOperator('Kerala State Electricity Board')).toBe('KSEB');
    expect(normaliseOperator('Charge Zone')).toBe('ChargeZone');
  });
  it('keeps unknown operators and drops blanks', () => {
    expect(normaliseOperator('  Local  Mall ')).toBe('Local Mall');
    expect(normaliseOperator('  ')).toBeNull();
    expect(normaliseOperator(undefined)).toBeNull();
  });
});

describe('osmConnectors', () => {
  it('reads count and output tags', () => {
    expect(osmConnectors({ 'socket:type2_combo': '2', 'socket:type2_combo:output': '60 kW' })).toEqual([
      { type: 'CCS2', count: 2, kw: 60 },
    ]);
  });
  it('accepts output-only tags and power written in the count field', () => {
    const c = osmConnectors({ 'socket:type7:output': '3.3 kW', 'socket:ccs': '24kw' });
    expect(c).toContainEqual({ type: 'CCS2', count: null, kw: 24 });
    expect(c).toContainEqual({ type: 'Other', count: null, kw: 3.3 });
  });
  it('ignores sockets tagged no and the malformed socket:type key', () => {
    expect(osmConnectors({ 'socket:chademo': 'no', 'socket:type:output': '3.3' })).toEqual([]);
  });
});

describe('osmToStation', () => {
  const base = { type: 'node' as const, id: 42, lat: 28.6, lon: 77.2 };

  it('builds a DC station with links and 24x7 hours', () => {
    const s = osmToStation({
      ...base,
      timestamp: '2025-03-01T10:00:00Z',
      tags: {
        amenity: 'charging_station',
        operator: 'Statiq',
        'socket:type2_combo': '1',
        'socket:type2_combo:output': '60 kW',
        opening_hours: '24/7',
        capacity: '2',
        website: 'statiq.in',
      },
    });
    expect(s).toMatchObject({
      id: 'osm-n42',
      name: 'Statiq charging station',
      operator: 'Statiq',
      speed: 'dc',
      maxKw: 60,
      points: 2,
      is24x7: true,
      website: 'https://statiq.in/',
      vehicles: ['car'],
    });
    expect(s?.sources[0].editUrl).toBe('https://www.openstreetmap.org/edit?node=42');
  });

  it('drops private chargers and elements without coordinates', () => {
    expect(osmToStation({ ...base, tags: { access: 'private' } })).toBeNull();
    expect(osmToStation({ type: 'way', id: 1, tags: {} })).toBeNull();
  });

  it('uses the centre of ways and marks 2-wheeler networks', () => {
    const s = osmToStation({ type: 'way', id: 7, center: { lat: 12.9, lon: 77.6 }, tags: { operator: 'Ather Energy' } });
    expect(s).toMatchObject({ id: 'osm-w7', lat: 12.9, lng: 77.6, operator: 'Ather Grid', vehicles: ['2w'], speed: 'unknown' });
  });

  it('rejects unsafe website schemes', () => {
    const s = osmToStation({ ...base, tags: { website: 'javascript:alert(1)' } });
    expect(s?.website).toBeNull();
  });
});

describe('ocmToStation', () => {
  it('maps connectors by title and skips private sites', () => {
    const s = ocmToStation({
      ID: 9,
      NumberOfPoints: 2,
      OperatorInfo: { Title: 'Tata Power' },
      UsageType: { Title: 'Public' },
      AddressInfo: { Title: 'Highway Plaza', Latitude: 26.9, Longitude: 75.8, Town: 'Jaipur' },
      Connections: [
        { ConnectionType: { Title: 'CCS (Type 2)' }, CurrentType: { Title: 'DC' }, PowerKW: 60, Quantity: 2 },
        { ConnectionType: { Title: 'Type 2 (Socket Only)' }, CurrentType: { Title: 'AC (Three-Phase)' }, PowerKW: 22 },
      ],
    });
    expect(s).toMatchObject({ id: 'ocm-9', operator: 'Tata Power EZ Charge', speed: 'dc', maxKw: 60, points: 2, access: 'public' });
    expect(s?.connectors.map((c) => c.type)).toEqual(['CCS2', 'Type 2']);
    expect(ocmToStation({ ID: 1, UsageType: { IsPrivateIndividuals: true }, AddressInfo: { Latitude: 1, Longitude: 1 } })).toBeNull();
  });
});

describe('dedupeStations', () => {
  const mk = (id: string, lat: number, lng: number, operator: string | null, connectors = 0) =>
    osmToStation({
      type: 'node',
      id: Number(id),
      lat,
      lon: lng,
      tags: {
        ...(operator ? { operator } : {}),
        ...(connectors ? { 'socket:type2_combo': String(connectors), 'socket:type2_combo:output': '50 kW' } : {}),
      },
    })!;

  it('merges nearby records of the same station and keeps both sources', () => {
    const out = dedupeStations([mk('1', 28.6, 77.2, 'Statiq', 1), mk('2', 28.6002, 77.2002, null)]);
    expect(out).toHaveLength(1);
    expect(out[0].sources.map((s) => s.id).sort()).toEqual(['node/1', 'node/2']);
  });

  it('keeps different operators at the same site apart', () => {
    expect(dedupeStations([mk('1', 28.6, 77.2, 'Statiq'), mk('2', 28.6001, 77.2001, 'ChargeZone')])).toHaveLength(2);
  });

  it('keeps stations further than 60 m apart', () => {
    expect(dedupeStations([mk('1', 28.6, 77.2, 'Statiq'), mk('2', 28.601, 77.2, 'Statiq')])).toHaveLength(2);
  });
});
