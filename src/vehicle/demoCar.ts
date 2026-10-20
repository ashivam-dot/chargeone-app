import { RouteIndex, type Coord } from '../planner/geometry.ts';
import type { MyVehicle } from '../shared/vehicles.ts';
import { Ewma, flatWhPerKm, rangeKm, segmentWh } from './energy.ts';
import type { Telemetry, VehicleSource } from './types.ts';
import { Listeners, bearingDeg, seededRandom } from './util.ts';

export type DemoScenario = 'normal' | 'range_drop';

export interface DemoChargeStop {
  alongKm: number;
  toPct: number;
  powerKw: number;
}

export interface DemoCarOptions {
  vehicle: MyVehicle;
  route: Coord[];
  startSocPct: number;
  /** Simulated seconds per real second. */
  speedup?: number;
  scenario?: DemoScenario;
  tickMs?: number;
  chargeStops?: DemoChargeStop[];
  seed?: number;
  /** Epoch ms of the simulated start; readings are stamped in simulated time. */
  startAtMs?: number;
  ambientC?: number;
  startOdometerKm?: number;
}

/** In the range_drop scenario consumption rises after this share of the route... */
export const RANGE_DROP_START_FRACTION = 0.12;
/** ...by this factor (headwind, higher speed, AC on full), ramped in over a few km. */
export const RANGE_DROP_FACTOR = 1.4;
const RANGE_DROP_RAMP_KM = 3;
const SOH_PCT = 96;
const MAX_SUBSTEP_S = 1;
const ACCEL_KMH_PER_S = 4.3;
const BRAKE_KMH_PER_S = 7;
const TEMP_LAG_S = 600;

/** Charging power the car accepts at a given charge level: full power up to 50%, then tapering. */
export function taperedChargeKw(socPct: number, powerKw: number): number {
  const share = socPct <= 50 ? 1 : socPct <= 80 ? 1 - ((socPct - 50) / 30) * 0.3 : 0.7 - ((socPct - 80) / 20) * 0.5;
  return powerKw * Math.max(0.15, share);
}

/** A simulated car driving a route, clearly labelled as a demo. Use step() directly in tests. */
export class DemoCarSource implements VehicleSource {
  readonly kind = 'demo' as const;
  private readonly listeners = new Listeners<Telemetry>();
  private readonly index: RouteIndex;
  private readonly random: () => number;
  private readonly stops: DemoChargeStop[];
  private readonly ewma = new Ewma(5);
  private readonly dropStartKm: number;
  private readonly startAtMs: number;
  private timer: ReturnType<typeof setInterval> | null = null;

  private km = 0;
  private simS = 0;
  private socKwh: number;
  private speed = 0;
  private targetKmh = 0;
  private targetLeftS = 0;
  private powerKw = 0;
  private batteryTempC = 29;
  private stopIdx = 0;
  private chargingNow = false;
  private stranded = false;

  constructor(private readonly opts: DemoCarOptions) {
    this.index = new RouteIndex(opts.route);
    this.random = seededRandom(opts.seed ?? 1);
    this.stops = [...(opts.chargeStops ?? [])].sort((a, b) => a.alongKm - b.alongKm);
    this.socKwh = (opts.startSocPct / 100) * opts.vehicle.batteryKwh;
    this.dropStartKm = opts.scenario === 'range_drop' ? this.index.lengthKm * RANGE_DROP_START_FRACTION : Infinity;
    this.startAtMs = opts.startAtMs ?? Date.now();
  }

  get kmDone(): number {
    return this.km;
  }

  get finished(): boolean {
    return this.km >= this.index.lengthKm || this.stranded;
  }

  get socPct(): number {
    return (this.socKwh / this.opts.vehicle.batteryKwh) * 100;
  }

  private get speedup(): number {
    return this.opts.speedup ?? 30;
  }

  private get tickMs(): number {
    return this.opts.tickMs ?? 500;
  }

  async connect(): Promise<void> {
    if (this.timer) return;
    this.listeners.emit(this.reading());
    this.timer = setInterval(() => {
      this.step((this.tickMs / 1000) * this.speedup);
      if (this.finished) this.clearTimer();
    }, this.tickMs);
  }

  async disconnect(): Promise<void> {
    this.clearTimer();
  }

