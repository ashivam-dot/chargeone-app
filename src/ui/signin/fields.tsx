// Form pieces for the sign-in sheet: labelled inputs with inline errors, a password field with
// show/hide, live password rules, a username field that checks availability, and a resend timer.
import {
  AtSign,
  Check,
  CircleAlert,
  Eye,
  EyeOff,
  LoaderCircle,
} from "lucide-preact";
import type { InputHTMLAttributes, JSX } from "preact";
import { useEffect, useId, useRef, useState } from "preact/hooks";
import { ApiError, api } from "../../lib/api.ts";
import { FirebaseAuthError } from "../../lib/firebaseRest.ts";
import {
  PASSWORD_MIN,
  PASSWORD_PROBLEM_TEXT,
  USERNAME_PROBLEM_TEXT,
  normalizeUsername,
  passwordProblems,
  usernameProblem,
  type PasswordProblem,
  type UsernameProblem,
} from "../../shared/auth.ts";

/** What every sign-in failure says, so the form never tells whether an account exists. */
export const BAD_LOGIN = "That email, username or password isn't right.";
const BAD_LOGIN_CODES = new Set([
  "INVALID_LOGIN_CREDENTIALS",
  "EMAIL_NOT_FOUND",
  "INVALID_PASSWORD",
  "USER_NOT_FOUND",
  "MISSING_PASSWORD",
]);

const minutes = (sec: number) =>
  sec >= 90
    ? `${Math.ceil(sec / 60)} minutes`
    : sec >= 60
      ? "a minute"
      : `${Math.max(1, Math.round(sec))} seconds`;

/** Friendly English for anything a sign-in step can throw. */
export function errorText(e: unknown, opts: { login?: boolean } = {}): string {
  if (e instanceof FirebaseAuthError)
    return opts.login && BAD_LOGIN_CODES.has(e.code) ? BAD_LOGIN : e.message;
  if (e instanceof ApiError) {
    if (e.status === 429) {
      const wait =
        typeof e.extra.retryAfter === "number" ? e.extra.retryAfter : 0;
      return wait > 0
        ? `Too many attempts. Try again in ${minutes(wait)}, or use another way to sign in.`
        : e.message;
    }
    if (e.code === "invalid_credentials") return BAD_LOGIN;
    return e.message;
  }
  return "Something went wrong. Please try again.";
}

/** Firebase or the Worker said "slow down" or "no more texts today": offer the other ways in. */
export const isThrottle = (e: unknown) =>
  (e instanceof FirebaseAuthError &&
    (e.code === "TOO_MANY_ATTEMPTS_TRY_LATER" ||
      e.code === "QUOTA_EXCEEDED")) ||
  (e instanceof ApiError && e.status === 429);

type InputProps = Omit<
  InputHTMLAttributes<HTMLInputElement>,
  "label" | "onInput" | "value" | "type" | "prefix"
>;

interface FieldProps extends InputProps {
  label: string;
  value: string;
  onValue: (v: string) => void;
  type?: "text" | "email" | "tel" | "password";
  error?: string | null;
  hint?: JSX.Element | string | null;
  /** Shown inside the input on the left, e.g. "@" or "+91". */
  prefix?: JSX.Element | string | null;
  /** Shown inside the input on the right, e.g. the show-password button. */
  suffix?: JSX.Element | null;
  testId?: string;
  labelAside?: JSX.Element | null;
}

