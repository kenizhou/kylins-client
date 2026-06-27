# Mail Sync Engine — Cross-Repo Research & Design Foundations

> Research goal: learn how Thunderbird, inbox-zero, Velo, and Mailspring implement
> multi-source mail sync, then design a source-agnostic sync engine for Kylins Client
> that abstracts away provider differences (Gmail, Outlook/Graph, IMAP, EAS) and handles
> heterogeneous real-time capabilities (IMAP IDLE, EAS Sync/Ping, polling).

## 1. Executive summary

All four mature clients converge on the **same core architecture**, despite different
languages and runtimes. The consensus is unmistakable:

1. A **provider abstraction** (one interface, N implementations, one factory).
2. **Decouple the "something changed" signal from the "what changed" fetch.**
3. **Delta sync via a per-folder cursor** — `UIDVALIDITY + highestUID + MODSEQ` (IMAP),
   `SyncKey` (EAS), `historyId` (Gmail). UIDVALIDITY change ⇒ wipe + full resync.
4. **Offline operations as persistent DB rows**, replayed in priority order, gated by the
   cache key (UIDVALIDITY / sync token).
5. **Optimistic local-apply, then remote-syncback**, with a short write-lock so a server
   delta can't clobber a just-made local edit.
6. **Headers-first, bodies-deferred** (separate body store; on-demand fetch).
7. **Per-account isolation** (process or task) so one flaky server can't stall the others.
8. A **delta event stream** to the UI — the UI never queries the network; it reacts.

The decisive difference between them is **where the engine runs** and **who owns the
delta stream**:

| Client | Engine location | Real-time | DB ownership |
|---|---|---|---|
| **Thunderbird** | Per-server thread, in main process | IMAP IDLE (async-stream wakeup) + Biff poll | Native (Mork→SQLite "Panorama") |
| **inbox-zero** | Serverless web (webhook→history.list) | Gmail Pub/Sub push (server-only) | Prisma/Postgres |
| **Velo** | Renderer `setInterval` + Rust network cmds | **None** — 60s polling | Frontend (tauri-plugin-sql) |
| **Mailspring** | Separate native process per account | IMAP IDLE on INBOX only (interruptible) | mailsync owns per-account SQLite |
| **Kylins (today)** | None — one-shot on account setup | None | Frontend (tauri-plugin-sql) |

**The headline finding:** Velo — Kylins' stated reference — is itself **Tauri v2** (not
Electron, as docs claim) but ships **zero real-time**. So Kylins must go *beyond* Velo for
the IDLE/EAS-Ping layer. The best template for that layer is **Mailspring's mailsync**:
native, per-account, IDLE-on-INBOX-only with an interruptible foreground worker, a
background CONDSTORE sweep for other folders, and a line-delimited JSON delta protocol.
Because Kylins' Rust backend is **already a separate process from the WebView**, we get
Mailspring's crash-isolation benefit for free — we can run the engine as Tokio tasks inside
the existing backend instead of spawning a second binary.

---

## 2. Cross-repo comparison

### 2.1 Provider abstraction

| Client | Abstraction | Shape | Providers |
|---|---|---|---|
| Thunderbird | `nsIMsgIncomingServer` + `nsIMsgFolder` IDL; contract-ID keyed by `type` string | override `PerformBiff`/`UpdateFolder`/`GetNewMessages` | imap, pop3, nntp, rss, exchange(EWS) |
| inbox-zero | `EmailProvider` TS interface (~80 methods) + factory | `getHistory`/`watchEmails`/`sendEmailWithHtml`/… | Gmail, Outlook(Graph) |
| Velo | `EmailProvider` TS interface + cached factory `getEmailProvider(id)` | `initialSync(daysBack,onProgress)` + `deltaSync(syncToken)` + thread-level actions | GmailApi, ImapSmtp |
| Mailspring | No mail-level abstraction — all IMAP; `provider` field only routes OAuth/contacts | — | (IMAP only; gmail/o365 differ on OAuth) |
| **Kylins target** | `MailSource` trait (Rust) — see §4 | capability-advertised methods | Imap, Eas, GmailApi, Graph |

**Lesson:** Velo's interface is the cleanest small-surface model — `initialSync` /
`deltaSync(cursor)` / `listFolders` / thread-level mutations / `sendMessage`. Add an
optional **real-time** surface (`watch()` / `ping()`) that adapters implement only if they
support it.

### 2.2 Real-time / push

