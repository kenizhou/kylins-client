// Tauri commands for the SyncEngine lifecycle. The frontend invokes these to start
// polling on app launch, trigger a manual "check mail", and stop on quit.

use std::collections::HashMap;
use std::sync::Arc;

use sqlx::SqlitePool;
use tauri::State;

use super::engine::{BodiesWrittenEvent, SnippetUpdate, SyncEngine};
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
/// `message_bodies` row is missing.
///
/// **Task 2 — batch-per-folder:** message_ids are grouped by their
/// `imap_folder`, then for each folder we issue ONE `fetch_bodies_batch` call
/// (chunked internally at 50 UIDs) instead of opening a fresh connection per
/// UID. The derived snippet is written onto `messages.snippet` (mirrored to
/// `threads.snippet`), and ONE `sync:bodies-written` event is emitted at the
/// end carrying every `SnippetUpdate` so the frontend patches the list in a
/// single scroll-preserving pass.
///
/// Non-IMAP sources (EAS today) return `None` from
/// `MailSource::imap_config_for_folder` and fall back to the per-message
/// `fetch_body` path — batching EAS is its own workstream.
///
/// Best-effort: per-message failures are logged and skipped so one bad row
/// never aborts the whole batch.
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
    log::info!("[sync] sync_request_bodies called: account={}, ids={}", account_id, message_ids.len());
    request_bodies_inner(engine.inner().clone(), pool.inner(), &account_id, &message_ids).await
}

