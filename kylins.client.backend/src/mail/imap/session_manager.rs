//! Single-connection IMAP session manager — ONE actor task per account owns
//! the single `Session<ImapStream>`, runs IDLE when idle, and breaks IDLE
//! (`DONE`) to run any command. This is the imapflow model, adapted to
//! async-imap 0.10.4's `idle()`-consumes-`Session` constraint.
//!
//! Why single-connection: Yahoo does not push `* EXISTS` to a purely-idle
//! *secondary* IDLE socket in real time — pushes were gated to ~120s (the other
//! connection's NOOP cadence) and the idle socket was reaped at ~300s. With one
//! connection, IDLE runs on the active socket, commands break it (activity → no
//! reap), and pushes land on that same socket immediately. Exchange has always
//! worked because it pushes to all selected connections.
//!
//! Architecture:
//! - `execute()` keeps its signature (8 callers + `fetch_bodies_batch`) but now
//!   erases its closure into `ErasedOp` and sends an `ActorMsg::Command` over an
//!   mpsc to the account's actor; the actor breaks IDLE, runs the command, and
//!   replies via a oneshot.
//! - The actor `select!`s between the IDLE wait and the command channel. On a
//!   push it emits a `PushNotice` on a separate mpsc that the engine worker
//!   drains (the engine then fetches via `execute()`).
//! - IDLE itself is the keepalive (no NOOP task); the 28-min `wait_with_timeout`
//!   re-issues IDLE on Timeout, and every command resets the server clock.
//! - `disconnect_account` (kept for the two raw-TCP callers) becomes a
//!   `YieldSession` message: the actor drops/parks its session so the caller's
//!   raw connection is briefly the only one; the next `execute()` reconnects.

use async_imap::extensions::idle::IdleResponse;
use async_imap::Session;
use std::any::Any;
use std::collections::HashMap;
use std::future::Future;
use std::pin::Pin;
use std::sync::Arc;
use std::time::Duration;
use tokio::sync::{mpsc, oneshot};
use tokio::task::JoinHandle;

use crate::mail::imap::client as imap_client;
use crate::mail::imap::client::ImapStream;
use crate::mail::imap::types::{FetchedBody, ImapConfig};

/// IDLE re-issue interval. The actor's `wait_with_timeout(IDLE_KEEPALIVE)`
/// returns `Timeout` after this long with no server traffic, at which point the
/// actor sends `DONE`, recovers the session, and re-enters IDLE on the SAME
/// socket — keeping the connection alive below the server's idle disconnect
/// (RFC 2177 suggests re-IDLE every ~29 min; 28 min matches). The clock is also
/// reset by ANY server traffic (`* OK Still here`, EXISTS) and by every command
/// (which breaks + re-enters IDLE).
const IDLE_KEEPALIVE: Duration = Duration::from_secs(28 * 60);

/// Best-effort LOGOUT timeout on shutdown (don't stall app exit).
const SHUTDOWN_LOGOUT_TIMEOUT: Duration = Duration::from_secs(5);

/// SELECT timeout — mirrors `IMAP_CMD_TIMEOUT` in `client.rs` (private there).
const SELECT_TIMEOUT: Duration = Duration::from_secs(30);

/// Cooldown before a reconnect-and-retry so an actively-aborting server/middlebox
/// can recycle the connection slot.
const RECONNECT_BACKOFF: Duration = Duration::from_millis(500);

// ============================ pure error/reselect helpers ============================

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
    if lower.contains("authenticationfailed")
        || lower.contains("login failed")
        || lower.contains("authentication failed")
        || lower.contains("invalid credentials")
        || lower.contains("authentication credentials")
    {
        return ErrorKind::Auth;
    }
    if lower.contains("connection closed")
        || lower.contains("connection reset")
        || lower.contains("broken pipe")
        || lower.contains("bye")
        || lower.contains("timed out")
        || lower.contains("tls")
        || lower.contains("eof")
        || lower.contains("connection refused")
        || lower.contains("parse")
        // Windows WSAECONNABORTED (10053).
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

