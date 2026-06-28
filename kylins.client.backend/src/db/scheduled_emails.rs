//! Scheduled emails domain query layer.
//!
//! Rust port of `kylins.client.frontend/src/services/db/scheduledEmails.ts`.
//! Owns the `scheduled_emails` table CRUD.
//!
//! The TS `DbScheduledEmail` surfaces snake_case column names; this DTO matches
//! byte-for-byte with `#[serde(rename_all = "snake_case")]`.

use serde::{Deserialize, Serialize};
use sqlx::{
    sqlite::SqliteRow,
    Row, SqlitePool,
};

fn now_secs() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

/// Scheduled email row. Mirrors TS `DbScheduledEmail`.
#[derive(Debug, Clone, Serialize, Deserialize, Default, PartialEq)]
#[serde(rename_all = "snake_case")]
pub struct ScheduledEmail {
    pub id: String,
    pub account_id: String,
    pub to_addresses: String,
    pub cc_addresses: Option<String>,
    pub bcc_addresses: Option<String>,
    pub subject: Option<String>,
    pub body_html: String,
    pub reply_to_message_id: Option<String>,
    pub thread_id: Option<String>,
    pub scheduled_at: i64,
    pub signature_id: Option<String>,
    pub attachment_paths: Option<String>,
    pub status: String,
    pub created_at: i64,
}

fn row_to_scheduled(row: &SqliteRow) -> ScheduledEmail {
    ScheduledEmail {
        id: row.try_get("id").unwrap_or_default(),
        account_id: row.try_get("account_id").unwrap_or_default(),
        to_addresses: row.try_get("to_addresses").unwrap_or_default(),
        cc_addresses: row.try_get("cc_addresses").unwrap_or(None),
        bcc_addresses: row.try_get("bcc_addresses").unwrap_or(None),
        subject: row.try_get("subject").unwrap_or(None),
        body_html: row.try_get("body_html").unwrap_or_default(),
        reply_to_message_id: row.try_get("reply_to_message_id").unwrap_or(None),
        thread_id: row.try_get("thread_id").unwrap_or(None),
        scheduled_at: row.try_get("scheduled_at").unwrap_or(0),
        signature_id: row.try_get("signature_id").unwrap_or(None),
        attachment_paths: row.try_get("attachment_paths").unwrap_or(None),
        status: row.try_get("status").unwrap_or_else(|_| "pending".into()),
        created_at: row.try_get("created_at").unwrap_or(0),
    }
}

/// All pending scheduled emails whose `scheduled_at <= now`, oldest-first.
/// Mirrors `getPendingScheduledEmails`.
pub async fn list_pending(pool: &SqlitePool) -> Result<Vec<ScheduledEmail>, String> {
    let now = now_secs();
    let rows = sqlx::query(
        "SELECT * FROM scheduled_emails WHERE status = 'pending' AND scheduled_at <= $1 ORDER BY scheduled_at ASC",
    )
    .bind(now)
    .fetch_all(pool)
    .await
    .map_err(|e| e.to_string())?;
    Ok(rows.iter().map(row_to_scheduled).collect())
}

/// Pending scheduled emails for an account, oldest-first.
pub async fn list_for_account(
    pool: &SqlitePool,
    account_id: &str,
) -> Result<Vec<ScheduledEmail>, String> {
    let rows = sqlx::query(
        "SELECT * FROM scheduled_emails WHERE account_id = $1 AND status = 'pending' ORDER BY scheduled_at ASC",
    )
    .bind(account_id)
    .fetch_all(pool)
    .await
    .map_err(|e| e.to_string())?;
    Ok(rows.iter().map(row_to_scheduled).collect())
}

/// Input for [`insert`]. Mirrors the inline TS type.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InsertScheduledEmailInput {
    pub account_id: String,
    pub to_addresses: String,
    pub cc_addresses: Option<String>,
    pub bcc_addresses: Option<String>,
    pub subject: Option<String>,
    pub body_html: String,
    pub reply_to_message_id: Option<String>,
    pub thread_id: Option<String>,
    pub scheduled_at: i64,
    pub signature_id: Option<String>,
}

/// Insert a scheduled email. Returns its id.
pub async fn insert(
    pool: &SqlitePool,
    email: InsertScheduledEmailInput,
) -> Result<String, String> {
    let id = uuid::Uuid::new_v4().to_string();
    sqlx::query(
        "INSERT INTO scheduled_emails (id, account_id, to_addresses, cc_addresses, bcc_addresses, subject, body_html, reply_to_message_id, thread_id, scheduled_at, signature_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)",
    )
    .bind(&id)
    .bind(&email.account_id)
    .bind(&email.to_addresses)
    .bind(&email.cc_addresses)
    .bind(&email.bcc_addresses)
    .bind(&email.subject)
    .bind(&email.body_html)
    .bind(&email.reply_to_message_id)
    .bind(&email.thread_id)
    .bind(email.scheduled_at)
    .bind(&email.signature_id)
    .execute(pool)
    .await
    .map_err(|e| e.to_string())?;
    Ok(id)
}

/// Update the status of a scheduled email.
pub async fn update_status(
    pool: &SqlitePool,
    id: &str,
    status: &str,
) -> Result<(), String> {
    sqlx::query("UPDATE scheduled_emails SET status = $1 WHERE id = $2")
        .bind(status)
        .bind(id)
        .execute(pool)
        .await
        .map_err(|e| e.to_string())?;
    Ok(())
}

/// Delete a scheduled email by id.
pub async fn delete(pool: &SqlitePool, id: &str) -> Result<(), String> {
    sqlx::query("DELETE FROM scheduled_emails WHERE id = $1")
        .bind(id)
        .execute(pool)
        .await
        .map_err(|e| e.to_string())?;
    Ok(())
}

/// Get the most recent scheduled email for an account (used by Composer to
/// attach serialized attachment data after a send-later). This is a NEW command
/// surfaced for the Composer inline-DB refactor; the TS Composer previously did
/// this as a raw SELECT + UPDATE.
pub async fn latest_for_account(
    pool: &SqlitePool,
    account_id: &str,
) -> Result<Option<ScheduledEmail>, String> {
    let row = sqlx::query(
        "SELECT * FROM scheduled_emails WHERE account_id = $1 ORDER BY created_at DESC LIMIT 1",
    )
    .bind(account_id)
    .fetch_optional(pool)
    .await
    .map_err(|e| e.to_string())?;
    Ok(row.as_ref().map(row_to_scheduled))
}

/// Set the `attachment_paths` column on a scheduled email (Composer inline
/// refactor — replaces the raw UPDATE the Composer used to do).
pub async fn set_attachment_paths(
    pool: &SqlitePool,
    id: &str,
    attachment_paths: &str,
) -> Result<(), String> {
    sqlx::query("UPDATE scheduled_emails SET attachment_paths = $1 WHERE id = $2")
        .bind(attachment_paths)
        .bind(id)
        .execute(pool)
        .await
        .map_err(|e| e.to_string())?;
    Ok(())
}
