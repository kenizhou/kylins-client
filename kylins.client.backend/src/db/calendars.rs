//! Calendar source list domain query layer.
//!
//! Owns the `calendars` table. Each account has one or more calendars
//! (local defaults today; CalDAV/Google/EAS sources later). Visibility and
//! primary flags drive the composite "visible calendars" view in the UI.

use serde::{Deserialize, Serialize};
use sqlx::{sqlite::SqliteRow, Row, SqlitePool};
use std::time::{SystemTime, UNIX_EPOCH};

/// Calendar row. Returned to the frontend with camelCase JSON keys.
#[derive(Debug, Clone, Serialize, Deserialize, Default, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Calendar {
    pub id: String,
    pub account_id: String,
    pub provider: String,
    pub remote_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub display_name: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub color: Option<String>,
    pub is_primary: bool,
    pub is_visible: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub sync_token: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ctag: Option<String>,
    pub created_at: i64,
    pub updated_at: i64,
}

/// Input for [`insert`]/[`update`]. `Option<Option<T>>` distinguishes "set to
/// NULL" from "not provided".
#[derive(Debug, Clone, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct UpsertCalendarInput {
    pub id: Option<String>,
    pub account_id: Option<String>,
    pub provider: Option<String>,
    pub remote_id: Option<String>,
    pub display_name: Option<Option<String>>,
    pub color: Option<Option<String>>,
    pub is_primary: Option<bool>,
    pub is_visible: Option<bool>,
    pub sync_token: Option<Option<String>>,
    pub ctag: Option<Option<String>>,
}

fn row_to_calendar(row: &SqliteRow) -> Calendar {
    Calendar {
        id: row.try_get("id").unwrap_or_default(),
        account_id: row.try_get("account_id").unwrap_or_default(),
        provider: row.try_get("provider").unwrap_or_else(|_| "local".into()),
        remote_id: row.try_get("remote_id").unwrap_or_default(),
        display_name: row.try_get("display_name").unwrap_or(None),
        color: row.try_get("color").unwrap_or(None),
        is_primary: row.try_get::<i64, _>("is_primary").unwrap_or(0) == 1,
        is_visible: row.try_get::<i64, _>("is_visible").unwrap_or(1) == 1,
        sync_token: row.try_get("sync_token").unwrap_or(None),
        ctag: row.try_get("ctag").unwrap_or(None),
        created_at: row.try_get("created_at").unwrap_or(0),
        updated_at: row.try_get("updated_at").unwrap_or(0),
    }
}

fn now_secs() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

/// Deterministic accent colors for local calendars. Picked in rotation so new
/// calendars are visually distinct without asking the user every time.
const DEFAULT_COLORS: &[&str] = &[
    "#ef4444", // red-500
    "#f97316", // orange-500
    "#eab308", // yellow-500
    "#22c55e", // green-500
    "#06b6d4", // cyan-500
    "#3b82f6", // blue-500
    "#8b5cf6", // violet-500
    "#ec4899", // pink-500
];

async fn pick_color_for_account(pool: &SqlitePool, account_id: &str) -> Result<String, String> {
    let count: i64 = sqlx::query_as::<_, (i64,)>("SELECT COUNT(*) FROM calendars WHERE account_id = $1")
        .bind(account_id)
        .fetch_one(pool)
        .await
        .map_err(|e| e.to_string())?
        .0;
    let idx = (count as usize) % DEFAULT_COLORS.len();
    Ok(DEFAULT_COLORS[idx].to_string())
}

// ---------------------------------------------------------------------------
// CRUD
// ---------------------------------------------------------------------------

/// List every calendar across all accounts.
pub async fn list_all(pool: &SqlitePool) -> Result<Vec<Calendar>, String> {
    let rows = sqlx::query("SELECT * FROM calendars ORDER BY account_id, created_at")
        .fetch_all(pool)
        .await
        .map_err(|e| e.to_string())?;
    Ok(rows.iter().map(row_to_calendar).collect())
}

/// List calendars for one account, primary first.
pub async fn list_for_account(pool: &SqlitePool, account_id: &str) -> Result<Vec<Calendar>, String> {
    let rows = sqlx::query(
        "SELECT * FROM calendars WHERE account_id = $1 ORDER BY is_primary DESC, created_at",
    )
    .bind(account_id)
    .fetch_all(pool)
    .await
    .map_err(|e| e.to_string())?;
    Ok(rows.iter().map(row_to_calendar).collect())
}

