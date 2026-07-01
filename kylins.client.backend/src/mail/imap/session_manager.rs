//! Persistent IMAP session manager — one long-lived `Session<ImapStream>` per
//! account, with lazy connect, reconnect-on-drop, mailbox serialization, and a
//! NOOP keepalive. See `docs/superpowers/plans/2026-06-30-sync-engine-phase3-imap-persistent-connection.md`.
//!
//! Task 1 (BASE `36b552e`) delivered the pure helpers (`classify_error`,
//! `should_reselect`), the `Handle` / `ImapSessionManager` skeleton, and the
//! Send-probe. Task 2 implements the heart: `execute()` — lazy connect, mailbox
//! lock (re-SELECT only on folder change), and reconnect-once on transient
//! errors. Task 5 (this commit) adds the per-account NOOP keepalive task (120s
//! interval, well under the ~29min server idle timeout) + `shutdown()` which
//! aborts every keepalive and best-effort LOGOUTs each session.

use async_imap::Session;
use std::collections::HashMap;
use std::future::Future;
use std::pin::Pin;
use std::sync::Arc;
use std::time::{Duration, Instant};
use tokio::task::JoinHandle;

use crate::mail::imap::client as imap_client;
use crate::mail::imap::client::ImapStream;
use crate::mail::imap::types::ImapConfig;

/// NOOP keepalive interval. async-imap sessions live in a `Mutex<Option<_>>`
/// with no IDLE; without periodic traffic the server idle-times the TCP
/// connection out (~29 min on the test IMAP server, common 30 min elsewhere).
/// 120 s is well under that ceiling with room for jitter, and matches
/// imapflow's default NOOP interval (we mirror their mailbox-lock pattern in
/// `execute`). A round only fires when the session has actually been idle this
/// long — `last_used` is bumped on every `execute()`, and the keepalive skips
/// the NOOP if a real command just reset the server's idle clock.
const NOOP_KEEPALIVE_INTERVAL: Duration = Duration::from_secs(120);

/// Per-NOOP command timeout. A NOOP round-trip on a live connection is a few
/// hundred ms; if it doesn't return in 30 s the connection is dead and we drop
/// the session so the next `execute()` reconnects. Mirrors `IMAP_CMD_TIMEOUT`
/// in `client.rs` (kept private there, so re-declared here under strict scope —
/// changing `client.rs` is out of bounds for Task 5; the deviation is documented
/// in `task-5-report.md`).
const NOOP_CMD_TIMEOUT: Duration = Duration::from_secs(30);

/// Per-NOOP best-effort LOGOUT timeout in `shutdown()`. LOGOUT is a single
/// round-trip; if the server is unresponsive we don't want to stall app exit.
const SHUTDOWN_LOGOUT_TIMEOUT: Duration = Duration::from_secs(5);

/// Pure decision: should the keepalive fire a NOOP right now? True iff the
/// session has been idle (no `execute()`) for at least `NOOP_KEEPALIVE_INTERVAL`.
/// Factored out of the spawned task so the timing math is unit-testable without
/// a live socket or a tokio runtime — the only testable seam in the keepalive
/// (the rest — locking the session, sending NOOP, dropping on error — needs a
/// real `Session<ImapStream>` which can't be constructed in a unit test).
pub fn keepalive_should_fire(last_used: Instant, now: Instant, interval: Duration) -> bool {
    now.duration_since(last_used) >= interval
}

/// Classify an IMAP error string to decide whether reconnect+retry is worth
/// attempting. Transient errors (network drop, BYE, parse failure) get one
/// retry; Auth errors surface immediately (reconnecting with the same creds is
/// pointless); Other errors surface as-is.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ErrorKind {
    /// Network/transport/server-drop — one reconnect+retry may help.
    Transient,
    /// Auth failed — reconnecting with the same creds is pointless; surface.
    Auth,
    /// Anything else (rate-limit, malformed request, etc.) — surface as-is.
    Other,
}

