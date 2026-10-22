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

export interface Connector {
  type: ConnectorType;
  count: number | null;
  kw: number | null;
}

export interface SourceRef {
  name: 'OpenStreetMap' | 'Open Charge Map';
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
