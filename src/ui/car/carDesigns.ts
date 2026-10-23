import type { BodyStyle, CarDesign, CarPaint, FaceItem, FacePt } from './carDesign.ts';
import { PAINT_SPECS } from './carPaints.ts';

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
  /** Bonnet dome, metres; default 0.022. */
  hoodCrown?: number;
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
}

// Bespoke faces for the cars whose signature carries their identity. Observed from the free-licence
// reference photos listed in research/car-designs.md; coordinates are design numbers, not traced.

/** An ellipse in face coordinates: `rs` is a share of the half width, `ry` of the height. */
function oval(s: number, y: number, rs: number, ry: number, k = 14): FacePt[] {
  return Array.from({ length: k }, (_, i): FacePt => [s + rs * Math.cos((2 * Math.PI * i) / k), y + ry * Math.sin((2 * Math.PI * i) / k)]);
}
/** A round LED projector: bright bezel, dark lens, lit centre. Sizes are for a car of half width `hw` and
 * height `h` (metres), so the projector stays round; `r` is its radius in metres. */
function projector(s: number, y: number, r: number, hw: number, h: number): FaceItem[] {
  return [
    { kind: 'chrome', poly: oval(s, y, r / hw, r / h), mirror: true, lift: 2 },
    { kind: 'housing', poly: oval(s, y, (r * 0.72) / hw, (r * 0.72) / h), mirror: true, lift: 3 },
    { kind: 'drl', poly: oval(s, y, (r * 0.34) / hw, (r * 0.34) / h, 10), mirror: true, lift: 4 },
  ];
}

/** Nexon EV (2023 facelift). Front: a thin full-width DRL bar in a gloss strip on the bonnet lip, its ends
 * turning down round the corners; split headlamps in gloss-black pods that lean outward at the bottom and
 * reach up to the DRL corners, so pod and lower intake form an X at each corner; a raised closed panel in
 * body colour between them; a lower air dam that widens toward the bottom, with silver strakes; an angled
 * silver skid plate. */
function nexonFront(n: number): FaceItem[] {
  const hw = 0.901;
  const h = 1.625;
  return [
    { kind: 'gloss', poly: [[-0.93, n - 0.004], [0.93, n - 0.004], [1.02, n - 0.03], [0.92, n - 0.032], [-0.92, n - 0.032], [-1.02, n - 0.03]] },
    { kind: 'drl', pts: [[0, n - 0.018], [0.88, n - 0.018], [0.96, n - 0.024], [1.0, n - 0.03]], w: 7, mirror: true },
    // Raised closed panel, its shut lines narrowing down to the air dam.
    { kind: 'body', poly: [[-0.54, n - 0.045], [0.54, n - 0.045], [0.46, 0.345], [-0.46, 0.345]], lift: 4 },
    { kind: 'trim', pts: [[0.54, n - 0.045], [0.46, 0.345]], w: 4, mirror: true },
    // Headlamp pod: the X's upper arm runs up to the DRL corner; the lamp housing sits in its lower half.
    { kind: 'gloss', poly: [[0.56, n - 0.05], [0.86, n - 0.04], [0.97, n - 0.07], [0.97, n - 0.25], [0.84, n - 0.275], [0.67, n - 0.19]], mirror: true, lift: 1 },
    { kind: 'satin', pts: [[0.56, n - 0.05], [0.67, n - 0.19], [0.84, n - 0.275], [0.97, n - 0.25]], w: 4, mirror: true, lift: 2 },
    // Smoked lamp cluster: a lit eyebrow over two stacked projectors and a vertical turn lamp.
    { kind: 'housing', poly: [[0.7, n - 0.085], [0.93, n - 0.08], [0.94, n - 0.24], [0.84, n - 0.255], [0.74, n - 0.18]], mirror: true, lift: 2 },
    { kind: 'drl', pts: [[0.72, n - 0.09], [0.92, n - 0.087]], w: 6, mirror: true },
    ...projector(0.81, n - 0.135, 0.046, hw, h),
    ...projector(0.85, n - 0.205, 0.04, hw, h),
    { kind: 'turn', pts: [[0.925, n - 0.12], [0.925, n - 0.23]], w: 7, mirror: true },
    // LED light guide down the inner edge of the pod.
    { kind: 'drl', pts: [[0.6, n - 0.065], [0.69, n - 0.12], [0.75, n - 0.2], [0.83, n - 0.26]], w: 5, mirror: true },
    // Lower air dam, wider at the bottom: the X's lower arms.
    { kind: 'gloss', poly: [[-0.5, 0.345], [0.5, 0.345], [0.74, 0.3], [1.02, 0.205], [-1.02, 0.205], [-0.74, 0.3]] },
    { kind: 'satin', pattern: 'slats-h', rect: [-0.5, 0.5, 0.25, 0.33], pitch: 26, fill: 0.3, lift: 1 },
    // Silver skid plate with upswept ends.
    { kind: 'satin', poly: [[-0.62, 0.2], [0.62, 0.2], [0.8, 0.235], [0.7, 0.245], [0.58, 0.222], [-0.58, 0.222], [-0.7, 0.245], [-0.8, 0.235]], lift: 2 },
  ];
}
/** Nexon EV rear: a connected red bar right under the rear glass that runs into gloss-black corner clusters
 * wrapping onto the quarters, where it splits into two angled blades (the arrow, or X, ends); body-colour
 * tailgate with a black band at its lower edge; black lower bumper with a plate recess; black corner pods with
 * tall red reflectors; silver skid. */
