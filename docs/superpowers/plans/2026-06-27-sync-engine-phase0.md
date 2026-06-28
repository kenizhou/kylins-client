# Kylins Mail Sync Engine — Phase 0 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Rust the sole owner of the SQLite DB and build a polling `SyncEngine` behind a `MailSource` trait so that, after account setup, IMAP mail syncs and stays fresh via polling and the UI updates through Tauri events (no manual refresh).

**Architecture:** Add `sqlx` to the Rust backend and move all DB access from the frontend (`@tauri-apps/plugin-sql`) to Rust `db_*` Tauri commands (clean cut — frontend becomes a view layer). Then add a `MailSource` trait + `ImapSource`/`EasSource` adapters wrapping the existing protocol clients, resurrect the dead `folder_sync_state`/`eas_sync_state` cursor tables as Rust-owned delta cursors, and run a per-account `AccountWorker` (Tokio task, wakeable 60s poll) that syncs folders and emits coalesced `sync:*` Tauri events the frontend subscribes to.

**Tech Stack:** Rust (edition 2021, rust-version 1.77.2), Tauri 2.10, Tokio 1 (features already include `time`, `sync`, `macros`, `rt`), `sqlx` 0.8 (sqlite + runtime-tokio; **runtime queries only**, no compile-time `query!` macro / no offline cache), `async-imap` 0.10, existing `crypto::encrypt`/`decrypt` (AES-256-GCM + OS keyring), React 19 + Zustand 5 + Vitest 4 frontend.

## Global Constraints

- **DTO JSON shape:** every Rust struct returned to the frontend MUST derive `Serialize` with `#[serde(rename_all = "camelCase")]` so field names match the existing TS interfaces exactly (e.g. `displayName`, `accessToken`, `imapHost`). This is load-bearing — the frontend port keeps the same TS types.
- **Crypto:** account secret fields (`access_token`, `refresh_token`, `imap_password`, `oauth_client_secret`) are stored as hex `nonce||ciphertext`. Rust encrypts on write via `crate::crypto::encrypt(plaintext) -> Result<String,String>` and decrypts on read via `crate::crypto::decrypt(hex) -> Result<String,String>` (both sync, already exist at `src/crypto.rs:41`,`:58`). Plaintext must never be written to SQLite.
- **DB file:** reuse the existing user file `mailclient.db` in the app-data dir. The Rust baseline migration MUST be idempotent (`CREATE TABLE IF NOT EXISTS`, `INSERT OR IGNORE`) so it applies cleanly on top of a DB already populated by the old frontend migrations. Preserve EVERY existing table/column — do not drop or rename anything (existing users have data).
- **SQLite pragmas:** open with `journal_mode=WAL` and `busy_timeout=5000` (matches the old frontend `PRAGMA busy_timeout=5000`).
- **Auth-method tolerance:** the `accounts.auth_method` column default is `'oauth'` (migration v14) but the TS `AuthMethod` type is `'oauth2'`. Rust must accept both on read; do not "fix" the data.
- **No frontend DB writes after Task 5:** `@tauri-apps/plugin-sql` and `tauri-plugin-sql` are removed entirely (frontend + backend). All reads go through `db_*` commands; all writes go through Rust (commands or the engine).
- **FTS + triggers:** the schema has `messages_fts` and `events_fts` FTS5 virtual tables with sync triggers. Keep them in the baseline verbatim; do not recreate manually.
- **Scope:** Phase 0 only. Offline-op replay (Phase 1), IMAP IDLE / EAS Ping (Phase 2), Gmail-API/Graph/QRESYNC (Phase 3) are OUT OF SCOPE. Mutations in Phase 0 execute immediately via the source (no queue); `markThreadRead` server-push of `\Seen` is deferred to Phase 1.
- **Commit cadence:** one commit per task (or per step where noted). Run `cargo test --lib` and the frontend Vitest suite at each task boundary.
- **EAS caveat:** `eas::client::sync()` currently returns `SyncResult::default()` (WBXML Sync-response parsing is a TODO at `eas/client.rs:194-198`). So `EasSource.sync_folder` for messages is scaffolded but non-functional until that parser is implemented (Task 10, optional sub-step). IMAP end-to-end is the Phase 0 exit criterion.

---

## File Structure

**Backend (Rust) — new/modified:**
- `kylins.client.backend/Cargo.toml` — add `sqlx`, `async-trait`.
- `kylins.client.backend/migrations/20260627000001_baseline.sql` — consolidated idempotent schema (all tables).
- `kylins.client.backend/src/db/mod.rs` — `DbPool` type alias, `init_db(dir) -> Result<DbPool>`, PRAGMAs, migrate.
- `kylins.client.backend/src/db/accounts.rs` — account CRUD + crypto + exact column mapping.
- `kylins.client.backend/src/db/settings.rs` — settings KV.
- `kylins.client.backend/src/db/labels.rs` — folders read/write.
- `kylins.client.backend/src/db/threads.rs` — thread/message reads + keyset pagination.
- `kylins.client.backend/src/db/message_bodies.rs` — body get/set.
- `kylins.client.backend/src/db/sync_state.rs` — folder_sync_state / eas_sync_state cursors + monotonic/gap/UIDVALIDITY.
- `kylins.client.backend/src/db/messages.rs` — `apply_folder_delta` (the Rust `upsertImapMessages`).
- `kylins.client.backend/src/sync_engine/mod.rs` — `MailSource` trait, `Capabilities`, `Cursor`, `FolderDelta`, `RemoteFolder`, `RemoteMessage`, factory.
- `kylins.client.backend/src/sync_engine/imap_source.rs` — `ImapSource` adapter.
- `kylins.client.backend/src/sync_engine/eas_source.rs` — `EasSource` adapter (scaffolding).
- `kylins.client.backend/src/sync_engine/engine.rs` — `SyncEngine` singleton + `AccountWorker` (polling) + events.
- `kylins.client.backend/src/sync_engine/commands.rs` — `sync_start/stop/account_now/request_bodies` + all `db_*` command re-exports.
- `kylins.client.backend/src/lib.rs` — init `DbPool`, manage as State, start `SyncEngine`, register new commands; REMOVE `tauri_plugin_sql`.
- `kylins.client.backend/src/mail/imap/client.rs` — add `capabilities()` (CAPABILITY negotiation) + a `connect_returning_caps` helper (minimal edit).

**Frontend — modified (become invoke wrappers; signatures/types unchanged):**
- `src/services/db/connection.ts` — DELETE (or reduce to a no-op export) after cutover.
- `src/services/db/{threads,messageBodies,labels}.rs-equiv.ts`, `src/services/accounts.ts`, `src/services/settings.ts` — bodies become `invoke('db_*')`.
- `src/services/mail/{provider,imapProvider,easProvider,folderSync}.ts` — providers collapse to thin `invoke` wrappers or are deleted; `folderSync.ts` removed.
- `src/services/queue/offlineQueue.ts` — body becomes `invoke` wrapper (kept for Phase 1).
- `src/stores/{folderStore,threadStore,accountStore}.ts` — unchanged shapes; loaders now call the wrapper fns; add event-driven invalidation.
- `src/hooks/useSyncEvents.ts` — NEW: subscribes to `sync:*` events.
- `src/App.tsx` — `invoke('sync_start')` after accounts load; remove `runMigrations`.
- `src/components/account-setup/AccountSetupFlow.tsx` — `invoke('sync_account_now')` on setup done (replaces `folderSync.ts` calls).
- `tests/**` — mocks updated (keep service-boundary mocking convention).
- `package.json` — remove `@tauri-apps/plugin-sql`.

---

## Task 1: Add sqlx, port schema baseline, init DbPool

**Files:**
- Modify: `kylins.client.backend/Cargo.toml`
- Create: `kylins.client.backend/migrations/20260627000001_baseline.sql`
- Create: `kylins.client.backend/src/db/mod.rs`
- Modify: `kylins.client.backend/src/lib.rs`
- Test: `kylins.client.backend/src/db/mod.rs` (`#[cfg(test)]`)

**Interfaces:**
- Produces: `pub type DbPool = SqlitePool;` and `pub async fn init_db(dir: &Path) -> Result<DbPool, sqlx::Error>` in `crate::db`. Later tasks depend on `DbPool`.

- [ ] **Step 1: Add dependencies**

Edit `kylins.client.backend/Cargo.toml` `[dependencies]`, add:
```toml
sqlx = { version = "0.8", default-features = false, features = ["runtime-tokio", "sqlite", "macros", "chrono"] }
async-trait = "0.1"
```
(We use `chrono` only if needed for `FromRow`; if unused later, drop it. `macros` gives `query_as!`-adjacent helpers we won't compile-time-use, but `FromRow` derive needs it.)

- [ ] **Step 2: Create the baseline migration**

Create `kylins.client.backend/migrations/20260627000001_baseline.sql`. This is the consolidated schema from the frontend's 35 migrations, made idempotent. Include EVERY table. The authoritative column lists are in `docs/mail-sync-engine-research.md` and the extraction report; reproduce them verbatim with `IF NOT EXISTS`. Skeleton (fill every table from the extraction report's "Consolidated current schema" section — do NOT abbreviate):