| Client | Mechanism | Notes |
|---|---|---|
| Thunderbird | IMAP **IDLE** via `AsyncWait` on socket; **Biff** poll (per-account `biffMinutes`, sleep/wake-aware) | One IDLE conn per selected mailbox; 2s pre-idle wait |
| inbox-zero | **Gmail Pub/Sub** (`users.watch`) → webhook → `history.list`; Graph subscriptions | Server-only — **no desktop analog** (needs public URL) |
| Velo | **None** | Pure 60s `setInterval` |
| Mailspring | **IDLE on INBOX only** (foreground worker, `timeout=0` indefinite), interruptible via CV + `interruptIdle()`; background worker does 2-min CONDSTORE sweeps of all other folders; IDLE drops silently swallowed | Multi-folder IDLE explicitly rejected |
| **Kylins target** | IMAP IDLE (Rust `async-imap::idle`) on INBOX; EAS **Ping** long-poll loop; **polling fallback** when neither is available/allowed | Capability-negotiated |

**Critical pattern (Mailspring + Thunderbird consensus):** IDLE lives on a **single
dedicated, interruptible worker for INBOX**; every other folder is kept fresh by a
**periodic background sweep** (Mailspring: 2-min shallow / 10-min deep). Do NOT try to IDLE
every folder — connection limits and complexity aren't worth it.

### 2.3 Delta sync state (the cursor)

| Source type | Cursor | "Wipe & resync" trigger |
|---|---|---|
| IMAP (Thunderbird, Mailspring, Velo) | `(uidvalidity, highest_uid, highest_modseq)` per folder | UIDVALIDITY change |
| EAS | `(collection_id, sync_key)` per folder | sync_key '0' = full |
| Gmail API (inbox-zero, Velo) | `history_id` (monotonic) | `HISTORY_EXPIRED` (≈30d) |
| Graph | subscription + delta token | delta token expired |

**Two race-safety techniques worth copying:**
- **inbox-zero:** monotonic *conditional* UPDATE —
  `UPDATE … SET history_id=$new WHERE history_id IS NULL OR history_id < $new`. Prevents
  a slow older sync from regressing the cursor under concurrent push + poll.
- **inbox-zero gap-bounding:** if the catch-up window is too large, skip *forward* to
  `webhookId − MAX_GAP` and process forward, accepting a bounded skip — never melt down on a
  months-offline mailbox.

**Persistence shape:** Mailspring stores the whole per-folder sync state as a **JSON blob
(`Folder.localStatus`)** — `uidvalidity, highestmodseq, uidnext, syncedMinUID, busy,
lastShallow, lastDeep`. Adding a field is a one-line change, no migration. Kylins'
existing `folder_sync_state` (typed columns) is fine too, but the JSON-blob idea is worth
keeping for the bits that change often.

### 2.4 Offline queue / syncback

| Client | Queue shape | Replay | Conflict-avoidance |
|---|---|---|---|
| Thunderbird | Offline-op rows in folder DB, op-type bitmask, keyed by UID | fixed priority (flags→keywords→copies→moves→appends→deletes), UIDVALIDITY-gated (mismatch ⇒ drop all) | UIDVALIDITY gate |
| Velo | `pending_operations` table | 30s runner, **`compactQueue()`** cancels toggle pairs & collapses sequential moves; backoff `[60,300,900,3600]`s; sync skips threads with pending ops | `getPendingOpsForResource` skip |
| Mailspring | `Task` model rows (`local→remote→complete`) | two-phase: `performLocal` (optimistic + emit delta) → `performRemote` (IMAP/SMTP) | **24-hr `syncedAt` bump** so a server FETCH can't revert a just-made local edit |
| **Kylins** | `pending_operations` table **exists**, backoff formula exists, **but no consumer** | — | — |

**Lesson:** Velo's `compactQueue` + Mailspring's 24-hr write-lock are the two subtle
techniques that make optimistic editing robust. Copy both.

### 2.5 Process model & IPC

- **Thunderbird:** one XPCOM thread per IMAP server; URL-queue serializes ops.
- **Mailspring:** one native child process per account; **stdin (JSON commands) / stdout
  (newline-delimited JSON deltas)**; 4 threads inside (bg sweep, fg IDLE, DAV, metadata).
- **Velo:** renderer `setInterval` → Rust commands (no background Rust loop).
- **Kylins opportunity:** run the engine as **per-account Tokio tasks inside the existing
  Rust backend**; the WebView↔backend boundary *is* the process isolation. Replace
  Mailspring's stdin/stdout JSON with **Tauri events** (the delta stream) + **Tauri
  commands** (the inbound ops). Same protocol shape, no second binary.

### 2.6 Error handling

- **Thunderbird:** no backoff (weak — hammers dead servers). Serializes password prompts
  via `MsgAsyncPrompter`.
