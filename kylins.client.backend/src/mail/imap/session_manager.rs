//! Persistent IMAP session manager — one long-lived `Session<ImapStream>` per
//! account, with lazy connect, reconnect-on-drop, mailbox serialization, and a
//! NOOP keepalive. See `docs/superpowers/plans/2026-06-30-sync-engine-phase3-imap-persistent-connection.md`.
//!
//! This file contains the pure helpers + the Send-probe in this first task;
//! the live `execute()` / reconnect / keepalive plumbing lands in Task 2.

use async_imap::Session;
use std::collections::HashMap;
use std::time::Instant;

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
}
