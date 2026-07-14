# Crypto Phase 1 — Plan 2: S/MIME Cert/Key Lifecycle Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement `crypto-smime`'s `CryptoBackend` **cert/key lifecycle** — self-signed cert `generate_key`, PEM `import_key`, `export_public` — and widen `crypto-core`'s `KeyStore` trait to carry key **material** (not just `KeyHandleRef` metadata). **No CMS sign/encrypt yet** — that's Plan 2b (the `cms` builder is WIP; Plan 2b starts with a build-approach spike).

**Architecture:** Two contract refinements + the lifecycle ops. (1) `crypto-core::KeyStore` widened so `put`/`get` move a `StoredKey { handle_ref, public_data, private_data }` (the cert + private-key bytes), with the backend's db-backed impl encrypting `private_data` at rest via `encrypt_with_aad`. (2) `crypto-smime` implements `CryptoBackend::{generate_key, import_key, export_public}` over `x509-cert` (self-signed cert builder + PEM cert parse) + `pkcs8` (PEM PKCS#8 key) + `rsa`/`p256` (keygen); `sign`/`encrypt`/`decrypt`/`verify` stay `NotImplemented` (Plan 2b+).

**Tech Stack:** Rust (edition 2021, rust-version 1.77.2); `x509-cert 0.3`, `der 0.8`, `spki 0.8`, `pkcs8 0.11`, `rsa`, `p256`/`p384`/`p521`, `sha2`, `signature`, `x509-parser 0.18`, `rand`; existing `crypto-core`, backend `crypto::encrypt_with_aad`. **No `cms` dep yet** (Plan 2b).

## Global Constraints

