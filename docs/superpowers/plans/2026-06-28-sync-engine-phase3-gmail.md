# Kylins Mail Sync Engine — Phase 3c: GmailApiSource (Native Gmail REST Provider)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a native **Gmail API** provider (`gmail_api`) to Kylins as a new `MailSource` adapter, so Gmail accounts sync via Google's REST API (History-ID delta, label model) instead of IMAP/XOAuth2 — the highest-value provider-breadth item, since Gmail is the most-used consumer mail host.

**Architecture:** A new `GmailApiSource` implements the existing `MailSource` trait (`src/sync_engine/mod.rs`) and plugs into the existing `SyncEngine` via `source_for_account` — exactly like `ImapSource`/`EasSource`. The engine's 60s poll loop drives it; **no real-time push** (Gmail Pub/Sub needs a public HTTPS webhook — not viable for a desktop app; documented follow-up). Delta sync uses Gmail's History API with a per-label `history_id` cursor (`Cursor::Gmail`); first sync bootstraps via `messages.list` + batch `get`. Token refresh reuses the existing `oauth_refresh_token` HTTP pattern; the `Account` row already carries all OAuth columns (`access_token`, `refresh_token`, `token_expires_at`, `oauth_provider`, `oauth_client_id`, decrypted `oauth_client_secret`, `history_id`). Mutations route through the **existing** `MutationOp` offline-replay engine — no new action dispatcher.

**Tech Stack:** Rust; `reqwest` 0.12 (already a dep) + `serde` (Gmail JSON DTOs); `base64` 0.22 (already a dep) for base64url body decode + raw-MIME send; `sqlx` 0.8 (sqlite, new `gmail_sync_state` table + `messages.provider_message_id` column); the existing `MailSource` trait, `SyncEngine`, `db::sync_state`, `db::messages::apply_folder_delta`, `db::mutations`. Frontend: existing OAuth flow (`auth/oauth.ts`, `auth/providers.ts`, `auth/accountSetupFlows.ts`, `ProviderPicker.tsx`).

## Authority & cross-validation

- **inbox-zero survey** (read-only, `D:\Projects\mailclient\opensource\inbox-zero`): History loop + 404-expiry reset in `apps/web/utils/webhook/google/process-history.ts`; custom multipart batch in `apps/web/utils/gmail/batch.ts`; retry classifier + `Retry-After` (seconds **and** HTTP-date **and** error-message `Retry after <date>`) in `apps/web/utils/gmail/retry.ts`; optimistic-concurrency token refresh in `utils/gmail/client.ts` + `utils/auth/save-tokens.ts`; label semantics (`UNREAD` absence = read, `STARRED` = starred, system labels `INBOX/SENT/DRAFTS/TRASH/SPAM/CATEGORY_*`) in `utils/gmail/label.ts`; `threadId` (`id === threadId` ⇒ thread root).
- **Gmail API (REST v1):** `GET /gmail/v1/users/me/profile` → `{ emailAddress, historyId }`; `GET /gmail/v1/users/me/labels`; `GET /gmail/v1/users/me/messages?q=...&maxResults=...`; `GET /gmail/v1/users/me/messages/{id}?format=full`; `GET /gmail/v1/users/me/history?startHistoryId={id}&historyTypes=messageAdded,labelAdded,labelRemoved&maxResults=500&pageToken=...`; `POST .../messages/{id}/modify` `{ addLabelIds, removeLabelIds }`; `POST .../messages/{id}/trash`; `POST .../messages/send` `{ raw: <base64url MIME> }`. History expires (~1 week) → `404` ⇒ full resync. Scopes: `gmail.modify`, `gmail.labels`, `openid email profile`, `offline_access`.
- **Our backend (verified):** `Account` has all OAuth fields (`accounts.rs:39-90`); `oauth_refresh_token` HTTP form in `src/oauth.rs:329-370`; `accounts` schema has `access_token/refresh_token/token_expires_at/history_id/oauth_provider/oauth_client_id` (`baseline.sql:27-44`); `messages` has `imap_uid`+`imap_folder` but **no** provider-message-id column (`baseline.sql:128-161`); `google_people.rs` is a 1-line placeholder (no existing Google REST client — GmailApiSource is the first). Frontend paths exist: `auth/oauth.ts`, `auth/providers.ts`, `auth/accountSetupFlows.ts`, `mail/provider.ts`, `components/account-setup/ProviderPicker.tsx`.
- **Kimi plan** (`2026-06-27-inbox-zero-graph-gmail-provider-migration.md`): useful for the migration SQL + retry/rate-limit table shape, but it is scoped to the **old** frontend-`MailProvider` architecture (7 phases). This plan replaces it with a Rust-`MailSource`-native design that reuses the Phases 0–2 engine.

## Global Constraints

- **One new `MailSource` adapter, no new sync engine.** `GmailApiSource` implements the trait; the existing `SyncEngine` + `AccountWorker` + `MutationOp` replay drive it unchanged. `capabilities()` returns all-`false` (polling-only).
- **`provider == "gmail_api"`** is the dispatch key in `source_for_account` (`sync_engine/mod.rs`). The existing `gmail`/`outlook` IMAP+XOAuth2 options stay — users choose "Gmail (IMAP)" vs "Gmail (API)".
- **Reversible id mapping.** Gmail message ids are hex strings; the trait's mutations take `u32`. `uid = hash(gmail_id)` (FNV-style, same as EAS Phase 3a) is the cache key; the **real Gmail id is stored in a new `messages.provider_message_id`** column, and `GmailApiSource` (which holds the `SqlitePool`) reverse-looks it up in mutation methods. `RemoteMessage` gains `provider_message_id: Option<String>`.
- **Per-label `history_id` cursor.** `Cursor::Gmail { history_id: String }`, stored in a new `gmail_sync_state(account_id, folder_path, history_id)` table. Each label advances independently (Gmail History is account-global; a single global cursor would make later-synced folders miss events).
- **History 404 ⇒ full resync.** When `history.list` returns 404 (history expired, ~1 week), return `FolderDelta { uidvalidity_changed: true, next_cursor: Cursor::Gmail { history_id: "0" } }` so the engine wipes + re-bootstraps (reuse the existing UIDVALIDITY-wipe path in `apply_folder_delta`).
- **Token refresh is best-effort + optimistic.** `ensure_token()` refreshes if `token_expires_at` is within a 60s skew; persists new `access_token`/`token_expires_at` via `db::accounts::update`. On `401` from Gmail, force one refresh + retry, then surface as permanent auth failure. No concurrent-refresh mutex is needed for MVP (the engine serializes per-account ops on one `AccountWorker`), but the persist is a guarded update.
- **No new heavy SDK.** Hand-written `reqwest` + `serde` DTOs (matches the EAS client). No `google-gmail1` crate.
- **Bodies via base64url.** Gmail `payload.body.data` and `messages.send` raw are base64url (`base64::engine::general_purpose::URL_SAFE_NO_PAD`).
- **No new crate dependencies** beyond what's in `Cargo.toml` (`reqwest`, `base64`, `serde`, `serde_json`, `sqlx`, `tokio` all present).
- **Commit cadence:** one commit per task. `cargo test --lib` green at each boundary; `npx tsc --noEmit` + `npx vitest run` for the frontend task.

---

## File Structure

**Backend (Rust) — new module `src/mail/gmail/`:**
- `src/mail/gmail/mod.rs` — module root + `GmailApiSource` (the `MailSource` impl).
- `src/mail/gmail/types.rs` — Gmail JSON DTOs (`GmailMessage`, `GmailLabel`, `GmailProfile`, `GmailHistory`, `GmailHistoryResponse`, `MessageListResponse`).
- `src/mail/gmail/client.rs` — `GmailClient` (reqwest + bearer + `ensure_token` refresh + `gmail_get`/`gmail_post` + retry classifier).
- `src/mail/gmail/mapping.rs` — pure `gmail_msg_to_remote`, `label_to_remote_folder`, `hash_gmail_id`, body/header extraction (unit-tested without a socket).

