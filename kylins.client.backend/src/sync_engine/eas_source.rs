// EasSource — MailSource adapter over the existing EAS (WBXML) client.
//
// STUB: compiles + participates in factory dispatch, methods return "not yet
// implemented". Task 10 fills it in: folder_sync for list_folders, sync(SyncRequest)
// threading the saved sync_key for sync_folder, item_operations/folder_* for mutations,
// send_mail for send. NOTE: the EAS client's sync() currently returns SyncResult::default()
// (WBXML Sync-response parsing is a TODO at eas/client.rs:194-198), so EAS message sync
// is scaffolded-only until that parser lands.

use async_trait::async_trait;

use crate::db::accounts::Account;

use super::{Capabilities, Cursor, FolderDelta, MailSource, RemoteFolder, SourceError};

fn nyi() -> SourceError {
    SourceError::Other("EasSource not yet implemented (Task 10)".into())
}

pub struct EasSource {
    #[allow(dead_code)]
    account: Account,
}

impl EasSource {
    pub fn new(account: Account) -> Self {
        Self { account }
    }
}

#[async_trait]
impl MailSource for EasSource {
    fn capabilities(&self) -> Capabilities {
        Capabilities::default()
    }

    async fn list_folders(&self) -> Result<Vec<RemoteFolder>, SourceError> {
        Err(nyi())
    }
    async fn sync_folder(&self, _folder: &RemoteFolder, _since: Cursor) -> Result<FolderDelta, SourceError> {
        Err(nyi())
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
}
