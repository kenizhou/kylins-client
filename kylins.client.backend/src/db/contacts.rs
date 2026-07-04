//! Contacts domain query layer.
//!
//! Rust port of `kylins.client.frontend/src/services/db/contacts.ts`. Owns the
//! `contacts`, `contact_groups`, and `contact_group_members` tables (rich local
//! contacts, groups, and future sync sources — CardDAV, Google People, EAS).
//!
//! Every DTO returned to the frontend derives `Serialize` with
//! `#[serde(rename_all = "camelCase")]` so the JSON field names match the
//! existing TypeScript `Contact` / `ContactGroup` interfaces exactly. The
//! frontend swap to `invoke('db_*')` is mechanical (same TS signatures).
//!
//! Email lookups are normalized via [`normalize_email`] (trim + lowercase) to
//! match the TS `normalizeEmail` helper. JSON-encoded array columns
//! (`emails_json`, `phone_numbers_json`, `addresses_json`) are passed through as
//! raw strings — the frontend parses them, same as before — except for
//! `createContact`/`updateContact` where the TS caller passes the array and we
//! re-serialize to JSON on the Rust side to match the historical behavior.

use serde::{Deserialize, Serialize};
use sqlx::{sqlite::SqliteRow, Row, SqlitePool};

use crate::db::settings;
use crate::mail::address::{is_unworthy_address, parse_address_header};
use crate::sync_engine::RemoteMessage;

/// Trim + lowercase an email address. Mirrors `normalizeEmail` in
/// `utils/emailUtils.ts`.
fn normalize_email(email: &str) -> String {
    email.trim().to_lowercase()
}

/// Current Unix timestamp in seconds. Mirrors `Math.floor(Date.now() / 1000)`.
fn now_secs() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

// ---------------------------------------------------------------------------
// Contact DTOs
// ---------------------------------------------------------------------------

/// Mirrors the TS `Contact` interface (`contacts.ts:57-80`). JSON keys are
/// camelCase to match byte-for-byte. Booleans are mapped from the 0/1 columns.
#[derive(Debug, Clone, Serialize, Deserialize, Default, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Contact {
    pub id: String,
    pub email: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub display_name: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub avatar_url: Option<String>,
    #[serde(default)]
    pub frequency: i64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_contacted_at: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub first_contacted_at: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub notes: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub account_id: Option<String>,
    #[serde(default)]
    pub source: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub external_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub etag: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub raw_vcard: Option<String>,
    pub is_hidden: bool,
    pub is_readonly: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub company: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub job_title: Option<String>,
    /// JSON-encoded array (raw string from DB). Frontend parses via parseJsonField.
    pub emails: serde_json::Value,
    /// JSON-encoded array (raw string from DB).
    pub phones: serde_json::Value,
    /// JSON-encoded array (raw string from DB).
    pub addresses: serde_json::Value,
    pub created_at: i64,
    pub updated_at: i64,
}

/// Input for [`create`]. Mirrors `CreateContactInput` (`contacts.ts:82-97`).
/// JSON-array fields are typed as `Option<serde_json::Value>` so the TS caller
/// passes arrays and they arrive as JSON; we serialize back to a JSON string
/// for the DB column (matching the historical `JSON.stringify(...)` behavior).
#[derive(Debug, Clone, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct CreateContactInput {
    pub email: String,
    pub display_name: Option<Option<String>>,
    pub account_id: Option<Option<String>>,
    pub source: Option<String>,
    pub external_id: Option<Option<String>>,
    pub etag: Option<Option<String>>,
    pub raw_vcard: Option<Option<String>>,
    pub avatar_url: Option<Option<String>>,
    pub company: Option<Option<String>>,
    pub job_title: Option<Option<String>>,
    pub emails: Option<serde_json::Value>,
    pub phones: Option<serde_json::Value>,
    pub addresses: Option<serde_json::Value>,
    pub notes: Option<Option<String>>,
}

/// Update payload for [`update`]. Mirrors `UpdateContactInput`
/// (`contacts.ts:99-110`). `Option<T>` = field present; inner `Option<Option<T>>`
/// distinguishes "set to NULL" from "not provided". Boolean fields use a plain
/// `Option<bool>` to match the TS `isHidden?: boolean` shape.
#[derive(Debug, Clone, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct UpdateContactInput {
    pub display_name: Option<Option<String>>,
    pub avatar_url: Option<Option<String>>,
    pub company: Option<Option<String>>,
    pub job_title: Option<Option<String>>,
    pub emails: Option<serde_json::Value>,
    pub phones: Option<serde_json::Value>,
    pub addresses: Option<serde_json::Value>,
    pub notes: Option<Option<String>>,
    pub is_hidden: Option<bool>,
    pub is_readonly: Option<bool>,
}

/// List options for [`list`]. Mirrors `ContactListOptions` (`contacts.ts:139-145`).
#[derive(Debug, Clone, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct ContactListOptions {
    pub account_id: Option<String>,
    pub source: Option<String>,
    pub limit: Option<i64>,
    pub offset: Option<i64>,
    pub include_hidden: Option<bool>,
}

