//! Threads query layer (read paths + mark-read).
//!
//! Rust port of the read side of
//! `kylins.client.frontend/src/services/db/threads.ts`. Owns:
//! - [`get_threads`] — keyset-paginated thread list with an optional label
//!   filter and a latest-message LEFT JOIN that surfaces `from_name` /
//!   `from_address` for the list view without pulling message bodies.
//! - [`get_messages_for_thread`] — the metadata-only per-thread message list
//!   (oldest→newest) backing the reading pane / conversation view.
//! - [`mark_thread_read`] — atomic "mark every message + the thread row as
//!   read" in one transaction.
//!
//! The write side (`upsertImapMessages`) is deferred to a later task; this
//! module only reads.
//!
//! The TS `Thread` interface (`threads.ts:11-28`) is the source of truth for
//! the [`Thread`] DTO shape, and the keyset SQL at `threads.ts:115-129` is
//! reproduced here verbatim in spirit (cursor form, latest-message subquery,
//! optional `INNER JOIN thread_labels`, `ORDER BY last_message_at DESC, id
//! DESC`, `LIMIT`). Field names are camelCase in JSON (via
//! `#[serde(rename_all = "camelCase")]`) so the Task 5 frontend cutover is a
//! pure mechanical invoke-wrapper swap.
//!
//! The TS `DbMessageRow` (`threads.ts:138-160`) is the source of truth for the
//! message-row DTO returned by [`get_messages_for_thread`]. The frontend's
//! `mapMessageToMailMessage` reads these **snake_case** field names directly
//! (e.g. `msg.from_name`, `msg.message_id_header`), so this DTO intentionally
//! keeps `#[serde(rename_all = "snake_case")]` — do NOT switch it to camelCase.

use serde::{Deserialize, Serialize};
use sqlx::{
    sqlite::SqliteRow,
    Row, SqlitePool,
};

/// Canonical thread DTO surfaced to the list view.
///
/// Mirrors `threads.ts:11-28` (`Thread` interface). JSON keys are camelCase to
/// match the TS interface byte-for-byte; Rust field names stay snake_case.
/// Boolean columns (`is_read`, `is_starred`, ...) are stored 0/1 in SQLite and
/// mapped to `bool` on read (`== 1`).
#[derive(Debug, Clone, Serialize, Deserialize, Default, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Thread {
    pub id: String,
    pub account_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub subject: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub snippet: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_message_at: Option<i64>,
    pub message_count: i64,
    pub is_read: bool,
    pub is_starred: bool,
    pub is_important: bool,
    pub has_attachments: bool,
    pub is_snoozed: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub from_name: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub from_address: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub classification_id: Option<String>,
    pub is_encrypted: bool,
    pub is_signed: bool,
}

/// Keyset cursor pointing at the last row of the previous page. Mirrors the TS
/// `ThreadCursor` (`threads.ts:30-33`). Pagination is on
/// `(last_message_at DESC, id DESC)`, so the cursor carries both.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ThreadCursor {
    pub date: i64,
    pub id: String,
}

/// Options for [`get_threads`]. Mirrors `GetThreadsOptions`
/// (`threads.ts:35-41`). `rename_all = "camelCase"` so a TS caller passes
/// `{ labelId, limit, cursor }` and it deserializes cleanly.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GetThreadsOptions {
    /// Restrict to threads tagged with this label/folder id.
    #[serde(default)]
    pub label_id: Option<String>,
    /// Page size. Defaults to 50 (matching the TS `?? 50`).
    #[serde(default)]
    pub limit: Option<i64>,
    /// Cursor from a previous page's `next_cursor`. `None` means first page.
    #[serde(default)]
    pub cursor: Option<ThreadCursor>,
}

/// Result of [`get_threads`]: one page plus the cursor for the next page (or
/// `None` when the page was short).
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ThreadsPage {
    pub threads: Vec<Thread>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub next_cursor: Option<ThreadCursor>,
}

