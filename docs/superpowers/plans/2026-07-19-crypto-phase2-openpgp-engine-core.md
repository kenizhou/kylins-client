# Crypto Phase 2 — OpenPGP Engine Core Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a `crypto-openpgp` crate that implements `crypto_core::CryptoBackend` over the Sequoia engine, with key gen/import/export + encrypt/decrypt/sign/verify proven by round-trip and cross-impl tests — no mail hooks, no frontend, no dispatch.

**Architecture:** A new workspace member `kylins.client.crypto/openpgp/` mirrors `smime/`. `OpenpgpBackend::new(Arc<dyn KeyStore>, CryptoPolicy)` resolves `KeyHandleRef`s to Sequoia `Cert`s via the held `KeyStore` and implements all nine `CryptoBackend` methods over `sequoia-openpgp` (pure-Rust `crypto-rust` backend). Engine-core tests use an in-memory `KeyStore`; the real `SqliteKeyStore` round-trip is deferred to the send slice. Task 1 is a Sequoia API spike that pins the dep version and verifies every Sequoia call sequence before later tasks adapt it.

**Tech Stack:** Rust (Tauri v2 backend workspace) · `sequoia-openpgp` 2.x (`default-features = false`, `crypto-rust` — pure-Rust, zero C deps) · `crypto-core` (path) · `zeroize` · `async-trait` · `tokio` (rt for `spawn_blocking`) · `sequoia-sq`/`gpg` (interop tests, skip-if-absent).

## Global Constraints

- **Branch:** `feat/crypto-openpgp-engine-core` (off `main` @ `33fb7a4`, the post-encryption-granularity merge).
- **Commit policy:** per-task commits on the branch, **NO push**; stage ONLY specific files; **NO** `git add -A` / `stash -u` / `clean`. Conventional-commit messages (`feat(crypto-openpgp): ...`, `test(crypto-openpgp): ...`, `refactor(crypto-openpgp): ...`). User controls merge/push.
- **Slice boundary:** this plan touches ONLY `kylins.client.crypto/` (workspace `Cargo.toml` + the new `openpgp/` member). **No backend `.rs` or `Cargo.toml` changes. No frontend changes. No migrations.**
- **Private key material never crosses IPC** (only `KeyHandleRef`s). Soft private keys are wrapped at rest by the master key when persisted (engine-core uses an in-memory store, so this is exercised in the send slice; the invariant still holds by construction). Unlocked secret material is held as `Zeroizing<...>`.
- **Write path** never emits MD5/SHA-1/3DES/DSA/Elgamal; RSA *recipient* keys require ≥3072 bits; RSA *generation* is rejected this slice.
- **Read path** accepts legacy algorithms (RSA any size, SHA-1, 3DES) for decrypt/verify and records a weak-algo warning.
- **CPU-bound Sequoia work runs via `tokio::task::spawn_blocking`** inside the async trait methods.
- **Contract source of truth:** `kylins.client.crypto/core/src/` — read the exact type signatures from there; do not invent field names. Key types (verified): `CryptoBackend` (`backend.rs:59`), `EncryptOp`/`DecryptOp`/`SignOp`/`VerifyOp`/`KeyGenParams` (`backend.rs:14-51`), `EncryptedEnvelope`/`SignedEnvelope`/`DecryptedPayload`/`Part`/`EncryptedPart`/`DetachedSignature`/`KeyPacketRef`/`VerificationResult`/`SignatureState`/`SerializationStrategy` (`envelope.rs`), `KeyHandleRef`/`KeyHandle`/`KeyUsage` (`handle.rs`), `KeyId`/`Fingerprint`/`TokenKeyId` (`ids.rs`), `Standard` (`standard.rs`), `CryptoPolicy` (`policy.rs`), `KeyStore`/`StoredKey` (`keystore.rs`), `SecretBox` (`secret.rs`).
- **Verification gate (per task):** `cd kylins.client.crypto && cargo test -p crypto-openpgp && cargo clippy -p crypto-openpgp --all-targets -- -D warnings`. **Workspace gate (final):** `cd kylins.client.crypto && cargo test && cargo clippy --all-targets -- -D warnings` (core + smime stay green). Bash cwd is the repo root — always prefix the `cd`.

## File Structure

```text
kylins.client.crypto/
  Cargo.toml                       MODIFY: add "openpgp" to [workspace] members
  openpgp/
    Cargo.toml                     CREATE: crypto-core (path), sequoia-openpgp (crypto-rust), zeroize, async-trait, tokio, [dev-dependencies] tempfile maybe
    src/
      lib.rs                       CREATE: OpenpgpBackend struct + CryptoBackend impl + pub re-exports
      engine.rs                    CREATE: Sequoia wrapper (the ONLY module that imports sequoia_openpgp)
      keymap.rs                    CREATE: Cert <-> KeyHandleRef, Cert <-> StoredKey blob, passphrase handling
      policy.rs                    CREATE: crypto-core CryptoPolicy <-> Sequoia StandardPolicy + weak-algo detection
      error.rs                     CREATE: openpgp::Error -> crypto_core::CryptoError mapping
    tests/
      spike.rs                     CREATE (Task 1): API-validation round-trips; lives only until folded into round_trip.rs
      common/
        mod.rs                     CREATE: in-memory KeyStore impl + shared test helpers
      round_trip.rs                CREATE: end-to-end self round-trips against the in-memory KeyStore
      interop.rs                   CREATE: sequoia-sq / gpg cross-impl (skip-if-absent)
```

Each module has one responsibility; only `engine.rs` touches Sequoia, so the Sequoia version can be swapped/re-validated in one place. `lib.rs` is the thin `CryptoBackend` wiring.

---

## Task 1: Sequoia API spike + crate scaffold

