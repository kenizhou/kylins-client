# `proton-crypto-rs` Source-Learning Report

**Study date:** 2026-07-10  
**Source:** `D:\Projects\mailclient\opensource\Proton\proton-crypto-rs`  
**Current codebase for comparison:** `D:\Projects\mailclient\kylins` (Tauri v2 + React 19 desktop email client)

---

## TL;DR

`proton-crypto-rs` is a **Proton-product-specific cryptographic SDK**, not a generic OpenPGP library. It wraps lower-level OpenPGP engines (Go/GopenPGP or pure-Rust `rpgp`) behind a single product-oriented API and layers Proton account cryptography on top: user/address keys, key salts, signed key lists, recovery secrets, SRP authentication, and device verification.

The best ideas to borrow for Kylins are architectural: **provider traits, builder-pattern crypto operations, centralized crypto policy, explicit secret lifecycle, and feature-gated backend selection**. The crate itself should **not** be imported into Kylins — its README explicitly warns against outside use.

---

## 1. Core Concepts

### What is it?

A Rust workspace of utility crates for Proton's end-to-end encrypted services (Mail, Drive, Account, VPN). It combines:

- **OpenPGP operations**: key generation, import/export, encryption, decryption, signing, verification, armor/dearmor, session-key handling, detached/inline/cleartext signatures.
- **Proton account cryptography**: user keys, address keys, organization keys, device keys, signed key lists (SKL), contact-card encryption, recovery secrets, key-token unlocking.
- **Secure Remote Password (SRP)**: Proton's SRP-6a variant for password-authenticated login.
- **Low-level primitives**: AES-GCM-256, HKDF-SHA256.
- **Device verification / proof-of-work**: ECDLP-over-Curve25519 and Argon2id challenge solvers.

### Fundamental abstractions

| Abstraction | Purpose | Key location |
|---|---|---|
| `PGPProvider` / `PGPProviderSync` / `PGPProviderAsync` | Root trait for all OpenPGP operations | `proton-crypto/src/crypto/mod.rs:39` |
| `SessionKey`, `PublicKey`, `PrivateKey` | Key types exposed as associated types of a provider | `proton-crypto/src/crypto/keys.rs:8,19,22` |
| `Encryptor`, `Decryptor`, `Signer`, `Verifier`, `KeyGenerator` | Builder types for crypto operations | `proton-crypto/src/crypto/{encrypt,decrypt,sign,verify,keys}.rs` |
| `CryptoClock` / `CryptoClockProvider` | Injectable time source to avoid local clock skew | `proton-crypto/src/lib.rs:88` |
| `UserKeys`, `AddressKeys`, `SignedKeyList`, `EncryptionPreferences` | Proton account key model | `proton-crypto-account/src/keys/*.rs` |

---

## 2. Architecture

### Workspace crates

The project is split into 7 crates by backend, domain, and security boundary:

| Crate | Version | Role |
|---|---|---|
| `proton-crypto` | 0.13.1 | **Core façade**. Trait-based, backend-agnostic PGP + SRP API. |
| `proton-crypto-account` | 0.19.1 | **Account domain layer**. User/address/org/device keys, SKL, contacts, recovery. Re-exports `proton-crypto`. |
| `proton-rpgp` | 0.4.0 | **Pure-Rust OpenPGP backend** built on `rpgp` (`pgp = 0.19.0`). |
| `gopenpgp-sys` | 0.3.6 | **Go/FFI OpenPGP backend** bindings to GopenPGP v3. |
| `proton-srp` | 0.8.2 | **Proton SRP-6a protocol** (client + server, modulus verification, password hashing). |
| `proton-crypto-subtle` | 0.2.1 | **Low-level primitives**: AES-GCM-256, HKDF-SHA256. |
| `proton-device-verification` | 0.1.1 | **Anti-abuse PoW**: Curve25519 ECDLP and Argon2id challenge solvers. |

### Dependency graph

```text
proton-crypto-account
        │ uses
        ▼
   proton-crypto  ──┬──► gopenpgp-sys  (Go backend, feature gopgp)
        │           └──► proton-rpgp    (Rust backend, feature rustpgp)
        │ uses
        ▼
   proton-srp

proton-crypto-subtle        (independent leaf crate)
proton-device-verification  (independent leaf crate)
```

