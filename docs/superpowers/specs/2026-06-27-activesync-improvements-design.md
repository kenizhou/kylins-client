# ActiveSync Improvements — Design & Implementation Plan

## Context

The kylins-client EAS stack has a solid foundation: a Rust WBXML codec, HTTP transport, and Tauri command wrappers already support EAS 16.1. However, it is not yet functional for real mail sync:

- `kylins.client.backend/src/eas/client.rs::sync()` sends a `Sync` request but returns `SyncResult::default()` without parsing the response.
- No per-folder sync state is persisted; the frontend always calls `sync_key: "0"`.
- `Provision`, OAuth Modern Auth, AutoDiscover, calendar/contact/task sync, and the full `EmailProvider` interface are missing.

This plan is based on a study of three reference client/server implementations in `D:\Projects\mailclient\opensource\ActiveSync`, plus the original ArkTS source that kylins-client's Rust backend was ported from:

- `ExchangeActiveSync-master` (C# client) — clean request/response classes and explicit status enums.
- `Android6-Gmail` (Java client) — mature per-folder sync-key storage, windowed sync, automatic provisioning, redirect handling, and gzip.
- `Z-Push-contrib` (PHP server) — authoritative request/response shapes, status codes, and multipart response behavior.
- `mailkit_arkts` (ArkTS/HarmonyOS client) — the original reference port. It has the most complete coverage: granular status enums, service-layer orchestration (account, ping, mail store, mail folder), OAuth2 refresh, AutoDiscover/redirect/throttling, and a debug WBXML translator.

The goal is to make EAS a first-class mail provider in three incremental phases, pulling the most reliable patterns from all four references.

## Approach

Use a **phased, dependency-ordered rollout** rather than a big-bang PR:

1. **Phase 1 — Functional mail sync:** parse `Sync` responses, persist sync keys, and make EAS mail sync end-to-end usable.
2. **Phase 2 — Provider integration:** expand `MailProvider` to a full `EmailProvider` interface, add a provider factory, and wire the sync engine / offline queue.
3. **Phase 3 — EAS hardening:** add `Provision`, OAuth Modern Auth, AutoDiscover, and extend sync to calendar/contact/task classes.

Each phase can be implemented, reviewed, and verified independently.

## Design

### Rust backend modules

- `src/eas/client.rs` — low-level HTTP transport with retry, redirect, throttling, and autodiscover-on-failure (exists; extend in Phase 3).
- `src/eas/commands.rs` — request builders + response parsers (exists; complete `parse_sync_response`, add `Provision`/`AutoDiscover`/`MoveItems`/`Settings`/`Find` builders).
- `src/eas/service.rs` — Tauri command façade (exists; register new commands).
- **New** `src/eas/sync.rs` — higher-level mail sync loop: `GetItemEstimate` → windowed `Sync` → parse → return typed items + new sync key.
- **New** `src/eas/provision.rs` — two-phase Provision flow + policy-key lifecycle.
- **New** `src/eas/autodiscover.rs` — AutoDiscover V1 POX and V2 JSON, plus redirect handling.
- **New** `src/eas/oauth.rs` — Modern Auth header injection and refresh-token flow.
- **New** `src/eas/status.rs` — comprehensive status-code enums (`CommonStatus`, `SyncStatus`, `FolderSyncStatus`, `ItemOperationsStatus`, `PingStatus`, `ProvisionStatus`, etc.) and mapping to actions.
- **New** `src/eas/services/` — service-layer orchestration:
  - `account_service.rs` — AutoDiscover, capabilities (OPTIONS), provision, device-info registration.
  - `ping_service.rs` — adaptive heartbeat Ping loop.
  - `mail_store_service.rs` — high-level send/reply/forward/find/move.
  - `mail_folder_service.rs` — per-folder fetch/attachment/empty/move.
- **New / fill in** `src/db/sync_state.rs` — CRUD for `eas_sync_state`, per-folder sync keys, policy keys, and `ping_duration`.
- **New** `src/eas/wbxml_debug.rs` — optional WBXML→XML translator for debug logging (only enabled in dev builds).

### Frontend provider architecture

- `src/services/mail/provider.ts` — expand `MailProvider` to `EmailProvider` with `testConnection`, `getProfile`, `listFolders`, `initialSync`, `deltaSync`, `fetchMessage`, `fetchAttachment`, `applyActions`, `sendMessage`.
- **New** `src/services/mail/providerFactory.ts` — `getEmailProvider(account)` switch over `account.provider`.
- `src/services/mail/easProvider.ts` — implement `EmailProvider` for EAS; manage folder hierarchy, sync keys, and item upsync.
- `src/services/mail/imapProvider.ts` — adapt existing methods to `EmailProvider`.
- `src/services/calendar/easCalendarProvider.ts` — extend to use the new backend Sync parsers for calendar class.
- **New** `src/services/contacts/easContactsProvider.ts` and **New** `src/services/tasks/easTasksProvider.ts`.
- `src/services/queue/offlineQueue.ts` — add EAS action processor that calls `provider.applyActions()`.

### Data flow

#### Phase 1: Mail sync

1. `EasProvider.listFolders()` calls `eas_folder_sync` and maps `Add/Change/Delete` to the existing `folders` table, storing server IDs in `remote_id`.
2. Sync engine calls `EasProvider.syncFolder(folderId)`.
3. Provider reads `(sync_key, collection_id)` from `eas_sync_state` (folder `remote_id` is the EAS collection ID).
4. Rust `sync.rs` builds the `Sync` request with `CollectionId`, `GetChanges=true`, `DeletesAsMoves=true`, and `BodyPreference` for HTML/PlainText.
5. Server response is parsed into `SyncResult { added, updated, deleted, sync_key }` with typed email items.
6. Provider upserts `messages` and `message_bodies` through existing DB commands.
7. New `sync_key` is written back to `eas_sync_state`.
8. If the response contains `MoreAvailable`, loop with the same key until the window is drained.

#### Phase 2: Full provider integration

- Replace direct `new EasProvider(account)` / `new ImapProvider(account)` calls with `getEmailProvider(account)`.
- Refactor `composer/send.ts` to route through the factory.
- Offline queue processor resolves EAS mutations by calling `provider.applyActions()`; failures are re-enqueued with backoff.
- `fetchMessage` uses `ItemOperations` or a targeted `Sync` request with `CollectionId` + `ServerId`.
- `fetchAttachment` uses `ItemOperations` with `FileReference` and supports multipart responses.

#### Phase 3: Hardening

- **Provision:** on status `126`/`142` or HTTP `449`, run the Provision handshake, store the permanent policy key in `accounts.eas_policy_key`, and retry the original command with `X-MS-PolicyKey`.
- **OAuth:** when `auth_type == 'oauth'`, send `Authorization: Bearer <token>` and refresh via existing secret/crypto flow.
- **AutoDiscover:** new account setup calls `eas_autodiscover`; on success the returned EAS URL populates `accounts.eas_url`; on failure fall back to manual entry.
- **Calendar/Contacts/Tasks:** reuse `eas_sync` with `class: 'Calendar' | 'Contacts' | 'Tasks'` and parse code pages 4, 7, and 9.

### Error handling

Introduce a typed `EasError` enum and a comprehensive `src/eas/status.rs` module covering `CommonStatus`, `SyncStatus`, `FolderSyncStatus`, `ItemOperationsStatus`, `PingStatus`, `ProvisionStatus`, `SettingsStatus`, `SearchStatus`, `AutoDiscoverStatus`, etc. Map them consistently to recovery actions:

| EAS status / HTTP | Action |
|-------------------|--------|
| `SyncStatus.invalidSyncKey` (3) / `FolderSyncStatus.invalidSyncKey` (9) | Reset folder `sync_key` to `"0"` and re-run `FolderSync`/`Sync`. |
| `SyncStatus.folderHierarchyChanged` (12) | Re-run `FolderSync`, remap local folders, retry. |
| `CommonStatus.deviceNotProvisioned` (142), `CommonStatus.policyRefresh` (143), `CommonStatus.invalidPolicyKey` (144), `CommonStatus.remoteWipeRequested` (140) / HTTP 449 | Run `Provision`, then retry original command. |
| `CommonStatus.invalidContent` / WBXML parsing errors | Log full debug WBXML/XML dump, surface generic server-error message. |
| `ItemOperationsStatus.notFound` / `ObjectNotFound` (8) | Skip item, log warning. |
| `PingStatus.hierarchySyncRequired` (7) | Trigger `FolderSync` before resuming Ping. |
| HTTP `449` | Run Provision. |
| HTTP `451` + `X-MS-Location` | Follow redirect up to 3 times, then surface. |
| HTTP `401` / `403` | Trigger AutoDiscover if current URL may be stale; otherwise surface auth failure. |
| `Retry-After` header | Delay and retry once, then return to offline queue. |
| `ServerError` / transient network | Return to offline queue with exponential backoff. |
| Auth failures (Basic 401, OAuth token rejected) | Surface to user immediately; do not retry. |

Transport rules borrowed from `mailkit_arkts`:
- Omit `X-MS-PolicyKey` for `Provision`, `AutoDiscover`, and `Ping`; also omit when `policy_key == "0"`.
- Send `Accept-Encoding: gzip` and decompress responses.
- On `401`/`403`/`500`, attempt AutoDiscover once before failing.
- Honor `X-MS-CredentialsExpire` / `X-MS-CredentialServiceUrl` for password-expiry flows.

All upsync errors are stored on the queue item so users can inspect and retry.

### Testing

- **Backend unit tests:**
  - Extend WBXML tests with realistic `Sync` response fixtures covering Add/Change/Delete, `MoreAvailable`, and email body types.
  - Add sqlx tests for `eas_sync_state` CRUD.
  - Add tests for status-code mapping (`status.rs`) and recovery actions.
  - Add tests for Provision and AutoDiscover request builders.
  - Add service-layer tests for ping heartbeat adaptation, account service provision flow, and mail store/folder operations.
  - Add gzip response handling tests.
  - Add debug WBXML→XML translator tests (dev builds only).
- **Frontend unit tests:**
  - Mock `invoke` for every new Tauri command.
  - Test `EasProvider.syncFolder` state machine: first sync → `"0"`, steady-state → uses stored key, `InvalidSyncKey` → reset, `MoreAvailable` → loops.
- **Integration tests:**
  - Extend ignored `tests/eas_integration.rs` to cover Sync, Provision, SendMail, ItemOperations, AutoDiscover, and Ping when a real server is available.

## Implementation Plan

### Phase 1 — Functional mail sync

| # | Task | Files to modify / create |
|---|------|--------------------------|
| 1.1 | Add comprehensive EAS status-code enums (`CommonStatus`, `SyncStatus`, `FolderSyncStatus`, etc.) and mapping helpers. | **New** `backend/src/eas/status.rs` |
| 1.2 | Add `SyncResponse` types and complete `parse_sync_response` in Rust. | `backend/src/eas/types.rs`, `backend/src/eas/commands.rs` |
| 1.3 | Add email ApplicationData parser (code pages 2 + 17) producing typed `EasEmailItem`. | `backend/src/eas/commands.rs` or new `backend/src/eas/parsers.rs` |
| 1.4 | Implement windowed sync loop with `GetItemEstimate` and `MoreAvailable` handling. | **New** `backend/src/eas/sync.rs` |
| 1.5 | Fill in `src/db/sync_state.rs` with queries for `eas_sync_state`. | `backend/src/db/sync_state.rs`, `backend/src/db/commands.rs` |
| 1.6 | Add high-level Tauri command `eas_sync_folder` that reads/writes sync state and returns parsed items. | `backend/src/eas/service.rs`, `backend/src/eas/mod.rs` |
| 1.7 | Update `EasProvider.syncFolder` to read/write sync keys and call the new command. | `frontend/src/services/mail/easProvider.ts` |
| 1.8 | Implement `EasProvider.listFolders` to persist folder hierarchy after `FolderSync`. | `frontend/src/services/mail/easProvider.ts`, DB commands for folders |
| 1.9 | Add upsert logic for messages/bodies from parsed EAS items. | `frontend/src/services/mail/easProvider.ts` |
| 1.10 | Add frontend/backend tests for the new sync path. | `frontend/tests/services/mail/easProvider.test.ts`, `backend/src/eas/...` tests |

### Phase 2 — Provider integration

| # | Task | Files to modify / create |
|---|------|--------------------------|
| 2.1 | Expand `MailProvider` to `EmailProvider` interface. | `frontend/src/services/mail/provider.ts` |
| 2.2 | Create `providerFactory.ts` and refactor `composer/send.ts` to use it. | **New** `frontend/src/services/mail/providerFactory.ts`, `frontend/src/services/composer/send.ts` |
| 2.3 | Implement remaining `EmailProvider` methods on `EasProvider`. | `frontend/src/services/mail/easProvider.ts` |
| 2.4 | Adapt `ImapProvider` to `EmailProvider`. | `frontend/src/services/mail/imapProvider.ts` |
| 2.5 | Add EAS action processor to offline queue (mark read, flag, move, delete upsync). | `frontend/src/services/queue/offlineQueue.ts` |
| 2.6 | Implement `applyActions` in `EasProvider` using `Sync` client changes. | `frontend/src/services/mail/easProvider.ts`, `backend/src/eas/commands.rs` |
| 2.7 | Add tests for factory, applyActions, and queue processor. | `frontend/tests/services/mail/...`, `frontend/tests/services/queue/...` |

### Phase 3 — EAS hardening

| # | Task | Files to modify / create |
|---|------|--------------------------|
| 3.1 | Implement `Provision` request/ack and policy-key persistence. | **New** `backend/src/eas/provision.rs`, `backend/src/eas/commands.rs`, `backend/src/db/sync_state.rs` |
| 3.2 | Add automatic Provision retry logic, redirect (HTTP 451) handling, throttling (`Retry-After`), and AutoDiscover-on-failure in `EasClient`. | `backend/src/eas/client.rs` |
| 3.3 | Implement AutoDiscover V1 POX and V2 JSON with redirect handling. | **New** `backend/src/eas/autodiscover.rs`, `backend/src/eas/service.rs` |
| 3.4 | Add OAuth Modern Auth header support and token refresh path. | **New** `backend/src/eas/oauth.rs`, `backend/src/eas/types.rs` |
| 3.5 | Add service-layer orchestration modules: account service, ping service, mail store service, mail folder service. | **New** `backend/src/eas/services/` |
| 3.6 | Add additional EAS command builders/parsers: `MoveItems`, `Settings` (device info/OOF), `Find` (GAL + mailbox), `ValidateCert`, `ResolveRecipients`, `MeetingResponse`. | `backend/src/eas/commands.rs`, `backend/src/eas/types.rs` |
| 3.7 | Add calendar/contact/task ApplicationData parsers and Tauri commands. | `backend/src/eas/commands.rs`, `backend/src/eas/sync.rs` |
| 3.8 | Create `easContactsProvider` and `easTasksProvider`; extend `easCalendarProvider`. | **New** `frontend/src/services/contacts/easContactsProvider.ts`, **New** `frontend/src/services/tasks/easTasksProvider.ts`, `frontend/src/services/calendar/easCalendarProvider.ts` |
| 3.9 | Update account setup UI to use AutoDiscover and OAuth where applicable. | Account setup components (e.g., `frontend/src/components/account/...` to be identified when Phase 3 starts) |
| 3.10 | Add gzip request/response support and `Accept-Encoding: gzip` header. | `backend/src/eas/client.rs` |
| 3.11 | Add optional WBXML→XML debug translator (dev builds only). | **New** `backend/src/eas/wbxml_debug.rs` |
| 3.12 | Add frontend migration for EAS OAuth columns (`auth_type`, `oauth_provider`, `oauth_refresh_token`) if not already present. | `frontend/src/services/db/migrations.ts` |
| 3.13 | Add tests for Provision, AutoDiscover, OAuth, service layer, and non-mail sync parsers. | Backend/frontend test files |

## Verification

1. **Unit tests pass:** `cargo test` in backend, `npx vitest run` in frontend.
2. **Type checks:** `npx tsc --noEmit` in frontend.
3. **Manual smoke test (requires EAS server):**
   - Add an EAS account.
   - Folder pane populates.
   - Sync fetches messages into message list.
   - Mark-read/moves are reflected after a round trip.
   - SendMail works.
4. **Integration tests:** run ignored EAS integration tests with `EAS_TEST_*` env vars.

## Risks & Deferred Items

- **Provision UI:** automatic Provision accepts the server policy silently in this plan; a future iteration may show a policy summary to the user.
- **OAuth scopes:** Microsoft EAS OAuth scopes are not yet validated; the plan leaves room to adjust scopes per tenant.
- **AutoDiscover reliability:** enterprise deployments vary; the implementation will fall back to manual URL entry.
- **Protocol version drift:** we target 16.1 but fall back gracefully to 14.1 if the server rejects 16.1.
- **Attachment streaming:** multipart responses are handled conceptually; very large attachments may need further download streaming work.
- **Device ID stability:** a stable device ID must be generated once per install and persisted; random IDs will break device partnerships on the server.
- **WBXML serializer correctness:** the pending-tag optimization must be verified against reference fixtures to avoid malformed requests.

## Critical Files to Modify or Create

- `kylins.client.backend/src/eas/client.rs`
- `kylins.client.backend/src/eas/commands.rs`
- `kylins.client.backend/src/eas/types.rs`
- `kylins.client.backend/src/eas/status.rs` *(new)*
- `kylins.client.backend/src/eas/service.rs`
- `kylins.client.backend/src/eas/sync.rs` *(new)*
- `kylins.client.backend/src/eas/provision.rs` *(new)*
- `kylins.client.backend/src/eas/autodiscover.rs` *(new)*
- `kylins.client.backend/src/eas/oauth.rs` *(new)*
- `kylins.client.backend/src/eas/wbxml_debug.rs` *(new)*
- `kylins.client.backend/src/eas/services/` *(new)*
- `kylins.client.backend/src/eas/mod.rs`
- `kylins.client.backend/src/db/sync_state.rs`
- `kylins.client.backend/src/db/commands.rs`
- `kylins.client.backend/src/lib.rs`
- `kylins.client.frontend/src/services/mail/provider.ts`
- `kylins.client.frontend/src/services/mail/easProvider.ts`
- `kylins.client.frontend/src/services/mail/imapProvider.ts`
- `kylins.client.frontend/src/services/mail/providerFactory.ts` *(new)*
- `kylins.client.frontend/src/services/composer/send.ts`
- `kylins.client.frontend/src/services/queue/offlineQueue.ts`
- `kylins.client.frontend/src/services/calendar/easCalendarProvider.ts`
- `kylins.client.frontend/src/services/contacts/easContactsProvider.ts` *(new)*
- `kylins.client.frontend/src/services/tasks/easTasksProvider.ts` *(new)*
- `kylins.client.frontend/src/services/db/migrations.ts`
- `kylins.client.frontend/tests/services/mail/easProvider.test.ts`
- `kylins.client.backend/tests/eas_integration.rs`
