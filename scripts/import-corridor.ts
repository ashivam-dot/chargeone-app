// Builds public/data/corridor/: stays, food, fuel, toilets and rest areas along India's national
// highways and expressways, whether or not a charger is nearby, so a trip can plan rests, meals and
// nights anywhere on the road.
// Source: OpenStreetMap (ODbL), run at build time, never by users. Two ways in:
//   --from-pbf <file>: a local extract (Geofabrik's india-latest.osm.pbf), read with osmium; all of
//     India in a few minutes. This is how the published files are built.
//   otherwise, the Overpass API: one query per geohash-3 cell (about 156 km square); a cell that is
//     too big for one query is split into four, down to two levels. Every answer is cached in
//     data-cache/corridor/, so a re-run only asks about boxes it hasn't fetched yet. Slow; use it
//     with --only for a quick look at a few cells.
// Usage: node scripts/import-corridor.ts [--from-pbf /tmp/osm/india.osm.pbf] [--from-cache] [--only=tep,tdr]
//   --from-cache: no network, use what is cached; --only: just these cells
import { existsSync } from 'node:fs';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';
import {
  CORRIDOR_CELL_PRECISION,
  CORRIDOR_KINDS,
  CORRIDOR_SCHEMA,
  CORRIDOR_STAY_M,
  osmToCorridorRow,
  ROADSIDE_M,
  type CorridorCellFile,
  type CorridorIndex,
  type CorridorKind,
  type CorridorRow,
} from '../src/data/corridor.ts';
import type { OsmElement } from '../src/data/normalize.ts';
import { geohashBounds, type Bounds } from '../src/shared/geohash.ts';
import { geohash, stateAt, stateShapes, type StateShape } from '../pipeline/lib/geo.ts';
import { flagValue, readPbf, type SegmentIndex } from './osm-pbf.ts';
import { overpass, OVERPASS_PAUSE_MS, QueryTooBig, sleep } from './overpass.ts';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const CACHE_DIR = join(ROOT, 'data-cache', 'corridor');
const BOUNDARIES = join(ROOT, 'data-cache', 'boundaries', 'IND-ADM1_simplified.geojson');
const OUT_DIR = join(ROOT, 'public', 'data', 'corridor');
/** Highways are looked for this far outside a box, so roadside places at its edge aren't missed. */
const ROAD_MARGIN_M = 2000;
/** Splits allowed below a geohash-3 cell (1 = quarters, 2 = sixteenths). */
const MAX_SPLIT = 2;
/**
 * Size cap: a cell file may not pass this many gzipped KB, so a long trip (10-15 cells) stays
 * around a megabyte or two. Over it the build fails, rather than trimming places silently.
 */
export const CELL_BUDGET_KB = 120;
/** And all cells together. */
export const TOTAL_BUDGET_KB = 6000;

const f5 = (n: number) => n.toFixed(5);
const box = (b: Bounds) => `${f5(b.south)},${f5(b.west)},${f5(b.north)},${f5(b.east)}`;

function grow(b: Bounds, metres: number): Bounds {
  const dLat = metres / 111_320;
  const dLng = metres / (111_320 * Math.cos((((b.south + b.north) / 2) * Math.PI) / 180));
  return { south: b.south - dLat, west: b.west - dLng, north: b.north + dLat, east: b.east + dLng };
}

function quarters(b: Bounds): Bounds[] {
  const midLat = (b.south + b.north) / 2;
  const midLng = (b.west + b.east) / 2;
  return [
    { south: b.south, west: b.west, north: midLat, east: midLng },
    { south: b.south, west: midLng, north: midLat, east: b.east },
    { south: midLat, west: b.west, north: b.north, east: midLng },
    { south: midLat, west: midLng, north: b.north, east: b.east },
  ];
}

/**
 * National highways and expressways: every motorway and trunk road (in India trunk is the NH
 * network) and their slip roads, plus primary and secondary roads that carry an NH or NE ref.
 * The same rule as isCorridorRoad in osm-pbf.ts.
 */
export function corridorQuery(b: Bounds): string {
  const roads = box(grow(b, ROAD_MARGIN_M));
  const inside = box(b);
  return `[out:json][timeout:180];
(
  way["highway"~"^(motorway|motorway_link|trunk|trunk_link)$"](${roads});
  way["highway"~"^(primary|secondary)$"]["ref"~"(^|;) *(NH|NE) *-? *[0-9]"](${roads});
)->.roads;
(
  nwr(around.roads:${ROADSIDE_M})["amenity"~"^(restaurant|fast_food|cafe|fuel|toilets)$"](${inside});
  nwr(around.roads:${ROADSIDE_M})["highway"~"^(rest_area|services)$"](${inside});
  nwr(around.roads:${CORRIDOR_STAY_M})["tourism"~"^(hotel|motel|guest_house)$"](${inside});
);
out tags center;`;
}

