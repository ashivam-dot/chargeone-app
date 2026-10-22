// Sign-in methods of an account (Google, email and password, phone) and how they find each other.
//
// - Google stays keyed by users.google_sub. Password and phone are keyed by the Firebase uid in
//   auth_identities.
// - Accounts are never joined silently across methods. Opening a verification link only proves
//   someone clicked it, not that they made the password, so a password sign-in whose email belongs
//   to a Google or phone account, and a first Google sign-in whose email belongs to a password
//   account, get 409 account_exists. Adding Google happens signed in (POST /api/auth/link/google),
//   and any method but the last can be removed (POST /api/auth/unlink), which signs out every device.
//   Trials still see one person through the email (canonical form) in trial.ts.
// - A phone number that comes back under a new Firebase uid finds its account by a keyed hash.
// - Usernames (optional) let a password account sign in without typing the email.
// Never log emails, phone numbers, tokens or passwords from here.
import {
  isEmail,
  maskEmail,
  maskPhone,
  normalizeUsername,
  stripHandle,
  usernameProblem,
  USERNAME_PROBLEM_TEXT,
  type AuthProvider,
  type MeUser,
  type UsernameProblem,
} from '../src/shared/auth.ts';
import { requireSecret, upsertUser, type GoogleIdentity, type User } from './auth.ts';
import { hmacSha256, toHex } from './crypto.ts';
import type { Env } from './env.ts';
import {
  deleteFirebaseUser,
  firebaseConfig,
  requireFirebase,
  sendPasswordReset,
  signInWithPassword,
  verifyFirebaseIdToken,
  type FirebaseIdentity,
} from './firebase.ts';
import { HttpError, clientKey, enforceRateLimitRetry, readJson, shortHash, str } from './http.ts';

const DELETED = 'deleted';
const E164 = /^\+[1-9]\d{7,14}$/;
const WINDOW_15_MIN = 15 * 60;
/** Password sign-ins (right or wrong) per network and per username or email in 15 minutes. */
export const PASSWORD_LOGIN_LIMIT = 10;
/** Password reset emails per network in 15 minutes, and per username or email in an hour. */
export const FORGOT_IP_LIMIT = 5;
export const FORGOT_ID_LIMIT = 3;
/** Username availability checks per network a minute, and username changes per account a day. */
export const USERNAME_CHECK_LIMIT = 30;
export const USERNAME_SET_LIMIT = 10;

const WAIT = 'Too many attempts. Wait a few minutes and try again, or sign in with Google.';
const BAD_LOGIN = "That username or password isn't right.";
export const FORGOT_MESSAGE = "If an account exists for that email or username, we've emailed it a link to reset the password.";

const now = () => new Date().toISOString();
const keyedHash = async (env: Env, label: string) => toHex(await hmacSha256(requireSecret(env), label));

/** A fresh address that can't exist, so an unknown username costs Firebase the same round trip as a real one. */
const noAccountEmail = () => `no-account-${crypto.randomUUID()}@no-account.chargeone.invalid`;

async function userById(env: Env, id: string): Promise<User> {
  const row = await env.DB.prepare('SELECT id, email, name FROM users WHERE id = ?1').bind(id).first<User>();
  if (!row) throw new HttpError(500, 'internal', 'Could not load the account.');
  return row;
}

interface IdentityExtra {
  display?: string | null;
  phoneHash?: string | null;
}

function identityInsert(env: Env, provider: AuthProvider, uid: string, userId: string, extra: IdentityExtra, onConflict: 'update' | 'nothing') {
  const at = now();
  const conflict =
    onConflict === 'nothing'
      ? 'ON CONFLICT DO NOTHING'
      : `ON CONFLICT(provider, provider_uid) DO UPDATE SET user_id = excluded.user_id,
           display = COALESCE(excluded.display, auth_identities.display),
           phone_hash = COALESCE(excluded.phone_hash, auth_identities.phone_hash),
           last_used_at = excluded.last_used_at`;
  return env.DB.prepare(
    `INSERT INTO auth_identities (provider, provider_uid, user_id, display, phone_hash, created_at, last_used_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?6) ${conflict}`,
  ).bind(provider, uid, userId, extra.display ?? null, extra.phoneHash ?? null, at);
}

