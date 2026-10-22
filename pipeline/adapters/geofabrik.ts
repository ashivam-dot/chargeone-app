// OpenStreetMap from the Geofabrik India extract: the scheduled-run replacement for Overpass.
//
// NOT run on a laptop: the PBF is about 1.7 GB. In CI (once GitHub Actions billing is fixed):
//
//   curl -sSfLo india.osm.pbf https://download.geofabrik.de/asia/india-latest.osm.pbf
//   osmium tags-filter india.osm.pbf nwr/amenity=charging_station -o ev.osm.pbf
//   osmium export ev.osm.pbf --geometry-types=point,polygon -a type,id,timestamp -f geojsonseq -o ev.geojsonseq
//   PIPELINE_OSM_SOURCE=geofabrik PIPELINE_GEOFABRIK_FILE=ev.geojsonseq npm run data:build
//
// Later runs should apply the daily .osc diffs (osmium apply-changes) instead of the full download.
// Each GeoJSON feature becomes the same OsmElement the Overpass adapter makes (polygons by their
// centroid), so toCanonical, health and licence are shared with osm.ts.
import { readFile } from 'node:fs/promises';
import { LICENCES } from '../licences.ts';
import type { Adapter } from '../types.ts';
import { osmHealth, osmToCanonical, type OsmElement, type OsmRaw } from './osm.ts';

interface GeoJsonSeqFeature {
  geometry: { type: string; coordinates: unknown };
  properties: Record<string, string | number>;
}

function centroid(geometry: GeoJsonSeqFeature['geometry']): { lat: number; lon: number } | null {
  if (geometry.type === 'Point') {
    const [lon, lat] = geometry.coordinates as [number, number];
    return { lat, lon };
  }
  const ring = geometry.type === 'Polygon' ? (geometry.coordinates as number[][][])[0] : geometry.type === 'MultiPolygon' ? (geometry.coordinates as number[][][][])[0][0] : null;
  if (!ring?.length) return null;
  const sum = ring.reduce((acc, [x, y]) => [acc[0] + x, acc[1] + y], [0, 0]);
  return { lon: sum[0] / ring.length, lat: sum[1] / ring.length };
}

/** Parses `osmium export -f geojsonseq -a type,id,timestamp` output. */
export function parseGeojsonSeq(text: string): OsmElement[] {
  const out: OsmElement[] = [];
  for (const line of text.split('\n')) {
    const json = line.replace(/^\x1e/, '').trim();
    if (!json) continue;
    const f = JSON.parse(json) as GeoJsonSeqFeature;
    const { '@type': type, '@id': id, '@timestamp': ts, ...tags } = f.properties;
    const c = centroid(f.geometry);
    if (!c) continue;
    const osmType = String(type) as OsmElement['type'];
    const stringTags = Object.fromEntries(Object.entries(tags).map(([k, v]) => [k, String(v)]));
    out.push({
      type: osmType,
      id: Number(id),
      ...(osmType === 'node' ? { lat: c.lat, lon: c.lon } : { center: c }),
      timestamp: typeof ts === 'number' ? new Date(ts * 1000).toISOString() : ts ? String(ts) : undefined,
      tags: stringTags,
    });
  }
  return out;
}

export const geofabrikAdapter: Adapter<OsmRaw> = {
  key: 'osm',
  name: 'OpenStreetMap (Geofabrik extract)',
  licence: LICENCES['ODbL-1.0'],
  async fetchRaw() {
    const file = process.env.PIPELINE_GEOFABRIK_FILE;
    if (!file) {
      throw new Error(
        'The Geofabrik adapter reads a pre-filtered osmium export (PIPELINE_GEOFABRIK_FILE). It is meant for CI; see the commands at the top of pipeline/adapters/geofabrik.ts.',
      );
    }
    const elements = parseGeojsonSeq(await readFile(file, 'utf8'));
    const latest = elements.reduce<string | null>((acc, e) => (e.timestamp && (!acc || e.timestamp > acc) ? e.timestamp : acc), null);
    return { snapshotAt: latest, fetchedAt: new Date().toISOString(), endpoint: 'geofabrik', elements };
  },
  toCanonical: osmToCanonical,
  health: osmHealth,
};
