# Kylins Client — Encryption & Security Module Design

> A fresh, comprehensive design for an independent, replaceable encryption/decryption framework
> supporting S/MIME, OpenPGP, and 国密 (SM2/SM3/SM4), plus PKCS#11/HSM/smartcard, and the
> application layer that binds it to email, key management, storage, search, and UI/UX.
>
> **Status:** Approved design (brainstormed 2026-07-10)
> **Author:** design session with stakeholder
> **Supersedes:** `docs/security/crypto-architecture-design.md` v1.0 (treated as one of six research inputs)
> **Inputs:** the six research documents under `docs/security/` — `crypto-architecture-design.md` (v1.0),
> `openpgp-crypto-ecosystem-analysis-report.md`, `proton-crypto-rs-source-learning-report.md`,
> `thunderbird-crypto-implementation-analysis-report.md`, `proton-clients-security-analysis-report.md`,
> `proton-webclients-security-analysis-report.md`.

---

## 0. Decision log (locked in this session)

| # | Decision | Choice |
|---|---|---|
| 1 | Relationship to v1.0 | **Fresh comprehensive design**; v1.0 is one input among six |
| 2 | Deployment form | **Form A** — Kylins client + third-party standard servers (Exchange/O365/Gmail/Workspace/Coremail/generic IMAP-SMTP) |
| 3 | Item scope | **Email E2EE** (per-part **and** single-blob strategies). Contacts/calendar/tasks **plaintext** for now (sync over TLS); revisit only under Form B |
| 4 | Standards posture | **All three first-class and pluggable** (S/MIME, OpenPGP, 国密) + PKCS#11/HSM; **phased build** |
| 5 | UI/UX depth | **Full spec + visual mockups** |
| 6 | Framework abstraction | **Neutral envelope + `KeyHandle`** (one message type; keys are handles, not bytes) |
| 7 | Encrypted subject | **Off by default** (both standards); opt-in per account/domain |
| 8 | Unlock model | **OS-keyring master key (default)** + **optional Argon2id passphrase** (backup/recovery) + **token PIN** (HSM/smartcard) |
| 9 | At-rest stance | **Graded at-rest** — ciphertext parts cached as ciphertext, plaintext metadata, secrets via `encrypt_secret`, **no SQLCipher**; decrypted plaintext memory-only |
| 10 | Spec language | **English** |

---

## 1. Goals & requirements

| Requirement | Design response |
|---|---|
| Full OpenPGP, S/MIME, and 国密 (SM2/SM3/SM4) support | Three `CryptoBackend` implementations behind a shared `crypto-core` contract |
| Independent, replaceable framework (à la `proton-crypto-rs`) | Standalone `crypto/` Cargo workspace; pure-trait core crate; backends feature-gated |
| Pluggable algorithms (hash / symmetric / asymmetric) | Versioned `CryptoPolicy`; every backend consults it before operating |
| PKCS#11 / HSM / smartcard | `crypto-pkcs11` token layer; token executes raw primitives only; `KeyHandle::Token` makes hardware-backed keys transparent |
| Configurable, async, non-blocking | All operations `async` on `spawn_blocking`; secret hygiene via `secrecy` + `zeroize` |
| Form-A interop (Thunderbird/GnuPG/Outlook/Coremail) | Outbound serialization defaults to `SingleMimeBlob` (PGP/MIME or S/MIME); per-part reserved for future internal paths |
| Local-first privacy | Graded at-rest local store + client-side encrypted search index |

---

## 2. Reference analysis (condensed)

See §9 for the side-by-side comparison. Key takeaways that shaped this design:

- **Thunderbird** gives the right *architecture* for a Form-A client: client-only, standard-interop, explicit Sign/Encrypt, the 5-value acceptance ladder, and `collected_keys` staging that prevents key poisoning. Avoid its NSS binding and external-GnuPG smartcard split.
- **Proton** gives the right *encryption rigor*: per-part split packages, fail-closed decryption, ciphertext-at-rest with plaintext memory-only, the lock-icon state machine, and contact pinning. Drop its server-centric pieces (SRP, account-key hierarchy, Key Transparency, EncryptedOutside).
- **proton-crypto-rs** gives the right *abstraction pattern*: provider trait, builder operations, centralized policy, type-erased errors, type-level Locked/Unlocked keys, leaf-crate discipline. It is PGP-only, so the associated-types-per-provider shape does **not** generalize across differing wire formats (PGP packets vs CMS) — hence the neutral-envelope choice (§3.2).
- **rust-cryptoki** gives the PKCS#11 model: one process context, slot enumeration, session pool (sessions are not `Sync`), mechanism probing, `AuthPin` wrapping, private keys never exported.

---

## 3. Module 1 — The crypto framework (`crypto/` workspace)

