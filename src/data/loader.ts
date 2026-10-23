// How the app reads charger data. First choice is the compact index (src/data/compact.ts): a fraction of
// stations.json to download and parse, enough for the national map, filters, search and the planner.
// A charger's details (hours, price, address, sources, per-field provenance) come from its shard, read
// only when the charger is opened. stations.json stays as the fallback for older deployments and for
// when the index can't be read. Ids the index doesn't carry (merged source records, retired c1 ids) are
// looked up in the alias buckets by src/data/aliasLookup.ts, loaded only when a link or a report names one.
//
// A deploy can land between reading index.json and opening a charger, leaving the index pointing at a
// shard that no longer holds it. A miss re-reads index.json past every cache and tries once more.
import { decodeIndex, type CompactIndex } from './compact.ts';
import type { Dataset, Station } from './model.ts';

export interface DataManifest {
  version: string;
  generatedAt: string;
  counts: Record<string, number>;
  shards: Array<{ cell: string; stations: number; bytes: number }>;
}

export interface LoadedData {
  dataset: Dataset;
  manifest: DataManifest | null;
  /** Which file the stations came from. */
  via: 'index' | 'stations';
}

export type Fetch = (input: string) => Promise<Response>;

export const getJson = async <T>(fetchFn: Fetch, url: string): Promise<T> => {
  const r = await fetchFn(url);
  if (!r.ok) throw new Error(`${url}: ${r.status}`);
  return (await r.json()) as T;
};

export async function loadDataset(fetchFn: Fetch = (u) => fetch(u)): Promise<LoadedData> {
  // The manifest is optional (counts for About); a failure there never blocks the map.
  const manifest = getJson<DataManifest>(fetchFn, '/data/manifest.json').catch(() => null);
  try {
    const ix = await getJson<CompactIndex>(fetchFn, '/data/index.json');
    const stations = decodeIndex(ix);
    if (!stations.length) throw new Error('empty index');
    return { dataset: { generatedAt: ix.generatedAt, version: ix.version, sources: ix.sources ?? [], stations }, manifest: await manifest, via: 'index' };
  } catch {
    const dataset = await getJson<Dataset>(fetchFn, '/data/stations.json');
    return { dataset, manifest: await manifest, via: 'stations' };
  }
}

interface ShardFile {
  cell: string;
  version: string;
  stations: Array<Station & { vehicleFlags?: unknown; batterySwapKnown?: unknown; membershipRequired?: unknown }>;
}

const shards = new Map<string, Promise<Map<string, Station>>>();

function loadShard(cell: string, version: string | undefined, fetchFn: Fetch): Promise<Map<string, Station>> {
  const key = `${version ?? ''}/${cell}`;
  let p = shards.get(key);
  if (!p) {
    const url = `/data/shards/${encodeURIComponent(cell)}.json${version ? `?v=${encodeURIComponent(version)}` : ''}`;
    p = getJson<ShardFile>(fetchFn, url).then((f) => new Map(f.stations.map((s) => [s.id, s])));
    // A failed read can be retried the next time the charger is opened.
    p.catch(() => shards.delete(key));
    shards.set(key, p);
  }
  return p;
}

const strip = (found: Station, shard: string): Station => {
  const { vehicleFlags: _v, batterySwapKnown: _b, membershipRequired: _m, ...rest } = found as ShardFile['stations'][number];
  return { ...rest, shard };
};

async function fromShard(station: Station, shard: string, version: string | undefined, fetchFn: Fetch): Promise<Station | null> {
  try {
    const found = (await loadShard(shard, version, fetchFn)).get(station.id);
    return found ? strip(found, shard) : null;
  } catch {
    return null;
  }
}

/** index.json past the browser and service-worker caches, for when the one in hand is out of date. */
async function freshIndex(fetchFn: Fetch): Promise<CompactIndex | null> {
  try {
    return await getJson<CompactIndex>(fetchFn, `/data/index.json?fresh=${Date.now().toString(36)}`);
  } catch {
    return null;
  }
}

/**
 * The charger with its details. Stations from stations.json already have them; one from the index gets
 * them from its shard. Returns null when the shard can't be read or no longer lists it.
 */
export async function loadStationDetail(station: Station, version?: string, fetchFn: Fetch = (u) => fetch(u)): Promise<Station | null> {
  if (station.detail !== 'pending' || !station.shard) return station;
  const first = await fromShard(station, station.shard, version, fetchFn);
  if (first) return first;
  // The shard is gone or no longer lists it: a newer build moved it. Find it in the current index, once.
  const ix = await freshIndex(fetchFn);
  if (!ix || ix.version === version) return null;
  let now: Station | undefined;
  try {
    now = decodeIndex(ix).find((s) => (station.c1Id && s.c1Id === station.c1Id) || s.id === station.id);
  } catch {
    return null;
  }
  if (!now?.shard) return null;
  return fromShard(now, now.shard, ix.version, fetchFn);
}

/** Test hook: forget shards read so far. */
export function clearShardCache(): void {
  shards.clear();
}
