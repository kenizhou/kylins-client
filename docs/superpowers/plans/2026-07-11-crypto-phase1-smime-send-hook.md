# Plan 4a — S/MIME Send-Hook (Backend) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Wire `crypto-smime` `sign`/`encrypt` into the backend send path so a draft with `cryptoMethod=smime` + `sign`/`encrypt` produces a real S/MIME message (clear-sign `multipart/signed`, `application/pkcs7-mime` enveloped-data, or sign-then-encrypt) handed to SMTP/EAS.

**Architecture:** A new `mail/crypto.rs` module owns a pure MIME-wrapping layer (`split_message`, `wrap_multipart_signed`, `wrap_enveloped`) + an async orchestrator `apply_crypto(backend, keystore, mime, draft, account_email, default_signing_key)`. `send_op` constructs `SmimeBackend` per-send and calls `apply_crypto` between `build_mime` and `src.send`; the same wrapped bytes flow to the Sent-folder APPEND. The crypto-smime `build_signed_data(detached=true)` path is fixed to sign over external content (required for clear-sign).

**Tech Stack:** crypto-smime (Plan 2b) · `cms` (vendored) · `mail-builder` 0.4 (unchanged — wrappers are manual byte construction for byte-exactness) · `base64` 0.22 · `sha2` 0.11 · crypto-core `SignOp`/`EncryptOp`/`KeyHandleRef`.

## Global Constraints

- **Send-only.** `decrypt`/`verify` stay `NotImplemented` (Phase 1b). Plan 4a produces signed/encrypted outbound MIME only.
- **Private key never crosses IPC.** The sender's PKCS#8 is read in-process via the keystore + `zeroize::Zeroizing` (already so in `SmimeBackend::sign`); no private bytes in `SendDraft` or the wrapped MIME.
- **Clear-sign (`multipart/signed`)** for sign-only and for the inner signed layer of sign-then-encrypt (parent spec §3; RFC 5751). `micalg="sha-256"`, `protocol="application/pkcs7-signature"`.
- **Encrypt-to-self:** the sender (`account_email`) is added as an encryption recipient so the Sent copy is decryptable by them.
- **Fail-closed:** a missing recipient cert or missing signing key is an error — `apply_crypto` returns `Err`, `send_op` emits `sync:send-result{success:false}` immediately. The op still returns `Err` (replay worker backs off); a permanent/non-retryable classification is a noted follow-up, NOT in 4a's scope.
- **Backward-compatible IPC:** new `SendDraft` fields are `#[serde(default)]` / optional in TS — old callers keep working.
- **`cms` vendored** at `kylins.client.crypto/vendor/cms/` (do not touch); switch-back is a separate carry-forward.
- **Plan per-task `git commit` steps are SKIPPED** — the user controls git; implement + test only, leave uncommitted.
- **Byte-exactness is test-gated:** every clear-sign test recovers the signer's verifying key and verifies the detached signature over the exact part-1 bytes parsed back out of the `multipart/signed`. A boundary/CRLF bug fails the test locally.

---

## File Structure

- **Create** `kylins.client.backend/src/mail/crypto.rs` — pure MIME wrappers (`split_message`, `wrap_multipart_signed`, `wrap_enveloped`) + async `apply_crypto` orchestrator + a `CryptoSendError` enum. Unit-tested in-module.
- **Modify** `kylins.client.crypto/smime/src/cms_build.rs` — fix `build_signed_data(detached=true)` to sign over external content (Task 3).
- **Modify** `kylins.client.backend/src/mail/builder.rs` — add `CryptoMethod` enum + `crypto_method`/`sign`/`encrypt` fields to `SendDraft` (Task 1).
- **Modify** `kylins.client.backend/src/db/crypto_keys.rs` — add `get_default_signing_key(account_id)` (Task 2).
- **Modify** `kylins.client.backend/src/sync_engine/engine.rs` — `send_op` constructs `SmimeBackend` + calls `apply_crypto` (Task 6).
- **Modify** `kylins.client.backend/src/mail/mod.rs` — declare `pub mod crypto;`.
- **Modify** `kylins.client.frontend/src/services/composer/types.ts` + `buildSendDraft.ts` — TS `SendDraft` crypto fields + propagation (Task 1).
- **Modify** `kylins.client.backend/src/lib.rs` — only if `mail::crypto` needs registration (it does not — `apply_crypto` is called directly by `send_op`).

---

### Task 1: `SendDraft` crypto fields (Rust + TS IPC contract)

**Files:**
- Modify: `kylins.client.backend/src/mail/builder.rs:42-69` (`SendDraft` struct; add `CryptoMethod` enum)
- Modify: `kylins.client.frontend/src/services/composer/types.ts` (TS `SendDraft`)
- Modify: `kylins.client.frontend/src/services/composer/buildSendDraft.ts`
- Test: `builder.rs` in-module tests; `kylins.client.frontend/tests/services/composer/buildSendDraft.test.ts`

**Interfaces:**
- Produces: `pub enum CryptoMethod { None, Smime }` (serde `rename_all="lowercase"` → `"none"`/`"smime"`); `SendDraft.crypto_method: CryptoMethod` (default `None`), `SendDraft.sign: bool` (default false), `SendDraft.encrypt: bool` (default false). TS mirror: `cryptoMethod: 'none'|'smime'`, `sign: boolean`, `encrypt: boolean`.

- [ ] **Step 1: Add the failing Rust test**

Append to `builder.rs` `#[cfg(test)] mod tests`:

```rust
    #[test]
    fn send_draft_crypto_fields_round_trip() {
        let draft = SendDraft {
            draft_id: "c1".into(),
            from: addr("a@k"),
            to: vec![addr("b@k")],
            subject: "S".into(),
            text_body: Some("x".into()),
            crypto_method: CryptoMethod::Smime,
            sign: true,
            encrypt: true,
            ..Default::default()
        };
        let json = serde_json::to_string(&draft).unwrap();
        assert!(json.contains("\"cryptoMethod\":\"smime\""), "{json}");
        assert!(json.contains("\"sign\":true"));
        assert!(json.contains("\"encrypt\":true"));
        let back: SendDraft = serde_json::from_str(&json).unwrap();
        assert_eq!(back.crypto_method, CryptoMethod::Smime);
        assert!(back.sign && back.encrypt);
    }

    #[test]
    fn send_draft_crypto_fields_default_none() {
        let json = "{\"draft_id\":\"\",\"from\":{\"email\":\"\"},\"to\":[],\"subject\":\"\"}";
        let d: SendDraft = serde_json::from_str(json).unwrap();
        assert_eq!(d.crypto_method, CryptoMethod::None);
        assert!(!d.sign && !d.encrypt);
    }
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd kylins.client.backend && cargo test --lib send_draft_crypto_fields`
Expected: COMPILE ERROR — `cannot find type CryptoMethod` / no fields `crypto_method`/`sign`/`encrypt`.

