# Decrypted-Attachments Fix Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make encrypted-mail attachments fully functional — display the decrypted attachment list, download attachment bytes, and resolve inline `cid:` images — all from the decrypted inner MIME.

**Architecture:** Factor a `decrypt_message_mime_bytes` helper out of `open_crypto_message` (behavior-preserving). Two new backend commands reuse it + `attachment_cache` writers + `copy_cached_attachment`: `crypto_fetch_attachment` (extract one part by filename/cid) + `crypto_fetch_inline_images` (extract inline cid parts). Frontend extends `decryptedCache` to carry `attachments` + `isCrypto`; `threadStore` stashes `result.attachments`; `AttachmentList` renders + downloads via crypto path when `isCrypto`; `ReadingPane` branches inline-image fetch.

**Tech Stack:** Rust (Tauri v2, `mail_parser`, `sqlx`), React 19 + TypeScript + Zustand + Vitest/Testing Library.

## Global Constraints

- **Branch:** `feat/encryption-granularity` (continues the crypto work). Per-task commits, no push.
- **Behavior-preserving refactor:** `open_crypto_message` must produce byte-identical `OpenCryptoResult` after the `decrypt_message_mime_bytes` extraction. The existing `granularity_b_merged_multipart_round_trips_through_smime_encrypt_decrypt` test (`mail/crypto.rs:3912`) + the `mail::crypto` test suite gate the refactor — they MUST stay green.
- **No new migration.** The `attachments` table is unchanged; the new commands write cache files (idempotent overwrite) and do NOT persist `attachments` rows. Ciphertext is local (`message_bodies.body_mime_ciphertext`) — re-decrypt is cheap.
- **Part identification:** by `(filename, content_id)` tuple — NOT `part_id` (the IMAP section id is synthetic for the decrypted inner MIME, not reversible to a `mail_parser` part index). Mirror `fetch_inline_cid_parts` (`mail/imap/client.rs:2317-2359`) which walks `message.parts` by `content_id`/`attachment_name()`.
- **Cache id:** `{account_id}_{message_id}_crypto_{sanitize(filename)}` (avoids collision with plain-mail `{account_id}_{message_id}_{part_id}`).
- **Reuse, don't reinvent:** `copy_cached_attachment` (`commands.rs:305-318`), `attachment_cache::{cache_file_path, write_cache_file, path_is_within_cache}` (`attachment_cache.rs:59-124`), the `match &part.body` bytes arms (`client.rs:2283-2298`), `ImapAttachment`/`CachedAttachment`/`CachedInlineImage` types.
- **Git guardrail (STRICT — a prior implementer's cleanup destroyed an untracked file):** stage ONLY the specific files you changed. NEVER `git add -A`/`git add .`/`git stash -u`/`git clean -fd`. If `cargo fmt --all`/prettier reformats unrelated files, leave them unstaged. Do NOT push.
- **Test runners:** backend `cargo test -p kylins-client-backend` from `kylins.client.backend/`; frontend `npx vitest run <path>` + `npx tsc --noEmit` from `kylins.client.frontend/`.
- **Existing patterns to mirror (do NOT guess — read first):**
  - Decrypt arm: `open_crypto_message` `mail/crypto.rs:872-1148`; `finish_open_crypto` + `parse_plaintext_mime` `:1205-1260`.
  - Part-bytes extraction: `decode_part_bytes` + `fetch_inline_cid_parts` `mail/imap/client.rs:2283-2300, 2317-2359`.
  - Command mirror: `sync_fetch_attachment_inner` `sync_engine/commands.rs:413-493`; `sync_fetch_inline_images_inner` `:530-641`.
  - Frontend download: `AttachmentList.tsx:86-103`; inline fetch: `ReadingPane.tsx:165-217`; store cache: `viewStore.ts:94, 158-162`; threadStore crypto branch: `threadStore.ts:139-188`.

## File Structure

| File | Action | Responsibility |
|---|---|---|
| `kylins.client.backend/src/mail/crypto.rs` | Modify | Extract `decrypt_message_mime_bytes` helper; refactor `open_crypto_message` to call it. + test. |
| `kylins.client.backend/src/sync_engine/commands.rs` | Modify | Add `crypto_fetch_attachment` + `crypto_fetch_inline_images` commands. + tests. |
| `kylins.client.backend/src/lib.rs` | Modify | Register the 2 new commands in `invoke_handler![]`. |
| `kylins.client.frontend/src/features/view/viewStore.ts` | Modify | `DecryptedCacheEntry` gains `attachments` + `isCrypto`; `setDecrypted` signature. |
| `kylins.client.frontend/src/stores/threadStore.ts` | Modify | Stash `result.attachments` into cache + `mail.attachments`. |
| `kylins.client.frontend/src/components/email/AttachmentList.tsx` | Modify | `decryptedAttachments` + `isCrypto` props; crypto render + download branch. |
| `kylins.client.frontend/src/components/layout/ReadingPane.tsx` | Modify | Pass props to `<AttachmentList>`; branch inline-image fetch for crypto. |
| `kylins.client.frontend/src/services/db/attachments.ts` | Modify | `fetchCryptoAttachment` + `fetchCryptoInlineImages` wrappers. |
| `kylins.client.frontend/tests/components/email/AttachmentList.test.tsx` | Create/Modify | Crypto render + download test. |

---

## Task 1: Backend `decrypt_message_mime_bytes` helper (behavior-preserving refactor)

**Files:**
- Modify: `kylins.client.backend/src/mail/crypto.rs` (`open_crypto_message` `:872-1148`, `finish_open_crypto` `:1205-1260`).
- Test: extend `#[cfg(test)] mod tests` in `crypto.rs`.

**Interfaces:**
- Produces: `pub(crate) async fn decrypt_message_mime_bytes(pool: &SqlitePool, account_id: &str, message_id: &str) -> Result<Option<Vec<u8>>, String>` — returns the decrypted plaintext MIME bytes (handles enveloped + signed-data recursion + clear-signed + opaque-signed, i.e. the `:878-1148` logic). Consumed by Task 2's commands.

- [ ] **Step 1: Read the decrypt arm + finish_open_crypto.** Read `mail/crypto.rs:872-1260` to understand the exact structure: `get_message_ciphertext` + `get_message_signed_part` → dispatch (enveloped `:1008-1148`, clear-signed `:921-952`, opaque signed `:1149-1170`) → `plaintext_mime: Option<Vec<u8>>` → `finish_open_crypto(..., plaintext_mime, ...)`. Note every branch that sets `plaintext_mime` and the `(crypto_kind, decrypt_state, signature_state, signer_*, failure_reason, revocation_reason)` tuple each branch produces.

- [ ] **Step 2: Write the failing test.** In `crypto.rs` tests, add a test that calls `decrypt_message_mime_bytes` on an encrypted message (reuse the round-trip fixture from `granularity_b_merged_multipart_round_trips_through_smime_encrypt_decrypt` `:3912` — seed ciphertext + key) and asserts it returns `Some(bytes)` where `bytes` parses as MIME (contains `Content-Type`/`multipart`). RED: function not defined.

- [ ] **Step 3: Implement — extract the helper.** Extract `decrypt_message_mime_bytes(pool, account_id, message_id) -> Result<Option<Vec<u8>>, String>` containing the `:878-1148` decrypt logic (ciphertext/signed_part fetch + smime_backend + EncryptedEnvelope + key loop + `is_signed_data` recursion into `run_verify_path` + clear-signed/opaque arms), returning `plaintext_mime`. Refactor `open_crypto_message` to: call `decrypt_message_mime_bytes` → obtain `plaintext_mime` + the `(crypto_kind, decrypt_state, signature_state, signer_*, failure_reason, revocation_reason)` tuple → `finish_open_crypto(...)`. **Preserve the exact tuple each branch produces** — the `OpenCryptoResult.cryptoResult` fields must not change. If the tuple computation is intertwined with the decrypt (e.g. `run_verify_path` returns both `plaintext` and signature state), keep that together — the helper may return `(Option<Vec<u8>>, CryptoOutcome)` or you keep the helper returning bytes + a parallel outcome computation in `open_crypto_message`. Read carefully and choose the split that preserves behavior with minimal duplication.

- [ ] **Step 4: Run the test + the gate tests.**
Run: `cargo test -p kylins-client-backend decrypt_message_mime_bytes` → PASS.
Run: `cargo test -p kylins-client-backend mail::crypto` → all pre-existing tests still PASS (zero regression — the refactor is behavior-preserving; `OpenCryptoResult` unchanged).

- [ ] **Step 5: Commit.**
```bash
cd kylins.client.backend && cargo fmt --all
git add kylins.client.backend/src/mail/crypto.rs
git commit -m "refactor(crypto): extract decrypt_message_mime_bytes helper (behavior-preserving)"
```

---

## Task 2: Backend `crypto_fetch_attachment` + `crypto_fetch_inline_images` commands

**Files:**
- Modify: `kylins.client.backend/src/sync_engine/commands.rs` (mirror `sync_fetch_attachment_inner` `:413-493` + `sync_fetch_inline_images_inner` `:530-641`).
- Modify: `kylins.client.backend/src/lib.rs:262-272` (register 2 commands).
- Test: extend `sync_engine/commands.rs` tests (or `mail/crypto.rs` tests if the command inner fns are testable there).

**Interfaces:**
- Consumes: `decrypt_message_mime_bytes` (Task 1), `attachment_cache::{cache_file_path, write_cache_file, CachedAttachment, CachedInlineImage}` (`attachment_cache.rs`), `mail_parser` part-bytes pattern.
- Produces: `crypto_fetch_attachment(account_id, message_id, filename, content_id) -> CachedAttachment`; `crypto_fetch_inline_images(account_id, message_id) -> Vec<CachedInlineImage>`. Consumed by Task 3's frontend.

- [ ] **Step 1: Read the mirror patterns.** Read `sync_fetch_attachment_inner` (`:413-493`) + `sync_fetch_inline_images_inner` (`:530-641`) + `fetch_inline_cid_parts` (`mail/imap/client.rs:2317-2359`) + `decode_part_bytes` (`:2283-2300`) + `attachment_cache.rs:59-124`. Note: cache path = `cache_file_path(cache_root, account_id, message_id, attachment_id, filename)`; `write_cache_file(path, bytes) -> u64`; the `match &part.body` arms for bytes.

- [ ] **Step 2: Write failing tests.** Round-trip tests (reuse the `granularity_b` fixture shape from `crypto.rs:3912`):
  - `crypto_fetch_attachment_returns_bytes`: encrypt a 3-attachment message, persist ciphertext via `message_bodies`, call `crypto_fetch_attachment(pool, account, msg, "a1.bin", None)`, assert `CachedAttachment.file_path` exists + `std::fs::read` equals `b"AAA"` (the a1.bin content).
  - `crypto_fetch_inline_images_returns_cid_parts`: encrypt a message with one inline `cid:` image, call `crypto_fetch_inline_images(pool, account, msg)`, assert 1 `CachedInlineImage` with the right `content_id` + bytes.
  RED: commands not defined.

- [ ] **Step 3: Implement `crypto_fetch_attachment_inner`.** Mirror `sync_fetch_attachment_inner` but: no `attachments::get_attachment_meta` (no DB row) — `decrypt_message_mime_bytes(pool, account_id, message_id)` → `MessageParser::default().parse(bytes)` → walk `parsed.parts` → find the part whose `attachment_name()` == `filename` (and `content_id()` matches `content_id` if provided, for inline disambiguation) → extract bytes via `match &part.body` → `cache_file_path(cache_root, account, msg, "{account}_{msg}_crypto_{sanitize(filename)}", filename)` + `write_cache_file` → return `CachedAttachment { file_path, filename, mime_type, size: written as i64 }`. Error if not found / not encrypted / decrypt failed.

- [ ] **Step 4: Implement `crypto_fetch_inline_images_inner`.** `decrypt_message_mime_bytes` → parse → walk `parsed.parts`, for each part with a `content_id()` (trim `<>`): extract bytes via `match &part.body` (skip `Multipart`) → `cache_file_path` + `write_cache_file` → collect `CachedInlineImage { content_id, file_path, mime_type, size }`. (If it's cleaner, extract a pure `extract_inline_cid_parts_from_message(&mail_parser::Message) -> Vec<(content_id, mime_type, bytes)>` helper and reuse it; otherwise inline the walk.)

- [ ] **Step 5: Add + register the `#[tauri::command]` wrappers.** Mirror `sync_fetch_attachment` (`:499-509`) + `sync_fetch_inline_images`. Register both in `lib.rs:262-272` `invoke_handler![]`.

- [ ] **Step 6: Run tests.**
Run: `cargo test -p kylins-client-backend crypto_fetch_attachment crypto_fetch_inline_images` → PASS.
Run: `cargo test -p kylins-client-backend --lib sync_engine::` → zero regression.

- [ ] **Step 7: Commit.**
```bash
cd kylins.client.backend && cargo fmt --all
git add kylins.client.backend/src/sync_engine/commands.rs kylins.client.backend/src/lib.rs
git commit -m "feat(crypto): crypto_fetch_attachment + crypto_fetch_inline_images commands"
```

---

## Task 3: Frontend wiring — display + download + inline branch

**Files:**
- Modify: `kylins.client.frontend/src/features/view/viewStore.ts:94, 158-162`.
- Modify: `kylins.client.frontend/src/stores/threadStore.ts:139-188`.
- Modify: `kylins.client.frontend/src/components/email/AttachmentList.tsx:46-103`.
- Modify: `kylins.client.frontend/src/components/layout/ReadingPane.tsx:165-217, 427-431`.
- Modify: `kylins.client.frontend/src/services/db/attachments.ts:62-78`.
- Test: `kylins.client.frontend/tests/components/email/AttachmentList.test.tsx`.

**Interfaces:**
- Consumes: `fetchCryptoAttachment` + `fetchCryptoInlineImages` (new wrappers in `attachments.ts`), `ImapAttachment` type, `OpenCryptoResult.attachments` (already in `cryptoReceive.ts`).
- Produces: `<AttachmentList decryptedAttachments={...} isCrypto={...} />` rendering crypto attachments + a crypto download path; `ReadingPane` inline branch.

- [ ] **Step 1: Read the current code.** Read `viewStore.ts:71-115, 158-162`, `threadStore.ts:139-188`, `AttachmentList.tsx:40-105`, `ReadingPane.tsx:160-220, 420-435`, `attachments.ts:19-78`, `cryptoReceive.ts:84-110` (for `ImapAttachment` TS shape — snake_case). Confirm the `ImapAttachment` TS fields (`part_id, filename, mime_type, size, content_id, is_inline`).

- [ ] **Step 2: Write the failing AttachmentList test.** Render `<AttachmentList decryptedAttachments={3 items} isCrypto accountId messageId />`; assert the 3 chips render (the existing `getAttachments` mock is NOT called when `isCrypto && decryptedAttachments`). Click download → assert `fetchCryptoAttachment` called with `(accountId, messageId, filename, contentId)` + `copy_cached_attachment` called. Mirror the real-store test pattern from `KeyManager.test.tsx` / `AttachmentList.test.tsx`. RED: `decryptedAttachments`/`isCrypto` props or `fetchCryptoAttachment` not present.

- [ ] **Step 3: Extend `viewStore.DecryptedCacheEntry`.** Add `attachments: ImapAttachment[]` + `isCrypto: boolean` to `DecryptedCacheEntry`; update `setDecrypted(id, html, text, attachments, isCrypto)`.

- [ ] **Step 4: Thread `result.attachments` in `threadStore.selectThread`.** In the crypto branch (`:156-175`): `setDecrypted(latest.id, result.plaintextHtml, result.plaintextText, result.attachments, true)` + `mail.attachments = result.attachments`. In the cache-hit branch (`:139-155`): re-hydrate `mail.attachments = cached.attachments`. (Confirm `MailMessage.attachments?` exists on the type — `viewStore.ts:22` per explore; if not, add it.)

- [ ] **Step 5: Add `fetchCryptoAttachment` + `fetchCryptoInlineImages` to `attachments.ts`.**
```ts
export function fetchCryptoAttachment(
  accountId: string, messageId: string,
  filename: string, contentId: string | null,
): Promise<CachedAttachment> {
  return invoke<CachedAttachment>('crypto_fetch_attachment', { accountId, messageId, filename, contentId });
}
export function fetchCryptoInlineImages(
  accountId: string, messageId: string,
): Promise<CachedInlineImage[]> {
  return invoke<CachedInlineImage[]>('crypto_fetch_inline_images', { accountId, messageId });
}
```

- [ ] **Step 6: `AttachmentList` crypto branch.** Accept `decryptedAttachments?: ImapAttachment[]` + `isCrypto?: boolean` props. When `isCrypto && decryptedAttachments?.length`, render those (map `ImapAttachment` → chip: `filename`, `mime_type`, `size`; hide inline if `is_inline && referencedCids.has(content_id)`). `handleDownload`: for crypto, `fetchCryptoAttachment(accountId, messageId, filename, contentId ?? null)` → `copy_cached_attachment` to dest; else existing `fetchAttachment(imapPartId)` path. The `CRYPTO_ENVELOPE_TYPES` filter is irrelevant for the crypto branch (decrypted attachments are real files, not envelopes).

- [ ] **Step 7: `ReadingPane` wiring.** Pass `decryptedAttachments={cached?.attachments}` + `isCrypto={cached?.isCrypto ?? !!message.isEncrypted}` to `<AttachmentList>` (`:427-431`). Inline-image effect (`:165-217`): if `isCrypto`, call `fetchCryptoInlineImages(acct, id)` instead of `fetchInlineImages(acct, id)`; the Blob/objectURL loop is unchanged. (Obtain `cached` from `useViewStore.getState().decryptedCache[message.id]`.)

- [ ] **Step 8: Run the test + type-check + full suite.**
Run: `cd kylins.client.frontend && npx vitest run tests/components/email/AttachmentList.test.tsx` → PASS.
Run: `npx tsc --noEmit` → clean.
Run: `npx vitest run` → zero regression.

- [ ] **Step 9: Commit.**
```bash
cd kylins.client.frontend
git add kylins.client.frontend/src/features/view/viewStore.ts \
        kylins.client.frontend/src/stores/threadStore.ts \
        kylins.client.frontend/src/components/email/AttachmentList.tsx \
        kylins.client.frontend/src/components/layout/ReadingPane.tsx \
        kylins.client.frontend/src/services/db/attachments.ts \
        kylins.client.frontend/tests/components/email/AttachmentList.test.tsx
git commit -m "feat(crypto): display + download + inline decrypted attachments for encrypted mail"
```

---

## Task 4: Full verification + smoke

**Files:** none modified — verification only.

- [ ] **Step 1: Full backend + frontend test run.**
```bash
cd kylins.client.backend && cargo test -p kylins-client-backend 2>&1 | grep -E "test result:|FAILED" | head
cd ../kylins.client.frontend && npx tsc --noEmit && npx vitest run 2>&1 | tail -10
```
Expected: backend 0 failed (incl. Task 1 helper test + Task 2 command round-trips + the `mail::crypto` gate); frontend `tsc` clean + all tests green (incl. Task 3 AttachmentList test).

- [ ] **Step 2: Manual smoke.** `cargo tauri dev` → open an encrypted message with attachments + an inline image → confirm: (a) attachment chips render, (b) clicking download saves the right file, (c) inline `cid:` image renders in the body. Then re-open (cache hit) → confirm attachments still render. Test a Granularity-B (merged-subtree) encrypted message too → confirm the merged-container attachments all show + download.

- [ ] **Step 3: Final commit if any smoke fixups.**
```bash
git add <specific files>
git commit -m "test(crypto): decrypted-attachments smoke fixups"
```

---

## Out of Scope

- Persisting crypto attachments to the `attachments` table (session/cache-only for now).
- EWS/EAS crypto attachments (IMAP S/MIME only).
- `send_op` / `build_mime` / `apply_crypto` / granularity-path changes.
- A global "decrypted attachments persist across sessions" feature (the cache is session-only, matching the existing decrypted-html/text cache).

## Self-Review

- **Spec coverage:** helper refactor (T1) ✓; `crypto_fetch_attachment` + `crypto_fetch_inline_images` (T2) ✓; display (decryptedCache + threadStore + AttachmentList) + download (fetchCryptoAttachment) + inline (ReadingPane branch) (T3) ✓; verification (T4) ✓.
- **No placeholders:** verify-points are "read X first" where the exact structure is codebase-specific (the decrypt-arm split in T1 Step 3, the cache-id format, the mail_parser API). The plan does not invent these.
- **Type consistency:** `decrypt_message_mime_bytes -> Result<Option<Vec<u8>>, String>` (T1) used by both commands (T2). `fetchCryptoAttachment(accountId, messageId, filename, contentId)` (TS) ↔ `crypto_fetch_attachment(account_id, message_id, filename, content_id)` (Rust). `CachedAttachment`/`CachedInlineImage` reused verbatim. `DecryptedCacheEntry.attachments: ImapAttachment[]` matches `OpenCryptoResult.attachments`.
