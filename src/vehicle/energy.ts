import { RouteIndex, type Coord } from '../planner/geometry.ts';
import { DEFAULT_OPTIONS, cumulativeEnergy, type PlanOptions } from '../planner/planner.ts';
import { baseWhPerKm, type MyVehicle } from '../shared/vehicles.ts';

// Same physical constants as the planner (src/planner/planner.ts), so live projections match the plan.
const PASSENGER_KG = 75;
const DRIVETRAIN_EFFICIENCY = 0.9;
const REGEN_EFFICIENCY = 0.6;

/** baseWhPerKm is quoted at this speed. */
export const REFERENCE_KMH = 80;
// Split of the reference consumption into rolling resistance, air drag and constant loads (AC, electronics).
const ROLLING_SHARE = 0.4;
const DRAG_SHARE = 0.45;
const AUX_SHARE = 0.15;
const MIN_MODEL_KMH = 20;
const MAX_MODEL_KMH = 160;

export interface DriveConditions {
  speedKmh: number;
  /** Height gained over the segment, metres (negative downhill). */
  climbM?: number;
  ambientC?: number | null;
  acOn?: boolean;
  extraPassengers?: number;
}

/** Consumption relative to the reference speed on flat ground: drag grows with v², constant loads spread over fewer km at speed. */
export function speedFactor(speedKmh: number): number {
  const v = Math.min(MAX_MODEL_KMH, Math.max(MIN_MODEL_KMH, speedKmh));
  const r = v / REFERENCE_KMH;
  return ROLLING_SHARE + DRAG_SHARE * r * r + AUX_SHARE / r;
}

/** Extra load for AC in heat and cabin and battery heating in the cold; neutral between 15 and 32 °C. */
export function temperatureFactor(ambientC: number | null | undefined): number {
  if (ambientC == null) return 1;
  return 1 + 0.006 * Math.max(0, ambientC - 32) + 0.012 * Math.max(0, 15 - ambientC);
}

/** Flat-road Wh/km at the reference speed for the plan's options, the same figure planner.cumulativeEnergy uses. */
export function flatWhPerKm(vehicle: MyVehicle, acOn = DEFAULT_OPTIONS.acOn, extraPassengers = DEFAULT_OPTIONS.extraPassengers): number {
  return baseWhPerKm(vehicle) * (acOn ? 1 : 0.95) * (1 + 0.015 * extraPassengers);
}

/** Wh to lift (or recover from lowering) the car by climbM, with the planner's drivetrain and regen efficiency. */
export function climbWh(massKg: number, climbM: number): number {
  const wh = (massKg * 9.81 * climbM) / 3600;
  return wh > 0 ? wh / DRIVETRAIN_EFFICIENCY : wh * REGEN_EFFICIENCY;
}

/** Energy for a segment, Wh. Never negative, like the planner: downhill regen only offsets that segment's driving. */
export function segmentWh(vehicle: MyVehicle, km: number, c: DriveConditions): number {
  if (km <= 0) return 0;
  const passengers = c.extraPassengers ?? DEFAULT_OPTIONS.extraPassengers;
  const flat = km * flatWhPerKm(vehicle, c.acOn ?? DEFAULT_OPTIONS.acOn, passengers) * speedFactor(c.speedKmh) * temperatureFactor(c.ambientC);
  const climb = c.climbM ? climbWh(vehicle.massKg + PASSENGER_KG * passengers, c.climbM) : 0;
  return Math.max(0, flat + climb);
}

export function segmentWhPerKm(vehicle: MyVehicle, km: number, c: DriveConditions): number {
  return km > 0 ? segmentWh(vehicle, km, c) / km : flatWhPerKm(vehicle, c.acOn, c.extraPassengers) * speedFactor(c.speedKmh) * temperatureFactor(c.ambientC);
}

/** Average Wh/km the planner assumes for a whole route, hills included. */
export function routeWhPerKm(coords: Coord[], vehicle: MyVehicle, options: PlanOptions = DEFAULT_OPTIONS): number {
  const index = new RouteIndex(coords);
  if (index.lengthKm <= 0) return flatWhPerKm(vehicle, options.acOn, options.extraPassengers);
  const cum = cumulativeEnergy(index, coords, vehicle, options);
  return (cum[cum.length - 1] * 1000) / index.lengthKm;
}

/** Km left above the reserve at a given consumption. */
export function rangeKm(socPct: number, batteryKwh: number, whPerKm: number, reservePct = 0): number {
  if (!(whPerKm > 0)) return 0;
  return Math.max(0, ((socPct - reservePct) / 100) * batteryKwh * 1000) / whPerKm;
}

/**
 * Exponentially weighted average where each sample carries a weight (km driven, minutes elapsed) and a
 * sample `halfLife` weight-units old counts half as much as a new one. Bias-corrected, so the first
 * samples aren't pulled towards zero.
 */
export class Ewma {
  private sum = 0;
  private weight = 0;
  private total = 0;

  constructor(readonly halfLife: number) {}

  push(value: number, weight: number): void {
    if (!(weight > 0) || !Number.isFinite(value)) return;
    const decay = Math.pow(2, -weight / this.halfLife);
    this.sum = this.sum * decay + value * weight;
    this.weight = this.weight * decay + weight;
    this.total += weight;
  }

  get value(): number | null {
    return this.weight > 0 ? this.sum / this.weight : null;
  }

  /** Total weight pushed so far (e.g. km observed). */
  get observed(): number {
    return this.total;
  }

  reset(): void {
    this.sum = 0;
    this.weight = 0;
    this.total = 0;
  }
}
