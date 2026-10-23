import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { maneuverSeconds, PLAN_SPEED_KMH, realisticMinutes, roadClass, windows, type ValhallaManeuver } from './driveTime.ts';
import { decodePolyline, parseValhalla } from './routing.ts';

/** A straight east-west line of `km` kilometres along the equator, a point every 500 m. */
function straight(km: number): number[][] {
  const step = 0.5 / 111.195;
  return Array.from({ length: Math.round(km * 2) + 1 }, (_, i) => [77 + i * step, 0]);
}

/** A zig-zag of `km` path kilometres that winds hard (path about 1.4x the straight line). */
function winding(km: number): number[][] {
  const pts: number[][] = [[77, 0]];
  const leg = 0.5 / 111.195;
  for (let i = 1; i <= km * 2; i++) {
    const [x, y] = pts[i - 1];
    pts.push([x + leg * 0.7, y + (i % 2 ? leg * 0.7 : -leg * 0.7)]);
  }
  return pts;
}

const stretch = (km: number, kmh: number, names: string[], shape: number[][], highway = false): ValhallaManeuver => ({
  length: km,
  time: (km / kmh) * 3600,
  street_names: names,
  highway,
  begin_shape_index: 0,
  end_shape_index: shape.length - 1,
});
const speed = (m: ValhallaManeuver, shape: number[][]) => m.length! / (maneuverSeconds(m, shape) / 3600);

describe('roadClass', () => {
  it('reads the class from Valhalla output only', () => {
    expect(roadClass({ highway: true, street_names: ['Mumbai - Pune Expressway'] })).toBe('expressway');
    expect(roadClass({ street_names: ['NH44', 'AH43'] })).toBe('nationalHighway');
    expect(roadClass({ street_names: ['Mumbai Delhi Highway', 'NH 48'] })).toBe('nationalHighway');
    expect(roadClass({ street_names: ['NE4', 'Delhi - Vadodara Expressway'] })).toBe('nationalHighway');
    expect(roadClass({ street_names: ['SH-17'] })).toBe('stateHighway');
    expect(roadClass({ street_names: ['Mahatma Gandhi Road'] })).toBe('other');
    expect(roadClass({})).toBe('other');
  });
});

describe('maneuverSeconds', () => {
  it('plans a straight national highway at 65% of the MoRTH 100 km/h limit', () => {
    const shape = straight(40);
    // FOSSGIS rates four-lane NH44 at 41 km/h.
    expect(speed(stretch(40, 41, ['NH44'], shape), shape)).toBeCloseTo(PLAN_SPEED_KMH.nationalHighway, 5);
    expect(PLAN_SPEED_KMH.nationalHighway).toBe(65);
  });

  it('caps an expressway at 90 km/h even when Valhalla is faster', () => {
    const shape = straight(100);
    expect(speed(stretch(100, 101, ['Bandikui Expressway'], shape, true), shape)).toBeCloseTo(90, 5);
  });

  it('keeps Valhalla on winding roads, short stretches, towns and unclassed roads', () => {
    const hill = winding(20);
    const hillRoad = stretch(20, 32, ['NH3'], hill);
    expect(maneuverSeconds(hillRoad, hill)).toBeCloseTo(hillRoad.time!, 5);
    const shape = straight(10);
    for (const m of [stretch(4, 41, ['NH44'], shape), stretch(10, 25, ['NH66'], shape), stretch(10, 41, ['Ring Road'], shape)]) {
      expect(maneuverSeconds(m, shape)).toBe(m.time);
    }
  });

  it('holds the straight parts of a hill road to 50 km/h', () => {
    // 10 km straight then 10 km winding: half the windows wind, so it is a hill road.
    const flat = straight(10);
    const bends = winding(10).map(([x, y]) => [x + (flat.at(-1)![0] - 77), y]);
    const shape = [...flat, ...bends.slice(1)];
    const pathKm = windows(shape).reduce((s, [p]) => s + p, 0);
    const m = stretch(pathKm, 32, ['NH154'], shape);
    const hours = maneuverSeconds(m, shape) / 3600;
    const flatKm = windows(flat).reduce((s, [p]) => s + p, 0);
    expect(hours).toBeCloseTo(flatKm / 50 + (pathKm - flatKm) / 32, 1);
  });

  it('is never slower than Valhalla below the class target', () => {
    const shape = straight(30);
    expect(speed(stretch(30, 60, ['NH16'], shape), shape)).toBeGreaterThanOrEqual(60);
  });
});

describe('realisticMinutes', () => {
  it("keeps Valhalla's time for legs without maneuvers", () => {
    expect(realisticMinutes([{ summary: { time: 3600 } }], [[]])).toBe(60);
  });

  it('brings recorded Hyderabad-Bengaluru (570 km) from 14.9 h to under 10 h', () => {
    const cached = JSON.parse(readFileSync(new URL('../scripts/trip-benchmark-routes/maneuvers/hyderabad-bengaluru.json', import.meta.url), 'utf8'));
    const before = cached.body.trip.summary.time / 3600;
    const route = parseValhalla(cached.status, cached.body);
    expect(before).toBeGreaterThan(14.8);
    expect(route.durationMin / 60).toBeGreaterThan(9);
    expect(route.durationMin / 60).toBeLessThan(10);
    // Every leg shape decodes, so the correction saw the whole route.
    expect(cached.body.trip.legs.every((l: { shape: string }) => decodePolyline(l.shape).length > 100)).toBe(true);
  });
});
