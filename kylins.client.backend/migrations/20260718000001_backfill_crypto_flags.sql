-- Backfill stale S/MIME crypto flags on messages + threads.
--
-- Messages synced BEFORE the Phase 1b S/MIME detection code landed in the
-- headers-sync upsert (`crypto_kind_from_content_type` → `is_encrypted`/
-- `is_signed` in db/messages.rs) have these flags frozen at 0. Delta sync only
-- fetches UIDs greater than the last cursor, so an already-synced message is
-- never re-fetched and the flags are never re-derived from its Content-Type.
-- The result: opening such a message takes the frontend's PLAIN path
-- (`threadStore.selectThread` gates on `is_encrypted===1 || is_signed===1`),
-- so the opaque `application/pkcs7-mime` body renders as a `smime.p7m`
-- attachment and `openCryptoMessage` is never called.
--
-- The body-fetch path DID cache the raw CMS payload in
-- `message_bodies.body_mime_ciphertext` (opaque `application/pkcs7-mime`,
-- enveloped OR opaque-signed-data) / `body_mime_signed_part` (clear-signed
-- `multipart/signed`). Those columns are the authoritative signal that a
-- message is a crypto message — set regardless of when its headers were
-- synced — so we derive the flags from them here.
--
-- Signal mapping (mirrors `extract_raw_ciphertext` /
-- `extract_clear_signed_parts` in mail/imap/client.rs):
--   - body_mime_signed_part IS NOT NULL → clear-signed → is_signed = 1
--   - body_mime_ciphertext IS NOT NULL AND body_mime_signed_part IS NULL
--     → opaque application/pkcs7-mime → is_encrypted = 1
--
-- Only flips 0 → 1; never downgrades an already-correct flag. The accurate
-- encrypted-vs-signed distinction is parsed from the CMS OID at open time by
-- `open_crypto_message` and written to `message_crypto_results`; these flag
-- columns are only the detection hint that routes the frontend to the crypto
-- path. (Caveat: an opaque signed-data blob is indistinguishable from enveloped
-- in SQL, so it is hinted as `is_encrypted=1`; the orchestrator produces the
-- correct per-message state and the badge reflects that.)

UPDATE messages
   SET is_encrypted = 1
 WHERE is_encrypted = 0
   AND id IN (
       SELECT mb.message_id
         FROM message_bodies AS mb
        WHERE mb.body_mime_ciphertext IS NOT NULL
          AND mb.body_mime_signed_part IS NULL
   );

UPDATE messages
   SET is_signed = 1
 WHERE is_signed = 0
   AND id IN (
       SELECT mb.message_id
         FROM message_bodies AS mb
        WHERE mb.body_mime_signed_part IS NOT NULL
   );

-- Mirror onto threads (one thread per message; thread_id = message_id). The
-- thread flags drive the message-list SecurityChips.
UPDATE threads
   SET is_encrypted = 1
 WHERE is_encrypted = 0
   AND id IN (SELECT m.thread_id FROM messages AS m WHERE m.is_encrypted = 1);

UPDATE threads
   SET is_signed = 1
 WHERE is_signed = 0
   AND id IN (SELECT m.thread_id FROM messages AS m WHERE m.is_signed = 1);
