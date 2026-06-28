# Plan: Migrate inbox-zero Gmail API / Microsoft Graph Providers into Kylins Client

**Date:** 2026-06-27  
**Status:** Draft — Zen reviewed, mail-only scope  
**Scope:** Add native Gmail API and Microsoft Graph email providers to Kylins Client, adapting proven patterns from inbox-zero to Kylins' Tauri v2 + Rust + React stack.

---

## Context

Kylins Client currently supports IMAP/SMTP and Exchange ActiveSync (EAS). Account setup for "Gmail" and "Outlook" today creates an `imap` provider that talks IMAP/SMTP over OAuth2 (XOAuth2), **not** the providers' native REST APIs. inbox-zero, by contrast, implements a full `EmailProvider` abstraction with native Gmail API (`GmailProvider`) and Microsoft Graph (`OutlookProvider`) providers, including delta sync, retries, batching, label/folder mapping, and AI-rule action dispatch.

This plan ports the **architectural patterns and operational semantics** from inbox-zero into Kylins, not the code verbatim. Kylins is a desktop Tauri app with a Rust backend that is becoming the sole SQLite owner, so the implementation must live primarily in Rust and expose Tauri commands, rather than running as Next.js Server Actions.

---

## Goals

1. Add native **Gmail API** provider (`gmail_api`) to Kylins.
2. Add native **Microsoft Graph** provider (`graph`) to Kylins.
3. Fit both providers into the existing Rust `MailSource` trait / sync-engine cursor model.
4. Reuse the existing composer/MIME pipeline where possible; add Graph structured-JSON send path.
5. Provide provider-agnostic AI/action dispatch so rules can target any account type.
6. Keep the implementation testable and incremental.

## Non-goals

- Replacing IMAP/SMTP or EAS providers.
- Server-side webhook push (desktop apps cannot receive HTTPS webhooks reliably).
- Full inbox-zero AI rule engine migration (only the provider-agnostic action dispatch layer).
- Calendar/contact sync via Graph (out of scope; mail only).

---

## Key Architectural Decisions

| Decision | Choice | Rationale |
|---|---|---|
| **HTTP client** | `reqwest` + `serde` in Rust; no heavy generated SDKs | Keeps binary small, matches existing EAS implementation, avoids `google-gmail1`/`graph-rs` bloat |
| **DB ownership** | Rust backend via `sqlx` (per sync-engine spec) | Single writer, WAL mode, crash-safe transactions |
| **Token refresh** | Shared `TokenManager` in `src/oauth.rs`; in-memory per-account mutex; force refresh on 401 | Single source of truth; prevents concurrent refresh races; hides OAuth from UI |
| **Gmail sync cursor** | Per-folder `gmail_history_id` stored in `folder_sync_state` | Gmail History API is global, but advancing a single global cursor per folder would skip events for folders synced later. Each folder stores the last history ID it processed. |
| **Graph sync cursor** | Per-folder `delta_token` in new `graph_sync_state` | Graph `/messages/delta` is folder-scoped; matches `MailSource` trait naturally |
| **Send path** | Gmail uses base64url raw MIME; Graph uses structured JSON | Reuse existing MIME builder for Gmail; build Graph converter |
| **Real-time** | Polling-only fallback on desktop (default 60s) | Webhooks require public HTTPS endpoint; IDLE is IMAP-only |
| **Rate limits** | Redis-free; per-account SQLite/`settings` rate-limit mode with TTL | Desktop has no Redis; reuse Kylins `settings` store |

---

## Current State to Build On

### Kylins already has

