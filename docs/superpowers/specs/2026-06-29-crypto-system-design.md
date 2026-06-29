# Crypto System Design: Modular Email Encryption/Decryption/Signing

## Context

Kylins Mail needs end-to-end email encryption supporting multiple standards:
- **S/MIME** with PKCS#11 hardware token support (Phase 1)
- **PGP** (Phase 2)
- **SM2/SM3/SM4** Chinese national crypto (Phase 3)

The system must be modular with a unified abstraction layer so users can switch encryption methods per account, and backends are pluggable/extensible.

## Architecture: Trait-based Provider Abstraction

Follows Proton's `PGPProviderSync` pattern. Each encryption standard implements a common `CryptoProvider` trait. The provider is selected per-account at runtime.

### Module Layout

```
kylins.client.backend/src/crypto/
├── mod.rs              // Re-exports, provider registry, factory
├── provider.rs         // CryptoProvider trait + associated types
├── encryptor.rs        // Encryptor builder trait
├── decryptor.rs        // Decryptor builder trait
├── signer.rs           // Signer builder trait
├── verifier.rs         // Verifier builder trait
├── types.rs            // Shared types (KeyId, Algorithm, SignResult, etc.)
├── key_store.rs        // KeyStore trait (find keys, import, delete)
├── smime/
│   ├── mod.rs          // SmimeProvider + CMS construction
│   ├── encryptor.rs    // EnvelopedData builder
│   ├── decryptor.rs    // EnvelopedData parser + decrypt
│   ├── signer.rs       // SignedData builder
│   ├── verifier.rs     // SignedData parser + verify
│   ├── cert_store.rs   // X.509 certificate store
│   └── pkcs11/
│       ├── mod.rs      // Pkcs11Token, session lifecycle
│       ├── cert_cache.rs
│       └── operations.rs // raw RSA sign/decrypt via rust-cryptoki
├── pgp/                // Phase 2
│   ├── mod.rs
│   ├── encryptor.rs
│   ├── decryptor.rs
│   ├── signer.rs
│   ├── verifier.rs
│   ├── key_store.rs
│   └── key_manager.rs
└── sm/                 // Phase 3
    ├── mod.rs
    ├── encryptor.rs
    ├── decryptor.rs
    ├── signer.rs
    ├── verifier.rs
    └── cert_store.rs
```

### Core Trait

```rust
pub trait CryptoProvider: Send + Sync {
    type Key: CryptoKey;
    type SessionKey: SessionKey;

    fn name(&self) -> &'static str;
    fn new_signer(&self, key: &Self::Key) -> Self::Signer;
    fn new_verifier(&self) -> Self::Verifier;
    fn new_encryptor(&self, recipients: &[Recipient]) -> Self::Encryptor;
    fn new_decryptor(&self, key: &Self::Key) -> Self::Decryptor;
    fn generate_session_key(&self, algo: SymmetricAlgorithm) -> Result<Self::SessionKey>;
    fn key_store(&self) -> &dyn KeyStore<Key = Self::Key>;
}
```

### Builder Traits

```rust
pub trait Signer: Sized {
    type Output;
    fn with_detached(self, detached: bool) -> Self;
    fn sign(self, content: &[u8]) -> Result<Self::Output>;
    // + streaming variant for large files:
    fn sign_file(self, input_path: &Path, output_path: &Path) -> Result<()>;
}

pub trait Verifier: Sized {
    fn with_detached_data(self, data: &[u8]) -> Self;
    fn verify(self, signed_content: &[u8]) -> Result<VerificationResult>;
    fn verify_file(self, input_path: &Path) -> Result<VerificationResult>;
}

pub trait Encryptor: Sized {
    type Output;
    fn with_session_key(self, key: &impl SessionKey) -> Self;
    fn encrypt(self, content: &[u8]) -> Result<Self::Output>;
    fn encrypt_file(self, input_path: &Path, output_path: &Path) -> Result<()>;
}

pub trait Decryptor: Sized {
    type Output;
    fn decrypt(self, encrypted: &[u8]) -> Result<DecryptResult>;
    fn decrypt_file(self, input_path: &Path, output_path: &Path) -> Result<DecryptResult>;
}
```

