-- Purge the poisoned empty-shell bodies cached by the headers-only sync BEFORE
-- the apply_folder_delta fix.
--
-- Background: apply_folder_delta ran on the headers-only sync path, but
-- mail_parser's body_html(0) synthesizes `<html><body></body></html>` for a
-- message that has no body content (headers-only fetch, or an empty text part
-- such as an Outlook calendar invite). apply_folder_delta then wrote that
-- 26-char shell into message_bodies AND set messages.body_cached = 1 for every
-- synced message. The reading pane rendered the shell as blank, and the
-- viewport prefetch / select-on-demand paths never re-fetched because the
-- message looked cached (body_cached = 1, body_html IS NOT NULL).
--
-- This migration clears those shells and resets body_cached so the real bodies
-- are re-fetched on demand. Exact-string match — DB inspection confirmed all
-- poisoned rows are precisely `<html><body></body></html>` (26 chars); real
-- bodies start at >= 72 chars.

DELETE FROM message_bodies WHERE body_html = '<html><body></body></html>';

UPDATE messages
   SET body_cached = 0
 WHERE body_cached = 1
   AND (account_id, id) NOT IN (
       SELECT account_id, message_id FROM message_bodies
   );