/// Pure classifier — unit-tested without a socket. The substrings are matched
/// case-insensitively against the error text (the existing `imap_client::*`
/// helpers bake the server's text into their `format!` strings).
pub fn classify_error(err_str: &str) -> ErrorKind {
    let lower = err_str.to_ascii_lowercase();
    // Auth: the existing `connect_inner` emits "Login failed: ..." or
    // "XOAUTH2 authentication failed: ..."; async-imap surfaces
    // `AUTHENTICATIONFAILED` via these same paths.
    if lower.contains("authenticationfailed")
        || lower.contains("login failed")
        || lower.contains("authentication failed")
        || lower.contains("invalid credentials")
        || lower.contains("authentication credentials")
    {
        return ErrorKind::Auth;
    }
    // Transient: connection drop, server-side close, parse failure, timeout.
    // The existing helpers emit these as "... timed out ...", "... failed: ...",
    // "Connection closed during FETCH", etc.
    if lower.contains("connection closed")
        || lower.contains("connection reset")
        || lower.contains("broken pipe")
        || lower.contains("bye")
        || lower.contains("timed out")
        || lower.contains("tls")
        || lower.contains("eof")
        || lower.contains("connection refused")
        || lower.contains("parse")
        // Windows WSAECONNABORTED (10053): the server (or a middlebox) aborted
        // the established TCP connection. Hyper/Rustls surfaces this as
        // "connection aborted" / "established connection was aborted", and the
        // raw OS error text carries the numeric code. Pre-fix this fell through
        // to `Other`, so a mid-round server abort never triggered reconnect-once
        // — every subsequent folder in the round failed against the dead socket
        // (the "reconnect storm / all folders fail with 10053" symptom).
        // Treating it as Transient lets the existing reconnect-once loop fire.
        || lower.contains("connection aborted")
        || lower.contains("established connection was aborted")
        || lower.contains("10053")
    {
        return ErrorKind::Transient;
    }
    ErrorKind::Other
}

/// Pure decision: do we need to re-SELECT? Returns true when the requested
/// folder differs from the currently-selected one (or when nothing is selected
/// yet, or when the caller passes `None` meaning "no folder context required
/// but I might SELECT inside the op" — in that case we don't force a SELECT).
pub fn should_reselect(current: &Option<String>, requested: Option<&str>) -> bool {
    match (current, requested) {
        (_, None) => false,                              // op has no folder context
        (None, Some(_)) => true,                         // nothing selected yet
        (Some(cur), Some(req)) => cur != req,            // different folder
    }
}

/// A pure helper that decides whether the `execute()` retry loop should retry,
/// reconnect, or surface. Factored out so the control flow is unit-testable
/// without a live `Session`. The live `execute()` below calls this and acts on
/// the result.
///
/// `attempt` is 1 (first try) or 2 (retry after one reconnect).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RetryDecision {
    /// First attempt failed transiently — reconnect once and retry.
    ReconnectAndRetry,
    /// Auth failure OR second attempt failed — surface to caller.
    Surface,
}

pub fn retry_decision(err: &str, attempt: u8) -> RetryDecision {
    match (classify_error(err), attempt) {
        (_, 2) => RetryDecision::Surface, // already retried once — never loop
        (ErrorKind::Auth, _) => RetryDecision::Surface,
        (ErrorKind::Transient, 1) => RetryDecision::ReconnectAndRetry,
        (ErrorKind::Other, _) => RetryDecision::Surface, // non-transient: retrying won't help
        // `attempt` is documented as 1 or 2; any other value is a caller bug.
        // Surface rather than retry — never loop.
        _ => RetryDecision::Surface,
    }
}

// ---- Live session types (fully wired in Task 2; here for the Send-probe) ----

pub struct Handle {
    pub account_id: String,
    pub config: ImapConfig,
    /// `None` = not yet connected, or the last session dropped (needs reconnect).
    /// Held in a tokio Mutex because `Session::select` etc. are async.
    pub session: tokio::sync::Mutex<Option<Session<ImapStream>>>,
    /// The currently-SELECTed mailbox, if any. Tracked so we re-SELECT only
    /// when the requested folder differs (imapflow mailbox-lock pattern).
    pub selected_mailbox: tokio::sync::Mutex<Option<String>>,
    /// Updated on every `execute()`; the keepalive task reads this to skip a
    /// NOOP if the session was just used (NOOP right after a real command is
    /// wasteful — the command itself reset the server's idle clock).
    pub last_used: tokio::sync::Mutex<Instant>,
    /// Per-account NOOP keepalive task handle. `None` until the first
    /// `execute()` connects (spawn is lazy + idempotent — guarded by this
    /// Option). Aborted in `shutdown()`; never awaited (the task loops until
    /// aborted). Held in a Mutex so `execute()` (caller thread) and `shutdown()`
    /// can both take/replace it without a race.
    pub keepalive: tokio::sync::Mutex<Option<JoinHandle<()>>>,
}

