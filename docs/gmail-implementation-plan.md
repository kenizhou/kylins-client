# Gmail API Implementation Plan for Kylins

> Derived from a source-learning study of Velo (`D:\Projects\mailclient\opensource\velo`).
> Velo does **not** use `googleapis` or any Gmail SDK; it talks directly to the Gmail REST API via raw `fetch`.

---

## 1. Goal

Enable Gmail (`provider = "gmail_api"`) as a first-class mail source in Kylins, alongside the existing IMAP and EAS sources. The UI should treat Gmail identically to other providers: folder pane, message list, reading pane, composer send, and offline mutations all work through the existing Rust sync engine.

---

## 2. What Velo Does (Reference Pattern)

### 2.1 No Google SDK

- Endpoints: `https://www.googleapis.com/gmail/v1/users/me/...`
- Auth endpoints: `https://accounts.google.com/o/oauth2/v2/auth`, `https://oauth2.googleapis.com/token`
- Scopes:
  - `gmail.readonly`
  - `gmail.modify`
  - `gmail.send`
  - `gmail.labels`
  - `userinfo.email`
  - `userinfo.profile`
  - (Velo also requests calendar scopes; Kylins can add those later)

### 2.2 Architecture in Velo

| Concern | File |
|---|---|
| OAuth2 + PKCE flow | `src/services/gmail/auth.ts` |
| Raw REST client | `src/services/gmail/client.ts` |
| Token lifecycle / settings | `src/services/gmail/tokenManager.ts` |
| Generic provider interface | `src/services/email/types.ts` |
| Provider factory | `src/services/email/providerFactory.ts` |
| Gmail adapter | `src/services/email/gmailProvider.ts` |
| Initial + delta sync | `src/services/gmail/sync.ts` |
| Background sync timer | `src/services/gmail/syncManager.ts` |
| Message parsing | `src/services/gmail/messageParser.ts` |
| Rust localhost callback server | `src-tauri/src/oauth.rs` |

### 2.3 Sync Strategy

- **Initial sync**: list threads with `after:<date>`, fetch each thread `format=full`, parse messages, store in SQLite, persist highest `historyId` in `accounts.history_id`.
- **Delta sync**: call `GET /history?startHistoryId=...`. Process `messagesAdded`, `messagesDeleted`, `labelsAdded`, `labelsRemoved`. Re-fetch affected threads. If history expired (404 / `HISTORY_EXPIRED`), fall back to initial sync.
- **Polling only**: Velo does **not** implement Gmail push notifications. Sync runs every 60 seconds.

### 2.4 Sending & Mutations

- Send: build RFC 2822 MIME, base64url encode, `POST /messages/send`. Gmail auto-saves a Sent copy.
- Read/star/trash/spam/label: `POST /threads/{id}/modify` with `addLabelIds` / `removeLabelIds`.
- Move: also via label modification (`INBOX` ↔ `TRASH` ↔ `SPAM` ↔ label list).

---

## 3. Current Kylins State

### 3.1 Already Aligned with Velo

- Rust backend owns SQLite, migrations, and AES-GCM encryption.
- `oauth.rs` already has the localhost callback server + generic token exchange/refresh commands.
- Frontend `types/index.ts` already declares `MailProvider = 'gmail_api' | 'imap' | 'eas'` and the `Account` type has `historyId`, `accessToken`, `refreshToken`, `oauthClientId`, `oauthClientSecret`.
- `sync_engine/mod.rs` defines a generic `MailSource` trait and a factory.
- `ImapSource` and `EasSource` are complete reference implementations.
- Sync engine has poll loop, replay queue, rate-limit short-circuit, circuit breaker, and event emission.

### 3.2 Missing Pieces

1. No `GmailApiSource` implementing `MailSource`.
2. No Gmail REST client.
3. No frontend Gmail OAuth flow.
4. `Cursor` enum only has `Imap` and `Eas` variants.
5. No Gmail label → `RemoteFolder` mapping.
6. No Gmail message JSON → `RemoteMessage` mapping.
7. No Gmail send/mutation methods.
8. `source_for_account` rejects `"gmail_api"`.

---

## 4. Implementation Plan

### Phase 0 — Foundation (must happen first)

#### 0.1 Add a `gmail` module in the Rust backend

Create:

