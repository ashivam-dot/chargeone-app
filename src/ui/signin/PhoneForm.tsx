// Mobile number and a one-time code. The Firebase SDK (with its invisible reCAPTCHA) loads when this
// form first shows, never before.
import { CircleAlert, Mail } from "lucide-preact";
import { useEffect, useRef, useState } from "preact/hooks";
import { FirebaseAuthError } from "../../lib/firebaseRest.ts";
import type { PhoneCodeSent, PhoneSignIn } from "../../lib/phoneAuth.ts";
import {
  normalizePhone,
  type FirebasePublicConfig,
} from "../../shared/auth.ts";
import {
  Field,
  Spinner,
  clock,
  errorText,
  isThrottle,
  useCooldown,
} from "./fields.tsx";

const RESEND_SEC = 30;
const CODE_LEN = 6;

/** "+919876543210" -> "+91 98765 43210"; other countries as typed. */
export const prettyPhone = (e164: string) =>
  /^\+91\d{10}$/.test(e164) ? `+91 ${e164.slice(3, 8)} ${e164.slice(8)}` : e164;

interface Props {
  firebase: FirebasePublicConfig;
  /** Local end-to-end tests with mocked Firebase only. */
  testMode: boolean;
  /** Called with the Firebase ID token; rejects with the reason the ChargeOne sign-in failed. */
  onToken: (idToken: string) => Promise<void>;
  onUseEmail: () => void;
}

interface OtpCredentialLike {
  code?: string;
}

