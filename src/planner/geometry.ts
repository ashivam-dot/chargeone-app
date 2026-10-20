export type Coord = [number, number] | [number, number, number];

export interface RouteGeometry {
  coords: Coord[];
  distanceKm: number;
  durationMin: number;
}

const EARTH_KM = 6371;
const toRad = (d: number) => (d * Math.PI) / 180;

export function haversineKm(a: Coord, b: Coord): number {
  const dLat = toRad(b[1] - a[1]);
  const dLng = toRad(b[0] - a[0]);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a[1])) * Math.cos(toRad(b[1])) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_KM * Math.asin(Math.sqrt(h));
}

export function cumulativeKm(coords: Coord[]): number[] {
  const out = new Array<number>(coords.length);
  out[0] = 0;
  for (let i = 1; i < coords.length; i++) out[i] = out[i - 1] + haversineKm(coords[i - 1], coords[i]);
  return out;
}

export interface Projection {
  /** Distance along the route to the closest point, km. */
  alongKm: number;
  /** Straight-line distance from the route to the point, km. */
  offKm: number;
}

/**
 * Projects points onto a route polyline. Segments are bucketed in a lat/lng grid (sampled every
 * ~1 km, so long straight segments are found too) and each point only checks nearby segments.
 */
export class RouteIndex {
  private readonly cell = 0.02;
  private readonly grid = new Map<string, Set<number>>();
  readonly cumKm: number[];
  readonly bbox: [number, number, number, number];

  constructor(readonly coords: Coord[]) {
    this.cumKm = cumulativeKm(coords);
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const c of coords) {
      minX = Math.min(minX, c[0]); maxX = Math.max(maxX, c[0]);
      minY = Math.min(minY, c[1]); maxY = Math.max(maxY, c[1]);
    }
    for (let i = 0; i < coords.length - 1; i++) {
      const a = coords[i], b = coords[i + 1];
      const steps = Math.max(1, Math.ceil(this.cumKm[i + 1] - this.cumKm[i]));
      for (let s = 0; s <= steps; s++) {
        const t = s / steps;
        const key = this.key(a[0] + t * (b[0] - a[0]), a[1] + t * (b[1] - a[1]));
        const bucket = this.grid.get(key);
        if (bucket) bucket.add(i);
        else this.grid.set(key, new Set([i]));
      }
    }
    this.bbox = [minX, minY, maxX, maxY];
  }

  private key(lng: number, lat: number): string {
    return `${Math.floor(lng / this.cell)}:${Math.floor(lat / this.cell)}`;
  }

  get lengthKm(): number {
    return this.cumKm[this.cumKm.length - 1] ?? 0;
  }

  project(lng: number, lat: number, maxOffKm: number): Projection | null {
    const pad = maxOffKm / 100;
    const [minX, minY, maxX, maxY] = this.bbox;
    if (lng < minX - pad || lng > maxX + pad || lat < minY - pad || lat > maxY + pad) return null;

    const reach = Math.ceil(maxOffKm / (this.cell * 100)) + 1;
    const cx = Math.floor(lng / this.cell);
    const cy = Math.floor(lat / this.cell);
    const candidates = new Set<number>();
    for (let dx = -reach; dx <= reach; dx++) {
      for (let dy = -reach; dy <= reach; dy++) {
        for (const i of this.grid.get(`${cx + dx}:${cy + dy}`) ?? []) candidates.add(i);
      }
    }
    let best: Projection | null = null;
    for (const i of candidates) {
      const p = this.projectOnSegment(i, lng, lat);
      if (p.offKm <= maxOffKm && (!best || p.offKm < best.offKm)) best = p;
    }
    return best;
  }

  /** Equirectangular projection is accurate enough at segment scale. */
  private projectOnSegment(i: number, lng: number, lat: number): Projection {
    const a = this.coords[i];
    const b = this.coords[i + 1];
    const kx = Math.cos(toRad(lat)) * 111.32;
    const ky = 110.57;
    const ax = a[0] * kx, ay = a[1] * ky;
    const bx = b[0] * kx, by = b[1] * ky;
    const px = lng * kx, py = lat * ky;
    const dx = bx - ax, dy = by - ay;
    const len2 = dx * dx + dy * dy;
    const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / len2));
    const qx = ax + t * dx, qy = ay + t * dy;
    const segKm = this.cumKm[i + 1] - this.cumKm[i];
    return { alongKm: this.cumKm[i] + t * segKm, offKm: Math.hypot(px - qx, py - qy) };
  }

  /** Point on the route at a given distance along it. */
  pointAt(alongKm: number): [number, number] {
    const km = Math.max(0, Math.min(alongKm, this.lengthKm));
    let lo = 0, hi = this.cumKm.length - 1;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (this.cumKm[mid] <= km) lo = mid;
      else hi = mid;
    }
    const seg = this.cumKm[hi] - this.cumKm[lo];
    const t = seg === 0 ? 0 : (km - this.cumKm[lo]) / seg;
    const a = this.coords[lo], b = this.coords[hi];
    return [a[0] + t * (b[0] - a[0]), a[1] + t * (b[1] - a[1])];
  }
}
