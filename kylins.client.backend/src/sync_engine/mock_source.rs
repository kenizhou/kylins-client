// Test double for MailSource. Used by sync-engine unit tests (and the SyncEngine tests
// in Task 9) to drive deterministic folder/message deltas without a live IMAP/EAS server.

use async_trait::async_trait;
use std::sync::{Arc, Mutex};

use super::{
    Capabilities, Cursor, FolderDelta, MailSource, RemoteFolder, RemoteMessage, SourceError,
};

/// Recorded call for assertion in tests. Captures enough of the arguments to verify
/// that `exec_via_source` dispatches each `MutationOp` variant to the right method
/// with the right folder/uids/flag.
#[derive(Debug, Clone, PartialEq)]
pub enum RecordedCall {
    SetFlags {
        folder: String,
        uids: Vec<u32>,
        flag: String,
        add: bool,
    },
    Move {
        src: String,
        uids: Vec<u32>,
        dest: String,
    },
    Delete {
        folder: String,
        uids: Vec<u32>,
    },
    Send {
        raw_bytes: Vec<u8>,
    },
    /// IMAP APPEND call recorded by `send_op`'s best-effort Sent-append step (T8).
    /// Captures the folder's `remote_id`, the raw MIME bytes, and the flag list
    /// so tests can assert the append happened with `\Seen` against the Sent
    /// folder.
    Append {
        folder: String,
        raw_bytes: Vec<u8>,
        flags: Vec<String>,
    },
}

/// Preload folders + a pool of messages. `sync_folder` drains messages matching the
/// folder whose uid exceeds the cursor's `highest_uid` (IMAP cursor semantics), then
// advances the cursor. Subsequent calls return empty deltas once drained.
pub struct MockSource {
    caps: Capabilities,
    folders: Vec<RemoteFolder>,
    pending: Arc<Mutex<Vec<RemoteMessage>>>,
    /// Mutation calls recorded in invocation order. Read via `recorded_calls()`.
    calls: Arc<Mutex<Vec<RecordedCall>>>,
    /// When true, `append` returns `SourceError::Other`. Used by T8's
    /// `send_op_append_failure_does_not_fail_op` test to verify the best-effort
    /// invariant: an append failure must NOT fail the op (send already succeeded).
    fail_append: bool,
}

impl MockSource {
    pub fn new(folders: Vec<RemoteFolder>, messages: Vec<RemoteMessage>) -> Self {
        Self {
            caps: Capabilities::default(),
            folders,
            pending: Arc::new(Mutex::new(messages)),
            calls: Arc::new(Mutex::new(vec![])),
            fail_append: false,
        }
    }

    pub fn with_caps(mut self, caps: Capabilities) -> Self {
        self.caps = caps;
        self
    }

    /// Force `append` to return `Err(SourceError::Other(...))` on every call, so
    /// the T8 best-effort invariant ("append failure never fails the op") can be
    /// exercised. Send + other methods are unaffected.
    pub fn with_fail_append(mut self, fail: bool) -> Self {
        self.fail_append = fail;
        self
    }

    /// Snapshot of recorded mutation calls (set_flags / move / delete / send /
    /// append) in the order they were invoked. Used by `exec_via_source` and
    /// `send_op` tests to assert the correct MailSource method was dispatched
    /// with the expected arguments.
    pub fn recorded_calls(&self) -> Vec<RecordedCall> {
        self.calls.lock().unwrap().clone()
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
            flag_updates: vec![],
            vanished_uids: vec![],
            next_cursor: Cursor::Imap {
                uidvalidity: uv,
                highest_uid: new_high,
                highest_modseq: 0,
            },
            uidvalidity_changed: false,
        })
    }

    async fn fetch_body(
        &self,
        _folder: &RemoteFolder,
        _uid: u32,
    ) -> Result<Option<String>, SourceError> {
        Ok(None)
    }
    async fn set_flags(
        &self,
        folder: &RemoteFolder,
        uids: &[u32],
        flag: &str,
        add: bool,
    ) -> Result<(), SourceError> {
        self.calls.lock().unwrap().push(RecordedCall::SetFlags {
            folder: folder.remote_id.clone(),
            uids: uids.to_vec(),
            flag: flag.to_string(),
            add,
        });
        Ok(())
    }
    async fn move_messages(
        &self,
        src: &RemoteFolder,
        uids: &[u32],
        dest: &RemoteFolder,
    ) -> Result<(), SourceError> {
        self.calls.lock().unwrap().push(RecordedCall::Move {
            src: src.remote_id.clone(),
            uids: uids.to_vec(),
            dest: dest.remote_id.clone(),
        });
        Ok(())
    }
    async fn delete_messages(
        &self,
        folder: &RemoteFolder,
        uids: &[u32],
    ) -> Result<(), SourceError> {
        self.calls.lock().unwrap().push(RecordedCall::Delete {
            folder: folder.remote_id.clone(),
            uids: uids.to_vec(),
        });
        Ok(())
    }
    async fn append(
        &self,
        folder: &RemoteFolder,
        raw: &[u8],
        flags: &[&str],
    ) -> Result<(), SourceError> {
        self.calls.lock().unwrap().push(RecordedCall::Append {
            folder: folder.remote_id.clone(),
            raw_bytes: raw.to_vec(),
            flags: flags.iter().map(|s| (*s).to_string()).collect(),
        });
        if self.fail_append {
            Err(SourceError::Other("mock append failure".into()))
        } else {
            Ok(())
        }
    }
    async fn send(&self, raw_mime: &[u8]) -> Result<(), SourceError> {
        self.calls.lock().unwrap().push(RecordedCall::Send {
            raw_bytes: raw_mime.to_vec(),
        });
        Ok(())
    }
}
