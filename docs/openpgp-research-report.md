# OpenPGP in Proton Mail, Thunderbird, and Kylins Client

**Research date:** 2026-07-08  
**Scope:** Compare the OpenPGP email-encryption implementations in Proton Mail clients (local Rust SDK at `D:\Projects\mailclient\opensource\Proton\clients`) and Mozilla Thunderbird desktop (local tree at `D:\Projects\mailclient\opensource\thunderbird-desktop`), then design an OpenPGP layer for Kylins Client (`D:\Projects\mailclient\kylins`).

---

## 1. Executive summary

| Dimension | Proton Mail clients | Thunderbird desktop | Kylins (proposed) |
|---|---|---|---|
| **Crypto engine** | Web: OpenPGP.js v6 via `pmcrypto` (archived standalone repo, now part of Proton WebPackages); Native Rust SDK: `proton-crypto` → `proton-rpgp` (`rpgp` 0.19) with optional `gopenpgp-sys` (Go/FFI). | RNP (C++/Botan) as default engine; optional external GnuPG/GPGME only for secret-key ops (smartcards, decryption fallback). | Rust-native engine in Tauri backend. **Primary: `sequoia-openpgp`**. **Alternative: `rpgp`**. |
| **Key storage** | Locked keys in local SQLite (`users.keys`, `addresses.keys`); passphrase-derived `KeySecret` encrypted under a per-session AES-GCM key stored in OS keychain. | Classic keyrings `secring.gpg` / `pubring.gpg`; automatic random passphrase encrypted by NSS SDR in `encrypted-openpgp-passphrase.txt`. | Encrypted secret-key blobs in SQLite, wrapped by the existing OS-keyring master key (`crypto.rs`); public metadata in SQLite. |
| **Key discovery** | Proton `/core/v4/keys/all` endpoint + contact pinned keys (signed vCards); WKD-sourced keys returned as “unverified”; keys.openpgp.org auto-lookup disabled after user pushback. | WKD, HKP/HKPS keyservers, Autocrypt headers/gossip, GnuPG keyring fallback; records key provenance; ignores Autocrypt encryption-preference headers (DKIM concerns). | Explicit-consent WKD/keyserver/Autocrypt; contact pinning with compromised-key filtering; provenance tracking. |
| **Trust model** | TOFU-like: pinned contact keys preferred over API keys; compromised keys filtered; no full web-of-trust. | Acceptance decisions in `openpgp.sqlite` (`undecided`/`unverified`/`verified`/`rejected`/`personal`); alias rules. | Contact pinning + TOFU + compromised-key filtering; “unknown / unverified / verified / trusted” signature states. |
| **PGP/MIME** | PGP/MIME only; inline PGP not supported. | RFC 3156 PGP/MIME + inline PGP + protected headers + Autocrypt gossip. | RFC 3156 PGP/MIME first; inline PGP read-only for compatibility. |
| **Smartcards** | None found in local Rust SDK. | Only via external GnuPG; RNP has no native smartcard support. | Via `openpgp-card` + backend-specific companion crate (`openpgp-card-sequoia` or `openpgp-card-rpgp`). |
| **Forward secrecy** | None for standard OpenPGP email. | None for standard OpenPGP email; AEAD disabled for compatibility. | None by default; offer Autocrypt v2 ratchet as an opt-in experimental mode. |

**Bottom line for Kylins:** Kylins’ existing architecture—Rust backend owns the database, MIME building, sync engine, and OS-keyring-backed master key—maps almost perfectly onto a Rust-native OpenPGP engine. The cleanest path is to add OpenPGP operations behind the existing IPC boundary, keep all secret-key material in Rust, and expose a thin TypeScript service façade to the React UI.

---

## 2. Proton Mail clients

### 2.1 What the local repo contains

