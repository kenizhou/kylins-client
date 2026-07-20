# Crypto Phase 2 — OpenPGP Engine Core (Design / Spec)

**Date:** 2026-07-19
**Branch:** `feat/crypto-openpgp-engine-core` (off `main`, post-`feat/encryption-granularity` merge `33fb7a4`)
**Parent architecture:** `docs/superpowers/specs/2026-07-10-crypto-security-module-design.md` · `docs/security/crypto-architecture-design.md`
**Contract source of truth:** `kylins.client.crypto/core/src/{backend,envelope,policy,handle,ids,keystore,standard,secret}.rs`
**Plan:** `docs/superpowers/plans/2026-07-19-crypto-phase2-openpgp-engine-core.md` *(to be written by `superpowers:writing-plans`)*
**Supersedes:** `docs/superpowers/specs/2026-07-09-crypto-phase0-openpgp-design.md` (stale — it predates the standalone `kylins.client.crypto/` workspace, the `CryptoBackend` trait, and the Sequoia-default engine decision; its `src/crypto/` layout and rpgp-default engine no longer apply).

## Purpose

Add OpenPGP as a peer crypto standard alongside S/MIME by implementing a new `crypto-openpgp` crate that realizes the existing `crypto_core::CryptoBackend` trait over the **Sequoia** engine (`sequoia-openpgp`, `crypto-rust` pure-Rust backend). This slice delivers **only the engine core**: key generation/import/export and encrypt/decrypt/sign/verify, proven by round-trip and cross-implementation tests. It deliberately does **not** wire the backend into the mail send/receive paths, the frontend, or any dispatch site — those are later slices. The goal is to de-risk the two hardest unknowns (Sequoia integration; trait fit) in isolation before touching the seven S/MIME-hardcoded dispatch sites the send/receive slices must refactor.

## Goals (in scope)

1. **New crate `kylins.client.crypto/openpgp/`** mirroring `smime/`, added to the `kylins.client.crypto` workspace `members`. (The backend path-dependency and dispatch land in the send slice — engine-core is self-contained within the crypto workspace.)
2. **`OpenpgpBackend`** implementing `crypto_core::CryptoBackend` (`core/src/backend.rs:59`) — all nine trait methods — returning `Standard::OpenPgp`.
3. **Key generation**: Ed25519 primary + X25519 transport-encryption subkey + Ed25519 signing subkey (RFC 9580 modern default).
4. **Key import/export**: parse armored **and** binary OpenPGP `Cert`s (TPKs); export ASCII-armored public keys.
5. **Encrypt/decrypt** of `Part` bytes (single-encryption-unit / `SingleMimeBlob`), including **sign-then-encrypt** via `EncryptOp.sign_with`.
6. **Sign/verify** (detached primary; inline supported), returning the framework `VerificationResult` / `SignatureState`.
7. **Algorithm policy**: modern write-path allow-set (ECC + RSA≥3072, AES, SHA-2); permissive read-path that accepts legacy algorithms (RSA any size, SHA-1, 3DES) and surfaces a *weak-algorithm warning*.
8. **KeyStore contract**: prove `OpenpgpBackend` works against the `crypto_core::KeyStore` trait via an in-memory test store (engine-core must not depend on the backend crate). The real `SqliteKeyStore` round-trip — proving `'openpgp'` keys store/retrieve through the shared store — is verified in the send slice, where backend + openpgp coexist.
9. **Tests**: self round-trip (gen→store→retrieve→encrypt/decrypt, sign/verify) plus cross-implementation interop with `sequoia-sq`/`gpg` (skip-if-absent).

## Non-goals (later slices — each its own spec → plan)

- **PGP/MIME (RFC 3156)** `multipart/encrypted` / `multipart/signed` framing.
- **The seven dispatch sites** (see §12) — `CryptoMethod::Openpgp`, `apply_crypto` dispatch, `send_op`, the `smime_backend()` IPC helper, `decrypt_message_with_outcome` receive routing, `get_default_signing_key` standard filter, frontend `'smime'` literals.
- **Frontend**: composer method picker, KeyManager PGP section, badge wiring.
- **Key discovery**: WKD, keyservers, Autocrypt (consent-gated stubs or full, all later).
- **Trust / Web-of-Trust context verify**: the inherent `verify_with_context_pgp` (analogous to `SmimeBackend::verify_with_context`) lands with the receive slice; engine-core `verify` is cryptographic-validity-only (see §8).
- **Smartcard / PKCS#11 / OpenPGP Card**; **PQ crypto** (RFC 9580 `draft-pqc`).
- **SplitPerPart serialization** and per-part session-key granularity (E2EE-internal future; engine-core implements `SingleMimeBlob` only).
- **Schema changes** — none. `crypto_keys.standard='openpgp'` is already allowed by the CHECK in `migrations/20260710000001_crypto_keys.sql:9`; the `KeyId` encoding `"{standard}|{fingerprint}"` (`keystore_bridge.rs:76-78`) is already standard-parameterized.

