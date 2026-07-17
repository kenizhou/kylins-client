// SyncEngine — process singleton that owns one AccountWorker (Tokio task) per active
// account. Each worker runs a wakeable poll: list_folders -> upsert labels ->
// per-folder sync_folder(cursor) -> apply_folder_delta -> advance cursor -> emit
// sync:* events. The poll cadence is IDLE-aware: poll-only accounts tick every
// `POLL_INTERVAL_SECS` (60s); accounts with an active IDLE watcher tick every
// `IDLE_BACKSTOP_SECS` (300s) — IDLE covers INBOX realtime, and the long backstop
// sweeps non-INBOX folders + recovers any IDLE gap. Phase 0 is poll-only; Phase 2
// layers IMAP IDLE / EAS Ping on top via the same MailSource trait.
//
// `EventSink` is the test seam: TauriEmitter emits via AppHandle in production;
// TestSink collects events for unit tests (so the engine is drivable without a WebView).

use std::collections::{HashMap, HashSet};
use std::path::PathBuf;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;
use std::time::Duration;

use serde::Serialize;
use sqlx::SqlitePool;
use tauri::{AppHandle, Emitter};
use tokio::sync::{mpsc, Mutex};

use crate::db::{accounts, contacts, labels, messages, send_as_aliases, sync_state};
use crate::mail::imap::session_manager::ImapSessionManager;
use crate::sync_engine::{
    source_for_account, Cursor, FolderDelta, MailSource, RemoteFolder, RemoteMessage,
};

// Poll-only cadence: the tick used for accounts without IDLE, or whose IDLE
// watcher isn't currently running. IDLE remains the preferred push path; this
// is the backstop for non-INBOX folders + the realtime path when the server
// (or our client) doesn't keep an IDLE socket alive.
const POLL_INTERVAL_SECS: u64 = 60;

// IDLE-aware backstop: when an account has an active IDLE watcher (covering
// INBOX realtime), the poll loop slows down to this cadence. The poll then
// only needs to sweep non-INBOX folders + recover any IDLE gap, so a 5-minute
// worst-case staleness there is acceptable and avoids redundant work on top
// of the push path.
const IDLE_BACKSTOP_SECS: u64 = 300;

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

/// Emitted by `send_op` after a queued Send op's transport result is known.
/// The frontend listens on `sync:send-result` to surface send feedback
/// (toast on success, error banner on failure) without re-polling the queue.
/// `error` is `Some(message)` only when `success` is false; `None` otherwise.
#[derive(Clone, Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct SendResultEvent {
    pub account_id: String,
    pub draft_id: String,
    pub success: bool,
    pub error: Option<String>,
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
    /// Emitted by `send_op` once the transport result of a queued Send is
    /// known. The frontend listens on `sync:send-result` and surfaces
    /// toast/error-banner feedback accordingly. `success=true` fires before
    /// the best-effort Sent-append so an append failure never flips a
    /// successful send to a failure signal (the send itself succeeded).
    fn emit_send_result(&self, evt: SendResultEvent);
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
    fn emit_send_result(&self, e: SendResultEvent) {
        let _ = self.0.emit("sync:send-result", e);
    }
}

#[derive(Clone, Debug)]
enum SyncOp {
    SyncNow,
    ReplayNow,
    Shutdown,
}

/// Realtime strategy picked from a source's `Capabilities` after the first
/// sync round populates the caps cache. `Idle` spawns the per-account IDLE
/// watcher (Task 3); `Poll` keeps the `POLL_INTERVAL_SECS` (60s) sweep as the
/// only push path. The poll loop runs in BOTH cases — under `Idle` it slows to
/// `IDLE_BACKSTOP_SECS` (300s) since IDLE covers INBOX realtime and the poll
/// only needs to sweep non-INBOX folders + recover IDLE gaps; under `Poll` it
/// stays at 60s as the only push path.
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
fn pick_realtime_strategy(caps: &crate::sync_engine::Capabilities, supports_idle: bool) -> RealtimeStrategy {
    if caps.idle && supports_idle {
        RealtimeStrategy::Idle
    } else {
        RealtimeStrategy::Poll
    }
}

struct WorkerHandle {
    tx: mpsc::Sender<SyncOp>,
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
    /// Tauri's `appDataDir` — the SAME directory the frontend resolves via
    /// `@tauri-apps/api/path`'s `appDataDir()`. Used by `send_op` (T8) to
    /// clean up the staged attachment directory `<appData>/outbox-attachments/
    /// {draft_id}/` after a successful send. Threading the resolved path
    /// through the engine (rather than re-resolving it via a Tauri handle)
    /// keeps `send_op` testable without an `AppHandle` — tests pass a tempdir.
    pub data_dir: PathBuf,
    /// Number of times `spawn_worker` has actually been invoked. Test-only
    /// diagnostic for detecting duplicate-spawn races in `ensure_worker`.
    workers_spawned: AtomicUsize,
    /// Guards
    /// `ensure_worker` against the classic check-then-act race where two
    /// concurrent callers both see an absent worker and both call
    /// `spawn_worker`, producing duplicate worker tasks.
    workers_starting: Arc<Mutex<HashSet<String>>>,
}

impl SyncEngine {
    pub fn new(pool: SqlitePool, sink: Arc<dyn EventSink>) -> Arc<Self> {
        // Default `data_dir` to the system temp dir so existing tests that
        // don't exercise cleanup keep working unchanged. Production code uses
        // [`Self::new_tauri`] / [`Self::with_data_dir`] to pass the real
        // `appDataDir`.
        Self::with_data_dir(pool, sink, std::env::temp_dir())
    }

    /// Construct with an explicit `data_dir` (the Tauri `appDataDir` in
    /// production, a tempdir in tests). Required for `send_op`'s attachment
    /// cleanup to remove the SAME dir the frontend staged under.
    pub fn with_data_dir(
        pool: SqlitePool,
        sink: Arc<dyn EventSink>,
        data_dir: PathBuf,
    ) -> Arc<Self> {
        Arc::new(Self {
            workers: Mutex::new(HashMap::new()),
            pool,
            sink,
            breakers: Mutex::new(HashMap::new()),
            session_manager: Arc::new(ImapSessionManager::new()),
            data_dir,
            workers_spawned: AtomicUsize::new(0),
            workers_starting: Arc::new(Mutex::new(HashSet::new())),
        })
    }

    /// Production constructor: emit over the Tauri WebView. `data_dir` MUST be
    /// the same path the frontend resolves via `appDataDir()` — `lib.rs`
    /// computes it once via `app.path().app_data_dir()` and passes it here so
    /// backend cleanup targets `<appData>/outbox-attachments/{draft_id}/`,
    /// matching the T7 frontend `attachments.ts` staging dir byte-for-byte.
    pub fn new_tauri(pool: SqlitePool, app: AppHandle, data_dir: PathBuf) -> Arc<Self> {
        Self::with_data_dir(pool, Arc::new(TauriSink(app)), data_dir)
    }

    /// Test-only accessor for the number of running workers.
    #[cfg(test)]
    pub async fn worker_count(&self) -> usize {
        self.workers.lock().await.len()
    }

    /// Test-only accessor for how many times `spawn_worker` was invoked.
    #[cfg(test)]
    pub fn spawned_count(&self) -> usize {
        self.workers_spawned.load(Ordering::Relaxed)
    }

    /// Spawn a worker for every active account.
    pub async fn start(self: &Arc<Self>) -> Result<(), String> {
        let accs = accounts::get_all(&self.pool).await?;
        let active: Vec<_> = accs.iter().filter(|a| a.is_active).cloned().collect();
        log::info!(
            "[send] SyncEngine::start: spawning workers for {} active account(s): [{}]",
            active.len(),
            active.iter().map(|a| a.id.as_str()).collect::<Vec<_>>().join(", ")
        );
        for a in &active {
            self.ensure_worker(a.id.clone()).await;
        }
        Ok(())
    }

    /// Ensure a worker exists for the account, then nudge it to sync immediately.
    pub async fn sync_account_now(self: &Arc<Self>, account_id: String) {
        log::info!(
            "[send] sync_account_now ENTER account_id={account_id} (ensure_worker + nudge)"
        );
        self.ensure_worker(account_id.clone()).await;
        self.nudge_worker(&account_id, SyncOp::SyncNow).await;
    }

    /// Ensure a worker exists, then nudge it to process queued mutations ONLY
    /// (replay, no folder sync, no `sync:status` flash). Used by
    /// `sync_apply_mutation` so markRead / send ops don't trigger a full folder
    /// sweep + StatusBar "syncing" indicator when the user selects a message.
    pub async fn sync_replay_now(self: &Arc<Self>, account_id: String) {
        log::info!(
            "[send] sync_replay_now ENTER account_id={account_id} (ensure_worker + nudge ReplayNow)"
        );
        self.ensure_worker(account_id.clone()).await;
        self.nudge_worker(&account_id, SyncOp::ReplayNow).await;
    }

    /// Send a `SyncOp` to the account's worker if one is running. Does NOT
    /// spawn a worker (unlike [`sync_account_now`]) — used by the IDLE-watcher
    /// task, which already lives inside the worker it wants to nudge, so
    /// re-running `ensure_worker` would be both redundant and (more
    /// importantly) would make the watcher future `!Send`: `ensure_worker`
    /// transitively awaits `spawn_worker`, whose outer `tokio::spawn` requires
    /// the worker-loop future (which contains THIS watcher task) to be `Send`,
    /// creating a cycle. This helper breaks the cycle by only touching the
    /// workers map (cloning the sender out of the lock scope before awaiting).
    async fn nudge_worker(self: &Arc<Self>, account_id: &str, op: SyncOp) {
        let tx = {
            let ws = self.workers.lock().await;
            ws.get(account_id).map(|w| w.tx.clone())
        };
        match tx {
            Some(tx) => {
                log::info!(
                    "[send] nudge_worker account_id={account_id} sending {op:?}"
                );
                if tx.send(op).await.is_err() {
                    log::warn!(
                        "[send] nudge_worker account_id={account_id} mpsc send FAILED (worker gone?)"
                    );
                }
            }
            None => {
                log::warn!(
                    "[send] nudge_worker account_id={account_id} NO WORKER running \
                     (sync_start not called? account inactive?) — Send op will sit in queue"
                );
            }
        }
    }

