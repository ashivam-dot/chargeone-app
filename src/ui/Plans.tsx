import { Check, EyeOff, Lock, Minus, RotateCcw, Route, ShieldCheck, Smartphone, Sparkles } from 'lucide-preact';
import { useState } from 'preact/hooks';
import { ApiError, api, loadScript, type Config, type Me, type UpiPayment } from '../lib/api.ts';
import { PLATFORM } from '../native/bridge.ts';
import { lazy } from './shell/lazy.tsx';

const UpiPay = lazy(
  () => import('./UpiPay.tsx').then((m) => m.UpiPay),
  () => <p class="muted">Loading UPI…</p>,
);
import { BASIC, COMPARE, FREE_TRIP_KM, PLANS, PLAN_ROWS, TRIAL_DAYS, YEARLY_SAVING_PCT, cheapestWith, formatRupees, isPlus, type Perk, type Plan, type PlanId } from '../shared/plans.ts';
import { PerkItem } from './PerkItem.tsx';
import { Sheet } from './Sheet.tsx';

/** Why the plans screen opened: the server refused a trip, or the user tapped a locked feature. */
export type Paywall = { kind: 'trip'; message: string } | { kind: 'perk'; perk: Perk; label: string };

interface Props {
  config: Config | null;
  me: Me | null;
  reason: Paywall | null;
  onClose: () => void;
  onRequireSignIn: () => void;
  onActivated: () => void;
  onStartTrial?: () => void;
}

interface RazorpayResponse {
  razorpay_payment_id: string;
  razorpay_signature: string;
  razorpay_order_id?: string;
  razorpay_subscription_id?: string;
}

interface RazorpayInstance {
  open(): void;
  on(event: 'payment.failed', cb: (r: { error?: { description?: string } }) => void): void;
}

declare global {
  interface Window {
    Razorpay?: new (options: Record<string, unknown>) => RazorpayInstance;
  }
}

const PRICE_UNIT: Record<PlanId, string> = {
  free: '',
  trip_pass: 'once',
  plus_monthly: '/month',
  plus_yearly: '/year',
};

/**
 * How this copy of the app takes payment. Google Play requires Play Billing for plans sold in the
 * Android app; the website takes UPI straight to ChargeOne's account (or Razorpay if set up).
 */
type Method = 'dev' | 'play' | 'upi' | 'razorpay' | 'none';

export function paymentMethod(config: Config | null): Method {
  if (config?.devLogin && !config.paymentsEnabled) return 'dev';
  const p = config?.payments;
  if (PLATFORM === 'android') return p?.play ? 'play' : 'none';
  if (PLATFORM === 'ios') return 'none';
  if (p?.upi) return 'upi';
  if (p ? p.razorpay : config?.paymentsEnabled) return 'razorpay';
  return 'none';
}

const prepaid = (m: Method) => m === 'upi';
const monthlyEquivalent = formatRupees(Math.round(PLANS.plus_yearly.pricePaise / 12 / 100) * 100);

function priceNote(id: PlanId, m: Method): string {
  if (id === 'trip_pass') return 'Valid 7 days · no renewal';
  if (id === 'plus_monthly') return prepaid(m) ? '30 days · no auto-renewal' : 'Renews monthly · cancel anytime';
  if (id === 'plus_yearly') return `About ${monthlyEquivalent} a month · ${prepaid(m) ? 'no auto-renewal' : 'cancel anytime'}`;
  return '';
}

function trust(m: Method): Array<[typeof ShieldCheck, string]> {
  const first: Record<Method, [typeof ShieldCheck, string]> = {
    upi: [ShieldCheck, 'Pay from your own UPI app'],
    play: [ShieldCheck, 'Billed securely by Google Play'],
    razorpay: [ShieldCheck, 'Secure checkout by Razorpay'],
    dev: [ShieldCheck, 'Test mode, no real payment'],
    none: [ShieldCheck, 'Secure payment'],
  };
  return [
    first[m],
    [Smartphone, m === 'upi' ? 'GPay, PhonePe, Paytm, BHIM or any bank app' : 'UPI, cards and more'],
    [RotateCcw, prepaid(m) ? 'Nothing renews by itself' : 'Cancel anytime'],
    [EyeOff, 'No ads. We never sell your data'],
  ];
}

