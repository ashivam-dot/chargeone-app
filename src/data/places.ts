import type { Station } from './model.ts';
import { distanceMetres, safeUrl, type OsmElement } from './normalize.ts';

export type FoodKind = 'restaurant' | 'cafe' | 'fast_food' | 'food_court';
export type StayKind = 'hotel' | 'motel' | 'guest_house' | 'hostel' | 'resort';
export type PlaceCategory = 'food' | 'stay';

export interface Place {
  id: string;
  cat: PlaceCategory;
  kind: FoodKind | StayKind;
  name: string;
  lat: number;
  lng: number;
  cuisine?: string[];
  /** 'pure' = vegetarian only, 'options' = has vegetarian dishes. */
  veg?: 'pure' | 'options';
  hours?: string;
  phone?: string;
  website?: string;
  stars?: number;
  rooms?: number;
  /** A compatible public charger is within a short walk (stays only). */
  chargerOnSite?: boolean;
}

/** Index into `places` and walking distance in metres. */
export type NearRef = [index: number, metres: number];

export interface PlacesData {
  generatedAt: string;
  attribution: string;
  places: Place[];
  /** Per station id: food within FOOD_RADIUS_M and stays within STAY_RADIUS_M, nearest first. */
  near: Record<string, { f: NearRef[]; s: NearRef[] }>;
  /** Per station id: the city or town it belongs to. */
  area: Record<string, string>;
  cities: City[];
}

export interface City {
  name: string;
  slug: string;
  lat: number;
  lng: number;
}

export const FOOD_RADIUS_M = 800;
export const STAY_RADIUS_M = 3000;
export const ON_SITE_M = 150;
export const MAX_FOOD = 12;
export const MAX_STAYS = 10;
const CITY_RADIUS_KM = 60;

const FOOD_KINDS: ReadonlySet<string> = new Set(['restaurant', 'cafe', 'fast_food', 'food_court']);
const STAY_KINDS: ReadonlySet<string> = new Set(['hotel', 'motel', 'guest_house', 'hostel']);

export const KIND_LABEL: Record<FoodKind | StayKind, string> = {
  restaurant: 'Restaurant',
  cafe: 'Café',
  fast_food: 'Quick bites',
  food_court: 'Food court',
  hotel: 'Hotel',
  motel: 'Motel',
  guest_house: 'Guest house',
  hostel: 'Hostel',
  resort: 'Resort',
};