De-risk the engine: pin the Sequoia version, confirm the `crypto-rust` backend compiles in the workspace, and prove every Sequoia call sequence this slice needs. The spike tests are throwaway validation; later tasks adapt the verified patterns. **Sign/verify and `StandardPolicy` customization are explicitly verified here** (Context7 surfaced encrypt/decrypt/generate/parse but not these).

**Files:**
- Modify: `kylins.client.crypto/Cargo.toml` (add `"openpgp"` to `[workspace] members`).
- Create: `kylins.client.crypto/openpgp/Cargo.toml`
- Create: `kylins.client.crypto/openpgp/src/lib.rs` (empty crate root for now)
- Create: `kylins.client.crypto/openpgp/tests/spike.rs`
- Create: `kylins.client.crypto/openpgp/spike-notes.md`

**Interfaces:**
- Consumes: `sequoia-openpgp` (new dep), `crypto-core` (path, for `Standard::OpenPgp` only at this stage).
- Produces: a compiling `crypto-openpgp` workspace member + `spike-notes.md` recording the exact Sequoia API signatures Tasks 5–7 adapt.

- [ ] **Step 1: Add the workspace member**

Edit `kylins.client.crypto/Cargo.toml`; in the `[workspace]` `members` array add `"openpgp"` alongside `"core"` and `"smime"`.

- [ ] **Step 2: Write the crate `Cargo.toml`**

Create `kylins.client.crypto/openpgp/Cargo.toml`:

```toml
[package]
name = "crypto-openpgp"
version = "0.1.0"
edition = "2021"

[dependencies]
crypto-core = { path = "../core" }
sequoia-openpgp = { version = "2", default-features = false, features = ["crypto-rust"] }
zeroize = { version = "1.8", features = ["zeroize_derive"] }
async-trait = "0.1"
tokio = { version = "1", features = ["rt", "rt-multi-thread"] }

[dev-dependencies]
# add tempfile here only if a later task needs it; the spike is in-memory
```

> If `cargo` resolves `sequoia-openpgp = "2"` to a version whose `crypto-rust` feature differs, pin the exact `2.x` patch here and record it in `spike-notes.md`.

- [ ] **Step 3: Empty crate root**

Create `kylins.client.crypto/openpgp/src/lib.rs`:

```rust
//! OpenPGP crypto backend (Sequoia engine). Implements `crypto_core::CryptoBackend`.
```

- [ ] **Step 4: Write the spike test — generate / encrypt / decrypt / parse / serialize / passphrase**

