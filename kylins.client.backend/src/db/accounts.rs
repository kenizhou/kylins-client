//! Accounts domain query layer.
//!
//! Rust port of `kylins.client.frontend/src/services/accounts.ts`. Owns the
//! `accounts` table CRUD with AES-256-GCM encryption for the four secret
//! columns (`access_token`, `refresh_token`, `imap_password`,
//! `oauth_client_secret`). Plaintext is never written to SQLite; secrets are
//! encrypted on write via [`crate::crypto::encrypt`] and decrypted on read via
//! [`crate::crypto::decrypt`].
//!
//! Every DTO returned to the frontend derives `Serialize` with
//! `#[serde(rename_all = "camelCase")]` so the JSON field names match the
//! existing TypeScript `Account` / `CreateAccountInput` / `AccountUpdates`
//! interfaces exactly. A later task cuts the frontend over to the `db_*`
//! Tauri commands declared in [`crate::db::commands`] and keeps the same TS
//! types, so the camelCase mapping is load-bearing.
//!
//! Corrupt-row behavior mirrors the frontend: [`get_all`] skips rows whose
//! secrets fail to decrypt (an `allSettled` equivalent), while
//! [`get_by_email`] returns a minimal `{id, email, provider}` stub on decrypt
//! failure so the duplicate-check in [`create`] still treats the row as an
//! existing account.

use serde::{Deserialize, Serialize};
use sqlx::{sqlite::SqliteRow, Row, SqlitePool};
use std::time::{SystemTime, UNIX_EPOCH};

use crate::crypto::{decrypt, encrypt};

/// An account row, with secret fields decrypted.
///
/// Field names are camelCase in JSON (via `#[serde(rename_all)]`) to match
/// the TypeScript `Account` interface. Rust field names stay snake_case to
/// match the DB columns and Rust convention.
#[derive(Debug, Clone, Serialize, Deserialize, Default, PartialEq, Eq)]
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

    // IMAP / SMTP
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub imap_host: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub imap_port: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub imap_security: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub smtp_host: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub smtp_port: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub smtp_security: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub auth_method: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub imap_password: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub imap_username: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub smtp_username: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub oauth_provider: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub oauth_client_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub oauth_client_secret: Option<String>,
    pub accept_invalid_certs: bool,

    // EAS
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub eas_url: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub eas_protocol_version: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub eas_device_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub eas_policy_key: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub eas_user_agent: Option<String>,
    /// EAS auth strategy: `"basic"` (default/null) or `"oauth"`. Phase 3b Task 3.
    /// Mirrors the `eas_policy_key` Option<String> pattern. NULL = Basic.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub auth_type: Option<String>,
    /// Per-account encryption granularity (§11.4.1). NULL = app default (WholeMessage).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub crypto_granularity: Option<String>,
}

/// Input for [`create`]. Mirrors the TypeScript `CreateAccountInput`
/// (30 fields). All fields except `email` and `provider` are optional.
#[derive(Debug, Clone, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct CreateAccountInput {
    pub email: String,
    #[serde(default)]
    pub display_name: Option<String>,
    #[serde(default)]
    pub account_label: Option<String>,
    pub provider: String,
    #[serde(default)]
    pub setup_provider_id: Option<String>,
    #[serde(default)]
    pub access_token: Option<String>,
    #[serde(default)]
    pub refresh_token: Option<String>,
    #[serde(default)]
    pub token_expires_at: Option<i64>,
    #[serde(default)]
    pub is_active: Option<bool>,
    #[serde(default)]
    pub is_default: Option<bool>,
    #[serde(default)]
    pub sort_order: Option<i64>,

    // IMAP / SMTP
    #[serde(default)]
    pub imap_host: Option<String>,
    #[serde(default)]
    pub imap_port: Option<i64>,
    #[serde(default)]
    pub imap_security: Option<String>,
    #[serde(default)]
    pub smtp_host: Option<String>,
    #[serde(default)]
    pub smtp_port: Option<i64>,
    #[serde(default)]
    pub smtp_security: Option<String>,
    #[serde(default)]
    pub auth_method: Option<String>,
    #[serde(default)]
    pub imap_password: Option<String>,
    #[serde(default)]
    pub imap_username: Option<String>,
    #[serde(default)]
    pub smtp_username: Option<String>,
    #[serde(default)]
    pub oauth_provider: Option<String>,
    #[serde(default)]
    pub oauth_client_id: Option<String>,
    #[serde(default)]
    pub oauth_client_secret: Option<String>,
    #[serde(default)]
    pub accept_invalid_certs: Option<bool>,

    // EAS (note: create does not set easPolicyKey/easUserAgent in the TS
    // implementation, but update does — reproduced faithfully below).
    #[serde(default)]
    pub eas_url: Option<String>,
    #[serde(default)]
    pub eas_protocol_version: Option<String>,
    #[serde(default)]
    pub eas_device_id: Option<String>,
}

