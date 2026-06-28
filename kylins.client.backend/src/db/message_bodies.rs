//! Message bodies (separate store) query layer.
//!
//! Rust port of `kylins.client.frontend/src/services/db/messageBodies.ts`.
//! Bulky rendered HTML lives in the `message_bodies` table (migration v34 in
//! the legacy frontend, consolidated into the baseline here), fetched lazily
//! when a message is opened. `messages` keeps only `body_text` (for FTS + the
//! reading-pane text fallback). Bodies can be evicted to reclaim space and
//! re-fetched on demand via [`set_message_body`].
//!
//! The TS `MessageBody` interface (`messageBodies.ts:8-13`) is the source of
//! truth for the [`MessageBody`] DTO. JSON keys are camelCase so the Task 5
//! frontend cutover is a mechanical swap.

use serde::{Deserialize, Serialize};
use sqlx::{
    sqlite::SqliteRow,
    Row, SqlitePool,
};

/// Lazily-fetched HTML body for a message. Mirrors `MessageBody`
/// (`messageBodies.ts:8-13`).
#[derive(Debug, Clone, Serialize, Deserialize, Default, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct MessageBody {
    pub account_id: String,
    pub message_id: String,
    /// `None` means no row / NULL stored.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub body_html: Option<String>,
    /// Unix-seconds the body was last fetched. `None` when absent.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub fetched_at: Option<i64>,
}

/// Map a raw `message_bodies` row to a [`MessageBody`]. Caller supplies the
/// `(account_id, message_id)` key because the SELECT only fetches the two
/// payload columns (matches the TS query at `messageBodies.ts:20-23`).
fn row_to_message_body(
    row: &SqliteRow,
    account_id: String,
    message_id: String,
) -> MessageBody {
    MessageBody {
        account_id,
        message_id,
        body_html: row.try_get("body_html").ok().flatten(),
        fetched_at: row.try_get("fetched_at").ok(),
    }
}

/// Fetch the cached HTML body for a message, or `None` if not present.
/// Mirrors `getMessageBody` (`messageBodies.ts:15-26`).
pub async fn get_message_body(
    pool: &SqlitePool,
    account_id: &str,
    message_id: &str,
) -> Result<Option<MessageBody>, String> {
    let row = sqlx::query(
        "SELECT body_html, fetched_at FROM message_bodies \
         WHERE account_id = ? AND message_id = ?",
    )
    .bind(account_id)
    .bind(message_id)
    .fetch_optional(pool)
    .await
    .map_err(|e| e.to_string())?;
    Ok(row.as_ref().map(|r| {
        row_to_message_body(
            r,
            account_id.to_string(),
            message_id.to_string(),
        )
    }))
}

/// Store/refresh a body and mark the message as `body_cached = 1`, atomically
/// in one transaction. Mirrors `setMessageBody` (`messageBodies.ts:29-45`).
/// `fetched_at` is stamped with `unixepoch()` at write time (matches the TS).
pub async fn set_message_body(
    pool: &SqlitePool,
    account_id: &str,
    message_id: &str,
    body_html: &str,
) -> Result<(), String> {
    let mut tx = pool.begin().await.map_err(|e| format!("begin tx: {e}"))?;
    sqlx::query(
        "INSERT OR REPLACE INTO message_bodies (account_id, message_id, body_html, fetched_at)
         VALUES (?, ?, ?, unixepoch())",
    )
    .bind(account_id)
    .bind(message_id)
    .bind(body_html)
    .execute(&mut *tx)
    .await
    .map_err(|e| e.to_string())?;
    sqlx::query("UPDATE messages SET body_cached = 1 WHERE account_id = ? AND id = ?")
        .bind(account_id)
        .bind(message_id)
        .execute(&mut *tx)
        .await
        .map_err(|e| e.to_string())?;
    tx.commit().await.map_err(|e| e.to_string())?;
    Ok(())
}

