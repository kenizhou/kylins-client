# Message List Loading — Design Plan

Load the message list from the DB (folder-filtered threads), built to stay fast with
a huge number of messages; split bulky HTML bodies into a separate table; add an FTS
search service; and document the RAG/semantic hook for later.

## Context

`MessageList.tsx` renders hardcoded `DEMO_MESSAGES` and ignores the selected folder. The
folder pane now drives `folderStore.selected = {accountId, labelId}` and the DB has real
`threads` / `messages` / `thread_labels`. This change loads real, folder-filtered threads
from SQLite, with keyset pagination + UI virtualization for scale, a Mailspring-style
separate body table, and FTS search over the existing `messages_fts`.

## References

- **Velo** (closest stack) — `getThreadsForAccount` (`threads [JOIN thread_labels] LEFT JOIN
  messages` latest-message subquery for sender, `ORDER BY last_message_at DESC LIMIT/OFFSET`),
  `mapDbThreads`, `threadStore` (`loadMore` by offset, infinite scroll), `getMessagesForThread`
  for the reading pane.
- **Mailspring list** — reactive `QuerySubscription`, `Thread.unread` stored boolean, bodies in
  a separate `MessageBody` table loaded only on open, `body_cached` gates presence.
- **Mailspring FTS** — FTS5 `{Model}Search` tables, `MATCH '"q"*' LIMIT 1000` subquery for ids,
  an AST query parser (`from:`/`to:`/`is:`/`has:`/`before:`/`since:`), client-side highlighting
  (`BoldedSearchResult`); reuses the normal thread list for results.

## Huge-volume strategy

1. **Keyset (cursor) pagination** instead of OFFSET —
   `WHERE (last_message_at, id) < (cursorDate, cursorId)`. Deep pages are an index seek
   (O(log n)), not a scan; stable under inserts.
2. **Index** `threads(account_id, last_message_at DESC, id DESC)`.
3. **UI virtualization** (`@tanstack/react-virtual`, new dep) — render only visible rows.
4. **Body-free list query** — list selects thread columns + sender only.

## Constraints in our schema

- `messages_fts` is external-content FTS5 (`content='messages'`) indexing
  `subject, from_name, from_address, body_text, snippet` (trigram) via triggers (migration v2).
  → `body_text` stays on `messages`; only `body_html` moves out.
- `messages.body_cached` already exists. `threads.snippet` exists → **list preview = `threads.snippet`**
  (body-free).
- `idx_threads_date(account_id, last_message_at DESC)` lacks the `id` tie-breaker → add the cursor
  index. No `services/db/threads.ts` / `stores/threadStore.ts` yet. `viewStore.MailMessage` needs
  `{id, subject, from:{name,address}, to[], date: ISO, preview, html, text, threadId}`;
  `ReadingPane` reads `viewStore.selectedMessage`.

## Design

### Phase A — Thread list (keyset-paginated, virtualized)

**New `src/services/db/threads.ts`**

`getThreads(accountId, { labelId?, limit=50, cursor? })` → `{ threads: Thread[]; nextCursor: {date; id} | null }`.
Cursor = last returned thread's `(last_message_at, id)`. SQL built conditionally (label join + cursor),
portable cursor form (no row-value syntax):

```sql
SELECT t.id, t.account_id, t.subject, t.snippet, t.last_message_at, t.message_count,
       t.is_read, t.is_starred, t.is_important, t.has_attachments, t.is_snoozed,
       m.from_name, m.from_address
FROM threads t
[INNER JOIN thread_labels tl
   ON tl.account_id = t.account_id AND tl.thread_id = t.id AND tl.label_id = $label]
LEFT JOIN messages m
   ON m.account_id = t.account_id AND m.thread_id = t.id
  AND m.date = (SELECT MAX(m2.date) FROM messages m2
                WHERE m2.account_id = t.account_id AND m2.thread_id = t.id)
WHERE t.account_id = $accountId
  [AND (t.last_message_at < $curDate OR (t.last_message_at = $curDate AND t.id < $curId))]
ORDER BY t.last_message_at DESC, t.id DESC
LIMIT $limit
```