```sql
-- Baseline schema for Kylins Client. Idempotent: safe to apply on top of a DB
-- already populated by the legacy frontend migrations.
PRAGMA foreign_keys = ON;
PRAGMA journal_mode = WAL;

CREATE TABLE IF NOT EXISTS _migrations (
  version INTEGER PRIMARY KEY,
  description TEXT,
  applied_at INTEGER DEFAULT (unixepoch())
);

CREATE TABLE IF NOT EXISTS accounts (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  display_name TEXT,
  avatar_url TEXT,
  access_token TEXT,
  refresh_token TEXT,
  token_expires_at INTEGER,
  history_id TEXT,
  last_sync_at INTEGER,
  is_active INTEGER DEFAULT 1,
  created_at INTEGER DEFAULT (unixepoch()),
  updated_at INTEGER DEFAULT (unixepoch()),
  provider TEXT DEFAULT 'gmail_api',
  imap_host TEXT, imap_port INTEGER, imap_security TEXT,
  smtp_host TEXT, smtp_port INTEGER, smtp_security TEXT,
  auth_method TEXT DEFAULT 'oauth',
  imap_password TEXT,
  oauth_provider TEXT, oauth_client_id TEXT, oauth_client_secret TEXT,
  imap_username TEXT,
  caldav_url TEXT, caldav_username TEXT, caldav_password TEXT,
  caldav_principal_url TEXT, caldav_home_url TEXT, calendar_provider TEXT,
  accept_invalid_certs INTEGER DEFAULT 0,
  eas_url TEXT, eas_protocol_version TEXT DEFAULT '16.1',
  eas_device_id TEXT, eas_policy_key TEXT, eas_user_agent TEXT,
  account_label TEXT, setup_provider_id TEXT,
  is_default INTEGER DEFAULT 0, sort_order INTEGER DEFAULT 0
);

CREATE TABLE IF NOT EXISTS labels (
  id TEXT NOT NULL,
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  type TEXT NOT NULL,
  color_bg TEXT, color_fg TEXT,
  visible INTEGER DEFAULT 1,
  sort_order INTEGER DEFAULT 0,
  imap_folder_path TEXT, imap_special_use TEXT,
  source TEXT NOT NULL DEFAULT 'local',
  role TEXT, parent_id TEXT, remote_id TEXT, delimiter TEXT,
  mail_class TEXT NOT NULL DEFAULT 'mail',
  unread_count INTEGER NOT NULL DEFAULT 0,
  total_count INTEGER NOT NULL DEFAULT 0,
  hierarchical_name TEXT,
  PRIMARY KEY (account_id, id)
);
CREATE INDEX IF NOT EXISTS idx_labels_account ON labels(account_id);
CREATE INDEX IF NOT EXISTS idx_labels_role ON labels(account_id, role);
CREATE INDEX IF NOT EXISTS idx_labels_parent ON labels(account_id, parent_id);

CREATE TABLE IF NOT EXISTS threads (
  id TEXT NOT NULL,
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  subject TEXT, snippet TEXT,
  last_message_at INTEGER,
  message_count INTEGER DEFAULT 0,
  is_read INTEGER DEFAULT 0, is_starred INTEGER DEFAULT 0,
  is_important INTEGER DEFAULT 0, has_attachments INTEGER DEFAULT 0,
  is_snoozed INTEGER DEFAULT 0, snooze_until INTEGER,
  is_pinned INTEGER DEFAULT 0, is_muted INTEGER DEFAULT 0,
  classification_id TEXT, is_encrypted INTEGER DEFAULT 0, is_signed INTEGER DEFAULT 0,
  PRIMARY KEY (account_id, id)
);
CREATE INDEX IF NOT EXISTS idx_threads_cursor ON threads(account_id, last_message_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_threads_snoozed ON threads(account_id, is_snoozed);
CREATE INDEX IF NOT EXISTS idx_threads_pinned ON threads(account_id, is_pinned);
CREATE INDEX IF NOT EXISTS idx_threads_muted ON threads(account_id, is_muted);

CREATE TABLE IF NOT EXISTS thread_labels (
  thread_id TEXT NOT NULL, account_id TEXT NOT NULL, label_id TEXT NOT NULL,
  PRIMARY KEY (account_id, thread_id, label_id),
  FOREIGN KEY (account_id, thread_id) REFERENCES threads(account_id, id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_thread_labels_label ON thread_labels(account_id, label_id);

CREATE TABLE IF NOT EXISTS messages (
  id TEXT NOT NULL,
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  thread_id TEXT NOT NULL,
  from_address TEXT, from_name TEXT,
  to_addresses TEXT, cc_addresses TEXT, bcc_addresses TEXT, reply_to TEXT,
  subject TEXT, snippet TEXT,
  date INTEGER NOT NULL,
  is_read INTEGER DEFAULT 0, is_starred INTEGER DEFAULT 0,
  body_html TEXT, body_text TEXT, body_cached INTEGER DEFAULT 0,
  raw_size INTEGER, internal_date INTEGER,
  list_unsubscribe TEXT, list_unsubscribe_post TEXT, auth_results TEXT,
  message_id_header TEXT, references_header TEXT, in_reply_to_header TEXT,
  imap_uid INTEGER, imap_folder TEXT,
  classification_id TEXT, is_encrypted INTEGER DEFAULT 0, is_signed INTEGER DEFAULT 0,
  PRIMARY KEY (account_id, id),
  FOREIGN KEY (account_id, thread_id) REFERENCES threads(account_id, id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_messages_thread ON messages(account_id, thread_id);
CREATE INDEX IF NOT EXISTS idx_messages_date ON messages(account_id, date);
CREATE INDEX IF NOT EXISTS idx_messages_from ON messages(account_id, from_address);
CREATE INDEX IF NOT EXISTS idx_messages_imap_uid ON messages(account_id, imap_folder, imap_uid);
CREATE INDEX IF NOT EXISTS idx_messages_message_id ON messages(message_id_header);

CREATE TABLE IF NOT EXISTS message_bodies (
  account_id TEXT NOT NULL,
  message_id TEXT NOT NULL,
  body_html TEXT,
  fetched_at INTEGER DEFAULT (unixepoch()),
  PRIMARY KEY (account_id, message_id),
  FOREIGN KEY (account_id, message_id) REFERENCES messages(account_id, id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS folder_sync_state (
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  folder_path TEXT NOT NULL,
  uidvalidity INTEGER, last_uid INTEGER DEFAULT 0, modseq INTEGER,
  last_sync_at INTEGER,
  PRIMARY KEY (account_id, folder_path)
);

CREATE TABLE IF NOT EXISTS eas_sync_state (
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  folder_id TEXT NOT NULL,
  collection_id TEXT, sync_key TEXT, policy_key TEXT, last_sync_at INTEGER,
  PRIMARY KEY (account_id, folder_id)
);
CREATE INDEX IF NOT EXISTS idx_eas_sync_account ON eas_sync_state(account_id);

CREATE TABLE IF NOT EXISTS pending_operations (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  operation_type TEXT NOT NULL,
  resource_id TEXT NOT NULL,
  params TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  retry_count INTEGER DEFAULT 0,
  max_retries INTEGER DEFAULT 10,
  next_retry_at INTEGER,
  created_at INTEGER DEFAULT (unixepoch()),
  error_message TEXT
);
CREATE INDEX IF NOT EXISTS idx_pending_ops_status ON pending_operations(status, next_retry_at);
CREATE INDEX IF NOT EXISTS idx_pending_ops_resource ON pending_operations(account_id, resource_id);

CREATE TABLE IF NOT EXISTS local_drafts (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  to_addresses TEXT, cc_addresses TEXT, bcc_addresses TEXT,
  subject TEXT, body_html TEXT,
  reply_to_message_id TEXT, thread_id TEXT, from_email TEXT, signature_id TEXT,
  remote_draft_id TEXT, attachments TEXT,
  created_at INTEGER DEFAULT (unixepoch()),
  updated_at INTEGER DEFAULT (unixepoch()),
  sync_status TEXT DEFAULT 'pending',
  classification_id TEXT, is_encrypted INTEGER DEFAULT 0, is_signed INTEGER DEFAULT 0
);

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS contact_sync_state (
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  source TEXT NOT NULL,
  sync_token TEXT, last_sync_at INTEGER,
  PRIMARY KEY (account_id, source)
);

-- FTS5 (messages). Keep the external-content table + 3 triggers verbatim from
-- the legacy migration v2. If messages_fts already exists this is a no-op.
CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(
  subject, from_name, from_address, body_text, snippet,
  content='messages', content_rowid='rowid', tokenize='trigram'
);
-- (Triggers messages_ai / messages_ad / messages_au: recreate IF NOT EXISTS.
--  Copy verbatim from legacy migration v2 in the frontend migrations.ts.)
```