/// Pure decision: should the command retry after a reconnect? Factored so the
/// control flow is unit-testable without a live `Session`.
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
        (ErrorKind::Other, _) => RetryDecision::Surface,
        _ => RetryDecision::Surface,
    }
}

// ============================ actor types ============================

/// Type-erased command closure. HRTB over the session-borrow lifetime: the
/// closure returns a future that borrows `&'a mut Session`, and `Box::pin` of
/// that future is itself bounded by `'a`. `FnMut` (not `FnOnce`) so the actor
/// can re-invoke it on a reconnect-and-retry. Validated by the Step-0 compile
/// probe (needs `O: 'static` at the erase site — caller closures are `move`
/// with owned captures).
pub type ErasedOp = Box<
    dyn for<'a> FnMut(&'a mut Session<ImapStream>)
            -> Pin<Box<dyn Future<Output = Result<Box<dyn Any + Send>, String>> + Send + 'a>>
        + Send,
>;

/// Erase a typed caller closure (`execute<O,R>`'s `op`) into `ErasedOp`. The
/// typed result is boxed into `Box<dyn Any + Send>`; `execute()` downcasts.
fn erase_op<R, O>(mut op: O) -> ErasedOp
where
    R: Send + 'static,
    O: FnMut(&mut Session<ImapStream>)
            -> Pin<Box<dyn Future<Output = Result<R, String>> + Send + '_>>
        + Send
        + 'static,
{
    Box::new(move |session: &mut Session<ImapStream>| {
        let fut = op(session);
        Box::pin(async move { fut.await.map(|r| Box::new(r) as Box<dyn Any + Send>) })
    })
}

/// What the actor is asked to do.
enum ActorMsg {
    /// Run a command on the session (breaking IDLE first). `folder = None`
    /// means no per-folder context (LIST/CAPABILITY) — no SELECT forced.
    Command {
        folder: Option<String>,
        op: ErasedOp,
        reply: oneshot::Sender<Result<Box<dyn Any + Send>, String>>,
    },
    /// Set the folder to IDLE on when the actor goes idle. `folder = None`
    /// means "stop IDLEing" (clears the push channel).
    SetIdleFolder {
        folder: Option<String>,
        push_tx: Option<mpsc::Sender<PushNotice>>,
    },
    /// Drop the session so a caller can open a transient raw 2nd connection
    /// (raw-fetch fallback / attachment fetch). Replies once the session is gone.
    YieldSession {
        reply: oneshot::Sender<()>,
    },
    /// Exit the actor loop (account removal / shutdown).
    Shutdown,
}

/// Signal from the actor to the engine: the IDLE-watched folder changed.
#[derive(Debug, Clone)]
pub struct PushNotice {
    pub folder: String,
}

// ============================ Handle + manager ============================

pub struct Handle {
    pub account_id: String,
    pub config: ImapConfig,
    cmd_tx: mpsc::Sender<ActorMsg>,
    actor: tokio::sync::Mutex<Option<JoinHandle<()>>>,
    /// Snapshot of the session setup (caps + profile + enabled) written by the
    /// actor on every connect/reconnect. Read by `get_setup()` → `ImapSource`.
    pub setup: Arc<std::sync::Mutex<Option<crate::mail::imap::client::SessionSetup>>>,
}

