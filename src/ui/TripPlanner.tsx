import { BedDouble, Car, Lightbulb, Moon, Navigation, Utensils } from 'lucide-preact';
import { useMemo, useState } from 'preact/hooks';
import type { Station } from '../data/model.ts';
import type { Place, PlacesData } from '../data/places.ts';
import { ApiError, api, currentPosition, type Me, type RouteResponse } from '../lib/api.ts';
import { loadPlaces } from '../lib/places.ts';
import { isObject, loadJson, saveJson } from '../lib/storage.ts';
import type { StopMarker } from '../map/MapView.tsx';
import type { Coord } from '../planner/geometry.ts';
import { nearbyPlaces, planJourney, staysNearDestination, type DayPlan, type Journey } from '../planner/journey.ts';
import { DEFAULT_OPTIONS, navigationUrl, planTrip, type DrivingStyle, type PlanOptions, type TripPlan } from '../planner/planner.ts';
import { FREE_TRIP_KM, PLANS } from '../shared/plans.ts';
import { LIVE_COLOUR, LIVE_LABEL, liveState, timeAgo, type StationStatus } from '../shared/status.ts';
import type { MyVehicle } from '../shared/vehicles.ts';
import { PlaceList } from './NearbyPlaces.tsx';
import { PlaceInput, type PickedPlace } from './PlaceInput.tsx';
import { Sheet } from './Sheet.tsx';

export interface TripView {
  route: Coord[];
  markers: StopMarker[];
  /** Ids of overnight and destination stays to show on the map. */
  placeIds: string[];
  bbox: [number, number, number, number];
}

interface Props {
  stations: Station[];
  statuses: Map<string, StationStatus>;
  vehicle: MyVehicle | null;
  me: Me | null;
  initialTo: PickedPlace | null;
  onClose: () => void;
  onNeedVehicle: () => void;
  onRequireSignIn: () => void;
  onPaywall: (message: string) => void;
  onShow: (view: TripView | null) => void;
  onSelectStation: (id: string) => void;
  onOpenPlace: (place: Place) => void;
  onUsageChanged: () => void;
}

interface Result {
  response: RouteResponse;
  journey: Journey;
  places: PlacesData | null;
  destStays: ReturnType<typeof staysNearDestination>;
  tip: string | null;
  from: PickedPlace;
  to: PickedPlace;
  plannedAt: Date;
}

type Point = { name: string; lat: number; lng: number };

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

function tripView(journey: Journey, destStays: Result['destStays'], route: Coord[]): TripView {
  const markers: StopMarker[] = [];
  let n = 0;
  journey.days.forEach((d, di) => {
    for (const s of d.plan.stops) markers.push({ id: s.station.id, lng: s.lng, lat: s.lat, label: String(++n) });
    if (d.overnight) markers.push({ id: d.overnight.station.id, lng: d.overnight.station.lng, lat: d.overnight.station.lat, label: `N${di + 1}`, overnight: true });
  });
  const placeIds = [...journey.days.flatMap((d) => (d.overnight?.stays ?? []).slice(0, 6).map((s) => s.place.id)), ...destStays.map((s) => s.place.id)];
  return { route, markers, placeIds, bbox: bboxOf(route) };
}

export function TripPlanner(props: Props) {
  const { stations, statuses, vehicle, me } = props;
  const [from, setFrom] = useState<PickedPlace | null>(null);
  const [to, setTo] = useState<PickedPlace | null>(props.initialTo);
  const [options, setOptions] = useState<PlanOptions>(() => ({ ...DEFAULT_OPTIONS, ...loadJson('trip-options', DEFAULT_OPTIONS, isOptions) }));
  const [dailyHours, setDailyHours] = useState(() => loadJson('trip-daily-hours', DEFAULT_DAILY_HOURS, isDailyHours));
  const [showMore, setShowMore] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<Result | null>(null);

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

  const run = async (start: PickedPlace, end: PickedPlace, tripId?: string) => {
    if (!vehicle) {
      props.onNeedVehicle();
      return;
    }
    if (!me?.user) {
      props.onRequireSignIn();
      return;
    }
    setBusy(tripId ? 'Re-planning from here…' : 'Planning your trip…');
    setError(null);
    try {
      const [response, places] = await Promise.all([
        api.route({ lat: start.lat, lng: start.lng }, { lat: end.lat, lng: end.lng }, tripId),
        loadPlaces(),
      ]);
      const input = {
        route: { coords: response.route.coords, distanceKm: response.route.distanceKm, durationMin: response.route.durationMin },
        stations,
        statuses,
        vehicle,
        options,
        now: new Date(),
      };
      const journey = planJourney({ ...input, dailyHours, places });
      const tip = journey.days.length === 1 ? fullChargeTip(journey.days[0].plan, input) : null;
      const destStays = staysNearDestination({ stations, places }, end);
      setResult({ response, journey, places, destStays, tip, from: start, to: end, plannedAt: new Date() });
      props.onShow(tripView(journey, destStays, response.route.coords));
      props.onUsageChanged();
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) props.onRequireSignIn();
      else if (e instanceof ApiError && e.status === 402) props.onPaywall(e.message);
      else setError(e instanceof Error ? e.message : 'Could not plan this trip.');
    } finally {
      setBusy(null);
    }
  };

  const replanFromHere = async () => {
    if (!result) return;
    setBusy('Finding you…');
    try {
      const pos = await currentPosition();
      await run({ name: 'My location', lat: pos.coords.latitude, lng: pos.coords.longitude, bbox: null }, result.to, result.response.tripId);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not get your location.');
      setBusy(null);
    }
  };

  const clear = () => {
    setResult(null);
    props.onShow(null);
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
  const free = (me?.plan ?? 'free') === 'free';

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

          <button type="button" class="link" aria-expanded={showMore} onClick={() => setShowMore(!showMore)}>
            {showMore ? 'Fewer options' : 'More options (reserve, AC, passengers, driving style)'}
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
          <button class="btn btn--primary btn--block" type="submit" disabled={!from || !to || busy !== null}>
            {busy ?? 'Plan my trip'}
          </button>
          {free && (
            <p class="small muted center">
              Free plan: trips up to {FREE_TRIP_KM} km, {PLANS.free.shortTripsPerDay} a day. Longer trips with Trip Pass or Plus.
            </p>
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
          onReplan={() => void replanFromHere()}
          onClear={clear}
          onSelectStation={props.onSelectStation}
          onOpenPlace={props.onOpenPlace}
        />
      )}
    </Sheet>
  );
}

