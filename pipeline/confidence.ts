// Existence confidence: how sure we are that a charger is really there today.
//
// Each source record is a piece of evidence that decays with age (half-life THRESHOLDS.halfLifeDays)
// towards a floor: a mapped charger rarely vanishes, but an old unchecked one is worth less. Age counts
// to the source's snapshot, not to today: a record in an April export was at most "now" in April, and the
// export's own staleness is the pipeline's to fix by refreshing it. Verified observations (OSM
// check_date/survey, OCM DateLastVerified) start higher than bulk imports. A specific listing (a named
// network, typed plugs with their kW, stated operational) is extra evidence: nobody invents that. Records
// from different sources combine as independent evidence (noisy-OR), so agreement raises confidence.
// Negative statuses reduce it.
//
// Calibrated against the 2026-04-22 OCM export (1,372 DC records) so that, with the client's 0.6
// planning line: a specific listing verified within a year, or bulk-imported within about 90 days, is
// plannable; older single-source listings are not; OSM and OCM agreeing usually are.
import { THRESHOLDS } from './config.ts';
import type { Claim, SourceRecord } from './types.ts';

/** [base, floor] by kind of observation. */
const VERIFIED: [number, number] = [0.8, 0.3];
const UNVERIFIED_OSM: [number, number] = [0.65, 0.35];
const BULK: [number, number] = [0.5, 0.25];
const FLOOR = BULK[1];
/** A specific listing: mapped operator, typed connector with kW, stated operational (or mapped on OSM). */
export const SPECIFICITY = 0.35;
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

export function decay(base: number, age: number | null, floor = FLOOR): number {
  if (age === null) return floor;
  return floor + (base - floor) * 0.5 ** (age / THRESHOLDS.halfLifeDays);
}

/** Ages count to the source snapshot when it predates the build (never to a future snapshot). */
export function referenceDate(snapshotAt: string | null | undefined, now: Date): Date {
  const t = snapshotAt ? Date.parse(snapshotAt) : Number.NaN;
  return Number.isFinite(t) && t < now.getTime() ? new Date(t) : now;
}

type EvidenceInput = Pick<SourceRecord, 'source' | 'verified' | 'observedAt' | 'status'> &
  Partial<Pick<SourceRecord, 'snapshotAt' | 'operatorMethod' | 'evses' | 'stationKw'>>;

/** Mapped operator, at least one typed connector with its kW, and the source says it works (OSM never says). */
export function isSpecific(r: EvidenceInput): boolean {
  if (r.operatorMethod !== 'mapped') return false;
  if (!(r.status === 'operational' || r.source === 'osm')) return false;
  const typed = (r.evses ?? []).some((e) => e.connectors.some((c) => c.standard !== 'Other' && (c.maxKw !== null || r.stationKw != null)));
  return typed;
}

/** How much one record on its own says the charger exists (0-1). */
export function recordEvidence(r: EvidenceInput, now: Date): number {
  const [base, floor] = r.verified ? VERIFIED : r.source === 'osm' ? UNVERIFIED_OSM : BULK;
  const aged = decay(base, ageDays(r.observedAt, referenceDate(r.snapshotAt, now)), floor);
  const evidence = isSpecific(r) ? noisyOr([aged, SPECIFICITY]) : aged;
  return evidence * STATUS_FACTOR[r.status];
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
