# Kylins Mail Sync Engine — Design Spec

**Date:** 2026-06-27
**Status:** Approved (pending spec review)
**Owner:** Kylins Client
**Predecessor docs:** `docs/mail-sync-engine-research.md` (cross-repo research),
`docs/architecture.md`, `docs/comparison-report.md`

---

## 1. Context & motivation

Kylins Client can create an IMAP account and pull one batch of Inbox messages on setup,
but **nothing keeps mail in sync**: there is no scheduler, no IMAP IDLE, no EAS Ping loop,
no offline-queue replay, and the per-folder cursor tables (`folder_sync_state`,
`eas_sync_state`) exist in the schema but are written and read by no code. Today mail is a
one-shot snapshot that goes stale instantly.

Cross-repo research (Thunderbird, inbox-zero, Velo, Mailspring) shows every mature client
converges on the same shape: a **provider abstraction**, **decoupled "something changed"
signal from "what changed" fetch**, **per-folder cursor delta sync**, **persistent offline
ops replayed in priority order**, **optimistic local-apply + remote-syncback**, and
**headers-first / bodies-deferred**. This spec adopts that shape, adapted to Kylins'
Tauri v2 + Rust + React stack.

Two design decisions were locked with the user:

- **D1 — Engine location & DB ownership:** the Rust backend owns **both** the sync engine
  and the SQLite database (via `sqlx`). The frontend becomes a pure view layer. This is the
  Mailspring/Thunderbird model. Rationale: the Tauri backend is already a separate process
  from the WebView (crash isolation is free), IDLE must hold a socket so the engine core is
  in Rust regardless, and a single writer avoids cross-language locking.
- **D2 — Build sequence (correctness ladder):** Phase 0 foundation → Phase 1 offline replay
  → Phase 2 real-time → Phase 3 provider breadth. Each phase ships independently; real-time
  rides on proven-correct cursors.

Two sub-decisions confirmed:

- **D3 — Real-time capability modeling:** capability **flags** + **optional trait methods**
  with `Unsupported` defaults. The scheduler reads `capabilities()` once per account and
  picks the strategy; engine code is identical for every source.
- **D4 — Notifications:** yes to OS notifications (`tauri-plugin-notification`) on new mail
  and to wiring the currently-dead `tray-check-mail` event.

---

## 2. Goals & non-goals

### Goals

- A single `SyncEngine` that syncs any source (IMAP, EAS, later Gmail API / Graph) through
  one uniform `MailSource` trait — **屏蔽差异性，统一调度**.
- Correct, resumable, crash-safe delta sync via per-folder cursors (UIDVALIDITY/MODSEQ for
  IMAP, SyncKey for EAS), including the UIDVALIDITY-change wipe-and-resync path.
- A scheduler with background polling (Phase 0), offline-op replay (Phase 1), and real-time
  push via IMAP IDLE + EAS Ping (Phase 2), with a polling fallback for sources without push.
- Rust as the **sole** SQLite owner; the frontend reads via Tauri commands and reacts to
  Tauri events.
- UI that updates on new mail without manual refresh; OS notifications + tray.

### Non-goals (this spec)

- Gmail API and Microsoft Graph providers (Phase 3, separate spec).
- QRESYNC (RFC 5162) beyond the CONDSTORE fast path (Phase 3).
- Calendar/contacts sync (separate source types, existing CalDAV/CardDAV path).
- Server-side search / sort / thread extensions (`SORT`, `THREAD`, `ESearch`).
- A separate sync subprocess (rejected — the backend already provides process isolation).
- POP3.

---

## 3. Architecture

