import { BadgeCheck, Bluetooth, CarFront, ChevronRight, FlaskConical, Info, Lock, Navigation2, Power, Smartphone, Sparkles } from 'lucide-preact';
import { useEffect, useState } from 'preact/hooks';
import { haptic } from '../../native/platform.ts';
import { TRIAL_DAYS } from '../../shared/plans.ts';
import { VEHICLES, baseWhPerKm, myVehicleFromModel, type MyVehicle, type VehicleModel } from '../../shared/vehicles.ts';
import { MAKER_NAMES } from '../../shared/vin.ts';
import { efficiencyScore, sohLabel } from '../../vehicle/health.ts';
import type { SourceKind, Telemetry } from '../../vehicle/types.ts';
import { Page } from '../shell/Page.tsx';
import { CarHero } from './CarHero.tsx';
import { CarStage } from './CarStage.tsx';
import { PaintSwatches } from './PaintSwatches.tsx';
import { connectDemo, connectObd, connectPhone, disconnectCar, setBatteryPct, useCarLink, type DetectedCar } from './carLink.ts';
import './car.css';
import '../screens.css';

interface Props {
  vehicle: MyVehicle | null;
  paint: string;
  /** Plus or a running trial: phone tracking and OBD-II are included. */
  canConnect: boolean;
  trialAvailable: boolean;
  onPaint: (hex: string) => void;
  onVehicle: (v: MyVehicle) => void;
  onGarage: () => void;
  onUnlock: () => void;
  onStartTrial: () => void;
}

const SOURCE_LABEL: Record<SourceKind, string> = { demo: 'Demo car', phone: 'Phone tracking', obd: 'OBD-II adapter' };

/**
 * Animates a number toward its new value so readings glide instead of jumping. The screen shows whole numbers,
 * so it only re-renders when the shown value moves by a whole step, not on every frame: telemetry arrives twice a
 * second and per-frame re-renders of the whole Car screen kept a slow phone's main thread busy all the time.
 */