- `MailProvider` interface: `kylins.client.frontend/src/services/mail/provider.ts`
- `ImapProvider` / `EasProvider` wrappers: `kylins.client.frontend/src/services/mail/imapProvider.ts`, `easProvider.ts`
- Rust IMAP/EAS command patterns: `kylins.client.backend/src/mail/imap/client.rs`, `src/eas/`
- OAuth infra: `kylins.client.frontend/src/services/auth/oauth.ts`, backend `src/oauth.rs`
- DB columns for Gmail cursor: `accounts.history_id` (`migrations.ts` v1)
- Provider-agnostic labels table with `source`, `role`, `remote_id` (migration v33)
- Sync-engine spec defining `MailSource` trait and cursor model: `docs/superpowers/specs/2026-06-27-sync-engine-design.md`

### inbox-zero patterns to adapt

- `EmailProvider` interface + provider factory: `apps/web/utils/email/{types,provider}.ts`
- Gmail retry/backoff: `apps/web/utils/gmail/retry.ts`
- Outlook retry/backoff: `apps/web/utils/outlook/retry.ts`
- Gmail batch fetch: `apps/web/utils/gmail/batch-with-retry.ts`
- Outlook batch: `apps/web/utils/outlook/batch.ts`
- Gmail History sync: `apps/web/utils/webhook/google/process-history.ts`
- Graph delta + subscriptions: `apps/web/utils/outlook/watch.ts`, `subscription-manager.ts`
- AI action dispatch: `apps/web/utils/ai/actions.ts`

---

## Phase 1 — Provider Enum, OAuth, and Account Setup

**Goal:** Let users create `gmail_api` and `graph` accounts.

### 1.1 Extend `Account` provider type

**File:** `kylins.client.frontend/src/types/index.ts`

Change:
```typescript
export type MailProvider = 'gmail_api' | 'imap' | 'eas';
// to:
export type MailProvider = 'gmail_api' | 'graph' | 'imap' | 'eas';
```

Add setup provider IDs if needed:
```typescript
export type SetupProviderId = 'gmail' | 'gmail_api' | 'outlook' | 'outlook_graph' | 'microsoft365' | ...;
```

### 1.2 Add native API OAuth scopes

**File:** `kylins.client.frontend/src/services/auth/providers.ts`

Add two new provider configs (or branch existing ones):

| Provider | Scopes |
|---|---|
| `gmail_api` | `https://www.googleapis.com/auth/gmail.modify`, `https://www.googleapis.com/auth/gmail.labels`, `openid`, `email`, `profile`, `offline_access` |
| `graph` | `Mail.ReadWrite`, `Mail.Send`, `User.Read`, `offline_access`, `openid`, `email`, `profile` |

Keep the existing `gmail`/`outlook` IMAP+XOAuth2 configs unchanged so users can still choose IMAP.

### 1.3 Account setup flow changes

**File:** `kylins.client.frontend/src/services/auth/accountSetupFlows.ts`

Add:
- `buildGmailApiAccount(tokens)` → sets `provider: 'gmail_api'`, stores encrypted `access_token`/`refresh_token`, `token_expires_at`, `oauth_provider: 'google'`.
- `buildGraphAccount(tokens)` → sets `provider: 'graph'`, stores encrypted tokens, `oauth_provider: 'microsoft'`.

Verification:
- For IMAP: test IMAP connection.
- For native APIs: call `gmail_test_connection` / `graph_test_connection` Rust commands (lightweight `users.getProfile` / `me/mailFolders`).

### 1.4 DB migrations

**File:** `kylins.client.backend/migrations/20260627000001_gmail_graph_accounts.sql`

