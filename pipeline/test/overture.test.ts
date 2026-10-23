// Overture Maps Places: car-capable networks only, per-record licence and origin, location-only
// confidence, de-duplication against OSM / OCM / TGREDCO, and the attribution that must travel with it.
import { describe, expect, it } from 'vitest';
import { PLAN_MIN_CONFIDENCE } from '../../src/data/trust.ts';
import { overtureHealth, overtureOperator, overtureToCanonical, type OverturePlace, type OvertureSource } from '../adapters/overture.ts';
import { tgredcoToCanonical } from '../adapters/tgredco.ts';
import { existenceConfidence } from '../confidence.ts';
import { runGates } from '../gates.ts';
import { emptyRegistry } from '../ids.ts';
import { CDLA_PERMISSIVE_2_TEXT, FOURSQUARE_NOTICE, LICENCES, OVERTURE_CDLA_CONTRIBUTORS } from '../licences.ts';
import { buildOutputs } from '../outputs.ts';
import { validateStations } from '../schema.ts';
import { buildStations } from '../stations.ts';
import { ccs2, metresNorth, record } from './helpers.ts';

const now = new Date('2026-10-23T00:00:00Z');
const src = (dataset: string, license: string, update = '2025-09-26T09:41:00Z'): OvertureSource => ({ property: '', dataset, license, record_id: '1', update_time: update });
const conf: OvertureSource = { property: '/properties/confidence', dataset: 'Overture', license: 'CDLA-Permissive-2.0', record_id: null, update_time: '2026-10-15T18:00:21Z' };
let n = 0;
const place = (over: Partial<OverturePlace> = {}): OverturePlace => ({
  id: `00000000-0000-0000-0000-${String(++n).padStart(12, '0')}`,
  name: 'ChargeZone EV Charging Station',
  category: 'ev_charging_station',
  basic_category: 'ev_charging_station',
  confidence: 0.85,
  operating_status: null,
  brand: null,
  websites: ['http://www.chargezone.co.in/'],
  address: 'Sector 18',
  locality: 'Gurugram',
  region: 'Haryana',
  postcode: '122001',
  country: 'IN',
  sources: [src('Microsoft', 'CDLA-Permissive-2.0'), conf],
  lat: 28.4,
  lng: 77.0,
  ...over,
});

const places = {
  chargezone: place(),
  bolt: place({ name: 'Bolt.Earth EV Charging Station', websites: ['https://bolt.earth/'], lat: 19.0 }),
  ather: place({ name: 'Ather Service Centre, Indore', websites: [], lat: 22.7, lng: 75.8 }),
  hotel: place({ name: 'OYO 10121 Hotel Twilight Bay', websites: ['https://www.oyorooms.com/h/16637'], lat: 12.9, lng: 80.2 }),
  foursquare: place({ name: 'Statiq Fast Charging Station', websites: ['http://www.statiq.in/'], sources: [src('Foursquare', 'Apache-2.0'), conf], lat: 26.9, lng: 75.8 }),
  foursquareTwin: place({ name: 'Statiq Charging Station', websites: ['https://www.statiq.in/'], sources: [src('Microsoft', 'CDLA-Permissive-2.0'), conf], lat: 26.9 + metresNorth(50), lng: 75.8 }),
  tesla: place({ name: 'Tesla Supercharger', websites: ['https://www.tesla.com/findus/location/supercharger/1'], sources: [src('AllThePlaces', 'CC0-1.0'), conf], lat: 19.06, lng: 72.86, region: 'MH' }),
  unknownDataset: place({ name: 'Statiq Charging Station', websites: ['http://www.statiq.in/'], sources: [src('SomeVendor', 'CDLA-Permissive-2.0')], lat: 13.0, lng: 77.6 }),
  wrongLicence: place({ name: 'Statiq Charging Station', websites: ['http://www.statiq.in/'], sources: [src('Microsoft', 'CC-BY-NC-4.0')], lat: 13.1, lng: 77.6 }),
  closed: place({ name: 'Shell Recharge Charging Station', websites: ['https://find.shell.com/in/fuel/1'], operating_status: 'permanently_closed', lat: 12.95, lng: 77.6 }),
  abroad: place({ country: 'NP', lat: 27.7, lng: 85.3 }),
  acOnly: place({ name: 'Jio-bp pulse 7.4 kW AC', websites: [], lat: 18.5, lng: 73.8 }),
  jio: place({
    name: 'Jio-bp pulse',
    websites: ['https://mobilitystation.jiobp.com/jio-bp-pulse-kukatpally-hyderabad-251893/Home?utm_source=locator&utm_medium=bing'],
    lat: 17.49,
    lng: 78.4,
    region: 'Telangana',
  }),
};
const result = overtureToCanonical({ file: 'fixture.json', release: '2026-10-21.0', places: Object.values(places) });
const rec = (p: OverturePlace) => result.records.find((r) => r.sourceId === `ovt-${p.id}`);
const reason = (p: OverturePlace) => result.rejected.find((r) => r.sourceId === `ovt-${p.id}`)?.reason;

