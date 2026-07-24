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
    /// 'low' | 'normal' | 'high' (NULL treated as 'normal' by the TS side).
    pub importance: Option<String>,
    pub request_read_receipt: i64,
    pub request_delivery_receipt: i64,
    /// Scheduled send time (unix seconds), NULL = send immediately.
    pub deliver_at: Option<i64>,
    pub prevent_copy: i64,
    /// JSON object of extra send-time headers (importance/receipt/prevent-copy
    /// header projections computed by the TS mapper).
    pub extra_headers: Option<String>,
    /// JSON array of RFC address strings (same encoding as to/cc/bcc).
    pub reply_to_addresses: Option<String>,
    /// Dock intent / window mode: 'new' | 'reply' | 'replyAll' | 'forward' |
    /// 'replyWithAttachments' | 'replyAllWithAttachments' (NULL for rows
    /// written before this column existed — resume falls back to deriving
    /// the mode from reply_to_message_id).
    pub intent: Option<String>,
    /// Source message for reply/forward attachment seeding + forward chrome.
    pub original_message_id: Option<String>,
    pub include_original_attachments: i64,
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
        importance: row.try_get("importance").unwrap_or(None),
        request_read_receipt: row.try_get("request_read_receipt").unwrap_or(0),
        request_delivery_receipt: row.try_get("request_delivery_receipt").unwrap_or(0),
        deliver_at: row.try_get("deliver_at").unwrap_or(None),
        prevent_copy: row.try_get("prevent_copy").unwrap_or(0),
        extra_headers: row.try_get("extra_headers").unwrap_or(None),
        reply_to_addresses: row.try_get("reply_to_addresses").unwrap_or(None),
        intent: row.try_get("intent").unwrap_or(None),
        original_message_id: row.try_get("original_message_id").unwrap_or(None),
        include_original_attachments: row.try_get("include_original_attachments").unwrap_or(0),
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
    /// 'low' | 'normal' | 'high'.
    pub importance: Option<Option<String>>,
    pub request_read_receipt: bool,
    pub request_delivery_receipt: bool,
    pub deliver_at: Option<Option<i64>>,
    pub prevent_copy: bool,
    /// JSON object of extra send-time headers (precomputed by the TS mapper).
    pub extra_headers: Option<Option<String>>,
    /// Pre-formatted recipient JSON (same encoding as to/cc/bcc).
    pub reply_to: Option<Option<String>>,
    /// Dock intent / window mode (see `Draft::intent`).
    pub intent: Option<Option<String>>,
    pub original_message_id: Option<Option<String>>,
    pub include_original_attachments: bool,
}

