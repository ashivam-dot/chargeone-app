// Firebase Authentication over its REST API (Identity Toolkit), without the Firebase SDK, so email
// and password sign-in adds no weight to the app. Phone sign-in needs reCAPTCHA and uses the SDK,
// loaded only when the driver picks it. Errors come back as FirebaseAuthError with a typed code and
// friendly English text. Never log tokens, passwords or the responses here.
import { AUTH_ERROR_TEXT, authErrorCode, type AuthErrorCode, type FirebasePublicConfig } from '../shared/auth.ts';

const TOOLKIT = 'https://identitytoolkit.googleapis.com/v1/accounts';
const SECURE_TOKEN = 'https://securetoken.googleapis.com/v1/token';
const TIMEOUT_MS = 15_000;

export class FirebaseAuthError extends Error {
  constructor(readonly code: AuthErrorCode) {
    super(AUTH_ERROR_TEXT[code]);
    this.name = 'FirebaseAuthError';
  }
}

/** A signed-in Firebase session. idToken lasts an hour; refreshToken gets a new one. */
export interface FirebaseSession {
  idToken: string;
  refreshToken: string;
  /** Firebase uid. */
  localId: string;
  email?: string;
  /** Seconds until idToken expires. */
  expiresIn: number;
}

export interface FirebaseAccountInfo {
  localId: string;
  email?: string;
  emailVerified?: boolean;
  phoneNumber?: string;
  displayName?: string;
}

type FetchLike = (input: string, init: RequestInit) => Promise<Response>;

async function call<T>(url: string, init: RequestInit, fetchImpl: FetchLike): Promise<T> {
  let res: Response;
  try {
    res = await fetchImpl(url, { ...init, signal: AbortSignal.timeout(TIMEOUT_MS) });
  } catch {
    throw new FirebaseAuthError('NETWORK');
  }
  const data = (await res.json().catch(() => null)) as (T & { error?: { message?: string } }) | null;
  if (res.ok && data) return data;
  if (res.status >= 500 || !data) throw new FirebaseAuthError('NETWORK');
  throw new FirebaseAuthError(authErrorCode(data.error?.message));
}

/** The Identity Toolkit client for one Firebase project. */
export function firebaseRest(config: FirebasePublicConfig, fetchImpl: FetchLike = (u, i) => fetch(u, i)) {
  const post = <T>(method: string, body: Record<string, unknown>) =>
    call<T>(`${TOOLKIT}:${method}?key=${encodeURIComponent(config.apiKey)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }, fetchImpl);
  const session = (d: { idToken: string; refreshToken: string; localId: string; email?: string; expiresIn?: string }): FirebaseSession => ({
    idToken: d.idToken,
    refreshToken: d.refreshToken,
    localId: d.localId,
    email: d.email,
    expiresIn: Number(d.expiresIn ?? 3600) || 3600,
  });

  return {
    /** Registers an email and password account (unverified until the link in the email is opened). */
    signUp: async (email: string, password: string, displayName?: string) => {
      const out = session(await post('signUp', { email, password, returnSecureToken: true }));
      if (displayName) await post('update', { idToken: out.idToken, displayName, returnSecureToken: false }).catch(() => undefined);
      return out;
    },
    signInWithPassword: async (email: string, password: string) => session(await post('signInWithPassword', { email, password, returnSecureToken: true })),
    /** Emails the verification link for the signed-in account. */
    sendVerifyEmail: async (idToken: string) => {
      await post('sendOobCode', { requestType: 'VERIFY_EMAIL', idToken });
    },
    /** Emails a password reset link. Firebase answers the same whether or not the account exists (with enumeration protection on). */
    sendPasswordReset: async (email: string) => {
      await post('sendOobCode', { requestType: 'PASSWORD_RESET', email });
    },
    /** The account behind an ID token, for example to see whether the email is verified yet. */
    lookup: async (idToken: string): Promise<FirebaseAccountInfo | null> => {
      const out = await post<{ users?: FirebaseAccountInfo[] }>('lookup', { idToken });
      return out.users?.[0] ?? null;
    },
    /** Deletes the Firebase user. Needs an ID token from a sign-in in the last few minutes. */
    deleteAccount: async (idToken: string) => {
      await post('delete', { idToken });
    },
    /** A fresh ID token (for example after the email was verified, so the new token says so). */
    refreshIdToken: async (refreshToken: string): Promise<FirebaseSession> => {
      const d = await call<{ id_token: string; refresh_token: string; user_id: string; expires_in?: string }>(
        `${SECURE_TOKEN}?key=${encodeURIComponent(config.apiKey)}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: refreshToken }).toString(),
        },
        fetchImpl,
      );
      return { idToken: d.id_token, refreshToken: d.refresh_token, localId: d.user_id, expiresIn: Number(d.expires_in ?? 3600) || 3600 };
    },
  };
}

export type FirebaseRest = ReturnType<typeof firebaseRest>;