- Rust edition **2021**, rust-version **1.77.2**. Framework workspace at `kylins.client.crypto/`; crate names unprefixed.
- Private key material **never crosses IPC** — ops take/return `KeyHandleRef`; material moves only Rust→`KeyStore`→Rust.
- Soft private keys encrypted at rest via `crypto::encrypt_with_aad(.., aad)` with `aad = format!("kylins:{account_id}:private_key:1")` (Plan 1's scheme). Decrypted only in-Rust.
- TDD; **do NOT commit** (user controls git). Gates: `cargo test` + `cargo clippy --all-targets -- -D warnings` clean per crate.
- **API uncertainty:** `x509-cert` CertificateBuilder + `pkcs8` PEM APIs must be confirmed against `docs.rs/x509-cert`, `docs.rs/pkcs8`, and the RustCrypto examples (`github.com/RustCrypto/formats`) — the implementer spikes the exact signatures per task (context7 does not carry these crates). Thunderbird S/MIME (`opensource/thunderbird-desktop/mailnews/extensions/smime`) is a structural reference for what a self-signed S/MIME cert carries (KeyUsage, EKU `emailProtection`, SAN email), not Rust API code.

## File Structure

**crypto-core (modify):**
- `kylins.client.crypto/core/src/keystore.rs` — widen `KeyStore` to carry material (`StoredKey`).
- `kylins.client.crypto/core/src/lib.rs` — re-export `StoredKey`.

**crypto-smime (create/modify):**
- `kylins.client.crypto/smime/Cargo.toml` — add the x509/pkcs8/rsa/signature deps.
- `kylins.client.crypto/smime/src/lib.rs` — `SmimeBackend`, `impl CryptoBackend` (generate/import/export functional; sign/encrypt/decrypt/verify → `NotImplemented`).
- `kylins.client.crypto/smime/src/{cert.rs, keystore_sqlite.rs}` — cert build/parse helpers + the db-backed `KeyStore` impl (or keep the KeyStore impl in the backend — see Task 2 decision).

**Backend (modify):**
- `kylins.client.backend/Cargo.toml` — add `crypto-smime` path dep (for the lifecycle smoke test).
- `kylins.client.backend/tests/crypto_smime_lifecycle.rs` — generate → store → export_public round-trip.

---

### Task 1: `crypto-smime` deps + `SmimeBackend` skeleton

**Files:** `kylins.client.crypto/smime/Cargo.toml`, `src/lib.rs`

**Interfaces:** Consumes `crypto-core::CryptoBackend`. Produces `SmimeBackend` (compiles; all ops `NotImplemented`).

- [ ] **Step 1:** Add deps to `smime/Cargo.toml`: `crypto-core = { path = "../core" }`, `x509-cert = "0.3"`, `der = "0.8"`, `spki = "0.8"`, `pkcs8 = "0.11"`, `rsa = "0.9"`, `p256 = "0.13"`, `sha2 = "0.10"`, `signature = "2"`, `x509-parser = "0.18"`, `rand = "0.8"`, `async-trait = "0.1"`, `thiserror = "1"`, `zeroize = "1"`.
- [ ] **Step 2:** In `smime/src/lib.rs` define `pub struct SmimeBackend { policy: crypto_core::CryptoPolicy }` with `SmimeBackend::new()`, and `#[async_trait] impl crypto_core::CryptoBackend for SmimeBackend` where `standard() -> OpenPgp`... **no — `Standard::Smime`**; `policy() -> &self.policy`; **all of `encrypt`/`decrypt`/`sign`/`verify`/`generate_key`/`import_key`/`export_public` return `Err(CryptoError::NotImplemented("Plan 2 task N".into()))`** for now (filled in by later tasks).
- [ ] **Step 3:** Test — `SmimeBackend` is object-safe (`Box<dyn CryptoBackend>`), `standard() == Smime`, `policy().min_rsa_bits == 3072`, and `generate_key(...)` returns `NotImplemented`.
- [ ] **Step 4:** Gate — `cargo test --manifest-path kylins.client.crypto/smime/Cargo.toml` + `cargo clippy --manifest-path kylins.client.crypto/Cargo.toml --all-targets -- -D warnings`.

### Task 2: Widen `crypto-core::KeyStore` to carry material

**Files:** `kylins.client.crypto/core/src/keystore.rs`, `lib.rs`

**Interfaces:** Consumes `KeyHandleRef`, `KeyHandle`, `SecretBox`. Produces `StoredKey` + a material-aware `KeyStore` trait.

- [ ] **Step 1:** Define `StoredKey`:
```rust
pub struct StoredKey {
    pub handle: KeyHandleRef,
    pub public_data: Vec<u8>,                      // DER cert / armored public
    pub private_data: Option<SecretBox<Vec<u8>>>,  // PKCS#8 DER private; None for public-only/token
}
```
- [ ] **Step 2:** Widen the `KeyStore` trait (replace the Phase-0 metadata-only shape):
```rust
pub trait KeyStore: Send + Sync {
    fn put(&self, key: StoredKey) -> Result<KeyHandleRef>;
    fn get(&self, handle: &KeyHandle) -> Result<Option<StoredKey>>;
    fn find_by_email(&self, standard: Standard, email: &str) -> Result<Vec<KeyHandleRef>>;
    fn remove(&self, handle: &KeyHandle) -> Result<()>;
}
```
- [ ] **Step 3:** Update the Phase-0 `NoopBackend`/tests if they referenced the old `KeyStore` shape (they likely didn't impl it — verify; the `backend.rs` NoopBackend doesn't use KeyStore). Re-export `StoredKey` from `lib.rs`.
- [ ] **Step 4:** Test — `StoredKey` serde round-trip (note: `SecretBox` isn't `Serialize`; the `private_data` field is `#[serde(skip)]` or the type is serde-opaque — confirm + assert material never serializes).
- [ ] **Step 5:** Gate — `cargo test --manifest-path kylins.client.crypto/core/Cargo.toml` + clippy.

### Task 3: db-backed `KeyStore` impl (backend) adapting `db::crypto_keys`

**Files:** `kylins.client.backend/src/db/crypto_keys.rs` (adapt), new `kylins.client.backend/src/crypto/keystore_bridge.rs` (the impl)

**Interfaces:** Consumes Task 2's `KeyStore`/`StoredKey` + Plan 1's `db::crypto_keys`. Produces a backend `KeyStore` impl bridging `StoredKey` ↔ `CryptoKeyRecord` (encrypting `private_data` via `encrypt_with_aad`).

- [ ] **Step 1:** Add `crypto-smime` + `crypto-core` are already backend deps (`crypto-core` from Phase 0; add `crypto-smime = { path = "../kylins.client.crypto/smime" }`). Implement `pub struct SqliteKeyStore { pool: Arc<SqlitePool> }` in `crypto/keystore_bridge.rs`, `impl crypto_core::KeyStore for SqliteKeyStore` mapping `StoredKey` → `db::crypto_keys::CryptoKeyRecord` (build the record: `public_data` from the cert DER, `private_data` from `expose_secret()` of `private_data`, etc.) and calling `upsert_crypto_key`/`get_crypto_key_full`/`list_crypto_keys_for_*`. The db layer already does the `encrypt_with_aad` wrap.
- [ ] **Step 2:** Test — store a `StoredKey` → `get` returns it with `private_data` decrypted back to the original bytes; `find_by_email` filters.
- [ ] **Step 3:** Gate — backend `cargo test` + clippy.

### Task 4: `generate_key` (self-signed cert) + `export_public`

**Files:** `kylins.client.crypto/smime/src/lib.rs` (or `cert.rs`)

**Interfaces:** Consumes `x509-cert` CertificateBuilder, `rsa`/`p256`, `pkcs8`, the `KeyStore`. Produces a working `generate_key` + `export_public`.

- [ ] **Step 1 (API spike):** Confirm against `docs.rs/x509-cert/0.3` the `CertificateBuilder` API (v3, self-signed, KeyUsage `digitalSignature`, EKU `emailProtection`, SAN `email`, Ed25519 or ECDSA P-256) + `pkcs8::EncodePrivateKey::to_pkcs8_pem` for the key. Also confirm `spki` SubjectPublicKeyInfo encoding for the chosen algorithm.
- [ ] **Step 2:** Implement `generate_key(KeyGenParams{standard: Smime, user_id, algorithm, passphrase})` — parse the email from `user_id`; generate a key (default ECDSA P-256, or Ed25519, or RSA-3072 per `algorithm`); build a self-signed cert via `CertificateBuilder`; DER-encode the cert + PKCS#8-DER-encode the private key; build `StoredKey{handle: KeyHandleRef{handle: Software(uuid), standard: Smime, fingerprint: <cert SKI hex>, usage: SignAndEncrypt, algorithm}, public_data: cert_der, private_data: Some(SecretBox(priv_pkcs8_der))}`; `self.keystore.put(stored)`; return the `KeyHandleRef`.
- [ ] **Step 3:** Implement `export_public(&KeyHandle)` — `self.keystore.get(handle)` → return `public_data` (DER cert).
- [ ] **Step 4:** Test — `generate_key` returns a `KeyHandleRef` with `standard==Smime` + a non-empty fingerprint; `export_public` returns DER that `x509-parser` re-parses to a cert with the right SAN email + EKU.
- [ ] **Step 5:** Gate — crypto-smime `cargo test` + clippy. (`SmimeBackend` now holds `Arc<dyn KeyStore>` — update the Task-1 struct.)

### Task 5: `import_key` (PEM cert + PEM PKCS#8 key)

**Files:** `kylins.client.crypto/smime/src/lib.rs` (or `cert.rs`)

**Interfaces:** Consumes `pkcs8` PEM decode, `x509-cert`/`x509-parser` PEM cert parse, `KeyStore`. Produces a working `import_key`.

- [ ] **Step 1 (API spike):** Confirm `pkcs8::PrivatekeyInfo::from_pem` (PEM PKCS#8 key) + `x509_parser::parse_x509_pem` (PEM cert) exact signatures.
- [ ] **Step 2:** Implement `import_key(data: &[u8], passphrase: Option<SecretBox<String>>)` — accept a PEM bundle (cert + key) or separate; parse cert → fingerprint (SKI) + KeyUsage/EKU; parse PKCS#8 key (decrypt with passphrase if encrypted, via `pkcs5` if needed — defer encrypted-PKCS#8 if the API is heavy); build `StoredKey`; `keystore.put`; return `KeyHandleRef`. (Encrypted PKCS#8 with passphrase → if `pkcs5` integration is heavy, return `NotImplemented` for the encrypted case in this task + note it; unencrypted PEM must work.)
- [ ] **Step 3:** Test — import an openssl-generated PEM (cert + unencrypted PKCS#8 key) → `KeyHandleRef` with the cert's fingerprint; `export_public` returns the same cert DER.
- [ ] **Step 4:** Gate — crypto-smime `cargo test` + clippy.

### Task 6: Backend lifecycle smoke test

**Files:** `kylins.client.backend/tests/crypto_smime_lifecycle.rs`

**Interfaces:** Consumes Tasks 3–5.

- [ ] **Step 1:** Integration test: build a `SmimeBackend` over a `SqliteKeyStore` (temp `init_db` pool) → `generate_key` → `export_public` → re-parse the DER cert (x509-parser) asserting SAN email + EKU `emailProtection`; then `import_key` of an openssl PEM → matches. (No CMS yet — that's Plan 2b.)
- [ ] **Step 2:** Gate — `cargo test --manifest-path kylins.client.backend/Cargo.toml --test crypto_smime_lifecycle` + full backend `cargo test` + clippy (both crates).

---

## Self-review

- **Spec coverage:** Phase 1 spec §0 decisions #3 (PEM import; `.p12` is Plan 3) + #4 (decrypt/verify NotImplemented) + #5 (generate self-signed) covered. CMS sign/encrypt (§3 sign/encrypt) is **intentionally deferred to Plan 2b** per the spike finding (cms builder WIP) — not a gap in THIS plan. `.p12` → Plan 3. Send hook + UI → later plans.
- **Placeholders:** Tasks 4 + 5 begin with an explicit API spike step (context7 lacks these crates; the implementer confirms exact `x509-cert`/`pkcs8` signatures against docs.rs). The struct/function/test contracts are fully specified; only the exact external-API call shapes are deferred to the spike — honest for unfamiliar APIs.
- **Type consistency:** `StoredKey` (Task 2) is used consistently in Tasks 3/4/5. `SmimeBackend` gains `Arc<dyn KeyStore>` in Task 4 (noted). `KeyHandleRef.handle = KeyHandle::Software(KeyId(uuid))` consistent with crypto-core.

## Plan 2 completion criteria

- `crypto-core::KeyStore` widened to carry material (`StoredKey`); crypto-core tests green.
- `SmimeBackend` implements `CryptoBackend`: `generate_key` (self-signed cert) + `import_key` (PEM) + `export_public` functional; `sign`/`encrypt`/`decrypt`/`verify` → `NotImplemented`.
- db-backed `SqliteKeyStore` bridges `StoredKey` ↔ `crypto_keys` (at-rest encryption via `encrypt_with_aad`).
- Backend lifecycle smoke test passes; all gates green; no regressions.

**Next: Plan 2b** — CMS sign (`SignedData`) + encrypt (`EnvelopedData`), starting with a build-approach spike (`cms` builder WIP vs `cryptographic-message-syntax` vs manual `der`), referencing Thunderbird S/MIME for structure.