fn row_to_contact(row: &SqliteRow) -> Contact {
    let emails_json: String = row.try_get("emails_json").unwrap_or_else(|_| "[]".into());
    let phones_json: String = row
        .try_get("phone_numbers_json")
        .unwrap_or_else(|_| "[]".into());
    let addresses_json: String = row
        .try_get("addresses_json")
        .unwrap_or_else(|_| "[]".into());
    let emails = serde_json::from_str(&emails_json).unwrap_or(serde_json::Value::Array(vec![]));
    let phones = serde_json::from_str(&phones_json).unwrap_or(serde_json::Value::Array(vec![]));
    let addresses =
        serde_json::from_str(&addresses_json).unwrap_or(serde_json::Value::Array(vec![]));
    Contact {
        id: row.try_get("id").unwrap_or_default(),
        email: row.try_get("email").unwrap_or_default(),
        display_name: row.try_get("display_name").unwrap_or(None),
        avatar_url: row.try_get("avatar_url").unwrap_or(None),
        frequency: row.try_get("frequency").unwrap_or(0),
        last_contacted_at: row.try_get("last_contacted_at").unwrap_or(None),
        first_contacted_at: row.try_get("first_contacted_at").unwrap_or(None),
        notes: row.try_get("notes").unwrap_or(None),
        account_id: row.try_get("account_id").unwrap_or(None),
        source: row.try_get("source").unwrap_or_else(|_| "local".into()),
        external_id: row.try_get("external_id").unwrap_or(None),
        etag: row.try_get("etag").unwrap_or(None),
        raw_vcard: row.try_get("raw_vcard").unwrap_or(None),
        is_hidden: row
            .try_get::<Option<i64>, _>("is_hidden")
            .unwrap_or(Some(0))
            .map(|v| v == 1)
            .unwrap_or(false),
        is_readonly: row
            .try_get::<Option<i64>, _>("is_readonly")
            .unwrap_or(Some(0))
            .map(|v| v == 1)
            .unwrap_or(false),
        company: row.try_get("company").unwrap_or(None),
        job_title: row.try_get("job_title").unwrap_or(None),
        emails,
        phones,
        addresses,
        created_at: row.try_get("created_at").unwrap_or(0),
        updated_at: row.try_get("updated_at").unwrap_or(0),
    }
}

/// Raw DB row shape for callers that only need email/name (autocomplete). The TS
/// `searchContacts` returns raw `DbContact[]` so this DTO keeps the snake_case
/// column names via `#[serde(rename_all = "snake_case")]` to match.
#[derive(Debug, Clone, Serialize, Deserialize, Default, PartialEq)]
#[serde(rename_all = "snake_case")]
pub struct DbContactRaw {
    pub id: String,
    pub email: String,
    pub display_name: Option<String>,
    pub avatar_url: Option<String>,
    pub frequency: i64,
    pub last_contacted_at: Option<i64>,
    pub first_contacted_at: Option<i64>,
    pub notes: Option<String>,
    pub account_id: Option<String>,
    pub source: String,
    pub external_id: Option<String>,
    pub etag: Option<String>,
    pub raw_vcard: Option<String>,
    pub is_hidden: i64,
    pub is_readonly: i64,
    pub company: Option<String>,
    pub job_title: Option<String>,
    pub emails_json: String,
    pub phone_numbers_json: String,
    pub addresses_json: String,
    pub created_at: i64,
    pub updated_at: i64,
}

fn row_to_db_contact_raw(row: &SqliteRow) -> DbContactRaw {
    DbContactRaw {
        id: row.try_get("id").unwrap_or_default(),
        email: row.try_get("email").unwrap_or_default(),
        display_name: row.try_get("display_name").unwrap_or(None),
        avatar_url: row.try_get("avatar_url").unwrap_or(None),
        frequency: row.try_get("frequency").unwrap_or(0),
        last_contacted_at: row.try_get("last_contacted_at").unwrap_or(None),
        first_contacted_at: row.try_get("first_contacted_at").unwrap_or(None),
        notes: row.try_get("notes").unwrap_or(None),
        account_id: row.try_get("account_id").unwrap_or(None),
        source: row.try_get("source").unwrap_or_else(|_| "local".into()),
        external_id: row.try_get("external_id").unwrap_or(None),
        etag: row.try_get("etag").unwrap_or(None),
        raw_vcard: row.try_get("raw_vcard").unwrap_or(None),
        is_hidden: row
            .try_get::<Option<i64>, _>("is_hidden")
            .unwrap_or(Some(0))
            .unwrap_or(0),
        is_readonly: row
            .try_get::<Option<i64>, _>("is_readonly")
            .unwrap_or(Some(0))
            .unwrap_or(0),
        company: row.try_get("company").unwrap_or(None),
        job_title: row.try_get("job_title").unwrap_or(None),
        emails_json: row.try_get("emails_json").unwrap_or_else(|_| "[]".into()),
        phone_numbers_json: row
            .try_get("phone_numbers_json")
            .unwrap_or_else(|_| "[]".into()),
        addresses_json: row
            .try_get("addresses_json")
            .unwrap_or_else(|_| "[]".into()),
        created_at: row.try_get("created_at").unwrap_or(0),
        updated_at: row.try_get("updated_at").unwrap_or(0),
    }
}

