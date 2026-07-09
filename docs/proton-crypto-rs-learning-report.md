# `proton-crypto-rs` & Rust OpenPGP Library Learning Report

**Study date:** 2026-07-08  
**Source studied:** `D:\Projects\mailclient\opensource\Proton\proton-crypto-rs`  
**Current codebase:** `D:\Projects\mailclient\kylins` (Tauri v2 + React 19 desktop email client)

---

## 1. Core concepts of `proton-crypto-rs`

`proton-crypto-rs` is **not a generic OpenPGP library**. It is a *Proton-specific cryptographic SDK* that happens to use OpenPGP as its message-crypto layer. Its purpose is to wrap lower-level OpenPGP implementations behind a single product-oriented API and then layer Proton account cryptography on top.

Key ideas:

* **Backend abstraction.** Consumers write against `proton_crypto::crypto::{PGPProviderSync, PGPProviderAsync}`. The concrete backend is selected at compile time via Cargo features (`gopgp`, `rustpgp`, `multi_be`).
* **Account-centric key model.** The crate family understands Proton’s key hierarchy: user keys, address keys, key salts, signed key lists (SKL), recovery secrets, and device keys.
* **Proton authentication.** It includes a pure-Rust implementation of Proton’s SRP-6a variant (`proton-srp`) with bcrypt-hardened password hashing.
* **Defense in depth.** Secrets are wrapped in zeroizing types (`KeySecret`, `MailboxHashedPassword`, `SensitiveDeviceKeyBytes`), key locking/unlocking is explicit, and SRP proofs are compared in constant time.
* **Not for general use.** The README explicitly states: *“Utility crates for cryptographic operations at Proton. Not intended or vetted for general usage outside Proton.”*

---

## 2. Architecture of `proton-crypto-rs`

### Workspace crates

| Crate | Role | Key files |
|---|---|---|
| `proton-crypto` | Core facade and provider traits; dispatches to Go or Rust backend. | `proton-crypto/src/lib.rs`, `proton-crypto/src/crypto/mod.rs` |
| `proton-crypto-account` | Proton account domain: `UserKeys`, `AddressKeys`, salts, SKL, recipient preferences, device keys, contacts. | `proton-crypto-account/src/keys/*.rs`, `src/salts.rs`, `src/recovery/`, `src/contacts/` |
| `proton-rpgp` | Pure-Rust backend built directly on the `pgp` crate (rpgp). | `proton-rpgp/src/profile.rs`, `src/profile/settings.rs`, `src/encrypt.rs`, `src/decrypt.rs`, `src/sign.rs`, `src/verify.rs` |
| `gopenpgp-sys` | Rust bindings to Proton’s Go `GopenPGP` v3 library via CGO + bindgen. | `gopenpgp-sys/src/lib.rs` |
| `proton-srp` | Proton SRP protocol, bcrypt password hashing, modulus verification. | `proton-srp/src/srp/client.rs`, `src/pmhash.rs` |
| `proton-crypto-subtle` | Low-level primitives: AES-GCM-256, HKDF-SHA256. | `proton-crypto-subtle/src/aead.rs`, `src/hkdf.rs` |
| `proton-device-verification` | Client-side proof-of-work solver for ECDLP and Argon2 challenges. | `proton-device-verification/src/lib.rs`, `src/pow/` |

### Dependency graph

```text
proton-crypto-account
        └── proton-crypto
                ├── proton-srp
                ├── proton-rpgp   (optional, feature rustpgp)
                └── gopenpgp-sys  (optional, feature gopgp)

proton-crypto-subtle  (independent)
proton-device-verification (independent)
```

### Backend dispatch

`proton-crypto/src/lib.rs` selects the backend at compile time:

```rust
pub fn new_pgp_provider() -> impl PGPProviderSync {
    #[cfg(feature = "rustpgp")] return new_rust_pgp_provider();
    #[cfg(all(not(feature = "rustpgp"), feature = "gopgp"))] return new_go_pgp_provider();
    // ...
}
```

* Default feature is `gopgp` (requires Go toolchain for `gopenpgp-sys`).
* Pure-Rust build: `cargo build --no-default-features -p proton-crypto -p proton-crypto-account --features rustpgp`.
* `multi_be` enables both backends simultaneously.

---

## 3. Design patterns

### Provider pattern with associated types

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

Sub-traits cover every operation:

| Concern | Trait(s) | Location |
|---|---|---|
| Key info | `AccessKeyInfo`, `PublicKey`, `PrivateKey`, `SessionKey` | `proton-crypto/src/crypto/keys.rs` |
| Encryption | `EncryptorSync` / `EncryptorAsync` | `proton-crypto/src/crypto/encrypt.rs` |
| Decryption | `DecryptorSync` / `DecryptorAsync` | `proton-crypto/src/crypto/decrypt.rs` |
| Signing | `SignerSync` / `SignerAsync` | `proton-crypto/src/crypto/sign.rs` |
| Verification | `VerifierSync` / `VerifierAsync` | `proton-crypto/src/crypto/verify.rs` |
| Armor | `ArmorerSync` | `proton-crypto/src/crypto/armor.rs` |

Both `RustPGPProvider` (`proton-crypto/src/rust/pgp.rs`) and `GoPGPProvider` (`proton-crypto/src/go/pgp.rs`) implement the same interface.

### Builder pattern

Every crypto operation is configured fluently:

* `Encryptor::with_encryption_key(...).with_signing_key(...).with_passphrase(...).encrypt(data)`
* `Decryptor::with_decryption_key(...).with_verification_key(...).decrypt(data)`
* `Signer::sign_detached(...)` / `Verifier::verify_detached(...)`
* `KeyGenerator::with_user_id(...).with_algorithm(...).generate()`

This hides backend-specific packet/message construction from higher-level code.

### Feature-gated backend selection

The crate uses Cargo features rather than runtime dispatch:

* `gopgp` → Go backend.
* `rustpgp` → Rust backend.
* `multi_be` → both available.
* `forcego` cfg forces Go backend.

### Strongly-typed string wrappers

Macros `lowercase_string_id!` and `string_id!` generate newtypes such as `KeyId`, `KeySalt`, `ArmoredPrivateKey`, `SKLSignature`, with `Display`, `From`, `Deref`, and optional `facet`/`rusqlite` support.

### Zeroize and explicit secret management

Secret types implement `ZeroizeOnDrop` where possible. Unlocking is explicit; unlocked keys are short-lived and can be cached with TTL in higher-level code.

### Error handling

* `proton-crypto` uses a single `CryptoError` wrapping `Arc<dyn std::error::Error + Send + Sync>` so backend errors cross the trait boundary.
* `proton-crypto-account` uses `thiserror`-derived enums (`AccountCryptoError`, `KeyError`, `KeySelectionError`, etc.).

---

## 4. How it works — key flows

### 4.1 Backend dispatch

`proton-crypto/src/lib.rs` (lines ~187–262) chooses the backend at compile time and returns an opaque `impl PGPProviderSync`. Higher-level code never names `rpgp` or `gopenpgp_sys` directly.

### 4.2 Encryption flow

1. `PGPProviderSync::new_encryptor()` → backend-specific `Encryptor`.
2. Configure keys, passphrase, session key, signing context, signing time.
3. `EncryptorSync::encrypt(data)` or `encrypt_to_writer(...)`.
4. In the Rust backend (`proton-rpgp/src/encrypt.rs`), an `rpgp` `MessageBuilder` is constructed, algorithms are selected via `RecipientsAlgorithms`, SEIPD v1/v2 and PKESK/SKESK are handled, and an `EncryptedMessage` is returned.

### 4.3 Decryption flow

1. `PGPProviderSync::new_decryptor()`.
2. Configure decryption key, verification key, passphrase/session key.
3. `DecryptorSync::decrypt(data)` returns `VerifiedData`.
4. `VerifiedData::verification_result()` exposes signature status independently of decryption success.
5. Rust backend (`proton-rpgp/src/decrypt.rs`) parses packets, decrypts session keys, then verifies via `Verifier`.

### 4.4 Account key unlock flow

1. Derive `KeySecret` from user password + per-key `KeySalt` via SRP provider (`mailbox_password_hash`).
2. `UserKeys::unlock(provider, &key_secret)` decrypts each locked user key.
3. `AddressKeys::unlock(provider, &unlocked_user_keys, legacy_passphrase)` decrypts address keys. Modern address keys contain an `EncryptedKeyToken` and `KeyTokenSignature`; the token is decrypted/verified with the user key, then used to decrypt the address key (`proton-crypto-account/src/crypto/key_import.rs`).
4. Selectors (`UserKeySelector`, `AddressKeySelector`) expose `for_signing`, `for_encryption`, `for_decryption`, `for_signature_verification`.

### 4.5 Key generation

