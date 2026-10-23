import { describe, expect, it } from 'vitest';
import { roadsideByCell, roadsideLimitM } from '../../scripts/import-corridor.ts';
import { placesNearPoints } from '../../scripts/import-places.ts';
import { addFeature, featureToElement, flagValue, isCorridorRoad, SegmentIndex, type Feature, type PbfContents } from '../../scripts/osm-pbf.ts';
import { RouteIndex, type Coord } from '../planner/geometry.ts';
import { geohashBounds } from '../shared/geohash.ts';
import {
  CORRIDOR_KINDS,
  CORRIDOR_SCHEMA,
  CORRIDOR_STAY_M,
  cellsAlongRoute,
  decodeCell,
  FLAG_OPEN_24H,
  FLAG_PURE_VEG,
  FLAG_TOILETS,
  osmToCorridorRow,
  placesAlongRoute,
  ROADSIDE_M,
  type CorridorRow,
} from './corridor.ts';

const node = (id: number, tags: Record<string, string>, lat = 17.1, lon = 78.2) => ({ type: 'node' as const, id, lat, lon, tags });

describe('osmToCorridorRow', () => {
  it('keeps the OSM ref, kind, point, name and flags', () => {
    expect(osmToCorridorRow(node(7, { amenity: 'restaurant', name: 'Highway  Dhaba', opening_hours: '24/7', 'diet:vegetarian': 'only', toilets: 'yes' }))).toEqual([
      'n7',
      CORRIDOR_KINDS.indexOf('restaurant'),
      17.1,
      78.2,
      'Highway Dhaba',
      FLAG_OPEN_24H | FLAG_PURE_VEG | FLAG_TOILETS,
    ]);
    const way = { type: 'way' as const, id: 9, center: { lat: 17.123456, lon: 78.654321 }, tags: { tourism: 'motel', name: 'NH44 Motel' } };
    expect(osmToCorridorRow(way)).toEqual(['w9', CORRIDOR_KINDS.indexOf('motel'), 17.12346, 78.65432, 'NH44 Motel', 0]);
  });

  it('keeps unnamed fuel, toilets and rest areas, using the fuel brand as a name', () => {
    expect(osmToCorridorRow(node(1, { amenity: 'fuel', brand: 'Indian Oil' }))?.[4]).toBe('Indian Oil');
    expect(osmToCorridorRow(node(2, { amenity: 'toilets' }))?.[4]).toBe('');
    expect(osmToCorridorRow(node(3, { highway: 'rest_area' }))?.[1]).toBe(CORRIDOR_KINDS.indexOf('rest_area'));
  });

  it('drops unnamed food and stays, eateries tagged as hotels, private toilets and closed places', () => {
    expect(osmToCorridorRow(node(1, { amenity: 'cafe' }))).toBeNull();
    expect(osmToCorridorRow(node(2, { tourism: 'hotel' }))).toBeNull();
    expect(osmToCorridorRow(node(3, { tourism: 'hotel', name: 'Sri Krishna Tiffins' }))).toBeNull();
    expect(osmToCorridorRow(node(4, { amenity: 'toilets', access: 'private' }))).toBeNull();
    expect(osmToCorridorRow(node(5, { amenity: 'fuel', name: 'Old pump', disused: 'yes' }))).toBeNull();
    expect(osmToCorridorRow(node(6, { amenity: 'bank', name: 'SBI' }))).toBeNull();
    expect(osmToCorridorRow({ type: 'node', id: 7, tags: { amenity: 'fuel' } })).toBeNull();
  });
});

describe('decodeCell', () => {
  it('reads rows into places with plain labels for unnamed ones', () => {
    const rows: CorridorRow[] = [
      ['n1', CORRIDOR_KINDS.indexOf('toilets'), 17, 78, '', 0],
      ['w2', CORRIDOR_KINDS.indexOf('fuel'), 17.1, 78.1, 'HP', FLAG_TOILETS | FLAG_OPEN_24H],
      ['x3', 0, 17, 78, 'bad ref', 0],
      ['n4', 99, 17, 78, 'unknown kind', 0],
    ];
    const places = decodeCell({ schema: CORRIDOR_SCHEMA, cell: 'tep', rows });
    expect(places).toHaveLength(2);
    expect(places[0]).toMatchObject({ id: 'osm-n1', cat: 'toilets', name: 'Toilets', named: false, toilets: true });
    expect(places[1]).toMatchObject({ id: 'osm-w2', cat: 'fuel', name: 'HP', named: true, open24h: true, toilets: true });
  });

  it('reads nothing from another schema', () => {
    expect(decodeCell({ schema: CORRIDOR_SCHEMA + 1, cell: 'tep', rows: [['n1', 0, 17, 78, 'x', 0]] })).toEqual([]);
  });
});

