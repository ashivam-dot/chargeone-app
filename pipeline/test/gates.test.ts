import { inflateRawSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import type { Station } from '../../src/data/model.ts';
import { baselineFrom, runGates, type GateInput } from '../gates.ts';
import { emptyRegistry } from '../ids.ts';
import { osmAdapter } from '../adapters/osm.ts';
import { ocmExportAdapter } from '../adapters/ocm-export.ts';
import { INDEX_SCHEMA, decodeIndex, type CellFile, type CompactIndex } from '../../src/data/compact.ts';
import { buildOutputs } from '../outputs.ts';
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

const previous = Array.from({ length: 100 }, (_, i) => station(`osm-n${i + 1}`, { lat: 12 + i * 0.01, speed: i < 50 ? 'dc' : 'ac' }));
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
    for (const f of ['manifest.json', 'index.json', 'coverage.json', 'review-queue.json', 'aliases.json', 'chargeone-stations-odbl.zip']) expect(files.has(f), f).toBe(true);
    expect([...files.keys()].some((f) => f.startsWith('shards/'))).toBe(true);
    expect(manifest.counts).toMatchObject({ stations: 2, merged: 1, quarantined: 2 });
    expect(manifest.sources.map((s) => s.licence)).toEqual(['ODbL-1.0', 'CC-BY-4.0']);
    const coverage = JSON.parse(files.get('coverage.json')!.toString());
    expect(coverage.national.wording).toMatch(/of at least \d+ installed charging stations/);
    const aliases = JSON.parse(files.get('aliases.json')!.toString());
    expect(aliases.aliases['ocm-2']).toBe(aliases.aliases['osm-n1']);
    expect(JSON.stringify([...files.values()].map((b) => b.toString('latin1')))).not.toContain('ocm-9');
  });

  it('writes a v2 index with sources and a cell file for every shard that aliases.json points to', () => {
    const { files, manifest } = build();
    const index = JSON.parse(files.get('index.json')!.toString()) as CompactIndex;
    expect(index.schema).toBe(INDEX_SCHEMA);
    expect(index.sources.map((s) => s.licence)).toEqual(['ODbL 1.0', 'CC BY 4.0']);
    const stations = decodeIndex(index);
    expect(stations).toHaveLength(manifest.counts.stations);
    const aliases = JSON.parse(files.get('aliases.json')!.toString()) as { cells: Record<string, string>; legacy: Record<string, string> };
    for (const s of stations) {
      const cell = aliases.cells[s.c1Id!];
      expect(manifest.shards.map((x) => x.cell)).toContain(cell);
      const rows = (JSON.parse(files.get(`cells/${cell}.json`)!.toString()) as CellFile).rows;
      expect(rows.find((r) => r[0] === s.c1Id)?.[1]).toBe(s.id);
      expect(aliases.legacy[s.c1Id!]).toBe(s.id);
    }
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

  it('splits dense areas into shards of at most 400 stations', () => {
    const many = Array.from({ length: 900 }, (_, i) => record({ sourceId: `osm-n${1000 + i}`, lat: 12.9 + (i % 30) * 0.004, lng: 77.5 + Math.floor(i / 30) * 0.004 }));
    const layer = buildStations(many, { registry: emptyRegistry(), now });
    const { manifest } = buildOutputs({ ...layer, sources: [], generatedAt: now.toISOString() });
    expect(manifest.shards.reduce((n, s) => n + s.stations, 0)).toBe(900);
    expect(Math.max(...manifest.shards.map((s) => s.stations))).toBeLessThanOrEqual(400);
  });
});
