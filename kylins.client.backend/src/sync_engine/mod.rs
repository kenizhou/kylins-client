// Source-agnostic mail provider abstraction ("屏蔽差异性，统一调度"): one MailSource
// trait, N adapters (ImapSource / EasSource / future GmailApiSource / GraphSource), one
// factory. The SyncEngine (Task 9) drives any source through this trait; per-source
// capability differences are declared via capabilities() and the scheduler picks a
// RealtimeStrategy (idle / ping / poll) accordingly.

pub mod commands;
pub mod eas_source;
pub mod engine;
pub mod imap_source;
pub mod mock_source;

use async_trait::async_trait;
use serde::{Deserialize, Serialize};
use sqlx::SqlitePool;
use std::sync::Arc;

/// Per-source capability flags. The scheduler reads these once per account to pick a
/// RealtimeStrategy. Phase 0 uses poll for every source; Phase 2 adds idle/ping.
#[derive(Debug, Clone, Copy, Default, Serialize, PartialEq, Eq)]
pub struct Capabilities {
    pub idle: bool,
    pub condstore: bool,
    pub qresync: bool,
    pub ping: bool,
    pub vanishearch: bool,
}

/// Opaque per-folder delta cursor. Each source defines its own payload; the engine
/// stores/advances it via db::sync_state (Task 8). `initial_imap()`/`initial_eas()`
/// produce a "fresh folder" cursor (uidvalidity 0 / sync_key "0" = initial sync).
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(tag = "kind", rename_all = "lowercase")]
pub enum Cursor {
    Imap {
        uidvalidity: u32,
        highest_uid: u32,
        highest_modseq: u64,
    },
    Eas {
        collection_id: String,
        sync_key: String,
    },
}

impl Default for Cursor {
    fn default() -> Self {
        Cursor::Imap {
            uidvalidity: 0,
            highest_uid: 0,
            highest_modseq: 0,
        }
    }
}

impl Cursor {
    pub fn initial_imap() -> Self {
        Cursor::Imap {
            uidvalidity: 0,
            highest_uid: 0,
            highest_modseq: 0,
        }
    }
    pub fn initial_eas(collection_id: &str) -> Self {
        Cursor::Eas {
            collection_id: collection_id.to_string(),
            sync_key: "0".to_string(),
        }
    }
}

/// A folder in the source's own terms (pre-adapter; the engine maps this to a `labels`
/// row via db::labels).
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct RemoteFolder {
    pub remote_id: String,
    pub name: String,
    pub delimiter: String,
    pub special_use: Option<String>,
    pub role: Option<String>,
    pub parent_id: Option<String>,
    pub exists: u32,
    pub unseen: u32,
}

/// A message in the source's own terms. The engine maps this to threads + messages +
/// message_bodies via db::messages::apply_folder_delta (Task 8).
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct RemoteMessage {
    pub uid: u32,
    pub folder: String,
    pub message_id: Option<String>,
    pub in_reply_to: Option<String>,
    pub references: Option<String>,
    pub from_address: Option<String>,
    pub from_name: Option<String>,
    pub to_addresses: Option<String>,
    pub cc_addresses: Option<String>,
    pub bcc_addresses: Option<String>,
    pub reply_to: Option<String>,
    pub subject: Option<String>,
    pub snippet: Option<String>,
    pub date: i64,
    pub is_read: bool,
    pub is_starred: bool,
    pub is_draft: bool,
    pub body_html: Option<String>,
    pub body_text: Option<String>,
    pub raw_size: u32,
    pub list_unsubscribe: Option<String>,
    pub list_unsubscribe_post: Option<String>,
    pub auth_results: Option<String>,
    pub has_attachments: bool,
}

/// A CONDSTORE flag-only delta: the server reported a FLAGS change for `uid` since the
/// last modseq. Carries just is_read/is_starred (the flags the UI tracks). The engine
/// applies this via `apply_flag_updates`, which MUST NOT touch the cached envelope
/// (subject/from/body) — unlike a full `RemoteMessage` upsert.
#[derive(Debug, Clone, Serialize, Deserialize, Default, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct FlagUpdate {
    pub uid: u32,
    pub is_read: bool,
    pub is_starred: bool,
}