A standalone Cargo workspace, a sibling to `kylins.client.backend/` and `kylins.client.frontend/`. The Tauri backend depends on it via a path dependency (`crypto = { path = "../crypto/crypto" }`), keeping the framework genuinely independent and replaceable (publishable/vendorable separately).

### 3.1 Workspace layout

```
crypto/                          (standalone Cargo workspace)
├── core/         pure traits + neutral types (zero engine deps — always compiles)
│   ├── envelope.rs    EncryptedEnvelope, SignedEnvelope, VerificationResult, Part, PartKind
│   ├── handle.rs      KeyHandle, KeyHandleRef, Origin, KeyUsage
│   ├── backend.rs     CryptoBackend trait, operation builders
│   ├── policy.rs      CryptoPolicy (hash/sym/aead/pk/kdf/dos), AlgorithmCapabilities
│   ├── error.rs       CryptoError (type-erased: Arc<dyn Error+Send+Sync>)
│   ├── keystore.rs    KeyStore trait (CRUD over KeyHandle)
│   ├── trust.rs       TrustState, TrustPolicy, TrustDecision
│   └── secret.rs      SecretBox<T> (secrecy + zeroize), Locked vs Unlocked
├── openpgp/      rpgp default; sequoia behind a feature
├── smime/        cms + x509-cert + token bridge
├── sm/           libsm default; gmssl behind a feature
├── pkcs11/       rust-cryptoki token session lifecycle
└── crypto/       façade crate: re-exports core + selected backends
```

Package names follow the workspace-namespace convention: `crypto`, `crypto-core`, `crypto-openpgp`, `crypto-smime`, `crypto-sm`, `crypto-pkcs11`. Default features: `["openpgp-rpgp", "smime", "pkcs11"]`; `sm-libsm` / `sm-gmssl` are opt-in.

### 3.2 The neutral envelope (the heart of the design)

The application layer holds **one** message shape regardless of backend. Wire-format bytes (PGP packets / CMS DER / GM-CMS) are opaque payload inside the envelope:

```rust
// crypto-core/envelope.rs
pub struct EncryptedEnvelope {
    pub standard: Standard,                   // OpenPgp | Smime | Sm
    pub serialization: SerializationStrategy, // SplitPerPart | SingleMimeBlob
    pub parts: Vec<EncryptedPart>,            // body + each attachment (per-part model)
    pub recipients: Vec<KeyPacketRef>,        // per-recipient key wraps (opaque bytes)
}

pub struct EncryptedPart {
    pub id: PartId,
    pub kind: PartKind,                       // Body | Attachment { filename, mime, content_id }
    pub ciphertext: Vec<u8>,                  // wire-format-agnostic blob
    pub signature: Option<DetachedSignature>,
}

pub enum SerializationStrategy {
    SplitPerPart,   // each part independent ciphertext + per-recipient key wrap (future internal)
    SingleMimeBlob, // whole MIME tree under one envelope (Form-A interop default)
}
```

For S/MIME, `parts` collapses to one (CMS `EnvelopedData` wraps the whole tree) — but the **same interface** still applies, so per-part and single-blob share one code path, never two parallel engines.

### 3.3 KeyHandle — software and token treated alike

Keys are **handles, not bytes**. This is what makes PKCS#11 fit cleanly:

```rust
// crypto-core/handle.rs
pub enum KeyHandle {
    Software(KeyId),                                  // bytes in KeyStore, AES-GCM at rest
    Token { token_serial: String, key_id: TokenKeyId }, // never leaves the device
}

pub struct KeyHandleRef {  // what crosses the Tauri IPC boundary — NEVER raw key bytes
    pub handle: KeyHandle,
    pub standard: Standard,
    pub fingerprint: String,
    pub usage: KeyUsage,                  // Sign | Encrypt | SignAndEncrypt
    pub algorithm: String,                // "Ed25519" | "RSA-4096" | "SM2" | ...
}
```

When encrypting/signing, the backend asks the `KeyStore` (software) or the PKCS#11 session (token) for the raw operation; the application and frontend never see raw key material.

### 3.4 CryptoBackend trait

```rust
#[async_trait]
pub trait CryptoBackend: Send + Sync + 'static {
    fn standard(&self) -> Standard;
    fn policy(&self) -> &CryptoPolicy;

    async fn encrypt(&self, op: EncryptOp) -> Result<EncryptedEnvelope, CryptoError>;
    async fn decrypt(&self, op: DecryptOp)  -> Result<DecryptedPayload, CryptoError>;
    async fn sign(&self, op: SignOp)        -> Result<SignedEnvelope, CryptoError>;
    async fn verify(&self, op: VerifyOp)    -> Result<VerificationResult, CryptoError>;

    async fn generate_key(&self, params: KeyGenParams) -> Result<KeyHandleRef, CryptoError>;
    async fn import_key(&self, data: &[u8], pass: Option<SecretString>) -> Result<KeyHandleRef, CryptoError>;
    async fn export_public(&self, h: &KeyHandle) -> Result<Vec<u8>, CryptoError>;
}
```