```sql
-- provider enum already a string, no change needed

-- Extend the existing folder_sync_state table with Gmail-specific per-folder
-- history ID. The Gmail History API is account-global, but we must not advance
-- a single global cursor for all folders (that would cause folders synced later
-- to miss events). Each folder stores the last history ID it has processed.
ALTER TABLE folder_sync_state ADD COLUMN IF NOT EXISTS gmail_history_id TEXT;

-- Graph: per-folder delta tokens
CREATE TABLE IF NOT EXISTS graph_sync_state (
  account_id TEXT NOT NULL,
  folder_id TEXT NOT NULL,
  delta_token TEXT NOT NULL,
  last_sync_at INTEGER DEFAULT (unixepoch()),
  PRIMARY KEY (account_id, folder_id),
  FOREIGN KEY (account_id) REFERENCES accounts(id) ON DELETE CASCADE
);

-- Rate-limit mode (replaces inbox-zero Redis TTL)
CREATE TABLE IF NOT EXISTS provider_rate_limit (
  account_id TEXT PRIMARY KEY REFERENCES accounts(id) ON DELETE CASCADE,
  retry_after INTEGER NOT NULL,
  updated_at INTEGER DEFAULT (unixepoch())
);

-- Messages already have provider_message_id; add provider_thread_id so Gmail
-- threads can be reconciled without relying solely on local References headers.
ALTER TABLE messages ADD COLUMN IF NOT EXISTS provider_thread_id TEXT;
```

### 1.5 Rust command registration

**File:** `kylins.client.backend/src/main.rs`

Add new command prefixes to `tauri::generate_handler![]`:
- `gmail_test_connection`
- `graph_test_connection`

### 1.6 Shared `TokenManager`

**File:** `kylins.client.backend/src/oauth.rs`

Introduce a `TokenManager` that both `GmailApiClient` and `GraphClient` use:

- In-memory `HashMap<account_id, Mutex<TokenState>>`.
- `TokenState` holds decrypted `access_token`, encrypted `refresh_token` blob, `expires_at`.
- `async fn get_token(pool, account_id) -> Result<String>`:
  1. Return cached token if still valid (with a small clock skew buffer, e.g., 60s).
  2. Acquire per-account mutex; re-check after lock.
  3. Decrypt refresh token, POST to provider token endpoint, encrypt and persist new tokens, update cache, return new access token.
  4. On any API `401`, invalidate cached token and force one retry refresh.

### 1.7 Generic retry middleware

**File:** `kylins.client.backend/src/sync/retry.rs` (new)

Instead of separate `with_gmail_retry` / `with_graph_retry`, build a provider-agnostic retry layer:

- `ErrorClass`: `Transient`, `Permanent`, `AuthExpired`.
- `RetryPolicy`: max total time (e.g., 5 minutes), base delay, cap, whether to respect `Retry-After`.
- For `AuthExpired`, force token refresh and retry once.
- For `429` with `Retry-After`, insert into `provider_rate_limit` and sleep exactly that long (up to policy cap).
- Gmail/Graph clients configure their own policies but share the same loop.

---

## Phase 2 — Gmail API Read-Only Sync

**Goal:** Fetch Gmail labels, messages, threads, and keep them in sync via History API.

### 2.1 Rust Gmail API client

**New files:**
- `kylins.client.backend/src/mail/gmail/mod.rs`
- `kylins.client.backend/src/mail/gmail/types.rs` — DTOs for `Message`, `Thread`, `Label`, `History`, `HistoryResponse`, etc.
- `kylins.client.backend/src/mail/gmail/client.rs` — `GmailApiClient`
- `kylins.client.backend/src/mail/gmail/retry.rs` — `with_gmail_retry`
- `kylins.client.backend/src/mail/gmail/commands.rs` — Tauri command wrappers

`GmailApiClient` responsibilities:
- Hold `reqwest::Client`, account ID, and a reference to the shared `TokenManager`.
- Resolve access tokens via `token_manager::get_token` before each call; force refresh on 401.
- Apply the generic retry middleware with a Gmail-specific policy (respect `Retry-After`, cap total retry time at 5 minutes).
- On `429`, write `retry_after` into `provider_rate_limit` via the sync engine's rate-limit helper.
- Provide helper methods for pagination and batch fetches.

### 2.2 Tauri commands (read)