> NOTE to executor: also create `calendars`, `calendar_events` + `events_fts`, `attachments`, `contacts`, `contact_groups`, `contact_group_members`, `signatures`, `scheduled_emails`, `filter_rules`, `templates`, `image_allowlist`, `ai_cache`, `thread_categories`, `follow_up_reminders`, `notification_vips`, `unsubscribe_actions`, `bundle_rules`, `bundled_threads`, `send_as_aliases`, `smart_folders`, `quick_steps`, `writing_style_profiles`, `tasks`, `task_tags`, `smart_label_rules`, `plugin_state`, `message_metadata`, `link_scan_results`, `phishing_allowlist` from the extraction report's per-table column lists, all `IF NOT EXISTS`. Copy the FTS triggers verbatim. This is mechanical reproduction of known SQL, not new design.

- [ ] **Step 3: Create `src/db/mod.rs`**

```rust
pub mod accounts;
pub mod settings;
pub mod labels;
pub mod threads;
pub mod message_bodies;
pub mod sync_state;
pub mod messages;

use std::path::Path;
use sqlx::{
    sqlite::{SqliteConnectOptions, SqlitePoolOptions},
    SqlitePool,
};

pub type DbPool = SqlitePool;

/// Open (or create) the mailclient.db in `dir`, set WAL + busy_timeout, run
/// migrations. Idempotent — safe on an already-populated DB.
pub async fn init_db(dir: &Path) -> Result<DbPool, sqlx::Error> {
    std::fs::create_dir_all(dir).ok();
    let db_path = dir.join("mailclient.db");
    let opts = SqliteConnectOptions::new()
        .filename(&db_path)
        .create_if_missing(true)
        .journal_mode(sqlx::sqlite::SqliteJournalMode::Wal)
        .busy_timeout(std::time::Duration::from_secs(5))
        .foreign_keys(true);
    let pool = SqlitePoolOptions::new()
        .max_connections(5)
        .connect_with(opts)
        .await?;
    sqlx::migrate!("./migrations").run(&pool).await?;
    Ok(pool)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[tokio::test]
    async fn migrations_apply_and_create_tables() {
        let tmp = tempfile::tempdir().unwrap(); // add `tempfile` to dev-deps (Step 4)
        let pool = init_db(tmp.path()).await.unwrap();
        let row: (i64,) = sqlx::query_as("SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name='accounts'")
            .fetch_one(&pool).await.unwrap();
        assert!(row.0 >= 1);
        let row: (i64,) = sqlx::query_as("SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name='folder_sync_state'")
            .fetch_one(&pool).await.unwrap();
        assert_eq!(row.0, 1);
        // Idempotent re-run must not error:
        sqlx::migrate!("./migrations").run(&pool).await.unwrap();
    }
}
```

- [ ] **Step 4: Add `tempfile` dev-dependency + register submodules**

`Cargo.toml` `[dev-dependencies]`: add `tempfile = "3"`.

Create empty stub files `src/db/accounts.rs`, `settings.rs`, `labels.rs`, `threads.rs`, `message_bodies.rs`, `sync_state.rs`, `messages.rs` — each just a module comment line (filled in later tasks). If `mod.rs` declares them, they must exist for compilation.

- [ ] **Step 5: Wire `init_db` into Tauri setup**

Edit `src/lib.rs`: add `pub mod db;` to the module declarations (around `lib.rs:12-17`). In `.setup(|app| { ... })` (around `lib.rs:109`), before the tray code, add:
```rust
let data_dir = app.path().app_data_dir().expect("app data dir");
let pool = kylins_client_lib::db::init_db(&data_dir)
    .await
    .expect("db init");
app.manage(pool);
```
(The setup closure must be `async` — Tauri 2 `setup` runs sync; if needed, wrap in `tauri::async_runtime::block_on(async move { ... })`. Use the pattern already used elsewhere in `lib.rs` if async setup exists; otherwise use `tauri::async_runtime::block_on`.)

- [ ] **Step 6: Run tests**

```bash
cd kylins.client.backend
cargo test --lib db::tests
cargo build
```
Expected: the migration test passes; build succeeds.

- [ ] **Step 7: Commit**
```bash
git add kylins.client.backend/Cargo.toml kylins.client.backend/Cargo.lock kylins.client.backend/migrations kylins.client.backend/src/db kylins.client.backend/src/lib.rs
git commit -m "feat(db): add sqlx, baseline schema migration, DbPool init"
```

---

## Task 2: `db::accounts` module + commands (exact column mapping + crypto)

**Files:**
- Create: `kylins.client.backend/src/db/accounts.rs`
- Modify: `kylins.client.backend/src/sync_engine/commands.rs` (create file; or put commands in `src/commands.rs` — choose `src/db/commands.rs` and declare `pub mod commands;` in `db/mod.rs`)
- Modify: `kylins.client.backend/src/lib.rs` (register commands)

**Interfaces:**
- Consumes: `crate::db::DbPool`, `crate::crypto::{encrypt, decrypt}`.
- Produces: Tauri commands `db_get_all_accounts`, `db_get_account_by_id`, `db_get_account_by_email`, `db_create_account`, `db_update_account`, `db_delete_account`, `db_delete_account_by_email`, `db_get_account_count`, `db_set_default_account`, `db_get_default_account`, each returning the same JSON shape the TS `Account`/`CreateAccountInput` expect (camelCase via serde).

> **Exact snake→camel mapping** (from `services/accounts.ts:18-65`). The `Account` Rust struct MUST reproduce this. Secret fields decrypt on read / encrypt on write:
>
> id, email, displayName←display_name, accountLabel←account_label, avatarUrl←avatar_url, provider, setupProviderId←setup_provider_id, accessToken←access_token(DECRYPT), refreshToken←refresh_token(DECRYPT), tokenExpiresAt←token_expires_at, historyId←history_id, lastSyncAt←last_sync_at, isActive←is_active(==1), isDefault←is_default(==1), sortOrder←sort_order(??0), createdAt←created_at, updatedAt←updated_at, imapHost←imap_host, imapPort←imap_port, imapSecurity←imap_security, smtpHost←smtp_host, smtpPort←smtp_port, smtpSecurity←smtp_security, authMethod←auth_method, imapPassword←imap_password(DECRYPT), imapUsername←imap_username, oauthProvider←oauth_provider, oauthClientId←oauth_client_id, oauthClientSecret←oauth_client_secret(DECRYPT), acceptInvalidCerts←accept_invalid_certs(==1), easUrl←eas_url, easProtocolVersion←eas_protocol_version, easDeviceId←eas_device_id, easPolicyKey←eas_policy_key, easUserAgent←eas_user_agent.
> Columns NOT mapped (skip): caldav_*, calendar_provider.

- [ ] **Step 1: Write the `Account` / `CreateAccountInput` / `AccountUpdates` DTOs + the failing test**

In `src/db/accounts.rs`:
```rust
use serde::{Deserialize, Serialize};
use sqlx::{sqlite::SqliteRow, Row, SqlitePool};
use crate::crypto::{encrypt, decrypt};

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct Account {
    pub id: String,
    pub email: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub display_name: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub account_label: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub avatar_url: Option<String>,
    pub provider: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub setup_provider_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub access_token: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub refresh_token: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub token_expires_at: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub history_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_sync_at: Option<i64>,
    pub is_active: bool,
    pub is_default: bool,
    #[serde(default)]
    pub sort_order: i64,
    pub created_at: i64,
    pub updated_at: i64,
    // imap/smtp/eas/oauth fields — same Option<String>/i64 pattern as above;
    // reproduce the full mapping table from the task header.
    #[serde(default, skip_serializing_if = "Option::is_none")] pub imap_host: Option<String>,
    #[serde(default)] pub imap_port: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")] pub imap_security: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")] pub smtp_host: Option<String>,
    #[serde(default)] pub smtp_port: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")] pub smtp_security: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")] pub auth_method: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")] pub imap_password: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")] pub imap_username: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")] pub oauth_provider: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")] pub oauth_client_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")] pub oauth_client_secret: Option<String>,
    pub accept_invalid_certs: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")] pub eas_url: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")] pub eas_protocol_version: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")] pub eas_device_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")] pub eas_policy_key: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")] pub eas_user_agent: Option<String>,
}

/// Deserialize-driven create input (camelCase from frontend CreateAccountInput).
#[derive(Debug, Clone, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct CreateAccountInput {
    pub email: String,
    pub provider: String,
    // ...every field of CreateAccountInput from services/accounts.ts:67-97 as Option<T>.
    #[serde(default)] pub display_name: Option<String>,
    #[serde(default)] pub imap_host: Option<String>,
    #[serde(default)] pub imap_port: Option<i64>,
    // (reproduce all 30 fields)
}
```

> Executor: reproduce ALL `CreateAccountInput` fields from `kylins.client.frontend/src/services/accounts.ts:67-97` and ALL `Account` fields per the mapping table. The above is the pattern; do not omit fields.

Failing test (`#[cfg(test)] mod tests`) using a temp pool:
```rust
#[tokio::test]
async fn create_and_read_account_roundtrips_secrets_encrypted() {
    let tmp = tempfile::tempdir().unwrap();
    let pool = crate::db::init_db(tmp.path()).await.unwrap();
    let created = create_account(&pool, CreateAccountInput {
        email: "e@x.com".into(), provider: "imap".into(),
        imap_password: Some("secret".into()),
        access_token: Some("tok".into()),
        ..Default::default()
    }).await.unwrap();
    assert_eq!(created.email, "e@x.com");
    assert_eq!(created.imap_password.as_deref(), Some("secret")); // decrypted on read
    // Stored cipher must not be plaintext:
    let (cipher,): (String,) = sqlx::query_as("SELECT imap_password FROM accounts WHERE id=$1")
        .bind(&created.id).fetch_one(&pool).await.unwrap();
    assert!(!cipher.contains("secret"));
}
```

