// Test double for MailSource. Used by sync-engine unit tests (and the SyncEngine tests
// in Task 9) to drive deterministic folder/message deltas without a live IMAP/EAS server.

use async_trait::async_trait;
use std::sync::{Arc, Mutex};

use super::{Capabilities, Cursor, FolderDelta, MailSource, RemoteFolder, RemoteMessage, SourceError};

/// Preload folders + a pool of messages. `sync_folder` drains messages matching the
/// folder whose uid exceeds the cursor's `highest_uid` (IMAP cursor semantics), then
// advances the cursor. Subsequent calls return empty deltas once drained.
pub struct MockSource {
    caps: Capabilities,
    folders: Vec<RemoteFolder>,
    pending: Arc<Mutex<Vec<RemoteMessage>>>,
}

impl MockSource {
    pub fn new(folders: Vec<RemoteFolder>, messages: Vec<RemoteMessage>) -> Self {
        Self {
            caps: Capabilities::default(),
            folders,
            pending: Arc::new(Mutex::new(messages)),
        }
    }

    pub fn with_caps(mut self, caps: Capabilities) -> Self {
        self.caps = caps;
        self
    }
}

#[async_trait]
impl MailSource for MockSource {
    fn capabilities(&self) -> Capabilities {
        self.caps
    }

    async fn list_folders(&self) -> Result<Vec<RemoteFolder>, SourceError> {
        Ok(self.folders.clone())
    }

    async fn sync_folder(
        &self,
        folder: &RemoteFolder,
        since: Cursor,
    ) -> Result<FolderDelta, SourceError> {
        let highest = match &since {
            Cursor::Imap { highest_uid, .. } => *highest_uid,
            _ => 0,
        };
        let uv = match &since {
            Cursor::Imap { uidvalidity, .. } => *uidvalidity,
            _ => 1,
        };
        let mut added = Vec::new();
        let mut pending = self.pending.lock().unwrap();
        pending.retain(|m| {
            if m.folder == folder.remote_id && m.uid > highest {
                added.push(m.clone());
                false
            } else {
                true
            }
        });
        let new_high = added.iter().map(|m| m.uid).max().unwrap_or(highest);
        Ok(FolderDelta {
            added,
            updated: vec![],
            vanished_uids: vec![],
            next_cursor: Cursor::Imap {
                uidvalidity: uv,
                highest_uid: new_high,
                highest_modseq: 0,
            },
            uidvalidity_changed: false,
        })
    }

    async fn fetch_body(&self, _folder: &RemoteFolder, _uid: u32) -> Result<Option<String>, SourceError> {
        Ok(None)
    }
    async fn set_flags(&self, _folder: &RemoteFolder, _uids: &[u32], _flag: &str, _add: bool) -> Result<(), SourceError> {
        Ok(())
    }
    async fn move_messages(&self, _src: &RemoteFolder, _uids: &[u32], _dest: &RemoteFolder) -> Result<(), SourceError> {
        Ok(())
    }
    async fn delete_messages(&self, _folder: &RemoteFolder, _uids: &[u32]) -> Result<(), SourceError> {
        Ok(())
    }
    async fn append(&self, _folder: &RemoteFolder, _raw: &[u8], _flags: &[&str]) -> Result<(), SourceError> {
        Ok(())
    }
    async fn send(&self, _raw_base64url: &str) -> Result<(), SourceError> {
        Ok(())
    }
}
