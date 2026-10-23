// Phone sign-in with a one-time code. Firebase needs its JS SDK (and an invisible reCAPTCHA) for this,
// so this module, and the SDK with it, loads only when the driver opens the Phone option. Only
// firebase/app and firebase/auth are used, with in-memory persistence: the ChargeOne session cookie is
// the real sign-in, the Firebase user is only needed until its ID token reaches the Worker.
import type { Auth, ConfirmationResult, RecaptchaVerifier } from 'firebase/auth';
import { authErrorCode, type FirebasePublicConfig } from '../shared/auth.ts';
import { FirebaseAuthError } from './firebaseRest.ts';

const APP_NAME = 'chargeone-phone';

let authPromise: Promise<{ auth: Auth; sdk: typeof import('firebase/auth') }> | null = null;

function loadAuth(config: FirebasePublicConfig, testMode: boolean) {
  authPromise ??= Promise.all([import('firebase/app'), import('firebase/auth')])
    .then(([app, sdk]) => {
      const existing = app.getApps().find((a) => a.name === APP_NAME);
      const fbApp = existing ?? app.initializeApp({ apiKey: config.apiKey, authDomain: config.authDomain, projectId: config.projectId, appId: config.appId }, APP_NAME);
      const auth = sdk.initializeAuth(fbApp, { persistence: sdk.inMemoryPersistence });
      auth.languageCode = 'en';
      // Local end-to-end tests only (see phoneTestMode): no reCAPTCHA, every network call is mocked.
      if (testMode) auth.settings.appVerificationDisabledForTesting = true;
      return { auth, sdk };
    })
    .catch((e: unknown) => {
      authPromise = null;
      throw e;
    });
  return authPromise;
}

/** The SDK's own errors (auth/...) and load failures as FirebaseAuthError with friendly text. */
export function toAuthError(e: unknown): FirebaseAuthError {
  if (e instanceof FirebaseAuthError) return e;
  const code = typeof e === 'object' && e !== null && 'code' in e ? (e as { code: unknown }).code : null;
  if (typeof code === 'string') return new FirebaseAuthError(authErrorCode(code));
  // A chunk that won't load means the connection dropped.
  return new FirebaseAuthError(e instanceof TypeError ? 'NETWORK' : 'UNKNOWN');
}

export interface PhoneCodeSent {
  /** Checks the code from the text message; resolves with the Firebase ID token. */
  confirm(code: string): Promise<string>;
}

export interface PhoneSignIn {
  /** Texts a code to the number (E.164). Each call needs a fresh reCAPTCHA, made here. */
  sendCode(e164: string): Promise<PhoneCodeSent>;
  dispose(): void;
}

/**
 * Prepares phone sign-in. `host` is an element the invisible reCAPTCHA can draw into (it stays empty
 * to the eye). testMode switches reCAPTCHA off for local tests with mocked Firebase; never in production.
 */
export async function phoneSignIn(config: FirebasePublicConfig, host: HTMLElement, testMode = false): Promise<PhoneSignIn> {
  let loaded: Awaited<ReturnType<typeof loadAuth>>;
  try {
    loaded = await loadAuth(config, testMode);
  } catch (e) {
    throw toAuthError(e);
  }
  const { auth, sdk } = loaded;
  let verifier: RecaptchaVerifier | null = null;
  const clear = () => {
    try {
      verifier?.clear();
    } catch {
      // Already gone with its element.
    }
    verifier = null;
    host.replaceChildren();
  };

  return {
    async sendCode(e164: string) {
      clear();
      const slot = document.createElement('div');
      host.appendChild(slot);
      verifier = new sdk.RecaptchaVerifier(auth, slot, { size: 'invisible' });
      let result: ConfirmationResult;
      try {
        result = await sdk.signInWithPhoneNumber(auth, e164, verifier);
      } catch (e) {
        clear();
        throw toAuthError(e);
      }
      return {
        async confirm(code: string) {
          try {
            const cred = await result.confirm(code);
            const token = await cred.user.getIdToken();
            // The ChargeOne session takes over from here; nothing of Firebase's is kept.
            void sdk.signOut(auth).catch(() => undefined);
            return token;
          } catch (e) {
            throw toAuthError(e);
          }
        },
      };
    },
    dispose: clear,
  };
}
