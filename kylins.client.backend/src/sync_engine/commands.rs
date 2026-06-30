// Tauri commands for the SyncEngine lifecycle. The frontend invokes these to start
// polling on app launch, trigger a manual "check mail", and stop on quit.

use std::sync::Arc;

use sqlx::SqlitePool;
use tauri::State;

use super::engine::SyncEngine;
use super::{source_for_account, RemoteFolder};
use crate::db::{message_bodies, messages, mutations::MutationOp, queue};

#[tauri::command]
pub async fn sync_start(engine: State<'_, Arc<SyncEngine>>) -> Result<(), String> {
    engine.start().await
}

#[tauri::command]
pub async fn sync_stop(engine: State<'_, Arc<SyncEngine>>) -> Result<(), String> {
    engine.stop_all().await;
    Ok(())
}

#[tauri::command]
pub async fn sync_account_now(
    engine: State<'_, Arc<SyncEngine>>,
    account_id: String,
) -> Result<(), String> {
    engine.sync_account_now(account_id).await;
    Ok(())
}

/// Fetch full message bodies on demand (the second half of the headers-first
/// sync design). The folder sweep persists envelopes + flags only
/// (`SYNC_FETCH_QUERY`); bodies arrive here when the user opens a message whose
/// `message_bodies` row is missing. For each `message_id`: read its
/// `(imap_folder, imap_uid)` location, build the account's `MailSource`, call
/// `fetch_body`, and upsert the HTML into `message_bodies` via
/// [`message_bodies::set_message_body`].
///
/// Best-effort: per-message failures are logged and skipped so one bad row
/// never aborts the whole batch (the caller — `threadStore.selectThread` —
/// re-reads the cache and renders whatever is present).
///
/// The thin `State` wrapper delegates to [`request_bodies_inner`] so the logic
/// is unit-testable without a `State` harness (mirrors `apply_mutation_inner`).
#[tauri::command]
pub async fn sync_request_bodies(
    engine: State<'_, Arc<SyncEngine>>,
    pool: State<'_, SqlitePool>,
    account_id: String,
    message_ids: Vec<String>,
) -> Result<(), String> {
    request_bodies_inner(pool.inner(), &engine.session_manager, &account_id, &message_ids).await
}

/// Testable core of [`sync_request_bodies`]. Takes a borrowed pool so unit tests
/// can drive it without a `State<'_, SqlitePool>` harness.
pub async fn request_bodies_inner(
    pool: &SqlitePool,
    manager: &std::sync::Arc<crate::mail::imap::session_manager::ImapSessionManager>,
    account_id: &str,
    message_ids: &[String],
) -> Result<(), String> {
    if message_ids.is_empty() {
        return Ok(());
    }
    // One source for the whole batch — `source_for_account` opens a fresh
    // connection per `fetch_body` call inside (ImapSource owns its lifecycle),
    // so we don't need to keep a session alive across messages.
    let src = match source_for_account(pool, account_id, manager).await {
        Ok(s) => s,
        Err(e) => {
            log::warn!("[sync] request_bodies: source for {account_id} failed: {e}");
            return Err(e);
        }
    };
    for mid in message_ids {
        // Resolve the IMAP coordinates for this message. Missing row / NULL UID
        // → skip (non-IMAP sources or partially-migrated data).
        let (folder_path, uid) = match messages::get_folder_uid_for_message(pool, account_id, mid)
            .await
        {
            Ok(Some(loc)) => loc,
            Ok(None) => {
                log::warn!(
                    "[sync] request_bodies: no imap_folder/uid for message {mid}; skipping"
                );
                continue;
            }
            Err(e) => {
                log::warn!(
                    "[sync] request_bodies: lookup failed for message {mid}: {e}; skipping"
                );
                continue;
            }
        };
        let folder = RemoteFolder {
            remote_id: folder_path.clone(),
            ..Default::default()
        };
        match src.fetch_body(&folder, uid).await {
            Ok(Some(html)) => {
                if let Err(e) =
                    message_bodies::set_message_body(pool, account_id, mid, &html).await
                {
                    log::warn!(
                        "[sync] request_bodies: persist body for {mid} (uid {uid} in {folder_path}) failed: {e}"
                    );
                }
            }
            Ok(None) => log::info!(
                "[sync] request_bodies: uid {uid} in {folder_path} had no body (empty message?)"
            ),
            Err(e) => log::warn!(
                "[sync] request_bodies: fetch_body uid {uid} in {folder_path} failed: {e}"
            ),
        }
    }
    Ok(())
}

