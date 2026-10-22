// Email and password: sign in (email or username), create an account, verify the email, reset a
// forgotten password, and choose a username.
import { ArrowLeft, CircleCheck, MailCheck } from "lucide-preact";
import { useEffect, useState } from "preact/hooks";
import { ApiError, type Me } from "../../lib/api.ts";
import { FirebaseAuthError } from "../../lib/firebaseRest.ts";
import {
  isEmail,
  normalizeUsername,
  passwordProblems,
} from "../../shared/auth.ts";
import {
  Field,
  PasswordField,
  PasswordRules,
  Spinner,
  UsernameField,
  clock,
  errorText,
  useCooldown,
  type UsernameState,
} from "./fields.tsx";

export const FORGOT_MESSAGE =
  "If an account exists for that email or username, we've emailed it a link to reset the password.";
const RESEND_EMAIL_SEC = 60;

function Alert({ text, testId }: { text: string | null; testId: string }) {
  if (!text) return null;
  return (
    <p class="auth-alert" role="alert" data-testid={testId}>
      {text}
    </p>
  );
}

function SubmitButton({
  busy,
  label,
  busyLabel,
  testId,
  disabled = false,
}: {
  busy: boolean;
  label: string;
  busyLabel: string;
  testId: string;
  disabled?: boolean;
}) {
  return (
    <button
      class="btn btn--primary btn--block auth-submit"
      disabled={busy || disabled}
      aria-busy={busy}
      data-testid={testId}
    >
      {busy ? (
        <>
          <Spinner /> {busyLabel}
        </>
      ) : (
        label
      )}
    </button>
  );
}

export function BackLink({
  onBack,
  label = "Back to sign in",
}: {
  onBack: () => void;
  label?: string;
}) {
  return (
    <button
      type="button"
      class="auth-back link"
      onClick={onBack}
      data-testid="signin-back"
    >
      <ArrowLeft size={16} aria-hidden="true" /> {label}
    </button>
  );
}

// ---- Sign in ----

interface SignInProps {
  identifier: string;
  onIdentifier: (v: string) => void;
  /** Rejects with what went wrong; an unverified email moves the sheet on by itself. */
  onSubmit: (identifier: string, password: string) => Promise<void>;
  onForgot: () => void;
  onRegister: () => void;
}

export function EmailSignIn({
  identifier,
  onIdentifier,
  onSubmit,
  onForgot,
  onRegister,
}: SignInProps) {
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fieldError, setFieldError] = useState<{ id?: string; pw?: string }>(
    {},
  );

  const submit = async (e: Event) => {
    e.preventDefault();
    const id = identifier.trim();
    const errs = {
      id: !id
        ? "Enter your email or username."
        : id.includes("@") && !isEmail(id)
          ? "Enter a valid email address."
          : undefined,
      pw: !password ? "Enter your password." : undefined,
    };
    setFieldError(errs);
    if (errs.id || errs.pw) return;
    setBusy(true);
    setError(null);
    try {
      await onSubmit(id, password);
    } catch (err) {
      setError(errorText(err, { login: true }));
    } finally {
      setBusy(false);
    }
  };

  return (
    <form
      class="auth-form"
      onSubmit={(e) => void submit(e)}
      noValidate
      data-testid="signin-email-form"
    >
      <Field
        label="Email or username"
        value={identifier}
        onValue={(v) => {
          onIdentifier(v);
          setFieldError((f) => ({ ...f, id: undefined }));
        }}
        autocomplete="username"
        autoCapitalize="none"
        autoCorrect="off"
        spellcheck={false}
        inputMode="email"
        maxLength={254}
        placeholder="you@example.com or username"
        error={fieldError.id}
        testId="signin-identifier"
      />
      <PasswordField
        label="Password"
        value={password}
        onValue={(v) => {
          setPassword(v);
          setFieldError((f) => ({ ...f, pw: undefined }));
        }}
        autocomplete="current-password"
        maxLength={4096}
        error={fieldError.pw}
        testId="signin-password"
        labelAside={
          <button
            type="button"
            class="link auth-field__link"
            onClick={onForgot}
            data-testid="signin-forgot"
          >
            Forgot password?
          </button>
        }
      />
      <Alert text={error} testId="signin-error" />
      <SubmitButton
        busy={busy}
        label="Sign in"
        busyLabel="Signing in…"
        testId="signin-submit"
      />
      <p class="auth-foot">
        New to ChargeOne?{" "}
        <button
          type="button"
          class="link link--inline"
          onClick={onRegister}
          data-testid="signin-register"
        >
          Create account
        </button>
      </p>
    </form>
  );
}

