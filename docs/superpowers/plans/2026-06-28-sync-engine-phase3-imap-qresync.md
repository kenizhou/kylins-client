# Kylins Mail Sync Engine — Phase 3e: IMAP CONDSTORE/QRESYNC Delta Sync

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `ImapSource::sync_folder` detect **flag changes** (read/star set on another client) and **expunges** (messages deleted on another client) since the last sync — closing the two correctness gaps where today's client only ever fetches *new* UIDs and silently ignores metadata changes and deletions from the server.

**Architecture:** Today `sync_folder` advances only `highest_uid` (new messages) and stores `highest_modseq` in the cursor but **never queries it**. This plan turns `highest_modseq` into a live CONDSTORE delta cursor: when the server advertises `CONDSTORE`, issue `UID FETCH 1:* (UID FLAGS MODSEQ) (CHANGEDSINCE <modseq>)` to get flag deltas (fully supported by async-imap's typed API — `Fetch.modseq` is populated). Expunges are detected universally via set-difference (`UID SEARCH ALL` minus locally-known UIDs), which works on every server without needing VANISHED parsing. The literal QRESYNC `SELECT … (QRESYNC (…))` + raw `VANISHED` fast-path is a documented optional follow-up — async-imap 0.10.4 parses VANISHED nowhere (verified: case-insensitive `vanished` has zero matches across the crate), so it would require fragile raw line parsing for a marginal one-round-trip gain over the set-difference path.

**Tech Stack:** Rust; `async-imap` 0.10.4 (typed `uid_fetch` + `Fetch.modseq` + `Mailbox.highest_modseq`); `sqlx` 0.8 (sqlite); the existing `MailSource`/`Cursor`/`FolderDelta` types; `db::sync_state` cursor store; `db::messages::apply_folder_delta`. Reference protocol implementation: `D:\Projects\mailclient\opensource\imapflow\lib\commands\{select,fetch,expunge}.js` (RFC 7162).

## Authority & cross-validation

- **RFC:** CONDSTORE + QRESYNC are consolidated in **RFC 7162** (obsoletes RFC 4551 + RFC 5162). The umbrella spec cites "QRESYNC (RFC 5162)"; 7162 is the current document. Key sections: §3.1 CONDSTORE, §3.2 QRESYNC, §3.2.5 SELECT/QRESYNC validity preconditions.
- **async-imap 0.10.4 source (verified in `~/.cargo/registry/.../async-imap-0.10.4/src/`):**
  - `types/fetch.rs:36` — `pub modseq: Option<u64>`, populated from `AttributeValue::ModSeq` (`fetch.rs:51`). ✅ CONDSTORE flag deltas are fully typed.
  - `client.rs:340` — `select` runs `SELECT {validate_str(name)}` — it quotes/validates, so QRESYNC params **cannot** be appended to `select()`.
  - `client.rs:1329` — `run_command_and_check_ok<S>(&mut self, command)` is the raw-command escape hatch (for `ENABLE QRESYNC` if ever needed).
  - `client.rs:477` — `uid_fetch(set, query)` takes an arbitrary query string (existing code already passes `"UID FLAGS INTERNALDATE BODY.PEEK[]"`).
  - **`vanished` has zero matches anywhere in the crate** → VANISHED is not parsed. Confirmed.
  - No `enable()` method; no `extensions/qresync` or `condstore` module (only compress/id/idle/quota).
- **imapflow reference:** `select.js:55-64` (QRESYNC SELECT args), `select.js:208-214` (validity preconditions + `NOMODSEQ` fallback), `fetch.js:118-121` (always request `MODSEQ`), `fetch.js:178-198` (`CHANGEDSINCE` + optional `VANISHED` modifier), `expunge.js:38-48` (HIGHESTMODSEQ in OK response code).

## Global Constraints

- **Do NOT rewrite the WBXML/EAS code or the IMAP transport.** Reuse the existing `imap_client::*` helpers and the existing per-call `connect()`+`logout()` connection model. (A persistent-session refactor is a *separate* workstream, not this one — see Deferred Follow-Ups.)
- **Capability-gated.** Every CONDSTORE code path is guarded by `caps.condstore && since_modseq > 0`. Servers without CONDSTORE keep the current append-only behavior unchanged.
- **Flag updates must never clobber envelope fields.** A CONDSTORE `CHANGEDSINCE` FETCH returns FLAGS only. Feeding a flag-only `RemoteMessage` through the existing `upsert_message` would overwrite `subject`/`from_address`/`body_*` with `None`. Therefore flag deltas flow through a **new** `apply_flag_updates` that touches only `is_read`/`is_starred` — never `upsert_message`.
- **`highest_modseq` advances monotonically.** A lagging sync round must never regress the modseq cursor. `advance_imap_cursor` becomes `MAX(excluded.modseq, stored.modseq)`.
- **First sync (modseq 0) does NOT issue `CHANGEDSINCE`.** `CHANGEDSINCE 0` would return every message's flags. On first sync, do the normal new-UID fetch and seed modseq from the mailbox `HIGHESTMODSEQ`.
- **Write-lock is honored** for both flag updates and vanished deletion: a message with a pending local op (`resource_id = imap-{account}-{folder}-{uid}`) is skipped, exactly as `upsert_message` does today.
- **No new crate dependencies.** Everything uses the existing `async-imap`, `sqlx`, `tokio::time::timeout` surface.
- **Commit cadence:** one commit per task. `cargo test --lib` green at each boundary.

---

## File Structure

**Backend (Rust):**
- `src/sync_engine/mod.rs` — add `FlagUpdate` struct; add `flag_updates: Vec<FlagUpdate>` field to `FolderDelta`. (Adding the field requires updating every existing `FolderDelta { … }` literal — `cargo build` will list them.)
- `src/db/messages.rs` — new `apply_flag_updates(...)` (updates `is_read`/`is_starred` on `messages` + mirrored `threads`, honors write-lock); wire `delta.vanished_uids` → local DELETE in `apply_folder_delta`.
- `src/mail/imap/client.rs` — new `fetch_changed_flags(session, folder, since_modseq) -> (Vec<ImapFlagChange>, next_modseq)` helper (typed `uid_fetch` with `CHANGEDSINCE`); the existing `search_all_uids` (client.rs:378) is reused as-is for expunge set-difference.
- `src/sync_engine/imap_source.rs` — extend `sync_folder`: extract `since_modseq`, call `fetch_changed_flags` (CONDSTORE-gated), build `delta.flag_updates`; call `search_all_uids` + local-uid diff → `delta.vanished_uids`; carry the advanced modseq into `next_cursor`.
- `src/db/sync_state.rs` — `advance_imap_cursor` modseq clause → monotonic `MAX`.
- `src/db/messages.rs` (or a small new `src/db/uid_index.rs`) — `list_local_uids(pool, account_id, folder_path) -> Vec<u32>` read for the expunge diff.

**Frontend:** Unchanged (the engine emits the same `sync:delta` events; flag/vanished changes arrive as row updates the stores already react to). Verify only.

---

## Task 1: DB prerequisite — `FlagUpdate` type, `flag_updates` delta field, flag-only apply, vanished deletion

**Files:** `src/sync_engine/mod.rs`, `src/db/messages.rs`

**Interfaces:**
- Produces: `pub struct FlagUpdate { uid, is_read, is_starred }` (in `sync_engine/mod.rs`); `FolderDelta.flag_updates: Vec<FlagUpdate>`; `db::messages::apply_flag_updates(pool, account_id, folder_path, &[FlagUpdate]) -> Result<u64, String>`; `apply_folder_delta` now deletes rows for `delta.vanished_uids`.

- [ ] **Step 1: Write failing tests** in `src/db/messages.rs` `#[cfg(test)] mod tests`:

```rust
use crate::sync_engine::FlagUpdate;

#[tokio::test]
async fn apply_flag_updates_changes_only_flags_not_envelope() {
    let tmp = tempfile::tempdir().unwrap();
    let pool = init_db(tmp.path()).await.unwrap();
    seed(&pool, "acc").await;
    // Seed a message with a known subject + is_read=false.
    let delta = FolderDelta {
        added: vec![RemoteMessage {
            uid: 7, folder: "INBOX".into(), subject: Some("Original Subject".into()),
            from_address: Some("a@b".into()), body_html: Some("<p>x</p>".into()),
            ..Default::default()
        }],
        ..Default::default()
    };
    apply_folder_delta(&pool, "acc", "acc:INBOX", "INBOX", &delta).await.unwrap();

    // CONDSTORE says: uid 7 now read + starred. apply_flag_updates must flip flags
    // but leave subject/from/body untouched.
    let n = apply_flag_updates(&pool, "acc", "INBOX", &[
        FlagUpdate { uid: 7, is_read: true, is_starred: true },
    ]).await.unwrap();
    assert_eq!(n, 1);

    let (is_read, is_starred, subject, body): (i64, i64, Option<String>, Option<String>) =
        sqlx::query_as("SELECT is_read, is_starred, subject, \
            (SELECT body_html FROM message_bodies WHERE message_id = messages.id) \
            FROM messages WHERE account_id='acc' AND imap_folder='INBOX' AND imap_uid=7")
        .fetch_one(&pool).await.unwrap();
    assert_eq!(is_read, 1);
    assert_eq!(is_starred, 1);
    assert_eq!(subject.as_deref(), Some("Original Subject"), "subject must not be clobbered");
    assert_eq!(body.as_deref(), Some("<p>x</p>"), "body must not be clobbered");
}

#[tokio::test]
async fn apply_folder_delta_deletes_vanished_uids() {
    let tmp = tempfile::tempdir().unwrap();
    let pool = init_db(tmp.path()).await.unwrap();
    seed(&pool, "acc").await;
    let seed = FolderDelta {
        added: vec![msg(1, "<m1>", false), msg(2, "<m2>", false), msg(3, "<m3>", false)],
        ..Default::default()
    };
    apply_folder_delta(&pool, "acc", "acc:INBOX", "INBOX", &seed).await.unwrap();
    assert_eq!(count(&pool, "messages").await, 3);

    // Server expunged uid 2.
    let delta = FolderDelta {
        vanished_uids: vec![2],
        ..Default::default()
    };
    apply_folder_delta(&pool, "acc", "acc:INBOX", "INBOX", &delta).await.unwrap();
    assert_eq!(count(&pool, "messages").await, 2, "uid 2 must be deleted");
    let remaining: Vec<(i64,)> = sqlx::query_as(
        "SELECT imap_uid FROM messages WHERE account_id='acc' AND imap_folder='INBOX' ORDER BY imap_uid")
        .fetch_all(&pool).await.unwrap();
    let uids: Vec<i64> = remaining.into_iter().map(|(u,)| u).collect();
    assert_eq!(uids, vec![1, 3]);
}
```

- [ ] **Step 2: Run — expect FAIL** (`FlagUpdate` undefined, `apply_flag_updates` undefined).

Run: `cargo test --lib db::messages`
Expected: compile error — `FlagUpdate` / `apply_flag_updates` not found.

- [ ] **Step 3: Implement.**

In `src/sync_engine/mod.rs`, after the `RemoteMessage` struct:

```rust
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
```

Add the field to `FolderDelta`:

```rust
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct FolderDelta {
    pub added: Vec<RemoteMessage>,
    pub updated: Vec<RemoteMessage>,
    pub flag_updates: Vec<FlagUpdate>,   // NEW — CONDSTORE CHANGEDSINCE flag deltas
    pub vanished_uids: Vec<u32>,
    pub next_cursor: Cursor,
    pub uidvalidity_changed: bool,
}
```

Then fix every existing `FolderDelta { … }` literal flagged by `cargo build` (in `mock_source.rs`, `eas_source.rs`, and the `mod.rs`/`messages.rs`/`sync_state.rs` tests). Preferred: convert literals that omit the new field to end with `..Default::default()`. (For literals that already list all fields, append `flag_updates: vec![]`.)

In `src/db/messages.rs`, add `apply_flag_updates` and wire vanished deletion. Replace the `apply_folder_delta` body's vanished comment block (currently `messages.rs:58-62`) with real deletion, and add the new function:

```rust
use crate::sync_engine::{FolderDelta, FlagUpdate, RemoteMessage}; // add FlagUpdate to the existing use

pub async fn apply_folder_delta(
    pool: &SqlitePool,
    account_id: &str,
    label_id: &str,
    folder_path: &str,
    delta: &FolderDelta,
) -> Result<AppliedCounts, String> {
    let mut tx = pool.begin().await.map_err(|e| e.to_string())?;

    if delta.uidvalidity_changed {
        // (unchanged wipe block — leave as-is)
        sqlx::query("DELETE FROM messages WHERE account_id = ? AND imap_folder = ?")
            .bind(account_id).bind(folder_path).execute(&mut *tx).await.map_err(|e| e.to_string())?;
        sqlx::query("DELETE FROM threads WHERE account_id = ? AND id NOT IN \
             (SELECT thread_id FROM messages WHERE account_id = ?)")
            .bind(account_id).bind(account_id).execute(&mut *tx).await.map_err(|e| e.to_string())?;
    }

    let mut deleted = 0u64;
    for m in &delta.added {
        upsert_message(&mut tx, account_id, label_id, m).await?;
    }
    for m in &delta.updated {
        upsert_message(&mut tx, account_id, label_id, m).await?;
    }
    for u in &delta.vanished_uids {
        let id = format!("imap-{account_id}-{folder_path}-{u}");
        let res = sqlx::query("DELETE FROM messages WHERE id = ?")
            .bind(&id).execute(&mut *tx).await.map_err(|e| e.to_string())?;
        deleted += res.rows_affected();
        sqlx::query("DELETE FROM message_bodies WHERE message_id = ?")
            .bind(&id).execute(&mut *tx).await.map_err(|e| e.to_string())?;
    }
    if !delta.vanished_uids.is_empty() {
        // Sweep threads left orphaned by the deletions (mirrors the wipe block).
        sqlx::query("DELETE FROM threads WHERE account_id = ? AND id NOT IN \
             (SELECT thread_id FROM messages WHERE account_id = ?)")
            .bind(account_id).bind(account_id).execute(&mut *tx).await.map_err(|e| e.to_string())?;
    }
    tx.commit().await.map_err(|e| e.to_string())?;

    // Flag updates run AFTER commit so they see the just-added rows (a message can be
    // added and flag-changed in the same round).
    let flagged = apply_flag_updates(pool, account_id, folder_path, &delta.flag_updates).await?;

    Ok(AppliedCounts {
        added: delta.added.len() as u64,
        updated: delta.updated.len() as u64 + flagged,
        deleted,
    })
}

/// Apply CONDSTORE flag-only deltas: update is_read/is_starred on `messages` and mirror
/// to the owning `threads`. Touches NOTHING else (no subject/from/body clobber). Honors
/// the 24-hr write-lock: a message with a pending local op is skipped.
pub async fn apply_flag_updates(
    pool: &SqlitePool,
    account_id: &str,
    folder_path: &str,
    updates: &[FlagUpdate],
) -> Result<u64, String> {
    let mut applied = 0u64;
    for u in updates {
        let message_id = format!("imap-{account_id}-{folder_path}-{u}");
        let locked: (i64,) = sqlx::query_as(
            "SELECT COUNT(*) FROM pending_operations \
             WHERE account_id = ? AND resource_id = ? AND status = 'pending'",
        )
        .bind(account_id).bind(&message_id).fetch_one(pool).await.map_err(|e| e.to_string())?;
        if locked.0 > 0 {
            continue; // local edit pending — don't let the server delta revert it
        }
        let is_read: i64 = if u.is_read { 1 } else { 0 };
        let is_starred: i64 = if u.is_starred { 1 } else { 0 };
        let res = sqlx::query(
            "UPDATE messages SET is_read = ?, is_starred = ? \
             WHERE account_id = ? AND imap_folder = ? AND imap_uid = ?",
        )
        .bind(is_read).bind(is_starred).bind(account_id).bind(folder_path).bind(u.uid as i64)
        .execute(pool).await.map_err(|e| e.to_string())?;
        if res.rows_affected() > 0 {
            applied += 1;
            // Mirror to the thread (Phase 0 threading: thread id == message id).
            sqlx::query("UPDATE threads SET is_read = ?, is_starred = ? WHERE id = ?")
                .bind(is_read).bind(is_starred).bind(&message_id)
                .execute(pool).await.map_err(|e| e.to_string())?;
        }
    }
    Ok(applied)
}
```

- [ ] **Step 4: Run — expect PASS.**

Run: `cargo test --lib db::messages`
Expected: both new tests pass; existing `apply_*` tests still green.

- [ ] **Step 5: Commit** — `feat(sync): FlagUpdate + apply_flag_updates + vanished-uid deletion in apply_folder_delta`.

---

## Task 2: CONDSTORE flag-change fetch — `fetch_changed_flags` helper + ImapSource wiring

**Files:** `src/mail/imap/client.rs`, `src/sync_engine/imap_source.rs`

**Interfaces:**
- Consumes: async-imap `Session::uid_fetch`, `Fetch.modseq` / `Fetch.flags()`; `IMAP_CMD_TIMEOUT`.
- Produces: `imap_client::fetch_changed_flags(session, folder, since_modseq) -> Result<(Vec<ImapFlagChange>, u64), String>`; `ImapSource::sync_folder` populates `delta.flag_updates` and advances `highest_modseq`.

- [ ] **Step 1: Write failing test** in `src/mail/imap/client.rs` `#[cfg(test)]`:

```rust
use super::fetch_changed_flags_response_from_fetches; // pure parser under test

#[test]
fn changed_flags_parser_maps_modseq_and_flags() {
    // Simulate three parsed Fetches from a CHANGEDSINCE response.
    // (We test the pure mapping; the live uid_fetch is exercised in the integration test.)
    let out = fetch_changed_flags_response_from_fetches(
        100, // since_modseq
        vec![
            (10, vec!["\\Seen"], 150u64),            // uid 10 now read, modseq 150
            (11, vec!["\\Flagged"], 160),            // uid 11 now starred
            (12, vec!["\\Seen", "\\Flagged"], 170),  // both
        ],
        175, // mailbox HIGHESTMODSEQ
    );
    assert_eq!(out.0.len(), 3);
    assert!(out.0.iter().any(|c| c.uid == 10 && c.is_read && !c.is_starred));
    assert!(out.0.iter().any(|c| c.uid == 11 && !c.is_read && c.is_starred));
    assert!(out.0.iter().any(|c| c.uid == 12 && c.is_read && c.is_starred));
    // next_modseq = max(fetch modseq, mailbox highestmodseq) = 175
    assert_eq!(out.1, 175);
}

#[test]
fn changed_flags_parser_floors_next_modseq_at_since() {
    // Empty change set -> next_modseq = max(since, mailbox_highest).
    let out = fetch_changed_flags_response_from_fetches(200, vec![], 200);
    assert!(out.0.is_empty());
    assert_eq!(out.1, 200);
}
```

- [ ] **Step 2: Run — expect FAIL.**

Run: `cargo test --lib mail::imap`
Expected: `fetch_changed_flags_response_from_fetches` undefined.

- [ ] **Step 3: Implement.** In `src/mail/imap/client.rs`, near the other fetch helpers:

```rust
use async_imap::types::Flag as ImapFlag;

#[derive(Debug, Clone)]
pub struct ImapFlagChange {
    pub uid: u32,
    pub is_read: bool,
    pub is_starred: bool,
    pub modseq: u64,
}

/// Pure reduction of parsed Fetch responses into flag changes + the next modseq cursor.
/// Factored out so it is unit-testable without a live socket.
fn fetch_changed_flags_response_from_fetches(
    since_modseq: u64,
    fetches: Vec<(u32, Vec<&str>, u64)>,
    mailbox_highest_modseq: u64,
) -> (Vec<ImapFlagChange>, u64) {
    let mut changes = Vec::new();
    let mut max_modseq = since_modseq;
    for (uid, flags, modseq) in fetches {
        if modseq > max_modseq {
            max_modseq = modseq;
        }
        let is_read = flags.iter().any(|f| f.eq_ignore_ascii_case("\\Seen"));
        let is_starred = flags.iter().any(|f| f.eq_ignore_ascii_case("\\Flagged"));
        changes.push(ImapFlagChange { uid, is_read, is_starred, modseq });
    }
    (changes, max_modseq.max(mailbox_highest_modseq))
}

/// CONDSTORE flag-delta fetch (RFC 7162 §3.1). Returns messages whose metadata changed
/// since `since_modseq`, plus the next modseq cursor (max of returned modseqs and the
/// mailbox HIGHESTMODSEQ, so a no-change round still advances). Requires the server to
/// advertise CONDSTORE; the caller gates on `caps.condstore && since_modseq > 0`.
pub async fn fetch_changed_flags(
    session: &mut ImapSession,
    folder: &str,
    since_modseq: u64,
) -> Result<(Vec<ImapFlagChange>, u64), String> {
    let mailbox = tokio::time::timeout(IMAP_CMD_TIMEOUT, session.select(folder))
        .await
        .map_err(|_| format!("SELECT {folder} timed out after {}s — check your server settings or network connection", IMAP_CMD_TIMEOUT.as_secs()))?
        .map_err(|e| format!("SELECT {folder} failed: {e}"))?;
    let mailbox_highest = mailbox.highest_modseq.unwrap_or(0);

    let query = format!("UID FLAGS MODSEQ (CHANGEDSINCE {since_modseq})");
    let fetches: Vec<_> = tokio::time::timeout(IMAP_FETCH_TIMEOUT, async {
        let stream = session
            .uid_fetch("1:*", &query)
            .await
            .map_err(|e| format!("UID FETCH CHANGEDSINCE {folder} failed: {e}"))?;
        Ok::<_, String>(stream.collect::<Vec<_>>().await)
    })
    .await
    .map_err(|_| format!("UID FETCH CHANGEDSINCE {folder} timed out after {}s — check your server settings or network connection", IMAP_FETCH_TIMEOUT.as_secs()))?;

    let mut changes = Vec::new();
    let mut max_modseq = since_modseq;
    for r in fetches.map_err(|e| e)? {
        match r {
            Ok(f) => {
                let uid = match f.uid { Some(u) => u, None => continue };
                let flags: Vec<_> = f.flags().collect();
                let is_read = flags.iter().any(|fl| matches!(fl, ImapFlag::Seen));
                let is_starred = flags.iter().any(|fl| matches!(fl, ImapFlag::Flagged));
                let ms = f.modseq.unwrap_or(0);
                if ms > max_modseq { max_modseq = ms; }
                changes.push(ImapFlagChange { uid, is_read, is_starred, modseq: ms });
            }
            Err(e) => log::warn!("IMAP CHANGEDSINCE {folder}: fetch stream error: {e}"),
        }
    }
    Ok((changes, max_modseq.max(mailbox_highest)))
}
```

Then wire it into `ImapSource::sync_folder` in `src/sync_engine/imap_source.rs`. Update the cursor destructure to capture modseq, add the CONDSTORE block after the new-UID fetch, and carry the advanced modseq into `next_cursor`:

```rust
// Replace the destructure:
let (since_uv, since_high, since_modseq) = match since {
    Cursor::Imap { uidvalidity, highest_uid, highest_modseq } => (uidvalidity, highest_uid, highest_modseq),
    _ => (0, 0, 0),
};

// ... (existing UIDVALIDITY-change check + new-UID fetch stay unchanged) ...

let caps = *self.caps.lock().unwrap().unwrap_or_default();
let mut flag_updates: Vec<FlagUpdate> = Vec::new();
let mut next_modseq = status.highest_modseq.unwrap_or(0);

if caps.condstore && since_modseq > 0 {
    match imap_client::fetch_changed_flags(&mut session, &folder.remote_id, since_modseq).await {
        Ok((changes, advanced)) => {
            next_modseq = advanced;
            flag_updates = changes.into_iter()
                .map(|c| FlagUpdate { uid: c.uid, is_read: c.is_read, is_starred: c.is_starred })
                .collect();
            log::info!(
                "[sync] CONDSTORE {}: {} flag change(s) since modseq {} (-> {})",
                folder.remote_id, flag_updates.len(), since_modseq, next_modseq
            );
        }
        Err(e) => {
            // CONDSTORE best-effort: a CHANGEDSINCE failure must not break the round.
            // We log and fall back to append-only semantics for this round.
            log::warn!("[sync] CONDSTORE {} CHANGEDSINCE failed, skipping flag delta: {e}", folder.remote_id);
        }
    }
}

let _ = session.logout().await;

Ok(FolderDelta {
    added,
    updated: vec![],
    flag_updates,
    vanished_uids: vec![],   // filled in Task 3
    next_cursor: Cursor::Imap {
        uidvalidity: status.uidvalidity,
        highest_uid: new_high,
        highest_modseq: next_modseq,
    },
    uidvalidity_changed: false,
})
```

Add `FlagUpdate` to the `use super::{…}` import at the top of `imap_source.rs`.

- [ ] **Step 4: Run — expect PASS.**

Run: `cargo test --lib mail::imap sync_engine::imap_source`
Expected: the two parser tests pass; existing imap_source tests still green.

- [ ] **Step 5: Commit** — `feat(sync): CONDSTORE CHANGEDSINCE flag-delta fetch in ImapSource.sync_folder`.

---

## Task 3: Expunge detection via set-difference

**Files:** `src/db/messages.rs` (new read), `src/sync_engine/imap_source.rs`

**Interfaces:**
- Consumes: `imap_client::search_all_uids` (already exists, `client.rs:378`); a new `db::messages::list_local_uids`.
- Produces: `sync_folder` fills `delta.vanished_uids` = (local UIDs) − (server UIDs).

- [ ] **Step 1: Write failing test** in `src/db/messages.rs`:

```rust
#[tokio::test]
async fn list_local_uids_returns_cached_uids_for_folder() {
    let tmp = tempfile::tempdir().unwrap();
    let pool = init_db(tmp.path()).await.unwrap();
    seed(&pool, "acc").await;
    apply_folder_delta(&pool, "acc", "acc:INBOX", "INBOX", &FolderDelta {
        added: vec![msg(1, "<m1>", false), msg(2, "<m2>", false), msg(9, "<m9>", false)],
        ..Default::default()
    }).await.unwrap();
    let mut uids = list_local_uids(&pool, "acc", "INBOX").await.unwrap();
    uids.sort();
    assert_eq!(uids, vec![1, 2, 9]);
}
```

- [ ] **Step 2: Run — expect FAIL** (`list_local_uids` undefined).

Run: `cargo test --lib db::messages`

- [ ] **Step 3: Implement.** In `src/db/messages.rs`:

```rust
/// UIDs we currently have cached for (account, folder). Used by the expunge
/// set-difference (server `UID SEARCH ALL` minus this set = vanished).
pub async fn list_local_uids(
    pool: &SqlitePool,
    account_id: &str,
    folder_path: &str,
) -> Result<Vec<u32>, String> {
    let rows: Vec<(Option<i64>,)> = sqlx::query_as(
        "SELECT imap_uid FROM messages WHERE account_id = ? AND imap_folder = ?",
    )
    .bind(account_id).bind(folder_path)
    .fetch_all(pool).await.map_err(|e| e.to_string())?;
    Ok(rows.into_iter().filter_map(|(u,)| u.map(|x| x as u32)).collect())
}
```

In `ImapSource::sync_folder` (`imap_source.rs`), after the CONDSTORE block and before building the return, add the expunge diff. **Important:** the diff needs the *server* UID set. Reuse the session we already hold (do NOT logout first):

```rust
// Expunge detection via set-difference (universal; needs no QRESYNC/VANISHED support).
// Server UID SEARCH ALL is the source of truth for "currently exists"; local UIDs not
// in that set were expunged on the server.
let mut vanished_uids: Vec<u32> = Vec::new();
let local_uids = match crate::db::messages::list_local_uids(
    /* pool — see note below */ &self.pool, account_id_placeholder, &folder.remote_id,
).await {
    Ok(v) => v,
    Err(e) => { log::warn!("[sync] list_local_uids {}: {e}", folder.remote_id); vec![] },
};
if !local_uids.is_empty() {
    match imap_client::search_all_uids(&mut session, &folder.remote_id).await {
        Ok(server_uids) => {
            let server_set: std::collections::HashSet<u32> = server_uids.into_iter().collect();
            vanished_uids = local_uids.into_iter().filter(|u| !server_set.contains(u)).collect();
            if !vanished_uids.is_empty() {
                log::info!("[sync] {}: {} locally-cached uid(s) expunged on server",
                    folder.remote_id, vanished_uids.len());
            }
        }
        Err(e) => log::warn!("[sync] UID SEARCH ALL {} for expunge diff failed: {e}", folder.remote_id),
    }
}
```

**Note on `pool`/`account_id`:** `ImapSource` currently holds only `account` (no `pool`). Two clean options — pick ONE and note it in the commit:
- **(A)** Add `pool: SqlitePool` (cheap `Arc`-backed clone) + keep `account.id` on `ImapSource`, set in `ImapSource::new`. Update `source_for_account` in `mod.rs` to pass `pool.clone()`. This also lets future tasks avoid plumbing DB reads through the engine. **(Recommended.)**
- **(B)** Do the `list_local_uids` read in the *engine* (`engine.rs::run_sync_round_with_source`) and pass the local UID set into `sync_folder` via a new trait param. More invasive.

Go with **(A)**: add `pool` to `ImapSource`. Then `list_local_uids(&self.pool, &self.account.id, &folder.remote_id)` resolves the placeholders above. Replace `vanished_uids: vec![]` in the returned `FolderDelta` with `vanished_uids`.

- [ ] **Step 4: Run — expect PASS.**

Run: `cargo test --lib db::messages sync_engine`
Expected: `list_local_uids` test passes; engine tests still green.

- [ ] **Step 5: Commit** — `feat(sync): expunge detection via UID SEARCH ALL set-difference`.

---

## Task 4: Cursor hardening — monotonic modseq advance + first-sync gate

**Files:** `src/db/sync_state.rs`, `src/sync_engine/imap_source.rs` (gate already added in Task 2 — verify)

**Interfaces:**
- Produces: `advance_imap_cursor` modseq advances as `MAX(excluded.modseq, stored.modseq)` (currently overwrites). The `since_modseq > 0` first-sync gate is already in place from Task 2.

- [ ] **Step 1: Write failing test** in `src/db/sync_state.rs` `#[cfg(test)]`:

```rust
#[tokio::test]
async fn imap_cursor_modseq_advances_monotonically() {
    let tmp = tempfile::tempdir().unwrap();
    let pool = init_db(tmp.path()).await.unwrap();
    seed(&pool, "a").await;
    advance_imap_cursor(&pool, "a", "INBOX", 100, 5, 50).await.unwrap();
    // A lagging round reports modseq 30 — must NOT regress to 30.
    advance_imap_cursor(&pool, "a", "INBOX", 100, 5, 30).await.unwrap();
    let c = get_imap_cursor(&pool, "a", "INBOX").await;
    assert_eq!(c, Cursor::Imap { uidvalidity: 100, highest_uid: 5, highest_modseq: 50 });
    // A newer modseq advances.
    advance_imap_cursor(&pool, "a", "INBOX", 100, 8, 90).await.unwrap();
    assert_eq!(get_imap_cursor(&pool, "a", "INBOX").await,
        Cursor::Imap { uidvalidity: 100, highest_uid: 8, highest_modseq: 90 });
}
```

- [ ] **Step 2: Run — expect FAIL** (current SQL overwrites modseq, so the lagging round regresses to 30).

Run: `cargo test --lib db::sync_state`

- [ ] **Step 3: Implement.** In `advance_imap_cursor` (`src/db/sync_state.rs`), change the `modseq = excluded.modseq` clause to a monotonic MAX:

```sql
-- before:
--   modseq = excluded.modseq,
-- after:
    modseq = MAX(excluded.modseq, folder_sync_state.modseq),
```

(The full `ON CONFLICT … DO UPDATE SET` block otherwise stays identical: `uidvalidity = excluded.uidvalidity`, `last_uid = CASE …`, `last_sync_at = excluded.last_sync_at`.)

- [ ] **Step 4: Run — expect PASS.** All `db::sync_state` tests green (the existing monotonic `last_uid` test is unaffected; add the new modseq test).

- [ ] **Step 5: Commit** — `fix(sync): advance_imap_cursor modseq is monotonic MAX`.

---

## Task 5: Tests + regression + manual e2e

**Files:** tests across `db::messages`, `db::sync_state`, `mail::imap`, `sync_engine::imap_source`; full regression.

- [ ] **Step 1: Integration-style CONDSTORE coverage.** Add an `imap_smtp_integration.rs` (ignored) test `test_changed_flags_via_condstore` that, against the live test server: appends a message, syncs once (seeds modseq), flips `\Seen` via raw STORE on a second connection, syncs again, and asserts the message's `is_read` flipped locally through the engine. Gate behind `#[ignore]` + `KYLINS_IMAP_*` env vars (matches the existing integration-test harness). If the test server lacks CONDSTORE, the test should assert the graceful no-op (flag unchanged) rather than fail.

- [ ] **Step 2: Expunge integration coverage.** Add ignored `test_expunge_detected_via_set_difference`: append two messages, sync, delete one via a second connection + EXPUNGE, sync again, assert the deleted uid appears in `vanished_uids` and is gone from the local cache.

- [ ] **Step 3: Full backend regression.**

Run: `cargo test --lib`
Expected: all green (was 236 at end of Phase 2; this plan adds ~6 new unit tests + 2 ignored integration tests).

- [ ] **Step 4: Frontend regression (frontend should be unchanged).**

Run: `cd ../kylins.client.frontend && npx tsc --noEmit && npx vitest run`
Expected: tsc 0 errors; vitest all green.

- [ ] **Step 5: Note manual e2e** (user runs `cargo tauri dev` against `imap.kylins.com` / `felixzhou@kylins.local`):
  1. Mark a synced Inbox message read in another client (e.g. webmail). Within one poll (≤60s) the message shows as read in Kylins **without** a manual refresh — proving the CONDSTORE flag delta path.
  2. Delete a message in webmail. Within one poll it disappears from the Kylins list — proving expunge set-difference.
  3. Star (`\Flagged`) a message in webmail → reflected in Kylins.
  4. Confirm a server *without* CONDSTORE still syncs new mail correctly (graceful append-only fallback; flag/expunge deltas silently skipped, logged at warn).

- [ ] **Step 6: Commit** any test fixes; update `.superpowers/sdd/progress.md` with the Phase 3e entry.

---

## Deferred Follow-Ups (documented, NOT in this plan's scope)

- **Literal QRESYNC fast-reconnect (`ENABLE QRESYNC` + `SELECT mbox (QRESYNC (uidvalidity modseq))` + raw `* VANISHED` parsing).** async-imap 0.10.4 parses VANISHED nowhere and `select()` validates the mailbox name, so this needs `run_command_and_check_ok` + manual `* VANISHED (uidset)` / early-response `* VANISHED:` line parsing (the `raw_*` helpers in `client.rs` already do manual line parsing — reuse that pattern). Value: one round-trip expunge+flag catch-up after downtime instead of `UID SEARCH ALL`. The set-difference path (Task 3) is universally correct without it, so this is a pure latency optimization. RFC 7162 §3.2.5 validity preconditions (UIDVALIDITY match + HIGHESTMODSEQ present + not `NOMODSEQ`, else full resync) MUST be honored — see imapflow `select.js:208-214`.
- **Explicit `NOMODSEQ` detection.** If the server returns `[NOMODSEQ]` (mailbox lost mod-sequences), CONDSTORE is unavailable for that mailbox. Today we rely on the CHANGEDSINCE fetch failing + the warn-and-skip fallback; an explicit detection (parse the STATUS/SELECT response code) would let us cache a per-folder "no modseq" flag and skip cleanly.
- **Per-round SEARCH cost.** Task 3 runs `UID SEARCH ALL` every round. Could be gated to "only when `mailbox.exists` decreased since last sync" or every Nth round. Default is every round for correctness; revisit if large folders show latency.
- **Persistent IMAP session** (the Kimi plan's #1, `docs/superpowers/plans/2026-06-27-imap-improvement-plan.md`). Orthogonal to delta sync; would remove the per-call `connect()`+`logout()` overhead and make `ENABLE QRESYNC` sticky. Separate workstream.
- **`COMPRESS=DEFLATE`** — bandwidth optimization (async-imap has `extensions::compress`).

## Self-review notes

- **Spec coverage (umbrella spec §10 + §14):**
  - "QRESYNC for fast reconnect after downtime" → CONDSTORE flag deltas (Task 2) + universal expunge detection (Task 3) deliver the *intent* (catch changes since last sync); the literal QRESYNC command is the documented optional follow-up above (honest about the async-imap limitation). ✅
  - "VANISHED fetch" / "per-message modseq" → `Fetch.modseq` drives the cursor (Task 2); vanished set-difference (Task 3). Per-message `modseq` column not needed (we track the folder-level `highest_modseq` cursor). ✅
- **Kimi plan reuse:** the Kimi plan is Phase 0-era and largely stale (persistent session = separate workstream; IDLE = already done in Phase 2). Its one durable contribution — capability detection + modseq cursor — was already built in Phase 2 Task 1 (`session_capabilities` + `caps` cache). This plan consumes that. The Kimi plan's QRESYNC/CONDSTORE deferral is exactly what we now implement. ✅
- **Prerequisite gaps closed:** `apply_folder_delta` vanished deletion (was a TODO at `messages.rs:61-62`) → Task 1. Flag-only update path (avoids clobber) → Task 1 `apply_flag_updates`. Cursor monotonicity → Task 4.
- **Type consistency:** `FlagUpdate` defined in Task 1, consumed in Task 2 (`imap_source` builds `Vec<FlagUpdate>`) and applied in Task 1 (`apply_flag_updates`). `FolderDelta.flag_updates` added in Task 1, populated in Task 2/3. `Cursor::Imap.highest_modseq` consumed (`since_modseq`) in Task 2, advanced (monotonic) in Task 4. `ImapFlagChange` (client.rs) → `FlagUpdate` (sync_engine) mapping is in Task 2's wiring. ✅
- **Honest MVP limitations:** literal QRESYNC SELECT+VANISHED deferred; `NOMODSEQ` implicit (fallback) not explicit; per-round SEARCH cost; flag mirror to `threads` assumes Phase 0's 1:1 threading (real conversation threading is its own follow-up).

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-06-28-sync-engine-phase3-imap-qresync.md`. Two execution options:

1. **Subagent-Driven (recommended)** — fresh subagent per task, review between tasks.
2. **Inline Execution** — this session via executing-plans, batched with checkpoints.

Which approach?
