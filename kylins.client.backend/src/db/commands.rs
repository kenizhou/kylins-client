//! Tauri command wrappers around the `db::accounts` query layer.
//!
//! Each command takes `State<'_, SqlitePool>` (the pool managed by
//! [`crate::lib::run`] setup) and delegates to the matching function in
//! [`crate::db::accounts`]. Commands are prefixed `db_` so they do not
//! collide with the legacy frontend IPC. A later task cuts the frontend over
//! to these commands; the JSON shape (camelCase via serde on the DTOs) is
//! identical to what the existing TypeScript `Account` types expect.

use std::collections::HashMap;

use tauri::State;

use sqlx::SqlitePool;

use crate::db::accounts::{
    self, Account, AccountUpdates, CreateAccountInput,
};
use crate::db::labels::{self, MailFolder};
use crate::db::settings;

#[tauri::command]
pub async fn db_get_all_accounts(pool: State<'_, SqlitePool>) -> Result<Vec<Account>, String> {
    accounts::get_all(&pool).await
}

#[tauri::command]
pub async fn db_get_account_by_id(
    pool: State<'_, SqlitePool>,
    id: String,
) -> Result<Option<Account>, String> {
    accounts::get_by_id(&pool, &id).await
}

#[tauri::command]
pub async fn db_get_account_by_email(
    pool: State<'_, SqlitePool>,
    email: String,
) -> Result<Option<Account>, String> {
    accounts::get_by_email(&pool, &email).await
}

#[tauri::command]
pub async fn db_create_account(
    pool: State<'_, SqlitePool>,
    input: CreateAccountInput,
) -> Result<Account, String> {
    accounts::create(&pool, input).await
}

#[tauri::command]
pub async fn db_update_account(
    pool: State<'_, SqlitePool>,
    id: String,
    updates: AccountUpdates,
) -> Result<(), String> {
    accounts::update(&pool, &id, updates).await
}

#[tauri::command]
pub async fn db_delete_account(pool: State<'_, SqlitePool>, id: String) -> Result<(), String> {
    accounts::delete(&pool, &id).await
}

#[tauri::command]
pub async fn db_delete_account_by_email(
    pool: State<'_, SqlitePool>,
    email: String,
) -> Result<(), String> {
    accounts::delete_by_email(&pool, &email).await
}

#[tauri::command]
pub async fn db_get_account_count(pool: State<'_, SqlitePool>) -> Result<i64, String> {
    accounts::get_count(&pool).await
}

#[tauri::command]
pub async fn db_set_default_account(
    pool: State<'_, SqlitePool>,
    id: String,
) -> Result<(), String> {
    accounts::set_default(&pool, &id).await
}

#[tauri::command]
pub async fn db_get_default_account(pool: State<'_, SqlitePool>) -> Result<Option<Account>, String> {
    accounts::get_default(&pool).await
}

// ---- settings (KV) ----

#[tauri::command]
pub async fn db_get_setting(
    pool: State<'_, SqlitePool>,
    key: String,
) -> Result<Option<String>, String> {
    settings::get(&pool, &key).await
}

#[tauri::command]
pub async fn db_set_setting(
    pool: State<'_, SqlitePool>,
    key: String,
    value: String,
) -> Result<(), String> {
    settings::set(&pool, &key, &value).await
}

#[tauri::command]
pub async fn db_get_setting_bool(
    pool: State<'_, SqlitePool>,
    key: String,
) -> Result<Option<bool>, String> {
    settings::get_bool(&pool, &key).await
}

#[tauri::command]
pub async fn db_set_setting_bool(
    pool: State<'_, SqlitePool>,
    key: String,
    value: bool,
) -> Result<(), String> {
    settings::set_bool(&pool, &key, value).await
}

#[tauri::command]
pub async fn db_get_setting_number(
    pool: State<'_, SqlitePool>,
    key: String,
) -> Result<Option<f64>, String> {
    settings::get_number(&pool, &key).await
}

#[tauri::command]
pub async fn db_set_setting_number(
    pool: State<'_, SqlitePool>,
    key: String,
    value: f64,
) -> Result<(), String> {
    settings::set_number(&pool, &key, value).await
}

// ---- labels (folders) ----

#[tauri::command]
pub async fn db_get_folders_by_account(
    pool: State<'_, SqlitePool>,
    account_id: String,
) -> Result<Vec<MailFolder>, String> {
    labels::get_folders_by_account(&pool, &account_id).await
}

#[tauri::command]
pub async fn db_get_all_folders(pool: State<'_, SqlitePool>) -> Result<Vec<MailFolder>, String> {
    labels::get_all_folders(&pool).await
}

#[tauri::command]
pub async fn db_get_folder_by_role(
    pool: State<'_, SqlitePool>,
    account_id: String,
    role: String,
) -> Result<Option<MailFolder>, String> {
    labels::get_folder_by_role(&pool, &account_id, &role).await
}

/// Unread thread counts per label for an account. Serialized as a JSON object
/// `{ label_id: count }` to match the TS `Record<string, number>` return of
/// `getUnreadCountsByAccount`.
#[tauri::command]
pub async fn db_get_unread_counts_by_account(
    pool: State<'_, SqlitePool>,
    account_id: String,
) -> Result<HashMap<String, i64>, String> {
    labels::get_unread_counts_by_account(&pool, &account_id).await
}

#[tauri::command]
pub async fn db_upsert_folders(
    pool: State<'_, SqlitePool>,
    folders: Vec<MailFolder>,
) -> Result<(), String> {
    labels::upsert_folders(&pool, &folders).await
}

/// Create a local user folder. `parentId` is optional.
#[tauri::command]
pub async fn db_create_folder(
    pool: State<'_, SqlitePool>,
    account_id: String,
    name: String,
    parent_id: Option<String>,
) -> Result<MailFolder, String> {
    labels::create_folder(&pool, &account_id, &name, parent_id.as_deref()).await
}

#[tauri::command]
pub async fn db_rename_folder(
    pool: State<'_, SqlitePool>,
    account_id: String,
    label_id: String,
    new_name: String,
) -> Result<(), String> {
    labels::rename_folder(&pool, &account_id, &label_id, &new_name).await
}

#[tauri::command]
pub async fn db_delete_folder(
    pool: State<'_, SqlitePool>,
    account_id: String,
    label_id: String,
) -> Result<(), String> {
    labels::delete_folder(&pool, &account_id, &label_id).await
}