async function linkIdentity(env: Env, provider: AuthProvider, uid: string, userId: string, extra: IdentityExtra = {}): Promise<void> {
  await identityInsert(env, provider, uid, userId, extra, 'update').run();
}

/** Development login only: gives the test account a password or phone identity, as a real sign-in would. */
export async function linkDevIdentity(env: Env, provider: 'password' | 'phone', email: string, userId: string): Promise<void> {
  await linkIdentity(env, provider, `dev:${email}`, userId);
}

/**
 * A new account with this identity. If a parallel request linked the identity first, that account
 * wins and the one made here (which has nothing in it yet) is removed.
 */
async function createLinkedUser(env: Env, provider: AuthProvider, uid: string, email: string, name: string | null, extra: IdentityExtra = {}): Promise<User> {
  const id = crypto.randomUUID();
  await env.DB.batch([
    env.DB.prepare('INSERT INTO users (id, google_sub, email, name, created_at) VALUES (?1, NULL, ?2, ?3, ?4)').bind(id, email, name, now()),
    identityInsert(env, provider, uid, id, extra, 'nothing'),
  ]);
  const owner = await env.DB.prepare('SELECT user_id FROM auth_identities WHERE provider = ?1 AND provider_uid = ?2')
    .bind(provider, uid)
    .first<{ user_id: string }>();
  if (!owner) throw new HttpError(500, 'internal', 'Could not create the account.');
  if (owner.user_id !== id) await env.DB.prepare('DELETE FROM users WHERE id = ?1').bind(id).run();
  return userById(env, owner.user_id);
}

async function knownIdentity(env: Env, provider: AuthProvider, uid: string): Promise<string | null> {
  const row = await env.DB.prepare(
    `SELECT i.user_id FROM auth_identities i JOIN users u ON u.id = i.user_id
     WHERE i.provider = ?1 AND i.provider_uid = ?2 AND u.email <> ?3`,
  )
    .bind(provider, uid, DELETED)
    .first<{ user_id: string }>();
  return row?.user_id ?? null;
}

// ---- Firebase sign-in (email and password, phone) ----

export interface SignInOptions {
  /** Name typed at registration, used when the account has none yet. */
  name?: string | null;
  /** Added to the 403 email_unverified answer (the username sign-in passes the ID token for "resend"). */
  unverifiedExtra?: Record<string, unknown>;
}

/** Finds or creates the ChargeOne account for a verified Firebase identity. */
export async function firebaseUser(env: Env, identity: FirebaseIdentity, opts: SignInOptions = {}): Promise<User> {
  const name = opts.name?.trim().slice(0, 100) || identity.name;
  if (identity.provider === 'password') {
    const email = identity.email;
    if (!email || !isEmail(email)) throw new HttpError(401, 'bad_firebase_token', 'Sign-in failed. Please try again.');
    if (!identity.emailVerified) {
      throw new HttpError(403, 'email_unverified', `Verify your email first: open the link we sent to ${maskEmail(email)}.`, {
        email: maskEmail(email),
        ...opts.unverifiedExtra,
      });
    }
    const known = await knownIdentity(env, 'password', identity.uid);
    if (known) {
      await linkIdentity(env, 'password', identity.uid, known);
      return userById(env, known);
    }
    const sameEmail = await env.DB.prepare(
      `SELECT u.id,
         (u.google_sub IS NOT NULL OR EXISTS (SELECT 1 FROM auth_identities i WHERE i.user_id = u.id AND i.provider <> 'password')) AS other
       FROM users u WHERE LOWER(u.email) = ?1 AND u.email NOT IN ('', ?2) AND u.is_test = 0 ORDER BY u.created_at LIMIT 1`,
    )
      .bind(email, DELETED)
      .first<{ id: string; other: number }>();
    if (sameEmail?.other) {
      // Never joined silently: whoever opened a verification link hasn't shown they own this account.
      const { methods } = await accountProfile(env, await userById(env, sameEmail.id));
      const how = methods.includes('google') ? 'Continue with Google' : 'Sign in with your phone number';
      throw new HttpError(409, 'account_exists', `This email already has a ChargeOne account. ${how} to open it.`, { methods });
    }
    if (sameEmail) {
      // Only password logins on that account (its old Firebase user is gone): the same mailbox, same person.
      await env.DB.batch([
        identityInsert(env, 'password', identity.uid, sameEmail.id, {}, 'update'),
        env.DB.prepare('UPDATE users SET name = ?1 WHERE id = ?2 AND name IS NULL').bind(name, sameEmail.id),
      ]);
      return userById(env, sameEmail.id);
    }
    return createLinkedUser(env, 'password', identity.uid, email, name);
  }

  if (identity.provider === 'phone') {
    const phone = identity.phoneNumber;
    if (!phone || !E164.test(phone)) throw new HttpError(401, 'bad_firebase_token', 'Sign-in failed. Please try again.');
    const extra = { display: maskPhone(phone), phoneHash: await keyedHash(env, `phone:${phone}`) };
    const known = await knownIdentity(env, 'phone', identity.uid);
    if (known) {
      await linkIdentity(env, 'phone', identity.uid, known, extra);
      return userById(env, known);
    }
    const samePhone = await env.DB.prepare(
      `SELECT i.user_id FROM auth_identities i JOIN users u ON u.id = i.user_id
       WHERE i.provider = 'phone' AND i.phone_hash = ?1 AND u.email <> ?2 ORDER BY i.created_at LIMIT 1`,
    )
      .bind(extra.phoneHash, DELETED)
      .first<{ user_id: string }>();
    if (samePhone) {
      await linkIdentity(env, 'phone', identity.uid, samePhone.user_id, extra);
      return userById(env, samePhone.user_id);
    }
    return createLinkedUser(env, 'phone', identity.uid, '', name, extra);
  }

  throw new HttpError(400, 'unsupported_provider', 'Sign in with Google, email or your mobile number.');
}

