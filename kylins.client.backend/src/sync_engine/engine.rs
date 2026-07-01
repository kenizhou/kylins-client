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
use tokio::sync::{mpsc, Mutex};

use crate::db::{accounts, labels, messages, sync_state};
use crate::mail::imap::session_manager::ImapSessionManager;
use crate::sync_engine::{source_for_account, Cursor, MailSource, RemoteFolder};

const POLL_INTERVAL_SECS: u64 = 60;

// ---- Phase 3f Task 3: circuit-breaker thresholds + cooldowns ----
//
// The breaker counts consecutive `list_folders` failures per account. At the
// SHORT threshold it enters a 15s cooldown; at the LONG threshold the cooldown
// escalates to 60s. A single successful round resets the counter to zero
// (clearing the slate). The breaker is in-memory only — fresh-start on every
// process launch, which is the correct semantics (a fresh process doesn't know
// the prior failure count and should try once normally). See Phase 3f plan
// Global Constraints for the rationale.
const BREAKER_THRESHOLD_SHORT: u32 = 3;
const BREAKER_THRESHOLD_LONG: u32 = 5;
const BREAKER_COOLDOWN_SHORT_SECS: i64 = 15;
const BREAKER_COOLDOWN_LONG_SECS: i64 = 60;

#[derive(Clone, Copy, Default)]
struct BreakerState {
    failures: u32,
    /// Epoch-seconds cooldown deadline. 0 = not cooling down.
    cooldown_until: i64,
}

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
    /// Stable message ids (`messages.id` shape: `imap-{account}-{folder}-{uid}`
    /// for IMAP) of the just-arrived messages, so the frontend can dedupe
    /// notifications per-message instead of per-batch. Empty when the source
    /// did not surface ids (the frontend falls back to count-only dedupe in
    /// that case). Populated from `delta.added` at the emit site.
    #[serde(default)]
    message_ids: Vec<String>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StatusEvent {
    account_id: String,
    state: String,
    /// Epoch-seconds payload. Carries `retry_after` for `rate_limited`,
    /// omitted (None) for `syncing` / `idle` / `error`. Phase 3g renders the
    /// status bar from this; here we only emit. Serialized as `null`-on-None
    /// via `skip_serializing_if` so the frontend TS type stays a single
    /// optional field (`detail?: number | null`) rather than a present/absent
    /// key flip.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub detail: Option<i64>,
}

/// Per-account pending-queue count, emitted after every replay round so the
/// UI can render "Offline — N pending" badges. Mirrors the other sync:* events.
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct QueueEvent {
    account_id: String,
    pending: i64,
}

/// One thread's freshly-derived preview snippet, carried in a
/// [`BodiesWrittenEvent`] so the frontend can patch `thread.snippet` in place
/// (scroll-preserving) without a re-read of `db_get_threads`.
#[derive(Clone, Serialize, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SnippetUpdate {
    pub thread_id: String,
    pub snippet: String,
}

/// Emitted ONCE at the end of `sync_request_bodies` with every message whose
/// body + snippet were freshly written this round. The frontend listens on
/// `sync:bodies-written` and patches the affected threads in one pass.
#[derive(Clone, Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct BodiesWrittenEvent {
    pub account_id: String,
    pub updates: Vec<SnippetUpdate>,
}

