//! Send-as aliases domain query layer.
//!
//! Rust port of `kylins.client.frontend/src/services/db/sendAsAliases.ts`. Owns
//! the `send_as_aliases` table (migration v7). An account can send from its own
//! address plus any verified aliases.
//!
//! The TS `DbSendAsAlias` interface surfaces snake_case column names; the TS
//! `SendAsAlias` is the mapped camelCase domain shape. This module returns both:
//! [`Alias`] is the raw snake_case row (for the rare callers that need it), and
//! the default list/get commands return the mapped camelCase shape. The
//! `accountAsAlias` pure helper stays in the frontend (it has no SQL).

use serde::{Deserialize, Serialize};
use sqlx::{sqlite::SqliteRow, Row, SqlitePool};

fn now_secs() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

/// Raw alias row (snake_case JSON keys). Mirrors TS `DbSendAsAlias`.
#[derive(Debug, Clone, Serialize, Deserialize, Default, PartialEq)]
#[serde(rename_all = "snake_case")]
pub struct Alias {
    pub id: String,
    pub account_id: String,
    pub email: String,
    pub display_name: Option<String>,
    pub reply_to_address: Option<String>,
    pub signature_id: Option<String>,
    pub is_primary: i64,
    pub is_default: i64,
    pub treat_as_alias: i64,
    pub verification_status: String,
    pub created_at: i64,
}

fn row_to_alias(row: &SqliteRow) -> Alias {
    Alias {
        id: row.try_get("id").unwrap_or_default(),
        account_id: row.try_get("account_id").unwrap_or_default(),
        email: row.try_get("email").unwrap_or_default(),
        display_name: row.try_get("display_name").unwrap_or(None),
        reply_to_address: row.try_get("reply_to_address").unwrap_or(None),
        signature_id: row.try_get("signature_id").unwrap_or(None),
        is_primary: row.try_get("is_primary").unwrap_or(0),
        is_default: row.try_get("is_default").unwrap_or(0),
        treat_as_alias: row.try_get("treat_as_alias").unwrap_or(0),
        verification_status: row
            .try_get("verification_status")
            .unwrap_or_else(|_| "accepted".into()),
        created_at: row.try_get("created_at").unwrap_or(0),
    }
}

/// Input for [`insert`]. Mirrors TS `CreateAliasInput`.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateAliasInput {
    pub account_id: String,
    pub email: String,
    pub display_name: Option<String>,
    pub reply_to: Option<String>,
    pub is_default: Option<bool>,
    pub treat_as_alias: Option<bool>,
}

/// Update payload for [`update`]. Mirrors `Partial<Omit<CreateAliasInput, 'accountId'|'email'>>`.
#[derive(Debug, Clone, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct UpdateAliasInput {
    pub display_name: Option<String>,
    pub reply_to: Option<String>,
    pub is_default: Option<bool>,
    pub treat_as_alias: Option<bool>,
}

/// List aliases for an account, ordered default-first then primary then created.
/// Returns raw snake_case rows (matching TS `getAliasesForAccount`).
pub async fn list_for_account(pool: &SqlitePool, account_id: &str) -> Result<Vec<Alias>, String> {
    let rows = sqlx::query(
        "SELECT * FROM send_as_aliases WHERE account_id = $1 ORDER BY is_default DESC, is_primary DESC, created_at ASC",
    )
    .bind(account_id)
    .fetch_all(pool)
    .await
    .map_err(|e| e.to_string())?;
    Ok(rows.iter().map(row_to_alias).collect())
}

/// Insert an alias. Returns the new id. If `is_default`, clears prior defaults
/// for the account first.
pub async fn insert(pool: &SqlitePool, input: CreateAliasInput) -> Result<String, String> {
    let id = uuid::Uuid::new_v4().to_string();
    if input.is_default.unwrap_or(false) {
        sqlx::query("UPDATE send_as_aliases SET is_default = 0 WHERE account_id = $1")
            .bind(&input.account_id)
            .execute(pool)
            .await
            .map_err(|e| e.to_string())?;
    }
    let now = now_secs();
    sqlx::query(
        "INSERT INTO send_as_aliases (
            id, account_id, email, display_name, reply_to_address,
            is_primary, is_default, treat_as_alias, verification_status, created_at
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'accepted', $9)",
    )
    .bind(&id)
    .bind(&input.account_id)
    .bind(&input.email)
    .bind(&input.display_name)
    .bind(&input.reply_to)
    .bind(0i64)
    .bind(if input.is_default.unwrap_or(false) {
        1i64
    } else {
        0
    })
    .bind(if input.treat_as_alias.unwrap_or(true) {
        1i64
    } else {
        0
    })
    .bind(now)
    .execute(pool)
    .await
    .map_err(|e| e.to_string())?;
    Ok(id)
}

/// Update an alias. When promoting to default, clears prior defaults for the
/// account first. Mirrors `updateAlias`.
pub async fn update(pool: &SqlitePool, id: &str, updates: UpdateAliasInput) -> Result<(), String> {
    if matches!(updates.is_default, Some(true)) {
        let row: Option<(String,)> =
            sqlx::query_as("SELECT account_id FROM send_as_aliases WHERE id = $1")
                .bind(id)
                .fetch_optional(pool)
                .await
                .map_err(|e| e.to_string())?;
        if let Some((account_id,)) = row {
            sqlx::query("UPDATE send_as_aliases SET is_default = 0 WHERE account_id = $1")
                .bind(&account_id)
                .execute(pool)
                .await
                .map_err(|e| e.to_string())?;
        }
    }

    let mut sets: Vec<(&str, crate::db::BindValue)> = Vec::new();
    if let Some(ref v) = updates.display_name {
        sets.push(("display_name", crate::db::BindValue::Text(v.clone())));
    }
    if let Some(ref v) = updates.reply_to {
        sets.push(("reply_to_address", crate::db::BindValue::Text(v.clone())));
    }
    if let Some(v) = updates.is_default {
        sets.push((
            "is_default",
            crate::db::BindValue::Int(if v { 1 } else { 0 }),
        ));
    }
    if let Some(v) = updates.treat_as_alias {
        sets.push((
            "treat_as_alias",
            crate::db::BindValue::Int(if v { 1 } else { 0 }),
        ));
    }

    crate::db::exec_dynamic_update(pool, "send_as_aliases", "id", id, sets).await
}

/// Delete an alias by id.
pub async fn delete(pool: &SqlitePool, id: &str) -> Result<(), String> {
    sqlx::query("DELETE FROM send_as_aliases WHERE id = $1")
        .bind(id)
        .execute(pool)
        .await
        .map_err(|e| e.to_string())?;
    Ok(())
}