/// Get a single calendar by id.
pub async fn get_by_id(pool: &SqlitePool, id: &str) -> Result<Option<Calendar>, String> {
    let row = sqlx::query("SELECT * FROM calendars WHERE id = $1")
        .bind(id)
        .fetch_optional(pool)
        .await
        .map_err(|e| e.to_string())?;
    Ok(row.as_ref().map(row_to_calendar))
}

/// Return the id of the primary calendar for an account, if one exists.
pub async fn primary_for_account(pool: &SqlitePool, account_id: &str) -> Result<Option<String>, String> {
    let row = sqlx::query("SELECT id FROM calendars WHERE account_id = $1 AND is_primary = 1 LIMIT 1")
        .bind(account_id)
        .fetch_optional(pool)
        .await
        .map_err(|e| e.to_string())?;
    Ok(row.and_then(|r| r.try_get("id").ok()))
}

/// Insert a new calendar. Local calendars get a generated `remote_id` and a
/// rotated default color unless the caller supplies them.
pub async fn insert(pool: &SqlitePool, input: UpsertCalendarInput) -> Result<String, String> {
    let id = input.id.unwrap_or_else(|| uuid::Uuid::new_v4().to_string());
    let account_id = input
        .account_id
        .ok_or_else(|| "[calendars] accountId is required".to_string())?;

    let provider = input.provider.unwrap_or_else(|| "local".into());
    let remote_id = input
        .remote_id
        .unwrap_or_else(|| uuid::Uuid::new_v4().to_string());
    let color = match input.color {
        Some(Some(c)) => Some(c),
        Some(None) => None,
        None => Some(pick_color_for_account(pool, &account_id).await?),
    };
    let display_name = input.display_name.unwrap_or(None);
    let is_primary = input.is_primary.unwrap_or(false);
    let is_visible = input.is_visible.unwrap_or(true);
    let sync_token = input.sync_token.unwrap_or(None);
    let ctag = input.ctag.unwrap_or(None);
    let now = now_secs();

    sqlx::query(
        "INSERT INTO calendars
         (id, account_id, provider, remote_id, display_name, color, is_primary, is_visible,
          sync_token, ctag, created_at, updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)",
    )
    .bind(&id)
    .bind(&account_id)
    .bind(&provider)
    .bind(&remote_id)
    .bind(&display_name)
    .bind(&color)
    .bind(if is_primary { 1i64 } else { 0 })
    .bind(if is_visible { 1i64 } else { 0 })
    .bind(&sync_token)
    .bind(&ctag)
    .bind(now)
    .bind(now)
    .execute(pool)
    .await
    .map_err(|e| e.to_string())?;

    // If this calendar is primary, clear the flag on the account's other
    // calendars so there is never more than one primary per account.
    if is_primary {
        set_primary(pool, &id, &account_id).await?;
    }

    Ok(id)
}

/// Apply a partial update. Only present fields are written.
pub async fn update(
    pool: &SqlitePool,
    id: &str,
    updates: UpsertCalendarInput,
) -> Result<(), String> {
    let mut sets: Vec<(&str, crate::db::BindValue)> = Vec::new();

    if let Some(v) = updates.provider {
        sets.push(("provider", crate::db::BindValue::Text(v)));
    }
    if let Some(v) = updates.remote_id {
        sets.push(("remote_id", crate::db::BindValue::Text(v)));
    }
    if let Some(opt) = updates.display_name {
        sets.push((
            "display_name",
            opt.map(crate::db::BindValue::Text)
                .unwrap_or(crate::db::BindValue::Null),
        ));
    }
    if let Some(opt) = updates.color {
        sets.push((
            "color",
            opt.map(crate::db::BindValue::Text)
                .unwrap_or(crate::db::BindValue::Null),
        ));
    }
    if let Some(v) = updates.is_primary {
        sets.push(("is_primary", crate::db::BindValue::Int(if v { 1 } else { 0 })));
    }
    if let Some(v) = updates.is_visible {
        sets.push(("is_visible", crate::db::BindValue::Int(if v { 1 } else { 0 })));
    }
    if let Some(opt) = updates.sync_token {
        sets.push((
            "sync_token",
            opt.map(crate::db::BindValue::Text)
                .unwrap_or(crate::db::BindValue::Null),
        ));
    }
    if let Some(opt) = updates.ctag {
        sets.push((
            "ctag",
            opt.map(crate::db::BindValue::Text)
                .unwrap_or(crate::db::BindValue::Null),
        ));
    }

    if !sets.is_empty() {
        sets.push(("updated_at", crate::db::BindValue::Int(now_secs())));
    }

    crate::db::exec_dynamic_update(pool, "calendars", "id", id, sets).await?;

    // If the update promoted this calendar to primary, let set_primary enforce
    // the single-primary invariant using the actual account_id from the row.
    if updates.is_primary == Some(true) {
        set_primary(pool, id, "").await?;
    }

    Ok(())
}

