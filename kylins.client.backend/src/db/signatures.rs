//! Signatures domain query layer.
//!
//! Rust port of `kylins.client.frontend/src/services/db/signatures.ts`. Owns
//! the `signatures` table CRUD with per-account, per-context default scoping.
//!
//! The TS `DbSignature` interface returns the snake_case column names directly
//! (it is a "Db" shape, not a domain shape), so the [`Signature`] DTO uses
//! `#[serde(rename_all = "snake_case")]` to match byte-for-byte.

use serde::{Deserialize, Serialize};
use sqlx::{
    sqlite::SqliteRow,
    Row, SqlitePool,
};

/// Signature context (when the signature applies). Mirrors `SignatureContext`.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum SignatureContext {
    All,
    New,
    Reply,
    Forward,
}

impl Default for SignatureContext {
    fn default() -> Self {
        Self::All
    }
}

/// Signature row. Mirrors TS `DbSignature` exactly (snake_case JSON keys) so the
/// frontend swap is mechanical. `is_default` stays an i64 (0/1) to match the
/// historical TS interface.
#[derive(Debug, Clone, Serialize, Deserialize, Default, PartialEq)]
#[serde(rename_all = "snake_case")]
pub struct Signature {
    pub id: String,
    pub account_id: String,
    pub name: String,
    pub body_html: String,
    pub is_default: i64,
    pub sort_order: i64,
    pub context: SignatureContext,
}

fn row_to_signature(row: &SqliteRow) -> Signature {
    let ctx_str: String = row.try_get("context").unwrap_or_else(|_| "all".into());
    let context = match ctx_str.as_str() {
        "new" => SignatureContext::New,
        "reply" => SignatureContext::Reply,
        "forward" => SignatureContext::Forward,
        _ => SignatureContext::All,
    };
    Signature {
        id: row.try_get("id").unwrap_or_default(),
        account_id: row.try_get("account_id").unwrap_or_default(),
        name: row.try_get("name").unwrap_or_default(),
        body_html: row.try_get("body_html").unwrap_or_default(),
        is_default: row.try_get("is_default").unwrap_or(0),
        sort_order: row.try_get("sort_order").unwrap_or(0),
        context,
    }
}

/// Input for [`insert`]. Mirrors the inline TS input type (`signatures.ts:45-51`).
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InsertSignatureInput {
    pub account_id: String,
    pub name: String,
    pub body_html: String,
    pub is_default: bool,
    pub context: Option<SignatureContext>,
}

/// Update payload for [`update`]. Mirrors `signatures.ts:70-73` inline type.
#[derive(Debug, Clone, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct UpdateSignatureInput {
    pub name: Option<String>,
    pub body_html: Option<String>,
    pub is_default: Option<bool>,
    pub context: Option<SignatureContext>,
}

/// List all signatures for an account, ordered by sort_order then created_at.
pub async fn list_for_account(
    pool: &SqlitePool,
    account_id: &str,
) -> Result<Vec<Signature>, String> {
    let rows = sqlx::query(
        "SELECT * FROM signatures WHERE account_id = $1 ORDER BY sort_order, created_at",
    )
    .bind(account_id)
    .fetch_all(pool)
    .await
    .map_err(|e| e.to_string())?;
    Ok(rows.iter().map(row_to_signature).collect())
}

/// Get the default signature for an account + context, falling back to the
/// all-context default. Mirrors `getDefaultSignature` exactly, including the
/// CASE-based priority ordering.
pub async fn get_default(
    pool: &SqlitePool,
    account_id: &str,
    context: SignatureContext,
) -> Result<Option<Signature>, String> {
    let ctx_str = match context {
        SignatureContext::All => "all",
        SignatureContext::New => "new",
        SignatureContext::Reply => "reply",
        SignatureContext::Forward => "forward",
    };
    let row = sqlx::query(
        "SELECT * FROM signatures
         WHERE account_id = $1 AND is_default = 1
           AND (context = $2 OR context = 'all')
         ORDER BY CASE WHEN context = $2 THEN 0 ELSE 1 END
         LIMIT 1",
    )
    .bind(account_id)
    .bind(ctx_str)
    .fetch_optional(pool)
    .await
    .map_err(|e| e.to_string())?;
    Ok(row.as_ref().map(row_to_signature))
}