// ---------------------------------------------------------------------------
// Contact CRUD
// ---------------------------------------------------------------------------

/// List contacts with optional filters. Mirrors `getContacts`. Default limit
/// 500, offset 0, hidden excluded (matches TS defaults).
pub async fn list(pool: &SqlitePool, opts: ContactListOptions) -> Result<Vec<Contact>, String> {
    let mut where_binds: Vec<(&str, crate::db::BindValue)> = Vec::new();
    let mut extra_where: Vec<String> = Vec::new();

    if let Some(ref acct) = opts.account_id {
        where_binds.push(("account_id", crate::db::BindValue::Text(acct.clone())));
    }
    if let Some(ref src) = opts.source {
        where_binds.push(("source", crate::db::BindValue::Text(src.clone())));
    }
    if !opts.include_hidden.unwrap_or(false) {
        extra_where.push("(is_hidden = 0 OR is_hidden IS NULL)".to_string());
    }
    let limit = opts.limit.unwrap_or(500);
    let offset = opts.offset.unwrap_or(0);

    let rows = crate::db::exec_dynamic_select_filter(
        pool,
        "contacts",
        where_binds,
        extra_where,
        "frequency DESC, display_name ASC, email ASC",
        limit,
        offset,
    )
    .await?;
    Ok(rows.iter().map(row_to_contact).collect())
}

/// Search contacts by email or name prefix (autocomplete). Returns RAW DB rows
/// (matching the TS `searchContacts` return type).
pub async fn search(
    pool: &SqlitePool,
    query: &str,
    limit: i64,
) -> Result<Vec<DbContactRaw>, String> {
    let pattern = format!("%{}%", query);
    let rows = sqlx::query(
        "SELECT * FROM contacts
         WHERE (is_hidden = 0 OR is_hidden IS NULL)
           AND (email LIKE $1 OR display_name LIKE $1)
         ORDER BY frequency DESC, display_name ASC
         LIMIT $2",
    )
    .bind(&pattern)
    .bind(limit)
    .fetch_all(pool)
    .await
    .map_err(|e| e.to_string())?;
    Ok(rows.iter().map(row_to_db_contact_raw).collect())
}

/// Get a contact by id.
pub async fn get_by_id(pool: &SqlitePool, id: &str) -> Result<Option<Contact>, String> {
    let row = sqlx::query("SELECT * FROM contacts WHERE id = $1 LIMIT 1")
        .bind(id)
        .fetch_optional(pool)
        .await
        .map_err(|e| e.to_string())?;
    Ok(row.as_ref().map(row_to_contact))
}

/// Get a contact by email (normalized).
pub async fn get_by_email(pool: &SqlitePool, email: &str) -> Result<Option<Contact>, String> {
    let normalized = normalize_email(email);
    let row = sqlx::query("SELECT * FROM contacts WHERE email = $1 LIMIT 1")
        .bind(&normalized)
        .fetch_optional(pool)
        .await
        .map_err(|e| e.to_string())?;
    Ok(row.as_ref().map(row_to_contact))
}

/// Get a contact by (account_id, source, external_id).
pub async fn get_by_external_id(
    pool: &SqlitePool,
    account_id: &str,
    source: &str,
    external_id: &str,
) -> Result<Option<Contact>, String> {
    let row = sqlx::query(
        "SELECT * FROM contacts WHERE account_id = $1 AND source = $2 AND external_id = $3 LIMIT 1",
    )
    .bind(account_id)
    .bind(source)
    .bind(external_id)
    .fetch_optional(pool)
    .await
    .map_err(|e| e.to_string())?;
    Ok(row.as_ref().map(row_to_contact))
}

/// Create a contact. Returns the created row. Mirrors `createContact`.
pub async fn create(pool: &SqlitePool, input: CreateContactInput) -> Result<Contact, String> {
    let id = uuid::Uuid::new_v4().to_string();
    let now = now_secs();
    let normalized = normalize_email(&input.email);
    let display_name = input.display_name.unwrap_or(None);
    let account_id = input.account_id.unwrap_or(None);
    let source = input.source.unwrap_or_else(|| "local".into());
    let external_id = input.external_id.unwrap_or(None);
    let etag = input.etag.unwrap_or(None);
    let raw_vcard = input.raw_vcard.unwrap_or(None);
    let avatar_url = input.avatar_url.unwrap_or(None);
    let company = input.company.unwrap_or(None);
    let job_title = input.job_title.unwrap_or(None);
    let notes = input.notes.unwrap_or(None);
    let emails_json = input
        .emails
        .map(|v| serde_json::to_string(&v).unwrap_or_else(|_| "[]".into()))
        .unwrap_or_else(|| "[]".into());
    let phones_json = input
        .phones
        .map(|v| serde_json::to_string(&v).unwrap_or_else(|_| "[]".into()))
        .unwrap_or_else(|| "[]".into());
    let addresses_json = input
        .addresses
        .map(|v| serde_json::to_string(&v).unwrap_or_else(|_| "[]".into()))
        .unwrap_or_else(|| "[]".into());

    sqlx::query(
        "INSERT INTO contacts (
            id, email, display_name, account_id, source, external_id, etag, raw_vcard,
            avatar_url, company, job_title, emails_json, phone_numbers_json, addresses_json,
            notes, created_at, updated_at
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $16)",
    )
    .bind(&id)
    .bind(&normalized)
    .bind(&display_name)
    .bind(&account_id)
    .bind(&source)
    .bind(&external_id)
    .bind(&etag)
    .bind(&raw_vcard)
    .bind(&avatar_url)
    .bind(&company)
    .bind(&job_title)
    .bind(&emails_json)
    .bind(&phones_json)
    .bind(&addresses_json)
    .bind(&notes)
    .bind(now)
    .execute(pool)
    .await
    .map_err(|e| e.to_string())?;

    get_by_id(pool, &id)
        .await?
        .ok_or_else(|| format!("[contacts] failed to read created contact {id}"))
}

