//! Full-text message search over `messages_fts` (external-content FTS5,
//! trigram tokenizer, migration v2). Read-only. Mirrors
//! `kylins.client.frontend/src/services/db/search.ts` exactly, including the
//! `snippet(messages_fts, 3, '<mark>', '</mark>', '…', 16)` column index.
//!
//! The SQL is reproduced verbatim (JOIN messages m ON m.rowid = messages_fts.rowid,
//! MATCH $1, account filter, ORDER BY rank, LIMIT $3) so results match the
//! historical TS behavior byte-for-byte.

use serde::{Deserialize, Serialize};
use sqlx::SqlitePool;

/// One search hit. Mirrors TS `MessageSearchResult` (camelCase JSON keys).
#[derive(Debug, Clone, Serialize, Deserialize, Default, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct MessageSearchResult {
    pub id: String,
    pub thread_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub subject: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub from_name: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub from_address: Option<String>,
    pub date: i64,
    /// Highlighted snippet with <mark>…</mark> around matching terms. Empty
    /// string if FTS returned NULL (matches the TS `?? ''`).
    pub preview: String,
    pub rank: f64,
}

/// Search an account's messages. Empty query returns no rows (matches TS guard).
pub async fn search_messages(
    pool: &SqlitePool,
    account_id: &str,
    query: &str,
    limit: i64,
) -> Result<Vec<MessageSearchResult>, String> {
    let trimmed = query.trim();
    if trimmed.is_empty() {
        return Ok(vec![]);
    }

    let rows: Vec<(
        String,
        String,
        Option<String>,
        Option<String>,
        Option<String>,
        i64,
        Option<String>,
        f64,
    )> = sqlx::query_as(
        "SELECT m.id AS id, m.thread_id AS thread_id, m.subject AS subject,
                m.from_name AS from_name, m.from_address AS from_address, m.date AS date,
                snippet(messages_fts, 3, '<mark>', '</mark>', '…', 16) AS preview,
                rank AS rank
         FROM messages_fts
         JOIN messages m ON m.rowid = messages_fts.rowid
         WHERE messages_fts MATCH $1 AND m.account_id = $2
         ORDER BY rank
         LIMIT $3",
    )
    .bind(trimmed)
    .bind(account_id)
    .bind(limit)
    .fetch_all(pool)
    .await
    .map_err(|e| e.to_string())?;

    Ok(rows
        .into_iter()
        .map(
            |(id, thread_id, subject, from_name, from_address, date, preview, rank)| {
                MessageSearchResult {
                    id,
                    thread_id,
                    subject,
                    from_name,
                    from_address,
                    date,
                    preview: preview.unwrap_or_default(),
                    rank,
                }
            },
        )
        .collect())
}