Create `kylins.client.crypto/openpgp/tests/spike.rs`. Adapt this verified pattern (from Sequoia's `generate-encrypt-decrypt` example) into a `#[test]`:

```rust
//! Sequoia API spike — validates the exact call sequences Tasks 5–7 depend on.
//! Throwaway: folded into round_trip.rs once the backend is complete.
use sequoia_openpgp as openpgp;
use openpgp::cert::prelude::*;
use openpgp::parse::stream::*;
use openpgp::parse::Parse;
use openpgp::policy::StandardPolicy as P;
use openpgp::serialize::stream::*;
use std::io::{self, Read, Write};

const P_: &P = &P::new();

fn gen() -> openpgp::Result<openpgp::Cert> {
    let (cert, _rev) = CertBuilder::new()
        .add_userid("spike@example.org")
        .add_transport_encryption_subkey()
        .add_signing_subkey()
        .generate()?;
    Ok(cert)
}

#[test]
fn spike_generate_encrypt_decrypt_roundtrip() -> openpgp::Result<()> {
    let cert = gen()?;
    let plaintext = b"hello sequoia";

    // encrypt
    let mut ct = Vec::new();
    let recipients = cert.keys().with_policy(P_, None).supported().alive()
        .revoked(false).for_transport_encryption();
    let msg = Encryptor::for_recipients(Message::new(&mut ct), recipients).build()?;
    let mut w = LiteralWriter::new(msg).build()?;
    w.write_all(plaintext)?;
    w.finalize()?;

    // decrypt (Helper providing the secret key + a permissive verifier)
    struct H<'a> { secret: &'a openpgp::Cert }
    impl<'a> VerificationHelper for H<'a> {
        fn get_certs(&mut self, _: &[openpgp::KeyHandle]) -> openpgp::Result<Vec<openpgp::Cert>> { Ok(vec![]) }
        fn check(&mut self, _: MessageStructure) -> openpgp::Result<()> { Ok(()) }
    }
    impl<'a> DecryptionHelper for H<'a> {
        fn decrypt(&mut self, pkesks: &[openpgp::packet::PKESK], _skesks: &[openpgp::packet::SKESK],
            sym_algo: Option<openpgp::types::SymmetricAlgorithm>,
            decrypt: &mut dyn FnMut(Option<openpgp::types::SymmetricAlgorithm>, &openpgp::crypto::SessionKey) -> bool)
            -> openpgp::Result<Option<openpgp::Cert>> {
            let key = self.secret.keys().unencrypted_secret().with_policy(P_, None)
                .for_transport_encryption().next().unwrap().key().clone();
            let mut pair = key.into_keypair()?;
            pkesks[0].decrypt(&mut pair, sym_algo).map(|(a, sk)| decrypt(a, &sk));
            Ok(None)
        }
    }
    let helper = H { secret: &cert };
    let mut pt = Vec::new();
    let mut dec = DecryptorBuilder::from_bytes(&ct)?.with_policy(P_, None, helper)?;
    io::copy(&mut dec, &mut pt)?;
    assert_eq!(pt, plaintext);
    Ok(())
}

#[test]
fn spike_cert_armor_parse_roundtrip() -> openpgp::Result<()> {
    let cert = gen()?;
    let mut armored = Vec::new();
    cert.armored().serialize(&mut armored)?;
    let parsed: Vec<openpgp::Cert> = CertParser::from_bytes(&armored)?
        .collect::<openpgp::Result<Vec<_>>>()?;
    assert_eq!(parsed.len(), 1);
    assert_eq!(parsed[0].fingerprint(), cert.fingerprint());
    Ok(())
}
```

- [ ] **Step 5: Run the spike — confirm the version + backend compile and the round-trips pass**

Run: `cd kylins.client.crypto && cargo test -p crypto-openpgp --test spike`
Expected: PASS (2 tests). If compilation fails on the `crypto-rust` feature or version, adjust the pin in `Cargo.toml` and re-run until green.

- [ ] **Step 6: Verify + record the sign/verify and policy APIs (Context7 gap)**

Context7 did not surface these; confirm them against the pinned version's docs (docs.rs/sequoia-openpgp) and the Sequoia `sign.rs`/`verify.rs` examples, then write a `spike-sign-verify` test that exercises them, and record the exact signatures in `spike-notes.md`. Specifically validate, using the `cert` from `gen()`:

- **Detached sign:** `Signer::detached(Message::new(&mut sig_buf), &[signing_keypair])?` then `sig_buf` holds the detached signature packet. (Confirm the exact constructor — `Signer::detached` vs `Signer::new(...).detached()`.)
- **Inline sign:** `Signer::new(Message::new(&mut out), vec![signing_keypair]).build()?` → `LiteralWriter` → write → `finalize()`.
- **Detached verify:** `DetachedVerifier::from_bytes(&sig, &mut msg_bytes, helper)?` where `helper: VerificationHelper` returns the signer `Cert` from `get_certs` and accepts a valid `MessageStructure` in `check`.
- **Inline verify:** `Verifier::from_bytes(&signed, helper)?` then read plaintext + rely on `check`.
- **Policy customization:** confirm how to build a relaxed `Policy` for the legacy read path (e.g. `StandardPolicy` mutation / a custom `dyn Policy`) and how to read the algorithm used by a signature (`Signature` packet's `hash_algo()` / `pk_algo()`) for the weak-algo detector.

Write the exact verified signatures into `kylins.client.crypto/openpgp/spike-notes.md` under headings `## detached-sign`, `## inline-sign`, `## detached-verify`, `## inline-verify`, `## policy-customization`, `## weak-algo-detection`. Each entry: the call sequence + one sentence on what it returns.

Add a `#[test] fn spike_sign_verify_roundtrip()` to `tests/spike.rs` proving detached sign → verify over a payload both succeeds and (after tampering) fails.

- [ ] **Step 7: Run the full spike + clippy**

Run: `cd kylins.client.crypto && cargo test -p crypto-openpgp --test spike && cargo clippy -p crypto-openpgp --all-targets -- -D warnings`
Expected: PASS (3 tests), clippy clean.

- [ ] **Step 8: Commit**

```bash
git add kylins.client.crypto/Cargo.toml kylins.client.crypto/openpgp/Cargo.toml kylins.client.crypto/openpgp/src/lib.rs kylins.client.crypto/openpgp/tests/spike.rs kylins.client.crypto/openpgp/spike-notes.md
git commit -m "feat(crypto-openpgp): sequoia API spike + crate scaffold (Task 1)"
```

---

## Task 2: error mapping (`error.rs`)

Map Sequoia's error type onto `crypto_core::CryptoError`. Pure, unit-tested, no Sequoia calls.

**Files:**
- Create: `kylins.client.crypto/openpgp/src/error.rs`
- Modify: `kylins.client.crypto/openpgp/src/lib.rs` (`pub mod error;` + re-export `CryptoError`)

**Interfaces:**
- Consumes: `crypto_core::CryptoError`, `sequoia_openpgp::Error`.
- Produces: `crate::error::{map_err, CryptoResult}` helpers used by every later module.

- [ ] **Step 1: Write the failing test**

Create `kylins.client.crypto/openpgp/src/error.rs` with a `#[cfg(test)]` block:

```rust
//! `sequoia_openpgp::Error` -> `crypto_core::CryptoError` mapping.
use crypto_core::CryptoError;

pub type CryptoResult<T> = Result<T, CryptoError>;

/// Wrap a Sequoia result into the framework's type-erased error.
pub fn map_err<T, E>(r: std::result::Result<T, E>) -> CryptoResult<T>
where
    E: std::fmt::Display,
{
    r.map_err(|e| CryptoError::Malformed(e.to_string()))
}

/// Build a policy-rejection error (weak/unsupported algorithm, bad passphrase, etc.).
pub fn policy<S: Into<String>>(msg: S) -> CryptoError {
    CryptoError::Malformed(msg.into())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn ok_passes_through() {
        let r: CryptoResult<i32> = map_err(Ok(7));
        assert_eq!(r.unwrap(), 7);
    }
    #[test]
    fn err_is_mapped_to_malformed() {
        let r: CryptoResult<i32> = map_err(Err("nope".to_string()));
        let e = r.unwrap_err();
        assert!(matches!(e, CryptoError::Malformed(s) if s.contains("nope")));
    }
}
```

> Confirm `CryptoError::Malformed(String)` is the correct variant by reading `kylins.client.crypto/core/src/error.rs` first; if the framework names it differently (e.g. `Other`, `Engine`), use that variant. This is the only assumption in this task.

- [ ] **Step 2: Run test to verify it fails (module not declared)**

Run: `cd kylins.client.crypto && cargo test -p crypto-openpgp error`
Expected: compile error — `error` module not declared in `lib.rs`.

- [ ] **Step 3: Declare the module**

In `kylins.client.crypto/openpgp/src/lib.rs` add:

```rust
pub mod error;
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd kylins.client.crypto && cargo test -p crypto-openpgp error`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add kylins.client.crypto/openpgp/src/error.rs kylins.client.crypto/openpgp/src/lib.rs
git commit -m "feat(crypto-openpgp): error mapping error.rs (Task 2)"
```

---

## Task 3: Cert ↔ key-handle / blob mapping (`keymap.rs`)

Translate between Sequoia `Cert`s and the framework's `KeyHandleRef` / `StoredKey`-style blobs. No `KeyStore` trait use yet (that lands in Task 8); this module is the pure (de)serialization + handle-construction layer.

**Files:**
- Create: `kylins.client.crypto/openpgp/src/keymap.rs`
- Modify: `kylins.client.crypto/openpgp/src/lib.rs` (`pub mod keymap;`)

**Interfaces:**
- Consumes: `crypto_core::{Standard, KeyHandleRef, KeyHandle, KeyId, Fingerprint, KeyUsage}`; `sequoia_openpgp::Cert`.
- Produces:
  - `pub fn cert_to_handle(cert: &openpgp::Cert) -> KeyHandleRef`
  - `pub fn cert_to_secret_blob(cert: &openpgp::Cert) -> CryptoResult<Vec<u8>>` (binary TPK, secret material)
  - `pub fn cert_to_public_blob(cert: &openpgp::Cert) -> CryptoResult<Vec<u8>>` (binary TPK, public only)
  - `pub fn cert_to_armored_public(cert: &openpgp::Cert) -> CryptoResult<Vec<u8>>`
  - `pub fn parse_certs(data: &[u8]) -> CryptoResult<Vec<openpgp::Cert>>` (armor + binary, via `CertParser`)
  - `pub fn fingerprint_of(cert: &openpgp::Cert) -> Fingerprint` → `Fingerprint::new(&cert.fingerprint().to_hex())`

- [ ] **Step 1: Write the failing test**

Create `kylins.client.crypto/openpgp/src/keymap.rs` with a `#[cfg(test)]` block that generates a `Cert` (reuse a local copy of the Task-1 `gen()` helper, duplicated per the no-cross-task-assumption rule), then asserts:
- `cert_to_handle(cert).standard == Standard::OpenPgp`
- `cert_to_handle(cert).usage == KeyUsage::SignAndEncrypt`
- `cert_to_handle(cert).fingerprint == fingerprint_of(cert)`
- `cert_to_handle(cert).handle` is `KeyHandle::Software(KeyId(s))` with `s == "openpgp|{hex fp}"`
- `parse_certs(&cert_to_public_blob(cert))` returns one Cert with the same fingerprint
- `parse_certs(&cert_to_armored_public(cert))` returns one Cert with the same fingerprint
- `cert_to_secret_blob` then `parse_certs` yields a Cert with a secret (`keys().secret()` is present)

Use the Task-1 spike `CertBuilder` pattern for `gen()`; duplicate it in the test module.

- [ ] **Step 2: Run test to verify it fails**

Run: `cd kylins.client.crypto && cargo test -p crypto-openpgp keymap`
Expected: compile error (module not declared).

- [ ] **Step 3: Implement `keymap.rs`**

```rust
//! Sequoia `Cert` <-> framework `KeyHandleRef` / blob translations.
use crypto_core::{Fingerprint, KeyHandle, KeyHandleRef, KeyId, KeyUsage, Standard};
use sequoia_openpgp as openpgp;
use sequoia_openpgp::cert::prelude::*;
use sequoia_openpgp::parse::Parse;

use crate::error::CryptoResult;

pub fn fingerprint_of(cert: &openpgp::Cert) -> Fingerprint {
    Fingerprint::new(cert.fingerprint().to_hex())
}

/// Build the framework handle for a Cert (cert-level: both subkeys present ⇒ SignAndEncrypt).
pub fn cert_to_handle(cert: &openpgp::Cert) -> KeyHandleRef {
    let fp = fingerprint_of(cert);
    KeyHandleRef {
        handle: KeyHandle::Software(KeyId(format!("openpgp|{}", fp.as_ref()))),
        standard: Standard::OpenPgp,
        fingerprint: fp,
        usage: KeyUsage::SignAndEncrypt,
        algorithm: "Ed25519/X25519".to_string(),
    }
}

pub fn cert_to_secret_blob(cert: &openpgp::Cert) -> CryptoResult<Vec<u8>> {
    let mut buf = Vec::new();
    crate::error::map_err(cert.serialize(&mut buf))?;
    Ok(buf)
}

pub fn cert_to_public_blob(cert: &openpgp::Cert) -> CryptoResult<Vec<u8>> {
    let stripped = crate::error::map_err(cert.clone().strip_secret())?;
    let mut buf = Vec::new();
    crate::error::map_err(stripped.serialize(&mut buf))?;
    Ok(buf)
}

pub fn cert_to_armored_public(cert: &openpgp::Cert) -> CryptoResult<Vec<u8>> {
    let mut buf = Vec::new();
    crate::error::map_err(cert.armored().serialize(&mut buf))?;
    Ok(buf)
}

pub fn parse_certs(data: &[u8]) -> CryptoResult<Vec<openpgp::Cert>> {
    let parsed = openpgp::CertParser::from_bytes(data)
        .map_err(|e| crypto_core::CryptoError::Malformed(e.to_string()))?;
    let mut out = Vec::new();
    for c in parsed {
        out.push(crate::error::map_err(c)?);
    }
    Ok(out)
}
```

> Verify `Fingerprint::as_ref()` / `Deref` and `cert.clone().strip_secret()` against `core/src/ids.rs` and the Sequoia `Cert` API during implementation; adjust to the exact method if named differently.

- [ ] **Step 4: Declare module + run test**

Add `pub mod keymap;` to `lib.rs`. Run: `cd kylins.client.crypto && cargo test -p crypto-openpgp keymap`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add kylins.client.crypto/openpgp/src/keymap.rs kylins.client.crypto/openpgp/src/lib.rs
git commit -m "feat(crypto-openpgp): cert<->handle/blob mapping keymap.rs (Task 3)"
```

---

## Task 4: policy bridge + weak-algo detection (`policy.rs`)

Translate `crypto_core::CryptoPolicy` into a Sequoia `&dyn Policy` for the **write** path (modern allow-set) and a relaxed policy for the **read** path, plus the weak-algorithm detector.

**Files:**
- Create: `kylins.client.crypto/openpgp/src/policy.rs`
- Modify: `kylins.client.crypto/openpgp/src/lib.rs` (`pub mod policy;`)

**Interfaces:**
- Consumes: `crypto_core::CryptoPolicy`; the `StandardPolicy` customization pattern recorded in Task 1 `spike-notes.md ## policy-customization`.
- Produces:
  - `pub struct PgpPolicy { write: ..., read: ..., weak: WeakAlgoDetector }`
  - `pub fn from_core(p: &CryptoPolicy) -> PgpPolicy`
  - `impl PgpPolicy { pub fn write_policy(&self) -> &dyn openpgp::policy::Policy; pub fn read_policy(&self) -> &dyn openpgp::policy::Policy; pub fn note_weak(&self, sig_or_msg: ...) -> Option<String> }`

- [ ] **Step 1: Write the failing test**

`#[cfg(test)]` asserting:
- `from_core(&CryptoPolicy::default_baseline()).write_policy()` is a `StandardPolicy` (modern).
- A helper `is_weak_read_algo(SymmetricAlgorithm::TripleDes)` (or the Sequoia enum equivalent) returns `true`; `Aes256` returns `false`.
- The write policy rejects a SHA-1 signature context (construct a tiny fixture or assert via the policy's accepted-hash set).

- [ ] **Step 2: Run test to verify it fails**

Run: `cd kylins.client.crypto && cargo test -p crypto-openpgp policy` → compile error (module not declared).

- [ ] **Step 3: Implement `policy.rs`**

Build two `StandardPolicy` instances (or one `StandardPolicy` + a custom relaxed `dyn Policy` per the Task-1 `## policy-customization` notes): `write` = a fresh `StandardPolicy::new()` (modern defaults already exclude SHA-1/3DES/DSA at production strength); `read` = a `StandardPolicy` configured to also admit legacy algorithms so decrypt/verify of old mail succeeds. `note_weak` inspects the `Signature`/`Message` algorithm fields the spike identified (`## weak-algo-detection`) and returns a human warning string when a legacy algo (SHA-1, 3DES, RSA<3072) is seen.

> The exact `StandardPolicy` relaxation API is whatever Task 1 recorded. Do not guess — copy from `spike-notes.md`. If Sequoia's `StandardPolicy` cannot be cheaply mutated, implement a small custom struct implementing `openpgp::policy::Policy` that delegates to `StandardPolicy` and broadens the legacy set on the read path.

- [ ] **Step 4: Declare module + run test**

Add `pub mod policy;`. Run: `cd kylins.client.crypto && cargo test -p crypto-openpgp policy`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add kylins.client.crypto/openpgp/src/policy.rs kylins.client.crypto/openpgp/src/lib.rs
git commit -m "feat(crypto-openpgp): policy bridge + weak-algo detection policy.rs (Task 4)"
```

---

## Task 5: engine — generate / import / export (`engine.rs` part 1)

The Sequoia wrapper. This task implements key generation, import, and public export — the non-streaming key ops. Adapt the verified Task-1 spike patterns.

**Files:**
- Create: `kylins.client.crypto/openpgp/src/engine.rs`
- Modify: `kylins.client.crypto/openpgp/src/lib.rs` (`pub mod engine;`)

**Interfaces:**
- Consumes: `crypto_core::{KeyGenParams, KeyHandleRef, KeyHandle, SecretBox, Standard}`; `crate::{keymap, policy, error}`; Task-1 spike `gen()` pattern.
- Produces:
  - `pub fn generate(user_id: &str) -> CryptoResult<openpgp::Cert>` — Ed25519 primary + X25519 enc-subkey + Ed25519 sign-subkey, via `CertBuilder::new().add_userid(user_id).add_transport_encryption_subkey().add_signing_subkey().generate()`.
  - `pub fn import(data: &[u8], passphrase: Option<SecretBox<String>>) -> CryptoResult<openpgp::Cert>` — `CertParser` → first cert; if its secret is encrypted, decrypt with the passphrase via `secret_mut().decrypt_in_place(...)` (Task-1 `## passphrase` pattern); reject encrypted-secret-without-passphrase with `error::policy(...)`.
  - `pub fn export_armored_public(cert: &openpgp::Cert) -> CryptoResult<Vec<u8>>` — delegates to `keymap::cert_to_armored_public`.

- [ ] **Step 1: Write the failing test**

`#[cfg(test)]`:
- `generate("a@b.c")` → cert with a transport-encryption subkey and a signing subkey (`cert.keys().for_transport_encryption().next().is_some()` etc.).
- `import(&export_armored_public(cert), None)` parses to a cert with the same fingerprint (public-only round-trip).
- Generate a passphrased cert in the test (or import a fixture), then `import` without the passphrase returns `Err`; with the correct passphrase returns `Ok`.

- [ ] **Step 2: Run test to verify it fails** → `cargo test -p crypto-openpgp engine` compile error.

- [ ] **Step 3: Implement `engine.rs`** using the Task-1 spike `gen()` body for `generate`, the `CertParser` + `decrypt_in_place` pattern for `import`, and the keymap delegation for export. Wrap every Sequoia call in `error::map_err`. Hold any unlocked secret bytes in `Zeroizing` where they materialize.

- [ ] **Step 4: Declare module + run test**

`pub mod engine;`. Run: `cd kylins.client.crypto && cargo test -p crypto-openpgp engine`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add kylins.client.crypto/openpgp/src/engine.rs kylins.client.crypto/openpgp/src/lib.rs
git commit -m "feat(crypto-openpgp): engine generate/import/export (Task 5)"
```

---

## Task 6: engine — encrypt / decrypt (`engine.rs` part 2)

Streaming encrypt/decrypt of `Part` bytes (`SingleMimeBlob`), including sign-then-encrypt. Adapt the Task-1 spike `Encryptor`/`DecryptorBuilder` + `Helper` pattern.

**Files:**
- Modify: `kylins.client.crypto/openpgp/src/engine.rs`
- Test: `kylins.client.crypto/openpgp/src/engine.rs` (`#[cfg(test)]`)

**Interfaces:**
- Consumes: `crypto_core::{Part, PartKind, PartId, EncryptedEnvelope, EncryptedPart, KeyPacketRef, SerializationStrategy, KeyHandleRef}`, the held `KeyStore` (resolves recipient + decryption `KeyHandleRef` → `openpgp::Cert`), Task-1 spike encrypt/decrypt pattern.
- Produces:
  - `pub fn encrypt(parts: &[Part], serialization: SerializationStrategy, recipients: &[openpgp::Cert], sign_with: Option<&openpgp::Cert>, policy: &PgpPolicy) -> CryptoResult<EncryptedEnvelope>`
  - `pub fn decrypt(envelope: &EncryptedEnvelope, decryption_cert: &openpgp::Cert, policy: &PgpPolicy) -> CryptoResult<(DecryptedPayload, Option<String>)>` — returns plaintext parts + optional weak-algo warning from `policy.note_weak`.

- [ ] **Step 1: Write the failing test**

`#[cfg(test)]`:
- Build one `Part { id: PartId("body".into()), kind: PartKind::Body, data: b"hi".to_vec() }`; generate a recipient cert; `encrypt(&[part], SingleMimeBlob, &[cert], None, &pol)` → envelope with exactly one `EncryptedPart` and ≥1 `KeyPacketRef`; `decrypt(&env, &cert, &pol)` → `DecryptedPayload` whose single part's `data == b"hi"`.
- Sign-then-encrypt: `sign_with = Some(&signer_cert)`; on decrypt the embedded signature is verified (the framework's `DecryptedPayload` carries plaintext only — verify-success is asserted by re-running `engine::verify` over the recovered plaintext in Task 8's integration test, or by a dedicated helper here).
- Weak-algo: synthesize/fixture a legacy-encrypted message (skip if a fixture is impractical — record in `spike-notes.md`).

- [ ] **Step 2: Run test to verify it fails** → `cargo test -p crypto-openpgp engine` (encrypt test fails / not implemented).

- [ ] **Step 3: Implement encrypt + decrypt**

`encrypt`: serialize the parts into one plaintext blob for `SingleMimeBlob` (concatenate part data with a simple length-prefixed framing — note this framing is internal and unwrapped symmetrically by `decrypt`; PGP/MIME framing is the send slice's job, NOT here). If `sign_with` is `Some`, wrap the `LiteralWriter` in a `Signer` stream first (Task-1 `## inline-sign` pattern). Use `policy.write_policy()` as the `&dyn Policy`.

`decrypt`: `DecryptorBuilder::from_bytes(&envelope.parts[0].ciphertext)?.with_policy(read_policy, None, helper)` where `helper` is a `DecryptionHelper`+`VerificationHelper` over `decryption_cert` (Task-1 `Helper` pattern, using `read_policy`). Read plaintext, split back into parts via the same framing, return `(DecryptedPayload, policy.note_weak(...))`.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd kylins.client.crypto && cargo test -p crypto-openpgp engine`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add kylins.client.crypto/openpgp/src/engine.rs
git commit -m "feat(crypto-openpgp): engine encrypt/decrypt incl sign-then-encrypt (Task 6)"
```

---

## Task 7: engine — sign / verify (`engine.rs` part 3)

Detached (primary) and inline signing + verification, returning `SignatureState`. Use the Task-1 `## detached-sign` / `## detached-verify` patterns.

**Files:**
- Modify: `kylins.client.crypto/openpgp/src/engine.rs`

**Interfaces:**
- Consumes: `crypto_core::{SignedEnvelope, DetachedSignature, VerificationResult, SignatureState, KeyHandleRef}`, `crate::keymap`.
- Produces:
  - `pub fn sign_detached(payload: &[u8], signer_cert: &openpgp::Cert, policy: &PgpPolicy) -> CryptoResult<DetachedSignature>`
  - `pub fn verify_detached(payload: &[u8], sig: &DetachedSignature, known_signers: &[openpgp::Cert], policy: &PgpPolicy) -> CryptoResult<VerificationResult>`

- [ ] **Step 1: Write the failing test**

`#[cfg(test)]`:
- Sign payload P with signer cert → `DetachedSignature`. `verify_detached(P, &sig, &[signer_cert], &pol)` → `state == SignatureState::ValidVerified`, `signer.is_some()`.
- Tamper P → `state == SignatureState::Invalid`, `failure_reason.is_some()`.
- `verify_detached(P, &sig, &[] /* no known signers */, &pol)` → `state == SignatureState::UnknownKey`.

- [ ] **Step 2: Run test to verify it fails** → `cargo test -p crypto-openpgp engine` (sign/verify tests fail).

- [ ] **Step 3: Implement sign_detached + verify_detached**

`sign_detached`: select the signing subkey from `signer_cert` (`keys().for_signing()...into_keypair()`), then `Signer::detached(Message::new(&mut sig_buf), &[keypair])` per `spike-notes.md ## detached-sign`. Wrap in `keymap::cert_to_handle(signer_cert)` for the `DetachedSignature.signer`; `signature = sig_buf`.

`verify_detached`: build a `VerificationHelper` that returns the `known_signers` whose fingerprint matches the signature's issuer; `DetachedVerifier::from_bytes(&sig.signature, &mut payload_buf, helper)` (per `## detached-verify`). Map: helper found the key + check OK → `ValidVerified`; no matching known signer → `UnknownKey` (with `signer` from the sig issuer fp); verification `Err` → `Invalid` with `failure_reason`. Run the verification under `policy.read_policy()`; call `policy.note_weak(...)` on the signature's hash/pk algo.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd kylins.client.crypto && cargo test -p crypto-openpgp engine`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add kylins.client.crypto/openpgp/src/engine.rs
git commit -m "feat(crypto-openpgp): engine sign/verify -> SignatureState (Task 7)"
```

---

## Task 8: `OpenpgpBackend` CryptoBackend impl + in-memory KeyStore + round-trip integration

Wire the engine into the `CryptoBackend` trait, build a tiny in-memory `KeyStore` for tests, and prove the whole backend end-to-end. This is the integration gate for the slice.

**Files:**
- Modify: `kylins.client.crypto/openpgp/src/lib.rs` (`OpenpgpBackend` struct + `#[async_trait] impl CryptoBackend`).
- Create: `kylins.client.crypto/openpgp/tests/common/mod.rs` (in-memory `KeyStore` impl + helpers).
- Create: `kylins.client.crypto/openpgp/tests/round_trip.rs` (end-to-end round-trips).
- Delete: `kylins.client.crypto/openpgp/tests/spike.rs` (fold its still-useful assertions into `round_trip.rs`; discard pure-API-exploration tests). Keep `spike-notes.md`.

**Interfaces:**
- Consumes: `crypto_core::{CryptoBackend, KeyStore, StoredKey, ...}` (read `core/src/keystore.rs` for the exact `KeyStore` trait + `StoredKey` fields), all `engine`/`keymap`/`policy`/`error` helpers, `tokio::task::spawn_blocking`.
- Produces: `pub struct OpenpgpBackend { keystore: Arc<dyn KeyStore>, policy: PgpPolicy }` + `impl OpenpgpBackend { pub fn new(keystore: Arc<dyn KeyStore>, core_policy: CryptoPolicy) -> Self }` + `#[async_trait] impl CryptoBackend for OpenpgpBackend`.

- [ ] **Step 1: Read the `KeyStore` contract + write the in-memory store**

Read `kylins.client.crypto/core/src/keystore.rs`. Implement `tests/common/mod.rs::MemoryKeyStore` (a `Mutex<HashMap<(Standard, Fingerprint), StoredKey>>`) implementing `KeyStore` exactly. Also add helpers `put_cert(cert)` and `get_cert(fp) -> Option<Cert>` that (de)serialize via `keymap`.

- [ ] **Step 2: Write the failing integration test**

`tests/round_trip.rs` (`#[tokio::test]`):
- `OpenpgpBackend::new(Arc::new(MemoryKeyStore::new()), CryptoPolicy::default_baseline())`.
- `generate_key(KeyGenParams{ standard: OpenPgp, user_id: "a@b.c".into(), algorithm: "default".into(), passphrase: None })` → `KeyHandleRef`; store the cert in the `MemoryKeyStore`.
- `export_public(&handle)` → armored bytes; `import_key(armored, None)` → same fingerprint.
- Encrypt a `Part` to the recipient handle (`sign_with=None`), `decrypt` → plaintext matches.
- Sign-then-encrypt: `encrypt(sign_with=Some(signer_handle))` → `decrypt` → plaintext; then `verify` the recovered detached signature → `ValidVerified`.
- `sign(detached=true)` → `verify` → `ValidVerified`; tamper → `Invalid`; unknown signer → `UnknownKey`.

- [ ] **Step 3: Implement `OpenpgpBackend` + the `CryptoBackend` impl in `lib.rs`**

```rust
pub struct OpenpgpBackend {
    keystore: std::sync::Arc<dyn crypto_core::KeyStore>,
    policy: crate::policy::PgpPolicy,
}

impl OpenpgpBackend {
    pub fn new(keystore: std::sync::Arc<dyn crypto_core::KeyStore>, core_policy: crypto_core::CryptoPolicy) -> Self {
        Self { keystore, policy: crate::policy::from_core(&core_policy) }
    }
}

#[async_trait::async_trait]
impl crypto_core::CryptoBackend for OpenpgpBackend {
    fn standard(&self) -> crypto_core::Standard { crypto_core::Standard::OpenPgp }
    fn policy(&self) -> &crypto_core::CryptoPolicy { /* hold the core policy alongside PgpPolicy, or reconstruct */ unimplemented!() }
    // encrypt/decrypt/sign/verify/generate_key/import_key/export_public:
    // each resolves KeyHandleRef -> openpgp::Cert via self.keystore, then delegates to
    // crate::engine::* inside tokio::task::spawn_blocking, mapping results to the
    // framework envelope types via crate::keymap. See spec §5 table for the mapping.
}
```

Resolve `KeyHandleRef` → `Cert`: parse the `KeyId` `"openpgp|{fp}"`, look up the `StoredKey` blob in `self.keystore`, `keymap::parse_certs(&blob)` → `Cert`. Wrap each heavy op in `tokio::task::spawn_blocking` (the trait is `async`). `generate_key` also persists the new cert into `self.keystore` before returning the handle.

Hold the original `crypto_core::CryptoPolicy` in the struct (add a field) so `policy()` returns it directly — fix the `unimplemented!()` above by storing `core_policy`.

- [ ] **Step 4: Delete spike.rs, run the integration test**

```bash
# fold any kept spike assertions into round_trip.rs first, then:
git rm kylins.client.crypto/openpgp/tests/spike.rs
cd kylins.client.crypto && cargo test -p crypto-openpgp --test round_trip
```
Expected: PASS (all `#[tokio::test]` cases).

- [ ] **Step 5: Commit**

```bash
git add kylins.client.crypto/openpgp/src/lib.rs kylins.client.crypto/openpgp/tests/common/mod.rs kylins.client.crypto/openpgp/tests/round_trip.rs
git rm kylins.client.crypto/openpgp/tests/spike.rs
git commit -m "feat(crypto-openpgp): OpenpgpBackend CryptoBackend impl + in-memory keystore round-trip (Task 8)"
```

---

## Task 9: cross-implementation interop + final workspace gate

Prove our output is consumed by a reference implementation and vice-versa (mirrors `crypto-smime` openssl interop), skip-if-absent so CI without the CLI stays green, then run the full workspace gate.

**Files:**
- Create: `kylins.client.crypto/openpgp/tests/interop.rs`

**Interfaces:**
- Consumes: `OpenpgpBackend`, `MemoryKeyStore` (from `tests/common`), `std::process::Command` (`sequoia-sq` / `gpg`).

- [ ] **Step 1: Write the interop test (skip-if-absent)**

`tests/interop.rs`: a helper `have(cmd) -> bool` (`which` via `Command::new(cmd).arg("--version")`). Each test begins `if !have("sq") && !have("gpg") { return; }`.

Cases (when a CLI is present):
- Export our generated public key (armored); import it into a temp `gpg`/`sq` keyring; encrypt a message there; `engine::decrypt` here → plaintext matches.
- Encrypt here; decrypt there → plaintext matches.
- Detached-sign here; verify there; and the reverse.

Use a temp home dir (`gpg --homedir` / `sq --keyring`) to avoid touching the user's keyring. Isolate in `tempfile::TempDir` (add `tempfile` to `[dev-dependencies]`).

- [ ] **Step 2: Run interop (skips cleanly without the CLI; full pass with it)**

Run: `cd kylins.client.crypto && cargo test -p crypto-openpgp --test interop`
Expected: PASS (or `ok. 0 passed` with ignored/skipped if no CLI). If `sq`/`gpg` is available locally, run it for a real cross-impl pass; otherwise record "manual interop pending" in `spike-notes.md`.

- [ ] **Step 3: Final workspace gate**

Run: `cd kylins.client.crypto && cargo test && cargo clippy --all-targets -- -D warnings`
Expected: core + smime still green; openpgp all green; clippy clean across the workspace.

- [ ] **Step 4: Commit**

```bash
git add kylins.client.crypto/openpgp/tests/interop.rs kylins.client.crypto/openpgp/Cargo.toml
git commit -m "test(crypto-openpgp): sequoia-sq/gpg cross-impl interop + final workspace gate (Task 9)"
```

---

## Self-Review

**1. Spec coverage** — spec §Goals mapped: G1 crate+workspace member (T1); G2 OpenpgpBackend impl (T8); G3 key generation Ed25519+X25519+sign subkey (T1/T5); G4 armored+binary import/export (T3/T5); G5 encrypt/decrypt + sign-then-encrypt (T6); G6 sign/verify → VerificationResult/SignatureState (T7); G7 modern-write + permissive-read + weak-algo warning (T4, exercised T6/T7); G8 KeyStore contract via in-memory store (T8); G9 self round-trip + cross-impl interop (T8/T9). Spec §non-goals (PGP/MIME, 7 dispatch sites, frontend, discovery, WoT, smartcard, PQ, SplitPerPart, schema) are all out of plan — confirmed. The 7 dispatch sites are enumerated in the spec §12 for the next slice, not here.

**2. Placeholder scan** — Tasks 2/3/5 contain complete Rust. Tasks 4/6/7/8 reference the Task-1 `spike-notes.md` for the Sequoia call sequences that Context7 did not surface and that are genuinely version-specific; the spike (T1) is itself a complete, compiling task that produces those notes — this is de-risking, not a placeholder. Framework-level test code is complete throughout. No "TBD"/"TODO"/"handle edge cases" prose.

**3. Type consistency** — `KeyHandleRef`/`Standard::OpenPgp`/`KeyUsage::SignAndEncrypt`/`KeyId("openpgp|{fp}")`/`SignatureState{ValidVerified,Invalid,UnknownKey}`/`EncryptedEnvelope`/`SignedEnvelope`/`DetachedSignature`/`VerificationResult` names match across T3, T5–T8 and the spec. `error::map_err`/`error::policy`/`CryptoResult` consistent T2→T7. `PgpPolicy::from_core` (T4) vs `OpenpgpBackend::new(..., core_policy)` storing the core policy (T8) — T8 Step 3 note makes `policy()` return the stored core policy, consistent.

**Open risks surfaced (controller-review attention):** (a) `CryptoError::Malformed(String)` variant name assumed in T2 — confirm against `core/src/error.rs`. (b) `Fingerprint` accessor + `Cert::strip_secret()` + `CertParser` API assumed in T3 — confirm during impl. (c) The `KeyStore`/`StoredKey` exact shape (T8) — read `core/src/keystore.rs` first. (d) Sequoia `StandardPolicy` legacy-relaxation API (T4) + exact sign/verify constructors (T7) — defined by the T1 spike notes, not assumed.

---

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-07-19-crypto-phase2-openpgp-engine-core.md` (uncommitted per git policy). Per the SDD directive, execution is **subagent-driven**: a fresh implementer subagent per task, controller review between tasks, ledger entry per task. Task 1 (the spike) must complete and populate `spike-notes.md` before Tasks 4/6/7/8.
