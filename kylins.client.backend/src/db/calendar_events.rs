//! Calendar events domain query layer.
//!
//! Rust port of `kylins.client.frontend/src/services/db/calendarEvents.ts`. Owns
//! the `calendar_events` table CRUD. The table is Google-shaped but carries
//! `ical_data`/`uid`/`etag` so it can store any provider's VEVENT verbatim.
//!
//! The TS `DbCalendarEvent` interface surfaces snake_case column names; this
//! DTO matches byte-for-byte with `#[serde(rename_all = "snake_case")]`.

use serde::{Deserialize, Serialize};
use sqlx::{sqlite::SqliteRow, Row, SqlitePool};

/// Calendar event row. Mirrors TS `DbCalendarEvent` (snake_case JSON keys).
#[derive(Debug, Clone, Serialize, Deserialize, Default, PartialEq)]
#[serde(rename_all = "snake_case")]
pub struct CalendarEvent {
    pub id: String,
    pub account_id: String,
    pub google_event_id: Option<String>,
    pub calendar_id: Option<String>,
    pub remote_event_id: Option<String>,
    pub uid: Option<String>,
    pub summary: Option<String>,
    pub description: Option<String>,
    pub location: Option<String>,
    pub start_time: i64,
    pub end_time: i64,
    pub is_all_day: i64,
    pub status: Option<String>,
    pub organizer_email: Option<String>,
    pub attendees_json: Option<String>,
    pub ical_data: Option<String>,
    pub etag: Option<String>,
    pub recurrence_start: Option<i64>,
    pub recurrence_end: Option<i64>,
    pub updated_at: i64,
}

fn row_to_event(row: &SqliteRow) -> CalendarEvent {
    CalendarEvent {
        id: row.try_get("id").unwrap_or_default(),
        account_id: row.try_get("account_id").unwrap_or_default(),
        google_event_id: row.try_get("google_event_id").unwrap_or(None),
        calendar_id: row.try_get("calendar_id").unwrap_or(None),
        remote_event_id: row.try_get("remote_event_id").unwrap_or(None),
        uid: row.try_get("uid").unwrap_or(None),
        summary: row.try_get("summary").unwrap_or(None),
        description: row.try_get("description").unwrap_or(None),
        location: row.try_get("location").unwrap_or(None),
        start_time: row.try_get("start_time").unwrap_or(0),
        end_time: row.try_get("end_time").unwrap_or(0),
        is_all_day: row.try_get("is_all_day").unwrap_or(0),
        status: row.try_get("status").unwrap_or(None),
        organizer_email: row.try_get("organizer_email").unwrap_or(None),
        attendees_json: row.try_get("attendees_json").unwrap_or(None),
        ical_data: row.try_get("ical_data").unwrap_or(None),
        etag: row.try_get("etag").unwrap_or(None),
        recurrence_start: row.try_get("recurrence_start").unwrap_or(None),
        recurrence_end: row.try_get("recurrence_end").unwrap_or(None),
        updated_at: row.try_get("updated_at").unwrap_or(0),
    }
}

/// Input for [`insert`]/[`update`]. Mirrors TS `UpsertCalendarEventInput`.
/// Outer Option = "field present"; inner Option<Option<T>> = "set to NULL".
#[derive(Debug, Clone, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct UpsertCalendarEventInput {
    pub id: Option<String>,
    pub account_id: Option<String>,
    pub google_event_id: Option<Option<String>>,
    pub calendar_id: Option<Option<String>>,
    pub remote_event_id: Option<Option<String>>,
    pub uid: Option<Option<String>>,
    pub summary: Option<Option<String>>,
    pub description: Option<Option<String>>,
    pub location: Option<Option<String>>,
    pub start_time: Option<i64>,
    pub end_time: Option<i64>,
    pub is_all_day: Option<bool>,
    pub status: Option<Option<String>>,
    pub organizer_email: Option<Option<String>>,
    pub attendees_json: Option<Option<String>>,
    pub ical_data: Option<Option<String>>,
    pub etag: Option<Option<String>>,
    pub recurrence_start: Option<Option<i64>>,
    pub recurrence_end: Option<Option<i64>>,
}

