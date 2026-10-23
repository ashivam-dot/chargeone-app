// Roadside places along India's national highways and expressways: stays, food, fuel, toilets and
// rest areas, with or without a charger nearby. Built by scripts/import-corridor.ts from
// OpenStreetMap (ODbL) and published as public/data/corridor/<geohash-3 cell>.json, about 156 km
// square each, so a trip loads only the cells its route crosses, and only when planning.
import { boundsAround, cellsCovering } from '../shared/geohash.ts';
import type { Coord, RouteIndex } from '../planner/geometry.ts';
import { distanceMetres, type OsmElement } from './normalize.ts';
import { cleanText, NOT_A_STAY } from './places.ts';

export const CORRIDOR_SCHEMA = 1;
/** Geohash precision of a corridor cell (about 156 x 156 km at India's latitudes). */
export const CORRIDOR_CELL_PRECISION = 3;
/** Roadside services are kept within this distance of a national highway or expressway. */
export const ROADSIDE_M = 500;
/** Stays are kept a little further out: hotels often sit back from the road. */
export const CORRIDOR_STAY_M = 1500;

/** Index into this list is the kind code in a row. Never reorder; append only. */
export const CORRIDOR_KINDS = ['hotel', 'motel', 'guest_house', 'restaurant', 'fast_food', 'cafe', 'fuel', 'toilets', 'rest_area', 'services'] as const;
export type CorridorKind = (typeof CORRIDOR_KINDS)[number];
export type CorridorCategory = 'stay' | 'food' | 'fuel' | 'toilets' | 'rest';

export const CORRIDOR_CATEGORY: Record<CorridorKind, CorridorCategory> = {
  hotel: 'stay',
  motel: 'stay',
  guest_house: 'stay',
  restaurant: 'food',
  fast_food: 'food',
  cafe: 'food',
  fuel: 'fuel',
  toilets: 'toilets',
  rest_area: 'rest',
  services: 'rest',
};

export const CORRIDOR_LABEL: Record<CorridorKind, string> = {
  hotel: 'Hotel',
  motel: 'Motel',
  guest_house: 'Guest house',
  restaurant: 'Restaurant',
  fast_food: 'Quick bites',
  cafe: 'Café',
  fuel: 'Fuel station',
  toilets: 'Toilets',
  rest_area: 'Rest area',
  services: 'Highway services',
};

/** Row flags, OR-ed together. */
export const FLAG_OPEN_24H = 1;
export const FLAG_TOILETS = 2;
export const FLAG_PURE_VEG = 4;

/**
 * One place: [OSM ref ("n123", "w45", "r6"), kind code, lat, lng, name ('' when OSM has none), flags].
 * The OSM ref keeps every row traceable to its source object, as the ODbL asks.
 */
export type CorridorRow = [ref: string, kind: number, lat: number, lng: number, name: string, flags: number];

export interface CorridorCellFile {
  schema: number;
  cell: string;
  rows: CorridorRow[];
}

export interface CorridorIndex {
  schema: number;
  generatedAt: string;
  attribution: string;
  licence: string;
  /** Places per published cell. */
  cells: Record<string, number>;
  /** Places per kind, across India. */
  counts: Partial<Record<CorridorKind, number>>;
}

export interface CorridorPlace {
  /** Same id scheme as places.json: "osm-n123". */
  id: string;
  kind: CorridorKind;
  cat: CorridorCategory;
  /** OSM name, or a plain label ("Toilets") when the place has none. */
  name: string;
  named: boolean;
  lat: number;
  lng: number;
  open24h: boolean;
  toilets: boolean;
  pureVeg: boolean;
}