/// Dynamic update of a contact. Mirrors `updateContact`. Builds the SET clause
/// from the provided fields. No-op if no fields provided.
pub async fn update(
    pool: &SqlitePool,
    id: &str,
    updates: UpdateContactInput,
) -> Result<(), String> {
    let mut sets: Vec<(&str, crate::db::BindValue)> = Vec::new();

    if let Some(opt) = updates.display_name {
        sets.push((
            "display_name",
            match opt {
                Some(s) => crate::db::BindValue::Text(s),
                None => crate::db::BindValue::Null,
            },
        ));
    }
    if let Some(opt) = updates.avatar_url {
        sets.push((
            "avatar_url",
            match opt {
                Some(s) => crate::db::BindValue::Text(s),
                None => crate::db::BindValue::Null,
            },
        ));
    }
    if let Some(opt) = updates.company {
        sets.push((
            "company",
            match opt {
                Some(s) => crate::db::BindValue::Text(s),
                None => crate::db::BindValue::Null,
            },
        ));
    }
    if let Some(opt) = updates.job_title {
        sets.push((
            "job_title",
            match opt {
                Some(s) => crate::db::BindValue::Text(s),
                None => crate::db::BindValue::Null,
            },
        ));
    }
    if let Some(ref v) = updates.emails {
        let s = serde_json::to_string(v).unwrap_or_else(|_| "[]".into());
        sets.push(("emails_json", crate::db::BindValue::Text(s)));
    }
    if let Some(ref v) = updates.phones {
        let s = serde_json::to_string(v).unwrap_or_else(|_| "[]".into());
        sets.push(("phone_numbers_json", crate::db::BindValue::Text(s)));
    }
    if let Some(ref v) = updates.addresses {
        let s = serde_json::to_string(v).unwrap_or_else(|_| "[]".into());
        sets.push(("addresses_json", crate::db::BindValue::Text(s)));
    }
    if let Some(opt) = updates.notes {
        sets.push((
            "notes",
            match opt {
                Some(s) => crate::db::BindValue::Text(s),
                None => crate::db::BindValue::Null,
            },
        ));
    }
    if let Some(v) = updates.is_hidden {
        sets.push((
            "is_hidden",
            crate::db::BindValue::Int(if v { 1 } else { 0 }),
        ));
    }
    if let Some(v) = updates.is_readonly {
        sets.push((
            "is_readonly",
            crate::db::BindValue::Int(if v { 1 } else { 0 }),
        ));
    }

    crate::db::exec_dynamic_update(pool, "contacts", "id", id, sets).await
}

/// Delete a contact by id.
pub async fn delete(pool: &SqlitePool, id: &str) -> Result<(), String> {
    sqlx::query("DELETE FROM contacts WHERE id = $1")
        .bind(id)
        .execute(pool)
        .await
        .map_err(|e| e.to_string())?;
    Ok(())
}

/// Upsert a contact from mail interaction — bumps frequency if exists.
/// Mirrors `upsertContact` (ON CONFLICT(email) DO UPDATE).
///
/// Source precedence is respected: if the existing row has a higher-priority
/// source (`local` or any synced source), the mail-sourced `display_name` is
/// ignored and only `frequency` / `last_contacted_at` are bumped.
pub async fn upsert(
    pool: &SqlitePool,
    email: &str,
    display_name: Option<&str>,
) -> Result<(), String> {
    let id = uuid::Uuid::new_v4().to_string();
    let normalized = normalize_email(email);
    sqlx::query(
        "INSERT INTO contacts (id, email, display_name, source, first_contacted_at, last_contacted_at)
         VALUES ($1, $2, $3, 'mail', unixepoch(), unixepoch())
         ON CONFLICT(email) DO UPDATE SET
           display_name = CASE
             WHEN contacts.source = 'mail' THEN COALESCE($3, contacts.display_name)
             ELSE contacts.display_name
           END,
           frequency = contacts.frequency + 1,
           last_contacted_at = unixepoch(),
           updated_at = unixepoch()",
    )
    .bind(&id)
    .bind(&normalized)
    .bind(display_name)
    .execute(pool)
    .await
    .map_err(|e| e.to_string())?;
    Ok(())
}

/// Maximum number of visible recipients on a single message before we treat it
/// as bulk mail and skip contact extraction.
const MASS_MAIL_RECIPIENT_LIMIT: usize = 25;

