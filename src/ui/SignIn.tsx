import { useEffect, useRef, useState } from 'preact/hooks';
import { api, loadScript, type Config, type Me } from '../lib/api.ts';
import { Sheet } from './Sheet.tsx';

interface Props {
  config: Config | null;
  dark: boolean;
  onClose: () => void;
  onSignedIn: (me: Me) => void;
}

interface GoogleId {
  initialize(o: { client_id: string; callback: (r: { credential: string }) => void; ux_mode?: string; itp_support?: boolean }): void;
  renderButton(el: HTMLElement, o: Record<string, unknown>): void;
}

declare global {
  interface Window {
    google?: { accounts: { id: GoogleId } };
  }
}

export function SignIn({ config, dark, onClose, onSignedIn }: Props) {
  const button = useRef<HTMLDivElement>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const clientId = config?.googleClientId;

  useEffect(() => {
    if (!clientId) return;
    let cancelled = false;
    loadScript('https://accounts.google.com/gsi/client')
      .then(() => {
        if (cancelled || !window.google || !button.current) return;
        window.google.accounts.id.initialize({
          client_id: clientId,
          itp_support: true,
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
      })
      .catch(() => setError('Google sign-in could not load. Check your connection.'));
    return () => {
      cancelled = true;
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

  return (
    <Sheet title="Sign in" onClose={onClose} modal>
      <p class="muted">Sign in to plan trips and report charger status. We only get your name and email from Google, never your password.</p>
      <div class="signin">
        {clientId ? <div ref={button} class="signin__google" /> : <p class="notice">Google sign-in isn't set up on this server yet.</p>}
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
      <p class="small muted">
        By continuing you agree to the <a href="/terms.html">terms</a> and <a href="/privacy.html">privacy policy</a>.
      </p>
    </Sheet>
  );
}