### Backend dispatch

`proton-crypto/src/lib.rs` selects the backend at compile time via Cargo features:

- Default: `gopgp` (requires Go toolchain for `gopenpgp-sys`).
- Pure-Rust build: `--no-default-features --features rustpgp`.
- `multi_be`: both backends coexist for testing/transition.

Higher-level code never names `rpgp` or `gopenpgp_sys` directly; it uses `impl PGPProviderSync`.

---

## 3. Design Patterns

### Provider trait with associated types

The central abstraction is a trait family in `proton-crypto/src/crypto/mod.rs`:

```rust
pub trait PGPProvider: Send + Sync + 'static + Clone {
    type SessionKey: SessionKey;
    type PrivateKey: PrivateKey;
    type PublicKey: PublicKey;
    type SigningContext: SigningContext;
    type VerificationContext: VerificationContext;
    type PGPMessage: PGPMessage;
    type VerifiedData: VerifiedData;
    // ...
}
pub trait PGPProviderSync: PGPProvider { /* builders + helpers */ }
pub trait PGPProviderAsync: PGPProvider { /* async versions */ }
```

Sub-traits cover every operation: key info, encryption, decryption, signing, verification, armor.

### Builder pattern

Every crypto operation is configured fluently:

- `Encryptor::with_encryption_key(...).with_signing_key(...).with_passphrase(...).encrypt(data)`
- `Decryptor::with_decryption_key(...).with_verification_key(...).decrypt(data)`
- `Signer::sign_detached(...)` / `Verifier::verify_detached(...)`
- `KeyGenerator::with_user_id(...).with_algorithm(...).generate()`

This hides backend-specific packet/message construction from higher-level code.

### Feature-gated backend selection

Cargo features select the backend at compile time rather than runtime:

- `gopgp` → Go backend.
- `rustpgp` → Rust backend.
- `multi_be` → both available.

### Strongly-typed string wrappers

Macros `lowercase_string_id!` (`proton-crypto/src/lib.rs:279`) and `string_id!` (`proton-crypto-account/src/lib.rs:17`) generate newtypes such as `KeyId`, `KeySalt`, `ArmoredPrivateKey`, `SKLSignature`, with `Display`, `From`, `Deref`, and optional `facet`/`rusqlite` support.

### Zeroization and explicit secret management

Secret types implement `ZeroizeOnDrop` where possible (`AesGcmKey` in `proton-crypto-subtle/src/aead.rs:138`, `SecretGoBytes` in `gopenpgp-sys/src/go.rs:69`). Unlocking is explicit; unlocked keys are short-lived.

### Error handling

- `proton-crypto` uses a single `CryptoError` wrapping `Arc<dyn std::error::Error + Send + Sync>` (`proton-crypto/src/lib.rs:27`) so backend errors cross the trait boundary cleanly.
- `proton-crypto-account` uses `thiserror`-derived enums (`AccountCryptoError`, `KeyError`, `KeySelectionError`, etc.).

### FFI handle ownership

`gopenpgp-sys` wraps Go object handles in Rust types with `Drop` impls that call the corresponding `pgp_*_destroy` function (e.g., `GoKey::drop` → `pgp_key_destroy`, `gopenpgp-sys/src/keys.rs:62`).

### Configuration via `Profile`

`proton-rpgp` centralizes crypto policy (algorithms, S2K, preferences, DoS limits) in a `Profile` object (`proton-rpgp/src/profile.rs:30`, `proton-rpgp/src/profile/settings.rs:58`).

---

### Rust OpenPGP library landscape

> Merged from the earlier `proton-crypto-rs-learning-report.md` (§5), which this report supersedes.