export function Field({
  label,
  value,
  onValue,
  type = "text",
  error,
  hint,
  prefix,
  suffix,
  testId,
  labelAside,
  ...rest
}: FieldProps) {
  const id = useId();
  const describe =
    [error ? `${id}-err` : "", hint ? `${id}-hint` : ""]
      .filter(Boolean)
      .join(" ") || undefined;
  return (
    <div class={`auth-field${error ? " is-invalid" : ""}`}>
      <div class="auth-field__top">
        <label for={id}>{label}</label>
        {labelAside}
      </div>
      <div
        class={`auth-field__box${prefix ? " has-prefix" : ""}${suffix ? " has-suffix" : ""}`}
      >
        {prefix && (
          <span class="auth-field__prefix" aria-hidden="true">
            {prefix}
          </span>
        )}
        <input
          {...({
            ...rest,
            id,
            type,
            value,
            onInput: (e: Event) =>
              onValue((e.currentTarget as HTMLInputElement).value),
            "aria-invalid": error ? "true" : undefined,
            "aria-describedby": describe,
            "data-testid": testId,
          } as JSX.IntrinsicElements["input"])}
        />
        {suffix}
      </div>
      {error && (
        <p class="auth-field__error" id={`${id}-err`} role="alert">
          <CircleAlert size={14} aria-hidden="true" /> {error}
        </p>
      )}
      {hint && !error && (
        <div class="auth-field__hint" id={`${id}-hint`}>
          {hint}
        </div>
      )}
    </div>
  );
}

interface PasswordProps extends Omit<FieldProps, "type" | "suffix"> {}

export function PasswordField(props: PasswordProps) {
  const [shown, setShown] = useState(false);
  return (
    <Field
      {...props}
      type={shown ? "text" : "password"}
      autoCapitalize="none"
      autoCorrect="off"
      spellcheck={false}
      suffix={
        <button
          type="button"
          class="auth-field__eye"
          aria-label={shown ? "Hide password" : "Show password"}
          aria-pressed={shown}
          onClick={() => setShown(!shown)}
          data-testid={props.testId ? `${props.testId}-toggle` : undefined}
        >
          {shown ? (
            <EyeOff size={18} aria-hidden="true" />
          ) : (
            <Eye size={18} aria-hidden="true" />
          )}
        </button>
      }
    />
  );
}

const BASE_RULES: PasswordProblem[] = ["too_short", "no_letter", "no_digit"];
const RULE_TEXT: Partial<Record<PasswordProblem, string>> = {
  too_short: `${PASSWORD_MIN}+ characters`,
  no_letter: "A letter",
  no_digit: "A number",
};

/** Live rules under a new password, plus a four-step strength bar. */
export function PasswordRules({
  password,
  email,
  username,
}: {
  password: string;
  email?: string;
  username?: string;
}) {
  const problems = passwordProblems(password, { email, username });
  const extra = problems.filter(
    (p) => !BASE_RULES.includes(p) && p !== "too_long",
  );
  const met = BASE_RULES.filter((r) => !problems.includes(r)).length;
  const strength = !password
    ? 0
    : problems.length
      ? Math.min(2, met)
      : password.length >= 12 && /[^\p{L}\d]/u.test(password)
        ? 4
        : 3;
  const label = ["", "Weak", "Weak", "Good", "Strong"][strength];
  return (
    <div class="auth-rules" data-testid="password-rules">
      <div
        class={`auth-strength auth-strength--${strength}`}
        aria-hidden="true"
      >
        <span />
        <span />
        <span />
        <span />
      </div>
      <ul aria-label="Password rules">
        {BASE_RULES.map((r) => {
          const ok = Boolean(password) && !problems.includes(r);
          return (
            <li key={r} class={ok ? "is-ok" : ""}>
              {ok ? (
                <Check size={13} aria-hidden="true" />
              ) : (
                <span class="auth-rules__dot" aria-hidden="true" />
              )}
              {RULE_TEXT[r]}
              <span class="sr-only">{ok ? " (done)" : " (needed)"}</span>
            </li>
          );
        })}
        {label && (
          <li class={`auth-rules__label auth-rules__label--${strength}`}>
            {label}
          </li>
        )}
      </ul>
      {password &&
        extra.map((p) => (
          <p key={p} class="auth-rules__extra">
            <CircleAlert size={13} aria-hidden="true" />{" "}
            {PASSWORD_PROBLEM_TEXT[p]}
          </p>
        ))}
      {password.length > 128 && (
        <p class="auth-rules__extra">{PASSWORD_PROBLEM_TEXT.too_long}</p>
      )}
    </div>
  );
}

