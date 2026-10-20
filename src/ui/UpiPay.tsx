import { ArrowLeft, Check, Copy, QrCode, Smartphone } from 'lucide-preact';
import { useMemo, useState } from 'preact/hooks';
import { renderSVG } from 'uqr';
import { ApiError, api, type UpiPayment } from '../lib/api.ts';
import { PLANS, formatRupees } from '../shared/plans.ts';

interface Props {
  payment: UpiPayment;
  onBack: () => void;
  onDone: (provisional: boolean) => void;
}

const isPhone = () => /Android|iPhone|iPad/i.test(navigator.userAgent);

/** Direct UPI: the payer's own UPI app sends the money to ChargeOne's UPI ID, then they enter the UTR. */
export function UpiPay({ payment, onBack, onDone }: Props) {
  const phone = isPhone();
  const [showQr, setShowQr] = useState(!phone);
  const [utr, setUtr] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const qr = useMemo(() => renderSVG(payment.uri, { border: 2, whiteColor: '#ffffff', blackColor: '#05070b' }), [payment.uri]);
  const plan = PLANS[payment.plan];
  const valid = /^\d{12}$/.test(utr);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(payment.payee);
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
    } catch {
      // Clipboard blocked; the UPI ID is on screen to type.
    }
  };

  const submit = async (e: Event) => {
    e.preventDefault();
    if (!valid) return;
    setBusy(true);
    setError(null);
    try {
      const r = await api.upiClaim(payment.ref, utr);
      onDone(r.provisional);
    } catch (err) {
      setError(err instanceof ApiError || err instanceof Error ? err.message : 'Could not send the transaction id.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div class="upi" data-testid="upi-pay">
      <button class="link upi__back" onClick={onBack}>
        <ArrowLeft size={16} aria-hidden="true" /> All plans
      </button>
      <div class="upi__amount">
        <span class="upi__plan">{plan.name}</span>
        <strong class="num">{formatRupees(payment.amountPaise)}</strong>
        <span class="muted small">{plan.billing === 'one_time' ? `${plan.periodDays} days` : `${plan.periodDays} days · no auto-renewal`}</span>
      </div>

      <ol class="upi__steps">
        <li>
          <span class="upi__step">1</span>
          <div>
            <strong>Pay with any UPI app</strong>
            <span class="muted small">GPay, PhonePe, Paytm, BHIM or your bank's app. The amount and note fill in by themselves.</span>
            {phone && (
              <a class="btn btn--primary btn--block btn--lg upi__open" href={payment.uri} data-testid="upi-open">
                <Smartphone size={18} aria-hidden="true" /> Pay {formatRupees(payment.amountPaise)} in a UPI app
              </a>
            )}
            {phone && !showQr && (
              <button class="link small" onClick={() => setShowQr(true)}>
                <QrCode size={14} aria-hidden="true" /> Show QR code instead
              </button>
            )}
            {showQr && <div class="upi__qr" role="img" aria-label={`UPI QR code for ${formatRupees(payment.amountPaise)}`} dangerouslySetInnerHTML={{ __html: qr }} />}
            <p class="upi__payee small">
              To <strong>{payment.payeeName}</strong> · <code>{payment.payee}</code>
              <button class="icon-btn icon-btn--sm" onClick={copy} aria-label="Copy UPI ID">
                {copied ? <Check size={14} /> : <Copy size={14} />}
              </button>
            </p>
            <p class="small muted">
              Note: <code>{payment.note}</code>
            </p>
          </div>
        </li>
        <li>
          <span class="upi__step">2</span>
          <form onSubmit={submit}>
            <label for="utr">
              <strong>Enter the UPI transaction ID</strong>
              <span class="muted small">12 digits, shown as UTR or UPI Ref No. on the payment receipt.</span>
            </label>
            <input
              id="utr"
              class="upi__utr num"
              inputMode="numeric"
              autoComplete="off"
              maxLength={12}
              placeholder="000000000000"
              value={utr}
              onInput={(e) => setUtr((e.target as HTMLInputElement).value.replace(/\D/g, '').slice(0, 12))}
              data-testid="upi-utr"
            />
            <button class="btn btn--primary btn--block" disabled={!valid || busy} data-testid="upi-submit">
              {busy ? 'Sending…' : "I've paid"}
            </button>
          </form>
        </li>
      </ol>
      {error && (
        <p class="notice notice--error" role="alert">
          {error}
        </p>
      )}
      <p class="small muted">
        The money goes straight to ChargeOne's bank account; there's no payment gateway. We match your transaction ID with our bank statement, usually
        within a few hours. In most cases your plan starts right away while we check.
      </p>
    </div>
  );
}
