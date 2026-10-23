import { describe, expect, it } from 'vitest';
import { RouteIndex, type Coord } from '../planner/geometry.ts';
import { geohashBounds } from '../shared/geohash.ts';
import {
  CORRIDOR_KINDS,
  CORRIDOR_SCHEMA,
  cellsAlongRoute,
  decodeCell,
  FLAG_OPEN_24H,
  FLAG_PURE_VEG,
  FLAG_TOILETS,
  osmToCorridorRow,
  placesAlongRoute,
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
