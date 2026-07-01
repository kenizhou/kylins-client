//! Attachment metadata query layer.
//!
//! The `attachments` table holds per-message MIME attachment metadata parsed
//! from the full body (filename, mime_type, size, content_id, is_inline, and
//! `imap_part_id` — the IMAP MIME section like "1.2" used to fetch the part
//! bytes on demand). Metadata is populated by `request_bodies_inner` whenever a
//! body is fetched (on-demand prefetch/select), using the `ImapAttachment`
//! list produced by `mail::imap::client::extract_attachments`. Binary content
//! is NOT cached here — it is fetched on demand via `sync_fetch_attachment` /
//! `sync_fetch_inline_images` and either downloaded (save dialog) or embedded
//! as a `data:` URL for inline `cid:` images.

use crate::mail::imap::types::ImapAttachment;
use serde::{Deserialize, Serialize};
use sqlx::{sqlite::SqliteRow, Row, SqlitePool};

/// One attachment-metadata row. Mirrors the `attachments` table; JSON keys are
/// camelCase for the frontend.
#[derive(Debug, Clone, Serialize, Deserialize, Default, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AttachmentRow {
    pub id: String,
    pub account_id: String,
    pub message_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub filename: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub mime_type: Option<String>,
    #[serde(default)]
    pub size: i64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub content_id: Option<String>,
    #[serde(default)]
    pub is_inline: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub imap_part_id: Option<String>,
}

fn row_to_attachment(row: &SqliteRow) -> AttachmentRow {
    AttachmentRow {
        id: row.try_get("id").unwrap_or_default(),
        account_id: row.try_get("account_id").unwrap_or_default(),
        message_id: row.try_get("message_id").unwrap_or_default(),
        filename: row.try_get("filename").ok().flatten(),
        mime_type: row.try_get("mime_type").ok().flatten(),
        size: row.try_get("size").unwrap_or(0),
        content_id: row.try_get("content_id").ok().flatten(),
        is_inline: row.try_get::<i64, _>("is_inline").unwrap_or(0) != 0,
        imap_part_id: row.try_get("imap_part_id").ok().flatten(),
    }
}

/// Replace the set of attachment rows for `(account_id, message_id)` with
/// `atts` in one transaction. Delete-then-insert keeps the table in sync with
/// the current MIME structure (parts can change if a message is re-fetched
/// after a server-side edit). Idempotent: a re-upsert with the same `atts`
/// yields the same rows. Empty `atts` just clears the set (the message had no
/// parseable attachments).
pub async fn upsert_attachments(
    pool: &SqlitePool,
    account_id: &str,
    message_id: &str,
    atts: &[ImapAttachment],
) -> Result<(), String> {
    let mut tx = pool.begin().await.map_err(|e| format!("begin tx: {e}"))?;
    sqlx::query("DELETE FROM attachments WHERE account_id = ? AND message_id = ?")
        .bind(account_id)
        .bind(message_id)
        .execute(&mut *tx)
        .await
        .map_err(|e| e.to_string())?;
    for att in atts {
        // id = "{account_id}_{message_id}_{part_id}" — stable across re-upserts
        // for the same part, and unique across accounts (the `attachments.id`
        // PRIMARY KEY is global, so account_id must be part of it).
        let id = format!("{account_id}_{message_id}_{}", att.part_id);
        sqlx::query(
            "INSERT OR REPLACE INTO attachments \
             (id, message_id, account_id, filename, mime_type, size, content_id, is_inline, imap_part_id) \
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
        )
        .bind(&id)
        .bind(message_id)
        .bind(account_id)
        .bind(&att.filename)
        .bind(&att.mime_type)
        .bind(att.size as i64)
        .bind(&att.content_id)
        .bind(if att.is_inline { 1i64 } else { 0i64 })
        .bind(&att.part_id)
        .execute(&mut *tx)
        .await
        .map_err(|e| e.to_string())?;
    }
    tx.commit().await.map_err(|e| e.to_string())?;
    Ok(())
}