- [ ] **Step 2: Run the test — expect FAIL** (`create_account` undefined).

```bash
cargo test --lib db::accounts::tests
```

- [ ] **Step 3: Implement read mapping + CRUD**

In `src/db/accounts.rs`, implement `row_to_account(row: &SqliteRow) -> Account` (decrypt the 4 secret fields; on decrypt failure return a minimal `{id, email, provider}` stub — replicate the corrupt-row behavior). Then implement:
- `pub async fn get_all(pool) -> Result<Vec<Account>, String>` — `SELECT * FROM accounts ORDER BY created_at DESC`; use `Promise.allSettled`-equivalent: skip rows that fail to decrypt (collect successes).
- `pub async fn get_by_id(pool, id) -> Result<Option<Account>, String>`
- `pub async fn get_by_email(pool, email) -> Result<Option<Account>, String>` — on decrypt failure return the stub (so duplicate-check sees it).
- `pub async fn create(pool, input) -> Result<Account, String>` — pre-check duplicate via `get_by_email`; encrypt the 4 secrets via `encrypt(...)?`; INSERT with `uuid::Uuid::new_v4()` id + `unixepoch()`; auto-set `is_default=1` if `get_count == 0`; then `get_by_id` and return.
- `pub async fn update(pool, id, updates: AccountUpdates) -> Result<(), String>` — dynamic UPDATE over the 30-field map (reproduce `accounts.ts:271-309`); re-encrypt secrets; stamp `updated_at`.
- `pub async fn delete(pool, id) -> Result<(), String>`
- `pub async fn delete_by_email(pool, email) -> Result<(), String>`
- `pub async fn get_count(pool) -> Result<i64, String>`
- `pub async fn set_default(pool, id) -> Result<(), String>` — tx: `UPDATE accounts SET is_default=0` then `... SET is_default=1, updated_at=unixepoch() WHERE id=?`.
- `pub async fn get_default(pool) -> Result<Option<Account>, String>`

Example `create`:
```rust
pub async fn create(pool: &SqlitePool, input: CreateAccountInput) -> Result<Account, String> {
    if let Some(existing) = get_by_email(pool, &input.email).await? {
        return Err(format!("An account for {} already exists.", input.email));
    }
    let id = uuid::Uuid::new_v4().to_string();
    let count = get_count(pool).await?;
    let is_default = input.is_default.unwrap_or(count == 0);
    let access_token = enc_opt(input.access_token.as_deref())?;
    let refresh_token = enc_opt(input.refresh_token.as_deref())?;
    let imap_password = enc_opt(input.imap_password.as_deref())?;
    let oauth_client_secret = enc_opt(input.oauth_client_secret.as_deref())?;
    sqlx::query(
      "INSERT INTO accounts (id, email, display_name, provider, imap_host, imap_port, imap_security,
         smtp_host, smtp_port, smtp_security, auth_method, imap_password, imap_username,
         access_token, refresh_token, oauth_provider, oauth_client_id, oauth_client_secret,
         token_expires_at, accept_invalid_certs, eas_url, eas_protocol_version, eas_device_id,
         eas_policy_key, eas_user_agent, account_label, setup_provider_id, is_default, sort_order,
         is_active, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,1,unixepoch(),unixepoch())"
    )
    .bind(&id).bind(&input.email).bind(input.display_name).bind(&input.provider)
    .bind(input.imap_host).bind(input.imap_port).bind(input.imap_security)
    .bind(input.smtp_host).bind(input.smtp_port).bind(input.smtp_security)
    .bind(input.auth_method).bind(&imap_password).bind(input.imap_username)
    .bind(&access_token).bind(&refresh_token).bind(input.oauth_provider)
    .bind(input.oauth_client_id).bind(&oauth_client_secret)
    .bind(input.token_expires_at).bind(input.accept_invalid_certs.unwrap_or(false))
    .bind(input.eas_url).bind(input.eas_protocol_version).bind(input.eas_device_id)
    .bind(input.eas_policy_key).bind(input.eas_user_agent)
    .bind(input.account_label).bind(input.setup_provider_id)
    .bind(is_default).bind(input.sort_order.unwrap_or(0))
    .execute(pool).await.map_err(|e| e.to_string())?;
    get_by_id(pool, &id).await?.ok_or("insert failed".into())
}
fn enc_opt(s: Option<&str>) -> Result<Option<String>, String> {
    match s { Some(v) => encrypt(v).map(Some), None => Ok(None) }
}
```
(`is_active` and `account_label`/`setup_provider_id`/`is_default`/`sort_order` may need adding to `CreateAccountInput` to match the TS 30-field set — reproduce faithfully.)

- [ ] **Step 4: Run test — expect PASS**

```bash
cargo test --lib db::accounts::tests
```

- [ ] **Step 5: Expose as Tauri commands**

Create `src/db/commands.rs` (declare `pub mod commands;` in `db/mod.rs`):
```rust
use tauri::State;
use sqlx::SqlitePool;
use super::accounts::*;

#[tauri::command]
pub async fn db_get_all_accounts(pool: State<'_, SqlitePool>) -> Result<Vec<Account>, String> {
    accounts::get_all(&pool).await
}
#[tauri::command]
pub async fn db_get_account_by_id(pool: State<'_, SqlitePool>, id: String) -> Result<Option<Account>, String> {
    accounts::get_by_id(&pool, &id).await
}
#[tauri::command]
pub async fn db_create_account(pool: State<'_, SqlitePool>, input: CreateAccountInput) -> Result<Account, String> {
    accounts::create(&pool, input).await
}
#[tauri::command]
pub async fn db_update_account(pool: State<'_, SqlitePool>, id: String, updates: AccountUpdates) -> Result<(), String> {
    accounts::update(&pool, &id, updates).await
}
#[tauri::command]
pub async fn db_delete_account(pool: State<'_, SqlitePool>, id: String) -> Result<(), String> {
    accounts::delete(&pool, &id).await
}
#[tauri::command]
pub async fn db_delete_account_by_email(pool: State<'_, SqlitePool>, email: String) -> Result<(), String> {
    accounts::delete_by_email(&pool, &email).await
}
#[tauri::command]
pub async fn db_get_account_count(pool: State<'_, SqlitePool>) -> Result<i64, String> {
    accounts::get_count(&pool).await
}
#[tauri::command]
pub async fn db_set_default_account(pool: State<'_, SqlitePool>, id: String) -> Result<(), String> {
    accounts::set_default(&pool, &id).await
}
#[tauri::command]
pub async fn db_get_default_account(pool: State<'_, SqlitePool>) -> Result<Option<Account>, String> {
    accounts::get_default(&pool).await
}
#[tauri::command]
pub async fn db_get_account_by_email(pool: State<'_, SqlitePool>, email: String) -> Result<Option<Account>, String> {
    accounts::get_by_email(&pool, &email).await
}
```
(Adjust `use super::accounts::*;` if `accounts` is also a module name clash — use fully-qualified `crate::db::accounts::...` if needed.)

- [ ] **Step 6: Register commands in `lib.rs` `generate_handler!`**

Add the 10 `db::*` commands to the list at `lib.rs:57-108`.

- [ ] **Step 7: Build + test**
```bash
cargo build && cargo test --lib db::accounts
```

- [ ] **Step 8: Commit**
```bash
git add kylins.client.backend/src/db kylins.client.backend/src/lib.rs
git commit -m "feat(db): accounts CRUD + crypto-backed secrets as db_* commands"
```

---

## Task 3: `db::settings` + `db::labels` modules + commands

**Files:** `src/db/settings.rs`, `src/db/labels.rs`, `src/db/commands.rs`, `src/lib.rs`.
**Interfaces:** Produces commands `db_get_setting`, `db_set_setting`, `db_get_folders_by_account`, `db_get_all_folders`, `db_get_folder_by_role`, `db_get_unread_counts_by_account`, `db_upsert_folders`, `db_create_folder`, `db_rename_folder`, `db_delete_folder`.

> Reproduce the exact SQL from the extraction report:
> - settings: `SELECT value FROM settings WHERE key=$1`; `INSERT OR REPLACE INTO settings(key,value) VALUES($1,$2)`.
> - labels: `getFoldersByAccount` = `SELECT * FROM labels WHERE account_id=$1 AND mail_class='mail' AND visible=1`; `getUnreadCountsByAccount` = the thread_labels JOIN query; `upsertFolders` = the 13-column INSERT with `ON CONFLICT(account_id,id) DO UPDATE SET ...`.
> - The `MailFolder` Rust DTO (`#[serde(rename_all="camelCase")]`) mirrors `services/mail/folders/folderModel.ts:29-54`.