/// Per-thread message metadata row. Mirrors `DbMessageRow`
/// (`threads.ts:138-160`). Intentionally `snake_case` in JSON — the frontend's
/// `mapMessageToMailMessage` reads these fields by their snake_case names, and
/// Task 5 keeps that mapper untouched.
///
/// Optional columns are surfaced as `Option<T>` so callers see `None` for NULL.
/// `body_html` is deliberately absent (it lives in the separate `message_bodies`
/// table, fetched lazily — see [`crate::db::message_bodies`]).
#[derive(Debug, Clone, Serialize, Deserialize, Default, PartialEq)]
#[serde(rename_all = "snake_case")]
pub struct MessageRow {
    pub id: String,
    pub account_id: String,
    pub thread_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub from_address: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub from_name: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub to_addresses: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cc_addresses: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub bcc_addresses: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reply_to: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub subject: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub snippet: Option<String>,
    pub date: i64,
    pub is_read: bool,
    pub is_starred: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub body_text: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub body_cached: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub message_id_header: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub in_reply_to_header: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub classification_id: Option<String>,
    pub is_encrypted: bool,
    pub is_signed: bool,
    /// IMAP UID of the message in `imap_folder` (NULL when the message is not
    /// from an IMAP source, e.g. an EAS account). Surfaced so the frontend can
    /// pass it into `sync_apply_mutation` ops (markRead/move/delete) for remote
    /// replay — without it the replay worker cannot address the server message.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub imap_uid: Option<i64>,
    /// IMAP folder path the message lives in (e.g. "INBOX", "Sent"). Surfaced
    /// for the same reason as `imap_uid`: the `folderPath` field of mutation ops.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub imap_folder: Option<String>,
}

/// Map a raw `threads`-join-`messages` row to a [`Thread`]. Mirrors
/// `mapThread` (`threads.ts:62-81`): boolean columns via `=== 1`.
fn row_to_thread(row: &SqliteRow) -> Thread {
    Thread {
        id: row.try_get("id").unwrap_or_default(),
        account_id: row.try_get("account_id").unwrap_or_default(),
        subject: row.try_get("subject").ok().flatten(),
        snippet: row.try_get("snippet").ok().flatten(),
        last_message_at: row.try_get("last_message_at").ok().flatten(),
        message_count: row.try_get("message_count").unwrap_or(0),
        is_read: row.try_get::<i64, _>("is_read").unwrap_or(0) == 1,
        is_starred: row.try_get::<i64, _>("is_starred").unwrap_or(0) == 1,
        is_important: row.try_get::<i64, _>("is_important").unwrap_or(0) == 1,
        has_attachments: row.try_get::<i64, _>("has_attachments").unwrap_or(0) == 1,
        is_snoozed: row.try_get::<i64, _>("is_snoozed").unwrap_or(0) == 1,
        from_name: row.try_get("from_name").ok().flatten(),
        from_address: row.try_get("from_address").ok().flatten(),
        classification_id: row.try_get("classification_id").ok().flatten(),
        is_encrypted: row.try_get::<i64, _>("is_encrypted").unwrap_or(0) == 1,
        is_signed: row.try_get::<i64, _>("is_signed").unwrap_or(0) == 1,
    }
}

/// Map a raw `messages` row to a [`MessageRow`]. Booleans via `== 1`. `date`
/// is NOT NULL in the schema; the rest are surfaced as `Option<T>`.
fn row_to_message(row: &SqliteRow) -> MessageRow {
    MessageRow {
        id: row.try_get("id").unwrap_or_default(),
        account_id: row.try_get("account_id").unwrap_or_default(),
        thread_id: row.try_get("thread_id").unwrap_or_default(),
        from_address: row.try_get("from_address").ok().flatten(),
        from_name: row.try_get("from_name").ok().flatten(),
        to_addresses: row.try_get("to_addresses").ok().flatten(),
        cc_addresses: row.try_get("cc_addresses").ok().flatten(),
        bcc_addresses: row.try_get("bcc_addresses").ok().flatten(),
        reply_to: row.try_get("reply_to").ok().flatten(),
        subject: row.try_get("subject").ok().flatten(),
        snippet: row.try_get("snippet").ok().flatten(),
        date: row.try_get("date").unwrap_or(0),
        is_read: row.try_get::<i64, _>("is_read").unwrap_or(0) == 1,
        is_starred: row.try_get::<i64, _>("is_starred").unwrap_or(0) == 1,
        body_text: row.try_get("body_text").ok().flatten(),
        body_cached: row.try_get("body_cached").ok(),
        message_id_header: row.try_get("message_id_header").ok().flatten(),
        in_reply_to_header: row.try_get("in_reply_to_header").ok().flatten(),
        classification_id: row.try_get("classification_id").ok().flatten(),
        is_encrypted: row.try_get::<i64, _>("is_encrypted").unwrap_or(0) == 1,
        is_signed: row.try_get::<i64, _>("is_signed").unwrap_or(0) == 1,
        imap_uid: row.try_get("imap_uid").ok().flatten(),
        imap_folder: row.try_get("imap_folder").ok().flatten(),
    }
}

