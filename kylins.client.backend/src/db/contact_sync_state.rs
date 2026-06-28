//! Contact sync state domain query layer.
//!
//! Rust port of `kylins.client.frontend/src/services/db/contactSyncState.ts`.
//! Owns the `contact_sync_state` table (per-account, per-source sync cursor).

use serde::{Deserialize, Serialize};
use sqlx::SqlitePool;

fn now_secs() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

/// Sync state row. Mirrors TS `ContactSyncState` (camelCase JSON keys).
#[derive(Debug, Clone, Serialize, Deserialize, Default, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ContactSyncState {
    pub account_id: String,
    pub source: String,
    pub sync_token: Option<String>,
    pub last_sync_at: Option<i64>,
}

/// Get the sync state for an (account, source) pair, or None.
pub async fn get(
    pool: &SqlitePool,
    account_id: &str,
    source: &str,
) -> Result<Option<ContactSyncState>, String> {
    let row: Option<(String, String, Option<String>, Option<i64>)> = sqlx::query_as(
        "SELECT account_id, source, sync_token, last_sync_at FROM contact_sync_state WHERE account_id = $1 AND source = $2 LIMIT 1",
    )
    .bind(account_id)
    .bind(source)
    .fetch_optional(pool)
    .await
    .map_err(|e| e.to_string())?;
    Ok(row.map(
        |(account_id, source, sync_token, last_sync_at)| ContactSyncState {
            account_id,
            source,
            sync_token,
            last_sync_at,
        },
    ))
}

/// Upsert sync state for an (account, source) pair. `last_sync_at` defaults to
/// now if not supplied (matches TS `?? Math.floor(Date.now()/1000)`).
pub async fn set(
    pool: &SqlitePool,
    account_id: &str,
    source: &str,
    sync_token: Option<&str>,
    last_sync_at: Option<i64>,
) -> Result<(), String> {
    let now = last_sync_at.unwrap_or_else(now_secs);
    sqlx::query(
        "INSERT INTO contact_sync_state (account_id, source, sync_token, last_sync_at)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT(account_id, source) DO UPDATE SET
           sync_token = $3,
           last_sync_at = $4",
    )
    .bind(account_id)
    .bind(source)
    .bind(sync_token)
    .bind(now)
    .execute(pool)
    .await
    .map_err(|e| e.to_string())?;
    Ok(())
}