* `LocalUserKey::generate(provider, algorithm, salted_password)` — `proton-crypto-account/src/keys/user_keys.rs`.
* `LocalAddressKey::generate(provider, email, algorithm, flags, primary, user_key)` — `proton-crypto-account/src/keys/address_keys.rs`.
* Default generation is ECC v4 (`Ed25519Legacy` + `ECDH/Curve25519`); PQC v6 (`ML-DSA` + `ML-KEM`) is available via `KeyGenerationType::PQC`.

### 4.6 SRP authentication

* `mailbox_password_hash(password, salt)` → bcrypt cost 10 → `MailboxHashedPassword`. The hashed portion (after the 29-byte prefix) becomes the `KeySecret`.
* `srp_password_hash(version, username, password, salt, modulus)` → for v3/v4, `bcrypt(password, salt || "proton")` then `SHA512(... || N)` ×4 → 256-byte `SRPHashedPassword`.
* `SRPAuth::new(...)` verifies the signed modulus against a hard-coded server public key, then `generate_proofs()` produces `SRPProof`.

### 4.7 Crypto policy

`proton-rpgp/src/profile/settings.rs` centralizes:

* Preferred symmetric/AEAD/hash/compression algorithms.
* Rejected algorithms (MD5, RIPEMD-160, SHA-1 for messages, Elgamal, DSA, secp256k1).
* S2K parameters for key vs message encryption.
* DoS limits: `max_reading_size = 50 MB`, `max_s2k_trials_per_passphrase = 5`.

---

## 5. Rust OpenPGP library landscape

| Library | Scope | Crypto backend | License vibe | RFC 9580 | Notable users / notes |
|---|---|---|---|---|---|
| **Sequoia PGP** (`sequoia-openpgp`) | Full-featured OpenPGP library + tools (including `chameleon`, a GnuPG CLI replacement) | Rust wrapper around **Nettle** (C) | GPL-family | Committed to RFC 9580 | Broad tooling, GnuPG-compatible workflows |
| **rPGP** (`rpgp`, crate name `pgp`) | Focused OpenPGP library | **Pure Rust** / RustCrypto | More permissive | Advertised as full-Rust RFC 9580 implementation | Delta Chat, Proton’s `proton-rpgp` wrapper |
| **openpgp-card** | OpenPGP smartcard client API only | PGP-implementation agnostic | — | N/A | Companion crates: `openpgp-card-rpgp`, `openpgp-card-sequoia` |
| **minipgp6** | Minimal v6-only implementation | Pure Rust | — | v6 only | Smaller scope, less mature ecosystem |
| **RNP** (`rnpgp/rnp`) | High-performance **C++** OpenPGP library | Botan or OpenSSL | BSD | RFC 4880 focused; backs LibrePGP camp | Mozilla Thunderbird |

### RFC 9580 vs. LibrePGP split

* **RFC 9580** (2024) is the IETF OpenPGP standard: 64-hex fingerprints, v6 packets, Ed25519/X25519 mandatory, AEAD-OCB, Argon2 S2K, HKDF, padding packets. It deprecates weak algorithms.
* **LibrePGP** is an alternative backed by GnuPG/RNP that is largely incompatible with RFC 9580. Thunderbird uses RNP, which places it closer to the LibrePGP camp.
* **Sequoia** and **rPGP** are both aligning with RFC 9580.

### Sequoia vs. rPGP for a new project

| Concern | Sequoia | rPGP |
|---|---|---|
| Ecosystem / tooling | Larger, includes CLI replacement | Smaller, library-only |
| Dependencies | C library (Nettle) | Pure Rust |
| License | GPL-family | More permissive |
| RFC 9580 readiness | Strong | Strong |
| Smartcard companion | `openpgp-card-sequoia` | `openpgp-card-rpgp` |
| API surface | Broader, more opinionated | Smaller, more focused |

For a **Tauri v2 desktop app** that wants a pure-Rust dependency tree and a small API surface, **rPGP is attractive**. For maximum interoperability and battle-tested GnuPG compatibility, **Sequoia is attractive**. A real Tauri v2 precedent exists: **KeychainPGP** uses Sequoia.

Sources:

* OpenPGP.org developer software list: https://www.openpgp.org/software/developer/
* RFC 9580 Datatracker: https://datatracker.ietf.org/doc/rfc9580/
* RFC 9580 text: https://www.ietf.org/rfc/rfc9580.html
* KeychainPGP (Tauri v2 + Sequoia): https://github.com/KeychainPGP/keychainpgp
* openpgp-card: https://codeberg.org/openpgp-card/openpgp-card
* openpgp-card-rpgp: https://codeberg.org/openpgp-card/rpgp

