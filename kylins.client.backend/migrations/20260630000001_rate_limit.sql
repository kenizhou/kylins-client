-- Phase 3f: per-account rate-limit state. The engine consults this before
-- scheduling a sync round; a row whose retry_after > now causes the round to
-- be skipped and sync:status { state: "rate_limited", detail: retry_after }
-- to be emitted. Rows are lazy-deleted on read once the window passes
-- (db::rate_limit::get_rate_limit), so no background sweeper is needed.
--
-- ON DELETE CASCADE: dropping an account cleans its rate-limit row.
CREATE TABLE IF NOT EXISTS provider_rate_limit (
  account_id TEXT PRIMARY KEY REFERENCES accounts(id) ON DELETE CASCADE,
  retry_after INTEGER NOT NULL,
  updated_at INTEGER DEFAULT (unixepoch())
);