```
kylins.client.backend/src/gmail/mod.rs
kylins.client.backend/src/gmail/client.rs
kylins.client.backend/src/gmail/parser.rs   // optional, can live in source adapter
```

Expose the module in `lib.rs`:

```rust
pub mod gmail;
```

#### 0.2 Decide on HTTP client

Kylins already pulls in `reqwest` (used in `oauth.rs`). Use `reqwest` for the Gmail client instead of hand-rolling `fetch` from the frontend. This keeps network logic in Rust where the sync engine lives.

### Phase 1 — Gmail REST Client

#### 1.1 Core client structure

Build `GmailClient` in `gmail/client.rs`:

```rust
pub struct GmailClient {
    account_id: String,
    access_token: String,
    refresh_token: Option<String>,
    token_expires_at: Option<i64>,
    client_id: String,
    client_secret: Option<String>,
    pool: SqlitePool,
}
```

Responsibilities:

- `request<T>(method, path, body)` — authenticated request with `Authorization: Bearer {token}`.
- Automatic token refresh when expiry is within 5 minutes.
- Mutex-protected refresh (single `refreshPromise` pattern, like Velo).
- Persist refreshed `access_token` and `token_expires_at` to the `accounts` table via `db::accounts::update`.
- 429 / 503 handling with `Retry-After` → `SourceError::RateLimited`.

#### 1.2 Required endpoints

Wrap these Gmail endpoints:

| Operation | Endpoint |
|---|---|
| Get profile | `GET /users/me/profile` |
| List labels | `GET /users/me/labels` |
| List threads | `GET /users/me/threads` |
| Get thread | `GET /users/me/threads/{id}?format=full` |
| Get message | `GET /users/me/messages/{id}?format=full` |
| Get history | `GET /users/me/history?startHistoryId=...` |
| Get attachment | `GET /users/me/messages/{msgId}/attachments/{id}` |
| Send message | `POST /users/me/messages/send` |
| Modify thread | `POST /users/me/threads/{id}/modify` |
| Modify message | `POST /users/me/messages/{id}/modify` |
| Trash / untrash message | `POST /users/me/messages/{id}/trash` / `/untrash` |
| Delete message | `DELETE /users/me/messages/{id}` |
| Create/update/delete label | `POST/PUT/DELETE /users/me/labels` |

#### 1.3 Token refresh command

`oauth.rs` already has `oauth_refresh_token`. The client should call that Tauri command (or the underlying logic) when refreshing.

Because the client runs inside the Rust backend, it can call a private helper directly rather than going through the Tauri IPC layer.

### Phase 2 — Extend Sync Engine for Gmail

#### 2.1 Add a `Gmail` cursor variant

In `sync_engine/mod.rs`:

```rust
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(tag = "kind", rename_all = "lowercase")]
pub enum Cursor {
    Imap { ... },
    Eas { ... },
    Gmail {
        history_id: String,
        label_id: String,
    },
}
```

Add helper:

```rust
impl Cursor {
    pub fn initial_gmail(label_id: &str) -> Self {
        Cursor::Gmail {
            history_id: String::new(),
            label_id: label_id.to_string(),
        }
    }
}
```

> Gmail history is account-level, but `sync_folder` is per-folder. Store `history_id` per label so each folder can resume independently, or keep one account-level history and ignore the per-folder cursor. Recommended: account-level history id stored in `accounts.history_id`, and the `Gmail` cursor simply carries the label id; the adapter reads `account.history_id`.

#### 2.2 Persist Gmail cursor / history id

Option A (recommended): reuse the existing `accounts.history_id` column. The adapter reads/writes it directly. No new sync_state table needed.

Option B: add a `gmail_sync_state` table mirroring `eas_sync_state`. More complex but consistent with the source-owned cursor pattern.

**Decision needed in Plan Mode.**

#### 2.3 Create `GmailApiSource`

File: `sync_engine/gmail_source.rs`

```rust
pub struct GmailApiSource {
    account: Account,
    client: GmailClient,
}
```

Implement `MailSource`:

- `capabilities()`:
  ```rust
  Capabilities {
      saves_sent_automatically: true,
      ..Capabilities::default()
  }
  ```
