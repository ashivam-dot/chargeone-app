import type { BodyStyle, CarDesign, CarPaint, FaceItem } from './carDesign.ts';

// One design per car in the catalogue, keyed by the start of its vehicle id. Sizes, wheelbase, clearance and
// rim are the makers' published figures; profile fractions, light layouts and paint colours were estimated
// from photos and press images (research/car-designs.md in the task folder) and tuned by eye in lab/car.html.

type FrontStyle = 'bar-split' | 'bar-down' | 'c-shape' | 'fang' | 'swept' | 'corners' | 'pixel' | 'v-face' | 'boomerang' | 'drop' | 'strip' | 'thin';
type RearStyle = 'bar' | 'x-bar' | 'u-bar' | 'c-shape' | 'separate' | 'vertical' | 'wrap' | 'pixel' | 'thin' | 'boomerang';

interface Spec {
  name: string;
  body: BodyStyle;
  size: [lengthMm: number, widthMm: number, heightMm: number, wheelbaseMm: number, clearanceMm: number, rimInch: number];
  /** cowlX, roofFrontX, roofRearX, rearGlassX, hoodFrontH, hoodCowlH, beltH, roofH, tailH (research/car-designs.json). */
  profile: [number, number, number, number, number, number, number, number, number];
  front: FrontStyle;
  rear: RearStyle;
  floatingRoof?: boolean;
  blackRoof?: boolean;
  cladding?: boolean;
  roofRails?: boolean;
  flushHandles?: boolean;
  spokes?: number;
  wheel?: CarDesign['wheel']['style'];
  finish?: CarDesign['wheel']['finish'];
  frontOverhang?: number;
  noseRound?: number;
  /** Metres the front face leans back from the bumper line; default 0.08. */
  faceRake?: number;
  /** Where the side windows end (default: just ahead of the rear glass, or halfway down a fastback). */
  dloX?: number;
  /** Roof height where it starts to fall (default: a little under roofH). */
  roofRearH?: number;
  /** Published tyre size [section mm, aspect %]. */
  tyre?: [number, number];
  curves?: CarDesign['curves'];
  plan?: Partial<CarDesign['plan']>;
  shoulder?: Partial<CarDesign['shoulder']>;
  glass?: Partial<CarDesign['glass']>;
  arch?: Partial<CarDesign['arch']>;
  clad?: Partial<CarDesign['clad']>;
  handles?: CarDesign['handles'];
  lampGlow?: number;
  /** A bespoke light signature and face, replacing the `front` / `rear` preset. */
  frontItems?: (n: number) => FaceItem[];
  rearItems?: (t: number) => FaceItem[];
  paints: Array<[name: string, hex: string]>;
}

// Bespoke faces for the cars whose signature carries their identity. Observed from the free-licence
// reference photos listed in research/car-designs.md; coordinates are design numbers, not traced.

/** Nexon EV (2023 facelift): thin full-width DRL bar on the bonnet edge, closed body-colour panel, split
 * headlamps in black bumper-corner pods, wide lower dam with silver strakes, silver skid. */
function nexonFront(n: number): FaceItem[] {
  return [
    { kind: 'gloss', rect: [-0.9, 0.9, n - 0.03, n - 0.004] },
    { kind: 'drl', pts: [[0, n - 0.016], [0.9, n - 0.016], [0.99, n - 0.03]], w: 8, mirror: true },
    { kind: 'body', pattern: 'slats-h', rect: [-0.5, 0.5, n - 0.12, n - 0.05], pitch: 16, fill: 0.45, lift: 1 },
    { kind: 'gloss', poly: [[0.6, n - 0.27], [0.97, n - 0.2], [0.99, n - 0.07], [0.9, n - 0.06], [0.64, n - 0.15]], mirror: true },
    { kind: 'drl', pts: [[0.97, n - 0.04], [0.93, n - 0.1], [0.72, n - 0.2]], w: 7, mirror: true },
    { kind: 'satin', rect: [0.76, 0.86, n - 0.22, n - 0.17], mirror: true },
    { kind: 'satin', rect: [0.86, 0.94, n - 0.18, n - 0.135], mirror: true },
    { kind: 'intake', poly: [[-0.7, 0.155], [0.7, 0.155], [0.8, 0.3], [0.6, 0.33], [-0.6, 0.33], [-0.8, 0.3]] },
    { kind: 'satin', pattern: 'slats-h', rect: [-0.62, 0.62, 0.19, 0.31], pitch: 30, fill: 0.25, lift: 1 },
    { kind: 'satin', poly: [[-0.42, 0.12], [0.42, 0.12], [0.46, 0.15], [-0.46, 0.15]], lift: 1 },
  ];
}
/** Connected thin red bar ending in angled X blades, black lower bumper, silver skid. */
function nexonRear(t: number): FaceItem[] {
  const top = t - 0.035;
  return [
    { kind: 'housing', rect: [-1.04, 1.04, top - 0.075, top] },
    { kind: 'tail', pts: [[0, top - 0.035], [1.04, top - 0.035]], w: 7, mirror: true },
    { kind: 'tail', pts: [[0.64, top - 0.07], [0.84, top - 0.012], [1.04, top - 0.012]], w: 9, mirror: true },
    { kind: 'tail', pts: [[0.64, top], [0.84, top - 0.06], [1.04, top - 0.062]], w: 9, mirror: true },
    { kind: 'gloss', rect: [-1.0, 1.0, 0.14, 0.27] },
    { kind: 'satin', rect: [-0.45, 0.45, 0.15, 0.17], lift: 1 },
    { kind: 'tail', rect: [0.8, 0.94, 0.225, 0.24], mirror: true },
  ];
}
/** Punch EV (2026 facelift): piano-black strip across the nose with small corner DRLs, vertical headlamp
 * pods low in the bumper, closed black upper panel, trapezoid lower intake, faux silver skid. */