/// Create a draft. Returns the new id. The row starts in `sync_status='pending'`.
pub async fn create(pool: &SqlitePool, input: DraftInput) -> Result<String, String> {
    let id = uuid::Uuid::new_v4().to_string();
    sqlx::query(
        "INSERT INTO local_drafts (
            id, account_id, to_addresses, cc_addresses, bcc_addresses, subject,
            body_html, from_email, thread_id, reply_to_message_id, signature_id,
            attachments, classification_id, is_encrypted, is_signed,
            importance, request_read_receipt, request_delivery_receipt, deliver_at,
            prevent_copy, extra_headers, reply_to_addresses,
            intent, original_message_id, include_original_attachments, sync_status
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15,
                  $16, $17, $18, $19, $20, $21, $22, $23, $24, $25, 'pending')",
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
    .bind(input.importance.unwrap_or(None))
    .bind(if input.request_read_receipt { 1i64 } else { 0 })
    .bind(if input.request_delivery_receipt { 1i64 } else { 0 })
    .bind(input.deliver_at.unwrap_or(None))
    .bind(if input.prevent_copy { 1i64 } else { 0 })
    .bind(input.extra_headers.unwrap_or(None))
    .bind(input.reply_to.unwrap_or(None))
    .bind(input.intent.unwrap_or(None))
    .bind(input.original_message_id.unwrap_or(None))
    .bind(if input.include_original_attachments {
        1i64
    } else {
        0
    })
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
            importance = $14,
            request_read_receipt = $15,
            request_delivery_receipt = $16,
            deliver_at = $17,
            prevent_copy = $18,
            extra_headers = $19,
            reply_to_addresses = $20,
            intent = $21,
            original_message_id = $22,
            include_original_attachments = $23,
            updated_at = $24
         WHERE id = $25",
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
    .bind(input.importance.unwrap_or(None))
    .bind(if input.request_read_receipt { 1i64 } else { 0 })
    .bind(if input.request_delivery_receipt { 1i64 } else { 0 })
    .bind(input.deliver_at.unwrap_or(None))
    .bind(if input.prevent_copy { 1i64 } else { 0 })
    .bind(input.extra_headers.unwrap_or(None))
    .bind(input.reply_to.unwrap_or(None))
    .bind(input.intent.unwrap_or(None))
    .bind(input.original_message_id.unwrap_or(None))
    .bind(if input.include_original_attachments {
        1i64
    } else {
        0
    })
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

#[cfg(test)]
mod tests {
    use super::*;

    async fn seed_account(pool: &SqlitePool, id: &str) {
        sqlx::query("INSERT INTO accounts (id, email) VALUES ($1, $2)")
            .bind(id)
            .bind(format!("{id}@example.com"))
            .execute(pool)
            .await
            .unwrap();
    }

    fn full_input(account_id: &str) -> DraftInput {
        DraftInput {
            account_id: account_id.to_string(),
            to: r#"["Alice <alice@x.com>"]"#.to_string(),
            cc: Some(Some(r#"["bob@x.com"]"#.to_string())),
            bcc: None,
            subject: "Hello".to_string(),
            body_html: "<p>Hi</p>".to_string(),
            from_email: Some(Some("me@x.com".to_string())),
            thread_id: Some(Some("t1".to_string())),
            reply_to_message_id: Some(Some("<m@x>".to_string())),
            signature_id: None,
            attachments: None,
            classification_id: Some(Some("confidential".to_string())),
            is_encrypted: true,
            is_signed: true,
            importance: Some(Some("high".to_string())),
            request_read_receipt: true,
            request_delivery_receipt: true,
            deliver_at: Some(Some(1_900_000_000)),
            prevent_copy: true,
            extra_headers: Some(Some(r#"{"X-Priority":"1"}"#.to_string())),
            reply_to: Some(Some(r#"["replyto@x.com"]"#.to_string())),
            intent: Some(Some("forward".to_string())),
            original_message_id: Some(Some("<orig@x>".to_string())),
            include_original_attachments: true,
        }
    }

    /// The completeness round-trip: every editable-draft field persists
    /// through create → get and update → list (regression: the whole set was
    /// silently dropped before the completeness migration).
    #[tokio::test]
    async fn create_get_update_round_trips_the_full_field_set() {
        let tmp = tempfile::tempdir().unwrap();
        let pool = crate::db::init_db(tmp.path()).await.unwrap();
        seed_account(&pool, "acc-1").await;

        let id = create(&pool, full_input("acc-1")).await.unwrap();
        let d = get(&pool, &id).await.unwrap().expect("draft exists");
        assert_eq!(d.importance.as_deref(), Some("high"));
        assert_eq!(d.request_read_receipt, 1);
        assert_eq!(d.request_delivery_receipt, 1);
        assert_eq!(d.deliver_at, Some(1_900_000_000));
        assert_eq!(d.prevent_copy, 1);
        assert_eq!(d.extra_headers.as_deref(), Some(r#"{"X-Priority":"1"}"#));
        assert_eq!(d.reply_to_addresses.as_deref(), Some(r#"["replyto@x.com"]"#));
        assert_eq!(d.intent.as_deref(), Some("forward"));
        assert_eq!(d.original_message_id.as_deref(), Some("<orig@x>"));
        assert_eq!(d.include_original_attachments, 1);
        assert_eq!(d.classification_id.as_deref(), Some("confidential"));
        assert_eq!(d.is_encrypted, 1);
        assert_eq!(d.is_signed, 1);

        let mut edited = full_input("acc-1");
        edited.importance = Some(Some("low".to_string()));
        edited.request_delivery_receipt = false;
        edited.deliver_at = None;
        edited.reply_to = None;
        update(&pool, &id, edited).await.unwrap();

        let rows = list_for_account(&pool, "acc-1").await.unwrap();
        assert_eq!(rows.len(), 1);
        let d = &rows[0];
        assert_eq!(d.importance.as_deref(), Some("low"));
        assert_eq!(d.request_delivery_receipt, 0);
        assert_eq!(d.deliver_at, None);
        assert_eq!(d.reply_to_addresses, None);
        assert!(d.updated_at >= d.created_at);
    }
}