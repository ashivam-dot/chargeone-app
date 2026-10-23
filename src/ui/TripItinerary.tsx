// One day of a trip on the clock: leave, charge, rest, eat, gaps in the chargers, and the night or the
// arrival. Every row can be tapped to see it on the map.
import { AlertTriangle, BedDouble, Coffee, Flag, MapPin, Moon, Split, Utensils, Zap } from 'lucide-preact';
import type { PlaceOnRoute } from '../data/corridor.ts';
import type { Place, PlacesData } from '../data/places.ts';
import type { RouteIndex } from '../planner/geometry.ts';
import { clockLabel, type ItineraryItem } from '../planner/itinerary.ts';
import { nearbyPlaces, type DayPlan, type NearbyPlace } from '../planner/journey.ts';
import type { Stop } from '../planner/planner.ts';
import { TAG_LABEL, type RouteAnalysis } from '../planner/routeCompare.ts';
import { cheapestWith, type Perk, type Plan } from '../shared/plans.ts';
import { LIVE_COLOUR, LIVE_LABEL, liveState, type StationStatus } from '../shared/status.ts';
import { PlaceList } from './NearbyPlaces.tsx';
import { PerkLock } from './PerkLock.tsx';

const CONFIDENCE_LABEL = {
  high: 'Reliable',
  medium: 'Likely fine',
  low: 'Uncertain',
} as const;
const CAT_LABEL: Record<string, string> = {
  rest: 'rest area',
  fuel: 'fuel station',
  toilets: 'toilets',
  food: 'restaurant',
  stay: 'hotel',
};

export interface DayTimelineProps {
  day: DayPlan;
  index: number;
  /** Charging stops on earlier days, so stop numbers run across the trip. */
  firstStopNo: number;
  fromName: string;
  toName: string;
  startName: string;
  places: PlacesData | null;
  route: RouteIndex;
  plan: Plan;
  statuses: Map<string, StationStatus>;
  now: Date;
  area: (stationId: string) => string | null;
  onSelectStation: (id: string) => void;
  onOpenPlace: (place: Place) => void;
  /** Show a point on the map. */
  onFocus: (lat: number, lng: number) => void;
  onUnlock: (label: string, perk: Perk) => void;
}

const range = (it: ItineraryItem) => (it.until > it.at + 60_000 ? `${clockLabel(it.at)}–${clockLabel(it.until)}` : clockLabel(it.at));