/// Load one page of threads for an account, optionally filtered to a label.
///
/// Reproduces the TS `getThreads` (`threads.ts:87-136`) keyset query:
/// - `WHERE t.account_id = ?` always.
/// - Optional `INNER JOIN thread_labels tl ON ...` when `label_id` is set.
/// - Optional cursor predicate
///   `(t.last_message_at < ? OR (t.last_message_at = ? AND t.id < ?))`.
/// - `LEFT JOIN messages m ON ... m.date = (SELECT MAX(m2.date) ...)` to pull
///   the latest message's `from_name` / `from_address`.
/// - `ORDER BY t.last_message_at DESC, t.id DESC`, `LIMIT ?`.
///
/// `next_cursor` is `Some` when `rows.len() == limit`, built from the last row.
pub async fn get_threads(
    pool: &SqlitePool,
    account_id: &str,
    opts: GetThreadsOptions,
) -> Result<ThreadsPage, String> {
    let limit = opts.limit.unwrap_or(50);

    // Dynamic SQL assembly mirrors the TS `joins` / `where` / `params` arrays.
    // SQLite binds positional `?` placeholders strictly in textual order, so we
    // collect (fragment, binds) pairs and append them in the order they'll
    // appear in the final SQL (JOIN before WHERE before LIMIT). This keeps the
    // bind list aligned with the placeholders no matter which options are set.
    //
    // The TS source uses numbered placeholders ($1, $2, ...) and can therefore
    // push `account_id` first even though its `?` lives in the WHERE clause
    // (textually after the JOIN); we cannot, so we structure around it.
    let mut join_sql = String::new();
    let mut join_binds: Vec<BindVal> = Vec::new();

    let mut where_sql = String::from("t.account_id = ?");
    let mut where_binds: Vec<BindVal> = vec![BindVal::Text(account_id.to_string())];

    if let Some(label_id) = &opts.label_id {
        // INNER JOIN appears textually before the LEFT JOIN messages and the
        // WHERE, so its bind is pushed onto the join list.
        join_sql.push_str(
            " INNER JOIN thread_labels tl ON tl.account_id = t.account_id \
             AND tl.thread_id = t.id AND tl.label_id = ?",
        );
        join_binds.push(BindVal::Text(label_id.clone()));
    }

    if let Some(cursor) = &opts.cursor {
        // Portable cursor form (no SQLite row-value syntax): strictly less than
        // the (date, id) tuple of the last row on the previous page.
        where_sql.push_str(
            " AND (t.last_message_at < ? OR (t.last_message_at = ? AND t.id < ?))",
        );
        where_binds.push(BindVal::Int(cursor.date));
        where_binds.push(BindVal::Int(cursor.date));
        where_binds.push(BindVal::Text(cursor.id.clone()));
    }

    let sql = format!(
        "SELECT t.id, t.account_id, t.subject, t.snippet, t.last_message_at, \
                t.message_count, t.is_read, t.is_starred, t.is_important, \
                t.has_attachments, t.is_snoozed, t.classification_id, \
                t.is_encrypted, t.is_signed, m.from_name, m.from_address
         FROM threads t
         {join_sql}
         LEFT JOIN messages m
           ON m.account_id = t.account_id AND m.thread_id = t.id
          AND m.date = (SELECT MAX(m2.date) FROM messages m2
                        WHERE m2.account_id = t.account_id AND m2.thread_id = t.id)
         WHERE {where_sql}
         ORDER BY t.last_message_at DESC, t.id DESC
         LIMIT ?",
    );

    // Concatenate binds in textual order: JOIN placeholders, then WHERE, then
    // the trailing LIMIT.
    let mut binds = join_binds;
    binds.append(&mut where_binds);
    binds.push(BindVal::Int(limit));

    let mut query = sqlx::query(&sql);
    for b in binds {
        query = match b {
            BindVal::Text(s) => query.bind(s),
            BindVal::Int(i) => query.bind(i),
        };
    }

    let rows = query.fetch_all(pool).await.map_err(|e| e.to_string())?;
    let threads: Vec<Thread> = rows.iter().map(row_to_thread).collect();

    // nextCursor = Some when the page was full; derived from the last row.
    let next_cursor = if threads.len() as i64 == limit {
        threads.last().map(|t| ThreadCursor {
            date: t.last_message_at.unwrap_or(0),
            id: t.id.clone(),
        })
    } else {
        None
    };

    Ok(ThreadsPage {
        threads,
        next_cursor,
    })
}

