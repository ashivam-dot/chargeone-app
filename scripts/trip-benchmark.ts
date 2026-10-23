/**
 * Trip-planning benchmark: runs today's planner on real Indian EV road trips.
 *
 * Read-only against app code: it imports the planner, the station index and places.json and
 * writes only results under research/ and cached routes under scripts/trip-benchmark-routes/.
 *
 * Routes come from FOSSGIS Valhalla (same request shape as worker/routing.ts, with maneuvers for the
 * drive-time correction) and are cached to scripts/trip-benchmark-routes/maneuvers/<id>.json. Older
 * caches without maneuvers (scripts/trip-benchmark-routes/<id>.json) are used when that is all there
 * is, with Valhalla's uncorrected time. A cached route is never refetched. Fetching is opt-in:
 *
 *   npx esbuild scripts/trip-benchmark.ts --bundle --platform=node --format=esm --outfile=/tmp/trip-benchmark.mjs
 *   node /tmp/trip-benchmark.mjs            # offline: uses cached routes only, skips missing ones
 *   node /tmp/trip-benchmark.mjs --fetch    # fetch missing routes (1 req / 1.2 s, max 20 per run)
 *
 * Output: research/trip-planning-audit-2026-10-23/benchmark.json (override with --out <file>).
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { decodeIndex } from '../src/data/compact.ts';
import { forCars } from '../src/data/filters.ts';
import type { PlacesData } from '../src/data/places.ts';
import { CORRIDOR_SCHEMA, cellsAlongRoute, decodeCell, type CorridorIndex, type CorridorPlace } from '../src/data/corridor.ts';
import { planTrip, findCandidates, DEFAULT_OPTIONS, type Candidate, type PlanInput, type TripPlan } from '../src/planner/planner.ts';
import { planJourney, staysNearDestination, type Journey } from '../src/planner/journey.ts';
import { clockLabel } from '../src/planner/itinerary.ts';
import { RouteIndex, type RouteGeometry } from '../src/planner/geometry.ts';
import { VEHICLES, myVehicleFromModel } from '../src/shared/vehicles.ts';
import { parseValhalla } from '../worker/valhalla.ts';

const args = process.argv.slice(2);
const flag = (name: string) => args.includes(name);
const opt = (name: string) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};

// Repo root: --repo, else the cwd if it looks like the repo, else relative to this file.
const here = (() => {
  try {
    return dirname(fileURLToPath(import.meta.url));
  } catch {
    return process.cwd();
  }
})();
const REPO = resolve(
  opt('--repo') ?? (existsSync(join(process.cwd(), 'public/data/index.json')) ? process.cwd() : join(here, '..')),
);
const ROUTES_DIR = join(REPO, 'scripts/trip-benchmark-routes');
const OUT = resolve(opt('--out') ?? join(REPO, 'research/trip-planning-audit-2026-10-23/benchmark.json'));
const VALHALLA_URL = 'https://valhalla1.openstreetmap.de/route';
const USER_AGENT = 'ChargeOne/0.2 (+https://chargeone.akshshivam5.workers.dev; EV trip planner for India)';
const MAX_FETCHES = 20;

type Pt = { name: string; lat: number; lng: number };
interface BenchRoute {
  id: string;
  name: string;
  points: Pt[];
}

// City-centre coordinates (approximate, public knowledge). Via points make multi-city trips.
const P = {
  mumbai: { name: 'Mumbai', lat: 19.076, lng: 72.8777 },
  pune: { name: 'Pune', lat: 18.5204, lng: 73.8567 },
  delhi: { name: 'Delhi', lat: 28.6139, lng: 77.209 },
  jaipur: { name: 'Jaipur', lat: 26.9124, lng: 75.7873 },
  bengaluru: { name: 'Bengaluru', lat: 12.9716, lng: 77.5946 },
  chennai: { name: 'Chennai', lat: 13.0827, lng: 80.2707 },
  mysuru: { name: 'Mysuru', lat: 12.2958, lng: 76.6394 },
  panaji: { name: 'Panaji (Goa)', lat: 15.4909, lng: 73.8278 },
  chandigarh: { name: 'Chandigarh', lat: 30.7333, lng: 76.7794 },
  manali: { name: 'Manali', lat: 32.2432, lng: 77.1892 },
  ahmedabad: { name: 'Ahmedabad', lat: 23.0225, lng: 72.5714 },
  hyderabad: { name: 'Hyderabad', lat: 17.385, lng: 78.4867 },
  agra: { name: 'Agra', lat: 27.1767, lng: 78.0081 },
  lucknow: { name: 'Lucknow', lat: 26.8467, lng: 80.9462 },
  pondicherry: { name: 'Puducherry', lat: 11.9416, lng: 79.8083 },
  nadiad: { name: 'Nadiad', lat: 22.69, lng: 72.86 },
  hyderabadLead: { name: 'Hyderabad', lat: 17.35, lng: 78.47 },
  kolkata: { name: 'Kolkata', lat: 22.5726, lng: 88.3639 },
  bhubaneswar: { name: 'Bhubaneswar', lat: 20.2961, lng: 85.8245 },
} satisfies Record<string, Pt>;

export const ROUTES: BenchRoute[] = [
  { id: 'mumbai-pune', name: 'Mumbai - Pune', points: [P.mumbai, P.pune] },
  { id: 'delhi-jaipur', name: 'Delhi - Jaipur', points: [P.delhi, P.jaipur] },
  { id: 'bengaluru-chennai', name: 'Bengaluru - Chennai', points: [P.bengaluru, P.chennai] },
  { id: 'bengaluru-mysuru', name: 'Bengaluru - Mysuru', points: [P.bengaluru, P.mysuru] },
  { id: 'mumbai-goa', name: 'Mumbai - Goa (Panaji)', points: [P.mumbai, P.panaji] },
  { id: 'delhi-chandigarh-manali', name: 'Delhi - Chandigarh - Manali', points: [P.delhi, P.chandigarh, P.manali] },
  { id: 'ahmedabad-mumbai', name: 'Ahmedabad - Mumbai', points: [P.ahmedabad, P.mumbai] },
  { id: 'hyderabad-bengaluru', name: 'Hyderabad - Bengaluru', points: [P.hyderabad, P.bengaluru] },
  { id: 'delhi-agra-lucknow', name: 'Delhi - Agra - Lucknow', points: [P.delhi, P.agra, P.lucknow] },
  { id: 'chennai-pondicherry', name: 'Chennai - Puducherry', points: [P.chennai, P.pondicherry] },
  // Reuses the lead agent's cached route (22.69,72.86 -> 17.35,78.47).
  { id: 'nadiad-hyderabad', name: 'Nadiad - Hyderabad', points: [P.nadiad, P.hyderabadLead] },
  { id: 'kolkata-bhubaneswar', name: 'Kolkata - Bhubaneswar', points: [P.kolkata, P.bhubaneswar] },
];

const CARS = ['tata-nexon-ev-45', 'tata-tiago-ev-24'];
const DAILY_HOURS = 8;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const r1 = (n: number) => Math.round(n * 10) / 10;

async function loadRoute(r: BenchRoute, allowFetch: boolean, budget: { left: number }) {
  const legacy = join(ROUTES_DIR, `${r.id}.json`);
  const withManeuvers = join(ROUTES_DIR, 'maneuvers', `${r.id}.json`);
  const file = existsSync(withManeuvers) || !existsSync(legacy) ? withManeuvers : legacy;
  if (!existsSync(file)) {
    if (!allowFetch) return { missing: true as const, file };
    if (budget.left <= 0) return { missing: true as const, file };
    budget.left--;
    await sleep(1200); // FOSSGIS: low volume, at most 1 request per second
    const res = await fetch(VALHALLA_URL, {
      method: 'POST',
      headers: { 'User-Agent': USER_AGENT, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        locations: r.points.map((p) => ({ lat: p.lat, lon: p.lng, type: 'break' })),
        costing: 'auto',
        units: 'kilometers',
        directions_type: 'maneuvers',
        shape_format: 'polyline6',
      }),
    });
    const body = await res.json();
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify({ status: res.status, fetchedAt: new Date().toISOString(), points: r.points, body }));
    console.error(`fetched ${r.id}: HTTP ${res.status}`);
  }
  const cached = JSON.parse(readFileSync(file, 'utf8'));
  return { missing: false as const, file, route: parseValhalla(cached.status, cached.body) };
}

/** Largest stretch with no usable charger: start, each usable charger and the destination are the anchors. */
function largestGap(cands: Candidate[], totalKm: number) {
  const anchors = [0, ...cands.map((c) => c.alongKm), totalKm].sort((a, b) => a - b);
  let gap = 0;
  let at = 0;
  for (let i = 1; i < anchors.length; i++) {
    const d = anchors[i] - anchors[i - 1];
    if (d > gap) {
      gap = d;
      at = anchors[i - 1];
    }
  }
  return { gapKm: r1(gap), fromKm: r1(at), toKm: r1(at + gap) };
}