/// Insert a signature. If `is_default`, clears prior defaults for the same
/// (account, context) first. Returns the new id.
pub async fn insert(pool: &SqlitePool, input: InsertSignatureInput) -> Result<String, String> {
    let id = uuid::Uuid::new_v4().to_string();
    let context = input.context.unwrap_or_default();
    let ctx_str = match context {
        SignatureContext::All => "all",
        SignatureContext::New => "new",
        SignatureContext::Reply => "reply",
        SignatureContext::Forward => "forward",
    };

    if input.is_default {
        sqlx::query(
            "UPDATE signatures SET is_default = 0 WHERE account_id = $1 AND context = $2",
        )
        .bind(&input.account_id)
        .bind(ctx_str)
        .execute(pool)
        .await
        .map_err(|e| e.to_string())?;
    }

    sqlx::query(
        "INSERT INTO signatures (id, account_id, name, body_html, is_default, context) VALUES ($1, $2, $3, $4, $5, $6)",
    )
    .bind(&id)
    .bind(&input.account_id)
    .bind(&input.name)
    .bind(&input.body_html)
    .bind(if input.is_default { 1i64 } else { 0 })
    .bind(ctx_str)
    .execute(pool)
    .await
    .map_err(|e| e.to_string())?;

    Ok(id)
}

/// Update a signature. When promoting to default or changing context, clears the
/// prior default for the (account, effective-context) pair first. Mirrors
/// `updateSignature` exactly, including the SELECT-then-clear-default flow.
pub async fn update(
    pool: &SqlitePool,
    id: &str,
    updates: UpdateSignatureInput,
) -> Result<(), String> {
    // When flipping default on or changing context, scope the default-clear to
    // the *effective* context (existing or new).
    if matches!(updates.is_default, Some(true)) || updates.context.is_some() {
        let row: Option<(String, String)> =
            sqlx::query_as("SELECT account_id, context FROM signatures WHERE id = $1")
                .bind(id)
                .fetch_optional(pool)
                .await
                .map_err(|e| e.to_string())?;
        if let Some((account_id, existing_ctx)) = row {
            let effective_ctx = match updates.context {
                Some(SignatureContext::All) => "all",
                Some(SignatureContext::New) => "new",
                Some(SignatureContext::Reply) => "reply",
                Some(SignatureContext::Forward) => "forward",
                None => existing_ctx.as_str(),
            };
            sqlx::query(
                "UPDATE signatures SET is_default = 0 WHERE account_id = $1 AND context = $2",
            )
            .bind(&account_id)
            .bind(effective_ctx)
            .execute(pool)
            .await
            .map_err(|e| e.to_string())?;
        }
    }

    let mut sets: Vec<(&str, crate::db::BindValue)> = Vec::new();
    if let Some(ref name) = updates.name {
        sets.push(("name", crate::db::BindValue::Text(name.clone())));
    }
    if let Some(ref body) = updates.body_html {
        sets.push(("body_html", crate::db::BindValue::Text(body.clone())));
    }
    if let Some(is_default) = updates.is_default {
        sets.push((
            "is_default",
            crate::db::BindValue::Int(if is_default { 1 } else { 0 }),
        ));
    }
    if let Some(ref ctx) = updates.context {
        let ctx_str = match ctx {
            SignatureContext::All => "all",
            SignatureContext::New => "new",
            SignatureContext::Reply => "reply",
            SignatureContext::Forward => "forward",
        };
        sets.push(("context", crate::db::BindValue::Text(ctx_str.to_string())));
    }

    crate::db::exec_dynamic_update(pool, "signatures", "id", id, sets).await
}

/// Delete a signature by id.
pub async fn delete(pool: &SqlitePool, id: &str) -> Result<(), String> {
    sqlx::query("DELETE FROM signatures WHERE id = $1")
        .bind(id)
        .execute(pool)
        .await
        .map_err(|e| e.to_string())?;
    Ok(())
}
