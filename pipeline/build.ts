// ChargeOne data pipeline: sources -> canonical records -> entity resolution -> stable ids -> gates ->
// public/data. See pipeline/README.md.
//
// Usage: npm run data:build [-- --refresh[=osm,ocm]] [-- --dry-run]
//   (default)        rebuild from data-cache, no network
//   --refresh        re-download every source (Overpass, OCM export pull / API), falling back to the cache
//   --refresh=osm    re-download only the named sources
//   --dry-run        run every gate, write nothing
// Env: OCM_API_KEY (use the OCM API instead of the GitHub export), PIPELINE_OSM_SOURCE=geofabrik (CI),
//      PIPELINE_CACHE_DIR, PIPELINE_OUT_DIR, PIPELINE_REGISTRY, PIPELINE_NOW (ISO date, for reproducible runs).
import { existsSync } from 'node:fs';
import { mkdir, readdir, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { Dataset } from '../src/data/model.ts';
import { geofabrikAdapter } from './adapters/geofabrik.ts';
import { ocmApiAdapter, ocmApiKey } from './adapters/ocm-api.ts';
import { ocmExportAdapter } from './adapters/ocm-export.ts';
import { osmAdapter } from './adapters/osm.ts';
import { overtureAdapter } from './adapters/overture.ts';
import { tgredcoAdapter } from './adapters/tgredco.ts';
import { CACHE_DIR, OUT_DIR, readJson, REGISTRY_FILE, writeJson } from './config.ts';
import { baselineFrom, runGates } from './gates.ts';
import { emptyRegistry, serializeRegistry, type Registry } from './ids.ts';
import { stateShapes, type StateShape } from './lib/geo.ts';
import { canonicalState } from './lib/states.ts';
import { buildOutputs, type Manifest, type SourceRun } from './outputs.ts';
import { readPublishedDataset } from './published.ts';
import { validateStations } from './schema.ts';
import { buildStations } from './stations.ts';
import type { Adapter, HealthReport, SourceKey, SourceRecord } from './types.ts';

const BOUNDARIES = join(CACHE_DIR, 'boundaries', 'IND-ADM1_simplified.geojson');

function parseArgs(argv: string[]) {
  const refresh = new Set<SourceKey>();
  let dryRun = false;
  for (const a of argv) {
    if (a === '--refresh') (['osm', 'ocm', 'tgredco'] as const).forEach((k) => refresh.add(k));
    else if (a.startsWith('--refresh=')) for (const k of a.slice(10).split(',')) refresh.add(k.trim() as SourceKey);
    else if (a === '--dry-run') dryRun = true;
    else throw new Error(`Unknown option ${a}`);
  }
  return { refresh, dryRun };
}

function chooseAdapters(): Array<{ adapter: Adapter<unknown>; origin: string }> {
  const osm = process.env.PIPELINE_OSM_SOURCE === 'geofabrik' ? geofabrikAdapter : osmAdapter;
  const ocm = ocmApiKey() || existsSync(join(CACHE_DIR, 'ocm-api.json')) ? ocmApiAdapter : ocmExportAdapter;
  return [
    { adapter: osm as Adapter<unknown>, origin: osm === geofabrikAdapter ? 'geofabrik' : 'overpass' },
    { adapter: ocm as Adapter<unknown>, origin: ocm === ocmApiAdapter ? 'api' : 'github-export' },
    { adapter: tgredcoAdapter as Adapter<unknown>, origin: 'data.telangana.gov.in' },
    { adapter: overtureAdapter as Adapter<unknown>, origin: 'overturemaps-us-west-2 (anonymous S3)' },
  ];
}

async function loadShapes(): Promise<StateShape[] | undefined> {
  if (!existsSync(BOUNDARIES)) {
    console.warn(`  no state boundaries at ${BOUNDARIES}; states come from source addresses only`);
    return undefined;
  }
  const geo = await readJson<{ features: Array<{ properties: Record<string, unknown>; geometry: unknown }> }>(BOUNDARIES);
  return stateShapes(geo as never, (p) => {
    const raw = String(p.shapeName ?? p.name ?? '');
    return canonicalState(raw) ?? raw;
  });
}

async function maybeJson<T>(file: string): Promise<T | null> {
  return existsSync(file) ? readJson<T>(file) : null;
}

export async function main(argv = process.argv.slice(2)): Promise<number> {
  const { refresh, dryRun } = parseArgs(argv);
  const now = process.env.PIPELINE_NOW ? new Date(process.env.PIPELINE_NOW) : new Date();
  console.log(`ChargeOne data pipeline (cache ${CACHE_DIR}, out ${OUT_DIR})`);

  const runs: SourceRun[] = [];
  const health: Partial<Record<SourceKey, HealthReport>> = {};
  for (const { adapter, origin } of chooseAdapters()) {
    console.log(`${adapter.name}`);
    const raw = await adapter.fetchRaw({ refresh: refresh.has(adapter.key) });
    const result = adapter.toCanonical(raw);
    health[adapter.key] = adapter.health(result);
    const reasons = new Map<string, number>();
    for (const r of result.rejected) reasons.set(r.reason, (reasons.get(r.reason) ?? 0) + 1);
    console.log(
      `  ${result.rawCount} raw -> ${result.records.length} records; rejected ${[...reasons].map(([k, n]) => `${k} ${n}`).join(', ') || 'none'}; snapshot ${result.snapshotAt ?? 'unknown'}`,
    );
    runs.push({ adapter, result, origin });
  }

  const records: SourceRecord[] = runs.flatMap((r) => r.result.records);
  const registry = (await maybeJson<Registry>(REGISTRY_FILE)) ?? emptyRegistry();
  // The last published build: stations.json while it's small enough to ship, else index.json and shards.
  const previous: Dataset | null = readPublishedDataset(OUT_DIR, { details: false });
  const previousManifest = await maybeJson<Manifest>(join(OUT_DIR, 'manifest.json'));
  const layer = buildStations(records, {
    registry,
    now,
    previousLegacy: new Set(previous?.stations.map((s) => s.id) ?? []),
    shapes: await loadShapes(),
  });
  const built = buildOutputs({
    stations: layer.stations,
    sites: layer.sites,
    review: layer.review,
    sources: runs,
    merged: layer.merged,
    blocked: layer.blocked,
    generatedAt: now.toISOString(),
  });

  const gates = runGates({
    baseline: baselineFrom(previous, previousManifest),
    health,
    sourceRecords: Object.fromEntries(runs.map((r) => [r.adapter.key, r.result.records.length])),
    stations: built.dataset.stations,
    schemaErrors: validateStations(built.dataset.stations),
    shardBytes: built.shardBytes,
    fileBytes: new Map([...built.files].map(([name, b]) => [name, b.length])),
    aliasCollisions: built.aliasCollisions,
    canonical: layer.stations,
    adapters: runs.map((r) => ({ key: r.adapter.key, licence: r.adapter.licence.id })),
  });
  for (const c of gates.checks) console.log(`  check: ${c}`);
  const m = built.manifest.counts;
  console.log(
    `Stations ${m.stations} (DC ${m.dc}, AC ${m.ac}, unknown ${m.unknownSpeed}) · with kW ${m.withKw} · with connectors ${m.withConnectors} · ` +
      `multi-source ${m.multiSource} · merged ${m.merged} · listed duplicates dropped ${layer.listedDuplicates} · review ${m.review} · quarantined ${m.quarantined} · sites ${m.sites}`,
  );
  if (!gates.ok) {
    for (const f of gates.failures) console.error(`  GATE FAILED: ${f}`);
    console.error('Nothing published.');
    return 1;
  }
  if (dryRun) {
    console.log('Dry run: gates passed, nothing written.');
    return 0;
  }

  for (const sub of ['shards', 'cells', 'aliases']) {
    const dir = join(OUT_DIR, sub);
    if (existsSync(dir)) for (const f of await readdir(dir)) await rm(join(dir, f));
  }
  // Files this build no longer writes: stations.json past its size limit, the old single aliases.json,
  // ODbL parts from a bigger build.
  for (const f of await readdir(OUT_DIR)) {
    const stale = f === 'stations.json' || f === 'aliases.json' || /^chargeone-stations-odbl(-\d+)?\.zip$/.test(f);
    if (stale && !built.files.has(f)) await rm(join(OUT_DIR, f));
  }
  for (const [name, bytes] of built.files) {
    const file = join(OUT_DIR, name);
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, bytes);
  }
  await writeJson(REGISTRY_FILE, serializeRegistry(registry), true);
  // Quarantined ids stay in the gitignored cache for review; they never ship.
  await writeJson(
    join(CACHE_DIR, 'quarantine.json'),
    runs.flatMap((r) => r.result.rejected.filter((x) => x.quarantine)),
    true,
  );
  console.log(`Published ${built.files.size} files (version ${built.manifest.version}) to ${OUT_DIR}`);
  return 0;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().then(
    (code) => process.exit(code),
    (err: unknown) => {
      console.error(err);
      process.exit(1);
    },
  );
}