// ---- Create account ----

export interface Registration {
  name: string;
  email: string;
  username: string | null;
  password: string;
}

interface RegisterProps {
  initialEmail: string;
  onSubmit: (r: Registration) => Promise<void>;
  onSignIn: () => void;
}

export function RegisterForm({
  initialEmail,
  onSubmit,
  onSignIn,
}: RegisterProps) {
  const [name, setName] = useState("");
  const [email, setEmail] = useState(
    isEmail(initialEmail.trim()) ? initialEmail.trim() : "",
  );
  const [username, setUsername] = useState("");
  const [uState, setUState] = useState<UsernameState>({ kind: "empty" });
  const [password, setPassword] = useState("");
  const [agreed, setAgreed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<{ text: string; exists?: boolean } | null>(
    null,
  );
  const [tried, setTried] = useState(false);

  const u = normalizeUsername(username);
  const problems = passwordProblems(password, { email, username: u });
  const errs = {
    name: !name.trim() ? "Enter your name." : null,
    email: !email.trim()
      ? "Enter your email."
      : !isEmail(email.trim())
        ? "Enter a valid email address."
        : null,
    username: uState.kind === "bad" ? "" : null,
    password: problems.length
      ? "Choose a password that meets the rules below."
      : null,
    terms: !agreed ? "Agree to the terms to create an account." : null,
  };
  const show = (k: keyof typeof errs) => (tried ? errs[k] || null : null);

  // Pressed while the username was still being checked: go ahead as soon as the check settles.
  const [queued, setQueued] = useState(false);
  useEffect(() => {
    if (!queued || uState.kind === "checking") return;
    setQueued(false);
    void run();
  }, [queued, uState.kind]);

  const submit = (e: Event) => {
    e.preventDefault();
    if (busy) return;
    setTried(true);
    if (Object.values(errs).some((v) => v !== null)) return;
    if (uState.kind === "checking") return setQueued(true);
    void run();
  };

  const run = async () => {
    if (Object.values(errs).some((v) => v !== null)) return;
    setBusy(true);
    setError(null);
    try {
      await onSubmit({
        name: name.trim(),
        email: email.trim().toLowerCase(),
        username: u || null,
        password,
      });
    } catch (err) {
      setError({
        text: errorText(err),
        exists: err instanceof FirebaseAuthError && err.code === "EMAIL_EXISTS",
      });
    } finally {
      setBusy(false);
    }
  };

  return (
    <form
      class="auth-form"
      onSubmit={(e) => void submit(e)}
      noValidate
      data-testid="signin-register-form"
    >
      <p class="auth-lede">
        One account for trips, charger reports and your plan. We never see your
        password.
      </p>
      <Field
        label="Name"
        value={name}
        onValue={setName}
        autocomplete="name"
        autoCapitalize="words"
        maxLength={100}
        error={show("name")}
        testId="register-name"
        autoFocus
      />
      <Field
        label="Email"
        type="email"
        value={email}
        onValue={setEmail}
        autocomplete="email"
        autoCapitalize="none"
        autoCorrect="off"
        spellcheck={false}
        inputMode="email"
        maxLength={254}
        error={show("email")}
        testId="register-email"
      />
      <UsernameField
        value={username}
        onValue={setUsername}
        onState={setUState}
        optional
        testId="register-username"
      />
      <PasswordField
        label="Password"
        value={password}
        onValue={setPassword}
        autocomplete="new-password"
        maxLength={4096}
        error={show("password")}
        testId="register-password"
        hint={<PasswordRules password={password} email={email} username={u} />}
      />
      {tried && errs.password && (
        <PasswordRules password={password} email={email} username={u} />
      )}
      <label class={`auth-check${show("terms") ? " is-invalid" : ""}`}>
        <input
          type="checkbox"
          checked={agreed}
          onChange={(e) => setAgreed(e.currentTarget.checked)}
          data-testid="register-terms"
        />
        <span>
          I agree to the{" "}
          <a href="/terms.html" target="_blank" rel="noopener">
            terms
          </a>{" "}
          and{" "}
          <a href="/privacy.html" target="_blank" rel="noopener">
            privacy policy
          </a>
          .
        </span>
      </label>
      {show("terms") && (
        <p class="auth-field__error" role="alert">
          {errs.terms}
        </p>
      )}
      {error && (
        <div class="auth-alert" role="alert" data-testid="register-error">
          <p>{error.text}</p>
          {error.exists && (
            <button type="button" class="link" onClick={onSignIn}>
              Sign in instead
            </button>
          )}
        </div>
      )}
      <SubmitButton
        busy={busy || queued}
        label="Create account"
        busyLabel="Creating your account…"
        testId="register-submit"
      />
      <p class="auth-foot">
        Already have an account?{" "}
        <button
          type="button"
          class="link link--inline"
          onClick={onSignIn}
          data-testid="register-signin"
        >
          Sign in
        </button>
      </p>
    </form>
  );
}

// ---- Verify the email ----

export interface VerifyState {
  /** The address as the driver typed it, or masked when it came from a username. */
  email: string;
  /** Whether a verification email went out just now (registration). */
  sentNow: boolean;
  /** A note to show at once, e.g. the first email couldn't be sent. */
  note?: string | null;
  resend: () => Promise<void>;
  /** Signs in again for a token that says the email is verified. */
  retry: () => Promise<Me>;
}

interface VerifyProps {
  state: VerifyState;
  onVerified: (me: Me) => Promise<void>;
  onBack: () => void;
}

export function VerifyEmail({ state, onVerified, onBack }: VerifyProps) {
  const [busy, setBusy] = useState<"retry" | "resend" | null>(null);
  const [error, setError] = useState<string | null>(state.note ?? null);
  const [info, setInfo] = useState<string | null>(null);
  const [wait, startWait] = useCooldown();
  const [started, setStarted] = useState(false);
  if (!started) {
    setStarted(true);
    if (state.sentNow) startWait(RESEND_EMAIL_SEC);
  }

  const retry = async () => {
    setBusy("retry");
    setError(null);
    setInfo(null);
    try {
      await onVerified(await state.retry());
    } catch (e) {
      setError(
        e instanceof ApiError && e.code === "email_unverified"
          ? "Your email isn't verified yet. Open the link in the email we sent (check spam too), then try again."
          : errorText(e, { login: true }),
      );
    } finally {
      setBusy(null);
    }
  };

  const resend = async () => {
    setBusy("resend");
    setError(null);
    setInfo(null);
    try {
      await state.resend();
      setInfo("Sent again. It can take a minute; check spam too.");
      startWait(RESEND_EMAIL_SEC);
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(null);
    }
  };

  return (
    <div class="auth-verify" data-testid="signin-verify">
      <div class="auth-verify__icon" aria-hidden="true">
        <MailCheck size={30} />
      </div>
      <h3 class="auth-verify__title">Check your inbox</h3>
      <p class="auth-verify__text">
        {state.sentNow
          ? "We sent a verification link to"
          : "Verify your email to sign in. The link went to"}{" "}
        <strong data-testid="signin-verify-email">{state.email}</strong>. Open
        it, then come back here.
      </p>
      {error && (
        <p class="auth-alert" role="alert" data-testid="signin-verify-error">
          {error}
        </p>
      )}
      {info && (
        <p class="auth-ok" role="status" data-testid="signin-verify-info">
          <CircleCheck size={16} aria-hidden="true" /> {info}
        </p>
      )}
      <button
        class="btn btn--primary btn--block auth-submit"
        disabled={busy !== null}
        onClick={() => void retry()}
        data-testid="signin-verify-continue"
      >
        {busy === "retry" ? (
          <>
            <Spinner /> Checking…
          </>
        ) : (
          "I've verified, continue"
        )}
      </button>
      <button
        class="btn btn--block btn--glass"
        disabled={busy !== null || wait > 0}
        onClick={() => void resend()}
        data-testid="signin-verify-resend"
      >
        {busy === "resend" ? (
          <>
            <Spinner /> Sending…
          </>
        ) : wait > 0 ? (
          <>
            Resend email in <span class="num">{clock(wait)}</span>
          </>
        ) : (
          "Resend email"
        )}
      </button>
      <BackLink onBack={onBack} label="Use a different account" />
    </div>
  );
}

// ---- Forgot password ----

interface ForgotProps {
  initial: string;
  onSend: (identifier: string) => Promise<void>;
  onBack: () => void;
}

export function ForgotPassword({ initial, onSend, onBack }: ForgotProps) {
  const [identifier, setIdentifier] = useState(initial);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fieldError, setFieldError] = useState<string | null>(null);

  const submit = async (e: Event) => {
    e.preventDefault();
    const id = identifier.trim();
    if (!id) return setFieldError("Enter your email or username.");
    if (id.includes("@") && !isEmail(id))
      return setFieldError("Enter a valid email address.");
    setBusy(true);
    setError(null);
    try {
      await onSend(id);
      setDone(true);
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  };

  if (done) {
    return (
      <div class="auth-form" data-testid="signin-forgot-done">
        <p class="auth-ok" role="status" data-testid="signin-forgot-message">
          <CircleCheck size={18} aria-hidden="true" /> {FORGOT_MESSAGE}
        </p>
        <p class="auth-lede">
          Open the link, choose a new password, then sign in here. No email
          after a few minutes? Check spam, or try again.
        </p>
        <button
          class="btn btn--primary btn--block auth-submit"
          onClick={onBack}
          data-testid="signin-forgot-back"
        >
          Back to sign in
        </button>
      </div>
    );
  }

  return (
    <form
      class="auth-form"
      onSubmit={(e) => void submit(e)}
      noValidate
      data-testid="signin-forgot-form"
    >
      <p class="auth-lede">
        Enter the email or username of your account and we'll email you a link
        to choose a new password.
      </p>
      <Field
        label="Email or username"
        value={identifier}
        onValue={(v) => {
          setIdentifier(v);
          setFieldError(null);
        }}
        autocomplete="username"
        autoCapitalize="none"
        autoCorrect="off"
        spellcheck={false}
        inputMode="email"
        maxLength={254}
        error={fieldError}
        testId="forgot-identifier"
        autoFocus
      />
      <Alert text={error} testId="forgot-error" />
      <SubmitButton
        busy={busy}
        label="Send reset link"
        busyLabel="Sending…"
        testId="forgot-submit"
      />
      <BackLink onBack={onBack} />
    </form>
  );
}

// ---- Choose a username ----

interface UsernameProps {
  initial: string;
  initialError: string | null;
  onSave: (username: string) => Promise<void>;
  onSkip: () => void;
}

export function ChooseUsername({
  initial,
  initialError,
  onSave,
  onSkip,
}: UsernameProps) {
  const [username, setUsername] = useState(initial);
  const [state, setState] = useState<UsernameState>({ kind: "empty" });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(initialError);

  const submit = async (e: Event) => {
    e.preventDefault();
    const u = normalizeUsername(username);
    if (!u) return setError("Choose a username, or skip for now.");
    if (state.kind === "bad" || state.kind === "checking") return;
    setBusy(true);
    setError(null);
    try {
      await onSave(u);
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <form
      class="auth-form"
      onSubmit={(e) => void submit(e)}
      noValidate
      data-testid="signin-username"
    >
      <p class="auth-lede">
        Pick a username to sign in with instead of your email. You can skip
        this.
      </p>
      <UsernameField
        value={username}
        onValue={(v) => {
          setUsername(v);
          setError(null);
        }}
        onState={setState}
        error={error}
        testId="claim-username"
        autoFocus
      />
      <SubmitButton
        busy={busy}
        label="Save username"
        busyLabel="Saving…"
        testId="claim-submit"
        disabled={state.kind === "bad"}
      />
      <button
        type="button"
        class="btn btn--block btn--ghost"
        onClick={onSkip}
        disabled={busy}
        data-testid="claim-skip"
      >
        Skip for now
      </button>
    </form>
  );
}