```
WebView (React) — VIEW ONLY                  Rust backend (Tauri + Tokio) — ENGINE + DB
┌────────────────────────────┐              ┌───────────────────────────────────────────┐
│ Zustand stores (read-only) │   commands   │ SyncEngine (singleton, owns N workers)     │
│  filled by db_* query cmds │ ───────────▶ │  per-account AccountWorker (tokio task):   │
│  invalidated by sync:delta │              │    • op-queue (mpsc<SyncOp>)                │
│                            │              │    • RealtimeStrategy (idle | ping | poll)  │
│ useSyncEvents() ◀──────────│  events      │    • background folder sweep (wakeable)     │
│  → invalidate store slices  │ ◀─────────── │    • body-fetch queue (on-demand + prefetch)│
│  → OS notif on sync:new-mail│             │    • offline-op replay loop                  │
│                            │              │  MailSource trait                            │
│ Mutations: invoke('sync_op')│             │   ├ ImapSource  ├ EasSource                  │
└────────────────────────────┘              │   └ (Phase 3: GmailApiSource, GraphSource)   │
                                            │  sqlx ──► SQLite (WAL) — sole owner           │
                                            │   accounts, labels, threads, messages,        │
                                            │   message_bodies, folder_sync_state,          │
                                            │   eas_sync_state, pending_operations, …       │
                                            └───────────────────────────────────────────┘
```

**Key invariants**

- Exactly one process writes SQLite: the Rust backend. The frontend never opens the DB.
- Exactly one `SyncEngine` instance (process singleton). It owns one `AccountWorker` per
  active account; workers do not share IMAP/EAS connections.
- All network I/O and all DB writes happen on backend Tokio tasks, never on the WebView.
- The frontend is reactive: it issues read commands and subscribes to events; it does not
  poll the network.

---

## 4. The `MailSource` trait

The provider abstraction. One trait, N implementations, one factory. Each adapter wraps the
existing Rust IMAP (`async-imap`) and EAS code; nothing protocol-level is rewritten.

```rust
#[derive(Clone, Copy, Default)]
pub struct Capabilities {
    pub idle: bool,          // IMAP IDLE
    pub condstore: bool,     // RFC 4551 MODSEQ / CHANGEDSINCE
    pub qresync: bool,       // RFC 5162 (Phase 3)
    pub vanishearch: bool,   // VANISHED in FETCH (Phase 3)
    pub ping: bool,          // EAS Ping long-poll
}

/// Opaque per-folder delta cursor. Each source defines its own payload.
pub enum Cursor {
    Imap { uidvalidity: u32, highest_uid: u32, highest_modseq: u64 },
    Eas  { collection_id: String, sync_key: String },
    // Phase 3: Gmail { history_id: String }, Graph { delta_token: String },
}

pub struct FolderDelta {
    pub added: Vec<RemoteMessage>,       // new envelopes + flags
    pub updated: Vec<RemoteMessage>,     // flag/label changes (CONDSTORE CHANGEDSINCE)
    pub vanished: Vec<Uid>,              // expunged UIDs (or UID range)
    pub next_cursor: Cursor,             // advanced cursor to persist
    pub uidvalidity_changed: bool,       // caller must wipe before applying
}

#[async_trait]
pub trait MailSource: Send + Sync {
    fn capabilities(&self) -> Capabilities;

    // Folder tree
    async fn list_folders(&self) -> Result<Vec<RemoteFolder>>;

    // Delta sync against a cursor. `Cursor::default()` (uidvalidity 0 / sync_key "0")
    // means "initial sync"; the source returns a windowed initial set.
    async fn sync_folder(&self, folder: &RemoteFolder, since: Cursor) -> Result<FolderDelta>;

    // Lazy body fetch (headers-first; bodies deferred)
    async fn fetch_body(&self, folder: &RemoteFolder, uid: Uid) -> Result<MessageBody>;
    async fn fetch_attachment(&self, folder: &RemoteFolder, uid: Uid, part: &str) -> Result<Attachment>;

    // Mutations — also routable through the offline queue
    async fn set_flags(&self, folder: &RemoteFolder, uids: &[Uid], op: FlagOp) -> Result<()>;
    async fn move_messages(&self, src: &RemoteFolder, uids: &[Uid], dst: &RemoteFolder) -> Result<()>;
    async fn append(&self, folder: &RemoteFolder, raw: &RawMessage, flags: &[Flag]) -> Result<Uid>;
    async fn send(&self, raw: &RawMessage) -> Result<()>;

    // OPTIONAL real-time — default Unsupported. Scheduler only calls these when
    // capabilities() advertises them.
    async fn watch(&self, folder: &RemoteFolder) -> Result<WatchStream> { Err(Error::Unsupported) }
    async fn ping(&self, collections: &[CollectionRef]) -> Result<PingEvent> { Err(Error::Unsupported) }
}
```