/// Extract contacts from a `RemoteMessage` and upsert them.
///
/// - `folder_role` is the normalized role of the folder the message came from
///   (`inbox`, `sent`, `drafts`, `trash`, `junk`, `archive`, etc.).
/// - `own_emails` is the set of addresses that belong to the account itself
///   (primary account email + send-as aliases). They are never recorded.
pub async fn record_from_remote_msg(
    pool: &SqlitePool,
    account_id: &str,
    msg: &RemoteMessage,
    folder_role: Option<&str>,
    own_emails: &[String],
) -> Result<(), String> {
    let _ = account_id; // reserved for per-account contact attribution if needed later

    let role = folder_role.unwrap_or("");
    if matches!(role, "trash" | "junk" | "drafts") {
        return Ok(());
    }

    let is_sent = role == "sent";

    // Respect user preferences: extraction from Sent is on by default;
    // extraction from received folders is off by default.
    if is_sent {
        let enabled = settings::get_bool(pool, "auto_extract_contacts_from_mail")
            .await
            .unwrap_or(Some(true))
            .unwrap_or(true);
        if !enabled {
            return Ok(());
        }
    } else if matches!(role, "inbox" | "archive") {
        let enabled = settings::get_bool(pool, "auto_extract_contacts_from_received")
            .await
            .unwrap_or(Some(false))
            .unwrap_or(false);
        if !enabled {
            return Ok(());
        }
    }

    let own_set: std::collections::HashSet<&str> = own_emails.iter().map(|s| s.as_str()).collect();

    let mut candidates: Vec<(Option<String>, String)> = Vec::new();

    // From / Reply-To are collected from every non-excluded folder.
    if let Some(from) = msg.from_address.as_deref() {
        let name = msg.from_name.as_deref();
        candidates.push((name.map(|n| n.to_string()), from.to_string()));
    }
    if let Some(reply_to) = msg.reply_to.as_deref() {
        candidates.extend(parse_address_header(reply_to));
    }

    // To / Cc / Bcc are only collected from the Sent folder.
    if is_sent {
        if let Some(to) = msg.to_addresses.as_deref() {
            candidates.extend(parse_address_header(to));
        }
        if let Some(cc) = msg.cc_addresses.as_deref() {
            candidates.extend(parse_address_header(cc));
        }
        if let Some(bcc) = msg.bcc_addresses.as_deref() {
            candidates.extend(parse_address_header(bcc));
        }
    }

    // Mass-mail / newsletter guard: count visible recipients on sent messages.
    if is_sent {
        let visible_count =
            msg.to_addresses.as_ref().map(|s| parse_address_header(s).len()).unwrap_or(0)
                + msg.cc_addresses.as_ref().map(|s| parse_address_header(s).len()).unwrap_or(0)
                + msg.bcc_addresses.as_ref().map(|s| parse_address_header(s).len()).unwrap_or(0);
        if visible_count > MASS_MAIL_RECIPIENT_LIMIT {
            return Ok(());
        }
    }

    for (name, email) in candidates {
        let normalized = normalize_email(&email);
        if own_set.contains(normalized.as_str()) {
            continue;
        }
        if is_unworthy_address(&normalized, name.as_deref()) {
            continue;
        }
        upsert(pool, &normalized, name.as_deref()).await?;
    }

    Ok(())
}

/// Update avatar for a contact (by email). Mirrors `updateContactAvatar`.
pub async fn update_avatar(pool: &SqlitePool, email: &str, avatar_url: &str) -> Result<(), String> {
    let normalized = normalize_email(email);
    sqlx::query("UPDATE contacts SET avatar_url = $1, updated_at = unixepoch() WHERE email = $2")
        .bind(avatar_url)
        .bind(&normalized)
        .execute(pool)
        .await
        .map_err(|e| e.to_string())?;
    Ok(())
}

/// Update notes for a contact (by email). Mirrors `updateContactNotes`.
pub async fn update_notes(
    pool: &SqlitePool,
    email: &str,
    notes: Option<&str>,
) -> Result<(), String> {
    let normalized = normalize_email(email);
    sqlx::query("UPDATE contacts SET notes = $1, updated_at = unixepoch() WHERE email = $2")
        .bind(notes)
        .bind(&normalized)
        .execute(pool)
        .await
        .map_err(|e| e.to_string())?;
    Ok(())
}

// ---------------------------------------------------------------------------
// Contact stats / related-message queries
// ---------------------------------------------------------------------------

/// Aggregated stats for a contact. Mirrors TS `ContactStats`.
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct ContactStats {
    #[serde(rename = "emailCount")]
    pub email_count: i64,
    #[serde(rename = "firstEmail")]
    pub first_email: Option<i64>,
    #[serde(rename = "lastEmail")]
    pub last_email: Option<i64>,
}

/// Stats for a contact by email (counts messages from them). Mirrors `getContactStats`.
pub async fn get_stats(pool: &SqlitePool, email: &str) -> Result<ContactStats, String> {
    let normalized = normalize_email(email);
    let row: Option<(i64, Option<i64>, Option<i64>)> = sqlx::query_as(
        "SELECT COUNT(*) as cnt, MIN(date) as first_date, MAX(date) as last_date
         FROM messages WHERE from_address = $1",
    )
    .bind(&normalized)
    .fetch_optional(pool)
    .await
    .map_err(|e| e.to_string())?;
    Ok(row
        .map(|(cnt, first, last)| ContactStats {
            email_count: cnt,
            first_email: first,
            last_email: last,
        })
        .unwrap_or_default())
}

