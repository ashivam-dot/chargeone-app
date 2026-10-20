-- One free Plus week per account and per phone. Rows outlive account deletion so a deleted and
-- re-created account on the same phone can't start another trial. They hold no personal data.
CREATE TABLE trials (
  user_id TEXT PRIMARY KEY,
  device_hash TEXT NOT NULL UNIQUE,
  vehicle_model TEXT NOT NULL,
  started_at TEXT NOT NULL,
  ends_at TEXT NOT NULL
);

CREATE TABLE feedback (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id TEXT,
  device_hash TEXT NOT NULL,
  rating INTEGER NOT NULL,
  category TEXT NOT NULL,
  message TEXT NOT NULL,
  screen TEXT NOT NULL,
  app_version TEXT NOT NULL,
  platform TEXT NOT NULL,
  contact_ok INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);
CREATE INDEX feedback_time ON feedback (created_at);
CREATE INDEX feedback_user ON feedback (user_id);
