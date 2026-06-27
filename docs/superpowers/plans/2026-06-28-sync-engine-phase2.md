# Kylins Mail Sync Engine — Phase 2 Implementation Plan (Real-Time Push)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deliver sub-second new-mail arrival on IMAP via IDLE (the Mailspring/Thunderbird pattern: IDLE on INBOX, poll the rest), with the engine auto-selecting `idle`/`ping`/`poll` per source from advertised capabilities, and a polling fallback for sources without push.

**Architecture:** `ImapSource` gains real CAPABILITY negotiation (caches `idle`/`condstore`/`qresync` on first connect) and a `watch()` impl that holds a long-lived IMAP IDLE connection on INBOX (re-arming on each untagged `EXISTS`/`EXPUNGE`/`FLAG`, refreshing before the server's ~29-min timeout, sending `DONE` on drop). The `AccountWorker`, after its first sync round, reads `capabilities()` and — if `idle` is advertised — spawns a separate IDLE-watcher task that calls `watch(INBOX)` in a loop and nudges the existing sync round on each notification. The 60s poll loop stays as the background sweep (non-INBOX folders + the poll fallback for sources without push). `EasSource` gets a real `ping()` + `capabilities{ping:true}` so the strategy can select it; EAS *message* sync still awaits the WBXML Sync-response parser (deferred, unchanged from Phase 0).

**Tech Stack:** Rust (Tauri 2.10, `async-imap` 0.10 incl. `extensions::idle`, tokio), the existing `MailSource` trait + `ImapSource`/`EasSource`, `SyncEngine`/`AccountWorker` (`sync_engine/engine.rs`), `eas::client` (WBXML over HTTP). React frontend (minor status-indicator change only).

## Global Constraints

- **IDLE is INBOX-only** (Mailspring/Thunderbird consensus). Do NOT IDLE every folder — one long-lived connection per account on INBOX; other folders stay on the 60s poll sweep.
- **IDLE must be cancellable by drop.** When the watcher task is dropped (account removed / app shutdown / re-connect), the in-flight IDLE must send `DONE` and release the socket. Use the runtime's drop-cancellation (the `watch()` future is dropped → `async-imap`'s idle handle drops → it sends `DONE`).
- **Keepalive refresh:** re-init IDLE before the server's idle timeout (~29 min) even with no traffic, to avoid a silent dead connection. Use a watchdog `tokio::time::timeout` shorter than the server timeout; on timeout, drop + re-`watch()`.
- **`watch()` is blocking + cancelable:** `async fn watch(&self, folder: &RemoteFolder) -> Result<(), SourceError>` returns `Ok(())` on the first untagged notification (caller then re-syncs + re-idles), `Err` on disconnect. It owns its own connection (NOT the per-call connect used by other methods — IDLE needs a persistent socket).
- **Strategy selection is data-driven:** the worker reads `source.capabilities()` and picks `idle` (caps.idle) / `ping` (caps.ping) / `poll` (default). The poll loop MUST remain the fallback and the background sweep for non-INBOX folders.
- **async-imap IDLE API:** consult current docs (use Context7 MCP: resolve `async-imap`, query "idle extension usage" — the exact method names for init/wait/done vary across 0.x). Do NOT guess the API from memory.
- **CAPABILITY negotiation:** `ImapSource::capabilities()` is sync and cannot connect — so cache caps in `Mutex<Option<Capabilities>>` populated on the first `list_folders`/`sync_folder`/`watch` connect; `capabilities()` returns the cached value or `Capabilities::default()` if not yet warmed. The worker selects strategy AFTER the first sync round (caps known by then).
- **DTOs:** unchanged from Phase 0/1. The `MailSource` trait already has `watch()`/`ping()` with `Err(SourceError::Unsupported)` defaults — you only override them in `ImapSource`/`EasSource`.
- **Scope:** Phase 2 only. The EAS WBXML Sync-response parser (so `EasSource::sync_folder` delivers actual messages) is a KNOWN DEFERRAL — implement EAS `ping()` + `list_folders()` + `capabilities`, but `sync_folder` stays a documented empty-delta stub until that parser lands (tracked follow-up). Gmail/Graph (Phase 3) out of scope.
- **Commit cadence:** one commit per task. Run `cargo test --lib` + frontend Vitest at each boundary.

