import type { MyVehicle } from '../../shared/vehicles.ts';
import { Ewma, flatWhPerKm, rangeKm, temperatureFactor } from '../energy.ts';
import { FixTracker, type FixStep } from '../track.ts';
import type { ConnectionState, PositionFix, Telemetry, VehicleSource, WatchPosition } from '../types.ts';
import { Listeners } from '../util.ts';
import { Elm327, ObdError, PID, type Elm327Options, type ObdTransport } from './elm327.ts';

export interface ObdSourceOptions {
  vehicle: MyVehicle;
  /** Opens the adapter connection, e.g. connectBleObd() from bleTransport.ts. */
  openTransport: () => Promise<ObdTransport>;
  /** Phone location for the map; OBD-II has no standard position data. */
  watch?: WatchPosition;
  pollMs?: number;
  elm?: Elm327Options;
  now?: () => number;
  /** Called once on connect when the car shares its VIN (many EVs don't). */
  onVin?: (vin: string) => void;
}

const EWMA_HALF_LIFE_KM = 8;
/** PID 5B moves in steps of 100/255 %, so consumption needs a few steps of change to mean anything. */
const MIN_SOC_DROP_PCT = 1;
const MIN_WINDOW_KM = 1;
const MAX_WINDOW_KM = 15;
const MIN_OBSERVED_KM = 2;
/** Longer gaps between polls (app paused, adapter asleep) aren't integrated into distance. */
const MAX_INTEGRATE_S = 30;
const CHARGING_HOLD_MS = 120_000;
const SLOW_READ_EVERY = 10;
const FAILURES_BEFORE_ERROR = 3;

/**
 * OBD-II (beta) over an ELM327 adapter: battery % (PID 5B) and speed (PID 0D) from the car, location
 * from the phone. Battery temperature, health and power have no standard PIDs, so they stay null.
 */
export class ObdSource implements VehicleSource {
  readonly kind = 'obd' as const;
  private readonly listeners = new Listeners<Telemetry>();
  private readonly ewma = new Ewma(EWMA_HALF_LIFE_KM);
  private readonly tracker = new FixTracker();
  private readonly now: () => number;
  private elm: Elm327 | null = null;
  private supported = new Set<number>();
  private stopWatch: (() => void) | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private running = false;
  private connectionState: ConnectionState = 'idle';
  private error: string | null = null;
  private failures = 0;
  private polls = 0;

  private lastFix: FixStep | null = null;
  private gpsKm = 0;
  private km = 0;
  private lastPollAt: number | null = null;
  private lastSpeed: number | null = null;
  private lastSoc: number | null = null;
  private anchor: { soc: number; km: number } | null = null;
  private lastRiseAt = -Infinity;
  private ambient: number | null = null;
  private voltage: number | null = null;

  constructor(private readonly opts: ObdSourceOptions) {
    this.now = opts.now ?? Date.now;
  }

  get state(): ConnectionState {
    return this.connectionState;
  }

  get lastError(): string | null {
    return this.error;
  }

  get kmDriven(): number {
    return this.km;
  }

  get ambientC(): number | null {
    return this.ambient;
  }

  /** 12 V system voltage from PID 42, when the car reports it. */
  get moduleVoltage(): number | null {
    return this.voltage;
  }

  get supportedPids(): ReadonlySet<number> {
    return this.supported;
  }

  /** Opens the adapter, checks the car shares battery %, then polls every few seconds. Rejects with ObdError. */
  async connect(): Promise<void> {
    if (this.running) return;
    this.connectionState = 'connecting';
    this.error = null;
    let elm: Elm327 | null = null;
    try {
      elm = new Elm327(await this.opts.openTransport(), this.opts.elm);
      await elm.init();
      this.supported = await elm.supportedPids();
      // Identifying the car is worth it even when it won't share battery %.
      const vin = await elm.readVin().catch(() => null);
      if (vin) this.opts.onVin?.(vin);
      if (!this.supported.has(PID.evBatteryPct)) throw new ObdError('no_soc');
    } catch (err) {
      await elm?.close().catch(() => undefined);
      const obdErr = err instanceof ObdError ? err : new ObdError('unable_to_connect', err instanceof Error ? err.message : undefined);
      this.connectionState = 'error';
      this.error = obdErr.message;
      throw obdErr;
    }
    this.elm = elm;
    this.running = true;
    if (this.opts.watch) this.stopWatch = this.opts.watch((fix) => this.onFix(fix), () => undefined);
    await this.poll();
    this.connectionState = 'connected';
    this.schedule();
  }