/// Result of one folder delta sync. The engine applies `added`/`updated`, processes
/// `vanished_uids`, and persists `next_cursor`. `uidvalidity_changed` signals a cache
/// wipe is required before applying (IMAP UIDVALIDITY changed).
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct FolderDelta {
    pub added: Vec<RemoteMessage>,
    pub updated: Vec<RemoteMessage>,
    pub flag_updates: Vec<FlagUpdate>,
    pub vanished_uids: Vec<u32>,
    pub next_cursor: Cursor,
    pub uidvalidity_changed: bool,
}

#[derive(Debug, thiserror::Error)]
pub enum SourceError {
    #[error("operation not supported by this source")]
    Unsupported,
    /// Provider returned a throttle response (HTTP 429 / 503 with Retry-After,
    /// or an EAS status indicating backoff). `retry_after` is epoch-seconds.
    /// The engine records it via `db::rate_limit::set_rate_limit` so the next
    /// round short-circuits until the window passes.
    #[error("source rate-limited; retry after epoch {retry_after}")]
    RateLimited { retry_after: i64 },
    #[error("{0}")]
    Other(String),
}

/// The provider abstraction. Adapters wrap the existing protocol clients (`async-imap`
/// for ImapSource, the EAS client for EasSource). The optional real-time methods
/// (`watch`/`ping`) default to Unsupported and are only called when capabilities()
/// advertises them.
#[async_trait]
pub trait MailSource: Send + Sync {
    fn capabilities(&self) -> Capabilities;

    async fn list_folders(&self) -> Result<Vec<RemoteFolder>, SourceError>;
    async fn sync_folder(
        &self,
        folder: &RemoteFolder,
        since: Cursor,
    ) -> Result<FolderDelta, SourceError>;
    async fn fetch_body(
        &self,
        folder: &RemoteFolder,
        uid: u32,
    ) -> Result<Option<String>, SourceError>;

    // Mutations — also routable through the offline queue (Phase 1).
    async fn set_flags(
        &self,
        folder: &RemoteFolder,
        uids: &[u32],
        flag: &str,
        add: bool,
    ) -> Result<(), SourceError>;
    async fn move_messages(
        &self,
        src: &RemoteFolder,
        uids: &[u32],
        dest: &RemoteFolder,
    ) -> Result<(), SourceError>;
    async fn delete_messages(&self, folder: &RemoteFolder, uids: &[u32])
        -> Result<(), SourceError>;
    async fn append(
        &self,
        folder: &RemoteFolder,
        raw: &[u8],
        flags: &[&str],
    ) -> Result<(), SourceError>;
    async fn send(&self, raw_base64url: &str) -> Result<(), SourceError>;

    /// Load this source's persisted per-folder cursor. Each source owns its cursor
    /// payload and its own persistence table (IMAP: `folder_sync_state`; EAS:
    /// `eas_sync_state`). The engine calls this before `sync_folder` so the source
    /// resumes from its real cursor instead of a wrong-type default (the bug this
    /// fixes: EAS was being handed an `Cursor::Imap` and re-bootstrapping every
    /// round). Default = `Cursor::default()` so mock/test sources need no change.
    async fn load_cursor(
        &self,
        _pool: &sqlx::SqlitePool,
        _account_id: &str,
        _folder_path: &str,
    ) -> Cursor {
        Cursor::default()
    }

    /// Resolve the source's connection config for a given folder, used by
    /// `request_bodies_inner` to issue ONE batched `fetch_bodies_batch` per
    /// folder instead of N per-UID connects. Returns `Ok(None)` for non-IMAP
    /// sources (EAS today); the caller then falls back to the per-message
    /// `fetch_body` path. Default = `Ok(None)` so mock/test sources and EAS
    /// need no change — only `ImapSource` overrides this.
    ///
    /// Returns `ImapConfig` by value (not `Arc<ImapConfig>`) to keep the
    /// trait's async-future `Send` bounds simple: the config is small (~6
    /// strings + a bool) and `fetch_bodies_batch` borrows it for the call
    /// only.
    async fn imap_config_for_folder(
        &self,
        _folder: &str,
    ) -> Result<Option<crate::mail::imap::types::ImapConfig>, SourceError> {
        Ok(None)
    }

