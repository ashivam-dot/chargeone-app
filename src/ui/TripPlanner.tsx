import { useMemo, useState } from 'preact/hooks';
import type { Station } from '../data/model.ts';
import { ApiError, api, currentPosition, type Me, type RouteResponse } from '../lib/api.ts';
import { isObject, loadJson, saveJson } from '../lib/storage.ts';
import type { Coord } from '../planner/geometry.ts';
import { DEFAULT_OPTIONS, navigationUrl, planTrip, type DrivingStyle, type PlanOptions, type Stop, type TripPlan } from '../planner/planner.ts';
import { FREE_TRIP_KM, PLANS } from '../shared/plans.ts';
import { LIVE_COLOUR, LIVE_LABEL, liveState, timeAgo, type StationStatus } from '../shared/status.ts';
import type { MyVehicle } from '../shared/vehicles.ts';
import { PlaceInput, type PickedPlace } from './PlaceInput.tsx';
import { Sheet } from './Sheet.tsx';

export interface TripView {
  route: Coord[];
  stops: Stop[];
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
  onUsageChanged: () => void;
}

interface Result {
  response: RouteResponse;
  plan: TripPlan;
  tip: string | null;
  from: PickedPlace;
  to: PickedPlace;
  plannedAt: Date;
}

const isOptions = (v: unknown): v is PlanOptions => isObject(v) && typeof v.startSocPct === 'number' && typeof v.style === 'string';

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

export function TripPlanner(props: Props) {
  const { stations, statuses, vehicle, me } = props;
  const [from, setFrom] = useState<PickedPlace | null>(null);
  const [to, setTo] = useState<PickedPlace | null>(props.initialTo);
  const [options, setOptions] = useState<PlanOptions>(() => ({ ...DEFAULT_OPTIONS, ...loadJson('trip-options', DEFAULT_OPTIONS, isOptions) }));
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
      const response = await api.route({ lat: start.lat, lng: start.lng }, { lat: end.lat, lng: end.lng }, tripId);
      const input = {
        route: { coords: response.route.coords, distanceKm: response.route.distanceKm, durationMin: response.route.durationMin },
        stations,
        statuses,
        vehicle,
        options,
        now: new Date(),
      };
      const plan = planTrip(input);
      setResult({ response, plan, tip: fullChargeTip(plan, input), from: start, to: end, plannedAt: new Date() });
      props.onShow({ route: response.route.coords, stops: plan.stops, bbox: bboxOf(response.route.coords) });
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
    return result.plan.stops
      .map((s, i) => ({ s, i, status: statuses.get(s.station.id) }))
      .filter(({ s, status }) => s.live !== 'problem' && liveState(status, now) === 'problem')
      .map(({ s, i, status }) => `Stop ${i + 1} (${s.station.name}) reported a problem ${timeAgo(status?.problemAt ?? null, now)}.`);
  }, [result, statuses]);

  const plan = result?.plan;
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
                  🚗 <strong>{vehicle.name}</strong>
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

      {result && plan && (
        <div class="trip-result">
          <div class={`verdict ${plan.feasible ? 'verdict--ok' : 'verdict--bad'}`} role="status">
            <strong>{plan.feasible ? (plan.stops.length ? `You'll make it with ${plan.stops.length} charging stop${plan.stops.length > 1 ? 's' : ''}` : "You'll make it without charging") : 'Not safe as planned'}</strong>
            <span>
              Arrive with about {Math.max(0, plan.arrivalSocPct)}% battery
            </span>
          </div>

          <div class="stats">
            <div>
              <span>Distance</span>
              <strong>{Math.round(plan.distanceKm)} km</strong>
            </div>
            <div>
              <span>Total time</span>
              <strong>{hm(plan.driveMinutes + plan.chargeMinutes)}</strong>
            </div>
            <div>
              <span>Charging</span>
              <strong>{hm(plan.chargeMinutes)}</strong>
            </div>
            <div>
              <span>Est. cost</span>
              <strong>₹{plan.totalCostInr}</strong>
            </div>
          </div>

          {alerts.map((a) => (
            <div key={a} class="notice notice--error" role="alert">
              {a}{' '}
              <button class="link" onClick={() => void replanFromHere()}>
                Re-plan now
              </button>
            </div>
          ))}
          {result.tip && (
            <p class="notice notice--ok">
              💡 {result.tip}
            </p>
          )}
          {plan.warnings.map((w) => (
            <p key={w} class="notice">
              {w}
            </p>
          ))}

          <ol class="timeline">
            <li class="timeline__end">
              <span class="timeline__dot" aria-hidden="true" />
              <div>
                <strong>{result.from.name}</strong>
                <span class="muted">Leave with {options.startSocPct}%</span>
              </div>
            </li>
            {plan.stops.map((s, i) => (
              <li key={s.station.id} class="timeline__stop">
                <span class="timeline__dot timeline__dot--stop" aria-hidden="true">
                  {i + 1}
                </span>
                <div>
                  <button class="timeline__name" onClick={() => props.onSelectStation(s.station.id)}>
                    {s.station.name}
                  </button>
                  <span class="muted">
                    km {Math.round(s.alongKm)}
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
                        <button key={b.station.id} class="backup" onClick={() => props.onSelectStation(b.station.id)}>
                          {b.station.name} · km {Math.round(b.alongKm)} · arrive {b.arriveSocPct}% · {b.mode.toUpperCase()} {b.powerKw} kW
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              </li>
            ))}
            <li class="timeline__end">
              <span class="timeline__dot" aria-hidden="true" />
              <div>
                <strong>{result.to.name}</strong>
                <span class="muted">Arrive with about {Math.max(0, plan.arrivalSocPct)}%</span>
              </div>
            </li>
          </ol>

          {error && (
            <p class="notice notice--error" role="alert">
              {error}
            </p>
          )}
          <div class="actions actions--stack">
            <a class="btn btn--primary btn--block" href={navigationUrl(result.from, result.to, plan.stops)} target="_blank" rel="noopener noreferrer">
              Start navigation in Google Maps
            </a>
            <button class="btn btn--block" disabled={busy !== null} onClick={() => void replanFromHere()}>
              {busy ?? 'Re-plan from where I am (free)'}
            </button>
            <button class="btn btn--block btn--ghost" onClick={clear}>
              Plan another trip
            </button>
          </div>
          <p class="small muted">
            Estimates use your car's typical consumption, the terrain and your settings. Costs assume about ₹22/kWh for DC and ₹14/kWh for AC.
            {result.response.counted === 'long' && me?.usage ? ` Long trips used: ${me.usage.longInWindow} of ${me.limits.longTripQuota}.` : ''}
          </p>
        </div>
      )}
    </Sheet>
  );
}