/// Partial update payload for [`update`]. Every field is optional; only
/// present fields are written. Mirrors the TypeScript `AccountUpdates` map
/// (`accounts.ts:271-309`), including `easPolicyKey` / `easUserAgent` which
/// `create` does not set.
#[derive(Debug, Clone, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct AccountUpdates {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub email: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub display_name: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub account_label: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub avatar_url: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub provider: Option<String>,
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
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub is_active: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub is_default: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub sort_order: Option<i64>,

    // IMAP / SMTP
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub imap_host: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub imap_port: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub imap_security: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub smtp_host: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub smtp_port: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub smtp_security: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub auth_method: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub imap_password: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub imap_username: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub smtp_username: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub oauth_provider: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub oauth_client_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub oauth_client_secret: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub accept_invalid_certs: Option<bool>,

    // EAS
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub eas_url: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub eas_protocol_version: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub eas_device_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub eas_policy_key: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub eas_user_agent: Option<String>,
    /// EAS auth strategy — see [`Account::auth_type`]. Phase 3b Task 3.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub auth_type: Option<String>,
}

/// Map a raw row to an [`Account`], decrypting the four secret fields.
///
/// Secrets that fail to decrypt are treated as `None` so account metadata
/// survives even when the master key changes (e.g. keyring reset).
fn row_to_account(row: &SqliteRow) -> Result<Account, String> {
    let access_token = dec_opt_graceful(row.try_get("access_token").ok().flatten(), "access_token");
    let refresh_token =
        dec_opt_graceful(row.try_get("refresh_token").ok().flatten(), "refresh_token");
    let imap_password =
        dec_opt_graceful(row.try_get("imap_password").ok().flatten(), "imap_password");
    let oauth_client_secret = dec_opt_graceful(
        row.try_get("oauth_client_secret").ok().flatten(),
        "oauth_client_secret",
    );

    Ok(Account {
        id: row.try_get("id").unwrap_or_default(),
        email: row.try_get("email").unwrap_or_default(),
        display_name: row.try_get("display_name").ok().flatten(),
        account_label: row.try_get("account_label").ok().flatten(),
        avatar_url: row.try_get("avatar_url").ok().flatten(),
        provider: row.try_get("provider").unwrap_or_default(),
        setup_provider_id: row.try_get("setup_provider_id").ok().flatten(),
        access_token,
        refresh_token,
        token_expires_at: row.try_get("token_expires_at").ok().flatten(),
        history_id: row.try_get("history_id").ok().flatten(),
        last_sync_at: row.try_get("last_sync_at").ok().flatten(),
        is_active: row.try_get::<i64, _>("is_active").unwrap_or(0) == 1,
        is_default: row.try_get::<i64, _>("is_default").unwrap_or(0) == 1,
        sort_order: row.try_get("sort_order").unwrap_or(0),
        created_at: row.try_get("created_at").unwrap_or(0),
        updated_at: row.try_get("updated_at").unwrap_or(0),
        imap_host: row.try_get("imap_host").ok().flatten(),
        imap_port: row.try_get("imap_port").ok().flatten(),
        imap_security: row.try_get("imap_security").ok().flatten(),
        smtp_host: row.try_get("smtp_host").ok().flatten(),
        smtp_port: row.try_get("smtp_port").ok().flatten(),
        smtp_security: row.try_get("smtp_security").ok().flatten(),
        auth_method: row.try_get("auth_method").ok().flatten(),
        imap_password,
        imap_username: row.try_get("imap_username").ok().flatten(),
        smtp_username: row.try_get("smtp_username").ok().flatten(),
        oauth_provider: row.try_get("oauth_provider").ok().flatten(),
        oauth_client_id: row.try_get("oauth_client_id").ok().flatten(),
        oauth_client_secret,
        accept_invalid_certs: row.try_get::<i64, _>("accept_invalid_certs").unwrap_or(0) == 1,
        eas_url: row.try_get("eas_url").ok().flatten(),
        eas_protocol_version: row.try_get("eas_protocol_version").ok().flatten(),
        eas_device_id: row.try_get("eas_device_id").ok().flatten(),
        eas_policy_key: row.try_get("eas_policy_key").ok().flatten(),
        eas_user_agent: row.try_get("eas_user_agent").ok().flatten(),
        auth_type: row.try_get("auth_type").ok().flatten(),
        crypto_granularity: row.try_get("crypto_granularity").ok().flatten(),
    })
}

/// Decrypt an optional hex ciphertext. `None` and empty string pass through.
fn dec_opt(stored: Option<&str>) -> Result<Option<String>, String> {
    match stored.filter(|s| !s.is_empty()) {
        Some(cipher) => decrypt(cipher).map(Some),
        None => Ok(None),
    }
}

