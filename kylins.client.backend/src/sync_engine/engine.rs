// SyncEngine — process singleton that owns one AccountWorker (Tokio task) per active
// account. Each worker runs a wakeable 60s poll: list_folders -> upsert labels ->
// per-folder sync_folder(cursor) -> apply_folder_delta -> advance cursor -> emit
// sync:* events. Phase 0 is poll-only; Phase 2 layers IMAP IDLE / EAS Ping on top via
// the same MailSource trait.
//
// `EventSink` is the test seam: TauriEmitter emits via AppHandle in production;
// TestSink collects events for unit tests (so the engine is drivable without a WebView).

use std::collections::{HashMap, HashSet};
use std::sync::Arc;
use std::time::Duration;

use serde::Serialize;
use sqlx::SqlitePool;
use tauri::{AppHandle, Emitter};
use tokio::sync::{Mutex, mpsc};

use crate::db::{accounts, labels, messages, sync_state};
use crate::sync_engine::{Cursor, MailSource, RemoteFolder, source_for_account};

const POLL_INTERVAL_SECS: u64 = 60;

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DeltaEvent {
    op: String,
    table: String,
    account_id: String,
    label_id: String,
    count: i64,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NewMailEvent {
    account_id: String,
    folder_id: String,
    count: i64,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StatusEvent {
    account_id: String,
    state: String,
}

/// Per-account pending-queue count, emitted after every replay round so the
/// UI can render "Offline — N pending" badges. Mirrors the other sync:* events.
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct QueueEvent {
    account_id: String,
    pending: i64,
}

/// Emit seam. Production impl wraps a Tauri `AppHandle`; tests collect into vectors.
pub trait EventSink: Send + Sync {
    fn emit_delta(&self, evt: DeltaEvent);
    fn emit_new_mail(&self, evt: NewMailEvent);
    fn emit_status(&self, evt: StatusEvent);
    fn emit_queue(&self, evt: QueueEvent);
}

struct TauriSink(AppHandle);
impl EventSink for TauriSink {
    fn emit_delta(&self, e: DeltaEvent) {
        let _ = self.0.emit("sync:delta", e);
    }
    fn emit_new_mail(&self, e: NewMailEvent) {
        let _ = self.0.emit("sync:new-mail", e);
    }
    fn emit_status(&self, e: StatusEvent) {
        let _ = self.0.emit("sync:status", e);
    }
    fn emit_queue(&self, e: QueueEvent) {
        let _ = self.0.emit("sync:queue", e);
    }
}

#[derive(Debug)]
enum SyncOp {
    SyncNow,
    Shutdown,
}

/// Realtime strategy picked from a source's `Capabilities` after the first
/// sync round populates the caps cache. `Idle` spawns the per-account IDLE
/// watcher (Task 3); `Poll` keeps the 60s sweep as the only push path. The
/// poll loop runs in BOTH cases — it stays as the background sweep for
/// non-INBOX folders + the fallback when IDLE is unavailable.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RealtimeStrategy {
    /// Source advertises `IDLE` — spawn the watcher task on INBOX.
    Idle,
    /// No real-time cap — poll-only (60s sweep covers every folder).
    Poll,
}

/// Pure decision helper: pick the realtime strategy from a source's caps.
/// Extracted from `spawn_worker` so the decision is unit-testable without
/// spawning the live watcher task (which needs a real IDLE socket).
///
/// The strategy is recomputed only after the first sync round, because that
/// round is what populates the cached caps on `ImapSource` (a fresh source
/// reports `Capabilities::default()` until its first connect succeeds — see
/// `ImapSource::capabilities()`).
fn pick_realtime_strategy(caps: &crate::sync_engine::Capabilities) -> RealtimeStrategy {
    if caps.idle {
        RealtimeStrategy::Idle
    } else {
        RealtimeStrategy::Poll
    }
}

struct WorkerHandle {
    tx: mpsc::Sender<SyncOp>,
    /// JoinHandle for the per-account IDLE watcher task, if the source
    /// advertised IDLE. `None` for poll-only accounts. Aborted in `stop_all`
    /// (and any future worker-removal path) so the watcher does not outlive
    /// its account.
    idle_watcher: Option<tokio::task::JoinHandle<()>>,
}

pub struct SyncEngine {
    workers: Mutex<HashMap<String, WorkerHandle>>,
    pool: SqlitePool,
    sink: Arc<dyn EventSink>,
}

impl SyncEngine {
    pub fn new(pool: SqlitePool, sink: Arc<dyn EventSink>) -> Arc<Self> {
        Arc::new(Self {
            workers: Mutex::new(HashMap::new()),
            pool,
            sink,
        })
    }

    /// Production constructor: emit over the Tauri WebView.
    pub fn new_tauri(pool: SqlitePool, app: AppHandle) -> Arc<Self> {
        Self::new(pool, Arc::new(TauriSink(app)))
    }

    /// Spawn a worker for every active account.
    pub async fn start(self: &Arc<Self>) -> Result<(), String> {
        let accs = accounts::get_all(&self.pool).await?;
        for a in accs.iter().filter(|a| a.is_active) {
            self.spawn_worker(a.id.clone()).await;
        }
        Ok(())
    }

    /// Ensure a worker exists for the account, then nudge it to sync immediately.
    pub async fn sync_account_now(self: &Arc<Self>, account_id: String) {
        self.ensure_worker(account_id.clone()).await;
        self.nudge_worker(&account_id).await;
    }

    /// Send a `SyncNow` to the account's worker if one is running. Does NOT
    /// spawn a worker (unlike [`sync_account_now`]) — used by the IDLE-watcher
    /// task, which already lives inside the worker it wants to nudge, so
    /// re-running `ensure_worker` would be both redundant and (more
    /// importantly) would make the watcher future `!Send`: `ensure_worker`
    /// transitively awaits `spawn_worker`, whose outer `tokio::spawn` requires
    /// the worker-loop future (which contains THIS watcher task) to be `Send`,
    /// creating a cycle. This helper breaks the cycle by only touching the
    /// workers map (cloning the sender out of the lock scope before awaiting).
    async fn nudge_worker(self: &Arc<Self>, account_id: &str) {
        let tx = {
            let ws = self.workers.lock().await;
            ws.get(account_id).map(|w| w.tx.clone())
        };
        if let Some(tx) = tx {
            let _ = tx.send(SyncOp::SyncNow).await;
        }
    }

    /// Ensure a worker exists for the account (no-op if already running).
    pub async fn ensure_worker(self: &Arc<Self>, account_id: String) {
        if self.workers.lock().await.contains_key(&account_id) {
            return;
        }
        self.spawn_worker(account_id).await;
    }

    async fn spawn_worker(self: &Arc<Self>, account_id: String) {
        // Validate the account + capture provider up front (skip silently if missing).
        let acc = match accounts::get_by_id(&self.pool, &account_id).await {
            Ok(Some(a)) => a,
            _ => {
                log::warn!("[sync] spawn_worker: account {account_id} not found");
                return;
            }
        };
        let provider = acc.provider.clone();

        let (tx, mut rx) = mpsc::channel::<SyncOp>(16);
        let engine = Arc::clone(self);
        let aid = account_id.clone();
        // Insert a placeholder handle up front so `ensure_worker`'s
        // contains_key check sees the worker as running before the spawn
        // finishes (avoids a double-spawn race if sync_account_now is
        // called concurrently). The idle_watcher slot is filled in below
        // once the first sync round has populated the caps cache.
        self.workers.lock().await.insert(
            account_id.clone(),
            WorkerHandle { tx: tx.clone(), idle_watcher: None },
        );
        tokio::spawn(async move {
            // Initial sync immediately — this also warms the source's caps
            // cache (ImapSource caches IDLE/CONDSTORE/etc. on the first
            // successful connect), so the strategy decision below sees the
            // server's real capabilities, not the default empty set.
            let _ = run_sync_round(&engine, &aid, &provider).await;

            // Strategy: if the source advertises IDLE, spawn a watcher for
            // INBOX that nudges a sync round on each notification. The poll
            // loop below stays as the background sweep for non-INBOX folders
            // + the fallback when IDLE is unavailable.
            let idle_watcher = {
                let src = crate::sync_engine::source_for_account(&engine.pool, &aid).await.ok();
                let caps = src.as_ref().map(|s| s.capabilities());
                match (src, caps) {
                    (Some(src), Some(caps)) if pick_realtime_strategy(&caps) == RealtimeStrategy::Idle => {
                        let engine2 = Arc::clone(&engine);
                        let aid2 = aid.clone();
                        let src2 = Arc::clone(&src);
                        // CANCELLATION CAVEAT (Phase 2 Task 2): async-imap 0.10.4's
                        // IDLE `Handle` has no `Drop` impl, so aborting this task
                        // (dropping the in-flight `watch()` future) leaves a dangling
                        // IDLE the server times out ~29 min later. This is ACCEPTABLE
                        // for Phase 2 — `stop_all` aborts the watcher on app shutdown
                        // and the next `watch()` reconnects cleanly. On the happy path
                        // (`Ok(())` on NewData) `watch()` calls `done()` cleanly and
                        // no leak occurs.
                        Some(tokio::spawn(async move {
                            loop {
                                // Resolve the INBOX folder (role=inbox) from the DB.
                                // The `remote_id` column holds the IMAP path (e.g.
                                // "INBOX"); `imap_folder_path` is labels-specific and
                                // only populated by other code paths, so we prefer
                                // `remote_id` (which always falls back to the label id
                                // on read — see `row_to_folder`).
                                let inbox = match crate::db::labels::get_folder_by_role(
                                    &engine2.pool, &aid2, "inbox",
                                ).await {
                                    Ok(Some(f)) => f,
                                    _ => {
                                        // No inbox row yet (initial sync may not have
                                        // persisted labels, e.g. a fresh account whose
                                        // first connect failed). Back off and retry.
                                        tokio::time::sleep(Duration::from_secs(60)).await;
                                        continue;
                                    }
                                };
                                let folder = RemoteFolder {
                                    remote_id: inbox.remote_id.clone(),
                                    name: inbox.name.clone(),
                                    delimiter: inbox.delimiter.clone().unwrap_or_else(|| "/".into()),
                                    role: Some("inbox".into()),
                                    ..Default::default()
                                };
                                match src2.watch(&folder).await {
                                    Ok(()) => {
                                        // Notification (or clean return) — nudge an
                                        // immediate sync round, then loop back into
                                        // watch(). We use `nudge_worker` (not
                                        // `sync_account_now`) because the worker is
                                        // already running — the watcher IS part of it —
                                        // and `sync_account_now`'s `ensure_worker` would
                                        // create a Send-cycle through `spawn_worker`.
                                        engine2.nudge_worker(&aid2).await;
                                    }
                                    Err(e) => {
                                        log::warn!("[sync] {aid2} IDLE err: {e}");
                                        // Brief backoff before reconnecting to avoid a
                                        // hot loop on persistent failures (e.g. server
                                        // flapping, dead socket).
                                        tokio::time::sleep(Duration::from_secs(30)).await;
                                    }
                                }
                            }
                        }))
                    }
                    _ => None,
                }
            };

            // Publish the watcher JoinHandle so stop_all can abort it.
            {
                let mut ws = engine.workers.lock().await;
                if let Some(h) = ws.get_mut(&aid) {
                    h.idle_watcher = idle_watcher;
                }
            }

            let mut tick = tokio::time::interval(Duration::from_secs(POLL_INTERVAL_SECS));
            // Drop the first immediate tick (we already synced above).
            tick.tick().await;
            loop {
                tokio::select! {
                    _ = tick.tick() => {
                        let _ = run_sync_round(&engine, &aid, &provider).await;
                    }
                    op = rx.recv() => match op {
                        Some(SyncOp::SyncNow) => {
                            let _ = run_sync_round(&engine, &aid, &provider).await;
                        }
                        Some(SyncOp::Shutdown) | None => break,
                    }
                }
            }
            // (the idle_watcher JoinHandle is aborted by stop_all / worker removal)
        });
    }

    /// Stop all workers (app shutdown / account removal). Sends Shutdown to each
    /// worker's poll loop AND aborts any per-account IDLE watcher task so it does
    /// not outlive its account.
    pub async fn stop_all(&self) {
        let mut ws = self.workers.lock().await;
        for (_, w) in ws.drain() {
            let _ = w.tx.send(SyncOp::Shutdown).await;
            if let Some(handle) = w.idle_watcher {
                handle.abort();
            }
        }
    }

    /// Fan a `sync:queue` event through the sink. Called by [`run_replay_round`]
    /// after each round so the UI's per-account pending badge stays in sync.
    fn emit_queue(&self, account_id: &str, pending: i64) {
        self.sink.emit_queue(QueueEvent {
            account_id: account_id.into(),
            pending,
        });
    }
}

/// Production round: resolve the source via the factory, then run.
async fn run_sync_round(engine: &Arc<SyncEngine>, account_id: &str, provider: &str) -> Result<(), String> {
    let src = source_for_account(&engine.pool, account_id).await?;
    run_sync_round_with_source(engine, account_id, provider, src.as_ref()).await
}

/// Drain this account's pending_operations queue through the `MailSource`.
/// Called at the end of every sync round (poll tick or `SyncNow`) so the
/// worker both pulls new mail and pushes queued writes in the same wake.
///
/// Mirrors [`run_sync_round_with_source`]'s test-seam shape: an explicit `src`
/// is passed in so unit tests can drive this without the source factory.
///
/// Flow per round:
/// 1. `compact_queue` — drop cancel-out toggle pairs (markRead/setFlag).
/// 2. `dequeue_pending_for_account` — up to 50 due rows, oldest-first.
/// 3. For each row: `MutationOp::from_pending` → `exec_via_source` →
///    `mark_completed` on Ok / `mark_failed` (with backoff) on Err.
/// 4. `pending_count_for_account` → `engine.emit_queue` so the UI badge updates.
async fn run_replay_round(engine: &Arc<SyncEngine>, account_id: &str, src: &dyn MailSource) {
    let pool = &engine.pool;
    if let Err(e) = crate::db::queue::compact_queue(pool, account_id).await {
        log::warn!("[sync] {account_id} compact_queue failed: {e}");
    }
    let ops = match crate::db::queue::dequeue_pending_for_account(pool, account_id, 50).await {
        Ok(o) => o,
        Err(e) => {
            log::warn!("[sync] {account_id} dequeue failed: {e}");
            return;
        }
    };
    for op in ops {
        let mop = match crate::db::mutations::MutationOp::from_pending(&op) {
            Ok(m) => m,
            Err(e) => {
                log::warn!("[sync] decode op {} failed: {e}", op.id);
                continue;
            }
        };
        match mop.exec_via_source(src).await {
            Ok(()) => {
                if let Err(e) = crate::db::queue::mark_completed(pool, &op.id).await {
                    log::warn!("[sync] mark_completed {} failed: {e}", op.id);
                }
            }
            Err(e) => {
                let msg = e.to_string();
                if let Err(e2) = crate::db::queue::mark_failed(pool, &op.id, &msg).await {
                    log::warn!("[sync] mark_failed {} failed: {e2}", op.id);
                }
            }
        }
    }
    let pending = crate::db::queue::pending_count_for_account(pool, account_id)
        .await
        .unwrap_or(0);
    engine.emit_queue(account_id, pending);
}

/// One sync round against an explicit source (test seam + reused by production).
async fn run_sync_round_with_source(
    engine: &Arc<SyncEngine>,
    account_id: &str,
    provider: &str,
    src: &dyn MailSource,
) -> Result<(), String> {
    engine.sink.emit_status(StatusEvent { account_id: account_id.into(), state: "syncing".into() });

    let folders = match src.list_folders().await {
        Ok(f) => f,
        Err(e) => {
            log::warn!("[sync] {account_id} list_folders failed: {e}");
            engine.sink.emit_status(StatusEvent { account_id: account_id.into(), state: "error".into() });
            return Err(e.to_string());
        }
    };

    // Persist the folder tree (RemoteFolder -> labels rows).
    for f in &folders {
        upsert_folder_label(&engine.pool, account_id, provider, f)
            .await
            .unwrap_or_else(|e| log::warn!("[sync] {account_id} upsert label {} failed: {e}", f.remote_id));
    }

    // Prune local labels whose remote_id is no longer on the server (renamed
    // or deleted from another client).
    let current_ids: HashSet<&str> = folders.iter().map(|f| f.remote_id.as_str()).collect();
    let _pruned = labels::prune_stale_labels(&engine.pool, account_id, provider, &current_ids)
        .await
        .unwrap_or_else(|e| {
            log::warn!("[sync] {account_id} prune stale labels failed: {e}");
            0
        });

    // Emit a labels delta so the frontend reloads the folder pane. We fire
    // this every round rather than tracking per-folder insert/update state
    // (which would require an extra SELECT before each INSERT and ~N extra
    // SQLite round-trips per sync tick). The frontend reload is a single
    // indexed read, and the event fires once per account per 60 s -- cheaper
    // than N extra queries per tick.
    engine.sink.emit_delta(DeltaEvent {
        op: "sync".into(),
        table: "labels".into(),
        account_id: account_id.into(),
        // Empty label_id = all-labels sentinel (folder-list delta, not a single-label delta).
        label_id: String::new(),
        count: 0,
    });

    // Per-folder delta sync.
    for f in &folders {
        let label_id = format!("{account_id}:{}", f.remote_id);
        let cursor = sync_state::get_imap_cursor(&engine.pool, account_id, &f.remote_id).await;
        let mut delta = match src.sync_folder(f, cursor).await {
            Ok(d) => d,
            Err(e) => {
                log::warn!("[sync] {account_id} sync_folder {} failed: {e}", f.remote_id);
                continue;
            }
        };

        // Compute vanished UIDs: local UIDs NOT in the server's full UID set.
        if !delta.server_uids.is_empty() {
            let server_set: HashSet<u32> = delta.server_uids.iter().copied().collect();
            if let Ok(local_uids) = messages::get_local_uids(&engine.pool, account_id, &f.remote_id).await {
                for uid in &local_uids {
                    if !server_set.contains(uid) {
                        delta.vanished_uids.push(*uid);
                    }
                }
            }
        }

        let counts = match messages::apply_folder_delta(&engine.pool, account_id, &label_id, &f.remote_id, &delta).await {
            Ok(c) => c,
            Err(e) => {
                log::warn!("[sync] {account_id} apply_folder_delta {} failed: {e}", f.remote_id);
                continue;
            }
        };
        // Advance the cursor (IMAP path; EAS cursors are advanced by EasSource in Task 10).
        if let Cursor::Imap { uidvalidity, highest_uid, highest_modseq } = &delta.next_cursor {
            let _ = sync_state::advance_imap_cursor(&engine.pool, account_id, &f.remote_id, *uidvalidity, *highest_uid, *highest_modseq).await;
        }
        if counts.added > 0 || counts.updated > 0 || counts.deleted > 0 {
            engine.sink.emit_delta(DeltaEvent {
                op: "persist".into(),
                table: "messages".into(),
                account_id: account_id.into(),
                label_id: label_id.clone(),
                count: (counts.added + counts.updated + counts.deleted) as i64,
            });
            if f.role.as_deref() == Some("inbox") {
                engine.sink.emit_new_mail(NewMailEvent {
                    account_id: account_id.into(),
                    folder_id: label_id,
                    count: counts.added as i64,
                });
            }
        }
    }

    let _ = accounts::touch_last_sync(&engine.pool, account_id).await;
    engine.sink.emit_status(StatusEvent { account_id: account_id.into(), state: "idle".into() });

    // Phase 1 Task 4: drain queued offline operations through the same source
    // we just used for the sync round. Runs on every poll tick AND on SyncNow,
    // since this is the tail of `run_sync_round_with_source`. Failures are
    // logged + retained with backoff (see `run_replay_round`).
    run_replay_round(engine, account_id, src).await;

    Ok(())
}

/// Map a RemoteFolder to a `labels` row (id = "{account}:{remote_id}").
/// Uses INSERT ON CONFLICT so repeated calls are idempotent.
async fn upsert_folder_label(pool: &SqlitePool, account_id: &str, source: &str, f: &RemoteFolder) -> Result<(), String> {
    let id = format!("{account_id}:{}", f.remote_id);
    let ty = if f.role.is_some() { "system" } else { "user" };
    sqlx::query(
        "INSERT INTO labels (id, account_id, name, type, visible, sort_order, source, role, parent_id,
            remote_id, delimiter, mail_class, hierarchical_name, unread_count, total_count)
         VALUES (?, ?, ?, ?, 1, 0, ?, ?, ?, ?, ?, 'mail', NULL, ?, ?)
         ON CONFLICT(account_id, id) DO UPDATE SET
           name = excluded.name, type = excluded.type, visible = excluded.visible,
           sort_order = excluded.sort_order, source = excluded.source, role = excluded.role,
           parent_id = excluded.parent_id, remote_id = excluded.remote_id,
           delimiter = excluded.delimiter, mail_class = excluded.mail_class,
           hierarchical_name = excluded.hierarchical_name",
    )
    .bind(&id)
    .bind(account_id)
    .bind(&f.name)
    .bind(ty)
    .bind(source)
    .bind(f.role.as_deref())
    .bind(f.parent_id.as_deref())
    .bind(&f.remote_id)
    .bind(&f.delimiter)
    .bind(f.unseen as i64)
    .bind(f.exists as i64)
    .execute(pool)
    .await
    .map_err(|e| e.to_string())?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::init_db;
    use crate::sync_engine::mock_source::MockSource;
    use crate::sync_engine::RemoteMessage;

    // NOTE: std::sync::Mutex (not tokio) — the EventSink::emit_* methods are sync
    // (Tauri emit is sync), so the sink must not use a runtime-aware lock.
    struct TestSink {
        deltas: std::sync::Mutex<Vec<DeltaEvent>>,
        new_mails: std::sync::Mutex<Vec<NewMailEvent>>,
        statuses: std::sync::Mutex<Vec<StatusEvent>>,
        queues: std::sync::Mutex<Vec<QueueEvent>>,
    }
    impl TestSink {
        fn new() -> Self {
            Self {
                deltas: std::sync::Mutex::new(vec![]),
                new_mails: std::sync::Mutex::new(vec![]),
                statuses: std::sync::Mutex::new(vec![]),
                queues: std::sync::Mutex::new(vec![]),
            }
        }
    }
    impl EventSink for TestSink {
        fn emit_delta(&self, e: DeltaEvent) { self.deltas.lock().unwrap().push(e); }
        fn emit_new_mail(&self, e: NewMailEvent) { self.new_mails.lock().unwrap().push(e); }
        fn emit_status(&self, e: StatusEvent) { self.statuses.lock().unwrap().push(e); }
        fn emit_queue(&self, e: QueueEvent) { self.queues.lock().unwrap().push(e); }
    }

    async fn seed_account(pool: &SqlitePool, id: &str) {
        sqlx::query("INSERT INTO accounts (id, email, provider) VALUES (?, ?, 'imap')")
            .bind(id)
            .bind(format!("{id}@x.com"))
            .execute(pool)
            .await
            .unwrap();
    }

    #[tokio::test]
    async fn run_round_syncs_inbox_and_emits_events() {
        let tmp = tempfile::tempdir().unwrap();
        let pool = init_db(tmp.path()).await.unwrap();
        seed_account(&pool, "a").await;

        let sink = Arc::new(TestSink::new());
        let engine = SyncEngine::new(pool.clone(), sink.clone());

        let folder = RemoteFolder {
            remote_id: "INBOX".into(),
            name: "INBOX".into(),
            delimiter: "/".into(),
            role: Some("inbox".into()),
            exists: 1,
            unseen: 1,
            ..Default::default()
        };
        let msgs = vec![RemoteMessage {
            uid: 1,
            folder: "INBOX".into(),
            message_id: Some("<m1>".into()),
            subject: Some("Hello".into()),
            date: 100,
            ..Default::default()
        }];
        let src = MockSource::new(vec![folder], msgs);

        run_sync_round_with_source(&engine, "a", "imap", &src).await.unwrap();

        // Message landed in the DB.
        let (n,): (i64,) = sqlx::query_as("SELECT COUNT(*) FROM messages WHERE account_id = 'a'")
            .fetch_one(&pool)
            .await
            .unwrap();
        assert_eq!(n, 1);
        // Label upserted.
        let (ln,): (i64,) = sqlx::query_as("SELECT COUNT(*) FROM labels WHERE account_id = 'a'")
            .fetch_one(&pool)
            .await
            .unwrap();
        assert_eq!(ln, 1);
        // Events fired.
        assert!(!sink.deltas.lock().unwrap().is_empty());
        assert!(!sink.new_mails.lock().unwrap().is_empty());
        let states: Vec<String> = sink.statuses.lock().unwrap().iter().map(|s| s.state.clone()).collect();
        assert!(states.contains(&"syncing".to_string()));
        assert!(states.contains(&"idle".to_string()));
        // Cursor advanced.
        assert_eq!(
            sync_state::get_imap_cursor(&pool, "a", "INBOX").await,
            Cursor::Imap { uidvalidity: 0, highest_uid: 1, highest_modseq: 0 }
        );
    }

    /// Regression: parent_id stores the parent's remote_id (provider-native id),
    /// which the frontend `buildFolderTree` matches against sibling `remoteId` values.
    /// The parent_id must be the raw IMAP path (e.g. "INBOX") not the label's DB id
    /// (e.g. "a:INBOX"), because the frontend lookup is keyed by remoteId.
    #[tokio::test]
    async fn parent_id_stores_parent_remote_id_for_frontend_tree_matching() {
        let tmp = tempfile::tempdir().unwrap();
        let pool = init_db(tmp.path()).await.unwrap();
        seed_account(&pool, "a").await;

        // Parent folder (INBOX) — system folder
        let parent = RemoteFolder {
            remote_id: "INBOX".into(),
            name: "Inbox".into(),
            delimiter: "/".into(),
            role: Some("inbox".into()),
            parent_id: None,
            ..Default::default()
        };
        upsert_folder_label(&pool, "a", "imap", &parent).await.unwrap();

        // Child folder (sub-folder of INBOX) — user folder
        let child = RemoteFolder {
            remote_id: "INBOX/KylinsTest".into(),
            name: "KylinsTest".into(),
            delimiter: "/".into(),
            role: None,
            parent_id: Some("INBOX".into()), // parent's remote_id (raw IMAP path)
            ..Default::default()
        };
        upsert_folder_label(&pool, "a", "imap", &child).await.unwrap();

        // A top-level folder with the same leaf name (different path, no parent)
        let top_level = RemoteFolder {
            remote_id: "KylinsTest".into(),
            name: "KylinsTest".into(),
            delimiter: "/".into(),
            role: None,
            parent_id: None,
            ..Default::default()
        };
        upsert_folder_label(&pool, "a", "imap", &top_level).await.unwrap();

        // Verify: child's parent_id stores the parent's remote_id (the IMAP path)
        let (child_parent_id,): (Option<String>,) = sqlx::query_as(
            "SELECT parent_id FROM labels WHERE account_id = 'a' AND remote_id = 'INBOX/KylinsTest'"
        ).fetch_one(&pool).await.unwrap();
        assert_eq!(child_parent_id.as_deref(), Some("INBOX"),
            "sub-folder parent_id must be the parent's remote_id, matching frontend buildFolderTree lookup");

        // Verify: the parent's remote_id column holds the IMAP path
        let (parent_remote_id,): (String,) = sqlx::query_as(
            "SELECT remote_id FROM labels WHERE account_id = 'a' AND id = 'a:INBOX'"
        ).fetch_one(&pool).await.unwrap();
        assert_eq!(parent_remote_id, "INBOX",
            "parent remote_id must match what child's parent_id references");

        // Verify: top-level folder has no parent
        let (top_parent_id,): (Option<String>,) = sqlx::query_as(
            "SELECT parent_id FROM labels WHERE account_id = 'a' AND remote_id = 'KylinsTest'"
        ).fetch_one(&pool).await.unwrap();
        assert_eq!(top_parent_id, None,
            "top-level folder with same name must not get a parent_id");

        // Verify: both "KylinsTest" folders exist and are distinct
        let (count,): (i64,) = sqlx::query_as(
            "SELECT COUNT(*) FROM labels WHERE account_id = 'a' AND name = 'KylinsTest'"
        ).fetch_one(&pool).await.unwrap();
        assert_eq!(count, 2, "two distinct folders named KylinsTest expected");
    }

    #[tokio::test]
    async fn run_round_advances_cursor_so_second_round_is_empty() {
        let tmp = tempfile::tempdir().unwrap();
        let pool = init_db(tmp.path()).await.unwrap();
        seed_account(&pool, "a").await;
        let sink = Arc::new(TestSink::new());
        let engine = SyncEngine::new(pool.clone(), sink.clone());
        let folder = RemoteFolder { remote_id: "INBOX".into(), name: "INBOX".into(), delimiter: "/".into(), role: None, ..Default::default() };
        let src = MockSource::new(
            vec![folder],
            vec![RemoteMessage { uid: 1, folder: "INBOX".into(), message_id: Some("<m1>".into()), date: 1, ..Default::default() }],
        );
        run_sync_round_with_source(&engine, "a", "imap", &src).await.unwrap();
        // Round 1: 1 message delta + 1 label delta
        assert_eq!(sink.deltas.lock().unwrap().len(), 2);
        // Round 2: no new messages + 1 label delta (emitted unconditionally per round)
        run_sync_round_with_source(&engine, "a", "imap", &src).await.unwrap();
        assert_eq!(sink.deltas.lock().unwrap().len(), 3);
    }

    // ---- Phase 1 Task 4: AccountWorker replay loop + sync:queue ----

    /// Seed one pending markRead op (one message = one row, matching how Task 3
    /// fans out). Used by the replay tests.
    async fn seed_pending_markread(pool: &SqlitePool, account_id: &str, op_id: &str, resource_id: &str, uid: u32, read: bool) {
        let params = serde_json::json!({
            "folderPath": "INBOX",
            "read": if read { 1 } else { 0 },
            "uids": [uid],
        }).to_string();
        sqlx::query(
            "INSERT INTO pending_operations (id, account_id, operation_type, resource_id, params, status, created_at)
             VALUES (?, ?, 'markRead', ?, ?, 'pending', 1)",
        )
        .bind(op_id)
        .bind(account_id)
        .bind(resource_id)
        .bind(&params)
        .execute(pool)
        .await
        .unwrap();
    }

    #[tokio::test]
    async fn run_replay_round_drains_pending_op_and_emits_queue_with_zero_pending() {
        let tmp = tempfile::tempdir().unwrap();
        let pool = init_db(tmp.path()).await.unwrap();
        seed_account(&pool, "a").await;
        seed_pending_markread(&pool, "a", "op-1", "msg-1", 42, true).await;

        let sink = Arc::new(TestSink::new());
        let engine = SyncEngine::new(pool.clone(), sink.clone());
        let src = MockSource::new(vec![], vec![]);

        run_replay_round(&engine, "a", &src).await;

        // Op was completed (deleted from the queue).
        let (cnt,): (i64,) = sqlx::query_as(
            "SELECT COUNT(*) FROM pending_operations WHERE account_id = 'a'",
        )
        .fetch_one(&pool)
        .await
        .unwrap();
        assert_eq!(cnt, 0, "completed op should be removed from the queue");

        // MockSource observed the set_flags call (markRead → \\Seen, add=read).
        assert_eq!(
            src.recorded_calls(),
            vec![crate::sync_engine::mock_source::RecordedCall::SetFlags {
                folder: "INBOX".into(),
                uids: vec![42],
                flag: "\\Seen".into(),
                add: true,
            }]
        );

        // sync:queue fired with pending=0.
        let qs = sink.queues.lock().unwrap().clone();
        assert_eq!(qs.len(), 1, "exactly one queue event should fire");
        assert_eq!(qs[0].account_id, "a");
        assert_eq!(qs[0].pending, 0);
    }

    #[tokio::test]
    async fn run_replay_round_failure_retains_op_and_applies_mark_failed_backoff() {
        // A MailSource whose set_flags always returns Unsupported → markRead replay fails.
        use async_trait::async_trait;
        struct FailingSource;
        #[async_trait]
        impl MailSource for FailingSource {
            fn capabilities(&self) -> crate::sync_engine::Capabilities {
                crate::sync_engine::Capabilities::default()
            }
            async fn list_folders(&self) -> Result<Vec<RemoteFolder>, crate::sync_engine::SourceError> {
                Ok(vec![])
            }
            async fn sync_folder(&self, _f: &RemoteFolder, _c: crate::sync_engine::Cursor) -> Result<crate::sync_engine::FolderDelta, crate::sync_engine::SourceError> {
                Err(crate::sync_engine::SourceError::Unsupported)
            }
            async fn fetch_body(&self, _f: &RemoteFolder, _u: u32) -> Result<Option<String>, crate::sync_engine::SourceError> {
                Err(crate::sync_engine::SourceError::Unsupported)
            }
            async fn set_flags(&self, _f: &RemoteFolder, _u: &[u32], _flag: &str, _add: bool) -> Result<(), crate::sync_engine::SourceError> {
                Err(crate::sync_engine::SourceError::Unsupported)
            }
            async fn move_messages(&self, _s: &RemoteFolder, _u: &[u32], _d: &RemoteFolder) -> Result<(), crate::sync_engine::SourceError> {
                Err(crate::sync_engine::SourceError::Unsupported)
            }
            async fn delete_messages(&self, _f: &RemoteFolder, _u: &[u32]) -> Result<(), crate::sync_engine::SourceError> {
                Err(crate::sync_engine::SourceError::Unsupported)
            }
            async fn append(&self, _f: &RemoteFolder, _r: &[u8], _fl: &[&str]) -> Result<(), crate::sync_engine::SourceError> {
                Err(crate::sync_engine::SourceError::Unsupported)
            }
            async fn send(&self, _r: &str) -> Result<(), crate::sync_engine::SourceError> {
                Err(crate::sync_engine::SourceError::Unsupported)
            }
        }

        let tmp = tempfile::tempdir().unwrap();
        let pool = init_db(tmp.path()).await.unwrap();
        seed_account(&pool, "a").await;
        seed_pending_markread(&pool, "a", "op-1", "msg-1", 42, true).await;

        let sink = Arc::new(TestSink::new());
        let engine = SyncEngine::new(pool.clone(), sink.clone());
        let src = FailingSource;

        run_replay_round(&engine, "a", &src).await;

        // Op retained (still pending) but retry_count bumped to 1 and next_retry_at scheduled.
        let row: (String, i64, Option<i64>) = sqlx::query_as(
            "SELECT status, retry_count, next_retry_at FROM pending_operations WHERE id = 'op-1'",
        )
        .fetch_one(&pool)
        .await
        .unwrap();
        assert_eq!(row.0, "pending", "status stays pending (1 < max_retries)");
        assert_eq!(row.1, 1, "retry_count incremented via mark_failed");
        assert!(row.2.is_some(), "next_retry_at scheduled by backoff");

        // sync:queue still fires — with pending=1, because the op is retained.
        let qs = sink.queues.lock().unwrap().clone();
        assert_eq!(qs.len(), 1);
        assert_eq!(qs[0].account_id, "a");
        assert_eq!(qs[0].pending, 1, "retained op counts toward pending");
    }

    // ---- Phase 2 Task 3: RealtimeStrategy decision ----
    //
    // The live IDLE watcher task needs a real IMAP socket (validated in Task 4
    // e2e), so the unit test covers only the DECISION: given a source's caps,
    // does `pick_realtime_strategy` pick `Idle` vs `Poll`? MockSource is used
    // only to produce caps — we never spawn the real watcher task here.

    use crate::sync_engine::Capabilities;

    #[test]
    fn pick_realtime_strategy_idle_when_source_advertises_idle() {
        // A MockSource configured with `idle: true` → strategy is Idle.
        let src = MockSource::new(vec![], vec![])
            .with_caps(Capabilities { idle: true, ..Default::default() });
        assert_eq!(pick_realtime_strategy(&src.capabilities()), RealtimeStrategy::Idle);
    }

    #[test]
    fn pick_realtime_strategy_poll_when_source_has_no_idle() {
        // Default caps (idle: false) → strategy is Poll (poll-only).
        let src = MockSource::new(vec![], vec![]);
        assert_eq!(pick_realtime_strategy(&src.capabilities()), RealtimeStrategy::Poll);
    }

    #[test]
    fn pick_realtime_strategy_poll_for_empty_default_caps() {
        // Bare default caps (no source) — the case before the first sync round
        // warms the ImapSource caps cache. Must be Poll so no watcher spawns.
        assert_eq!(pick_realtime_strategy(&Capabilities::default()), RealtimeStrategy::Poll);
    }
}