- [ ] **Step 1: Write failing tests** — settings round-trip; upsertFolders then getFoldersByAccount returns them; unread counts query.
- [ ] **Step 2: Run — expect FAIL.**
- [ ] **Step 3: Implement** `settings::{get,set,get_bool,set_bool,get_number,set_number}` and `labels::{get_folders_by_account, get_all_folders, get_folder_by_role, get_unread_counts_by_account, upsert_folders, create_folder, rename_folder, delete_folder}`. Map rows → `MailFolder` DTO (snake→camel, `visible==1`, `unread_count`/`total_count` defaults 0). `delete_folder` runs in a tx: delete thread_labels then labels (no FK to labels — replicate `labels.ts:228`).
- [ ] **Step 4: Run — expect PASS.**
- [ ] **Step 5: Add commands** `db_*` in `src/db/commands.rs` + register in `lib.rs`.
- [ ] **Step 6: Build + test.**
- [ ] **Step 7: Commit** — `feat(db): settings + labels (folders) db_* commands`.

---

## Task 4: `db::threads` (reads) + `db::message_bodies` + commands

**Files:** `src/db/threads.rs`, `src/db/message_bodies.rs`, `src/db/commands.rs`, `src/lib.rs`.
**Interfaces:** Produces commands `db_get_threads`, `db_get_messages_for_thread`, `db_mark_thread_read`, `db_get_message_body`, `db_set_message_body`.

> Reproduce `getThreads` keyset SQL verbatim (extraction report §threads): the `(last_message_at, id)` cursor WHERE clause, the LEFT JOIN messages for latest from_name/from_address, optional INNER JOIN thread_labels when `label_id` is set, `LIMIT $p`. `Thread` DTO mirrors `services/db/threads.ts:11-28` (camelCase). `markThreadRead` = the tx updating threads+messages.

- [ ] **Step 1: Write failing tests** — seed a thread+message+thread_label, assert `get_threads(account, {label_id})` returns it with `from_address`; assert keyset cursor returns next page; assert `mark_thread_read` flips `is_read`; assert message_body round-trip.
- [ ] **Step 2: Run — expect FAIL.**
- [ ] **Step 3: Implement** `threads::{get_threads, get_messages_for_thread, mark_thread_read}` and `message_bodies::{get_message_body, set_message_body, evict_body}`. The `GetThreadsOptions { label_id: Option<String>, limit: Option<i64>, cursor: Option<(i64,String)> }` mirrors TS.
- [ ] **Step 4: Run — expect PASS.**
- [ ] **Step 5: Add commands** + register.
- [ ] **Step 6: Build + test.**
- [ ] **Step 7: Commit** — `feat(db): threads/message reads + mark-read db_* commands`.

---

## Task 5: Frontend DB cutover — invoke wrappers, remove plugin-sql

**Files:** `src/services/db/connection.ts` (delete), `src/services/db/threads.ts`, `src/services/db/messageBodies.ts`, `src/services/db/labels.ts`, `src/services/accounts.ts`, `src/services/settings.ts`, `src/services/queue/offlineQueue.ts`, `src/services/mail/{provider,imapProvider,easProvider,folderSync}.ts`, `src/App.tsx`, `src/stores/*` (loaders unchanged signatures), `tests/**`, `package.json`, backend `Cargo.toml` + `lib.rs`.

**Interfaces:** Consumes all `db_*` commands from Tasks 2–4. Produces: frontend that performs NO direct SQL. `tauri-plugin-sql` removed frontend + backend.

> Strategy: preserve every TS function signature and the TS types (`Account`, `MailFolder`, `Thread`, `ImapMessage`, `CreateAccountInput`). Only the function BODIES change from `db.select(...)` / `db.execute(...)` to `invoke('db_<name>', {...})`. Stores stay byte-for-byte identical.

- [ ] **Step 1: Add a shared invoke-mock test helper**

Create `src/test/mockInvoke.ts`:
```ts
import { vi } from 'vitest';
export function mockInvoke(handlers: Record<string, (args: any) => unknown>) {
  const invoke = vi.fn(async (cmd: string, args?: Record<string, unknown>) => {
    const h = handlers[cmd];
    if (!h) throw new Error(`unexpected invoke ${cmd}`);
    return h(args ?? {});
  });
  vi.mock('@tauri-apps/api/core', () => ({ invoke }));
  return invoke;
}
```

- [ ] **Step 2: Rewrite `services/accounts.ts` bodies to invoke**

Keep the `Account`, `CreateAccountInput`, `AccountUpdates` types. Replace each fn body:
```ts
import { invoke } from '@tauri-apps/api/core';
export async function getAllAccounts(): Promise<Account[]> {
  return invoke<Account[]>('db_get_all_accounts');
}
export async function createAccount(input: CreateAccountInput): Promise<Account> {
  return invoke<Account>('db_create_account', { input });
}
export async function getAccountById(id: string) { return invoke<Account | null>('db_get_account_by_id', { id }); }
export async function deleteAccount(id: string) { return invoke<void>('db_delete_account', { id }); }
export async function deleteAccountByEmail(email: string) { return invoke<void>('db_delete_account_by_email', { email }); }
export async function updateAccount(id: string, updates: AccountUpdates) { return invoke<void>('db_update_account', { id, updates }); }
export async function setDefaultAccount(id: string) { return invoke<void>('db_set_default_account', { id }); }
export async function getDefaultAccount() { return invoke<Account | null>('db_get_default_account'); }
// Remove encrypt/decrypt usage — Rust handles crypto. Delete encryptSecret/decryptField helpers
// from this file (crypto.ts remains for other callers).
```
Delete the now-unused imports (`getDb`, `withTransaction`, `encryptSecret`, `decryptSecret`).

- [ ] **Step 3: Rewrite `services/settings.ts`, `services/db/threads.ts` (read fns), `services/db/messageBodies.ts`, `services/db/labels.ts` bodies to invoke**

Same pattern. e.g. `getThreads(accountId, opts)` → `invoke('db_get_threads', { accountId, labelId: opts.labelId ?? null, limit: opts.limit ?? null, cursor: opts.cursor ?? null })` returning `{ threads, nextCursor }`. Keep `mapMessageToMailMessage`/`parseAddresses` (pure, still used by threadStore) but they no longer touch the DB.

- [ ] **Step 4: Rewrite `services/queue/offlineQueue.ts` to invoke**

(Phase 0 keeps the queue storage commands even though the replay runner is Phase 1. If no Rust commands for pending_operations exist yet, add `db_enqueue_op`/`db_dequeue_pending`/`db_mark_op_completed`/`db_mark_op_failed` as a mini-extension in Task 3 or here — see note.) For Phase 0, since only `composer/send.ts` enqueues and nothing dequeues, you may leave `offlineQueue.ts` calling a new `db_*` command set; add those 4 commands to `db/commands.rs` reproducing the exact SQL from the extraction report (enqueue INSERT, dequeuePending SELECT, markCompleted DELETE, markFailed UPDATE with `60 * (1 << retry_count)` backoff).

- [ ] **Step 5: Collapse the mail providers / remove `folderSync.ts`**

Replace `services/mail/provider.ts`, `imapProvider.ts`, `easProvider.ts` usages in stores with direct `invoke('imap_*')`/`invoke('eas_*')` calls where still needed for Phase-0 mutations (send). Since the SyncEngine now owns folder/message sync, `folderSync.ts` is deleted and `folderStore.syncFolder` is changed to call `invoke('sync_account_now', { accountId })` (Task 10 wires the command). For Task 5, have `folderStore.syncFolder` temporarily call `invoke('sync_account_now', { accountId: folder.accountId })` — the command exists after Task 9; until then guard with a TODO or implement `sync_account_now` as a thin stub that returns immediately (filled in Task 9). **Simplest:** leave `folderStore.syncFolder` calling the (still-present) `imap_sync_folder`/`eas_sync` count path for now and rewire in Task 10. Keep the app building.

- [ ] **Step 6: Remove `runMigrations` from `App.tsx`** (Rust now migrates on startup). Delete the `await runMigrations();` line at `App.tsx:146`. Remove the import.

- [ ] **Step 7: Remove `@tauri-apps/plugin-sql`**

- `package.json`: remove `"@tauri-apps/plugin-sql"`.
- `Cargo.toml`: remove `tauri-plugin-sql = ...`.
- `lib.rs`: remove `.plugin(tauri_plugin_sql::Builder::default().build())` (`:49`).
- Delete `src/services/db/connection.ts`; remove all imports of it.

- [ ] **Step 8: Update tests**

- `tests/services/accounts.test.ts`: replace the `vi.mock('.../db/connection')` + `mockDb` pattern with `vi.mock('@tauri-apps/api/core', ...)` invoke mock (use `src/test/mockInvoke.ts`). Rewrite assertions to check `invoke` was called with `'db_create_account'` etc.
- `tests/stores/folderStore.test.ts`, `threadStore.test.ts`: keep mocking at the service boundary (`services/db/labels`, `services/db/threads`) — those modules still export the same functions (now invoke wrappers), so the existing `vi.mock('.../services/db/labels', ...)` still works WITHOUT changes. Prefer this to minimize churn.
- `tests/App.test.tsx`: already mocks `@tauri-apps/api/core`; ensure `invoke` mock returns sane defaults for any `db_*` calls (e.g. `db_get_all_accounts` → `[]`).

