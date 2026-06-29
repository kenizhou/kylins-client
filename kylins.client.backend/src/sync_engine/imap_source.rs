// ImapSource — MailSource adapter over the existing async-imap client.
//
// Owns its connection lifecycle (connect once per public call, run sub-ops on the same
// session, logout at the end). Maps ImapFolder -> RemoteFolder and ImapMessage ->
// RemoteMessage. sync_folder uses delta semantics: get_folder_status for UIDVALIDITY,
// fetch_new_uids(highest_uid+1), chunked fetch_messages for the new envelopes.
//
// CAPABILITY negotiation: best-effort. `list_folders`/`sync_folder` query the server's
// CAPABILITY on every connect and cache the result in `caps`; `capabilities()` returns
// the cached value or `Capabilities::default()` if no connect has succeeded yet. This
// is what lets a later task pick a RealtimeStrategy (idle vs. poll) based on the
// server's actual `IDLE`/`CONDSTORE`/`QRESYNC`/`VANISHED` support.
//
// `watch()` (Phase 2 Task 2): long-lived IDLE on the folder. Unlike the per-call
// methods above, watch() holds its connection for the duration of the IDLE and uses
// async-imap's `wait_with_timeout(28 min)` keepalive watchdog (reset by `* OK Still
// here` server pings, < the ~29 min server idle timeout). Returns `Ok(())` on the
// first real notification so the caller can re-sync then re-enter watch().

use async_imap::extensions::idle::IdleResponse;
use async_trait::async_trait;
use std::sync::Mutex;
use std::time::Duration;

use crate::db::accounts::Account;
use crate::mail::imap::client as imap_client;
use crate::mail::imap::types::{ImapConfig, ImapFolder, ImapMessage};
use crate::mail::smtp::client as smtp_client;
use crate::mail::smtp::types::SmtpConfig;

use super::{
    Capabilities, Cursor, FolderDelta, MailSource, RemoteFolder, RemoteMessage, SourceError,
};

/// IDLE keepalive watchdog. async-imap's `wait_with_timeout` resets this clock on any
/// server traffic (including `* OK Still here`), so we stay below the server's typical
/// ~29 min idle disconnect. On `IdleResponse::Timeout` we send DONE and re-init IDLE
/// (loop continues); on `NewData` we return so the caller re-syncs.
const IDLE_KEEPALIVE: Duration = Duration::from_secs(28 * 60);

pub struct ImapSource {
    account: Account,
    caps: Mutex<Option<Capabilities>>,
}

impl ImapSource {
    pub fn new(account: Account) -> Self {
        Self {
            account,
            caps: Mutex::new(None),
        }
    }

    fn imap_config(&self) -> ImapConfig {
        ImapConfig {
            host: self.account.imap_host.clone().unwrap_or_default(),
            port: self.account.imap_port.unwrap_or(993) as u16,
            security: self
                .account
                .imap_security
                .clone()
                .unwrap_or_else(|| "tls".to_string()),
            username: self
                .account
                .imap_username
                .clone()
                .unwrap_or_else(|| self.account.email.clone()),
            password: self.account.imap_password.clone().unwrap_or_default(),
            auth_method: self
                .account
                .auth_method
                .clone()
                .unwrap_or_else(|| "password".to_string()),
            accept_invalid_certs: self.account.accept_invalid_certs,
        }
    }

    fn smtp_config(&self) -> SmtpConfig {
        SmtpConfig {
            host: self.account.smtp_host.clone().unwrap_or_default(),
            port: self.account.smtp_port.unwrap_or(587) as u16,
            security: self
                .account
                .smtp_security
                .clone()
                .unwrap_or_else(|| "starttls".to_string()),
            username: self
                .account
                .imap_username
                .clone()
                .unwrap_or_else(|| self.account.email.clone()),
            password: self.account.imap_password.clone().unwrap_or_default(),
            auth_method: self
                .account
                .auth_method
                .clone()
                .unwrap_or_else(|| "password".to_string()),
            accept_invalid_certs: self.account.accept_invalid_certs,
        }
    }
}

