// The sign-in sheet: Google on top, then email (or username) and password, or a mobile number and a
// one-time code. Also creating an account, verifying the email, resetting a password and choosing a
// username. This whole module is a lazy chunk; the Firebase SDK (phone only) is a further one.
import { Check, Mail, Smartphone } from "lucide-preact";
import { useEffect, useMemo, useRef, useState } from "preact/hooks";
import { ApiError, api, type Config, type Me } from "../../lib/api.ts";
import {
  FirebaseAuthError,
  firebaseRest,
  type FirebaseSession,
} from "../../lib/firebaseRest.ts";
import { rememberFirebaseToken } from "../../lib/firebaseSession.ts";
import { isEmail, normalizeUsername, stripHandle } from "../../shared/auth.ts";
import { BASIC, COMPARE, PLANS } from "../../shared/plans.ts";
import { Sheet } from "../Sheet.tsx";
import { signInReady } from "../SignIn.tsx";
import {
  ChooseUsername,
  EmailSignIn,
  ForgotPassword,
  RegisterForm,
  VerifyEmail,
  type Registration,
  type VerifyState,
} from "./EmailForms.tsx";
import { Spinner, errorText } from "./fields.tsx";
import { GoogleButton } from "./GoogleButton.tsx";
import { MethodsView } from "./MethodsView.tsx";
import { PhoneForm } from "./PhoneForm.tsx";
import "./signin.css";

export interface SignInSheetProps {
  config: Config | null;
  dark: boolean;
  /** Open straight at "choose a username" or "sign-in methods" for a signed-in driver (from the You screen). */
  start?: "username" | "methods";
  me?: Me | null;
  onClose: () => void;
  onSignedIn: (me: Me) => void;
}

declare global {
  interface Window {
    /** Set only by the local end-to-end tests, with every Firebase call mocked. */
    __CHARGEONE_E2E_PHONE__?: boolean;
  }
}

/** What works without an account, from the same rows the plans screen shows. */
const BASIC_ROWS = COMPARE.map((r) => ({
  label: r.label,
  value: r.value(BASIC),
})).filter((r) => r.value !== false);

/** Phone sign-in without reCAPTCHA: only a development server, on this machine, under the e2e tests. */
const phoneTestMode = (config: Config | null) =>
  Boolean(config?.devLogin) &&
  ["localhost", "127.0.0.1"].includes(location.hostname) &&
  window.__CHARGEONE_E2E_PHONE__ === true;

const ASKED_KEY = "chargeone:username-asked";
const accountKey = (me: Me) =>
  me.user?.email ?? me.user?.phone ?? me.user?.name ?? "";
function askedBefore(me: Me): boolean {
  try {
    return (
      JSON.parse(localStorage.getItem(ASKED_KEY) ?? "[]") as string[]
    ).includes(accountKey(me));
  } catch {
    return false;
  }
}
function markAsked(me: Me): void {
  try {
    const list = (
      JSON.parse(localStorage.getItem(ASKED_KEY) ?? "[]") as string[]
    )
      .filter((k) => k !== accountKey(me))
      .slice(-19);
    localStorage.setItem(ASKED_KEY, JSON.stringify([...list, accountKey(me)]));
  } catch {
    // Private mode: ask again next time.
  }
}

type View = "signin" | "register" | "forgot" | "verify" | "username" | "methods";
type Method = "email" | "phone";

const TITLES: Record<View, string> = {
  signin: "Sign in",
  register: "Create account",
  forgot: "Reset password",
  verify: "Verify your email",
  username: "Choose a username",
  methods: "Sign-in methods",
};

/** Usernames stand in for the email at password sign-in, so only accounts with a password get one. */
const canHaveUsername = (me: Me) =>
  Boolean(me.user && !me.user.username && me.user.methods?.includes("password"));

/** Where focus goes when the sheet moves to another view: its marked heading, else its first field or button. */
const FOCUS_TARGET =
  "[data-autofocus], input:not([type=hidden]):not([disabled]), textarea, select, button:not([disabled])";

const unverified = (e: unknown): e is ApiError =>
  e instanceof ApiError && e.code === "email_unverified";

