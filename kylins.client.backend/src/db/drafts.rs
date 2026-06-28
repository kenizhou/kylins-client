//! Local drafts domain query layer.
//!
//! Rust port of `kylins.client.frontend/src/composer/drafts.ts`. Owns the
//! `local_drafts` table CRUD (migration v17). Recipients are stored as
//! JSON-encoded arrays of RFC address strings ("Name <email>").
//!
//! The TS `DbDraft` interface surfaces the snake_case column names directly, so
//! the [`Draft`] DTO uses `#[serde(rename_all = "snake_case")]` to match
//! byte-for-byte. The TS caller (composer) reads these raw columns and parses
//! the JSON itself.

use serde::{Deserialize, Serialize};
use sqlx::{sqlite::SqliteRow, Row, SqlitePool};

fn now_secs() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

/// Draft row. Mirrors TS `DbDraft` exactly (snake_case JSON keys). Boolean-ish
/// columns stay i64 (0/1) to match the historical TS interface.
#[derive(Debug, Clone, Serialize, Deserialize, Default, PartialEq)]
#[serde(rename_all = "snake_case")]
pub struct Draft {
    pub id: String,
    pub account_id: String,
    pub to_addresses: Option<String>,
    pub cc_addresses: Option<String>,
    pub bcc_addresses: Option<String>,
    pub subject: Option<String>,
    pub body_html: Option<String>,
    pub reply_to_message_id: Option<String>,
    pub thread_id: Option<String>,
    pub from_email: Option<String>,
    pub signature_id: Option<String>,
    pub remote_draft_id: Option<String>,
    pub attachments: Option<String>,
    pub classification_id: Option<String>,
    pub is_encrypted: i64,
    pub is_signed: i64,
    pub created_at: i64,
    pub updated_at: i64,
    pub sync_status: String,
}

fn row_to_draft(row: &SqliteRow) -> Draft {
    Draft {
        id: row.try_get("id").unwrap_or_default(),
        account_id: row.try_get("account_id").unwrap_or_default(),
        to_addresses: row.try_get("to_addresses").unwrap_or(None),
        cc_addresses: row.try_get("cc_addresses").unwrap_or(None),
        bcc_addresses: row.try_get("bcc_addresses").unwrap_or(None),
        subject: row.try_get("subject").unwrap_or(None),
        body_html: row.try_get("body_html").unwrap_or(None),
        reply_to_message_id: row.try_get("reply_to_message_id").unwrap_or(None),
        thread_id: row.try_get("thread_id").unwrap_or(None),
        from_email: row.try_get("from_email").unwrap_or(None),
        signature_id: row.try_get("signature_id").unwrap_or(None),
        remote_draft_id: row.try_get("remote_draft_id").unwrap_or(None),
        attachments: row.try_get("attachments").unwrap_or(None),
        classification_id: row.try_get("classification_id").unwrap_or(None),
        is_encrypted: row.try_get("is_encrypted").unwrap_or(0),
        is_signed: row.try_get("is_signed").unwrap_or(0),
        created_at: row.try_get("created_at").unwrap_or(0),
        updated_at: row.try_get("updated_at").unwrap_or(0),
        sync_status: row
            .try_get("sync_status")
            .unwrap_or_else(|_| "pending".into()),
    }
}

/// Input for create/update. Mirrors TS `DraftInput`. JSON-array fields
/// (to/cc/bcc, attachments) are passed as serialized strings by the frontend
/// (which formats recipients and serializes attachments itself — same as before).
#[derive(Debug, Clone, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct DraftInput {
    pub account_id: String,
    /// Pre-formatted recipient JSON (string). Frontend calls formatRecipients + JSON.stringify.
    pub to: String,
    pub cc: Option<Option<String>>,
    pub bcc: Option<Option<String>>,
    pub subject: String,
    pub body_html: String,
    pub from_email: Option<Option<String>>,
    pub thread_id: Option<Option<String>>,
    pub reply_to_message_id: Option<Option<String>>,
    pub signature_id: Option<Option<String>>,
    pub attachments: Option<Option<String>>,
    pub classification_id: Option<Option<String>>,
    pub is_encrypted: bool,
    pub is_signed: bool,
}