/// Row of `{ threadId, subject, lastMessageAt }`. Mirrors the TS return shape of
/// `getRecentThreadsWithContact` (note: TS used snake_case keys; preserve that).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub struct ContactThread {
    pub thread_id: String,
    pub subject: Option<String>,
    pub last_message_at: Option<i64>,
}

/// Recent threads with a contact (by email). Mirrors `getRecentThreadsWithContact`.
pub async fn recent_threads_with(
    pool: &SqlitePool,
    email: &str,
    limit: i64,
) -> Result<Vec<ContactThread>, String> {
    let normalized = normalize_email(email);
    let rows: Vec<(String, Option<String>, Option<i64>)> = sqlx::query_as(
        "SELECT DISTINCT t.id as thread_id, t.subject, t.last_message_at
         FROM threads t
         INNER JOIN messages m ON m.account_id = t.account_id AND m.thread_id = t.id
         WHERE m.from_address = $1
         ORDER BY t.last_message_at DESC
         LIMIT $2",
    )
    .bind(&normalized)
    .bind(limit)
    .fetch_all(pool)
    .await
    .map_err(|e| e.to_string())?;
    Ok(rows
        .into_iter()
        .map(|(thread_id, subject, last_message_at)| ContactThread {
            thread_id,
            subject,
            last_message_at,
        })
        .collect())
}

/// Attachment shared with a contact. Mirrors TS `ContactAttachment`.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ContactAttachment {
    pub filename: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub mime_type: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub size: Option<i64>,
    pub date: i64,
}

/// Attachments sent by / shared with a contact. Mirrors `getAttachmentsFromContact`.
pub async fn attachments_from(
    pool: &SqlitePool,
    email: &str,
    limit: i64,
) -> Result<Vec<ContactAttachment>, String> {
    let normalized = normalize_email(email);
    let rows: Vec<(String, Option<String>, Option<i64>, i64)> = sqlx::query_as(
        "SELECT a.filename, a.mime_type, a.size, m.date
         FROM attachments a
         INNER JOIN messages m ON m.account_id = a.account_id AND m.id = a.message_id
         WHERE m.from_address = $1 AND a.is_inline = 0 AND a.filename IS NOT NULL
         ORDER BY m.date DESC
         LIMIT $2",
    )
    .bind(&normalized)
    .bind(limit)
    .fetch_all(pool)
    .await
    .map_err(|e| e.to_string())?;
    Ok(rows
        .into_iter()
        .map(|(filename, mime_type, size, date)| ContactAttachment {
            filename,
            mime_type,
            size,
            date,
        })
        .collect())
}

/// Another contact at the same (non-public) domain. Mirrors `SameDomainContact`.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub struct SameDomainContact {
    pub email: String,
    pub display_name: Option<String>,
    pub avatar_url: Option<String>,
}

/// Well-known public mailbox providers; contacts from these domains are excluded
/// from the "same domain" suggestion. Mirrors `PUBLIC_DOMAINS` in the TS source.
const PUBLIC_DOMAINS: &[&str] = &[
    "gmail.com",
    "googlemail.com",
    "outlook.com",
    "hotmail.com",
    "live.com",
    "yahoo.com",
    "yahoo.co.uk",
    "aol.com",
    "icloud.com",
    "me.com",
    "mac.com",
    "protonmail.com",
    "proton.me",
    "mail.com",
    "zoho.com",
    "yandex.com",
    "gmx.com",
    "gmx.net",
];

/// Contacts sharing a non-public domain. Mirrors `getContactsFromSameDomain`.
/// Returns empty list for public domains.
pub async fn same_domain(
    pool: &SqlitePool,
    email: &str,
    limit: i64,
) -> Result<Vec<SameDomainContact>, String> {
    let normalized = normalize_email(email);
    let at_idx = match normalized.find('@') {
        Some(i) => i,
        None => return Ok(vec![]),
    };
    let domain = &normalized[at_idx + 1..];
    if PUBLIC_DOMAINS.contains(&domain) {
        return Ok(vec![]);
    }
    let pattern = format!("%@{}", domain);
    let rows: Vec<(String, Option<String>, Option<String>)> = sqlx::query_as(
        "SELECT email, display_name, avatar_url FROM contacts
         WHERE email LIKE $1 AND email != $2
         ORDER BY frequency DESC
         LIMIT $3",
    )
    .bind(&pattern)
    .bind(&normalized)
    .bind(limit)
    .fetch_all(pool)
    .await
    .map_err(|e| e.to_string())?;
    Ok(rows
        .into_iter()
        .map(|(email, display_name, avatar_url)| SameDomainContact {
            email,
            display_name,
            avatar_url,
        })
        .collect())
}

