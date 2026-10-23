// Geohash blocking, distances and state lookup.
export { distanceMetres } from '../../src/data/normalize.ts';

const BASE32 = '0123456789bcdefghjkmnpqrstuvwxyz';

export function geohash(lat: number, lng: number, precision: number): string {
  let latLo = -90;
  let latHi = 90;
  let lngLo = -180;
  let lngHi = 180;
  let bits = 0;
  let bit = 0;
  let even = true;
  let out = '';
  while (out.length < precision) {
    if (even) {
      const mid = (lngLo + lngHi) / 2;
      if (lng >= mid) {
        bits = (bits << 1) | 1;
        lngLo = mid;
      } else {
        bits <<= 1;
        lngHi = mid;
      }
    } else {
      const mid = (latLo + latHi) / 2;
      if (lat >= mid) {
        bits = (bits << 1) | 1;
        latLo = mid;
      } else {
        bits <<= 1;
        latHi = mid;
      }
    }
    even = !even;
    if (++bit === 5) {
      out += BASE32[bits];
      bits = 0;
      bit = 0;
    }
  }
  return out;
}

/** Cell size in degrees at a precision: [lat, lng]. */
export function geohashCellSize(precision: number): [number, number] {
  const lngBits = Math.ceil((precision * 5) / 2);
  const latBits = Math.floor((precision * 5) / 2);
  return [180 / 2 ** latBits, 360 / 2 ** lngBits];
}

/** The cell of a point and its 8 neighbours, for candidate blocking. */
export function geohashBlock(lat: number, lng: number, precision: number): string[] {
  const [dLat, dLng] = geohashCellSize(precision);
  const cells = new Set<string>();
  for (const dy of [-1, 0, 1]) for (const dx of [-1, 0, 1]) cells.add(geohash(lat + dy * dLat, lng + dx * dLng, precision));
  return [...cells];
}

/** Rough India bounding box; records outside it are not Indian stations. */
export function inIndia(lat: number, lng: number): boolean {
  return lat >= 6 && lat <= 37.6 && lng >= 68 && lng <= 97.5;
}

export function round6(n: number): number {
  return Math.round(n * 1e6) / 1e6;
}

type Ring = Array<[number, number]>;
type PolygonCoords = Ring[];

export interface StateShape {
  name: string;
  bbox: [number, number, number, number];
  polygons: PolygonCoords[];
}

interface GeoJsonFeature {
  properties: Record<string, unknown>;
  geometry: { type: 'Polygon'; coordinates: PolygonCoords } | { type: 'MultiPolygon'; coordinates: PolygonCoords[] };
}

/** Reads a GeoJSON FeatureCollection of states, naming each with `nameOf`. */
export function stateShapes(geojson: { features: GeoJsonFeature[] }, nameOf: (props: Record<string, unknown>) => string): StateShape[] {
  return geojson.features.map((f) => {
    const polygons = f.geometry.type === 'Polygon' ? [f.geometry.coordinates] : f.geometry.coordinates;
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (const poly of polygons) {
      for (const [x, y] of poly[0]) {
        minX = Math.min(minX, x);
        minY = Math.min(minY, y);
        maxX = Math.max(maxX, x);
        maxY = Math.max(maxY, y);
      }
    }
    return { name: nameOf(f.properties), bbox: [minX, minY, maxX, maxY], polygons };
  });
}

function inRing(x: number, y: number, ring: Ring): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

function inPolygon(x: number, y: number, poly: PolygonCoords): boolean {
  if (!inRing(x, y, poly[0])) return false;
  for (let h = 1; h < poly.length; h++) if (inRing(x, y, poly[h])) return false;
  return true;
}

/** The state containing a point, or null (offshore, or just outside a simplified coastline). */
export function stateAt(shapes: StateShape[], lat: number, lng: number): string | null {
  for (const s of shapes) {
    const [minX, minY, maxX, maxY] = s.bbox;
    if (lng < minX || lng > maxX || lat < minY || lat > maxY) continue;
    if (s.polygons.some((p) => inPolygon(lng, lat, p))) return s.name;
  }
  return null;
}
