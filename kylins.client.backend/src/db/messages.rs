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

use crate::sync_engine::{FlagUpdate, FolderDelta, RemoteMessage};

/// Number of messages persisted per transaction inside `apply_folder_delta`.
/// Each chunk is a separate BEGIN→upsert*N→COMMIT so the SQLite write-lock is
/// released frequently: a single transaction holding the writer for several
/// seconds (a 13k-message folder = ~40k statements) trips `busy_timeout` on
/// any contending writer and returns spurious SQLITE_BUSY. With chunks of 200
/// each transaction runs <1-2s, shrinking the contention window to the point
/// where the 30s busy_timeout is effectively never hit.
const APPLY_BATCH_SIZE: usize = 200;

#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AppliedCounts {
    pub added: u64,
    pub updated: u64,
    pub deleted: u64,
}

/// Apply a folder delta for `label_id` (the labels.id) / `folder_path` (the IMAP path,
/// used for the UIDVALIDITY wipe and the `imap_folder` column).
///
/// Transactions are committed in short batches (see `APPLY_BATCH_SIZE`) so no
/// single write transaction spans the whole folder — that previously held the
/// SQLite writer lock for 4-6+ seconds on large folders and caused spurious
/// `SQLITE_BUSY` (code 5) under any concurrent writer. Idempotent via
/// `ON CONFLICT` on every upsert, so a partial failure (one batch errors) is
/// safe to retry next round: already-applied rows are no-ops, the engine's
/// retry re-runs the same delta.
pub async fn apply_folder_delta(
    pool: &SqlitePool,
    account_id: &str,
    label_id: &str,
    folder_path: &str,
    delta: &FolderDelta,
) -> Result<AppliedCounts, String> {
    // 1. UIDVALIDITY wipe — its OWN transaction, run first and alone. It must
    //    commit before any adds so the fresh rows aren't swept by the orphan
    //    query below.
    if delta.uidvalidity_changed {
        let mut tx = pool.begin().await.map_err(|e| e.to_string())?;
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
        tx.commit().await.map_err(|e| e.to_string())?;
    }

    // 2. added + updated — process in chunks; each chunk its own transaction.
    //    `added` and `updated` go through the same `upsert_message` path, so
    //    we concat references and batch them together (the per-message
    //    write-lock check inside upsert_message makes ordering irrelevant
    //    across the two slices).
    let total_upserts = delta.added.len() + delta.updated.len();
    let mut upsert_idx = 0usize;
    while upsert_idx < total_upserts {
        let mut tx = pool.begin().await.map_err(|e| e.to_string())?;
        let chunk_end = (upsert_idx + APPLY_BATCH_SIZE).min(total_upserts);
        for i in upsert_idx..chunk_end {
            // Index into `added` first, then `updated`. Both branches borrow
            // the same `&RemoteMessage` so the loop body is identical.
            let m: &RemoteMessage = if i < delta.added.len() {
                &delta.added[i]
            } else {
                &delta.updated[i - delta.added.len()]
            };
            upsert_message(&mut tx, account_id, label_id, m).await?;
        }
        tx.commit().await.map_err(|e| e.to_string())?;
        upsert_idx = chunk_end;
    }

    // 3. vanished_uids deletes — own transaction (batched internally if huge,
    //    but usually small). Each uid deletes its message + body row.
    let mut deleted = 0u64;
    if !delta.vanished_uids.is_empty() {
        let mut van_idx = 0usize;
        while van_idx < delta.vanished_uids.len() {
            let mut tx = pool.begin().await.map_err(|e| e.to_string())?;
            let chunk_end = (van_idx + APPLY_BATCH_SIZE).min(delta.vanished_uids.len());
            for u in &delta.vanished_uids[van_idx..chunk_end] {
                let id = format!("imap-{account_id}-{folder_path}-{u}");
                let res = sqlx::query("DELETE FROM messages WHERE id = ?")
                    .bind(&id)
                    .execute(&mut *tx)
                    .await
                    .map_err(|e| e.to_string())?;
                deleted += res.rows_affected();
                sqlx::query("DELETE FROM message_bodies WHERE message_id = ?")
                    .bind(&id)
                    .execute(&mut *tx)
                    .await
                    .map_err(|e| e.to_string())?;
            }
            tx.commit().await.map_err(|e| e.to_string())?;
            van_idx = chunk_end;
        }

        // Sweep threads left orphaned by the deletions (mirrors the wipe block).
        // Run ONCE after all delete batches — its own short transaction.
        let mut tx = pool.begin().await.map_err(|e| e.to_string())?;
        sqlx::query(
            "DELETE FROM threads WHERE account_id = ? AND id NOT IN \
             (SELECT thread_id FROM messages WHERE account_id = ?)",
        )
        .bind(account_id)
        .bind(account_id)
        .execute(&mut *tx)
        .await
        .map_err(|e| e.to_string())?;
        tx.commit().await.map_err(|e| e.to_string())?;
    }

    // 4. Flag updates run AFTER commit so they see the just-added rows (a
    //    message can be added and flag-changed in the same round). Unchanged —
    //    it runs its own per-message statements outside any explicit tx.
    let flagged = apply_flag_updates(pool, account_id, folder_path, &delta.flag_updates).await?;

    Ok(AppliedCounts {
        added: delta.added.len() as u64,
        updated: delta.updated.len() as u64 + flagged,
        deleted,
    })
}

