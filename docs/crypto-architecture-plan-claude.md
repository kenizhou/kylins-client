# Kylins Client — Encryption Architecture & Implementation Plan (verified)

**Author:** Claude (deep-research + source study, 2026-07-09)
**Responds to:** `docs/crypto-architecture-design.md` (v1.0, kimi-generated) and its four prerequisite reports.
**Method:** studied the 4 kimi docs + actual source (`proton-crypto-rs`, `thunderbird-desktop`, `rust-cryptoki`) + a 15-agent verification workflow (7 web-verify of current 2026 state, 2 local-source sweeps, 6-vote adversarial check on the 2 decision-critical claims; 1.96M tokens, 0 errors).

> Supersedes the earlier 21:57 draft of this file. That draft recommended **rpgp as default**; a deeper adversarial pass (3/3 votes refuted "rpgp-as-default" from rpgp's own security docs) reverses that to **Sequoia** below. The rpgp rationale (license + smartcard + precedent) survives as a documented alternative (§7.1) for the closed-source case.
>
> This plan **builds on** the v1.0 design doc, which is strong. It corrects three load-bearing decisions the verification overturned, maps everything to the **actual Kylins codebase**, and adds per-phase verification gates.

---

## 0. Executive decisions (what changed vs. the v1.0 doc)

| # | v1.0 doc says | Verified finding | This plan |
|---|---|---|---|
| 1 | **rPGP is the default OpenPGP engine** (§5.1) | rpgp's own docs disclaim security/spec-compliance; high-level API "not yet started"; open Marvin-attack vuln in `rsa` (CVE-2024-53856/57); it's a low-level building block. Sequoia 2.4.1 ships a **pure-Rust backend (`crypto-rust`)** — the "Nettle C burden" objection evaporates. **3/3 adversarial votes refuted "rpgp as default".** | **Sequoia (`crypto-rust`) is the default engine**; rPGP stays behind the `CryptoProvider` trait as a compile-time option. (Caveat: Sequoia is LGPL-2.0+ vs rpgp MIT/Apache — §7.1.) |
| 2 | **S/MIME is Phase 1** (§14) | Pure-Rust S/MIME **send** is viable, but **receive/verify is not** (`cms` has no verify/decrypt API; no RFC 5280 path validator; `cms`/`pkcs12` pre-release). A mail client *must* receive. OpenPGP receive is complete out-of-the-box in Sequoia. | **OpenPGP is Phase 1, S/MIME Phase 2** (with an explicit receive-side strategy decision — §7.2). Matches the Thunderbird report, now evidence-backed. |
| 3 | "ML-KEM-65"; "Sequoia Autocrypt ratchet"; `openpgp-card-sequoia` | RFC 9980 ID 30 is **ML-DSA-65+Ed25519** (typo). Autocrypt v2 (2025 draft) ≠ Sequoia's 2018 ratchet talk (conflation). `openpgp-card-sequoia` is **RUSTSEC-deprecated**. | Corrected throughout. Autocrypt **Level 1** now; FS/PQ (RFC 9980 / Autocrypt v2) is Phase 4. |

Everything else in the v1.0 doc — the `CryptoProvider` abstraction, `CryptoPolicy`, key lifecycle, DB schema, MIME hooks, PKCS#11/token model — holds up and is adopted below, mapped to real files.

---

## 1. Verified fact base (load-bearing, primary-sourced)

| Fact | Verdict | Source |
|---|---|---|
| RFC 9580 is the current OpenPGP standard; mandates Ed25519/X25519, AEAD, Argon2 S2K, v6 | confirmed | rfc-editor.org/rfc9580 |
| **RFC 9980** (PQ in OpenPGP, June 2026): ML-KEM-768+X25519 = **ID 35 (MUST)**; ML-DSA-65+Ed25519 = **ID 30 (MUST)**; IDs 31/36 SHOULD; 32–34 MAY | confirmed (0/3 refute) | rfc-editor.org/rfc9980.txt |
| **Sequoia 2.4.1** (2026-07-09), RFC 9580, LGPL-2.0+; **pure-Rust via `crypto-rust`** backend (Nettle only default); smartcard via `sequoia-keystore-openpgp-card` 0.2.1 | confirmed | crates.io API, sequoia-pgp.org |
| rpgp 0.20.0 pure-Rust MIT/Apache, low-level RFC 9580 (v4/v6/SEIPDv2/AEAD); high-level API "not started"; `rsa` Marvin-attack vuln (CVE-2024-53856/57); `draft-pqc`="DO NOT USE IN PRODUCTION" | confirmed | github.com/rpgp/rpgp README/SECURITY_STATUS/IMPL_STATUS |
| Rust S/MIME **send** OK in pure Rust (`cms` builder + rsa + p256/384/521 + aes-gcm); **receive/verify** not (`cms` no verify/decrypt API; `x509-verify` no RFC 5280 path; `cms` 0.3-pre, `pkcs12` 0.2-pre) | confirmed | docs.rs/cms, docs.rs/x509-verify, RustCrypto/formats |
| SM primitives exist (RustCrypto sm2/3/4 unaudited; libsm 0.6.1 pure-Rust no-audit; gmssl-rs 0.1.1 = official GmSSL FFI→C). **No GM/T 0010 SM-S/MIME in Rust** | confirmed | crates.io API, GmSSL repo |
| `openpgp-card` 0.6.1 + `openpgp-card-rpgp` 0.7.0 + `card-backend-pcsc` 0.5.1 maintained; **`openpgp-card-sequoia` deprecated (RUSTSEC-2025-0011)**; Sequoia route = `sequoia-keystore-openpgp-card` 0.2.1 | confirmed | codeberg/openpgp-card, rustsec.org |
| `cryptoki` (rust-cryptoki) 0.12.x mature; `Session` is `Send` not `Sync` (need pool); SafeNet/Luna driver SIGSEGV friction | confirmed | github.com/parallaxsecond/rust-cryptoki |
| Autocrypt v2 (FS) is a -00/-01 I-D, single adopter (Delta Chat, rpgp); **implement Autocrypt Level 1 now** | confirmed | datatracker draft-autocrypt-openpgp-v2-cert, delta.chat |
| 2024 Summit: Proton disabled auto keys.openpgp.org lookup; Thunderbird ignores Autocrypt `prefer-encrypt` (DKIM risk) | confirmed | openpgp.org 2024 summit minutes |
| No Rust/Tauri desktop **email client** ships OpenPGP/S-MIME today; Delta Chat (rpgp+Autocrypt L1, USENIX'24 verified) is closest precedent | confirmed | surveyed Mailspring/Thunderbird/Betterbird/Delta Chat/KeychainPGP |

**Source-confirmed patterns to port (from the local agents that read the real repos):**

*From `proton-crypto-rs`* — `PGPProvider` trait + 8 associated types; **three-tier builder split** (config base trait holding assoc types + fluent `with_*` / `Sync` ops trait / `Async` ops trait); `Profile`/`CryptoPolicy` (preference-*ordered* candidate lists + single preferred + `HashSet` rejected denylist + DoS limits + first-class S2K); `CryptoError` = `Arc<dyn Error+Send+Sync>` (backend's rich `thiserror` stays behind the Arc); `zeroize` on session/AEAD keys; **`VerifiedData` returns plaintext even when signature fails** (show decrypted mail + "sig failed", don't hide it); `SigningContext`/`VerificationContext` for domain separation; `CryptoClock` (server time overrides local → no clock-skew verify failures); compile-time `cargo feature` backend select + `compile_error!` guards. **Skip:** SRP, user/address/org/device key hierarchy, SKL, key transparency, device verification.

*From Thunderbird* — `nsIMsgComposeSecure` is the **shared compose seam** (`requiresCryptoEncapsulation`/`beginCryptoEncapsulation`/`mimeCryptoWriteBlock`/`finishCryptoEncapsulation`) implemented by BOTH S/MIME C++ and OpenPGP JS → our `ComposeSecure` trait; async verification off-main-thread under a **static mutex** (NSS/PGP not thread-safe → `spawn_blocking` + serialize); **separate trust store** (`openpgp.sqlite`: `undecided`/`unverified`/`verified`/`rejected`/`personal`) orthogonal to the keyring; cert-by-usage indexing (`certUsageEmailSigner`/`Recipient`).

---

## 2. Architecture (adopted from v1.0 doc, corrected, mapped to real files)

The v1.0 layered design is sound. I keep its directory layout under `kylins.client.backend/src/crypto/` and its `CryptoProvider` trait, with two refinements: (a) the trait carries the **`VerifiedData`** rule and a **`ComposeSecure`** sub-trait (Thunderbird's seam); (b) backend selection is **Sequoia-default with rPGP optional**, not the reverse.

### 2.1 Layered diagram (with real hook points)

```
React 19 frontend
  Composer {isSigned,isEncrypted,cryptoMethod}  ReadingPane security chips  SecurityPreferences/KeyManager
  services/crypto/mailCrypto.ts (thin Tauri façade)
        │  invoke / events
────────┴───────────────────────────────────────────────────────────────────  Tauri v2 IPC
commands/crypto_commands.rs            ← NEW: crypto_sign/encrypt/decrypt/verify,
  spawn_blocking + serialize (Thunderbird's static-mutex lesson)                key import/gen/export
crypto/
  provider.rs     CryptoProvider trait + ComposeSecure + VerifiedData rule
  policy.rs       CryptoPolicy (preference-ordered + denylist + DoS + S2K)   ← from proton Profile
  error.rs        CryptoError = Arc<dyn Error+Send+Sync>                       ← from proton
  key_store.rs    KeyStore trait + unlock/cache-TTL/lock + zeroize
  trust.rs        TrustPolicy (pinning / TOFU / compromised filter) + append-only
  mime.rs         PGP/MIME (RFC 3156) + S/MIME CMS (RFC 8551) wrappers
  openpgp/
    sequoia.rs    DEFAULT engine (crypto-rust backend, zero C deps)
    rpgp.rs       optional engine (feature-gated) behind the same trait
    policy.rs discovery.rs (WKD/HKP/Autocrypt-L1, consent-gated) smartcard.rs
  smime/ engine.rs(cert_store, validation) pkcs11.rs(cryptoki) mime.rs
  sm/     (Phase 3) engine.rs (libsm primitives OR gmssl-rs FFI) cms_sm.rs
db/  crypto_keys, trust_decisions, contacts.pinned_keys   ← migration
crypto.rs  EXISTING master-key (AES-256-GCM) + OS keyring  ← Layer-0 wrapper reused as-is
───────────────────────────────────────────────────────────────────────────────
Real integration hooks (already in the codebase):
  mail/builder.rs::build_mime(SendDraft)            ← OUTBOUND: sign→encrypt wrap
  sync_engine/commands.rs (request_bodies_inner,
    sync_fetch_attachment) + mail/imap/client.rs     ← INBOUND: detect→decrypt→verify
  messages.is_encrypted / is_signed                  ← already exist (currently stub)
```

### 2.2 The `CryptoProvider` trait (refined)

Adopt the v1.0 trait plus the two verified refinements (verified-data-on-sig-fail; `ComposeSecure`):

```rust
// crypto/provider.rs
pub trait CryptoProvider: Send + Sync + 'static {
    type PublicKey: PublicKey;
    type PrivateKey: PrivateKey;
    type Encrypted: EncryptedMessage;
    type Signed: SignedMessage;
    fn name(&self) -> &'static str;
    fn policy(&self) -> &CryptoPolicy;                 // from proton Profile
    fn encryptor(&self) -> Box<dyn Encryptor>;         // fluent with_*; validates against policy
    fn decryptor(&self) -> Box<dyn Decryptor>;
    fn signer(&self, key: &Self::PrivateKey) -> Box<dyn Signer>;
    fn verifier(&self) -> Box<dyn Verifier>;
    fn generate_key(&self, p: KeyGenParams) -> Result<Self::PublicKey, CryptoError>;
    fn import_key(&self, data: &[u8], pass: Option<&str>) -> Result<Self::PublicKey, CryptoError>;
}

/// Shared compose seam (Thunderbird nsIMsgComposeSecure, ported to Rust).
/// Implemented by BOTH the OpenPGP and S/MIME providers so the send path
/// is backend-agnostic — mirroring TB's beginCryptoEncapsulation /
/// mimeCryptoWriteBlock / finishCryptoEncapsulation.
pub trait ComposeSecure: Send {
    fn requires_encapsulation(&self, draft: &SendDraft) -> bool;
    fn begin(&mut self, draft: &SendDraft, recipients: &[Self::PublicKey]) -> Result<(), CryptoError>;
    fn write_block(&mut self, chunk: &[u8]) -> Result<(), CryptoError>;
    fn finish(&mut self) -> Result<Vec<u8>, CryptoError>;   // returns wrapped MIME bytes
}

/// Verified-data rule (from proton): decryption returns the plaintext even
/// when signature verification fails, AND the signature result — so the UI
/// shows the decrypted body + a "signature failed" chip, never silently hides mail.
pub struct DecryptResult { pub plaintext: Vec<u8>, pub signature: VerificationResult }
```

`CryptoError` = `Arc<dyn std::error::Error + Send + Sync>` (proton's erasure) so Sequoia/rpgp/`cms` backend errors cross the trait boundary uniformly.

### 2.3 Default policy (CryptoPolicy) — RFC 9580 / 8551 baseline

```rust
// crypto/policy.rs
pub fn default_policy() -> CryptoPolicy {
    CryptoPolicy {
        // OpenPGP (RFC 9580): AES-256/128, SHA-256/384/512, AEAD OCB/EAX, Ed25519/X25519, RSA≥3072
        // S/MIME (RFC 8551): AES-256/128-GCM, ECDSA P-256/Ed25519/RSA-PSS, SHA-256/512
        rejected: [MD5, SHA1, RIPEMD160, 3DES, IDEA, CAST5, DSA, Elgamal],  // denylist (proton HashSet)
        s2k: Argon2 { t:1, p:4, m:21 },                                      // RFC 9580
        dos: DosLimits { max_msg: 50*MB, max_s2k_trials: 5, max_nested: 32 }, // proton limits
        prefer_aead: true,
        ..defaults_per_backend()
    }
}
```
Policy precedence (v1.0 §9.2): built-in → `settings.crypto.policy` JSON → per-account override → per-op builder arg (must stay inside policy).

### 2.4 Key lifecycle & storage (adopt v1.0 §10)

* Layers 0–3 unchanged: OS-keyring master secret (exists) → HKDF account key → crypto identity key → per-message session key.
* New tables `crypto_keys`, `trust_decisions`, `contacts.pinned_keys` per v1.0 §10.2 SQL (keep as-is).
* Soft private keys: armored → `crypto::encrypt_secret` (existing master-key AES-GCM) → `private_data_enc`. Token private keys: never leave token (`token_serial`+`token_key_id`).
* Unlock cache: 10-min TTL + explicit lock; `secrecy::SecretVec` + `zeroize` (proton pattern).

### 2.5 MIME integration (the two real hooks)

**Outbound** (`mail/builder.rs::build_mime`): if `SendDraft` carries `isSigned`/`isEncrypted`/`cryptoMethod` (the flags already exist in `composerStore` + `SendDraft`, currently ignored), route through the matching `ComposeSecure` impl: **sign → then encrypt** (inner `multipart/signed`, outer encrypted) per RFC 3156 / 8551. Attachments go inside the encrypted payload (no filename leak).

**Inbound** (`sync_engine/commands.rs` body-fetch path, alongside `sync_fetch_attachment`): `detect_crypto_type(content_type)` → decrypt → verify → store decrypted canonical MIME in `message_bodies`, set `messages.is_encrypted`/`is_signed` (columns exist), generate snippet from decrypted plaintext. **Decrypted HTML still goes through DOMPurify + the sandboxed iframe** (existing `SafeHtmlFrame`).

Detection table (v1.0 §11.3): `application/pkcs7-mime; smime-type=enveloped-data|signed-data`, `multipart/signed; protocol=pkcs7-signature`, `multipart/encrypted; protocol=pgp-encrypted`, `multipart/signed; protocol=pgp-signature`, inline PGP (read-only).

---

## 3. Implementation roadmap (revised ordering + verification gates)

Strict SDD per project convention (fresh implementer + controller review + ledger entry each task); every task ends green on `cargo test --lib` + `cargo clippy --all-targets -- -D warnings` + `tsc --noEmit` + `vitest run`.

### Phase 1 — Foundation + OpenPGP (FIRST — the reversal)

OpenPGP is Phase 1 because receive/verify/decrypt is complete in Sequoia today; S/MIME receive is not.

| Task | Files | Gate |
|---|---|---|
| 1.1 `crypto/` skeleton: `CryptoProvider`+`ComposeSecure` traits, `CryptoError`, `CryptoPolicy` (default), `KeyStore` trait | `crypto/{provider,error,policy,key_store,trust,mime}.rs` | trait compiles; policy unit tests (denylist intersection) |
| 1.2 Sequoia engine (pure-Rust): `default-features=false, features=["crypto-rust"]`; impl `CryptoProvider` (gen/import/export, encrypt/decrypt, sign/verify) + `ComposeSecure` (RFC 3156 PGP/MIME) | `crypto/openpgp/sequoia.rs`, `Cargo.toml` | round-trip: sign+encrypt → decrypt+verify with Sequoia policy; v4 + v6 keys |
| 1.3 DB migration: `crypto_keys`, `trust_decisions`, `contacts.pinned_keys`; `accounts.crypto_method` | `db/crypto_keys.rs`, `db/trust_decisions.rs`, migration | migration idempotent; round-trip key row |
| 1.4 Key lifecycle: unlock (master-key wrap), 10-min TTL cache + lock, `zeroize` | `crypto/key_store.rs` | unlock/lock/expiry tests |
| 1.5 Tauri commands (async, `spawn_blocking`+serialized): `crypto_*` gen/import/export/sign/encrypt/decrypt/verify | `commands/crypto_commands.rs`, `lib.rs` register | command-shape tests + mock |
| 1.6 **Outbound hook**: `build_mime` reads `SendDraft` flags → `ComposeSecure` wrap | `mail/builder.rs`, `crypto/mime.rs` | send signed+encrypted to a test account; verify MIME structure |
| 1.7 **Inbound hook**: detect → decrypt → verify → store + `is_encrypted`/`is_signed` + snippet | `sync_engine/commands.rs`, `mail/imap/client.rs` | receive encrypted/signed mail via `felixzhou@kylins.local`; chips render |
| 1.8 Frontend: wire `isSigned/isEncrypted/cryptoMethod` (already in `composerStore`) → real invokes; `SecurityPreferences` My Keys / Trusted Contacts; `SecurityChips` trust detail | `services/crypto/mailCrypto.ts`, `Composer.tsx`, `ReadingPane.tsx`, `SecurityPreferences.tsx` | tsc + vitest; manual send+receive |
| 1.9 Key discovery: WKD + HKP (`keys.openpgp.org`), **explicit consent only** (Proton/TB lesson); Autocrypt **Level 1** header parse (parse + store provenance; do **not** auto-encrypt) | `crypto/openpgp/discovery.rs`, `autocrypt.rs` | WKD against a known domain; provenance logged |

**Phase 1 exit:** generate/import an OpenPGP key, send a signed+encrypted PGP/MIME mail, receive one, decrypt+verify, trust chip shows correct state. Interop target: round-trips with Thunderbird / Sequoia `sq`.

### Phase 2 — S/MIME (SECOND — requires a receive-side decision, §7.2)

| Task | Files | Gate |
|---|---|---|
| 2.1 `cms` + `x509-cert` + `der` + `rsa`/`p256…` + `aes-gcm`: **build side** (SignedData detached + EnvelopedData) | `crypto/smime/engine.rs`, `mime.rs` | build a SignedData+EnvelopedData that Thunderbird verifies |
| 2.2 **Receive side** (the gap): CMS decrypt + signature verify (DIY over `cms` parse + RustCrypto), RFC 5280 path validation, OCSP/CRL. **Decision §7.2**: DIY vs OpenSSL/NSS binding vs wait for RustCrypto maturity. | `crypto/smime/validation.rs` | verify a Thunderbird-signed+encrypted mail end-to-end |
| 2.3 Cert store: X.509 import (PEM/DER + PKCS#12 via pre-release `pkcs12`), per-email+usage index (`certUsageEmailSigner`/`Recipient`) | `crypto/smime/cert_store.rs`, `db/certs.rs` | import a `.p12`; chain validation |
| 2.4 `ComposeSecure` impl for S/MIME; outbound multipart/signed + enveloped-data | `mail/builder.rs` | send S/MIME Thunderbird can decrypt |
| 2.5 Inbound detection for pkcs7-mime/multipart-signed; frontend cert manager + per-account cert prefs | `sync_engine/commands.rs`, `CertManager.tsx` | round-trip with Thunderbird |

**Phase 2 exit:** import an S/MIME cert, send+receive signed+encrypted S/MIME that interops with Thunderbird/NSS.

### Phase 3 — Chinese national crypto (SM2/SM3/SM4)

Verification found **no GM/T 0010 SM-S/MIME exists in Rust.** Two paths (pick by §7.3):
- **3a primitives-first**: RustCrypto `sm2/sm3/sm4` (or `libsm`) for SM2/SM3/SM4, then build CMS-SM (GM/T 0010) yourself → bespoke, interop-test vs GmSSL/Coremail.
- **3b FFI**: `gmssl-rs` (official, by GmSSL's author; 0.1.1) → real GM/T 0010, but GmSSL C dependency (CMake, Windows/macOS distribution burden).

Either way: `SmProvider : CryptoProvider`, SM2 cert store, SM4-CBC/GCM content encryption, OpenPGP-SM algorithm IDs follow the latest IETF draft (not yet RFC). **Feature-gated, off by default.**

### Phase 4 — Advanced / compliance

1. Smartcards: `sequoia-keystore-openpgp-card` (Sequoia-native) **or** `openpgp-card` + `openpgp-card-rpgp` + `card-backend-pcsc` (if rpgp feature). S/MIME token via `cryptoki` (session pool for `!Sync`). **Not** `openpgp-card-sequoia` (RUSTSEC-deprecated).
2. **RFC 9980 post-quantum** (IDs 30/35) — experimental, once engines expose it (rpgp `pqc` feature; Sequoia `…-pqc.1` alpha tracks it).
3. Autocrypt v2 forward-secrecy — **only after it leaves I-D status** (currently -00/-01, single adopter).
4. OCSP/CRL hardening; enterprise CA/LDAP/GAL; encrypted-mail local search index.

---

## 4. Risk register (verified, updated)

| Risk | Evidence | Mitigation |
|---|---|---|
| rpgp `rsa` Marvin-attack vuln (CVE-2024-53856/57); rpgp self-disclaims spec-compliance | rpgp SECURITY_STATUS | Default to **Sequoia**; rpgp optional + ECC-only (avoid its RSA path) |
| Pure-Rust S/MIME receive-side missing (no CMS verify/decrypt, no RFC 5280 path, pre-release `cms`/`pkcs12`) | docs.rs/cms, x509-verify | Phase 2 gated on §7.2; don't promise S/MIME receive until 2.2 lands |
| SM S/MIME (GM/T 0010) has no Rust impl; gmssl-rs is FFI→C, unaudited | crates.io, GmSSL repo | Phase 3, feature-gated off; primitives-first where possible; interop-test vs GmSSL |
| `openpgp-card-sequoia` deprecated (RUSTSEC-2025-0011) | rustsec.org | Use `sequoia-keystore-openpgp-card` (Sequoia) or `openpgp-card-rpgp` (rpgp) |
| Crypto blocks UI | Thunderbird static-mutex pattern | All crypto commands `async` + `spawn_blocking`, serialized |
| Private key over IPC | — | Keys never serialized to `invoke`; file paths / handles only |
| Weak-algorithm acceptance | RFC 9580/8551 | `CryptoPolicy` denylist (MD5/SHA1/3DES/DSA/Elgamal) + versioned |
| Autocrypt auto-encrypt spoofing | 2024 OpenPGP Summit | Parse + store only; never auto-encrypt without explicit consent |

---

## 5. Best-practices checklist (carry from v1.0 §15.2, verified-relevant)

- [ ] all crypto `async` + `spawn_blocking`, serialized (Thunderbird mutex lesson)
- [ ] `secrecy`/`zeroize` on all secret material; constant-time compare (`subtle`) for MACs/fingerprints
- [ ] `VerifiedData`: decrypt returns plaintext even on sig failure (proton) — never hide mail
- [ ] `CryptoClock`: allow server-time override to avoid clock-skew verify failures (proton)
- [ ] decrypted HTML → DOMPurify + sandboxed iframe (existing `SafeHtmlFrame`)
- [ ] key discovery explicit-consent only (Proton/TB lesson)
- [ ] `trust_decisions` append-only (audit history)
- [ ] private keys never cross IPC (paths/handles only); wrapped at rest by existing master key
- [ ] mock-token + real-token feature gates; 200MB attachment streaming, <100MB peak

---

## 6. Standing on the v1.0 doc

Adopted unchanged: overall layered architecture (§3), `CryptoProvider` trait shape (§4), DB schema SQL (§10.2), MIME detection table (§11.3), frontend services + settings keys (§12), PKCS#11 token model (§8), OID table (§7.5). The v1.0 doc is a strong base; this plan corrects its engine default, phase order, and three factual slips, and binds each task to a real file + verification gate.

---

## 7. Open decisions for you

1. **Engine license (§7.1)** — Sequoia is LGPL-2.0+; rpgp is MIT/Apache. If Kylins will be **closed-source/proprietary**, LGPL imposes dynamic-link/relinking obligations and rpgp (+ a hand-built or `rpgpie` semantics layer) may be preferable despite the verified maturity gaps. If Kylins stays **open-source** (current signals: public GitHub, velo Apache-2.0 port), **Sequoia is the clear default.** *Which licensing path?*
2. **S/MIME receive-side strategy (§7.2, Phase 2 crux)**: (a) DIY the CMS verify/decrypt + RFC 5280 path validator in pure Rust (most work, keeps pure-Rust); (b) bind OpenSSL or NSS for verify/decrypt only (pragmatic, breaks pure-Rust); (c) defer S/MIME until RustCrypto `cms`/`x509-verify`/`pkcs12` stabilize. *Which?*
3. **SM path (§7.3)** — primitives-first (3a) vs gmssl-rs FFI (3b)? (Recommend 3a for primitives now; 3b only if GM/T 0010 SM-S/MIME interop is a hard near-term requirement.)

---

### Sources (primary)

RFC 9580 (OpenPGP) · RFC 9980 (PQ in OpenPGP, 2026-06) · RFC 8551 (S/MIME 4.0) · RFC 5652 (CMS) · RFC 3156 (PGP/MIME) · rfc-editor.org, datatracker.ietf.org · github.com/rpgp/rpgp (README, SECURITY_STATUS, IMPL_STATUS) · sequoia-pgp.org (`crypto-rust` backend) · crates.io API (`pgp` 0.20, `sequoia-openpgp` 2.4.1, `cms`, `x509-verify`, `pkcs12`, `libsm` 0.6.1, `gmssl-rs` 0.1.1, `openpgp-card` 0.6.1, `openpgp-card-rpgp` 0.7.0, `sequoia-keystore-openpgp-card` 0.2.1, `cryptoki` 0.12) · rustsec.org RUSTSEC-2025-0011 · codeberg.org/openpgp-card · 2024 OpenPGP Email Summit minutes · Song et al., USENIX Security 2024 (Delta Chat verification) · local source: `proton-crypto-rs`, `thunderbird-desktop`, `rust-cryptoki`.

*Generated by `/deep-research` (15-agent verification workflow, 1.96M tokens, 0 errors) + local source study + the four kimi reports. All load-bearing facts primary-sourced; the two decision-critical claims survived adversarial 3-vote refutation (RFC 9980) or were killed by it (rpgp-as-default).*