- [ ] **Step 9: Type-check + run full Vitest suite**
```bash
cd kylins.client.frontend
npx tsc --noEmit
npx vitest run
```
Expected: 0 type errors; all tests pass (mocks updated).

- [ ] **Step 10: Backend build** (plugin removed): `cd kylins.client.backend && cargo build`.
- [ ] **Step 11: Smoke-run the app** `cargo tauri dev` — confirm: app boots, existing accounts/folders/threads still render (now via `db_*` commands). This is the clean-cut milestone: Rust is sole DB owner.
- [ ] **Step 12: Commit** — `refactor(db): cut frontend over to Rust db_* commands; remove tauri-plugin-sql`.

---

## Task 6: `MailSource` trait + types + factory + mock

**Files:** `src/sync_engine/mod.rs`, `src/sync_engine/mock_source.rs`, `src/lib.rs` (`pub mod sync_engine;`).
**Interfaces:** Produces `MailSource` trait, `Capabilities`, `Cursor`, `FolderDelta`, `RemoteFolder`, `RemoteMessage`, `MailSourceFactory::for_account`.

- [ ] **Step 1: Write the trait module** (`src/sync_engine/mod.rs`):
```rust
pub mod mock_source;
pub mod imap_source;
pub mod eas_source;
pub mod engine;
pub mod commands;

use async_trait::async_trait;
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, Default, Serialize)]
pub struct Capabilities { pub idle: bool, pub condstore: bool, pub qresync: bool, pub ping: bool, pub vanishearch: bool }

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "lowercase")]
pub enum Cursor {
    Imap { uidvalidity: u32, highest_uid: u32, highest_modseq: u64 },
    Eas  { collection_id: String, sync_key: String },
}
impl Cursor {
    pub fn initial_imap() -> Self { Cursor::Imap { uidvalidity: 0, highest_uid: 0, highest_modseq: 0 } }
    pub fn initial_eas(collection_id: &str) -> Self { Cursor::Eas { collection_id: collection_id.into(), sync_key: "0".into() } }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteFolder {
    pub remote_id: String, pub name: String, pub delimiter: String,
    pub special_use: Option<String>, pub role: Option<String>,
    pub parent_id: Option<String>, pub exists: u32, pub unseen: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct RemoteMessage {
    pub uid: u32, pub folder: String,
    pub message_id: Option<String>, pub in_reply_to: Option<String>, pub references: Option<String>,
    pub from_address: Option<String>, pub from_name: Option<String>,
    pub to_addresses: Option<String>, pub cc_addresses: Option<String>,
    pub bcc_addresses: Option<String>, pub reply_to: Option<String>,
    pub subject: Option<String>, pub snippet: Option<String>,
    pub date: i64, pub is_read: bool, pub is_starred: bool, pub is_draft: bool,
    pub body_html: Option<String>, pub body_text: Option<String>,
    pub raw_size: u32, pub list_unsubscribe: Option<String>, pub list_unsubscribe_post: Option<String>,
    pub auth_results: Option<String>, pub has_attachments: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct FolderDelta {
    pub added: Vec<RemoteMessage>,
    pub updated: Vec<RemoteMessage>,
    pub vanished_uids: Vec<u32>,
    pub next_cursor: Cursor,
    pub uidvalidity_changed: bool,
}

#[derive(Debug, thiserror::Error)]
pub enum SourceError {
    #[error("unsupported")] Unsupported,
    #[error("{0}")] Other(String),
}

#[async_trait]
pub trait MailSource: Send + Sync {
    fn capabilities(&self) -> Capabilities;
    async fn list_folders(&self) -> Result<Vec<RemoteFolder>, SourceError>;
    async fn sync_folder(&self, folder: &RemoteFolder, since: Cursor) -> Result<FolderDelta, SourceError>;
    async fn fetch_body(&self, folder: &RemoteFolder, uid: u32) -> Result<Option<String>, SourceError>;
    async fn set_flags(&self, folder: &RemoteFolder, uids: &[u32], flag: &str, add: bool) -> Result<(), SourceError>;
    async fn move_messages(&self, src: &RemoteFolder, uids: &[u32], dest: &RemoteFolder) -> Result<(), SourceError>;
    async fn delete_messages(&self, folder: &RemoteFolder, uids: &[u32]) -> Result<(), SourceError>;
    async fn append(&self, folder: &RemoteFolder, raw: &[u8], flags: &[&str]) -> Result<(), SourceError>;
    async fn send(&self, raw_base64url: &str) -> Result<(), SourceError>;
    // Optional real-time — Phase 2; default Unsupported.
    async fn watch(&self, _folder: &RemoteFolder) -> Result<(), SourceError> { Err(SourceError::Unsupported) }
    async fn ping(&self, _collections: &[(&str, &str)]) -> Result<(), SourceError> { Err(SourceError::Unsupported) }
}
```
Add a factory that, given an `Account` (from `db::accounts`) + decrypted credentials, returns `Arc<dyn MailSource>`. Because account credentials live in the DB (encrypted), the factory needs the pool to load + decrypt the account, then build the source. Put the factory in `engine.rs` or `mod.rs`:
```rust
use std::sync::Arc;
pub async fn source_for_account(pool: &SqlitePool, account_id: &str) -> Result<Arc<dyn MailSource>, String> {
    let acc = crate::db::accounts::get_by_id(pool, account_id).await?.ok_or("account not found")?;
    Ok(match acc.provider.as_str() {
        "imap" => Arc::new(imap_source::ImapSource::new(acc)),
        "eas"  => Arc::new(eas_source::EasSource::new(acc)),
        other => return Err(format!("unsupported provider {other}")),
    })
}
```

- [ ] **Step 2: Write the mock + a failing test**
`src/sync_engine/mock_source.rs`: a `MockSource` with an `Arc<Mutex<Vec<RemoteMessage>>>` queue; `sync_folder` returns deltas from the queue. Test: drive `sync_folder` twice, second returns empty (cursor advanced).
- [ ] **Step 3: Run — expect FAIL** then implement `MockSource`.
- [ ] **Step 4: Run — expect PASS.**
- [ ] **Step 5: Build + commit** — `feat(sync): MailSource trait, Cursor/FolderDelta types, factory, MockSource`.

---

## Task 7: `ImapSource` adapter (+ CAPABILITY negotiation)

**Files:** `src/sync_engine/imap_source.rs`, `src/mail/imap/client.rs` (add `capabilities()` + a connect helper).
**Interfaces:** Consumes existing `crate::mail::imap::{client, types::*}` and `crate::mail::smtp::client`. Produces `ImapSource` implementing `MailSource`.

- [ ] **Step 1: Add CAPABILITY negotiation to the IMAP client**

In `src/mail/imap/client.rs`, add:
```rust
pub async fn session_capabilities(session: &mut ImapSession) -> Result<Capabilities, String> {
    // async-imap exposes Session::capabilities() which runs CAPABILITY if not yet known.
    let caps = session.capabilities().await.map_err(|e| e.to_string())?;
    let has = |t: &str| caps.has_str(t);
    Ok(Capabilities {
        idle: has("IDLE"),
        condstore: has("CONDSTORE"),
        qresync: has("QRESYNC"),
        vanishearch: has("VANISHED") || has("ENABLE"), // approximation; refined in Phase 2
        ping: false,
    })
}
```
(`Capabilities` is defined in `sync_engine`; to avoid a cycle, either move `Capabilities` into `mail/imap` or pass back a tuple `(bool,bool,bool,bool)` from the client and assemble `Capabilities` in the adapter. Prefer returning a small local struct `(idle,condstore,qresync,vanished)` from `client.rs` and mapping in `ImapSource` to keep `mail/imap` independent of `sync_engine`.)

