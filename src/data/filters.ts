import type { ConnectorType, Station, Vehicle } from './model.ts';

export interface Filters {
  dcOnly: boolean;
  open24x7: boolean;
  connectors: ConnectorType[];
  operator: string | null;
  vehicle: Vehicle | null;
  minKw: number;
}

export const EMPTY_FILTERS: Filters = {
  dcOnly: false,
  open24x7: false,
  connectors: [],
  operator: null,
  vehicle: null,
  minKw: 0,
};

export function activeFilterCount(f: Filters): number {
  return (
    Number(f.dcOnly) +
    Number(f.open24x7) +
    f.connectors.length +
    Number(f.operator !== null) +
    Number(f.vehicle !== null) +
    Number(f.minKw > 0)
  );
}

/**
 * Stations with unknown data are kept unless a filter needs that data, so the map doesn't
 * hide chargers just because nobody has tagged them yet.
 */
export function matchesFilters(s: Station, f: Filters): boolean {
  if (f.dcOnly && s.speed !== 'dc') return false;
  if (f.open24x7 && !s.is24x7) return false;
  if (f.operator !== null && s.operator !== f.operator) return false;
  if (f.minKw > 0 && (s.maxKw === null || s.maxKw < f.minKw)) return false;
  if (f.connectors.length > 0 && !s.connectors.some((c) => f.connectors.includes(c.type))) return false;
  if (f.vehicle !== null && s.vehicles.length > 0 && !s.vehicles.includes(f.vehicle)) return false;
  return true;
}

export function filterStations(stations: Station[], f: Filters): Station[] {
  return activeFilterCount(f) === 0 ? stations : stations.filter((s) => matchesFilters(s, f));
}

export function operatorsByCount(stations: Station[]): Array<{ name: string; count: number }> {
  const counts = new Map<string, number>();
  for (const s of stations) {
    if (s.operator) counts.set(s.operator, (counts.get(s.operator) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
}