/// Load a thread's message metadata (no `body_html`), oldest→newest. Mirrors
/// `getMessagesForThread` (`threads.ts:163-172`).
pub async fn get_messages_for_thread(
    pool: &SqlitePool,
    account_id: &str,
    thread_id: &str,
) -> Result<Vec<MessageRow>, String> {
    let rows = sqlx::query(
        "SELECT * FROM messages WHERE account_id = ? AND thread_id = ? \
         ORDER BY date ASC",
    )
    .bind(account_id)
    .bind(thread_id)
    .fetch_all(pool)
    .await
    .map_err(|e| e.to_string())?;
    Ok(rows.iter().map(row_to_message).collect())
}

/// Mark every message in a thread (and the thread row) as read, atomically in
/// one transaction. Mirrors `markThreadRead` (`threads.ts:175-186`).
pub async fn mark_thread_read(
    pool: &SqlitePool,
    account_id: &str,
    thread_id: &str,
) -> Result<(), String> {
    let mut tx = pool.begin().await.map_err(|e| format!("begin tx: {e}"))?;
    sqlx::query("UPDATE threads SET is_read = 1 WHERE account_id = ? AND id = ?")
        .bind(account_id)
        .bind(thread_id)
        .execute(&mut *tx)
        .await
        .map_err(|e| e.to_string())?;
    sqlx::query("UPDATE messages SET is_read = 1 WHERE account_id = ? AND thread_id = ?")
        .bind(account_id)
        .bind(thread_id)
        .execute(&mut *tx)
        .await
        .map_err(|e| e.to_string())?;
    tx.commit().await.map_err(|e| e.to_string())?;
    Ok(())
}

/// Type-erased bind value for the dynamic [`get_threads`] SQL builder.
enum BindVal {
    Text(String),
    Int(i64),
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Insert a bare account row directly (no crypto), so thread tests have a
    /// parent account_id without depending on the keyring.
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

    /// Insert a thread row with the given flags + last_message_at.
    async fn seed_thread(
        pool: &SqlitePool,
        account_id: &str,
        thread_id: &str,
        last_message_at: i64,
        is_read: bool,
    ) {
        sqlx::query(
            "INSERT INTO threads (id, account_id, subject, snippet, last_message_at, message_count, is_read)
             VALUES (?, ?, ?, ?, ?, ?, ?)",
        )
        .bind(thread_id)
        .bind(account_id)
        .bind(format!("Subject {thread_id}"))
        .bind(format!("snippet {thread_id}"))
        .bind(last_message_at)
        .bind(1_i64)
        .bind(if is_read { 1 } else { 0 })
        .execute(pool)
        .await
        .unwrap();
    }

    /// Insert a message row (FK to threads). `from_name` / `from_address`
    /// drive the latest-message LEFT JOIN in `get_threads`.
    async fn seed_message(
        pool: &SqlitePool,
        account_id: &str,
        thread_id: &str,
        message_id: &str,
        date: i64,
        from_name: Option<&str>,
        from_address: Option<&str>,
    ) {
        sqlx::query(
            "INSERT INTO messages (id, account_id, thread_id, from_address, from_name, date, subject, is_read, is_starred)
             VALUES (?, ?, ?, ?, ?, ?, ?, 0, 0)",
        )
        .bind(message_id)
        .bind(account_id)
        .bind(thread_id)
        .bind(from_address)
        .bind(from_name)
        .bind(date)
        .bind(format!("Re: {thread_id}"))
        .execute(pool)
        .await
        .unwrap();
    }

    async fn seed_thread_label(
        pool: &SqlitePool,
        account_id: &str,
        thread_id: &str,
        label_id: &str,
    ) {
        sqlx::query(
            "INSERT INTO thread_labels (account_id, thread_id, label_id)
             VALUES (?, ?, ?)",
        )
        .bind(account_id)
        .bind(thread_id)
        .bind(label_id)
        .execute(pool)
        .await
        .unwrap();
    }