function punchFront(n: number): FaceItem[] {
  return [
    { kind: 'gloss', rect: [-0.92, 0.92, n - 0.075, n - 0.008] },
    { kind: 'drl', pts: [[0.7, n - 0.025], [0.95, n - 0.025], [1.0, n - 0.05]], w: 11, mirror: true },
    { kind: 'gloss', rect: [-0.55, 0.55, n - 0.17, n - 0.09] },
    { kind: 'housing', poly: [[0.66, n - 0.33], [0.9, n - 0.31], [0.93, n - 0.12], [0.7, n - 0.12]], mirror: true },
    { kind: 'satin', rect: [0.73, 0.86, n - 0.2, n - 0.14], mirror: true },
    { kind: 'satin', rect: [0.73, 0.86, n - 0.29, n - 0.23], mirror: true },
    { kind: 'drl', pts: [[0.9, n - 0.14], [0.9, n - 0.3]], w: 5, mirror: true },
    { kind: 'intake', poly: [[-0.42, 0.16], [0.42, 0.16], [0.55, 0.29], [-0.55, 0.29]] },
    { kind: 'trim', pattern: 'slats-h', rect: [-0.4, 0.4, 0.18, 0.27], pitch: 24, fill: 0.4, lift: 1 },
    { kind: 'satin', poly: [[-0.34, 0.13], [0.34, 0.13], [0.4, 0.16], [-0.4, 0.16]], lift: 1 },
  ];
}
function punchRear(t: number): FaceItem[] {
  const top = t - 0.035;
  return [
    { kind: 'housing', rect: [0.66, 1.05, top - 0.08, top], mirror: true },
    { kind: 'tail', pts: [[0, top - 0.025], [1.04, top - 0.025]], w: 6, mirror: true },
    { kind: 'tail', rect: [0.72, 1.03, top - 0.07, top - 0.045], mirror: true },
    { kind: 'clad', rect: [-1.0, 1.0, 0.13, 0.26] },
    { kind: 'satin', rect: [-0.4, 0.4, 0.145, 0.17], lift: 1 },
  ];
}
/** XEV 9S: thick full-width LED bar that turns down at the corners to frame the face, headlamps flanking a
 * blanked black panel, gloss-black lower bumper with two slots. */
function xev9sFront(n: number): FaceItem[] {
  return [
    { kind: 'drl', pts: [[0, n - 0.02], [0.86, n - 0.02], [0.95, n - 0.05], [0.98, n - 0.21]], w: 15, mirror: true },
    { kind: 'gloss', rect: [-0.88, 0.88, n - 0.2, n - 0.045] },
    { kind: 'housing', poly: [[0.66, n - 0.19], [0.92, n - 0.18], [0.93, n - 0.06], [0.68, n - 0.06]], mirror: true, lift: 1 },
    { kind: 'satin', rect: [0.7, 0.77, n - 0.15, n - 0.09], mirror: true, lift: 2 },
    { kind: 'satin', rect: [0.79, 0.86, n - 0.15, n - 0.09], mirror: true, lift: 2 },
    { kind: 'gloss', rect: [-0.86, 0.86, 0.15, 0.31] },
    { kind: 'intake', poly: [[0.08, 0.19], [0.55, 0.19], [0.62, 0.27], [0.1, 0.27]], mirror: true, lift: 1 },
    { kind: 'satin', rect: [-0.4, 0.4, 0.125, 0.145], lift: 1 },
  ];
}
/** XUV700-style tail lamps joined by a black trim panel with a hex pattern; no light bar. */
function xev9sRear(t: number): FaceItem[] {
  const top = t - 0.03;
  return [
    // Tall lamps that run forward onto the rear quarters, as on the XUV700 body it shares.
    { kind: 'housing', poly: [[0.6, top - 0.13], [1.1, top - 0.07], [1.1, top + 0.015], [0.6, top + 0.015]], mirror: true },
    { kind: 'lens', poly: [[0.63, top - 0.11], [1.08, top - 0.06], [1.08, top + 0.003], [0.63, top + 0.003]], mirror: true, lift: 1 },
    { kind: 'tail', pts: [[0.64, top - 0.008], [1.07, top - 0.008]], w: 10, mirror: true },
    { kind: 'tail', pts: [[0.66, top - 0.1], [1.07, top - 0.055]], w: 8, mirror: true },
    { kind: 'gloss', rect: [-0.62, 0.62, top - 0.08, top - 0.015] },
    { kind: 'grille', pattern: 'diamonds', rect: [-0.58, 0.58, top - 0.07, top - 0.025], pitch: 24, fill: 0.6, lift: 1 },
    { kind: 'gloss', rect: [-1.0, 1.0, 0.13, 0.27] },
    { kind: 'satin', rect: [-0.42, 0.42, 0.14, 0.16], lift: 1 },
    { kind: 'tail', rect: [0.82, 0.95, 0.22, 0.235], mirror: true },
  ];
}