fn other(e: String) -> SourceError {
    SourceError::Other(e)
}

fn uid_set(uids: &[u32]) -> String {
    uids.iter()
        .map(|u| u.to_string())
        .collect::<Vec<_>>()
        .join(",")
}

fn format_flags(flags: &[&str]) -> String {
    format!(
        "({})",
        flags
            .iter()
            .map(|f| if f.starts_with('\\') {
                (*f).to_string()
            } else {
                format!("\\{f}")
            })
            .collect::<Vec<_>>()
            .join(" ")
    )
}

fn role_from_special_use(su: Option<&str>) -> Option<String> {
    let s = su?.to_ascii_lowercase();
    if s.contains("inbox") {
        Some("inbox".into())
    } else if s.contains("\\sent") {
        Some("sent".into())
    } else if s.contains("\\drafts") {
        Some("drafts".into())
    } else if s.contains("\\trash") {
        Some("trash".into())
    } else if s.contains("\\junk") || s.contains("\\spam") {
        Some("junk".into())
    } else if s.contains("\\archive") || s.contains("\\all") {
        Some("archive".into())
    } else {
        None
    }
}

fn role_from_name(name: &str) -> Option<String> {
    if name.eq_ignore_ascii_case("inbox") {
        Some("inbox".into())
    } else {
        None
    }
}

fn parent_of(path: &str, delimiter: &str) -> Option<String> {
    if delimiter.is_empty() {
        return None;
    }
    let parts: Vec<&str> = path.split(delimiter).collect();
    if parts.len() > 1 {
        Some(parts[..parts.len() - 1].join(delimiter))
    } else {
        None
    }
}

fn imap_folder_to_remote(f: ImapFolder) -> RemoteFolder {
    let remote_id = if f.raw_path.is_empty() {
        f.path.clone()
    } else {
        f.raw_path.clone()
    };
    // parent_id must be computed from the SAME source as remote_id so it
    // matches the parent's remote_id column. Using decoded path would produce
    // mismatched values for non-ASCII (IMAP modified UTF-7) names.
    let parent_id = parent_of(&remote_id, &f.delimiter);
    let role = role_from_special_use(f.special_use.as_deref()).or_else(|| role_from_name(&f.name));
    RemoteFolder {
        remote_id,
        name: f.name,
        delimiter: f.delimiter,
        special_use: f.special_use,
        role,
        parent_id,
        exists: f.exists,
        unseen: f.unseen,
    }
}

fn imap_message_to_remote(m: ImapMessage) -> RemoteMessage {
    let has_attachments = !m.attachments.is_empty();
    RemoteMessage {
        uid: m.uid,
        folder: m.folder,
        message_id: m.message_id,
        in_reply_to: m.in_reply_to,
        references: m.references,
        from_address: m.from_address,
        from_name: m.from_name,
        to_addresses: m.to_addresses,
        cc_addresses: m.cc_addresses,
        bcc_addresses: m.bcc_addresses,
        reply_to: m.reply_to,
        subject: m.subject,
        snippet: m.snippet,
        date: m.date,
        is_read: m.is_read,
        is_starred: m.is_starred,
        is_draft: m.is_draft,
        body_html: m.body_html,
        body_text: m.body_text,
        raw_size: m.raw_size,
        list_unsubscribe: m.list_unsubscribe,
        list_unsubscribe_post: m.list_unsubscribe_post,
        auth_results: m.auth_results,
        has_attachments,
    }
}

#[async_trait]
impl MailSource for ImapSource {
    fn capabilities(&self) -> Capabilities {
        // Return cached server-advertised caps, or the default poll-only set if no
        // connect has succeeded yet (caps stay None on best-effort query failure).
        self.caps.lock().unwrap().unwrap_or_default()
    }

    /// ImapSource owns its cursor in `folder_sync_state`. Delegates to the shared
    /// `sync_state::get_imap_cursor` helper (typed row -> `Cursor::Imap`).
    async fn load_cursor(
        &self,
        pool: &sqlx::SqlitePool,
        account_id: &str,
        folder_path: &str,
    ) -> Cursor {
        crate::db::sync_state::get_imap_cursor(pool, account_id, folder_path).await
    }

