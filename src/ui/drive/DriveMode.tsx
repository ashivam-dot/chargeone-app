import { AlertTriangle, BatteryCharging, Check, FlaskConical, Flag, Gauge, MapPin, Navigation, Smartphone, Star, Volume2, VolumeX, X, Zap } from 'lucide-preact';
import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import type { Station } from '../../data/model.ts';
import { createDriveSession, type DriveAlert, type DriveSession, type DriveState, type PlannedStop, formatKm } from '../../drive/driveEngine.ts';
import { ensureNotifyPermission, haptic, isNative, keepAwake, notify } from '../../native/platform.ts';
import { liveState, type LiveState, type StationStatus } from '../../shared/status.ts';
import type { MyVehicle } from '../../shared/vehicles.ts';
import type { DemoChargeStop } from '../../vehicle/demoCar.ts';
import { BatteryGauge } from '../car/CarScreen.tsx';
import { connectDemo, connectPhone, disconnectCar, useCarLink } from '../car/carLink.ts';
import type { DriveRequest } from '../TripPlanner.tsx';
import '../car/car.css';
import './drive.css';

export interface CarPosition {
  lng: number;
  lat: number;
  headingDeg: number;
}

interface Props {
  request: DriveRequest;
  vehicle: MyVehicle;
  stations: Station[];
  statuses: Map<string, StationStatus>;
  /** Phone tracking and OBD-II need Plus or a trial; the demo drive is open to everyone. */
  canDriveLive: boolean;
  onCar: (pos: CarPosition | null) => void;
  onUnlock: () => void;
  onFeedback: () => void;
  onClose: () => void;
}

interface PlanStops {
  stops: PlannedStop[];
  demo: DemoChargeStop[];
  startSocPct: number;
}

/** The trip's charging stops on one axis: stop distances are per day, so they're offset by the day's start. */
export function planStops(req: DriveRequest): PlanStops {
  const stops: PlannedStop[] = [];
  const demo: DemoChargeStop[] = [];
  for (const day of req.journey.days) {
    for (const s of day.plan.stops) {
      const alongKm = day.startKm + s.alongKm;
      stops.push({ stationId: s.station.id, name: s.station.name, alongKm, plannedArriveSocPct: s.arriveSocPct, lat: s.lat, lng: s.lng, powerKw: s.powerKw, chargeMinutes: s.chargeMinutes });
      demo.push({ alongKm, toPct: s.departSocPct, powerKw: s.powerKw });
    }
    const o = day.overnight;
    if (o) {
      stops.push({ stationId: o.station.id, name: o.station.name, alongKm: o.alongKm, plannedArriveSocPct: day.plan.arrivalSocPct, lat: o.station.lat, lng: o.station.lng, powerKw: o.powerKw, chargeMinutes: 0 });
      demo.push({ alongKm: o.alongKm, toPct: o.morningSocPct, powerKw: o.powerKw });
    }
  }
  return { stops, demo, startSocPct: req.journey.days[0]?.startSocPct ?? 80 };
}

const LIVE_TEXT: Record<LiveState, string> = { working: 'Working', in_use: 'In use', problem: 'Reported problem', unknown: 'No recent reports' };

function fmtEta(min: number): string {
  if (!Number.isFinite(min)) return '--';
  const h = Math.floor(min / 60);
  const m = Math.round(min % 60);
  return h ? `${h} h ${m} min` : `${m} min`;
}

function arrivalClock(min: number, nowMs: number): string {
  if (!Number.isFinite(min)) return '';
  return new Date(nowMs + min * 60_000).toLocaleTimeString('en-IN', { hour: 'numeric', minute: '2-digit' });
}

type Phase = 'choose' | 'driving' | 'arrived';

