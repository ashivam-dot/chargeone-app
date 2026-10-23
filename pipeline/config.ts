import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/** Raw downloads (gitignored). A worktree can point this at the main checkout's cache with PIPELINE_CACHE_DIR. */
export const CACHE_DIR = process.env.PIPELINE_CACHE_DIR ?? join(ROOT, 'data-cache');
export const OUT_DIR = process.env.PIPELINE_OUT_DIR ?? join(ROOT, 'public', 'data');
export const REGISTRY_FILE = process.env.PIPELINE_REGISTRY ?? join(ROOT, 'pipeline', 'registry.json');

/** Sent with every download so operators of public endpoints know who is calling. */
export const USER_AGENT = `ChargeOne-data-pipeline/1.0 (+${process.env.PIPELINE_CONTACT ?? 'https://chargeone.akshshivam5.workers.dev'})`;

export const THRESHOLDS = {
  /** A source losing more than this share of its records fails the run. */
  sourceDrop: 0.2,
  /** Stations moving more than `moveMetres`, as a share of matched stations. */
  movedShare: 0.05,
  moveMetres: 200,
  /** DC station count falling by more than this share. */
  dcDrop: 0.1,
  shardBytes: 1_000_000,
  shardMaxStations: 400,
  /** Entity resolution. */
  autoMerge: 0.85,
  review: 0.6,
  candidateMetres: 150,
  distanceSigmaMetres: 40,
  siteMetres: 60,
  /** Existence confidence. */
  halfLifeDays: 182,
  /** Share of DC stations at or above the planner's confidence line (src/data/trust.ts). Below it, plans fail. */
  minPlannableDcShare: 0.25,
  /** Cloudflare Workers static assets: 25 MiB per file. Kept a little under. */
  assetBytes: 24 * 1024 * 1024,
  /**
   * stations.json, the old all-in-one file, is written only while it stays this small (about 10k stations).
   * The app, the worker and the SEO build read index.json, the shards and the alias buckets instead.
   */
  legacyStationsBytes: 8 * 1024 * 1024,
  /** Files under public/data. The whole deployment may hold 20,000 (scripts/prerender.ts budgets the rest). */
  maxDataFiles: 3000,
};

export async function readJson<T>(file: string): Promise<T> {
  return JSON.parse(await readFile(file, 'utf8')) as T;
}

export async function writeJson(file: string, data: unknown, pretty = false): Promise<void> {
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, pretty ? `${JSON.stringify(data, null, 2)}\n` : JSON.stringify(data));
}

/** Returns the cached JSON unless a refresh is asked for (or there's no cache); then fetches and caches it. */
export async function cachedJson<T>(name: string, refresh: boolean, fetcher: () => Promise<T>): Promise<T> {
  const file = join(CACHE_DIR, name);
  if (!refresh && existsSync(file)) return readJson<T>(file);
  if (!refresh) throw new Error(`No cached ${name} in ${CACHE_DIR}; run with --refresh to download it`);
  const data = await fetcher();
  await writeJson(file, data);
  return data;
}
