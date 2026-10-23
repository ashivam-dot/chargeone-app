import { BedDouble, BellRing, Bookmark, BookmarkCheck, Car, ChevronDown, Gauge, Lightbulb, Moon, Navigation, SlidersHorizontal, Split, Utensils, X, Zap } from 'lucide-preact';
import type { ComponentChildren } from 'preact';
import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import type { Station } from '../data/model.ts';
import type { Place, PlacesData } from '../data/places.ts';
import { ApiError, api, currentPosition, type Me, type RouteResponse } from '../lib/api.ts';
import { formatDate } from '../lib/format.ts';
import { loadPlaces } from '../lib/places.ts';
import { loadSavedTrips, removeSavedTrip, saveTrip, type SavedTrip } from '../lib/savedTrips.ts';
import { isObject, loadJson, saveJson } from '../lib/storage.ts';
import type { StopMarker } from '../map/MapView.tsx';
import type { Coord } from '../planner/geometry.ts';
import { nearbyPlaces, planJourney, staysNearDestination, type DayPlan, type Journey } from '../planner/journey.ts';
import { DEFAULT_OPTIONS, navigationUrl, planTrip, type DrivingStyle, type PlanOptions, type TripPlan } from '../planner/planner.ts';
import { TAG_LABEL, compareRoutes, type RouteAnalysis, type RouteCandidate } from '../planner/routeCompare.ts';
import { BASIC, FREE_TRIP_KM, PLANS, REPLAN_WINDOW_HOURS, TRIAL_DAYS, cheapestWith, formatRupees, type Perk, type Plan, type PlanId } from '../shared/plans.ts';
import { LIVE_COLOUR, LIVE_LABEL, liveState, timeAgo, type StationStatus } from '../shared/status.ts';
import type { MyVehicle } from '../shared/vehicles.ts';
import { PlaceList } from './NearbyPlaces.tsx';
import { PerkLock } from './PerkLock.tsx';
import { PlaceInput, type PickedPlace } from './PlaceInput.tsx';
import type { Paywall } from './Plans.tsx';
import { Sheet } from './Sheet.tsx';

export interface TripView {
  route: Coord[];
  altRoutes: Coord[][];
  markers: StopMarker[];
  /** Ids of overnight and destination stays to show on the map. */
  placeIds: string[];
  bbox: [number, number, number, number];
}

interface Props {
  stations: Station[];
  /** The charger list: a plan made before it loads would find no chargers and still use up a trip. */
  dataState?: 'loading' | 'ready' | 'failed';
  onRetryData?: () => void;
  statuses: Map<string, StationStatus>;
  vehicle: MyVehicle | null;
  me: Me | null;
  /** The current plan, or the last known one while offline. */
  planId: PlanId;
  initialTo: PickedPlace | null;
  initialFrom?: PickedPlace | null;
  initialSoc?: number | null;
  /** Plan straight away when both ends are given, e.g. after a voice request. */
  autoRun?: boolean;
  onClose: () => void;
  onStartDrive?: (drive: DriveRequest) => void;
  /** A new plan is on screen; voice and the copilot use it. */
  onPlanned?: (plan: PlannedTrip) => void;
  onNeedVehicle: () => void;
  onRequireSignIn: () => void;
  /** Sign-in works on this server; until it does, guests aren't offered it. */
  signInReady: boolean;
  /** Offered when a guest reaches a Basic limit. */
  onStartTrial?: () => void;
  onPaywall: (reason: Paywall) => void;
  onPlans: () => void;
  onShow: (view: TripView | null) => void;
  onSelectStation: (id: string) => void;
  onOpenPlace: (place: Place) => void;
  onUsageChanged: () => void;
}

/** A Basic limit a guest reached, with the server's exact reason. */
interface GuestLimit {
  code: 'too_long' | 'daily_limit';
  message: string;
}

/** The server's reason, in words that say what still works. */
function tripError(e: unknown): string {
  if (!(e instanceof ApiError)) return 'Could not plan this trip.';
  if (e.code === 'not_configured') return "Trip planning isn't switched on yet. The charger map and live status still work.";
  if (e.code === 'device_required') return "This browser didn't keep ChargeOne's app id. Allow site storage, or leave private browsing, and try again.";
  return e.message;
}

interface Result {
  response: RouteResponse;
  journey: Journey;
  places: PlacesData | null;
  destStays: ReturnType<typeof staysNearDestination>;
  tip: string | null;
  from: Point;
  to: Point;
  plannedAt: Date;
  /** When this trip was first planned; re-plans keep it, and it starts the free re-plan window. */
  startedAt: Date;
  /** Set when the result was opened from a saved trip rather than planned now. */
  savedAt: string | null;
  /** Every road route planned for this trip with its comparison; `active` is the one shown. */
  routes: Array<{ candidate: RouteCandidate; analysis: RouteAnalysis; destStays: Result['destStays']; tip: string | null; fullWorks: boolean }>;
  active: number;
  /** The driver asked to plan at unverified chargers too (for this trip only). */
  unverified: boolean;
}

export type Point = { name: string; lat: number; lng: number };

export interface PlannedTrip {
  journey: Journey;
  from: Point;
  to: Point;
}

/** Everything live drive mode needs about the trip on screen. */
export interface DriveRequest {
  route: Coord[];
  durationMin: number;
  journey: Journey;
  from: Point;
  to: Point;
  options: PlanOptions;
}

const MULTI_DAY_LABEL = 'Multi-day trips with a hotel and overnight charging';

const DAILY_HOURS = [0, 4, 6, 8, 10, 12];
const DEFAULT_DAILY_HOURS = 8;

const isOptions = (v: unknown): v is PlanOptions => isObject(v) && typeof v.startSocPct === 'number' && typeof v.style === 'string';
const isDailyHours = (v: unknown): v is number => typeof v === 'number' && DAILY_HOURS.includes(v);

function hm(minutes: number): string {
  const h = Math.floor(minutes / 60);
  const m = Math.round(minutes % 60);
  return h ? `${h} h ${m.toString().padStart(2, '0')} min` : `${m} min`;
}

function bboxOf(coords: Coord[]): [number, number, number, number] {
  let [x1, y1, x2, y2] = [180, 90, -180, -90];
  for (const [x, y] of coords) {
    x1 = Math.min(x1, x);
    y1 = Math.min(y1, y);
    x2 = Math.max(x2, x);
    y2 = Math.max(y2, y);
  }
  return [x1, y1, x2, y2];
}

