-- Separate SMTP login username from IMAP username.
-- Defaults to the existing imap_username so existing accounts keep working.
ALTER TABLE accounts ADD COLUMN smtp_username TEXT;

UPDATE accounts
SET smtp_username = imap_username
WHERE smtp_username IS NULL;