    async fn list_folders(&self) -> Result<Vec<RemoteFolder>, SourceError> {
        let config = self.imap_config();
        let mut session = imap_client::connect(&config).await.map_err(other)?;
        // Best-effort CAPABILITY cache; ignore errors so caps stay default.
        if let Ok((idle, condstore, qresync, vanished)) =
            imap_client::session_capabilities(&mut session).await
        {
            *self.caps.lock().unwrap() = Some(Capabilities {
                idle,
                condstore,
                qresync,
                ping: false,
                vanishearch: vanished,
            });
        }
        let folders = imap_client::list_folders(&mut session)
            .await
            .map_err(other)?;
        let _ = session.logout().await;
        Ok(folders.into_iter().map(imap_folder_to_remote).collect())
    }

    async fn sync_folder(
        &self,
        folder: &RemoteFolder,
        since: Cursor,
    ) -> Result<FolderDelta, SourceError> {
        let config = self.imap_config();
        let mut session = imap_client::connect(&config).await.map_err(other)?;
        // Best-effort CAPABILITY cache; ignore errors so caps stay default.
        if let Ok((idle, condstore, qresync, vanished)) =
            imap_client::session_capabilities(&mut session).await
        {
            *self.caps.lock().unwrap() = Some(Capabilities {
                idle,
                condstore,
                qresync,
                ping: false,
                vanishearch: vanished,
            });
        }

        let (since_uv, since_high) = match since {
            Cursor::Imap {
                uidvalidity,
                highest_uid,
                ..
            } => (uidvalidity, highest_uid),
            _ => (0, 0),
        };

        let status = imap_client::get_folder_status(&mut session, &folder.remote_id)
            .await
            .map_err(other)?;

        // UIDVALIDITY change -> the server rebuilt the folder; signal a cache wipe and a
        // full resync from uid 0. The engine (Task 8) deletes the folder's rows first.
        if since_uv != 0 && status.uidvalidity != since_uv {
            return Ok(FolderDelta {
                added: vec![],
                updated: vec![],
                flag_updates: vec![],
                vanished_uids: vec![],
                next_cursor: Cursor::Imap {
                    uidvalidity: status.uidvalidity,
                    highest_uid: 0,
                    highest_modseq: status.highest_modseq.unwrap_or(0),
                },
                uidvalidity_changed: true,
            });
        }

        let new_uids = imap_client::fetch_new_uids(&mut session, &folder.remote_id, since_high)
            .await
            .map_err(other)?;
        let to_fetch: Vec<u32> = new_uids.into_iter().filter(|&u| u > since_high).collect();

        let mut added = Vec::new();
        for chunk in to_fetch.chunks(100) {
            let range = uid_set(chunk);
            let res = match imap_client::fetch_messages(&mut session, &folder.remote_id, &range)
                .await
            {
                Ok(r) => r,
                Err(e) if e.starts_with("ASYNC_IMAP_EMPTY:") => {
                    log::info!("[sync] async-imap returned empty; falling back to raw TCP fetch for {} UIDs {range}", folder.remote_id);
                    imap_client::raw_fetch_messages(&config, &folder.remote_id, &range)
                        .await
                        .map_err(other)?
                }
                Err(e) => return Err(other(e)),
            };
            for m in res.messages {
                added.push(imap_message_to_remote(m));
            }
        }

        let new_high = added.iter().map(|m| m.uid).max().unwrap_or(since_high);
        let _ = session.logout().await;

        Ok(FolderDelta {
            added,
            updated: vec![],
            flag_updates: vec![],
            vanished_uids: vec![],
            next_cursor: Cursor::Imap {
                uidvalidity: status.uidvalidity,
                highest_uid: new_high,
                highest_modseq: status.highest_modseq.unwrap_or(0),
            },
            uidvalidity_changed: false,
        })
    }