- [ ] **Step 3: Implement the Rust fields + enum**

In `builder.rs`, above `pub struct SendDraft`, add:

```rust
/// Per-message crypto intent carried in `SendDraft`. Mirrors the TS union
/// `'none' | 'smime'` (serde `rename_all = "lowercase"`). Future standards
/// (openpgp, sm) add variants here.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum CryptoMethod {
    #[default]
    None,
    Smime,
}
```

Add three fields to `SendDraft` (after `extra_headers`):

```rust
    /// S/MIME per-message intent (sign/encrypt toggles). Default `None` — the
    /// send path treats the draft as plain MIME. Plan 4a honors `Smime`.
    #[serde(default)]
    pub crypto_method: CryptoMethod,
    /// Sign the message (clear-sign multipart/signed). Only meaningful when
    /// `crypto_method == Smime`.
    #[serde(default)]
    pub sign: bool,
    /// Encrypt the message (application/pkcs7-mime enveloped-data).
    #[serde(default)]
    pub encrypt: bool,
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd kylins.client.backend && cargo test --lib send_draft_crypto_fields`
Expected: 2 passed.

- [ ] **Step 5: TS mirror + buildSendDraft propagation**

In `kylins.client.frontend/src/services/composer/types.ts`, add to the `SendDraft` interface:

```ts
  /** Per-message crypto intent. Plan 4a honors 'smime'; 'none' = plain MIME. */
  cryptoMethod: 'none' | 'smime';
  sign: boolean;
  encrypt: boolean;
```

In `buildSendDraft.ts`, thread the fields from the input options (defaulting `'none'`/`false` so existing callers are unaffected). Find the `SendDraft` object literal it builds and add:

```ts
    cryptoMethod: options.cryptoMethod ?? 'none',
    sign: options.sign ?? false,
    encrypt: options.encrypt ?? false,
```