function nexonRear(t: number): FaceItem[] {
  const top = t - 0.03;
  return [
    { kind: 'gloss', rect: [-0.94, 0.94, top - 0.004, t - 0.004] },
    { kind: 'tail', pts: [[0, top - 0.013], [0.66, top - 0.013]], w: 11, mirror: true },
    { kind: 'housing', poly: [[0.6, top - 0.002], [1.14, top + 0.006], [1.14, top - 0.07], [0.98, top - 0.085], [0.78, top - 0.04]], mirror: true, lift: 1 },
    { kind: 'lens', poly: [[0.64, top - 0.006], [1.12, top + 0.002], [1.12, top - 0.064], [0.98, top - 0.078], [0.8, top - 0.038]], mirror: true, lift: 2 },
    // The X end: the bar's upper blade runs out to the corner, a lower blade angles down and back up.
    { kind: 'tail', pts: [[0.64, top - 0.013], [1.12, top - 0.006]], w: 12, mirror: true, lift: 2 },
    { kind: 'tail', pts: [[0.8, top - 0.036], [0.98, top - 0.072], [1.12, top - 0.058]], w: 9, mirror: true, lift: 2 },

    // Black band along the bottom of the tailgate.
    { kind: 'gloss', rect: [-0.8, 0.8, 0.375, 0.39] },
    // Lower bumper: black centre with a plate recess, body-colour corners carrying black reflector pods.
    { kind: 'gloss', poly: [[-0.6, 0.345], [0.6, 0.345], [0.72, 0.26], [0.7, 0.198], [-0.7, 0.198], [-0.72, 0.26]] },
    { kind: 'housing', rect: [-0.3, 0.3, 0.265, 0.33], lift: 1 },
    { kind: 'satin', pts: [[-0.56, 0.35], [0.56, 0.35]], w: 3 },
    { kind: 'gloss', poly: [[0.84, 0.37], [1.06, 0.39], [1.06, 0.22], [0.94, 0.22]], mirror: true },
    { kind: 'tail', rect: [0.96, 1.01, 0.25, 0.35], mirror: true, lift: 1 },
    { kind: 'satin', poly: [[-0.66, 0.19], [0.66, 0.19], [0.6, 0.214], [-0.6, 0.214]], lift: 2 },
  ];
}
/** Punch EV (2026 facelift). Front: no light bar; a piano-black strip along the bonnet lip with short LED
 * DRLs (also the indicators) at its ends that turn down the corners; a raised body-colour centre panel; tall
 * black headlamp pods low in the bumper corners with two lamps stacked and a chevron LED guide; a black
 * blade across the face between the pods; a black lower bumper with grey vertical teeth; a silver skid plate
 * with upturned ends. */
function punchFront(n: number): FaceItem[] {
  const hw = 0.871;
  const h = 1.622;
  return [
    { kind: 'gloss', poly: [[-0.96, n - 0.004], [0.96, n - 0.004], [1.03, n - 0.03], [0.96, n - 0.046], [-0.96, n - 0.046], [-1.03, n - 0.03]] },
    // Corner DRLs (also the indicators) at the strip ends, wrapping round the corner along the bonnet shut line.
    { kind: 'drl', pts: [[0.66, n - 0.026], [0.96, n - 0.02], [1.015, n - 0.03]], w: 11, mirror: true },
    // Raised centre panel.
    { kind: 'body', poly: [[-0.34, n - 0.05], [0.34, n - 0.05], [0.31, n - 0.2], [-0.31, n - 0.2]], lift: 5 },
    { kind: 'trim', pts: [[-0.34, n - 0.05], [-0.31, n - 0.2], [0.31, n - 0.2], [0.34, n - 0.05]], w: 4 },
    // Angular headlamp pods low in the bumper corners, with a satin frame.
    { kind: 'gloss', poly: [[0.6, n - 0.11], [0.9, n - 0.1], [0.97, n - 0.15], [0.95, n - 0.33], [0.8, n - 0.335], [0.64, n - 0.24]], mirror: true, lift: 1 },
    { kind: 'satin', pts: [[0.6, n - 0.11], [0.64, n - 0.24], [0.8, n - 0.335], [0.95, n - 0.33]], w: 4, mirror: true, lift: 1 },
    { kind: 'housing', poly: [[0.71, n - 0.125], [0.9, n - 0.12], [0.92, n - 0.3], [0.8, n - 0.305], [0.71, n - 0.24]], mirror: true, lift: 2 },
    ...projector(0.8, n - 0.165, 0.042, hw, h),
    ...projector(0.82, n - 0.255, 0.042, hw, h),
    { kind: 'drl', pts: [[0.68, n - 0.125], [0.665, n - 0.21], [0.73, n - 0.3]], w: 5, mirror: true },
    // Black blade between the pods, splitting the upper face from the bumper.
    { kind: 'gloss', poly: [[-0.66, n - 0.255], [0.66, n - 0.255], [0.66, n - 0.285], [-0.66, n - 0.285]] },
    // Lower bumper with vertical teeth.
    { kind: 'trim', poly: [[-0.74, 0.3], [0.74, 0.3], [0.94, 0.24], [0.99, 0.2], [-0.99, 0.2], [-0.94, 0.24]] },
    { kind: 'clad', pattern: 'slats-v', rect: [-0.6, 0.6, 0.235, 0.29], pitch: 34, fill: 0.32, lift: 1 },
    { kind: 'satin', poly: [[-0.7, 0.196], [0.7, 0.196], [0.84, 0.238], [0.76, 0.244], [0.64, 0.218], [-0.64, 0.218], [-0.76, 0.244], [-0.84, 0.238]], lift: 2 },
  ];
}
/** Punch EV rear: Y-shaped LED signatures in the corner lamps (an arm from the centre that forks out to
 * the corner), joined across the tailgate by a thin bar; a recessed plate panel on the tailgate; grey clad
 * lower bumper with reflectors and a silver skid plate. */
