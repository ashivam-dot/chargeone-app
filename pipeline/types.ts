// The pipeline's canonical model, aligned with OCPI 2.2.1 Locations: Site -> Station (one per operator)
// -> EVSE -> Connector. Every attribute keeps the claims behind it, so the app can say where a value
// came from and how old it is. Unknown stays unknown: no attribute defaults to false or 0.
import type { ConnectorType } from '../src/data/model.ts';

export type SourceKey = 'osm' | 'ocm';

export type LicenceId = 'ODbL-1.0' | 'CC-BY-4.0';

export interface Licence {
  id: LicenceId;
  name: string;
  attribution: string;
  url: string;
  /** What we must do when we publish data from this source. */
  obligations: string;
}

/** One value as a source states it. */
export interface Claim<T> {
  value: T;
  source: SourceKey;
  /** The source's own id in our legacy form: `osm-n123`, `ocm-456`. */
  sourceId: string;
  /** When the source last saw or verified it (ISO date), or null when the source gives no date. */
  observedAt: string | null;
  licence: LicenceId;
  /** `mapped`: the source states it. `derived`: computed from the source's other fields. `inferred`: a guess from the name. */
  method: 'mapped' | 'derived' | 'inferred';
}

/** OCPI PowerType. */
export type PowerType = 'AC_1_PHASE' | 'AC_3_PHASE' | 'DC';

export interface CanonicalConnector {
  standard: ConnectorType;
  powerType: PowerType | null;
  maxKw: number | null;
  /** How many of these sockets the source says there are. */
  count: number | null;
}

/** One charge point as the source describes it (OCM Connections, or one OSM socket key). */
export interface CanonicalEvse {
  uid: string;
  connectors: CanonicalConnector[];
}

/** Three-way: true, false, or null when no source says. */
export type Tri = boolean | null;

export interface VehicleFlags {
  car: Tri;
  twoWheeler: Tri;
  threeWheeler: Tri;
  bus: Tri;
}

export type VehicleClass = 'car' | '2w' | '3w' | 'mixed' | 'unknown';

/** Source-reported operating status. Never a live status: OSM and OCM can't say whether a charger is free now. */
export type SourceStatus = 'operational' | 'temporarily_unavailable' | 'partly_operational' | 'unknown';

export type Access = 'public' | 'customers' | 'unknown';

/** One upstream object after `toCanonical`: pure, no merging yet. */
export interface SourceRecord {
  source: SourceKey;
  sourceId: string;
  url: string;
  editUrl?: string;
  licence: LicenceId;
  /**
   * The upstream dataset inside an aggregate source (an Overture record's `sources[].dataset`, e.g.
   * "Foursquare"). Absent for single-origin sources. The licence gate checks it against the denylist.
   */
  origin?: string;
  /** Best date for "last seen": OSM check_date or edit time; OCM DateLastVerified. */
  observedAt: string | null;
  /** False when the date is only an edit or bulk-import date, not a survey or verification. */
  verified: boolean;
  lat: number;
  lng: number;
  name: string | null;
  /** Canonical operator name, or null when unknown. */
  operator: string | null;
  operatorMethod: 'mapped' | 'inferred' | null;
  evses: CanonicalEvse[];
  /** Total sockets/points when the source gives it. */
  points: number | null;
  /** Station-level output when the source gives it apart from connectors. */
  stationKw: number | null;
  hours: string | null;
  price: string | null;
  access: Access;
  membershipRequired: Tri;
  address: string | null;
  /** The state name as the source writes it (normalised), used only when the coordinates fall outside every state shape. */
  stateHint: string | null;
  website: string | null;
  vehicles: VehicleFlags;
  batterySwap: Tri;
  status: SourceStatus;
  /** Anything worth showing or reviewing: `ocm-status-30`, `bulk-unverified`, ... */
  flags: string[];
  /**
   * A charging network the listing's title names when it differs from `operator` ("Earthtron EV" filed under
   * OCM's CHARGE+). Either may be wrong, so this record may merge with a station of that network.
   */
  titleOperator?: string | null;
  /** When the source snapshot holding this record was taken; confidence ages records against it. */
  snapshotAt?: string | null;
}

/** Why a record never reached the station layer. */
export interface Rejection {
  sourceId: string;
  reason:
    | 'no-coordinates'
    | 'outside-india'
    | 'private'
    | 'not-operational'
    | 'planned'
    | 'removed'
    | 'not-live'
    | 'google-derived'
    | 'other-licence';
  /** Quarantined records are kept out for legal reasons and must never ship, even as ids. */
  quarantine: boolean;
}

export interface AdapterResult {
  records: SourceRecord[];
  rejected: Rejection[];
  /** Raw objects read from the source before any filtering. */
  rawCount: number;
  /** ISO time of the snapshot the source represents (export commit, Overpass timestamp). */
  snapshotAt: string | null;
}

export interface HealthReport {
  ok: boolean;
  problems: string[];
}

export interface Adapter<Raw> {
  key: SourceKey;
  /** Human name used in attribution: "OpenStreetMap". */
  name: string;
  licence: Licence;
  /** Reads the raw source, from the cache unless `refresh` asks for a new download. */
  fetchRaw(opts: { refresh: boolean }): Promise<Raw>;
  /** Pure: same raw input, same output. */
  toCanonical(raw: Raw): AdapterResult;
  /** Refuses obviously broken input before anything is merged. */
  health(result: AdapterResult): HealthReport;
}

export interface FieldValue<T> {
  value: T;
  /** 0-1: how much to trust this value. */
  confidence: number;
  claims: Array<Claim<T>>;
}

/** A merged station: one operator at one place. */
export interface CanonicalStation {
  /** Stable ChargeOne id: `c1_` + 12 base32 characters. */
  id: string;
  /** The id the app and check-ins used before (`osm-…`/`ocm-…`), kept stable across runs. */
  legacyId: string;
  /** Every source id and retired c1 id that now points here. */
  aliases: string[];
  siteId: string;
  lat: number;
  lng: number;
  state: string | null;
  name: FieldValue<string>;
  operator: FieldValue<string | null>;
  connectors: FieldValue<CanonicalConnector[]>;
  maxKw: FieldValue<number | null>;
  points: FieldValue<number | null>;
  hours: FieldValue<string | null>;
  price: FieldValue<string | null>;
  access: FieldValue<Access>;
  address: FieldValue<string | null>;
  website: FieldValue<string | null>;
  speed: 'dc' | 'ac' | 'unknown';
  is24x7: Tri;
  vehicles: VehicleFlags;
  vehicleClass: VehicleClass;
  batterySwap: Tri;
  membershipRequired: Tri;
  status: SourceStatus;
  /** Existence confidence 0-1. */
  confidence: number;
  members: SourceRecord[];
  flags: string[];
}

export interface Site {
  id: string;
  lat: number;
  lng: number;
  stationIds: string[];
}

export interface ReviewItem {
  /** `operator-title`: one listing whose title names a different network than its operator (a === b). */
  kind: 'possible-duplicate' | 'operator-conflict' | 'operator-title';
  score: number;
  distanceM: number;
  a: { id: string; legacyId: string; name: string; operator: string | null; sources: string[] };
  b: { id: string; legacyId: string; name: string; operator: string | null; sources: string[] };
  reasons: string[];
}
