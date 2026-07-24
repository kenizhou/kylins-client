-- Drafting-flow completeness (2/2): persist the compose intent and
-- forward-context so a saved draft resumes with its original mode.
--
-- Without these, a forward draft (reply_to_message_id IS NULL) resumed as a
-- brand-new message — losing the "Include original attachments" affordance
-- and forward semantics — and a reply-with-attachments draft lost its
-- variant. `intent` stores the dock intent ('new' | 'reply' | 'replyAll' |
-- 'forward' | 'replyWithAttachments' | 'replyAllWithAttachments'); the OS
-- compose window persists its base mode ('new' | 'reply' | 'replyAll' |
-- 'forward').

ALTER TABLE local_drafts ADD COLUMN intent TEXT;
ALTER TABLE local_drafts ADD COLUMN original_message_id TEXT;
ALTER TABLE local_drafts ADD COLUMN include_original_attachments INTEGER NOT NULL DEFAULT 0;