export function DayTimeline(props: DayTimelineProps) {
  const { day: d, index: di, places, route } = props;
  const byId = new Map((places?.places ?? []).map((p) => [p.id, p]));
  // A roadside place we also have full details for opens its card; others just show on the map.
  const openPoi = (p: PlaceOnRoute) => {
    const full = byId.get(p.place.id);
    if (full) props.onOpenPlace(full);
    else props.onFocus(p.place.lat, p.place.lng);
  };
  const focusKm = (km: number) => {
    const [lng, lat] = route.pointAt(km);
    props.onFocus(lat, lng);
  };

  return (
    <ol class="timeline" data-testid={`itinerary-day-${di + 1}`}>
      {d.items.map((it, k) => {
        const key = `${it.kind}-${k}`;
        switch (it.kind) {
          case 'depart':
            return (
              <li key={key} class="timeline__end" data-kind="depart">
                <span class="timeline__dot" aria-hidden="true" />
                <div>
                  <strong>{di === 0 ? props.fromName : `Morning at ${props.startName}`}</strong>
                  <span class="muted">
                    <span class="timeline__time">{clockLabel(it.at)}</span> Leave with {d.startSocPct}%
                  </span>
                </div>
              </li>
            );
          case 'charge': {
            const s = d.plan.stops[it.stopIndex!];
            return <StopCard key={key} {...props} item={it} stop={s} no={props.firstStopNo + it.stopIndex! + 1} />;
          }
          case 'break':
            return (
              <li key={key} class="timeline__item" data-kind="break">
                <span class="timeline__dot timeline__dot--small" aria-hidden="true">
                  <Coffee size={12} />
                </span>
                <div>
                  <button type="button" class="timeline__line" onClick={() => (it.poi ? openPoi(it.poi) : focusKm(it.km))}>
                    <span class="timeline__time">{range(it)}</span>
                    {it.poi ? (
                      <span>
                        Break at <strong>{it.poi.place.name}</strong>
                        <span class="muted">
                          {' '}
                          · {CAT_LABEL[it.poi.place.cat]}, km {Math.round(it.km)}
                        </span>
                      </span>
                    ) : (
                      <span>Take a short break around km {Math.round(it.km)}</span>
                    )}
                  </button>
                  <span class="small muted">{Math.round(it.drivenSinceRestMin)} min since your last rest. Stretch, water, toilets.</span>
                </div>
              </li>
            );
          case 'meal':
            return (
              <li key={key} class="timeline__item" data-kind="meal">
                <span class="timeline__dot timeline__dot--small timeline__dot--food" aria-hidden="true">
                  <Utensils size={12} />
                </span>
                <div>
                  <button type="button" class="timeline__line" onClick={() => (it.poi ? openPoi(it.poi) : focusKm(it.km))}>
                    <span class="timeline__time">{range(it)}</span>
                    {it.poi ? (
                      <span>
                        {it.meal} at <strong>{it.poi.place.name}</strong>
                        <span class="muted"> · km {Math.round(it.km)}</span>
                      </span>
                    ) : (
                      <span>
                        {it.meal} around km {Math.round(it.km)}
                      </span>
                    )}
                  </button>
                  {!it.poi && <span class="small muted">No restaurant is mapped right here. Stop at the next restaurant or dhaba you see.</span>}
                </div>
              </li>
            );
          case 'gap': {
            const g = it.gap!;
            return (
              <li key={key} class="timeline__item timeline__item--gap" data-kind="gap" data-testid="itinerary-gap">
                <span class="timeline__dot timeline__dot--small timeline__dot--gap" aria-hidden="true">
                  <AlertTriangle size={12} />
                </span>
                <div>
                  <button type="button" class="timeline__line" onClick={() => focusKm((g.fromKm + g.toKm) / 2)}>
                    <span>
                      <strong>No confirmed car charger for {Math.round(g.toKm - g.fromKm)} km</strong> between {g.fromName ?? (di === 0 ? props.fromName : "last night's stop")} (km{' '}
                      {Math.round(g.fromKm)}) and {g.toName ?? (d.night ? "tonight's stop" : props.toName)} (km {Math.round(g.toKm)})
                    </span>
                  </button>
                  {g.unconfirmed.length > 0 ? (
                    <div class="backups">
                      <span class="small muted">Chargers we can't confirm in this stretch. Call ahead before you rely on them:</span>
                      {g.unconfirmed.slice(0, 5).map((u) => (
                        <button key={u.station.id} type="button" class="backup" onClick={() => props.onSelectStation(u.station.id)}>
                          {u.station.name} · km {Math.round(d.startKm + u.alongKm)} · {u.mode.toUpperCase()} {Math.round(u.powerKw)} kW
                        </button>
                      ))}
                    </div>
                  ) : (
                    <span class="small muted">We don't know of any car charger in this stretch.</span>
                  )}
                  <span class="small muted">The rest of the plan assumes you get past it.</span>
                </div>
              </li>
            );
          }
          case 'night':
            return d.overnight ? <OvernightCard key={key} {...props} item={it} /> : <NightCard key={key} {...props} item={it} />;
          case 'arrive':
            return (
              <li key={key} class="timeline__end" data-kind="arrive">
                <span class="timeline__dot timeline__dot--end" aria-hidden="true">
                  <Flag size={11} />
                </span>
                <div>
                  <strong>{props.toName}</strong>
                  <span class="muted">
                    <span class="timeline__time">{clockLabel(it.at)}</span> Arrive with about {Math.max(0, d.plan.arrivalSocPct)}%
                    {it.meal ? ` · ${it.meal.toLowerCase()} time` : ''}
                  </span>
                </div>
              </li>
            );
        }
      })}
    </ol>
  );
}