**Factory:** `MailSourceFactory::for_account(account) -> Arc<dyn MailSource>`, keyed on
`account.provider`, returning a cached instance. The frontend never constructs a source.

`ImapSource` advertises `idle` + `condstore` from the server's CAPABILITY (negotiated on
connect — the current client skips CAPABILITY; we add it). `EasSource` advertises `ping`.

---

## 5. Cursor model & delta sync

Per-folder cursors, owned and persisted by Rust.

- **IMAP** → `folder_sync_state (account_id, folder_path, uidvalidity, highest_uid,
  highest_modseq, last_sync_at)`. Resurrect this table (exists in schema v14, currently dead).
  - `sync_folder` calls the existing `imap_delta_check` (UIDVALIDITY check + new-UID search),
    then `UID FETCH` for `highest_uid+1:*` (envelopes + flags). When CONDSTORE is available,
    also fetch `CHANGEDSINCE modseq` flag updates + `VANISHED`.
  - **UIDVALIDITY change ⇒ delete the folder's messages, reset `highest_uid=0` /
    `highest_modseq=0`, persist new uidvalidity, full resync.** (Thunderbird/Mailspring/Velo
    consensus — non-negotiable for cache correctness.)
- **EAS** → `eas_sync_state (account_id, folder_id, collection_id, sync_key, policy_key,
  last_sync_at)`. Resurrect (schema v25, dead). `EasSource.sync_folder` threads the saved
  `sync_key` through instead of today's hardcoded `'0'`.
- **Persistence rules** (from inbox-zero):
  - **Monotonic conditional update** — only advance the cursor if the new value is greater,
    so a slow older sync can't regress it under concurrent push + poll.
  - **Gap-bounding** — if the catch-up window exceeds a threshold (e.g. UID gap or stale
    modseq), skip *forward* to a bounded recent point and process forward rather than fetch
    the entire history.
- `accounts.last_sync_at` updated on every successful per-account sync round.

---

## 6. SyncEngine & AccountWorker

`SyncEngine` is a process singleton started once at app launch (after migrations). It owns:

- `workers: HashMap<AccountId, AccountWorkerHandle>` — add on account create, remove on
  delete.
- A shared `AppHandle` for emitting Tauri events.
- A bounded connection/exec budget per account (Thunderbird-style circuit breaker + Velo's
  tiered per-command `tokio::time::timeout`: 30s SELECT/LIST/STORE, 60s SEARCH, 120s FETCH,
  60s connect; TCP keepalive 60s).

**`AccountWorker`** (one Tokio task per account) has:

1. **op-queue** — `mpsc::channel<SyncOp>`. Ops: `SyncFolderNow`, `SyncAllFolders`,
   `EnqueueMutation`, `RequestBodies`, `Wake`, `Shutdown`. Serializing on one channel per
   account gives trivial ordering, cancellation, and IDLE coexistence (Thunderbird lesson).
2. **RealtimeStrategy** — chosen once from `source.capabilities()`:
   - `idle` ⇒ `IdleGuard` IDLEs on INBOX (Mailspring: IDLE **INBOX only**, `timeout=0`
     indefinite, interruptible via a `tokio::sync::Notify` + sending `DONE`). On
     `EXISTS`/`EXPUNGE`/`FLAG` untagged responses, post a `SyncFolderNow(INBOX)` op and a
     background sweep of changed folders. IDLE drops are swallowed (reconnect next loop).
   - `ping` ⇒ EAS `Ping` long-poll loop; on status change, post sync ops for affected
     collections.
   - `poll` ⇒ a wakeable `tokio::time::interval` (default 60s; per-folder shallow 2-min /
     deep 10-min cadence per Mailspring). This is the Phase 0 default for **all** sources.
3. **Background folder sweep** — wakeable sleep; on wake, iterate non-INBOX folders running
   `sync_folder` with the stored cursor. Inter-folder delay ~1s (avoid connection bursts).
