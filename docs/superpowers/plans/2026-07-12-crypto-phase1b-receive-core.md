# Crypto Phase 1b Plan 1 — S/MIME Receive Crypto Core (Detection + Decrypt + Verify) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deliver the S/MIME receive crypto core — populate the dormant `is_encrypted`/`is_signed` detection flags on inbound mail, and turn the `SmimeBackend::decrypt` / `SmimeBackend::verify` `NotImplemented` stubs into real, unit-tested CMS decrypt (ktri RSA + kari ECC) and signature verify (ECDSA-P256).

**Architecture:** This is **Phase 1b Plan 1 of N** (per the spec's §10 decomposition). It covers the spec's **G1 (schema + detection), G2 (CMS decrypt), G3 (CMS verify — signature check)**. It is deliberately free of any `pkix-chain` dependency: cert-chain validation, CRL, the backend `open_crypto_message` orchestrator, the frontend UI, and Thunderbird interop are subsequent plans (G4–G7). After this plan: inbound IMAP mail is flagged encrypted/signed, and `crypto-smime` can decrypt what its own `build_enveloped_data` produced (RSA + ECC) and verify what its own `build_signed_data` produced — proven by round-trip unit tests.

**Tech Stack:** Rust; `crypto-smime` + `crypto-core` (path crates); vendored `cms` (`kylins.client.crypto/vendor/cms`, `features=["builder"]` — parsing is via derived `der::Decode`, no extra feature); `x509-cert 0.3`, `der 0.8`, `spki 0.8`, `p256 0.14`, `rsa 0.10.0-rc.18`, `sha2 0.11`, `aes 0.9`, `cbc 0.2`, `aes-kw 0.3`, `cipher 0.5` (dev). Backend: `sqlx 0.8` (sqlite), `mail-parser`. Spec: `docs/superpowers/specs/2026-07-12-crypto-phase1b-smime-receive-design.md`.

## Global Constraints

- **User controls git — DO NOT COMMIT.** The plan's "commit" steps are skipped (per the project's standing rule). Implementers leave changes staged/uncommitted in the working tree for the user to commit. Controller review still runs per task.
- **SDD workflow:** fresh implementer subagent per task + controller review + ledger entry (matches the send-side Plans 1/2/2b/4a/4b rhythm).
- **Gates (every task):** `cargo test --lib` green for the touched crate(s); `cargo clippy --all-targets -- -D warnings` clean; for backend tasks also `cargo build` clean. Run from the relevant workspace: `kylins.client.crypto/` for crypto-smime/core, `kylins.client.backend/` for backend.
- **No new crypto deps this plan.** `pkix-*`, `p384`, etc. arrive in G4. This plan uses only what's already in `kylins.client.crypto/smime/Cargo.toml`.
- **Private-key hygiene:** private PKCS#8 bytes are read via `crypto_core::secret::expose_bytes(...)` and wrapped in `zeroize::Zeroizing::new(...)` so clones are wiped on drop (exactly as the send-side `sign`/`encrypt` do at `smime/src/lib.rs:106-110, 167-171`). Private material never crosses function boundaries except as the CMS plaintext/signature output.
- **Naming/format:** DB timestamps use `strftime('%s','now')` (string epoch seconds) — matches the existing `crypto_keys`/`trust_decisions` modules, NOT `unixepoch()`. Rust→frontend serde is camelCase.
- **Scope discipline:** G3 implements ECDSA-P256 CMS signature verify only (the algorithm our own `build_signed_data` produces, so it is fully round-trip-testable). RSA / RSA-PSS / ECDSA-P384 CMS verify arms are a documented carry-forward to G4 (which adds `p384` anyway and needs them for Thunderbird interop). Do NOT add them speculatively here.

## File Structure

**Create:**
- `kylins.client.backend/migrations/20260712000001_crypto_receive.sql` — `message_crypto_results`, `crl_cache`, `message_bodies.body_mime_ciphertext`.
- `kylins.client.backend/src/db/message_crypto_results.rs` — `MessageCryptoResultRow` + upsert/get helpers.
- `kylins.client.backend/src/db/crl_cache.rs` — `CrlCacheRow` + upsert/get/prune helpers.
- `kylins.client.crypto/smime/src/cms_parse.rs` — `parse_enveloped_data`, `decrypt_enveloped`, `parse_signed_data`, `verify_signed`.

**Modify:**
- `kylins.client.backend/src/db/mod.rs` — register the two new modules.
- `kylins.client.backend/src/db/message_bodies.rs` — `set_message_ciphertext` / `get_message_ciphertext`.
- `kylins.client.backend/src/db/messages.rs` — `upsert_message` binds `is_encrypted`/`is_signed` from `RemoteMessage.crypto_kind` and adds them to the `ON CONFLICT DO UPDATE` set.
- `kylins.client.backend/src/sync_engine/mod.rs` — `RemoteMessage` gains `crypto_kind: Option<CryptoKind>` + the `CryptoKind` enum.
- `kylins.client.backend/src/sync_engine/imap_source.rs` — `imap_message_to_remote` derives `crypto_kind` from the top-level Content-Type.
- `kylins.client.backend/src/mail/imap/client.rs` — add `CONTENT-TYPE` to `SYNC_FETCH_QUERY` + update its test.
- `kylins.client.crypto/smime/src/lib.rs` — `mod cms_parse;` + replace the `decrypt`/`verify` stubs.

**Test files:** crypto-smime tests live inline in `cms_parse.rs`'s `#[cfg(test)] mod tests` (mirror `cms_build.rs`'s test module). Backend db tests live inline in each `db/*.rs` module's `#[cfg(test)] mod tests` (mirror `db/crypto_keys.rs`'s test-module pool setup).

---

## Interfaces (cross-task contract — implementers read this)

