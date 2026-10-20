-- A keyed hash of the Google account that took the trial. Deleting an account clears its Google id,
-- so without this the same Google login on a fresh install could start another free week.
ALTER TABLE trials ADD COLUMN account_hash TEXT;
CREATE UNIQUE INDEX trials_account ON trials (account_hash);
