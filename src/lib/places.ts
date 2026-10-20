import type { PlacesData } from '../data/places.ts';

let pending: Promise<PlacesData | null> | null = null;

/** Loads food and stays near chargers once; the service worker keeps a copy for offline use. */
export function loadPlaces(): Promise<PlacesData | null> {
  pending ??= fetch('/data/places.json')
    .then((r) => (r.ok ? (r.json() as Promise<PlacesData>) : null))
    .then((d) => (d && Array.isArray(d.places) && d.near ? d : null))
    .catch(() => {
      pending = null;
      return null;
    });
  return pending;
}

/** Optional Booking.com affiliate id, set at build time with VITE_BOOKING_AID. */
export const BOOKING_AFFILIATE_ID: string | null = import.meta.env.VITE_BOOKING_AID || null;

/** Chargers that list this place as nearby, nearest first. */
export function stationsNearPlace(data: PlacesData, placeIndex: number): Array<[stationId: string, metres: number]> {
  const out: Array<[string, number]> = [];
  for (const [id, { f, s }] of Object.entries(data.near)) {
    const hit = f.find(([i]) => i === placeIndex) ?? s.find(([i]) => i === placeIndex);
    if (hit) out.push([id, hit[1]]);
  }
  return out.sort((a, b) => a[1] - b[1]);
}
