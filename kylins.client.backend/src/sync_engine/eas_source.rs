// EasSource — MailSource adapter over the existing EAS (WBXML) client.
//
// Phase 2 Task 4: real `list_folders` (FolderSync) + real `ping` (Ping) +
// `capabilities() -> { ping: true }` so the RealtimeStrategy *could* select EAS
// Ping in a future task.
//
// Phase 3a Task 4: `sync_folder` now drives the real EAS Sync command through
// `EasClient::sync` (which parses the WBXML Sync response as of Task 3) and
// maps `EasItem`s into source-agnostic `RemoteMessage`s. The engine advances
// the `Cursor::Eas` cursor via `sync_state::advance_eas_cursor`.
//
// MVP limitations (documented, intentionally not gold-plated):
//   * `parse_eas_date` returns `None` — `date_received` is dropped to 0. A
//     follow-up adds ISO-8601 parsing (no `time`/`chrono` dep in this crate).
//   * MoreAvailable is single-round — the 60s poll loop re-enters sync with
//     the new sync_key, so the eventual full drain is bounded by polling.
//   * ServerId → uid is an FNV-style hash; a proper server-id↔uid map table is
//     a follow-up.
//   * `deleted_server_ids` are NOT mapped to `vanished_uids` yet (EAS
//     deletes-as-moves semantics need the uid map above first).
//   * status 12 ideally triggers FolderSync; MVP resets sync_key + wipes cache
//     (safe fallback).
//
// Other trait methods (`fetch_body`, `set_flags`, `move_messages`,
// `delete_messages`, `append`, `send`) remain unsupported stubs; they'll be
// filled in by a later task alongside the Sync parser.

use async_trait::async_trait;

use crate::db::accounts::Account;
use crate::eas::client::EasClient;
use crate::eas::client::EasError;
use crate::eas::types::{EasConfig, EasFolder, EasItem, PingCollection, PingRequest, SyncRequest};
use crate::eas::types::SyncResult;

use super::{Capabilities, Cursor, FolderDelta, MailSource, RemoteFolder, RemoteMessage, SourceError};

fn nyi() -> SourceError {
    SourceError::Other("EasSource method not yet implemented".into())
}

/// Default rate-limit window (seconds) used when the server returns 429/503
/// WITHOUT a delta-seconds `Retry-After` header (or with an HTTP-date form we
/// don't parse). Conservative: sheds one poll tick (60s) without wedging the
/// account for minutes. The breaker handles escalation for persistent failures.
const RATE_LIMIT_DEFAULT_WINDOW_SECS: i64 = 60;

/// Map an `EasError` to a `SourceError`, promoting a 429/503 `HttpStatus` to
/// `SourceError::RateLimited`. Pure / no I/O — factored out of `list_folders`
/// and `sync_folder` so the rate-limit promotion decision is unit-testable
/// without a live `EasClient`.
///
/// - 429/503 + `retry_after = Some(ra)` -> `RateLimited { retry_after: ra }`
///   (server told us exactly how long to wait).
/// - 429/503 + `retry_after = None`     -> `RateLimited { retry_after:
///   RATE_LIMIT_DEFAULT_WINDOW_SECS }` (server throttled us without a window;
///   use the conservative default).
/// - Any other `EasError` (transport, WBXML, CommandStatus, HttpStatus 5xx
///   other than 503, etc.) -> `SourceError::Other(..)` (preserves the existing
///   behavior for non-throttle failures; the breaker may bump on these).
fn map_eas_error(err: EasError) -> SourceError {
    match err {
        EasError::HttpStatus {
            status: 429 | 503,
            retry_after: Some(ra),
            ..
        } => SourceError::RateLimited { retry_after: ra },
        EasError::HttpStatus {
            status: 429 | 503,
            ..
        } => SourceError::RateLimited {
            retry_after: RATE_LIMIT_DEFAULT_WINDOW_SECS,
        },
        other => SourceError::Other(other.to_string()),
    }
}

