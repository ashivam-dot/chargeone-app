import {
  BoxGeometry,
  BufferAttribute,
  BufferGeometry,
  CatmullRomCurve3,
  Color,
  CylinderGeometry,
  DoubleSide,
  ExtrudeGeometry,
  Group,
  LatheGeometry,
  Matrix4,
  Mesh,
  MeshPhysicalMaterial,
  MeshStandardMaterial,
  Path,
  Shape,
  ShapeUtils,
  SphereGeometry,
  TubeGeometry,
  Vector2,
  Vector3,
  type Material,
  type Object3D,
} from 'three';
import { mergeGeometries, mergeVertices } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import type { CarDesign, Curve, FaceItem, FaceKind, FaceLine, FacePanel, FacePattern, FacePoly, FacePt } from './carDesign.ts';

// Builds a car from its CarDesign numbers: a lofted body with a top-down plan shape, shoulder and door creases
// and real wheel arches; a glasshouse whose window graphic (DLO) is cut from the side surface; cladding that
// stands proud; wheels from a small design library at the real tyre size; and the light signature and closed
// EV face drawn onto the actual front and rear surfaces. The car points along +x, stands on y = 0 and is centred
// on x and z. Everything is merged by material, so a car draws in about 25 calls.

export interface CarModel {
  group: Group;
  /** Each wheel turns about its local z axis. */
  wheels: Group[];
  wheelRadius: number;
  paint: MeshPhysicalMaterial;
  headlights: MeshStandardMaterial[];
  taillights: MeshStandardMaterial[];
  /** DRL glow to show while the car isn't connected. */
  lampGlow: number;
  length: number;
  dispose(): void;
}

const lerp = (a: number, b: number, u: number) => a + (b - a) * u;
const clamp01 = (u: number) => Math.min(1, Math.max(0, u));
const smooth = (u: number) => {
  const v = clamp01(u);
  return v * v * (3 - 2 * v);
};

/** A smooth curve through control points that never overshoots them (Fritsch-Carlson monotone cubic). */
export function monotone(pts: Curve): (x: number) => number {
  const xs = pts.map((p) => p[0]);
  const ys = pts.map((p) => p[1]);
  const n = pts.length;
  if (n < 2) return () => ys[0] ?? 0;
  const dk: number[] = [];
  for (let i = 0; i < n - 1; i++) dk.push((ys[i + 1] - ys[i]) / Math.max(1e-9, xs[i + 1] - xs[i]));
  const mk: number[] = [dk[0]];
  for (let i = 1; i < n - 1; i++) mk.push(dk[i - 1] * dk[i] <= 0 ? 0 : (dk[i - 1] + dk[i]) / 2);
  mk.push(dk[n - 2]);
  for (let i = 0; i < n - 1; i++) {
    if (dk[i] === 0) {
      mk[i] = 0;
      mk[i + 1] = 0;
      continue;
    }
    const a = mk[i] / dk[i];
    const b = mk[i + 1] / dk[i];
    const s = a * a + b * b;
    if (s > 9) {
      const tau = 3 / Math.sqrt(s);
      mk[i] = tau * a * dk[i];
      mk[i + 1] = tau * b * dk[i];
    }
  }
  return (x: number) => {
    if (x <= xs[0]) return ys[0];
    if (x >= xs[n - 1]) return ys[n - 1];
    let i = 0;
    while (i < n - 2 && x > xs[i + 1]) i++;
    const h = xs[i + 1] - xs[i];
    const u = (x - xs[i]) / h;
    const u2 = u * u;
    const u3 = u2 * u;
    return (2 * u3 - 3 * u2 + 1) * ys[i] + (u3 - 2 * u2 + u) * h * mk[i] + (-2 * u3 + 3 * u2) * ys[i + 1] + (u3 - u2) * h * mk[i + 1];
  };
}

/** Tyre outer radius and width from the published tyre size, else the usual Indian-market size for the rim. */
function tyreFor(d: CarDesign): { R: number; width: number; rimR: number } {
  const rim = d.rimInch;
  const [wMm, aspect] = d.tyre ?? (rim <= 12 ? [145, 70] : rim <= 14 ? [165, 70] : rim <= 15 ? [195, 65] : rim <= 16 ? [215, 60] : rim <= 17 ? [215, 55] : rim <= 18 ? [235, 55] : rim <= 19 ? [245, 50] : [255, 45]);
  const width = wMm / 1000;
  const rimR = (rim * 0.0254) / 2;
  return { R: rimR + (width * aspect) / 100, width, rimR };
}

interface Mats {
  paint: MeshPhysicalMaterial;
  black: MeshPhysicalMaterial;
  matte: MeshStandardMaterial;
  clad: MeshStandardMaterial;
  under: MeshStandardMaterial;
  glass: MeshPhysicalMaterial;
  chrome: MeshStandardMaterial;
  satin: MeshStandardMaterial;
  housing: MeshPhysicalMaterial;
  lens: MeshPhysicalMaterial;
  drl: MeshStandardMaterial;
  turn: MeshStandardMaterial;
  tail: MeshStandardMaterial;
  tyre: MeshStandardMaterial;
  rim: MeshPhysicalMaterial;
  rimDark: MeshStandardMaterial;
}

function materials(d: CarDesign, paint: string): Mats {
  const decal = { polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2, side: DoubleSide };
  const lamp = { ...decal, polygonOffsetFactor: -4, polygonOffsetUnits: -4 };
  const f = d.wheel.finish;
  const rimColour = f === 'black' ? '#17181b' : f === 'gunmetal' ? '#4c5159' : f === 'two-tone' ? '#d9dde2' : '#c4c9cf';
  return {
    // Metallic base under a hard clearcoat: the coat carries the sharp studio reflections.
    paint: new MeshPhysicalMaterial({ color: new Color(paint), metalness: 0.3, roughness: 0.36, clearcoat: 1, clearcoatRoughness: 0.03, envMapIntensity: 1.1 }),
    black: new MeshPhysicalMaterial({ color: '#040506', metalness: 0, roughness: 0.14, clearcoat: 1, clearcoatRoughness: 0.03, ...decal }),
    matte: new MeshStandardMaterial({ color: '#111215', roughness: 0.78, ...decal }),
    clad: new MeshStandardMaterial({ color: new Color(d.clad.colour), roughness: 0.72, metalness: 0.05, ...decal }),
    under: new MeshStandardMaterial({ color: '#09090b', roughness: 0.92, side: DoubleSide }),
    glass: new MeshPhysicalMaterial({ color: '#33414d', metalness: 0, roughness: 0.02, clearcoat: 1, clearcoatRoughness: 0, envMapIntensity: 1.7 }),
    chrome: new MeshStandardMaterial({ color: '#dfe3e8', metalness: 1, roughness: 0.14, ...decal }),
    satin: new MeshStandardMaterial({ color: '#aeb3ba', metalness: 0.75, roughness: 0.38, ...decal }),
    housing: new MeshPhysicalMaterial({ color: '#0b0d11', metalness: 0.3, roughness: 0.06, clearcoat: 1, ...decal }),
    // A softer coat than the paint: on a small, sharply curved lens a mirror coat shows the faceting as blotches.
    lens: new MeshPhysicalMaterial({ color: '#6a0a12', emissive: new Color('#5c0610'), emissiveIntensity: 0.5, metalness: 0.1, roughness: 0.3, clearcoat: 0.6, clearcoatRoughness: 0.25, ...lamp }),
    drl: new MeshStandardMaterial({ color: '#ffffff', emissive: new Color('#e4eeff'), emissiveIntensity: d.lampGlow, roughness: 0.25, ...lamp }),
    turn: new MeshStandardMaterial({ color: '#ffb84a', emissive: new Color('#ff9a1f'), emissiveIntensity: 0.25, roughness: 0.3, ...lamp }),
    tail: new MeshStandardMaterial({ color: '#b3121b', emissive: new Color('#ff1e2c'), emissiveIntensity: 1.1, roughness: 0.3, ...lamp }),
    tyre: new MeshStandardMaterial({ color: '#19191b', roughness: 0.86 }),
    rim: new MeshPhysicalMaterial({ color: rimColour, metalness: f === 'black' ? 0.2 : 0.95, roughness: f === 'two-tone' ? 0.16 : 0.3, clearcoat: f === 'black' ? 1 : 0.4 }),
    rimDark: new MeshStandardMaterial({ color: '#141518', metalness: 0.45, roughness: 0.5 }),
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
    for (const k of list) index.push(k);
  });
  geo.setIndex(index);
  geo.computeVertexNormals();
  return new Mesh(geo, matList);
}

