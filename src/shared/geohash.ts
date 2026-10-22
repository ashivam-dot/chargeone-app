// Geohash cell bounds, shared by the app and the worker to find which data cells cover an area.
const BASE32 = '0123456789bcdefghjkmnpqrstuvwxyz';

export interface Bounds {
  south: number;
  west: number;
  north: number;
  east: number;
}

/** The box a geohash cell covers. Throws on characters that aren't geohash. */
export function geohashBounds(cell: string): Bounds {
  let latLo = -90;
  let latHi = 90;
  let lngLo = -180;
  let lngHi = 180;
  let even = true;
  for (const ch of cell) {
    const v = BASE32.indexOf(ch);
    if (v < 0) throw new Error(`not a geohash: ${cell}`);
    for (let bit = 4; bit >= 0; bit--) {
      const on = (v >> bit) & 1;
      if (even) {
        const mid = (lngLo + lngHi) / 2;
        if (on) lngLo = mid;
        else lngHi = mid;
      } else {
        const mid = (latLo + latHi) / 2;
        if (on) latLo = mid;
        else latHi = mid;
      }
      even = !even;
    }
  }
  return { south: latLo, west: lngLo, north: latHi, east: lngHi };
}

/** A box around a point: radiusKm in every direction. */
export function boundsAround(at: { lat: number; lng: number }, radiusKm: number): Bounds {
  const dLat = radiusKm / 111.32;
  const dLng = radiusKm / (111.32 * Math.max(0.05, Math.cos((at.lat * Math.PI) / 180)));
  return { south: at.lat - dLat, west: at.lng - dLng, north: at.lat + dLat, east: at.lng + dLng };
}

export function boundsIntersect(a: Bounds, b: Bounds): boolean {
  return a.south <= b.north && b.south <= a.north && a.west <= b.east && b.west <= a.east;
}

/** The cells (from a published list) that overlap a box. */
export function cellsCovering(cells: Iterable<string>, box: Bounds): string[] {
  return [...cells].filter((c) => boundsIntersect(geohashBounds(c), box));
}