function summarisePlan(p: TripPlan) {
  return {
    feasible: p.feasible,
    stops: p.stops.length,
    gapAtKm: p.gapAtKm === null ? null : r1(p.gapAtKm),
    arrivalSocPct: p.arrivalSocPct,
    chargeMinutes: Math.round(p.chargeMinutes),
    driveMinutes: Math.round(p.driveMinutes),
    stopDetail: p.stops.map((s) => ({
      km: r1(s.alongKm),
      station: s.station.name,
      mode: s.mode,
      powerKw: s.powerKw,
      arrive: s.arriveSocPct,
      depart: s.departSocPct,
      trusted: s.trusted,
      backups: s.backups.length,
    })),
    extras: p.extras.length,
    extrasFeasible: p.extrasFeasible,
    warnings: p.warnings,
  };
}

function summariseJourney(j: Journey) {
  // Every day but the last ends with a night: at a charger, at a roadside hotel, or "around km X".
  const nights = j.days.filter((d) => d.night);
  return {
    feasible: j.feasible,
    days: j.days.length,
    nights: nights.length,
    nightsAtCharger: nights.filter((d) => d.overnight).length,
    nightsWithStay: nights.filter((d) => (d.night?.stays.length ?? 0) > 0).length,
    nightsWithFood: nights.filter((d) => (d.night?.food.length ?? 0) > 0).length,
    stopCount: j.stopCount,
    tooLong: j.tooLong,
    // Clock checks: longest drive without a rest (min), latest night arrival (HH:MM), longest day at the wheel (min).
    maxDriveSinceRestMin: Math.max(0, ...j.days.flatMap((d) => d.items.map((i) => i.drivenSinceRestMin))),
    latestNightArrival: j.days
      .filter((d) => d.night)
      .map((d) => clockLabel(d.arriveAt))
      .sort()
      .pop() ?? null,
    longestDayDriveMin: Math.max(0, ...j.days.map((d) => d.driveMinutes)),
    clockOrdered: j.days.every((d) => d.items.every((it, k) => k === 0 || (it.at >= d.items[k - 1].until - 1000 && it.km >= d.items[k - 1].km - 0.01))),
    dayDetail: j.days.map((d) => ({
      fromKm: r1(d.startKm),
      toKm: r1(d.endKm),
      feasible: d.plan.feasible,
      stops: d.plan.stops.length,
      gapAtKm: d.plan.gapAtKm === null ? null : r1(d.startKm + d.plan.gapAtKm),
      // The day on the clock, one line per row the app shows.
      timeline: d.items.map((it) => {
        const stop = it.stopIndex !== undefined ? d.plan.stops[it.stopIndex] : null;
        const what = stop
          ? `charge at ${stop.station.name} (${stop.mode.toUpperCase()} ${stop.powerKw} kW) ${stop.arriveSocPct}%->${stop.departSocPct}%`
          : it.poi
            ? `${it.poi.place.cat} ${it.poi.place.name}`
            : it.gap
              ? `no confirmed charger for ${Math.round(it.gap.toKm - it.gap.fromKm)} km`
              : '';
        const span = it.until > it.at + 60_000 ? `${clockLabel(it.at)}-${clockLabel(it.until)}` : clockLabel(it.at);
        return `${span} ${it.kind}${it.meal ? ` (${it.meal})` : ''} km ${Math.round(it.km)} ${what}`.trim();
      }),
      night: d.night ? { kind: d.night.kind, name: d.night.name, km: d.night.alongKm, stays: d.night.stays.length, food: d.night.food.length } : null,
      overnight: d.overnight
        ? { station: d.overnight.station.name, km: d.overnight.alongKm, stays: d.overnight.stays.length, food: d.overnight.food.length, morningSocPct: d.overnight.morningSocPct }
        : null,
    })),
    warnings: j.warnings,
  };
}

