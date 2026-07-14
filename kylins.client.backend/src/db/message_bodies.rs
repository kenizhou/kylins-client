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
use sqlx::{sqlite::SqliteRow, Row, SqlitePool};

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
fn row_to_message_body(row: &SqliteRow, account_id: String, message_id: String) -> MessageBody {
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
    Ok(row
        .as_ref()
        .map(|r| row_to_message_body(r, account_id.to_string(), message_id.to_string())))
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

/// Bounded-cache eviction: if `message_bodies` exceeds `cap_rows`, delete the
/// oldest-`fetched_at` rows beyond the cap (LRU-by-rows) and clear their
/// `body_cached` flag. One transaction. Idempotent. The cap is a row count
/// (each body is ~10s of KB on average → 2000 rows ≈ a few hundred MB).
pub async fn maybe_evict(pool: &SqlitePool, cap_rows: i64) -> Result<u64, String> {
    let (cnt,): (i64,) = sqlx::query_as("SELECT COUNT(*) FROM message_bodies")
        .fetch_one(pool)
        .await
        .map_err(|e| e.to_string())?;
    if cnt <= cap_rows {
        return Ok(0);
    }
    let to_delete = cnt - cap_rows;
    let mut tx = pool.begin().await.map_err(|e| format!("begin tx: {e}"))?;
    // SQLite supports the `DELETE ... WHERE rowid IN (SELECT ... ORDER BY …
    // LIMIT n)` form; we delete the oldest-N message_ids first, then clear
    // their body_cached flag.
    let deleted_ids: Vec<String> = sqlx::query_scalar(
        "DELETE FROM message_bodies \
         WHERE rowid IN ( \
             SELECT rowid FROM message_bodies \
             ORDER BY fetched_at ASC \
             LIMIT ? \
         ) RETURNING message_id",
    )
    .bind(to_delete)
    .fetch_all(&mut *tx)
    .await
    .map_err(|e| e.to_string())?;
    let n = deleted_ids.len() as u64;
    // Clear body_cached for the evicted messages (so a future prefetch will
    // re-fetch them if they scroll back into view).
    for mid in &deleted_ids {
        // account_id is implicit in the message_id uniqueness, but the column
        // is on messages — we have only message_id here, so clear by id alone
        // (account_id is redundant for the WHERE because message ids are
        // globally unique: "imap-{account}-{folder}-{uid}").
        sqlx::query("UPDATE messages SET body_cached = 0 WHERE id = ?")
            .bind(mid)
            .execute(&mut *tx)
            .await
            .map_err(|e| e.to_string())?;
    }
    tx.commit().await.map_err(|e| e.to_string())?;
    log::info!("[db] message_bodies evicted {n} row(s) (was {cnt}, cap {cap_rows})");
    Ok(n)
}

/// Persist the raw CMS payload (`smime.p7m` / opaque `p7s` body) for an
/// encrypted or opaque-signed message. Plaintext is NEVER written via this
/// path — only the opaque CMS blob exactly as received. The row must already
/// exist (created by [`set_message_body`]); this UPDATE only fills the
/// ciphertext column. Idempotent: re-writing overwrites the prior blob.
pub async fn set_message_ciphertext(
    pool: &SqlitePool,
    account_id: &str,
    message_id: &str,
    ciphertext: &[u8],
) -> Result<(), String> {
    sqlx::query(
        "UPDATE message_bodies SET body_mime_ciphertext = ? \
         WHERE account_id = ? AND message_id = ?",
    )
    .bind(ciphertext)
    .bind(account_id)
    .bind(message_id)
    .execute(pool)
    .await
    .map_err(|e| e.to_string())?;
    Ok(())
}

/// Read the cached raw CMS payload, if any. Returns `Ok(None)` when the row
/// exists but the column is NULL (a plain text/html message) or when no row
/// exists at all — both mean "no ciphertext to process".
pub async fn get_message_ciphertext(
    pool: &SqlitePool,
    account_id: &str,
    message_id: &str,
) -> Result<Option<Vec<u8>>, String> {
    let row: Option<(Option<Vec<u8>>,)> = sqlx::query_as(
        "SELECT body_mime_ciphertext FROM message_bodies \
         WHERE account_id = ? AND message_id = ?",
    )
    .bind(account_id)
    .bind(message_id)
    .fetch_optional(pool)
    .await
    .map_err(|e| e.to_string())?;
    Ok(row.and_then(|(b,)| b))
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
    async fn seed_message(pool: &SqlitePool, account_id: &str, thread_id: &str, message_id: &str) {
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
        let (cnt,): (i64,) = sqlx::query_as(
            "SELECT COUNT(*) FROM message_bodies WHERE account_id = ? AND message_id = ?",
        )
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
        set_message_body(&pool, "acct-1", "m1", "stash me")
            .await
            .unwrap();

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
    async fn maybe_evict_deletes_oldest_rows_beyond_cap_and_clears_cached_flag() {
        let tmp = tempfile::tempdir().unwrap();
        let pool = crate::db::init_db(tmp.path()).await.unwrap();
        seed_account(&pool, "a").await;
        // Seed 3 messages with bodies fetched at increasing fetched_at.
        for i in 1..=3 {
            let mid = format!("m{i}");
            seed_message(&pool, "a", &format!("t{i}"), &mid).await;
            set_message_body(&pool, "a", &mid, &format!("body{i}"))
                .await
                .unwrap();
            // Force distinct fetched_at so the eviction order is deterministic.
            sqlx::query("UPDATE message_bodies SET fetched_at = ? WHERE message_id = ?")
                .bind(i as i64) // m1 oldest, m3 newest
                .bind(&mid)
                .execute(&pool)
                .await
                .unwrap();
        }

        // Cap at 2 rows → m1 (oldest) evicted; m2 + m3 stay.
        let evicted = maybe_evict(&pool, 2).await.unwrap();
        assert_eq!(evicted, 1);

        let (cnt,): (i64,) = sqlx::query_as("SELECT COUNT(*) FROM message_bodies")
            .fetch_one(&pool)
            .await
            .unwrap();
        assert_eq!(cnt, 2);
        let (cached_m1,): (i64,) =
            sqlx::query_as("SELECT body_cached FROM messages WHERE id = 'm1'")
                .fetch_one(&pool)
                .await
                .unwrap();
        assert_eq!(
            cached_m1, 0,
            "evicted message's body_cached flag must be cleared"
        );
        // m2 + m3 still cached.
        for keep in ["m2", "m3"] {
            let (c,): (i64,) =
                sqlx::query_as("SELECT body_cached FROM messages WHERE id = ?")
                    .bind(keep)
                    .fetch_one(&pool)
                    .await
                    .unwrap();
            assert_eq!(c, 1);
        }
    }

    #[tokio::test]
    async fn maybe_evict_noop_when_under_cap() {
        let tmp = tempfile::tempdir().unwrap();
        let pool = crate::db::init_db(tmp.path()).await.unwrap();
        seed_account(&pool, "a").await;
        seed_message(&pool, "a", "t1", "m1").await;
        set_message_body(&pool, "a", "m1", "x").await.unwrap();
        let evicted = maybe_evict(&pool, 100).await.unwrap();
        assert_eq!(evicted, 0);
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
        for key in ["account_id", "message_id", "body_html", "fetched_at"] {
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

    /// Round-trip the raw CMS ciphertext column added in Plan 1 (G1). Proves the
    /// ALTER TABLE migration landed and the helper pair writes + reads back the
    /// exact bytes. The column stores the opaque `application/pkcs7-mime` /
    /// multipart-signed blob; plaintext is NEVER written via this path.
    #[tokio::test]
    async fn set_and_get_message_ciphertext_round_trips() {
        let tmp = tempfile::tempdir().unwrap();
        let pool = crate::db::init_db(tmp.path()).await.unwrap();
        seed_account(&pool, "acct").await;
        seed_message(&pool, "acct", "t1", "msg-1").await;
        // message_bodies row must exist for the UPDATE to hit a row.
        set_message_body(&pool, "acct", "msg-1", "<p>x</p>")
            .await
            .unwrap();

        let blob = b"application/pkcs7-mime raw bytes here";
        set_message_ciphertext(&pool, "acct", "msg-1", blob)
            .await
            .unwrap();

        let got = get_message_ciphertext(&pool, "acct", "msg-1")
            .await
            .unwrap()
            .expect("row present");
        assert_eq!(got, blob);
    }

    /// A message with no cached ciphertext must return `Ok(None)` (not error),
    /// so the decrypt pipeline can treat absence as "no work to do".
    #[tokio::test]
    async fn get_message_ciphertext_returns_none_when_absent() {
        let tmp = tempfile::tempdir().unwrap();
        let pool = crate::db::init_db(tmp.path()).await.unwrap();
        seed_account(&pool, "acct").await;
        seed_message(&pool, "acct", "t1", "msg-2").await;
        set_message_body(&pool, "acct", "msg-2", "<p>x</p>")
            .await
            .unwrap();

        assert!(get_message_ciphertext(&pool, "acct", "msg-2")
            .await
            .unwrap()
            .is_none());
    }
}
