import { useState } from 'preact/hooks';
import { ApiError, api, loadScript, type Config, type Me } from '../lib/api.ts';
import { PAID_PLANS, PLANS, formatRupees, type PlanId } from '../shared/plans.ts';
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

const PRICE_NOTE: Record<PlanId, string> = {
  free: '',
  trip_pass: 'one time · 7 days',
  plus_monthly: 'per month · cancel anytime',
  plus_yearly: 'per year · about ₹83/month',
};

export function Plans({ config, me, reason, onClose, onRequireSignIn, onActivated }: Props) {
  const [busy, setBusy] = useState<PlanId | null>(null);
  const [message, setMessage] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null);
  const current = me?.plan ?? 'free';

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
      await new Promise<void>((resolve, reject) => {
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
              await api.confirm({ ...resp });
              resolve();
            } catch (e) {
              reject(e);
            }
          },
        });
        rzp.on('payment.failed', (r) => reject(new Error(r.error?.description ?? 'Payment failed.')));
        rzp.open();
      });
      setMessage({ kind: 'ok', text: `${PLANS[plan].name} is active. Happy driving!` });
      onActivated();
    } catch (e) {
      if (e instanceof Error && e.message === 'dismissed') setMessage(null);
      else if (e instanceof ApiError && e.status === 401) onRequireSignIn();
      else setMessage({ kind: 'error', text: e instanceof Error ? e.message : 'Payment did not complete.' });
    } finally {
      setBusy(null);
    }
  };

  return (
    <Sheet title="Plans" onClose={onClose} modal>
      {reason && <p class="notice">{reason}</p>}
      <p class="muted">The map and live charger status are free for everyone. Plans unlock long trips with full charging stops.</p>
      <ul class="plans">
        {PAID_PLANS.map((id) => {
          const p = PLANS[id];
          const active = current === id;
          return (
            <li key={id} class={`plan${id === 'plus_monthly' ? ' plan--featured' : ''}`}>
              {id === 'plus_monthly' && <span class="plan__ribbon">Most popular</span>}
              <div class="plan__head">
                <h3>{p.name}</h3>
                <div class="plan__price">
                  <strong>{formatRupees(p.pricePaise)}</strong>
                  <span>{PRICE_NOTE[id]}</span>
                </div>
              </div>
              <ul class="plan__features">
                {p.features.map((f) => (
                  <li key={f}>{f}</li>
                ))}
              </ul>
              <button class={`btn btn--block ${id === 'plus_monthly' ? 'btn--primary' : ''}`} disabled={active || busy !== null} onClick={() => void buy(id)}>
                {active ? 'Your plan' : busy === id ? 'Opening payment…' : `Get ${p.name}`}
              </button>
            </li>
          );
        })}
      </ul>
      {message && (
        <p class={`notice notice--${message.kind}`} role={message.kind === 'error' ? 'alert' : 'status'}>
          {message.text}
        </p>
      )}
      <p class="small muted">
        Payments are processed by Razorpay (UPI, cards, net banking). We never see your card or UPI details. Plus renews automatically
        until you cancel; cancelling keeps access until the end of the paid period.
      </p>
    </Sheet>
  );
}
