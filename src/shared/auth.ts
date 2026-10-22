// Sign-in rules and shapes shared by the app and the Worker: usernames, passwords, Indian mobile
// numbers, masking for display, and the Firebase Identity Toolkit error codes in plain English.

/** The ways a ChargeOne account can sign in. */
export type AuthProvider = 'google' | 'password' | 'phone';

/** Public Firebase web config from /api/config (null there when Firebase isn't set up). */
export interface FirebasePublicConfig {
  apiKey: string;
  authDomain: string;
  projectId: string;
  appId: string;
}

/** The signed-in user in /api/me and every sign-in response. */
export interface MeUser {
  /** Null for accounts that only sign in with a phone number. */
  email: string | null;
  name: string | null;
  username: string | null;
  /** Masked, e.g. "+91•••••••001". Never the full number. */
  phone: string | null;
  methods: AuthProvider[];
}

// ---- Usernames ----

export const USERNAME_MIN = 3;
export const USERNAME_MAX = 20;
const USERNAME_CHARS = /^[a-z0-9_.]+$/;

/** Words nobody can take, so no one can pose as the app or its staff. */
export const RESERVED_USERNAMES = new Set([
  'admin', 'administrator', 'root', 'system', 'support', 'help', 'helpdesk', 'contact', 'info', 'mail', 'email',
  'chargeone', 'charge.one', 'charge_one', 'official', 'staff', 'team', 'moderator', 'mod', 'owner', 'security',
  'billing', 'payments', 'account', 'accounts', 'settings', 'api', 'www', 'web', 'app', 'login', 'logout', 'signin',
  'signup', 'register', 'me', 'you', 'user', 'users', 'guest', 'test', 'null', 'undefined', 'deleted', 'anonymous',
  'about', 'privacy', 'terms', 'legal', 'abuse', 'noreply', 'no_reply', 'no.reply', 'webmaster', 'hostmaster',
]);

export type UsernameProblem = 'too_short' | 'too_long' | 'bad_chars' | 'bad_dots' | 'reserved';

/** Usernames are case-insensitive: stored and compared in lower case, without spaces around. */
export const normalizeUsername = (input: string): string => input.trim().toLowerCase();

/** Null when the (normalised) username is allowed, else why not. */
export function usernameProblem(username: string): UsernameProblem | null {
  if (username.length < USERNAME_MIN) return 'too_short';
  if (username.length > USERNAME_MAX) return 'too_long';
  if (!USERNAME_CHARS.test(username)) return 'bad_chars';
  if (username.startsWith('.') || username.endsWith('.') || username.includes('..')) return 'bad_dots';
  if (RESERVED_USERNAMES.has(username) || /^chargeone/.test(username)) return 'reserved';
  return null;
}

export const USERNAME_PROBLEM_TEXT: Record<UsernameProblem | 'taken', string> = {
  too_short: `Use at least ${USERNAME_MIN} characters.`,
  too_long: `Use at most ${USERNAME_MAX} characters.`,
  bad_chars: 'Use only letters, numbers, dots and underscores.',
  bad_dots: "A username can't start or end with a dot, or have two dots in a row.",
  reserved: 'That username is reserved. Try another.',
  taken: 'That username is taken. Try another.',
};

// ---- Passwords ----

export const PASSWORD_MIN = 8;
export const PASSWORD_MAX = 128;
const COMMON_PASSWORDS = new Set(['password', 'password1', 'password123', '12345678', '123456789', '1234567890', 'qwerty123', 'iloveyou', 'chargeone', 'chargeone1', 'abcd1234', '11111111', '00000000']);

export type PasswordProblem = 'too_short' | 'too_long' | 'no_letter' | 'no_digit' | 'common' | 'matches_identity';

/** Everything wrong with a new password, in the order the form shows it. Empty = strong enough. */
export function passwordProblems(password: string, identity: { email?: string; username?: string } = {}): PasswordProblem[] {
  const out: PasswordProblem[] = [];
  if (password.length < PASSWORD_MIN) out.push('too_short');
  if (password.length > PASSWORD_MAX) out.push('too_long');
  if (!/\p{L}/u.test(password)) out.push('no_letter');
  if (!/\d/.test(password)) out.push('no_digit');
  const lower = password.toLowerCase();
  if (COMMON_PASSWORDS.has(lower)) out.push('common');
  const local = identity.email?.split('@')[0]?.toLowerCase();
  if ((local && local.length >= 3 && lower.includes(local)) || (identity.username && identity.username.length >= 3 && lower.includes(identity.username.toLowerCase()))) {
    out.push('matches_identity');
  }
  return out;
}

