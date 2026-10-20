import type { MyVehicle } from '../shared/vehicles.ts';
import { Ewma, flatWhPerKm, rangeKm, segmentWh, temperatureFactor } from './energy.ts';
import { FixTracker, type FixStep } from './track.ts';
import type { ConnectionState, PositionFix, Telemetry, VehicleSource, WatchPosition } from './types.ts';
import { Listeners } from './util.ts';

export interface PhoneSourceOptions {
  vehicle: MyVehicle;
  watch: WatchPosition;
  startSocPct: number;
  ambientC?: number | null;
  firstFixTimeoutMs?: number;
}

const EWMA_HALF_LIFE_KM = 5;
/** Below this much distance the rolling Wh/km is too noisy to show. */
const MIN_OBSERVED_KM = 1;

/**
 * Tracks the car through the phone's GPS. Battery % is an estimate from the energy model, reset
 * whenever the driver enters the figure shown in the car. The phone can't see battery temperature
 * or health, so those stay null.
 */
export class PhoneSource implements VehicleSource {
  readonly kind = 'phone' as const;
  private readonly listeners = new Listeners<Telemetry>();
  private readonly ewma = new Ewma(EWMA_HALF_LIFE_KM);
  private readonly tracker = new FixTracker();
  private socKwh: number;
  private stopWatch: (() => void) | null = null;
  private last: FixStep | null = null;
  private measuredPending = false;
  private connectionState: ConnectionState = 'idle';
  private error: string | null = null;

  constructor(private readonly opts: PhoneSourceOptions) {
    this.socKwh = (clampPct(opts.startSocPct) / 100) * opts.vehicle.batteryKwh;
  }

  get state(): ConnectionState {
    return this.connectionState;
  }

  get lastError(): string | null {
    return this.error;
  }

  get kmDriven(): number {
    return this.tracker.km;
  }

  connect(): Promise<void> {
    if (this.stopWatch) return Promise.resolve();
    this.connectionState = 'connecting';
    return new Promise<void>((resolve, reject) => {
      let settled = false;
      const settle = (err: string | null) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (err === null) {
          this.connectionState = 'connected';
          resolve();
        } else {
          this.fail(err);
          this.stop();
          reject(new Error(err));
        }
      };
      const timer = setTimeout(
        () => settle("Couldn't get a GPS fix. Check that location is on and allowed for ChargeOne, then try again."),
        this.opts.firstFixTimeoutMs ?? 30_000,
      );
      const stopWatch = this.opts.watch(
        (fix) => {
          this.onFix(fix);
          settle(null);
        },
        (message) => {
          if (settled) this.fail(message);
          else settle(message);
        },
      );
      if (this.connectionState === 'error') stopWatch();
      else this.stopWatch = stopWatch;
    });
  }

  async disconnect(): Promise<void> {
    this.stop();
    this.connectionState = 'idle';
  }

  subscribe(listener: (t: Telemetry) => void): () => void {
    return this.listeners.add(listener);
  }

  setBatteryPct(pct: number): void {
    this.socKwh = (clampPct(pct) / 100) * this.opts.vehicle.batteryKwh;
    this.measuredPending = true;
    this.listeners.emit(this.reading(Date.now()));
  }

  private stop(): void {
    this.stopWatch?.();
    this.stopWatch = null;
  }

  private fail(message: string): void {
    this.connectionState = 'error';
    this.error = message;
  }

  private onFix(fix: PositionFix): void {
    const step = this.tracker.accept(fix);
    if (!step) return;
    if (this.connectionState === 'error') {
      this.connectionState = 'connected';
      this.error = null;
    }
    if (step.km > 0) {
      const wh = segmentWh(this.opts.vehicle, step.km, {
        speedKmh: step.segmentKmh ?? 0,
        climbM: step.climbM,
        ambientC: this.opts.ambientC,
      });
      this.socKwh = Math.max(0, this.socKwh - wh / 1000);
      this.ewma.push(wh / step.km, step.km);
    }
    this.last = step;
    this.listeners.emit(this.reading(fix.at));
  }

  private reading(at: number): Telemetry {
    const v = this.opts.vehicle;
    const soc = (this.socKwh / v.batteryKwh) * 100;
    const whPerKm = this.ewma.observed >= MIN_OBSERVED_KM ? this.ewma.value : null;
    const measured = this.measuredPending;
    this.measuredPending = false;
    const fix = this.last?.fix ?? null;
    return {
      at,
      source: 'phone',
      socPct: Math.round(soc * 10) / 10,
      socMeasured: measured,
      rangeKm: Math.round(rangeKm(soc, v.batteryKwh, whPerKm ?? flatWhPerKm(v) * temperatureFactor(this.opts.ambientC)) * 10) / 10,
      speedKmh: this.last?.speedKmh == null ? null : Math.round(this.last.speedKmh),
      powerKw: null,
      whPerKm: whPerKm === null ? null : Math.round(whPerKm),
      batteryTempC: null,
      sohPct: null,
      odometerKm: null,
      charging: false,
      lat: fix?.lat ?? null,
      lng: fix?.lng ?? null,
      headingDeg: this.last?.headingDeg ?? null,
    };
  }
}

function clampPct(pct: number): number {
  return Math.max(0, Math.min(100, pct));
}
