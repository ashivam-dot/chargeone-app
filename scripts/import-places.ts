// Builds public/data/places.json: food and stays near every car charger we publish, and the city each charger is in.
// Source: OpenStreetMap via the Overpass API (run at build time, never by users).
// Places are fetched around the merged station list (OSM and Open Charge Map alike). Chargers are
// grouped by geohash cell (about 5 x 5 km); each cell becomes one small box, widened by the search
// radius, and a query asks for a batch of boxes. Box-and-tag lookups are what Overpass does fastest;
// linkPlaces then keeps only places within walking or driving distance. Every answer is cached in
// data-cache/, so a re-run only asks about chargers it hasn't seen before.
// Usage: node scripts/import-places.ts [--from-cache]   (--from-cache: no network, use what is cached)
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Dataset, Station } from '../src/data/model.ts';
import type { OsmElement } from '../src/data/normalize.ts';
import { assignAreas, compact, FOOD_RADIUS_M, linkPlaces, osmToCities, osmToPlace, STAY_RADIUS_M, type Place, type PlacesData } from '../src/data/places.ts';
import { geohash } from '../pipeline/lib/geo.ts';
import { geohashBounds, type Bounds } from '../src/shared/geohash.ts';
import { overpass, OVERPASS_PAUSE_MS, sleep } from './overpass.ts';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
/** The first import (2026-10-20): places around OSM charging stations, plus every city and town node. */
const LEGACY_CACHE = join(ROOT, 'data-cache', 'osm-places.json');
/** Places around each charger point, filled a batch of cells at a time. */
const AROUND_CACHE = join(ROOT, 'data-cache', 'osm-places-around.json');
const STATIONS_FILE = join(ROOT, 'public', 'data', 'stations.json');
const OUT_FILE = join(ROOT, 'public', 'data', 'places.json');
/** Geohash precision for grouping chargers: 5 is about 4.9 x 4.9 km. */
const CELL_PRECISION = 5;
/** Cells per Overpass query; neighbouring cells share a batch. */
const BATCH = 12;

const CITIES_QUERY = `[out:json][timeout:300];
area["ISO3166-1"="IN"][admin_level=2]->.in;
node["place"~"^(city|town)$"]["name"](area.in);
out body;`;

/** A box grown by `metres` on every side, as Overpass "south,west,north,east". */
function grown(b: Bounds, metres: number): string {
  const dLat = metres / 111_320;
  const dLng = metres / (111_320 * Math.cos((((b.south + b.north) / 2) * Math.PI) / 180));
  const f = (n: number) => n.toFixed(5);
  return `${f(b.south - dLat)},${f(b.west - dLng)},${f(b.north + dLat)},${f(b.east + dLng)}`;
}

export function cellQuery(cells: string[]): string {
  const lines = cells.flatMap((cell) => {
    const box = geohashBounds(cell);
    const food = grown(box, FOOD_RADIUS_M);
    const stay = grown(box, STAY_RADIUS_M);
    return [
      `  nwr["amenity"~"^(restaurant|cafe|fast_food|food_court)$"]["name"](${food});`,
      `  nwr["tourism"~"^(hotel|motel|guest_house|hostel)$"]["name"](${stay});`,
      `  nwr["leisure"="resort"]["name"](${stay});`,
    ];
  });
  return `[out:json][timeout:180];\n(\n${lines.join('\n')}\n);\nout tags center;`;
}

interface AroundCache {
  /** Points already asked about, as "lat,lng" to 4 decimals (about 11 m). */
  points: string[];
  elements: OsmElement[];
}

const pointKey = (s: { lat: number; lng: number }) => `${s.lat.toFixed(4)},${s.lng.toFixed(4)}`;
const carCanCharge = (s: Station) => !s.batterySwap && (s.vehicles.length === 0 || s.vehicles.includes('car'));

/** Share of car chargers with a stay within 2 km and food within 500 m, the trip planner's bar. */
function coverage(stations: Station[], near: PlacesData['near']): string {
  const cars = stations.filter(carCanCharge);
  const stay = cars.filter((s) => near[s.id]?.s.some(([, d]) => d <= 2000)).length;
  const food = cars.filter((s) => near[s.id]?.f.some(([, d]) => d <= 500)).length;
  const pct = (n: number) => `${((100 * n) / cars.length).toFixed(1)}%`;
  return `${cars.length} car chargers: ${stay} (${pct(stay)}) with a stay within 2 km, ${food} (${pct(food)}) with food within 500 m`;
}

