import {
  BoxGeometry,
  BufferAttribute,
  BufferGeometry,
  CatmullRomCurve3,
  Color,
  CylinderGeometry,
  DoubleSide,
  Group,
  LatheGeometry,
  Matrix4,
  Mesh,
  MeshPhysicalMaterial,
  MeshStandardMaterial,
  SphereGeometry,
  TubeGeometry,
  Vector2,
  Vector3,
  type Material,
  type Object3D,
} from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import type { CarDesign, FaceItem, FaceLine } from './carDesign.ts';

// Builds a car from its CarDesign numbers: a lofted body with real wheel arches, a glasshouse with
// pillars and roof, wheels with the car's own spoke count, and its light signature drawn onto the
// actual front and rear surfaces. The car points along +x, stands on y = 0 and is centred on x and z.

export interface CarModel {
  group: Group;
  /** Each wheel turns about its local z axis. */
  wheels: Group[];
  wheelRadius: number;
  paint: MeshPhysicalMaterial;
  headlights: MeshStandardMaterial[];
  taillights: MeshStandardMaterial[];
  length: number;
  dispose(): void;
}

const lerp = (a: number, b: number, u: number) => a + (b - a) * u;
const clamp01 = (u: number) => Math.min(1, Math.max(0, u));
const smooth = (u: number) => {
  const v = clamp01(u);
  return v * v * (3 - 2 * v);
};

/** Tyre outer radius and width from the rim size, using the usual Indian-market sizes. */
function tyreFor(rimInch: number): { R: number; width: number; rimR: number } {
  const [width, aspect] = rimInch <= 14 ? [0.165, 0.7] : rimInch <= 15 ? [0.195, 0.65] : rimInch <= 16 ? [0.215, 0.6] : rimInch <= 17 ? [0.215, 0.55] : rimInch <= 18 ? [0.235, 0.55] : rimInch <= 19 ? [0.245, 0.5] : [0.255, 0.45];
  const rimR = (rimInch * 0.0254) / 2;
  return { R: rimR + width * aspect, width, rimR };
}

interface Mats {
  paint: MeshPhysicalMaterial;
  black: MeshPhysicalMaterial;
  matte: MeshStandardMaterial;
  under: MeshStandardMaterial;
  glass: MeshPhysicalMaterial;
  chrome: MeshStandardMaterial;
  housing: MeshPhysicalMaterial;
  drl: MeshStandardMaterial;
  turn: MeshStandardMaterial;
  tail: MeshStandardMaterial;
  tyre: MeshStandardMaterial;
  rim: MeshStandardMaterial;
  rimDark: MeshStandardMaterial;
}

function materials(d: CarDesign, paint: string): Mats {
  const decal = { polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2, side: DoubleSide };
  const rimColour = d.wheel.finish === 'black' ? '#1b1c1f' : d.wheel.finish === 'gunmetal' ? '#4a4f57' : '#c3c8cf';
  return {
    paint: new MeshPhysicalMaterial({ color: new Color(paint), metalness: 0.45, roughness: 0.3, clearcoat: 1, clearcoatRoughness: 0.04 }),
    black: new MeshPhysicalMaterial({ color: '#08090b', metalness: 0.3, roughness: 0.18, clearcoat: 1, clearcoatRoughness: 0.05 }),
    matte: new MeshStandardMaterial({ color: '#141518', roughness: 0.82, ...decal }),
    under: new MeshStandardMaterial({ color: '#0a0a0c', roughness: 0.9 }),
    glass: new MeshPhysicalMaterial({ color: '#0b1018', metalness: 0.2, roughness: 0.03, clearcoat: 1, clearcoatRoughness: 0.02, envMapIntensity: 1.4 }),
    chrome: new MeshStandardMaterial({ color: '#c9ced6', metalness: 1, roughness: 0.22, ...decal }),
    housing: new MeshPhysicalMaterial({ color: '#0d1016', metalness: 0.4, roughness: 0.08, clearcoat: 1, ...decal }),
    drl: new MeshStandardMaterial({ color: '#e9f2ff', emissive: new Color('#d6e8ff'), emissiveIntensity: 0.35, roughness: 0.3, ...decal, polygonOffsetFactor: -4, polygonOffsetUnits: -4 }),
    turn: new MeshStandardMaterial({ color: '#ffb84a', emissive: new Color('#ff9a1f'), emissiveIntensity: 0.2, roughness: 0.3, ...decal, polygonOffsetFactor: -4, polygonOffsetUnits: -4 }),
    tail: new MeshStandardMaterial({ color: '#7a0d12', emissive: new Color('#ff1f2d'), emissiveIntensity: 0.3, roughness: 0.3, ...decal, polygonOffsetFactor: -4, polygonOffsetUnits: -4 }),
    tyre: new MeshStandardMaterial({ color: '#0f0f11', roughness: 0.92 }),
    rim: new MeshStandardMaterial({ color: rimColour, metalness: d.wheel.finish === 'black' ? 0.4 : 0.9, roughness: 0.28 }),
    rimDark: new MeshStandardMaterial({ color: '#141518', metalness: 0.5, roughness: 0.5 }),
  };
}