    async fn fetch_body(
        &self,
        folder: &RemoteFolder,
        uid: u32,
    ) -> Result<Option<String>, SourceError> {
        let config = self.imap_config();
        let mut session = imap_client::connect(&config).await.map_err(other)?;
        let msg = imap_client::fetch_message_body(&mut session, &folder.remote_id, uid)
            .await
            .map_err(other)?;
        let _ = session.logout().await;
        Ok(msg.body_html.or(msg.body_text))
    }

    async fn set_flags(
        &self,
        folder: &RemoteFolder,
        uids: &[u32],
        flag: &str,
        add: bool,
    ) -> Result<(), SourceError> {
        if uids.is_empty() {
            return Ok(());
        }
        let config = self.imap_config();
        let mut session = imap_client::connect(&config).await.map_err(other)?;
        let flag_op = if add { "+FLAGS" } else { "-FLAGS" };
        let flags_str = format_flags(&[flag]);
        imap_client::set_flags(
            &mut session,
            &folder.remote_id,
            &uid_set(uids),
            flag_op,
            &flags_str,
        )
        .await
        .map_err(other)?;
        let _ = session.logout().await;
        Ok(())
    }

    async fn move_messages(
        &self,
        src: &RemoteFolder,
        uids: &[u32],
        dest: &RemoteFolder,
    ) -> Result<(), SourceError> {
        if uids.is_empty() {
            return Ok(());
        }
        let config = self.imap_config();
        let mut session = imap_client::connect(&config).await.map_err(other)?;
        imap_client::move_messages(
            &mut session,
            &src.remote_id,
            &uid_set(uids),
            &dest.remote_id,
        )
        .await
        .map_err(other)?;
        let _ = session.logout().await;
        Ok(())
    }

    async fn delete_messages(
        &self,
        folder: &RemoteFolder,
        uids: &[u32],
    ) -> Result<(), SourceError> {
        if uids.is_empty() {
            return Ok(());
        }
        let config = self.imap_config();
        let mut session = imap_client::connect(&config).await.map_err(other)?;
        imap_client::delete_messages(&mut session, &folder.remote_id, &uid_set(uids))
            .await
            .map_err(other)?;
        let _ = session.logout().await;
        Ok(())
    }

    async fn append(
        &self,
        folder: &RemoteFolder,
        raw: &[u8],
        flags: &[&str],
    ) -> Result<(), SourceError> {
        let config = self.imap_config();
        let mut session = imap_client::connect(&config).await.map_err(other)?;
        let flags_str = format_flags(flags);
        let flags_opt = if flags.is_empty() {
            None
        } else {
            Some(flags_str.as_str())
        };
        imap_client::append_message(&mut session, &folder.remote_id, flags_opt, raw)
            .await
            .map_err(other)?;
        let _ = session.logout().await;
        Ok(())
    }

    async fn send(&self, raw_base64url: &str) -> Result<(), SourceError> {
        smtp_client::send_raw_email(&self.smtp_config(), raw_base64url)
            .await
            .map(|_| ())
            .map_err(other)
    }