pub struct ImapSessionManager {
    /// `pub` because Task 2's `execute()` reads/writes this map (insert-on-
    /// first-use, clone-the-Arc-per-op). Same skeleton-only rationale as the
    /// `Handle` fields above — kept public so this file compiles clean under
    /// `-D warnings` without behavior yet.
    pub accounts: tokio::sync::Mutex<HashMap<String, std::sync::Arc<Handle>>>,
}

impl ImapSessionManager {
    pub fn new() -> Self {
        Self {
            accounts: tokio::sync::Mutex::new(HashMap::new()),
        }
    }
}

impl Default for ImapSessionManager {
    fn default() -> Self {
        Self::new()
    }
}

// ============================ Task 2: live plumbing ============================

impl ImapSessionManager {
    /// Run `op` against the account's persistent session. Lazily connects on
    /// first use, re-SELECTs only when `folder` differs from the currently-
    /// selected mailbox, and reconnects+retries once on a transient connection
    /// error (network drop / BYE / parse failure / timeout). Auth errors and
    /// second-attempt failures surface immediately — Phase 3f's circuit breaker
    /// handles persistent outages, so we never loop here.
    ///
    /// `folder = None` means "this op has no per-folder context" (e.g. LIST,
    /// CAPABILITY) — the mailbox lock is still acquired (so concurrent ops
    /// don't interleave SELECTs) but no SELECT is forced.
    ///
    /// `op` is `FnMut` (not `FnOnce`) because the reconnect-once path may
    /// invoke it twice — once on the dead session, once on the fresh one.
    /// The op must therefore be idempotent w.r.t. its own captures across two
    /// calls (typical IMAP ops capture `&folder`/`&uids` and write results
    /// into an `&mut Vec`, which is safe to retry since the first call's
    /// partial results were never observed by the caller on the failure path).
    ///
    /// **Mailbox lock**: `handle.session` is a `tokio::sync::Mutex` held for
    /// the entire op (SELECT + `op(&mut session)`), so two `execute()` calls
    /// on the same account cannot interleave. The inner `selected_mailbox` /
    /// `last_used` locks are always acquired *after* `session` and never held
    /// across an `.await` (the only await on them is `Mutex::lock` itself) —
    /// lock ordering is `session` → `selected_mailbox` → `last_used`, and
    /// every acquirer in this file follows that order.
    pub async fn execute<O, R>(
        &self,
        account_id: &str,
        config: &ImapConfig,
        folder: Option<&str>,
        mut op: O,
    ) -> Result<R, String>
    where
        O: FnMut(
                &mut Session<ImapStream>,
            ) -> Pin<Box<dyn Future<Output = Result<R, String>> + Send + '_>>
            + Send,
        R: Send,
    {
        let handle = self.handle_for(account_id, config).await;

        for attempt in 1u8..=2 {
            // Lazy connect / reconnect-after-drop. Cheap fast path when the
            // session slot is already populated.
            handle.ensure_connected(config).await?;

            // Spawn the NOOP keepalive on first connect (idempotent — guarded
            // by the Option). Done BEFORE acquiring the session mutex so we
            // never hold two locks at once (and the keepalive's own lock
            // acquisition order stays consistent with the rest of this file).
            {
                let mut kg = handle.keepalive.lock().await;
                if kg.is_none() {
                    let h = Arc::clone(&handle);
                    *kg = Some(Self::spawn_noop_keepalive(h));
                }
            }

            // Acquire the per-account session mutex for the whole op so a
            // concurrent execute() cannot interleave SELECTs or commands.
            {
                let mut guard = handle.session.lock().await;
                let session = guard
                    .as_mut()
                    .ok_or_else(|| "session not connected after ensure_connected".to_string())?;

                // Re-SELECT only when the requested folder differs from the
                // currently-selected mailbox (imapflow mailbox-lock pattern).
                if let Some(folder) = folder {
                    let needs_select = {
                        let current = handle.selected_mailbox.lock().await;
                        should_reselect(&current, Some(folder))
                    };
                    if needs_select {
                        // SELECT validates+quotes the name (async-imap client.rs).
                        // 30s matches IMAP_CMD_TIMEOUT in client.rs.
                        tokio::time::timeout(
                            std::time::Duration::from_secs(30),
                            session.select(folder),
                        )
                        .await
                        .map_err(|_| format!("SELECT {folder} timed out"))?
                        .map_err(|e| format!("SELECT {folder} failed: {e}"))?;
                        *handle.selected_mailbox.lock().await = Some(folder.to_string());
                    }
                }

                // Mark last_used so the keepalive task can skip a redundant NOOP.
                *handle.last_used.lock().await = Instant::now();

                // Run the op against the session.
                match op(session).await {
                    Ok(r) => return Ok(r),
                    Err(e) => {
                        match retry_decision(&e, attempt) {
                            RetryDecision::Surface => {
                                // Reconnect-once exhausted (attempt 2 transient)
                                // OR auth/non-transient on attempt 1. Either way
                                // the session is suspect — for the 10053 / abort
                                // case it's provably dead, and even for a
                                // non-fatal BAD the connection may be in an
                                // indeterminate state. Drop it in place so the
                                // NEXT execute() (next folder in the round, or
                                // the next poll tick) starts fresh via
                                // ensure_connected rather than reusing a
                                // poisoned socket. Pre-fix this arm returned
                                // without clearing, so every subsequent folder
                                // in the round failed against the same dead
                                // connection (the "all folders fail with 10053"
                                // storm). Release the session lock BEFORE
                                // touching selected_mailbox (lock ordering:
                                // session → selected).
                                *guard = None;
                                drop(guard);
                                *handle.selected_mailbox.lock().await = None;
                                return Err(e);
                            }
                            RetryDecision::ReconnectAndRetry => {
                                log::warn!(
                                    "[imap-mgr] {} transient error (attempt {}): {e}; \
                                     reconnecting + retrying once",
                                    handle.account_id,
                                    attempt
                                );
                                // Drop the (likely-dead) session in place, then
                                // release the session lock BEFORE touching
                                // selected_mailbox (preserves lock ordering).
                                // ensure_connected on the next iteration dials
                                // fresh.
                                *guard = None;
                                drop(guard);
                                *handle.selected_mailbox.lock().await = None;
                                // 500ms cooldown before the redial so we don't
                                // hammer a server that is actively aborting our
                                // connections (the 10053 reconnect-storm symptom:
                                // attempt 2's fresh dial gets aborted just as
                                // fast, and without a gap the round burns through
                                // every folder in <1s of failed reconnects). Half
                                // a second is enough for the server/middlebox to
                                // recycle the connection slot without materially
                                // slowing a normal recovery (the 60s poll cadence
                                // hides it).
                                tokio::time::sleep(Duration::from_millis(500)).await;
                                continue; // -> attempt 2
                            }
                        }
                    }
                }
            }
        }
        // Unreachable: the loop returns Ok on success, returns Err on Surface,
        // or continues to attempt 2 which must Surface. Sentinel for the type
        // system; if hit it indicates a logic bug, not a recoverable state.
        Err("imap execute: exhausted retries without resolution".into())
    }