4. **Body-fetch queue** — on-demand (frontend requests bodies for visible messages via
   `sync_request_bodies`) plus idle-time prefetch; bodies written to `message_bodies`.
5. **Offline-op replay loop** (Phase 1) — drains `pending_operations` in priority order
   (flags → moves → appends → deletes → sends), `compactQueue` first, 24-hr write-lock.
6. **Error/backoff** — Velo circuit breaker (3 fails ⇒ 15s cooldown, 5 ⇒ skip remaining
   folders this round); the existing `60 * 2^n` backoff is reused for the offline queue;
   retryable vs permanent classification (network/429/5xx retryable; 401/403 permanent).

Every state change emits a Tauri event (§8). The worker never touches the WebView directly.

---

## 7. DB migration — the clean cut

Rust becomes the **sole** SQLite owner via `sqlx` (compile-time-checked queries where
practical, runtime for dynamic ones), WAL mode. `tauri-plugin-sql` is **removed** from the
frontend.

**Steps:**

1. **Port the schema.** Convert the existing TS migration set
   (`kylins.client.frontend/src/services/db/migrations.ts`) to `sqlx` migrations under
   `kylins.client.backend/migrations/`. Preserve every table/column; this is a 1:1 port. The
   `_migrations` bookkeeping table becomes sqlx's `sqlx_migrations` (run automatically on
   connect). The existing user DB file `sqlite:mailclient.db` is reused in place.
2. **Resurrect dead cursor tables** as read/written by Rust: `folder_sync_state`,
   `eas_sync_state`. Add `messages.modseq` (NULLable) for future CONDSTORE per-message.
3. **Port frontend read functions to Tauri commands.** Each existing TS data-access function
   (`getThreads`, `getMessagesForThread`, `getMessageBody`, `getLabels`/folders, `getSetting`,
   `getAllAccounts`, …) becomes a `#[tauri::command] db_<name>` in Rust returning the same
   DTO. The TS function keeps its signature but its body becomes `invoke('db_<name>', …)`.
   **Frontend store code is unchanged** — only the data-access layer moves.
4. **Remove `tauri-plugin-sql`** and the frontend `getDb()`/`withTransaction()` once all
   reads are ported. Delete the now-dead TS files (`upsertImapMessages`, `folderSync.ts`
   write paths, `offlineQueue.ts` write paths — their logic moves into the engine).
5. **Secrets** continue through the existing `encrypt_secret`/`decrypt_secret` Rust commands
   + OS keyring; `accounts.access_token` etc. stay hex `nonce||ciphertext`. sqlx reads/writes
   them as opaque blobs; only the crypto commands (already Rust) touch plaintext.

**Risk & mitigation:** this is the largest single chunk of Phase 0. Mitigate by porting
table-groups behind the same DTO signatures and running the existing Vitest suite (mocks
updated to mock `invoke`) plus new Rust integration tests against a temp SQLite file after
each table-group port. The existing test suite is the regression net.

---

## 8. IPC / event contract

**Commands (frontend → backend):**

| Command | Purpose |
|---|---|
| `sync_start` / `sync_stop` | Engine lifecycle (start on app ready; stop on quit) |
| `sync_account_now(account_id)` | Manual "check mail" (also wired to `tray-check-mail`) |
| `sync_enqueue_op(account_id, op)` | Mutations: flag/move/delete/send/append |
| `sync_request_bodies(account_id, msg_ids)` | On-demand body fetch for visible messages |
| `db_<name>(...)` | Read commands (one per ported data-access fn) |

**Events (backend → frontend), emitted by the engine:**

| Event | Payload | Meaning |
|---|---|---|
| `sync:delta` | `{ op: "persist"\|"unpersist", table, rows[] }` | Mailspring-style coalesced row change (new/updated/deleted). Coalesced **by id within a transaction**, flushed at txn commit (≤500ms window). |
| `sync:new-mail` | `{ account_id, folder_id, count }` | New unread messages in an Inbox-equivalent folder → OS notification. |
| `sync:status` | `{ account_id, state, detail? }` | `idle`/`syncing`/`error`/`offline` for the status bar. |
| `sync:queue` | `{ account_id, pending }` | Offline-queue depth (D4: surface "Offline — N pending"). |