- [ ] **Step 2: Write `ImapSource`**
```rust
pub struct ImapSource { account: Account }
impl ImapSource {
    pub fn new(account: Account) -> Self { Self { account } }
    fn config(&self) -> ImapConfig {
        ImapConfig {
            host: self.account.imap_host.clone().unwrap_or_default(),
            port: self.account.imap_port.unwrap_or(993) as u16,
            security: self.account.imap_security.clone().unwrap_or_else(|| "tls".into()),
            username: self.account.imap_username.clone().unwrap_or_else(|| self.account.email.clone()),
            password: self.account.imap_password.clone().unwrap_or_default(),
            auth_method: self.account.auth_method.clone().unwrap_or_else(|| "password".into()),
            accept_invalid_certs: self.account.accept_invalid_certs,
        }
    }
    fn smtp_config(&self) -> SmtpConfig { /* map account → SmtpConfig */ }
}
```
Implement the trait by wrapping the existing session fns (connect once per public call, reuse the session for sub-ops, logout at the end):
- `list_folders` → `connect` → `client::list_folders(&mut session)` → map `ImapFolder`→`RemoteFolder` (role from special_use via the same heuristic the TS `imapFolderAdapter` uses — replicate `adapters.ts` role resolution in Rust, or accept `role=None` here and let `db::labels::upsert_folders` infer; simplest: set `role` from `special_use` mapping `\Inbox→inbox, \Sent→sent, ...`).
- `sync_folder(folder, since)`:
  ```rust
  let mut s = client::connect(&config).await?;
  let status = client::get_folder_status(&mut s, &folder.remote_id).await?;
  let Cursor::Imap { uidvalidity, highest_uid, highest_modseq } = since else { return Err(Unsupported) };
  if uidvalidity != 0 && status.uidvalidity != uidvalidity {
      return Ok(FolderDelta { added: vec![], updated: vec![], vanished_uids: vec![],
          next_cursor: Cursor::Imap { uidvalidity: status.uidvalidity, highest_uid: 0, highest_modseq: status.highest_modseq.unwrap_or(0) },
          uidvalidity_changed: true });
  }
  let new_uids = client::fetch_new_uids(&mut s, &folder.remote_id, highest_uid).await?;
  let to_fetch: Vec<u32> = new_uids.into_iter().filter(|&u| u > highest_uid).collect();
  let mut added = vec![];
  for chunk in to_fetch.chunks(100) {
      let range = uid_range(chunk);
      let res = client::fetch_messages(&mut s, &folder.remote_id, &range).await?;
      added.extend(res.messages.into_iter().map(remote_from_imap));
  }
  let new_high = added.iter().map(|m| m.uid).max().unwrap_or(highest_uid);
  Ok(FolderDelta { added, updated: vec![], vanished_uids: vec![],
      next_cursor: Cursor::Imap { uidvalidity: status.uidvalidity, highest_uid: new_high, highest_modseq: status.highest_modseq.unwrap_or(highest_modseq) },
      uidvalidity_changed: false })
  ```
- `fetch_body` → `fetch_message_body` → `Some(msg.body_html)` (or body_text fallback).
- `set_flags`/`move_messages`/`delete_messages`/`append` → wrap the matching `client::*` fns (build `uid_set` string from the slice). `send` → `crate::mail::smtp::client::send_raw_email(&smtp_config(), raw_base64url)`.
- `remote_from_imap(m: ImapMessage) -> RemoteMessage` — direct field copy (`has_attachments = !m.attachments.is_empty()`).

- [ ] **Step 3: Write integration test** reusing `tests/imap_smtp_integration.rs` machinery — append a message to the test folder, then `ImapSource.sync_folder` with `Cursor::initial_imap()` and assert the message appears in `added`.
- [ ] **Step 4: Run — expect FAIL/PASS** per TDD; implement.
- [ ] **Step 5: Build + commit** — `feat(sync): ImapSource adapter with CAPABILITY + delta sync`.

---

## Task 8: `db::sync_state` cursors + `db::messages::apply_folder_delta`

**Files:** `src/db/sync_state.rs`, `src/db/messages.rs`, `src/db/commands.rs`, `src/lib.rs`.
**Interfaces:** Produces internal fns (engine-facing, not necessarily commands): `sync_state::{get_imap_cursor, advance_imap_cursor, get_eas_cursor, advance_eas_cursor}` and `messages::apply_folder_delta(pool, account_id, label_id, &FolderDelta) -> Result<AppliedCounts,String>`.

> Reproduce the TS `upsertImapMessages` logic in Rust (extraction report §threads): in ONE transaction, per message: upsert `threads` (ON CONFLICT (account_id,id) DO UPDATE of the listed cols; `id` = message_id or generated uuid), upsert `messages` (23-col INSERT + ON CONFLICT DO UPDATE), `INSERT INTO thread_labels ... ON CONFLICT DO NOTHING`, and if `body_html` present `INSERT OR REPLACE INTO message_bodies`.

- [ ] **Step 1: Failing tests**
- `advance_imap_cursor` persists + returns the stored value; calling with a LOWER uidvalidity/higher_uid is ignored (monotonic).
- `advance_imap_cursor` with a huge gap (highest_uid jumps >> threshold) still advances (gap-bounding is about the FETCH, tested at the engine level; here just assert monotonic).
- `apply_folder_delta` with 2 added messages creates 2 threads + 2 messages + thread_labels + body rows; calling again with the same delta is idempotent.
- `apply_folder_delta` with `uidvalidity_changed=true` first deletes the folder's messages/threads.
- [ ] **Step 2: Run — expect FAIL.**
- [ ] **Step 3: Implement**

`sync_state.rs`:
```rust
pub async fn get_imap_cursor(pool, account_id, folder_path) -> Cursor {
    // SELECT uidvalidity,last_uid,modseq FROM folder_sync_state ...; default initial_imap()
}
pub async fn advance_imap_cursor(pool, account_id, folder_path, new: u32, new_uv: u32, new_modseq: u64) -> Result<(),String> {
    // Monotonic: INSERT ... ON CONFLICT DO UPDATE SET last_uid = MAX(excluded.last_uid, folder_sync_state.last_uid) ...
    // Use: UPDATE folder_sync_state SET last_uid = $new, uidvalidity = $uv, modseq = $ms, last_sync_at = unixepoch()
    //      WHERE account_id=$a AND folder_path=$f AND (last_uid IS NULL OR last_uid <= $new)
    //      OR INSERT ... — guard the regression.
}
```
`messages.rs::apply_folder_delta`: open `pool.begin().await?`, branch on `uidvalidity_changed` (delete folder rows first), loop added+updated applying the upserts, `INSERT OR REPLACE message_bodies`, commit. Return `{added, updated, deleted}` counts.

- [ ] **Step 4: Run — expect PASS.**
- [ ] **Step 5: Build + commit** — `feat(db): sync cursors (monotonic) + apply_folder_delta`.

---

## Task 9: `SyncEngine` + `AccountWorker` (polling) + events + commands

**Files:** `src/sync_engine/engine.rs`, `src/sync_engine/commands.rs`, `src/lib.rs`.
**Interfaces:** Consumes `MailSource`, `db::{accounts, sync_state, messages, labels}`. Produces commands `sync_start`, `sync_stop`, `sync_account_now`, `sync_request_bodies`; emits Tauri events `sync:delta`, `sync:status`, `sync:new-mail`.

- [ ] **Step 1: Write `SyncEngine`**

```rust
pub struct SyncEngine { workers: Mutex<HashMap<String, WorkerHandle>>, pool: SqlitePool, app: AppHandle }
struct WorkerHandle { tx: mpsc::Sender<SyncOp>, join: tokio::task::JoinHandle<()> }
enum SyncOp { SyncNow, RequestBodies(Vec<String>), Shutdown }

impl SyncEngine {
    pub fn new(pool: SqlitePool, app: AppHandle) -> Arc<Self> { ... }
    pub async fn start(self: &Arc<Self>) -> Result<(), String> {
        let accounts = crate::db::accounts::get_all(&self.pool).await?;
        for a in accounts.into_iter().filter(|a| a.is_active) { self.spawn_worker(a.id).await?; }
        Ok(())
    }
    pub async fn ensure_worker(self: &Arc<Self>, account_id: String) { /* spawn if missing */ }
    pub async fn stop_worker(self: &Arc<Self>, account_id: &str) { /* send Shutdown, abort */ }
    async fn spawn_worker(self: &Arc<Self>, account_id: String) -> Result<(), String> {
        let (tx, mut rx) = mpsc::channel::<SyncOp>(16);
        let pool = self.pool.clone(); let app = self.app.clone();
        let join = tokio::spawn(async move {
            let mut tick = tokio::time::interval(std::time::Duration::from_secs(60));
            tick.tick().await; // skip immediate (engine.start does an initial sync_now)
            loop {
                tokio::select! {
                    _ = tick.tick() => { let _ = run_sync_round(&pool, &app, &account_id).await; }
                    op = rx.recv() => match op {
                        Some(SyncOp::SyncNow) => { let _ = run_sync_round(&pool, &app, &account_id).await; }
                        Some(SyncOp::Shutdown) | None => break,
                        Some(SyncOp::RequestBodies(ids)) => { let _ = fetch_bodies(&pool, &app, &account_id, ids).await; }
                    }
                }
            }
        });
        self.workers.lock().await.insert(account_id, WorkerHandle { tx, join });
        Ok(())
    }
    pub async fn sync_now(&self, account_id: &str) { /* send SyncOp::SyncNow if worker exists */ }
}
```

`run_sync_round`:
```rust
async fn run_sync_round(pool, app, account_id) -> Result<(), String> {
    let _ = app.emit("sync:status", StatusEvt { account_id, state: "syncing" });
    let src = crate::sync_engine::source_for_account(pool, account_id).await?;
    // 1. folders
    let folders = src.list_folders().await?;
    crate::db::labels::upsert_folders_remote(account_id, &folders).await?; // map RemoteFolder→labels row
    // 2. per-folder delta
    for f in &folders {
        let cursor = crate::db::sync_state::get_imap_cursor(pool, account_id, &f.remote_id).await;
        let delta = match src.sync_folder(f, cursor).await { Ok(d) => d, Err(e) => { log::warn!("sync_folder failed: {e}"); continue; } };
        let label_id = format!("{account_id}:{}", f.remote_id);
        let counts = crate::db::messages::apply_folder_delta(pool, account_id, &label_id, &delta).await?;
        crate::db::sync_state::advance_imap_cursor(pool, account_id, &f.remote_id, next_uid_of(&delta.next_cursor), uv_of(&delta.next_cursor), modseq_of(&delta.next_cursor)).await?;
        if counts.added > 0 {
            let _ = app.emit("sync:delta", DeltaEvt { op: "persist".into(), table: "messages".into(), account_id: account_id.into(), label_id: label_id.clone(), count: counts.added as i64 });
            if is_inbox_like(f) { let _ = app.emit("sync:new-mail", NewMailEvt { account_id: account_id.into(), folder_id: label_id, count: counts.added as i64 }); }
        }
    }
    crate::db::accounts::touch_last_sync(pool, account_id).await?; // UPDATE accounts SET last_sync_at=unixepoch()
    let _ = app.emit("sync:status", StatusEvt { account_id, state: "idle" });
    Ok(())
}
```
(Event payload structs derive `Serialize + Clone`; Tauri `emit` requires `Clone`.)

