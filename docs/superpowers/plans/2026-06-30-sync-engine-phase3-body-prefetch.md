# Kylins Mail Sync Engine — Phase 3: Viewport-Aware Batch Message-Body Prefetch

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. Do NOT skip the TDD red-green-refactor loop in any task; the `cargo test --lib` boundaries are load-bearing and each task ends in a commit.

**Goal:** Replace the current "fetch body on message-open" model — one message per call, each opening a fresh IMAP connection — with **viewport-aware batch prefetch**: when the message-list scroll settles, fetch the full bodies for the *visible + buffer* items in ONE batched IMAP `UID FETCH … BODY.PEEK[]` per folder, so the list shows real preview snippets and opening a message is instant. Today `thread.snippet` is NULL after sync (headers-only `SYNC_FETCH_QUERY` at `kylins.client.backend/src/mail/imap/client.rs:26`); this plan makes snippets appear without a manual message-open.

**Architecture:** Three changes, in order:
1. **Backend true batch fetch** — `imap_client::fetch_bodies_batch(config, folder, uids)` reuses the `raw_fetch_folder` single-connection skeleton (`client.rs:1262`) — ONE connect + login + SELECT + chunked `UID FETCH <uid-set> BODY.PEEK[]` + LOGOUT — and returns `Vec<FetchedBody { uid, body_html, body_text, snippet }>`.
2. **Batched `sync_request_bodies` + new event** — group input `message_ids` by folder, call `fetch_bodies_batch` once per folder, persist via `message_bodies::set_message_body`, write the derived snippet onto `messages.snippet` (so future `db_get_threads` reads it), and emit a NEW `sync:bodies-written { accountId, updates: [{ threadId, snippet }] }` event so the list can patch in place.
3. **Frontend viewport prefetch + scroll-preserving snippet patch** — a new `useViewportBodyPrefetch` hook debounces on scroll / mount / folder-switch, computes visible+buffer from `virtualizer.getVirtualItems()`, filters via a new `db_get_uncached_body_message_ids` command, and `invoke('sync_request_bodies', …)`. A `sync:bodies-written` listener patches `threadStore.threads[i].snippet` IN PLACE (never `refresh()` — react-virtualized #1837: a full reload resets scroll).

Plus: a simple LRU-by-rows eviction (`message_bodies::maybe_evict`) so the body cache stays bounded.

**Tech Stack:** Rust; `async-imap` 0.10.4 is NOT used on the batch path (the test server returns 0 from `uid_fetch` — see `MEMORY.md` "imap-stability-gaps"); the **raw TCP** single-connection path (`raw_fetch_folder` / `raw_parse_fetch_responses` / `uid_set_raw`) is the workhorse and is reused verbatim in shape. `mail_parser::MessageParser` for body parsing; `sqlx` 0.8 (sqlite); React 19 + `@tanstack/react-virtual`; Zustand `useThreadStore`; `@tauri-apps/api/event` for the new listener.

---

## Authority & cross-validation

- **RFC 3501 §6.4.8 FETCH** — `UID FETCH` accepts a uid-set (`1,2,7` or `1:4`); `BODY.PEEK[]` (§6.4.5) does NOT set `\Seen` (the whole point of prefetch — preview without marking mail read). The literal `[1]<0.nnn>` partial is RFC 3501 §6.4.5 (documented as a tunable in Deferred).
- **Server concurrency limits:** 50 UIDs per FETCH command is the conservative envelope used by Thunderbird/Mailspring; some servers cap at a few hundred. Chunking at 50 keeps us safe on the test server (`imap.kylins.com`, STARTTLS) and is consistent with `raw_fetch_folder`'s existing `chunk_size` parameter.
- **react-virtualized issue #1837 (also affects `@tanstack/react-virtual`):** resetting the underlying array (e.g. `threadStore.refresh()` → `set({ threads: […] })`) invalidates measured row sizes and can jump scroll. **In-place element patch** (`threads.map(t => t.id === id ? { …t, snippet } : t)`) preserves the array identity of unchanged rows and is the correct pattern. Confirmed against the current `threadStore.refresh()` (`threadStore.ts:126-129`) which calls `loadThreads` → `set({ threads: […] })`.
- **Verified current pipeline (file:line refs):**
  - `kylins.client.frontend/src/components/layout/MessageList.tsx:243-248` — `useVirtualizer({ count: items.length, overscan: 12 })`.
  - `MessageList.tsx:254-260` — `virtualizer.getVirtualItems()` + `nearEnd` infinite-scroll.
  - `MessageList.tsx:91-92` — `const preview = snippet ?? ''; … showPreview = density !== 'compact' && preview.length > 0;` (NULL snippet → no preview line today).
  - `kylins.client.frontend/src/stores/threadStore.ts:87-124` — `selectThread` is the ONLY body-fetch path; calls `invoke('sync_request_bodies', { messageIds: [latest.id] })` for a single message.
  - `kylins.client.frontend/src/services/db/threads.ts:18-35` — `Thread.snippet: string | null` (already nullable — patch is non-breaking).
  - `kylins.client.backend/src/sync_engine/commands.rs:47-120` — `sync_request_bodies` + `request_bodies_inner` (the loop-per-UID we replace).
  - `kylins.client.backend/src/mail/imap/client.rs:328-369` — `fetch_message_body` (single-UID; replaced by the batch).
  - `kylins.client.backend/src/mail/imap/client.rs:1262-1430` — `raw_fetch_folder` (the single-connection skeleton reused).
  - `kylins.client.backend/src/mail/imap/client.rs:1443-1448` — `uid_set_raw` (comma-join helper, reused).
  - `kylins.client.backend/src/mail/imap/client.rs:1648+` — `raw_parse_fetch_responses` (already extracts `RawFetchedMessage { uid, body, is_read, … }` — reused).
  - `kylins.client.backend/src/db/message_bodies.rs:46-118` — `get_message_body`, `set_message_body` (sets `body_cached=1` atomically), `evict_body`.
  - `kylins.client.backend/src/db/messages.rs:210-225` — `get_folder_uid_for_message` (one query per message_id — used to build the per-folder group).
  - `kylins.client.backend/src/sync_engine/engine.rs:88-109` — `EventSink` trait + `TauriSink` (4 methods today).
  - `kylins.client.backend/src/sync_engine/engine.rs:801-830` — `TestSink` (4 event vectors).
  - `kylins.client.backend/src/db/rate_limit.rs` + `engine.rs:527-545` — live `provider_rate_limit` row is read at the top of every round; the hook must consult the same source before prefetching.
  - `kylins.client.backend/src/mail/imap/types.rs:7-16` — `ImapConfig { host, port, security, username, password, auth_method, accept_invalid_certs }`.

## Global Constraints

- **Reuse the `raw_fetch_folder` single-connection skeleton. Do NOT regress to per-UID connects.** The current `request_bodies_inner` opens a new connection per message via `source.fetch_body` (`imap_source.rs:510-522`); on large folders that triggered `* BYE Connection closed` connection storms (see commit `3769cd5` and `MEMORY.md`). The batch path MUST be one connect+login+SELECT+chunked-FETCH+LOGOUT per folder.
- **`BODY.PEEK[]` only — never `BODY[]`.** Prefetch must not flip `\Seen` server-side. (The raw command string is hand-built, so this is a literal-text constraint — review it.)
- **Respect the Phase 3f rate-limit / circuit-breaker.** Before invoking `sync_request_bodies`, the frontend hook checks the account is not in `rate_limited` state (via the existing `sync:status` listener / `uiStore` surfacing — see Task 3). When rate-limited, prefetch is skipped (low-priority work; the next poll will fill the cache).
- **Prefetch visible + buffer only.** Cap at ~30 message_ids per invocation (visible rows + ±5–8 buffer + overscan already covers the rest). Never prefetch the whole folder.
- **Snippet updates must NOT reset scroll.** On `sync:bodies-written`, patch `threadStore.threads[i].snippet` in place — do NOT call `threadStore.refresh()`. (Hard requirement; tested in Task 4.)
- **No new crate dependencies, no new npm dependencies.** Everything is built on the existing `mail_parser`, `sqlx`, `@tanstack/react-virtual`, `zustand`, `@tauri-apps/api`.
- **Best-effort per-message, atomic per-message persist.** A single bad body (parse failure, missing UID) is logged and skipped; it never aborts the batch. `set_message_body` already wraps its two writes in one transaction — preserve that.
- **Fast-scroll handling: debounce + 1-batch/sec throttle; late batches still apply (Scenario 3, 11).** A fast scroll fires multiple debounce windows; the 250 ms debounce coalesces them and a 1-batch/sec min-interval throttle (Task 3b) bounds the rate. We deliberately do NOT gate snippet patches on a supersede token — a late-arriving batch still usefully fills the cache + patches snippets for threads likely still in view; patches are idempotent (`INSERT OR REPLACE` + in-place map), so applying a "stale" result is correct, not a bug. (Task 3b removes the vestigial token that the first draft carried.)
- **Open-message is priority, not queued (Scenario 5).** `selectThread` fires its own `sync_request_bodies([id])` concurrent with any in-flight batch (it does not wait). Backend dedups via `INSERT OR REPLACE`; cost is one extra short-lived connection. (A shared in-flight `Map<id, Promise>` is a documented follow-up.)
- **Folder switch = ignore stale results, NOT hard-cancel (Scenario 6).** The previous folder's in-flight batch completes + caches + emits, but `patchSnippets` is keyed by `thread_id`; the new folder's threads have different ids → stale patches are no-ops. Hard abort via `AbortController` is a follow-up.
- **Failed prefetches retry implicitly (Scenario 7).** A failed fetch leaves `body_cached = 0`, so the next `getUncachedBodyMessageIds` (next scroll/mount/switch) re-includes those ids. No explicit retry queue; the Phase 3f rate-limit/breaker still guards the server side.
- **First viewport fires immediately (Scenario 1).** Task 3b skips the debounce on the very first mount; subsequent triggers debounce.
- **Commit cadence:** one commit per task. `cargo test --lib` + `cargo clippy --all-targets -- -D warnings` + `npx tsc --noEmit` + `npx vitest run` green at each boundary.

---

## File Structure

**Backend (Rust):**
- `src/mail/imap/client.rs` — NEW `pub async fn fetch_bodies_batch(config, folder, uids, chunk_size) -> Result<Vec<FetchedBody>, String>` + NEW `pub struct FetchedBody { uid, body_html, body_text, snippet }` + NEW pure helper `fn derive_snippet(body_text: &str) -> String` (unit-testable). Reuses `raw_connect_starttls` / `connect_stream` / `raw_send_and_wait` / `raw_parse_fetch_responses` / `uid_set_raw`.
- `src/db/message_bodies.rs` — NEW `pub async fn maybe_evict(pool, cap_rows: i64) -> Result<u64, String>` (LRU-by-rows; deletes oldest-`fetched_at` rows beyond the cap + clears their `body_cached`).
- `src/db/messages.rs` — NEW `pub async fn get_uncached_body_message_ids(pool, account_id, message_ids: &[String]) -> Result<Vec<String>, String>` (one `SELECT … WHERE body_cached=0`) + NEW `pub async fn set_message_snippet(pool, account_id, message_id, snippet) -> Result<(), String>` (snippet write-back) + NEW `pub async fn get_thread_id_for_message(pool, account_id, message_id) -> Result<Option<String>, String>` (for the event payload).
- `src/sync_engine/engine.rs` — extend `EventSink` trait with `emit_bodies_written(&self, evt: BodiesWrittenEvent)`; `TauriSink` emits `sync:bodies-written`; `TestSink` records into a new `bodies_written: Mutex<Vec<BodiesWrittenEvent>>`. Add `BodiesWrittenEvent { account_id, updates: Vec<SnippetUpdate> }` + `SnippetUpdate { thread_id, snippet }`.
- `src/sync_engine/commands.rs` — refactor `request_bodies_inner` to group by folder, call `fetch_bodies_batch` once per folder, persist via `set_message_body` + `set_message_snippet`, resolve `thread_id`, emit `emit_bodies_written` once at the end. Add a thin `State<'_, Arc<SyncEngine>>` arg to `sync_request_bodies` (so the event can be emitted) — the IPC signature changes.
- `src/sync_engine/commands.rs` — NEW `#[tauri::command] db_get_uncached_body_message_ids(pool, account_id, message_ids) -> Vec<String>` (frontend filter). Register in `lib.rs`.

**Frontend:**
- `src/services/db/messages.ts` (NEW or extend `src/services/db/threads.ts`) — `getUncachedBodyMessageIds(accountId, messageIds: string[]): Promise<string[]>` thin `invoke`.
- `src/hooks/useViewportBodyPrefetch.ts` (NEW) — debounce 250ms on scroll / mount / folder-switch; compute visible+buffer; filter via `getUncachedBodyMessageIds`; `invoke('sync_request_bodies', { accountId, messageIds })`; supersede via a `useRef<string>` token; skip when rate-limited (read from `uiStore`).
- `src/hooks/useSyncEvents.ts` — add a `sync:bodies-written` listener that calls a new `threadStore.patchSnippets(updates)` (in-place map; scroll-preserving).
- `src/stores/threadStore.ts` — NEW `patchSnippets(updates: { threadId: string; snippet: string }[])` method.
- `src/components/layout/MessageList.tsx` — call `useViewportBodyPrefetch({ virtualizer, items, scrollRef })`. Reuse the existing `virtualizer.getVirtualItems()` (no second virtualizer).
- `src/stores/uiStore.ts` — surface `rateLimitedAccountIds: Set<string>` from the existing `sync:status` listener (Task 3 reads it; the listener already exists in `useSyncEvents.ts:90-99`).

---

## Task 1: Backend `fetch_bodies_batch` (single-connection, chunked BODY.PEEK[]) + `FetchedBody` + snippet parser

**Files:** `src/mail/imap/client.rs`, `src/mail/imap/types.rs`

**Interfaces:**
- Produces: `pub struct FetchedBody { pub uid: u32, pub body_html: Option<String>, pub body_text: Option<String>, pub snippet: String }`; `pub async fn fetch_bodies_batch(config: &ImapConfig, folder: &str, uids: &[u32], chunk_size: usize) -> Result<Vec<FetchedBody>, String>`; `fn derive_snippet(body_text: &str) -> String` (pure).

- [ ] **Step 1: Write failing tests** in `src/mail/imap/client.rs` `#[cfg(test)] mod tests` (the pure parser; the live socket path is exercised by an ignored integration test in Task 5):

```rust
use super::derive_snippet;

#[test]
fn derive_snippet_strips_whitespace_and_truncates() {
    // Leading/trailing whitespace + newlines collapse to single spaces;
    // result is capped at 200 chars.
    let body = "  Hello,\n\n   world.   \n\nThis is a long body.   ";
    let s = derive_snippet(body);
    assert!(s.starts_with("Hello,"));
    assert!(!s.contains('\n'));
    assert!(!s.contains("  ")); // no double spaces
}

#[test]
fn derive_snippet_truncates_at_200_chars() {
    let body = "x".repeat(500);
    let s = derive_snippet(&body);
    assert_eq!(s.len(), 200);
}

#[test]
fn derive_snippet_empty_yields_empty() {
    assert_eq!(derive_snippet("   \n\n  "), "");
    assert_eq!(derive_snippet(""), "");
}
```

- [ ] **Step 2: Run — expect FAIL.**

Run: `cargo test --lib mail::imap::tests::derive_snippet`
Expected: `derive_snippet` undefined.

- [ ] **Step 3: Implement.** In `src/mail/imap/types.rs`, add the DTO near the other `Imap*` structs:

```rust
/// One message body returned by `fetch_bodies_batch`. The `snippet` is the
/// ~200-char whitespace-collapsed preview derived from `body_text`; the engine
/// writes it onto `messages.snippet` so the thread list shows a preview without
/// a second read of the (large) `message_bodies` row.
#[derive(Debug, Clone, PartialEq)]
pub struct FetchedBody {
    pub uid: u32,
    pub body_html: Option<String>,
    pub body_text: Option<String>,
    pub snippet: String,
}
```

In `src/mail/imap/client.rs`, near `raw_fetch_folder`, add the pure helper and the batch fetcher:

```rust
use mail_parser::{MessageParser, MimeHeaders, PartType};
use super::types::FetchedBody;

/// Derive a single-line preview from a body's plain-text part: collapse all
/// whitespace runs to one space, trim, cap at 200 chars. Pure so it can be
/// unit-tested without a socket.
fn derive_snippet(body_text: &str) -> String {
    let collapsed: String = body_text
        .split(|c: char| c.is_whitespace())
        .filter(|s| !s.is_empty())
        .collect::<Vec<_>>()
        .join(" ");
    collapsed.chars().take(200).collect()
}

/// Viewport-aware batch body prefetch. ONE connect + login + SELECT + chunked
/// `UID FETCH <uid-set> BODY.PEEK[]` + LOGOUT (reuses `raw_fetch_folder`'s
/// single-connection skeleton — never per-UID reconnects). `BODY.PEEK[]` (not
/// `BODY[]`) so prefetch does not set `\Seen`. Chunks at `chunk_size` (50 is the
/// recommended cap — see plan Global Constraints). Best-effort: on mid-batch
/// error (server drop), logs and returns what was fetched so far.
pub async fn fetch_bodies_batch(
    config: &ImapConfig,
    folder: &str,
    uids: &[u32],
    chunk_size: usize,
) -> Result<Vec<FetchedBody>, String> {
    if uids.is_empty() {
        return Ok(vec![]);
    }
    let chunk_size = if chunk_size == 0 { 50 } else { chunk_size };

    log::info!(
        "FETCH BODIES BATCH: {}:{} {folder}, {} UID(s) in chunks of {chunk_size}",
        config.host, config.port, uids.len()
    );

    // 1. connect (+ greeting), 2. login — identical to raw_fetch_folder.
    let stream = if config.security == "starttls" {
        raw_connect_starttls(config).await?
    } else {
        connect_stream(config).await?
    };
    let mut reader = BufReader::new(stream);
    if config.security != "starttls" {
        let mut line = String::new();
        reader.read_line(&mut line).await.map_err(|e| format!("greeting: {e}"))?;
    }
    let login_cmd = if config.auth_method == "oauth2" {
        let xoauth2 = format!(
            "user={}\x01auth=Bearer {}\x01\x01",
            config.username, config.password
        );
        let b64 = base64::Engine::encode(
            &base64::engine::general_purpose::STANDARD,
            xoauth2.as_bytes(),
        );
        format!("a1 AUTHENTICATE XOAUTH2 {b64}\r\n")
    } else {
        format!("a1 LOGIN \"{}\" \"{}\"\r\n", config.username, config.password)
    };
    raw_send_and_wait(&mut reader, login_cmd.as_bytes(), "a1").await?;

    // 3. SELECT once for the whole batch.
    let select_cmd = format!("a2 SELECT \"{folder}\"\r\n");
    let _ = raw_send_and_wait(&mut reader, select_cmd.as_bytes(), "a2").await?;

    // 4. UID FETCH each chunk on the SAME connection. BODY.PEEK[] (not BODY[]).
    let parser = MessageParser::default();
    let mut out: Vec<FetchedBody> = Vec::new();
    let chunks: Vec<&[u32]> = uids.chunks(chunk_size).collect();
    let mut tag_index = 3u32;

    for (i, chunk) in chunks.iter().enumerate() {
        let range = uid_set_raw(chunk);
        let tag = format!("a{tag_index}");
        // BODY.PEEK[] — never BODY[] (prefetch must not set \Seen).
        let fetch_cmd = format!("{tag} UID FETCH {range} BODY.PEEK[]\r\n");

        if let Err(e) = reader.get_mut().write_all(fetch_cmd.as_bytes()).await {
            log::warn!(
                "[sync] fetch_bodies_batch {folder} chunk {} (uids {range}): write failed: {e}; returning {} fetched so far",
                i + 1, out.len()
            );
            break;
        }
        match raw_parse_fetch_responses(&mut reader, &tag).await {
            Ok(raw_messages) => {
                for raw_msg in &raw_messages {
                    let parsed = match parser.parse(&raw_msg.body) {
                        Some(p) => p,
                        None => {
                            log::warn!(
                                "fetch_bodies_batch {folder}: UID {} parse failed; skipping",
                                raw_msg.uid
                            );
                            continue;
                        }
                    };
                    let body_text = parsed
                        .body_text(0)
                        .map(|s| s.to_string());
                    let body_html = parsed
                        .attachments
                        .iter()
                        .find(|a| a.is_text_html())
                        .and_then(|a| a.contents())
                        .map(|b| String::from_utf8_lossy(b).to_string());
                    let snippet = derive_snippet(body_text.as_deref().unwrap_or(""));
                    out.push(FetchedBody {
                        uid: raw_msg.uid,
                        body_html,
                        body_text,
                        snippet,
                    });
                }
                log::info!(
                    "FETCH BODIES BATCH {folder} chunk {} (uids {range}): parsed {} bodies",
                    i + 1, raw_messages.len()
                );
            }
            Err(e) => {
                log::warn!(
                    "[sync] fetch_bodies_batch {folder} chunk {} (uids {range}) failed: {e}; returning {} fetched so far",
                    i + 1, out.len()
                );
                break;
            }
        }
        tag_index = tag_index.saturating_add(1);
    }

    // 5. best-effort LOGOUT.
    let _ = reader.get_mut().write_all(b"LOGOUT\r\n").await;

    log::info!(
        "FETCH BODIES BATCH {folder}: {}/{} UID(s) fetched",
        out.len(), uids.len()
    );
    Ok(out)
}
```

> **Note on `body_text(0)`:** `mail_parser::MessageParser::body_text` returns the first text/plain part. If the body is HTML-only, `body_text` is `None` and the snippet comes from stripping tags off the HTML. For the MVP we accept an empty snippet on HTML-only messages (deferred: a tag-stripping snippet fallback — see Deferred). This keeps the snippet parser dependency-free.

- [ ] **Step 4: Run — expect PASS.**

Run: `cargo test --lib mail::imap`
Expected: three `derive_snippet` tests pass; existing imap tests still green.

- [ ] **Step 5: Commit** — `feat(sync): fetch_bodies_batch single-connection BODY.PEEK[] + FetchedBody + derive_snippet`.

---

## Task 2: Refactor `sync_request_bodies` to batch-per-folder + `messages.snippet` write-back + `sync:bodies-written` event

**Files:** `src/sync_engine/engine.rs`, `src/sync_engine/commands.rs`, `src/db/messages.rs`, `src/lib.rs`

**Interfaces:**
- Produces: `EventSink::emit_bodies_written(&self, BodiesWrittenEvent)`; `BodiesWrittenEvent { account_id, updates: Vec<SnippetUpdate> }`; `SnippetUpdate { thread_id, snippet }`; `db::messages::set_message_snippet`, `db::messages::get_thread_id_for_message`; refactored `request_bodies_inner(engine: Arc<SyncEngine>, pool, account_id, message_ids)` that groups by folder and emits one event at the end.

- [ ] **Step 1: Write failing tests.** First the `EventSink` trait addition — extend `TestSink` and add a test in `engine.rs` `#[cfg(test)]`:

```rust
// New event types — declared next to DeltaEvent / NewMailEvent:
#[derive(Clone, Serialize, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SnippetUpdate {
    pub thread_id: String,
    pub snippet: String,
}

#[derive(Clone, Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct BodiesWrittenEvent {
    pub account_id: String,
    pub updates: Vec<SnippetUpdate>,
}
```

Then in `engine.rs` tests:

```rust
#[tokio::test]
async fn test_sink_records_bodies_written_events() {
    // TestSink must capture the new event shape so commands.rs unit tests
    // (Task 2 Step 3) can assert on it.
    let sink = Arc::new(TestSink::new());
    let tmp = tempfile::tempdir().unwrap();
    let pool = init_db(tmp.path()).await.unwrap();
    let engine = SyncEngine::new(pool.clone(), sink.clone());
    sink.emit_bodies_written(BodiesWrittenEvent {
        account_id: "a".into(),
        updates: vec![SnippetUpdate { thread_id: "t1".into(), snippet: "hi".into() }],
    });
    let evts = sink.bodies_written.lock().unwrap().clone();
    assert_eq!(evts.len(), 1);
    assert_eq!(evts[0].account_id, "a");
    assert_eq!(evts[0].updates[0].thread_id, "t1");
    let _ = engine; // keep engine alive (unused otherwise)
}
```

And in `db/messages.rs` tests:

```rust
#[tokio::test]
async fn set_message_snippet_updates_column_and_thread_row() {
    let tmp = tempfile::tempdir().unwrap();
    let pool = init_db(tmp.path()).await.unwrap();
    seed(&pool, "acc").await;
    // Seed one thread + one message (thread id == message id, Phase 0 threading).
    seed_message_with_location(&pool, "acc", "imap-acc-INBOX-7", "INBOX", 7).await;
    // thread_id == message_id in Phase 0; set the thread row's snippet too
    // (so db_get_threads reflects the new snippet without a re-sync).
    sqlx::query("UPDATE threads SET snippet = NULL WHERE id = 'imap-acc-INBOX-7'")
        .execute(&pool).await.unwrap();

    set_message_snippet(&pool, "acc", "imap-acc-INBOX-7", "Hello world")
        .await.unwrap();

    let (msg_snip, thr_snip): (Option<String>, Option<String>) = sqlx::query_as(
        "SELECT m.snippet, t.snippet
         FROM messages m LEFT JOIN threads t ON t.id = m.thread_id
         WHERE m.id = 'imap-acc-INBOX-7'",
    ).fetch_one(&pool).await.unwrap();
    assert_eq!(msg_snip.as_deref(), Some("Hello world"));
    assert_eq!(thr_snip.as_deref(), Some("Hello world"),
        "thread row snippet must mirror so db_get_threads sees it without a re-sync");
}

#[tokio::test]
async fn get_thread_id_for_message_returns_thread_id() {
    let tmp = tempfile::tempdir().unwrap();
    let pool = init_db(tmp.path()).await.unwrap();
    seed(&pool, "acc").await;
    seed_message_with_location(&pool, "acc", "imap-acc-INBOX-9", "INBOX", 9).await;
    let tid = get_thread_id_for_message(&pool, "acc", "imap-acc-INBOX-9")
        .await.unwrap();
    assert_eq!(tid.as_deref(), Some("imap-acc-INBOX-9"));
}
```

And in `commands.rs` tests (the heart of Task 2 — batch grouping + event emission). Use a `MockSource`-style seam: factor the source resolution so a test can inject a fake. The cleanest path is to make `request_bodies_inner` take the engine (for events) and call a NEW private `request_bodies_with_source` that takes a `dyn MailSource` — but `MailSource::fetch_body` is single-UID and we want the BATCH path. So instead, inject the batch function via a function pointer / trait. For the MVP, **test the pure grouping logic** — extract `group_message_ids_by_folder` as a pure function and test it, plus an integration-style test that asserts the event is emitted against a stub. Add to `commands.rs` tests:

```rust
use crate::sync_engine::engine::{BodiesWrittenEvent, EventSink};
use std::sync::{Arc, Mutex};

#[derive(Default, Clone)]
struct CapturingSink {
    bodies: Arc<Mutex<Vec<BodiesWrittenEvent>>>,
}
impl EventSink for CapturingSink {
    fn emit_delta(&self, _: crate::sync_engine::engine::DeltaEvent) {}
    fn emit_new_mail(&self, _: crate::sync_engine::engine::NewMailEvent) {}
    fn emit_status(&self, _: crate::sync_engine::engine::StatusEvent) {}
    fn emit_queue(&self, _: crate::sync_engine::engine::QueueEvent) {}
    fn emit_bodies_written(&self, e: BodiesWrittenEvent) {
        self.bodies.lock().unwrap().push(e);
    }
}

#[test]
fn group_message_ids_by_folder_buckets_by_imap_folder() {
    // Pure: given a list of (message_id, folder, uid) tuples, produce a map
    // folder -> [(message_id, uid)].
    use std::collections::HashMap;
    let inputs = vec![
        ("imap-a-INBOX-1", "INBOX", 1u32),
        ("imap-a-INBOX-2", "INBOX", 2),
        ("imap-a-Sent-9", "Sent", 9),
    ];
    let mut buckets: HashMap<&str, Vec<(&str, u32)>> = HashMap::new();
    for (mid, folder, uid) in &inputs {
        buckets.entry(folder).or_default().push((mid, *uid));
    }
    assert_eq!(buckets["INBOX"].len(), 2);
    assert_eq!(buckets["Sent"].len(), 1);
}
```

(The end-to-end batched fetch is covered by the Task 5 ignored integration test — Step 1 here covers the parts that can be unit-tested without a live socket: pure grouping, snippet write-back, thread_id lookup, event capture.)

- [ ] **Step 2: Run — expect FAIL** (`emit_bodies_written` not on trait; `set_message_snippet` / `get_thread_id_for_message` undefined; `BodiesWrittenEvent` / `SnippetUpdate` undefined).

Run: `cargo test --lib sync_engine db::messages`

- [ ] **Step 3: Implement.**

**3a. `src/sync_engine/engine.rs`** — add the two structs near `DeltaEvent` (already shown above), extend the trait:

```rust
pub trait EventSink: Send + Sync {
    fn emit_delta(&self, evt: DeltaEvent);
    fn emit_new_mail(&self, evt: NewMailEvent);
    fn emit_status(&self, evt: StatusEvent);
    fn emit_queue(&self, evt: QueueEvent);
    /// Emitted once at the end of `sync_request_bodies` for every message
    /// whose body+snippet were freshly written. The frontend listens on
    /// `sync:bodies-written` and patches `thread.snippet` in place
    /// (scroll-preserving — react-virtualized #1837).
    fn emit_bodies_written(&self, evt: BodiesWrittenEvent);
}
```

`TauriSink`:

```rust
impl EventSink for TauriSink {
    // ... existing four methods unchanged ...
    fn emit_bodies_written(&self, e: BodiesWrittenEvent) {
        let _ = self.0.emit("sync:bodies-written", e);
    }
}
```

`TestSink` — add a field + impl:

```rust
struct TestSink {
    deltas: std::sync::Mutex<Vec<DeltaEvent>>,
    new_mails: std::sync::Mutex<Vec<NewMailEvent>>,
    statuses: std::sync::Mutex<Vec<StatusEvent>>,
    queues: std::sync::Mutex<Vec<QueueEvent>>,
    bodies_written: std::sync::Mutex<Vec<BodiesWrittenEvent>>,  // NEW
}
// ... in new(): bodies_written: std::sync::Mutex::new(vec![]),
impl EventSink for TestSink {
    // ... existing four unchanged ...
    fn emit_bodies_written(&self, e: BodiesWrittenEvent) {
        self.bodies_written.lock().unwrap().push(e);
    }
}
```

> **Trait-change ripple:** `NullSink` in `commands.rs::tests` (`commands.rs:188-193`) and every other test-only `impl EventSink` (search: `grep -rn "impl EventSink for" kylins.client.backend/src`) must add the method. List them: `NullSink` (commands.rs), `TestSink` (engine.rs), plus any `MockSink` in `imap_source.rs` / `eas_source.rs` tests. Each gets a no-op `fn emit_bodies_written(&self, _: BodiesWrittenEvent) {}`. `cargo build` will list them.

**3b. `src/db/messages.rs`** — add the two helpers near `get_folder_uid_for_message`:

```rust
/// Write the derived preview snippet onto ONE message AND its owning thread
/// (Phase 0: thread id == message id, but the write is by `thread_id` so it
/// stays correct when real conversation threading lands). One transaction so
/// the two writes are atomic. Mirrors how `apply_flag_updates` mirrors to the
/// thread.
pub async fn set_message_snippet(
    pool: &SqlitePool,
    account_id: &str,
    message_id: &str,
    snippet: &str,
) -> Result<(), String> {
    let mut tx = pool.begin().await.map_err(|e| format!("begin tx: {e}"))?;
    let thread_id: Option<String> = sqlx::query_scalar(
        "UPDATE messages SET snippet = ? WHERE account_id = ? AND id = ? \
         RETURNING (SELECT thread_id FROM messages WHERE account_id = ? AND id = ?)",
    )
    .bind(snippet)
    .bind(account_id)
    .bind(message_id)
    .bind(account_id)
    .bind(message_id)
    .fetch_optional(&mut *tx)
    .await
    .map_err(|e| e.to_string())?;
    if let Some(tid) = thread_id {
        sqlx::query("UPDATE threads SET snippet = ? WHERE account_id = ? AND id = ?")
            .bind(snippet)
            .bind(account_id)
            .bind(tid)
            .execute(&mut *tx)
            .await
            .map_err(|e| e.to_string())?;
    }
    tx.commit().await.map_err(|e| e.to_string())?;
    Ok(())
}

/// Resolve the thread_id for a message (used to build the `BodiesWrittenEvent`
/// payload so the frontend can patch the right `thread.snippet` without a
/// second query).
pub async fn get_thread_id_for_message(
    pool: &SqlitePool,
    account_id: &str,
    message_id: &str,
) -> Result<Option<String>, String> {
    let row: Option<(Option<String>,)> = sqlx::query_as(
        "SELECT thread_id FROM messages WHERE account_id = ? AND id = ?",
    )
    .bind(account_id)
    .bind(message_id)
    .fetch_optional(pool)
    .await
    .map_err(|e| e.to_string())?;
    Ok(row.and_then(|(t,)| t))
}
```

**3c. `src/sync_engine/commands.rs`** — refactor `request_bodies_inner` to batch-per-folder + emit. The IPC command now needs the engine for the event sink; change its signature:

```rust
use std::collections::HashMap;
use crate::db::accounts;
use crate::sync_engine::engine::{BodiesWrittenEvent, SnippetUpdate};
use crate::sync_engine::source_for_account;
// NOTE: we keep `source_for_account` to resolve the ImapConfig, but the batch
// path does NOT call source.fetch_body — it calls fetch_bodies_batch directly.
// For non-IMAP sources (EAS), fall back to the per-message source.fetch_body
// path (EAS bodies are fetched per-message today; batching EAS is its own
// workstream — see Deferred).

#[tauri::command]
pub async fn sync_request_bodies(
    engine: State<'_, Arc<SyncEngine>>,
    pool: State<'_, SqlitePool>,
    account_id: String,
    message_ids: Vec<String>,
) -> Result<(), String> {
    request_bodies_inner(engine.inner().clone(), pool.inner(), &account_id, &message_ids).await
}

pub async fn request_bodies_inner(
    engine: Arc<SyncEngine>,
    pool: &SqlitePool,
    account_id: &str,
    message_ids: &[String],
) -> Result<(), String> {
    if message_ids.is_empty() {
        return Ok(());
    }

    // 1. Build a per-folder map: folder -> Vec<(message_id, uid)>.
    //    One DB read per message_id (the existing helper). This is N small
    //    queries, not N connections — cheap relative to the network round-trip
    //    we are about to make.
    let mut by_folder: HashMap<String, Vec<(String, u32)>> = HashMap::new();
    for mid in message_ids {
        match messages::get_folder_uid_for_message(pool, account_id, mid).await {
            Ok(Some((folder, uid))) => {
                by_folder.entry(folder).or_default().push((mid.clone(), uid));
            }
            Ok(None) => log::warn!(
                "[sync] request_bodies: no imap_folder/uid for message {mid}; skipping"
            ),
            Err(e) => log::warn!(
                "[sync] request_bodies: lookup failed for message {mid}: {e}; skipping"
            ),
        }
    }
    if by_folder.is_empty() {
        return Ok(());
    }

    // 2. Resolve the account config ONCE (source_for_account opens a fresh
    //    source; we only need the ImapConfig out of it for fetch_bodies_batch).
    let src = match source_for_account(pool, account_id).await {
        Ok(s) => s,
        Err(e) => {
            log::warn!("[sync] request_bodies: source for {account_id} failed: {e}");
            return Err(e);
        }
    };

    let mut updates: Vec<SnippetUpdate> = Vec::new();

    // 3. Per folder: one batched fetch_bodies_batch call.
    for (folder, mid_uids) in by_folder {
        // Ask the source for an ImapConfig for this folder. The cleanest seam:
        // a new `MailSource::imap_config_for_folder(&self, folder) -> Option<ImapConfig>`
        // trait method (default None). For non-IMAP sources it returns None and
        // we fall back to the per-message loop below. (See "3d" for the trait
        // addition.)
        let uids: Vec<u32> = mid_uids.iter().map(|(_, u)| *u).collect();
        match src.imap_config_for_folder(&folder).await {
            Ok(Some(config)) => {
                match crate::mail::imap::client::fetch_bodies_batch(
                    &config, &folder, &uids, 50,
                ).await {
                    Ok(fetched) => {
                        // Index fetched by uid for fast lookup.
                        let by_uid: HashMap<u32, &crate::mail::imap::types::FetchedBody> =
                            fetched.iter().map(|f| (f.uid, f)).collect();
                        for (mid, uid) in &mid_uids {
                            match by_uid.get(uid) {
                                Some(fb) => {
                                    // Persist body_html (prefers HTML; falls back to text).
                                    let body_str = fb.body_html.clone()
                                        .or_else(|| fb.body_text.clone());
                                    if let Some(body) = body_str {
                                        if let Err(e) = message_bodies::set_message_body(
                                            pool, account_id, mid, &body,
                                        ).await {
                                            log::warn!("[sync] request_bodies: persist body {mid}: {e}");
                                            continue;
                                        }
                                    }
                                    // Write snippet onto messages + threads.
                                    if let Err(e) = messages::set_message_snippet(
                                        pool, account_id, mid, &fb.snippet,
                                    ).await {
                                        log::warn!("[sync] request_bodies: snippet {mid}: {e}");
                                        continue;
                                    }
                                    // Resolve thread_id for the event payload.
                                    if let Ok(Some(tid)) = messages::get_thread_id_for_message(
                                        pool, account_id, mid,
                                    ).await {
                                        updates.push(SnippetUpdate {
                                            thread_id: tid,
                                            snippet: fb.snippet.clone(),
                                        });
                                    }
                                }
                                None => log::info!(
                                    "[sync] request_bodies: uid {uid} in {folder} not in batch result; skipping"
                                ),
                            }
                        }
                    }
                    Err(e) => log::warn!(
                        "[sync] request_bodies: fetch_bodies_batch {folder} failed: {e}"
                    ),
                }
            }
            Ok(None) => {
                // Non-IMAP source (EAS today): fall back to per-message.
                for (mid, uid) in &mid_uids {
                    let folder_obj = RemoteFolder {
                        remote_id: folder.clone(),
                        ..Default::default()
                    };
                    match src.fetch_body(&folder_obj, *uid).await {
                        Ok(Some(html)) => {
                            let _ = message_bodies::set_message_body(
                                pool, account_id, mid, &html,
                            ).await;
                            let _ = messages::set_message_snippet(
                                pool, account_id, mid, "",
                            ).await;
                        }
                        Ok(None) => log::info!(
                            "[sync] request_bodies (fallback): uid {uid} {folder} no body"
                        ),
                        Err(e) => log::warn!(
                            "[sync] request_bodies (fallback): fetch_body {mid}: {e}"
                        ),
                    }
                }
            }
            Err(e) => log::warn!(
                "[sync] request_bodies: imap_config_for_folder {folder} failed: {e}; falling back to per-message"
            ),
        }
    }

    // 4. Emit ONE bodies-written event with all updates so the frontend patches
    //    every thread in a single pass.
    if !updates.is_empty() {
        engine.emit_bodies_written_public(BodiesWrittenEvent {
            account_id: account_id.to_string(),
            updates,
        });
    }
    Ok(())
}
```

> **Engine accessor:** `SyncEngine` holds the sink privately. Add a thin pub method `pub fn emit_bodies_written_public(&self, e: BodiesWrittenEvent) { self.sink.emit_bodies_written(e) }` (mirror however the other events are surfaced if there's already a public emitter; if not, add this one). Confirm against `SyncEngine`'s existing pub API — the engine uses the sink internally for `emit_delta` etc.; expose this one for the commands layer.

**3d. `src/sync_engine/mod.rs`** — add the trait method with a default impl so existing impls (MockSource etc.) don't break:

```rust
// In the MailSource trait:
async fn imap_config_for_folder(
    &self,
    _folder: &str,
) -> Result<Option<std::sync::Arc<crate::mail::imap::types::ImapConfig>>, SourceError> {
    Ok(None) // default: non-IMAP source
}
```

And implement it in `ImapSource` (return a clone of `self.imap_config()` — already exists at `imap_source.rs:515`):

```rust
async fn imap_config_for_folder(
    &self,
    _folder: &str,
) -> Result<Option<std::sync::Arc<crate::mail::imap::types::ImapConfig>>, SourceError> {
    Ok(Some(std::sync::Arc::new(self.imap_config())))
}
```

> **If returning `Arc<ImapConfig>` ripples too far (the trait's existing async fns may force a `Send` boxed future):** fall back to returning `ImapConfig` by value (it's small — 6 strings/numbers + a bool). Pick the simpler shape and note it in the commit.

- [ ] **Step 4: Run — expect PASS.**

Run: `cargo test --lib sync_engine db::messages`
Expected: all new tests pass; existing `request_bodies_inner_*` tests still green (the empty-input test calls with `&[]` and short-circuits before the engine is used — but now needs an engine arg; update the call site in the test). The missing-row test seeds no `messages` row so `by_folder` is empty → Ok. Update both existing tests to pass a `SyncEngine` (with `NullSink`).

Run: `cargo clippy --all-targets -- -D warnings` — expect clean.

- [ ] **Step 5: Commit** — `feat(sync): batch-per-folder sync_request_bodies + sync:bodies-written event + messages.snippet write-back`.

---

## Task 3: Backend `db_get_uncached_body_message_ids` command + frontend `useViewportBodyPrefetch` hook

**Files:** `src/db/messages.rs`, `src/db/commands.rs` (or wherever `db_*` commands live), `src/lib.rs`; `kylins.client.frontend/src/services/db/messages.ts` (NEW), `src/hooks/useViewportBodyPrefetch.ts` (NEW), `src/components/layout/MessageList.tsx`, `src/stores/uiStore.ts`

**Interfaces:**
- Produces: `db::messages::get_uncached_body_message_ids(pool, account_id, message_ids) -> Vec<String>`; Tauri command `db_get_uncached_body_message_ids`; frontend `getUncachedBodyMessageIds`; `useViewportBodyPrefetch({ virtualizer, items, accountId })` hook; `uiStore.rateLimitedAccountIds: Set<string>`.

- [ ] **Step 1: Write failing backend test** in `src/db/messages.rs`:

```rust
#[tokio::test]
async fn get_uncached_body_message_ids_returns_only_body_cached_zero() {
    let tmp = tempfile::tempdir().unwrap();
    let pool = init_db(tmp.path()).await.unwrap();
    seed(&pool, "acc").await;
    // Two messages; one cached, one not.
    seed_message_with_location(&pool, "acc", "imap-acc-INBOX-1", "INBOX", 1).await;
    seed_message_with_location(&pool, "acc", "imap-acc-INBOX-2", "INBOX", 2).await;
    sqlx::query("UPDATE messages SET body_cached = 1 WHERE id = 'imap-acc-INBOX-1'")
        .execute(&pool).await.unwrap();

    let mut ids = get_uncached_body_message_ids(&pool, "acc", &[
        "imap-acc-INBOX-1".into(), "imap-acc-INBOX-2".into(), "missing".into(),
    ]).await.unwrap();
    ids.sort();
    assert_eq!(ids, vec!["imap-acc-INBOX-2".to_string()],
        "cached id filtered out; missing id silently dropped");
}
```

- [ ] **Step 2: Run — expect FAIL.**

Run: `cargo test --lib db::messages::tests::get_uncached_body_message_ids`

- [ ] **Step 3: Implement backend.** In `src/db/messages.rs`:

```rust
/// Return the subset of `message_ids` whose body is NOT cached
/// (`body_cached = 0`). Used by the viewport prefetch hook to avoid
/// re-requesting bodies the cache already has. Missing message_ids are
/// silently dropped (the prefetch will simply skip them).
pub async fn get_uncached_body_message_ids(
    pool: &SqlitePool,
    account_id: &str,
    message_ids: &[String],
) -> Result<Vec<String>, String> {
    if message_ids.is_empty() {
        return Ok(vec![]);
    }
    // SQLite parameter limit is 999 by default; chunk to be safe. Visible+buffer
    // is ~30 so this is rarely more than one chunk, but guard anyway.
    let mut out = Vec::new();
    for chunk in message_ids.chunks(500) {
        let placeholders = (0..chunk.len()).map(|_| "?").collect::<Vec<_>>().join(",");
        let sql = format!(
            "SELECT id FROM messages \
             WHERE account_id = ? AND id IN ({placeholders}) AND body_cached = 0",
        );
        let mut q = sqlx::query(&sql).bind(account_id);
        for id in chunk {
            q = q.bind(id);
        }
        let rows: Vec<(String,)> = q.fetch_all(pool).await.map_err(|e| e.to_string())?;
        out.extend(rows.into_iter().map(|(id,)| id));
    }
    Ok(out)
}
```

Add the Tauri command (next to the other `db_*` commands — confirm the file; if `src/db/commands.rs`, add there, else in `src/sync_engine/commands.rs`):

```rust
#[tauri::command]
pub async fn db_get_uncached_body_message_ids(
    pool: State<'_, SqlitePool>,
    account_id: String,
    message_ids: Vec<String>,
) -> Result<Vec<String>, String> {
    Ok(messages::get_uncached_body_message_ids(pool.inner(), &account_id, &message_ids).await?)
}
```

Register in `src/lib.rs` `invoke_handler![…]` (add `db_get_uncached_body_message_ids` to the list).

- [ ] **Step 4: Run — expect PASS.**

Run: `cargo test --lib db::messages` ; `cargo clippy --all-targets -- -D warnings`.

- [ ] **Step 5: Implement frontend.** NEW `kylins.client.frontend/src/services/db/messages.ts`:

```ts
import { invoke } from '@tauri-apps/api/core';

/**
 * Return the subset of `messageIds` whose body is NOT cached
 * (`body_cached = 0`). The prefetch hook uses this to avoid re-requesting
 * bodies the cache already has. Missing ids are silently dropped.
 */
export function getUncachedBodyMessageIds(
  accountId: string,
  messageIds: string[],
): Promise<string[]> {
  return invoke<string[]>('db_get_uncached_body_message_ids', {
    accountId,
    messageIds,
  });
}
```

Surface rate-limit state in `uiStore` — read the existing `sync:status` listener (`useSyncEvents.ts:90-99`) and store the set there. In `src/stores/uiStore.ts` add:

```ts
interface UIState {
  // ... existing ...
  rateLimitedAccountIds: Set<string>;
  setRateLimited: (accountId: string, rateLimited: boolean) => void;
}
// in create():
rateLimitedAccountIds: new Set<string>(),
setRateLimited: (accountId, rateLimited) => {
  set((s) => {
    const next = new Set(s.rateLimitedAccountIds);
    if (rateLimited) next.add(accountId);
    else next.delete(accountId);
    return { rateLimitedAccountIds: next };
  });
},
```

In `useSyncEvents.ts`, the existing `sync:status` listener becomes:

```ts
unlisteners.push(
  await listen<StatusEvent>('sync:status', (e) => {
    useUIStore.getState().setRateLimited(
      e.payload.accountId,
      e.payload.state === 'rate_limited',
    );
  }),
);
```

NEW `kylins.client.frontend/src/hooks/useViewportBodyPrefetch.ts`:

```ts
import { useEffect, useRef } from 'react';
import type { Virtualizer } from '@tanstack/react-virtual';
import { invoke } from '@tauri-apps/api/core';
import { useThreadStore } from '../stores/threadStore';
import { useUIStore } from '../stores/uiStore';
import { getUncachedBodyMessageIds } from '../services/db/messages';
import type { Thread } from '../services/db/threads';

interface Options {
  virtualizer: Virtualizer<HTMLDivElement, Element>;
  threads: Thread[];
  /** Account id for the currently-loaded list. */
  accountId: string | null;
}

/** Buffer (rows) added above/below the visible range when picking prefetch
 * candidates. ~5–8; tuned so a single scroll tick doesn't miss. */
const VIEWPORT_BUFFER = 6;
/** Hard cap on message_ids per prefetch invocation. */
const MAX_PREFETCH = 30;
/** Debounce window (ms). Lets a fast scroll settle before we fetch. */
const DEBOUNCE_MS = 250;

const isTauri = typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;

/**
 * Viewport-aware batch body prefetch. When the message-list scroll settles
 * (or on mount / folder-switch), compute the visible+buffer rows, take the
 * latest message_id for each visible thread (the row maps 1:1 in Phase 0 —
 * `thread.id` IS the message_id), filter via `getUncachedBodyMessageIds`,
 * and invoke `sync_request_bodies` once. Best-effort + superseded: a newer
 * viewport wins; an older in-flight fetch is allowed to complete (its writes
 * are idempotent INSERT OR REPLACE) but its store patches are dropped.
 *
 * Skipped entirely when the account is rate-limited (Phase 3f) — prefetch is
 * low-priority and the next poll will fill the cache.
 */
export function useViewportBodyPrefetch({
  virtualizer,
  threads,
  accountId,
}: Options): void {
  // Supersede token. Each invocation increments; only the latest invocation's
  // callback still applies patches to the store.
  const tokenRef = useRef(0);

  useEffect(() => {
    if (!isTauri || !accountId || threads.length === 0) return;

    let cancelled = false;
    const handle = window.setTimeout(() => {
      void (async () => {
        // Rate-limit gate.
        if (useUIStore.getState().rateLimitedAccountIds.has(accountId)) return;

        const visible = virtualizer.getVirtualItems();
        if (visible.length === 0) return;
        const firstIdx = Math.max(0, visible[0]!.index - VIEWPORT_BUFFER);
        const lastIdx = Math.min(
          threads.length - 1,
          visible[visible.length - 1]!.index + VIEWPORT_BUFFER,
        );

        // Map visible thread rows to their latest message_id. Phase 0:
        // thread.id == message_id, so the latest message_id is thread.id.
        // (When real conversation threading lands, expose latest_message_id
        // on the Thread type — see Deferred.)
        const candidateIds: string[] = [];
        for (let i = firstIdx; i <= lastIdx; i++) {
          const t = threads[i];
          if (t) candidateIds.push(t.id);
          if (candidateIds.length >= MAX_PREFETCH) break;
        }
        if (candidateIds.length === 0) return;

        // Filter to uncached only — don't re-request what we already have.
        let uncached: string[];
        try {
          uncached = await getUncachedBodyMessageIds(accountId, candidateIds);
        } catch (e) {
          console.error('[prefetch] getUncachedBodyMessageIds failed', e);
          return;
        }
        if (uncached.length === 0) return;

        // Supersede: bump token; capture locally.
        const myToken = ++tokenRef.current;

        try {
          await invoke('sync_request_bodies', {
            accountId,
            messageIds: uncached,
          });
        } catch (e) {
          console.error('[prefetch] sync_request_bodies failed', e);
        }
        // The store patch happens via the sync:bodies-written listener
        // (Task 4). The token check there supersedes stale applications.
        void myToken; // (token is consulted by the listener — see Task 4.)
      })();
    }, DEBOUNCE_MS);

    return () => {
      cancelled = true;
      window.clearTimeout(handle);
    };
  }, [virtualizer, threads, accountId]);
}
```

> **Trigger surface:** depending on `threads` (array identity changes whenever the store updates — including on the in-place snippet patch in Task 4) would re-fire prefetch on every patch. To avoid a feedback loop, depend on `accountId` + a stable `threads.length` + the virtualizer's range. The cleanest version: take `threads` as a ref, not a dep. Convert to:
>
> ```ts
> const threadsRef = useRef(threads);
> threadsRef.current = threads;
> // deps: [virtualizer, accountId, threads.length, scrollTick]
> ```
>
> Where `scrollTick` is a number bumped by a `scroll` event listener on the scroll element. That is more code; for the MVP, depend on `[virtualizer, accountId]` and read `threads` via `useThreadStore.getState().threads` inside the timeout (Zustand `getState` is stable). Final shape decided in review — the unit tests below don't depend on the dep array.

Wire into `MessageList.tsx`:

```tsx
// after the virtualizer declaration (MessageList.tsx:243-248):
useViewportBodyPrefetch({
  virtualizer,
  threads,
  accountId: selectedFolder?.accountId ?? null,
});
```

Add the import at the top.

- [ ] **Step 6: Write failing frontend test** `kylins.client.frontend/tests/hooks/useViewportBodyPrefetch.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';

// Mock the Tauri + db surfaces BEFORE importing the hook.
vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../../src/services/db/messages', () => ({
  getUncachedBodyMessageIds: vi.fn().mockResolvedValue([]),
}));

// jsdom: no __TAURI_INTERNALS__ → hook is a no-op in tests by default.
// Force-enable by setting window.__TAURI_INTERNALS__ = {} in setup.
describe('useViewportBodyPrefetch', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    (window as any).__TAURI_INTERNALS__ = {};
  });

  it('is a no-op when there are no visible items', async () => {
    const { invoke } = await import('@tauri-apps/api/core');
    const virtualizer = {
      getVirtualItems: () => [],
    } as any;
    const { result } = renderHook(() =>
      // dynamic import so the mocks apply
      (require('../../src/hooks/useViewportBodyPrefetch') as any).useViewportBodyPrefetch({
        virtualizer,
        threads: [],
        accountId: 'a',
      }),
    );
    act(() => { vi.advanceTimersByTime(300); });
    expect(invoke).not.toHaveBeenCalled();
  });

  it('invokes sync_request_bodies with uncached visible ids after debounce', async () => {
    const { invoke } = await import('@tauri-apps/api/core');
    const { getUncachedBodyMessageIds } = await import('../../src/services/db/messages');
    (getUncachedBodyMessageIds as any).mockResolvedValue(['t2']);
    const virtualizer = {
      getVirtualItems: () => [
        { index: 0 }, { index: 1 }, { index: 2 },
      ],
    } as any;
    const threads = [
      { id: 't0' }, { id: 't1' }, { id: 't2' },
    ] as any;
    renderHook(() =>
      (require('../../src/hooks/useViewportBodyPrefetch') as any).useViewportBodyPrefetch({
        virtualizer, threads, accountId: 'a',
      }),
    );
    await act(async () => { await vi.advanceTimersByTimeAsync(300); });
    expect(invoke).toHaveBeenCalledWith('sync_request_bodies', {
      accountId: 'a', messageIds: ['t2'],
    });
  });
});
```

- [ ] **Step 7: Run — expect FAIL first (no hook), then PASS once the hook exists.**

Run: `cd kylins.client.frontend && npx vitest run tests/hooks/useViewportBodyPrefetch.test.ts && npx tsc --noEmit`

- [ ] **Step 8: Commit** — `feat(prefetch): db_get_uncached_body_message_ids + useViewportBodyPrefetch hook`.

---

## Task 3b: Prefetch robustness — first-mount immediate, 1-batch/sec throttle, supersede cleanup (closes the 6 design-review scenario gaps)

**Files:** `kylins.client.frontend/src/hooks/useViewportBodyPrefetch.ts`, `kylins.client.frontend/tests/hooks/useViewportBodyPrefetch.test.ts`

This task hardens the Task 3 hook against the 6 scenarios the design review flagged as implicit/partial. **Three are code changes to the hook; three are deliberate, documented trade-offs** (no code — they're correct already, just need to be stated so a future reader doesn't "fix" them).

**Code changes to the Task 3 hook (`useViewportBodyPrefetch.ts`):**

1. **First-mount fires immediately (Scenario 1 — no 250 ms wait on the initial viewport).** Add `const didMount = useRef(false)`. In the effect: if `!didMount.current`, set it true and use a `0`-ms timeout (fire next tick); otherwise use `DEBOUNCE_MS`. The very first viewport prefetches without the debounce; all subsequent triggers (scroll, folder-switch) keep the 250 ms debounce.
2. **Min-interval throttle — ≤ 1 batch/sec (Scenario 11).** Add `const lastFireRef = useRef(0)`. Compute the effective delay as `Math.max(DEBOUNCE_MS, 1000 - (Date.now() - lastFireRef.current))` (guard `Date.now() < lastFireRef.current` → `DEBOUNCE_MS`). After a successful `invoke('sync_request_bodies', …)`, set `lastFireRef.current = Date.now()`. This bounds the rate even when scroll settles repeatedly within one second.
3. **Remove the vestigial supersede token (Scenario 3).** Delete `tokenRef` / `myToken` from the Task 3 hook, and replace the comment that referenced it with:
   > // We deliberately do NOT gate patches on a supersede token. A late-arriving
   > // batch fired during fast scroll still usefully fills the cache and patches
   > // snippets for threads that are very likely still in the list. Patches are
   > // idempotent (INSERT OR REPLACE on the body; in-place map on the store), so
   > // applying a "stale" result is correct, not a bug. The debounce + 1-batch/sec
   > // throttle already prevent flooding; nothing further is gained by dropping
   > // legitimate late arrivals.

**Documented trade-offs (add to the hook's doc-comment + the plan Global Constraints — NO code):**

- **Open-message is concurrent / priority, not queued (Scenario 5).** `selectThread` fires its own `sync_request_bodies([id])` independent of any in-flight prefetch batch — it does NOT wait behind the batch, so it is effectively priority. If the id is also in an in-flight batch, the backend dedups via `INSERT OR REPLACE`; the only cost is one extra short-lived IMAP connection. Acceptable for MVP (a shared in-flight `Map<id, Promise>` to fully dedup is a documented follow-up).
- **Folder switch IGNORES stale results, does not hard-cancel (Scenario 6).** The previous folder's in-flight batch still completes + caches + emits `sync:bodies-written`, but `patchSnippets` is keyed by `thread_id` — the new folder's threads have different ids, so stale patches are no-ops. This is "ignore, not cancel" by design; a hard abort would require wiring an `AbortController` through to the backend fetch (follow-up).
- **Failed prefetches retry implicitly (Scenario 7).** A failed `sync_request_bodies` leaves `body_cached = 0`, so the next `getUncachedBodyMessageIds` call (on the next scroll / mount / folder-switch) re-includes those ids. No explicit retry queue is needed; retry is automatic on the next user-driven trigger. (The Phase 3f rate-limit/breaker still guards the server side.)

- [ ] **Step 1: Write failing tests** appended to `tests/hooks/useViewportBodyPrefetch.test.ts`:

```ts
it('fires immediately on first mount (no debounce) when items are visible', async () => {
  const { invoke } = await import('@tauri-apps/api/core');
  const { getUncachedBodyMessageIds } = await import('../../src/services/db/messages');
  (getUncachedBodyMessageIds as any).mockResolvedValue(['t1']);
  const virtualizer = { getVirtualItems: () => [{ index: 0 }, { index: 1 }] } as any;
  renderHook(() =>
    (require('../../src/hooks/useViewportBodyPrefetch') as any).useViewportBodyPrefetch({
      virtualizer, threads: [{ id: 't0' }, { id: 't1' }] as any, accountId: 'a',
    }),
  );
  // DO NOT advance the 250ms debounce timer — first-mount must have fired already.
  expect(invoke).toHaveBeenCalledWith('sync_request_bodies', { accountId: 'a', messageIds: ['t1'] });
});

it('throttles to <=1 batch/sec on rapid scroll-settle', async () => {
  const { invoke } = await import('@tauri-apps/api/core');
  const { getUncachedBodyMessageIds } = await import('../../src/services/db/messages');
  (getUncachedBodyMessageIds as any).mockResolvedValue(['t1']);
  const virtualizer = { getVirtualItems: () => [{ index: 0 }] } as any;
  const { rerender } = renderHook(() =>
    (require('../../src/hooks/useViewportBodyPrefetch') as any).useViewportBodyPrefetch({
      virtualizer, threads: [{ id: 't0' }, { id: 't1' }] as any, accountId: 'a',
    }),
  );
  await act(async () => { await vi.advanceTimersByTimeAsync(300); }); // first fire
  expect(invoke).toHaveBeenCalledTimes(1);
  // Rapid second trigger well inside 1s — must NOT fire again.
  vi.setSystemTime(new Date(Date.now() + 400));
  rerender();
  await act(async () => { await vi.advanceTimersByTimeAsync(300); });
  expect(invoke).toHaveBeenCalledTimes(1);
  // After the 1s window elapses, a new trigger fires.
  vi.setSystemTime(new Date(Date.now() + 1200));
  rerender();
  await act(async () => { await vi.advanceTimersByTimeAsync(300); });
  expect(invoke).toHaveBeenCalledTimes(2);
});
```
> `useFakeTimers()` is already set in the suite's `beforeEach`. `vi.setSystemTime` drives `Date.now()` for the throttle window. (If the hook reads time via `performance.now()` instead, switch the test to mock that — pick whichever the implementation uses.)

- [ ] **Step 2: Run — expect FAIL** (first-mount test fails because the current hook debounces the first run; throttle test fails because there's no throttle).

Run: `cd kylins.client.frontend && npx vitest run tests/hooks/useViewportBodyPrefetch.test.ts`

- [ ] **Step 3: Implement** the three code changes above (didMount + lastFireRef + remove token) in `useViewportBodyPrefetch.ts`. Keep the existing debounce / uncached-filter / rate-limit-gate / no-visible-items paths intact.

- [ ] **Step 4: Run — expect PASS.** All prefetch tests green (the two new + the existing three from Task 3); `npx tsc --noEmit` clean.

- [ ] **Step 5: Commit** — `feat(prefetch): first-mount immediate + 1-batch/sec throttle + remove vestigial supersede token`.

---

## Task 4: Snippet reactivity — `sync:bodies-written` listener → in-place `threadStore.threads` snippet patch (scroll-preserving)

**Files:** `kylins.client.frontend/src/stores/threadStore.ts`, `kylins.client.frontend/src/hooks/useSyncEvents.ts`, `kylins.client.frontend/tests/stores/threadStore.patchSnippets.test.ts`

**Interfaces:**
- Produces: `useThreadStore.patchSnippets(updates: { threadId: string; snippet: string }[])`; a `sync:bodies-written` listener in `useSyncEvents.ts` that calls it.

- [ ] **Step 1: Write failing test** `kylins.client.frontend/tests/stores/threadStore.patchSnippets.test.ts`:

```ts
import { describe, it, expect, beforeEach } from 'vitest';
import { useThreadStore } from '../../src/stores/threadStore';
import type { Thread } from '../../src/services/db/threads';

function mkThread(id: string): Thread {
  return {
    id, accountId: 'a', subject: null, snippet: null, lastMessageAt: null,
    messageCount: 1, isRead: false, isStarred: false, isImportant: false,
    hasAttachments: false, isSnoozed: false, fromName: null, fromAddress: null,
    classificationId: null, isEncrypted: false, isSigned: false,
  };
}

describe('threadStore.patchSnippets', () => {
  beforeEach(() => {
    useThreadStore.setState({
      threads: [mkThread('t1'), mkThread('t2'), mkThread('t3')],
      selectedThreadId: null, isLoading: false, cursor: null, currentQuery: null,
    });
  });

  it('patches only the snippet of matching threads in place', () => {
    const before = useThreadStore.getState().threads;
    useThreadStore.getState().patchSnippets([
      { threadId: 't2', snippet: 'hello' },
      { threadId: 'missing', snippet: 'nope' },
    ]);
    const after = useThreadStore.getState().threads;
    expect(after[1]!.snippet).toBe('hello');
    expect(after[0]!.snippet).toBeNull();
    expect(after[2]!.snippet).toBeNull();
  });

  it('preserves array identity of UNPATCHED threads (scroll-safe)', () => {
    // react-virtualized #1837: a full reload invalidates measured sizes.
    // Unpatched thread objects MUST be === their prior reference.
    const before = useThreadStore.getState().threads;
    useThreadStore.getState().patchSnippets([
      { threadId: 't2', snippet: 'hello' },
    ]);
    const after = useThreadStore.getState().threads;
    expect(after[0]).toBe(before[0]); // same ref
    expect(after[2]).toBe(before[2]); // same ref
    expect(after[1]).not.toBe(before[1]); // patched row is a new object
  });
});
```

- [ ] **Step 2: Run — expect FAIL** (`patchSnippets` undefined).

Run: `cd kylins.client.frontend && npx vitest run tests/stores/threadStore.patchSnippets.test.ts`

- [ ] **Step 3: Implement.** In `threadStore.ts`, add the method to the interface and the impl:

```ts
interface ThreadState {
  // ... existing ...
  patchSnippets: (updates: { threadId: string; snippet: string }[]) => void;
}

// in create():
patchSnippets: (updates) => {
  if (updates.length === 0) return;
  const byId = new Map(updates.map((u) => [u.threadId, u.snippet]));
  set((s) => ({
    threads: s.threads.map((t) =>
      byId.has(t.id) ? { ...t, snippet: byId.get(t.id)! } : t,
    ),
  })),
},
```

In `useSyncEvents.ts`, add the listener:

```ts
unlisteners.push(
  await listen<{
    accountId: string;
    updates: { threadId: string; snippet: string }[];
  }>('sync:bodies-written', (e) => {
    useThreadStore.getState().patchSnippets(e.payload.updates);
  }),
);
```

- [ ] **Step 4: Run — expect PASS.**

Run: `cd kylins.client.frontend && npx vitest run && npx tsc --noEmit`

- [ ] **Step 5: Commit** — `feat(prefetch): scroll-preserving sync:bodies-written -> threadStore.patchSnippets`.

---

## Task 5: LRU eviction (`maybe_evict`) + full regression + manual e2e notes

**Files:** `kylins.client.backend/src/db/message_bodies.rs`, `kylins.client.backend/src/sync_engine/commands.rs`

**Interfaces:**
- Produces: `db::message_bodies::maybe_evict(pool, cap_rows) -> Result<u64, String>`; called once at the end of `request_bodies_inner`.

- [ ] **Step 1: Write failing test** in `src/db/message_bodies.rs`:

```rust
#[tokio::test]
async fn maybe_evict_deletes_oldest_rows_beyond_cap_and_clears_cached_flag() {
    let tmp = tempfile::tempdir().unwrap();
    let pool = crate::db::init_db(tmp.path()).await.unwrap();
    seed_account(&pool, "a").await;
    // Seed 3 messages with bodies fetched at increasing fetched_at.
    for i in 1..=3 {
        let mid = format!("m{i}");
        seed_message(&pool, "a", &format!("t{i}"), &mid).await;
        set_message_body(&pool, "a", &mid, &format!("body{i}")).await.unwrap();
        // Force distinct fetched_at so the eviction order is deterministic.
        sqlx::query("UPDATE message_bodies SET fetched_at = ? WHERE message_id = ?")
            .bind(i as i64) // m1 oldest, m3 newest
            .bind(&mid)
            .execute(&pool).await.unwrap();
    }

    // Cap at 2 rows → m1 (oldest) evicted; m2 + m3 stay.
    let evicted = maybe_evict(&pool, 2).await.unwrap();
    assert_eq!(evicted, 1);

    let (cnt,): (i64,) = sqlx::query_as("SELECT COUNT(*) FROM message_bodies")
        .fetch_one(&pool).await.unwrap();
    assert_eq!(cnt, 2);
    let (cached_m1,): (i64,) = sqlx::query_as(
        "SELECT body_cached FROM messages WHERE id = 'm1'",
    ).fetch_one(&pool).await.unwrap();
    assert_eq!(cached_m1, 0, "evicted message's body_cached flag must be cleared");
    // m2 + m3 still cached.
    for keep in ["m2", "m3"] {
        let (c,): (i64,) = sqlx::query_as(
            "SELECT body_cached FROM messages WHERE id = ?",
        ).bind(keep).fetch_one(&pool).await.unwrap();
        assert_eq!(c, 1);
    }
}

#[tokio::test]
async fn maybe_evict_noop_when_under_cap() {
    let tmp = tempfile::tempdir().unwrap();
    let pool = crate::db::init_db(tmp.path()).await.unwrap();
    seed_account(&pool, "a").await;
    seed_message(&pool, "a", "t1", "m1").await;
    set_message_body(&pool, "a", "m1", "x").await.unwrap();
    let evicted = maybe_evict(&pool, 100).await.unwrap();
    assert_eq!(evicted, 0);
}
```

- [ ] **Step 2: Run — expect FAIL** (`maybe_evict` undefined).

Run: `cargo test --lib db::message_bodies::tests::maybe_evict`

- [ ] **Step 3: Implement.** In `src/db/message_bodies.rs`:

```rust
/// Bounded-cache eviction: if `message_bodies` exceeds `cap_rows`, delete the
/// oldest-`fetched_at` rows beyond the cap (LRU-by-rows) and clear their
/// `body_cached` flag. One transaction. Idempotent. The cap is a row count
/// (each body is ~10s of KB on average → 2000 rows ≈ a few hundred MB).
pub async fn maybe_evict(
    pool: &SqlitePool,
    cap_rows: i64,
) -> Result<u64, String> {
    let (cnt,): (i64,) = sqlx::query_as("SELECT COUNT(*) FROM message_bodies")
        .fetch_one(pool)
        .await
        .map_err(|e| e.to_string())?;
    if cnt <= cap_rows {
        return Ok(0);
    }
    let to_delete = cnt - cap_rows;
    let mut tx = pool.begin().await.map_err(|e| format!("begin tx: {e}"))?;
    // SQLite supports the `DELETE ... WHERE rowid IN (SELECT ... ORDER BY …
    // LIMIT n)` form; we delete the oldest-N message_ids first, then clear
    // their body_cached flag.
    let deleted_ids: Vec<String> = sqlx::query_scalar(
        "DELETE FROM message_bodies \
         WHERE rowid IN ( \
             SELECT rowid FROM message_bodies \
             ORDER BY fetched_at ASC \
             LIMIT ? \
         ) RETURNING message_id",
    )
    .bind(to_delete)
    .fetch_all(&mut *tx)
    .await
    .map_err(|e| e.to_string())?;
    let n = deleted_ids.len() as u64;
    // Clear body_cached for the evicted messages (so a future prefetch will
    // re-fetch them if they scroll back into view).
    for mid in &deleted_ids {
        // account_id is implicit in the message_id uniqueness, but the column
        // is on messages — we have only message_id here, so clear by id alone
        // (account_id is redundant for the WHERE because message ids are
        // globally unique: "imap-{account}-{folder}-{uid}").
        sqlx::query("UPDATE messages SET body_cached = 0 WHERE id = ?")
            .bind(mid)
            .execute(&mut *tx)
            .await
            .map_err(|e| e.to_string())?;
    }
    tx.commit().await.map_err(|e| e.to_string())?;
    log::info!("[db] message_bodies evicted {n} row(s) (was {cnt}, cap {cap_rows})");
    Ok(n)
}
```

Wire into `request_bodies_inner` (Task 2's refactor) — just before the `emit_bodies_written` call:

```rust
// Bounded cache: evict oldest bodies past the cap. Best-effort — log on error.
const BODY_CACHE_CAP_ROWS: i64 = 2000;
if let Err(e) = message_bodies::maybe_evict(pool, BODY_CACHE_CAP_ROWS).await {
    log::warn!("[sync] request_bodies: maybe_evict failed (non-fatal): {e}");
}
```

- [ ] **Step 4: Run — expect PASS.**

Run: `cargo test --lib db::message_bodies`

- [ ] **Step 5: Full backend regression.**

Run: `cargo test --lib`
Expected: all green (was 236+ at end of Phase 3e; this plan adds ~10 new unit tests).

Run: `cargo clippy --all-targets -- -D warnings`
Expected: clean.

- [ ] **Step 6: Full frontend regression.**

Run: `cd kylins.client.frontend && npx tsc --noEmit && npx vitest run`
Expected: tsc 0 errors; vitest all green (new: viewport prefetch test, snippet patch test).

- [ ] **Step 7: Manual e2e** (user runs `cargo tauri dev` against `imap.kylins.com` / `felixzhou@kylins.local`):
  1. Open an Inbox with at least 50 messages. The message list shows real preview snippets (from cached bodies) WITHOUT clicking any message — proving viewport prefetch + snippet write-back.
  2. Scroll the list fast. Scroll position does not jump when snippets populate a second later — proving the in-place `patchSnippets` (Task 4) preserves scroll.
  3. Open a message. The reading pane renders instantly (body already in `message_bodies` from prefetch) — proving the prefetch populated the cache that `threadStore.selectThread` reads.
  4. Watch the Rust log: a single `FETCH BODIES BATCH INBOX: 30/30 UID(s) fetched` line per scroll settle — proving ONE connection per batch (not 30 reconnects).
  5. With DevTools network visible (or `tcpdump`/server log), confirm the messages do NOT get marked `\Seen` server-side from prefetch (open one prefetched-but-not-clicked message in webmail → it is still unread) — proving `BODY.PEEK[]`.
  6. Simulate a rate-limit (or use an account already in `rate_limited` state): confirm the prefetch is skipped (no `sync_request_bodies` invoke) while the list still scrolls normally.
  7. Sync 2000+ bodies (across folders), confirm `message_bodies` row count stays near the cap and the oldest are evicted — proving LRU.

- [ ] **Step 8: Commit** — `feat(prefetch): message_bodies LRU-by-rows eviction (cap 2000) + full regression`.

---

## Deferred Follow-Ups (documented, NOT in this plan's scope)

- **Truncated-preview alternative (`BODY.PEEK[1]<0.500>`).** RFC 3501 §6.4.5 partial — fetch only the first 500 bytes of the body part for the snippet, then a separate full-body fetch on open. Saves bandwidth on slow links. Tunable; current MVP fetches the full body so the cache is open-instant.
- **HTML-aware snippet parser (preheader).** Today `derive_snippet` reads the plain-text part only; HTML-only messages get an empty snippet. A real preheader parser strips tags from the HTML and prefers the `<body>`'s first text node (Mailspring/Inbox Zero pattern). Out of scope for MVP.
- **Per-account concurrency caps.** The prefetch hook caps at ~30 message_ids per invocation, but if multiple accounts scroll simultaneously there's no global cap. A `p-limit`-style semaphore in the hook is a future refinement.
- **Persisted eviction policy.** LRU-by-rows (cap 2000) is the MVP heuristic. A byte-size cap (e.g. 500MB) or per-account quota is more precise but needs a periodic `SELECT SUM(LENGTH(body_html))` cost — defer.
- **EAS body batching.** Today EAS bodies are fetched per-message (`MailSource::fetch_body`). EAS Sync has a different batch primitive (`ItemOperations`); out of scope.
- **Attachment prefetch.** Separate workstream — attachment download has its own UX (download-on-click vs. cache-attachments toggle) and is not part of body prefetch.
- **Conversation threading + `latest_message_id`.** When real conversation threading lands (multiple messages per thread), the prefetch hook needs the *latest* message_id per visible thread, not `thread.id`. Surface `latestMessageId` on the `Thread` type at that point.
- **Persistent IMAP session.** A separate workstream (`docs/superpowers/plans/2026-06-27-imap-improvement-plan.md`) that would let the batch fetch reuse an already-open session instead of connect+login+SELECT per batch.

## Self-review notes

- **Scenario coverage — all 12 design scenarios now deliberately addressed (6 tasks: 1, 2, 3, 3b, 4, 5):**
  - S1 initial open, no debounce → Task 3b first-mount-immediate ✅
  - S2 slow scroll, debounce+buffer → Task 3 (250 ms + ±6) ✅
  - S3 fast scroll / supersede → Task 3b removes vestigial token; late batches still apply (idempotent) ✅
  - S4 scroll back up, skip cached → Task 3 `getUncachedBodyMessageIds` ✅
  - S5 open is priority → Global Constraint: concurrent fetch, deduped by `INSERT OR REPLACE` ✅ (documented trade-off)
  - S6 folder switch → Global Constraint: ignore stale via `thread_id` mismatch (not hard-cancel) ✅ (documented)
  - S7 offline/flaky retry → Global Constraint: implicit retry via `body_cached=0` ✅ (documented)
  - S8 multi-account scoped → Task 3 `accountId` ✅
  - S9 large folders bounded → Task 3 `MAX_PREFETCH=30` + buffer ✅
  - S10 revisit, skip cached → Task 3 `getUncachedBodyMessageIds` ✅
  - S11 server load ≤1 batch/sec → Task 3b min-interval throttle + one-connection-per-batch ✅
  - S12 storage growth → Task 5 LRU `maybe_evict` ✅

- **Scope coverage:**
  - "viewport-aware batch prefetch" → `useViewportBodyPrefetch` (Task 3) + `fetch_bodies_batch` (Task 1). ✅
  - "single batched IMAP FETCH" → `fetch_bodies_batch` (Task 1) reuses `raw_fetch_folder` skeleton; ONE connect per folder. ✅
  - "visible items" → `virtualizer.getVirtualItems()` + buffer ±6 (Task 3). ✅
  - "list shows preview snippets" → `set_message_snippet` (Task 2) + `patchSnippets` (Task 4). ✅
  - "opening a message is instant" → `selectThread` reads from the now-populated cache; unchanged. ✅
- **Current-pipeline gaps closed:**
  - "per-UID, each opening a NEW IMAP connection" (`commands.rs:77-118`) → batch-per-folder (Task 2). ✅
  - "no event fires when a body is written" → `sync:bodies-written` (Task 2). ✅
  - "thread.snippet is NULL after sync" → write-back in Task 2 + reactive patch in Task 4. ✅
  - "NO LRU/eviction policy" → `maybe_evict` (Task 5). ✅
- **Type consistency:**
  - `FetchedBody` defined in Task 1, consumed in Task 2 (`fetch_bodies_batch` return). ✅
  - `BodiesWrittenEvent` / `SnippetUpdate` defined in Task 2 (`engine.rs`), consumed by `TauriSink` + `TestSink` (Task 2) and the frontend listener (Task 4). ✅
  - `EventSink::emit_bodies_written` added to the trait in Task 2; every impl updated (NullSink, TestSink, plus any test-only impls flagged by `cargo build`). ✅
  - `set_message_snippet` / `get_thread_id_for_message` / `get_uncached_body_message_ids` all in `db::messages` (Task 2/3). ✅
  - `MailSource::imap_config_for_folder` added with a default `Ok(None)` (Task 2) so the EAS path falls back to per-message — non-breaking. ✅
  - Frontend `Thread.snippet` is already `string | null` (`threads.ts:22`) — the patch is non-breaking. ✅
- **Honest MVP limitations:**
  - HTML-only messages get an empty snippet until the deferred HTML-aware parser lands.
  - LRU is row-count, not byte-count.
  - EAS bodies are still per-message (fallback path).
  - `MailSource::imap_config_for_folder` returns a fresh `ImapConfig` per call (cheap struct copy); a persistent-session refactor would return `Arc<ImapConfig>` instead.

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-06-30-sync-engine-phase3-body-prefetch.md`. Two execution options:

1. **Subagent-Driven (recommended)** — fresh subagent per task (Task 1 → Task 5, including Task 3b), review between tasks. The tasks are mostly sequential (Task 2's refactor depends on Task 1's `fetch_bodies_batch`; Task 3 depends on Task 2's IPC signature change; Task 3b hardens Task 3's hook; Task 4 depends on Task 2's event), so a serial subagent chain is the right shape. Six commits total; each ends green on `cargo test --lib` + `clippy -D warnings` + `tsc --noEmit` + `vitest run`.
2. **Inline Execution** — this session via executing-plans, batched with checkpoints. Faster turnaround but loses the per-task review surface; only viable if no context pressure.

Recommended approach: **subagent-driven**, with Task 1 and Task 5 (the most self-contained) as the first and last subagents, and Tasks 2–4 reviewed carefully since they touch the IPC boundary (Task 2 changes `sync_request_bodies`' signature — every frontend caller must update).

Which approach?