    // Optional real-time (Phase 2). Default = Unsupported.
    async fn watch(&self, _folder: &RemoteFolder) -> Result<(), SourceError> {
        Err(SourceError::Unsupported)
    }
    async fn ping(&self, _collections: &[(&str, &str)]) -> Result<(), SourceError> {
        Err(SourceError::Unsupported)
    }
}

/// Factory: load the (decrypted) account and return the matching source adapter.
/// The SyncEngine uses this to construct one worker per account.
///
/// `manager` is threaded through so ImapSource can use the persistent session
/// instead of connect-per-call (the swap itself is Task 4 — Task 3 only wires
/// the handle through). EasSource ignores it (EAS uses HTTP, no long-lived
/// socket to manage this way today).
pub async fn source_for_account(
    pool: &SqlitePool,
    account_id: &str,
    manager: &std::sync::Arc<crate::mail::imap::session_manager::ImapSessionManager>,
) -> Result<Arc<dyn MailSource>, String> {
    let acc = crate::db::accounts::get_by_id(pool, account_id)
        .await?
        .ok_or_else(|| format!("account {account_id} not found"))?;
    Ok(match acc.provider.as_str() {
        "imap" => Arc::new(imap_source::ImapSource::new(
            acc,
            pool.clone(),
            std::sync::Arc::clone(manager),
        )),
        "eas" => Arc::new(eas_source::EasSource::new(acc, pool.clone())),
        other => return Err(format!("unsupported provider {other}")),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::accounts::{create, CreateAccountInput};
    use crate::db::init_db;

    #[tokio::test]
    async fn mock_source_drains_messages_then_empty() {
        let folder = RemoteFolder {
            remote_id: "INBOX".into(),
            name: "INBOX".into(),
            delimiter: "/".into(),
            special_use: None,
            role: Some("inbox".into()),
            parent_id: None,
            exists: 2,
            unseen: 2,
        };
        let msgs = vec![
            RemoteMessage {
                uid: 1,
                folder: "INBOX".into(),
                date: 100,
                ..Default::default()
            },
            RemoteMessage {
                uid: 2,
                folder: "INBOX".into(),
                date: 200,
                ..Default::default()
            },
        ];
        let src = mock_source::MockSource::new(vec![folder.clone()], msgs);
        let d1 = src
            .sync_folder(&folder, Cursor::initial_imap())
            .await
            .unwrap();
        assert_eq!(d1.added.len(), 2);
        assert_eq!(
            d1.next_cursor,
            Cursor::Imap {
                uidvalidity: 0,
                highest_uid: 2,
                highest_modseq: 0
            }
        );
        // Second sync from the advanced cursor yields nothing new.
        let d2 = src
            .sync_folder(&folder, d1.next_cursor.clone())
            .await
            .unwrap();
        assert!(d2.added.is_empty());
    }

    #[tokio::test]
    async fn factory_returns_source_for_imap_account() {
        let tmp = tempfile::tempdir().unwrap();
        let pool = init_db(tmp.path()).await.unwrap();
        let acc = create(
            &pool,
            CreateAccountInput {
                email: "im@x.com".into(),
                provider: "imap".into(),
                ..Default::default()
            },
        )
        .await
        .unwrap();
        let manager = Arc::new(
            crate::mail::imap::session_manager::ImapSessionManager::new(),
        );
        let src = source_for_account(&pool, &acc.id, &manager).await.unwrap();
        // Stub ImapSource advertises default (empty) capabilities until Task 7.
        assert_eq!(src.capabilities(), Capabilities::default());
    }

    #[tokio::test]
    async fn factory_rejects_unknown_provider() {
        let tmp = tempfile::tempdir().unwrap();
        let pool = init_db(tmp.path()).await.unwrap();
        let acc = create(
            &pool,
            CreateAccountInput {
                email: "weird@x.com".into(),
                provider: "carrier-pigeon".into(),
                ..Default::default()
            },
        )
        .await
        .unwrap();
        let manager = Arc::new(
            crate::mail::imap::session_manager::ImapSessionManager::new(),
        );
        let res = source_for_account(&pool, &acc.id, &manager).await;
        assert!(res.is_err());
        assert!(res.err().unwrap().contains("unsupported provider"));
    }
}
