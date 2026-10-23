// Builds public/data/places.json: food and stays near every charger, and the city each charger is in.
// Source: OpenStreetMap via the Overpass API (one query, run at build time, never by users).
// Usage: node scripts/import-places.ts [--from-cache]
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Dataset } from '../src/data/model.ts';
import type { OsmElement } from '../src/data/normalize.ts';
import { assignAreas, compact, linkPlaces, osmToCities, osmToPlace, type Place, type PlacesData } from '../src/data/places.ts';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
/** The same cache directory as the data pipeline (PIPELINE_CACHE_DIR, default data-cache/). */
const CACHE_FILE = join(process.env.PIPELINE_CACHE_DIR || join(ROOT, 'data-cache'), 'osm-places.json');
const STATIONS_FILE = join(ROOT, 'public', 'data', 'stations.json');
const OUT_FILE = join(ROOT, 'public', 'data', 'places.json');
const USER_AGENT = 'ChargeOne-data-import/0.1 (personal open-data project)';
const ENDPOINTS = ['https://overpass-api.de/api/interpreter', 'https://overpass.kumi.systems/api/interpreter'];

const QUERY = `[out:json][timeout:600];
area["ISO3166-1"="IN"][admin_level=2]->.in;
nwr["amenity"="charging_station"](area.in)->.ch;
(
  nwr(around.ch:800)["amenity"~"^(restaurant|cafe|fast_food|food_court)$"]["name"];
  nwr(around.ch:3000)["tourism"~"^(hotel|motel|guest_house|hostel)$"]["name"];
  nwr(around.ch:3000)["leisure"="resort"]["name"];
);
out tags center;
node["place"~"^(city|town)$"]["name"](area.in);
out body;`;

async function fetchOverpass(): Promise<OsmElement[]> {
  let lastError: unknown;
  for (const endpoint of ENDPOINTS) {
    try {
      console.log(`  querying ${endpoint}`);
      const res = await fetch(endpoint, {
        method: 'POST',
        headers: { 'User-Agent': USER_AGENT, 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ data: QUERY }),
        signal: AbortSignal.timeout(660_000),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = (await res.json()) as { elements?: OsmElement[] };
      if (!Array.isArray(json.elements)) throw new Error('response has no elements array');
      return json.elements;
    } catch (err) {
      lastError = err;
      console.warn(`  ${endpoint} failed: ${String(err)}`);
    }
  }
  throw new Error(`All Overpass endpoints failed: ${String(lastError)}`);
}

async function main(): Promise<void> {
  const dataset = JSON.parse(await readFile(STATIONS_FILE, 'utf8')) as Dataset;
  let elements: OsmElement[];
  if (process.argv.includes('--from-cache') && existsSync(CACHE_FILE)) {
    console.log('  using cached osm-places.json');
    elements = JSON.parse(await readFile(CACHE_FILE, 'utf8')) as OsmElement[];
  } else {
    elements = await fetchOverpass();
    await mkdir(dirname(CACHE_FILE), { recursive: true });
    await writeFile(CACHE_FILE, JSON.stringify(elements));
  }

  const { cities, cityCount } = osmToCities(elements);
  const area = assignAreas(dataset.stations, cities, cityCount);

  const seen = new Set<string>();
  const all: Place[] = [];
  for (const el of elements) {
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
  await writeFile(OUT_FILE, JSON.stringify(data));
  console.log(`Wrote ${OUT_FILE}`);
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