| Command | Maps to |
|---|---|
| `gmail_test_connection` | `GET /gmail/v1/users/me/profile` |
| `gmail_list_labels` | `GET /gmail/v1/users/me/labels` |
| `gmail_list_history` | `GET /gmail/v1/users/me/history?startHistoryId={id}` |
| `gmail_get_message` | `GET /gmail/v1/users/me/messages/{id}?format=full` |
| `gmail_get_thread` | `GET /gmail/v1/users/me/threads/{id}?format=full` |
| `gmail_batch_get_messages` | `GET /gmail/v1/users/me/messages/batchGet?ids=...` or custom batch |

### 2.3 Implement `GmailApiSource` as `MailSource`

**File:** `kylins.client.backend/src/mail/gmail/sync.rs`

- `capabilities()`: no `idle`, no `condstore`, no `ping` → polling only.
- `list_folders()` → `gmail_list_labels`, map system labels (`INBOX`, `SENT`, `DRAFTS`, etc.) to `MailFolder` with `role`.
- `sync_folder(folder, since)`:
  - Read `folder_sync_state.gmail_history_id` for this folder (initial bootstrap uses the latest `history.list` without `startHistoryId`).
  - Call `history.list?startHistoryId={id}` to get global changes since that folder's last processed ID.
  - Filter changes to messages bearing this folder's label.
  - Fetch new/changed messages via `batchGet`.
  - Return `FolderDelta` with added/updated/vanished messages.
  - Persist the **folder's own** `gmail_history_id` atomically alongside the delta commit so other folders are not advanced prematurely.
- `fetch_body()` → `gmail_get_message` and extract `payload.parts`.
- Mutations (`set_flags`, `move_messages`, etc.) → Phase 3.

### 2.4 Frontend `GmailApiProvider`

**New file:** `kylins.client.frontend/src/services/mail/gmailApiProvider.ts`

Implements `MailProvider` plus methods like `listFolders`, `getMessage`, etc. Maps `Account` to OAuth token references and invokes `gmail_*` commands.

### 2.5 Tests

- Rust: `gmail/client.rs` unit tests with `wiremock` / `mockito` for retry and JSON parsing.
- Frontend: `tests/services/mail/gmailApiProvider.test.ts` mocking `invoke`.

---

## Phase 3 — Gmail API Mutations (Send / Draft / Flags / Labels)

**Goal:** Send mail and perform actions via Gmail API.

### 3.1 Rust commands

| Command | Maps to |
|---|---|
| `gmail_send_raw` | `POST /gmail/v1/users/me/messages/send` with base64url raw MIME |
| `gmail_create_draft` | `POST /gmail/v1/users/me/drafts` |
| `gmail_update_draft` | `PUT /gmail/v1/users/me/drafts/{id}` |
| `gmail_send_draft` | `POST /gmail/v1/users/me/drafts/{id}/send` |
| `gmail_modify_labels` | `POST /gmail/v1/users/me/messages/{id}/modify` |
| `gmail_trash_message` | `POST /gmail/v1/users/me/messages/{id}/trash` |

### 3.2 Composer send branching

**File:** `kylins.client.frontend/src/services/composer/send.ts` (or create it)

Current SMTP/EAS send uses raw MIME. Add branch:
- `provider === 'gmail_api'` → build MIME, base64url encode, call `gmail_send_raw`.
- `provider === 'imap'` → SMTP raw.
- `provider === 'eas'` → `eas_send_mail`.

### 3.3 Flag/label mapping

- Gmail labels are strings (`INBOX`, `UNREAD`, `STARRED`, `SPAM`, `SENT`, `DRAFT`, user labels).
- Kylins unified `labels` table stores them with `source: 'gmail_api'`, `remote_id: labelId`.
- `set_flags()` in `GmailApiSource` translates to `gmail_modify_labels`.

---

## Phase 4 — Microsoft Graph Read-Only Sync

**Goal:** Fetch Outlook folders, messages, and keep them in sync via Graph delta queries.

### 4.1 Rust Graph client