/// Apply CONDSTORE flag-only deltas: update is_read/is_starred on `messages` and mirror
/// to the owning `threads`. Touches NOTHING else (no subject/from/body clobber). Honors
/// the 24-hr write-lock: a message with a pending local op is skipped.
pub async fn apply_flag_updates(
    pool: &SqlitePool,
    account_id: &str,
    folder_path: &str,
    updates: &[FlagUpdate],
) -> Result<u64, String> {
    let mut applied = 0u64;
    for u in updates {
        let message_id = format!("imap-{account_id}-{folder_path}-{}", u.uid);
        let locked: (i64,) = sqlx::query_as(
            "SELECT COUNT(*) FROM pending_operations \
             WHERE account_id = ? AND resource_id = ? AND status = 'pending'",
        )
        .bind(account_id)
        .bind(&message_id)
        .fetch_one(pool)
        .await
        .map_err(|e| e.to_string())?;
        if locked.0 > 0 {
            continue; // local edit pending — don't let the server delta revert it
        }
        let is_read: i64 = if u.is_read { 1 } else { 0 };
        let is_starred: i64 = if u.is_starred { 1 } else { 0 };
        let res = sqlx::query(
            "UPDATE messages SET is_read = ?, is_starred = ? \
             WHERE account_id = ? AND imap_folder = ? AND imap_uid = ?",
        )
        .bind(is_read)
        .bind(is_starred)
        .bind(account_id)
        .bind(folder_path)
        .bind(u.uid as i64)
        .execute(pool)
        .await
        .map_err(|e| e.to_string())?;
        if res.rows_affected() > 0 {
            applied += 1;
            // Mirror to the thread (Phase 0 threading: thread id == message id).
            sqlx::query("UPDATE threads SET is_read = ?, is_starred = ? WHERE id = ?")
                .bind(is_read)
                .bind(is_starred)
                .bind(&message_id)
                .execute(pool)
                .await
                .map_err(|e| e.to_string())?;
        }
    }
    Ok(applied)
}