describe('Overture adapter', () => {
  it('keeps only known car networks and says why the others went', () => {
    expect(reason(places.bolt)).toBe('ac-only');
    expect(reason(places.acOnly)).toBe('ac-only');
    expect(reason(places.ather)).toBe('not-car');
    expect(reason(places.hotel)).toBe('car-unknown');
    expect(reason(places.closed)).toBe('removed');
    expect(reason(places.abroad)).toBe('outside-india');
    expect(reason(places.foursquareTwin)).toBe('duplicate-listing');
    expect(rec(places.foursquare)!.flags).toContain('listed-2-times');
    expect(result.records.map((r) => r.operator).sort()).toEqual(['ChargeZone', 'Jio-bp pulse', 'Statiq', 'Tesla']);
  });

  it('refuses a record with a dataset or licence outside the Places list', () => {
    expect(reason(places.unknownDataset)).toBe('other-licence');
    expect(reason(places.wrongLicence)).toBe('other-licence');
  });

  it('keeps each record’s own licence and upstream dataset', () => {
    expect(rec(places.chargezone)).toMatchObject({ licence: 'CDLA-Permissive-2.0', origin: 'Microsoft' });
    expect(rec(places.foursquare)).toMatchObject({ licence: 'Apache-2.0', origin: 'Foursquare' });
    expect(rec(places.tesla)).toMatchObject({ licence: 'CC0-1.0', origin: 'AllThePlaces', stateHint: 'Maharashtra' });
  });

  it('claims nothing it cannot know and strips tracking from links', () => {
    for (const r of result.records) {
      expect(r).toMatchObject({ source: 'overture', verified: false, status: 'unknown', evses: [], stationKw: null, access: 'unknown' });
      expect(r.flags).toEqual(expect.arrayContaining(['places-listed', 'location-only']));
      expect(r.observedAt! <= '2026-10-21T00:00:00.000Z').toBe(true);
    }
    expect(rec(places.jio)!.website).toBe('https://mobilitystation.jiobp.com/jio-bp-pulse-kukatpally-hyderabad-251893/Home');
  });

  it('takes the network from the website before the name', () => {
    expect(overtureOperator({ name: 'ChargeZone x TATA.ev Charging Station', brand: null, websites: ['http://www.chargezone.co.in/'] })).toBe('ChargeZone');
    expect(overtureOperator({ name: 'Charging Station', brand: null, websites: ['https://mobilitystation.jiobp.com/x'] })).toBe('Jio-bp pulse');
  });

  it('fails health on a short extract', () => {
    expect(overtureHealth(result).ok).toBe(false);
  });
});