- **`CryptoKind`** (defined Task 1, in `sync_engine/mod.rs`): `pub enum CryptoKind { Encrypted, Signed, EncryptedSigned }` with `pub fn is_encrypted(&self) -> bool` and `pub fn is_signed(&self) -> bool`. `RemoteMessage.crypto_kind: Option<CryptoKind>`.
- **`db::message_bodies`** (Task 1): `pub async fn set_message_ciphertext(pool: &SqlitePool, account_id: &str, message_id: &str, ciphertext: &[u8]) -> Result<(), String>` and `pub async fn get_message_ciphertext(pool: &SqlitePool, account_id: &str, message_id: &str) -> Result<Option<Vec<u8>>, String>`.
- **`cms_parse::decrypt_enveloped`** (Task 2): `pub(crate) fn decrypt_enveloped(enveloped_der: &[u8], recipient_cert_der: &[u8], recipient_priv_pkcs8_der: &[u8]) -> crypto_core::Result<Vec<u8>>` — returns the inner plaintext MIME bytes.
- **`cms_parse::verify_signed`** (Task 3): `pub(crate) fn verify_signed(signed_data_der: &[u8], covered_content: Option<&[u8]>) -> crypto_core::Result<CmsSigCheck>` where `CmsSigCheck { sig_ok: bool, signer_cert_der: Option<Vec<u8>>, signer_fingerprint: Option<String> }`. `covered_content = None` means the SignedData encapsulates its content (read `eContent`); `Some(bytes)` means detached (use the caller-supplied content).

---

## Task 1: Schema + receive detection (G1)

**Files:**
- Create: `kylins.client.backend/migrations/20260712000001_crypto_receive.sql`
- Create: `kylins.client.backend/src/db/message_crypto_results.rs`
- Create: `kylins.client.backend/src/db/crl_cache.rs`
- Modify: `kylins.client.backend/src/db/mod.rs`
- Modify: `kylins.client.backend/src/db/message_bodies.rs`
- Modify: `kylins.client.backend/src/db/messages.rs:406-448` (upsert bind sites)
- Modify: `kylins.client.backend/src/sync_engine/mod.rs:94-121` (RemoteMessage)
- Modify: `kylins.client.backend/src/sync_engine/imap_source.rs:221-249` (imap_message_to_remote)
- Modify: `kylins.client.backend/src/mail/imap/client.rs:25-28` (SYNC_FETCH_QUERY) + `:2934-2948` (its test)

**Interfaces:**
- Consumes: the existing `SqlitePool` + sqlx::migrate runner; `mail_parser::Message` headers (already used in `imap_message_to_remote`).
- Produces: `CryptoKind` enum; `RemoteMessage.crypto_kind`; `db::message_crypto_results` / `db::crl_cache` / `db::message_bodies::{set,get}_message_ciphertext`; populated `is_encrypted`/`is_signed` on inbound rows.

- [ ] **Step 1: Write the migration**

Create `kylins.client.backend/migrations/20260712000001_crypto_receive.sql`:

```sql
-- Per-message crypto verification/decryption result (one row per message).
CREATE TABLE IF NOT EXISTS message_crypto_results (
    account_id         TEXT NOT NULL,
    message_id         TEXT NOT NULL,
    crypto_kind        TEXT NOT NULL CHECK(crypto_kind IN ('encrypted','signed','encrypted-signed')),
    decrypt_state      TEXT NOT NULL CHECK(decrypt_state IN ('ok','no-key','failed','n/a')),
    signature_state    TEXT NOT NULL CHECK(signature_state IN
                          ('not-signed','valid-verified','valid-unverified','invalid','unknown-key','mismatch')),
    signer_fingerprint TEXT,
    signer_email       TEXT,
    chain_valid        INTEGER,
    revocation_state   TEXT NOT NULL DEFAULT 'unchecked'
                        CHECK(revocation_state IN ('good','revoked','unchecked')),
    verified_at        TEXT NOT NULL,
    PRIMARY KEY (account_id, message_id),
    FOREIGN KEY (account_id, message_id) REFERENCES messages(account_id, id) ON DELETE CASCADE
);

-- CRL cache (keyed by distribution-point URL). Populated by G4; table lands here.
CREATE TABLE IF NOT EXISTS crl_cache (
    crl_url     TEXT PRIMARY KEY,
    crl_der     BLOB NOT NULL,
    issuer_dn   TEXT,
    next_update TEXT,
    fetched_at  TEXT NOT NULL
);

-- Raw CMS payload for encrypted / opaque-signed mail. Plaintext is NEVER persisted.
ALTER TABLE message_bodies ADD COLUMN body_mime_ciphertext BLOB;
```

- [ ] **Step 2: Register modules + verify the build picks up the migration**

In `kylins.client.backend/src/db/mod.rs`, add (next to the existing `mod crypto_keys;` / `mod trust_decisions;` lines):

```rust
pub mod crl_cache;
pub mod message_crypto_results;
```

Run: `cd kylins.client.backend && cargo build`
Expected: builds clean (sqlx::migrate! macro picks up the new `.sql` at compile time; no DB run yet).

- [ ] **Step 3: Write the `db::message_bodies` ciphertext helpers (failing test first)**

In `kylins.client.backend/src/db/message_bodies.rs`, add a test (mirror the existing test-module pool setup in this file or `db/crypto_keys.rs`):

```rust
#[cfg(test)]
mod ciphertext_tests {
    use super::*;
    use crate::db::message_bodies::set_message_ciphertext; // adjust if test lives in same mod

    #[sqlx::test]
    async fn set_and_get_message_ciphertext_round_trips(pool: sqlx::SqlitePool) {
        // Seed a messages row the FK + existing body row require (mirror the
        // setup used by set_message_body's test in this file: insert account,
        // thread, message, then a message_bodies row).
        let account_id = "acct";
        let message_id = "msg-1";
        seed_message(&pool, account_id, message_id).await;

        let blob = b"application/pkcs7-mime raw bytes here";
        set_message_ciphertext(&pool, account_id, message_id, blob)
            .await
            .unwrap();

        let got = get_message_ciphertext(&pool, account_id, message_id)
            .await
            .unwrap()
            .expect("row present");
        assert_eq!(got, blob);
    }
}
```

Run: `cd kylins.client.backend && cargo test --lib message_bodies::ciphertext_tests`
Expected: FAIL — `set_message_ciphertext` / `get_message_ciphertext` not defined.

- [ ] **Step 4: Implement the ciphertext helpers**

In `kylins.client.backend/src/db/message_bodies.rs`, add (mirror the style of the existing `set_message_body` / `get_message_body`):