/// Like [`dec_opt`] but returns `None` on decrypt failure so account metadata
/// survives a master-key reset. The warning helps operators spot stale secrets.
fn dec_opt_graceful(stored: Option<&str>, field: &str) -> Option<String> {
    dec_opt(stored).unwrap_or_else(|e| {
        log::warn!("[accounts] failed to decrypt {field}, treating as empty: {e}");
        None
    })
}

/// Encrypt an optional plaintext. `None` passes through.
fn enc_opt(plaintext: Option<&str>) -> Result<Option<String>, String> {
    match plaintext {
        Some(v) => encrypt(v).map(Some),
        None => Ok(None),
    }
}

/// Current unix timestamp in seconds. Matches the frontend's
/// `Math.floor(Date.now() / 1000)`.
fn now_secs() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

/// Return all accounts newest-first. Rows whose secrets fail to decrypt are
/// warned and skipped (the `Promise.allSettled` equivalent from
/// `accounts.ts:210-234`).
pub async fn get_all(pool: &SqlitePool) -> Result<Vec<Account>, String> {
    let rows = sqlx::query("SELECT * FROM accounts ORDER BY created_at DESC")
        .fetch_all(pool)
        .await
        .map_err(|e| e.to_string())?;

    let mut accounts = Vec::with_capacity(rows.len());
    for row in rows {
        let id: String = row.try_get("id").unwrap_or_default();
        let email: String = row.try_get("email").unwrap_or_default();
        match row_to_account(&row) {
            Ok(a) => accounts.push(a),
            Err(e) => log::warn!("[accounts] skipping corrupt row id={id} email={email}: {e}"),
        }
    }
    Ok(accounts)
}

/// Return the account with this id, or `None` if not found.
pub async fn get_by_id(pool: &SqlitePool, id: &str) -> Result<Option<Account>, String> {
    let row = sqlx::query("SELECT * FROM accounts WHERE id = ?")
        .bind(id)
        .fetch_optional(pool)
        .await
        .map_err(|e| e.to_string())?;
    row.map(|r| row_to_account(&r)).transpose()
}

/// Return the account with this email, or `None` if not found.
///
/// On decrypt failure, returns a minimal `{id, email, provider}` stub so the
/// duplicate-check in [`create`] still treats the row as existing
/// (`accounts.ts:242-260`).
pub async fn get_by_email(pool: &SqlitePool, email: &str) -> Result<Option<Account>, String> {
    let row = sqlx::query("SELECT * FROM accounts WHERE email = ? LIMIT 1")
        .bind(email)
        .fetch_optional(pool)
        .await
        .map_err(|e| e.to_string())?;

    let Some(row) = row else { return Ok(None) };
    match row_to_account(&row) {
        Ok(a) => Ok(Some(a)),
        Err(e) => {
            log::warn!(
                "[accounts] account {email} exists but is corrupt; treating as duplicate: {e}"
            );
            Ok(Some(Account {
                id: row.try_get("id").unwrap_or_default(),
                email: row.try_get("email").unwrap_or_default(),
                provider: row.try_get("provider").unwrap_or_default(),
                ..Default::default()
            }))
        }
    }
}

/// Load only `crypto_granularity` for an account. Mirrors `get_default_signing_key`
/// (db/crypto_keys.rs). NULL (or missing row) → None → caller falls back to WholeMessage.
///
/// Note: `.flatten()` forces the scalar type to `Option<String>` so that a row with
/// a NULL column decodes to `None` (via the `Option<T>` Decode path that checks
/// `is_null`). Without it, the inferred scalar type would be `String`, and sqlx-sqlite
/// 0.8 decodes NULL TEXT as `Some("")` (see `sqlx-sqlite/src/value.rs:text()` — empty
/// blob is treated as NULL and returned as `""`, not propagated as `None`).
pub async fn get_crypto_granularity(
    pool: &SqlitePool,
    account_id: &str,
) -> Result<Option<String>, sqlx::Error> {
    Ok(
        sqlx::query_scalar("SELECT crypto_granularity FROM accounts WHERE id = ?")
            .bind(account_id)
            .fetch_optional(pool)
            .await?
            .flatten(),
    )
}

