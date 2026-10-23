// The Firebase ID token from this tab's last email or phone sign-in, kept in memory only (never in
// storage) so "Delete my account" can delete the Firebase login too. Firebase only accepts it for
// that within a few minutes of signing in, so an older one isn't offered.
const FRESH_MS = 4 * 60_000;

let last: { token: string; at: number } | null = null;

export function rememberFirebaseToken(token: string | null | undefined, now = Date.now()): void {
  last = token ? { token, at: now } : null;
}

/** The token if the sign-in was recent enough for Firebase to delete the user with it. */
export function freshFirebaseToken(now = Date.now()): string | undefined {
  return last && now - last.at < FRESH_MS ? last.token : undefined;
}

export function forgetFirebaseToken(): void {
  last = null;
}
