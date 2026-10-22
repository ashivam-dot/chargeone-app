// Existence confidence: how sure we are that a charger is really there today.
//
// Each source record is a piece of evidence that decays with age (half-life THRESHOLDS.halfLifeDays)
// towards a floor: a mapped charger rarely vanishes, but an old unchecked one is worth less. Verified
// observations (OSM check_date/survey, OCM DateLastVerified) start higher than bulk imports. Records
// from different sources combine as independent evidence (noisy-OR), so agreement raises confidence.
// Negative statuses reduce it.
import { THRESHOLDS } from './config.ts';
import type { Claim, SourceRecord } from './types.ts';

const FLOOR = 0.25;
const BASE_VERIFIED = 0.7;
const BASE_UNVERIFIED_OSM = 0.65;
const BASE_BULK = 0.5;
const DAY = 86_400_000;

const STATUS_FACTOR: Record<SourceRecord['status'], number> = {
  operational: 1,
  unknown: 1,
  partly_operational: 0.85,
  temporarily_unavailable: 0.6,
};

export function ageDays(observedAt: string | null, now: Date): number | null {
  if (!observedAt) return null;
  const t = Date.parse(observedAt);
  if (!Number.isFinite(t)) return null;
  return Math.max(0, (now.getTime() - t) / DAY);
}

export function decay(base: number, age: number | null): number {
  if (age === null) return FLOOR;
  return FLOOR + (base - FLOOR) * 0.5 ** (age / THRESHOLDS.halfLifeDays);
}

/** How much one record on its own says the charger exists (0-1). */
export function recordEvidence(r: Pick<SourceRecord, 'source' | 'verified' | 'observedAt' | 'status'>, now: Date): number {
  const base = r.verified ? BASE_VERIFIED : r.source === 'osm' ? BASE_UNVERIFIED_OSM : BASE_BULK;
  return decay(base, ageDays(r.observedAt, now)) * STATUS_FACTOR[r.status];
}

export function noisyOr(values: number[]): number {
  return 1 - values.reduce((acc, v) => acc * (1 - v), 1);
}

const round2 = (n: number) => Math.round(n * 100) / 100;

/**
 * Existence confidence for a merged station. Several records from the same source are not independent
 * (one OCM bulk import duplicated twice proves little), so each source counts once, by its best record.
 */
export function existenceConfidence(members: SourceRecord[], now: Date): number {
  const best = new Map<string, number>();
  for (const r of members) best.set(r.source, Math.max(best.get(r.source) ?? 0, recordEvidence(r, now)));
  return round2(Math.min(0.99, noisyOr([...best.values()])));
}

/**
 * Confidence in one attribute value: agreeing claims support it, disagreeing claims count against it,
 * and a value guessed from a name ("inferred") is worth less than one the source states.
 */
export function fieldConfidence<T>(
  value: T,
  claims: Array<Claim<T>>,
  evidence: Map<string, number>,
  same: (a: T, b: T) => boolean = (a, b) => JSON.stringify(a) === JSON.stringify(b),
): number {
  if (claims.length === 0 || value === null) return 0;
  const weight = (c: Claim<T>) => (evidence.get(c.sourceId) ?? FLOOR) * (c.method === 'inferred' ? 0.6 : c.method === 'derived' ? 0.85 : 1);
  const support = noisyOr(claims.filter((c) => same(c.value, value)).map(weight));
  const against = noisyOr(claims.filter((c) => !same(c.value, value)).map(weight));
  return round2(support * (1 - 0.5 * against));
}
