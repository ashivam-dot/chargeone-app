// "Sign-in methods" for a signed-in account: what it signs in with, adding Google (accounts are
// never joined just because the emails match, so adding is done here, signed in), and removing a
// method that isn't the last one. Removing signs every other device out.
import { KeyRound, Mail, Smartphone } from "lucide-preact";
import { useState } from "preact/hooks";
import { api, type Me } from "../../lib/api.ts";
import type { AuthProvider } from "../../shared/auth.ts";
import { Spinner, errorText } from "./fields.tsx";
import { GoogleButton } from "./GoogleButton.tsx";

const LABEL: Record<AuthProvider, string> = {
  google: "Google",
  password: "Email and password",
  phone: "Mobile number",
};

interface Props {
  me: Me;
  clientId: string | null;
  dark: boolean;
  onUpdated: (me: Me) => void;
  onDone: () => void;
}

export function MethodsView({ me, clientId, dark, onUpdated, onDone }: Props) {
  const [busy, setBusy] = useState<AuthProvider | null>(null);
  const [confirm, setConfirm] = useState<AuthProvider | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);
  const user = me.user;
  const methods = user?.methods ?? [];

  const detail = (m: AuthProvider) =>
    m === "phone" ? (user?.phone ?? "") : (user?.email ?? "");

  const run = async (m: AuthProvider, fn: () => Promise<Me>, done: string) => {
    setBusy(m);
    setError(null);
    setInfo(null);
    try {
      onUpdated(await fn());
      setInfo(done);
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(null);
      setConfirm(null);
    }
  };

  return (
    <div class="auth-methods" data-testid="signin-methods">
      <p class="auth-lede" tabIndex={-1} data-autofocus>
        The ways you can sign in to this account.
      </p>
      <ul class="auth-methods__list">
        {methods.map((m) => (
          <li key={m} class="auth-methods__item" data-testid={`method-${m}`}>
            <span class="auth-methods__icon" aria-hidden="true">
              {m === "phone" ? (
                <Smartphone size={18} />
              ) : m === "password" ? (
                <KeyRound size={18} />
              ) : (
                <Mail size={18} />
              )}
            </span>
            <span class="auth-methods__text">
              <strong>{LABEL[m]}</strong>
              {detail(m) && <span class="muted small">{detail(m)}</span>}
            </span>
            {methods.length > 1 &&
              (confirm === m ? (
                <button
                  type="button"
                  class="btn btn--ghost"
                  disabled={busy !== null}
                  onClick={() =>
                    void run(
                      m,
                      () => api.unlinkMethod(m),
                      `${LABEL[m]} removed. Other devices were signed out.`,
                    )
                  }
                  data-testid={`method-${m}-confirm`}
                >
                  {busy === m ? <Spinner /> : null} Remove for good
                </button>
              ) : (
                <button
                  type="button"
                  class="link small"
                  disabled={busy !== null}
                  aria-label={`Remove ${LABEL[m]}`}
                  onClick={() => setConfirm(m)}
                  data-testid={`method-${m}-remove`}
                >
                  Remove
                </button>
              ))}
          </li>
        ))}
      </ul>
      {methods.length === 1 && (
        <p class="muted small">
          This is your only way in, so it can't be removed.
        </p>
      )}
      {!methods.includes("google") && clientId && (
        <div class="auth-methods__add">
          <p class="small">
            Add Google{user?.email ? ` (the Google account for ${user.email})` : ""}{" "}
            to sign in with it too.
          </p>
          <GoogleButton
            clientId={clientId}
            dark={dark}
            disabled={busy !== null}
            onCredential={(c) =>
              void run("google", () => api.linkGoogle(c), "Google added.")
            }
          />
        </div>
      )}
      {error && (
        <p class="auth-alert" role="alert" data-testid="methods-error">
          {error}
        </p>
      )}
      {info && (
        <p class="auth-ok" role="status" data-testid="methods-info">
          {info}
        </p>
      )}
      <button
        type="button"
        class="btn btn--block btn--glass"
        onClick={onDone}
        data-testid="methods-done"
      >
        Done
      </button>
    </div>
  );
}
