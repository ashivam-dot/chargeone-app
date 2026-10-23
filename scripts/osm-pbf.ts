// Reads places and highways from a local OpenStreetMap extract (the Geofabrik India .osm.pbf, ODbL),
// for the build-time imports. One pass of osmium (brew install osmium-tool) keeps only the roads and
// place tags we use and exports them as GeoJSON lines; everything after that is plain node code.
// Far faster than asking Overpass about India box by box, and no load on a donated server.
import { spawnSync } from 'node:child_process';
import { createReadStream, existsSync, statSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { createInterface } from 'node:readline';
import type { OsmElement } from '../src/data/normalize.ts';

/** Everything the corridor and places imports look at, as osmium tags-filter expressions. */
export const PBF_FILTERS = [
  'w/highway=motorway,motorway_link,trunk,trunk_link,primary,primary_link,secondary',
  'nwr/amenity=restaurant,fast_food,cafe,food_court,fuel,toilets',
  'nwr/highway=rest_area,services',
  'nwr/tourism=hotel,motel,guest_house,hostel',
  'nwr/leisure=resort',
];

const ROAD_TYPES = new Set(['motorway', 'motorway_link', 'trunk', 'trunk_link']);
const NH_REF = /(^|;) *(NH|NE) *-? *[0-9]/;

/**
 * National highways and expressways: every motorway and trunk road (in India trunk is the NH
 * network) and their slip roads, plus primary and secondary roads that carry an NH or NE ref.
 * The same rule as the Overpass query in import-corridor.ts.
 */
export function isCorridorRoad(tags: Record<string, string> | undefined): boolean {
  const hw = tags?.highway ?? '';
  if (ROAD_TYPES.has(hw)) return true;
  return (hw === 'primary' || hw === 'secondary') && NH_REF.test(tags?.ref ?? '');
}

export interface Feature {
  type: 'Feature';
  id?: string;
  geometry: { type: string; coordinates: unknown } | null;
  properties: Record<string, unknown> | null;
}

type Pos = [number, number];

/** Every polyline in a geometry: a line, each ring of a polygon, and so on. */
export function linesOf(geometry: Feature['geometry']): Pos[][] {
  if (!geometry) return [];
  const c = geometry.coordinates;
  switch (geometry.type) {
    case 'LineString':
      return [c as Pos[]];
    case 'MultiLineString':
    case 'Polygon':
      return c as Pos[][];
    case 'MultiPolygon':
      return (c as Pos[][][]).flat();
    default:
      return [];
  }
}

function tagsOf(f: Feature): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(f.properties ?? {})) if (typeof v === 'string') out[k] = v;
  return out;
}

const TYPES = { n: 'node', w: 'way', r: 'relation' } as const;

/**
 * An exported feature as the element Overpass would have returned with `out tags center`: a node
 * keeps its point, a way or relation gets the centre of its bounding box.
 */
export function featureToElement(f: Feature): OsmElement | null {
  const m = /^([nwr])(\d+)$/.exec(f.id ?? '');
  if (!m || !f.geometry) return null;
  const type = TYPES[m[1] as keyof typeof TYPES];
  const id = Number(m[2]);
  const tags = tagsOf(f);
  if (f.geometry.type === 'Point') {
    const [lon, lat] = f.geometry.coordinates as Pos;
    return { type, id, lat, lon, tags };
  }
  let south = Infinity;
  let north = -Infinity;
  let west = Infinity;
  let east = -Infinity;
  for (const line of linesOf(f.geometry)) {
    for (const [lng, lat] of line) {
      if (lat < south) south = lat;
      if (lat > north) north = lat;
      if (lng < west) west = lng;
      if (lng > east) east = lng;
    }
  }
  if (!Number.isFinite(south)) return null;
  return { type, id, center: { lat: (south + north) / 2, lon: (west + east) / 2 }, tags };
}

const M_PER_DEG = 111_320;
/** Grid step of the road index, in degrees (about 5.5 km). */
const GRID_DEG = 0.05;

/** Road segments on a coarse grid, for "how far is the nearest highway" in a few microseconds. */
export class SegmentIndex {
  private readonly coords: number[] = [];
  private readonly grid = new Map<number, number[]>();
  segments = 0;

  private static key(gx: number, gy: number): number {
    return gy * 100_000 + gx;
  }

  /** Adds a polyline of [lng, lat] points. */
  addLine(line: Pos[]): void {
    for (let i = 1; i < line.length; i++) {
      const [x1, y1] = line[i - 1];
      const [x2, y2] = line[i];
      const s = this.coords.length / 4;
      this.coords.push(x1, y1, x2, y2);
      this.segments++;
      const gx0 = Math.floor(Math.min(x1, x2) / GRID_DEG);
      const gx1 = Math.floor(Math.max(x1, x2) / GRID_DEG);
      const gy0 = Math.floor(Math.min(y1, y2) / GRID_DEG);
      const gy1 = Math.floor(Math.max(y1, y2) / GRID_DEG);
      for (let gy = gy0; gy <= gy1; gy++) {
        for (let gx = gx0; gx <= gx1; gx++) {
          const k = SegmentIndex.key(gx, gy);
          const list = this.grid.get(k);
          if (list) list.push(s);
          else this.grid.set(k, [s]);
        }
      }
    }
  }

