import { DC_THRESHOLD_KW, DC_TYPES, type ConnectorType } from '../../src/data/model.ts';
import type { CanonicalConnector, CanonicalEvse, PowerType } from '../types.ts';

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

/** One connector per standard: highest count and power win, a known power type beats an unknown one. */
export function mergeCanonicalConnectors(lists: CanonicalConnector[][]): CanonicalConnector[] {
  const byType = new Map<ConnectorType, CanonicalConnector>();
  for (const list of lists) {
    for (const c of list) {
      const e = byType.get(c.standard);
      if (!e) {
        byType.set(c.standard, { ...c });
        continue;
      }
      e.count = maxOrNull(e.count, c.count);
      e.maxKw = maxOrNull(e.maxKw, c.maxKw);
      e.powerType ??= c.powerType;
    }
  }
  return [...byType.values()].sort((a, b) => (b.maxKw ?? 0) - (a.maxKw ?? 0) || a.standard.localeCompare(b.standard));
}

export function connectorsOf(evses: CanonicalEvse[]): CanonicalConnector[] {
  return mergeCanonicalConnectors(evses.map((e) => e.connectors));
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
 * DC needs a DC connector, a DC power type, or more than 22 kW. AC needs an AC connector, an AC power
 * type or a kW value. A connector of unknown type with no kW is no evidence at all: "unknown".
 */
export function speedOf(connectors: CanonicalConnector[], maxKw: number | null): 'dc' | 'ac' | 'unknown' {
  if (connectors.some((c) => DC_TYPES.has(c.standard) || c.powerType === 'DC')) return 'dc';
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