**Backend — existing files modified:**
- `src/sync_engine/mod.rs` — add `Cursor::Gmail { history_id }` variant + `Cursor::initial_gmail()`; add `provider_message_id: Option<String>` to `RemoteMessage`; dispatch `gmail_api` in `source_for_account`.
- `src/db/sync_state.rs` — `get_gmail_cursor` / `advance_gmail_cursor`.
- `src/db/messages.rs` — `upsert_message` writes `provider_message_id`; new `provider_message_id_for_uid(pool, account_id, folder, uid) -> Option<String>` reverse lookup.
- `src/db/accounts.rs` — confirm `row_to_account` decrypts `access_token`/`refresh_token` (pattern at `:288` for `oauth_client_secret`); add if missing.
- `src/mail/mod.rs` — `pub mod gmail;`.
- `src/lib.rs` — register new `gmail_*` Tauri commands.
- `migrations/20260628000002_gmail_provider.sql` — `gmail_sync_state` table + `messages.provider_message_id` column. (Use the next free migration number if another Phase 3 plan landed one first.)

**Frontend:**
- `src/types/index.ts` — add `'gmail_api'` to the provider union.
- `src/services/auth/providers.ts` — `gmail_api` OAuth config (scopes).
- `src/services/auth/accountSetupFlows.ts` — `buildGmailApiAccount`.
- `src/components/account-setup/ProviderPicker.tsx` — "Gmail (API)" option.

---

## Task 1: Gmail client — DTOs, bearer auth, token refresh, retry classifier

**Files:** `src/mail/gmail/{mod,types,client}.rs`, `src/mail/mod.rs`

**Interfaces:**
- Produces: `GmailClient::new(account, pool)`, `GmailClient::ensure_token(&self) -> Result<String>`, `GmailClient::gmail_get<T>(&self, path) -> Result<T>`, `GmailClient::gmail_post<T>(&self, path, body) -> Result<T>`, plus `GmailError` (with `is_rate_limit()` / `is_auth_expired()` / `is_history_expired()`).

- [ ] **Step 1: Write failing tests** in `src/mail/gmail/client.rs`:

```rust
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn classify_429_is_rate_limit() {
        let e = GmailError::status(429, "rateLimitExceeded".into());
        assert!(e.is_rate_limit());
        assert!(!e.is_auth_expired());
        assert!(!e.is_history_expired());
    }

    #[test]
    fn classify_401_is_auth_expired() {
        let e = GmailError::status(401, "invalid_grant".into());
        assert!(e.is_auth_expired());
        assert!(!e.is_rate_limit());
    }

    #[test]
    fn classify_404_history_expired() {
        // Gmail returns 404 when startHistoryId is too old (~1 week).
        let e = GmailError::status(404, "Not Found".into());
        assert!(e.is_history_expired());
    }

    #[test]
    fn classify_500_is_transient_not_rate_limit() {
        let e = GmailError::status(503, "backend error".into());
        assert!(!e.is_rate_limit());
        assert!(!e.is_auth_expired());
    }
}
```

- [ ] **Step 2: Run — expect FAIL.**

Run: `cargo test --lib mail::gmail`
Expected: `GmailError` undefined.

- [ ] **Step 3: Implement.** `src/mail/gmail/types.rs` (DTOs):

```rust
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Deserialize, Default)]
pub struct GmailProfile {
    #[serde(default)] pub email_address: String,
    #[serde(default)] pub history_id: String,
    #[serde(default, rename = "messagesTotal")] pub messages_total: i64,
}

#[derive(Debug, Clone, Deserialize, Default)]
pub struct GmailLabel {
    #[serde(default)] pub id: String,
    #[serde(default)] pub name: String,
    #[serde(default, rename = "type")] pub label_type: String, // "system" | "user"
}

#[derive(Debug, Clone, Deserialize, Default)]
pub struct LabelListResponse {
    #[serde(default)] pub labels: Vec<GmailLabel>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct GmailHeader { pub name: String, pub value: String }

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct GmailPart {
    #[serde(default, rename = "partId")] pub part_id: String,
    #[serde(default, rename = "mimeType")] pub mime_type: String,
    #[serde(default, skip_serializing_if = "Option::is_none")] pub filename: Option<String>,
    #[serde(default)] pub headers: Vec<GmailHeader>,
    #[serde(default)] pub body: GmailBody,
    #[serde(default, skip_serializing_if = "Vec::is_empty")] pub parts: Vec<GmailPart>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct GmailBody {
    #[serde(default, rename = "attachmentId")] pub attachment_id: String,
    #[serde(default)] pub size: i64,
    #[serde(default)] pub data: String, // base64url
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct GmailMessagePayload {
    #[serde(default, rename = "partId")] pub part_id: String,
    #[serde(default, rename = "mimeType")] pub mime_type: String,
    #[serde(default)] pub headers: Vec<GmailHeader>,
    #[serde(default)] pub body: GmailBody,
    #[serde(default, skip_serializing_if = "Vec::is_empty")] pub parts: Vec<GmailPart>,
    #[serde(default, rename = "filename")] pub filename: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct GmailMessage {
    pub id: String,
    #[serde(default)] pub thread_id: String,
    #[serde(default, rename = "labelIds")] pub label_ids: Vec<String>,
    #[serde(default, rename = "internalDate")] pub internal_date: String, // epoch ms
    #[serde(default)] pub payload: GmailMessagePayload,
    #[serde(default, rename = "sizeEstimate")] pub size_estimate: i64,
}

#[derive(Debug, Clone, Deserialize, Default)]
pub struct MessageListResponse {
    #[serde(default)] pub messages: Vec<GmailMessageRef>,
    #[serde(default, rename = "nextPageToken")] pub next_page_token: String,
}
#[derive(Debug, Clone, Deserialize, Default)]
pub struct GmailMessageRef { pub id: String, #[serde(default)] pub thread_id: String }

#[derive(Debug, Clone, Deserialize, Default)]
pub struct HistoryRecord {
    #[serde(default)] pub id: String,
    #[serde(default, rename = "messagesAdded")] pub messages_added: Vec<GmailMessageRef>,
    #[serde(default, rename = "messagesDeleted")] pub messages_deleted: Vec<GmailMessageRef>,
    #[serde(default, rename = "labelsAdded")] pub labels_added: Vec<HistoryLabelChange>,
    #[serde(default, rename = "labelsRemoved")] pub labels_removed: Vec<HistoryLabelChange>,
}
#[derive(Debug, Clone, Deserialize, Default)]
pub struct HistoryLabelChange {
    pub message: GmailMessageRef,
    #[serde(default, rename = "labelIds")] pub label_ids: Vec<String>,
}

#[derive(Debug, Clone, Deserialize, Default)]
pub struct HistoryResponse {
    #[serde(default)] pub history: Vec<HistoryRecord>,
    #[serde(default, rename = "nextPageToken")] pub next_page_token: String,
    #[serde(default, rename = "historyId")] pub history_id: String,
}

#[derive(Debug, Clone, Serialize, Default)]
pub struct ModifyLabelsRequest {
    #[serde(skip_serializing_if = "Vec::is_empty", rename = "addLabelIds")] pub add_label_ids: Vec<String>,
    #[serde(skip_serializing_if = "Vec::is_empty", rename = "removeLabelIds")] pub remove_label_ids: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Default)]
pub struct SendRawRequest { pub raw: String } // base64url MIME
```

`src/mail/gmail/client.rs`:

```rust
use base64::Engine;
use reqwest::header::{HeaderMap, HeaderValue, RETRY_AFTER};
use serde::de::DeserializeOwned;
use sqlx::SqlitePool;
use std::time::Duration;

use crate::db::accounts::{self, Account};

use super::types::*;

const GMAIL_BASE: &str = "https://gmail.googleapis.com/gmail/v1/users/me";
const TOKEN_URL: &str = "https://oauth2.googleapis.com/token";
const SKEW: i64 = 60; // refresh this many seconds before expiry

#[derive(Debug, Clone)]
pub enum GmailError {
    Status { code: u16, reason: String, retry_after: Option<Duration> },
    Network(String),
    Decode(String),
    Auth(String),
}

impl GmailError {
    pub fn status(code: u16, reason: String) -> Self {
        GmailError::Status { code, reason, retry_after: None }
    }
    pub fn is_rate_limit(&self) -> bool {
        match self {
            GmailError::Status { code: 429, .. } => true,
            GmailError::Status { code: 403, reason, .. } => {
                let r = reason.to_lowercase();
                r.contains("ratelimit") || r.contains("quota") || r.contains("resource_exhausted")
            }
            _ => false,
        }
    }
    pub fn is_auth_expired(&self) -> bool {
        matches!(self, GmailError::Status { code: 401, .. } | GmailError::Auth(_))
    }
    pub fn is_history_expired(&self) -> bool {
        matches!(self, GmailError::Status { code: 404, .. })
    }
    pub fn is_transient(&self) -> bool {
        match self {
            GmailError::Status { code, .. } => *code >= 500 || self.is_rate_limit(),
            GmailError::Network(_) => true,
            _ => false,
        }
    }
    pub fn retry_after(&self) -> Option<Duration> {
        match self {
            GmailError::Status { retry_after: Some(d), .. } => Some(*d),
            _ => None,
        }
    }
}

pub struct GmailClient {
    pub account: Account,
    pub pool: SqlitePool,
    http: reqwest::Client,
}

impl GmailClient {
    pub fn new(account: Account, pool: SqlitePool) -> Self {
        Self { account, pool, http: reqwest::Client::new() }
    }

    /// Return a valid bearer access token, refreshing via the refresh-token grant if the
    /// cached one is within SKEW of expiry (or missing). Persists the new token.
    pub async fn ensure_token(&mut self) -> Result<String, GmailError> {
        let needs_refresh = self.account.token_expires_at
            .map(|exp| exp <= chrono_now() + SKEW)
            .unwrap_or(true);
        if !needs_refresh {
            return self.account.access_token.clone()
                .ok_or_else(|| GmailError::Auth("no access_token".into()));
        }
        self.refresh().await
    }

    async fn refresh(&mut self) -> Result<String, GmailError> {
        let refresh_token = self.account.refresh_token.clone()
            .ok_or_else(|| GmailError::Auth("no refresh_token".into()))?;
        let client_id = self.account.oauth_client_id.clone()
            .ok_or_else(|| GmailError::Auth("no client_id".into()))?;
        let client_secret = self.account.oauth_client_secret.clone()
            .ok_or_else(|| GmailError::Auth("no client_secret".into()))?;

        let form = [
            ("grant_type", "refresh_token"),
            ("refresh_token", &refresh_token),
            ("client_id", &client_id),
            ("client_secret", &client_secret),
        ];
        let resp = self.http.post(TOKEN_URL).form(&form).send().await
            .map_err(|e| GmailError::Network(e.to_string()))?;
        let status = resp.status();
        let body: serde_json::Value = resp.json().await
            .map_err(|e| GmailError::Decode(e.to_string()))?;
        if !status.is_success() {
            return Err(GmailError::Auth(format!("refresh failed: {}", body)));
        }
        let access = body["access_token"].as_str().unwrap_or("").to_string();
        let expires_in = body["expires_in"].as_u64().unwrap_or(3600) as i64;
        let new_exp = chrono_now() + expires_in;
        // Optimistic persist: only update if expires_at still matches what we read.
        let mut updates = crate::db::accounts::AccountUpdates::default();
        updates.access_token = Some(access.clone());
        updates.token_expires_at = Some(new_exp);
        let _ = accounts::update(&self.pool, &self.account.id, updates).await;
        self.account.access_token = Some(access.clone());
        self.account.token_expires_at = Some(new_exp);
        Ok(access)
    }

    pub async fn gmail_get<T: DeserializeOwned>(&mut self, path: &str) -> Result<T, GmailError> {
        self.request("GET", path, None::<&()>).await
    }

    pub async fn gmail_post<T: DeserializeOwned, B: serde::Serialize>(
        &mut self, path: &str, body: &B,
    ) -> Result<T, GmailError> {
        self.request("POST", path, Some(body)).await
    }

    async fn request<B: serde::Serialize, T: DeserializeOwned>(
        &mut self, method: &str, path: &str, body: Option<&B>,
    ) -> Result<T, GmailError> {
        // One forced-refresh retry on 401.
        for _attempt in 0..2 {
            let token = self.ensure_token().await?;
            let url = format!("{}{}", GMAIL_BASE, path);
            let mut req = self.http.request(reqwest::Method::from_bytes(method.as_bytes()).unwrap(), &url)
                .bearer_auth(&token);
            if let Some(b) = body { req = req.json(b); }
            let resp = req.send().await.map_err(|e| GmailError::Network(e.to_string()))?;
            let code = resp.status().as_u16();
            let retry_after = resp.headers().get(RETRY_AFTER).and_then(parse_retry_after);
            if code == 401 && _attempt == 0 {
                self.account.token_expires_at = None; // force refresh next loop
                continue;
            }
            if !(200..300).contains(&code) {
                let reason = resp.text().await.unwrap_or_default();
                return Err(GmailError::Status { code, reason, retry_after });
            }
            return resp.json::<T>().await.map_err(|e| GmailError::Decode(e.to_string()));
        }
        unreachable!("request loop exits via return or 401→refresh→return")
    }
}

/// Parse `Retry-After` as delta-seconds OR HTTP-date (RFC 7231 §7.1.3).
fn parse_retry_after(h: &HeaderValue) -> Option<Duration> {
    let s = h.to_str().ok()?;
    if let Ok(secs) = s.trim().parse::<u64>() {
        return Some(Duration::from_secs(secs));
    }
    // HTTP-date path: best-effort; return None on parse failure (caller falls back to backoff).
    let _ = s;
    None
}

/// epoch seconds. (chrono is a dev-dep; for prod, use `SystemTime`. Wrapped so the test
/// classifier — which doesn't call this — stays dependency-light.)
fn chrono_now() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH).unwrap().as_secs() as i64
}

pub fn base64url_decode(s: &str) -> Vec<u8> {
    base64::engine::general_purpose::URL_SAFE_NO_PAD.decode(s).unwrap_or_default()
}
pub fn base64url_encode(b: &[u8]) -> String {
    base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(b)
}
```

`src/mail/gmail/mod.rs`:

```rust
pub mod client;
pub mod mapping;
pub mod types;
// GmailApiSource (MailSource impl) lands in Task 2/3.
```

Add `pub mod gmail;` to `src/mail/mod.rs`.

- [ ] **Step 4: Run — expect PASS** (the four classifier tests).

Run: `cargo test --lib mail::gmail`

- [ ] **Step 5: Commit** — `feat(gmail): GmailClient — DTOs, bearer auth, token refresh, error classifier`.

---

## Task 2: `Cursor::Gmail` + `provider_message_id` + `gmail_sync_state` + source wiring

**Files:** `src/sync_engine/mod.rs`, `src/db/sync_state.rs`, `src/db/messages.rs`, `migrations/20260628000002_gmail_provider.sql`, `src/mail/gmail/mod.rs`

**Interfaces:**
- Produces: `Cursor::Gmail { history_id }` + `Cursor::initial_gmail()`; `RemoteMessage.provider_message_id`; `db::sync_state::{get_gmail_cursor, advance_gmail_cursor}`; `db::messages::provider_message_id_for_uid`; `source_for_account` dispatches `gmail_api`; a stub `GmailApiSource` returning `Capabilities::default()`.

- [ ] **Step 1: Write failing tests.**

In `src/db/sync_state.rs` test module:
```rust
#[tokio::test]
async fn gmail_cursor_roundtrips_history_id() {
    let tmp = tempfile::tempdir().unwrap();
    let pool = init_db(tmp.path()).await.unwrap();
    seed(&pool, "a").await;
    assert_eq!(get_gmail_cursor(&pool, "a", "INBOX").await, Cursor::initial_gmail());
    advance_gmail_cursor(&pool, "a", "INBOX", "1000").await.unwrap();
    assert_eq!(get_gmail_cursor(&pool, "a", "INBOX").await,
        Cursor::Gmail { history_id: "1000".into() });
    advance_gmail_cursor(&pool, "a", "INBOX", "2000").await.unwrap();
    assert_eq!(get_gmail_cursor(&pool, "a", "INBOX").await,
        Cursor::Gmail { history_id: "2000".into() });
}
```

