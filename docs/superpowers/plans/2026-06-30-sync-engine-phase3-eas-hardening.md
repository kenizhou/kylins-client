# Kylins Mail Sync Engine — Phase 3b: EAS Hardening

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. Each task is self-contained, ends with `cargo test --lib` green, and is one commit.

**Goal:** Unblock EAS against real Exchange Online tenants by closing the four MVP-critical gaps the Phase 3a client left open: (1) protocol status codes are still stringly-typed `u32`s with ad-hoc recovery in two places; (2) Provision is not implemented so any tenant enforcing EAS policy returns status 142/143/144 and wedges; (3) only Basic auth is wired, so modern-auth (OAuth2) tenants cannot connect; (4) there is no AutoDiscover, so the user must hand-enter the EAS URL. This plan delivers a typed status layer, the two-phase Provision handshake, OAuth Bearer auth (with refresh-on-401), and V1 POX + V2 JSON AutoDiscover — the minimum to make `EasSource.sync_folder` actually complete a round trip against Exchange Online.

**Architecture:** Four narrow modules added under `src/eas/`, each independently testable, wired into the existing transport (`client.rs`) at the end:

- `status.rs` — typed enums (`CommonStatus`, `SyncStatus`, `FolderSyncStatus`, `PingStatus`, `ProvisionStatus`) + a single `recovery_action(...) -> RecoveryAction` decision function. Pure, no I/O. Phase 3a's `classify_collection_status` in `eas_source.rs` is refactored to delegate here so there is exactly one place that maps status → action.
- `provision.rs` — WBXML marshalers for the Provision command (Phase-1 policy request + Phase-2 ack) and a `provision_and_persist` orchestrator on `EasClient` that runs the handshake and writes the permanent policy key back into `EasConfig` (the source-layer caller persists it to `accounts.eas_policy_key` via the existing `UpdateAccount` setter).
- `oauth.rs` (EAS-local) — `EasAuth` enum (`Basic` | `OAuth { access_token, refresh_token, client_id, client_secret, token_url, scope }`), a `refresh()` helper that mirrors `crate::oauth::oauth_refresh_token`, and an `authorization_header()` method used by the transport.
- `autodiscover.rs` — V1 POX (`POST /autodiscover/autodiscover.xml` mobilesync envelope → parse `<Server><Url>`) with up to 3 redirect hops, V2 JSON (`https://autodisver-s.outlook.com/autodiscover/autodiscover.json?Email=...`) fallback.