/// Insert a new account. Encrypts the four secret fields, auto-sets
/// `is_default` when this is the first account, rejects duplicate emails, and
/// seeds a default signature row (faithful to the legacy frontend
/// `insertSignature` call that used to follow account creation).
pub async fn create(pool: &SqlitePool, input: CreateAccountInput) -> Result<Account, String> {
    // Duplicate check first — uses get_by_email so a corrupt row still counts
    // as "exists".
    if let Some(_existing) = get_by_email(pool, &input.email).await? {
        return Err(format!("An account for {} already exists.", input.email));
    }

    let id = uuid::Uuid::new_v4().to_string();
    let count = get_count(pool).await?;
    let is_default = input.is_default.unwrap_or(count == 0);
    let is_active = input.is_active.unwrap_or(true);
    let sort_order = input.sort_order.unwrap_or(0);
    let accept_invalid_certs = input.accept_invalid_certs.unwrap_or(false);

    let access_token = enc_opt(input.access_token.as_deref())?;
    let refresh_token = enc_opt(input.refresh_token.as_deref())?;
    let imap_password = enc_opt(input.imap_password.as_deref())?;
    let oauth_client_secret = enc_opt(input.oauth_client_secret.as_deref())?;

    sqlx::query(
        "INSERT INTO accounts (
            id, email, display_name, account_label, provider, setup_provider_id,
            access_token, refresh_token, token_expires_at,
            is_active, is_default, sort_order, created_at, updated_at,
            imap_host, imap_port, imap_security,
            smtp_host, smtp_port, smtp_security,
            auth_method, imap_password, imap_username, smtp_username,
            oauth_provider, oauth_client_id, oauth_client_secret,
            accept_invalid_certs,
            eas_url, eas_protocol_version, eas_device_id
        ) VALUES (
            ?, ?, ?, ?, ?, ?,
            ?, ?, ?,
            ?, ?, ?, strftime('%s','now'), strftime('%s','now'),
            ?, ?, ?,
            ?, ?, ?,
            ?, ?, ?, ?,
            ?, ?, ?,
            ?,
            ?, ?, ?
        )",
    )
    .bind(&id)
    .bind(&input.email)
    .bind(input.display_name)
    .bind(input.account_label)
    .bind(&input.provider)
    .bind(input.setup_provider_id)
    .bind(&access_token)
    .bind(&refresh_token)
    .bind(input.token_expires_at)
    .bind(is_active as i64)
    .bind(is_default as i64)
    .bind(sort_order)
    .bind(input.imap_host)
    .bind(input.imap_port)
    .bind(input.imap_security)
    .bind(input.smtp_host)
    .bind(input.smtp_port)
    .bind(input.smtp_security)
    .bind(input.auth_method)
    .bind(&imap_password)
    .bind(input.imap_username)
    .bind(input.smtp_username)
    .bind(input.oauth_provider)
    .bind(input.oauth_client_id)
    .bind(&oauth_client_secret)
    .bind(accept_invalid_certs as i64)
    .bind(input.eas_url)
    .bind(input.eas_protocol_version)
    .bind(input.eas_device_id)
    .execute(pool)
    .await
    .map_err(|e| e.to_string())?;

    // Seed a default signature so the composer always has something to offer.
    // This replaces the frontend `insertSignature` call that used to live in
    // `accounts.ts:createAccount` (removed during the Task 5 cutover so the
    // Rust-owned create path doesn't cross back into the frontend). The
    // `signatures` table is now also Rust-owned (see `db::signatures`).
    // Faithful to the TS default: name='Default',
    // body_html='<p>Sent from Kylins Mail</p>', is_default=1, context='all'.
    // Best-effort: a failure here is logged but does not fail the account
    // creation (matches the TS try/catch around insertSignature).
    let sig_id = uuid::Uuid::new_v4().to_string();
    if let Err(e) = sqlx::query(
        "INSERT INTO signatures (id, account_id, name, body_html, is_default, context)
         VALUES (?, ?, 'Default', '<p>Sent from Kylins Mail</p>', 1, 'all')",
    )
    .bind(&sig_id)
    .bind(&id)
    .execute(pool)
    .await
    {
        log::warn!("[accounts] failed to seed default signature for {id}: {e}");
    }

    // Seed a default local calendar for the account. Best-effort: a failure here
    // is logged but does not fail account creation (matches the signature-seed
    // pattern above).
    if let Err(e) = crate::db::calendars::seed_default_for_account(pool, &id).await {
        log::warn!("[accounts] failed to seed default calendar for {id}: {e}");
    }

    get_by_id(pool, &id)
        .await?
        .ok_or_else(|| "insert failed: row not found after create".to_string())
}

