# Crypto Phase 0 — OpenPGP Core Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship a standard-agnostic crypto abstraction plus a working OpenPGP backend (rpgp 0.20) so encrypt/decrypt/sign/verify + key storage round-trip end-to-end, validating the `CryptoProvider` architecture against a real engine.

**Architecture:** A `crypto/` module (promoted from the flat `crypto.rs`) holds the engine-agnostic layer — `CryptoProvider` trait, `CryptoPolicy`, `CryptoError`, `KeyStore`, shared types — ported from `proton-crypto-rs`'s shape. The OpenPGP backend implements `CryptoProvider` over `pgp` (rpgp) 0.20. Soft private keys are wrapped at rest by the existing master-key AES-256-GCM layer; unlocked keys are `Zeroizing` + TTL-cached. All crypto runs `spawn_blocking`.

**Tech Stack:** Rust (Tauri v2 backend) · **`sequoia-openpgp` 2.4.1 (`crypto-rust` backend — pure-Rust, zero C deps)** · `zeroize` 1.8 · `sqlx` (existing) · `aes-gcm`/`keyring` (existing master-key layer). The PGP provider/engine **design is ported from the proven `proton-crypto-rs`** (`PGPProvider` trait + builder split + `VerifiedData` ergonomics — see `D:\Projects\mailclient\opensource\Proton\proton-crypto-rs`); rpgp remains an optional compile-time engine behind the trait.

## Global Constraints

- Branch: `feat/crypto-openpgp-phase0` (off `main`).
- Verification gate per task: `cd kylins.client.backend && cargo test --lib && cargo clippy --all-targets -- -D warnings` (backend); `cd kylins.client.frontend && npx tsc --noEmit && npx vitest run` (frontend tasks). Bash cwd is the repo root — always prefix the `cd`.
- Private key material never crosses IPC; soft keys encrypted at rest via `crate::crypto::encrypt`; unlocked keys `Zeroizing`, TTL ≤ 10 min.
- `CryptoPolicy` rejects MD5/SHA-1/3DES/DSA/Elgamal/secp256k1 at builder construction.
- All crypto Tauri commands `spawn_blocking`.
- `trust_decisions` is append-only.
- Conventional-commit messages; the user controls git (commit only on explicit ask).

## File Structure (Phase 0)

```text
src/crypto/mod.rs          module root + master_key re-export (+ later: CryptoBackend resolver)
src/crypto/master_key.rs   MOVED from crypto.rs — unchanged encrypt/decrypt API
src/crypto/policy.rs       algorithm enums + CryptoPolicy + default (RFC 9580) + allow/reject
src/crypto/error.rs        CryptoError(Arc<dyn Error>) type erasure + Result
src/crypto/types.rs        CryptoMethod, KeyOrigin, VerificationResult, KeyGenParams
src/crypto/provider.rs     CryptoProvider trait + associated types + builder traits (def only)
src/crypto/key_store.rs    KeyStore trait (def only)
src/crypto/openpgp/        Task 3: OpenPgpProvider + rpgp engine
src/db/crypto_keys.rs      Task 2: crypto_keys CRUD
src/db/trust_decisions.rs  Task 2: trust_decisions CRUD
migrations/<ts>_crypto.sql Task 2
src/commands/crypto_commands.rs  Tasks 4/6: async Tauri commands
src/crypto/mime.rs         Task 5: RFC 3156 PGP/MIME build/parse
```

---

## Task 1: Crypto abstraction skeleton (no engine, no new deps)

**Files:**
- Create: `kylins.client.backend/src/crypto/master_key.rs` (content = current `src/crypto.rs`, verbatim)
- Create: `kylins.client.backend/src/crypto/mod.rs`
- Create: `kylins.client.backend/src/crypto/policy.rs`
- Create: `kylins.client.backend/src/crypto/error.rs`
- Create: `kylins.client.backend/src/crypto/types.rs`
- Create: `kylins.client.backend/src/crypto/provider.rs`
- Create: `kylins.client.backend/src/crypto/key_store.rs`
- Delete: `kylins.client.backend/src/crypto.rs` (moved into `crypto/master_key.rs`)
- No change: `lib.rs` (`pub mod crypto;` resolves to `crypto/mod.rs` automatically)

