# Plan: Detect flag changes and message moves during IMAP sync

**Date:** 2026-06-28
**Status:** Deferred (Phase 3 dependency)

## Problem

Two related sync gaps in `ImapSource::sync_folder`:

1. **Flag changes not detected**: When a message is read/unread/starred in another mail client, our local flags never update.
2. **Message moves not detected**: When a message is moved to another folder in another client, it persists in the old folder AND appears in the new folder (duplicate — never removed from old folder).

## Root cause

`sync_folder` in `imap_source.rs` only fetches NEW UIDs via `UID SEARCH (highest_uid+1):*`. It never:

1. Re-fetches already-seen UIDs for flag/read-state changes
2. Detects UIDs that vanished from the folder (moved/deleted on server)

The `FolderDelta` has `updated` and `vanished_uids` fields that are **always hardcoded empty**:

```rust
updated: vec![],        // NEVER populated
vanished_uids: vec![],  // NEVER populated
```

`apply_folder_delta` in `db/messages.rs` already handles both fields correctly (upserts updated messages with new flags via `ON CONFLICT DO UPDATE SET is_read = excluded.is_read`), and the `vanished_uids` count is tracked — the data just never arrives.

## Data flow trace

### Flag change scenario
1. Message UID=5 in INBOX, locally stored with `is_read=false`
2. User marks it read in webmail
3. Next poll: `fetch_new_uids(since_high=10)` → `UID SEARCH 11:*` → returns UIDs 11,12 (new messages only)
4. UID=5 is NOT re-fetched → `is_read` stays `false` forever
5. **Breakpoint**: `fetch_new_uids` only queries UIDs > highest known

### Move scenario
1. Message UID=3 in INBOX
2. User moves it to "Archive" in webmail
3. Server: UID 3 expunged from INBOX, new UID 1 assigned in Archive
4. Next poll for INBOX: no new UIDs found, UID 3 still in local DB
5. Next poll for Archive: UID 1 detected as "new" → inserted
6. **Result**: UID 3 persists in INBOX, UID 1 added to Archive → message appears in BOTH folders

## Fix outline (3 files, Phase 0 compatible)

### 1. `sync_engine/imap_source.rs` — Populate `delta.updated` and `delta.vanished_uids`

After fetching new messages, also perform a lightweight flags fetch for ALL UIDs:

```
UID FETCH 1:* (UID FLAGS)
```

Then diff against known local state:
- UID in FETCH response but flags differ from local → populate `delta.updated` with flag-only `RemoteMessage`
- UID in local cursor but NOT in FETCH response → populate `delta.vanished_uids`

### 2. `db/sync_state.rs` — Store known UID set per folder

Add `get_known_uids(pool, account_id, folder_path) -> Vec<u32>` to track which UIDs we expect in each folder. Update after each sync round. This is the ground truth for "what should be here" diff.

### 3. `db/messages.rs` — Delete messages for `vanished_uids`

Currently `vanished_uids.len()` is only used for the count. Add actual deletion in `apply_folder_delta`:

```rust
for uid in &delta.vanished_uids {
    sqlx::query("DELETE FROM messages WHERE account_id = ? AND imap_folder = ? AND imap_uid = ?")
        .bind(account_id).bind(folder_path).bind(*uid as i64)
        .execute(&mut *tx).await?;
}
```

## Cost analysis

- `UID FETCH 1:* (UID FLAGS)` is a single IMAP command returning `(UID FLAGS)` tuples — very cheap (~hundreds of bytes per message, no body)
- For a folder with 10,000 messages, this is ~500KB of response data
- The local diff is O(n) against a HashSet of known UIDs
- This is the standard approach used by Thunderbird, Mailspring, and every other IMAP client for non-CONDSTORE servers

## Related

- Phase 3e QRESYNC plan: `docs/superpowers/plans/2026-06-28-sync-engine-phase3-imap-qresync.md` — QRESYNC would handle this more efficiently via VANISHED and FETCH CHANGEDSINCE
- Phase 3 sync decomposition: `memory/phase3-sync-decomposition.md`
