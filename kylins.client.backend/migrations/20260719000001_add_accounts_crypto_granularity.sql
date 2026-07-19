-- EncryptionGranularity: per-account default encryption scope (§11.4.1).
-- Values: 'whole_message' | 'body_inline_per_attachment' | 'body_inline_merged_attachments'.
-- NULL = application default (WholeMessage). Mirrors auth_type / smtp_username precedent.
ALTER TABLE accounts ADD COLUMN crypto_granularity TEXT;