function punchRear(t: number): FaceItem[] {
  const top = t - 0.032;
  return [
    { kind: 'gloss', rect: [-0.94, 0.94, top - 0.003, t - 0.004] },
    { kind: 'housing', poly: [[0.62, top - 0.006], [1.1, top - 0.001], [1.1, top - 0.095], [0.86, top - 0.095], [0.7, top - 0.055]], mirror: true, lift: 1 },
    { kind: 'lens', poly: [[0.66, top - 0.01], [1.08, top - 0.006], [1.08, top - 0.088], [0.87, top - 0.088], [0.73, top - 0.054]], mirror: true, lift: 2 },
    { kind: 'tail', pts: [[0, top - 0.03], [0.78, top - 0.03]], w: 5, mirror: true },
    { kind: 'tail', pts: [[0.78, top - 0.03], [0.9, top - 0.014], [1.08, top - 0.014]], w: 10, mirror: true, lift: 2 },
    { kind: 'tail', pts: [[0.78, top - 0.03], [0.9, top - 0.064], [1.08, top - 0.072]], w: 10, mirror: true, lift: 2 },
    // Gloss garnish across the tailgate over the plate area, and the tailgate's lower shut line.
    { kind: 'gloss', rect: [-0.38, 0.38, 0.505, 0.53] },
    { kind: 'trim', pts: [[-0.9, 0.345], [0.9, 0.345]], w: 4 },
    { kind: 'clad', poly: [[-1.0, 0.33], [1.0, 0.33], [1.02, 0.192], [-1.02, 0.192]] },
    { kind: 'tail', rect: [0.82, 0.95, 0.255, 0.272], mirror: true, lift: 1 },
    { kind: 'satin', poly: [[-0.52, 0.19], [0.52, 0.19], [0.46, 0.228], [-0.46, 0.228]], lift: 2 },
  ];
}
/** XEV 9S. Front: a thick LED bar across the nose whose ends drop down the corners in long legs that kick
 * inward at the bottom (the boomerang L); triangular headlamp clusters tucked inside each L; a smooth,
 * blanked gloss-black panel in the middle that narrows downward; a gloss-black lower bumper with two slots. */