/** The front face, from the bonnet's leading edge `n` down. */
function frontFace(style: FrontStyle, n: number): FaceItem[] {
  const lowIntake: FaceItem = { kind: 'intake', rect: [-0.62, 0.62, 0.15, 0.27] };
  const skid: FaceItem = { kind: 'chrome', rect: [-0.42, 0.42, 0.12, 0.135] };
  switch (style) {
    case 'bar-split':
      return [
        { kind: 'drl', pts: [[0, n - 0.012], [0.9, n - 0.012], [0.98, n - 0.03]], w: 9, mirror: true },
        { kind: 'housing', rect: [-0.74, 0.74, n - 0.1, n - 0.065] },
        { kind: 'housing', rect: [0.76, 0.97, n - 0.2, n - 0.06], mirror: true },
        { kind: 'drl', pts: [[0.8, n - 0.075], [0.93, n - 0.075]], w: 10, mirror: true },
        { kind: 'intake', rect: [-0.72, 0.72, 0.17, n - 0.16] },
        { kind: 'chrome', pts: [[0, 0.165], [0.86, 0.165], [0.95, 0.2]], w: 7, mirror: true },
        skid,
      ];
    case 'bar-down':
      return [
        { kind: 'drl', pts: [[0, n - 0.015], [0.88, n - 0.015], [0.97, n - 0.11]], w: 12, mirror: true },
        { kind: 'housing', rect: [-0.86, 0.86, n - 0.06, n - 0.03] },
        { kind: 'housing', rect: [0.6, 0.9, n - 0.22, n - 0.13], mirror: true },
        { kind: 'drl', pts: [[0.63, n - 0.18], [0.86, n - 0.18]], w: 8, mirror: true },
        lowIntake,
        skid,
      ];
    case 'c-shape':
      return [
        { kind: 'housing', rect: [-0.78, 0.78, n - 0.1, n - 0.03] },
        { kind: 'drl', pts: [[0.99, n - 0.012], [0.8, n - 0.012], [0.75, n - 0.07], [0.8, n - 0.13], [0.98, n - 0.13]], w: 13, mirror: true },
        { kind: 'housing', rect: [0.62, 0.9, n - 0.24, n - 0.17], mirror: true },
        { kind: 'intake', rect: [-0.5, 0.5, 0.14, 0.24] },
        { kind: 'chrome', rect: [-0.55, 0.55, 0.12, 0.13] },
      ];
    case 'fang':
      return [
        { kind: 'housing', rect: [0.58, 0.97, n - 0.09, n - 0.005], mirror: true },
        { kind: 'drl', pts: [[0.62, n - 0.02], [0.95, n - 0.02]], w: 8, mirror: true },
        { kind: 'drl', pts: [[0.84, n - 0.1], [0.86, n - 0.3]], w: 16, mirror: true },
        { kind: 'housing', rect: [-0.5, 0.5, n - 0.13, n - 0.02] },
        { kind: 'chrome', pts: [[0, n - 0.135], [0.5, n - 0.135]], w: 8, mirror: true },
        lowIntake,
        skid,
      ];
    case 'swept':
      return [
        { kind: 'housing', rect: [0.56, 0.98, n - 0.075, n - 0.005], mirror: true },
        { kind: 'drl', pts: [[0.6, n - 0.065], [0.92, n - 0.04], [0.98, n - 0.01]], w: 9, mirror: true },
        { kind: 'chrome', pts: [[0, n - 0.035], [0.56, n - 0.035]], w: 10, mirror: true },
        { kind: 'intake', rect: [-0.62, 0.62, 0.16, n - 0.14] },
        skid,
      ];
    case 'corners':
      return [
        { kind: 'housing', rect: [-0.8, 0.8, n - 0.045, n - 0.01] },
        { kind: 'drl', pts: [[0.7, n - 0.025], [0.97, n - 0.025]], w: 12, mirror: true },
        { kind: 'housing', rect: [0.7, 0.96, n - 0.22, n - 0.12], mirror: true },
        lowIntake,
        skid,
      ];
    case 'pixel':
      return [
        { kind: 'housing', rect: [0.62, 0.93, n - 0.1, n - 0.012], mirror: true },
        { kind: 'drl', pts: [[0.64, n - 0.02], [0.64, n - 0.09], [0.91, n - 0.09], [0.91, n - 0.02]], w: 7, mirror: true },
        { kind: 'intake', rect: [-0.7, 0.7, 0.15, 0.25] },
      ];
    case 'v-face':
      return [
        { kind: 'drl', pts: [[0, n - 0.07], [0.35, n - 0.015], [0.97, n - 0.015]], w: 11, mirror: true },
        { kind: 'housing', rect: [0.64, 0.92, n - 0.22, n - 0.13], mirror: true },
        lowIntake,
        skid,
      ];
    case 'boomerang':
      return [
        { kind: 'drl', pts: [[0, n - 0.02], [0.66, n - 0.02]], w: 5, mirror: true },
        { kind: 'housing', rect: [0.66, 0.97, n - 0.08, n - 0.005], mirror: true },
        { kind: 'drl', pts: [[0.68, n - 0.02], [0.95, n - 0.02], [0.99, n - 0.12]], w: 9, mirror: true },
        { kind: 'intake', rect: [-0.75, 0.75, 0.15, 0.25] },
      ];
    case 'drop':
      return [
        { kind: 'housing', rect: [0.6, 0.97, n - 0.05, n - 0.005], mirror: true },
        { kind: 'drl', pts: [[0.62, n - 0.03], [0.82, n - 0.03], [0.86, n - 0.2]], w: 8, mirror: true },
        { kind: 'intake', rect: [-0.5, 0.5, 0.14, 0.24] },
      ];
    case 'strip':
      return [
        { kind: 'drl', pts: [[0, n - 0.01], [0.97, n - 0.01]], w: 10, mirror: true },
        { kind: 'housing', rect: [0.62, 0.92, n - 0.22, n - 0.14], mirror: true },
        { kind: 'intake', rect: [-0.5, 0.5, 0.15, 0.24] },
      ];
    case 'thin':
      return [
        { kind: 'drl', pts: [[0, n - 0.01], [0.95, n - 0.01]], w: 5, mirror: true },
        { kind: 'housing', rect: [0.74, 0.95, n - 0.1, n - 0.06], mirror: true },
        { kind: 'drl', pts: [[0.76, n - 0.08], [0.93, n - 0.07]], w: 5, mirror: true },
        { kind: 'trim', rect: [-0.55, 0.55, 0.13, 0.2] },
      ];
  }
}

