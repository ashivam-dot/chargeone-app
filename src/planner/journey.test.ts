import { describe, expect, it } from 'vitest';
import type { Station } from '../data/model.ts';
import type { Place, PlacesData } from '../data/places.ts';
import { VEHICLES, myVehicleFromModel } from '../shared/vehicles.ts';
import type { Coord } from './geometry.ts';
import { NIGHT_BY, morningSoc, planJourney, sortStays, staysNearDestination } from './journey.ts';
import { DEFAULT_OPTIONS } from './planner.ts';
import type { CorridorPlace } from '../data/corridor.ts';
import { BREAK_EVERY_MIN, BREAK_TOLERANCE_MIN } from './itinerary.ts';

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
    confidence: 0.8,
  };
}

const stay = (id: string, chargerOnSite = false): Place => ({
  id,
  cat: 'stay',
  kind: 'hotel',
  name: `Hotel ${id}`,
  lat: 0,
  lng: 0,
  chargerOnSite,
});
const food = (id: string): Place => ({
  id,
  cat: 'food',
  kind: 'restaurant',
  name: `Food ${id}`,
  lat: 0,
  lng: 0,
});

// Chargers every 100 km; only some have stays, one with a charger on site.
const stations = [100, 200, 300, 380, 420, 500, 600, 700, 800, 900].map((km) => station(`c${km}`, km));
const places: PlacesData = {
  generatedAt: '',
  attribution: '',
  places: [stay('h1'), stay('h2', true), food('f1')],
  near: {
    c380: { f: [[2, 120]], s: [[0, 400]] },
    c420: { f: [], s: [[1, 90]] },
  },
  area: {},
  cities: [],
};

const depart = new Date(2026, 9, 21, 6, 0).getTime();

function journey(
  km: number,
  dailyHours: number,
  data: PlacesData | null = places,
  extra: {
    stations?: Station[];
    corridor?: CorridorPlace[];
    departAt?: number;
  } = {},
) {
  return planJourney({
    route: route(km),
    stations: extra.stations ?? stations,
    statuses: new Map(),
    vehicle: nexon,
    options: DEFAULT_OPTIONS,
    now,
    dailyHours,
    places: data,
    departAt: extra.departAt ?? depart,
    corridor: extra.corridor,
  });
}

const poi = (id: string, km: number, kind: CorridorPlace['kind'], cat: CorridorPlace['cat'], name = `${kind} ${id}`): CorridorPlace => ({
  id: `osm-n${id}`,
  kind,
  cat,
  name,
  named: true,
  lat: START_LAT + km / KM_PER_DEG_LAT,
  lng: LNG + 0.002,
  open24h: true,
  toilets: false,
  pureVeg: false,
});

