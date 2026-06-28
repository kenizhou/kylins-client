//! Image allowlist domain query layer.
//!
//! Rust port of `kylins.client.frontend/src/services/db/imageAllowlist.ts`.
//! Owns the `image_allowlist` table (per-sender remote-image allowlist).

use sqlx::SqlitePool;

/// Trim + lowercase an email address. Mirrors `normalizeEmail`.
fn normalize_email(email: &str) -> String {
    email.trim().to_lowercase()
}

/// Add a sender to the allowlist (idempotent via INSERT OR IGNORE).
pub async fn add(pool: &SqlitePool, account_id: &str, sender_address: &str) -> Result<(), String> {
    let id = uuid::Uuid::new_v4().to_string();
    let normalized = normalize_email(sender_address);
    sqlx::query(
        "INSERT OR IGNORE INTO image_allowlist (id, account_id, sender_address) VALUES ($1, $2, $3)",
    )
    .bind(&id)
    .bind(account_id)
    .bind(&normalized)
    .execute(pool)
    .await
    .map_err(|e| e.to_string())?;
    Ok(())
}

/// Check whether a sender is on the allowlist for an account.
pub async fn is_allowlisted(
    pool: &SqlitePool,
    account_id: &str,
    sender_address: &str,
) -> Result<bool, String> {
    let normalized = normalize_email(sender_address);
    let row: Option<(String,)> = sqlx::query_as(
        "SELECT id FROM image_allowlist WHERE account_id = $1 AND sender_address = $2 LIMIT 1",
    )
    .bind(account_id)
    .bind(&normalized)
    .fetch_optional(pool)
    .await
    .map_err(|e| e.to_string())?;
    Ok(row.is_some())
}

/// Remove a sender from the allowlist for an account.
pub async fn remove(
    pool: &SqlitePool,
    account_id: &str,
    sender_address: &str,
) -> Result<(), String> {
    let normalized = normalize_email(sender_address);
    sqlx::query("DELETE FROM image_allowlist WHERE account_id = $1 AND sender_address = $2")
        .bind(account_id)
        .bind(&normalized)
        .execute(pool)
        .await
        .map_err(|e| e.to_string())?;
    Ok(())
}
