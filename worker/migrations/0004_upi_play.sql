-- Direct UPI payments to the business UPI ID, with no payment gateway. The payer's UPI app shows
-- the reference in the note, then the payer enters the UPI transaction id (UTR), and the owner
-- confirms it against the bank statement. Status: created, claimed, confirmed or rejected.
CREATE TABLE upi_payments (
  ref TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  plan TEXT NOT NULL,
  amount_paise INTEGER NOT NULL,
  utr TEXT UNIQUE,
  status TEXT NOT NULL,
  created_at TEXT NOT NULL,
  claimed_at TEXT,
  decided_at TEXT
);
CREATE INDEX upi_payments_user ON upi_payments (user_id, created_at);
CREATE INDEX upi_payments_status ON upi_payments (status, claimed_at);

-- Google Play purchases from the Android app, one row per purchase token. A token belongs to the
-- account that first verified it.
CREATE TABLE play_purchases (
  token TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  product_id TEXT NOT NULL,
  order_id TEXT,
  expires_at TEXT,
  status TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX play_purchases_user ON play_purchases (user_id);
