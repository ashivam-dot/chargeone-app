// The sign-in sheet loads on first use (it and its forms stay out of the start-up bundle); the app
// preloads it once the map is up so opening it feels instant.
import type { Config } from '../lib/api.ts';
import { lazy } from './shell/lazy.tsx';
import type { SignInSheetProps } from './signin/SignInSheet.tsx';

/** Sign-in is possible on this server: Google or Firebase is configured, or the development test login is on. */
export const signInReady = (config: Config | null) => Boolean(config?.googleClientId || config?.firebase || config?.devLogin);

export const SignIn = lazy<SignInSheetProps>(() => import('./signin/SignInSheet.tsx').then((m) => m.SignInSheet));