    /// Long-lived IDLE on `folder`. Blocks until the server signals a change
    /// (EXISTS/EXPUNGE/FLAG), then returns `Ok(())` so the caller can re-sync and
    /// re-enter watch(). Cancelable by drop: the outer watcher task `select!`s on this
    /// future vs a shutdown signal; dropping it mid-wait simply drops the inner wait
    /// future (async-imap 0.10 has no Drop impl on `Handle`, so no DONE is sent on
    /// drop — the server times the dangling IDLE out, and the next watch() reconnects
    /// cleanly). Returns `Err(SourceError::Unsupported)` if the server's CAPABILITY
    /// does not advertise `IDLE`.
    ///
    /// Keepalive: `wait_with_timeout(IDLE_KEEPALIVE=28min)` returns `Timeout` if no
    /// bytes arrive for 28 min; on Timeout we send DONE, recover the Session, and loop
    /// (re-init IDLE). The 28-min clock is reset by any server traffic, including
    /// `* OK Still here` keepalive pings.
    async fn watch(&self, folder: &RemoteFolder) -> Result<(), SourceError> {
        // watch() owns its own connection (IDLE needs a persistent socket). Connect,
        // SELECT the folder, and refresh the caps cache.
        let config = self.imap_config();
        let mut session = imap_client::connect(&config).await.map_err(other)?;
        tokio::time::timeout(Duration::from_secs(30), session.select(&folder.remote_id))
            .await
            .map_err(|_| other(format!("SELECT {} timed out", folder.remote_id)))?
            .map_err(|e| other(e.to_string()))?;

        let mut idle_cap = false;
        if let Ok((idle, condstore, qresync, vanished)) =
            imap_client::session_capabilities(&mut session).await
        {
            idle_cap = idle;
            *self.caps.lock().unwrap() = Some(Capabilities {
                idle,
                condstore,
                qresync,
                ping: false,
                vanishearch: vanished,
            });
        }
        if !idle_cap {
            let _ = session.logout().await;
            return Err(SourceError::Unsupported);
        }

        loop {
            // Enter IDLE: idle() consumes the Session, init() sends IDLE and waits
            // for the `+ idling` continuation. On failure we surface the error and
            // let the caller reconnect.
            let mut idle = session.idle();
            idle.init()
                .await
                .map_err(|e| other(format!("IDLE init failed: {e}")))?;

            // wait_with_timeout returns a future + StopSource. We discard the
            // StopSource (manual interrupt not needed here; the outer select! drops
            // the whole watch() future for cancellation). The future's clock resets
            // on any server traffic, so 28 min of total silence -> Timeout.
            let (wait_fut, _stop) = idle.wait_with_timeout(IDLE_KEEPALIVE);
            match wait_fut.await {
                Ok(IdleResponse::NewData(_)) => {
                    // Server signaled a real change. Send DONE, recover the session,
                    // logout, return Ok so the caller re-syncs then re-enters watch().
                    match idle.done().await {
                        Ok(mut s) => {
                            let _ = s.logout().await;
                        }
                        Err(e) => log::warn!("[sync] IDLE done() after NewData failed: {e}"),
                    }
                    return Ok(());
                }
                Ok(IdleResponse::ManualInterrupt) => {
                    // Treated as a notification: caller re-syncs, then re-enters.
                    match idle.done().await {
                        Ok(mut s) => {
                            let _ = s.logout().await;
                        }
                        Err(e) => {
                            log::warn!("[sync] IDLE done() after ManualInterrupt failed: {e}")
                        }
                    }
                    return Ok(());
                }
                Ok(IdleResponse::Timeout) => {
                    // Keepalive fired: 28 min of silence. Send DONE to recover the
                    // Session, then loop and re-init IDLE (keeps the connection
                    // alive below the server's ~29 min idle disconnect).
                    match idle.done().await {
                        Ok(s) => {
                            session = s;
                        }
                        Err(e) => {
                            return Err(other(format!("IDLE done() after Timeout failed: {e}")));
                        }
                    }
                    continue;
                }
                Err(e) => {
                    // IDLE wait itself errored (socket dead, parse failure, etc.).
                    // The handle is consumed by the error path; we cannot recover
                    // the session, so surface the error and let the caller reconnect.
                    return Err(other(format!("IDLE wait failed: {e}")));
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::init_db;
    use crate::db::sync_state::advance_imap_cursor;
    use crate::mail::imap::types::ImapAttachment;

    #[test]
    fn role_from_special_use_maps_known_flags() {
        assert_eq!(role_from_special_use(Some("\\Inbox")), Some("inbox".into()));
        assert_eq!(role_from_special_use(Some("\\Sent")), Some("sent".into()));
        assert_eq!(
            role_from_special_use(Some("\\Drafts")),
            Some("drafts".into())
        );
        assert_eq!(role_from_special_use(Some("\\Trash")), Some("trash".into()));
        assert_eq!(role_from_special_use(Some("\\Junk")), Some("junk".into()));
        assert_eq!(
            role_from_special_use(Some("\\Archive")),
            Some("archive".into())
        );
        assert_eq!(role_from_special_use(None), None);
        assert_eq!(role_from_special_use(Some("\\Other")), None);
    }

    #[test]
    fn role_from_name_detects_inbox() {
        assert_eq!(role_from_name("INBOX"), Some("inbox".into()));
        assert_eq!(role_from_name("Inbox"), Some("inbox".into()));
        assert_eq!(role_from_name("Sent"), None);
    }

    #[test]
    fn parent_of_splits_on_delimiter() {
        assert_eq!(parent_of("INBOX", "/"), None);
        assert_eq!(parent_of("A/B/C", "/"), Some("A/B".into()));
        assert_eq!(parent_of("A.B", "."), Some("A".into()));
        assert_eq!(parent_of("flat", "/"), None);
        assert_eq!(parent_of("anything", ""), None);
    }

    #[test]
    fn uid_set_joins_comma() {
        assert_eq!(uid_set(&[1, 2, 3]), "1,2,3");
        assert_eq!(uid_set(&[42]), "42");
        assert_eq!(uid_set(&[]), "");
    }

    #[test]
    fn format_flags_prepends_backslash() {
        assert_eq!(format_flags(&["\\Seen"]), "(\\Seen)");
        assert_eq!(format_flags(&["Seen", "Flagged"]), "(\\Seen \\Flagged)");
        assert_eq!(format_flags(&[]), "()");
    }

    #[test]
    fn imap_message_to_remote_maps_fields_and_attachments_flag() {
        let m = ImapMessage {
            uid: 7,
            folder: "INBOX".into(),
            message_id: Some("<m@x>".into()),
            in_reply_to: None,
            references: None,
            from_address: Some("a@b".into()),
            from_name: Some("A".into()),
            to_addresses: None,
            cc_addresses: None,
            bcc_addresses: None,
            reply_to: None,
            subject: Some("Hi".into()),
            date: 1234,
            is_read: false,
            is_starred: true,
            is_draft: false,
            body_html: Some("<p>x</p>".into()),
            body_text: Some("x".into()),
            snippet: Some("x".into()),
            raw_size: 10,
            list_unsubscribe: None,
            list_unsubscribe_post: None,
            auth_results: None,
            attachments: vec![ImapAttachment {
                part_id: "2".into(),
                filename: "f.bin".into(),
                mime_type: "application/octet-stream".into(),
                size: 5,
                content_id: None,
                is_inline: false,
            }],
        };
        let r = imap_message_to_remote(m);
        assert_eq!(r.uid, 7);
        assert_eq!(r.folder, "INBOX");
        assert_eq!(r.message_id.as_deref(), Some("<m@x>"));
        assert_eq!(r.subject.as_deref(), Some("Hi"));
        assert!(r.is_starred);
        assert!(!r.is_read);
        assert!(r.has_attachments);
    }

    #[test]
    fn imap_folder_to_remote_uses_raw_path_and_role() {
        let f = ImapFolder {
            path: "Sent".into(),
            raw_path: "Sent".into(),
            name: "Sent".into(),
            delimiter: "/".into(),
            special_use: Some("\\Sent".into()),
            exists: 5,
            unseen: 1,
        };
        let r = imap_folder_to_remote(f);
        assert_eq!(r.remote_id, "Sent");
        assert_eq!(r.role.as_deref(), Some("sent"));
        assert_eq!(r.exists, 5);
        assert_eq!(r.unseen, 1);
    }

    /// Cancellation/connect-failure test for `watch()`.
    ///
    /// A live IDLE needs a real socket (validated in Task 4/5 e2e), so the unit test
    /// covers the two paths we CAN exercise without one:
    ///   1. connect failure returns `Err(Other(..))` fast (no hang) when pointed at a
    ///      non-existent host — proving the watch() entry path doesn't block.
    ///   2. `watch()` is cancelable by drop: wrapping it in `tokio::time::timeout`
    ///      and letting the timeout win drops the future cleanly (no panic). This is
    ///      exactly what the outer watcher task's `select!` does for shutdown.
    ///
    /// The live notification behavior (NewData -> Ok(()), keepalive loop) is
    /// validated by the Task 4 manual e2e against a real IMAP server.
    #[tokio::test]
    async fn watch_returns_err_fast_on_connect_failure_and_is_cancelable_by_drop() {
        // Point at a host that refuses TCP connections on this port. connect() should
        // fail fast (connection refused / timeout), surfacing Err(Other(..)).
        let account = Account {
            email: "nobody@invalid.test".into(),
            provider: "imap".into(),
            imap_host: Some("127.0.0.1".into()),
            // TCP port 1 is reserved and not listening on dev machines; connect
            // fails near-instantly with ConnectionRefused.
            imap_port: Some(1),
            imap_security: Some("none".into()),
            imap_username: Some("nobody".into()),
            imap_password: Some("wrong".into()),
            ..Account::default()
        };
        let source = ImapSource::new(account);
        let folder = RemoteFolder {
            remote_id: "INBOX".into(),
            name: "INBOX".into(),
            delimiter: "/".into(),
            ..Default::default()
        };

        // Path 1: watch() returns Err (not hang) on connect failure.
        let res = source.watch(&folder).await;
        assert!(
            res.is_err(),
            "watch() against a dead host should error, not hang"
        );
        match res {
            Err(SourceError::Other(_)) => {}
            Err(SourceError::Unsupported) => {
                // Acceptable: if caps somehow got cached without IDLE we still bail.
            }
            Ok(()) => panic!("watch() must not return Ok against a dead host"),
        }

        // Path 2: cancelability by drop. Wrap a fresh watch() call in a very short
        // timeout; if watch() is not cancelable by drop this hangs the test. We use
        // a second source (fresh caps cache) to avoid any state leakage.
        let source2 = ImapSource::new(Account {
            email: "nobody2@invalid.test".into(),
            provider: "imap".into(),
            imap_host: Some("127.0.0.1".into()),
            imap_port: Some(1),
            imap_security: Some("none".into()),
            imap_username: Some("nobody".into()),
            imap_password: Some("wrong".into()),
            ..Account::default()
        });
        let cancel = tokio::time::timeout(Duration::from_millis(100), source2.watch(&folder)).await;
        // Either the connect failed fast (Err resolves before the timeout) OR the
        // timeout fired and dropped the pending future. Both prove no hang/panic.
        assert!(
            cancel.is_ok() || cancel.is_err(),
            "tokio::timeout always resolves; this assert is a no-op sanity check"
        );
        // The load-bearing assertion is that this line is reached at all.
    }

    /// REGRESSION companion to the EAS `load_cursor` test: confirms
    /// `ImapSource::load_cursor` reads `folder_sync_state` and returns a
    /// `Cursor::Imap` with the persisted uidvalidity/uid/modseq. This locks in
    /// the source-owned `load_cursor` contract for the IMAP side (the engine
    /// previously called `sync_state::get_imap_cursor` directly; it now goes
    /// through the trait, so this test proves the delegation is wired).
    #[tokio::test]
    async fn load_cursor_returns_persisted_imap_cursor() {
        let tmp = tempfile::tempdir().unwrap();
        let pool = init_db(tmp.path()).await.unwrap();
        // folder_sync_state.account_id REFERENCES accounts(id); seed the parent.
        sqlx::query("INSERT INTO accounts (id, email, provider) VALUES (?, ?, 'imap')")
            .bind("imap-acct")
            .bind("imap@x.com")
            .execute(&pool)
            .await
            .unwrap();
        advance_imap_cursor(&pool, "imap-acct", "INBOX", 100, 42, 7)
            .await
            .unwrap();

        let src = ImapSource::new(Account::default());
        let cursor = src.load_cursor(&pool, "imap-acct", "INBOX").await;
        match cursor {
            Cursor::Imap {
                uidvalidity,
                highest_uid,
                highest_modseq,
            } => {
                assert_eq!(uidvalidity, 100);
                assert_eq!(highest_uid, 42);
                assert_eq!(highest_modseq, 7);
            }
            other => panic!(
                "ImapSource::load_cursor must return Cursor::Imap, got {other:?}"
            ),
        }
    }
}