/// Look up the `(imap_folder, imap_uid)` location of a message so the sync
/// engine can fetch its body on demand. Returns `None` if the row is missing or
/// its UID/folder are NULL (non-IMAP sources, partially-migrated rows). Used by
/// `sync_engine::commands::sync_request_bodies` to translate a frontend
/// `message_id` into the IMAP coordinates `MailSource::fetch_body` needs.
pub async fn get_folder_uid_for_message(
    pool: &SqlitePool,
    account_id: &str,
    message_id: &str,
) -> Result<Option<(String, u32)>, String> {
    let row: Option<(Option<String>, Option<i64>)> = sqlx::query_as(
        "SELECT imap_folder, imap_uid FROM messages WHERE account_id = ? AND id = ?",
    )
    .bind(account_id)
    .bind(message_id)
    .fetch_optional(pool)
    .await
    .map_err(|e| e.to_string())?;
    Ok(row
        .and_then(|(folder, uid)| folder.zip(uid.and_then(|u| u32::try_from(u).ok()))))
}

/// Write the derived preview snippet onto ONE message AND its owning thread
/// (Phase 0: thread id == message id, but the write is by `thread_id` so it
/// stays correct when real conversation threading lands). One transaction so
/// the two writes are atomic — mirrors how `apply_flag_updates` mirrors flag
/// changes to the thread so `db_get_threads` sees them without a re-sync.
///
/// Returns `Ok(())` even if the message row is missing (no-op in that case):
/// `request_bodies_inner` is best-effort per message, and a vanishing row
/// (expunged between the UID lookup and the body write) must not abort the
/// surrounding batch.
pub async fn set_message_snippet(
    pool: &SqlitePool,
    account_id: &str,
    message_id: &str,
    snippet: &str,
) -> Result<(), String> {
    let mut tx = pool.begin().await.map_err(|e| format!("begin tx: {e}"))?;
    // UPDATE ... RETURNING (SELECT thread_id ...) reads the owning thread in
    // the SAME statement so we don't need a second query (and the read sees
    // the row inside this transaction). Returns None when no row matched.
    let thread_id: Option<String> = sqlx::query_scalar(
        "UPDATE messages SET snippet = ? WHERE account_id = ? AND id = ? \
         RETURNING (SELECT thread_id FROM messages WHERE account_id = ? AND id = ?)",
    )
    .bind(snippet)
    .bind(account_id)
    .bind(message_id)
    .bind(account_id)
    .bind(message_id)
    .fetch_optional(&mut *tx)
    .await
    .map_err(|e| e.to_string())?;
    if let Some(tid) = thread_id {
        sqlx::query("UPDATE threads SET snippet = ? WHERE account_id = ? AND id = ?")
            .bind(snippet)
            .bind(account_id)
            .bind(tid)
            .execute(&mut *tx)
            .await
            .map_err(|e| e.to_string())?;
    }
    tx.commit().await.map_err(|e| e.to_string())?;
    Ok(())
}

/// Resolve the `thread_id` for a message — used by `request_bodies_inner` to
/// build the `BodiesWrittenEvent` payload so the frontend can patch the right
/// `thread.snippet` without a second query. Returns `None` when the row is
/// missing or its `thread_id` is NULL (non-IMAP sources, partial migrations).
pub async fn get_thread_id_for_message(
    pool: &SqlitePool,
    account_id: &str,
    message_id: &str,
) -> Result<Option<String>, String> {
    let row: Option<(Option<String>,)> = sqlx::query_as(
        "SELECT thread_id FROM messages WHERE account_id = ? AND id = ?",
    )
    .bind(account_id)
    .bind(message_id)
    .fetch_optional(pool)
    .await
    .map_err(|e| e.to_string())?;
    Ok(row.and_then(|(t,)| t))
}

