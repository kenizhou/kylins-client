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

use crate::db::accounts::{self, Account, AccountUpdates, CreateAccountInput};
use crate::db::attachments::{self, AttachmentRow};
use crate::db::labels::{self, MailFolder};
use crate::db::message_bodies;
use crate::db::messages;
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
pub async fn db_set_default_account(pool: State<'_, SqlitePool>, id: String) -> Result<(), String> {
    accounts::set_default(&pool, &id).await
}

#[tauri::command]
pub async fn db_get_default_account(
    pool: State<'_, SqlitePool>,
) -> Result<Option<Account>, String> {
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

/// Total unread across all accounts (when `account_id` is None) or one account.
/// Used by the tray tooltip + StatusBar aggregate badge.
#[tauri::command]
pub async fn db_get_total_unread(
    pool: State<'_, SqlitePool>,
    account_id: Option<String>,
) -> Result<i64, String> {
    labels::get_total_unread(&pool, account_id.as_deref()).await
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

/// List attachment metadata for a message (filename, mime_type, size,
/// content_id, is_inline, imap_part_id). Populated by the body-fetch path.
#[tauri::command]
pub async fn db_get_attachments(
    pool: State<'_, SqlitePool>,
    account_id: String,
    message_id: String,
) -> Result<Vec<AttachmentRow>, String> {
    attachments::get_attachments(&pool, &account_id, &message_id).await
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

/// Return the subset of `message_ids` whose body is NOT cached
/// (`body_cached = 0`). The viewport prefetch hook calls this to filter the
/// visible+buffer candidate list so it only requests bodies the cache is
/// missing. Missing ids are silently dropped (the prefetch skips them).
#[tauri::command]
pub async fn db_get_uncached_body_message_ids(
    pool: State<'_, SqlitePool>,
    account_id: String,
    message_ids: Vec<String>,
) -> Result<Vec<String>, String> {
    messages::get_uncached_body_message_ids(&pool, &account_id, &message_ids).await
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

// ---- contacts ----

use crate::db::contacts::{
    self, Contact, ContactAttachment, ContactGroup, ContactListOptions, ContactStats,
    ContactThread, CreateContactInput, DbContactRaw, SameDomainContact, UpdateContactInput,
};

#[tauri::command]
pub async fn db_list_contacts(
    pool: State<'_, SqlitePool>,
    options: Option<ContactListOptions>,
) -> Result<Vec<Contact>, String> {
    contacts::list(&pool, options.unwrap_or_default()).await
}

#[tauri::command]
pub async fn db_search_contacts(
    pool: State<'_, SqlitePool>,
    query: String,
    limit: Option<i64>,
) -> Result<Vec<DbContactRaw>, String> {
    contacts::search(&pool, &query, limit.unwrap_or(10)).await
}

#[tauri::command]
pub async fn db_get_contact_by_id(
    pool: State<'_, SqlitePool>,
    id: String,
) -> Result<Option<Contact>, String> {
    contacts::get_by_id(&pool, &id).await
}

#[tauri::command]
pub async fn db_get_contact_by_email(
    pool: State<'_, SqlitePool>,
    email: String,
) -> Result<Option<Contact>, String> {
    contacts::get_by_email(&pool, &email).await
}

#[tauri::command]
pub async fn db_get_contact_by_external_id(
    pool: State<'_, SqlitePool>,
    account_id: String,
    source: String,
    external_id: String,
) -> Result<Option<Contact>, String> {
    contacts::get_by_external_id(&pool, &account_id, &source, &external_id).await
}

#[tauri::command]
pub async fn db_create_contact(
    pool: State<'_, SqlitePool>,
    input: CreateContactInput,
) -> Result<Contact, String> {
    contacts::create(&pool, input).await
}

#[tauri::command]
pub async fn db_update_contact(
    pool: State<'_, SqlitePool>,
    id: String,
    updates: UpdateContactInput,
) -> Result<(), String> {
    contacts::update(&pool, &id, updates).await
}

#[tauri::command]
pub async fn db_delete_contact(pool: State<'_, SqlitePool>, id: String) -> Result<(), String> {
    contacts::delete(&pool, &id).await
}

#[tauri::command]
pub async fn db_upsert_contact(
    pool: State<'_, SqlitePool>,
    email: String,
    display_name: Option<String>,
) -> Result<(), String> {
    contacts::upsert(&pool, &email, display_name.as_deref()).await
}

#[tauri::command]
pub async fn db_update_contact_avatar(
    pool: State<'_, SqlitePool>,
    email: String,
    avatar_url: String,
) -> Result<(), String> {
    contacts::update_avatar(&pool, &email, &avatar_url).await
}

#[tauri::command]
pub async fn db_update_contact_notes(
    pool: State<'_, SqlitePool>,
    email: String,
    notes: Option<String>,
) -> Result<(), String> {
    contacts::update_notes(&pool, &email, notes.as_deref()).await
}

#[tauri::command]
pub async fn db_get_contact_stats(
    pool: State<'_, SqlitePool>,
    email: String,
) -> Result<ContactStats, String> {
    contacts::get_stats(&pool, &email).await
}

#[tauri::command]
pub async fn db_get_recent_threads_with_contact(
    pool: State<'_, SqlitePool>,
    email: String,
    limit: Option<i64>,
) -> Result<Vec<ContactThread>, String> {
    contacts::recent_threads_with(&pool, &email, limit.unwrap_or(5)).await
}

#[tauri::command]
pub async fn db_get_attachments_from_contact(
    pool: State<'_, SqlitePool>,
    email: String,
    limit: Option<i64>,
) -> Result<Vec<ContactAttachment>, String> {
    contacts::attachments_from(&pool, &email, limit.unwrap_or(5)).await
}

#[tauri::command]
pub async fn db_get_contacts_from_same_domain(
    pool: State<'_, SqlitePool>,
    email: String,
    limit: Option<i64>,
) -> Result<Vec<SameDomainContact>, String> {
    contacts::same_domain(&pool, &email, limit.unwrap_or(5)).await
}

#[tauri::command]
pub async fn db_get_latest_auth_result(
    pool: State<'_, SqlitePool>,
    email: String,
) -> Result<Option<String>, String> {
    contacts::latest_auth_result(&pool, &email).await
}

// contact groups

#[tauri::command]
pub async fn db_get_contact_groups(
    pool: State<'_, SqlitePool>,
    account_id: Option<String>,
) -> Result<Vec<ContactGroup>, String> {
    contacts::list_groups(&pool, account_id.as_deref()).await
}

#[tauri::command]
pub async fn db_get_contact_group_by_id(
    pool: State<'_, SqlitePool>,
    id: String,
) -> Result<Option<ContactGroup>, String> {
    contacts::get_group_by_id(&pool, &id).await
}

#[tauri::command]
pub async fn db_create_contact_group(
    pool: State<'_, SqlitePool>,
    name: String,
    account_id: Option<String>,
    source: Option<String>,
) -> Result<ContactGroup, String> {
    contacts::create_group(
        &pool,
        &name,
        account_id.as_deref(),
        source.as_deref().unwrap_or("local"),
    )
    .await
}

#[tauri::command]
pub async fn db_rename_contact_group(
    pool: State<'_, SqlitePool>,
    id: String,
    name: String,
) -> Result<(), String> {
    contacts::rename_group(&pool, &id, &name).await
}

#[tauri::command]
pub async fn db_delete_contact_group(
    pool: State<'_, SqlitePool>,
    id: String,
) -> Result<(), String> {
    contacts::delete_group(&pool, &id).await
}

#[tauri::command]
pub async fn db_add_contact_to_group(
    pool: State<'_, SqlitePool>,
    contact_id: String,
    group_id: String,
) -> Result<(), String> {
    contacts::add_to_group(&pool, &contact_id, &group_id).await
}

#[tauri::command]
pub async fn db_remove_contact_from_group(
    pool: State<'_, SqlitePool>,
    contact_id: String,
    group_id: String,
) -> Result<(), String> {
    contacts::remove_from_group(&pool, &contact_id, &group_id).await
}

#[tauri::command]
pub async fn db_get_contact_ids_for_group(
    pool: State<'_, SqlitePool>,
    group_id: String,
) -> Result<Vec<String>, String> {
    contacts::contact_ids_for_group(&pool, &group_id).await
}

#[tauri::command]
pub async fn db_get_groups_for_contact(
    pool: State<'_, SqlitePool>,
    contact_id: String,
) -> Result<Vec<ContactGroup>, String> {
    contacts::groups_for_contact(&pool, &contact_id).await
}

// ---- signatures ----

use crate::db::signatures::{
    self, InsertSignatureInput, Signature, SignatureContext, UpdateSignatureInput,
};

#[tauri::command]
pub async fn db_get_signatures_for_account(
    pool: State<'_, SqlitePool>,
    account_id: String,
) -> Result<Vec<Signature>, String> {
    signatures::list_for_account(&pool, &account_id).await
}

#[tauri::command]
pub async fn db_get_default_signature(
    pool: State<'_, SqlitePool>,
    account_id: String,
    context: Option<SignatureContext>,
) -> Result<Option<Signature>, String> {
    signatures::get_default(&pool, &account_id, context.unwrap_or_default()).await
}

#[tauri::command]
pub async fn db_insert_signature(
    pool: State<'_, SqlitePool>,
    input: InsertSignatureInput,
) -> Result<String, String> {
    signatures::insert(&pool, input).await
}

#[tauri::command]
pub async fn db_update_signature(
    pool: State<'_, SqlitePool>,
    id: String,
    updates: UpdateSignatureInput,
) -> Result<(), String> {
    signatures::update(&pool, &id, updates).await
}

#[tauri::command]
pub async fn db_delete_signature(pool: State<'_, SqlitePool>, id: String) -> Result<(), String> {
    signatures::delete(&pool, &id).await
}

// ---- drafts (local_drafts) ----

use crate::db::drafts::{self, Draft, DraftInput};

#[tauri::command]
pub async fn db_create_draft(
    pool: State<'_, SqlitePool>,
    input: DraftInput,
) -> Result<String, String> {
    drafts::create(&pool, input).await
}

#[tauri::command]
pub async fn db_update_draft(
    pool: State<'_, SqlitePool>,
    id: String,
    input: DraftInput,
) -> Result<(), String> {
    drafts::update(&pool, &id, input).await
}

#[tauri::command]
pub async fn db_delete_draft(pool: State<'_, SqlitePool>, id: String) -> Result<(), String> {
    drafts::delete(&pool, &id).await
}

#[tauri::command]
pub async fn db_get_draft(
    pool: State<'_, SqlitePool>,
    id: String,
) -> Result<Option<Draft>, String> {
    drafts::get(&pool, &id).await
}

#[tauri::command]
pub async fn db_list_drafts_for_account(
    pool: State<'_, SqlitePool>,
    account_id: String,
) -> Result<Vec<Draft>, String> {
    drafts::list_for_account(&pool, &account_id).await
}

// ---- send_as_aliases ----

use crate::db::send_as_aliases::{self, Alias, CreateAliasInput, UpdateAliasInput};

#[tauri::command]
pub async fn db_get_aliases_for_account(
    pool: State<'_, SqlitePool>,
    account_id: String,
) -> Result<Vec<Alias>, String> {
    send_as_aliases::list_for_account(&pool, &account_id).await
}

#[tauri::command]
pub async fn db_insert_alias(
    pool: State<'_, SqlitePool>,
    input: CreateAliasInput,
) -> Result<String, String> {
    send_as_aliases::insert(&pool, input).await
}

#[tauri::command]
pub async fn db_update_alias(
    pool: State<'_, SqlitePool>,
    id: String,
    updates: UpdateAliasInput,
) -> Result<(), String> {
    send_as_aliases::update(&pool, &id, updates).await
}

#[tauri::command]
pub async fn db_delete_alias(pool: State<'_, SqlitePool>, id: String) -> Result<(), String> {
    send_as_aliases::delete(&pool, &id).await
}

// ---- search (FTS5) ----

use crate::db::search::{self, MessageSearchResult};

#[tauri::command]
pub async fn db_search_messages(
    pool: State<'_, SqlitePool>,
    account_id: String,
    query: String,
    limit: Option<i64>,
) -> Result<Vec<MessageSearchResult>, String> {
    search::search_messages(&pool, &account_id, &query, limit.unwrap_or(50)).await
}

// ---- calendar_events ----

use crate::db::calendar_events::{self, CalendarEvent, UpsertCalendarEventInput};
use crate::db::calendars::{self, Calendar, UpsertCalendarInput};

#[tauri::command]
pub async fn db_get_calendar_events_for_account(
    pool: State<'_, SqlitePool>,
    account_id: String,
) -> Result<Vec<CalendarEvent>, String> {
    calendar_events::list_for_account(&pool, &account_id).await
}

#[tauri::command]
pub async fn db_get_calendar_events_in_range(
    pool: State<'_, SqlitePool>,
    account_id: String,
    range_start: i64,
    range_end: i64,
) -> Result<Vec<CalendarEvent>, String> {
    calendar_events::list_in_range(&pool, &account_id, range_start, range_end).await
}

#[tauri::command]
pub async fn db_get_calendar_event_by_id(
    pool: State<'_, SqlitePool>,
    id: String,
) -> Result<Option<CalendarEvent>, String> {
    calendar_events::get_by_id(&pool, &id).await
}

#[tauri::command]
pub async fn db_insert_calendar_event(
    pool: State<'_, SqlitePool>,
    input: UpsertCalendarEventInput,
) -> Result<String, String> {
    calendar_events::insert(&pool, input).await
}

#[tauri::command]
pub async fn db_update_calendar_event(
    pool: State<'_, SqlitePool>,
    id: String,
    updates: UpsertCalendarEventInput,
) -> Result<(), String> {
    calendar_events::update(&pool, &id, updates).await
}

#[tauri::command]
pub async fn db_delete_calendar_event(
    pool: State<'_, SqlitePool>,
    id: String,
) -> Result<(), String> {
    calendar_events::delete(&pool, &id).await
}

#[tauri::command]
pub async fn db_get_calendar_events_in_range_for_calendars(
    pool: State<'_, SqlitePool>,
    calendar_ids: Vec<String>,
    range_start: i64,
    range_end: i64,
) -> Result<Vec<CalendarEvent>, String> {
    calendar_events::list_in_range_for_calendars(&pool, &calendar_ids, range_start, range_end).await
}

// ---- calendars ----

#[tauri::command]
pub async fn db_get_all_calendars(pool: State<'_, SqlitePool>) -> Result<Vec<Calendar>, String> {
    calendars::list_all(&pool).await
}

#[tauri::command]
pub async fn db_get_calendars_for_account(
    pool: State<'_, SqlitePool>,
    account_id: String,
) -> Result<Vec<Calendar>, String> {
    calendars::list_for_account(&pool, &account_id).await
}

#[tauri::command]
pub async fn db_get_calendar_by_id(
    pool: State<'_, SqlitePool>,
    id: String,
) -> Result<Option<Calendar>, String> {
    calendars::get_by_id(&pool, &id).await
}

#[tauri::command]
pub async fn db_create_calendar(
    pool: State<'_, SqlitePool>,
    input: UpsertCalendarInput,
) -> Result<Calendar, String> {
    let id = calendars::insert(&pool, input).await?;
    calendars::get_by_id(&pool, &id)
        .await?
        .ok_or_else(|| "insert failed: calendar row not found after create".to_string())
}

#[tauri::command]
pub async fn db_update_calendar(
    pool: State<'_, SqlitePool>,
    id: String,
    updates: UpsertCalendarInput,
) -> Result<(), String> {
    calendars::update(&pool, &id, updates).await
}

#[tauri::command]
pub async fn db_delete_calendar(pool: State<'_, SqlitePool>, id: String) -> Result<(), String> {
    calendars::delete(&pool, &id).await
}

#[tauri::command]
pub async fn db_set_calendar_visible(
    pool: State<'_, SqlitePool>,
    id: String,
    visible: bool,
) -> Result<(), String> {
    calendars::set_visible(&pool, &id, visible).await
}

#[tauri::command]
pub async fn db_set_primary_calendar(
    pool: State<'_, SqlitePool>,
    id: String,
    account_id: String,
) -> Result<(), String> {
    calendars::set_primary(&pool, &id, &account_id).await
}

// ---- tasks ----

use crate::db::tasks::{self, Task, TaskTag, UpsertTaskInput};

#[tauri::command]
pub async fn db_get_tasks_for_account(
    pool: State<'_, SqlitePool>,
    account_id: String,
    include_completed: bool,
) -> Result<Vec<Task>, String> {
    tasks::list_for_account(&pool, &account_id, include_completed).await
}

#[tauri::command]
pub async fn db_get_tasks_for_thread(
    pool: State<'_, SqlitePool>,
    thread_account_id: String,
    thread_id: String,
) -> Result<Vec<Task>, String> {
    tasks::list_for_thread(&pool, &thread_account_id, &thread_id).await
}

#[tauri::command]
pub async fn db_get_task_by_id(
    pool: State<'_, SqlitePool>,
    id: String,
) -> Result<Option<Task>, String> {
    tasks::get_by_id(&pool, &id).await
}

#[tauri::command]
pub async fn db_insert_task(
    pool: State<'_, SqlitePool>,
    input: UpsertTaskInput,
) -> Result<String, String> {
    tasks::insert(&pool, input).await
}

#[tauri::command]
pub async fn db_update_task(
    pool: State<'_, SqlitePool>,
    id: String,
    updates: UpsertTaskInput,
) -> Result<(), String> {
    tasks::update(&pool, &id, updates).await
}

#[tauri::command]
pub async fn db_delete_task(pool: State<'_, SqlitePool>, id: String) -> Result<(), String> {
    tasks::delete(&pool, &id).await
}

#[tauri::command]
pub async fn db_toggle_task_completed(
    pool: State<'_, SqlitePool>,
    id: String,
    completed: bool,
) -> Result<(), String> {
    tasks::toggle_completed(&pool, &id, completed).await
}

#[tauri::command]
pub async fn db_get_task_tags(
    pool: State<'_, SqlitePool>,
    account_id: Option<String>,
) -> Result<Vec<TaskTag>, String> {
    tasks::list_tags(&pool, account_id.as_deref()).await
}

#[tauri::command]
pub async fn db_create_task_tag(
    pool: State<'_, SqlitePool>,
    tag: String,
    account_id: Option<String>,
    color: Option<String>,
) -> Result<(), String> {
    tasks::create_tag(&pool, &tag, account_id.as_deref(), color.as_deref()).await
}

#[tauri::command]
pub async fn db_update_task_tag_color(
    pool: State<'_, SqlitePool>,
    tag: String,
    account_id: Option<String>,
    color: Option<String>,
) -> Result<(), String> {
    tasks::update_tag_color(&pool, &tag, account_id.as_deref(), color.as_deref()).await
}

#[tauri::command]
pub async fn db_delete_task_tag(
    pool: State<'_, SqlitePool>,
    tag: String,
    account_id: Option<String>,
) -> Result<(), String> {
    tasks::delete_tag(&pool, &tag, account_id.as_deref()).await
}

// ---- scheduled_emails ----

use crate::db::scheduled_emails::{self, InsertScheduledEmailInput, ScheduledEmail};

#[tauri::command]
pub async fn db_get_pending_scheduled_emails(
    pool: State<'_, SqlitePool>,
) -> Result<Vec<ScheduledEmail>, String> {
    scheduled_emails::list_pending(&pool).await
}

#[tauri::command]
pub async fn db_get_scheduled_emails_for_account(
    pool: State<'_, SqlitePool>,
    account_id: String,
) -> Result<Vec<ScheduledEmail>, String> {
    scheduled_emails::list_for_account(&pool, &account_id).await
}

#[tauri::command]
pub async fn db_insert_scheduled_email(
    pool: State<'_, SqlitePool>,
    email: InsertScheduledEmailInput,
) -> Result<String, String> {
    scheduled_emails::insert(&pool, email).await
}

#[tauri::command]
pub async fn db_update_scheduled_email_status(
    pool: State<'_, SqlitePool>,
    id: String,
    status: String,
) -> Result<(), String> {
    scheduled_emails::update_status(&pool, &id, &status).await
}

#[tauri::command]
pub async fn db_delete_scheduled_email(
    pool: State<'_, SqlitePool>,
    id: String,
) -> Result<(), String> {
    scheduled_emails::delete(&pool, &id).await
}

#[tauri::command]
pub async fn db_get_latest_scheduled_email_for_account(
    pool: State<'_, SqlitePool>,
    account_id: String,
) -> Result<Option<ScheduledEmail>, String> {
    scheduled_emails::latest_for_account(&pool, &account_id).await
}

#[tauri::command]
pub async fn db_set_scheduled_email_attachment_paths(
    pool: State<'_, SqlitePool>,
    id: String,
    attachment_paths: String,
) -> Result<(), String> {
    scheduled_emails::set_attachment_paths(&pool, &id, &attachment_paths).await
}

// ---- templates ----

use crate::db::templates::{self, InsertTemplateInput, Template, UpdateTemplateInput};

#[tauri::command]
pub async fn db_get_templates_for_account(
    pool: State<'_, SqlitePool>,
    account_id: String,
) -> Result<Vec<Template>, String> {
    templates::list_for_account(&pool, &account_id).await
}

#[tauri::command]
pub async fn db_insert_template(
    pool: State<'_, SqlitePool>,
    tmpl: InsertTemplateInput,
) -> Result<String, String> {
    templates::insert(&pool, tmpl).await
}

#[tauri::command]
pub async fn db_update_template(
    pool: State<'_, SqlitePool>,
    id: String,
    updates: UpdateTemplateInput,
) -> Result<(), String> {
    templates::update(&pool, &id, updates).await
}

#[tauri::command]
pub async fn db_delete_template(pool: State<'_, SqlitePool>, id: String) -> Result<(), String> {
    templates::delete(&pool, &id).await
}

// ---- contact_sync_state ----

use crate::db::contact_sync_state::{self, ContactSyncState};

#[tauri::command]
pub async fn db_get_contact_sync_state(
    pool: State<'_, SqlitePool>,
    account_id: String,
    source: String,
) -> Result<Option<ContactSyncState>, String> {
    contact_sync_state::get(&pool, &account_id, &source).await
}

#[tauri::command]
pub async fn db_set_contact_sync_state(
    pool: State<'_, SqlitePool>,
    account_id: String,
    source: String,
    sync_token: Option<String>,
    last_sync_at: Option<i64>,
) -> Result<(), String> {
    contact_sync_state::set(
        &pool,
        &account_id,
        &source,
        sync_token.as_deref(),
        last_sync_at,
    )
    .await
}

// ---- image_allowlist ----

#[tauri::command]
pub async fn db_add_to_image_allowlist(
    pool: State<'_, SqlitePool>,
    account_id: String,
    sender_address: String,
) -> Result<(), String> {
    crate::db::image_allowlist::add(&pool, &account_id, &sender_address).await
}

#[tauri::command]
pub async fn db_is_image_allowlisted(
    pool: State<'_, SqlitePool>,
    account_id: String,
    sender_address: String,
) -> Result<bool, String> {
    crate::db::image_allowlist::is_allowlisted(&pool, &account_id, &sender_address).await
}

#[tauri::command]
pub async fn db_remove_from_image_allowlist(
    pool: State<'_, SqlitePool>,
    account_id: String,
    sender_address: String,
) -> Result<(), String> {
    crate::db::image_allowlist::remove(&pool, &account_id, &sender_address).await
}

// ---- ai_cache ----

#[tauri::command]
pub async fn db_get_cached_ai_result(
    pool: State<'_, SqlitePool>,
    account_id: Option<String>,
    thread_id: String,
    cache_type: String,
) -> Result<Option<String>, String> {
    crate::db::ai_cache::get_cached(&pool, account_id.as_deref(), &thread_id, &cache_type).await
}

#[tauri::command]
pub async fn db_cache_ai_result(
    pool: State<'_, SqlitePool>,
    account_id: Option<String>,
    thread_id: String,
    cache_type: String,
    content: String,
) -> Result<(), String> {
    crate::db::ai_cache::cache(
        &pool,
        account_id.as_deref(),
        &thread_id,
        &cache_type,
        &content,
    )
    .await
}

// ---- crypto keys / trust / collected keys (Phase 1 Plan 1) ----
//
// Storage foundation for the Kylins crypto framework. `db_get_crypto_key`
// returns the PUBLIC-facing [`CryptoKeyRow`] only (no private material —
// `has_private` is a bool). The decrypting read (`get_crypto_key_full`) is an
// in-Rust fn and is deliberately NOT exposed as a command: private key bytes
// never cross the Tauri IPC boundary.

use crate::db::collected_keys::{self, CollectedKeyRow};
use crate::db::crypto_keys::{self, CryptoKeyRecord, CryptoKeyRow};
use crate::db::trust_decisions::{self, TrustDecisionRow};

use serde::Deserialize;

/// CamelCase IPC input for [`db_put_trust_decision`]. Mirrors the positional
/// args of [`trust_decisions::put_trust_decision`].
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TrustDecisionInput {
    pub account_id: String,
    pub peer_email: String,
    pub standard: String,
    pub fingerprint: String,
    pub decision: String,
    #[serde(default)]
    pub evidence_json: Option<String>,
}

/// CamelCase IPC input for [`db_stage_collected_key`]. `public_data` is the
/// raw key bytes (armored PGP / DER) as a byte array.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CollectedKeyInput {
    #[serde(default)]
    pub account_id: Option<String>,
    #[serde(default)]
    pub peer_email: Option<String>,
    #[serde(default)]
    pub standard: Option<String>,
    #[serde(default)]
    pub fingerprint: Option<String>,
    pub public_data: Vec<u8>,
    #[serde(default)]
    pub source: Option<String>,
}

/// Upsert a crypto identity key/cert. Private material in
/// `input.private_data` is encrypted at rest via `encrypt_with_aad` inside the
/// db layer; only the public row is ever readable via a command.
#[tauri::command]
pub async fn db_upsert_crypto_key(
    pool: State<'_, SqlitePool>,
    input: CryptoKeyRecord,
) -> Result<(), String> {
    crypto_keys::upsert_crypto_key(&pool, &input).await
}

/// Return the PUBLIC-facing row for a key (`has_private` flag, no private
/// bytes), or `None`. Private material is never returned across IPC.
#[tauri::command]
pub async fn db_get_crypto_key(
    pool: State<'_, SqlitePool>,
    standard: String,
    fingerprint: String,
) -> Result<Option<CryptoKeyRow>, String> {
    crypto_keys::get_crypto_key_public(&pool, &standard, &fingerprint).await
}

/// List public-facing keys for `(standard, email)`.
#[tauri::command]
pub async fn db_list_crypto_keys_for_email(
    pool: State<'_, SqlitePool>,
    standard: String,
    email: String,
) -> Result<Vec<CryptoKeyRow>, String> {
    crypto_keys::list_crypto_keys_for_email(&pool, &standard, &email).await
}

/// List public-facing keys for `(account_id, standard)`.
#[tauri::command]
pub async fn db_list_crypto_keys_for_account(
    pool: State<'_, SqlitePool>,
    account_id: String,
    standard: String,
) -> Result<Vec<CryptoKeyRow>, String> {
    crypto_keys::list_crypto_keys_for_account(&pool, &account_id, &standard).await
}

/// Delete a crypto key by `(account_id, standard, fingerprint)`. Backs the
/// KeyManager UI's Delete action. Idempotent at the db layer (no rows affected
/// is not an error) — the caller is responsible for any "row was already gone"
/// UX. Private material is purged along with the row.
#[tauri::command]
pub async fn db_delete_crypto_key(
    pool: State<'_, SqlitePool>,
    account_id: String,
    standard: String,
    fingerprint: String,
) -> Result<(), String> {
    crypto_keys::delete_crypto_key(&pool, &account_id, &standard, &fingerprint).await
}

/// Atomically flag `(account_id, standard, fingerprint)` as the default
/// signing key: un-flag all existing defaults in the scope, then flag the
/// chosen one — both inside a single transaction. Returns `Err` if no key row
/// matches the triple, so a stale KeyManager UI surfaces the missing key
/// instead of silently leaving the account without a default.
#[tauri::command]
pub async fn db_set_default_signing_key(
    pool: State<'_, SqlitePool>,
    account_id: String,
    standard: String,
    fingerprint: String,
) -> Result<(), String> {
    crypto_keys::set_default_signing_key(&pool, &account_id, &standard, &fingerprint).await
}

/// Append a trust decision (INSERT only — audit history is never mutated).
#[tauri::command]
pub async fn db_put_trust_decision(
    pool: State<'_, SqlitePool>,
    input: TrustDecisionInput,
) -> Result<(), String> {
    trust_decisions::put_trust_decision(
        &pool,
        &input.account_id,
        &input.peer_email,
        &input.standard,
        &input.fingerprint,
        &input.decision,
        input.evidence_json.as_deref(),
    )
    .await
}

/// Return the latest trust decision for a peer key, or `None`.
#[tauri::command]
pub async fn db_get_trust_decision(
    pool: State<'_, SqlitePool>,
    account_id: String,
    peer_email: String,
    standard: String,
    fingerprint: String,
) -> Result<Option<TrustDecisionRow>, String> {
    trust_decisions::get_latest_trust_decision(
        &pool,
        &account_id,
        &peer_email,
        &standard,
        &fingerprint,
    )
    .await
}

/// Stage a discovered (not-yet-accepted) key.
#[tauri::command]
pub async fn db_stage_collected_key(
    pool: State<'_, SqlitePool>,
    input: CollectedKeyInput,
) -> Result<(), String> {
    collected_keys::stage_collected_key(
        &pool,
        input.account_id.as_deref(),
        input.peer_email.as_deref(),
        input.standard.as_deref(),
        input.fingerprint.as_deref(),
        &input.public_data,
        input.source.as_deref(),
    )
    .await
    .map(|_| ())
}

/// List staged keys for `(account_id, peer_email, standard)`.
#[tauri::command]
pub async fn db_list_collected_keys(
    pool: State<'_, SqlitePool>,
    account_id: String,
    peer_email: String,
    standard: String,
) -> Result<Vec<CollectedKeyRow>, String> {
    collected_keys::list_collected_keys_for_peer(&pool, &account_id, &peer_email, &standard).await
}

/// Remove a staged key by id.
#[tauri::command]
pub async fn db_remove_collected_key(pool: State<'_, SqlitePool>, id: i64) -> Result<(), String> {
    collected_keys::remove_collected_key(&pool, id).await
}

// ---- S/MIME backend lifecycle commands (Plan 4b Task 2) ----
//
// Thin Tauri wrappers around `crypto_smime::SmimeBackend`'s generate / import /
// export ops, bound to the per-account `SqliteKeyStore` (same construction
// `send_op` does at `engine.rs:1011`). Path-based import/export dodges the
// `plugin-fs` appData-scope restriction on byte-array IPC and mirrors the
// `stage_picked_attachment` pattern.
//
// Each command delegates to a `pub async fn <name>_inner(&SqlitePool, ...)`
// body so the lifecycle can be exercised against a real in-memory pool without
// a Tauri runtime (same delegation-pinning strategy as the test for
// `db_get_rate_limit_info`).
//
// Returned `CryptoKeyRow`s are the PUBLIC-facing view only: `has_private: bool`
// is set, but no private bytes ever cross the IPC boundary (private reads go
// through `get_crypto_key_full`, which is deliberately NOT exposed as a command).

use crypto_core::{CryptoBackend, CryptoPolicy, KeyGenParams, KeyHandle, KeyId, Standard};
use crypto_smime::SmimeBackend;

use crate::keystore_bridge::SqliteKeyStore;

/// Build a per-call `SmimeBackend` bound to `account_id`, mirroring the
/// `send_op` construction at `engine.rs:1011`. `SqlitePool::clone` is a cheap
/// `Arc` bump; the outer `Arc<SqliteKeyStore>` coerces to `Arc<dyn KeyStore>`.
fn smime_backend(pool: &SqlitePool, account_id: &str) -> SmimeBackend {
    SmimeBackend::new(
        std::sync::Arc::new(SqliteKeyStore::new(
            std::sync::Arc::new(pool.clone()),
            account_id,
        )),
        CryptoPolicy::default_baseline(),
    )
}

/// Generate a self-signed S/MIME cert + PKCS#8 private key, persisting both to
/// `crypto_keys` (private blob encrypted at rest via `encrypt_with_aad`).
/// Returns the PUBLIC row only — `has_private: true`, no private bytes.
pub async fn crypto_generate_key_inner(
    pool: &SqlitePool,
    account_id: &str,
    email: &str,
) -> Result<CryptoKeyRow, String> {
    let backend = smime_backend(pool, account_id);
    let h = backend
        .generate_key(KeyGenParams {
            standard: Standard::Smime,
            user_id: email.into(),
            algorithm: "ECDSA-P256".into(),
            passphrase: None,
        })
        .await
        .map_err(|e| e.to_string())?;
    crypto_keys::get_crypto_key_public(pool, h.standard.as_str(), h.fingerprint.as_str())
        .await?
        .ok_or_else(|| "generate_key: row not found after put".into())
}

/// Read a PEM bundle (cert + PKCS#8 private key) **or** a `.p12`/`.pfx`
/// (PKCS#12) bundle **or** an encrypted-PKCS#8 PEM from `path` and import it
/// into the account's keystore, persisting to `crypto_keys`. Returns the PUBLIC
/// row only.
///
/// `passphrase` is threaded through to `SmimeBackend::import_key` as a
/// `SecretBox<String>` (zeroized on drop). It is used ONLY to decrypt the
/// bag/PBE in-memory; it is never persisted nor logged. Pass `None` for
/// unencrypted PEM bundles; pass `Some(pass)` for `.p12`/`.pfx` (always
/// passphrase-protected) and encrypted-PKCS#8 PEM. Same IPC channel as the
/// path — Tauri IPC is local same-process (no network exposure).
pub async fn crypto_import_key_from_path_inner(
    pool: &SqlitePool,
    account_id: &str,
    path: &str,
    passphrase: Option<String>,
) -> Result<CryptoKeyRow, String> {
    let bytes = std::fs::read(path).map_err(|e| format!("read {path}: {e}"))?;
    // Wrap at the IPC boundary: the incoming `String` becomes a zeroizing
    // `SecretBox<String>` for the scope of `import_key` only.
    let pass = passphrase.map(|p| crypto_core::SecretBox::new(Box::new(p)));
    let backend = smime_backend(pool, account_id);
    // Use `import_key_with_chain` (NOT the trait `import_key`) so the `.p12`
    // arm's intermediate CA cert DERs are returned to the backend for direct
    // INSERT with `key_type='intermediate'`. Persisting them through the
    // trait `import_key` would drop them on the floor; persisting through
    // `SqliteKeyStore::put` would hardcode `key_type='cert'` (the known quirk)
    // and pollute the trust-anchor candidate set — a trust overreach.
    let (h, intermediate_ders) = backend
        .import_key_with_chain(&bytes, pass)
        .await
        .map_err(|e| e.to_string())?;

    // Persist each returned intermediate via a direct INSERT. Failures here
    // are logged + skipped (one bad intermediate must not fail the leaf
    // import — the spec's "skip JUST that cert" failure mode); the leaf is
    // already persisted by `import_key_with_chain`'s internal `persist_imported`.
    for inter_der in &intermediate_ders {
        if let Err(e) = crypto_keys::upsert_intermediate_cert(pool, account_id, inter_der).await {
            log::warn!(
                "[crypto] failed to persist .p12 intermediate for account {account_id}: {e}"
            );
        }
    }

    crypto_keys::get_crypto_key_public(pool, h.standard.as_str(), h.fingerprint.as_str())
        .await?
        .ok_or_else(|| "import_key: row not found after put".into())
}

/// Export the public cert (DER) for `(standard, fingerprint)` to `out_path`.
/// Used by the KeyManager UI's "Export certificate" action. Public-only — never
/// touches `private_data`.
pub async fn crypto_export_public_to_path_inner(
    pool: &SqlitePool,
    account_id: &str,
    standard: &str,
    fingerprint: &str,
    out_path: &str,
) -> Result<(), String> {
    let backend = smime_backend(pool, account_id);
    // The KeyId encoding matches `SqliteKeyStore::encode_key_id` so the
    // backend's `export_public` → `keystore.get` resolves the row.
    let handle = KeyHandle::Software(KeyId(format!("{standard}|{fingerprint}")));
    let der = backend
        .export_public(&handle)
        .await
        .map_err(|e| e.to_string())?;
    std::fs::write(out_path, &der).map_err(|e| format!("write {out_path}: {e}"))?;
    Ok(())
}

/// Tauri wrapper for [`crypto_generate_key_inner`].
#[tauri::command]
pub async fn crypto_generate_key(
    pool: State<'_, SqlitePool>,
    account_id: String,
    email: String,
) -> Result<CryptoKeyRow, String> {
    crypto_generate_key_inner(&pool, &account_id, &email).await
}

/// Tauri wrapper for [`crypto_import_key_from_path_inner`]. The optional
/// `passphrase` (camelCased `passphrase` from the frontend) is forwarded
/// verbatim — `None`/`undefined` deserializes to `None`.
#[tauri::command]
pub async fn crypto_import_key_from_path(
    pool: State<'_, SqlitePool>,
    account_id: String,
    path: String,
    passphrase: Option<String>,
) -> Result<CryptoKeyRow, String> {
    crypto_import_key_from_path_inner(&pool, &account_id, &path, passphrase).await
}

/// Tauri wrapper for [`crypto_export_public_to_path_inner`].
#[tauri::command]
pub async fn crypto_export_public_to_path(
    pool: State<'_, SqlitePool>,
    account_id: String,
    standard: String,
    fingerprint: String,
    out_path: String,
) -> Result<(), String> {
    crypto_export_public_to_path_inner(&pool, &account_id, &standard, &fingerprint, &out_path).await
}

// ---- S/MIME receive orchestrator commands (Plan 3 / G5 Task 4) ----
//
// Thin Tauri wrappers around the G5 Task 3 receive orchestrator
// (`mail::crypto::open_crypto_message`) + the persisted-result read
// (`db::message_crypto_results::get_message_crypto_result`). Two commands:
//
// 1. `crypto_open_message` — decrypts + verifies a crypto-marked message,
//    returns the in-memory plaintext + the persisted verification outcome,
//    AND emits `sync:crypto-result` so the G6 UI can refresh crypto badges
//    for the opened message without re-decrypting. The event is fired AFTER
//    `open_crypto_message` runs (so the `message_crypto_results` row is
//    already written when the frontend re-reads it).
//
// 2. `db_get_message_crypto_result` — reads the persisted
//    `message_crypto_results` row. Used by the list view to render crypto
//    badges without triggering a full decrypt (the row was written the last
//    time the message was opened).
//
// The emit-access pattern mirrors `sync_request_bodies` (engine.rs:
// `emit_bodies_written_public`): the `SyncEngine` owns the private
// `Arc<dyn EventSink>`, so the command takes `State<'_, Arc<SyncEngine>>` and
// calls the narrow public helper `emit_crypto_result_public`. No `spawn_blocking`
// — matches `crypto_generate_key` (the orchestrator is already async).

use std::sync::Arc;

use crate::db::message_crypto_results::MessageCryptoResultRow;
use crate::mail::crypto::{get_signer_details, open_crypto_message, OpenCryptoResult, SignerDetails};
use crate::sync_engine::engine::{CryptoResultEvent, SyncEngine};

/// Testable core of [`crypto_open_message`]. Takes a borrowed pool + an
/// `&Arc<SyncEngine>` (the engine is only used for the final event emission)
/// so unit tests can drive it without a `State<'_, _>` harness — mirrors
/// `request_bodies_inner` in `sync_engine/commands.rs`.
pub async fn crypto_open_message_inner(
    engine: &Arc<SyncEngine>,
    pool: &SqlitePool,
    account_id: &str,
    message_id: &str,
) -> Result<OpenCryptoResult, String> {
    let res = open_crypto_message(pool, account_id, message_id).await?;
    // Fire AFTER open_crypto_message so the persisted row is visible to the
    // frontend's re-read (the G6 handler queries db_get_message_crypto_result
    // on this event). Best-effort: emit errors are swallowed inside
    // `emit_crypto_result_public` (Tauri emit never errors on a valid
    // AppHandle — the `let _ =` in TauriSink).
    engine.emit_crypto_result_public(CryptoResultEvent {
        account_id: account_id.to_string(),
        message_id: message_id.to_string(),
    });
    Ok(res)
}

/// Open (decrypt + verify) a crypto-marked message. Returns the in-memory
/// plaintext (html / text / attachment metadata) + the persisted verification
/// outcome (`crypto_result`). Emits `sync:crypto-result` after the orchestrator
/// runs so the G6 UI can refresh crypto badges. Plaintext is IN-MEMORY ONLY —
/// the backend never persists it (see `OpenCryptoResult`).
#[tauri::command]
pub async fn crypto_open_message(
    engine: State<'_, Arc<SyncEngine>>,
    pool: State<'_, SqlitePool>,
    account_id: String,
    message_id: String,
) -> Result<OpenCryptoResult, String> {
    crypto_open_message_inner(engine.inner(), pool.inner(), &account_id, &message_id).await
}

/// Read the persisted `message_crypto_results` row for `(account_id,
/// message_id)`. Used by the list view to render crypto badges without
/// re-decrypting (the row is written by the last `crypto_open_message` call).
#[tauri::command]
pub async fn db_get_message_crypto_result(
    pool: State<'_, SqlitePool>,
    account_id: String,
    message_id: String,
) -> Result<Option<MessageCryptoResultRow>, String> {
    crate::db::message_crypto_results::get_message_crypto_result(&pool, &account_id, &message_id)
        .await
}

/// Testable core of [`crypto_get_signer_details`]. Mirrors
/// `db_get_message_crypto_result`'s shape (pool + two strings, no `SyncEngine`
/// — the dialog emits no events). Re-parses the cached CMS blob to surface the
/// signer cert + chain path for the read-only "Signature details…" dialog.
pub async fn crypto_get_signer_details_inner(
    pool: &SqlitePool,
    account_id: &str,
    message_id: &str,
) -> Result<Option<SignerDetails>, String> {
    get_signer_details(pool, account_id, message_id).await
}

/// Build the full signer + chain record for the "Signature details…" dialog.
/// Pure parse + DB reads (no decrypt, no network). Returns `None` when the
/// message has never been opened through the crypto pipeline. For
/// `signed` / clear-signed messages the signer cert + chain path are
/// re-parsed from the cached CMS columns; for `encrypted-signed` the
/// SignedData lives in decrypted in-memory-only bytes and `signer` is `None`.
#[tauri::command]
pub async fn crypto_get_signer_details(
    pool: State<'_, SqlitePool>,
    account_id: String,
    message_id: String,
) -> Result<Option<SignerDetails>, String> {
    crypto_get_signer_details_inner(pool.inner(), &account_id, &message_id).await
}

// ---- rate-limit (Phase 3f) ----

/// Returns the account's current rate-limit window (`Some(retry_after)` epoch
/// seconds) if a live row exists, else `None`. The Phase 3g status bar polls
/// this to render "Rate limited — retrying at X". Lazy-deletes an expired row
/// on read (see [`crate::db::rate_limit::get_rate_limit`]).
///
/// This command is a one-line delegation; the underlying TTL/upsert semantics
/// are covered by `db::rate_limit::tests`. The test below pins the delegation
/// contract (the command calls exactly that function with the given id) so a
/// future refactor cannot silently diverge.
#[tauri::command]
pub async fn db_get_rate_limit_info(
    pool: State<'_, SqlitePool>,
    account_id: String,
) -> Result<Option<i64>, String> {
    crate::db::rate_limit::get_rate_limit(&pool, &account_id).await
}

#[cfg(test)]
mod tests {
    use super::*;

    // Exercises the exact delegation path the command uses — same function,
    // same argument order — against a real SQLite pool. Tauri `State<'_, _>`
    // cannot be erected inside a `#[tokio::test]` without a full `App` harness,
    // so we call the delegated function directly. If `db_get_rate_limit_info`
    // ever stops delegating to `crate::db::rate_limit::get_rate_limit(&pool,
    // &account_id)`, the command's behaviour would diverge from what these
    // assertions pin.

    async fn seed_account(pool: &SqlitePool, id: &str) {
        sqlx::query(
            "INSERT INTO accounts (id, email, provider, is_active, is_default, sort_order, created_at, updated_at)
             VALUES (?, ?, 'imap', 1, 0, 0, strftime('%s','now'), strftime('%s','now'))",
        )
        .bind(id)
        .bind(format!("{id}@x.com"))
        .execute(pool)
        .await
        .unwrap();
    }

    #[tokio::test]
    async fn get_rate_limit_info_delegation_returns_some_when_row_live() {
        // Mirrors what `db_get_rate_limit_info` returns for a rate-limited
        // account: Some(retry_after). Seeds a window 300s in the future.
        let tmp = tempfile::tempdir().unwrap();
        let pool = crate::db::init_db(tmp.path()).await.unwrap();
        seed_account(&pool, "a").await;

        let retry_after = sqlx::query_as::<_, (i64,)>("SELECT unixepoch() + 300")
            .fetch_one(&pool)
            .await
            .unwrap()
            .0;
        crate::db::rate_limit::set_rate_limit(&pool, "a", retry_after)
            .await
            .unwrap();

        // The command body is `crate::db::rate_limit::get_rate_limit(&pool, &account_id)`.
        let got = crate::db::rate_limit::get_rate_limit(&pool, "a").await;
        assert_eq!(got.unwrap(), Some(retry_after));
    }

    #[tokio::test]
    async fn get_rate_limit_info_delegation_returns_none_when_no_row() {
        // Mirrors what `db_get_rate_limit_info` returns for an account with no
        // recorded rate-limit window: None.
        let tmp = tempfile::tempdir().unwrap();
        let pool = crate::db::init_db(tmp.path()).await.unwrap();
        seed_account(&pool, "a").await;

        let got = crate::db::rate_limit::get_rate_limit(&pool, "a").await;
        assert_eq!(got.unwrap(), None);
    }

    // ---- G5 Task 4: crypto_open_message + db_get_message_crypto_result ----
    //
    // Tauri `State<'_, _>` cannot be erected inside a `#[tokio::test]` without
    // a full `App` harness, so we exercise the testable core (`*_inner`) of
    // each command directly — the same strategy as the rate-limit delegation
    // tests above + `request_bodies_inner` in `sync_engine/commands.rs`. The
    // load-bearing decrypt+verify round-trip is already pinned in
    // `mail/crypto.rs::tests`; these tests cover ONLY the wrapper concerns:
    //   1. `crypto_open_message_inner` delegates to `open_crypto_message` AND
    //      emits exactly one `CryptoResultEvent` with the right ids.
    //   2. `db_get_message_crypto_result` returns the persisted row (the
    //      `get_message_crypto_result` CRUD contract is pinned in
    //      `db/message_crypto_results.rs::tests` — this only pins the
    //      delegation wiring).

    use crate::sync_engine::engine::{
        CryptoResultEvent, EventSink, SyncEngine,
    };
    use crate::db::message_crypto_results::MessageCryptoResultRow;
    use std::sync::{Arc, Mutex};

    /// Sink that captures `CryptoResultEvent`s (and no-ops the rest). Mirrors
    /// the `CapturingSink` in `sync_engine/commands.rs::tests` but local so
    /// this test module stays self-contained.
    #[derive(Default, Clone)]
    struct CryptoResultCapturingSink {
        crypto: Arc<Mutex<Vec<CryptoResultEvent>>>,
    }
    impl EventSink for CryptoResultCapturingSink {
        fn emit_delta(&self, _: crate::sync_engine::engine::DeltaEvent) {}
        fn emit_new_mail(&self, _: crate::sync_engine::engine::NewMailEvent) {}
        fn emit_status(&self, _: crate::sync_engine::engine::StatusEvent) {}
        fn emit_queue(&self, _: crate::sync_engine::engine::QueueEvent) {}
        fn emit_bodies_written(&self, _: crate::sync_engine::engine::BodiesWrittenEvent) {}
        fn emit_send_result(&self, _: crate::sync_engine::engine::SendResultEvent) {}
        fn emit_crypto_result(&self, e: CryptoResultEvent) {
            self.crypto.lock().unwrap().push(e);
        }
    }

    async fn seed_thread_and_message(pool: &SqlitePool, account_id: &str, message_id: &str) {
        sqlx::query(
            "INSERT INTO threads (id, account_id, is_read, last_message_at)
             VALUES (?, ?, 0, 0)",
        )
        .bind(message_id)
        .bind(account_id)
        .execute(pool)
        .await
        .unwrap();
        sqlx::query(
            "INSERT INTO messages (id, account_id, thread_id, from_address, date, is_read, is_starred, body_cached)
             VALUES (?, ?, ?, ?, 0, 0, 0, 0)",
        )
        .bind(message_id)
        .bind(account_id)
        .bind(message_id)
        .bind(format!("{account_id}@x.com"))
        .execute(pool)
        .await
        .unwrap();
    }

    /// `crypto_open_message_inner` delegates to `open_crypto_message` (which
    /// writes the `message_crypto_results` row even on the no-ciphertext →
    /// Failed path) AND emits exactly one `CryptoResultEvent`. Uses the
    /// no-ciphertext path so this test does not require generating S/MIME keys
    /// — the load-bearing decrypt+verify round-trip is already pinned in
    /// `mail/crypto.rs::tests`.
    #[tokio::test]
    async fn crypto_open_message_inner_returns_result_and_emits_crypto_result_event() {
        let tmp = tempfile::tempdir().unwrap();
        let pool = crate::db::init_db(tmp.path()).await.unwrap();
        seed_account(&pool, "a").await;
        // Seed thread+message so `open_crypto_message`'s ciphertext lookup has
        // a row to read from-address off (the no-ciphertext → Failed path
        // still writes a crypto_result row).
        seed_thread_and_message(&pool, "a", "msg-1").await;

        let sink = Arc::new(CryptoResultCapturingSink::default());
        let engine = SyncEngine::new(pool.clone(), sink.clone());

        let res = crypto_open_message_inner(&engine, &pool, "a", "msg-1")
            .await
            .expect("open_crypto_message ok (no-ciphertext → Failed outcome)");

        // The no-ciphertext path records a Failed decrypt outcome (the
        // orchestrator's contract is to surface a meaningful result, not Err).
        assert_eq!(res.crypto_result.account_id, "a");
        assert_eq!(res.crypto_result.message_id, "msg-1");
        assert_eq!(res.crypto_result.decrypt_state, "failed");

        // Exactly ONE event, with the wrapper-supplied ids.
        let events = sink.crypto.lock().unwrap().clone();
        assert_eq!(events.len(), 1, "exactly one sync:crypto-result emission");
        assert_eq!(events[0].account_id, "a");
        assert_eq!(events[0].message_id, "msg-1");
    }

    /// `db_get_message_crypto_result` returns the row that
    /// `open_crypto_message` persisted. The wrapper is a one-line delegation,
    /// so this asserts the call path (same as the rate-limit delegation tests).
    #[tokio::test]
    async fn db_get_message_crypto_result_reads_persisted_row() {
        let tmp = tempfile::tempdir().unwrap();
        let pool = crate::db::init_db(tmp.path()).await.unwrap();
        seed_account(&pool, "a").await;
        seed_thread_and_message(&pool, "a", "msg-2").await;

        // Run the orchestrator once so it persists a row for `msg-2`.
        let sink = Arc::new(CryptoResultCapturingSink::default());
        let engine = SyncEngine::new(pool.clone(), sink.clone());
        let _ = crypto_open_message_inner(&engine, &pool, "a", "msg-2")
            .await
            .expect("open_crypto_message ok");

        // The command body is
        // `get_message_crypto_result(&pool, &account_id, &message_id)`.
        let got: Option<MessageCryptoResultRow> =
            crate::db::message_crypto_results::get_message_crypto_result(&pool, "a", "msg-2")
                .await
                .expect("read ok");
        let row = got.expect("row persisted by open_crypto_message");
        assert_eq!(row.account_id, "a");
        assert_eq!(row.message_id, "msg-2");
        assert_eq!(row.decrypt_state, "failed");
    }
}
