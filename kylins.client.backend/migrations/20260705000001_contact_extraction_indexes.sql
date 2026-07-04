-- Contact extraction and autocomplete performance indexes.
-- These support sync-time mail-to-contact extraction, source-badged queries,
-- and fast lookup of messages by sender / account for search suggestions.

CREATE INDEX IF NOT EXISTS idx_contacts_email_source ON contacts(email, source);
CREATE INDEX IF NOT EXISTS idx_messages_from_addr ON messages(from_address);
CREATE INDEX IF NOT EXISTS idx_messages_date_account ON messages(account_id, date);
