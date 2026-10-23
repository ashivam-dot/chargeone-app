import type { ConnectorType, Station, Vehicle } from './model.ts';

export interface Filters {
  dcOnly: boolean;
  open24x7: boolean;
  connectors: ConnectorType[];
  operator: string | null;
  vehicle: Vehicle | null;
  minKw: number;
  /** Also show chargers only for a business's customers or residents. */
  showRestricted: boolean;
}

/** No filtering at all: every station passes. */
export const EMPTY_FILTERS: Filters = {
  dcOnly: false,
  open24x7: false,
  connectors: [],
  operator: null,
  vehicle: null,
  minKw: 0,
  showRestricted: true,
};

/** What the map starts with: chargers open to the public (or not known to be closed). */
export const DEFAULT_FILTERS: Filters = { ...EMPTY_FILTERS, showRestricted: false };

/** Plugs drivers pick from, with the names Indian chargers use. */
export const CONNECTOR_OPTIONS: Array<{ type: ConnectorType; label: string }> = [
  { type: 'CCS2', label: 'CCS2' },
  { type: 'Type 2', label: 'Type 2' },
  { type: 'CHAdeMO', label: 'CHAdeMO' },
  { type: 'Bharat DC', label: 'Bharat DC-001' },
  { type: 'Bharat AC', label: 'Bharat AC-001' },
  { type: '3-pin socket', label: '15 A socket' },
];

/** Filters the user chose (the customers-only toggle is a setting, not a filter). */
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

/** Only for a vehicle type other than `v`: we know who it's for, and it isn't them. */
function onlyForOthers(s: Station, v: Vehicle): boolean {
  if (s.vehicleClass && s.vehicleClass !== 'unknown') {
    if (s.vehicleClass === 'mixed') return false;
    return s.vehicleClass !== v;
  }
  return s.vehicles.length > 0 && !s.vehicles.includes(v);
}

/** ChargeOne is for electric cars: chargers known to be only for 2-wheelers, 3-wheelers or buses are left out everywhere. */
export function forCars(stations: Station[]): Station[] {
  return stations.filter((s) => !onlyForOthers(s, 'car'));
}

/**
 * Stations with unknown data are kept unless a filter needs that data, so the map doesn't
 * hide chargers just because nobody has tagged them yet.
 */
export function matchesFilters(s: Station, f: Filters): boolean {
  if (!f.showRestricted && s.access === 'customers') return false;
  if (f.dcOnly && s.speed !== 'dc') return false;
  if (f.open24x7 && !s.is24x7) return false;
  if (f.operator !== null && s.operator !== f.operator) return false;
  if (f.minKw > 0 && (s.maxKw === null || s.maxKw < f.minKw)) return false;
  if (f.connectors.length > 0 && !s.connectors.some((c) => f.connectors.includes(c.type))) return false;
  if (f.vehicle !== null && s.vehicles.length > 0 && !s.vehicles.includes(f.vehicle)) return false;
  return true;
}

export function filterStations(stations: Station[], f: Filters): Station[] {
  return activeFilterCount(f) === 0 && f.showRestricted ? stations : stations.filter((s) => matchesFilters(s, f));
}

/** Stations the customers-only setting hides among those the other filters keep, so the count can say so. */
export function hiddenBySettings(stations: Station[], f: Filters): number {
  const relaxed: Filters = { ...f, showRestricted: true };
  return filterStations(stations, relaxed).length - filterStations(stations, f).length;
}

/** The filters with the customers-only setting opened up: "show the hidden ones". */
export function showHidden<F extends Filters>(f: F): F {
  return { ...f, showRestricted: true };
}

/**
 * The filters loosened only as far as `s` needs to pass them: a charger picked from search that a filter
 * hides opens without wiping the rest. The customers-only setting opens (showHidden), every other filter is cleared only if this station fails it.
 */
export function relaxToShow<F extends Filters>(s: Station, f: F): F {
  let out: F = f;
  const fails = (k: Partial<Filters>) => !matchesFilters(s, { ...EMPTY_FILTERS, ...k });
  if (fails({ showRestricted: f.showRestricted })) out = showHidden(out);
  if (f.dcOnly && fails({ dcOnly: true })) out = { ...out, dcOnly: false };
  if (f.open24x7 && fails({ open24x7: true })) out = { ...out, open24x7: false };
  if (f.operator !== null && fails({ operator: f.operator })) out = { ...out, operator: null };
  if (f.minKw > 0 && fails({ minKw: f.minKw })) out = { ...out, minKw: 0 };
  if (f.connectors.length > 0 && fails({ connectors: f.connectors })) out = { ...out, connectors: [] };
  if (f.vehicle !== null && fails({ vehicle: f.vehicle })) out = { ...out, vehicle: null };
  return out;
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
