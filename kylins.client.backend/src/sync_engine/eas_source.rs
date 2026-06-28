// EasSource — MailSource adapter over the existing EAS (WBXML) client.
//
// Phase 2 Task 4: real `list_folders` (FolderSync) + real `ping` (Ping) +
// `capabilities() -> { ping: true }` so the RealtimeStrategy *could* select EAS
// Ping in a future task. `sync_folder` STAYS an empty-delta stub: EAS message
// sync needs the WBXML Sync-response parser, which is still a TODO at
// `eas/client.rs:194-198` (`sync()` currently returns `SyncResult::default()`).
// Until that lands, EAS accounts get folder list + ping notifications but no
// message bodies via sync — same deferral as Phase 0.
//
// Other trait methods (`fetch_body`, `set_flags`, `move_messages`,
// `delete_messages`, `append`, `send`) remain unsupported stubs; they'll be
// filled in by a later task alongside the Sync parser.

use async_trait::async_trait;

use crate::db::accounts::Account;
use crate::eas::client::EasClient;
use crate::eas::types::{
    EasConfig, EasFolder, PingCollection, PingRequest,
};

use super::{Capabilities, Cursor, FolderDelta, MailSource, RemoteFolder, SourceError};

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
        _since: Cursor,
    ) -> Result<FolderDelta, SourceError> {
        // DEFERRED: EAS message sync needs the WBXML Sync-response parser
        // (eas::client::sync currently returns SyncResult::default() at
        // eas/client.rs:194-198). Until that lands, EAS accounts get folder
        // list + ping notifications but no message bodies via sync. We return
        // an empty delta at a fresh EAS cursor so the engine can persist state
        // without falsely advancing the sync_key.
        Ok(FolderDelta {
            added: vec![],
            updated: vec![],
            vanished_uids: vec![],
            next_cursor: Cursor::initial_eas(&folder.remote_id),
            uidvalidity_changed: false,
        })
    }

    async fn fetch_body(&self, _folder: &RemoteFolder, _uid: u32) -> Result<Option<String>, SourceError> {
        Err(nyi())
    }
    async fn set_flags(&self, _folder: &RemoteFolder, _uids: &[u32], _flag: &str, _add: bool) -> Result<(), SourceError> {
        Err(nyi())
    }
    async fn move_messages(&self, _src: &RemoteFolder, _uids: &[u32], _dest: &RemoteFolder) -> Result<(), SourceError> {
        Err(nyi())
    }
    async fn delete_messages(&self, _folder: &RemoteFolder, _uids: &[u32]) -> Result<(), SourceError> {
        Err(nyi())
    }
    async fn append(&self, _folder: &RemoteFolder, _raw: &[u8], _flags: &[&str]) -> Result<(), SourceError> {
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
    use crate::eas::types::EasFolder;

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
        assert_eq!(cfg.url, "https://mail.example.com/Microsoft-Server-ActiveSync");
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
        assert!(res.is_err(), "list_folders against an unreachable host must error");
        match res {
            Err(SourceError::Other(_)) => {}
            other => panic!("expected SourceError::Other, got {other:?}"),
        }
    }
}