**Frontend `useSyncEvents()` hook** subscribes to all of the above:
- `sync:delta` → invalidate the matching store slice (`folderStore`, `threadStore`,
  `accountStore`) so the next read re-queries. (Zustand selectors re-render; no manual
  refresh.)
- `sync:new-mail` → `tauri-plugin-notification` + bump unread badge.
- `sync:status` → `uiStore` / status bar.
- `sync:queue` → status bar "Offline — N pending".

---

## 9. Frontend changes

- **Stores become read-only views.** `accountStore`, `folderStore`, `threadStore`,
  `viewStore` keep their shapes; their loaders call `db_*` commands; they are invalidated by
  `sync:delta`.
- **Data-access layer** (`services/db/*`, `services/mail/folderSync.ts`,
  `services/queue/offlineQueue.ts`) is deleted; the read paths become `invoke()` wrappers,
  the write paths move into the Rust engine.
- **Mutations** (composer send, mark-read, move, delete, star) call
  `invoke('sync_enqueue_op', …)`. Optimistic UI still happens in the store; the engine does
  the durable local-apply + remote-syncback (Phase 1).
- **`tray-check-mail`** gets a frontend listener (D4) that calls `sync_account_now` for the
  default account (or all).

---

## 10. Phased plan

### Phase 0 — Foundation (correctness via polling)
- Port schema to `sqlx` migrations; reuse the existing DB file.
- Implement `MailSource` trait + `ImapSource` (wrap existing `async-imap` client; add
  CAPABILITY negotiation) + `EasSource` (wrap existing EAS client; thread saved `sync_key`).
- Implement `SyncEngine` + `AccountWorker` with the **polling** RealtimeStrategy only — a
  single wakeable per-account interval (default 60s) that runs `sync_folder` for every folder
  against its stored cursor. (The shallow 2-min / deep 10-min *cadence* is a Phase 2
  background-sweep optimization layered on top of IDLE; Phase 0 keeps one simple interval.)
- Resurrect `folder_sync_state` / `eas_sync_state` as Rust-owned cursors with monotonic +
  gap-bounded advances; implement UIDVALIDITY-change wipe/resync.
- Port frontend read functions to `db_*` commands; remove `tauri-plugin-sql`.
- Emit `sync:delta` / `sync:status` / `sync:new-mail`; implement `useSyncEvents()`.
- **Exit criterion:** after account setup, mail syncs and **stays fresh via polling**; the
  UI updates through events with no manual refresh; opening a folder shows current server
  state. Today's "messages don't sync" gap is closed.

### Phase 1 — Offline replay (resilience)
- Move `pending_operations` consumption into `AccountWorker`.
- Route all mutations through optimistic-apply (store) → `sync_enqueue_op` → durable
  local-apply (engine writes to DB + emits `sync:delta`) → remote exec via the source.
- `compactQueue` (cancel toggle pairs, collapse sequential moves) before each replay pass.
- 24-hr write-lock: a just-mutated row's `syncedAt` is bumped so a concurrent server delta
  can't revert the local edit (Mailspring pattern).
- Emit `sync:queue` for the status bar.
- **Exit criterion:** send/flag/move/delete survive offline + crash; replay is correct under
  concurrent sync.

### Phase 2 — Real-time (latency)
- Implement `watch()` (IMAP IDLE) in `ImapSource` via `async-imap::extensions::idle`;
  `IdleGuard` IDLEs INBOX, interruptible, with reconnect-on-drop.
- Implement `ping()` in `EasSource`; `PingLoop` long-polls and posts sync ops.
- `RealtimeStrategy` auto-selects idle/ping/poll from `capabilities()`.
- Background folder sweep for non-INBOX folders (wakeable; shallow/deep cadence).
- **Exit criterion:** sub-second new-mail notification on IMAP + EAS; sources without push
  fall back to Phase 0 polling unchanged.