Verification result is **decoupled** from decryption result (from proton-crypto-rs's `VerifiedData`) — "decrypted OK, signature unverified" is a real, distinct UI state.

### 3.5 CryptoPolicy + error + secret hygiene

- **`CryptoPolicy`** — shared allow/reject lists + DoS caps (`max_message_size = 50 MB`, `max_s2k_trials = 5`). Each backend reads the subset relevant to it (国密 reads SM entries; PGP reads RFC 9580 entries). Override precedence: built-in → global → per-account → per-operation.
- **`CryptoError`** — type-erased `Arc<dyn Error + Send + Sync>`; backend native errors never cross the trait boundary.
- **Secrets** — all in-memory raw keys / session keys use `SecretBox<T>` + `ZeroizeOnDrop`; type-level `Locked` vs `Unlocked` private keys prevent accidental persistence of unlocked material.

### 3.6 Backend selection

```rust
pub fn resolve_backend(standard: Standard) -> Arc<dyn CryptoBackend> {
    match standard {
        Standard::OpenPgp => OPENPGP.clone(),   // rpgp (or sequoia under feature)
        Standard::Smime   => SMIME.clone(),
        Standard::Sm      => SM.clone(),        // libsm (or gmssl under feature)
    }
}
```

Standard is chosen per account (`crypto_method`). PKCS#11 is a **key source inside the `KeyStore`/backend**, not a fourth parallel standard — so an S/MIME signing key can move between software and token transparently.

---

## 4. Module 2 — Application layer

Binds the backends to concrete mail-client behaviour.

### 4.1 Key hierarchy & unlock model

```
Layer 0  OS Keyring master key (256-bit; existing crypto.rs — hardened first, §4.1.1)
Layer 1  Account identity keys: one PGP key / one S/MIME cert / one SM2 key per identity.
         Private halves AES-256-GCM encrypted at rest by the master key (private_data_enc).
         Token-backed keys: private half never present — token_serial + token_key_id reference it.
Layer 2  Message/attachment session keys: fresh random per-part, ephemeral, never persisted.
```

Three unlock paths coexist, all yielding the same in-memory unlocked identity key (memory TTL cache 10 min, zeroized on lock):

1. **Default** — OS-keyring master key auto-unlocks identity keys (zero friction).
2. **Optional passphrase** — a user-set Argon2id passphrase derives a KEK wrapping the identity private halves; enables backup/recovery + portability (recovery kit = BIP-39 mnemonic → derives the same KEK, from Proton).
3. **Token PIN** — for token-backed keys; PIN cached per-session/per-operation (configurable).

#### 4.1.1 P0 hardening of existing `crypto.rs` (before any standard work)

- Add AAD to the AES-GCM vault binding `account_id + field + key_version` (prevents cross-account/cross-field ciphertext replay).
- Replace the plain `[u8; 32]` master key with `secrecy::SecretBox<[u8; 32]>` + `zeroize` on drop.
- Prefix ciphertext with a key-version byte for future rotation.
- Constant-time MAC/fingerprint comparison via `subtle`.

### 4.2 KeyStore — two-tier schema (Thunderbird's anti-poisoning model)

```sql
-- Accepted keys/certs only (after explicit user action)
CREATE TABLE crypto_keys (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  standard TEXT NOT NULL CHECK(standard IN ('openpgp','smime','sm')),
  key_type TEXT NOT NULL CHECK(key_type IN ('public','private','cert')),
  email TEXT, fingerprint TEXT NOT NULL,
  public_data BLOB NOT NULL,           -- armored PGP / DER cert / SM2 cert
  private_data_enc BLOB,               -- AES-GCM(priv) for software keys; NULL for token keys
  token_serial TEXT, token_key_id TEXT,-- present only when the private half is on a token
  origin TEXT NOT NULL,                -- generated|imported|wkd|keyserver|autocrypt|contact
  is_default_sign INTEGER DEFAULT 0,
  is_default_encrypt INTEGER DEFAULT 0,
  created_at TEXT NOT NULL, expires_at TEXT,
  policy_json TEXT
);

-- Silent staging: keys seen via WKD/keyserver/Autocrypt but NOT yet accepted
CREATE TABLE collected_keys (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  account_id TEXT, peer_email TEXT, standard TEXT,
  fingerprint TEXT, public_data BLOB, source TEXT, seen_at TEXT
);

CREATE TABLE trust_decisions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  account_id TEXT, peer_email TEXT, standard TEXT, fingerprint TEXT,
  decision TEXT NOT NULL CHECK(decision IN ('rejected','undecided','unverified','verified','personal')),
  evidence_json TEXT, decided_at TEXT NOT NULL
);  -- append-only audit history

ALTER TABLE accounts ADD COLUMN crypto_method TEXT DEFAULT 'none';   -- none|openpgp|smime|sm
ALTER TABLE accounts ADD COLUMN crypto_policy_json TEXT;
ALTER TABLE contacts ADD COLUMN pinned_keys_json TEXT;               -- [{standard, fingerprint, data}]
```

Auto-discovered keys land in `collected_keys`; only after the Import Confirmation dialog (fingerprint + user-IDs + forced acceptance radio) do they move to `crypto_keys`. **Never auto-replace** an accepted key on conflict — always surface a dialog.

### 4.3 Key discovery + trust (consent-first, never auto-encrypt)

| Standard | Discovery channels | Trust/acceptance |
|---|---|---|
| OpenPGP | WKD (first, privacy-preserving z-base-32), then HKP/HKPS keyservers + keys.openpgp.org; Autocrypt header; attachment | 5-value ladder; `collected_keys` → explicit accept → `crypto_keys` |
| S/MIME | `SMIMECapabilities` on recipient cert; LDAP/GAL directory lookup; attached cert | CA-chain validation (webpki) + OCSP; per-identity signing/encryption certs |
| 国密 | SM2-cert directory / attachment; fixed 国密 profile (no cross-standard negotiation) | SM2 cert-chain validation |

Hard rules: discovery always requires explicit consent — never auto-encrypt on Autocrypt `prefer-encrypt=mutual`; never silently replace an accepted key. Fail-closed: a failing primary-key decrypt returns an empty set, never a partial/tampered set.

### 4.4 Send flow — two serialization strategies, one code path

```
Composer (sign/encrypt flags, method)
  → buildRawEmail() → canonical MIME
  → crypto.sign(detached)                      # signature over plaintext MIME
  → crypto.encrypt(parts, strategy, recipients)
       SplitPerPart   → each part: own session key → ciphertext (recipient-independent)
                       + per-recipient key_packet (re-wrap only on forward; ciphertext reused)
       SingleMimeBlob → whole MIME tree under one envelope (Form-A interop DEFAULT)
  → base64 → SMTP / EAS
```

**Strategy selection:** Form-A outbound is always `SingleMimeBlob` (PGP/MIME or S/MIME); `SplitPerPart` never goes over public SMTP — it is reserved for future internal/partial-load paths, but the **same `encrypt_parts` interface is built from day one**, so there is no parallel engine. S/MIME is naturally single-blob (one `EnvelopedData`); it collapses `parts` to one and reuses the same code path.

**Encrypted subject (off by default):** when the user opts in, the real subject goes into the inner encrypted MIME; the outer `Subject:` = placeholder (`...`). Opt-in is per account/domain. The decrypted real subject lives in memory + the encrypted index only — **never written back** to the row.

### 4.5 Receive flow — decrypt and verify decoupled

```
IMAP fetch raw MIME → detect_crypto_type(content-type)
  → crypto.decrypt(parts)        [token PIN prompt if key on token]
  → crypto.verify(decrypted)     [separate pass — UI can show plaintext first, trust async]
  → DOMPurify → sandboxed iframe (no allow-same-origin)
  → CryptoBadge(tech, encryption, signature)
```

Detection rules: `application/pkcs7-mime; smime-type=enveloped-data` (S/MIME enc), `multipart/encrypted; protocol=application/pgp-encrypted` (PGP/MIME enc), and the signed variants. State taxonomy mirrors Thunderbird's explicit enum (valid-verified / valid-unverified / uncertain-no-key / invalid …) — never collapse "decrypted" and "verified" into one boolean.

### 4.6 Local storage form — graded at-rest (not whole-DB, not all-plaintext)

| Data | Local form | Rule |
|---|---|---|
| Message body / each attachment | cached **as server ciphertext** | decrypt runs in Rust; plaintext **never written back** to SQLite |
| Encrypted mail subject | `messages.subject` = server value (placeholder); real value memory-only + encrypted index | never write decrypted subject back |
| Metadata (id, folder, flags, time, parties) | **plaintext SQLite** | needed for list/sort/filter |
| Keys/tokens/passphrases | `encrypt_secret` wrapped, **never plaintext** | CLAUDE.md red line |
| Entire `mailclient.db` | **not encrypted** (no SQLCipher) | confidentiality = per-envelope + keyring, not whole-DB (Proton model) |

### 4.7 Local encrypted search — client-side scan, not server-side SSE

Encrypted mail can't be server-indexed, so search relies on a **local AES-GCM encrypted index**:

```
OS keyring master key → encrypt_secret wraps IndexKey K → es_config
IndexKey K (memory only) → per-item random IV → AES-GCM(es_metadata / es_content)
```

Two-phase build (**metadata first** → cheap list/filter; **content second** → evictable, capped, resumable). Query: normalize keywords → cheap metadata filter → decrypt candidates → substring AND match → stream. **Honest leak surface:** zero-knowledge to the *server* (queries never leave the client); local-disk forensics sees shape, not content (message count/timing, GCM length) — inherent to graded at-rest, not a defect. Logout/password change → `es_nuke` (destroy K + index).

---

## 5. Module 3 — PKCS#11/HSM/smartcard + 国密 backend

### 5.1 PKCS#11 / HSM / smartcard — token does primitives only

**Cardinal rule: the token executes only raw RSA/EC/SM2 sign or decrypt; all CMS/PGP structures are built in Rust.** A hardware-backed S/MIME sign is indistinguishable from a software-backed one — `KeyHandle::Token` resolves identically.

**Session lifecycle (`crypto-pkcs11`, on `rust-cryptoki`):**

```rust
pub struct TokenSession {
    pkcs11: Arc<Pkcs11>,               // one context per process, Clone-able
    slot: Slot,
    session_pool: Mutex<Vec<Session>>, // sessions are NOT Sync → pool, not one shared session
}
impl TokenSession {
    fn sign_digest(&self, h: TokenKeyId, mech: Mechanism, digest: &[u8]) -> Result<Vec<u8>>;
    fn decrypt_kek(&self, h: TokenKeyId, mech: Mechanism, wrapped: &[u8]) -> Result<Vec<u8>>;
}
```

- Slot discovery via `get_slots_with_initialized_token()` + `TokenInfo`; pick by label/serial.
- **Mechanism probing** before every op (`get_mechanism_list` / `get_mechanism_info`) → clear error if the token cannot do RSA-PSS-SHA256 / ECDSA-P256 / etc.
- `AuthPin` (`secrecy::SecretString`) wraps PINs so they never hit logs; handle `UserAlreadyLoggedIn`/`UserNotLoggedIn` per session.

**PIN UX (`PinEntry`):**

```rust
pub enum PinEntry { Provided(SecretString), ProtectedAuthPath }  // latter = vendor dialog on the reader
```

PIN caching is **configurable**: per-operation (most secure) or per-session (convenience), in `crypto.pkcs11.pin_cache`.

**Two token families:**

| Family | Path |
|---|---|
| **OpenPGP-applet smartcards** (YubiKey OpenPGP) | `openpgp-card-rpgp` + PC/SC — talks to the card directly, no external GnuPG/scdaemon (avoids Thunderbird's split UX). OpenPGP backend delegates sign/decrypt to the card. |
| **PKCS#11-only HSMs** (SafeNet, YubiHSM, national-crypto tokens) | `rust-cryptoki`; S/MIME raw RSA/EC ops go to the token. For OpenPGP subkeys on such HSMs, an `openpgp-pkcs11` bridge keeps the OpenPGP cert local while the private op hits the token. |

**Discovery & hotplug:** enumerate on startup + on device-change; re-decrypt already-open messages when a token appears (Thunderbird's `nsEncryptedSMIMEURIsService` pattern). A "Module Management" panel registers a vendor `.dll`/`.so` path and sets the default token.

### 5.2 国密 (SM2/SM3/SM4) backend — first-class, Phase 3 build

Three must-cover surfaces:

1. **SM S/MIME variant (primary):** SM2 cert + SM3 digest + SM4 symmetric, packaged in CMS per GM/T 0010 — what Coremail and domestic enterprise mail expect.
2. **OpenPGP 国密 extension:** SM2/SM3/SM4 algorithm IDs in PGP packets, following the active `draft-liu-sm-for-openpgp` (the Ribose SCA draft expired). **Feature-gated** because the IDs are not yet a stable RFC.
3. **Raw primitives:** SM2 sign/key-exchange/encrypt, SM3 hash, SM4-CBC/GCM.

**Engine selection (mirrors the libsm/gmssl trade-off):**

| Surface | Default | Feature-gated fallback |
|---|---|---|
| Raw SM2/SM3/SM4 primitives | `libsm` (pure Rust, no FFI) | — |
| Full SM-CMS interop (GM/T 0010) | evaluate `libsm` + custom CMS first | `gmssl-rs` FFI (or direct GmSSL bindgen) |
| OpenPGP 国密 | extend `rpgp` + `libsm` | — |

`SmProvider` implements the same `CryptoBackend` trait; `SmEngine` is the primitive trait:

```rust
pub trait SmEngine: Send + Sync {
    fn sm2_sign(&self, sk: &Sm2PrivateKey, id: &[u8], msg: &[u8]) -> Result<Vec<u8>>;
    fn sm2_verify(&self, pk: &Sm2PublicKey, id: &[u8], msg: &[u8], sig: &[u8]) -> Result<bool>;
    fn sm3(&self, data: &[u8]) -> [u8; 32];
    fn sm4_cbc_encrypt(&self, key: &[u8; 16], iv: &[u8; 16], data: &[u8]) -> Result<Vec<u8>>;
    fn sm4_cbc_decrypt(&self, key: &[u8; 16], iv: &[u8; 16], data: &[u8]) -> Result<Vec<u8>>;
    fn sm4_gcm_encrypt(&self, key: &[u8; 16], nonce: &[u8], aad: &[u8], data: &[u8]) -> Result<Vec<u8>>;
    fn sm4_gcm_decrypt(&self, key: &[u8; 16], nonce: &[u8], aad: &[u8], data: &[u8]) -> Result<Vec<u8>>;
}
```

**SM OIDs:** SM2-sign `1.2.156.10197.1.501`, SM2-exchange `…1.301`, SM3 `…1.401`, SM4-CBC `…1.104`, SM4-GCM `…1.104.8` — wired into the CMS builder.

**Risk posture:** `gmssl-rs` is brand-new (0.1.x, unaudited) — keep it **feature-gated, off by default**, with `libsm` as the always-on fallback; never ship GmSSL FFI in a default build until audited. National-crypto token support rides on the §5.1 PKCS#11 layer (SM2 raw ops on a GM-compliant token).

---

## 6. Module 4 — UI/UX (Proton + Thunderbird synthesis)

### 6.1 Component inventory

| Component | Surface | Purpose |
|---|---|---|
| **CryptoBadge** | message-list row + reading-pane header | the `(tech, encryption, signature)` triple → icon+color+tooltip |
| **SecurityPanel** | reading-pane, expandable from badge | signer/key-id, cert chain & CA, verification details, "discover key" actions |
| **ComposerCryptoControls** | compose toolbar — single **Security** button → popover | method picker (None/PGP/S-MIME/国密) + Sign + Encrypt + attach-key + encrypt-subject |
| **KeyAssistant** | modal, blocks send | per-recipient readiness — problematic vs ready lists, Resolve/Discover/Import |
| **ImportConfirmation** | modal, hard gate | fingerprint + user-IDs + forced acceptance radio (every import path) |
| **KeyManager / CertManager** | settings | generate / import / export / set-default / acceptance ladder / expiry; unified across standards with filter tabs (All/OpenPGP/S-MIME/国密/Smartcard) |
| **SmartcardPanel** | settings | token discovery, PIN cache policy, register vendor `.dll`/`.so` |
| **CryptoPreferences** | settings | global + per-account method, policy JSON, discovery-consent toggles |

### 6.2 Badge state machine — the triple

`tech ∈ {OpenPGP, S/MIME, 国密}` × `encryption ∈ {none, ok, failed}` × `signature ∈ {not-signed, valid-verified, valid-unverified, invalid, unknown-key, mismatch}` → icon + color:

| State | Icon | Color | Meaning |
|---|---|---|---|
| Encrypted + sig valid-verified | 🔒✅ | green | best case |
| Encrypted + sig valid-unverified | 🔒✅ | blue | encrypted, key not yet accepted |
| Encrypted + unsigned | 🔒 | blue | encrypted, not signed (shown explicitly) |
| Encrypted + sig invalid | 🔒⚠️ | red | tamper/key-mismatch — alert |
| Signed-only valid-verified | ✒️✅ | green | signed, not encrypted |
| Signed-only invalid | ✒️⚠️ | red | bad signature |
| Plaintext | — | — | no badge |

**Borrowed hard rule (Thunderbird):** plaintext mail suppresses the bad-signature indicator, but **encrypted mail always shows signature status** — never let "encrypted" read as "safe."

### 6.3 Trust + send-readiness states

- **Acceptance ladder (per key, per email):** `rejected · undecided · unverified · verified · personal` — only `verified`/`personal` auto-qualify a recipient key for encryption.
- **Send-readiness (per recipient):** `ready · no-key · expired · rejected · alias · conflict` — Send stays disabled until all green; conflicts/missing-keys route to KeyAssistant. Last-millisecond re-verification before send (anti-downgrade).

### 6.4 Key flows

- **Send:** composer flags → readiness check (all recipients) → if all green, sign-then-encrypt → SMTP/EAS; else open KeyAssistant.
- **First signed inbound:** badge → expand SecurityPanel → TrustDialog (fingerprint + UIDs + forced acceptance) → `collected_keys` → `crypto_keys`.
- **Import (any path):** ImportConfirmation gate → acceptance choice.
- **Smartcard insert:** detected → already-decrypted messages re-decryptable; PIN prompt per configured policy.

### 6.5 Accessibility

Never color-only — every badge is **icon + text label + color**; ARIA labels carry the full state sentence; all dialogs keyboard-accessible with focus trap; uncertainty expressed in copy ("Uncertain Digital Signature").

> Visual mockups for the badge grammar, composer Security-popover, and Key/Cert Manager + import gate were produced in the brainstorming companion and persist under `.superpowers/brainstorm/`.

---

## 7. Frontend & Tauri integration

### 7.1 Frontend service (invoke-only façade; never holds keys)

```typescript
// kylins.client.frontend/src/services/crypto/mailCrypto.ts
export async function signEmail(accountId, inputPath, outputPath, detached): Promise<void>;
export async function encryptEmail(accountId, inputPath, outputPath, recipients, strategy): Promise<void>;
export async function decryptEmail(accountId, inputPath, outputPath): Promise<DecryptResult>;
export async function verifyEmail(accountId, signedPath, detachedDataPath?): Promise<VerificationResult>;
export async function checkSendReadiness(accountId, recipients, method): Promise<RecipientReadiness[]>;
```

### 7.2 Tauri commands (`commands/crypto_commands.rs`)

`crypto_sign`, `crypto_encrypt`, `crypto_decrypt`, `crypto_verify`, `crypto_generate_key`, `crypto_import_key`, `crypto_export_public`, `crypto_with_key`, `check_send_readiness`, plus the encrypted-search set (`es_init`, `es_seal_item`, `es_open_item`, `es_nuke`, `es_rekey`). All async on `spawn_blocking`. **Private keys never cross the invoke boundary** — only file paths and `KeyHandleRef`s.

### 7.3 Settings keys

```
crypto.method            = 'none' | 'smime' | 'openpgp' | 'sm'
crypto.policy            = JSON
crypto.encrypt_subject   = false (default)        // per-account/domain opt-in
crypto.pkcs11.lib        = vendor .dll/.so path
crypto.pkcs11.pin_cache  = 'per_op' | 'per_session'
crypto.smime.default_sign_cert / default_encrypt_cert
crypto.openpgp.keyring
crypto.es.enabled / .index_key_wrapped / .limited
```

---

## 8. Dependencies (new)

| crate | use | phase |
|---|---|---|
| `pgp` (rpgp) | OpenPGP engine | P2 |
| `sequoia-openpgp` | OpenPGP alt engine (feature) | P2 |
| `cms`, `x509-cert`, `x509-parser` | CMS / X.509 | P1 |
| `rsa`, `p256`, `p384`, `p521` | software asymmetric | P1 |
| `sha2`, `sha3`, `aes`, `aes-gcm`, `cbc` | hash / symmetric | P1 |
| `cryptoki` | PKCS#11 | P4 |
| `secrecy`, `zeroize`, `subtle` | secret hygiene | P0 |
| `libsm` | 国密 primitives | P3 |
| `gmssl-rs` | 国密 FFI (feature, off by default) | P3 |
| `openpgp-card-rpgp` | OpenPGP smartcard | P4 |
| `openpgp-pkcs11-sequoia` | PKCS#11 OpenPGP bridge | P4 |

Existing `mail-builder`/`mail-parser`, `sqlx`, `keyring`, `reqwest` are reused.

---

## 9. Proton vs Thunderbird comparison + optimal synthesis

| Dimension | Proton | Thunderbird | **Kylins synthesis** |
|---|---|---|---|
| Architecture | server-centric zero-knowledge | client-only, standard interop | **TB model** (Form A, client-only, 3rd-party servers) |
| Standards | PGP only | PGP + S/MIME | **all three**: PGP + S/MIME + 国密 |
| Key model | user/address-key hierarchy + SRP | NSS certs + RNP keyring | **neutral `KeyHandle`**, OS-keyring master + optional passphrase + token PIN |
| Granularity | split packages (per-part) | single MIME blob | **both strategies, one interface**; single-blob = Form-A default |
| Trust | pinning + API-verified + Key Transparency | 5-value acceptance + `collected_keys` | **TB's ladder + collected_keys** + Proton's pinning (no KT) |
| Discovery | API + WKD | WKD → keyserver → Autocrypt | **TB's discovery**, consent-first |
| Search | local AES-GCM index (client-side) | server/index | **local AES-GCM index**, scan-based |
| Local storage | ciphertext cache, plaintext memory-only | plaintext local | **Proton's graded at-rest** (no SQLCipher) |
| UI | lock-icon state machine, no Sign toggle | explicit Sign/Encrypt + cryptoBox | **explicit Sign/Encrypt** (popover) + Proton's lock grammar + readiness gate |
| Smartcard/HSM | none | NSS PKCS#11 + OpenPGP via external GnuPG | **`rust-cryptoki` + `openpgp-card-rpgp`** — no NSS, no external GnuPG |
| 国密 | none | none | **own design** (libsm default / gmssl gated) |
| Unlock | password-derived (SRP+salt), fail-closed | master password → NSS token | **OS-keyring + passphrase + token PIN**, fail-closed |

**Optimal solution in one line:** take Thunderbird's interoperable client-only architecture, graft on Proton's encryption rigor (per-part model, fail-closed decryption, ciphertext-at-rest, lock-icon grammar, contact pinning), add 国密 as a first-class backend, and rebuild it all on modern pure-Rust crates with no NSS and no external GnuPG — behind a neutral-envelope + `KeyHandle` framework so all three standards + PKCS#11 share one contract.

---

## 10. Phased roadmap

**Phase 0 (P0, prerequisite):** harden existing `crypto.rs` (§4.1.1) + scaffold `crypto-core` trait crate (neutral envelope, `KeyHandle`, `CryptoBackend`, `CryptoPolicy`, `CryptoError`). Zero engine deps.

**Phase 1 — S/MIME:** `crypto-smime` (CMS via `cms`, X.509 via `x509-cert`/`x509-parser`, software RSA/EC), cert store + chain validation (webpki), MIME packaging, `crypto_keys`/`trust_decisions` migrations, Tauri commands, CryptoBadge + SecurityPanel, send/receive hooks.

**Phase 2 — OpenPGP:** `crypto-openpgp` (rpgp), WKD/keyserver/Autocrypt discovery, 5-value trust + `collected_keys`, PGP/MIME packaging, Composer Security-popover + KeyAssistant + KeyManager, per-recipient readiness + anti-downgrade re-verify.

**Phase 3 — 国密:** `crypto-sm` (libsm primitives; gmssl feature-gated for full SM-CMS / GM/T 0010), SM2 cert management, SM4 content encryption, OpenPGP-国密 draft behind a feature flag.

**Phase 4 — Advanced/compliance:** PKCS#11/HSM (`rust-cryptoki`) + OpenPGP smartcard (`openpgp-card-rpgp`), full OCSP/CRL, local encrypted search index, enterprise CA/LDAP/GAL. (RFC 9980 post-quantum and contact/calendar E2EE remain deferred.)

---

## 11. Risks & best practices

**Top risks & mitigations**

| Risk | Mitigation |
|---|---|
| `gmssl-rs` immaturity | feature-gated, off by default, `libsm` fallback always-on |
| OpenPGP-国密 algorithm IDs not standardized | feature flag, follow active draft |
| PKCS#11 driver variance | mechanism probing + user-configurable library path + clear errors |
| UI-blocking crypto | every op async on `spawn_blocking` |
| Weak-algo acceptance | `CryptoPolicy` defaults reject MD5/SHA-1/3DES/DSA; versioned |
| Private-key IPC leak | keys never cross the invoke boundary; paths/handles only |
| Accidental auto-trust | consent-first discovery, never auto-encrypt, never auto-replace accepted keys |

**Best-practices checklist**

- [ ] All crypto operations `async` on `tokio::task::spawn_blocking`.
- [ ] Sensitive buffers use `secrecy::SecretVec`/`SecretString` + `zeroize`; constant-time compare (`subtle`).
- [ ] Per-part session keys (body + each attachment independent); ciphertext recipient-independent; only key-wrapping varies per recipient.
- [ ] Decrypt decoupled per part: a single attachment can be downloaded/decrypted without forcing the whole message.
- [ ] Outbound always `SingleMimeBlob` (Form A); `SplitPerPart` never on public SMTP.
- [ ] Encrypted subject **off by default**, opt-in per account/domain; never write decrypted subject back to the row.
- [ ] Graded at-rest: ciphertext parts as ciphertext, plaintext metadata, secrets via `encrypt_secret`, no SQLCipher; decrypted plaintext memory-only.
- [ ] Encrypted-search index key wrapped by `encrypt_secret`, never plaintext on disk; per-item random IV; content evictable + capped; logout/lock clears K.
- [ ] Trust-decisions table append-only (full audit history).
- [ ] Decrypted HTML still goes through DOMPurify + sandboxed iframe.
- [ ] Key discovery always explicit-consent; never auto-encrypt.
- [ ] Unit tests + mock token + real-token feature gate.

---

## 12. References

- RFC 9580 (OpenPGP), RFC 9980 (PQC in OpenPGP), RFC 8551 (S/MIME 4.0), RFC 5652 (CMS), RFC 3156 (PGP/MIME), RFC 5280 (X.509 profile).
- `draft-liu-sm-for-openpgp` (SM2/SM3/SM4 OpenPGP); GM/T 0010 (SM CMS).
- Crates: `pgp`/rpgp, `sequoia-openpgp`, `cms`, `x509-cert`, `cryptoki`, `libsm`, `gmssl-rs`, `openpgp-card-rpgp`.
- Local reference sources: Thunderbird (`opensource/thunderbird-desktop`), proton-crypto-rs (`opensource/Proton/proton-crypto-rs`), rust-cryptoki (`opensource/pkcs11/rust-cryptoki`).
- Research docs: the six files under `docs/security/`.

---

*This design was produced via a brainstorming session synthesizing the six `docs/security/` research reports with Proton's and Thunderbird's architecture, rebuilt on modern pure-Rust crates behind a neutral-envelope + KeyHandle framework.*