describe('planJourney', () => {
  it('keeps a trip within the daily limit as one day, with clock times', () => {
    const j = journey(300, 8);
    expect(j.days).toHaveLength(1);
    expect(j.days[0].night).toBeNull();
    expect(j.feasible).toBe(true);
    expect(j.departAt).toBe(depart);
    const items = j.days[0].items;
    expect(items[0].kind).toBe('depart');
    expect(items[items.length - 1].kind).toBe('arrive');
    expect(j.arriveAt).toBe(items[items.length - 1].at);
    // 300 km at 60 km/h plus stops: at least 5 h after leaving.
    expect(j.arriveAt - depart).toBeGreaterThanOrEqual(300 * 60_000);
  });

  it('splits a long trip at a reachable charger with a stay, within the day limit and night window', () => {
    const j = journey(1000, 8);
    expect(j.days.length).toBeGreaterThanOrEqual(2);
    expect(j.feasible).toBe(true);
    for (const d of j.days.slice(0, -1)) {
      expect(d.night).not.toBeNull();
      expect(d.driveMinutes).toBeLessThanOrEqual(8 * 60 + 10);
      const by = new Date(d.departAt);
      expect(d.arriveAt).toBeLessThanOrEqual(new Date(by.getFullYear(), by.getMonth(), by.getDate(), NIGHT_BY[0], NIGHT_BY[1] + 15).getTime());
    }
    const first = j.days[0];
    expect(first.overnight?.station.id).toMatch(/^c(380|420)$/);
    expect(first.night!.stays.length).toBeGreaterThan(0);
    expect(j.days[1].startKm).toBeCloseTo(first.endKm, 0);
    expect(j.days[1].startSocPct).toBe(first.night!.morningSocPct);
    // The next morning leaves at the same time of day.
    expect(new Date(j.days[1].departAt).getHours()).toBe(6);
    expect(j.distanceKm).toBeCloseTo(1000, -1);
  });

  it('ends the day earlier when leaving late, so it arrives by the night window', () => {
    const late = new Date(2026, 9, 21, 14, 0).getTime();
    const j = journey(1000, 10, places, { departAt: late });
    const d = j.days[0];
    expect(d.night).not.toBeNull();
    expect(d.arriveAt).toBeLessThanOrEqual(new Date(2026, 9, 21, NIGHT_BY[0], NIGHT_BY[1] + 15).getTime());
  });

  it('never charges at the overnight charger as a stop on the same day', () => {
    for (const hours of [4, 6, 8]) {
      const j = journey(1000, hours);
      for (const d of j.days) {
        if (d.overnight) expect(d.plan.stops.map((s) => s.station.id)).not.toContain(d.overnight.station.id);
      }
    }
  });

  it('has no daily limit when set to 0, with a warning for a very long day', () => {
    const j = journey(1000, 0);
    expect(j.days).toHaveLength(1);
    expect(j.warnings.join(' ')).toMatch(/at the wheel in one go/);
  });

  it('starts the next day below 100% after a night on a slow AC charger', () => {
    expect(morningSoc(20, 45, 'dc', 30)).toBe(100);
    expect(morningSoc(20, 45, 'ac', 7.4)).toBe(100);
    expect(morningSoc(20, 45, 'ac', 3.3)).toBe(75);
  });

  it('calls a trip too long, not unsafe, when it needs more than 7 days', () => {
    const j = journey(1000, 2);
    expect(j.days).toHaveLength(7);
    expect(j.tooLong).toBe(true);
    expect(j.feasible).toBe(false);
    expect(j.warnings.join(' ')).toContain('more than 7 days');
    expect(journey(1000, 8).tooLong).toBe(false);
  });

  it('never ends a day at an unverified or customers-only charger unless the driver allows it', () => {
    const shaky = stations.map((s) => (s.id === 'c380' ? { ...s, confidence: 0.3 } : s.id === 'c420' ? { ...s, access: 'customers' as const } : s));
    const strict = journey(1000, 8, places, { stations: shaky })
      .days.map((d) => d.overnight)
      .filter((o) => o !== null);
    expect(strict.map((o) => o.station.id)).not.toContain('c380');
    expect(strict.map((o) => o.station.id)).not.toContain('c420');
    expect(strict.every((o) => o.trusted)).toBe(true);
  });

  it('still splits the trip without any stay data', () => {
    const j = journey(1000, 8, null);
    expect(j.days.length).toBeGreaterThan(1);
    expect(j.days[0].night).not.toBeNull();
  });

  it('stops for the night at a roadside hotel with no charger when the car can reach a charger next morning', () => {
    const corridor = [poi('901', 440, 'hotel', 'stay', 'Highway Inn')];
    const sparse = [100, 250, 500, 650, 800].map((km) => station(`s${km}`, km));
    const j = journey(900, 8, null, { stations: sparse, corridor });
    expect(j.days.length).toBeGreaterThan(1);
    const kinds = j.days.slice(0, -1).map((d) => d.night!.kind);
    expect(kinds.every((k) => k === 'charger' || k === 'stay' || k === 'roadside')).toBe(true);
    expect(j.hasCorridor).toBe(true);
  });

  it('keeps planning every day after a gap in the chargers', () => {
    // Nothing between 300 and 700: a 400 km gap on day 1 or 2; the plan still reaches the end.
    const gappy = [100, 200, 300, 700, 800, 900, 1000, 1100].map((km) => station(`g${km}`, km));
    const j = journey(1200, 8, null, { stations: gappy });
    expect(j.gaps.length).toBeGreaterThan(0);
    expect(j.feasible).toBe(false);
    expect(j.tooLong).toBe(false);
    const last = j.days[j.days.length - 1];
    expect(last.endKm).toBeCloseTo(1200, -1);
    expect(last.items[last.items.length - 1].kind).toBe('arrive');
    expect(j.days.flatMap((d) => d.items).some((i) => i.kind === 'gap')).toBe(true);
    // Stops after the gap are planned too.
    expect(j.days.some((d) => d.plan.stops.some((s) => d.startKm + s.alongKm > 690))).toBe(true);
  });

  it('words gap warnings in whole-trip km and names the night stops, not the trip ends', () => {
    const gappy = [100, 200, 300, 700, 800, 900, 1000, 1100].map((km) => station(`g${km}`, km));
    const j = journey(1200, 8, null, { stations: gappy });
    const gapWarnings = j.warnings.filter((w) => w.includes('no confirmed car charger'));
    expect(gapWarnings.length).toBeGreaterThan(0);
    for (const g of j.gaps) expect(gapWarnings.some((w) => w.includes(`(km ${Math.round(g.fromKm)})`))).toBe(true);
    for (const d of j.days.slice(1))
      for (const g of d.plan.gaps.filter((x) => x.fromName === null))
        expect(gapWarnings.some((w) => w.includes(`last night's stop (km ${Math.round(d.startKm + g.fromKm)})`))).toBe(true);
  });

  it('never drives more than about 2 h without a rest', () => {
    const corridor = [poi('1', 110, 'fuel', 'fuel'), poi('2', 230, 'rest_area', 'rest'), poi('3', 340, 'restaurant', 'food')];
    const j = journey(1000, 10, places, { corridor });
    for (const d of j.days) for (const it of d.items) expect(it.drivenSinceRestMin).toBeLessThanOrEqual(BREAK_EVERY_MIN + BREAK_TOLERANCE_MIN + 1);
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
