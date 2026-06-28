//! AI cache domain query layer.
//!
//! Rust port of `kylins.client.frontend/src/services/ai/aiService.ts` (the
//! cache-read/write half). Owns the `ai_cache` table (keyed by
//! account+thread+type). The LLM provider invocation (`chat`/`summarize`)
//! stays in the frontend — Rust only owns the cache table.

use sqlx::SqlitePool;

/// Read a cached result. `account_id` is optional (matches the TS signature
/// where it is `string | undefined`, stored as NULL).
pub async fn get_cached(
    pool: &SqlitePool,
    account_id: Option<&str>,
    thread_id: &str,
    cache_type: &str,
) -> Result<Option<String>, String> {
    let row: Option<(String,)> = sqlx::query_as(
        "SELECT content FROM ai_cache WHERE account_id = $1 AND thread_id = $2 AND type = $3",
    )
    .bind(account_id)
    .bind(thread_id)
    .bind(cache_type)
    .fetch_optional(pool)
    .await
    .map_err(|e| e.to_string())?;
    Ok(row.map(|(c,)| c))
}

/// Insert or replace a cached result.
pub async fn cache(
    pool: &SqlitePool,
    account_id: Option<&str>,
    thread_id: &str,
    cache_type: &str,
    content: &str,
) -> Result<(), String> {
    sqlx::query(
        "INSERT OR REPLACE INTO ai_cache (account_id, thread_id, type, content)
         VALUES ($1, $2, $3, $4)",
    )
    .bind(account_id)
    .bind(thread_id)
    .bind(cache_type)
    .bind(content)
    .execute(pool)
    .await
    .map_err(|e| e.to_string())?;
    Ok(())
}