pub struct ImapSessionManager {
    pub accounts: tokio::sync::Mutex<HashMap<String, Arc<Handle>>>,
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

impl ImapSessionManager {
    /// Run `op` against the account's single connection. Lazily spawns the
    /// actor on first use. Signature is unchanged from the pre-actor design so
    /// the 8 callers in `imap_source.rs` + `fetch_bodies_batch` need no edits.
    ///
    /// Internally: erase `op`, send `Command` to the actor, await the oneshot
    /// reply, downcast. The actor owns lazy-connect, SELECT-if-differs, and
    /// reconnect-retry-once; `execute()` is a thin send+await.
    pub async fn execute<O, R>(
        &self,
        account_id: &str,
        config: &ImapConfig,
        folder: Option<&str>,
        op: O,
    ) -> Result<R, String>
    where
        O: FnMut(&mut Session<ImapStream>)
                -> Pin<Box<dyn Future<Output = Result<R, String>> + Send + '_>>
            + Send
            + 'static,
        R: Send + 'static,
    {
        let handle = self.handle_for(account_id, config).await;
        let (tx, rx) = oneshot::channel();
        let erased = erase_op::<R, O>(op);
        if handle
            .cmd_tx
            .send(ActorMsg::Command {
                folder: folder.map(str::to_owned),
                op: erased,
                reply: tx,
            })
            .await
            .is_err()
        {
            return Err("imap execute: actor task not running".into());
        }
        let boxed = rx
            .await
            .map_err(|_| "imap execute: actor dropped reply".to_string())??;
        boxed
            .downcast::<R>()
            .map(|b| *b)
            .map_err(|_| "imap execute: result downcast failed".to_string())
    }

    /// Fetch full message bodies in batches. Unchanged thin wrapper over
    /// `execute()` (which breaks IDLE, runs the batch, re-IDLEs).
    pub async fn fetch_bodies_batch(
        &self,
        account_id: &str,
        config: &ImapConfig,
        folder: &str,
        uids: &[u32],
        chunk_size: usize,
    ) -> Result<Vec<FetchedBody>, String> {
        let folder_owned = folder.to_string();
        let uids = uids.to_vec();
        let chunk_size = if chunk_size == 0 { 50 } else { chunk_size };
        self.execute(account_id, config, Some(folder), move |session| {
            let folder = folder_owned.clone();
            let uids = uids.clone();
            Box::pin(async move {
                imap_client::fetch_bodies_batch_on_session(session, &folder, &uids, chunk_size).await
            })
        })
        .await
    }

    /// Get-or-insert the per-account `Handle`, spawning the actor on insert.
    /// Cheap `Arc` clone out. Double-checked locking under the map mutex; the
    /// actor spawn happens under the write lock.
    pub async fn handle_for(&self, account_id: &str, config: &ImapConfig) -> Arc<Handle> {
        {
            let map = self.accounts.lock().await;
            if let Some(h) = map.get(account_id) {
                return Arc::clone(h);
            }
        }
        let mut map = self.accounts.lock().await;
        if let Some(h) = map.get(account_id) {
            return Arc::clone(h);
        }
        let (cmd_tx, cmd_rx) = mpsc::channel::<ActorMsg>(64);
        let setup_slot: Arc<std::sync::Mutex<Option<crate::mail::imap::client::SessionSetup>>> =
            Arc::new(std::sync::Mutex::new(None));
        let actor = spawn_actor(account_id.to_string(), config.clone(), cmd_rx, Arc::clone(&setup_slot));
        let handle = Arc::new(Handle {
            account_id: account_id.to_string(),
            config: config.clone(),
            cmd_tx,
            actor: tokio::sync::Mutex::new(Some(actor)),
            setup: setup_slot,
        });
        map.insert(account_id.to_string(), Arc::clone(&handle));
        handle
    }

    /// Read the session-setup snapshot (caps + profile + enabled) for an account.
    /// Written by the actor on every connect/reconnect. Returns `None` if the
    /// actor hasn't connected yet.
    pub async fn get_setup(
        &self,
        account_id: &str,
    ) -> Option<crate::mail::imap::client::SessionSetup> {
        let map = self.accounts.lock().await;
        map.get(account_id)
            .and_then(|h| h.setup.lock().unwrap().clone())
    }