/** A grid surface from rings of points; each quad's material comes from `pick(ring, edge)`. */
function loft(rings: Vector3[][], closed: boolean, pick: (i: number, j: number) => number, matList: Material[]): Mesh {
  const n = rings[0].length;
  const pos = new Float32Array(rings.length * n * 3);
  rings.forEach((ring, i) => ring.forEach((p, j) => pos.set([p.x, p.y, p.z], (i * n + j) * 3)));
  const buckets: number[][] = matList.map(() => []);
  const edges = closed ? n : n - 1;
  for (let i = 0; i < rings.length - 1; i++) {
    for (let j = 0; j < edges; j++) {
      const a = i * n + j;
      const b = i * n + ((j + 1) % n);
      const c = (i + 1) * n + j;
      const e = (i + 1) * n + ((j + 1) % n);
      buckets[pick(i, j)].push(a, b, c, b, e, c);
    }
  }
  const geo = new BufferGeometry();
  geo.setAttribute('position', new BufferAttribute(pos, 3));
  const index: number[] = [];
  buckets.forEach((list, m) => {
    if (list.length) geo.addGroup(index.length, list.length, m);
    index.push(...list);
  });
  geo.setIndex(index);
  geo.computeVertexNormals();
  return new Mesh(geo, matList);
}

/** A face item that misses the body is skipped; only the design lab needs to hear about it. */
function offBody(name: string, item: FaceItem): void {
  if (import.meta.env?.DEV) console.warn(`${name}: face item off the body`, item);
}

/**
 * Bakes every mesh under `root` (but not under `skip`) into one mesh per material, so a car draws in
 * about a dozen calls instead of a hundred.
 */
function mergeByMaterial(root: Object3D, skip: Object3D[] = []): void {
  root.updateMatrixWorld(true);
  const toRoot = root.matrixWorld.clone().invert();
  const byMat = new Map<Material, BufferGeometry[]>();
  const merged: Mesh[] = [];
  const walk = (o: Object3D) => {
    if (o !== root && skip.includes(o)) return;
    const mesh = o as Mesh;
    if (mesh.isMesh && !Array.isArray(mesh.material)) {
      const mat = new Matrix4().multiplyMatrices(toRoot, mesh.matrixWorld);
      let g = mesh.geometry.index ? mesh.geometry.toNonIndexed() : mesh.geometry.clone();
      for (const k of Object.keys(g.attributes)) if (k !== 'position' && k !== 'normal') g.deleteAttribute(k);
      if (!g.getAttribute('normal')) g.computeVertexNormals();
      g.applyMatrix4(mat);
      if (mat.determinant() < 0) g = flipWinding(g);
      const list = byMat.get(mesh.material) ?? [];
      list.push(g);
      byMat.set(mesh.material, list);
      merged.push(mesh);
    }
    for (const c of [...o.children]) walk(c);
  };
  walk(root);
  for (const mesh of merged) {
    mesh.removeFromParent();
    mesh.geometry.dispose();
  }
  for (const [mat, list] of byMat) {
    const g = mergeGeometries(list);
    for (const part of list) part.dispose();
    if (g) root.add(new Mesh(g, mat));
  }
}

function flipWinding(g: BufferGeometry): BufferGeometry {
  for (const attr of Object.values(g.attributes)) {
    const a = attr as BufferAttribute;
    for (let i = 0; i + 2 < a.count; i += 3) {
      for (let k = 0; k < a.itemSize; k++) {
        const t = a.array[(i + 1) * a.itemSize + k];
        a.array[(i + 1) * a.itemSize + k] = a.array[(i + 2) * a.itemSize + k];
        a.array[(i + 2) * a.itemSize + k] = t;
      }
    }
  }
  return g;
}

function strip(points: Array<[Vector3, Vector3]>, mat: Material): Mesh {
  const pos = new Float32Array(points.length * 6);
  points.forEach(([a, b], i) => pos.set([a.x, a.y, a.z, b.x, b.y, b.z], i * 6));
  const index: number[] = [];
  for (let i = 0; i < points.length - 1; i++) {
    const k = i * 2;
    index.push(k, k + 1, k + 2, k + 1, k + 3, k + 2);
  }
  const geo = new BufferGeometry();
  geo.setAttribute('position', new BufferAttribute(pos, 3));
  geo.setIndex(index);
  geo.computeVertexNormals();
  return new Mesh(geo, mat);
}