export function cleanText(raw: string | undefined | null, max: number): string | null {
  if (!raw) return null;
  const text = raw.replace(/[\u0000-\u001f\u007f<>]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
  return text || null;
}

export function slugify(name: string): string {
  return name
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
}

function cuisineList(raw: string | undefined): string[] | undefined {
  if (!raw) return undefined;
  const list = raw
    .split(/[;,]/)
    .map((c) => c.trim().replace(/_/g, ' '))
    .filter((c) => /^[a-z][a-z \-]{1,23}$/i.test(c))
    .map((c) => c.replace(/\b\w/g, (ch) => ch.toUpperCase()))
    .slice(0, 3);
  return list.length ? list : undefined;
}

/** Keeps one plausible phone number: digits, spaces, +, - and brackets, 8 to 15 digits. */
export function cleanPhone(raw: string | undefined): string | undefined {
  const first = raw?.split(/[;,/]/)[0]?.trim();
  if (!first || !/^[+0-9 ()-]+$/.test(first)) return undefined;
  const digits = first.replace(/\D/g, '').length;
  return digits >= 8 && digits <= 15 ? first : undefined;
}

export function telHref(phone: string): string {
  return `tel:${phone.replace(/[^+0-9]/g, '')}`;
}

function boundedNumber(raw: string | undefined, min: number, max: number): number | undefined {
  if (!raw) return undefined;
  const n = Number.parseFloat(raw);
  return Number.isFinite(n) && n >= min && n <= max ? n : undefined;
}

/**
 * In India "hotel" often means an eatery, and hostels are often student or worker housing.
 * Such places are tagged as stays in OSM but can't take a traveller for the night.
 */
export const NOT_A_STAY =
  /\b(mess|parotta|biriyani|biryani|tiffins?|meals|dhaba|canteen|restaurant|cafe|bakery|sweets?|juice|chai|tea|coffee|dining|kitchen|food|snacks?|chaat|vada ?pav|idli|dosa|pizza|burger|bhojanalaya|khanaval|pg|paying guest|boys|girls|ladies|gents|students?|working wom[ae]n|co-?living|nestaway|zolo|stanza living)\b/i;

export function osmToPlace(el: OsmElement): Place | null {
  const tags = el.tags ?? {};
  const lat = el.lat ?? el.center?.lat;
  const lng = el.lon ?? el.center?.lon;
  const name = cleanText(tags['name:en'] ?? tags.name, 80);
  if (lat === undefined || lng === undefined || !name) return null;

  let cat: PlaceCategory;
  let kind: FoodKind | StayKind;
  if (FOOD_KINDS.has(tags.amenity)) {
    cat = 'food';
    kind = tags.amenity as FoodKind;
  } else if (STAY_KINDS.has(tags.tourism)) {
    cat = 'stay';
    kind = tags.tourism as StayKind;
  } else if (tags.leisure === 'resort') {
    cat = 'stay';
    kind = 'resort';
  } else {
    return null;
  }
  if (cat === 'stay' && NOT_A_STAY.test(name)) return null;

  const place: Place = { id: `osm-${el.type[0]}${el.id}`, cat, kind, name, lat: round5(lat), lng: round5(lng) };
  if (cat === 'food') {
    const cuisine = cuisineList(tags.cuisine);
    if (cuisine) place.cuisine = cuisine;
    const diet = tags['diet:vegetarian'];
    if (diet === 'only' || cuisine?.includes('Vegetarian')) place.veg = 'pure';
    else if (diet === 'yes') place.veg = 'options';
  } else {
    const stars = boundedNumber(tags.stars, 1, 7);
    if (stars) place.stars = stars;
    const rooms = boundedNumber(tags.rooms, 1, 5000);
    if (rooms) place.rooms = Math.round(rooms);
  }
  const hours = cleanText(tags.opening_hours, 80);
  if (hours) place.hours = hours === '24/7' ? 'Open 24 hours' : hours;
  const phone = cleanPhone(tags.phone ?? tags['contact:phone']);
  if (phone) place.phone = phone;
  const website = safeUrl(tags.website ?? tags['contact:website']);
  if (website && website.length <= 200) place.website = website;
  return place;
}

function round5(n: number): number {
  return Math.round(n * 1e5) / 1e5;
}

/**
 * Turns OSM `place=city|town` nodes into a list with unique slugs: cities first (biggest first),
 * then towns. `cityCount` is how many entries at the front are cities.
 */
export function osmToCities(elements: OsmElement[]): { cities: City[]; cityCount: number } {
  const rows = elements
    .filter((el) => el.lat !== undefined && el.lon !== undefined && (el.tags?.place === 'city' || el.tags?.place === 'town'))
    .map((el) => {
      const name = cleanText(el.tags?.['name:en'] ?? el.tags?.name, 60);
      const population = Number.parseInt(el.tags?.population ?? '0', 10) || 0;
      return name ? { name, lat: round5(el.lat!), lng: round5(el.lon!), city: el.tags?.place === 'city', population } : null;
    })
    .filter((c): c is NonNullable<typeof c> => c !== null && /[a-z]/i.test(c.name))
    .sort((a, b) => Number(b.city) - Number(a.city) || b.population - a.population);
  const seen = new Set<string>();
  const out: City[] = [];
  let cityCount = 0;
  for (const r of rows) {
    const slug = slugify(r.name);
    if (!slug || seen.has(slug)) continue;
    seen.add(slug);
    out.push({ name: r.name, slug, lat: r.lat, lng: r.lng });
    if (r.city) cityCount++;
  }
  return { cities: out, cityCount };
}

/**
 * Assigns each station to a city: the nearest `place=city` within CITY_RADIUS_KM, otherwise the
 * nearest town. Cities come first in the list, so a big city wins over a suburb town.
 */
export function assignAreas(stations: Station[], cities: City[], cityCount: number): Record<string, string> {
  const area: Record<string, string> = {};
  for (const s of stations) {
    let best: { name: string; d: number } | null = null;
    for (let i = 0; i < cities.length; i++) {
      const c = cities[i];
      const d = distanceMetres(s, c) / 1000;
      if (d > CITY_RADIUS_KM) continue;
      // Prefer a real city within range over any closer town.
      const rank = (i < cityCount ? 0 : 1000) + d;
      if (!best || rank < best.d) best = { name: c.name, d: rank };
    }
    if (best) area[s.id] = best.name;
  }
  return area;
}

/** Links each station to nearby food and stays, and marks stays with a charger on site. */
export function linkPlaces(stations: Station[], places: Place[]): PlacesData['near'] {
  const near: PlacesData['near'] = {};
  const cellDeg = 0.05;
  const grid = new Map<string, number[]>();
  places.forEach((p, i) => {
    const key = `${Math.floor(p.lat / cellDeg)}:${Math.floor(p.lng / cellDeg)}`;
    (grid.get(key) ?? grid.set(key, []).get(key)!).push(i);
  });
  for (const s of stations) {
    const f: NearRef[] = [];
    const st: NearRef[] = [];
    const carCanCharge = !s.batterySwap && (s.vehicles.length === 0 || s.vehicles.includes('car'));
    const cy = Math.floor(s.lat / cellDeg);
    const cx = Math.floor(s.lng / cellDeg);
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        for (const i of grid.get(`${cy + dy}:${cx + dx}`) ?? []) {
          const p = places[i];
          const d = Math.round(distanceMetres(s, p));
          if (p.cat === 'food' && d <= FOOD_RADIUS_M) f.push([i, d]);
          if (p.cat === 'stay' && d <= STAY_RADIUS_M) {
            st.push([i, d]);
            if (d <= ON_SITE_M && carCanCharge) p.chargerOnSite = true;
          }
        }
      }
    }
    f.sort((a, b) => a[1] - b[1]);
    st.sort((a, b) => a[1] - b[1]);
    if (f.length || st.length) near[s.id] = { f: f.slice(0, MAX_FOOD), s: st.slice(0, MAX_STAYS) };
  }
  return near;
}

