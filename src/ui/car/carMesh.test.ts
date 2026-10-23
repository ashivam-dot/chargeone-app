import { Box3, type Mesh, Vector3 } from 'three';
import { describe, expect, it } from 'vitest';
import { VEHICLES } from '../../shared/vehicles.ts';
import { DEFAULT_PAINTS, DESIGNS, designFor, paintsFor } from './carDesigns.ts';
import { buildCar, type CarSurfaces } from './carMesh.ts';

describe('car designs', () => {
  it.each(Object.entries(DESIGNS))('%s builds to its published size', (_id, design) => {
    const car = buildCar(design, design.paints[0]?.hex ?? '#888888');
    car.group.updateMatrixWorld(true);
    const size = new Box3().setFromObject(car.group).getSize(new Vector3());
    // Mirrors stick out past the body width, so width is only checked from below.
    expect(size.x).toBeCloseTo(design.lengthMm / 1000, 1);
    expect(Math.abs(size.y - design.heightMm / 1000)).toBeLessThan(0.06);
    expect(size.z).toBeGreaterThan((design.widthMm / 1000) * 0.97);
    expect(car.wheels).toHaveLength(4);
    let bad = 0;
    car.group.traverse((o) => {
      const pos = (o as Mesh).geometry?.getAttribute('position');
      if (pos) for (let i = 0; i < pos.array.length; i++) if (!Number.isFinite(pos.array[i])) bad++;
    });
    expect(bad).toBe(0);
    car.dispose();
  });

  it('gives every catalogue car its own design except custom ones', () => {
    const missing = VEHICLES.filter((v) => !designFor(v.id).exact).map((v) => v.id);
    expect(missing).toEqual([]);
    expect(designFor('custom').exact).toBe(false);
  });

  it('offers factory paints for known cars and a plain set otherwise', () => {
    expect(paintsFor('tata-nexon-ev-45').length).toBeGreaterThan(2);
    expect(paintsFor('custom')).toBe(DEFAULT_PAINTS);
    for (const d of Object.values(DESIGNS)) for (const p of d.paints) expect(p.hex).toMatch(/^#[0-9a-f]{6}$/i);
  });
});

/** Do segments ab and cd cross (properly, not just touch)? */
function crosses(a: Vector3, b: Vector3, c: Vector3, d: Vector3): boolean {
  const o = (p: Vector3, q: Vector3, r: Vector3) => (q.z - p.z) * (r.y - p.y) - (q.y - p.y) * (r.z - p.z);
  return o(c, d, a) * o(c, d, b) < -1e-12 && o(a, b, c) * o(a, b, d) < -1e-12;
}

/** Problems with a lofted surface: rings whose half profile crosses itself, and rows that run backwards. */
function loftFaults(rings: Vector3[][], ts: number[], side: number): string[] {
  const out: string[] = [];
  for (let i = 1; i < ts.length; i++) if (!(ts[i] > ts[i - 1])) out.push(`station ${i} not after ${i - 1}`);
  rings.forEach((ring, i) => {
    const half = ring.slice(0, side);
    for (let a = 0; a < half.length - 1; a++)
      for (let b = a + 2; b < half.length - 1; b++) if (crosses(half[a], half[a + 1], half[b], half[b + 1])) out.push(`ring t=${ts[i].toFixed(4)} crosses itself (${a}/${b})`);
  });
  // Each row runs strictly from the front to the back, nose and tail caps included.
  for (let i = 0; i < rings.length - 1; i++)
    for (let j = 0; j < side; j++) if (!(rings[i + 1][j].x < rings[i][j].x)) out.push(`row ${j} runs backwards at t=${ts[i].toFixed(4)}`);
  return out;
}

describe('car loft geometry', () => {
  it.each(Object.entries(DESIGNS))('%s lofts without self-crossing or backward rings', (_id, design) => {
    const s: CarSurfaces = {};
    buildCar(design, '#888888', s).dispose();
    expect(loftFaults(s.body!, s.bodyT!, s.bodySide!).slice(0, 5)).toEqual([]);
    expect(loftFaults(s.glass!, s.glassT!, s.glassSide!).slice(0, 5)).toEqual([]);
  });
});