function grid(cols: Vector3[][], mat: Material): Mesh {
  const rows = cols[0].length;
  const pos = new Float32Array(cols.length * rows * 3);
  cols.forEach((col, i) => col.forEach((p, j) => pos.set([p.x, p.y, p.z], (i * rows + j) * 3)));
  const index: number[] = [];
  for (let i = 0; i < cols.length - 1; i++) {
    for (let j = 0; j < rows - 1; j++) {
      const a = i * rows + j;
      index.push(a, a + rows, a + 1, a + 1, a + rows, a + rows + 1);
    }
  }
  const geo = new BufferGeometry();
  geo.setAttribute('position', new BufferAttribute(pos, 3));
  geo.setIndex(index);
  geo.computeVertexNormals();
  return new Mesh(geo, mat);
}

function wheel(m: Mats, d: CarDesign, R: number, width: number, rimR: number): Group {
  const g = new Group();
  // Tyre: a rounded profile turned about the axle.
  const prof: Vector2[] = [];
  const hw = width / 2;
  const shoulder = Math.min(0.045, (R - rimR) * 0.45);
  prof.push(new Vector2(rimR * 0.98, -hw * 0.92));
  for (let i = 0; i <= 6; i++) {
    const a = -Math.PI / 2 + (Math.PI / 2) * (i / 6);
    prof.push(new Vector2(R - shoulder + shoulder * Math.cos(a), -hw + shoulder + shoulder * Math.sin(a)));
  }
  for (let i = 0; i <= 6; i++) {
    const a = (Math.PI / 2) * (i / 6);
    prof.push(new Vector2(R - shoulder + shoulder * Math.cos(a), hw - shoulder + shoulder * Math.sin(a)));
  }
  prof.push(new Vector2(rimR * 0.98, hw * 0.92));
  const tyre = new Mesh(new LatheGeometry(prof, 56), m.tyre);
  tyre.rotation.x = Math.PI / 2;
  g.add(tyre);

  const face = hw * 0.78;
  const barrel = new Mesh(new CylinderGeometry(rimR, rimR, width * 0.9, 40, 1, true), m.rimDark);
  barrel.rotation.x = Math.PI / 2;
  g.add(barrel);
  const disc = new Mesh(new CylinderGeometry(rimR * 0.62, rimR * 0.62, 0.02, 32), m.rimDark);
  disc.rotation.x = Math.PI / 2;
  disc.position.z = face - 0.05;
  g.add(disc);
  const lip = new Mesh(new CylinderGeometry(rimR, rimR * 0.97, 0.012, 48, 1, true), m.rim);
  lip.rotation.x = Math.PI / 2;
  lip.position.z = face;
  g.add(lip);

  const n = Math.max(3, d.wheel.spokes);
  const aero = d.wheel.style === 'aero';
  const spokeW = aero ? (2 * Math.PI * rimR * 0.62) / n - 0.012 : d.wheel.style === 'turbine' ? 0.026 : 0.038;
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2;
    const len = rimR * 0.9;
    const spoke = new Mesh(new BoxGeometry(len, spokeW, 0.018), m.rim);
    spoke.position.set(Math.cos(a) * len * 0.52, Math.sin(a) * len * 0.52, face - 0.004);
    spoke.rotation.z = a + (d.wheel.style === 'turbine' ? 0.35 : 0);
    g.add(spoke);
  }
  if (d.wheel.finish === 'two-tone') {
    // Machined faces over a dark wheel: thin dark wedges between the bright spokes read as the paint.
    for (let i = 0; i < n; i++) {
      const a = ((i + 0.5) / n) * Math.PI * 2;
      const wedge = new Mesh(new BoxGeometry(rimR * 0.75, 0.012, 0.01), m.rimDark);
      wedge.position.set(Math.cos(a) * rimR * 0.5, Math.sin(a) * rimR * 0.5, face + 0.006);
      wedge.rotation.z = a;
      g.add(wedge);
    }
  }
  const hub = new Mesh(new CylinderGeometry(0.055, 0.06, 0.03, 24), m.rim);
  hub.rotation.x = Math.PI / 2;
  hub.position.z = face + 0.004;
  g.add(hub);
  const cap = new Mesh(new CylinderGeometry(0.03, 0.03, 0.032, 20), m.black);
  cap.rotation.x = Math.PI / 2;
  cap.position.z = face + 0.008;
  g.add(cap);
  return g;
}