interface ResultProps {
  result: Result;
  journey: Journey;
  alerts: string[];
  busy: string | null;
  error: string | null;
  me: Me | null;
  onReplan: () => void;
  onClear: () => void;
  onSelectStation: (id: string) => void;
  onOpenPlace: (place: Place) => void;
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

function JourneyResult({ result, journey, alerts, busy, error, me, onReplan, onClear, onSelectStation, onOpenPlace }: ResultProps) {
  const ends = dayEnds(journey, result.from, result.to);
  const multi = journey.days.length > 1;
  const area = (stationId: string) => result.places?.area[stationId] ?? null;
  let stopNo = 0;

  return (
    <div class="trip-result">
      <div class={`verdict ${journey.feasible ? 'verdict--ok' : 'verdict--bad'}`} role="status">
        <strong>{verdictText(journey)}</strong>
        <span>Arrive with about {Math.max(0, journey.arrivalSocPct)}% battery</span>
      </div>

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

      {alerts.map((a) => (
        <div key={a} class="notice notice--error" role="alert">
          {a}{' '}
          <button class="link" onClick={onReplan}>
            Re-plan now
          </button>
        </div>
      ))}
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
                        <span class="badge">
                          <span class="dot" style={{ background: LIVE_COLOUR[s.live] }} aria-hidden="true" /> {LIVE_LABEL[s.live]}
                        </span>
                      </div>
                      <ul class="timeline__notes">
                        {s.notes.map((n) => (
                          <li key={n}>{n}</li>
                        ))}
                      </ul>
                      {s.backups.length > 0 && (
                        <div class="backups">
                          <span class="small muted">If it's busy or down:</span>
                          {s.backups.map((b) => (
                            <button key={b.station.id} class="backup" onClick={() => onSelectStation(b.station.id)}>
                              {b.station.name} · km {Math.round(d.startKm + b.alongKm)} · arrive {b.arriveSocPct}% · {b.mode.toUpperCase()} {b.powerKw} kW
                            </button>
                          ))}
                        </div>
                      )}
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
          class="btn btn--primary btn--block"
          href={navigationUrl(ends[0].start, ends[0].end, journey.days[0].plan.stops)}
          target="_blank"
          rel="noopener noreferrer"
        >
          {multi ? 'Start day 1 in Google Maps' : 'Start navigation in Google Maps'}
        </a>
        <button class="btn btn--block" disabled={busy !== null} onClick={onReplan}>
          {busy ?? 'Re-plan from where I am (free)'}
        </button>
        <button class="btn btn--block btn--ghost" onClick={onClear}>
          Plan another trip
        </button>
      </div>
      <p class="small muted">
        Estimates use your car's typical consumption, the terrain and your settings. Costs assume about ₹22/kWh for DC and ₹14/kWh for AC. Hotel
        prices and availability are on Booking.com.
        {result.response.counted === 'long' && me?.usage ? ` Long trips used: ${me.usage.longInWindow} of ${me.limits.longTripQuota}.` : ''}
      </p>
    </div>
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
        <div class="timeline__charge">
          Arrive {Math.max(0, day.plan.arrivalSocPct)}% → <strong>{night.morningSocPct === 100 ? '100%' : `about ${night.morningSocPct}%`} by morning</strong> ·{' '}
          {night.morningSocPct === 100 ? `about ${night.hoursToFull} h` : `${night.hoursToFull} h to full`} on {night.mode.toUpperCase()} {night.powerKw} kW
        </div>
        {night.morningSocPct < 100 && (
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
