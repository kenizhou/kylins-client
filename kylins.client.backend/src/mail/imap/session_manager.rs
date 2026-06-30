//! Persistent IMAP session manager — one long-lived `Session<ImapStream>` per
//! account, with lazy connect, reconnect-on-drop, mailbox serialization, and a
//! NOOP keepalive. See `docs/superpowers/plans/2026-06-30-sync-engine-phase3-imap-persistent-connection.md`.
//!
//! Task 1 (BASE `36b552e`) delivered the pure helpers (`classify_error`,
//! `should_reselect`), the `Handle` / `ImapSessionManager` skeleton, and the
//! Send-probe. Task 2 (this commit) implements the heart: `execute()` —
//! lazy connect, mailbox lock (re-SELECT only on folder change), and
//! reconnect-once on transient errors. NOOP keepalive lands in Task 5.

use async_imap::Session;
use std::collections::HashMap;
use std::future::Future;
use std::sync::Arc;
use std::time::Instant;

use crate::mail::imap::client as imap_client;
use crate::mail::imap::client::ImapStream;
use crate::mail::imap::types::ImapConfig;

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
    pub async fn execute<O, R, F>(
        &self,
        account_id: &str,
        config: &ImapConfig,
        folder: Option<&str>,
        mut op: O,
    ) -> Result<R, String>
    where
        O: FnMut(&mut Session<ImapStream>) -> F + Send,
        F: Future<Output = Result<R, String>> + Send,
        R: Send,
    {
        let handle = self.handle_for(account_id, config).await;

        for attempt in 1u8..=2 {
            // Lazy connect / reconnect-after-drop. Cheap fast path when the
            // session slot is already populated.
            handle.ensure_connected(config).await?;

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
                            RetryDecision::Surface => return Err(e),
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
        });
        map.insert(account_id.to_string(), Arc::clone(&handle));
        handle
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
        let session = imap_client::connect(config).await?;
        *guard = Some(session);
        // New session = nothing selected yet. Acquired after `session` per the
        // documented lock ordering; released at the statement boundary.
        *self.selected_mailbox.lock().await = None;
        Ok(())
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
}