/** The rear face, from the bottom of the rear glass `t` down. */
function rearFace(style: RearStyle, t: number): FaceItem[] {
  const top = t - 0.035;
  const reflector: FaceItem[] = [
    { kind: 'trim', rect: [-0.3, 0.3, 0.27, 0.36] },
    { kind: 'tail', rect: [0.78, 0.92, 0.215, 0.235], mirror: true },
  ];
  switch (style) {
    case 'bar':
      return [
        { kind: 'housing', rect: [0.66, 1.05, top - 0.07, top], mirror: true },
        { kind: 'tail', pts: [[0, top - 0.03], [1.04, top - 0.03]], w: 12, mirror: true },
        ...reflector,
      ];
    case 'x-bar':
      return [
        { kind: 'housing', rect: [0.62, 1.05, top - 0.08, top], mirror: true },
        { kind: 'tail', pts: [[0, top - 0.035], [1.04, top - 0.035]], w: 9, mirror: true },
        { kind: 'tail', pts: [[0.66, top - 0.07], [0.86, top - 0.01], [1.04, top - 0.01]], w: 9, mirror: true },
        { kind: 'chrome', rect: [-0.45, 0.45, 0.2, 0.215] },
        ...reflector,
      ];
    case 'u-bar':
      return [
        { kind: 'tail', pts: [[0, top - 0.01], [0.9, top - 0.01], [1.02, top - 0.12]], w: 13, mirror: true },
        { kind: 'housing', rect: [-0.86, 0.86, top - 0.05, top - 0.025] },
        ...reflector,
      ];
    case 'c-shape':
      return [
        { kind: 'housing', rect: [-0.76, 0.76, top - 0.08, top - 0.02] },
        { kind: 'tail', pts: [[1.03, top], [0.82, top], [0.77, top - 0.05], [0.82, top - 0.1], [1.03, top - 0.1]], w: 12, mirror: true },
        ...reflector,
      ];
    case 'separate':
      return [
        { kind: 'housing', rect: [0.66, 1.05, top - 0.09, top], mirror: true },
        { kind: 'tail', rect: [0.7, 1.03, top - 0.07, top - 0.02], mirror: true },
        { kind: 'chrome', pts: [[0, top - 0.045], [0.66, top - 0.045]], w: 7, mirror: true },
        ...reflector,
      ];
    case 'vertical':
      return [
        { kind: 'housing', rect: [0.84, 1.05, top - 0.2, top], mirror: true },
        { kind: 'tail', pts: [[0.9, top - 0.02], [0.9, top - 0.18]], w: 26, mirror: true },
        ...reflector,
      ];
    case 'wrap':
      return [
        { kind: 'housing', rect: [0.6, 1.06, top - 0.1, top], mirror: true },
        { kind: 'tail', pts: [[0.64, top - 0.02], [1.04, top - 0.02], [1.05, top - 0.09]], w: 12, mirror: true },
        { kind: 'housing', rect: [-0.6, 0.6, top - 0.07, top - 0.03] },
        ...reflector,
      ];
    case 'pixel':
      return [
        { kind: 'housing', rect: [-1.03, 1.03, top - 0.08, top] },
        { kind: 'tail', rect: [0.74, 0.97, top - 0.06, top - 0.02], mirror: true },
        ...reflector,
      ];
    case 'thin':
      return [
        { kind: 'tail', pts: [[0, top - 0.015], [1.04, top - 0.015]], w: 6, mirror: true },
        { kind: 'tail', rect: [0.8, 1.04, top - 0.06, top - 0.03], mirror: true },
        ...reflector,
      ];
    case 'boomerang':
      return [
        { kind: 'tail', pts: [[0, top - 0.04], [0.95, top - 0.04], [1.05, top - 0.13]], w: 8, mirror: true },
        ...reflector,
      ];
  }
}

