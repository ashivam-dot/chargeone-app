// Realistic driving time for a Valhalla route on Indian highways.
//
// Why: the public FOSSGIS Valhalla server gives Indian highways road-class default speeds that are far
// below what cars drive. Its own edge data (trace_attributes on NH44 near Kurnool, 2026-10-23) shows
// four-lane NH44 as `trunk`, speed 41 km/h, speed_type "classified", even where OSM tags maxspeed=100.
// On the benchmark routes every long national-highway stretch comes back at 32-46 km/h (NH44
// Hyderabad-Bengaluru 548 km at 39 km/h, NH16 Kolkata-Bhubaneswar 297 km at 41, NH66 Konkan at 35),
// so Nadiad-Hyderabad (1,196 km) took 27.5 h and Hyderabad-Bengaluru (570 km) 14.9 h. Every day split
// built on those times is wrong.
//
// Method (no Google or other proprietary times are used):
// 1. Ask Valhalla for maneuvers (`directions_type: 'maneuvers'`, no extra request). Each maneuver is
//    one stretch of named road with its own length, time and shape. Its class comes from Valhalla's
//    own output: `highway: true` means a motorway (an expressway); a street name like "NH44", "NE4" or
//    "AH43" means a national highway; "SH17" a state highway. Anything else keeps Valhalla's time.
// 2. The ceiling is the legal car (M1) speed limit from MoRTH notification S.O. 1522(E) of 6 April
//    2018: 120 km/h on expressways, 100 km/h on national highways of four or more lanes with a divider,
//    and 70 km/h on other roads. Nobody averages the limit, so the target is a share of it: 75% on
//    expressways (90 km/h), 65% on national highways (65 km/h, low because many NHs are two-lane or
//    pass through villages), 70% of 70 on state highways (49 km/h).
// 3. Terrain from the route shape: each 2 km of a stretch is measured for how winding it is (path
//    length over straight-line distance): straight (up to 1.04), rolling (up to 1.10) or winding.
//    Winding windows keep Valhalla's own, slower speed. On open country, straight windows get the
//    class target and rolling ones 55 km/h. A stretch where at least a fifth of the windows wind is a
//    hill or ghat road: there straight windows get 50 km/h and rolling ones 40 km/h (valley floors
//    in the hills still have towns, trucks and single lanes). No window is planned faster than its
//    class target, and none slower than Valhalla rated it, except where Valhalla is above the target.
// 4. Left as Valhalla says: stretches under 5 km (junctions, ramps, town streets), and any stretch
//    Valhalla already rates below 30 km/h (its sign of a dense town or city).
// The result is a moving time: breaks, meals and charging are added by the planner on top.
// These shares are assumptions, not measurements. Check them against logged real drives (audit R40).

/** Legal car speed limits, MoRTH S.O. 1522(E), 6 April 2018 (M1 category). */
export const MORTH_CAR_LIMIT_KMH = { expressway: 120, nationalHighway: 100, other: 70 } as const;
/** Average moving speed we plan with, by road class. */
export const PLAN_SPEED_KMH = {
  expressway: MORTH_CAR_LIMIT_KMH.expressway * 0.75,
  nationalHighway: MORTH_CAR_LIMIT_KMH.nationalHighway * 0.65,
  stateHighway: MORTH_CAR_LIMIT_KMH.other * 0.7,
} as const;
/** Ceilings by terrain, [open country, hill road], for straight and rolling windows. */
export const STRAIGHT_KMH = [Infinity, 50] as const;
export const ROLLING_KMH = [55, 40] as const;
const ROLLING_SINUOSITY = 1.04;
const WINDING_SINUOSITY = 1.1;
/** Share of winding windows that makes a stretch a hill road. */
const HILL_SHARE = 0.2;
const WINDOW_KM = 2;
const MIN_STRETCH_KM = 5;
/** Valhalla rates dense town roads below this; we never second-guess a town. */
const TOWN_KMH = 30;

export type RoadClass = keyof typeof PLAN_SPEED_KMH | 'other';

