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
#[cfg(test)]
use crate::sync_engine::CryptoKind;

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

/// Reconcile `thread_labels` for an account: ensure every message currently in
/// `messages` has a `thread_labels` row linking its thread to its folder's label
/// (`{account_id}:{imap_folder}`). Self-heals any wipe.
///
/// `thread_labels` rows are only ever (re)created by `upsert_message` — for
/// messages upserted *after* the wipe. So a folder whose linkage was deleted
/// (by a `MutationOp::Move`, `delete_folder`/`prune_stale_labels`, or a direct
/// delete) but whose messages were NOT re-upserted stays unlinked forever:
/// `get_threads` does an `INNER JOIN thread_labels`, so it returns an empty
/// message list even though `messages`/`threads` are full. Skip/flag-delta
/// rounds re-upsert nothing, so the empty state never self-corrects. Running
/// this at the tail of every sync round restores linkage regardless of whether
/// the round had deltas. Idempotent (`ON CONFLICT DO NOTHING`); returns the
/// number of rows added.
pub async fn reconcile_thread_labels(pool: &SqlitePool, account_id: &str) -> Result<u64, String> {
    let res = sqlx::query(
        "INSERT INTO thread_labels (thread_id, account_id, label_id)
         SELECT DISTINCT m.thread_id, m.account_id, (m.account_id || ':' || m.imap_folder)
         FROM messages m
         WHERE m.account_id = ?
         ON CONFLICT(account_id, thread_id, label_id) DO NOTHING",
    )
    .bind(account_id)
    .execute(pool)
    .await
    .map_err(|e| e.to_string())?;
    Ok(res.rows_affected())
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

/// Return the subset of `message_ids` whose body is NOT cached
/// (`body_cached = 0`). Used by the viewport prefetch hook to avoid
/// re-requesting bodies the cache already has. Missing message_ids are
/// silently dropped (the prefetch will simply skip them — they were likely
/// expunged between the list render and the prefetch fire).
///
/// Chunks the input at 500 ids per query so the bound parameter count stays
/// well under SQLite's default 999-parameter limit (visible + buffer is ~30,
/// so this is rarely more than one chunk, but the guard is cheap insurance).
pub async fn get_uncached_body_message_ids(
    pool: &SqlitePool,
    account_id: &str,
    message_ids: &[String],
) -> Result<Vec<String>, String> {
    if message_ids.is_empty() {
        return Ok(vec![]);
    }
    let mut out = Vec::new();
    for chunk in message_ids.chunks(500) {
        let placeholders = (0..chunk.len())
            .map(|_| "?")
            .collect::<Vec<_>>()
            .join(",");
        let sql = format!(
            "SELECT id FROM messages \
             WHERE account_id = ? AND id IN ({placeholders}) AND body_cached = 0",
        );
        let mut q = sqlx::query_as::<_, (String,)>(&sql).bind(account_id);
        for id in chunk {
            q = q.bind(id);
        }
        let rows: Vec<(String,)> = q.fetch_all(pool).await.map_err(|e| e.to_string())?;
        out.extend(rows.into_iter().map(|(id,)| id));
    }
    Ok(out)
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
    // Phase 1b S/MIME receive detection: derive the dormant `is_encrypted` /
    // `is_signed` INTEGER flags from `RemoteMessage.crypto_kind` (set by the
    // IMAP source adapter from the top-level Content-Type). `None` means the
    // source didn't detect crypto structure (plain message, or EAS) → both
    // flags stay 0. Bound on BOTH the initial INSERT and the ON CONFLICT
    // UPDATE so a re-sync that detects crypto (e.g. a UIDVALIDITY reset that
    // re-fetches the message after the body changed) re-stamps the flags.
    let (is_encrypted, is_signed) = m
        .crypto_kind
        .map(|k| k.db_flags())
        .unwrap_or((0, 0));
    // `apply_folder_delta` runs ONLY on the headers-only sync path ( sole
    // caller is the SyncEngine at engine.rs ~812), so no real body was
    // fetched — always insert body_cached = 0. The body-fetch path
    // (`message_bodies::set_message_body`) flips this to 1 when a real body
    // lands. Do NOT derive it from `m.body_html`: mail_parser's `body_html(0)`
    // synthesizes `<html><body></body></html>` for a headers-only message, so
    // `m.body_html.is_some()` is true even when no body exists — that lie is
    // what poisoned the cache (29K shell rows marked cached). The ON CONFLICT
    // branch below deliberately does NOT update body_cached, so a real body
    // cached later by the prefetch path survives subsequent re-syncs.
    let body_cached: i64 = 0;

    // Thread (placeholder: one thread per message).
    sqlx::query(
        "INSERT INTO threads (id, account_id, subject, snippet, last_message_at, message_count,
            is_read, is_starred, is_important, has_attachments, is_snoozed, from_name, from_address,
            classification_id, is_encrypted, is_signed)
         VALUES (?, ?, ?, ?, ?, 1, ?, ?, 0, ?, 0, ?, ?, NULL, ?, ?)
         ON CONFLICT(account_id, id) DO UPDATE SET
           subject = excluded.subject, snippet = excluded.snippet,
           last_message_at = excluded.last_message_at, message_count = excluded.message_count,
           is_read = excluded.is_read, is_starred = excluded.is_starred,
           is_important = excluded.is_important, has_attachments = excluded.has_attachments,
           from_name = excluded.from_name, from_address = excluded.from_address,
           is_encrypted = excluded.is_encrypted, is_signed = excluded.is_signed",
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
    .bind(is_encrypted)
    .bind(is_signed)
    .execute(&mut **tx)
    .await
    .map_err(|e| e.to_string())?;

    // Message.
    sqlx::query(
        "INSERT INTO messages (id, account_id, thread_id, from_address, from_name, to_addresses,
            cc_addresses, bcc_addresses, reply_to, subject, snippet, date, is_read, is_starred,
            body_text, body_cached, raw_size, message_id_header, in_reply_to_header,
            references_header, list_unsubscribe, list_unsubscribe_post, auth_results,
            imap_uid, imap_folder, classification_id, is_encrypted, is_signed,
            remote_email_id, remote_thread_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?)
         ON CONFLICT(account_id, id) DO UPDATE SET
           from_address = excluded.from_address, from_name = excluded.from_name,
           to_addresses = excluded.to_addresses, cc_addresses = excluded.cc_addresses,
           bcc_addresses = excluded.bcc_addresses, reply_to = excluded.reply_to,
           subject = excluded.subject, snippet = excluded.snippet, date = excluded.date,
           is_read = excluded.is_read, is_starred = excluded.is_starred,
           body_text = excluded.body_text, raw_size = excluded.raw_size,
           message_id_header = excluded.message_id_header,
           imap_uid = excluded.imap_uid, imap_folder = excluded.imap_folder,
           is_encrypted = excluded.is_encrypted, is_signed = excluded.is_signed,
           remote_email_id = excluded.remote_email_id, remote_thread_id = excluded.remote_thread_id",
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
    .bind(is_encrypted)
    .bind(is_signed)
    .bind(&m.remote_email_id)
    .bind(&m.remote_thread_id)
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

    // NOTE: do NOT write to `message_bodies` here. This is the headers-only
    // sync path — no real body was fetched. mail_parser's `body_html(0)` on a
    // headers-only message returns the synthesized shell `<html><body></body>
    // </html>`, and writing that here poisoned the cache (every synced message
    // got a 26-char shell row that the reading pane then rendered as blank).
    // `message_bodies` is owned exclusively by the body-fetch path
    // (`message_bodies::set_message_body`, called from `request_bodies_inner`
    // via `fetch_bodies_batch`). body_cached stays 0 (see above) so the
    // viewport prefetch / select-on-demand paths re-fetch the real body.

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
        // apply_folder_delta is the HEADERS-only sync path — it must NOT write
        // message_bodies (that's the body-fetch path's job). Even though m1
        // carried body_html=Some, no row is written here.
        assert_eq!(count(&pool, "message_bodies").await, 0);
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

        // apply_folder_delta is headers-only and does NOT cache bodies (the
        // body-fetch path owns message_bodies). Seed a real body the
        // production way so we can assert the flag update doesn't clobber it.
        crate::db::message_bodies::set_message_body(
            &pool,
            "acc",
            "imap-acc-INBOX-7",
            "<p>x</p>",
        )
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
        // apply_folder_delta is headers-only — it never writes message_bodies
        // (the body-fetch path owns that table). bodies are fetched on demand.
        assert_eq!(count(&pool, "message_bodies").await, 0);

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

    // ---- get_uncached_body_message_ids (viewport prefetch filter) ----

    /// `get_uncached_body_message_ids` is the backend half of the viewport
    /// body-prefetch: given a candidate list of message_ids (visible + buffer
    /// rows), return only those whose body is NOT cached (`body_cached = 0`).
    /// Cached ids are filtered out (no point re-fetching); missing ids are
    /// silently dropped (the prefetch simply skips them — they were likely
    /// expunged between the list render and the prefetch fire).
    #[tokio::test]
    async fn get_uncached_body_message_ids_returns_only_body_cached_zero() {
        let tmp = tempfile::tempdir().unwrap();
        let pool = init_db(tmp.path()).await.unwrap();
        seed(&pool, "acc").await;
        // Two messages; one cached, one not.
        seed_message_with_location(&pool, "acc", "imap-acc-INBOX-1", "INBOX", 1).await;
        seed_message_with_location(&pool, "acc", "imap-acc-INBOX-2", "INBOX", 2).await;
        sqlx::query("UPDATE messages SET body_cached = 1 WHERE id = 'imap-acc-INBOX-1'")
            .execute(&pool)
            .await
            .unwrap();

        let mut ids = get_uncached_body_message_ids(
            &pool,
            "acc",
            &[
                "imap-acc-INBOX-1".into(),
                "imap-acc-INBOX-2".into(),
                "missing".into(),
            ],
        )
        .await
        .unwrap();
        ids.sort();
        assert_eq!(
            ids,
            vec!["imap-acc-INBOX-2".to_string()],
            "cached id filtered out; missing id silently dropped"
        );
    }

    /// Empty input short-circuits (no SQL, no params bound) — the common case
    /// when the viewport is empty or every visible row is already cached.
    #[tokio::test]
    async fn get_uncached_body_message_ids_empty_input_returns_empty() {
        let tmp = tempfile::tempdir().unwrap();
        let pool = init_db(tmp.path()).await.unwrap();
        seed(&pool, "acc").await;
        let ids = get_uncached_body_message_ids(&pool, "acc", &[]).await.unwrap();
        assert!(ids.is_empty());
    }

    /// Account isolation: an id under a different account must not be returned
    /// even if it matches the id list and has body_cached = 0. Prevents a
    /// cross-account prefetch from accidentally fetching another account's
    /// body via a shared id space.
    #[tokio::test]
    async fn get_uncached_body_message_ids_isolates_by_account() {
        let tmp = tempfile::tempdir().unwrap();
        let pool = init_db(tmp.path()).await.unwrap();
        seed(&pool, "a1").await;
        seed(&pool, "a2").await;
        seed_message_with_location(&pool, "a2", "shared-id", "INBOX", 5).await;
        // shared-id exists under a2 with body_cached = 0, but we ask for a1.
        let ids = get_uncached_body_message_ids(&pool, "a1", &["shared-id".into()])
            .await
            .unwrap();
        assert!(
            ids.is_empty(),
            "lookup must be scoped by account_id — no cross-account leak"
        );
    }

    /// Phase 1b receive detection: `apply_folder_delta` must persist the
    /// dormant `is_encrypted` / `is_signed` columns on BOTH `messages` and
    /// `threads` from `RemoteMessage.crypto_kind.db_flags()`. Proves the bind
    /// + ON CONFLICT SET clauses land the flags for a detected S/MIME
    /// enveloped-data message (encrypted-only).
    #[tokio::test]
    async fn apply_folder_delta_persists_crypto_flags_for_encrypted_message() {
        let tmp = tempfile::tempdir().unwrap();
        let pool = init_db(tmp.path()).await.unwrap();
        seed(&pool, "acc").await;
        let delta = FolderDelta {
            added: vec![RemoteMessage {
                uid: 11,
                folder: "INBOX".into(),
                message_id: Some("<enc>".into()),
                subject: Some("Encrypted".into()),
                from_address: Some("a@b".into()),
                date: 5000,
                crypto_kind: Some(CryptoKind::Encrypted),
                ..Default::default()
            }],
            ..Default::default()
        };
        apply_folder_delta(&pool, "acc", "acc:INBOX", "INBOX", &delta)
            .await
            .unwrap();

        // Message PK is `imap-{account}-{folder}-{uid}` (the stable IMAP identity).
        let pk = "imap-acc-INBOX-11";
        let (enc, sig): (i64, i64) =
            sqlx::query_as("SELECT is_encrypted, is_signed FROM messages WHERE account_id = 'acc' AND id = ?")
                .bind(pk)
                .fetch_one(&pool)
                .await
                .unwrap();
        assert_eq!((enc, sig), (1, 0), "messages flags must reflect Encrypted");

        let (enc_t, sig_t): (i64, i64) =
            sqlx::query_as("SELECT is_encrypted, is_signed FROM threads WHERE account_id = 'acc' AND id = ?")
                .bind(pk)
                .fetch_one(&pool)
                .await
                .unwrap();
        assert_eq!((enc_t, sig_t), (1, 0), "threads flags must reflect Encrypted");
    }

    /// Companion to the encrypted-message test: a plain message (crypto_kind =
    /// None) must leave both flags at 0, and an EncryptedSigned kind must set
    /// both.
    #[tokio::test]
    async fn apply_folder_delta_crypto_flags_plain_and_signed_variants() {
        let tmp = tempfile::tempdir().unwrap();
        let pool = init_db(tmp.path()).await.unwrap();
        seed(&pool, "acc").await;

        // Plain message → (0, 0).
        let delta = FolderDelta {
            added: vec![RemoteMessage {
                uid: 21,
                folder: "INBOX".into(),
                message_id: Some("<plain>".into()),
                subject: Some("Plain".into()),
                from_address: Some("a@b".into()),
                date: 6000,
                ..Default::default()
            }],
            ..Default::default()
        };
        apply_folder_delta(&pool, "acc", "acc:INBOX", "INBOX", &delta)
            .await
            .unwrap();
        let (enc, sig): (i64, i64) =
            sqlx::query_as("SELECT is_encrypted, is_signed FROM messages WHERE account_id = 'acc' AND id = ?")
                .bind("imap-acc-INBOX-21")
                .fetch_one(&pool)
                .await
                .unwrap();
        assert_eq!((enc, sig), (0, 0), "plain message must not set flags");

        // EncryptedSigned → (1, 1).
        let delta = FolderDelta {
            added: vec![RemoteMessage {
                uid: 22,
                folder: "INBOX".into(),
                message_id: Some("<both>".into()),
                subject: Some("Both".into()),
                from_address: Some("a@b".into()),
                date: 7000,
                crypto_kind: Some(CryptoKind::EncryptedSigned),
                ..Default::default()
            }],
            ..Default::default()
        };
        apply_folder_delta(&pool, "acc", "acc:INBOX", "INBOX", &delta)
            .await
            .unwrap();
        let (enc, sig): (i64, i64) =
            sqlx::query_as("SELECT is_encrypted, is_signed FROM messages WHERE account_id = 'acc' AND id = ?")
                .bind("imap-acc-INBOX-22")
                .fetch_one(&pool)
                .await
                .unwrap();
        assert_eq!((enc, sig), (1, 1), "EncryptedSigned must set both flags");
    }

    /// Re-sync via ON CONFLICT must UPDATE the flags (not leave the original
    /// zeros). Proves the `is_encrypted = excluded.is_encrypted` clause in the
    /// ON CONFLICT DO UPDATE SET list.
    #[tokio::test]
    async fn apply_folder_delta_resync_updates_crypto_flags() {
        let tmp = tempfile::tempdir().unwrap();
        let pool = init_db(tmp.path()).await.unwrap();
        seed(&pool, "acc").await;
        let pk = "imap-acc-INBOX-31";

        // Round 1: plain message (crypto_kind None) — flags (0, 0).
        let delta1 = FolderDelta {
            added: vec![RemoteMessage {
                uid: 31,
                folder: "INBOX".into(),
                message_id: Some("<resync>".into()),
                subject: Some("Resync".into()),
                from_address: Some("a@b".into()),
                date: 8000,
                ..Default::default()
            }],
            ..Default::default()
        };
        apply_folder_delta(&pool, "acc", "acc:INBOX", "INBOX", &delta1)
            .await
            .unwrap();
        let (enc, sig): (i64, i64) =
            sqlx::query_as("SELECT is_encrypted, is_signed FROM messages WHERE account_id = 'acc' AND id = ?")
                .bind(pk)
                .fetch_one(&pool)
                .await
                .unwrap();
        assert_eq!((enc, sig), (0, 0));

        // Round 2: same message id + uid, now flagged as Signed. The ON
        // CONFLICT path must update the flags to (0, 1).
        let delta2 = FolderDelta {
            added: vec![RemoteMessage {
                uid: 31,
                folder: "INBOX".into(),
                message_id: Some("<resync>".into()),
                subject: Some("Resync".into()),
                from_address: Some("a@b".into()),
                date: 8000,
                crypto_kind: Some(CryptoKind::Signed),
                ..Default::default()
            }],
            ..Default::default()
        };
        apply_folder_delta(&pool, "acc", "acc:INBOX", "INBOX", &delta2)
            .await
            .unwrap();
        let (enc, sig): (i64, i64) =
            sqlx::query_as("SELECT is_encrypted, is_signed FROM messages WHERE account_id = 'acc' AND id = ?")
                .bind(pk)
                .fetch_one(&pool)
                .await
                .unwrap();
        assert_eq!((enc, sig), (0, 1), "re-sync must update is_signed via ON CONFLICT");
    }

    /// P4 OBJECTID stable IDs: `apply_folder_delta` must persist
    /// `remote_email_id` / `remote_thread_id` from a `RemoteMessage` onto the
    /// new `messages` columns on BOTH the initial INSERT and the ON CONFLICT
    /// UPDATE (so a re-sync that picks up the stable ID later — e.g. after the
    /// server starts advertising OBJECTID — stamps the values). Locks the
    /// column list + bind ordering in `upsert_message`.
    /// `reconcile_thread_labels` self-heals a wipe: after upserting a message
    /// (which links its thread via `thread_labels`), a direct `DELETE FROM
    /// thread_labels` (as `MutationOp::Move` / `delete_folder` do) leaves the
    /// folder's message list empty until the message is re-upserted. The
    /// reconcile must restore the linkage from `messages` alone.
    #[tokio::test]
    async fn reconcile_thread_labels_self_heals_after_wipe() {
        let tmp = tempfile::tempdir().unwrap();
        let pool = init_db(tmp.path()).await.unwrap();
        seed(&pool, "acc").await;

        // Upsert one INBOX message — upsert_message links its thread to "acc:INBOX".
        let delta = FolderDelta {
            added: vec![RemoteMessage {
                uid: 7,
                folder: "INBOX".into(),
                message_id: Some("<m7>".into()),
                subject: Some("hi".into()),
                from_address: Some("a@b".into()),
                date: 1000,
                ..Default::default()
            }],
            ..Default::default()
        };
        apply_folder_delta(&pool, "acc", "acc:INBOX", "INBOX", &delta)
            .await
            .unwrap();
        let linked: i64 = sqlx::query_scalar(
            "SELECT COUNT(*) FROM thread_labels WHERE account_id = 'acc'",
        )
        .fetch_one(&pool)
        .await
        .unwrap();
        assert_eq!(linked, 1, "upsert must link the thread to its folder label");

        // Simulate a wipe (what Move/delete_folder do) — linkage gone, message stays.
        sqlx::query("DELETE FROM thread_labels WHERE account_id = 'acc'")
            .execute(&pool)
            .await
            .unwrap();
        let wiped: i64 = sqlx::query_scalar(
            "SELECT COUNT(*) FROM thread_labels WHERE account_id = 'acc'",
        )
        .fetch_one(&pool)
        .await
        .unwrap();
        assert_eq!(wiped, 0);

        // Reconcile must rebuild the linkage from `messages` alone (no re-upsert).
        let healed = reconcile_thread_labels(&pool, "acc").await.unwrap();
        assert_eq!(healed, 1, "reconcile must re-add the wiped row");
        let (tid, label): (String, String) = sqlx::query_as(
            "SELECT thread_id, label_id FROM thread_labels WHERE account_id = 'acc'",
        )
        .fetch_one(&pool)
        .await
        .unwrap();
        assert_eq!(tid, "imap-acc-INBOX-7");
        assert_eq!(label, "acc:INBOX");

        // Idempotent: a second reconcile adds nothing.
        let again = reconcile_thread_labels(&pool, "acc").await.unwrap();
        assert_eq!(again, 0);
    }

    #[tokio::test]
    async fn apply_folder_delta_persists_remote_stable_ids() {
        let tmp = tempfile::tempdir().unwrap();
        let pool = init_db(tmp.path()).await.unwrap();
        seed(&pool, "acc").await;

        // Round 1: insert WITH stable IDs (Yahoo OBJECTID EMAILID/THREADID).
        let delta = FolderDelta {
            added: vec![RemoteMessage {
                uid: 42,
                folder: "INBOX".into(),
                message_id: Some("<oid>".into()),
                subject: Some("With OID".into()),
                from_address: Some("a@b".into()),
                date: 6000,
                remote_email_id: Some("P0000000000000042".into()),
                remote_thread_id: Some("P0000000000000099".into()),
                ..Default::default()
            }],
            ..Default::default()
        };
        apply_folder_delta(&pool, "acc", "acc:INBOX", "INBOX", &delta)
            .await
            .unwrap();

        let pk = "imap-acc-INBOX-42";
        let (email_id, thread_id): (Option<String>, Option<String>) =
            sqlx::query_as("SELECT remote_email_id, remote_thread_id FROM messages WHERE account_id = 'acc' AND id = ?")
                .bind(pk)
                .fetch_one(&pool)
                .await
                .unwrap();
        assert_eq!(email_id.as_deref(), Some("P0000000000000042"));
        assert_eq!(thread_id.as_deref(), Some("P0000000000000099"));

        // Round 2: re-sync with DIFFERENT stable IDs — ON CONFLICT UPDATE must
        // overwrite (mirrors how a UIDVALIDITY reset + re-fetch re-links the
        // logical message under a new OBJECTID).
        let delta2 = FolderDelta {
            added: vec![RemoteMessage {
                uid: 42,
                folder: "INBOX".into(),
                message_id: Some("<oid>".into()),
                subject: Some("With OID".into()),
                from_address: Some("a@b".into()),
                date: 6000,
                remote_email_id: Some("P0000000000000042".into()),
                remote_thread_id: Some("P0000000000000177".into()),
                ..Default::default()
            }],
            ..Default::default()
        };
        apply_folder_delta(&pool, "acc", "acc:INBOX", "INBOX", &delta2)
            .await
            .unwrap();
        let (email_id2, thread_id2): (Option<String>, Option<String>) =
            sqlx::query_as("SELECT remote_email_id, remote_thread_id FROM messages WHERE account_id = 'acc' AND id = ?")
                .bind(pk)
                .fetch_one(&pool)
                .await
                .unwrap();
        assert_eq!(email_id2.as_deref(), Some("P0000000000000042"));
        assert_eq!(
            thread_id2.as_deref(),
            Some("P0000000000000177"),
            "re-sync must update remote_thread_id via ON CONFLICT"
        );

        // Round 3: a message with NO stable IDs (generic IMAP) — columns stay NULL,
        // and a prior non-NULL value is NOT clobbered to NULL by a None bind on
        // the UPDATE path (generic server re-syncing after a cap was once advertised
        // would drop the value; this asserts the bind is the source-of-truth).
        // NOTE: None binds as SQL NULL, so this WILL overwrite to NULL — this is
        // the intended behaviour (the new fetch genuinely saw no stable ID).
        let delta3 = FolderDelta {
            added: vec![RemoteMessage {
                uid: 42,
                folder: "INBOX".into(),
                message_id: Some("<oid>".into()),
                subject: Some("With OID".into()),
                from_address: Some("a@b".into()),
                date: 6000,
                ..Default::default()
            }],
            ..Default::default()
        };
        apply_folder_delta(&pool, "acc", "acc:INBOX", "INBOX", &delta3)
            .await
            .unwrap();
        let (email_id3, _): (Option<String>, Option<String>) =
            sqlx::query_as("SELECT remote_email_id, remote_thread_id FROM messages WHERE account_id = 'acc' AND id = ?")
                .bind(pk)
                .fetch_one(&pool)
                .await
                .unwrap();
        assert!(email_id3.is_none(), "None stable ID binds to SQL NULL on re-sync");
    }
}
