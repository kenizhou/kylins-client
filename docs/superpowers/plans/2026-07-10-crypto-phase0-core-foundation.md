# Crypto Module — Phase 0: Core Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Harden the existing secret vault and scaffold the standalone `crypto-core` trait crate so every later phase (S/MIME, OpenPGP, 国密, PKCS#11) builds on a shared, engine-free contract.

**Architecture:** Two deliverables. (1) Harden `kylins.client.backend/src/crypto.rs`: wrap the OS-keyring master key in `secrecy::SecretBox` (zeroizing), add a versioned AAD-bound vault format alongside the legacy API. (2) Create a standalone `crypto/` Cargo workspace with a `crypto-core` crate defining the neutral envelope, `KeyHandle`, `CryptoBackend` trait, `CryptoPolicy`, `CryptoError`, and shared utilities — zero engine dependencies, compiles standalone. Wire `crypto-core` as a path dependency of the backend.

**Tech Stack:** Rust (edition 2021, rust-version 1.77.2); crates `aes-gcm`, `keyring`, `rand`, `hex` (existing); NEW `secrecy`, `zeroize`, `subtle` (backend), plus `serde`, `async-trait`, `thiserror` (crypto-core).

## Global Constraints

- Rust edition **2021**, rust-version **1.77.2** (matches `kylins.client.backend/Cargo.toml`).
- The crypto framework lives at repo root **`crypto/`** (sibling to `kylins.client.backend/` and `kylins.client.frontend/`). Crate/package names use **no `kylins-` prefix** (`crypto-core`, later `crypto-openpgp`, `crypto-smime`, `crypto-sm`, `crypto-pkcs11`, `crypto`).
- OS keyring entry is service **`mailclient`**, user **`master-key`** (existing — do not change).
- Secrets never written plaintext to SQLite (CLAUDE.md red line). Master key lives only in the OS keyring + process memory.
- **Backward compatibility is mandatory:** the existing `crypto::encrypt(&str) -> Result<String, String>` / `decrypt(&str) -> Result<String, String>` (v0 format = `hex(nonce(12) || ct)`, no AAD) must keep working unchanged, because the frontend `encrypt_secret`/`decrypt_secret` IPC and already-stored token blobs depend on it.
- New vault format is v1 = `hex(0x01 || nonce(12) || ct+tag)`, AES-256-GCM with caller-supplied AAD; the leading `0x01` is also bound into the GCM tag.
- `crypto-core` has **zero** engine dependencies — only `serde`, `async-trait`, `thiserror`, `secrecy`, `zeroize`, `subtle`.
- TDD: every code task writes the failing test first, runs it red, implements, runs it green, commits.
- Private key material never crosses the Tauri IPC boundary — `KeyHandleRef` carries only handles/metadata (enforced by type design in this phase).

## File Structure

**Backend (modify):**
- `kylins.client.backend/src/crypto.rs` — reworked: `SecretBox` master key, `CryptoVaultError`, legacy v0 API kept, new v1 AAD API added.
- `kylins.client.backend/Cargo.toml` — add `secrecy`, `zeroize`, `subtle`, and `crypto-core` path dep.
- `kylins.client.backend/tests/crypto_core_wiring.rs` — integration test proving the backend consumes `crypto-core`.

**Framework (create):**
- `crypto/Cargo.toml` — workspace root (`members = ["core"]`).
- `crypto/core/Cargo.toml` — `crypto-core` package.
- `crypto/core/src/lib.rs` — module declarations + re-exports.
- `crypto/core/src/standard.rs` — `Standard` enum.
- `crypto/core/src/ids.rs` — `KeyId`, `TokenKeyId`, `Fingerprint` newtypes.
- `crypto/core/src/handle.rs` — `KeyUsage`, `KeyHandle`, `KeyHandleRef`.
- `crypto/core/src/envelope.rs` — neutral message types (`Part`, `EncryptedPart`, `EncryptedEnvelope`, `SerializationStrategy`, …).
- `crypto/core/src/policy.rs` — `CryptoPolicy`, algorithm enums, `DosLimits`.
- `crypto/core/src/error.rs` — type-erased `CryptoError`, `Result`.
- `crypto/core/src/secret.rs` — `SecretBox<T>` alias + helper.
- `crypto/core/src/util.rs` — `constant_time_eq`.
- `crypto/core/src/trust.rs` — `TrustState` (5-value ladder).
- `crypto/core/src/backend.rs` — `CryptoBackend` async trait + operation structs + `KeyGenParams`.
- `crypto/core/src/keystore.rs` — `KeyStore` trait.

---

### Task 1: Add security dependencies to the backend

**Files:**
- Modify: `kylins.client.backend/Cargo.toml` (the `# Secrets` section around line 57)

**Interfaces:**
- Consumes: nothing
- Produces: `secrecy`, `zeroize`, `subtle` available to `kylins.client.backend`

- [ ] **Step 1: Add the three dependencies**

In `kylins.client.backend/Cargo.toml`, replace the Secrets block:

```toml
# Secrets (kylins original — AES-256-GCM via OS keyring)
aes-gcm = "0.10"
rand = "0.8"
hex = "0.4"
```

with:

```toml
# Secrets (kylins original — AES-256-GCM via OS keyring)
aes-gcm = "0.10"
rand = "0.8"
hex = "0.4"
# Secret hygiene: zeroizing master key + constant-time comparison
secrecy = "0.10"
zeroize = "1"
subtle = "2"
```

- [ ] **Step 2: Verify the dependencies resolve and the crate still builds**

Run: `cargo build --manifest-path kylins.client.backend/Cargo.toml`
Expected: build succeeds (the new deps are unused so far, which is fine — cargo does not warn about unused dependencies).

- [ ] **Step 3: Commit**

```bash
git add kylins.client.backend/Cargo.toml kylins.client.backend/Cargo.lock
git commit -m "build(crypto): add secrecy/zeroize/subtle to backend deps"
```

---

### Task 2: Harden the master key (SecretBox + zeroize), keep legacy API

**Files:**
- Modify: `kylins.client.backend/src/crypto.rs` (full rework of internals)
- Test: `kylins.client.backend/src/crypto.rs` (`#[cfg(test)] mod tests`)

