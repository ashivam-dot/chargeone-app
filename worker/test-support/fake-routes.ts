// A stand-in for the OSRM demo server: each route runs straight between the requested points
// (start, any via points, destination), densely sampled, at 60 km/h.
import { haversineKm, type Coord } from '../../src/planner/geometry.ts';

export interface RouteStubOptions {
  /** Road distance to report for the straight-line distance through the points. */
  roadKm?: (straightKm: number, points: Coord[]) => number;
  status?: number;
}

export function lineThrough(points: Coord[], stepsPerLeg = 40): Coord[] {
  const out: Coord[] = [points[0]];
  for (let i = 1; i < points.length; i++) {
    const [a, b] = [points[i - 1], points[i]];
    for (let s = 1; s <= stepsPerLeg; s++) out.push([a[0] + ((b[0] - a[0]) * s) / stepsPerLeg, a[1] + ((b[1] - a[1]) * s) / stepsPerLeg]);
  }
  return out;
}

export const lengthKm = (coords: Coord[]) => coords.slice(1).reduce((km, c, i) => km + haversineKm(coords[i], c), 0);

export function osrmStub(opts: RouteStubOptions = {}) {
  const calls: Coord[][] = [];
  const fetch = async (input: string | URL | Request) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (url.hostname !== 'router.project-osrm.org') throw new Error(`unexpected fetch ${url}`);
    const points = decodeURIComponent(url.pathname.split('/').pop()!)
      .split(';')
      .map((p) => p.split(',').map(Number) as Coord);
    calls.push(points);
    if (opts.status) return new Response('busy', { status: opts.status });
    const coords = lineThrough(points);
    const km = opts.roadKm ? opts.roadKm(lengthKm(coords), points) : lengthKm(coords);
    return Response.json({ code: 'Ok', routes: [{ distance: km * 1000, duration: km * 60, geometry: { coordinates: coords } }] });
  };
  return { calls, fetch };
}
