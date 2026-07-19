# Decrypted-Attachments Fix — Design Spec

> Bug: for an S/MIME-encrypted message, after decryption the body renders but **attachments don't show and can't be downloaded**, and **inline `cid:` images don't resolve**. Root cause: the backend `open_crypto_message` correctly extracts the decrypted attachments into `OpenCryptoResult.attachments`, but the frontend discards them and the display/download/inline paths all read `db_get_attachments` (the IMAP-synced OUTER structure = empty for encrypted mail). This is a long-standing gap that `dd9f9ea`'s decrypt-gate fix made visible (decryption now actually triggers, so the empty attachment list is conspicuous).
>
> Date: 2026-07-19. Parent design: `docs/security/crypto-architecture-design.md` §11. Related plans: `2026-07-19-encryption-granularity.md` (granularity feature on this branch).

## Goal

Make encrypted-mail attachments fully functional: **display** the decrypted attachment list, **download** attachment bytes, and **resolve inline `cid:` images** — all from the decrypted inner MIME, not the empty outer envelope.

## Root cause (confirmed)

- Backend `open_crypto_message` (`mail/crypto.rs:872`) decrypts → `parse_plaintext_mime` → `extract_attachments` → `OpenCryptoResult.attachments: Vec<ImapAttachment>` (metadata-only, populated). ✅
- Frontend `threadStore.selectThread` (`threadStore.ts:158-175`) reads `result.plaintextHtml`/`plaintextText`/`cryptoResult` — **never reads `result.attachments`**. Dropped. (`git log -S "result.attachments"` empty — never wired.)
- `AttachmentList` (`AttachmentList.tsx:49`) reads `db_get_attachments` (IMAP-synced outer structure). Sync body-fetch never decrypts (only the send path has `apply_crypto`, `engine.rs:1049`); for encrypted mail the outer is one `application/pkcs7-mime` envelope → `extract_attachments` returns 0 → empty list (envelope filtered by `CRYPTO_ENVELOPE_TYPES` dd9f9ea added).
- Download: `AttachmentList.handleDownload` (`:86-103`) calls `fetchAttachment(accountId, messageId, imapPartId)` → `sync_fetch_attachment` → fetches from IMAP by `part_id`. For encrypted mail there's no IMAP part (bytes are inside the CMS blob) → can't download.
- Inline images: `ReadingPane.tsx:194` calls `fetchInlineImages` → `sync_fetch_inline_images` → `list_inline_cid_parts` reads the `attachments` table (empty for encrypted mail) → `cidMap` empty → broken-image icons.

## Architecture

A shared backend helper `decrypt_message_mime_bytes(pool, account_id, message_id) -> Result<Option<Vec<u8>>, String>` returns the decrypted plaintext MIME bytes (factored out of `open_crypto_message`, which is refactored to call it — preserving current behavior). Two new backend commands reuse it + the existing `attachment_cache` writers + `copy_cached_attachment`:
- `crypto_fetch_attachment(accountId, messageId, filename, contentId) -> CachedAttachment` — re-decrypt, parse, find the part by `(filename, content_id)`, write cache file, return path.
- `crypto_fetch_inline_images(accountId, messageId) -> Vec<CachedInlineImage>` — re-decrypt, parse, extract inline `cid:` parts, write cache files, return.

Frontend: extend `viewStore.decryptedCache` to carry `attachments: ImapAttachment[]` + an `isCrypto` flag; `threadStore.selectThread` stashes `result.attachments`; `AttachmentList` prefers the cached decrypted attachments (when crypto) + uses `fetchCryptoAttachment` for download; `ReadingPane` branches to `fetchCryptoInlineImages` for crypto messages.

## Design decisions