- **inbox-zero:** per-account **rate-limit "mode" with TTL** — a 429 writes `retryAt` to
  Redis; *all* subsequent calls for that account short-circuit until the window passes.
  Plus `withGmailRetry` (parse `Retry-After`, abort if backoff > 10s).
- **Velo:** circuit breaker (3 fails ⇒ 15s cooldown, 5 ⇒ skip folder) + tiered
  `tokio::time::timeout` (30s cmd / 60s search / 120s fetch / 60s connect) + TCP keepalive 60s.
- **Mailspring:** fixed 120s reconnect; IDLE drops swallowed; crash-tracker refuses relaunch
  after 5 crashes/5min.

**Lesson:** Kylins already has `60 * 2^n` backoff (better than Thunderbird). Add: tiered
per-command timeouts (Velo), circuit breaker (Velo), per-account rate-limit-mode (inbox-zero).

---

## 3. Kylins current state — gap summary

**Already in place (don't rebuild):**
- Rust IMAP command surface (LIST/SELECT/FETCH/SEARCH/STORE/MOVE/COPY/APPEND/STATUS,
  CONDSTORE-aware `delta_check_folders`, raw-TCP fallback).
- Real EAS client (`folder_sync`, `sync`, `ping`, `item_operations`, send).
- SMTP via `lettre`.
- Frontend `ImapProvider` + `EasProvider` wrappers.
- DB schema: `folder_sync_state` (v14), `eas_sync_state` (v25), `pending_operations` (v17),
  `message_bodies` (v34), threads/messages/labels.
- `OfflineQueue` storage primitive with backoff.

**Missing (the engine):**
- (a) **Abstraction:** `MailProvider` is 6 lines; no factory; no delta/cursor/real-time
  contract. Gmail-API & Graph providers absent.
- (b) **Scheduler/real-time:** no `SyncManager`; no IDLE; EAS `ping` exists but never called;
  no polling timer; `tray-check-mail` event has no listener.
- (c) **Cursors:** `folder_sync_state` / `eas_sync_state` are **dead** (written nowhere);
  `EasProvider` always passes `sync_key:'0'`; `accounts.last_sync_at` never updated.
- (d) **Offline replay:** `OfflineQueue.dequeuePending` has **zero callers**; only
  `composer/send.ts` enqueues.
- (e) **IPC→UI:** no sync Tauri events; no listener that refreshes stores on new mail;
  `tray-check-mail` unhandled.

---

## 4. Proposed Kylins architecture (design space — decisions in §5)

```
┌──────────────── WebView / React ────────────────┐
│  useSyncEvents() ← Tauri listen()                │
│    → folderStore.invalidate / threadStore.refresh│
│    → OS notification on sync:new-mail            │
│  Stores read local SQLite for display            │
│  UI mutations → invoke('sync_op', …)             │
└──────────────────────┬───────────────────────────┘
                       │ commands ▲   events ▼
┌──────────────────────┴───────────────────────────┐
│            Rust backend (Tauri + Tokio)           │
│  ┌──────────── SyncEngine (singleton) ──────────┐│
│  │  per-account AccountWorker (tokio task)       ││
│  │   ├─ op-queue (typed SyncOp mpsc channel)     ││
│  │   ├─ RealtimeStrategy: IdleGuard│PingLoop│Poll││
│  │   ├─ background folder sweep (wakeable sleep)  ││
│  │   ├─ body fetch queue (on-demand + prefetch)   ││
│  │   └─ offline-op replay (drains pending_ops)    ││
│  │  MailSource trait: Imap│Eas│GmailApi│Graph      ││
│  │  emits: sync:delta / sync:new-mail / sync:status│
│  └───────────────────────────────────────────────┘│
│  SQLite (WAL): accounts, labels, threads,         │
│   messages, message_bodies, folder_sync_state,    │
│   eas_sync_state, pending_operations              │
└───────────────────────────────────────────────────┘
```

### The `MailSource` trait (Rust) — capability-advertised

```text
trait MailSource {
    fn capabilities(&self) -> Capabilities;   // { idle, condstore, qresync, vanishearch, ping, … }

    // folder tree
    async fn list_folders(&self) -> Result<Vec<RemoteFolder>>;
    // cursor-based sync — returns new/updated/vanished + advanced cursor
    async fn sync_folder(&self, folder, since: Cursor) -> Result<FolderDelta>;
    async fn fetch_body(&self, folder, uid) -> Result<MessageBody>;

    // mutations (also routed through offline queue)
    async fn set_flags(&self, folder, uids, flags) -> Result<()>;
    async fn move_messages(&self, …) -> Result<()>;
    async fn append(&self, …) -> Result<Uid>;
    async fn send(&self, raw) -> Result<()>;

    // OPTIONAL real-time — default = "not supported"
    async fn watch(&self, folder) -> Result<WatchStream>;   // IMAP IDLE
    async fn ping(&self, collections) -> Result<PingEvent>; // EAS Ping
}
```

The scheduler reads `capabilities()` to pick a `RealtimeStrategy` per account:
- `idle` supported ⇒ IDLE on INBOX + background sweep for the rest.
- `ping` supported (EAS) ⇒ Ping long-poll loop.
- neither ⇒ polling timer (per-folder interval, wakeable).

This is exactly the "屏蔽差异性，统一调度" the user asked for: the scheduler is identical
for every source; only the strategy object differs.

---

## 5. Open design decisions (to resolve before planning)

1. **Engine location & persistence ownership.**
   - **A — Rust-owned engine + Rust-owned DB (sqlx).** Cleanest; matches Mailspring;
     frontend becomes a pure view layer. Biggest refactor (move all DB code to Rust,
     migrate tauri-plugin-sql schema).
   - **B — Rust-owned engine, frontend-owned DB (tauri-plugin-sql).** Incremental; Rust
     emits "here's new data" events, frontend persists (current `upsertImapMessages`
     pattern). Less restructuring, chatty delta protocol, two-write-path risk.
   - **C — Hybrid:** Rust owns sync_state cursors + queue + IDLE; shared SQLite file in WAL
     between Rust (sqlx) and JS (plugin-sql). Risk: cross-language locking.
   - *(Recommended: A long-term, but phase the migration.)*

2. **Build order / sequencing.**
   - Option 1: scheduler + cursors first (correctness), then IDLE (latency), then offline
     replay (resilience).
   - Option 2: offline replay first (unblocks reliable send), then scheduler, then IDLE.

3. **Real-time capability modeling in the trait.** Capability flags + default-unsupported
   optional methods (above), vs. an enum strategy selected at construction. (Recommended:
   flags + optional methods.)

4. **Frontend notification path.** `tray-check-mail` listener + `sync:new-mail` →
   `tauri-plugin-notification` + store refresh. Confirm we want OS notifications + tray.

---

## 6. Reference file pointers

**Velo (primary model for interface + DB + queue):**
- `…/velo/src/services/email/types.ts` — `EmailProvider` interface
- `…/velo/src/services/email/providerFactory.ts` — cached factory
- `…/velo/src/services/gmail/syncManager.ts` — scheduler (60s)
- `…/velo/src/services/imap/imapSync.ts` — streaming initial sync, circuit breaker
- `…/velo/src/services/emailActions.ts` — offline-aware mutation layer
- `…/velo/src/services/queue/queueProcessor.ts` — replay + compactQueue
- `…/velo/src/services/db/folderSyncState.ts` — IMAP cursor table
- `…/velo/src-tauri/src/imap/client.rs` — Rust IMAP, tiered timeouts, delta_check

**Mailspring (primary model for IDLE + delta protocol + process model):**
- `…/Mailspring/mailsync/MailSync/SyncWorker.cpp` — IDLE-on-INBOX, background sweep,
  CONDSTORE path, UIDVALIDITY reset, interruptible idle
- `…/Mailspring/mailsync/MailSync/DeltaStream.cpp` — line-delimited JSON delta + coalescing
- `…/Mailspring/mailsync/MailSync/TaskProcessor.cpp` — two-phase performLocal/performRemote,
  24-hr syncedAt write-lock
- `…/Mailspring/mailsync/MailSync/main.cpp` — stdin command dispatch
- `…/Mailspring/app/src/flux/mailsync-bridge.ts` — delta→store bridge

**Thunderbird (primary model for IDLE wakeup + offline-op priority + body-deferral):**
- `…/thunderbird-desktop/mailnews/imap/src/nsImapProtocol.cpp` — IDLE, threading, chunking
- `…/thunderbird-desktop/mailnews/imap/src/nsImapOfflineSync.cpp` — offline-op playback
- `…/thunderbird-desktop/mailnews/imap/src/nsAutoSyncManager.cpp` — deferred body download
- `…/thunderbird-desktop/mailnews/base/src/nsMsgBiffManager.cpp` — biff scheduler

**inbox-zero (primary model for cursor race-safety + rate-limit mode):**
- `…/inbox-zero/apps/web/utils/webhook/google/process-history.ts` — monotonic cursor,
  gap-bounding
- `…/inbox-zero/apps/web/utils/email/rate-limit.ts` — per-account rate-limit mode
- `…/inbox-zero/apps/web/utils/gmail/retry.ts` — withGmailRetry