The retry/provision/refresh orchestration is wired into `client.rs::send_command` as a **single retry layer** (one retry per command, classified by `recovery_action`), not a middleware tower. Status 142/143/144 → run Provision then retry; HTTP 401 with OAuth → refresh then retry; HTTP 429/5xx → fail back to the caller (the engine's existing 60s poll is the retry). One retry keeps the code simple and bounds latency.

**Tech Stack:** Rust (existing `eas::client`, `eas::commands`, `eas::wbxml` codec — unchanged, `eas::types`), `reqwest` (already a dep), `quick-xml` for the AutoDiscover POX/JSON parsing (NEW minimal dep — see Task 5 justification), `serde` (already a dep), `sqlx` (already a dep) + new migration file for `accounts.auth_type`. No WBXML codec changes. No frontend changes (the `accounts` table columns are read by the existing `Account` mapper once a new field is added).

---

## Global Constraints

- **Do NOT touch the WBXML codec** (`eas/wbxml/`). Use the existing `WbxmlElement` API (`WbxmlElement::container(page, token, children)`, `WbxmlElement::text(page, token, &str)`, `WbxmlElement::empty(page, token)`, `element.tag_name()`, `element.children`, `element.value`) and the existing `tags::provision::*` / `tags::pages::PROVISION` constants from `eas/wbxml/tags.rs`. Phase 3a proved this surface is sufficient.
- **One retry per command.** `send_command` calls the underlying transport at most twice: original + one classified retry (Provision after 142/143/144, token-refresh after 401-on-OAuth, redirect-follow after 451). Throttling (429) and 5xx are surfaced, not retried inline — the sync engine's 60s poll is the retry. This bounds tail latency and avoids tight loops.
- **X-MS-PolicyKey header always sent.** Already the case in `client.rs` (sends `"0"` when `policy_key` is empty). Provision persists the real key into `EasConfig.policy_key`; subsequent commands then send it. The field already exists on `EasConfig` and `accounts.eas_policy_key` — Task 1 just starts populating it.
- **Basic stays the default.** `EasAuth::Basic { username, password }` is the fallback when `auth_type` is null/`"basic"`. OAuth is opt-in via `auth_type = "oauth"`. No existing basic-auth code path is broken.
- **No new secrets handling.** OAuth `access_token` / `refresh_token` reuse the existing `accounts.access_token` / `accounts.refresh_token` columns (already encrypted-at-rest via `crypto::encrypt`). The `eas_policy_key` is not a secret (server-issued device token) and stays plaintext — matches existing column.
- **Migration pattern:** sqlx embedded migrations, new file `migrations/<TS>_add_accounts_auth_type.sql`. The baseline is a single consolidated `IF NOT EXISTS` snapshot; new schema changes go in numbered files (standard sqlx workflow).
- **No RemoteWipe auto-execution.** If Provision returns a `<RemoteWipe>` element, surface `RecoveryAction::SurfacePermanent` with the reason — never call any wipe API. The user is shown a dialog in a follow-up UI task (out of scope here).
- **AutoDiscover redirects: max 3 hops.** Count both POX `<Action>redirect</Action>` (with `<Redirect><Url>`) and HTTP 302/303 `Location`. After 3 hops without a `<Server><Url>`, fail with a typed error so the user can fall back to manual URL entry.
- **Tag dispatch via `tag_name()`**, not raw token IDs, where the page is unambiguous. Provision status, policy key, etc. are parsed by walking `root.children` and matching `child.tag_name() == "Status"` etc. This is self-documenting and matches Phase 3a's idiom.
- **`X-MS-PolicyKey` is sent on EVERY command including Provision itself** (the spec says Provision with `PolicyKey` empty in Phase 1, then the temp key in Phase 2; we send `"0"` then temp — which is exactly what the existing header code does given `policy_key` is mutable on `EasConfig`).
- **Commit cadence:** one commit per task. `cargo test --lib` at each boundary. `cargo clippy -D warnings` clean at the end of each task (matches Phase 3a bar).

### EAS status → recovery mapping (single source of truth — lives in `status.rs`)

```
Common (per-command, top-level Status):
  1           → Ok
  142/143/144 → RetryProvision   (policy missing / changed / not provisioned)
  140         → SurfacePermanent (remote wipe required)
  126         → SurfacePermanent (provision required before this cmd can return data; but we always provision first, so this is a misconfig → surface)
  other       → SurfacePermanent

Sync collection status (MS-ASSYNC 2.2.3.23):
  1, 6        → Ok
  3           → ResetSyncKey      (sync key invalid)
  12          → RunFolderSync    (hierarchy changed; MVP falls back to ResetSyncKey+cache-wipe, same as 3a)
  4,5,8,16    → SurfacePermanent
  other       → SurfacePermanent

FolderSync status (MS-ASFolderSync 2.2.3.1.10):
  1           → Ok
  9           → ResetSyncKey
  126/142     → RetryProvision
  other       → SurfacePermanent

Ping status (MS-ASPing 2.2.3.7):
  1           → Ok (changes)
  2           → Ok (heartbeat elapsed)
  7           → RunFolderSync
  5           → SurfacePermanent (bad parameters)
  other       → SurfacePermanent

Provision status:
  1           → Ok (success, persist PolicyKey)
  2           → SurfacePermanent (protocol error)
  3           → SurfacePermanent (server error)
  other       → SurfacePermanent

HTTP status (transport-level):
  200         → Ok
  401         → if OAuth: RefreshToken then retry once; if Basic: SurfaceAuth
  403         → SurfaceAuth
  429         → RetryTransient (after Retry-After seconds; engine-level)
  449         → RetryProvision
  451         → FollowRedirect (X-MS-Location) then retry once
  5xx         → RetryTransient (engine-level)
  other       → SurfacePermanent
```

The `RecoveryAction` enum is the union: `Ok`, `RetryProvision`, `ResetSyncKey`, `RunFolderSync`, `RefreshToken`, `FollowRedirect`, `RetryTransient`, `SurfaceAuth`, `SurfacePermanent`.

---

## File Structure

**New files (Rust):**
- `src/eas/status.rs` — `CommonStatus`, `SyncStatus`, `FolderSyncStatus`, `PingStatus`, `ProvisionStatus`, `HttpOutcome`, `RecoveryAction` + `recovery_action_*` fns.
- `src/eas/provision.rs` — `build_provision_phase1_request()`, `build_provision_phase2_request(temp_policy_key)`, `parse_provision_response(root) -> ProvisionResult { status, policy_key, is_remote_wipe }`, `ProvisionError`.
- `src/eas/auth.rs` — `EasAuth` enum, `authorization_header()`, `refresh()` (OAuth only). (Named `auth.rs` not `oauth.rs` to avoid shadowing the top-level `crate::oauth`.)
- `src/eas/autodiscover.rs` — `autodiscover(email, http_client) -> Result<String, AutoDiscoverError>`, V1 POX + V2 JSON, redirect loop.

**Modified files (Rust):**
- `src/eas/mod.rs` — add `pub mod status; pub mod provision; pub mod auth; pub mod autodiscover;`.
- `src/eas/types.rs` — `EasConfig` gains `auth_type: EasAuthType` (default `Basic`) and `access_token: Option<String>` (+ OAuth refresh fields, hidden behind `EasAuth`). `EasError` gains variants `ProvisionRequired`, `AuthRefreshFailed`, `AutoDiscover`, `Redirect { location }`, `Throttled { retry_after_secs }`. Keep the legacy struct `EasError` in `types.rs`? — see Task 1 note; the client already uses `client::EasError` (the enum), so the `types::EasError` struct is dead code; Task 1 deletes it.
- `src/eas/client.rs` — replace the inline `Authorization` builder with `config.auth.authorization_header()`; refactor `send_command` into `send_command_with_retry` (one retry); add `provision(&mut self) -> Result<(), EasError>` method (Phase-1 + Phase-2 + persist to `self.config.policy_key`).
- `src/sync_engine/eas_source.rs` — `eas_config()` populates `auth_type` from `accounts.auth_type` + token fields; after a successful `provision()`, persist the new policy key to `accounts.eas_policy_key` via `db::accounts::update_account`. Replace local `classify_collection_status` with `status::recovery_action_for_sync(status)`.
- `src/db/accounts.rs` — `Account`, `CreateAccount`, `UpdateAccount` gain `auth_type: Option<String>`; `UpdateAccount::auth_type` setter.
- `src/eas/wbxml/tags.rs` — already has `tags::provision::*`; no changes needed.

**New migration:**
- `kylins.client.backend/migrations/<TS>_add_accounts_auth_type.sql` — `ALTER TABLE accounts ADD COLUMN auth_type TEXT;` (default null = basic).

---

## Task 1: `status.rs` — typed status enums + recovery-action classifier

**Files:** `src/eas/status.rs` (new), `src/eas/mod.rs`, `src/eas/types.rs` (delete dead `EasError` struct)

**Interfaces:**
- Produces: `RecoveryAction`, `CommonStatus { from_u32 }`, `SyncStatus`, `FolderSyncStatus`, `PingStatus`, `ProvisionStatus`, and four pure classifier fns: `recovery_action_for_common(u32)`, `recovery_action_for_sync(u32)`, `recovery_action_for_folder_sync(u32)`, `recovery_action_for_ping(u32)`, `recovery_action_for_provision(u32)`, `recovery_action_for_http(status: u16, is_oauth: bool) -> HttpRecovery`.

- [ ] **Step 1: Failing test.** In `status.rs`, write tests that assert the full mapping table above. Concretely:
```rust
#[test]
fn common_142_143_144_retry_provision() {
    assert_eq!(recovery_action_for_common(142), RecoveryAction::RetryProvision);
    assert_eq!(recovery_action_for_common(143), RecoveryAction::RetryProvision);
    assert_eq!(recovery_action_for_common(144), RecoveryAction::RetryProvision);
}
#[test]
fn common_140_126_surface_permanent() {
    assert_eq!(recovery_action_for_common(140), RecoveryAction::SurfacePermanent);
    assert_eq!(recovery_action_for_common(126), RecoveryAction::SurfacePermanent);
}
#[test]
fn sync_3_reset_sync_key_12_run_folder_sync() {
    assert_eq!(recovery_action_for_sync(3), RecoveryAction::ResetSyncKey);
    assert_eq!(recovery_action_for_sync(12), RecoveryAction::RunFolderSync);
    assert_eq!(recovery_action_for_sync(1), RecoveryAction::Ok);
    assert_eq!(recovery_action_for_sync(6), RecoveryAction::Ok);
}
#[test]
fn folder_sync_9_reset_sync_key_126_retry_provision() {
    assert_eq!(recovery_action_for_folder_sync(9), RecoveryAction::ResetSyncKey);
    assert_eq!(recovery_action_for_folder_sync(126), RecoveryAction::RetryProvision);
    assert_eq!(recovery_action_for_folder_sync(142), RecoveryAction::RetryProvision);
}
#[test]
fn ping_7_run_folder_sync() {
    assert_eq!(recovery_action_for_ping(7), RecoveryAction::RunFolderSync);
    assert_eq!(recovery_action_for_ping(1), RecoveryAction::Ok);
    assert_eq!(recovery_action_for_ping(2), RecoveryAction::Ok);
}
#[test]
fn http_401_oauth_refresh_basic_surface_auth() {
    assert_eq!(recovery_action_for_http(401, true),  RecoveryAction::RefreshToken);
    assert_eq!(recovery_action_for_http(401, false), RecoveryAction::SurfaceAuth);
    assert_eq!(recovery_action_for_http(403, true),  RecoveryAction::SurfaceAuth);
    assert_eq!(recovery_action_for_http(429, true),  RecoveryAction::RetryTransient);
    assert_eq!(recovery_action_for_http(449, true),  RecoveryAction::RetryProvision);
    assert_eq!(recovery_action_for_http(451, true),  RecoveryAction::FollowRedirect);
    assert_eq!(recovery_action_for_http(503, true),  RecoveryAction::RetryTransient);
    assert_eq!(recovery_action_for_http(200, true),  RecoveryAction::Ok);
}
```

- [ ] **Step 2: Run — expect FAIL** (module doesn't exist).

- [ ] **Step 3: Implement.** Create `src/eas/status.rs`:
```rust
//! Typed EAS status enums + the single source-of-truth mapping from a status
//! code to a `RecoveryAction`. Pure / no I/O — callers in `client.rs` and
//! `eas_source.rs` consult this instead of open-coding recovery decisions.

/// The set of actions a caller can take in response to an EAS status code.
/// Ordered roughly from "no-op" to "fatal". Every classifier in this module
/// returns one of these.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RecoveryAction {
    /// Apply the returned delta / response normally.
    Ok,
    /// Run the Provision handshake, then retry the original command once.
    /// Triggered by Common 142/143/144, FolderSync 126/142, HTTP 449.
    RetryProvision,
    /// Reset the collection sync_key to "0" and re-bootstrap the folder
    /// cache. Triggered by Sync 3, FolderSync 9.
    ResetSyncKey,
    /// Run FolderSync (hierarchy changed). Triggered by Sync 12, Ping 7.
    /// MVP note: the engine's cache-wipe path is a safe superset, so this
    /// currently degrades to `ResetSyncKey` at the call site.
    RunFolderSync,
    /// Refresh the OAuth access token, then retry once. HTTP 401 + OAuth only.
    RefreshToken,
    /// Follow the X-MS-Location URL, then retry once. HTTP 451 only.
    FollowRedirect,
    /// Wait then retry at the engine layer (60s poll). HTTP 429 / 5xx.
    RetryTransient,
    /// Surface an "authentication required" error to the user — token
    /// refresh failed, or Basic auth rejected. HTTP 401 + Basic, 403.
    SurfaceAuth,
    /// Surface a non-recoverable error (do NOT silently retry). Includes
    /// Common 140 (remote wipe) and 126, unknown statuses, malformed responses.
    SurfacePermanent,
}

/// Recovery decision for a Sync collection status (MS-ASSYNC 2.2.3.23).
pub fn recovery_action_for_sync(status: u32) -> RecoveryAction {
    match status {
        1 | 6 => RecoveryAction::Ok,
        3 => RecoveryAction::ResetSyncKey,
        12 => RecoveryAction::RunFolderSync,
        _ => RecoveryAction::SurfacePermanent,
    }
}

/// Recovery decision for a top-level Common status (MS-AS* top-level Status).
pub fn recovery_action_for_common(status: u32) -> RecoveryAction {
    match status {
        1 => RecoveryAction::Ok,
        142 | 143 | 144 => RecoveryAction::RetryProvision,
        140 | 126 => RecoveryAction::SurfacePermanent,
        _ => RecoveryAction::SurfacePermanent,
    }
}

/// Recovery decision for a FolderSync status (MS-ASFolderSync 2.2.3.1.10).
pub fn recovery_action_for_folder_sync(status: u32) -> RecoveryAction {
    match status {
        1 => RecoveryAction::Ok,
        9 => RecoveryAction::ResetSyncKey,
        126 | 142 => RecoveryAction::RetryProvision,
        _ => RecoveryAction::SurfacePermanent,
    }
}

/// Recovery decision for a Ping status (MS-ASPing 2.2.3.7).
pub fn recovery_action_for_ping(status: u32) -> RecoveryAction {
    match status {
        1 | 2 => RecoveryAction::Ok, // 1 = changes, 2 = heartbeat elapsed
        7 => RecoveryAction::RunFolderSync,
        _ => RecoveryAction::SurfacePermanent,
    }
}

/// Recovery decision for a Provision status (MS-ASPROV 2.2.3.x).
pub fn recovery_action_for_provision(status: u32) -> RecoveryAction {
    match status {
        1 => RecoveryAction::Ok,
        _ => RecoveryAction::SurfacePermanent,
    }
}

/// Recovery decision for an HTTP status. The OAuth-vs-Basic distinction
/// matters for 401: OAuth → try refresh; Basic → surface immediately.
pub fn recovery_action_for_http(status: u16, is_oauth: bool) -> RecoveryAction {
    match status {
        200 => RecoveryAction::Ok,
        401 if is_oauth => RecoveryAction::RefreshToken,
        401 | 403 => RecoveryAction::SurfaceAuth,
        429 => RecoveryAction::RetryTransient,
        449 => RecoveryAction::RetryProvision,
        451 => RecoveryAction::FollowRedirect,
        500..=599 => RecoveryAction::RetryTransient,
        _ => RecoveryAction::SurfacePermanent,
    }
}

#[cfg(test)]
mod tests { /* ...the tests from Step 1... */ }
```

Wire into `mod.rs`:
```rust
pub mod status;
```

Also in `types.rs`: **delete** the dead `pub struct EasError { status, message, command }` (lines ~316-333). It's unused — `client::EasError` (the enum at `client.rs:41`) is what flows through the codebase. Confirm with `cargo build` after deletion; if any stray reference surfaces, point it at `client::EasError`.

- [ ] **Step 4: Run — expect PASS.** All new status tests green; `cargo build` clean (the dead-struct deletion compiles).
- [ ] **Step 5: Commit** — `feat(eas): typed status enums + recovery_action classifier in status.rs`.

---

## Task 2: Provision command (WBXML builders + parser + handshake orchestrator)

**Files:** `src/eas/provision.rs` (new), `src/eas/mod.rs`, `src/eas/client.rs` (add `provision()` method)

**Interfaces:**
- Produces: `build_provision_phase1_request() -> WbxmlElement`, `build_provision_phase2_request(temp_policy_key: &str) -> WbxmlElement`, `parse_provision_response(root) -> Result<ProvisionResult, WbxmlError>`, `ProvisionResult { status: u32, policy_key: Option<String>, remote_wipe: bool }`, and `EasClient::provision(&mut self) -> Result<(), EasError>`.

- [ ] **Step 1: Failing test.** Build the WBXML for Phase 1, serialize → deserialize, walk the tree, assert the request shape. And build a mock Phase-1 response tree, assert `parse_provision_response` extracts the temp policy key + status=1.
```rust
#[test]
fn phase1_request_has_policy_type_ms_eas_provisioning_wbxml() {
    let tree = build_provision_phase1_request();
    // Root: Provision (page 14, 0x05)
    assert_eq!(tree.page, pages::PROVISION);
    assert_eq!(tree.token, provision::PROVISION);
    // Walk: Provision > Policies > Policy > PolicyType == "MS-EAS-Provisioning-WBXML"
    let policies = tree.children.iter().find(|c| c.token == provision::POLICIES).expect("Policies");
    let policy = policies.children.iter().find(|c| c.token == provision::POLICY).expect("Policy");
    let ptype = policy.children.iter().find(|c| c.token == provision::POLICY_TYPE).expect("PolicyType");
    assert_eq!(ptype.text_str(), "MS-EAS-Provisioning-WBXML");
}

#[test]
fn parse_phase1_response_extracts_temp_policy_key() {
    // Build a tree mimicking:
    // <Provision><Status>1</Status><Policies><Policy><PolicyType>...</PolicyType>
    //   <Status>1</Status><PolicyKey>{TEMP-123}</PolicyKey><Data>...</Data></Policy></Policies></Provision>
    let tree = WbxmlElement::container(pages::PROVISION, provision::PROVISION, vec![
        WbxmlElement::text(pages::PROVISION, provision::STATUS, "1"),
        WbxmlElement::container(pages::PROVISION, provision::POLICIES, vec![
            WbxmlElement::container(pages::PROVISION, provision::POLICY, vec![
                WbxmlElement::text(pages::PROVISION, provision::POLICY_TYPE, "MS-EAS-Provisioning-WBXML"),
                WbxmlElement::text(pages::PROVISION, provision::STATUS, "1"),
                WbxmlElement::text(pages::PROVISION, provision::POLICY_KEY, "{TEMP-123}"),
            ]),
        ]),
    ]);
    let r = parse_provision_response(&tree).unwrap();
    assert_eq!(r.status, 1);
    assert_eq!(r.policy_key.as_deref(), Some("{TEMP-123}"));
    assert!(!r.remote_wipe);
}

#[test]
fn parse_response_flags_remote_wipe() {
    // <Provision><Status>1</Status><RemoteWipe>...</RemoteWipe></Provision>
    let tree = WbxmlElement::container(pages::PROVISION, provision::PROVISION, vec![
        WbxmlElement::text(pages::PROVISION, provision::STATUS, "1"),
        WbxmlElement::empty(pages::PROVISION, provision::REMOTE_WIPE),
    ]);
    let r = parse_provision_response(&tree).unwrap();
    assert!(r.remote_wipe, "must flag RemoteWipe so caller surfaces it");
}
```
(`text_str()` is a test-only helper added to `WbxmlElement` if not already present — check `wbxml/types.rs`; if missing, inline the `match &c.value { WbxmlValue::Text(s) => s.clone(), _ => panic!() }` in the test instead.)

- [ ] **Step 2: Run — expect FAIL.**

- [ ] **Step 3: Implement.** Create `src/eas/provision.rs`:
```rust
//! Provision command (MS-ASPROV). Two-phase handshake:
//!   Phase 1: client requests the policy → server returns a TEMP PolicyKey
//!           and the policy XML in <Data>.
//!   Phase 2: client acknowledges with the temp PolicyKey and <Status>1</Status>
//!           → server returns a PERMANENT PolicyKey that the client must send
//!           in the X-MS-PolicyKey header on every subsequent command.
//!
//! RemoteWipe: if the server returns <RemoteWipe>, we surface it as a
//! permanent error — never auto-execute. The UI is a follow-up.

use crate::eas::wbxml::tags::{pages, provision};
use crate::eas::wbxml::types::{WbxmlElement, WbxmlValue};
use crate::eas::wbxml::WbxmlError;

const MS_EAS_PROVISIONING_WBXML: &str = "MS-EAS-Provisioning-WBXML";

/// Build the Phase-1 Provision request (no policy key yet).
pub fn build_provision_phase1_request() -> WbxmlElement {
    WbxmlElement::container(
        pages::PROVISION,
        provision::PROVISION,
        vec![
            WbxmlElement::container(
                pages::PROVISION,
                provision::POLICIES,
                vec![WbxmlElement::container(
                    pages::PROVISION,
                    provision::POLICY,
                    vec![WbxmlElement::text(
                        pages::PROVISION,
                        provision::POLICY_TYPE,
                        MS_EAS_PROVISIONING_WBXML,
                    )],
                )],
            ),
        ],
    )
}

/// Build the Phase-2 ack: client has received the temp policy and accepts it
/// (Status 1 = client compliant). Server replies with the permanent key.
pub fn build_provision_phase2_request(temp_policy_key: &str) -> WbxmlElement {
    WbxmlElement::container(
        pages::PROVISION,
        provision::PROVISION,
        vec![
            WbxmlElement::container(
                pages::PROVISION,
                provision::POLICIES,
                vec![WbxmlElement::container(
                    pages::PROVISION,
                    provision::POLICY,
                    vec![
                        WbxmlElement::text(pages::PROVISION, provision::POLICY_TYPE, MS_EAS_PROVISIONING_WBXML),
                        WbxmlElement::text(pages::PROVISION, provision::POLICY_KEY, temp_policy_key),
                        WbxmlElement::text(pages::PROVISION, provision::STATUS, "1"),
                    ],
                )],
            ),
        ],
    )
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct ProvisionResult {
    /// Top-level Provision Status. 1 = success.
    pub status: u32,
    /// Permanent (Phase 2) or temp (Phase 1) policy key returned by the server.
    pub policy_key: Option<String>,
    /// True if the server sent a `<RemoteWipe>` element. Caller MUST surface,
    /// never auto-wipe.
    pub remote_wipe: bool,
}

/// Parse a Provision response. Extracts the top-level Status, the nested
/// Policy's PolicyKey, and detects a RemoteWipe element.
pub fn parse_provision_response(root: &WbxmlElement) -> Result<ProvisionResult, WbxmlError> {
    let mut out = ProvisionResult { status: 1, ..Default::default() };
    for child in &root.children {
        // Match on (page, token) — provision page is unambiguous in the root.
        match (child.page, child.token) {
            (pages::PROVISION, provision::STATUS) => {
                out.status = text(child).parse().unwrap_or(1);
            }
            (pages::PROVISION, provision::POLICIES) => {
                if let Some(key) = find_policy_key(child) {
                    out.policy_key = Some(key);
                }
            }
            (pages::PROVISION, provision::REMOTE_WIPE) => {
                out.remote_wipe = true;
            }
            _ => {}
        }
    }
    Ok(out)
}

fn find_policy_key(policies_el: &WbxmlElement) -> Option<String> {
    for policy in &policies_el.children {
        if policy.token != provision::POLICY { continue; }
        for field in &policy.children {
            if field.token == provision::POLICY_KEY {
                return Some(text(field));
            }
        }
    }
    None
}

fn text(el: &WbxmlElement) -> String {
    match &el.value {
        WbxmlValue::Text(s) => s.clone(),
        WbxmlValue::Opaque(b) => String::from_utf8_lossy(b).into_owned(),
        WbxmlValue::Empty => String::new(),
    }
}

#[cfg(test)]
mod tests { /* ...Step 1 tests... */ }
```

Add the orchestrator to `EasClient` (in `client.rs`). Note `&mut self` because Phase 2 writes the permanent key into `self.config.policy_key`:
```rust
/// Run the two-phase Provision handshake and persist the resulting policy
/// key into `self.config.policy_key`. Subsequent commands then send it via
/// the X-MS-PolicyKey header (already wired in `send_command`).
///
/// Errors with `CommandStatus` if either phase returns non-1 status, or
/// `Transport` if the server returns a RemoteWipe (we surface, never execute).
pub async fn provision(&mut self) -> Result<(), EasError> {
    // Phase 1.
    let req1 = commands::build_provision_phase1_request();  // module re-export see below
    let resp1 = self.send_command_no_retry("Provision", &req1).await?;
    let parsed1 = crate::eas::provision::parse_provision_response(&resp1)?;
    if parsed1.remote_wipe {
        return Err(EasError::CommandStatus {
            status: 140,
            message: "server requested RemoteWipe — refusing to auto-execute".into(),
        });
    }
    if parsed1.status != 1 {
        return Err(EasError::CommandStatus {
            status: parsed1.status,
            message: format!("Provision phase 1 status {}", parsed1.status),
        });
    }
    let temp_key = parsed1.policy_key.ok_or_else(|| EasError::Transport(
        "Provision phase 1 returned no PolicyKey".into(),
    ))?;

    // Phase 2: ack with temp key.
    let req2 = crate::eas::provision::build_provision_phase2_request(&temp_key);
    let resp2 = self.send_command_no_retry("Provision", &req2).await?;
    let parsed2 = crate::eas::provision::parse_provision_response(&resp2)?;
    if parsed2.remote_wipe {
        return Err(EasError::CommandStatus {
            status: 140,
            message: "server requested RemoteWipe in phase 2 — refusing".into(),
        });
    }
    if parsed2.status != 1 {
        return Err(EasError::CommandStatus {
            status: parsed2.status,
            message: format!("Provision phase 2 status {}", parsed2.status),
        });
    }
    let perm_key = parsed2.policy_key.ok_or_else(|| EasError::Transport(
        "Provision phase 2 returned no permanent PolicyKey".into(),
    ))?;
    self.config.policy_key = perm_key;
    Ok(())
}
```
(`send_command_no_retry` is the extracted transport core — see Task 6. For Task 2, expose it as a private method on `EasClient`; if Task 6 hasn't landed its retry wrapper yet, `send_command` can be temporarily used and the rename done in Task 6.)

Add `pub mod provision;` to `src/eas/mod.rs`.

- [ ] **Step 4: Run — expect PASS.** All Provision tests green; `cargo build` clean.
- [ ] **Step 5: Commit** — `feat(eas): Provision two-phase handshake + client::provision()`.

---

## Task 3: `auth.rs` — `EasAuth` enum (Basic + OAuth Bearer) + refresh helper

**Files:** `src/eas/auth.rs` (new), `src/eas/mod.rs`, `src/eas/types.rs` (extend `EasConfig`), `src/db/accounts.rs` (add `auth_type`), `migrations/<TS>_add_accounts_auth_type.sql` (new)

**Interfaces:**
- Produces: `EasAuth` enum, `EasAuth::Basic { username, password }` / `EasAuth::OAuth { access_token, refresh_token, client_id, client_secret, token_url, scope }`, `authorization_header(&self) -> String`, `refresh(&mut self) -> Result<(), EasError>` (OAuth only). `EasConfig` gains `pub auth: EasAuth`. The migration adds `accounts.auth_type TEXT`.

- [ ] **Step 1: Failing test.**
```rust
#[test]
fn basic_authorization_header_is_base64() {
    let auth = EasAuth::Basic { username: "alice".into(), password: "s3cret".into() };
    assert_eq!(auth.authorization_header(), "Basic YWxpY2U6czNjcmV0");
    assert!(auth.is_oauth() == false);
}

#[tokio::test]
async fn oauth_refresh_updates_access_token() {
    // Mock the token endpoint with a wiremock-like server.
    // For TDD simplicity and zero new test deps, use reqwest against a
    // localhost hyper server OR factor the refresh into a pure fn
    // `build_refresh_form(refresh_token, client_id, ...) -> Vec<(String,String)>`
    // and assert the form body. Network behavior tested at integration layer.
    let form = build_refresh_form("rtok", "cid", Some("csec"), Some("scope"));
    assert_eq!(form.iter().find(|(k, _)| k == "grant_type").unwrap().1, "refresh_token");
    assert_eq!(form.iter().find(|(k, _)| k == "refresh_token").unwrap().1, "rtok");
}

#[test]
fn oauth_authorization_header_is_bearer() {
    let auth = EasAuth::OAuth { access_token: "ATOM".into(), ..Default::default() };
    assert_eq!(auth.authorization_header(), "Bearer ATOM");
    assert!(auth.is_oauth());
}
```

- [ ] **Step 2: Run — expect FAIL.**

- [ ] **Step 3: Implement.** Create `src/eas/auth.rs`:
```rust
//! EAS authentication strategies. The transport in `client.rs` calls
//! `auth.authorization_header()` to populate the `Authorization` header.
//!
//! `Basic` is the historical default. `OAuth` is required for Exchange Online
//! modern auth tenants — the access token is short-lived (~1h) and refreshed
//! on a 401 by the transport's retry layer.

use crate::eas::client::EasError;

#[derive(Debug, Clone)]
pub enum EasAuth {
    Basic {
        username: String,
        password: String,
    },
    OAuth {
        access_token: String,
        /// OAuth2 refresh token. Required for unattended refresh; if absent,
        /// a 401 surfaces as `SurfaceAuth` (user must re-authenticate).
        refresh_token: Option<String>,
        /// Client ID registered with the IdP. Required to call the token endpoint.
        client_id: String,
        /// Client secret. Public clients (desktop apps) typically omit this and
        /// use PKCE instead — left optional and not validated here.
        client_secret: Option<String>,
        /// Token endpoint URL, e.g. `https://login.microsoftonline.com/common/oauth2/v2.0/token`.
        token_url: String,
        /// Space-separated scopes to request on refresh.
        scope: Option<String>,
    },
}

impl EasAuth {
    pub fn is_oauth(&self) -> bool {
        matches!(self, EasAuth::OAuth { .. })
    }

    /// Build the `Authorization` header value for the next request.
    pub fn authorization_header(&self) -> String {
        match self {
            EasAuth::Basic { username, password } => {
                let encoded = base64::engine::general_purpose::STANDARD
                    .encode(format!("{}:{}", username, password));
                format!("Basic {}", encoded)
            }
            EasAuth::OAuth { access_token, .. } => format!("Bearer {}", access_token),
        }
    }

    /// Refresh the access token (OAuth only). Basic is a no-op success.
    /// Mirrors `crate::oauth::oauth_refresh_token` but operates on `&mut self`.
    pub async fn refresh(&mut self) -> Result<(), EasError> {
        let (refresh_token, client_id, client_secret, scope, token_url) = match self {
            EasAuth::Basic { .. } => return Ok(()),
            EasAuth::OAuth { refresh_token, client_id, client_secret, scope, token_url, .. } => {
                let rt = refresh_token.as_ref().ok_or_else(|| EasError::AuthRefreshFailed(
                    "no refresh_token — user must re-authenticate".into(),
                ))?;
                (rt.clone(), client_id.clone(), client_secret.clone(), scope.clone(), token_url.clone())
            }
            // (access_token gets overwritten after the form-build below)
        };

        let form = build_refresh_form(&refresh_token, &client_id, client_secret.as_deref(), scope.as_deref());
        let client = reqwest::Client::new();
        let resp = client.post(&token_url).form(&form).send().await
            .map_err(|e| EasError::AuthRefreshFailed(format!("refresh request failed: {}", e)))?;
        if !resp.status().is_success() {
            let body = resp.text().await.unwrap_or_default();
            return Err(EasError::AuthRefreshFailed(format!("refresh status: {}", body)));
        }
        let parsed: RefreshResponse = resp.json().await
            .map_err(|e| EasError::AuthRefreshFailed(format!("refresh parse: {}", e)))?;

        // Overwrite the access_token in place.
        if let EasAuth::OAuth { access_token, refresh_token, .. } = self {
            *access_token = parsed.access_token;
            // RFC 6749: server MAY rotate the refresh token. If present, adopt it.
            if let Some(new_rt) = parsed.refresh_token {
                *refresh_token = Some(new_rt);
            }
        }
        Ok(())
    }
}

/// Build the x-www-form-urlencoded body for a refresh_token grant.
/// Pure / no I/O so it's directly testable.
pub fn build_refresh_form(
    refresh_token: &str,
    client_id: &str,
    client_secret: Option<&str>,
    scope: Option<&str>,
) -> Vec<(String, String)> {
    let mut v = vec![
        ("grant_type".into(), "refresh_token".into()),
        ("refresh_token".into(), refresh_token.into()),
        ("client_id".into(), client_id.into()),
    ];
    if let Some(s) = client_secret { v.push(("client_secret".into(), s.into())); }
    if let Some(s) = scope { v.push(("scope".into(), s.into())); }
    v
}

#[derive(serde::Deserialize)]
struct RefreshResponse {
    access_token: String,
    #[serde(default)]
    refresh_token: Option<String>,
}

#[cfg(test)]
mod tests { /* ...Step 1 tests... */ }
```

Extend `EasConfig` in `types.rs`:
```rust
// Replace the `username`/`password` fields (keep them for backwards compat
// in serde) and add `auth`. To minimize churn, ADD a new field that the
// source layer populates; the client uses `auth` if set, else falls back to
// basic with username/password.

pub struct EasConfig {
    // ...existing fields...
    pub username: String,        // kept for Basic fallback / serde
    pub password: String,        // kept for Basic fallback / serde
    /// Default `"basic"`. When `"oauth"`, the source layer also fills `auth`.
    #[serde(default)]
    pub auth_type: String,
    /// Typed auth. Built by `EasSource::eas_config()` from the stored fields.
    #[serde(default)]
    pub auth: Option<EasAuth>,
}
```
(Keep `username`/`password` on the struct for Basic; the transport uses `auth.authorization_header()` when `auth` is `Some`, else falls back to Basic with username/password — this preserves backwards compatibility with existing tests.)

Add `EasError::AuthRefreshFailed(String)` variant to `client.rs::EasError`:
```rust
#[error("OAuth token refresh failed: {0}")]
AuthRefreshFailed(String),
```

Migration file `kylins.client.backend/migrations/20260630000001_add_accounts_auth_type.sql`:
```sql
-- Phase 3b: EAS hardening. Adds auth_type so the EAS source can pick Basic vs OAuth.
-- Default null = Basic (preserves existing rows).
ALTER TABLE accounts ADD COLUMN auth_type TEXT;
```

In `src/db/accounts.rs`: add `pub auth_type: Option<String>` to `Account`, `CreateAccount`, `UpdateAccount`. Map it in `row_to_account` (`auth_type: row.try_get("auth_type").ok().flatten()`) and the insert/update setters (`push_str!("auth_type", updates.auth_type);`). Follow the existing `eas_policy_key` pattern verbatim.

Add `pub mod auth;` to `src/eas/mod.rs`.

- [ ] **Step 4: Run — expect PASS.** All auth tests green; migration test in `db/mod.rs::migrations_apply_and_create_tables` still green (sqlx picks up the new file automatically). Confirm with `cargo test --lib db::`.
- [ ] **Step 5: Commit** — `feat(eas): EasAuth (Basic+OAuth) + auth_type column + refresh helper`.

---

## Task 4: AutoDiscover (V1 POX + V2 JSON, redirect-safe)

**Files:** `src/eas/autodiscover.rs` (new), `src/eas/mod.rs`

**Interfaces:**
- Produces: `autodiscover(email: &str, http: &reqwest::Client) -> Result<AutodiscoverResult, AutoDiscoverError>`, `AutodiscoverResult { eas_url: String, redirect_url: Option<String> }`, `AutoDiscoverError` enum. Internal: `try_v1_pox(...)`, `try_v2_json(...)`, `parse_v1_pox_response(body: &str) -> Result<PoxOutcome, _>`, `parse_v2_json_response(body: &str) -> Result<String, _>`.

- [ ] **Step 1: Failing test.** Use real fixture strings (snippets of the XML/JSON the servers return):
```rust
#[test]
fn parse_v1_pox_extracts_server_url() {
    let body = r#"<?xml version="1.0" encoding="utf-8"?>
<Autodiscover xmlns="http://schemas.microsoft.com/exchange/autodiscover/responseschema/2006">
  <Response>
    <User><AutoDiscoverEmail>alice@contoso.com</AutoDiscoverEmail></User>
    <Action>Settings</Action>
    <MobileSync>
      <Server>
        <Type>MobileSync</Type>
        <Url>https://mail.contoso.com/Microsoft-Server-ActiveSync</Url>
        <Name>https://mail.contoso.com/Microsoft-Server-ActiveSync</Name>
      </Server>
    </MobileSync>
  </Response>
</Autodiscover>"#;
    let parsed = parse_v1_pox_response(body).unwrap();
    match parsed {
        PoxOutcome::Server(url) => assert_eq!(url, "https://mail.contoso.com/Microsoft-Server-ActiveSync"),
        _ => panic!("expected Server outcome"),
    }
}

#[test]
fn parse_v1_pox_returns_redirect_when_action_redirect() {
    let body = r#"<Autodiscover xmlns="...">
      <Response><Action>redirect</Action><Redirect><Url>https://contoso.onmicrosoft.com/autodiscover/autodiscover.xml</Url></Redirect></Response>
    </Autodiscover>"#;
    let parsed = parse_v1_pox_response(body).unwrap();
    match parsed {
        PoxOutcome::Redirect(url) => assert!(url.contains("contoso.onmicrosoft.com")),
        _ => panic!("expected Redirect"),
    }
}

#[test]
fn parse_v2_json_extracts_url() {
    let body = r#"{"Url":"https://outlook.office365.com/Microsoft-Server-ActiveSync","Protocol":"ActiveSync"}"#;
    let url = parse_v2_json_response(body).unwrap();
    assert_eq!(url, "https://outlook.office365.com/Microsoft-Server-ActiveSync");
}

#[test]
fn parse_v1_pox_rejects_error_response() {
    let body = r#"<Autodiscover xmlns="..."><Response><Error><ErrorCode>500</ErrorCode><Message>Invalid request</Message></Error></Response></Autodiscover>"#;
    assert!(parse_v1_pox_response(body).is_err());
}
```

- [ ] **Step 2: Run — expect FAIL.**

- [ ] **Step 3: Implement.** Decision on XML parsing: the EAS codebase already ships a hand-written WBXML codec; adding `quick-xml` for ~3 tags is overkill and introduces a dep that must live across the whole crate. **Instead, parse the POX response with a regex-free tag-scan** (string `find` between `<Url>...</Url>` and `<Action>...</Action>`). The mobilesync response is a fixed, server-controlled shape; a robust XML parser is a deferred hardening item (documented). This keeps `Cargo.toml` clean.

Create `src/eas/autodiscover.rs`:
```rust
//! Exchange AutoDiscover — resolves the EAS URL for a user's email.
//!
//! Two flows, tried in order:
//!   1. V1 POX — POST the mobilesync XML envelope to
//!      `https://<domain>/autodiscover/autodiscover.xml` (and the same path on
//!      `autodiscover.<domain>`). Parse the `<MobileSync><Server><Url>` from
//!      the XML response. Follow `<Redirect><Url>` up to MAX_REDIRECTS hops.
//!   2. V2 JSON — GET `https://autodiscover-s.outlook.com/autodiscover/autodiscover.json?Email=<email>`
//!      and read `Url` from the JSON. The V2 endpoint returns the canonical
//!      Exchange Online EAS URL for any M365 mailbox.
//!
//! HTTP 302/303 redirects on the V1 endpoint also count toward MAX_REDIRECTS.

use serde::Deserialize;

const MAX_REDIRECTS: u8 = 3;

#[derive(Debug, thiserror::Error)]
pub enum AutoDiscoverError {
    #[error("HTTP {status}: {body}")]
    HttpStatus { status: u16, body: String },
    #[error("transport: {0}")]
    Transport(String),
    #[error("parse: {0}")]
    Parse(String),
    #[error("redirect loop exceeded {0} hops")]
    TooManyRedirects(u8),
    #[error("no EAS URL found in any flow")]
    NotFound,
}

#[derive(Debug, Clone)]
pub struct AutodiscoverResult {
    pub eas_url: String,
}

/// Run the full flow: V1 POX (with redirects) on the email's domain, then
/// V2 JSON fallback for Exchange Online.
pub async fn autodiscover(
    email: &str,
    http: &reqwest::Client,
) -> Result<AutodiscoverResult, AutoDiscoverError> {
    // V2 first is actually faster and more reliable for M365 — but the spec
    // ordering is V1 → V2 to support on-prem Exchange. Try V1 on the email's
    // domain and autodiscover.<domain>; if both fail, try V2.
    let domain = email.rsplit_once('@').map(|(_, d)| d).ok_or_else(|| {
        AutoDiscoverError::Parse(format!("not an email: {}", email))
    })?;
    let v1_candidates = [
        format!("https://{}/autodiscover/autodiscover.xml", domain),
        format!("https://autodiscover.{}/autodiscover/autodiscover.xml", domain),
    ];
    for base in v1_candidates {
        match try_v1_pox(base.clone(), email, http).await {
            Ok(url) => return Ok(AutodiscoverResult { eas_url: url }),
            Err(AutoDiscoverError::NotFound) => continue,
            Err(e) => {
                log::debug!("AutoDiscover V1 {} failed: {}", base, e);
                continue;
            }
        }
    }
    // V2 fallback.
    let url = try_v2_json(email, http).await?;
    Ok(AutodiscoverResult { eas_url: url })
}

/// Outcome of parsing one V1 POX response body.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PoxOutcome {
    Server(String),
    Redirect(String),
}

