import { ArrowRight, BatteryCharging, Bell, Mic, Route, Sparkles, Zap } from 'lucide-preact';
import { useMemo, useState } from 'preact/hooks';
import { haptic } from '../../native/platform.ts';
import { TRIAL_DAYS } from '../../shared/plans.ts';
import { CUSTOM_VEHICLE_ID, VEHICLES, myVehicleFromModel, type MyVehicle } from '../../shared/vehicles.ts';
import { CarHero } from '../car/CarHero.tsx';
import { PAINTS } from '../car/carArt.ts';
import './onboarding.css';

interface Props {
  stationCount: number;
  dcCount: number;
  vehicle: MyVehicle | null;
  paint: string;
  /** False when this account or phone already had its free week. */
  trialAvailable: boolean;
  onPaint: (hex: string) => void;
  onVehicle: (v: MyVehicle) => void;
  onStartTrial: (v: MyVehicle) => void;
  onFinish: () => void;
}

type Step = 'intro' | 'car' | 'trial';

const brandOf = (name: string) => name.split(' ')[0];

const TRIAL_PERKS: Array<[typeof Route, string, string]> = [
  [Route, 'Compare routes', 'Up to 3 roads, with stops, cost and charger safety for each'],
  [Bell, 'Live drive alerts', 'A heads-up when battery falls faster than planned, with an earlier charger'],
  [BatteryCharging, 'Connect your car', 'Live battery, range and efficiency while you drive'],
  [Mic, 'Copilot in Hindi or English', 'Plan the whole trip by voice and ask anything on the way'],
];