/// Delete a calendar by id. Events referencing it are cascade-deleted by the
/// existing foreign key.
pub async fn delete(pool: &SqlitePool, id: &str) -> Result<(), String> {
    sqlx::query("DELETE FROM calendars WHERE id = $1")
        .bind(id)
        .execute(pool)
        .await
        .map_err(|e| e.to_string())?;
    Ok(())
}

/// Toggle a calendar's visibility flag.
pub async fn set_visible(pool: &SqlitePool, id: &str, visible: bool) -> Result<(), String> {
    sqlx::query(
        "UPDATE calendars SET is_visible = $1, updated_at = $2 WHERE id = $3",
    )
    .bind(if visible { 1i64 } else { 0 })
    .bind(now_secs())
    .bind(id)
    .execute(pool)
    .await
    .map_err(|e| e.to_string())?;
    Ok(())
}

/// Make the given calendar the account's primary calendar and demote all
/// others in the same account. The passed `account_id` is ignored; the real
/// account is read from the calendar row so callers cannot affect other
/// accounts.
pub async fn set_primary(pool: &SqlitePool, id: &str, _account_id: &str) -> Result<(), String> {
    let mut tx = pool.begin().await.map_err(|e| format!("begin tx: {e}"))?;
    let row = sqlx::query("SELECT account_id FROM calendars WHERE id = $1")
        .bind(id)
        .fetch_optional(&mut *tx)
        .await
        .map_err(|e| e.to_string())?;
    let account_id = match row {
        Some(r) => r.try_get::<String, _>("account_id").unwrap_or_default(),
        None => return Err(format!("calendar {id} not found")),
    };
    if account_id.is_empty() {
        return Err(format!("calendar {id} has no account"));
    }

    sqlx::query("UPDATE calendars SET is_primary = 0 WHERE account_id = $1")
        .bind(&account_id)
        .execute(&mut *tx)
        .await
        .map_err(|e| e.to_string())?;
    sqlx::query(
        "UPDATE calendars SET is_primary = 1, updated_at = $1 WHERE id = $2",
    )
    .bind(now_secs())
    .bind(id)
    .execute(&mut *tx)
    .await
    .map_err(|e| e.to_string())?;
    tx.commit().await.map_err(|e| e.to_string())?;
    Ok(())
}