/** Inside India, allowing for a simplified coastline: the point or one about 3 km away is in a state. */
function inIndia(shapes: StateShape[], lat: number, lng: number): boolean {
  const d = 0.03;
  return [[0, 0], [d, 0], [-d, 0], [0, d], [0, -d]].some(([dy, dx]) => stateAt(shapes, lat + dy, lng + dx) !== null);
}

/** The geohash-3 cells with any part of India in them, from a 6 x 6 sample grid per cell. */
function indianCells(shapes: StateShape[]): string[] {
  const out = new Set<string>();
  for (let lat = 6; lat <= 37.6; lat += 0.7) {
    for (let lng = 68; lng <= 97.5; lng += 0.7) {
      const cell = geohash(lat, lng, CORRIDOR_CELL_PRECISION);
      if (out.has(cell)) continue;
      const b = geohashBounds(cell);
      const grid = [0.05, 0.25, 0.45, 0.55, 0.75, 0.95];
      if (grid.some((y) => grid.some((x) => stateAt(shapes, b.south + y * (b.north - b.south), b.west + x * (b.east - b.west)) !== null))) out.add(cell);
    }
  }
  return [...out].sort();
}

async function fetchBox(key: string, b: Bounds, depth: number, offline: boolean, state: { queries: number }): Promise<OsmElement[] | null> {
  const file = join(CACHE_DIR, `${key}.json`);
  if (existsSync(file)) return JSON.parse(await readFile(file, 'utf8')) as OsmElement[];
  // A split box is cached as its parts.
  const parts = quarters(b).map((q, i) => ({ key: `${key}-${i}`, q }));
  if (parts.some((p) => existsSync(join(CACHE_DIR, `${p.key}.json`))) || (offline && depth < MAX_SPLIT)) {
    const lists = await Promise.all(parts.map((p) => fetchBox(p.key, p.q, depth + 1, offline, state)));
    return lists.some((l) => l) ? lists.flatMap((l) => l ?? []) : null;
  }
  if (offline) return null;
  if (state.queries++) await sleep(OVERPASS_PAUSE_MS);
  try {
    const elements = await overpass(corridorQuery(b), 180);
    await writeFile(file, JSON.stringify(elements));
    console.log(`  ${key}: ${elements.length} places`);
    return elements;
  } catch (err) {
    if (!(err instanceof QueryTooBig) || depth >= MAX_SPLIT) throw err;
    console.warn(`  ${key} is too big for one query, splitting it in four`);
    const out: OsmElement[] = [];
    for (const p of parts) out.push(...((await fetchBox(p.key, p.q, depth + 1, offline, state)) ?? []));
    return out;
  }
}

/** How far from a highway a place of this kind may be: stays sit further back than a pump or a dhaba. */
export function roadsideLimitM(row: CorridorRow): number {
  const kind = CORRIDOR_KINDS[row[1]];
  return kind === 'hotel' || kind === 'motel' || kind === 'guest_house' ? CORRIDOR_STAY_M : ROADSIDE_M;
}

/**
 * The places a traveller can use within reach of a national highway, grouped by the cell their point
 * is in. `onRoad` is null when the source already applied the distance rule (Overpass `around`).
 */
export function roadsideByCell(
  elements: Iterable<OsmElement>,
  onRoad: SegmentIndex | null,
  keep: (row: CorridorRow, cell: string) => boolean,
): Map<string, CorridorRow[]> {
  const byCell = new Map<string, CorridorRow[]>();
  const seen = new Set<string>();
  for (const el of elements) {
    const row = osmToCorridorRow(el);
    if (!row || seen.has(row[0])) continue;
    if (onRoad && onRoad.nearestM(row[2], row[3], roadsideLimitM(row)) === null) continue;
    const cell = geohash(row[2], row[3], CORRIDOR_CELL_PRECISION);
    if (!keep(row, cell)) continue;
    seen.add(row[0]);
    (byCell.get(cell) ?? byCell.set(cell, []).get(cell)!).push(row);
  }
  for (const rows of byCell.values()) rows.sort((a, b) => a[2] - b[2] || a[3] - b[3]);
  return byCell;
}