export function Onboarding({ stationCount, dcCount, vehicle, paint, trialAvailable, onPaint, onVehicle, onStartTrial, onFinish }: Props) {
  const [step, setStep] = useState<Step>('intro');
  const [modelId, setModelId] = useState(vehicle?.modelId && vehicle.modelId !== CUSTOM_VEHICLE_ID ? vehicle.modelId : 'tata-nexon-ev-45');
  const brands = useMemo(() => [...new Set(VEHICLES.map((m) => brandOf(m.name)))], []);
  const [brand, setBrand] = useState(brandOf(VEHICLES.find((m) => m.id === modelId)?.name ?? 'Tata'));
  const model = VEHICLES.find((m) => m.id === modelId) ?? VEHICLES[0];
  const go = (s: Step) => {
    void haptic('light');
    const swap = () => setStep(s);
    if (document.startViewTransition) document.startViewTransition(swap);
    else swap();
  };

  const confirmCar = () => {
    const v = myVehicleFromModel(model);
    onVehicle(v);
    if (trialAvailable) go('trial');
    else onFinish();
  };

  return (
    <div class={`onboard onboard--${step}`} role="dialog" aria-modal="true" aria-label="Welcome to ChargeOne">
      <div class="onboard__aurora" aria-hidden="true" />
      <div class="onboard__grid" aria-hidden="true" />

      {step === 'intro' && (
        <section class="onboard__step onboard__intro">
          <div class="onboard__logo" aria-hidden="true">
            <img src="/icon.svg" alt="" width="72" height="72" />
            <span class="onboard__ring" />
            <span class="onboard__ring onboard__ring--2" />
          </div>
          <p class="onboard__kicker">
            <Zap size={14} aria-hidden="true" /> Made for Indian roads
          </p>
          <h1 class="onboard__headline">
            Road trips,
            <br />
            <span class="grad-text">fully charged.</span>
          </h1>
          <p class="onboard__lead">Live chargers drivers trust, routes compared side by side, and a copilot that speaks Hindi and English.</p>
          <ul class="onboard__stats">
            <li>
              <strong class="num">{stationCount.toLocaleString('en-IN')}</strong>
              <span>chargers mapped</span>
            </li>
            <li>
              <strong class="num">{dcCount.toLocaleString('en-IN')}</strong>
              <span>DC fast</span>
            </li>
            <li>
              <strong class="num">24×7</strong>
              <span>driver reports</span>
            </li>
          </ul>
          <div class="onboard__actions">
            <button class="btn btn--primary btn--lg btn--block" onClick={() => go('car')} data-testid="onboard-start">
              Get started <ArrowRight size={18} aria-hidden="true" />
            </button>
            <button class="btn btn--ghost btn--block" onClick={onFinish} data-testid="onboard-skip">
              Just explore the map
            </button>
          </div>
        </section>
      )}

      {step === 'car' && (
        <section class="onboard__step onboard__car">
          <p class="onboard__kicker">Step 1 of {trialAvailable ? 2 : 1}</p>
          <h1 class="onboard__title">What do you drive?</h1>
          <div class="onboard__hero">
            <CarHero key={modelId} modelId={modelId} paint={paint} connected driving={false} charging={false} label={`${model.name} preview`} />
          </div>
          <p class="onboard__model">
            <strong>{model.name}</strong>
            <span class="muted">
              {model.batteryKwh} kWh · {model.maxDcKw ? `DC ${model.maxDcKw} kW` : 'AC only'} · about {Math.round((model.batteryKwh * 1000) / model.highwayWhPerKm)} km highway
            </span>
          </p>
          <div class="swatches" role="radiogroup" aria-label="Paint">
            {PAINTS.map((p) => (
              <button
                key={p.id}
                class="swatch"
                role="radio"
                aria-checked={p.hex === paint}
                aria-label={p.name}
                style={{ '--c': p.hex }}
                onClick={() => {
                  void haptic('selection');
                  onPaint(p.hex);
                }}
              />
            ))}
          </div>
          <div class="onboard__brands" role="tablist" aria-label="Brand">
            {brands.map((b) => (
              <button key={b} role="tab" aria-selected={b === brand} class="chip" aria-pressed={b === brand} onClick={() => setBrand(b)}>
                {b}
              </button>
            ))}
          </div>
          <div class="onboard__models" role="listbox" aria-label="Model">
            {VEHICLES.filter((m) => brandOf(m.name) === brand).map((m) => (
              <button
                key={m.id}
                role="option"
                aria-selected={m.id === modelId}
                class={`onboard__modelbtn${m.id === modelId ? ' is-on' : ''}`}
                onClick={() => {
                  void haptic('selection');
                  setModelId(m.id);
                }}
              >
                {m.name.replace(`${brand} `, '')}
              </button>
            ))}
          </div>
          <div class="onboard__actions">
            <button class="btn btn--primary btn--lg btn--block" onClick={confirmCar} data-testid="onboard-car">
              This is my car <ArrowRight size={18} aria-hidden="true" />
            </button>
            <button class="btn btn--ghost btn--block" onClick={onFinish}>
              I'll add it later
            </button>
          </div>
        </section>
      )}

      {step === 'trial' && (
        <section class="onboard__step onboard__trial">
          <p class="onboard__kicker">Step 2 of 2</p>
          <div class="onboard__gift" aria-hidden="true">
            <Sparkles size={30} />
          </div>
          <h1 class="onboard__title">
            Your {model.name.split(' ').slice(1, 3).join(' ')} gets <span class="grad-text--plus">Plus free for {TRIAL_DAYS} days</span>
          </h1>
          <p class="onboard__lead">No card, no payment. It ends by itself after {TRIAL_DAYS} days and you move to the free plan.</p>
          <ul class="onboard__perks">
            {TRIAL_PERKS.map(([Icon, title, text], i) => (
              <li key={title} style={{ '--d': `${i * 90 + 150}ms` }}>
                <span class="rows__icon rows__icon--plus" aria-hidden="true">
                  <Icon size={18} />
                </span>
                <div>
                  <strong>{title}</strong>
                  <span>{text}</span>
                </div>
              </li>
            ))}
          </ul>
          <div class="onboard__actions">
            <button class="btn btn--plus btn--lg btn--block" onClick={() => onStartTrial(myVehicleFromModel(model))} data-testid="onboard-trial">
              <Sparkles size={18} aria-hidden="true" /> Start my free week
            </button>
            <button class="btn btn--ghost btn--block" onClick={onFinish} data-testid="onboard-basic">
              Not now, use the free version
            </button>
            <p class="small muted center">Sign in with Google to start. One free week per person and phone.</p>
          </div>
        </section>
      )}
    </div>
  );
}
