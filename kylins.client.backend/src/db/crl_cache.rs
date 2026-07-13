//! CRL (Certificate Revocation List) cache query layer.
//!
//! Owns the `crl_cache` table CRUD. Populated by the G4 receive-crypto plan
//! (cert-chain validation fetches the issuer's CRL distribution point and
//! caches the DER here so revocation checks don't re-fetch on every signed
//! message); the module + table land in Plan 1 (G1) so the migration is paired
//! with its query layer. Rows are keyed by distribution-point URL; `next_update`
//! drives [`prune_stale_crls`] which evicts expired entries.

use serde::{Deserialize, Serialize};
use sqlx::SqlitePool;

/// A cached CRL row. JSON keys are camelCase for the IPC boundary. The DER
/// blob is stored verbatim (the issuer's signed CRL bytes); validation +
/// signature checking happen in the G4 pipeline, not here.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, sqlx::FromRow)]
#[serde(rename_all = "camelCase")]
pub struct CrlCacheRow {
    pub crl_url: String,
    /// Raw DER bytes of the issuer-signed CRL.
    pub crl_der: Vec<u8>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub issuer_dn: Option<String>,
    /// Epoch-seconds string. A row is stale once `now >= next_update`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub next_update: Option<String>,
    /// Epoch-seconds string (`strftime('%s','now')` at write time).
    pub fetched_at: String,
}

/// Insert or replace a cached CRL. On conflict (same `crl_url`) every field
/// updates — the latest fetch always wins. Caller supplies `fetched_at`
/// (convention: `strftime('%s','now')` string epoch seconds, matching
/// `crypto_keys` / `trust_decisions`).
pub async fn upsert_crl(pool: &SqlitePool, row: &CrlCacheRow) -> Result<(), String> {
    sqlx::query(
        "INSERT INTO crl_cache (crl_url, crl_der, issuer_dn, next_update, fetched_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(crl_url) DO UPDATE SET
            crl_der = excluded.crl_der,
            issuer_dn = excluded.issuer_dn,
            next_update = excluded.next_update,
            fetched_at = excluded.fetched_at",
    )
    .bind(&row.crl_url)
    .bind(&row.crl_der)
    .bind(&row.issuer_dn)
    .bind(&row.next_update)
    .bind(&row.fetched_at)
    .execute(pool)
    .await
    .map_err(|e| e.to_string())?;
    Ok(())
}

/// Read a cached CRL by its distribution-point URL, or `None` if not cached.
pub async fn get_crl(pool: &SqlitePool, crl_url: &str) -> Result<Option<CrlCacheRow>, String> {
    let row: Option<CrlCacheRow> = sqlx::query_as(
        "SELECT crl_url, crl_der, issuer_dn, next_update, fetched_at
         FROM crl_cache WHERE crl_url = ?",
    )
    .bind(crl_url)
    .fetch_optional(pool)
    .await
    .map_err(|e| e.to_string())?;
    Ok(row)
}