export type UsernameState =
  | { kind: "empty" }
  | { kind: "checking" }
  | { kind: "ok"; username: string }
  | { kind: "bad"; reason: UsernameProblem | "taken" }
  /** The check itself failed (offline, too many checks): the server decides on save. */
  | { kind: "unknown"; username: string };

const CHECK_DELAY_MS = 450;

/** A username input that checks the rules at once and availability shortly after typing stops. */
export function UsernameField({
  value,
  onValue,
  onState,
  label = "Username",
  optional = false,
  error,
  testId = "username-input",
  autoFocus,
}: {
  value: string;
  onValue: (v: string) => void;
  onState: (s: UsernameState) => void;
  label?: string;
  optional?: boolean;
  error?: string | null;
  testId?: string;
  autoFocus?: boolean;
}) {
  const [state, setState] = useState<UsernameState>({ kind: "empty" });
  const report = useRef(onState);
  report.current = onState;
  const update = (s: UsernameState) => {
    setState(s);
    report.current(s);
  };

  useEffect(() => {
    const u = normalizeUsername(value);
    if (!u) return update({ kind: "empty" });
    const problem = usernameProblem(u);
    if (problem) return update({ kind: "bad", reason: problem });
    update({ kind: "checking" });
    let live = true;
    const t = setTimeout(() => {
      api
        .usernameAvailable(u)
        .then(
          (r) =>
            live &&
            update(
              r.available
                ? { kind: "ok", username: r.username }
                : { kind: "bad", reason: r.reason ?? "taken" },
            ),
        )
        .catch(() => live && update({ kind: "unknown", username: u }));
    }, CHECK_DELAY_MS);
    return () => {
      live = false;
      clearTimeout(t);
    };
  }, [value]);

  const status =
    state.kind === "checking" ? (
      <span class="auth-status">
        <LoaderCircle size={14} class="auth-spin" aria-hidden="true" />{" "}
        Checking…
      </span>
    ) : state.kind === "ok" ? (
      <span class="auth-status auth-status--ok" data-testid={`${testId}-ok`}>
        <Check size={14} aria-hidden="true" /> @{state.username} is available
      </span>
    ) : state.kind === "unknown" ? (
      <span class="auth-status">
        Couldn't check right now. We'll check when you save.
      </span>
    ) : (
      <span class="auth-status">
        3 to 20 letters, numbers, dots or underscores. You can sign in with it.
      </span>
    );

  return (
    <Field
      label={label}
      labelAside={
        optional ? <span class="auth-field__opt">Optional</span> : null
      }
      value={value}
      onValue={(v) => onValue(v.replace(/\s/g, "").slice(0, 30))}
      prefix={<AtSign size={16} />}
      autocomplete="username"
      autoCapitalize="none"
      autoCorrect="off"
      spellcheck={false}
      maxLength={30}
      autoFocus={autoFocus}
      error={
        error ??
        (state.kind === "bad" ? USERNAME_PROBLEM_TEXT[state.reason] : null)
      }
      hint={<div aria-live="polite">{status}</div>}
      testId={testId}
    />
  );
}

/** Seconds left before an action can repeat, e.g. "Resend code in 0:27". */
export function useCooldown(): [number, (seconds: number) => void] {
  const [until, setUntil] = useState(0);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (until <= now) return;
    const t = setTimeout(() => setNow(Date.now()), 250);
    return () => clearTimeout(t);
  }, [until, now]);
  const left = Math.max(0, Math.ceil((until - now) / 1000));
  return [
    left,
    (seconds: number) => {
      const t = Date.now();
      setNow(t);
      setUntil(t + seconds * 1000);
    },
  ];
}

export const clock = (sec: number) =>
  `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, "0")}`;

export function Spinner() {
  return <LoaderCircle size={18} class="auth-spin" aria-hidden="true" />;
}
