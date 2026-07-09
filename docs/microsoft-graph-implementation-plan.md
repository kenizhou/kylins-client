# Thunderbird Desktop Microsoft Graph API — Learning Report & Kylins Plan

> Derived from a source-learning study of Thunderbird Desktop (`D:\Projects\mailclient\opensource\thunderbird-desktop`, commit `48f05724af9`).

---

## 1. What library does Thunderbird use for Microsoft Graph?

**Thunderbird does NOT use the Microsoft Graph JavaScript SDK, MSAL, or any third-party Microsoft client library.**

Instead, it uses a **custom, auto-generated Rust crate** called `ms_graph_tb`:

- Location: `rust/ms_graph_tb/`
- Generated from Microsoft's official OpenAPI metadata: `https://github.com/microsoftgraph/msgraph-metadata/blob/master/openapi/v1.0/openapi.yaml`
- Regenerated via `mach ms-graph-tb-extract` (`python/rocbuild/rocbuild/rust.py`)
- Uses raw `http::Request`, `serde_json`, and custom traits (`Operation`, `OperationBody`, `Select`, `Expand`, `Filter`)
- Supports pagination (`Paginated<T>`, `DeltaResponse<T>`, `DeltaItem<T>`, `NextPage<R>`)
- Supports JSON batching (`batching.rs`)
- Supports MAPI legacy extended properties (`extended_properties.rs`)

Key files:

| File | Purpose |
|---|---|
| `rust/ms_graph_tb/src/lib.rs` | Core traits: `Operation`, `OperationBody`, `Select`, `Expand`, `Filter` |
| `rust/ms_graph_tb/src/paths/me/messages.rs` | Generated `/me/messages` operations |
| `rust/ms_graph_tb/src/paths/me/mail_folders.rs` | Generated `/me/mailFolders` operations |
| `rust/ms_graph_tb/src/pagination.rs` | Delta link / next page handling |
| `rust/ms_graph_tb/src/batching.rs` | Graph JSON batching |
| `rust/ms_graph_tb/src/extended_properties.rs` | MAPI single-value extended properties |

The actual Thunderbird integration is in a separate crate:

- `rust/graph_xpcom/` — XPCOM bridge that wraps `ms_graph_tb` and implements the shared `IExchangeClient` interface.
- `rust/protocol_shared/` — shared abstractions used by both Graph and EWS (auth, operation queue, outgoing server).

---

## 2. Core Concepts

### 2.1 Mail-only Graph integration

Thunderbird's Graph integration is **mail-only**. Calendars and contacts are NOT integrated via Graph; they use CalDAV/ICS and CardDAV/MAPI/LDAP respectively. The Graph scopes requested are only:

- `User.Read`
- `MailboxFolder.ReadWrite`
- `Mail.ReadWrite`
- `Mail.Send`
- `offline_access`

### 2.2 Delta sync as the primary mechanism

Thunderbird uses Graph **delta query** for both folders and messages:

- Folder hierarchy: `GET /me/mailFolders/delta`
- Messages per folder: `GET /me/mailFolders/{id}/messages/delta`

The final response contains an `@odata.deltaLink` that is persisted as the sync state token for the next sync.

There is **no use of Graph change notifications (webhooks/subscriptions)**. Sync is purely client-pulled.

### 2.3 Shared Exchange abstraction

Graph and EWS share a single XPCOM interface: `IExchangeClient`. The C++ `ExchangeIncomingServer` picks the concrete client at runtime based on the account type and the `mail.graph.enabled` pref:

```cpp
if (StaticPrefs::mail_graph_enabled()) {
    nsAutoCString contractId{"@mozilla.org/messenger/"};
    contractId.Append(type);  // "graph" or "ews"
    contractId.Append("-client;1");
    mClient = do_CreateInstance(contractId.Data(), &rv);
} else {
    mClient = do_CreateInstance("@mozilla.org/messenger/ews-client;1", &rv);
}
```

### 2.4 OAuth2 in JavaScript, token consumption in Rust

- OAuth2 flow lives in JavaScript modules (`OAuth2.sys.mjs`, `OAuth2Module.sys.mjs`, `OAuth2Providers.sys.mjs`).
- Refresh tokens are stored in the Firefox login manager.
- Rust code obtains a bearer token via an XPCOM callback (`GetAccessToken`).

---

## 3. Architecture

