# Kylins Client — Crypto Phase 1b: S/MIME Receive (Decrypt + Verify + Cert Validation) Design

> **Status:** Approved (brainstormed 2026-07-12).
> **Parent:** `docs/superpowers/specs/2026-07-10-crypto-security-module-design.md` (umbrella design) — this phase specializes §4.4 (detection), §4.5 (receive flow — decrypt and verify decoupled), §7.2 (Tauri commands) for S/MIME inbound.
> **Builds on:** Phase 1 (send-first) — Plans 1/2/2b/4a/4b (committed at `bfc8f27`). The `crypto-smime` crate (sign + encrypt + CMS build), `crypto-core` (`CryptoBackend` trait, `SignatureState`, `DecryptedPayload`, `KeyStore`, `TrustState`), the backend `mail/crypto.rs` send orchestrator, and the KeyManager UI.
> **Plan (to be written):** `docs/superpowers/plans/2026-07-12-crypto-phase1b-smime-receive.md`.

---

## 0. Decision log (locked this session)

| # | Decision | Choice |
|---|---|---|
| 1 | Scope | **Full receive side in one plan:** decrypt + verify core, RFC 5280 §6 cert-chain validation, CRL revocation, **and full receive UI** (granular CryptoBadge states + TrustDialog + decrypt-failure UX). Also closes the Plan 4a "unvalidated recipient cert" carry-forward by reusing the same validator on the send side. |
| 2 | Decrypt/verify model | **Decoupled** (umbrella §4.5). "Decrypted OK, signature unverified/invalid" is a real, distinct UI state. Never collapse decrypt and verify into one boolean. |
| 3 | Cert-chain engine | **`pkix-chain` 0.4.x** (the `crate-pkix` workspace, MarkAtwood / wolfSSL-backed) + **`pkix-profiles-cabf::SmimeProfile`** (CA/B Forum S/MIME BR policy) + **`pkix-identity`** (RFC 8398 `From:`↔SAN mailbox binding) + **`pkix-revocation`** (CRL). Chosen over `picky` (does NOT implement full §6.1 — simplified linear-chain only), `rustls-webpki` (TLS-only, no `emailProtection`), and hand-rolling (RFC 5280 §6.1 is a well-known security footgun). Apache-2.0 OR MIT. Hedge: track `carl-wallace/rust-pki` `certval` for the eventual RustCrypto upstreaming (formats Issue #838). |
| 4 | Revocation posture | **CRL, hard-fail-on-revoked, soft-fail-on-transport; skip OCSP.** CRL via `pkix-revocation` + a hand-rolled HTTP fetcher (`reqwest`) + `crl_cache` table. A fetched CRL that says *revoked* → hard-fail (`chain_valid=false`, signature → `Invalid`). CRL unreachable/stale → `revocation_state=unchecked`, soft-fail (chain proceeds, UI warns). OCSP skipped: deprecated industry-wide (Let's Encrypt ended OCSP 2025; Google PKI following), no turnkey pure-Rust RFC 6960 client+verifier (`x509-ocsp` is parse-only), and soft-fail OCSP is widely considered broken. |
| 5 | Detection timing | **Sync-time flags + lazy decrypt/verify.** Add `CONTENT-TYPE` to the headers-only FETCH allow-list → derive `is_encrypted`/`is_signed` on the existing dormant columns at `upsert_message` (cheap, works on 10K-message folders, powers list-row badges). Decrypt/verify runs **on open** (Stage B body-fetch), not at sync. |
| 6 | At-rest policy | **Ciphertext cached in DB; plaintext memory-only** (umbrella §4.x hard rule). Raw `smime.p7m`/`p7s` bytes persist in `message_bodies.body_mime_ciphertext` (no IMAP re-fetch each open). Decrypted plaintext is returned to the UI in-memory and held in a session-scoped cache only — **never written back to SQLite.** |
| 7 | Trust anchors | **User-imported CA roots + explicit per-signer trust.** KeyManager gains a "Trusted CAs" section (CA roots stored as `crypto_keys` rows, `standard='smime'`, `key_type='cert'`). The TrustDialog writes a `trust_decisions` row (reuses the 5-rung `TrustState` ladder). **No bundled S/MIME CA root program in Phase 1b** — that is a separate effort. Self-signed senders chain only to a user-accepted anchor. |
| 8 | UI depth | **Full receive UI:** granular `CryptoBadge` for the full `SignatureState` taxonomy, `TrustDialog` (accept/reject signer), decrypt-failure panel, session plaintext cache, "Trusted CAs" in KeyManager. |
| 9 | Verify-time | **CMS `signingTime`** (the signed attribute), not wall-clock "now" — so a message verifies the same today and in 10 years (after signer cert expiry it still verifies *as-of-signing*). Fallback to now() only if `signingTime` absent. |
| 10 | Algorithm coverage | ECDSA P-256 + **P-384** (add `p384` dep) + RSA-PKCS1v15 + **RSA-PSS**. `pkix-chain`'s `DefaultVerifier` lacks RSA-PSS / P-521 / Ed25519 / SHA-1; we supply a **custom `SignatureVerifier`** adding RSA-PSS (`rsa::pss::VerifyingKey`) and P-384. P-521/Ed25519 deferred (negligible in deployed S/MIME per USENIX Security 2025 survey). |

---

## 1. Goals

Deliver **S/MIME receive** end-to-end: a Thunderbird-signed-and-encrypted message **decrypts and verifies in Kylins**, with RFC 5280 §6.1 cert-chain validation, CRL revocation, the full Thunderbird-style trust taxonomy surfaced in the UI, and a TrustDialog for explicit signer acceptance. This completes the bidirectional S/MIME story started by Phase 1 (send) and retires the "decrypt/verify → NotImplemented" stubs.

**Interop target:** a Thunderbird-signed-and-encrypted mail decrypts + verifies in Kylins (symmetric to the Phase 1 gate "a Kylins-signed-and-encrypted mail decrypts + verifies in Thunderbird").

## 2. Scope

**In:**
- `crypto-smime`: real `SmimeBackend::decrypt` (EnvelopedData — ktri RSA + **kari ECC written fresh**) and `SmimeBackend::verify` (SignedData — hand-composed CMS signature check over ECDSA P-256/P-384, RSA-PKCS1v15, RSA-PSS).
- Cert-chain validation: `chain.rs` wiring `pkix-chain` + `SmimeProfile` + `pkix-identity`, custom `SignatureVerifier` (RSA-PSS + P-384), signingTime verify-time, From↔SAN binding.
- CRL revocation: HTTP fetcher + `crl_cache` table + `pkix-revocation`, hard-fail-on-revoked / soft-fail-on-transport.
- Schema: new `message_crypto_results` table, new `crl_cache` table, `message_bodies.body_mime_ciphertext` column; populate the dormant `messages`/`threads.is_encrypted`/`is_signed` on receive.
- Detection: `CONTENT-TYPE` in the headers-only FETCH allow-list; `RemoteMessage.crypto_kind`; `upsert_message` binds the flags (+ `ON CONFLICT DO UPDATE`).
- Backend orchestration: `mail/crypto.rs::open_crypto_message` (receive counterpart to `apply_crypto`); `crypto_open_message` + `db_get_message_crypto_result` Tauri commands; ciphertext persist in `fetch_bodies_batch_on_session`; `sync:crypto-result` event.
- Send-side reuse: `apply_crypto` runs recipient certs through the same validator before encrypting (closes the Plan 4a "unvalidated recipient cert" carry-forward).
- Frontend: granular `CryptoBadge` (full `SignatureState` taxonomy), `ReadingPane` integration + decrypt-failure panel + remove the classification-level gate, `TrustDialog` (writes `trust_decisions`), session plaintext cache, KeyManager "Trusted CAs" section, `services/cryptoReceive.ts`.

**Out (carry-forwards):**
- OCSP (skipped — deprecated; no turnkey Rust client).
- EAS receive-crypto (EAS body-on-demand is `nyi()` — `eas_source.rs:463`); Phase 1b receive is **IMAP-only**.
- Encrypted-subject (off by default; receive-side real-subject decrypt deferred).
- P-521 / Ed25519 signature verify.
- A bundled S/MIME CA root program (Phase 1b uses user-imported roots only).
- CRLite (future privacy-preserving mass revocation via Mozilla `clubcard`).
- `.p12`/encrypted-PKCS#8 import (Plan 3), `.p12` export.

## 3. Architecture

### 3.1 Receive pipeline — decoupled decrypt-then-verify (umbrella §4.5)

```
  IMAP BODY.PEEK[] (Stage B, on open)
    │
    │  fetch_bodies_batch_on_session parses full MIME
    ▼
  Detect top-level Content-Type
    │
    ├─ application/pkcs7-mime; smime-type=enveloped-data  ──► ENCRYPTED
    │      │
    │      ▼  crypto_open_message (mail/crypto.rs)
    │      resolve decryption key (match recipient info vs our S/MIME privkeys)
    │      SmimeBackend::decrypt  ──►  inner MIME bytes
    │      (if inner is itself multipart/signed / SignedData ──► verify too)
    │
    ├─ multipart/signed  /  application/pkcs7-mime; smime-type=signed-data ──► SIGNED
    │      │
    │      ▼  SmimeBackend::verify
    │      hand-composed CMS sig check (~200 LoC)
    │         + chain.rs: pkix-chain SmimeProfile @ signingTime
    │         + From↔SAN (pkix-identity)
    │         + CRL revocation (pkix-revocation, hard/soft-fail)
    │      ──► SignatureState
    │
    ▼
  mail_parser the final plaintext MIME  ──►  { html, text, attachments, inline }
    │
    │  plaintext returned IN-MEMORY ONLY (never persisted)
    ▼
  upsert message_crypto_results  (signature_state, signer_fp, chain_valid,
                                   revocation_state, decrypt_state, verified_at)
    │
    ▼
  EmailRenderer renders plaintext; CryptoBadge renders from message_crypto_results
```

Decrypt and verify are **two independent passes**. A message may be "decrypted OK, signature unverified" — a distinct, honest UI state.

### 3.2 File layout (mirrors the send side)

- `kylins.client.crypto/smime/src/cms_parse.rs` *(new)* — `parse_enveloped_data`, `parse_signed_data`, `decrypt_enveloped`, `verify_signed` (built from the send-side test templates + the vendored cms `test_build_sceptest_like_pkcs7` consume template; kari decrypt written fresh).
- `kylins.client.crypto/smime/src/chain.rs` *(new)* — pkix-chain + `SmimeProfile` + `pkix-identity` wiring, custom `SignatureVerifier` (RSA-PSS + P-384), CRL glue, trust→`SignatureState` mapping.
- `kylins.client.crypto/smime/src/lib.rs` — replace the `decrypt`/`verify` `NotImplemented` stubs (lib.rs:145, 191) with real impls.
- `kylins.client.backend/src/mail/crypto.rs` — add `open_crypto_message` (receive orchestrator) alongside `apply_crypto`; the recipient-cert validation helper used by both.
- `kylins.client.backend/src/db/message_crypto_results.rs` *(new)* + `crl_cache.rs` *(new)* + commands.
- `kylins.client.backend/src/sync_engine/commands.rs` — `crypto_open_message` + `db_get_message_crypto_result`.
- Frontend: `features/.../CryptoBadge.tsx` (extends `SecurityChips`), `features/.../TrustDialog.tsx` *(new)*, `services/cryptoReceive.ts` *(new)*, KeyManager "Trusted CAs" section.

### 3.3 crypto-core contract (already in place — receive consumes it)

- `DecryptOp { envelope: &EncryptedEnvelope, decryption_key: KeyHandleRef }` — caller selects the key (the orchestrator matches recipient info → our key).
- `VerifyOp { signed: &SignedEnvelope }`.
- `DecryptedPayload { standard, parts: Vec<Part> }` — flat; S/MIME collapses to one Body part.
- `SignatureState`: `NotSigned | ValidVerified | ValidUnverified | Invalid | UnknownKey | Mismatch`.
- `VerificationResult { state, signer: Option<KeyHandleRef> }`.

## 4. Crypto core

### 4.1 Decrypt (`SmimeBackend::decrypt` + `cms_parse::decrypt_enveloped`)

1. `ContentInfo::from_der` → `EnvelopedData::from_der`.
2. Iterate `recip_infos`; find the entry whose `rid` (IssuerAndSerialNumber or SubjectKeyIdentifier) matches the `decryption_key`'s cert:
   - **ktri (RSA):** `rsa::pkcs1v15::DecryptingKey` unwraps the CEK from `enc_key`.
   - **kari (ECC, written fresh — no upstream template):** ECDH our P-256 private key × sender's ephemeral public key → `DhSinglePassStdDhKdf<Sha256>` → KEK → `aes-kw` AES-192-KW unwrap the CEK.
3. AES-128/256-CBC decrypt `encrypted_content` using the IV from `content_enc_alg.parameters` (PKCS#7 unpad via `cbc::Decryptor<Aes128/256>` + `Pkcs7`).
4. Return inner MIME bytes as `DecryptedPayload` (one Body part).

**Decryption-key selection (backend orchestrator, pre-decrypt):** load the account's S/MIME private keys (`list_crypto_keys_for_account`, `has_private=true`); for each, parse its cert and test IssuerAndSerialNumber/SKI against each recipient info; pass the match as `DecryptOp.decryption_key`. No match → `decrypt_state = no-key` (distinct from `failed`/`malformed`).

### 4.2 Verify — CMS signature check (`SmimeBackend::verify` + `cms_parse::verify_signed`)

1. Parse `SignedData`; locate the signer cert in `SignedData.certificates` by `SignerIdentifier` (fallback: our keyring by fingerprint).
2. **Hand-composed check (~200 LoC):** recompute `messageDigest` (SHA-256 over the covered content / `encapContent`), verify it equals the `messageDigest` signed attribute; verify `encryptedDigest` over the DER-encoded `signed_attrs` using the signer SPKI. Algorithm dispatch: ECDSA P-256/P-384, RSA-PKCS1v15, **RSA-PSS** (`rsa::pss::VerifyingKey`).
3. Hand off to `chain.rs` for cert-chain validation + revocation + identity binding → `SignatureState`.

### 4.3 Cert-chain validation + revocation (`chain.rs`)

- **Chain build:** leaf = signer cert; intermediates from the CMS `certificates` set; ordered leaf-first; root from the trust-anchor store.
- **Policy:** `pkix-profiles-cabf::SmimeProfile` (CA/B Forum S/MIME BR — does the emailProtection EKU, key-usage, basic-constraints, name-constraint, and policy work).
- **Verifier:** custom `SignatureVerifier` wrapping `DefaultVerifier` and adding RSA-PSS + P-384 (the two gaps that matter for S/MIME).
- **Verify-time:** CMS `signingTime` signed attribute (parsed from `signed_attrs`); fallback `now()`.
- **Identity binding:** `pkix-identity` matches the RFC 5322 `From:` address against the signer cert's `rfc822Name` / `id-on-SmtpUTF8Mailbox` SANs (case-sensitive local-part, case-insensitive domain, no subaddress normalization). Mismatch → `Mismatch`.
- **CRL revocation:** extract `cRLDistributionPoints` from each chain cert (`x509-parser`), HTTP-GET via `reqwest`, cache in `crl_cache` (keyed by CRL URL, with `next_update`); feed to `pkix-revocation`. **Revoked → hard-fail** (`chain_valid=false`). **Unreachable / stale → soft-fail** (`revocation_state=unchecked`).

### 4.4 Trust-ladder → `SignatureState` mapping (Thunderbird taxonomy)

| Condition | `SignatureState` | `revocation_state` |
|---|---|---|
| sig OK + chain OK + revocation good + signer explicitly trusted (`trust_decisions` Verified/Personal, or our own key) | `ValidVerified` | good |
| sig OK + chain OK (revocation good or unchecked) + signer not explicitly trusted | `ValidUnverified` | good/unchecked |
| sig OK but `From:`↔SAN mismatch | `Mismatch` | — |
| sig structural but no signer cert available (not in CMS `certificates`, not in keyring) | `UnknownKey` | — |
| sig crypto-fail, OR chain invalid, OR revoked (hard-fail) | `Invalid` | revoked (if revoked) |
| no signature present | `NotSigned` | — |

### 4.5 Fail-closed / secrets hygiene

- Decryption failure → `decrypt_state=failed`/`no-key` (UI shows reason; no partial plaintext).
- Private keys read via `db::crypto_keys::get_crypto_key_full` (at-rest-decrypt), wrapped in `Zeroizing`, never serialized/logged across IPC.
- Malformed CMS → `CryptoError::Malformed`.
- Decrypted plaintext is memory-only (§0.6).

## 5. Data model

### 5.1 New migration `20260712000001_crypto_receive.sql`

```sql
-- Per-message crypto verification/decryption result (one row per message).
CREATE TABLE IF NOT EXISTS message_crypto_results (
    account_id        TEXT NOT NULL,
    message_id        TEXT NOT NULL,
    crypto_kind       TEXT NOT NULL CHECK(crypto_kind IN ('encrypted','signed','encrypted-signed')),
    decrypt_state     TEXT NOT NULL CHECK(decrypt_state IN ('ok','no-key','failed','n/a')),
    signature_state   TEXT NOT NULL CHECK(signature_state IN
                        ('not-signed','valid-verified','valid-unverified','invalid','unknown-key','mismatch')),
    signer_fingerprint TEXT,
    signer_email       TEXT,
    chain_valid        INTEGER,        -- 0/1/NULL (NULL = not assessed)
    revocation_state   TEXT NOT NULL DEFAULT 'unchecked'
                       CHECK(revocation_state IN ('good','revoked','unchecked')),
    verified_at        TEXT NOT NULL,  -- strftime('%s','now')
    PRIMARY KEY (account_id, message_id),
    FOREIGN KEY (account_id, message_id) REFERENCES messages(account_id, id) ON DELETE CASCADE
);

-- CRL cache (keyed by distribution-point URL).
CREATE TABLE IF NOT EXISTS crl_cache (
    crl_url        TEXT PRIMARY KEY,
    crl_der        BLOB NOT NULL,
    issuer_dn      TEXT,
    next_update    TEXT,              -- parsed CRL thisUpdate/nextUpdate
    fetched_at     TEXT NOT NULL      -- strftime('%s','now')
);

-- Raw CMS ciphertext for an encrypted/signed message (plaintext is NEVER persisted).
ALTER TABLE message_bodies ADD COLUMN body_mime_ciphertext BLOB;
```

### 5.2 Detection on the dormant columns

`is_encrypted`/`is_signed` already exist on `messages`/`threads`/`local_drafts` but are bound to literal `0` at `db/messages.rs:406-417` (threads) and `:433-448` (messages), and absent from the `ON CONFLICT DO UPDATE` set. This phase:
- adds `CONTENT-TYPE` to `SYNC_FETCH_QUERY` (`mail/imap/client.rs:25-28`) and updates its test (`client.rs:2934`);
- threads `crypto_kind: Option<CryptoKind>` through `RemoteMessage` (`sync_engine/mod.rs:94-121`);
- derives the kind in `imap_message_to_remote` from the parsed top-level Content-Type;
- binds `is_encrypted`/`is_signed` in `upsert_message` **and adds them to the `ON CONFLICT DO UPDATE` set** so re-syncs update them.

### 5.3 `db::message_crypto_results` + `db::crl_cache`

Public async helpers over `&SqlitePool`:
- `upsert_message_crypto_result(pool, &MessageCryptoResultRow)`, `get_message_crypto_result(pool, account_id, message_id) -> Option<...>`.
- `upsert_crl(pool, url, der, issuer_dn, next_update)`, `get_crl(pool, url) -> Option<...>`, `prune_stale_crls(pool)`.
- `db::message_bodies::set_message_ciphertext(pool, account_id, message_id, &[u8])` and `get_message_ciphertext(...) -> Option<Vec<u8>>` for the new `body_mime_ciphertext` column (the raw CMS payload for encrypted / opaque-signed mail; clear-signed `multipart/signed` reuses the existing `body_html` path — its `smime.p7s` is just an attachment).

Plus Tauri commands `db_get_message_crypto_result`, registered in `lib.rs`.

## 6. Backend orchestration

### 6.1 `mail/crypto.rs::open_crypto_message`

Per-call `SmimeBackend` (mirrors `send_op`'s per-call construction — `SmimeBackend` is not `Clone`). Steps per §3.1. Returns `OpenCryptoResult { plaintext_html, plaintext_text, attachments, inline_images, crypto_result }` — **plaintext in-memory only**. Upserts `message_crypto_results`.

### 6.2 Ciphertext persist (Stage B)

In `fetch_bodies_batch_on_session` (`mail/imap/client.rs:412-506`): when the parsed MIME is crypto-marked, write the raw `smime.p7m`/`p7s` body into `message_bodies.body_mime_ciphertext` (and do not write misleading parsed HTML). Non-crypto mail unchanged. `FetchedBody` (`mail/imap/types.rs:96-103`) gains an optional `mime_ciphertext: Option<Vec<u8>>` field.

### 6.3 Send-side reuse (closes Plan 4a carry-forward)

`apply_crypto` calls the new `chain.rs` validation helper on each recipient cert before encrypting (`notAfter` + chain attempt + key usage). Missing/expired/invalid recipient cert → a clear `CryptoSendError::InvalidRecipientCert` (fail-closed), retiring the "unvalidated recipient cert" security note.

### 6.4 Commands + events

- `crypto_open_message(account_id, message_id) -> OpenCryptoResult` (spawn_blocking).
- `db_get_message_crypto_result(account_id, message_id) -> Option<MessageCryptoResultRow>`.
- Event `sync:crypto-result { account_id, message_id }` so list/pane badges refresh.

## 7. Frontend (React)

1. **Granular `CryptoBadge`** (extends `SecurityChips`): lock glyph (solid = decrypted, broken = `no-key`/`failed`); signature glyph (✓ `ValidVerified`, ◐ `ValidUnverified`, ? `UnknownKey`, ⚠ `Mismatch`, ✕ `Invalid`, absent `NotSigned`); revocation overlay for `unchecked`/`revoked`; tooltip with signer email + fingerprint + chain/revocation detail. Icon variant (list rows) + label variant (reading pane).
2. **`ReadingPane` integration:** remove the classification-level gate (`ReadingPane.tsx:198-210`). On open of a crypto-marked message → `crypto_open_message` → render plaintext via `EmailRenderer` + badge from result. On `decrypt_state ∈ {no-key, failed}` show a **decrypt-failure panel** (not the body): "Can't decrypt — no matching private key" / "Decryption failed: …" + "Manage keys" action.
3. **`TrustDialog`:** fires on `ValidUnverified`/`UnknownKey`/`Mismatch`. Shows signer identity (email, fingerprint, issuer, chain/revocation status). Actions: **Trust signer** (writes `trust_decisions` Verified → re-verify → `ValidVerified`), **Trust & save cert** (stages signer cert into `crypto_keys`), **Don't trust** (Rejected). Thunderbird "untrusted signer" model.
4. **Session plaintext cache:** `viewStore` in-memory `Map<message_id, DecryptedContent>` so re-selecting a thread within a session doesn't re-decrypt; cleared on lock/logout. (Honors "plaintext memory-only" — disk never holds it; RAM does, transiently.)
5. **KeyManager → "Trusted CAs":** new section in `SecurityPreferences` for importing/removing CA root certs (trust anchors), reusing the path-based import pattern from Plan 4b.
6. **Wrappers/types:** `services/cryptoReceive.ts` (`openCryptoMessage` + `MessageCryptoResult`/`OpenCryptoResult` TS mirroring Rust camelCase); `cryptoKeys.ts` gains CA-root import/list/delete wrappers.

## 8. Dependencies (additive)

`kylins.client.crypto/smime/Cargo.toml`:
- `pkix-chain = "0.4"`, `pkix-profiles-cabf`, `pkix-identity`, `pkix-revocation` (pin per the workspace; Apache-2.0 OR MIT).
- `p384 = "0.14"` (P-384 verify, feature `pem`).
- RSA-PSS comes from the already-present `rsa = "0.10.0-rc.18"` (`rsa::pss::VerifyingKey`).

`kylins.client.backend/Cargo.toml`: no new dep — `reqwest` (already present for the HTTP stack) is reused for CRL fetching.

**Switch-back note:** `pkix-*` is young (first release May 2026). Pin exact versions; the S/MIME policy layer we write in `chain.rs` is engine-agnostic enough that a future swap to `certval` (when RustCrypto upstreams it, formats Issue #838) travels with us. The Thunderbird interop gate de-risks the engine choice end-to-end.

## 9. Verification gate

- **crypto-smime unit tests:** `cms_parse` decrypts what `build_enveloped_data` produced — ktri (RSA) **and** kari (ECC, fresh); multi-recipient (encrypt-to-self round-trip); `verify_signed` verifies what `build_signed_data` produced (encapsulated + detached); tamper → `Invalid`; each algorithm (ECDSA P-256/P-384, RSA-PKCS1v15, RSA-PSS).
- **chain.rs tests:** `SmimeProfile` validates known-good chains → valid; known-bad (expired, wrong EKU, name-constraint violation, revoked) → the right failure; From↔SAN match + mismatch; a curated **x509-limbo subset** run.
- **Backend integration:** in-codebase round-trip — `apply_crypto` (sign+encrypt) → `open_crypto_message` → decrypts + verifies → `ValidVerified`. `message_crypto_results` + `crl_cache` persistence.
- **Per-task SDD gates:** crypto-core 17 + crypto-smime (growing), backend `cargo test --lib` + integration, `cargo clippy --all-targets -D warnings` clean across workspaces, frontend `tsc --noEmit` clean + `vitest`.
- **Interop (the real gate):** a Thunderbird-signed-and-encrypted S/MIME message **decrypts + verifies in Kylins**; and a Kylins-signed-and-encrypted message decrypts + verifies in Thunderbird (now with chain validation, Thunderbird reports a structurally-valid signature).
- **Manual e2e (user-run):** `cargo tauri dev` vs `imap.kylins.com` — receive a Thunderbird signed+encrypted mail → decrypts + shows `ValidVerified`/`ValidUnverified`; TrustDialog accept → re-verifies `ValidVerified`; decrypt-failure (encrypt to an account whose key is absent → `no-key` panel); CRL revoked-cert test if obtainable; list-row badges populate.

## 10. Anticipated task groups (the plan will finalize)

One spec → one plan → ~7 SDD task groups (fresh implementer + controller review each), mirroring the send side's Plans 1/2/2b/4a/4b:

1. **G1 — Schema + detection:** migration; `RemoteMessage.crypto_kind`; `CONTENT-TYPE` in `SYNC_FETCH_QUERY` + test; `upsert_message` binds flags + `ON CONFLICT` update; `db::message_crypto_results` + `db::crl_cache` + commands.
2. **G2 — CMS decrypt:** `cms_parse` parse/decrypt EnvelopedData (ktri RSA + **kari ECC fresh**); `SmimeBackend::decrypt`; decrypt-key selection.
3. **G3 — CMS verify (signature):** `cms_parse` parse/verify SignedData (~200 LoC; ECDSA P-256/P-384, RSA-PKCS1v15, RSA-PSS); `SmimeBackend::verify` (pre-chain).
4. **G4 — Cert-chain + CRL:** `chain.rs` (pkix-chain + SmimeProfile + pkix-identity; custom SignatureVerifier; signingTime; From↔SAN; CRL fetcher + `crl_cache` + pkix-revocation; hard/soft-fail; trust→SignatureState; trust-anchor store).
5. **G5 — Backend orchestration:** `open_crypto_message`; `crypto_open_message` + `db_get_message_crypto_result`; event; ciphertext persist; **send-side `apply_crypto` recipient-cert validation** (closes Plan 4a).
6. **G6 — Frontend receive UI:** granular CryptoBadge; ReadingPane integration + decrypt-failure panel + remove gate; TrustDialog; session plaintext cache; KeyManager Trusted CAs; `services/cryptoReceive.ts`.
7. **G7 — Final gates + interop:** consolidated gates; Thunderbird bidirectional (manual); carry-forward docs.

## 11. Carry-forwards (explicit)

- OCSP — skipped (deprecated; no turnkey Rust client).
- EAS receive-crypto (EAS body-fetch `nyi`); Phase 1b receive is IMAP-only.
- Encrypted-subject (off by default; receive-side real-subject decrypt deferred).
- P-521 / Ed25519 signature verify (negligible in deployed S/MIME).
- Bundled S/MIME CA root program (user-imported roots only for Phase 1b).
- CRLite (future privacy-preserving mass revocation via Mozilla `clubcard`).
- `pkix-*` → `certval` migration when RustCrypto upstreams (formats Issue #838).

## 12. Open risks

- **`pkix-*` maturity** — first release May 2026, low adoption, wolfSSL-backed, not publicly audited. Mitigation: pin versions; the algorithm is deterministic; Thunderbird interop gate validates end-to-end; `certval` is the documented migration target.
- **`DefaultVerifier` algorithm gaps** — no RSA-PSS / P-521 / Ed25519 / SHA-1. Mitigation: custom `SignatureVerifier` adds RSA-PSS + P-384 (the two that matter); P-521/Ed25519 deferred with rationale.
- **kari decrypt has no upstream template** — written fresh against RFC 5753 / the send-side kari build path. Mitigation: round-trip test against our own `build_enveloped_data` ECC output + a Thunderbird ECC-encrypted fixture.
- **CRL transport soft-fail** — an attacker who blocks the CRL URL forces `unchecked`. Acceptable per the chosen posture (soft-fail-on-transport); UI surfaces the `unchecked` state explicitly; a future CRLite filter removes the network dependency.
- **Trust-anchor UX burden** — with no bundled root set, every new CA-issued signer needs a one-time accept. Acceptable for Phase 1b (power-user / own-cert ecosystem); the bundled-root program is a later usability phase.
- **Verify-time vs clock skew** — `signingTime` is a signed attribute (attacker can't forge it without breaking the signature), so verify-at-signing-time is sound.
