import { describe, expect, it } from 'vitest';
import type { CorridorPlace, PlaceOnRoute } from '../data/corridor.ts';
import { BREAK_EVERY_MIN, BREAK_TOLERANCE_MIN, clockLabel, dayClock, kmAtTime, sameTimeLater, type DayClockInput } from './itinerary.ts';
import type { ChargeGap, Stop } from './planner.ts';

const MIN = 60_000;
const day = (h: number, m = 0) => new Date(2026, 9, 21, h, m).getTime();

const stop = (id: string, alongKm: number, chargeMinutes: number): Stop =>
  ({
    station: { id, name: `Charger ${id}` },
    alongKm,
    chargeMinutes,
    detourKm: 0,
  }) as unknown as Stop;

const poi = (id: string, km: number, cat: CorridorPlace['cat']): PlaceOnRoute =>
  ({
    alongKm: km,
    offKm: 0.1,
    place: {
      id,
      cat,
      kind: cat === 'food' ? 'restaurant' : cat === 'rest' ? 'rest_area' : cat === 'stay' ? 'hotel' : cat,
      name: `${cat} ${id}`,
      named: true,
      lat: 0,
      lng: 0,
      open24h: true,
      toilets: false,
      pureVeg: false,
    },
  }) as PlaceOnRoute;

function run(over: Partial<DayClockInput>) {
  return dayClock({
    startKm: 0,
    endKm: 300,
    departAt: day(6),
    minPerKm: 1,
    stops: [],
    gaps: [],
    pois: [],
    foodNear: () => 0,
    end: 'arrive',
    ...over,
  });
}

