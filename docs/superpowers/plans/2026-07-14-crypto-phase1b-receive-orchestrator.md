# Crypto Phase 1b Plan 3 — S/MIME Receive Backend Orchestrator (G5) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Wire the S/MIME receive pieces together end-to-end on the backend: persist inbound CMS ciphertext at body-fetch time, and add the `open_crypto_message` orchestrator + `crypto_open_message` / `db_get_message_crypto_result` Tauri commands that decrypt + cert-chain-verify an opened message and persist the result — plus wire `validate_recipient_certs` into the send side (closes Plan 4a). After this plan, opening an encrypted/signed message via the command produces decrypted plaintext (in-memory) + a persisted `message_crypto_results` row, with no frontend change yet (G6 does the UI).

**Architecture:** This is **Phase 1b Plan 3 (G5)**, backend-only. It composes Plan 1's `cms_parse::{decrypt_enveloped, verify_signed}` + G4's `SmimeBackend::verify_with_context` / `validate_recipient_certs` / `fetch_crl_cached` / `validate_signer_chain` into a receive orchestrator (`mail/crypto.rs::open_crypto_message`), backed by a trust-anchor resolver (`db::crypto_keys::list_trust_anchor_certs`) and an intermediates extractor (`cms_parse::extract_intermediates`). Ciphertext is cached at rest (`message_bodies.body_mime_ciphertext`); plaintext is memory-only. The send side gains fail-closed recipient-cert validation. The `sync:crypto-result` event lets the (G6) UI refresh.

**Tech Stack:** Rust; backend `kylins.client.backend` (sqlx, reqwest, mail-parser, tauri); `crypto-smime` (path crate — `SmimeBackend`, `verify_with_context`, `validate_recipient_certs`, `cms_parse`, `chain`). `x509-parser 0.18` (already a backend dev-dep) for CRL distribution-point extraction. Spec: `docs/superpowers/specs/2026-07-12-crypto-phase1b-smime-receive-design.md` §6. Plan 1 (`9402bf0`) + G4 (`535163e`, `90ca70e`) provide the building blocks.

## Global Constraints

- **User controls git — DO NOT COMMIT.** Skip "Commit" steps; leave changes uncommitted. Controller review still runs per task.
- **SDD workflow:** fresh implementer subagent per task + controller review + ledger entry.
- **Gates (every task):** `cargo test --lib` green (backend); `cargo test -p crypto-smime` green where the crypto-smime crate is touched; `cargo clippy --all-targets -- -D warnings` clean; `cargo build` clean. Run from `kylins.client.backend/` (and `kylins.client.crypto/` for crypto-smime tasks).
- **Backend-only scope.** Do NOT touch the frontend (G6 owns threadStore.selectThread wiring + CryptoBadge/TrustDialog). Do NOT build the KeyManager "Trusted CAs" UI (G6) — this plan only adds the backend resolver + assumes CA roots are inserted via the existing `db_upsert_crypto_key` (`key_type='cert'`).
- **Plaintext is memory-only** (spec hard rule): `open_crypto_message` returns decrypted plaintext in its return value; it is NEVER written to SQLite. Only the CMS *ciphertext* is persisted (in `message_bodies.body_mime_ciphertext`).
- **Private-key hygiene:** decryption-key PKCS#8 bytes via `get_crypto_key_full` (at-rest-decrypt) wrapped in `Zeroizing` (mirror the send side). `SmimeBackend` per-call (not Clone).
- **The two G4 integration landmines are fixed here:** (1) `fetch_crl_cached` is called with a `reqwest::Client` built with a timeout (e.g. `Client::builder().timeout(Duration::from_secs(30)).build()`); (2) `validate_recipient_certs` is widened at the send-side call site to pass intermediates (see Task 5).
- **`from_address`** (NOT `from_email`) is the `messages` column for the From: email.
- **spawn_blocking:** the existing crypto-command convention is to `.await` the backend method directly (no `spawn_blocking` today). Follow that convention for `crypto_open_message` unless a focused benchmark shows the cert-chain work blocks the runtime — then wrap the blocking portion in `spawn_blocking`. Default: `.await` directly.

