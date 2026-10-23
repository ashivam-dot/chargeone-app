// Prints the half profile (z, y) of the glasshouse or body ring nearest each given station.
// Usage: node scripts/car-mesh-ring.ts <id> <body|glass> t1 [t2 ...]
import { DESIGNS } from '../src/ui/car/carDesigns.ts';
import { buildCar, type CarSurfaces } from '../src/ui/car/carMesh.ts';

const [id, part, ...tArgs] = process.argv.slice(2);
const s: CarSurfaces = {};
buildCar(DESIGNS[id], '#888888', s).dispose();
const rings = part === 'glass' ? s.glass! : s.body!;
const ts = part === 'glass' ? s.glassT! : s.bodyT!;
const side = part === 'glass' ? s.glassSide! : s.bodySide!;
for (const ta of tArgs) {
  const t = Number(ta);
  let best = 0;
  ts.forEach((v, i) => {
    if (Math.abs(v - t) < Math.abs(ts[best] - t)) best = i;
  });
  const r = rings[best].slice(0, side);
  console.log(`t ${ts[best].toFixed(4)}: ` + r.map((p, j) => `${j}:${p.z.toFixed(3)},${p.y.toFixed(3)}`).join(' '));
}
