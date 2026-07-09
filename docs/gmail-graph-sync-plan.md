# Gmail API & Microsoft Graph Sync Migration Plan

> Scope: migrate the Gmail and Microsoft 365/Outlook message sync paths in Kylins from IMAP/SMTP over OAuth2 to the native REST APIs (Gmail API and Microsoft Graph), while keeping IMAP/EAS as fallbacks/manual options.
>
> Based on a deep study of:
> - `D:\Projects\mailclient\opensource\inbox-zero` — Gmail/Graph sync patterns
> - `D:\Projects\mailclient\opensource\velo` — OAuth IMAP/SMTP patterns (note: Velo does **not** use Graph)
> - `D:\Projects\mailclient\opensource\google-apis-rs` — `google-gmail1` generated Rust API
> - `D:\Projects\mailclient\opensource\graph-rs-sdk` — Rust Microsoft Graph SDK mail/delta APIs
> - `D:\Projects\mailclient\kylins` — current Kylins skeleton, `MailSource` trait, DB schema, OAuth backend

## Reference SDK choices

| Provider | Reference codebase (TypeScript) | Proposed Rust equivalent |
|----------|--------------------------------|--------------------------|
| Gmail | `@googleapis/gmail` (`inbox-zero`) | `google-gmail1` from `google-apis-rs` |
| Microsoft Graph | `@microsoft/microsoft-graph-client` + `@microsoft/microsoft-graph-types` (`inbox-zero`) | `graph-rs-sdk` |

`inbox-zero` uses the official Google per-API packages and the official Microsoft Graph JS SDK. It does **not** use Graph `$delta` for mail; it relies on folder listing + message queries + webhook notifications. For Kylins we will still implement `$delta` for efficient incremental sync because the Rust SDK exposes it cleanly.

## High-level approach

Add `gmail_api` and `graph` as first-class `provider` values alongside existing `imap` and `eas`. Keep IMAP/EAS untouched so existing accounts and manual setups continue to work. Native API accounts are created from the same provider picker tiles, but the setup flow now writes `provider: 'gmail_api'` or `provider: 'graph'` instead of `provider: 'imap'`.

The implementation lives almost entirely in the Rust backend behind the existing `MailSource` abstraction:
- New `Cursor` variants for Gmail `history_id` and Graph `delta_token`.
- New per-folder sync-state tables `gmail_sync_state` and `graph_sync_state`.
- New `GmailSource` and `GraphSource` adapters implementing `MailSource`.
- Factory wiring in `source_for_account()`.
- OAuth token refresh moved into the sync worker.
- Frontend changes limited to OAuth scopes and account-setup builders.

## Resolved decisions

1. **SDK vs hand-rolled HTTP**: Use `google-gmail1` and `graph-rs-sdk` (local path dependencies if available, otherwise crates.io).
2. **IMAP fallback**: Expose an explicit IMAP/SMTP fallback toggle in the provider picker for Gmail and Outlook.
3. **Initial sync depth**: Cap initial import to the last 90 days (`newer_than:90d` for Gmail; `$filter=receivedDateTime ge ...` for Graph). User-configurable in settings later.

## Phase 1 — Foundation: Schema, Cursor, OAuth Refresh

1. **Add migration** `kylins.client.backend/migrations/20260707000001_gmail_graph_sync.sql`
   - Create `gmail_sync_state(account_id, label_id, history_id, last_sync_at)`
   - Create `graph_sync_state(account_id, folder_id, delta_token, last_sync_at)`
   - Add to `messages`: `gmail_message_id`, `graph_message_id`, `gmail_thread_id`, `graph_conversation_id`
   - Add indexes on `(account_id, gmail_message_id)` and `(account_id, graph_message_id)`

2. **Extend `Cursor` enum** in `kylins.client.backend/src/sync_engine/mod.rs`
   - Add `Gmail { history_id: String }` and `Graph { delta_token: String }`
   - Add `initial_gmail()` and `initial_graph()` constructors

