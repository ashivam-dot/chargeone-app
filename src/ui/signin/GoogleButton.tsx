// Google's own "Continue with Google" button (Google Identity Services draws it in an iframe).
import { useEffect, useRef, useState } from "preact/hooks";
import { loadScript } from "../../lib/api.ts";

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

interface Props {
  clientId: string;
  dark: boolean;
  disabled: boolean;
  onCredential: (credential: string) => void;
}

export function GoogleButton({
  clientId,
  dark,
  disabled,
  onCredential,
}: Props) {
  const box = useRef<HTMLDivElement>(null);
  const [missing, setMissing] = useState(false);
  const [loadFailed, setLoadFailed] = useState(false);
  const callback = useRef(onCredential);
  callback.current = onCredential;

  useEffect(() => {
    let cancelled = false;
    let timer = 0;
    setMissing(false);
    setLoadFailed(false);
    loadScript("https://accounts.google.com/gsi/client")
      .then(() => {
        const el = box.current;
        if (cancelled || !window.google || !el) return;
        window.google.accounts.id.initialize({
          client_id: clientId,
          // Safari and other browsers without third-party cookies: ITP flow, and FedCM where offered.
          itp_support: true,
          use_fedcm_for_button: true,
          callback: ({ credential }) => callback.current(credential),
        });
        el.replaceChildren();
        window.google.accounts.id.renderButton(el, {
          theme: dark ? "filled_black" : "outline",
          size: "large",
          shape: "pill",
          text: "continue_with",
          logo_alignment: "center",
          // Google's button is 200 to 400 px wide; match the form below it.
          width: Math.round(
            Math.max(200, Math.min(400, el.clientWidth || 320)),
          ),
        });
        timer = window.setTimeout(() => {
          if (!cancelled && !el.querySelector("iframe")) setMissing(true);
        }, BUTTON_WAIT_MS);
      })
      .catch(() => !cancelled && setLoadFailed(true));
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [clientId, dark]);

  return (
    <div class="auth-google">
      <div
        ref={box}
        class={`auth-google__button${disabled ? " is-busy" : ""}`}
        data-testid="signin-google"
      />
      {loadFailed && (
        <p class="auth-note" role="alert" data-testid="signin-google-failed">
          Google sign-in couldn't load. Check your connection or content
          blocker, or use email or phone below.
        </p>
      )}
      {missing && !loadFailed && (
        <div class="auth-note" role="alert" data-testid="signin-button-missing">
          <p>
            Google's button didn't appear. Allow third-party sign-in for this
            site, or use email or phone below.
          </p>
          <details class="small">
            <summary>For the site owner</summary>
            {/* Google refuses the button when this origin isn't listed on the OAuth client. */}
            Add <code>{window.location.origin}</code> to Authorized JavaScript
            origins of this OAuth client in Google Cloud Console (APIs &amp;
            Services, Credentials). Changes can take a few minutes.
          </details>
        </div>
      )}
    </div>
  );
}