**New files:**
- `kylins.client.backend/src/mail/graph/mod.rs`
- `kylins.client.backend/src/mail/graph/types.rs` — DTOs for `Message`, `MailFolder`, `DeltaResponse`, etc.
- `kylins.client.backend/src/mail/graph/client.rs` — `GraphClient`
- `kylins.client.backend/src/mail/graph/retry.rs` — `with_graph_retry`
- `kylins.client.backend/src/mail/graph/commands.rs` — Tauri command wrappers

`GraphClient` responsibilities:
- `reqwest` client with `Prefer: IdType="ImmutableId"` header.
- Resolve access tokens via the shared `TokenManager`; force refresh on 401.
- Apply the generic retry middleware with a Graph-specific policy (429 fixed 30s unless `Retry-After` is present, 5xx exponential, 412 conflict exponential, total cap 5 minutes).
- `@odata.nextLink` pagination with host allowlist (Graph national clouds).
- On `429`, write `retry_after` into `provider_rate_limit`.

### 4.2 Tauri commands (read)

| Command | Maps to |
|---|---|
| `graph_test_connection` | `GET /me/mailFolders` |
| `graph_list_mail_folders` | `GET /me/mailFolders` (recursive tree to 6 levels) |
| `graph_list_messages_delta` | `GET /me/mailFolders/{id}/messages/delta` or `?deltaToken=` |
| `graph_get_message` | `GET /me/messages/{id}` |
| `graph_get_message_body` | `GET /me/messages/{id}?$select=body` |

### 4.3 Implement `GraphSource` as `MailSource`

**File:** `kylins.client.backend/src/mail/graph/sync.rs`

- `capabilities()`: no `idle`, no `ping` → polling only.
- `list_folders()` → `graph_list_mail_folders`, map well-known folders (`inbox`, `sentitems`, `drafts`, `archive`, `deleteditems`, `junkemail`) to `role`.
- `sync_folder(folder, since)`:
  - Read `delta_token` from `graph_sync_state`.
  - Call `/me/mailFolders/{folder.remote_id}/messages/delta` with `deltaToken`.
  - Paginate `@odata.nextLink` and `@odata.deltaLink`.
  - Return `FolderDelta`; persist new `delta_token` atomically with the data commit so a crash cannot duplicate messages.
- `fetch_body()` → `graph_get_message_body`.

### 4.4 Frontend `GraphProvider`

**New file:** `kylins.client.frontend/src/services/mail/graphProvider.ts`

Wraps `graph_*` commands.

### 4.5 Tests

- Rust: mock Graph API responses for delta pagination and retry.
- Frontend: mock `invoke` provider tests.

---

## Phase 5 — Microsoft Graph Mutations (Send / Draft / Flags / Move)

**Goal:** Send mail and perform actions via Graph API.

### 5.1 Rust commands

| Command | Maps to |
|---|---|
| `graph_send_mail` | `POST /me/sendMail` with structured JSON payload |
| `graph_create_draft` | `POST /me/messages` |
| `graph_update_draft` | `PATCH /me/messages/{id}` |
| `graph_send_draft` | `POST /me/messages/{id}/send` |
| `graph_create_reply` | `POST /me/messages/{id}/createReply` |
| `graph_create_forward` | `POST /me/messages/{id}/createForward` |
| `graph_mark_read` | `PATCH /me/messages/{id}` `{ isRead: true }` |
| `graph_move_message` | `POST /me/messages/{id}/move` |
| `graph_flag_message` | `PATCH /me/messages/{id}` `{ flag: { flagStatus: "flagged" } }` |

### 5.2 Composer Graph converter

**New file:** `kylins.client.backend/src/mail/graph/message_builder.rs`

Convert Kylins composer fields (to, cc, bcc, subject, bodyHtml, bodyText, attachments, inReplyTo, references) into Graph `Message` JSON.

For replies/forwards, prefer Graph `createReply`/`createForward` endpoints to preserve threading headers, then PATCH content and recipients, then send.

### 5.3 Label/folder mapping