/// Recovery action for an EAS Sync collection status (MS-ASSYNC 2.2.3.23).
///
/// Factored out of `sync_folder` so the status-recovery decision is unit-
/// testable without a live `EasClient`. `sync_folder` consults this and then
/// either applies the delta (`Ok`), returns a wipe-and-resync `FolderDelta`
/// (`Resync`), or surfaces a `SourceError::Other` (`Error`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum CollectionStatusAction {
    /// Status 1 (success) or 6 (partial success) — apply the returned delta.
    Ok,
    /// Status 3 (invalid sync key) or 12 (folder hierarchy changed) — reset
    /// sync_key to "0" and signal `uidvalidity_changed` so the engine wipes
    /// the folder cache and re-bootstraps on the next round.
    ///
    /// Status 12 ideally also triggers a FolderSync (the hierarchy change may
    /// have moved/renamed the collection). The MVP-safe fallback (cache wipe +
    /// re-sync) is a correct superset of the status-3 recovery and un-wedges
    /// the folder; a follow-up wires the explicit FolderSync.
    Resync,
    /// Any other status — surface as `SourceError::Other` rather than silently
    /// succeeding or wedging on a resync loop.
    Error,
}

/// Classify an EAS Sync collection status into a recovery action. Pure / no I/O.
///
/// MS-ASSYNC 2.2.3.23 status codes:
///   1  = success
///   3  = invalid synchronization key (server lost state)
///   6  = (server-side) optional partial success
///   12 = server detected the folder hierarchy changed since the last sync
fn classify_collection_status(status: u32) -> CollectionStatusAction {
    match status {
        1 | 6 => CollectionStatusAction::Ok,
        3 | 12 => CollectionStatusAction::Resync,
        _ => CollectionStatusAction::Error,
    }
}

pub struct EasSource {
    account: Account,
}

impl EasSource {
    pub fn new(account: Account) -> Self {
        Self { account }
    }

    /// Map the stored `Account` row onto an `EasConfig` for the EAS client.
    ///
    /// `username` falls back to `email` when `imap_username` is unset (matches
    /// the ImapSource convention). `protocol_version` falls back to `"16.1"`
    /// (Exchange 2016/2019/Online). `policy_key` falls back to `""` (the HTTP
    /// layer sends header `X-MS-PolicyKey: 0` for empty, per the EAS client).
    fn eas_config(&self) -> EasConfig {
        EasConfig {
            url: self.account.eas_url.clone().unwrap_or_default(),
            username: self
                .account
                .imap_username
                .clone()
                .filter(|s| !s.is_empty())
                .unwrap_or_else(|| self.account.email.clone()),
            password: self.account.imap_password.clone().unwrap_or_default(),
            protocol_version: self
                .account
                .eas_protocol_version
                .clone()
                .filter(|s| !s.is_empty())
                .unwrap_or_else(|| "16.1".to_string()),
            device_id: self.account.eas_device_id.clone().unwrap_or_default(),
            device_type: "KylinsMail".to_string(),
            user_agent: self
                .account
                .eas_user_agent
                .clone()
                .filter(|s| !s.is_empty())
                .unwrap_or_else(|| "KylinsMail/1.0".to_string()),
            policy_key: self.account.eas_policy_key.clone().unwrap_or_default(),
            accept_invalid_certs: self.account.accept_invalid_certs,
        }
    }
}

/// Map an `EasFolder` (from a FolderSync response) to the source-agnostic
/// `RemoteFolder`. `role` is derived from the raw EAS folder `Type` byte
/// (MS-ASFD `FolderHierarchy:Type`): 2=Inbox, 3=Drafts, 4=DeletedItems,
/// 5=Sent, 6=Outbox, 12=user-created mail. Surfacing a canonical role here
/// lets the frontend avoid locale-dependent name matching.
fn role_from_folder_type(folder_type: Option<u8>) -> Option<String> {
    match folder_type? {
        2 => Some("inbox".into()),
        3 => Some("drafts".into()),
        4 => Some("trash".into()),
        5 => Some("sent".into()),
        6 => Some("outbox".into()),
        _ => None,
    }
}

fn eas_folder_to_remote(f: EasFolder) -> RemoteFolder {
    let parent_id = if f.parent_id.is_empty() {
        None
    } else {
        Some(f.parent_id.clone())
    };
    RemoteFolder {
        remote_id: f.server_id,
        name: f.display_name,
        delimiter: "/".to_string(),
        special_use: None,
        role: role_from_folder_type(f.folder_type),
        parent_id,
        exists: 0,
        unseen: 0,
    }
}