/// Create a draft. Returns the new id. The row starts in `sync_status='pending'`.
pub async fn create(pool: &SqlitePool, input: DraftInput) -> Result<String, String> {
    let id = uuid::Uuid::new_v4().to_string();
    sqlx::query(
        "INSERT INTO local_drafts (
            id, account_id, to_addresses, cc_addresses, bcc_addresses, subject,
            body_html, from_email, thread_id, reply_to_message_id, signature_id,
            attachments, classification_id, is_encrypted, is_signed, sync_status
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, 'pending')",
    )
    .bind(&id)
    .bind(&input.account_id)
    .bind(&input.to)
    .bind(input.cc.unwrap_or(None))
    .bind(input.bcc.unwrap_or(None))
    .bind(&input.subject)
    .bind(&input.body_html)
    .bind(input.from_email.unwrap_or(None))
    .bind(input.thread_id.unwrap_or(None))
    .bind(input.reply_to_message_id.unwrap_or(None))
    .bind(input.signature_id.unwrap_or(None))
    .bind(input.attachments.unwrap_or(None))
    .bind(input.classification_id.unwrap_or(None))
    .bind(if input.is_encrypted { 1i64 } else { 0 })
    .bind(if input.is_signed { 1i64 } else { 0 })
    .execute(pool)
    .await
    .map_err(|e| e.to_string())?;
    Ok(id)
}

/// Update a draft's full content. Always bumps `updated_at`. Mirrors `updateDraft`.
pub async fn update(pool: &SqlitePool, id: &str, input: DraftInput) -> Result<(), String> {
    let now = now_secs();
    sqlx::query(
        "UPDATE local_drafts SET
            to_addresses = $1,
            cc_addresses = $2,
            bcc_addresses = $3,
            subject = $4,
            body_html = $5,
            from_email = $6,
            thread_id = $7,
            reply_to_message_id = $8,
            signature_id = $9,
            attachments = $10,
            classification_id = $11,
            is_encrypted = $12,
            is_signed = $13,
            updated_at = $14
         WHERE id = $15",
    )
    .bind(&input.to)
    .bind(input.cc.unwrap_or(None))
    .bind(input.bcc.unwrap_or(None))
    .bind(&input.subject)
    .bind(&input.body_html)
    .bind(input.from_email.unwrap_or(None))
    .bind(input.thread_id.unwrap_or(None))
    .bind(input.reply_to_message_id.unwrap_or(None))
    .bind(input.signature_id.unwrap_or(None))
    .bind(input.attachments.unwrap_or(None))
    .bind(input.classification_id.unwrap_or(None))
    .bind(if input.is_encrypted { 1i64 } else { 0 })
    .bind(if input.is_signed { 1i64 } else { 0 })
    .bind(now)
    .bind(id)
    .execute(pool)
    .await
    .map_err(|e| e.to_string())?;
    Ok(())
}

/// Delete a draft by id.
pub async fn delete(pool: &SqlitePool, id: &str) -> Result<(), String> {
    sqlx::query("DELETE FROM local_drafts WHERE id = $1")
        .bind(id)
        .execute(pool)
        .await
        .map_err(|e| e.to_string())?;
    Ok(())
}

/// Get a draft by id (or None).
pub async fn get(pool: &SqlitePool, id: &str) -> Result<Option<Draft>, String> {
    let row = sqlx::query("SELECT * FROM local_drafts WHERE id = $1")
        .bind(id)
        .fetch_optional(pool)
        .await
        .map_err(|e| e.to_string())?;
    Ok(row.as_ref().map(row_to_draft))
}

/// List drafts for an account, newest-first by updated_at.
pub async fn list_for_account(pool: &SqlitePool, account_id: &str) -> Result<Vec<Draft>, String> {
    let rows =
        sqlx::query("SELECT * FROM local_drafts WHERE account_id = $1 ORDER BY updated_at DESC")
            .bind(account_id)
            .fetch_all(pool)
            .await
            .map_err(|e| e.to_string())?;
    Ok(rows.iter().map(row_to_draft).collect())
}