/// Drop a body to reclaim space (re-fetched on next open) and clear the
/// message's `body_cached` flag, atomically. Mirrors `evictBody`
/// (`messageBodies.ts:48-59`).
pub async fn evict_body(
    pool: &SqlitePool,
    account_id: &str,
    message_id: &str,
) -> Result<(), String> {
    let mut tx = pool.begin().await.map_err(|e| format!("begin tx: {e}"))?;
    sqlx::query("DELETE FROM message_bodies WHERE account_id = ? AND message_id = ?")
        .bind(account_id)
        .bind(message_id)
        .execute(&mut *tx)
        .await
        .map_err(|e| e.to_string())?;
    sqlx::query("UPDATE messages SET body_cached = 0 WHERE account_id = ? AND id = ?")
        .bind(account_id)
        .bind(message_id)
        .execute(&mut *tx)
        .await
        .map_err(|e| e.to_string())?;
    tx.commit().await.map_err(|e| e.to_string())?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

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

    /// Plant a thread + message so `message_bodies` (FK to messages) can be
    /// populated. `body_cached` starts at 0.
    async fn seed_message(
        pool: &SqlitePool,
        account_id: &str,
        thread_id: &str,
        message_id: &str,
    ) {
        sqlx::query(
            "INSERT INTO threads (id, account_id, is_read, last_message_at)
             VALUES (?, ?, 0, 0)",
        )
        .bind(thread_id)
        .bind(account_id)
        .execute(pool)
        .await
        .unwrap();
        sqlx::query(
            "INSERT INTO messages (id, account_id, thread_id, date, is_read, is_starred, body_cached)
             VALUES (?, ?, ?, 0, 0, 0, 0)",
        )
        .bind(message_id)
        .bind(account_id)
        .bind(thread_id)
        .execute(pool)
        .await
        .unwrap();
    }

    #[tokio::test]
    async fn get_message_body_returns_none_when_absent() {
        let tmp = tempfile::tempdir().unwrap();
        let pool = crate::db::init_db(tmp.path()).await.unwrap();
        seed_account(&pool, "acct-1").await;
        seed_message(&pool, "acct-1", "t1", "m1").await;

        let got = get_message_body(&pool, "acct-1", "m1").await.unwrap();
        assert!(got.is_none());
    }

    #[tokio::test]
    async fn set_then_get_roundtrips_body_and_sets_cached_flag() {
        let tmp = tempfile::tempdir().unwrap();
        let pool = crate::db::init_db(tmp.path()).await.unwrap();
        seed_account(&pool, "acct-1").await;
        seed_message(&pool, "acct-1", "t1", "m1").await;

        set_message_body(&pool, "acct-1", "m1", "<p>hi</p>")
            .await
            .unwrap();

        let body = get_message_body(&pool, "acct-1", "m1")
            .await
            .unwrap()
            .unwrap();
        assert_eq!(body.account_id, "acct-1");
        assert_eq!(body.message_id, "m1");
        assert_eq!(body.body_html.as_deref(), Some("<p>hi</p>"));
        // fetched_at was stamped by the DB (unixepoch) — must be Some and recent-ish.
        let fetched = body.fetched_at.expect("fetched_at should be set");
        assert!(fetched > 0);

        // The messages.body_cached flag must be flipped to 1.
        let (cached,): (i64,) =
            sqlx::query_as("SELECT body_cached FROM messages WHERE account_id = ? AND id = ?")
                .bind("acct-1")
                .bind("m1")
                .fetch_one(&pool)
                .await
                .unwrap();
        assert_eq!(cached, 1);
    }

    #[tokio::test]
    async fn set_replaces_existing_body() {
        let tmp = tempfile::tempdir().unwrap();
        let pool = crate::db::init_db(tmp.path()).await.unwrap();
        seed_account(&pool, "acct-1").await;
        seed_message(&pool, "acct-1", "t1", "m1").await;

        set_message_body(&pool, "acct-1", "m1", "v1").await.unwrap();
        set_message_body(&pool, "acct-1", "m1", "v2-much-longer")
            .await
            .unwrap();

        let body = get_message_body(&pool, "acct-1", "m1")
            .await
            .unwrap()
            .unwrap();
        assert_eq!(body.body_html.as_deref(), Some("v2-much-longer"));

        // Only one row in message_bodies (INSERT OR REPLACE).
        let (cnt,): (i64,) =
            sqlx::query_as("SELECT COUNT(*) FROM message_bodies WHERE account_id = ? AND message_id = ?")
                .bind("acct-1")
                .bind("m1")
                .fetch_one(&pool)
                .await
                .unwrap();
        assert_eq!(cnt, 1);
    }

    #[tokio::test]
    async fn evict_removes_body_and_clears_cached_flag() {
        let tmp = tempfile::tempdir().unwrap();
        let pool = crate::db::init_db(tmp.path()).await.unwrap();
        seed_account(&pool, "acct-1").await;
        seed_message(&pool, "acct-1", "t1", "m1").await;
        set_message_body(&pool, "acct-1", "m1", "stash me").await.unwrap();

        evict_body(&pool, "acct-1", "m1").await.unwrap();

        // Body gone.
        assert!(get_message_body(&pool, "acct-1", "m1")
            .await
            .unwrap()
            .is_none());
        // Flag cleared.
        let (cached,): (i64,) =
            sqlx::query_as("SELECT body_cached FROM messages WHERE account_id = ? AND id = ?")
                .bind("acct-1")
                .bind("m1")
                .fetch_one(&pool)
                .await
                .unwrap();
        assert_eq!(cached, 0);
    }

    #[tokio::test]
    async fn evict_is_noop_when_body_absent() {
        // Evicting a message with no cached body must not error.
        let tmp = tempfile::tempdir().unwrap();
        let pool = crate::db::init_db(tmp.path()).await.unwrap();
        seed_account(&pool, "acct-1").await;
        seed_message(&pool, "acct-1", "t1", "m1").await;

        evict_body(&pool, "acct-1", "m1").await.unwrap();
        // body_cached was already 0.
        let (cached,): (i64,) =
            sqlx::query_as("SELECT body_cached FROM messages WHERE account_id = ? AND id = ?")
                .bind("acct-1")
                .bind("m1")
                .fetch_one(&pool)
                .await
                .unwrap();
        assert_eq!(cached, 0);
    }

    #[tokio::test]
    async fn get_isolates_by_account_and_message() {
        let tmp = tempfile::tempdir().unwrap();
        let pool = crate::db::init_db(tmp.path()).await.unwrap();
        seed_account(&pool, "a1").await;
        seed_account(&pool, "a2").await;
        seed_message(&pool, "a1", "t1", "m1").await;
        seed_message(&pool, "a2", "t1", "m1").await;

        set_message_body(&pool, "a1", "m1", "one").await.unwrap();
        set_message_body(&pool, "a2", "m1", "two").await.unwrap();

        assert_eq!(
            get_message_body(&pool, "a1", "m1")
                .await
                .unwrap()
                .unwrap()
                .body_html
                .as_deref(),
            Some("one")
        );
        assert_eq!(
            get_message_body(&pool, "a2", "m1")
                .await
                .unwrap()
                .unwrap()
                .body_html
                .as_deref(),
            Some("two")
        );
        // Wrong message_id → None.
        assert!(get_message_body(&pool, "a1", "nope")
            .await
            .unwrap()
            .is_none());
    }

    #[tokio::test]
    async fn message_body_dto_serializes_to_camel_case_json() {
        let b = MessageBody {
            account_id: "a1".into(),
            message_id: "m1".into(),
            body_html: Some("<p>x</p>".into()),
            fetched_at: Some(123),
        };
        let json = serde_json::to_value(&b).unwrap();
        let obj = json.as_object().unwrap();
        for key in ["accountId", "messageId", "bodyHtml", "fetchedAt"] {
            assert!(obj.contains_key(key), "expected camelCase key {key}");
        }
        for key in [
            "account_id",
            "message_id",
            "body_html",
            "fetched_at",
        ] {
            assert!(!obj.contains_key(key), "snake_case key {key} leaked");
        }

        // None optionals are skipped.
        let b2 = MessageBody {
            account_id: "a1".into(),
            message_id: "m1".into(),
            body_html: None,
            fetched_at: None,
        };
        let json2 = serde_json::to_value(&b2).unwrap();
        assert!(!json2.as_object().unwrap().contains_key("bodyHtml"));
        assert!(!json2.as_object().unwrap().contains_key("fetchedAt"));
    }
}
