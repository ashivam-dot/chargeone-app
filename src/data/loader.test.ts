import { existsSync, readFileSync } from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import { decodeIndex, encodeIndex, INDEX_SCHEMA, longId, shortId, type CompactIndex } from './compact.ts';
import { clearAliasCache, resolveAlias } from './aliasLookup.ts';
import { clearShardCache, loadDataset, loadStationDetail } from './loader.ts';
import { aliasBucket, bucketCount, KEYS_PER_BUCKET, resolveThroughBuckets, type AliasBucket } from './lookup.ts';
import type { Dataset, Station } from './model.ts';
import { keepIfSame, statusesByStation, unknownStatusIds } from './statusIds.ts';
import type { StationStatus } from '../shared/status.ts';

const DIR = new URL('../../public/data/', import.meta.url);
const read = (name: string) => JSON.parse(readFileSync(new URL(name, DIR), 'utf8'));

/** Serves public/data like the deployment, recording what was asked for. */
function diskFetch(overrides: Record<string, unknown> = {}) {
  const seen: string[] = [];
  const fetchFn = async (url: string) => {
    seen.push(url);
    const name = url.replace(/^\/data\//, '').replace(/\?.*$/, '');
    if (name in overrides) {
      const o = overrides[name];
      return typeof o === 'number' ? new Response('x', { status: o }) : new Response(JSON.stringify(o));
    }
    return existsSync(new URL(name, DIR)) ? new Response(readFileSync(new URL(name, DIR), 'utf8')) : new Response('not found', { status: 404 });
  };
  return { seen, fetchFn };
}

afterEach(() => {
  clearShardCache();
  clearAliasCache();
});

describe('index.json (schema 3)', () => {
  const index = read('index.json') as CompactIndex;
  const legacy = read('stations.json') as Dataset;

  it('decodes to the same stations as stations.json for every map field', () => {
    expect(index.schema).toBe(INDEX_SCHEMA);
    const stations = decodeIndex(index);
    expect(stations).toHaveLength(legacy.stations.length);
    const byId = new Map(legacy.stations.map((s) => [s.id, s]));
    for (const s of stations) {
      const l = byId.get(s.id)!;
      expect(l, s.id).toBeDefined();
      expect({ c1Id: s.c1Id, lat: s.lat, lng: s.lng, operator: s.operator, maxKw: s.maxKw, speed: s.speed, vehicles: s.vehicles, status: s.status, connectors: s.connectors }).toEqual({
        c1Id: l.c1Id,
        lat: l.lat,
        lng: l.lng,
        operator: l.operator,
        maxKw: l.maxKw,
        speed: l.speed,
        vehicles: l.vehicles,
        status: l.status ?? 'unknown',
        connectors: l.connectors,
      });
      expect(s.confidence).toBeCloseTo(l.confidence ?? 0, 2);
    }
  });

  it('round-trips ids, including stations without a c1 id', () => {
    for (const id of ['osm-n1', 'osm-w22', 'osm-r3', 'ocm-45', 'c1_abcdefghijkl']) expect(longId(shortId(id))).toBe(id);
    const plain: Station = { ...decodeIndex(index)[0], c1Id: undefined, id: 'ocm-7' };
    const [back] = decodeIndex(encodeIndex({ generatedAt: 'x', version: 'v', sources: [], stations: [plain] }, () => 'tdr'));
    expect(back.id).toBe('ocm-7');
    expect(back.c1Id).toBe('ocm-7');
    expect(back.shard).toBe('tdr');
  });

  it('is much smaller than stations.json', () => {
    expect(readFileSync(new URL('index.json', DIR)).length).toBeLessThan(readFileSync(new URL('stations.json', DIR)).length / 3);
  });

  it('the app loads it, not stations.json', async () => {
    const { seen, fetchFn } = diskFetch();
    const loaded = await loadDataset(fetchFn);
    expect(loaded.via).toBe('index');
    expect(seen).not.toContain('/data/stations.json');
  });
});

describe('alias buckets', () => {
  it('a bucket count keeps buckets near KEYS_PER_BUCKET and names are stable hex', () => {
    expect(bucketCount(0)).toBe(1);
    expect(bucketCount(KEYS_PER_BUCKET)).toBe(1);
    expect(bucketCount(KEYS_PER_BUCKET + 1)).toBe(2);
    expect(bucketCount(250_000)).toBe(64);
    expect(aliasBucket('osm-n1', 64)).toMatch(/^[0-9a-f]{2}$/);
    expect(aliasBucket('osm-n1', 64)).toBe(aliasBucket('osm-n1', 64));
    expect(aliasBucket('osm-n1', 1)).toBe('0');
  });

  it('resolves through at most two buckets', async () => {
    // Find a bucket count where the alias and its station land in different buckets.
    const n = [2, 4, 8, 16].find((k) => aliasBucket('ocm-1', k) !== aliasBucket('c1_x', k))!;
    const own = aliasBucket('ocm-1', n);
    const home = aliasBucket('c1_x', n);
    const files: Record<string, AliasBucket> = {
      [own]: { version: 'v', bucket: own, aliases: { 'ocm-1': 'c1_x' }, legacy: {}, cells: {} },
      [home]: { version: 'v', bucket: home, aliases: {}, legacy: { c1_x: 'osm-n1' }, cells: { c1_x: 'tdr' } },
    };
    const reads: string[] = [];
    const reader = async (name: string) => (reads.push(name), files[name] ?? { version: 'v', bucket: name, aliases: {}, legacy: {}, cells: {} });
    expect(await resolveThroughBuckets('ocm-1', n, reader)).toEqual({ c1Id: 'c1_x', legacyId: 'osm-n1', cell: 'tdr' });
    expect(reads).toEqual([own, home]);
    expect(await resolveThroughBuckets('ocm-2', n, reader)).toBeNull();
  });

  it('the app resolves a merged record’s id and a retired id from the published buckets', async () => {
    const lookup = read('cells.json') as { aliasBuckets: number };
    const index = decodeIndex(read('index.json'));
    const merged = index.find((s) => (read('stations.json') as Dataset).stations.find((l) => l.id === s.id)?.aliases?.length)!;
    const alias = (read('stations.json') as Dataset).stations.find((l) => l.id === merged.id)!.aliases![0];
    const { seen, fetchFn } = diskFetch();
    const r = await resolveAlias(alias, fetchFn);
    expect(r).toMatchObject({ c1Id: merged.c1Id, legacyId: merged.id });
    expect(seen.filter((u) => u.startsWith('/data/aliases/')).length).toBeLessThanOrEqual(2);
    expect(await resolveAlias('osm-n999999999', fetchFn)).toBeNull();
    expect(lookup.aliasBuckets).toBeGreaterThan(0);
  });

  it('no buckets on this deployment means null, and it asks again later', async () => {
    const missing = diskFetch({ 'cells.json': 404 });
    expect(await resolveAlias('ocm-1', missing.fetchFn)).toBeNull();
    await Promise.resolve();
    const { fetchFn } = diskFetch();
    const someC1 = decodeIndex(read('index.json'))[0].c1Id!;
    expect((await resolveAlias(someC1, fetchFn))?.c1Id).toBe(someC1);
  });
});

describe('charger details after a deploy', () => {
  const index = read('index.json') as CompactIndex;
  const station = decodeIndex(index)[0];

  it('reads the details from the station’s shard', async () => {
    const { fetchFn } = diskFetch();
    const s = await loadStationDetail(station, index.version, fetchFn);
    expect(s?.id).toBe(station.id);
    expect(s?.sources.length).toBeGreaterThan(0);
  });

  it('a shard that no longer lists the station re-reads index.json once and follows it', async () => {
    const moved = { ...station, shard: 'zzz' };
    const stale = { cell: 'zzz', version: 'old', stations: [] };
    const { seen, fetchFn } = diskFetch({ 'shards/zzz.json': stale });
    const s = await loadStationDetail(moved, 'old', fetchFn);
    expect(s?.id).toBe(station.id);
    expect(seen.some((u) => u.startsWith('/data/index.json?fresh='))).toBe(true);
    expect(seen.filter((u) => u.startsWith('/data/index.json')).length).toBe(1);
  });

  it('gives up (null) when the fresh index is the same version', async () => {
    const { fetchFn } = diskFetch({ [`shards/${station.shard}.json`]: { cell: station.shard, version: index.version, stations: [] } });
    expect(await loadStationDetail(station, index.version, fetchFn)).toBeNull();
  });

  it('caches shards per data version', async () => {
    const { seen, fetchFn } = diskFetch();
    await loadStationDetail(station, index.version, fetchFn);
    await loadStationDetail(station, index.version, fetchFn);
    await loadStationDetail(station, 'other', fetchFn);
    expect(seen.filter((u) => u.startsWith('/data/shards/')).length).toBe(2);
  });
});

describe('driver report statuses', () => {
  const st = (stationId: string, reports7d = 1): StationStatus => ({
    stationId,
    lastWorkedAt: null,
    lastWorkedKw: null,
    lastWorkedVehicle: null,
    inUseSince: null,
    queueAt: null,
    problemAt: null,
    problemKind: null,
    problemReports: 0,
    reports7d,
  });
  const stations = [{ id: 'osm-n1', c1Id: 'c1_aaaaaaaaaaaa', aliases: ['ocm-9'] }, { id: 'ocm-2', c1Id: 'c1_bbbbbbbbbbbb' }] as Station[];

  it('keeps the same array when a poll returns the same statuses', () => {
    const prev = [st('c1_aaaaaaaaaaaa')];
    expect(keepIfSame(prev, [st('c1_aaaaaaaaaaaa')])).toBe(prev);
    const next = [st('c1_aaaaaaaaaaaa', 2)];
    expect(keepIfSame(prev, next)).toBe(next);
  });

  it('maps c1 ids, aliases and looked-up retired ids to the app’s station ids', () => {
    const out = statusesByStation(stations, [st('c1_aaaaaaaaaaaa'), st('ocm-9', 5), st('c1_retiredxxxxx'), st('c1_unknownxxxxx')], new Map([['c1_retiredxxxxx', 'c1_bbbbbbbbbbbb'], ['c1_unknownxxxxx', null]]));
    expect([...out.keys()].sort()).toEqual(['ocm-2', 'osm-n1']);
    expect(out.get('osm-n1')?.reports7d).toBe(1); // the first status wins
    expect(out.get('ocm-2')?.stationId).toBe('ocm-2');
  });

  it('looks up only ids nobody lists, each once, at most 40', () => {
    const raw = [st('c1_aaaaaaaaaaaa'), st('ocm-9'), st('c1_retiredxxxxx'), st('c1_retiredxxxxx'), ...Array.from({ length: 60 }, (_, i) => st(`ocm-${1000 + i}`))];
    const ids = unknownStatusIds(stations, raw, new Map([['ocm-1000', null]]));
    expect(ids[0]).toBe('c1_retiredxxxxx');
    expect(ids).toHaveLength(40);
    expect(ids).not.toContain('ocm-1000');
    expect(ids).not.toContain('ocm-9');
  });
});

describe('places.json', () => {
  // Built from stations.json by scripts/import-places.ts; rebuild it whenever the stations change.
  it('matches the published stations: every charger has its town, and nothing points at a charger that is gone', () => {
    const ids = new Set((read('stations.json') as { stations: Array<{ id: string }> }).stations.map((s) => s.id));
    const places = read('places.json') as { area: Record<string, string>; near: Record<string, unknown> };
    expect([...ids].filter((id) => !places.area[id])).toEqual([]);
    expect(Object.keys(places.near).filter((id) => !ids.has(id))).toEqual([]);
  });
});