```rust
/// Persist the raw CMS payload (`smime.p7m`/`p7s` body) for an encrypted or
/// opaque-signed message. Plaintext is NEVER written via this path.
pub async fn set_message_ciphertext(
    pool: &sqlx::SqlitePool,
    account_id: &str,
    message_id: &str,
    ciphertext: &[u8],
) -> Result<(), String> {
    sqlx::query(
        "UPDATE message_bodies SET body_mime_ciphertext = ? WHERE account_id = ? AND message_id = ?",
    )
    .bind(ciphertext)
    .bind(account_id)
    .bind(message_id)
    .execute(pool)
    .await
    .map_err(|e| e.to_string())?;
    Ok(())
}

/// Read the cached raw CMS payload, if any.
pub async fn get_message_ciphertext(
    pool: &sqlx::SqlitePool,
    account_id: &str,
    message_id: &str,
) -> Result<Option<Vec<u8>>, String> {
    let row: Option<(Option<Vec<u8>>,)> = sqlx::query_as(
        "SELECT body_mime_ciphertext FROM message_bodies WHERE account_id = ? AND message_id = ?",
    )
    .bind(account_id)
    .bind(message_id)
    .fetch_optional(pool)
    .await
    .map_err(|e| e.to_string())?;
    Ok(row.and_then(|(b,)| b)
}
```

Run: `cd kylins.client.backend && cargo test --lib message_bodies::ciphertext_tests`
Expected: PASS.

- [ ] **Step 5: Write `db::message_crypto_results` + `db::crl_cache` (test-first, then impl)**

Create `kylins.client.backend/src/db/message_crypto_results.rs`. Mirror `db/crypto_keys.rs` structure (row struct camelCase serde, async helpers over `&SqlitePool`, inline `#[cfg(test)] mod tests` using the same pool-setup helper pattern). Public surface:

```rust
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MessageCryptoResultRow {
    pub account_id: String,
    pub message_id: String,
    pub crypto_kind: String,        // 'encrypted' | 'signed' | 'encrypted-signed'
    pub decrypt_state: String,      // 'ok' | 'no-key' | 'failed' | 'n/a'
    pub signature_state: String,    // 'not-signed' | 'valid-verified' | ...
    pub signer_fingerprint: Option<String>,
    pub signer_email: Option<String>,
    pub chain_valid: Option<i64>,
    pub revocation_state: String,   // 'good' | 'revoked' | 'unchecked'
    pub verified_at: String,
}

pub async fn upsert_message_crypto_result(
    pool: &sqlx::SqlitePool,
    row: &MessageCryptoResultRow,
) -> Result<(), String> {
    sqlx::query(
        "INSERT INTO message_crypto_results
            (account_id, message_id, crypto_kind, decrypt_state, signature_state,
             signer_fingerprint, signer_email, chain_valid, revocation_state, verified_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(account_id, message_id) DO UPDATE SET
            crypto_kind = excluded.crypto_kind,
            decrypt_state = excluded.decrypt_state,
            signature_state = excluded.signature_state,
            signer_fingerprint = excluded.signer_fingerprint,
            signer_email = excluded.signer_email,
            chain_valid = excluded.chain_valid,
            revocation_state = excluded.revocation_state,
            verified_at = excluded.verified_at",
    )
    .bind(&row.account_id)
    .bind(&row.message_id)
    .bind(&row.crypto_kind)
    .bind(&row.decrypt_state)
    .bind(&row.signature_state)
    .bind(&row.signer_fingerprint)
    .bind(&row.signer_email)
    .bind(row.chain_valid)
    .bind(&row.revocation_state)
    .bind(&row.verified_at)
    .execute(pool)
    .await
    .map_err(|e| e.to_string())?;
    Ok(())
}

pub async fn get_message_crypto_result(
    pool: &sqlx::SqlitePool,
    account_id: &str,
    message_id: &str,
) -> Result<Option<MessageCryptoResultRow>, String> {
    let row: Option<MessageCryptoResultRow> = sqlx::query_as(
        "SELECT account_id, message_id, crypto_kind, decrypt_state, signature_state,
                signer_fingerprint, signer_email, chain_valid, revocation_state, verified_at
         FROM message_crypto_results WHERE account_id = ? AND message_id = ?",
    )
    .bind(account_id)
    .bind(message_id)
    .fetch_optional(pool)
    .await
    .map_err(|e| e.to_string())?;
    Ok(row)
}
```

Add an inline test `upsert_then_get_round_trips` mirroring the ciphertext test's `seed_message` helper (FK requires a messages row). Write the test first, run it (fail — table empty / helper missing), then confirm the impl passes.

Create `kylins.client.backend/src/db/crl_cache.rs` analogously with `CrlCacheRow { crl_url, crl_der: Vec<u8>, issuer_dn: Option<String>, next_update: Option<String>, fetched_at }` + `upsert_crl`, `get_crl`, `prune_stale_crls(pool, now_epoch: &str)` (deletes rows whose `next_update < now`). This table is unused until G4; landing the module now keeps the migration paired with its module. Add one round-trip test for `upsert_crl`/`get_crl`.

Run: `cd kylins.client.backend && cargo test --lib message_crypto_results crl_cache`
Expected: PASS.

- [ ] **Step 6: Add `CryptoKind` + `RemoteMessage.crypto_kind`**

In `kylins.client.backend/src/sync_engine/mod.rs`, near the `RemoteMessage` struct (`:94-121`):

```rust
/// Detected S/MIME (Phase 1b) / future-PGP structure of an inbound message,
/// derived from its top-level Content-Type header.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CryptoKind {
    Encrypted,
    Signed,
    EncryptedSigned,
}

impl CryptoKind {
    pub fn is_encrypted(&self) -> bool {
        matches!(self, CryptoKind::Encrypted | CryptoKind::EncryptedSigned)
    }
    pub fn is_signed(&self) -> bool {
        matches!(self, CryptoKind::Signed | CryptoKind::EncryptedSigned)
    }
    /// For the dormant `messages.is_encrypted` / `is_signed` INTEGER columns.
    pub fn db_flags(&self) -> (i64, i64) {
        (self.is_encrypted() as i64, self.is_signed() as i64)
    }
}
```

Add `pub crypto_kind: Option<CryptoKind>` to `RemoteMessage`. Update every `RemoteMessage { ... }` literal to include the field (search the backend; the EAS mapper + test helpers construct literals — set them to `None` for EAS in this plan; the IMAP mapper is set in Step 8).