/// Apply a mail mutation optimistically (local DB), then enqueue one
/// `pending_operations` row per affected message for the replay worker, then
/// nudge the worker. This is the single frontend entry point for every mail
/// write (mark-read, flag, move, delete, send).
///
/// **Order is load-bearing:** local-apply happens BEFORE the rows are enqueued,
/// so the UI reflects the change immediately even if the worker is mid-replay.
/// If enqueue fails after a partial local-apply, the user-visible state is
/// consistent with "applied locally, will sync later" — the next replay round
/// reconciles. We do NOT roll back the local write on enqueue failure because
/// the optimistic update is the whole point.
///
/// **Resource IDs:** one row per affected `message_id` (the per-message write
/// lock). `Send` has no message id yet, so a single row keyed by `send:{uuid}`
/// is enqueued instead.
///
/// The Tauri `State` wrapper is intentionally thin — all logic lives in
/// [`apply_mutation_inner`] so it is unit-testable without a `State` harness.
#[tauri::command]
pub async fn sync_apply_mutation(
    engine: State<'_, Arc<SyncEngine>>,
    pool: State<'_, SqlitePool>,
    account_id: String,
    op: MutationOp,
) -> Result<(), String> {
    apply_mutation_inner(engine.inner().clone(), pool.inner(), account_id, op).await
}