## File Structure

**Create:**
- (none — no new modules; all changes are additions to existing files.)

**Modify:**
- `kylins.client.backend/src/mail/imap/types.rs` — `FetchedBody` gains `raw_ciphertext: Option<Vec<u8>>`.
- `kylins.client.backend/src/mail/imap/client.rs` — `fetch_bodies_batch_on_session` populates `raw_ciphertext` from the raw CMS part for crypto-marked messages.
- `kylins.client.backend/src/sync_engine/commands.rs` — `request_bodies_inner` persists ciphertext (`set_message_ciphertext` after `set_message_body`).
- `kylins.client.backend/src/db/crypto_keys.rs` — `list_trust_anchor_certs(pool, account_id) -> Vec<Vec<u8>>`.
- `kylins.client.backend/src/db/commands.rs` — `crypto_open_message` + `db_get_message_crypto_result` Tauri commands (+ `_inner` for the orchestrator).
- `kylins.client.crypto/smime/src/cms_parse.rs` — `extract_intermediates(signed_data_der) -> Vec<Vec<u8>>` (pub(crate)→pub via re-export if needed by the backend).
- `kylins.client.crypto/smime/src/lib.rs` — re-export `extract_intermediates` (like `validate_signer_chain`).
- `kylins.client.backend/src/mail/crypto.rs` — `open_crypto_message` orchestrator + CDP-extraction helper; wire `validate_recipient_certs` into `apply_crypto`.
- `kylins.client.backend/src/sync_engine/engine.rs` — `EventSink::emit_crypto_result` + `CryptoResultEvent`; update `TauriSink` + test sinks.
- `kylins.client.backend/src/lib.rs` — register `crypto_open_message` + `db_get_message_crypto_result`.

---

## Interfaces (cross-task contract — implementers read this)

- **`db::crypto_keys::list_trust_anchor_certs(pool, account_id) -> Result<Vec<Vec<u8>>, String>`** (Task 2) — returns CA-root cert DERs (`standard='smime' AND key_type='cert'`), `public_data` column.
- **`cms_parse::extract_intermediates(signed_data_der) -> crypto_core::Result<Vec<Vec<u8>>>`** (Task 2) — all certs in the SignedData `certificates` set EXCEPT the signer leaf.
- **`mail::crypto::open_crypto_message(pool, account_id, message_id) -> Result<OpenCryptoResult, String>`** (Task 3) — the orchestrator. `OpenCryptoResult { plaintext_html: Option<String>, plaintext_text: Option<String>, attachments: Vec<...>, crypto_result: MessageCryptoResultRow }`. Plaintext is in-memory only.
- **`crypto_open_message` / `db_get_message_crypto_result`** (Task 4) — Tauri commands wrapping the above.
- **`EventSink::emit_crypto_result(CryptoResultEvent)`** (Task 4) — `{ account_id, message_id }`.

---

## Task 1: Ciphertext persist at body-fetch time

**Files:**
- Modify: `kylins.client.backend/src/mail/imap/types.rs:108-115` (`FetchedBody`)
- Modify: `kylins.client.backend/src/mail/imap/client.rs:414-508` (`fetch_bodies_batch_on_session`)
- Modify: `kylins.client.backend/src/sync_engine/commands.rs:139-203` (`request_bodies_inner`)

**Interfaces:**
- Consumes: Plan 1's `crypto_kind_from_content_type` (in `sync_engine/mod.rs`), `set_message_ciphertext` (`db::message_bodies`).
- Produces: `FetchedBody.raw_ciphertext` populated for crypto-marked messages; the ciphertext persisted to `message_bodies.body_mime_ciphertext`.

