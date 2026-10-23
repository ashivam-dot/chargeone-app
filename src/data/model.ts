export type ConnectorType =
  | 'CCS2'
  | 'CCS1'
  | 'CHAdeMO'
  | 'Type 2'
  | 'Type 1'
  | 'GB/T DC'
  | 'GB/T AC'
  | 'Bharat AC'
  | 'Bharat DC'
  | 'LECCS'
  | '3-pin socket'
  | 'Other';

export type Speed = 'dc' | 'ac' | 'unknown';

export type Vehicle = 'car' | '2w' | '3w' | 'bus';

/**
 * The data sources (pipeline/types.ts SourceKey). `tgredco` (a government list) and `overture` (a places
 * dataset) are location-only.
 */
export type DataSourceKey = 'osm' | 'ocm' | 'tgredco' | 'overture';

/** Display names of the sources (pipeline/outputs.ts SOURCE_NAME). */
export type SourceName = 'OpenStreetMap' | 'Open Charge Map' | 'Telangana Open Data (TGREDCO)' | 'Overture Maps Places';

export interface Connector {
  type: ConnectorType;
  count: number | null;
  kw: number | null;
}

export interface SourceRef {
  name: SourceName;
  id: string;
  url: string;
  editUrl?: string;
  updated?: string;
}

export interface Station {
  id: string;
  name: string;
  operator: string | null;
  lat: number;
  lng: number;
  connectors: Connector[];
  /** Number of vehicles that can charge at once, when known. */
  points: number | null;
  maxKw: number | null;
  speed: Speed;
  vehicles: Vehicle[];
  batterySwap: boolean;
  hours: string | null;
  /** Null when no source gives opening hours: unknown, not "closed at night". */
  is24x7: boolean | null;
  price: string | null;
  access: 'public' | 'customers' | 'unknown';
  address: string | null;
  website: string | null;
  sources: SourceRef[];
  // Added by the data pipeline (pipeline/); older files and tests may leave them out.
  /** Stable ChargeOne id (`c1_…`). `id` stays the legacy osm-/ocm- id that links and check-ins use. */
  c1Id?: string;
  /** Other ids that resolve to this station: merged source records and retired c1 ids. */
  aliases?: string[];
  /** 0-1: how sure we are the charger exists, from source agreement and how recently it was seen. */
  confidence?: number;
  vehicleClass?: 'car' | '2w' | '3w' | 'mixed' | 'unknown';
  /** State or UT, from the coordinates. */
  state?: string | null;
  /** Set when stations within a few metres of each other (different operators at one car park) share a site. */
  siteId?: string;
  /** Source-reported status; never live availability. */
  status?: 'operational' | 'temporarily_unavailable' | 'partly_operational' | 'unknown';
  /** Most recent date any source saw or verified the station. */
  observedAt?: string | null;
  /** Which source id supplied each shown field; only on stations merged from several records. */
  provenance?: Partial<Record<'position' | 'name' | 'operator' | 'connectors' | 'maxKw' | 'hours' | 'price' | 'address', string>>;
  flags?: string[];
  // Only on stations read from index.json (src/data/compact.ts) and their shards.
  /** Geohash cell of the shard that holds this station's details. */
  shard?: string;
  /** 'pending' until the shard is read: hours, price, address, website and sources are still empty, not unknown. */
  detail?: 'pending';
  /** Every field's value with the source claims behind it (from the shard). */
  fields?: Partial<Record<DetailField, FieldDetail>>;
  /** The source records behind the station (from the shard). */
  records?: SourceRecordRef[];
}

export type DetailField = 'name' | 'operator' | 'connectors' | 'maxKw' | 'points' | 'hours' | 'price' | 'access' | 'address' | 'website';

export interface FieldClaim {
  value: unknown;
  source: DataSourceKey;
  sourceId: string;
  observedAt: string | null;
  licence: string;
  /** `mapped`: the source states it. `derived`: computed from its other fields. `inferred`: guessed from the name. */
  method: 'mapped' | 'derived' | 'inferred';
}

export interface FieldDetail {
  value: unknown;
  confidence: number;
  /** Best claim first. */
  claims: FieldClaim[];
}

export interface SourceRecordRef {
  sourceId: string;
  source: DataSourceKey;
  observedAt: string | null;
  /** True when the date is a survey or verification; false when it's only an edit or bulk-import date. */
  verified: boolean;
}

export interface DatasetSource {
  name: string;
  licence: string;
  attribution: string;
  url: string;
  count: number;
  /** When the source snapshot was taken (Overpass timestamp, OCM export commit). */
  snapshotAt?: string | null;
}

export interface Dataset {
  generatedAt: string;
  sources: DatasetSource[];
  stations: Station[];
  /** Content hash of the build; matches manifest.json. */
  version?: string;
}

export const DC_TYPES: ReadonlySet<ConnectorType> = new Set([
  'CCS2',
  'CCS1',
  'CHAdeMO',
  'GB/T DC',
  'Bharat DC',
]);

/** Above this, an untyped or mixed connector is treated as DC fast charging. */
export const DC_THRESHOLD_KW = 22;

/** Has DC fast charging, judged the way the data import does. */
export function hasDc(s: Pick<Station, 'speed' | 'connectors' | 'maxKw'>): boolean {
  return s.speed === 'dc' || s.connectors.some((c) => DC_TYPES.has(c.type)) || (s.maxKw ?? 0) > DC_THRESHOLD_KW;
}