/// Latest auth result (SPF/DKIM/DMARC) for a sender. Mirrors `getLatestAuthResult`.
pub async fn latest_auth_result(pool: &SqlitePool, email: &str) -> Result<Option<String>, String> {
    let normalized = normalize_email(email);
    let row: Option<(Option<String>,)> = sqlx::query_as(
        "SELECT auth_results FROM messages
         WHERE from_address = $1 AND auth_results IS NOT NULL
         ORDER BY date DESC LIMIT 1",
    )
    .bind(&normalized)
    .fetch_optional(pool)
    .await
    .map_err(|e| e.to_string())?;
    Ok(row.and_then(|(v,)| v))
}

// ---------------------------------------------------------------------------
// Contact groups
// ---------------------------------------------------------------------------

/// Contact group DTO. Mirrors TS `ContactGroup`.
#[derive(Debug, Clone, Serialize, Deserialize, Default, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ContactGroup {
    pub id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub account_id: Option<String>,
    pub source: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub external_id: Option<String>,
    pub name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub etag: Option<String>,
    pub is_readonly: bool,
    pub created_at: i64,
    pub updated_at: i64,
}

fn row_to_group(row: &SqliteRow) -> ContactGroup {
    ContactGroup {
        id: row.try_get("id").unwrap_or_default(),
        account_id: row.try_get("account_id").unwrap_or(None),
        source: row.try_get("source").unwrap_or_else(|_| "local".into()),
        external_id: row.try_get("external_id").unwrap_or(None),
        name: row.try_get("name").unwrap_or_default(),
        etag: row.try_get("etag").unwrap_or(None),
        is_readonly: row
            .try_get::<Option<i64>, _>("is_readonly")
            .unwrap_or(Some(0))
            .map(|v| v == 1)
            .unwrap_or(false),
        created_at: row.try_get("created_at").unwrap_or(0),
        updated_at: row.try_get("updated_at").unwrap_or(0),
    }
}

/// List contact groups. With `account_id`, includes groups where
/// `account_id IS NULL OR = $1`. Mirrors `getContactGroups`.
pub async fn list_groups(
    pool: &SqlitePool,
    account_id: Option<&str>,
) -> Result<Vec<ContactGroup>, String> {
    let rows = if let Some(acct) = account_id {
        sqlx::query(
            "SELECT * FROM contact_groups WHERE account_id = $1 OR account_id IS NULL ORDER BY name ASC",
        )
        .bind(acct)
        .fetch_all(pool)
        .await
        .map_err(|e| e.to_string())?
    } else {
        sqlx::query("SELECT * FROM contact_groups ORDER BY name ASC")
            .fetch_all(pool)
            .await
            .map_err(|e| e.to_string())?
    };
    Ok(rows.iter().map(row_to_group).collect())
}

/// Get a group by id.
pub async fn get_group_by_id(pool: &SqlitePool, id: &str) -> Result<Option<ContactGroup>, String> {
    let row = sqlx::query("SELECT * FROM contact_groups WHERE id = $1 LIMIT 1")
        .bind(id)
        .fetch_optional(pool)
        .await
        .map_err(|e| e.to_string())?;
    Ok(row.as_ref().map(row_to_group))
}

/// Create a group. Mirrors `createContactGroup`.
pub async fn create_group(
    pool: &SqlitePool,
    name: &str,
    account_id: Option<&str>,
    source: &str,
) -> Result<ContactGroup, String> {
    let id = uuid::Uuid::new_v4().to_string();
    let now = now_secs();
    sqlx::query(
        "INSERT INTO contact_groups (id, account_id, source, name, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $5)",
    )
    .bind(&id)
    .bind(account_id)
    .bind(source)
    .bind(name)
    .bind(now)
    .execute(pool)
    .await
    .map_err(|e| e.to_string())?;
    get_group_by_id(pool, &id)
        .await?
        .ok_or_else(|| format!("[contacts] failed to read created group {id}"))
}

/// Rename a group.
pub async fn rename_group(pool: &SqlitePool, id: &str, name: &str) -> Result<(), String> {
    sqlx::query("UPDATE contact_groups SET name = $1, updated_at = unixepoch() WHERE id = $2")
        .bind(name)
        .bind(id)
        .execute(pool)
        .await
        .map_err(|e| e.to_string())?;
    Ok(())
}

/// Delete a group.
pub async fn delete_group(pool: &SqlitePool, id: &str) -> Result<(), String> {
    sqlx::query("DELETE FROM contact_groups WHERE id = $1")
        .bind(id)
        .execute(pool)
        .await
        .map_err(|e| e.to_string())?;
    Ok(())
}

/// Add a contact to a group (idempotent via INSERT OR IGNORE).
pub async fn add_to_group(
    pool: &SqlitePool,
    contact_id: &str,
    group_id: &str,
) -> Result<(), String> {
    sqlx::query(
        "INSERT OR IGNORE INTO contact_group_members (group_id, contact_id) VALUES ($1, $2)",
    )
    .bind(group_id)
    .bind(contact_id)
    .execute(pool)
    .await
    .map_err(|e| e.to_string())?;
    Ok(())
}

/// Remove a contact from a group.
pub async fn remove_from_group(
    pool: &SqlitePool,
    contact_id: &str,
    group_id: &str,
) -> Result<(), String> {
    sqlx::query("DELETE FROM contact_group_members WHERE group_id = $1 AND contact_id = $2")
        .bind(group_id)
        .bind(contact_id)
        .execute(pool)
        .await
        .map_err(|e| e.to_string())?;
    Ok(())
}

