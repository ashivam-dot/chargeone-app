import { Check } from 'lucide-preact';
import { useEffect, useRef, useState } from 'preact/hooks';
import { api, loadScript, type Config, type Me } from '../lib/api.ts';
import { BASIC, COMPARE, PLANS } from '../shared/plans.ts';
import { Sheet } from './Sheet.tsx';

interface Props {
  config: Config | null;
  dark: boolean;
  onClose: () => void;
  onSignedIn: (me: Me) => void;
}

interface GoogleId {
  initialize(o: {
    client_id: string;
    callback: (r: { credential: string }) => void;
    ux_mode?: string;
    itp_support?: boolean;
    use_fedcm_for_button?: boolean;
  }): void;
  renderButton(el: HTMLElement, o: Record<string, unknown>): void;
}

declare global {
  interface Window {
    google?: { accounts: { id: GoogleId } };
  }
}

/** Google draws its button in an iframe; if none appears by then, the button was refused. */
const BUTTON_WAIT_MS = 6000;

/** What works without an account, from the same rows the plans screen shows. */
const BASIC_ROWS = COMPARE.map((r) => ({ label: r.label, value: r.value(BASIC) })).filter((r) => r.value !== false);

/** Sign-in is possible on this server: Google is configured, or the development test login is on. */
export const signInReady = (config: Config | null) => Boolean(config?.googleClientId || config?.devLogin);

export function SignIn({ config, dark, onClose, onSignedIn }: Props) {
  const button = useRef<HTMLDivElement>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [buttonMissing, setButtonMissing] = useState(false);
  const clientId = config?.googleClientId;

  useEffect(() => {
    if (!clientId) return;
    let cancelled = false;
    let timer = 0;
    setButtonMissing(false);
    loadScript('https://accounts.google.com/gsi/client')
      .then(() => {
        if (cancelled || !window.google || !button.current) return;
        window.google.accounts.id.initialize({
          client_id: clientId,
          // Safari and other browsers without third-party cookies: ITP flow, and FedCM where offered.
          itp_support: true,
          use_fedcm_for_button: true,
          callback: async ({ credential }) => {
            setBusy(true);
            setError(null);
            try {
              onSignedIn(await api.signInGoogle(credential));
            } catch (e) {
              setError(e instanceof Error ? e.message : 'Sign-in failed.');
            } finally {
              setBusy(false);
            }
          },
        });
        window.google.accounts.id.renderButton(button.current, {
          theme: dark ? 'filled_black' : 'outline',
          size: 'large',
          shape: 'pill',
          text: 'continue_with',
          width: 300,
        });
        timer = window.setTimeout(() => {
          if (!cancelled && !button.current?.querySelector('iframe')) setButtonMissing(true);
        }, BUTTON_WAIT_MS);
      })
      .catch(() => setError('Google sign-in could not load. Check your connection, or turn off a content blocker for this site.'));
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [clientId, dark]);

  const devSignIn = async () => {
    setBusy(true);
    try {
      onSignedIn(await api.signInDev());
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Sign-in failed.');
    } finally {
      setBusy(false);
    }
  };

  if (!signInReady(config)) {
    return (
      <Sheet title="Sign in" onClose={onClose} modal>
        <div data-testid="signin-unavailable">
          <p class="notice">
            {config
              ? 'Google sign-in is being set up. Until then, keep using ChargeOne as a guest.'
              : "Couldn't check sign-in right now. Check your connection, or keep using ChargeOne as a guest."}
          </p>
          <p class="muted">Basic, without an account, includes:</p>
          <ul class="perks perks--compact">
            {BASIC_ROWS.map((r) => (
              <li key={r.label} class="perk">
                <Check size={16} aria-hidden="true" />
                <span>
                  {typeof r.value === 'string' ? (
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
          <button class="btn btn--primary btn--block" onClick={onClose} data-testid="signin-guest">
            Continue as guest
          </button>
        </div>
      </Sheet>
    );
  }

  return (
    <Sheet title="Sign in" onClose={onClose} modal>
      <p class="muted">
        Sign in free for {PLANS.free.shortTripsPerDay} trips a day and to report charger status. We only get your name and email from Google, never your
        password.
      </p>
      <div class="signin">
        {clientId && <div ref={button} class="signin__google" data-testid="signin-google" />}
        {config?.devLogin && (
          <button class="btn btn--block" disabled={busy} onClick={() => void devSignIn()}>
            Test sign-in (development only)
          </button>
        )}
      </div>
      {busy && <p class="muted center">Signing you in…</p>}
      {error && (
        <p class="notice notice--error" role="alert">
          {error}
        </p>
      )}
      {clientId && buttonMissing && !error && (
        <div class="notice notice--error" role="alert" data-testid="signin-button-missing">
          <p>Google's sign-in button didn't appear. Allow third-party sign-in for this site, or try another browser. You can keep using ChargeOne as a guest.</p>
          <details class="small">
            <summary>For the site owner</summary>
            {/* Google refuses the button when this origin isn't listed on the OAuth client. */}
            Add <code>{window.location.origin}</code> to Authorized JavaScript origins of this OAuth client in Google Cloud Console (APIs &amp;
            Services, Credentials). Changes can take a few minutes.
          </details>
        </div>
      )}
      <p class="small muted">
        By continuing you agree to the <a href="/terms.html">terms</a> and <a href="/privacy.html">privacy policy</a>.
      </p>
    </Sheet>
  );
}