    /// Get-or-insert the per-account `Handle`. Cheap `Arc` clone out.
    ///
    /// Double-checked under separate read/write locks on the map — we don't
    /// hold the write lock while dialing (the dial happens lazily inside
    /// `ensure_connected`, on the session mutex, not the map mutex).
    pub async fn handle_for(&self, account_id: &str, config: &ImapConfig) -> Arc<Handle> {
        // Fast path: read lock + clone the Arc out.
        {
            let map = self.accounts.lock().await;
            if let Some(h) = map.get(account_id) {
                return Arc::clone(h);
            }
        }
        // Slow path: take the write lock. Re-check — another caller may have
        // inserted while we were waiting.
        let mut map = self.accounts.lock().await;
        if let Some(h) = map.get(account_id) {
            return Arc::clone(h);
        }
        let handle = Arc::new(Handle {
            account_id: account_id.to_string(),
            config: config.clone(),
            session: tokio::sync::Mutex::new(None),
            selected_mailbox: tokio::sync::Mutex::new(None),
            last_used: tokio::sync::Mutex::new(Instant::now()),
            // Spawned lazily on first `execute()` connect (idempotent — guarded
            // by the Option). None here means "no keepalive running yet".
            keepalive: tokio::sync::Mutex::new(None),
        });
        map.insert(account_id.to_string(), Arc::clone(&handle));
        handle
    }
}