/** POST /api/auth/firebase {idToken, name?}: an ID token from email or phone sign-in in the browser. */
export async function firebaseSignIn(req: Request, env: Env): Promise<User> {
  const config = requireFirebase(env);
  await enforceRateLimitRetry(env.DB, `auth:${await clientKey(req)}`, 20, 600, WAIT);
  const body = await readJson(req, 8192);
  const idToken = str(body, 'idToken', { max: 4096 })!;
  const name = str(body, 'name', { max: 100, optional: true });
  const identity = await verifyFirebaseIdToken(idToken, config.projectId);
  return firebaseUser(env, identity, { name });
}

// ---- Google sign-in, and adding Google to an account explicitly ----

/**
 * A first Google sign-in whose email already has a password account is refused rather than joined:
 * that password account may have been made by someone else (they only needed its owner to open one
 * verification link). The owner signs in with the password and adds Google from "Sign-in methods".
 */
export async function googleUser(env: Env, google: GoogleIdentity): Promise<User> {
  const known = await env.DB.prepare('SELECT id FROM users WHERE google_sub = ?1').bind(google.sub).first();
  if (!known) {
    const match = await env.DB.prepare(
      `SELECT u.id FROM users u
       WHERE u.google_sub IS NULL AND LOWER(u.email) = LOWER(?1) AND u.email NOT IN ('', ?2) AND u.is_test = 0
         AND EXISTS (SELECT 1 FROM auth_identities i WHERE i.user_id = u.id AND i.provider = 'password')
       LIMIT 1`,
    )
      .bind(google.email, DELETED)
      .first<{ id: string }>();
    if (match) {
      throw new HttpError(
        409,
        'account_exists',
        'This email already has a ChargeOne account with a password. Sign in with your email or username and password, then add Google under You, Sign-in methods.',
        { methods: ['password'] },
      );
    }
  }
  const user = await upsertUser(env, google.sub, google.email, google.name);
  await linkIdentity(env, 'google', google.sub, user.id);
  return user;
}

/**
 * POST /api/auth/link/google {credential}: adds Google to the signed-in account. The Google account
 * must have the account's email (phone-only accounts take the Google email) and no account of its own.
 */