/// List attachment metadata for a message, ordered by part id (sections like
/// "1", "1.2", "2" — lexicographic keeps top-level parts in order).
pub async fn get_attachments(
    pool: &SqlitePool,
    account_id: &str,
    message_id: &str,
) -> Result<Vec<AttachmentRow>, String> {
    let rows = sqlx::query(
        "SELECT id, account_id, message_id, filename, mime_type, size, content_id, is_inline, imap_part_id \
         FROM attachments WHERE account_id = ? AND message_id = ? ORDER BY imap_part_id ASC",
    )
    .bind(account_id)
    .bind(message_id)
    .fetch_all(pool)
    .await
    .map_err(|e| e.to_string())?;
    Ok(rows.iter().map(row_to_attachment).collect())
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

    async fn seed_message(pool: &SqlitePool, account_id: &str, thread_id: &str, message_id: &str) {
        sqlx::query(
            "INSERT INTO threads (id, account_id, is_read, last_message_at)
             VALUES (?, ?, 0, 0)",
        )
        .bind(thread_id)
        .bind(account_id)
        .execute(pool)
        .await
        .unwrap();
        sqlx::query(
            "INSERT INTO messages (id, account_id, thread_id, date, is_read, is_starred, body_cached)
             VALUES (?, ?, ?, 0, 0, 0, 0)",
        )
        .bind(message_id)
        .bind(account_id)
        .bind(thread_id)
        .execute(pool)
        .await
        .unwrap();
    }

    fn att(part_id: &str, filename: &str, mime: &str, size: u32, cid: Option<&str>, inline: bool) -> ImapAttachment {
        ImapAttachment {
            part_id: part_id.to_string(),
            filename: filename.to_string(),
            mime_type: mime.to_string(),
            size,
            content_id: cid.map(String::from),
            is_inline: inline,
        }
    }

    #[tokio::test]
    async fn upsert_then_get_roundtrips_rows() {
        let tmp = tempfile::tempdir().unwrap();
        let pool = crate::db::init_db(tmp.path()).await.unwrap();
        seed_account(&pool, "a1").await;
        seed_message(&pool, "a1", "t1", "m1").await;

        upsert_attachments(
            &pool,
            "a1",
            "m1",
            &[
                att("1", "logo.png", "image/png", 1234, Some("logo@x"), true),
                att("2", "report.pdf", "application/pdf", 56789, None, false),
            ],
        )
        .await
        .unwrap();

        let rows = get_attachments(&pool, "a1", "m1").await.unwrap();
        assert_eq!(rows.len(), 2);
        assert_eq!(rows[0].imap_part_id.as_deref(), Some("1"));
        assert_eq!(rows[0].filename.as_deref(), Some("logo.png"));
        assert_eq!(rows[0].size, 1234);
        assert_eq!(rows[0].content_id.as_deref(), Some("logo@x"));
        assert!(rows[0].is_inline);
        assert_eq!(rows[1].filename.as_deref(), Some("report.pdf"));
        assert!(!rows[1].is_inline);
        assert!(rows[1].content_id.is_none());
    }

    #[tokio::test]
    async fn upsert_is_idempotent_and_replaces_set() {
        let tmp = tempfile::tempdir().unwrap();
        let pool = crate::db::init_db(tmp.path()).await.unwrap();
        seed_account(&pool, "a1").await;
        seed_message(&pool, "a1", "t1", "m1").await;

        upsert_attachments(&pool, "a1", "m1", &[att("1", "a.bin", "x/y", 1, None, false)])
            .await
            .unwrap();
        // Re-upsert with a DIFFERENT set — old row must be replaced.
        upsert_attachments(
            &pool,
            "a1",
            "m1",
            &[att("2", "b.bin", "x/y", 2, None, false)],
        )
        .await
        .unwrap();

        let rows = get_attachments(&pool, "a1", "m1").await.unwrap();
        assert_eq!(rows.len(), 1, "old attachment must be replaced");
        assert_eq!(rows[0].filename.as_deref(), Some("b.bin"));
    }

    #[tokio::test]
    async fn upsert_empty_clears_the_set() {
        let tmp = tempfile::tempdir().unwrap();
        let pool = crate::db::init_db(tmp.path()).await.unwrap();
        seed_account(&pool, "a1").await;
        seed_message(&pool, "a1", "t1", "m1").await;
        upsert_attachments(&pool, "a1", "m1", &[att("1", "a", "x", 1, None, false)])
            .await
            .unwrap();
        upsert_attachments(&pool, "a1", "m1", &[]).await.unwrap();
        assert!(get_attachments(&pool, "a1", "m1").await.unwrap().is_empty());
    }

    #[tokio::test]
    async fn get_isolates_by_account_and_message() {
        let tmp = tempfile::tempdir().unwrap();
        let pool = crate::db::init_db(tmp.path()).await.unwrap();
        seed_account(&pool, "a1").await;
        seed_account(&pool, "a2").await;
        seed_message(&pool, "a1", "t1", "m1").await;
        seed_message(&pool, "a2", "t1", "m1").await;
        upsert_attachments(&pool, "a1", "m1", &[att("1", "a1f", "x", 1, None, false)])
            .await
            .unwrap();
        upsert_attachments(&pool, "a2", "m1", &[att("1", "a2f", "x", 1, None, false)])
            .await
            .unwrap();
        let a1 = get_attachments(&pool, "a1", "m1").await.unwrap();
        assert_eq!(a1.len(), 1);
        assert_eq!(a1[0].filename.as_deref(), Some("a1f"));
        assert!(get_attachments(&pool, "a1", "nope").await.unwrap().is_empty());
    }
}