describe('route helpers', () => {
  // Hyderabad to Kurnool, roughly along NH44.
  const route: Coord[] = Array.from({ length: 41 }, (_, i) => [78.47 - i * 0.004, 17.38 - i * 0.05]);

  it('finds every published cell the route crosses, and no others', () => {
    const published = ['tep', 'tef', 'te7', 'tdr', 'tg2'];
    const cells = cellsAlongRoute(route, published);
    for (const c of route) {
      const inside = published.find((cell) => {
        const b = geohashBounds(cell);
        return c[1] >= b.south && c[1] <= b.north && c[0] >= b.west && c[0] <= b.east;
      });
      if (inside) expect(cells).toContain(inside);
    }
    expect(cells).not.toContain('tg2');
  });

  it('orders places by distance along the route and drops far ones', () => {
    const index = new RouteIndex(route);
    const at = (i: number, offLng: number) => ({ lat: route[i][1], lng: route[i][0] + offLng });
    const rows: CorridorRow[] = [
      ['n1', CORRIDOR_KINDS.indexOf('fuel'), at(30, 0).lat, at(30, 0).lng, 'Late', 0],
      ['n2', CORRIDOR_KINDS.indexOf('hotel'), at(5, 0.005).lat, at(5, 0.005).lng, 'Early', 0],
      ['n3', CORRIDOR_KINDS.indexOf('cafe'), at(10, 0.2).lat, at(10, 0.2).lng, 'Far off', 0],
    ];
    const found = placesAlongRoute(index, decodeCell({ schema: CORRIDOR_SCHEMA, cell: 'tep', rows }));
    expect(found.map((f) => f.place.name)).toEqual(['Early', 'Late']);
    expect(found[0].offKm).toBeLessThan(1);
    expect(found[1].alongKm).toBeGreaterThan(found[0].alongKm);
  });
});

