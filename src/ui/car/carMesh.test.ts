import { Box3, Mesh, Vector3 } from 'three';
import { describe, expect, it } from 'vitest';
import { VEHICLES } from '../../shared/vehicles.ts';
import { DEFAULT_PAINTS, DESIGNS, designFor, paintsFor } from './carDesigns.ts';
import { buildCar } from './carMesh.ts';

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
