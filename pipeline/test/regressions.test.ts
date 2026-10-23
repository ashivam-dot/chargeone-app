// Regression tests for the data-fixes-v3 findings: connector counts, speed, scooter detection, OCM
// connection statuses, the Google filter, title networks, OSM swap tags, listing chains and id reissue.
import { describe, expect, it } from 'vitest';
import { GOOGLE_DERIVED, ocmLookups, ocmRecord, ocmToCanonical, titleNetwork, type OcmCompactPoi, type OcmRaw } from '../adapters/ocm.ts';
import { explicitSwap, osmRecord } from '../adapters/osm.ts';
import { aliasCollisions, assignIds, emptyRegistry } from '../ids.ts';
import { mergeSourceConnectors, sourceConnectors, speedOf, sumConnectors } from '../lib/connectors.ts';
import { inferVehicles, NO_VEHICLE_FLAGS } from '../lib/vehicle.ts';
import { listingNumber, resolve } from '../resolve.ts';
import { buildStations } from '../stations.ts';
import type { SourceRecord } from '../types.ts';
import { ccs2, fixture, metresNorth, record, type2 } from './helpers.ts';

const ocm = fixture<Pick<OcmRaw, 'pois' | 'ref'>>('ocm-sample.json');
const lookups = ocmLookups(ocm.ref);
const now = new Date('2026-10-23T00:00:00Z');

const poi = (over: Partial<OcmCompactPoi> = {}): OcmCompactPoi => ({
  ID: 990001,
  DataProviderID: 1,
  OperatorID: 3779,
  UsageTypeID: 5,
  StatusTypeID: 50,
  SubmissionStatusTypeID: 200,
  DateCreated: '2026-01-01T00:00:00Z',
  DateLastVerified: '2026-06-01T00:00:00Z',
  AddressInfo: { Title: 'Statiq Forum Mall', CountryID: 106, Latitude: 12.93, Longitude: 77.61, StateOrProvince: 'Karnataka' },
  Connections: [{ ID: 1, ConnectionTypeID: 33, CurrentTypeID: 30, PowerKW: 60, Quantity: 2, StatusTypeID: 50 }],
  ...over,
});
const asRecord = (p: OcmCompactPoi) => {
  const r = ocmRecord(p, lookups);
  if ('reason' in r) throw new Error(`rejected: ${r.reason}`);
  return r;
};

describe('connector counts', () => {
  it('adds up the connections of one listing, one entry per kW tier', () => {
    const summed = sumConnectors([[ccs2(60)], [ccs2(60)], [ccs2(30)], [type2(7.4)]]);
    expect(summed.map((c) => [c.standard, c.maxKw, c.count])).toEqual([
      ['CCS2', 60, 2],
      ['CCS2', 30, 1],
      ['Type 2', 7.4, 1],
    ]);
    expect(sumConnectors([[{ ...ccs2(60), count: 2 }], [{ ...ccs2(60), count: 3 }]])[0].count).toBe(5);
    expect(sumConnectors([[ccs2(60)]])[0].count).toBe(1); // a lone entry keeps its own count
  });

  it('two OSM objects are two chargers; one OCM site listed twice is counted once', () => {
    expect(sourceConnectors('osm', [[ccs2(60)], [ccs2(60)]])[0].count).toBe(2);
    expect(sourceConnectors('ocm', [[ccs2(60)], [ccs2(60)]])[0].count).toBe(1);
    expect(sourceConnectors('ocm', [[ccs2(60)], [ccs2(30)]]).map((c) => c.maxKw)).toEqual([60, 30]);
  });

  it('never adds OSM and OCM descriptions of the same site together', () => {
    const merged = mergeSourceConnectors([[{ ...ccs2(null), count: 2 }], [{ ...ccs2(60), count: 2 }]]);
    expect(merged.map((c) => [c.standard, c.maxKw, c.count])).toEqual([['CCS2', 60, 2]]);
  });

  it('the OCM 471003 shape (2x160 + 2x60 CCS2, two Type 2) counts six sockets, not two', () => {
    const p = ocm.pois.find((x) => x.ID === 471003)!;
    const r = asRecord({ ...p, ID: 990002, GeneralComments: null, AddressInfo: { ...p.AddressInfo!, AccessComments: null } });
    const connectors = sumConnectors(r.evses.map((e) => e.connectors));
    expect(connectors.reduce((n, c) => n + (c.count ?? 0), 0)).toBe(6);
    expect(connectors.filter((c) => c.standard === 'CCS2').map((c) => c.maxKw)).toEqual([160, 60]);
  });

  it('the merged station reports summed connectors', () => {
    const r = record({ source: 'ocm', operator: 'Statiq', evses: [ccs2(60), ccs2(60), type2(7.4)].map((c, i) => ({ uid: `x:${i}`, connectors: [c] })) });
    const [s] = buildStations([r], { registry: emptyRegistry(), now }).stations;
    expect(s.connectors.value.find((c) => c.standard === 'CCS2')?.count).toBe(2);
  });
});