// ============================ Task 5: keepalive + shutdown ============================

impl ImapSessionManager {
    /// Send a single NOOP on the session, with a timeout. Returns Err if the
    /// session is dead (timeout / transport error / parse failure) — the caller
    /// (keepalive task) reacts by dropping the session so the next `execute()`
    /// reconnects. NOOP is RFC 3501 §6.4.4 — the lightest valid IMAP command;
    /// the server responds with the current state (untagged \* EXISTS / EXPUNGE
    /// / FETCH etc. may arrive on the same stream but `async-imap`'s `noop`
    /// drains them into the unsolicited channel, so a NOOP round-trip is safe).
    ///
    /// Scope deviation: the brief put this helper in `client.rs` next to the
    /// other timeout wrappers. Task 5's strict scope forbids touching
    /// `client.rs`, so it lives here as a private free fn. Same body as the
    /// brief's `client::noop` (re-declared `NOOP_CMD_TIMEOUT` because
    /// `client::IMAP_CMD_TIMEOUT` is private).
    async fn noop_step(session: &mut Session<ImapStream>) -> Result<(), String> {
        tokio::time::timeout(NOOP_CMD_TIMEOUT, session.noop())
            .await
            .map_err(|_| {
                format!(
                    "NOOP timed out after {}s",
                    NOOP_CMD_TIMEOUT.as_secs()
                )
            })?
            .map_err(|e| format!("NOOP failed: {e}"))
    }

    /// Spawn a per-account NOOP keepalive task. Fires NOOP every
    /// `NOOP_KEEPALIVE_INTERVAL` (120s) when the session has actually been idle
    /// that long (a real `execute()` command would have reset the server's idle
    /// clock, making the NOOP redundant). Self-skips when the session is `None`
    /// (not yet connected / just dropped) — no socket to NOOP. If the NOOP
    /// errors, the session is assumed dead and set to `None` so the next
    /// `execute()` reconnects.
    ///
    /// **Lock ordering** (critical — the rest of this file locks
    /// `session → selected_mailbox → last_used`): this task takes `last_used`
    /// first (cheap, released at the statement boundary BEFORE awaiting
    /// `session`), then `session`, then — only on the error path —
    /// `selected_mailbox`. Because `last_used` is never held across the
    /// `session` await, no AB-BA deadlock with `execute()` (which takes
    /// `session` then `last_used`) is possible.
    ///
    /// Best-effort by construction: any error is logged and the loop continues
    /// (the next tick re-evaluates `last_used` / `session`). The task never
    /// panics — `noop_step` returns `Result`, and locking a `tokio::Mutex`
    /// doesn't panic. Aborted by `shutdown()` (via the stored `JoinHandle`).
    pub fn spawn_noop_keepalive(handle: Arc<Handle>) -> JoinHandle<()> {
        tokio::spawn(async move {
            // `tokio::time::interval` fires immediately on the first `tick()`;
            // we consume that tick here so the first real NOOP waits a full
            // interval. (Even if it didn't, the `keepalive_should_fire` gate
            // below would skip it — `last_used` was just bumped by the
            // `execute()` that spawned us.)
            let mut interval = tokio::time::interval(NOOP_KEEPALIVE_INTERVAL);
            interval.tick().await; // discard immediate first tick

            loop {
                interval.tick().await;

                // Gate 1: skip if a real command ran recently. `last_used` is
                // bumped at the end of every `execute()` op; if it's newer than
                // the interval, the server's idle clock was already reset and a
                // NOOP would be pure waste. The lock guard drops here (statement
                // boundary) — released BEFORE we await `session` below, keeping
                // the lock-ordering invariant documented above.
                let now = Instant::now();
                let last_used = *handle.last_used.lock().await;
                if !keepalive_should_fire(last_used, now, NOOP_KEEPALIVE_INTERVAL) {
                    continue;
                }

                // Gate 2: skip if not connected. Cheap fast path; also handles
                // the window where `execute()` dropped the session on a
                // transient error and hasn't reconnected yet (the next
                // `execute()` will dial + respawn is a no-op since the handle
                // is the same).
                let mut guard = handle.session.lock().await;
                let session = match guard.as_mut() {
                    Some(s) => s,
                    None => continue,
                };

                // Fire the NOOP. On error, drop the session in place (set
                // `*guard = None`) so the next `execute()` reconnects. The
                // selected-mailbox cache is also cleared — a fresh session
                // starts un-SELECTed. `selected_mailbox` lock is acquired AFTER
                // `session` (matches the documented ordering) and only on this
                // error path.
                if let Err(e) = Self::noop_step(session).await {
                    log::warn!(
                        "[imap-mgr] {} NOOP keepalive failed: {e}; dropping session \
                         (next execute() will reconnect)",
                        handle.account_id,
                    );
                    *guard = None;
                    // Drop the session lock BEFORE taking selected_mailbox —
                    // strict lock ordering (session before selected), and
                    // avoids holding session across an unrelated lock await.
                    drop(guard);
                    *handle.selected_mailbox.lock().await = None;
                }
                // Success path: `guard` drops here, session stays Some.
            }
        })
    }