- Graph uses **categories** (like labels) and **mailFolders** (like folders).
- Kylins stores both in `labels` table with `source: 'graph'` and appropriate `role`.
- `set_flags()` → PATCH `isRead` / flag.
- `move_messages()` → POST `/move` to target folder.
- `labelMessage()` → PATCH `categories` array.

### 5.4 Threading, labels, and folders

Gmail and Graph expose different message/grouping semantics that must be reconciled with Kylins' folder-centric UI:

- **Gmail threads:** store the provider's `threadId` in `messages.provider_thread_id`. Continue to compute a local `thread_id` from `Message-Id`/`References`/`In-Reply-To` for uniform behavior across providers. Use `provider_thread_id` only when re-fetching a full Gmail thread via `threads.get`.
- **Gmail labels vs. folders:** A Gmail message can have multiple labels. Treat labels as tags in the `labels` table, but derive a `primary_folder_id` for the message so the folder tree has a single home (e.g., prefer `INBOX`, then `SENT`, then user labels). Messages appear in every label they carry.
- **Graph categories vs. mailFolders:** Graph categories behave like tags; mailFolders behave like folders. Store both in `labels` with distinct roles, and compute `primary_folder_id` from the mailFolder.

---

## Phase 6 — Unified Action Dispatch + AI Integration

**Goal:** Provider-agnostic actions so AI rules work across IMAP/EAS/Gmail/Graph.

### 6.1 Define `MailAction` enum in Rust

**File:** `kylins.client.backend/src/mail/actions.rs`

```rust
pub enum MailAction {
    MarkRead { message_ids: Vec<String>, read: bool },
    Star { message_ids: Vec<String>, starred: bool },
    Archive { thread_ids: Vec<String> },
    Trash { thread_ids: Vec<String> },
    Label { message_ids: Vec<String>, label_id: String, add: bool },
    Move { thread_ids: Vec<String>, folder_id: String },
    SendRaw { raw: String },
    Draft { ... },
}
```

### 6.2 Implement `apply_action` on `MailSource`

Add to `MailSource` trait:
```rust
async fn apply_action(&self, action: MailAction) -> Result<()>;
```

Each source implements its own mapping:
- `ImapSource`: IMAP STORE / MOVE / APPEND.
- `EasSource`: EAS Sync commands.
- `GmailApiSource`: `gmail_modify_labels`, `gmail_trash_message`, etc.
- `GraphSource`: PATCH / move / flag.

### 6.3 Frontend action dispatcher

**New file:** `kylins.client.frontend/src/services/mail/actions.ts`

Mirror inbox-zero `utils/ai/actions.ts` but adapted to desktop:
- Accept `Account`, `action`, and `resourceIds`.
- Resolve provider instance via factory.
- Call Rust `sync_enqueue_op` with a `MailAction` payload (so the sync engine can optimistic-apply + remote-syncback).

### 6.4 AI rule integration

When AI providers are implemented, the rule executor can call the dispatcher without knowing the account type.

---

## Phase 7 — Real-Time, Rate Limits, and Watch

### 7.1 Real-time on desktop

- **No webhooks.** Desktop cannot receive Pub/Sub or Graph change notifications without a public HTTPS endpoint.
- **Polling fallback:** Sync engine already schedules per-account polling (default 60s). For Gmail/Graph this is sufficient.
- **Future enhancement:** Use IMAP IDLE for Gmail API accounts that also have IMAP enabled, but this reintroduces protocol duality and is not recommended.

### 7.2 Rate-limit mode

- On `429`, upsert `(account_id, retry_after = now + Retry-After seconds)` into `provider_rate_limit`.
- Before scheduling any sync round for an account, query `provider_rate_limit`. If `retry_after > now()`, skip the account entirely and emit `sync:status` → `"rate_limited"`. Do not treat this as a normal failure/cooldown.
- The row is deleted lazily on the next scheduling attempt after the window passes.
- Expose `db_get_rate_limit_info(account_id)` so the status bar can show "Rate limited — retrying at X".
- Rate-limit state overrides the sync engine's generic circuit-breaker cooldown while it is active.