| Library | Scope | Crypto backend | RFC 9580 | Notes |
|---|---|---|---|---|
| **Sequoia PGP** (`sequoia-openpgp`) | Full OpenPGP library + tools (`sq`/`chameleon`) | Nettle (C) by default; optional pure-Rust `crypto-rust` | Strong | Best GnuPG compatibility; broad tooling |
| **rPGP** (`rpgp`, crate `pgp`) | Focused OpenPGP library | Pure Rust / RustCrypto | Strong | Used by Proton `proton-rpgp`, Delta Chat |
| **openpgp-card** | OpenPGP smartcard client API | Backend-agnostic | N/A | Companions: `openpgp-card-rpgp`, `openpgp-card-sequoia` |
| **minipgp6** | Minimal v6-only implementation | Pure Rust | v6 only | Small scope, less mature |
| **RNP** (`rnpgp/rnp`) | High-performance C++ OpenPGP | Botan or OpenSSL | RFC 4880 focused | Backs Thunderbird; closer to LibrePGP camp |

**RFC 9580 vs. LibrePGP split.** RFC 9580 (2024) is the IETF standard: 64-hex fingerprints, v6 packets, Ed25519/X25519 mandatory, AEAD-OCB, Argon2 S2K, HKDF, padding packets. LibrePGP is a GnuPG/RNP-backed alternative largely incompatible with RFC 9580. Sequoia and rPGP align with RFC 9580; Thunderbird's RNP sits closer to LibrePGP.

**Sequoia vs. rPGP for a new project.** Sequoia offers a larger ecosystem/tooling and GnuPG compatibility but pulls a C dependency (Nettle); rPGP is pure Rust with a smaller, focused API. A real Tauri v2 precedent exists: **KeychainPGP** uses Sequoia. See `openpgp-crypto-ecosystem-analysis-report.md` for the cross-platform and pure-Rust trade-off analysis and the final recommendation.

---

## 4. How It Works — Key Flows

### 4.1 Backend dispatch

`proton-crypto/src/lib.rs` (lines ~187–262) chooses the backend at compile time and returns an opaque `impl PGPProviderSync`. Higher-level code never names `rpgp` or `gopenpgp_sys` directly.

### 4.2 Encryption flow

1. Get provider: `let pgp = ProtonPGP::new_sync();` (`proton-crypto/src/lib.rs:143`).
2. Create encryptor: `pgp.new_encryptor()`.
3. Add recipients: `.with_encryption_keys(recipient_public_keys)`.
4. Optionally sign: `.with_signing_key(sender_private_key)`.
5. Encrypt: `.encrypt(data)` → returns `PGPMessage`.

In the Rust backend (`proton-rpgp/src/encrypt.rs:34`), an `rpgp` `MessageBuilder` is constructed, algorithms are selected via `RecipientsAlgorithms`, SEIPD v1/v2 and PKESK/SKESK are handled, and an `EncryptedMessage` is returned.

### 4.3 Decryption flow

1. Create decryptor: `pgp.new_decryptor()`.
2. Provide private key: `.with_decryption_key(private_key)`.
3. Optionally provide verification keys: `.with_verification_key(sender_public_key)`.
4. Decrypt: `.decrypt(pgp_message)` → returns `VerifiedData`.
5. `VerifiedData::verification_result()` exposes signature status independently of decryption success.

### 4.4 Account key unlock flow

1. Derive `KeySecret` from user password + per-key `KeySalt` via SRP provider (`mailbox_password_hash`).
   - `proton-crypto-account/src/salts.rs:104`
2. `UserKeys::unlock(provider, &key_secret)` decrypts each locked user key.
   - `proton-crypto-account/src/keys/user_keys.rs:199`
3. `AddressKeys::unlock(provider, &unlocked_user_keys, legacy_passphrase)` decrypts address keys.
   - Modern address keys contain an `EncryptedKeyToken` and `KeyTokenSignature`; the token is decrypted/verified with the user key, then used to decrypt the address key.
   - `proton-crypto-account/src/keys/address_keys.rs:312`
4. Selectors (`UserKeySelector`, `AddressKeySelector`) expose `for_signing`, `for_encryption`, `for_decryption`, `for_signature_verification`.

### 4.5 Key generation

- `LocalUserKey::generate(provider, algorithm, salted_password)` — `proton-crypto-account/src/keys/user_keys.rs:430`.
- `LocalAddressKey::generate(provider, email, algorithm, flags, primary, user_key)` — `proton-crypto-account/src/keys/address_keys.rs:630`.
- Default generation is ECC v4 (`Ed25519Legacy` + `ECDH/Curve25519`); PQC v6 (`ML-DSA` + `ML-KEM`) is available via `KeyGenerationType::PQC`.