/// Testable core of [`sync_apply_mutation`]. Takes a borrowed pool and an
/// `Arc<SyncEngine>` (the engine is only used for the best-effort nudge).
pub async fn apply_mutation_inner(
    engine: Arc<SyncEngine>,
    pool: &SqlitePool,
    account_id: String,
    op: MutationOp,
) -> Result<(), String> {
    // 1. Optimistic local write (single transaction; rolls back on error).
    let affected = op.local_writes(pool, &account_id).await?;

    // 2. Enqueue one row per affected message. Send has no message_id → one row
    //    keyed by a generated "send:{uuid}".
    let ids: Vec<String> = if affected.is_empty() {
        vec![format!("send:{}", uuid::Uuid::new_v4())]
    } else {
        affected.clone()
    };
    for rid in &ids {
        let params = op.encode_params(rid);
        queue::enqueue(pool, &account_id, op.op_type(), rid, &params).await?;
    }

    // 3. Nudge the worker to replay (best-effort, non-blocking). The worker
    //    drains the queue in Task 4; for now this just kicks a folder sync.
    engine.sync_account_now(account_id.clone()).await;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::init_db;
    use crate::sync_engine::engine::SyncEngine;

    /// Sink that discards every event — we only need the engine to exist for the
    /// nudge; we do not assert on events here.
    struct NullSink;
    impl crate::sync_engine::engine::EventSink for NullSink {
        fn emit_delta(&self, _: crate::sync_engine::engine::DeltaEvent) {}
        fn emit_new_mail(&self, _: crate::sync_engine::engine::NewMailEvent) {}
        fn emit_status(&self, _: crate::sync_engine::engine::StatusEvent) {}
        fn emit_queue(&self, _: crate::sync_engine::engine::QueueEvent) {}
    }

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

    async fn seed_thread_with_message(
        pool: &SqlitePool,
        account_id: &str,
        thread_id: &str,
        folder: &str,
        uid: u32,
    ) {
        seed_thread_with_messages(pool, account_id, thread_id, folder, &[uid]).await;
    }

    /// Insert one thread row + a message row per uid. Reusable across the
    /// apply-mutation tests so multi-message ops (markRead on a 2-message
    /// thread) can be seeded in one call without tripping the threads UNIQUE
    /// constraint.
    async fn seed_thread_with_messages(
        pool: &SqlitePool,
        account_id: &str,
        thread_id: &str,
        folder: &str,
        uids: &[u32],
    ) {
        sqlx::query(
            "INSERT INTO threads (id, account_id, subject, is_read, is_starred)
             VALUES (?, ?, 'test', 0, 0)",
        )
        .bind(thread_id)
        .bind(account_id)
        .execute(pool)
        .await
        .unwrap();
        for uid in uids {
            let mid = format!("imap-{account_id}-{folder}-{uid}");
            sqlx::query(
                "INSERT INTO messages
                 (id, account_id, thread_id, subject, date, is_read, is_starred, imap_uid, imap_folder)
                 VALUES (?, ?, ?, 'm', 1000, 0, 0, ?, ?)",
            )
            .bind(&mid)
            .bind(account_id)
            .bind(thread_id)
            .bind(*uid as i64)
            .bind(folder)
            .execute(pool)
            .await
            .unwrap();
        }
    }

    fn msg_id(account_id: &str, folder: &str, uid: u32) -> String {
        format!("imap-{account_id}-{folder}-{uid}")
    }

    #[tokio::test]
    async fn apply_mutation_markread_applies_locally_and_enqueues_per_message() {
        let tmp = tempfile::tempdir().unwrap();
        let pool = init_db(tmp.path()).await.unwrap();
        seed_account(&pool, "acct").await;
        seed_thread_with_messages(&pool, "acct", "thr", "INBOX", &[10, 11]).await;
        let engine = SyncEngine::new(pool.clone(), Arc::new(NullSink));

        let mids = vec![msg_id("acct", "INBOX", 10), msg_id("acct", "INBOX", 11)];
        let op = MutationOp::MarkRead {
            thread_id: "thr".into(),
            message_ids: mids.clone(),
            folder_path: "INBOX".into(),
            uids: vec![10, 11],
            read: true,
        };
        apply_mutation_inner(engine, &pool, "acct".into(), op)
            .await
            .unwrap();

        // Local: thread + messages now read.
        let (tr,): (i64,) =
            sqlx::query_as("SELECT is_read FROM threads WHERE account_id='acct' AND id='thr'")
                .fetch_one(&pool)
                .await
                .unwrap();
        assert_eq!(tr, 1);

        // Queue: one row per affected message_id, op_type=markRead, params has read=1.
        let rows: Vec<(String, String, String)> = sqlx::query_as(
            "SELECT resource_id, operation_type, params FROM pending_operations
             WHERE account_id='acct' ORDER BY resource_id",
        )
        .fetch_all(&pool)
        .await
        .unwrap();
        assert_eq!(rows.len(), 2, "one row per affected message");
        let rids: Vec<&str> = rows.iter().map(|r| r.0.as_str()).collect();
        assert!(rids.contains(&mids[0].as_str()));
        assert!(rids.contains(&mids[1].as_str()));
        for (_, op_type, params) in &rows {
            assert_eq!(op_type, "markRead");
            let p: serde_json::Value = serde_json::from_str(params).unwrap();
            assert_eq!(p["read"], 1);
        }
    }

    #[tokio::test]
    async fn apply_mutation_send_enqueues_single_send_row_with_uuid_resource() {
        let tmp = tempfile::tempdir().unwrap();
        let pool = init_db(tmp.path()).await.unwrap();
        seed_account(&pool, "acct").await;
        let engine = SyncEngine::new(pool.clone(), Arc::new(NullSink));

        let op = MutationOp::Send {
            raw_base64url: "YWJj".into(),
        };
        apply_mutation_inner(engine, &pool, "acct".into(), op)
            .await
            .unwrap();

        let rows: Vec<(String, String)> = sqlx::query_as(
            "SELECT resource_id, operation_type FROM pending_operations WHERE account_id='acct'",
        )
        .fetch_all(&pool)
        .await
        .unwrap();
        assert_eq!(rows.len(), 1, "Send enqueues exactly one row");
        assert!(
            rows[0].0.starts_with("send:"),
            "resource_id starts with 'send:'"
        );
        assert_eq!(rows[0].1, "send");
    }

    #[tokio::test]
    async fn apply_mutation_delete_removes_messages_and_enqueues_delete_rows() {
        let tmp = tempfile::tempdir().unwrap();
        let pool = init_db(tmp.path()).await.unwrap();
        seed_account(&pool, "acct").await;
        seed_thread_with_message(&pool, "acct", "thr", "INBOX", 5).await;
        let engine = SyncEngine::new(pool.clone(), Arc::new(NullSink));

        let mid = msg_id("acct", "INBOX", 5);
        let op = MutationOp::Delete {
            message_ids: vec![mid.clone()],
            folder_path: "INBOX".into(),
            uids: vec![5],
        };
        apply_mutation_inner(engine, &pool, "acct".into(), op)
            .await
            .unwrap();

        // Message gone.
        let (mn,): (i64,) = sqlx::query_as("SELECT COUNT(*) FROM messages WHERE account_id='acct'")
            .fetch_one(&pool)
            .await
            .unwrap();
        assert_eq!(mn, 0);

        // Queue row.
        let (rid, op_type): (String, String) = sqlx::query_as(
            "SELECT resource_id, operation_type FROM pending_operations WHERE account_id='acct'",
        )
        .fetch_one(&pool)
        .await
        .unwrap();
        assert_eq!(rid, mid);
        assert_eq!(op_type, "delete");
    }

    // ---- sync_request_bodies (on-demand body fetch) ----

    /// Empty input is a no-op — never reaches the source factory (which would
    /// fail for an account whose provider has no row, e.g. a fresh test DB).
    #[tokio::test]
    async fn request_bodies_inner_empty_input_is_noop() {
        let tmp = tempfile::tempdir().unwrap();
        let pool = init_db(tmp.path()).await.unwrap();
        let manager = std::sync::Arc::new(
            crate::mail::imap::session_manager::ImapSessionManager::new(),
        );
        // Note: no account seeded — the empty-input early return must fire
        // before `source_for_account` is ever called.
        request_bodies_inner(&pool, &manager, "acct", &[])
            .await
            .expect("empty input must short-circuit to Ok");
    }

    /// Missing-message rows are skipped silently (the contract the frontend
    /// relies on: opening a not-yet-synced thread does not throw). Seeds the
    /// account so the source factory can resolve it, but passes message ids
    /// that have no `messages` row — every iteration hits the None branch.
    #[tokio::test]
    async fn request_bodies_inner_skips_missing_message_rows_without_aborting() {
        let tmp = tempfile::tempdir().unwrap();
        let pool = init_db(tmp.path()).await.unwrap();
        seed_account(&pool, "acct").await;
        let manager = std::sync::Arc::new(
            crate::mail::imap::session_manager::ImapSessionManager::new(),
        );

        request_bodies_inner(
            &pool,
            &manager,
            "acct",
            &["missing-1".into(), "missing-2".into()],
        )
        .await
        .expect("best-effort: missing rows must not abort the batch");

        // Nothing persisted.
        let (n,): (i64,) = sqlx::query_as("SELECT COUNT(*) FROM message_bodies")
            .fetch_one(&pool)
            .await
            .unwrap();
        assert_eq!(n, 0);
    }
}