describe('Overture listings in the station layer', () => {
  it('stay under the planner line and add nothing to an OSM station', () => {
    const listing = rec(places.chargezone)!;
    expect(existenceConfidence([listing], now)).toBeLessThan(PLAN_MIN_CONFIDENCE);
    const osm = record({ sourceId: 'osm-n1', lat: listing.lat, lng: listing.lng, operator: 'ChargeZone', operatorMethod: 'mapped', connectors: [ccs2(60)] });
    expect(existenceConfidence([osm, listing], now)).toBe(existenceConfidence([osm], now));
  });

  it('are dropped near an OSM, OCM or TGREDCO record of a compatible operator, kept near another network', () => {
    const listing = { ...rec(places.chargezone)!, operator: 'ChargeZone' };
    const osm = record({ sourceId: 'osm-n9', lat: listing.lat + metresNorth(60), lng: listing.lng, name: 'EV point', connectors: [ccs2(60)] });
    const near = buildStations([osm, listing], { registry: emptyRegistry(), now });
    expect(near.stations.map((s) => s.legacyId)).toEqual(['osm-n9']);
    expect(near.listedDuplicates).toBe(1);

    const tata = record({ sourceId: 'osm-n10', lat: listing.lat + metresNorth(60), lng: listing.lng, operator: 'Tata Power EZ Charge', operatorMethod: 'mapped', connectors: [ccs2(60)] });
    expect(buildStations([tata, listing], { registry: emptyRegistry(), now }).stations).toHaveLength(2);

    const tgCsv = 'S.No.,Name of the EV Charging Station,State,District,Address,Latitude,Longitude,Name of the Owning Organisation\n1,Kukatpally FS,Telangana,Hyderabad,Kukatpally,17.4904,78.4,Jio-bp\n';
    const tg = tgredcoToCanonical({ file: 't.csv', csv: tgCsv }).records;
    const jio = rec(places.jio)!;
    const layer = buildStations([...tg, jio], { registry: emptyRegistry(), now });
    // Same network at the same spot: one station (merged or dropped), never two pins.
    expect(layer.stations).toHaveLength(1);
    expect(layer.stations[0].members.map((m) => m.source)).toContain('tgredco');
    expect(layer.stations[0].confidence).toBeLessThan(PLAN_MIN_CONFIDENCE);
  });

  it('pass the schema and the provenance gate, and ship the CDLA text and the Foursquare NOTICE', () => {
    const layer = buildStations(result.records, { registry: emptyRegistry(), now });
    for (const s of layer.stations) {
      expect(s.legacyId).toBe(s.id);
      expect(s.confidence).toBeLessThan(PLAN_MIN_CONFIDENCE);
    }
    const built = buildOutputs({ stations: layer.stations, sites: layer.sites, review: layer.review, sources: [], merged: layer.merged, blocked: layer.blocked, generatedAt: now.toISOString() });
    expect(validateStations(built.dataset.stations)).toEqual([]);
    const gates = runGates({
      baseline: null,
      health: {},
      sourceRecords: {},
      stations: [],
      schemaErrors: [],
      shardBytes: new Map(),
      canonical: layer.stations,
      adapters: [{ key: 'overture', licence: 'CDLA-Permissive-2.0' }],
    });
    expect(gates.failures).toEqual([]);
    const licence = built.files.get('LICENSE-data.txt')!.toString();
    for (const c of OVERTURE_CDLA_CONTRIBUTORS) expect(licence).toContain(c);
    expect(licence).toContain('Copyright 2024 Foursquare Labs, Inc.');
    expect(licence).toContain('AllThePlaces. Available under CC0 1.0');
    expect(built.files.get('LICENSE-CDLA-Permissive-2.0.txt')!.toString()).toBe(CDLA_PERMISSIVE_2_TEXT);
    expect(built.files.get('NOTICE-Foursquare.txt')!.toString()).toContain(FOURSQUARE_NOTICE);
    expect(built.files.get('LICENSE-Apache-2.0.txt')!.toString()).toMatch(/Apache License\s+Version 2\.0, January 2004/);
  });

  it('fails the licence gate when an Overture record claims ODbL', () => {
    const layer = buildStations([rec(places.chargezone)!], { registry: emptyRegistry(), now });
    (layer.stations[0].members[0] as { licence: string }).licence = 'ODbL-1.0';
    const gates = runGates({ baseline: null, health: {}, sourceRecords: {}, stations: [], schemaErrors: [], shardBytes: new Map(), canonical: layer.stations, adapters: [] });
    expect(gates.failures.join()).toMatch(/does not fit source overture/);
  });

  it('credits CDLA, every contributor, Foursquare and AllThePlaces in the adapter attribution', () => {
    const a = LICENCES['CDLA-Permissive-2.0'].attribution;
    for (const part of ['Overture Maps Foundation', 'Permissive 2.0', ...OVERTURE_CDLA_CONTRIBUTORS, 'Copyright 2024 Foursquare Labs, Inc.', 'Apache 2.0', 'AllThePlaces', 'CC0 1.0']) expect(a).toContain(part);
  });
});