**Interfaces:**
- Consumes: the existing `crypto.rs` master-key API (must keep `crate::crypto::encrypt`/`decrypt` working for `commands::encrypt_secret`/`decrypt_secret`).
- Produces: `crypto::CryptoPolicy` (+ `default_policy()`), `crypto::CryptoError` (+ `Result`), `crypto::types::*`, the `CryptoProvider`/`KeyStore` trait definitions. Tasks 3–4 implement these.

- [ ] **Step 1: Move the master-key module**

Create `src/crypto/master_key.rs` with the **exact** current contents of `src/crypto.rs` (the `KEY` static, `get_or_create_key`, `encrypt`, `decrypt`). Then delete `src/crypto.rs`.

- [ ] **Step 2: Write `src/crypto/mod.rs`**

```rust
//! Crypto module.
//!
//! - [`master_key`]: existing AES-256-GCM secret encryption backed by the OS
//!   keyring (the Layer-0 wrapper all soft private keys are stored under).
//! - [`policy`] / [`error`] / [`types`] / [`provider`] / [`key_store`]: the
//!   standard-agnostic crypto abstraction (OpenPGP / S/MIME / 国密). Backends
//!   (`openpgp/`, `smime/`, `sm/`) are added in later tasks.
//!
//! Abstraction shape ported from `proton-crypto-rs` (provider trait +
//! centralized policy + type-erased error) and Thunderbird's `nsIMsgComposeSecure`.

pub mod error;
pub mod key_store;
pub mod master_key;
pub mod policy;
pub mod provider;
pub mod types;

// Preserve the flat API the rest of the backend already uses
// (`commands::encrypt_secret` / `decrypt_secret` call `crate::crypto::encrypt`).
pub use master_key::{decrypt, encrypt};
```

- [ ] **Step 3: Write the failing policy test in `src/crypto/policy.rs`**

