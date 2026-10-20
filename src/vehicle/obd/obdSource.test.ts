import { afterEach, describe, expect, it, vi } from 'vitest';
import { VEHICLES, myVehicleFromModel } from '../../shared/vehicles.ts';
import type { PositionFix, Telemetry, WatchPosition } from '../types.ts';
import { ObdError, PID } from './elm327.ts';
import { FakeElm, bitmapReply, type FakeReply } from './fakeElm.ts';
import { ObdSource } from './obdSource.ts';

const nexon = myVehicleFromModel(VEHICLES.find((v) => v.id === 'tata-nexon-ev-45')!);
const EV_PIDS = [PID.speed, 0x20, 0x40, PID.moduleVoltage, PID.ambientTemp, PID.evBatteryPct];

function hex(n: number): string {
  return Math.round(n).toString(16).padStart(2, '0').toUpperCase();
}

function adapter(over: Record<string, FakeReply> = {}): FakeElm {
  return new FakeElm({
    ATZ: 'ELM327 v1.5',
    '0100': `SEARCHING...\n${bitmapReply(0x00, EV_PIDS)}`,
    '0120': bitmapReply(0x20, EV_PIDS),
    '0140': bitmapReply(0x40, EV_PIDS),
    '010D': '410D5A',
    '015B': '415BCC',
    '0146': '41464A',
    '0142': '41423138',
    ...over,
  });
}

function clock(startMs = 1_000_000) {
  const c = { ms: startMs, now: () => c.ms };
  return c;
}

afterEach(() => {
  vi.useRealTimers();
});

describe('ObdSource', () => {
  it('connects, reads battery %, speed and ambient temperature, and is honest about the rest', async () => {
    const t = adapter();
    const src = new ObdSource({ vehicle: nexon, openTransport: async () => t, now: clock().now });
    const seen: Telemetry[] = [];
    src.subscribe((r) => seen.push(r));
    await src.connect();
    expect(src.state).toBe('connected');
    const r = seen[0];
    expect(r.source).toBe('obd');
    expect(r.socPct).toBeCloseTo(80, 0);
    expect(r.socMeasured).toBe(true);
    expect(r.speedKmh).toBe(90);
    expect(src.ambientC).toBe(34);
    expect(src.moduleVoltage).toBeCloseTo(12.6, 6);
    expect(r.sohPct).toBeNull();
    expect(r.batteryTempC).toBeNull();
    expect(r.powerKw).toBeNull();
    expect(r.whPerKm).toBeNull();
    expect(r.rangeKm).toBeGreaterThan(200);
    expect(r.lat).toBeNull();
    await src.disconnect();
    expect(t.closed).toBe(true);
  });

  it('refuses cars that do not share battery % and closes the adapter', async () => {
    const t = adapter({ '0140': bitmapReply(0x40, [PID.ambientTemp]) });
    const src = new ObdSource({ vehicle: nexon, openTransport: async () => t });
    const err = await src.connect().then(() => null, (e: unknown) => e);
    expect(err).toBeInstanceOf(ObdError);
    expect((err as ObdError).code).toBe('no_soc');
    expect((err as ObdError).message).toMatch(/can only read speed\. Phone tracking still works\./);
    expect(src.state).toBe('error');
    expect(t.closed).toBe(true);
  });

  it('reports an adapter that cannot reach the car', async () => {
    const t = adapter({ '0100': 'UNABLE TO CONNECT' });
    const src = new ObdSource({ vehicle: nexon, openTransport: async () => t });
    await expect(src.connect()).rejects.toMatchObject({ code: 'unable_to_connect' });
    expect(t.closed).toBe(true);
  });

  it('estimates consumption and range from battery % drops over distance', async () => {
    const c = clock();
    let km = 0;
    // 90 km/h for 3 s per poll; the car uses 160 Wh/km.
    const socAt = () => 80 - ((km * 160) / 45_000) * 100;
    const t = adapter({ '015B': () => `415B${hex((socAt() * 255) / 100)}` });
    const src = new ObdSource({ vehicle: nexon, openTransport: async () => t, now: c.now });
    await src.connect();
    let r: Telemetry | null = null;
    for (let i = 0; i < 400; i++) {
      c.ms += 3000;
      km += (90 * 3) / 3600;
      r = await src.poll();
    }
    expect(src.kmDriven).toBeCloseTo(30, 0);
    expect(r!.whPerKm).toBeGreaterThan(160 * 0.85);
    expect(r!.whPerKm).toBeLessThan(160 * 1.15);
    expect(r!.rangeKm).toBeCloseTo((r!.socPct! / 100) * 45_000 / r!.whPerKm!, -1);
    expect(r!.charging).toBe(false);
  });

  it('detects charging when the car is parked and battery % rises', async () => {
    const c = clock();
    let soc = 40;
    const t = adapter({ '010D': '410D00', '015B': () => `415B${hex((soc * 255) / 100)}` });
    const src = new ObdSource({ vehicle: nexon, openTransport: async () => t, now: c.now });
    await src.connect();
    let r: Telemetry | null = null;
    for (let i = 0; i < 20; i++) {
      c.ms += 3000;
      soc += 0.5;
      r = await src.poll();
    }
    expect(r!.charging).toBe(true);
    expect(r!.speedKmh).toBe(0);
  });

  it('takes the position from the phone', async () => {
    let onFix: (f: PositionFix) => void = () => {};
    let stopped = false;
    const watch: WatchPosition = (f) => {
      onFix = f;
      return () => {
        stopped = true;
      };
    };
    const src = new ObdSource({ vehicle: nexon, openTransport: async () => adapter(), watch, now: clock().now });
    await src.connect();
    onFix({ lat: 19.07, lng: 72.88, accuracy: 10, altitude: null, speedMps: 25, headingDeg: 45, at: 1 });
    const r = await src.poll();
    expect(r.lat).toBe(19.07);
    expect(r.lng).toBe(72.88);
    expect(r.headingDeg).toBe(45);
    expect(r.speedKmh).toBe(90);
    await src.disconnect();
    expect(stopped).toBe(true);
  });

  it('polls on a timer and flags a dead adapter after repeated failures', async () => {
    vi.useFakeTimers();
    let alive = true;
    const t = adapter({ '015B': () => (alive ? '415BCC' : null) });
    const src = new ObdSource({ vehicle: nexon, openTransport: async () => t, pollMs: 3000, elm: { timeoutMs: 100 } });
    const seen: Telemetry[] = [];
    src.subscribe((r) => seen.push(r));
    await src.connect();
    await vi.advanceTimersByTimeAsync(9000);
    expect(seen).toHaveLength(4);
    alive = false;
    await vi.advanceTimersByTimeAsync(3 * 3100);
    expect(src.state).toBe('error');
    expect(src.lastError).toMatch(/stopped answering/);
    alive = true;
    await vi.advanceTimersByTimeAsync(3100);
    expect(src.state).toBe('connected');
    await src.disconnect();
    const count = seen.length;
    await vi.advanceTimersByTimeAsync(10_000);
    expect(seen).toHaveLength(count);
  });
});
