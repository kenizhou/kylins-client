//! Crypto identity key/cert query layer.
//!
//! Owns the `crypto_keys` table CRUD. Soft private-key blobs are wrapped at
//! rest via [`crate::crypto::encrypt_with_aad`] before they ever touch SQLite,
//! and decrypted in-Rust only via [`get_crypto_key_full`]. The AAD binds
//! `account_id + field name + key version` so a blob captured from one
//! account/field cannot be replayed against another.
//!
//! Two row types are exposed:
//! - [`CryptoKeyRow`] — the **public-facing** view returned across the Tauri
//!   IPC boundary. It carries NO private material; only `has_private: bool`.
//! - [`CryptoKeyRecord`] — the **internal** view used by [`upsert_crypto_key`]
//!   and [`get_crypto_key_full`] (in-Rust only, never a command). It includes
//!   the plaintext public blob and, optionally, the plaintext private blob
//!   that the db layer encrypts at rest.

use serde::{Deserialize, Serialize};
use sqlx::{sqlite::SqliteRow, Row, SqlitePool};

use crate::crypto::{decrypt_with_aad, encrypt_with_aad};

/// AAD key-version constant. Bumped into the AAD string so a future rotation
/// can migrate blobs without ambiguity: `aad = "kylins:{account_id}:private_key:{ver}"`.
const PRIVATE_KEY_AAD_VERSION: u8 = 1;

/// The public-facing crypto key row. Returned by `db_*` commands. Carries NO
/// private key material — only [`has_private`] indicating whether a soft
/// private blob exists at rest. JSON keys are camelCase for the frontend.
///
/// [`has_private`]: CryptoKeyRow::has_private
#[derive(Debug, Clone, Serialize, Deserialize, Default, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CryptoKeyRow {
    pub id: String,
    pub account_id: String,
    pub standard: String,
    pub key_type: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub email: Option<String>,
    pub fingerprint: String,
    pub origin: String,
    pub is_default_sign: bool,
    pub is_default_encrypt: bool,
    pub created_at: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub expires_at: Option<String>,
    /// `true` when `private_data_enc IS NOT NULL` (a soft private blob exists).
    pub has_private: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub token_serial: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub token_key_id: Option<String>,
}

/// The internal crypto key record. Carries the plaintext public blob and,
/// optionally, the plaintext private blob. Used as the [`upsert_crypto_key`]
/// input (so it derives `Deserialize`) and as the [`get_crypto_key_full`]
/// return (so it derives `Serialize`). **Never returned from a `db_*`
/// command** — the decrypting read is in-Rust only.
#[derive(Debug, Clone, Serialize, Deserialize, Default, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CryptoKeyRecord {
    #[serde(flatten)]
    pub row: CryptoKeyRow,
    /// Armored PGP / PEM / DER (hex) public material.
    pub public_data: String,
    /// Plaintext armored/DER private material; `None` for public-only/token keys.
    /// The db layer encrypts this at rest via [`encrypt_with_aad`] before
    /// writing, and decrypts on read in [`get_crypto_key_full`].
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub private_data: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub policy_json: Option<String>,
}

fn row_to_crypto_key(row: &SqliteRow) -> CryptoKeyRow {
    CryptoKeyRow {
        id: row.try_get("id").unwrap_or_default(),
        account_id: row.try_get("account_id").unwrap_or_default(),
        standard: row.try_get("standard").unwrap_or_default(),
        key_type: row.try_get("key_type").unwrap_or_default(),
        email: row.try_get("email").ok().flatten(),
        fingerprint: row.try_get("fingerprint").unwrap_or_default(),
        origin: row.try_get("origin").unwrap_or_default(),
        is_default_sign: row.try_get::<i64, _>("is_default_sign").unwrap_or(0) != 0,
        is_default_encrypt: row.try_get::<i64, _>("is_default_encrypt").unwrap_or(0) != 0,
        created_at: row.try_get("created_at").unwrap_or_default(),
        expires_at: row.try_get("expires_at").ok().flatten(),
        has_private: row.try_get::<i64, _>("has_private").unwrap_or(0) != 0,
        token_serial: row.try_get("token_serial").ok().flatten(),
        token_key_id: row.try_get("token_key_id").ok().flatten(),
    }
}