describe('speed', () => {
  it('a DC current on an AC-only plug is a data-entry slip, not a fast charger', () => {
    expect(speedOf([{ ...type2(7.4), powerType: 'DC' }], 7.4)).toBe('ac');
    expect(speedOf([{ standard: '3-pin socket', powerType: 'DC', maxKw: 3, count: 1 }], 3)).toBe('ac');
    expect(speedOf([{ ...type2(43), powerType: 'DC' }], 43)).toBe('dc'); // the power says DC
    expect(speedOf([{ standard: 'Other', powerType: 'DC', maxKw: null, count: 1 }], null)).toBe('dc');
    expect(speedOf([ccs2(null)], null)).toBe('dc');
  });
});

describe('two-wheeler detection', () => {
  const v = (name: string | null, connectors = [type2(3.3)], tethered = false) =>
    inferVehicles({ explicit: NO_VEHICLE_FLAGS, connectors, operator: null, name, stationKw: null, tethered });

  it('reads 2W wording in names', () => {
    for (const name of ['Two Wheeler Charging', '2-Wheeler Point', '2 Ev Wheeler Charger', 'KSEB 2W', 'E-Bike charging', 'Scooter dock']) {
      expect(v(name, []).twoWheeler, name).toBe(true);
    }
    expect(v('Wheeler Road Charging Hub', []).twoWheeler).toBeNull();
  });

  it('a tethered or 2W-named Type 2 lead of 3.3 kW or less is a scooter charger, not a car one', () => {
    expect(v(null, [type2(3.3)], true)).toMatchObject({ twoWheeler: true, car: false });
    expect(v('2 Wheeler charging', [type2(3.3)])).toMatchObject({ twoWheeler: true, car: false });
    // An untethered 3.3 kW Type 2 socket with no 2W hint might take a car's own cable.
    expect(v('Mall parking', [type2(3.3)]).car).not.toBe(false);
    // A car DC plug at the same listing keeps it a car charger.
    expect(v(null, [type2(3.3), ccs2(60)], true).car).toBe(true);
    // 7.4 kW tethered Type 2 is a car lead.
    expect(v(null, [type2(7.4)], true).car).toBe(true);
  });

  it('the OCM adapter passes "Type 2 (Tethered Connector)" through', () => {
    const r = asRecord(poi({ Connections: [{ ID: 1, ConnectionTypeID: 1036, PowerKW: 3.3, Quantity: 1, StatusTypeID: 50 }] }));
    expect(r.vehicles).toMatchObject({ twoWheeler: true, car: false });
  });
});