    /// Start IDLE on `folder`. Returns a receiver the engine drains for push
    /// notifications. Idempotent: re-sending just updates the idle folder / push
    /// channel. Returns `None` if the actor isn't running.
    pub async fn start_idle(
        &self,
        account_id: &str,
        config: &ImapConfig,
        folder: &str,
    ) -> Option<mpsc::Receiver<PushNotice>> {
        let handle = self.handle_for(account_id, config).await;
        let (push_tx, push_rx) = mpsc::channel::<PushNotice>(16);
        if handle
            .cmd_tx
            .send(ActorMsg::SetIdleFolder {
                folder: Some(folder.to_string()),
                push_tx: Some(push_tx),
            })
            .await
            .is_ok()
        {
            Some(push_rx)
        } else {
            None
        }
    }

    /// Make the actor drop its session so a caller about to open its OWN raw
    /// connection (raw-fetch fallback / attachment fetch) is the only live
    /// connection for the account. The next `execute()` reconnects fresh. Kept
    /// under the historical name so the two raw-TCP call sites need no change.
    pub async fn disconnect_account(&self, account_id: &str) {
        let handle = {
            let map = self.accounts.lock().await;
            map.get(account_id).cloned()
        };
        if let Some(handle) = handle {
            let (tx, rx) = oneshot::channel();
            if handle
                .cmd_tx
                .send(ActorMsg::YieldSession { reply: tx })
                .await
                .is_ok()
            {
                let _ = rx.await;
            }
        }
    }

