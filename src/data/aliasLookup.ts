// Ids the index doesn't list (a merged source record, a retired c1 id), resolved through the alias
// buckets. Its own chunk: the app imports it only when a link or a report names such an id.
import { getJson, type Fetch } from './loader.ts';
import { resolveThroughBuckets, type AliasBucket, type LookupFile, type ResolvedId } from './lookup.ts';

let lookupFile: Promise<LookupFile | null> | null = null;
const buckets = new Map<string, Promise<AliasBucket | null>>();

/**
 * The current station for an id the index doesn't list (a merged source record or a retired c1 id), from
 * the alias buckets. Null when nobody has it or the deployment has no buckets.
 */
export async function resolveAlias(id: string, fetchFn: Fetch = (u) => fetch(u)): Promise<ResolvedId | null> {
  if (!lookupFile) {
    lookupFile = getJson<LookupFile>(fetchFn, '/data/cells.json').catch(() => null);
    void lookupFile.then((f) => {
      if (!f) lookupFile = null;
    });
  }
  const file = await lookupFile;
  if (!file) return null;
  const read = (name: string) => {
    const key = `${file.version}/${name}`;
    let p = buckets.get(key);
    if (!p) {
      p = getJson<AliasBucket>(fetchFn, `/data/aliases/${encodeURIComponent(name)}.json?v=${encodeURIComponent(file.version)}`).catch(() => {
        buckets.delete(key);
        return null;
      });
      buckets.set(key, p);
    }
    return p;
  };
  try {
    return await resolveThroughBuckets(id, file.aliasBuckets, read);
  } catch {
    return null;
  }
}

/** Test hook: forget the lookup file and alias buckets read so far. */
export function clearAliasCache(): void {
  buckets.clear();
  lookupFile = null;
}
