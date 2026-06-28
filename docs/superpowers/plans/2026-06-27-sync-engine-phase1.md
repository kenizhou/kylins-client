# Kylins Mail Sync Engine — Phase 1 Implementation Plan (Offline Replay)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Route every mail mutation (mark-read, star/flag, move, delete, send) through a durable optimistic pipeline — local DB apply + enqueue → `AccountWorker` replays via the `MailSource` — so mutations survive offline + crash and never get reverted by a concurrent server sync.

**Architecture:** The frontend issues one `sync_apply_mutation` command per action. The engine applies it to the local DB immediately (optimistic), emits `sync:delta`, enqueues a `pending_operations` row, and nudges the worker. The `AccountWorker` replay loop (added alongside the poll loop) drains due ops, `compact_queue`s them, executes each via `MailSource` (`set_flags`/`move_messages`/`delete_messages`/`append`/`send`), and marks completed/failed (exponential backoff). `apply_folder_delta` skips upserting any message that has a pending op (the write-lock), so a server FETCH arriving mid-edit cannot revert a local change. The status bar shows the pending count via `sync:queue`.

**Tech Stack:** Rust (Tauri 2.10, sqlx runtime queries, tokio), the existing `MailSource` trait + `ImapSource`, `db::queue` (`pending_operations`), `SyncEngine`/`AccountWorker`, React 19 + Zustand frontend.

## Global Constraints

- **One pending op per affected message** — `resource_id` = the message's id (for `Send`, `"send:"+uuid`). This makes the write-lock an exact `EXISTS … WHERE resource_id = ?` lookup. `params` is a JSON string.
- **Optimistic order:** local DB write + `sync:delta` emit + enqueue all happen before any network call; the user sees the change instantly.
- **Write-lock:** `apply_folder_delta` MUST NOT upsert a `RemoteMessage` whose `message_id` has a pending op for that account. This is the "24-hr lock" equivalent — it prevents a concurrent server delta from reverting an un-replayed local edit.
- **Backoff is pre-existing:** reuse `db::queue::mark_failed` (`60 * (1 << retry_count)` pre-increment, flips to `'failed'` at `max_retries`). Do NOT reinvent backoff.
- **DTO JSON shape:** all structs crossing to the frontend use `#[serde(rename_all = "camelCase")]`. The `MutationOp` enum uses `#[serde(tag = "type", rename_all = "camelCase")]` so the frontend sends `{ type: "markRead", threadId, messageIds, folderPath, uids, read }` etc.
- **Replay is per-account:** the `AccountWorker` only replays its own account's ops (use the new `dequeue_pending_for_account`).
- **Scope:** Phase 1 only. IMAP IDLE / EAS Ping (Phase 2) and Gmail/Graph (Phase 3) are OUT OF SCOPE.
- **Commit cadence:** one commit per task. Run `cargo test --lib` and the frontend Vitest suite at each task boundary.
- **Existing surface to build on:** `db::queue::{enqueue, dequeue_pending, mark_completed, mark_failed}`, `SyncEngine`/`AccountWorker` (`sync_engine/engine.rs`), `MailSource::{set_flags, move_messages, delete_messages, append, send}` + `ImapSource` impls, `db::messages::apply_folder_delta`, `sync_engine::commands::sync_account_now`, frontend `offlineQueue.ts` (invoke wrapper) + `useSyncEvents`.

---

## File Structure

**Backend (Rust) — new/modified:**
- `src/db/queue.rs` — add `dequeue_pending_for_account` + `pending_count_for_account` + `compact_queue` + `has_pending_for_resource`.
- `src/db/mutations.rs` (NEW) — `MutationOp` enum + `apply_locally` (per-variant local DB writes) + `exec_via_source` (per-variant remote calls) + the op→(type,resource_id,params) encoding.
- `src/sync_engine/engine.rs` — add the replay loop to `AccountWorker` (`SyncOp::Replay`), `run_replay_round`, `sync:queue` emission.
- `src/sync_engine/commands.rs` — `sync_apply_mutation` command (+ register).
- `src/db/mod.rs` — `pub mod mutations;`.
- `src/db/messages.rs` — `apply_folder_delta` write-lock (skip messages with pending ops).
- `src/lib.rs` — register `sync_apply_mutation`.

