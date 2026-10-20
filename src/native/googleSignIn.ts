// Native Google sign-in for the apps. The ID token goes to POST /api/auth/google as { credential }, like the web button.
import { IS_NATIVE, PLATFORM } from './bridge.ts';

const WEB_CLIENT_ID: string | null = (import.meta.env.VITE_GOOGLE_WEB_CLIENT_ID as string | undefined) || null;
const IOS_CLIENT_ID: string | null = (import.meta.env.VITE_GOOGLE_IOS_CLIENT_ID as string | undefined) || null;

/** True when this build can show the native Google account picker. */
export const nativeGoogleAvailable: boolean = IS_NATIVE && WEB_CLIENT_ID !== null && (PLATFORM !== 'ios' || IOS_CLIENT_ID !== null);

let initialized: Promise<void> | null = null;

async function plugin() {
  const { SocialLogin } = await import('@capgo/capacitor-social-login');
  initialized ??= SocialLogin.initialize({
    google: {
      webClientId: WEB_CLIENT_ID ?? undefined,
      iOSClientId: IOS_CLIENT_ID ?? undefined,
      mode: 'online',
    },
  }).catch((err: unknown) => {
    initialized = null;
    throw err;
  });
  await initialized;
  return SocialLogin;
}

/**
 * Opens the Google account picker and resolves the Google ID token.
 * Resolves null when this build isn't configured for it or the driver cancels; rejects on real failures.
 */
export async function nativeGoogleIdToken(): Promise<string | null> {
  if (!nativeGoogleAvailable) return null;
  const SocialLogin = await plugin();
  try {
    const { result } = await SocialLogin.login({ provider: 'google', options: { scopes: ['email', 'profile'] } });
    return result.responseType === 'online' ? result.idToken : null;
  } catch (err) {
    if ((err as { code?: unknown } | null)?.code === 'USER_CANCELLED') return null;
    throw err;
  }
}

export async function nativeGoogleSignOut(): Promise<void> {
  if (!nativeGoogleAvailable) return;
  const SocialLogin = await plugin();
  await SocialLogin.logout({ provider: 'google' }).catch(() => undefined);
}