const CONFIDENCE_LABEL = { high: 'Reliable', medium: 'Likely fine', low: 'Uncertain' } as const;

/** Suggests leaving with a full battery when that removes a stop or saves real time. */
function fullChargeTip(plan: TripPlan, input: Parameters<typeof planTrip>[0]): string | null {
  if (input.options.startSocPct >= 100 || plan.stops.length === 0) return null;
  const full = planTrip({ ...input, options: { ...input.options, startSocPct: 100 } });
  if (!full.feasible) return null;
  const fewer = plan.stops.length - full.stops.length;
  const saved = plan.chargeMinutes - full.chargeMinutes;
  if (fewer > 0) return `Charge to 100% before you leave and you'll need ${fewer} fewer stop${fewer > 1 ? 's' : ''}${saved >= 10 ? `, saving about ${hm(saved)} on the road` : ''}.`;
  if (saved >= 30) return `Charge to 100% before you leave to save about ${hm(saved)} of charging on the road.`;
  return null;
}

/** Start and end of each day: the trip start, overnight chargers, then the destination. */
function dayEnds(journey: Journey, from: Point, to: Point): Array<{ start: Point; end: Point }> {
  return journey.days.map((d, i) => {
    const prev = journey.days[i - 1]?.overnight?.station;
    const night = d.overnight?.station;
    return { start: prev ?? from, end: night ?? to };
  });
}

function tripView(journey: Journey, destStays: Result['destStays'], route: Coord[], altRoutes: Coord[][] = []): TripView {
  const markers: StopMarker[] = [];
  let n = 0;
  journey.days.forEach((d, di) => {
    for (const s of d.plan.stops) markers.push({ id: s.station.id, lng: s.lng, lat: s.lat, label: String(++n) });
    if (d.overnight) markers.push({ id: d.overnight.station.id, lng: d.overnight.station.lng, lat: d.overnight.station.lat, label: `N${di + 1}`, overnight: true });
  });
  const placeIds = [...journey.days.flatMap((d) => (d.overnight?.stays ?? []).slice(0, 6).map((s) => s.place.id)), ...destStays.map((s) => s.place.id)];
  return { route, altRoutes, markers, placeIds, bbox: bboxOf([...route, ...altRoutes.flat()]) };
}

