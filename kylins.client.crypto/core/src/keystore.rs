use serde::{Deserialize, Serialize};

use crate::error::Result;
use crate::handle::{KeyHandle, KeyHandleRef};
use crate::secret::SecretBox;
use crate::standard::Standard;

/// An in-Rust transport of a key's **material** (metadata + bytes). Unlike
/// [`KeyHandleRef`] (metadata only), `StoredKey` carries the public blob and,
/// for software keys, the private blob. It is the unit that moves Rust →
/// [`KeyStore`] → Rust; private material **never** crosses the IPC boundary.
///
/// # Serde
/// `private_data` is `#[serde(skip)]` because [`SecretBox`] is not `Serialize`
/// in secrecy 0.10 — and more importantly, private key material must never be
/// serialized into a serde stream (IPC, JSON logs, etc.). A round-tripped
/// `StoredKey` always has `private_data == None`; the bytes survive only
/// in-Rust through the `KeyStore` put/get path.
#[derive(Debug, Serialize, Deserialize)]
pub struct StoredKey {
    pub handle: KeyHandleRef,
    /// DER cert / armored PGP public / SM2 public — raw bytes.
    pub public_data: Vec<u8>,
    /// PKCS#8 DER (soft) private material; `None` for public-only/token keys.
    /// Skipped during serde so private bytes never serialize.
    #[serde(skip)]
    pub private_data: Option<SecretBox<Vec<u8>>>,
}

/// CRUD over key **material**. Implementations back this with the `crypto_keys`
/// / `collected_keys` SQLite tables (Phase 1+) and, for token keys, PKCS#11
/// lookups (Phase 4).
///
/// The trait is `async` because every concrete impl touches async storage
/// (SQLite via `sqlx`, PKCS#11 sessions, remote token services). Sync methods
/// would force bridges to `block_on` internally, risking runtime nesting.
///
/// - [`KeyStore::put`] consumes a [`StoredKey`] and returns the canonical
///   [`KeyHandleRef`] the caller should retain for later `get`/`export` calls.
/// - [`KeyStore::get`] retrieves the full material for a handle produced by
///   `put`/`find_by_email`.
#[async_trait::async_trait]
pub trait KeyStore: Send + Sync {
    async fn put(&self, key: StoredKey) -> Result<KeyHandleRef>;
    async fn get(&self, handle: &KeyHandle) -> Result<Option<StoredKey>>;
    async fn find_by_email(&self, standard: Standard, email: &str) -> Result<Vec<KeyHandleRef>>;
    async fn remove(&self, handle: &KeyHandle) -> Result<()>;
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::handle::KeyUsage;
    use crate::ids::{Fingerprint, KeyId};

    fn sample_stored_key() -> StoredKey {
        StoredKey {
            handle: KeyHandleRef {
                handle: KeyHandle::Software(KeyId("k1".into())),
                standard: Standard::Smime,
                fingerprint: Fingerprint::new("ab12cd"),
                usage: KeyUsage::SignAndEncrypt,
                algorithm: "ECDSA-P256".into(),
            },
            public_data: vec![0x30, 0x82, 0x01],
            private_data: Some(SecretBox::new(Box::new(vec![0xDE, 0xAD, 0xBE, 0xEF]))),
        }
    }

    #[test]
    fn stored_key_private_data_never_serializes() {
        let key = sample_stored_key();
        let json = serde_json::to_string(&key).expect("serialize");
        // The skip attribute must keep private material out of the JSON.
        assert!(
            !json.contains("private_data"),
            "private_data field leaked into JSON: {json}"
        );
        assert!(
            !json.contains("deadbeef") && !json.to_lowercase().contains("deadbeef"),
            "private bytes leaked into JSON: {json}"
        );
        // public material + handle DO survive.
        assert!(json.contains("public_data"));
        assert!(json.contains("ECDSA-P256"));
    }

    #[test]
    fn stored_key_roundtrip_private_data_is_none() {
        let key = sample_stored_key();
        let json = serde_json::to_string(&key).expect("serialize");
        let back: StoredKey = serde_json::from_str(&json).expect("deserialize");
        // Private material must NOT survive a serde round-trip.
        assert!(
            back.private_data.is_none(),
            "private material must not round-trip through serde"
        );
        // Metadata + public bytes are preserved.
        assert_eq!(back.handle, key.handle);
        assert_eq!(back.public_data, key.public_data);
    }
}