export const PASSWORD_PROBLEM_TEXT: Record<PasswordProblem, string> = {
  too_short: `At least ${PASSWORD_MIN} characters`,
  too_long: `At most ${PASSWORD_MAX} characters`,
  no_letter: 'At least one letter',
  no_digit: 'At least one number',
  common: 'Not a common password',
  matches_identity: "Doesn't contain your email or username",
};

// ---- Email ----

/** A practical check, not RFC 5322: one @, a dot in the domain, no spaces. */
export const EMAIL_PATTERN = /^[^\s@]{1,64}@[^\s@]+\.[^\s@]{2,}$/;
export const isEmail = (value: string) => value.length <= 254 && EMAIL_PATTERN.test(value);

/**
 * What was typed in "Email or username", with one leading "@" dropped when the rest is a username:
 * the app shows usernames as "@asha", so people type them that way. Emails are left alone.
 */
export function stripHandle(input: string): string {
  const value = input.trim();
  return value.startsWith('@') && !value.slice(1).includes('@') ? value.slice(1).trim() : value;
}

/** Mail providers whose addresses ignore dots in the local part. */
const DOTLESS_DOMAINS = new Set(['gmail.com', 'googlemail.com']);

/**
 * One form per mailbox, for keys like "this person already had the free trial": lower case, no
 * "+tag" (most providers deliver a+1@x to a@x), no dots for Gmail, googlemail.com read as gmail.com.
 * Only for matching; the account keeps the address as typed.
 */
export function canonicalEmail(email: string): string {
  const lower = email.trim().toLowerCase();
  const at = lower.lastIndexOf('@');
  if (at < 1) return lower;
  let local = lower.slice(0, at).split('+')[0];
  let domain = lower.slice(at + 1);
  if (DOTLESS_DOMAINS.has(domain)) {
    local = local.replaceAll('.', '');
    domain = 'gmail.com';
  }
  return `${local || lower.slice(0, at)}@${domain}`;
}

/** Throwaway-inbox services: fine for signing in, but they don't get the free Plus week. */
export const DISPOSABLE_EMAIL_DOMAINS = new Set([
  'mailinator.com', 'guerrillamail.com', 'guerrillamail.net', 'guerrillamail.org', 'sharklasers.com', 'grr.la',
  '10minutemail.com', '10minutemail.net', 'temp-mail.org', 'tempmail.com', 'tempmail.net', 'tempmailo.com',
  'yopmail.com', 'yopmail.net', 'trashmail.com', 'getnada.com', 'nada.email', 'dispostable.com', 'maildrop.cc',
  'mailnesia.com', 'throwawaymail.com', 'fakeinbox.com', 'mohmal.com', 'emailondeck.com', 'mintemail.com',
  'spamgourmet.com', 'mailcatch.com', 'moakt.com', 'tmail.ws', 'tmpmail.org', 'tmpmail.net', 'burnermail.io',
  'inboxkitten.com', '1secmail.com', '1secmail.net', '1secmail.org', 'mail.tm', 'mail.gw', 'emailfake.com',
]);

export const isDisposableEmail = (email: string) => DISPOSABLE_EMAIL_DOMAINS.has(email.trim().toLowerCase().split('@').pop() ?? '');

/** "akash@gmail.com" -> "a•••@gmail.com". */
export function maskEmail(email: string): string {
  const at = email.lastIndexOf('@');
  if (at < 1) return '•••';
  return `${email[0]}•••${email.slice(at)}`;
}

// ---- Phone numbers ----

export const DEFAULT_COUNTRY_CODE = '+91';
const E164 = /^\+[1-9]\d{7,14}$/;
const INDIAN_MOBILE = /^[6-9]\d{9}$/;