function xev9sFront(n: number): FaceItem[] {
  return [
    { kind: 'gloss', rect: [-0.92, 0.92, n - 0.05, n - 0.004] },
    // The L's leg runs in a smoked strip down the corner and lands in the gloss lower bumper, so its light
    // never ends on bare paint.
    { kind: 'housing', poly: [[0.94, n - 0.04], [1.0, n - 0.04], [1.0, n - 0.275], [0.95, n - 0.325], [0.9, n - 0.31], [0.95, n - 0.265]], mirror: true, lift: 1 },
    { kind: 'drl', pts: [[0, n - 0.024], [0.9, n - 0.024], [0.965, n - 0.045], [0.98, n - 0.09], [0.975, n - 0.27], [0.935, n - 0.305]], w: 20, mirror: true },
    // Headlamps: a smoked wedge inside the L, deepest at the outer edge, holding two square projector modules
    // with chrome bezels and a lit inner LED line under them.
    { kind: 'housing', poly: [[0.6, n - 0.062], [0.95, n - 0.062], [0.95, n - 0.24], [0.86, n - 0.2]], mirror: true, lift: 1 },
    { kind: 'chrome', poly: [[0.72, n - 0.075], [0.8, n - 0.075], [0.8, n - 0.125], [0.72, n - 0.125]], mirror: true, lift: 2 },
    { kind: 'housing', poly: [[0.73, n - 0.08], [0.79, n - 0.08], [0.79, n - 0.12], [0.73, n - 0.12]], mirror: true, lift: 3 },
    { kind: 'chrome', poly: [[0.83, n - 0.085], [0.92, n - 0.085], [0.92, n - 0.14], [0.83, n - 0.14]], mirror: true, lift: 2 },
    { kind: 'housing', poly: [[0.84, n - 0.09], [0.91, n - 0.09], [0.91, n - 0.135], [0.84, n - 0.135]], mirror: true, lift: 3 },
    { kind: 'drl', pts: [[0.66, n - 0.075], [0.86, n - 0.17], [0.93, n - 0.205]], w: 5, mirror: true },
    // Blanked panel: smooth body colour between the lamps, underlined in satin.
    { kind: 'satin', pts: [[-0.3, n - 0.215], [0.3, n - 0.215]], w: 4 },
    // Lower bumper: gloss black, rising up the corners inside the DRL legs, with a satin top edge.
    { kind: 'gloss', poly: [[-0.55, 0.3], [0.55, 0.3], [0.78, 0.31], [0.9, n - 0.29], [0.94, n - 0.33], [1.05, 0.25], [1.05, 0.185], [-1.05, 0.185], [-1.05, 0.25], [-0.94, n - 0.33], [-0.9, n - 0.29], [-0.78, 0.31]] },
    { kind: 'satin', pts: [[-0.55, 0.302], [0.55, 0.302], [0.78, 0.312], [0.9, n - 0.288]], w: 3, mirror: true, lift: 1 },
    // Two intake slots with fine vertical vanes, and a sensor box in the middle.
    { kind: 'intake', poly: [[0.1, 0.212], [0.52, 0.212], [0.6, 0.272], [0.12, 0.272]], mirror: true, lift: 1 },
    { kind: 'trim', pattern: 'slats-v', rect: [0.14, 0.52, 0.218, 0.266], pitch: 22, fill: 0.35, mirror: true, lift: 2 },
    { kind: 'housing', rect: [-0.06, 0.06, 0.225, 0.262], lift: 1 },
    { kind: 'satin', poly: [[-0.4, 0.19], [0.4, 0.19], [0.44, 0.202], [-0.44, 0.202]], lift: 2 },
  ];
}
/** XUV700-style tail lamps: angled clusters that run forward onto the quarters and hook down at their inner
 * end, joined across the tailgate by a smooth gloss-black panel with a thin satin underline; no light bar. */
function xev9sRear(t: number): FaceItem[] {
  const top = t - 0.025;
  return [
    { kind: 'housing', poly: [[0.56, top - 0.035], [0.62, top + 0.012], [1.13, top + 0.012], [1.13, top - 0.06], [0.72, top - 0.14]], mirror: true, lift: 1 },
    { kind: 'lens', poly: [[0.6, top - 0.033], [0.645, top + 0.002], [1.11, top + 0.002], [1.11, top - 0.052], [0.73, top - 0.125]], mirror: true, lift: 3 },
    { kind: 'tail', pts: [[0.63, top - 0.006], [1.11, top - 0.006]], w: 10, mirror: true, lift: 3 },
    { kind: 'tail', pts: [[0.64, top - 0.035], [0.74, top - 0.115], [0.84, top - 0.098], [1.1, top - 0.045]], w: 7, mirror: true, lift: 3 },
    { kind: 'gloss', rect: [-0.57, 0.57, top - 0.065, top - 0.008] },
    // Fine hexagon-like relief on the joining panel, done as small diamonds.
    { kind: 'housing', pattern: 'diamonds', rect: [-0.54, 0.54, top - 0.058, top - 0.014], pitch: 22, fill: 0.7, lift: 1 },
    { kind: 'satin', pts: [[-0.55, top - 0.07], [0.55, top - 0.07]], w: 4 },
    { kind: 'gloss', poly: [[-1.02, 0.3], [1.02, 0.3], [1.02, 0.19], [-1.02, 0.19]] },
    { kind: 'satin', poly: [[-0.45, 0.188], [0.45, 0.188], [0.4, 0.215], [-0.4, 0.215]], lift: 2 },
    { kind: 'tail', rect: [0.8, 0.95, 0.245, 0.262], mirror: true, lift: 1 },
  ];
}

/** A headlamp cluster for the preset faces, at the pilots' level of detail: a satin bezel (so the lamp still
 * reads on dark paint), a smoked housing, two LED projectors low in it and an amber turn strip at its outer
 * edge. `hw` and `h` are the car's half width and height in metres, so the projectors stay round. */
