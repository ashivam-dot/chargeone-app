import { describe, expect, it } from 'vitest';
import { VEHICLES, myVehicleFromModel } from '../shared/vehicles.ts';
import { flatWhPerKm, segmentWh } from './energy.ts';
import { PhoneSource } from './phoneTracker.ts';
import type { PositionFix, Telemetry, WatchPosition } from './types.ts';

const nexon = myVehicleFromModel(VEHICLES.find((v) => v.id === 'tata-nexon-ev-45')!);
const M_PER_DEG_LAT = 111_195;

function fakeWatch() {
  const state = { onFix: (_: PositionFix) => {}, onError: (_: string) => {}, stopped: false };
  const watch: WatchPosition = (onFix, onError) => {
    state.onFix = onFix;
    state.onError = onError;
    return () => {
      state.stopped = true;
    };
  };
  return { watch, state };
}

function fix(northM: number, atS: number, over: Partial<PositionFix> = {}): PositionFix {
  return { lat: 20 + northM / M_PER_DEG_LAT, lng: 77, accuracy: 8, altitude: null, speedMps: null, headingDeg: null, at: atS * 1000, ...over };
}

async function connected(startSocPct = 80) {
  const { watch, state } = fakeWatch();
  const src = new PhoneSource({ vehicle: nexon, watch, startSocPct, firstFixTimeoutMs: 50 });
  const seen: Telemetry[] = [];
  src.subscribe((t) => seen.push(t));
  const ready = src.connect();
  state.onFix(fix(0, 0));
  await ready;
  return { src, state, seen };
}

/** Drives north at a steady speed with one fix per second. */
function drive(state: { onFix: (f: PositionFix) => void }, fromM: number, fromS: number, seconds: number, mps: number, over: (s: number) => Partial<PositionFix> = () => ({})) {
  for (let s = 1; s <= seconds; s++) state.onFix(fix(fromM + s * mps, fromS + s, { speedMps: mps, ...over(s) }));
  return { m: fromM + seconds * mps, s: fromS + seconds };
}

describe('PhoneSource', () => {
  it('counts distance and estimates battery from the energy model', async () => {
    const { src, state, seen } = await connected();
    expect(src.state).toBe('connected');
    drive(state, 0, 0, 450, 22.22);
    expect(src.kmDriven).toBeCloseTo(10, 1);
    const t = seen.at(-1)!;
    const expectedSoc = 80 - ((flatWhPerKm(nexon) * 10) / (nexon.batteryKwh * 1000)) * 100;
    expect(t.socPct).toBeCloseTo(expectedSoc, 0);
    expect(t.whPerKm! / flatWhPerKm(nexon)).toBeGreaterThan(0.97);
    expect(t.whPerKm! / flatWhPerKm(nexon)).toBeLessThan(1.03);
    expect(t.speedKmh).toBe(80);
    expect(t.rangeKm).toBeCloseTo((t.socPct! / 100) * 45_000 / t.whPerKm!, -1);
    expect(t.headingDeg).toBe(0);
    expect(t.socMeasured).toBe(false);
  });

  it('is honest about what the phone cannot know', async () => {
    const { state, seen } = await connected();
    drive(state, 0, 0, 10, 22.22);
    const t = seen.at(-1)!;
    expect(t.source).toBe('phone');
    expect(t.sohPct).toBeNull();
    expect(t.batteryTempC).toBeNull();
    expect(t.powerKw).toBeNull();
    expect(t.odometerKm).toBeNull();
    expect(t.whPerKm).toBeNull();
  });

  it('ignores inaccurate fixes, GPS jumps and jitter', async () => {
    const { src, state } = await connected();
    let at = drive(state, 0, 0, 45, 22.22);
    state.onFix(fix(at.m + 3000, at.s + 1, { accuracy: 120 }));
    state.onFix(fix(at.m + 5000, at.s + 1));
    expect(src.kmDriven).toBeCloseTo(1, 1);
    at = drive(state, at.m, at.s, 45, 22.22);
    expect(src.kmDriven).toBeCloseTo(2, 1);
    for (let s = 1; s <= 600; s++) state.onFix(fix(at.m + 10 * Math.sin(s), at.s + s, { speedMps: 0 }));
    expect(src.kmDriven).toBeCloseTo(2, 1);
  });

  it('counts slow movement once it adds up past the jitter radius', async () => {
    const { src, state } = await connected();
    drive(state, 0, 0, 100, 2);
    expect(src.kmDriven).toBeCloseTo(0.2, 1);
  });

  it('uses more energy uphill when altitude is reliable', async () => {
    const flat = await connected();
    drive(flat.state, 0, 0, 225, 22.22, () => ({ altitude: 300 }));
    const hill = await connected();
    drive(hill.state, 0, 0, 225, 22.22, (s) => ({ altitude: 300 + s * 0.5 }));
    const noisy = await connected();
    drive(noisy.state, 0, 0, 225, 22.22, (s) => ({ altitude: 300 + s * 0.5, accuracy: 40 }));
    const flatSoc = flat.seen.at(-1)!.socPct!;
    const hillSoc = hill.seen.at(-1)!.socPct!;
    const climbPct = (segmentWh(nexon, 1, { speedKmh: 80, climbM: 100 }) - segmentWh(nexon, 1, { speedKmh: 80 })) / 450;
    expect(flatSoc - hillSoc).toBeGreaterThan(climbPct * 0.7);
    expect(noisy.seen.at(-1)!.socPct).toBeCloseTo(flatSoc, 1);
  });

  it('takes the battery % from the driver as a new baseline', async () => {
    const { src, state, seen } = await connected();
    const at = drive(state, 0, 0, 45, 22.22);
    src.setBatteryPct(62);
    expect(seen.at(-1)!.socPct).toBe(62);
    expect(seen.at(-1)!.socMeasured).toBe(true);
    drive(state, at.m, at.s, 1, 22.22);
    expect(seen.at(-1)!.socMeasured).toBe(false);
    expect(seen.at(-1)!.socPct).toBeLessThanOrEqual(62);
    expect(seen.at(-1)!.socPct).toBeGreaterThan(61.9);
  });

  it('rejects connect when location fails before a fix, and stops watching', async () => {
    const { watch, state } = fakeWatch();
    const src = new PhoneSource({ vehicle: nexon, watch, startSocPct: 80 });
    const ready = src.connect();
    state.onError('Location permission denied');
    await expect(ready).rejects.toThrow('Location permission denied');
    expect(state.stopped).toBe(true);
    expect(src.state).toBe('error');
  });

  it('rejects connect when no fix arrives in time', async () => {
    const { watch, state } = fakeWatch();
    const src = new PhoneSource({ vehicle: nexon, watch, startSocPct: 80, firstFixTimeoutMs: 20 });
    await expect(src.connect()).rejects.toThrow(/GPS fix/);
    expect(state.stopped).toBe(true);
  });

  it('stops watching on disconnect', async () => {
    const { src, state } = await connected();
    await src.disconnect();
    expect(state.stopped).toBe(true);
    expect(src.state).toBe('idle');
  });
});