/** A face item that misses the body is skipped; only the design lab needs to hear about it. */
function offBody(name: string, item: FaceItem): void {
  if (import.meta.env?.DEV) console.warn(`${name}: face item off the body`, item);
}

/** The vertex range [start, start + count) of a non-indexed geometry as its own geometry. */
function slice(g: BufferGeometry, start: number, count: number): BufferGeometry {
  const out = new BufferGeometry();
  for (const k of ['position', 'normal']) {
    const a = g.getAttribute(k) as BufferAttribute | undefined;
    if (!a) continue;
    out.setAttribute(k, new BufferAttribute((a.array as Float32Array).slice(start * a.itemSize, (start + count) * a.itemSize), a.itemSize));
  }
  return out;
}

/**
 * Bakes every mesh under `root` (but not under `skip`) into one mesh per material, so a car draws in
 * about two dozen calls instead of hundreds. Multi-material meshes are split by their groups first.
 */
function mergeByMaterial(root: Object3D, skip: Object3D[] = []): void {
  root.updateMatrixWorld(true);
  const toRoot = root.matrixWorld.clone().invert();
  const byMat = new Map<Material, BufferGeometry[]>();
  const merged: Mesh[] = [];
  const add = (mat: Material, g: BufferGeometry) => {
    const list = byMat.get(mat) ?? [];
    list.push(g);
    byMat.set(mat, list);
  };
  const walk = (o: Object3D) => {
    if (o !== root && skip.includes(o)) return;
    const mesh = o as Mesh;
    if (mesh.isMesh) {
      const mat = new Matrix4().multiplyMatrices(toRoot, mesh.matrixWorld);
      let g = mesh.geometry.index ? mesh.geometry.toNonIndexed() : mesh.geometry.clone();
      for (const k of Object.keys(g.attributes)) if (k !== 'position' && k !== 'normal') g.deleteAttribute(k);
      if (!g.getAttribute('normal')) g.computeVertexNormals();
      g.applyMatrix4(mat);
      if (mat.determinant() < 0) g = flipWinding(g);
      if (Array.isArray(mesh.material)) {
        const total = g.getAttribute('position').count;
        const groups = g.groups.length ? g.groups : [{ start: 0, count: total, materialIndex: 0 }];
        for (const grp of groups) {
          const m = mesh.material[grp.materialIndex ?? 0];
          const count = Math.min(grp.count, total - grp.start);
          if (m && count > 0) add(m, slice(g, grp.start, count));
        }
        g.dispose();
      } else {
        add(mesh.material, g);
      }
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

/** A triangle soup (face decals) with smooth normals: shared corners are welded first, so a lens or panel
 * draped over a curved corner shades as one surface instead of showing every facet in the reflections. */
function triangles(pos: number[], mat: Material): Mesh {
  const raw = new BufferGeometry();
  raw.setAttribute('position', new BufferAttribute(new Float32Array(pos), 3));
  const geo = mergeVertices(raw, 1e-5);
  raw.dispose();
  geo.computeVertexNormals();
  return new Mesh(geo, mat);
}

// ---------------------------------------------------------------------------------------------------------
// Wheels

interface WheelLayout {
  n: number;
  /** Hub and outer radius of the openings, as a share of the rim radius. */
  rin: number;
  rout: number;
  /** Half the spoke width, metres. */
  half: number;
  /** How far a spoke turns (radians) from hub to rim: the turbine look. */
  twist: number;
  /** Half width of the slot that splits each spoke into two, metres (twin spokes). */
  slot: number;
  /** Extra half width per metre of radius: spokes that widen toward the rim (blades). */
  grow?: number;
}

function wheelLayout(d: CarDesign, rimR: number): WheelLayout {
  const n = Math.max(3, d.wheel.spokes);
  switch (d.wheel.style) {
    case 'twin':
      return { n, rin: 0.34, rout: 0.88, half: 0.026, twist: 0, slot: 0.006 };
    case 'multi':
      return { n: Math.max(8, n), rin: 0.32, rout: 0.89, half: 0.0095, twist: 0.05, slot: 0 };
    case 'aero':
      // Mostly closed faces: short openings near the rim between wide, flat spokes.
      return { n, rin: 0.5, rout: 0.86, half: ((Math.PI * rimR * 0.68) / n) * 0.5, twist: 0.12, slot: 0 };
    case 'turbine':
      return { n, rin: 0.33, rout: 0.89, half: 0.016, twist: 0.8, slot: 0 };
    case 'blade':
      return { n, rin: 0.3, rout: 0.9, half: 0.017, grow: 0.08, twist: 0.6, slot: 0.005 };
    case 'disc':
      return { n, rin: 0.72, rout: 0.84, half: ((Math.PI * rimR * 0.78) / n) * 0.78, twist: 0.3, slot: 0 };
    default:
      return { n, rin: 0.33, rout: 0.88, half: 0.021, twist: 0, slot: 0 };
  }
}

/** The wheel face as a flat shape: the rim disc with the openings between the spokes cut out. */
function wheelShape(lay: WheelLayout, rimR: number): Shape {
  const face = new Shape();
  face.absarc(0, 0, rimR * 0.975, 0, Math.PI * 2, false);
  const rin = lay.rin * rimR + 0.006;
  const rout = lay.rout * rimR;
  const ang = (k: number, r: number) => (2 * Math.PI * k) / lay.n + lay.twist * clamp01((r - rin) / (rout - rin)) ** 1.2;
  const M = 7;
  for (let k = 0; k < lay.n; k++) {
    const left: Vector2[] = [];
    const right: Vector2[] = [];
    let ok = true;
    for (let i = 0; i <= M; i++) {
      const r = lerp(rin, rout, i / M);
      const a0 = ang(k, r) + Math.asin(Math.min(0.95, (lay.half + (lay.grow ?? 0) * r) / r));
      const a1 = ang(k + 1, r) - Math.asin(Math.min(0.95, (lay.half + (lay.grow ?? 0) * r) / r));
      if (a1 - a0 < 0.02) ok = false;
      left.push(new Vector2(Math.cos(a0) * r, Math.sin(a0) * r));
      right.push(new Vector2(Math.cos(a1) * r, Math.sin(a1) * r));
    }
    if (!ok) continue;
    const hole = new Path();
    hole.moveTo(left[0].x, left[0].y);
    for (const v of left.slice(1)) hole.lineTo(v.x, v.y);
    // Outer edge follows the rim; inner edge the hub.
    const aOut0 = Math.atan2(left[M].y, left[M].x);
    let aOut1 = Math.atan2(right[M].y, right[M].x);
    while (aOut1 < aOut0) aOut1 += Math.PI * 2;
    for (let i = 1; i < 6; i++) {
      const a = lerp(aOut0, aOut1, i / 6);
      hole.lineTo(Math.cos(a) * rout, Math.sin(a) * rout);
    }
    for (let i = M; i >= 0; i--) hole.lineTo(right[i].x, right[i].y);
    const aIn0 = Math.atan2(right[0].y, right[0].x);
    let aIn1 = Math.atan2(left[0].y, left[0].x);
    while (aIn1 > aIn0) aIn1 -= Math.PI * 2;
    for (let i = 1; i < 3; i++) {
      const a = lerp(aIn0, aIn1, i / 3);
      hole.lineTo(Math.cos(a) * rin, Math.sin(a) * rin);
    }
    face.holes.push(hole);
    if (lay.slot > 0) {
      // Split the spoke after this opening into a pair.
      const slot = new Path();
      const r0 = rin + (rout - rin) * 0.28;
      const pts: Vector2[] = [];
      for (let i = 0; i <= 4; i++) {
        const r = lerp(r0, rout, i / 4);
        const a = ang(k + 1, r) + lay.slot / r;
        pts.push(new Vector2(Math.cos(a) * r, Math.sin(a) * r));
      }
      for (let i = 4; i >= 0; i--) {
        const r = lerp(r0, rout, i / 4);
        const a = ang(k + 1, r) - lay.slot / r;
        pts.push(new Vector2(Math.cos(a) * r, Math.sin(a) * r));
      }
      slot.moveTo(pts[0].x, pts[0].y);
      for (const v of pts.slice(1)) slot.lineTo(v.x, v.y);
      face.holes.push(slot);
    }
  }
  return face;
}

function wheel(m: Mats, d: CarDesign, R: number, width: number, rimR: number): Group {
  const g = new Group();
  const hw = width / 2;
  // Tyre: bead, a bulging sidewall with a rim-protector rib, rounded shoulders and a tread with two grooves.
  const sw = R - rimR;
  const side = (s: number): Vector2[] => {
    const pts = [
      [rimR * 0.985, 0.86],
      [rimR + sw * 0.1, 0.94],
      [rimR + sw * 0.16, 0.98],
      [rimR + sw * 0.24, 0.96],
      [rimR + sw * 0.45, 1.0],
      [rimR + sw * 0.68, 0.99],
      [R - 0.03, 0.93],
      [R - 0.012, 0.84],
      [R - 0.003, 0.72],
      [R, 0.6],
    ].map(([r, z]) => new Vector2(r, s * z * hw));
    return s < 0 ? pts : pts.reverse();
  };
  const tread = [
    new Vector2(R, -0.3 * hw),
    new Vector2(R - 0.007, -0.27 * hw),
    new Vector2(R - 0.007, -0.21 * hw),
    new Vector2(R + 0.002, -0.18 * hw),
    new Vector2(R + 0.002, 0.18 * hw),
    new Vector2(R - 0.007, 0.21 * hw),
    new Vector2(R - 0.007, 0.27 * hw),
    new Vector2(R, 0.3 * hw),
  ];
  const prof = [...side(-1), ...tread, ...side(1)];
  const tyre = new Mesh(new LatheGeometry(prof, 64), m.tyre);
  tyre.rotation.x = Math.PI / 2;
  g.add(tyre);

  // The rim face sits almost flush with the sidewall, so the wheel reads at its real size from three-quarter
  // views instead of hiding behind the tyre bulge.
  const face = hw * 0.9;
  const barrel = new Mesh(new CylinderGeometry(rimR * 0.985, rimR * 0.985, width * 0.85, 40, 1, true), m.rimDark);
  barrel.rotation.x = Math.PI / 2;
  g.add(barrel);
  const back = new Mesh(new CylinderGeometry(rimR * 0.985, rimR * 0.985, 0.01, 40), m.rimDark);
  back.rotation.x = Math.PI / 2;
  back.position.z = face - 0.11;
  g.add(back);
  // Brake disc behind the spokes.
  const disc = new Mesh(new CylinderGeometry(rimR * 0.74, rimR * 0.74, 0.024, 36), m.rimDark);
  disc.rotation.x = Math.PI / 2;
  disc.position.z = face - 0.07;
  g.add(disc);

  // Rim lip: the bright rolled flange, which stands out past the bead seat (the nominal rim size) over the
  // tyre bead, so the visible wheel is a little bigger than the rim's nominal diameter, as on a real car.
  const flange = rimR + 0.016;
  const lipProf = [new Vector2(rimR * 0.94, 0), new Vector2(rimR * 0.985, 0.007), new Vector2(flange - 0.004, 0.006), new Vector2(flange, 0.0), new Vector2(flange - 0.002, -0.016)];
  const lip = new Mesh(new LatheGeometry(lipProf, 56), m.rim);
  lip.rotation.x = Math.PI / 2;
  lip.position.z = face;
  g.add(lip);

  // The face: spokes are what is left of a disc once the openings are cut out. Two-tone wheels have machined
  // faces (bright) over dark-painted sides.
  const lay = wheelLayout(d, rimR);
  const depth = 0.02;
  const geo = new ExtrudeGeometry(wheelShape(lay, rimR), { depth, bevelEnabled: true, bevelThickness: 0.004, bevelSize: 0.003, bevelSegments: 1, curveSegments: 40 });
  // Dish: the hub stands proud of the rim edge.
  const pos = geo.getAttribute('position') as BufferAttribute;
  for (let i = 0; i < pos.count; i++) {
    const r = Math.hypot(pos.getX(i), pos.getY(i));
    pos.setZ(i, pos.getZ(i) + 0.028 * (1 - r / rimR) ** 1.3);
  }
  geo.computeVertexNormals();
  const faceMats = d.wheel.finish === 'two-tone' ? [m.rim, m.rimDark] : [m.rim, m.rim];
  const spokes = new Mesh(geo, faceMats);
  spokes.position.z = face - depth - 0.012;
  g.add(spokes);
  const hub = new Mesh(new CylinderGeometry(0.06, 0.066, 0.02, 28), m.rim);
  hub.rotation.x = Math.PI / 2;
  hub.position.z = face + 0.02;
  g.add(hub);
  const cap = new Mesh(new CylinderGeometry(0.036, 0.036, 0.022, 24), m.rimDark);
  cap.rotation.x = Math.PI / 2;
  cap.position.z = face + 0.024;
  g.add(cap);
  return g;
}

// ---------------------------------------------------------------------------------------------------------
// Body

export function buildCar(d: CarDesign, paintHex: string): CarModel {
  const L = d.lengthMm / 1000;
  const W = d.widthMm / 1000;
  const H = d.heightMm / 1000;
  const WB = d.wheelbaseMm / 1000;
  const GC = d.clearanceMm / 1000;
  const p = d.profile;
  const { R, width: tyreW, rimR } = tyreFor(d);
  const archR = R + d.arch.gap;
  const archQ = d.arch.shape === 'squared' ? 3.2 : 2;
  const xF = L / 2;
  const axles = [xF - (L - WB) * d.frontOverhang, xF - (L - WB) * d.frontOverhang - WB];
  const xOf = (t: number) => xF - t * L;
  const tOf = (x: number) => (xF - x) / L;
  const m = materials(d, paintHex);

  // ---------- Side view ----------
  const T_NOSE = 0.035;
  const T_TAIL = 0.03;
  const beltPts = d.curves?.belt;
  const beltCurve = beltPts ? monotone(beltPts) : null;
  const belt = (t: number): number => {
    const a = p.cowlX;
    if (beltCurve && beltPts) {
      const c0 = beltPts[0][0];
      if (t >= c0) return H * beltCurve(t);
      return H * lerp(p.hoodCowlH, beltCurve(c0), smooth((t - a) / Math.max(1e-4, c0 - a)));
    }
    const b = Math.min(p.cowlX + 0.06, p.rearGlassX - 0.01);
    if (t <= b) return H * lerp(p.hoodCowlH, p.beltH, smooth((t - a) / (b - a)));
    return H * lerp(p.beltH, p.tailH, clamp01((t - b) / (p.rearGlassX - b)));
  };
  const hoodCurve = d.curves?.hood ? monotone(d.curves.hood) : null;
  const top = (t: number): number => {
    if (t <= p.cowlX && hoodCurve) return H * hoodCurve(t);
    if (t <= T_NOSE) return H * (p.noseH + (p.hoodFrontH - p.noseH) * Math.sin((Math.PI / 2) * (t / T_NOSE)));
    if (t <= p.cowlX) return H * lerp(p.hoodFrontH, p.hoodCowlH, (t - T_NOSE) / (p.cowlX - T_NOSE));
    if (t <= p.rearGlassX) return belt(t);
    if (t <= 1 - T_TAIL) return H * p.tailH;
    return H * (p.tailH - 0.05 * Math.sin((Math.PI / 2) * ((t - (1 - T_TAIL)) / T_TAIL)));
  };
  /** Height of the arch edge above the ground at x, or -Infinity outside the arches. */
  const archAt = (x: number): number => {
    let y = -Infinity;
    for (const ax of axles) {
      const u = Math.abs(x - ax) / archR;
      if (u < 1) y = Math.max(y, R + archR * (1 - u ** archQ) ** (1 / archQ));
    }
    return y;
  };
  /** The body's bottom edge ignoring the wheel arches. */
  const bottomBase = (t: number): number => {
    let y = GC;
    if (t < 0.07) y += 0.11 * (1 - t / 0.07) ** 2;
    if (t > 0.93) y += 0.09 * ((t - 0.93) / 0.07) ** 2;
    return y;
  };
  const bottom = (t: number): number => Math.max(bottomBase(t), archAt(xOf(t)));
  /** Top-down half width: superellipse corners at the nose and tail. */
  const se = (u: number, q: number) => (1 - (1 - clamp01(u)) ** q) ** (1 / q);
  const planHalf = (t: number): number => {
    const dn = t * L;
    const dr = (1 - t) * L;
    let k = 1;
    if (dn < d.plan.noseDepth) k = Math.min(k, se(dn / d.plan.noseDepth, d.plan.noseSquare));
    if (dr < d.plan.tailDepth) k = Math.min(k, se(dr / d.plan.tailDepth, d.plan.tailSquare));
    return (W / 2) * k;
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

  // ---------- Cross-section ----------
  const N_FLAT = 3;
  const N_BARC = 4;
  const sillTop = GC + d.clad.sillH;
  interface Section {
    pts: Array<[number, number]>;
    yb: number;
    yt: number;
    /** Where the top corner starts, and its size. */
    zA: number;
    yA: number;
    rtz: number;
    rty: number;
    /** Width at the bottom of the side. */
    zLow: number;
  }
  const sections = new Map<number, Section>();
  const section = (t: number): Section => {
    const key = Math.round(t * 1e5);
    const hit = sections.get(key);
    if (hit) return hit;
    // The section is laid out on the arch-free bottom, so every shoulder, crease and sill vertex keeps its
    // height from ring to ring; points below an arch are then collapsed onto the arch edge. Laying it out on
    // the arch itself squeezed the creases upward over each wheel and made the reflections wobble there.
    const yb = bottomBase(t);
    const yArch = archAt(xOf(t));
    const yt = Math.max(top(t), yb + 0.04, yArch + 0.04);
    const h = yt - yb;
    const x = xOf(t);
    // Haunches: full width over the wheels, a little in between.
    const flare = Math.max(...axles.map((ax) => Math.exp(-(((x - ax) / 0.6) ** 2))));
    const w = planHalf(t) * (0.975 + 0.025 * flare);
    const nose = t < 0.18 ? (1 - t / 0.18) ** 1.5 : 0;
    const tail = t > 0.9 ? ((t - 0.9) / 0.1) ** 1.5 : 0;
    const u = clamp01((t - 0.1) / 0.8);
    const drop = lerp(d.shoulder.drop[0], d.shoulder.drop[1], u);
    const rb = Math.min(0.08, h * 0.2, w * 0.4);
    const rty = Math.min(0.04 + 0.1 * nose * (0.4 + d.noseRound) + 0.05 * tail, h * 0.3, drop * 0.9);
    const rtz = Math.min(rty * 1.2, w * 0.4);
    const y0 = yb + rb;
    const yA = yt - rty;
    // Heights of the shoulder, the door crease and the cladding line, kept in order on short sections.
    const span = yA - y0;
    // The shoulder follows a straight line from the scuttle to the tail, not the window sill: a belt-line
    // kick-up at the C-pillar then fills in above the shoulder instead of dragging the whole flank up with it
    // (that drag was the lumpy reflection over the rear quarters).
    const inBelt = t > p.cowlX && t < p.rearGlassX;
    const ref = inBelt ? lerp(top(p.cowlX), top(p.rearGlassX), (t - p.cowlX) / (p.rearGlassX - p.cowlX)) : yt;
    let ys = Math.min(yt, ref) - drop;
    let yc = d.shoulder.crease ? H * lerp(d.shoulder.crease.y[0], d.shoulder.crease.y[1], u) : (y0 + ys) / 2;
    let ySill = sillTop;
    const cw = Math.min(0.025, span * 0.06);
    ys = Math.min(Math.max(ys, y0 + span * 0.45), yA - span * 0.08);
    yc = Math.min(Math.max(yc, y0 + span * 0.18), ys - cw - span * 0.08);
    ySill = Math.min(Math.max(ySill, y0 + span * 0.04), yc - cw - span * 0.05);
    // Tuck and tumble shrink with the section at the very nose and tail, so a narrow ring never folds
    // across the centre line (that fold showed as an X-shaped notch down the middle of the face).
    const tuck = Math.min(0.032, w * 0.2);
    const tumble = Math.min(d.shoulder.tumble, w * 0.3);
    const creaseDepth = Math.min(d.shoulder.crease?.depth ?? 0, w * 0.05);
    const zAt = (y: number): number => Math.max(0, y <= ys ? w - tuck * ((ys - y) / Math.max(1e-3, ys - yb)) ** 2 : w - tumble * ((y - ys) / Math.max(1e-3, yt - ys)) ** 1.25);
    const zA = zAt(yA);
    const pts: Array<[number, number]> = [];
    const zb = zAt(y0);
    for (let i = 0; i <= N_FLAT; i++) pts.push([((zb - rb) * i) / N_FLAT, yb]);
    for (let i = 1; i <= N_BARC; i++) {
      const a = -Math.PI / 2 + (Math.PI / 2) * (i / N_BARC);
      pts.push([zb - rb + rb * Math.cos(a), yb + rb + rb * Math.sin(a)]);
    }
    const run = (from: number, to: number, count: number) => {
      for (let i = 1; i <= count; i++) {
        const y = lerp(from, to, i / count);
        pts.push([zAt(y), y]);
      }
    };
    run(y0, ySill, 2);
    run(ySill, yc - cw, 3);
    pts.push([zAt(yc) - creaseDepth, yc]);
    pts.push([zAt(yc + cw), yc + cw]);
    run(yc + cw, ys, 3);
    // A sharp shoulder repeats its point, so the surface normals break there.
    const ysNext = lerp(ys, yA, 1 / 3);
    pts.push(d.shoulder.sharp ? [zAt(ys), ys] : [zAt(lerp(ys, ysNext, 0.5)), lerp(ys, ysNext, 0.5)]);
    run(ys, yA, 3);
    for (let i = 1; i <= 6; i++) {
      const a = (Math.PI / 2) * (i / 6);
      pts.push([zA - rtz * (1 - Math.cos(a)), yA + rty * Math.sin(a)]);
    }
    // The bonnet is domed more than the rest of the body top; the dome fades out at the scuttle.
    const crownMax = lerp(0.022, d.hoodCrown, smooth((p.cowlX - t) / 0.06));
    const crown = Math.min(crownMax, w * 0.06);
    const zc = zA - rtz;
    for (let i = 1; i <= 5; i++) {
      const z = zc * (1 - i / 5);
      pts.push([z, yt + crown * (1 - (z / Math.max(1e-6, zc)) ** 2)]);
    }
    if (yArch > yb) {
      // Over a wheel: the floor rises to the arch and the side points below it collapse onto its edge.
      const zEdge = zAt(yArch);
      pts.forEach((pt, k) => {
        if (pt[1] >= yArch) return;
        pts[k] = [k <= N_FLAT ? Math.min(pt[0], zEdge) : zEdge, yArch];
      });
    }
    const s: Section = { pts, yb: Math.max(yb, yArch), yt, zA, yA, rtz, rty, zLow: zb };
    sections.set(key, s);
    return s;
  };
  const SIDE_PTS = section(0.5).pts.length;
  const SILL_IDX = N_FLAT + 1 + N_BARC + 2;
  /** Half width of the body surface at station t and height y, or null when y misses the section. */
  const halfWidthAt = (t: number, y: number): number | null => {
    const { pts } = section(t);
    let best: number | null = null;
    for (let k = N_FLAT; k < pts.length - 1; k++) {
      const [z0, y0] = pts[k];
      const [z1, y1] = pts[k + 1];
      if ((y - y0) * (y - y1) > 0 || y0 === y1) continue;
      const z = lerp(z0, z1, (y - y0) / (y1 - y0));
      if (best === null || z > best) best = z;
    }
    return best;
  };

  // ---------- Lower body ----------
  const ring = (t: number): Vector3[] => {
    const side = section(t).pts;
    const x = xOf(t);
    const out = side.map(([z, y]) => new Vector3(x + faceShift(t, y), y, z));
    for (let j = side.length - 2; j >= 1; j--) out.push(new Vector3(x + faceShift(t, side[j][1]), side[j][1], -side[j][0]));
    return out;
  };
  const sourceIndex = (j: number, n: number) => (j < SIDE_PTS ? j : n - j);

  const tSet = new Set<number>([T_NOSE, 0.05, 0.07, 0.09, 0.12, p.cowlX, p.rearGlassX, 0.88, 0.91, 0.93, 0.95, 0.965, 0.975, 0.985, 0.992, 0.997, 1]);
  for (let k = 0; k <= 18; k++) tSet.add((d.plan.noseDepth / L) * (k / 18) ** 2.2);
  for (let k = 0; k <= 14; k++) tSet.add(1 - (d.plan.tailDepth / L) * (k / 14) ** 2.2);
  for (let t = 0.12; t < 0.96; t += 0.011) tSet.add(t);
  for (const ax of axles) for (let x = ax - archR - 0.04; x <= ax + archR + 0.04; x += 0.018) tSet.add(clamp01(tOf(x)));
  // Drop stations that land almost on top of another one (the even spacing and the arch spacing interleave):
  // a sliver of quads between two near-identical rings showed as fine vertical ripples in the reflections.
  const keep = new Set([T_NOSE, p.cowlX, p.rearGlassX, 1].map((t) => Math.round(t * 1e5) / 1e5));
  const tList = [...tSet]
    .map((t) => Math.round(clamp01(t) * 1e5) / 1e5)
    .sort((a, b) => a - b)
    .reduce<number[]>((out, t) => {
      const last = out[out.length - 1];
      // Only thin between the nose and the last few centimetres of the tail; the nose and tail-corner
      // roundings need their dense stations.
      const thin = t >= 0.12 && t <= 1 - 0.04 / L;
      if (last === undefined || !thin || (t - last) * L >= 0.012) out.push(t);
      else if (keep.has(t) && !keep.has(last)) out[out.length - 1] = t;
      return out;
    }, []);

  const group = new Group();
  const lowerRings = tList.map(ring);
  const n = lowerRings[0].length;
  const lowerMats: Material[] = [m.paint, m.clad, m.under];
  const clad = d.cladding ? d.clad : null;
  /** Is a point on the cladding: the band round each arch, the sills, and (optionally) the lower bumpers? */
  const onClad = (x: number, y: number, t: number): boolean => {
    if (!clad) return false;
    // The arch bands are separate proud mouldings (below); on the body only the sill line is a clean
    // horizontal edge, because the section has a vertex exactly there.
    const between = x < axles[0] && x > axles[1];
    return y < sillTop && (between || clad.bumpers || (t > 0.05 && t < 0.95));
  };
  const body = loft(
    lowerRings,
    true,
    (i, j) => {
      const src = Math.min(sourceIndex(j, n), sourceIndex((j + 1) % n, n));
      if (src < N_FLAT) return 2;
      const a = lowerRings[i][j];
      const b = lowerRings[i][(j + 1) % n];
      const c = lowerRings[i + 1][j];
      const e = lowerRings[i + 1][(j + 1) % n];
      const x = (a.x + b.x + c.x + e.x) / 4;
      const y = (a.y + b.y + c.y + e.y) / 4;
      // Everything below the section's sill vertex row is cladding, so its top edge is one clean line round
      // the car, rising over the bumpers where the body lifts, instead of stepping from ring to ring.
      return src < SILL_IDX - 1 && onClad(x, Math.min(y, sillTop - 0.001), (tList[i] + tList[i + 1]) / 2) ? 1 : 0;
    },
    lowerMats,
  );
  group.add(body);

  // ---------- Glasshouse ----------
  const roofHalf = (t: number) => {
    const k = clamp01((t - p.cowlX) / Math.max(0.05, p.roofRearX - p.cowlX));
    return (W / 2) * d.roofWidth * lerp(d.plan.roofTaper, 1, smooth(k * 1.8)) * (planHalf(t) / (W / 2));
  };
  const roofCurve = d.curves?.roof ? monotone(d.curves.roof) : null;
  const ghTop = (t: number): number => {
    if (t <= p.cowlX) return belt(t);
    if (t <= p.roofFrontX) {
      const u = clamp01((t - p.cowlX) / (p.roofFrontX - p.cowlX));
      const roofF = roofCurve ? H * roofCurve(p.roofFrontX) : H * p.roofH;
      return belt(t) + (roofF - belt(t)) * (1 - (1 - u) ** 1.5);
    }
    if (t <= p.roofRearX) {
      if (roofCurve) return H * roofCurve(t);
      return H * lerp(p.roofH, p.roofRearH, smooth((t - p.roofFrontX) / (p.roofRearX - p.roofFrontX)) ** 1.3);
    }
    if (t >= p.rearGlassX) return belt(t);
    const u = clamp01((t - p.roofRearX) / (p.rearGlassX - p.roofRearX));
    const rr = roofCurve ? H * roofCurve(p.roofRearX) : H * p.roofRearH;
    return rr + (belt(t) - rr) * u ** 1.6;
  };
  const N_GS = 8;
  const N_GC = 5;
  const N_GT = 5;
  const ghSide = (t: number): Array<[number, number]> => {
    const s = section(t);
    // Sit the glasshouse on the body's top corner, a little inside it.
    const zg = s.zA - s.rtz * 0.6;
    const yg = s.yA + s.rty * Math.sin(Math.acos(0.4)) - 0.006;
    const yt = Math.max(ghTop(t), yg + 0.0005);
    const h = yt - yg;
    const wtop = Math.min(roofHalf(t), zg);
    const r = Math.min(0.06, h * 0.4, wtop * 0.5);
    const pts: Array<[number, number]> = [];
    for (let i = 0; i <= N_GS; i++) {
      const u = i / N_GS;
      pts.push([lerp(zg, wtop, u) + 0.014 * Math.sin(Math.PI * u) * Math.min(1, h / 0.3), yg + (h - r) * u]);
    }
    for (let i = 1; i <= N_GC; i++) {
      const a = (Math.PI / 2) * (i / N_GC);
      pts.push([wtop - r + r * Math.cos(a), yt - r + r * Math.sin(a)]);
    }
    for (let i = 1; i <= N_GT; i++) {
      const z = (wtop - r) * (1 - i / N_GT);
      pts.push([z, yt + 0.016 * (1 - (z / Math.max(1e-6, wtop - r)) ** 2)]);
    }
    return pts;
  };
  const ghHalfAt = (t: number, y: number): number => {
    const pts = ghSide(t);
    for (let k = 0; k < N_GS + N_GC; k++) {
      const [z0, y0] = pts[k];
      const [z1, y1] = pts[k + 1];
      if (y >= y0 && y <= y1 && y1 > y0) return lerp(z0, z1, (y - y0) / (y1 - y0));
    }
    return pts[0][0];
  };
  /** Height of the roof skin at station t and half width z. */
  const ghYAt = (t: number, z: number): number => {
    const pts = ghSide(t);
    for (let k = N_GS; k < pts.length - 1; k++) {
      const [z0, y0] = pts[k];
      const [z1, y1] = pts[k + 1];
      if ((z - z0) * (z - z1) <= 0 && z0 !== z1) return lerp(y0, y1, (z - z0) / (z1 - z0));
    }
    return ghTop(t);
  };
  const ghRing = (t: number) => {
    const side = ghSide(t);
    const x = xOf(t);
    const out = side.map(([z, y]) => new Vector3(x, y, z));
    for (let j = side.length - 2; j >= 0; j--) out.push(new Vector3(x, side[j][1], -side[j][0]));
    return out;
  };
  // The rear edge of the side glass slants, and the window graphic is picked per quad, so the rings are
  // packed closer there to keep that edge from stepping.
  const slantT0 = p.dloX - d.glass.rearSlant / L - 0.006;
  const slantT1 = p.dloX + 0.004;
  const ghT: number[] = [];
  for (let t = p.cowlX; t < p.rearGlassX; t += t > slantT0 && t < slantT1 ? 0.0012 : 0.005) ghT.push(t);
  ghT.push(p.rearGlassX);
  const ghRings = ghT.map(ghRing);
  const ghN = ghRings[0].length;
  const GH_HALF = N_GS + 1 + N_GC + N_GT;
  const fastback = d.body === 'coupe' || d.body === 'sedan';
  const pillarsAt = d.glass.pillarsAt ?? [lerp(p.roofFrontX, Math.min(p.roofRearX, p.dloX), fastback ? 0.55 : 0.42), ...(d.body === 'micro' ? [] : [Math.min(p.roofRearX - 0.02, p.dloX - 0.07)])];
  const bX = pillarsAt[0];
  const cX = pillarsAt[1] ?? p.dloX;
  // On a fastback the roof skin runs most of the way down the slope; only its last part is glass.
  const roofEnd = fastback ? p.rearGlassX - 0.1 : p.roofRearX;
  const aMat = d.pillars === 'black' ? m.black : m.paint;
  const rearMat = d.glass.rearPillar === 'black' ? m.black : m.paint;
  const roofMat = d.roof === 'black' ? m.black : m.paint;
  const frameMat = d.pillars === 'black' || d.roof === 'black' ? m.black : m.paint;
  const FRAME = 0.045;
  const aShift = 0.075 / L;
  const rShift = 0.06 / L;
  const dloTop = (t: number) => Math.min(ghTop(t) - FRAME, ghTop(t - aShift) - 0.012, ghTop(t + rShift) - 0.012, H * p.roofH - FRAME);
  const dloEnd = (y: number) => {
    const yb = belt(p.dloX);
    const k = clamp01((y - yb) / Math.max(0.05, ghTop(p.dloX) - yb));
    return p.dloX - (d.glass.rearSlant / L) * k;
  };
  const ghMats: Material[] = [m.glass, aMat, roofMat, m.black, rearMat, frameMat];
  const greenhouse = loft(
    ghRings,
    false,
    (i, j) => {
      const t = (ghT[i] + ghT[i + 1]) / 2;
      const src = Math.min(j < GH_HALF ? j : ghN - 1 - j, j + 1 < GH_HALF ? j + 1 : ghN - 2 - j);
      if (src >= N_GS + N_GC) return t > p.roofFrontX + 0.01 && t < roofEnd - 0.005 ? 2 : 0;
      const y = (ghRings[i][j].y + ghRings[i][j + 1].y + ghRings[i + 1][j].y + ghRings[i + 1][j + 1].y) / 4;
      const top = ghTop(t);
      if (y > top - 0.012 && t > p.roofFrontX && t < roofEnd) return 2;
      if (t < p.roofFrontX && y > top - 0.03 && src >= N_GS) return 1;
      const end = dloEnd(y);
      if (t > end) return 4;
      if (y > dloTop(t)) return t < p.roofFrontX - 0.01 ? 1 : 5;
      if (y < belt(t) + 0.012) return 5;
      if (Math.abs(t - bX) < 0.036 / L) return 3;
      if (pillarsAt.length > 1 && Math.abs(t - cX) < 0.03 / L) return 3;
      if (t < p.cowlX + 0.012) return 1;
      return 0;
    },
    ghMats,
  );
  group.add(greenhouse);

  // ---------- Side details ----------
  const sidePoint = (x: number, y: number, zSign: number, off = 0.004) => new Vector3(x, y, zSign * ((halfWidthAt(clamp01(tOf(x)), y) ?? section(clamp01(tOf(x))).zLow) + off));
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
  const archPoint = (ax: number, a: number, r: number): [number, number] => {
    const c = Math.cos(a);
    const s = Math.sin(a);
    const k = 1 / (Math.abs(c) ** archQ + Math.abs(s) ** archQ) ** (1 / archQ);
    return [ax + c * r * k, R + s * r * k];
  };
  // Wheel-arch liners, so the inside of the body never shows round the tyres.
  for (const ax of axles) {
    const liner: Array<[Vector3, Vector3]> = [];
    const zw = W / 2 - 0.015;
    for (let i = 0; i <= 24; i++) {
      const [x, y] = archPoint(ax, -0.15 + ((Math.PI + 0.3) * i) / 24, archR - 0.008);
      liner.push([new Vector3(x, y, zw), new Vector3(x, y, -zw)]);
    }
    group.add(strip(liner, m.under));
  }
  for (const zSign of [1, -1]) {
    if (clad) {
      // Arch cladding stands proud of the body: a face band plus the lip that wraps into the arch.
      for (const ax of axles) {
        // The face band is a small grid (several rows across its width) that follows the body surface
        // point by point; a two-edge strip cut through the curved flank and let paint show through in
        // scallops over the arch.
        const ROWS = 5;
        const zBody = (x: number, y: number) => {
          const t = clamp01(tOf(x));
          return Math.max(halfWidthAt(t, y) ?? 0, section(t).zLow);
        };
        const faceRings: Vector3[][] = [];
        const lipBand: Array<[Vector3, Vector3]> = [];
        for (let i = 0; i <= 40; i++) {
          const a = -0.12 + ((Math.PI + 0.24) * i) / 40;
          const row: Vector3[] = [];
          for (let r = 0; r <= ROWS; r++) {
            const u = r / ROWS;
            const [x, y] = archPoint(ax, a, archR - 0.004 + (clad.archWidth + 0.004) * u);
            // Full thickness most of the way out, then a rounded fall to the body at the outer edge.
            const off = clad.proud * (u < 0.6 ? 1 : 0.25 + 0.75 * Math.cos(((u - 0.6) / 0.4) * (Math.PI / 2)));
            row.push(new Vector3(x, y, zSign * (zBody(x, Math.max(y, GC + 0.02)) + off + 0.001)));
          }
          if (zSign < 0) row.reverse();
          faceRings.push(row);
          const [xi, yi] = archPoint(ax, a, archR - 0.004);
          const zi = zBody(xi, Math.max(yi, GC + 0.02));
          lipBand.push([new Vector3(xi, yi, zSign * (zi - 0.03)), new Vector3(xi, yi, zSign * (zi + clad.proud + 0.001))]);
        }
        if (zSign < 0) lipBand.forEach((pair) => pair.reverse());
        group.add(loft(faceRings, false, () => 0, [m.clad]));
        group.add(strip(lipBand, m.clad));
      }
      // Sill moulding between the arches.
      const x0 = axles[0] - archR - clad.archWidth * 0.5;
      const x1 = axles[1] + archR + clad.archWidth * 0.5;
      const sill: Array<[Vector3, Vector3]> = [];
      for (let i = 0; i <= 12; i++) {
        const x = lerp(x0, x1, i / 12);
        const t = clamp01(tOf(x));
        const z = section(t).zLow + clad.proud * 0.6;
        sill.push([new Vector3(x, GC + 0.015, zSign * z), new Vector3(x, sillTop - 0.01, zSign * ((halfWidthAt(t, sillTop - 0.01) ?? z) + clad.proud * 0.3))]);
      }
      if (zSign < 0) sill.forEach((pair) => pair.reverse());
      group.add(strip(sill, m.clad));
    }
    // Door shut lines.
    const sill = Math.max(GC + 0.1, clad ? sillTop + 0.01 : 0);
    const doorLines = [p.cowlX + 0.03, bX + 0.005, d.body === 'micro' ? null : Math.min(cX, p.dloX) - 0.01].filter((t): t is number => t !== null);
    for (const t of doorLines) {
      const x = xOf(t);
      const yTop = belt(t) - 0.014;
      const path: Array<[number, number]> = [];
      const y0 = Math.max(sill, bottom(t) + 0.02);
      for (let k = 0; k <= 12; k++) path.push([x + 0.012 * Math.sin((k / 12) * Math.PI), lerp(y0, yTop, k / 12)]);
      group.add(sideRibbon(path, 0.004, m.under, zSign, 0.003));
    }
    // Beltline trim under the side glass.
    if (d.glass.trim !== 'none') {
      const path: Array<[number, number]> = [];
      for (let k = 0; k <= 30; k++) {
        const t = lerp(p.cowlX + 0.03, dloEnd(belt(p.dloX)), k / 30);
        path.push([xOf(t), belt(t) - 0.01]);
      }
      group.add(sideRibbon(path, d.glass.trim === 'chrome' ? 0.014 : 0.01, d.glass.trim === 'chrome' ? m.chrome : m.black, zSign, 0.003));
    }
    // Door handles.
    const handleTs = [bX - 0.04, Math.min(cX, p.dloX) - 0.05];
    handleTs.forEach((t, i) => {
      const x = xOf(t);
      if (i === 1 && d.handles === 'pillar-rear') {
        // Hidden rear handle: a short vertical grip up in the C-pillar.
        const tp = dloEnd(belt(p.dloX)) + 0.015;
        const yb = belt(tp) + 0.03;
        const pts: Array<[Vector3, Vector3]> = [];
        for (let k = 0; k <= 3; k++) {
          const y = yb + 0.03 * k;
          const z = zSign * (ghHalfAt(tp, y) + 0.004);
          pts.push([new Vector3(xOf(tp) + 0.015, y, z), new Vector3(xOf(tp) - 0.015, y, z)]);
        }
        if (zSign < 0) pts.forEach((pair) => pair.reverse());
        group.add(strip(pts, m.matte));
        return;
      }
      const y = belt(t) - 0.075;
      const flush = d.handles === 'flush';
      group.add(sideRibbon([[x + 0.065, y], [x - 0.065, y]], flush ? 0.02 : 0.028, flush ? m.black : m.chrome, zSign, flush ? 0.003 : 0.009));
    });
    // Mirror on the door, at the base of the A-pillar.
    // A real mirror: a base plate on the door top, a short arm, and a housing that is wide across the car,
    // shallow front to back, with a flat glass face toward the rear.
    const mt = p.cowlX + 0.045;
    const ms = section(mt);
    const mBelt = belt(mt);
    const zBase = Math.min(ms.zA, ghHalfAt(mt, mBelt + 0.03) + 0.01);
    const base = new Mesh(new BoxGeometry(0.12, 0.06, 0.03), m.black);
    base.position.set(xOf(mt) + 0.01, mBelt + 0.025, zSign * zBase);
    group.add(base);
    const arm = new Mesh(new BoxGeometry(0.06, 0.028, 0.09), m.black);
    arm.position.set(xOf(mt) - 0.005, mBelt + 0.045, zSign * (zBase + 0.05));
    group.add(arm);
    const housing = new Mesh(new SphereGeometry(0.5, 24, 16), d.roof === 'black' ? m.black : m.paint);
    housing.scale.set(0.1, 0.13, 0.24);
    const mz = zSign * (zBase + 0.15);
    housing.position.set(xOf(mt) - 0.02, mBelt + 0.085, mz);
    housing.rotation.y = zSign * 0.12;
    group.add(housing);
    const glassFace = new Mesh(new CylinderGeometry(0.5, 0.5, 0.01, 24), m.housing);
    glassFace.scale.set(0.1, 1, 0.2);
    glassFace.rotation.set(0, zSign * 0.12, Math.PI / 2);
    glassFace.position.set(xOf(mt) - 0.059, mBelt + 0.085, mz);
    group.add(glassFace);
    if (d.roofRails) {
      // Rails stand on the actual roof skin at their own width (which is lower than the centre line), on
      // three solid feet, so they never float.
      const rail: Vector3[] = [];
      const surf: number[] = [];
      const RISE = 0.042;
      for (let k = 0; k <= 8; k++) {
        const t = lerp(p.roofFrontX + 0.04, p.roofRearX - 0.015, k / 8);
        const z = roofHalf(t) * 0.8;
        const y = ghYAt(t, z);
        surf.push(y);
        rail.push(new Vector3(xOf(t), y + RISE, zSign * z));
      }
      group.add(new Mesh(new TubeGeometry(new CatmullRomCurve3(rail), 24, 0.012, 8), m.black));
      for (const k of [0, 4, 8]) {
        const hgt = RISE + 0.008;
        const leg = new Mesh(new BoxGeometry(k === 4 ? 0.06 : 0.11, hgt, 0.026), m.black);
        leg.position.set(rail[k].x, surf[k] + hgt / 2 - 0.006, rail[k].z);
        group.add(leg);
      }
    }
  }
  if (d.spoiler && fastback) {
    // Ducktail across the top of the boot lid.
    const t = p.rearGlassX + 0.01;
    const lip = new Mesh(new BoxGeometry(0.1, 0.022, section(t).zA * 1.9), m.paint);
    lip.position.set(xOf(t), belt(p.rearGlassX) + 0.01, 0);
    lip.rotation.z = -0.12;
    group.add(lip);
  } else if (d.spoiler) {
    const t = p.roofRearX;
    const lip = new Mesh(new BoxGeometry(0.13, 0.03, roofHalf(t) * 1.7), d.roof === 'black' ? m.black : m.paint);
    lip.position.set(xOf(t) - 0.02, ghTop(t) - 0.004, 0);
    lip.rotation.z = 0.12;
    group.add(lip);
  }

  // ---------- Lamps and panels on the front and rear faces ----------
  type OutlinePt = { x: number; z: number; s: number; nx: number; nz: number };
  const outlines = new Map<string, OutlinePt[]>();
  const outline = (front: boolean, y: number): OutlinePt[] => {
    const key = `${front}:${Math.round(y * 2000)}`;
    const hit = outlines.get(key);
    if (hit) return hit;
    const raw: Array<{ x: number; z: number }> = [];
    for (let k = 0; k <= 200; k++) {
      const u = 0.3 * (k / 200) ** 1.6;
      const t = front ? u : 1 - u;
      const z = halfWidthAt(t, y);
      if (z === null) continue;
      if (raw.length === 0) raw.push({ x: xOf(t) + faceShift(t, y), z: 0 });
      raw.push({ x: xOf(t) + faceShift(t, y), z });
    }
    const out: OutlinePt[] = [];
    let acc = 0;
    raw.forEach((pt, i) => {
      if (i > 0) acc += Math.hypot(pt.x - raw[i - 1].x, pt.z - raw[i - 1].z);
      const a = raw[Math.max(0, i - 1)];
      const b = raw[Math.min(raw.length - 1, Math.max(1, i + 1))];
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
  const matFor = (kind: FaceKind): Material => {
    switch (kind) {
      case 'drl':
        return m.drl;
      case 'turn':
        return m.turn;
      case 'tail':
        return m.tail;
      case 'lens':
        return m.lens;
      case 'chrome':
        return m.chrome;
      case 'satin':
      case 'skid':
        return m.satin;
      case 'housing':
        return m.housing;
      case 'trim':
      case 'gloss':
        return m.black;
      case 'body':
        return m.paint;
      case 'clad':
        return m.clad;
      default:
        return m.matte;
    }
  };
  const offFor = (kind: FaceKind, lift = 0) =>
    (kind === 'drl' || kind === 'tail' || kind === 'turn' ? 0.008 : kind === 'lens' || kind === 'satin' || kind === 'chrome' || kind === 'skid' ? 0.0065 : kind === 'body' ? 0.003 : 0.005) + lift / 1000;

  const polyItem = (front: boolean, poly: FacePt[], mirrorSign: number, off: number, mat: Material): boolean => {
    const contour = poly.map(([s, y]) => new Vector2(s * mirrorSign * (W / 2), y * H));
    if (ShapeUtils.isClockWise(contour)) contour.reverse();
    const tris = ShapeUtils.triangulateShape(contour, []);
    const pos: number[] = [];
    let ok = true;
    const emit = (a: Vector2, b: Vector2, c: Vector2, depth: number) => {
      if (!ok) return;
      const longest = Math.max(a.distanceTo(b), b.distanceTo(c), c.distanceTo(a));
      if (longest > 0.03 && depth < 12) {
        // Halve the longest edge only, so long thin slats stay a few triangles thick.
        const [p, q, r] = a.distanceTo(b) === longest ? [a, b, c] : b.distanceTo(c) === longest ? [b, c, a] : [c, a, b];
        const mid = p.clone().add(q).multiplyScalar(0.5);
        emit(p, mid, r, depth + 1);
        emit(mid, q, r, depth + 1);
        return;
      }
      for (const v of [a, b, c]) {
        const pt = facePoint(front, v.x / (W / 2), v.y / H, off);
        if (!pt) {
          ok = false;
          return;
        }
        pos.push(pt.x, pt.y, pt.z);
      }
    };
    for (const [i, j, k] of tris) emit(contour[i], contour[j], contour[k], 0);
    if (ok && pos.length) group.add(triangles(pos, mat));
    return ok;
  };
  const patternPolys = (it: FacePattern): FacePt[][] => {
    const [s0, s1, y0, y1] = it.rect;
    const ps = it.pitch / 1000 / (W / 2);
    const py = it.pitch / 1000 / H;
    const f = it.fill ?? 0.5;
    const out: FacePt[][] = [];
    const eps = 1e-6;
    switch (it.pattern) {
      case 'slats-h':
        for (let y = y0; y + py * f <= y1 + eps; y += py) out.push([[s0, y], [s1, y], [s1, y + py * f], [s0, y + py * f]]);
        break;
      case 'slats-v':
        for (let s = s0; s + ps * f <= s1 + eps; s += ps) out.push([[s, y0], [s + ps * f, y0], [s + ps * f, y1], [s, y1]]);
        break;
      default: {
        let row = 0;
        for (let y = y0; y + py * f <= y1 + eps; y += py, row++) {
          const shift = row % 2 ? ps / 2 : 0;
          for (let s = s0 + shift; s + ps * f <= s1 + eps; s += ps) {
            const w = ps * f;
            const h = py * f;
            if (it.pattern === 'triangles') out.push(row % 2 ? [[s, y + h], [s + w / 2, y], [s + w, y + h]] : [[s, y], [s + w, y], [s + w / 2, y + h]]);
            else if (it.pattern === 'diamonds') out.push([[s + w / 2, y], [s + w, y + h / 2], [s + w / 2, y + h], [s, y + h / 2]]);
            else if (it.pattern === 'chevrons') {
              const k = 0.32;
              out.push([[s, y + h], [s + w / 2, y], [s + w, y + h], [s + w * (1 - k / 2), y + h], [s + w / 2, y + h * k * 1.6], [s + (w * k) / 2, y + h]]);
            } else out.push([[s, y], [s + w, y], [s + w, y + h], [s, y + h]]);
          }
        }
      }
    }
    return out;
  };

  const faceItem = (front: boolean, item: FaceItem, mirrorSign: number) => {
    if ('pattern' in item) {
      const it = item as FacePattern;
      const mat = matFor(it.kind);
      for (const poly of patternPolys(it)) if (!polyItem(front, poly, mirrorSign, offFor(it.kind, it.lift ?? 2), mat)) return offBody(d.name, item);
      return;
    }
    if ('poly' in item) {
      const it = item as FacePoly;
      if (!polyItem(front, it.poly, mirrorSign, offFor(it.kind, it.lift), matFor(it.kind))) offBody(d.name, item);
      return;
    }
    if ('rect' in item) {
      const it = item as FacePanel;
      const [s0, s1, y0, y1] = it.rect;
      const ns = Math.max(2, Math.ceil((Math.abs(s1 - s0) * (W / 2)) / 0.02) + 1);
      const ny = Math.max(2, Math.ceil(((y1 - y0) * H) / 0.02) + 1);
      const cols: Vector3[][] = [];
      for (let i = 0; i < ns; i++) {
        const s = lerp(s0, s1, i / (ns - 1)) * mirrorSign;
        const col: Vector3[] = [];
        for (let j = 0; j < ny; j++) {
          const pt = facePoint(front, s, lerp(y0, y1, j / (ny - 1)), offFor(it.kind, it.lift));
          if (!pt) return offBody(d.name, item);
          col.push(pt);
        }
        cols.push(col);
      }
      const rows = cols[0].length;
      const pos: number[] = [];
      for (let i = 0; i < cols.length - 1; i++) {
        for (let j = 0; j < rows - 1; j++) {
          const [a, b, c, e] = [cols[i][j], cols[i + 1][j], cols[i][j + 1], cols[i + 1][j + 1]];
          pos.push(a.x, a.y, a.z, b.x, b.y, b.z, c.x, c.y, c.z, c.x, c.y, c.z, b.x, b.y, b.z, e.x, e.y, e.z);
        }
      }
      group.add(triangles(pos, matFor(it.kind)));
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
      const a = facePoint(front, (s + os / (W / 2)) * mirrorSign, y + oy / H, offFor(line.kind, line.lift));
      const b = facePoint(front, (s - os / (W / 2)) * mirrorSign, y - oy / H, offFor(line.kind, line.lift));
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
      // Tyre sidewall almost flush with the body side, as on the real cars (a sunk-in wheel reads as small).
      w.position.set(ax, R, zSign * (W / 2 - tyreW / 2 - 0.005));
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
  return { group, wheels, wheelRadius: R, paint: m.paint, headlights: [m.drl], taillights: [m.tail], lampGlow: d.lampGlow, length: L, dispose: disposeAll };
}
