# Kylins Mail Sync Engine — Phase 3d: GraphSource (Native Microsoft Graph Provider)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a native **Microsoft Graph** provider (`graph`) to Kylins as a new `MailSource` adapter, so Microsoft accounts (Exchange Online, outlook.com, Microsoft 365) can sync via the Graph REST API with delta-query incremental sync — complementing EAS (which already covers Exchange via the ActiveSync protocol).

**Architecture:** A new `GraphSource` implements the existing `MailSource` trait and plugs into the existing `SyncEngine` via `source_for_account` — structurally identical to `GmailApiSource` (Phase 3c). The engine's 60s poll drives it; **no real-time push** (Graph change notifications need a public HTTPS endpoint — not viable for desktop; documented follow-up). The differentiators vs. Gmail: (1) **delta-query sync** with an opaque `deltaLink` cursor (folder-scoped `/me/mailFolders/{id}/messages/delta`, returns adds + `@removed` deletes in one call — cleaner than Gmail's global History); (2) **structured-JSON send** (`POST /me/sendMail`, not raw MIME) via a composer→Graph message builder; (3) **`Prefer: IdType="ImmutableId"`** on every request; (4) **categories-as-tags** alongside mailFolders. Token refresh + retry mirror the Gmail client (Microsoft token endpoint, Graph error codes).