  /** Metres from a point to the nearest road, or null when none is within `maxM`. */
  nearestM(lat: number, lng: number, maxM: number): number | null {
    const cos = Math.cos((lat * Math.PI) / 180);
    const dLat = maxM / M_PER_DEG;
    const dLng = maxM / (M_PER_DEG * cos);
    let best = Infinity;
    const seen = new Set<number>();
    for (let gy = Math.floor((lat - dLat) / GRID_DEG); gy <= Math.floor((lat + dLat) / GRID_DEG); gy++) {
      for (let gx = Math.floor((lng - dLng) / GRID_DEG); gx <= Math.floor((lng + dLng) / GRID_DEG); gx++) {
        for (const s of this.grid.get(SegmentIndex.key(gx, gy)) ?? []) {
          if (seen.has(s)) continue;
          seen.add(s);
          // Flat metres around the point: plenty accurate over a couple of kilometres.
          const ax = (this.coords[s * 4] - lng) * cos * M_PER_DEG;
          const ay = (this.coords[s * 4 + 1] - lat) * M_PER_DEG;
          const bx = (this.coords[s * 4 + 2] - lng) * cos * M_PER_DEG;
          const by = (this.coords[s * 4 + 3] - lat) * M_PER_DEG;
          const dx = bx - ax;
          const dy = by - ay;
          const len2 = dx * dx + dy * dy;
          const t = len2 ? Math.max(0, Math.min(1, -(ax * dx + ay * dy) / len2)) : 0;
          const d = Math.hypot(ax + t * dx, ay + t * dy);
          if (d < best) best = d;
        }
      }
    }
    return best <= maxM ? best : null;
  }
}

export interface PbfContents {
  /** Every place-tagged object (not roads), as Overpass-style elements. */
  places: OsmElement[];
  /** National highways and expressways; only built when asked for. */
  roads: SegmentIndex | null;
}

function osmium(args: string[]): void {
  const r = spawnSync('osmium', args, { stdio: 'inherit' });
  if (r.error) throw new Error(`osmium failed to start (brew install osmium-tool): ${r.error.message}`);
  if (r.status !== 0) throw new Error(`osmium ${args[0]} exited with ${r.status}`);
}

/**
 * Runs osmium once per extract: tags-filter, then export to GeoJSON lines next to the extract
 * (in /tmp/osm/ for the India file). A later call reuses the export while it is newer than the extract.
 */
export function exportPbf(pbf: string): string {
  if (!existsSync(pbf)) throw new Error(`${pbf} not found`);
  const base = join(dirname(pbf), basename(pbf).replace(/(\.osm)?\.pbf$/, ''));
  const filtered = `${base}.chargeone.osm.pbf`;
  const out = `${base}.chargeone.geojsonseq`;
  if (existsSync(out) && statSync(out).mtimeMs > statSync(pbf).mtimeMs) return out;
  console.log(`  osmium: filtering ${pbf}`);
  osmium(['tags-filter', pbf, ...PBF_FILTERS, '-o', filtered, '--overwrite']);
  console.log(`  osmium: exporting ${filtered}`);
  osmium(['export', filtered, '-f', 'geojsonseq', '-x', 'print_record_separator=false', '-u', 'type_id', '-o', out, '--overwrite']);
  return out;
}

const PLACE_TAG = /"(amenity|tourism|leisure|highway)"/;
export const isPlaceTags = (t: Record<string, string>) =>
  /^(restaurant|fast_food|cafe|food_court|fuel|toilets)$/.test(t.amenity ?? '') ||
  /^(rest_area|services)$/.test(t.highway ?? '') ||
  /^(hotel|motel|guest_house|hostel)$/.test(t.tourism ?? '') ||
  t.leisure === 'resort';

/** Reads one GeoJSON line into the contents: a highway goes into the road index, a place into the list. */
export function addFeature(into: PbfContents, f: Feature): void {
  const tags = tagsOf(f);
  if (f.id?.startsWith('w') && isCorridorRoad(tags)) {
    if (into.roads) for (const l of linesOf(f.geometry)) into.roads.addLine(l);
    return;
  }
  if (!isPlaceTags(tags)) return;
  const el = featureToElement(f);
  if (el) into.places.push(el);
}

/** Reads an export made by exportPbf. */
export async function readPbfExport(file: string, withRoads: boolean): Promise<PbfContents> {
  const into: PbfContents = { places: [], roads: withRoads ? new SegmentIndex() : null };
  const lines = createInterface({ input: createReadStream(file), crlfDelay: Infinity });
  for await (const line of lines) if (line && PLACE_TAG.test(line)) addFeature(into, JSON.parse(line) as Feature);
  return into;
}

/** Both steps: osmium (or its cached export), then the read. */
export async function readPbf(pbf: string, withRoads: boolean): Promise<PbfContents> {
  return readPbfExport(exportPbf(pbf), withRoads);
}

/** The value after a flag, as in `--from-pbf /tmp/osm/india.osm.pbf` or `--from-pbf=...`. */
export function flagValue(argv: string[], flag: string): string | null {
  const eq = argv.find((a) => a.startsWith(`${flag}=`));
  if (eq) return eq.slice(flag.length + 1);
  const i = argv.indexOf(flag);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : null;
}