  private clearTimer(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  subscribe(listener: (t: Telemetry) => void): () => void {
    return this.listeners.add(listener);
  }

  setBatteryPct(pct: number): void {
    this.socKwh = (Math.max(0, Math.min(100, pct)) / 100) * this.opts.vehicle.batteryKwh;
    this.listeners.emit(this.reading());
  }

  /** Advances the simulation and emits (and returns) the new reading. */
  step(simSeconds: number): Telemetry {
    let left = simSeconds;
    while (left > 0) {
      const dt = Math.min(MAX_SUBSTEP_S, left);
      left -= dt;
      this.simS += dt;
      this.substep(dt);
    }
    const t = this.reading();
    this.listeners.emit(t);
    return t;
  }

  private substep(dt: number): void {
    const v = this.opts.vehicle;
    if (this.finished) {
      this.speed = 0;
      this.powerKw = 0;
    } else if (this.chargingNow) {
      const stop = this.stops[this.stopIdx];
      const kw = taperedChargeKw(this.socPct, stop.powerKw);
      this.socKwh = Math.min(v.batteryKwh, this.socKwh + (kw * dt) / 3600);
      this.powerKw = -kw;
      if (this.socPct >= stop.toPct || this.socPct >= 100) {
        this.chargingNow = false;
        this.stopIdx++;
      }
    } else {
      this.drive(dt);
    }
    const target = 28 + 0.35 * Math.abs(this.powerKw);
    this.batteryTempC += (Math.min(38, target) - this.batteryTempC) * (1 - Math.exp(-dt / TEMP_LAG_S));
  }

  private drive(dt: number): void {
    const v = this.opts.vehicle;
    this.targetLeftS -= dt;
    if (this.targetLeftS <= 0) {
      if (this.random() < 0.12) {
        // Town, toll plaza or a slow truck.
        this.targetKmh = 25 + 20 * this.random();
        this.targetLeftS = 30 + 60 * this.random();
      } else {
        this.targetKmh = 80 + 20 * (this.random() - this.random());
        this.targetLeftS = 40 + 110 * this.random();
      }
    }
    this.speed =
      this.speed < this.targetKmh
        ? Math.min(this.targetKmh, this.speed + ACCEL_KMH_PER_S * dt)
        : Math.max(this.targetKmh, this.speed - BRAKE_KMH_PER_S * dt);

    const stop = this.stops[this.stopIdx];
    const limitKm = stop && stop.alongKm < this.index.lengthKm ? stop.alongKm : this.index.lengthKm;
    let km = (this.speed / 3600) * dt;
    let arrived = false;
    if (this.km + km >= limitKm) {
      km = Math.max(0, limitKm - this.km);
      arrived = true;
    }
    const climbM = this.altitudeAt(this.km + km) - this.altitudeAt(this.km);
    const wh = segmentWh(v, km, { speedKmh: this.speed, climbM, ambientC: this.opts.ambientC ?? 30 }) * this.extraLoad(this.km);
    this.km += km;
    this.socKwh -= wh / 1000;
    if (km > 0) this.ewma.push(wh / km, km);
    this.powerKw = (wh / 1000) * (3600 / dt);

    if (this.socKwh <= 0) {
      this.socKwh = 0;
      this.stranded = true;
      this.speed = 0;
      this.powerKw = 0;
    } else if (arrived) {
      this.speed = 0;
      this.targetLeftS = 0;
      if (stop && limitKm === stop.alongKm) {
        if (this.socPct < stop.toPct) this.chargingNow = true;
        else this.stopIdx++;
      }
    }
  }

  private extraLoad(km: number): number {
    if (km <= this.dropStartKm) return 1;
    return 1 + (RANGE_DROP_FACTOR - 1) * Math.min(1, (km - this.dropStartKm) / RANGE_DROP_RAMP_KM);
  }

  private altitudeAt(km: number): number {
    const { cumKm, coords } = this.index;
    let lo = 0, hi = cumKm.length - 1;
    if (hi < 1) return coords[0]?.[2] ?? 0;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (cumKm[mid] <= km) lo = mid;
      else hi = mid;
    }
    const a = coords[lo][2] ?? 0, b = coords[hi][2] ?? 0;
    const seg = cumKm[hi] - cumKm[lo];
    const t = seg === 0 ? 0 : Math.max(0, Math.min(1, (km - cumKm[lo]) / seg));
    return a + t * (b - a);
  }

  /** The current state as a reading, without advancing the simulation. */
  reading(): Telemetry {
    const v = this.opts.vehicle;
    const [lng, lat] = this.index.pointAt(this.km);
    const ahead = Math.min(this.index.lengthKm, this.km + 0.05);
    const [aLng, aLat] = ahead > this.km ? this.index.pointAt(ahead) : [lng, lat];
    const [bLng, bLat] = ahead > this.km ? [lng, lat] : this.index.pointAt(Math.max(0, this.km - 0.05));
    const whPerKm = this.ewma.value;
    const soc = this.socPct;
    return {
      at: this.startAtMs + Math.round(this.simS * 1000),
      source: 'demo',
      socPct: round1(soc),
      socMeasured: true,
      rangeKm: round1(rangeKm(soc, v.batteryKwh, whPerKm ?? flatWhPerKm(v))),
      speedKmh: Math.round(this.speed),
      powerKw: round1(this.powerKw),
      whPerKm: whPerKm === null ? null : Math.round(whPerKm),
      batteryTempC: round1(this.batteryTempC),
      sohPct: SOH_PCT,
      odometerKm: round1((this.opts.startOdometerKm ?? 12480) + this.km),
      charging: this.chargingNow,
      lat,
      lng,
      headingDeg: Math.round(bearingDeg(bLng, bLat, aLng, aLat)),
    };
  }
}

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}
