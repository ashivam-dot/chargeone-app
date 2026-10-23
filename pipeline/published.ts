// Reads a published data directory (public/data, or dist/data after a build) back into a Dataset, for the
// pipeline's baseline and the SEO prerender. stations.json is used while it is still published; past
// THRESHOLDS.legacyStationsBytes it isn't, and the stations come from index.json plus their shards.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { decodeIndex, type CompactIndex } from '../src/data/compact.ts';
import type { Dataset, Station } from '../src/data/model.ts';

const read = <T>(file: string): T => JSON.parse(readFileSync(file, 'utf8')) as T;

interface ShardFile {
  stations: Array<Station & { vehicleFlags?: unknown; batterySwapKnown?: unknown; membershipRequired?: unknown }>;
}

/**
 * The published stations, or null when the directory has none. `details` fills hours, price, address and
 * sources from the shards for index-only builds (the prerender needs them; the baseline doesn't).
 */
export function readPublishedDataset(dir: string, { details = true }: { details?: boolean } = {}): Dataset | null {
  const legacy = join(dir, 'stations.json');
  if (existsSync(legacy)) return read<Dataset>(legacy);
  const indexFile = join(dir, 'index.json');
  if (!existsSync(indexFile)) return null;
  const ix = read<CompactIndex>(indexFile);
  let stations: Station[];
  try {
    stations = decodeIndex(ix);
  } catch {
    // An index from an older schema: no baseline rather than a crash; the next build replaces it.
    return null;
  }
  if (details) {
    const byShard = new Map<string, Map<string, Station>>();
    stations = stations.map((s) => {
      if (!s.shard) return s;
      let shard = byShard.get(s.shard);
      if (!shard) {
        const file = join(dir, 'shards', `${s.shard}.json`);
        shard = new Map(existsSync(file) ? read<ShardFile>(file).stations.map((x) => [x.id, x]) : []);
        byShard.set(s.shard, shard);
      }
      const full = shard.get(s.id);
      if (!full) return s;
      const { vehicleFlags: _v, batterySwapKnown: _b, membershipRequired: _m, ...rest } = full as ShardFile['stations'][number];
      return { ...rest, shard: s.shard };
    });
  }
  return { generatedAt: ix.generatedAt, version: ix.version, sources: ix.sources ?? [], stations };
}