```rust
//! Centralized, versioned crypto algorithm policy. Every backend consults a
//! [`CryptoPolicy`] before constructing an operation; an algorithm not in the
//! allow-set is refused at build time so weak primitives can never be selected
//! by accident. Ported from proton-crypto-rs `proton-rpgp/src/profile/settings.rs`.

use std::collections::HashSet;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum HashAlgorithm { Md5, Sha1, Ripemd160, Sha224, Sha256, Sha384, Sha512, Sha3_256, Sm3 }

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum SymmetricAlgorithm { TripleDes, Idea, Cast5, Aes128, Aes192, Aes256, Sm4 }

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum AeadAlgorithm { Ocb, Eax, Gcm }

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum PkAlgorithm { Rsa, Dsa, Elgamal, Ed25519, EcdhX25519, EcdsaP256, EcdsaP384, EcdsaP521, Sm2 }

#[derive(Debug, Clone)]
pub struct DosLimits {
    pub max_message_size: u64,
    pub max_s2k_trials: u32,
}
impl Default for DosLimits {
    fn default() -> Self { Self { max_message_size: 50 * 1024 * 1024, max_s2k_trials: 5 } }
}

/// The allow-set + defaults a backend must obey. Algorithms absent from the
/// allow-sets are rejected (so MD5/SHA-1/3DES/DSA/Elgamal are excluded by the
/// default). `min_rsa_bits` applies only to `PkAlgorithm::Rsa`.
#[derive(Debug, Clone)]
pub struct CryptoPolicy {
    pub allowed_hashes: HashSet<HashAlgorithm>,
    pub allowed_symmetric: HashSet<SymmetricAlgorithm>,
    pub allowed_aead: HashSet<AeadAlgorithm>,
    pub allowed_pk: HashSet<PkAlgorithm>,
    pub default_hash: HashAlgorithm,
    pub default_symmetric: SymmetricAlgorithm,
    pub min_rsa_bits: u32,
    pub dos: DosLimits,
}

impl CryptoPolicy {
    pub fn is_hash_allowed(&self, h: HashAlgorithm) -> bool { self.allowed_hashes.contains(&h) }
    pub fn is_symmetric_allowed(&self, s: SymmetricAlgorithm) -> bool { self.allowed_symmetric.contains(&s) }
    pub fn is_aead_allowed(&self, a: AeadAlgorithm) -> bool { self.allowed_aead.contains(&a) }
    /// RSA additionally requires `rsa_bits >= min_rsa_bits` when provided.
    pub fn is_pk_allowed(&self, p: PkAlgorithm, rsa_bits: Option<u32>) -> bool {
        if !self.allowed_pk.contains(&p) { return false; }
        if p == PkAlgorithm::Rsa { if let Some(b) = rsa_bits { if b < self.min_rsa_bits { return false; } } }
        true
    }
}

/// RFC 9580 baseline: modern ECC + AES + SHA-2; weak legacy primitives excluded.
pub fn default_policy() -> CryptoPolicy {
    use AeadAlgorithm::*; use HashAlgorithm::*; use PkAlgorithm::*; use SymmetricAlgorithm::*;
    CryptoPolicy {
        allowed_hashes: [Sha256, Sha384, Sha512, Sha3_256].into_iter().collect(),
        allowed_symmetric: [Aes128, Aes256].into_iter().collect(),
        allowed_aead: [Ocb, Eax].into_iter().collect(),
        allowed_pk: [Ed25519, EcdhX25519, Rsa].into_iter().collect(),
        default_hash: Sha256,
        default_symmetric: Aes256,
        min_rsa_bits: 3072,
        dos: DosLimits::default(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn default_policy_allows_modern_and_rejects_weak() {
        let p = default_policy();
        // allowed
        assert!(p.is_hash_allowed(Sha256));
        assert!(p.is_symmetric_allowed(Aes256));
        assert!(p.is_pk_allowed(Ed25519, None));
        assert!(p.is_pk_allowed(EcdhX25519, None));
        assert!(p.is_pk_allowed(PkAlgorithm::Rsa, Some(3072)));
        // rejected (not in allow-set)
        assert!(!p.is_hash_allowed(Md5));
        assert!(!p.is_hash_allowed(Sha1));
        assert!(!p.is_hash_allowed(Ripemd160));
        assert!(!p.is_symmetric_allowed(TripleDes));
        assert!(!p.is_pk_allowed(Dsa, None));
        assert!(!p.is_pk_allowed(Elgamal, None));
    }

    #[test]
    fn rsa_below_min_bits_is_rejected() {
        let p = default_policy();
        assert!(!p.is_pk_allowed(PkAlgorithm::Rsa, Some(2048)));
        assert!(p.is_pk_allowed(PkAlgorithm::Rsa, Some(3072)));
        assert!(p.is_pk_allowed(PkAlgorithm::Rsa, Some(4096)));
    }

    #[test]
    fn dos_limits_match_spec() {
        let p = default_policy();
        assert_eq!(p.dos.max_message_size, 50 * 1024 * 1024);
        assert_eq!(p.dos.max_s2k_trials, 5);
    }
}
```

- [ ] **Step 4: Run policy test to verify it passes**

Run: `cd kylins.client.backend && cargo test --lib crypto::policy`
Expected: PASS (3 tests).

- [ ] **Step 5: Write `src/crypto/error.rs` with its test**