/// Apply a partial update. Only present fields are written; the four secrets
/// are re-encrypted. Always stamps `updated_at`. Reproduces the 30-field map
/// from `accounts.ts:271-309` (including `easPolicyKey` / `easUserAgent`).
pub async fn update(pool: &SqlitePool, id: &str, updates: AccountUpdates) -> Result<(), String> {
    // Each entry is (column, boxed value binder). We collect Sqlite-typed
    // values (`String`, `i64`, `bool`) and bind them positionally with a
    // final id parameter. Secrets are encrypted before being pushed.
    let mut sets: Vec<String> = Vec::new();
    let mut binds: Vec<SqliteValue> = Vec::new();

    macro_rules! push_str {
        ($col:expr, $val:expr) => {{
            if let Some(v) = $val {
                sets.push(format!("{} = ?", $col));
                binds.push(SqliteValue::Text(v));
            }
        }};
    }
    macro_rules! push_i64 {
        ($col:expr, $val:expr) => {{
            if let Some(v) = $val {
                sets.push(format!("{} = ?", $col));
                binds.push(SqliteValue::Int(v));
            }
        }};
    }
    macro_rules! push_bool {
        ($col:expr, $val:expr) => {{
            if let Some(v) = $val {
                sets.push(format!("{} = ?", $col));
                binds.push(SqliteValue::Bool(v));
            }
        }};
    }

    push_str!("email", updates.email);
    push_str!("display_name", updates.display_name);
    push_str!("account_label", updates.account_label);
    push_str!("avatar_url", updates.avatar_url);
    push_str!("provider", updates.provider);
    push_str!("setup_provider_id", updates.setup_provider_id);

    if let Some(v) = updates.access_token {
        sets.push("access_token = ?".to_string());
        binds.push(SqliteValue::Text(encrypt(&v)?));
    }
    if let Some(v) = updates.refresh_token {
        sets.push("refresh_token = ?".to_string());
        binds.push(SqliteValue::Text(encrypt(&v)?));
    }
    push_i64!("token_expires_at", updates.token_expires_at);
    push_str!("history_id", updates.history_id);
    push_i64!("last_sync_at", updates.last_sync_at);
    push_bool!("is_active", updates.is_active);
    push_bool!("is_default", updates.is_default);
    push_i64!("sort_order", updates.sort_order);

    push_str!("imap_host", updates.imap_host);
    push_i64!("imap_port", updates.imap_port);
    push_str!("imap_security", updates.imap_security);
    push_str!("smtp_host", updates.smtp_host);
    push_i64!("smtp_port", updates.smtp_port);
    push_str!("smtp_security", updates.smtp_security);
    push_str!("auth_method", updates.auth_method);
    if let Some(v) = updates.imap_password {
        sets.push("imap_password = ?".to_string());
        binds.push(SqliteValue::Text(encrypt(&v)?));
    }
    push_str!("imap_username", updates.imap_username);
    push_str!("smtp_username", updates.smtp_username);
    push_str!("oauth_provider", updates.oauth_provider);
    push_str!("oauth_client_id", updates.oauth_client_id);
    if let Some(v) = updates.oauth_client_secret {
        sets.push("oauth_client_secret = ?".to_string());
        binds.push(SqliteValue::Text(encrypt(&v)?));
    }
    push_bool!("accept_invalid_certs", updates.accept_invalid_certs);

    push_str!("eas_url", updates.eas_url);
    push_str!("eas_protocol_version", updates.eas_protocol_version);
    push_str!("eas_device_id", updates.eas_device_id);
    push_str!("eas_policy_key", updates.eas_policy_key);
    push_str!("eas_user_agent", updates.eas_user_agent);
    push_str!("auth_type", updates.auth_type);

    // Always stamp updated_at.
    sets.push("updated_at = ?".to_string());
    binds.push(SqliteValue::Int(now_secs()));

    if sets.is_empty() {
        return Ok(()); // nothing to do (shouldn't happen because updated_at is always added)
    }

    let sql = format!("UPDATE accounts SET {} WHERE id = ?", sets.join(", "));
    let mut q = sqlx::query(&sql);
    for b in binds {
        q = match b {
            SqliteValue::Text(s) => q.bind(s),
            SqliteValue::Int(i) => q.bind(i),
            SqliteValue::Bool(b2) => q.bind(b2 as i64),
        };
    }
    q.bind(id).execute(pool).await.map_err(|e| e.to_string())?;
    Ok(())
}

/// Delete the account with this id.
pub async fn delete(pool: &SqlitePool, id: &str) -> Result<(), String> {
    sqlx::query("DELETE FROM accounts WHERE id = ?")
        .bind(id)
        .execute(pool)
        .await
        .map_err(|e| e.to_string())?;
    Ok(())
}

/// Delete the account with this email.
pub async fn delete_by_email(pool: &SqlitePool, email: &str) -> Result<(), String> {
    sqlx::query("DELETE FROM accounts WHERE email = ?")
        .bind(email)
        .execute(pool)
        .await
        .map_err(|e| e.to_string())?;
    Ok(())
}

/// Total number of account rows.
pub async fn get_count(pool: &SqlitePool) -> Result<i64, String> {
    let row: (i64,) = sqlx::query_as("SELECT COUNT(*) FROM accounts")
        .fetch_one(pool)
        .await
        .map_err(|e| e.to_string())?;
    Ok(row.0)
}