```
C++ / JS mail code
    |
    v
IExchangeClient (XPCOM IDL)
    |
    +-- ews_xpcom::XpcomEwsBridge  -->  ews crate
    |
    +-- graph_xpcom::XpcomGraphBridge  -->  ms_graph_tb crate
```

Shared Rust infrastructure in `rust/protocol_shared/src/`:

| Module | Purpose |
|---|---|
| `client.rs` | `ProtocolClient` trait, `DoOperation` trait |
| `operation_sender.rs` | `OperationSender<ServerT>`, retry/auth failure handling |
| `authentication/credentials.rs` | `Credentials` enum, `AuthenticationProvider` trait |
| `outgoing.rs` | `SendCapableClient`, `OutgoingServer` |
| `safe_xpcom/` | Safe XPCOM listener wrappers |

### Key source files

| Concern | Path |
|---|---|
| Graph API generated crate | `rust/ms_graph_tb/` |
| Graph XPCOM bridge | `rust/graph_xpcom/src/lib.rs` |
| Graph client operations | `rust/graph_xpcom/src/client/*.rs` |
| Shared protocol abstractions | `rust/protocol_shared/src/` |
| Exchange incoming server (C++) | `mailnews/protocols/exchange/src/ExchangeIncomingServer.cpp` |
| Exchange client IDL | `mailnews/protocols/exchange/src/IExchangeClient.idl` |
| XPCOM component registration | `mailnews/protocols/exchange/src/components.conf` |
| OAuth2 providers config | `mailnews/base/src/OAuth2Providers.sys.mjs` |
| OAuth2 module | `mailnews/base/src/OAuth2Module.sys.mjs` |
| OAuth2 core flow | `mailnews/base/src/OAuth2.sys.mjs` |
| Custom OAuth details | `mailnews/protocols/exchange/src/ExchangeOAuth2CustomDetails.cpp` |
| Graph pref | `mail/app/StaticPrefList.yaml` |
| Fake Graph test server | `mailnews/test/fakeserver/GraphServer.sys.mjs` |

---

## 4. Design Patterns

### 4.1 Code generation from OpenAPI

Instead of hand-writing Graph request types, Thunderbird generates them from Microsoft's OpenAPI spec. This ensures correctness and makes it easy to add new endpoints by updating the supported-types/paths lists.

### 4.2 Delta-link sync state

Sync state is an opaque `@odata.deltaLink` URL stored per-folder (and per-folder-hierarchy). The client simply replays the URL on the next sync. This is simpler than Gmail's `historyId` because the server encodes all needed state in the link.

### 4.3 Operation queue + retry

`OperationSender` queues operations, handles auth failures (token refresh), transport security failures, and retries. Both EWS and Graph use the same queue/retry machinery.

### 4.4 Raw MIME for send

Thunderbird builds the outgoing message as RFC822 MIME in Rust, base64-encodes it, and uses:

1. `POST /me/messages` (create draft from MIME)
2. `PATCH /me/messages/{id}` (set Bcc and DSN flag)
3. `POST /me/messages/{id}/send`

This avoids the complexity of constructing a Graph message JSON object and preserves exact MIME semantics.

### 4.5 Polling only

Like Velo's Gmail integration, Thunderbird Graph does **not** use server push. It relies on periodic delta sync (the exact cadence is driven by the existing mail backend scheduler).

---

## 5. Flow

### 5.1 Account setup / OAuth

1. Account autoconfig returns type `graph` or `ews`.
2. `OAuth2Providers.sys.mjs` returns Graph scopes if type is `graph` and `mail.graph.enabled` is true.
3. `OAuth2.sys.mjs` performs authorization-code + PKCE flow in an external browser or internal dialog.
4. `OAuth2Module.sys.mjs` stores the refresh token in the login manager.
5. `ExchangeOAuth2CustomDetails` stores tenant/app ID/scopes/endpoint overrides.

### 5.2 Folder sync

1. `ExchangeIncomingServer::GetNewMessages` triggers `syncFolderHierarchy`.
2. Graph client calls `GET /me/mailFolders/delta`.
3. Process `DeltaItem::Present` / `Removed`, paginate via `@odata.nextLink`.
4. Persist `@odata.deltaLink` via `onSyncStateTokenChanged`.
5. Map well-known folders (Inbox, Sent, Trash, etc.) to folder flags/roles.

### 5.3 Message sync