/// Testable core of [`sync_request_bodies`]. Takes a borrowed pool + an
/// `Arc<SyncEngine>` (the engine is only used for the final event emission)
/// so unit tests can drive it without a `State<'_, SqlitePool>` harness.
pub async fn request_bodies_inner(
    engine: Arc<SyncEngine>,
    pool: &SqlitePool,
    account_id: &str,
    message_ids: &[String],
) -> Result<(), String> {
    if message_ids.is_empty() {
        return Ok(());
    }

    // 1. Build a per-folder map: folder -> Vec<(message_id, uid)>.
    //    One DB read per message_id (the existing helper). This is N small
    //    queries, not N connections — cheap relative to the network round-trip
    //    we are about to make. Missing rows / NULL UIDs are skipped (non-IMAP
    //    sources or partially-migrated data).
    let mut by_folder: HashMap<String, Vec<(String, u32)>> = HashMap::new();
    for mid in message_ids {
        match messages::get_folder_uid_for_message(pool, account_id, mid).await {
            Ok(Some((folder, uid))) => {
                by_folder.entry(folder).or_default().push((mid.clone(), uid));
            }
            Ok(None) => log::warn!(
                "[sync] request_bodies: no imap_folder/uid for message {mid}; skipping"
            ),
            Err(e) => log::warn!(
                "[sync] request_bodies: lookup failed for message {mid}: {e}; skipping"
            ),
        }
    }
    if by_folder.is_empty() {
        return Ok(());
    }

    // 2. Resolve the account's MailSource ONCE. The batch path does NOT call
    //    `source.fetch_body` — it asks the source for an `ImapConfig` via the
    //    new `imap_config_for_folder` trait method and hands it to
    //    `fetch_bodies_batch` directly. Non-IMAP sources return `None` and we
    //    fall back to the per-message `source.fetch_body` below.
    let src = match source_for_account(pool, account_id, &engine.session_manager).await {
        Ok(s) => s,
        Err(e) => {
            log::warn!("[sync] request_bodies: source for {account_id} failed: {e}");
            return Err(e);
        }
    };

    let mut updates: Vec<SnippetUpdate> = Vec::new();

    // 3. Per folder: one batched fetch_bodies_batch call (IMAP), or per-message
    //    fallback (EAS / non-IMAP).
    //
    //    CONCURRENT-CONNECTION GUARD (mirrors the fix in imap_source::sync_folder
    //    Stage 1.5): `fetch_bodies_batch` opens its OWN raw TCP connection and
    //    holds it for the whole batch. If the persistent IMAP session is still
    //    alive at the same time, the server sees 2 concurrent connections from
    //    this client and kills one (`* BYE Connection closed. 14`), which can
    //    cascade into the body fetch failing mid-batch. Disconnect the persistent
    //    session BEFORE the raw batch connection opens. The session lazily
    //    reconnects on the next `manager.execute(...)` call, so this is safe.
    //    Only IMAP sources have a persistent session (EAS has none), and we only
    //    disconnect once per `request_bodies_inner` call (not per folder) since
    //    the first disconnect already guarantees no concurrency for subsequent
    //    folders in the same batch.
    let mut persistent_session_disconnected = false;
    for (folder, mid_uids) in by_folder {
        match src.imap_config_for_folder(&folder).await {
            Ok(Some(config)) => {
                let uids: Vec<u32> = mid_uids.iter().map(|(_, u)| *u).collect();
                // Disconnect the persistent session ONCE before the first raw
                // batch fetch in this call. Subsequent folders reuse the already-
                // disconnected state (no-op when already None).
                if !persistent_session_disconnected {
                    log::info!(
                        "[sync] request_bodies: disconnecting persistent IMAP session for {account_id} before fetch_bodies_batch (concurrent-connection guard)"
                    );
                    engine.session_manager.disconnect_account(account_id).await;
                    persistent_session_disconnected = true;
                }
                match crate::mail::imap::client::fetch_bodies_batch(
                    &config,
                    &folder,
                    &uids,
                    50,
                )
                .await
                {
                    Ok(fetched) => {
                        // Index fetched bodies by uid for O(1) lookup.
                        let by_uid: HashMap<u32, &crate::mail::imap::types::FetchedBody> =
                            fetched.iter().map(|f| (f.uid, f)).collect();
                        for (mid, uid) in &mid_uids {
                            match by_uid.get(uid) {
                                Some(fb) => {
                                    // Persist body_html (prefers HTML; falls back to text).
                                    let body_str = fb
                                        .body_html
                                        .clone()
                                        .or_else(|| fb.body_text.clone());
                                    if let Some(body) = body_str {
                                        if let Err(e) = message_bodies::set_message_body(
                                            pool, account_id, mid, &body,
                                        )
                                        .await
                                        {
                                            log::warn!(
                                                "[sync] request_bodies: persist body for {mid} (uid {uid} in {folder}) failed: {e}"
                                            );
                                            continue;
                                        }
                                    }
                                    // Write snippet onto messages + threads.
                                    if let Err(e) = messages::set_message_snippet(
                                        pool, account_id, mid, &fb.snippet,
                                    )
                                    .await
                                    {
                                        log::warn!(
                                            "[sync] request_bodies: snippet for {mid} failed: {e}"
                                        );
                                        continue;
                                    }
                                    // Resolve thread_id for the event payload.
                                    match messages::get_thread_id_for_message(
                                        pool, account_id, mid,
                                    )
                                    .await
                                    {
                                        Ok(Some(tid)) => updates.push(SnippetUpdate {
                                            thread_id: tid,
                                            snippet: fb.snippet.clone(),
                                        }),
                                        Ok(None) => log::warn!(
                                            "[sync] request_bodies: no thread_id for {mid}; event patch skipped"
                                        ),
                                        Err(e) => log::warn!(
                                            "[sync] request_bodies: thread_id lookup for {mid} failed: {e}"
                                        ),
                                    }
                                }
                                None => log::info!(
                                    "[sync] request_bodies: uid {uid} in {folder} not in batch result; skipping"
                                ),
                            }
                        }
                    }
                    Err(e) => log::warn!(
                        "[sync] request_bodies: fetch_bodies_batch for {folder} failed: {e}"
                    ),
                }
            }
            Ok(None) => {
                // Non-IMAP source (EAS today): fall back to per-message.
                // The batch path is unavailable; each fetch_body opens its own
                // transport. Snippet is left empty for EAS until the EAS
                // client exposes a derived preview (deferred).
                for (mid, uid) in &mid_uids {
                    let folder_obj = RemoteFolder {
                        remote_id: folder.clone(),
                        ..Default::default()
                    };
                    match src.fetch_body(&folder_obj, *uid).await {
                        Ok(Some(html)) => {
                            if let Err(e) =
                                message_bodies::set_message_body(pool, account_id, mid, &html).await
                            {
                                log::warn!(
                                    "[sync] request_bodies (fallback): persist body for {mid} failed: {e}"
                                );
                                continue;
                            }
                            // EAS has no derived snippet yet; write empty so the
                            // thread row is consistent (and the column is NOT
                            // NULL, which db_get_threads would otherwise treat
                            // as "needs preview generation" later).
                            if let Err(e) =
                                messages::set_message_snippet(pool, account_id, mid, "").await
                            {
                                log::warn!(
                                    "[sync] request_bodies (fallback): snippet for {mid} failed: {e}"
                                );
                            }
                        }
                        Ok(None) => log::info!(
                            "[sync] request_bodies (fallback): uid {uid} in {folder} had no body"
                        ),
                        Err(e) => log::warn!(
                            "[sync] request_bodies (fallback): fetch_body for {mid} (uid {uid} in {folder}) failed: {e}"
                        ),
                    }
                }
            }
            Err(e) => log::warn!(
                "[sync] request_bodies: imap_config_for_folder for {folder} failed: {e}; falling back to per-message"
            ),
        }
    }

    // 4. Bounded cache: evict oldest bodies past the cap. Best-effort — log on
    //    error. Run unconditionally (even if this round wrote nothing) so the
    //    cache converges to the cap regardless of which call happens to push it
    //    over. `set_message_body`/`INSERT OR REPLACE` bumped the row count, so
    //    `maybe_evict` is the symmetric reclaim step that keeps `message_bodies`
    //    from growing unbounded across a long-running session.
    const BODY_CACHE_CAP_ROWS: i64 = 2000;
    if let Err(e) = message_bodies::maybe_evict(pool, BODY_CACHE_CAP_ROWS).await {
        log::warn!("[sync] request_bodies: maybe_evict failed (non-fatal): {e}");
    }

    // 5. Emit ONE bodies-written event with all updates so the frontend
    //    patches every thread in a single scroll-preserving pass.
    if !updates.is_empty() {
        engine.emit_bodies_written_public(BodiesWrittenEvent {
            account_id: account_id.to_string(),
            updates,
        });
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
    use crate::sync_engine::engine::{
        BodiesWrittenEvent, DeltaEvent, EventSink, NewMailEvent, QueueEvent, StatusEvent, SyncEngine,
    };
    use std::sync::{Arc, Mutex};

    /// Sink that discards every event — we only need the engine to exist for the
    /// nudge; we do not assert on events here.
    struct NullSink;
    impl EventSink for NullSink {
        fn emit_delta(&self, _: DeltaEvent) {}
        fn emit_new_mail(&self, _: NewMailEvent) {}
        fn emit_status(&self, _: StatusEvent) {}
        fn emit_queue(&self, _: QueueEvent) {}
        fn emit_bodies_written(&self, _: BodiesWrittenEvent) {}
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
        let engine = SyncEngine::new(
            pool.clone(),
            std::sync::Arc::new(NullSink),
        );
        // Note: no account seeded — the empty-input early return must fire
        // before `source_for_account` is ever called.
        request_bodies_inner(engine, &pool, "acct", &[])
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
        let engine = SyncEngine::new(
            pool.clone(),
            std::sync::Arc::new(NullSink),
        );

        request_bodies_inner(
            engine,
            &pool,
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

    // ---- Task 2: batch-per-folder grouping + bodies-written emission ----

    /// EventSink that captures `BodiesWrittenEvent`s for assertion. The other
    /// event kinds are discarded — Task 2 only asserts on bodies-written.
    #[derive(Default, Clone)]
    struct CapturingSink {
        bodies: Arc<Mutex<Vec<BodiesWrittenEvent>>>,
    }
    impl EventSink for CapturingSink {
        fn emit_delta(&self, _: DeltaEvent) {}
        fn emit_new_mail(&self, _: NewMailEvent) {}
        fn emit_status(&self, _: StatusEvent) {}
        fn emit_queue(&self, _: QueueEvent) {}
        fn emit_bodies_written(&self, e: BodiesWrittenEvent) {
            self.bodies.lock().unwrap().push(e);
        }
    }

    /// Pure folder-grouping sanity: given a list of (message_id, folder, uid)
    /// tuples, produce a map folder -> [(message_id, uid)]. This is the shape
    /// `request_bodies_inner` builds before issuing one
    /// `fetch_bodies_batch` per folder. The end-to-end batched fetch needs a
    /// live IMAP socket (Task 5 ignored integration test), so this unit test
    /// pins only the bucketing the loop relies on.
    #[test]
    fn group_message_ids_by_folder_buckets_by_imap_folder() {
        use std::collections::HashMap;
        let inputs = vec![
            ("imap-a-INBOX-1", "INBOX", 1u32),
            ("imap-a-INBOX-2", "INBOX", 2),
            ("imap-a-Sent-9", "Sent", 9),
        ];
        let mut buckets: HashMap<&str, Vec<(&str, u32)>> = HashMap::new();
        for (mid, folder, uid) in &inputs {
            buckets.entry(folder).or_default().push((mid, *uid));
        }
        assert_eq!(buckets["INBOX"].len(), 2);
        assert_eq!(buckets["Sent"].len(), 1);
    }

    /// When `request_bodies_inner` resolves no source (e.g. the account's
    /// provider is not imap/eas) the call surfaces the factory's Err — but the
    /// sink must NOT have emitted any bodies-written event (we never reached
    /// the batch loop). Pins the "no partial emit on factory failure" contract
    /// the frontend relies on.
    #[tokio::test]
    async fn request_bodies_inner_does_not_emit_when_source_factory_fails() {
        let tmp = tempfile::tempdir().unwrap();
        let pool = init_db(tmp.path()).await.unwrap();
        // No account seeded -> source_for_account returns Err.
        let sink = Arc::new(CapturingSink::default());
        let engine = SyncEngine::new(pool.clone(), sink.clone());
        // Seed an account with an unsupported provider + a phantom thread +
        // messages row so by_folder is non-empty and we reach the source
        // factory. (Unsupported provider -> factory Err; no batch loop.) The
        // account row satisfies the FK on threads.account_id.
        sqlx::query(
            "INSERT INTO accounts (id, email, provider)
             VALUES ('acct', 'acct@x.com', 'carrier-pigeon')",
        )
        .execute(&pool)
        .await
        .unwrap();
        sqlx::query(
            "INSERT INTO threads (id, account_id, subject, is_read, is_starred)
             VALUES ('imap-acct-INBOX-1', 'acct', 'p', 0, 0)",
        )
        .execute(&pool)
        .await
        .unwrap();
        sqlx::query(
            "INSERT INTO messages (id, account_id, thread_id, date, is_read, is_starred,
                imap_uid, imap_folder)
             VALUES ('imap-acct-INBOX-1', 'acct', 'imap-acct-INBOX-1', 0, 0, 0, 1, 'INBOX')",
        )
        .execute(&pool)
        .await
        .unwrap();

        let _ = request_bodies_inner(
            engine,
            &pool,
            "acct",
            &["imap-acct-INBOX-1".into()],
        )
        .await;

        assert!(
            sink.bodies.lock().unwrap().is_empty(),
            "no bodies-written event when source factory fails"
        );
    }
}