/** The parts of a Valhalla maneuver this needs. */
export interface ValhallaManeuver {
  time?: number;
  length?: number;
  street_names?: string[];
  highway?: boolean;
  begin_shape_index?: number;
  end_shape_index?: number;
}

const NATIONAL = /^(NH|NE|AH)[\s-]?\d/i;
const STATE = /^SH[\s-]?\d/i;

export function roadClass(m: Pick<ValhallaManeuver, 'highway' | 'street_names'>): RoadClass {
  if (m.highway) return 'expressway';
  const names = m.street_names ?? [];
  if (names.some((n) => NATIONAL.test(n.trim()))) return 'nationalHighway';
  if (names.some((n) => STATE.test(n.trim()))) return 'stateHighway';
  return 'other';
}

/** Great-circle distance in km between [lng, lat] points. */
function km(a: readonly number[], b: readonly number[]): number {
  const rad = Math.PI / 180;
  const dLat = (b[1] - a[1]) * rad;
  const dLng = (b[0] - a[0]) * rad;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a[1] * rad) * Math.cos(b[1] * rad) * Math.sin(dLng / 2) ** 2;
  return 2 * 6371 * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** Splits a polyline into about-2 km windows: [path km, sinuosity] for each. */
export function windows(shape: ReadonlyArray<readonly number[]>): Array<[pathKm: number, sinuosity: number]> {
  const out: Array<[number, number]> = [];
  let start = 0;
  let path = 0;
  for (let i = 1; i < shape.length; i++) {
    path += km(shape[i - 1], shape[i]);
    if (path >= WINDOW_KM || i === shape.length - 1) {
      out.push([path, path / Math.max(1e-3, km(shape[start], shape[i]))]);
      start = i;
      path = 0;
    }
  }
  return out;
}

/** Seconds for one maneuver: Valhalla's time, or the class speed on long open-road stretches. */
export function maneuverSeconds(m: ValhallaManeuver, legShape: ReadonlyArray<readonly number[]>): number {
  const seconds = m.time ?? 0;
  const length = m.length ?? 0;
  const cls = roadClass(m);
  if (cls === 'other' || length < MIN_STRETCH_KM || seconds <= 0) return seconds;
  const valhallaKmh = length / (seconds / 3600);
  if (valhallaKmh < TOWN_KMH) return seconds;
  const target = PLAN_SPEED_KMH[cls];
  const shape = legShape.slice(m.begin_shape_index ?? 0, (m.end_shape_index ?? legShape.length - 1) + 1);
  const parts = windows(shape);
  const drawn = parts.reduce((sum, [p]) => sum + p, 0);
  // Without a usable shape, treat the whole stretch as one straight window.
  if (drawn <= 0) return (length / target) * 3600;
  const hill = parts.filter(([, s]) => s > WINDING_SINUOSITY).length >= HILL_SHARE * parts.length ? 1 : 0;
  let hours = 0;
  for (const [p, sinuosity] of parts) {
    // Window lengths are scaled so they add up to Valhalla's length for the stretch.
    const part = (p / drawn) * length;
    const asValhalla = Math.min(valhallaKmh, target);
    const ceiling = sinuosity > WINDING_SINUOSITY ? 0 : sinuosity > ROLLING_SINUOSITY ? ROLLING_KMH[hill] : STRAIGHT_KMH[hill];
    const kmh = Math.max(asValhalla, Math.min(target, ceiling));
    hours += part / kmh;
  }
  return hours * 3600;
}

/**
 * Minutes of driving for a whole Valhalla trip, leg by leg. Legs without maneuvers (an older
 * request shape) keep Valhalla's own time.
 */
export function realisticMinutes(legs: ReadonlyArray<{ maneuvers?: ValhallaManeuver[]; summary?: { time?: number } }>, shapes: ReadonlyArray<ReadonlyArray<readonly number[]>>): number {
  let seconds = 0;
  legs.forEach((leg, i) => {
    if (!leg.maneuvers?.length) seconds += leg.summary?.time ?? 0;
    else for (const m of leg.maneuvers) seconds += maneuverSeconds(m, shapes[i] ?? []);
  });
  return seconds / 60;
}