describe('OCM connection statuses', () => {
  const conn = (status: number | null, kw = 60) => ({ ID: kw * 10 + (status ?? 0), ConnectionTypeID: 33, CurrentTypeID: 30, PowerKW: kw, Quantity: 1, StatusTypeID: status });

  it('rejects a POI whose every connection is non-operational, planned or removed', () => {
    expect(ocmRecord(poi({ Connections: [conn(100), conn(100, 30)] }), lookups)).toMatchObject({ reason: 'not-operational' });
    expect(ocmRecord(poi({ Connections: [conn(200), conn(150, 30)] }), lookups)).toMatchObject({ reason: 'removed' });
  });

  it('all connections temporarily unavailable makes the station temporarily unavailable', () => {
    const r = asRecord(poi({ Connections: [conn(30), conn(30, 30)] }));
    expect(r.status).toBe('temporarily_unavailable');
    expect(r.flags).toContain('ocm-connections-30');
  });

  it('some connections down or removed makes an operational station partly operational', () => {
    const some = asRecord(poi({ Connections: [conn(30), conn(50, 30)] }));
    expect(some.status).toBe('partly_operational');
    expect(some.flags).toContain('ocm-connections-partly');
    const removed = asRecord(poi({ Connections: [conn(200), conn(50, 30)] }));
    expect(removed.status).toBe('partly_operational');
    expect(removed.flags).toContain('connection-removed');
    expect(removed.evses).toHaveLength(1);
  });

  it('"operational" with no equipment listed is unknown', () => {
    expect(asRecord(poi({ Connections: [] })).status).toBe('unknown');
    expect(asRecord(poi()).status).toBe('operational');
  });
});

describe('Google-derived OCM records', () => {
  it('catches every Maps link shape and Place ids', () => {
    for (const s of [
      'Google Place ID: x',
      'ChIJN1t_tDeuEmsRUsoyG83frY4',
      'https://maps.google.com/?cid=1',
      'https://www.google.co.in/maps/place/x',
      'https://goo.gl/maps/abc',
      'https://maps.app.goo.gl/occVcRz8hSiCw4dp8',
      'https://g.page/some-business',
    ]) {
      expect(GOOGLE_DERIVED.test(s), s).toBe(true);
    }
    for (const s of ['https://greenenergyevcharger.com/', 'Opposite Google office, Bengaluru', 'Chijmes Road']) expect(GOOGLE_DERIVED.test(s), s).toBe(false);
  });

  it('scans every text field, not just the general comments', () => {
    const link = 'https://maps.app.goo.gl/abc123';
    expect(ocmRecord(poi({ AddressInfo: { ...poi().AddressInfo!, AccessComments: link } }), lookups)).toMatchObject({ reason: 'google-derived', quarantine: true });
    expect(ocmRecord(poi({ AddressInfo: { ...poi().AddressInfo!, RelatedURL: link } }), lookups)).toMatchObject({ reason: 'google-derived' });
    expect(ocmRecord({ ...poi(), MediaItems: [{ Comment: link }] } as OcmCompactPoi, lookups)).toMatchObject({ reason: 'google-derived' });
  });

  it('quarantines the real OCM 471003 listing (maps.app.goo.gl in its comments)', () => {
    const result = ocmToCanonical({ ...ocm, snapshotAt: '2026-04-22T10:59:34Z', origin: 'export' });
    expect(result.rejected).toContainEqual({ sourceId: 'ocm-471003', reason: 'google-derived', quarantine: true });
    expect(result.records.some((r) => r.sourceId === 'ocm-471003')).toBe(false);
  });
});

describe('networks named in OCM titles', () => {
  it('spots another network in the title, as words or run together', () => {
    expect(titleNetwork('ChargeZone - Forum Mall', 'Statiq', lookups)).toBe('ChargeZone');
    expect(titleNetwork('Charge Zone Forum Mall', 'Statiq', lookups)).toBe('ChargeZone');
    expect(titleNetwork('Relux Electric Padi', 'Statiq', lookups)).toBe('Relux Electric');
  });

  it('ignores titles that name the mapped operator, generic words and hosts', () => {
    expect(titleNetwork('Statiq x ChargeZone Hub', 'Statiq', lookups)).toBeNull();
    expect(titleNetwork('Popular Hyundai EV Charging Station', 'Statiq', lookups)).toBeNull();
    expect(titleNetwork(null, 'Statiq', lookups)).toBeNull();
  });

  it('flags the record and carries the title operator', () => {
    const r = asRecord(poi({ AddressInfo: { ...poi().AddressInfo!, Title: 'ChargeZone Forum Mall' } }));
    expect(r.flags).toContain('operator-conflict');
    expect(r.titleOperator).toBe('ChargeZone');
    expect(new Set(r.flags).size).toBe(r.flags.length);
  });
});