### Key Types

```rust
pub trait CryptoKey: Send + Sync {
    fn key_id(&self) -> KeyId;
    fn fingerprint(&self) -> Vec<u8>;
    fn can_sign(&self) -> bool;
    fn can_encrypt(&self) -> bool;
}

pub trait SessionKey: Send + Sync {
    fn algorithm(&self) -> SymmetricAlgorithm;
    fn raw_bytes(&self) -> &[u8];
}
```

## S/MIME + PKCS#11 (Phase 1)

### Design Principle (from CMMP.CryptoKit)

**The PKCS#11 token ONLY does raw RSA.** CMS/PKCS#7 framing is pure Rust (RustCrypto `cms` crate). The token never sees email content — only 32-byte DigestInfo (signing) or 256-byte encrypted CEK (decryption).

### PKCS#11 Integration

Wrapper around `rust-cryptoki`:

```rust
pub struct Pkcs11Token {
    pkcs11: Arc<Pkcs11>,
    slot: Slot,
    session_timeout: Duration,
}

impl Pkcs11Token {
    pub fn open(lib_path: &str, pin: &AuthPin) -> Result<Self>;
    pub fn find_certs(&self) -> Result<Vec<CertInfo>>;
    pub fn find_key_by_cert(&self, cert_serial: &[u8]) -> Result<Option<ObjectHandle>>;
    pub fn sign_rsa_pkcs(&self, key: ObjectHandle, digest_info: &[u8]) -> Result<Vec<u8>>;
    pub fn decrypt_rsa_pkcs(&self, key: ObjectHandle, encrypted_cek: &[u8]) -> Result<Vec<u8>>;
}
```

Uses `secrecy` crate for PIN zeroization. Session timeout with auto-reconnect pattern from CMMP.CryptoKit.

### Sign Flow (Streaming)

```
1. Open input MIME file, read in 64KB chunks
2. sha2::Sha256::update(chunk) for each chunk
3. finalize() → 32-byte hash
4. Build CMS SignedAttributes { contentType, messageDigest, signingTime }
5. DER-encode SignedAttributes, SHA-256 hash them
6. Build DigestInfo (hash OID + hash) = ~51 bytes
7. Pkcs11Token::sign_rsa_pkcs(key_handle, &digest_info) → RSA signature on token
8. Build SignerInfo { sid, digest_alg, signed_attrs, signature_alg, signature }
9. RustCrypto cms::SignedDataBuilder → add certificate, add signer_info
10. Write DER output to output_path
```

### Encrypt Flow (Streaming)

```
1. Generate random 256-bit AES session key
2. Open input MIME file
3. For each recipient: extract RSA public key from X.509 cert
4. For each recipient: rsa::encrypt(recipient_pubkey, &session_key) → encrypted CEK
5. Construct RecipientInfos with KeyTransRecipientInfo per recipient
6. Stream content: read input in 64KB chunks → aes-256-cbc encrypt → write output
7. Build EnvelopedData with EncryptedContentInfo { alg: AES-256-CBC, content: output_path }
8. Write DER output
```

### Decrypt Flow

```
1. Parse CMS EnvelopedData (RustCrypto cms::ContentInfo::from_der)
2. Extract recipient infos, find one matching our cert (by IssuerAndSerialNumber)
3. Extract encrypted CEK for our recipient
4. Pkcs11Token::decrypt_rsa_pkcs(key_handle, &encrypted_cek) → decrypted CEK
5. aes-256-cbc decrypt the encrypted content using decrypted CEK
6. Return raw MIME bytes
```

### Verify Flow