/**
 * The number in E.164, or null when it isn't a valid mobile. Ten digits (or 0/91 plus ten) are an
 * Indian mobile and must start with 6 to 9; anything starting with + is taken as international.
 */
export function normalizePhone(input: string): string | null {
  const raw = input.trim().replace(/[\s\-().]/g, '');
  if (raw.startsWith('+')) {
    if (!E164.test(raw)) return null;
    if (raw.startsWith('+91') && !INDIAN_MOBILE.test(raw.slice(3))) return null;
    return raw;
  }
  if (!/^\d+$/.test(raw)) return null;
  const digits = raw.length === 11 && raw.startsWith('0') ? raw.slice(1) : raw.length === 12 && raw.startsWith('91') ? raw.slice(2) : raw;
  return INDIAN_MOBILE.test(digits) ? `+91${digits}` : null;
}

/** "+919999900001" -> "+91•••••••001": the country code and last three digits only. */
export function maskPhone(e164: string): string {
  const digits = e164.replace(/\D/g, '');
  const cc = e164.startsWith('+91') ? '91' : digits.slice(0, Math.max(1, digits.length - 10));
  const rest = digits.slice(cc.length);
  return `+${cc}${'•'.repeat(Math.max(0, rest.length - 3))}${rest.slice(-3)}`;
}

// ---- Identity Toolkit (Firebase Auth REST) errors ----

/** Error codes the Identity Toolkit REST API and the phone sign-in SDK answer with, as the app sees them. */
export type AuthErrorCode =
  | 'EMAIL_EXISTS'
  | 'EMAIL_NOT_FOUND'
  | 'INVALID_PASSWORD'
  | 'INVALID_LOGIN_CREDENTIALS'
  | 'INVALID_EMAIL'
  | 'MISSING_PASSWORD'
  | 'WEAK_PASSWORD'
  | 'USER_DISABLED'
  | 'USER_NOT_FOUND'
  | 'TOO_MANY_ATTEMPTS_TRY_LATER'
  | 'OPERATION_NOT_ALLOWED'
  | 'INVALID_ID_TOKEN'
  | 'TOKEN_EXPIRED'
  | 'CREDENTIAL_TOO_OLD_LOGIN_AGAIN'
  | 'EXPIRED_OOB_CODE'
  | 'INVALID_OOB_CODE'
  | 'QUOTA_EXCEEDED'
  | 'INVALID_PHONE_NUMBER'
  | 'INVALID_CODE'
  | 'CODE_EXPIRED'
  | 'CAPTCHA_FAILED'
  | 'NETWORK'
  | 'UNKNOWN';

const KNOWN_CODES = new Set<AuthErrorCode>([
  'EMAIL_EXISTS', 'EMAIL_NOT_FOUND', 'INVALID_PASSWORD', 'INVALID_LOGIN_CREDENTIALS', 'INVALID_EMAIL', 'MISSING_PASSWORD',
  'WEAK_PASSWORD', 'USER_DISABLED', 'USER_NOT_FOUND', 'TOO_MANY_ATTEMPTS_TRY_LATER', 'OPERATION_NOT_ALLOWED', 'INVALID_ID_TOKEN',
  'TOKEN_EXPIRED', 'CREDENTIAL_TOO_OLD_LOGIN_AGAIN', 'EXPIRED_OOB_CODE', 'INVALID_OOB_CODE', 'QUOTA_EXCEEDED',
  'INVALID_PHONE_NUMBER', 'INVALID_CODE', 'CODE_EXPIRED', 'CAPTCHA_FAILED', 'NETWORK', 'UNKNOWN',
]);