**Tech Stack:** Rust; `reqwest` 0.12 + `serde` (Graph JSON DTOs); `base64` 0.22 (attachment `contentBytes`); `chrono` 0.4 (**add to `[dependencies]`** — Graph dates are ISO-8601, unlike Gmail's epoch-ms `internalDate`); `sqlx` 0.8 (new `graph_sync_state` table; reuses `messages.provider_message_id` from Phase 3c). Existing `MailSource` trait, `SyncEngine`, `db::sync_state`, `db::messages`, `db::mutations`.

## Authority & cross-validation

- **inbox-zero survey** (read-only, `apps/web/utils/outlook/` + `utils/email/microsoft.ts`): **inbox-zero does NOT use Graph delta** — it paginates (`message.ts:508-524` uses `@odata.nextLink`). So this plan implements delta from the Graph spec, not from inbox-zero. Inbox-zero's reusable Graph patterns: `client.ts:107-235` token refresh (login.microsoftonline.com, 10-min buffer, AADSTS reauth codes); `retry.ts:138-221` error classifier (`429 TooManyRequests/ApplicationThrottled/MailboxConcurrency`, `412 ErrorIrresolvableConflict`, `502-504 ServiceNotAvailable/ServerBusy`, fixed 30s rate-limit backoff); `mail.ts:52-90` sendMail JSON (draft→send for sent-id); `batch.ts` `/$batch` JSON (20/batch); `label.ts` `masterCategories` taxonomy; `folders.ts` well-known folders; `page-token.ts` nextLink host allowlist (graph.microsoft.com/us/de, dod-graph, chinacloud, canary); `Prefer: IdType="ImmutableId"` on every request (`client.ts:36-44`).
- **Microsoft Graph spec:** `/me/mailFolders` (well-known: `inbox`/`sentitems`/`drafts`/`archive`/`deleteditems`/`junkemail`); `/me/mailFolders/{id}/messages/delta` → `{ value:[msg…], "@odata.nextLink"?, "@odata.deltaLink"? }`, deletes marked `"@removed":{"reason":"deleted"|"changed"}`; `/me/sendMail` `{message:{…}, saveToSentItems:true}` (returns 202, no body); `/me/messages/{id}/move` `{destinationId}`; `PATCH /me/messages/{id}` `{isRead}` / `{flag:{flagStatus}}`; `/me/messages/{id}/createReply` `{comment}` for threaded replies. Scopes: `Mail.ReadWrite Mail.Send User.Read MailboxSettings.Read offline_access openid email profile`. Token: `https://login.microsoftonline.com/{tenant|common}/oauth2/v2.0/token`.
- **Our backend (verified):** no Graph code anywhere (grep: zero matches for `graph.microsoft|/me/messages|deltaToken|deltaLink`). `Account` has all OAuth columns; `oauth_refresh_token` HTTP pattern in `src/oauth.rs:329-370`; `messages` gets `provider_message_id` from Phase 3c Task 2 (this plan depends on it — see Global Constraints).
- **Kimi plan** (`2026-06-27-inbox-zero-graph-gmail-provider-migration.md`, Phases 4-5): useful for the `graph_sync_state` table shape + sendMail/`message_builder.rs` concept, but scoped to the old frontend-`MailProvider` architecture. This plan replaces it with a Rust-`MailSource`-native design.

## Global Constraints

- **One new `MailSource` adapter, no new sync engine.** `GraphSource` implements the trait; the existing `SyncEngine` + `MutationOp` replay drive it unchanged. `capabilities()` returns all-`false` (polling-only).
- **`provider == "graph"`** is the dispatch key in `source_for_account`. The existing `outlook` IMAP+XOAuth2 option stays — users choose "Outlook (IMAP)" vs "Outlook (Graph)". (Exchange servers usable via EAS too; Graph is the REST alternative, cleanest for outlook.com.)
- **Depends on Phase 3c's `provider_message_id`.** Graph message ids are also non-numeric (GUIDs/hex). The reversible-id pattern is identical to Gmail: `uid = hash(provider_id)` (FNV), real id in `messages.provider_message_id`, reverse-looked-up in mutations. If Phase 3c Task 2 has NOT landed, **this plan's Task 2 adds the `provider_message_id` column + `RemoteMessage` field** (same migration it adds `graph_sync_state`). If 3c landed first, skip that — just add `graph_sync_state`.
- **Delta cursor is an opaque full `deltaLink` URL.** `Cursor::Graph { delta_link: String }`. First sync (`delta_link` empty) → `/me/mailFolders/{id}/messages/delta` (initial set); steady-state → GET the stored `deltaLink` URL (host-allowlisted). Advance to the response's final `@odata.deltaLink`. On deltaLink expiry (Graph returns an error indicating the token is stale, or the initial-set signal), restart with a fresh initial delta + signal `uidvalidity_changed` so the engine wipes + re-syncs.
- **`Prefer: IdType="ImmutableId"` on every Graph request**, so ids stay stable across delta pages.
- **nextLink/deltaLink host allowlist.** Before following any `@odata.nextLink`/`@odata.deltaLink`, verify the host is in `{graph.microsoft.com, graph.microsoft.us, dod-graph.microsoft.us, graph.microsoft.de, microsoftgraph.chinacloudapi.cn, canary.graph.microsoft.com}`. Reject others (SSRF guard). Allowlist should be configurable at runtime if a national cloud is missing.
- **Token refresh (Microsoft):** `POST https://login.microsoftonline.com/{tenant}/oauth2/v2.0/token` with `grant_type=refresh_token`. Tenant from `account.oauth_provider` (`microsoft` → `common`, or a stored tenant id if we later persist one). Refresh if `token_expires_at` within a 60s skew; force one refresh + retry on `401`. AADSTS `invalid_grant`/reauth codes → surface as permanent auth failure (don't loop).
- **Send is structured JSON**, not MIME. A `message_builder` converts composer fields → Graph `Message`. Replies/forwards use `createReply`/`createReplyAll`/`createForward` (Graph sets `In-Reply-To`/`References`); `sendMail` cannot set those headers itself.
- **Dates need `chrono`.** Graph `receivedDateTime`/`sentDateTime` are ISO-8601. Add `chrono = "0.4"` to `[dependencies]` (already a dev-dep). Map to epoch seconds for `RemoteMessage.date`.
- **No new heavy SDK.** Hand-written `reqwest` + `serde` (matches Gmail/EAS clients). No `graph-rs` crate.
- **Commit cadence:** one commit per task. `cargo test --lib` green at each boundary; `npx tsc --noEmit` + `npx vitest run` for the frontend task.

---

## File Structure

**Backend (Rust) — new module `src/mail/graph/`:**
- `src/mail/graph/mod.rs` — module root + `GraphSource` (`MailSource` impl).
- `src/mail/graph/types.rs` — Graph JSON DTOs (`GraphMessage`, `EmailAddress`, `GraphBody`, `GraphFolder`, `GraphCategory`, `DeltaResponse`, `SendMailRequest`, `MessagePayload` for send).
- `src/mail/graph/client.rs` — `GraphClient` (reqwest + bearer + ImmutableId header + token refresh + `graph_get`/`graph_post`/`graph_patch` + retry classifier + nextLink host allowlist).
- `src/mail/graph/mapping.rs` — pure `graph_msg_to_remote`, `folder_to_remote_folder`, `hash_graph_id`, ISO-date parse (unit-tested).
- `src/mail/graph/message_builder.rs` — composer fields → Graph `Message` JSON (to/cc/bcc/subject/body/attachments).

**Backend — existing files modified:**
- `src/sync_engine/mod.rs` — add `Cursor::Graph { delta_link }` + `Cursor::initial_graph()`; dispatch `"graph"` in `source_for_account`. (If 3c didn't land: also add `provider_message_id` to `RemoteMessage`.)
- `src/db/sync_state.rs` — `get_graph_cursor` / `advance_graph_cursor`.
- `src/db/messages.rs` — (if 3c didn't land) `upsert_message` writes `provider_message_id`; `provider_message_id_for_uid` reverse lookup.
- `src/mail/mod.rs` — `pub mod graph;`.
- `src/lib.rs` — register new `graph_*` commands.
- `migrations/20260628000003_graph_provider.sql` — `graph_sync_state` table (+ `messages.provider_message_id` column IF 3c's migration `20260628000002` didn't land).
- `Cargo.toml` — add `chrono = "0.4"` to `[dependencies]`.

**Frontend:**
- `src/types/index.ts` — add `'graph'` to the provider union.
- `src/services/auth/providers.ts` — `graph` OAuth config (Microsoft scopes).
- `src/services/auth/accountSetupFlows.ts` — `buildGraphAccount`.
- `src/components/account-setup/ProviderPicker.tsx` — "Outlook (Graph)" option.

---

## Task 1: Graph client — DTOs, bearer auth (ImmutableId), token refresh, retry, host allowlist

**Files:** `src/mail/graph/{mod,types,client}.rs`, `src/mail/mod.rs`, `Cargo.toml`

**Interfaces:**
- Produces: `GraphClient::new(account, pool)`, `ensure_token()`, `graph_get/post/patch`, `GraphError` (with `is_rate_limit()`/`is_auth_expired()`/`is_conflict()`/`is_delta_expired()`), `is_allowed_graph_host(&Url) -> bool`.

- [ ] **Step 1: Write failing tests** in `src/mail/graph/client.rs`:

```rust
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn classify_graph_429_rate_limit() {
        let e = GraphError::status(429, "TooManyRequests".into());
        assert!(e.is_rate_limit());
    }
    #[test]
    fn classify_graph_throttling_codes() {
        assert!(GraphError::status(429, "ApplicationThrottled".into()).is_rate_limit());
        assert!(GraphError::status(403, "MailboxConcurrency".into()).is_rate_limit());
    }
    #[test]
    fn classify_graph_412_conflict() {
        let e = GraphError::status(412, "ErrorIrresolvableConflict".into());
        assert!(e.is_conflict());
        assert!(!e.is_rate_limit());
    }
    #[test]
    fn classify_graph_401_auth_expired() {
        assert!(GraphError::status(401, "InvalidAuthenticationToken".into()).is_auth_expired());
    }
    #[test]
    fn classify_graph_410_delta_expired() {
        // Graph signals a stale delta token with 410 Gone (or a resync link).
        assert!(GraphError::status(410, "SyncStateNotFound".into()).is_delta_expired());
    }
    #[test]
    fn host_allowlist_accepts_known_graph_hosts() {
        assert!(is_allowed_graph_host(&"https://graph.microsoft.com/v1.0/me".parse().unwrap()));
        assert!(is_allowed_graph_host(&"https://graph.microsoft.us/v1.0/".parse().unwrap()));
        assert!(!is_allowed_graph_host(&"https://evil.example.com/".parse().unwrap()));
    }
}
```

- [ ] **Step 2: Run — expect FAIL.**

Run: `cargo test --lib mail::graph`

- [ ] **Step 3: Implement.** Add `chrono = "0.4"` to `[dependencies]` in `Cargo.toml`. `src/mail/graph/types.rs`:

```rust
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Deserialize, Default)]
pub struct EmailAddress { #[serde(default)] pub name: String, #[serde(default)] pub address: String }

#[derive(Debug, Clone, Deserialize, Default)]
pub struct Recipient { #[serde(default)] pub email_address: EmailAddress }

#[derive(Debug, Clone, Deserialize, Default)]
pub struct GraphBody { #[serde(default)] pub content_type: String, #[serde(default)] pub content: String }

#[derive(Debug, Clone, Deserialize, Default)]
pub struct ItemFlag { #[serde(default)] pub flag_status: String }

#[derive(Debug, Clone, Deserialize, Default)]
pub struct GraphMessage {
    pub id: String,
    #[serde(default, rename = "conversationId")] pub conversation_id: String,
    #[serde(default)] pub subject: String,
    #[serde(default)] pub body: GraphBody,
    #[serde(default, rename = "bodyPreview")] pub body_preview: String,
    #[serde(default)] pub from: Option<Recipient>,
    #[serde(default, rename = "toRecipients")] pub to_recipients: Vec<Recipient>,
    #[serde(default, rename = "ccRecipients")] pub cc_recipients: Vec<Recipient>,
    #[serde(default, rename = "bccRecipients")] pub bcc_recipients: Vec<Recipient>,
    #[serde(default, rename = "replyTo")] pub reply_to: Vec<Recipient>,
    #[serde(default, rename = "receivedDateTime")] pub received_date_time: String,
    #[serde(default, rename = "sentDateTime")] pub sent_date_time: String,
    #[serde(default, rename = "isRead")] pub is_read: bool,
    #[serde(default)] pub flag: ItemFlag,
    #[serde(default, rename = "hasAttachments")] pub has_attachments: bool,
    #[serde(default, rename = "internetMessageId")] pub internet_message_id: String,
    #[serde(default, rename = "inReplyTo")] pub in_reply_to: String,
    #[serde(default)] pub categories: Vec<String>,
    #[serde(default, rename = "parentFolderId")] pub parent_folder_id: String,
    #[serde(default, rename = "@removed")] pub removed: Option<RemovedReason>,
    #[serde(default, rename = "@odata.etag")] pub etag: Option<String>,
}
#[derive(Debug, Clone, Deserialize, Default)]
pub struct RemovedReason { #[serde(default)] pub reason: String }

#[derive(Debug, Clone, Deserialize, Default)]
pub struct DeltaResponse {
    #[serde(default)] pub value: Vec<GraphMessage>,
    #[serde(default, rename = "@odata.nextLink")] pub next_link: Option<String>,
    #[serde(default, rename = "@odata.deltaLink")] pub delta_link: Option<String>,
}

#[derive(Debug, Clone, Deserialize, Default)]
pub struct GraphFolder {
    pub id: String,
    #[serde(default, rename = "displayName")] pub display_name: String,
    #[serde(default, rename = "parentFolderId")] pub parent_folder_id: String,
    #[serde(default, rename = "totalItemCount")] pub total_item_count: i64,
    #[serde(default, rename = "unreadItemCount")] pub unread_item_count: i64,
    #[serde(default, rename = "wellKnownName")] pub well_known_name: String,
}
#[derive(Debug, Clone, Deserialize, Default)]
pub struct FolderListResponse { #[serde(default)] pub value: Vec<GraphFolder> }

#[derive(Debug, Clone, Deserialize, Default)]
pub struct GraphCategory { pub id: String, #[serde(default, rename = "displayName")] pub display_name: String, #[serde(default)] pub color: String }
#[derive(Debug, Clone, Deserialize, Default)]
pub struct CategoryListResponse { #[serde(default)] pub value: Vec<GraphCategory> }

// ---- Send payload (structured JSON) ----
#[derive(Debug, Clone, Serialize, Default)]
pub struct SendEmailAddress { pub address: String }
#[derive(Debug, Clone, Serialize, Default)]
pub struct SendRecipient { #[serde(rename = "emailAddress")] pub email_address: SendEmailAddress }
#[derive(Debug, Clone, Serialize, Default)]
pub struct SendBody { #[serde(rename = "contentType")] pub content_type: String, pub content: String }
#[derive(Debug, Clone, Serialize, Default)]
pub struct SendAttachment {
    #[serde(rename = "@odata.type")] pub odata_type: String, // "#microsoft.graph.fileAttachment"
    pub name: String,
    #[serde(rename = "contentType")] pub content_type: String,
    #[serde(rename = "contentBytes")] pub content_bytes: String, // base64
}
#[derive(Debug, Clone, Serialize, Default)]
pub struct SendMessage {
    #[serde(skip_serializing_if = "Vec::is_empty", rename = "toRecipients")] pub to_recipients: Vec<SendRecipient>,
    #[serde(skip_serializing_if = "Vec::is_empty", rename = "ccRecipients")] pub cc_recipients: Vec<SendRecipient>,
    #[serde(skip_serializing_if = "Vec::is_empty", rename = "bccRecipients")] pub bcc_recipients: Vec<SendRecipient>,
    #[serde(skip_serializing_if = "Option::is_none")] pub subject: Option<String>,
    pub body: SendBody,
    #[serde(skip_serializing_if = "Vec::is_empty", rename = "replyTo")] pub reply_to: Vec<SendRecipient>,
    #[serde(skip_serializing_if = "Vec::is_empty")] pub attachments: Vec<SendAttachment>,
}
#[derive(Debug, Clone, Serialize)]
pub struct SendMailRequest {
    pub message: SendMessage,
    #[serde(rename = "saveToSentItems")] pub save_to_sent_items: bool,
}
```

`src/mail/graph/client.rs` (token-refresh + retry mirror Gmail; the Graph-specific parts are ImmutableId header, Microsoft endpoint, host allowlist, Graph error codes):

```rust
use reqwest::header::{HeaderMap, HeaderValue, RETRY_AFTER};
use serde::de::DeserializeOwned;
use sqlx::SqlitePool;
use std::time::Duration;
use url::Url; // NOTE: see Step 3 note on the `url` crate.

use crate::db::accounts::{self, Account};
use super::types::*;

const GRAPH_BASE: &str = "https://graph.microsoft.com/v1.0";
const TOKEN_URL_COMMON: &str = "https://login.microsoftonline.com/common/oauth2/v2.0/token";
const SKEW: i64 = 60;

const ALLOWED_GRAPH_HOSTS: &[&str] = &[
    "graph.microsoft.com", "graph.microsoft.us", "dod-graph.microsoft.us",
    "graph.microsoft.de", "microsoftgraph.chinacloudapi.cn", "canary.graph.microsoft.com",
];

pub fn is_allowed_graph_host(u: &Url) -> bool {
    u.host_str().map(|h| ALLOWED_GRAPH_HOSTS.iter().any(|a| *a == h)).unwrap_or(false)
}

#[derive(Debug, Clone)]
pub enum GraphError {
    Status { code: u16, reason: String, retry_after: Option<Duration> },
    Network(String),
    Decode(String),
    Auth(String),
}
impl GraphError {
    pub fn status(code: u16, reason: String) -> Self { GraphError::Status { code, reason, retry_after: None } }
    pub fn is_rate_limit(&self) -> bool {
        match self {
            GraphError::Status { code: 429, .. } => true,
            GraphError::Status { code: 403, reason, .. } => {
                let r = reason.to_ascii_lowercase();
                r.contains("throttl") || r.contains("mailboxconcurrency") || r.contains("tooManyRequests".to_lowercase().as_str())
            }
            _ => false,
        }
    }
    pub fn is_conflict(&self) -> bool {
        matches!(self, GraphError::Status { code: 412, .. })
    }
    pub fn is_auth_expired(&self) -> bool {
        matches!(self, GraphError::Status { code: 401, .. } | GraphError::Auth(_))
    }
    pub fn is_delta_expired(&self) -> bool {
        // 410 Gone / SyncStateNotFound signals a stale delta token -> resync.
        match self {
            GraphError::Status { code: 410, .. } => true,
            GraphError::Status { code: 404, reason, .. } => reason.to_ascii_lowercase().contains("syncstate"),
            _ => false,
        }
    }
    pub fn is_transient(&self) -> bool {
        match self {
            GraphError::Status { code, .. } => (500..600).contains(code) || self.is_rate_limit() || self.is_conflict(),
            GraphError::Network(_) => true,
            _ => false,
        }
    }
    pub fn retry_after(&self) -> Option<Duration> {
        match self { GraphError::Status { retry_after: Some(d), .. } => Some(*d), _ => None }
    }
}

pub struct GraphClient { pub account: Account, pub pool: SqlitePool, http: reqwest::Client }

impl GraphClient {
    pub fn new(account: Account, pool: SqlitePool) -> Self {
        let mut h = HeaderMap::new();
        h.insert("Prefer", HeaderValue::from_static(r#"IdType="ImmutableId""#));
        let http = reqwest::Client::builder().default_headers(h).build().unwrap_or_else(|_| reqwest::Client::new());
        Self { account, pool, http }
    }

    pub async fn ensure_token(&mut self) -> Result<String, GraphError> {
        let needs_refresh = self.account.token_expires_at.map(|e| e <= now_secs() + SKEW).unwrap_or(true);
        if !needs_refresh {
            return self.account.access_token.clone().ok_or_else(|| GraphError::Auth("no access_token".into()));
        }
        self.refresh().await
    }

    async fn refresh(&mut self) -> Result<String, GraphError> {
        let refresh_token = self.account.refresh_token.clone().ok_or_else(|| GraphError::Auth("no refresh_token".into()))?;
        let client_id = self.account.oauth_client_id.clone().ok_or_else(|| GraphError::Auth("no client_id".into()))?;
        let client_secret = self.account.oauth_client_secret.clone().ok_or_else(|| GraphError::Auth("no client_secret".into()))?;
        let form = [
            ("grant_type", "refresh_token"),
            ("refresh_token", &refresh_token),
            ("client_id", &client_id),
            ("client_secret", &client_secret),
            // Microsoft: scope must be the Graph resource, not the original scopes.
            ("scope", "https://graph.microsoft.com/.default offline_access"),
        ];
        let resp = self.http.post(TOKEN_URL_COMMON).form(&form).send().await.map_err(|e| GraphError::Network(e.to_string()))?;
        let status = resp.status();
        let body: serde_json::Value = resp.json().await.map_err(|e| GraphError::Decode(e.to_string()))?;
        if !status.is_success() { return Err(GraphError::Auth(format!("refresh failed: {}", body))); }
        let access = body["access_token"].as_str().unwrap_or("").to_string();
        let exp = body["expires_in"].as_u64().unwrap_or(3600) as i64;
        let new_exp = now_secs() + exp;
        let mut u = crate::db::accounts::AccountUpdates::default();
        u.access_token = Some(access.clone());
        u.token_expires_at = Some(new_exp);
        let _ = accounts::update(&self.pool, &self.account.id, u).await;
        self.account.access_token = Some(access.clone());
        self.account.token_expires_at = Some(new_exp);
        Ok(access)
    }

    pub async fn graph_get<T: DeserializeOwned>(&mut self, path_or_url: &str) -> Result<T, GraphError> {
        self.request("GET", path_or_url, None::<&serde_json::Value>).await
    }
    pub async fn graph_post<T: DeserializeOwned, B: serde::Serialize>(&mut self, path: &str, body: &B) -> Result<T, GraphError> {
        self.request("POST", path, Some(body)).await
    }
    pub async fn graph_patch<T: DeserializeOwned, B: serde::Serialize>(&mut self, path: &str, body: &B) -> Result<T, GraphError> {
        self.request("PATCH", path, Some(body)).await
    }

    async fn request<B: serde::Serialize, T: DeserializeOwned>(
        &mut self, method: &str, path_or_url: &str, body: Option<&B>,
    ) -> Result<T, GraphError> {
        // path_or_url is either a relative path ("/me/...") or a full nextLink/deltaLink URL.
        let url = if path_or_url.starts_with("http") {
            let u: Url = path_or_url.parse().map_err(|e| GraphError::Network(format!("bad url: {e}")))?;
            if !is_allowed_graph_host(&u) { return Err(GraphError::Network("blocked nextLink host".into())); }
            path_or_url.to_string()
        } else {
            format!("{}{}", GRAPH_BASE, path_or_url)
        };
        for attempt in 0..2u8 {
            let token = self.ensure_token().await?;
            let mut req = self.http.request(reqwest::Method::from_bytes(method.as_bytes()).unwrap(), &url).bearer_auth(&token);
            if let Some(b) = body { req = req.json(b); }
            let resp = req.send().await.map_err(|e| GraphError::Network(e.to_string()))?;
            let code = resp.status().as_u16();
            let retry_after = resp.headers().get(RETRY_AFTER).and_then(parse_retry_after);
            if code == 401 && attempt == 0 { self.account.token_expires_at = None; continue; }
            if !(200..300).contains(&code) {
                let reason = resp.text().await.unwrap_or_default();
                return Err(GraphError::Status { code, reason, retry_after });
            }
            if resp.content_length().map(|n| n == 0).unwrap_or(true) && method == "POST" {
                // Graph sendMail/move/etc. return 202 with empty body.
                return serde_json::from_value(serde_json::Value::Null).map_err(|e| GraphError::Decode(e.to_string()));
            }
            return resp.json::<T>().await.map_err(|e| GraphError::Decode(e.to_string()));
        }
        unreachable!()
    }
}

fn parse_retry_after(h: &HeaderValue) -> Option<Duration> {
    let s = h.to_str().ok()?;
    s.trim().parse::<u64>().ok().map(Duration::from_secs) // delta-seconds only (HTTP-date deferred)
}

fn now_secs() -> i64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_secs() as i64
}
```
> **`url` crate note:** `is_allowed_graph_host` uses `url::Url`. If `url` is not a direct dep, it's almost certainly transitive (reqwest pulls it). If `cargo build` flags it, either `use reqwest::Url` (re-export) or `cargo add url`. Prefer the re-export to avoid a new direct dep.

`src/mail/graph/mod.rs`: `pub mod client; pub mod mapping; pub mod message_builder; pub mod types;` and add `pub mod graph;` to `src/mail/mod.rs`.

- [ ] **Step 4: Run — expect PASS** (the six classifier + host tests).

Run: `cargo test --lib mail::graph`

- [ ] **Step 5: Commit** — `feat(graph): GraphClient — DTOs, ImmutableId bearer, token refresh, error classifier, host allowlist`.

---

## Task 2: `Cursor::Graph` + `graph_sync_state` + source wiring (+ `provider_message_id` if 3c absent)

**Files:** `src/sync_engine/mod.rs`, `src/db/sync_state.rs`, `migrations/20260628000003_graph_provider.sql`, `src/mail/graph/mod.rs`, (`src/db/messages.rs`, `src/db/sync_engine/RemoteMessage` if 3c absent)

**Interfaces:**
- Produces: `Cursor::Graph { delta_link }` + `Cursor::initial_graph()`; `db::sync_state::{get_graph_cursor, advance_graph_cursor}`; `source_for_account` dispatches `"graph"`; stub `GraphSource`.

- [ ] **Step 1: Write failing tests.** In `src/db/sync_state.rs` test module:
```rust
#[tokio::test]
async fn graph_cursor_roundtrips_delta_link() {
    let tmp = tempfile::tempdir().unwrap();
    let pool = init_db(tmp.path()).await.unwrap();
    seed(&pool, "a").await;
    assert_eq!(get_graph_cursor(&pool, "a", "inbox").await, Cursor::initial_graph());
    let link = "https://graph.microsoft.com/v1.0/me/mailFolders/1/messages/delta?$deltaToken=abc";
    advance_graph_cursor(&pool, "a", "inbox", link).await.unwrap();
    assert_eq!(get_graph_cursor(&pool, "a", "inbox").await, Cursor::Graph { delta_link: link.into() });
}
```

- [ ] **Step 2: Run — expect FAIL.**

Run: `cargo test --lib db::sync_state`

- [ ] **Step 3: Implement.** Migration `migrations/20260628000003_graph_provider.sql`:
```sql
-- Per-folder Graph delta cursor. The delta_link is an opaque full URL the server issues;
-- we GET it on each steady-state sync and replace it with the response's @odata.deltaLink.
CREATE TABLE IF NOT EXISTS graph_sync_state (
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  folder_path TEXT NOT NULL,
  delta_link TEXT NOT NULL,
  last_sync_at INTEGER DEFAULT (unixepoch()),
  PRIMARY KEY (account_id, folder_path)
);

-- Reversible Graph id store (shared with Gmail/Phase 3c). ONLY add this if Phase 3c's
-- migration 20260628000002 has NOT landed; sqlx ALTER TABLE is idempotent-ish but a
-- second ADD COLUMN of the same name errors — guard with a check or run once.
-- If 3c landed: delete this ALTER from this migration.
-- ALTER TABLE messages ADD COLUMN provider_message_id TEXT;
```

In `src/sync_engine/mod.rs`:
```rust
// add to enum Cursor:
Gmail { history_id: String },        // (from Phase 3c, if present)
Graph { delta_link: String },
// add to impl Cursor:
pub fn initial_graph() -> Self { Cursor::Graph { delta_link: String::new() } }
```
> If `Cursor` doesn't yet have `Gmail` (3c not landed), add only `Graph`. `Cursor::default()` stays the IMAP variant.

`source_for_account` dispatch:
```rust
Ok(match acc.provider.as_str() {
    "imap" => Arc::new(imap_source::ImapSource::new(acc)),
    "eas" => Arc::new(eas_source::EasSource::new(acc)),
    "gmail_api" => Arc::new(gmail_source::GmailApiSource::new(acc, pool.clone())), // if 3c landed
    "graph" => Arc::new(graph_source::GraphSource::new(acc, pool.clone())),
    other => return Err(format!("unsupported provider {other}")),
})
```

In `src/db/sync_state.rs`:
```rust
pub async fn get_graph_cursor(pool: &SqlitePool, account_id: &str, folder_path: &str) -> Cursor {
    let row: Result<Option<(String,)>, _> = sqlx::query_as(
        "SELECT delta_link FROM graph_sync_state WHERE account_id = ? AND folder_path = ?",
    ).bind(account_id).bind(folder_path).fetch_optional(pool).await;
    match row {
        Ok(Some((dl,))) if !dl.is_empty() => Cursor::Graph { delta_link: dl },
        _ => Cursor::initial_graph(),
    }
}
pub async fn advance_graph_cursor(
    pool: &SqlitePool, account_id: &str, folder_path: &str, delta_link: &str,
) -> Result<(), String> {
    sqlx::query(
        "INSERT INTO graph_sync_state (account_id, folder_path, delta_link, last_sync_at)
         VALUES (?, ?, ?, unixepoch())
         ON CONFLICT(account_id, folder_path) DO UPDATE SET
           delta_link = excluded.delta_link, last_sync_at = excluded.last_sync_at",
    ).bind(account_id).bind(folder_path).bind(delta_link).execute(pool).await.map_err(|e| e.to_string())?;
    Ok(())
}
```

Stub `GraphSource` in `src/mail/graph/mod.rs` (mirror the Phase 3c GmailApiSource stub: `capabilities()` all-false, all methods `Err(SourceError::Unsupported)` until Tasks 3-6). It holds `account: Account` + `pool: SqlitePool`.

- [ ] **Step 4: Run — expect PASS.**

Run: `cargo test --lib db::sync_state sync_engine`

- [ ] **Step 5: Commit** — `feat(graph): Cursor::Graph + graph_sync_state + source dispatch`.

---

## Task 3: `list_folders` (mailFolders + masterCategories) + well-known role mapping

**Files:** `src/mail/graph/mapping.rs`, `src/mail/graph/mod.rs`

**Interfaces:**
- Produces: `mapping::folder_to_remote_folder(GraphFolder) -> RemoteFolder`; `GraphSource::list_folders` (`GET /me/mailFolders?$top=100` → folders; categories fetched lazily/deferred for MVP).

- [ ] **Step 1: Write failing tests** in `src/mail/graph/mapping.rs`:
```rust
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn well_known_folder_roles() {
        assert_eq!(role_of_well_known("inbox"), Some("inbox"));
        assert_eq!(role_of_well_known("sentitems"), Some("sent"));
        assert_eq!(role_of_well_known("drafts"), Some("drafts"));
        assert_eq!(role_of_well_known("deleteditems"), Some("trash"));
        assert_eq!(role_of_well_known("junkemail"), Some("junk"));
        assert_eq!(role_of_well_known("archive"), Some("archive"));
        assert_eq!(role_of_well_known(""), None);
    }
    #[test]
    fn folder_maps_id_name_role() {
        let f = folder_to_remote_folder(&GraphFolder {
            id: "AAMk...".into(), display_name: "Inbox".into(),
            well_known_name: "inbox".into(), parent_folder_id: "".into(),
            total_item_count: 5, unread_item_count: 2,
        });
        assert_eq!(f.remote_id, "AAMk...");
        assert_eq!(f.name, "Inbox");
        assert_eq!(f.role.as_deref(), Some("inbox"));
        assert_eq!(f.exists, 5);
        assert_eq!(f.unseen, 2);
    }
    #[test]
    fn hash_graph_id_is_stable() {
        assert_eq!(hash_graph_id("AAMk1"), hash_graph_id("AAMk1"));
        assert_ne!(hash_graph_id("AAMk1"), hash_graph_id("AAMk2"));
    }
}
```

- [ ] **Step 2: Run — expect FAIL.**

Run: `cargo test --lib mail::graph::mapping`

- [ ] **Step 3: Implement.** `src/mail/graph/mapping.rs`:
```rust
use crate::sync_engine::RemoteFolder;
use super::types::*;

pub fn role_of_well_known(well_known: &str) -> Option<&'static str> {
    match well_known.to_ascii_lowercase().as_str() {
        "inbox" => Some("inbox"),
        "sentitems" | "sentmail" => Some("sent"),
        "drafts" => Some("drafts"),
        "deleteditems" => Some("trash"),
        "junkemail" => Some("junk"),
        "archive" => Some("archive"),
        _ => None,
    }
}
fn special_use_for(well_known: &str) -> Option<String> {
    match role_of_well_known(well_known) {
        Some("inbox") => Some("\\Inbox".into()),
        Some("sent") => Some("\\Sent".into()),
        Some("drafts") => Some("\\Drafts".into()),
        Some("trash") => Some("\\Trash".into()),
        Some("junk") => Some("\\Junk".into()),
        Some("archive") => Some("\\Archive".into()),
        _ => None,
    }
}
pub fn folder_to_remote_folder(f: &GraphFolder) -> RemoteFolder {
    RemoteFolder {
        remote_id: f.id.clone(),
        name: f.display_name.clone(),
        delimiter: "/".into(),
        special_use: special_use_for(&f.well_known_name),
        role: role_of_well_known(&f.well_known_name).map(String::from),
        parent_id: if f.parent_folder_id.is_empty() { None } else { Some(f.parent_folder_id.clone()) },
        exists: f.total_item_count as u32,
        unseen: f.unread_item_count as u32,
    }
}
pub fn hash_graph_id(id: &str) -> u32 {
    id.bytes().fold(0u32, |a, b| a.wrapping_mul(31).wrapping_add(b as u32))
}
```

`GraphSource::list_folders` in `src/mail/graph/mod.rs`:
```rust
async fn list_folders(&self) -> Result<Vec<RemoteFolder>, SourceError> {
    let mut c = GraphClient::new(self.account.clone(), self.pool.clone());
    let resp: FolderListResponse = c.graph_get("/me/mailFolders?$top=100").await
        .map_err(|e| SourceError::Other(e.to_string()))?;
    Ok(resp.value.iter().map(folder_to_remote_folder).collect())
    // Categories (masterCategories taxonomy) are fetched as tags in a follow-up; MVP = folders only.
}
```
(import `GraphClient`, DTOs, `mapping::folder_to_remote_folder`.)

- [ ] **Step 4: Run — expect PASS.**

Run: `cargo test --lib mail::graph`

- [ ] **Step 5: Commit** — `feat(graph): list_folders via mailFolders + well-known role mapping`.

---

## Task 4: `sync_folder` — delta query (first + steady) + `@removed` + Graph→RemoteMessage + deltaLink-expiry resync

**Files:** `src/mail/graph/mapping.rs`, `src/mail/graph/mod.rs`

**Interfaces:**
- Produces: `mapping::graph_msg_to_remote(&GraphMessage, folder) -> RemoteMessage`; `GraphSource::sync_folder` runs the delta loop (initial vs steady via `Cursor::Graph`), maps `@removed` → `vanished_uids`, advances the deltaLink cursor, and signals full resync on delta-expiry.

- [ ] **Step 1: Write failing test** in `mapping.rs`:
```rust
#[test]
fn graph_msg_maps_structured_fields_and_iso_date() {
    let m = GraphMessage {
        id: "A1".into(), conversation_id: "C1".into(), subject: "Hello".into(),
        body: GraphBody { content_type: "html".into(), content: "<p>Hi</p>".into() },
        body_preview: "Hi".into(),
        from: Some(Recipient { email_address: EmailAddress { name: "Alice".into(), address: "a@b.com".into() } }),
        to_recipients: vec![Recipient { email_address: EmailAddress { name: "".into(), address: "me@x.com".into() } }],
        received_date_time: "2023-01-01T00:00:00Z".into(),
        is_read: true, has_attachments: true,
        internet_message_id: "<m@x>".into(), categories: vec!["Work".into()],
        ..Default::default()
    };
    let r = graph_msg_to_remote(&m, "inbox");
    assert_eq!(r.uid, hash_graph_id("A1"));
    assert_eq!(r.provider_message_id.as_deref(), Some("A1"));
    assert_eq!(r.subject.as_deref(), Some("Hello"));
    assert_eq!(r.from_address.as_deref(), Some("a@b.com"));
    assert_eq!(r.to_addresses.as_deref(), Some("me@x.com"));
    assert!(r.is_read);
    assert!(r.has_attachments);
    assert_eq!(r.body_html.as_deref(), Some("<p>Hi</p>"));
    assert_eq!(r.date, 1_672_531_200); // 2023-01-01T00:00:00Z in epoch seconds
}

#[test]
fn graph_iso_date_parses_or_zero() {
    assert_eq!(parse_iso_epoch("2023-01-01T00:00:00Z"), Some(1_672_531_200));
    assert_eq!(parse_iso_epoch(""), None);
    assert_eq!(parse_iso_epoch("garbage"), None);
}
```

- [ ] **Step 2: Run — expect FAIL.**

Run: `cargo test --lib mail::graph::mapping`

- [ ] **Step 3: Implement.** In `mapping.rs`:
```rust
use chrono::{DateTime, Utc};

pub fn parse_iso_epoch(s: &str) -> Option<i64> {
    if s.is_empty() { return None; }
    DateTime::parse_from_rfc3339(s).ok()
        .map(|dt| dt.with_timezone(&Utc).timestamp())
}

pub fn graph_msg_to_remote(m: &GraphMessage, folder: &str) -> crate::sync_engine::RemoteMessage {
    use crate::sync_engine::RemoteMessage;
    let join = |rs: &[Recipient]| -> Option<String> {
        let parts: Vec<String> = rs.iter().filter_map(|r| {
            let a = &r.email_address.address;
            if a.is_empty() { None } else if r.email_address.name.is_empty() { Some(a.clone()) }
            else { Some(format!("{} <{}>", r.email_address.name, a)) }
        }).collect();
        if parts.is_empty() { None } else { Some(parts.join(", ")) }
    };
    let from = m.from.as_ref();
    let body_html = if m.body.content_type.eq_ignore_ascii_case("html") && !m.body.content.is_empty() { Some(m.body.content.clone()) } else { None };
    let body_text = if m.body.content_type.eq_ignore_ascii_case("text") && !m.body.content.is_empty() { Some(m.body.content.clone()) } else { None };
    RemoteMessage {
        uid: hash_graph_id(&m.id),
        folder: folder.to_string(),
        message_id: if m.internet_message_id.is_empty() { None } else { Some(m.internet_message_id.clone()) },
        provider_message_id: Some(m.id.clone()),
        in_reply_to: if m.in_reply_to.is_empty() { None } else { Some(m.in_reply_to.clone()) },
        references: None, // Graph doesn't expose References array in the default $select; follow-up.
        from_address: from.map(|r| r.email_address.address.clone()).filter(|s| !s.is_empty()),
        from_name: from.and_then(|r| if r.email_address.name.is_empty() { None } else { Some(r.email_address.name.clone()) }),
        to_addresses: join(&m.to_recipients),
        cc_addresses: join(&m.cc_recipients),
        bcc_addresses: join(&m.bcc_recipients),
        reply_to: join(&m.reply_to),
        subject: if m.subject.is_empty() { None } else { Some(m.subject.clone()) },
        snippet: if m.body_preview.is_empty() { None } else { Some(m.body_preview.clone()) },
        date: parse_iso_epoch(&m.received_date_time)
            .or_else(|| parse_iso_epoch(&m.sent_date_time))
            .unwrap_or(0),
        is_read: m.is_read,
        is_starred: m.flag.flag_status.eq_ignore_ascii_case("flagged"),
        is_draft: false, // Graph marks drafts via the drafts folder, not a flag; derived from parentFolderId in a follow-up.
        body_html,
        body_text,
        raw_size: 0,
        has_attachments: m.has_attachments,
        ..Default::default()
    }
}
```

Delta loop in `GraphSource::sync_folder` (`src/mail/graph/mod.rs`):
```rust
async fn sync_folder(&self, folder: &RemoteFolder, since: Cursor) -> Result<FolderDelta, SourceError> {
    let mut c = GraphClient::new(self.account.clone(), self.pool.clone());
    let folder_id = folder.remote_id.clone();

    // First call: relative path (initial delta). Steady-state: the stored deltaLink URL.
    let start: String = match &since {
        Cursor::Graph { delta_link } if !delta_link.is_empty() => delta_link.clone(),
        _ => format!("/me/mailFolders/{}/messages/delta?$select=id,subject,bodyPreview,from,toRecipients,ccRecipients,receivedDateTime,sentDateTime,isRead,flag,hasAttachments,internetMessageId,inReplyTo,categories,parentFolderId", folder_id),
    };

    let mut added: Vec<RemoteMessage> = Vec::new();
    let mut vanished_uids: Vec<u32> = Vec::new();
    let mut next = Some(start);
    let mut final_delta_link: Option<String> = None;

    while let Some(url) = next {
        let resp: DeltaResponse = match c.graph_get(&url).await {
            Ok(r) => r,
            Err(e) if e.is_delta_expired() => {
                // Stale delta token: wipe + re-bootstrap from initial delta.
                return Ok(FolderDelta {
                    added: vec![], updated: vec![], flag_updates: vec![], vanished_uids: vec![],
                    next_cursor: Cursor::Graph { delta_link: String::new() },
                    uidvalidity_changed: true,
                });
            }
            Err(e) => return Err(SourceError::Other(e.to_string())),
        };
        for m in &resp.value {
            if m.removed.is_some() {
                vanished_uids.push(hash_graph_id(&m.id));
            } else {
                added.push(graph_msg_to_remote(m, &folder_id));
            }
        }
        final_delta_link = resp.delta_link.clone().or(final_delta_link);
        next = resp.next_link; // already host-allowlisted inside graph_get
    }

    let new_link = final_delta_link.unwrap_or_default();
    Ok(FolderDelta {
        added,
        updated: vec![], flag_updates: vec![], vanished_uids,
        next_cursor: Cursor::Graph { delta_link: new_link },
        uidvalidity_changed: false,
    })
}
```
> **Engine cursor-advance:** `engine.rs::run_sync_round_with_source` must advance `Cursor::Graph` via `advance_graph_cursor` — mirror the IMAP/EAS/Gmail branches. Add it in this task's commit (and note it covers `Cursor::Gmail` too if 3c landed).

- [ ] **Step 4: Run — expect PASS.**

Run: `cargo test --lib mail::graph`

- [ ] **Step 5: Commit** — `feat(graph): sync_folder delta query + @removed + Graph→RemoteMessage + deltaLink resync`.

---

## Task 5: Mutations (PATCH isRead/flag, move, delete) + fetch_body

**Files:** `src/mail/graph/mapping.rs`, `src/mail/graph/mod.rs`

**Interfaces:**
- Produces: `set_flags` (`PATCH /me/messages/{id}` isRead / flag), `move_messages` (`POST /me/messages/{id}/move`), `delete_messages` (`POST /me/messages/{id}/move` → deleteditems), `fetch_body` (`GET /me/messages/{id}?$select=body`). Reverse-resolve uid → provider_message_id.

- [ ] **Step 1: Write failing test** (flag → PATCH body shape, pure, in `mapping.rs`):
```rust
#[test]
fn flag_patch_body() {
    assert_eq!(is_read_patch(true), serde_json::json!({"isRead": true}));
    assert_eq!(flag_patch(true), serde_json::json!({"flag":{"flagStatus":"flagged"}}));
    assert_eq!(flag_patch(false), serde_json::json!({"flag":{"flagStatus":"notFlagged"}}));
}
```

- [ ] **Step 2: Run — expect FAIL.**

Run: `cargo test --lib mail::graph::mapping`

- [ ] **Step 3: Implement.** In `mapping.rs`:
```rust
pub fn is_read_patch(read: bool) -> serde_json::Value {
    serde_json::json!({ "isRead": read })
}
pub fn flag_patch(flagged: bool) -> serde_json::Value {
    serde_json::json!({ "flag": { "flagStatus": if flagged { "flagged" } else { "notFlagged" } } })
}
```

In `GraphSource` (`src/mail/graph/mod.rs`), the mutation methods (reverse-resolve like Gmail):
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
    let mut c = GraphClient::new(self.account.clone(), self.pool.clone());
    for id in self.resolve_ids(folder, uids).await {
        let body = match flag {
            "read" => is_read_patch(add),
            "starred" | "flagged" => flag_patch(add),
            _ => continue,
        };
        let _: serde_json::Value = c.graph_patch(&format!("/me/messages/{}", id), &body).await
            .map_err(|e| SourceError::Other(e.to_string()))?;
    }
    Ok(())
}
async fn move_messages(&self, src: &RemoteFolder, uids: &[u32], dest: &RemoteFolder) -> Result<(), SourceError> {
    if uids.is_empty() { return Ok(()); }
    let mut c = GraphClient::new(self.account.clone(), self.pool.clone());
    let body = serde_json::json!({ "destinationId": dest.remote_id });
    for id in self.resolve_ids(src, uids).await {
        let _: serde_json::Value = c.graph_post(&format!("/me/messages/{}/move", id), &body).await
            .map_err(|e| SourceError::Other(e.to_string()))?;
    }
    Ok(())
}
async fn delete_messages(&self, folder: &RemoteFolder, uids: &[u32]) -> Result<(), SourceError> {
    if uids.is_empty() { return Ok(()); }
    let mut c = GraphClient::new(self.account.clone(), self.pool.clone());
    let body = serde_json::json!({ "destinationId": "deleteditems" });
    for id in self.resolve_ids(folder, uids).await {
        let _: serde_json::Value = c.graph_post(&format!("/me/messages/{}/move", id), &body).await
            .map_err(|e| SourceError::Other(e.to_string()))?;
    }
    Ok(())
}
async fn fetch_body(&self, folder: &RemoteFolder, uid: u32) -> Result<Option<String>, SourceError> {
    let pid = crate::db::messages::provider_message_id_for_uid(&self.pool, &self.account.id, &folder.remote_id, uid).await
        .map_err(|e| SourceError::Other(e.to_string()))?
        .ok_or_else(|| SourceError::Other(format!("no provider_message_id for uid {uid}")))?;
    let mut c = GraphClient::new(self.account.clone(), self.pool.clone());
    let m: GraphMessage = c.graph_get(&format!("/me/messages/{}?$select=body", pid)).await
        .map_err(|e| SourceError::Other(e.to_string()))?;
    if m.body.content_type.eq_ignore_ascii_case("html") { Ok(Some(m.body.content)) }
    else { Ok(Some(m.body.content)) }
}
async fn append(&self, _folder: &RemoteFolder, _raw: &[u8], _flags: &[&str]) -> Result<(), SourceError> {
    Err(SourceError::Unsupported) // Graph drafts use POST /me/messages; follow-up.
}
```

- [ ] **Step 4: Run — expect PASS.**

Run: `cargo test --lib mail::graph`

- [ ] **Step 5: Commit** — `feat(graph): mutations (PATCH/move/trash) + fetch_body`.

---

## Task 6: Send (structured JSON) — `message_builder` + sendMail + createReply/createForward

**Files:** `src/mail/graph/message_builder.rs`, `src/mail/graph/mod.rs`

**Interfaces:**
- Produces: `message_builder::build_send_message(to,cc,bcc,subject,html,attachments) -> SendMessage`; `GraphSource::send` (`POST /me/sendMail`); a `graph_create_reply` path using `createReply` (documented for the composer reply flow).

- [ ] **Step 1: Write failing test** in `message_builder.rs`:
```rust
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn builds_send_message_with_recipients_and_html_body() {
        let m = build_send_message(
            &["a@b.com".into(), "c@d.com".into()],
            &["e@f.com".into()],
            &[],
            "Hello",
            "<p>Body</p>",
            &[],
        );
        assert_eq!(m.to_recipients.len(), 2);
        assert_eq!(m.to_recipients[0].email_address.address, "a@b.com");
        assert_eq!(m.cc_recipients.len(), 1);
        assert_eq!(m.subject.as_deref(), Some("Hello"));
        assert_eq!(m.body.content_type, "HTML");
        assert_eq!(m.body.content, "<p>Body</p>");
        assert!(m.attachments.is_empty());
    }

    #[test]
    fn attachment_is_fileattachment_with_base64() {
        let att = Attachment { filename: "x.txt".into(), mime_type: "text/plain".into(), data: b"hi".to_vec() };
        let m = build_send_message(&["a@b.com".into()], &[], &[], "S", "<p>b</p>", &[att]);
        assert_eq!(m.attachments.len(), 1);
        assert_eq!(m.attachments[0].odata_type, "#microsoft.graph.fileAttachment");
        assert_eq!(m.attachments[0].content_bytes, base64_std(b"hi"));
    }
}
```
(`base64_std` is a tiny test helper wrapping `base64::engine::general_purpose::STANDARD.encode`.)

- [ ] **Step 2: Run — expect FAIL.**

Run: `cargo test --lib mail::graph::message_builder`

- [ ] **Step 3: Implement.** `src/mail/graph/message_builder.rs`:
```rust
use base64::Engine;
use super::types::*;
use super::client::base64url_encode; // reuse from 3c Gmail, or define a STANDARD encoder here

pub struct Attachment { pub filename: String, pub mime_type: String, pub data: Vec<u8> }

fn recip(addr: &str) -> SendRecipient {
    SendRecipient { email_address: SendEmailAddress { address: addr.to_string() } }
}

pub fn build_send_message(
    to: &[String], cc: &[String], bcc: &[String],
    subject: &str, html: &str, attachments: &[Attachment],
) -> SendMessage {
    SendMessage {
        to_recipients: to.iter().map(|a| recip(a)).collect(),
        cc_recipients: cc.iter().map(|a| recip(a)).collect(),
        bcc_recipients: bcc.iter().map(|a| recip(a)).collect(),
        subject: if subject.is_empty() { None } else { Some(subject.to_string()) },
        body: SendBody { content_type: "HTML".into(), content: html.to_string() },
        reply_to: vec![],
        attachments: attachments.iter().map(|a| SendAttachment {
            odata_type: "#microsoft.graph.fileAttachment".into(),
            name: a.filename.clone(),
            content_type: a.mime_type.clone(),
            content_bytes: base64::engine::general_purpose::STANDARD.encode(&a.data),
        }).collect(),
    }
}
```

`GraphSource::send` in `src/mail/graph/mod.rs`:
```rust
async fn send(&self, raw_b64url_or_json: &str) -> Result<(), SourceError> {
    // The trait's send() takes a base64url raw-MIME string (Gmail/IMAP contract).
    // For Graph we can't send raw MIME via sendMail. The composer must call the
    // dedicated `graph_send_message` command (below) for Graph accounts. As a fallback,
    // if a raw MIME is passed, decode it and best-effort parse into SendMessage.
    // MVP: surface Unsupported from the trait path; real send goes through graph_send_message.
    Err(SourceError::Unsupported)
}
```
> **Send routing note:** Graph can't honor the trait's raw-MIME `send()` contract. Add a dedicated Tauri command that the composer calls for `graph` accounts:
```rust
#[tauri::command]
pub async fn graph_send_message(
    state: tauri::State<'_, AppState>, account_id: String,
    to: Vec<String>, cc: Vec<String>, bcc: Vec<String>,
    subject: String, html: String,
    attachments: Vec<message_builder::Attachment>,
) -> Result<(), String> {
    let acc = crate::db::accounts::get_by_id(&state.pool, &account_id).await?.ok_or("no account")?;
    let mut c = GraphClient::new(acc, state.pool.clone());
    let msg = message_builder::build_send_message(&to, &cc, &bcc, &subject, &html, &attachments);
    let req = SendMailRequest { message: msg, save_to_sent_items: true };
    let _: serde_json::Value = c.graph_post("/me/sendMail", &req).await.map_err(|e| e.to_string())?;
    Ok(())
}
```
Register `graph_send_message` in `src/lib.rs` `generate_handler!`. The composer's send branch (frontend `composer/send.ts`) calls `invoke('graph_send_message', …)` when `provider === 'graph'`, else the existing `sync_apply_mutation`/SMTP path. (Replies: `POST /me/messages/{id}/createReply` → returns draft → PATCH body → `POST /me/messages/{draftId}/send`; a follow-up command `graph_reply` if the composer needs server-threaded replies.)

- [ ] **Step 4: Run — expect PASS.**

Run: `cargo test --lib mail::graph`

- [ ] **Step 5: Commit** — `feat(graph): structured sendMail via message_builder + graph_send_message`.

---

## Task 7: Frontend account setup (`graph`) + retry polish + regression

**Files:** `src/types/index.ts`, `src/services/auth/providers.ts`, `src/services/auth/accountSetupFlows.ts`, `src/components/account-setup/ProviderPicker.tsx`, `src/services/composer/send.ts`, `src/mail/graph/client.rs` (retry), `src/lib.rs` (commands)

**Interfaces:**
- Produces: an "Outlook (Graph)" setup option (Microsoft OAuth, Graph scopes); `GraphClient` bounded retry (429/412/5xx, `Retry-After`, Microsoft's fixed-30s rate-limit backoff); composer send branches to `graph_send_message` for `graph` accounts; full regression green.

- [ ] **Step 1: Frontend — add the provider.** In `src/types/index.ts`, add `'graph'` to the provider union. In `src/services/auth/providers.ts`, add a `graph` config: authorization endpoint `https://login.microsoftonline.com/common/oauth2/v2.0/authorize`, token endpoint `…/token`, scopes `openid email profile User.Read Mail.ReadWrite Mail.Send MailboxSettings.Read offline_access`. In `src/services/auth/accountSetupFlows.ts`, add `buildGraphAccount(tokens)` setting `provider: 'graph'`, `oauth_provider: 'microsoft'`, encrypted tokens, `token_expires_at`. In `ProviderPicker.tsx`, add "Outlook (Graph)" alongside "Outlook (IMAP)" and "Exchange (EAS)".

- [ ] **Step 2: Composer send branch.** In `src/services/composer/send.ts` (create if absent), branch on `account.provider`: `'graph'` → `invoke('graph_send_message', { accountId, to, cc, bcc, subject, html, attachments })`; else the existing SMTP/`sync_apply_mutation` path.

- [ ] **Step 3: Backend — bounded retry in `GraphClient::request`.** Wrap the single 401-retry loop with a transient-retry loop: on `is_transient()`/`is_rate_limit()`/`is_conflict()`, sleep `retry_after().unwrap_or_else(backoff_for_class)` (rate-limit: fixed 30s; conflict: `500ms*2^n` cap 8s; server: `5s*2^n` cap 80s), up to ~5 attempts total, `Retry-After` honored and capped at 30s for desktop responsiveness. Emit `sync:status { state: "rate_limited" }` best-effort on a rate-limit hit. Keep the Task 1 classifier as the single source of truth.

- [ ] **Step 4: Backend — register commands.** In `src/lib.rs` `generate_handler!`, register `graph_send_message` (+ `graph_test_connection` → `GET /me` if account-setup's verify step needs one).

- [ ] **Step 5: Run full regression.**

```bash
cd kylins.client.backend && cargo test --lib
cd ../kylins.client.frontend && npx tsc --noEmit && npx vitest run
```
Expected: backend green (adds ~10 unit tests); frontend tsc 0 + vitest green.

- [ ] **Step 6: Note manual e2e** (user runs `cargo tauri dev` with a real Microsoft account):
  1. Add an "Outlook (Graph)" account via OAuth; mailFolders populate.
  2. Inbox initial delta backfills messages.
  3. Within one poll (≤60s), changes made in Outlook Web appear in Kylins (delta).
  4. Delete in Outlook Web → message vanishes in Kylins (`@removed` delta).
  5. Mark read/flag in Kylins → reflected server-side (PATCH).
  6. Send from the composer → arrives in Sent (`sendMail` + `saveToSentItems`).
  7. Leave offline >7 days → next sync hits delta-expiry → full re-bootstrap (no crash).

- [ ] **Step 7: Commit** any fixes; update `.superpowers/sdd/progress.md` with the Phase 3d entry.

---

## Deferred Follow-Ups (documented, NOT in this plan's scope)

- **Shared OAuth-HTTP backbone (DRY with Gmail).** `GraphClient` and `GmailClient` (Phase 3c) duplicate ~80 lines (bearer auth, token refresh, retry loop). After both 3c and 3d land, factor a `OAuthHttpClient`/`TokenManager` they both wrap, with per-provider error-classifier + endpoint config. Don't do it with only one provider (YAGNI).
- **Categories as tags.** `/me/outlook/masterCategories` taxonomy + `message.categories` should map into the unified `labels` table (source `graph`, distinct from mailFolders). MVP syncs folders only; categories are a follow-up task.
- **Real-time push (Graph change notifications).** Needs a public HTTPS notification endpoint (or a hosted relay + 3-day subscription renewal watchdog — `subscription-manager.ts`). Desktop can't host it directly. Polling (60s) is the MVP.
- **Batch.** `/$batch` JSON (20/batch) for bulk flag/move — pure latency optimization.
- **Threading via `conversationId` / `createReply`.** MVP send is new-message `sendMail`; server-threaded replies (`createReply`/`createReplyAll`/`createForward` → PATCH → send) are a follow-up composer command. Local `conversationId` reconciliation is a follow-up.
- **`References` header.** Graph doesn't return `References` in the default `$select`; JWZ-style threading uses `internetMessageId`/`inReplyTo` only for MVP.
- **Drafts.** `POST /me/messages` (draft) + `POST /me/messages/{id}/send`; a separate drafts feature surface.
- **Attachments >3MB.** Direct `contentBytes` caps at ~3MB; upload-session chunked PUT handles up to 150MB — follow-up.
- **`deltaLink` `@removed` reason.** MVP treats any `@removed` as a vanish; distinguishing `"changed"` (moved out of delta scope) vs `"deleted"` for the multi-folder over-delete caveat is a follow-up (same caveat as Gmail 3c).
- **National-cloud / tenant-specific endpoints.** `login.microsoftonline.com/common` is MVP; persisting a tenant id and using `…/{tenant}/…` is a follow-up for enterprise accounts.

## Self-review notes

- **Spec coverage (umbrella spec §10 Phase 3 + §14):** "`GraphSource` (delta token)" → Tasks 2 (cursor) + 4 (delta query). Real-time push is explicitly non-goal. ✅
- **inbox-zero delta gap:** inbox-zero does NOT use Graph delta (it paginates). This plan implements delta from the Graph spec — a place where Kylins improves on inbox-zero's approach. inbox-zero's reusable pieces (token refresh, error classifier, host allowlist, sendMail shape, ImmutableId, categories) are all adopted. ✅
- **Reuse of Phases 0–2 + 3c:** `SyncEngine`, `MutationOp` replay, `apply_folder_delta` (added/vanished + UIDVALIDITY-wipe reused for delta-expiry), `db::sync_state` cursor pattern, `provider_message_id` (shared with 3c), `db::accounts` crypto. No new sync engine. ✅
- **Type consistency:** `Cursor::Graph` (Task 2) consumed in `sync_folder` (Task 4) + advanced via `advance_graph_cursor` (engine branch). `RemoteMessage.provider_message_id` populated in `graph_msg_to_remote` (Task 4) + reverse-read in mutations (Task 5). `GraphMessage`/`DeltaResponse` (Task 1) consumed by mapping (Task 4). `SendMessage`/`SendMailRequest` (Task 1) built by `message_builder` (Task 6) + sent by `graph_send_message` (Task 6). `is_read_patch`/`flag_patch` (Task 5) consumed by `set_flags`. ✅
- **Engine cursor-advance gap (MUST address in Task 4 commit):** `engine.rs::run_sync_round_with_source` needs a `Cursor::Graph` branch calling `advance_graph_cursor` (and `Cursor::Gmail` if 3c landed). Flagged in Task 4.
- **Priority honesty:** Graph overlaps with EAS for Exchange (3a/3b). Graph's distinct value = outlook.com personal accounts + cleaner REST + categories. If the target is Exchange Online only, EAS suffices and 3d is lower priority than 3c (Gmail). Documented in the plan header.
- **Honest MVP limitations:** no categories-as-tags, no push, no batch, no createReply threading, no drafts, >3MB attachments, multi-folder `@removed` over-delete caveat, common-tenant-only — all documented.

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-06-28-sync-engine-phase3-graph.md`. Two execution options:

1. **Subagent-Driven (recommended)** — fresh subagent per task, review between tasks.
2. **Inline Execution** — this session via executing-plans, batched with checkpoints.

Which approach?