- [ ] **Step 1: Extend `FetchedBody`**

In `mail/imap/types.rs`, add a field:
```rust
pub struct FetchedBody {
    pub uid: u32,
    pub body_html: Option<String>,
    pub body_text: Option<String>,
    pub snippet: String,
    pub attachments: Vec<ImapAttachment>,
    /// Raw CMS payload (`smime.p7m`/`p7s` body bytes) for encrypted / opaque-signed
    /// mail. Populated only when the top-level Content-Type is S/MIME; None for
    /// ordinary mail. Plaintext is NEVER persisted — only this ciphertext.
    pub raw_ciphertext: Option<Vec<u8>>,
}
```
Update every `FetchedBody { ... }` literal (search the backend) to include `raw_ciphertext` (default `None` except the producer in Step 2).

- [ ] **Step 2: Populate `raw_ciphertext` in `fetch_bodies_batch_on_session`**

In `mail/imap/client.rs::fetch_bodies_batch_on_session`, after `let parsed = parser.parse(raw)` (the `mail_parser::Message`), re-derive `crypto_kind` from `parsed.content_type()` (mirror `imap_message_to_remote`'s `crypto_kind_from_content_type` call at `imap_source.rs:227-230`). When it is `Some(CryptoKind::Encrypted)` or `Some(Signed)` (opaque `application/pkcs7-mime; smime-type=signed-data` — NOT clear-signed `multipart/signed`, whose body is already plaintext), extract the raw CMS part bytes and set `raw_ciphertext`.

For `application/pkcs7-mime` (enveloped-data / opaque signed-data): the CMS blob IS the message body — `raw_ciphertext = Some(raw_body_bytes_for_that_part)`. `mail_parser` exposes the raw part bytes; if the body is base64-encoded `smime.p7m`, the CMS DER is the base64-decoded body. Use `mail_parser`'s raw-part access (or base64-decode `parsed.body_text(0)` when the content-type is `application/pkcs7-mime`). Confirm the exact `mail_parser` API for raw part bytes; the intent is: the binary CMS DER that `decrypt_enveloped`/`verify_signed` will consume.

For `multipart/signed` (clear-signed): NO `raw_ciphertext` (the body is plaintext; the signature is a `smime.p7s` attachment). Set `raw_ciphertext = None` — the orchestrator handles clear-signed via the attachment.

- [ ] **Step 3: Persist ciphertext in `request_bodies_inner`**

In `sync_engine/commands.rs::request_bodies_inner`, inside the `Some(fb) => { ... }` block (lines 139-203), AFTER `set_message_body` succeeds, add:
```rust
if let Some(ct) = fb.raw_ciphertext.as_deref() {
    // set_message_ciphertext UPDATEs an existing row; set_message_body
    // above must have created it. Best-effort: log + skip on error.
    if let Err(e) = message_bodies::set_message_ciphertext(pool, account_id, mid, ct).await {
        log::warn!("[crypto] failed to persist ciphertext for {mid}: {e}");
    }
}
```
(Note the ordering dependency from the grounding report: `set_message_body` first, then `set_message_ciphertext` — the latter is an UPDATE that requires the row to exist.)

- [ ] **Step 4: Test**

Add a backend test that builds a crypto-marked `FetchedBody` (or a small fake of the fetch path) + asserts `set_message_ciphertext` is reached. If the fetch path is hard to unit-test end-to-end, test `set_message_ciphertext` after `set_message_body` directly (the ordering invariant) — seed a message_bodies row via `set_message_body`, then `set_message_ciphertext`, then `get_message_ciphertext` round-trip. Mirror the existing `message_bodies::ciphertext_tests` from Plan 1.

Run: `cd kylins.client.backend && cargo test --lib message_bodies && cargo clippy --all-targets -- -D warnings`
Expected: PASS + clean.

- [ ] **Step 5: Commit (SKIPPED — user controls git)**

---

## Task 2: Trust-anchor resolver + intermediates extractor

**Files:**
- Modify: `kylins.client.backend/src/db/crypto_keys.rs` (add `list_trust_anchor_certs`)
- Modify: `kylins.client.backend/src/db/commands.rs` (optional thin command wrapper, if G6 needs it — otherwise skip)
- Modify: `kylins.client.crypto/smime/src/cms_parse.rs` (add `extract_intermediates`)
- Modify: `kylins.client.crypto/smime/src/lib.rs` (re-export `extract_intermediates`)

**Interfaces:**
- Consumes: the `crypto_keys` schema (`key_type='cert'`, `public_data` BLOB); `cms::signed_data::SignedData.certificates` (`CertificateSet`).
- Produces: `list_trust_anchor_certs(pool, account_id) -> Result<Vec<Vec<u8>>, String>` + `cms_parse::extract_intermediates(signed_data_der) -> Result<Vec<Vec<u8>>>`.

- [ ] **Step 1: `list_trust_anchor_certs` (failing test first)**

In `db/crypto_keys.rs`, add a test (mirror the existing test-module pool setup):
```rust
#[cfg(test)]
async fn list_trust_anchor_certs_returns_ca_root_ders(pool: SqlitePool) {
    // seed an account + a crypto_keys row with key_type='cert', standard='smime',
    // public_data = a CA-root DER (any bytes), account_id = "acct".
    // call list_trust_anchor_certs(&pool, "acct") -> assert returns [that DER].
    // seed a key_type='private' row (a signing key) -> assert it is NOT returned.
}
```
Run → FAIL (`list_trust_anchor_certs` undefined).

- [ ] **Step 2: Implement `list_trust_anchor_certs`**

```rust
/// Return the DER bytes of every S/MIME CA-root trust anchor the user has
/// imported for this account (`crypto_keys` rows with standard='smime',
/// key_type='cert'). These feed `SmimeBackend::verify_with_context`'s
/// `trust_anchor_ders`. Personal signing keys (key_type='private') are excluded.
pub async fn list_trust_anchor_certs(
    pool: &sqlx::SqlitePool,
    account_id: &str,
) -> Result<Vec<Vec<u8>>, String> {
    let rows: Vec<(Vec<u8>,)> = sqlx::query_as(
        "SELECT public_data FROM crypto_keys
         WHERE account_id = ? AND standard = 'smime' AND key_type = 'cert'",
    )
    .bind(account_id)
    .fetch_all(pool)
    .await
    .map_err(|e| e.to_string())?;
    Ok(rows.into_iter().map(|(d,)| d).collect())
}
```
Run → GREEN.

- [ ] **Step 3: `extract_intermediates` in `cms_parse.rs` (failing test first)**

In `cms_parse.rs`, add a test: build a SignedData whose `certificates` set contains a signer leaf + 1 intermediate (use the send-side `build_signed_data` which embeds the signer cert; for a multi-cert set, extend the test to add an intermediate — or test against a fixture). Assert `extract_intermediates` returns the intermediate DER(s), NOT the signer leaf.

Run → FAIL.

- [ ] **Step 4: Implement `extract_intermediates`**

```rust
/// Extract every cert in the SignedData `certificates` set EXCEPT the signer
/// leaf — the intermediates the orchestrator passes to
/// `verify_with_context(intermediate_ders)`. The signer leaf is identified by
/// the first SignerInfo's SignerIdentifier (IssuerAndSerialNumber), mirroring
/// `locate_signer_cert`.
pub fn extract_intermediates(signed_data_der: &[u8]) -> Result<Vec<Vec<u8>>> {
    // Parse ContentInfo -> SignedData (same idiom as verify_signed).
    // For each cert in sd.certificates (CertificateChoices::Certificate(c)):
    //   if c is NOT the signer leaf (by IssuerAndSerialNumber / SKI match) -> push c.to_der().
    // Return the Vec.
    todo!("implement: mirror verify_signed's parse + locate_signer_cert; collect non-signer certs")
}
```
Resolve the `CertificateSet` iteration + `CertificateChoices` variants against the vendored cms source (`vendor/cms/src/signed_data.rs` + the send-side `cms_build.rs` which already touches `CertificateChoices`). The signer-leaf match reuses the same `SignerIdentifier` comparison as `locate_signer_cert`. Re-export from `lib.rs`: `pub use cms_parse::extract_intermediates;` (next to the existing `validate_signer_chain` re-export).

Run → GREEN.

- [ ] **Step 5: Gates + Commit (SKIPPED)**

`cargo test -p crypto-smime` (extract_intermediates test) + backend `cargo test --lib` (list_trust_anchor_certs test) + clippy both.

---

## Task 3: `open_crypto_message` orchestrator

**Files:**
- Modify: `kylins.client.backend/src/mail/crypto.rs` (add `open_crypto_message` + `extract_crl_distribution_points` + `OpenCryptoResult`)

**Interfaces:**
- Consumes: `SmimeBackend::{decrypt, verify_with_context, export_public}` (crypto-smime); `cms_parse::{decrypt_enveloped, verify_signed, extract_intermediates}`; `db::crypto_keys::{list_trust_anchor_certs, list_crypto_keys_for_account, get_crypto_key_full}`; `db::message_bodies::get_message_ciphertext`; `db::message_crypto_results::upsert_message_crypto_result`; `db::messages` (from_address); `fetch_crl_cached`; `crypto_kind_from_content_type`.
- Produces: `open_crypto_message(pool, account_id, message_id) -> Result<OpenCryptoResult, String>`.

- [ ] **Step 1: Define `OpenCryptoResult` + the orchestrator skeleton**

In `mail/crypto.rs`:
```rust
/// Result of opening a crypto-marked message. Plaintext fields are IN-MEMORY
/// ONLY — the caller (the Tauri command / G6 UI) renders them; they are NEVER
/// written back to SQLite.
pub struct OpenCryptoResult {
    pub plaintext_html: Option<String>,
    pub plaintext_text: Option<String>,
    pub attachments: Vec<crate::mail::imap::types::ImapAttachment>, // or the shared attachment type
    pub crypto_result: crate::db::message_crypto_results::MessageCryptoResultRow,
}
```

`open_crypto_message` flow (the receive pipeline, spec §3.1):
1. Load `messages.from_address` + `message_bodies.body_mime_ciphertext` for `(account_id, message_id)`. If no ciphertext → return an error / `decrypt_state=Failed` (the message isn't actually crypto-marked, or the body wasn't fetched).
2. Parse the CMS blob: `ContentInfo::from_der` → branch on `id-enveloped-data` (encrypted) vs `id-signed-data` (opaque signed). (For clear-signed `multipart/signed` the body is already plaintext + a `smime.p7s` attachment — handle separately or defer to G6; for G5 focus on `application/pkcs7-mime` enveloped/signed-data.)
3. **If encrypted:** resolve the decryption key (load the account's S/MIME private keys via `list_crypto_keys_for_account`; for each, test whether its cert's IssuerAndSerialNumber/SKI matches a recipient info — mirror Plan 1's decrypt-key selection). Build the `EncryptedEnvelope` + `DecryptOp`, call `backend.decrypt` → inner MIME bytes. If the inner MIME is itself signed (`id-signed-data`), recurse into verify.
4. **If signed:** build the `SignedEnvelope` (signature DER = the SignedData; payload = covered content). Resolve trust anchors (`list_trust_anchor_certs`), intermediates (`extract_intermediates`), from_email (`from_address`), CRLs (Step 2 helper), signer trust (Step 3). Call `backend.verify_with_context` → `VerificationResult`.
5. `mail_parser` the final plaintext MIME → html/text/attachments (reuse `extract_attachments`).
6. Upsert `message_crypto_results` (crypto_kind, decrypt_state, signature_state, signer_fingerprint/email, chain_valid, revocation_state, verified_at).
7. Return `OpenCryptoResult` (plaintext in-memory).

- [ ] **Step 2: CRL distribution-point extraction + fetch**

```rust
/// Extract cRLDistributionPoints URLs from a cert (x509-parser) + fetch each
/// (cached, soft-fail). Returns the fetched CRL DERs for verify_with_context.
async fn resolve_crls(
    pool: &sqlx::SqlitePool,
    client: &reqwest::Client,
    cert_ders: &[Vec<u8>], // signer + intermediates
) -> Vec<Vec<u8>> {
    // For each cert, x509-parser -> iter crl_distribution_points() -> each URL.
    // fetch_crl_cached(pool, client, url) per URL; collect Somes.
    // Resolves the G4 landmine #1 (client has a timeout) at the CALL SITE.
    todo!()
}
```
The orchestrator builds the `reqwest::Client` ONCE with a timeout: `reqwest::Client::builder().timeout(std::time::Duration::from_secs(30)).build().unwrap()`. (G4 landmine #1 fixed here.) Use `x509-parser`'s `X509Certificate::iter_extensions()` / `ParsedExtension::CRLDistributionPoints` to get URLs — confirm the exact API against `x509-parser 0.18`.

- [ ] **Step 3: Resolve signer trust**

```rust
/// Resolve the signer's TrustState for the verify_with_context mapping:
/// - if the signer fingerprint matches one of the account's OWN private keys
///   (encrypt-to-self) -> TrustState::Personal;
/// - else look up the latest trust_decision for (account_id, signer_email, 'smime', fp);
///   map decision -> TrustState (verified/personal/unverified/undecided/rejected);
/// - default TrustState::Undecided.
async fn resolve_signer_trust(pool, account_id, signer_fingerprint, signer_email) -> TrustState { ... }
```
(The `trust_decisions.decision` values already match `TrustState`'s serde lowercase names.)

- [ ] **Step 4: Test the orchestrator (integration)**

Backend integration test (mirror the existing `crypto_smime_lifecycle` integration test pattern): generate a key, sign+encrypt a MIME via `apply_crypto` (send side), persist the ciphertext as a `message_bodies.body_mime_ciphertext` row, call `open_crypto_message` → assert it decrypts + verifies → `decrypt_state=Ok`, `signature_state=ValidVerified` (our own key → Personal trust). Add a no-decryption-key case → `decrypt_state=NoKey`.

This is the load-bearing end-to-end test for G5 (send-side `apply_crypto` → receive `open_crypto_message` round-trip).

- [ ] **Step 5: Gates + Commit (SKIPPED)**

`cargo test --lib` (orchestrator test) + clippy + build. This task is the largest; if the implementer is uncertain about the CMS-structure branching (encrypted-vs-signed) or the decrypt-key selection, escalate — those are the subtle bits.

---

## Task 4: Tauri commands + `sync:crypto-result` event

**Files:**
- Modify: `kylins.client.backend/src/db/commands.rs` (`crypto_open_message` + `db_get_message_crypto_result` + `_inner`s)
- Modify: `kylins.client.backend/src/sync_engine/engine.rs` (`EventSink::emit_crypto_result` + `CryptoResultEvent`; `TauriSink` + test sinks)
- Modify: `kylins.client.backend/src/lib.rs` (register the two commands)

**Interfaces:**
- Consumes: `open_crypto_message`, `db::message_crypto_results::get_message_crypto_result`, the `EventSink` trait.
- Produces: the two Tauri commands + the event.

- [ ] **Step 1: `crypto_open_message` + `db_get_message_crypto_result` commands**

In `db/commands.rs`, mirror `crypto_generate_key` (the `_inner` + command pattern):
```rust
#[tauri::command]
pub async fn crypto_open_message(
    pool: State<'_, SqlitePool>,
    sink: State<'_, Arc<dyn EventSink>>,   // confirm the exact State type the engine sink is managed as
    account_id: String,
    message_id: String,
) -> Result<crypto_open_message_result, String> {
    let res = crate::mail::crypto::open_crypto_message(&pool, &account_id, &message_id).await?;
    // emit sync:crypto-result so the (G6) UI can refresh badges
    // sink.emit_crypto_result(CryptoResultEvent { account_id, message_id });
    Ok(res)
}

#[tauri::command]
pub async fn db_get_message_crypto_result(
    pool: State<'_, SqlitePool>,
    account_id: String,
    message_id: String,
) -> Result<Option<MessageCryptoResultRow>, String> {
    crate::db::message_crypto_results::get_message_crypto_result(&pool, &account_id, &message_id).await
}
```
(Confirm how the `EventSink` is managed in `lib.rs` (is it `State<'_, Arc<dyn EventSink>>`? or accessed via the `SyncEngine`?). The `crypto_open_message` command needs the sink to emit — read `lib.rs` setup to get the right `State` handle. If the sink isn't a managed State, emit via the `SyncEngine`'s sink or pass through a Tauri `AppHandle`. Match the existing pattern.)

Register both in `lib.rs`'s `invoke_handler!` (next to `db_get_message_body` / `crypto_generate_key`).

- [ ] **Step 2: `CryptoResultEvent` + `EventSink::emit_crypto_result`**

In `engine.rs`:
```rust
#[derive(Clone, serde::Serialize)]
pub struct CryptoResultEvent {
    pub account_id: String,
    pub message_id: String,
}
```
Add `fn emit_crypto_result(&self, evt: CryptoResultEvent);` to the `EventSink` trait. Implement in `TauriSink`: `self.0.emit("sync:crypto-result", e);`. Update EVERY test sink impl (`NullSink`, `CapturingSink`, `TestSink`) with a no-op (or capturing) `emit_crypto_result` — the compiler will list them.

- [ ] **Step 3: Test**

A focused test that `crypto_open_message` returns the result + (if the sink is testable) emits the event. The orchestrator integration test from Task 3 already exercises the logic; this task's test focuses on the command wrapper + event emission.

- [ ] **Step 4: Gates + Commit (SKIPPED)**

`cargo test --lib` + clippy + build.

---

## Task 5: Send-side `validate_recipient_certs` wiring (closes Plan 4a)

**Files:**
- Modify: `kylins.client.backend/src/mail/crypto.rs::apply_crypto` (lines 272-317, the encrypt block)

**Interfaces:**
- Consumes: `validate_recipient_certs` (G4), `list_trust_anchor_certs` (Task 2), `SmimeBackend::export_public`.
- Produces: fail-closed recipient-cert validation before `backend.encrypt`.

- [ ] **Step 1: Wire `validate_recipient_certs` into `apply_crypto`**

In the encrypt block, AFTER the `recipients` loop resolves the `KeyHandleRef`s (line 291) and BEFORE `backend.encrypt` (line 292):
1. Resolve each recipient `KeyHandleRef` → its cert DER via `backend.export_public(&h.handle)` (or the keystore's `get` → `public_data`).
2. Resolve the trust anchors via `list_trust_anchor_certs(pool, account_id)` (G4 landmine #2: pass intermediates too — for recipients whose chain isn't directly to a configured anchor, include any intermediate certs bundled at PEM import; for G5, also pass the account's own cert + any `key_type='cert'` rows as candidate intermediates if cheap, OR accept that corporate-PKI recipients need bundled intermediates at import — document this).
3. `let now_unix = SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0);`
4. `validate_recipient_certs(&recipient_cert_ders, &trust_anchor_ders, now_unix).await.map_err(|e| CryptoSendError::MissingRecipientCert(e))?;` — add a `CryptoSendError` variant or map to an existing one (read `CryptoSendError` at `mail/crypto.rs:64-69`; add `InvalidRecipientCert(String)` if no fit).
5. On `Err`, `apply_crypto` returns the error → `send_op` (engine.rs:1071-1078) emits `SendResultEvent{success:false}` + returns `Err` → fail-closed (no ciphertext produced). Confirmed by the grounding report.

- [ ] **Step 2: Test**

Extend the send-side test: an `apply_crypto` call with a recipient whose cert chains to an unconfigured anchor → `Err(InvalidRecipientCert)`, and NO `backend.encrypt` call (fail-closed — assert via a mock/recording backend). A valid recipient → proceeds to encrypt.

- [ ] **Step 3: Gates + Commit (SKIPPED)**

`cargo test --lib` + clippy + build.

---

## Task 6: Final gates + carry-forward docs

- [ ] **Step 1: Consolidated gates**

Run: `cd kylins.client.backend && cargo test --lib && cargo clippy --all-targets -- -D warnings` + `cd kylins.client.crypto && cargo test && cargo clippy --all-targets -- -D warnings`. All green.

- [ ] **Step 2: Document carry-forwards in the report + ledger**

G6 owns: frontend `threadStore.selectThread` wiring (invoke `crypto_open_message` for crypto-marked messages), CryptoBadge receive states, TrustDialog, decrypt-failure panel, KeyManager "Trusted CAs" UI (insert CA roots via `db_upsert_crypto_key` key_type='cert'). G7: Thunderbird interop (incl. the `cms_build.rs:65-68` eContent double-wrap investigation). The `clear-signed multipart/signed` receive path may need a small orchestrator addition if G6 surfaces it (the `smime.p7s` attachment path).

- [ ] **Step 3: Commit (SKIPPED — user controls git)**

---

## Carry-forwards (from this plan → later Phase 1b plans)

- **G6 — frontend:** `threadStore.selectThread` → `crypto_open_message` for crypto-marked messages; granular CryptoBadge (SignatureState), TrustDialog (writes `trust_decisions` → re-`open_crypto_message`), decrypt-failure panel, session plaintext cache, KeyManager "Trusted CAs" section.
- **G7 — Thunderbird interop:** our-signs→Thunderbird-verifies (cms_build.rs eContent double-wrap) + Thunderbird-signs→Kylins-verifies (real CA-issued chain); cross-impl kari decrypt.
- **Hardening:** `spawn_blocking` for the cert-chain work if a benchmark shows it blocks; `extract_intermediates` + `open_crypto_message` for `multipart/signed` clear-signed (the `smime.p7s` attachment path); CRL `nextUpdate` parsing in the fetcher (currently 24h transport TTL).

## Self-review

1. **Spec coverage:** §6.1 `open_crypto_message` = Task 3; §6.2 ciphertext persist = Task 1; §6.3 send-side `validate_recipient_certs` = Task 5; §6.4 commands + event = Task 4; trust-anchor resolver (§0.7) = Task 2; CRL wiring + reqwest timeout (G4 landmine #1) = Task 3; `validate_recipient_certs` intermediates (G4 landmine #2) = Task 5. All covered.
2. **Placeholders:** the `todo!()`s in Task 2/3 are deliberate implementer-resolution points (the `mail_parser` raw-part API, the `x509-parser` CDP API, the `CertificateSet` iteration) — the implementer reads the named source to resolve them; the test contracts are concrete. No vague "add error handling."
3. **Type consistency:** `OpenCryptoResult`, `list_trust_anchor_certs`, `extract_intermediates`, `CryptoResultEvent` named consistently across tasks + the Interfaces block. `from_address` (not from_email) used consistently. `SmimeBackend::verify_with_context` signature matches G4's (committed).
