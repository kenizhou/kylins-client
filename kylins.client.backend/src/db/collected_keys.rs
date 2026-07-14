//! Collected (staging) keys query layer.
//!
//! Owns the `collected_keys` table — the **silent staging** area for keys
//! observed via discovery (WKD/keyserver/autocrypt/contact) but not yet
//! accepted into `crypto_keys`. Staged rows are listed for UI review and
//! removed once the user accepts or rejects them.

use serde::{Deserialize, Serialize};
use sqlx::{sqlite::SqliteRow, Row, SqlitePool};

/// One collected-key staging row. Mirrors the `collected_keys` table; JSON
/// keys are camelCase for the frontend. `public_data` is the raw key bytes
/// (armored PGP / DER) as observed at discovery time.
#[derive(Debug, Clone, Serialize, Deserialize, Default, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CollectedKeyRow {
    pub id: i64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub account_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub peer_email: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub standard: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub fingerprint: Option<String>,
    #[serde(default, with = "serde_bytes_option")]
    pub public_data: Vec<u8>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source: Option<String>,
    pub seen_at: String,
}

/// serde helper: serialize `Vec<u8>` as a base64 string (or absent when empty),
/// so the frontend receives a portable representation rather than a raw byte
/// array. Empty vec serializes as `None`.
mod serde_bytes_option {
    use base64::{engine::general_purpose::STANDARD as B64, Engine};
    use serde::{Deserialize, Deserializer, Serializer};

    pub fn serialize<S: Serializer>(v: &Vec<u8>, s: S) -> Result<S::Ok, S::Error> {
        if v.is_empty() {
            return s.serialize_none();
        }
        s.serialize_str(&B64.encode(v))
    }

    pub fn deserialize<'de, D: Deserializer<'de>>(d: D) -> Result<Vec<u8>, D::Error> {
        let opt: Option<String> = Option::deserialize(d)?;
        match opt {
            Some(s) if !s.is_empty() => {
                B64.decode(s.as_bytes()).map_err(serde::de::Error::custom)
            }
            _ => Ok(Vec::new()),
        }
    }
}

fn row_to_collected_key(row: &SqliteRow) -> CollectedKeyRow {
    CollectedKeyRow {
        id: row.try_get("id").unwrap_or_default(),
        account_id: row.try_get("account_id").ok().flatten(),
        peer_email: row.try_get("peer_email").ok().flatten(),
        standard: row.try_get("standard").ok().flatten(),
        fingerprint: row.try_get("fingerprint").ok().flatten(),
        public_data: row.try_get("public_data").ok().flatten().unwrap_or_default(),
        source: row.try_get("source").ok().flatten(),
        seen_at: row.try_get("seen_at").unwrap_or_default(),
    }
}

/// Stage a discovered key. `seen_at` is stamped server-side via
/// `strftime('%s','now')`. Returns the new row id.
pub async fn stage_collected_key(
    pool: &SqlitePool,
    account_id: Option<&str>,
    peer_email: Option<&str>,
    standard: Option<&str>,
    fingerprint: Option<&str>,
    public_data: &[u8],
    source: Option<&str>,
) -> Result<i64, String> {
    let result = sqlx::query(
        "INSERT INTO collected_keys \
         (account_id, peer_email, standard, fingerprint, public_data, source, seen_at) \
         VALUES (?, ?, ?, ?, ?, ?, strftime('%s','now'))",
    )
    .bind(account_id)
    .bind(peer_email)
    .bind(standard)
    .bind(fingerprint)
    .bind(public_data)
    .bind(source)
    .execute(pool)
    .await
    .map_err(|e| e.to_string())?;
    Ok(result.last_insert_rowid())
}

/// List staged keys for a `(account_id, peer_email, standard)` triple, newest
/// first. Any of the filter values may be NULL in the table; the query matches
/// NULLs with `IS NOT DISTINCT FROM` so a `None` filter value matches NULL rows.
pub async fn list_collected_keys_for_peer(
    pool: &SqlitePool,
    account_id: &str,
    peer_email: &str,
    standard: &str,
) -> Result<Vec<CollectedKeyRow>, String> {
    let rows = sqlx::query(
        "SELECT id, account_id, peer_email, standard, fingerprint, public_data, source, seen_at \
         FROM collected_keys \
         WHERE account_id IS NOT DISTINCT FROM ? \
           AND peer_email IS NOT DISTINCT FROM ? \
           AND standard IS NOT DISTINCT FROM ? \
         ORDER BY seen_at DESC, id DESC",
    )
    .bind(account_id)
    .bind(peer_email)
    .bind(standard)
    .fetch_all(pool)
    .await
    .map_err(|e| e.to_string())?;
    Ok(rows.iter().map(row_to_collected_key).collect())
}

/// Remove a staged key by id.
pub async fn remove_collected_key(pool: &SqlitePool, id: i64) -> Result<(), String> {
    sqlx::query("DELETE FROM collected_keys WHERE id = ?")
        .bind(id)
        .execute(pool)
        .await
        .map_err(|e| e.to_string())?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn stage_list_remove_roundtrip() {
        let tmp = tempfile::tempdir().unwrap();
        let pool = crate::db::init_db(tmp.path()).await.unwrap();

        let id = stage_collected_key(
            &pool,
            Some("a1"),
            Some("peer@x.com"),
            Some("smime"),
            Some("fp1"),
            b"-----BEGIN CERTIFICATE-----\nFAKE\n-----END CERTIFICATE-----",
            Some("autocrypt"),
        )
        .await
        .unwrap();

        let rows = list_collected_keys_for_peer(&pool, "a1", "peer@x.com", "smime")
            .await
            .unwrap();
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].id, id);
        assert_eq!(rows[0].fingerprint.as_deref(), Some("fp1"));
        assert_eq!(rows[0].source.as_deref(), Some("autocrypt"));
        assert!(
            rows[0]
                .public_data
                .windows(5)
                .any(|w| w == b"BEGIN"),
            "public_data bytes must round-trip"
        );

        remove_collected_key(&pool, id).await.unwrap();
        let after = list_collected_keys_for_peer(&pool, "a1", "peer@x.com", "smime")
            .await
            .unwrap();
        assert!(after.is_empty(), "row must be removed");
    }
}
