// Quality gates. Any failure stops the run before public/data is touched, so a broken download or a bad
// merge can never replace the published data. The baseline is the last published build: manifest.json
// when there is one, else the legacy stations.json.
import type { Dataset, Station } from '../src/data/model.ts';
import { PLAN_MIN_CONFIDENCE } from '../src/data/trust.ts';
import { THRESHOLDS } from './config.ts';
import { denied, strings } from './lib/denylist.ts';
import { distanceMetres } from './lib/geo.ts';
import type { CanonicalStation, FieldValue, HealthReport, SourceKey } from './types.ts';

/**
 * Licences a published value may carry: free, no card, commercial use allowed
 * (research/free-only-coverage-2026-10-23). Anything else, or no licence at all, fails the build.
 */
export const ALLOWED_LICENCES: ReadonlySet<string> = new Set(['ODbL-1.0', 'CC-BY-4.0', 'GODL-India', 'CDLA-Permissive-2.0', 'CC0-1.0', 'Apache-2.0']);

/** The licences each source may hand us. A record whose licence doesn't fit its source came from somewhere else. */
export const SOURCE_LICENCES: Readonly<Record<string, ReadonlySet<string>>> = {
  osm: new Set(['ODbL-1.0']),
  ocm: new Set(['CC-BY-4.0']),
};

const STATION_FIELDS = ['name', 'operator', 'connectors', 'maxKw', 'points', 'hours', 'price', 'access', 'address', 'website'] as const;

/**
 * Per-record and per-field provenance: every source record and every field claim must name an allowed
 * licence that fits its source (and upstream origin, when a source is an aggregate), every claim must come
 * from one of the station's own records, and no published text or URL may look copied from Google Maps or
 * PlugShare. Returns one line per problem kind with a count and the first few station ids.
 */
export function provenanceFailures(stations: CanonicalStation[], adapters: Array<{ key: string; licence: string | undefined }> = []): string[] {
  const problems = new Map<string, string[]>();
  const add = (kind: string, where: string) => {
    const list = problems.get(kind);
    if (list) list.push(where);
    else problems.set(kind, [where]);
  };
  const licenceProblem = (licence: string | null | undefined, source: string): string | null => {
    if (!licence) return 'missing licence';
    if (!ALLOWED_LICENCES.has(licence)) return `licence ${licence} not allowed`;
    if (!SOURCE_LICENCES[source]) return `source ${source} not allowed`;
    if (!SOURCE_LICENCES[source].has(licence)) return `licence ${licence} does not fit source ${source}`;
    return null;
  };

  for (const a of adapters) {
    const p = licenceProblem(a.licence, a.key);
    if (p) add(`adapter: ${p}`, a.key);
  }

  for (const s of stations) {
    const members = new Map(s.members.map((r) => [r.sourceId, r]));
    for (const r of s.members) {
      const p = licenceProblem(r.licence, r.source);
      if (p) add(`record: ${p}`, `${s.id} (${r.sourceId})`);
      if (r.origin !== undefined && (!r.origin || denied(r.origin))) add('record: origin missing or denied', `${s.id} (${r.sourceId})`);
      const texts = [r.name, r.operator, r.address, r.website, r.url, r.editUrl, r.hours, r.price, r.origin];
      if (texts.some((t) => denied(t))) add('record: Google/PlugShare text or URL', `${s.id} (${r.sourceId})`);
    }
    for (const key of STATION_FIELDS) {
      const field = s[key] as FieldValue<unknown>;
      if (strings(field.value).some((t) => denied(t))) add(`field ${key}: Google/PlugShare text or URL`, s.id);
      for (const c of field.claims) {
        const p = licenceProblem(c.licence, c.source);
        if (p) add(`claim ${key}: ${p}`, `${s.id} (${c.sourceId})`);
        const owner = members.get(c.sourceId);
        if (!owner) add(`claim ${key}: from a record the station doesn't hold`, `${s.id} (${c.sourceId})`);
        else if (owner.licence !== c.licence) add(`claim ${key}: licence differs from its record`, `${s.id} (${c.sourceId})`);
        if (strings(c.value).some((t) => denied(t))) add(`claim ${key}: Google/PlugShare text or URL`, `${s.id} (${c.sourceId})`);
      }
    }
  }
  return [...problems].map(([kind, where]) => `provenance: ${where.length} × ${kind}, first: ${where.slice(0, 3).join(', ')}`);
}

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
  /** Every file to publish under public/data, by size. */
  fileBytes?: Map<string, number>;
  /** Alias keys that are some live station's own id (outputs.ts leaves them out; any is a registry bug). */
  aliasCollisions?: string[];
  /** The canonical stations behind `stations`, for the per-record licence and denylist gate. */
  canonical?: CanonicalStation[];
  /** Each source's declared licence. */
  adapters?: Array<{ key: string; licence: string | undefined }>;
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

  // The planner only stops at chargers at or above PLAN_MIN_CONFIDENCE. Too few of those and every
  // strict plan fails, which is what a miscalibrated confidence model looks like from the outside.
  const dc = g.stations.filter((s) => s.speed === 'dc');
  const plannable = dc.filter((s) => (s.confidence ?? 0) >= PLAN_MIN_CONFIDENCE).length;
  const plannableShare = dc.length ? plannable / dc.length : 1;
  checks.push(`plannable DC (confidence >= ${PLAN_MIN_CONFIDENCE}): ${plannable} of ${dc.length} (${pct(plannableShare)})`);
  if (plannableShare < THRESHOLDS.minPlannableDcShare) {
    failures.push(`only ${pct(plannableShare)} of DC stations are plannable (limit ${pct(THRESHOLDS.minPlannableDcShare)})`);
  }

  // "Operational" with nothing to plug into is a contradiction an adapter let through.
  const empty = g.stations.filter((s) => s.status === 'operational' && s.connectors.length === 0);
  if (empty.length) failures.push(`${empty.length} operational stations list no connectors, first: ${empty.slice(0, 3).map((s) => s.id).join(', ')}`);

  if (g.canonical || g.adapters) {
    const provenance = provenanceFailures(g.canonical ?? [], g.adapters ?? []);
    failures.push(...provenance);
    checks.push(`provenance: ${g.canonical?.length ?? 0} stations, ${provenance.length ? 'FAILED' : 'every record and claim licensed, no denylisted text'}`);
  }

  if (g.aliasCollisions?.length) failures.push(`${g.aliasCollisions.length} aliases are live station ids, first: ${g.aliasCollisions.slice(0, 3).join(', ')}`);

  if (g.fileBytes) {
    for (const [name, bytes] of g.fileBytes) {
      if (bytes > THRESHOLDS.assetBytes) failures.push(`${name} is ${bytes} bytes (asset limit ${THRESHOLDS.assetBytes})`);
    }
    const largest = [...g.fileBytes].sort(([, a], [, b]) => b - a)[0];
    checks.push(`${g.fileBytes.size} data files, largest ${largest ? `${largest[0]} ${largest[1]} bytes` : 'none'}`);
    if (g.fileBytes.size > THRESHOLDS.maxDataFiles) failures.push(`${g.fileBytes.size} data files (limit ${THRESHOLDS.maxDataFiles})`);
  }
  return { ok: failures.length === 0, failures, checks };
}