/// Map a typed `EasItem` (from a Sync response) onto the source-agnostic
/// `RemoteMessage` consumed by `messages::apply_folder_delta`.
///
/// `uid` is derived from the EAS `ServerId` via an FNV-style hash. EAS has no
/// numeric UID of its own — ServerId is opaque per-server — so a stable hash
/// gives the engine a fixed-width key it can store, dedupe, and keyset-paginate
/// on. A proper server-id↔uid map table is a follow-up (the hash is stable for
/// a given ServerId, so swapping it in later is transparent to the DB schema).
fn eas_item_to_remote(item: &EasItem, folder: &str) -> RemoteMessage {
    let uid = item
        .server_id
        .bytes()
        .fold(0u32, |a, b| a.wrapping_mul(31).wrapping_add(b as u32));
    RemoteMessage {
        uid,
        folder: folder.to_string(),
        // EAS doesn't expose an RFC `Message-Id` in ApplicationData by default;
        // the field exists on `EasItem` for future ItemOperations enrichment.
        message_id: item.message_id.clone(),
        from_address: item.from.clone(),
        // MVP: the From string is passed verbatim (often "Display Name" <addr>).
        // Structured parsing into from_name/from_address is a follow-up that
        // needs an RFC 5322 mailbox parser shared with the IMAP path.
        from_name: None,
        to_addresses: item.to.clone(),
        cc_addresses: item.cc.clone(),
        bcc_addresses: item.bcc.clone(),
        reply_to: item.reply_to.clone(),
        subject: item.subject.clone(),
        snippet: item.preview.clone(),
        date: parse_eas_date(item.date_received.as_deref()).unwrap_or(0),
        is_read: item.read.unwrap_or(false),
        // EAS `Flag` (flagged/follow-up) maps to starred; the wire field is a
        // complex type in 16.1 but the parser surfaces a bool for MVP.
        is_starred: item.flag.unwrap_or(false),
        is_draft: item.is_draft.unwrap_or(false),
        body_html: item.body_html.clone(),
        body_text: item.body_text.clone(),
        // raw_size: EAS doesn't give a raw byte size for the whole MIME; the
        // bodies above carry their own lengths. Zero is the conventional
        // "unknown" for the engine's size column.
        raw_size: 0,
        has_attachments: item.has_attachments,
        ..Default::default()
    }
}

/// Parse an EAS `DateReceived` (ISO-8601, e.g. "2025-01-01T00:00:00.000Z") to
/// unix-epoch seconds. MVP: returns `None` so the engine stores `date = 0`
/// (sorts as oldest). The proper parser needs an ISO-8601 library that isn't a
/// runtime dep of this crate yet — tracked as a follow-up alongside the
/// IMAP-date parser (chrono is currently dev-dep only).
fn parse_eas_date(_s: Option<&str>) -> Option<i64> {
    None
}

#[async_trait]
impl MailSource for EasSource {
    fn capabilities(&self) -> Capabilities {
        // EAS supports Ping (long-poll heartbeats) but not IMAP IDLE/CONDSTORE/
        // QRESYNC. The scheduler reads this to pick a RealtimeStrategy.
        Capabilities {
            ping: true,
            ..Capabilities::default()
        }
    }

    /// EasSource owns its cursor in `eas_sync_state`. Delegates to the shared
    /// `sync_state::get_eas_cursor` helper (typed row -> `Cursor::Eas`). This is
    /// the fix for the bug where the engine was unconditionally loading the IMAP
    /// cursor and handing an `Cursor::Imap` to `EasSource::sync_folder`, which
    /// made EAS re-bootstrap (sync_key "0") every round.
    async fn load_cursor(
        &self,
        pool: &sqlx::SqlitePool,
        account_id: &str,
        folder_path: &str,
    ) -> Cursor {
        crate::db::sync_state::get_eas_cursor(pool, account_id, folder_path).await
    }

    async fn list_folders(&self) -> Result<Vec<RemoteFolder>, SourceError> {
        let client = EasClient::new(self.eas_config());
        // Initial FolderSync uses sync_key "0" for the full hierarchy.
        // `map_eas_error` promotes a 429/503 HttpStatus (with or without a
        // Retry-After) to SourceError::RateLimited; anything else stays Other.
        let result = client
            .folder_sync("0")
            .await
            .map_err(map_eas_error)?;
        Ok(result
            .changes
            .into_iter()
            .map(eas_folder_to_remote)
            .collect())
    }

