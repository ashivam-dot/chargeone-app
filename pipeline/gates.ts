// Quality gates. Any failure stops the run before public/data is touched, so a broken download or a bad
// merge can never replace the published data. The baseline is the last published build: manifest.json
// when there is one, else the legacy stations.json.
import type { Dataset, Station } from '../src/data/model.ts';
import { THRESHOLDS } from './config.ts';
import { distanceMetres } from './lib/geo.ts';
import type { HealthReport, SourceKey } from './types.ts';

export interface Baseline {
  /** Records per source in the last build (after adapter filtering). */
  sourceRecords: Partial<Record<SourceKey, number>>;
  dc: number;
  stations: Station[];
}

const SOURCE_KEY: Record<string, SourceKey> = { OpenStreetMap: 'osm', 'Open Charge Map': 'ocm' };

/** Baseline from the published files. `manifest` wins for source counts; positions and DC come from stations.json. */
export function baselineFrom(dataset: Dataset | null, manifest: { sources: Array<{ key: SourceKey; records: number }> } | null): Baseline | null {
  if (!dataset) return null;
  const sourceRecords: Baseline['sourceRecords'] = {};
  if (manifest) for (const s of manifest.sources) sourceRecords[s.key] = s.records;
  else for (const s of dataset.sources) if (SOURCE_KEY[s.name]) sourceRecords[SOURCE_KEY[s.name]] = s.count;
  return { sourceRecords, dc: dataset.stations.filter((s) => s.speed === 'dc').length, stations: dataset.stations };
}

export interface GateInput {
  baseline: Baseline | null;
  health: Partial<Record<SourceKey, HealthReport>>;
  sourceRecords: Partial<Record<SourceKey, number>>;
  stations: Station[];
  schemaErrors: string[];
  shardBytes: Map<string, number>;
}

export interface GateResult {
  ok: boolean;
  failures: string[];
  checks: string[];
}

export function runGates(g: GateInput): GateResult {
  const failures: string[] = [];
  const checks: string[] = [];
  const pct = (n: number) => `${(n * 100).toFixed(1)}%`;

  for (const [key, h] of Object.entries(g.health)) {
    if (!h.ok) failures.push(`${key} health: ${h.problems.join('; ')}`);
  }

  if (g.baseline) {
    for (const [key, before] of Object.entries(g.baseline.sourceRecords) as Array<[SourceKey, number]>) {
      const now = g.sourceRecords[key];
      if (now === undefined) {
        failures.push(`${key}: missing from this run (had ${before} records)`);
        continue;
      }
      const drop = before > 0 ? (before - now) / before : 0;
      checks.push(`${key}: ${before} -> ${now} records`);
      if (drop > THRESHOLDS.sourceDrop) failures.push(`${key} dropped ${pct(drop)} (${before} -> ${now}; limit ${pct(THRESHOLDS.sourceDrop)})`);
    }

    const dcNow = g.stations.filter((s) => s.speed === 'dc').length;
    const dcDrop = g.baseline.dc > 0 ? (g.baseline.dc - dcNow) / g.baseline.dc : 0;
    checks.push(`DC stations: ${g.baseline.dc} -> ${dcNow}`);
    if (dcDrop > THRESHOLDS.dcDrop) failures.push(`DC stations dropped ${pct(dcDrop)} (${g.baseline.dc} -> ${dcNow})`);

    const byId = new Map<string, Station>();
    for (const s of g.stations) for (const id of [s.id, ...(s.aliases ?? [])]) byId.set(id, s);
    let matched = 0;
    let moved = 0;
    for (const prev of g.baseline.stations) {
      const now = byId.get(prev.id);
      if (!now) continue;
      matched++;
      if (distanceMetres(prev, now) > THRESHOLDS.moveMetres) moved++;
    }
    const share = matched ? moved / matched : 0;
    checks.push(`moved >${THRESHOLDS.moveMetres} m: ${moved} of ${matched} matched stations`);
    if (share > THRESHOLDS.movedShare) failures.push(`${pct(share)} of stations moved more than ${THRESHOLDS.moveMetres} m (limit ${pct(THRESHOLDS.movedShare)})`);
  } else {
    checks.push('no baseline: first build');
  }

  if (g.schemaErrors.length) failures.push(`schema: ${g.schemaErrors.length} errors, first: ${g.schemaErrors.slice(0, 3).join(' | ')}`);
  for (const [cell, bytes] of g.shardBytes) {
    if (bytes > THRESHOLDS.shardBytes) failures.push(`shard ${cell} is ${bytes} bytes (limit ${THRESHOLDS.shardBytes})`);
  }
  checks.push(`${g.shardBytes.size} shards, largest ${Math.max(0, ...g.shardBytes.values())} bytes`);
  return { ok: failures.length === 0, failures, checks };
}