export async function linkGoogle(env: Env, user: User, google: GoogleIdentity): Promise<void> {
  const inUse = () =>
    new HttpError(409, 'google_in_use', 'That Google account already has its own ChargeOne account. Sign in with it, or delete that account first.');
  const row = await env.DB.prepare('SELECT google_sub, email FROM users WHERE id = ?1').bind(user.id).first<{ google_sub: string | null; email: string }>();
  if (!row || row.email === DELETED) throw new HttpError(401, 'signed_out', 'Please sign in first.');
  if (row.google_sub === google.sub) return;
  if (row.google_sub) throw new HttpError(409, 'google_linked', 'This account already signs in with another Google account. Remove it first.');
  if (row.email && row.email.toLowerCase() !== google.email.toLowerCase()) {
    throw new HttpError(400, 'email_mismatch', `Choose the Google account for ${maskEmail(row.email)}.`);
  }
  if (await env.DB.prepare('SELECT 1 FROM users WHERE google_sub = ?1').bind(google.sub).first()) throw inUse();
  let changes = 0;
  try {
    const res = await env.DB.prepare(
      `UPDATE users SET google_sub = ?1, email = CASE WHEN email = '' THEN ?3 ELSE email END
       WHERE id = ?2 AND google_sub IS NULL`,
    )
      .bind(google.sub, user.id, google.email.toLowerCase())
      .run();
    changes = res.meta.changes ?? 0;
  } catch (err) {
    // Only the unique index on google_sub (a parallel sign-in with that Google account) is expected.
    if (String(err).includes('UNIQUE')) throw inUse();
    throw err;
  }
  if (!changes) throw new HttpError(409, 'google_linked', 'This account already signs in with another Google account. Remove it first.');
  await linkIdentity(env, 'google', google.sub, user.id);
}

/**
 * POST /api/auth/unlink {provider}: removes one sign-in method, never the last one. The caller then
 * signs every other device out, so a method that was added by someone else loses its session too.
 */
export async function unlinkMethod(req: Request, env: Env, user: User): Promise<AuthProvider> {
  const body = await readJson(req, 256);
  const provider = body.provider;
  if (provider !== 'google' && provider !== 'password' && provider !== 'phone') {
    throw new HttpError(400, 'invalid', 'Choose google, password or phone.');
  }
  const { methods } = await accountProfile(env, user);
  if (!methods.includes(provider)) throw new HttpError(404, 'not_linked', 'This account does not sign in that way.');
  if (methods.length < 2) throw new HttpError(409, 'last_method', 'This is the only way to sign in to this account. Add another before removing it.');
  const remove = env.DB.prepare('DELETE FROM auth_identities WHERE user_id = ?1 AND provider = ?2').bind(user.id, provider);
  const extra =
    provider === 'google'
      ? [env.DB.prepare("UPDATE users SET google_sub = NULL WHERE id = ?1 AND google_sub NOT LIKE '%:%'").bind(user.id)]
      : provider === 'password'
        ? // A username only signs in with a password.
          [env.DB.prepare('UPDATE users SET username = NULL WHERE id = ?1').bind(user.id)]
        : [];
  await env.DB.batch([remove, ...extra]);
  return provider;
}

// ---- Profile ----

const METHOD_ORDER: AuthProvider[] = ['google', 'password', 'phone'];

/** The account as /api/me shows it: the email (null for phone-only), username, masked phone and sign-in methods. */
export async function accountProfile(env: Env, user: User): Promise<MeUser> {
  const [row, ids] = await Promise.all([
    env.DB.prepare('SELECT username, google_sub FROM users WHERE id = ?1').bind(user.id).first<{ username: string | null; google_sub: string | null }>(),
    env.DB.prepare('SELECT provider, display FROM auth_identities WHERE user_id = ?1 ORDER BY created_at')
      .bind(user.id)
      .all<{ provider: AuthProvider; display: string | null }>(),
  ]);
  const methods = new Set(ids.results.map((r) => r.provider));
  if (row?.google_sub && !row.google_sub.includes(':')) methods.add('google');
  return {
    email: user.email && user.email !== DELETED ? user.email : null,
    name: user.name,
    username: row?.username ?? null,
    phone: ids.results.find((r) => r.provider === 'phone')?.display ?? null,
    methods: METHOD_ORDER.filter((m) => methods.has(m)),
  };
}

// ---- Usernames ----

function parseUsername(raw: unknown): string {
  if (typeof raw !== 'string' || raw.length > 100) throw new HttpError(400, 'invalid_username', USERNAME_PROBLEM_TEXT.bad_chars, { reason: 'bad_chars' });
  const username = normalizeUsername(raw);
  const problem = usernameProblem(username);
  if (problem) throw new HttpError(400, 'invalid_username', USERNAME_PROBLEM_TEXT[problem], { reason: problem });
  return username;
}