    #[tokio::test]
    async fn get_threads_returns_thread_with_latest_from_join() {
        let tmp = tempfile::tempdir().unwrap();
        let pool = crate::db::init_db(tmp.path()).await.unwrap();
        seed_account(&pool, "acct-1").await;
        seed_thread(&pool, "acct-1", "t1", 100, false).await;
        // Older message + newer message — the LEFT JOIN must pick the newer.
        seed_message(&pool, "acct-1", "t1", "m1-old", 90, Some("Old"), Some("old@x")).await;
        seed_message(
            &pool,
            "acct-1",
            "t1",
            "m2-new",
            100,
            Some("New Sender"),
            Some("new@x"),
        )
        .await;

        let page = get_threads(
            &pool,
            "acct-1",
            GetThreadsOptions {
                limit: Some(10),
                ..Default::default()
            },
        )
        .await
        .unwrap();
        assert_eq!(page.threads.len(), 1);
        let t = &page.threads[0];
        assert_eq!(t.id, "t1");
        assert_eq!(t.account_id, "acct-1");
        assert_eq!(t.last_message_at, Some(100));
        assert_eq!(t.from_name.as_deref(), Some("New Sender"));
        assert_eq!(t.from_address.as_deref(), Some("new@x"));
        assert!(!t.is_read);
        assert_eq!(t.message_count, 1);
        assert!(page.next_cursor.is_none(), "short page → no cursor");
    }

    #[tokio::test]
    async fn get_threads_label_filter_inner_joins_thread_labels() {
        let tmp = tempfile::tempdir().unwrap();
        let pool = crate::db::init_db(tmp.path()).await.unwrap();
        seed_account(&pool, "acct-1").await;
        seed_thread(&pool, "acct-1", "t1", 100, false).await;
        seed_thread(&pool, "acct-1", "t2", 90, false).await;
        seed_message(&pool, "acct-1", "t1", "m1", 100, None, None).await;
        seed_message(&pool, "acct-1", "t2", "m2", 90, None, None).await;
        // Only t1 is in the inbox label.
        seed_thread_label(&pool, "acct-1", "t1", "inbox").await;

        let page = get_threads(
            &pool,
            "acct-1",
            GetThreadsOptions {
                label_id: Some("inbox".into()),
                limit: Some(10),
                ..Default::default()
            },
        )
        .await
        .unwrap();
        let ids: Vec<&str> = page.threads.iter().map(|t| t.id.as_str()).collect();
        assert_eq!(ids, vec!["t1"]);
    }

    #[tokio::test]
    async fn get_threads_keyset_cursor_returns_next_page() {
        let tmp = tempfile::tempdir().unwrap();
        let pool = crate::db::init_db(tmp.path()).await.unwrap();
        seed_account(&pool, "acct-1").await;
        // Three threads with distinct (last_message_at, id); page size 2.
        seed_thread(&pool, "acct-1", "t1", 300, false).await;
        seed_thread(&pool, "acct-1", "t2", 200, false).await;
        seed_thread(&pool, "acct-1", "t3", 100, false).await;

        // Page 1 — should return t1, t2 (DESC order) and a next_cursor.
        let page1 = get_threads(
            &pool,
            "acct-1",
            GetThreadsOptions {
                limit: Some(2),
                ..Default::default()
            },
        )
        .await
        .unwrap();
        let ids1: Vec<&str> = page1.threads.iter().map(|t| t.id.as_str()).collect();
        assert_eq!(ids1, vec!["t1", "t2"]);
        let cursor = page1.next_cursor.expect("full page should yield cursor");
        assert_eq!(cursor.date, 200);
        assert_eq!(cursor.id, "t2");

        // Page 2 — using the cursor must skip t1/t2 and return only t3.
        let page2 = get_threads(
            &pool,
            "acct-1",
            GetThreadsOptions {
                limit: Some(2),
                cursor: Some(cursor),
                ..Default::default()
            },
        )
        .await
        .unwrap();
        let ids2: Vec<&str> = page2.threads.iter().map(|t| t.id.as_str()).collect();
        assert_eq!(ids2, vec!["t3"]);
        assert!(page2.next_cursor.is_none(), "short page → no cursor");
    }

