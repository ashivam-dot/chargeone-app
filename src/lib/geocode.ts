export interface Place {
  name: string;
  detail: string;
  lat: number;
  lng: number;
  bbox: [number, number, number, number] | null;
}

export const INDIA_BBOX: [number, number, number, number] = [68.1, 6.5, 97.4, 35.7];

interface PhotonFeature {
  geometry: { coordinates: [number, number] };
  properties: {
    name?: string;
    street?: string;
    city?: string;
    district?: string;
    county?: string;
    state?: string;
    countrycode?: string;
    extent?: [number, number, number, number];
  };
}

/** Photon (komoot) public geocoder: free, fair use, no key. Callers must debounce. */
export async function searchPlaces(query: string, signal: AbortSignal): Promise<Place[]> {
  const params = new URLSearchParams({
    q: query,
    limit: '6',
    lang: 'en',
    bbox: INDIA_BBOX.join(','),
  });
  const res = await fetch(`https://photon.komoot.io/api/?${params}`, { signal });
  if (!res.ok) throw new Error(`Place search failed (${res.status})`);
  const json = (await res.json()) as { features?: PhotonFeature[] };
  const seen = new Set<string>();
  const places: Place[] = [];
  for (const f of json.features ?? []) {
    const p = f.properties;
    if (p.countrycode && p.countrycode !== 'IN') continue;
    const name = p.name ?? p.street ?? p.city;
    if (!name) continue;
    const detail = [p.city !== name ? p.city : undefined, p.district ?? p.county, p.state]
      .filter((x, i, arr): x is string => Boolean(x) && arr.indexOf(x) === i)
      .join(', ');
    const key = `${name}|${detail}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const [lng, lat] = f.geometry.coordinates;
    places.push({ name, detail, lat, lng, bbox: p.extent ?? null });
  }
  return places;
}