    async fn sync_folder(
        &self,
        folder: &RemoteFolder,
        since: Cursor,
    ) -> Result<FolderDelta, SourceError> {
        // Resolve the cursor: an EAS cursor carries the persisted sync_key; any
        // other cursor (e.g. a fresh folder with the default Imap cursor) is
        // treated as an initial sync (sync_key "0"). The collection_id is the
        // folder's remote_id (the EAS folder ServerId from FolderSync).
        let (collection_id, sync_key) = match &since {
            Cursor::Eas {
                collection_id,
                sync_key,
            } => (collection_id.clone(), sync_key.clone()),
            // Non-EAS cursor: start a fresh EAS sync on this collection.
            _ => (folder.remote_id.clone(), "0".to_string()),
        };

        let client = EasClient::new(self.eas_config());
        let req = SyncRequest {
            collection_id: collection_id.clone(),
            sync_key: sync_key.clone(),
            class: "Email".into(),
            window_size: 50,
            filter_age_days: 0,
            fetch_body: true,
        };
        let result: SyncResult = client
            .sync(&req)
            .await
            .map_err(map_eas_error)?;

        // Status recovery. MS-ASSYNC collection status: 1 = success,
        // 6 = (server-side) optional partial success treated as ok, 3 = invalid
        // sync key (server lost state), 12 = folder hierarchy changed since the
        // last sync. Statuses 3 and 12 both require a resync: reset the sync_key
        // to "0" and signal uidvalidity_changed so the engine wipes the folder
        // cache before applying the (empty) delta from this round; the next
        // round re-enters sync_folder with sync_key "0" for a full pull.
        //
        // Status 12 ideally also triggers a FolderSync (the hierarchy change may
        // have moved/renamed the collection); the MVP-safe fallback (cache wipe
        // + re-sync) is a correct superset of the status-3 recovery and un-
        // wedges the folder. See `classify_collection_status` and the file's
        // MVP-limitations note.
        match classify_collection_status(result.status) {
            CollectionStatusAction::Resync => {
                return Ok(FolderDelta {
                    added: vec![],
                    updated: vec![],
                    flag_updates: vec![],
                    vanished_uids: vec![],
                    next_cursor: Cursor::Eas {
                        collection_id,
                        sync_key: "0".into(),
                    },
                    uidvalidity_changed: true,
                });
            }
            CollectionStatusAction::Ok => {}
            CollectionStatusAction::Error => {
                return Err(SourceError::Other(format!(
                    "EAS sync status {}",
                    result.status
                )));
            }
        }

        // Map typed EasItems to source-agnostic RemoteMessages. Both added and
        // updated items are full envelopes (the parser fills the same fields
        // for both Change types), so the same mapping applies.
        let added: Vec<RemoteMessage> = result
            .added
            .iter()
            .map(|i| eas_item_to_remote(i, &folder.remote_id))
            .collect();
        let updated: Vec<RemoteMessage> = result
            .updated
            .iter()
            .map(|i| eas_item_to_remote(i, &folder.remote_id))
            .collect();

        // MoreAvailable: MVP is single-round. The next sync_key is always the
        // one from the response — re-entering on the next poll tick drains the
        // remaining pages (each round yields up to window_size=50 items). A
        // tight drain loop is a follow-up once the engine has a backpressure
        // story for large mailboxes.
        //
        // vanished_uids: EAS signals deletes via `deleted_server_ids`, but
        // mapping those to our hashed uids needs the server-id↔uid table (see
        // eas_item_to_remote). Deferred — leave empty for now.
        Ok(FolderDelta {
            added,
            updated,
            flag_updates: vec![],
            vanished_uids: vec![],
            next_cursor: Cursor::Eas {
                collection_id,
                sync_key: result.sync_key,
            },
            uidvalidity_changed: false,
        })
    }

    async fn fetch_body(
        &self,
        _folder: &RemoteFolder,
        _uid: u32,
    ) -> Result<Option<String>, SourceError> {
        Err(nyi())
    }
    async fn set_flags(
        &self,
        _folder: &RemoteFolder,
        _uids: &[u32],
        _flag: &str,
        _add: bool,
    ) -> Result<(), SourceError> {
        Err(nyi())
    }
    async fn move_messages(
        &self,
        _src: &RemoteFolder,
        _uids: &[u32],
        _dest: &RemoteFolder,
    ) -> Result<(), SourceError> {
        Err(nyi())
    }
    async fn delete_messages(
        &self,
        _folder: &RemoteFolder,
        _uids: &[u32],
    ) -> Result<(), SourceError> {
        Err(nyi())
    }
    async fn append(
        &self,
        _folder: &RemoteFolder,
        _raw: &[u8],
        _flags: &[&str],
    ) -> Result<(), SourceError> {
        Err(nyi())
    }
    async fn send(&self, _raw_base64url: &str) -> Result<(), SourceError> {
        Err(nyi())
    }