const SPECS: Record<string, Spec> = {
  'tata-nexon-ev': {
    name: 'Tata Nexon EV',
    body: 'suv',
    size: [3995, 1802, 1625, 2498, 190, 16],
    profile: [0.31, 0.46, 0.87, 0.95, 0.6, 0.65, 0.63, 0.98, 0.68],
    dloX: 0.86,
    faceRake: 0.06,
    front: 'bar-split',
    rear: 'x-bar',
    floatingRoof: true,
    blackRoof: true,
    cladding: true,
    wheel: 'aero',
    finish: 'two-tone',
    tyre: [215, 60],
    frontOverhang: 0.538,
    noseRound: 0.25,
    frontItems: nexonFront,
    rearItems: nexonRear,
    // Window line rises gently and kicks up into the thick rear quarter.
    curves: { belt: [[0.31, 0.63], [0.6, 0.645], [0.79, 0.66], [0.85, 0.7], [0.95, 0.68]] },
    shoulder: { drop: [0.1, 0.075], tumble: 0.05, sharp: true, crease: { y: [0.34, 0.42], depth: 0.007 } },
    glass: { rearPillar: 'black', trim: 'black', rearSlant: 0.1 },
    clad: { archWidth: 0.065, sillH: 0.11 },
    lampGlow: 1.2,
    paints: [['Empowered Oxide', '#8A8F86'], ['Pristine White', '#F2F2EF'], ['Daytona Grey', '#5E6266'], ['Ocean Blue', '#1F4E79'], ['Pure Grey', '#9B9EA0']],
  },
  'tata-punch-ev': {
    name: 'Tata Punch EV',
    body: 'suv',
    size: [3880, 1742, 1622, 2445, 195, 16],
    profile: [0.3, 0.44, 0.9, 0.96, 0.58, 0.64, 0.62, 0.96, 0.66],
    front: 'corners',
    rear: 'bar',
    floatingRoof: true,
    blackRoof: true,
    cladding: true,
    roofRails: true,
    noseRound: 0.1,
    faceRake: 0.04,
    wheel: 'spoke',
    finish: 'two-tone',
    tyre: [195, 60],
    frontItems: punchFront,
    rearItems: punchRear,
    plan: { noseDepth: 0.2, noseSquare: 3.8, tailDepth: 0.2, tailSquare: 3.6 },
    shoulder: { drop: [0.085, 0.08], tumble: 0.035, sharp: true },
    glass: { rearPillar: 'black', trim: 'black', rearSlant: 0.04 },
    arch: { shape: 'squared', gap: 0.035 },
    clad: { colour: '#4a4d52', archWidth: 0.085, sillH: 0.13, proud: 0.016 },
    handles: 'pillar-rear',
    lampGlow: 1.2,
    paints: [['Fearless Yellow', '#E9B824'], ['Supernova Copper', '#B36A45'], ['Bengal Rouge', '#8E2430'], ['Empowered Oxide', '#8A8F86'], ['Pristine White', '#F2F2EF']],
  },
  'tata-tiago-ev': {
    name: 'Tata Tiago EV',
    body: 'hatch',
    size: [3825, 1684, 1562, 2400, 165, 14],
    profile: [0.3, 0.46, 0.88, 0.95, 0.52, 0.6, 0.58, 0.98, 0.63],
    front: 'swept',
    rear: 'bar',
    cladding: true,
    spokes: 8,
    finish: 'silver',
    paints: [['Dehradun Dew', '#7FA88B'], ['Sobo Surge', '#2F5D8A'], ['Pangong Pulse', '#4A86B8'], ['Pure Grey', '#9B9EA0'], ['Pristine White', '#F2F2EF']],
  },
  'tata-curvv-ev': {
    name: 'Tata Curvv EV',
    body: 'coupe',
    size: [4310, 1810, 1637, 2560, 186, 18],
    profile: [0.31, 0.45, 0.62, 0.93, 0.56, 0.63, 0.62, 0.98, 0.7],
    roofRearH: 0.96,
    dloX: 0.78,
    front: 'bar-split',
    rear: 'bar',
    cladding: true,
    flushHandles: true,
    wheel: 'aero',
    finish: 'two-tone',
    paints: [['Virtual Sunrise', '#C8643B'], ['Empowered Oxide', '#8A8F86'], ['Flame Red', '#B3202A'], ['Pure Grey', '#9B9EA0'], ['Pristine White', '#F2F2EF']],
  },
  'tata-harrier-ev': {
    name: 'Tata Harrier EV',
    body: 'suv',
    size: [4607, 1922, 1740, 2741, 186, 19],
    profile: [0.33, 0.47, 0.88, 0.95, 0.6, 0.63, 0.61, 0.96, 0.64],
    front: 'bar-down',
    rear: 'bar',
    cladding: true,
    roofRails: true,
    finish: 'two-tone',
    noseRound: 0.15,
    paints: [['Nainital Nocturne', '#1E2A3A'], ['Empowered Oxide', '#8A8F86'], ['Seaweed Green', '#4E5E4A'], ['Pure Grey', '#9B9EA0'], ['Pristine White', '#F2F2EF']],
  },
  'mg-zs-ev': {
    name: 'MG ZS EV',
    body: 'suv',
    size: [4323, 1809, 1649, 2585, 177, 17],
    profile: [0.31, 0.45, 0.86, 0.95, 0.52, 0.6, 0.59, 0.97, 0.63],
    front: 'swept',
    rear: 'separate',
    cladding: true,
    roofRails: true,
    finish: 'two-tone',
    noseRound: 0.5,
    paints: [['Glaze Red', '#A3212B'], ['Aurora Silver', '#B9BCBE'], ['Starry Black', '#16181B'], ['Candy White', '#F3F3F0']],
  },
  'mg-windsor': {
    name: 'MG Windsor EV',
    body: 'mpv',
    size: [4295, 1850, 1677, 2700, 186, 18],
    profile: [0.25, 0.44, 0.9, 0.97, 0.5, 0.57, 0.57, 1, 0.61],
    front: 'strip',
    rear: 'thin',
    floatingRoof: true,
    blackRoof: true,
    cladding: true,
    flushHandles: true,
    wheel: 'aero',
    finish: 'two-tone',
    noseRound: 0.7,
    paints: [['Starburst Black', '#121315'], ['Pearl White', '#EFEFEA'], ['Clay Beige', '#B9A58C'], ['Turquoise Green', '#3E8B84'], ['Aurora Silver', '#B9BCBE']],
  },
  'mg-comet': {
    name: 'MG Comet EV',
    body: 'micro',
    size: [2974, 1505, 1640, 2010, 165, 12],
    profile: [0.14, 0.36, 0.94, 0.99, 0.52, 0.55, 0.53, 1, 0.58],
    front: 'strip',
    rear: 'thin',
    floatingRoof: true,
    blackRoof: true,
    wheel: 'aero',
    finish: 'silver',
    frontOverhang: 0.5,
    noseRound: 0.8,
    paints: [['Apple Green', '#9BC33A'], ['Candy White', '#F3F3F0'], ['Aurora Silver', '#B9BCBE'], ['Starry Black', '#16181B']],
  },
  'mahindra-xuv400': {
    name: 'Mahindra XUV400',
    body: 'suv',
    size: [4200, 1821, 1634, 2600, 200, 16],
    profile: [0.31, 0.46, 0.88, 0.95, 0.58, 0.63, 0.62, 0.96, 0.66],
    front: 'fang',
    rear: 'wrap',
    blackRoof: true,
    cladding: true,
    roofRails: true,
    finish: 'two-tone',
    noseRound: 0.3,
    paints: [['Everest White', '#F1F1EE'], ['Nebula Blue', '#2A4A73'], ['Galaxy Grey', '#5B5F63'], ['Stealth Black', '#141517'], ['Arctic Blue', '#8DB7D6']],
  },
  'mahindra-be6': {
    name: 'Mahindra BE 6',
    body: 'coupe',
    size: [4371, 1907, 1627, 2775, 207, 20],
    profile: [0.33, 0.5, 0.64, 0.92, 0.5, 0.63, 0.63, 1, 0.72],
    roofRearH: 0.97,
    dloX: 0.76,
    faceRake: 0.18,
    front: 'c-shape',
    rear: 'c-shape',
    floatingRoof: true,
    blackRoof: true,
    cladding: true,
    flushHandles: true,
    wheel: 'turbine',
    finish: 'two-tone',
    frontOverhang: 0.5,
    noseRound: 0.2,
    paints: [['Firestorm Orange', '#D9581F'], ['Tango Red', '#B01E2A'], ['Deep Forest', '#2F3B2C'], ['Desert Myst', '#B8AE9C'], ['Everest White', '#F1F1EE']],
  },
  'mahindra-xev9e': {
    name: 'Mahindra XEV 9e',
    body: 'coupe',
    size: [4789, 1907, 1694, 2775, 207, 19],
    profile: [0.3, 0.45, 0.52, 0.93, 0.52, 0.6, 0.62, 1, 0.72],
    roofRearH: 0.99,
    dloX: 0.79,
    faceRake: 0.12,
    front: 'bar-down',
    rear: 'u-bar',
    floatingRoof: true,
    cladding: true,
    flushHandles: true,
    wheel: 'turbine',
    finish: 'two-tone',
    noseRound: 0.35,
    paints: [['Everest White', '#F1F1EE'], ['Nebula Blue', '#2A4A73'], ['Ruby Velvet', '#6E1F2E'], ['Desert Myst', '#B8AE9C'], ['Stealth Black', '#141517']],
  },
  'mahindra-xev9s': {
    name: 'Mahindra XEV 9S',
    body: 'suv',
    size: [4737, 1900, 1747, 2762, 205, 18],
    profile: [0.31, 0.45, 0.9, 0.96, 0.58, 0.62, 0.6, 0.97, 0.63],
    front: 'bar-down',
    rear: 'wrap',
    cladding: true,
    roofRails: true,
    flushHandles: true,
    wheel: 'aero',
    finish: 'two-tone',
    tyre: [235, 60],
    noseRound: 0.15,
    faceRake: 0.05,
    frontItems: xev9sFront,
    rearItems: xev9sRear,
    // Upright XUV700 body: the window line kicks up at the C-pillar into a body-colour D-pillar.
    curves: { belt: [[0.31, 0.6], [0.7, 0.61], [0.8, 0.62], [0.85, 0.665], [0.96, 0.63]] },
    plan: { noseDepth: 0.26, noseSquare: 3.4 },
    shoulder: { drop: [0.095, 0.09], tumble: 0.045, sharp: true, crease: { y: [0.37, 0.4], depth: 0.006 } },
    glass: { rearPillar: 'body', trim: 'chrome', rearSlant: 0.05 },
    clad: { colour: '#0b0c0e', archWidth: 0.06, sillH: 0.11 },
    lampGlow: 1.3,
    paints: [['Nebula Blue', '#2A4A73'], ['Ruby Velvet', '#6E1F2E'], ['Desert Myst', '#B8AE9C'], ['Midnight Black', '#151B2B'], ['Everest White', '#F1F1EE']],
  },
  'hyundai-creta-electric': {
    name: 'Hyundai Creta Electric',
    body: 'suv',
    size: [4340, 1790, 1655, 2610, 200, 17],
    profile: [0.31, 0.45, 0.87, 0.95, 0.56, 0.62, 0.6, 0.97, 0.64],
    front: 'bar-split',
    rear: 'bar',
    cladding: true,
    roofRails: true,
    wheel: 'aero',
    finish: 'two-tone',
    paints: [['Ocean Blue', '#1E4F7C'], ['Atlas White', '#F0F0EC'], ['Fiery Red', '#B1202B'], ['Starry Night', '#232B3B'], ['Abyss Black', '#121314']],
  },
  'hyundai-ioniq5': {
    name: 'Hyundai Ioniq 5',
    body: 'suv',
    size: [4655, 1890, 1625, 3000, 160, 20],
    profile: [0.27, 0.45, 0.9, 0.97, 0.52, 0.58, 0.58, 0.99, 0.63],
    front: 'pixel',
    rear: 'pixel',
    flushHandles: true,
    wheel: 'aero',
    finish: 'silver',
    frontOverhang: 0.5,
    noseRound: 0.3,
    paints: [['Gravity Gold Matte', '#A49A78'], ['Midnight Black Pearl', '#141516'], ['Titan Grey', '#6A6D70'], ['Optic White', '#F2F2EF']],
  },
  'kia-ev6': {
    name: 'Kia EV6',
    body: 'coupe',
    size: [4695, 1890, 1570, 2900, 178, 19],
    profile: [0.3, 0.47, 0.7, 0.9, 0.49, 0.57, 0.58, 1, 0.66],
    faceRake: 0.18,
    front: 'boomerang',
    rear: 'boomerang',
    cladding: true,
    flushHandles: true,
    wheel: 'aero',
    finish: 'gunmetal',
    noseRound: 0.6,
    paints: [['Snow White Pearl', '#F1F1EC'], ['Wolf Gray', '#5E6164'], ['Runway Red', '#A71E2A'], ['Aurora Black Pearl', '#121314'], ['Yacht Blue Matte', '#25344B']],
  },
  'byd-atto3': {
    name: 'BYD Atto 3',
    body: 'suv',
    size: [4455, 1875, 1615, 2720, 175, 18],
    profile: [0.3, 0.45, 0.87, 0.95, 0.54, 0.6, 0.59, 0.97, 0.63],
    front: 'swept',
    rear: 'bar',
    floatingRoof: true,
    cladding: true,
    roofRails: true,
    finish: 'two-tone',
    noseRound: 0.55,
    paints: [['Ski White', '#F2F2EF'], ['Cosmos Black', '#131416'], ['Harbour Grey', '#6B7075'], ['Atlantis Gray', '#4B5A66']],
  },
  'byd-seal': {
    name: 'BYD Seal',
    body: 'sedan',
    size: [4800, 1875, 1460, 2920, 149, 19],
    profile: [0.31, 0.46, 0.66, 0.86, 0.47, 0.58, 0.62, 1, 0.7],
    faceRake: 0.2,
    front: 'drop',
    rear: 'thin',
    flushHandles: true,
    wheel: 'aero',
    finish: 'gunmetal',
    noseRound: 0.7,
    paints: [['Aurora White', '#F2F2EF'], ['Atlantis Gray', '#4B5A66'], ['Cosmos Black', '#131416'], ['Shark Gray', '#7A7F84']],
  },
  'byd-emax7': {
    name: 'BYD eMax 7',
    body: 'mpv',
    size: [4710, 1810, 1690, 2800, 170, 17],
    profile: [0.26, 0.42, 0.93, 0.98, 0.52, 0.57, 0.56, 0.98, 0.6],
    front: 'swept',
    rear: 'bar',
    roofRails: true,
    finish: 'two-tone',
    noseRound: 0.5,
    paints: [['Quartz Blue', '#2C4E6E'], ['Cosmos Black', '#131416'], ['Crystal White', '#F2F2EF'], ['Harbour Grey', '#6B7075']],
  },
  'citroen-ec3': {
    name: 'Citroën ë-C3',
    body: 'hatch',
    size: [3981, 1733, 1586, 2540, 170, 15],
    profile: [0.3, 0.46, 0.88, 0.95, 0.57, 0.62, 0.6, 1, 0.64],
    front: 'swept',
    rear: 'vertical',
    cladding: true,
    roofRails: true,
    spokes: 8,
    finish: 'silver',
    noseRound: 0.25,
    paints: [['Polar White', '#F2F2EF'], ['Perla Nera Black', '#131416'], ['Cosmo Blue', '#2F5B8F']],
  },
  'maruti-e-vitara': {
    name: 'Maruti e Vitara',
    body: 'suv',
    size: [4275, 1800, 1640, 2700, 185, 18],
    profile: [0.3, 0.45, 0.87, 0.95, 0.58, 0.63, 0.62, 0.99, 0.67],
    front: 'corners',
    rear: 'bar',
    floatingRoof: true,
    blackRoof: true,
    cladding: true,
    finish: 'two-tone',
    noseRound: 0.25,
    paints: [['Nexa Blue', '#1F3C78'], ['Opulent Red', '#8E1F2A'], ['Land Breeze Green', '#7E9C8A'], ['Grandeur Grey', '#5B5F63'], ['Arctic White', '#F2F2EF']],
  },
  'tesla-model-y': {
    name: 'Tesla Model Y',
    body: 'coupe',
    size: [4790, 1920, 1624, 2890, 167, 19],
    profile: [0.27, 0.45, 0.64, 0.89, 0.47, 0.58, 0.6, 1, 0.68],
    faceRake: 0.2,
    front: 'thin',
    rear: 'thin',
    flushHandles: true,
    spokes: 10,
    wheel: 'aero',
    finish: 'gunmetal',
    frontOverhang: 0.5,
    noseRound: 0.75,
    paints: [['Stealth Grey', '#4D5156'], ['Pearl White Multi-Coat', '#F1F1EC'], ['Diamond Black', '#121314'], ['Glacier Blue', '#6E8EA8'], ['Ultra Red', '#A8141E']],
  },
  'vinfast-vf7': {
    name: 'VinFast VF 7',
    body: 'coupe',
    size: [4550, 1893, 1596, 2840, 190, 19],
    profile: [0.3, 0.47, 0.68, 0.9, 0.52, 0.59, 0.61, 1, 0.67],
    front: 'v-face',
    rear: 'boomerang',
    floatingRoof: true,
    blackRoof: true,
    cladding: true,
    roofRails: true,
    flushHandles: true,
    wheel: 'turbine',
    finish: 'two-tone',
    noseRound: 0.5,
    paints: [['Infinity Blanc', '#F2F2EF'], ['Crimson Red', '#9E1B25'], ['Jet Black', '#111213'], ['Zenith Grey', '#5A5E62'], ['Urban Mint', '#9FC2B4']],
  },
};

