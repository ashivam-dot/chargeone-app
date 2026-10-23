// The clock side of a trip: when the driver leaves, reaches each charger and leaves it, where they
// rest, eat and stop for the night. Pure functions over a day's charging plan, so they are cheap to
// re-run while the night stop is being chosen.
import type { PlaceOnRoute } from '../data/corridor.ts';
import type { ChargeGap, Stop } from './planner.ts';

export type ItemKind = 'depart' | 'charge' | 'break' | 'meal' | 'gap' | 'night' | 'arrive';
export type MealName = 'Lunch' | 'Dinner';

export interface ItineraryItem {
  kind: ItemKind;
  /** Km along the whole route. */
  km: number;
  /** Arrival time, ms since the epoch. */
  at: number;
  /** Leaving time; the same as `at` for the start, the end and gaps. */
  until: number;
  /** Driving since the last rest when this item is reached, in minutes. */
  drivenSinceRestMin: number;
  /** Index into the day's plan.stops (charge items). */
  stopIndex?: number;
  /** A meal taken here: at a charger with food nearby, or at the night's stay. */
  meal?: MealName;
  /** The roadside place for a break or meal; null when none is mapped there. */
  poi?: PlaceOnRoute | null;
  /** Gap items: the stretch, in whole-route km. */
  gap?: ChargeGap;
}

export interface DayClock {
  items: ItineraryItem[];
  /** Minutes at the wheel. */
  driveMinutes: number;
  endAt: number;
}

export interface DayClockInput {
  /** Where the day starts and ends along the whole route, km. */
  startKm: number;
  endKm: number;
  departAt: number;
  minPerKm: number;
  /** The day's charging stops; their alongKm is relative to startKm. */
  stops: Stop[];
  /** The day's gaps, relative to startKm. */
  gaps: ChargeGap[];
  /** Roadside places along the whole route (rest, fuel, toilets, food, stays), in driving order. */
  pois: PlaceOnRoute[];
  /** Places to eat near a charger: a meal is only planned at a charger that has some. */
  foodNear: (stop: Stop) => number;
  end: 'night' | 'arrive';
}

const MIN = 60_000;
/** Drive at most this long without a rest... */
export const BREAK_EVERY_MIN = 120;
/** ...give or take this much, to reach a charger or a proper rest area. */
export const BREAK_TOLERANCE_MIN = 15;
const BREAK_MIN = 15;
const MEAL_MIN = 45;
/** A charging stop at least this long is also a rest. */
const STOP_IS_REST_MIN = 10;
/** Minutes per km of detour to a charger off the route, each way. */
const DETOUR_MIN_PER_KM = 1.5;

export const LUNCH = { name: 'Lunch' as const, from: [12, 30], to: [14, 30] };
export const DINNER = { name: 'Dinner' as const, from: [19, 30], to: [21, 30] };

interface MealWindow {
  name: MealName;
  start: number;
  end: number;
  done: boolean;
}

function at(base: number, dayOffset: number, [h, m]: number[]): number {
  const d = new Date(base);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() + dayOffset, h, m).getTime();
}

function mealWindows(departAt: number): MealWindow[] {
  const out: MealWindow[] = [];
  for (let d = 0; d < 3; d++) {
    for (const w of [LUNCH, DINNER])
      out.push({
        name: w.name,
        start: at(departAt, d, w.from),
        end: at(departAt, d, w.to),
        done: false,
      });
  }
  return out.filter((w) => w.end > departAt);
}

/** "06:05": 24-hour local time. */
export function clockLabel(ms: number): string {
  const d = new Date(ms);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

/** The same local time of day on the date `days` later. */
export function sameTimeLater(ms: number, days: number): number {
  const d = new Date(ms);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() + days, d.getHours(), d.getMinutes()).getTime();
}

/** The local time `hh:mm` on the day of `ms`. */
export function timeOnDay(ms: number, [h, m]: number[]): number {
  return at(ms, 0, [h, m]);
}

