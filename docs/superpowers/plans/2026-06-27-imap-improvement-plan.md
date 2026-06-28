# IMAP Improvement Plan — Learnings from imapflow

## Context

The Kylins IMAP layer works but is stateless: every Tauri command (`imap_fetch_messages`, `imap_set_flags`, etc.) opens a new TCP+TLS connection, SELECTs the folder, runs one operation, and tears down. That makes sync slow, rules out IMAP IDLE/push, and wastes server resources.

`imapflow` (the reference Node IMAP client in `D:\Projects\mailclient\opensource\imapflow`) solves this with:

- One persistent connection per account
- In-order command queueing / pipelining with tag-based promise resolution
- A mailbox lock mutex so concurrent operations cannot interleave SELECTs
- IMAP IDLE with a `preCheck` breaker to transition back to command mode
- Automatic throttling/backoff for Office 365
- STARTTLS plaintext-injection guard
- Multiple auth fallbacks (OAUTHBEARER, XOAUTH2, SASL PLAIN, LOGIN)
- QRESYNC/CONDSTORE for delta sync, COMPRESS=DEFLATE, streaming body download

Kylins already has the right surrounding architecture: the Phase 0 sync-engine plan (`docs/superpowers/plans/2026-06-27-sync-engine-phase0.md`) defines a `MailSource` trait, `ImapSource` adapter, `SyncEngine` singleton, per-account `AccountWorker` polling, and `sync:*` Tauri events. Tasks 1–5 (DB cutover) are complete; Tasks 6–10 (trait, adapters, engine, events) are pending.

This plan maps the imapflow-inspired improvements onto those pending Tasks 6–10, keeping the scope realistic and incremental.

## Recommended approach

### 1. Single persistent IMAP session per account

Instead of opening a connection per command, keep one long-lived `ImapSession` per account. This is the highest-value change and mirrors imapflow’s `ImapFlow` instance.

**Key design decision — `Send` or not?**

`async-imap` futures/types may or may not be `Send` depending on version/features. The plan must start with a quick compile-time probe (see Verification). Two implementations are possible:

- **If `ImapSession` is `Send`:** wrap it in `tokio::sync::Mutex<ImapSession>` and keep it in a `HashMap<String, Arc<Mutex<ImapSession>>>` keyed by account ID, accessed directly from async Tauri commands and the `AccountWorker`.
- **If `ImapSession` is `!Send`:** spawn a dedicated OS thread per account running a single-threaded Tokio `LocalSet`, and communicate via an MPSC channel + oneshot replies (actor pattern). This also gives us mailbox serialization for free because the actor processes one command at a time.

In either case the external contract is the same: a `SessionHandle` that accepts IMAP commands and returns replies.

### 2. Integrate the persistent session into the existing Phase 0 tasks

| Existing Task | Refinement from imapflow study |
|---|---|
| **Task 6 — `MailSource` trait + factory** | No change to the trait shape. Add a `SessionManager`/`ImapActorHandle` abstraction so `ImapSource` does not own a raw connection directly. |
| **Task 7 — `ImapSource` adapter** | Replace per-call `client::connect(...)` with `session_manager.get(account_id).execute(...)` for `list_folders`, `sync_folder`, flag/mutation helpers. Add a `capabilities()` probe on first connect. Add throttling backoff (exponential, 500 ms → 5 min cap) around transient failures. |
| **Task 8 — cursors + `apply_folder_delta`** | No structural change. Use `folder_sync_state` cursor from the existing schema. |
| **Task 9 — `SyncEngine` + `AccountWorker`** | The worker holds the `SessionHandle` for its account; the 60 s polling tick reuses the same connection. Add a `NOOP` keep-alive every ~25 min inside the session manager so the server does not idle-timeout us. |
| **Task 10 — frontend wiring + EasSource** | `folderStore.syncFolder` calls `invoke('sync_account_now')` instead of instantiating `ImapProvider`. `useSyncEvents` listens for `sync:delta`/`sync:status`/`sync:new-mail`. Keep existing `imap_*` Tauri commands but make them route through the same session manager. |

### 3. Keep existing `imap_*` Tauri commands alive (for now)

The frontend still calls commands like `imap_append_message` when sending via SMTP + APPEND-to-Sent, and `imap_fetch_attachment` when viewing attachments. Rather than deleting these commands immediately, route them through the shared session manager. This gives incremental migration and avoids breaking the UI.

Long-term (after the sync engine is stable) the ad-hoc commands can be retired in favor of `sync_request_bodies` and an offline-op queue, but that is Phase 1, not Phase 0.

### 4. Mailbox serialization

IMAP requires that only one mailbox be SELECTed at a time on a given connection. The persistent session manager enforces this:

- `Mutex<ImapSession>` path: an async mutex naturally serializes commands; add an internal `selected_mailbox: Option<String>` and re-SELECT only when the requested folder differs.
- Actor path: the actor loop processes one message at a time, which is the mailbox lock.

### 5. What to defer

These imapflow features are valuable but out of Phase 0 scope:

| Feature | Reason | Target |
|---|---|---|
| IMAP IDLE / real-time push | Needs IDLE→command breaker state machine; polling MVP is sufficient first | Phase 2 |
| QRESYNC/CONDSTORE delta sync | Requires capability detection + modseq cursor; current `highest_uid` delta is enough for MVP | Phase 3 |
| COMPRESS=DEFLATE | Bandwidth optimization, not correctness | Phase 3 |
| Streaming body download | Current `BODY.PEEK[]` loads full message; streaming needs async generator refactor | Phase 3 |
| OAUTHBEARER / SASL PLAIN / LOGIN fallback | Current XOAUTH2 + password LOGIN covers Gmail/Office365/IMAP; expand later | Phase 1 |