    /// Ensure a worker exists for the account (no-op if already running).
    pub async fn ensure_worker(self: &Arc<Self>, account_id: String) {
        // Fast path: worker already registered. This avoids taking the
        // `workers_starting` lock on the hot path.
        if self.workers.lock().await.contains_key(&account_id) {
            log::info!(
                "[send] ensure_worker account_id={account_id}: worker already running (no-op)"
            );
            return;
        }

        // Critical section: atomically check whether a spawn is already in
        // flight and, if not, reserve the slot. This prevents two concurrent
        // callers from both passing the workers-map check and invoking
        // `spawn_worker`, which would create duplicate worker tasks.
        struct StartingGuard {
            account_id: String,
            set: Arc<Mutex<HashSet<String>>>,
        }
        impl Drop for StartingGuard {
            fn drop(&mut self) {
                // `try_lock` is used because `spawn_worker` is async and a panic
                // during it would run Drop while the same task may or may not
                // hold the mutex. The critical section is tiny, so the lock is
                // essentially always free here.
                if let Ok(mut starting) = self.set.try_lock() {
                    starting.remove(&self.account_id);
                }
            }
        }

        let guard = {
            let mut starting = self.workers_starting.lock().await;
            if self.workers.lock().await.contains_key(&account_id)
                || starting.contains(&account_id)
            {
                None
            } else {
                starting.insert(account_id.clone());
                Some(StartingGuard {
                    account_id: account_id.clone(),
                    set: Arc::clone(&self.workers_starting),
                })
            }
        };

        let Some(_guard) = guard else {
            log::info!(
                "[send] ensure_worker account_id={account_id}: worker already starting (no-op)"
            );
            return;
        };

        log::info!(
            "[send] ensure_worker account_id={account_id}: NO worker yet → spawning"
        );
        self.spawn_worker(account_id.clone()).await;

        // The StartingGuard removes the reservation when it drops, even if
        // `spawn_worker` panicked, so a future re-spawn is never permanently
        // blocked.
    }