1. `syncMessagesForFolder` is called per folder.
2. Graph client calls `GET /me/mailFolders/{id}/messages/delta`.
3. `select` only the properties Thunderbird needs (headers, recipients, flag, read status, etc.).
4. Process present/removed items, paginate.
5. Persist `@odata.deltaLink`.

### 5.4 Fetch full message

1. `getMessage` called with message id.
2. `GET /me/messages/{id}/$value` returns raw RFC822 MIME.
3. MIME is passed to the mail parser.

### 5.5 Send message

1. Composer produces RFC822 MIME.
2. `POST /me/messages` with base64 MIME content.
3. `PATCH /me/messages/{id}` to add Bcc and DSN flag.
4. `POST /me/messages/{id}/send`.

### 5.6 Mutations

Read/star/trash/junk/move/copy/delete are implemented as Graph operations in `rust/graph_xpcom/src/client/*.rs`, called through the `IExchangeClient` interface.

---

## 6. How It Works

Thunderbird leverages its existing Exchange infrastructure and swaps the transport layer:

- **EWS** uses SOAP/XML via the `ews` crate.
- **Graph** uses JSON/REST via the auto-generated `ms_graph_tb` crate.

Both implement the same `IExchangeClient` interface, so the C++ mail code and UI are transport-agnostic. OAuth2, operation queuing, retry, and outgoing mail are shared.

The generated crate means Thunderbird doesn't hand-maintain hundreds of Graph request/response types; it regenerates them from Microsoft's canonical OpenAPI spec.

---

## 7. Current Codebase Comparison (Kylins)

### 7.1 Patterns Kylins already follows

1. **Rust-centric backend** — Kylins already does DB, crypto, sync, and protocol work in Rust, similar to Thunderbird's Rust Graph stack.
2. **Generic source trait** — `MailSource` in `sync_engine/mod.rs` is the equivalent of Thunderbird's `IExchangeClient` / `ProtocolClient`.
3. **Delta sync cursors** — Kylins already stores per-source cursors (`folder_sync_state`, `eas_sync_state`).
4. **OAuth callback server** — `oauth.rs` already handles localhost OAuth callbacks and token exchange/refresh.
5. **Offline replay queue** — `engine.rs` already replays pending operations through the `MailSource` trait.
6. **Raw MIME send** — Kylins already builds RFC5322 MIME in `mail/builder.rs` and passes raw bytes to `MailSource::send`.
7. **Capability flags** — `Capabilities::saves_sent_automatically` already handles providers that auto-save Sent copies.

### 7.2 Patterns Kylins misses for Graph

1. **No Graph provider type** — `MailProvider` is currently `'gmail_api' | 'imap' | 'eas'`. Need to add `'graph'` or `'ms_graph'`.
2. **No Graph REST client** — No equivalent of `ms_graph_tb` or `graph_xpcom`.
3. **No Microsoft OAuth frontend flow** — Kylins has no Microsoft-specific OAuth scopes or account setup path.
4. **No delta-link cursor variant** — `Cursor` has `Imap` and `Eas`; need a `Graph` variant carrying the `delta_link` per folder.
5. **No Graph message/folder mapping** — Need `MailFolder` → `RemoteFolder` and Graph `Message` → `RemoteMessage`.
6. **No Graph send path** — Need `POST /me/messages` → `PATCH` → `POST /send`.
7. **No Graph mutations** — Need read/star/trash/move/copy/delete via Graph endpoints.
8. **No auto-generated types** — Kylins hand-writes types (like EAS). Adopting OpenAPI codegen is optional but would scale better.

---

## 8. Suggested Improvements (Prioritized)

| # | Improvement | Impact | Effort | Files |
|---|---|---|---|---|
| 1 | Add `graph` provider to types and factory | High | Small | `types/index.ts`, `sync_engine/mod.rs` |
| 2 | Build/port a Microsoft Graph REST client | High | Large | `graph/client.rs`, `graph/types.rs` |
| 3 | Add Microsoft OAuth2 frontend flow | High | Medium | `services/msgraph/auth.ts`, account setup UI |
| 4 | Add `Graph` cursor variant and persistence | High | Small | `sync_engine/mod.rs`, `db/sync_state.rs` |
| 5 | Create `GraphSource` implementing `MailSource` | High | Large | `sync_engine/graph_source.rs` |
| 6 | Map Graph folders/labels → `RemoteFolder` | Medium | Small | `graph_source.rs` |
| 7 | Map Graph message JSON → `RemoteMessage` | Medium | Medium | `graph_source.rs` / `graph/parser.rs` |
| 8 | Implement Graph send (`/me/messages` + send) | Medium | Medium | `graph_source.rs` |
| 9 | Implement Graph mutations | Medium | Medium | `graph_source.rs` |
| 10 | Add tests + fake Graph server | High | Medium | `tests/`, fake server module |

