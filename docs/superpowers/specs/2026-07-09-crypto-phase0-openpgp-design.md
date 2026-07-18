# Crypto Phase 0 — OpenPGP Core (Design / Spec)

**Date:** 2026-07-09 · **Branch:** `feat/crypto-openpgp-phase0`
**Parent architecture:** `docs/crypto-architecture-plan-claude.md` (verified 2026-07-09)
**Plan:** `docs/superpowers/plans/2026-07-09-crypto-phase0-openpgp.md`

## Purpose

Phase 0 delivers the **crypto abstraction layer + a working OpenPGP backend** so the architecture can be validated end-to-end (key gen, encrypt/decrypt, sign/verify, storage) before S/MIME and 国密 are built. It is the foundational de-risking step: OpenPGP has a complete pure-Rust engine today (`pgp`/rpgp 0.20), so the `CryptoProvider` trait gets proven against a real engine immediately rather than against the half-built Rust S/MIME stack.

## Goals (in scope)

1. **Abstraction layer** (`src/crypto/`): `CryptoProvider` trait, `MsgComposeSecure` streaming trait, `CryptoPolicy`, `CryptoError`, shared types, `KeyStore` trait, `CryptoBackend` resolver. Standard-agnostic.
2. **OpenPGP backend** on **Sequoia (`sequoia-openpgp` 2.4.1, `crypto-rust` backend — pure-Rust, zero C deps)**: key generation (Ed25519 primary + X25519 subkey default; RSA-4096 option), armor import/export, encrypt/decrypt, sign/verify. Implements `CryptoProvider`. (rpgp remains an optional compile-time engine behind the trait; see `crypto-architecture-plan-claude.md` §7.1 for the licensing dimension.)
3. **DB layer**: `crypto_keys` + `trust_decisions` tables + migration + `db_*` commands. Soft private keys wrapped by the existing master-key AES-256-GCM (`crypto::encrypt`).
4. **Key lifecycle**: store armored private key encrypted at rest; unlock to `Zeroizing<Vec<u8>>` in memory; TTL cache (10 min) + explicit lock.
5. **PGP/MIME** (RFC 3156): build/parse `multipart/encrypted` + `multipart/signed`; `MsgComposeSecure` impl for OpenPGP.
6. **Send + receive hooks**: outbound PGP/MIME in `mail/builder.rs`; inbound decrypt/verify in `sync_engine`/`imap` path; set `messages.is_encrypted`/`is_signed`.
7. **Frontend**: `services/crypto/mailCrypto.ts` façade, composer toggles wired to backend, ReadingPane security state, basic KeyManager UI.

## Non-goals (later phases)

- S/MIME (Phase 1), 国密 SM2/3/4 (Phase 2), smartcard/PKCS#11 (Phase 3), RFC 9980 PQ + Autocrypt v2 (Phase 3).
- WKD/keyserver/Autocrypt discovery automation beyond a consent-gated stub.
- Encrypted-message local search index.

## Verified decisions (from `crypto-architecture-plan-claude.md`)

- **Engine: `pgp` (rpgp) 0.20** default (pure-Rust, MIT/Apache, RFC 9580-complete, `draft-pqc` feature, maintained smartcard companion `openpgp-card-rpgp`). Sequoia optional behind a feature.
- **Abstraction shape ported from `proton-crypto-rs`** (provider trait + associated types + builder sub-traits + `Arc<dyn Error>` erasure + `Zeroizing` secrets + `VerifiedData` ergonomics) and **`MsgComposeSecure` from Thunderbird's `nsIMsgComposeSecure`** (4-method streaming seam both backends share).
- **Async off-main-thread**: every crypto op runs `spawn_blocking`; results via events.
- **Trust store orthogonal to keys**, append-only (Thunderbird `openpgp.sqlite` pattern).
- **Consent-first discovery**: never auto-encrypt from `prefer-encrypt=mutual`.

## Architecture (Phase 0 slice)

```text
src/crypto/
  mod.rs            CryptoBackend enum + resolve_provider(); re-exports master_key::{encrypt,decrypt}
  master_key.rs     (MOVED from crypto.rs) AES-256-GCM + OS keyring (unchanged API)
  provider.rs       CryptoProvider trait + associated types
  compose.rs        MsgComposeSecure streaming trait
  policy.rs         CryptoPolicy + algorithm enums + defaults (RFC 9580 baseline) + allow/reject
  types.rs          PublicKey/PrivateKey/KeyPair/KeyGenParams/VerificationResult/DecryptResult/KeyOrigin
  error.rs          CryptoError(Arc<dyn Error+Send+Sync>) + Result alias
  key_store.rs      KeyStore trait (encrypted-blob at rest, TTL-cached unlock)
  openpgp/
    mod.rs          OpenPgpProvider (impl CryptoProvider) + engine dispatch
    engine.rs       rpgp 0.20 wrapper: gen/import/export/encrypt/decrypt/sign/verify
    policy.rs       OpenPGP-specific policy (S2K, AEAD, DoS limits)
src/db/crypto_keys.rs       crypto_keys CRUD
src/db/trust_decisions.rs   trust_decisions CRUD (append-only)
migrations/2026xxxxxxxxxx_crypto.sql
src/commands/crypto_commands.rs   async Tauri commands (spawn_blocking)
```

## Data model

(see `crypto-architecture-plan-claude.md` §5 — `crypto_keys` + `trust_decisions` + `accounts.crypto_method`/`crypto_policy_json` + `contacts.pinned_keys_json`)

## Security invariants (must hold after every task)

1. Private key material **never** crosses IPC — only ids/paths.
2. Soft private keys encrypted at rest with the master key (`crypto::encrypt`).
3. Unlocked private keys held as `Zeroizing<...>`, cached ≤ 10 min, explicit `lock`.
4. `CryptoPolicy` rejects MD5/SHA-1/3DES/DSA/Elgamal/secp256k1 at builder construction.
5. All crypto Tauri commands run on `spawn_blocking` (never block the UI thread).
6. `trust_decisions` is append-only.

## Verification bar (Phase 0 exit gate)

- `cargo test --lib` green (new crypto unit tests + existing suite); `cargo clippy --all-targets -- -D warnings` clean.
- Frontend `tsc --noEmit` clean; `vitest run` green.
- **Manual e2e:** exchange a signed+encrypted PGP/MIME message with Thunderbird or Proton, both directions; confirm `is_encrypted`/`is_signed` set and signature trust state shown.