/// List all events for an account.
pub async fn list_for_account(
    pool: &SqlitePool,
    account_id: &str,
) -> Result<Vec<CalendarEvent>, String> {
    let rows = sqlx::query("SELECT * FROM calendar_events WHERE account_id = $1")
        .bind(account_id)
        .fetch_all(pool)
        .await
        .map_err(|e| e.to_string())?;
    Ok(rows.iter().map(row_to_event).collect())
}

/// Events potentially visible in `[range_start, range_end]`. A row is included
/// if its single occurrence overlaps OR its recurrence window overlaps.
/// Mirrors `getCalendarEventsInRange` SQL verbatim.
pub async fn list_in_range(
    pool: &SqlitePool,
    account_id: &str,
    range_start: i64,
    range_end: i64,
) -> Result<Vec<CalendarEvent>, String> {
    let rows = sqlx::query(
        "SELECT * FROM calendar_events
         WHERE account_id = $1 AND (
           (start_time <= $3 AND end_time >= $2)
           OR (recurrence_start IS NOT NULL AND recurrence_end IS NOT NULL
               AND recurrence_start <= $3 AND recurrence_end >= $2)
         )
         ORDER BY start_time ASC",
    )
    .bind(account_id)
    .bind(range_start)
    .bind(range_end)
    .fetch_all(pool)
    .await
    .map_err(|e| e.to_string())?;
    Ok(rows.iter().map(row_to_event).collect())
}

/// Get an event by id.
pub async fn get_by_id(pool: &SqlitePool, id: &str) -> Result<Option<CalendarEvent>, String> {
    let row = sqlx::query("SELECT * FROM calendar_events WHERE id = $1")
        .bind(id)
        .fetch_optional(pool)
        .await
        .map_err(|e| e.to_string())?;
    Ok(row.as_ref().map(row_to_event))
}

/// Insert an event. Returns its id. Mirrors `insertCalendarEvent` including the
/// `google_event_id ?? uid ?? id` fallback for the NOT NULL Google-shaped column.
pub async fn insert(pool: &SqlitePool, input: UpsertCalendarEventInput) -> Result<String, String> {
    let id = input.id.unwrap_or_else(|| uuid::Uuid::new_v4().to_string());
    let account_id = input
        .account_id
        .ok_or_else(|| "[calendar] accountId is required".to_string())?;
    let uid = input.uid.unwrap_or(None);
    let google_event_id = input
        .google_event_id
        .unwrap_or(None)
        .or_else(|| uid.clone())
        .unwrap_or_else(|| id.clone());
    let start_time = input.start_time.unwrap_or(0);
    let end_time = input.end_time.unwrap_or(0);
    let is_all_day = input.is_all_day.unwrap_or(false);

    sqlx::query(
        "INSERT INTO calendar_events
         (id, account_id, google_event_id, calendar_id, remote_event_id, uid, summary,
          description, location, start_time, end_time, is_all_day, status, organizer_email,
          attendees_json, ical_data, etag, recurrence_start, recurrence_end)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19)",
    )
    .bind(&id)
    .bind(&account_id)
    .bind(&google_event_id)
    .bind(input.calendar_id.unwrap_or(None))
    .bind(input.remote_event_id.unwrap_or(None))
    .bind(&uid)
    .bind(input.summary.unwrap_or(None))
    .bind(input.description.unwrap_or(None))
    .bind(input.location.unwrap_or(None))
    .bind(start_time)
    .bind(end_time)
    .bind(if is_all_day { 1i64 } else { 0 })
    .bind(input.status.unwrap_or(None))
    .bind(input.organizer_email.unwrap_or(None))
    .bind(input.attendees_json.unwrap_or(None))
    .bind(input.ical_data.unwrap_or(None))
    .bind(input.etag.unwrap_or(None))
    .bind(input.recurrence_start.unwrap_or(None))
    .bind(input.recurrence_end.unwrap_or(None))
    .execute(pool)
    .await
    .map_err(|e| e.to_string())?;

    Ok(id)
}

