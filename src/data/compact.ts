// The compact formats the app and the worker read instead of the whole stations.json:
//
// - index.json: one column per field (schema 3), enough to draw the national map, filter, search and plan.
//   Repeated strings (operators, connector types, states, statuses, cells) are stored once and referenced
//   by position. Details (hours, price, address, sources, per-field provenance) live in the shards.
// - cells/<geohash>.json: the same stations split by the shard cells, in a tiny self-contained row form,
//   so the worker can answer "chargers near here" by reading only the cells around a point.
//
// The pipeline writes both with encodeIndex/encodeCell; the app and worker read them with the decoders.
import type { ConnectorType, Dataset, DatasetSource, Speed, Station, Vehicle } from './model.ts';

export const INDEX_SCHEMA = 3;

/** [type index, count, kW]. */
export type CompactConnector = [number, number | null, number | null];

/**
 * One array per field, row i of each being station i (schema 3). Columns pack far better than one array
 * per row: no per-row brackets, small integer codes for every enumerated value, ids without their
 * common prefixes and the shard as a position in `cells`. About half the bytes of schema 2.
 */
export interface IndexColumns {
  /** Legacy id, shortened: `n123`/`w123`/`r123` are osm-n123..., bare digits are ocm-<digits>. */
  id: string[];
  /** c1 id without `c1_` (a station with no c1 id keeps its own id). */
  c1: string[];
  lat: number[];
  lng: number[];
  /** Position in `speeds`. */
  speed: number[];
  maxKw: Array<number | null>;
  /** Position in `operators`. */
  operator: Array<number | null>;
  /** Position in `vehicleClasses`. */
  vehicleClass: number[];
  /** Existence confidence in hundredths. */
  confidence: number[];
  /** Position in `cells`: the shard holding the station's details. */
  shard: number[];
  name: string[];
  connectors: CompactConnector[][];
  points: Array<number | null>;
  /** Bit mask of VEHICLE_BITS. */
  vehicles: number[];
  batterySwap: Array<0 | 1>;
  /** 1 open 24x7, 0 not, null unknown. */
  is24x7: Array<0 | 1 | null>;
  access: number[];
  status: number[];
  state: Array<number | null>;
  /** Bit mask over `flags`. */
  flags: number[];
}

export interface CompactIndex {
  version: string;
  schema: typeof INDEX_SCHEMA;
  generatedAt: string;
  sources: DatasetSource[];
  operators: string[];
  connectorTypes: ConnectorType[];
  speeds: Speed[];
  vehicleClasses: NonNullable<Station['vehicleClass']>[];
  access: Station['access'][];
  statuses: NonNullable<Station['status']>[];
  states: string[];
  flags: string[];
  cells: string[];
  count: number;
  columns: IndexColumns;
}

export const VEHICLE_BITS: Record<Vehicle, number> = { car: 1, '2w': 2, '3w': 4, bus: 8 };

const ACCESS: Station['access'][] = ['public', 'customers', 'unknown'];
const STATUSES: NonNullable<Station['status']>[] = ['operational', 'temporarily_unavailable', 'partly_operational', 'unknown'];
const SPEEDS: Speed[] = ['dc', 'ac', 'unknown'];
const VEHICLE_CLASSES: NonNullable<Station['vehicleClass']>[] = ['car', '2w', '3w', 'mixed', 'unknown'];

const indexer = <T>(list: T[]) => {
  const map = new Map(list.map((v, i) => [v, i]));
  return (v: T) => map.get(v)!;
};

/** `osm-n123` -> `n123`, `ocm-45` -> `45`; anything else is kept whole (it can't look like either). */
export function shortId(id: string): string {
  const osm = id.match(/^osm-([nwr]\d+)$/);
  if (osm) return osm[1];
  const ocm = id.match(/^ocm-(\d+)$/);
  return ocm ? ocm[1] : id;
}

export function longId(short: string): string {
  if (/^[nwr]\d+$/.test(short)) return `osm-${short}`;
  if (/^\d+$/.test(short)) return `ocm-${short}`;
  return short;
}