`nextCursor` = last row's `(last_message_at, id)` when the page is full, else null.

- `getMessagesForThread(accountId, threadId)` → metadata rows `ORDER BY date ASC` (no `body_html`).
- `markThreadRead(accountId, threadId)` → `UPDATE threads SET is_read=1`.
- `mapThread`; `parseAddresses(str)`; `mapMessageToMailMessage(msg, bodyHtml?)` (epoch-s `date`→ISO;
  `to`/`cc` via parseAddresses; `preview`←snippet; `text`←body_text).

**New `src/stores/threadStore.ts`** (Zustand): `threads`, `selectedThreadId`, `isLoading`, `cursor`,
`currentQuery`. Actions: `loadThreads(accountId,labelId)` (reset + page 1), `loadMore()` (use `cursor`;
append; stop when page short / cursor null), `selectThread(thread)` (load messages + that message's
`body_html`; `mapMessageToMailMessage`→`useViewStore.setSelectedMessage`; if `!isRead` optimistic +
`markThreadRead` + `useFolderStore.loadLabels()`), `refresh()`.

**Rewrite `src/components/layout/MessageList.tsx`** with `@tanstack/react-virtual`:
- Subscribe `threadStore` + `folderStore.selected` + `viewStore`(density/columns/conversation).
  `useEffect` on `folderStore.selected`→`loadThreads`.
- Flatten loaded threads into virtual items, prepending a date-group header item at each day boundary
  (Today/Yesterday/Earlier from `lastMessageAt`). `useVirtualizer` renders only visible items; each is
  a group header or a `MessageRow` mapped from `Thread` (sender=`fromName??fromAddress`,
  preview=`thread.snippet`, time=ISO(lastMessageAt), state = starred→flagged | important→vip |
  !read→unread | read).
- `onClick`→`selectThread`; `onDoubleClick`→`openViewerWindow(useViewStore.selectedMessage)`.
  Highlight `selectedThreadId`.
- Infinite scroll: `loadMore()` when the last visible index nears the count.
- States: `isLoading` → "Loading…"; empty → "No messages in this folder." Drop `DEMO_MESSAGES`.

**Reload** — `folderStore.syncFolder` also calls `useThreadStore.getState().refresh()`.

### Phase B — Separate bodies + FTS search

**Migration v34** (latest applied v33):

```sql
-- cursor index for keyset pagination
CREATE INDEX IF NOT EXISTS idx_threads_cursor ON threads(account_id, last_message_at DESC, id DESC);

-- separate body store: move bulky HTML out, keep body_text inline for FTS
CREATE TABLE IF NOT EXISTS message_bodies (
  account_id TEXT NOT NULL, message_id TEXT NOT NULL,
  body_html TEXT, fetched_at INTEGER DEFAULT (unixepoch()),
  PRIMARY KEY (account_id, message_id),
  FOREIGN KEY (account_id, message_id) REFERENCES messages(account_id, id) ON DELETE CASCADE
);
INSERT OR IGNORE INTO message_bodies (account_id, message_id, body_html)
  SELECT account_id, id, body_html FROM messages WHERE body_html IS NOT NULL;
UPDATE messages SET body_html = NULL, body_cached = 1
  WHERE id IN (SELECT message_id FROM message_bodies);
-- messages.body_html RETAINED (NULL) to avoid risky DROP COLUMN; app reads HTML only from message_bodies.
```

**New `src/services/db/messageBodies.ts`** — `getMessageBody`, `setMessageBody` (writes + `body_cached=1`),
`evictBody` (future). `selectThread` fetches the latest message's body before assembling `MailMessage`.