**Frontend — modified:**
- `src/stores/threadStore.ts` — `selectThread` mark-read → `invoke('sync_apply_mutation', { op })` (optimistic UI stays).
- `src/services/composer/send.ts` (or wherever send is) — send → `invoke('sync_apply_mutation', { op: { type:'send', rawBase64url } })`.
- `src/hooks/useSyncEvents.ts` — `sync:queue` listener → status bar store.
- `src/stores/uiStore.ts` (or a sync-status store) — `pendingCount` + setter for the status bar.
- `tests/**` — mocks updated for the new command + a store test for optimistic mark-read.

---

## Task 1: Per-account queue reads + resource write-lock helper

**Files:**
- Modify: `kylins.client.backend/src/db/queue.rs`
- Test: `db/queue.rs` `#[cfg(test)]`

**Interfaces:**
- Consumes: existing `pending_operations` schema.
- Produces: `dequeue_pending_for_account(pool, account_id, limit) -> Vec<PendingOperation>`, `pending_count_for_account(pool, account_id) -> i64`, `has_pending_for_resource(pool, account_id, resource_id) -> bool`, `compact_queue(pool, account_id)`.

- [ ] **Step 1: Write failing tests** in `db/queue.rs` tests:
  - `dequeue_pending_for_account` returns only that account's due ops (plant ops for two accounts; assert filter).
  - `pending_count_for_account` counts status='pending' rows for the account.
  - `has_pending_for_resource` true when a row exists with that account_id+resource_id, false otherwise.
  - `compact_queue` removes a `markRead(read=true)` + `markRead(read=false)` pair for the same resource_id (cancel-out), and is a no-op when no cancelable pairs.

```rust
#[tokio::test]
async fn dequeue_pending_for_account_filters_by_account() {
    let tmp = tempfile::tempdir().unwrap();
    let pool = crate::db::init_db(tmp.path()).await.unwrap();
    seed_account(&pool, "a1").await;
    seed_account(&pool, "a2").await;
    for (id, acc) in [("o1","a1"),("o2","a1"),("o3","a2")] {
        sqlx::query("INSERT INTO pending_operations (id, account_id, operation_type, resource_id, params, status, created_at) VALUES (?,?,'x','r','{}','pending', 1)")
            .bind(id).bind(acc).execute(&pool).await.unwrap();
    }
    let ops = dequeue_pending_for_account(&pool, "a1", 50).await.unwrap();
    let ids: Vec<&str> = ops.iter().map(|o| o.id.as_str()).collect();
    assert_eq!(ids, vec!["o1", "o2"]);
}

#[tokio::test]
async fn has_pending_for_resource_is_exact() {
    let tmp = tempfile::tempdir().unwrap();
    let pool = crate::db::init_db(tmp.path()).await.unwrap();
    seed_account(&pool, "a1").await;
    assert!(!has_pending_for_resource(&pool, "a1", "msg-1").await);
    sqlx::query("INSERT INTO pending_operations (id, account_id, operation_type, resource_id, params, status, created_at) VALUES ('p','a1','markRead','msg-1','{}','pending',1)")
        .execute(&pool).await.unwrap();
    assert!(has_pending_for_resource(&pool, "a1", "msg-1").await);
    assert!(!has_pending_for_resource(&pool, "a1", "msg-2").await);
}
```

- [ ] **Step 2: Run — expect FAIL** (`dequeue_pending_for_account` etc. undefined).

- [ ] **Step 3: Implement**

```rust
pub async fn dequeue_pending_for_account(
    pool: &SqlitePool,
    account_id: &str,
    limit: i64,
) -> Result<Vec<PendingOperation>, String> {
    let rows = sqlx::query(
        "SELECT * FROM pending_operations
         WHERE account_id = ? AND status = 'pending'
           AND (next_retry_at IS NULL OR next_retry_at <= unixepoch())
         ORDER BY created_at ASC LIMIT ?",
    )
    .bind(account_id)
    .bind(limit)
    .fetch_all(pool)
    .await
    .map_err(|e| e.to_string())?;
    Ok(rows.iter().map(row_to_op).collect())
}

pub async fn pending_count_for_account(pool: &SqlitePool, account_id: &str) -> Result<i64, String> {
    let (n,): (i64,) = sqlx::query_as(
        "SELECT COUNT(*) FROM pending_operations WHERE account_id = ? AND status = 'pending'",
    )
    .bind(account_id)
    .fetch_one(pool)
    .await
    .map_err(|e| e.to_string())?;
    Ok(n)
}

pub async fn has_pending_for_resource(
    pool: &SqlitePool,
    account_id: &str,
    resource_id: &str,
) -> bool {
    let row: Result<(i64,), _> = sqlx::query_as(
        "SELECT COUNT(*) FROM pending_operations
         WHERE account_id = ? AND resource_id = ? AND status = 'pending'",
    )
    .bind(account_id)
    .bind(resource_id)
    .fetch_one(pool)
    .await;
    matches!(row, Ok((n,)) if n > 0)
}
```