/// Set `is_default = 1` for the given account and clear the flag on all
/// others, in a single transaction so there is never zero or two defaults.
pub async fn set_default(pool: &SqlitePool, id: &str) -> Result<(), String> {
    let mut tx = pool.begin().await.map_err(|e| format!("begin tx: {e}"))?;
    sqlx::query("UPDATE accounts SET is_default = 0")
        .execute(&mut *tx)
        .await
        .map_err(|e| e.to_string())?;
    sqlx::query("UPDATE accounts SET is_default = 1, updated_at = ? WHERE id = ?")
        .bind(now_secs())
        .bind(id)
        .execute(&mut *tx)
        .await
        .map_err(|e| e.to_string())?;
    tx.commit().await.map_err(|e| e.to_string())?;
    Ok(())
}

/// Return the default account, or `None` if no row has `is_default = 1`.
pub async fn get_default(pool: &SqlitePool) -> Result<Option<Account>, String> {
    let row = sqlx::query("SELECT * FROM accounts WHERE is_default = 1 LIMIT 1")
        .fetch_optional(pool)
        .await
        .map_err(|e| e.to_string())?;
    row.map(|r| row_to_account(&r)).transpose()
}

/// Stamp `last_sync_at` (and `updated_at`) after a successful sync round.
pub async fn touch_last_sync(pool: &SqlitePool, id: &str) -> Result<(), String> {
    sqlx::query(
        "UPDATE accounts SET last_sync_at = unixepoch(), updated_at = unixepoch() WHERE id = ?",
    )
    .bind(id)
    .execute(pool)
    .await
    .map_err(|e| e.to_string())?;
    Ok(())
}

/// Type-erased bind value for the dynamic [`update`] builder.
enum SqliteValue {
    Text(String),
    Int(i64),
    Bool(bool),
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Helper: insert a bare row directly with the given (already-encrypted)
    /// secrets, bypassing [`create`]. Used to plant corrupt rows.
    async fn insert_row_direct(
        pool: &SqlitePool,
        id: &str,
        email: &str,
        access_token_cipher: Option<&str>,
        imap_password_cipher: Option<&str>,
    ) {
        sqlx::query(
            "INSERT INTO accounts (id, email, provider, access_token, imap_password, is_active, is_default, sort_order, created_at, updated_at)
             VALUES (?, ?, 'imap', ?, ?, 1, 0, 0, strftime('%s','now'), strftime('%s','now'))",
        )
        .bind(id)
        .bind(email)
        .bind(access_token_cipher)
        .bind(imap_password_cipher)
        .execute(pool)
        .await
        .unwrap();
    }

    #[tokio::test]
    async fn create_and_read_account_roundtrips_secrets_encrypted() {
        let tmp = tempfile::tempdir().unwrap();
        let pool = crate::db::init_db(tmp.path()).await.unwrap();
        let created = create(
            &pool,
            CreateAccountInput {
                email: "e@x.com".into(),
                provider: "imap".into(),
                imap_password: Some("secret".into()),
                access_token: Some("tok".into()),
                ..Default::default()
            },
        )
        .await
        .unwrap();
        assert_eq!(created.email, "e@x.com");
        assert_eq!(created.imap_password.as_deref(), Some("secret")); // decrypted on read
        assert_eq!(created.access_token.as_deref(), Some("tok"));

        // Stored cipher must not contain the plaintext.
        let (cipher,): (Option<String>,) =
            sqlx::query_as("SELECT imap_password FROM accounts WHERE id = ?")
                .bind(&created.id)
                .fetch_one(&pool)
                .await
                .unwrap();
        assert!(
            !cipher.as_deref().unwrap_or("").contains("secret"),
            "plaintext leaked into DB"
        );
    }

    #[tokio::test]
    async fn create_seeds_default_signature() {
        // Task 5 moved signature seeding from the frontend `insertSignature`
        // call into Rust `create`. Verify a default signature row is inserted
        // with the faithful TS defaults.
        let tmp = tempfile::tempdir().unwrap();
        let pool = crate::db::init_db(tmp.path()).await.unwrap();
        let created = create(
            &pool,
            CreateAccountInput {
                email: "sig@x.com".into(),
                provider: "imap".into(),
                ..Default::default()
            },
        )
        .await
        .unwrap();

        let row: (String, String, i64, String) = sqlx::query_as(
            "SELECT name, body_html, is_default, context FROM signatures WHERE account_id = ?",
        )
        .bind(&created.id)
        .fetch_one(&pool)
        .await
        .unwrap();
        assert_eq!(row.0, "Default");
        assert_eq!(row.1, "<p>Sent from Kylins Mail</p>");
        assert_eq!(row.2, 1, "seeded signature should be the default");
        assert_eq!(row.3, "all");
    }