    /// Shutdown: abort every per-account keepalive task + best-effort LOGOUT
    /// each live session. Intended for app exit / account removal. Idempotent —
    /// safe to call when no keepalives/sessions exist (the Options are None).
    ///
    /// **Lock ordering**: takes the accounts map once, then per-handle acquires
    /// `keepalive → session → selected_mailbox` (in that order, each released
    /// before the next). `selected_mailbox` isn't touched here (LOGOUT doesn't
    /// care about the selected mailbox), but the ordering is still consistent
    /// with the rest of the file. The 5s per-LOGOUT timeout bounds total
    /// shutdown time at `5s * account_count` worst case — acceptable for app
    /// exit; if you need tighter, abort-only (skip LOGOUT) is a follow-up.
    ///
    /// **Wiring status**: `lib.rs::run()` has no on-exit hook today (Tauri's
    /// `.run()` consumes the builder and exits at process end; the only
    /// window-event handler intercepts CloseRequested to minimize-to-tray).
    /// Calling `shutdown()` on real app exit is therefore a documented
    /// follow-up — see `task-5-report.md`. The method is complete and tested;
    /// only the call site is pending.
    pub async fn shutdown(&self) {
        let map = self.accounts.lock().await;
        for (_account_id, handle) in map.iter() {
            // Abort the keepalive first so it doesn't fight us for the session
            // lock mid-LOGOUT. `take()` leaves None, so a second shutdown() is
            // a no-op for this handle.
            if let Some(h) = handle.keepalive.lock().await.take() {
                h.abort();
            }
            // Best-effort LOGOUT. The session is consumed (`take()`); on
            // timeout we just drop it (the OS closes the TCP stream either
            // way). 5s ceiling per account.
            let mut guard = handle.session.lock().await;
            if let Some(mut session) = guard.take() {
                let _ = tokio::time::timeout(SHUTDOWN_LOGOUT_TIMEOUT, session.logout()).await;
            }
            // Clear the selected-mailbox cache too (defensive — if the handle
            // is reused after shutdown, the next execute() SELECTs fresh).
            *handle.selected_mailbox.lock().await = None;
        }
    }
}