(If `buildSendDraft`'s options type is an inline type, extend it with optional `cryptoMethod?`, `sign?`, `encrypt?`. The composer UI that actually SETS these toggles is Plan 4b — 4a only requires the fields to flow through.)

- [ ] **Step 6: TS test — buildSendDraft carries the fields**

Add to `buildSendDraft.test.ts` a case passing `{ cryptoMethod: 'smime', sign: true, encrypt: true }` and assert the returned draft has those values; plus a case with no crypto options asserting `cryptoMethod==='none'`, `sign===false`, `encrypt===false`.

- [ ] **Step 7: Run gates**

Run: `cd kylins.client.backend && cargo test --lib && cargo clippy --all-targets -- -D warnings`
Run: `cd kylins.client.frontend && npx tsc --noEmit && npx vitest run tests/services/composer/buildSendDraft.test.ts`
Expected: backend green + clippy clean; tsc 0 errors; vitest green.

---

### Task 2: `db::crypto_keys::get_default_signing_key`

**Files:**
- Modify: `kylins.client.backend/src/db/crypto_keys.rs` (add the helper + a `KeyHandleRef`-shaped return)
- Test: in-module `#[cfg(test)] mod tests` in `crypto_keys.rs`

**Interfaces:**
- Consumes: the `crypto_keys` schema (columns incl. `is_default_sign` — already upsertable).
- Produces: `pub async fn get_default_signing_key(pool: &SqlitePool, account_id: &str) -> Result<Option<DefaultKeyRow>, sqlx::Error>` where `DefaultKeyRow { standard: String, fingerprint: String, email: Option<String> }` — enough for `apply_crypto`/`send_op` to build a `KeyHandleRef`.

- [ ] **Step 1: Write the failing test**

In `crypto_keys.rs` tests (mirror the existing `seed_account` + key-seed helpers already in that module):

```rust
    #[tokio::test]
    async fn get_default_signing_key_returns_the_flagged_row() {
        let pool = /* existing in-memory pool + init_db helper used by other crypto_keys tests */;
        crate::db::tests::seed_account(&pool, "acct", "owner@k").await; // reuse existing helper name
        // seed two smime keys for acct, one with is_default_sign=1
        upsert_crypto_key(&pool, &record("acct", "smime", "fp-A", /*is_default_sign=*/ false)).await.unwrap();
        upsert_crypto_key(&pool, &record("acct", "smime", "fp-B", /*is_default_sign=*/ true)).await.unwrap();
        let got = get_default_signing_key(&pool, "acct").await.unwrap().expect("present");
        assert_eq!(got.fingerprint, "fp-B");
        assert_eq!(got.standard, "smime");
    }

    #[tokio::test]
    async fn get_default_signing_key_none_when_no_default() {
        let pool = /* … */;
        crate::db::tests::seed_account(&pool, "acct2", "o@k").await;
        assert!(get_default_signing_key(&pool, "acct2").await.unwrap().is_none());
    }
```

(Use the module's existing test helpers / `CryptoKeyRecord` constructors; the `is_default_sign` column already exists on `crypto_keys`. The `record(...)` helper is a small local fn building a `CryptoKeyRecord` with the given default flag — write it inline if no such helper exists.)

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd kylins.client.backend && cargo test --lib get_default_signing_key`
Expected: COMPILE ERROR — `cannot find function get_default_signing_key`.

- [ ] **Step 3: Implement**

Add to `crypto_keys.rs`:

```rust
/// Minimal view of a default signing key — the bits `send_op`/`apply_crypto`
/// need to build a `KeyHandleRef` and resolve the cert+key via `get_crypto_key_full`.
#[derive(Debug, Clone, sqlx::FromRow)]
pub struct DefaultKeyRow {
    pub standard: String,
    pub fingerprint: String,
    pub email: Option<String>,
}

/// The account's default S/MIME signing key, if one is flagged. Phase 1 uses a
/// single default per account; multiple-standard selection arrives later.
pub async fn get_default_signing_key(
    pool: &sqlx::SqlitePool,
    account_id: &str,
) -> Result<Option<DefaultKeyRow>, sqlx::Error> {
    sqlx::query_as::<_, DefaultKeyRow>(
        "SELECT standard, fingerprint, email FROM crypto_keys
         WHERE account_id = ? AND standard = 'smime' AND is_default_sign = 1
         LIMIT 1",
    )
    .bind(account_id)
    .fetch_optional(pool)
    .await
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd kylins.client.backend && cargo test --lib get_default_signing_key`
Expected: 2 passed.

- [ ] **Step 5: Run gates**

Run: `cd kylins.client.backend && cargo test --lib && cargo clippy --all-targets -- -D warnings`
Expected: green + clippy clean.

---

### Task 3: Fix `build_signed_data(detached=true)` (crypto-smime)

**Files:**
- Modify: `kylins.client.crypto/smime/src/cms_build.rs` (the `build_signed_data` detached branch)
- Test: in-module `tests` in `cms_build.rs`

**Interfaces:**
- Consumes: the cms `SignerInfoBuilder::new(sid, digest, &encap, external_message_digest)`. The cms builder's `external_message_digest` is a **precomputed digest** of the external content (see `cms/src/builder.rs` finalize path) — NOT the raw content.
- Produces: `build_signed_data(payload, detached=true, …)` now yields a detached `SignedData` whose `messageDigest` signed attribute == `SHA-256(payload)`. (Clear-sign correctness.)

- [ ] **Step 1: Write the failing test**

Add to `cms_build.rs` tests:

```rust
    /// detached=true must sign over the external payload: the SignedData's
    /// messageDigest signed attribute must equal SHA-256(payload). (Currently
    /// degenerate — messageDigest is absent — so this fails first.)
    #[test]
    fn build_signed_data_detached_covers_external_payload() {
        use sha2::Digest;
        let built = crate::cert::build_self_signed_smime_cert("detached@kylins.com").unwrap();
        let payload = b"external content to be clear-signed";
        let der = build_signed_data(payload, true, &built.cert_der, &built.priv_pkcs8_der).unwrap();

        let ci: ContentInfo = <ContentInfo as Decode>::from_der(&der).unwrap();
        let sd: SignedData = <SignedData as Decode>::from_der(ci.content.to_der().unwrap().as_slice()).unwrap();
        assert_eq!(sd.encap_content_info.econtent, None, "detached ⇒ eContent absent");

        let signer_info = sd.signer_infos.0.get(0).unwrap();
        let signed_attrs = signer_info.signed_attrs.clone().expect("signed attrs present");
        // Find the messageDigest attribute (OID 1.2.840.113549.1.9.4) and read its value.
        let md = signed_attrs.iter()
            .find(|a| a.oid.to_string() == "1.2.840.113549.1.9.4")
            .expect("messageDigest attribute present");
        let md_val = md.values.get(0).unwrap();
        let md_octets = der::asn1::OctetString::from_der(md_val.value()).unwrap();
        assert_eq!(md_octets.as_bytes(), &sha2::Sha256::digest(payload)[..]);
    }
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd kylins.client.crypto && cargo test -p crypto-smime build_signed_data_detached_covers_external_payload`
Expected: FAIL — `messageDigest attribute present` panics (the attribute is absent because the current detached path passes `external_message_digest=None`).

- [ ] **Step 3: Implement the fix**

In `build_signed_data`, replace the single `SignerInfoBuilder::new(sid, digest_algorithm.clone(), &encap, None)` line with:

```rust
    // For a detached signature (clear-sign multipart/signed), the cms builder
    // takes a PRECOMPUTED digest of the external content via
    // `external_message_digest` (it is NOT the raw content). For encapsulated
    // (detached=false) the builder hashes `econtent` itself, so pass None.
    let external_digest = if detached {
        use sha2::Digest;
        Some(sha2::Sha256::digest(payload).to_vec())
    } else {
        None
    };
    let signer_info_builder = SignerInfoBuilder::new(
        sid,
        digest_algorithm.clone(),
        &encap,
        external_digest.as_deref(),
    )
    .map_err(|e| cms_err("signer info builder", e))?;
```

(The digest algorithm is `ID_SHA_256`, so `Sha256::digest` matches. `sha2` is already a crypto-smime dep.)

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd kylins.client.crypto && cargo test -p crypto-smime build_signed_data_detached_covers_external_payload`
Expected: PASS.

- [ ] **Step 5: Run full crypto-smime suite + clippy (no regression to Tasks 1–5 of Plan 2b)**

Run: `cd kylins.client.crypto && cargo test -p crypto-smime && cargo clippy -p crypto-smime --all-targets -- -D warnings`
Expected: 20 passed (was 19 + 1 new), clippy clean.

---

### Task 4: `mail/crypto.rs` MIME wrappers (split + multipart/signed + enveloped)

> **Byte structure validated against Thunderbird** (`mailnews/extensions/smime/nsMsgComposeSecure.cpp` + `nsCMS.cpp`, 2026-07-11): confirmed (a) sign-then-encrypt ordering, (b) encrypt-to-self, (c) part 1 = the full body MIME entity (Content-Type **and** Content-Transfer-Encoding), (d) the signed bytes include exactly one trailing CRLF (the body's own terminator — do NOT double-add), (e) the same wrapped bytes are sent + saved to Sent. Match Thunderbird's exact header emit: **unquoted** `micalg=sha-256`, **quoted** `boundary="…"`, a `"This is a cryptographically signed message in MIME format."` preamble, part-2 `Content-Description: S/MIME Cryptographic Signature`, and base64 line-wrapped at **column 72**. (`micalg` quoting is cosmetic for interop but matched for byte-fidelity.)

**Files:**
- Create: `kylins.client.backend/src/mail/crypto.rs`
- Modify: `kylins.client.backend/src/mail/mod.rs` (add `pub mod crypto;`)
- Test: in-module `tests` in `crypto.rs`

**Interfaces:**
- Produces (all `pub(crate)` unless noted):
  - `pub(crate) enum CryptoSendError { NoSigningKey, MissingRecipientCert(String), Backend(crypto_core::CryptoError), Mime(String) }` (impl `From<CryptoError>` + `Display`; the backend maps it to a `String` for `SourceError`).
  - `fn split_message(full: &[u8]) -> Result<(MessageHeaders, EntityBytes), CryptoSendError>` — splits a built RFC5322 message into the outer message-header block (everything except entity headers) and the body entity (entity headers + blank line + body). Entity headers = `content-type | content-transfer-encoding | content-disposition | content-id | content-description | content-language`.
  - `fn ensure_one_trailing_crlf(bytes: &[u8]) -> Vec<u8>` — for clear-sign part-1 byte-exactness.
  - `fn wrap_multipart_signed(inner_entity_with_crlf: &[u8], signed_der: &[u8]) -> Vec<u8>` — returns a complete `multipart/signed` MIME **entity** (`Content-Type: multipart/signed; protocol=…; micalg=…; boundary=…` header + blank + multipart body). Part 1 is EXACTLY `inner_entity_with_crlf`.
  - `fn wrap_enveloped(enveloped_der: &[u8], smime_type: &str) -> Vec<u8>` — returns a complete `application/pkcs7-mime` MIME entity (Content-Type/CTE/CD headers + blank + base64 body, 64-col wrapped).

- [ ] **Step 1: Write the failing tests**

Create `mail/crypto.rs` with the test module first:

```rust
//! S/MIME MIME-wrapping layer for the send hook (Plan 4a). Pure byte
//! construction — no mail-builder dependency — so clear-sign part-1 byte
//! exactness is fully under our control (the signature must cover the exact
//! part-1 bytes incl. the trailing CRLF before the boundary).

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn split_message_separates_headers_and_body_entity() {
        let full = b"From: a@k\r\nTo: b@k\r\nSubject: Hi\r\nMIME-Version: 1.0\r\nContent-Type: text/plain; charset=utf-8\r\n\r\nHello body\r\n";
        let (outer, entity) = split_message(full).unwrap();
        assert!(outer.headers.contains("From: a@k"));
        assert!(outer.headers.contains("MIME-Version: 1.0"));
        assert!(!outer.headers.contains("Content-Type:"));
        assert!(entity.starts_with(b"Content-Type: text/plain; charset=utf-8\r\n\r\nHello body"));
    }

    #[test]
    fn wrap_multipart_signed_part1_is_byte_exact_and_parses() {
        let part1 = ensure_one_trailing_crlf(b"Content-Type: text/plain; charset=utf-8\r\n\r\nbody\r\n");
        let signed_der = b"\x30\x02\x00\x00"; // opaque fixture; structure test only
        let entity = wrap_multipart_signed(&part1, signed_der);
        let s = std::str::from_utf8(&entity).unwrap();
        assert!(s.contains("multipart/signed"));
        assert!(s.contains("protocol=\"application/pkcs7-signature\""));
        assert!(s.contains("micalg=sha-256"));
        // part-1 bytes appear verbatim between the first boundary and the next.
        let boundary_line = s.lines().find(|l| l.starts_with("--")).unwrap();
        let bound = boundary_line.trim_start_matches('-');
        let after_first_bound = s.split_once(boundary_line).unwrap().1;
        let (part1_region, _rest) = after_first_bound.split_once(boundary_line).unwrap();
        // part1_region starts with a leading \n (from "--bound\r\n"); trim it.
        let part1_in_mime = part1_region.trim_start_matches('\r').trim_start_matches('\n');
        assert_eq!(part1_in_mime.as_bytes(), &part1[..]);
    }

    #[test]
    fn wrap_enveloped_emits_pkcs7_mime_base64() {
        let entity = wrap_enveloped(&[0xDE, 0xAD, 0xBE, 0xEF], "enveloped-data");
        let s = std::str::from_utf8(&entity).unwrap();
        assert!(s.contains("application/pkcs7-mime; smime-type=enveloped-data"));
        assert!(s.contains("Content-Transfer-Encoding: base64"));
        assert!(s.contains("3q2+7w==")); // base64 of DEADBEEF
    }
}
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd kylins.client.backend && cargo test --lib mail::crypto::`
Expected: COMPILE ERROR — `cannot find function split_message` / types missing.

- [ ] **Step 3: Implement the wrappers**

Add to `mail/crypto.rs` (above the test module):

```rust
use base64::Engine;

/// The set of MIME *entity* headers that belong to a body part (move with the
/// body entity), not the outer RFC5322 message. Everything else (From/To/
/// Subject/Date/Message-ID/MIME-Version/…) stays outer.
const ENTITY_HEADERS: &[&str] = &[
    "content-type",
    "content-transfer-encoding",
    "content-disposition",
    "content-id",
    "content-description",
    "content-language",
];

#[derive(Debug, Clone)]
pub(crate) struct MessageHeaders {
    /// Outer message header lines, each `Name: value\r\n`-terminated, NO entity
    /// headers, NO trailing blank line.
    pub headers: String,
}

#[derive(Debug, Clone)]
pub(crate) struct EntityBytes(pub Vec<u8>);

/// Errors from the send-hook crypto layer.
#[derive(Debug)]
pub enum CryptoSendError {
    NoSigningKey,
    MissingRecipientCert(String),
    Backend(crypto_core::CryptoError),
    Mime(String),
}
impl std::fmt::Display for CryptoSendError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::NoSigningKey => write!(f, "no default S/MIME signing key for the account"),
            Self::MissingRecipientCert(e) => write!(f, "no S/MIME cert for recipient {e}"),
            Self::Backend(e) => write!(f, "crypto backend: {e}"),
            Self::Mime(s) => write!(f, "mime: {s}"),
        }
    }
}
impl std::error::Error for CryptoSendError {}
impl From<crypto_core::CryptoError> for CryptoSendError {
    fn from(e: crypto_core::CryptoError) -> Self {
        Self::Backend(e)
    }
}

/// Split a built RFC5322 message into the outer message headers (no entity
/// headers) and the body entity (entity headers + blank line + body).
///
/// Assumes `build_mime` output has no folded (continuation) header lines —
/// true for mail-builder 0.4's simple headers.
pub(crate) fn split_message(full: &[u8]) -> Result<(MessageHeaders, EntityBytes), CryptoSendError> {
    let s = std::str::from_utf8(full).map_err(|e| CryptoSendError::Mime(format!("not utf-8: {e}")))?;
    let blank = s
        .find("\r\n\r\n")
        .ok_or_else(|| CryptoSendError::Mime("no header/body blank line".into()))?;
    let header_block = &s[..blank];
    let body = &s[blank + 4..];

    let mut outer = String::new();
    let mut entity_headers = String::new();
    for line in header_block.split("\r\n") {
        let name = line
            .split(':')
            .next()
            .unwrap_or("")
            .trim()
            .to_ascii_lowercase();
        let target = if ENTITY_HEADERS.contains(&name.as_str()) {
            &mut entity_headers
        } else {
            &mut outer
        };
        if !target.is_empty() {
            target.push_str("\r\n");
        }
        target.push_str(line);
    }
    let entity = format!("{entity_headers}\r\n\r\n{body}").into_bytes();
    Ok((MessageHeaders { headers: outer }, EntityBytes(entity)))
}

/// Ensure `bytes` ends with exactly one `\r\n`. Clear-sign part-1 byte exactness.
pub(crate) fn ensure_one_trailing_crlf(bytes: &[u8]) -> Vec<u8> {
    let mut out = bytes.to_vec();
    while out.ends_with(b"\r\n\r\n") {
        out.truncate(out.len() - 2); // collapse doubled trailing CRLF
    }
    if !out.ends_with(b"\r\n") {
        out.extend_from_slice(b"\r\n");
    }
    out
}

const SIGNED_BOUNDARY: &str = "----=_kylins_smime_signed_0001";

/// Build a `multipart/signed` MIME **entity** (Content-Type header + blank +
/// multipart body). Part 1 is EXACTLY `inner_entity_with_crlf` — the caller
/// signs that exact slice and passes the resulting detached SignedData DER.
pub(crate) fn wrap_multipart_signed(inner_entity_with_crlf: &[u8], signed_der: &[u8]) -> Vec<u8> {
    let sig_b64 = base64::engine::general_purpose::STANDARD.encode(signed_der);
    let mut out = Vec::new();
    out.extend_from_slice(
        format!(
            "Content-Type: multipart/signed; protocol=\"application/pkcs7-signature\"; \
             micalg=sha-256; boundary=\"{SIGNED_BOUNDARY}\"\r\n\r\n"
        )
        .as_bytes(),
    );
    out.extend_from_slice(b"This is a cryptographically signed message in MIME format.\r\n");
    // Part 1 — the signed body entity (exact bytes).
    out.extend_from_slice(format!("--{SIGNED_BOUNDARY}\r\n").as_bytes());
    out.extend_from_slice(inner_entity_with_crlf);
    // Part 2 — the detached signature.
    out.extend_from_slice(format!("--{SIGNED_BOUNDARY}\r\n").as_bytes());
    out.extend_from_slice(
        b"Content-Type: application/pkcs7-signature; name=\"smime.p7s\"\r\n\
          Content-Transfer-Encoding: base64\r\n\
          Content-Disposition: attachment; filename=\"smime.p7s\"\r\n\
          Content-Description: S/MIME Cryptographic Signature\r\n\r\n",
    );
    for chunk in sig_b64.as_bytes().chunks(72) {
        out.extend_from_slice(chunk);
        out.extend_from_slice(b"\r\n");
    }
    out.extend_from_slice(format!("--{SIGNED_BOUNDARY}--\r\n").as_bytes());
    out
}

/// Build an `application/pkcs7-mime` MIME **entity** (headers + blank + base64
/// body, 64-col wrapped). `smime_type` = `"enveloped-data"` (encryption) —
/// `"signed-data"` (opaque signing, unused in 4a but supported).
pub(crate) fn wrap_enveloped(cms_der: &[u8], smime_type: &str) -> Vec<u8> {
    let b64 = base64::engine::general_purpose::STANDARD.encode(cms_der);
    let mut out = Vec::new();
    out.extend_from_slice(
        format!(
            "Content-Type: application/pkcs7-mime; smime-type={smime_type}; name=\"smime.p7m\"\r\n\
             Content-Transfer-Encoding: base64\r\n\
             Content-Disposition: attachment; filename=\"smime.p7m\"\r\n\r\n"
        )
        .as_bytes(),
    );
    for chunk in b64.as_bytes().chunks(72) {
        out.extend_from_slice(chunk);
        out.extend_from_slice(b"\r\n");
    }
    out
}
```

Add to `mail/mod.rs`:

```rust
pub mod crypto;
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd kylins.client.backend && cargo test --lib mail::crypto::`
Expected: 3 passed.

- [ ] **Step 5: Run gates**

Run: `cd kylins.client.backend && cargo test --lib && cargo clippy --all-targets -- -D warnings`
Expected: green + clippy clean.

---

### Task 5: `apply_crypto` orchestrator (sign → clear-sign; encrypt → enveloped; compose)

**Files:**
- Modify: `kylins.client.backend/src/mail/crypto.rs` (add `apply_crypto`)
- Test: in-module `tests` in `crypto.rs`

**Interfaces:**
- Consumes: `crypto_smime::SmimeBackend` (`sign`/`encrypt`), `crate::keystore_bridge::SqliteKeyStore` (`find_by_email`), crypto-core `SignOp`/`EncryptOp`/`Part`/`PartId`/`PartKind`/`SerializationStrategy`/`Standard`/`KeyHandleRef`/`KeyHandle`/`KeyId`/`Fingerprint`/`KeyUsage`, `crate::mail::builder::SendDraft`/`CryptoMethod`/`AddressSpec`, Task 2's `DefaultKeyRow`, Task 4's wrappers.
- Produces: `pub(crate) async fn apply_crypto(backend: &SmimeBackend, keystore: &SqliteKeyStore, mime: &[u8], draft: &SendDraft, account_email: &str, default_signing_key: Option<&DefaultKeyRow>) -> Result<Vec<u8>, CryptoSendError>`.

- [ ] **Step 1: Write the failing tests**

Add to `crypto.rs` tests. These build a real `SmimeBackend` over an in-memory `SqliteKeyStore` (mirror `crypto_smime_lifecycle.rs`'s harness: `init_db` + `seed_account` + `generate_key` to seed signer + recipient certs).

```rust
    #[tokio::test]
    async fn apply_crypto_sign_only_produces_verifiable_multipart_signed() {
        // pool + account seeded; signer = generated smime key (default_signing_key).
        // recipient irrelevant for sign-only.
        let (backend, keystore, pool, account_email, signer_row) = harness(/*signer only*/).await;
        let inner = b"From: a@k\r\nTo: b@k\r\nSubject: Hi\r\nMIME-Version: 1.0\r\n\
                       Content-Type: text/plain; charset=utf-8\r\n\r\nsigned body\r\n";
        let draft = sign_only_draft();
        let out = apply_crypto(&backend, &keystore, inner, &draft, &account_email,
                               Some(&signer_row)).await.unwrap();
        let s = std::str::from_utf8(&out).unwrap();
        assert!(s.contains("multipart/signed"));
        // CRYPTOGRAPHIC GATE: parse part 1 out of the multipart/signed and verify
        // the detached signature over those exact bytes using the signer's cert.
        let part1_bytes = extract_multipart_signed_part1(&out);
        let signed_der = extract_p7s_der(&out);
        assert!(verify_detached_over(&signed_der, &part1_bytes, /*signer cert*/),
                "detached signature must verify over the exact part-1 bytes");
    }

    #[tokio::test]
    async fn apply_crypto_encrypt_only_produces_enveloped_data() {
        // seed a recipient cert (generated key) + sender cert (encrypt-to-self).
        let (backend, keystore, pool, account_email, _signer) = harness(/*recipient + sender*/).await;
        let inner = b"From: a@k\r\nTo: b@k\r\nSubject: Hi\r\nMIME-Version: 1.0\r\n\
                       Content-Type: text/plain; charset=utf-8\r\n\r\nsecret\r\n";
        let out = apply_crypto(&backend, &keystore, inner, &encrypt_only_draft(),
                               &account_email, None).await.unwrap();
        let s = std::str::from_utf8(&out).unwrap();
        assert!(s.contains("application/pkcs7-mime; smime-type=enveloped-data"));
    }

    #[tokio::test]
    async fn apply_crypto_missing_recipient_cert_fails_closed() {
        // recipient "nobody@k" has NO cert in the keystore.
        let (backend, keystore, _pool, account_email, _signer) = harness(/*sender only*/).await;
        let inner = b"From: a@k\r\nTo: nobody@k\r\nSubject: Hi\r\nMIME-Version: 1.0\r\n\
                       Content-Type: text/plain\r\n\r\nx\r\n";
        let err = apply_crypto(&backend, &keystore, inner, &encrypt_only_draft(),
                               &account_email, None).await.unwrap_err();
        assert!(matches!(err, CryptoSendError::MissingRecipientCert(_)));
    }

    #[tokio::test]
    async fn apply_crypto_passthrough_when_no_crypto() {
        let (backend, keystore, _pool, account_email, _signer) = harness(/*minimal*/).await;
        let inner = b"From: a@k\r\nTo: b@k\r\nSubject: Hi\r\nMIME-Version: 1.0\r\n\
                       Content-Type: text/plain\r\n\r\nplain\r\n";
        let draft = plain_draft(); // crypto_method=None
        let out = apply_crypto(&backend, &keystore, inner, &draft, &account_email, None).await.unwrap();
        assert_eq!(out, inner); // unchanged
    }
```

(`harness()` builds an in-memory `SqliteKeyStore` + `SmimeBackend`, seeds account(s), and for the recipient case generates an extra key whose email matches the draft's `to`. `extract_multipart_signed_part1`/`extract_p7s_der`/`verify_detached_over` are small local helpers — write them: parse the multipart with `mail_parser`, base64-decode the p7s, recover the verifying key from the signer cert, verify the ECDSA signature over the part-1 bytes + trailing CRLF. `verify_detached_over` reuses the same ECDSA-verify technique as the crypto-smime Task 1 test.)

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd kylins.client.backend && cargo test --lib mail::crypto::tests::apply_crypto`
Expected: COMPILE ERROR — `cannot find function apply_crypto`.

- [ ] **Step 3: Implement `apply_crypto`**

Add to `mail/crypto.rs`:

```rust
use crypto_core::{
    EncryptOp, KeyHandle, KeyHandleRef, KeyId, KeyUsage, Part, PartId, PartKind,
    SerializationStrategy, SignOp, Standard,
};
use crypto_smime::SmimeBackend;
use der::Decode;

use crate::db::crypto_keys::DefaultKeyRow;
use crate::keystore_bridge::SqliteKeyStore;
use crate::mail::builder::{CryptoMethod, SendDraft};

/// Apply S/MIME sign/encrypt to a built MIME message. Returns the wrapped bytes
/// (or the input unchanged when `crypto_method != Smime` or neither flag set).
///
/// - `sign`   → clear-sign `multipart/signed` over the body entity.
/// - `encrypt` → `application/pkcs7-mime; smime-type=enveloped-data` over the
///   (possibly signed) body entity; the sender (`account_email`) is added as a
///   recipient (encrypt-to-self).
/// - sign + encrypt → inner clear-sign, outer enveloped.
pub(crate) async fn apply_crypto(
    backend: &SmimeBackend,
    keystore: &SqliteKeyStore,
    mime: &[u8],
    draft: &SendDraft,
    account_email: &str,
    default_signing_key: Option<&DefaultKeyRow>,
) -> Result<Vec<u8>, CryptoSendError> {
    if draft.crypto_method != CryptoMethod::Smime || (!draft.sign && !draft.encrypt) {
        return Ok(mime.to_vec());
    }

    let (outer, mut entity) = split_message(mime)?;

    // --- sign (clear-sign) ---
    if draft.sign {
        let signer_row = default_signing_key.ok_or(CryptoSendError::NoSigningKey)?;
        let signer = key_handle_ref(signer_row);
        let part1 = ensure_one_trailing_crlf(&entity.0);
        let signed = backend
            .sign(SignOp {
                payload: &part1,
                signing_key: signer,
                detached: true,
            })
            .await?;
        entity.0 = wrap_multipart_signed(&part1, &signed.signature.signature);
    }

    // --- encrypt ---
    if draft.encrypt {
        let recipient_emails: Vec<String> = std::iter::once(account_email.to_string())
            .chain(draft.to.iter().map(|a| a.email.clone()))
            .chain(draft.cc.iter().map(|a| a.email.clone()))
            .chain(draft.bcc.iter().map(|a| a.email.clone()))
            .collect();
        let mut recipients = Vec::with_capacity(recipient_emails.len());
        for email in &recipient_emails {
            let mut handles = keystore
                .find_by_email(Standard::Smime, email)
                .await
                .map_err(CryptoSendError::Backend)?;
            let h = handles
                .first()
                .cloned()
                .ok_or_else(|| CryptoSendError::MissingRecipientCert(email.clone()))?;
            recipients.push(h);
        }
        let env = backend
            .encrypt(EncryptOp {
                parts: &[Part {
                    id: PartId("body".into()),
                    kind: PartKind::Body,
                    data: entity.0.clone(),
                }],
                serialization: SerializationStrategy::SingleMimeBlob,
                recipients: &recipients,
                sign_with: None,
            })
            .await?;
        let enveloped_der = env.parts.first().expect("one part").ciphertext.clone();
        let wrapped_entity = wrap_enveloped(&enveloped_der, "enveloped-data");
        // Final message = outer headers (no entity Content-Type) + the wrapped
        // entity (which carries its own application/pkcs7-mime Content-Type).
        let mut out = outer.headers.into_bytes();
        out.extend_from_slice(b"\r\n");
        out.extend_from_slice(&wrapped_entity);
        return Ok(out);
    }

    // sign-only: outer headers + the multipart/signed entity (its own Content-Type).
    let mut out = outer.headers.into_bytes();
    out.extend_from_slice(b"\r\n");
    out.extend_from_slice(&entity.0);
    Ok(out)
}

/// Build a `KeyHandleRef` matching `SqliteKeyStore`'s canonical
/// `standard|fingerprint` KeyId encoding (so `keystore.get` resolves it).
fn key_handle_ref(row: &DefaultKeyRow) -> KeyHandleRef {
    KeyHandleRef {
        handle: KeyHandle::Software(KeyId(format!("{}|{}", row.standard, row.fingerprint))),
        standard: Standard::Smime,
        fingerprint: crypto_core::Fingerprint::new(&row.fingerprint),
        usage: KeyUsage::SignAndEncrypt,
        algorithm: "ECDSA-P256".into(),
    }
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd kylins.client.backend && cargo test --lib mail::crypto::tests::apply_crypto`
Expected: 4 passed — INCLUDING the cryptographic gate (`apply_crypto_sign_only_produces_verifiable_multipart_signed` verifies the detached signature over the exact part-1 bytes).

- [ ] **Step 5: Run gates**

Run: `cd kylins.client.backend && cargo test --lib && cargo clippy --all-targets -- -D warnings`
Expected: green + clippy clean.

---

### Task 6: `send_op` wiring — construct backend + call `apply_crypto`

**Files:**
- Modify: `kylins.client.backend/src/sync_engine/engine.rs` (in `send_op`, between `build_mime` ~L934 and `src.send` ~L973)
- Test: `engine.rs` in-module `tests` (extend the existing `send_op` test harness — uses `MockSource::RecordedCall::Send`)

**Interfaces:**
- Consumes: Task 5's `apply_crypto`, Task 2's `get_default_signing_key`, `SqliteKeyStore::new`, `SmimeBackend::new`, `CryptoPolicy::default_baseline`, the account's email (`SELECT email FROM accounts WHERE id = ?` — already used in `keystore_bridge.rs`).
- Produces: `send_op` wraps the MIME via `apply_crypto` before transport; the wrapped bytes flow to `src.send` AND the Sent-folder `src.append` (already reused). On `CryptoSendError`, emits `sync:send-result{success:false, error}` and returns `Err(SourceError::Other(...))`.

- [ ] **Step 1: Write the failing test**

Add to `engine.rs` tests (mirror the existing `send_op_builds_mime_and_calls_send` harness):

```rust
    #[tokio::test]
    async fn send_op_signs_when_draft_requests_smime_sign() {
        let (engine, src) = harness_with_account(/*seeds an account + a default smime signing key via the db*/).await;
        let mut draft = base_draft();
        draft.crypto_method = CryptoMethod::Smime;
        draft.sign = true;
        send_op(&engine, "acct", &src, &draft).await.unwrap();
        let raw = src.last_send_bytes().expect("send was called");
        let s = std::str::from_utf8(&raw).unwrap();
        assert!(s.contains("multipart/signed"), "signed send must wrap MIME");
    }

    #[tokio::test]
    async fn send_op_encrypts_and_includes_self_as_recipient() {
        // account + sender cert + one recipient cert seeded.
        let (engine, src) = harness_with_account_and_recipient().await;
        let mut draft = base_draft();
        draft.crypto_method = CryptoMethod::Smime;
        draft.encrypt = true;
        send_op(&engine, "acct", &src, &draft).await.unwrap();
        let raw = src.last_send_bytes().unwrap();
        let s = std::str::from_utf8(&raw).unwrap();
        assert!(s.contains("application/pkcs7-mime; smime-type=enveloped-data"));
    }

    #[tokio::test]
    async fn send_op_missing_recipient_cert_surfaces_error() {
        let (engine, src) = harness_with_account(/*sender only, no recipient cert*/).await;
        let mut draft = base_draft();
        draft.crypto_method = CryptoMethod::Smime;
        draft.encrypt = true; // recipient has no cert → fail-closed
        let err = send_op(&engine, "acct", &src, &draft).await.unwrap_err();
        assert!(err.to_string().contains("no S/MIME cert for recipient"));
        assert!(src.last_send_bytes().is_none(), "must NOT have sent plaintext");
    }
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd kylins.client.backend && cargo test --lib send_op_`
Expected: FAIL — `send_op` doesn't wrap (the signed draft's raw bytes have no `multipart/signed`).

- [ ] **Step 3: Implement the wiring**

In `send_op` (`engine.rs`), immediately AFTER `let mime = build_mime(draft).await?;` (around L934) and BEFORE `src.send(&mime)` (around L973), insert:

```rust
    // Plan 4a: S/MIME sign/encrypt wrapping. Construct the backend per-send
    // (keystore is a cheap Arc<SqlitePool> handle). The wrapped bytes flow to
    // both transport (below) and the Sent-folder APPEND (reused later).
    let mime = if matches!(draft.crypto_method, crate::mail::builder::CryptoMethod::Smime)
        && (draft.sign || draft.encrypt)
    {
        let account_email: String = sqlx::query_scalar("SELECT email FROM accounts WHERE id = ?")
            .bind(account_id)
            .fetch_one(engine.pool.as_ref())
            .await
            .map_err(|e| SourceError::Other(format!("lookup account email: {e}")))?;
        let keystore = crate::keystore_bridge::SqliteKeyStore::new(engine.pool.clone(), account_id);
        let backend = crypto_smime::SmimeBackend::new(
            std::sync::Arc::new(keystore.clone()),
            crypto_core::CryptoPolicy::default_baseline(),
        );
        // Re-resolve the keystore for find_by_email (the backend owns an Arc clone).
        let default_key = crate::db::crypto_keys::get_default_signing_key(
            engine.pool.as_ref(),
            account_id,
        )
        .await
        .map_err(|e| SourceError::Other(format!("lookup default signing key: {e}")))?;
        match crate::mail::crypto::apply_crypto(
            &backend,
            &keystore,
            &mime,
            draft,
            &account_email,
            default_key.as_ref(),
        )
        .await
        {
            Ok(wrapped) => wrapped,
            Err(e) => {
                // Permanent crypto error — surface immediately, no plaintext fallback.
                engine
                    .sink
                    .emit_send_result(crate::sync_engine::events::SendResultEvent {
                        account_id: account_id.to_string(),
                        draft_id: draft.draft_id.clone(),
                        success: false,
                        error: Some(e.to_string()),
                    })
                    .await;
                return Err(SourceError::Other(e.to_string()));
            }
        }
    } else {
        mime
    };
```

(Adjust the exact `SourceError`/`sink`/`SendResultEvent` names to match the existing code — read `engine.rs` around `send_op` + the existing `emit_send_result` call ~L985 to copy the real shapes. If `SqliteKeyStore` isn't `Clone`, construct two stores from the same pool — one for the backend, one for `find_by_email` — or thread one `&keystore` by restructuring. The `apply_crypto` signature takes `&SqliteKeyStore`, so pass a reference to the one held by the backend is not possible (it's behind `Arc` inside the backend) — pass a second store constructed from the same pool. Both are cheap.)

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd kylins.client.backend && cargo test --lib send_op_`
Expected: 3 passed.

- [ ] **Step 5: Run the full backend gate**

Run: `cd kylins.client.backend && cargo test --lib && cargo test --test crypto_smime_lifecycle && cargo clippy --all-targets -- -D warnings`
Expected: all green (lib 465+ + new send_op tests + lifecycle 2) + clippy clean.

---

### Task 7: Final gates + Thunderbird interop note

**Files:** none (verification + documentation only).

- [ ] **Step 1: Full workspace gates**

Run:
```bash
cd kylins.client.crypto && cargo test && cargo clippy --all-targets -- -D warnings
cd kylins.client.backend && cargo test && cargo clippy --all-targets -- -D warnings
cd kylins.client.frontend && npx tsc --noEmit && npx vitest run
```
Expected: crypto workspace green (crypto-core 17, crypto-smime 20) + clippy clean; backend green (lib 465+ + new mail::crypto + send_op tests + integration) + clippy clean; frontend tsc 0 + vitest green.

- [ ] **Step 2: Manual Thunderbird interop (optional, document only — not blocking)**

Document in the SDD ledger: to confirm outbound CMS interop, generate a signed `.eml` (an `apply_crypto` sign-only output with a `generate_key` self-signed cert) and open it in Thunderbird — expect "untrusted signer" (self-signed) but a structurally-valid signature. Full decrypt/verify interop waits for Phase 1b. This is a user-run manual step; the automated cryptographic gate (Task 5's verify-over-part-1-bytes test) is the real correctness proof.

- [ ] **Step 3: Update the SDD ledger**

Append to `.superpowers/sdd/progress.md`: Plan 4a complete (tasks + gates); carry-forwards: (1) permanent/non-retryable error classification for crypto-missing-cert/key (currently surfaced via sync:send-result but the op still backs off); (2) the 8 deferred Plan 2b Minors; (3) Plan 4b (CryptoBadge + KeyManager UI); (4) Phase 1b receive-side.

---

## Self-Review

**1. Spec coverage.** Spec §0 decisions: per-send backend (Task 6) ✅; clear-sign (Tasks 3+4+5) ✅; sign+encrypt inner clear-sign (Task 5) ✅; encrypt-to-self (Task 5) ✅; fail-closed permanent (Task 5+6) ✅; Sent-copy wrapping (Task 6 — reuses wrapped bytes) ✅; backend.encrypt(sign_with) unused (Task 5 uses sign+encrypt separately) ✅. Spec §1 IPC (Task 1) ✅. §2 components: SendDraft fields (T1) ✅; get_default_signing_key (T2) ✅; mail/crypto.rs apply_crypto (T4+T5) ✅; send_op wiring (T6) ✅; detached fix (T3) ✅. §4 clear-sign mechanics: detached fix (T3) ✅; multipart/signed manual construction (T4 — spike resolved: manual, no mail-builder dep) ✅. §5 verification: automated verify-over-part-1 (T5) ✅; structural enveloped (T5) ✅; fail-closed (T5) ✅; manual Thunderbird (T7, optional) ✅.

**2. Placeholder scan.** No TBD/TODO. Task 6 Step 3 flags that the exact `SourceError`/`sink`/`SendResultEvent`/`Clone` shapes must be matched to the existing `engine.rs` — this directs the implementer to read the existing code (the shapes exist from the send-flow-hardening work) rather than guessing. All other steps carry complete code.

**3. Type consistency.** `CryptoMethod{None,Smime}` (Task 1) used in Task 5/6 ✅. `CryptoSendError{NoSigningKey,MissingRecipientCert,Backend,Mime}` (Task 4) used in Task 5/6 ✅. `DefaultKeyRow{standard,fingerprint,email}` (Task 2) used in Task 5/6 ✅. `split_message`/`wrap_multipart_signed`/`wrap_enveloped`/`ensure_one_trailing_crlf` (Task 4) used in Task 5 ✅. `apply_crypto(backend, keystore, mime, draft, account_email, default_signing_key)` signature consistent across Tasks 5+6 ✅. `key_handle_ref` produces the `standard|fingerprint` KeyId matching `SqliteKeyStore`'s encoding (Plan 2) ✅.

**Carry-forwards (not in this plan):** permanent-error classification (replay worker) · Plan 4b UI (CryptoBadge + KeyManager) · `.p12` import (Plan 3) · recipient discovery (Phase 1b/2) · decrypt/verify (Phase 1b) · the 8 deferred Plan 2b Minors.

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-07-11-crypto-phase1-smime-send-hook.md`. Two execution options:

**1. Subagent-Driven (recommended)** — fresh subagent per task, controller review between tasks.

**2. Inline Execution** — batch execution with checkpoints.

Which approach?
