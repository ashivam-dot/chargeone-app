// How much to trust a charger, and where each shown value came from.
//
// The data pipeline's `confidence` (0-1) says how sure we are the charger exists, from source agreement
// and how recently a source saw it. A driver who charged there recently is stronger evidence than any
// map edit, so a "worked" report adds to it (decaying over about a month, per the strategy's model),
// and a recent problem report overrides everything. The planner only plans stops at PLAN_MIN_CONFIDENCE
// or above. The 0.6 line is a starting guess until it's calibrated against ground checks.
import { liveState, type StationStatus } from '../shared/status.ts';
import type { DataSourceKey, DetailField, FieldClaim, SourceName, SourceRecordRef, Station } from './model.ts';

export const PLAN_MIN_CONFIDENCE = 0.6;
/** A fresh "charged fine" report on its own. */
const REPORT_EVIDENCE = 0.9;
const REPORT_HALF_LIFE_DAYS = 30;
/** Above this, a charger nobody reported recently is still "likely". */
const LIKELY = PLAN_MIN_CONFIDENCE;
/** A driver charged here within this many days: "verified working". */
const VERIFIED_DAYS = 14;
const DAY = 86_400_000;

function reportEvidence(status: StationStatus | undefined, now: Date): number {
  if (!status?.lastWorkedAt) return 0;
  const age = Math.max(0, (now.getTime() - Date.parse(status.lastWorkedAt)) / DAY);
  return REPORT_EVIDENCE * 0.5 ** (age / REPORT_HALF_LIFE_DAYS);
}

/** 0-1. Stations from older data without a confidence count as unverified (0). */
export function trustScore(station: Pick<Station, 'confidence'>, status: StationStatus | undefined, now: Date): number {
  if (liveState(status, now) === 'problem') return 0;
  const base = station.confidence ?? 0;
  const report = reportEvidence(status, now);
  return Math.round((1 - (1 - base) * (1 - report)) * 100) / 100;
}

export type TrustBadge = 'verified' | 'likely' | 'unverified' | 'broken';

export const TRUST_LABEL: Record<TrustBadge, string> = {
  verified: 'Verified working',
  likely: 'Likely working',
  unverified: 'Unverified',
  broken: 'Reported broken',
};

export function trustBadge(station: Pick<Station, 'confidence'>, status: StationStatus | undefined, now: Date): TrustBadge {
  if (liveState(status, now) === 'problem') return 'broken';
  const worked = status?.lastWorkedAt ? now.getTime() - Date.parse(status.lastWorkedAt) <= VERIFIED_DAYS * DAY : false;
  if (worked) return 'verified';
  return trustScore(station, status, now) >= LIKELY ? 'likely' : 'unverified';
}

/** The speed isn't known: no kW and no connector that says DC or AC. */
export function speedUnknown(s: Pick<Station, 'speed' | 'maxKw'>): boolean {
  return s.speed === 'unknown' && s.maxKw === null;
}

const SOURCE_NAME: Record<DataSourceKey, SourceName> = { osm: 'OpenStreetMap', ocm: 'Open Charge Map', tgredco: 'Telangana Open Data (TGREDCO)', overture: 'Overture Maps Places' };
const SOURCE_KEY = Object.fromEntries(Object.entries(SOURCE_NAME).map(([k, v]) => [v, k])) as Record<SourceName, DataSourceKey>;

const monthYear = (iso: string) => new Date(iso).toLocaleDateString('en-IN', { month: 'short', year: 'numeric' });

/** A source date within this many days counts as "recently" seen. */
const RECENT_SOURCE_DAYS = 90;

/** The map sources behind a station, by name. */
function sourceNames(station: Station): string {
  const names = new Set<string>(station.sources.map((s) => s.name));
  for (const r of station.records ?? []) names.add(SOURCE_NAME[r.source]);
  return [...names].join(' and ') || 'the map sources';
}

/** The newest date a source saw the station, if any is valid. */
function lastSeen(station: Station): string | null {
  const dates = [station.observedAt, ...station.sources.map((s) => s.updated), ...(station.records ?? []).map((r) => r.observedAt)].filter(
    (d): d is string => Boolean(d) && Number.isFinite(Date.parse(d!)),
  );
  return dates.sort((a, b) => Date.parse(a) - Date.parse(b)).at(-1) ?? null;
}