async fn try_v1_pox(
    url: String,
    email: &str,
    http: &reqwest::Client,
) -> Result<String, AutoDiscoverError> {
    let body = format!(
        r#"<?xml version="1.0" encoding="utf-8"?>
<Autodiscover xmlns="http://schemas.microsoft.com/exchange/autodiscover/outlook/requestschema/2006">
  <Request>
    <AcceptableResponseSchema>http://schemas.microsoft.com/exchange/autodiscover/mobilesync/responseschema/2006</AcceptableResponseSchema>
    <EMailAddress>{}</EMailAddress>
  </Request>
</Autodiscover>"#,
        email
    );
    let mut current_url = url;
    for _ in 0..MAX_REDIRECTS {
        let resp = http.post(&current_url)
            .header("Content-Type", "text/xml")
            .body(body.clone())
            .send()
            .await
            .map_err(|e| AutoDiscoverError::Transport(e.to_string()))?;
        let status = resp.status().as_u16();
        if status == 301 || status == 302 || status == 303 {
            if let Some(loc) = resp.headers().get(reqwest::header::LOCATION).and_then(|v| v.to_str().ok()) {
                current_url = loc.to_string();
                continue;
            }
        }
        if status != 200 {
            let b = resp.text().await.unwrap_or_default();
            return Err(AutoDiscoverError::HttpStatus { status, body: b });
        }
        let text = resp.text().await.map_err(|e| AutoDiscoverError::Transport(e.to_string()))?;
        match parse_v1_pox_response(&text)? {
            PoxOutcome::Server(u) => return Ok(u),
            PoxOutcome::Redirect(u) => { current_url = u; continue; }
        }
    }
    Err(AutoDiscoverError::TooManyRedirects(MAX_REDIRECTS))
}