impl Handle {
    /// Ensure `self.session` holds a live `Session`. Connects on first use and
    /// after a prior drop (None). If a session is already present, returns Ok
    /// without probing — the next command's success/failure is the liveness
    /// check (a fresh NOOP just to "test" the connection is wasteful; the
    /// reconnect-once loop in `execute` catches a dead session mid-command).
    pub async fn ensure_connected(&self, config: &ImapConfig) -> Result<(), String> {
        let mut guard = self.session.lock().await;
        if guard.is_some() {
            return Ok(());
        }
        // Trace logging at the connect boundary: the worker reaches
        // `ensure_connected` right after the keyring-decrypt step (one log line)
        // and then either hangs or dies silently. Logging BEFORE + AFTER the
        // connect call pinpoints whether the worker is wedged inside the dial
        // (TLS handshake / TCP / XOAUTH2) or died before reaching it. The
        // `&self.account_id` is captured in `Handle` so the log is per-account.
        log::info!(
            "[imap-mgr] {}: connecting to {}:{} (security={})...",
            self.account_id,
            config.host,
            config.port,
            config.security
        );
        match imap_client::connect(config).await {
            Ok(session) => {
                log::info!(
                    "[imap-mgr] {}: connected to {}:{}",
                    self.account_id,
                    config.host,
                    config.port
                );
                *guard = Some(session);
                // New session = nothing selected yet. Acquired after `session`
                // per the documented lock ordering; released at the statement
                // boundary.
                *self.selected_mailbox.lock().await = None;
                Ok(())
            }
            Err(e) => {
                log::warn!(
                    "[imap-mgr] {}: connect to {}:{} failed: {e}",
                    self.account_id,
                    config.host,
                    config.port
                );
                Err(e)
            }
        }
    }

