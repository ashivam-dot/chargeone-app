-- Accounts the owner's admin console creates to try each plan without Google. They are left out of
-- every count on the admin overview.
ALTER TABLE users ADD COLUMN is_test INTEGER NOT NULL DEFAULT 0;

-- Every change made from the admin console: what, to whom, when, and a hash of the network address.
CREATE TABLE admin_audit (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  action TEXT NOT NULL,
  target TEXT,
  detail TEXT,
  ip_hash TEXT NOT NULL,
  at TEXT NOT NULL
);
CREATE INDEX admin_audit_time ON admin_audit (at);

-- The overview counts sign-ups and trips by day across everyone.
CREATE INDEX users_created ON users (created_at);
CREATE INDEX trips_time ON trips (created_at);