---

## 9. Recommended Implementation Plan

### Phase 0 — Foundation

1. **Add `graph` provider type**
   - Update `kylins.client.frontend/src/types/index.ts`:
     ```ts
     export type MailProvider = 'gmail_api' | 'imap' | 'eas' | 'graph';
     ```
   - Add `graph` branch to `sync_engine::source_for_account`.

2. **Create backend `graph` module**
   ```
   kylins.client.backend/src/graph/mod.rs
   kylins.client.backend/src/graph/client.rs
   kylins.client.backend/src/graph/types.rs   // optional
   ```
   Expose in `lib.rs`:
   ```rust
   pub mod graph;
   ```

3. **HTTP client choice**
   - Use `reqwest` (already in `Cargo.toml` via `oauth.rs`).

### Phase 1 — Microsoft OAuth2 Frontend

Create `kylins.client.frontend/src/services/msgraph/auth.ts`:

- Scopes:
  ```
  https://graph.microsoft.com/User.Read
  https://graph.microsoft.com/MailboxFolder.ReadWrite
  https://graph.microsoft.com/Mail.ReadWrite
  https://graph.microsoft.com/Mail.Send
  offline_access
  ```
- Token endpoint: `https://login.microsoftonline.com/common/oauth2/v2.0/token`
- Auth endpoint: `https://login.microsoftonline.com/common/oauth2/v2.0/authorize`
- PKCE + external browser flow, using existing `start_oauth_server` Rust command.
- Exchange code via existing `oauth_exchange_token` Rust command.
- Fetch user info from `https://graph.microsoft.com/v1.0/me`.
- Create account with `provider: 'graph'`, tokens, and `oauthProvider: 'microsoft'`.

### Phase 2 — Graph REST Client

Build `graph/client.rs` with:

- Authentication header injection.
- Token refresh via `oauth_refresh_token` helper.
- Delta sync endpoints:
  - `GET /me/mailFolders/delta`
  - `GET /me/mailFolders/{id}/messages/delta`
- Message fetch:
  - `GET /me/messages/{id}/$value` (raw MIME)
  - `GET /me/messages/{id}` (metadata)
- Send:
  - `POST /me/messages` (from MIME)
  - `PATCH /me/messages/{id}`
  - `POST /me/messages/{id}/send`
- Mutations:
  - `PATCH /me/messages/{id}` for read/flag
  - `POST /me/messages/{id}/move`
  - `POST /me/messages/{id}/copy`
  - `DELETE /me/messages/{id}`
  - `POST /me/messages/{id}/trash` / `/untrash`

Pagination: follow `@odata.nextLink`; delta sync ends at `@odata.deltaLink`.

### Phase 3 — Extend Sync Engine

1. **Add `Graph` cursor variant**
   ```rust
   Cursor::Graph {
       delta_link: String,
   }
   ```

2. **Persist delta links**
   - Add `graph_sync_state` table:
     ```sql
     CREATE TABLE graph_sync_state (
       account_id TEXT NOT NULL,
       folder_id TEXT NOT NULL,
       delta_link TEXT NOT NULL,
       last_sync_at INTEGER NOT NULL,
       PRIMARY KEY (account_id, folder_id)
     );
     ```
   - Or reuse `sync_state` generically. Recommended: dedicated table consistent with EAS.

3. **Create `GraphSource`**
   - File: `sync_engine/graph_source.rs`
   - Implement `MailSource`:
     - `capabilities()`:
       ```rust
       Capabilities {
           saves_sent_automatically: true,
           ..Capabilities::default()
       }
       ```
     - `list_folders()` → `GET /me/mailFolders/delta`, map to `RemoteFolder`.
     - `sync_folder(folder, cursor)` → delta sync messages, return `FolderDelta`.
     - `fetch_body(folder, uid)` → fetch raw MIME or body content.
     - `set_flags(folder, uids, flag, add)` → `PATCH /me/messages/{id}`.
     - `move_messages(src, uids, dest)` → `POST /me/messages/{id}/move`.
     - `copy_messages(src, uids, dest)` → `POST /me/messages/{id}/copy`.
     - `delete_messages(folder, uids)` → `DELETE` or trash.
     - `send(raw_mime)` → create + patch + send.