/// Parse a V1 POX response body. Uses a tag-scan (NOT a full XML parser) —
/// the response shape is server-controlled and stable; robust XML parsing is
/// a documented follow-up.
pub fn parse_v1_pox_response(body: &str) -> Result<PoxOutcome, AutoDiscoverError> {
    if let Some(_err) = find_tag(body, "Error") {
        return Err(AutoDiscoverError::Parse("server returned <Error>".into()));
    }
    if let Some(action) = find_tag(body, "Action") {
        if action.trim() == "redirect" {
            let url = find_tag(body, "Url")
                .ok_or_else(|| AutoDiscoverError::Parse("redirect without <Url>".into()))?;
            return Ok(PoxOutcome::Redirect(url));
        }
    }
    // MobileSync Server Url.
    if let Some(url) = find_tag(body, "Url") {
        return Ok(PoxOutcome::Server(url));
    }
    Err(AutoDiscoverError::NotFound)
}

/// Find the inner text of the first `<tag>...</tag>` occurrence. Naive — does
/// NOT handle namespaces, CDATA, or self-closing. Sufficient for AutoDiscover.
fn find_tag(body: &str, tag: &str) -> Option<String> {
    let open = format!("<{}", tag);
    let close = format!("</{}>", tag);
    let start = body.find(&open)? + open.len();
    // Skip attributes within the opening tag (> ends it).
    let text_start = body[start..].find('>')? + start + 1;
    let text_end = body[text_start..].find(&close)? + text_start;
    Some(body[text_start..text_end].trim().to_string())
}