    /// Stop + clean up every account's actor (app shutdown / stop_all).
    pub async fn shutdown(&self) {
        let mut map = self.accounts.lock().await;
        for (_, h) in map.drain() {
            // Best-effort clean exit; abort if it doesn't promptly.
            let _ = h.cmd_tx.send(ActorMsg::Shutdown).await;
            if let Some(jh) = h.actor.lock().await.take() {
                jh.abort();
            }
        }
    }
}

// ============================ the actor ============================

/// Which event won the IDLE-phase `select!`. Computed WITHOUT consuming `idle`
/// in the branch bodies — `idle.done()` happens after the select, once the
/// borrowed wait-future is dropped (see `spawn_actor`).
enum IdleSel {
    /// A command arrived (preempts IDLE). `None` = channel closed.
    Cmd(Option<ActorMsg>),
    /// Server pushed new data (`* EXISTS` / FETCH).
    NewData,
    /// 28-min keepalive fired — re-IDLE on the same socket.
    Timeout,
    /// `StopSource` dropped / stream end — re-IDLE.
    Interrupt,
    /// The IDLE wait itself errored (socket dead) — drop the session.
    WaitErr(String),
}

/// Spawn the per-account actor that owns the single `Session<ImapStream>`.
///
/// State machine:
/// - Drain any queued commands first (commands preempt IDLE).
/// - If a session and an idle folder are set → enter IDLE, `select!` between the
///   command channel and the IDLE wait. On a command: `done()` + handle it. On a
///   push: emit `PushNotice` + re-IDLE. On Timeout/Interrupt: re-IDLE. On error:
///   drop the session.
/// - Else block on the command channel.
fn spawn_actor(account_id: String, config: ImapConfig, mut cmd_rx: mpsc::Receiver<ActorMsg>, setup_slot: Arc<std::sync::Mutex<Option<crate::mail::imap::client::SessionSetup>>>) -> JoinHandle<()> {
    tokio::spawn(async move {
        let mut session: Option<Session<ImapStream>> = None;
        let mut selected: Option<String> = None;
        let mut idle_folder: Option<String> = None;
        let mut push_tx: Option<mpsc::Sender<PushNotice>> = None;

        'main: loop {
            // Drain queued commands (commands always preempt IDLE).
            while let Ok(msg) = cmd_rx.try_recv() {
                if handle_msg(
                    msg,
                    &mut session,
                    &mut selected,
                    &mut idle_folder,
                    &mut push_tx,
                    &config,
                    &account_id,
                    &setup_slot,
                )
                .await
                {
                    return;
                }
            }

            let can_idle = session.is_some() && idle_folder.is_some();
            if can_idle {
                // Brief grace period: wait 100ms for a follow-up command before
                // re-entering IDLE. This batches rapid sequential commands (e.g.,
                // per-folder sync round) so the actor doesn't break/re-enter IDLE
                // between each folder — 8 folder syncs run back-to-back instead of
                // interleaving with 8 IDLE break/re-enter cycles.
                match tokio::time::timeout(Duration::from_millis(100), cmd_rx.recv()).await {
                    Ok(Some(msg)) => {
                        if handle_msg(
                            msg,
                            &mut session,
                            &mut selected,
                            &mut idle_folder,
                            &mut push_tx,
                            &config,
                            &account_id,
                            &setup_slot,
                        )
                        .await
                        {
                            return;
                        }
                        continue 'main;
                    }
                    Ok(None) => return, // channel closed → exit actor
                    Err(_) => {}        // timeout — no more commands, proceed to IDLE
                }
                // SELECT the idle folder if it differs from the current selection.
                {
                    let needs_select = should_reselect(&selected, idle_folder.as_deref());
                    if needs_select {
                        let f = idle_folder.as_deref().unwrap();
                        let sess = session.as_mut().unwrap();
                        match tokio::time::timeout(SELECT_TIMEOUT, sess.select(f)).await {
                            Ok(Ok(_)) => selected = Some(f.to_string()),
                            Ok(Err(e)) => {
                                log::warn!(
                                    "[imap-mgr] {account_id} IDLE SELECT {f} failed: {e}; dropping session"
                                );
                                session = None;
                                selected = None;
                                continue 'main;
                            }
                            Err(_) => {
                                log::warn!(
                                    "[imap-mgr] {account_id} IDLE SELECT {f} timed out; dropping session"
                                );
                                session = None;
                                selected = None;
                                continue 'main;
                            }
                        }
                    }
                }

                // Enter IDLE. `session.idle()` consumes the Session; `done()`
                // below recovers it.
                let sess = session.take().unwrap();
                let mut idle = sess.idle();
                if let Err(e) = idle.init().await {
                    log::warn!(
                        "[imap-mgr] {account_id} IDLE init failed: {e}; dropping session"
                    );
                    session = None;
                    selected = None;
                    continue 'main;
                }
                log::info!(
                    "[imap-mgr] {account_id} IDLE waiting on {} (keepalive={}s, single connection)",
                    idle_folder.as_deref().unwrap_or("?"),
                    IDLE_KEEPALIVE.as_secs(),
                );

                let (wait_fut, _stop) = idle.wait_with_timeout(IDLE_KEEPALIVE);
                // Heap-pin so we can `drop(wait_fut)` to release the `&mut idle`
                // borrow BEFORE `idle.done()` consumes `idle`.
                let mut wait_fut = Box::pin(wait_fut);

                let sel: IdleSel = tokio::select! {
                    biased;
                    msg = cmd_rx.recv() => IdleSel::Cmd(msg),
                    res = wait_fut.as_mut() => match res {
                        Ok(IdleResponse::NewData(_)) => IdleSel::NewData,
                        Ok(IdleResponse::Timeout) => IdleSel::Timeout,
                        Ok(IdleResponse::ManualInterrupt) => IdleSel::Interrupt,
                        Err(e) => IdleSel::WaitErr(format!("{e}")),
                    },
                };

                // The wait future borrowed `idle`; drop it so `idle.done()`
                // (which takes `self`) can run. (`_stop` lives until end of block.)
                drop(wait_fut);
                let recovered = idle.done().await.ok();
                let mut wait_failed = false;
                match sel {
                    IdleSel::Cmd(None) => return, // channel closed → exit actor
                    IdleSel::Cmd(Some(msg)) => {
                        session = recovered;
                        if handle_msg(
                            msg,
                            &mut session,
                            &mut selected,
                            &mut idle_folder,
                            &mut push_tx,
                            &config,
                            &account_id,
                            &setup_slot,
                        )
                        .await
                        {
                            return;
                        }
                    }
                    IdleSel::NewData => {
                        session = recovered;
                        log::info!(
                            "[imap-mgr] {account_id} IDLE push on {} → engine syncs",
                            idle_folder.as_deref().unwrap_or("?"),
                        );
                        if let (Some(tx), Some(f)) = (push_tx.as_ref(), idle_folder.as_ref()) {
                            let _ = tx.send(PushNotice { folder: f.clone() }).await;
                        }
                        // loop → re-IDLE on the recovered session
                    }
                    IdleSel::Timeout | IdleSel::Interrupt => {
                        session = recovered; // loop → re-IDLE
                    }
                    IdleSel::WaitErr(e) => {
                        log::warn!("[imap-mgr] {account_id} IDLE wait err: {e}; dropping session");
                        wait_failed = true;
                    }
                }
                if wait_failed {
                    session = None;
                    selected = None;
                } else if session.is_none() {
                    selected = None;
                }
            } else {
                // No session (or no idle folder) and no queued command: block.
                match cmd_rx.recv().await {
                    Some(msg) => {
                        if handle_msg(
                            msg,
                            &mut session,
                            &mut selected,
                            &mut idle_folder,
                            &mut push_tx,
                            &config,
                            &account_id,
                            &setup_slot,
                        )
                        .await
                        {
                            return;
                        }
                    }
                    None => return,
                }
            }
        }
    })
}