    #[tokio::test]
    async fn get_threads_cursor_handles_tie_on_date_via_id() {
        // Two threads with the SAME last_message_at — the cursor's id
        // tiebreaker must distinguish them.
        let tmp = tempfile::tempdir().unwrap();
        let pool = crate::db::init_db(tmp.path()).await.unwrap();
        seed_account(&pool, "acct-1").await;
        seed_thread(&pool, "acct-1", "a", 100, false).await;
        seed_thread(&pool, "acct-1", "b", 100, false).await;

        // Cursor at (100, "b") → must return only "a" (id < "b").
        let page = get_threads(
            &pool,
            "acct-1",
            GetThreadsOptions {
                limit: Some(10),
                cursor: Some(ThreadCursor {
                    date: 100,
                    id: "b".into(),
                }),
                ..Default::default()
            },
        )
        .await
        .unwrap();
        let ids: Vec<&str> = page.threads.iter().map(|t| t.id.as_str()).collect();
        assert_eq!(ids, vec!["a"]);
    }

    #[tokio::test]
    async fn get_threads_default_limit_is_50() {
        // Plant 51 threads; default-limit page should be 50 with a cursor.
        let tmp = tempfile::tempdir().unwrap();
        let pool = crate::db::init_db(tmp.path()).await.unwrap();
        seed_account(&pool, "acct-1").await;
        for i in 0..51 {
            // Distinct (date, id) so the order is deterministic.
            let id = format!("t{:03}", i);
            seed_thread(&pool, "acct-1", &id, 1000 - i, false).await;
        }

        let page = get_threads(&pool, "acct-1", GetThreadsOptions::default())
            .await
            .unwrap();
        assert_eq!(page.threads.len(), 50, "default limit should be 50");
        assert!(page.next_cursor.is_some());
    }

    #[tokio::test]
    async fn get_threads_isolates_by_account() {
        let tmp = tempfile::tempdir().unwrap();
        let pool = crate::db::init_db(tmp.path()).await.unwrap();
        seed_account(&pool, "a1").await;
        seed_account(&pool, "a2").await;
        seed_thread(&pool, "a1", "t1", 100, false).await;
        seed_thread(&pool, "a2", "t2", 100, false).await;

        let page = get_threads(
            &pool,
            "a1",
            GetThreadsOptions {
                limit: Some(10),
                ..Default::default()
            },
        )
        .await
        .unwrap();
        assert_eq!(page.threads.len(), 1);
        assert_eq!(page.threads[0].account_id, "a1");
    }

    #[tokio::test]
    async fn get_threads_empty_when_account_has_no_threads() {
        let tmp = tempfile::tempdir().unwrap();
        let pool = crate::db::init_db(tmp.path()).await.unwrap();
        seed_account(&pool, "acct-1").await;
        let page = get_threads(
            &pool,
            "acct-1",
            GetThreadsOptions {
                limit: Some(10),
                ..Default::default()
            },
        )
        .await
        .unwrap();
        assert!(page.threads.is_empty());
        assert!(page.next_cursor.is_none());
    }

    #[tokio::test]
    async fn get_messages_for_thread_returns_oldest_first() {
        let tmp = tempfile::tempdir().unwrap();
        let pool = crate::db::init_db(tmp.path()).await.unwrap();
        seed_account(&pool, "acct-1").await;
        seed_thread(&pool, "acct-1", "t1", 100, false).await;
        // Insert out of order — query must return oldest→newest.
        seed_message(&pool, "acct-1", "t1", "new", 300, Some("B"), Some("b@x")).await;
        seed_message(&pool, "acct-1", "t1", "old", 100, Some("A"), Some("a@x")).await;
        seed_message(&pool, "acct-1", "t1", "mid", 200, Some("C"), Some("c@x")).await;

        let msgs = get_messages_for_thread(&pool, "acct-1", "t1")
            .await
            .unwrap();
        let ids: Vec<&str> = msgs.iter().map(|m| m.id.as_str()).collect();
        assert_eq!(ids, vec!["old", "mid", "new"]);
        // Snake_case fields surface the from_* values.
        assert_eq!(msgs[0].from_name.as_deref(), Some("A"));
        assert_eq!(msgs[0].from_address.as_deref(), Some("a@x"));
    }