function cluster(s0: number, s1: number, yTop: number, yBot: number, hw: number, h: number): FaceItem[] {
  const span = s1 - s0;
  const ym = yBot + (yTop - yBot) * 0.42;
  const r = Math.min(0.03, (yTop - yBot) * h * 0.3, span * hw * 0.16);
  return [
    { kind: 'satin', rect: [s0 - 0.012, s1 + 0.012, yBot - 0.006, yTop + 0.006], mirror: true },
    { kind: 'housing', rect: [s0, s1, yBot, yTop], mirror: true, lift: 2 },
    ...projector(s0 + span * 0.3, ym, r, hw, h),
    ...projector(s0 + span * 0.62, ym, r, hw, h),
    { kind: 'turn', pts: [[s1 - 0.03, yTop - 0.012], [s1 - 0.03, yBot + 0.012]], w: 6, mirror: true },
  ];
}
/** The lower bumper of the preset faces: a trapezoid intake that widens downward, with fine slats, over a
 * gloss-black lower lip carrying a satin skid. `top` is the intake's top edge. */
function lowerFace(top: number, w = 0.6): FaceItem[] {
  return [
    { kind: 'intake', poly: [[-w, top], [w, top], [w + 0.1, 0.165], [-w - 0.1, 0.165]] },
    { kind: 'trim', pattern: 'slats-h', rect: [-w + 0.04, w + 0.02, 0.18, top - 0.014], pitch: 24, fill: 0.3, lift: 1 },
    { kind: 'gloss', poly: [[-0.9, 0.158], [0.9, 0.158], [0.97, 0.13], [-0.97, 0.13]], lift: 1 },
    { kind: 'satin', poly: [[-0.4, 0.136], [0.4, 0.136], [0.36, 0.152], [-0.36, 0.152]], lift: 2 },
  ];
}