### 4.6 SRP authentication

- `mailbox_password_hash(password, salt)` → bcrypt cost 10 → `MailboxHashedPassword`. The hashed portion (after the 29-byte prefix) becomes the `KeySecret`.
- `srp_password_hash(version, username, password, salt, modulus)` → for v3/v4, `bcrypt(password, salt || "proton")` then `SHA512(... || N)` ×4 → 256-byte `SRPHashedPassword`.
- `SRPAuth::new(...)` verifies the signed modulus against a hard-coded server public key, then `generate_proofs()` produces `SRPProof`.
- Client compares server proof in constant time: `ClientProof::compare_server_proof(...)` — `proton-crypto/src/srp.rs:18`.

### 4.7 Crypto policy

`proton-rpgp/src/profile/settings.rs` centralizes:

- Preferred symmetric/AEAD/hash/compression algorithms.
- Rejected algorithms (MD5, RIPEMD-160, SHA-1 for messages, Elgamal, DSA, secp256k1).
- S2K parameters for key vs message encryption.
- DoS limits: `max_reading_size = 50 MB`, `max_s2k_trials_per_passphrase = 5`.

---

## 5. Notable Files and Line Numbers

### Workspace

- `D:/Projects/mailclient/opensource/Proton/proton-crypto-rs/Cargo.toml` — workspace members and shared lints/dependencies.
- `D:/Projects/mailclient/opensource/Proton/proton-crypto-rs/README.md` — high-level crate overview.

### `proton-crypto`

- `src/lib.rs:27` — `CryptoError` (opaque `Arc<dyn Error>`).
- `src/lib.rs:88` — `CryptoClockProvider` trait and injectable clock.
- `src/lib.rs:143,147` — `ProtonPGP::new_sync()`, `new_async()`.
- `src/lib.rs:214,229` — `new_pgp_provider()`, `new_pgp_provider_async()`.
- `src/lib.rs:265` — `new_srp_provider()`.
- `src/crypto/mod.rs:39` — `PGPProvider` trait with associated types.
- `src/crypto/mod.rs:106` — `PGPProviderSync` trait.
- `src/crypto/mod.rs:292` — `PGPProviderAsync` trait.
- `src/crypto/keys.rs:8,19,22` — `SessionKey`, `PublicKey`, `PrivateKey` traits.
- `src/crypto/encrypt.rs:55` — `Encryptor` / `EncryptorSync`.
- `src/crypto/decrypt.rs:13` — `Decryptor` / `DecryptorSync`.
- `src/crypto/sign.rs:17` — `Signer` / `SignerSync`.
- `src/crypto/verify.rs:87` — `Verifier` / `VerifierSync`.
- `src/srp.rs:61` — `SRPProvider` trait.
- `src/rust/pgp.rs:78` — `RustPGPProvider` adapter.
- `src/go/pgp.rs:28` — `GoPGPProvider` adapter.

### `proton-crypto-account`

- `src/lib.rs:15` — re-exports `proton_crypto`.
- `src/lib.rs:17` — `string_id!` macro for typed IDs.
- `src/keys/user_keys.rs:199` — `UserKeys::unlock`.
- `src/keys/user_keys.rs:430` — `LocalUserKey::generate`.
- `src/keys/address_keys.rs:312` — `AddressKeys::unlock`.
- `src/keys/address_keys.rs:630` — `LocalAddressKey::generate`.
- `src/keys/signed_key_list.rs:240` — `LocalSignedKeyList::generate`.
- `src/keys/recipient.rs:478` — `EncryptionPreferences`.
- `src/salts.rs:104` — `KeySalt::salted_key_passphrase`.
- `src/recovery/mod.rs:60` — `VerifiedRecoverySecret::generate`.
- `src/errors.rs` — domain error enums.

### `proton-rpgp`

