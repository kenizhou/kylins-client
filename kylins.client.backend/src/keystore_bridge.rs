//! DB-backed `KeyStore` bridge: adapts [`crypto_core::KeyStore`] (the
//! material-aware trait from Plan 2 Task 2) to the existing
//! [`crate::db::crypto_keys`] SQLite layer (Plan 1).
//!
//! `StoredKey` ↔ `CryptoKeyRecord` mapping:
//! - `public_data` (DER bytes) ↔ hex-encoded `CryptoKeyRecord.public_data`.
//! - `private_data` (secret bytes) ↔ hex-encoded `CryptoKeyRecord.private_data`;
//!   the db layer wraps these at rest via [`crate::crypto::encrypt_with_aad`].
//! - `algorithm` + `usage` (crypto-core metadata with no db column) are carried
//!   in the per-key `policy_json` field so they survive a put→get round-trip.
//! - The `KeyHandleRef`'s `KeyId` embeds `standard|fingerprint` so that
//!   `get(&KeyHandle)` (which receives only the opaque `KeyHandle`) can recover
//!   the db lookup keys.
//!
//! # Deviation from plan
//! The plan wrote `SqliteKeyStore { pool: Arc<SqlitePool> }`. The db schema
//! (`crypto_keys.account_id TEXT NOT NULL REFERENCES accounts(id)`) requires an
//! account id on every insert; `StoredKey`/`KeyHandleRef` carry no account id.
//! The bridge therefore binds a fixed `account_id` at construction, mirroring
//! how the rest of the app scopes data per mail account. This is the minimal
//! change that makes the trait work without altering the db layer.

use std::str::FromStr;
use std::sync::Arc;

use async_trait::async_trait;
use serde::{Deserialize, Serialize};
use secrecy::ExposeSecret;
use sqlx::SqlitePool;

use crypto_core::{
    CryptoError, Fingerprint, KeyHandle, KeyHandleRef, KeyId, KeyStore, KeyUsage, Result as
    CryptoResult, Standard, StoredKey,
};

use crate::db::crypto_keys::{
    get_crypto_key_full, list_crypto_keys_for_email, upsert_crypto_key, CryptoKeyRecord,
    CryptoKeyRow,
};

/// String-error wrapper so db `String` errors can flow through
/// `CryptoError::backend` (which requires `std::error::Error`).
#[derive(Debug, thiserror::Error)]
#[error("keystore db error: {0}")]
struct DbError(String);

/// Per-key metadata persisted in `crypto_keys.policy_json`. The db schema has
/// no `algorithm`/`usage` columns; these crypto-core fields ride alongside the
/// key so a `get` round-trip recovers them.
#[derive(Serialize, Deserialize)]
struct KeyMetadata {
    algorithm: String,
    usage: KeyUsage,
}

/// SQLite-backed `KeyStore` scoped to one mail account. The db layer encrypts
/// private material at rest; this bridge hex-encodes binary material so DER
/// survives the String-based `CryptoKeyRecord` fields losslessly.
pub struct SqliteKeyStore {
    pool: Arc<SqlitePool>,
    account_id: String,
}

impl SqliteKeyStore {
    /// Construct a keystore bound to `account_id`. The account must exist in
    /// the `accounts` table (FK constraint on `crypto_keys`).
    pub fn new(pool: Arc<SqlitePool>, account_id: impl Into<String>) -> Self {
        Self {
            pool,
            account_id: account_id.into(),
        }
    }

    /// Encode `standard|fingerprint` into a `KeyId` so a later
    /// `get(&KeyHandle::Software(KeyId))` can recover the db lookup keys.
    fn encode_key_id(standard: Standard, fingerprint: &Fingerprint) -> KeyId {
        KeyId(format!("{}|{}", standard.as_str(), fingerprint.as_str()))
    }

