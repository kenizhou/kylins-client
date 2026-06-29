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
//
// Other trait methods (`fetch_body`, `set_flags`, `move_messages`,
// `delete_messages`, `append`, `send`) remain unsupported stubs; they'll be
// filled in by a later task alongside the Sync parser.

use async_trait::async_trait;

use crate::db::accounts::Account;
use crate::eas::client::EasClient;
use crate::eas::types::{EasConfig, EasFolder, EasItem, PingCollection, PingRequest, SyncRequest};
use crate::eas::types::SyncResult;

use super::{Capabilities, Cursor, FolderDelta, MailSource, RemoteFolder, RemoteMessage, SourceError};

fn nyi() -> SourceError {
    SourceError::Other("EasSource method not yet implemented".into())
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

    async fn list_folders(&self) -> Result<Vec<RemoteFolder>, SourceError> {
        let client = EasClient::new(self.eas_config());
        // Initial FolderSync uses sync_key "0" for the full hierarchy.
        let result = client
            .folder_sync("0")
            .await
            .map_err(|e| SourceError::Other(e.to_string()))?;
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
            .map_err(|e| SourceError::Other(e.to_string()))?;

        // Status recovery. MS-ASSYNC collection status: 1 = success,
        // 6 = (server-side) optional partial success treated as ok, 3 = invalid
        // sync key (server lost state). Status 3 means we must reset to "0" and
        // signal a resync: the engine sees uidvalidity_changed and wipes the
        // folder cache before applying the (empty) delta from this round; the
        // next round re-enters sync_folder with sync_key "0" for a full pull.
        if result.status == 3 {
            return Ok(FolderDelta {
                added: vec![],
                updated: vec![],
                vanished_uids: vec![],
                next_cursor: Cursor::Eas {
                    collection_id,
                    sync_key: "0".into(),
                },
                uidvalidity_changed: true,
            });
        }
        if result.status != 1 && result.status != 6 {
            return Err(SourceError::Other(format!(
                "EAS sync status {}",
                result.status
            )));
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
}