- `src/lib.rs:14` — re-exports `pgp` crate.
- `src/key.rs:65` — `PublicKey`.
- `src/key.rs:147` — `LockedPrivateKey`.
- `src/key.rs:316` — `PrivateKey`.
- `src/key/generation.rs:37` — `KeyGenerator`.
- `src/encrypt.rs:34` — `Encryptor`.
- `src/decrypt.rs:25` — `Decryptor`.
- `src/sign.rs:32` — `Signer`.
- `src/verify.rs:31` — `Verifier`.
- `src/profile.rs:30` — `Profile`.
- `src/profile/settings.rs:58` — `ProfileSettings`.

### `gopenpgp-sys`

- `src/lib.rs:1` — crate doc / build requirements.
- `src/go.rs:16` — `include!` of `bindgen`-generated bindings.
- `src/go.rs:69` — `SecretGoBytes` (zeroizing Go buffer).
- `src/keys.rs:62` — `GoKey::drop` → `pgp_key_destroy`.
- `src/keys.rs:194` — `PublicKey` (`Arc<GoKey>`).
- `src/encryption.rs:414` — `Encryptor::encrypt`.
- `src/decryption.rs:308` — `Decryptor::decrypt`.
- `build.rs:90` — orchestrates `go build` + `bindgen`.

### `proton-srp`

- `src/lib.rs:22` — `SrpHashVersion` enum.
- `src/srp/client.rs:134` — `SRPAuth::new`.
- `src/srp/client.rs:197` — `SRPAuth::generate_proofs`.
- `src/srp/core.rs:141` — `SRPAuthData::generate_client_proof`.
- `src/pmhash.rs:131,154` — `mailbox_password_hash`, `srp_password_hash`.

### `proton-crypto-subtle`

- `src/aead.rs:139` — `AesGcmKey`.
- `src/aead.rs:196` — `AesGcmKey::encrypt`.
- `src/aead.rs:222` — `AesGcmKey::decrypt`.
- `src/hkdf.rs:35` — `derive_aes_gcm_key`.

### `proton-device-verification`

- `src/lib.rs:21` — `DeviceChallenge` enum.
- `src/lib.rs:35` — `DeviceChallenge::solve`.
- `src/pow.rs:32` — `solve_ecdlp_challenge`.
- `src/pow.rs:89` — `solve_argon2_challenge`.

---

## 6. Current Codebase Comparison — Kylins Client

### 6.1 Patterns Kylins already follows

| Pattern in `proton-crypto-rs` | Where Kylins aligns | Notes |
|---|---|---|
| Backend owns secrets and crypto | `kylins.client.backend/src/crypto.rs` caches a 256-bit master key and exposes `encrypt_secret` / `decrypt_secret`. | Good boundary — frontend never sees raw secrets. |
| OS keyring for master key | `crypto.rs` uses the `keyring` crate for service `mailclient` / user `master-key`. | Same approach Proton uses for session encryption key storage. |
| SQLite as encrypted metadata store | Kylins stores encrypted account secrets in SQLite (`db/accounts.rs`). | Can be extended for OpenPGP key metadata + encrypted secret blobs. |
| Builder-pattern MIME construction | `kylins.client.backend/src/mail/builder.rs` builds `SendDraft` into RFC5322 MIME using `mail-builder`. | Natural hook point for PGP/MIME wrapping. |
| Event-driven frontend updates | Tauri events (`sync:delta`, `sync:new-mail`, etc.) propagate backend state. | Decryption/verification results can use the same mechanism. |

### 6.2 Patterns Kylins misses

| Pattern in `proton-crypto-rs` | What Kylins lacks | Impact |
|---|---|---|
| Provider trait abstraction over OpenPGP backends | No OpenPGP provider trait; no OpenPGP engine at all. | Ties Kylins to a single engine if not careful. |
| Centralized crypto policy / profile | No policy file controlling allowed algorithms, AEAD, S2K, DoS limits. | Risk of accepting weak algorithms or interop edge cases. |
| Builder-pattern OpenPGP operations | No `Encryptor`/`Decryptor`/`Signer`/`Verifier` abstraction. | Crypto code will be scattered and harder to test. |
| Account/user/address key hierarchy | Kylins is a generic IMAP/EAS client, not a Proton account. | Proton's exact key model does not apply, but a per-account key model does. |
| Explicit unlock/cache/lock lifecycle for secret keys | Kylins only caches the master key; no per-key unlock TTL. | Needed once private keys are used repeatedly. |
| `zeroize` for in-memory secrets | Master key and decrypted secrets are ordinary `String`/`[u8; 32]`. | Memory dumps could expose secrets. |
| AAD / authenticated context for AES-GCM | Current ciphertext does not bind to account, field, or version. | Ciphertext could be replayed across contexts. |
| SRP / Proton-specific auth | Not applicable to Kylins. | — |

