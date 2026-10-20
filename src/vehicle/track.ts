import { haversineKm } from '../planner/geometry.ts';
import type { PositionFix } from './types.ts';
import { bearingDeg } from './util.ts';

/** Fixes less accurate than this are ignored. */
export const MAX_ACCURACY_M = 50;
/** Movement shorter than this is treated as GPS jitter and not counted until it adds up. */
export const JITTER_M = 25;
/** Faster than this (252 km/h) between fixes is a GPS jump, not driving. */
export const MAX_SPEED_MPS = 70;
/** Phone altitude is much noisier than position; only trust it from good fixes. */
export const ALTITUDE_ACCURACY_M = 20;
const ALTITUDE_SMOOTHING = 0.25;

export interface FixStep {
  fix: PositionFix;
  /** Distance counted for this fix, km (0 when it was within the jitter radius). */
  km: number;
  /** Seconds since the previous counted point. */
  dtS: number;
  /** Speed to show: the phone's own reading, else derived from movement. */
  speedKmh: number | null;
  /** Average speed over the counted distance, for the energy model. */
  segmentKmh: number | null;
  /** Smoothed height gained over the counted distance, metres. */
  climbM: number;
  headingDeg: number | null;
}

/** Turns raw phone fixes into counted distance, filtering inaccurate fixes, jitter and jumps. */
export class FixTracker {
  private anchor: PositionFix | null = null;
  private anchorAlt: number | null = null;
  private smoothedAlt: number | null = null;
  private totalKm = 0;
  private lastHeading: number | null = null;

  get km(): number {
    return this.totalKm;
  }

  accept(fix: PositionFix): FixStep | null {
    if (!(fix.accuracy <= MAX_ACCURACY_M) || !Number.isFinite(fix.lat) || !Number.isFinite(fix.lng)) return null;
    const phoneKmh = fix.speedMps !== null && fix.speedMps >= 0 ? fix.speedMps * 3.6 : null;

    const anchor = this.anchor;
    if (!anchor) {
      this.anchor = fix;
      this.trackAltitude(fix);
      this.anchorAlt = this.smoothedAlt;
      this.lastHeading = fix.headingDeg;
      return { fix, km: 0, dtS: 0, speedKmh: phoneKmh, segmentKmh: null, climbM: 0, headingDeg: fix.headingDeg };
    }
    const dtS = (fix.at - anchor.at) / 1000;
    if (dtS <= 0) return null;
    const metres = haversineKm([anchor.lng, anchor.lat], [fix.lng, fix.lat]) * 1000;
    if (metres / dtS > MAX_SPEED_MPS) return null;
    this.trackAltitude(fix);

    if (metres < JITTER_M) {
      return { fix, km: 0, dtS, speedKmh: phoneKmh, segmentKmh: null, climbM: 0, headingDeg: fix.headingDeg ?? this.lastHeading };
    }
    const segmentKmh = (metres / dtS) * 3.6;
    const climbM = this.smoothedAlt !== null && this.anchorAlt !== null ? this.smoothedAlt - this.anchorAlt : 0;
    const headingDeg = fix.headingDeg ?? bearingDeg(anchor.lng, anchor.lat, fix.lng, fix.lat);
    this.anchor = fix;
    this.anchorAlt = this.smoothedAlt;
    this.lastHeading = headingDeg;
    this.totalKm += metres / 1000;
    return { fix, km: metres / 1000, dtS, speedKmh: phoneKmh ?? segmentKmh, segmentKmh, climbM, headingDeg };
  }

  private trackAltitude(fix: PositionFix): void {
    if (fix.altitude === null || !Number.isFinite(fix.altitude) || fix.accuracy > ALTITUDE_ACCURACY_M) return;
    this.smoothedAlt = this.smoothedAlt === null ? fix.altitude : this.smoothedAlt + ALTITUDE_SMOOTHING * (fix.altitude - this.smoothedAlt);
  }
}
