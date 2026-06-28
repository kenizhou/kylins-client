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