### 6.3 Should Kylins reuse `proton-crypto-rs`?

**No.** The README explicitly says it is *“Not intended or vetted for general usage outside Proton.”* Kylins is a generic email client, not a Proton service. The Proton-specific abstractions (SRP, user/address keys, SKL, device verification) are irrelevant baggage.

**What is worth copying:** the *shape* of the abstraction — a small provider trait, builder-pattern operations, a centralized crypto policy, and explicit secret lifecycle — applied to a generic email-client key model.

---

## 7. Suggested Improvements for Kylins

> **Authoritative design doc:** This section captures directional suggestions derived from studying the source. The canonical Kylins crypto design lives in [`crypto-architecture-design.md`](crypto-architecture-design.md); where the two diverge, the design doc wins.

### 7.1 Adopt a provider-trait abstraction

Create a backend-agnostic `CryptoProvider` trait in `kylins.client.backend/src/crypto/`:

```rust
pub trait CryptoProvider: Send + Sync + 'static {
    type Key: CryptoKey;
    type PublicKey: PublicKey;
    type PrivateKey: PrivateKey;
    type SignedMessage: SignedMessage;
    type EncryptedMessage: EncryptedMessage;

    fn name(&self) -> &'static str;
    fn policy(&self) -> &CryptoPolicy;

    fn new_signer(&self, key: &Self::PrivateKey) -> Result<Box<dyn Signer>, CryptoError>;
    fn new_verifier(&self) -> Result<Box<dyn Verifier>, CryptoError>;
    fn new_encryptor(&self) -> Result<Box<dyn Encryptor>, CryptoError>;
    fn new_decryptor(&self, key: &Self::PrivateKey) -> Result<Box<dyn Decryptor>, CryptoError>;

    fn generate_key(&self, params: KeyGenParams) -> Result<Self::Key, CryptoError>;
    fn import_key(&self, data: &[u8], passphrase: Option<&str>) -> Result<Self::Key, CryptoError>;
}
```

Implement it for a chosen engine (start with **rPGP** or **Sequoia**) behind a Cargo feature.

### 7.2 Centralize crypto policy

Add `kylins.client.backend/src/crypto/policy.rs`:

- Allowed asymmetric algorithms: Ed25519, X25519, RSA ≥3072.
- Allowed symmetric: AES-256, AES-128.
- Allowed hashes: SHA-256, SHA-384, SHA-512.
- AEAD policy: prefer OCB, fallback to SEIPDv2/v1 for compatibility.
- Reject: MD5, SHA-1, 3DES, IDEA, DSA, Elgamal, secp256k1.
- DoS limits: max message size, max S2K trials, max nested packets.

### 7.3 Builder-pattern crypto operations

Mirror Proton's style but keep it email-generic:

```rust
let encrypted = provider.encryptor()
    .for_recipients(&recipient_keys)
    .signed_by(&sender_key)
    .with_policy(&policy)
    .encrypt(mime_bytes)?;
```

### 7.4 Explicit key lifecycle

- Store encrypted secret-key blobs in SQLite, wrapped by the existing master key.
- Cache unlocked keys in Rust memory with a TTL (e.g., 10 minutes) and an explicit lock command.
- Use `secrecy`/`zeroize` for in-memory secret material.
- Add AAD to the existing AES-GCM vault to bind ciphertext to account/field/version.

### 7.5 Extend the existing hook points

- **Outbound:** `kylins.client.backend/src/mail/builder.rs` — sign-then-encrypt into RFC 3156 PGP/MIME or RFC 8551 S/MIME.
- **Inbound:** `kylins.client.backend/src/sync_engine/commands.rs` and `src/mail/imap/client.rs` — decrypt/verify after fetching raw bodies.