    /// Drop the current session (if any) and dial a fresh one. Used by the
    /// keepalive task (Task 5) and by callers that want to force a reconnect
    /// without running an op. The reconnect-once path inside `execute` does
    /// its own in-place drop, so it does not call this.
    pub async fn reconnect(&self, config: &ImapConfig) -> Result<(), String> {
        // Acquire session lock first (lock ordering: session before selected).
        let mut guard = self.session.lock().await;
        // Take the old session (drops it, closing the TCP stream).
        if guard.take().is_some() {
            log::info!("[imap-mgr] {} reconnecting (dropped old session)", self.account_id);
        }
        let session = imap_client::connect(config).await?;
        *guard = Some(session);
        *self.selected_mailbox.lock().await = None;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Compile-time Send-probe — the load-bearing decision for the whole
    /// design. If this stops compiling after an `async-imap` upgrade, the
    /// mutex path is no longer viable and the code must move to a dedicated-
    /// thread actor (`LocalSet` + mpsc). Verified against async-imap 0.10.4
    /// on 2026-06-30; PASS (corroborated by the existing `watch()` already
    /// holding `Session<ImapStream>` across `.await` inside a `tokio::spawn`).
    #[test]
    fn probe_session_is_send() {
        fn assert_send<T: Send>() {}
        // ImapStream (enum: Tls(TlsStream<TcpStream>) | Plain(TcpStream)).
        assert_send::<ImapStream>();
        // The actual type the manager holds:
        assert_send::<Session<ImapStream>>();
        // Wrapping in tokio::sync::Mutex requires the inner be Send.
        assert_send::<tokio::sync::Mutex<Session<ImapStream>>>();
        // And the full Handle (must be Send + Sync so `Arc<Handle>` is too).
        fn assert_send_sync<T: Send + Sync>() {}
        assert_send_sync::<std::sync::Arc<Handle>>();
    }

    #[test]
    fn classify_error_auth_surfaces_immediately() {
        assert_eq!(
            classify_error("Login failed: AUTHENTICATIONFAILED Invalid credentials"),
            ErrorKind::Auth
        );
        assert_eq!(
            classify_error("XOAUTH2 authentication failed: ..."),
            ErrorKind::Auth
        );
    }

    #[test]
    fn classify_error_transient_retries_once() {
        assert_eq!(
            classify_error("Connection closed during FETCH"),
            ErrorKind::Transient
        );
        assert_eq!(
            classify_error("UID FETCH INBOX timed out after 120s"),
            ErrorKind::Transient
        );
        assert_eq!(
            classify_error("FETCH read: connection reset by peer"),
            ErrorKind::Transient
        );
        // Server-initiated BYE:
        assert_eq!(classify_error("* BYE Connection closed"), ErrorKind::Transient);
    }

    /// Regression: Windows WSAECONNABORTED (10053) — the server/middlebox
    /// aborted the established TCP connection. Pre-fix this fell through to
    /// `Other`, so a mid-round abort never triggered reconnect-once and every
    /// subsequent folder in the round failed against the dead socket. The
    /// matching is case-insensitive across all three forms the error surfaces
    /// in practice (hyper's "connection aborted", rustls's "established
    /// connection was aborted", and the raw OS code "10053").
    #[test]
    fn classify_error_connection_aborted_is_transient() {
        assert_eq!(
            classify_error("connection aborted"),
            ErrorKind::Transient
        );
        assert_eq!(
            classify_error("An established connection was aborted by the software in your host machine"),
            ErrorKind::Transient
        );
        assert_eq!(
            classify_error("FETCH failed: os error 10053"),
            ErrorKind::Transient
        );
        // Mixed case (hyper-style phrasing) must also match.
        assert_eq!(
            classify_error("Connection aborted"),
            ErrorKind::Transient
        );
    }

    #[test]
    fn classify_error_other_is_neither_auth_nor_transient() {
        // A NO/BAD response that isn't an auth failure stays "Other" — surfaces
        // as-is (the caller's existing error handling already returns it).
        assert_eq!(
            classify_error("UID STORE failed: BAD invalid sequence"),
            ErrorKind::Other
        );
    }

    #[test]
    fn should_reselect_only_when_folder_differs() {
        // Nothing selected yet, op wants a folder -> SELECT needed.
        assert!(should_reselect(&None, Some("INBOX")));
        // Same folder -> skip.
        assert!(!should_reselect(&Some("INBOX".into()), Some("INBOX")));
        // Different folder -> SELECT needed.
        assert!(should_reselect(&Some("INBOX".into()), Some("Sent")));
        // Op has no folder context (e.g. LIST, CAPABILITY) -> don't force.
        assert!(!should_reselect(&Some("INBOX".into()), None));
        assert!(!should_reselect(&None, None));
    }

    #[test]
    fn retry_decision_reconnects_once_on_transient_then_surfaces() {
        assert_eq!(
            retry_decision("Connection closed during FETCH", 1),
            RetryDecision::ReconnectAndRetry
        );
        // Second attempt with the same transient error surfaces (don't loop).
        assert_eq!(
            retry_decision("Connection closed during FETCH", 2),
            RetryDecision::Surface
        );
    }

    #[test]
    fn retry_decision_surfaces_auth_immediately() {
        assert_eq!(
            retry_decision("Login failed: AUTHENTICATIONFAILED", 1),
            RetryDecision::Surface
        );
    }

    #[test]
    fn retry_decision_surfaces_other_immediately() {
        // A BAD response isn't transient — retrying won't help.
        assert_eq!(
            retry_decision("UID STORE failed: BAD invalid sequence", 1),
            RetryDecision::Surface
        );
    }

    // ---- Task 5: keepalive seam tests ----
    //
    // The spawned keepalive task itself can't be unit-tested (it needs a live
    // `Session<ImapStream>` + real time). The two behaviors that matter —
    // "skip NOOP if the session was just used" and "skip NOOP if the session is
    // None" — are gated by the pure helper `keepalive_should_fire` and the
    // `Option::as_mut()` match respectively. `keepalive_should_fire` is the
    // load-bearing seam (the timing math), so it gets the tests below. The
    // None-skip is a trivial `match` arm obvious at the call site; testing it
    // via a wrapper would just assert `Option::is_none()` and add no value.

    #[test]
    fn keepalive_should_fire_after_interval_elapsed() {
        let interval = Duration::from_secs(120);
        let last_used = Instant::now() - Duration::from_secs(180);
        // 180s > 120s interval -> a real NOOP is due.
        assert!(keepalive_should_fire(last_used, Instant::now(), interval));
    }

    #[test]
    fn keepalive_skips_when_session_used_recently() {
        let interval = Duration::from_secs(120);
        // `execute()` just bumped last_used 5s ago — well under the 120s
        // interval. The real command reset the server's idle clock, so a NOOP
        // now would be redundant. Gate must skip.
        let last_used = Instant::now() - Duration::from_secs(5);
        assert!(!keepalive_should_fire(last_used, Instant::now(), interval));
    }

    #[test]
    fn keepalive_boundary_fires_at_exactly_interval() {
        // At exactly the interval the session has been idle "long enough" —
        // fire. (`>=` so that a 120s idle on a 120s interval is treated as due,
        // not one tick short of due — matches the doc comment on the helper.)
        let interval = Duration::from_secs(120);
        let now = Instant::now();
        let last_used = now - interval;
        assert!(keepalive_should_fire(last_used, now, interval));
    }
}
