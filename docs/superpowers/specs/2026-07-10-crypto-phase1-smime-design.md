# Kylins Client — Crypto Phase 1: S/MIME (Send-First) Design

> **Status:** Approved (brainstormed 2026-07-10)
> **Parent:** `docs/superpowers/specs/2026-07-10-crypto-security-module-design.md` (umbrella design) — this phase specializes §4/§6/§10 for S/MIME outbound.
> **Builds on:** Phase 0 — the `kylins.client.crypto/` workspace, the `crypto-core` crate (neutral envelope + `KeyHandle` + `CryptoBackend` trait + `CryptoPolicy` + `CryptoError`), and the hardened backend `crypto.rs` (zeroizing master key + v1 AAD vault).
> **Plan (to be written):** `docs/superpowers/plans/2026-07-10-crypto-phase1-smime.md`

---

## 0. Decision log (locked this session)

| # | Decision | Choice |
|---|---|---|
| 1 | Receive-side (umbrella §7.2) | **Defer to Phase 1b.** Phase 1 is **send-only** (sign + encrypt). Pure-Rust S/MIME *receive* (`cms` verify/decrypt + RFC 5280 §6 path validation) is incomplete today; *send* is viable now. |
| 2 | Send scope | **Both sign and encrypt** (sign-then-encrypt). Encrypt needs only manual recipient-cert import — no extra infrastructure. |
| 3 | Cert/key import format | **`.p12`/`.pfx` primary** via `p12-keystore` 0.3.1 (stable, on the current `cms`/`der`/`x509-cert` line) **+ PEM cert + PEM PKCS#8 key** via `pkcs8` (secondary). `.p12` is the standard CA-issued format users actually have. |
| 4 | `decrypt`/`verify` on `CryptoBackend` | **Stubbed** → return a not-implemented error. The Phase 1 plan adds a `CryptoError::NotImplemented` variant to `crypto-core::error` (cleaner than overloading `Backend`/`Malformed`); the trait stays complete and receive is honestly unimplemented. |
| 5 | Cert chain validation (send) | **Minimal** — the sender signs with their own already-imported cert (self-trusted). Full chain validation + OCSP/CRL arrive with receive in Phase 1b. |
| 6 | Framework crate location | `kylins.client.crypto/smime/` (package `crypto-smime`, a member of the `kylins.client.crypto` workspace renamed from `crypto/` this session). The `crypto-core` crate names stay unprefixed (publishable). |

---

## 1. Goals

Deliver the **first concrete `CryptoBackend`** — `crypto-smime` — covering outbound S/MIME (sign + encrypt) end-to-end, plus the key/cert store, the send hook, and minimal UI. This proves the Phase-0 `crypto-core` contract against a real standard. **Interop target: a Kylins-signed-and-encrypted mail decrypts and verifies in Thunderbird.**

## 2. Scope

**In:**
- `crypto-smime` crate: `impl CryptoBackend` with **`sign` + `encrypt` + `generate_key` + `import_key` + `export_public` functional**; **`decrypt` + `verify` → `NotImplemented`** (Phase 1b).
- `.p12`/`.pfx` import (`p12-keystore`) **and** PEM cert + PEM PKCS#8 key import (`pkcs8`).
- Software RSA / ECDSA via RustCrypto; CMS `SignedData` (detached → `multipart/signed`) + `EnvelopedData` (`application/pkcs7-mime; smime-type=enveloped-data`); **sign-then-encrypt**.
- DB migration: `crypto_keys` + `trust_decisions` (append-only) + `collected_keys` + `accounts.crypto_method`/`crypto_policy_json` + `contacts.pinned_keys_json` (umbrella §4.2 SQL); `db::` modules + `db_*` commands; private blobs wrapped via the Phase-0 `encrypt_with_aad` (AAD = `account_id + field + key_version`).
- Send hook: `mail/builder.rs::build_mime` routes `SendDraft{cryptoMethod=smime, isSigned, isEncrypted}` through `crypto-smime` (`SingleMimeBlob`).
- UI: **CryptoBadge** (composer + sent-mail state) + **KeyManager** (import `.p12`/PEM, set default sign/encrypt identity).

**Out (Phase 1b+):** receive (decrypt/verify), RFC 5280 chain validation, OCSP/CRL, LDAP/GAL/SMIMEA recipient discovery, encrypted-subject, SecurityPanel/TrustDialog (receive UI), `.p12` **export**, full CryptoBadge receive states.

## 3. Architecture — `crypto-smime` crate

Package `crypto-smime` at `kylins.client.crypto/smime/` (workspace member). Depends on `crypto-core` (path) + the RustCrypto S/MIME stack (§7). Implements `crypto_core::CryptoBackend`, mapping the **neutral envelope** to CMS:

- **`sign`** → CMS `SignedData`, emitted as detached `application/pkcs7-signature` over a `multipart/signed` body (`protocol="application/pkcs7-signature"`, `micalg=sha-256`). Signer = the sender's imported signing cert + private key (RSA-PSS-SHA256 or ECDSA-SHA256, chosen by the cert's key type).
- **`encrypt`** → CMS `EnvelopedData` (`application/pkcs7-mime; smime-type=enveloped-data`): fresh per-message AES-128/256 content key, one `KeyTransRecipientInfo` per recipient cert (RSA key transport, or EC for modern recipients). Wraps the (already-signed) MIME.
- **`sign`-then-`encrypt`** = inner `multipart/signed`, outer `enveloped-data` (`SerializationStrategy::SingleMimeBlob`).
- **`generate_key`** → S/MIME keys are cert-bound, so on-device generation produces a **self-signed cert + key** (testing/local use). Real S/MIME certs arrive via import.
- **`import_key`** → `.p12` (`p12-keystore`: parse bag → cert + encrypted private key, decrypt bag PBE) **or** PEM cert + PEM PKCS#8 key; persist via `KeyStore`.
- **`export_public`** → emit the cert (PEM/DER) for sharing / sending to a recipient out-of-band.

The backend resolves a `KeyHandleRef` → concrete cert+key through the `KeyStore`; it does **not** expose concrete key types across the contract (the neutral-envelope design from Phase 0).

## 4. DB (migration — umbrella §4.2 SQL verbatim)

New `migrations/20260710000001_crypto_keys.sql`:
- `crypto_keys` (UNIQUE `account_id`+`standard`+`fingerprint`; CHECK on `standard`/`key_type`/`origin`).
- `trust_decisions` (append-only).
- `collected_keys` (silent staging for discovered-but-unaccepted keys).
- `ALTER TABLE accounts ADD crypto_method / crypto_policy_json`; `ALTER TABLE contacts ADD pinned_keys_json`.

`db::crypto_keys`, `db::trust_decisions`, `db::collected_keys` modules + `db_*` Tauri commands. Soft private-key blobs are wrapped with `crypto::encrypt_with_aad(.., aad = "kylins:{account_id}:{field}:{key_version}")` — never plaintext in SQLite.

## 5. Send flow

`mail/builder.rs::build_mime`: when `SendDraft.cryptoMethod == "smime"` and (`isSigned` or `isEncrypted`):
1. Resolve the sender's signing cert (`crypto_keys`, `is_default_sign`, `standard='smime'`).
2. Resolve each recipient's cert (`crypto_keys` by email — **manual import only** in Phase 1).
3. **Fail-closed:** if any required cert is missing → return an error (KeyAssistant routing arrives in 1b; Phase 1 surfaces a clear error).
4. `sign` (if `isSigned`) → `multipart/signed`; `encrypt` (if `isEncrypted`) → `enveloped-data` over the signed MIME. `SingleMimeBlob`. Base64 → SMTP/EAS.

## 6. UI (React)

- **CryptoBadge** — `(tech, encryption, signature)` triple on the composer + sent-mail row (umbrella §6.2 grammar). Receive-side states (valid-unverified / invalid / unknown-key) light up in 1b.
- **KeyManager** (settings) — import `.p12`/PEM cert + key, set default signing/encryption identity per account, list keys (filter by `standard`). (CertManager / SecurityPanel / TrustDialog come with receive in 1b.)

## 7. Dependencies (`crypto-smime/Cargo.toml`)

`cms = "0.3.0-pre.*"` (builder — pre-release), `x509-cert = "0.3"`, `der = "0.8"`, `pkcs8 = "0.11"` (PEM key), `p12-keystore = "0.3"` (`.p12`), `rsa` + `p256`/`p384`/`p521` (software asym), `sha2`, `aes-gcm` + `cbc` (CMS content ciphers), `signature` (sign/verify traits), `x509-parser = "0.18"` (cert helpers), `thiserror`, `async-trait`. Path dep `crypto-core`. The backend gains `crypto-smime` (path) when the send hook is wired. **Note:** `cms` is pre-release; Phase 1 accepts pre-release `cms`/`pkcs12` (the whole Rust S/MIME stack is on the `0.3-pre` line).

## 8. Verification gate

- **`crypto-smime`:** `cargo test` — CMS round-trips (build `SignedData` → parse back; build `EnvelopedData` → parse back; sign-then-encrypt structure; `decrypt`/`verify` return `NotImplemented`); `cargo clippy --all-targets -- -D warnings` clean.
- **Backend:** `cargo test` (migration applies; `db_*` round-trips; private blobs encrypted-at-rest asserted) + clippy.
- **Interop (the real gate):** a Kylins-signed-and-encrypted S/MIME message **decrypts + verifies in Thunderbird** — proves outbound CMS is standards-correct even though our own receive is deferred.
- **`.p12` validation:** import a real `openssl pkcs12`/Thunderbird-exported `.p12` and round-trip the cert + key (validates `p12-keystore` end-to-end).

## 9. Carry-forwards (Phase 1b)

- **Receive-side**: `decrypt`/`verify` + RFC 5280 §6 chain validation + OCSP/CRL — needs the umbrella §7.2 strategy decision when we start 1b.
- Recipient discovery (LDAP/GAL/SMIMEA); encrypted-subject; SecurityPanel/TrustDialog; `.p12` export; full CryptoBadge receive states.

## 10. Open risks

- **`p12-keystore` runtime correctness** unverified (stable + right dep line, but not runtime-tested here) → mitigated by the §8 `.p12` interop test.
- **`cms` pre-release API churn** → pin `cms`; track upstream.
- **RSA key transport** in `EnvelopedData` (legacy RSAES-PKCS1-v1.5 vs modern RSA-OAEP) → the Thunderbird interop test decides which Thunderbird can decrypt; default to the most-compatible option Thunderbird accepts.