```
1. Parse CMS SignedData
2. Extract signer cert from CertificateSet (or use provided cert)
3. Verify X.509 cert chain (x509-cert crate, optional: OS trust store)
4. Extract messageDigest from signer's SignedAttributes
5. Re-compute hash of detached content (or eContent)
6. Compare digests → match?
7. Extract signature from SignerInfo.signature
8. rsa::verify(signer_pubkey, &digest_info, &signature) → boolean
9. Return VerificationResult { valid, signer_cert, digest_algorithm }
```

### MIME Wrapping

After crypto, the signed/encrypted CMS DER bytes are MIME-wrapped for email transport:

- **Signed-only**: `multipart/signed; protocol="application/pkcs7-signature"; micalg=sha-256`
  - Part 1: original content
  - Part 2: `application/pkcs7-signature` (detached CMS signature)
- **Encrypted**: `application/pkcs7-mime; smime-type=enveloped-data`
  - Body: CMS EnvelopedData DER (base64)
- **Signed+Encrypted**: Encrypt the entire signed MIME message → `application/pkcs7-mime`

### Dual Key Source

S/MIME keys can come from two sources, unified in `SmimeKeyStore`:

1. **PKCS#11 token** (hardware) — private key ops on token, certs read from token
2. **Soft certificates** (software) — PKCS#12/PEM files imported into local cert store. Uses `rsa` crate for key ops.

Both implement the same `CryptoKey` trait. The store searches token first, then soft store.

## PGP Backend (Phase 2)

### Approach

Uses `rpgp` crate (RustCrypto ecosystem, pure Rust). Implements the same `CryptoProvider` trait — zero code changes to the abstraction layer.

### Key Differences from S/MIME

| Aspect | S/MIME | PGP |
|--------|--------|-----|
| Key format | X.509 certificates | OpenPGP key pairs |
| Trust model | PKI (CA hierarchy) | Web of Trust + pinned keys |
| MIME | application/pkcs7-* | multipart/encrypted + application/pgp-encrypted |
| Key discovery | Directory + token | WKD + keyservers + contact pinned keys |
| Sign+Encrypt | Sign first, then encrypt | Same (sign-then-encrypt) |

### Key Management

Follows Proton's contact-pinned-key model:
- User has PGP keyrings (public + private)
- Per-contact keys can be pinned from received signed emails
- `PgpKeyStore` wraps keyring file I/O + WKD lookup

## SM2/SM3/SM4 Backend (Phase 3)

### Approach

Uses `libsm` crate. Chinese national standards mapped to the same CMS structures as S/MIME, just with different OIDs and algorithms:

| Role | International | Chinese | OID |
|------|--------------|---------|-----|
| Signature | RSA + SHA-256 | SM2 + SM3 | 1.2.156.10197.1.501 |
| Key exchange | RSA / ECDH | SM2 | 1.2.156.10197.1.301 |
| Hash | SHA-256 | SM3 | 1.2.156.10197.1.401 |
| Symmetric | AES-256-CBC | SM4-CBC | 1.2.156.10197.1.104 |

### Implementation Notes

- Extend RustCrypto `cms` crate's `ContentEncryptionAlgorithm` with `Sm4Cbc`
- SM2 key pairs use the `libsm::sm2` API (sign/verify/encrypt/decrypt)
- SM3 hash via `libsm::sm3`
- SM4-CBC via `libsm::sm4`
- Same `CryptoProvider` trait, same CMS structures, different OIDs

## Tauri Commands (Frontend Bridge)

File paths, not byte arrays (for large email support):

```rust
// kylins.client.backend/src/commands/crypto_commands.rs

#[tauri::command]
async fn crypto_sign(
    state: State<'_, AppState>,
    account_id: String,
    input_mime_path: String,       // raw MIME to sign
    output_path: String,           // where to write signed result
    detached: bool,                // detached (multipart/signed) or opaque
) -> Result<(), String>;

#[tauri::command]
async fn crypto_encrypt(
    state: State<'_, AppState>,
    account_id: String,
    input_path: String,            // raw MIME to encrypt
    output_path: String,           // where to write CMS EnvelopedData
    recipients: Vec<String>,       // email addresses
) -> Result<(), String>;

#[tauri::command]
async fn crypto_decrypt(
    state: State<'_, AppState>,
    account_id: String,
    input_path: String,            // encrypted MIME file
    output_path: String,           // where to write decrypted MIME
) -> Result<DecryptResult, String>;

#[tauri::command]
async fn crypto_verify(
    state: State<'_, AppState>,
    account_id: String,
    signed_path: String,           // signed MIME
    detached_data_path: Option<String>,  // for multipart/signed
) -> Result<VerificationResult, String>;
```