/// Emit seam. Production impl wraps a Tauri `AppHandle`; tests collect into vectors.
pub trait EventSink: Send + Sync {
    fn emit_delta(&self, evt: DeltaEvent);
    fn emit_new_mail(&self, evt: NewMailEvent);
    fn emit_status(&self, evt: StatusEvent);
    fn emit_queue(&self, evt: QueueEvent);
    /// Emitted once at the end of `sync_request_bodies` for every message
    /// whose body+snippet were freshly written. The frontend listens on
    /// `sync:bodies-written` and patches `thread.snippet` in place
    /// (scroll-preserving — react-virtualized #1837).
    fn emit_bodies_written(&self, evt: BodiesWrittenEvent);
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
    fn emit_bodies_written(&self, e: BodiesWrittenEvent) {
        let _ = self.0.emit("sync:bodies-written", e);
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
    /// Per-account consecutive-failure counter + cooldown. In-memory only —
    /// resets on restart (fresh-start semantics: a fresh process doesn't know
    /// the prior failure count and should try once normally). Counts
    /// `list_folders` failures only; per-folder `sync_folder` failures stay
    /// best-effort so one bad folder can't trip the whole account.
    breakers: Mutex<HashMap<String, BreakerState>>,
    /// Owns one persistent IMAP session per account. Constructed once, shared
    /// with every ImapSource the engine spawns. Held but unused by ImapSource's
    /// methods until Task 4 swaps `imap_client::connect()` per-call for
    /// `manager.execute(...)`; Task 3 is plumbing only (no behavior change).
    pub session_manager: Arc<ImapSessionManager>,
}

impl SyncEngine {
    pub fn new(pool: SqlitePool, sink: Arc<dyn EventSink>) -> Arc<Self> {
        Arc::new(Self {
            workers: Mutex::new(HashMap::new()),
            pool,
            sink,
            breakers: Mutex::new(HashMap::new()),
            session_manager: Arc::new(ImapSessionManager::new()),
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
            WorkerHandle {
                tx: tx.clone(),
                idle_watcher: None,
            },
        );
        // Capture the worker's JoinHandle so a supervisor can observe its exit.
        // Pre-fix the handle was discarded (detached spawn), which meant a
        // panic inside the worker loop was swallowed silently by tokio — the
        // panic went to stderr only (not the tauri-plugin-log file), and the
        // worker vanished with no log line, leaving the account's sync seemingly
        // "stuck" at the last emitted status. The supervisor below awaits the
        // handle and logs the exit cause (normal / cancelled / panicked) so the
        // log shows exactly when + why a worker died.
        let worker_handle: tokio::task::JoinHandle<()> = tokio::spawn(async move {
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
                let src = crate::sync_engine::source_for_account(
                    &engine.pool,
                    &aid,
                    &engine.session_manager,
                )
                .await
                .ok();
                let caps = src.as_ref().map(|s| s.capabilities());
                match (src, caps) {
                    (Some(src), Some(caps))
                        if pick_realtime_strategy(&caps) == RealtimeStrategy::Idle =>
                    {
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
                                    &engine2.pool,
                                    &aid2,
                                    "inbox",
                                )
                                .await
                                {
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
                                    delimiter: inbox
                                        .delimiter
                                        .clone()
                                        .unwrap_or_else(|| "/".into()),
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
            // The channel may close if the Sender is dropped unexpectedly (the
            // original `tx` local in spawn_worker is dropped when the function
            // returns; the clone in WorkerHandle *should* keep it alive, but
            // if it doesn't, `rx.recv()` returns None). Pre-fix, `None => break`
            // caused the worker to EXIT SILENTLY — sync stopped with no error.
            // Now: switch to tick-only mode (the 60s poll continues regardless
            // of channel state; SyncNow nudges are best-effort).
            let mut channel_open = true;
            loop {
                if channel_open {
                    tokio::select! {
                        _ = tick.tick() => {
                            let _ = run_sync_round(&engine, &aid, &provider).await;
                        }
                        op = rx.recv() => match op {
                            Some(SyncOp::SyncNow) => {
                                let _ = run_sync_round(&engine, &aid, &provider).await;
                            }
                            Some(SyncOp::Shutdown) => {
                                log::info!("[sync] {aid} worker received Shutdown; exiting");
                                break;
                            }
                            None => {
                                log::warn!("[sync] {aid} worker channel closed; switching to tick-only poll");
                                channel_open = false;
                            }
                        }
                    }
                } else {
                    // Channel closed — poll via tick only (no busy-loop).
                    tick.tick().await;
                    let _ = run_sync_round(&engine, &aid, &provider).await;
                }
            }
            // (the idle_watcher JoinHandle is aborted by stop_all / worker removal)
        });

        // Supervisor: log when the worker exits. A panic in the worker loop
        // surfaces here as `Err(join_err)` with `is_panic() == true` — without
        // this supervisor the panic is silent (tokio::spawn detaches, the
        // default JoinHandle drop does not await). The worker is never polled
        // after exit, so this supervisor runs exactly once per worker and then
        // itself exits. `aid_log` is captured by move so the supervisor is
        // self-contained (no borrow on `account_id` which is moved into the
        // worker above).
        let aid_log = account_id.clone();
        tokio::spawn(async move {
            match worker_handle.await {
                Ok(()) => log::warn!(
                    "[sync] worker for account {aid_log} exited normally"
                ),
                Err(join_err) => {
                    if join_err.is_panic() {
                        log::error!(
                            "[sync] worker for account {aid_log} PANICKED: {:?}",
                            join_err
                        );
                    } else {
                        log::warn!(
                            "[sync] worker for account {aid_log} cancelled: {join_err}"
                        );
                    }
                }
            }
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

    /// Fan a `sync:bodies-written` event through the sink. Called by
    /// [`commands::request_bodies_inner`] once at the end of a batched body
    /// fetch so the frontend patches every affected `thread.snippet` in one
    /// pass. Public so the commands layer (which owns the batch loop) can reach
    /// the private sink — mirrors how the other engine-internal emitters stay
    /// encapsulated while exposing a narrow command-facing surface.
    pub fn emit_bodies_written_public(&self, evt: BodiesWrittenEvent) {
        self.sink.emit_bodies_written(evt);
    }
}

/// Production round: resolve the source via the factory, then run.
async fn run_sync_round(
    engine: &Arc<SyncEngine>,
    account_id: &str,
    provider: &str,
) -> Result<(), String> {
    let src = source_for_account(&engine.pool, account_id, &engine.session_manager).await?;
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

// ---- Phase 3f Task 3: circuit-breaker helpers ----
//
// Pure-ish state mutations on `SyncEngine::breakers`. Each helper is a small,
// individually-testable unit; together they implement: cooldown-bypass read,
// record-failure (bump + maybe-set cooldown), record-success (reset). `now` is
// sourced from SQLite (`unixepoch()`) so the breaker's clock matches the same
// clock `provider_rate_limit` uses — the two short-circuits can be reasoned
// about against a single timebase.

/// Returns `Some(cooldown_until)` if the account is currently in breaker
/// cooldown, else `None`. Pure read — does not mutate the breaker state.
async fn breaker_cooldown(engine: &SyncEngine, account_id: &str) -> Option<i64> {
    let now = unix_now(&engine.pool).await;
    let bs = engine.breakers.lock().await;
    let state = bs.get(account_id).copied()?;
    if now < state.cooldown_until {
        Some(state.cooldown_until)
    } else {
        None
    }
}

/// Record a failed round: bump the failure counter and, when the new count
/// reaches the SHORT/LONG thresholds, schedule the matching cooldown. Between
/// thresholds the cooldown is whatever was last set at a threshold crossing
/// (i.e. once we enter cooldown we stay in cooldown until it expires, even
/// though subsequent bypass rounds don't bump the counter — they never reach
/// this function). Below the SHORT threshold no cooldown is set, just count.
async fn breaker_record_failure(engine: &SyncEngine, account_id: &str) {
    let now = unix_now(&engine.pool).await;
    let mut bs = engine.breakers.lock().await;
    let state = bs.entry(account_id.to_string()).or_default();
    state.failures = state.failures.saturating_add(1);
    let cd = if state.failures >= BREAKER_THRESHOLD_LONG {
        BREAKER_COOLDOWN_LONG_SECS
    } else if state.failures >= BREAKER_THRESHOLD_SHORT {
        BREAKER_COOLDOWN_SHORT_SECS
    } else {
        // Below threshold — accumulate the failure but do not cool down yet.
        return;
    };
    state.cooldown_until = now + cd;
}

/// Record a successful round: reset the counter to zero (remove the entry
/// entirely, which `or_default()` re-materializes as fresh on the next
/// failure). A single success after N failures clears the slate.
async fn breaker_record_success(engine: &SyncEngine, account_id: &str) {
    let mut bs = engine.breakers.lock().await;
    bs.remove(account_id);
}

/// Current wall-clock in epoch seconds, sourced from SQLite so the breaker and
/// the rate-limit short-circuit share one timebase. Falls back to 0 on a
/// transient SQLite blip — that would briefly disable cooldown bypass, which
/// is the safe fail-open direction (we re-try rather than wedge the account).
async fn unix_now(pool: &SqlitePool) -> i64 {
    let (now,): (i64,) = sqlx::query_as("SELECT unixepoch()")
        .fetch_one(pool)
        .await
        .unwrap_or((0,));
    now
}

/// One sync round against an explicit source (test seam + reused by production).
async fn run_sync_round_with_source(
    engine: &Arc<SyncEngine>,
    account_id: &str,
    provider: &str,
    src: &dyn MailSource,
) -> Result<(), String> {
    // ---- Phase 3f Task 2: rate-limit short-circuit ----
    // A live `provider_rate_limit` row skips the round entirely. This is NOT
    // an error: the server told us to back off, so we emit a distinct state
    // the UI can render ("Rate limited — retrying at X") and return Ok. The
    // failure/breaker counter is NOT bumped on this path. `get_rate_limit`
    // lazy-deletes an expired row, so a stale window self-heals on the next
    // wake (the fail-open `Err` arm logs + proceeds so a transient SQLite
    // blip does not wedge every account's sync).
    match crate::db::rate_limit::get_rate_limit(&engine.pool, account_id).await {
        Ok(Some(retry_after)) => {
            engine.sink.emit_status(StatusEvent {
                account_id: account_id.into(),
                state: "rate_limited".into(),
                detail: Some(retry_after),
            });
            return Ok(());
        }
        Ok(None) => {} // not limited — proceed
        Err(e) => log::warn!(
            "[sync] {account_id} rate_limit read failed (fail-open): {e}"
        ),
    }

    // ---- Phase 3f Task 3: circuit-breaker cooldown short-circuit ----
    // Distinct from rate-limit above: this counts OUR consecutive
    // `list_folders` failures, not a server-told-us-to-stop signal. The check
    // runs AFTER rate-limit so a live rate-limit window wins (rate-limit emits
    // `rate_limited`; breaker emits `error`). A cooldown-bypass round emits
    // `error` + `detail: Some(cooldown_until)` and returns Ok WITHOUT calling
    // the source and WITHOUT bumping the counter again (the counter was bumped
    // by the failure that triggered the cooldown; bypass rounds must not
    // escalate it further or the cooldown would never expire on a dead account).
    if let Some(cooldown_until) = breaker_cooldown(engine, account_id).await {
        engine.sink.emit_status(StatusEvent {
            account_id: account_id.into(),
            state: "error".into(),
            detail: Some(cooldown_until),
        });
        return Ok(());
    }

    engine.sink.emit_status(StatusEvent {
        account_id: account_id.into(),
        state: "syncing".into(),
        detail: None,
    });

    let folders = match src.list_folders().await {
        Ok(f) => f,
        Err(e) => {
            log::warn!("[sync] {account_id} list_folders failed: {e}");
            // Phase 3f Task 5: if the source signalled a rate limit, persist
            // the window so the NEXT round short-circuits at the top via the
            // rate-limit check. This is NOT a breaker failure (the server told
            // us to wait, not a dead socket), so do NOT bump the counter —
            // other Err variants keep the existing breaker-bump path.
            match &e {
                crate::sync_engine::SourceError::RateLimited { retry_after } => {
                    if let Err(e2) = crate::db::rate_limit::set_rate_limit(
                        &engine.pool,
                        account_id,
                        *retry_after,
                    )
                    .await
                    {
                        log::warn!("[sync] {account_id} set_rate_limit failed: {e2}");
                    }
                }
                _ => breaker_record_failure(engine, account_id).await,
            }
            engine.sink.emit_status(StatusEvent {
                account_id: account_id.into(),
                state: "error".into(),
                detail: None,
            });
            return Err(e.to_string());
        }
    };

    // Persist the folder tree (RemoteFolder -> labels rows).
    for f in &folders {
        upsert_folder_label(&engine.pool, account_id, provider, f)
            .await
            .unwrap_or_else(|e| {
                log::warn!(
                    "[sync] {account_id} upsert label {} failed: {e}",
                    f.remote_id
                )
            });
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
        // Source-owned cursor load: each source reads its own persisted cursor
        // (ImapSource -> folder_sync_state, EasSource -> eas_sync_state). The
        // previous unconditional `sync_state::get_imap_cursor` here handed an
        // `Cursor::Imap` to EAS sources, so `EasSource::sync_folder` fell through
        // to its non-Eas branch and re-bootstrapped (sync_key "0") every round.
        let cursor = src.load_cursor(&engine.pool, account_id, &f.remote_id).await;
        let delta = match src.sync_folder(f, cursor).await {
            Ok(d) => d,
            Err(e) => {
                log::warn!(
                    "[sync] {account_id} sync_folder {} failed: {e}",
                    f.remote_id
                );
                continue;
            }
        };
        let counts = match messages::apply_folder_delta(
            &engine.pool,
            account_id,
            &label_id,
            &f.remote_id,
            &delta,
        )
        .await
        {
            Ok(c) => c,
            Err(e) => {
                log::warn!(
                    "[sync] {account_id} apply_folder_delta {} failed: {e}",
                    f.remote_id
                );
                continue;
            }
        };
        // Advance the cursor. Each source owns its own cursor payload and its
        // own persistence call (IMAP merges monotonically; EAS overwrites the
        // opaque sync_key). The branches are mutually exclusive — a delta from
        // a given source only ever carries that source's cursor kind.
        if let Cursor::Imap {
            uidvalidity,
            highest_uid,
            highest_modseq,
        } = &delta.next_cursor
        {
            let _ = sync_state::advance_imap_cursor(
                &engine.pool,
                account_id,
                &f.remote_id,
                *uidvalidity,
                *highest_uid,
                *highest_modseq,
            )
            .await;
        }
        if let Cursor::Eas {
            collection_id,
            sync_key,
        } = &delta.next_cursor
        {
            let _ = sync_state::advance_eas_cursor(
                &engine.pool,
                account_id,
                &f.remote_id,
                collection_id,
                sync_key,
            )
            .await;
        }
        // Emit a `sync:delta{messages}` only when the round actually changed
        // something — a no-op round (cursor advanced but DB unchanged: 0 added,
        // 0 updated, 0 deleted) must NOT emit. Pre-fix this was guarded by
        // `counts.added > 0` alone, which (a) skipped legitimate flag-update /
        // expunge rounds (the UI never learned a message was marked read on
        // another client via CONDSTORE, or expunged server-side), and (b) still
        // fired every poll round on accounts that see a constant trickle of new
        // mail (the symptom behind the "message list fully refreshed every 60s"
        // bug). Adding updated/deleted to the guard fixes (a); the per-folder
        // burst is collapsed on the frontend via a trailing debounce in
        // `useSyncEvents`. The count field carries `added` (the most common
        // case + what the new-mail path needs); updated/deleted are signalled
        // by the event's existence, not the count — the frontend reloads the
        // page either way.
        if counts.added > 0 || counts.updated > 0 || counts.deleted > 0 {
            engine.sink.emit_delta(DeltaEvent {
                op: "persist".into(),
                table: "messages".into(),
                account_id: account_id.into(),
                label_id: label_id.clone(),
                count: counts.added as i64,
            });
            if f.role.as_deref() == Some("inbox") {
                // Collect the stable message ids (`messages.id` shape) of the
                // just-arrived messages so the frontend can dedupe
                // notifications per-message. `delta.added` is the same slice
                // `apply_folder_delta` just persisted, and `m.folder` is the
                // IMAP path matching the `imap-{account}-{folder}-{uid}` id
                // built in `db::messages::upsert_message`. `Vec::with_capacity`
                // + `push` keeps this O(n) with one allocation.
                let mut added_ids: Vec<String> = Vec::with_capacity(delta.added.len());
                for m in &delta.added {
                    added_ids.push(format!("imap-{account_id}-{}-{}", m.folder, m.uid));
                }
                engine.sink.emit_new_mail(NewMailEvent {
                    account_id: account_id.into(),
                    folder_id: label_id,
                    count: counts.added as i64,
                    message_ids: added_ids,
                });
            }
        }
    }

    let _ = accounts::touch_last_sync(&engine.pool, account_id).await;
    // Successful round end-to-end (list_folders + at least the folder iteration
    // completed without early-return): reset the breaker so a later outage must
    // accumulate fresh failures before tripping again. Per-folder sync_folder
    // failures are best-effort (logged + continue) and do not block this reset
    // — the account is reachable, individual folder hiccups should not preserve
    // a stale failure count.
    breaker_record_success(engine, account_id).await;
    engine.sink.emit_status(StatusEvent {
        account_id: account_id.into(),
        state: "idle".into(),
        detail: None,
    });

    // Phase 1 Task 4: drain queued offline operations through the same source
    // we just used for the sync round. Runs on every poll tick AND on SyncNow,
    // since this is the tail of `run_sync_round_with_source`. Failures are
    // logged + retained with backoff (see `run_replay_round`).
    run_replay_round(engine, account_id, src).await;

    Ok(())
}

/// Map a RemoteFolder to a `labels` row (id = "{account}:{remote_id}").
/// Uses INSERT ON CONFLICT so repeated calls are idempotent.
async fn upsert_folder_label(
    pool: &SqlitePool,
    account_id: &str,
    source: &str,
    f: &RemoteFolder,
) -> Result<(), String> {
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
        bodies_written: std::sync::Mutex<Vec<BodiesWrittenEvent>>,
    }
    impl TestSink {
        fn new() -> Self {
            Self {
                deltas: std::sync::Mutex::new(vec![]),
                new_mails: std::sync::Mutex::new(vec![]),
                statuses: std::sync::Mutex::new(vec![]),
                queues: std::sync::Mutex::new(vec![]),
                bodies_written: std::sync::Mutex::new(vec![]),
            }
        }
    }
    impl EventSink for TestSink {
        fn emit_delta(&self, e: DeltaEvent) {
            self.deltas.lock().unwrap().push(e);
        }
        fn emit_new_mail(&self, e: NewMailEvent) {
            self.new_mails.lock().unwrap().push(e);
        }
        fn emit_status(&self, e: StatusEvent) {
            self.statuses.lock().unwrap().push(e);
        }
        fn emit_queue(&self, e: QueueEvent) {
            self.queues.lock().unwrap().push(e);
        }
        fn emit_bodies_written(&self, e: BodiesWrittenEvent) {
            self.bodies_written.lock().unwrap().push(e);
        }
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

        run_sync_round_with_source(&engine, "a", "imap", &src)
            .await
            .unwrap();

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
        let states: Vec<String> = sink
            .statuses
            .lock()
            .unwrap()
            .iter()
            .map(|s| s.state.clone())
            .collect();
        assert!(states.contains(&"syncing".to_string()));
        assert!(states.contains(&"idle".to_string()));
        // Cursor advanced.
        assert_eq!(
            sync_state::get_imap_cursor(&pool, "a", "INBOX").await,
            Cursor::Imap {
                uidvalidity: 0,
                highest_uid: 1,
                highest_modseq: 0
            }
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
        upsert_folder_label(&pool, "a", "imap", &parent)
            .await
            .unwrap();

        // Child folder (sub-folder of INBOX) — user folder
        let child = RemoteFolder {
            remote_id: "INBOX/KylinsTest".into(),
            name: "KylinsTest".into(),
            delimiter: "/".into(),
            role: None,
            parent_id: Some("INBOX".into()), // parent's remote_id (raw IMAP path)
            ..Default::default()
        };
        upsert_folder_label(&pool, "a", "imap", &child)
            .await
            .unwrap();

        // A top-level folder with the same leaf name (different path, no parent)
        let top_level = RemoteFolder {
            remote_id: "KylinsTest".into(),
            name: "KylinsTest".into(),
            delimiter: "/".into(),
            role: None,
            parent_id: None,
            ..Default::default()
        };
        upsert_folder_label(&pool, "a", "imap", &top_level)
            .await
            .unwrap();

        // Verify: child's parent_id stores the parent's remote_id (the IMAP path)
        let (child_parent_id,): (Option<String>,) = sqlx::query_as(
            "SELECT parent_id FROM labels WHERE account_id = 'a' AND remote_id = 'INBOX/KylinsTest'"
        ).fetch_one(&pool).await.unwrap();
        assert_eq!(child_parent_id.as_deref(), Some("INBOX"),
            "sub-folder parent_id must be the parent's remote_id, matching frontend buildFolderTree lookup");

        // Verify: the parent's remote_id column holds the IMAP path
        let (parent_remote_id,): (String,) = sqlx::query_as(
            "SELECT remote_id FROM labels WHERE account_id = 'a' AND id = 'a:INBOX'",
        )
        .fetch_one(&pool)
        .await
        .unwrap();
        assert_eq!(
            parent_remote_id, "INBOX",
            "parent remote_id must match what child's parent_id references"
        );

        // Verify: top-level folder has no parent
        let (top_parent_id,): (Option<String>,) = sqlx::query_as(
            "SELECT parent_id FROM labels WHERE account_id = 'a' AND remote_id = 'KylinsTest'",
        )
        .fetch_one(&pool)
        .await
        .unwrap();
        assert_eq!(
            top_parent_id, None,
            "top-level folder with same name must not get a parent_id"
        );

        // Verify: both "KylinsTest" folders exist and are distinct
        let (count,): (i64,) = sqlx::query_as(
            "SELECT COUNT(*) FROM labels WHERE account_id = 'a' AND name = 'KylinsTest'",
        )
        .fetch_one(&pool)
        .await
        .unwrap();
        assert_eq!(count, 2, "two distinct folders named KylinsTest expected");
    }

    #[tokio::test]
    async fn run_round_advances_cursor_so_second_round_is_empty() {
        let tmp = tempfile::tempdir().unwrap();
        let pool = init_db(tmp.path()).await.unwrap();
        seed_account(&pool, "a").await;
        let sink = Arc::new(TestSink::new());
        let engine = SyncEngine::new(pool.clone(), sink.clone());
        let folder = RemoteFolder {
            remote_id: "INBOX".into(),
            name: "INBOX".into(),
            delimiter: "/".into(),
            role: None,
            ..Default::default()
        };
        let src = MockSource::new(
            vec![folder],
            vec![RemoteMessage {
                uid: 1,
                folder: "INBOX".into(),
                message_id: Some("<m1>".into()),
                date: 1,
                ..Default::default()
            }],
        );
        run_sync_round_with_source(&engine, "a", "imap", &src)
            .await
            .unwrap();
        // Round 1: 1 message delta + 1 label delta
        assert_eq!(sink.deltas.lock().unwrap().len(), 2);
        // Round 2: no new messages + 1 label delta (emitted unconditionally per round)
        run_sync_round_with_source(&engine, "a", "imap", &src)
            .await
            .unwrap();
        assert_eq!(sink.deltas.lock().unwrap().len(), 3);
    }

    // ---- Phase 3f Task 2: rate-limit short-circuit ----
    //
    // When provider_rate_limit has a live row, run_sync_round_with_source MUST
    // skip the source entirely (Ok, not Err) and emit `rate_limited` with the
    // retry_after payload. Distinct from any failure/breaker path: the server
    // told us to back off, so we oblige.

    use crate::db::rate_limit;

    /// When provider_rate_limit has a live row, run_sync_round_with_source MUST:
    ///   - emit exactly one sync:status { state: "rate_limited", detail: <epoch> }
    ///   - NOT call list_folders on the source (the source's recorded calls
    ///     stay empty AND no messages land in the DB, proving sync_folder was
    ///     never drained)
    ///   - return Ok(()) (rate-limiting is not an error)
    ///   - NOT advance the cursor or touch last_sync_at
    #[tokio::test]
    async fn run_round_skips_when_rate_limited_and_emits_status() {
        let tmp = tempfile::tempdir().unwrap();
        let pool = init_db(tmp.path()).await.unwrap();
        seed_account(&pool, "a").await;
        // Seed a live rate-limit window 300s in the future.
        let retry_after = sqlx::query_as::<_, (i64,)>("SELECT unixepoch() + 300")
            .fetch_one(&pool)
            .await
            .unwrap()
            .0;
        rate_limit::set_rate_limit(&pool, "a", retry_after)
            .await
            .unwrap();

        let sink = Arc::new(TestSink::new());
        let engine = SyncEngine::new(pool.clone(), sink.clone());
        // MockSource with a folder + a message that must NEVER be fetched.
        let src = MockSource::new(
            vec![RemoteFolder {
                remote_id: "INBOX".into(),
                name: "INBOX".into(),
                delimiter: "/".into(),
                role: Some("inbox".into()),
                ..Default::default()
            }],
            vec![RemoteMessage {
                uid: 1,
                folder: "INBOX".into(),
                message_id: Some("<m1>".into()),
                ..Default::default()
            }],
        );

        run_sync_round_with_source(&engine, "a", "imap", &src)
            .await
            .unwrap();

        // Source was never touched (no mutation calls recorded; the DB count
        // below proves sync_folder was never drained either).
        assert!(src.recorded_calls().is_empty(),
            "rate-limited round must not call the source");
        // No messages landed in the DB.
        let (n,): (i64,) = sqlx::query_as("SELECT COUNT(*) FROM messages WHERE account_id = 'a'")
            .fetch_one(&pool)
            .await
            .unwrap();
        assert_eq!(n, 0);

        // Exactly one status event, and it is rate_limited with the detail.
        let statuses = sink.statuses.lock().unwrap().clone();
        assert_eq!(
            statuses.len(),
            1,
            "rate-limited round emits one status, not syncing+idle"
        );
        assert_eq!(statuses[0].state, "rate_limited");
        assert_eq!(statuses[0].detail, Some(retry_after));
        assert_eq!(statuses[0].account_id, "a");
    }

    /// After the rate-limit window passes, the next round runs normally
    /// (lazy-delete on read un-wedges the account without manual clear).
    #[tokio::test]
    async fn run_round_runs_normally_after_rate_limit_window_expires() {
        let tmp = tempfile::tempdir().unwrap();
        let pool = init_db(tmp.path()).await.unwrap();
        seed_account(&pool, "a").await;
        // Expired row.
        let past = sqlx::query_as::<_, (i64,)>("SELECT unixepoch() - 100")
            .fetch_one(&pool)
            .await
            .unwrap()
            .0;
        rate_limit::set_rate_limit(&pool, "a", past).await.unwrap();

        let sink = Arc::new(TestSink::new());
        let engine = SyncEngine::new(pool.clone(), sink.clone());
        let src = MockSource::new(
            vec![RemoteFolder {
                remote_id: "INBOX".into(),
                name: "INBOX".into(),
                delimiter: "/".into(),
                role: Some("inbox".into()),
                ..Default::default()
            }],
            vec![RemoteMessage {
                uid: 1,
                folder: "INBOX".into(),
                message_id: Some("<m1>".into()),
                ..Default::default()
            }],
        );

        run_sync_round_with_source(&engine, "a", "imap", &src)
            .await
            .unwrap();

        // Normal round: syncing ... idle.
        let states: Vec<String> = sink
            .statuses
            .lock()
            .unwrap()
            .iter()
            .map(|s| s.state.clone())
            .collect();
        assert!(states.contains(&"syncing".to_string()));
        assert!(states.contains(&"idle".to_string()));
        assert!(!states.contains(&"rate_limited".to_string()));
        // And the stale row was lazy-deleted.
        let (cnt,): (i64,) = sqlx::query_as(
            "SELECT COUNT(*) FROM provider_rate_limit WHERE account_id = 'a'",
        )
        .fetch_one(&pool)
        .await
        .unwrap();
        assert_eq!(cnt, 0);
    }

    // ---- Phase 3f Task 3: per-account circuit breaker ----
    //
    // The breaker is an in-memory consecutive-`list_folders`-failure counter per
    // account with escalating cooldowns (3 -> 15s, 5 -> 60s). It is DISTINCT from
    // rate-limit mode (server authority): rate-limit short-circuits first and
    // wins; the breaker is our own failure counter. Breaker-tripped rounds emit
    // `error` state with `detail: Some(cooldown_until)` and skip the source
    // entirely (Ok, not Err). Per-folder `sync_folder` failures do NOT bump the
    // breaker (one bad folder must not trip the whole account).

    /// A MailSource whose `list_folders` always errors — simulates a dead socket
    /// / expired token, the exact connectivity storm the breaker exists to calm.
    /// All other methods return `Unsupported` (shape copied from the existing
    /// `FailingSource` in `run_replay_round_failure_retains_op...`).
    struct ListFoldersFailingSource;
    #[async_trait::async_trait]
    impl MailSource for ListFoldersFailingSource {
        fn capabilities(&self) -> crate::sync_engine::Capabilities {
            crate::sync_engine::Capabilities::default()
        }
        async fn list_folders(
            &self,
        ) -> Result<Vec<RemoteFolder>, crate::sync_engine::SourceError> {
            Err(crate::sync_engine::SourceError::Other("simulated outage".into()))
        }
        async fn sync_folder(
            &self,
            _f: &RemoteFolder,
            _c: crate::sync_engine::Cursor,
        ) -> Result<crate::sync_engine::FolderDelta, crate::sync_engine::SourceError> {
            Err(crate::sync_engine::SourceError::Unsupported)
        }
        async fn fetch_body(
            &self,
            _f: &RemoteFolder,
            _u: u32,
        ) -> Result<Option<String>, crate::sync_engine::SourceError> {
            Err(crate::sync_engine::SourceError::Unsupported)
        }
        async fn set_flags(
            &self,
            _f: &RemoteFolder,
            _u: &[u32],
            _flag: &str,
            _add: bool,
        ) -> Result<(), crate::sync_engine::SourceError> {
            Err(crate::sync_engine::SourceError::Unsupported)
        }
        async fn move_messages(
            &self,
            _s: &RemoteFolder,
            _u: &[u32],
            _d: &RemoteFolder,
        ) -> Result<(), crate::sync_engine::SourceError> {
            Err(crate::sync_engine::SourceError::Unsupported)
        }
        async fn delete_messages(
            &self,
            _f: &RemoteFolder,
            _u: &[u32],
        ) -> Result<(), crate::sync_engine::SourceError> {
            Err(crate::sync_engine::SourceError::Unsupported)
        }
        async fn append(
            &self,
            _f: &RemoteFolder,
            _r: &[u8],
            _fl: &[&str],
        ) -> Result<(), crate::sync_engine::SourceError> {
            Err(crate::sync_engine::SourceError::Unsupported)
        }
        async fn send(&self, _r: &str) -> Result<(), crate::sync_engine::SourceError> {
            Err(crate::sync_engine::SourceError::Unsupported)
        }
    }

    /// After N consecutive `list_folders` failures the breaker enters cooldown:
    /// the next round emits `error` + `detail=cooldown_until` and returns Ok
    /// WITHOUT calling the source. Covers: (a) N-1 failures don't trip; (b) 3rd
    /// failure -> 15s cooldown and the 4th round is short-circuited.
    #[tokio::test]
    async fn breaker_enters_cooldown_after_threshold_consecutive_failures() {
        let tmp = tempfile::tempdir().unwrap();
        let pool = init_db(tmp.path()).await.unwrap();
        seed_account(&pool, "a").await;
        let sink = Arc::new(TestSink::new());
        let engine = SyncEngine::new(pool.clone(), sink.clone());
        let src = ListFoldersFailingSource;

        // Drive BREAKER_THRESHOLD_SHORT (3) failing rounds. Each emits
        // syncing + error.
        for _ in 0..BREAKER_THRESHOLD_SHORT {
            let _ = run_sync_round_with_source(&engine, "a", "imap", &src).await;
        }

        // The round AFTER the threshold crossing must short-circuit: ONE status
        // event = { error, detail=Some(..) } and the source's list_folders is
        // NOT called again (we cannot directly assert call count on
        // ListFoldersFailingSource, but the single-event signature distinguishes
        // the cooldown-bypass path from the normal failure path which would
        // emit syncing THEN error).
        sink.statuses.lock().unwrap().clear();
        run_sync_round_with_source(&engine, "a", "imap", &src)
            .await
            .unwrap();
        let statuses = sink.statuses.lock().unwrap().clone();
        assert_eq!(
            statuses.len(),
            1,
            "cooldown round emits exactly one status (no `syncing`)"
        );
        assert_eq!(statuses[0].state, "error");
        assert_eq!(statuses[0].account_id, "a");
        assert!(
            statuses[0].detail.is_some(),
            "breaker cooldown detail is an epoch seconds value"
        );
        // Sanity: the recorded cooldown is roughly now + 15s (allow slack for
        // test latency). This pins the SHORT cooldown value, not just "some
        // future epoch".
        let now: (i64,) = sqlx::query_as("SELECT unixepoch()")
            .fetch_one(&pool)
            .await
            .unwrap();
        let cd = statuses[0].detail.unwrap();
        assert!(
            cd >= now.0 + BREAKER_COOLDOWN_SHORT_SECS - 5
                && cd <= now.0 + BREAKER_COOLDOWN_SHORT_SECS + 5,
            "short-threshold cooldown should be ~now+{}s, got now={} cd={}",
            BREAKER_COOLDOWN_SHORT_SECS,
            now.0,
            cd
        );
    }

    /// At the LONG threshold (5 consecutive failures) the cooldown escalates to
    /// 60s. Drives 5 failing rounds then asserts the 6th is short-circuited with
    /// a ~now+60s detail.
    #[tokio::test]
    async fn breaker_escalates_to_long_cooldown_at_five_failures() {
        let tmp = tempfile::tempdir().unwrap();
        let pool = init_db(tmp.path()).await.unwrap();
        seed_account(&pool, "a").await;
        let sink = Arc::new(TestSink::new());
        let engine = SyncEngine::new(pool.clone(), sink.clone());
        let src = ListFoldersFailingSource;

        // 4 failures: at SHORT threshold after the 3rd, the 4th round is
        // short-circuited (cooldown active). The 5th call below still must NOT
        // call the source (still in cooldown from failure #3 -> the counter
        // does not advance on a bypass round). To actually reach failure #5 we
        // must drive past the short cooldown. Instead of sleeping 15s in the
        // test, we directly mutate the breaker to simulate the post-cooldown
        // state where failures=3 + cooldown_until expired, then drive 2 more
        // failing rounds to reach failures=5.
        //
        // Failure path #1..#3 (3rd triggers 15s cooldown).
        for _ in 0..3 {
            let _ = run_sync_round_with_source(&engine, "a", "imap", &src).await;
        }
        // 4th call: bypassed (in cooldown) — counter unchanged at 3.
        let _ = run_sync_round_with_source(&engine, "a", "imap", &src).await;

        // Expire the short cooldown so the next failure actually reaches the
        // engine + bumps the counter. We rewrite cooldown_until to the past.
        {
            let mut bs = engine.breakers.lock().await;
            let state = bs.get_mut("a").expect("breaker seeded by failures above");
            state.cooldown_until = 0; // expire immediately
        }
        // Failure #4 -> still SHORT (3 < failures=4 < 5): bumps to 4, cooldown
        // 15s.
        let _ = run_sync_round_with_source(&engine, "a", "imap", &src).await;
        // Bypass the new 15s cooldown again.
        {
            let mut bs = engine.breakers.lock().await;
            let state = bs.get_mut("a").unwrap();
            state.cooldown_until = 0;
        }
        // Failure #5 -> LONG threshold: bumps to 5, cooldown 60s.
        let _ = run_sync_round_with_source(&engine, "a", "imap", &src).await;

        // The next round must be bypassed with detail ~= now + 60s.
        sink.statuses.lock().unwrap().clear();
        run_sync_round_with_source(&engine, "a", "imap", &src)
            .await
            .unwrap();
        let statuses = sink.statuses.lock().unwrap().clone();
        assert_eq!(statuses.len(), 1, "post-long-threshold bypass: one status");
        assert_eq!(statuses[0].state, "error");
        let cd = statuses[0].detail.expect("long-cooldown detail present");
        let now: (i64,) = sqlx::query_as("SELECT unixepoch()")
            .fetch_one(&pool)
            .await
            .unwrap();
        assert!(
            cd >= now.0 + BREAKER_COOLDOWN_LONG_SECS - 5
                && cd <= now.0 + BREAKER_COOLDOWN_LONG_SECS + 5,
            "long-threshold cooldown should be ~now+{}s, got now={} cd={}",
            BREAKER_COOLDOWN_LONG_SECS,
            now.0,
            cd
        );
    }

    /// A single successful round resets the breaker to zero failures, so a later
    /// outage must accumulate fresh failures before tripping again.
    #[tokio::test]
    async fn breaker_resets_to_zero_on_successful_round() {
        let tmp = tempfile::tempdir().unwrap();
        let pool = init_db(tmp.path()).await.unwrap();
        seed_account(&pool, "a").await;
        let sink = Arc::new(TestSink::new());
        let engine = SyncEngine::new(pool.clone(), sink.clone());

        // Two failures (below threshold).
        for _ in 0..2 {
            let _ =
                run_sync_round_with_source(&engine, "a", "imap", &ListFoldersFailingSource).await;
        }
        // Then a successful round (MockSource with an empty folder list).
        let ok_src = MockSource::new(vec![], vec![]);
        run_sync_round_with_source(&engine, "a", "imap", &ok_src)
            .await
            .unwrap();

        // Breaker should be reset. Two more failures must NOT trip the breaker
        // yet (would need a 3rd). Verify the two post-reset failure rounds still
        // go through the normal syncing -> error path (two events each), NOT the
        // one-event cooldown bypass.
        sink.statuses.lock().unwrap().clear();
        for _ in 0..2 {
            let _ =
                run_sync_round_with_source(&engine, "a", "imap", &ListFoldersFailingSource).await;
        }
        let len_after_two_failures = sink.statuses.lock().unwrap().len();
        assert!(
            len_after_two_failures >= 4,
            "two normal failure rounds each emit syncing+error (>=4 events); \
             a cooldown bypass would emit 1 (got {len_after_two_failures})"
        );
    }

    /// A MailSource whose `list_folders` returns `SourceError::RateLimited` —
    /// simulates an EAS 429 with Retry-After. All other methods return
    /// `Unsupported` (shape copied from `ListFoldersFailingSource`).
    struct RateLimitedSource {
        retry_after: i64,
    }
    #[async_trait::async_trait]
    impl MailSource for RateLimitedSource {
        fn capabilities(&self) -> crate::sync_engine::Capabilities {
            crate::sync_engine::Capabilities::default()
        }
        async fn list_folders(
            &self,
        ) -> Result<Vec<RemoteFolder>, crate::sync_engine::SourceError> {
            Err(crate::sync_engine::SourceError::RateLimited {
                retry_after: self.retry_after,
            })
        }
        async fn sync_folder(
            &self,
            _f: &RemoteFolder,
            _c: crate::sync_engine::Cursor,
        ) -> Result<crate::sync_engine::FolderDelta, crate::sync_engine::SourceError> {
            Err(crate::sync_engine::SourceError::Unsupported)
        }
        async fn fetch_body(
            &self,
            _f: &RemoteFolder,
            _u: u32,
        ) -> Result<Option<String>, crate::sync_engine::SourceError> {
            Err(crate::sync_engine::SourceError::Unsupported)
        }
        async fn set_flags(
            &self,
            _f: &RemoteFolder,
            _u: &[u32],
            _flag: &str,
            _add: bool,
        ) -> Result<(), crate::sync_engine::SourceError> {
            Err(crate::sync_engine::SourceError::Unsupported)
        }
        async fn move_messages(
            &self,
            _s: &RemoteFolder,
            _u: &[u32],
            _d: &RemoteFolder,
        ) -> Result<(), crate::sync_engine::SourceError> {
            Err(crate::sync_engine::SourceError::Unsupported)
        }
        async fn delete_messages(
            &self,
            _f: &RemoteFolder,
            _u: &[u32],
        ) -> Result<(), crate::sync_engine::SourceError> {
            Err(crate::sync_engine::SourceError::Unsupported)
        }
        async fn append(
            &self,
            _f: &RemoteFolder,
            _r: &[u8],
            _fl: &[&str],
        ) -> Result<(), crate::sync_engine::SourceError> {
            Err(crate::sync_engine::SourceError::Unsupported)
        }
        async fn send(&self, _r: &str) -> Result<(), crate::sync_engine::SourceError> {
            Err(crate::sync_engine::SourceError::Unsupported)
        }
    }

    // ---- Phase 3f Task 5: list_folders RateLimited -> set_rate_limit ----
    //
    // When a source's list_folders returns SourceError::RateLimited, the engine
    // MUST record the window via set_rate_limit (so the NEXT round short-
    // circuits at the top via the rate-limit check) and MUST NOT bump the
    // breaker (a 429 is the server telling us to wait, not a dead socket).
    // Other SourceError variants keep the existing breaker-bump + error path.

    /// When `list_folders` returns `SourceError::RateLimited { retry_after }`,
    /// the engine records it in `provider_rate_limit` and does NOT bump the
    /// breaker. Drives one round, then asserts:
    ///   - the `provider_rate_limit` row was written with the source's epoch;
    ///   - the breaker counter for the account is still 0 (no failure recorded).
    #[tokio::test]
    async fn list_folders_rate_limited_records_window_and_skips_breaker() {
        let tmp = tempfile::tempdir().unwrap();
        let pool = init_db(tmp.path()).await.unwrap();
        seed_account(&pool, "a").await;
        let sink = Arc::new(TestSink::new());
        let engine = SyncEngine::new(pool.clone(), sink.clone());

        // The source hands back a rate-limit epoch ~300s in the future. Use
        // SQLite's clock so the assertion can compare apples-to-apples.
        let retry_after = sqlx::query_as::<_, (i64,)>("SELECT unixepoch() + 300")
            .fetch_one(&pool)
            .await
            .unwrap()
            .0;
        let src = RateLimitedSource { retry_after };

        // The round returns Err (list_folders failed) — but the side effect we
        // care about is the recorded rate-limit row, not the return value.
        let res = run_sync_round_with_source(&engine, "a", "eas", &src).await;
        assert!(res.is_err(), "list_folders Err surfaces as round Err");

        // provider_rate_limit row written with the source's retry_after.
        let row: Option<(i64,)> =
            sqlx::query_as("SELECT retry_after FROM provider_rate_limit WHERE account_id = 'a'")
                .fetch_optional(&pool)
                .await
                .unwrap();
        assert_eq!(
            row,
            Some((retry_after,)),
            "RateLimited list_folders must persist the retry_after window"
        );

        // Breaker NOT bumped: no entry (or zero failures). The engine resets
        // the breaker on success, but on this Err path the only mutation would
        // be `breaker_record_failure`; we assert it did NOT happen.
        let bs = engine.breakers.lock().await;
        let failures = bs.get("a").map(|s| s.failures).unwrap_or(0);
        assert_eq!(
            failures, 0,
            "RateLimited must NOT bump the breaker (server told us to wait, not a dead socket)"
        );
        drop(bs);

        // The NEXT round must short-circuit at the rate-limit check at the top
        // of run_sync_round_with_source — emitting exactly one `rate_limited`
        // status and NOT calling the source's list_folders again (the source's
        // list_folders would error with RateLimited again, but the short-
        // circuit means we never reach it). Clearing statuses then driving one
        // more round proves the window is live.
        sink.statuses.lock().unwrap().clear();
        run_sync_round_with_source(&engine, "a", "eas", &src)
            .await
            .unwrap();
        let statuses = sink.statuses.lock().unwrap().clone();
        assert_eq!(statuses.len(), 1, "next round short-circuits on rate-limit");
        assert_eq!(statuses[0].state, "rate_limited");
        assert_eq!(statuses[0].detail, Some(retry_after));
    }

    /// The breaker check runs AFTER the rate-limit short-circuit, so a live
    /// rate-limit row wins even if the breaker is tripped. Verifies the
    /// precedence: rate_limited state, not error, and the rate-limit detail
    /// (not the breaker cooldown_until).
    #[tokio::test]
    async fn rate_limit_wins_over_breaker_when_both_tripped() {
        let tmp = tempfile::tempdir().unwrap();
        let pool = init_db(tmp.path()).await.unwrap();
        seed_account(&pool, "a").await;

        // Trip the breaker: 3 list_folders failures (3rd sets a 15s cooldown).
        let sink0 = Arc::new(TestSink::new());
        let engine = SyncEngine::new(pool.clone(), sink0.clone());
        for _ in 0..3 {
            let _ =
                run_sync_round_with_source(&engine, "a", "imap", &ListFoldersFailingSource).await;
        }
        // Sanity: breaker is now in cooldown.
        let bs = engine.breakers.lock().await;
        let state = bs.get("a").copied().expect("breaker seeded");
        assert!(state.failures >= BREAKER_THRESHOLD_SHORT);
        assert!(state.cooldown_until > 0);
        drop(bs);

        // Seed a rate-limit window ~300s out.
        let retry_after = sqlx::query_as::<_, (i64,)>("SELECT unixepoch() + 300")
            .fetch_one(&pool)
            .await
            .unwrap()
            .0;
        crate::db::rate_limit::set_rate_limit(&pool, "a", retry_after)
            .await
            .unwrap();

        // Drive a round against a source whose list_folders would fail (so if
        // the breaker ran first we'd see an error). Rate-limit must win.
        sink0.statuses.lock().unwrap().clear();
        run_sync_round_with_source(&engine, "a", "imap", &ListFoldersFailingSource)
            .await
            .unwrap();
        let statuses = sink0.statuses.lock().unwrap().clone();
        assert_eq!(statuses.len(), 1, "rate-limit short-circuit emits one status");
        assert_eq!(statuses[0].state, "rate_limited");
        assert_eq!(
            statuses[0].detail,
            Some(retry_after),
            "rate-limit detail wins over breaker cooldown"
        );
    }

    /// Per-account isolation: a live `provider_rate_limit` row for account "a"
    /// must NOT short-circuit account "b"'s sync round. The workstream is
    /// literally "per-account rate-limit mode", so pinning that the SQL lookup
    /// is scoped by `account_id` (and the in-memory breaker map likewise) is a
    /// real regression guard against a future refactor that drops the WHERE
    /// clause or shares state across accounts.
    ///
    /// Seeds two accounts, rate-limits only "a", then drives a normal round for
    /// "b" and asserts "b" syncs normally (syncing -> ... -> idle, messages
    /// land in the DB) and emits NO `rate_limited` status.
    #[tokio::test]
    async fn rate_limit_is_per_account_and_does_not_skip_other_accounts() {
        let tmp = tempfile::tempdir().unwrap();
        let pool = init_db(tmp.path()).await.unwrap();
        seed_account(&pool, "a").await;
        seed_account(&pool, "b").await;

        // Rate-limit ONLY account "a", 300s in the future.
        let retry_after_a = sqlx::query_as::<_, (i64,)>("SELECT unixepoch() + 300")
            .fetch_one(&pool)
            .await
            .unwrap()
            .0;
        rate_limit::set_rate_limit(&pool, "a", retry_after_a)
            .await
            .unwrap();

        let sink = Arc::new(TestSink::new());
        let engine = SyncEngine::new(pool.clone(), sink.clone());

        // Account "b" has a real folder + message to deliver.
        let src = MockSource::new(
            vec![RemoteFolder {
                remote_id: "INBOX".into(),
                name: "INBOX".into(),
                delimiter: "/".into(),
                role: Some("inbox".into()),
                ..Default::default()
            }],
            vec![RemoteMessage {
                uid: 1,
                folder: "INBOX".into(),
                message_id: Some("<m-b-1>".into()),
                ..Default::default()
            }],
        );

        run_sync_round_with_source(&engine, "b", "imap", &src)
            .await
            .unwrap();

        // "b"'s message landed — sync was NOT short-circuited.
        let (n_b,): (i64,) =
            sqlx::query_as("SELECT COUNT(*) FROM messages WHERE account_id = 'b'")
                .fetch_one(&pool)
                .await
                .unwrap();
        assert_eq!(n_b, 1, "account b must sync normally despite a being rate-limited");

        // "a"'s rate-limit row is untouched and still live.
        let info_a = rate_limit::get_rate_limit(&pool, "a").await.unwrap();
        assert!(
            info_a.is_some(),
            "account a remains rate-limited (isolation: b's round did not clear a's window)"
        );

        // No rate_limited status was emitted for b — its round ran to
        // completion. (sink.statuses may contain a final idle/syncing for b;
        // what matters is none of them are rate_limited.)
        let any_rate_limited_for_b = sink
            .statuses
            .lock()
            .unwrap()
            .iter()
            .any(|s| s.account_id == "b" && s.state == "rate_limited");
        assert!(
            !any_rate_limited_for_b,
            "account b must not see a rate_limited status"
        );
    }

    // ---- Phase 1 Task 4: AccountWorker replay loop + sync:queue ----

    /// Seed one pending markRead op (one message = one row, matching how Task 3
    /// fans out). Used by the replay tests.
    async fn seed_pending_markread(
        pool: &SqlitePool,
        account_id: &str,
        op_id: &str,
        resource_id: &str,
        uid: u32,
        read: bool,
    ) {
        let params = serde_json::json!({
            "folderPath": "INBOX",
            "read": if read { 1 } else { 0 },
            "uids": [uid],
        })
        .to_string();
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
        let (cnt,): (i64,) =
            sqlx::query_as("SELECT COUNT(*) FROM pending_operations WHERE account_id = 'a'")
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
            async fn list_folders(
                &self,
            ) -> Result<Vec<RemoteFolder>, crate::sync_engine::SourceError> {
                Ok(vec![])
            }
            async fn sync_folder(
                &self,
                _f: &RemoteFolder,
                _c: crate::sync_engine::Cursor,
            ) -> Result<crate::sync_engine::FolderDelta, crate::sync_engine::SourceError>
            {
                Err(crate::sync_engine::SourceError::Unsupported)
            }
            async fn fetch_body(
                &self,
                _f: &RemoteFolder,
                _u: u32,
            ) -> Result<Option<String>, crate::sync_engine::SourceError> {
                Err(crate::sync_engine::SourceError::Unsupported)
            }
            async fn set_flags(
                &self,
                _f: &RemoteFolder,
                _u: &[u32],
                _flag: &str,
                _add: bool,
            ) -> Result<(), crate::sync_engine::SourceError> {
                Err(crate::sync_engine::SourceError::Unsupported)
            }
            async fn move_messages(
                &self,
                _s: &RemoteFolder,
                _u: &[u32],
                _d: &RemoteFolder,
            ) -> Result<(), crate::sync_engine::SourceError> {
                Err(crate::sync_engine::SourceError::Unsupported)
            }
            async fn delete_messages(
                &self,
                _f: &RemoteFolder,
                _u: &[u32],
            ) -> Result<(), crate::sync_engine::SourceError> {
                Err(crate::sync_engine::SourceError::Unsupported)
            }
            async fn append(
                &self,
                _f: &RemoteFolder,
                _r: &[u8],
                _fl: &[&str],
            ) -> Result<(), crate::sync_engine::SourceError> {
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
        let src = MockSource::new(vec![], vec![]).with_caps(Capabilities {
            idle: true,
            ..Default::default()
        });
        assert_eq!(
            pick_realtime_strategy(&src.capabilities()),
            RealtimeStrategy::Idle
        );
    }

    #[test]
    fn pick_realtime_strategy_poll_when_source_has_no_idle() {
        // Default caps (idle: false) → strategy is Poll (poll-only).
        let src = MockSource::new(vec![], vec![]);
        assert_eq!(
            pick_realtime_strategy(&src.capabilities()),
            RealtimeStrategy::Poll
        );
    }

    #[test]
    fn pick_realtime_strategy_poll_for_empty_default_caps() {
        // Bare default caps (no source) — the case before the first sync round
        // warms the ImapSource caps cache. Must be Poll so no watcher spawns.
        assert_eq!(
            pick_realtime_strategy(&Capabilities::default()),
            RealtimeStrategy::Poll
        );
    }

    // ---- Task 2: EventSink::emit_bodies_written capture ----

    /// TestSink must capture the new `BodiesWrittenEvent` shape so the
    /// commands.rs unit tests (and any future test driving
    /// `request_bodies_inner`) can assert on the event payload. This pins the
    /// trait-method-to-storage wiring without depending on a live socket.
    #[tokio::test]
    async fn test_sink_records_bodies_written_events() {
        let sink = Arc::new(TestSink::new());
        let tmp = tempfile::tempdir().unwrap();
        let pool = init_db(tmp.path()).await.unwrap();
        let engine = SyncEngine::new(pool.clone(), sink.clone());
        sink.emit_bodies_written(BodiesWrittenEvent {
            account_id: "a".into(),
            updates: vec![SnippetUpdate {
                thread_id: "t1".into(),
                snippet: "hi".into(),
            }],
        });
        let evts = sink.bodies_written.lock().unwrap().clone();
        assert_eq!(evts.len(), 1);
        assert_eq!(evts[0].account_id, "a");
        assert_eq!(evts[0].updates[0].thread_id, "t1");
        let _ = engine; // keep engine alive (unused otherwise)
    }
}