```rust
//! Type-erased crypto error. Mirrors proton-crypto's `CryptoError(Arc<dyn Error>)`
//! so backend-specific errors (rpgp / cms / sm) cross the trait boundary in one
//! uniform type without leaking the backend's error enum.

use std::sync::Arc;

#[derive(Debug)]
pub struct CryptoError(pub Arc<dyn std::error::Error + Send + Sync>);

impl CryptoError {
    pub fn new<E>(e: E) -> Self
    where E: std::error::Error + Send + Sync + 'static { Self(Arc::new(e)) }

    pub fn msg<S: Into<String>>(s: S) -> Self { Self(Arc::new(StrErr(s.into()))) }
}

impl std::fmt::Display for CryptoError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result { write!(f, "{}", self.0) }
}
impl std::error::Error for CryptoError {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> { Some(&*self.0) }
}

impl From<std::io::Error> for CryptoError { fn from(e: std::io::Error) -> Self { Self::new(e) } }
impl From<&str> for CryptoError { fn from(s: &str) -> Self { Self::msg(s) } }
impl From<String> for CryptoError { fn from(s: String) -> Self { Self::msg(s) } }

pub type Result<T> = std::result::Result<T, CryptoError>;

#[derive(Debug)]
struct StrErr(String);
impl std::fmt::Display for StrErr {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result { write!(f, "{}", self.0) }
}
impl std::error::Error for StrErr {}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn erases_and_displays_inner_io_error() {
        let io_err = std::io::Error::new(std::io::ErrorKind::Other, "boom");
        let e: CryptoError = io_err.into();
        assert!(e.to_string().contains("boom"));
        assert!(e.source().is_some(), "source() must expose the wrapped error");
    }

    #[test]
    fn from_string_roundtrips() {
        let e: CryptoError = "bad alg".into();
        assert_eq!(e.to_string(), "bad alg");
    }
}
```

- [ ] **Step 6: Write `src/crypto/types.rs`**

```rust
//! Shared, engine-agnostic types. Concrete key types arrive with each backend
//! (the engine's own key handles); these are the cross-cutting enums every
//! backend reports through.

use crate::crypto::policy::PkAlgorithm;

/// Which crypto standard an account uses (stored on `accounts.crypto_method`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[cfg_attr(feature = "serde", derive(serde::Serialize, serde::Deserialize))]
pub enum CryptoMethod { None, OpenPgp, Smime, Sm }

/// Where a key/cert came from — recorded for trust provenance.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum KeyOrigin { Generated, Imported, Wkd, Keyserver, Autocrypt, Contact }

/// Signature outcome, independent of decryption success (proton `VerifiedData`
/// ergonomics: plaintext is returned even when verification fails).
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum VerificationResult {
    NotSigned,
    Verified { signer_fingerprint: String },
    Unverified { fingerprint: String },
    Failed { reason: String },
}

/// Parameters for key generation.
#[derive(Debug, Clone)]
pub struct KeyGenParams {
    pub user_id: String, // "Display Name <email@example.com>"
    pub primary: PkAlgorithm,
    pub rsa_bits: Option<u32>,
}
```

- [ ] **Step 7: Write `src/crypto/provider.rs` (trait definitions only)**

```rust
//! The standard-agnostic provider abstraction. Ported from proton-crypto-rs
//! `PGPProvider` (associated types + builder sub-traits). Each backend
//! (`openpgp`, `smime`, `sm`) implements this. NOTE: the associated types mean
//! `CryptoProvider` is NOT object-safe — backends are dispatched via the
//! `CryptoBackend` enum added in Task 3, not `dyn CryptoProvider`.

use crate::crypto::error::Result;
use crate::crypto::policy::CryptoPolicy;
use crate::crypto::types::KeyGenParams;

// Marker traits concrete backends fill in with their own key handles.
pub trait PublicKey: Send + Sync + std::fmt::Debug {
    fn fingerprint(&self) -> &str;
}
pub trait PrivateKey: Send + Sync + std::fmt::Debug {
    fn fingerprint(&self) -> &str;
}

pub trait CryptoProvider: Send + Sync {
    type PublicKey: PublicKey;
    type PrivateKey: PrivateKey;

    fn name(&self) -> &'static str; // "openpgp-rpgp" | "smime" | "sm"
    fn policy(&self) -> &CryptoPolicy;

    fn generate_key(&self, params: KeyGenParams) -> Result<KeyPair<Self::PublicKey, Self::PrivateKey>>;
    fn import_key(&self, data: &[u8], passphrase: Option<&str>) -> Result<KeyPair<Self::PublicKey, Self::PrivateKey>>;
}

/// A generated/imported key pair. Generic over the provider's concrete key types.
#[derive(Debug, Clone)]
pub struct KeyPair<P: PublicKey, S: PrivateKey> {
    pub public: P,
    pub private: S,
}
```

- [ ] **Step 8: Write `src/crypto/key_store.rs` (trait definition only)**