3. **Add cursor helpers** in `kylins.client.backend/src/db/sync_state.rs`
   - `get_gmail_cursor`, `advance_gmail_cursor`
   - `get_graph_cursor`, `advance_graph_cursor`

4. **Wire cursor persistence** in `kylins.client.backend/src/sync_engine/engine.rs`
   - Extend the `if let` branches around lines 1397–1426 to advance new cursor variants

5. **Add reusable OAuth refresh helper** in `kylins.client.backend/src/oauth.rs`
   - `refresh_oauth_token(token_url, refresh_token, client_id, client_secret, scope)`
   - Called automatically by new sources when `token_expires_at` is within 5 min

6. **Wire factory** in `kylins.client.backend/src/sync_engine/mod.rs`
   - Match `"gmail_api"` and `"graph"` in `source_for_account()` (initially return a stub/todo source if Phase 2/3 not done)

7. **Frontend types** `kylins.client.frontend/src/types/index.ts`
   - `MailProvider = 'gmail_api' | 'imap' | 'eas' | 'graph'`
   - Add optional native ID fields to `Account`

8. **Frontend OAuth scopes** `kylins.client.frontend/src/services/auth/providers.ts`
   - Gmail: `https://www.googleapis.com/auth/gmail.modify`, `gmail.send`, `gmail.labels`, `openid`, `email`, `profile`, `offline_access`
   - Outlook/Microsoft 365: `https://graph.microsoft.com/Mail.ReadWrite`, `Mail.Send`, `User.Read`, `offline_access`, `openid`, `email`, `profile`

9. **Frontend account builders** `kylins.client.frontend/src/services/auth/accountSetupFlows.ts`
   - `buildGmailApiAccount()` → `provider: 'gmail_api'`
   - `buildGraphAccount()` → `provider: 'graph'`
   - Add an explicit IMAP/SMTP fallback toggle in the provider picker for Gmail/Outlook; when chosen, call the existing `buildImapAccount()` instead

**Verification:** New OAuth accounts are created with `provider = 'gmail_api'` or `'graph'`. `cargo build` and `npx tsc --noEmit` pass. Sync starts and fails gracefully with a clear "not implemented" status until Phase 2/3 land.

## Phase 2 — Gmail API Source

1. **Add Gmail API client dependency**
   - Use `google-gmail1` from the local `google-apis-rs` crate (path dependency) or crates.io

2. **Create** `kylins.client.backend/src/sync_engine/gmail_source.rs`
   - Implement `MailSource` for `GmailSource`
   - `capabilities()`: no idle, `saves_sent_automatically: true`
   - `list_folders()`: `users.labels.list` → map system labels (`INBOX`, `SENT`, `DRAFT`, `TRASH`, `SPAM`) to roles
   - `sync_folder()`:
     - Initial: `users.messages.list(labelIds=..., maxResults=500, q="newer_than:90d")` + batched `users.messages.get(format=metadata)`
     - Incremental: `users.history.list(startHistoryId)` filtered to the label
     - On stale history 404/`historyIdNotFound`, reset history_id and wipe cache
   - `fetch_body()`: `users.messages.get(format=full)` and extract HTML/text parts
   - `set_flags()`: `users.messages.batchModify` with `UNREAD`/`STARRED` labels
   - `move_messages()`: label add/remove (e.g., remove `INBOX`, add `TRASH`)
   - `delete_messages()`: `users.messages.batchDelete` or move to Trash
   - `send()`: `users.messages.send` with raw RFC5322 MIME

3. **Stable local UID**
   - Hash Gmail message ID string to `u32` using the same FNV-style multiplier already used in `eas_source.rs`
   - Store original in `messages.gmail_message_id`

4. **Wire factory** to instantiate `GmailSource` for `"gmail_api"`

5. **Tests**
   - Unit tests with mocked `reqwest` responses or trait seam
   - Manual end-to-end test with a real Gmail account