### Phase 3 — Provider breadth & hardening
- `GmailApiSource` (History API delta, `history_id` cursor) + `GraphSource` (delta token).
- QRESYNC for fast reconnect after downtime.
- Per-account rate-limit "mode" with TTL (inbox-zero) — short-circuit all calls for a
  throttled account until the window passes.
- Tray + notification polish; status-bar "Last synced" / "Offline — N pending".
- **Exit criterion:** multi-provider; hardened against rate limits and reconnect storms.

---

## 11. Testing strategy

- **Rust unit tests** (`cargo test --lib`): `MailSource` adapters against a fake/in-memory
  IMAP/EAS responder; cursor advance/monotonic/gap-bounding; UIDVALIDITY-change wipe;
  `compactQueue`; replay priority. Use the existing `tests/imap_smtp_integration.rs` harness
  for live IMAP CRUD against the test server.
- **Rust integration tests** against a temp SQLite file: sqlx migrations apply cleanly;
  round-trip read commands return expected DTOs; the engine populates + queries threads.
- **Frontend (Vitest):** update mocks from `@tauri-apps/plugin-sql` to `invoke` mocks;
  `useSyncEvents()` invalidates the right store slice per `sync:delta` payload; mutations
  call `sync_enqueue_op`; existing component/store tests remain green.
- **Manual:** account setup → polling keeps Inbox fresh; offline toggle → mutations queue
  and replay; IDLE (Phase 2) → send test mail, observe sub-second arrival + OS notification.

---

## 12. Risks & mitigations

| Risk | Mitigation |
|---|---|
| DB migration (§7) is large and touches every read path | Port table-group by table-group behind unchanged DTO signatures; the Vitest suite + new Rust integration tests are the regression net; reuse the existing DB file in place. |
| Frontend currently assumes it owns the DB | The clean cut removes `tauri-plugin-sql` entirely; no shared-writer ambiguity. |
| IDLE stability on flaky servers (Mailspring: Yandex drops) | Swallow IDLE-exit errors; reconnect next loop; the *next* failure is the real error. Circuit breaker + tiered timeouts. |
| UIDVALIDITY change is destructive (silent data loss for offline ops) | Surface a user-visible conflict banner (Phase 1) rather than silently dropping queued ops. |
| Concurrent optimistic edit vs server delta | 24-hr `syncedAt` write-lock (Phase 1, Mailspring). |
| Existing EAS always uses `sync_key '0'` | Phase 0 threads the real saved sync_key; covered by integration test. |

---

## 13. Implementation-plan scope

This spec is the **umbrella design** for the end-to-end sync engine (all four phases). The
**first implementation plan** (produced next via the `writing-plans` skill) covers **Phase 0
only** — the Rust-DB foundation, `MailSource` trait + IMAP/EAS adapters, resurrected cursors,
and the polling-only `SyncEngine` that closes today's "mail doesn't sync" gap. Phases 1–3
each get their own plan, built on the Phase 0 foundation, in the order in §10.

---

## 14. Open / deferred

- Gmail API + Graph providers (Phase 3).
- QRESYNC, VANISHED fetch, per-message `modseq` (Phase 3).
- Conflict-resolution UI for UIDVALIDITY-change op loss (Phase 1 polish).
- Calendaring/contacts are separate source types and out of scope.

---

## 15. Reference pointers

- Interface/factory/queue model: `…/velo/src/services/email/{types.ts,providerFactory.ts}`,
  `…/velo/src/services/emailActions.ts`, `…/velo/src/services/queue/queueProcessor.ts`.
- IDLE + delta protocol + process model: `…/Mailspring/mailsync/MailSync/SyncWorker.cpp`,
  `DeltaStream.cpp`, `TaskProcessor.cpp`.
- Cursor race-safety + rate-limit mode: `…/inbox-zero/apps/web/utils/webhook/google/process-history.ts`,
  `…/inbox-zero/apps/web/utils/email/rate-limit.ts`.
- Offline-op priority + UIDVALIDITY handling: `…/thunderbird-desktop/mailnews/imap/src/nsImapOfflineSync.cpp`.
- Full research: `docs/mail-sync-engine-research.md`.