    async fn spawn_worker(self: &Arc<Self>, account_id: String) {
        log::info!("[send] spawn_worker ENTER account_id={account_id}");
        // Diagnostic: every actual spawn increments this counter so tests can
        // detect the double-spawn race in `ensure_worker` even though the
        // workers map later dedupes by account_id.
        self.workers_spawned.fetch_add(1, Ordering::Relaxed);
        // Validate the account + capture provider up front (skip silently if missing).
        let acc = match accounts::get_by_id(&self.pool, &account_id).await {
            Ok(Some(a)) => a,
            _ => {
                log::warn!(
                    "[send] spawn_worker: account {account_id} not found in DB — \
                     worker NOT started. Send op will sit in queue until sync_start \
                     is called for an account that exists."
                );
                return;
            }
        };
        let provider = acc.provider.clone();

        let (tx, mut rx) = mpsc::channel::<SyncOp>(16);
        let engine = Arc::clone(self);
        let aid = account_id.clone();
        // Insert a placeholder handle up front so `ensure_worker`'s
        // contains_key check sees the worker as running before the spawn
        // finishes (avoids a double-spawn race if sync_account_now is called
        // concurrently).
        self.workers
            .lock()
            .await
            .insert(account_id.clone(), WorkerHandle { tx: tx.clone() });
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
            let mut idle_push_rx: Option<mpsc::Receiver<crate::mail::imap::session_manager::PushNotice>> = {
                let src = crate::sync_engine::source_for_account(
                    &engine.pool,
                    &aid,
                    &engine.session_manager,
                )
                .await
                .ok();
                // Populate the caps cache so pick_realtime_strategy sees the
                // server's actual IDLE support (a fresh source reports default
                // caps until its first connect).
                if let Some(src) = &src {
                    let _ = src.list_folders().await;
                }
                let caps = src.as_ref().map(|s| s.capabilities());
                let supports_idle = engine
                    .session_manager
                    .get_setup(&aid)
                    .await
                    .map(|s| s.profile.supports_idle())
                    // Default to Poll on a transient get_setup miss (actor not
                    // yet connected) — safer than assuming IDLE works, which
                    // could re-enable IDLE for a profile (e.g. Yahoo) that opts out.
                    .unwrap_or(false);
                let strategy = caps
                    .as_ref()
                    .map(|c| pick_realtime_strategy(c, supports_idle))
                    .unwrap_or(RealtimeStrategy::Poll);
                let idle_cap = caps.as_ref().map(|c| c.idle).unwrap_or(false);
                log::info!(
                    "[sync] {aid} realtime strategy: {strategy:?} (idle_cap={idle_cap})"
                );
                // Single-connection actor: if the server advertises IDLE, ask
                // the manager's actor to IDLE on INBOX and hand us its push
                // channel. The actor owns the ONE connection; commands (incl.
                // the INBOX sync we run on a push) break IDLE on it. No second
                // connection → Yahoo pushes land on this socket in real time.
                if strategy != RealtimeStrategy::Idle {
                    None
                } else {
                    let inbox = crate::db::labels::get_folder_by_role(
                        &engine.pool,
                        &aid,
                        "inbox",
                    )
                    .await
                    .ok()
                    .flatten();
                    match (inbox, src.as_ref()) {
                        (Some(f), Some(s)) => {
                            match s.imap_config_for_folder(&f.remote_id).await.ok().flatten() {
                                Some(config) => {
                                    log::info!(
                                        "[sync] {aid} starting IDLE on {} (single-connection actor)",
                                        f.remote_id
                                    );
                                    engine
                                        .session_manager
                                        .start_idle(&aid, &config, &f.remote_id)
                                        .await
                                }
                                None => None,
                            }
                        }
                        _ => None,
                    }
                }
            };

            // The poll cadence is IDLE-aware: with IDLE (a push_rx) the poll
            // slows to IDLE_BACKSTOP_SECS as a long backstop for non-INBOX +
            // IDLE-gap recovery; without IDLE it stays at POLL_INTERVAL_SECS.
            let has_idle = idle_push_rx.is_some();

            let poll_secs = if has_idle { IDLE_BACKSTOP_SECS } else { POLL_INTERVAL_SECS };
            let mut tick = tokio::time::interval(Duration::from_secs(poll_secs));
            log::info!(
                "[sync] {aid} poll interval: {}s (IDLE {})",
                poll_secs,
                if has_idle { "active → long backstop" } else { "inactive → short poll" }
            );
            // Drop the first immediate tick (we already synced above).
            tick.tick().await;
            // The channel may close if the Sender is dropped unexpectedly (the
            // original `tx` local in spawn_worker is dropped when the function
            // returns; the clone in WorkerHandle *should* keep it alive, but
            // if it doesn't, `rx.recv()` returns None). Pre-fix, `None => break`
            // caused the worker to EXIT SILENTLY — sync stopped with no error.
            // Now: switch to tick-only mode (the poll continues regardless
            // of channel state; SyncNow nudges are best-effort).
            let mut channel_open = true;
            loop {
                if channel_open {
                    tokio::select! {
                        _ = tick.tick() => {
                            log::info!(
                                "[send] worker {aid} tick fired → run_sync_round (periodic poll)"
                            );
                            let _ = run_sync_round(&engine, &aid, &provider).await;
                        }
                        op = rx.recv() => match op {
                            Some(SyncOp::SyncNow) => {
                                log::info!(
                                    "[send] worker {aid} received SyncNow → run_sync_round (run_replay_round runs FIRST at the top — queued Sends drain regardless of folder-sync health; then the receive round)"
                                );
                                let _ = run_sync_round(&engine, &aid, &provider).await;
                            }
                            Some(SyncOp::ReplayNow) => {
                                log::info!(
                                    "[send] worker {aid} received ReplayNow → run_replay_round ONLY (no folder sync, no sync:status)"
                                );
                                match crate::sync_engine::source_for_account(
                                    &engine.pool,
                                    &aid,
                                    &engine.session_manager,
                                )
                                .await
                                {
                                    Ok(src) => {
                                        run_replay_round(&engine, &aid, src.as_ref()).await;
                                    }
                                    Err(e) => log::warn!(
                                        "[sync] {aid} ReplayNow: source resolution failed: {e}"
                                    ),
                                }
                            }
                            Some(SyncOp::Shutdown) => {
                                log::info!("[sync] {aid} worker received Shutdown; exiting");
                                break;
                            }
                            None => {
                                log::warn!("[sync] {aid} worker channel closed; switching to tick-only poll");
                                channel_open = false;
                            }
                        },
                        // IDLE push from the single-connection actor: a NewData
                        // arrived on the IDLE socket. Sync INBOX (via execute(),
                        // which breaks IDLE on the actor) + apply/emit. Pending
                        // forever when there's no push_rx (poll-only accounts).
                        notice = async {
                            if let Some(rx) = &mut idle_push_rx {
                                rx.recv().await
                            } else {
                                std::future::pending::<
                                    Option<crate::mail::imap::session_manager::PushNotice>,
                                >()
                                .await
                            }
                        } => {
                            if notice.is_some() {
                                log::info!("[sync] {aid} IDLE push → sync INBOX");
                                run_inbox_push_sync(&engine, &aid).await;
                            }
                        }
                    }
                } else {
                    // Channel closed — poll via tick only (no busy-loop).
                    tick.tick().await;
                    let _ = run_sync_round(&engine, &aid, &provider).await;
                }
            }
            // (the IDLE actor lives in the session manager; stop_all shuts it down.)
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
    /// worker's poll loop AND shuts down the per-account IDLE actor on the session
    /// manager so its single connection doesn't outlive the account.
    pub async fn stop_all(&self) {
        let mut ws = self.workers.lock().await;
        for (_, w) in ws.drain() {
            let _ = w.tx.send(SyncOp::Shutdown).await;
        }
        drop(ws);
        // Stop every account's single-connection actor (sends Shutdown + aborts).
        self.session_manager.shutdown().await;
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
    log::info!(
        "[send] run_replay_round ENTER account_id={account_id} dequeued {} op(s)",
        ops.len()
    );
    if ops.is_empty() {
        // Nothing pending — emit the queue event (0 pending) and return so the
        // user can grep "dequeued 0 op(s)" to see idle replay rounds fire.
        let pending = crate::db::queue::pending_count_for_account(pool, account_id)
            .await
            .unwrap_or(0);
        engine.emit_queue(account_id, pending);
        return;
    }
    for op in ops {
        log::info!(
            "[send] processing op id={} account_id={account_id} op_type={} resource_id={}",
            op.id,
            op.operation_type,
            op.resource_id
        );
        let mop = match crate::db::mutations::MutationOp::from_pending(&op) {
            Ok(m) => m,
            Err(e) => {
                log::warn!(
                    "[send] decode op {} FAILED (op_type={}, resource_id={}): {e} — op skipped, will retry next round",
                    op.id,
                    op.operation_type,
                    op.resource_id
                );
                continue;
            }
        };
        // Send is intercepted here (not dispatched via `exec_via_source`) so the
        // worker can build RFC5322 MIME bytes from the structured `SendDraft`
        // before calling `MailSource::send(&[u8])`. T8 will widen `send_op` to
        // also best-effort IMAP-APPEND a Sent copy and clean up staged
        // attachment files on success; the signature already threads `engine`
        // + `account_id` so T8 drops in without reshuffling the call site.
        let dispatch = match &mop {
            crate::db::mutations::MutationOp::Send { draft } => {
                log::info!(
                    "[send] op {} dispatch: Send → send_op (draft_id={}, subject={:?})",
                    op.id,
                    draft.draft_id,
                    draft.subject
                );
                "send_op"
            }
            _ => {
                log::info!(
                    "[send] op {} dispatch: {} → exec_via_source",
                    op.id,
                    mop.op_type()
                );
                "exec_via_source"
            }
        };
        let result = match &mop {
            crate::db::mutations::MutationOp::Send { draft } => {
                // `draft` is `&Box<SendDraft>`; `send_op` takes `&SendDraft`.
                // `Box` derefs to its contents, so `.as_ref()` recovers the
                // borrowed inner reference without cloning.
                send_op(engine, account_id, src, draft.as_ref()).await
            }
            _ => mop.exec_via_source(src).await,
        };
        match result {
            Ok(()) => {
                log::info!(
                    "[send] op {} OK via {} → mark_completed",
                    op.id,
                    dispatch
                );
                if let Err(e) = crate::db::queue::mark_completed(pool, &op.id).await {
                    log::warn!("[sync] mark_completed {} failed: {e}", op.id);
                }
            }
            Err(e) => {
                let msg = e.to_string();
                log::warn!(
                    "[send] op {} ERR via {}: {msg} → mark_failed (will retry with backoff)",
                    op.id,
                    dispatch
                );
                if let Err(e2) = crate::db::queue::mark_failed(pool, &op.id, &msg).await {
                    log::warn!("[sync] mark_failed {} failed: {e2}", op.id);
                }
            }
        }
    }
    let pending = crate::db::queue::pending_count_for_account(pool, account_id)
        .await
        .unwrap_or(0);
    log::info!(
        "[send] run_replay_round EXIT account_id={account_id} remaining_pending={pending}"
    );
    engine.emit_queue(account_id, pending);
}

/// Build RFC5322 MIME bytes from `draft` (via `mail_builder::build_mime`),
/// transmit them via `MailSource::send(&[u8])`, then — for IMAP/SMTP accounts
/// where the server does NOT auto-save a Sent copy — best-effort IMAP-APPEND
/// the MIME to the account's Sent folder, and finally clean up the staged
/// attachment directory on success.
///
/// **Best-effort invariant (load-bearing):** a Sent-append failure or
/// cleanup failure MUST NEVER fail the op. The send already succeeded, so
/// returning `Err` here would cause the replay worker to `mark_failed` +
/// retry the whole op on the next round, re-sending the email and producing
/// duplicates. Both the append and cleanup paths log a warning and continue.
///
/// The append is gated by BOTH:
///   - `!src.capabilities().saves_sent_automatically` (EAS SaveInSentItems
///     already saved; Gmail/Graph defer to 3c/3d), AND
///   - the per-account `save_sent_copy` setting (default TRUE when the key
///     is absent — `None → true`).
///
/// Build/send failures DO surface as `Err(SourceError::Other(...))` so the
/// replay worker's standard Ok→mark_completed / Err→mark_failed handling
/// applies and the op retries with backoff like any other failed mutation.
async fn send_op(
    engine: &Arc<SyncEngine>,
    account_id: &str,
    src: &dyn MailSource,
    draft: &crate::mail::builder::SendDraft,
) -> Result<(), crate::sync_engine::SourceError> {
    log::info!(
        "[send] send_op ENTER account_id={account_id} draft_id={} from={} to_count={} caps.saves_sent_automatically={}",
        draft.draft_id,
        draft.from.email,
        draft.to.len(),
        src.capabilities().saves_sent_automatically
    );

    // Build MIME once — reused for both send and Sent-append (no rebuild).
    let mime = match crate::mail::builder::build_mime(draft).await {
        Ok(bytes) => {
            log::info!(
                "[send] build_mime OK draft_id={} {} bytes",
                draft.draft_id,
                bytes.len()
            );
            bytes
        }
        Err(e) => {
            log::warn!(
                "[send] build_mime ERR draft_id={}: {e}",
                draft.draft_id
            );
            // Surface failure to the frontend BEFORE the op is mark_failed's
            // + retried. The error string carries the build error verbatim.
            let err_msg = format!("build_mime: {e}");
            log::info!(
                "[send] {account_id} emit sync:send-result success=false draft_id={}",
                draft.draft_id
            );
            engine.sink.emit_send_result(SendResultEvent {
                account_id: account_id.into(),
                draft_id: draft.draft_id.clone(),
                success: false,
                error: Some(err_msg.clone()),
            });
            return Err(crate::sync_engine::SourceError::Other(err_msg));
        }
    };

    // ---- Plan 4a Task 6: S/MIME sign/encrypt wrapping ----
    //
    // If the draft carries `crypto_method=Smime` + sign/encrypt, wrap the MIME
    // via `apply_crypto` before transport. The wrapped bytes (multipart/signed
    // or application/pkcs7-mime enveloped-data) flow to BOTH `src.send` (below)
    // AND the Sent-folder `src.append` (reused later) — the variable shadowing
    // below is what makes the reuse automatic. Fail-closed: a `CryptoSendError`
    // emits `sync:send-result{success:false}` AND returns `Err` so the replay
    // worker marks the op failed (no plaintext fallback, no retry of a crypto
    // error that won't resolve on retry).
    //
    // `SqliteKeyStore` is NOT `Clone` (its `account_id: String` field has no
    // cheap clone-path) but its constructor is cheap (`Arc<SqlitePool>` handle
    // bump + `String` clone), so we construct TWO stores from the same pool —
    // one moved into `Arc<dyn KeyStore>` for the backend, one borrowed by
    // `apply_crypto` for its own `find_by_email` recipient lookups. The
    // backend's internal `Arc<dyn KeyStore>` and the lookup store share the
    // same SQLite handle, so both see the same key rows.
    let mime = if matches!(draft.crypto_method, crate::mail::builder::CryptoMethod::Smime)
        && (draft.sign || draft.encrypt)
    {
        let account_email: String = match sqlx::query_scalar("SELECT email FROM accounts WHERE id = ?")
            .bind(account_id)
            .fetch_one(&engine.pool)
            .await
        {
            Ok(email) => email,
            Err(e) => {
                let msg = format!("lookup account email: {e}");
                log::warn!("[send] {account_id} draft_id={} {msg}", draft.draft_id);
                engine.sink.emit_send_result(SendResultEvent {
                    account_id: account_id.into(),
                    draft_id: draft.draft_id.clone(),
                    success: false,
                    error: Some(msg.clone()),
                });
                return Err(crate::sync_engine::SourceError::Other(msg));
            }
        };
        let pool_arc = std::sync::Arc::new(engine.pool.clone());
        let keystore_for_backend = crate::keystore_bridge::SqliteKeyStore::new(
            std::sync::Arc::clone(&pool_arc),
            account_id,
        );
        let keystore_for_lookup =
            crate::keystore_bridge::SqliteKeyStore::new(pool_arc, account_id);
        let backend = crypto_smime::SmimeBackend::new(
            std::sync::Arc::new(keystore_for_backend),
            crypto_core::CryptoPolicy::default_baseline(),
        );
        let default_key = match crate::db::crypto_keys::get_default_signing_key(
            &engine.pool,
            account_id,
        )
        .await
        {
            Ok(row) => row,
            Err(e) => {
                let msg = format!("lookup default signing key: {e}");
                log::warn!("[send] {account_id} draft_id={} {msg}", draft.draft_id);
                engine.sink.emit_send_result(SendResultEvent {
                    account_id: account_id.into(),
                    draft_id: draft.draft_id.clone(),
                    success: false,
                    error: Some(msg.clone()),
                });
                return Err(crate::sync_engine::SourceError::Other(msg));
            }
        };
        match crate::mail::crypto::apply_crypto(
            &backend,
            &keystore_for_lookup,
            &mime,
            draft,
            &account_email,
            default_key.as_ref(),
        )
        .await
        {
            Ok(wrapped) => {
                log::info!(
                    "[send] apply_crypto OK draft_id={} wrapped {} -> {} bytes \
                     (sign={} encrypt={})",
                    draft.draft_id,
                    mime.len(),
                    wrapped.len(),
                    draft.sign,
                    draft.encrypt
                );
                wrapped
            }
            Err(e) => {
                // Permanent crypto error — surface immediately, no plaintext
                // fallback. The replay worker will `mark_failed` on the Err
                // return; emitting the send-result first lets the frontend
                // show an error banner without waiting for the next round.
                let msg = e.to_string();
                log::warn!(
                    "[send] apply_crypto ERR draft_id={}: {msg} \
                     (fail-closed — src.send NOT called)",
                    draft.draft_id
                );
                log::info!(
                    "[send] {account_id} emit sync:send-result success=false draft_id={}",
                    draft.draft_id
                );
                engine.sink.emit_send_result(SendResultEvent {
                    account_id: account_id.into(),
                    draft_id: draft.draft_id.clone(),
                    success: false,
                    error: Some(msg.clone()),
                });
                return Err(crate::sync_engine::SourceError::Other(msg));
            }
        }
    } else {
        mime
    };

    // The retryable unit: an Err here surfaces to the replay worker, which
    // marks the op failed + schedules backoff. Anything AFTER this line is
    // best-effort and MUST NOT return Err (send already succeeded).
    log::info!(
        "[send] calling src.send draft_id={} (transport = {})",
        draft.draft_id,
        src_send_label(src)
    );
    match src.send(&mime).await {
        Ok(()) => {
            log::info!("[send] src.send OK draft_id={}", draft.draft_id);
            // Surface success to the frontend now — BEFORE the best-effort
            // Sent-append + cleanup. The invariant: an append failure or a
            // cleanup failure must NEVER flip this to a failure signal, so
            // we emit success=true at the exact point the transport resolved
            // Ok (the send itself succeeded; everything below is best-effort).
            log::info!(
                "[send] {account_id} emit sync:send-result success=true draft_id={}",
                draft.draft_id
            );
            engine.sink.emit_send_result(SendResultEvent {
                account_id: account_id.into(),
                draft_id: draft.draft_id.clone(),
                success: true,
                error: None,
            });
        }
        Err(e) => {
            log::warn!(
                "[send] src.send ERR draft_id={}: {e} (op will mark_failed + retry)",
                draft.draft_id
            );
            // Surface failure BEFORE returning Err so the frontend can show
            // an immediate error banner (the replay worker will separately
            // mark_failed + schedule backoff on the returned Err).
            let err_msg = e.to_string();
            log::info!(
                "[send] {account_id} emit sync:send-result success=false draft_id={}",
                draft.draft_id
            );
            engine.sink.emit_send_result(SendResultEvent {
                account_id: account_id.into(),
                draft_id: draft.draft_id.clone(),
                success: false,
                error: Some(err_msg),
            });
            return Err(e);
        }
    }

    // ---- best-effort Sent-append (IMAP/SMTP only; EAS skips — SaveInSentItems) ----
    if !src.capabilities().saves_sent_automatically {
        // Default TRUE when the setting is absent OR the read fails: only an
        // explicit `Some(false)` skips the append. `unwrap_or(None)` on Err
        // keeps the read failure best-effort (treat as unset = default-true).
        let save = save_sent_copy(&engine.pool, account_id)
            .await
            .unwrap_or(None)
            != Some(false);
        if !save {
            log::info!(
                "[send] sent-append SKIPPED: per-account save_sent_copy=false (draft_id={})",
                draft.draft_id
            );
        } else {
            match crate::db::labels::resolve_sent_folder(&engine.pool, account_id).await {
                Ok(Some(folder)) => {
                    let sent_remote = mail_folder_to_remote(&folder);
                    log::info!(
                        "[send] sent-append calling src.append draft_id={} folder={} (best-effort)",
                        draft.draft_id,
                        sent_remote.remote_id
                    );
                    match src.append(&sent_remote, &mime, &["\\Seen"]).await {
                        Ok(()) => log::info!(
                            "[send] sent-append OK draft_id={}",
                            draft.draft_id
                        ),
                        Err(e) => log::warn!(
                            "[send] sent-append ERR (best-effort; send already succeeded) account_id={account_id} draft_id={}: {e}",
                            draft.draft_id
                        ),
                    }
                }
                Ok(None) => log::warn!(
                    "[send] sent-append SKIPPED: no Sent folder resolved for account_id={account_id} (draft_id={})",
                    draft.draft_id
                ),
                Err(e) => log::warn!(
                    "[send] sent-append SKIPPED: resolve_sent_folder err account_id={account_id} draft_id={}: {e}",
                    draft.draft_id
                ),
            }
        }
    } else {
        log::info!(
            "[send] sent-append SKIPPED: source caps.saves_sent_automatically=true (EAS-style) draft_id={}",
            draft.draft_id
        );
    }

    // ---- best-effort cleanup of staged attachment files ----
    // `<appData>/outbox-attachments/{draft_id}/` is where the T7 frontend
    // (`attachments.ts`) stages attachment files for the picker + inline
    // images. On successful send the staged files are no longer needed — the
    // message (with attachments embedded in the MIME) is on its way and the
    // Sent copy (if appended) carries them too. Failure here is logged +
    // swallowed: orphaned files are cosmetic, not a send-flow error.
    match cleanup_attachment_files(&engine.data_dir, &draft.draft_id).await {
        Ok(()) => log::info!(
            "[send] attachment cleanup OK draft_id={} (data_dir={})",
            draft.draft_id,
            engine.data_dir.display()
        ),
        Err(e) => log::warn!(
            "[send] attachment cleanup ERR (best-effort) draft_id={}: {e}",
            draft.draft_id
        ),
    }
    log::info!("[send] send_op EXIT OK draft_id={}", draft.draft_id);
    Ok(())
}

/// Best-effort label for the `src.send` log line — distinguishes IMAP/SMTP
/// (which actually transports) from EAS (WBXML SendMail) from test mocks.
/// Pure string match on the source's type name; falls back to "?" if the
/// type name is unavailable (e.g. mock sources in tests).
fn src_send_label(src: &dyn MailSource) -> &'static str {
    let ty = std::any::type_name_of_val(src);
    if ty.contains("ImapSource") {
        "SMTP (ImapSource::send → smtp_client::send_raw_email)"
    } else if ty.contains("EasSource") {
        "EAS SendMail (EasSource::send → EasClient::send_mail)"
    } else if ty.contains("MockSource") {
        "MockSource::send (test)"
    } else {
        "?UnknownSource::send"
    }
}

/// Read the per-account `save_sent_copy` setting. The key layout is
/// `account.{account_id}.save_sent_copy`; values follow the settings layer's
/// bool convention (`"true"` / `"false"`). Returns `None` when the key is
/// absent — the caller (`send_op`) treats `None` as default-true.
async fn save_sent_copy(
    pool: &SqlitePool,
    account_id: &str,
) -> Result<Option<bool>, String> {
    crate::db::settings::get_bool(pool, &format!("account.{account_id}.save_sent_copy")).await
}

/// Remove the staged attachment directory for `draft_id`. Path:
/// `<data_dir>/outbox-attachments/{draft_id}/`, matching the T7 frontend
/// `attachments.ts` `outboxDir(draftId)` resolver byte-for-byte (both use
/// Tauri's `appDataDir()`). Missing dir = no-op (the user may have no
/// attachments, or the dir was already cleaned).
async fn cleanup_attachment_files(data_dir: &std::path::Path, draft_id: &str) -> Result<(), String> {
    // draft_id comes from the frontend as an opaque identifier; make sure it
    // cannot be used to traverse outside the per-draft staging directory.
    if draft_id.is_empty()
        || draft_id == "."
        || draft_id == ".."
        || draft_id.contains('/')
        || draft_id.contains('\\')
    {
        return Err(format!("invalid draft_id for attachment cleanup: {:?}", draft_id));
    }
    let dir = data_dir.join("outbox-attachments").join(draft_id);
    // Resolve the final path and ensure it is still inside the staging root.
    let Ok(canonical_root) = tokio::fs::canonicalize(data_dir.join("outbox-attachments")).await else {
        return Ok(());
    };
    let Ok(canonical_target) = tokio::fs::canonicalize(&dir).await else {
        return Ok(());
    };
    if !canonical_target.starts_with(&canonical_root) {
        return Err(format!(
            "attachment cleanup path escapes staging root: {:?}",
            canonical_target
        ));
    }
    tokio::fs::remove_dir_all(&dir)
        .await
        .map_err(|e| e.to_string())
}

/// Convert a stored `MailFolder` (DB row) into a `RemoteFolder` so it can be
/// fed to `MailSource::append(&RemoteFolder, ...)` in `send_op`. Mirrors the
/// inline conversion used at the IDLE-watcher call site (~line 389) for the
/// INBOX folder; pulled into a helper because T8 needs the same mapping for
/// the Sent folder. Only the fields the source adapters actually read
/// (`remote_id` for IMAP) are load-bearing; the rest are best-effort mirrored.
fn mail_folder_to_remote(f: &crate::db::labels::MailFolder) -> RemoteFolder {
    RemoteFolder {
        remote_id: f.remote_id.clone(),
        name: f.name.clone(),
        delimiter: f
            .delimiter
            .clone()
            .unwrap_or_else(|| "/".to_string()),
        special_use: f.imap_special_use.clone(),
        role: f.role.clone(),
        parent_id: f.parent_id.clone(),
        exists: 0,
        unseen: 0,
    }
}

/// Core build-and-send logic, split out from `send_op` so unit tests can reach
/// it without constructing a full `SyncEngine`. The worker-path test
/// (`send_op_builds_mime_and_calls_send`) drives this directly with a
/// `MockSource`. Kept as a pub(crate) test seam even after T8 inlined the
/// build step into `send_op` (so the MIME bytes are built once and reused for
/// the append) — the test still validates the build-and-send path in
/// isolation, and any future caller that wants "send-only, no append/cleanup"
/// can reach for this helper.
#[allow(dead_code)] // test seam; referenced from #[cfg(test)] mod tests below
pub(crate) async fn build_and_send(
    src: &dyn MailSource,
    draft: &crate::mail::builder::SendDraft,
) -> Result<(), crate::sync_engine::SourceError> {
    let mime = crate::mail::builder::build_mime(draft)
        .await
        .map_err(|e| crate::sync_engine::SourceError::Other(format!("build_mime: {e}")))?;
    src.send(&mime).await
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

/// Addresses belonging to the account itself (primary email + verified
/// send-as aliases). Auto-extraction must never record these as contacts.
/// Lifted out of `run_sync_round_with_source` so the IDLE watcher's apply
/// path (which bypasses the round for the INBOX it owns) can reuse it.
async fn own_emails_for_account(pool: &SqlitePool, account_id: &str) -> Vec<String> {
    match accounts::get_by_id(pool, account_id).await {
        Ok(Some(account)) => {
            let mut set: Vec<String> = Vec::new();
            let primary = account.email.trim().to_lowercase();
            if !primary.is_empty() {
                set.push(primary);
            }
            if let Ok(aliases) = send_as_aliases::emails_for_account(pool, account_id).await {
                for alias in aliases {
                    let email = alias.trim().to_lowercase();
                    if !email.is_empty() && !set.contains(&email) {
                        set.push(email);
                    }
                }
            }
            set
        }
        Ok(None) => Vec::new(),
        Err(e) => {
            log::warn!("[sync] {account_id} failed to load account for contact extraction: {e}");
            Vec::new()
        }
    }
}

/// Emit the per-folder `sync:delta` (+ `sync:new-mail` for INBOX) when a
/// round/watcher actually changed something. Lifted out of the per-folder loop
/// so the IDLE watcher applies INBOX deltas with byte-identical events to the
/// round (poll mode). `added` is the same slice just persisted, used to build
/// the stable message ids for `new-mail` dedupe.
fn emit_folder_delta(
    sink: &dyn EventSink,
    account_id: &str,
    label_id: &str,
    folder_role: Option<&str>,
    counts: messages::AppliedCounts,
    added: &[RemoteMessage],
) {
    if counts.added > 0 || counts.updated > 0 || counts.deleted > 0 {
        sink.emit_delta(DeltaEvent {
            op: "persist".into(),
            table: "messages".into(),
            account_id: account_id.into(),
            label_id: label_id.into(),
            count: counts.added as i64,
        });
        if folder_role == Some("inbox") {
            let message_ids: Vec<String> = added
                .iter()
                .map(|m| format!("imap-{account_id}-{}-{}", m.folder, m.uid))
                .collect();
            sink.emit_new_mail(NewMailEvent {
                account_id: account_id.into(),
                folder_id: label_id.into(),
                count: counts.added as i64,
                message_ids,
            });
        }
    }
}

/// Apply + emit a folder delta: `apply_folder_delta` → contact extraction →
/// cursor advance (IMAP/EAS) → `emit_folder_delta`. Shared by the per-folder
/// poll loop AND the IDLE push handler so poll-delivered and push-delivered mail
/// are indistinguishable to the DB and the UI.
async fn apply_folder_and_emit(
    engine: &Arc<SyncEngine>,
    account_id: &str,
    folder: &RemoteFolder,
    delta: &FolderDelta,
    own_emails: &[String],
) {
    let label_id = format!("{account_id}:{}", folder.remote_id);
    let counts = match messages::apply_folder_delta(
        &engine.pool,
        account_id,
        &label_id,
        &folder.remote_id,
        delta,
    )
    .await
    {
        Ok(c) => c,
        Err(e) => {
            log::warn!(
                "[sync] {account_id} apply_folder_delta {} failed: {e}",
                folder.remote_id
            );
            return;
        }
    };
    for m in delta.added.iter().chain(delta.updated.iter()) {
        if let Err(e) =
            contacts::record_from_remote_msg(&engine.pool, account_id, m, folder.role.as_deref(), own_emails)
                .await
        {
            log::warn!(
                "[contacts] {account_id} extraction failed for {}: {e}",
                m.uid
            );
        }
    }
    if let Cursor::Imap {
        uidvalidity,
        highest_uid,
        highest_modseq,
    } = &delta.next_cursor
    {
        let _ = sync_state::advance_imap_cursor(
            &engine.pool,
            account_id,
            &folder.remote_id,
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
            &folder.remote_id,
            collection_id,
            sync_key,
        )
        .await;
    }
    emit_folder_delta(
        engine.sink.as_ref(),
        account_id,
        &label_id,
        folder.role.as_deref(),
        counts,
        &delta.added,
    );
}

/// Handle an IDLE push notification: resolve INBOX + source, sync INBOX (via
/// `execute()`, which breaks IDLE on the single-connection actor), and apply +
/// emit. The actor's IDLE socket is the only connection that SELECTs INBOX, so
/// the push that triggered this already landed on it in real time.
async fn run_inbox_push_sync(engine: &Arc<SyncEngine>, account_id: &str) {
    let inbox = match crate::db::labels::get_folder_by_role(&engine.pool, account_id, "inbox").await {
        Ok(Some(f)) => f,
        _ => return,
    };
    let folder = RemoteFolder {
        remote_id: inbox.remote_id.clone(),
        name: inbox.name.clone(),
        delimiter: inbox.delimiter.clone().unwrap_or_else(|| "/".into()),
        role: Some("inbox".into()),
        ..Default::default()
    };
    let src = match crate::sync_engine::source_for_account(&engine.pool, account_id, &engine.session_manager).await {
        Ok(s) => s,
        Err(e) => {
            log::warn!("[sync] {account_id} IDLE push: source resolve failed: {e}");
            return;
        }
    };
    let cursor = src.load_cursor(&engine.pool, account_id, &folder.remote_id).await;
    let delta = match src.sync_folder(&folder, cursor).await {
        Ok(d) => d,
        Err(e) => {
            log::warn!("[sync] {account_id} IDLE push: sync_folder INBOX failed: {e}");
            return;
        }
    };
    let own_emails = own_emails_for_account(&engine.pool, account_id).await;
    apply_folder_and_emit(engine, account_id, &folder, &delta, &own_emails).await;
}

/// One sync round against an explicit source (test seam + reused by production).
async fn run_sync_round_with_source(
    engine: &Arc<SyncEngine>,
    account_id: &str,
    provider: &str,
    src: &dyn MailSource,
) -> Result<(), String> {
    // Drain queued operations (Send, etc.) FIRST, before any receive-side gates.
    // Send uses a DIFFERENT transport (SMTP / EAS SendMail) than the receive poll
    // (IMAP list_folders / EAS Ping), so a rate-limit, circuit-breaker cooldown, or
    // flaky list_folders on the RECEIVE side must never be allowed to block SENDS
    // indefinitely. Running replay at the top guarantees a queued Send fires on the
    // next SyncNow nudge (the send path enqueues + nudges) regardless of folder-sync
    // health. The Phase 3f rate-limit/breaker gates below still protect the RECEIVE
    // round that follows.
    log::info!(
        "[send] {account_id} run_sync_round_with_source: draining replay queue FIRST \
         (queued Sends fire here regardless of receive-side gates)"
    );
    run_replay_round(engine, account_id, src).await;

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
            log::warn!(
                "[send] {account_id} run_sync_round_with_source: RECEIVE round rate-limited, \
                 skipping folder sync (queued Sends already drained at the top via run_replay_round)"
            );
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
        log::warn!(
            "[send] {account_id} run_sync_round_with_source: RECEIVE round breaker in cooldown \
             (until={cooldown_until}), skipping folder sync (queued Sends already drained at the \
             top via run_replay_round)"
        );
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
        Ok(f) => {
            log::info!("[sync] {account_id} list_folders returned {} folder(s)", f.len());
            f
        }
        Err(e) => {
            log::warn!(
                "[send] {account_id} run_sync_round_with_source: list_folders FAILED ({e}) \
                 — receive round returns Err (queued Sends already drained at the top via \
                 run_replay_round; only folder SYNC is skipped here)."
            );
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

    // Addresses that belong to the account itself (excluded from contact
    // auto-extraction). Extracted into `own_emails_for_account` so the IDLE
    // watcher's apply path reuses it.
    let own_emails: Vec<String> = own_emails_for_account(&engine.pool, account_id).await;

    // Per-folder delta sync. INBOX is synced here too (cursor-based, idempotent)
    // — the single-connection actor serializes IDLE and commands on ONE socket,
    // so there's no concurrent-SELECT reason to skip it. The 300s poll sweeps
    // non-INBOX folders + acts as an INBOX backstop; realtime INBOX comes from
    // the actor's IDLE push (handled in the worker's `select!`).
    for f in &folders {
        // Source-owned cursor load: each source reads its own persisted cursor
        // (ImapSource -> folder_sync_state, EasSource -> eas_sync_state).
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
        apply_folder_and_emit(engine, account_id, f, &delta, &own_emails).await;
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

    // NOTE: `run_replay_round` now runs at the TOP of this function (before the
    // rate-limit/breaker/list_folders gates) so a queued Send is never blocked by
    // a receive-side failure. See the rationale at the top of this function.
    // (Previously this tail call was the only place Sends fired — a rate-limited,
    // breaker-tripped, or flaky-list_folders account would starve Sends forever.)

    // Best-effort contact sync pass. A configured CardDAV/Google/EAS source is
    // independent of mail sync; failures are logged but do not fail the round.
    if let Err(e) = crate::sync::contacts::source::run_for_account(&engine.pool, account_id).await {
        log::warn!("[contacts] {account_id} sync-source pass failed: {e}");
    }

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
        send_results: std::sync::Mutex<Vec<SendResultEvent>>,
    }
    impl TestSink {
        fn new() -> Self {
            Self {
                deltas: std::sync::Mutex::new(vec![]),
                new_mails: std::sync::Mutex::new(vec![]),
                statuses: std::sync::Mutex::new(vec![]),
                queues: std::sync::Mutex::new(vec![]),
                bodies_written: std::sync::Mutex::new(vec![]),
                send_results: std::sync::Mutex::new(vec![]),
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
        fn emit_send_result(&self, e: SendResultEvent) {
            self.send_results.lock().unwrap().push(e);
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

    /// Regression: SyncEngine::start must be idempotent. Duplicate startup calls
    /// (e.g. React StrictMode double-mount) should not spawn overlapping workers.
    #[tokio::test]
    async fn start_is_idempotent_for_active_accounts() {
        let tmp = tempfile::tempdir().unwrap();
        let pool = init_db(tmp.path()).await.unwrap();
        seed_account(&pool, "a").await;

        let sink = Arc::new(TestSink::new());
        let engine = SyncEngine::new(pool.clone(), sink.clone());

        engine.start().await.unwrap();
        engine.start().await.unwrap();

        assert_eq!(
            engine.worker_count().await,
            1,
            "start() must not spawn duplicate workers for the same account"
        );
    }

    /// Regression: two concurrent ensure_worker calls must produce exactly one
    /// worker. Without a guard, both can pass the contains_key check before either
    /// inserts its placeholder, spawning duplicate workers.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn ensure_worker_is_race_free() {
        let tmp = tempfile::tempdir().unwrap();
        let pool = init_db(tmp.path()).await.unwrap();
        seed_account(&pool, "a").await;

        let sink = Arc::new(TestSink::new());
        let engine = SyncEngine::new(pool.clone(), sink.clone());
        let engine_for_count = Arc::clone(&engine);

        let engine2 = Arc::clone(&engine);
        let (a1, a2) = ("a".to_string(), "a".to_string());
        let (r1, r2) = tokio::join!(
            tokio::spawn(async move { engine.ensure_worker(a1).await }),
            tokio::spawn(async move { engine2.ensure_worker(a2).await }),
        );
        r1.unwrap();
        r2.unwrap();

        assert_eq!(
            engine_for_count.worker_count().await,
            1,
            "concurrent ensure_worker calls must not spawn duplicate workers"
        );
        assert_eq!(
            engine_for_count.spawned_count(),
            1,
            "concurrent ensure_worker calls must not invoke spawn_worker more than once"
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
        async fn send(&self, _r: &[u8]) -> Result<(), crate::sync_engine::SourceError> {
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
        async fn send(&self, _r: &[u8]) -> Result<(), crate::sync_engine::SourceError> {
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

    /// Regression for "replay tail-gating": `run_replay_round` MUST drain queued
    /// ops even when the receive-side `list_folders` fails. Before the fix, replay
    /// ran only at the TAIL of `run_sync_round_with_source` (after `list_folders`),
    /// so a `list_folders` error starved ALL queued ops (Send/MarkRead/…)
    /// indefinitely — the "replay worker never sends" symptom. Now replay runs at
    /// the TOP, before the receive gates.
    #[tokio::test]
    async fn replay_drains_queue_even_when_list_folders_fails() {
        use async_trait::async_trait;
        struct OutageButFlagsOk;
        #[async_trait]
        impl MailSource for OutageButFlagsOk {
            fn capabilities(&self) -> crate::sync_engine::Capabilities {
                crate::sync_engine::Capabilities::default()
            }
            async fn list_folders(
                &self,
            ) -> Result<Vec<crate::sync_engine::RemoteFolder>, crate::sync_engine::SourceError>
            {
                Err(crate::sync_engine::SourceError::Other("simulated outage".into()))
            }
            async fn sync_folder(
                &self,
                _f: &crate::sync_engine::RemoteFolder,
                _c: crate::sync_engine::Cursor,
            ) -> Result<crate::sync_engine::FolderDelta, crate::sync_engine::SourceError> {
                Err(crate::sync_engine::SourceError::Unsupported)
            }
            async fn fetch_body(
                &self,
                _f: &crate::sync_engine::RemoteFolder,
                _u: u32,
            ) -> Result<Option<String>, crate::sync_engine::SourceError> {
                Err(crate::sync_engine::SourceError::Unsupported)
            }
            async fn set_flags(
                &self,
                _f: &crate::sync_engine::RemoteFolder,
                _u: &[u32],
                _flag: &str,
                _add: bool,
            ) -> Result<(), crate::sync_engine::SourceError> {
                Ok(())
            }
            async fn move_messages(
                &self,
                _s: &crate::sync_engine::RemoteFolder,
                _u: &[u32],
                _d: &crate::sync_engine::RemoteFolder,
            ) -> Result<(), crate::sync_engine::SourceError> {
                Err(crate::sync_engine::SourceError::Unsupported)
            }
            async fn delete_messages(
                &self,
                _f: &crate::sync_engine::RemoteFolder,
                _u: &[u32],
            ) -> Result<(), crate::sync_engine::SourceError> {
                Err(crate::sync_engine::SourceError::Unsupported)
            }
            async fn append(
                &self,
                _f: &crate::sync_engine::RemoteFolder,
                _r: &[u8],
                _fl: &[&str],
            ) -> Result<(), crate::sync_engine::SourceError> {
                Err(crate::sync_engine::SourceError::Unsupported)
            }
            async fn send(&self, _r: &[u8]) -> Result<(), crate::sync_engine::SourceError> {
                Ok(())
            }
        }

        let tmp = tempfile::tempdir().unwrap();
        let pool = init_db(tmp.path()).await.unwrap();
        seed_account(&pool, "a").await;
        seed_pending_markread(&pool, "a", "op-1", "msg-1", 42, true).await;
        let sink = Arc::new(TestSink::new());
        let engine = SyncEngine::new(pool.clone(), sink.clone());

        // list_folders fails → pre-fix this returned Err BEFORE replay, stranding the op.
        let res = run_sync_round_with_source(&engine, "a", "imap", &OutageButFlagsOk).await;
        assert!(
            res.is_err(),
            "list_folders failure still returns Err for the receive round"
        );

        // But the queued op DRAINED anyway (replay ran at the TOP, before list_folders).
        let (cnt,): (i64,) =
            sqlx::query_as("SELECT COUNT(*) FROM pending_operations WHERE account_id = 'a'")
                .fetch_one(&pool)
                .await
                .unwrap();
        assert_eq!(
            cnt, 0,
            "queued op must drain even when list_folders fails (replay runs before receive gates)"
        );
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
            async fn send(&self, _r: &[u8]) -> Result<(), crate::sync_engine::SourceError> {
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
            pick_realtime_strategy(&src.capabilities(), true),
            RealtimeStrategy::Idle
        );
    }

    #[test]
    fn pick_realtime_strategy_poll_when_source_has_no_idle() {
        // Default caps (idle: false) → strategy is Poll (poll-only).
        let src = MockSource::new(vec![], vec![]);
        assert_eq!(
            pick_realtime_strategy(&src.capabilities(), true),
            RealtimeStrategy::Poll
        );
    }

    #[test]
    fn pick_realtime_strategy_poll_for_empty_default_caps() {
        // Bare default caps (no source) — the case before the first sync round
        // warms the ImapSource caps cache. Must be Poll so no watcher spawns.
        assert_eq!(
            pick_realtime_strategy(&Capabilities::default(), true),
            RealtimeStrategy::Poll
        );
    }

    #[test]
    fn pick_realtime_strategy_poll_when_idle_disabled_by_profile() {
        // Server advertises IDLE but profile says unreliable → Poll.
        let caps = Capabilities { idle: true, ..Default::default() };
        assert_eq!(
            pick_realtime_strategy(&caps, false),
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

    // ---- Send-flow T6: send_op worker-path test ----
    //
    // Send no longer flows through `exec_via_source` (the T3 base64url bridge
    // is gone; the variant now carries a structured `SendDraft`). The replay
    // worker intercepts `MutationOp::Send` and routes it through `send_op` →
    // `build_and_send`, which builds RFC5322 bytes via `mail_builder::build_mime`
    // and hands them to `MailSource::send(&[u8])`. This test drives the core
    // directly with a `MockSource` (avoiding a full `SyncEngine` construction)
    // and asserts the recorded `Send` call's bytes contain the draft's subject
    // and body, proving the build-and-send path works end-to-end at the unit
    // level. The exec_via_source fallback arm is covered by
    // `exec_via_source_send_returns_unreachable_fallback` in `db::mutations`.

    #[tokio::test]
    async fn send_op_builds_mime_and_calls_send() {
        use crate::mail::builder::{AddressSpec, SendDraft};
        use crate::sync_engine::mock_source::RecordedCall;

        let src = MockSource::new(vec![], vec![]);
        let draft = SendDraft {
            draft_id: "e1".into(),
            from: AddressSpec {
                name: None,
                email: "alice@kylins.local".into(),
            },
            to: vec![AddressSpec {
                name: None,
                email: "bob@kylins.local".into(),
            }],
            subject: "Hello from T6".into(),
            text_body: Some("the quick brown fox".into()),
            ..Default::default()
        };

        // Drive the core build-and-send logic directly. `send_op` wraps this
        // with engine + account_id params threaded for T8; those are unused in
        // T6 (`let _ = ...`), so testing the core avoids spinning up a full
        // SyncEngine + pool just to exercise the build+send path.
        build_and_send(&src, &draft).await.unwrap();

        // Exactly one send call recorded, with the MIME bytes that contain the
        // draft's subject + body. This proves: (a) Send reached `src.send`
        // (not `exec_via_source`'s fallback arm), and (b) `build_mime`
        // produced bytes carrying the draft's content.
        let calls = src.recorded_calls();
        assert_eq!(calls.len(), 1, "exactly one send call expected");
        match &calls[0] {
            RecordedCall::Send { raw_bytes } => {
                let s = String::from_utf8_lossy(raw_bytes);
                assert!(
                    s.contains("Subject:") && s.contains("Hello from T6"),
                    "MIME bytes must contain the draft's Subject header; got:\n{s}"
                );
                assert!(
                    s.contains("the quick brown fox"),
                    "MIME bytes must contain the draft's text body; got:\n{s}"
                );
            }
            other => panic!("expected RecordedCall::Send, got {other:?}"),
        }
    }

    // ---- Send-flow T8: best-effort Sent-append + save_sent_copy + cleanup ----
    //
    // T8 widens `send_op` from "build + send" to "build + send + best-effort
    // IMAP-APPEND to Sent + cleanup staged attachments". The load-bearing
    // invariant is **best-effort means NEVER fail the op** — an append failure
    // or cleanup failure logs a warning and `send_op` still returns Ok (so the
    // replay worker `mark_completed`s the op, no retry, no duplicate send).
    // The append is gated by BOTH `!saves_sent_automatically` AND the
    // per-account `save_sent_copy` setting (default true on missing key).

    use crate::db::settings;
    use crate::mail::builder::{AddressSpec, SendDraft};
    use crate::sync_engine::mock_source::RecordedCall;

    /// Seed a `labels` row with `role='sent'` for the account, matching the
    /// shape the IMAP folder-list sync writes (so `resolve_sent_folder` finds
    /// it). `remote_id` carries the IMAP path the append will target.
    async fn seed_sent_folder(pool: &SqlitePool, account_id: &str, remote_id: &str) {
        sqlx::query(
            "INSERT INTO labels (id, account_id, name, type, visible, sort_order, source, role,
                                 remote_id, delimiter, mail_class)
             VALUES (?, ?, 'Sent', 'system', 1, 0, 'imap', 'sent', ?, '/', 'mail')",
        )
        .bind(format!("{account_id}:{remote_id}"))
        .bind(account_id)
        .bind(remote_id)
        .execute(pool)
        .await
        .unwrap();
    }

    /// Minimal text-only draft for T8 tests. `draft_id` is the dir name under
    /// `<appData>/outbox-attachments/` that the cleanup step removes.
    fn t8_draft(draft_id: &str) -> SendDraft {
        SendDraft {
            draft_id: draft_id.into(),
            from: AddressSpec {
                name: None,
                email: "alice@kylins.local".into(),
            },
            to: vec![AddressSpec {
                name: None,
                email: "bob@kylins.local".into(),
            }],
            subject: "Hello from T8".into(),
            text_body: Some("the quick brown fox".into()),
            ..Default::default()
        }
    }

    /// IMAP-like caps: `saves_sent_automatically = false` (client must APPEND
    /// to Sent). This is the gate that makes `send_op` attempt the append.
    fn imap_caps() -> crate::sync_engine::Capabilities {
        crate::sync_engine::Capabilities {
            saves_sent_automatically: false,
            ..Default::default()
        }
    }

    /// EAS-like caps: `saves_sent_automatically = true` (SaveInSentItems
    /// already saved). `send_op` must SKIP the append for these sources.
    fn eas_caps() -> crate::sync_engine::Capabilities {
        crate::sync_engine::Capabilities {
            saves_sent_automatically: true,
            ..Default::default()
        }
    }

    /// IMAP/SMTP account + a Sent folder + default `save_sent_copy` (absent =
    /// true) → `send_op` MUST call `src.append(&["\\Seen"])` once with the
    /// MIME bytes that `send` already saw. Pins the happy path: append fires,
    /// the folder is the resolved Sent, the flag is `\Seen`.
    #[tokio::test]
    async fn send_op_appends_for_imap_when_save_sent() {
        let tmp = tempfile::tempdir().unwrap();
        let pool = init_db(tmp.path()).await.unwrap();
        seed_account(&pool, "a").await;
        seed_sent_folder(&pool, "a", "Sent").await;

        let sink = Arc::new(TestSink::new());
        let engine = SyncEngine::with_data_dir(
            pool.clone(),
            sink.clone(),
            tmp.path().to_path_buf(),
        );
        let src = MockSource::new(vec![], vec![]).with_caps(imap_caps());

        send_op(&engine, "a", &src, &t8_draft("d1")).await.unwrap();

        let calls = src.recorded_calls();
        // Exactly two calls: Send, then Append (in that order).
        assert_eq!(
            calls.len(),
            2,
            "IMAP/SMTP send_op must record Send + Append; got {calls:?}"
        );
        assert!(matches!(calls[0], RecordedCall::Send { .. }));
        match &calls[1] {
            RecordedCall::Append {
                folder,
                flags,
                raw_bytes,
            } => {
                assert_eq!(folder, "Sent", "append must target the resolved Sent folder");
                assert_eq!(flags, &vec!["\\Seen".to_string()], "append must pass \\Seen");
                // Reuse invariant: the same MIME bytes are appended, not rebuilt.
                let s = String::from_utf8_lossy(raw_bytes);
                assert!(
                    s.contains("Hello from T8"),
                    "appended bytes must be the same MIME that was sent"
                );
            }
            other => panic!("expected RecordedCall::Append, got {other:?}"),
        }
    }

    /// EAS account (saves_sent_automatically=true) → `send_op` MUST NOT call
    /// `append`. The SaveInSentItems EAS flag already server-side stored the
    /// copy; calling append would double-save. Pins the gate.
    #[tokio::test]
    async fn send_op_skips_append_for_eas() {
        let tmp = tempfile::tempdir().unwrap();
        let pool = init_db(tmp.path()).await.unwrap();
        seed_account(&pool, "a").await;
        // A Sent folder exists, but EAS caps must short-circuit before lookup.
        seed_sent_folder(&pool, "a", "Sent").await;

        let sink = Arc::new(TestSink::new());
        let engine = SyncEngine::with_data_dir(
            pool.clone(),
            sink.clone(),
            tmp.path().to_path_buf(),
        );
        let src = MockSource::new(vec![], vec![]).with_caps(eas_caps());

        send_op(&engine, "a", &src, &t8_draft("d2")).await.unwrap();

        let calls = src.recorded_calls();
        assert_eq!(
            calls.len(),
            1,
            "EAS send_op must record only Send (no append); got {calls:?}"
        );
        assert!(matches!(calls[0], RecordedCall::Send { .. }));
    }

    /// Mock `append` returns Err, `send` returns Ok → `send_op` returns Ok.
    /// This is THE load-bearing best-effort invariant: a Sent-append failure
    /// after a successful SMTP send must NOT fail the op (otherwise the replay
    /// worker `mark_failed`s + retries, re-sending the email → duplicates).
    #[tokio::test]
    async fn send_op_append_failure_does_not_fail_op() {
        let tmp = tempfile::tempdir().unwrap();
        let pool = init_db(tmp.path()).await.unwrap();
        seed_account(&pool, "a").await;
        seed_sent_folder(&pool, "a", "Sent").await;

        let sink = Arc::new(TestSink::new());
        let engine = SyncEngine::with_data_dir(
            pool.clone(),
            sink.clone(),
            tmp.path().to_path_buf(),
        );
        let src = MockSource::new(vec![], vec![])
            .with_caps(imap_caps())
            .with_fail_append(true);

        // Must return Ok despite the append failure.
        let res = send_op(&engine, "a", &src, &t8_draft("d3")).await;
        assert!(res.is_ok(), "append failure must NOT fail the op");

        // Both Send and Append were attempted (the failure was on the append
        // side, not a skip).
        let calls = src.recorded_calls();
        assert_eq!(calls.len(), 2);
        assert!(matches!(calls[0], RecordedCall::Send { .. }));
        assert!(matches!(calls[1], RecordedCall::Append { .. }));
    }

    /// On successful send, `send_op` MUST remove the staged attachment
    /// directory `<appData>/outbox-attachments/{draft_id}/`. The dir is
    /// created by the T7 frontend `attachments.ts` picker; leaving it would
    /// leak user files (potentially large). Stages a temp dir matching the
    /// cleanup path, asserts it exists before + is gone after.
    #[tokio::test]
    async fn send_op_cleans_up_attachments_on_success() {
        let tmp = tempfile::tempdir().unwrap();
        let pool = init_db(tmp.path()).await.unwrap();
        seed_account(&pool, "a").await;
        // EAS caps so the append step is skipped — isolates the cleanup
        // assertion (we're not depending on a Sent folder here).
        seed_sent_folder(&pool, "a", "Sent").await;

        let sink = Arc::new(TestSink::new());
        let engine = SyncEngine::with_data_dir(
            pool.clone(),
            sink.clone(),
            tmp.path().to_path_buf(),
        );
        let src = MockSource::new(vec![], vec![]).with_caps(eas_caps());

        // Stage the attachment dir matching the T7 frontend layout exactly:
        // `<data_dir>/outbox-attachments/{draft_id}/attachment.png`.
        let draft_id = "cleanup-test-draft";
        let attach_dir = tmp
            .path()
            .join("outbox-attachments")
            .join(draft_id);
        std::fs::create_dir_all(&attach_dir).unwrap();
        let staged_file = attach_dir.join("attachment.png");
        std::fs::write(&staged_file, b"pretend-png-bytes").unwrap();
        assert!(staged_file.exists(), "precondition: staged file exists");

        send_op(&engine, "a", &src, &t8_draft(draft_id))
            .await
            .unwrap();

        assert!(
            !attach_dir.exists(),
            "staged attachment dir must be removed on successful send"
        );
    }

    /// `save_sent_copy` set explicitly to `false` for the account → append is
    /// skipped (Send still fires). Pins the per-account opt-out: a user who
    /// disables "save sent copy" must not get the IMAP APPEND.
    #[tokio::test]
    async fn send_op_skips_append_when_save_sent_copy_false() {
        let tmp = tempfile::tempdir().unwrap();
        let pool = init_db(tmp.path()).await.unwrap();
        seed_account(&pool, "a").await;
        seed_sent_folder(&pool, "a", "Sent").await;
        settings::set_bool(
            &pool,
            "account.a.save_sent_copy",
            false,
        )
        .await
        .unwrap();

        let sink = Arc::new(TestSink::new());
        let engine = SyncEngine::with_data_dir(
            pool.clone(),
            sink.clone(),
            tmp.path().to_path_buf(),
        );
        let src = MockSource::new(vec![], vec![]).with_caps(imap_caps());

        send_op(&engine, "a", &src, &t8_draft("d4")).await.unwrap();

        let calls = src.recorded_calls();
        assert_eq!(
            calls.len(),
            1,
            "save_sent_copy=false must skip append; got {calls:?}"
        );
        assert!(matches!(calls[0], RecordedCall::Send { .. }));
    }

    /// Default-true invariant: when the `save_sent_copy` key is ABSENT (None),
    /// `send_op` MUST still append. This pins the "None → true" rule so a
    /// fresh install with no settings row keeps saving Sent copies.
    #[tokio::test]
    async fn send_op_appends_when_save_sent_copy_key_absent() {
        let tmp = tempfile::tempdir().unwrap();
        let pool = init_db(tmp.path()).await.unwrap();
        seed_account(&pool, "a").await;
        seed_sent_folder(&pool, "a", "Sent").await;
        // Intentionally DO NOT set the key — asserts the None-default-true path.

        let sink = Arc::new(TestSink::new());
        let engine = SyncEngine::with_data_dir(
            pool.clone(),
            sink.clone(),
            tmp.path().to_path_buf(),
        );
        let src = MockSource::new(vec![], vec![]).with_caps(imap_caps());

        send_op(&engine, "a", &src, &t8_draft("d5")).await.unwrap();

        let calls = src.recorded_calls();
        assert_eq!(
            calls.len(),
            2,
            "absent key (default-true) must still append; got {calls:?}"
        );
        // Verify the key really was absent (sanity: confirms the default-true
        // path is what fired, not a stale row).
        let v = settings::get_bool(&pool, "account.a.save_sent_copy")
            .await
            .unwrap();
        assert!(v.is_none(), "precondition: key really absent");
    }

    // ---- sync:send-result emission ----
    //
    // `send_op` must emit a `SendResultEvent` on the three outcomes so the
    // frontend can surface toast / error-banner feedback without re-polling
    // the queue. Pins:
    //   - success: exactly one event, success=true, error=None, BEFORE the
    //     best-effort Sent-append + cleanup (so an append failure never
    //     produces a duplicate or flips the signal).
    //   - transport failure: exactly one event, success=false, error=Some(..),
    //     emitted BEFORE the Err return so the frontend sees the failure
    //     immediately (rather than waiting for the next replay round to mark
    //     it failed).
    // The recording `TestSink` (above) captures `SendResultEvent`s; the
    // MockSource is extended with `with_fail_send` to drive the transport Err
    // without spinning up a real SMTP socket.

    /// Happy path: `src.send` Ok → exactly one `SendResultEvent` with
    /// `success=true, error=None`, carrying the draft_id and account_id the
    /// frontend needs to reconcile the originating composer tab.
    #[tokio::test]
    async fn send_op_emits_send_result_success_on_transport_ok() {
        let tmp = tempfile::tempdir().unwrap();
        let pool = init_db(tmp.path()).await.unwrap();
        seed_account(&pool, "a").await;
        // EAS caps so the Sent-append is SKIPPED — isolates the success-emit
        // assertion (the only event captured should be the success, not an
        // append-side artifact).
        let sink = Arc::new(TestSink::new());
        let engine = SyncEngine::with_data_dir(
            pool.clone(),
            sink.clone(),
            tmp.path().to_path_buf(),
        );
        let src = MockSource::new(vec![], vec![]).with_caps(eas_caps());

        send_op(&engine, "a", &src, &t8_draft("ok-1"))
            .await
            .expect("send_op should succeed when src.send is Ok");

        let evts = sink.send_results.lock().unwrap().clone();
        assert_eq!(
            evts.len(),
            1,
            "exactly one send-result event on success; got {evts:?}"
        );
        assert_eq!(evts[0].account_id, "a");
        assert_eq!(evts[0].draft_id, "ok-1");
        assert!(evts[0].success);
        assert!(
            evts[0].error.is_none(),
            "success event must carry error=None"
        );
    }

    /// Failure path: `src.send` Err → exactly one `SendResultEvent` with
    /// `success=false, error=Some(..)` BEFORE `send_op` returns Err. The
    /// transport error string must be surfaced verbatim so the frontend banner
    /// can display it (e.g. "SMTP relay denied: auth required").
    #[tokio::test]
    async fn send_op_emits_send_result_failure_on_transport_err() {
        let tmp = tempfile::tempdir().unwrap();
        let pool = init_db(tmp.path()).await.unwrap();
        seed_account(&pool, "a").await;

        let sink = Arc::new(TestSink::new());
        let engine = SyncEngine::with_data_dir(
            pool.clone(),
            sink.clone(),
            tmp.path().to_path_buf(),
        );
        // MockSource with fail_send=true → src.send returns SourceError::Other.
        let src = MockSource::new(vec![], vec![])
            .with_caps(eas_caps())
            .with_fail_send(true);

        let res = send_op(&engine, "a", &src, &t8_draft("fail-1")).await;
        assert!(res.is_err(), "fail_send must surface as Err");

        let evts = sink.send_results.lock().unwrap().clone();
        assert_eq!(
            evts.len(),
            1,
            "exactly one send-result event on failure; got {evts:?}"
        );
        assert_eq!(evts[0].account_id, "a");
        assert_eq!(evts[0].draft_id, "fail-1");
        assert!(
            !evts[0].success,
            "transport failure must emit success=false"
        );
        let err = evts[0]
            .error
            .as_ref()
            .expect("failure event must carry error=Some(..)");
        assert!(
            err.contains("mock send failure"),
            "error string should carry the transport error verbatim; got: {err}"
        );
    }

    /// Best-effort invariant pinned at the event level: a Sent-append failure
    /// after a successful send MUST NOT emit a second `SendResultEvent` (and
    /// certainly not a failure event). The single success signal was already
    /// emitted at the moment `src.send` resolved Ok; everything below is
    /// best-effort and must not corrupt the success feedback.
    #[tokio::test]
    async fn send_op_does_not_emit_second_send_result_on_append_failure() {
        let tmp = tempfile::tempdir().unwrap();
        let pool = init_db(tmp.path()).await.unwrap();
        seed_account(&pool, "a").await;
        seed_sent_folder(&pool, "a", "Sent").await;

        let sink = Arc::new(TestSink::new());
        let engine = SyncEngine::with_data_dir(
            pool.clone(),
            sink.clone(),
            tmp.path().to_path_buf(),
        );
        // IMAP caps + fail_append → send succeeds, append fails. The op must
        // still return Ok (best-effort) and emit exactly ONE success event.
        let src = MockSource::new(vec![], vec![])
            .with_caps(imap_caps())
            .with_fail_append(true);

        send_op(&engine, "a", &src, &t8_draft("ok-append-fails"))
            .await
            .expect("append failure must NOT fail the op");

        let evts = sink.send_results.lock().unwrap().clone();
        assert_eq!(
            evts.len(),
            1,
            "append failure must not emit a second send-result event; got {evts:?}"
        );
        assert!(
            evts[0].success,
            "the single event must be the original success signal"
        );
    }

    // ---- Plan 4a Task 6: S/MIME send_op wiring ----
    //
    // send_op must call apply_crypto between build_mime and src.send when the
    // draft carries crypto_method=Smime + sign/encrypt. The wrapped bytes
    // (multipart/signed or application/pkcs7-mime enveloped-data) flow to
    // src.send. A crypto failure (e.g. missing recipient cert) MUST emit a
    // sync:send-result{success=false} event AND return Err(SourceError::Other)
    // — fail-closed, no plaintext fallback.

    use crate::keystore_bridge::SqliteKeyStore;
    use crate::mail::builder::CryptoMethod;
    use crypto_core::{CryptoBackend, CryptoPolicy, KeyGenParams, Standard};
    use crypto_smime::SmimeBackend;

    /// Generate an S/MIME keypair for an existing account and (optionally)
    /// flag it as the account's default signing key. Mirrors the seed pattern
    /// in `mail/crypto.rs` Task 5 tests: the keygen `user_id` is the account's
    /// email so `find_by_email` (which queries by the `email` column written by
    /// `SqliteKeyStore::put`) resolves it for encrypt-to-self + recipient
    /// lookups. Uses the EXISTING `seed_account` helper (email = `{id}@x.com`).
    async fn seed_smime_key_for_account(
        pool: &SqlitePool,
        account_id: &str,
        flag_default_sign: bool,
    ) {
        // Resolve the email the same way send_op will at send time so the
        // keygen user_id matches what `apply_crypto` queries for encrypt-to-self.
        let email: String = sqlx::query_scalar("SELECT email FROM accounts WHERE id = ?")
            .bind(account_id)
            .fetch_one(pool)
            .await
            .expect("seed account exists");
        let ks = std::sync::Arc::new(SqliteKeyStore::new(
            std::sync::Arc::new(pool.clone()),
            account_id,
        ));
        let backend = SmimeBackend::new(ks, CryptoPolicy::default_baseline());
        let key = backend
            .generate_key(KeyGenParams {
                standard: Standard::Smime,
                user_id: email,
                algorithm: "ECDSA-P256".into(),
                passphrase: None,
            })
            .await
            .expect("generate_key");
        if flag_default_sign {
            sqlx::query("UPDATE crypto_keys SET is_default_sign = 1 WHERE fingerprint = ?")
                .bind(key.fingerprint.as_str())
                .execute(pool)
                .await
                .expect("flag default signer");
        }
    }

    /// Helper that extracts the raw bytes from the single recorded `Send` call.
    /// Mirrors the brief's `src.last_send_bytes()` pseudocode by filtering the
    /// existing `MockSource::recorded_calls()` recorder for `RecordedCall::Send`.
    /// Returns `None` when no Send was recorded (the fail-closed assertion path).
    fn last_send_bytes(src: &MockSource) -> Option<Vec<u8>> {
        src.recorded_calls().into_iter().find_map(|c| match c {
            RecordedCall::Send { raw_bytes } => Some(raw_bytes),
            _ => None,
        })
    }

    /// Sign path: `draft.sign=true` + a default-flagged S/MIME signing key →
    /// `src.send` receives bytes containing `multipart/signed`. Proves the
    /// Task 5 `apply_crypto` orchestrator is invoked on the send path and the
    /// wrapped bytes (not the inner MIME) reach transport.
    #[tokio::test]
    async fn send_op_signs_when_draft_requests_smime_sign() {
        let tmp = tempfile::tempdir().unwrap();
        let pool = init_db(tmp.path()).await.unwrap();
        seed_account(&pool, "a").await; // email: a@x.com
        seed_smime_key_for_account(&pool, "a", true).await; // default-flagged signer

        let sink = Arc::new(TestSink::new());
        let engine = SyncEngine::with_data_dir(
            pool.clone(),
            sink.clone(),
            tmp.path().to_path_buf(),
        );
        // EAS caps → skip Sent-append so the only recorded call is Send.
        let src = MockSource::new(vec![], vec![]).with_caps(eas_caps());

        let mut draft = t8_draft("smime-sign-1");
        draft.crypto_method = CryptoMethod::Smime;
        draft.sign = true;

        send_op(&engine, "a", &src, &draft)
            .await
            .expect("send_op should succeed for sign-only");

        let raw = last_send_bytes(&src).expect("send was called");
        let s = String::from_utf8_lossy(&raw);
        assert!(
            s.contains("multipart/signed"),
            "signed send must wrap MIME in multipart/signed; got:\n{s}"
        );
        assert!(
            s.contains("application/pkcs7-signature"),
            "multipart/signed part 2 must be application/pkcs7-signature; got:\n{s}"
        );
    }

    /// Encrypt path: sender cert (encrypt-to-self) + one recipient cert →
    /// `src.send` receives bytes containing
    /// `application/pkcs7-mime; smime-type=enveloped-data`. Proves the
    /// recipient-set resolution + enveloped wrapping fires on send.
    #[tokio::test]
    async fn send_op_encrypts_and_includes_self_as_recipient() {
        let tmp = tempfile::tempdir().unwrap();
        let pool = init_db(tmp.path()).await.unwrap();
        // Sender account a@x.com — own cert resolves for encrypt-to-self.
        seed_account(&pool, "a").await;
        seed_smime_key_for_account(&pool, "a", false).await;
        // Recipient account b@x.com — own cert under its own account row so
        // `find_by_email` (no account filter) locates it.
        seed_account(&pool, "b").await;
        seed_smime_key_for_account(&pool, "b", false).await;

        let sink = Arc::new(TestSink::new());
        let engine = SyncEngine::with_data_dir(
            pool.clone(),
            sink.clone(),
            tmp.path().to_path_buf(),
        );
        let src = MockSource::new(vec![], vec![]).with_caps(eas_caps());

        let mut draft = t8_draft("smime-encrypt-1");
        // Override recipient so it matches a seeded cert.
        draft.to = vec![AddressSpec {
            name: None,
            email: "b@x.com".into(),
        }];
        draft.crypto_method = CryptoMethod::Smime;
        draft.encrypt = true;

        send_op(&engine, "a", &src, &draft)
            .await
            .expect("send_op should succeed for encrypt");

        let raw = last_send_bytes(&src).expect("send was called");
        let s = String::from_utf8_lossy(&raw);
        assert!(
            s.contains("application/pkcs7-mime; smime-type=enveloped-data"),
            "encrypt send must wrap MIME in pkcs7-mime enveloped-data; got:\n{s}"
        );
    }

    /// Fail-closed: encrypting to a recipient with no cert in the keystore
    /// MUST return `Err`, emit a `sync:send-result{success=false}` event, and
    /// NOT call `src.send` (no plaintext leak). The error string carries the
    /// missing recipient email verbatim so the frontend banner is actionable.
    #[tokio::test]
    async fn send_op_missing_recipient_cert_surfaces_error_and_no_plaintext_send() {
        let tmp = tempfile::tempdir().unwrap();
        let pool = init_db(tmp.path()).await.unwrap();
        // Sender a@x.com — own cert resolves (encrypt-to-self). Recipient
        // nobody@x.com has NO seeded cert → apply_crypto returns
        // MissingRecipientCert and send_op must fail-closed.
        seed_account(&pool, "a").await;
        seed_smime_key_for_account(&pool, "a", false).await;

        let sink = Arc::new(TestSink::new());
        let engine = SyncEngine::with_data_dir(
            pool.clone(),
            sink.clone(),
            tmp.path().to_path_buf(),
        );
        let src = MockSource::new(vec![], vec![]).with_caps(eas_caps());

        let mut draft = t8_draft("smime-missing-rcpt-1");
        draft.to = vec![AddressSpec {
            name: None,
            email: "nobody@x.com".into(),
        }];
        draft.crypto_method = CryptoMethod::Smime;
        draft.encrypt = true;

        let err = send_op(&engine, "a", &src, &draft)
            .await
            .expect_err("missing recipient cert must surface as Err");
        assert!(
            err.to_string().contains("no S/MIME cert for recipient"),
            "expected missing-recipient error, got: {err}"
        );

        // Fail-closed: src.send was NEVER called (no plaintext leak).
        assert!(
            last_send_bytes(&src).is_none(),
            "must NOT call src.send when crypto fails (plaintext leak)"
        );
        assert!(
            src.recorded_calls().is_empty(),
            "no source mutation calls should be recorded on crypto failure; got {:?}",
            src.recorded_calls()
        );

        // The failure was surfaced via sync:send-result so the frontend can
        // render an immediate error banner (independent of mark_failed).
        let evts = sink.send_results.lock().unwrap().clone();
        assert_eq!(
            evts.len(),
            1,
            "exactly one send-result event on crypto failure; got {evts:?}"
        );
        assert!(!evts[0].success, "crypto failure must emit success=false");
        assert_eq!(evts[0].draft_id, "smime-missing-rcpt-1");
        let err_msg = evts[0]
            .error
            .as_deref()
            .expect("failure event must carry error=Some(..)");
        assert!(
            err_msg.contains("no S/MIME cert for recipient"),
            "event error string must carry the missing-recipient detail; got: {err_msg}"
        );
    }
}