describe('OSM battery swapping tags', () => {
  it('reads charging_station:battery_swapping and battery_swapping', () => {
    expect(explicitSwap({ 'charging_station:battery_swapping': 'yes' })).toBe(true);
    expect(explicitSwap({ battery_swapping: 'yes' })).toBe(true);
    expect(explicitSwap({ battery_swapping: 'no' })).toBe(false);
    expect(explicitSwap({})).toBeNull();
  });

  it('an OSM swap station is a swap station whatever its name', () => {
    const r = osmRecord({ type: 'node', id: 77, lat: 12.97, lon: 77.59, tags: { amenity: 'charging_station', name: 'Corner Store', battery_swapping: 'yes' } });
    expect('reason' in r ? null : r.batterySwap).toBe(true);
  });
});

describe('same-source listings and title operators in resolution', () => {
  it('reads listing numbers', () => {
    expect(listingNumber('Statiq Hub - 2')).toBe(2);
    expect(listingNumber('Statiq Hub #3')).toBe(3);
    expect(listingNumber('Fast Charger 4')).toBe(4);
    expect(listingNumber('NH 48 Charging')).toBeNull();
    expect(listingNumber(null)).toBeNull();
  });

  it('keeps numbered listings of one source apart, even at one point', () => {
    const a = record({ source: 'ocm', operator: 'Statiq', name: 'Statiq Hub - 1', connectors: [ccs2(60)] });
    const b = record({ source: 'ocm', operator: 'Statiq', name: 'Statiq Hub - 2', connectors: [ccs2(60)] });
    const { clusters, blocked } = resolve([a, b]);
    expect(clusters).toHaveLength(2);
    expect(blocked[0].reason).toMatch(/numbered listings 1 \/ 2/);
  });

  it('does not chain two different same-source listings through a record of the other source', () => {
    const osm = record({ source: 'osm', operator: 'Statiq', name: 'Statiq', connectors: [ccs2(60)] });
    const a = record({ source: 'ocm', operator: 'Statiq', name: 'Statiq Forum Mall', lat: osm.lat + metresNorth(3), connectors: [ccs2(60)] });
    const b = record({ source: 'ocm', operator: 'Statiq', name: 'Statiq Koramangala Depot', lat: osm.lat - metresNorth(3), connectors: [ccs2(60)] });
    const { clusters } = resolve([osm, a, b]);
    for (const cl of clusters) expect(cl.filter((i) => [osm, a, b][i].source === 'ocm').length).toBeLessThanOrEqual(1);
  });

  it('a title naming the other record’s network lets two sources merge despite the operator', () => {
    const osm = record({ source: 'osm', operator: 'ChargeZone', name: 'ChargeZone Forum Mall', connectors: [ccs2(60)] });
    const ocmR = record({ source: 'ocm', operator: 'Statiq', titleOperator: 'ChargeZone', name: 'ChargeZone Forum Mall', lat: osm.lat + metresNorth(5), connectors: [ccs2(60)] });
    const { clusters, review } = resolve([osm, ocmR]);
    expect(clusters).toHaveLength(1);
    expect(review.some((x) => x.kind === 'operator-title')).toBe(false); // confirmed by the OSM record
  });

  it('the same title within 10 m relaxes the operator block; farther apart it stays', () => {
    const a = record({ source: 'osm', operator: 'ChargeZone', name: 'Highway Fuel Plaza EV', connectors: [ccs2(60)] });
    const near = record({ source: 'ocm', operator: 'Statiq', name: 'Highway Fuel Plaza EV', lat: a.lat + metresNorth(6), connectors: [ccs2(60)] });
    const far = { ...near, sourceId: 'ocm-far', lat: a.lat + metresNorth(40) };
    expect(resolve([a, near]).blocked).toHaveLength(0);
    expect(resolve([a, far]).blocked[0].reason).toMatch(/different operators/);
  });

  it('an unconfirmed title operator goes to the review queue as its own item', () => {
    const r = record({ source: 'ocm', operator: 'Statiq', titleOperator: 'ChargeZone', name: 'ChargeZone Forum Mall', connectors: [ccs2(60)] });
    const { review } = resolve([r]);
    expect(review).toEqual([expect.objectContaining({ kind: 'operator-title', i: 0, j: 0 })]);
    const [s] = buildStations([r], { registry: emptyRegistry(), now }).review;
    expect(s).toMatchObject({ kind: 'operator-title' });
  });

  it('prefers an operator not flagged as conflicting when merging', () => {
    const osm = record({ source: 'osm', operator: 'ChargeZone', name: 'ChargeZone Forum Mall', connectors: [ccs2(60)] });
    const ocmR = record({ source: 'ocm', operator: 'Statiq', titleOperator: 'ChargeZone', flags: ['operator-conflict'], name: 'ChargeZone Forum Mall', lat: osm.lat + metresNorth(5), connectors: [ccs2(60)] });
    const stations = buildStations([ocmR, osm], { registry: emptyRegistry(), now }).stations;
    expect(stations).toHaveLength(1);
    expect(stations[0].operator.value).toBe('ChargeZone');
  });
});

