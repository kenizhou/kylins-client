# Sync Engine Analysis — 2026-07-01

Findings from log and code analysis of the Kylins Client IMAP sync path.
No code changes were made.

---

## 1. `message_bodies.body_html` filled with `<html><body></body></html>` on first load

### Observed behavior
After the first load from the mail server, the `message_bodies` table contains rows whose `body_html` is exactly:

```html
<html><body></body></html>
```

### Root cause
1. The initial folder sync is **headers-only** by design.  
   `src/mail/imap/client.rs:15-29` defines `SYNC_FETCH_QUERY` as `BODY.PEEK[HEADER.FIELDS (...)]`.
2. The raw IMAP response is still parsed by `mail-parser` in `parse_message` (`src/mail/imap/client.rs:2238`).
3. `mail-parser::body_html(0)` auto-synthesizes an HTML representation when a message has no usable body. For a headers-only or otherwise empty-body message it returns the empty HTML document shell `<html><body></body></html>`.
4. `apply_folder_delta` (`src/db/messages.rs:482-494`) inserts into `message_bodies` whenever `m.body_html` is `Some(...)`:

   ```rust
   if let Some(html) = &m.body_html {
       // INSERT OR REPLACE INTO message_bodies ...
   }
   ```

   Because the synthesized shell is `Some(...)`, a row is written for every message even though no real body was fetched.

### Impact
The frontend `EmailRenderer` (`src/components/email/EmailRenderer.tsx:91-92`) sees a non-null `html` prop, treats the message as HTML, and never falls back to the plain-text view. The reading pane renders blank.

### Recommended fix
Normalize the empty shell to `None` in the headers-only sync path, or check for the shell before inserting. Since the sync knows it only fetched headers, the cleanest approach is to drop `body_html`/`body_text` from `ImapMessage` results produced by the headers-only fetchers before they reach `apply_folder_delta`.

---

## 2. Re-login every 100 messages during raw fallback

### Observed behavior
Logs show a fresh `a1 LOGIN` / `a2 SELECT` for every 100-message chunk:

```text
RAW IMAP FETCH: connecting to imap.kylins.com:143 for folder Alerts, UIDs 2,3,...,101
S: a1 OK LOGIN completed.
C: a2 SELECT "Alerts"
RAW IMAP FETCH Alerts: parsed 100 raw messages
...
(repeats)
```

### Root cause
1. The sync engine tries the typed `async-imap` path in 100-UID chunks (`src/sync_engine/imap_source.rs:527`).
2. On this server, `async-imap` hits its known “returns 0 items” quirk on the first chunk, so the engine falls back to raw TCP parsing.
3. The fallback in `src/sync_engine/imap_source.rs:727-774` chooses:
   - `raw_fetch_folder` (single connection) **only** when the entire pending UID list fits in one chunk (≤ 100 UIDs).
   - `raw_fetch_messages` (one connection **per chunk**) when there are multiple chunks.
4. `raw_fetch_messages` (`src/mail/imap/client.rs:1128`) opens a full connection lifecycle for a single UID range:

   ```text
   connect -> LOGIN -> SELECT -> UID FETCH -> close
   ```

   Because IMAP requires authentication and mailbox selection on every new connection, each chunk logs a fresh `LOGIN` + `SELECT`.

### Impact
Folders with more than 100 new messages create many short-lived connections. This is slower and noisier in the logs than necessary.

### Recommended fix
Route any multi-chunk remaining set through `raw_fetch_folder` instead of per-chunk `raw_fetch_messages`. `raw_fetch_folder` already supports internal 100-UID chunking over a single connection.

---

## 3. 30-second polling and repeated CONDSTORE gate logs

### Observed behavior
CONDSTORE gate logs appear for every folder every ~30 seconds:

```text
[sync] CONDSTORE WR gate: caps.condstore=false since_modseq=0 (skipped if 0)
```

### Root cause
1. `src/sync_engine/engine.rs:29` defines `POLL_INTERVAL_SECS = 30`.
2. Every spawned worker runs a 30-second `tokio::time::interval` tick (`src/sync_engine/engine.rs:437-439`) that calls `run_sync_round` regardless of IDLE state.
3. `run_sync_round` iterates all folders and hits the CONDSTORE gate check (`src/sync_engine/imap_source.rs:584` and `:824` for Stage 2).
4. The gate skips CONDSTORE because:
   - `caps.condstore=false` — the server does not advertise the `CONDSTORE` capability, **or**
   - `since_modseq=0` — there is no stored modseq for a first sync.

   Either condition causes the code to skip `FETCH CHANGEDSINCE` and rely on a full UID scan / append-only strategy.

5. An IDLE watcher is also spawned for the INBOX (`src/sync_engine/engine.rs:365-423`) to get near-real-time push notifications, but the 30-second tick is kept as a backstop. The log line `worker channel closed; switching to tick-only poll` means the IDLE watcher’s control channel closed, so the worker stopped listening for `SyncNow` nudges and now relies only on the tick. The tick was already running, so the visible polling interval did not change.

### Impact
- Every folder is re-evaluated every 30 seconds, generating a large burst of gate logs.
- Without `CONDSTORE`, the engine cannot do incremental flag deltas and must scan instead.

### Recommended fix
- If server support is confirmed later, CONDSTORE will automatically be used once `since_modseq > 0`.
- To reduce log noise, the CONDSTORE gate log could be moved to `DEBUG` after first sync, or only logged when the decision changes.
- The 30-second poll interval is documented as an interim measure; it could be made configurable or relaxed once IDLE reliability is proven.
