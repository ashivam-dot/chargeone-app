export class Listeners<T> {
  private readonly set = new Set<(value: T) => void>();

  add(listener: (value: T) => void): () => void {
    this.set.add(listener);
    return () => {
      this.set.delete(listener);
    };
  }

  emit(value: T): void {
    for (const listener of this.set) listener(value);
  }
}

/** Small seeded PRNG (mulberry32) so simulations and tests repeat exactly. */
export function seededRandom(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Initial compass bearing from one point to another, degrees clockwise from north. */
export function bearingDeg(lng1: number, lat1: number, lng2: number, lat2: number): number {
  const toRad = Math.PI / 180;
  const y = Math.sin((lng2 - lng1) * toRad) * Math.cos(lat2 * toRad);
  const x =
    Math.cos(lat1 * toRad) * Math.sin(lat2 * toRad) - Math.sin(lat1 * toRad) * Math.cos(lat2 * toRad) * Math.cos((lng2 - lng1) * toRad);
  return ((Math.atan2(y, x) * 180) / Math.PI + 360) % 360;
}