---

## 6. Current codebase comparison — Kylins Client

### 6.1 Patterns we already follow

| Pattern in `proton-crypto-rs` | Where Kylins aligns | Notes |
|---|---|---|
| Backend owns secrets and crypto | `kylins.client.backend/src/crypto.rs` already caches a 256-bit master key and exposes `encrypt_secret` / `decrypt_secret`. | Good boundary — frontend never sees raw secrets. |
| OS keyring for master key | `crypto.rs` uses `keyring` crate for service `mailclient` / user `master-key`. | Same approach Proton uses for session encryption key storage. |
| SQLite as encrypted metadata store | Kylins stores encrypted account secrets in SQLite (`db/accounts.rs`). | Can be extended for OpenPGP key metadata + encrypted secret blobs. |
| Builder-pattern MIME construction | `kylins.client.backend/src/mail/builder.rs` already builds `SendDraft` into RFC5322 MIME using `mail-builder`. | Natural hook point for PGP/MIME wrapping. |
| Event-driven frontend updates | Tauri events (`sync:delta`, `sync:new-mail`, etc.) already propagate backend state. | Decryption/verification results can use the same mechanism. |

### 6.2 Patterns we miss

| Pattern in `proton-crypto-rs` | What Kylins lacks | Impact |
|---|---|---|
| Provider trait abstraction over OpenPGP backends | No OpenPGP provider trait; no OpenPGP engine at all. | Ties us to a single engine if we’re not careful. |
| Centralized crypto policy / profile | No policy file controlling allowed algorithms, AEAD, S2K, DoS limits. | Risk of accepting weak algorithms or being surprised by interop edge cases. |
| Builder-pattern OpenPGP operations | No `Encryptor`/`Decryptor`/`Signer`/`Verifier` abstraction. | Crypto code will be scattered and harder to test. |
| Account/user/address key hierarchy | Kylins is a generic IMAP/EAS client, not a Proton account. | Proton’s exact key model does not apply, but a per-account key model does. |
| Explicit unlock/cache/lock lifecycle for secret keys | Kylins only caches the master key; no per-key unlock TTL. | Needed once private keys are used repeatedly. |
| SRP / Proton-specific auth | Not applicable to Kylins. | — |

### 6.3 Should Kylins reuse `proton-crypto-rs`?

**No.** The README explicitly says it is *“Not intended or vetted for general usage outside Proton.”* Kylins is a generic email client, not a Proton service. The Proton-specific abstractions (SRP, user/address keys, SKL, device verification) are irrelevant baggage.

**What is worth copying:** the *shape* of the abstraction — a small provider trait, builder-pattern operations, a centralized crypto policy, and explicit secret lifecycle — applied to a generic email-client key model.

---

## 7. Suggested improvements for Kylins

### 7.1 Adopt a provider-trait abstraction

Create a backend-agnostic `OpenPgpProvider` trait in `kylins.client.backend/src/openpgp/`:

```rust
pub trait OpenPgpProvider: Send + Sync + 'static + Clone {
    type PublicKey: PublicKey;
    type PrivateKey: PrivateKey;
    type SignedMessage: SignedMessage;
    type EncryptedMessage: EncryptedMessage;

    fn generate_key(&self, params: KeyGenParams) -> Result<KeyPair, OpenPgpError>;
    fn encrypt(&self, op: EncryptOp) -> Result<EncryptedMessage, OpenPgpError>;
    fn decrypt(&self, op: DecryptOp) -> Result<DecryptedData, OpenPgpError>;
    fn sign(&self, op: SignOp) -> Result<SignedMessage, OpenPgpError>;
    fn verify(&self, op: VerifyOp) -> Result<VerificationResult, OpenPgpError>;
}
```

Implement it for a chosen engine (start with **Sequoia** or **rPGP**) behind a `sequoia`/`rpgp` Cargo feature.

### 7.2 Centralize crypto policy

Add `kylins.client.backend/src/openpgp/policy.rs`:

* Allowed asymmetric algorithms: Ed25519, X25519, RSA ≥3072.
* Allowed symmetric: AES-256, AES-128.
* Allowed hashes: SHA-256, SHA-384, SHA-512.
* AEAD policy: prefer OCB, fallback to SEIPDv2/v1 for compatibility.
* Reject: MD5, SHA-1, 3DES, IDEA, DSA, Elgamal, secp256k1.
* DoS limits: max message size, max S2K trials, max nested packets.

### 7.3 Builder-pattern crypto operations