/** One OSM object as a corridor row, or null when it isn't a place a traveller can use. */
export function osmToCorridorRow(el: OsmElement): CorridorRow | null {
  const tags = el.tags ?? {};
  const lat = el.lat ?? el.center?.lat;
  const lng = el.lon ?? el.center?.lon;
  if (lat === undefined || lng === undefined) return null;
  let kind: CorridorKind | null = null;
  if (['restaurant', 'fast_food', 'cafe', 'fuel', 'toilets'].includes(tags.amenity)) kind = tags.amenity as CorridorKind;
  else if (tags.highway === 'rest_area' || tags.highway === 'services') kind = tags.highway;
  else if (['hotel', 'motel', 'guest_house'].includes(tags.tourism)) kind = tags.tourism as CorridorKind;
  if (!kind) return null;
  if (/^(private|no|customers)$/.test(tags.access ?? '') && kind !== 'fuel') return null;
  if (tags.disused === 'yes' || tags['disused:amenity']) return null;
  const name = cleanText(tags['name:en'] ?? tags.name ?? (kind === 'fuel' ? tags.brand : undefined), 80) ?? '';
  const food = kind === 'restaurant' || kind === 'fast_food' || kind === 'cafe';
  const stay = kind === 'hotel' || kind === 'motel' || kind === 'guest_house';
  // A meal or a night needs a name to be found; fuel, toilets and rest areas are useful without one.
  if ((food || stay) && !name) return null;
  if (stay && NOT_A_STAY.test(name)) return null;
  let flags = 0;
  if (/^24\/7$/.test(tags.opening_hours ?? '')) flags |= FLAG_OPEN_24H;
  if (tags.toilets === 'yes' && kind !== 'toilets') flags |= FLAG_TOILETS;
  if (food && tags['diet:vegetarian'] === 'only') flags |= FLAG_PURE_VEG;
  const round = (n: number) => Math.round(n * 1e5) / 1e5;
  return [`${el.type[0]}${el.id}`, CORRIDOR_KINDS.indexOf(kind), round(lat), round(lng), name, flags];
}

export function decodeRow([ref, code, lat, lng, name, flags]: CorridorRow): CorridorPlace | null {
  const kind = CORRIDOR_KINDS[code];
  if (!kind || !/^[nwr]\d+$/.test(ref)) return null;
  return {
    id: `osm-${ref}`,
    kind,
    cat: CORRIDOR_CATEGORY[kind],
    name: name || CORRIDOR_LABEL[kind],
    named: Boolean(name),
    lat,
    lng,
    open24h: Boolean(flags & FLAG_OPEN_24H),
    toilets: kind === 'toilets' || Boolean(flags & FLAG_TOILETS),
    pureVeg: Boolean(flags & FLAG_PURE_VEG),
  };
}

export function decodeCell(file: CorridorCellFile): CorridorPlace[] {
  if (file.schema !== CORRIDOR_SCHEMA || !Array.isArray(file.rows)) return [];
  return file.rows.map(decodeRow).filter((p): p is CorridorPlace => p !== null);
}

/** The published cells within `bufferKm` of a route. Sampled every 10 km, so each sample also covers 5 km either side. */
export function cellsAlongRoute(coords: Coord[], published: Iterable<string>, bufferKm = 5): string[] {
  const cells = [...published];
  const out = new Set<string>();
  let last: Coord | null = null;
  coords.forEach((c, i) => {
    const far = !last || distanceMetres({ lat: c[1], lng: c[0] }, { lat: last[1], lng: last[0] }) >= 10_000;
    if (!far && i !== coords.length - 1) return;
    last = c;
    for (const cell of cellsCovering(cells, boundsAround({ lat: c[1], lng: c[0] }, bufferKm + 5))) out.add(cell);
  });
  return [...out].sort();
}

export interface PlaceOnRoute {
  place: CorridorPlace;
  /** Km from the start of the route. */
  alongKm: number;
  /** Straight-line km from the road. */
  offKm: number;
}

/** Places within `maxOffKm` of the route, in driving order. */
export function placesAlongRoute(route: RouteIndex, places: Iterable<CorridorPlace>, maxOffKm = 1.5): PlaceOnRoute[] {
  const out: PlaceOnRoute[] = [];
  for (const place of places) {
    const p = route.project(place.lng, place.lat, maxOffKm);
    if (p) out.push({ place, alongKm: p.alongKm, offKm: p.offKm });
  }
  return out.sort((a, b) => a.alongKm - b.alongKm);
}