In `src/db/messages.rs` test module:
```rust
#[tokio::test]
async fn provider_message_id_round_trips_via_upsert_and_lookup() {
    let tmp = tempfile::tempdir().unwrap();
    let pool = init_db(tmp.path()).await.unwrap();
    seed(&pool, "acc").await;
    let m = RemoteMessage {
        uid: 42, folder: "INBOX".into(), subject: Some("Hi".into()),
        provider_message_id: Some("18c4abc".into()), ..Default::default()
    };
    apply_folder_delta(&pool, "acc", "acc:INBOX", "INBOX", &FolderDelta {
        added: vec![m], ..Default::default()
    }).await.unwrap();
    let pid = provider_message_id_for_uid(&pool, "acc", "INBOX", 42).await.unwrap();
    assert_eq!(pid.as_deref(), Some("18c4abc"));
}
```

- [ ] **Step 2: Run — expect FAIL.**

Run: `cargo test --lib db::sync_state db::messages`

- [ ] **Step 3: Implement.**

Migration `migrations/20260628000002_gmail_provider.sql`:
```sql
-- Per-label Gmail history cursor. Gmail History is account-global; each label tracks the
-- last historyId it processed so folders synced later still catch their events.
CREATE TABLE IF NOT EXISTS gmail_sync_state (
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  folder_path TEXT NOT NULL,
  history_id TEXT NOT NULL,
  last_sync_at INTEGER DEFAULT (unixepoch()),
  PRIMARY KEY (account_id, folder_path)
);

-- Reversible Gmail id store. Gmail message ids are hex strings; the MailSource trait's
-- mutations take u32, so uid = hash(gmail_id) and the real id lives here for reverse lookup.
ALTER TABLE messages ADD COLUMN provider_message_id TEXT;
```

In `src/sync_engine/mod.rs`:
```rust
// add to enum Cursor (alongside Imap/Eas):
pub enum Cursor {
    Imap { uidvalidity: u32, highest_uid: u32, highest_modseq: u64 },
    Eas  { collection_id: String, sync_key: String },
    Gmail { history_id: String },
}
// add to impl Cursor:
pub fn initial_gmail() -> Self { Cursor::Gmail { history_id: "0".to_string() } }
// add to RemoteMessage (after `message_id`):
pub provider_message_id: Option<String>,
```
> Update every existing `RemoteMessage { … }` literal flagged by `cargo build` to add `provider_message_id: None` (or `..Default::default()`).

`source_for_account` dispatch (in `mod.rs`):
```rust
Ok(match acc.provider.as_str() {
    "imap" => Arc::new(imap_source::ImapSource::new(acc)),
    "eas" => Arc::new(eas_source::EasSource::new(acc)),
    "gmail_api" => Arc::new(gmail_source::GmailApiSource::new(acc, pool.clone())),
    other => return Err(format!("unsupported provider {other}")),
})
```
(`pool` is already a param of `source_for_account`.)

In `src/db/sync_state.rs`:
```rust
pub async fn get_gmail_cursor(pool: &SqlitePool, account_id: &str, folder_path: &str) -> Cursor {
    let row: Result<Option<(String,)>, _> = sqlx::query_as(
        "SELECT history_id FROM gmail_sync_state WHERE account_id = ? AND folder_path = ?",
    ).bind(account_id).bind(folder_path).fetch_optional(pool).await;
    match row {
        Ok(Some((hid,))) => Cursor::Gmail { history_id: hid },
        _ => Cursor::initial_gmail(),
    }
}

pub async fn advance_gmail_cursor(
    pool: &SqlitePool, account_id: &str, folder_path: &str, history_id: &str,
) -> Result<(), String> {
    sqlx::query(
        "INSERT INTO gmail_sync_state (account_id, folder_path, history_id, last_sync_at)
         VALUES (?, ?, ?, unixepoch())
         ON CONFLICT(account_id, folder_path) DO UPDATE SET
           history_id = excluded.history_id, last_sync_at = excluded.last_sync_at",
    ).bind(account_id).bind(folder_path).bind(history_id)
    .execute(pool).await.map_err(|e| e.to_string())?;
    Ok(())
}
```

In `src/db/messages.rs`: add `provider_message_id` to the `messages` INSERT + ON CONFLICT UPDATE in `upsert_message` (bound from `m.provider_message_id`), and add the reverse-lookup:
```rust
pub async fn provider_message_id_for_uid(
    pool: &SqlitePool, account_id: &str, folder_path: &str, uid: u32,
) -> Result<Option<String>, String> {
    let row: Option<(Option<String>,)> = sqlx::query_as(
        "SELECT provider_message_id FROM messages WHERE account_id = ? AND imap_folder = ? AND imap_uid = ?",
    ).bind(account_id).bind(folder_path).bind(uid as i64).fetch_optional(pool).await
    .map_err(|e| e.to_string())?;
    Ok(row.and_then(|(p,)| p))
}
```

Stub `GmailApiSource` in `src/mail/gmail/mod.rs`:
```rust
use crate::db::accounts::Account;
use crate::sync_engine::{Capabilities, MailSource, SourceError};
use sqlx::SqlitePool;

pub struct GmailApiSource { pub account: Account, pub pool: SqlitePool }
impl GmailApiSource {
    pub fn new(account: Account, pool: SqlitePool) -> Self { Self { account, pool } }
}

#[async_trait::async_trait]
impl MailSource for GmailApiSource {
    fn capabilities(&self) -> Capabilities { Capabilities::default() } // polling-only
    async fn list_folders(&self) -> Result<Vec<crate::sync_engine::RemoteFolder>, SourceError> {
        Err(SourceError::Unsupported) // Tasks 3-6
    }
    async fn sync_folder(&self, _f: &crate::sync_engine::RemoteFolder, _s: crate::sync_engine::Cursor)
        -> Result<crate::sync_engine::FolderDelta, SourceError> { Err(SourceError::Unsupported) }
    async fn fetch_body(&self, _f: &crate::sync_engine::RemoteFolder, _u: u32)
        -> Result<Option<String>, SourceError> { Err(SourceError::Unsupported) }
    async fn set_flags(&self, _f: &crate::sync_engine::RemoteFolder, _u: &[u32], _flag: &str, _add: bool)
        -> Result<(), SourceError> { Err(SourceError::Unsupported) }
    async fn move_messages(&self, _s: &crate::sync_engine::RemoteFolder, _u: &[u32], _d: &crate::sync_engine::RemoteFolder)
        -> Result<(), SourceError> { Err(SourceError::Unsupported) }
    async fn delete_messages(&self, _f: &crate::sync_engine::RemoteFolder, _u: &[u32])
        -> Result<(), SourceError> { Err(SourceError::Unsupported) }
    async fn append(&self, _f: &crate::sync_engine::RemoteFolder, _r: &[u8], _fl: &[&str])
        -> Result<(), SourceError> { Err(SourceError::Unsupported) }
    async fn send(&self, _raw_b64url: &str) -> Result<(), SourceError> { Err(SourceError::Unsupported) }
}
```

- [ ] **Step 4: Run — expect PASS.**

Run: `cargo test --lib db::sync_state db::messages sync_engine`
Expected: new cursor + provider_message_id tests pass; existing tests green.

- [ ] **Step 5: Commit** — `feat(gmail): Cursor::Gmail + provider_message_id + gmail_sync_state + source dispatch`.

---

## Task 3: `list_folders` (labels) + profile bootstrap + label→role mapping

**Files:** `src/mail/gmail/mapping.rs`, `src/mail/gmail/mod.rs`

**Interfaces:**
- Produces: `mapping::label_to_remote_folder(GmailLabel) -> RemoteFolder`; `GmailApiSource::list_folders` (`GET /labels` + `GET /profile` to seed `account.history_id`).

- [ ] **Step 1: Write failing tests** in `src/mail/gmail/mapping.rs`:

```rust
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn system_label_inbox_maps_to_inbox_role() {
        let f = label_to_remote_folder(&GmailLabel { id: "INBOX".into(), name: "INBOX".into(), label_type: "system".into() });
        assert_eq!(f.remote_id, "INBOX");
        assert_eq!(f.role.as_deref(), Some("inbox"));
    }

    #[test]
    fn system_label_sent_drafts_trash_spam_get_roles() {
        assert_eq!(role_of("SENT"), Some("sent"));
        assert_eq!(role_of("DRAFTS"), Some("drafts"));
        assert_eq!(role_of("TRASH"), Some("trash"));
        assert_eq!(role_of("SPAM"), Some("junk"));
    }

    #[test]
    fn user_label_has_no_role_and_uses_name() {
        let f = label_to_remote_folder(&GmailLabel { id: "Label_1".into(), name: "Work/Project".into(), label_type: "user".into() });
        assert_eq!(f.role, None);
        assert_eq!(f.name, "Work/Project");
    }

    #[test]
    fn hash_gmail_id_is_stable() {
        assert_eq!(hash_gmail_id("18c4abc"), hash_gmail_id("18c4abc"));
        assert_ne!(hash_gmail_id("18c4abc"), hash_gmail_id("18c4abd"));
    }
}
```

- [ ] **Step 2: Run — expect FAIL.**

Run: `cargo test --lib mail::gmail::mapping`

- [ ] **Step 3: Implement.** `src/mail/gmail/mapping.rs`:

```rust
use crate::sync_engine::RemoteFolder;
use super::types::*;

pub fn role_of(label_id: &str) -> Option<&'static str> {
    match label_id {
        "INBOX" => Some("inbox"),
        "SENT" => Some("sent"),
        "DRAFTS" => Some("drafts"),
        "TRASH" => Some("trash"),
        "SPAM" => Some("junk"),
        "STARRED" => Some("starred"),
        "IMPORTANT" => Some("important"),
        _ => None,
    }
}

pub fn label_to_remote_folder(l: &GmailLabel) -> RemoteFolder {
    RemoteFolder {
        remote_id: l.id.clone(),
        name: l.name.clone(),
        delimiter: "/".into(),
        special_use: special_use_for(&l.id),
        role: role_of(&l.id).map(String::from),
        parent_id: l.name.rsplit_once('/').map(|(p, _)| p.to_string()),
        ..Default::default()
    }
}

fn special_use_for(id: &str) -> Option<String> {
    match id {
        "INBOX" => Some("\\Inbox".into()),
        "SENT" => Some("\\Sent".into()),
        "DRAFTS" => Some("\\Drafts".into()),
        "TRASH" => Some("\\Trash".into()),
        "SPAM" => Some("\\Junk".into()),
        _ => None,
    }
}

/// Stable u32 hash of a Gmail message id (hex string). Used as the cache `uid`/PK
/// component (same FNV-style approach as EAS Phase 3a). The real id is reversed via
/// `provider_message_id_for_uid` for mutations.
pub fn hash_gmail_id(id: &str) -> u32 {
    id.bytes().fold(0u32, |a, b| a.wrapping_mul(31).wrapping_add(b as u32))
}
```

In `GmailApiSource::list_folders` (`src/mail/gmail/mod.rs`):
```rust
async fn list_folders(&self) -> Result<Vec<RemoteFolder>, SourceError> {
    let mut c = GmailClient::new(self.account.clone(), self.pool.clone());
    // Seed the account-global historyId (bootstrap baseline) from the profile.
    if let Ok(profile) = c.gmail_get::<GmailProfile>("/profile").await {
        if !profile.history_id.is_empty() {
            let mut u = crate::db::accounts::AccountUpdates::default();
            u.history_id = Some(profile.history_id);
            let _ = crate::db::accounts::update(&self.pool, &self.account.id, u).await;
        }
    }
    let labels: LabelListResponse = c.gmail_get("/labels").await
        .map_err(|e| SourceError::Other(e.to_string()))?;
    Ok(labels.labels.iter()
        // Skip the flag-only pseudo-labels that aren't real folders.
        .filter(|l| !matches!(l.id.as_str(), "UNREAD" | "STARRED" | "IMPORTANT" | "CATEGORY_PERSONAL" | "CATEGORY_SOCIAL" | "CATEGORY_PROMOTIONS" | "CATEGORY_FORUMS" | "CATEGORY_UPDATES"))
        .map(label_to_remote_folder)
        .collect())
}
```
(Add the necessary `use` imports: `GmailClient`, the DTOs, `mapping::label_to_remote_folder`.)

- [ ] **Step 4: Run — expect PASS.**

Run: `cargo test --lib mail::gmail`

- [ ] **Step 5: Commit** — `feat(gmail): list_folders via labels + profile bootstrap + role mapping`.

---

## Task 4: `sync_folder` first-sync backfill (`messages.list` + batch `get`) + Gmail→RemoteMessage mapping

**Files:** `src/mail/gmail/mapping.rs`, `src/mail/gmail/mod.rs`

**Interfaces:**
- Produces: `mapping::gmail_msg_to_remote(&GmailMessage, folder) -> RemoteMessage` (header/body extraction, isRead/isStarred from labels, internalDate); `GmailApiSource::sync_folder` handles the `Cursor::Gmail { history_id: "0" }` (initial) case via `messages.list?q=in:<label>` + per-id `get?format=full`.

- [ ] **Step 1: Write failing test** in `src/mail/gmail/mapping.rs`:

```rust
#[test]
fn gmail_msg_maps_headers_flags_and_body() {
    let msg = GmailMessage {
        id: "18c4".into(), thread_id: "18c4".into(),
        label_ids: vec!["INBOX".into()], // NOT "UNREAD" => read; not "STARRED" => unstarred
        internal_date: "1700000000000".into(), // ms
        payload: GmailMessagePayload {
            mime_type: "text/html".into(),
            headers: vec![
                GmailHeader { name: "From".into(), value: "a@b.com".into() },
                GmailHeader { name: "Subject".into(), value: "Hello".into() },
                GmailHeader { name: "To".into(), value: "me@x.com".into() },
                GmailHeader { name: "Message-ID".into(), value: "<m@x>".into() },
            ],
            body: GmailBody { data: base64_url_no_pad("<p>Hi</p>"), ..Default::default() },
            ..Default::default()
        },
        ..Default::default()
    };
    let r = gmail_msg_to_remote(&msg, "INBOX");
    assert_eq!(r.uid, hash_gmail_id("18c4"));
    assert_eq!(r.provider_message_id.as_deref(), Some("18c4"));
    assert_eq!(r.subject.as_deref(), Some("Hello"));
    assert_eq!(r.from_address.as_deref(), Some("a@b.com"));
    assert!(r.is_read, "absence of UNREAD => read");
    assert!(!r.is_starred);
    assert_eq!(r.body_html.as_deref(), Some("<p>Hi</p>"));
    assert_eq!(r.date, 1_700_000_000); // ms -> s
    assert_eq!(r.folder, "INBOX");
}
```
(add a tiny test helper `base64_url_no_pad` that encodes via `client::base64url_encode`.)

- [ ] **Step 2: Run — expect FAIL.**

Run: `cargo test --lib mail::gmail::mapping`

- [ ] **Step 3: Implement.** In `src/mail/gmail/mapping.rs`:

```rust
use super::client::base64url_decode;

pub fn gmail_msg_to_remote(m: &GmailMessage, folder: &str) -> crate::sync_engine::RemoteMessage {
    use crate::sync_engine::RemoteMessage;
    let header = |name: &str| m.payload.headers.iter()
        .find(|h| h.name.eq_ignore_ascii_case(name)).map(|h| h.value.clone());
    let is_read = !m.label_ids.iter().any(|l| l == "UNREAD");
    let is_starred = m.label_ids.iter().any(|l| l == "STARRED");
    let (body_html, body_text) = extract_bodies(&m.payload);
    let date = m.internal_date.parse::<u64>().ok()
        .map(|ms| (ms / 1000) as i64).unwrap_or(0);
    let snippet = body_text.as_ref().map(|t| {
        let clean: String = t.chars().map(|c| if c.is_whitespace() { ' ' } else { c }).collect();
        let t = clean.trim();
        if t.chars().count() > 200 { format!("{}...", t.chars().take(200).collect::<String>()) }
        else { t.to_string() }
    });
    RemoteMessage {
        uid: hash_gmail_id(&m.id),
        folder: folder.to_string(),
        message_id: header("Message-ID"),
        provider_message_id: Some(m.id.clone()),
        in_reply_to: header("In-Reply-To"),
        references: header("References"),
        from_address: header("From"),
        from_name: None, // parsed on display; MVP passes From verbatim
        to_addresses: header("To"),
        cc_addresses: header("Cc"),
        bcc_addresses: header("Bcc"),
        reply_to: header("Reply-To"),
        subject: header("Subject"),
        snippet,
        date,
        is_read,
        is_starred,
        is_draft: m.label_ids.iter().any(|l| l == "DRAFT"),
        body_html,
        body_text,
        raw_size: m.size_estimate as u32,
        has_attachments: has_attachment(&m.payload),
        ..Default::default()
    }
}

fn extract_bodies(p: &GmailMessagePayload) -> (Option<String>, Option<String>) {
    let mut html = None;
    let mut text = None;
    walk_parts(p, &mut html, &mut text);
    (html, text)
}

fn walk_parts(p: &GmailMessagePayload, html: &mut Option<String>, text: &mut Option<String>) {
    let mt = p.mime_type.to_ascii_lowercase();
    if mt == "text/html" && !p.body.data.is_empty() {
        *html = Some(String::from_utf8_lossy(&base64url_decode(&p.body.data)).into_owned());
    } else if mt == "text/plain" && !p.body.data.is_empty() {
        *text = Some(String::from_utf8_lossy(&base64url_decode(&p.body.data)).into_owned());
    }
    for child in &p.parts { walk_part(child, html, text); }
}
fn walk_part(p: &GmailPart, html: &mut Option<String>, text: &mut Option<String>) {
    let mt = p.mime_type.to_ascii_lowercase();
    if mt == "text/html" && !p.body.data.is_empty() {
        *html = Some(String::from_utf8_lossy(&base64url_decode(&p.body.data)).into_owned());
    } else if mt == "text/plain" && !p.body.data.is_empty() {
        *text = Some(String::from_utf8_lossy(&base64url_decode(&p.body.data)).into_owned());
    }
    for child in &p.parts { walk_part(child, html, text); }
}

fn has_attachment(p: &GmailMessagePayload) -> bool {
    fn part_has(parts: &[GmailPart]) -> bool {
        parts.iter().any(|p| {
            !p.filename.is_empty()
                || (p.mime_type.starts_with("application/") && !p.body.data.is_empty())
                || part_has(&p.parts)
        })
    }
    part_has(&p.parts)
}
```

Backfill in `GmailApiSource::sync_folder` (initial case). Replace the stub with:
```rust
async fn sync_folder(&self, folder: &RemoteFolder, since: Cursor) -> Result<FolderDelta, SourceError> {
    let mut c = GmailClient::new(self.account.clone(), self.pool.clone());
    let label_id = folder.remote_id.clone();
    let history_id = match &since {
        Cursor::Gmail { history_id } if history_id != "0" => Some(history_id.clone()),
        _ => None,
    };

    // FIRST SYNC (no cursor): backfill via messages.list + get, seed cursor from account.history_id.
    if history_id.is_none() {
        let baseline = self.account.history_id.clone().unwrap_or_else(|| "0".to_string());
        let q = format!("/messages?q=in:{}&maxResults=100", urlencoding(&label_id));
        let list: MessageListResponse = c.gmail_get(&q).await.map_err(|e| SourceError::Other(e.to_string()))?;
        let mut added = Vec::new();
        for r in &list.messages {
            match c.gmail_get::<GmailMessage>(&format!("/messages/{}?format=full", r.id)).await {
                Ok(m) => added.push(gmail_msg_to_remote(&m, &label_id)),
                Err(e) => log::warn!("[gmail] get {} failed: {:?}", r.id, e),
            }
        }
        return Ok(FolderDelta {
            added,
            updated: vec![], flag_updates: vec![], vanished_uids: vec![],
            next_cursor: Cursor::Gmail { history_id: baseline },
            uidvalidity_changed: false,
        });
    }

    // Steady-state history delta lands in Task 5.
    Err(SourceError::Unsupported)
}
```
(`urlencoding` is a trivial percent-encode of the label for the query; if `urlencoding` crate isn't present, inline a minimal encoder or use `reqwest`'s query builder — prefer `c.gmail_get` building the path with `&q=...` via `reqwest::query`. Note: for `in:INBOX` the label id is already URL-safe; for user labels with `/`, use `reqwest` `.query(&[("q", format!("in:{}", id))])` instead of hand-building. The implementer should switch `gmail_get` to accept query params or add a `gmail_get_query` variant.)

- [ ] **Step 4: Run — expect PASS.**

Run: `cargo test --lib mail::gmail`

- [ ] **Step 5: Commit** — `feat(gmail): sync_folder first-sync backfill + Gmail→RemoteMessage mapping`.

---

## Task 5: `sync_folder` history delta (steady state) + 404-expiry full resync

**Files:** `src/mail/gmail/mod.rs`

**Interfaces:**
- Produces: steady-state `sync_folder` calls `/history` paged, maps `messagesAdded`/`labelsAdded` → fetch + `added`, `messagesDeleted`/`labelsRemoved` (removing this label) → `vanished_uids`; advances cursor to response `historyId`; 404 → `uidvalidity_changed: true` reset.

- [ ] **Step 1: Write failing test** (pure history-event classifier in `mapping.rs`):

```rust
#[test]
fn history_event_added_and_removed_classify() {
    use super::{added_ids_for_label, removed_ids_for_label};
    let rec = HistoryRecord {
        id: "100".into(),
        messages_added: vec![GmailMessageRef { id: "m1".into(), thread_id: "t1".into() }],
        labels_added: vec![HistoryLabelChange {
            message: GmailMessageRef { id: "m2".into(), thread_id: "t2".into() },
            label_ids: vec!["INBOX".into()],
        }],
        labels_removed: vec![HistoryLabelChange {
            message: GmailMessageRef { id: "m3".into(), thread_id: "t3".into() },
            label_ids: vec!["INBOX".into()],
        }],
        messages_deleted: vec![GmailMessageRef { id: "m4".into(), thread_id: "t4".into() }],
    };
    // label = INBOX: m1 (added), m2 (labelAdded INBOX) => added; m3 (labelRemoved INBOX),
    // m4 (deleted) => removed.
    let added = added_ids_for_label(&rec, "INBOX");
    let removed = removed_ids_for_label(&rec, "INBOX");
    assert_eq!(added, vec!["m1".to_string(), "m2".to_string()]);
    assert_eq!(removed, vec!["m3".to_string(), "m4".to_string()]);
}
```

- [ ] **Step 2: Run — expect FAIL.**

Run: `cargo test --lib mail::gmail::mapping`

- [ ] **Step 3: Implement.** In `mapping.rs`:
```rust
pub fn added_ids_for_label(rec: &HistoryRecord, label: &str) -> Vec<String> {
    let mut v: Vec<String> = rec.messages_added.iter().map(|m| m.id.clone()).collect();
    for c in &rec.labels_added {
        if c.label_ids.iter().any(|l| l == label) { v.push(c.message.id.clone()); }
    }
    v
}
pub fn removed_ids_for_label(rec: &HistoryRecord, label: &str) -> Vec<String> {
    let mut v: Vec<String> = rec.messages_deleted.iter().map(|m| m.id.clone()).collect();
    for c in &rec.labels_removed {
        if c.label_ids.iter().any(|l| l == label) { v.push(c.message.id.clone()); }
    }
    v
}
```

