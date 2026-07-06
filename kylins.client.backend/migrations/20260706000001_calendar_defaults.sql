-- Seed a primary local calendar for every account that has none, and backfill
-- orphan calendar_events rows so they belong to the account's primary calendar.
-- Idempotent: re-running leaves existing calendars untouched and the backfill
-- is a no-op once calendar_id is populated.

INSERT INTO calendars (id, account_id, provider, remote_id, display_name, color, is_primary, is_visible, sync_token, ctag, created_at, updated_at)
SELECT
  lower(hex(randomblob(16))),
  a.id,
  'local',
  'local_default',
  'Calendar',
  '#3b82f6',
  1,
  1,
  NULL,
  NULL,
  unixepoch(),
  unixepoch()
FROM accounts a
WHERE NOT EXISTS (
  SELECT 1 FROM calendars c WHERE c.account_id = a.id
);

UPDATE calendar_events
SET calendar_id = (
  SELECT c.id FROM calendars c
  WHERE c.account_id = calendar_events.account_id AND c.is_primary = 1
  LIMIT 1
)
WHERE calendar_id IS NULL;