function faq(m: Method): Array<[string, string]> {
  return [
    [
      'What counts as a long trip?',
      `Any trip over ${FREE_TRIP_KM} km. Shorter trips don't use it: up to ${PLANS.trip_pass.shortTripsPerDay} a day on Trip Pass and ${PLANS.plus_monthly.shortTripsPerDay} on Plus.`,
    ],
    ['What happens when my plan ends?', "You're back on Free. The charger map, live status, food and stays stay free for everyone."],
    prepaid(m)
      ? ['Does Plus renew by itself?', 'No. Plus bought with UPI lasts the days you paid for. In its last week you can pay again and the new days are added on top.']
      : [
          'Can I cancel Plus?',
          m === 'play'
            ? 'Yes, any time in Google Play subscriptions. You keep Plus until the end of the period you paid for.'
            : 'Yes, any time in Account. You keep Plus until the end of the period you paid for. Trip Pass is a one-time payment and never renews.',
        ],
    [
      'Is paying here safe?',
      m === 'upi'
        ? 'You pay in your own UPI app with your UPI PIN. ChargeOne never sees your PIN, card or bank details.'
        : m === 'play'
          ? 'Google Play handles the payment. ChargeOne never sees your card, UPI or bank details.'
          : "Payment happens entirely in Razorpay's secure checkout. ChargeOne never sees your card, UPI or bank details.",
    ],
  ];
}

const PLUS_SUMMARY = `${PLANS.plus_monthly.longTripQuota} long trips a month, any distance`;

function Cell({ value }: { value: boolean | string }) {
  if (value === true) return <Check size={16} class="cell--yes" role="img" aria-label="Included" />;
  if (value === false) return <Minus size={16} class="cell--no" role="img" aria-label="Not included" />;
  return <span>{value}</span>;
}