---

## File Structure

**Backend (Rust) — modified:**
- `src/mail/imap/client.rs` — add `pub async fn session_capabilities(session: &mut ImapSession) -> Capabilities` (CAPABILITY negotiation). NOTE: `Capabilities` lives in `sync_engine`; to avoid `mail/imap` depending on `sync_engine`, return a small local `(idle, condstore, qresync, vanished)` tuple and map it in `ImapSource`.
- `src/sync_engine/imap_source.rs` — cache `caps: Mutex<Option<Capabilities>>` (populated on connect), override `capabilities()`; implement `watch()` (IDLE).
- `src/sync_engine/eas_source.rs` — real `list_folders` (via `eas::client` `folder_sync`), `ping` (via `eas::client` `ping`), `capabilities()` → `{ping:true}`; `sync_folder` stays empty-delta stub (WBXML parser deferred).
- `src/sync_engine/engine.rs` — `AccountWorker`: after the first sync round, if `source.capabilities().idle` spawn an IDLE-watcher task (loop `watch(INBOX)` → `sync_account_now`); store its `JoinHandle` so `stop_all`/worker removal aborts it. The poll loop stays.

**Frontend — minor:**
- `src/hooks/useSyncEvents.ts` (or `uiStore`) — optional: surface an `idle-connected` state from `sync:status`. (Nice-to-have; not blocking the exit criterion.)

---

## Task 1: CAPABILITY negotiation in ImapSource

**Files:**
- Modify: `kylins.client.backend/src/mail/imap/client.rs`
- Modify: `kylins.client.backend/src/sync_engine/imap_source.rs`
- Test: `imap_source.rs` + `client.rs` `#[cfg(test)]`

**Interfaces:**
- Consumes: `ImapSession`, `async-imap` `Session::capabilities()`.
- Produces: `imap_client::session_capabilities(session) -> (bool,bool,bool,bool)` (idle, condstore, qresync, vanished); `ImapSource` caches `Capabilities` and `capabilities()` returns it.

- [ ] **Step 1: Failing test** — a unit test that builds a `Capabilities` from a fake capability-set string list and asserts `idle`/`condstore`/`qresync` flags map correctly (`IDLE`→idle, `CONDSTORE`→condstore, `QRESYNC`→qresync, `VANISHED`→vanished). (Test the pure mapping fn, not the live `Session::capabilities()` call which needs a socket.)

- [ ] **Step 2: Run — expect FAIL.**

- [ ] **Step 3: Implement**