/** One line on why the badge says what it says. */
export function trustReason(station: Station, status: StationStatus | undefined, now: Date): string {
  const badge = trustBadge(station, status, now);
  if (badge === 'broken') return 'A driver reported a problem in the last 24 hours.';
  if (badge === 'verified') return 'A driver charged here in the last two weeks.';
  const flags = new Set(station.flags ?? []);
  if (flags.has('ocm-status-30') || station.status === 'temporarily_unavailable') return 'A source lists it as temporarily unavailable.';
  // The flags say more than the score: a bulk import or an edit date is no sign anyone checked the charger.
  if (flags.has('location-only')) {
    const seen = lastSeen(station);
    return `Only in ${sourceNames(station)}${seen ? ` (${monthYear(seen)})` : ''}, which gives the place but no plugs or status. Unverified: confirm before you rely on it.`;
  }
  if (flags.has('bulk-unverified')) return 'Added in a bulk import and never checked since. It may not exist or work.';
  const seen = lastSeen(station);
  const by = sourceNames(station);
  if (flags.has('edit-date-only')) {
    return `Listed by ${by}${seen ? ` (last edited ${monthYear(seen)})` : ''}; the date is only an edit, and no driver has reported it recently.`;
  }
  if (badge === 'likely') {
    const what = station.operator && station.connectors.length ? 'with operator and plug details ' : '';
    if (!seen) return `Listed ${what}by ${by} (date not given); no recent driver report.`;
    const ageDays = (now.getTime() - Date.parse(seen)) / DAY;
    if (ageDays <= RECENT_SOURCE_DAYS) return `Recently seen by ${by} (${monthYear(seen)}), but no recent driver report.`;
    return `Listed ${what}by ${by} (last seen ${monthYear(seen)}); no recent driver report.`;
  }
  return 'No recent check by the map sources or drivers. Confirm before you rely on it.';
}

function describe(source: DataSourceKey, observedAt: string | null, verified: boolean | null, method: FieldClaim['method'] = 'mapped'): string {
  const name = SOURCE_NAME[source];
  const valid = observedAt && Number.isFinite(Date.parse(observedAt));
  if (method === 'inferred') return `Guessed from the name on ${name}`;
  const prefix = method === 'derived' ? `Worked out from ${name}` : `From ${name}`;
  if (!valid) return `${prefix}, date not given`;
  if (verified) return `${prefix}, verified ${monthYear(observedAt)}`;
  if (source === 'osm') return `${prefix}, edited ${new Date(observedAt).getFullYear()}`;
  return `${prefix}, listed ${monthYear(observedAt)}`;
}

function sourceOfLegacyRef(station: Station): { source: DataSourceKey; observedAt: string | null } | null {
  // stations.json only: one source supplies every field unless the station was merged.
  if (station.sources.length !== 1) return null;
  const s = station.sources[0];
  return { source: SOURCE_KEY[s.name] ?? 'ocm', observedAt: s.updated ?? null };
}

/**
 * Where a field's value came from and how old it is ("From Open Charge Map, verified Mar 2026"), or
 * null when the value is unknown or its source can't be told.
 */
export function fieldSource(station: Station, field: DetailField): string | null {
  const f = station.fields?.[field];
  if (f) {
    const empty = f.value === null || (Array.isArray(f.value) && f.value.length === 0);
    const claim = f.claims[0];
    if (empty || !claim) return null;
    const record: SourceRecordRef | undefined = station.records?.find((r) => r.sourceId === claim.sourceId);
    const label = describe(claim.source, claim.observedAt, record ? record.verified : null, claim.method);
    const same = JSON.stringify(f.value);
    const other = f.claims.filter((c) => c.source !== claim.source);
    const agree = new Set(other.filter((c) => JSON.stringify(c.value) === same).map((c) => SOURCE_NAME[c.source]));
    const differ = new Set(other.filter((c) => JSON.stringify(c.value) !== same).map((c) => SOURCE_NAME[c.source]));
    const extra = [...agree].map((n) => `${n} agrees`).concat([...differ].filter((n) => !agree.has(n)).map((n) => `${n} says otherwise`));
    return extra.length ? `${label} (${extra.join(', ')})` : label;
  }
  const one = sourceOfLegacyRef(station);
  if (!one) return null;
  const flags = new Set(station.flags ?? []);
  const verified = !(flags.has('edit-date-only') || flags.has('bulk-unverified'));
  return describe(one.source, one.observedAt, station.flags ? verified : null);
}

/** "Reported 2 h ago": the age of the newest driver report, if any. */
export function reportAge(status: StationStatus | undefined, now: Date): string | null {
  const times = [status?.lastWorkedAt, status?.problemAt, status?.inUseSince, status?.queueAt].filter((t): t is string => Boolean(t));
  if (!times.length) return null;
  const newest = times.sort().at(-1)!;
  const mins = Math.max(0, Math.round((now.getTime() - Date.parse(newest)) / 60_000));
  if (mins < 60) return `Reported ${mins < 1 ? 'just now' : `${mins} min ago`}`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `Reported ${hours} h ago`;
  const days = Math.round(hours / 24);
  return `Reported ${days} day${days === 1 ? '' : 's'} ago`;
}