/** The front face, from the bonnet's leading edge `n` down; `hw` and `h` are the half width and height in metres. */
function frontFace(style: FrontStyle, n: number, hw: number, h: number): FaceItem[] {
  const intakeTop = (below: number) => Math.min(0.3, n - below);
  switch (style) {
    case 'bar-split':
      return [
        { kind: 'drl', pts: [[0, n - 0.012], [0.9, n - 0.012], [0.97, n - 0.028]], w: 9, mirror: true },
        { kind: 'housing', rect: [-0.7, 0.7, n - 0.1, n - 0.065] },
        ...cluster(0.72, 0.96, n - 0.07, n - 0.2, hw, h),
        ...lowerFace(intakeTop(0.24)),
      ];
    case 'bar-down':
      return [
        // The bar's ends turn down the corners inside a smoked surround, so they never run onto bare paint.
        { kind: 'housing', poly: [[0.84, n - 0.004], [0.99, n - 0.004], [1.0, n - 0.125], [0.93, n - 0.125], [0.9, n - 0.03], [0.84, n - 0.03]], mirror: true, lift: 1 },
        { kind: 'housing', rect: [-0.86, 0.86, n - 0.06, n - 0.03] },
        { kind: 'drl', pts: [[0, n - 0.015], [0.88, n - 0.015], [0.955, n - 0.04], [0.965, n - 0.11]], w: 12, mirror: true },
        ...cluster(0.6, 0.88, n - 0.13, n - 0.23, hw, h),
        ...lowerFace(intakeTop(0.26)),
      ];
    case 'c-shape':
      return [
        { kind: 'housing', rect: [-0.78, 0.78, n - 0.1, n - 0.03] },
        { kind: 'housing', poly: [[0.74, n - 0.004], [0.99, n - 0.004], [0.99, n - 0.14], [0.74, n - 0.14]], mirror: true, lift: 1 },
        { kind: 'drl', pts: [[0.97, n - 0.014], [0.8, n - 0.014], [0.76, n - 0.07], [0.8, n - 0.128], [0.97, n - 0.128]], w: 12, mirror: true },
        ...cluster(0.62, 0.9, n - 0.17, n - 0.25, hw, h),
        ...lowerFace(intakeTop(0.28), 0.5),
      ];
    case 'fang':
      return [
        { kind: 'satin', rect: [0.57, 0.98, n - 0.1, n - 0.002], mirror: true },
        { kind: 'housing', rect: [0.58, 0.97, n - 0.092, n - 0.006], mirror: true, lift: 2 },
        { kind: 'drl', pts: [[0.62, n - 0.02], [0.94, n - 0.02]], w: 8, mirror: true },
        ...projector(0.72, n - 0.058, 0.024, hw, h),
        ...projector(0.84, n - 0.058, 0.024, hw, h),
        // The fang: a lit blade dropping from the lamp, in its own smoked slot.
        { kind: 'housing', poly: [[0.8, n - 0.1], [0.9, n - 0.1], [0.91, n - 0.31], [0.82, n - 0.31]], mirror: true, lift: 1 },
        { kind: 'drl', pts: [[0.85, n - 0.11], [0.865, n - 0.3]], w: 14, mirror: true },
        { kind: 'housing', rect: [-0.5, 0.5, n - 0.13, n - 0.02] },
        { kind: 'chrome', pts: [[0, n - 0.135], [0.5, n - 0.135]], w: 8, mirror: true },
        ...lowerFace(intakeTop(0.33), 0.55),
      ];
    case 'swept':
      return [
        ...cluster(0.58, 0.97, n - 0.008, n - 0.1, hw, h),
        { kind: 'drl', pts: [[0.6, n - 0.024], [0.9, n - 0.02], [0.955, n - 0.014]], w: 8, mirror: true, lift: 2 },
        { kind: 'chrome', pts: [[0, n - 0.035], [0.555, n - 0.035]], w: 10, mirror: true },
        ...lowerFace(intakeTop(0.15)),
      ];
    case 'corners':
      return [
        { kind: 'housing', rect: [-0.8, 0.8, n - 0.045, n - 0.01] },
        { kind: 'drl', pts: [[0.7, n - 0.025], [0.79, n - 0.025]], w: 12, mirror: true },
        { kind: 'housing', rect: [0.8, 0.98, n - 0.05, n - 0.004], mirror: true },
        { kind: 'drl', pts: [[0.81, n - 0.025], [0.96, n - 0.025]], w: 12, mirror: true },
        ...cluster(0.7, 0.96, n - 0.12, n - 0.22, hw, h),
        ...lowerFace(intakeTop(0.25)),
      ];
    case 'pixel':
      return [
        { kind: 'satin', rect: [0.61, 0.94, n - 0.11, n - 0.002], mirror: true },
        { kind: 'housing', rect: [0.62, 0.93, n - 0.1, n - 0.012], mirror: true, lift: 2 },
        // Parametric pixels: square LED cells in a grid, with a lit frame.
        { kind: 'drl', pattern: 'dots', rect: [0.66, 0.89, n - 0.082, n - 0.03], pitch: 20, fill: 0.5, mirror: true, lift: 3 },
        { kind: 'drl', pts: [[0.64, n - 0.02], [0.64, n - 0.09], [0.91, n - 0.09], [0.91, n - 0.02], [0.64, n - 0.02]], w: 5, mirror: true },
        ...lowerFace(intakeTop(0.2), 0.66),
      ];
    case 'v-face':
      return [
        { kind: 'drl', pts: [[0, n - 0.07], [0.35, n - 0.015], [0.95, n - 0.015]], w: 11, mirror: true },
        ...cluster(0.64, 0.92, n - 0.13, n - 0.22, hw, h),
        ...lowerFace(intakeTop(0.25)),
      ];
    case 'boomerang':
      return [
        { kind: 'drl', pts: [[0, n - 0.02], [0.64, n - 0.02]], w: 5, mirror: true },
        { kind: 'satin', poly: [[0.645, n + 0.001], [1.0, n + 0.001], [1.01, n - 0.137], [0.93, n - 0.137], [0.89, n - 0.087], [0.645, n - 0.087]], mirror: true },
        { kind: 'housing', poly: [[0.66, n - 0.005], [0.99, n - 0.005], [1.0, n - 0.13], [0.94, n - 0.13], [0.9, n - 0.08], [0.66, n - 0.08]], mirror: true, lift: 2 },
        { kind: 'drl', pts: [[0.68, n - 0.02], [0.95, n - 0.02], [0.975, n - 0.12]], w: 9, mirror: true },
        ...projector(0.76, n - 0.05, 0.022, hw, h),
        ...projector(0.86, n - 0.05, 0.022, hw, h),
        ...lowerFace(intakeTop(0.22), 0.7),
      ];
    case 'drop':
      return [
        { kind: 'satin', rect: [0.59, 0.98, n - 0.083, n - 0.001], mirror: true },
        { kind: 'housing', rect: [0.6, 0.97, n - 0.075, n - 0.005], mirror: true, lift: 2 },
        { kind: 'drl', pts: [[0.62, n - 0.02], [0.95, n - 0.016]], w: 7, mirror: true },
        ...projector(0.74, n - 0.05, 0.02, hw, h),
        ...projector(0.86, n - 0.05, 0.02, hw, h),
        ...lowerFace(intakeTop(0.2), 0.5),
      ];
    case 'strip':
      return [
        { kind: 'drl', pts: [[0, n - 0.01], [0.95, n - 0.01]], w: 10, mirror: true },
        ...cluster(0.62, 0.92, n - 0.13, n - 0.23, hw, h),
        ...lowerFace(intakeTop(0.25), 0.5),
      ];
    case 'thin':
      return [
        { kind: 'drl', pts: [[0, n - 0.01], [0.95, n - 0.01]], w: 5, mirror: true },
        ...cluster(0.72, 0.96, n - 0.05, n - 0.115, hw, h),
        { kind: 'drl', pts: [[0.74, n - 0.062], [0.94, n - 0.058]], w: 5, mirror: true, lift: 2 },
        ...lowerFace(intakeTop(0.2), 0.55),
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
    profile: [0.31, 0.46, 0.87, 0.955, 0.57, 0.65, 0.645, 0.98, 0.705],
    dloX: 0.875,
    faceRake: 0.1,
    front: 'bar-split',
    rear: 'x-bar',
    floatingRoof: true,
    blackRoof: true,
    cladding: true,
    // Five twin spokes, machined faces over dark pockets.
    wheel: 'twin',
    finish: 'two-tone',
    tyre: [215, 60],
    frontOverhang: 0.538,
    noseRound: 0.22,
    frontItems: nexonFront,
    rearItems: nexonRear,
    curves: {
      // Long, flat bonnet with a short, firm lip that the DRL bar sits on.
      hood: [[0, 0.548], [0.007, 0.572], [0.02, 0.586], [0.06, 0.596], [0.31, 0.65]],
      // The window line climbs all the way back and kicks up hard into the thick rear quarter, while the
      // roof falls away from the B-pillar: the coupe-SUV stance, with side glass tapering to a point.
      belt: [[0.31, 0.645], [0.5, 0.656], [0.7, 0.68], [0.8, 0.72], [0.87, 0.77], [0.9, 0.778], [0.955, 0.71]],
      roof: [[0.48, 0.982], [0.6, 0.975], [0.72, 0.955], [0.8, 0.93], [0.87, 0.89]],
    },
    // A wide, flat face with tight corners, so both headlamp pods show from a three-quarter view.
    plan: { noseDepth: 0.25, noseSquare: 3.6, tailDepth: 0.26, tailSquare: 3 },
    hoodCrown: 0.026,
    shoulder: { drop: [0.2, 0.11], tumble: 0.085, sharp: true, crease: { y: [0.44, 0.5], depth: 0.008 } },
    // Silver accent along the rising window line, as on the dual-tone cars.
    glass: { rearPillar: 'body', trim: 'chrome', rearSlant: 0.12 },
    arch: { shape: 'round', gap: 0.013 },
    clad: { archWidth: 0.09, sillH: 0.125, proud: 0.014 },
    lampGlow: 1.2,
  },
  'tata-punch-ev': {
    name: 'Tata Punch EV',
    body: 'suv',
    size: [3880, 1742, 1622, 2445, 195, 16],
    // Roof falls a little toward a raked rear glass over a short tail; the side glass ends ahead of a
    // thick C-pillar that carries the rear door handle.
    profile: [0.29, 0.44, 0.88, 0.965, 0.6, 0.665, 0.66, 0.955, 0.69],
    dloX: 0.865,
    front: 'corners',
    rear: 'bar',
    floatingRoof: true,
    blackRoof: true,
    cladding: true,
    roofRails: true,
    noseRound: 0.15,
    faceRake: 0.06,
    wheel: 'aero',
    spokes: 6,
    finish: 'two-tone',
    tyre: [195, 60],
    frontItems: punchFront,
    rearItems: punchRear,
    // Short, high clamshell bonnet with a firm rounded lip.
    // A tall, stubby body: high bonnet and window line, so the glass is a short band under the rails.
    curves: {
      hood: [[0, 0.575], [0.008, 0.598], [0.022, 0.612], [0.06, 0.624], [0.29, 0.665]],
      roof: [[0.44, 0.955], [0.62, 0.953], [0.78, 0.945], [0.88, 0.93]],
      belt: [[0.29, 0.665], [0.5, 0.66], [0.75, 0.664], [0.85, 0.69], [0.965, 0.69]],
    },
    plan: { noseDepth: 0.22, noseSquare: 3.8, tailDepth: 0.2, tailSquare: 3.6 },
    hoodCrown: 0.03,
    shoulder: { drop: [0.12, 0.1], tumble: 0.055, sharp: true },
    glass: { rearPillar: 'body', trim: 'black', rearSlant: 0.07 },
    arch: { shape: 'squared', gap: 0.014 },
    clad: { colour: '#4a4d52', archWidth: 0.09, sillH: 0.14, proud: 0.018 },
    handles: 'pillar-rear',
    lampGlow: 1.2,
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
  },
  'tata-curvv-ev': {
    name: 'Tata Curvv EV',
    body: 'coupe',
    size: [4310, 1810, 1637, 2560, 186, 18],
    profile: [0.31, 0.45, 0.64, 0.95, 0.56, 0.63, 0.62, 0.98, 0.73],
    roofRearH: 0.96,
    dloX: 0.78,
    front: 'bar-split',
    rear: 'bar',
    cladding: true,
    flushHandles: true,
    wheel: 'aero',
    finish: 'two-tone',
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
  },
  'mahindra-xev9s': {
    name: 'Mahindra XEV 9S',
    body: 'suv',
    size: [4737, 1900, 1747, 2762, 205, 18],
    // Tall, upright three-row body: the bonnet and beltline sit a little above the photo estimates, which
    // read as a low estate car in the renders.
    // The published height includes the roof rails, so the roof skin sits a rail height below it.
    profile: [0.31, 0.45, 0.9, 0.962, 0.6, 0.665, 0.66, 0.965, 0.705],
    front: 'bar-down',
    rear: 'wrap',
    cladding: true,
    roofRails: true,
    flushHandles: true,
    // Five wide, swirling aero blades, two-tone.
    wheel: 'blade',
    finish: 'two-tone',
    tyre: [235, 60],
    noseRound: 0.2,
    faceRake: 0.07,
    frontItems: xev9sFront,
    rearItems: xev9sRear,
    // Upright XUV700 body: the window line kicks up at the C-pillar into a body-colour D-pillar.
    curves: {
      // Big rounded bonnet lip over the full-width light bar.
      hood: [[0, 0.57], [0.008, 0.597], [0.022, 0.614], [0.06, 0.626], [0.31, 0.665]],
      // High window line that rises gently, then kicks up sharply into the body-colour D-pillar.
      belt: [[0.31, 0.66], [0.6, 0.67], [0.78, 0.685], [0.815, 0.695], [0.86, 0.765], [0.962, 0.705]],
      // The roof falls slightly toward the tailgate over the third row.
      roof: [[0.45, 0.965], [0.65, 0.964], [0.82, 0.955], [0.9, 0.942]],
    },
    plan: { noseDepth: 0.3, noseSquare: 3.4, tailDepth: 0.26, tailSquare: 3.2 },
    arch: { shape: 'round', gap: 0.014 },
    hoodCrown: 0.05,
    shoulder: { drop: [0.17, 0.13], tumble: 0.1, sharp: true, crease: { y: [0.47, 0.5], depth: 0.01 } },
    glass: { rearPillar: 'body', trim: 'chrome', rearSlant: 0.05 },
    clad: { colour: '#0b0c0e', archWidth: 0.075, sillH: 0.13, proud: 0.014 },
    lampGlow: 1.3,
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
  },
  'tesla-model-y': {
    name: 'Tesla Model Y',
    body: 'coupe',
    size: [4790, 1920, 1624, 2890, 167, 19],
    profile: [0.27, 0.45, 0.66, 0.955, 0.5, 0.59, 0.61, 1, 0.71],
    dloX: 0.83,
    faceRake: 0.2,
    front: 'thin',
    rear: 'thin',
    flushHandles: true,
    spokes: 10,
    wheel: 'aero',
    finish: 'gunmetal',
    frontOverhang: 0.5,
    noseRound: 0.75,
  },
  'vinfast-vf7': {
    name: 'VinFast VF 7',
    body: 'coupe',
    size: [4550, 1893, 1596, 2840, 190, 19],
    profile: [0.3, 0.47, 0.7, 0.95, 0.53, 0.6, 0.62, 1, 0.72],
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
  },
};

function make(s: Spec, paints: ReadonlyArray<readonly [string, string]> = []): CarDesign {
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
    hoodCrown: s.hoodCrown ?? 0.022,
    roofWidth: s.body === 'micro' ? 0.84 : s.body === 'mpv' ? 0.8 : coupe ? 0.68 : 0.73,
    noseRound,
    roof: s.blackRoof ? 'black' : 'body',
    pillars: 'black',
    cladding: s.cladding ?? false,
    roofRails: s.roofRails ?? false,
    flushHandles: s.flushHandles ?? false,
    spoiler: s.body !== 'sedan',
    wheel: { spokes: s.spokes ?? 5, style: s.wheel ?? 'spoke', finish: s.finish ?? 'silver' },
    front: s.frontItems ? s.frontItems(hoodFrontH) : frontFace(s.front, hoodFrontH, widthMm / 2000, heightMm / 1000),
    rear: s.rearItems ? s.rearItems(tailH) : rearFace(s.rear, tailH),
    paints: paints.map(([name, hex]): CarPaint => ({ name, hex: hex.toLowerCase() })),
  };
}