/// Build the AAD bound into the private-key wrapping. The same string is
/// recomputed on decrypt so a blob lifted from one account/field/version
/// fails AEAD verification elsewhere.
fn private_aad(account_id: &str) -> String {
    format!(
        "kylins:{}:private_key:{}",
        account_id, PRIVATE_KEY_AAD_VERSION
    )
}

/// Insert or update a crypto key. Booleans are bound as `i64`. If
/// [`CryptoKeyRecord::private_data`] is `Some(pt)`, it is wrapped via
/// [`encrypt_with_aad`] with the account-bound AAD and stored in
/// `private_data_enc`; otherwise `private_data_enc` is NULL. On conflict
/// (same `account_id + standard + fingerprint`) the `id` + `created_at` +
/// `origin` are preserved; all other fields update.
pub async fn upsert_crypto_key(pool: &SqlitePool, rec: &CryptoKeyRecord) -> Result<(), String> {
    let id = if rec.row.id.is_empty() {
        uuid::Uuid::new_v4().to_string()
    } else {
        rec.row.id.clone()
    };

    // Encrypt the private blob at rest if present.
    let private_data_enc: Option<String> = match rec.private_data.as_deref() {
        Some(pt) if !pt.is_empty() => {
            let aad = private_aad(&rec.row.account_id);
            Some(encrypt_with_aad(pt.as_bytes(), aad.as_bytes()).map_err(|e| e.to_string())?)
        }
        _ => None,
    };

    sqlx::query(
        "INSERT INTO crypto_keys (
            id, account_id, standard, key_type, email, fingerprint, public_data,
            private_data_enc, token_serial, token_key_id, origin,
            is_default_sign, is_default_encrypt, created_at, expires_at, policy_json
        ) VALUES (
            ?, ?, ?, ?, ?, ?, ?,
            ?, ?, ?, ?,
            ?, ?, strftime('%s','now'), ?, ?
        )
        ON CONFLICT(account_id, standard, fingerprint) DO UPDATE SET
            key_type = excluded.key_type,
            email = excluded.email,
            public_data = excluded.public_data,
            private_data_enc = excluded.private_data_enc,
            token_serial = excluded.token_serial,
            token_key_id = excluded.token_key_id,
            is_default_sign = excluded.is_default_sign,
            is_default_encrypt = excluded.is_default_encrypt,
            expires_at = excluded.expires_at,
            policy_json = excluded.policy_json",
    )
    .bind(&id)
    .bind(&rec.row.account_id)
    .bind(&rec.row.standard)
    .bind(&rec.row.key_type)
    .bind(&rec.row.email)
    .bind(&rec.row.fingerprint)
    .bind(&rec.public_data)
    .bind(&private_data_enc)
    .bind(&rec.row.token_serial)
    .bind(&rec.row.token_key_id)
    .bind(&rec.row.origin)
    .bind(rec.row.is_default_sign as i64)
    .bind(rec.row.is_default_encrypt as i64)
    .bind(&rec.row.expires_at)
    .bind(&rec.policy_json)
    .execute(pool)
    .await
    .map_err(|e| e.to_string())?;
    Ok(())
}

const PUBLIC_COLS: &str = "id, account_id, standard, key_type, email, fingerprint, origin, \
     is_default_sign, is_default_encrypt, created_at, expires_at, \
     (private_data_enc IS NOT NULL) AS has_private, token_serial, token_key_id";

/// Return the public-facing row for a key identified by `(standard,
/// fingerprint)`, or `None`. Never exposes private material.
pub async fn get_crypto_key_public(
    pool: &SqlitePool,
    standard: &str,
    fingerprint: &str,
) -> Result<Option<CryptoKeyRow>, String> {
    let sql = format!("SELECT {PUBLIC_COLS} FROM crypto_keys WHERE standard = ? AND fingerprint = ?");
    let row = sqlx::query(&sql)
        .bind(standard)
        .bind(fingerprint)
        .fetch_optional(pool)
        .await
        .map_err(|e| e.to_string())?;
    Ok(row.map(|r| row_to_crypto_key(&r)))
}