- `list_folders()` → fetch labels, map system labels (`INBOX`, `SENT`, `DRAFT`, `TRASH`, `SPAM`, `STARRED`, `UNREAD`, `IMPORTANT`) and user labels to `RemoteFolder`.
- `sync_folder(folder, cursor)`:
  - If `history_id` is empty → initial sync: list threads for this label, fetch each thread full, map to `RemoteMessage`s.
  - Else → delta sync: `GET /history`, collect affected thread ids, re-fetch them.
  - Return `FolderDelta` with `next_cursor: Cursor::Gmail { history_id: new_history_id, label_id: folder.remote_id.clone() }`.
- `fetch_body(folder, uid)` → `GET /messages/{id}?format=full`, return HTML or text body.
- `set_flags(folder, uids, flag, add)` → map to label modification (`UNREAD` / `STARRED`).
- `move_messages(src, uids, dest)` → modify labels (remove source label, add destination label). Special-case `TRASH`, `SPAM`, `INBOX`.
- `delete_messages(folder, uids)` → `DELETE /messages/{id}` or trash via label.
- `append(folder, raw, flags)` → optionally unsupported initially (Gmail doesn't need client-side Sent append because `saves_sent_automatically = true`).
- `send(raw_mime)` → base64url encode, `POST /messages/send`.

#### 2.4 Map Gmail data to source-agnostic types

**Labels → `RemoteFolder`**:

| Gmail label id | `role` |
|---|---|
| `INBOX` | `inbox` |
| `SENT` | `sent` |
| `DRAFT` | `drafts` |
| `TRASH` | `trash` |
| `SPAM` | `junk` |
| `CATEGORY_PERSONAL`, `CATEGORY_UPDATES`, etc. | `None` or custom |
| User labels | `None` |

`remote_id` = Gmail label id (e.g. `"Label_1"`).

**Thread / message → `RemoteMessage`**:

Gmail has no numeric UID, so generate one from the message id (stable hash) or use the Gmail message id string directly. The `RemoteMessage.uid` field is `u32`, so a hash is required.

Map:
- `message_id` → `payload.headers["Message-Id"]`
- `from_address`, `from_name` → parse `From`
- `to_addresses`, `cc_addresses`, `bcc_addresses` → parse `To`, `Cc`, `Bcc`
- `subject` → `Subject`
- `date` → parse `Date` header to epoch seconds
- `is_read` → `!labelIds.contains("UNREAD")`
- `is_starred` → `labelIds.contains("STARRED")`
- `is_draft` → `labelIds.contains("DRAFT")`
- `body_html` / `body_text` → from `payload.parts[]` mimeType `text/html` / `text/plain`
- `snippet` → `snippet` field
- `has_attachments` → `payload.parts[]` has `mimeType != text/*` with `body.attachmentId`
- `auth_results` → parse `Authentication-Results` header

Consider reusing `mail::address` parser if available.

### Phase 3 — Frontend OAuth Flow

#### 3.1 Create `services/gmail/auth.ts`

Port/adapt Velo's `auth.ts`:

- `buildAuthUrl(clientId, redirectUri, state, codeChallenge)`
- `startOAuthFlow(clientId, clientSecret)`:
  1. Generate PKCE verifier/challenge.
  2. Generate state.
  3. Invoke `start_oauth_server` Rust command (port can be fixed, e.g. `17248`, with fallbacks).
  4. Open browser via Tauri `opener` plugin.
  5. Exchange code for tokens via Rust `oauth_exchange_token` command (avoids CORS).
  6. Fetch user info from `https://www.googleapis.com/oauth2/v2/userinfo`.
  7. Return `{ tokens, userInfo }`.

#### 3.2 Add account creation flow

In the Add Account UI:

- Detect provider `gmail_api`.
- Read `oauthClientId` / `oauthClientSecret` from settings (or env/embedded values).
- Call `startOAuthFlow(...)`.
- Create account via `db_create_account` with:
  - `provider: "gmail_api"`
  - `email: userInfo.email`
  - `displayName: userInfo.name`
  - `avatarUrl: userInfo.picture`
  - `accessToken`, `refreshToken`, `tokenExpiresAt`
  - `oauthProvider: "google"`

> Kylins stores secrets encrypted in Rust, so pass plaintext tokens to `db_create_account`; the backend will encrypt them.

#### 3.3 Store Google client credentials

Add settings keys:

- `gmail_client_id`
- `gmail_client_secret` (optional; Google allows public clients without secret)

Or embed them in the app config. Decision needed.

### Phase 4 — Wire the Factory

In `sync_engine/mod.rs`:

```rust
"gmail_api" => Arc::new(gmail_source::GmailApiSource::new(acc, pool.clone())),
```

Add module declarations:

```rust
pub mod gmail_source;
```

### Phase 5 — Mutations & Offline Queue

The replay queue in `engine.rs` already calls `MailSource` trait methods. Ensure `GmailApiSource` implements:

- `set_flags` for read/star.
- `move_messages` for archive/trash/spam/label moves.
- `delete_messages` for permanent delete.
- `send` for composer sends.

No changes needed in `engine.rs` if the trait is implemented correctly.

### Phase 6 — Testing

#### 6.1 Unit tests

- Gmail client request signing and token-refresh mutex.
- Label → `RemoteFolder` mapping.
- Message JSON → `RemoteMessage` mapping.
- `GmailApiSource::capabilities()`.
- `source_for_account` factory returns Gmail source.

#### 6.2 Engine tests

- Add a `MockGmailClient` or use `mockall` so `GmailApiSource` can be tested through `run_sync_round_with_source` without real network.
- Verify initial sync persists messages.
- Verify delta sync emits `sync:delta` events.
- Verify send path returns success and skips Sent append (`saves_sent_automatically = true`).

#### 6.3 Manual / integration test

- Register a Google OAuth app (or use existing Kylins client id).
- Add a Gmail account in the app.
- Verify folder list, message list, reading pane, send, mark read, trash.

### Phase 7 — Polish

- Add CSP entries for `https://www.googleapis.com` and `https://oauth2.googleapis.com` in `tauri.conf.json` if not already covered.
- Add Gmail-specific rate-limit handling (429 with `Retry-After`).
- Add logging (`log::info!` / `log::warn!`) matching IMAP/EAS style.
- Handle `HISTORY_EXPIRED` fallback cleanly.
- Add user-facing error messages for auth revocation.

---

## 5. Open Decisions

Before implementation starts, decide:

1. **Gmail history id persistence**: account-level `accounts.history_id` column, or new `gmail_sync_state` table?
2. **Gmail client credentials**: embedded in app, stored in settings, or fetched from backend config?
3. **UID generation for Gmail messages**: stable hash of Gmail message id, or sequential counter with a mapping table?
4. **Thread vs message model**: Kylins DB has threads/messages; should Gmail sync fetch threads and split into messages, or fetch messages directly? (Velo is thread-centric.)
5. **Base64 decoding**: decode base64url bodies in Rust or pass raw to frontend? Rust is preferred.
6. **Attachment strategy**: fetch on demand via `GET /messages/{id}/attachments/{id}` and cache in `attachment_cache`, similar to IMAP/EAS.

---

## 6. File Checklist

### New files

- `kylins.client.backend/src/gmail/mod.rs`
- `kylins.client.backend/src/gmail/client.rs`
- `kylins.client.backend/src/gmail/types.rs` (optional)
- `kylins.client.backend/src/sync_engine/gmail_source.rs`
- `kylins.client.frontend/src/services/gmail/auth.ts`
- `kylins.client.frontend/src/services/gmail/tokenManager.ts` (optional)

### Modified files

- `kylins.client.backend/src/lib.rs` — add `pub mod gmail;`
- `kylins.client.backend/src/sync_engine/mod.rs` — add `Gmail` cursor variant and factory branch
- `kylins.client.backend/src/db/sync_state.rs` — add Gmail cursor persistence (if Option A not chosen)
- `kylins.client.frontend/src/types/index.ts` — possibly no changes needed
- Account setup UI — wire Gmail OAuth flow
- `kylins.client.backend/tauri.conf.json` — tighten CSP if needed

---

## 7. Success Criteria

- [ ] A user can add a Gmail account via OAuth.
- [ ] Gmail labels appear in the folder pane.
- [ ] Messages sync on startup and every poll tick.
- [ ] Delta sync uses the Gmail History API after the first sync.
- [ ] Composer can send via Gmail.
- [ ] Read/star/trash/archive mutations work and survive offline replay.
- [ ] Unit tests cover client, parser, and source adapter.
- [ ] No regression in IMAP or EAS behavior.
