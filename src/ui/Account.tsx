import { useState } from 'preact/hooks';
import { api, type Me } from '../lib/api.ts';
import { PLANS } from '../shared/plans.ts';
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

      <div class="card">
        <div class="row">
          <div>
            <span class="muted small">Plan</span>
            <strong class="block">{plan.name}</strong>
          </div>
          <button class="btn" onClick={onPlans}>
            {me.plan === 'free' ? 'Upgrade' : 'Plans'}
          </button>
        </div>
        {e?.activeUntil && me.plan !== 'free' && (
          <p class="small muted">
            {e.status === 'cancelled' ? 'Cancelled, access until' : me.plan === 'trip_pass' ? 'Valid until' : 'Renews around'} {dateFmt(e.activeUntil)}
          </p>
        )}
        {me.usage && (
          <p class="small">
            Today: {me.usage.shortToday} of {plan.shortTripsPerDay} short trips
            {plan.longTripQuota > 0 && ` · Long trips: ${me.usage.longInWindow} of ${plan.longTripQuota}`}
          </p>
        )}
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