describe('id reissue on a split', () => {
  it('a split brings the merged-away id back to life, with no alias pointing at a live id', () => {
    const reg = emptyRegistry();
    const [a, b] = assignIds([['ocm-1'], ['osm-n1']], reg, '2026-10-01');
    const [merged] = assignIds([['ocm-1', 'osm-n1']], reg, '2026-10-10');
    const retired = merged.id === a.id ? b.id : a.id;
    expect(merged.aliases).toContain(retired);
    expect(reg.stations[retired].mergedInto).toBe(merged.id);
    const split = assignIds([['ocm-1'], ['osm-n1']], reg, '2026-10-20');
    expect(split.map((s) => s.id).sort()).toEqual([a.id, b.id].sort());
    expect(reg.stations[retired].mergedInto).toBeUndefined();
    expect(reg.stations[retired].gone).toBeUndefined();
    expect(aliasCollisions(split)).toEqual([]);
    for (const s of split) expect(s.aliases).not.toContain(split.find((x) => x !== s)!.id);
  });

  it('aliasCollisions reports an alias that is a live id', () => {
    expect(aliasCollisions([{ id: 'c1_a', legacyId: 'osm-n1', aliases: ['c1_b'] }, { id: 'c1_b', legacyId: 'osm-n2', aliases: [] }])).toEqual(['c1_b (alias of c1_a)']);
  });

  it('assigns 50,000 clusters with history in well under a few seconds', () => {
    const reg = emptyRegistry();
    const singles = Array.from({ length: 50_000 }, (_, i) => [`osm-n${i}`]);
    assignIds(singles, reg, '2026-10-01');
    // Merge pairs, so half the ids retire into the other half.
    const pairs = Array.from({ length: 25_000 }, (_, i) => [`osm-n${2 * i}`, `osm-n${2 * i + 1}`]);
    const t = performance.now();
    const out = assignIds(pairs, reg, '2026-10-02');
    expect(performance.now() - t).toBeLessThan(3000);
    expect(out).toHaveLength(25_000);
    expect(out[0].aliases.some((x) => x.startsWith('c1_'))).toBe(true);
  });
});

/** Narrow a record to a fixture-free shape (keeps the type checker honest about SourceRecord). */
export type _Unused = SourceRecord;
