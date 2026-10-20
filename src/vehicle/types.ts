// Live data from the car, whichever way it arrives (demo car, phone tracking or an OBD-II adapter).

export type SourceKind = 'demo' | 'phone' | 'obd';

export interface Telemetry {
  /** Epoch ms. */
  at: number;
  source: SourceKind;
  /** Battery state of charge, %. null when the source can't tell. */
  socPct: number | null;
  /** True when socPct was measured (OBD) or entered by the driver, false when estimated. */
  socMeasured: boolean;
  /** Estimated range left at the current consumption, km. */
  rangeKm: number | null;
  speedKmh: number | null;
  /** Battery power, kW: positive when driving, negative when charging or regenerating. */
  powerKw: number | null;
  /** Recent consumption, Wh/km, averaged over the last few km. */
  whPerKm: number | null;
  batteryTempC: number | null;
  /** Estimated battery health, % of original capacity. */
  sohPct: number | null;
  odometerKm: number | null;
  charging: boolean;
  lat: number | null;
  lng: number | null;
  headingDeg: number | null;
}

export type ConnectionState = 'idle' | 'connecting' | 'connected' | 'error';

export interface PositionFix {
  lat: number;
  lng: number;
  /** Metres. */
  accuracy: number;
  /** Metres above sea level, when the phone knows it. */
  altitude: number | null;
  speedMps: number | null;
  headingDeg: number | null;
  /** Epoch ms. */
  at: number;
}

/** Starts watching the phone's position; returns a function that stops it. Web and native both provide one. */
export type WatchPosition = (onFix: (fix: PositionFix) => void, onError: (message: string) => void) => () => void;

export interface VehicleSource {
  readonly kind: SourceKind;
  /** Starts the source; resolves when the first reading is possible or rejects with a message for the driver. */
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  /** Called with every new reading; returns an unsubscribe function. */
  subscribe(listener: (t: Telemetry) => void): () => void;
  /** The driver tells the app the battery % shown in the car (phone tracking uses it as the new baseline). */
  setBatteryPct?(pct: number): void;
}
