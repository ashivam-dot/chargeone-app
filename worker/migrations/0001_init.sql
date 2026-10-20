CREATE TABLE users (
  id TEXT PRIMARY KEY,
  google_sub TEXT UNIQUE,
  email TEXT NOT NULL,
  name TEXT,
  session_version INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL
);

CREATE TABLE entitlements (
  user_id TEXT PRIMARY KEY REFERENCES users(id),
  plan TEXT NOT NULL,
  active_until TEXT,
  period_start TEXT,
  source TEXT NOT NULL,
  external_id TEXT,
  status TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE checkins (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  station_id TEXT NOT NULL,
  user_id TEXT NOT NULL REFERENCES users(id),
  kind TEXT NOT NULL,
  kw REAL,
  vehicle TEXT,
  note TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX checkins_station_time ON checkins (station_id, created_at);
CREATE INDEX checkins_time ON checkins (created_at);
CREATE INDEX checkins_user_time ON checkins (user_id, created_at);

CREATE TABLE trips (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  counts TEXT NOT NULL,
  distance_km REAL NOT NULL,
  to_lat REAL NOT NULL,
  to_lng REAL NOT NULL,
  replans INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);
CREATE INDEX trips_user_time ON trips (user_id, created_at);

CREATE TABLE checkouts (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  plan TEXT NOT NULL,
  kind TEXT NOT NULL,
  status TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX checkouts_user ON checkouts (user_id);

CREATE TABLE payments (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  plan TEXT NOT NULL,
  checkout_id TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE webhook_events (
  id TEXT PRIMARY KEY,
  received_at TEXT NOT NULL
);

CREATE TABLE rate_limits (
  key TEXT PRIMARY KEY,
  window_start INTEGER NOT NULL,
  count INTEGER NOT NULL
);
