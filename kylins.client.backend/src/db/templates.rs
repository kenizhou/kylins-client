//! Templates domain query layer.
//!
//! Rust port of `kylins.client.frontend/src/services/db/templates.ts`. Owns the
//! `templates` table CRUD.
//!
//! The TS `DbTemplate` surfaces snake_case column names; this DTO matches
//! byte-for-byte with `#[serde(rename_all = "snake_case")]`.

use serde::{Deserialize, Serialize};
use sqlx::{
    sqlite::SqliteRow,
    Row, SqlitePool,
};

/// Template row. Mirrors TS `DbTemplate`.
#[derive(Debug, Clone, Serialize, Deserialize, Default, PartialEq)]
#[serde(rename_all = "snake_case")]
pub struct Template {
    pub id: String,
    pub account_id: Option<String>,
    pub name: String,
    pub subject: Option<String>,
    pub body_html: String,
    pub shortcut: Option<String>,
    pub sort_order: i64,
    pub created_at: i64,
}

fn row_to_template(row: &SqliteRow) -> Template {
    Template {
        id: row.try_get("id").unwrap_or_default(),
        account_id: row.try_get("account_id").unwrap_or(None),
        name: row.try_get("name").unwrap_or_default(),
        subject: row.try_get("subject").unwrap_or(None),
        body_html: row.try_get("body_html").unwrap_or_default(),
        shortcut: row.try_get("shortcut").unwrap_or(None),
        sort_order: row.try_get("sort_order").unwrap_or(0),
        created_at: row.try_get("created_at").unwrap_or(0),
    }
}

/// List templates visible to an account (includes globals where account_id IS NULL).
pub async fn list_for_account(
    pool: &SqlitePool,
    account_id: &str,
) -> Result<Vec<Template>, String> {
    let rows = sqlx::query(
        "SELECT * FROM templates WHERE account_id = $1 OR account_id IS NULL ORDER BY sort_order, created_at",
    )
    .bind(account_id)
    .fetch_all(pool)
    .await
    .map_err(|e| e.to_string())?;
    Ok(rows.iter().map(row_to_template).collect())
}

/// Input for [`insert`]. Mirrors the inline TS type.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InsertTemplateInput {
    pub account_id: Option<String>,
    pub name: String,
    pub subject: Option<String>,
    pub body_html: String,
    pub shortcut: Option<String>,
}

/// Insert a template. Returns its id.
pub async fn insert(pool: &SqlitePool, tmpl: InsertTemplateInput) -> Result<String, String> {
    let id = uuid::Uuid::new_v4().to_string();
    sqlx::query(
        "INSERT INTO templates (id, account_id, name, subject, body_html, shortcut) VALUES ($1, $2, $3, $4, $5, $6)",
    )
    .bind(&id)
    .bind(&tmpl.account_id)
    .bind(&tmpl.name)
    .bind(&tmpl.subject)
    .bind(&tmpl.body_html)
    .bind(&tmpl.shortcut)
    .execute(pool)
    .await
    .map_err(|e| e.to_string())?;
    Ok(id)
}

/// Update payload for [`update`]. Mirrors the inline TS type.
#[derive(Debug, Clone, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct UpdateTemplateInput {
    pub name: Option<String>,
    pub subject: Option<Option<String>>,
    pub body_html: Option<String>,
    pub shortcut: Option<Option<String>>,
}

/// Update mutable fields of a template. No-op if no fields provided.
pub async fn update(
    pool: &SqlitePool,
    id: &str,
    updates: UpdateTemplateInput,
) -> Result<(), String> {
    let mut sets: Vec<(&str, crate::db::BindValue)> = Vec::new();

    if let Some(ref v) = updates.name {
        sets.push(("name", crate::db::BindValue::Text(v.clone())));
    }
    if let Some(ref opt) = updates.subject {
        sets.push((
            "subject",
            match opt {
                Some(s) => crate::db::BindValue::Text(s.clone()),
                None => crate::db::BindValue::Null,
            },
        ));
    }
    if let Some(ref v) = updates.body_html {
        sets.push(("body_html", crate::db::BindValue::Text(v.clone())));
    }
    if let Some(ref opt) = updates.shortcut {
        sets.push((
            "shortcut",
            match opt {
                Some(s) => crate::db::BindValue::Text(s.clone()),
                None => crate::db::BindValue::Null,
            },
        ));
    }

    crate::db::exec_dynamic_update(pool, "templates", "id", id, sets).await
}

/// Delete a template by id.
pub async fn delete(pool: &SqlitePool, id: &str) -> Result<(), String> {
    sqlx::query("DELETE FROM templates WHERE id = $1")
        .bind(id)
        .execute(pool)
        .await
        .map_err(|e| e.to_string())?;
    Ok(())
}
