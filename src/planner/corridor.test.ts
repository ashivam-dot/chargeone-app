// The planner on the real published data: a strict plan (trusted chargers only) must work on a busy
// corridor. With the old confidence model only 8 DC chargers in India cleared the planning line, and
// every strict plan that needed a stop failed.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { decodeIndex, type CompactIndex } from '../data/compact.ts';
import { PLAN_MIN_CONFIDENCE } from '../data/trust.ts';
import { VEHICLES, myVehicleFromModel } from '../shared/vehicles.ts';
import type { Coord } from './geometry.ts';
import { DEFAULT_OPTIONS, planTrip } from './planner.ts';

const stations = decodeIndex(JSON.parse(readFileSync(new URL('../../public/data/index.json', import.meta.url), 'utf8')) as CompactIndex);
const nexon = myVehicleFromModel(VEHICLES.find((v) => v.id === 'tata-nexon-ev-45')!);
const now = new Date('2026-10-23T10:00:00Z');

/** Bengaluru to Mysuru along NH 275 (Kengeri, Bidadi, Ramanagara, Channapatna, Maddur, Mandya, Srirangapatna). */
const WAYPOINTS: Array<[number, number]> = [
  [12.9716, 77.5946],
  [12.9177, 77.4838],
  [12.7975, 77.387],
  [12.7209, 77.2799],
  [12.6518, 77.2089],
  [12.5843, 77.0436],
  [12.5223, 76.897],
  [12.4216, 76.6932],
  [12.2958, 76.6394],
];

function corridor() {
  const km = (a: [number, number], b: [number, number]) => {
    const r = Math.PI / 180;
    const h = Math.sin(((b[0] - a[0]) * r) / 2) ** 2 + Math.cos(a[0] * r) * Math.cos(b[0] * r) * Math.sin(((b[1] - a[1]) * r) / 2) ** 2;
    return 2 * 6371 * Math.asin(Math.sqrt(h));
  };
  const coords: Coord[] = [];
  let total = 0;
  for (let i = 0; i < WAYPOINTS.length - 1; i++) {
    const [a, b] = [WAYPOINTS[i], WAYPOINTS[i + 1]];
    const d = km(a, b);
    total += d;
    const n = Math.ceil(d);
    for (let k = 0; k < n; k++) coords.push([a[1] + ((b[1] - a[1]) * k) / n, a[0] + ((b[0] - a[0]) * k) / n]);
  }
  const end = WAYPOINTS[WAYPOINTS.length - 1];
  coords.push([end[1], end[0]]);
  return { coords, distanceKm: total, durationMin: total * 1.3 };
}

describe('strict planning on the real data (Bengaluru to Mysuru)', () => {
  const route = corridor();

  it('finds a trusted DC stop when the car starts low', () => {
    const p = planTrip({ route, stations, statuses: new Map(), vehicle: nexon, options: { ...DEFAULT_OPTIONS, startSocPct: 30 }, now });
    expect(p.feasible).toBe(true);
    expect(p.stops.length).toBeGreaterThan(0);
    for (const s of p.stops) {
      expect(s.trusted).toBe(true);
      expect(s.station.confidence ?? 0).toBeGreaterThanOrEqual(PLAN_MIN_CONFIDENCE);
      expect(s.station.speed).toBe('dc');
    }
  });

  it('a quarter or more of DC chargers in India clear the planning line', () => {
    const dc = stations.filter((s) => s.speed === 'dc');
    expect(dc.filter((s) => (s.confidence ?? 0) >= PLAN_MIN_CONFIDENCE).length / dc.length).toBeGreaterThanOrEqual(0.25);
  });
});