/// Delete cached CRLs whose `next_update` is strictly less than `now_epoch`
/// (string comparison on epoch-second strings is correct for equal-length
/// numeric strings). Returns the number of rows deleted. Idempotent.
pub async fn prune_stale_crls(pool: &SqlitePool, now_epoch: &str) -> Result<u64, String> {
    let res = sqlx::query("DELETE FROM crl_cache WHERE next_update IS NOT NULL AND next_update < ?")
        .bind(now_epoch)
        .execute(pool)
        .await
        .map_err(|e| e.to_string())?;
    Ok(res.rows_affected())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn upsert_then_get_round_trips() {
        let tmp = tempfile::tempdir().unwrap();
        let pool = crate::db::init_db(tmp.path()).await.unwrap();

        let row = CrlCacheRow {
            crl_url: "http://ca.example.com/crl.der".to_string(),
            crl_der: b"fake-der-bytes".to_vec(),
            issuer_dn: Some("CN=Test CA".to_string()),
            next_update: Some("1800000000".to_string()),
            fetched_at: "1770000000".to_string(),
        };
        upsert_crl(&pool, &row).await.unwrap();

        let got = get_crl(&pool, "http://ca.example.com/crl.der")
            .await
            .unwrap()
            .expect("row present");
        assert_eq!(got, row);
        assert_eq!(got.crl_der, b"fake-der-bytes");
    }

    #[tokio::test]
    async fn upsert_replaces_on_conflict() {
        let tmp = tempfile::tempdir().unwrap();
        let pool = crate::db::init_db(tmp.path()).await.unwrap();

        let mut row = CrlCacheRow {
            crl_url: "http://ca.example.com/crl.der".to_string(),
            crl_der: b"v1".to_vec(),
            issuer_dn: Some("CN=Test CA".to_string()),
            next_update: Some("1800000000".to_string()),
            fetched_at: "1770000000".to_string(),
        };
        upsert_crl(&pool, &row).await.unwrap();

        // Re-fetch: new DER + advanced next_update + new fetched_at.
        row.crl_der = b"v2-refreshed".to_vec();
        row.next_update = Some("1810000000".to_string());
        row.fetched_at = "1780000000".to_string();
        upsert_crl(&pool, &row).await.unwrap();

        let got = get_crl(&pool, "http://ca.example.com/crl.der")
            .await
            .unwrap()
            .expect("row present");
        assert_eq!(got.crl_der, b"v2-refreshed");
        assert_eq!(got.next_update.as_deref(), Some("1810000000"));
        assert_eq!(got.fetched_at, "1780000000");
    }

    #[tokio::test]
    async fn get_returns_none_when_absent() {
        let tmp = tempfile::tempdir().unwrap();
        let pool = crate::db::init_db(tmp.path()).await.unwrap();
        assert!(get_crl(&pool, "http://nope.example.com/crl.der")
            .await
            .unwrap()
            .is_none());
    }

    #[tokio::test]
    async fn prune_deletes_only_stale_rows() {
        let tmp = tempfile::tempdir().unwrap();
        let pool = crate::db::init_db(tmp.path()).await.unwrap();

        // Two CRLs: one stale (next_update before now), one fresh.
        let stale = CrlCacheRow {
            crl_url: "http://ca.example.com/stale.der".to_string(),
            crl_der: b"stale".to_vec(),
            issuer_dn: None,
            next_update: Some("1700000000".to_string()),
            fetched_at: "1690000000".to_string(),
        };
        let fresh = CrlCacheRow {
            crl_url: "http://ca.example.com/fresh.der".to_string(),
            crl_der: b"fresh".to_vec(),
            issuer_dn: None,
            next_update: Some("1900000000".to_string()),
            fetched_at: "1770000000".to_string(),
        };
        // A row with NULL next_update is NEVER pruned (no expiry known).
        let no_expiry = CrlCacheRow {
            crl_url: "http://ca.example.com/no-expiry.der".to_string(),
            crl_der: b"unknown".to_vec(),
            issuer_dn: None,
            next_update: None,
            fetched_at: "1770000000".to_string(),
        };
        upsert_crl(&pool, &stale).await.unwrap();
        upsert_crl(&pool, &fresh).await.unwrap();
        upsert_crl(&pool, &no_expiry).await.unwrap();

        let deleted = prune_stale_crls(&pool, "1800000000").await.unwrap();
        assert_eq!(deleted, 1, "only the stale row is deleted");

        assert!(get_crl(&pool, "http://ca.example.com/stale.der")
            .await
            .unwrap()
            .is_none());
        assert!(get_crl(&pool, "http://ca.example.com/fresh.der")
            .await
            .unwrap()
            .is_some());
        assert!(get_crl(&pool, "http://ca.example.com/no-expiry.der")
            .await
            .unwrap()
            .is_some());
    }

    #[tokio::test]
    async fn prune_noop_when_nothing_stale() {
        let tmp = tempfile::tempdir().unwrap();
        let pool = crate::db::init_db(tmp.path()).await.unwrap();
        let row = CrlCacheRow {
            crl_url: "http://ca.example.com/fresh.der".to_string(),
            crl_der: b"fresh".to_vec(),
            issuer_dn: None,
            next_update: Some("1900000000".to_string()),
            fetched_at: "1770000000".to_string(),
        };
        upsert_crl(&pool, &row).await.unwrap();

        let deleted = prune_stale_crls(&pool, "1800000000").await.unwrap();
        assert_eq!(deleted, 0);
    }
}