/** The sign-in email behind a username, only for accounts that have a password. */
async function emailForUsername(env: Env, username: string): Promise<string | null> {
  const row = await env.DB.prepare(
    `SELECT u.email FROM users u WHERE u.username = ?1 AND u.email NOT IN ('', ?2)
       AND EXISTS (SELECT 1 FROM auth_identities i WHERE i.user_id = u.id AND i.provider = 'password')`,
  )
    .bind(username, DELETED)
    .first<{ email: string }>();
  return row?.email ?? null;
}

/** An email typed in, or the email behind a username; null when there's no such password account. */
async function resolveIdentifier(env: Env, identifier: string): Promise<string | null> {
  const value = stripHandle(identifier).toLowerCase();
  if (value.includes('@')) return isEmail(value) ? value : null;
  return usernameProblem(value) ? null : emailForUsername(env, value);
}

/** GET /api/auth/username-available?u=: whether a username can be taken. */
export async function usernameAvailability(req: Request, env: Env): Promise<{ username: string; available: boolean; reason: UsernameProblem | 'taken' | null }> {
  await enforceRateLimitRetry(env.DB, `uname-ip:${await clientKey(req)}`, USERNAME_CHECK_LIMIT, 60, 'Too many checks. Wait a minute and try again.');
  const username = normalizeUsername((new URL(req.url).searchParams.get('u') ?? '').slice(0, 100));
  const problem = usernameProblem(username);
  if (problem) return { username, available: false, reason: problem };
  const taken = await env.DB.prepare('SELECT 1 FROM users WHERE username = ?1').bind(username).first();
  return { username, available: !taken, reason: taken ? 'taken' : null };
}

/** POST /api/auth/username {username}: sets or changes the signed-in account's username. */
export async function claimUsername(req: Request, env: Env, user: User): Promise<{ username: string }> {
  const body = await readJson(req, 512);
  const username = parseUsername(body.username);
  // A username stands in for the email at password sign-in, so it is only for accounts with a password.
  const hasPassword = await env.DB.prepare("SELECT 1 FROM auth_identities WHERE user_id = ?1 AND provider = 'password'").bind(user.id).first();
  if (!hasPassword) {
    throw new HttpError(409, 'username_needs_password', 'Usernames are for signing in with a password. This account signs in with Google or a phone number.');
  }
  await enforceRateLimitRetry(env.DB, `uname-set:${user.id}`, USERNAME_SET_LIMIT, 86400, 'You have changed your username too often today. Try again tomorrow.');
  const taken = () => new HttpError(409, 'username_taken', USERNAME_PROBLEM_TEXT.taken, { reason: 'taken' });
  let changes = 0;
  try {
    const res = await env.DB.prepare(
      `UPDATE users SET username = ?1 WHERE id = ?2 AND email <> ?3
         AND NOT EXISTS (SELECT 1 FROM users WHERE username = ?1 AND id <> ?2)`,
    )
      .bind(username, user.id, DELETED)
      .run();
    changes = res.meta.changes ?? 0;
  } catch (err) {
    // The unique index caught a parallel claim of the same name.
    if (String(err).includes('UNIQUE')) throw taken();
    throw err;
  }
  if (!changes) throw taken();
  return { username };
}

// ---- Username or email sign-in through the Worker, and password reset ----

function readIdentifier(body: Record<string, unknown>): string {
  const raw = body.username ?? body.identifier;
  if (typeof raw !== 'string' || !raw.trim() || raw.length > 254) throw new HttpError(400, 'invalid', 'Enter your email or username.');
  // "@asha" is how the app shows a username; the rate-limit keys use the same form as the lookup.
  const value = stripHandle(raw).toLowerCase();
  if (!value) throw new HttpError(400, 'invalid', 'Enter your email or username.');
  return value;
}

/**
 * POST /api/auth/password-login {username, password}: the Worker looks the username up and signs in
 * with Firebase for the browser. Unknown usernames take the same path (a Firebase call for an address
 * that can't exist) and get the same answer, so the endpoint can't tell who has an account.
 */