> **Test precondition:** the tests in Tasks 2–3 read/create the OS keyring entry (service `mailclient`, user `master-key`) via `acquire_key()`. On first run they generate and store a random master key there; subsequent runs reuse it. Run them in a user session where the OS keyring is available (the developer's Windows/macOS session — `keyring` uses Windows Credential Manager / macOS Keychain). The integration test in Task 10 has the same precondition.

**Interfaces:**
- Consumes: `secrecy`, `zeroize`, `subtle` (Task 1)
- Produces: `crypto::encrypt`/`crypto::decrypt` (unchanged signatures, v0 format), internal `CryptoVaultError`, `acquire_key()` returning a `KeyGuard`

- [ ] **Step 1: Write the failing test**

Append to `kylins.client.backend/src/crypto.rs`:

```rust
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn legacy_encrypt_decrypt_roundtrip() {
        // The v0 (no-AAD, no-version-byte) API must keep working so already
        // stored token blobs and the frontend encrypt_secret/decrypt_secret
        // IPC continue to function.
        let plaintext = "super-secret-oauth-refresh-token";
        let blob = encrypt(plaintext).expect("legacy encrypt");
        // v0 format: hex(nonce(12) || ct), so no leading 0x01 version byte.
        let bytes = hex::decode(&blob).unwrap();
        assert_ne!(bytes[0], VAULT_VERSION_V1, "legacy blob must not carry the v1 version byte");
        let recovered = decrypt(&blob).expect("legacy decrypt");
        assert_eq!(recovered, plaintext);
    }

    #[test]
    fn master_key_is_secret_box_backed() {
        // Compile-time guarantee: the cached master key is a zeroizing secret,
        // not a raw [u8; 32]. If someone reverts it to a plain array this
        // fails to compile.
        fn _accept_secret(_s: &secrecy::SecretBox<[u8; 32]>) {}
        let guard = acquire_key().expect("acquire key");
        _accept_secret(guard.as_secret_ref());
    }
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cargo test --manifest-path kylins.client.backend/Cargo.toml crypto::tests -- --nocapture`
Expected: FAIL — `acquire_key`, `VAULT_VERSION_V1`, and `KeyGuard::as_secret_ref` are not defined.

- [ ] **Step 3: Write the implementation**

Replace the **entire contents** of `kylins.client.backend/src/crypto.rs` with:

```rust
use aes_gcm::{
    aead::{Aead, KeyInit, Payload},
    Aes256Gcm, Nonce,
};
use rand::RngCore;
use secrecy::{ExposeSecret, SecretBox};
use std::sync::Mutex;

/// OS keyring entry holding the 256-bit master secret that wraps all secrets
/// at rest. Kept identical to the original so existing installs keep working.
pub const KEYRING_SERVICE: &str = "mailclient";
pub const KEYRING_USER: &str = "master-key";

/// Vault format + master-key version. v1 = AAD-bound, version-prefixed.
/// v0 (legacy) = bare `hex(nonce || ct)`, produced by the public `encrypt`/
/// `decrypt` pair for backward compatibility.
pub const VAULT_VERSION_V1: u8 = 0x01;
const NONCE_LEN: usize = 12;

type MasterKey = SecretBox<[u8; 32]>;

static KEY: Mutex<Option<MasterKey>> = Mutex::new(None);

/// Typed vault error. The public legacy API maps this to `String` to preserve
/// its signature; the new AAD API returns it directly.
#[derive(Debug, thiserror::Error)]
pub enum CryptoVaultError {
    #[error("master key lock poisoned")]
    KeyLockPoisoned,
    #[error("keyring error: {0}")]
    Keyring(String),
    #[error("hex decode error: {0}")]
    Decode(String),
    #[error("ciphertext too short")]
    CiphertextTooShort,
    #[error("unsupported vault version byte: {0}")]
    UnsupportedVersion(u8),
    #[error("aes-gcm error: {0}")]
    Aead(String),
}

/// RAII guard holding the master-key lock, so the secret is only exposed while
/// the guard is alive and the cache is populated lazily on first access.
pub struct KeyGuard<'a> {
    guard: std::sync::MutexGuard<'a, Option<MasterKey>>,
}

impl<'a> KeyGuard<'a> {
    /// The raw master-key bytes, scoped to this guard's lifetime.
    fn key_bytes(&self) -> &[u8; 32] {
        // expose_secret() -> &Box<[u8;32]>; .as_ref() -> &[u8;32]
        self.guard
            .as_ref()
            .expect("key initialized before use")
            .expose_secret()
            .as_ref()
    }

    /// Test-only accessor proving the cached key is a `SecretBox`.
    #[cfg(test)]
    pub(crate) fn as_secret_ref(&self) -> &SecretBox<[u8; 32]> {
        self.guard.as_ref().expect("key initialized before use")
    }
}

/// Acquire the process master key, creating + persisting it on first use.
pub fn acquire_key() -> Result<KeyGuard<'static>, CryptoVaultError> {
    let mut guard = KEY.lock().map_err(|_| CryptoVaultError::KeyLockPoisoned)?;
    if guard.is_none() {
        *guard = Some(load_or_create_master_key()?);
    }
    Ok(KeyGuard { guard })
}

fn load_or_create_master_key() -> Result<MasterKey, CryptoVaultError> {
    let entry = keyring::Entry::new(KEYRING_SERVICE, KEYRING_USER)
        .map_err(|e| CryptoVaultError::Keyring(e.to_string()))?;

    let key = match entry.get_password() {
        Ok(hex_key) => {
            let mut key = [0u8; 32];
            hex::decode_to_slice(hex_key, &mut key)
                .map_err(|e| CryptoVaultError::Decode(e.to_string()))?;
            key
        }
        Err(keyring::Error::NoEntry) => {
            let mut key = [0u8; 32];
            rand::thread_rng().fill_bytes(&mut key);
            entry
                .set_password(&hex::encode(key))
                .map_err(|e| CryptoVaultError::Keyring(e.to_string()))?;
            key
        }
        Err(e) => return Err(CryptoVaultError::Keyring(e.to_string())),
    };

    Ok(SecretBox::new(Box::new(key)))
}

// ---- Legacy v0 API (backward compatible) ---------------------------------

/// Encrypt a UTF-8 string with the v0 format `hex(nonce(12) || ct)`, no AAD.
/// Kept for already-stored secrets and the `encrypt_secret` IPC command.
pub fn encrypt(plaintext: &str) -> Result<String, String> {
    encrypt_legacy(plaintext.as_bytes()).map_err(|e| e.to_string())
}

/// Decrypt a v0 `hex(nonce(12) || ct)` blob to a UTF-8 string.
pub fn decrypt(ciphertext_hex: &str) -> Result<String, String> {
    let bytes = decrypt_legacy(ciphertext_hex).map_err(|e| e.to_string())?;
    String::from_utf8(bytes).map_err(|e| e.to_string())
}

fn encrypt_legacy(plaintext: &[u8]) -> Result<String, CryptoVaultError> {
    let guard = acquire_key()?;
    let cipher = Aes256Gcm::new_from_slice(guard.key_bytes())
        .map_err(|e| CryptoVaultError::Aead(e.to_string()))?;

    let mut nonce_bytes = [0u8; NONCE_LEN];
    rand::thread_rng().fill_bytes(&mut nonce_bytes);
    let nonce = Nonce::from_slice(&nonce_bytes);

    let ciphertext = cipher
        .encrypt(nonce, plaintext)
        .map_err(|e| CryptoVaultError::Aead(e.to_string()))?;

    let mut combined = nonce_bytes.to_vec();
    combined.extend_from_slice(&ciphertext);
    Ok(hex::encode(combined))
}

fn decrypt_legacy(ciphertext_hex: &str) -> Result<Vec<u8>, CryptoVaultError> {
    let guard = acquire_key()?;
    let cipher = Aes256Gcm::new_from_slice(guard.key_bytes())
        .map_err(|e| CryptoVaultError::Aead(e.to_string()))?;

    let combined = hex::decode(ciphertext_hex).map_err(|e| CryptoVaultError::Decode(e.to_string()))?;
    if combined.len() < NONCE_LEN + 16 {
        return Err(CryptoVaultError::CiphertextTooShort);
    }
    let (nonce_bytes, ciphertext) = combined.split_at(NONCE_LEN);
    let nonce = Nonce::from_slice(nonce_bytes);

    cipher
        .decrypt(nonce, ciphertext)
        .map_err(|e| CryptoVaultError::Aead(e.to_string()))
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cargo test --manifest-path kylins.client.backend/Cargo.toml crypto::tests -- --nocapture`
Expected: PASS — both `legacy_encrypt_decrypt_roundtrip` and `master_key_is_secret_box_backed` pass.

- [ ] **Step 5: Commit**

```bash
git add kylins.client.backend/src/crypto.rs
git commit -m "feat(crypto): wrap master key in zeroizing SecretBox, keep legacy v0 API"
```

---

### Task 3: Add the versioned AAD-bound vault API (v1)

**Files:**
- Modify: `kylins.client.backend/src/crypto.rs`
- Test: `kylins.client.backend/src/crypto.rs` (`mod tests`)

**Interfaces:**
- Consumes: `acquire_key()`, `CryptoVaultError`, `VAULT_VERSION_V1` (Task 2)
- Produces: `crypto::encrypt_with_aad(&[u8], &[u8]) -> Result<String, CryptoVaultError>`, `crypto::decrypt_with_aad(&str, &[u8]) -> Result<Vec<u8>, CryptoVaultError>`

- [ ] **Step 1: Write the failing tests**

Append inside the `mod tests` block in `kylins.client.backend/src/crypto.rs`:

```rust
    #[test]
    fn aad_roundtrip_succeeds() {
        let blob = encrypt_with_aad(b"private key blob", b"kylins:acct-1:pgp-key:1")
            .expect("encrypt_with_aad");
        let bytes = hex::decode(&blob).unwrap();
        assert_eq!(bytes[0], VAULT_VERSION_V1, "v1 blob must start with the version byte");
        let pt = decrypt_with_aad(&blob, b"kylins:acct-1:pgp-key:1").expect("decrypt_with_aad");
        assert_eq!(pt, b"private key blob");
    }

    #[test]
    fn aad_wrong_context_fails() {
        let blob = encrypt_with_aad(b"private key blob", b"kylins:acct-1:pgp-key:1")
            .expect("encrypt_with_aad");
        // Wrong AAD (different field/account) must fail AEAD verification.
        let err = decrypt_with_aad(&blob, b"kylins:acct-2:pgp-key:1");
        assert!(matches!(err, Err(CryptoVaultError::Aead(_))), "wrong AAD must reject");
    }

    #[test]
    fn aad_tampered_version_fails() {
        // The version byte is bound into the GCM tag: flipping it must fail.
        let blob = encrypt_with_aad(b"x", b"ctx").unwrap();
        let mut bytes = hex::decode(&blob).unwrap();
        bytes[0] = 0x02; // unsupported version
        let tampered = hex::encode(&bytes);
        let err = decrypt_with_aad(&tampered, b"ctx");
        assert!(matches!(err, Err(CryptoVaultError::UnsupportedVersion(2))));
    }
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cargo test --manifest-path kylins.client.backend/Cargo.toml crypto::tests -- --nocapture`
Expected: FAIL — `encrypt_with_aad` / `decrypt_with_aad` are not defined.

- [ ] **Step 3: Write the implementation**

Append to `kylins.client.backend/src/crypto.rs` (after the legacy functions):

```rust
// ---- v1 AAD-bound API ----------------------------------------------------

/// Build the full AAD fed to AES-GCM: the caller's context is prefixed with
/// the version byte so the tag authenticates the format as well as the
/// caller-supplied context (prevents format/version confusion).
fn full_aad(aad: &[u8]) -> Vec<u8> {
    let mut out = Vec::with_capacity(1 + aad.len());
    out.push(VAULT_VERSION_V1);
    out.extend_from_slice(aad);
    out
}

/// Encrypt `plaintext` with caller-supplied AAD. Output format:
/// `hex(0x01 || nonce(12) || ct+tag)`. Use for new sensitive material
/// (crypto private keys, index keys) where cross-account/field replay must be
/// prevented — bind `account_id`, field name, and key version into `aad`.
pub fn encrypt_with_aad(plaintext: &[u8], aad: &[u8]) -> Result<String, CryptoVaultError> {
    let guard = acquire_key()?;
    let cipher = Aes256Gcm::new_from_slice(guard.key_bytes())
        .map_err(|e| CryptoVaultError::Aead(e.to_string()))?;

    let mut nonce_bytes = [0u8; NONCE_LEN];
    rand::thread_rng().fill_bytes(&mut nonce_bytes);
    let nonce = Nonce::from_slice(&nonce_bytes);

    let payload_aad = full_aad(aad);
    let ciphertext = cipher
        .encrypt(nonce, Payload { msg: plaintext, aad: &payload_aad })
        .map_err(|e| CryptoVaultError::Aead(e.to_string()))?;

    let mut out = Vec::with_capacity(1 + NONCE_LEN + ciphertext.len());
    out.push(VAULT_VERSION_V1);
    out.extend_from_slice(&nonce_bytes);
    out.extend_from_slice(&ciphertext);
    Ok(hex::encode(out))
}

/// Decrypt a v1 `hex(0x01 || nonce(12) || ct+tag)` blob produced by
/// [`encrypt_with_aad`], verifying the version byte and AAD.
pub fn decrypt_with_aad(blob_hex: &str, aad: &[u8]) -> Result<Vec<u8>, CryptoVaultError> {
    let raw = hex::decode(blob_hex).map_err(|e| CryptoVaultError::Decode(e.to_string()))?;
    if raw.len() < 1 + NONCE_LEN + 16 {
        return Err(CryptoVaultError::CiphertextTooShort);
    }
    let version = raw[0];
    if version != VAULT_VERSION_V1 {
        return Err(CryptoVaultError::UnsupportedVersion(version));
    }
    let nonce_bytes = &raw[1..1 + NONCE_LEN];
    let ciphertext = &raw[1 + NONCE_LEN..];

    let guard = acquire_key()?;
    let cipher = Aes256Gcm::new_from_slice(guard.key_bytes())
        .map_err(|e| CryptoVaultError::Aead(e.to_string()))?;

    let payload_aad = full_aad(aad);
    let nonce = Nonce::from_slice(nonce_bytes);
    cipher
        .decrypt(nonce, Payload { msg: ciphertext, aad: &payload_aad })
        .map_err(|e| CryptoVaultError::Aead(e.to_string()))
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cargo test --manifest-path kylins.client.backend/Cargo.toml crypto::tests -- --nocapture`
Expected: PASS — `aad_roundtrip_succeeds`, `aad_wrong_context_fails`, `aad_tampered_version_fails` all pass (plus the Task 2 tests still pass).

- [ ] **Step 5: Commit**

```bash
git add kylins.client.backend/src/crypto.rs
git commit -m "feat(crypto): add versioned AAD-bound vault API (v1)"
```

---

### Task 4: Create the `crypto/` workspace + `crypto-core` crate skeleton

**Files:**
- Create: `crypto/Cargo.toml`
- Create: `crypto/core/Cargo.toml`
- Create: `crypto/core/src/lib.rs`
- Create: `crypto/core/src/standard.rs`

**Interfaces:**
- Consumes: nothing
- Produces: a compilable `crypto-core` crate with `Standard`

- [ ] **Step 1: Write the failing test**

Create `crypto/core/src/standard.rs`:

```rust
use serde::{Deserialize, Serialize};

use crate::error::CryptoError;

/// The crypto standard a key or message belongs to. Stored in the `standard`
/// column of `crypto_keys` and used to dispatch to the right `CryptoBackend`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Standard {
    OpenPgp,
    Smime,
    Sm,
}

impl Standard {
    pub fn as_str(self) -> &'static str {
        match self {
            Standard::OpenPgp => "openpgp",
            Standard::Smime => "smime",
            Standard::Sm => "sm",
        }
    }
}

impl std::fmt::Display for Standard {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(self.as_str())
    }
}

impl std::str::FromStr for Standard {
    type Err = CryptoError;
    fn from_str(s: &str) -> Result<Self, Self::Err> {
        match s {
            "openpgp" => Ok(Standard::OpenPgp),
            "smime" => Ok(Standard::Smime),
            "sm" => Ok(Standard::Sm),
            other => Err(CryptoError::UnsupportedStandard(other.to_string())),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn serde_roundtrip_preserves_variant() {
        for s in [Standard::OpenPgp, Standard::Smime, Standard::Sm] {
            let json = serde_json::to_string(&s).unwrap();
            let back: Standard = serde_json::from_str(&json).unwrap();
            assert_eq!(s, back);
        }
    }

    #[test]
    fn serde_uses_lowercase_keys() {
        assert_eq!(serde_json::to_string(&Standard::OpenPgp).unwrap(), "\"openpgp\"");
    }

    #[test]
    fn from_str_roundtrip() {
        let s: Standard = "smime".parse().unwrap();
        assert_eq!(s, Standard::Smime);
    }
}
```

Create `crypto/core/src/error.rs` (minimal — extended in Task 8; defined now so `standard.rs` compiles):

```rust
use std::sync::Arc;

/// Type-erased crypto error. Backend-native errors are wrapped here so the
/// core contract exposes exactly one error type across all backends.
#[derive(Debug, Clone, thiserror::Error)]
pub enum CryptoError {
    #[error("crypto backend error: {0}")]
    Backend(Arc<dyn std::error::Error + Send + Sync>),

    #[error("policy rejected algorithm: {0}")]
    Policy(String),

    #[error("key not found: {0}")]
    KeyNotFound(String),

    #[error("unsupported standard: {0}")]
    UnsupportedStandard(String),

    #[error("malformed input: {0}")]
    Malformed(String),
}

impl CryptoError {
    /// Wrap a backend-native error behind the type-erased `Backend` variant.
    pub fn backend<E>(e: E) -> Self
    where
        E: std::error::Error + Send + Sync + 'static,
    {
        CryptoError::Backend(Arc::new(e))
    }
}

pub type Result<T> = std::result::Result<T, CryptoError>;
```

Create `crypto/core/src/lib.rs`:

```rust
//! Neutral, engine-free crypto abstractions for the Kylins crypto framework.
//!
//! This crate defines the shared contract that every standard backend
//! (OpenPGP, S/MIME, 国密) and every key source (software, PKCS#11 token)
//! implements. It depends on NO cryptographic engine — only serde,
//! async-trait, thiserror, secrecy, zeroize, and subtle — so it compiles
//! standalone and lets the application hold one message type regardless of
//! backend.

pub mod error;
pub mod standard;

pub use error::{CryptoError, Result};
pub use standard::Standard;
```

Create `crypto/core/Cargo.toml`:

```toml
[package]
name = "crypto-core"
version = "0.1.0"
edition = "2021"
rust-version = "1.77.2"

[dependencies]
serde = { version = "1", features = ["derive"] }
serde_json = "1"
async-trait = "0.1"
thiserror = "1"
secrecy = "0.10"
zeroize = "1"
subtle = "2"

[dev-dependencies]
serde_json = "1"
```

Create `crypto/Cargo.toml` (workspace root):

```toml
[workspace]
resolver = "2"
members = ["core"]
```

- [ ] **Step 2: Run test to verify it fails (or build first)**

Run: `cargo test --manifest-path crypto/core/Cargo.toml`
Expected: PASS immediately (the test ships with the code in this step) — this task scaffolds a compiling crate. If it fails to compile, fix before continuing. The key assertion: `crypto-core` builds with **zero** engine dependencies.

- [ ] **Step 3: Verify the workspace builds standalone**

Run: `cargo build --manifest-path crypto/Cargo.toml -p crypto-core`
Expected: build succeeds with only serde/async-trait/thiserror/secrecy/zeroize/subtle pulled in (confirm via the dependency tree: `cargo tree --manifest-path crypto/core/Cargo.toml` shows no `aes-gcm`/`pgp`/`cms`/etc.).

- [ ] **Step 4: Commit**

```bash
git add crypto/
git commit -m "feat(crypto-core): scaffold standalone crypto-core crate with Standard"
```

---

### Task 5: Define key identity types — `ids.rs` + `handle.rs`

**Files:**
- Create: `crypto/core/src/ids.rs`
- Create: `crypto/core/src/handle.rs`
- Modify: `crypto/core/src/lib.rs` (declare modules + re-export)

**Interfaces:**
- Consumes: `Standard` (Task 4)
- Produces: `KeyId`, `TokenKeyId`, `Fingerprint`, `KeyUsage`, `KeyHandle`, `KeyHandleRef`

- [ ] **Step 1: Write the failing test**

Create `crypto/core/src/ids.rs`:

```rust
use serde::{Deserialize, Serialize};
use std::fmt;

/// Opaque identifier for a software-backed key inside a `KeyStore`.
#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub struct KeyId(pub String);

impl fmt::Display for KeyId {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.0)
    }
}

/// Identifier of a key object living on a PKCS#11/HSM token (never exported).
#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub struct TokenKeyId(pub String);

impl fmt::Display for TokenKeyId {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.0)
    }
}

/// Hex key fingerprint (PGP fingerprint, X.509 SKI, SM2 hash). Normalized to
/// lowercase on construction; compared in constant time at trust-decision
/// sites (see `util::constant_time_eq`).
#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub struct Fingerprint(pub String);

impl Fingerprint {
    pub fn new(value: impl Into<String>) -> Self {
        Self(value.into().to_ascii_lowercase())
    }
    pub fn as_str(&self) -> &str {
        &self.0
    }
}

impl fmt::Display for Fingerprint {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.0)
    }
}
```

Create `crypto/core/src/handle.rs`:

```rust
use serde::{Deserialize, Serialize};

use crate::ids::{Fingerprint, KeyId, TokenKeyId};
use crate::standard::Standard;

/// What a key may be used for. Stored per key; selectors pick the right key
/// for each operation so a signing key is never used to encrypt.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum KeyUsage {
    Sign,
    Encrypt,
    SignAndEncrypt,
}

/// Where a key's private half lives. Software keys expose encrypted bytes at
/// rest through a `KeyStore`; token keys never leave the device — operations
/// are delegated to the token by the backend.
#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "lowercase")]
pub enum KeyHandle {
    Software(KeyId),
    Token {
        token_serial: String,
        key_id: TokenKeyId,
    },
}

/// A *reference* to a key — everything the application layer and the IPC
/// boundary ever see. Raw key bytes never appear here by construction.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct KeyHandleRef {
    pub handle: KeyHandle,
    pub standard: Standard,
    pub fingerprint: Fingerprint,
    pub usage: KeyUsage,
    pub algorithm: String,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn token_handle_serde_roundtrip() {
        let r = KeyHandleRef {
            handle: KeyHandle::Token {
                token_serial: "YubiKey-001".into(),
                key_id: TokenKeyId("slot-9a".into()),
            },
            standard: Standard::OpenPgp,
            fingerprint: Fingerprint::new("AB12CD34"),
            usage: KeyUsage::Sign,
            algorithm: "Ed25519".into(),
        };
        let json = serde_json::to_string(&r).unwrap();
        let back: KeyHandleRef = serde_json::from_str(&json).unwrap();
        assert_eq!(r, back);
        // Token handle is tagged "kind":"token".
        assert!(json.contains("\"kind\":\"token\""));
    }

    #[test]
    fn software_handle_tagged_software() {
        let h = KeyHandle::Software(KeyId("k1".into()));
        let json = serde_json::to_string(&h).unwrap();
        assert!(json.contains("\"kind\":\"software\""));
    }
}
```

Update `crypto/core/src/lib.rs` — add the modules and re-exports (replace the file):

```rust
//! Neutral, engine-free crypto abstractions for the Kylins crypto framework.
//!
//! This crate defines the shared contract that every standard backend
//! (OpenPGP, S/MIME, 国密) and every key source (software, PKCS#11 token)
//! implements. It depends on NO cryptographic engine — only serde,
//! async-trait, thiserror, secrecy, zeroize, and subtle — so it compiles
//! standalone and lets the application hold one message type regardless of
//! backend.

pub mod error;
pub mod handle;
pub mod ids;
pub mod standard;

pub use error::{CryptoError, Result};
pub use handle::{KeyHandle, KeyHandleRef, KeyUsage};
pub use ids::{Fingerprint, KeyId, TokenKeyId};
pub use standard::Standard;
```

- [ ] **Step 2: Run test to verify it passes**

Run: `cargo test --manifest-path crypto/core/Cargo.toml handle`
Expected: PASS — `token_handle_serde_roundtrip`, `software_handle_tagged_software` pass.

- [ ] **Step 3: Commit**

```bash
git add crypto/core/src/ids.rs crypto/core/src/handle.rs crypto/core/src/lib.rs
git commit -m "feat(crypto-core): add key identity types (KeyId/TokenKeyId/Fingerprint/KeyHandle)"
```

---

### Task 6: Define the neutral envelope — `envelope.rs`

**Files:**
- Create: `crypto/core/src/envelope.rs`
- Modify: `crypto/core/src/lib.rs`

**Interfaces:**
- Consumes: `Standard`, `KeyHandleRef` (Tasks 4–5)
- Produces: `PartId`, `PartKind`, `Part`, `EncryptedPart`, `DetachedSignature`, `SerializationStrategy`, `KeyPacketRef`, `EncryptedEnvelope`, `SignedEnvelope`, `DecryptedPayload`, `SignatureState`, `VerificationResult`

- [ ] **Step 1: Write the failing test + implementation together**

Create `crypto/core/src/envelope.rs`:

```rust
use serde::{Deserialize, Serialize};

use crate::handle::KeyHandleRef;
use crate::standard::Standard;

#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub struct PartId(pub String);

/// What a part represents inside a message.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "lowercase")]
pub enum PartKind {
    Body,
    Attachment {
        filename: String,
        mime: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        content_id: Option<String>,
    },
}

/// A plaintext input part (the body, or one attachment) feeding `encrypt_parts`.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Part {
    pub id: PartId,
    pub kind: PartKind,
    pub data: Vec<u8>,
}

/// A detached signature over a single part's ciphertext, so a forwarded part
/// can be verified independently of the body.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DetachedSignature {
    pub standard: Standard,
    pub signer: KeyHandleRef,
    pub signature: Vec<u8>,
}

/// One encrypted part. `ciphertext` is wire-format-agnostic; `signature` is
/// independent of the body's signature.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct EncryptedPart {
    pub id: PartId,
    pub kind: PartKind,
    pub ciphertext: Vec<u8>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub signature: Option<DetachedSignature>,
}

/// How a set of parts is serialized onto the wire. Form-A outbound is always
/// `SingleMimeBlob`; `SplitPerPart` is reserved for future internal paths.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SerializationStrategy {
    SplitPerPart,
    SingleMimeBlob,
}

/// One per-recipient key-wrap packet (opaque wire bytes).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct KeyPacketRef {
    pub recipient: KeyHandleRef,
    pub packet: Vec<u8>,
}

/// The neutral encrypted message the application layer holds regardless of
/// backend. For S/MIME, `parts` collapses to one (the CMS `EnvelopedData`
/// wraps the whole MIME tree).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct EncryptedEnvelope {
    pub standard: Standard,
    pub serialization: SerializationStrategy,
    pub parts: Vec<EncryptedPart>,
    pub recipients: Vec<KeyPacketRef>,
}

/// A signed payload (detached signature carried alongside plaintext).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SignedEnvelope {
    pub standard: Standard,
    pub payload: Vec<u8>,
    pub signature: DetachedSignature,
}

/// The decrypted plaintext parts, with the standard that produced them.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DecryptedPayload {
    pub standard: Standard,
    pub parts: Vec<Part>,
}

/// Signature outcome, decoupled from decryption so "decrypted OK, signature
/// unverified" is a real, distinct state.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SignatureState {
    NotSigned,
    ValidVerified,
    ValidUnverified,
    Invalid,
    UnknownKey,
    Mismatch,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct VerificationResult {
    pub state: SignatureState,
    /// The signer key, when one was identified.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub signer: Option<KeyHandleRef>,
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::handle::KeyUsage;
    use crate::ids::{Fingerprint, KeyId};

    fn dummy_ref() -> KeyHandleRef {
        KeyHandleRef {
            handle: KeyHandle::Software(KeyId("k1".into())),
            standard: Standard::Smime,
            fingerprint: Fingerprint::new("deadbeef"),
            usage: KeyUsage::SignAndEncrypt,
            algorithm: "RSA-4096".into(),
        }
    }

    #[test]
    fn envelope_serde_roundtrip_single_blob() {
        let env = EncryptedEnvelope {
            standard: Standard::Smime,
            serialization: SerializationStrategy::SingleMimeBlob,
            parts: vec![EncryptedPart {
                id: PartId("body".into()),
                kind: PartKind::Body,
                ciphertext: vec![1, 2, 3],
                signature: None,
            }],
            recipients: vec![KeyPacketRef { recipient: dummy_ref(), packet: vec![9, 9] }],
        };
        let json = serde_json::to_string(&env).unwrap();
        let back: EncryptedEnvelope = serde_json::from_str(&json).unwrap();
        assert_eq!(back.standard, Standard::Smime);
        assert_eq!(back.serialization, SerializationStrategy::SingleMimeBlob);
        assert_eq!(back.parts.len(), 1);
        assert_eq!(back.recipients.len(), 1);
    }

    #[test]
    fn verification_result_default_signer_none() {
        let v = VerificationResult { state: SignatureState::NotSigned, signer: None };
        let json = serde_json::to_string(&v).unwrap();
        assert!(!json.contains("signer"), "None signer is skipped");
    }
}
```

Update `crypto/core/src/lib.rs` — add `pub mod envelope;` (after `pub mod error;`) and re-export the envelope types. Replace the re-export block with:

```rust
pub mod envelope;
pub mod error;
pub mod handle;
pub mod ids;
pub mod standard;

pub use envelope::{
    DecryptedPayload, DetachedSignature, EncryptedEnvelope, EncryptedPart, KeyPacketRef, Part,
    PartId, PartKind, SerializationStrategy, SignatureState, SignedEnvelope, VerificationResult,
};
pub use error::{CryptoError, Result};
pub use handle::{KeyHandle, KeyHandleRef, KeyUsage};
pub use ids::{Fingerprint, KeyId, TokenKeyId};
pub use standard::Standard;
```

- [ ] **Step 2: Run test to verify it passes**

Run: `cargo test --manifest-path crypto/core/Cargo.toml envelope`
Expected: PASS — `envelope_serde_roundtrip_single_blob`, `verification_result_default_signer_none` pass.

- [ ] **Step 3: Commit**

```bash
git add crypto/core/src/envelope.rs crypto/core/src/lib.rs
git commit -m "feat(crypto-core): add neutral envelope types (per-part + single-blob)"
```

---

### Task 7: Define `CryptoPolicy` + algorithm enums — `policy.rs`

**Files:**
- Create: `crypto/core/src/policy.rs`
- Modify: `crypto/core/src/lib.rs`

**Interfaces:**
- Consumes: nothing (standalone)
- Produces: `HashAlgorithm`, `SymmetricAlgorithm`, `AeadAlgorithm`, `PkAlgorithm`, `DosLimits`, `CryptoPolicy`

- [ ] **Step 1: Write the failing test + implementation**

Create `crypto/core/src/policy.rs`:

```rust
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum HashAlgorithm {
    Sha256,
    Sha384,
    Sha512,
    Sha3_256,
    Sm3,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum SymmetricAlgorithm {
    Aes128,
    Aes256,
    Aes128Gcm,
    Aes256Gcm,
    Sm4Cbc,
    Sm4Gcm,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum AeadAlgorithm {
    Ocb,
    Eax,
    Gcm,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum PkAlgorithm {
    Ed25519,
    X25519,
    EcdsaP256,
    EcdsaP384,
    Rsa3072Plus,
    Sm2,
}

/// Resource caps shared across backends to bound DoS exposure.
#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
pub struct DosLimits {
    pub max_message_size: u64,
    pub max_s2k_trials: u32,
}

/// Versioned allow/reject algorithm table. Every backend consults it before
/// operating. Override precedence (applied outside this crate): built-in →
/// global → per-account → per-operation.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CryptoPolicy {
    pub allowed_hashes: Vec<HashAlgorithm>,
    pub allowed_symmetric: Vec<SymmetricAlgorithm>,
    pub allowed_aead: Vec<AeadAlgorithm>,
    pub allowed_pk: Vec<PkAlgorithm>,
    pub rejected_hashes: Vec<HashAlgorithm>,
    pub rejected_symmetric: Vec<SymmetricAlgorithm>,
    pub rejected_pk: Vec<PkAlgorithm>,
    pub min_rsa_bits: u32,
    pub dos: DosLimits,
}

impl CryptoPolicy {
    /// A modern baseline across all three standards. Each backend intersects
    /// this with the subset relevant to its standard (e.g. 国密 reads SM entries).
    pub fn default_baseline() -> Self {
        use AeadAlgorithm::*;
        use HashAlgorithm::*;
        use PkAlgorithm::*;
        use SymmetricAlgorithm::*;
        Self {
            allowed_hashes: vec![Sha256, Sha384, Sha512, Sm3],
            allowed_symmetric: vec![Aes256Gcm, Aes128Gcm, Aes256, Aes128, Sm4Gcm, Sm4Cbc],
            allowed_aead: vec![Gcm, Ocb, Eax],
            allowed_pk: vec![Ed25519, X25519, EcdsaP256, EcdsaP384, Rsa3072Plus, Sm2],
            rejected_hashes: vec![],
            rejected_symmetric: vec![],
            rejected_pk: vec![],
            min_rsa_bits: 3072,
            dos: DosLimits { max_message_size: 50 * 1024 * 1024, max_s2k_trials: 5 },
        }
    }

    pub fn is_hash_allowed(&self, a: HashAlgorithm) -> bool {
        self.allowed_hashes.contains(&a) && !self.rejected_hashes.contains(&a)
    }

    pub fn is_symmetric_allowed(&self, a: SymmetricAlgorithm) -> bool {
        self.allowed_symmetric.contains(&a) && !self.rejected_symmetric.contains(&a)
    }

    pub fn is_pk_allowed(&self, a: PkAlgorithm) -> bool {
        self.allowed_pk.contains(&a) && !self.rejected_pk.contains(&a)
    }
}

impl Default for CryptoPolicy {
    fn default() -> Self {
        Self::default_baseline()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn baseline_allows_modern_rejects_via_reject_list() {
        let mut p = CryptoPolicy::default_baseline();
        assert!(p.is_pk_allowed(PkAlgorithm::Ed25519));
        assert!(p.is_hash_allowed(HashAlgorithm::Sm3));
        // Rejecting Sm3 flips it to disallowed even though it's in the allow list.
        p.rejected_hashes.push(HashAlgorithm::Sm3);
        assert!(!p.is_hash_allowed(HashAlgorithm::Sm3));
    }

    #[test]
    fn dos_caps_match_spec() {
        let p = CryptoPolicy::default_baseline();
        assert_eq!(p.dos.max_message_size, 50 * 1024 * 1024);
        assert_eq!(p.dos.max_s2k_trials, 5);
    }
}
```

Update `crypto/core/src/lib.rs` — add `pub mod policy;` and re-export:

```rust
pub use policy::{
    AeadAlgorithm, CryptoPolicy, DosLimits, HashAlgorithm, PkAlgorithm, SymmetricAlgorithm,
};
```

(Add the `pub mod policy;` line alongside the other module declarations, and the `pub use policy::…` line in the re-export block.)

- [ ] **Step 2: Run test to verify it passes**

Run: `cargo test --manifest-path crypto/core/Cargo.toml policy`
Expected: PASS — `baseline_allows_modern_rejects_via_reject_list`, `dos_caps_match_spec` pass.

- [ ] **Step 3: Commit**

```bash
git add crypto/core/src/policy.rs crypto/core/src/lib.rs
git commit -m "feat(crypto-core): add CryptoPolicy + algorithm enums"
```

---

### Task 8: Verify `CryptoError`, add `SecretBox` + `constant_time_eq`

**Files:**
- Modify: `crypto/core/src/error.rs` (already created in Task 4 — verify/extend)
- Create: `crypto/core/src/secret.rs`
- Create: `crypto/core/src/util.rs`
- Modify: `crypto/core/src/lib.rs`

**Interfaces:**
- Consumes: nothing
- Produces: `CryptoError::backend`, `SecretBox<T>` alias, `constant_time_eq`

- [ ] **Step 1: Write the failing tests + implementation**

`crypto/core/src/error.rs` already contains the full `CryptoError` enum and `backend()` helper from Task 4 — keep it as-is. Verify it has the `Backend`, `Policy`, `KeyNotFound`, `UnsupportedStandard`, `Malformed` variants.

Create `crypto/core/src/secret.rs`:

```rust
//! Secret-material wrappers.
//!
//! `SecretBox<T>` is a heap-allocated, zeroizing secret. Use it for raw key
//! material and session keys that transit the process temporarily. The
//! type-level `Locked` vs `Unlocked` private-key distinction (from
//! proton-crypto-rs) will be introduced in Phase 1 alongside the first
//! concrete `PrivateKey` type.

use secrecy::Secret;

/// A heap-allocated secret that zeroizes its contents on drop.
pub type SecretBox<T> = Secret<Box<T>>;

/// View the bytes inside a byte-vector secret.
pub fn expose_bytes(secret: &SecretBox<Vec<u8>>) -> &[u8] {
    secret.expose_secret().as_ref()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn secret_box_holds_and_exposes_bytes() {
        let s: SecretBox<Vec<u8>> = SecretBox::new(Box::new(b"raw-key".to_vec()));
        assert_eq!(expose_bytes(&s), b"raw-key");
    }
}
```

Create `crypto/core/src/util.rs`:

```rust
//! Shared utilities.

use subtle::ConstantTimeEq;

/// Constant-time byte comparison for MACs and fingerprints, so equality
/// checks do not leak via timing. Returns `true` iff the slices are equal.
pub fn constant_time_eq(a: &[u8], b: &[u8]) -> bool {
    a.ct_eq(b).into()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn equal_and_unequal() {
        assert!(constant_time_eq(b"abcdef", b"abcdef"));
        assert!(!constant_time_eq(b"abcdef", b"abcdeg"));
        assert!(!constant_time_eq(b"abc", b"abcd"));
    }
}
```

Add a focused test for `CryptoError::backend` type-erasure. Append to `crypto/core/src/error.rs`:

```rust
#[cfg(test)]
mod tests {
    use super::*;

    #[derive(Debug, thiserror::Error)]
    #[error("boom: {0}")]
    struct FakeBackendErr(String);

    #[test]
    fn backend_error_is_type_erased_and_cloneable() {
        let err = CryptoError::backend(FakeBackendErr("detached tag mismatch".into()));
        let cloned = err.clone();
        // Display round-trips through the Arc'd inner error.
        let msg = format!("{cloned}");
        assert!(msg.contains("detached tag mismatch"));
        // It is NOT one of the other variants.
        assert!(!matches!(err, CryptoError::Policy(_)));
    }
}
```

Update `crypto/core/src/lib.rs` — add `pub mod secret;`, `pub mod util;` and re-exports:

```rust
pub use secret::SecretBox;
pub use util::constant_time_eq;
```

- [ ] **Step 2: Run tests to verify they pass**

Run: `cargo test --manifest-path crypto/core/Cargo.toml`
Expected: PASS — `secret::tests::secret_box_holds_and_exposes_bytes`, `util::tests::equal_and_unequal`, and `error::tests::backend_error_is_type_erased_and_cloneable` all pass; all earlier tests still pass.

- [ ] **Step 3: Commit**

```bash
git add crypto/core/src/secret.rs crypto/core/src/util.rs crypto/core/src/error.rs crypto/core/src/lib.rs
git commit -m "feat(crypto-core): add SecretBox, constant_time_eq, error tests"
```

---

### Task 9: Define `TrustState`, `CryptoBackend` trait, `KeyStore` trait

**Files:**
- Create: `crypto/core/src/trust.rs`
- Create: `crypto/core/src/backend.rs`
- Create: `crypto/core/src/keystore.rs`
- Modify: `crypto/core/src/lib.rs`

**Interfaces:**
- Consumes: envelope types, `KeyHandle`/`KeyHandleRef`, `CryptoPolicy`, `CryptoError`, `SecretBox`, `Standard` (Tasks 4–8)
- Produces: `TrustState`, `EncryptOp`/`DecryptOp`/`SignOp`/`VerifyOp`, `KeyGenParams`, `CryptoBackend` (async trait), `KeyStore` trait

- [ ] **Step 1: Write the failing test + implementation**

Create `crypto/core/src/trust.rs`:

```rust
use serde::{Deserialize, Serialize};

/// Five-value acceptance ladder (Thunderbird model). Only `Verified` and
/// `Personal` auto-qualify a recipient key for encryption; below that, the
/// composer routes the recipient to the Key Assistant.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum TrustState {
    Rejected,
    Undecided,
    Unverified,
    Verified,
    Personal,
}

impl TrustState {
    /// A key at this level may be used to encrypt to a recipient without an
    /// explicit per-send confirmation.
    pub fn may_encrypt_to(self) -> bool {
        matches!(self, TrustState::Verified | TrustState::Personal)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_verified_and_personal_auto_qualify() {
        assert!(!TrustState::Unverified.may_encrypt_to());
        assert!(TrustState::Verified.may_encrypt_to());
        assert!(TrustState::Personal.may_encrypt_to());
        assert!(!TrustState::Rejected.may_encrypt_to());
    }
}
```

Create `crypto/core/src/backend.rs`:

```rust
use async_trait::async_trait;

use crate::envelope::{
    DecryptedPayload, EncryptedEnvelope, Part, SerializationStrategy, SignedEnvelope,
    VerificationResult,
};
use crate::error::Result;
use crate::handle::{KeyHandle, KeyHandleRef};
use crate::policy::CryptoPolicy;
use crate::secret::SecretBox;
use crate::standard::Standard;

/// Parameters for an encrypt operation.
#[derive(Debug, Clone)]
pub struct EncryptOp<'a> {
    pub parts: &'a [Part],
    pub serialization: SerializationStrategy,
    pub recipients: &'a [KeyHandleRef],
    pub sign_with: Option<KeyHandleRef>,
}

#[derive(Debug, Clone)]
pub struct DecryptOp<'a> {
    pub envelope: &'a EncryptedEnvelope,
    pub decryption_key: KeyHandleRef,
}

#[derive(Debug, Clone)]
pub struct SignOp<'a> {
    pub payload: &'a [u8],
    pub signing_key: KeyHandleRef,
    pub detached: bool,
}

#[derive(Debug, Clone)]
pub struct VerifyOp<'a> {
    pub signed: &'a SignedEnvelope,
}

#[derive(Debug, Clone)]
pub struct KeyGenParams {
    pub standard: Standard,
    pub user_id: String,
    pub algorithm: String,
    pub passphrase: Option<SecretBox<String>>,
}

/// The contract every standard backend implements. Verification is decoupled
/// from decryption — a message can be "decrypted OK, signature unverified".
///
/// Concrete backends (crypto-openpgp, crypto-smime, crypto-sm) are added in
/// later phases; this phase only proves the trait is usable and object-safe.
#[async_trait]
pub trait CryptoBackend: Send + Sync + 'static {
    fn standard(&self) -> Standard;
    fn policy(&self) -> &CryptoPolicy;

    async fn encrypt(&self, op: EncryptOp<'_>) -> Result<EncryptedEnvelope>;
    async fn decrypt(&self, op: DecryptOp<'_>) -> Result<DecryptedPayload>;
    async fn sign(&self, op: SignOp<'_>) -> Result<SignedEnvelope>;
    async fn verify(&self, op: VerifyOp<'_>) -> Result<VerificationResult>;

    async fn generate_key(&self, params: KeyGenParams) -> Result<KeyHandleRef>;
    async fn import_key(&self, data: &[u8], passphrase: Option<SecretBox<String>>)
        -> Result<KeyHandleRef>;
    async fn export_public(&self, handle: &KeyHandle) -> Result<Vec<u8>>;
}

/// A no-op backend used only to prove the trait compiles and is object-safe.
/// Real backends ship in later phases.
#[cfg(test)]
struct NoopBackend {
    policy: CryptoPolicy,
}

#[cfg(test)]
#[async_trait]
impl CryptoBackend for NoopBackend {
    fn standard(&self) -> Standard {
        Standard::OpenPgp
    }
    fn policy(&self) -> &CryptoPolicy {
        &self.policy
    }
    async fn encrypt(&self, _op: EncryptOp<'_>) -> Result<EncryptedEnvelope> {
        Err(crate::error::CryptoError::Malformed("noop backend".into()))
    }
    async fn decrypt(&self, _op: DecryptOp<'_>) -> Result<DecryptedPayload> {
        Err(crate::error::CryptoError::Malformed("noop backend".into()))
    }
    async fn sign(&self, _op: SignOp<'_>) -> Result<SignedEnvelope> {
        Err(crate::error::CryptoError::Malformed("noop backend".into()))
    }
    async fn verify(&self, _op: VerifyOp<'_>) -> Result<VerificationResult> {
        Err(crate::error::CryptoError::Malformed("noop backend".into()))
    }
    async fn generate_key(&self, _p: KeyGenParams) -> Result<KeyHandleRef> {
        Err(crate::error::CryptoError::Malformed("noop backend".into()))
    }
    async fn import_key(
        &self,
        _d: &[u8],
        _p: Option<SecretBox<String>>,
    ) -> Result<KeyHandleRef> {
        Err(crate::error::CryptoError::Malformed("noop backend".into()))
    }
    async fn export_public(&self, _h: &KeyHandle) -> Result<Vec<u8>> {
        Err(crate::error::CryptoError::Malformed("noop backend".into()))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn trait_is_object_safe_and_callable() {
        let backend: Box<dyn CryptoBackend> = Box::new(NoopBackend {
            policy: CryptoPolicy::default_baseline(),
        });
        assert_eq!(backend.standard(), Standard::OpenPgp);
        assert_eq!(backend.policy().min_rsa_bits, 3072);
        // Object-safe dispatch through the trait object.
        let op = SignOp {
            payload: b"",
            signing_key: KeyHandleRef {
                handle: KeyHandle::Software(crate::ids::KeyId("k".into())),
                standard: Standard::OpenPgp,
                fingerprint: crate::ids::Fingerprint::new("aa"),
                usage: crate::handle::KeyUsage::Sign,
                algorithm: "Ed25519".into(),
            },
            detached: true,
        };
        let res = backend.sign(op).await;
        assert!(res.is_err(), "noop backend always errors");
    }
}
```

Create `crypto/core/src/keystore.rs`:

```rust
use crate::error::Result;
use crate::handle::{KeyHandle, KeyHandleRef};
use crate::standard::Standard;

/// CRUD over `KeyHandle`s. Implementations back this with the `crypto_keys` /
/// `collected_keys` SQLite tables (Phase 1+) and, for token keys, PKCS#11
/// lookups (Phase 4).
pub trait KeyStore: Send + Sync {
    fn put(&self, key: KeyHandleRef) -> Result<()>;
    fn get(&self, handle: &KeyHandle) -> Result<Option<KeyHandleRef>>;
    fn find_by_email(&self, standard: Standard, email: &str) -> Result<Vec<KeyHandleRef>>;
    fn remove(&self, handle: &KeyHandle) -> Result<()>;
}
```

Update `crypto/core/src/lib.rs` — add `pub mod backend;`, `pub mod keystore;`, `pub mod trust;` and re-exports:

```rust
pub use backend::{CryptoBackend, DecryptOp, EncryptOp, KeyGenParams, SignOp, VerifyOp};
pub use keystore::KeyStore;
pub use trust::TrustState;
```

`backend.rs`'s test uses `#[tokio::test]`, so add `tokio` as a **dev-dependency** of `crypto-core`. In `crypto/core/Cargo.toml`, change the `[dev-dependencies]` block to:

```toml
[dev-dependencies]
serde_json = "1"
tokio = { version = "1", features = ["macros", "rt"] }
```

- [ ] **Step 2: Run tests to verify they pass**

Run: `cargo test --manifest-path crypto/core/Cargo.toml`
Expected: PASS — `trust::tests::only_verified_and_personal_auto_qualify` and `backend::tests::trait_is_object_safe_and_callable` pass; the whole crate still builds.

- [ ] **Step 3: Commit**

```bash
git add crypto/core/src/trust.rs crypto/core/src/backend.rs crypto/core/src/keystore.rs crypto/core/src/lib.rs crypto/core/Cargo.toml
git commit -m "feat(crypto-core): add CryptoBackend/KeyStore traits, TrustState, op structs"
```

---

### Task 10: Wire `crypto-core` as a backend path dependency + integration test

**Files:**
- Modify: `kylins.client.backend/Cargo.toml`
- Create: `kylins.client.backend/tests/crypto_core_wiring.rs`

**Interfaces:**
- Consumes: `crypto-core` crate (Tasks 4–9)
- Produces: backend can consume `crypto_core::*`; Phase 0 complete.

- [ ] **Step 1: Write the failing test**

Create `kylins.client.backend/tests/crypto_core_wiring.rs`:

```rust
//! Proves the backend can consume the `crypto-core` crate across the path
//! dependency, and that the neutral envelope + key-handle types round-trip
//! across the serde boundary the IPC layer will use.

use crypto_core::{
    EncryptedEnvelope, EncryptedPart, KeyHandle, KeyHandleRef, KeyId, KeyPacketRef, KeyUsage,
    Fingerprint, PartId, PartKind, SerializationStrategy, Standard,
};

#[test]
fn neutral_envelope_roundtrips_through_serde() {
    let recipient = KeyHandleRef {
        handle: KeyHandle::Software(KeyId("sign-1".into())),
        standard: Standard::Smime,
        fingerprint: Fingerprint::new("AABBCCDD"),
        usage: KeyUsage::SignAndEncrypt,
        algorithm: "RSA-4096".into(),
    };
    let env = EncryptedEnvelope {
        standard: Standard::Smime,
        serialization: SerializationStrategy::SingleMimeBlob,
        parts: vec![EncryptedPart {
            id: PartId("body".into()),
            kind: PartKind::Body,
            ciphertext: vec![0xDE, 0xAD, 0xBE, 0xEF],
            signature: None,
        }],
        recipients: vec![KeyPacketRef { recipient, packet: vec![1, 2, 3, 4] }],
    };
    let json = serde_json::to_string(&env).expect("serialize envelope");
    let back: EncryptedEnvelope = serde_json::from_str(&json).expect("deserialize envelope");
    assert_eq!(back.parts.len(), 1);
    assert_eq!(back.serialization, SerializationStrategy::SingleMimeBlob);
    assert_eq!(back.standard, Standard::Smime);
}

#[test]
fn vault_aad_roundtrip_from_backend() {
    // The hardened v1 vault is usable from the backend's own crate root.
    let blob =
        kylins_client_lib::crypto::encrypt_with_aad(b"identity-key-blob", b"kylins:acct-1:smime:1")
            .expect("encrypt_with_aad");
    let pt = kylins_client_lib::crypto::decrypt_with_aad(&blob, b"kylins:acct-1:smime:1")
        .expect("decrypt_with_aad");
    assert_eq!(pt, b"identity-key-blob");
}
```

- [ ] **Step 2: Add the path dependency**

In `kylins.client.backend/Cargo.toml`, in the `# Secrets` section (after the `subtle = "2"` line added in Task 1), add:

```toml
# Crypto framework core (neutral envelope + KeyHandle + CryptoBackend trait).
crypto-core = { path = "../crypto/core" }
```

Also expose the hardened vault + crypto module to the integration test. The backend lib already has `pub mod crypto;` in `src/lib.rs`, and Task 2–3 made `encrypt_with_aad`/`decrypt_with_aad` `pub`. Verify those are `pub` (they are). No other change needed.

- [ ] **Step 3: Run test to verify it fails then passes**

Run: `cargo test --manifest-path kylins.client.backend/Cargo.toml --test crypto_core_wiring`
Expected: PASS — both `neutral_envelope_roundtrips_through_serde` and `vault_aad_roundtrip_from_backend` pass. (If it fails with "unresolved import `crypto_core`", confirm the path dep resolves: `cargo tree --manifest-path kylins.client.backend/Cargo.toml -i crypto-core`.)

- [ ] **Step 4: Run the full backend + framework test suites**

Run: `cargo test --manifest-path kylins.client.backend/Cargo.toml` then `cargo test --manifest-path crypto/Cargo.toml`
Expected: both suites PASS, no regressions.

- [ ] **Step 5: Commit**

```bash
git add kylins.client.backend/Cargo.toml kylins.client.backend/Cargo.lock kylins.client.backend/tests/crypto_core_wiring.rs
git commit -m "feat(crypto): wire crypto-core into backend; phase 0 foundation complete"
```

---

## Phase 0 completion criteria

- `kylins.client.backend/src/crypto.rs` holds the master key as a zeroizing `SecretBox`, keeps the legacy v0 `encrypt`/`decrypt` working, and exposes a versioned AAD-bound v1 API (`encrypt_with_aad`/`decrypt_with_aad`).
- A standalone `crypto/` workspace exists with a `crypto-core` crate compiling with **zero** engine dependencies, exposing: `Standard`, key identity types (`KeyHandle`/`KeyHandleRef`/`KeyId`/`TokenKeyId`/`Fingerprint`), the neutral envelope (`EncryptedEnvelope`/`Part`/`EncryptedPart`/`SerializationStrategy`/…), `CryptoPolicy` + algorithm enums, type-erased `CryptoError`, `SecretBox`, `constant_time_eq`, `TrustState`, the async `CryptoBackend` trait (with op structs), and the `KeyStore` trait.
- The backend depends on `crypto-core` and an integration test proves cross-crate usage.
- All tests green; no regressions.

The next plan (Phase 1 — S/MIME) builds the first real `CryptoBackend` (`crypto-smime`), the `crypto_keys`/`trust_decisions`/`collected_keys` SQLite migrations, and the send/receive + CryptoBadge UI.