### 6. Authentication / token refresh

For now keep the existing `XOAuth2` and password flows. When OAuth tokens expire during a long-lived session, the session manager should detect `AUTHENTICATIONFAILED`, close the session, and let the next command trigger a fresh login using the account’s (decrypted) credentials. A future improvement is an explicit token-refresh callback channel.

## Critical files to modify

### New files

- `kylins.client.backend/src/mail/imap/session_manager.rs` — `SessionManager` + `SessionHandle`; owns the account ID → persistent session map. If the `!Send` actor path is chosen, this file becomes `actor.rs`.
- `kylins.client.backend/src/sync_engine/mod.rs` — `MailSource` trait, `Capabilities`, `Cursor`, `FolderDelta`, `RemoteFolder`, `RemoteMessage`, factory.
- `kylins.client.backend/src/sync_engine/imap_source.rs` — `ImapSource` implementing `MailSource` via the session manager.
- `kylins.client.backend/src/sync_engine/engine.rs` — `SyncEngine` singleton + `AccountWorker` (Tokio task or OS thread depending on session path).
- `kylins.client.backend/src/sync_engine/commands.rs` — `sync_start`, `sync_stop`, `sync_account_now`, `sync_request_bodies`.
- `kylins.client.frontend/src/hooks/useSyncEvents.ts` — subscribe to `sync:*` events and refresh folder/thread stores.

### Modified files

- `kylins.client.backend/src/mail/imap/client.rs` — keep existing connect/auth/fetch helpers, but expose them so the session manager can call them once and hold the `Session`. Add `capabilities()` probe.
- `kylins.client.backend/src/mail/imap/mod.rs` — add `pub mod session_manager;`.
- `kylins.client.backend/src/commands.rs` — existing `imap_*` commands now acquire the session from `SessionManager` instead of calling `connect()`.
- `kylins.client.backend/src/lib.rs` — init `SessionManager`, build `SyncEngine`, register sync commands in `generate_handler!`.
- `kylins.client.frontend/src/App.tsx` — call `invoke('sync_start')` after accounts load; add `useSyncEvents()`.
- `kylins.client.frontend/src/stores/folderStore.ts` — replace `syncFolder` body with `invoke('sync_account_now', { accountId: folder.accountId })`.
- `kylins.client.frontend/src/components/account-setup/AccountSetupFlow.tsx` — replace folder-sync calls with `invoke('sync_account_now', { accountId })`.

## Implementation order

1. **Probe `Send`:** write a tiny throwaway module that tries to put `ImapSession` in an `Arc<tokio::sync::Mutex<_>>` and spawn it across Tokio threads. Decide actor vs. mutex path.
2. **Task 6:** `MailSource` trait + types + session manager skeleton.
3. **Task 7a:** `ImapSource` using the session manager; background sync path only.
4. **Task 7b:** migrate existing `imap_*` Tauri commands to route through the session manager.
5. **Task 8:** `db::sync_state` cursors + `db::messages::apply_folder_delta` (message persistence).
6. **Task 9:** `SyncEngine` + `AccountWorker` polling + `sync:*` events.
7. **Task 10:** frontend event hook, `App.tsx` lifecycle, `folderStore.syncFolder` rewiring.

Each step should leave the app building and the existing IMAP commands functional.

## Verification

- **Compile probe:**
  ```rust
  // throwaway test in kylins.client.backend/src/mail/imap/client.rs tests
  fn assert_send<T: Send>() {}
  #[test]
  fn imap_session_is_send() {
      assert_send::<Session<ImapStream>>();
  }
  ```
  If it fails, use the actor path.

- **Per-step tests:**
  - `cargo test --lib mail::imap` after session manager integration
  - `cargo test --lib sync_engine::imap_source` after `ImapSource`
  - `cargo test --lib db::messages` after `apply_folder_delta`
  - `cargo test --lib sync_engine::engine` after `SyncEngine`

- **Frontend tests:**
  ```bash
  cd kylins.client.frontend
  npx tsc --noEmit
  npx vitest run
  ```

- **End-to-end:**
  ```bash
  cd kylins.client.backend
  cargo tauri dev
  ```
  - Create an IMAP account.
  - Folders should populate automatically via `sync_account_now`.
  - Wait for the 60 s polling tick (or trigger sync) and confirm new mail appears with a `sync:delta` event.
  - Confirm existing commands (`imap_fetch_attachment`, `imap_append_message` on send) still work.

## Notes and risks

- `async-imap` `!Send` would push us toward a per-account actor thread; this is safe but adds thread-count overhead. Verify early so the design does not have to change mid-implementation.
- The existing raw TCP fallback (`raw_fetch_messages`, `raw_fetch_diagnostic`) should be preserved and used only for diagnostics, not the sync path.
- Keep the existing `ImapMessage` / `ImapFolder` types; `ImapSource` maps them to `RemoteMessage` / `RemoteFolder`.
- Do not modify the existing DB schema — `folder_sync_state`, `messages`, `threads`, `message_bodies`, `thread_labels` already support the sync engine.