function make(s: Spec): CarDesign {
  const [lengthMm, widthMm, heightMm, wheelbaseMm, clearanceMm, rimInch] = s.size;
  const [cowlX, roofFrontX, roofRearX, rearGlassX, hoodFrontH, hoodCowlH, beltH, roofH, tailH] = s.profile;
  const coupe = s.body === 'coupe' || s.body === 'sedan';
  const boxy = s.body === 'mpv' || s.body === 'micro';
  const noseRound = s.noseRound ?? 0.4;
  return {
    tyre: s.tyre,
    curves: s.curves,
    plan: { noseDepth: 0.22 + 0.35 * noseRound, noseSquare: 3.2 - 1.4 * noseRound, tailDepth: 0.25, tailSquare: 3, roofTaper: 0.94, ...s.plan },
    shoulder: { drop: [0.09, 0.075], tumble: coupe ? 0.06 : 0.045, sharp: false, ...s.shoulder },
    glass: { rearPillar: s.floatingRoof ? 'black' : 'body', trim: 'black', rearSlant: coupe ? 0.14 : 0.06, ...s.glass },
    arch: { shape: 'round', gap: 0.03, ...s.arch },
    clad: { colour: '#141518', archWidth: 0.06, sillH: 0.1, proud: 0.012, bumpers: true, ...s.clad },
    handles: s.handles ?? (s.flushHandles ? 'flush' : 'standard'),
    lampGlow: s.lampGlow ?? 1,
    name: s.name,
    body: s.body,
    lengthMm,
    widthMm,
    heightMm,
    wheelbaseMm,
    clearanceMm,
    rimInch,
    frontOverhang: s.frontOverhang ?? 0.53,
    profile: {
      noseH: hoodFrontH,
      hoodFrontH: hoodFrontH + 0.015,
      hoodCowlH,
      // Photo-measured pillar bases sit under the visible glass edge; the real screen runs a little lower.
      cowlX: boxy ? cowlX : cowlX - 0.015,
      roofFrontX: boxy ? roofFrontX : roofFrontX + 0.02,
      roofRearX,
      rearGlassX,
      beltH,
      roofH,
      roofRearH: s.roofRearH ?? roofH - (coupe ? 0.04 : 0.025),
      tailH,
      dloX: s.dloX ?? (coupe ? roofRearX + (rearGlassX - roofRearX) * 0.45 : rearGlassX - 0.035),
    },
    faceRake: s.faceRake ?? 0.08,
    roofWidth: s.body === 'micro' ? 0.84 : s.body === 'mpv' ? 0.8 : coupe ? 0.68 : 0.73,
    noseRound,
    roof: s.blackRoof ? 'black' : 'body',
    pillars: 'black',
    cladding: s.cladding ?? false,
    roofRails: s.roofRails ?? false,
    flushHandles: s.flushHandles ?? false,
    spoiler: s.body !== 'sedan',
    wheel: { spokes: s.spokes ?? 5, style: s.wheel ?? 'spoke', finish: s.finish ?? 'silver' },
    front: s.frontItems ? s.frontItems(hoodFrontH) : frontFace(s.front, hoodFrontH),
    rear: s.rearItems ? s.rearItems(tailH) : rearFace(s.rear, tailH),
    paints: s.paints.map(([name, hex]): CarPaint => ({ name, hex: hex.toLowerCase() })),
  };
}

