import { describe, expect, it } from 'vitest';
import type { Station } from '../data/model.ts';
import type { PlacesData } from '../data/places.ts';
import { VEHICLES, myVehicleFromModel } from '../shared/vehicles.ts';
import type { Coord } from './geometry.ts';
import { planJourney } from './journey.ts';
import { DEFAULT_OPTIONS } from './planner.ts';
import { compareRoutes, type RouteCandidate } from './routeCompare.ts';

const KM_PER_DEG_LAT = 111.2;
const now = new Date('2026-10-20T10:00:00Z');
const nexon = myVehicleFromModel(VEHICLES.find((v) => v.id === 'tata-nexon-ev-45')!);

function station(id: string, lng: number, atKm: number): Station {
  return {
    id,
    name: `Charger ${id}`,
    operator: 'Test',
    lat: 20 + atKm / KM_PER_DEG_LAT,
    lng: lng + 0.003,
    connectors: [{ type: 'CCS2', count: 1, kw: 60 }],
    points: 1,
    maxKw: 60,
    speed: 'dc',
    vehicles: ['car'],
    batterySwap: false,
    hours: '24/7',
    is24x7: true,
    price: null,
    access: 'public',
    address: null,
    website: null,
    sources: [],
    confidence: 0.8,
  };
}

/** A straight north-bound road along `lng`, `km` long, at `kmh`. */
function road(lng: number, km: number, kmh: number, climbPerKm = 0): { coords: Coord[]; distanceKm: number; durationMin: number } {
  const coords: Coord[] = [];
  for (let d = 0; d <= km; d += 5) coords.push([lng, 20 + d / KM_PER_DEG_LAT, 300 + (d % 20 < 10 ? d * climbPerKm : 0)]);
  return { coords, distanceKm: km, durationMin: (km / kmh) * 60 };
}

// Road A: chargers every 60 km. Road B: faster, but one 150 km stretch without a fast charger.
const stations = [
  ...[60, 120, 180, 240, 300, 360].map((km) => station(`a${km}`, 77, km)),
  ...[100, 250].map((km) => station(`b${km}`, 78, km)),
];
const places: PlacesData = { generatedAt: '', attribution: '', places: [], near: {}, area: { b100: 'Salem' }, cities: [] };

function candidate(r: ReturnType<typeof road>, via: RouteCandidate['via']): RouteCandidate {
  const journey = planJourney({ route: r, stations, statuses: new Map(), vehicle: nexon, options: DEFAULT_OPTIONS, now, dailyHours: 0, places: null });
  return { ...r, journey, via };
}

describe('compareRoutes', () => {
  const main = candidate(road(77, 400, 60), null);
  const alt = candidate(road(78, 400, 70, 1), { lat: 20 + 100 / KM_PER_DEG_LAT, lng: 78 });
  const rows = compareRoutes([main, alt], stations, new Map(), places, now);

  it('labels the main route and names the town an alternative goes through', () => {
    expect(rows.map((r) => r.label)).toEqual(['Main route', 'Via Salem']);
  });

  it('measures DC chargers along each road and the longest gap', () => {
    expect(rows[0].dcChargers).toBe(6);
    expect(rows[0].longestDcGapKm).toBe(60);
    expect(rows[1].dcChargers).toBe(2);
    expect(rows[1].longestDcGapKm).toBe(150);
  });

  it('plans both roads as drivable', () => {
    expect(rows.every((r) => r.feasible)).toBe(true);
  });

  it('tags the faster road and the one with denser chargers', () => {
    expect(rows[1].tags).toContain('fastest');
    expect(rows[0].tags).toContain('safest');
    expect(rows[1].cons.some((c) => c.includes('no fast charger'))).toBe(true);
  });

  it('explains advantages in plain words', () => {
    expect(rows[1].pros.some((p) => p.endsWith('faster'))).toBe(true);
    expect(rows[0].pros).toContain('DC chargers at most 60 km apart');
  });

  it('never sells an unsafe route as faster or with fewer stops', () => {
    const bare = { ...candidate(road(79, 400, 90), { lat: 21, lng: 79 }) };
    bare.journey = { ...bare.journey, feasible: false, stopCount: 0, chargeMinutes: 0 };
    const [safe, unsafe] = compareRoutes([main, bare], stations, new Map(), places, now);
    expect(unsafe.cons[0]).toBe('Not safe as planned with your battery');
    expect(unsafe.pros.some((p) => p.endsWith('faster') || p.includes('fewer charging stop'))).toBe(false);
    expect(unsafe.tags).not.toContain('fastest');
    expect(safe.cons.some((c) => c.endsWith('slower'))).toBe(false);
  });

  it('returns a single row unchanged when there is nothing to compare', () => {
    const one = compareRoutes([main], stations, new Map(), places, now);
    expect(one).toHaveLength(1);
    expect(one[0].tags).toEqual([]);
  });
});
