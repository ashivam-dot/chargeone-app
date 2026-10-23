// Id lookups without one big file, shared by the pipeline (writes), the worker and the app (read).
//
// - cells.json: the data version, the shard cells and how many alias buckets there are. A few KB at any
//   size, so a cold worker reads it in well under a millisecond.
// - aliases/<bucket>.json: one bucket of a hash split of every id. `aliases` maps a legacy osm-/ocm- id or
//   a retired c1_ id to the current c1_ id; `legacy` and `cells` map a current c1_ id to the id the app
//   uses and its cell. Each key sits in the bucket of its own hash, so any lookup reads one or two buckets.

export const LOOKUP_SCHEMA = 1;

export interface LookupFile {
  version: string;
  schema: typeof LOOKUP_SCHEMA;
  /** Number of alias buckets (a power of two); `aliasBucket` names a key's bucket. */
  aliasBuckets: number;
  /** Shard and cell-file names, sorted. */
  cells: string[];
}

export interface AliasBucket {
  version: string;
  bucket: string;
  aliases: Record<string, string>;
  legacy: Record<string, string>;
  cells: Record<string, string>;
}

/** About this many keys per bucket: a bucket stays a few hundred KB at 100k stations. */
export const KEYS_PER_BUCKET = 4000;

export function bucketCount(keys: number): number {
  let n = 1;
  while (n * KEYS_PER_BUCKET < keys && n < 4096) n *= 2;
  return n;
}

/** FNV-1a over the id: cheap, stable and the same in Node, workers and browsers. */
export function aliasBucket(id: string, buckets: number): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < id.length; i++) {
    h ^= id.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  const width = Math.max(1, Math.ceil(Math.log2(buckets) / 4));
  return ((h >>> 0) % buckets).toString(16).padStart(width, '0');
}

export interface ResolvedId {
  c1Id: string;
  /** The id the app keys this station by. */
  legacyId: string;
  cell: string;
}

/**
 * The current station for any id, reading at most two buckets: the id's own (alias -> c1) and the
 * c1 id's (legacy id and cell). Null when no station has it.
 */
export async function resolveThroughBuckets(id: string, buckets: number, read: (bucket: string) => Promise<AliasBucket | null>): Promise<ResolvedId | null> {
  const own = await read(aliasBucket(id, buckets));
  if (!own) return null;
  const c1 = own.aliases[id] ?? id;
  const home = aliasBucket(c1, buckets) === own.bucket ? own : await read(aliasBucket(c1, buckets));
  const cell = home?.cells[c1];
  if (!home || !cell) return null;
  return { c1Id: c1, legacyId: home.legacy[c1] ?? c1, cell };
}
