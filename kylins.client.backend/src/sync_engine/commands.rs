// Tauri commands for the SyncEngine lifecycle. The frontend invokes these to start
// polling on app launch, trigger a manual "check mail", and stop on quit.

use std::sync::Arc;

use sqlx::SqlitePool;
use tauri::State;

use super::engine::SyncEngine;
use crate::db::{mutations::MutationOp, queue};

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
pub async fn sync_account_now(engine: State<'_, Arc<SyncEngine>>, account_id: String) -> Result<(), String> {
    engine.sync_account_now(account_id).await;
    Ok(())
}

#[tauri::command]
pub async fn sync_request_bodies(
    _engine: State<'_, Arc<SyncEngine>>,
    _account_id: String,
    _message_ids: Vec<String>,
) -> Result<(), String> {
    // Phase 0: bodies are fetched inline during sync_folder. On-demand prefetch is Phase 2.
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

    async fn seed_thread_with_message(pool: &SqlitePool, account_id: &str, thread_id: &str, folder: &str, uid: u32) {
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
        apply_mutation_inner(engine, &pool, "acct".into(), op).await.unwrap();

        // Local: thread + messages now read.
        let (tr,): (i64,) = sqlx::query_as("SELECT is_read FROM threads WHERE account_id='acct' AND id='thr'")
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
        apply_mutation_inner(engine, &pool, "acct".into(), op).await.unwrap();

        let rows: Vec<(String, String)> = sqlx::query_as(
            "SELECT resource_id, operation_type FROM pending_operations WHERE account_id='acct'",
        )
        .fetch_all(&pool)
        .await
        .unwrap();
        assert_eq!(rows.len(), 1, "Send enqueues exactly one row");
        assert!(rows[0].0.starts_with("send:"), "resource_id starts with 'send:'");
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
        apply_mutation_inner(engine, &pool, "acct".into(), op).await.unwrap();

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
}