```rust
//! At-rest key/cert storage trait. Soft private keys are wrapped by the master
//! key (`crate::crypto::encrypt`); token-backed keys reference a PKCS#11/
//! OpenPGP-card handle instead (Phase 3).

use crate::crypto::error::Result;
use crate::crypto::types::KeyOrigin;

/// One stored key/cert row (mirrors the `crypto_keys` table).
#[derive(Debug, Clone)]
pub struct KeyRecord {
    pub id: String,
    pub account_id: String,
    pub backend: String,       // "openpgp" | "smime" | "sm"
    pub key_type: String,      // "public" | "private" | "cert"
    pub email: Option<String>,
    pub fingerprint: String,
    pub public_data: Vec<u8>,
    pub private_data_enc: Option<Vec<u8>>, // AES-256-GCM(master key) of soft private key
    pub token_serial: Option<String>,
    pub token_key_id: Option<String>,
    pub origin: KeyOrigin,
    pub is_default_sign: bool,
    pub is_default_encrypt: bool,
}

pub trait KeyStore: Send + Sync {
    fn put(&self, record: KeyRecord) -> Result<()>;
    fn get_by_fingerprint(&self, backend: &str, fingerprint: &str) -> Result<Option<KeyRecord>>;
    fn list_for_email(&self, backend: &str, email: &str) -> Result<Vec<KeyRecord>>;
}
```

- [ ] **Step 9: Build + full test + clippy**

Run: `cd kylins.client.backend && cargo test --lib && cargo clippy --all-targets -- -D warnings`
Expected: existing suite still green (master-key move is API-preserving) + 5 new crypto tests pass; clippy clean.

- [ ] **Step 10: Commit (on explicit user ask only)**

```bash
git add kylins.client.backend/src/crypto/ kylins.client.backend/src/crypto.rs
git commit -m "feat(crypto): engine-agnostic abstraction skeleton (provider/policy/error/types/keystore)"
```

---

## Task 2: DB schema — `crypto_keys` + `trust_decisions` + migration + `db_*` commands

**Files:**
- Create: `migrations/<ts>_crypto.sql` (the SQL from spec §data-model)
- Create: `src/db/crypto_keys.rs`, `src/db/trust_decisions.rs` (CRUD, sqlx, mirroring existing `db/accounts.rs`/`db/labels.rs` style)
- Modify: `src/db/mod.rs` (declare the two modules)
- Create: `db_create_crypto_key` / `db_get_crypto_key` / `db_list_crypto_keys_for_email` / `db_put_trust_decision` / `db_get_trust_decision` Tauri commands (in `src/db/commands.rs` or `commands/crypto_commands.rs`)

**Interfaces:**
- Consumes: `crypto::types::{KeyOrigin, CryptoMethod}`, `crypto::encrypt`/`decrypt` for `private_data_enc`.
- Produces: the `crypto_keys`/`trust_decisions` tables + async CRUD the engine (Task 3) and keystore (Task 4) consume.