/// Handle one actor message. Returns `true` if the actor should exit (Shutdown).
// actor state-passing seam — each arg is a distinct piece of mutable actor state; bundling into a struct would mean create-then-immediately-destructure.
#[allow(clippy::too_many_arguments)]
async fn handle_msg(
    msg: ActorMsg,
    session: &mut Option<Session<ImapStream>>,
    selected: &mut Option<String>,
    idle_folder: &mut Option<String>,
    push_tx: &mut Option<mpsc::Sender<PushNotice>>,
    config: &ImapConfig,
    account_id: &str,
    setup_slot: &Arc<std::sync::Mutex<Option<crate::mail::imap::client::SessionSetup>>>,
) -> bool {
    match msg {
        ActorMsg::Shutdown => true,
        ActorMsg::SetIdleFolder { folder, push_tx: ptx } => {
            *idle_folder = folder;
            *push_tx = ptx;
            false
        }
        ActorMsg::YieldSession { reply } => {
            if session.is_some() {
                log::info!(
                    "[imap-mgr] {account_id} disconnect_account: yielding session for caller's raw connection"
                );
            }
            *session = None;
            *selected = None;
            let _ = reply.send(());
            false
        }
        ActorMsg::Command { folder, op, reply } => {
            run_command(account_id, config, session, selected, folder, op, reply, setup_slot).await;
            false
        }
    }
}