**New `src/services/db/search.ts`** — `searchMessages(accountId, query, limit=50)` over `messages_fts`
(`snippet()`/`highlight()`, `ORDER BY rank`):

```sql
SELECT m.id, m.thread_id, m.subject, m.from_name, m.from_address, m.date,
       snippet(messages_fts, 3, '<mark>', '</mark>', '…', 16) AS preview, rank
FROM messages_fts JOIN messages m ON m.rowid = messages_fts.rowid
WHERE messages_fts MATCH $query AND m.account_id = $accountId
ORDER BY rank LIMIT $limit
```

Exposed for a search box (UI wiring is a separate task). Future (Mailspring-style): an AST parser
(`from:`/`is:unread`/`since:`) on top of FTS + client-side highlight.

**Seed update** (`seedDummyData.ts`) — write `body_html` to `message_bodies`; keep `body_text` on `messages`.

### Phase C — RAG / semantic search (DESIGNED, DEFERRED)

Needs an embedding provider + vector similarity:
- `message_embeddings(account_id, message_id, model, chunk_index, embedding BLOB)`.
- `embed(text)` in `services/ai/` (`AIService`/`LLMProvider` exist for chat/summary) → fill at sync time.
- Query: FTS-narrowed candidates → app-side cosine over BLOBs, or `sqlite-vec` if the Tauri SQL plugin
  can load it (verify then).

## Files

- **New:** `services/db/threads.ts`, `services/db/messageBodies.ts`, `services/db/search.ts`,
  `stores/threadStore.ts`.
- **Modified:** `components/layout/MessageList.tsx` (rewrite + virtualization),
  `stores/folderStore.ts` (`syncFolder`→`threadStore.refresh()`), `services/db/seedDummyData.ts`
  (bodies→`message_bodies`), `services/db/migrations.ts` (v34), `package.json` (+`@tanstack/react-virtual`).
- **Unchanged:** `ReadingPane`, `viewStore`, `EmailRenderer` (bridge via `setSelectedMessage`).

## Conventions / scope

- TS strict (`noUncheckedIndexedAccess`); tests mock `getDb()`+`@tauri-apps/plugin-sql`; no backend
  changes — no `cargo`.
- Deferred: full conversation view, message-sync persistence, multi-select, search UI + query parser, RAG.

## Tests

- `threads.test.ts` — first page (no cursor) vs cursor page (emits the `<` predicate); label join
  present/absent; `ORDER BY … DESC, id DESC` + `LIMIT`; `nextCursor` set when full, null when short;
  `mapThread`; `getMessagesForThread` ASC; `markThreadRead`.
- `messageBodies.test.ts` — get/set SQL + sets `body_cached`.
- `search.test.ts` — `MATCH` + `snippet()` + `rank` query shape.
- `threadStore.test.ts` — `loadThreads` sets cursor; `loadMore` appends + uses cursor + stops at short
  page; `selectThread` loads messages + body, sets `selectedMessage`, marks unread read; `refresh`.
- `MessageList.test.tsx` — renders store threads (no `DEMO_MESSAGES`), empty state, calls `loadMore` near
  end, reloads on `folderStore.selected` change.

## Verification

```bash
cd kylins.client.frontend
npm install                       # @tanstack/react-virtual
npx tsc --noEmit
npx vitest run tests/services/db/threads.test.ts tests/services/db/messageBodies.test.ts tests/services/db/search.test.ts tests/stores/threadStore.test.ts tests/components/layout/MessageList.test.tsx
npm run build
```

Then `cargo tauri dev`: pick a folder → list shows that folder's seeded threads (Inbox = unread
security-alert + marketing; Sent = welcome), preview = snippet, date groups + unread/star indicators,
only visible rows in the DOM (virtualized); click opens the reading pane (body fetched from
`message_bodies`) and marks read (folder badge drops); scrolling near the bottom loads the next cursor
page; switching folders/accounts reloads. `searchMessages` is available to wire to a search box next.