    /// Parse a `KeyId` produced by [`encode_key_id`].
    fn decode_key_id(id: &KeyId) -> CryptoResult<(Standard, Fingerprint)> {
        let (std_str, fp) = id.0.split_once('|').ok_or_else(|| {
            CryptoError::Malformed(format!("invalid keystore KeyId (no '|'): {}", id.0))
        })?;
        let standard = Standard::from_str(std_str).map_err(|_| {
            CryptoError::Malformed(format!("unknown standard in KeyId: {std_str}"))
        })?;
        Ok((standard, Fingerprint::new(fp)))
    }
}

#[async_trait]
impl KeyStore for SqliteKeyStore {
    async fn put(&self, key: StoredKey) -> CryptoResult<KeyHandleRef> {
        let standard = key.handle.standard;
        let fingerprint = key.handle.fingerprint.clone();

        // Look up the bound account's email so find_by_email can locate this
        // key later (the cert's SAN email isn't parsed until Group B).
        let email: Option<String> = sqlx::query_scalar("SELECT email FROM accounts WHERE id = ?")
            .bind(&self.account_id)
            .fetch_optional(self.pool.as_ref())
            .await
            .map_err(|e| CryptoError::backend(DbError(e.to_string())))?
            .flatten();

        // Hex-encode material so binary DER survives the String-based db fields.
        let public_hex = hex::encode(&key.public_data);
        let private_hex = key
            .private_data
            .as_ref()
            .map(|s| hex::encode(s.expose_secret().as_slice()));

        // Persist algorithm + usage in policy_json (no dedicated columns).
        let metadata = KeyMetadata {
            algorithm: key.handle.algorithm.clone(),
            usage: key.handle.usage,
        };
        let policy_json = serde_json::to_string(&metadata).ok();

        let record = CryptoKeyRecord {
            row: CryptoKeyRow {
                // Empty id → upsert_crypto_key generates a uuid.
                id: String::new(),
                account_id: self.account_id.clone(),
                standard: standard.as_str().to_string(),
                key_type: "cert".to_string(),
                email,
                fingerprint: fingerprint.as_str().to_string(),
                origin: "generated".to_string(),
                ..Default::default()
            },
            public_data: public_hex,
            private_data: private_hex,
            policy_json,
        };

        upsert_crypto_key(self.pool.as_ref(), &record)
            .await
            .map_err(|e| CryptoError::backend(DbError(e)))?;

        // Return a canonical KeyHandleRef whose KeyId embeds standard|fingerprint.
        let mut canonical = key.handle;
        canonical.handle = KeyHandle::Software(Self::encode_key_id(standard, &fingerprint));
        Ok(canonical)
    }

    async fn get(&self, handle: &KeyHandle) -> CryptoResult<Option<StoredKey>> {
        let key_id = match handle {
            KeyHandle::Software(id) => id,
            // Token keys never live in the software store.
            KeyHandle::Token { .. } => return Ok(None),
        };
        let (standard, fingerprint) = Self::decode_key_id(key_id)?;

        let record = get_crypto_key_full(
            self.pool.as_ref(),
            standard.as_str(),
            fingerprint.as_str(),
        )
        .await
        .map_err(|e| CryptoError::backend(DbError(e)))?;

        let Some(record) = record else {
            return Ok(None);
        };

        // Hex-decode public material.
        let public_data = hex::decode(&record.public_data).map_err(|e| {
            CryptoError::Malformed(format!("public_data hex decode failed: {e}"))
        })?;

        // Hex-decode private material (already decrypted by get_crypto_key_full).
        let private_data = match record.private_data.as_deref() {
            Some(hex_str) if !hex_str.is_empty() => {
                let bytes = hex::decode(hex_str).map_err(|e| {
                    CryptoError::Malformed(format!("private_data hex decode failed: {e}"))
                })?;
                Some(crypto_core::SecretBox::new(Box::new(bytes)))
            }
            _ => None,
        };

        // Recover algorithm + usage from policy_json, or fall back to defaults.
        let (algorithm, usage) = record
            .policy_json
            .as_deref()
            .and_then(|s| serde_json::from_str::<KeyMetadata>(s).ok())
            .map(|m| (m.algorithm, m.usage))
            .unwrap_or_else(|| ("unknown".to_string(), KeyUsage::SignAndEncrypt));

        let handle_ref = KeyHandleRef {
            handle: KeyHandle::Software(key_id.clone()),
            standard,
            fingerprint,
            usage,
            algorithm,
        };

        Ok(Some(StoredKey {
            handle: handle_ref,
            public_data,
            private_data,
        }))
    }