async function main() {
  const allStations = decodeIndex(JSON.parse(readFileSync(join(REPO, 'public/data/index.json'), 'utf8')));
  const stations = forCars(allStations);
  let places: PlacesData | null = null;
  try {
    places = JSON.parse(readFileSync(join(REPO, 'public/data/places.json'), 'utf8'));
  } catch {
    places = null;
  }
  // Roadside stays, food, fuel and rest areas (public/data/corridor), as the app loads them for a route.
  let corridorIndex: CorridorIndex | null = null;
  try {
    const idx = JSON.parse(readFileSync(join(REPO, 'public/data/corridor/index.json'), 'utf8')) as CorridorIndex;
    corridorIndex = idx.schema === CORRIDOR_SCHEMA && idx.cells ? idx : null;
  } catch {
    corridorIndex = null;
  }
  const corridorFor = (coords: RouteGeometry['coords']): CorridorPlace[] =>
    corridorIndex
      ? cellsAlongRoute(coords, Object.keys(corridorIndex.cells)).flatMap((cell) =>
          decodeCell(JSON.parse(readFileSync(join(REPO, `public/data/corridor/${cell}.json`), 'utf8'))),
        )
      : [];
  const now = new Date();
  const budget = { left: MAX_FETCHES };
  const results: unknown[] = [];
  const skipped: string[] = [];

  for (const r of ROUTES) {
    const loaded = await loadRoute(r, flag('--fetch'), budget);
    if (loaded.missing) {
      skipped.push(r.id);
      console.error(`skip ${r.id}: no cached route (${loaded.file}); rerun with --fetch`);
      continue;
    }
    const route = loaded.route;
    const index = new RouteIndex(route.coords);
    const totalKm = index.lengthKm || route.distanceKm;
    const dest = r.points[r.points.length - 1];
    const corridor = corridorFor(route.coords);

    for (const carId of CARS) {
      const model = VEHICLES.find((v) => v.id === carId);
      if (!model) throw new Error(`unknown vehicle ${carId}`);
      const vehicle = myVehicleFromModel(model);
      const input: PlanInput = { route, stations, statuses: new Map(), vehicle, options: DEFAULT_OPTIONS, now };
      const loose = { ...DEFAULT_OPTIONS, allowUnverified: true };

      const c3 = findCandidates(index, input, 3);
      const c8 = findCandidates(index, input, 8);
      const per100: Record<string, { all: number; trusted: number }> = {};
      for (let b = 0; b < totalKm; b += 100) per100[String(b)] = { all: 0, trusted: 0 };
      for (const c of c8) {
        const b = String(Math.floor(c.alongKm / 100) * 100);
        per100[b] ??= { all: 0, trusted: 0 };
        per100[b].all++;
        if (c.trusted) per100[b].trusted++;
      }

      const strict = planTrip(input);
      const looseP = planTrip({ ...input, options: loose });
      const jStrict = planJourney({ ...input, dailyHours: DAILY_HOURS, places, corridor });
      const jLoose = planJourney({ ...input, options: loose, dailyHours: DAILY_HOURS, places, corridor });
      // What a Free-plan user gets: TripPlanner passes dailyHours 0 when plan.multiDay is false.
      const jFree = planJourney({ ...input, dailyHours: 0, places, corridor });

      results.push({
        route: r.id,
        name: r.name,
        points: r.points,
        car: carId,
        batteryKwh: vehicle.batteryKwh,
        routeKm: r1(totalKm),
        routeDriveHours: r1(route.durationMin / 60),
        chargers: {
          within3km: c3.length,
          within3kmTrusted: c3.filter((c) => c.trusted).length,
          within8km: c8.length,
          within8kmTrusted: c8.filter((c) => c.trusted).length,
          within8kmDc: c8.filter((c) => c.mode === 'dc').length,
          per100kmWithin8km: per100,
        },
        // "Usable" = what the loose planner may stop at (tier < 3: DC, no reported problem); "trusted" = strict planner.
        largestGapUsable8km: largestGap(c8.filter((c) => c.tier < 3), totalKm),
        largestGapTrusted8km: largestGap(c8.filter((c) => c.trusted), totalKm),
        strictPlan: summarisePlan(strict),
        loosePlan: summarisePlan(looseP),
        journey8hStrict: summariseJourney(jStrict),
        journey8hLoose: summariseJourney(jLoose),
        freePlanSingleDay: { feasible: jFree.feasible, days: jFree.days.length, stops: jFree.stopCount },
        staysNearDestination15km: staysNearDestination({ stations, places }, dest).length,
      });
    }
  }

  const out = {
    generatedAt: now.toISOString(),
    harness: 'scripts/trip-benchmark.ts',
    data: {
      stationsInIndex: allStations.length,
      carUsableStations: stations.length,
      placesLoaded: Boolean(places),
      places: places?.places.length ?? 0,
      stationsWithNearbyPlaces: places ? Object.keys(places.near ?? {}).length : 0,
    },
    options: { ...DEFAULT_OPTIONS, dailyHours: DAILY_HOURS, cars: CARS },
    definitions: {
      within3km_8km: 'findCandidates(): stations compatible with the car (chargeOption), straight-line off-route distance <= N km',
      trusted: 'isTrusted(): DC (or AC-only car), plug verified, trust >= PLAN_MIN_CONFIDENCE, not customers-only, no problem report',
      largestGap: 'longest stretch along the route between consecutive chargers within 8 km (route start and end count as anchors)',
      strictPlan: 'planTrip() with DEFAULT_OPTIONS (what the app plans by default)',
      loosePlan: 'planTrip() with allowUnverified: true',
      journey8h: 'planJourney() dailyHours 8 with places.json (and the corridor places; nights = every night stop (charger, roadside hotel or around km X), nightsWithStay = nights with >=1 stay listed)',
      freePlanSingleDay: 'planJourney() dailyHours 0 (Free plan has multiDay=false)',
    },
    skippedRoutes: skipped,
    results,
  };
  mkdirSync(dirname(OUT), { recursive: true });
  writeFileSync(OUT, JSON.stringify(out, null, 2));
  console.log(`wrote ${OUT}: ${results.length} route x car results, skipped ${skipped.length}`);
  for (const x of results as any[]) {
    console.log(
      [
        x.route.padEnd(24),
        x.car.padEnd(17),
        `${x.routeKm}km`.padEnd(9),
        `c3=${x.chargers.within3km} c8=${x.chargers.within8km} t8=${x.chargers.within8kmTrusted}`.padEnd(20),
        `gap=${x.largestGapUsable8km.gapKm}@${x.largestGapUsable8km.fromKm}`.padEnd(16),
        `strict=${x.strictPlan.feasible ? 'OK' : 'FAIL@' + x.strictPlan.gapAtKm}/${x.strictPlan.stops}`.padEnd(18),
        `loose=${x.loosePlan.feasible ? 'OK' : 'FAIL@' + x.loosePlan.gapAtKm}/${x.loosePlan.stops}`.padEnd(18),
        `j8=${x.journey8hLoose.days}d n${x.journey8hLoose.nights} chg${x.journey8hLoose.nightsAtCharger} stay${x.journey8hLoose.nightsWithStay} ${x.journey8hLoose.feasible ? 'OK' : 'FAIL'}`,
      ].join(' '),
    );
  }
}

await main();
