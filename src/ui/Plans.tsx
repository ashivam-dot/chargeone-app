import { Check, EyeOff, Minus, RotateCcw, Route, ShieldCheck, Smartphone, Sparkles } from 'lucide-preact';
import { useState } from 'preact/hooks';
import { ApiError, api, loadScript, type Config, type Me } from '../lib/api.ts';
import { COMPARE, FREE_TRIP_KM, PLANS, PLAN_ROWS, YEARLY_SAVING_PCT, formatRupees, isPlus, type Plan, type PlanId } from '../shared/plans.ts';
import { Sheet } from './Sheet.tsx';

interface Props {
  config: Config | null;
  me: Me | null;
  reason: string | null;
  onClose: () => void;
  onRequireSignIn: () => void;
  onActivated: () => void;
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

const PRICE_NOTE: Record<PlanId, string> = {
  free: '',
  trip_pass: 'Valid 7 days · no renewal',
  plus_monthly: 'Renews monthly · cancel anytime',
  plus_yearly: `About ${formatRupees(Math.round(PLANS.plus_yearly.pricePaise / 12 / 100) * 100)} a month · cancel anytime`,
};

const TRUST: Array<[typeof ShieldCheck, string]> = [
  [ShieldCheck, 'Secure checkout by Razorpay'],
  [Smartphone, 'UPI, cards and net banking'],
  [RotateCcw, 'Cancel anytime in Account'],
  [EyeOff, 'No ads. We never sell your data'],
];

const FAQ: Array<[string, string]> = [
  [
    'What counts as a long trip?',
    `Any trip over ${FREE_TRIP_KM} km. Shorter trips don't use it: up to ${PLANS.trip_pass.shortTripsPerDay} a day on Trip Pass and ${PLANS.plus_monthly.shortTripsPerDay} on Plus.`,
  ],
  ['What happens when my plan ends?', "You're back on Free. The charger map, live status, food and stays stay free for everyone."],
  [
    'Can I cancel Plus?',
    'Yes, any time in Account. You keep Plus until the end of the period you paid for. Trip Pass is a one-time payment and never renews.',
  ],
  ['Is paying here safe?', "Payment happens entirely in Razorpay's secure checkout. ChargeOne never sees your card, UPI or bank details."],
];

function Perk({ label, value }: { label: string; value: boolean | string }) {
  const included = value !== false;
  return (
    <li class={`perk${included ? '' : ' perk--no'}`}>
      {included ? <Check size={16} aria-hidden="true" /> : <Minus size={16} aria-hidden="true" />}
      <span>
        {typeof value === 'string' ? (
          <>
            {label}: <strong>{value}</strong>
          </>
        ) : (
          label
        )}
        {!included && <span class="visually-hidden"> (not included)</span>}
      </span>
    </li>
  );
}

function Cell({ value }: { value: boolean | string }) {
  if (value === true) return <Check size={16} class="cell--yes" role="img" aria-label="Included" />;
  if (value === false) return <Minus size={16} class="cell--no" role="img" aria-label="Not included" />;
  return <span>{value}</span>;
}

export function Plans({ config, me, reason, onClose, onRequireSignIn, onActivated }: Props) {
  const [busy, setBusy] = useState<PlanId | null>(null);
  const [message, setMessage] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null);
  const [yearly, setYearly] = useState(false);
  const current = me?.plan ?? 'free';
  const plusId: PlanId = yearly ? 'plus_yearly' : 'plus_monthly';

  const buy = async (plan: PlanId) => {
    if (!me?.user) {
      onRequireSignIn();
      return;
    }
    setBusy(plan);
    setMessage(null);
    try {
      if (config?.devLogin && !config.paymentsEnabled) {
        await api.devGrant(plan);
        setMessage({ kind: 'ok', text: `Test mode: ${PLANS[plan].name} activated without payment.` });
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
      if (e instanceof Error && e.message === 'dismissed') setMessage(null);
      else if (e instanceof ApiError && e.status === 401) onRequireSignIn();
      else if (e instanceof ApiError && e.code === 'payment_pending') {
        setMessage({ kind: 'error', text: e.message });
        onActivated();
      } else setMessage({ kind: 'error', text: e instanceof Error ? e.message : 'Payment did not complete.' });
    } finally {
      setBusy(null);
    }
  };

  const card = (p: Plan, featured: boolean) => {
    const active = current === p.id || (featured && isPlus(current) && isPlus(p.id));
    return (
      <li key={featured ? 'plus' : p.id} class={`plan${featured ? ' plan--featured' : ''}`} aria-label={p.name}>
        {featured && (
          <span class="plan__ribbon">
            <Sparkles size={12} aria-hidden="true" /> Best value
          </span>
        )}
        {!featured && reason && <span class="plan__ribbon plan__ribbon--quiet">Covers this trip</span>}
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
        <p class="plan__note">{PRICE_NOTE[p.id]}</p>
        <ul class="perks">
          {PLAN_ROWS.map((r) => (
            <Perk key={r.label} label={r.label} value={r.value(p)} />
          ))}
        </ul>
        <button class={`btn btn--block ${featured ? 'btn--primary btn--lg' : ''}`} disabled={active || busy !== null} onClick={() => void buy(p.id)}>
          {active ? 'Your plan' : busy === p.id ? 'Opening payment…' : `Get ${p.name}`}
        </button>
      </li>
    );
  };

  return (
    <Sheet title={reason ? 'Unlock this trip' : 'Choose your plan'} onClose={onClose} modal>
      {reason ? (
        <div class="unlock">
          <span class="unlock__icon" aria-hidden="true">
            <Route size={20} />
          </span>
          <div>
            <strong>{reason}</strong>
            <span>
              Trip Pass covers it for {formatRupees(PLANS.trip_pass.pricePaise)}. Plus covers every trip, with alerts if a charger on your route breaks.
            </span>
          </div>
        </div>
      ) : (
        <p class="plans__lead">The charger map, live status, food and stays are free for everyone. Pay only when you drive out of town.</p>
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
        {TRUST.map(([Icon, text]) => (
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
        {FAQ.map(([q, a]) => (
          <details key={q}>
            <summary>{q}</summary>
            <p>{a}</p>
          </details>
        ))}
      </div>

      <p class="small muted">
        Plus renews automatically until you cancel; cancelling keeps access until the end of the paid period.
      </p>
    </Sheet>
  );
}