### 7.6 Keep key discovery consent-first

- Do **not** auto-encrypt based on Autocrypt `prefer-encrypt=mutual` alone.
- Require explicit user confirmation for WKD/keyserver lookups.
- Record key provenance (`origin`) and trust state in SQLite.

---

## 8. Implementation Plan

| Priority | Step | Files / crates | Verification |
|---|---|---|---|
| **P0** | Harden the existing AES vault: add AAD, `zeroize`, and a key-version prefix. | `kylins.client.backend/src/crypto.rs` | Existing account tests still pass; new tests for tampered/replayed ciphertext fail. |
| **P0** | Choose primary OpenPGP engine and add dependency/feature flag. | `kylins.client.backend/Cargo.toml` | `cargo build` succeeds with feature on/off. |
| **P0** | Define `CryptoProvider` trait + `CryptoPolicy` + error types. | `src/crypto/provider.rs`, `src/crypto/policy.rs`, `src/crypto/error.rs` | Unit tests compile. |
| **P0** | Implement provider for chosen engine (key generation, armor, encrypt/decrypt, sign/verify). | `src/crypto/openpgp/engine.rs` or `src/crypto/openpgp/sequoia.rs` | Unit tests pass. |
| **P1** | Add `pgp_keys` table and `trust_decisions` migration. | `kylins.client.backend/migrations/` | `cargo test` for migrations passes. |
| **P1** | Implement key import/export/generation Tauri commands. | `src/commands/crypto_commands.rs`, `src/lib.rs` | Manual test via frontend or `cargo test`. |
| **P1** | Hook outbound PGP/MIME into `mail/builder.rs`. | `src/mail/builder.rs`, `src/crypto/mime.rs` | Send an encrypted/signed test message; inspect MIME. |
| **P1** | Hook inbound decryption/verification into sync/imap path. | `src/sync_engine/commands.rs`, `src/mail/imap/client.rs` | Receive encrypted/signed test message; `is_encrypted`/`is_signed` set. |
| **P2** | Add frontend composer toggles and reading-pane security UI. | `Composer.tsx`, `ReadingPane.tsx`, `SecurityChips.tsx` | UI reflects encryption/signing state and trust. |
| **P2** | Implement WKD + keyserver lookup with explicit consent. | `src/crypto/openpgp/discovery.rs` | Lookup works and logs provenance. |
| **P2** | Add contact pinning and trust preferences. | `contacts.ts`, `SecurityPreferences.tsx` | Pinned keys override discovered keys. |
| **P3** | Autocrypt header/gossip parsing. | `src/crypto/openpgp/autocrypt.rs` | Parses but does not auto-encrypt without consent. |
| **P3** | Smartcard integration via `openpgp-card`. | `src/crypto/openpgp/smartcard.rs` | Sign/decrypt with inserted OpenPGP card. |
| **P4** | Post-quantum algorithm support (ML-KEM / ML-DSA) per RFC 9980. | `src/crypto/openpgp/policy.rs` | Experimental feature gate works. |

---

## 9. Key Takeaways

1. **`proton-crypto-rs` is a Proton product SDK, not a reusable OpenPGP library.** Do not import it into Kylins.
2. **Its best ideas are architectural:** provider traits, builder-pattern crypto ops, centralized policy, explicit secret lifecycle, and backend feature flags.
3. **For Kylins, use a generic Rust OpenPGP engine directly.** `sequoia-openpgp` and `rpgp` are both RFC-9580-aligned; choose based on whether you prioritize GnuPG compatibility/tooling (Sequoia) or pure-Rust/minimal dependencies (rPGP).
4. **Kylins already has the right security boundary** (Rust backend + OS keyring + SQLite). Adding OpenPGP is mostly about inserting the engine at the existing MIME and sync hook points.
5. **First harden the existing vault** (AAD, zeroize, key versioning) before adding complex OpenPGP/S-MIME logic.

---

*Report generated by source-learning workflow: local read-only sweep of `proton-crypto-rs` compared against the Kylins Client codebase.*