describe('dayClock', () => {
  it('runs the clock from departure to arrival with charge times', () => {
    const c = run({ endKm: 100, stops: [stop('a', 50, 20)] });
    expect(c.items.map((i) => i.kind)).toEqual(['depart', 'charge', 'arrive']);
    expect(c.items[1].at).toBe(day(6, 50));
    expect(c.items[1].until).toBe(day(7, 10));
    expect(c.items[2].at).toBe(day(7, 60));
    expect(c.endAt).toBe(day(8));
    expect(clockLabel(c.items[1].at)).toBe('06:50');
    for (let i = 1; i < c.items.length; i++) expect(c.items[i].at).toBeGreaterThanOrEqual(c.items[i - 1].until);
  });

  it('adds a break at least every 2 hours, at a rest area when one is mapped', () => {
    const c = run({ endKm: 400, pois: [poi('r1', 110, 'rest')] });
    const breaks = c.items.filter((i) => i.kind === 'break');
    expect(breaks.length).toBeGreaterThanOrEqual(3);
    expect(breaks[0].poi?.place.id).toBe('r1');
    expect(breaks[0].km).toBe(110);
    expect(breaks.find((b) => !b.poi)).toBeTruthy();
    for (const it of c.items) expect(it.drivenSinceRestMin).toBeLessThanOrEqual(BREAK_EVERY_MIN + BREAK_TOLERANCE_MIN);
  });

  it('counts a charging stop as the break', () => {
    const c = run({ endKm: 220, stops: [stop('a', 110, 25)] });
    expect(c.items.filter((i) => i.kind === 'break')).toHaveLength(0);
  });

  it('plans lunch between 12:30 and 14:30 at a charger with food nearby', () => {
    const c = run({
      departAt: day(10),
      endKm: 400,
      stops: [stop('a', 160, 20)],
      foodNear: () => 3,
    });
    const lunch = c.items.find((i) => i.meal === 'Lunch')!;
    expect(lunch.kind).toBe('charge');
    expect(lunch.at).toBeGreaterThanOrEqual(day(12, 30));
    expect(lunch.at).toBeLessThanOrEqual(day(14, 30));
    // A meal stop lasts at least 45 minutes even if the charge is quicker.
    expect(lunch.until - lunch.at).toBeGreaterThanOrEqual(45 * MIN);
  });

  it('plans lunch at a roadside restaurant when the charger has no food', () => {
    const c = run({
      departAt: day(11),
      endKm: 300,
      stops: [stop('a', 100, 15)],
      pois: [poi('f1', 120, 'food')],
    });
    const lunch = c.items.find((i) => i.meal === 'Lunch')!;
    expect(lunch.kind).toBe('meal');
    expect(lunch.poi?.place.id).toBe('f1');
    expect(lunch.at).toBeGreaterThanOrEqual(day(12, 30));
    expect(lunch.at).toBeLessThanOrEqual(day(14, 30));
  });

  it('plans dinner between 19:30 and 21:30, at the night stop when the day ends then', () => {
    const c = run({ departAt: day(17), endKm: 400, end: 'night' });
    const dinner = c.items.find((i) => i.meal === 'Dinner')!;
    expect(dinner).toBeTruthy();
    expect(dinner.at).toBeGreaterThanOrEqual(day(19, 30));
    expect(dinner.at).toBeLessThanOrEqual(day(21, 30));
  });

  it('puts a gap on the timeline and keeps going after it', () => {
    const gap: ChargeGap = {
      fromKm: 100,
      toKm: 400,
      fromName: 'Charger a',
      toName: 'Charger b',
      toStationId: 'b',
      unconfirmed: [],
    };
    const c = run({
      endKm: 500,
      stops: [stop('a', 100, 30), stop('b', 400, 30)],
      gaps: [gap],
    });
    const kinds = c.items.map((i) => i.kind);
    const g = kinds.indexOf('gap');
    expect(g).toBeGreaterThan(kinds.indexOf('charge'));
    expect(kinds.lastIndexOf('charge')).toBeGreaterThan(g);
    expect(kinds[kinds.length - 1]).toBe('arrive');
  });

  it('finds the km reached at a given time', () => {
    const c = run({ endKm: 100, stops: [stop('a', 50, 20)] });
    expect(kmAtTime(c, day(6, 30), 1)).toBeCloseTo(30, 5);
    expect(kmAtTime(c, day(7), 1)).toBe(50);
    expect(kmAtTime(c, day(7, 20), 1)).toBeCloseTo(60, 5);
    expect(kmAtTime(c, day(12), 1)).toBe(100);
  });

  it('keeps the time of day for the next morning', () => {
    expect(new Date(sameTimeLater(day(6, 15), 1)).getDate()).toBe(22);
    expect(clockLabel(sameTimeLater(day(6, 15), 1))).toBe('06:15');
  });
});

describe('rests', () => {
  it('makes a short top-up near the two-hour mark the rest, and never lets a meal stretch past 2 h 15', () => {
    // 116 min to a 7-minute top-up just before lunch: the top-up becomes a 15-minute rest.
    const c = run({ departAt: day(10, 30), endKm: 400, stops: [stop('a', 116, 7)], pois: [poi('r', 129, 'food')] });
    const charge = c.items.find((i) => i.kind === 'charge')!;
    expect(charge.until - charge.at).toBe(15 * MIN);
    for (const it of c.items) expect(it.drivenSinceRestMin).toBeLessThanOrEqual(BREAK_EVERY_MIN + BREAK_TOLERANCE_MIN);
  });

  it("doesn't rest and then eat straight after", () => {
    // Dinner at the destination looks possible until the rests on the way are counted.
    const pois = [111, 234, 275, 405, 452, 519, 624].map((km) => poi(`f${km}`, km, 'food')).concat([poi('fuel', 633, 'fuel')]);
    const c = run({ departAt: day(7, 12), endKm: 712, minPerKm: 1.01, pois: pois.sort((a, b) => a.alongKm - b.alongKm) });
    c.items.forEach((it, k) => {
      if (k > 0 && it.kind === 'meal') expect(c.items[k - 1].kind === 'break' && it.at - c.items[k - 1].until < 10 * MIN).toBe(false);
    });
    expect(c.items.some((it) => it.meal === 'Dinner')).toBe(true);
  });
});
