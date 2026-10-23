// Geometry diagnostics for the lofted car body: self-intersecting rings, stations that run backwards,
// and folds (adjacent quads whose normals disagree sharply) with where they are.
// Usage: node scripts/car-mesh-diag.ts [ids...] [--fold 25]
import { Vector3 } from 'three';
import { DESIGNS } from '../src/ui/car/carDesigns.ts';
import { buildCar, type CarSurfaces } from '../src/ui/car/carMesh.ts';

const args = process.argv.slice(2);
const fi = args.indexOf('--fold');
const FOLD = fi >= 0 ? Number(args[fi + 1]) : 25;
const ids = args.filter((a, i) => a !== '--fold' && args[i - 1] !== '--fold');

function segX(a: [number, number], b: [number, number], c: [number, number], d: [number, number]): boolean {
  const o = (p: [number, number], q: [number, number], r: [number, number]) => (q[0] - p[0]) * (r[1] - p[1]) - (q[1] - p[1]) * (r[0] - p[0]);
  const d1 = o(c, d, a);
  const d2 = o(c, d, b);
  const d3 = o(a, b, c);
  const d4 = o(a, b, d);
  return d1 * d2 < -1e-12 && d3 * d4 < -1e-12;
}

function report(name: string, rings: Vector3[][], ts: number[], side: number) {
  let crossings = 0;
  const firstX: string[] = [];
  rings.forEach((ring, i) => {
    const pts = ring.slice(0, side).map((p): [number, number] => [p.z, p.y]);
    for (let a = 0; a < pts.length - 1; a++)
      for (let b = a + 2; b < pts.length - 1; b++)
        if (segX(pts[a], pts[a + 1], pts[b], pts[b + 1])) {
          crossings++;
          if (firstX.length < 6) firstX.push(`t=${ts[i].toFixed(4)} seg ${a}/${b} y=${pts[a][1].toFixed(3)}`);
        }
  });
  let backwards = 0;
  const firstB: string[] = [];
  for (let i = 0; i < rings.length - 1; i++)
    for (let j = 0; j < side; j++)
      if (rings[i + 1][j].x > rings[i][j].x + 1e-6) {
        backwards++;
        if (firstB.length < 6) firstB.push(`t=${ts[i].toFixed(4)} j=${j} y=${rings[i][j].y.toFixed(3)} dx=${(rings[i + 1][j].x - rings[i][j].x).toFixed(4)}`);
      }
  // Folds along t: normal of quad (i, j) vs quad (i + 1, j).
  const qn = (i: number, j: number): Vector3 | null => {
    const a = rings[i][j];
    const b = rings[i][j + 1];
    const c = rings[i + 1][j];
    const e = rings[i + 1][j + 1];
    const n = new Vector3().subVectors(e, a).cross(new Vector3().subVectors(b, c));
    return n.length() < 1e-10 ? null : n.normalize();
  };
  const folds: Array<{ ang: number; s: string }> = [];
  for (let i = 0; i < rings.length - 2; i++)
    for (let j = name === 'body' ? 8 : 0; j < side - 1; j++) {
      const n0 = qn(i, j);
      const n1 = qn(i + 1, j);
      if (!n0 || !n1) continue;
      const ang = (Math.acos(Math.max(-1, Math.min(1, n0.dot(n1)))) * 180) / Math.PI;
      const p = rings[i + 1][j];
      if (ang > FOLD) folds.push({ ang, s: `t=${ts[i + 1].toFixed(4)} j=${j} (x ${p.x.toFixed(3)} y ${p.y.toFixed(3)} z ${p.z.toFixed(3)}) ${ang.toFixed(0)}deg` });
    }
  folds.sort((a, b) => b.ang - a.ang);
  console.log(`  ${name}: ${rings.length} rings, ${crossings} self-crossings, ${backwards} backward steps, ${folds.length} folds > ${FOLD}deg`);
  for (const s of firstX) console.log('    cross', s);
  for (const s of firstB) console.log('    back ', s);
  for (const f of folds.slice(0, 25)) console.log('    fold ', f.s);
}

for (const [id, design] of Object.entries(DESIGNS)) {
  if (ids.length && !ids.includes(id)) continue;
  const s: CarSurfaces = {};
  const car = buildCar(design, '#888888', s);
  console.log(id);
  report('body', s.body!, s.bodyT!, s.bodySide!);
  report('glass', s.glass!, s.glassT!, s.glassSide!);
  car.dispose();
}