export const DESIGNS: Record<string, CarDesign> = Object.fromEntries(Object.entries(SPECS).map(([k, s]) => [k, make(s)]));

/** For a custom car: a plain body of the right kind. */
const GENERIC: Record<BodyStyle, CarDesign> = {
  suv: { ...make({ ...SPECS['hyundai-creta-electric'], name: 'Electric SUV', front: 'thin', rear: 'bar' }), paints: [] },
  coupe: { ...make({ ...SPECS['kia-ev6'], name: 'Electric coupe SUV', front: 'thin', rear: 'thin' }), paints: [] },
  hatch: { ...make({ ...SPECS['tata-tiago-ev'], name: 'Electric hatchback', front: 'thin', rear: 'bar' }), paints: [] },
  sedan: { ...make({ ...SPECS['byd-seal'], name: 'Electric sedan', front: 'thin', rear: 'thin' }), paints: [] },
  mpv: { ...make({ ...SPECS['byd-emax7'], name: 'Electric MPV', front: 'thin', rear: 'bar' }), paints: [] },
  micro: { ...make({ ...SPECS['mg-comet'], name: 'Electric city car' }), paints: [] },
};

/** The design for an app vehicle id: its own when ChargeOne has one, else a generic body. */
export function designFor(modelId: string): { design: CarDesign; exact: boolean } {
  const key = Object.keys(DESIGNS).find((k) => modelId.startsWith(k));
  if (key) return { design: DESIGNS[key], exact: true };
  return { design: GENERIC.suv, exact: false };
}

export const DEFAULT_PAINTS: CarPaint[] = [
  { name: 'White', hex: '#f2f2ef' },
  { name: 'Silver', hex: '#b9bcbe' },
  { name: 'Grey', hex: '#5e6266' },
  { name: 'Black', hex: '#131416' },
  { name: 'Blue', hex: '#1f4e79' },
  { name: 'Red', hex: '#a8141e' },
];

/** Factory colours for a model, or a plain set for a car ChargeOne has no design for. */
export function paintsFor(modelId: string): CarPaint[] {
  const { design, exact } = designFor(modelId);
  return exact && design.paints.length ? design.paints : DEFAULT_PAINTS;
}
