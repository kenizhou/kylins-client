// ImapSource — MailSource adapter over the existing async-imap client.
//
// STUB: this file compiles and participates in the factory dispatch, but every method
// returns "not yet implemented". Task 7 fills in the real implementation: own connection
// lifecycle (connect once per operation set), CAPABILITY negotiation, and list_folders /
// sync_folder (via delta_check_folders + fetch_new_uids + fetch_messages) / fetch_body /
// mutations, mapping ImapFolder -> RemoteFolder and ImapMessage -> RemoteMessage.

use async_trait::async_trait;

use crate::db::accounts::Account;

use super::{Capabilities, Cursor, FolderDelta, MailSource, RemoteFolder, SourceError};

fn nyi() -> SourceError {
    SourceError::Other("ImapSource not yet implemented (Task 7)".into())
}

pub struct ImapSource {
    #[allow(dead_code)]
    account: Account,
}

impl ImapSource {
    pub fn new(account: Account) -> Self {
        Self { account }
    }
}

#[async_trait]
impl MailSource for ImapSource {
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