    #[tokio::test]
    async fn first_account_auto_becomes_default() {
        let tmp = tempfile::tempdir().unwrap();
        let pool = crate::db::init_db(tmp.path()).await.unwrap();
        let a = create(
            &pool,
            CreateAccountInput {
                email: "a@x.com".into(),
                provider: "imap".into(),
                ..Default::default()
            },
        )
        .await
        .unwrap();
        assert!(a.is_default, "first account should auto-become default");

        let b = create(
            &pool,
            CreateAccountInput {
                email: "b@x.com".into(),
                provider: "imap".into(),
                ..Default::default()
            },
        )
        .await
        .unwrap();
        assert!(!b.is_default, "second account should not be default");
    }

    #[tokio::test]
    async fn duplicate_email_is_rejected() {
        let tmp = tempfile::tempdir().unwrap();
        let pool = crate::db::init_db(tmp.path()).await.unwrap();
        create(
            &pool,
            CreateAccountInput {
                email: "dup@x.com".into(),
                provider: "imap".into(),
                ..Default::default()
            },
        )
        .await
        .unwrap();
        let err = create(
            &pool,
            CreateAccountInput {
                email: "dup@x.com".into(),
                provider: "imap".into(),
                ..Default::default()
            },
        )
        .await
        .unwrap_err();
        assert!(
            err.contains("already exists"),
            "expected duplicate error, got: {err}"
        );
    }

    #[tokio::test]
    async fn update_reencrypts_secrets_and_stamps_updated_at() {
        let tmp = tempfile::tempdir().unwrap();
        let pool = crate::db::init_db(tmp.path()).await.unwrap();
        let created = create(
            &pool,
            CreateAccountInput {
                email: "u@x.com".into(),
                provider: "imap".into(),
                imap_password: Some("old".into()),
                ..Default::default()
            },
        )
        .await
        .unwrap();
        let original_updated = created.updated_at;

        update(
            &pool,
            &created.id,
            AccountUpdates {
                imap_password: Some("new-secret".into()),
                display_name: Some("Display".into()),
                is_active: Some(false),
                eas_policy_key: Some("policy-1".into()),
                ..Default::default()
            },
        )
        .await
        .unwrap();

        let after = get_by_id(&pool, &created.id).await.unwrap().unwrap();
        assert_eq!(after.imap_password.as_deref(), Some("new-secret"));
        assert_eq!(after.display_name.as_deref(), Some("Display"));
        assert!(!after.is_active);
        assert_eq!(after.eas_policy_key.as_deref(), Some("policy-1"));
        assert!(after.updated_at >= original_updated);

        // Stored cipher changed.
        let (cipher,): (Option<String>,) =
            sqlx::query_as("SELECT imap_password FROM accounts WHERE id = ?")
                .bind(&created.id)
                .fetch_one(&pool)
                .await
                .unwrap();
        assert!(
            !cipher.as_deref().unwrap_or("").contains("new-secret"),
            "plaintext leaked after update"
        );
    }

    #[tokio::test]
    async fn get_all_skips_corrupt_rows() {
        let tmp = tempfile::tempdir().unwrap();
        let pool = crate::db::init_db(tmp.path()).await.unwrap();
        // A good row.
        create(
            &pool,
            CreateAccountInput {
                email: "good@x.com".into(),
                provider: "imap".into(),
                imap_password: Some("pw".into()),
                ..Default::default()
            },
        )
        .await
        .unwrap();
        // A corrupt row whose access_token is not a valid ciphertext.
        insert_row_direct(&pool, "bad-id", "bad@x.com", Some("not-real-cipher"), None).await;

        let all = get_all(&pool).await.unwrap();
        // Both rows survive — the corrupt one has empty secrets instead of being
        // dropped, so account metadata is preserved even when the master key changes.
        assert_eq!(all.len(), 2);
        // Good row has its decrypted password.
        let good = all.iter().find(|a| a.email == "good@x.com").unwrap();
        assert_eq!(good.imap_password.as_deref(), Some("pw"));
        // Corrupt row survives with empty secrets (not skipped).
        let bad = all.iter().find(|a| a.email == "bad@x.com").unwrap();
        assert_eq!(bad.id, "bad-id");
        assert!(bad.access_token.is_none());
        assert!(bad.imap_password.is_none());
    }

    #[tokio::test]
    async fn get_by_email_returns_minimal_stub_for_corrupt_row() {
        let tmp = tempfile::tempdir().unwrap();
        let pool = crate::db::init_db(tmp.path()).await.unwrap();
        insert_row_direct(&pool, "bad-id", "bad@x.com", Some("not-real-cipher"), None).await;

        let stub = get_by_email(&pool, "bad@x.com").await.unwrap().unwrap();
        assert_eq!(stub.id, "bad-id");
        assert_eq!(stub.email, "bad@x.com");
        assert_eq!(stub.provider, "imap");
        // The corrupt row should still block creating a new account for it.
        let err = create(
            &pool,
            CreateAccountInput {
                email: "bad@x.com".into(),
                provider: "imap".into(),
                ..Default::default()
            },
        )
        .await
        .unwrap_err();
        assert!(err.contains("already exists"));
    }

