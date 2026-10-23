// The Telangana TGREDCO list (GODL-India): coordinate repair, drop rules, per-charge-point merging, no
// person names, location-only confidence, de-duplication against OSM/OCM, and the licence gate.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { PLAN_MIN_CONFIDENCE } from '../../src/data/trust.ts';
import { parseCoordinate, parseCsv, telanganaPoint, tgredcoHealth, tgredcoToCanonical } from '../adapters/tgredco.ts';
import { existenceConfidence, LISTED_MAX } from '../confidence.ts';
import { runGates } from '../gates.ts';
import { emptyRegistry } from '../ids.ts';
import { LICENCES } from '../licences.ts';
import { buildOutputs } from '../outputs.ts';
import { validateStations } from '../schema.ts';
import { buildStations } from '../stations.ts';
import type { SourceRecord } from '../types.ts';
import { ccs2, metresNorth, record } from './helpers.ts';

const csv = readFileSync(new URL('./fixtures/tgredco-sample.csv', import.meta.url), 'utf8');
const result = tgredcoToCanonical({ file: 'tgredco-sample.csv', csv });
const byId = (id: string) => result.records.find((r) => r.sourceId === id);
const reason = (id: string) => result.rejected.find((r) => r.sourceId === id)?.reason;
const now = new Date('2026-10-23T00:00:00Z');

describe('TGREDCO coordinates', () => {
  it.each([
    ['17.4500000,', 17.45],
    ['78. 4500000', 78.45],
    ["17.4346097'", 17.4346097],
    ['17.30509N', 17.30509],
    ["17°20'43.5", 17 + 20 / 60 + 43.5 / 3600],
    ['17°19\'4.23"N', 17 + 19 / 60 + 4.23 / 3600],
    ["17°28.673'N", 17 + 28.673 / 60],
    ['78°27.591"E', 78 + 27.591 / 60],
    ['17.2417.0N', 17 + 24 / 60 + 17 / 3600],
    ['78.2000.1 E', 78 + 20 / 60 + 0.1 / 3600],
  ])('reads %s', (raw, want) => {
    expect(parseCoordinate(raw)).toBeCloseTo(want, 6);
  });

  it('refuses what it cannot read', () => {
    for (const raw of ['NA', '', '-', "17°75'00\"", 'abc', '17.4.5.6']) expect(parseCoordinate(raw), raw).toBeNull();
  });

  it('puts a swapped pair back and refuses points outside Telangana', () => {
    expect(telanganaPoint('79.5', '18.0')).toEqual({ lat: 18, lng: 79.5 });
    expect(telanganaPoint('18.53', '75.78')).toBe('outside');
    expect(telanganaPoint('NA', '78.4')).toBeNull();
  });

  it('parses quoted CSV fields with commas, newlines and doubled quotes', () => {
    expect(parseCsv('a,"b, c","d\ne","f ""g"""\n1,2,3,4\n')).toEqual([
      ['a', 'b, c', 'd\ne', 'f "g"'],
      ['1', '2', '3', '4'],
    ]);
  });
});

describe('TGREDCO adapter', () => {
  it('keeps public car-capable rows and says why the others went', () => {
    expect(result.rawCount).toBe(21);
    expect(reason('tg-8')).toBe('no-coordinates');
    expect(reason('tg-9')).toBe('outside-state');
    expect(reason('tg-10')).toBe('not-car');
    expect(reason('tg-11')).toBe('battery-swap');
    expect(reason('tg-12')).toBe('bus');
    expect(reason('tg-13')).toBe('metro');
    expect(reason('tg-14')).toBe('private-individual');
    expect(reason('tg-19')).toBe('not-car');
    expect(byId('tg-6')).toMatchObject({ lat: 18, lng: 79.5 });
    expect(byId('tg-7')!.lat).toBeCloseTo(17.404722, 5);
    expect(byId('tg-4')!.lat).toBeCloseTo(17.41, 5);
    expect(byId('tg-5')!.lat).toBeCloseTo(17.345417, 5);
  });

  it('merges one operator’s rows within 100 m into one station (one row per charge point)', () => {
    expect(reason('tg-3')).toBe('duplicate-listing');
    expect(byId('tg-2')!.flags).toContain('listed-2-times');
  });

  it('publishes no owner and no person’s name', () => {
    const published = JSON.stringify(result.records);
    expect(published).not.toMatch(/Test Person|Domestic|Company Limited|pvt Ltd/i);
    expect(byId('tg-15')!.name).toBeNull();
    expect(byId('tg-17')!.name).toBe('Begumpet');
    expect(byId('tg-18')!.name).toBe('Anutex Sample Mall, Dr. AS Rao Nagar');
  });

  it('hides a fuel outlet named after its dealer, in the name and the address, but keeps places named after people', () => {
    expect(byId('tg-20')!.name).toBeNull();
    expect(byId('tg-20')!.address).toBe('National Highway 1, Sample Village');
    expect(byId('tg-21')!.name).toBeNull();
    expect(byId('tg-21')!.address).toBeNull();
    expect(byId('tg-21')!.operator).toBe('BPCL');
    expect(JSON.stringify(result.records)).not.toMatch(/Sample Rao|Laxmikanthamma/);
    expect(byId('tg-18')!.address).toBe('Dr. AS Rao Nagar Rd');
  });

  it('claims nothing it cannot know: no plugs, unknown status, unverified, GODL-India', () => {
    for (const r of result.records) {
      expect(r).toMatchObject({ source: 'tgredco', licence: 'GODL-India', verified: false, status: 'unknown', evses: [], access: 'unknown' });
      expect(r.flags).toEqual(expect.arrayContaining(['govt-listed', 'location-only']));
    }
    expect(byId('tg-1')!.operator).toBe('Tata Power EZ Charge');
    expect(byId('tg-4')!.operator).toBe('TGREDCO');
    expect(byId('tg-16')).toMatchObject({ stationKw: 120 });
    expect(byId('tg-16')!.vehicles.car).toBe(true);
    expect(byId('tg-1')!.vehicles).toEqual({ car: null, twoWheeler: null, threeWheeler: null, bus: null });
  });

  it('fails health on a truncated file', () => {
    expect(tgredcoHealth(result).ok).toBe(false);
    expect(tgredcoHealth({ ...result, rawCount: 551 }).problems.join()).toMatch(/usable/);
  });

  it('carries the GODL-India attribution with provider, portal, licence, link and no endorsement', () => {
    const a = LICENCES['GODL-India'].attribution;
    for (const part of ['TGREDCO', 'Telangana Open Data Portal', 'Government Open Data License - India', 'https://data.telangana.gov.in/dataset/', 'Not endorsed']) expect(a).toContain(part);
    expect(LICENCES['GODL-India'].obligations).toMatch(/never uploaded to OpenStreetMap/);
  });
});