#[derive(Deserialize)]
struct V2Response {
    #[serde(rename = "Url")]
    url: String,
    #[serde(rename = "Protocol", default = "default_protocol")]
    _protocol: String,
}
fn default_protocol() -> String { String::new() }

async fn try_v2_json(email: &str, http: &reqwest::Client) -> Result<String, AutoDiscoverError> {
    let url = format!(
        "https://autodiscover-s.outlook.com/autodiscover/autodiscover.json?Email={}",
        email
    );
    let resp = http.get(&url).send().await
        .map_err(|e| AutoDiscoverError::Transport(e.to_string()))?;
    let status = resp.status().as_u16();
    if status != 200 {
        let b = resp.text().await.unwrap_or_default();
        return Err(AutoDiscoverError::HttpStatus { status, body: b });
    }
    let text = resp.text().await.map_err(|e| AutoDiscoverError::Transport(e.to_string()))?;
    parse_v2_json_response(&text)
}

pub fn parse_v2_json_response(body: &str) -> Result<String, AutoDiscoverError> {
    let parsed: V2Response = serde_json::from_str(body)
        .map_err(|e| AutoDiscoverError::Parse(format!("V2 JSON: {}", e)))?;
    Ok(parsed.url)
}

#[cfg(test)]
mod tests { /* ...Step 1 tests... */ }
```

(`serde_json` is already a workspace dep via `reqwest`'s json feature; confirm in Task 5's dep audit. `thiserror` is already a dep — `client.rs` uses it.)

Add `pub mod autodiscover;` to `src/eas/mod.rs`.

- [ ] **Step 4: Run — expect PASS.** All autodiscover tests green; no network tests in CI (the unit tests cover parse fns only).
- [ ] **Step 5: Commit** — `feat(eas): AutoDiscover V1 POX + V2 JSON resolver`.

---

## Task 5: Wire retry layer into `client.rs::send_command` + auth/provision integration

**Files:** `src/eas/client.rs`, `src/sync_engine/eas_source.rs` (populate `auth`, persist policy key after Provision)

**Interfaces:**
- Produces: `send_command` now does **one** classified retry. Internals: `send_command_no_retry` (the existing transport core, extracted) + a wrapper that inspects the response/error and consults `status::recovery_action_for_http` / `_for_common` to decide whether to retry. `EasSource::eas_config` builds the `EasAuth` from stored fields; `EasSource` calls `client.provision()` after a successful bootstrap or on `ProvisionRequired`.

- [ ] **Step 1: Failing test.** The retry logic itself is hard to unit-test without a mock HTTP server. Instead, test the **decision function** (which the wrapper calls):
```rust
#[test]
fn retry_decision_449_triggers_provision() {
    let d = retry_decision_for_http_err(449, false);
    assert_eq!(d, RetryDecision::RunProvision);
}
#[test]
fn retry_decision_401_oauth_triggers_refresh() {
    let d = retry_decision_for_http_err(401, true);
    assert_eq!(d, RetryDecision::RefreshToken);
}
#[test]
fn retry_decision_401_basic_no_retry() {
    let d = retry_decision_for_http_err(401, false);
    assert_eq!(d, RetryDecision::None);
}
#[test]
fn retry_decision_451_triggers_redirect() {
    let d = retry_decision_for_http_err(451, false);
    assert_eq!(d, RetryDecision::FollowRedirect);
}
```

- [ ] **Step 2: Run — expect FAIL.**

- [ ] **Step 3: Implement.** Refactor `client.rs`. Rename the existing `send_command` body to `send_command_no_retry` (private). Add a public `send_command` wrapper:
```rust
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum RetryDecision { None, RunProvision, RefreshToken, FollowRedirect }

