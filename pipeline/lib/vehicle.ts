// Which vehicles a charger serves, inferred only from evidence. A charger with no evidence is
// "unknown", never "car", so a two-wheeler point is not planned as a car stop.
import type { ConnectorType } from '../../src/data/model.ts';
import type { CanonicalConnector, Tri, VehicleClass, VehicleFlags } from '../types.ts';
import { SWAP_OPERATORS, TWO_WHEELER_OPERATORS } from './operators.ts';

/** Connectors made for cars (Bharat AC-001 and DC-001 are the Indian car standards). */
export const CAR_CONNECTORS: ReadonlySet<ConnectorType> = new Set([
  'CCS2',
  'CCS1',
  'CHAdeMO',
  'Type 2',
  'Type 1',
  'GB/T DC',
  'GB/T AC',
  'Bharat AC',
  'Bharat DC',
]);

/** Above this, an untyped AC point is more than a scooter needs. Ather and most 2W points are 3.3 kW or less. */
export const TWO_WHEELER_MAX_KW = 3.3;

const TWO_WHEELER_NAME = /\bscooters?\b|two[\s-]?wheelers?|\b2\s?w\b|\be-?bikes?\b|\bbikes?\b|\bmoped|ather\s*grid/i;
const THREE_WHEELER_NAME = /rickshaw|\be-?rick|\b3\s?w\b|three[\s-]?wheeler|\be-?autos?\b/i;
const BUS_NAME = /\bbus\s*(depot|stand|charging|station)|\bdepot\b.*\bbus\b/i;
const SWAP_NAME = /\bswap(ping)?\b|battery\s*smart|e:?\s*swap/i;

export interface VehicleEvidence {
  /** Explicit source statements (OSM motorcar=yes/no, ...). Null where the source is silent. */
  explicit: VehicleFlags;
  connectors: CanonicalConnector[];
  operator: string | null;
  name: string | null;
  /** Station-level kW when connectors don't carry one. */
  stationKw: number | null;
}

export const NO_VEHICLE_FLAGS: VehicleFlags = { car: null, twoWheeler: null, threeWheeler: null, bus: null };

export function inferVehicles(e: VehicleEvidence): VehicleFlags {
  const flags: VehicleFlags = { ...e.explicit };
  const types = new Set(e.connectors.map((c) => c.standard));
  const carConnector = [...types].some((t) => CAR_CONNECTORS.has(t));
  const kws = e.connectors.map((c) => c.maxKw).filter((k): k is number => k !== null);
  if (e.stationKw !== null) kws.push(e.stationKw);
  const maxKw = kws.length ? Math.max(...kws) : null;
  const name = e.name ?? '';

  const twoWheelerOperator = e.operator !== null && TWO_WHEELER_OPERATORS.has(e.operator);
  const leccs = types.has('LECCS');
  const onlySmallSockets = types.size > 0 && [...types].every((t) => t === '3-pin socket' || t === 'LECCS');
  const lowPowerOnly = !carConnector && maxKw !== null && maxKw <= TWO_WHEELER_MAX_KW;
  // Strong: the hardware or the network only serves 2W, so a car can't use it.
  const exclusive2w = twoWheelerOperator || (leccs && !carConnector) || (lowPowerOnly && !types.has('3-pin socket'));

  if (flags.twoWheeler === null && (exclusive2w || leccs || onlySmallSockets || lowPowerOnly || TWO_WHEELER_NAME.test(name))) {
    flags.twoWheeler = true;
  }
  if (flags.threeWheeler === null && THREE_WHEELER_NAME.test(name)) flags.threeWheeler = true;
  if (flags.bus === null && BUS_NAME.test(name)) flags.bus = true;
  if (flags.car === null) {
    if (carConnector || (!exclusive2w && maxKw !== null && maxKw > TWO_WHEELER_MAX_KW)) flags.car = true;
    else if (exclusive2w) flags.car = false;
  }
  return flags;
}

export function vehicleClass(f: VehicleFlags): VehicleClass {
  const small = f.twoWheeler === true || f.threeWheeler === true;
  if (f.car === true) return small ? 'mixed' : 'car';
  if (f.twoWheeler === true) return '2w';
  if (f.threeWheeler === true) return '3w';
  // Bus-only depots stay "unknown" for car drivers; `vehicles` still lists the bus.
  return 'unknown';
}

/** Two classes that can't be the same physical charger (a scooter point and a car charger). */
export function vehicleConflict(a: VehicleClass, b: VehicleClass): boolean {
  const small = (c: VehicleClass) => c === '2w' || c === '3w';
  return (small(a) && b === 'car') || (small(b) && a === 'car');
}

export function inferSwap(operator: string | null, name: string | null, explicit: Tri = null): Tri {
  if (explicit !== null) return explicit;
  if ((operator !== null && SWAP_OPERATORS.has(operator)) || SWAP_NAME.test(name ?? '')) return true;
  return null;
}

/** Union of flags across sources: true wins, then false, then null. */
export function mergeVehicleFlags(list: VehicleFlags[]): VehicleFlags {
  const pick = (k: keyof VehicleFlags): Tri =>
    list.some((f) => f[k] === true) ? true : list.some((f) => f[k] === false) ? false : null;
  return { car: pick('car'), twoWheeler: pick('twoWheeler'), threeWheeler: pick('threeWheeler'), bus: pick('bus') };
}