**Steps (summary — full brief at execution):** write migration SQL → write `crypto_keys.rs` CRUD (insert/get/list-by-email, encrypt private blob via `crypto::encrypt` before insert, decrypt on read) → write `trust_decisions.rs` (append-only insert + latest-for-(email,backend,fingerprint)) → Tauri commands → unit tests against an in-memory `init_db` pool (the project's `tempfile + init_db` test pattern). Gate: `cargo test --lib` + clippy.

---

## Task 3: OpenPGP backend — Sequoia engine (`crypto::openpgp`)

**Files:**
- Modify: `kylins.client.backend/Cargo.toml` — add `sequoia-openpgp = { version = "2.4.1", default-features = false, features = ["crypto-rust"] }` (pure-Rust, zero C deps), `zeroize = { version = "1.8", features = ["zeroize_derive"] }`.
- Create: `src/crypto/openpgp/{mod.rs,sequoia.rs,policy.rs}`.
- Create/modify: `src/crypto/mod.rs` — add `CryptoBackend` enum + `resolve_provider()` (concrete dispatch, now that `OpenPgpProvider` exists).
- **Reference (proven PGP design):** `D:\Projects\mailclient\opensource\Proton\proton-crypto-rs` — port the provider/builder/`VerifiedData` shape; `proton-rpgp/src/{encrypt,decrypt,sign,verify}.rs` shows how to wrap a low-level OpenPGP engine behind the trait (translate the pattern to Sequoia's API).

**Interfaces:**
- Consumes: `crypto::provider::CryptoProvider`, `crypto::policy`, the `sequoia-openpgp` 2.4.1 API.
- Produces: `OpenPgpProvider` impl of `CryptoProvider`; `CryptoBackend` resolver.

**Steps (summary):** add dep + confirm Sequoia 2.4.1 `crypto-rust` API via docs.rs spike → `sequoia.rs`: key gen (Ed25519 primary + X25519 subkey default; RSA-4096 via `rsa_bits`), armor import/export, encrypt-to-recipients/decrypt, sign/verify (returning `DecryptResult` with independent `VerificationResult` — proton `VerifiedData` rule) → `OpenPgpProvider` impl → tests: key-gen + armor round-trip; encrypt→decrypt round-trip; sign→verify round-trip; policy rejects a forced weak algo. Gate: `cargo test --lib` + clippy. *(First step is a Sequoia-2.4.1 API spike — confirm exact signatures against docs.rs before coding; mirror the engine-wrap structure proven in `proton-rpgp`.)*

---

## Task 4: Key store + unlock lifecycle (`crypto::key_store` impl)

**Files:**
- Create: `src/crypto/openpgp/key_store.rs` (or `crypto/key_store_sqlite.rs`) — `KeyStore` impl over Task 2's `crypto_keys`; unlock to `Zeroizing<Vec<u8>>`; TTL cache (10 min) + `lock_all()`.
- Modify: `src/commands/crypto_commands.rs` — `crypto_unlock_key` / `crypto_lock_all` commands.

**Steps (summary):** impl `KeyStore` for a struct holding `Arc<SqlitePool>`; on get, decrypt `private_data_enc` via `crypto::decrypt`; `UnlockedKeyCache` (`Mutex<HashMap<fingerprint, (Instant, Zeroizing<Vec<u8>>)>>`) with 10-min TTL; tests for store→load→unlock + TTL expiry. Gate: tests + clippy.

---

## Task 5: PGP/MIME (RFC 3156) + send/receive hooks

**Files:**
- Create: `src/crypto/mime.rs` — build/parse `multipart/encrypted` + `multipart/signed`; `MsgComposeSecure` streaming trait + OpenPGP impl.
- Modify: `src/mail/builder.rs` (send: wrap via `MsgComposeSecure` when `SendDraft.is_encrypted`/`is_signed`).
- Modify: `src/sync_engine/commands.rs` + `src/mail/imap/client.rs` (receive: detect crypto MIME → decrypt/verify → set `messages.is_encrypted`/`is_signed`).
- Frontend: `services/crypto/mailCrypto.ts`, composer toggles → backend, ReadingPane security state, KeyManager UI.

**Steps (summary):** `MsgComposeSecure` trait + OpenPGP impl → RFC 3156 build/parse with round-trip tests → hook `builder.rs` → hook receive path (detect content-type, decrypt/verify, set flags) → frontend service + UI wiring → **manual e2e** with Thunderbird/Proton (Phase 0 exit gate).

---

## Self-review

- **Spec coverage:** abstraction (T1), DB (T2), engine (T3), keystore/lifecycle (T4), MIME+hooks+frontend (T5) — every spec §Goals item mapped. S/MIME/SM/smartcard/PQ explicitly non-goals (later phases).
- **Placeholders:** Task 1 has complete code; Tasks 2–5 carry Files/Interfaces/Produces + step summaries and are flagged "full brief at execution" per the project's SDD rhythm (one detailed brief per task, as the ledger shows for prior phases).
- **Type consistency:** `CryptoProvider`/`KeyPair`/`KeyRecord`/`VerificationResult`/`KeyGenParams`/`CryptoPolicy` names match across Task 1 and the Tasks 2–5 Produces lines. `CryptoBackend` deferred to Task 3 (object-safety: assoc types ⇒ no `dyn CryptoProvider`).