    #[tokio::test]
    async fn get_messages_for_thread_isolates_account_and_thread() {
        let tmp = tempfile::tempdir().unwrap();
        let pool = crate::db::init_db(tmp.path()).await.unwrap();
        seed_account(&pool, "acct-1").await;
        seed_thread(&pool, "acct-1", "t1", 100, false).await;
        seed_thread(&pool, "acct-1", "t2", 100, false).await;
        seed_message(&pool, "acct-1", "t1", "m1", 100, None, None).await;
        seed_message(&pool, "acct-1", "t2", "m2", 100, None, None).await;

        let msgs = get_messages_for_thread(&pool, "acct-1", "t1")
            .await
            .unwrap();
        assert_eq!(msgs.len(), 1);
        assert_eq!(msgs[0].id, "m1");
    }

    #[tokio::test]
    async fn mark_thread_read_flips_thread_and_all_messages() {
        let tmp = tempfile::tempdir().unwrap();
        let pool = crate::db::init_db(tmp.path()).await.unwrap();
        seed_account(&pool, "acct-1").await;
        seed_thread(&pool, "acct-1", "t1", 100, false).await;
        seed_message(&pool, "acct-1", "t1", "m1", 90, None, None).await;
        seed_message(&pool, "acct-1", "t1", "m2", 100, None, None).await;
        // A second thread that must NOT be touched.
        seed_thread(&pool, "acct-1", "t2", 100, false).await;
        seed_message(&pool, "acct-1", "t2", "m3", 100, None, None).await;

        mark_thread_read(&pool, "acct-1", "t1").await.unwrap();

        // Thread row flipped.
        let (tr,): (i64,) =
            sqlx::query_as("SELECT is_read FROM threads WHERE account_id = ? AND id = ?")
                .bind("acct-1")
                .bind("t1")
                .fetch_one(&pool)
                .await
                .unwrap();
        assert_eq!(tr, 1);

        // All messages in t1 flipped...
        let (cnt_unread,): (i64,) = sqlx::query_as(
            "SELECT COUNT(*) FROM messages WHERE account_id = ? AND thread_id = ? AND is_read = 0",
        )
        .bind("acct-1")
        .bind("t1")
        .fetch_one(&pool)
        .await
        .unwrap();
        assert_eq!(cnt_unread, 0);

        // ...but t2's message is still unread.
        let (cnt_unread_t2,): (i64,) = sqlx::query_as(
            "SELECT COUNT(*) FROM messages WHERE account_id = ? AND thread_id = ? AND is_read = 0",
        )
        .bind("acct-1")
        .bind("t2")
        .fetch_one(&pool)
        .await
        .unwrap();
        assert_eq!(cnt_unread_t2, 1);
    }

    #[tokio::test]
    async fn mark_thread_read_is_noop_on_missing_thread() {
        // Must not error when the thread doesn't exist (UPDATE matches 0 rows).
        let tmp = tempfile::tempdir().unwrap();
        let pool = crate::db::init_db(tmp.path()).await.unwrap();
        seed_account(&pool, "acct-1").await;
        mark_thread_read(&pool, "acct-1", "nope").await.unwrap();
    }

    #[tokio::test]
    async fn thread_dto_serializes_to_camel_case_json() {
        let t = Thread {
            id: "t1".into(),
            account_id: "a1".into(),
            subject: Some("Sub".into()),
            snippet: Some("Snip".into()),
            last_message_at: Some(123),
            message_count: 2,
            is_read: true,
            is_starred: false,
            is_important: true,
            has_attachments: false,
            is_snoozed: false,
            from_name: Some("N".into()),
            from_address: Some("a@x".into()),
            classification_id: Some("c1".into()),
            is_encrypted: false,
            is_signed: true,
        };
        let json = serde_json::to_value(&t).unwrap();
        let obj = json.as_object().unwrap();
        // camelCase keys must be present.
        for key in [
            "id",
            "accountId",
            "subject",
            "snippet",
            "lastMessageAt",
            "messageCount",
            "isRead",
            "isStarred",
            "isImportant",
            "hasAttachments",
            "isSnoozed",
            "fromName",
            "fromAddress",
            "classificationId",
            "isEncrypted",
            "isSigned",
        ] {
            assert!(obj.contains_key(key), "expected camelCase key {key}");
        }
        // snake_case must NOT leak.
        for key in [
            "account_id",
            "last_message_at",
            "message_count",
            "is_read",
            "is_starred",
            "is_important",
            "has_attachments",
            "is_snoozed",
            "from_name",
            "from_address",
            "classification_id",
            "is_encrypted",
            "is_signed",
        ] {
            assert!(!obj.contains_key(key), "snake_case key {key} leaked");
        }
    }