export const DESIGNS: Record<string, CarDesign> = Object.fromEntries(Object.entries(SPECS).map(([k, s]) => [k, make(s, PAINT_SPECS[k])]));

/** For a custom car: a plain body of the right kind. */
const GENERIC: Record<BodyStyle, CarDesign> = {
  suv: make({ ...SPECS['hyundai-creta-electric'], name: 'Electric SUV', front: 'thin', rear: 'bar' }),
  coupe: make({ ...SPECS['kia-ev6'], name: 'Electric coupe SUV', front: 'thin', rear: 'thin' }),
  hatch: make({ ...SPECS['tata-tiago-ev'], name: 'Electric hatchback', front: 'thin', rear: 'bar' }),
  sedan: make({ ...SPECS['byd-seal'], name: 'Electric sedan', front: 'thin', rear: 'thin' }),
  mpv: make({ ...SPECS['byd-emax7'], name: 'Electric MPV', front: 'thin', rear: 'bar' }),
  micro: make({ ...SPECS['mg-comet'], name: 'Electric city car' }),
};

/** The design for an app vehicle id: its own when ChargeOne has one, else a generic body. */
export function designFor(modelId: string): { design: CarDesign; exact: boolean } {
  const key = Object.keys(DESIGNS).find((k) => modelId.startsWith(k));
  if (key) return { design: DESIGNS[key], exact: true };
  return { design: GENERIC.suv, exact: false };
}

export { DEFAULT_PAINTS, paintsFor } from './carPaints.ts';