Commands resolve the provider from account settings: `settings.get("crypto.method")` → `"smime"`.

## Frontend Integration

### New Service

`kylins.client.frontend/src/services/crypto/mailCrypto.ts`:

```typescript
export async function signEmail(accountId: string, mimePath: string, outputPath: string): Promise<void>
export async function encryptEmail(accountId: string, inputPath: string, outputPath: string, recipients: string[]): Promise<void>
export async function decryptEmail(accountId: string, inputPath: string, outputPath: string): Promise<DecryptResult>
export async function verifyEmail(accountId: string, signedPath: string, detachedDataPath?: string): Promise<VerificationResult>
```

### Send Pipeline Integration

Modify `composer/send.ts` — insert after `buildRawEmail()` but before enqueuing:

```
buildRawEmail() → write to temp file →
  signEmail(tempFile, signedFile) →
  encryptEmail(signedFile, encryptedFile) [if encryption enabled] →
  read encryptedFile → base64url encode → enqueue send mutation
```

### Receive Pipeline Integration

In `ReadingPane` or message display — when loading a message:

```
fetch raw MIME from server/DB → write to temp file →
  decryptEmail(encFile, decFile) [if encrypted] →
  verifyEmail(decFile) [if signed] →
  read decFile → render MIME in SafeHtmlFrame
```

### Settings

New settings keys in `settingsKeys.ts`:

```typescript
crypto_method: 'crypto.method',                    // 'none' | 'smime' | 'pgp' | 'sm'
crypto_smime_pkcs11_lib: 'crypto.smime.pkcs11_lib', // path to PKCS#11 .so/.dll
crypto_smime_default_sign_cert: 'crypto.smime.default_sign_cert',
crypto_smime_default_encrypt_cert: 'crypto.smime.default_encrypt_cert',
crypto_pgp_keyring_path: 'crypto.pgp.keyring_path',
```

Preferences UI under `GeneralPreferences` or a new `SecurityPreferences` tab.

## Dependencies

### Phase 1 (S/MIME)
- `cms` (RustCrypto) — CMS/PKCS#7 structure building/parsing
- `cryptoki` (rust-cryptoki) — PKCS#11 token operations
- `rsa` (RustCrypto) — Software RSA operations
- `sha2` (RustCrypto) — SHA-256 hashing
- `aes` / `cbc` (RustCrypto) — AES-256-CBC content encryption
- `x509-cert` (RustCrypto) — X.509 certificate parsing
- `der` (RustCrypto) — DER encoding
- `secrecy` — Zeroizing PIN/password storage
- `tempfile` — Temporary file management

### Phase 2 (PGP)
- `rpgp` — Pure Rust OpenPGP implementation

### Phase 3 (SM)
- `libsm` — SM2/SM3/SM4 Chinese national crypto

## Verification

1. **Unit tests**: Each backend's sign/encrypt round-trip: sign→verify, encrypt→decrypt with in-memory keys
2. **PKCS#11 tests**: Mock PKCS#11 token (rust-cryptoki has mock support) for CI; real token test gated behind `#[cfg(feature = "pkcs11-tests")]`
3. **Integration test**: Full flow — compose MIME → sign → encrypt → decrypt → verify → compare with original
4. **Large file test**: 200MB file sign/encrypt/decrypt/verify, verify memory stays under 100MB
5. **Frontend**: Vitest tests for `mailCrypto.ts` with mocked `invoke()`
