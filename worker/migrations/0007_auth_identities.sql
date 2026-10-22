-- More ways to sign in: email and password, and mobile number with a one-time code (both through
-- Firebase Auth), next to Google. One row per sign-in method of an account. Google stays keyed by
-- users.google_sub as before, and its rows here are for showing the account's methods.
-- provider_uid: the Google sub, or the Firebase uid for password and phone.
-- display: a masked phone number for phone rows ("+91•••••••001"), never the full number.
-- phone_hash: a keyed hash of the full number, so a phone that signs in again under a new Firebase
-- uid (after its Firebase user was deleted) finds the same account.
CREATE TABLE auth_identities (
  provider TEXT NOT NULL CHECK (provider IN ('google', 'password', 'phone')),
  provider_uid TEXT NOT NULL,
  user_id TEXT NOT NULL REFERENCES users(id),
  display TEXT,
  phone_hash TEXT,
  created_at TEXT NOT NULL,
  last_used_at TEXT,
  PRIMARY KEY (provider, provider_uid)
);
CREATE INDEX auth_identities_user ON auth_identities (user_id);
CREATE INDEX auth_identities_phone ON auth_identities (phone_hash);

-- Existing Google accounts (not the local dev or admin test accounts, whose subs have a colon).
INSERT INTO auth_identities (provider, provider_uid, user_id, created_at)
SELECT 'google', google_sub, id, created_at FROM users WHERE google_sub IS NOT NULL AND instr(google_sub, ':') = 0;

-- Optional username for signing in with a password, stored in lower case. users.email stays NOT
-- NULL: accounts that only have a phone number keep an empty string there (no table rebuild, so
-- every existing row and foreign key is untouched), and the API reports it as null.
ALTER TABLE users ADD COLUMN username TEXT;
CREATE UNIQUE INDEX users_username ON users (username);
-- Signing in with a password links to the Google account with the same verified email, and back.
CREATE INDEX users_email_lower ON users (LOWER(email));

-- Every account key that ever took the free Plus week: the Google login, the email address, the
-- Firebase uid and the phone number, each as a keyed hash. Like trials, the rows outlive account
-- deletion and hold no personal data, so signing up again another way can't start another week.
-- (trials.account_hash still holds the first key of each trial, as before.)
CREATE TABLE trial_accounts (
  account_hash TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  started_at TEXT NOT NULL
);
CREATE INDEX trial_accounts_user ON trial_accounts (user_id);
