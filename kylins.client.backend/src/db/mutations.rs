//! Mail mutation operations — the contract for every mail write that needs to
//! be applied both optimistically (local DB) and remotely (IMAP/SMTP/Gmail).
//!
//! Each variant of [`MutationOp`] carries the data required to (a) run the
//! optimistic local write via [`MutationOp::local_writes`], and (b) encode a
//! per-message params row for the offline queue via
//! [`MutationOp::encode_params`]. The frontend serializes a `MutationOp` to
//! JSON with `{ "type": "markRead", "threadId": ..., "messageIds": ... }`.
//!
//! **Serde note:** the container-level `#[serde(rename_all = "camelCase")]`
//! renames the **variant names** used as the `type` tag (`MarkRead` →
//! `markRead`). It does NOT cascade into each variant's struct fields with
//! the internally-tagged representation, so each variant carries its own
//! `#[serde(rename_all = "camelCase")]` to rename fields (`thread_id` →
//! `threadId`, etc.). This is verified by the round-trip test
//! `serde_uses_type_tag_and_camel_case`.
//!
//! ## The `read` field contract
//!
//! [`MutationOp::encode_params`] MUST emit a top-level `read` integer (0/1) for
//! both `MarkRead` and `SetFlag` — this is what `queue::compact_queue` cancels
//! on via `json_extract(params, '$.read')`. The two operations are treated
//! uniformly so a toggle pair (`add=true` then `add=false`, or
//! `read=true` then `read=false`) on the same `resource_id` annihilates
//! regardless of op type.

use serde::{Deserialize, Serialize};
use sqlx::SqlitePool;

/// One mail mutation. Variants cover the five operations the mail sync engine
/// performs: marking a thread read/unread, toggling an IMAP flag (currently
/// only `\Flagged` is reflected into `messages.is_starred`), moving messages
/// between folders/labels, deleting messages, and sending a new message.
///
/// Field names use snake_case in Rust; serde rewrites them to camelCase on the
/// wire so the frontend `MutationOp` TS type matches exactly
/// (`threadId`, `messageIds`, `folderPath`, …).
#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum MutationOp {
    /// Mark an entire thread (and its messages) read or unread.
    #[serde(rename_all = "camelCase")]
    MarkRead {
        thread_id: String,
        message_ids: Vec<String>,
        folder_path: String,
        uids: Vec<u32>,
        read: bool,
    },
    /// Add or remove an IMAP flag on a set of messages. Only `\Flagged` is
    /// reflected into the local `messages.is_starred` column; other flags are
    /// encoded for remote replay but do not have a local column to update.
    #[serde(rename_all = "camelCase")]
    SetFlag {
        message_ids: Vec<String>,
        folder_path: String,
        uids: Vec<u32>,
        flag: String,
        add: bool,
    },
    /// Move a set of messages from one folder/label to another. Local-apply
    /// re-points the `thread_labels` row from `src_label` to `dst_label`.
    #[serde(rename_all = "camelCase")]
    Move {
        message_ids: Vec<String>,
        src_label: String,
        dst_label: String,
        src_folder_path: String,
        dst_folder_path: String,
        uids: Vec<u32>,
    },
    /// Delete a set of messages. Local-apply removes the messages and any
    /// threads left orphaned (no remaining messages).
    #[serde(rename_all = "camelCase")]
    Delete {
        message_ids: Vec<String>,
        folder_path: String,
        uids: Vec<u32>,
    },
    /// Send a new message. Local-apply is a no-op (the message has no row yet);
    /// the encoded `rawBase64url` is what the SMTP worker transmits.
    #[serde(rename_all = "camelCase")]
    Send { raw_base64url: String },
}

