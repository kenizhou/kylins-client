// apply_folder_delta — persists a MailSource::sync_folder result into threads +
// messages + thread_labels + message_bodies, in one transaction. This is the Rust
// successor to the frontend `upsertImapMessages` (deleted in Task 5), plus the
// UIDVALIDITY-change wipe path.
//
// Threading is intentionally minimal in Phase 0: one thread per message (thread id =
// Message-Id header, or a generated uuid). Real conversation grouping by
// References/In-Reply-To is a follow-up (the TS had the same TODO).

use serde::Serialize;
use sqlx::{SqlitePool, Transaction};

use crate::sync_engine::{FolderDelta, RemoteMessage};

#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AppliedCounts {
    pub added: u64,
    pub updated: u64,
    pub deleted: u64,
}

/// Apply a folder delta for `label_id` (the labels.id) / `folder_path` (the IMAP path,
/// used for the UIDVALIDITY wipe and the `imap_folder` column).
pub async fn apply_folder_delta(
    pool: &SqlitePool,
    account_id: &str,
    label_id: &str,
    folder_path: &str,
    delta: &FolderDelta,
) -> Result<AppliedCounts, String> {
    let mut tx = pool.begin().await.map_err(|e| e.to_string())?;

    if delta.uidvalidity_changed {
        // The server rebuilt the folder (UIDVALIDITY changed): drop every message we
        // stored for it, plus any threads left orphaned. Cascade handles thread_labels
        // (FK to threads) once the threads are gone.
        sqlx::query("DELETE FROM messages WHERE account_id = ? AND imap_folder = ?")
            .bind(account_id)
            .bind(folder_path)
            .execute(&mut *tx)
            .await
            .map_err(|e| e.to_string())?;
        sqlx::query(
            "DELETE FROM threads WHERE account_id = ? AND id NOT IN \
             (SELECT thread_id FROM messages WHERE account_id = ?)",
        )
        .bind(account_id)
        .bind(account_id)
        .execute(&mut *tx)
        .await
        .map_err(|e| e.to_string())?;
    }

    for m in &delta.added {
        upsert_message(&mut tx, account_id, label_id, m).await?;
    }
    for m in &delta.updated {
        upsert_message(&mut tx, account_id, label_id, m).await?;
    }
    // vanished_uids: Phase 0 does not yet expunge locally (no CONDSTORE VANISHED). The
    // deleted count is reported for events; actual local deletion arrives with QRESYNC.
    tx.commit().await.map_err(|e| e.to_string())?;

    Ok(AppliedCounts {
        added: delta.added.len() as u64,
        updated: delta.updated.len() as u64,
        deleted: delta.vanished_uids.len() as u64,
    })
}