## Verified decisions (from brainstorming + architecture exploration)

- **Engine: Sequoia** (`sequoia-openpgp` 2.x, `default-features = false`, `crypto-rust` backend — pure-Rust, zero C deps). This is the locked decision for this open-source project (LGPL is acceptable); rpgp remains a possible *future* compile-time alternative behind the trait, but is **not** added in this slice. Exact version pinned in the T0 spike.
- **Approach A — trait-only minimal**: `OpenpgpBackend` implements exactly the `CryptoBackend` surface. No inherent trust-context methods, no MIME, no frontend in this slice.
- **Algorithm policy = modern write + permissive read** (see §7).
- **Key model = Ed25519 + X25519** primary/subkeys (see §6).
- **The framework was designed for this**: `CryptoBackend` is object-safe; `Standard::OpenPgp` already exists; the schema allows `'openpgp'`; `SqliteKeyStore` is standard-agnostic; `CryptoBadge` / `message_crypto_results` are standard-agnostic. This slice adds a backend and proves it; it does **not** introduce a runtime dispatch layer (every consumer outside `crypto-core` still names `SmimeBackend` concretely — that is the send/receive slice's job).

## Architecture

```text
kylins.client.crypto/
  Cargo.toml              add `openpgp` to workspace `members`
  core/                   (unchanged) the engine-agnostic contract
  smime/                  (unchanged) the S/MIME reference backend
  openpgp/
    Cargo.toml            deps: crypto-core (path), sequoia-openpgp (crypto-rust), zeroize, async-trait, tokio (rt for spawn_blocking)
    src/
      lib.rs              OpenpgpBackend struct + CryptoBackend impl + public re-exports
      engine.rs           Sequoia wrapper: gen/import/export/encrypt/decrypt/sign/verify (the only place sequoia-openpgp is touched)
      policy.rs           crypto-core CryptoPolicy ↔ Sequoia StandardPolicy; legacy-read relaxation + weak-algo detection
      keymap.rs           Sequoia Cert ↔ KeyHandleRef / StoredKey-blob (de)serialization; passphrase handling
      error.rs            sequoia::Error → crypto_core::CryptoError mapping
    tests/
      round_trip.rs       self round-trip against an in-memory KeyStore (gen→store→retrieve→encrypt/decrypt; sign/verify; sign-then-encrypt)
      interop.rs          sequoia-sq / gpg cross-impl (skip-if-absent)
      common/             shared in-memory KeyStore impl + Sequoia-Cert↔blob (de)serialization helpers used by both test files
```

**No backend changes in this slice** — not even `Cargo.toml`. The backend path-dependency, the dispatch refactor, and all send/receive wiring land in the send slice. **No frontend changes. No migrations.** This slice touches only `kylins.client.crypto/`.

## CryptoBackend trait mapping

`OpenpgpBackend::new(keystore: Arc<dyn crypto_core::keystore::KeyStore>, policy: crypto_core::CryptoPolicy)` mirrors `SmimeBackend::new` (`crypto-smime/src/lib.rs:82`). The backend resolves every `KeyHandleRef` to Sequoia key material through the held `KeyStore`.

| `CryptoBackend` method (`backend.rs:59`) | Sequoia operation | Returns |
|---|---|---|
| `standard(&self)` | — | `Standard::OpenPgp` |
| `policy(&self)` | — | the held `&CryptoPolicy` |
| `generate_key(KeyGenParams)` | `CertBuilder::new().add_userid(user_id).add_transport_encryption_subkey().add_signing_subkey().generate()` (Ed25519 primary + X25519 enc + Ed25519 sign under `crypto-rust`) | `KeyHandleRef` (Cert persisted to KeyStore; `KeyUsage::SignAndEncrypt`, `algorithm="Ed25519/X25519"`) |
| `import_key(data, pass)` | `CertParser::from_bytes(data)`; if a secret is encrypted, `secret_mut().decrypt_in_place(&passphrase)` | `KeyHandleRef` |
| `export_public(&KeyHandle)` | resolve Cert via KeyStore; `cert.armored().serialize(&mut buf)` | `Vec<u8>` (ASCII-armored) |
| `encrypt(EncryptOp)` | `Encryptor::for_recipients(msg, recipient_keys).build()` → `LiteralWriter` over the serialized parts; if `sign_with` is `Some`, wrap in a `Signer` stream first (sign-then-encrypt) | `EncryptedEnvelope { standard: OpenPgp, serialization, parts: one EncryptedPart for SingleMimeBlob, recipients: Vec<KeyPacketRef> }` |
| `decrypt(DecryptOp)` | `DecryptorBuilder::from_bytes(envelope.parts[0].ciphertext).with_policy(p, None, Helper)` where `Helper` is a `DecryptionHelper`+`VerificationHelper` over the decryption key | `DecryptedPayload { standard: OpenPgp, parts }` |
| `sign(SignOp)` | `Signer` stream over `payload` (detached → emit signature packet only; inline → one-pass + literal + sig) | `SignedEnvelope { standard: OpenPgp, payload, signature: DetachedSignature }` |
| `verify(VerifyOp)` | verify `signed.signature.signature` over `signed.payload` using the signer's public key (resolved via KeyStore, or the signature's issuer fingerprint) | `VerificationResult { state, signer, failure_reason, revocation_reason }` |