async function fromOverpass(cells: string[], offline: boolean, shapes: StateShape[]): Promise<Map<string, CorridorRow[]>> {
  await mkdir(CACHE_DIR, { recursive: true });
  const state = { queries: 0 };
  const byCell = new Map<string, CorridorRow[]>();
  let missing = 0;
  for (const cell of cells) {
    const elements = await fetchBox(cell, geohashBounds(cell), 0, offline, state);
    if (!elements) {
      missing++;
      continue;
    }
    // A place belongs to the cell its point is in; split boxes can return it twice.
    const rows = roadsideByCell(elements, null, (r, c) => c === cell && inIndia(shapes, r[2], r[3])).get(cell);
    if (rows) byCell.set(cell, rows);
  }
  if (missing) console.warn(`  ${missing} cells not fetched yet${offline ? ' (offline)' : ''}`);
  return byCell;
}

async function fromPbf(pbf: string, cells: string[], shapes: StateShape[]): Promise<Map<string, CorridorRow[]>> {
  const { places, roads } = await readPbf(pbf, true);
  console.log(`  ${places.length} places and ${roads!.segments} highway segments in ${pbf}`);
  const wanted = new Set(cells);
  return roadsideByCell(places, roads, (r, c) => wanted.has(c) && inIndia(shapes, r[2], r[3]));
}

async function writeCells(byCell: Map<string, CorridorRow[]>): Promise<void> {
  await rm(OUT_DIR, { recursive: true, force: true });
  await mkdir(OUT_DIR, { recursive: true });
  const counts: Partial<Record<CorridorKind, number>> = {};
  const index: CorridorIndex = {
    schema: CORRIDOR_SCHEMA,
    generatedAt: new Date().toISOString(),
    attribution: '© OpenStreetMap contributors (ODbL)',
    licence: 'ODbL-1.0',
    cells: {},
    counts,
  };
  let totalKb = 0;
  let biggest = { cell: '', kb: 0 };
  const over: string[] = [];
  for (const [cell, rows] of [...byCell].sort((a, b) => a[0].localeCompare(b[0]))) {
    const file: CorridorCellFile = { schema: CORRIDOR_SCHEMA, cell, rows };
    const json = JSON.stringify(file);
    const kb = gzipSync(json).length / 1024;
    totalKb += kb;
    if (kb > biggest.kb) biggest = { cell, kb };
    if (kb > CELL_BUDGET_KB) over.push(`${cell} (${kb.toFixed(0)} KB)`);
    await writeFile(join(OUT_DIR, `${cell}.json`), json);
    index.cells[cell] = rows.length;
    for (const r of rows) counts[CORRIDOR_KINDS[r[1]]] = (counts[CORRIDOR_KINDS[r[1]]] ?? 0) + 1;
  }
  await writeFile(join(OUT_DIR, 'index.json'), JSON.stringify(index));
  const total = Object.values(index.cells).reduce((a, b) => a + b, 0);
  console.log(`  ${total} places in ${byCell.size} cells: ${CORRIDOR_KINDS.map((k) => `${k} ${counts[k] ?? 0}`).join(' · ')}`);
  console.log(`  ${totalKb.toFixed(0)} KB gzipped in all (budget ${TOTAL_BUDGET_KB}), biggest cell ${biggest.cell} ${biggest.kb.toFixed(1)} KB (budget ${CELL_BUDGET_KB})`);
  if (over.length || totalKb > TOTAL_BUDGET_KB) {
    throw new Error(`Corridor data is over budget: ${over.join(', ') || `${totalKb.toFixed(0)} KB in all`}`);
  }
  console.log(`Wrote ${OUT_DIR}`);
}

async function main(): Promise<void> {
  const offline = process.argv.includes('--from-cache');
  const pbf = flagValue(process.argv, '--from-pbf');
  const geo = JSON.parse(await readFile(BOUNDARIES, 'utf8'));
  const shapes = stateShapes(geo, (p) => String(p.shapeName ?? p.name ?? ''));
  const only = process.argv.find((a) => a.startsWith('--only='))?.slice(7).split(',');
  const cells = indianCells(shapes).filter((c) => !only || only.includes(c));
  console.log(`  ${cells.length} geohash-${CORRIDOR_CELL_PRECISION} cells${only ? '' : ' cover India'}`);
  await writeCells(pbf ? await fromPbf(pbf, cells, shapes) : await fromOverpass(cells, offline, shapes));
}

// Only when run as a script, so tests can import the helpers.
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((err: unknown) => {
    console.error(err);
    process.exit(1);
  });
}