Mirror Proton’s style but keep it email-generic:

```rust
let encrypted = provider.encryptor()
    .for_recipients(&recipient_keys)
    .signed_by(&sender_key)
    .with_policy(&policy)
    .encrypt(mime_bytes)?;
```

### 7.4 Explicit key lifecycle

* Store encrypted secret-key blobs in SQLite, wrapped by the existing master key.
* Cache unlocked keys in Rust memory with a TTL (e.g., 10 minutes) and an explicit lock command.
* Use `zeroize` for in-memory secret material.

### 7.5 Extend the existing hook points

* **Outbound:** `kylins.client.backend/src/mail/builder.rs` — sign-then-encrypt into RFC 3156 PGP/MIME.
* **Inbound:** `kylins.client.backend/src/sync_engine/commands.rs` and `src/mail/imap/client.rs` — decrypt/verify after fetching raw bodies.

### 7.6 Keep key discovery consent-first

* Do **not** auto-encrypt based on Autocrypt `prefer-encrypt=mutual` alone (Thunderbird’s lesson).
* Require explicit user confirmation for WKD/keyserver lookups.
* Record key provenance (`origin`) and trust state in SQLite.

---

## 8. Implementation plan

| Priority | Step | Files / crates | Verification |
|---|---|---|---|
| **P0** | Choose primary engine and add dependency/feature flag. | `kylins.client.backend/Cargo.toml` | `cargo build` succeeds with feature on/off. |
| **P0** | Define `OpenPgpProvider` trait + error types. | `src/openpgp/provider.rs`, `src/openpgp/error.rs` | Unit tests compile. |
| **P0** | Implement provider for chosen engine (key generation, armor, encrypt/decrypt, sign/verify). | `src/openpgp/engines/sequoia.rs` or `rpgp.rs` | Unit tests pass. |
| **P0** | Add `pgp_keys` table and `account_pgp_settings` migration. | `kylins.client.backend/migrations/` | `cargo test` for migrations passes. |
| **P1** | Implement key import/export/generation Tauri commands. | `src/openpgp/mod.rs`, `src/commands.rs` | Manual test via frontend or `cargo test`. |
| **P1** | Hook outbound PGP/MIME into `mail/builder.rs`. | `src/mail/builder.rs`, `src/openpgp/mime.rs` | Send an encrypted/signed test message; inspect MIME. |
| **P1** | Hook inbound decryption/verification into sync/imap path. | `src/sync_engine/commands.rs`, `src/mail/imap/client.rs` | Receive encrypted/signed test message; `is_encrypted`/`is_signed` set. |
| **P2** | Add frontend composer toggles and reading-pane security UI. | `Composer.tsx`, `ReadingPane.tsx`, `SecurityChips.tsx` | UI reflects encryption/signing state and trust. |
| **P2** | Implement WKD + keyserver lookup with explicit consent. | `src/openpgp/discovery.rs` | Lookup works and logs provenance. |
| **P2** | Add contact pinning and trust preferences. | `contacts.ts`, `SecurityPreferences.tsx` | Pinned keys override discovered keys. |
| **P3** | Autocrypt header/gossip parsing. | `src/openpgp/autocrypt.rs` | Parses but does not auto-encrypt without consent. |
| **P3** | Smartcard integration via `openpgp-card`. | `src/openpgp/smartcard.rs` | Sign/decrypt with inserted OpenPGP card. |
| **P4** | Autocrypt v2 ratchet (experimental, once draft stabilizes). | `src/openpgp/autocrypt.rs` | Rotating subkeys generated/used correctly. |

---

## 9. Key takeaways

1. **`proton-crypto-rs` is a Proton product SDK, not a reusable OpenPGP library.** Do not import it into Kylins.
2. **Its best ideas are architectural:** provider traits, builder-pattern crypto ops, centralized policy, explicit secret lifecycle, and backend feature flags.
3. **For Kylins, use a generic Rust OpenPGP engine directly.** `sequoia-openpgp` and `rpgp` are both RFC-9580-aligned; choose based on whether you prioritize GnuPG compatibility/tooling (Sequoia) or pure-Rust/minimal dependencies (rPGP).
4. **Kylins already has the right security boundary** (Rust backend + OS keyring + SQLite). Adding OpenPGP is mostly about inserting the engine at the existing MIME and sync hook points.

---

*Report generated by source-learning workflow: local read-only sweep of `proton-crypto-rs` plus web survey of the Rust OpenPGP ecosystem, compared against the Kylins Client codebase.*