export function PhoneForm({ firebase, testMode, onToken, onUseEmail }: Props) {
  const host = useRef<HTMLDivElement>(null);
  const codeInput = useRef<HTMLInputElement>(null);
  const client = useRef<Promise<PhoneSignIn> | null>(null);
  const sent = useRef<PhoneCodeSent | null>(null);
  const [number, setNumber] = useState("");
  const [e164, setE164] = useState<string | null>(null);
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState<"send" | "verify" | null>(null);
  const [error, setError] = useState<{
    text: string;
    throttle: boolean;
    field?: boolean;
  } | null>(null);
  const [resendIn, startCooldown] = useCooldown();
  const [focused, setFocused] = useState(false);

  // Load the SDK as soon as the Phone option opens, so "Send code" answers quickly.
  const getClient = () => {
    client.current ??= import("../../lib/phoneAuth.ts")
      .then((m) => m.phoneSignIn(firebase, host.current!, testMode))
      .catch((e: unknown) => {
        client.current = null;
        throw e instanceof FirebaseAuthError
          ? e
          : new FirebaseAuthError("NETWORK");
      });
    return client.current;
  };
  useEffect(() => {
    getClient().catch(() => undefined);
    return () => {
      void client.current?.then((c) => c.dispose()).catch(() => undefined);
    };
  }, []);

  // Android Chrome can read the code from the text message (WebOTP) when the SMS names this site.
  useEffect(() => {
    if (!e164 || !("OTPCredential" in window)) return;
    const ac = new AbortController();
    (
      navigator.credentials.get({
        otp: { transport: ["sms"] },
        signal: ac.signal,
      } as CredentialRequestOptions) as Promise<OtpCredentialLike | null>
    )
      .then((c) => {
        if (c?.code && /^\d{6}$/.test(c.code)) {
          setCode(c.code);
          void verify(c.code);
        }
      })
      .catch(() => undefined);
    return () => ac.abort();
  }, [e164]);

  const fail = (e: unknown, field = false) =>
    setError({
      text: errorText(e),
      throttle:
        isThrottle(e) ||
        (e instanceof FirebaseAuthError && e.code === "CAPTCHA_FAILED"),
      field,
    });

  const send = async (target: string) => {
    setBusy("send");
    setError(null);
    try {
      const c = await getClient();
      sent.current = await c.sendCode(target);
      setE164(target);
      setCode("");
      startCooldown(RESEND_SEC);
      setTimeout(() => codeInput.current?.focus(), 50);
    } catch (e) {
      fail(
        e,
        e instanceof FirebaseAuthError && e.code === "INVALID_PHONE_NUMBER",
      );
    } finally {
      setBusy(null);
    }
  };

  const submitNumber = (e: Event) => {
    e.preventDefault();
    const target = normalizePhone(number);
    if (!target) {
      setError({
        text: new FirebaseAuthError("INVALID_PHONE_NUMBER").message,
        throttle: false,
        field: true,
      });
      return;
    }
    void send(target);
  };

  const verify = async (value = code) => {
    if (busy) return;
    if (!sent.current || value.length !== CODE_LEN) {
      setError({
        text: `Enter the ${CODE_LEN}-digit code from the text message.`,
        throttle: false,
        field: true,
      });
      return;
    }
    setBusy("verify");
    setError(null);
    try {
      const token = await sent.current.confirm(value);
      await onToken(token);
    } catch (e) {
      fail(e, e instanceof FirebaseAuthError && e.code === "INVALID_CODE");
      if (e instanceof FirebaseAuthError && e.code === "INVALID_CODE") {
        setCode("");
        codeInput.current?.focus();
      }
    } finally {
      setBusy(null);
    }
  };

  const onCode = (v: string) => {
    const digits = v.replace(/\D/g, "").slice(0, CODE_LEN);
    setCode(digits);
    if (error?.field) setError(null);
    if (digits.length === CODE_LEN) void verify(digits);
  };

  const errorBox = error && !error.field && (
    <div class="auth-alert" role="alert" data-testid="signin-phone-error">
      <CircleAlert size={16} aria-hidden="true" />
      <div>
        <p>{error.text}</p>
        {error.throttle && (
          <button
            type="button"
            class="link"
            onClick={onUseEmail}
            data-testid="signin-phone-use-email"
          >
            <Mail size={14} aria-hidden="true" /> Use email instead
          </button>
        )}
      </div>
    </div>
  );

  return (
    <div class="auth-phone" data-testid="signin-phone">
      {!e164 ? (
        <form class="auth-form" onSubmit={submitNumber} noValidate>
          <Field
            label="Mobile number"
            type="tel"
            inputMode="tel"
            autocomplete="tel"
            placeholder="98765 43210"
            value={number}
            onValue={(v) => {
              setNumber(v.replace(/[^\d+\s\-()]/g, "").slice(0, 20));
              if (error) setError(null);
            }}
            prefix={number.trim().startsWith("+") ? null : "+91"}
            error={error?.field ? error.text : null}
            hint="We'll text you a 6-digit code. Outside India? Start with + and your country code."
            testId="signin-phone-input"
          />
          {errorBox}
          <button
            class="btn btn--primary btn--block auth-submit"
            disabled={busy !== null}
            data-testid="signin-phone-send"
          >
            {busy === "send" ? (
              <>
                <Spinner /> Sending code…
              </>
            ) : (
              "Send code"
            )}
          </button>
        </form>
      ) : (
        <form
          class="auth-form"
          onSubmit={(e) => {
            e.preventDefault();
            void verify();
          }}
          noValidate
        >
          <p class="auth-sent" data-testid="signin-otp-sent">
            Enter the code we sent to{" "}
            <strong class="num">{prettyPhone(e164)}</strong>{" "}
            <button
              type="button"
              class="link link--inline"
              onClick={() => {
                setE164(null);
                setCode("");
                setError(null);
                sent.current = null;
              }}
              data-testid="signin-phone-change"
            >
              Change number
            </button>
          </p>
          <label class="sr-only" for="auth-otp">
            {CODE_LEN}-digit code
          </label>
          <div
            class={`auth-otp${error?.field ? " is-invalid" : ""}${focused ? " is-focused" : ""}`}
          >
            <input
              id="auth-otp"
              ref={codeInput}
              value={code}
              onInput={(e) => onCode(e.currentTarget.value)}
              onFocus={() => setFocused(true)}
              onBlur={() => setFocused(false)}
              inputMode="numeric"
              autocomplete="one-time-code"
              pattern="[0-9]*"
              maxLength={CODE_LEN}
              aria-invalid={error?.field ? "true" : undefined}
              aria-describedby={error?.field ? "auth-otp-err" : undefined}
              data-testid="signin-otp-input"
            />
            <div class="auth-otp__cells" aria-hidden="true">
              {Array.from({ length: CODE_LEN }, (_, i) => (
                <span
                  key={i}
                  class={`auth-otp__cell${i === Math.min(code.length, CODE_LEN - 1) && focused ? " is-active" : ""}${code[i] ? " is-filled" : ""}`}
                >
                  {code[i] ?? ""}
                </span>
              ))}
            </div>
          </div>
          {error?.field && (
            <p
              class="auth-field__error"
              id="auth-otp-err"
              role="alert"
              data-testid="signin-otp-error"
            >
              <CircleAlert size={14} aria-hidden="true" /> {error.text}
            </p>
          )}
          {errorBox}
          <button
            class="btn btn--primary btn--block auth-submit"
            disabled={busy !== null}
            data-testid="signin-otp-verify"
          >
            {busy === "verify" ? (
              <>
                <Spinner /> Checking…
              </>
            ) : (
              "Verify and sign in"
            )}
          </button>
          <p class="auth-foot">
            {resendIn > 0 ? (
              <span class="muted" data-testid="signin-otp-wait">
                Resend code in <span class="num">{clock(resendIn)}</span>
              </span>
            ) : (
              <button
                type="button"
                class="link link--inline"
                disabled={busy !== null}
                onClick={() => void send(e164)}
                data-testid="signin-otp-resend"
              >
                Resend code
              </button>
            )}
          </p>
        </form>
      )}
      <div ref={host} class="auth-recaptcha" />
    </div>
  );
}