describe('reading a local OSM extract', () => {
  const line = (id: string, tags: Record<string, string>, coordinates: number[][]): Feature => ({
    type: 'Feature',
    id,
    geometry: { type: 'LineString', coordinates },
    properties: tags,
  });

  it('takes the same roads as the Overpass query', () => {
    expect(isCorridorRoad({ highway: 'trunk' })).toBe(true);
    expect(isCorridorRoad({ highway: 'motorway_link' })).toBe(true);
    expect(isCorridorRoad({ highway: 'primary', ref: 'SH 1;NH 44' })).toBe(true);
    expect(isCorridorRoad({ highway: 'secondary', ref: 'NE-4' })).toBe(true);
    expect(isCorridorRoad({ highway: 'primary', ref: 'SH 17' })).toBe(false);
    expect(isCorridorRoad({ highway: 'primary' })).toBe(false);
    expect(isCorridorRoad({ highway: 'primary_link', ref: 'NH 44' })).toBe(false);
  });

  it('reads nodes, ways and osmium areas as Overpass-style elements', () => {
    const point: Feature = { type: 'Feature', id: 'n5', geometry: { type: 'Point', coordinates: [78.2, 17.1] }, properties: { amenity: 'fuel', 'fuel:diesel': 'yes' } };
    expect(featureToElement(point)).toEqual({ type: 'node', id: 5, lat: 17.1, lon: 78.2, tags: { amenity: 'fuel', 'fuel:diesel': 'yes' } });
    const ring = [[[78, 17], [78.2, 17], [78.2, 17.4], [78, 17]]];
    const wayArea: Feature = { type: 'Feature', id: 'a20', geometry: { type: 'MultiPolygon', coordinates: [ring] }, properties: { tourism: 'hotel' } };
    expect(featureToElement(wayArea)).toMatchObject({ type: 'way', id: 10, center: { lat: 17.2, lon: 78.1 } });
    expect(featureToElement({ ...wayArea, id: 'a21' })).toMatchObject({ type: 'relation', id: 10 });
    expect(featureToElement({ ...wayArea, id: 'x1' })).toBeNull();
    expect(flagValue(['node', 's', '--from-pbf', '/tmp/a.pbf'], '--from-pbf')).toBe('/tmp/a.pbf');
    expect(flagValue(['--from-pbf=/tmp/b.pbf'], '--from-pbf')).toBe('/tmp/b.pbf');
    expect(flagValue(['--from-pbf', '--only=tep'], '--from-pbf')).toBeNull();
  });

  it('measures metres to the nearest road segment', () => {
    const roads = new SegmentIndex();
    // A north-south highway at lng 78.0 from lat 17 to 18 (about 111 km, one segment over many grid squares).
    roads.addLine([[78, 17], [78, 18]]);
    const m = roads.nearestM(17.5, 78.004, 1000)!;
    expect(m).toBeGreaterThan(400);
    expect(m).toBeLessThan(450);
    expect(roads.nearestM(17.5, 78.01, 500)).toBeNull();
    // Past the end of the road, the distance is to its end point.
    expect(roads.nearestM(18.004, 78, 1000)).toBeCloseTo(445, -1);
  });

  it('keeps places by the road rules: 500 m for services, 1.5 km for stays, roads only from highways', () => {
    const contents: PbfContents = { places: [], roads: new SegmentIndex() };
    addFeature(contents, line('w1', { highway: 'trunk', ref: 'NH44' }, [[78, 17], [78, 18]]));
    addFeature(contents, line('w2', { highway: 'primary', ref: 'SH 1' }, [[78.1, 17], [78.1, 18]]));
    const at = (id: string, tags: Record<string, string>, lng: number): Feature => ({ type: 'Feature', id, geometry: { type: 'Point', coordinates: [lng, 17.5] }, properties: tags });
    addFeature(contents, at('n1', { amenity: 'fuel', brand: 'HP' }, 78.003)); // ~320 m: kept
    addFeature(contents, at('n2', { amenity: 'restaurant', name: 'Far Dhaba' }, 78.008)); // ~850 m: too far for food
    addFeature(contents, at('n3', { tourism: 'hotel', name: 'Road Inn' }, 78.012)); // ~1.3 km: kept, a stay
    addFeature(contents, at('n4', { tourism: 'hotel', name: 'State Road Inn' }, 78.1)); // on a state road only
    addFeature(contents, at('n5', { shop: 'bakery', name: 'Not wanted' }, 78));
    expect(contents.roads!.segments).toBe(1);
    expect(contents.places.map((p) => p.id)).toEqual([1, 2, 3, 4]);
    const byCell = roadsideByCell(contents.places, contents.roads, () => true);
    const rows = [...byCell.values()].flat();
    expect(rows.map((r) => r[0]).sort()).toEqual(['n1', 'n3']);
    expect(roadsideLimitM(rows.find((r) => r[0] === 'n3')!)).toBe(CORRIDOR_STAY_M);
    expect(roadsideLimitM(rows.find((r) => r[0] === 'n1')!)).toBe(ROADSIDE_M);
    // A place seen twice (an area and a node, or two split boxes) is kept once.
    expect([...roadsideByCell([...contents.places, ...contents.places], contents.roads, () => true).values()].flat()).toHaveLength(2);
  });

  it('finds named food, stays and toilets near charger points for import-places', () => {
    const el = (id: number, tags: Record<string, string>, lon: number) => ({ type: 'node' as const, id, lat: 17.5, lon, tags });
    const els = [
      el(1, { amenity: 'cafe', name: 'Near Cafe' }, 78.005), // ~530 m
      el(2, { amenity: 'cafe', name: 'Far Cafe' }, 78.01), // ~1.06 km, past 800 m
      el(3, { tourism: 'hotel', name: 'Hotel 2 km' }, 78.02), // ~2.1 km, within 3 km
      el(4, { amenity: 'cafe' }, 78.001), // no name
      el(5, { amenity: 'toilets' }, 78.001),
      el(6, { amenity: 'fuel', name: 'Pump' }, 78.001), // not a place import-places wants
    ];
    expect(placesNearPoints([...els, els[0]], [{ lat: 17.5, lng: 78 }]).map((e) => e.id)).toEqual([1, 3, 5]);
    expect(placesNearPoints(els, [])).toEqual([]);
  });
});
