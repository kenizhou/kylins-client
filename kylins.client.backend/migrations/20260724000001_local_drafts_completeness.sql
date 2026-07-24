-- Drafting-flow completeness: persist the full editable draft field set.
--
-- The TS composer has always produced these fields (importance, read/delivery
-- receipts, scheduled delivery, prevent-copy, extra headers, Reply-To
-- recipients) and the TS `DbDraft` interface declared most of them, but the
-- baseline table and the Rust `Draft`/`DraftInput` structs predated them —
-- every save silently dropped the whole set (save → resume lost the flags).

ALTER TABLE local_drafts ADD COLUMN importance TEXT;
ALTER TABLE local_drafts ADD COLUMN request_read_receipt INTEGER NOT NULL DEFAULT 0;
ALTER TABLE local_drafts ADD COLUMN request_delivery_receipt INTEGER NOT NULL DEFAULT 0;
ALTER TABLE local_drafts ADD COLUMN deliver_at INTEGER;
ALTER TABLE local_drafts ADD COLUMN prevent_copy INTEGER NOT NULL DEFAULT 0;
ALTER TABLE local_drafts ADD COLUMN extra_headers TEXT;
ALTER TABLE local_drafts ADD COLUMN reply_to_addresses TEXT;