    #[tokio::test]
    async fn message_row_dto_serializes_to_snake_case_json() {
        // The frontend's mapMessageToMailMessage reads these snake_case keys
        // directly — keep them snake_case on purpose.
        let m = MessageRow {
            id: "m1".into(),
            account_id: "a1".into(),
            thread_id: "t1".into(),
            from_address: Some("a@x".into()),
            from_name: Some("N".into()),
            to_addresses: Some("t@x".into()),
            cc_addresses: None,
            subject: Some("S".into()),
            snippet: Some("Sn".into()),
            date: 100,
            is_read: true,
            is_starred: false,
            body_text: Some("txt".into()),
            message_id_header: Some("<m@x>".into()),
            classification_id: None,
            is_encrypted: false,
            is_signed: true,
            imap_uid: Some(4242),
            imap_folder: Some("INBOX".into()),
            ..Default::default()
        };
        let json = serde_json::to_value(&m).unwrap();
        let obj = json.as_object().unwrap();
        // snake_case keys must be present (the frontend mapper reads them).
        for key in [
            "id",
            "account_id",
            "thread_id",
            "from_address",
            "from_name",
            "to_addresses",
            "subject",
            "snippet",
            "date",
            "is_read",
            "is_starred",
            "body_text",
            "message_id_header",
            "is_encrypted",
            "is_signed",
            "imap_uid",
            "imap_folder",
        ] {
            assert!(obj.contains_key(key), "expected snake_case key {key}");
        }
        assert_eq!(json["imap_uid"], 4242);
        assert_eq!(json["imap_folder"], "INBOX");
        // camelCase must NOT leak for the snake_case DTO.
        for key in [
            "accountId",
            "threadId",
            "fromAddress",
            "fromName",
            "messageIdHeader",
            "isRead",
            "isEncrypted",
        ] {
            assert!(!obj.contains_key(key), "camelCase key {key} leaked");
        }
    }

    #[tokio::test]
    async fn threads_page_serializes_to_threads_next_cursor_shape() {
        // Mirrors TS `{ threads, nextCursor }`.
        let page = ThreadsPage {
            threads: vec![Thread {
                id: "t1".into(),
                account_id: "a1".into(),
                last_message_at: Some(100),
                ..Default::default()
            }],
            next_cursor: Some(ThreadCursor {
                date: 100,
                id: "t1".into(),
            }),
        };
        let json = serde_json::to_value(&page).unwrap();
        let obj = json.as_object().unwrap();
        assert!(obj.contains_key("threads"));
        assert!(obj.contains_key("nextCursor"));
        let nc = obj.get("nextCursor").unwrap().as_object().unwrap();
        assert!(nc.contains_key("date"));
        assert!(nc.contains_key("id"));

        // nextCursor None → skipped (frontend treats absent as null).
        let page_no_cursor = ThreadsPage {
            threads: vec![],
            next_cursor: None,
        };
        let json2 = serde_json::to_value(&page_no_cursor).unwrap();
        assert!(!json2.as_object().unwrap().contains_key("nextCursor"));
    }

    #[tokio::test]
    async fn get_threads_options_deserializes_from_camel_case_json() {
        // A TS caller passes `{ labelId, limit, cursor }`. Must deserialize.
        let json = r#"{"labelId":"inbox","limit":25,"cursor":{"date":100,"id":"t1"}}"#;
        let opts: GetThreadsOptions = serde_json::from_str(json).unwrap();
        assert_eq!(opts.label_id.as_deref(), Some("inbox"));
        assert_eq!(opts.limit, Some(25));
        let cursor = opts.cursor.expect("cursor should be set");
        assert_eq!(cursor.date, 100);
        assert_eq!(cursor.id, "t1");
    }

    #[tokio::test]
    async fn get_threads_options_defaults_when_empty_object() {
        // `{}` must deserialize to all-None (first page, default limit applied
        // inside get_threads).
        let json = r#"{}"#;
        let opts: GetThreadsOptions = serde_json::from_str(json).unwrap();
        assert!(opts.label_id.is_none());
        assert!(opts.limit.is_none());
        assert!(opts.cursor.is_none());
    }
}
