// The compact formats the app and the worker read instead of the whole stations.json:
//
// - index.json: one array row per station, enough to draw the national map, filter, search and plan.
//   Repeated strings (operators, connector types, states, statuses) are stored once and referenced by
//   position. Details (hours, price, address, sources, per-field provenance) live in the shards.
// - cells/<geohash>.json: the same stations split by the shard cells, in a tiny self-contained row form,
//   so the worker can answer "chargers near here" by reading only the cells around a point.
//
// The pipeline writes both with encodeIndex/encodeCell; the app and worker read them with the decoders.
import type { Connector, ConnectorType, Dataset, DatasetSource, Speed, Station, Vehicle } from './model.ts';

export const INDEX_SCHEMA = 2;

export const INDEX_FIELDS = [
  'id',
  'c1Id',
  'lat',
  'lng',
  'speed',
  'maxKw',
  'operator',
  'vehicleClass',
  'confidence',
  'shard',
  'name',
  'connectors',
  'points',
  'vehicles',
  'batterySwap',
  'is24x7',
  'access',
  'status',
  'state',
  'flags',
] as const;

/** [type index, count, kW]. */
export type CompactConnector = [number, number | null, number | null];

export type IndexRow = [
  id: string,
  c1Id: string,
  lat: number,
  lng: number,
  speed: Speed,
  maxKw: number | null,
  operator: number | null,
  vehicleClass: NonNullable<Station['vehicleClass']>,
  confidence: number,
  shard: string,
  name: string,
  connectors: CompactConnector[],
  points: number | null,
  /** Bit mask of VEHICLE_BITS. */
  vehicles: number,
  batterySwap: 0 | 1,
  /** 1 open 24x7, 0 not, null unknown. */
  is24x7: 0 | 1 | null,
  access: number,
  status: number,
  state: number | null,
  /** Bit mask over `flags`. */
  flags: number,
];

export interface CompactIndex {
  version: string;
  schema: typeof INDEX_SCHEMA;
  generatedAt: string;
  sources: DatasetSource[];
  fields: readonly string[];
  operators: string[];
  connectorTypes: ConnectorType[];
  access: Station['access'][];
  statuses: NonNullable<Station['status']>[];
  states: string[];
  flags: string[];
  rows: IndexRow[];
}

export const VEHICLE_BITS: Record<Vehicle, number> = { car: 1, '2w': 2, '3w': 4, bus: 8 };

const ACCESS: Station['access'][] = ['public', 'customers', 'unknown'];
const STATUSES: NonNullable<Station['status']>[] = ['operational', 'temporarily_unavailable', 'partly_operational', 'unknown'];

const indexer = <T>(list: T[]) => {
  const map = new Map(list.map((v, i) => [v, i]));
  return (v: T) => map.get(v)!;
};

/** Builds index.json from the app stations. `shardOf` names the shard cell holding each station's details. */
export function encodeIndex(dataset: Required<Pick<Dataset, 'version'>> & Dataset, shardOf: (s: Station) => string): CompactIndex {
  const { stations, version, generatedAt, sources } = dataset;
  const sorted = (values: Iterable<string>) => [...new Set(values)].sort();
  const operators = sorted(stations.map((s) => s.operator).filter((o): o is string => o !== null));
  const connectorTypes = sorted(stations.flatMap((s) => s.connectors.map((c) => c.type))) as ConnectorType[];
  const states = sorted(stations.map((s) => s.state).filter((x): x is string => typeof x === 'string'));
  const flags = sorted(stations.flatMap((s) => s.flags ?? []));
  if (flags.length > 30) throw new Error('index.json flags no longer fit a bit mask');
  const op = indexer(operators);
  const ct = indexer(connectorTypes);
  const st = indexer(states);
  const fl = indexer(flags);
  const ac = indexer(ACCESS);
  const ss = indexer(STATUSES);
  return {
    version,
    schema: INDEX_SCHEMA,
    generatedAt,
    sources,
    fields: INDEX_FIELDS,
    operators,
    connectorTypes,
    access: ACCESS,
    statuses: STATUSES,
    states,
    flags,
    rows: stations.map((s): IndexRow => [
      s.id,
      s.c1Id ?? s.id,
      s.lat,
      s.lng,
      s.speed,
      s.maxKw,
      s.operator === null ? null : op(s.operator),
      s.vehicleClass ?? 'unknown',
      s.confidence ?? 0,
      shardOf(s),
      s.name,
      s.connectors.map((c): CompactConnector => [ct(c.type), c.count, c.kw]),
      s.points,
      s.vehicles.reduce((m, v) => m | VEHICLE_BITS[v], 0),
      s.batterySwap ? 1 : 0,
      s.is24x7 === null ? null : s.is24x7 ? 1 : 0,
      ac(s.access),
      ss(s.status ?? 'unknown'),
      s.state ? st(s.state) : null,
      (s.flags ?? []).reduce((m, f) => m | (1 << fl(f)), 0),
    ]),
  };
}

/**
 * Stations from index.json. They have everything the map, filters, search and planner need; the text
 * details and sources are empty until the station's shard is read (see loadStationDetail).
 */
export function decodeIndex(ix: CompactIndex): Station[] {
  if (ix.schema !== INDEX_SCHEMA) throw new Error(`index.json schema ${String(ix.schema)} not supported`);
  const vehicleList = Object.entries(VEHICLE_BITS) as Array<[Vehicle, number]>;
  return ix.rows.map((r) => {
    const [id, c1Id, lat, lng, speed, maxKw, op, vehicleClass, confidence, shard, name, conns, points, vmask, swap, h24, access, status, state, fmask] = r;
    const connectors: Connector[] = conns.map(([t, count, kw]) => ({ type: ix.connectorTypes[t], count, kw }));
    return {
      id,
      name,
      operator: op === null ? null : ix.operators[op],
      lat,
      lng,
      connectors,
      points,
      maxKw,
      speed,
      vehicles: vehicleList.filter(([, bit]) => vmask & bit).map(([v]) => v),
      batterySwap: swap === 1,
      hours: null,
      is24x7: h24 === null ? null : h24 === 1,
      price: null,
      access: ix.access[access],
      address: null,
      website: null,
      sources: [],
      c1Id,
      confidence,
      vehicleClass,
      state: state === null ? null : ix.states[state],
      status: ix.statuses[status],
      flags: ix.flags.filter((_, i) => fmask & (1 << i)),
      shard,
      detail: 'pending',
    };
  });
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
