// Draw calls and triangles for each car design, so the 3D model stays cheap on phones.
// Usage: node scripts/perf-car.ts [ids...]
import type { Mesh } from 'three';
import { DESIGNS } from '../src/ui/car/carDesigns.ts';
import { buildCar } from '../src/ui/car/carMesh.ts';

const ids = process.argv.slice(2);
let worst = 0;
for (const [id, design] of Object.entries(DESIGNS)) {
  if (ids.length && !ids.includes(id)) continue;
  const car = buildCar(design, design.paints[0]?.hex ?? '#888888');
  let calls = 0;
  let tris = 0;
  car.group.traverse((o) => {
    const m = o as Mesh;
    if (!m.isMesh) return;
    calls++;
    const g = m.geometry;
    tris += (g.index ? g.index.count : g.getAttribute('position').count) / 3;
  });
  worst = Math.max(worst, calls);
  console.log(`${id.padEnd(24)} ${String(calls).padStart(3)} draw calls ${Math.round(tris).toLocaleString('en-IN').padStart(8)} triangles`);
  car.dispose();
}
console.log(`most draw calls: ${worst}`);