/// Return the full record (incl. decrypted private blob) for
/// `(standard, fingerprint)`, or `None`. **In-Rust only — never a command.**
/// Recomputes the same AAD used at write time and decrypts via
/// [`decrypt_with_aad`]; a wrong AAD (different account/version) fails AEAD
/// verification.
pub async fn get_crypto_key_full(
    pool: &SqlitePool,
    standard: &str,
    fingerprint: &str,
) -> Result<Option<CryptoKeyRecord>, String> {
    let row = sqlx::query(
        "SELECT id, account_id, standard, key_type, email, fingerprint, public_data, \
                private_data_enc, token_serial, token_key_id, origin, \
                is_default_sign, is_default_encrypt, created_at, expires_at, policy_json \
         FROM crypto_keys WHERE standard = ? AND fingerprint = ?",
    )
    .bind(standard)
    .bind(fingerprint)
    .fetch_optional(pool)
    .await
    .map_err(|e| e.to_string())?;

    let Some(row) = row else { return Ok(None) };

    let account_id: String = row.try_get("account_id").unwrap_or_default();
    let enc_hex: Option<String> = row
        .try_get::<Option<String>, _>("private_data_enc")
        .ok()
        .flatten();
    let private_data = match enc_hex.as_deref().filter(|s| !s.is_empty()) {
        Some(enc) => {
            let aad = private_aad(&account_id);
            let bytes = decrypt_with_aad(enc, aad.as_bytes()).map_err(|e| e.to_string())?;
            Some(String::from_utf8(bytes).map_err(|e| e.to_string())?)
        }
        None => None,
    };

    Ok(Some(CryptoKeyRecord {
        row: CryptoKeyRow {
            id: row.try_get("id").unwrap_or_default(),
            account_id,
            standard: row.try_get("standard").unwrap_or_default(),
            key_type: row.try_get("key_type").unwrap_or_default(),
            email: row.try_get("email").ok().flatten(),
            fingerprint: row.try_get("fingerprint").unwrap_or_default(),
            origin: row.try_get("origin").unwrap_or_default(),
            is_default_sign: row.try_get::<i64, _>("is_default_sign").unwrap_or(0) != 0,
            is_default_encrypt: row.try_get::<i64, _>("is_default_encrypt").unwrap_or(0) != 0,
            created_at: row.try_get("created_at").unwrap_or_default(),
            expires_at: row.try_get("expires_at").ok().flatten(),
            has_private: enc_hex.is_some(),
            token_serial: row.try_get("token_serial").ok().flatten(),
            token_key_id: row.try_get("token_key_id").ok().flatten(),
        },
        public_data: row.try_get("public_data").unwrap_or_default(),
        private_data,
        policy_json: row.try_get("policy_json").ok().flatten(),
    }))
}

/// List public-facing rows for `(standard, email)`. Ordered by fingerprint
/// for deterministic output. Never exposes private material.
pub async fn list_crypto_keys_for_email(
    pool: &SqlitePool,
    standard: &str,
    email: &str,
) -> Result<Vec<CryptoKeyRow>, String> {
    let sql = format!(
        "SELECT {PUBLIC_COLS} FROM crypto_keys WHERE standard = ? AND email = ? ORDER BY fingerprint"
    );
    let rows = sqlx::query(&sql)
        .bind(standard)
        .bind(email)
        .fetch_all(pool)
        .await
        .map_err(|e| e.to_string())?;
    Ok(rows.iter().map(row_to_crypto_key).collect())
}

/// List public-facing rows for `(account_id, standard)`. Ordered by
/// fingerprint. Never exposes private material.
pub async fn list_crypto_keys_for_account(
    pool: &SqlitePool,
    account_id: &str,
    standard: &str,
) -> Result<Vec<CryptoKeyRow>, String> {
    let sql = format!(
        "SELECT {PUBLIC_COLS} FROM crypto_keys WHERE account_id = ? AND standard = ? ORDER BY fingerprint"
    );
    let rows = sqlx::query(&sql)
        .bind(account_id)
        .bind(standard)
        .fetch_all(pool)
        .await
        .map_err(|e| e.to_string())?;
    Ok(rows.iter().map(row_to_crypto_key).collect())
}

#[cfg(test)]
mod tests {
    use super::*;