function useTween(value: number | null, ms = 700, step = 1): number | null {
  const [shown, setShown] = useState(value);
  useEffect(() => {
    if (value === null || shown === null || matchMedia('(prefers-reduced-motion: reduce)').matches) {
      setShown(value);
      return;
    }
    const from = shown;
    const start = performance.now();
    let raf = 0;
    let lastStep = Math.round(from / step);
    const tick = (now: number) => {
      const t = Math.min(1, (now - start) / ms);
      const e = 1 - (1 - t) ** 3;
      const v = from + (value - from) * e;
      const s = Math.round(v / step);
      if (t >= 1) setShown(value);
      else if (s !== lastStep) {
        lastStep = s;
        setShown(s * step);
      }
      if (t < 1) raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [value]);
  return shown;
}

function Sparkline({ history }: { history: Telemetry[] }) {
  const pts = history.map((t) => t.whPerKm).filter((v): v is number => v !== null && v > 0);
  if (pts.length < 4) return <div class="spark spark--empty">Drive a little to see your consumption</div>;
  const lo = Math.min(...pts) * 0.92;
  const hi = Math.max(...pts) * 1.06;
  const w = 300;
  const h = 70;
  const xy = pts.map((v, i) => [(i / (pts.length - 1)) * w, h - ((v - lo) / Math.max(1, hi - lo)) * h] as const);
  const line = xy.map(([x, y], i) => `${i ? 'L' : 'M'}${x.toFixed(1)} ${y.toFixed(1)}`).join('');
  return (
    <svg class="spark" viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="none" role="img" aria-label={`Consumption trend, latest ${Math.round(pts[pts.length - 1])} watt-hours per kilometre`}>
      <defs>
        <linearGradient id="spark-fill" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stop-color="#2b6bff" stop-opacity="0.35" />
          <stop offset="1" stop-color="#2b6bff" stop-opacity="0" />
        </linearGradient>
        <linearGradient id="spark-line" x1="0" y1="0" x2="1" y2="0">
          <stop offset="0" stop-color="#2b6bff" />
          <stop offset="1" stop-color="#30d158" />
        </linearGradient>
      </defs>
      <path d={`${line}L${w} ${h}L0 ${h}Z`} fill="url(#spark-fill)" />
      <path d={line} fill="none" stroke="url(#spark-line)" stroke-width="2.4" vector-effect="non-scaling-stroke" stroke-linejoin="round" />
      <circle cx={xy[xy.length - 1][0]} cy={xy[xy.length - 1][1]} r="4" class="spark__dot" />
    </svg>
  );
}

export function BatteryGauge({ soc, rangeKm, charging, measured }: { soc: number | null; rangeKm: number | null; charging: boolean; measured: boolean }) {
  const s = useTween(soc);
  const r = useTween(rangeKm);
  const pct = s === null ? 0 : Math.max(0, Math.min(100, s));
  const level = pct < 20 ? ' battery--low' : pct < 40 ? ' battery--mid' : '';
  return (
    <div class={`battery${level}${charging ? ' battery--charging' : ''}`} style={{ '--soc': pct }} role="meter" aria-label="Battery" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(pct)}>
      <div class="battery__fill" />
      <div class="battery__text">
        <span class="battery__level">
          Battery
          <span class="battery__pct">
            {s === null ? '—' : Math.round(pct)}
            {s !== null && <small>%</small>}
          </span>
        </span>
        <span class="battery__range">
          {charging ? 'Charging' : measured ? 'Range' : 'Est. range'}
          <strong>{r === null ? '—' : `${Math.round(r)} km`}</strong>
        </span>
      </div>
    </div>
  );
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** What the OBD-II adapter learned from the car's VIN, compared with the car the driver chose. */
function DetectedCarNote({ detected, vehicle, onVehicle, onGarage }: { detected: DetectedCar; vehicle: MyVehicle; onVehicle: (v: MyVehicle) => void; onGarage: () => void }) {
  const maker = MAKER_NAMES[detected.maker];
  const built = detected.year ? `, built ${detected.month ? `${MONTHS[detected.month - 1]} ` : ''}${detected.year}` : '';
  const chosenMaker = vehicle.modelId.split('-')[0];
  if (detected.modelHints.includes(vehicle.modelId) || (detected.modelHints.length === 0 && chosenMaker === detected.maker)) {
    return (
      <p class="detected small" role="status" data-testid="car-detected">
        <BadgeCheck size={16} aria-hidden="true" /> Recognised over OBD-II: your {maker}
        {built}.
      </p>
    );
  }
  const options = detected.modelHints.map((id) => VEHICLES.find((m) => m.id === id)).filter((m): m is VehicleModel => Boolean(m));
  return (
    <section class="detected detected--ask" role="alert" data-testid="car-detected">
      <p class="small">
        <strong>The connected car is a {options.length ? options[0].name.replace(/ \d+(\.\d+)?$/, '') : maker}</strong>
        {built}, not a {vehicle.name}. Plans use the car you choose, so switch to get the right range.
      </p>
      <div class="actions">
        {options.map((m) => (
          <button key={m.id} class="btn btn--primary" onClick={() => onVehicle(myVehicleFromModel(m))}>
            Use {m.name}
          </button>
        ))}
        {options.length === 0 && (
          <button class="btn btn--primary" onClick={onGarage}>
            Change car
          </button>
        )}
      </div>
    </section>
  );
}

export function CarScreen({ vehicle, paint, canConnect, trialAvailable, onPaint, onVehicle, onGarage, onUnlock, onStartTrial }: Props) {
  const link = useCarLink();
  const t = link.telemetry;
  const [busy, setBusy] = useState<SourceKind | null>(null);
  const [batteryAsk, setBatteryAsk] = useState<SourceKind | null>(null);
  const [batteryPct, setBatteryPctInput] = useState(80);
  const live = link.state === 'connected';
  const speed = useTween(t?.speedKmh ?? null);

  if (!vehicle) {
    return (
      <Page title="My car" testId="screen-car">
        <div class="car-empty">
          <CarHero modelId="tata-nexon-ev-45" paint="#5e6266" connected={false} driving={false} charging={false} label="Add your car" />
          <p class="muted center">Add your EV to see live battery, range and health, and to plan trips that match your car.</p>
          <button class="btn btn--primary btn--block btn--lg" onClick={onGarage} data-testid="car-add">
            <CarFront size={18} aria-hidden="true" /> Add my car
          </button>
        </div>
      </Page>
    );
  }

  const run = async (kind: SourceKind, fn: () => Promise<void>) => {
    void haptic('medium');
    setBusy(kind);
    try {
      await fn();
      void haptic('success');
    } catch {
      void haptic('error');
    } finally {
      setBusy(null);
    }
  };

  const start = (kind: SourceKind, pct: number) => {
    setBatteryAsk(null);
    if (kind === 'phone') void run('phone', () => connectPhone(vehicle, pct));
    else if (kind === 'demo') void run('demo', () => connectDemo({ vehicle, startSocPct: pct, speedup: 12 }));
  };

  const rated = baseWhPerKm(vehicle);
  const eff = efficiencyScore(t?.whPerKm ?? null, rated);
  const kind = link.kind;
  const driving = live && (t?.speedKmh ?? 0) > 3;
  const charging = live && Boolean(t?.charging);
  const fullRange = Math.round((vehicle.batteryKwh * 1000) / rated);
  const shortName = vehicle.name.replace(/^(Tata|Mahindra|MG|Hyundai|Kia|BYD|Citroën|Maruti|Tesla|VinFast)\s/, '');

  return (
    <Page
      title={shortName}
      testId="screen-car"
      eyebrow={
        live && kind ? (
          <>
            <span class="pill pill--live">Live</span>
            <span class={`pill${kind === 'demo' ? ' pill--demo' : kind === 'obd' ? ' pill--beta' : ''}`}>
              {SOURCE_LABEL[kind]}
              {kind === 'demo' ? ' · simulated' : kind === 'obd' ? ' · beta' : ''}
            </span>
          </>
        ) : (
          <span class="pill">Not connected</span>
        )
      }
    >
      <div class="car-stage">
        <CarStage key={vehicle.modelId} modelId={vehicle.modelId} paint={paint} connected={live} driving={driving} charging={charging} speedKmh={t?.speedKmh} label={`${vehicle.name}${live ? ', connected' : ''}`} />
        <PaintSwatches modelId={vehicle.modelId} paint={paint} onPaint={onPaint} small />
      </div>

      <BatteryGauge
        soc={live ? (t?.socPct ?? null) : null}
        rangeKm={live ? (t?.rangeKm ?? null) : fullRange}
        charging={charging}
        measured={Boolean(t?.socMeasured)}
      />
      {!live && <p class="small muted car-note">About {fullRange} km on a full charge on the highway. Connect to see live figures.</p>}
      {live && kind === 'phone' && (
        <button class="link car-note" onClick={() => setBatteryAsk('phone')}>
          Battery % estimated from your drive. Tap to enter the figure your car shows.
        </button>
      )}

      {live && (
        <div class="tiles tiles--3 car-tiles">
          <div class="tile">
            <span class="tile__label">Speed</span>
            <div class="tile__value">
              {speed === null ? '--' : Math.round(speed)}
              <small>km/h</small>
            </div>
          </div>
          <div class="tile">
            <span class="tile__label">Using</span>
            <div class="tile__value">
              {t?.whPerKm ? Math.round(t.whPerKm) : '--'}
              <small>Wh/km</small>
            </div>
            <div class="tile__hint">{eff ? eff.label : `Rated ${Math.round(rated)}`}</div>
          </div>
          <div class="tile">
            <span class="tile__label">Power</span>
            <div class="tile__value">
              {t?.powerKw !== null && t?.powerKw !== undefined ? Math.round(t.powerKw) : '--'}
              <small>kW</small>
            </div>
            <div class="tile__hint">{charging ? 'Into battery' : (t?.powerKw ?? 0) < 0 ? 'Regenerating' : 'From battery'}</div>
          </div>
          <div class="tile">
            <span class="tile__label">Battery temp</span>
            <div class="tile__value">
              {t?.batteryTempC !== null && t?.batteryTempC !== undefined ? Math.round(t.batteryTempC) : '--'}
              <small>°C</small>
            </div>
            {t?.batteryTempC === null && <div class="tile__hint">Not shared by this source</div>}
          </div>
          <div class="tile tile--wide">
            <span class="tile__label">Battery health</span>
            <div class="tile__hint tile__hint--strong">{sohLabel(t?.sohPct ?? null, kind ?? 'phone')}</div>
          </div>
        </div>
      )}

      {live && (
        <section class="tile">
          <div class="row">
            <span class="tile__label">Consumption</span>
            {eff && <span class={`pill${eff.score >= 70 ? ' pill--live' : ''}`}>Efficiency {eff.score}</span>}
          </div>
          <Sparkline history={link.history} />
        </section>
      )}

      {link.detected && <DetectedCarNote detected={link.detected} vehicle={vehicle} onVehicle={onVehicle} onGarage={onGarage} />}

      {link.error && (
        <p class="notice notice--error" role="alert">
          {link.error}
        </p>
      )}

      {batteryAsk && (
        <section class="tile battery-ask" aria-label="Battery now">
          <label class="slider">
            <span>
              What does your car show now? <strong>{batteryPct}%</strong>
            </span>
            <input type="range" min={5} max={100} step={1} value={batteryPct} onInput={(e) => setBatteryPctInput(Number((e.target as HTMLInputElement).value))} />
          </label>
          <div class="actions">
            <button class="btn btn--glass" onClick={() => setBatteryAsk(null)}>
              Cancel
            </button>
            <button
              class="btn btn--primary"
              data-testid="battery-confirm"
              onClick={() => {
                if (live && kind === batteryAsk) {
                  setBatteryPct(batteryPct);
                  setBatteryAsk(null);
                } else start(batteryAsk, batteryPct);
              }}
            >
              {live && kind === batteryAsk ? 'Update' : 'Connect'}
            </button>
          </div>
        </section>
      )}

      <h2 class="section-title">Connect</h2>
      <div class="rows">
        {live && (
          <button class="rows__item" onClick={() => void disconnectCar()} data-testid="car-disconnect">
            <span class="rows__icon" aria-hidden="true">
              <Power size={18} />
            </span>
            <span class="rows__text">
              <strong>Disconnect</strong>
              <span>{kind ? SOURCE_LABEL[kind] : ''}</span>
            </span>
          </button>
        )}
        <button class="rows__item" disabled={busy !== null} onClick={() => (kind === 'demo' ? void disconnectCar() : setBatteryAsk('demo'))} data-testid="car-demo">
          <span class="rows__icon" aria-hidden="true">
            <FlaskConical size={18} />
          </span>
          <span class="rows__text">
            <strong>{kind === 'demo' ? 'Stop the demo car' : 'Try the demo car'}</strong>
            <span>A simulated drive from Mumbai to Pune. Not your real car.</span>
          </span>
          <ChevronRight size={18} class="rows__chev" aria-hidden="true" />
        </button>
        <button
          class="rows__item"
          disabled={busy !== null}
          onClick={() => (canConnect ? setBatteryAsk('phone') : onUnlock())}
          data-testid="car-phone"
        >
          <span class="rows__icon" aria-hidden="true">
            <Smartphone size={18} />
          </span>
          <span class="rows__text">
            <strong>Track with this phone</strong>
            <span>GPS and your car's energy model. You enter the battery % now and then.</span>
          </span>
          {canConnect ? <ChevronRight size={18} class="rows__chev" aria-hidden="true" /> : <Lock size={16} class="rows__chev" aria-hidden="true" />}
        </button>
        <button
          class="rows__item"
          disabled={busy !== null}
          onClick={() => (canConnect ? void run('obd', () => connectObd(vehicle)) : onUnlock())}
          data-testid="car-obd"
        >
          <span class="rows__icon" aria-hidden="true">
            <Bluetooth size={18} />
          </span>
          <span class="rows__text">
            <strong>
              OBD-II adapter <span class="pill pill--beta">Beta</span>
            </strong>
            <span>{busy === 'obd' ? 'Looking for your adapter…' : 'A Bluetooth LE ELM327 plugged in under the dashboard. Reads battery % and speed where the car shares them.'}</span>
          </span>
          {canConnect ? <ChevronRight size={18} class="rows__chev" aria-hidden="true" /> : <Lock size={16} class="rows__chev" aria-hidden="true" />}
        </button>
      </div>

      {!canConnect && (
        <button class="trial-offer" onClick={trialAvailable ? onStartTrial : onUnlock}>
          <span class="trial-offer__icon" aria-hidden="true">
            <Sparkles size={20} />
          </span>
          <span class="trial-offer__text">
            <strong>{trialAvailable ? `Connect free for ${TRIAL_DAYS} days` : 'Connect your car with Plus'}</strong>
            <span>Live battery, range and efficiency, plus drive alerts that warn you early.</span>
          </span>
        </button>
      )}

      <p class="car-oem small muted">
        <Info size={14} aria-hidden="true" /> Mahindra, Tata and MG don't offer a public way for other apps to read their connected-car data yet.
        When they do, ChargeOne will connect to it directly. Until then, phone tracking and OBD-II give you the live figures.
      </p>

      <button class="btn btn--glass btn--block" onClick={onGarage}>
        <Navigation2 size={16} aria-hidden="true" /> Change car or real-world range
      </button>
    </Page>
  );
}