/** Firebase JS SDK codes (phone sign-in) mapped onto the REST codes above. */
const SDK_CODES: Record<string, AuthErrorCode> = {
  'auth/invalid-verification-code': 'INVALID_CODE',
  'auth/missing-verification-code': 'INVALID_CODE',
  'auth/code-expired': 'CODE_EXPIRED',
  'auth/invalid-phone-number': 'INVALID_PHONE_NUMBER',
  'auth/missing-phone-number': 'INVALID_PHONE_NUMBER',
  'auth/too-many-requests': 'TOO_MANY_ATTEMPTS_TRY_LATER',
  'auth/quota-exceeded': 'QUOTA_EXCEEDED',
  'auth/captcha-check-failed': 'CAPTCHA_FAILED',
  'auth/invalid-app-credential': 'CAPTCHA_FAILED',
  'auth/network-request-failed': 'NETWORK',
  'auth/user-disabled': 'USER_DISABLED',
  'auth/operation-not-allowed': 'OPERATION_NOT_ALLOWED',
  'auth/invalid-credential': 'INVALID_LOGIN_CREDENTIALS',
  'auth/wrong-password': 'INVALID_LOGIN_CREDENTIALS',
  'auth/user-not-found': 'INVALID_LOGIN_CREDENTIALS',
  'auth/email-already-in-use': 'EMAIL_EXISTS',
  'auth/weak-password': 'WEAK_PASSWORD',
  'auth/invalid-email': 'INVALID_EMAIL',
};

/**
 * The code from an Identity Toolkit error message ("WEAK_PASSWORD : Password should be at least 6
 * characters", "TOO_MANY_ATTEMPTS_TRY_LATER : ...") or a Firebase SDK code ("auth/code-expired").
 */
export function authErrorCode(message: unknown): AuthErrorCode {
  if (typeof message !== 'string' || !message) return 'UNKNOWN';
  if (message.startsWith('auth/')) return SDK_CODES[message] ?? 'UNKNOWN';
  const code = message.split(/[\s:]/)[0].toUpperCase();
  if (code === 'RESET_PASSWORD_EXCEED_LIMIT') return 'TOO_MANY_ATTEMPTS_TRY_LATER';
  if (code === 'INVALID_SESSION_INFO' || code === 'SESSION_EXPIRED') return 'CODE_EXPIRED';
  if (code === 'INVALID_CODE' || code === 'INVALID_VERIFICATION_CODE') return 'INVALID_CODE';
  return KNOWN_CODES.has(code as AuthErrorCode) ? (code as AuthErrorCode) : 'UNKNOWN';
}

/** Friendly English for each code. Sign-in failures never say whether the account exists. */
export const AUTH_ERROR_TEXT: Record<AuthErrorCode, string> = {
  EMAIL_EXISTS: 'An account with this email already exists. Sign in instead, or reset your password.',
  EMAIL_NOT_FOUND: "That email or password isn't right.",
  INVALID_PASSWORD: "That email or password isn't right.",
  INVALID_LOGIN_CREDENTIALS: "That email or password isn't right.",
  INVALID_EMAIL: 'Enter a valid email address.',
  MISSING_PASSWORD: 'Enter your password.',
  WEAK_PASSWORD: 'Choose a stronger password: at least 8 characters with a letter and a number.',
  USER_DISABLED: 'This account has been switched off. Contact support if you think this is a mistake.',
  USER_NOT_FOUND: 'This account no longer exists. Create a new one.',
  TOO_MANY_ATTEMPTS_TRY_LATER: 'Too many attempts. Wait a few minutes, or sign in with Google instead.',
  OPERATION_NOT_ALLOWED: "This sign-in option isn't switched on yet. Use Google or another option.",
  INVALID_ID_TOKEN: 'Your sign-in expired. Please sign in again.',
  TOKEN_EXPIRED: 'Your sign-in expired. Please sign in again.',
  CREDENTIAL_TOO_OLD_LOGIN_AGAIN: 'For your security, sign in again first.',
  EXPIRED_OOB_CODE: 'That link has expired. Ask for a new one.',
  INVALID_OOB_CODE: 'That link is no longer valid. Ask for a new one.',
  QUOTA_EXCEEDED: "We can't send more text messages today. Sign in with email or Google instead.",
  INVALID_PHONE_NUMBER: 'Enter a valid mobile number, like 98765 43210.',
  INVALID_CODE: "That code isn't right. Check the text message and try again.",
  CODE_EXPIRED: 'That code has expired. Send a new one.',
  CAPTCHA_FAILED: "We couldn't check this browser. Reload the page and try again.",
  NETWORK: "You're offline or the connection dropped. Check it and try again.",
  UNKNOWN: 'Something went wrong. Please try again.',
};

export const authErrorText = (message: unknown) => AUTH_ERROR_TEXT[authErrorCode(message)];