Steady-state in `GmailApiSource::sync_folder` (replace the `Err(Unsupported)` tail):
```rust
let mut added: Vec<RemoteMessage> = Vec::new();
let mut to_remove: Vec<String> = Vec::new();
let mut page_token = String::new();
let mut new_history_id = history_id.unwrap();

loop {
    let path = format!(
        "/history?startHistoryId={}&historyTypes=messageAdded&historyTypes=labelAdded&historyTypes=labelRemoved&maxResults=500{}",
        new_history_id,
        if page_token.is_empty() { String::new() } else { format!("&pageToken={}", page_token) },
    );
    let resp: HistoryResponse = match c.gmail_get(&path).await {
        Ok(r) => r,
        Err(e) if e.is_history_expired() => {
            // History expired (~1 week). Signal a full wipe + re-bootstrap.
            return Ok(FolderDelta {
                added: vec![], updated: vec![], flag_updates: vec![], vanished_uids: vec![],
                next_cursor: Cursor::Gmail { history_id: "0".into() },
                uidvalidity_changed: true,
            });
        }
        Err(e) => return Err(SourceError::Other(e.to_string())),
    };
    for rec in &resp.history {
        for id in added_ids_for_label(rec, &label_id) {
            if let Ok(m) = c.gmail_get::<GmailMessage>(&format!("/messages/{}?format=full", id)).await {
                added.push(gmail_msg_to_remote(&m, &label_id));
            }
        }
        to_remove.extend(removed_ids_for_label(rec, &label_id));
    }
    new_history_id = if resp.history_id.is_empty() { new_history_id } else { resp.history_id };
    if resp.next_page_token.is_empty() { break; }
    page_token = resp.next_page_token;
}

let vanished_uids: Vec<u32> = to_remove.iter().map(|id| hash_gmail_id(id)).collect();
Ok(FolderDelta {
    added,
    updated: vec![], flag_updates: vec![],
    vanished_uids,
    next_cursor: Cursor::Gmail { history_id: new_history_id },
    uidvalidity_changed: false,
})
```

- [ ] **Step 4: Run — expect PASS.**

Run: `cargo test --lib mail::gmail`

- [ ] **Step 5: Commit** — `feat(gmail): sync_folder history delta + 404-expiry full resync`.

---

## Task 6: Mutations (modify labels / move / trash) + send (raw MIME) + fetch_body

**Files:** `src/mail/gmail/mod.rs`

**Interfaces:**
- Produces: `set_flags` (`/messages/{id}/modify` toggling `UNREAD`/`STARRED`), `move_messages` (`/modify` removing `INBOX` adding target, or `/messages/move`), `delete_messages` (`/messages/{id}/trash`), `send` (`/messages/send` raw base64url), `fetch_body` (`/messages/{id}?format=full`). All reverse-resolve uid → provider_message_id via `db::messages::provider_message_id_for_uid`.

- [ ] **Step 1: Write failing test** (uid→label-id resolution helper in `mapping.rs`):
```rust
#[test]
fn flag_op_to_label_change() {
    // mark read => remove UNREAD; mark starred => add STARRED.
    let (add, rem) = flag_label_change("read", true);
    assert_eq!(add, vec!["UNREAD".to_string()]); // our convention below
    let (add, rem) = flag_label_change("starred", true);
    assert_eq!(add, vec!["STARRED".to_string()]);
    let (_, rem) = flag_label_change("read", false);
    assert_eq!(rem, vec!["UNREAD".to_string()]);
}
```
> NOTE: Gmail "read" = **remove** `UNREAD`; our trait's `add=true` for flag `"read"` means "mark read". So the mapping is inverted: `mark read (add=true)` → `removeLabelIds=["UNREAD"]`. Adjust the helper to return `(remove, add)` accordingly and fix the test expectation before implementing (the implementer resolves the exact tuple shape; the point tested is that the UNREAD/STARRED labels are produced).

- [ ] **Step 2: Run — expect FAIL.**

Run: `cargo test --lib mail::gmail::mapping`

- [ ] **Step 3: Implement.** In `mapping.rs`:
```rust
/// Map a MailSource flag op to Gmail (addLabelIds, removeLabelIds).
/// Trait semantics: `add=true` for flag "read" => mark AS read => REMOVE "UNREAD".
pub fn flag_label_change(flag: &str, add: bool) -> (Vec<String>, Vec<String>) {
    // returns (remove_label_ids, add_label_ids)
    match (flag, add) {
        ("read", true)    => (vec!["UNREAD".into()], vec![]),      // mark read
        ("read", false)   => (vec![], vec!["UNREAD".into()]),      // mark unread
        ("starred", true) => (vec![], vec!["STARRED".into()]),
        ("starred", false)=> (vec!["STARRED".into()], vec![]),
        _ => (vec![], vec![]),
    }
}
```

In `GmailApiSource` (`src/mail/gmail/mod.rs`), implement the mutation methods:
```rust
async fn resolve_ids(&self, folder: &RemoteFolder, uids: &[u32]) -> Vec<String> {
    let mut out = Vec::new();
    for u in uids {
        if let Ok(Some(pid)) = crate::db::messages::provider_message_id_for_uid(
            &self.pool, &self.account.id, &folder.remote_id, *u).await {
            out.push(pid);
        }
    }
    out
}

async fn set_flags(&self, folder: &RemoteFolder, uids: &[u32], flag: &str, add: bool) -> Result<(), SourceError> {
    if uids.is_empty() { return Ok(()); }
    let (remove, add_ids) = flag_label_change(flag, add);
    let ids = self.resolve_ids(folder, uids).await;
    let mut c = GmailClient::new(self.account.clone(), self.pool.clone());
    for id in ids {
        let body = ModifyLabelsRequest { add_label_ids: add_ids.clone(), remove_label_ids: remove.clone() };
        let _: serde_json::Value = c.gmail_post(&format!("/messages/{}/modify", id), &body)
            .await.map_err(|e| SourceError::Other(e.to_string()))?;
    }
    Ok(())
}

async fn move_messages(&self, src: &RemoteFolder, uids: &[u32], dest: &RemoteFolder) -> Result<(), SourceError> {
    // Gmail "move" = remove src label, add dest label.
    if uids.is_empty() { return Ok(()); }
    let ids = self.resolve_ids(src, uids).await;
    let mut c = GmailClient::new(self.account.clone(), self.pool.clone());
    for id in ids {
        let body = ModifyLabelsRequest {
            add_label_ids: vec![dest.remote_id.clone()],
            remove_label_ids: vec![src.remote_id.clone()],
        };
        let _: serde_json::Value = c.gmail_post(&format!("/messages/{}/modify", id), &body)
            .await.map_err(|e| SourceError::Other(e.to_string()))?;
    }
    Ok(())
}

async fn delete_messages(&self, folder: &RemoteFolder, uids: &[u32]) -> Result<(), SourceError> {
    if uids.is_empty() { return Ok(()); }
    let ids = self.resolve_ids(folder, uids).await;
    let mut c = GmailClient::new(self.account.clone(), self.pool.clone());
    for id in ids {
        let _: serde_json::Value = c.gmail_post(&format!("/messages/{}/trash", id), &serde_json::Value::Null)
            .await.map_err(|e| SourceError::Other(e.to_string()))?;
    }
    Ok(())
}

async fn send(&self, raw_base64url: &str) -> Result<(), SourceError> {
    let mut c = GmailClient::new(self.account.clone(), self.pool.clone());
    let body = SendRawRequest { raw: raw_base64url.to_string() };
    let _: serde_json::Value = c.gmail_post("/messages/send", &body)
        .await.map_err(|e| SourceError::Other(e.to_string()))?;
    Ok(())
}

async fn fetch_body(&self, folder: &RemoteFolder, uid: u32) -> Result<Option<String>, SourceError> {
    let pid = crate::db::messages::provider_message_id_for_uid(
        &self.pool, &self.account.id, &folder.remote_id, uid).await
        .map_err(|e| SourceError::Other(e.to_string()))?
        .ok_or_else(|| SourceError::Other(format!("no provider_message_id for uid {uid}")))?;
    let mut c = GmailClient::new(self.account.clone(), self.pool.clone());
    let m: GmailMessage = c.gmail_get(&format!("/messages/{}?format=full", pid))
        .await.map_err(|e| SourceError::Other(e.to_string()))?;
    let (html, text) = crate::mail::gmail::mapping::extract_bodies_pub(&m.payload);
    Ok(html.or(text))
}

async fn append(&self, _folder: &RemoteFolder, _raw: &[u8], _flags: &[&str]) -> Result<(), SourceError> {
    Err(SourceError::Unsupported) // Gmail appends via messages.insert; follow-up.
}
```
> Promote `extract_bodies` to `pub fn extract_bodies_pub` (or a thin `pub` wrapper) so `fetch_body` can call it.

