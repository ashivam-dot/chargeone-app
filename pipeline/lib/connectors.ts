import { DC_THRESHOLD_KW, DC_TYPES, type ConnectorType } from '../../src/data/model.ts';
import type { CanonicalConnector, CanonicalEvse, PowerType, SourceKey } from '../types.ts';

const AC_TYPES: ReadonlySet<ConnectorType> = new Set(['Type 2', 'Type 1', 'GB/T AC', 'Bharat AC', '3-pin socket']);

/** The power type a connector standard implies, or null when the standard allows both (LECCS) or is unknown. */
export function impliedPowerType(standard: ConnectorType): PowerType | null {
  if (DC_TYPES.has(standard)) return 'DC';
  if (standard === '3-pin socket' || standard === 'Bharat AC') return 'AC_1_PHASE';
  return null;
}

export function roundKw(kw: number | null | undefined): number | null {
  if (kw === null || kw === undefined || !Number.isFinite(kw) || kw <= 0 || kw > 1000) return null;
  return Math.round(kw * 10) / 10;
}

const tierKey = (c: CanonicalConnector) => `${c.standard}|${c.maxKw ?? ''}`;
const byPower = (a: CanonicalConnector, b: CanonicalConnector) => (b.maxKw ?? 0) - (a.maxKw ?? 0) || a.standard.localeCompare(b.standard);

/**
 * Connectors of distinct charge points (the OCM Connections of one listing, or distinct OSM objects): the
 * same standard at the same power adds up, and each kW tier of a standard stays its own entry (2x CCS2
 * 60 kW + 2x CCS2 30 kW is not "2x CCS2 60 kW"). Every listed entry is at least one socket, so an unknown
 * quantity counts as 1 once there is more than one entry; a lone entry with no quantity stays unknown.
 */
export function sumConnectors(lists: CanonicalConnector[][]): CanonicalConnector[] {
  const groups = new Map<string, CanonicalConnector[]>();
  for (const list of lists) {
    for (const c of list) {
      const g = groups.get(tierKey(c));
      if (g) g.push(c);
      else groups.set(tierKey(c), [c]);
    }
  }
  return [...groups.values()]
    .map((g) => ({
      ...g[0],
      powerType: g.find((c) => c.powerType !== null)?.powerType ?? null,
      count: g.length === 1 ? g[0].count : g.reduce((n, c) => n + (c.count ?? 1), 0),
    }))
    .sort(byPower);
}

/** The connectors one source record lists. */
export function connectorsOf(evses: CanonicalEvse[]): CanonicalConnector[] {
  return sumConnectors(evses.map((e) => e.connectors));
}

const signature = (list: CanonicalConnector[]) => JSON.stringify(list.map((c) => [c.standard, c.maxKw, c.count, c.powerType]));

/**
 * Connectors of several records from ONE source in one station. Distinct OSM objects are distinct charge
 * points (one feature, one object), so they add up. OCM often lists one site twice; two OCM listings with the
 * very same equipment are taken as a duplicate listing and counted once, different equipment adds up.
 */
export function sourceConnectors(source: SourceKey, lists: CanonicalConnector[][]): CanonicalConnector[] {
  const nonEmpty = lists.filter((l) => l.length > 0);
  if (source === 'osm') return sumConnectors(nonEmpty);
  const distinct = new Map(nonEmpty.map((l) => [signature(l), l]));
  return sumConnectors([...distinct.values()]);
}

/**
 * Connectors of the same physical site as described by different sources (in priority order). Sources are
 * not added up: for each standard one source's description wins, the first that knows the power, else the
 * one counting the most sockets, else the first. Gaps (power type, a lone count) are filled from the others.
 */
export function mergeSourceConnectors(lists: CanonicalConnector[][]): CanonicalConnector[] {
  const standards = [...new Set(lists.flatMap((l) => l.map((c) => c.standard)))];
  const out: CanonicalConnector[] = [];
  for (const standard of standards) {
    const options = lists.map((l) => l.filter((c) => c.standard === standard)).filter((l) => l.length > 0);
    const total = (l: CanonicalConnector[]) => l.reduce((n, c) => n + (c.count ?? 0), 0);
    const best =
      options.find((l) => l.some((c) => c.maxKw !== null)) ?? [...options].sort((a, b) => total(b) - total(a))[0];
    const powerType = best.find((c) => c.powerType)?.powerType ?? options.flat().find((c) => c.powerType)?.powerType ?? null;
    const otherCount = Math.max(0, ...options.map(total)) || null;
    for (const c of best) {
      const count = best.length === 1 && c.count === null ? otherCount : c.count;
      out.push({ ...c, powerType: c.powerType ?? powerType, count });
    }
  }
  return out.sort(byPower);
}

export function maxOrNull(a: number | null, b: number | null): number | null {
  if (a === null) return b;
  if (b === null) return a;
  return Math.max(a, b);
}

export function maxKwOf(connectors: CanonicalConnector[], stationKw: number | null): number | null {
  return connectors.reduce<number | null>((acc, c) => maxOrNull(acc, c.maxKw), stationKw);
}

/**
 * DC needs a DC connector, a DC power type on a plug that can carry DC, or more than 22 kW. AC needs an AC connector, an AC power
 * type or a kW value. A connector of unknown type with no kW is no evidence at all: "unknown".
 */
export function speedOf(connectors: CanonicalConnector[], maxKw: number | null): 'dc' | 'ac' | 'unknown' {
  // A "DC" current on an AC-only plug (Type 2, Type 1, 3-pin, Bharat AC) is a data-entry slip: such a
  // plug is DC only when its power says so (above 22 kW, handled below).
  if (connectors.some((c) => DC_TYPES.has(c.standard) || (c.powerType === 'DC' && !AC_TYPES.has(c.standard)))) return 'dc';
  if (maxKw !== null && maxKw > DC_THRESHOLD_KW) return 'dc';
  if (connectors.some((c) => AC_TYPES.has(c.standard) || c.powerType === 'AC_1_PHASE' || c.powerType === 'AC_3_PHASE')) return 'ac';
  if (maxKw !== null) return 'ac';
  return 'unknown';
}

/** True when two connector lists could describe the same charger: either is empty, or they share a standard. */
export function connectorsCompatible(a: CanonicalConnector[], b: CanonicalConnector[]): boolean | null {
  const ta = a.filter((c) => c.standard !== 'Other').map((c) => c.standard);
  const tb = new Set(b.filter((c) => c.standard !== 'Other').map((c) => c.standard));
  if (ta.length === 0 || tb.size === 0) return null;
  return ta.some((t) => tb.has(t));
}