const REST_RANK: Record<string, number> = {
  rest: 0,
  fuel: 1,
  toilets: 2,
  food: 3,
};

/** Places in [fromKm, toKm] of the given categories. */
function poisBetween(pois: PlaceOnRoute[], fromKm: number, toKm: number, cats: string[]): PlaceOnRoute[] {
  return pois.filter((p) => p.alongKm >= fromKm && p.alongKm <= toKm && cats.includes(p.place.cat));
}

/**
 * Lays a day's charging plan on the clock: a rest at least every two hours (a charging stop counts,
 * and a break moves a little to reach one), lunch and dinner in their windows at a charger with food
 * nearby or a roadside restaurant, and the gaps where no confirmed charger is in reach.
 */
export function dayClock(input: DayClockInput): DayClock {
  const { startKm, endKm, minPerKm, pois } = input;
  const items: ItineraryItem[] = [];
  const meals = mealWindows(input.departAt);
  let pos = startKm;
  let t = input.departAt;
  let since = 0;
  const drive = (km: number) => Math.max(0, km - pos) * minPerKm;
  const kmAfter = (minutes: number) => pos + Math.max(0, minutes) / minPerKm;
  const move = (km: number) => {
    since += drive(km);
    t += drive(km) * MIN;
    pos = Math.max(pos, km);
  };
  items.push({
    kind: 'depart',
    km: startKm,
    at: t,
    until: t,
    drivenSinceRestMin: 0,
  });

  const targets = [
    ...input.stops.map((s, i) => ({
      km: startKm + s.alongKm,
      stop: s as Stop | null,
      stopIndex: i,
    })),
    { km: endKm, stop: null, stopIndex: -1 },
  ];
  for (const target of targets) {
    const food = target.stop ? input.foodNear(target.stop) : 1;
    for (let guard = 0; guard < 60; guard++) {
      const arrive = t + drive(target.km) * MIN;
      // Meals whose window has passed while charging or driving are dropped.
      for (const m of meals) if (!m.done && t > m.end - MEAL_MIN * MIN) m.done = true;
      const meal = meals.find((m) => !m.done);
      // The rests still due on the way push the arrival later; a meal only waits for the target if it's still in time then.
      const restsOnWay = Math.max(0, Math.ceil((since + drive(target.km) - BREAK_EVERY_MIN - BREAK_TOLERANCE_MIN) / BREAK_EVERY_MIN));
      const arriveAfterRests = arrive + restsOnWay * BREAK_MIN * MIN;
      const mergeMeal = meal && arrive >= meal.start && arriveAfterRests <= meal.end - 30 * MIN && food > 0 ? meal : null;
      let mealKm: number | null = null;
      let mealPoi: PlaceOnRoute | null = null;
      if (meal && !mergeMeal && meal.start < arrive) {
        const first = kmAfter((meal.start - t) / MIN);
        let last = Math.min(target.km - 0.5, kmAfter((meal.end - MEAL_MIN * MIN - t) / MIN));
        // Eat by the time a rest is due, when the window allows, rather than rest and then eat straight after.
        const restDue = kmAfter(BREAK_EVERY_MIN + BREAK_TOLERANCE_MIN - since);
        if (restDue >= first) last = Math.min(last, restDue);
        if (last >= first) {
          mealPoi = poisBetween(pois, first, last, ['food'])[0] ?? null;
          mealKm = mealPoi?.alongKm ?? Math.min(last, kmAfter((meal.start - t) / MIN + 30));
          // No restaurant before the charger and still time after it: eat after charging instead.
          const leaveTarget = arrive + (target.stop ? target.stop.chargeMinutes * MIN : 0);
          if (!mealPoi && target.stop && leaveTarget <= meal.end - MEAL_MIN * MIN - 30 * MIN) mealKm = null;
        }
      }
      const breakKm = kmAfter(BREAK_EVERY_MIN - since);
      const reachTarget = since + drive(target.km) <= BREAK_EVERY_MIN + BREAK_TOLERANCE_MIN;
      if (reachTarget && (mealKm === null || mealKm >= target.km)) {
        move(target.km);
        if (target.stop) {
          const s = target.stop;
          const charge = s.chargeMinutes + s.detourKm * 2 * DETOUR_MIN_PER_KM;
          // Near the two-hour mark a short top-up also becomes the rest, so no break follows right after it.
          const rest = since >= BREAK_EVERY_MIN - 30 ? BREAK_MIN : 0;
          const stay = Math.max(charge, mergeMeal ? MEAL_MIN : 0, rest);
          if (mergeMeal) mergeMeal.done = true;
          items.push({
            kind: 'charge',
            km: target.km,
            at: t,
            until: t + stay * MIN,
            drivenSinceRestMin: Math.round(since),
            stopIndex: target.stopIndex,
            meal: mergeMeal?.name,
          });
          t += stay * MIN;
          if (stay >= STOP_IS_REST_MIN) since = 0;
        } else {
          // The day ends here: lunch at the destination if it's lunchtime, dinner wherever the night is.
          const endMeal = mergeMeal ?? (input.end === 'night' ? (meals.find((m) => !m.done && m.name === 'Dinner' && m.end > t) ?? null) : null);
          if (endMeal) endMeal.done = true;
          items.push({
            kind: input.end,
            km: target.km,
            at: t,
            until: t,
            drivenSinceRestMin: Math.round(since),
            meal: endMeal?.name,
          });
        }
        break;
      }
      if (mealKm !== null && mealKm <= kmAfter(BREAK_EVERY_MIN + BREAK_TOLERANCE_MIN - since)) {
        move(mealKm);
        meal!.done = true;
        items.push({
          kind: 'meal',
          km: pos,
          at: t,
          until: t + MEAL_MIN * MIN,
          drivenSinceRestMin: Math.round(since),
          meal: meal!.name,
          poi: mealPoi,
        });
        t += MEAL_MIN * MIN;
        since = 0;
        continue;
      }
      // A rest: a proper rest area or fuel station in the half hour before it's due, else "around km X".
      const options = poisBetween(pois, Math.max(pos + 1, kmAfter(BREAK_EVERY_MIN - 30 - since)), Math.min(breakKm, target.km - 1), [
        'rest',
        'fuel',
        'toilets',
        'food',
      ]);
      const poi = options.sort((a, b) => REST_RANK[a.place.cat] - REST_RANK[b.place.cat] || b.alongKm - a.alongKm)[0] ?? null;
      move(Math.min(poi?.alongKm ?? breakKm, target.km - 0.5));
      items.push({
        kind: 'break',
        km: pos,
        at: t,
        until: t + BREAK_MIN * MIN,
        drivenSinceRestMin: Math.round(since),
        poi,
      });
      t += BREAK_MIN * MIN;
      since = 0;
    }
  }

  for (const g of input.gaps) {
    const gap = { ...g, fromKm: startKm + g.fromKm, toKm: startKm + g.toKm };
    let i = items.length - 1;
    while (i > 0 && items[i].km > gap.fromKm + 0.5) i--;
    if (items[i].kind === 'night' || items[i].kind === 'arrive') i--;
    const when = items[i].until;
    items.splice(i + 1, 0, {
      kind: 'gap',
      km: gap.fromKm,
      at: when,
      until: when,
      drivenSinceRestMin: 0,
      gap,
    });
  }

  return { items, driveMinutes: (endKm - startKm) * minPerKm, endAt: t };
}

/** Km along the route where the clock reaches `time`, on a day's timeline (the end if it never does). */
export function kmAtTime(clock: DayClock, time: number, minPerKm: number): number {
  const { items } = clock;
  for (let i = 0; i < items.length; i++) {
    const it = items[i];
    if (time <= it.at) {
      const prev = items[i - 1];
      if (!prev) return it.km;
      return Math.min(it.km, prev.km + Math.max(0, time - prev.until) / MIN / minPerKm);
    }
    if (time <= it.until) return it.km;
  }
  return items[items.length - 1].km;
}
