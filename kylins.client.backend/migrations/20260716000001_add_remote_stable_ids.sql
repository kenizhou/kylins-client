-- P4 OBJECTID stable IDs: provider-agnostic stable message/thread identifiers.
-- `remote_email_id` maps Yahoo's OBJECTID EMAILID (RFC 8474) or Gmail's
-- X-GM-MSGID (X-GM-EXT-1); `remote_thread_id` maps THREADID / X-GM-THRID.
-- Both are NULL for servers that expose neither (generic IMAP). The composite
-- index (account_id, remote_email_id) lets the sync engine deduplicate across
-- UIDVALIDITY resets and cross-folder moves without a full table scan.
ALTER TABLE messages ADD COLUMN remote_email_id TEXT;
ALTER TABLE messages ADD COLUMN remote_thread_id TEXT;
CREATE INDEX IF NOT EXISTS idx_messages_remote_email_id ON messages(account_id, remote_email_id);
