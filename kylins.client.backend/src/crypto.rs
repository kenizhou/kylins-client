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
        // expose_secret() -> &Box<[u8;32]>; deref-coerces to &[u8;32].
        self.guard
            .as_ref()
            .expect("key initialized before use")
            .expose_secret()
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

    let combined =
        hex::decode(ciphertext_hex).map_err(|e| CryptoVaultError::Decode(e.to_string()))?;
    if combined.len() < NONCE_LEN + 16 {
        return Err(CryptoVaultError::CiphertextTooShort);
    }
    let (nonce_bytes, ciphertext) = combined.split_at(NONCE_LEN);
    let nonce = Nonce::from_slice(nonce_bytes);

    cipher
        .decrypt(nonce, ciphertext)
        .map_err(|e| CryptoVaultError::Aead(e.to_string()))
}

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
        .encrypt(
            nonce,
            Payload {
                msg: plaintext,
                aad: &payload_aad,
            },
        )
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
        .decrypt(
            nonce,
            Payload {
                msg: ciphertext,
                aad: &payload_aad,
            },
        )
        .map_err(|e| CryptoVaultError::Aead(e.to_string()))
}

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
        assert_ne!(
            bytes[0], VAULT_VERSION_V1,
            "legacy blob must not carry the v1 version byte"
        );
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

    #[test]
    fn aad_roundtrip_succeeds() {
        let blob = encrypt_with_aad(b"private key blob", b"kylins:acct-1:pgp-key:1")
            .expect("encrypt_with_aad");
        let bytes = hex::decode(&blob).unwrap();
        assert_eq!(
            bytes[0], VAULT_VERSION_V1,
            "v1 blob must start with the version byte"
        );
        let pt = decrypt_with_aad(&blob, b"kylins:acct-1:pgp-key:1").expect("decrypt_with_aad");
        assert_eq!(pt, b"private key blob");
    }

    #[test]
    fn aad_wrong_context_fails() {
        let blob = encrypt_with_aad(b"private key blob", b"kylins:acct-1:pgp-key:1")
            .expect("encrypt_with_aad");
        // Wrong AAD (different field/account) must fail AEAD verification.
        let err = decrypt_with_aad(&blob, b"kylins:acct-2:pgp-key:1");
        assert!(
            matches!(err, Err(CryptoVaultError::Aead(_))),
            "wrong AAD must reject"
        );
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
}
