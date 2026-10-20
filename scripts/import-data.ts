// Builds public/data/stations.json from OpenStreetMap (always) and Open Charge Map (when OCM_API_KEY is set).
// Usage: node scripts/import-data.ts [--from-cache]
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Dataset, DatasetSource, Station } from '../src/data/model.ts';
import {
  dedupeStations,
  ocmToStation,
  osmSocketType,
  osmToStation,
  type OcmPoi,
  type OsmElement,
} from '../src/data/normalize.ts';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const CACHE_DIR = join(ROOT, 'data-cache');
const OUT_FILE = join(ROOT, 'public', 'data', 'stations.json');
const USER_AGENT = 'ChargeOne-data-import/0.1 (personal open-data project)';

const OVERPASS_ENDPOINTS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
];

const OVERPASS_QUERY = `[out:json][timeout:180];
area["ISO3166-1"="IN"][admin_level=2]->.in;
nwr["amenity"="charging_station"](area.in);
out tags center meta;`;

const fromCache = process.argv.includes('--from-cache');

async function cached<T>(name: string, fetcher: () => Promise<T>): Promise<T> {
  const file = join(CACHE_DIR, name);
  if (fromCache && existsSync(file)) {
    console.log(`  using cached ${name}`);
    return JSON.parse(await readFile(file, 'utf8')) as T;
  }
  const data = await fetcher();
  await mkdir(CACHE_DIR, { recursive: true });
  await writeFile(file, JSON.stringify(data));
  return data;
}

async function fetchOsm(): Promise<OsmElement[]> {
  let lastError: unknown;
  for (const endpoint of OVERPASS_ENDPOINTS) {
    try {
      console.log(`  querying ${endpoint}`);
      const res = await fetch(endpoint, {
        method: 'POST',
        headers: { 'User-Agent': USER_AGENT, 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ data: OVERPASS_QUERY }),
        signal: AbortSignal.timeout(240_000),
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

async function fetchOcm(apiKey: string): Promise<OcmPoi[]> {
  const url = new URL('https://api.openchargemap.io/v3/poi');
  url.search = new URLSearchParams({
    output: 'json',
    countrycode: 'IN',
    maxresults: '100000',
    compact: 'false',
    verbose: 'false',
  }).toString();
  const res = await fetch(url, {
    headers: { 'User-Agent': USER_AGENT, 'X-API-Key': apiKey },
    signal: AbortSignal.timeout(240_000),
  });
  if (!res.ok) throw new Error(`Open Charge Map HTTP ${res.status}`);
  const json = (await res.json()) as unknown;
  if (!Array.isArray(json)) throw new Error('Open Charge Map response is not an array');
  return json as OcmPoi[];
}

function report(label: string, stations: Station[]): void {
  const dc = stations.filter((s) => s.speed === 'dc').length;
  const withConnectors = stations.filter((s) => s.connectors.length > 0).length;
  const withOperator = stations.filter((s) => s.operator).length;
  console.log(
    `  ${label}: ${stations.length} stations · ${dc} DC fast · ${withConnectors} with connector data · ${withOperator} with operator`,
  );
}

async function main(): Promise<void> {
  const sources: DatasetSource[] = [];
  const all: Station[] = [];

  console.log('OpenStreetMap');
  const osm = await cached('osm.json', fetchOsm);
  const unknownSockets = new Set<string>();
  for (const el of osm) {
    for (const key of Object.keys(el.tags ?? {})) {
      const m = key.match(/^socket:([a-z0-9_]+)(?::output)?$/i);
      if (m && m[1].toLowerCase() !== 'type' && osmSocketType(m[1]) === 'Other') unknownSockets.add(m[1]);
    }
  }
  const osmStations = osm.map(osmToStation).filter((s): s is Station => s !== null);
  report(`${osm.length} OSM objects ->`, osmStations);
  if (unknownSockets.size) console.log(`  socket keys shown as "Other": ${[...unknownSockets].sort().join(', ')}`);
  all.push(...osmStations);
  sources.push({
    name: 'OpenStreetMap',
    licence: 'ODbL 1.0',
    attribution: '© OpenStreetMap contributors',
    url: 'https://www.openstreetmap.org/copyright',
    count: osmStations.length,
  });

  const ocmKey = process.env.OCM_API_KEY?.trim();
  if (ocmKey) {
    console.log('Open Charge Map');
    const ocm = await cached('ocm.json', () => fetchOcm(ocmKey));
    const ocmStations = ocm.map(ocmToStation).filter((s): s is Station => s !== null);
    report(`${ocm.length} OCM records ->`, ocmStations);
    all.push(...ocmStations);
    sources.push({
      name: 'Open Charge Map',
      licence: 'CC BY 4.0 (user contributions); third-party data under its provider licence',
      attribution: 'Open Charge Map contributors',
      url: 'https://openchargemap.org/site/about/terms',
      count: ocmStations.length,
    });
  } else {
    console.log('Open Charge Map skipped (set OCM_API_KEY to include it)');
  }

  const stations = dedupeStations(all);
  report('After merging duplicates', stations);

  const dataset: Dataset = { generatedAt: new Date().toISOString(), sources, stations };
  await mkdir(dirname(OUT_FILE), { recursive: true });
  await writeFile(OUT_FILE, JSON.stringify(dataset));
  console.log(`Wrote ${OUT_FILE}`);
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