async function main(): Promise<void> {
  const offline = process.argv.includes('--from-cache');
  const dataset = JSON.parse(await readFile(STATIONS_FILE, 'utf8')) as Dataset;

  // The legacy file already holds everything around OSM charging stations, so those points count as asked.
  const legacy: OsmElement[] = existsSync(LEGACY_CACHE) ? JSON.parse(await readFile(LEGACY_CACHE, 'utf8')) : [];
  const around: AroundCache = existsSync(AROUND_CACHE) ? JSON.parse(await readFile(AROUND_CACHE, 'utf8')) : { points: [], elements: [] };
  const asked = new Set(around.points);
  if (legacy.length) for (const s of dataset.stations) if (s.id.startsWith('osm-')) asked.add(pointKey(s));

  // Charger points not asked about yet, grouped by cell. A fetched cell covers every point in it.
  const todo = new Map<string, Set<string>>();
  for (const s of dataset.stations.filter(carCanCharge)) {
    const key = pointKey(s);
    if (asked.has(key)) continue;
    const cell = geohash(s.lat, s.lng, CELL_PRECISION);
    (todo.get(cell) ?? todo.set(cell, new Set()).get(cell)!).add(key);
  }
  // Sorted cells keep each batch in one region.
  const pending = [...todo.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  const pointCount = pending.reduce((n, [, keys]) => n + keys.size, 0);
  console.log(
    `  ${dataset.stations.length} stations · ${pointCount} charger points in ${pending.length} cells not asked about yet${offline ? ' (offline, skipped)' : ''}`,
  );

  if (!offline) {
    const seenIds = new Set(around.elements.map((e) => `${e.type}${e.id}`));
    for (let i = 0; i < pending.length; i += BATCH) {
      const batch = pending.slice(i, i + BATCH);
      if (i) await sleep(OVERPASS_PAUSE_MS);
      const elements = await overpass(cellQuery(batch.map(([cell]) => cell)), 180);
      for (const el of elements) {
        const id = `${el.type}${el.id}`;
        if (!seenIds.has(id)) {
          seenIds.add(id);
          around.elements.push(el);
        }
      }
      around.points.push(...batch.flatMap(([, keys]) => [...keys]));
      // Saved after every batch, so an interrupted run resumes where it stopped.
      await mkdir(dirname(AROUND_CACHE), { recursive: true });
      await writeFile(AROUND_CACHE, JSON.stringify(around));
      console.log(`  batch ${i / BATCH + 1}/${Math.ceil(pending.length / BATCH)}: ${elements.length} places (${around.elements.length} cached)`);
    }
  }

  // City and town nodes: from the legacy file when it has them, otherwise one query.
  let cityElements = legacy.filter((el) => el.tags?.place === 'city' || el.tags?.place === 'town');
  if (!cityElements.length && !offline) {
    cityElements = await overpass(CITIES_QUERY, 300);
    await writeFile(LEGACY_CACHE, JSON.stringify(cityElements));
  }
  const { cities, cityCount } = osmToCities(cityElements);
  const area = assignAreas(dataset.stations, cities, cityCount);

  const seen = new Set<string>();
  const all: Place[] = [];
  for (const el of [...legacy, ...around.elements]) {
    const p = osmToPlace(el);
    if (p && !seen.has(p.id)) {
      seen.add(p.id);
      all.push(p);
    }
  }
  const { places, near } = compact(all, linkPlaces(dataset.stations, all));

  const usedCities = new Set(Object.values(area));
  const data: PlacesData = {
    generatedAt: new Date().toISOString(),
    attribution: '© OpenStreetMap contributors (ODbL)',
    places,
    near,
    area,
    cities: cities.filter((c) => usedCities.has(c.name)),
  };
  const food = places.filter((p) => p.cat === 'food').length;
  const stays = places.filter((p) => p.cat === 'stay');
  const withNear = Object.keys(near).length;
  console.log(
    `  ${food} places to eat · ${stays.length} stays (${stays.filter((s) => s.chargerOnSite).length} with a charger on site) · ` +
      `${withNear} of ${dataset.stations.length} chargers have something nearby · ${data.cities.length} cities`,
  );
  if (existsSync(OUT_FILE)) {
    const before = JSON.parse(await readFile(OUT_FILE, 'utf8')) as PlacesData;
    console.log(`  before: ${coverage(dataset.stations, before.near)}`);
  }
  console.log(`  after:  ${coverage(dataset.stations, near)}`);
  await writeFile(OUT_FILE, JSON.stringify(data));
  console.log(`Wrote ${OUT_FILE}`);
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