fn retry_decision_for_http_err(status: u16, is_oauth: bool) -> RetryDecision {
    use crate::eas::status::RecoveryAction as A;
    match crate::eas::status::recovery_action_for_http(status, is_oauth) {
        A::RetryProvision => RetryDecision::RunProvision,
        A::RefreshToken => RetryDecision::RefreshToken,
        A::FollowRedirect => RetryDecision::FollowRedirect,
        _ => RetryDecision::None,
    }
}

/// Public entry: sends a command, applying ONE classified retry on
/// transport-level signals (Provision required, OAuth 401, HTTP 451 redirect).
/// Command-level status errors (Sync 3, FolderSync 9, etc.) are surfaced to
/// the caller — the caller maps them via `status::recovery_action_for_*`.
pub async fn send_command(
    &self,
    cmd_name: &str,
    request_root: &WbxmlElement,
) -> Result<WbxmlElement, EasError> {
    match self.send_command_no_retry(cmd_name, request_root).await {
        Ok(root) => Ok(root),
        Err(EasError::HttpStatus { status, .. }) => {
            let is_oauth = self.config.auth.as_ref().map(|a| a.is_oauth()).unwrap_or(false);
            match retry_decision_for_http_err(status, is_oauth) {
                RetryDecision::RunProvision => {
                    self.provision().await?;  // &mut self required; see note below
                    self.send_command_no_retry(cmd_name, request_root).await
                }
                RetryDecision::RefreshToken => {
                    if let Some(auth) = self.config.auth.as_mut() {
                        auth.refresh().await?;
                    }
                    self.send_command_no_retry(cmd_name, request_root).await
                }
                RetryDecision::FollowRedirect => {
                    // The X-MS-Location header was consumed inside send_command_no_retry
                    // and stored on the error variant. EasError::Redirect carries it.
                    // (For MVP, follow by re-issuing with updated config.url.)
                    Err(EasError::HttpStatus { status, body: "redirect handling pending".into() })
                    // NOTE: full redirect handling is a follow-up; the classification
                    // is wired here so the recovery layer is complete. The engine
                    // surfaces the error and the user is prompted to re-run AutoDiscover.
                }
                RetryDecision::None => Err(EasError::HttpStatus { status, body: format!("http {}", status) }),
            }
        }
        Err(e) => Err(e), // transport / wbxml errors: surface, don't retry
    }
}
```

**Note on `&mut self`:** the existing `EasClient` methods take `&self`. Provision mutates `config.policy_key`; refresh mutates the OAuth `access_token`. Two options:
  1. Change `EasClient` to take `&mut self` on the methods that go through `send_command` — cleanest, but touches many call sites in `eas_source.rs`.
  2. Use `parking_lot::RwLock<EasConfig>` interior mutability — no API breakage.

**Decision: option 1.** The call sites are few (`eas_source.rs` owns the only `EasClient` instance per sync round; it's created fresh per call). Changing `&self` → `&mut self` on `sync`/`folder_sync`/etc. is mechanical and surfaces the mutation explicitly. Update `EasClient` method signatures and the `EasSource` callers (they already construct a fresh client each call).

Wire `EasSource::eas_config` to populate `auth`:
```rust
fn eas_config(&self) -> EasConfig {
    let auth = match self.account.auth_type.as_deref() {
        Some("oauth") => Some(EasAuth::OAuth {
            access_token: self.account.access_token.clone().unwrap_or_default(),
            refresh_token: self.account.refresh_token.clone(),
            client_id: self.account.oauth_client_id.clone().unwrap_or_default(),  // see note
            client_secret: self.account.oauth_client_secret.clone(),
            token_url: self.account.oauth_token_url.clone().unwrap_or_default(),
            scope: self.account.oauth_scope.clone(),
        }),
        _ => None,  // Basic fallback via username/password
    };
    EasConfig {
        // ...existing fields...
        auth_type: self.account.auth_type.clone().unwrap_or_else(|| "basic".into()),
        auth,
    }
}
```
(The `oauth_client_id` / `oauth_token_url` / `oauth_scope` fields may not yet exist on `Account`. **Decision:** if missing, store them in `settings` KV (already a key-value store) keyed by `eas.oauth.<account_id>`, OR add a follow-up migration. For this task, **add the minimal columns** `oauth_client_id`, `oauth_token_url`, `oauth_scope`, `oauth_client_secret` to the same Task 3 migration — they're nullable TEXT and reused by any future OAuth provider. Update Task 3's migration accordingly. If the reviewer prefers to defer, hard-code the well-known M365 values: `client_id = "9e5f94bc-e8a4-4e73-b8be-63364c29d753"` (Azure registered public client), `token_url = "https://login.microsoftonline.com/common/oauth2/v2.0/token"`, `scope = "https://outlook.office365.com/.default offline_access"`. The hard-coding is acceptable for MVP and avoids new columns.)

In `EasSource::sync_folder`, after the first successful sync round, persist the policy key if Provision ran:
```rust
// (only if client.provision() was invoked — track via a flag returned from send_command,
// or simpler: persist unconditionally if config.policy_key differs from account.eas_policy_key)
if client.config.policy_key != self.account.eas_policy_key.clone().unwrap_or_default() {
    let mut upd = UpdateAccount::default();
    upd.eas_policy_key = Some(client.config.policy_key.clone());
    let _ = db::accounts::update_account(&self.pool, &self.account.id, upd).await;
}
```
(This requires `EasSource` to hold a `pool: DbPool`. Add it to the `EasSource::new` signature; update the engine call site. The ImapSource already does this — match its pattern.)

- [ ] **Step 4: Run — expect PASS** (decision-function tests) + full `cargo test --lib` no regressions. The integration (real Provision handshake) is covered by Task 7's manual e2e note.
- [ ] **Step 5: Commit** — `feat(eas): retry layer (Provision/OAuth-refresh/redirect) in send_command + EasSource auth wiring`.

---

## Task 6: Refactor `eas_source::classify_collection_status` to use `status.rs`

**Files:** `src/sync_engine/eas_source.rs`

**Interfaces:**
- Consumes: `crate::eas::status`.
- Produces: the local `CollectionStatusAction` enum is replaced (or thin-shims) by `status::RecoveryAction`. Removes the duplicate decision logic so there's exactly one status → action mapping.

- [ ] **Step 1: Failing test.** The existing tests in `eas_source::tests` (`classify_status_3_is_resync`, etc.) already pin the behavior. Keep them, but assert against the new `RecoveryAction`:
```rust
#[test]
fn classify_status_3_is_reset_sync_key() {
    assert_eq!(
        crate::eas::status::recovery_action_for_sync(3),
        crate::eas::status::RecoveryAction::ResetSyncKey
    );
}
```

- [ ] **Step 2: Run — expect FAIL** (the local `classify_collection_status` returns `CollectionStatusAction::Resync`, not `RecoveryAction::ResetSyncKey`).

- [ ] **Step 3: Implement.** Delete `CollectionStatusAction` and `classify_collection_status` from `eas_source.rs`. In `sync_folder`, change:
```rust
match crate::eas::status::recovery_action_for_sync(result.status) {
    crate::eas::status::RecoveryAction::ResetSyncKey |
    crate::eas::status::RecoveryAction::RunFolderSync => {
        // MVP: RunFolderSync degrades to cache-wipe+resync (same as 3a).
        return Ok(FolderDelta {
            added: vec![], updated: vec![], flag_updates: vec![],
            vanished_uids: vec![],
            next_cursor: Cursor::Eas { collection_id, sync_key: "0".into() },
            uidvalidity_changed: true,
        });
    }
    crate::eas::status::RecoveryAction::Ok => {}
    other => {
        return Err(SourceError::Other(format!("EAS sync status {} ({:?})", result.status, other)));
    }
}
```
Update the existing tests to assert on `RecoveryAction` (rename them).

- [ ] **Step 4: Run — expect PASS.** All `eas_source` tests green.
- [ ] **Step 5: Commit** — `refactor(eas): unify status recovery through status::recovery_action_for_sync`.

---

## Task 7: Integration tests + regression sweep

**Files:** tests inline in `eas/`, `eas/provision.rs`, `eas/auth.rs`, `eas/autodiscover.rs`

- [ ] **Step 1: End-to-end Provision WBXML round-trip.** Build Phase-1 request → serialize to WBXML bytes → deserialize → parse as if it were a server response (with hand-crafted Status/Policies) → assert the orchestrator logic. This proves the WBXML codec round-trips the Provision tree without needing a live server.
- [ ] **Step 2: Status-classifier exhaustive table test.** A single test enumerating every status code in the mapping table from the Global Constraints section, asserting each maps to the expected `RecoveryAction`. This is the contract test for `status.rs`.
- [ ] **Step 3: AutoDiscover fixture sweep.** Three V1 fixtures (server response, redirect response, error response) + one V2 JSON fixture, all parsed by the pure functions; assert outcomes.
- [ ] **Step 4: `eas_config` OAuth-build test.** With `account.auth_type = Some("oauth")` + token fields populated, assert `eas_config().auth` is `Some(EasAuth::OAuth { .. })` and `authorization_header()` starts with `"Bearer "`.
- [ ] **Step 5: Full regression.** `cargo test --lib` (expect all green) + `cargo clippy -- -D warnings` (expect clean) + `cd ../kylins.client.frontend && npx tsc --noEmit` (frontend unchanged — the `Account` type gains an optional field; check `types/index.ts` for a matching `auth_type?: string | null` addition if surfaced to the UI; if not surfaced, skip the frontend check).
- [ ] **Step 6: Commit** — `test(eas): integration fixtures + status contract + regression`.
- [ ] **Step 7: Manual e2e (documented).** Requires a real Exchange Online mailbox with modern auth + a registered AAD app. Steps: register a public client in AAD → add EAS account via AutoDiscover → observe Provision handshake in logs → verify `accounts.eas_policy_key` populated → verify Inbox syncs messages. Without this, the WBXML + classifier logic is unit-verified but the live transport path is not. Track in the memory ledger.

---

## Self-review notes

- **Scope coverage:**
  - status.rs (typed enums + recovery_action) → Task 1 ✅
  - Provision (two-phase + persist + X-MS-PolicyKey) → Task 2 ✅ (X-MS-PolicyKey header already sent by client.rs; Task 2 just populates the field)
  - OAuth modern auth (Bearer + refresh-on-401 + reuse `oauth_refresh_token` pattern) → Tasks 3 + 5 ✅
  - AutoDiscover (V1 POX + V2 JSON + 3-hop redirect) → Task 4 ✅
  - Retry-middleware wiring into client → Task 5 ✅
  - Integration tests → Task 7 ✅
  - Refactor of Phase 3a's `classify_collection_status` to use the new `status.rs` (single source of truth) → Task 6 ✅

- **Deferred (documented, NOT in scope):**
  - gzip (`Accept-Encoding: gzip` + `flate2`) — the transport does not advertise it; bodies are small for Sync envelopes. Add when a tenant starts returning gzipped responses.
  - Settings / MoveItems / Find / ResolveRecipients commands.
  - Calendar/Contacts/Task sync (EAS code pages 4/7/9) — separate plans.
  - WBXML debug translator (`<token 0x05 page 14>` → `"Provision"`).
  - Remote-wipe execution + UI dialog (we surface only).
  - V1 POX robust XML parsing (current impl is a tag-scan; `quick-xml` is a follow-up if servers emit CDATA/namespaces that break the scan).
  - HTTP 451 redirect *following* (the classification is wired; the actual URL swap is a stub returning the error — full handling needs the engine to re-issue AutoDiscover, deferred).
  - MoreAvailable tight loop (carried over from Phase 3a).
  - ServerId → uid map table (carried over from Phase 3a; needed before `deleted_server_ids` → `vanished_uids` is correct).
  - `oauth_client_id` / `oauth_token_url` / `oauth_scope` as proper `accounts` columns (MVP hard-codes M365 values; generalization is a follow-up).

- **Key decisions:**
  - **One retry per command** (not a tower). Bounds latency, keeps the code flat, matches the engine's 60s-poll-is-the-retry philosophy.
  - **`&mut self` on `EasClient` methods** (not `RwLock`). The mutation is explicit (Provision writes policy key; refresh writes access token); `EasSource` constructs a fresh client per call so the API change is local.
  - **Tag-scan XML parsing for AutoDiscover** (not `quick-xml`). The mobilesync response is server-controlled and stable; a dep to parse 3 tags is unjustified. Documented as a hardening follow-up.
  - **M365 OAuth constants hard-coded** for MVP (client_id, token_url, scope) to avoid new `accounts` columns. Generalization is a documented follow-up.
  - **`accounts.auth_type` is the only new column.** All other OAuth fields reuse existing `access_token`/`refresh_token` or hard-coded M365 defaults.

- **Type consistency:**
  - `RecoveryAction` is the single enum used by `client.rs` (HTTP layer, via `recovery_action_for_http`) and `eas_source.rs` (Sync status, via `recovery_action_for_sync`). Task 6 removes the duplicate `CollectionStatusAction`.
  - `EasAuth` flows: `EasConfig.auth: Option<EasAuth>` → `client.rs` calls `auth.authorization_header()` and `auth.refresh()`. `EasSource::eas_config` builds it from `Account`.
  - `ProvisionResult` flows: `provision::parse_provision_response` → `EasClient::provision` → mutates `self.config.policy_key` → `EasSource::sync_folder` persists via `UpdateAccount::eas_policy_key`.

- **Risk callouts:**
  - **Live Exchange Online testing is mandatory** before declaring Phase 3b done. The unit tests verify WBXML shape + classifier logic; only a real handshake validates protocol-version quirks (e.g. 14.1 vs 16.1 Provision differences), AAD token scopes, and AutoDiscover redirects. Task 7 Step 7 captures this.
  - **`&mut self` API breakage** in Task 5: any other caller of `EasClient::*` methods must be updated. Grep confirms `eas_source.rs` is the only call site (the `service.rs` shim is unused/legacy — verify before the commit).
  - **The migration is one-way** (ALTER TABLE ADD COLUMN). sqlx handles the rollback-free nature; the column is nullable so existing rows are unaffected.

---

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-06-30-sync-engine-phase3-eas-hardening.md`. Tasks are sequenced so each is independently mergeable and `cargo test --lib` is green at each boundary.

**Recommended execution: Subagent-Driven Development** (`superpowers:subagent-driven-development`).
- Spawn a fresh subagent per task (1 → 7). Each subagent gets the task's "Files / Interfaces / Step 1-5" section as its prompt plus this whole plan for context.
- Review checkpoint between tasks: the parent session reads the diff, runs `cargo test --lib`, and only then dispatches the next task.
- Task 6 is a pure refactor of Task 1's output — must run AFTER Task 1 (hard dependency).
- Task 5 depends on Tasks 1+2+3 (it wires them all into the client). Task 7 depends on all.
- Tasks 2, 3, 4 are independent and could theoretically be parallelized — BUT they all touch `mod.rs` and the `EasClient`/`EasConfig` surface, so sequential is safer (avoids merge conflicts in the same files).

**Alternative: Inline Execution** via `superpowers:executing-plans`, batched with checkpoints every 2 tasks. Lower overhead but no isolation between tasks.

Which approach?