`compact_queue` (cancel-out pairs): two ops of the same `operation_type` + same `resource_id` whose params are semantic inverses cancel. For Phase 1, handle the common case: a `setFlag`/`markRead` add=true followed by add=false on the same resource deletes BOTH. Parse `params` JSON minimally.

```rust
pub async fn compact_queue(pool: &SqlitePool, account_id: &str) -> Result<(), String> {
    // Cancel markRead/setFlag toggle pairs on the same resource_id:
    //   (add=true) then (add=false) on the same resource => drop both.
    sqlx::query(
        "DELETE FROM pending_operations
         WHERE id IN (
           SELECT a.id FROM pending_operations a
           JOIN pending_operations b
             ON a.account_id = b.account_id AND a.resource_id = b.resource_id
            AND a.operation_type = b.operation_type AND a.id < b.id
           WHERE a.account_id = ? AND a.status = 'pending' AND b.status = 'pending'
             AND a.operation_type IN ('markRead','setFlag')
             AND json_extract(a.params, '$.read') = 1
             AND json_extract(b.params, '$.read') = 0
         )",
    )
    .bind(account_id)
    .execute(pool)
    .await
    .map_err(|e| e.to_string())?;
    sqlx::query(
        "DELETE FROM pending_operations
         WHERE id IN (
           SELECT b.id FROM pending_operations a
           JOIN pending_operations b
             ON a.account_id = b.account_id AND a.resource_id = b.resource_id
            AND a.operation_type = b.operation_type AND a.id < b.id
           WHERE a.account_id = ? AND a.status = 'pending' AND b.status = 'pending'
             AND a.operation_type IN ('markRead','setFlag')
             AND json_extract(a.params, '$.read') = 1
             AND json_extract(b.params, '$.read') = 0
         )",
    )
    .bind(account_id)
    .execute(pool)
    .await
    .map_err(|e| e.to_string())?;
    Ok(())
}
```
(Both `markRead` and `setFlag` carry the boolean in a `read`/`add` param — the frontend MUST send `read` for markRead and `read` for setFlag's add to keep this query uniform. See Task 3's `MutationOp` encoding. The test seeds `params` with `{"read":1}` / `{"read":0}`.)

- [ ] **Step 4: Run — expect PASS.**
- [ ] **Step 5: Commit** — `feat(db): per-account queue reads + resource write-lock helper + compact_queue`.

---

## Task 2: `MutationOp` enum + local-apply

**Files:**
- Create: `kylins.client.backend/src/db/mutations.rs`
- Modify: `kylins.client.backend/src/db/mod.rs` (`pub mod mutations;`)
- Test: `db/mutations.rs` `#[cfg(test)]`

**Interfaces:**
- Consumes: `SqlitePool`, the `threads`/`messages`/`thread_labels` schema.
- Produces: `MutationOp` (serde enum), `MutationOp::local_writes(&self, pool, account_id) -> Result<Vec<String /*message_ids affected*/>, String>`, `MutationOp::op_type(&self) -> &str`, `MutationOp::encode_params(&self, message_id: &str) -> String`, `MutationOp::resource_id(&self) -> String`.

- [ ] **Step 1: Failing tests** — for each variant, `local_writes` produces the correct DB state:
  - `MarkRead{read:true}` → `threads.is_read=1` + `messages.is_read=1` for the thread.
  - `SetFlag{flag:"\\Flagged", add:true}` → `messages.is_starred=1`.
  - `Move` → `thread_labels` row removed from src label, added to dst label.
  - `Delete` → messages + thread gone.

- [ ] **Step 2: Run — expect FAIL.**

- [ ] **Step 3: Implement** `MutationOp` + `local_writes`:

```rust
use serde::{Deserialize, Serialize};
use sqlx::SqlitePool;

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum MutationOp {
    MarkRead { thread_id: String, message_ids: Vec<String>, folder_path: String, uids: Vec<u32>, read: bool },
    SetFlag { message_ids: Vec<String>, folder_path: String, uids: Vec<u32>, flag: String, add: bool },
    Move { message_ids: Vec<String>, src_label: String, dst_label: String, src_folder_path: String, dst_folder_path: String, uids: Vec<u32> },
    Delete { message_ids: Vec<String>, folder_path: String, uids: Vec<u32> },
    Send { raw_base64url: String },
}

impl MutationOp {
    pub fn op_type(&self) -> &'static str {
        match self {
            MutationOp::MarkRead { .. } => "markRead",
            MutationOp::SetFlag { .. } => "setFlag",
            MutationOp::Move { .. } => "move",
            MutationOp::Delete { .. } => "delete",
            MutationOp::Send { .. } => "send",
        }
    }

    /// Encode the per-message params row for `compact_queue` + replay. Always includes
    /// a `read` boolean (markRead/setFlag) so compact_queue's JSON-extract is uniform.
    pub fn encode_params(&self, _message_id: &str) -> String {
        match self {
            MutationOp::MarkRead { folder_path, uids, read, .. } => serde_json::json!({
                "folderPath": folder_path,
                "read": if *read { 1 } else { 0 },
                "uids": uids,
            }).to_string(),
            MutationOp::SetFlag { folder_path, uids, flag, add, .. } => serde_json::json!({
                "folderPath": folder_path, "flag": flag,
                "read": if *add { 1 } else { 0 }, // uniform w/ markRead for compact_queue
                "add": *add, "uids": uids,
            }).to_string(),
            MutationOp::Move { src_folder_path, dst_folder_path, dst_label, uids, .. } => serde_json::json!({
                "srcFolderPath": src_folder_path, "dstFolderPath": dst_folder_path,
                "dstLabel": dst_label, "uids": uids,
            }).to_string(),
            MutationOp::Delete { folder_path, uids, .. } => serde_json::json!({
                "folderPath": folder_path, "uids": uids,
            }).to_string(),
            MutationOp::Send { raw_base64url } => serde_json::json!({ "rawBase64url": raw_base64url }).to_string(),
        }
    }
}

impl MutationOp {
    /// Apply the optimistic local DB write. Returns the affected message_ids (for
    /// enqueue + sync:delta). For Move/Delete this is `message_ids`; for MarkRead/SetFlag
    /// the message_ids of the thread; for Send an empty vec.
    pub async fn local_writes(&self, pool: &SqlitePool, account_id: &str) -> Result<Vec<String>, String> {
        let mut tx = pool.begin().await.map_err(|e| e.to_string())?;
        let affected: Vec<String> = match self {
            MutationOp::MarkRead { thread_id, message_ids, read, .. } => {
                let r: i64 = if *read { 1 } else { 0 };
                sqlx::query("UPDATE threads SET is_read = ? WHERE account_id = ? AND id = ?").bind(r).bind(account_id).bind(thread_id).execute(&mut *tx).await.map_err(|e| e.to_string())?;
                sqlx::query("UPDATE messages SET is_read = ? WHERE account_id = ? AND thread_id = ?").bind(r).bind(account_id).bind(thread_id).execute(&mut *tx).await.map_err(|e| e.to_string())?;
                message_ids.clone()
            }
            MutationOp::SetFlag { message_ids, add, flag, .. } => {
                let starred = (flag == "\\Flagged") && *add;
                let v: i64 = if starred { 1 } else { 0 };
                for mid in message_ids {
                    sqlx::query("UPDATE messages SET is_starred = ? WHERE account_id = ? AND id = ?").bind(v).bind(account_id).bind(mid).execute(&mut *tx).await.map_err(|e| e.to_string())?;
                }
                message_ids.clone()
            }
            MutationOp::Move { message_ids, src_label, dst_label, .. } => {
                for mid in message_ids {
                    sqlx::query("DELETE FROM thread_labels WHERE account_id = ? AND label_id = ? AND thread_id IN (SELECT thread_id FROM messages WHERE account_id = ? AND id = ?)")
                        .bind(account_id).bind(src_label).bind(account_id).bind(mid).execute(&mut *tx).await.map_err(|e| e.to_string())?;
                    sqlx::query("INSERT INTO thread_labels (thread_id, account_id, label_id) SELECT thread_id, ?, ? FROM messages WHERE account_id = ? AND id = ? ON CONFLICT DO NOTHING")
                        .bind(account_id).bind(dst_label).bind(account_id).bind(mid).execute(&mut *tx).await.map_err(|e| e.to_string())?;
                }
                message_ids.clone()
            }
            MutationOp::Delete { message_ids, .. } => {
                for mid in message_ids {
                    sqlx::query("DELETE FROM messages WHERE account_id = ? AND id = ?").bind(account_id).bind(mid).execute(&mut *tx).await.map_err(|e| e.to_string())?;
                }
                sqlx::query("DELETE FROM threads WHERE account_id = ? AND id NOT IN (SELECT thread_id FROM messages WHERE account_id = ?)").bind(account_id).bind(account_id).execute(&mut *tx).await.map_err(|e| e.to_string())?;
                message_ids.clone()
            }
            MutationOp::Send { .. } => vec![],
        };
        tx.commit().await.map_err(|e| e.to_string())?;
        Ok(affected)
    }
}
```