export async function passwordLogin(req: Request, env: Env): Promise<{ user: User; idToken: string }> {
  const config = requireFirebase(env);
  const body = await readJson(req, 4096);
  const identifier = readIdentifier(body);
  const password = body.password;
  if (typeof password !== 'string' || !password || password.length > 4096) throw new HttpError(400, 'invalid', 'Enter your password.');
  await enforceRateLimitRetry(env.DB, `pwlogin-ip:${await clientKey(req)}`, PASSWORD_LOGIN_LIMIT, WINDOW_15_MIN, WAIT);
  await enforceRateLimitRetry(env.DB, `pwlogin-id:${await shortHash(`pwlogin:${identifier}`)}`, PASSWORD_LOGIN_LIMIT, WINDOW_15_MIN, WAIT);

  const email = await resolveIdentifier(env, identifier);
  const origin = new URL(req.url).origin;
  const result = await signInWithPassword(config, email ?? noAccountEmail(), password, origin);
  if (!result.ok) {
    if (result.code === 'NETWORK') throw new HttpError(502, 'firebase_unavailable', 'Sign-in is unavailable right now. Try again, or use Google.');
    if (result.code === 'TOO_MANY_ATTEMPTS_TRY_LATER') throw new HttpError(429, 'rate_limited', WAIT, { retryAfter: WINDOW_15_MIN });
    throw new HttpError(401, 'invalid_credentials', BAD_LOGIN);
  }
  if (!email) throw new HttpError(401, 'invalid_credentials', BAD_LOGIN);
  const identity = await verifyFirebaseIdToken(result.data.idToken, config.projectId);
  const user = await firebaseUser(env, identity, { unverifiedExtra: { idToken: result.data.idToken } });
  return { user, idToken: result.data.idToken };
}

/** POST /api/auth/forgot {identifier}: emails a reset link. Always the same answer, account or not. */
export async function forgotPassword(req: Request, env: Env): Promise<{ ok: true; message: string }> {
  const config = requireFirebase(env);
  const body = await readJson(req, 1024);
  const identifier = readIdentifier(body);
  await enforceRateLimitRetry(env.DB, `forgot-ip:${await clientKey(req)}`, FORGOT_IP_LIMIT, WINDOW_15_MIN, 'Too many reset requests. Wait a few minutes and try again.');
  await enforceRateLimitRetry(env.DB, `forgot-id:${await shortHash(`forgot:${identifier}`)}`, FORGOT_ID_LIMIT, 3600, 'Too many reset requests. Wait a while and try again.');
  const email = await resolveIdentifier(env, identifier);
  const result = await sendPasswordReset(config, email ?? noAccountEmail(), new URL(req.url).origin);
  if (!result.ok && result.code === 'NETWORK') throw new HttpError(502, 'firebase_unavailable', "We couldn't send the email right now. Try again in a minute.");
  return { ok: true, message: FORGOT_MESSAGE };
}

// ---- Account deletion ----

/**
 * Deletes the Firebase user behind the account when the app sends a fresh ID token of one of the
 * account's own Firebase identities. Without one (Google-only accounts, or a token over an hour old)
 * the Firebase user stays; it can't sign in to anything here, since its identity rows are removed.
 */
export async function deleteFirebaseAccount(req: Request, env: Env, user: User, idToken: string | null): Promise<boolean> {
  const config = firebaseConfig(env);
  if (!config || !idToken) return false;
  const identity = await verifyFirebaseIdToken(idToken, config.projectId).catch(() => null);
  if (!identity) return false;
  const owned = await env.DB.prepare("SELECT 1 FROM auth_identities WHERE user_id = ?1 AND provider IN ('password', 'phone') AND provider_uid = ?2")
    .bind(user.id, identity.uid)
    .first();
  if (!owned) return false;
  return (await deleteFirebaseUser(config, idToken, new URL(req.url).origin)).ok;
}

/** Statements that remove an account's sign-in methods and username (part of the deletion batch). */
export const identityDeletion = (env: Env, userId: string) => [
  env.DB.prepare('DELETE FROM auth_identities WHERE user_id = ?1').bind(userId),
  env.DB.prepare('UPDATE users SET username = NULL WHERE id = ?1').bind(userId),
];