/// UIDs we currently have cached for (account, folder). Used by the expunge
/// set-difference (server `UID SEARCH ALL` minus this set = vanished). Rows with
/// NULL `imap_uid` (non-IMAP sources, partially-migrated rows) are filtered out;
/// the remaining i64 values are cast to u32 (IMAP UIDs are 32-bit).
pub async fn list_local_uids(
    pool: &SqlitePool,
    account_id: &str,
    folder_path: &str,
) -> Result<Vec<u32>, String> {
    let rows: Vec<(Option<i64>,)> = sqlx::query_as(
        "SELECT imap_uid FROM messages WHERE account_id = ? AND imap_folder = ?",
    )
    .bind(account_id)
    .bind(folder_path)
    .fetch_all(pool)
    .await
    .map_err(|e| e.to_string())?;
    Ok(rows
        .into_iter()
        .filter_map(|(u,)| u.map(|x| x as u32))
        .collect())
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

    // Write-lock (24-hr guarantee): if a local mutation for this exact
    // resource is still pending replay, skip the upsert so the server delta
    // cannot revert the local edit. The check runs inside this transaction
    // (against `&mut **tx`) so the lock decision is consistent with the writes
    // that follow. `resource_id` matches what `sync_apply_mutation` enqueues —
    // the frontend-sent message id, which is the same `imap-{a}-{f}-{uid}`.
    let locked: (i64,) = sqlx::query_as(
        "SELECT COUNT(*) FROM pending_operations
         WHERE account_id = ? AND resource_id = ? AND status = 'pending'",
    )
    .bind(account_id)
    .bind(&message_id)
    .fetch_one(&mut **tx)
    .await
    .map_err(|e| e.to_string())?;
    if locked.0 > 0 {
        return Ok(());
    }

    // RFC 2822 Message-ID header (for JWZ threading). Fall back to a synthetic
    // deterministic ID when the server sent no header (drafts, calendar items, etc.).
    let rfc2822_message_id = m.message_id.clone().unwrap_or_else(|| {
        format!(
            "synthetic-{}-{}-{}@kylins.local",
            account_id, m.folder, m.uid
        )
    });
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
    use crate::sync_engine::{Cursor, FlagUpdate, RemoteMessage};

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
            flag_updates: vec![],
            vanished_uids: vec![],
            next_cursor: Cursor::initial_imap(),
            uidvalidity_changed: false,
        };
        let counts = apply_folder_delta(&pool, "acc", "acc:INBOX", "INBOX", &delta)
            .await
            .unwrap();
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
        apply_folder_delta(&pool, "acc", "acc:INBOX", "INBOX", &delta)
            .await
            .unwrap();
        apply_folder_delta(&pool, "acc", "acc:INBOX", "INBOX", &delta)
            .await
            .unwrap();
        assert_eq!(count(&pool, "messages").await, 1);
        assert_eq!(count(&pool, "threads").await, 1);
    }

    /// Write-lock: when a message has a pending local mutation in
    /// `pending_operations`, an incoming server delta for the same
    /// `imap-{account}-{folder}-{uid}` resource_id must NOT overwrite the
    /// locally-edited row. This is the "24-hr lock" guarantee — the local edit
    /// survives until the op is replayed.
    #[tokio::test]
    async fn write_lock_skips_upsert_when_pending_op_exists() {
        let tmp = tempfile::tempdir().unwrap();
        let pool = init_db(tmp.path()).await.unwrap();
        seed(&pool, "acc").await;

        // 1. Seed an existing server message (is_read = false).
        let seed_delta = FolderDelta {
            added: vec![msg(7, "<m7>", false)],
            ..Default::default()
        };
        apply_folder_delta(&pool, "acc", "acc:INBOX", "INBOX", &seed_delta)
            .await
            .unwrap();

        // 2. Apply the local edit directly: flip is_read to true on the row.
        //    The frontend would have done this through sync_apply_mutation and
        //    also enqueued a pending op with resource_id = the message id.
        let message_id = "imap-acc-INBOX-7";
        sqlx::query("UPDATE messages SET is_read = 1 WHERE id = ?")
            .bind(message_id)
            .execute(&pool)
            .await
            .unwrap();
        sqlx::query(
            "INSERT INTO pending_operations
                (id, account_id, operation_type, resource_id, params, status, created_at)
             VALUES ('p1','acc','markRead',?,'{\"read\":true}','pending',1)",
        )
        .bind(message_id)
        .execute(&pool)
        .await
        .unwrap();

        // 3. Server delta arrives claiming is_read = false. The write-lock must
        //    skip this upsert so the pending local edit (is_read = true) wins.
        let server_delta = FolderDelta {
            updated: vec![msg(7, "<m7>", false)], // server says still unread
            ..Default::default()
        };
        apply_folder_delta(&pool, "acc", "acc:INBOX", "INBOX", &server_delta)
            .await
            .unwrap();

        let (is_read,): (i64,) = sqlx::query_as("SELECT is_read FROM messages WHERE id = ?")
            .bind(message_id)
            .fetch_one(&pool)
            .await
            .unwrap();
        assert_eq!(
            is_read, 1,
            "local edit must survive server delta while op is pending"
        );
    }

    #[tokio::test]
    async fn uidvalidity_change_wipes_folder_messages() {
        let tmp = tempfile::tempdir().unwrap();
        let pool = init_db(tmp.path()).await.unwrap();
        seed(&pool, "acc").await;
        let seed = FolderDelta {
            added: vec![msg(1, "<m1>", false), msg(2, "<m2>", false)],
            ..Default::default()
        };
        apply_folder_delta(&pool, "acc", "acc:INBOX", "INBOX", &seed)
            .await
            .unwrap();
        assert_eq!(count(&pool, "messages").await, 2);
        // UIDVALIDITY changed -> wipe, then add one fresh.
        let wipe = FolderDelta {
            added: vec![msg(1, "<m1new>", false)],
            uidvalidity_changed: true,
            ..Default::default()
        };
        apply_folder_delta(&pool, "acc", "acc:INBOX", "INBOX", &wipe)
            .await
            .unwrap();
        assert_eq!(count(&pool, "messages").await, 1);
        assert_eq!(count(&pool, "threads").await, 1);
    }

    // ---- get_folder_uid_for_message (on-demand body fetch helper) ----

    /// Seed one thread + one message row with explicit `(imap_folder, imap_uid)`
    /// columns so the lookup helper has realistic data to read.
    async fn seed_message_with_location(
        pool: &sqlx::SqlitePool,
        account_id: &str,
        message_id: &str,
        folder: &str,
        uid: u32,
    ) {
        sqlx::query(
            "INSERT INTO threads (id, account_id, subject, is_read, last_message_at)
             VALUES (?, ?, 's', 0, 0)",
        )
        .bind(message_id)
        .bind(account_id)
        .execute(pool)
        .await
        .unwrap();
        sqlx::query(
            "INSERT INTO messages (id, account_id, thread_id, date, is_read, is_starred,
                imap_uid, imap_folder)
             VALUES (?, ?, ?, 0, 0, 0, ?, ?)",
        )
        .bind(message_id)
        .bind(account_id)
        .bind(message_id)
        .bind(uid as i64)
        .bind(folder)
        .execute(pool)
        .await
        .unwrap();
    }

    #[tokio::test]
    async fn get_folder_uid_returns_location_for_seeded_message() {
        let tmp = tempfile::tempdir().unwrap();
        let pool = init_db(tmp.path()).await.unwrap();
        seed(&pool, "acc").await;
        seed_message_with_location(&pool, "acc", "imap-acc-INBOX-42", "INBOX", 42).await;

        let loc = get_folder_uid_for_message(&pool, "acc", "imap-acc-INBOX-42")
            .await
            .unwrap();
        assert_eq!(loc, Some(("INBOX".to_string(), 42)));
    }

    #[tokio::test]
    async fn get_folder_uid_returns_none_for_missing_message() {
        let tmp = tempfile::tempdir().unwrap();
        let pool = init_db(tmp.path()).await.unwrap();
        seed(&pool, "acc").await;
        assert!(get_folder_uid_for_message(&pool, "acc", "no-such-id")
            .await
            .unwrap()
            .is_none());
    }

    #[tokio::test]
    async fn get_folder_uid_isolates_by_account() {
        let tmp = tempfile::tempdir().unwrap();
        let pool = init_db(tmp.path()).await.unwrap();
        seed(&pool, "a1").await;
        seed(&pool, "a2").await;
        seed_message_with_location(&pool, "a1", "shared-id", "INBOX", 7).await;
        // Same message id under a different account must not be visible.
        assert_eq!(
            get_folder_uid_for_message(&pool, "a2", "shared-id")
                .await
                .unwrap(),
            None,
            "lookup must be scoped by account_id"
        );
    }

    // ---- set_message_snippet + get_thread_id_for_message (Task 2 body write-back) ----

    /// `set_message_snippet` must write `messages.snippet` AND mirror the value
    /// onto the owning `threads.snippet` in the same transaction, so
    /// `db_get_threads` reflects the new preview without a re-sync. Phase 0
    /// threading: thread id == message id, but the write is by `thread_id` so
    /// it stays correct under future conversation threading.
    #[tokio::test]
    async fn set_message_snippet_updates_column_and_thread_row() {
        let tmp = tempfile::tempdir().unwrap();
        let pool = init_db(tmp.path()).await.unwrap();
        seed(&pool, "acc").await;
        seed_message_with_location(&pool, "acc", "imap-acc-INBOX-7", "INBOX", 7).await;
        // thread_id == message_id in Phase 0; null the thread row's snippet so
        // the mirror write is observable (otherwise the seed already wrote NULL
        // and we couldn't distinguish "no-op" from "wrote the value").
        sqlx::query("UPDATE threads SET snippet = NULL WHERE id = 'imap-acc-INBOX-7'")
            .execute(&pool)
            .await
            .unwrap();

        set_message_snippet(&pool, "acc", "imap-acc-INBOX-7", "Hello world")
            .await
            .unwrap();

        let (msg_snip, thr_snip): (Option<String>, Option<String>) = sqlx::query_as(
            "SELECT m.snippet, t.snippet
             FROM messages m LEFT JOIN threads t ON t.id = m.thread_id
             WHERE m.id = 'imap-acc-INBOX-7'",
        )
        .fetch_one(&pool)
        .await
        .unwrap();
        assert_eq!(msg_snip.as_deref(), Some("Hello world"));
        assert_eq!(
            thr_snip.as_deref(),
            Some("Hello world"),
            "thread row snippet must mirror so db_get_threads sees it without a re-sync"
        );
    }

    /// `get_thread_id_for_message` resolves the owning thread for a message —
    /// used by `request_bodies_inner` to build the `BodiesWrittenEvent`
    /// payload without a second query.
    #[tokio::test]
    async fn get_thread_id_for_message_returns_thread_id() {
        let tmp = tempfile::tempdir().unwrap();
        let pool = init_db(tmp.path()).await.unwrap();
        seed(&pool, "acc").await;
        seed_message_with_location(&pool, "acc", "imap-acc-INBOX-9", "INBOX", 9).await;
        let tid = get_thread_id_for_message(&pool, "acc", "imap-acc-INBOX-9")
            .await
            .unwrap();
        assert_eq!(tid.as_deref(), Some("imap-acc-INBOX-9"));
    }

    // ---- apply_flag_updates (CONDSTORE flag-only delta) ----

    /// CONDSTORE CHANGEDSINCE returns flag-only deltas. `apply_flag_updates` must
    /// flip `is_read`/`is_starred` on both `messages` and the owning `thread`
    /// (Phase 0: thread id == message id) WITHOUT touching subject/from/body —
    /// otherwise the cached envelope is clobbered by a FLAGS-only FETCH.
    #[tokio::test]
    async fn apply_flag_updates_changes_only_flags_not_envelope() {
        let tmp = tempfile::tempdir().unwrap();
        let pool = init_db(tmp.path()).await.unwrap();
        seed(&pool, "acc").await;
        // Seed a message with a known subject + is_read=false.
        let delta = FolderDelta {
            added: vec![RemoteMessage {
                uid: 7,
                folder: "INBOX".into(),
                subject: Some("Original Subject".into()),
                from_address: Some("a@b".into()),
                body_html: Some("<p>x</p>".into()),
                ..Default::default()
            }],
            ..Default::default()
        };
        apply_folder_delta(&pool, "acc", "acc:INBOX", "INBOX", &delta)
            .await
            .unwrap();

        // CONDSTORE says: uid 7 now read + starred. apply_flag_updates must flip flags
        // but leave subject/from/body untouched.
        let n = apply_flag_updates(
            &pool,
            "acc",
            "INBOX",
            &[FlagUpdate {
                uid: 7,
                is_read: true,
                is_starred: true,
            }],
        )
        .await
        .unwrap();
        assert_eq!(n, 1);

        let (is_read, is_starred, subject, body): (i64, i64, Option<String>, Option<String>) =
            sqlx::query_as(
                "SELECT is_read, is_starred, subject, \
                 (SELECT body_html FROM message_bodies WHERE message_id = messages.id) \
                 FROM messages WHERE account_id='acc' AND imap_folder='INBOX' AND imap_uid=7",
            )
            .fetch_one(&pool)
            .await
            .unwrap();
        assert_eq!(is_read, 1);
        assert_eq!(is_starred, 1);
        assert_eq!(
            subject.as_deref(),
            Some("Original Subject"),
            "subject must not be clobbered"
        );
        assert_eq!(
            body.as_deref(),
            Some("<p>x</p>"),
            "body must not be clobbered"
        );
    }

    // ---- list_local_uids (expunge set-difference input) ----

    /// `list_local_uids` returns the `imap_uid` values we currently have cached
    /// for (account, folder). It is the local half of the expunge set-diff
    /// (server `UID SEARCH ALL` minus this set = vanished). Rows with NULL
    /// `imap_uid` (non-IMAP sources, partial migrations) are filtered out.
    #[tokio::test]
    async fn list_local_uids_returns_cached_uids_for_folder() {
        let tmp = tempfile::tempdir().unwrap();
        let pool = init_db(tmp.path()).await.unwrap();
        seed(&pool, "acc").await;
        apply_folder_delta(
            &pool,
            "acc",
            "acc:INBOX",
            "INBOX",
            &FolderDelta {
                added: vec![
                    msg(1, "<m1>", false),
                    msg(2, "<m2>", false),
                    msg(9, "<m9>", false),
                ],
                ..Default::default()
            },
        )
        .await
        .unwrap();
        let mut uids = list_local_uids(&pool, "acc", "INBOX").await.unwrap();
        uids.sort();
        assert_eq!(uids, vec![1, 2, 9]);
    }

    /// VANISHED (QRESYNC) — server expunged the UIDs listed in `vanished_uids`.
    /// `apply_folder_delta` must delete the matching `messages` rows (+ their
    /// `message_bodies`) and sweep orphan threads, NOT just count them.
    #[tokio::test]
    async fn apply_folder_delta_deletes_vanished_uids() {
        let tmp = tempfile::tempdir().unwrap();
        let pool = init_db(tmp.path()).await.unwrap();
        seed(&pool, "acc").await;
        let seed = FolderDelta {
            added: vec![msg(1, "<m1>", false), msg(2, "<m2>", false), msg(3, "<m3>", false)],
            ..Default::default()
        };
        apply_folder_delta(&pool, "acc", "acc:INBOX", "INBOX", &seed)
            .await
            .unwrap();
        assert_eq!(count(&pool, "messages").await, 3);

        // Server expunged uid 2.
        let delta = FolderDelta {
            vanished_uids: vec![2],
            ..Default::default()
        };
        apply_folder_delta(&pool, "acc", "acc:INBOX", "INBOX", &delta)
            .await
            .unwrap();
        assert_eq!(count(&pool, "messages").await, 2, "uid 2 must be deleted");
        let remaining: Vec<(i64,)> = sqlx::query_as(
            "SELECT imap_uid FROM messages WHERE account_id='acc' AND imap_folder='INBOX' ORDER BY imap_uid",
        )
        .fetch_all(&pool)
        .await
        .unwrap();
        let uids: Vec<i64> = remaining.into_iter().map(|(u,)| u).collect();
        assert_eq!(uids, vec![1, 3]);
    }

    // ---- apply_folder_delta batching (regression for SQLITE_BUSY) ----

    /// Regression: large-folder apply must NOT run one giant transaction. The
    /// pre-fix code opened ONE tx, looped all `added`, and committed at the
    /// end; for Deleted Items (≈13k messages) that held the SQLite writer lock
    /// for several seconds and any contending writer gave up after
    /// `busy_timeout` (then 5s) → `database is locked` (code 5).
    ///
    /// This test seeds >APPLY_BATCH_SIZE (250 > 200) added messages via
    /// `apply_folder_delta` and asserts that (a) all 250 land — i.e. the
    /// chunked commits actually persisted each batch and did not roll back the
    /// earlier ones when the later chunk committed — and (b) the
    /// `AppliedCounts.added` reflects the total. A bonus check: thread_labels
    /// + threads also reflect the full count, proving the per-message upsert
    /// ran to completion inside each batch.
    #[tokio::test]
    async fn apply_folder_delta_batches_large_added_set() {
        let tmp = tempfile::tempdir().unwrap();
        let pool = init_db(tmp.path()).await.unwrap();
        seed(&pool, "acc").await;

        // 250 messages: more than APPLY_BATCH_SIZE (200) so we exercise the
        // 2-chunk path (200 + 50).
        let added: Vec<RemoteMessage> = (1..=250)
            .map(|uid| msg(uid, &format!("<m{uid}>"), true))
            .collect();
        let delta = FolderDelta {
            added,
            ..Default::default()
        };

        let counts = apply_folder_delta(&pool, "acc", "acc:INBOX", "INBOX", &delta)
            .await
            .unwrap();

        assert_eq!(counts.added, 250, "AppliedCounts must reflect the total");
        assert_eq!(
            count(&pool, "messages").await,
            250,
            "every batch must commit; partial rollback would leak rows"
        );
        assert_eq!(
            count(&pool, "threads").await,
            250,
            "one placeholder thread per message"
        );
        assert_eq!(
            count(&pool, "thread_labels").await,
            250,
            "thread_labels written inside the same chunked tx"
        );
        assert_eq!(
            count(&pool, "message_bodies").await,
            250,
            "every seeded msg had body_html — bodies must persist too"
        );

        // Spot-check a row from the SECOND chunk (uid 225 > 200) to prove the
        // later batch landed and didn't get dropped at the boundary.
        let (subject,): (Option<String>,) =
            sqlx::query_as("SELECT subject FROM messages WHERE account_id='acc' AND imap_uid=225")
                .fetch_one(&pool)
                .await
                .unwrap();
        assert_eq!(subject.as_deref(), Some("S225"));
    }

    /// Cross-check: batching must also compose `added` + `updated` across the
    /// chunk boundary (the loop concatenates the two slices). Seed 200 `added`
    /// + 5 `updated` (205 total > 200) and confirm both slices land.
    #[tokio::test]
    async fn apply_folder_delta_batches_combined_added_and_updated() {
        let tmp = tempfile::tempdir().unwrap();
        let pool = init_db(tmp.path()).await.unwrap();
        seed(&pool, "acc").await;

        let added: Vec<RemoteMessage> = (1..=200)
            .map(|uid| msg(uid, &format!("<m{uid}>"), false))
            .collect();
        let updated: Vec<RemoteMessage> = (201..=205)
            .map(|uid| msg(uid, &format!("<m{uid}>"), false))
            .collect();
        let delta = FolderDelta {
            added,
            updated,
            ..Default::default()
        };

        let counts = apply_folder_delta(&pool, "acc", "acc:INBOX", "INBOX", &delta)
            .await
            .unwrap();

        assert_eq!(counts.added, 200);
        assert_eq!(counts.updated, 5); // 5 updated upserts + 0 flag_updates
        assert_eq!(count(&pool, "messages").await, 205);
    }
}
