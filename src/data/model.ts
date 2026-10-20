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
  is24x7: boolean;
  price: string | null;
  access: 'public' | 'customers' | 'unknown';
  address: string | null;
  website: string | null;
  sources: SourceRef[];
}

export interface DatasetSource {
  name: string;
  licence: string;
  attribution: string;
  url: string;
  count: number;
}

export interface Dataset {
  generatedAt: string;
  sources: DatasetSource[];
  stations: Station[];
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