1. **Part identification for download:** by `(filename, content_id)` tuple (both in `ImapAttachment`). NOT by `part_id` — the IMAP section id is synthetic for the decrypted inner MIME (not reversible to a `mail_parser` part index without re-walking). Filename match (+ cid for inline disambiguation) is robust. Mirror `fetch_inline_cid_parts` (`mail/imap/client.rs:2317-2359`) which already walks `message.parts` matching by `content_id`/`attachment_name()`.
2. **Cache persistence:** no new `attachments`-table rows; the new commands write cache files via `attachment_cache::cache_file_path` + `write_cache_file` (idempotent overwrite on re-download). Ciphertext is local (`message_bodies.body_mime_ciphertext`) — re-decrypt is cheap, no IMAP. No migration. Cache id: `{account_id}_{message_id}_crypto_{sanitize(filename)}` (avoids collision with plain-mail `{account_id}_{message_id}_{part_id}`).
3. **Refactor `open_crypto_message`:** extract `decrypt_message_mime_bytes` (handles enveloped + signed-data recursion + clear-signed + opaque-signed — the `:878-1148` logic, returning `plaintext_mime: Option<Vec<u8>>` instead of calling `finish_open_crypto`). `open_crypto_message` calls the helper then `finish_open_crypto(..., plaintext_mime, ...)` — behavior-preserving. Existing tests (incl. the Granularity-B round-trip `crypto.rs:3912`) gate the refactor.
4. **Scope:** all crypto messages where attachments are inside the crypto blob (encrypted/enveloped + opaque-signed). Clear-signed messages already work (attachments are siblings in the outer `multipart/mixed`, visible via `db_get_attachments`); the helper returns their plaintext too, but the display path falls back to `db_get_attachments` for non-crypto (no regression).
5. **Bytes extraction:** reuse the canonical `match &part.body` arms (`mail/imap/client.rs:2283-2298`: `Binary`/`InlineBinary`/`Text`/`Html`/`Message` → bytes; `Multipart` → skip).

## Components / data flow

### Backend (`kylins.client.backend/`)

1. **`mail/crypto.rs`** — extract `pub(crate) async fn decrypt_message_mime_bytes(pool, account_id, message_id) -> Result<Option<Vec<u8>>, String>` from `open_crypto_message` (`:878-1148`); refactor `open_crypto_message` to call it then `finish_open_crypto`. Reuses `get_message_ciphertext` + `get_message_signed_part` (`db/message_bodies.rs:195-260`) + `smime_backend` + `EncryptedEnvelope` + key loop + `is_signed_data` recursion into `run_verify_path`.
2. **`sync_engine/commands.rs`** — new commands `crypto_fetch_attachment` + `crypto_fetch_inline_images` (mirror `sync_fetch_attachment_inner` `:413-493` / `sync_fetch_inline_images_inner` `:530-641` but: `decrypt_message_mime_bytes` instead of IMAP fetch; extract part(s) from the decrypted `mail_parser::Message` by filename/cid; `attachment_cache::cache_file_path` + `write_cache_file`; return `CachedAttachment` / `Vec<CachedInlineImage>`).
3. **`lib.rs:262-272`** — register the 2 new commands in `invoke_handler![]`.
4. **Pure helper** — extract `extract_inline_cid_parts_from_message(&mail_parser::Message) -> Vec<InlineCidPart>` from `fetch_inline_cid_parts` (`mail/imap/client.rs:2317-2359`) so both the IMAP path and the crypto path share the bytes-extraction logic. (Optional but DRY; if it complicates the IMAP path, duplicate in the crypto command instead.)

### Frontend (`kylins.client.frontend/`)

5. **`features/view/viewStore.ts`** — `DecryptedCacheEntry` gains `attachments: ImapAttachment[]` + `isCrypto: boolean`; `setDecrypted(id, html, text, attachments, isCrypto)`.
6. **`stores/threadStore.ts:158-175`** — `setDecrypted(latest.id, result.plaintextHtml, result.plaintextText, result.attachments, true)`; also set `mail.attachments = result.attachments` so `selectedMessage` carries them. Cache-hit branch (`:139-155`) re-hydrates `mail.attachments` from the cache.
7. **`components/email/AttachmentList.tsx`** — accept an optional `decryptedAttachments?: ImapAttachment[]` prop + `isCrypto?: boolean`. When `isCrypto && decryptedAttachments`, render those (mapped to `AttachmentRow`-shaped items) instead of `getAttachments`. `handleDownload`: for crypto, call `fetchCryptoAttachment(accountId, messageId, filename, contentId)` (returns `CachedAttachment`) then the same `copy_cached_attachment` → dest. Else existing `fetchAttachment` path.
8. **`components/layout/ReadingPane.tsx`** — pass `decryptedAttachments={cache?.attachments}` + `isCrypto={cache?.isCrypto ?? !!message.isEncrypted}` to `<AttachmentList>` (`:427-431`). Inline-image effect (`:165-217`): for crypto messages call `fetchCryptoInlineImages(acct, id)` instead of `fetchInlineImages(acct, id)`; the Blob/objectURL loop runs unchanged.
9. **`services/db/attachments.ts`** — new `fetchCryptoAttachment(accountId, messageId, filename, contentId)` + `fetchCryptoInlineImages(accountId, messageId)` wrappers (mirror `fetchAttachment`/`fetchInlineImages`).

