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
use crate::db::message_bodies;
use crate::db::queue::{self, PendingOperation};
use crate::db::settings;
use crate::db::threads::{self, GetThreadsOptions, MessageRow, ThreadsPage};

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

// ---- threads (reads) + message_bodies ----

/// Load one page of threads for an account, optionally filtered to a label.
/// Mirrors the TS `getThreads` return shape `{ threads, nextCursor }`. The
/// `opts` payload is deserialized directly into [`GetThreadsOptions`] (camelCase
/// via serde), so a TS caller passes `{ labelId, limit, cursor }`.
#[tauri::command]
pub async fn db_get_threads(
    pool: State<'_, SqlitePool>,
    account_id: String,
    opts: GetThreadsOptions,
) -> Result<ThreadsPage, String> {
    threads::get_threads(&pool, &account_id, opts).await
}

/// Load a thread's message metadata (no body_html), oldest→newest. Mirrors the
/// TS `getMessagesForThread`.
#[tauri::command]
pub async fn db_get_messages_for_thread(
    pool: State<'_, SqlitePool>,
    account_id: String,
    thread_id: String,
) -> Result<Vec<MessageRow>, String> {
    threads::get_messages_for_thread(&pool, &account_id, &thread_id).await
}

/// Mark every message in a thread (and the thread row) as read, atomically.
/// Mirrors the TS `markThreadRead`.
#[tauri::command]
pub async fn db_mark_thread_read(
    pool: State<'_, SqlitePool>,
    account_id: String,
    thread_id: String,
) -> Result<(), String> {
    threads::mark_thread_read(&pool, &account_id, &thread_id).await
}

/// Fetch the cached HTML body for a message, or `None` if not present.
#[tauri::command]
pub async fn db_get_message_body(
    pool: State<'_, SqlitePool>,
    account_id: String,
    message_id: String,
) -> Result<Option<message_bodies::MessageBody>, String> {
    message_bodies::get_message_body(&pool, &account_id, &message_id).await
}

/// Store/refresh a body and mark the message as body_cached, atomically.
#[tauri::command]
pub async fn db_set_message_body(
    pool: State<'_, SqlitePool>,
    account_id: String,
    message_id: String,
    body_html: String,
) -> Result<(), String> {
    message_bodies::set_message_body(&pool, &account_id, &message_id, &body_html).await
}

/// Drop a cached body (re-fetched on next open) and clear body_cached.
#[tauri::command]
pub async fn db_evict_body(
    pool: State<'_, SqlitePool>,
    account_id: String,
    message_id: String,
) -> Result<(), String> {
    message_bodies::evict_body(&pool, &account_id, &message_id).await
}

// ---- offline queue (pending_operations) ----

/// Enqueue a pending operation. `params` is a JSON string. Returns the
/// generated operation id.
#[tauri::command]
pub async fn db_enqueue_op(
    pool: State<'_, SqlitePool>,
    account_id: String,
    operation_type: String,
    resource_id: String,
    params: String,
) -> Result<String, String> {
    queue::enqueue(&pool, &account_id, &operation_type, &resource_id, &params).await
}

/// Dequeue up to `limit` due pending operations, oldest-first.
#[tauri::command]
pub async fn db_dequeue_pending(
    pool: State<'_, SqlitePool>,
    limit: Option<i64>,
) -> Result<Vec<PendingOperation>, String> {
    queue::dequeue_pending(&pool, limit.unwrap_or(50)).await
}

/// Remove a completed operation.
#[tauri::command]
pub async fn db_mark_op_completed(pool: State<'_, SqlitePool>, id: String) -> Result<(), String> {
    queue::mark_completed(&pool, &id).await
}

/// Mark an operation as failed, bumping retry_count, scheduling the next retry
/// with exponential backoff, and flipping status to 'failed' once
/// retry_count + 1 >= max_retries. See [`queue::mark_failed`] for the
/// load-bearing pre-increment backoff semantics.
#[tauri::command]
pub async fn db_mark_op_failed(
    pool: State<'_, SqlitePool>,
    id: String,
    error: String,
) -> Result<(), String> {
    queue::mark_failed(&pool, &id, &error).await
}