- [ ] **Step 4: Run — expect PASS.**
- [ ] **Step 5: Commit** — `feat(db): MutationOp + optimistic local-apply`.

---

## Task 3: `exec_via_source` (remote replay) + the apply-and-enqueue command

**Files:**
- Modify: `kylins.client.backend/src/db/mutations.rs` (add `exec_via_source`)
- Modify: `kylins.client.backend/src/sync_engine/commands.rs` (`sync_apply_mutation`)
- Modify: `kylins.client.backend/src/lib.rs` (register)
- Test: `db/mutations.rs` (exec via `MockSource`)

**Interfaces:**
- Consumes: `MailSource`, `db::queue`, `MutationOp::local_writes`.
- Produces: `MutationOp::exec_via_source(&self, src: &dyn MailSource) -> Result<(), SourceError>` (remote call), `sync_apply_mutation` command.

- [ ] **Step 1: Failing test** — drive `exec_via_source` with a `MockSource` for each variant; assert the mock recorded the expected call (extend `MockSource` with call recorders if needed, or assert via the mock's existing no-op behavior + a dedicated test double). Minimal: assert MarkRead calls don't error and return Ok.

- [ ] **Step 2: Run — expect FAIL.**

- [ ] **Step 3: Implement** `exec_via_source`:

```rust
use crate::sync_engine::{MailSource, RemoteFolder, SourceError};

impl MutationOp {
    /// Execute the remote (server) side of the op via the MailSource. Called by the
    /// replay loop. Resource paths come from the op's own fields (a Move carries both
    /// src + dst folder paths).
    pub async fn exec_via_source(&self, src: &dyn MailSource) -> Result<(), SourceError> {
        match self {
            MutationOp::MarkRead { folder_path, uids, read, .. } => {
                let f = folder_remote(folder_path);
                src.set_flags(&f, uids, "\\Seen", *read).await
            }
            MutationOp::SetFlag { folder_path, uids, flag, add, .. } => {
                let f = folder_remote(folder_path);
                src.set_flags(&f, uids, flag, *add).await
            }
            MutationOp::Move { src_folder_path, dst_folder_path, uids, .. } => {
                src.move_messages(&folder_remote(src_folder_path), uids, &folder_remote(dst_folder_path)).await
            }
            MutationOp::Delete { folder_path, uids, .. } => {
                src.delete_messages(&folder_remote(folder_path), uids).await
            }
            MutationOp::Send { raw_base64url } => src.send(raw_base64url).await,
        }
    }
}

fn folder_remote(path: &str) -> RemoteFolder {
    RemoteFolder { remote_id: path.into(), name: path.into(), delimiter: "/".into(), ..Default::default() }
}
```

The `sync_apply_mutation` command (in `sync_engine/commands.rs`): optimistic local-apply + enqueue (one row per affected message) + nudge worker. It does NOT block on the network — the worker replays.

```rust
use crate::db::{queue, mutations::MutationOp};
use crate::sync_engine::engine::SyncEngine;

#[tauri::command]
pub async fn sync_apply_mutation(
    engine: State<'_, Arc<SyncEngine>>,
    pool: State<'_, SqlitePool>,
    account_id: String,
    op: MutationOp,
) -> Result<(), String> {
    let affected = op.local_writes(&pool, &account_id).await?;
    // Enqueue one row per affected message (resource_id = message_id) for the exact
    // write-lock. Send has no message_id -> one row, resource_id "send:<uuid>".
    let ids: Vec<String> = if affected.is_empty() {
        vec![format!("send:{}", uuid::Uuid::new_v4())]
    } else {
        affected.clone()
    };
    for rid in &ids {
        let params = op.encode_params(rid);
        queue::enqueue(&pool, &account_id, op.op_type(), rid, &params).await?;
    }
    // Nudge the worker to replay (best-effort, non-blocking).
    engine.sync_account_now(account_id.clone()).await;
    Ok(())
}
```
Register `sync_apply_mutation` in `lib.rs` `generate_handler!`. (Note: `sync_account_now` currently syncs folders; Task 4 adds replay to the worker so the nudge also drains the queue.)

- [ ] **Step 4: Run — expect PASS.**
- [ ] **Step 5: Commit** — `feat(sync): MutationOp.exec_via_source + sync_apply_mutation command`.

---

## Task 4: AccountWorker replay loop + `sync:queue` event

**Files:**
- Modify: `kylins.client.backend/src/sync_engine/engine.rs`
- Test: `engine.rs` `#[cfg(test)]`

**Interfaces:**
- Consumes: `db::queue::{dequeue_pending_for_account, compact_queue, mark_completed, mark_failed, pending_count_for_account}`, `MutationOp::{exec_via_source, decode from pending row}`, `source_for_account`.
- Produces: the replay runs inside each `AccountWorker`; emits `sync:queue { accountId, pending }`.

- [ ] **Step 1: Failing test** — seed an account + a pending `markRead` op + a `MockSource`; call `run_replay_round(&engine, "a", &src)`; assert the op is deleted (completed) and `sync:queue` emitted with pending=0. A second test: `MockSource` returns `Err` → op stays, `mark_failed` backoff applied (retry_count=1).

- [ ] **Step 2: Run — expect FAIL.**

- [ ] **Step 3: Implement** the replay round + wire it into the worker's `select!`:

Add to `MutationOp` a constructor from a `PendingOperation` (decode `params` JSON back into the variant — for the single-message replay, build a per-message op from the row):

```rust
impl MutationOp {
    /// Reconstruct the op for replay from a pending row. The row encodes one message
    /// (resource_id) worth of params.
    pub fn from_pending(row: &crate::db::queue::PendingOperation) -> Result<Self, String> {
        let v: serde_json::Value = serde_json::from_str(&row.params).map_err(|e| e.to_string())?;
        let uid = v.get("uids").and_then(|a| a.as_array()).and_then(|a| a.first()).and_then(|x| x.as_u64()).unwrap_or(0) as u32;
        let folder = v.get("folderPath").and_then(|x| x.as_str()).unwrap_or("").to_string();
        Ok(match row.operation_type.as_str() {
            "markRead" => MutationOp::MarkRead {
                thread_id: row.resource_id.clone(), message_ids: vec![row.resource_id.clone()],
                folder_path: folder, uids: vec![uid],
                read: v.get("read").and_then(|x| x.as_i64()).unwrap_or(0) == 1,
            },
            "setFlag" => MutationOp::SetFlag {
                message_ids: vec![row.resource_id.clone()], folder_path: folder, uids: vec![uid],
                flag: v.get("flag").and_then(|x| x.as_str()).unwrap_or("\\Flagged").to_string(),
                add: v.get("add").and_then(|x| x.as_bool()).unwrap_or(true),
            },
            "move" => MutationOp::Move {
                message_ids: vec![row.resource_id.clone()],
                src_label: String::new(), dst_label: v.get("dstLabel").and_then(|x| x.as_str()).unwrap_or("").to_string(),
                src_folder_path: v.get("srcFolderPath").and_then(|x| x.as_str()).unwrap_or("").to_string(),
                dst_folder_path: v.get("dstFolderPath").and_then(|x| x.as_str()).unwrap_or("").to_string(),
                uids: vec![uid],
            },
            "delete" => MutationOp::Delete {
                message_ids: vec![row.resource_id.clone()], folder_path: folder, uids: vec![uid],
            },
            "send" => MutationOp::Send {
                raw_base64url: v.get("rawBase64url").and_then(|x| x.as_str()).unwrap_or("").to_string(),
            },
            other => return Err(format!("unknown op type {other}")),
        })
    }
}
```

In `engine.rs`, add a `run_replay_round` (mirrors `run_sync_round_with_source`'s test-seam shape) + a `QueueEvent { account_id, pending }` emitted before/after:

```rust
async fn run_replay_round(engine: &Arc<SyncEngine>, account_id: &str, src: &dyn MailSource) {
    let pool = &engine.pool;
    if let Err(e) = crate::db::queue::compact_queue(pool, account_id).await {
        log::warn!("[sync] {account_id} compact_queue failed: {e}");
    }
    let ops = match crate::db::queue::dequeue_pending_for_account(pool, account_id, 50).await {
        Ok(o) => o, Err(e) => { log::warn!("[sync] {account_id} dequeue failed: {e}"); return; }
    };
    for op in ops {
        let mop = match crate::db::mutations::MutationOp::from_pending(&op) {
            Ok(m) => m, Err(e) => { log::warn!("[sync] decode op {} failed: {e}", op.id); continue; }
        };
        match mop.exec_via_source(src).await {
            Ok(()) => { let _ = crate::db::queue::mark_completed(pool, &op.id).await; }
            Err(e) => { let _ = crate::db::queue::mark_failed(pool, &op.id, &e.to_string()).await; }
        }
    }
    let pending = crate::db::queue::pending_count_for_account(pool, account_id).await.unwrap_or(0);
    engine.emit_queue(account_id, pending);
}

impl SyncEngine {
    fn emit_queue(&self, account_id: &str, pending: i64) {
        self.sink.emit_queue(QueueEvent { account_id: account_id.into(), pending });
    }
}
```

Add `emit_queue` to the `EventSink` trait (+ `TauriSink` emits `"sync:queue"`, + `TestSink` collects). Wire the replay into the worker: after every `run_sync_round` (and on `SyncOp::SyncNow`), call `run_replay_round` with the resolved source. Simplest: extend `run_sync_round_with_source` to call `run_replay_round(engine, account_id, src)` at the end (it already has `src`).

- [ ] **Step 4: Run — expect PASS** (op completes + `sync:queue` pending=0; failure path → op retained + backoff).
- [ ] **Step 5: Commit** — `feat(sync): AccountWorker replay loop + compact_queue + sync:queue`.

---

## Task 5: Write-lock in `apply_folder_delta`

**Files:**
- Modify: `kylins.client.backend/src/db/messages.rs`

**Interfaces:**
- Consumes: `db::queue::has_pending_for_resource`.
- Produces: `apply_folder_delta` skips upserting messages with a pending op.

- [ ] **Step 1: Failing test** — seed account + message + a pending op for that message_id; call `apply_folder_delta` with an `added` RemoteMessage whose `message_id` matches the pending resource; assert the message's `is_read` is NOT overwritten by the delta (the local edit survives).

- [ ] **Step 2: Run — expect FAIL.**

- [ ] **Step 3: Implement** — in `upsert_message`, before the threads/messages upsert, check the write-lock and skip if held:

```rust
// At the top of upsert_message, after computing message_id:
if crate::db::queue::has_pending_for_resource(&**tx as &SqlitePool, account_id, &message_id).await {
    // A local mutation is pending replay — do not let a server delta revert it.
    return Ok(());
}
```
(`has_pending_for_resource` takes `&SqlitePool`; inside a `Transaction` you can run the query via `&mut **tx` — adjust to query through the tx handle: `sqlx::query(...).fetch_one(&mut **tx)`.) Repoint `has_pending_for_resource` to accept the executor OR run the EXISTS inline in `upsert_message` against `&mut **tx`:

```rust
let locked: (i64,) = sqlx::query_as(
    "SELECT COUNT(*) FROM pending_operations WHERE account_id = ? AND resource_id = ? AND status = 'pending'",
)
.bind(account_id).bind(&message_id).fetch_one(&mut **tx).await.map_err(|e| e.to_string())?;
if locked.0 > 0 { return Ok(()); }
```

- [ ] **Step 4: Run — expect PASS** + re-run the Task 8 (apply_folder_delta) tests to confirm no regression.
- [ ] **Step 5: Commit** — `feat(db): apply_folder_delta write-lock (skip messages with pending ops)`.

---

## Task 6: Frontend wiring — mark-read + send via `sync_apply_mutation`; `sync:queue` status

**Files:**
- Modify: `kylins.client.frontend/src/stores/threadStore.ts`
- Modify: `kylins.client.frontend/src/services/composer/send.ts` (send path)
- Modify: `kylins.client.frontend/src/hooks/useSyncEvents.ts`
- Modify: `kylins.client.frontend/src/stores/uiStore.ts` (or a sync-status store) — `pendingCount`
- Modify: `tests/**` (threadStore test, App.test mocks)

**Interfaces:**
- Consumes: `sync_apply_mutation` command, `sync:queue` event.
- Produces: optimistic mark-read/send through the engine; status bar pending count.

- [ ] **Step 1: Failing test** — `threadStore.selectThread` calls `invoke('sync_apply_mutation', { accountId, op: { type:'markRead', ... } })` instead of `invoke('db_mark_thread_read', ...)`; optimistic UI still flips `isRead`. Use the existing service-boundary mock pattern (mock the data-access module).

- [ ] **Step 2: Run — expect FAIL.**

- [ ] **Step 3: Implement**
  - `threadStore.selectThread`: replace the `markThreadRead(accountId, threadId)` call with:
    ```ts
    invoke('sync_apply_mutation', {
      accountId: thread.accountId,
      op: {
        type: 'markRead',
        threadId: thread.id,
        messageIds: /* messages in the thread (you have `messages` in scope) */ messages.map(m => m.id),
        folderPath: /* current folder path from folderStore.currentSelection or the message's folder */,
        uids: messages.map(m => m.imapUid ?? 0),
        read: true,
      },
    });
    ```
    (Keep the optimistic `threads.map(isRead:true)` + `decrementUnread`. The engine's local-apply is now the durable write, so drop the separate `db_mark_thread_read` call.)
  - `services/composer/send.ts`: the send path currently does SMTP + `offlineQueue.enqueue` on failure. Replace with a single `invoke('sync_apply_mutation', { accountId, op: { type:'send', rawBase64url } })`. The engine's replay handles send via `MailSource::send` with the existing backoff. (Keep the draft-delete on success semantics by checking the op result via the existing send flow — OR leave the immediate SMTP attempt for instant send + fall back to enqueue. **Simplest faithful port:** call `sync_apply_mutation`; the engine applies locally (no-op for send) + enqueues + replays. The composer treats the invoke resolve as "queued/sent".)
  - `useSyncEvents.ts`: add a `sync:queue` listener → `useUIStore.getState().setPendingCount(payload.pending)`.
  - `uiStore.ts`: add `pendingCount: number` + `setPendingCount`.
  - Tests: update `tests/stores/threadStore.test.ts` to assert the new invoke; mock `@tauri-apps/api/core` invoke in any test that exercises the send path.

- [ ] **Step 4: Run — expect PASS.**
- [ ] **Step 5: Commit** — `feat(sync): route mark-read + send through sync_apply_mutation; sync:queue status`.

---

## Task 7: End-to-end verification + regression

**Files:** none (verification only) — but fix anything that surfaces.

- [ ] **Step 1: Full backend suite** `cd kylins.client.backend && cargo test --lib` — expect all green.
- [ ] **Step 2: Full frontend suite** `cd kylins.client.frontend && npx tsc --noEmit && npx vitest run` — expect green.
- [ ] **Step 3: Manual offline-replay e2e** `cargo tauri dev`:
  - Create the IMAP account; let Inbox sync.
  - Mark a thread read → it flips instantly (optimistic); within the replay tick the server `\Seen` is pushed.
  - Stop the IMAP server (or disconnect network); mark another thread read / star / move / delete → the change applies locally and queues; bring the server back → within the replay tick the op drains and the change is confirmed server-side.
  - Status bar shows "Offline — N pending" via `sync:queue` while queued, 0 when drained.
- [ ] **Step 4: Commit any fixes** (if the e2e surfaced regressions).
- [ ] **Step 5: Update ledger** — Phase 1 complete.

---

## Self-review notes

- **Spec coverage (umbrella spec §10 Phase 1):** mutations→optimistic→enqueue→replay = Tasks 2–4, 6; `compactQueue` = Task 1; 24-hr write-lock = Task 5; `sync:queue` status = Task 4 + 6; exit (survive offline/crash) = Task 7. ✅
- **Type consistency:** `MutationOp` variants + `op_type()` strings ("markRead"/"setFlag"/"move"/"delete"/"send") are used identically in `encode_params` (Task 2), `from_pending` (Task 4), `sync_apply_mutation` (Task 3), and `compact_queue` (Task 1). `resource_id` = message_id consistently (the write-lock key). `read` param is the uniform compact_queue field for both markRead + setFlag.
- **Known limitation (acceptable for Phase 1):** replay executes ops one-resource-at-a-time (per-message `STORE`). Batching same-folder flag ops into one `STORE` uid-set is a follow-up optimization (compact_queue already cancels toggles). The write-lock is exact per-message (one op row per message_id).

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-06-27-sync-engine-phase1.md`. Two execution options:

1. **Subagent-Driven (recommended)** — fresh subagent per task, review between tasks.
2. **Inline Execution** — this session via executing-plans, batched with checkpoints.

Which approach?