- [ ] **Step 2: Commands** in `src/sync_engine/commands.rs`:
```rust
#[tauri::command]
pub async fn sync_start(engine: State<'_, Arc<SyncEngine>>) -> Result<(), String> { engine.start().await }
#[tauri::command]
pub async fn sync_stop(engine: State<'_, Arc<SyncEngine>>) -> Result<(), String> { /* stop all workers */ Ok(()) }
#[tauri::command]
pub async fn sync_account_now(engine: State<'_, Arc<SyncEngine>>, account_id: String) -> Result<(), String> { engine.sync_now(&account_id).await; Ok(()) }
#[tauri::command]
pub async fn sync_request_bodies(engine: State<'_, Arc<SyncEngine>>, account_id: String, message_ids: Vec<String>) -> Result<(), String> { /* send RequestBodies */ Ok(()) }
```

- [ ] **Step 3: Failing test** — drive `SyncEngine` with a `MockSource` (inject via a seam: have `run_sync_round` take the source, or make `source_for_account` injectable in tests) against a temp pool; assert `sync:delta`/`sync:new-mail` fire and messages land. Use a test `AppHandle`? Tauri `AppHandle` is hard to construct in tests — instead, factor the emit behind a trait `EventSink` (`fn emit(...)`) with a real Tauri impl and a `TestSink` (collects into a `Vec`). Inject the sink. This is the testable seam.
- [ ] **Step 4: Run — FAIL → implement.**
- [ ] **Step 5: Run — PASS.**
- [ ] **Step 6: Register in `lib.rs`**: in setup, after `app.manage(pool)`, build `let engine = Arc::new(SyncEngine::new(pool.clone(), app.handle().clone())); app.manage(engine.clone());` (do NOT auto-start here — the frontend starts it after accounts load, Task 10). Add `sync_*` + the `db::*` commands to `generate_handler!`.
- [ ] **Step 7: Build + commit** — `feat(sync): SyncEngine + polling AccountWorker + sync:* events`.

---

## Task 10: EasSource scaffolding + wire engine lifecycle + `useSyncEvents` + end-to-end

**Files:** `src/sync_engine/eas_source.rs`, `src/hooks/useSyncEvents.ts`, `src/App.tsx`, `src/stores/{folderStore,threadStore}.ts`, `src/components/account-setup/AccountSetupFlow.tsx`, `src/services/mail/folderStore` tray wiring.

- [ ] **Step 1: `EasSource` scaffolding** — implement `MailSource` wrapping `EasClient`: `list_folders` via `folder_sync('0')` → map `EasFolder`→`RemoteFolder` (role from folder_type). `sync_folder` builds `SyncRequest` with the saved sync_key from `eas_sync_state`, calls `client.sync()`. **Because `client.sync()` returns `SyncResult::default()` (WBXML parse TODO at `eas/client.rs:194-198`), `added` will be empty until the parser is implemented.** Persist the returned (empty) `sync_key` via `sync_state::advance_eas_cursor`. `set_flags`/`move`/`delete`/`append` map to `item_operations`/`folder_*` where the EAS client supports them; leave `Err(Unsupported)` where not. `send` → `client.send_mail`. Document the limitation in a code comment.

- [ ] **Step 2 (OPTIONAL, may defer): implement EAS Sync response parsing** in `eas/commands.rs`/`eas/client.rs` so `client.sync()` populates `SyncResult.{added,updated,deleted_server_ids,sync_key,more_available}` from the WBXML. This is the real enabler for EAS message sync. If time-boxed, defer to a follow-up issue and keep Step 1's limitation note.

- [ ] **Step 3: `useSyncEvents` hook** — `src/hooks/useSyncEvents.ts`:
```ts
import { useEffect } from 'react';
import { listen } from '@tauri-apps/api/event';
import { useFolderStore } from '../stores/folderStore';
import { useThreadStore } from '../stores/threadStore';
import { isTauri } from '../...'; // existing sentinel check
import { sendNotification } from '@tauri-apps/plugin-notification';

export function useSyncEvents() {
  useEffect(() => {
    if (!isTauri) return;
    const unsubs: Array<() => Promise<void>> = [];
    (async () => {
      unsubs.push(await listen<{accountId:string; labelId?:string}>('sync:delta', (e) => {
        useFolderStore.getState().loadLabels();      // re-read counts
        const q = useThreadStore.getState().currentQuery;
        if (q) useThreadStore.getState().refresh();  // re-read current folder
      }));
      unsubs.push(await listen<{accountId:string; count:number}>('sync:new-mail', async (e) => {
        try { await sendNotification({ title: 'New mail', body: `${e.payload.count} new message(s)` }); } catch {}
      }));
    })();
    return () => { unsubs.forEach((u) => void u()); };
  }, []);
}
```
Call `useSyncEvents()` in `App.tsx` (top-level, main window only).

- [ ] **Step 4: Start the engine after accounts load** — in `App.tsx` main-window branch, after `refreshAccounts()`: `await invoke('sync_start');`. Also when `accounts` changes (add/remove), call `invoke('sync_account_now', { accountId })` for the new account (the engine's `ensure_worker` handles spawn). Simplest: in the `accounts` effect, `invoke('sync_start')` is idempotent (engine spawns missing workers).

- [ ] **Step 5: AccountSetupFlow → engine** — replace the `syncAccountFolders`/`syncFolderMessages` calls (`AccountSetupFlow.tsx:329-337`) with `await invoke('sync_account_now', { accountId: createdAccount.id });`. Remove the now-dead `folderSync.ts` import.

- [ ] **Step 6: tray-check-mail listener** — in `useSyncEvents` or App, add `await listen('tray-check-mail', () => { useAccountStore.getState().accounts.forEach(a => invoke('sync_account_now', { accountId: a.id })); });`.

- [ ] **Step 7: End-to-end manual verification**
```bash
cd kylins.client.backend
cargo tauri dev
```
- Create the IMAP account (`felixzhou@kylins.local` / `P@ssw0rd`, imap.kylins.com:143 STARTTLS, smtp.kylins.com:587 STARTTLS, accept-invalid-certs on).
- On setup-complete, the engine fires one `sync_account_now`; Inbox populates.
- Wait 60s (or click the folder-pane sync / tray "Check for Mail"); send a test mail to the account → within ≤60s it appears with an OS notification, no manual refresh.
- DevTools console: no errors; `sync:delta`/`sync:new-mail` fire.
- Exit criterion met: **mail syncs on setup and stays fresh via polling; UI updates via events.**

- [ ] **Step 8: Full regression**
```bash
cd kylins.client.backend && cargo test
cd ../kylins.client.frontend && npx tsc --noEmit && npx vitest run
```
- [ ] **Step 9: Commit** — `feat(sync): wire SyncEngine lifecycle, useSyncEvents, EasSource scaffolding; end-to-end polling sync`.

---

## Self-review notes (resolved during authoring)

- **Spec coverage:** every Phase 0 item in the spec §10 maps to a task: schema→T1, MailSource trait + ImapSource/EasSource→T6/T7/T10, cursors→T8, SyncEngine polling→T9, frontend view-layer + events→T5/T10. Offline replay / IDLE / Ping / Gmail-API are correctly absent (Phases 1–3).
- **Type consistency:** `Capabilities`, `Cursor` (`Imap`/`Eas`), `FolderDelta`, `RemoteFolder`, `RemoteMessage` are defined once (T6) and consumed unchanged in T7/T8/T9. DTOs all use `#[serde(rename_all="camelCase")]` to match TS. `DbPool = SqlitePool` is the single pool type.
- **Known limitation explicitly flagged:** EAS message sync depends on the WBXML Sync-response parser (T10 Step 2, optional). IMAP end-to-end is the exit criterion.
- **DB cutover ordering is safe:** Tasks 2–4 add Rust read/write commands while the frontend still owns writes (one writer = frontend; Rust reads via sqlx in tests only). Task 5 cuts the frontend over; only afterward (T6+) does the engine write. No two-writer window on the real DB.

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-06-27-sync-engine-phase0.md`. Two execution options:

1. **Subagent-Driven (recommended)** — I dispatch a fresh subagent per task, review between tasks, fast iteration.
2. **Inline Execution** — execute tasks in this session using executing-plans, batch execution with checkpoints.

Which approach?
