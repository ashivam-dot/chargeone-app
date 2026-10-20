import { describe, expect, it } from 'vitest';
import type { Station } from '../data/model.ts';
import type { Place, PlacesData } from '../data/places.ts';
import { VEHICLES, myVehicleFromModel } from '../shared/vehicles.ts';
import type { Coord } from './geometry.ts';
import { chooseOvernight, planJourney, sortStays, staysNearDestination } from './journey.ts';
import { DEFAULT_OPTIONS } from './planner.ts';

const KM_PER_DEG_LAT = 111.2;
const LNG = 77;
const START_LAT = 20;
const now = new Date('2026-10-20T10:00:00Z');
const nexon = myVehicleFromModel(VEHICLES.find((v) => v.id === 'tata-nexon-ev-45')!);

/** A straight north-bound route at 60 km/h with a vertex every 5 km. */
function route(km: number) {
  const coords: Coord[] = [];
  for (let d = 0; d <= km; d += 5) coords.push([LNG, START_LAT + d / KM_PER_DEG_LAT]);
  return { coords, distanceKm: km, durationMin: km };
}

function station(id: string, atKm: number): Station {
  return {
    id,
    name: `Charger ${id}`,
    operator: 'Test',
    lat: START_LAT + atKm / KM_PER_DEG_LAT,
    lng: LNG + 0.003,
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
  };
}

const stay = (id: string, chargerOnSite = false): Place => ({ id, cat: 'stay', kind: 'hotel', name: `Hotel ${id}`, lat: 0, lng: 0, chargerOnSite });
const food = (id: string): Place => ({ id, cat: 'food', kind: 'restaurant', name: `Food ${id}`, lat: 0, lng: 0 });

// Chargers every 100 km; only some have stays, one with a charger on site.
const stations = [100, 200, 300, 380, 420, 500, 600, 700, 800, 900].map((km) => station(`c${km}`, km));
const places: PlacesData = {
  generatedAt: '',
  attribution: '',
  places: [stay('h1'), stay('h2', true), food('f1')],
  near: { c380: { f: [[2, 120]], s: [[0, 400]] }, c420: { f: [], s: [[1, 90]] } },
  area: {},
  cities: [],
};

function journey(km: number, dailyHours: number, data: PlacesData | null = places) {
  return planJourney({ route: route(km), stations, statuses: new Map(), vehicle: nexon, options: DEFAULT_OPTIONS, now, dailyHours, places: data });
}

describe('planJourney', () => {
  it('keeps a trip within the daily limit as one day', () => {
    const j = journey(300, 8);
    expect(j.days).toHaveLength(1);
    expect(j.days[0].overnight).toBeNull();
    expect(j.feasible).toBe(true);
  });

  it('splits a long trip at a charger with stays, preferring a charger on site', () => {
    // 1000 km at 60 km/h is ~16.7 h; 8 h/day with the buffer is ~408 km a day.
    const j = journey(1000, 8);
    expect(j.days.length).toBeGreaterThanOrEqual(3);
    const first = j.days[0].overnight!;
    expect(first.station.id).toBe('c380');
    expect(first.stays[0].place.name).toBe('Hotel h1');
    expect(first.food[0].place.name).toBe('Food f1');
    expect(j.days[1].startSocPct).toBe(100);
    expect(j.days[1].startKm).toBeCloseTo(first.alongKm, 0);
    expect(j.feasible).toBe(true);
    expect(j.distanceKm).toBeCloseTo(1000, -1);
  });

  it('has no daily limit when set to 0', () => {
    expect(journey(1000, 0).days).toHaveLength(1);
  });

  it('still splits the trip without any stay data', () => {
    const j = journey(1000, 8, null);
    expect(j.days.length).toBeGreaterThan(1);
    expect(j.days[0].overnight?.stays).toEqual([]);
  });
});

describe('chooseOvernight', () => {
  const cand = (id: string, alongKm: number, stays: Place[]) => ({
    station: station(id, alongKm),
    alongKm,
    detourKm: 0,
    mode: 'dc' as const,
    powerKw: 50,
    stays: stays.map((place) => ({ place, metres: 100 })),
  });

  it('prefers a stay with a charger on site over a slightly later charger', () => {
    const pick = chooseOvernight([cand('a', 380, [stay('x', true)]), cand('b', 400, [stay('y')])], 0, 400);
    expect(pick?.station.id).toBe('a');
  });

  it('prefers any stay over none', () => {
    expect(chooseOvernight([cand('a', 300, [stay('x')]), cand('b', 395, [])], 0, 400)?.station.id).toBe('a');
  });

  it('ends the day a little earlier to reach a charger with a hotel', () => {
    expect(chooseOvernight([cand('a', 200, [stay('x')]), cand('b', 300, [])], 0, 400)?.station.id).toBe('a');
    expect(chooseOvernight([cand('a', 150, [stay('x')]), cand('b', 300, [])], 0, 400)?.station.id).toBe('b');
  });

  it('returns null when no charger is near the end of the day', () => {
    expect(chooseOvernight([cand('a', 50, [])], 0, 400)).toBeNull();
  });
});

describe('stays', () => {
  it('sorts a charger on site first, then by distance', () => {
    const sorted = sortStays([
      { place: stay('far'), metres: 100 },
      { place: stay('onsite', true), metres: 900 },
      { place: stay('near'), metres: 50 },
    ]);
    expect(sorted.map((s) => s.place.id)).toEqual(['onsite', 'near', 'far']);
  });

  it('finds stays near the destination through nearby chargers', () => {
    const dest = { lat: START_LAT + 420 / KM_PER_DEG_LAT, lng: LNG };
    expect(staysNearDestination({ stations, places }, dest).map((s) => s.place.id)).toEqual(['h2']);
    expect(staysNearDestination({ stations, places }, dest, 50).map((s) => s.place.id)).toEqual(['h2', 'h1']);
  });
});