impl MutationOp {
    /// The operation type tag stored in `pending_operations.operation_type`.
    /// Matches the lowercase strings `queue::compact_queue` keys on.
    pub fn op_type(&self) -> &'static str {
        match self {
            MutationOp::MarkRead { .. } => "markRead",
            MutationOp::SetFlag { .. } => "setFlag",
            MutationOp::Move { .. } => "move",
            MutationOp::Delete { .. } => "delete",
            MutationOp::Send { .. } => "send",
        }
    }

    /// Encode the per-message params row for `compact_queue` + replay. Always
    /// includes a top-level `read` integer (0/1) for `MarkRead` (from `read`)
    /// and `SetFlag` (from `add`) so `compact_queue`'s JSON-extract is uniform
    /// across the two toggle op types. The `_message_id` argument is reserved
    /// for future per-message scoping; current params are uniform across the
    /// batch (the resource_id column already scopes per-message).
    pub fn encode_params(&self, _message_id: &str) -> String {
        match self {
            MutationOp::MarkRead {
                folder_path,
                uids,
                read,
                ..
            } => serde_json::json!({
                "folderPath": folder_path,
                "read": if *read { 1 } else { 0 },
                "uids": uids,
            })
            .to_string(),
            MutationOp::SetFlag {
                folder_path,
                uids,
                flag,
                add,
                ..
            } => serde_json::json!({
                "folderPath": folder_path,
                "flag": flag,
                "read": if *add { 1 } else { 0 }, // uniform w/ markRead for compact_queue
                "add": *add,
                "uids": uids,
            })
            .to_string(),
            MutationOp::Move {
                src_folder_path,
                dst_folder_path,
                dst_label,
                uids,
                ..
            } => serde_json::json!({
                "srcFolderPath": src_folder_path,
                "dstFolderPath": dst_folder_path,
                "dstLabel": dst_label,
                "uids": uids,
            })
            .to_string(),
            MutationOp::Delete {
                folder_path,
                uids,
                ..
            } => serde_json::json!({
                "folderPath": folder_path,
                "uids": uids,
            })
            .to_string(),
            MutationOp::Send { raw_base64url } => {
                serde_json::json!({ "rawBase64url": raw_base64url }).to_string()
            }
        }
    }

    /// The per-message resource id this mutation targets. Used by the Task 3
    /// command to fan out one `pending_operations` row per affected message
    /// (`resource_id = message_id`) so per-message locking and compact_queue
    /// cancellation work correctly. For `Send`, there is no message id yet —
    /// return empty (the command enqueues a single row keyed by a generated
    /// draft id instead).
    pub fn resource_id(&self) -> String {
        match self {
            MutationOp::MarkRead { thread_id, .. } => thread_id.clone(),
            MutationOp::SetFlag { message_ids, .. }
            | MutationOp::Move { message_ids, .. }
            | MutationOp::Delete { message_ids, .. } => message_ids.join(","),
            MutationOp::Send { .. } => String::new(),
        }
    }

    /// Apply the optimistic local DB write. Returns the affected `message_ids`
    /// (for enqueue + `sync:delta`). For `MarkRead`/`SetFlag`/`Move`/`Delete`
    /// this is the input `message_ids`; for `Send` an empty vec.
    ///
    /// All writes run in ONE transaction. Errors roll back automatically
    /// (the `sqlx::Transaction` is dropped on `?`).
    pub async fn local_writes(
        &self,
        pool: &SqlitePool,
        account_id: &str,
    ) -> Result<Vec<String>, String> {
        let mut tx = pool.begin().await.map_err(|e| e.to_string())?;
        let affected: Vec<String> = match self {
            MutationOp::MarkRead {
                thread_id,
                message_ids,
                read,
                ..
            } => {
                let r: i64 = if *read { 1 } else { 0 };
                sqlx::query("UPDATE threads SET is_read = ? WHERE account_id = ? AND id = ?")
                    .bind(r)
                    .bind(account_id)
                    .bind(thread_id)
                    .execute(&mut *tx)
                    .await
                    .map_err(|e| e.to_string())?;
                sqlx::query("UPDATE messages SET is_read = ? WHERE account_id = ? AND thread_id = ?")
                    .bind(r)
                    .bind(account_id)
                    .bind(thread_id)
                    .execute(&mut *tx)
                    .await
                    .map_err(|e| e.to_string())?;
                message_ids.clone()
            }
            MutationOp::SetFlag {
                message_ids,
                add,
                flag,
                ..
            } => {
                // Only \Flagged has a local column (is_starred). Other flags
                // are encoded for remote replay only.
                let starred = (flag == "\\Flagged") && *add;
                let v: i64 = if starred { 1 } else { 0 };
                for mid in message_ids {
                    sqlx::query(
                        "UPDATE messages SET is_starred = ? WHERE account_id = ? AND id = ?",
                    )
                    .bind(v)
                    .bind(account_id)
                    .bind(mid)
                    .execute(&mut *tx)
                    .await
                    .map_err(|e| e.to_string())?;
                }
                message_ids.clone()
            }
            MutationOp::Move {
                message_ids,
                src_label,
                dst_label,
                ..
            } => {
                for mid in message_ids {
                    // Remove the src label from this message's thread.
                    sqlx::query(
                        "DELETE FROM thread_labels
                         WHERE account_id = ? AND label_id = ?
                           AND thread_id IN (
                             SELECT thread_id FROM messages
                             WHERE account_id = ? AND id = ?
                           )",
                    )
                    .bind(account_id)
                    .bind(src_label)
                    .bind(account_id)
                    .bind(mid)
                    .execute(&mut *tx)
                    .await
                    .map_err(|e| e.to_string())?;
                    // Insert the dst label on this message's thread (ignore dup).
                    sqlx::query(
                        "INSERT INTO thread_labels (thread_id, account_id, label_id)
                         SELECT thread_id, ?, ? FROM messages
                         WHERE account_id = ? AND id = ?
                         ON CONFLICT DO NOTHING",
                    )
                    .bind(account_id)
                    .bind(dst_label)
                    .bind(account_id)
                    .bind(mid)
                    .execute(&mut *tx)
                    .await
                    .map_err(|e| e.to_string())?;
                }
                message_ids.clone()
            }
            MutationOp::Delete { message_ids, .. } => {
                for mid in message_ids {
                    sqlx::query("DELETE FROM messages WHERE account_id = ? AND id = ?")
                        .bind(account_id)
                        .bind(mid)
                        .execute(&mut *tx)
                        .await
                        .map_err(|e| e.to_string())?;
                }
                // Sweep orphan threads (threads with no remaining messages).
                // The thread_labels FK ON DELETE CASCADE already removed label
                // rows for the deleted threads.
                sqlx::query(
                    "DELETE FROM threads
                     WHERE account_id = ?
                       AND id NOT IN (
                         SELECT thread_id FROM messages WHERE account_id = ?
                       )",
                )
                .bind(account_id)
                .bind(account_id)
                .execute(&mut *tx)
                .await
                .map_err(|e| e.to_string())?;
                message_ids.clone()
            }
            MutationOp::Send { .. } => vec![],
        };
        tx.commit().await.map_err(|e| e.to_string())?;
        Ok(affected)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Insert a bare account row directly (no crypto), so messages/threads
    /// have a parent account_id without depending on the keyring. Matches the
    /// pattern in `db::queue::tests::seed_account`.
    async fn seed_account(pool: &SqlitePool, id: &str) {
        sqlx::query(
            "INSERT INTO accounts (id, email, provider, is_active, is_default, sort_order, created_at, updated_at)
             VALUES (?, ?, 'imap', 1, 0, 0, strftime('%s','now'), strftime('%s','now'))",
        )
        .bind(id)
        .bind(format!("{id}@x.com"))
        .execute(pool)
        .await
        .unwrap();
    }

    /// Insert a thread + a set of messages under it. Returns the thread id.
    /// Message ids follow the synthetic `imap-{account}-{folder}-{uid}` form.
    async fn seed_thread_with_messages(
        pool: &SqlitePool,
        account_id: &str,
        thread_id: &str,
        folder: &str,
        uids: &[u32],
    ) {
        sqlx::query(
            "INSERT INTO threads (id, account_id, subject, is_read, is_starred)
             VALUES (?, ?, 'test', 0, 0)",
        )
        .bind(thread_id)
        .bind(account_id)
        .execute(pool)
        .await
        .unwrap();
        for (i, uid) in uids.iter().enumerate() {
            let mid = format!("imap-{account_id}-{folder}-{uid}");
            sqlx::query(
                "INSERT INTO messages
                 (id, account_id, thread_id, subject, date, is_read, is_starred, imap_uid, imap_folder)
                 VALUES (?, ?, ?, 'm', ?, 0, 0, ?, ?)",
            )
            .bind(&mid)
            .bind(account_id)
            .bind(thread_id)
            .bind(1000 + i as i64)
            .bind(*uid as i64)
            .bind(folder)
            .execute(pool)
            .await
            .unwrap();
        }
    }

    fn msg_id(account_id: &str, folder: &str, uid: u32) -> String {
        format!("imap-{account_id}-{folder}-{uid}")
    }

    // ---- op_type / encode_params / resource_id ----

    #[test]
    fn op_type_matches_compact_queue_strings() {
        assert_eq!(
            MutationOp::MarkRead {
                thread_id: "t".into(),
                message_ids: vec![],
                folder_path: "INBOX".into(),
                uids: vec![],
                read: true,
            }
            .op_type(),
            "markRead"
        );
        assert_eq!(
            MutationOp::SetFlag {
                message_ids: vec![],
                folder_path: "INBOX".into(),
                uids: vec![],
                flag: "\\Flagged".into(),
                add: true,
            }
            .op_type(),
            "setFlag"
        );
        assert_eq!(
            MutationOp::Move {
                message_ids: vec![],
                src_label: "s".into(),
                dst_label: "d".into(),
                src_folder_path: "a".into(),
                dst_folder_path: "b".into(),
                uids: vec![],
            }
            .op_type(),
            "move"
        );
        assert_eq!(
            MutationOp::Delete {
                message_ids: vec![],
                folder_path: "INBOX".into(),
                uids: vec![],
            }
            .op_type(),
            "delete"
        );
        assert_eq!(
            MutationOp::Send {
                raw_base64url: "x".into()
            }
            .op_type(),
            "send"
        );
    }

    #[test]
    fn encode_params_markread_has_read_1_or_0() {
        let on = MutationOp::MarkRead {
            thread_id: "t".into(),
            message_ids: vec!["m1".into()],
            folder_path: "INBOX".into(),
            uids: vec![7],
            read: true,
        };
        let off = MutationOp::MarkRead {
            thread_id: "t".into(),
            message_ids: vec!["m1".into()],
            folder_path: "INBOX".into(),
            uids: vec![7],
            read: false,
        };
        let on_json: serde_json::Value = serde_json::from_str(&on.encode_params("m1")).unwrap();
        let off_json: serde_json::Value = serde_json::from_str(&off.encode_params("m1")).unwrap();
        assert_eq!(on_json["read"], 1);
        assert_eq!(off_json["read"], 0);
        assert_eq!(on_json["folderPath"], "INBOX");
        assert_eq!(on_json["uids"][0], 7);
    }

    #[test]
    fn encode_params_setflag_has_read_from_add_for_compact_queue() {
        // compact_queue keys cancel-out pairs on json_extract(params, '$.read').
        // setFlag MUST expose `read` derived from `add` so an add=true /
        // add=false pair on the same resource annihilates.
        let add = MutationOp::SetFlag {
            message_ids: vec!["m1".into()],
            folder_path: "INBOX".into(),
            uids: vec![7],
            flag: "\\Flagged".into(),
            add: true,
        };
        let remove = MutationOp::SetFlag {
            message_ids: vec!["m1".into()],
            folder_path: "INBOX".into(),
            uids: vec![7],
            flag: "\\Flagged".into(),
            add: false,
        };
        let add_json: serde_json::Value = serde_json::from_str(&add.encode_params("m1")).unwrap();
        let rm_json: serde_json::Value =
            serde_json::from_str(&remove.encode_params("m1")).unwrap();
        assert_eq!(add_json["read"], 1, "add=true must encode read=1");
        assert_eq!(rm_json["read"], 0, "add=false must encode read=0");
        assert_eq!(add_json["flag"], "\\Flagged");
        assert_eq!(add_json["add"], true);
    }

    #[test]
    fn encode_params_move_and_delete_and_send() {
        let mv = MutationOp::Move {
            message_ids: vec![],
            src_label: "s".into(),
            dst_label: "d".into(),
            src_folder_path: "src".into(),
            dst_folder_path: "dst".into(),
            uids: vec![1, 2],
        };
        let mv_json: serde_json::Value = serde_json::from_str(&mv.encode_params("m")).unwrap();
        assert_eq!(mv_json["srcFolderPath"], "src");
        assert_eq!(mv_json["dstFolderPath"], "dst");
        assert_eq!(mv_json["dstLabel"], "d");

        let del = MutationOp::Delete {
            message_ids: vec![],
            folder_path: "INBOX".into(),
            uids: vec![5],
        };
        let del_json: serde_json::Value = serde_json::from_str(&del.encode_params("m")).unwrap();
        assert_eq!(del_json["folderPath"], "INBOX");
        assert_eq!(del_json["uids"][0], 5);

        let send = MutationOp::Send {
            raw_base64url: "abc".into(),
        };
        let send_json: serde_json::Value = serde_json::from_str(&send.encode_params("m")).unwrap();
        assert_eq!(send_json["rawBase64url"], "abc");
    }

    #[test]
    fn resource_id_returns_thread_for_markread_empty_for_send() {
        let mr = MutationOp::MarkRead {
            thread_id: "thr-1".into(),
            message_ids: vec![],
            folder_path: "INBOX".into(),
            uids: vec![],
            read: true,
        };
        assert_eq!(mr.resource_id(), "thr-1");

        let send = MutationOp::Send {
            raw_base64url: "x".into(),
        };
        assert_eq!(send.resource_id(), "");

        // setFlag/move/delete join message_ids.
        let sf = MutationOp::SetFlag {
            message_ids: vec!["m1".into(), "m2".into()],
            folder_path: "INBOX".into(),
            uids: vec![],
            flag: "\\Flagged".into(),
            add: true,
        };
        assert_eq!(sf.resource_id(), "m1,m2");
    }

    #[test]
    fn serde_uses_type_tag_and_camel_case() {
        // Round-trip a MarkRead through JSON and confirm the wire shape matches
        // what the frontend sends: `{ "type": "markRead", "threadId": ... }`.
        let json = r#"{
            "type": "markRead",
            "threadId": "t1",
            "messageIds": ["m1", "m2"],
            "folderPath": "INBOX",
            "uids": [5, 6],
            "read": true
        }"#;
        let op: MutationOp = serde_json::from_str(json).unwrap();
        match op {
            MutationOp::MarkRead {
                thread_id,
                message_ids,
                folder_path,
                uids,
                read,
            } => {
                assert_eq!(thread_id, "t1");
                assert_eq!(message_ids, vec!["m1", "m2"]);
                assert_eq!(folder_path, "INBOX");
                assert_eq!(uids, vec![5, 6]);
                assert!(read);
            }
            _ => panic!("expected MarkRead"),
        }
    }

    // ---- local_writes: real-DB state assertions ----

    #[tokio::test]
    async fn local_writes_markread_true_sets_thread_and_messages_read() {
        let tmp = tempfile::tempdir().unwrap();
        let pool = crate::db::init_db(tmp.path()).await.unwrap();
        seed_account(&pool, "acct").await;
        seed_thread_with_messages(&pool, "acct", "thr", "INBOX", &[10, 11]).await;

        let op = MutationOp::MarkRead {
            thread_id: "thr".into(),
            message_ids: vec![msg_id("acct", "INBOX", 10), msg_id("acct", "INBOX", 11)],
            folder_path: "INBOX".into(),
            uids: vec![10, 11],
            read: true,
        };
        let affected = op.local_writes(&pool, "acct").await.unwrap();
        assert_eq!(affected.len(), 2);

        let (tr,): (i64,) = sqlx::query_as("SELECT is_read FROM threads WHERE account_id='acct' AND id='thr'")
            .fetch_one(&pool)
            .await
            .unwrap();
        assert_eq!(tr, 1, "thread is_read=1 after markRead true");

        let (mr,): (i64,) = sqlx::query_as(
            "SELECT COUNT(*) FROM messages WHERE account_id='acct' AND thread_id='thr' AND is_read=1",
        )
        .fetch_one(&pool)
        .await
        .unwrap();
        assert_eq!(mr, 2, "both messages is_read=1");
    }

    #[tokio::test]
    async fn local_writes_markread_false_clears_read() {
        let tmp = tempfile::tempdir().unwrap();
        let pool = crate::db::init_db(tmp.path()).await.unwrap();
        seed_account(&pool, "acct").await;
        seed_thread_with_messages(&pool, "acct", "thr", "INBOX", &[10]).await;
        // Pre-set is_read=1.
        sqlx::query("UPDATE threads SET is_read=1 WHERE account_id='acct' AND id='thr'")
            .execute(&pool)
            .await
            .unwrap();
        sqlx::query("UPDATE messages SET is_read=1 WHERE account_id='acct' AND thread_id='thr'")
            .execute(&pool)
            .await
            .unwrap();

        let op = MutationOp::MarkRead {
            thread_id: "thr".into(),
            message_ids: vec![msg_id("acct", "INBOX", 10)],
            folder_path: "INBOX".into(),
            uids: vec![10],
            read: false,
        };
        op.local_writes(&pool, "acct").await.unwrap();

        let (tr,): (i64,) = sqlx::query_as("SELECT is_read FROM threads WHERE account_id='acct' AND id='thr'")
            .fetch_one(&pool)
            .await
            .unwrap();
        assert_eq!(tr, 0);
        let (mr,): (i64,) = sqlx::query_as(
            "SELECT is_read FROM messages WHERE account_id='acct' AND id=?",
        )
        .bind(msg_id("acct", "INBOX", 10))
        .fetch_one(&pool)
        .await
        .unwrap();
        assert_eq!(mr, 0);
    }

    #[tokio::test]
    async fn local_writes_setflag_flagged_add_true_sets_is_starred() {
        let tmp = tempfile::tempdir().unwrap();
        let pool = crate::db::init_db(tmp.path()).await.unwrap();
        seed_account(&pool, "acct").await;
        seed_thread_with_messages(&pool, "acct", "thr", "INBOX", &[10, 11]).await;
        let mids = vec![msg_id("acct", "INBOX", 10), msg_id("acct", "INBOX", 11)];

        let op = MutationOp::SetFlag {
            message_ids: mids.clone(),
            folder_path: "INBOX".into(),
            uids: vec![10, 11],
            flag: "\\Flagged".into(),
            add: true,
        };
        op.local_writes(&pool, "acct").await.unwrap();

        let (n,): (i64,) = sqlx::query_as(
            "SELECT COUNT(*) FROM messages WHERE account_id='acct' AND id IN (?,?) AND is_starred=1",
        )
        .bind(&mids[0])
        .bind(&mids[1])
        .fetch_one(&pool)
        .await
        .unwrap();
        assert_eq!(n, 2, "both messages starred");
    }

    #[tokio::test]
    async fn local_writes_setflag_remove_clears_is_starred() {
        let tmp = tempfile::tempdir().unwrap();
        let pool = crate::db::init_db(tmp.path()).await.unwrap();
        seed_account(&pool, "acct").await;
        seed_thread_with_messages(&pool, "acct", "thr", "INBOX", &[10]).await;
        sqlx::query("UPDATE messages SET is_starred=1 WHERE account_id='acct' AND id=?")
            .bind(msg_id("acct", "INBOX", 10))
            .execute(&pool)
            .await
            .unwrap();

        let op = MutationOp::SetFlag {
            message_ids: vec![msg_id("acct", "INBOX", 10)],
            folder_path: "INBOX".into(),
            uids: vec![10],
            flag: "\\Flagged".into(),
            add: false,
        };
        op.local_writes(&pool, "acct").await.unwrap();

        let (s,): (i64,) = sqlx::query_as("SELECT is_starred FROM messages WHERE account_id='acct' AND id=?")
            .bind(msg_id("acct", "INBOX", 10))
            .fetch_one(&pool)
            .await
            .unwrap();
        assert_eq!(s, 0);
    }

    #[tokio::test]
    async fn local_writes_move_repoints_thread_label_src_to_dst() {
        let tmp = tempfile::tempdir().unwrap();
        let pool = crate::db::init_db(tmp.path()).await.unwrap();
        seed_account(&pool, "acct").await;
        seed_thread_with_messages(&pool, "acct", "thr", "INBOX", &[10]).await;
        // Plant a src label row on the thread.
        sqlx::query(
            "INSERT INTO thread_labels (thread_id, account_id, label_id) VALUES ('thr','acct','INBOX')",
        )
        .execute(&pool)
        .await
        .unwrap();

        let op = MutationOp::Move {
            message_ids: vec![msg_id("acct", "INBOX", 10)],
            src_label: "INBOX".into(),
            dst_label: "Archive".into(),
            src_folder_path: "INBOX".into(),
            dst_folder_path: "Archive".into(),
            uids: vec![10],
        };
        op.local_writes(&pool, "acct").await.unwrap();

        let (src_n,): (i64,) = sqlx::query_as(
            "SELECT COUNT(*) FROM thread_labels WHERE account_id='acct' AND thread_id='thr' AND label_id='INBOX'",
        )
        .fetch_one(&pool)
        .await
        .unwrap();
        assert_eq!(src_n, 0, "src label row removed");

        let (dst_n,): (i64,) = sqlx::query_as(
            "SELECT COUNT(*) FROM thread_labels WHERE account_id='acct' AND thread_id='thr' AND label_id='Archive'",
        )
        .fetch_one(&pool)
        .await
        .unwrap();
        assert_eq!(dst_n, 1, "dst label row inserted");
    }

    #[tokio::test]
    async fn local_writes_delete_removes_messages_and_orphan_thread() {
        let tmp = tempfile::tempdir().unwrap();
        let pool = crate::db::init_db(tmp.path()).await.unwrap();
        seed_account(&pool, "acct").await;
        seed_thread_with_messages(&pool, "acct", "thr", "INBOX", &[10, 11]).await;

        let op = MutationOp::Delete {
            message_ids: vec![msg_id("acct", "INBOX", 10), msg_id("acct", "INBOX", 11)],
            folder_path: "INBOX".into(),
            uids: vec![10, 11],
        };
        op.local_writes(&pool, "acct").await.unwrap();

        let (mn,): (i64,) = sqlx::query_as("SELECT COUNT(*) FROM messages WHERE account_id='acct' AND thread_id='thr'")
            .fetch_one(&pool)
            .await
            .unwrap();
        assert_eq!(mn, 0, "messages deleted");

        let (tn,): (i64,) = sqlx::query_as("SELECT COUNT(*) FROM threads WHERE account_id='acct' AND id='thr'")
            .fetch_one(&pool)
            .await
            .unwrap();
        assert_eq!(tn, 0, "orphan thread swept");
    }

    #[tokio::test]
    async fn local_writes_delete_keeps_thread_if_other_messages_remain() {
        let tmp = tempfile::tempdir().unwrap();
        let pool = crate::db::init_db(tmp.path()).await.unwrap();
        seed_account(&pool, "acct").await;
        seed_thread_with_messages(&pool, "acct", "thr", "INBOX", &[10, 11, 12]).await;

        // Delete only two of three — thread must survive.
        let op = MutationOp::Delete {
            message_ids: vec![msg_id("acct", "INBOX", 10), msg_id("acct", "INBOX", 11)],
            folder_path: "INBOX".into(),
            uids: vec![10, 11],
        };
        op.local_writes(&pool, "acct").await.unwrap();

        let (tn,): (i64,) = sqlx::query_as("SELECT COUNT(*) FROM threads WHERE account_id='acct' AND id='thr'")
            .fetch_one(&pool)
            .await
            .unwrap();
        assert_eq!(tn, 1, "thread kept when one message remains");
        let (mn,): (i64,) = sqlx::query_as("SELECT COUNT(*) FROM messages WHERE account_id='acct' AND thread_id='thr'")
            .fetch_one(&pool)
            .await
            .unwrap();
        assert_eq!(mn, 1);
    }

    #[tokio::test]
    async fn local_writes_send_is_noop_returns_empty() {
        let tmp = tempfile::tempdir().unwrap();
        let pool = crate::db::init_db(tmp.path()).await.unwrap();
        seed_account(&pool, "acct").await;

        let op = MutationOp::Send {
            raw_base64url: "abc".into(),
        };
        let affected = op.local_writes(&pool, "acct").await.unwrap();
        assert!(affected.is_empty(), "Send affects no messages locally");
    }

    #[tokio::test]
    async fn local_writes_markread_does_not_touch_other_threads() {
        // Cross-account / cross-thread isolation: marking thr-1 must not flip
        // thr-2's read state.
        let tmp = tempfile::tempdir().unwrap();
        let pool = crate::db::init_db(tmp.path()).await.unwrap();
        seed_account(&pool, "acct").await;
        seed_thread_with_messages(&pool, "acct", "thr-1", "INBOX", &[10]).await;
        seed_thread_with_messages(&pool, "acct", "thr-2", "INBOX", &[20]).await;

        let op = MutationOp::MarkRead {
            thread_id: "thr-1".into(),
            message_ids: vec![msg_id("acct", "INBOX", 10)],
            folder_path: "INBOX".into(),
            uids: vec![10],
            read: true,
        };
        op.local_writes(&pool, "acct").await.unwrap();

        let (other,): (i64,) = sqlx::query_as("SELECT is_read FROM threads WHERE account_id='acct' AND id='thr-2'")
            .fetch_one(&pool)
            .await
            .unwrap();
        assert_eq!(other, 0, "thr-2 must remain unread");
    }
}