export function buildCar(d: CarDesign, paintHex: string): CarModel {
  const L = d.lengthMm / 1000;
  const W = d.widthMm / 1000;
  const H = d.heightMm / 1000;
  const WB = d.wheelbaseMm / 1000;
  const GC = d.clearanceMm / 1000;
  const p = d.profile;
  const { R, width: tyreW, rimR } = tyreFor(d.rimInch);
  const archR = R + 0.04;
  const xF = L / 2;
  const axles = [xF - (L - WB) * d.frontOverhang, xF - (L - WB) * d.frontOverhang - WB];
  const xOf = (t: number) => xF - t * L;
  const tOf = (x: number) => (xF - x) / L;
  const m = materials(d, paintHex);

  const T_NOSE = 0.035;
  const T_TAIL = 0.03;
  const belt = (t: number): number => {
    const a = p.cowlX;
    const b = Math.min(p.cowlX + 0.06, p.rearGlassX - 0.01);
    if (t <= b) return H * lerp(p.hoodCowlH, p.beltH, smooth((t - a) / (b - a)));
    return H * lerp(p.beltH, p.tailH, clamp01((t - b) / (p.rearGlassX - b)));
  };
  const top = (t: number): number => {
    if (t <= T_NOSE) return H * (p.noseH + (p.hoodFrontH - p.noseH) * Math.sin((Math.PI / 2) * (t / T_NOSE)));
    if (t <= p.cowlX) return H * lerp(p.hoodFrontH, p.hoodCowlH, (t - T_NOSE) / (p.cowlX - T_NOSE));
    if (t <= p.rearGlassX) return belt(t);
    if (t <= 1 - T_TAIL) return H * p.tailH;
    return H * (p.tailH - 0.05 * Math.sin((Math.PI / 2) * ((t - (1 - T_TAIL)) / T_TAIL)));
  };
  const bottom = (t: number): number => {
    const x = xOf(t);
    let y = GC;
    if (t < 0.07) y += 0.11 * (1 - t / 0.07) ** 2;
    if (t > 0.93) y += 0.09 * ((t - 0.93) / 0.07) ** 2;
    for (const ax of axles) {
      const dx = x - ax;
      if (Math.abs(dx) < archR) y = Math.max(y, R + Math.sqrt(archR * archR - dx * dx));
    }
    return y;
  };
  const planScale = (t: number): number => {
    const fz = 0.08 + 0.06 * d.noseRound;
    const rz = 0.08;
    if (t < fz) return 1 - (0.1 + 0.14 * d.noseRound) * (1 - Math.sin((Math.PI / 2) * (t / fz)));
    if (t > 1 - rz) return 1 - 0.12 * (1 - Math.sin((Math.PI / 2) * ((1 - t) / rz)));
    return 1;
  };
  /**
   * The faces aren't flat: the front leans back above the bumper line and tucks in below it, and the
   * tailgate leans forward. Returns the x offset for a point at station t and height y.
   */
  const FRONT_FACE_T = 0.1;
  const REAR_FACE_T = 0.08;
  const faceShift = (t: number, y: number): number => {
    if (t < FRONT_FACE_T) {
      const ym = H * 0.33;
      const k = y > ym ? Math.min(1.3, (y - ym) / (H * p.noseH - ym)) ** 2 * d.faceRake : ((ym - y) / ym) ** 2 * 0.06;
      return -(1 - t / FRONT_FACE_T) * k;
    }
    if (t > 1 - REAR_FACE_T) {
      const ym = H * 0.36;
      const k = y > ym ? Math.min(1.3, (y - ym) / (H * p.tailH - ym)) ** 2 * 0.07 : ((ym - y) / ym) ** 2 * 0.05;
      return (1 - (1 - t) / REAR_FACE_T) * k;
    }
    return 0;
  };
  const sideWidth = (w: number, yb: number, yt: number, y: number) => {
    const k = (y - yb) / Math.max(1e-6, yt - yb);
    return w * (1 - 0.045 * ((k - 0.62) / 0.62) ** 2);
  };
  const section = (t: number) => {
    const yb = bottom(t);
    const yt = Math.max(top(t), yb + 0.02);
    // Haunches: full width over the wheels, a little in between.
    const x = xOf(t);
    const flare = Math.max(...axles.map((ax) => Math.exp(-(((x - ax) / 0.55) ** 2))));
    const w = (W / 2) * planScale(t) * (0.978 + 0.022 * flare);
    const h = yt - yb;
    const rb = Math.min(0.08, h * 0.22);
    // Rounder shoulders at the nose and tail, so the bonnet reads narrower than the bumper.
    const nose = t < 0.16 ? (1 - t / 0.16) ** 1.5 : 0;
    const tail = t > 0.9 ? ((t - 0.9) / 0.1) ** 1.5 : 0;
    const rt = Math.min(0.075 + 0.11 * nose + 0.05 * tail, h * 0.4);
    return { yb, yt, w, rb, rt, wb: sideWidth(w, yb, yt, yb + rb), wt: sideWidth(w, yb, yt, yt - rt) };
  };
  /** Half width of the body surface at station t and height y (inside the section). */
  const halfWidthAt = (t: number, y: number): number => {
    const s = section(t);
    if (y < s.yb + s.rb) return s.wb - s.rb + Math.sqrt(Math.max(0, s.rb ** 2 - (s.yb + s.rb - y) ** 2));
    if (y > s.yt - s.rt) return s.wt - s.rt + Math.sqrt(Math.max(0, s.rt ** 2 - (y - (s.yt - s.rt)) ** 2));
    return sideWidth(s.w, s.yb, s.yt, y);
  };

  // ---------- Lower body ----------
  const lowerSide = (t: number): Array<[number, number]> => {
    const { yb, yt, w, rb, rt, wb, wt } = section(t);
    const pts: Array<[number, number]> = [];
    for (let i = 0; i <= 3; i++) pts.push([((wb - rb) * i) / 3, yb]);
    for (let i = 1; i <= 4; i++) {
      const a = -Math.PI / 2 + (Math.PI / 2) * (i / 4);
      pts.push([wb - rb + rb * Math.cos(a), yb + rb + rb * Math.sin(a)]);
    }
    for (let i = 1; i <= 7; i++) {
      const y = yb + rb + ((yt - rt - yb - rb) * i) / 7;
      pts.push([sideWidth(w, yb, yt, y), y]);
    }
    for (let i = 1; i <= 6; i++) {
      const a = (Math.PI / 2) * (i / 6);
      pts.push([wt - rt + rt * Math.cos(a), yt - rt + rt * Math.sin(a)]);
    }
    const crown = Math.min(0.02, w * 0.02);
    for (let i = 1; i <= 5; i++) {
      const z = (wt - rt) * (1 - i / 5);
      pts.push([z, yt + crown * (1 - (z / Math.max(1e-6, wt - rt)) ** 2)]);
    }
    return pts;
  };
  const SIDE_PTS = 26;
  const ring = (t: number, side: Array<[number, number]>): Vector3[] => {
    const x = xOf(t);
    const out = side.map(([z, y]) => new Vector3(x + faceShift(t, y), y, z));
    for (let j = side.length - 2; j >= 1; j--) out.push(new Vector3(x + faceShift(t, side[j][1]), side[j][1], -side[j][0]));
    return out;
  };
  const sourceIndex = (j: number, n: number, sideLen: number) => (j < sideLen ? j : n - j);

  const tSet = new Set<number>([0, 0.003, 0.008, 0.015, 0.025, T_NOSE, 0.05, 0.07, 0.09, 0.12, p.cowlX, p.rearGlassX, 0.88, 0.91, 0.93, 0.95, 0.965, 0.975, 0.985, 0.992, 0.997, 1]);
  for (let t = 0.12; t < 0.88; t += 0.012) tSet.add(t);
  for (const ax of axles) for (let x = ax - archR - 0.04; x <= ax + archR + 0.04; x += 0.02) tSet.add(clamp01(tOf(x)));
  const tList = [...tSet].map((t) => Math.round(t * 1e5) / 1e5).filter((t, i, a) => a.indexOf(t) === i).sort((a, b) => a - b);

  const group = new Group();
  const lowerRings = tList.map((t) => ring(t, lowerSide(t)));
  const n = lowerRings[0].length;
  const lowerMats: Material[] = [m.paint, m.matte, m.under];
  // Cladded cars have a black band all round the bottom: bumper lips, sills and arch edges.
  const claddingTop = GC + 0.15;
  const body = loft(
    lowerRings,
    true,
    (i, j) => {
      const src = Math.min(sourceIndex(j, n, SIDE_PTS), sourceIndex((j + 1) % n, n, SIDE_PTS));
      if (src < 3) return 2;
      const y = (lowerRings[i][j].y + lowerRings[i][(j + 1) % n].y + lowerRings[i + 1][j].y) / 3;
      return d.cladding && y < claddingTop ? 1 : 0;
    },
    lowerMats,
  );
  group.add(body);
  // Front and rear faces close the body.
  for (const [ringPts, front] of [[lowerRings[0], true], [lowerRings[lowerRings.length - 1], false]] as const) {
    const c = ringPts.reduce((acc, v) => acc.add(v), new Vector3()).divideScalar(ringPts.length);
    const pos: number[] = [c.x, c.y, c.z];
    ringPts.forEach((v) => pos.push(v.x, v.y, v.z));
    const idx: number[] = [];
    for (let j = 0; j < ringPts.length; j++) {
      const a = 1 + j;
      const b = 1 + ((j + 1) % ringPts.length);
      idx.push(...(front ? [0, b, a] : [0, a, b]));
    }
    const geo = new BufferGeometry();
    geo.setAttribute('position', new BufferAttribute(new Float32Array(pos), 3));
    geo.setIndex(idx);
    geo.computeVertexNormals();
    group.add(new Mesh(geo, m.paint));
  }

  // ---------- Glasshouse ----------
  const roofHalf = (t: number) => (W / 2) * d.roofWidth * planScale(t);
  const ghTop = (t: number): number => {
    if (t <= p.roofFrontX) {
      const u = clamp01((t - p.cowlX) / (p.roofFrontX - p.cowlX));
      return belt(t) + (H * p.roofH - belt(t)) * (1 - (1 - u) ** 1.5);
    }
    if (t <= p.roofRearX) return H * lerp(p.roofH, p.roofRearH, smooth((t - p.roofFrontX) / (p.roofRearX - p.roofFrontX)) ** 1.3);
    const u = clamp01((t - p.roofRearX) / (p.rearGlassX - p.roofRearX));
    return H * p.roofRearH + (belt(t) - H * p.roofRearH) * u ** 1.6;
  };
  const ghSide = (t: number): Array<[number, number]> => {
    const yb = belt(t) - 0.004;
    const yt = Math.max(ghTop(t), yb + 0.0005);
    const h = yt - yb;
    const wb = section(t).wt - 0.035;
    const wtop = Math.min(roofHalf(t), wb);
    const r = Math.min(0.07, h * 0.45, wtop * 0.5);
    const pts: Array<[number, number]> = [];
    for (let i = 0; i <= 4; i++) pts.push([lerp(wb, wtop, i / 4), yb + ((h - r) * i) / 4]);
    for (let i = 1; i <= 5; i++) {
      const a = (Math.PI / 2) * (i / 5);
      pts.push([wtop - r + r * Math.cos(a), yt - r + r * Math.sin(a)]);
    }
    for (let i = 1; i <= 5; i++) {
      const z = (wtop - r) * (1 - i / 5);
      pts.push([z, yt + 0.015 * (1 - (z / Math.max(1e-6, wtop - r)) ** 2)]);
    }
    return pts;
  };
  const ghRing = (t: number) => {
    const side = ghSide(t);
    const x = xOf(t);
    const out = side.map(([z, y]) => new Vector3(x, y, z));
    for (let j = side.length - 2; j >= 0; j--) out.push(new Vector3(x, side[j][1], -side[j][0]));
    return out;
  };
  const ghT: number[] = [];
  for (let t = p.cowlX; t < p.rearGlassX; t += 0.005) ghT.push(t);
  ghT.push(p.rearGlassX);
  const ghRings = ghT.map(ghRing);
  const ghN = ghRings[0].length;
  const GH_SIDE = 15;
  const fastback = d.body === 'coupe' || d.body === 'sedan';
  const bX = lerp(p.roofFrontX, Math.min(p.roofRearX, p.dloX), fastback ? 0.55 : 0.42);
  const cX = Math.min(p.roofRearX - 0.02, p.dloX - 0.07);
  // On a fastback the roof skin runs most of the way down the slope; only its last part is glass.
  const roofEnd = fastback ? p.rearGlassX - 0.1 : p.roofRearX;
  const pillarMat = d.pillars === 'black' ? m.black : m.paint;
  const roofMat = d.roof === 'black' ? m.black : m.paint;
  const ghMats: Material[] = [m.glass, pillarMat, roofMat];
  const greenhouse = loft(
    ghRings,
    false,
    (i, j) => {
      const t = (ghT[i] + ghT[i + 1]) / 2;
      const src = Math.min(j < GH_SIDE ? j : ghN - 1 - j, j + 1 < GH_SIDE ? j + 1 : ghN - 2 - j);
      const region = src < 4 ? 'side' : src < 9 ? 'corner' : 'top';
      if (region === 'top') return t > p.roofFrontX + 0.01 && t < roofEnd - 0.005 ? 2 : 0;
      if (region === 'corner') return t > p.roofFrontX && t < roofEnd ? 2 : 1;
      if (t > p.dloX || Math.abs(t - bX) < 0.014 || Math.abs(t - cX) < 0.018) return 1;
      return 0;
    },
    ghMats,
  );
  group.add(greenhouse);

  // ---------- Details ----------
  const sidePoint = (x: number, y: number, zSign: number, off = 0.004) => new Vector3(x, y, zSign * (halfWidthAt(clamp01(tOf(x)), y) + off));
  const sideRibbon = (path: Array<[number, number]>, w: number, mat: Material, zSign: number, off = 0.004) => {
    const pts: Array<[Vector3, Vector3]> = [];
    for (let i = 0; i < path.length; i++) {
      const [x0, y0] = path[Math.max(0, i - 1)];
      const [x1, y1] = path[Math.min(path.length - 1, i + 1)];
      const len = Math.hypot(x1 - x0, y1 - y0) || 1;
      const nx = (-(y1 - y0) / len) * (w / 2);
      const ny = ((x1 - x0) / len) * (w / 2);
      const [x, y] = path[i];
      pts.push([sidePoint(x + nx, y + ny, zSign, off), sidePoint(x - nx, y - ny, zSign, off)]);
    }
    return strip(pts, mat);
  };
  for (const zSign of [1, -1]) {
    if (d.cladding) {
      // Arch cladding stands proud of the body at full width; sampling the surface at the arch edge
      // would follow the rounded lower corner inward and bury it.
      for (const ax of axles) {
        const pts: Array<[Vector3, Vector3]> = [];
        for (let i = 0; i <= 28; i++) {
          const a = 0.07 * Math.PI + (0.86 * Math.PI * i) / 28;
          const z = zSign * (section(clamp01(tOf(ax + Math.cos(a) * archR))).wb + 0.012);
          const inner = archR - 0.005;
          const outer = archR + 0.12;
          pts.push([
            new Vector3(ax + Math.cos(a) * inner, R + Math.sin(a) * inner, z),
            new Vector3(ax + Math.cos(a) * outer, R + Math.sin(a) * outer, z),
          ]);
        }
        if (zSign < 0) pts.forEach((pair) => pair.reverse());
        group.add(strip(pts, m.matte));
      }
    }
    // Door shut lines and handles.
    const sill = GC + 0.14;
    const doorLines = [p.cowlX + 0.03, bX + 0.005, d.body === 'micro' ? null : cX - 0.01].filter((t): t is number => t !== null);
    for (const t of doorLines) {
      const x = xOf(t);
      const yTop = belt(t) - 0.012;
      const path: Array<[number, number]> = [];
      for (let k = 0; k <= 10; k++) path.push([x + 0.01 * Math.sin((k / 10) * Math.PI), lerp(Math.max(sill, bottom(t) + 0.02), yTop, k / 10)]);
      group.add(sideRibbon(path, 0.004, m.under, zSign, 0.003));
    }
    for (const t of [bX - 0.035, cX - 0.045]) {
      const x = xOf(t);
      const y = belt(t) - 0.075;
      group.add(sideRibbon([[x + 0.06, y], [x - 0.06, y]], d.flushHandles ? 0.022 : 0.03, d.flushHandles ? m.black : m.chrome, zSign, d.flushHandles ? 0.003 : 0.008));
    }
    // Mirror on a short stalk at the base of the windscreen.
    const mt = p.cowlX + 0.05;
    const mirror = new Mesh(new SphereGeometry(0.5, 20, 14), d.pillars === 'black' ? m.black : m.paint);
    mirror.scale.set(0.16, 0.1, 0.12);
    mirror.position.set(xOf(mt), belt(mt) + 0.075, zSign * (section(mt).wt + 0.06));
    mirror.rotation.y = zSign * 0.18;
    group.add(mirror);
    const stalk = new Mesh(new BoxGeometry(0.05, 0.03, 0.08), m.black);
    stalk.position.set(xOf(mt) + 0.02, belt(mt) + 0.035, zSign * (section(mt).wt + 0.01));
    group.add(stalk);
    if (d.roofRails) {
      const rail: Vector3[] = [];
      for (let k = 0; k <= 8; k++) {
        const t = lerp(p.roofFrontX + 0.05, p.roofRearX - 0.01, k / 8);
        rail.push(new Vector3(xOf(t), ghTop(t) + 0.035, zSign * roofHalf(t) * 0.86));
      }
      group.add(new Mesh(new TubeGeometry(new CatmullRomCurve3(rail), 24, 0.013, 8), m.black));
      for (const k of [0, 8]) {
        const leg = new Mesh(new BoxGeometry(0.06, 0.04, 0.03), m.black);
        leg.position.copy(rail[k]).add(new Vector3(0, -0.02, 0));
        group.add(leg);
      }
    }
  }
  if (d.spoiler && fastback) {
    // Ducktail across the top of the boot lid.
    const t = p.rearGlassX + 0.01;
    const lip = new Mesh(new BoxGeometry(0.1, 0.022, section(t).wt * 1.9), m.paint);
    lip.position.set(xOf(t), belt(p.rearGlassX) + 0.01, 0);
    lip.rotation.z = -0.12;
    group.add(lip);
  } else if (d.spoiler) {
    const t = p.roofRearX;
    const lip = new Mesh(new BoxGeometry(0.13, 0.03, roofHalf(t) * 1.7), d.roof === 'black' ? m.black : m.paint);
    lip.position.set(xOf(t) - 0.02, H * p.roofRearH - 0.004, 0);
    lip.rotation.z = 0.12;
    group.add(lip);
  }

  // ---------- Lamps and panels on the front and rear faces ----------
  const outlines = new Map<string, Array<{ x: number; z: number; s: number; nx: number; nz: number }>>();
  const outline = (front: boolean, y: number) => {
    const key = `${front}:${Math.round(y * 1000)}`;
    const hit = outlines.get(key);
    if (hit) return hit;
    const raw: Array<{ x: number; z: number }> = [];
    for (let k = 0; k <= 160; k++) {
      const t = front ? (k / 160) * 0.28 : 1 - (k / 160) * 0.28;
      const s = section(t);
      if (y < s.yb || y > s.yt) continue;
      if (raw.length === 0) raw.push({ x: xOf(t) + faceShift(t, y), z: 0 });
      raw.push({ x: xOf(t) + faceShift(t, y), z: halfWidthAt(t, y) });
    }
    const out: Array<{ x: number; z: number; s: number; nx: number; nz: number }> = [];
    let acc = 0;
    raw.forEach((pt, i) => {
      if (i > 0) acc += Math.hypot(pt.x - raw[i - 1].x, pt.z - raw[i - 1].z);
      const a = raw[Math.max(0, i - 1)];
      const b = raw[Math.min(raw.length - 1, Math.max(1, i + (i === 0 ? 1 : 0)))];
      const dx = b.x - a.x;
      const dz = b.z - a.z;
      const len = Math.hypot(dx, dz) || 1;
      const [nx, nz] = front ? [dz / len, -dx / len] : [-dz / len, dx / len];
      out.push({ ...pt, s: acc, nx, nz });
    });
    outlines.set(key, out);
    return out;
  };
  const facePoint = (front: boolean, sFrac: number, yFrac: number, off: number): Vector3 | null => {
    const y = yFrac * H;
    const o = outline(front, y);
    const sign = sFrac < 0 ? -1 : 1;
    const target = Math.abs(sFrac) * (W / 2);
    if (o.length < 2) return null;
    let i = 1;
    while (i < o.length - 1 && o[i].s < target) i++;
    const a = o[i - 1];
    const b = o[i] ?? a;
    const u = b.s > a.s ? clamp01((target - a.s) / (b.s - a.s)) : 0;
    const x = lerp(a.x, b.x, u) + lerp(a.nx, b.nx, u) * off;
    const z = lerp(a.z, b.z, u) + lerp(a.nz, b.nz, u) * off;
    return new Vector3(x, y, sign * z);
  };
  const matFor = (kind: string): Material =>
    kind === 'drl' ? m.drl : kind === 'turn' ? m.turn : kind === 'tail' ? m.tail : kind === 'chrome' ? m.chrome : kind === 'housing' ? m.housing : kind === 'skid' ? m.chrome : kind === 'trim' ? m.black : m.matte;
  const faceItem = (front: boolean, item: FaceItem, mirrorSign: number) => {
    if ('rect' in item) {
      const [s0, s1, y0, y1] = item.rect;
      const ns = Math.max(2, Math.ceil(Math.abs(s1 - s0) * (W / 2) / 0.02) + 1);
      const ny = Math.max(2, Math.ceil(((y1 - y0) * H) / 0.02) + 1);
      const cols: Vector3[][] = [];
      for (let i = 0; i < ns; i++) {
        const s = lerp(s0, s1, i / (ns - 1)) * mirrorSign;
        const col: Vector3[] = [];
        for (let j = 0; j < ny; j++) {
          const pt = facePoint(front, s, lerp(y0, y1, j / (ny - 1)), item.kind === 'drl' || item.kind === 'tail' ? 0.007 : 0.005);
          if (!pt) return offBody(d.name, item);
          col.push(pt);
        }
        cols.push(col);
      }
      group.add(grid(cols, matFor(item.kind)));
      return;
    }
    const line = item as FaceLine;
    const path: Array<[number, number]> = [];
    for (let k = 0; k < line.pts.length - 1; k++) {
      const [s0, y0] = line.pts[k];
      const [s1, y1] = line.pts[k + 1];
      const len = Math.hypot((s1 - s0) * (W / 2), (y1 - y0) * H);
      const steps = Math.max(1, Math.ceil(len / 0.012));
      for (let i = 0; i < steps; i++) path.push([lerp(s0, s1, i / steps), lerp(y0, y1, i / steps)]);
    }
    path.push(line.pts[line.pts.length - 1]);
    const half = line.w / 2000;
    const pts: Array<[Vector3, Vector3]> = [];
    for (let i = 0; i < path.length; i++) {
      const [s, y] = path[i];
      const [sa, ya] = path[Math.max(0, i - 1)];
      const [sb, yb] = path[Math.min(path.length - 1, i + 1)];
      const ds = (sb - sa) * (W / 2);
      const dy = (yb - ya) * H;
      const len = Math.hypot(ds, dy) || 1;
      const os = (-dy / len) * half;
      const oy = (ds / len) * half;
      const a = facePoint(front, (s + os / (W / 2)) * mirrorSign, y + oy / H, 0.008);
      const b = facePoint(front, (s - os / (W / 2)) * mirrorSign, y - oy / H, 0.008);
      if (!a || !b) return offBody(d.name, line);
      pts.push([a, b]);
    }
    group.add(strip(pts, matFor(line.kind)));
  };
  for (const [items, front] of [[d.front, true], [d.rear, false]] as const) {
    for (const item of items) {
      faceItem(front, item, 1);
      if (item.mirror) faceItem(front, item, -1);
    }
  }

  // ---------- Wheels ----------
  const wheels: Group[] = [];
  for (const ax of axles) {
    for (const zSign of [1, -1]) {
      const w = wheel(m, d, R, tyreW, rimR);
      w.position.set(ax, R, zSign * (W / 2 - tyreW / 2 - 0.02));
      if (zSign < 0) w.scale.z = -1;
      const pivot = new Group();
      pivot.add(w);
      wheels.push(w);
      group.add(pivot);
    }
  }

  for (const w of wheels) mergeByMaterial(w);
  mergeByMaterial(group, wheels);

  const disposeAll = () => {
    group.traverse((o) => (o as Mesh).geometry?.dispose());
    for (const mat of Object.values(m)) (mat as Material).dispose();
  };
  return { group, wheels, wheelRadius: R, paint: m.paint, headlights: [m.drl], taillights: [m.tail], length: L, dispose: disposeAll };
}