/** Builds index.json from the app stations. `shardOf` names the shard cell holding each station's details. */
export function encodeIndex(dataset: Required<Pick<Dataset, 'version'>> & Dataset, shardOf: (s: Station) => string): CompactIndex {
  const { stations, version, generatedAt, sources } = dataset;
  const sorted = (values: Iterable<string>) => [...new Set(values)].sort();
  const operators = sorted(stations.map((s) => s.operator).filter((o): o is string => o !== null));
  const connectorTypes = sorted(stations.flatMap((s) => s.connectors.map((c) => c.type))) as ConnectorType[];
  const states = sorted(stations.map((s) => s.state).filter((x): x is string => typeof x === 'string'));
  const flags = sorted(stations.flatMap((s) => s.flags ?? []));
  const cells = sorted(stations.map(shardOf));
  if (flags.length > 30) throw new Error('index.json flags no longer fit a bit mask');
  const op = indexer(operators);
  const ct = indexer(connectorTypes);
  const st = indexer(states);
  const fl = indexer(flags);
  const ac = indexer(ACCESS);
  const ss = indexer(STATUSES);
  const sp = indexer(SPEEDS);
  const vc = indexer(VEHICLE_CLASSES);
  const ce = indexer(cells);
  const col = <T>(f: (s: Station) => T): T[] => stations.map(f);
  return {
    version,
    schema: INDEX_SCHEMA,
    generatedAt,
    sources,
    operators,
    connectorTypes,
    speeds: SPEEDS,
    vehicleClasses: VEHICLE_CLASSES,
    access: ACCESS,
    statuses: STATUSES,
    states,
    flags,
    cells,
    count: stations.length,
    columns: {
      id: col((s) => shortId(s.id)),
      c1: col((s) => (s.c1Id ?? s.id).replace(/^c1_/, '')),
      lat: col((s) => s.lat),
      lng: col((s) => s.lng),
      speed: col((s) => sp(s.speed)),
      maxKw: col((s) => s.maxKw),
      operator: col((s) => (s.operator === null ? null : op(s.operator))),
      vehicleClass: col((s) => vc(s.vehicleClass ?? 'unknown')),
      confidence: col((s) => Math.round((s.confidence ?? 0) * 100)),
      shard: col((s) => ce(shardOf(s))),
      name: col((s) => s.name),
      connectors: col((s) => s.connectors.map((c): CompactConnector => [ct(c.type), c.count, c.kw])),
      points: col((s) => s.points),
      vehicles: col((s) => s.vehicles.reduce((m, v) => m | VEHICLE_BITS[v], 0)),
      batterySwap: col((s) => (s.batterySwap ? 1 : 0)),
      is24x7: col((s) => (s.is24x7 === null ? null : s.is24x7 ? 1 : 0)),
      access: col((s) => ac(s.access)),
      status: col((s) => ss(s.status ?? 'unknown')),
      state: col((s) => (s.state ? st(s.state) : null)),
      flags: col((s) => (s.flags ?? []).reduce((m, f) => m | (1 << fl(f)), 0)),
    },
  };
}

/**
 * Stations from index.json. They have everything the map, filters, search and planner need; the text
 * details and sources are empty until the station's shard is read (see loadStationDetail).
 */
export function decodeIndex(ix: CompactIndex): Station[] {
  if (ix.schema !== INDEX_SCHEMA) throw new Error(`index.json schema ${String(ix.schema)} not supported`);
  const vehicleList = Object.entries(VEHICLE_BITS) as Array<[Vehicle, number]>;
  const c = ix.columns;
  const out: Station[] = new Array(ix.count);
  for (let i = 0; i < ix.count; i++) {
    const op = c.operator[i];
    const vmask = c.vehicles[i];
    const fmask = c.flags[i];
    const h24 = c.is24x7[i];
    const state = c.state[i];
    out[i] = {
      id: longId(c.id[i]),
      name: c.name[i],
      operator: op === null ? null : ix.operators[op],
      lat: c.lat[i],
      lng: c.lng[i],
      connectors: c.connectors[i].map(([t, count, kw]) => ({ type: ix.connectorTypes[t], count, kw })),
      points: c.points[i],
      maxKw: c.maxKw[i],
      speed: ix.speeds[c.speed[i]],
      vehicles: vehicleList.filter(([, bit]) => vmask & bit).map(([v]) => v),
      batterySwap: c.batterySwap[i] === 1,
      hours: null,
      is24x7: h24 === null ? null : h24 === 1,
      price: null,
      access: ix.access[c.access[i]],
      address: null,
      website: null,
      sources: [],
      c1Id: /^[a-z2-7]{12}$/.test(c.c1[i]) ? `c1_${c.c1[i]}` : c.c1[i],
      confidence: c.confidence[i] / 100,
      vehicleClass: ix.vehicleClasses[c.vehicleClass[i]],
      state: state === null ? null : ix.states[state],
      status: ix.statuses[c.status[i]],
      flags: fmask ? ix.flags.filter((_, k) => fmask & (1 << k)) : [],
      shard: ix.cells[c.shard[i]],
      detail: 'pending',
    };
  }
  return out;
}

/** One station in a worker cell file: [c1Id, legacy id, lat, lng, name, operator, maxKw, connector types, dc]. */
export type CellRow = [string, string, number, number, string, string | null, number | null, ConnectorType[], 0 | 1];

export interface CellFile {
  cell: string;
  version: string;
  rows: CellRow[];
}

export function encodeCell(cell: string, version: string, stations: Station[], isDc: (s: Station) => boolean): CellFile {
  return {
    cell,
    version,
    rows: stations.map((s) => [s.c1Id ?? s.id, s.id, s.lat, s.lng, s.name, s.operator, s.maxKw, [...new Set(s.connectors.map((c) => c.type))], isDc(s) ? 1 : 0]),
  };
}
