// The shape of a car, as numbers the 3D generator (carMesh.ts) turns into a model.
// Lengths are millimetres unless marked metres; profile heights are fractions of the overall height and
// positions along the car (`t`) are fractions of the overall length from the front bumper (0) to the rear (1).

export type BodyStyle = 'suv' | 'coupe' | 'hatch' | 'sedan' | 'mpv' | 'micro';

/**
 * What a face item is made of. Lamps: `drl` (white, lit), `turn` (amber), `tail` (red, lit), `lens` (dark red
 * unlit tail-lamp lens), `housing` (smoked lamp housing). Panels: `gloss` (piano black), `body` (paint colour, a
 * raised closed-grille panel), `intake`/`grille`/`trim` (dark plastic), `clad` (the car's cladding colour),
 * `satin` (brushed silver skid plates and strakes), `chrome`, `skid` (old name for satin).
 */
export type FaceKind =
  | 'drl'
  | 'turn'
  | 'tail'
  | 'lens'
  | 'housing'
  | 'gloss'
  | 'body'
  | 'intake'
  | 'grille'
  | 'trim'
  | 'clad'
  | 'satin'
  | 'chrome'
  | 'skid';

/** A point on the front or rear face. `s` runs from the centre line (0) to the corner (1) as a fraction of
 * half the width, measured along the surface, and past 1 it wraps onto the side; `y` is a fraction of height. */
export type FacePt = [s: number, y: number];

/** A stroke: a light line or a trim line. */
export interface FaceLine {
  kind: FaceKind;
  pts: FacePt[];
  /** Stroke width, millimetres. */
  w: number;
  /** Also draw it on the other side of the centre line. */
  mirror?: boolean;
}
/** A rectangle in face coordinates. A panel from -s to s is one piece across the centre. */
export interface FacePanel {
  kind: FaceKind;
  rect: [s0: number, s1: number, y0: number, y1: number];
  mirror?: boolean;
  /** Extra millimetres it stands off the surface. */
  lift?: number;
}
/** Any polygon in face coordinates (lamp pods, trapezoid intakes, arrow DRLs). */
export interface FacePoly {
  kind: FaceKind;
  poly: FacePt[];
  mirror?: boolean;
  /** Extra millimetres it stands off the surface (stacks it over other items). */
  lift?: number;
}
/** A repeated pattern filling a rectangle: the closed-face textures of EVs, done as geometry. */
export interface FacePattern {
  kind: FaceKind;
  pattern: 'slats-h' | 'slats-v' | 'triangles' | 'chevrons' | 'dots' | 'diamonds';
  rect: [s0: number, s1: number, y0: number, y1: number];
  /** Repeat distance, millimetres. */
  pitch: number;
  /** Share of the pitch that is solid (0..1), default 0.5. */
  fill?: number;
  mirror?: boolean;
  lift?: number;
}
export type FaceItem = FaceLine | FacePanel | FacePoly | FacePattern;

/** Control points `[t, h]` of a side-view line; the generator runs a smooth, non-overshooting curve through them. */
export type Curve = Array<[t: number, h: number]>;

export type WheelStyle = 'spoke' | 'twin' | 'multi' | 'aero' | 'turbine' | 'disc';
export type WheelFinish = 'silver' | 'two-tone' | 'black' | 'gunmetal';

export interface CarPaint {
  name: string;
  hex: string;
}

export interface CarDesign {
  name: string;
  body: BodyStyle;
  lengthMm: number;
  widthMm: number;
  heightMm: number;
  wheelbaseMm: number;
  clearanceMm: number;
  rimInch: number;
  /** Tyre section width (mm) and aspect ratio (%), e.g. [215, 60] for 215/60 R16. Default: by rim size. */
  tyre?: [widthMm: number, aspect: number];
  /** Share of the total overhang that is in front of the front axle. */
  frontOverhang: number;
  profile: {
    /** Top of the front face (bumper and lamps) where the nose rounds into the bonnet. */
    noseH: number;
    hoodFrontH: number;
    hoodCowlH: number;
    cowlX: number;
    roofFrontX: number;
    roofRearX: number;
    rearGlassX: number;
    /** Window sill just behind the windscreen; it rises to tailH at the bottom of the rear glass. */
    beltH: number;
    roofH: number;
    /** Roof height where the rear glass starts (a coupe roof falls toward it). */
    roofRearH: number;
    tailH: number;
    /** Where the side windows end at the beltline; behind it is pillar. */
    dloX: number;
  };
  /** Optional side-view curves that replace the straight-line defaults between the profile stations. */
  curves?: {
    /** Bonnet top from the nose (t = 0) to the cowl. */
    hood?: Curve;
    /** Roof skin between roofFrontX and roofRearX. */
    roof?: Curve;
    /** Window sill from just behind the cowl to the rear glass: a kick-up at the C-pillar goes here. */
    belt?: Curve;
  };
  /** Top-down shape. Depths are metres from the bumper tip over which the body reaches full width;
   * `square` is a superellipse power (2 round, 4 nearly square corners). */
  plan: { noseDepth: number; noseSquare: number; tailDepth: number; tailSquare: number; roofTaper: number };
  /** Shoulder line: metres below the body top at the front and rear, how far the side above it leans in
   * (metres), and whether it is a sharp crease. `crease` adds a lower door crease. */
  shoulder: {
    drop: [front: number, rear: number];
    tumble: number;
    sharp: boolean;
    crease?: { y: [front: number, rear: number]; depth: number };
  };
  /** How far the top of the front face leans back from the bumper line, metres (a wedge nose is large). */
  faceRake: number;
  /** Roof width as a share of body width. */
  roofWidth: number;
  /** How rounded the nose is (0 boxy, 1 very round); it also rounds the bonnet's top corners. */
  noseRound: number;
  roof: 'body' | 'black';
  pillars: 'body' | 'black';
  glass: {
    /** Pillar colour behind the rear doors: black for a floating roof, body for a solid D-pillar. */
    rearPillar: 'body' | 'black';
    /** Window surround and beltline trim. */
    trim: 'chrome' | 'black' | 'none';
    /** Where the B and C pillars stand (t); default from the profile. */
    pillarsAt?: number[];
    /** Metres the rear edge of the side glass leans forward at the top. */
    rearSlant: number;
  };
  arch: { shape: 'round' | 'squared'; gap: number };
  cladding: boolean;
  /** Cladding colour, how wide it runs round the arches and up the sills, and how far it stands proud (metres). */
  clad: { colour: string; archWidth: number; sillH: number; proud: number; bumpers: boolean };
  roofRails: boolean;
  flushHandles: boolean;
  /** `pillar-rear`: rear door handles hidden up in the C-pillar. */
  handles: 'standard' | 'flush' | 'pillar-rear';
  spoiler: boolean;
  wheel: { spokes: number; style: WheelStyle; finish: WheelFinish };
  /** DRL glow while the car is not connected, 0..2. */
  lampGlow: number;
  front: FaceItem[];
  rear: FaceItem[];
  paints: CarPaint[];
}