export function TripPlanner(props: Props) {
  const { stations, statuses, vehicle, me } = props;
  const [from, setFrom] = useState<PickedPlace | null>(props.initialFrom ?? null);
  const [to, setTo] = useState<PickedPlace | null>(props.initialTo);
  const [options, setOptions] = useState<PlanOptions>(() => {
    const saved = { ...DEFAULT_OPTIONS, ...loadJson('trip-options', DEFAULT_OPTIONS, isOptions) };
    return props.initialSoc ? { ...saved, startSocPct: Math.round(props.initialSoc / 5) * 5 } : saved;
  });
  const [dailyHours, setDailyHours] = useState(() => loadJson('trip-daily-hours', DEFAULT_DAILY_HOURS, isDailyHours));
  const [showMore, setShowMore] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [limit, setLimit] = useState<GuestLimit | null>(null);
  const [result, setResult] = useState<Result | null>(null);
  const [saved, setSaved] = useState<SavedTrip[]>(loadSavedTrips);
  const plan = PLANS[props.planId];
  const dataReady = (props.dataState ?? 'ready') === 'ready';
  /** The route request in flight, so the driver can cancel it on a stalled connection. */
  const inFlight = useRef<AbortController | null>(null);
  const [routing, setRouting] = useState(false);
  const cancelPlanning = () => inFlight.current?.abort();
  useEffect(() => () => inFlight.current?.abort(), []);

  // A limit card is about the trip it refused; a new start or destination clears it.
  useEffect(() => setLimit(null), [from, to]);

  const setOpt = <K extends keyof PlanOptions>(key: K, value: PlanOptions[K]) => {
    const next = { ...options, [key]: value };
    setOptions(next);
    saveJson('trip-options', next);
  };

  const useMyLocation = async () => {
    setBusy('Finding you…');
    setError(null);
    try {
      const pos = await currentPosition();
      setFrom({ name: 'My location', lat: pos.coords.latitude, lng: pos.coords.longitude, bbox: null });
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not get your location.');
    } finally {
      setBusy(null);
    }
  };

  const present = (
    car: MyVehicle,
    response: RouteResponse,
    places: PlacesData | null,
    start: Point,
    end: Point,
    startedAt: Date,
    savedAt: string | null = null,
    unverified = false,
    startSocPct = options.startSocPct,
  ) => {
    const now = new Date();
    const planOptions: PlanOptions = { ...options, startSocPct, allowUnverified: unverified };
    const destStays = staysNearDestination({ stations, places }, end);
    const geometries = [{ ...response.route, via: null }, ...(response.alternatives ?? [])];
    const candidates: RouteCandidate[] = [];
    const tips: Array<string | null> = [];
    const fullWorks: boolean[] = [];
    for (const g of geometries) {
      const input = { route: { coords: g.coords, distanceKm: g.distanceKm, durationMin: g.durationMin }, stations, statuses, vehicle: car, options: planOptions, now };
      const dayHours = plan.multiDay ? dailyHours : 0;
      const journey = planJourney({ ...input, dailyHours: dayHours, places });
      candidates.push({ coords: g.coords, distanceKm: g.distanceKm, durationMin: g.durationMin, journey, via: g.via });
      tips.push(journey.days.length === 1 ? fullChargeTip(journey.days[0].plan, input) : null);
      // A trip that can't be done as asked: would leaving full be enough, on the same chargers?
      fullWorks.push(
        !journey.feasible && startSocPct < 100 && planJourney({ ...input, options: { ...planOptions, startSocPct: 100 }, dailyHours: dayHours, places }).feasible,
      );
    }
    const analyses = compareRoutes(candidates, stations, statuses, places, now);
    const routes = candidates.map((candidate, i) => ({ candidate, analysis: analyses[i], destStays, tip: tips[i], fullWorks: fullWorks[i] }));
    const journey = candidates[0].journey;
    setResult({ response, journey, places, destStays, tip: tips[0], from: start, to: end, plannedAt: now, startedAt, savedAt, routes, active: 0, unverified });
    props.onShow(tripView(journey, destStays, response.route.coords, candidates.slice(1).map((c) => c.coords)));
    return journey;
  };

  const chooseRoute = (i: number) => {
    if (!result || i === result.active) return;
    const r = result.routes[i];
    // Applied directly: a View Transition would freeze the map's route redraw and swallow taps while it ran.
    setResult({ ...result, active: i, journey: r.candidate.journey, tip: r.tip });
    props.onShow(tripView(r.candidate.journey, r.destStays, r.candidate.coords, result.routes.filter((_, k) => k !== i).map((o) => o.candidate.coords)));
  };

  const openSaved = async (trip: SavedTrip) => {
    if (!vehicle) {
      props.onNeedVehicle();
      return;
    }
    setBusy('Opening saved trip…');
    setError(null);
    try {
      present(vehicle, trip.response, await loadPlaces(), trip.from, trip.to, new Date(trip.plannedAt), trip.savedAt);
    } catch {
      setError("This saved trip couldn't be opened. Remove it and plan the trip again.");
    } finally {
      setBusy(null);
    }
  };

  const run = async (start: Point, end: Point, tripId?: string) => {
    const startedAt = tripId && result ? result.startedAt : new Date();
    if (!vehicle) {
      props.onNeedVehicle();
      return;
    }
    if (!dataReady) {
      // Never route (and count a trip) before the chargers are known: the plan would wrongly say there are none.
      setError(props.dataState === 'failed' ? "The charger list didn't load, so this trip can't be planned yet." : 'Still loading chargers. Try again in a moment.');
      return;
    }
    const ctl = new AbortController();
    inFlight.current = ctl;
    setRouting(true);
    setBusy(tripId ? 'Re-planning from here…' : plan.routeCompare ? 'Comparing routes…' : 'Planning your trip…');
    setError(null);
    setLimit(null);
    try {
      const [response, places] = await Promise.all([
        api.route({ lat: start.lat, lng: start.lng }, { lat: end.lat, lng: end.lng }, tripId, plan.routeCompare && !tripId, ctl.signal),
        loadPlaces(),
      ]);
      const journey = present(vehicle, response, places, start, end, response.counted === 'replan' ? startedAt : new Date());
      props.onUsageChanged();
      props.onPlanned?.({ journey, from: start, to: end });
    } catch (e) {
      if (ctl.signal.aborted) return;
      if (e instanceof ApiError && e.status === 402 && !me?.user && (e.code === 'too_long' || e.code === 'daily_limit')) {
        // Guests stay here: the reason, and what they can do instead.
        setLimit({ code: e.code, message: e.message });
      } else if (e instanceof ApiError && e.status === 401) props.onRequireSignIn();
      else if (e instanceof ApiError && e.status === 402) props.onPaywall({ kind: 'trip', message: e.message });
      else setError(tripError(e));
    } finally {
      if (inFlight.current === ctl) {
        inFlight.current = null;
        setRouting(false);
      }
      setBusy(null);
    }
  };

  const replanFromHere = async () => {
    if (!result) return;
    setBusy('Finding you…');
    try {
      const pos = await currentPosition();
      await run({ name: 'My location', lat: pos.coords.latitude, lng: pos.coords.longitude }, result.to, result.response.tripId);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not get your location.');
      setBusy(null);
    }
  };

  // Re-plan the same road with unverified chargers allowed: no new route request, so it costs nothing.
  const useExtras = () => {
    if (!result || !vehicle) return;
    present(vehicle, result.response, result.places, result.from, result.to, result.startedAt, result.savedAt, true);
  };

  // Same road, leaving with a full battery: also a re-plan with no new route request.
  const useFullCharge = () => {
    if (!result || !vehicle) return;
    setOpt('startSocPct', 100);
    present(vehicle, result.response, result.places, result.from, result.to, result.startedAt, result.savedAt, result.unverified, 100);
  };

  const clear = () => {
    setResult(null);
    props.onShow(null);
  };

  useEffect(() => {
    if (props.autoRun && from && to) void run(from, to);
  }, []);

  const startDrive = () => {
    if (!result || !props.onStartDrive) return;
    const chosen = result.routes[result.active].candidate;
    props.onStartDrive({ route: chosen.coords, durationMin: chosen.durationMin, journey: result.journey, from: result.from, to: result.to, options: { ...options, allowUnverified: result.unverified } });
  };

  // A stop that has had a problem report since the plan was made: offer a re-plan.
  const alerts = useMemo(() => {
    if (!result) return [];
    const now = new Date();
    const stops = result.journey.days.flatMap((d) => d.plan.stops);
    return stops
      .map((s, i) => ({ s, i, status: statuses.get(s.station.id) }))
      .filter(({ s, status }) => s.live !== 'problem' && liveState(status, now) === 'problem')
      .map(({ s, i, status }) => `Stop ${i + 1} (${s.station.name}) reported a problem ${timeAgo(status?.problemAt ?? null, now)}.`);
  }, [result, statuses]);

  const journey = result?.journey;
  const free = plan.id === 'free';
  const unlock = (label: string, perk: Perk) => props.onPaywall({ kind: 'perk', perk, label });

  const savedCopy = result ? saved.find((t) => t.id === result.response.tripId) : undefined;
  const saveState: SaveState = !savedCopy
    ? 'none'
    : savedCopy.savedAt === result?.savedAt || Date.parse(savedCopy.savedAt) >= (result?.plannedAt.getTime() ?? 0)
      ? 'current'
      : 'stale';
  const save = () => {
    if (!result) return;
    const chosen = result.routes[result.active].candidate;
    const response: RouteResponse = {
      ...result.response,
      route: {
        coords: chosen.coords,
        distanceKm: chosen.distanceKm,
        durationMin: chosen.durationMin,
        hasElevation: result.response.route.hasElevation,
        source: result.response.route.source,
      },
      alternatives: undefined,
    };
    const list = saveTrip(result.from, result.to, response, result.startedAt, plan.savedTrips);
    if (list) setSaved(list);
    else setError("Couldn't save: this phone's storage is full or blocked.");
  };

  return (
    <Sheet title={result ? `To ${result.to.name}` : 'Plan a trip'} onClose={props.onClose}>
      {!result && (
        <form
          class="trip-form"
          onSubmit={(e) => {
            e.preventDefault();
            if (from && to) void run(from, to);
          }}
        >
          <div class="trip-form__places">
            <PlaceInput
              label="Start"
              placeholder="Start: city, area or charger"
              value={from}
              stations={stations}
              onPick={setFrom}
              leading={{ label: '📍 Use my location', onSelect: () => void useMyLocation() }}
            />
            <PlaceInput label="Destination" placeholder="Where to?" value={to} stations={stations} onPick={setTo} autoFocus={!props.initialTo} />
          </div>

          <div class="vehicle-row">
            {vehicle ? (
              <>
                <span>
                  <Car size={16} aria-hidden="true" /> <strong>{vehicle.name}</strong>
                  {vehicle.realRangeKm ? ` · ${vehicle.realRangeKm} km real range` : ''}
                </span>
                <button type="button" class="link" onClick={props.onNeedVehicle}>
                  Change
                </button>
              </>
            ) : (
              <button type="button" class="btn" onClick={props.onNeedVehicle}>
                Choose your car
              </button>
            )}
          </div>

          <label class="slider">
            <span>
              Battery now <strong>{options.startSocPct}%</strong>
            </span>
            <input type="range" min={5} max={100} step={5} value={options.startSocPct} onInput={(e) => setOpt('startSocPct', Number((e.target as HTMLInputElement).value))} />
          </label>

          {plan.multiDay ? (
            <label class="inline-select">
              <span>
                <Moon size={16} aria-hidden="true" /> Drive per day
              </span>
              <select
                value={dailyHours}
                onChange={(e) => {
                  const v = Number((e.target as HTMLSelectElement).value);
                  setDailyHours(v);
                  saveJson('trip-daily-hours', v);
                }}
              >
                {DAILY_HOURS.map((h) => (
                  <option key={h} value={h}>
                    {h === 0 ? 'No limit (one day)' : `Up to ${h} h, then stay overnight`}
                  </option>
                ))}
              </select>
            </label>
          ) : (
            <PerkLock text={MULTI_DAY_LABEL} plan={cheapestWith('multiDay')} onUnlock={() => unlock('Multi-day trips', 'multiDay')} />
          )}

          <button type="button" class="disclose" aria-expanded={showMore} onClick={() => setShowMore(!showMore)}>
            <SlidersHorizontal size={18} aria-hidden="true" />
            <span class="disclose__text">
              <strong>{showMore ? 'Fewer options' : 'More options'}</strong>
              <span>Reserve, AC, passengers, driving style</span>
            </span>
            <ChevronDown size={18} class="disclose__chev" aria-hidden="true" />
          </button>
          {showMore && (
            <div class="trip-options">
              <label>
                Arrive with at least
                <select value={options.arriveReservePct} onChange={(e) => setOpt('arriveReservePct', Number((e.target as HTMLSelectElement).value))}>
                  {[10, 15, 20, 25, 30].map((v) => (
                    <option key={v} value={v}>
                      {v}%
                    </option>
                  ))}
                </select>
              </label>
              <label>
                Usually charge to
                <select value={options.chargeToPct} onChange={(e) => setOpt('chargeToPct', Number((e.target as HTMLSelectElement).value))}>
                  {[70, 80, 90, 100].map((v) => (
                    <option key={v} value={v}>
                      {v}%
                    </option>
                  ))}
                </select>
              </label>
              <label>
                Passengers besides you
                <select value={options.extraPassengers} onChange={(e) => setOpt('extraPassengers', Number((e.target as HTMLSelectElement).value))}>
                  {[0, 1, 2, 3, 4].map((v) => (
                    <option key={v} value={v}>
                      {v}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                Driving style
                <select value={options.style} onChange={(e) => setOpt('style', (e.target as HTMLSelectElement).value as DrivingStyle)}>
                  <option value="eco">Relaxed (≤80 km/h)</option>
                  <option value="normal">Normal</option>
                  <option value="fast">Fast (100+ km/h)</option>
                </select>
              </label>
              <label class="check">
                <input type="checkbox" checked={options.acOn} onChange={(e) => setOpt('acOn', (e.target as HTMLInputElement).checked)} />
                AC on
              </label>
            </div>
          )}

          {error && (
            <p class="notice notice--error" role="alert">
              {error}
            </p>
          )}
          {limit && (
            <GuestLimitCard
              limit={limit}
              signInReady={props.signInReady}
              onStartTrial={props.onStartTrial}
              onSignIn={props.onRequireSignIn}
              onPlans={props.onPlans}
            />
          )}
          {!dataReady && (
            <p class="notice" role="status" data-testid="trip-data-state">
              {props.dataState === 'failed' ? (
                <>
                  The charger list didn't load, so trips can't be planned yet.{' '}
                  {props.onRetryData && (
                    <button type="button" class="link link--inline" onClick={props.onRetryData}>
                      Try again
                    </button>
                  )}
                </>
              ) : (
                'Loading chargers…'
              )}
            </p>
          )}
          <button class="btn btn--primary btn--block" type="submit" disabled={!from || !to || busy !== null || !dataReady}>
            {busy ?? 'Plan my trip'}
          </button>
          {routing && (
            <button type="button" class="btn btn--block btn--ghost" onClick={cancelPlanning} data-testid="trip-cancel">
              Cancel
            </button>
          )}
          {free && !me?.user && (
            <p class="small muted center" data-testid="basic-hint">
              Basic: {BASIC.shortTripsPerDay} trip plan a day up to {BASIC.maxTripKm} km, no sign-in.
              {typeof me?.basicToday === 'number' && ` ${Math.max(0, BASIC.shortTripsPerDay - me.basicToday)} left today.`}{' '}
              {props.signInReady ? (
                <button type="button" class="link link--inline" onClick={props.onRequireSignIn}>
                  Sign in free for {PLANS.free.shortTripsPerDay} a day
                </button>
              ) : (
                <>Free accounts with {PLANS.free.shortTripsPerDay} a day are coming soon.</>
              )}
            </p>
          )}
          {free && me?.user && (
            <p class="small muted center">
              Free plan: trips up to {FREE_TRIP_KM} km, {PLANS.free.shortTripsPerDay} a day.{' '}
              <button type="button" class="link link--inline" onClick={props.onPlans}>
                Longer trips from {formatRupees(PLANS.trip_pass.pricePaise)}
              </button>
            </p>
          )}

          {saved.length > 0 && (
            <section class="saved" aria-label="Saved trips">
              <h3>
                <BookmarkCheck size={16} aria-hidden="true" /> Saved trips
              </h3>
              <ul>
                {saved.map((t) => (
                  <li key={t.id}>
                    <button type="button" class="saved__open" disabled={busy !== null || !dataReady} onClick={() => void openSaved(t)}>
                      <strong>
                        {t.from.name} → {t.to.name}
                      </strong>
                      <span class="muted small">
                        {Math.round(t.response.route.distanceKm)} km · saved {formatDate(t.savedAt)}
                      </span>
                    </button>
                    <button type="button" class="icon-btn icon-btn--small" aria-label={`Remove saved trip ${t.from.name} to ${t.to.name}, saved ${formatDate(t.savedAt)}`} onClick={() => setSaved(removeSavedTrip(t.id))}>
                      <X size={16} aria-hidden="true" />
                    </button>
                  </li>
                ))}
              </ul>
            </section>
          )}
        </form>
      )}

      {result && journey && (
        <JourneyResult
          result={result}
          journey={journey}
          alerts={alerts}
          busy={busy}
          error={error}
          me={me}
          plan={plan}
          statuses={statuses}
          saveState={saveState}
          onSave={save}
          onUnlock={unlock}
          onReplan={() => void replanFromHere()}
          onCancel={routing ? cancelPlanning : undefined}
          limitCard={
            limit && (
              <GuestLimitCard
                limit={limit}
                signInReady={props.signInReady}
                onStartTrial={props.onStartTrial}
                onSignIn={props.onRequireSignIn}
                onPlans={props.onPlans}
              />
            )
          }
          onClear={clear}
          onChooseRoute={chooseRoute}
          onStartDrive={props.onStartDrive ? startDrive : undefined}
          onSelectStation={props.onSelectStation}
          onOpenPlace={props.onOpenPlace}
          onUseExtras={useExtras}
          onFullCharge={useFullCharge}
        />
      )}
    </Sheet>
  );
}

interface LimitProps {
  limit: GuestLimit;
  signInReady: boolean;
  onStartTrial?: () => void;
  onSignIn: () => void;
  onPlans: () => void;
}

/** A guest reached a Basic limit: say exactly which, and offer only what this server can do. */
function GuestLimitCard({ limit, signInReady, onStartTrial, onSignIn, onPlans }: LimitProps) {
  return (
    <div class="trip-limit" role="alert" data-testid="trip-limit">
      <p class="trip-limit__why">{limit.message}</p>
      <p class="small muted">
        {limit.code === 'too_long'
          ? `You can still plan any trip up to ${BASIC.maxTripKm} km, and the charger map works for every distance.`
          : 'The charger map and live status still work. Plan again after midnight.'}
      </p>
      {signInReady ? (
        <div class="trip-limit__actions">
          {onStartTrial && (
            <button type="button" class="btn btn--primary btn--block" onClick={onStartTrial} data-testid="trip-limit-trial">
              Try Plus free for {TRIAL_DAYS} days
            </button>
          )}
          {limit.code === 'daily_limit' && (
            <button type="button" class="btn btn--block" onClick={onSignIn}>
              Sign in free for {PLANS.free.shortTripsPerDay} trips a day
            </button>
          )}
          <button type="button" class="btn btn--block btn--ghost" onClick={onPlans}>
            See plans
          </button>
        </div>
      ) : (
        <p class="small muted" data-testid="trip-limit-soon">
          Free accounts and longer trips need sign-in, which is coming soon.
        </p>
      )}
    </div>
  );
}

/** Whether this trip is saved on the phone, and whether the saved copy is older than the route on screen. */
type SaveState = 'none' | 'current' | 'stale';

interface ResultProps {
  result: Result;
  journey: Journey;
  alerts: string[];
  busy: string | null;
  error: string | null;
  me: Me | null;
  plan: Plan;
  statuses: Map<string, StationStatus>;
  saveState: SaveState;
  onSave: () => void;
  onUnlock: (label: string, perk: Perk) => void;
  onReplan: () => void;
  /** Set while a re-plan is waiting on the network. */
  onCancel?: () => void;
  /** A guest's re-plan that Basic doesn't cover: shown by the re-plan button, as the form is hidden. */
  limitCard: ComponentChildren;
  onClear: () => void;
  onChooseRoute: (index: number) => void;
  onStartDrive?: () => void;
  onSelectStation: (id: string) => void;
  onOpenPlace: (place: Place) => void;
  onUseExtras?: () => void;
  onFullCharge?: () => void;
}

function RouteCompareCards({ result, onChoose }: { result: Result; onChoose: (i: number) => void }) {
  return (
    <section class="routes" aria-label="Compare routes">
      <h3>
        <Split size={14} aria-hidden="true" /> {result.routes.length} routes compared
      </h3>
      <div class="routes__list" role="radiogroup" aria-label="Choose a route">
        {result.routes.map(({ analysis: a }, i) => (
          <button
            key={a.label}
            role="radio"
            aria-checked={i === result.active}
            class={`route-card${i === result.active ? ' is-on' : ''}${a.feasible ? '' : ' route-card--bad'}`}
            onClick={() => onChoose(i)}
            data-testid={`route-${i}`}
          >
            <span class="route-card__head">
              <strong>{a.label}</strong>
              {i === result.active && <span class="route-card__check" aria-hidden="true" />}
            </span>
            <span class="route-card__tags">
              {a.tags.map((t) => (
                <span key={t} class={`route-tag route-tag--${t}`}>
                  {TAG_LABEL[t]}
                </span>
              ))}
            </span>
            <span class="route-card__nums">
              <span>
                <strong class="num">{hm(a.totalMinutes)}</strong>
                <small>total</small>
              </span>
              <span>
                <strong class="num">{a.distanceKm}</strong>
                <small>km</small>
              </span>
              <span>
                <strong class="num">{a.stops}</strong>
                <small>{a.stops === 1 ? 'stop' : 'stops'}</small>
              </span>
              <span>
                <strong class="num">₹{a.costInr}</strong>
                <small>cost</small>
              </span>
            </span>
            <span class="route-card__meta">
              <Zap size={12} aria-hidden="true" /> {a.dcChargers} DC chargers · longest gap {a.longestDcGapKm} km
              {a.climbM !== null ? ` · ${a.climbM} m climb` : ''}
            </span>
            {(a.pros.length > 0 || a.cons.length > 0) && (
              <ul class="route-card__why">
                {a.pros.slice(0, 3).map((p) => (
                  <li key={p} class="is-pro">
                    {p}
                  </li>
                ))}
                {a.cons.slice(0, 2).map((c) => (
                  <li key={c} class="is-con">
                    {c}
                  </li>
                ))}
              </ul>
            )}
          </button>
        ))}
      </div>
    </section>
  );
}

function verdictText(j: Journey): string {
  if (j.tooLong) return 'Too long for your daily driving limit';
  if (!j.feasible) return 'Not safe as planned';
  const stops = `${j.stopCount} charging stop${j.stopCount === 1 ? '' : 's'}`;
  if (j.days.length > 1) {
    const nights = j.days.length - 1;
    return `${j.days.length}-day trip: ${stops} and ${nights} overnight stay${nights > 1 ? 's' : ''}`;
  }
  return j.stopCount ? `You'll make it with ${stops}` : "You'll make it without charging";
}

function JourneyResult(props: ResultProps) {
  const { result, journey, alerts, busy, error, me, plan, statuses, saveState, onSave, onUnlock, onReplan, onCancel, limitCard, onClear, onChooseRoute, onStartDrive, onSelectStation, onOpenPlace, onUseExtras, onFullCharge } = props;
  const extras = journey.days.flatMap((d) => d.plan.extras.map((s) => ({ s, km: d.startKm + s.alongKm })));
  const extrasWork = journey.days.some((d) => d.plan.extras.length > 0) && journey.days.every((d) => d.plan.feasible || d.plan.extrasFeasible);
  const ends = dayEnds(journey, result.from, result.to);
  const multi = journey.days.length > 1;
  const area = (stationId: string) => result.places?.area[stationId] ?? null;
  const now = new Date();
  const replanFree = plan.freeReplans && now.getTime() - result.startedAt.getTime() < REPLAN_WINDOW_HOURS * 3600_000;
  const replanCost = plan.freeReplans ? 'uses a long trip' : "uses one of today's trips";
  // Basic has no re-plans: each one is a new trip, so say so once today's are used.
  const basicUsed = !me?.user && typeof me?.basicToday === 'number' && me.basicToday >= BASIC.shortTripsPerDay;
  const gapDay = journey.days.find((d) => d.plan.gapAtKm !== null);
  const gapKm = gapDay ? Math.round(gapDay.startKm + gapDay.plan.gapAtKm!) : null;
  const safeRoute = result.routes.findIndex((r, i) => i !== result.active && r.candidate.journey.feasible);
  const fullWorks = result.routes[result.active]?.fullWorks ?? false;
  const canFix = safeRoute >= 0 || fullWorks || (extrasWork && Boolean(onUseExtras));
  let stopNo = 0;

  return (
    <div class="trip-result">
      <div class={`verdict ${journey.feasible ? 'verdict--ok' : 'verdict--bad'}`} role="status">
        <strong>{verdictText(journey)}</strong>
        <span>
          {journey.feasible || journey.tooLong
            ? `Arrive with about ${Math.max(0, journey.arrivalSocPct)}% battery`
            : gapKm !== null
              ? `No ${result.unverified ? 'known' : 'confirmed'} charger in reach after km ${gapKm}`
              : 'You would arrive below your safety reserve'}
        </span>
      </div>

      {!journey.feasible && !journey.tooLong && (
        // Never a dead end: what would make this trip work, best first, each a re-plan of the same road.
        <section class="fixes" aria-label="Ways to make this trip" data-testid="trip-fixes">
          <h3>{canFix ? 'Ways to make this trip' : 'What you can do'}</h3>
          <ul>
            {safeRoute >= 0 && (
              <li>
                <button class="fix" onClick={() => onChooseRoute(safeRoute)} data-testid="fix-route">
                  <strong>Take the {result.routes[safeRoute].analysis.label.toLowerCase()} instead</strong>
                  <span>It has confirmed chargers all the way with your battery.</span>
                </button>
              </li>
            )}
            {fullWorks && onFullCharge && (
              <li>
                <button class="fix" onClick={onFullCharge} data-testid="fix-full">
                  <strong>Leave with a full battery</strong>
                  <span>At 100% the chargers on this plan are enough. Charge at home or near the start first.</span>
                </button>
              </li>
            )}
            {extrasWork && onUseExtras && (
              <li>
                <button class="fix" onClick={onUseExtras} data-testid="use-extras">
                  <strong>Also use chargers nobody has confirmed recently</strong>
                  <span>
                    {extras.length === 1 ? 'One charger' : `${extras.length} chargers`} on this road would fill the gap. They're listed in our data but have no recent check-in, so call
                    ahead or check reports before you rely on them.
                  </span>
                </button>
              </li>
            )}
            <li class="fix fix--text">
              <strong>Or change the trip</strong>
              <span>
                {gapKm !== null
                  ? `Plan to a town before km ${gapKm} and charge there overnight, or pick a nearer destination.`
                  : 'Start with more charge, or pick a nearer destination.'}{' '}
                Know a charger on this road that we don't?{' '}
                <a href="https://www.openstreetmap.org/fixthemap" target="_blank" rel="noopener noreferrer">
                  Add it to OpenStreetMap
                </a>{' '}
                and a later plan can use it.
              </span>
            </li>
          </ul>
        </section>
      )}

      <div class="stats">
        <div>
          <span>Distance</span>
          <strong>{Math.round(journey.distanceKm)} km</strong>
        </div>
        <div>
          <span>{multi ? 'On the road' : 'Total time'}</span>
          <strong>{hm(journey.driveMinutes + journey.chargeMinutes)}</strong>
        </div>
        <div>
          <span>Charging</span>
          <strong>{hm(journey.chargeMinutes)}</strong>
        </div>
        <div>
          <span>Est. cost</span>
          <strong>₹{journey.costInr}</strong>
        </div>
      </div>

      {result.routes.length > 1 && <RouteCompareCards result={result} onChoose={onChooseRoute} />}
      {!plan.routeCompare && !result.savedAt && (
        <PerkLock text="Compare up to 3 roads: time, stops, cost and how far apart fast chargers are" plan={cheapestWith('routeCompare')} onUnlock={() => onUnlock('Route comparison', 'routeCompare')} />
      )}

      {onStartDrive &&
        (plan.liveDrive ? (
          <button class="btn btn--primary btn--block btn--lg drive-start" onClick={onStartDrive} data-testid="start-drive">
            <Gauge size={20} aria-hidden="true" /> Start live drive
          </button>
        ) : (
          <PerkLock
            text="Live drive: watches your battery on the way and warns early, with an earlier charger, if it drops faster than planned"
            plan={cheapestWith('liveDrive')}
            onUnlock={() => onUnlock('Live drive mode', 'liveDrive')}
          />
        ))}

      {plan.liveDrive &&
        alerts.map((a) => (
          <div key={a} class="notice notice--error" role="alert">
            {a}{' '}
            <button class="link" onClick={onReplan}>
              Re-plan now
            </button>
          </div>
        ))}
      {plan.liveDrive && journey.stopCount > 0 && alerts.length === 0 && (
        <p class="perk-on">
          <BellRing size={16} aria-hidden="true" />
          <span>
            <strong>Alerts on.</strong> {journey.stopCount > 1 ? `If any of your ${journey.stopCount} stops is` : 'If your charging stop is'} reported broken
            while this trip is open, you'll see it here with a one-tap re-plan.
          </span>
        </p>
      )}
      {result.tip && (
        <p class="notice notice--ok">
          <Lightbulb size={16} aria-hidden="true" /> {result.tip}
        </p>
      )}
      {journey.warnings.map((w) => (
        <p key={w} class="notice">
          {w}
        </p>
      ))}
      {result.unverified && (
        <p class="notice" data-testid="unverified-plan">
          This plan includes chargers nobody has confirmed recently. Check each one before you set off, and keep the backups in mind.
        </p>
      )}
      {extras.length > 0 && (
        <section class="extras" aria-label="Extra options" data-testid="extra-options">
          <h3>Extra options, not verified</h3>
          <p class="small muted">
            Chargers on this road that could fill the gap, but that nobody has confirmed recently. We don't plan stops at them unless you ask.
          </p>
          <ul>
            {extras.map(({ s, km }) => (
              <li key={s.station.id}>
                <button class="backup" onClick={() => onSelectStation(s.station.id)}>
                  {s.station.name} · km {Math.round(km)} · {s.mode.toUpperCase()} {s.powerKw} kW
                </button>
              </li>
            ))}
          </ul>
        </section>
      )}

      {journey.days.map((d, di) => {
        const { start, end } = ends[di];
        const first = stopNo;
        stopNo += d.plan.stops.length;
        return (
          <section key={di} class="day" aria-label={multi ? `Day ${di + 1}` : 'Your route'}>
            {multi && (
              <header class="day__head">
                <h3>Day {di + 1}</h3>
                <span class="muted small">
                  {Math.round(d.endKm - d.startKm)} km · {hm(d.plan.driveMinutes + d.plan.chargeMinutes)}
                </span>
                <a class="chip-link" href={navigationUrl(start, end, d.plan.stops)} target="_blank" rel="noopener noreferrer">
                  <Navigation size={14} aria-hidden="true" /> Navigate
                </a>
              </header>
            )}
            <ol class="timeline">
              <li class="timeline__end">
                <span class="timeline__dot" aria-hidden="true" />
                <div>
                  <strong>{di === 0 ? result.from.name : `Morning at ${start.name}`}</strong>
                  <span class="muted">Leave with {d.startSocPct}%</span>
                </div>
              </li>
              {d.plan.stops.map((s, i) => {
                const food = nearbyPlaces(result.places, s.station.id, 'f');
                return (
                  <li key={s.station.id} class="timeline__stop">
                    <span class="timeline__dot timeline__dot--stop" aria-hidden="true">
                      {first + i + 1}
                    </span>
                    <div>
                      <button class="timeline__name" onClick={() => onSelectStation(s.station.id)}>
                        {s.station.name}
                      </button>
                      <span class="muted">
                        km {Math.round(d.startKm + s.alongKm)}
                        {s.station.operator ? ` · ${s.station.operator}` : ''}
                      </span>
                      <div class="timeline__charge">
                        Arrive {s.arriveSocPct}% → charge to <strong>{s.departSocPct}%</strong> · about {s.chargeMinutes} min · ₹{s.costInr}
                      </div>
                      <div class="badges">
                        <span class={`badge badge--${s.confidence}`}>{CONFIDENCE_LABEL[s.confidence]}</span>
                        <LiveBadge state={liveState(statuses.get(s.station.id), now)} />
                      </div>
                      <ul class="timeline__notes">
                        {s.notes.map((n) => (
                          <li key={n}>{n}</li>
                        ))}
                      </ul>
                      {s.backups.length > 0 &&
                        (plan.backups ? (
                          <div class="backups">
                            <span class="small muted">If it's busy or down:</span>
                            {s.backups.map((b) => (
                              <button key={b.station.id} class="backup" onClick={() => onSelectStation(b.station.id)}>
                                {b.station.name} · km {Math.round(d.startKm + b.alongKm)} · arrive {b.arriveSocPct}% · {b.mode.toUpperCase()} {b.powerKw} kW
                                {b.trusted ? '' : ' · unverified'}
                              </button>
                            ))}
                          </div>
                        ) : (
                          <PerkLock
                            text={`${s.backups.length} backup charger${s.backups.length > 1 ? 's' : ''} found for this stop`}
                            plan={cheapestWith('backups')}
                            onUnlock={() => onUnlock('Backup chargers', 'backups')}
                          />
                        ))}
                      {food.length > 0 && (
                        <details class="stop-places">
                          <summary>
                            <Utensils size={14} aria-hidden="true" /> {food.length} place{food.length > 1 ? 's' : ''} to eat while you charge
                          </summary>
                          <PlaceList items={food} area={area(s.station.id)} limit={3} onOpen={onOpenPlace} />
                        </details>
                      )}
                    </div>
                  </li>
                );
              })}
              {d.overnight ? (
                <OvernightCard day={d} index={di} area={area(d.overnight.station.id)} onSelectStation={onSelectStation} onOpenPlace={onOpenPlace} />
              ) : (
                <li class="timeline__end">
                  <span class="timeline__dot" aria-hidden="true" />
                  <div>
                    <strong>{result.to.name}</strong>
                    <span class="muted">Arrive with about {Math.max(0, d.plan.arrivalSocPct)}%</span>
                  </div>
                </li>
              )}
            </ol>
          </section>
        );
      })}

      {result.destStays.length > 0 && (
        <section class="dest-stays" aria-label={`Stays near ${result.to.name}`}>
          <h3>
            <BedDouble size={16} aria-hidden="true" /> Staying at {result.to.name}?
          </h3>
          <p class="small muted">Hotels near your destination with a public charger on site or within 3 km. Distances are from your destination.</p>
          <PlaceList items={result.destStays} area={result.to.name} limit={3} from="destination" onOpen={onOpenPlace} />
        </section>
      )}

      {error && (
        <p class="notice notice--error" role="alert">
          {error}
        </p>
      )}
      <div class="actions actions--stack">
        <a
          class={`btn btn--block ${onStartDrive && plan.liveDrive ? 'btn--glass' : 'btn--primary'}`}
          href={navigationUrl(ends[0].start, ends[0].end, journey.days[0].plan.stops)}
          target="_blank"
          rel="noopener noreferrer"
        >
          {multi ? 'Start day 1 in Google Maps' : 'Start navigation in Google Maps'}
        </a>
        {plan.savedTrips > 0 ? (
          <button class="btn btn--block" disabled={saveState === 'current'} onClick={onSave}>
            {saveState === 'current' ? <BookmarkCheck size={18} aria-hidden="true" /> : <Bookmark size={18} aria-hidden="true" />}
            {saveState === 'current' ? 'Saved on this phone' : saveState === 'stale' ? 'Update saved trip' : 'Save trip for no-signal areas'}
          </button>
        ) : (
          saveState === 'none' && (
            <PerkLock text="Save this trip to open without signal" plan={cheapestWith('savedTrips')} onUnlock={() => onUnlock('Saved trips', 'savedTrips')} />
          )
        )}
        {limitCard}
        <button class="btn btn--block" disabled={busy !== null} onClick={onReplan} data-testid="trip-replan">
          {busy ?? `Re-plan from where I am (${basicUsed ? "today's Basic trip is used" : replanFree ? 'free' : replanCost})`}
        </button>
        {onCancel && (
          <button type="button" class="btn btn--block btn--ghost" onClick={onCancel} data-testid="trip-cancel">
            Cancel
          </button>
        )}
        <button class="btn btn--block btn--ghost" onClick={onClear}>
          Plan another trip
        </button>
      </div>
      <p class="small muted">
        Estimates use your car's typical consumption, {result.response.route.hasElevation ? 'the terrain and ' : ''}your settings. Costs assume about ₹22/kWh for DC and ₹14/kWh for AC. Hotel
        prices and availability are on Booking.com.
        {result.savedAt
          ? ` Opened from your saved trips (saved ${formatDate(result.savedAt)}); it didn't use a trip.`
          : result.response.counted === 'long' && me?.usage
            ? ` Long trips used: ${me.usage.longInWindow} of ${me.limits.longTripQuota}.`
            : ''}
      </p>
      {result.response.route.source === 'valhalla' && (
        // FOSSGIS's terms for its public router: OpenStreetMap credit and a way to report map errors.
        <p class="small muted" data-testid="route-attribution">
          Route ©{' '}
          <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">
            OpenStreetMap contributors
          </a>{' '}
          (ODbL) · Valhalla by FOSSGIS ·{' '}
          <a href="https://www.openstreetmap.org/fixthemap" target="_blank" rel="noopener">
            Report a map error
          </a>
        </p>
      )}
    </div>
  );
}

function LiveBadge({ state }: { state: ReturnType<typeof liveState> }) {
  return (
    <span class="badge">
      <span class="dot" style={{ background: LIVE_COLOUR[state] }} aria-hidden="true" /> {LIVE_LABEL[state]}
    </span>
  );
}

interface OvernightProps {
  day: DayPlan;
  index: number;
  area: string | null;
  onSelectStation: (id: string) => void;
  onOpenPlace: (place: Place) => void;
}

function OvernightCard({ day, index, area, onSelectStation, onOpenPlace }: OvernightProps) {
  const night = day.overnight!;
  const onsite = night.stays.filter((s) => s.place.chargerOnSite).length;
  return (
    <li class="timeline__stop timeline__stop--night">
      <span class="timeline__dot timeline__dot--night" aria-hidden="true">
        <Moon size={14} />
      </span>
      <div class="overnight">
        <span class="overnight__label">Night {index + 1}</span>
        <button class="timeline__name" onClick={() => onSelectStation(night.station.id)}>
          {night.station.name}
        </button>
        <span class="muted">
          km {Math.round(night.alongKm)}
          {area ? ` · ${area}` : ''}
        </span>
        {(!night.trusted || night.speedUnknown) && (
          <span class="trust__badge trust__badge--unverified" data-testid="overnight-unverified">
            {[!night.trusted && 'Unverified', night.speedUnknown && 'Speed unknown'].filter(Boolean).join(' · ')}
          </span>
        )}
        {night.speedUnknown ? (
          <div class="timeline__charge">
            Arrive {Math.max(0, day.plan.arrivalSocPct)}%. No source gives this charger's speed, so we can't say how full the battery will be by
            morning. Ask the site, or plan a stop early on day {index + 2}.
          </div>
        ) : (
          <div class="timeline__charge">
            Arrive {Math.max(0, day.plan.arrivalSocPct)}% → <strong>{night.morningSocPct === 100 ? '100%' : `about ${night.morningSocPct}%`} by morning</strong> ·{' '}
            {night.morningSocPct === 100 ? `about ${night.hoursToFull} h` : `${night.hoursToFull} h to full`} on {night.mode.toUpperCase()} {night.powerKw} kW
          </div>
        )}
        {!night.trusted && <p class="small muted">Nobody has confirmed this charger recently. Call the site before you rely on it for the night.</p>}
        {night.station.access === 'customers' && <p class="small muted">Customers only: book a room there, or ask before you plug in.</p>}
        {!night.speedUnknown && night.morningSocPct < 100 && (
          <p class="small muted">A slow charger: a night here won't fill the battery, so day {index + 2} starts lower and may need an extra stop.</p>
        )}
        {night.stays.length > 0 ? (
          <>
            <p class="small muted">
              {night.stays.length} stay{night.stays.length > 1 ? 's' : ''} within 3 km
              {onsite ? `, ${onsite} with a charger on site` : ''}. Plug in, check in, sleep.
            </p>
            <PlaceList items={night.stays} area={area} limit={3} onOpen={onOpenPlace} />
          </>
        ) : (
          <p class="small muted">No hotel is mapped right here. Search nearby on the map, or ask a hotel about a 3-pin socket.</p>
        )}
        {night.food.length > 0 && (
          <details class="stop-places">
            <summary>
              <Utensils size={14} aria-hidden="true" /> {night.food.length} place{night.food.length > 1 ? 's' : ''} for dinner nearby
            </summary>
            <PlaceList items={night.food} area={area} limit={3} onOpen={onOpenPlace} />
          </details>
        )}
      </div>
    </li>
  );
}