/// Upsert one message + its (placeholder) thread + thread_label + optional body.
async fn upsert_message(
    tx: &mut Transaction<'_, sqlx::Sqlite>,
    account_id: &str,
    label_id: &str,
    m: &RemoteMessage,
) -> Result<(), String> {
    // Stable PK: imap-{account}-{folder}-{uid} (Velo pattern — IMAP identity is UID+folder,
    // not Message-ID header, which calendar items and server notifications lack).
    let message_id = format!("imap-{}-{}-{}", account_id, m.folder, m.uid);

    // RFC 2822 Message-ID header (for JWZ threading). Fall back to a synthetic
    // deterministic ID when the server sent no header (drafts, calendar items, etc.).
    let rfc2822_message_id = m
        .message_id
        .clone()
        .unwrap_or_else(|| format!("synthetic-{}-{}-{}@kylins.local", account_id, m.folder, m.uid));
    let has_attachments: i64 = if m.has_attachments { 1 } else { 0 };
    let is_read: i64 = if m.is_read { 1 } else { 0 };
    let is_starred: i64 = if m.is_starred { 1 } else { 0 };
    let body_cached: i64 = if m.body_html.is_some() { 1 } else { 0 };

    // Thread (placeholder: one thread per message).
    sqlx::query(
        "INSERT INTO threads (id, account_id, subject, snippet, last_message_at, message_count,
            is_read, is_starred, is_important, has_attachments, is_snoozed, from_name, from_address,
            classification_id, is_encrypted, is_signed)
         VALUES (?, ?, ?, ?, ?, 1, ?, ?, 0, ?, 0, ?, ?, NULL, 0, 0)
         ON CONFLICT(account_id, id) DO UPDATE SET
           subject = excluded.subject, snippet = excluded.snippet,
           last_message_at = excluded.last_message_at, message_count = excluded.message_count,
           is_read = excluded.is_read, is_starred = excluded.is_starred,
           is_important = excluded.is_important, has_attachments = excluded.has_attachments,
           from_name = excluded.from_name, from_address = excluded.from_address",
    )
    .bind(&message_id)
    .bind(account_id)
    .bind(&m.subject)
    .bind(&m.snippet)
    .bind(m.date)
    .bind(is_read)
    .bind(is_starred)
    .bind(has_attachments)
    .bind(&m.from_name)
    .bind(&m.from_address)
    .execute(&mut **tx)
    .await
    .map_err(|e| e.to_string())?;

    // Message.
    sqlx::query(
        "INSERT INTO messages (id, account_id, thread_id, from_address, from_name, to_addresses,
            cc_addresses, bcc_addresses, reply_to, subject, snippet, date, is_read, is_starred,
            body_text, body_cached, raw_size, message_id_header, in_reply_to_header,
            references_header, list_unsubscribe, list_unsubscribe_post, auth_results,
            imap_uid, imap_folder, classification_id, is_encrypted, is_signed)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, 0, 0)
         ON CONFLICT(account_id, id) DO UPDATE SET
           from_address = excluded.from_address, from_name = excluded.from_name,
           to_addresses = excluded.to_addresses, cc_addresses = excluded.cc_addresses,
           bcc_addresses = excluded.bcc_addresses, reply_to = excluded.reply_to,
           subject = excluded.subject, snippet = excluded.snippet, date = excluded.date,
           is_read = excluded.is_read, is_starred = excluded.is_starred,
           body_text = excluded.body_text, raw_size = excluded.raw_size,
           message_id_header = excluded.message_id_header,
           imap_uid = excluded.imap_uid, imap_folder = excluded.imap_folder",
    )
    .bind(&message_id)
    .bind(account_id)
    .bind(&message_id)
    .bind(&m.from_address)
    .bind(&m.from_name)
    .bind(&m.to_addresses)
    .bind(&m.cc_addresses)
    .bind(&m.bcc_addresses)
    .bind(&m.reply_to)
    .bind(&m.subject)
    .bind(&m.snippet)
    .bind(m.date)
    .bind(is_read)
    .bind(is_starred)
    .bind(&m.body_text)
    .bind(body_cached)
    .bind(m.raw_size as i64)
    .bind(&rfc2822_message_id)
    .bind(&m.in_reply_to)
    .bind(&m.references)
    .bind(&m.list_unsubscribe)
    .bind(&m.list_unsubscribe_post)
    .bind(&m.auth_results)
    .bind(m.uid as i64)
    .bind(&m.folder)
    .execute(&mut **tx)
    .await
    .map_err(|e| e.to_string())?;

    // thread_labels (folder membership). idempotent.
    sqlx::query(
        "INSERT INTO thread_labels (thread_id, account_id, label_id)
         VALUES (?, ?, ?)
         ON CONFLICT(account_id, thread_id, label_id) DO NOTHING",
    )
    .bind(&message_id)
    .bind(account_id)
    .bind(label_id)
    .execute(&mut **tx)
    .await
    .map_err(|e| e.to_string())?;

    // Body (split store; only when present).
    if let Some(html) = &m.body_html {
        sqlx::query(
            "INSERT OR REPLACE INTO message_bodies (account_id, message_id, body_html, fetched_at)
             VALUES (?, ?, ?, unixepoch())",
        )
        .bind(account_id)
        .bind(&message_id)
        .bind(html)
        .execute(&mut **tx)
        .await
        .map_err(|e| e.to_string())?;
    }

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::init_db;
    use crate::sync_engine::{Cursor, RemoteMessage};

    async fn seed(pool: &sqlx::SqlitePool, id: &str) {
        sqlx::query("INSERT INTO accounts (id, email, provider) VALUES (?, ?, 'imap')")
            .bind(id)
            .bind(format!("{id}@x.com"))
            .execute(pool)
            .await
            .unwrap();
    }

    fn msg(uid: u32, mid: &str, html: bool) -> RemoteMessage {
        RemoteMessage {
            uid,
            folder: "INBOX".into(),
            message_id: Some(mid.into()),
            subject: Some(format!("S{uid}")),
            from_address: Some("a@b".into()),
            date: 1000 + uid as i64,
            body_html: if html { Some("<p>x</p>".into()) } else { None },
            ..Default::default()
        }
    }

    async fn count(pool: &sqlx::SqlitePool, table: &str) -> i64 {
        let (n,): (i64,) = sqlx::query_as(&format!("SELECT COUNT(*) FROM {table}"))
            .fetch_one(pool)
            .await
            .unwrap();
        n
    }

    #[tokio::test]
    async fn apply_creates_threads_messages_labels_and_bodies() {
        let tmp = tempfile::tempdir().unwrap();
        let pool = init_db(tmp.path()).await.unwrap();
        seed(&pool, "acc").await;
        let delta = FolderDelta {
            added: vec![msg(1, "<m1>", true), msg(2, "<m2>", false)],
            updated: vec![],
            vanished_uids: vec![],
            next_cursor: Cursor::initial_imap(),
            uidvalidity_changed: false,
        };
        let counts = apply_folder_delta(&pool, "acc", "acc:INBOX", "INBOX", &delta).await.unwrap();
        assert_eq!(counts.added, 2);
        assert_eq!(count(&pool, "threads").await, 2);
        assert_eq!(count(&pool, "messages").await, 2);
        assert_eq!(count(&pool, "thread_labels").await, 2);
        assert_eq!(count(&pool, "message_bodies").await, 1); // only m1 had html
    }

    #[tokio::test]
    async fn apply_is_idempotent_on_resync() {
        let tmp = tempfile::tempdir().unwrap();
        let pool = init_db(tmp.path()).await.unwrap();
        seed(&pool, "acc").await;
        let delta = FolderDelta {
            added: vec![msg(1, "<m1>", false)],
            ..Default::default()
        };
        apply_folder_delta(&pool, "acc", "acc:INBOX", "INBOX", &delta).await.unwrap();
        apply_folder_delta(&pool, "acc", "acc:INBOX", "INBOX", &delta).await.unwrap();
        assert_eq!(count(&pool, "messages").await, 1);
        assert_eq!(count(&pool, "threads").await, 1);
    }

    #[tokio::test]
    async fn uidvalidity_change_wipes_folder_messages() {
        let tmp = tempfile::tempdir().unwrap();
        let pool = init_db(tmp.path()).await.unwrap();
        seed(&pool, "acc").await;
        let seed = FolderDelta { added: vec![msg(1, "<m1>", false), msg(2, "<m2>", false)], ..Default::default() };
        apply_folder_delta(&pool, "acc", "acc:INBOX", "INBOX", &seed).await.unwrap();
        assert_eq!(count(&pool, "messages").await, 2);
        // UIDVALIDITY changed -> wipe, then add one fresh.
        let wipe = FolderDelta {
            added: vec![msg(1, "<m1new>", false)],
            uidvalidity_changed: true,
            ..Default::default()
        };
        apply_folder_delta(&pool, "acc", "acc:INBOX", "INBOX", &wipe).await.unwrap();
        assert_eq!(count(&pool, "messages").await, 1);
        assert_eq!(count(&pool, "threads").await, 1);
    }
}