Run: `cd kylins.client.backend && cargo build`
Expected: compiler lists every `RemoteMessage` literal missing the field. Fix each (EAS + test fixtures → `crypto_kind: None`).

- [ ] **Step 7: Add `CONTENT-TYPE` to the headers-only FETCH query + fix its test**

In `kylins.client.backend/src/mail/imap/client.rs:25-28`, add `CONTENT-TYPE` to the `SYNC_FETCH_QUERY` field list (it is a `BODY.PEEK[HEADER.FIELDS (...)]` literal — append `CONTENT-TYPE` inside the parens).

The test at `client.rs:2934-2948` asserts the query selects header fields and does NOT contain `BODY.PEEK[]`. Adding `CONTENT-TYPE` does not violate either assertion, but if the test asserts the exact field list, update it to include `CONTENT-TYPE`. Read the test, update the expectation accordingly.

Run: `cd kylins.client.backend && cargo test --lib sync_fetch_query` (or the test's actual name — search for `SYNC_FETCH_QUERY` in the test module)
Expected: PASS.

- [ ] **Step 8: Derive `crypto_kind` in `imap_message_to_remote`**

In `kylins.client.backend/src/sync_engine/imap_source.rs:221-249` (`imap_message_to_remote`), after the existing field copies, derive the kind from the parsed message's top-level Content-Type. `mail_parser` exposes `message.content_type()`:

```rust
let crypto_kind = m.content_type()
    .and_then(|ct| {
        let ctype = ct.ctype().to_lowercase();
        let params = ct.params.clone().unwrap_or_default();
        let smime_type = params
            .iter()
            .find(|(k, _)| k.eq_ignore_ascii_case("smime-type"))
            .map(|(_, v)| v.to_lowercase())
            .unwrap_or_default();
        let is_encrypted = ctype == "application/pkcs7-mime"
            && smime_type.contains("enveloped-data");
        let is_signed = (ctype == "application/pkcs7-mime" && smime_type.contains("signed-data"))
            || ctype == "multipart/signed";
        match (is_encrypted, is_signed) {
            (true, true) => Some(CryptoKind::EncryptedSigned),
            (true, false) => Some(CryptoKind::Encrypted),
            (false, true) => Some(CryptoKind::Signed),
            (false, false) => None,
        }
    });
```

Set `crypto_kind` on the returned `RemoteMessage`. (Confirm the exact `ContentType` accessor names against the `mail-parser` version in `Cargo.lock` — `ct.ctype()` returns the main type string; `ct.params` is `Option<Vec<(String, String)>>`. If the installed version differs, adapt; the intent is: top-level type + `smime-type` parameter.)

- [ ] **Step 9: Bind `is_encrypted`/`is_signed` in `upsert_message`**

In `kylins.client.backend/src/db/messages.rs`, the threads INSERT (`:406-417`) and messages INSERT (`:433-448`) currently bind `NULL, 0, 0` for `classification_id, is_encrypted, is_signed`. Change the `0, 0` to bind from the `RemoteMessage`:

Compute once near the top of `upsert_message`:
```rust
let (is_encrypted, is_signed) = m
    .crypto_kind
    .map(|k| k.db_flags())
    .unwrap_or((0, 0));
```

Bind `is_encrypted` / `is_signed` (replacing the literal `0, 0`) in BOTH the threads and messages INSERTs.

**Also add them to the `ON CONFLICT DO UPDATE SET` clauses** for both tables (currently they are absent, so re-syncs never update the flags). Append `is_encrypted = excluded.is_encrypted, is_signed = excluded.is_signed` to each `ON CONFLICT ... DO UPDATE SET` list.

- [ ] **Step 10: Write a detection unit test**

Add a unit test (pure, no DB) for the Content-Type → `CryptoKind` derivation. Extract the derivation in Step 8 into a small pure helper `pub(crate) fn crypto_kind_from_content_type(ctype: &str, smime_type: &str) -> Option<CryptoKind>` and test it directly:

```rust
#[test]
fn crypto_kind_detection() {
    use super::CryptoKind;
    let kind = |c: &str, s: &str| super::crypto_kind_from_content_type(c, s);
    assert_eq!(kind("application/pkcs7-mime", "enveloped-data"), Some(CryptoKind::Encrypted));
    assert_eq!(kind("multipart/signed", ""), Some(CryptoKind::Signed));
    assert_eq!(kind("application/pkcs7-mime", "signed-data"), Some(CryptoKind::Signed));
    assert_eq!(kind("text/plain", ""), None);
    assert_eq!(kind("APPLICATION/PKCS7-MIME", "ENVELOPED-DATA"), Some(CryptoKind::Encrypted));
}
```

Run: `cd kylins.client.backend && cargo test --lib crypto_kind_detection`
Expected: PASS.

- [ ] **Step 11: Full backend gate**

Run: `cd kylins.client.backend && cargo test --lib && cargo clippy --all-targets -- -D warnings`
Expected: all green. (lib count rises by the new db + detection tests.)

- [ ] **Step 12: Commit (SKIPPED — user controls git)**

Leave changes uncommitted. Controller review runs; ledger entry added.

---

## Task 2: CMS decrypt — `SmimeBackend::decrypt` (G2)

**Files:**
- Create: `kylins.client.crypto/smime/src/cms_parse.rs`
- Modify: `kylins.client.crypto/smime/src/lib.rs:145-147` (decrypt impl) + add `mod cms_parse;`

**Interfaces:**
- Consumes: `DecryptOp { envelope: &EncryptedEnvelope, decryption_key: KeyHandleRef }`; the send-side `cms_build::build_enveloped_data` output (for the round-trip test); the keystore's `StoredKey { public_data: cert DER, private_data: Option<SecretBox> }`.
- Produces: `cms_parse::decrypt_enveloped(...)`; a real `SmimeBackend::decrypt` returning `DecryptedPayload { standard: Smime, parts: vec![Part{ id:"body", kind:Body, data: plaintext }] }`.

- [ ] **Step 1: Write the failing decrypt round-trip test (RSA / ktri)**

Create `kylins.client.crypto/smime/src/cms_parse.rs` with a test module that builds an EnvelopedData via the existing `cms_build::build_enveloped_data` and asserts the new `decrypt_enveloped` recovers the plaintext. First write only enough file to compile + the test:

```rust
//! Pure CMS parsers for S/MIME receive (Plan 1b / Phase 1b Plan 1).
//!
//! Mirror of `cms_build` in the receive direction. Hold no state, do no I/O,
//! never touch the keystore.

use crypto_core::{CryptoError, Result};
use der::Decode;

pub(crate) struct CmsSigCheck {
    pub sig_ok: bool,
    pub signer_cert_der: Option<Vec<u8>>,
    pub signer_fingerprint: Option<String>,
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::cms_build::{build_enveloped_data, recipient_input_from_cert};
    // RSA key + self-signed cert fixture: generate with `openssl` OR reuse a
    // test helper already present in cms_build.rs's tests (it builds RSA
    // fixtures for the send-side round-trip — read cms_build.rs:350-411 and
    // reuse the same RSA cert/key setup function).

    #[test]
    fn decrypt_round_trips_rsa_recipient() {
        let (cert_der, priv_pkcs8) = rsa_test_cert_and_key(); // reuse cms_build test helper
        let plaintext = b"hello S/MIME RSA";
        let recip = recipient_input_from_cert(&cert_der).unwrap();
        let enveloped_der = build_enveloped_data(plaintext, &[recip]).unwrap();

        let recovered = decrypt_enveloped(&enveloped_der, &cert_der, &priv_pkcs8).unwrap();
        assert_eq!(recovered, plaintext);
    }
}
```

Run: `cd kylins.client.crypto && cargo test -p crypto-smime decrypt_round_trips_rsa_recipient`
Expected: FAIL — `decrypt_enveloped` not defined.

- [ ] **Step 2: Implement `decrypt_enveloped` (ktri RSA path)**

Add to `cms_parse.rs`. Mirror the parse idiom from the vendored cms tests (`ContentInfo::from_der` → `ci.content.to_der()` → `EnvelopedData::from_der`):

```rust
use cms::content_info::ContentInfo;
use cms::enveloped_data::EnvelopedData;
use der::Encode;

pub(crate) fn decrypt_enveloped(
    enveloped_der: &[u8],
    recipient_cert_der: &[u8],
    recipient_priv_pkcs8_der: &[u8],
) -> Result<Vec<u8>> {
    let ci = ContentInfo::from_der(enveloped_der)
        .map_err(|e| cms_err("parse ContentInfo", e))?;
    let inner = ci.content.to_der().map_err(|e| cms_err("re-derive content", e))?;
    let env = EnvelopedData::from_der(&inner)
        .map_err(|e| cms_err("parse EnvelopedData", e))?;

    // Parse our cert to match its IssuerAndSerialNumber against recipient infos.
    let our_cert = <x509_cert::Certificate as Decode>::from_der(recipient_cert_der)
        .map_err(|e| cms_err("parse recipient cert", e))?;
    let our_iasn = cms::cert::IssuerAndSerialNumber {
        issuer: our_cert.tbs_certificate().issuer().clone(),
        serial_number: our_cert.tbs_certificate().serial_number().clone(),
    };

    // The vendored cms exposes recip_infos as a SET OF RecipientInfo (an enum:
    // Ktri / Kari / Kekri / Pwri / Ori). Iterate, find our recipient, unwrap CEK.
    let cek = find_and_unwrap_cek(&env.recip_infos.0, &our_iasn, recipient_priv_pkcs8_der)?;

    // AES-CBC decrypt the encrypted content using IV from content_enc_alg.parameters.
    let eci = env.encrypted_content_info;
    let iv = parse_aes_cbc_iv(&eci.content_enc_alg)?;
    let enc = eci.encrypted_content.as_ref().ok_or_else(|| {
        CryptoError::Malformed("EnvelopedData: missing encrypted_content".into())
    })?;
    aes_cbc_decrypt(&cek, iv, enc)
}
```

Implement the helpers `find_and_unwrap_cek`, `parse_aes_cbc_iv`, `aes_cbc_decrypt`, and `cms_err` (copy `cms_err` from `cms_build.rs:30-32`). For `find_and_unwrap_cek`:
- Iterate `RecipientInfo` variants; on `Ktri(ktri)` where `ktri.rid` matches `IssuerAndSerialNumber(our_iasn)` → RSA-unwrap: parse the private key with `rsa::pkcs8::DecodePrivateKey::from_pkcs8_der`, build `rsa::pkcs1v15::DecryptingKey`, call `.decrypt(ktri.enc_key.as_bytes())` → CEK. (Mirror the send-side test `build_enveloped_data_round_trips_rsa_recipient` at `cms_build.rs:350-411`, which already does exactly this RSA unwrap + AES-CBC decrypt — reuse its structure.)
- `parse_aes_cbc_iv`: `content_enc_alg.parameters` is `Option<Any>`; decode as `der::asn1::OctetString` → 16-byte IV for AES-128/256-CBC. The algorithm OID tells AES key size (2.16.840.1.101.3.4.1.42 = AES-128-CBC, .46 = AES-256-CBC).
- `aes_cbc_decrypt`: `cbc::Decryptor::<aes::Aes128>::new(cek.into(), iv.into()).decrypt_padded_vec::<cipher::block_padding::Pkcs7>(enc)` (use `cipher::BlockModeDecrypt`); pick Aes128 vs Aes256 by the OID. `cipher` is already a dev-dependency of crypto-smime.

Read `cms_build.rs:350-411` and copy its proven RSA-unwrap + AES-CBC-decrypt logic verbatim into `find_and_unwrap_cek` / `aes_cbc_decrypt` — that test already round-trips the build output, so its decrypt code is exactly what `decrypt_enveloped` needs (extract it from the test into the helper).

Run: `cd kylins.client.crypto && cargo test -p crypto-smime decrypt_round_trips_rsa_recipient`
Expected: PASS.

- [ ] **Step 3: Add the kari (ECC) round-trip test (failing)**

Append to `cms_parse.rs` tests:

```rust
    #[test]
    fn decrypt_round_trips_ecc_recipient() {
        let (cert_der, priv_pkcs8) = p256_test_cert_and_key(); // reuse cms_build ECC fixture
        let plaintext = b"hello S/MIME ECC kari";
        let recip = recipient_input_from_cert(&cert_der).unwrap();
        let enveloped_der = build_enveloped_data(plaintext, &[recip]).unwrap();

        let recovered = decrypt_enveloped(&enveloped_der, &cert_der, &priv_pkcs8).unwrap();
        assert_eq!(recovered, plaintext);
    }
```

Run: `cd kylins.client.crypto && cargo test -p crypto-smime decrypt_round_trips_ecc_recipient`
Expected: FAIL — kari arm not implemented (no Ktri matches an ECC recipient).

- [ ] **Step 4: Implement the kari (ECC) decrypt arm**

Extend `find_and_unwrap_cek` to handle `Kari(kari)`. This is the **fresh** code (no upstream template). Per RFC 5753 + mirroring the build-side `KeyAgreeRecipientInfoBuilder<NistP256, DhSinglePassStdDhKdf<Sha256>, AesKw<Aes192>, Aes128>` choices in `cms_build.rs`:

1. Recover the originator's ephemeral ECDH public key from `kari.originator` (`OriginatorIdentifierOrKey::OriginatorKey(KeyAgreePublicKey::Ecdh(...) → an EC point)`). Parse it into a `p256::PublicKey` via `p256::PublicKey::from_sec1_point(...)` or `DecodePublicKey::from_public_key_der`.
2. Load our private key: `p256::SecretKey::from_pkcs8_der(recipient_priv_pkcs8_der)`.
3. ECDH: `p256::ecdh::diffie_hellman(our_secret, originator_public)` → shared `SharedSecret`.
4. KDF: `DhSinglePassStdDhKdf::<Sha256>::new(sha2::Sha256, 192 / 8, ...)` over the shared secret + the `kari.key_enc_alg.algorithm` (AES-192-KW = OID 2.16.840.1.101.3.4.1.21) → 192-bit KEK. Use the `kari` recipient's `key_identifier`/user keying material as the KDF `ukm` if present.
5. AES-192-KW unwrap: `aes_kw::Aes192::new(kek.into())` then `.unwrap(kari.encrypted_key.as_bytes(), None)` → CEK (AES-128 key, per the build choice `Aes128` content cipher).
6. Return the CEK; the existing `aes_cbc_decrypt` then decrypts the content.

The exact `kari` field names (`originator`, `key_enc_alg`, `encrypted_key`, `recipient_identifier`) and the `OriginatorIdentifierOrKey` / `KeyAgreePublicKey` enum shapes live in the **vendored** cms source at `kylins.client.crypto/vendor/cms/src/enveloped_data.rs` — read it to resolve the precise accessors (it is local; no network needed). The KDF/AES-KW API (`elliptic_curve::ecdh::diffie_hellman`, `aes_kw::Kw`/`Aes192`) is on the existing dep line; confirm against the vendored cms's own kari BUILD test (`vendor/cms/tests/builder/kari.rs`) which exercises the same primitives.

Run: `cd kylins.client.crypto && cargo test -p crypto-smime decrypt_round_trips_ecc_recipient`
Expected: PASS.

- [ ] **Step 4b: Add a no-matching-recipient test**

```rust
    #[test]
    fn decrypt_no_matching_recipient_returns_error() {
        let (cert_a, _) = rsa_test_cert_and_key();
        let (cert_b, priv_b) = rsa_test_cert_and_key(); // different identity
        let recip = recipient_input_from_cert(&cert_a).unwrap();
        let enveloped_der = build_enveloped_data(b"x", &[recip]).unwrap();
        let err = decrypt_enveloped(&enveloped_der, &cert_b, &priv_b).unwrap_err();
        assert!(matches!(err, CryptoError::Malformed(_))); // "no matching recipient"
    }
```

Run: `cd kylins.client.crypto && cargo test -p crypto-smime decrypt_no_matching`
Expected: PASS.

- [ ] **Step 5: Wire `SmimeBackend::decrypt` to the helper**

In `kylins.client.crypto/smime/src/lib.rs`:
- Add `mod cms_parse;` near `mod cms_build;`.
- Replace the decrypt stub (`:145-147`):

```rust
async fn decrypt(&self, op: DecryptOp<'_>) -> crypto_core::Result<DecryptedPayload> {
    let single = op
        .envelope
        .parts
        .first()
        .ok_or_else(|| CryptoError::Malformed("decrypt: envelope has no parts".into()))?;
    let stored = self
        .keystore
        .get(&op.decryption_key.handle)
        .await?
        .ok_or_else(|| CryptoError::KeyNotFound(format!("decrypt: {:?}", op.decryption_key.handle)))?;
    let priv_box = stored.private_data.as_ref().ok_or_else(|| {
        CryptoError::Policy("decrypt: key has no private material".into())
    })?;
    let priv_der =
        zeroize::Zeroizing::new(crypto_core::secret::expose_bytes(priv_box).to_vec());
    let plaintext = cms_parse::decrypt_enveloped(&single.ciphertext, &stored.public_data, priv_der.as_slice())?;
    Ok(DecryptedPayload {
        standard: Standard::Smime,
        parts: vec![crypto_core::Part {
            id: crypto_core::PartId("body".into()),
            kind: crypto_core::PartKind::Body,
            data: plaintext,
        }],
    })
}
```

(Confirm `crypto_core::Part`/`PartId`/`PartKind` field names against `crypto-core/src/envelope.rs` — the send-side `encrypt` constructs `PartId("body".into())` / `PartKind::Body`, so the same construction applies here.)

Run: `cd kylins.client.crypto && cargo test -p crypto-smime && cargo clippy --all-targets -- -D warnings`
Expected: all green; the 2 decrypt round-trip tests pass via the public trait if desired (optional higher-level test), and the `cms_parse` unit tests pass.

- [ ] **Step 6: Commit (SKIPPED — user controls git)**

Leave uncommitted. Controller review + ledger entry.

---

## Task 3: CMS verify — `SmimeBackend::verify` signature check (G3)

**Files:**
- Modify: `kylins.client.crypto/smime/src/cms_parse.rs` (add `parse_signed_data`, `verify_signed`)
- Modify: `kylins.client.crypto/smime/src/lib.rs:191-193` (verify impl)

**Interfaces:**
- Consumes: `VerifyOp { signed: &SignedEnvelope }` where `signed.signature.signature` is the DER `SignedData` (ContentInfo) and `signed.payload` is the covered content; the send-side `cms_build::build_signed_data` output.
- Produces: `cms_parse::verify_signed(...) -> Result<CmsSigCheck>`; a real `SmimeBackend::verify` returning a **pre-chain** `VerificationResult` (sig OK → `ValidUnverified`; sig fail → `Invalid`; no signer cert → `UnknownKey`). Chain/trust refinement is G4.

- [ ] **Step 1: Write the failing encapsulated-signature verify test**

Append to `cms_parse.rs` tests:

```rust
    #[test]
    fn verify_round_trips_encapsulated_signed_data() {
        let (cert_der, priv_pkcs8) = p256_test_cert_and_key();
        let payload = b"signed payload";
        let signed_data_der =
            crate::cms_build::build_signed_data(payload, /*detached=*/ false, &cert_der, &priv_pkcs8)
                .unwrap();
        let check = verify_signed(&signed_data_der, /*covered_content=*/ None).unwrap();
        assert!(check.sig_ok);
        assert!(check.signer_cert_der.is_some());
        assert!(check.signer_fingerprint.is_some());
    }
```

Run: `cd kylins.client.crypto && cargo test -p crypto-smime verify_round_trips_encapsulated`
Expected: FAIL — `verify_signed` not defined.

- [ ] **Step 2: Implement `verify_signed` (encapsulated path)**

Add to `cms_parse.rs`. Mirror the send-side test `build_signed_data_produces_verifiable_signed_data` (`cms_build.rs:267-314`), which already re-parses SignedData, recovers the ECDSA `VerifyingKey` from the signer cert's SPKI, and verifies the signature over DER-encoded `signed_attrs` — extract that proven logic into the helper:

```rust
use cms::signed_data::{SignedData, SignerIdentifier};
use sha2::{Digest, Sha256};

const ID_MESSAGE_DIGEST: const_oid::ObjectIdentifier =
    const_oid::ObjectIdentifier::new_unwrap("1.2.840.113549.1.9.4");

pub(crate) fn verify_signed(
    signed_data_der: &[u8],
    covered_content: Option<&[u8]>,
) -> Result<CmsSigCheck> {
    let ci = ContentInfo::from_der(signed_data_der)
        .map_err(|e| cms_err("parse ContentInfo", e))?;
    let inner = ci.content.to_der().map_err(|e| cms_err("re-derive content", e))?;
    let sd = SignedData::from_der(&inner)
        .map_err(|e| cms_err("parse SignedData", e))?;

    // Encapsulated content (detached ⇒ caller supplies covered_content).
    let content_bytes: Vec<u8> = match covered_content {
        Some(b) => b.to_vec(),
        None => sd.encap_content_info
            .econtent
            .as_ref()
            .map(|any| any.value().to_vec())
            .unwrap_or_default(),
    };

    let signer_info = sd.signer_infos.0.first().ok_or_else(|| {
        CryptoError::Malformed("SignedData: no signer infos".into())
    })?;

    // Locate the signer cert in the SignedData certificates set by SignerIdentifier.
    let signer_cert_der = locate_signer_cert(&sd.certificates, &signer_info.sid)?;
    let signer_cert = <x509_cert::Certificate as Decode>::from_der(&signer_cert_der)
        .map_err(|e| cms_err("parse signer cert", e))?;
    let fp = fingerprint_of_spki(&signer_cert)?;

    // 1. messageDigest signed attribute must equal SHA-256(content).
    let signed_attrs = signer_info.signed_attrs.as_ref().ok_or_else(|| {
        CryptoError::Malformed("SignedData: missing signed_attrs".into())
    })?;
    let stored_digest = find_attr_value(signed_attrs, &ID_MESSAGE_DIGEST)
        .ok_or_else(|| CryptoError::Malformed("missing messageDigest attr".into()))?;
    let computed_digest = Sha256::digest(&content_bytes);
    if stored_digest != computed_digest.as_slice() {
        return Ok(CmsSigCheck { sig_ok: false, signer_cert_der: Some(signer_cert_der), signer_fingerprint: Some(fp) });
    }

    // 2. Verify encryptedDigest over the DER encoding of signed_attrs (IMPLICIT
    //    [0] tag — re-tag 0xA0 before hashing, per RFC 5652 §5.4). ECDSA-P256.
    let signed_attrs_der = reencode_as_implicit_set(signed_attrs)?;
    let sig_ok = verify_ecdsa_p256_signature(
        &signer_cert,
        &signed_attrs_der,
        signer_info.signature.as_bytes(),
    )?;

    Ok(CmsSigCheck { sig_ok, signer_cert_der: Some(signer_cert_der), signer_fingerprint: Some(fp) })
}
```

Implement the helpers (`locate_signer_cert`, `fingerprint_of_spki`, `find_attr_value`, `reencode_as_implicit_set`, `verify_ecdsa_p256_signature`) by extracting + generalizing the proven logic from `cms_build.rs:267-314`:
- `verify_ecdsa_p256_signature`: recover `p256::ecdsa::VerifyingKey` from the cert SPKI (`p256::ecdsa::VerifyingKey::from_sec1_bytes(spki.subject_public_key)`), build `p256::ecdsa::Signature::from_der(sig)`, call `vk.verify(signed_attrs_der, &signature)`. `signer_info.digest_algorithm.algorithm` must be SHA-256 and `signer_info.signature_algorithm` ECDSA-with-SHA-256 — assert/return `sig_ok=false` otherwise.
- `fingerprint_of_spki`: SHA-1 of the cert's `subject_public_key_info` DER (RFC 5280 SKI method 1) hex-lower — reuse `cert.rs::to_hex_lower` and the existing fingerprint computation in `cert.rs` (the send side already computes this for `generate_key`).
- `reencode_as_implicit_set`: the `signed_attrs` field is parsed with its real tag; RFC 5652 §5.4 requires the signature to cover the IMPLICIT [0] SET encoding. The send-side test handles this — copy its approach.

Read `cms_build.rs:267-344` and port its verification logic; it is the canonical template.

Run: `cd kylins.client.crypto && cargo test -p crypto-smime verify_round_trips_encapsulated`
Expected: PASS.

- [ ] **Step 3: Add a detached-signature verify test + a tamper test**

```rust
    #[test]
    fn verify_round_trips_detached_signed_data() {
        let (cert_der, priv_pkcs8) = p256_test_cert_and_key();
        let payload = b"detached payload";
        let signed_data_der =
            crate::cms_build::build_signed_data(payload, /*detached=*/ true, &cert_der, &priv_pkcs8)
                .unwrap();
        let check = verify_signed(&signed_data_der, /*covered_content=*/ Some(payload)).unwrap();
        assert!(check.sig_ok);
    }

    #[test]
    fn verify_tampered_content_is_invalid() {
        let (cert_der, priv_pkcs8) = p256_test_cert_and_key();
        let signed_data_der =
            crate::cms_build::build_signed_data(b"original", false, &cert_der, &priv_pkcs8).unwrap();
        // Rebuild SignedData with encapsulated content swapped is complex; easier
        // path: flip a byte in the DER and expect parse-fail or sig_ok=false.
        let mut tampered = signed_data_der.clone();
        let last = tampered.len() - 1;
        tampered[last] ^= 0xFF;
        let res = verify_signed(&tampered, None);
        assert!(res.is_err() || !res.unwrap().sig_ok);
    }
```

Run: `cd kylins.client.crypto && cargo test -p crypto-smime verify_round_trips_detached verify_tampered`
Expected: PASS.

- [ ] **Step 4: Wire `SmimeBackend::verify` (pre-chain state mapping)**

Replace the verify stub in `smime/src/lib.rs:191-193`:

```rust
async fn verify(&self, op: VerifyOp<'_>) -> crypto_core::Result<VerificationResult> {
    let signed_data_der = &op.signed.signature.signature;
    let covered = Some(op.signed.payload.as_slice());
    let check = match cms_parse::verify_signed(signed_data_der, covered) {
        Ok(c) => c,
        Err(CryptoError::Malformed(msg)) if msg.contains("no signer cert") => {
            // No usable signer cert available to verify against.
            return Ok(VerificationResult { state: crypto_core::SignatureState::UnknownKey, signer: None });
        }
        Err(e) => return Err(e),
    };
    let state = if check.sig_ok {
        // Pre-chain: cryptographic sig OK, chain/trust assessment is G4.
        crypto_core::SignatureState::ValidUnverified
    } else {
        crypto_core::SignatureState::Invalid
    };
    let signer = check.signer_fingerprint.map(|fp| crypto_core::KeyHandleRef {
        handle: crypto_core::KeyHandle::Software(crypto_core::KeyId(format!("smime|{fp}"))),
        algorithm: "ECDSA-P256".into(),
    });
    Ok(VerificationResult { state, signer })
}
```

(Confirm the `KeyHandleRef`/`KeyHandle::Software(KeyId(...))` construction against `crypto-core/src/handle.rs` — the send side builds these the same way. If the `KeyId` encoding differs, match the send-side `encode_key_id` format `"{standard}|{fingerprint}"`.)

Run: `cd kylins.client.crypto && cargo test -p crypto-smime && cargo clippy --all-targets -- -D warnings`
Expected: all green.

- [ ] **Step 5: Cross-crate gate**

Run: `cd kylins.client.crypto && cargo test` (both crypto-core + crypto-smime; vendor excluded) and `cd kylins.client.backend && cargo build` (backend still compiles — it consumes crypto-smime).
Expected: crypto-core 17, crypto-smime (prior count + new decrypt/verify tests), backend builds clean.

- [ ] **Step 6: Commit (SKIPPED — user controls git)**

Leave uncommitted. Controller review + ledger entry.

---

## Carry-forwards (from this plan → later Phase 1b plans)

- **G4 — cert-chain + CRL:** `chain.rs` (pkix-chain + SmimeProfile + pkix-identity; custom `SignatureVerifier` adding RSA-PSS + P-384; signingTime; From↔SAN; CRL fetcher + `crl_cache` + pkix-revocation; hard/soft-fail; trust→SignatureState refinement of G3's pre-chain `ValidUnverified`; trust-anchor store). Adds deps `pkix-chain`, `pkix-profiles-cabf`, `pkix-identity`, `pkix-revocation`, `p384`.
- **CMS signature algorithms beyond ECDSA-P256** (RSA-PKCS1v15, RSA-PSS, ECDSA-P384) — added in `verify_signed`'s dispatch during G4 (needed for Thunderbird interop; p384 dep lands then).
- **G5 — backend orchestration:** `mail/crypto.rs::open_crypto_message`; `crypto_open_message` + `db_get_message_crypto_result` commands; ciphertext persist in `fetch_bodies_batch_on_session`; **send-side `apply_crypto` recipient-cert validation** (closes Plan 4a).
- **G6 — frontend receive UI; G7 — final gates + Thunderbird interop.**
- EAS receive-crypto (EAS body-fetch `nyi`); OCSP (skipped); encrypted-subject; P-521/Ed25519; bundled S/MIME CA roots; CRLite; pkix-* → certval migration.

## Self-review (run before handoff)

1. **Spec coverage:** G1 (schema+detection) = Task 1 ✓; G2 (decrypt) = Task 2 ✓; G3 (verify signature check) = Task 3 ✓. G4–G7 explicitly deferred to subsequent plans (listed above). Spec §3.1 pipeline steps 1–2 (detect + persist ciphertext) are Task 1; steps 3–4 (decrypt + verify) are Tasks 2–3. §4.1 decrypt = Task 2; §4.2 verify pre-chain = Task 3; §4.3 chain/CRL = G4 (deferred). §5 migration = Task 1 Step 1. §5.2 detection bind = Task 1 Steps 6–10.
2. **Placeholders:** test-fixture helpers (`rsa_test_cert_and_key`, `p256_test_cert_and_key`) are referenced by name with instructions to reuse the existing `cms_build.rs` test fixtures — not placeholders, they already exist in the send-side test module. Where exact cms/x509 accessor names need confirmation against the vendored source, the step says so explicitly and points to the file.
3. **Type consistency:** `decrypt_enveloped` / `verify_signed` / `CmsSigCheck` signatures match across the Interfaces section, Task 2, and Task 3. `CryptoKind` + `db_flags()` used consistently in Task 1 Steps 6/8/9. `set_message_ciphertext`/`get_message_ciphertext` consistent across Task 1 Steps 3–4.