export function DriveMode({ request, vehicle, stations, statuses, canDriveLive, onCar, onUnlock, onFeedback, onClose }: Props) {
  const link = useCarLink();
  const plan = useMemo(() => planStops(request), [request]);
  const sessionRef = useRef<DriveSession | null>(null);
  const lastAt = useRef<number>(0);
  const [phase, setPhase] = useState<Phase>('choose');
  const [demo, setDemo] = useState(false);
  const [state, setState] = useState<DriveState | null>(null);
  const [alert, setAlert] = useState<DriveAlert | null>(null);
  const [voiceOn, setVoiceOn] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const totalKm = request.journey.distanceKm;

  const liveStates = useMemo(() => {
    const now = new Date();
    const m = new Map<string, LiveState>();
    for (const [id, s] of statuses) m.set(id, liveState(s, now));
    return m;
  }, [statuses]);

  /** Set when this drive connected the car itself; a link made on the Car tab stays up. */
  const ownsLink = useRef(false);

  useEffect(() => {
    void keepAwake(true);
    return () => {
      void keepAwake(false);
      onCar(null);
      if (ownsLink.current) void disconnectCar();
    };
  }, []);

  const begin = async (useDemo: boolean) => {
    void haptic('medium');
    setError(null);
    sessionRef.current = createDriveSession({
      route: request.route,
      stops: plan.stops,
      plannedArrivalSocPct: request.journey.arrivalSocPct,
      vehicle,
      planOptions: request.options,
      stations,
      routeDurationMin: request.durationMin,
    });
    lastAt.current = 0;
    setDemo(useDemo);
    void ensureNotifyPermission();
    try {
      if (useDemo) {
        ownsLink.current = true;
        await connectDemo({ vehicle, route: request.route, startSocPct: plan.startSocPct, scenario: 'range_drop', chargeStops: plan.demo, speedup: 60 });
      } else if (link.state !== 'connected' || link.kind === 'demo') {
        ownsLink.current = true;
        await connectPhone(vehicle, plan.startSocPct);
      }
      setPhase('driving');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not start the drive.');
    }
  };

  const t = link.telemetry;
  useEffect(() => {
    const session = sessionRef.current;
    if (phase !== 'driving' || !session || !t || t.at === lastAt.current) return;
    lastAt.current = t.at;
    const next = session.update(t, t.at, liveStates);
    setState(next);
    if (t.lat !== null && t.lng !== null) onCar({ lng: t.lng, lat: t.lat, headingDeg: t.headingDeg ?? 0 });
    for (const a of next.alerts) raise(a);
  }, [t, phase]);

  const raise = (a: DriveAlert) => {
    if (a.kind === 'arrived') {
      void haptic('success');
      setPhase('arrived');
      void notify({ id: 9001, title: 'You have arrived', body: `${Math.round(totalKm)} km done. How was the trip?` });
      if (voiceOn) void import('../../voice/speech.ts').then((m) => m.speak('You have arrived. Have a great time!', 'en'));
      return;
    }
    setAlert((cur) => (cur && rank(cur) > rank(a) ? cur : a));
    void haptic(a.severity === 'critical' ? 'error' : 'warning');
    if (isNative || document.hidden) void notify({ id: hashId(a.id), title: a.title, body: a.body });
    if (voiceOn) void import('../../voice/speech.ts').then((m) => m.speak(`${a.title}. ${a.body}`, 'en'));
  };

  const switchStop = () => {
    const s = sessionRef.current;
    if (!s || !alert?.suggestion) return;
    s.switchTo(alert.suggestion);
    s.acknowledge(alert.id);
    void haptic('success');
    void notify({ id: 9002, title: 'Plan updated', body: `Next charge: ${alert.suggestion.name}` });
    setAlert(null);
  };

  const keepPlan = () => {
    if (alert) sessionRef.current?.acknowledge(alert.id);
    setAlert(null);
  };

  const end = async () => {
    void haptic('light');
    void import('../../voice/speech.ts').then((m) => m.stopSpeaking());
    if (ownsLink.current) {
      ownsLink.current = false;
      await disconnectCar();
    }
    onClose();
  };

  if (phase === 'choose') {
    return (
      <div class="drive drive--choose" role="dialog" aria-modal="true" aria-label="Start a drive" data-testid="drive-choose">
        <div class="drive-sheet">
          <div class="drive-sheet__head">
            <div>
              <span class="eyebrow">Live drive</span>
              <h2>
                {request.from.name} <span class="muted">to</span> {request.to.name}
              </h2>
            </div>
            <button class="icon-btn" onClick={() => void end()} aria-label="Close">
              <X size={20} />
            </button>
          </div>
          <p class="muted small">ChargeOne follows your battery as you drive and warns you early if it's running down faster than planned, with a closer charger to switch to.</p>
          <button class="drive-option" onClick={() => (canDriveLive ? void begin(false) : onUnlock())} data-testid="drive-live">
            <span class="drive-option__icon" aria-hidden="true">
              <Smartphone size={22} />
            </span>
            <span class="drive-option__text">
              <strong>Drive now</strong>
              <span>
                {link.state === 'connected' && link.kind !== 'demo' ? `Using your ${link.kind === 'obd' ? 'OBD-II adapter' : 'phone'}` : `Phone GPS, starting at ${plan.startSocPct}% battery`}
              </span>
            </span>
            {!canDriveLive && <span class="pill pill--plus">Plus</span>}
          </button>
          <button class="drive-option" onClick={() => void begin(true)} data-testid="drive-demo">
            <span class="drive-option__icon drive-option__icon--demo" aria-hidden="true">
              <FlaskConical size={22} />
            </span>
            <span class="drive-option__text">
              <strong>Watch a demo drive</strong>
              <span>A simulated car on this route at 60× speed. Partway through, consumption jumps so you can see an alert.</span>
            </span>
            <span class="pill pill--demo">Demo</span>
          </button>
          {error && (
            <p class="notice notice--error" role="alert">
              {error}
            </p>
          )}
        </div>
      </div>
    );
  }

  const soc = state?.socPct ?? t?.socPct ?? null;
  const kmDone = state?.kmDone ?? 0;
  const progress = totalKm > 0 ? Math.min(1, kmDone / totalKm) : 0;
  const delta = state?.consumptionDeltaPct ?? null;
  const next = state?.nextStop ?? null;
  const now = t?.at ?? Date.now();
  const arrive = state?.projectedSocAtDestinationPct ?? null;

  if (phase === 'arrived') {
    return (
      <div class="drive drive--arrived" role="dialog" aria-modal="true" aria-label="Trip complete" data-testid="drive-arrived">
        <div class="drive-sheet drive-sheet--center">
          <div class="arrive-badge" aria-hidden="true">
            <Flag size={30} />
          </div>
          <h2>You've arrived</h2>
          <p class="muted">
            {request.to.name}
            {soc !== null ? ` with ${Math.round(soc)}% battery` : ''}
            {demo ? ' (demo drive)' : ''}
          </p>
          <div class="tiles tiles--3">
            <div class="tile">
              <span class="tile__label">Distance</span>
              <div class="tile__value">
                {Math.round(kmDone || totalKm)}
                <small>km</small>
              </div>
            </div>
            <div class="tile">
              <span class="tile__label">Average</span>
              <div class="tile__value">
                {state?.liveWhPerKm ? Math.round(state.liveWhPerKm) : '--'}
                <small>Wh/km</small>
              </div>
            </div>
            <div class="tile">
              <span class="tile__label">Plan</span>
              <div class="tile__value">
                {Math.round(state?.plannedWhPerKm ?? 0)}
                <small>Wh/km</small>
              </div>
            </div>
          </div>
          <button class="btn btn--primary btn--block btn--lg" onClick={onFeedback} data-testid="drive-feedback">
            <Star size={18} aria-hidden="true" /> Rate this trip
          </button>
          <button class="btn btn--glass btn--block" onClick={() => void end()}>
            Done
          </button>
        </div>
      </div>
    );
  }

  return (
    <div class="drive" data-testid="drive-hud">
      <div class="drive-top">
        <div class="drive-next" aria-live="polite">
          <span class="drive-next__icon" aria-hidden="true">
            {next ? <Zap size={20} /> : <MapPin size={20} />}
          </span>
          <div class="drive-next__text">
            <span class="drive-next__label">{next ? `Next charge in ${Math.max(0, Math.round(next.kmAway))} km` : `Destination in ${Math.round(state?.kmLeft ?? totalKm)} km`}</span>
            <strong>{next ? next.name : request.to.name}</strong>
            {next && (
              <span class={`drive-next__live drive-next__live--${next.liveState}`}>
                {LIVE_TEXT[next.liveState]} · {Math.round(next.powerKw)} kW
                {state?.projectedSocAtNextStopPct !== null && state?.projectedSocAtNextStopPct !== undefined ? ` · arrive ${Math.round(state.projectedSocAtNextStopPct)}%` : ''}
              </span>
            )}
          </div>
        </div>
        <div class="drive-top__actions">
          {demo && <span class="pill pill--demo">Demo · 60×</span>}
          <button class="icon-btn icon-btn--glass" onClick={() => setVoiceOn((v) => !v)} aria-label={voiceOn ? 'Mute voice alerts' : 'Turn on voice alerts'} aria-pressed={voiceOn}>
            {voiceOn ? <Volume2 size={18} /> : <VolumeX size={18} />}
          </button>
        </div>
      </div>

      {alert && (
        <div class={`drive-alert drive-alert--${alert.severity}`} role="alertdialog" aria-modal="false" aria-labelledby="drive-alert-title" data-testid="drive-alert">
          <div class="drive-alert__head">
            <span class="drive-alert__icon" aria-hidden="true">
              <AlertTriangle size={22} />
            </span>
            <strong id="drive-alert-title">{alert.title}</strong>
          </div>
          <p>{alert.body}</p>
          {alert.suggestion && (
            <div class="drive-alert__suggest">
              <BatteryCharging size={18} aria-hidden="true" />
              <span>
                <strong>{alert.suggestion.name}</strong>
                <span class="small muted">
                  {' '}
                  {formatKm(alert.suggestion.kmAway)} km away · {Math.round(alert.suggestion.powerKw)} kW · arrive with {Math.round(alert.suggestion.projectedArriveSocPct)}% · {LIVE_TEXT[alert.suggestion.liveState]}
                </span>
              </span>
            </div>
          )}
          <div class="actions">
            <button class="btn btn--glass" onClick={keepPlan} data-testid="alert-keep">
              {alert.suggestion ? 'Keep plan' : 'OK'}
            </button>
            {alert.suggestion && (
              <button class="btn btn--primary" onClick={switchStop} data-testid="alert-switch">
                <Check size={16} aria-hidden="true" /> Switch
              </button>
            )}
          </div>
        </div>
      )}

      <div class="drive-panel">
        <div class="drive-progress" style={{ '--p': progress }} aria-label={`${Math.round(kmDone)} of ${Math.round(totalKm)} km`}>
          <div class="drive-progress__fill" />
          {plan.stops.map((s) => (
            <span key={s.stationId + s.alongKm} class="drive-progress__stop" style={{ left: `${(s.alongKm / Math.max(1, totalKm)) * 100}%` }} />
          ))}
        </div>
        <div class="drive-panel__row">
          <BatteryGauge soc={soc} rangeKm={t?.rangeKm ?? null} charging={Boolean(t?.charging)} measured={Boolean(t?.socMeasured)} />
        </div>
        <div class="drive-stats">
          <div>
            <span class="tile__label">Speed</span>
            <strong>
              {t?.speedKmh !== null && t?.speedKmh !== undefined ? Math.round(t.speedKmh) : '--'}
              <small>km/h</small>
            </strong>
          </div>
          <div>
            <span class="tile__label">Arrive</span>
            <strong>{state ? arrivalClock(state.etaMin, now) : '--'}</strong>
            <span class="small muted">{state ? fmtEta(state.etaMin) : ''}</span>
          </div>
          <div class={arrive !== null && arrive < 10 ? 'drive-stats__bad' : undefined}>
            <span class="tile__label">At destination</span>
            <strong>
              {arrive === null ? '--' : arrive <= 0 ? 'Short' : Math.round(arrive)}
              {arrive !== null && arrive > 0 && <small>%</small>}
            </strong>
            {arrive !== null && arrive <= 0 && <span class="small">Needs a charge</span>}
          </div>
        </div>
        <div class="drive-panel__foot">
          {/* An open alert quotes consumption from when it fired; a live figure beside it would contradict it. */}
          {alert ? (
            <span />
          ) : (
            <span class={`drive-delta${delta !== null && delta > 10 ? ' drive-delta--bad' : delta !== null && delta < -5 ? ' drive-delta--good' : ''}`}>
              <Gauge size={15} aria-hidden="true" />
              {delta === null ? 'Learning your consumption…' : delta >= 0 ? `Using ${Math.round(delta)}% more than planned` : `Using ${Math.round(-delta)}% less than planned`}
            </span>
          )}
          <button class="btn btn--glass" onClick={() => void end()} data-testid="drive-end">
            <Navigation size={16} aria-hidden="true" /> End
          </button>
        </div>
      </div>
    </div>
  );
}

const SEVERITY = { info: 0, warn: 1, critical: 2 } as const;
const rank = (a: DriveAlert) => SEVERITY[a.severity];

function hashId(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return Math.abs(h) % 1_000_000;
}