**Verification:** Gmail account syncs folders and messages; read/star/trash/send operations work; `sync:delta` events update the UI.

## Phase 3 — Microsoft Graph Source

1. **Add Graph client dependency**
   - Use `graph-rs-sdk` from the local checkout (path dependency) or crates.io

2. **Create** `kylins.client.backend/src/sync_engine/graph_source.rs`
   - Implement `MailSource` for `GraphSource`
   - `capabilities()`: no idle, `saves_sent_automatically: true`
   - `list_folders()`: `me/mailFolders` + recursive `childFolders`; map `wellKnownName` to roles
   - `sync_folder()`:
     - Use `/me/mailFolders/{id}/messages/delta`
     - Initial snapshot returns `@odata.deltaLink`; store token
     - Incremental follows `@odata.deltaLink`/`@odata.nextLink`
     - On `resyncRequired`, reset token and wipe cache
   - `fetch_body()`: `GET /me/messages/{id}?$select=body`
   - `set_flags()`: `PATCH /me/messages/{id}` with `isRead`, `flag/flagStatus`
   - `move_messages()`: `POST /me/messages/{id}/move`
   - `delete_messages()`: `DELETE /me/messages/{id}`
   - `send()`: `POST /me/sendMail` with raw MIME (base64)

3. **Stable local UID**
   - Hash Graph message ID string to `u32`
   - Store original in `messages.graph_message_id`

4. **Wire factory** to instantiate `GraphSource` for `"graph"`

5. **Tests**
   - Unit tests with mocked responses
   - Manual end-to-end test with Outlook / Microsoft 365 account

**Verification:** Graph account syncs folders and messages; read/star/move/delete/send operations work.

## Phase 4 — UI Polish & Threading

1. Provider picker/account badge rendering for `gmail_api` and `graph`
2. Use `gmail_thread_id` and `graph_conversation_id` for conversation grouping
3. Provider picker IMAP/SMTP fallback toggle for Gmail/Outlook
4. Rich sync-status events for API-specific errors (rate limit, auth failure, resync required)

## Critical files

Backend:
- `kylins.client.backend/src/sync_engine/mod.rs` — `Cursor`, `MailSource`, `source_for_account`
- `kylins.client.backend/src/sync_engine/engine.rs` — sync scheduling and cursor advancement
- `kylins.client.backend/src/sync_engine/gmail_source.rs` — new
- `kylins.client.backend/src/sync_engine/graph_source.rs` — new
- `kylins.client.backend/src/db/sync_state.rs` — cursor persistence helpers
- `kylins.client.backend/src/db/messages.rs` — `upsert_message` native ID extension
- `kylins.client.backend/src/oauth.rs` — token refresh helper
- `kylins.client.backend/migrations/20260707000001_gmail_graph_sync.sql` — new
- `kylins.client.backend/Cargo.toml` — new dependencies

Frontend:
- `kylins.client.frontend/src/services/auth/providers.ts` — scopes
- `kylins.client.frontend/src/services/auth/accountSetupFlows.ts` — account builders
- `kylins.client.frontend/src/types/index.ts` — types

## Key risks & mitigations

| Risk | Mitigation |
|------|------------|
| Large generated crates (`google-gmail1`, `graph-rs-sdk`) may have long compile times or awkward APIs | Spike dependency integration in Phase 1; fall back to `reqwest` + `serde` if needed |
| Rate limiting | Map 429/`Retry-After` to `SourceError::RateLimited`; the engine already persists rate-limit state and circuit breaks |
| OAuth token expiry during sync | Centralized Rust-side refresh before every `list_folders()` |
| Stale Gmail historyId | Reset to `"0"` and wipe folder cache on 404 |
| Graph delta token expiration | Reset token on `resyncRequired` |
| SQLite concurrency | Keep 200-message batches, WAL mode, 30 s busy timeout already configured |
| UID collisions from hashing opaque IDs | Accept low-probability FNV collision; add a `source_uid_map` table only if observed |
