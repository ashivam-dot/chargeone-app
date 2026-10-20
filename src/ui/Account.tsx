import { Check, Minus, Sparkles } from 'lucide-preact';
import { useState } from 'preact/hooks';
import { api, type Me } from '../lib/api.ts';
import { PLANS, PLAN_ROWS } from '../shared/plans.ts';
import type { MyVehicle } from '../shared/vehicles.ts';
import { Sheet } from './Sheet.tsx';

interface Props {
  me: Me;
  vehicle: MyVehicle | null;
  dark: boolean;
  onToggleDark: () => void;
  onClose: () => void;
  onChanged: () => void;
  onSignedOut: () => void;
  onPlans: () => void;
  onGarage: () => void;
  onAbout: () => void;
}

function Meter({ label, used, of }: { label: string; used: number; of: number }) {
  const pct = Math.min(100, Math.round((used / Math.max(1, of)) * 100));
  return (
    <div class="meter">
      <div class="meter__label">
        <span>{label}</span>
        <strong>
          {used} of {of}
        </strong>
      </div>
      <div class="meter__track" role="progressbar" aria-label={label} aria-valuemin={0} aria-valuemax={of} aria-valuenow={used}>
        <div class={`meter__bar${pct >= 100 ? ' meter__bar--full' : ''}`} style={{ width: `${pct}%` }} />
      </div>
    </div>
  );
}

const dateFmt = (iso: string) => new Date(iso).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' });

export function Account({ me, vehicle, dark, onToggleDark, onClose, onChanged, onSignedOut, onPlans, onGarage, onAbout }: Props) {
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const plan = PLANS[me.plan];
  const e = me.entitlement;
  const subscribed = e?.source === 'razorpay' && e.status === 'active' && (me.plan === 'plus_monthly' || me.plan === 'plus_yearly');

  const act = async (label: string, fn: () => Promise<unknown>, after: () => void) => {
    setBusy(label);
    setError(null);
    try {
      await fn();
      after();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'That did not work. Try again.');
    } finally {
      setBusy(null);
    }
  };

  return (
    <Sheet title="Account" onClose={onClose} modal>
      <p>
        <strong>{me.user?.name ?? 'Driver'}</strong>
        <br />
        <span class="muted">{me.user?.email}</span>
      </p>

      <div class={`card plan-card${me.plan === 'free' ? '' : ' plan-card--paid'}`}>
        <div class="row">
          <div class="plan-card__info">
            <span class="muted small">Your plan</span>
            <strong class="plan-card__name">
              {me.plan !== 'free' && <Sparkles size={16} aria-hidden="true" />} {plan.name}
            </strong>
            <span class="small muted">{plan.tagline}</span>
          </div>
          <button class={`btn${me.plan === 'free' ? ' btn--primary' : ''}`} onClick={onPlans}>
            {me.plan === 'free' ? 'Upgrade' : 'Plans'}
          </button>
        </div>
        {e?.activeUntil && me.plan !== 'free' && (
          <p class="small muted">
            {e.status === 'cancelled' ? 'Cancelled, access until' : me.plan === 'trip_pass' ? 'Valid until' : 'Renews around'} {dateFmt(e.activeUntil)}
          </p>
        )}
        {me.usage && (
          <div class="meters">
            <Meter label="Short trips today" used={me.usage.shortToday} of={plan.shortTripsPerDay} />
            {plan.longTripQuota > 0 && (
              <Meter label={plan.longTripWindow === 'period' ? 'Long trips on this pass' : 'Long trips this month'} used={me.usage.longInWindow} of={plan.longTripQuota} />
            )}
          </div>
        )}
        <ul class="perks perks--compact">
          {PLAN_ROWS.slice(2).map((r) => {
            const v = r.value(plan);
            return (
              <li key={r.label} class={`perk${v === false ? ' perk--no' : ''}`}>
                {v === false ? <Minus size={16} aria-hidden="true" /> : <Check size={16} aria-hidden="true" />}
                <span>
                  {r.label}
                  {v === false && <span class="visually-hidden"> (not included)</span>}
                </span>
              </li>
            );
          })}
        </ul>
        {subscribed && (
          <button
            class="link danger"
            disabled={busy !== null}
            onClick={() => {
              if (confirm('Cancel Plus? You keep it until the end of the period you paid for.')) void act('cancel', api.cancel, onChanged);
            }}
          >
            {busy === 'cancel' ? 'Cancelling…' : 'Cancel subscription'}
          </button>
        )}
      </div>

      <div class="list">
        <button class="list__item" onClick={onGarage}>
          <span>Your car</span>
          <span class="muted">{vehicle?.name ?? 'Not set'}</span>
        </button>
        <button class="list__item" onClick={onToggleDark}>
          <span>Appearance</span>
          <span class="muted">{dark ? 'Dark' : 'Light'}</span>
        </button>
        <button class="list__item" onClick={onAbout}>
          <span>About and data sources</span>
        </button>
      </div>

      {error && (
        <p class="notice notice--error" role="alert">
          {error}
        </p>
      )}
      <div class="actions actions--stack">
        <button class="btn btn--block" disabled={busy !== null} onClick={() => void act('out', api.signOut, onSignedOut)}>
          Sign out
        </button>
        <button class="btn btn--block btn--ghost" disabled={busy !== null} onClick={() => void act('all', api.signOutEverywhere, onSignedOut)}>
          Sign out on all devices
        </button>
        <button
          class="btn btn--block btn--ghost danger"
          disabled={busy !== null}
          onClick={() => {
            if (confirm('Delete your account? Your trips are erased and any subscription is cancelled. Payment records are kept as the law requires.')) {
              void act('delete', api.deleteAccount, onSignedOut);
            }
          }}
        >
          {busy === 'delete' ? 'Deleting…' : 'Delete my account'}
        </button>
      </div>
    </Sheet>
  );
}