4. **Folder role mapping**
   | Graph well-known folder | `role` |
   |---|---|
   | `inbox` | `inbox` |
   | `sentitems` | `sent` |
   | `drafts` | `drafts` |
   | `deleteditems` | `trash` |
   | `junkemail` | `junk` |
   | `archive` | `archive` |

5. **Message mapping**
   - Use Graph `id` as a stable string; hash to `u32` for `RemoteMessage.uid`.
   - Map `from`, `toRecipients`, `ccRecipients`, `bccRecipients`, `replyTo`.
   - `is_read` → `isRead`
   - `is_starred` → `flag.flagStatus == "flagged"`
   - `is_draft` → `isDraft`
   - `subject`, `bodyPreview`, `receivedDateTime`, `sentDateTime`
   - `internetMessageHeaders` for `Message-Id`, `References`, `In-Reply-To`, `Authentication-Results`

### Phase 4 — Wire Factory and UI

- Add `graph` branch to `source_for_account`.
- Add Microsoft account option to the Add Account UI.
- Store Microsoft client id/secret in settings or embed them.

### Phase 5 — Testing

1. **Unit tests**
   - Graph client request signing and token refresh.
   - Folder/message mapping functions.
   - `GraphSource::capabilities()`.
   - Factory returns Graph source.

2. **Engine tests**
   - Mock Graph client and drive `run_sync_round_with_source`.
   - Verify delta sync persists messages.
   - Verify send path skips Sent append.

3. **Fake Graph server**
   - Create a test fake similar to Thunderbird's `GraphServer.sys.mjs`, but in Rust or as a simple `wiremock`/`httptest` server.

4. **Manual integration**
   - Register Azure app or use Thunderbird's well-known client id.
   - Add a Microsoft/Outlook.com account.
   - Verify folder list, sync, send, read/star/trash.

### Phase 6 — Polish

- Rate-limit handling (429 + `Retry-After`).
- Auth revocation detection.
- CSP entries for `https://graph.microsoft.com` and `https://login.microsoftonline.com`.
- Logging consistent with IMAP/EAS sources.

---

## 10. Open Decisions

1. **Provider name**: `'graph'`, `'ms_graph'`, or `'outlook'`?
2. **Client credentials**: use Thunderbird's well-known public client id, or register a Kylins-specific Azure app?
3. **Delta-link persistence**: dedicated `graph_sync_state` table or generic cursor store?
4. **Code generation**: hand-write Graph types (like EAS) or adopt OpenAPI codegen (like Thunderbird)?
5. **Threading model**: Graph has `conversationId`; should Kylins use it or rely on `References`/`In-Reply-To`?
6. **Calendars/contacts**: out of scope initially, but ensure scopes can be expanded later.

---

## 11. File Checklist

### New files

- `kylins.client.backend/src/graph/mod.rs`
- `kylins.client.backend/src/graph/client.rs`
- `kylins.client.backend/src/graph/types.rs` (optional)
- `kylins.client.backend/src/sync_engine/graph_source.rs`
- `kylins.client.frontend/src/services/msgraph/auth.ts`
- `kylins.client.backend/migrations/...` for `graph_sync_state` table (if chosen)

### Modified files

- `kylins.client.backend/src/lib.rs` — add `pub mod graph;`
- `kylins.client.backend/src/sync_engine/mod.rs` — add `Graph` cursor variant and factory branch
- `kylins.client.backend/src/db/sync_state.rs` — add Graph cursor persistence
- `kylins.client.frontend/src/types/index.ts` — add `'graph'` to `MailProvider`
- Account setup UI — wire Microsoft OAuth flow
- `kylins.client.backend/tauri.conf.json` — CSP if needed

---

## 12. Success Criteria

- [ ] A user can add a Microsoft/Outlook.com account via OAuth.
- [ ] Graph mail folders appear in the folder pane.
- [ ] Messages sync on startup and every poll tick using delta query.
- [ ] Composer can send via Graph.
- [ ] Read/star/trash/archive/move mutations work and survive offline replay.
- [ ] Unit tests cover client, parser, and source adapter.
- [ ] No regression in IMAP, EAS, or Gmail behavior.