/// Get all contact ids in a group.
pub async fn contact_ids_for_group(
    pool: &SqlitePool,
    group_id: &str,
) -> Result<Vec<String>, String> {
    let rows: Vec<(String,)> =
        sqlx::query_as("SELECT contact_id FROM contact_group_members WHERE group_id = $1")
            .bind(group_id)
            .fetch_all(pool)
            .await
            .map_err(|e| e.to_string())?;
    Ok(rows.into_iter().map(|(c,)| c).collect())
}

/// Get all groups a contact belongs to.
pub async fn groups_for_contact(
    pool: &SqlitePool,
    contact_id: &str,
) -> Result<Vec<ContactGroup>, String> {
    let rows = sqlx::query(
        "SELECT g.* FROM contact_groups g
         INNER JOIN contact_group_members m ON m.group_id = g.id
         WHERE m.contact_id = $1
         ORDER BY g.name ASC",
    )
    .bind(contact_id)
    .fetch_all(pool)
    .await
    .map_err(|e| e.to_string())?;
    Ok(rows.iter().map(row_to_group).collect())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::init_db;
    use crate::sync_engine::RemoteMessage;

    #[tokio::test]
    async fn record_from_remote_msg_upserts_from_and_recipients() {
        let tmp = tempfile::tempdir().unwrap();
        let pool = init_db(tmp.path()).await.unwrap();
        settings::set_bool(&pool, "auto_extract_contacts_from_received", true)
            .await
            .unwrap();

        let msg = RemoteMessage {
            uid: 1,
            folder: "INBOX".into(),
            from_address: Some("alice@example.com".into()),
            from_name: Some("Alice".into()),
            to_addresses: Some("bob@example.com".into()),
            cc_addresses: Some("carol@example.com".into()),
            ..Default::default()
        };
        record_from_remote_msg(&pool, "acc-1", &msg, Some("inbox"), &[])
            .await
            .unwrap();

        let all = list(&pool, Default::default()).await.unwrap();
        let emails: Vec<String> = all.iter().map(|c| c.email.clone()).collect();
        assert!(emails.contains(&"alice@example.com".into()));
        assert!(!emails.contains(&"bob@example.com".into()));
        assert!(!emails.contains(&"carol@example.com".into()));
    }

    #[tokio::test]
    async fn record_from_remote_msg_sent_records_recipients() {
        let tmp = tempfile::tempdir().unwrap();
        let pool = init_db(tmp.path()).await.unwrap();

        let msg = RemoteMessage {
            uid: 2,
            folder: "Sent".into(),
            from_address: Some("alice@example.com".into()),
            from_name: Some("Alice".into()),
            to_addresses: Some("bob@example.com".into()),
            cc_addresses: Some("carol@example.com".into()),
            ..Default::default()
        };
        record_from_remote_msg(&pool, "acc-1", &msg, Some("sent"), &["alice@example.com".into()])
            .await
            .unwrap();

        let all = list(&pool, Default::default()).await.unwrap();
        let emails: Vec<String> = all.iter().map(|c| c.email.clone()).collect();
        assert!(emails.contains(&"bob@example.com".into()));
        assert!(emails.contains(&"carol@example.com".into()));
        assert!(!emails.contains(&"alice@example.com".into()));
    }

    #[tokio::test]
    async fn record_from_remote_msg_skips_trash_and_drafts() {
        let tmp = tempfile::tempdir().unwrap();
        let pool = init_db(tmp.path()).await.unwrap();

        for role in ["trash", "junk", "drafts"] {
            let msg = RemoteMessage {
                uid: 3,
                folder: role.into(),
                from_address: Some("sender@example.com".into()),
                ..Default::default()
            };
            record_from_remote_msg(&pool, "acc-1", &msg, Some(role), &[])
                .await
                .unwrap();
        }

        let all = list(&pool, Default::default()).await.unwrap();
        assert!(all.is_empty());
    }

    #[tokio::test]
    async fn record_from_remote_msg_skips_mass_mail() {
        let tmp = tempfile::tempdir().unwrap();
        let pool = init_db(tmp.path()).await.unwrap();

        let recipients: Vec<String> = (0..30).map(|i| format!("user{}@example.com", i)).collect();
        let msg = RemoteMessage {
            uid: 4,
            folder: "Sent".into(),
            to_addresses: Some(recipients.join(", ")),
            ..Default::default()
        };
        record_from_remote_msg(&pool, "acc-1", &msg, Some("sent"), &[])
            .await
            .unwrap();

        let all = list(&pool, Default::default()).await.unwrap();
        assert!(all.is_empty());
    }

    #[tokio::test]
    async fn upsert_bumps_frequency_for_existing_mail_contact() {
        let tmp = tempfile::tempdir().unwrap();
        let pool = init_db(tmp.path()).await.unwrap();

        upsert(&pool, "bob@example.com", Some("Bob")).await.unwrap();
        upsert(&pool, "bob@example.com", None).await.unwrap();

        let all = list(&pool, Default::default()).await.unwrap();
        assert_eq!(all.len(), 1);
        assert_eq!(all[0].frequency, 2);
    }
}