export function Plans({ config, me, reason, onClose, onRequireSignIn, onActivated, onStartTrial }: Props) {
  const [busy, setBusy] = useState<PlanId | null>(null);
  const [message, setMessage] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null);
  const [yearly, setYearly] = useState(false);
  const [upi, setUpi] = useState<UpiPayment | null>(null);
  const current = me?.plan ?? 'free';
  const plusId: PlanId = yearly ? 'plus_yearly' : 'plus_monthly';
  const method = paymentMethod(config);

  const buy = async (plan: PlanId) => {
    if (!me?.user) {
      onRequireSignIn();
      return;
    }
    setBusy(plan);
    setMessage(null);
    try {
      if (method === 'dev') {
        await api.devGrant(plan);
        setMessage({ kind: 'ok', text: `Test mode: ${PLANS[plan].name} activated without payment.` });
        onActivated();
        return;
      }
      if (method === 'none') {
        setMessage({ kind: 'error', text: PLATFORM === 'ios' ? "Plans can't be bought in the iPhone app yet." : 'Payments are not set up yet.' });
        return;
      }
      if (method === 'upi') {
        UpiPay.preload();
        setUpi(await api.upiStart(plan));
        return;
      }
      if (method === 'play' && plan !== 'free') {
        const { appAccountToken } = await api.storeAccount();
        const { buyOnPlay } = await import('../native/playBilling.ts');
        const purchase = await buyOnPlay(plan, appAccountToken);
        const r = await api.playVerify(purchase.productId, purchase.purchaseToken);
        setMessage({ kind: 'ok', text: `${PLANS[r.plan === 'free' ? plan : r.plan].name} is active. Happy driving!` });
        onActivated();
        return;
      }
      const checkout = await api.checkout(plan);
      await loadScript('https://checkout.razorpay.com/v1/checkout.js');
      if (!window.Razorpay) throw new Error('Payment window could not load.');
      const result = await new Promise<{ refundDue?: boolean }>((resolve, reject) => {
        const rzp = new window.Razorpay!({
          key: checkout.keyId,
          ...(checkout.kind === 'order' ? { order_id: checkout.orderId, amount: checkout.amount, currency: 'INR' } : { subscription_id: checkout.subscriptionId }),
          name: 'ChargeOne',
          description: PLANS[plan].name,
          prefill: { email: checkout.email, name: checkout.name ?? '' },
          theme: { color: '#0d9488' },
          modal: { ondismiss: () => reject(new Error('dismissed')) },
          handler: async (resp: RazorpayResponse) => {
            try {
              resolve(await api.confirm({ ...resp }));
            } catch (e) {
              reject(e);
            }
          },
        });
        rzp.on('payment.failed', (r) => reject(new Error(r.error?.description ?? 'Payment failed.')));
        rzp.open();
      });
      setMessage(
        result.refundDue
          ? { kind: 'error', text: 'You already have Plus, so this payment will be refunded within 5–7 days.' }
          : { kind: 'ok', text: `${PLANS[plan].name} is active. Happy driving!` },
      );
      onActivated();
    } catch (e) {
      const cancelled = e instanceof Error && (e.message === 'dismissed' || /cancel/i.test(e.message));
      if (cancelled) setMessage(null);
      else if (e instanceof ApiError && e.status === 401) onRequireSignIn();
      else if (e instanceof ApiError && e.code === 'payment_pending') {
        setMessage({ kind: 'error', text: e.message });
        onActivated();
      } else setMessage({ kind: 'error', text: e instanceof Error ? e.message : 'Payment did not complete.' });
    } finally {
      setBusy(null);
    }
  };

  const onTrial = me?.entitlement?.source === 'trial';
  const hasPlus = isPlus(current) && !onTrial;
  const onPass = current === 'trip_pass';
  const trialOffer = !onTrial && !isPlus(current) && (me?.trial?.eligible ?? !me?.user);
  // A new Trip Pass starts a fresh 7 days and 10 trips, which only helps once this one's trips are used.
  const renewPass = onPass && reason?.kind === 'trip';
  const passFits = !hasPlus && (reason?.kind === 'trip' || (reason?.kind === 'perk' && Boolean(PLANS.trip_pass[reason.perk])));
  const perkPlan = reason?.kind === 'perk' ? cheapestWith(reason.perk) : null;

  const buttonLabel = (p: Plan, featured: boolean): { text: string; disabled: boolean } => {
    if (busy === p.id) return { text: 'Opening payment…', disabled: true };
    if (featured && hasPlus) return { text: current === p.id ? 'Your plan' : 'You have Plus', disabled: true };
    if (!featured && hasPlus) return { text: 'Included in your Plus', disabled: true };
    if (!featured && onTrial) return { text: 'Included in your Plus trial', disabled: true };
    if (featured && onTrial) return { text: `Keep ${p.name} after the trial`, disabled: busy !== null };
    if (!featured && onPass) return renewPass ? { text: 'Start a new Trip Pass', disabled: busy !== null } : { text: 'Your plan', disabled: true };
    return { text: `Get ${p.name}`, disabled: busy !== null };
  };

  const card = (p: Plan, featured: boolean) => {
    const button = buttonLabel(p, featured);
    return (
      <li key={featured ? 'plus' : p.id} class={`plan${featured ? ' plan--featured' : ''}`} aria-label={p.name}>
        {featured && (
          <span class="plan__ribbon">
            <Sparkles size={12} aria-hidden="true" /> Best value
          </span>
        )}
        {!featured && passFits && (!onPass || renewPass) && (
          <span class="plan__ribbon plan__ribbon--quiet">{reason?.kind === 'trip' ? 'Covers this trip' : 'Includes this'}</span>
        )}
        <div class="plan__head">
          <div>
            <h3>{featured ? 'Plus' : p.name}</h3>
            <p class="plan__tagline">{featured ? PLANS.plus_monthly.tagline : p.tagline}</p>
          </div>
          <div class="plan__price">
            <strong>{formatRupees(p.pricePaise)}</strong>
            <span>{PRICE_UNIT[p.id]}</span>
          </div>
        </div>
        {featured && (
          <div class="segmented segmented--small" role="group" aria-label="Billing">
            <button type="button" aria-pressed={!yearly} onClick={() => setYearly(false)}>
              Monthly
            </button>
            <button type="button" aria-pressed={yearly} onClick={() => setYearly(true)}>
              Yearly <span class="save">−{YEARLY_SAVING_PCT}%</span>
            </button>
          </div>
        )}
        <p class="plan__note">{priceNote(p.id, method)}</p>
        <ul class="perks">
          {PLAN_ROWS.map((r) => (
            <PerkItem key={r.label} label={r.label} value={r.value(p)} />
          ))}
        </ul>
        <button class={`btn btn--block ${featured ? 'btn--primary btn--lg' : ''}`} disabled={button.disabled} onClick={() => void buy(p.id)}>
          {button.text}
        </button>
      </li>
    );
  };

  const pass = formatRupees(PLANS.trip_pass.pricePaise);
  const tripHint = hasPlus
    ? `Plus includes ${PLUS_SUMMARY}. Each long trip stops counting 30 days after you plan it.`
    : onPass
      ? `A new Trip Pass gives ${PLANS.trip_pass.longTripQuota} more long trips over ${PLANS.trip_pass.periodDays} days for ${pass}. Plus gives ${PLUS_SUMMARY}.`
      : `Trip Pass covers it for ${pass}. Plus gives ${PLUS_SUMMARY}, with in-app alerts and saved trips.`;
  const perkHint =
    perkPlan?.id === 'trip_pass'
      ? `Trip Pass includes them for ${pass} for ${PLANS.trip_pass.periodDays} days. Plus includes them with ${PLUS_SUMMARY}.`
      : `Plus is ${formatRupees(PLANS.plus_monthly.pricePaise)} a month or ${formatRupees(PLANS.plus_yearly.pricePaise)} a year.`;
  const title = !reason ? 'Choose your plan' : reason.kind === 'trip' ? 'Unlock this trip' : `Unlock ${reason.label.toLowerCase()}`;

  if (upi) {
    return (
      <Sheet title="Pay with UPI" onClose={onClose} modal>
        <UpiPay
          payment={upi}
          onBack={() => setUpi(null)}
          onDone={(provisional) => {
            setUpi(null);
            setMessage({
              kind: 'ok',
              text: provisional
                ? `Thanks! ${PLANS[upi.plan].name} is on now. We'll confirm your payment within a few hours.`
                : `Thanks! We'll switch on ${PLANS[upi.plan].name} as soon as we've matched your payment, usually within a few hours.`,
            });
            onActivated();
          }}
        />
      </Sheet>
    );
  }

  return (
    <Sheet title={title} onClose={onClose} modal>
      {reason ? (
        <div class="unlock">
          <span class="unlock__icon" aria-hidden="true">
            {reason.kind === 'trip' ? <Route size={20} /> : <Lock size={20} />}
          </span>
          <div>
            <strong>{reason.kind === 'trip' ? reason.message : `${reason.label} come with ${perkPlan?.id === 'trip_pass' ? 'Trip Pass and Plus' : 'Plus'}.`}</strong>
            <span>{reason.kind === 'trip' ? tripHint : perkHint}</span>
          </div>
        </div>
      ) : (
        <p class="plans__lead">The charger map, live status, food and stays are free for everyone. Pay only when you drive out of town.</p>
      )}

      {trialOffer && onStartTrial && (
        <button class="trial-offer" onClick={onStartTrial} data-testid="plans-trial">
          <span class="trial-offer__icon" aria-hidden="true">
            <Sparkles size={20} />
          </span>
          <span class="trial-offer__text">
            <strong>Try Plus free for {TRIAL_DAYS} days</strong>
            <span>No card, no payment. Ends by itself. One free week per person and phone.</span>
          </span>
        </button>
      )}

      <ul class="plans">
        {card(PLANS[plusId], true)}
        {card(PLANS.trip_pass, false)}
      </ul>

      {message && (
        <p class={`notice notice--${message.kind}`} role={message.kind === 'error' ? 'alert' : 'status'}>
          {message.text}
        </p>
      )}

      <ul class="trust">
        {trust(method).map(([Icon, text]) => (
          <li key={text}>
            <Icon size={16} aria-hidden="true" />
            {text}
          </li>
        ))}
      </ul>

      <h3>Compare plans</h3>
      <div class="compare" role="region" aria-label="Compare plans" tabIndex={0}>
        <table>
          <thead>
            <tr>
              <th scope="col">
                <span class="visually-hidden">Feature</span>
              </th>
              <th scope="col">Basic</th>
              <th scope="col">Free</th>
              <th scope="col">Trip Pass</th>
              <th scope="col" class="compare__plus">
                Plus
              </th>
            </tr>
          </thead>
          <tbody>
            {COMPARE.map((r) => (
              <tr key={r.label}>
                <th scope="row">{r.label}</th>
                <td>
                  <Cell value={r.value(BASIC)} />
                </td>
                <td>
                  <Cell value={r.value(PLANS.free)} />
                </td>
                <td>
                  <Cell value={r.value(PLANS.trip_pass)} />
                </td>
                <td class="compare__plus">
                  <Cell value={r.value(PLANS.plus_monthly)} />
                </td>
              </tr>
            ))}
            <tr class="compare__price">
              <th scope="row">Price</th>
              <td>₹0, no sign-in</td>
              <td>₹0</td>
              <td>{formatRupees(PLANS.trip_pass.pricePaise)} once</td>
              <td class="compare__plus">
                {formatRupees(PLANS.plus_monthly.pricePaise)}/mo or {formatRupees(PLANS.plus_yearly.pricePaise)}/yr
              </td>
            </tr>
          </tbody>
        </table>
      </div>

      <h3>Questions</h3>
      <div class="faq">
        {faq(method).map(([q, a]) => (
          <details key={q}>
            <summary>{q}</summary>
            <p>{a}</p>
          </details>
        ))}
      </div>

      <p class="small muted">
        {prepaid(method)
          ? 'Plans paid with UPI last the days you paid for and never renew by themselves.'
          : 'Plus renews automatically until you cancel; cancelling keeps access until the end of the paid period.'}
      </p>
    </Sheet>
  );
}