### 7.3 Subscriptions lifecycle (deferred)

If Kylins later adds a cloud relay or uses Tauri's deep-link with a hosted service, revisit Graph subscriptions and Gmail Pub/Sub. For now, polling only.

---

## Critical Files to Create / Modify

### Rust backend

| Path | Purpose |
|---|---|
| `kylins.client.backend/src/mail/gmail/mod.rs` | Module root |
| `kylins.client.backend/src/mail/gmail/types.rs` | Gmail API DTOs |
| `kylins.client.backend/src/mail/gmail/client.rs` | HTTP client + auth + retry |
| `kylins.client.backend/src/mail/gmail/retry.rs` | `with_gmail_retry` |
| `kylins.client.backend/src/mail/gmail/sync.rs` | `GmailApiSource` |
| `kylins.client.backend/src/mail/gmail/commands.rs` | Tauri command wrappers |
| `kylins.client.backend/src/mail/graph/mod.rs` | Module root |
| `kylins.client.backend/src/mail/graph/types.rs` | Graph DTOs |
| `kylins.client.backend/src/mail/graph/client.rs` | HTTP client + auth + retry |
| `kylins.client.backend/src/mail/graph/retry.rs` | `with_graph_retry` |
| `kylins.client.backend/src/mail/graph/sync.rs` | `GraphSource` |
| `kylins.client.backend/src/mail/graph/commands.rs` | Tauri command wrappers |
| `kylins.client.backend/src/mail/graph/message_builder.rs` | Composer → Graph JSON |
| `kylins.client.backend/src/mail/actions.rs` | Unified `MailAction` enum |
| `kylins.client.backend/src/sync/retry.rs` | Generic retry middleware |
| `kylins.client.backend/src/oauth.rs` | Shared `TokenManager` + auto-refresh |
| `kylins.client.backend/src/main.rs` | Register new commands |
| `kylins.client.backend/migrations/20260627000001_gmail_graph_accounts.sql` | Schema additions |

### Frontend

| Path | Purpose |
|---|---|
| `kylins.client.frontend/src/types/index.ts` | Add `'graph'` to `MailProvider` |
| `kylins.client.frontend/src/services/auth/providers.ts` | Native API OAuth scopes |
| `kylins.client.frontend/src/services/auth/accountSetupFlows.ts` | Build `gmail_api`/`graph` accounts |
| `kylins.client.frontend/src/services/mail/gmailApiProvider.ts` | `GmailApiProvider` wrapper |
| `kylins.client.frontend/src/services/mail/graphProvider.ts` | `GraphProvider` wrapper |
| `kylins.client.frontend/src/services/mail/providerFactory.ts` | New: resolve provider by `account.provider` |
| `kylins.client.frontend/src/services/mail/actions.ts` | New: provider-agnostic action dispatcher |
| `kylins.client.frontend/src/services/composer/send.ts` | Branch send by provider |

---

## Risks and Mitigations

| Risk | Mitigation |
|---|---|
| Gmail API global history makes per-folder `sync_folder` awkward | Store per-folder `gmail_history_id` in `folder_sync_state` and update only the folder being synced. |
| Graph send uses JSON, not MIME; composer pipeline assumes raw MIME | Build a Graph message builder; keep MIME path for IMAP/EAS/Gmail. |
| OAuth token refresh races across concurrent sync + send | Use the shared `TokenManager` with per-account mutex; force refresh on 401. |
| Graph national cloud endpoints / nextLink SSRF | Host allowlist in `resolveMicrosoftGraphNextLink`; make allowlist configurable at runtime. |
| Rate-limit mode without Redis | Use SQLite `provider_rate_limit` table with TTL; integrate into sync scheduler. |
| Large attachment upload (>3MB) on Graph | Implement upload session chunked PUT (Phase 5 follow-up). |
| Webhooks unavailable on desktop | Accept polling-only; document limitation. |
| Threading reconciliation across providers | Store `provider_thread_id` but keep local thread grouping uniform. |
| Label vs. folder semantics (Gmail multi-label) | Derive `primary_folder_id` for the folder tree; store all labels as tags. |
| Crash between data write and cursor update | Apply new messages/bodies and cursor updates in a single SQL transaction. |