/// Seed a primary local calendar for an account if it has none. Best-effort:
/// failures are logged but do not fail the caller (matches the signature
/// seeding pattern in `accounts::create`).
pub async fn seed_default_for_account(pool: &SqlitePool, account_id: &str) -> Result<(), String> {
    let count: i64 = sqlx::query_as::<_, (i64,)>("SELECT COUNT(*) FROM calendars WHERE account_id = $1")
        .bind(account_id)
        .fetch_one(pool)
        .await
        .map_err(|e| e.to_string())?
        .0;

    if count > 0 {
        return Ok(());
    }

    let id = uuid::Uuid::new_v4().to_string();
    // First calendar for the account: pick the first default color directly,
    // avoiding a redundant COUNT query inside pick_color_for_account.
    let color = DEFAULT_COLORS[0].to_string();

    sqlx::query(
        "INSERT INTO calendars
         (id, account_id, provider, remote_id, display_name, color, is_primary, is_visible,
          sync_token, ctag, created_at, updated_at)
         VALUES ($1,$2,'local','local_default','Calendar',$3,1,1,NULL,NULL,$4,$4)",
    )
    .bind(&id)
    .bind(account_id)
    .bind(&color)
    .bind(now_secs())
    .execute(pool)
    .await
    .map_err(|e| e.to_string())?;

    Ok(())
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::init_db;

    async fn seed_account(pool: &SqlitePool, id: &str) {
        sqlx::query(
            "INSERT INTO accounts (id, email, provider, is_active, is_default, sort_order, created_at, updated_at)
             VALUES ($1, $2, 'imap', 1, 0, 0, unixepoch(), unixepoch())",
        )
        .bind(id)
        .bind(format!("{id}@x.com"))
        .execute(pool)
        .await
        .unwrap();
    }

    #[tokio::test]
    async fn seed_default_creates_primary_calendar() {
        let tmp = tempfile::tempdir().unwrap();
        let pool = init_db(tmp.path()).await.unwrap();
        seed_account(&pool, "acc1").await;

        seed_default_for_account(&pool, "acc1").await.unwrap();
        let cals = list_for_account(&pool, "acc1").await.unwrap();
        assert_eq!(cals.len(), 1);
        assert_eq!(cals[0].display_name.as_deref(), Some("Calendar"));
        assert!(cals[0].is_primary);
        assert!(cals[0].is_visible);
        assert_eq!(cals[0].provider, "local");

        // Idempotent: second call is a no-op.
        seed_default_for_account(&pool, "acc1").await.unwrap();
        let cals = list_for_account(&pool, "acc1").await.unwrap();
        assert_eq!(cals.len(), 1);
    }

    #[tokio::test]
    async fn insert_picks_rotated_colors() {
        let tmp = tempfile::tempdir().unwrap();
        let pool = init_db(tmp.path()).await.unwrap();
        seed_account(&pool, "acc1").await;

        let mut colors = Vec::new();
        for _ in 0..DEFAULT_COLORS.len() + 1 {
            let id = insert(
                &pool,
                UpsertCalendarInput {
                    account_id: Some("acc1".into()),
                    display_name: Some(Some("Loop".into())),
                    ..Default::default()
                },
            )
            .await
            .unwrap();
            let cal = get_by_id(&pool, &id).await.unwrap().unwrap();
            colors.push(cal.color.unwrap());
        }
        assert_eq!(colors[0], colors[DEFAULT_COLORS.len()]);
        assert_ne!(colors[0], colors[1]);
    }

    #[tokio::test]
    async fn set_primary_demotes_others() {
        let tmp = tempfile::tempdir().unwrap();
        let pool = init_db(tmp.path()).await.unwrap();
        seed_account(&pool, "acc1").await;

        let a = insert(
            &pool,
            UpsertCalendarInput {
                account_id: Some("acc1".into()),
                is_primary: Some(true),
                ..Default::default()
            },
        )
        .await
        .unwrap();
        let b = insert(
            &pool,
            UpsertCalendarInput {
                account_id: Some("acc1".into()),
                ..Default::default()
            },
        )
        .await
        .unwrap();

        assert!(get_by_id(&pool, &a).await.unwrap().unwrap().is_primary);
        assert!(!get_by_id(&pool, &b).await.unwrap().unwrap().is_primary);

        set_primary(&pool, &b, "acc1").await.unwrap();
        assert!(!get_by_id(&pool, &a).await.unwrap().unwrap().is_primary);
        assert!(get_by_id(&pool, &b).await.unwrap().unwrap().is_primary);
    }

    #[tokio::test]
    async fn set_visible_and_delete() {
        let tmp = tempfile::tempdir().unwrap();
        let pool = init_db(tmp.path()).await.unwrap();
        seed_account(&pool, "acc1").await;

        let id = insert(
            &pool,
            UpsertCalendarInput {
                account_id: Some("acc1".into()),
                ..Default::default()
            },
        )
        .await
        .unwrap();

        set_visible(&pool, &id, false).await.unwrap();
        assert!(!get_by_id(&pool, &id).await.unwrap().unwrap().is_visible);

        delete(&pool, &id).await.unwrap();
        assert!(get_by_id(&pool, &id).await.unwrap().is_none());
    }

    #[tokio::test]
    async fn update_renames_and_promotes() {
        let tmp = tempfile::tempdir().unwrap();
        let pool = init_db(tmp.path()).await.unwrap();
        seed_account(&pool, "acc1").await;

        let a = insert(
            &pool,
            UpsertCalendarInput {
                account_id: Some("acc1".into()),
                is_primary: Some(true),
                ..Default::default()
            },
        )
        .await
        .unwrap();
        let b = insert(
            &pool,
            UpsertCalendarInput {
                account_id: Some("acc1".into()),
                ..Default::default()
            },
        )
        .await
        .unwrap();

        update(
            &pool,
            &b,
            UpsertCalendarInput {
                display_name: Some(Some("Work".into())),
                is_primary: Some(true),
                ..Default::default()
            },
        )
        .await
        .unwrap();

        let b_after = get_by_id(&pool, &b).await.unwrap().unwrap();
        assert_eq!(b_after.display_name.as_deref(), Some("Work"));
        assert!(b_after.is_primary);
        assert!(!get_by_id(&pool, &a).await.unwrap().unwrap().is_primary);
    }
}