    async fn seed_account(pool: &SqlitePool, id: &str) {
        sqlx::query(
            "INSERT INTO accounts (id, email, provider, is_active, is_default, sort_order, created_at, updated_at)
             VALUES (?, ?, 'imap', 1, 0, 0, strftime('%s','now'), strftime('%s','now'))",
        )
        .bind(id)
        .bind(format!("{id}@x.com"))
        .execute(pool)
        .await
        .unwrap();
    }

    fn sample_record(account_id: &str, fingerprint: &str) -> CryptoKeyRecord {
        CryptoKeyRecord {
            row: CryptoKeyRow {
                id: format!("k_{fingerprint}"),
                account_id: account_id.to_string(),
                standard: "smime".to_string(),
                key_type: "cert".to_string(),
                email: Some(format!("{account_id}@x.com")),
                fingerprint: fingerprint.to_string(),
                origin: "generated".to_string(),
                ..Default::default()
            },
            public_data: "-----BEGIN CERTIFICATE-----\nFAKE\n-----END CERTIFICATE-----".to_string(),
            private_data: Some("-----BEGIN ENCRYPTED PRIVATE KEY-----\nSECRET\n-----END ENCRYPTED PRIVATE KEY-----".to_string()),
            policy_json: None,
        }
    }

    #[tokio::test]
    async fn upsert_then_public_row_has_private_flag_no_private_field() {
        let tmp = tempfile::tempdir().unwrap();
        let pool = crate::db::init_db(tmp.path()).await.unwrap();
        seed_account(&pool, "a1").await;
        let rec = sample_record("a1", "fp1");
        upsert_crypto_key(&pool, &rec).await.unwrap();

        let pub_row = get_crypto_key_public(&pool, "smime", "fp1")
            .await
            .unwrap()
            .expect("row present");
        assert!(pub_row.has_private, "has_private must be true");
        assert_eq!(pub_row.fingerprint, "fp1");
        assert_eq!(pub_row.origin, "generated");
        // CryptoKeyRow has NO private_data field — assert at the type level by
        // constructing a default and checking it serializes without one.
        let json = serde_json::to_value(CryptoKeyRow::default()).unwrap();
        assert!(
            json.as_object().map(|o| !o.contains_key("privateData")).unwrap_or(true),
            "CryptoKeyRow must not expose privateData"
        );
        // Spot-check the serialized public row has hasPrivate but no privateData.
        let json = serde_json::to_value(&pub_row).unwrap();
        assert!(json.get("hasPrivate").is_some());
        assert!(json.get("privateData").is_none());
    }

    #[tokio::test]
    async fn full_roundtrip_decrypts_private_to_original() {
        let tmp = tempfile::tempdir().unwrap();
        let pool = crate::db::init_db(tmp.path()).await.unwrap();
        seed_account(&pool, "a1").await;
        let rec = sample_record("a1", "fp2");
        upsert_crypto_key(&pool, &rec).await.unwrap();

        let full = get_crypto_key_full(&pool, "smime", "fp2")
            .await
            .unwrap()
            .expect("row present");
        assert_eq!(full.private_data.as_deref(), rec.private_data.as_deref());
        assert_eq!(full.public_data, rec.public_data);
    }

    #[tokio::test]
    async fn stored_private_blob_is_opaque() {
        // Raw SELECT of private_data_enc must NOT contain the plaintext.
        let tmp = tempfile::tempdir().unwrap();
        let pool = crate::db::init_db(tmp.path()).await.unwrap();
        seed_account(&pool, "a1").await;
        let rec = sample_record("a1", "fp3");
        upsert_crypto_key(&pool, &rec).await.unwrap();

        let (stored,): (Option<String>,) =
            sqlx::query_as("SELECT private_data_enc FROM crypto_keys WHERE fingerprint = ?")
                .bind("fp3")
                .fetch_one(&pool)
                .await
                .unwrap();
        let stored = stored.expect("private_data_enc must be populated");
        assert!(
            !stored.contains("SECRET"),
            "plaintext leaked into DB: {stored}"
        );
        assert!(
            !stored.contains("BEGIN ENCRYPTED PRIVATE KEY"),
            "plaintext header leaked into DB"
        );
        // Must be hex (the encrypt_with_aad output format).
        assert!(
            stored.chars().all(|c| c.is_ascii_hexdigit()),
            "expected hex blob, got non-hex chars"
        );
    }