---

## Verification Steps

### Unit tests

- Rust token manager concurrency: spawn multiple callers; assert only one refresh HTTP call.
- Rust generic retry: mock 429/5xx/401 responses, assert `Retry-After` is honored, rate-limit table is written, and 401 triggers a single forced refresh.
- Rust JSON parsing: parse Gmail/Graph fixtures into internal `RemoteMessage` types.
- Rust per-folder Gmail history: mock history with events for multiple labels; sync folder A then folder B and verify no events are skipped.
- Rust cursor persistence: verify `gmail_history_id` and `delta_token` are monotonic and atomically committed with data writes.
- Rust rate-limit lifecycle: 429 inserts row, scheduler skips account, resumes after window, row deleted.
- Frontend provider wrappers: mock `invoke`, verify command payloads.

### Integration tests

- Rust: `tests/gmail_graph_integration.rs` with real test accounts (optional, behind feature flag).
- Frontend: account setup flow tests for `gmail_api` and `graph`.

### Manual scenarios

1. Add a Gmail API account; verify labels load; send a test email; verify it appears in Sent via history sync.
2. Add a Microsoft Graph account; verify folder tree loads; archive a message; verify delta sync picks up the change.
3. Toggle a message read/starred on both provider types; verify UI optimistic update and subsequent `sync:delta` event.
4. Disconnect network, perform actions, reconnect; verify offline queue replay.

---

## Suggested Rollout Order

1. **Complete or verify sync-engine Phase 0** — `MailSource` trait, `SyncEngine`, polling loop, and atomic folder/cursor persistence must exist before adapters are meaningful.
2. **Phase 1 concurrently** — provider enum, OAuth scopes, account setup UI, and shared `TokenManager` can land in parallel with sync-engine work because they only need DB schema and account records.
3. **Ship Gmail API read-only sync** — per-folder `gmail_history_id` in `folder_sync_state`, lower risk.
4. **Add Gmail API send/flags** — closes the loop for Gmail users.
5. **Ship Microsoft Graph read-only sync** — new `graph_sync_state` table, per-folder delta is natural.
6. **Add Graph send/flags/move** — structured send path is the main new work.
7. **Unify action dispatch + AI integration** — once both providers exist.

---

## Open Questions for the User

1. Should the existing "Gmail" and "Outlook" setup options remain as IMAP+XOAuth2, or be replaced by the native API providers?  
   **Recommendation:** Keep both; add "Gmail (IMAP)" / "Gmail (API)" and "Outlook (IMAP)" / "Outlook (Graph)" choices.

2. Which provider should be implemented first — Gmail API or Microsoft Graph?  
   **Recommendation:** Gmail API, because `accounts.history_id` already exists and the sync model is simpler.

3. Is offline-queue replay for Gmail/Graph required in the first phase, or can mutations execute synchronously and only fall back to the queue on failure?  
   **Recommendation:** Use the existing `sync_enqueue_op` path from the sync-engine spec; it handles optimistic apply + remote syncback uniformly.

4. Should AI rule actions be part of this work, or should we only lay the provider-agnostic action dispatcher foundation?  
   **Recommendation:** Foundation only in this plan; AI rule engine is a separate body of work.

5. How should Kylins reconcile Gmail's multi-label model with the folder tree?  
   **Recommendation:** Derive a `primary_folder_id` for each message (INBOX > SENT > user label) so the folder tree has one home, while still showing the message under every label it carries.