export function SignInSheet({
  config,
  dark,
  start,
  me: initialMe,
  onClose,
  onSignedIn,
}: SignInSheetProps) {
  const firebase = config?.firebase ?? null;
  const clientId = config?.googleClientId ?? null;
  const rest = useMemo(
    () => (firebase ? firebaseRest(firebase) : null),
    [firebase],
  );
  const [view, setView] = useState<View>(
    start && initialMe?.user ? start : "signin",
  );
  const [method, setMethod] = useState<Method>("email");
  const [identifier, setIdentifier] = useState("");
  const [verify, setVerify] = useState<VerifyState | null>(null);
  const [busy, setBusy] = useState<"google" | "dev" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [usernameError, setUsernameError] = useState<string | null>(null);
  /** Signed in, waiting on the username step. */
  const signedIn = useRef<Me | null>(
    start ? (initialMe ?? null) : null,
  );
  /** A username typed at registration, claimed once the verified sign-in lands. */
  const pendingUsername = useRef<{ email: string; username: string } | null>(
    null,
  );
  const [initialUsername, setInitialUsername] = useState("");
  /** Re-renders the methods view after a change (the account itself lives in signedIn). */
  const [, setMethodsMe] = useState<Me | null>(null);
  const tabs = useRef<HTMLDivElement>(null);
  const root = useRef<HTMLDivElement>(null);
  const firstView = useRef(true);

  // The control that moved the sheet on is gone with its view; keep focus inside the dialog.
  useEffect(() => {
    if (firstView.current) {
      firstView.current = false;
      return;
    }
    const target = root.current?.querySelector<HTMLElement>(FOCUS_TARGET);
    target?.focus();
  }, [view]);

  /** Every sign-in ends here: claim or offer a username, then hand the session to the app. */
  const finish = async (me: Me) => {
    signedIn.current = me;
    setError(null);
    const pending = pendingUsername.current;
    // Only for the account that was just registered, never for another one signed in afterwards.
    const wanted =
      pending && me.user?.email?.toLowerCase() === pending.email
        ? pending.username
        : null;
    pendingUsername.current = null;
    if (me.user && canHaveUsername(me) && wanted) {
      try {
        const { username } = await api.claimUsername(wanted);
        return onSignedIn({ ...me, user: { ...me.user, username } });
      } catch (e) {
        markAsked(me);
        setInitialUsername(wanted);
        setUsernameError(errorText(e));
        return setView("username");
      }
    }
    if (canHaveUsername(me) && !askedBefore(me)) {
      markAsked(me);
      setInitialUsername("");
      setUsernameError(null);
      return setView("username");
    }
    onSignedIn(me);
  };

  /** Hands a Firebase ID token to the Worker; a 403 email_unverified opens "check your inbox". */
  const viaFirebase = async (
    session: FirebaseSession,
    email: string,
    name?: string,
  ) => {
    let current = session;
    const exchange = async () => {
      const me = await api.signInFirebase(current.idToken, name);
      rememberFirebaseToken(current.idToken);
      return me;
    };
    try {
      await finish(await exchange());
    } catch (e) {
      if (!unverified(e) || !rest) throw e;
      setVerify({
        email,
        sentNow: false,
        resend: () => rest.sendVerifyEmail(current.idToken),
        retry: async () => {
          // A refreshed token carries email_verified once the link was opened.
          current = await rest.refreshIdToken(current.refreshToken);
          return exchange();
        },
      });
      setView("verify");
    }
  };

  const signInWithPassword = async (typed: string, password: string) => {
    const id = stripHandle(typed);
    if (id.includes("@")) {
      if (!rest)
        throw new ApiError(
          503,
          "not_configured",
          "Email sign-in is being set up. Use another option for now.",
          {},
        );
      const email = id.toLowerCase();
      return viaFirebase(await rest.signInWithPassword(email, password), email);
    }
    const username = normalizeUsername(id);
    const attempt = async () => {
      const r = await api.passwordLogin(username, password);
      rememberFirebaseToken(r.firebaseIdToken);
      const { firebaseIdToken: _, ...me } = r;
      return me as Me;
    };
    try {
      await finish(await attempt());
    } catch (e) {
      if (!unverified(e)) throw e;
      const token =
        typeof e.extra.idToken === "string" ? e.extra.idToken : null;
      setVerify({
        email: typeof e.extra.email === "string" ? e.extra.email : "your email",
        sentNow: false,
        resend: async () => {
          if (!rest || !token)
            throw new ApiError(
              400,
              "resend",
              "Sign in again to get a new link.",
              {},
            );
          await rest.sendVerifyEmail(token);
        },
        retry: attempt,
      });
      setView("verify");
    }
  };

  const register = async (r: Registration) => {
    if (!rest)
      throw new ApiError(
        503,
        "not_configured",
        "Creating an account is being set up. Use Google for now.",
        {},
      );
    const session = await rest.signUp(r.email, r.password, r.name);
    pendingUsername.current = r.username
      ? { email: r.email.toLowerCase(), username: r.username }
      : null;
    let note: string | null = null;
    try {
      await rest.sendVerifyEmail(session.idToken);
    } catch {
      note =
        "Your account is made, but the verification email didn't go out. Tap Resend email.";
    }
    let current = session;
    setVerify({
      email: r.email,
      sentNow: !note,
      note,
      resend: () => rest.sendVerifyEmail(current.idToken),
      retry: async () => {
        current = await rest.refreshIdToken(current.refreshToken);
        const me = await api.signInFirebase(current.idToken, r.name);
        rememberFirebaseToken(current.idToken);
        return me;
      },
    });
    setView("verify");
  };

  const forgot = async (typed: string) => {
    const id = stripHandle(typed);
    if (isEmail(id) && rest) {
      try {
        await rest.sendPasswordReset(id.toLowerCase());
      } catch (e) {
        // Only a dropped connection or a throttle is worth saying; anything else would hint whether the account exists.
        if (
          e instanceof FirebaseAuthError &&
          (e.code === "NETWORK" || e.code === "TOO_MANY_ATTEMPTS_TRY_LATER")
        )
          throw e;
      }
      return;
    }
    await api.forgotPassword(id);
  };

  const google = async (credential: string) => {
    setBusy("google");
    setError(null);
    try {
      await finish(await api.signInGoogle(credential));
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(null);
    }
  };

  const dev = async () => {
    setBusy("dev");
    setError(null);
    try {
      await finish(await api.signInDev());
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(null);
    }
  };

  const phoneToken = async (idToken: string) => {
    const me = await api.signInFirebase(idToken);
    rememberFirebaseToken(idToken);
    await finish(me);
  };

  const saveUsername = async (u: string) => {
    const me = signedIn.current;
    const { username } = await api.claimUsername(u);
    if (me?.user) onSignedIn({ ...me, user: { ...me.user, username } });
    else onClose();
  };

  /** Closing after the sign-in landed keeps the driver signed in. */
  const close = () =>
    signedIn.current && (view === "username" || view === "methods")
      ? onSignedIn(signedIn.current)
      : onClose();

  const toSignIn = () => {
    setVerify(null);
    pendingUsername.current = null;
    setView("signin");
  };

  if (!signInReady(config)) {
    return (
      <Sheet title="Sign in" onClose={onClose} modal>
        <div class="auth" data-testid="signin-unavailable">
          <p class="notice">
            {config
              ? "Sign-in is being set up. Until then, keep using ChargeOne as a guest."
              : "Couldn't check sign-in right now. Check your connection, or keep using ChargeOne as a guest."}
          </p>
          <p class="muted">Basic, without an account, includes:</p>
          <ul class="perks perks--compact">
            {BASIC_ROWS.map((r) => (
              <li key={r.label} class="perk">
                <Check size={16} aria-hidden="true" />
                <span>
                  {typeof r.value === "string" ? (
                    <>
                      {r.label}: <strong>{r.value}</strong>
                    </>
                  ) : (
                    r.label
                  )}
                </span>
              </li>
            ))}
          </ul>
          <button
            class="btn btn--primary btn--block"
            onClick={onClose}
            data-testid="signin-guest"
          >
            Continue as guest
          </button>
        </div>
      </Sheet>
    );
  }

  const onTabKey = (e: KeyboardEvent) => {
    if (
      e.key !== "ArrowLeft" &&
      e.key !== "ArrowRight" &&
      e.key !== "Home" &&
      e.key !== "End"
    )
      return;
    e.preventDefault();
    const next: Method =
      e.key === "Home"
        ? "email"
        : e.key === "End"
          ? "phone"
          : method === "email"
            ? "phone"
            : "email";
    setMethod(next);
    tabs.current
      ?.querySelector<HTMLButtonElement>(`[data-method="${next}"]`)
      ?.focus();
  };

  const body = (() => {
    switch (view) {
      case "register":
        return (
          <RegisterForm
            initialEmail={identifier}
            onSubmit={register}
            onSignIn={toSignIn}
          />
        );
      case "forgot":
        return (
          <ForgotPassword
            initial={identifier}
            onSend={forgot}
            onBack={toSignIn}
          />
        );
      case "verify":
        return verify ? (
          <VerifyEmail state={verify} onVerified={finish} onBack={toSignIn} />
        ) : null;
      case "methods":
        return signedIn.current ? (
          <MethodsView
          me={signedIn.current}
          clientId={clientId}
          dark={dark}
          onUpdated={(m) => {
            signedIn.current = m;
            setMethodsMe(m);
          }}
          onDone={() => (signedIn.current ? onSignedIn(signedIn.current) : onClose())}
        />
        ) : null;
      case "username":
        return (
          <ChooseUsername
            initial={initialUsername}
            initialError={usernameError}
            onSave={saveUsername}
            onSkip={() =>
              signedIn.current ? onSignedIn(signedIn.current) : onClose()
            }
          />
        );
      default:
        return (
          <>
            <p class="auth-lede">
              Sign in free for {PLANS.free.shortTripsPerDay} trips a day, saved
              trips and charger reports. Basic keeps working without an account.
            </p>
            {clientId && (
              <GoogleButton
                clientId={clientId}
                dark={dark}
                disabled={busy !== null}
                onCredential={(c) => void google(c)}
              />
            )}
            {busy === "google" && (
              <p class="auth-busy" role="status">
                <Spinner /> Signing you in with Google…
              </p>
            )}
            {error && (
              <p
                class="auth-alert"
                role="alert"
                data-testid="signin-google-error"
              >
                {error}
              </p>
            )}
            {firebase && (
              <>
                {clientId && (
                  <div class="auth-or" role="separator">
                    <span>or</span>
                  </div>
                )}
                <div
                  class="auth-tabs"
                  role="tablist"
                  aria-label="Sign in with"
                  ref={tabs}
                  onKeyDown={onTabKey}
                >
                  {(["email", "phone"] as const).map((m) => (
                    <button
                      key={m}
                      type="button"
                      role="tab"
                      id={`auth-tab-${m}`}
                      data-method={m}
                      aria-selected={method === m}
                      aria-controls={`auth-panel-${m}`}
                      tabIndex={method === m ? 0 : -1}
                      class={`auth-tabs__tab${method === m ? " is-active" : ""}`}
                      onClick={() => setMethod(m)}
                      data-testid={`signin-tab-${m}`}
                    >
                      {m === "email" ? (
                        <Mail size={16} aria-hidden="true" />
                      ) : (
                        <Smartphone size={16} aria-hidden="true" />
                      )}
                      {m === "email" ? "Email" : "Phone"}
                    </button>
                  ))}
                </div>
                <div
                  role="tabpanel"
                  id={`auth-panel-${method}`}
                  aria-labelledby={`auth-tab-${method}`}
                  class="auth-panel"
                >
                  {method === "email" ? (
                    <EmailSignIn
                      identifier={identifier}
                      onIdentifier={setIdentifier}
                      onSubmit={signInWithPassword}
                      onForgot={() => setView("forgot")}
                      onRegister={() => setView("register")}
                    />
                  ) : (
                    <PhoneForm
                      firebase={firebase}
                      testMode={phoneTestMode(config)}
                      onToken={phoneToken}
                      onUseEmail={() => setMethod("email")}
                    />
                  )}
                </div>
              </>
            )}
            {config?.devLogin && (
              <button
                class="btn btn--block btn--ghost auth-dev"
                disabled={busy !== null}
                onClick={() => void dev()}
                data-testid="signin-dev"
              >
                {busy === "dev" ? <Spinner /> : null} Test sign-in (development
                only)
              </button>
            )}
            <p class="auth-legal">
              By continuing you agree to the <a href="/terms.html">terms</a> and{" "}
              <a href="/privacy.html">privacy policy</a>.
            </p>
          </>
        );
    }
  })();

  return (
    <Sheet title={TITLES[view]} onClose={close} modal>
      <div
        class={`auth auth--${view}`}
        data-testid="signin-sheet"
        data-view={view}
        ref={root}
      >
        {body}
      </div>
    </Sheet>
  );
}
