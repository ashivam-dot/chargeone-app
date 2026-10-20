import { CarFront, ChevronRight, Info, LogIn, MessageSquareHeart, Moon, Sparkles, Sun, Tag } from 'lucide-preact';
import { useState } from 'preact/hooks';
import { api, type Me } from '../lib/api.ts';
import { BASIC, FEATURE_ROWS, PLANS, TRIAL_DAYS, isPlus } from '../shared/plans.ts';
import type { MyVehicle } from '../shared/vehicles.ts';
import { PerkItem } from './Plans.tsx';
import { Page } from './shell/Page.tsx';
import './screens.css';

interface Props {
  me: Me | null;
  vehicle: MyVehicle | null;
  dark: boolean;
  onToggleDark: () => void;
  onChanged: () => void;
  onSignedOut: () => void;
  onSignIn: () => void;
  onPlans: () => void;
  onGarage: () => void;
  onAbout: () => void;
  onFeedback: () => void;
  onStartTrial: () => void;
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
const DAY_MS = 86_400_000;

function TrialRing({ endsAt }: { endsAt: string }) {
  const left = Math.max(0, Date.parse(endsAt) - Date.now());
  const days = Math.ceil(left / DAY_MS);
  const frac = Math.min(1, left / (TRIAL_DAYS * DAY_MS));
  const c = 2 * Math.PI * 26;
  return (
    <div class="trial-ring" role="img" aria-label={`${days} ${days === 1 ? 'day' : 'days'} of Plus trial left`}>
      <svg viewBox="0 0 64 64" aria-hidden="true">
        <defs>
          <linearGradient id="trial-ring-grad" x1="0" y1="0" x2="1" y2="1">
            <stop offset="0" stop-color="#a78bfa" />
            <stop offset="1" stop-color="#22d3ee" />
          </linearGradient>
        </defs>
        <circle cx="32" cy="32" r="26" class="trial-ring__track" />
        <circle cx="32" cy="32" r="26" class="trial-ring__bar" stroke-dasharray={`${c * frac} ${c}`} />
      </svg>
      <span>
        <strong class="num">{days}</strong>
        <small>{days === 1 ? 'day' : 'days'}</small>
      </span>
    </div>
  );
}

export function YouScreen(p: Props) {
  const { me, vehicle, dark } = p;
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const signedIn = Boolean(me?.user);
  const plan = me && signedIn ? PLANS[me.plan] : null;
  const e = me?.entitlement;
  const onTrial = e?.source === 'trial' && Boolean(me?.trial?.endsAt);
  const subscribed = e?.source === 'razorpay' && e.status === 'active' && me !== null && isPlus(me.plan);
  const trialOpen = !onTrial && (me?.trial?.eligible ?? !signedIn) && !(me && isPlus(me.plan));

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

  const name = me?.user?.name ?? me?.user?.email ?? 'Guest';
  const tierName = onTrial ? 'Plus trial' : plan ? plan.name : BASIC.name;

  return (
    <Page title="You" testId="screen-you">
      <section class="tile you__profile">
        <span class={`you__avatar${me && isPlus(me.plan) ? ' you__avatar--plus' : ''}`} aria-hidden="true">
          {signedIn ? name.slice(0, 1).toUpperCase() : <LogIn size={22} />}
        </span>
        <div class="you__who">
          <strong>{signedIn ? name : 'Using ChargeOne Basic'}</strong>
          <span class="muted">{signedIn ? me?.user?.email : 'No sign-in needed. Sign in free for more trips.'}</span>
        </div>
        {!signedIn && (
          <button class="btn btn--primary" onClick={p.onSignIn} data-testid="you-signin">
            Sign in
          </button>
        )}
      </section>

      <section class={`tile you__plan${onTrial || (me && isPlus(me.plan)) ? ' you__plan--plus' : ''}`}>
        <div class="row">
          <div>
            <span class="tile__label">Your plan</span>
            <h2 class="you__tier">
              {(onTrial || (me && me.plan !== 'free')) && <Sparkles size={18} aria-hidden="true" />} {tierName}
            </h2>
            <span class="small muted">
              {onTrial && me?.trial?.endsAt
                ? `Free until ${dateFmt(me.trial.endsAt)}. No payment, ends by itself.`
                : e?.activeUntil && me?.plan !== 'free'
                  ? `${e.status === 'cancelled' ? 'Cancelled, access until' : me?.plan === 'trip_pass' ? 'Valid until' : 'Renews around'} ${dateFmt(e.activeUntil)}`
                  : plan
                    ? plan.tagline
                    : `${BASIC.shortTripsPerDay} trip plan a day, up to ${BASIC.maxTripKm} km`}
            </span>
          </div>
          {onTrial && me?.trial?.endsAt && <TrialRing endsAt={me.trial.endsAt} />}
        </div>

        {me?.usage && plan && (
          <div class="meters">
            <Meter label="Short trips today" used={me.usage.shortToday} of={plan.shortTripsPerDay} />
            {plan.longTripQuota > 0 && (
              <Meter label={plan.longTripWindow === 'period' ? 'Long trips on this pass' : 'Long trips this month'} used={me.usage.longInWindow} of={plan.longTripQuota} />
            )}
          </div>
        )}
        {!signedIn && me?.basicToday !== null && me?.basicToday !== undefined && (
          <div class="meters">
            <Meter label="Trip plans today" used={me.basicToday} of={BASIC.shortTripsPerDay} />
          </div>
        )}

        {plan && (
          <ul class="perks perks--compact">
            {FEATURE_ROWS.map((r) => (
              <PerkItem key={r.label} label={r.label} value={r.value(plan)} />
            ))}
          </ul>
        )}

        <div class="actions">
          {trialOpen && vehicle && (
            <button class="btn btn--plus" onClick={p.onStartTrial} data-testid="you-trial">
              <Sparkles size={16} aria-hidden="true" /> Try Plus free for {TRIAL_DAYS} days
            </button>
          )}
          <button class={`btn ${trialOpen && vehicle ? 'btn--glass' : 'btn--primary'}`} onClick={p.onPlans}>
            {me && isPlus(me.plan) && !onTrial ? 'Plans' : onTrial ? 'Keep Plus after the trial' : 'See plans'}
          </button>
        </div>
        {trialOpen && !vehicle && (
          <p class="small muted">Add your car to unlock a free week of Plus.</p>
        )}
        {subscribed && (
          <button
            class="link danger"
            disabled={busy !== null}
            onClick={() => {
              if (confirm('Cancel Plus? You keep it until the end of the period you paid for.')) void act('cancel', api.cancel, p.onChanged);
            }}
          >
            {busy === 'cancel' ? 'Cancelling…' : 'Cancel subscription'}
          </button>
        )}
      </section>

      <h2 class="section-title">Settings</h2>
      <div class="rows">
        <button class="rows__item" onClick={p.onGarage}>
          <span class="rows__icon" aria-hidden="true">
            <CarFront size={18} />
          </span>
          <span class="rows__text">
            <strong>My car</strong>
            <span>{vehicle?.name ?? 'Not set yet'}</span>
          </span>
          <ChevronRight size={18} class="rows__chev" aria-hidden="true" />
        </button>
        <button class="rows__item" onClick={p.onPlans}>
          <span class="rows__icon rows__icon--plus" aria-hidden="true">
            <Tag size={18} />
          </span>
          <span class="rows__text">
            <strong>Plans and pricing</strong>
            <span>Basic, Free, Trip Pass and Plus compared</span>
          </span>
          <ChevronRight size={18} class="rows__chev" aria-hidden="true" />
        </button>
        <button class="rows__item" onClick={p.onFeedback} data-testid="you-feedback">
          <span class="rows__icon" aria-hidden="true">
            <MessageSquareHeart size={18} />
          </span>
          <span class="rows__text">
            <strong>Send feedback</strong>
            <span>Tell us what to fix or build next</span>
          </span>
          <ChevronRight size={18} class="rows__chev" aria-hidden="true" />
        </button>
        <button class="rows__item" onClick={p.onToggleDark} aria-pressed={dark}>
          <span class="rows__icon" aria-hidden="true">
            {dark ? <Moon size={18} /> : <Sun size={18} />}
          </span>
          <span class="rows__text">
            <strong>Appearance</strong>
            <span>{dark ? 'Dark' : 'Light'}</span>
          </span>
          <ChevronRight size={18} class="rows__chev" aria-hidden="true" />
        </button>
        <button class="rows__item" onClick={p.onAbout}>
          <span class="rows__icon" aria-hidden="true">
            <Info size={18} />
          </span>
          <span class="rows__text">
            <strong>About and data sources</strong>
            <span>Where the charger data comes from</span>
          </span>
          <ChevronRight size={18} class="rows__chev" aria-hidden="true" />
        </button>
      </div>
      <p class="small muted center you__legal">
        <a href="/privacy.html">Privacy</a> · <a href="/terms.html">Terms</a>
      </p>

      {error && (
        <p class="notice notice--error" role="alert">
          {error}
        </p>
      )}
      {signedIn && (
        <div class="actions actions--stack you__danger">
          <button class="btn btn--block btn--glass" disabled={busy !== null} onClick={() => void act('out', api.signOut, p.onSignedOut)}>
            Sign out
          </button>
          <button class="btn btn--block btn--ghost" disabled={busy !== null} onClick={() => void act('all', api.signOutEverywhere, p.onSignedOut)}>
            Sign out on all devices
          </button>
          <button
            class="btn btn--block btn--ghost danger"
            disabled={busy !== null}
            onClick={() => {
              if (confirm('Delete your account? Your trips are erased and any subscription is cancelled. Payment records are kept as the law requires.')) {
                void act('delete', api.deleteAccount, p.onSignedOut);
              }
            }}
          >
            {busy === 'delete' ? 'Deleting…' : 'Delete my account'}
          </button>
        </div>
      )}
    </Page>
  );
}