/** Drops places no station links to and renumbers the references. */
export function compact(places: Place[], near: PlacesData['near']): { places: Place[]; near: PlacesData['near'] } {
  const used = new Map<number, number>();
  const out: Place[] = [];
  const remap = (refs: NearRef[]): NearRef[] =>
    refs.map(([i, d]) => {
      if (!used.has(i)) {
        used.set(i, out.length);
        out.push(places[i]);
      }
      return [used.get(i)!, d];
    });
  const next: PlacesData['near'] = {};
  for (const [id, { f, s }] of Object.entries(near)) next[id] = { f: remap(f), s: remap(s) };
  return { places: out, near: next };
}

export function walkMinutes(metres: number): number {
  return Math.max(1, Math.round(metres / 75));
}

export function formatDistance(metres: number): string {
  return metres < 1000 ? `${Math.round(metres / 10) * 10} m` : `${(metres / 1000).toFixed(1)} km`;
}

const BOOKING_AID = /^\d{3,12}$/;

/** Booking.com search for a stay; adds the affiliate id when one is configured. */
export function bookingUrl(place: Pick<Place, 'name'>, area: string | null, affiliateId?: string | null): string {
  const params = new URLSearchParams({ ss: area ? `${place.name}, ${area}` : place.name });
  if (affiliateId && BOOKING_AID.test(affiliateId)) params.set('aid', affiliateId);
  return `https://www.booking.com/searchresults.html?${params}`;
}

/** Google search for reviews, photos and prices. */
export function reviewsUrl(place: Pick<Place, 'name'>, area: string | null): string {
  return `https://www.google.com/search?${new URLSearchParams({ q: area ? `${place.name} ${area}` : place.name })}`;
}