## Testing

### Backend
- `decrypt_message_mime_bytes`: test that it returns the plaintext MIME bytes for an encrypted message (seed ciphertext + key, assert bytes non-empty + parseable). The existing `granularity_b_merged_multipart_round_trips_through_smime_encrypt_decrypt` (`crypto.rs:3912`) gates the `open_crypto_message` refactor (must still pass).
- `crypto_fetch_attachment`: round-trip — encrypt a 3-attachment message, persist ciphertext, call `crypto_fetch_attachment(account, msg, "a1.bin", None)`, assert the returned `CachedAttachment` file_path exists + contains the right bytes.
- `crypto_fetch_inline_images`: round-trip — encrypt a message with an inline `cid:` image, call `crypto_fetch_inline_images`, assert 1 `CachedInlineImage` with the right cid + bytes.

### Frontend
- `AttachmentList` test: render with `decryptedAttachments` + `isCrypto=true`; assert the N chips render; click download → assert `fetchCryptoAttachment` called with `(accountId, messageId, filename, contentId)` + `copy_cached_attachment` called. Mirror `KeyManager.test.tsx`'s real-store pattern.
- `ReadingPane` inline-image branch: for a crypto message, assert `fetchCryptoInlineImages` called (not `fetchInlineImages`). (If ReadingPane is hard to test in isolation, cover via the viewStore + a focused AttachmentList test.)
- `npx tsc --noEmit` clean.

## Out of scope

- **Persisting crypto attachments to the `attachments` table** (cache-hit reuse across sessions). Re-decrypt is cheap (local ciphertext); cache files are idempotent overwrites. A persistence layer can be added later if re-decrypt cost matters.
- **Granularity-B-specific handling.** The fix is granularity-agnostic — `extract_attachments` walks any decrypted MIME tree (merged or sibling). No granularity-path change.
- **EWS/EAS crypto attachments.** Only IMAP-backed S/MIME is in scope (the existing crypto path). EAS/EWS crypto receive isn't built yet.
- **`send_op` / `build_mime` / `apply_crypto` changes.** Send path untouched.

## Self-review

- **Spec coverage:** display (decryptedCache + threadStore + AttachmentList) ✓; download (`crypto_fetch_attachment` + fetchCryptoAttachment + AttachmentList.handleDownload branch) ✓; inline images (`crypto_fetch_inline_images` + ReadingPane branch) ✓; backend helper refactor (`decrypt_message_mime_bytes`) ✓; tests (backend round-trips + frontend component) ✓.
- **No placeholders:** all file:line anchors from the explore map (`crypto.rs:872-1148/1205-1260`, `client.rs:2283-2300/2317-2359/3394-3433`, `attachment_cache.rs:59-124`, `commands.rs:413-493/530-641`, `commands.rs:305-318`, `db/attachments.rs:19-253`, `db/message_bodies.rs:195-260`, `lib.rs:262-272`, `attachments.ts:19-78`, `AttachmentList.tsx:49/86-103`, `ReadingPane.tsx:165-217/427-431`, `viewStore.ts:94/158-162`, `threadStore.ts:139-175`).
- **Consistency:** reuses `copy_cached_attachment`, `attachment_cache` writers, `mail_parser` part-bytes pattern, `ImapAttachment`/`CachedAttachment`/`CachedInlineImage` types. No new migration. Behavior-preserving refactor gated by existing tests.
- **Scope:** focused on the decrypted-attachment blind spot; no send-path / granularity / EAS changes.