In `src/mail/imap/client.rs`, add a pure helper that maps an iterator of capability strings to the tuple (so it's unit-testable without a socket):
```rust
/// Map a set of IMAP capability strings to the feature flags the sync engine cares
/// about. Pure so it's unit-testable; `session_capabilities` runs the live command
/// then delegates here.
pub fn capabilities_from_strs<'a, I: IntoIterator<Item = &'a str>>(caps: I) -> (bool, bool, bool, bool) {
    let mut idle = false; let mut condstore = false; let mut qresync = false; let mut vanished = false;
    for c in caps {
        let up = c.to_ascii_uppercase();
        match up.as_str() {
            "IDLE" => idle = true,
            "CONDSTORE" => condstore = true,
            "QRESYNC" => qresync = true,
            "VANISHED" => vanished = true,
            _ => {}
        }
    }
    (idle, condstore, qresync, vanished)
}

/// Run CAPABILITY on an open session and map to the feature tuple.
pub async fn session_capabilities(session: &mut ImapSession) -> Result<(bool, bool, bool, bool), String> {
    let caps = session.capabilities().await.map_err(|e| e.to_string())?;
    Ok(capabilities_from_strs(caps.iter().map(|c| c.as_str())))
}
```

In `src/sync_engine/imap_source.rs`, add caps caching:
```rust
use std::sync::Mutex;
pub struct ImapSource {
    account: Account,
    caps: Mutex<Option<Capabilities>>,
}
impl ImapSource {
    pub fn new(account: Account) -> Self { Self { account, caps: Mutex::new(None) } }
    fn remember_caps(&self, session: &mut ImapSession) {
        // best-effort: query + cache; ignore errors (caps stay None -> default)
        // NOTE: this is async — see Step 3b for the await pattern.
    }
}
impl MailSource for ImapSource {
    fn capabilities(&self) -> Capabilities {
        self.caps.lock().unwrap().unwrap_or_default()
    }
    // in list_folders / sync_folder, AFTER connect, do:
    //   if let Ok((idle,condstore,qresync,van)) = imap_client::session_capabilities(&mut session).await {
    //       *self.caps.lock().unwrap() = Some(Capabilities { idle, condstore, qresync, ping:false, vanishearch: van });
    //   }
    ...
}
```
- **Step 3b:** because `session_capabilities` is async, capture caps inside the existing async methods (`list_folders`/`sync_folder`) right after `connect(...)`, before the logout. Add the `if let Ok(...) = ... .await { *self.caps.lock().unwrap() = Some(...) }` block in both. Map the tuple into `Capabilities { idle, condstore, qresync, ping: false, vanishearch: vanished }`.

- [ ] **Step 4: Run — expect PASS.**
- [ ] **Step 5: Commit** — `feat(sync): ImapSource CAPABILITY negotiation (cached caps)`.

---

## Task 2: IMAP IDLE in `ImapSource::watch()`

**Files:**
- Modify: `kylins.client.backend/src/sync_engine/imap_source.rs`
- Test: `imap_source.rs` (smoke/unit) + live e2e in Task 4

**Interfaces:**
- Consumes: `async-imap::extensions::idle`, `imap_client::connect`, the `MailSource::watch` trait method.
- Produces: `ImapSource::watch(folder) -> Result<(), SourceError>` that blocks until an INBOX change notification (or keepalive timeout), cancelable by drop.

- [ ] **Step 1: Fetch the async-imap IDLE API (Context7)** — resolve `async-imap` and query "idle extension: init, wait, done, Stream of notifications". Capture the exact method names for 0.10 (e.g. `session.idle()` → `Idle`, `.init().await`, `.wait().await` / streaming). Write the API sketch in the report. **Do not guess.**

- [ ] **Step 2: Failing smoke test** — assert `ImapSource::watch` exists and returns `Err` (or hangs-then-canceled) when pointed at a non-existent/loopback that rejects IDLE — OR, since a real IDLE needs a socket, write a test that cancels `watch()` via `tokio::time::timeout(very_short)` and asserts it returns via cancellation (proving drop-cancellation works). The live behavior is validated in Task 4's e2e.

- [ ] **Step 3: Implement** `watch()`. Pattern (fill exact API from Step 1):
```rust
async fn watch(&self, folder: &RemoteFolder) -> Result<(), SourceError> {
    let config = self.imap_config();
    let mut session = imap_client::connect(&config).await.map_err(other)?;
    // IDLE requires a selected mailbox.
    session.select(&folder.remote_id).await.map_err(other)?;
    // cache caps while we have a session
    if let Ok((idle,condstore,qresync,van)) = imap_client::session_capabilities(&mut session).await {
        *self.caps.lock().unwrap() = Some(Capabilities { idle, condstore, qresync, ping:false, vanishearch: van });
    }
    loop {
        // Enter IDLE. The exact calls come from the Context7 lookup in Step 1;
        // typically: let idle = session.idle(); let handle = idle.init().await?;
        // Then wait with a watchdog shorter than the server timeout (~29min):
        match tokio::time::timeout(Duration::from_secs(28 * 60), wait_for_idle_notification(&mut session)).await {
            Ok(Ok(())) => {
                // Server signaled a change (EXISTS/EXPUNGE/FLAG). Return so the caller
                // re-syncs, then re-enters watch().
                let _ = session.logout().await;
                return Ok(());
            }
            Ok(Err(e)) => { let _ = session.logout().await; return Err(other(e.to_string())); }
            Err(_elapsed) => {
                // Watchdog fired before the server timeout: send DONE, re-init IDLE
                // (keeps the connection alive). Loop continues.
                // (send DONE per the API from Step 1; re-select + re-idle)
            }
        }
    }
}
```
Where `wait_for_idle_notification` wraps the blocking IDLE wait from the API lookup. **Cancellation:** the outer `tokio::select!` in the watcher task (Task 3) drops this future → the `Idle` handle drops → async-imap sends `DONE`. Confirm via the Step 2 cancellation test.

- [ ] **Step 4: Run — expect PASS** (cancellation test; live notification = Task 4 e2e).
- [ ] **Step 5: Commit** — `feat(sync): ImapSource IDLE watch() on INBOX (interruptible, keepalive)`.

---

## Task 3: RealtimeStrategy — IDLE watcher task in AccountWorker

**Files:**
- Modify: `kylins.client.backend/src/sync_engine/engine.rs`
- Test: `engine.rs` `#[cfg(test)]` (strategy selection with a MockSource advertising caps)

**Interfaces:**
- Consumes: `source.capabilities()`, `ImapSource::watch` (via `MailSource::watch`), `SyncEngine::sync_account_now`.
- Produces: per-account IDLE watcher task spawned when `caps.idle`; `WorkerHandle` stores its `JoinHandle` so it's aborted on shutdown/removal.

- [ ] **Step 1: Failing test** — drive a `MockSource` with `Capabilities { idle: true, .. }` through a strategy-selection helper and assert an "idle watcher should run" decision; with `idle: false` assert "poll only". (The watcher task itself needs a real IDLE socket — test the DECISION, not the live task. Use a `MockSource::with_caps(...)`.)

- [ ] **Step 2: Run — expect FAIL.**

- [ ] **Step 3: Implement**

Extend `WorkerHandle` to hold the IDLE watcher's `JoinHandle`:
```rust
struct WorkerHandle {
    tx: mpsc::Sender<SyncOp>,
    idle_watcher: Option<tokio::task::JoinHandle<()>>,
}
```
In `spawn_worker`, after the first `run_sync_round` (so caps are cached), decide the strategy and optionally spawn the IDLE watcher. Refactor the worker body so the strategy check runs once after the initial round:
```rust
tokio::spawn(async move {
    // First round (populates caps + does an initial sync/replay).
    let _ = run_sync_round(&engine, &aid, &provider).await;

    // Strategy: if the source advertises IDLE, spawn a watcher for INBOX that nudges
    // a sync round on each notification. The poll loop below stays as the background
    // sweep for non-INBOX folders + the fallback.
    let idle_watcher = {
        let src = crate::sync_engine::source_for_account(&engine.pool, &aid).await.ok();
        if let Some(src) = src {
            if src.capabilities().idle {
                let engine2 = Arc::clone(&engine);
                let aid2 = aid.clone();
                Some(tokio::spawn(async move {
                    loop {
                        // Resolve the INBOX folder (role=inbox) from the DB.
                        let inbox = match crate::db::labels::get_folder_by_role(&engine2.pool, &aid2, "inbox").await {
                            Ok(Some(f)) => f, _ => { tokio::time::sleep(Duration::from_secs(60)).await; continue; }
                        };
                        // watch() blocks until a notification (or returns on disconnect).
                        let folder = RemoteFolder { remote_id: inbox.remoteId_or_id(), name: inbox.name.clone(), delimiter: inbox.delimiter.clone().unwrap_or_else(|| "/".into()), role: Some("inbox".into()), ..Default::default() };
                        match src.watch(&folder).await {
                            Ok(()) => { engine2.sync_account_now(aid2.clone()).await; }   // nudge
                            Err(e) => { log::warn!("[sync] {aid2} IDLE err: {e}"); tokio::time::sleep(Duration::from_secs(30)).await; }
                        }
                    }
                }))
            } else { None }
        } else { None }
    };

    // Store the watcher handle + run the poll loop (unchanged).
    {
        let mut ws = engine.workers.lock().await;
        if let Some(h) = ws.get_mut(&aid) { h.idle_watcher = idle_watcher; }
    }

    let mut tick = tokio::time::interval(Duration::from_secs(POLL_INTERVAL_SECS));
    tick.tick().await;
    loop {
        tokio::select! {
            _ = tick.tick() => { let _ = run_sync_round(&engine, &aid, &provider).await; }
            op = rx.recv() => match op {
                Some(SyncOp::SyncNow) => { let _ = run_sync_round(&engine, &aid, &provider).await; }
                Some(SyncOp::Shutdown) | None => break,
            }
        }
    }
    // (the idle_watcher JoinHandle is aborted by stop_all / worker removal)
});
```
Update `stop_all` (and any worker-removal path) to also `abort()` the `idle_watcher` JoinHandle. NOTE: `get_folder_by_role` returns the labels `MailFolder` DTO — map its `remoteId` (or `id`) to `RemoteFolder.remote_id`; the inbox's `remote_id` IS the IMAP path (e.g. `"INBOX"`). Check the exact `MailFolder` field name for the remote id (it's `remoteId` in the camelCase DTO).