function StopCard(props: DayTimelineProps & { item: ItineraryItem; stop: Stop; no: number }) {
  const { item: it, stop: s, day: d, plan } = props;
  const food = nearbyPlaces(props.places, s.station.id, 'f');
  return (
    <li class="timeline__stop" data-kind="charge">
      <span class="timeline__dot timeline__dot--stop" aria-hidden="true">
        {props.no}
      </span>
      <div>
        <span class="timeline__time timeline__time--block">
          {range(it)}
          {it.meal && (
            <span class="pill pill--meal">
              <Utensils size={11} aria-hidden="true" /> {it.meal} here
            </span>
          )}
        </span>
        <button class="timeline__name" onClick={() => props.onSelectStation(s.station.id)}>
          {s.station.name}
        </button>
        <span class="muted">
          km {Math.round(d.startKm + s.alongKm)}
          {s.station.operator ? ` · ${s.station.operator}` : ''}
          {food.length > 0 ? ' · food nearby' : ''}
        </span>
        <div class="timeline__charge">
          Arrive {s.arriveSocPct}% → charge to <strong>{s.departSocPct}%</strong> · about {s.chargeMinutes} min · ₹{s.costInr}
        </div>
        <div class="badges">
          <span class={`badge badge--${s.confidence}`}>{CONFIDENCE_LABEL[s.confidence]}</span>
          <LiveBadge state={liveState(props.statuses.get(s.station.id), props.now)} />
        </div>
        <ul class="timeline__notes">
          {s.afterGap && <li>First confirmed charger after the gap: arrive with your reserve, if you got past it.</li>}
          {s.notes.map((n) => (
            <li key={n}>{n}</li>
          ))}
        </ul>
        {s.backups.length > 0 &&
          (plan.backups ? (
            <div class="backups">
              <span class="small muted">If it's busy or down:</span>
              {s.backups.map((b) => (
                <button key={b.station.id} class="backup" onClick={() => props.onSelectStation(b.station.id)}>
                  {b.station.name} · km {Math.round(d.startKm + b.alongKm)} · arrive {b.arriveSocPct}% · {b.mode.toUpperCase()} {b.powerKw} kW
                  {b.trusted ? '' : ' · unverified'}
                </button>
              ))}
            </div>
          ) : (
            <PerkLock
              text={`${s.backups.length} backup charger${s.backups.length > 1 ? 's' : ''} found for this stop`}
              plan={cheapestWith('backups')}
              onUnlock={() => props.onUnlock('Backup chargers', 'backups')}
            />
          ))}
        {food.length > 0 && (
          <details class="stop-places" open={Boolean(it.meal)}>
            <summary>
              <Utensils size={14} aria-hidden="true" /> {food.length} place
              {food.length > 1 ? 's' : ''} to eat while you charge
            </summary>
            <PlaceList items={food} area={props.area(s.station.id)} limit={3} onOpen={props.onOpenPlace} />
          </details>
        )}
      </div>
    </li>
  );
}

export function LiveBadge({ state }: { state: ReturnType<typeof liveState> }) {
  return (
    <span class="badge">
      <span class="dot" style={{ background: LIVE_COLOUR[state] }} aria-hidden="true" /> {LIVE_LABEL[state]}
    </span>
  );
}

function Stays({
  stays,
  food,
  area,
  onOpenPlace,
  radius,
}: {
  stays: NearbyPlace[];
  food: NearbyPlace[];
  area: string | null;
  onOpenPlace: (p: Place) => void;
  radius: string;
}) {
  const onsite = stays.filter((s) => s.place.chargerOnSite).length;
  return (
    <>
      {stays.length > 0 ? (
        <>
          <p class="small muted">
            {stays.length} stay{stays.length > 1 ? 's' : ''} {radius}
            {onsite ? `, ${onsite} with a charger on site` : ''}.
          </p>
          <PlaceList items={stays} area={area} limit={3} onOpen={onOpenPlace} />
        </>
      ) : (
        <p class="small muted">No hotel is mapped right here. Search nearby on the map, or ask a hotel about a 3-pin socket.</p>
      )}
      {food.length > 0 && (
        <details class="stop-places">
          <summary>
            <Utensils size={14} aria-hidden="true" /> {food.length} place
            {food.length > 1 ? 's' : ''} for dinner nearby
          </summary>
          <PlaceList items={food} area={area} limit={3} onOpen={onOpenPlace} />
        </details>
      )}
    </>
  );
}

function OvernightCard(props: DayTimelineProps & { item: ItineraryItem }) {
  const { day, index, item: it } = props;
  const night = day.overnight!;
  const area = props.area(night.station.id);
  return (
    <li class="timeline__stop--night" data-kind="night" data-testid={`night-${index + 1}`}>
      <span class="timeline__dot timeline__dot--night" aria-hidden="true">
        <Moon size={14} />
      </span>
      <div class="overnight">
        <span class="overnight__label">
          Night {index + 1} · arrive {clockLabel(it.at)}
          {it.meal ? ' · dinner here' : ''}
        </span>
        <button class="timeline__name" onClick={() => props.onSelectStation(night.station.id)}>
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
            Arrive {Math.max(0, day.plan.arrivalSocPct)}%. No source gives this charger's speed, so we can't say how full the battery will be by morning. Ask
            the site, or plan a stop early on day {index + 2}.
          </div>
        ) : (
          <div class="timeline__charge">
            Arrive {Math.max(0, day.plan.arrivalSocPct)}% → <strong>{night.morningSocPct === 100 ? '100%' : `about ${night.morningSocPct}%`} by morning</strong>{' '}
            · {night.morningSocPct === 100 ? `about ${night.hoursToFull} h` : `${night.hoursToFull} h to full`} on {night.mode.toUpperCase()} {night.powerKw} kW
          </div>
        )}
        {!night.trusted && <p class="small muted">Nobody has confirmed this charger recently. Call the site before you rely on it for the night.</p>}
        {night.station.access === 'customers' && <p class="small muted">Customers only: book a room there, or ask before you plug in.</p>}
        {!night.speedUnknown && night.morningSocPct < 100 && (
          <p class="small muted">A slow charger: a night here won't fill the battery, so day {index + 2} starts lower and may need an extra stop.</p>
        )}
        <Stays stays={night.stays} food={night.food} area={area} onOpenPlace={props.onOpenPlace} radius="within 3 km. Plug in, check in, sleep" />
      </div>
    </li>
  );
}