/// Update mutable fields of an event. Mirrors `updateCalendarEvent`: only
/// columns whose field is present in `updates` are written. Iterates the same
/// candidate list as the TS `map` object.
pub async fn update(
    pool: &SqlitePool,
    id: &str,
    updates: UpsertCalendarEventInput,
) -> Result<(), String> {
    let mut sets: Vec<(&str, crate::db::BindValue)> = Vec::with_capacity(16);

    if let Some(opt) = updates.summary {
        sets.push((
            "summary",
            match opt {
                Some(s) => crate::db::BindValue::Text(s),
                None => crate::db::BindValue::Null,
            },
        ));
    }
    if let Some(opt) = updates.description {
        sets.push((
            "description",
            match opt {
                Some(s) => crate::db::BindValue::Text(s),
                None => crate::db::BindValue::Null,
            },
        ));
    }
    if let Some(opt) = updates.location {
        sets.push((
            "location",
            match opt {
                Some(s) => crate::db::BindValue::Text(s),
                None => crate::db::BindValue::Null,
            },
        ));
    }
    if let Some(v) = updates.start_time {
        sets.push(("start_time", crate::db::BindValue::Int(v)));
    }
    if let Some(v) = updates.end_time {
        sets.push(("end_time", crate::db::BindValue::Int(v)));
    }
    if let Some(v) = updates.is_all_day {
        sets.push((
            "is_all_day",
            crate::db::BindValue::Int(if v { 1 } else { 0 }),
        ));
    }
    if let Some(opt) = updates.status {
        sets.push((
            "status",
            match opt {
                Some(s) => crate::db::BindValue::Text(s),
                None => crate::db::BindValue::Null,
            },
        ));
    }
    if let Some(opt) = updates.organizer_email {
        sets.push((
            "organizer_email",
            match opt {
                Some(s) => crate::db::BindValue::Text(s),
                None => crate::db::BindValue::Null,
            },
        ));
    }
    if let Some(opt) = updates.attendees_json {
        sets.push((
            "attendees_json",
            match opt {
                Some(s) => crate::db::BindValue::Text(s),
                None => crate::db::BindValue::Null,
            },
        ));
    }
    if let Some(opt) = updates.ical_data {
        sets.push((
            "ical_data",
            match opt {
                Some(s) => crate::db::BindValue::Text(s),
                None => crate::db::BindValue::Null,
            },
        ));
    }
    if let Some(opt) = updates.etag {
        sets.push((
            "etag",
            match opt {
                Some(s) => crate::db::BindValue::Text(s),
                None => crate::db::BindValue::Null,
            },
        ));
    }
    if let Some(opt) = updates.recurrence_start {
        sets.push((
            "recurrence_start",
            match opt {
                Some(n) => crate::db::BindValue::Int(n),
                None => crate::db::BindValue::Null,
            },
        ));
    }
    if let Some(opt) = updates.recurrence_end {
        sets.push((
            "recurrence_end",
            match opt {
                Some(n) => crate::db::BindValue::Int(n),
                None => crate::db::BindValue::Null,
            },
        ));
    }
    if let Some(opt) = updates.calendar_id {
        sets.push((
            "calendar_id",
            match opt {
                Some(s) => crate::db::BindValue::Text(s),
                None => crate::db::BindValue::Null,
            },
        ));
    }
    if let Some(opt) = updates.remote_event_id {
        sets.push((
            "remote_event_id",
            match opt {
                Some(s) => crate::db::BindValue::Text(s),
                None => crate::db::BindValue::Null,
            },
        ));
    }
    if let Some(opt) = updates.uid {
        sets.push((
            "uid",
            match opt {
                Some(s) => crate::db::BindValue::Text(s),
                None => crate::db::BindValue::Null,
            },
        ));
    }
    // google_event_id is intentionally NOT in the TS update map — skip.

    crate::db::exec_dynamic_update(pool, "calendar_events", "id", id, sets).await
}

/// Delete an event by id.
pub async fn delete(pool: &SqlitePool, id: &str) -> Result<(), String> {
    sqlx::query("DELETE FROM calendar_events WHERE id = $1")
        .bind(id)
        .execute(pool)
        .await
        .map_err(|e| e.to_string())?;
    Ok(())
}
