import { inflateRawSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import type { Station } from '../../src/data/model.ts';
import { baselineFrom, runGates, type GateInput } from '../gates.ts';
import { emptyRegistry } from '../ids.ts';
import { osmAdapter } from '../adapters/osm.ts';
import { ocmExportAdapter } from '../adapters/ocm-export.ts';
import { INDEX_SCHEMA, decodeIndex, type CellFile, type CompactIndex } from '../../src/data/compact.ts';
import { aliasBucket, resolveThroughBuckets, type AliasBucket, type LookupFile } from '../../src/data/lookup.ts';
import { THRESHOLDS } from '../config.ts';
import { geohash } from '../lib/geo.ts';
import { adaptiveCells, buildOutputs } from '../outputs.ts';
import { validateStations } from '../schema.ts';
import { buildStations } from '../stations.ts';
import type { AdapterResult } from '../types.ts';
import { ccs2, metresNorth, record, type2 } from './helpers.ts';

const station = (id: string, over: Partial<Station> = {}): Station => ({
  id,
  name: 'Test',
  operator: null,
  lat: 12.97,
  lng: 77.59,
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
  sources: [{ name: 'OpenStreetMap', id: 'node/1', url: 'https://www.openstreetmap.org/node/1' }],
  ...over,
});

const previous = Array.from({ length: 100 }, (_, i) => station(`osm-n${i + 1}`, { lat: 12 + i * 0.01, speed: i < 50 ? 'dc' : 'ac', confidence: 0.8 }));
const baseline = baselineFrom(
  { generatedAt: '2026-10-20T00:00:00Z', sources: [{ name: 'OpenStreetMap', licence: 'ODbL 1.0', attribution: '', url: '', count: 100 }], stations: previous },
  null,
);
const ok: GateInput = {
  baseline,
  health: { osm: { ok: true, problems: [] } },
  sourceRecords: { osm: 100 },
  stations: previous,
  schemaErrors: [],
  shardBytes: new Map([['tdr', 1000]]),
};

describe('quality gates', () => {
  it('passes an unchanged build', () => {
    expect(runGates(ok)).toMatchObject({ ok: true, failures: [] });
  });

  it('fails when a source is truncated (fault injection)', () => {
    const r = runGates({ ...ok, sourceRecords: { osm: 70 } });
    expect(r.ok).toBe(false);
    expect(r.failures.join()).toMatch(/osm dropped 30\.0%/);
  });

  it('fails when a source disappears', () => {
    expect(runGates({ ...ok, sourceRecords: {} }).failures.join()).toMatch(/missing from this run/);
  });

  it('fails when the adapter health check fails', () => {
    expect(runGates({ ...ok, health: { osm: { ok: false, problems: ['only 9 OSM objects'] } } }).ok).toBe(false);
  });

  it('fails when the DC count drops by more than 10%', () => {
    const fewerDc = (n: number) => previous.map((s, i) => (i < n ? { ...s, speed: 'ac' as const } : s));
    expect(runGates({ ...ok, stations: fewerDc(4) }).ok).toBe(true); // 4 of 50 = 8%
    const r = runGates({ ...ok, stations: fewerDc(6) }); // 6 of 50 = 12%
    expect(r.ok).toBe(false);
    expect(r.failures.join()).toMatch(/DC stations dropped/);
  });

  it('fails when more than 5% of stations move more than 200 m', () => {
    const moved = previous.map((s, i) => (i < 6 ? { ...s, lat: s.lat + 0.01 } : s));
    expect(runGates({ ...ok, stations: moved }).failures.join()).toMatch(/moved more than 200 m/);
    const fine = previous.map((s, i) => (i < 4 ? { ...s, lat: s.lat + 0.01 } : s));
    expect(runGates({ ...ok, stations: fine }).ok).toBe(true);
  });

  it('follows aliases when matching moved stations', () => {
    const renamed = previous.map((s) => ({ ...s, id: `ocm-${s.id.slice(5)}`, aliases: [s.id] }));
    expect(runGates({ ...ok, stations: renamed }).checks.join()).toMatch(/0 of 100 matched/);
  });

  it('fails on schema errors and on shards over 1 MB', () => {
    expect(runGates({ ...ok, schemaErrors: validateStations([station('bad-id')]) }).failures.join()).toMatch(/schema/);
    expect(runGates({ ...ok, shardBytes: new Map([['t9y', 1_200_000]]) }).failures.join()).toMatch(/shard t9y/);
  });

  it('fails when too few DC stations clear the planner confidence line', () => {
    const shaky = previous.map((s, i) => (i < 40 ? { ...s, confidence: 0.4 } : s)); // 10 of 50 DC plannable = 20%
    expect(runGates({ ...ok, stations: shaky }).failures.join()).toMatch(/of DC stations are plannable/);
    const enough = previous.map((s, i) => (i < 30 ? { ...s, confidence: 0.4 } : s)); // 20 of 50 = 40%
    expect(runGates({ ...ok, stations: enough }).ok).toBe(true);
  });

  it('fails on an operational station with no connectors', () => {
    const empty = previous.map((s, i) => (i === 0 ? { ...s, status: 'operational' as const } : s));
    expect(runGates({ ...ok, stations: empty }).failures.join()).toMatch(/1 operational stations list no connectors, first: osm-n1/);
    const unknown = previous.map((s, i) => (i === 0 ? { ...s, status: 'unknown' as const } : s));
    expect(runGates({ ...ok, stations: unknown }).ok).toBe(true);
  });

  it('fails on alias collisions, oversized files and too many files', () => {
    expect(runGates({ ...ok, aliasCollisions: ['osm-n2'] }).failures.join()).toMatch(/1 aliases are live station ids/);
    expect(runGates({ ...ok, fileBytes: new Map([['index.json', THRESHOLDS.assetBytes + 1]]) }).failures.join()).toMatch(/index\.json is \d+ bytes \(asset limit/);
    const many = new Map(Array.from({ length: THRESHOLDS.maxDataFiles + 1 }, (_, i) => [`shards/${i}.json`, 10] as [string, number]));
    expect(runGates({ ...ok, fileBytes: many }).failures.join()).toMatch(/data files \(limit/);
    expect(runGates({ ...ok, fileBytes: new Map([['index.json', 1000]]) }).ok).toBe(true);
  });

  it('the schema validator accepts the published shape and rejects broken rows', () => {
    expect(validateStations(previous)).toEqual([]);
    expect(validateStations([station('osm-n1', { lat: 51.5 })]).join()).toMatch(/outside India/);
    expect(validateStations([station('osm-n1'), station('osm-n1')]).join()).toMatch(/used by two stations/);
  });
});

describe('outputs', () => {
  const now = new Date('2026-10-23T00:00:00Z');
  const records = [
    record({ sourceId: 'osm-n1', operator: 'Statiq', name: 'Statiq Mall', connectors: [ccs2(60)], stateHint: 'Karnataka' }),
    record({ sourceId: 'ocm-2', source: 'ocm', operator: 'Statiq', name: 'Statiq Mall', lat: 12.97 + metresNorth(9), connectors: [ccs2(60), type2()] }),
    record({ sourceId: 'osm-n3', lat: 19.07, lng: 72.87, stateHint: 'Maharashtra' }),
  ];
  const result = (recs: typeof records): AdapterResult => ({ records: recs, rejected: [{ sourceId: 'ocm-9', reason: 'google-derived', quarantine: true }], rawCount: recs.length + 1, snapshotAt: '2026-10-22T00:00:00Z' });
  const build = () => {
    const layer = buildStations(records, { registry: emptyRegistry(), now });
    return buildOutputs({
      ...layer,
      sources: [
        { adapter: osmAdapter as never, result: result(records.filter((r) => r.source === 'osm')), origin: 'overpass' },
        { adapter: ocmExportAdapter as never, result: result(records.filter((r) => r.source === 'ocm')), origin: 'github-export' },
      ],
      generatedAt: now.toISOString(),
    });
  };

  it('writes a backward-compatible stations.json with the new optional fields', () => {
    const { dataset } = build();
    expect(dataset.stations).toHaveLength(2);
    const merged = dataset.stations.find((s) => s.id === 'osm-n1')!;
    expect(merged.c1Id).toMatch(/^c1_/);
    expect(merged.aliases).toEqual(['ocm-2']);
    expect(merged.sources.map((s) => s.name)).toEqual(['Open Charge Map', 'OpenStreetMap']);
    expect(merged.provenance).toMatchObject({ position: 'osm-n1', maxKw: 'ocm-2' });
    expect(validateStations(dataset.stations)).toEqual([]);
  });

  it('is byte-for-byte reproducible', () => {
    const a = build();
    const b = build();
    for (const [name, bytes] of a.files) expect(b.files.get(name)?.equals(bytes), name).toBe(true);
  });

  it('publishes the manifest, index, shards, coverage, review queue, aliases and the ODbL dump', () => {
    const { files, manifest } = build();
    for (const f of ['manifest.json', 'index.json', 'coverage.json', 'review-queue.json', 'cells.json', 'chargeone-stations-odbl.zip']) expect(files.has(f), f).toBe(true);
    expect([...files.keys()].some((f) => f.startsWith('shards/'))).toBe(true);
    expect(manifest.counts).toMatchObject({ stations: 2, merged: 1, quarantined: 2 });
    expect(manifest.sources.map((s) => s.licence)).toEqual(['ODbL-1.0', 'CC-BY-4.0']);
    const coverage = JSON.parse(files.get('coverage.json')!.toString());
    expect(coverage.national.wording).toMatch(/of at least \d+ installed charging stations/);
    expect(files.has('aliases.json'), 'no single alias file').toBe(false);
    const lookup = JSON.parse(files.get('cells.json')!.toString()) as LookupFile;
    const bucket = (id: string) => JSON.parse(files.get(`aliases/${aliasBucket(id, lookup.aliasBuckets)}.json`)!.toString()) as AliasBucket;
    expect(bucket('ocm-2').aliases['ocm-2']).toBe(bucket('osm-n1').aliases['osm-n1']);
    expect(JSON.stringify([...files.values()].map((b) => b.toString('latin1')))).not.toContain('ocm-9');
  });

  it('writes a columnar index with sources and a cell file for every shard the alias buckets point to', async () => {
    const { files, manifest } = build();
    const index = JSON.parse(files.get('index.json')!.toString()) as CompactIndex;
    expect(index.schema).toBe(INDEX_SCHEMA);
    expect(index.sources.map((s) => s.licence)).toEqual(['ODbL 1.0', 'CC BY 4.0']);
    const stations = decodeIndex(index);
    expect(stations).toHaveLength(manifest.counts.stations);
    const lookup = JSON.parse(files.get('cells.json')!.toString()) as LookupFile;
    expect(lookup.version).toBe(manifest.version);
    const read = async (b: string) => {
      const f = files.get(`aliases/${b}.json`);
      return f ? (JSON.parse(f.toString()) as AliasBucket) : null;
    };
    for (const s of stations) {
      const hit = (await resolveThroughBuckets(s.c1Id!, lookup.aliasBuckets, read))!;
      expect(manifest.shards.map((x) => x.cell)).toContain(hit.cell);
      expect(lookup.cells).toContain(hit.cell);
      const rows = (JSON.parse(files.get(`cells/${hit.cell}.json`)!.toString()) as CellFile).rows;
      expect(rows.find((r) => r[0] === s.c1Id)?.[1]).toBe(s.id);
      expect(hit.legacyId).toBe(s.id);
      for (const a of s.aliases ?? []) expect((await resolveThroughBuckets(a, lookup.aliasBuckets, read))?.c1Id).toBe(s.c1Id);
    }
    expect(await resolveThroughBuckets('osm-n999999', lookup.aliasBuckets, read)).toBeNull();
  });

  it('the ODbL zip holds the licence and the data', () => {
    const zip = build().files.get('chargeone-stations-odbl.zip')!;
    expect(zip.readUInt32LE(0)).toBe(0x04034b50);
    const nameLen = zip.readUInt16LE(26);
    const size = zip.readUInt32LE(18);
    expect(zip.subarray(30, 30 + nameLen).toString()).toBe('LICENSE.txt');
    const text = inflateRawSync(zip.subarray(30 + nameLen, 30 + nameLen + size)).toString();
    expect(text).toMatch(/Open Database License/);
    expect(text).toMatch(/CC BY 4\.0/);
  });

  it('leaves aliases that are live ids out of the alias buckets and reports them', () => {
    const layer = buildStations(records, { registry: emptyRegistry(), now });
    const [first, second] = layer.stations;
    const clash = { ...layer, stations: [{ ...first, aliases: [...first.aliases, second.id] }, second] };
    const built = buildOutputs({ ...clash, sources: [], generatedAt: now.toISOString() });
    expect(built.aliasCollisions).toEqual([`${second.id} (alias of ${first.id})`]);
    for (const [name, bytes] of built.files) if (name.startsWith('aliases/')) expect((JSON.parse(bytes.toString()) as AliasBucket).aliases[second.id]).toBeUndefined();
    expect(runGates({ ...ok, aliasCollisions: built.aliasCollisions }).ok).toBe(false);
  });

  it('stops writing stations.json once it outgrows the legacy limit', () => {
    const saved = THRESHOLDS.legacyStationsBytes;
    try {
      THRESHOLDS.legacyStationsBytes = 100;
      const { files, manifest } = build();
      expect(files.has('stations.json')).toBe(false);
      expect(manifest.legacyStations).toBe(false);
      expect(files.has('index.json')).toBe(true);
    } finally {
      THRESHOLDS.legacyStationsBytes = saved;
    }
    expect(build().manifest.legacyStations).toBe(true);
  });

  it('splits the ODbL dump into parts under the asset limit, each with the licence', () => {
    const saved = THRESHOLDS.assetBytes;
    try {
      THRESHOLDS.assetBytes = 1500;
      const { files, manifest } = build();
      expect(manifest.odbl.length).toBeGreaterThan(1);
      expect(manifest.odbl[0]).toBe('chargeone-stations-odbl.zip');
      expect(manifest.odbl[1]).toBe('chargeone-stations-odbl-2.zip');
      const ids: string[] = [];
      for (const name of manifest.odbl) {
        const zip = files.get(name)!;
        const nameLen = zip.readUInt16LE(26);
        const size = zip.readUInt32LE(18);
        expect(inflateRawSync(zip.subarray(30 + nameLen, 30 + nameLen + size)).toString()).toMatch(/Open Database License[\s\S]*Part \d of \d/);
        const second = 30 + nameLen + size;
        const n2 = zip.readUInt16LE(second + 26);
        const s2 = zip.readUInt32LE(second + 18);
        const geo = JSON.parse(inflateRawSync(zip.subarray(second + 30 + n2, second + 30 + n2 + s2)).toString()) as { features: Array<{ id: string }> };
        ids.push(...geo.features.map((f) => f.id));
      }
      expect(ids.sort()).toEqual(build().dataset.stations.map((s) => s.c1Id!).sort());
    } finally {
      THRESHOLDS.assetBytes = saved;
    }
  });

  it('keeps the file count low at 100k stations: sparse children stay in their parent cell', () => {
    // A uniform spread over India is the worst case for geohash splitting (no empty cells to skip).
    const points = Array.from({ length: 100_000 }, (_, i) => ({ lat: 8.5 + (i % 400) * 0.05, lng: 70 + Math.floor(i / 400) * 0.08 }));
    const cells = adaptiveCells(points);
    expect([...cells.values()].reduce((n, m) => n + m.length, 0)).toBe(100_000);
    expect(Math.max(...[...cells.values()].map((m) => m.length))).toBeLessThanOrEqual(400);
    // Two files per cell (shard + cell list): within the data file budget with room for the alias buckets.
    expect(cells.size * 2 + 64 + 10).toBeLessThan(THRESHOLDS.maxDataFiles);
    // Every station sits in a cell whose bounds hold it, so readers that pick cells by bounds find it.
    for (const [cell, m] of cells) for (const i of m.slice(0, 3)) expect(geohash(points[i].lat, points[i].lng, cell.length)).toBe(cell);
  });

  it.runIf(process.env.PIPELINE_SCALE)('builds 100k stations under the Cloudflare file limits (PIPELINE_SCALE=1)', () => {
    const many = Array.from({ length: 100_000 }, (_, i) =>
      record({ sourceId: `osm-n${i + 1}`, operator: 'Statiq', operatorMethod: 'mapped', name: `Statiq ${i}`, lat: 8.5 + (i % 400) * 0.05, lng: 70 + Math.floor(i / 400) * 0.08, connectors: [ccs2(60)] }),
    );
    const layer = buildStations(many, { registry: emptyRegistry(), now });
    const built = buildOutputs({ ...layer, sources: [], generatedAt: now.toISOString() });
    const fileBytes = new Map([...built.files].map(([n, b]) => [n, b.length]));
    expect(Math.max(...fileBytes.values())).toBeLessThanOrEqual(THRESHOLDS.assetBytes);
    expect(fileBytes.size).toBeLessThanOrEqual(THRESHOLDS.maxDataFiles);
    expect(built.files.has('stations.json')).toBe(false);
  }, 120_000);

  it('splits dense areas into shards of at most 400 stations', () => {
    const many = Array.from({ length: 900 }, (_, i) => record({ sourceId: `osm-n${1000 + i}`, lat: 12.9 + (i % 30) * 0.004, lng: 77.5 + Math.floor(i / 30) * 0.004 }));
    const layer = buildStations(many, { registry: emptyRegistry(), now });
    const { manifest } = buildOutputs({ ...layer, sources: [], generatedAt: now.toISOString() });
    expect(manifest.shards.reduce((n, s) => n + s.stations, 0)).toBe(900);
    expect(Math.max(...manifest.shards.map((s) => s.stations))).toBeLessThanOrEqual(400);
  });
});