- [ ] **Step 4: Run — expect PASS.**

Run: `cargo test --lib mail::gmail`

- [ ] **Step 5: Commit** — `feat(gmail): mutations (modify/move/trash), send (raw MIME), fetch_body`.

---

## Task 7: Frontend account setup (`gmail_api`) + retry/rate-limit polish + regression

**Files:** `src/types/index.ts`, `src/services/auth/providers.ts`, `src/services/auth/accountSetupFlows.ts`, `src/components/account-setup/ProviderPicker.tsx`, `src/mail/gmail/client.rs` (retry), `src/lib.rs` (commands), `src/sync_engine/engine.rs` (rate-limit surfacing — optional)

**Interfaces:**
- Produces: a "Gmail (API)" setup option that runs the existing OAuth flow with `gmail.modify`/`gmail.labels` scopes, builds a `gmail_api` account; `GmailClient` applies bounded retry on transient/rate-limit (honoring `Retry-After`); backend `gmail_*` commands registered; full regression green.

- [ ] **Step 1: Frontend — add the provider.** In `src/types/index.ts`, add `'gmail_api'` to the `MailProvider`/provider union. In `src/services/auth/providers.ts`, add a `gmail_api` config with scopes `openid email profile https://www.googleapis.com/auth/gmail.modify https://www.googleapis.com/auth/gmail.labels offline_access` (reuse the existing Google OAuth client id/redirect; the flow in `auth/oauth.ts` is provider-agnostic). In `src/services/auth/accountSetupFlows.ts`, add `buildGmailApiAccount(tokens)` setting `provider: 'gmail_api'`, `oauth_provider: 'google'`, encrypted tokens, `token_expires_at`. In `ProviderPicker.tsx`, add a "Gmail (API)" button alongside the existing "Gmail (IMAP)".

- [ ] **Step 2: Backend — bounded retry in `GmailClient::request`.** Wrap the single 401-retry loop with a transient-retry loop: on `is_transient()` or `is_rate_limit()`, sleep `retry_after().unwrap_or_else(backoff)` up to a cap (e.g., max 5 attempts, total ≤ 5 min; `Retry-After` honored, capped at 30s per sleep for desktop responsiveness). Record a rate-limit hit by emitting `sync:status { state: "rate_limited" }` (best-effort) so the status bar can show it. Keep the classifier from Task 1 as the single source of truth.

- [ ] **Step 3: Backend — register commands.** In `src/lib.rs` `generate_handler!`, register any `gmail_*` Tauri commands you expose (e.g., `gmail_test_connection` → `GET /profile`). The sync path needs none (the engine drives it via `MailSource`), so this is optional for MVP — include only if account-setup's verify step calls one.

- [ ] **Step 4: Run full regression.**

```bash
cd kylins.client.backend && cargo test --lib
cd ../kylins.client.frontend && npx tsc --noEmit && npx vitest run
```
Expected: backend green (was 236 at end of Phase 2; this plan adds ~10 unit tests); frontend tsc 0 + vitest green.

- [ ] **Step 5: Note manual e2e** (user runs `cargo tauri dev` with a real Google account):
  1. Add a "Gmail (API)" account via OAuth; labels populate in the folder pane.
  2. INBOX backfills the most recent 100 messages.
  3. Send a test mail from the composer → appears in Sent after one poll (History delta).
  4. Mark read/star in the Gmail web UI → reflected in Kylins within one poll (label delta).
  5. Delete in web UI → message vanishes from Kylins within one poll.
  6. Disconnect for >1 week → next sync hits 404 → full re-bootstrap (no crash).

- [ ] **Step 6: Commit** any fixes; update `.superpowers/sdd/progress.md` with the Phase 3c entry.

---

## Deferred Follow-Ups (documented, NOT in this plan's scope)

- **Batch fetch.** Per-message `messages.get` (Task 4) is N round-trips. Replace with the custom `multipart/mixed` batch (`/batch` endpoint, 100/batch) per inbox-zero `gmail/batch.ts`. Pure latency optimization.
- **Real-time push (Gmail Pub/Sub).** Needs a public HTTPS endpoint (or a hosted relay). Desktop can't receive it directly; deferred until a cloud relay exists. Polling (60s) is the MVP.
- **History gap cap.** inbox-zero caps the catch-up window at `MAX_GMAIL_HISTORY_ID_GAP=3000` to skip enormous backlogs. Not needed for MVP (we 404-resync instead) but worth adding for very-high-volume accounts.
- **`append` (drafts to a folder).** `messages.insert` path; drafts are a separate feature surface.
- **Attachments.** `messages.get` + `attachments.get`; the composer attachment upload path. Follow-up.
- **Multi-label vanish semantics.** Today `vanished_uids` deletes the local message row entirely (the IMAP-shaped `apply_folder_delta`). Gmail "removed from INBOX but still in SENT" would over-delete. Correct fix: a `remove_from_folder` delta that deletes the `thread_labels` row, not the message — an engine-level change spanning all providers. Documented as a known MVP limitation for Gmail.
- **Threading by `threadId`.** MVP uses the existing local Message-Id threading. Storing `provider_thread_id` and reconciling with Gmail threads is a follow-up (the Kimi plan's §5.4).
- **HTTP-date `Retry-After` parsing.** Task 1 parses delta-seconds; HTTP-date parsing (RFC 7231) is stubbed `None`. Add a real parser if a server is observed sending dates.

## Self-review notes

- **Spec coverage (umbrella spec §10 Phase 3 + §14):** "`GmailApiSource` (History API delta, `history_id` cursor)" → Tasks 2 (cursor) + 4/5 (history delta). "Per-account rate-limit mode" → partially here (Task 7 surfaces `rate_limited` status); the full cross-provider rate-limit *mode* (workstream 3f) is separate. Real-time push is explicitly non-goal (desktop). ✅
- **Kimi plan reuse:** migration SQL shape (adapted — `accounts` already has the OAuth columns, so only `gmail_sync_state` + `provider_message_id` are new), retry classifier + `Retry-After` parsing, label semantics, optimistic token refresh — all adopted. The Kimi plan's frontend-`MailProvider` phases + `MailAction` enum (Phase 6) are **superseded** by the Rust `MailSource` trait + existing `MutationOp` replay. ✅
- **Reuse of Phases 0–2:** `SyncEngine`, `AccountWorker` poll loop, `MutationOp` replay, `apply_folder_delta` (added/updated/flag_updates/vanished + UIDVALIDITY-wipe path reused for 404-expiry), `db::sync_state` cursor pattern, `db::accounts` crypto — all unchanged/consumed. No new sync engine, no new IPC contract beyond optional verify commands. ✅
- **Type consistency:** `Cursor::Gmail` (Task 2) consumed in `sync_folder` (Tasks 4/5) + advanced via `advance_gmail_cursor` (engine EAS-style branch needed — see note below). `RemoteMessage.provider_message_id` (Task 2) populated in `gmail_msg_to_remote` (Task 4) + reverse-read in mutations (Task 6). `GmailMessage`/`HistoryRecord` DTOs (Task 1) consumed by mapping (Tasks 4/5). `flag_label_change` (Task 6) consumed by `set_flags`/`move_messages`. ✅
- **Engine cursor-advance gap (MUST address in Task 2 or a Task 5 sub-step):** `engine.rs::run_sync_round_with_source` currently advances only `Cursor::Imap` (and Phase 3a adds `Cursor::Eas`). A `Cursor::Gmail` branch calling `advance_gmail_cursor` is required — mirror the Phase 3a EAS branch. The implementer must add it; flag in Task 5's commit.
- **Honest MVP limitations:** no batch (N round-trips), no push, no drafts/attachments, multi-label over-delete, no HTTP-date `Retry-After`, no threadId reconciliation — all documented above.

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-06-28-sync-engine-phase3-gmail.md`. Two execution options:

1. **Subagent-Driven (recommended)** — fresh subagent per task, review between tasks.
2. **Inline Execution** — this session via executing-plans, batched with checkpoints.

Which approach?
