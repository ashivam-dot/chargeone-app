// The shape of a car, as numbers the 3D generator (carMesh.ts) turns into a model.
// Lengths are millimetres; profile heights are fractions of the overall height and positions along the
// car are fractions of the overall length from the front bumper (0) to the rear bumper (1).

export type BodyStyle = 'suv' | 'coupe' | 'hatch' | 'sedan' | 'mpv' | 'micro';

/** A lamp, trim or panel on the front or rear face. `s` runs from the centre line (0) to the corner (1)
 * as a fraction of half the width, and past 1 it wraps onto the side; `y` is a fraction of the height. */
export interface FaceLine {
  kind: 'drl' | 'turn' | 'tail' | 'trim' | 'chrome';
  pts: Array<[s: number, y: number]>;
  /** Stroke width, millimetres. */
  w: number;
  /** Also draw it on the other side of the centre line. */
  mirror?: boolean;
}
export interface FacePanel {
  kind: 'housing' | 'grille' | 'intake' | 'skid' | 'tail' | 'drl' | 'chrome' | 'trim';
  /** s0, s1, y0, y1 as above. A panel from -s to s is one piece across the centre. */
  rect: [s0: number, s1: number, y0: number, y1: number];
  mirror?: boolean;
}
export type FaceItem = FaceLine | FacePanel;

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
    /** Where the side windows end; behind it is pillar. */
    dloX: number;
  };
  /** How far the top of the front face leans back from the bumper line, metres (a wedge nose is large). */
  faceRake: number;
  /** Roof width as a share of body width. */
  roofWidth: number;
  /** How rounded the nose is seen from above (0 boxy, 1 very round). */
  noseRound: number;
  roof: 'body' | 'black';
  pillars: 'body' | 'black';
  cladding: boolean;
  roofRails: boolean;
  flushHandles: boolean;
  spoiler: boolean;
  wheel: { spokes: number; style: 'spoke' | 'aero' | 'turbine'; finish: 'silver' | 'two-tone' | 'black' | 'gunmetal' };
  front: FaceItem[];
  rear: FaceItem[];
  paints: CarPaint[];
}