`D:\Projects\mailclient\opensource\Proton\clients` is the Rust part of the Proton client SDK. It does **not** contain the TypeScript web-client code; that lives in Proton WebPackages and historically used [`pmcrypto`](https://github.com/ProtonMail/pmcrypto) (now archived and folded into WebPackages). The local tree is the shared Rust crypto/mail SDK used by iOS, Android, and TUI clients.

### 2.2 Architecture

```text
UI / platform host
   └── mail-uniffi (FFI) / mail-tui
         └── core-common AuthStore + OS keychain
               └── mail-stash SQLite DB (locked keys, encrypted tokens)
                     └── core-key-manager / crypto-inbox
                           └── proton-crypto-account / proton-crypto
                                 └── proton-rpgp (rpgp 0.19)  OR  gopenpgp-sys (Go)
```

Key crates observed in the local tree:

| Crate | Role |
|---|---|
| `proton-crypto` | Generic OpenPGP + SRP provider façade. |
| `proton-crypto-account` | `LocalUserKey`, `LocalAddressKey`, `KeySalt`, `KeySecret`, `EncryptionPreferences`. |
| `proton-crypto-subtle` | Low-level AES-GCM, HKDF. |
| `proton-rpgp` | Pure-Rust OpenPGP backend on top of `rpgp` 0.19. |
| `gopenpgp-sys` | Rust FFI/bindgen wrapper around Proton’s Go `gopenpgp`. |
| `project/mail/rust/crypto/crypto-inbox` | Encrypt/decrypt/sign/verify messages and attachments. |
| `project/mail/rust/crypto/crypto-inbox-mime` | Parse/build PGP/MIME bodies (`mail_parser` / `mail_builder`). |
| `project/mail/rust/crypto/crypto-contact-keys` | Extract pinned keys from signed vCards. |
| `project/mail/rust/core/core-key-manager` | Load/unlock/select/cache user and address keys. |
| `project/mail/rust/account/account-api` | Login, SRP, key setup, password change. |
| `project/mail/rust/core/core-common` | `AuthStore`, `SessionEncryptionKey`, OS keychain abstraction. |
| `project/mail/rust/shared/mail-stash` | SQLite ORM; user/address keys persisted as JSON. |

The workspace `Cargo.toml` selects `features = ["facet", "rustpgp"]` for `proton-crypto`, so this build prefers the Rust `proton-rpgp` path, but `Cargo.lock` still pulls `gopenpgp-sys` 0.3.6, so both backends are present.

### 2.3 Key generation and derivation

* New user keys are generated in `core-key/src/keys/new_user_key.rs` (`NewUserKey::init`), defaulting to ECC.
* New address keys are generated in `core-key/src/keys/new_addr_key.rs` and signed by the unlocked user key.
* The user password is hardened with **bcrypt** using a per-user `keySalt` to derive the OpenPGP key passphrase / `KeySecret`.
* SRP authentication uses Proton’s SRP-6a variant with bcrypt cost 10 and `PMHash` (SHA-512 iterated) over the signed modulus.
* PIN protection (separate from OpenPGP) uses Argon2 with memory 19 MiB, 2 iterations, parallelism 1 (`crypto-pin-hash/src/argon2.rs`).

### 2.4 Private-key storage at rest

* Private keys are stored **armored on Proton’s servers** (`UserKey.private_key`, `AddressKey.private_key`) and returned by the API.
* Locally they are cached locked in SQLite (`users.keys`, `addresses.keys`) via `mail-stash`.
* The derived `KeySecret` is encrypted with AES-256-GCM under a random per-session `SessionEncryptionKey` and stored in `core_sessions.key_secret` as `EncryptedKeySecret`.
* The `SessionEncryptionKey` lives in the OS keychain (`core-common/src/os/keychain.rs`; `mail-tui` uses the `keyring` crate).
* Access/refresh tokens are encrypted with the same session key (`core-common/src/db/account/types.rs`).

### 2.5 Public-key management and trust

* `core-key-manager` loads locked keys, unlocks them with the `KeySecret`, and caches unlocked keys in memory (10 min for user keys, 5 min for address keys).
* Public keys for recipients are fetched from Proton’s `/core/v4/keys/all` endpoint (`account-api/src/protocol/proton.rs`, `core-common/src/user_context/services/crypto_key_service.rs`), with a 1-hour local cache.
* Responses contain `address_keys`, `catch_all_keys`, `unverified_keys` (which may include WKD-sourced keys), and `proton_mx` / `is_proton` flags.
* Contact pinned keys are extracted from signed vCards (`crypto-contact-keys/src/vcard_crypto.rs`) and override API keys for signature verification.
* `crypto-inbox/src/keys/verification.rs` builds `InboxVerificationPreferences`:
  * **Pinned keys are preferred** whenever the pinned-key list is non-empty; otherwise API keys are used.
  * Keys flagged `is_compromised` are filtered out.
  * Pinned/vCard keys whose fingerprints match compromised API keys are also excluded.
* There is no full OpenPGP web-of-trust; trust is TOFU-like via pinned contact keys plus server-mediated key transparency (`KTVerificationResult`).

### 2.6 Encryption, decryption, signing, verification

* `crypto-inbox/src/message/encrypt.rs`, `decrypt.rs`, `verify.rs`, `packages.rs` handle message crypto.
* `mail-package-builder/src/packages.rs` generates one encrypted body per needed MIME type (HTML, text, multipart), signs with the sender primary address key, and re-encrypts the session key per recipient.
* `crypto-inbox/src/keys/session_key.rs` wraps session keys and creates per-recipient key packets.
* Attachments use a fresh session key per attachment, detached signature over plaintext, and encrypted detached signature (`crypto-inbox/src/attachment/encrypt.rs`, `decrypt.rs`).
* External-recipient (EO) messages encrypt the session key to a password (`SKESK`) and generate an SRP challenge (`crypto-inbox/src/eo.rs`).

### 2.7 MIME handling

* `crypto-inbox-mime/src/read.rs` parses decrypted MIME bodies with `mail_parser`, extracts body/attachments/encrypted subject/`multipart/signed` signatures.
* `crypto-inbox-mime/src/write.rs` builds outgoing MIME via `mail_builder`.
* `SendPreferences` distinguishes `PgpMime`, `PgpInline`, and `ClearMime`, but the code currently forces PGP/MIME: “inline pgp is not supported currently.”

### 2.8 Key discovery

* **Primary mechanism:** Proton `/core/v4/keys/all` endpoint.
* **WKD:** `APIPublicKeySource::WKD` exists and WKD-sourced keys appear in the `Unverified` group, but there is no local WKD resolver.
* **Keyservers / KS:** not implemented.
* **Autocrypt key gossip:** not implemented in the Rust SDK.
* **Contact pinned keys:** implemented via signed vCards.

### 2.9 Smartcards and forward secrecy

* No smartcard/YubiKey/OpenPGP-card support was found in the local Rust tree.
* No forward secrecy: each message uses a fresh symmetric session key, but that key is encrypted to long-term OpenPGP user/address keys.

---

## 3. Mozilla Thunderbird desktop

### 3.1 Overall architecture

Thunderbird’s OpenPGP support is an in-tree extension derived from the legacy Enigmail add-on, living under `mail/extensions/openpgp/`. It has three layers:

1. **C++/libmime layer** — `mailnews/mime/cthandlers/pgpmime/nsPgpMimeProxy.cpp/.h` bridges libmime with JS stream listeners.
2. **JavaScript XPCOM/stream-handler layer** — `PgpMimeHandler.sys.mjs`, `mimeDecrypt.sys.mjs`, `mimeVerify.sys.mjs`, `mimeEncrypt.sys.mjs`.
3. **Crypto backend layer** — RNP (default) loaded via `ctypes` from the vendored tree at `third_party/rnp`; optional external GnuPG via `GPGME.sys.mjs`.

Core orchestration files:

| File | Role |
|---|---|
| `mail/extensions/openpgp/BondOpenPGP.sys.mjs` | Public entry point; initializes key cache, verifier, RNP, optional GPGME. |
| `mail/extensions/openpgp/content/modules/core.sys.mjs` | SQLite schema check, registers verifier/encrypt handler. |
| `mail/extensions/openpgp/content/modules/RNPLib.sys.mjs` | `ctypes` FFI to RNP, keyring load/save. |
| `mail/extensions/openpgp/content/modules/RNP.sys.mjs` | High-level JS API: key generation, encrypt/sign, decrypt/verify, revocation. |
| `mail/extensions/openpgp/content/modules/keyRing.sys.mjs` | In-memory key cache, recipient key selection, acceptance-state computation. |
| `mail/extensions/openpgp/content/modules/keyObj.sys.mjs` | `EnigmailKeyObj` and key-validity helpers. |
| `mail/extensions/openpgp/content/modules/sqliteDb.sys.mjs` | SQLite metadata store for key acceptance decisions. |
| `mail/extensions/openpgp/content/modules/masterpass.sys.mjs` | Automatic OpenPGP passphrase management. |
| `mail/extensions/openpgp/content/modules/CollectedKeysDB.sys.mjs` | IndexedDB cache for discovered public keys. |
| `mail/extensions/openpgp/content/modules/trust.sys.mjs` | GPG-compatible trust codes. |
| `mail/extensions/openpgp/content/modules/wkdLookup.sys.mjs` | Web Key Directory lookup. |
| `mail/extensions/openpgp/content/modules/keyserver.sys.mjs` | HKP/HKPS/VKS keyserver client. |
| `mail/extensions/openpgp/content/modules/GPGME.sys.mjs` / `GPGMELib.sys.mjs` | Optional external GnuPG wrapper. |
| `mail/extensions/openpgp/content/modules/mimeEncrypt.sys.mjs` | Outgoing PGP/MIME composer (`nsIMsgComposeSecure`). |
| `mail/extensions/openpgp/content/modules/mimeDecrypt.sys.mjs` | Incoming PGP/MIME decryptor. |
| `mail/extensions/openpgp/content/modules/mimeVerify.sys.mjs` | Detached signature verifier. |
| `mail/extensions/openpgp/content/ui/keyWizard.js` | Key generation/import UI. |
| `third_party/openpgp.configure` | RNP build configuration (Botan backend by default). |
| `third_party/rnp` | Vendored RNP sources. |

### 3.2 Key generation, passphrase derivation, and keyring storage

* Thunderbird **does not ask the user for an OpenPGP passphrase by default**. It generates a 32-byte random hex string (`masterpass.sys.mjs`), encrypts it with NSS Secret Decoder Ring (SDR), and stores it in `<profile>/encrypted-openpgp-passphrase.txt`.
* The SDR key is stored in the NSS database (`key4.db`), which is protected by the Thunderbird Primary Password if one is set.
* Secret keys live in classic binary OpenPGP keyrings:
  * `<profile>/secring.gpg`
  * `<profile>/pubring.gpg`
* `masterpass.sys.mjs` calls `RNPLib.protectUnprotectedKeys()` to ensure every secret key in `secring.gpg` is encrypted with the automatic passphrase.
* Users may instead enable `mail.openpgp.passphrases.enabled` and supply their own passphrase during key generation/import.
* ECC default: primary key EdDSA, subkey ECDH on Curve25519 (`RNP.sys.mjs`).
* Revocation certificates are written to `<profile>/<keyid>_rev.asc`.

### 3.3 Trust, signatures, revocation, validation

* In-memory key cache (`keyRing.sys.mjs`) indexed by key ID, fingerprint, and subkey ID.
* Acceptance metadata in `openpgp.sqlite` (`sqliteDb.sys.mjs`):
  * `acceptance_email(fpr, email)`
  * `acceptance_decision(fpr, decision)` — `undecided`, `unverified`, `verified`, `rejected`, `personal`.
* Readiness states: `accepted`, `expiredAccepted`, `undecided`, `rejected`, `collected`, `revoked`, etc.
* Validity helpers: `getSigningValidity()`, `getEncryptionValidity()`, `getKeyExpiry()`.
* Revocation via `rnp_key_revoke`; new revocation certificates via `unlockAndGetNewRevocation`.
* Alias rules: `OpenPGPAlias.sys.mjs` loads a JSON file pointed to by `mail.openpgp.alias_rules_file`.

### 3.4 Encryption, decryption, signing, verification

* `encryption.sys.mjs` translates send flags into RNP/GPGME parameters and calls `RNP.encryptAndOrSign()`.
* RNP operation (`RNP.sys.mjs`):
  * Prefers newest encryption-capable subkey.
  * Symmetric AES256, hash SHA256.
  * **Disables AEAD:** `rnp_op_encrypt_set_aead(op, "NONE")` for compatibility.
* Decryption (`RNP.sys.mjs` / `decryption.sys.mjs`):
  * Two-pass password callback to avoid nested event loops.
  * Validates MDC/integrity protection.
  * Falls back to `GPGME.decryptArray()` if RNP fails and external GnuPG is allowed.
  * Handles inline PGP blocks, public-key import from message bodies, nested signed messages.
* Verification:
  * PGP/MIME detached: `mimeVerify.sys.mjs` canonicalizes line endings to CRLF and calls `RNP.verifyDetached()`.
  * Inline signed: handled in `decryption.sys.mjs`.

### 3.5 MIME and Autocrypt

* Outgoing PGP/MIME: `mimeEncrypt.sys.mjs` implements `nsIMsgComposeSecure`, producing RFC 3156 structures:
  * `multipart/encrypted` with `application/pgp-encrypted` control part + `application/octet-stream` encrypted payload.
  * `multipart/signed` with `application/pgp-signature`.
* Supports protected headers (encrypting Subject), Autocrypt gossip headers.
* Incoming PGP/MIME: `PgpMimeHandler.sys.mjs` routes `multipart/encrypted` to `mimeDecrypt.sys.mjs` and `multipart/signed` to `mimeVerify.sys.mjs`.
* Inline PGP handled for reading and sending text.
* Autocrypt export uses `rnp_key_export_autocrypt`; gossip parsed from decrypted headers.

### 3.6 Key discovery

* **WKD:** `wkdLookup.sys.mjs` computes SHA1 of local part, z-base32 encodes it, fetches direct + advanced methods, pads requests to 512-byte multiples, and skips known public-webmail domains.
* **Keyservers:** `keyserver.sys.mjs` implements HKP/HKPS and VKS (e.g., `keys.openpgp.org`) via `XMLHttpRequest`; supports search, download, upload, refresh, confirmation-link handling.
* **LDAP:** recognized in URL parsing but not actually implemented.
* **Autocrypt:** discovered keys cached in IndexedDB `CollectedKeysDB`.
* **GnuPG keyring:** available when external GnuPG is enabled.

### 3.7 Smartcards and forward secrecy

* **No native smartcard support in RNP.**
* **Indirect support via external GnuPG/GPGME** when `mail.openpgp.allow_external_gnupg` is enabled; the key wizard has an “external key” flow that stores `is_gnupg_key_id` / `openpgp_key_id` on the identity.
* Only decryption and signing are supported via the GnuPG path; public-key ops stay in RNP.
* **No forward secrecy.** OpenPGP messages are encrypted to long-term recipient keys. AEAD is disabled for compatibility. Decrypted messages are stored locally in plaintext.

---

## 4. Standards and ecosystem context

| Standard | Status | Relevance |
|---|---|---|
| **RFC 9580** (2024) | Current OpenPGP Message Format; obsoletes RFC 4880, 5581, 6637. | Modern v6 keys, AEAD, SEIPDv2. Both Proton (via OpenPGP.js v6 / pmcrypto v8) and the ecosystem are moving toward it. |
| **RFC 3156** (2001) | Current Proposed Standard for PGP/MIME. | The normative container for encrypted/signed MIME mail. |
| **Autocrypt v2 draft** (active I-D) | Forward-secrecy extension with Ed25519 primary + ML-KEM-768+X25519 fallback + rotating subkey. | Provides a concrete ratchet (HKDF-SHA2-512, 10-day rotation default, ~20-day recovery window). Worth monitoring as an opt-in mode. |

Key UX/consent lessons from the 2024 OpenPGP Email Summit minutes:

* Proton enabled automatic `keys.openpgp.org` lookup, users complained (“why am I suddenly getting encrypted email?”), and Proton turned it off. **Conclusion:** key discovery must be explicit and consent-based.
* Thunderbird records key origins and **ignores Autocrypt encryption-preference headers** because they may not be DKIM-signed and can be spoofed.
* Thunderbird added bidirectional Autocrypt gossip support, but automatic mailing-list encryption remains cautious.

---

## 5. Design proposal for Kylins Client

### 5.1 Fit with existing Kylins architecture

Kylins is already well-shaped for OpenPGP:

* The **Rust backend** owns the SQLite database (`kylins.client.backend/src/db/`), MIME construction (`src/mail/builder.rs`), sync engine (`src/sync_engine/`), and secrets (`src/crypto.rs`).
* The **frontend** is a reactive view layer (`React 19 + Vite`) with existing security UI (`SecurityChips.tsx`, `ClassificationBanner.tsx`) and composer flags (`isEncrypted`, `isSigned`).
* IPC is through Tauri `invoke` and events; the frontend never touches the DB directly.
* The OS keyring already protects a 256-bit master key used for AES-256-GCM secret encryption.

**Therefore:** implement the OpenPGP engine as a **Rust service**, expose it through a small set of Tauri commands/events, and keep the frontend responsible only for UI state and user consent.

### 5.2 Component boundaries

```text
┌─────────────────────────────────────────────────────────────┐
│  React 19 frontend                                          │
│  - Composer encryption/sign toggles                         │
│  - ReadingPane security chips & decryption error UI         │
│  - SecurityPreferences key management                       │
│  - Contact public-key pinning                               │
└───────────────────────┬─────────────────────────────────────┘
│ invoke / events       │
├───────────────────────┘
│  Tauri v2 backend (Rust)
│  - openpgp_service: key generation, import, encrypt, sign,
│    decrypt, verify, key discovery orchestration
│  - key_store: SQLite public metadata + encrypted secret blobs
│  - crypto.rs: existing AES-256-GCM + OS-keyring master key
│  - mail/builder.rs: PGP/MIME outgoing wrapper
│  - sync_engine/commands.rs + mail/imap/client.rs: inbound
│    decryption/verification hook
└─────────────────────────────────────────────────────────────┘
```

Suggested new Rust modules/files:

```textnkylins.client.backend/src/openpgp/
├── mod.rs                 # public API / Tauri commands
├── engine.rs              # Sequoia/rPGP crypto operations
├── key_store.rs           # DB-backed keyring
├── key_unlock.rs          # passphrase / master-key unlocking
├── discovery.rs           # WKD, keyserver, Autocrypt orchestration
├── trust.rs               # acceptance / pinning / compromised filtering
├── mime_crypto.rs         # RFC 3156 PGP/MIME builder/parser helpers
├── smartcard.rs           # openpgp-card integration (optional)
└── autocrypt.rs           # Autocrypt header/gossip parsing (v1 + v2)
```

### 5.3 Recommended crates

| Layer | Primary crate | Alternative | Notes |
|---|---|---|---|
| **OpenPGP engine** | `sequoia-openpgp` | `rpgp` (a.k.a. `pgp`) | Sequoia is idiomatic Rust, targets RFC 9580, and is used by KeychainPGP (Tauri v2 precedent). rPGP is the engine Proton’s Rust SDK uses. |
| **MIME** | `mail-builder` (already used) + `mail-parser` | `mailparse` | Proton uses `mail_parser` and `mail_builder`; Kylins already uses `mail-builder` for outgoing MIME. |
| **WKD** | Custom + `sha-1`, `zbase32`, `reqwest` | — | RFC-compliant WKD is small; implement in Rust to keep secrets out of the renderer. |
| **Keyserver (HKP/VKS)** | `reqwest` + custom HKP parser | — | Keep keyserver traffic explicit and logged. |
| **Smartcard** | `openpgp-card` + `openpgp-card-sequoia` | `openpgp-card-rpgp` | Choose companion crate matching the selected engine. |
| **Crypto primitives** | `aes-gcm`, `hkdf`, `sha2`, `argon2` | — | Already used/available; reuse for wrapping passphrases/PINs. |
| **OS keyring** | `keyring` (already used) | — | Continue using the existing master-key storage. |

**Recommendation:** Start with **Sequoia-PGP** because it is RFC-9580-ready and has a proven Tauri v2 integration pattern (KeychainPGP). Retain an abstraction trait so `rpgP` can be swapped in later if needed (e.g., for `openpgp-card-rpgp` smartcard workflows).

### 5.4 Key storage strategy

Leverage Kylins’ existing security model:

1. **Master key** in OS keyring, cached in `crypto.rs` `Mutex<Option<[u8; 32]>>`.
2. **OpenPGP secret keys** stored as armored/encrypted blobs in a new `pgp_keys` table:
   ```sql
   CREATE TABLE pgp_keys (
     id INTEGER PRIMARY KEY,
     account_id INTEGER REFERENCES accounts(id) ON DELETE CASCADE,
     key_type TEXT NOT NULL CHECK(key_type IN ('private','public','subkey')),
     fingerprint TEXT NOT NULL UNIQUE,
     user_id TEXT,
     armored_data BLOB NOT NULL,        -- encrypted with AES-256-GCM master key
     created_at INTEGER NOT NULL,
     expires_at INTEGER,
     is_primary INTEGER DEFAULT 0,
     passphrase_protected INTEGER DEFAULT 0,
     origin TEXT                          -- 'generated','imported','wkd','keyserver','autocrypt','contact'
   );
   ```
3. **Public key metadata** in the same table (`key_type = 'public'`) or a separate `pgp_public_keys` table; include provenance and acceptance state.
4. **Per-account defaults** in a new `account_pgp_settings` table or `accounts` columns:
   ```sql
   ALTER TABLE accounts ADD COLUMN pgp_sign_by_default INTEGER DEFAULT 0;
   ALTER TABLE accounts ADD COLUMN pgp_encrypt_by_default INTEGER DEFAULT 0;
   ALTER TABLE accounts ADD COLUMN pgp_prefer_openpgp INTEGER DEFAULT 1;
   ```
5. **Contact pinned keys** attach to the existing contacts table (`contacts.pgp_fingerprint`, `contacts.pgp_armored_key`).

Unlocking:

* For Kylins-generated keys, the armored secret-key blob is encrypted with the master key; no per-key passphrase is needed at runtime unless the user opts in.
* For imported passphrase-protected keys, prompt once, decrypt to a memory-only unlocked key, and optionally re-encrypt under the master key.
* Cache unlocked keys in Rust memory with a TTL (e.g., 10 minutes, mirroring Proton) and an explicit lock command.

### 5.5 Key generation and defaults

* Default to **Ed25519 primary key + X25519 encryption subkey** (modern, compact, RFC 9580 friendly).
* Allow RSA 4096 as a compatibility option.
* Key expiration: recommend 2–3 years, renewable.
* Generate revocation certificate at creation time and store it encrypted alongside the key.
* User ID format: `Display Name <email@example.com>` per account address.

### 5.6 Outbound flow (signing/encrypting)

Hook into the existing send path:

1. Composer sets `isEncrypted` / `isSigned` (already in `composerStore.ts` and `SendDraft`).
2. `buildSendDraft.ts` passes the flags to the Rust `send` mutation.
3. In `kylins.client.backend/src/mail/builder.rs` (`build_mime`):
   * If signing: build canonical MIME body, sign with sender private key, wrap in `multipart/signed`.
   * If encrypting: resolve recipient public keys (see §5.8); if any recipient lacks a key, warn/fail according to policy. Encrypt the MIME body to all recipients + sender, wrap in `multipart/encrypted`.
   * If both: **sign then encrypt** (encrypt the `multipart/signed` package). This is the PGP/MIME convention and avoids the “encrypt-then-sign” ambiguity.
4. Attachments are included inside the encrypted MIME package; do not leak filenames in the outer structure.

### 5.7 Inbound flow (decryption/verification)

Hook into the sync/body-fetch path:

1. In `kylins.client.backend/src/sync_engine/commands.rs` (`request_bodies_inner`) or `mail/imap/client.rs` body fetch paths, after raw bytes are fetched:
   * Detect `multipart/encrypted` → decrypt with account private key(s).
   * Detect `multipart/signed` → verify detached signature.
   * Handle inline PGP blocks in a compatibility pass.
2. Store **decrypted canonical MIME** in `message_bodies`.
3. Set `messages.is_encrypted` / `messages.is_signed` (columns already exist).
4. Generate snippet from decrypted plaintext so message-list previews are readable.
5. Cache discovered sender public keys/Autocrypt headers for trust decisions, but **do not auto-encrypt to them without explicit user action**.

### 5.8 Key discovery and trust UX

| Source | Behavior |
|---|---|
| **Local keyring** | Always checked first. |
| **Contact pinned keys** | Highest trust for verification; used for encryption if available and accepted. |
| **WKD** | Manual or semi-automatic with explicit consent per domain. |
| **Keyservers (`keys.openpgp.org`)** | Explicit lookup only; require user confirmation before encryption. |
| **Autocrypt headers/gossip** | Parsed and stored as “discovered” with provenance; **ignore `prefer-encrypt=mutual` for automatic encryption** (DKIM-spoofing risk, per Thunderbird). Use only to populate keys for manual/user-confirmed encryption. |
| **Import from file/clipboard** | Allowed with fingerprint display and trust prompt. |

Trust states for signatures:

* **Unknown** — no key found.
* **Unverified** — key found but not yet accepted.
* **Verified** — fingerprint manually checked or pinned.
* **Trusted** — contact-pinned key matches.
* **Compromised / rejected** — explicit rejection or known compromise.

UI requirements:

* Composer shows per-recipient key availability: green lock (accepted key), yellow lock (discovered key), red/no lock (missing key).
* Reading pane uses existing `SecurityChips` and adds signature trust details and decryption error banners.
* SecurityPreferences gets sections: My Keys, Trusted Contacts, Key Discovery, Advanced (Autocrypt v2 experimental).

### 5.9 Smartcard support

* Phase 1: software keys only.
* Phase 2: integrate `openpgp-card` with the chosen engine companion crate (`openpgp-card-sequoia` or `openpgp-card-rpgp`).
* UX: detect inserted OpenPGP card, allow importing the public key, mark operations as “smartcard-backed,” and delegate signing/decryption to the card via PC/SC.
* This matches Thunderbird’s model but keeps the implementation native Rust instead of shelling out to GnuPG.

### 5.10 Forward secrecy

* Standard OpenPGP mode: **no forward secrecy**. Document this clearly.
* **Autocrypt v2 ratchet** (ML-KEM-768+X25519 rotating subkeys, 10-day default rotation, HKDF-SHA2-512) can be offered as an **opt-in experimental mode** once the draft stabilizes and the chosen engine supports v6 packets. Store ratchet state in Rust, schedule rotation there, and expose status to the frontend via events.

### 5.11 Migration and interop path

1. **Database migration** (`kylins.client.backend/migrations/`):
   * Add `pgp_keys`, `account_pgp_settings`, and `contacts.pgp_*` columns.
   * Existing `messages.is_encrypted` / `is_signed` columns remain; backfill during first sync after upgrade.
2. **Key import:**
   * Support armored private/public key files (`.asc`).
   * Import from Thunderbird: import `pubring.gpg`/`secring.gpg` or a GnuPG home directory.
   * Import from Proton: export armored keys from Proton settings and import; Kylins cannot reuse Proton’s passphrase-derived `KeySecret` directly.
3. **Key export:** armored public/private keys, revocation certificates, and (later) WKD publication helper.
4. **Interoperability target:** RFC 3156 PGP/MIME + RFC 9580 v6/v4 key parsing. Start with v4 keys for broad compatibility, generate v6-capable keys where the engine allows.

---

## 6. Implementation roadmap (suggested)

| Phase | Work | Files / areas |
|---|---|---|
| **P0** | Add backend OpenPGP crate & keyring schema. | `Cargo.toml`, `migrations/`, `src/openpgp/`, `src/db/`. |
| **P0** | Key generation / import / export Tauri commands. | `src/openpgp/mod.rs`, `src/commands.rs`. |
| **P0** | Encrypt/decrypt/sign/verify core engine. | `src/openpgp/engine.rs`. |
| **P1** | Outbound PGP/MIME wrapper in `builder.rs`. | `src/mail/builder.rs`, `src/openpgp/mime_crypto.rs`. |
| **P1** | Inbound decryption/verification hook in sync/imap path. | `src/sync_engine/commands.rs`, `src/mail/imap/client.rs`. |
| **P1** | Frontend composer toggles & reading-pane security UI. | `Composer.tsx`, `ReadingPane.tsx`, `SecurityChips.tsx`. |
| **P2** | WKD + keyserver lookup with explicit consent. | `src/openpgp/discovery.rs`. |
| **P2** | Contact pinning & trust preferences. | `contacts.ts`, `SecurityPreferences.tsx`. |
| **P3** | Autocrypt header/gossip parsing. | `src/openpgp/autocrypt.rs`. |
| **P3** | Smartcard integration (`openpgp-card`). | `src/openpgp/smartcard.rs`. |
| **P4** | Autocrypt v2 ratchet (experimental). | `src/openpgp/autocrypt.rs`, ratchet state store. |

---

## 7. Risks and caveats

* **RFC 9580 readiness:** Verify the exact Sequoia/rPGP version at implementation time; v6 key and AEAD support is still stabilizing across engines.
* **Deprecation of `pmcrypto`:** Proton’s standalone `pmcrypto` repo is archived; Proton web clients now embed the code in WebPackages. The Rust SDK is the more stable reference for native clients.
* **Proton `rustpgp` is experimental:** The local `Cargo.toml` comments describe the `rustpgp` feature as “experimental,” and `gopenpgp-sys` is still linked. Do not assume Proton has fully replaced Go with Rust.
* **Smartcard maturity:** `openpgp-card` is the right abstraction, but real-world YubiKey workflows require testing across platforms.
* **Autocrypt v2 is a draft:** Ratchet details may change; treat as experimental.
* **Forward secrecy:** Standard OpenPGP email cannot provide it. If forward secrecy is a hard requirement, consider a parallel channel (e.g., Signal protocol) rather than bolting it onto OpenPGP.

---

## 8. Sources and references

### Web / standards sources

* RNP repository — “high performance C++ OpenPGP library used by Mozilla Thunderbird.” https://github.com/rnpgp/rnp
* Thunderbird Blog — “OpenPGP in Thunderbird 78.” https://blog.thunderbird.net/2020/09/openpgp-in-thunderbird-78/
* Mozilla Wiki — Thunderbird OpenPGP Smartcards. https://wiki.mozilla.org/Thunderbird:OpenPGP:Smartcards
* OpenPGP.js / pmcrypto — RFC 9580 support notes. https://github.com/ProtonMail/pmcrypto, https://github.com/openpgpjs/openpgpjs/releases/tag/v6.0.0
* RFC 9580 (current OpenPGP Message Format). https://www.rfc-editor.org/info/rfc9580
* RFC 3156 (MIME Security with OpenPGP). https://www.rfc-editor.org/info/rfc3156
* Autocrypt v2 certificate draft. https://datatracker.ietf.org/doc/draft-autocrypt-openpgp-v2-cert/
* 2024 OpenPGP Email Summit minutes (key discovery consent, Thunderbird provenance, Proton keys.openpgp.org disablement). https://www.openpgp.org/community/email-summit/2024/minutes/
* KeychainPGP — Tauri v2 + Sequoia-PGP precedent. https://github.com/KeychainPGP/keychainpgp
* openpgp-card project. https://codeberg.org/openpgp-card/openpgp-card
* openpgp-card-rpgp companion crate. https://codeberg.org/openpgp-card/rpgp
* Zellic Research — Proton SRP bcrypt password-hardening details. https://www.zellic.io/blog/proton-dart-flutter-csprng-prng

### Local source references

#### Proton clients (`D:\Projects\mailclient\opensource\Proton\clients`)

* Key setup: `account-api/src/login/state/mod.rs`, `core-key/src/keys/new_user_key.rs`, `core-key/src/keys/new_addr_key.rs`
* Storage: `core-common/src/db/account/types.rs`, `core-common/src/auth_store.rs`, `core-common/src/os/keychain.rs`, `mail-tui/src/keychain.rs`, `mail-uniffi/src/core/keychain.rs`
* Key manager: `core-key-manager/src/manager.rs`, `core-key-manager/src/cache.rs`
* Crypto: `crypto-inbox/src/message/encrypt.rs`, `decrypt.rs`, `verify.rs`, `packages.rs`; `crypto-inbox/src/keys/verification.rs`, `session_key.rs`, `encryption.rs`
* Attachments: `crypto-inbox/src/attachment/encrypt.rs`, `decrypt.rs`
* MIME: `crypto-inbox-mime/src/read.rs`, `write.rs`
* Package builder: `mail-package-builder/src/packages.rs`
* Key service: `core-common/src/user_context/services/crypto_key_service.rs`
* Contact keys: `crypto-contact-keys/src/vcard_crypto.rs`
* PIN hash: `crypto-pin-hash/src/argon2.rs`, `core-common/src/pin_code.rs`

#### Thunderbird desktop (`D:\Projects\mailclient\opensource\thunderbird-desktop`)

* Entry/loader: `mail/extensions/openpgp/BondOpenPGP.sys.mjs`, `mail/extensions/openpgp/content/modules/core.sys.mjs`
* RNP FFI & API: `mail/extensions/openpgp/content/modules/RNPLib.sys.mjs`, `mail/extensions/openpgp/content/modules/RNP.sys.mjs`
* Passphrase: `mail/extensions/openpgp/content/modules/masterpass.sys.mjs`
* Key cache/trust: `mail/extensions/openpgp/content/modules/keyRing.sys.mjs`, `keyObj.sys.mjs`, `sqliteDb.sys.mjs`, `trust.sys.mjs`
* Discovery: `mail/extensions/openpgp/content/modules/wkdLookup.sys.mjs`, `keyserver.sys.mjs`, `CollectedKeysDB.sys.mjs`
* GnuPG fallback: `mail/extensions/openpgp/content/modules/GPGME.sys.mjs`, `GPGMELib.sys.mjs`
* MIME: `mail/extensions/openpgp/content/modules/mimeEncrypt.sys.mjs`, `mimeDecrypt.sys.mjs`, `mimeVerify.sys.mjs`, `PgpMimeHandler.sys.mjs`
* C++ bridge: `mailnews/mime/cthandlers/pgpmime/nsPgpMimeProxy.cpp/.h`
* UI: `mail/extensions/openpgp/content/ui/keyWizard.js`, `enigmailMsgComposeOverlay.js`, `enigmailMsgHdrViewOverlay.js`
* RNP sources: `third_party/rnp`, `third_party/openpgp.configure`

#### Kylins Client (`D:\Projects\mailclient\kylins`)

* Backend entry: `kylins.client.backend/src/lib.rs`
* Commands/crypto: `kylins.client.backend/src/commands.rs`, `src/crypto.rs`
* DB/migrations: `kylins.client.backend/src/db/mod.rs`, `migrations/`
* MIME builder: `kylins.client.backend/src/mail/builder.rs`
* Sync engine: `kylins.client.backend/src/sync_engine/engine.rs`, `src/sync_engine/commands.rs`
* IMAP body fetch: `kylins.client.backend/src/mail/imap/client.rs`
* Frontend crypto service: `kylins.client.frontend/src/services/crypto.ts`
* Composer/send: `kylins.client.frontend/src/services/composer/buildSendDraft.ts`, `src/services/composer/send.ts`, `src/components/composer/Composer.tsx`
* Reading pane / security UI: `kylins.client.frontend/src/components/layout/ReadingPane.tsx`, `src/features/classification/components/SecurityChips.tsx`, `src/components/email/EmailRenderer.tsx`
* Plugin injection: `kylins.client.frontend/src/components/plugins/InjectedComponentSet.tsx`, `src/services/plugins/pluginManager.ts`, `src/services/plugins/pluginAPI.ts`
* Preferences: `kylins.client.frontend/src/components/preferences/SecurityPreferences.tsx`, `src/stores/preferencesStore.ts`
* Contacts: `kylins.client.frontend/src/services/db/contacts.ts`

---

*Report generated by the deep-research workflow (104 agents, 22 web sources fetched, 25 claims adversarially verified: 20 confirmed, 5 refuted) combined with read-only sweeps of the three local repositories.*