describe('location-only listings in the station layer', () => {
  const listed = (over: Partial<SourceRecord> = {}): SourceRecord => ({ ...byId('tg-1')!, ...over });

  it('stays under the planner line however fresh', () => {
    expect(existenceConfidence([listed({ observedAt: now.toISOString(), snapshotAt: now.toISOString() })], now)).toBeLessThanOrEqual(LISTED_MAX);
    expect(LISTED_MAX).toBeLessThan(PLAN_MIN_CONFIDENCE);
  });

  it('adds nothing to a station OSM describes', () => {
    const osm = record({ sourceId: 'osm-n1', lat: 17.4, lng: 78.4, operator: 'Tata Power EZ Charge', operatorMethod: 'mapped', connectors: [ccs2(60)] });
    expect(existenceConfidence([osm, listed()], now)).toBe(existenceConfidence([osm], now));
  });

  it('drops a listing of a charger OSM already maps nearby, but keeps another operator’s', () => {
    const osm = record({ sourceId: 'osm-n1', lat: 17.4, lng: 78.4, name: 'Somewhere else', connectors: [ccs2(60)] });
    const near = listed({ sourceId: 'tg-1', lat: 17.4 + metresNorth(80), operator: null, operatorMethod: null });
    const other = listed({ sourceId: 'tg-2', lat: 17.4 + metresNorth(70), lng: 78.4, operator: 'BPCL' });
    const osmTata = record({ sourceId: 'osm-n2', lat: 17.4, lng: 78.4, operator: 'Tata Power EZ Charge', operatorMethod: 'mapped', connectors: [ccs2(60)] });
    const layer = buildStations([osm, near], { registry: emptyRegistry(), now });
    expect(layer.stations.map((s) => s.legacyId)).toEqual(['osm-n1']);
    expect(layer.listedDuplicates).toBe(1);
    const kept = buildStations([osmTata, other], { registry: emptyRegistry(), now });
    expect(kept.stations).toHaveLength(2);
  });

  it('gives a listing-only station its c1 id as the app id and passes the schema and gates', () => {
    const layer = buildStations(result.records, { registry: emptyRegistry(), now });
    for (const s of layer.stations) {
      expect(s.legacyId).toBe(s.id);
      expect(s.confidence).toBeLessThan(PLAN_MIN_CONFIDENCE);
      expect(s.flags).toContain('location-only');
    }
    const built = buildOutputs({
      stations: layer.stations,
      sites: layer.sites,
      review: layer.review,
      sources: [],
      merged: layer.merged,
      blocked: layer.blocked,
      generatedAt: now.toISOString(),
    });
    expect(validateStations(built.dataset.stations)).toEqual([]);
    const gates = runGates({
      baseline: null,
      health: {},
      sourceRecords: {},
      stations: [],
      schemaErrors: [],
      shardBytes: new Map(),
      canonical: layer.stations,
      adapters: [{ key: 'tgredco', licence: 'GODL-India' }],
    });
    expect(gates.failures).toEqual([]);
    expect(gates.checks.join()).toMatch(/location-only: \d+ stations, all under the planner line/);
    const odbl = built.files.get('LICENSE-data.txt')!.toString();
    expect(odbl).toMatch(/TGREDCO/);
    expect(odbl).toMatch(/must not be uploaded to\s+OpenStreetMap/);
  });

  it('fails the gate if a location-only station ever reached the planner line', () => {
    const layer = buildStations([byId('tg-1')!], { registry: emptyRegistry(), now });
    layer.stations[0].confidence = 0.7;
    const gates = runGates({ baseline: null, health: {}, sourceRecords: {}, stations: [], schemaErrors: [], shardBytes: new Map(), canonical: layer.stations, adapters: [] });
    expect(gates.failures.join()).toMatch(/location-only stations reach the planner line/);
  });

  it('fails the licence gate when a TGREDCO record claims another licence', () => {
    const layer = buildStations([byId('tg-1')!], { registry: emptyRegistry(), now });
    (layer.stations[0].members[0] as { licence: string }).licence = 'CC-BY-4.0';
    const gates = runGates({ baseline: null, health: {}, sourceRecords: {}, stations: [], schemaErrors: [], shardBytes: new Map(), canonical: layer.stations, adapters: [] });
    expect(gates.failures.join()).toMatch(/does not fit source tgredco/);
  });
});