/** A night with no charger: a roadside hotel the car reaches with enough charge for the morning, or just a km mark. */
function NightCard(props: DayTimelineProps & { item: ItineraryItem }) {
  const { day, index, item: it } = props;
  const night = day.night!;
  const stay = night.kind === 'stay';
  return (
    <li class="timeline__stop--night" data-kind="night" data-testid={`night-${index + 1}`}>
      <span class="timeline__dot timeline__dot--night" aria-hidden="true">
        {stay ? <BedDouble size={14} /> : <MapPin size={14} />}
      </span>
      <div class="overnight">
        <span class="overnight__label">
          Night {index + 1} · arrive {clockLabel(it.at)}
          {it.meal ? ' · dinner here' : ''}
        </span>
        <button class="timeline__name" onClick={() => props.onFocus(night.lat, night.lng)}>
          {stay ? night.name : `Stop for the night around km ${Math.round(night.alongKm)}`}
        </button>
        <span class="muted">km {Math.round(night.alongKm)}</span>
        <div class="timeline__charge">
          {stay
            ? day.plan.feasible
              ? `No charger here. Arrive with about ${Math.max(0, night.arriveSocPct)}%, enough to reach the next charger in the morning.`
              : "No charger here, and today's drive has a gap in the chargers, so we can't say how much charge you'll arrive with. Ask the hotel about a 3-pin socket for slow charging overnight."
            : `No charger or hotel is mapped near here. Arrive with about ${Math.max(0, night.arriveSocPct)}%; ask a hotel about a 3-pin socket for slow charging overnight.`}
        </div>
        <Stays stays={night.stays} food={night.food} area={null} onOpenPlace={props.onOpenPlace} radius={stay ? 'here' : 'within 15 km'} />
      </div>
    </li>
  );
}

function hm(minutes: number): string {
  const h = Math.floor(minutes / 60);
  const m = Math.round(minutes % 60);
  return h ? `${h} h ${m.toString().padStart(2, '0')} min` : `${m} min`;
}

export function RouteCompareCards({ routes, active, onChoose }: { routes: { analysis: RouteAnalysis }[]; active: number; onChoose: (i: number) => void }) {
  return (
    <section class="routes" aria-label="Compare routes">
      <h3>
        <Split size={14} aria-hidden="true" /> {routes.length} routes compared
      </h3>
      <div class="routes__list" role="radiogroup" aria-label="Choose a route">
        {routes.map(({ analysis: a }, i) => (
          <button
            key={a.label}
            role="radio"
            aria-checked={i === active}
            class={`route-card${i === active ? ' is-on' : ''}${a.feasible ? '' : ' route-card--bad'}`}
            onClick={() => onChoose(i)}
            data-testid={`route-${i}`}
          >
            <span class="route-card__head">
              <strong>{a.label}</strong>
              {i === active && <span class="route-card__check" aria-hidden="true" />}
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

/** Where the plan's data comes from, and what it can miss. */
export function TripCoverage({ coverage, hasCorridor }: { coverage: { confirmed: number; unconfirmed: number }; hasCorridor: boolean }) {
  return (
    <p class="small muted coverage" data-testid="trip-coverage">
      Based on {coverage.confirmed} confirmed car charger
      {coverage.confirmed === 1 ? '' : 's'} near this road
      {coverage.unconfirmed ? ` and ${coverage.unconfirmed} we can't confirm` : ''} (OpenStreetMap, Open Charge Map and state open data). Our map doesn't have
      every charger, so a new one may be missing.
      {hasCorridor ? ' Rest stops, food and hotels on the way are from OpenStreetMap.' : ''} Breaks are planned at least every 2 hours, lunch 12:30–14:30 and
      dinner 19:30–21:30.
    </p>
  );
}

/** Unconfirmed chargers on this road that could fill a gap. */
export function ExtraOptions({ extras, onSelectStation }: { extras: { s: Stop; km: number }[]; onSelectStation: (id: string) => void }) {
  return (
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
  );
}