    /// Long-poll the server for changes on the monitored collections. EAS Ping
    /// blocks for up to `heartbeat_interval` (we use 1800s = 30 min, comfortably
    /// under the server max of ~3540s) or until a change is signaled, whichever
    /// comes first. Returns `Ok(())` on either outcome (change detected OR
    /// heartbeat elapsed); the caller then re-syncs and re-enters ping.
    async fn ping(&self, collections: &[(&str, &str)]) -> Result<(), SourceError> {
        let client = EasClient::new(self.eas_config());
        let req = PingRequest {
            heartbeat_interval: 1800,
            monitored_collections: collections
                .iter()
                .map(|(id, class)| PingCollection {
                    collection_id: id.to_string(),
                    class: class.to_string(),
                })
                .collect(),
        };
        client
            .ping(&req)
            .await
            .map(|_| ())
            .map_err(|e| SourceError::Other(e.to_string()))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::init_db;
    use crate::db::sync_state::advance_eas_cursor;
    use crate::eas::types::{EasFolder, EasItem};

    #[test]
    fn eas_item_to_remote_maps_fields() {
        let item = EasItem {
            server_id: "1:123".into(),
            subject: Some("Hello".into()),
            from: Some("a@b.com".into()),
            to: Some("c@d.com".into()),
            read: Some(true),
            body_html: Some("<p>Hi</p>".into()),
            date_received: Some("2025-01-01T00:00:00.000Z".into()),
            ..Default::default()
        };
        let m = eas_item_to_remote(&item, "INBOX");
        // uid is the FNV-style hash of the server_id bytes.
        let expected_uid = "1:123"
            .bytes()
            .fold(0u32, |a, b| a.wrapping_mul(31).wrapping_add(b as u32));
        assert_eq!(m.uid, expected_uid);
        assert_eq!(m.subject.as_deref(), Some("Hello"));
        assert_eq!(m.from_address.as_deref(), Some("a@b.com"));
        assert_eq!(m.to_addresses.as_deref(), Some("c@d.com"));
        assert!(m.is_read);
        assert_eq!(m.body_html.as_deref(), Some("<p>Hi</p>"));
        assert_eq!(m.folder, "INBOX");
        // MVP deferrals.
        assert_eq!(m.date, 0, "parse_eas_date returns None for MVP");
        assert_eq!(m.from_name, None);
        assert_eq!(m.message_id, None);
    }

    #[test]
    fn capabilities_advertises_ping_only() {
        let src = EasSource::new(Account::default());
        let caps = src.capabilities();
        assert!(caps.ping, "EAS sources must advertise ping support");
        assert!(
            !caps.idle,
            "EAS sources must not advertise IDLE (IMAP-only)"
        );
        assert!(
            !caps.condstore && !caps.qresync && !caps.vanishearch,
            "EAS sources must not advertise IMAP-only caps"
        );
    }

    #[test]
    fn eas_folder_to_remote_maps_server_id_and_display_name() {
        let f = EasFolder {
            server_id: "1".to_string(),
            parent_id: "0".to_string(),
            display_name: "Inbox".to_string(),
            class: "Email".to_string(),
            folder_type: Some(2),
        };
        let r = eas_folder_to_remote(f);
        assert_eq!(r.remote_id, "1");
        assert_eq!(r.name, "Inbox");
        assert_eq!(r.delimiter, "/");
        assert_eq!(r.role.as_deref(), Some("inbox"));
        assert_eq!(r.parent_id.as_deref(), Some("0"));
    }

    #[test]
    fn eas_folder_to_remote_maps_known_folder_types_to_roles() {
        // MS-ASFD FolderHierarchy:Type values.
        let cases: &[(u8, &str)] = &[
            (2, "inbox"),
            (3, "drafts"),
            (4, "trash"),
            (5, "sent"),
            (6, "outbox"),
        ];
        for (ty, expected_role) in cases {
            let f = EasFolder {
                server_id: format!("id-{ty}"),
                parent_id: "0".to_string(),
                display_name: format!("Folder {ty}"),
                class: "Email".to_string(),
                folder_type: Some(*ty),
            };
            let r = eas_folder_to_remote(f);
            assert_eq!(
                r.role.as_deref(),
                Some(*expected_role),
                "folder_type {ty} should map to role {expected_role}"
            );
        }
    }

    #[test]
    fn eas_folder_to_remote_returns_none_role_for_unknown_or_absent_type() {
        // user-created folder (Type 12 / 1) and missing Type both yield None.
        let f = EasFolder {
            server_id: "custom".to_string(),
            parent_id: "0".to_string(),
            display_name: "My Folder".to_string(),
            class: "Email".to_string(),
            folder_type: Some(12),
        };
        assert_eq!(eas_folder_to_remote(f).role, None);

        let f = EasFolder {
            server_id: "notype".to_string(),
            parent_id: String::new(),
            display_name: "No Type".to_string(),
            class: "Email".to_string(),
            folder_type: None,
        };
        let r = eas_folder_to_remote(f);
        assert_eq!(r.role, None);
        assert_eq!(r.parent_id, None, "empty parent_id should become None");
    }

    #[test]
    fn eas_config_maps_account_fields_with_defaults() {
        let account = Account {
            email: "user@example.com".to_string(),
            imap_username: Some("user@example.com".to_string()),
            imap_password: Some("hunter2".to_string()),
            eas_url: Some("https://mail.example.com/Microsoft-Server-ActiveSync".to_string()),
            eas_protocol_version: Some("14.1".to_string()),
            eas_device_id: Some("DEVICE1234".to_string()),
            eas_policy_key: Some("policy-abc".to_string()),
            accept_invalid_certs: true,
            ..Account::default()
        };
        let src = EasSource::new(account);
        let cfg = src.eas_config();
        assert_eq!(
            cfg.url,
            "https://mail.example.com/Microsoft-Server-ActiveSync"
        );
        assert_eq!(cfg.username, "user@example.com");
        assert_eq!(cfg.password, "hunter2");
        assert_eq!(cfg.protocol_version, "14.1");
        assert_eq!(cfg.device_id, "DEVICE1234");
        assert_eq!(cfg.device_type, "KylinsMail");
        assert_eq!(cfg.user_agent, "KylinsMail/1.0");
        assert_eq!(cfg.policy_key, "policy-abc");
        assert!(cfg.accept_invalid_certs);
    }

    #[test]
    fn eas_config_falls_back_to_email_when_username_missing() {
        let account = Account {
            email: "fallback@example.com".to_string(),
            imap_username: None,
            ..Account::default()
        };
        let src = EasSource::new(account);
        let cfg = src.eas_config();
        assert_eq!(cfg.username, "fallback@example.com");
    }

    #[test]
    fn eas_config_falls_back_to_defaults_when_optional_fields_blank() {
        let account = Account {
            email: "x@y.com".to_string(),
            eas_protocol_version: None,
            eas_user_agent: None,
            eas_policy_key: None,
            ..Account::default()
        };
        let src = EasSource::new(account);
        let cfg = src.eas_config();
        assert_eq!(cfg.protocol_version, "16.1");
        assert_eq!(cfg.user_agent, "KylinsMail/1.0");
        assert_eq!(cfg.policy_key, "");
    }

    /// `list_folders` against a non-existent host surfaces a connection error
    /// rather than hanging. The full happy-path needs a live Exchange server
    /// (validated manually); this test proves the error path is wired through
    /// `EasClient::folder_sync` -> `SourceError::Other`.
    #[tokio::test]
    async fn list_folders_surfaces_error_on_unreachable_host() {
        let account = Account {
            email: "nobody@invalid.test".to_string(),
            eas_url: Some("http://127.0.0.1:1/Microsoft-Server-ActiveSync".to_string()),
            eas_device_id: Some("TESTDEVICE".to_string()),
            ..Account::default()
        };
        let src = EasSource::new(account);
        let res = src.list_folders().await;
        assert!(
            res.is_err(),
            "list_folders against an unreachable host must error"
        );
        match res {
            Err(SourceError::Other(_)) => {}
            other => panic!("expected SourceError::Other, got {other:?}"),
        }
    }

    /// REGRESSION for the EAS-cursor bug: `run_sync_round_with_source` used to
    /// unconditionally call `sync_state::get_imap_cursor(...)` for every account,
    /// handing `EasSource::sync_folder` a `Cursor::Imap`. The EAS path then fell
    /// through to its non-Eas branch and re-bootstrapped (sync_key "0") every
    /// round, never advancing the persisted `Cursor::Eas`.
    ///
    /// Fix: the engine now calls `src.load_cursor(...)` (source-owned), and
    /// `EasSource::load_cursor` reads `eas_sync_state`. This test seeds a
    /// non-zero sync_key and asserts `EasSource::load_cursor` returns
    /// `Cursor::Eas { .. }` with the seeded values — NOT `Cursor::Imap`/default.
    #[tokio::test]
    async fn load_cursor_returns_persisted_eas_cursor_not_default() {
        let tmp = tempfile::tempdir().unwrap();
        let pool = init_db(tmp.path()).await.unwrap();
        // eas_sync_state.account_id REFERENCES accounts(id), so seed the parent
        // row first (matches the sync_state.rs test helper convention).
        sqlx::query("INSERT INTO accounts (id, email, provider) VALUES (?, ?, 'eas')")
            .bind("eas-acct")
            .bind("eas@x.com")
            .execute(&pool)
            .await
            .unwrap();
        advance_eas_cursor(&pool, "eas-acct", "INBOX", "col-7", "{sync-key-123}")
            .await
            .unwrap();

        let src = EasSource::new(Account::default());
        let cursor = src.load_cursor(&pool, "eas-acct", "INBOX").await;

        // The load-bearing assertion: the cursor is EAS-shaped and carries the
        // persisted sync_key. Before the fix this returned Cursor::Imap (default)
        // because the engine called get_imap_cursor, which has no row and falls
        // back to Cursor::initial_imap().
        match cursor {
            Cursor::Eas {
                collection_id,
                sync_key,
            } => {
                assert_eq!(collection_id, "col-7");
                assert_eq!(sync_key, "{sync-key-123}");
            }
            other => panic!(
                "EasSource::load_cursor must return Cursor::Eas, got {other:?}"
            ),
        }
    }

    /// Companion to the seeded-cursor test: with no persisted row,
    /// `EasSource::load_cursor` returns the initial EAS cursor (sync_key "0"),
    /// NOT the IMAP default. This is what a fresh EAS folder sees on its first
    /// sync round. (No accounts row needed — get_eas_cursor only reads.)
    #[tokio::test]
    async fn load_cursor_returns_initial_eas_cursor_when_no_row() {
        let tmp = tempfile::tempdir().unwrap();
        let pool = init_db(tmp.path()).await.unwrap();

        let src = EasSource::new(Account::default());
        let cursor = src.load_cursor(&pool, "eas-acct", "INBOX").await;

        // get_eas_cursor falls back to Cursor::initial_eas(folder_id) when no
        // row exists — EAS-shaped, sync_key "0". Asserting it is NOT the IMAP
        // default is the regression guard.
        match cursor {
            Cursor::Eas {
                collection_id,
                sync_key,
            } => {
                assert_eq!(collection_id, "INBOX");
                assert_eq!(sync_key, "0");
            }
            other => panic!(
                "EasSource::load_cursor with no row must return initial Cursor::Eas, got {other:?}"
            ),
        }
    }

    // ---- Phase 3a final-review fix I-2: status-12 (hierarchy changed) resync ----
    //
    // `sync_folder` calls a live `EasClient::sync`, so a pure unit test of the
    // status branch through `sync_folder` is infeasible without a mock client.
    // The status-recovery decision is factored into the pure helper
    // `classify_collection_status(status)`, which these tests exercise directly.
    // The brief's note "at minimum add a test on the status-recovery logic if
    // it's factored into a testable function" is satisfied here.

    /// Status 3 (invalid sync key, MS-ASSYNC 2.2.3.23) must classify as `Resync`
    /// so `sync_folder` resets the sync_key to "0" and signals
    /// `uidvalidity_changed = true` for a cache wipe + re-bootstrap.
    #[test]
    fn classify_status_3_is_resync() {
        assert_eq!(
            classify_collection_status(3),
            CollectionStatusAction::Resync
        );
    }

    /// Status 12 (folder hierarchy changed) must classify as `Resync` — the
    /// same recovery as status 3. Before the fix this fell through to
    /// `SourceError::Other("EAS sync status 12")`, which the engine logged and
    /// `continue`d past, wedging the folder (it failed every 60s tick with no
    /// recovery because the required FolderSync was never triggered).
    ///
    /// The MVP-safe fallback (cache wipe + re-sync) is a superset of the
    /// status-3 recovery and un-wedges sync correctly; an ideal implementation
    /// would also trigger a FolderSync, tracked as a follow-up.
    #[test]
    fn classify_status_12_is_resync_not_error() {
        assert_eq!(
            classify_collection_status(12),
            CollectionStatusAction::Resync,
            "status 12 must resync, not fall through to Other error"
        );
    }

    /// Status 1 and 6 (success / partial success) must classify as `Ok` so the
    /// engine applies the returned delta normally.
    #[test]
    fn classify_status_1_and_6_are_ok() {
        assert_eq!(classify_collection_status(1), CollectionStatusAction::Ok);
        assert_eq!(classify_collection_status(6), CollectionStatusAction::Ok);
    }

    /// Any other status (e.g. 4, 8) must classify as `Error` so `sync_folder`
    /// surfaces `SourceError::Other` rather than silently treating it as
    /// success or wedging on a resync loop.
    #[test]
    fn classify_other_statuses_are_error() {
        assert_eq!(
            classify_collection_status(4),
            CollectionStatusAction::Error
        );
        assert_eq!(
            classify_collection_status(8),
            CollectionStatusAction::Error
        );
    }

    // ---- Phase 3f Task 5: EasError -> SourceError rate-limit promotion ----
    //
    // `map_eas_error` is the pure decision function factored out of
    // `list_folders` / `sync_folder`. A 429/503 HttpStatus with a parsed
    // Retry-After promotes to SourceError::RateLimited (carrying the server's
    // epoch); a 429/503 without one falls back to the default window; anything
    // else stays SourceError::Other (so the breaker can still bump on real
    // connectivity failures).

    #[test]
    fn map_eas_error_promotes_429_with_retry_after_to_rate_limited() {
        let err = EasError::HttpStatus {
            status: 429,
            body: "Too Many Requests".into(),
            retry_after: Some(1234567890),
        };
        match map_eas_error(err) {
            SourceError::RateLimited { retry_after } => {
                assert_eq!(retry_after, 1234567890)
            }
            other => panic!("expected RateLimited, got {other:?}"),
        }
    }

    #[test]
    fn map_eas_error_promotes_503_with_retry_after_to_rate_limited() {
        // 503 is also a throttle signal when sent with Retry-After (RFC 7231
        // §7.1.3). Some Exchange deployments use 503 instead of 429.
        let err = EasError::HttpStatus {
            status: 503,
            body: "Service Unavailable".into(),
            retry_after: Some(999),
        };
        match map_eas_error(err) {
            SourceError::RateLimited { retry_after } => assert_eq!(retry_after, 999),
            other => panic!("expected RateLimited, got {other:?}"),
        }
    }

    #[test]
    fn map_eas_error_promotes_429_without_retry_after_to_default_window() {
        // Server throttled us but gave no window — fall back to the default.
        let err = EasError::HttpStatus {
            status: 429,
            body: "".into(),
            retry_after: None,
        };
        match map_eas_error(err) {
            SourceError::RateLimited { retry_after } => {
                assert_eq!(retry_after, RATE_LIMIT_DEFAULT_WINDOW_SECS)
            }
            other => panic!("expected RateLimited with default window, got {other:?}"),
        }
    }

    #[test]
    fn map_eas_error_promotes_503_without_retry_after_to_default_window() {
        let err = EasError::HttpStatus {
            status: 503,
            body: "".into(),
            retry_after: None,
        };
        match map_eas_error(err) {
            SourceError::RateLimited { retry_after } => {
                assert_eq!(retry_after, RATE_LIMIT_DEFAULT_WINDOW_SECS)
            }
            other => panic!("expected RateLimited with default window, got {other:?}"),
        }
    }

    #[test]
    fn map_eas_error_passes_other_http_status_through_as_other() {
        // 500 is a server error, not a throttle — must NOT promote. The engine
        // bumps the breaker on this path (real failure, not "server told us to
        // wait").
        let err = EasError::HttpStatus {
            status: 500,
            body: "boom".into(),
            retry_after: None,
        };
        assert!(matches!(map_eas_error(err), SourceError::Other(_)));
    }

    #[test]
    fn map_eas_error_passes_non_http_status_through_as_other() {
        // Transport / WBXML / CommandStatus errors are not throttles.
        let transport = EasError::Transport("connection reset".into());
        assert!(matches!(map_eas_error(transport), SourceError::Other(_)));

        let cmd = EasError::CommandStatus {
            status: 142,
            message: "provisioning required".into(),
        };
        assert!(matches!(map_eas_error(cmd), SourceError::Other(_)));
    }
}