**Serialization of parts**: engine-core implements `SerializationStrategy::SingleMimeBlob` — the `Part` bytes (body, or body+attachments serialized at this layer) are encrypted as one OpenPGP literal-data message under one session key, producing **one** `EncryptedPart`. `SplitPerPart` (per-part session keys) is deferred. **No MIME framing is applied here** — the send slice owns PGP/MIME; engine-core treats `Part.data` as opaque plaintext bytes.

**Async / CPU-bound**: Sequoia operations are synchronous and CPU-bound. The trait methods are `async` (`#[async_trait]`); the impl dispatches the heavy Sequoia work via `tokio::task::spawn_blocking` so the async runtime is never blocked. *(T0 spike confirms `crypto-smime`'s async/CPU convention for consistency.)*

## Key model & generation

- **Generate**: Ed25519 primary (certify + sign) + X25519 transport-encryption subkey + Ed25519 signing subkey. This is the modern default Thunderbird/Proton/GnuPG ship; it maximizes interop while using no legacy primitives.
- **No OpenPGP S2K passphrase on generated keys.** At-rest confidentiality is provided by the existing **master-key AES-256-GCM** layer that wraps `crypto_keys.private_data_enc` (`db/crypto_keys.rs:98-103`, AAD `kylins:{account_id}:private_key:{ver}`). The generated Cert's secret material is serialized and stored under that wrap; it is held in memory only as `Zeroizing<...>`.
- **`KeyGenParams.algorithm: String`** is interpreted by the backend: `"default"` / `"Ed25519"` → the ECC layout above. Other values are rejected (RSA generation is **not** supported this slice — see §7). `KeyGenParams.passphrase`, if supplied, is used only for an export passphrase, not at-rest (at-rest is always master-key).
- **`KeyHandleRef`**: `handle = KeyHandle::Software(KeyId("openpgp|{fingerprint}"))`, `standard = OpenPgp`, `fingerprint = Cert.fingerprint()`, `usage = SignAndEncrypt`, `algorithm = "Ed25519/X25519"`. Token (`KeyHandle::Token`) is out of scope.

## Algorithm policy (modern write + permissive read)

`crypto_core::CryptoPolicy` (`core/src/policy.rs`) is **generic across all three standards** and its `default_baseline()` already allows Ed25519/X25519/P-256/P-384/RSA≥3072 + AES + SHA-2 (it also lists SM2/3/4 for the future 国密 backend). Crucially, **its enums deliberately omit SHA-1/3DES/DSA/MD5** — so the permissive-read acceptance of legacy algorithms is **not** expressible through `CryptoPolicy` and is instead a Sequoia-engine concern:

- **Write path** (generate / new encrypt / new sign): the backend intersects `CryptoPolicy` with the OpenPGP-relevant subset and consults Sequoia's `StandardPolicy` to refuse anything outside it. RSA generation is rejected this slice (`algorithm != "default"` → `CryptoError`); RSA≥3072 *recipient* keys are accepted on encrypt (interoperating with RSA correspondents is in scope; generating RSA keys is not). SHA-1/3DES/DSA/MD5 are never used to *produce* output.
- **Read path** (decrypt / verify): the backend uses a **relaxed Sequoia `StandardPolicy`** (or Sequoia's `P::encrypted_secret` / `allow_weak_crypto`-style relaxation) so legacy-encrypted/legacy-signed messages still parse and the operation succeeds. Whenever a legacy/weak algorithm (SHA-1, 3DES, RSA<3072, etc.) is encountered on the read path, the backend records it and surfaces a **weak-algorithm warning**. The warning channel is the existing diagnostic surface — the spec does **not** add new framework fields; for engine-core it is surfaced in test assertions and (in the receive slice) will map onto the existing `VerificationResult.failure_reason` / a UI warning. *(Exact warning-carrier decision deferred to the receive slice; engine-core proves detection works.)*

`policy.rs` in this crate holds the crypto-core ↔ Sequoia policy bridge and the weak-algo detector.

## Key storage & lifecycle (KeyStore integration)

- The backend holds `Arc<dyn KeyStore>`; Sequoia `Cert`s are serialized (binary TPK for the private store, armored for public export) and exchanged with the store as `StoredKey` blobs. `SqliteKeyStore` (`backend/src/keystore_bridge.rs`) is already standard-agnostic — the standard rides on `KeyHandleRef` and the `"openpgp|{fp}"` KeyId encoding — but it lives in the **backend** crate, so engine-core cannot depend on it. **Engine-core tests use an in-memory `KeyStore` impl** (under `tests/common/`) to prove the `OpenpgpBackend` ↔ `KeyStore` contract. The real `SqliteKeyStore` round-trip is verified in the send slice (where backend + openpgp coexist); the store needs no changes because it is standard-agnostic by construction.
- **Private material never crosses IPC** and is wrapped at rest by the master key. Unlocked secret material is `Zeroizing`. (Matches the security invariants the S/MIME backend already upholds.)
- `import_key`: content-sniffs armored (`-----BEGIN PGP`) vs binary; for a passphrased secret, decrypts the S2K in place, then stores the now-unprotected secret under the master-key wrap. For a public-only Cert, stores with `private_data_enc = NULL`.

## Verify semantics (engine-core)

`verify` returns **cryptographic validity + signer-key presence**, mapped to the framework `SignatureState` (`envelope.rs:138`). An OpenPGP signature can only be checked once the signer's public key is available, so the states reduce to:

- Signer's public key is in the store **and** the signature is cryptographically valid → `ValidVerified` (engine-core treats local key presence as the verify threshold; the trust/WoT layer may downgrade this in the receive slice).
- Signer's public key is **not** in the store → `UnknownKey` (the signature cannot be checked without the key; the issuer fingerprint from the signature packet is still returned in `signer`).
- Signer's public key is in the store **but** the signature is cryptographically invalid → `Invalid` (with `failure_reason`).
- No signature present → `NotSigned`.
- `ValidUnverified` (signature valid but trust/chain unverified) and `Mismatch` (identity mismatch) are populated by the **receive/trust slice**, not engine-core.

**Web-of-Trust / trust-context verification is deferred to the receive slice** (it needs trusted-key sets, TOFU state, and a `verify_with_context_pgp` inherent method analogous to `SmimeBackend::verify_with_context` — the trait cannot carry that context). For engine-core, the tests prove the `SignatureState` mapping for each branch. `failure_reason` / `revocation_reason` are populated where applicable and left `None` otherwise (PGP has no PKIX CRL concept, so `revocation_reason` stays `None` here; key revocation handling arrives with WoT).

## Error handling

- Sequoia's `openpgp::Error` is mapped to `crypto_core::CryptoError` (the existing type-erased error in `core/src/error.rs`). `error.rs` in this crate holds the `From<openpgp::Error>` mapping plus `CryptoError::msg(...)` for policy rejections (weak-algo, unsupported algorithm, passphrase failure).
- Policy violations (e.g. forcing SHA-1 on a write op) return `Err(CryptoError)` rather than silently downgrading — fail-closed, matching the crypto-core intent.

## Security invariants (must hold after every task)

1. Private key material **never** crosses IPC — only `KeyHandleRef`s (which carry fingerprints, never bytes).
2. Soft private keys encrypted at rest with the master key (`crypto_keys.private_data_enc`).
3. Unlocked secret material held as `Zeroizing<...>`.
4. Write path never emits MD5/SHA-1/3DES/DSA/Elgamal; RSA write-recipient requires ≥3072 bits.
5. `verify` never reports `ValidVerified` unless the signer key is locally known/trusted.
6. Heavy Sequoia work runs off the async worker (`spawn_blocking`).

## Testing & verification bar

- **Unit / round-trip** (`tests/round_trip.rs`, against the in-memory `KeyStore` in `tests/common/`):
  - generate → `export_public` → re-import → fingerprint stable.
  - generate → store → retrieve → encrypt to recipient → decrypt → plaintext matches (`SingleMimeBlob`).
  - sign (detached) → verify: `ValidVerified`; verify with tampered payload → `Invalid`; verify with unknown signer → `ValidUnverified`.
  - sign-then-encrypt (`EncryptOp.sign_with = Some`) → decrypt yields plaintext and an embedded valid signature.
  - policy: a forced-weak write op returns `Err`; a legacy-encrypted fixture decrypts on the read path and surfaces a weak-algo warning.
  - passphrase: import of an encrypted secret Cert fails without the passphrase and succeeds with it.
- **Cross-implementation interop** (`tests/interop.rs`, skip-if-CLI-absent so CI without the tool stays green):
  - key generated here → exported → imported by `sequoia-sq` (and/or `gpg`); message encrypted there → decrypted here, and vice-versa.
  - This mirrors the `crypto-smime` openssl interop-test precedent (`crypto-smime/src/interop_tests.rs`).
- **Gates**: `cd kylins.client.crypto && cargo test` (core + smime still green + new openpgp tests); `cargo clippy --all-targets -- -D warnings` clean across the workspace. (No backend/frontend gate changes required — those trees are untouched.)
- **Manual e2e**: *not* a gate for this slice (there is no UI path yet); the send/receive slice carries the Thunderbird/Proton interop exit gate.

## Open items to confirm in the T0 spike (first plan step)

1. Exact `sequoia-openpgp` version + the precise `crypto-rust` feature wiring for a path-dep workspace member (Context7/gitlab confirms the pattern; pin the version).
2. `crypto-smime`'s async/CPU convention — confirm `spawn_blocking` is the consistent choice.
3. Whether `crypto_core::CryptoPolicy` needs any OpenPGP-specific enum additions (e.g. AEAD is already present via `AeadAlgorithm::{Ocb,Eax,Gcm}`; Sequoia AEAD usage maps cleanly) — none expected.
4. Sequoia's recommended relaxation knob for legacy read (`StandardPolicy` customization vs the `crypto-android`-style helper) — pick the one that surfaces the weak-algo signal cleanly.

## Out-of-scope dispatch sites (for the *next* slice — enumerated here for continuity)

These are the S/MIME hardcodes a later "OpenPGP send + receive" slice must gain dispatch over (from the architecture exploration):

1. `mail/builder.rs:42` — add `CryptoMethod::Openpgp`.
2. `mail/crypto.rs:1335` `apply_crypto` — currently `&SmimeBackend`; generalize to `&dyn CryptoBackend` + per-method dispatch.
3. `sync_engine/engine.rs:998-1058` `send_op` — hardcoded `SmimeBackend::new(...)`; branch on `draft.crypto_method`.
4. `db/commands.rs:1356` `smime_backend()` IPC helper — every crypto IPC command constructs `SmimeBackend` concretely; add `openpgp_backend()` / standard dispatch.
5. `mail/crypto.rs:926` `decrypt_message_with_outcome` — receive dispatch on CMS OIDs; add PGP content-type sniff (`application/pgp-encrypted`, `multipart/encrypted`, `multipart/signed; protocol="application/pgp-signature"`, armored `-----BEGIN PGP MESSAGE-----`) → `open_crypto_message_pgp`. Also `crypto_kind_from_content_type` (`sync_engine/mod.rs:206`) needs the PGP content types.
6. `db/crypto_keys.rs:465` `get_default_signing_key` — drop the `standard = 'smime'` literal (take a `standard` param; the setter already accepts one).
7. Frontend literals: `services/composer/send.ts:83`, `buildSendDraft.ts:43`, `services/composer/types.ts:64`, `services/db/cryptoKeys.ts`, `services/db/cryptoReceive.ts:127`, `components/email/TrustDialog.tsx:102`, plus a KeyManager PGP section.

A PGP-specific inherent `verify_with_context_pgp` (trusted-key/WoT context, mirroring `SmimeBackend::verify_with_context`) and armored-secret-key export (`export_armored`) also land with the receive/key-management slices — they are explicitly **not** part of engine-core's trait surface.