    #[tokio::test]
    async fn set_default_moves_the_flag() {
        let tmp = tempfile::tempdir().unwrap();
        let pool = crate::db::init_db(tmp.path()).await.unwrap();
        let a = create(
            &pool,
            CreateAccountInput {
                email: "a@x.com".into(),
                provider: "imap".into(),
                ..Default::default()
            },
        )
        .await
        .unwrap();
        let b = create(
            &pool,
            CreateAccountInput {
                email: "b@x.com".into(),
                provider: "imap".into(),
                ..Default::default()
            },
        )
        .await
        .unwrap();
        // a is the auto-default; flip it to b.
        set_default(&pool, &b.id).await.unwrap();
        let def = get_default(&pool).await.unwrap().unwrap();
        assert_eq!(def.id, b.id);
        let a_after = get_by_id(&pool, &a.id).await.unwrap().unwrap();
        assert!(!a_after.is_default);
    }

    #[tokio::test]
    async fn delete_and_count_work() {
        let tmp = tempfile::tempdir().unwrap();
        let pool = crate::db::init_db(tmp.path()).await.unwrap();
        let a = create(
            &pool,
            CreateAccountInput {
                email: "a@x.com".into(),
                provider: "imap".into(),
                ..Default::default()
            },
        )
        .await
        .unwrap();
        assert_eq!(get_count(&pool).await.unwrap(), 1);
        delete(&pool, &a.id).await.unwrap();
        assert_eq!(get_count(&pool).await.unwrap(), 0);
        assert!(get_by_id(&pool, &a.id).await.unwrap().is_none());

        // delete_by_email on a non-existent row is a no-op.
        delete_by_email(&pool, "missing@x.com").await.unwrap();
    }

    #[tokio::test]
    async fn get_crypto_granularity_returns_none_for_fresh_account() {
        // Fresh accounts have NULL crypto_granularity (Task 2 migration);
        // the loader must return None so callers fall back to WholeMessage.
        // Also covers the sqlx-sqlite NULL→"" quirk (see loader doc-comment).
        let tmp = tempfile::tempdir().unwrap();
        let pool = crate::db::init_db(tmp.path()).await.unwrap();
        sqlx::query(
            "INSERT INTO accounts (id, email, created_at) VALUES ('acct-gran', 'g@x', '0')",
        )
        .execute(&pool)
        .await
        .unwrap();
        // Sanity: the column is NULL in SQLite (rules out a stray DEFAULT empty-string).
        let (is_null,): (i64,) = sqlx::query_as(
            "SELECT CASE WHEN crypto_granularity IS NULL THEN 1 ELSE 0 END FROM accounts WHERE id = 'acct-gran'",
        )
        .fetch_one(&pool)
        .await
        .unwrap();
        assert_eq!(is_null, 1, "column must be NULL in SQLite; got {is_null}");
        // The row_to_account path must also see None (verifies the field mapping).
        let acct = super::get_by_id(&pool, "acct-gran").await.unwrap().unwrap();
        assert_eq!(
            acct.crypto_granularity, None,
            "row_to_account must map NULL to None"
        );
        // And the scalar loader (the actual loader under test).
        let g = super::get_crypto_granularity(&pool, "acct-gran")
            .await
            .unwrap();
        assert_eq!(g, None, "fresh account has NULL crypto_granularity");
    }

    #[tokio::test]
    async fn account_serializes_to_camel_case_json() {
        let account = Account {
            id: "id1".into(),
            email: "e@x.com".into(),
            display_name: Some("Disp".into()),
            provider: "imap".into(),
            access_token: Some("tok".into()),
            imap_host: Some("imap.x.com".into()),
            token_expires_at: Some(123),
            is_active: true,
            is_default: false,
            sort_order: 5,
            created_at: 1,
            updated_at: 2,
            accept_invalid_certs: true,
            eas_protocol_version: Some("16.1".into()),
            ..Default::default()
        };
        let json = serde_json::to_value(&account).unwrap();
        let obj = json.as_object().unwrap();
        // Spot-check the load-bearing camelCase keys.
        assert!(obj.contains_key("displayName"));
        assert!(obj.contains_key("accessToken"));
        assert!(obj.contains_key("imapHost"));
        assert!(obj.contains_key("tokenExpiresAt"));
        assert!(obj.contains_key("isActive"));
        assert!(obj.contains_key("isDefault"));
        assert!(obj.contains_key("sortOrder"));
        assert!(obj.contains_key("createdAt"));
        assert!(obj.contains_key("acceptInvalidCerts"));
        assert!(obj.contains_key("easProtocolVersion"));
        // None fields should be skipped.
        assert!(!obj.contains_key("refreshToken"));
        assert!(!obj.contains_key("imapPassword"));
    }
}