    async fn find_by_email(
        &self,
        standard: Standard,
        email: &str,
    ) -> CryptoResult<Vec<KeyHandleRef>> {
        let rows = list_crypto_keys_for_email(self.pool.as_ref(), standard.as_str(), email)
            .await
            .map_err(|e| CryptoError::backend(DbError(e)))?;

        Ok(rows
            .into_iter()
            .filter_map(|row| {
                let fp = Fingerprint::new(&row.fingerprint);
                let std = Standard::from_str(&row.standard).ok()?;
                Some(KeyHandleRef {
                    handle: KeyHandle::Software(Self::encode_key_id(std, &fp)),
                    standard: std,
                    fingerprint: fp,
                    // find_by_email returns metadata-only refs; defaults are
                    // fine — callers call get() for full material + algorithm.
                    usage: KeyUsage::SignAndEncrypt,
                    algorithm: "unknown".to_string(),
                })
            })
            .collect())
    }

    async fn remove(&self, handle: &KeyHandle) -> CryptoResult<()> {
        let key_id = match handle {
            KeyHandle::Software(id) => id,
            KeyHandle::Token { .. } => return Ok(()),
        };
        let (standard, fingerprint) = Self::decode_key_id(key_id)?;

        sqlx::query("DELETE FROM crypto_keys WHERE standard = ? AND fingerprint = ?")
            .bind(standard.as_str())
            .bind(fingerprint.as_str())
            .execute(self.pool.as_ref())
            .await
            .map_err(|e| CryptoError::backend(DbError(e.to_string())))?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crypto_core::{KeyHandle as CoreKeyHandle, KeyUsage};

    async fn seed_account(pool: &SqlitePool, id: &str, email: &str) {
        sqlx::query(
            "INSERT INTO accounts (id, email, provider, is_active, is_default, sort_order, created_at, updated_at)
             VALUES (?, ?, 'imap', 1, 0, 0, strftime('%s','now'), strftime('%s','now'))",
        )
        .bind(id)
        .bind(email)
        .execute(pool)
        .await
        .unwrap();
    }

    fn sample_stored_key(fingerprint: &str, private_bytes: Vec<u8>) -> StoredKey {
        StoredKey {
            handle: KeyHandleRef {
                handle: CoreKeyHandle::Software(KeyId("placeholder".into())),
                standard: Standard::Smime,
                fingerprint: Fingerprint::new(fingerprint),
                usage: KeyUsage::SignAndEncrypt,
                algorithm: "ECDSA-P256".into(),
            },
            public_data: vec![0x30, 0x82, 0x01, 0xFF],
            private_data: Some(crypto_core::SecretBox::new(Box::new(private_bytes))),
        }
    }

    #[tokio::test]
    async fn put_then_get_roundtrips_private_material() {
        let tmp = tempfile::tempdir().unwrap();
        let pool = Arc::new(crate::db::init_db(tmp.path()).await.unwrap());
        seed_account(&pool, "acct-1", "owner@example.com").await;

        let store = SqliteKeyStore::new(pool.clone(), "acct-1");

        let original_priv = vec![0xDE, 0xAD, 0xBE, 0xEF, 0x01, 0x02];
        let stored = sample_stored_key("fp-aaa", original_priv.clone());

        let returned_ref = store.put(stored).await.expect("put");
        assert_eq!(returned_ref.standard, Standard::Smime);

        // get() returns the material with private_data decrypted back to original.
        let fetched = store
            .get(&returned_ref.handle)
            .await
            .expect("get")
            .expect("row present");
        assert_eq!(fetched.public_data, vec![0x30, 0x82, 0x01, 0xFF]);
        let fetched_priv = fetched
            .private_data
            .as_ref()
            .expect("private_data present")
            .expose_secret()
            .as_slice();
        assert_eq!(fetched_priv, original_priv);
        // Algorithm + usage survive the round-trip via policy_json.
        assert_eq!(fetched.handle.algorithm, "ECDSA-P256");
        assert_eq!(fetched.handle.usage, KeyUsage::SignAndEncrypt);
    }

    #[tokio::test]
    async fn put_public_only_key_roundtrips_with_none_private() {
        let tmp = tempfile::tempdir().unwrap();
        let pool = Arc::new(crate::db::init_db(tmp.path()).await.unwrap());
        seed_account(&pool, "acct-1", "owner@example.com").await;

        let store = SqliteKeyStore::new(pool, "acct-1");
        let mut stored = sample_stored_key("fp-pub", vec![]);
        stored.private_data = None;

        let returned_ref = store.put(stored).await.expect("put");
        let fetched = store
            .get(&returned_ref.handle)
            .await
            .expect("get")
            .expect("row present");
        assert!(
            fetched.private_data.is_none(),
            "public-only key must have no private material"
        );
    }

    #[tokio::test]
    async fn find_by_email_filters_by_email() {
        let tmp = tempfile::tempdir().unwrap();
        let pool = Arc::new(crate::db::init_db(tmp.path()).await.unwrap());
        seed_account(&pool, "acct-1", "owner@example.com").await;

        let store = SqliteKeyStore::new(pool.clone(), "acct-1");

        // Put a key for acct-1 (whose email is owner@example.com).
        store
            .put(sample_stored_key("fp-find", vec![0x11]))
            .await
            .unwrap();

        // find_by_email with the account's email locates the key.
        let found = store
            .find_by_email(Standard::Smime, "owner@example.com")
            .await
            .expect("find");
        assert_eq!(found.len(), 1);
        assert_eq!(found[0].fingerprint, Fingerprint::new("fp-find"));
        assert_eq!(found[0].standard, Standard::Smime);

        // A different email yields no results.
        let miss = store
            .find_by_email(Standard::Smime, "nobody@example.com")
            .await
            .expect("find miss");
        assert!(miss.is_empty(), "unrelated email must return nothing");
    }

    #[tokio::test]
    async fn remove_deletes_the_key() {
        let tmp = tempfile::tempdir().unwrap();
        let pool = Arc::new(crate::db::init_db(tmp.path()).await.unwrap());
        seed_account(&pool, "acct-1", "owner@example.com").await;

        let store = SqliteKeyStore::new(pool, "acct-1");
        let returned_ref = store
            .put(sample_stored_key("fp-rm", vec![0x22]))
            .await
            .unwrap();

        store.remove(&returned_ref.handle).await.expect("remove");
        let fetched = store.get(&returned_ref.handle).await.expect("get");
        assert!(fetched.is_none(), "removed key must not be found");
    }

    #[tokio::test]
    async fn stored_private_blob_is_opaque() {
        // Raw SELECT must not contain the plaintext private bytes.
        let tmp = tempfile::tempdir().unwrap();
        let pool = Arc::new(crate::db::init_db(tmp.path()).await.unwrap());
        seed_account(&pool, "acct-1", "owner@example.com").await;

        let store = SqliteKeyStore::new(pool.clone(), "acct-1");
        let original_priv = vec![0xCA, 0xFE, 0xBA, 0xBE];
        store
            .put(sample_stored_key("fp-opaque", original_priv.clone()))
            .await
            .unwrap();

        let (stored_enc,): (Option<String>,) =
            sqlx::query_as("SELECT private_data_enc FROM crypto_keys WHERE fingerprint = ?")
                .bind("fp-opaque")
                .fetch_one(pool.as_ref())
                .await
                .unwrap();
        let stored_enc = stored_enc.expect("private_data_enc populated");
        // The plaintext hex of our bytes must not appear in the encrypted blob.
        let plaintext_hex = hex::encode(&original_priv);
        assert!(
            !stored_enc.contains(&plaintext_hex),
            "private plaintext hex leaked into DB"
        );
    }
}