- [ ] **Step 4: Run — expect PASS** (strategy-decision test). Full `cargo test --lib` green (the live IDLE task only spawns against a real account; tests use MockSource which doesn't advertise idle by default, so no watcher spawns in tests).
- [ ] **Step 5: Commit** — `feat(sync): RealtimeStrategy — IDLE watcher task + poll fallback`.

---

## Task 4: EAS real impl (`list_folders` + `ping`; sync_folder deferred)

**Files:**
- Modify: `kylins.client.backend/src/sync_engine/eas_source.rs`
- Test: `eas_source.rs` (mapping tests) + live optional

**Interfaces:**
- Consumes: `eas::client::EasClient::{folder_sync, ping, sync}`, `eas::types::{EasConfig, PingRequest, PingCollection}`.
- Produces: `EasSource::list_folders` (real), `ping` (real), `capabilities() -> {ping:true}`; `sync_folder` stays empty-delta stub.

- [ ] **Step 1: Failing test** — `EasSource::capabilities()` returns `Capabilities { ping: true, .. }` (the strategy signal). And a pure `eas_folder_to_remote` mapping test (EasFolder → RemoteFolder).

- [ ] **Step 2: Run — expect FAIL.**

- [ ] **Step 3: Implement**
```rust
fn capabilities(&self) -> Capabilities { Capabilities { ping: true, ..Default::default() } }

async fn list_folders(&self) -> Result<Vec<RemoteFolder>, SourceError> {
    let client = EasClient::new(self.eas_config());
    let result = client.folder_sync("0").await.map_err(|e| SourceError::Other(e.to_string()))?;
    Ok(result.changes.iter().map(eas_folder_to_remote).collect())
}
async fn ping(&self, collections: &[(&str, &str)]) -> Result<(), SourceError> {
    let client = EasClient::new(self.eas_config());
    let req = PingRequest {
        heartbeat_interval: 1800, // 30 min < server max (~3540)
        monitored_collections: collections.iter()
            .map(|(id, cls)| PingCollection { collection_id: id.to_string(), class: cls.to_string() })
            .collect(),
    };
    client.ping(&req).await.map(|_| ()).map_err(|e| SourceError::Other(e.to_string()))
}
async fn sync_folder(&self, _folder: &RemoteFolder, _since: Cursor) -> Result<FolderDelta, SourceError> {
    // DEFERRED: EAS message sync needs the WBXML Sync-response parser
    // (eas::client::sync currently returns SyncResult::default()). Until that lands,
    // EAS accounts get folder list + ping notifications but no message bodies via sync.
    Ok(FolderDelta { added: vec![], updated: vec![], vanished_uids: vec![], next_cursor: Cursor::initial_eas(&_folder.remote_id), uidvalidity_changed: false })
}
```
Add `eas_config(&self) -> EasConfig` (map Account → EasConfig: url=easUrl, username=imapUsername||email, password=imapPassword, protocol_version=easProtocolVersion||"16.1", device_id=easDeviceId, device_type="KylinsMail", user_agent="KylinsMail/1.0", policy_key=easPolicyKey||"", accept_invalid_certs). Add `eas_folder_to_remote(EasFolder) -> RemoteFolder` (role from folder_type).

- [ ] **Step 4: Run — expect PASS** (capabilities + mapping tests; live EAS = optional manual).
- [ ] **Step 5: Commit** — `feat(sync): EasSource list_folders + ping + capabilities (message sync deferred)`.

---

## Task 5: End-to-end verification + regression

**Files:** none (verification + any fix that surfaces).

- [ ] **Step 1: Full backend suite** `cd kylins.client.backend && cargo test --lib` — expect all green (incl. Phase 1's 220 + Phase 2's new tests).
- [ ] **Step 2: Full frontend suite** `cd kylins.client.frontend && npx tsc --noEmit && npx vitest run` — expect green (frontend unchanged or minor status indicator).
- [ ] **Step 3: Manual real-time e2e** `cargo tauri dev`:
  - Create/restore the IMAP account; let Inbox sync.
  - DevTools network/console: confirm a `sync:status` → `idle` (or the IDLE watcher running) once connected.
  - From another client, send a test mail to the account → it should appear in Kylins **within ~1-2 seconds** (vs the 60s poll) with an OS notification. This is the Phase 2 exit criterion.
  - Confirm non-INBOX folders still refresh on the 60s poll (background sweep).
  - (Optional, if an EAS server is available) EAS account: folder list loads; ping loop runs (logs); message sync deferred → note in console.
- [ ] **Step 4: Commit any fix** the e2e surfaces.
- [ ] **Step 5: Update ledger** — Phase 2 complete.

---

## Self-review notes

- **Spec coverage (umbrella spec §10 Phase 2):** `watch()` IDLE on INBOX = Task 2 (+ strategy wiring Task 3); background folder sweep = Task 3 (poll loop retained); `ping()` EAS = Task 4; strategy auto-select from `capabilities()` = Task 3; CAPABILITY negotiation = Task 1; exit (sub-second IMAP via IDLE, poll fallback) = Task 5. ✅
- **Known deferral (unchanged from Phase 0):** EAS **message** sync awaits the WBXML Sync-response parser (`eas::client::sync` returns default). Task 4 ships EAS folder-sync + ping + caps so the strategy can select `ping`, but `sync_folder` is an empty-delta stub until the parser lands. Tracked follow-up.
- **Type consistency:** `watch()`/`ping()` override the trait's default `Err(Unsupported)`. `WorkerHandle.idle_watcher: Option<JoinHandle<()>>` is added in Task 3 and aborted in `stop_all`. `Capabilities` field names (`idle`, `condstore`, `qresync`, `ping`, `vanishearch`) are reused exactly.
- **Risk:** the async-imap IDLE API surface (Task 2) is the one place the plan defers to a docs lookup (Context7) rather than hardcoding — this is intentional; the implementer must confirm the exact method names for 0.10 before writing the loop.

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-06-28-sync-engine-phase2.md`. Two execution options:

1. **Subagent-Driven (recommended)** — fresh subagent per task, review between tasks.
2. **Inline Execution** — this session via executing-plans, batched with checkpoints.

Which approach?