  async disconnect(): Promise<void> {
    this.running = false;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.stopWatch?.();
    this.stopWatch = null;
    const elm = this.elm;
    this.elm = null;
    await elm?.close().catch(() => undefined);
    this.connectionState = 'idle';
  }

  subscribe(listener: (t: Telemetry) => void): () => void {
    return this.listeners.add(listener);
  }

  /** Reads the car once and emits a reading. The poll loop calls this; tests call it directly. */
  async poll(): Promise<Telemetry> {
    const elm = this.elm;
    if (!elm) throw new ObdError('closed');
    const slow = this.polls++ % SLOW_READ_EVERY === 0;
    const soc = await elm.readEvBatteryPct();
    const speed = this.supported.has(PID.speed) ? await elm.readSpeedKmh() : null;
    if (slow && this.supported.has(PID.ambientTemp)) this.ambient = (await elm.readAmbientC()) ?? this.ambient;
    if (slow && this.supported.has(PID.moduleVoltage)) this.voltage = (await elm.readModuleVoltage()) ?? this.voltage;
    const t = this.update(this.now(), soc, speed);
    this.listeners.emit(t);
    return t;
  }

  private schedule(): void {
    if (!this.running) return;
    this.timer = setTimeout(async () => {
      try {
        await this.poll();
        this.failures = 0;
        this.connectionState = 'connected';
        this.error = null;
      } catch (err) {
        if (++this.failures >= FAILURES_BEFORE_ERROR && this.running) {
          this.connectionState = 'error';
          this.error = err instanceof Error ? err.message : String(err);
        }
      }
      this.schedule();
    }, this.opts.pollMs ?? 3000);
  }

  private onFix(fix: PositionFix): void {
    const step = this.tracker.accept(fix);
    if (!step) return;
    this.lastFix = step;
    this.gpsKm += step.km;
  }

  private update(at: number, soc: number | null, speed: number | null): Telemetry {
    const v = this.opts.vehicle;
    const dtS = this.lastPollAt === null ? 0 : (at - this.lastPollAt) / 1000;
    if (speed !== null && this.lastSpeed !== null && dtS > 0 && dtS <= MAX_INTEGRATE_S) {
      this.km += (((speed + this.lastSpeed) / 2) * dtS) / 3600;
    } else if (speed === null && this.gpsKm > 0) {
      this.km += this.gpsKm;
    }
    this.gpsKm = 0;
    this.lastPollAt = at;
    const moving = (speed ?? this.lastFix?.speedKmh ?? 0) > 3;
    this.lastSpeed = speed;

    if (soc !== null) {
      if (this.lastSoc !== null && soc > this.lastSoc + 0.2 && !moving) this.lastRiseAt = at;
      this.trackConsumption(soc);
      this.lastSoc = soc;
    }
    const charging = !moving && at - this.lastRiseAt < CHARGING_HOLD_MS;
    const whPerKm = this.ewma.observed >= MIN_OBSERVED_KM ? this.ewma.value : null;
    const socNow = soc ?? this.lastSoc;
    const fix = this.lastFix?.fix ?? null;
    return {
      at,
      source: 'obd',
      socPct: soc === null ? null : Math.round(soc * 10) / 10,
      socMeasured: soc !== null,
      rangeKm:
        socNow === null
          ? null
          : Math.round(rangeKm(socNow, v.batteryKwh, whPerKm ?? flatWhPerKm(v) * temperatureFactor(this.ambient)) * 10) / 10,
      speedKmh: speed ?? (this.lastFix?.speedKmh == null ? null : Math.round(this.lastFix.speedKmh)),
      powerKw: null,
      whPerKm: whPerKm === null ? null : Math.round(whPerKm),
      batteryTempC: null,
      sohPct: null,
      odometerKm: null,
      charging,
      lat: fix?.lat ?? null,
      lng: fix?.lng ?? null,
      headingDeg: this.lastFix?.headingDeg ?? null,
    };
  }

  private trackConsumption(soc: number): void {
    const a = this.anchor;
    if (!a || soc > a.soc + 0.5) {
      this.anchor = { soc, km: this.km };
      return;
    }
    const km = this.km - a.km;
    const drop = a.soc - soc;
    if (km >= MIN_WINDOW_KM && (drop >= MIN_SOC_DROP_PCT || km >= MAX_WINDOW_KM)) {
      this.ewma.push(((drop / 100) * this.opts.vehicle.batteryKwh * 1000) / km, km);
      this.anchor = { soc, km: this.km };
    }
  }
}