/// Run one command against the session with lazy-connect, SELECT-if-differs,
/// and reconnect-retry-once on transient errors. The session is left in a
/// usable state (or `None` if a reconnect is needed next time).
// private internal fn, single call site (handle_msg) — actor state-passing seam; a param-object would add a type for marginal gain.
#[allow(clippy::too_many_arguments)]
async fn run_command(
    account_id: &str,
    config: &ImapConfig,
    session: &mut Option<Session<ImapStream>>,
    selected: &mut Option<String>,
    folder: Option<String>,
    mut op: ErasedOp,
    reply: oneshot::Sender<Result<Box<dyn Any + Send>, String>>,
    setup_slot: &Arc<std::sync::Mutex<Option<crate::mail::imap::client::SessionSetup>>>,
) {
    let mut attempt = 1u8;
    loop {
        // Lazy connect (and reconnect after a transient drop).
        if session.is_none() {
            match imap_client::connect(config).await {
                Ok((s, setup)) => {
                    *session = Some(s);
                    *selected = None;
                    *setup_slot.lock().unwrap() = Some(setup);
                }
                Err(e) => {
                    let estr = format!("IMAP connect failed: {e}");
                    let _ = reply.send(Err(estr));
                    return;
                }
            }
        }

        // SELECT if the requested folder differs. Scoped so the `&mut session`
        // borrow ends before the op / retry paths touch `*session`.
        let select_err: Option<String> = {
            if let Some(folder) = folder.as_deref() {
                if should_reselect(selected, Some(folder)) {
                    let sess = session.as_mut().unwrap();
                    match tokio::time::timeout(SELECT_TIMEOUT, sess.select(folder)).await {
                        Ok(Ok(_)) => {
                            *selected = Some(folder.to_string());
                            None
                        }
                        Ok(Err(e)) => Some(format!("SELECT {folder} failed: {e}")),
                        Err(_) => Some(format!("SELECT {folder} timed out")),
                    }
                } else {
                    None
                }
            } else {
                None
            }
        };
        if let Some(e) = select_err {
            if matches!(retry_decision(&e, attempt), RetryDecision::ReconnectAndRetry) {
                log::warn!(
                    "[imap-mgr] {account_id} transient SELECT (attempt {attempt}): {e}; reconnect+retry"
                );
                *session = None;
                *selected = None;
                attempt = 2;
                tokio::time::sleep(RECONNECT_BACKOFF).await;
                continue;
            }
            let _ = reply.send(Err(e));
            return;
        }

        // Run the op. Scoped so the session borrow ends before a retry mutates
        // `*session`.
        let op_result: Result<Box<dyn Any + Send>, String> = {
            let sess = session.as_mut().unwrap();
            op(sess).await
        };
        match op_result {
            Ok(boxed) => {
                let _ = reply.send(Ok(boxed));
                return;
            }
            Err(e) => {
                if matches!(retry_decision(&e, attempt), RetryDecision::ReconnectAndRetry) {
                    log::warn!(
                        "[imap-mgr] {account_id} transient (attempt {attempt}): {e}; reconnect+retry"
                    );
                    *session = None;
                    *selected = None;
                    attempt = 2;
                    tokio::time::sleep(RECONNECT_BACKOFF).await;
                    continue;
                }
                let _ = reply.send(Err(e));
                return;
            }
        }
    }
}

// silence unused if LOGOUT path is compiled out under tests
const _: Duration = SHUTDOWN_LOGOUT_TIMEOUT;

#[cfg(test)]
mod tests {
    use super::*;

    /// Send-probe — load-bearing: the actor task runs on the multi-threaded
    /// runtime, so every type that crosses the mpsc + the spawned future must
    /// be `Send`.
    #[test]
    fn probe_types_are_send() {
        fn assert_send<T: Send>() {}
        fn assert_send_sync<T: Send + Sync>() {}
        assert_send::<ImapStream>();
        assert_send::<Session<ImapStream>>();
        assert_send::<ErasedOp>();
        assert_send::<ActorMsg>();
        assert_send::<PushNotice>();
        assert_send_sync::<Arc<Handle>>();
        assert_send_sync::<Arc<ImapSessionManager>>();
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
        assert_eq!(classify_error("* BYE Connection closed"), ErrorKind::Transient);
    }

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
        assert_eq!(
            classify_error("Connection aborted"),
            ErrorKind::Transient
        );
    }

    #[test]
    fn classify_error_other_is_neither_auth_nor_transient() {
        assert_eq!(
            classify_error("UID STORE failed: BAD invalid sequence"),
            ErrorKind::Other
        );
    }

    #[test]
    fn should_reselect_only_when_folder_differs() {
        assert!(should_reselect(&None, Some("INBOX")));
        assert!(!should_reselect(&Some("INBOX".into()), Some("INBOX")));
        assert!(should_reselect(&Some("INBOX".into()), Some("Sent")));
        assert!(!should_reselect(&Some("INBOX".into()), None));
        assert!(!should_reselect(&None, None));
    }

    #[test]
    fn retry_decision_reconnects_once_on_transient_then_surfaces() {
        assert_eq!(
            retry_decision("Connection closed during FETCH", 1),
            RetryDecision::ReconnectAndRetry
        );
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
        assert_eq!(
            retry_decision("UID STORE failed: BAD invalid sequence", 1),
            RetryDecision::Surface
        );
    }
}