    #[tokio::test]
    async fn re_upsert_same_key_preserves_created_at_and_id() {
        let tmp = tempfile::tempdir().unwrap();
        let pool = crate::db::init_db(tmp.path()).await.unwrap();
        seed_account(&pool, "a1").await;
        let rec = sample_record("a1", "fp4");
        upsert_crypto_key(&pool, &rec).await.unwrap();
        let before = get_crypto_key_public(&pool, "smime", "fp4")
            .await
            .unwrap()
            .unwrap();
        let original_created = before.created_at.clone();
        let original_id = before.id.clone();

        // Yield so strftime('%s','now') would advance if it re-stamped.
        tokio::time::sleep(std::time::Duration::from_secs(1)).await;

        // Re-upsert with a different default flag + new id attempt.
        let mut rec2 = sample_record("a1", "fp4");
        rec2.row.id = "DIFFERENT_ID".to_string();
        rec2.row.is_default_sign = true;
        upsert_crypto_key(&pool, &rec2).await.unwrap();

        let after = get_crypto_key_public(&pool, "smime", "fp4")
            .await
            .unwrap()
            .unwrap();
        assert_eq!(after.created_at, original_created, "created_at must be preserved");
        assert_eq!(after.id, original_id, "id must be preserved on conflict");
        assert!(after.is_default_sign, "updatable field must update");
    }

    #[tokio::test]
    async fn cross_account_isolation() {
        let tmp = tempfile::tempdir().unwrap();
        let pool = crate::db::init_db(tmp.path()).await.unwrap();
        seed_account(&pool, "a1").await;
        seed_account(&pool, "a2").await;
        // Same fingerprint, different accounts — both must coexist (UNIQUE is
        // account_id+standard+fingerprint). The global PRIMARY KEY `id` must
        // still differ per row.
        let mut r1 = sample_record("a1", "shared_fp");
        let mut r2 = sample_record("a2", "shared_fp");
        r1.row.id = "k_a1_shared".into();
        r2.row.id = "k_a2_shared".into();
        r1.row.email = Some("a1@x.com".into());
        r2.row.email = Some("a2@x.com".into());
        upsert_crypto_key(&pool, &r1).await.unwrap();
        upsert_crypto_key(&pool, &r2).await.unwrap();

        let a1 = list_crypto_keys_for_account(&pool, "a1", "smime")
            .await
            .unwrap();
        let a2 = list_crypto_keys_for_account(&pool, "a2", "smime")
            .await
            .unwrap();
        assert_eq!(a1.len(), 1);
        assert_eq!(a2.len(), 1);
        assert_eq!(a1[0].email.as_deref(), Some("a1@x.com"));
        assert_eq!(a2[0].email.as_deref(), Some("a2@x.com"));
    }

    #[tokio::test]
    async fn list_for_email_filters_by_email() {
        let tmp = tempfile::tempdir().unwrap();
        let pool = crate::db::init_db(tmp.path()).await.unwrap();
        seed_account(&pool, "a1").await;
        let mut r1 = sample_record("a1", "fp_a");
        r1.row.email = Some("peer@x.com".into());
        let mut r2 = sample_record("a1", "fp_b");
        r2.row.email = Some("other@x.com".into());
        upsert_crypto_key(&pool, &r1).await.unwrap();
        upsert_crypto_key(&pool, &r2).await.unwrap();

        let rows = list_crypto_keys_for_email(&pool, "smime", "peer@x.com")
            .await
            .unwrap();
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].fingerprint, "fp_a");
    }

    #[tokio::test]
    async fn public_only_key_has_no_private() {
        let tmp = tempfile::tempdir().unwrap();
        let pool = crate::db::init_db(tmp.path()).await.unwrap();
        seed_account(&pool, "a1").await;
        let mut rec = sample_record("a1", "fp_pub");
        rec.private_data = None;
        upsert_crypto_key(&pool, &rec).await.unwrap();

        let pub_row = get_crypto_key_public(&pool, "smime", "fp_pub")
            .await
            .unwrap()
            .unwrap();
        assert!(!pub_row.has_private);
        let full = get_crypto_key_full(&pool, "smime", "fp_pub")
            .await
            .unwrap()
            .unwrap();
        assert!(full.private_data.is_none());
    }
}
