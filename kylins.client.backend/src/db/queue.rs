//! Offline operations queue (`pending_operations` table).
//!
//! Rust port of `kylins.client.frontend/src/services/queue/offlineQueue.ts`.
//! Used by the composer send path to park operations that need a server
//! round-trip when the network is down; a later worker drains the queue with
//! exponential backoff.
//!
//! The four functions mirror the `OfflineQueue` TS class methods exactly,
//! including the pre-increment backoff semantics of [`mark_failed`] (see the
//! note on that function). All SQL is reproduced verbatim from the TS source
//! so a row written by the legacy frontend is interpretable by this code and
//! vice-versa — the table schema is unchanged.

use serde::{Deserialize, Serialize};
use sqlx::{
    sqlite::SqliteRow,
    Row, SqlitePool,
};

/// One row of the `pending_operations` table, surfaced to the frontend in
/// camelCase to match the TS `PendingOperation` interface
/// (`offlineQueue.ts:3-9`).
///
/// `params` is the raw JSON string in the DB; the TS caller JSON.parses it. We
/// keep it as a string here to avoid prescribing a schema for the params
/// payload (the TS interface types it as `Record<string, unknown>`).
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct PendingOperation {
    pub id: String,
    pub account_id: String,
    pub operation_type: String,
    pub resource_id: String,
    /// Serialized JSON. The frontend parses this into a `Record<string, unknown>`.
    pub params: String,
}

fn row_to_op(row: &SqliteRow) -> PendingOperation {
    PendingOperation {
        id: row.try_get("id").unwrap_or_default(),
        account_id: row.try_get("account_id").unwrap_or_default(),
        operation_type: row.try_get("operation_type").unwrap_or_default(),
        resource_id: row.try_get("resource_id").unwrap_or_default(),
        params: row.try_get("params").unwrap_or_default(),
    }
}

/// Insert a new pending operation. `id` is generated server-side (uuid v4) to
/// match the TS `op.id ?? crypto.randomUUID()` fallback.
pub async fn enqueue(
    pool: &SqlitePool,
    account_id: &str,
    operation_type: &str,
    resource_id: &str,
    params: &str,
) -> Result<String, String> {
    let id = uuid::Uuid::new_v4().to_string();
    sqlx::query(
        "INSERT INTO pending_operations
         (id, account_id, operation_type, resource_id, params, status, created_at)
         VALUES (?, ?, ?, ?, ?, 'pending', unixepoch())",
    )
    .bind(&id)
    .bind(account_id)
    .bind(operation_type)
    .bind(resource_id)
    .bind(params)
    .execute(pool)
    .await
    .map_err(|e| e.to_string())?;
    Ok(id)
}

/// Return up to `limit` pending operations whose `next_retry_at` is due (or
/// NULL, i.e. never retried yet), oldest-first.
pub async fn dequeue_pending(
    pool: &SqlitePool,
    limit: i64,
) -> Result<Vec<PendingOperation>, String> {
    let rows = sqlx::query(
        "SELECT * FROM pending_operations
         WHERE status = 'pending' AND (next_retry_at IS NULL OR next_retry_at <= unixepoch())
         ORDER BY created_at ASC LIMIT ?",
    )
    .bind(limit)
    .fetch_all(pool)
    .await
    .map_err(|e| e.to_string())?;
    Ok(rows.iter().map(row_to_op).collect())
}

/// Remove a completed operation.
pub async fn mark_completed(pool: &SqlitePool, id: &str) -> Result<(), String> {
    sqlx::query("DELETE FROM pending_operations WHERE id = ?")
        .bind(id)
        .execute(pool)
        .await
        .map_err(|e| e.to_string())?;
    Ok(())
}

/// Mark an operation as failed, bumping `retry_count`, scheduling the next
/// retry with exponential backoff, and flipping `status` to `'failed'` once
/// `retry_count + 1 >= max_retries`.
///
/// **Pre-increment semantics (reproduced from the TS verbatim):** SQLite
/// evaluates every RHS reference to `retry_count` against the *original* row
/// value, not the in-progress new value. So `next_retry_at` uses the
/// pre-increment count, and the `CASE` compares the post-increment count
/// (`retry_count + 1`) to `max_retries`. This is load-bearing: a naively
/// "fixed" version that used the post-increment value for the shift would
/// double the backoff window. See `offlineQueue.ts:54-65`.
pub async fn mark_failed(pool: &SqlitePool, id: &str, error: &str) -> Result<(), String> {
    sqlx::query(
        "UPDATE pending_operations
         SET retry_count = retry_count + 1,
             next_retry_at = unixepoch() + (60 * (1 << retry_count)),
             error_message = ?,
             status = CASE WHEN retry_count + 1 >= max_retries THEN 'failed' ELSE 'pending' END
         WHERE id = ?",
    )
    .bind(error)
    .bind(id)
    .execute(pool)
    .await
    .map_err(|e| e.to_string())?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Insert a bare account row directly (no crypto), so pending ops have a
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

    #[tokio::test]
    async fn enqueue_inserts_row_as_pending_with_uuid_id() {
        let tmp = tempfile::tempdir().unwrap();
        let pool = crate::db::init_db(tmp.path()).await.unwrap();
        seed_account(&pool, "acct-1").await;

        let id = enqueue(&pool, "acct-1", "archive", "thread-1", "{}")
            .await
            .unwrap();
        assert!(!id.is_empty(), "id should be generated");

        let row: (String, String, String) = sqlx::query_as(
            "SELECT status, operation_type, resource_id FROM pending_operations WHERE id = ?",
        )
        .bind(&id)
        .fetch_one(&pool)
        .await
        .unwrap();
        assert_eq!(row.0, "pending");
        assert_eq!(row.1, "archive");
        assert_eq!(row.2, "thread-1");
    }

    #[tokio::test]
    async fn dequeue_returns_due_pending_rows_oldest_first() {
        let tmp = tempfile::tempdir().unwrap();
        let pool = crate::db::init_db(tmp.path()).await.unwrap();
        seed_account(&pool, "acct-1").await;

        // Plant two rows with distinct created_at so order is deterministic.
        sqlx::query(
            "INSERT INTO pending_operations (id, account_id, operation_type, resource_id, params, status, created_at)
             VALUES ('old', 'acct-1', 'a', 'r1', '{}', 'pending', 100)",
        )
        .execute(&pool)
        .await
        .unwrap();
        sqlx::query(
            "INSERT INTO pending_operations (id, account_id, operation_type, resource_id, params, status, created_at)
             VALUES ('new', 'acct-1', 'a', 'r2', '{}', 'pending', 200)",
        )
        .execute(&pool)
        .await
        .unwrap();
        // A row already past max retries / status='failed' must be skipped.
        sqlx::query(
            "INSERT INTO pending_operations (id, account_id, operation_type, resource_id, params, status, created_at)
             VALUES ('failed', 'acct-1', 'a', 'r3', '{}', 'failed', 50)",
        )
        .execute(&pool)
        .await
        .unwrap();

        let ops = dequeue_pending(&pool, 50).await.unwrap();
        let ids: Vec<&str> = ops.iter().map(|o| o.id.as_str()).collect();
        assert_eq!(ids, vec!["old", "new"], "oldest-first, failed excluded");

        // camelCase JSON shape sanity (the TS caller reads these fields).
        let json = serde_json::to_value(&ops[0]).unwrap();
        let obj = json.as_object().unwrap();
        assert!(obj.contains_key("accountId"));
        assert!(obj.contains_key("operationType"));
        assert!(obj.contains_key("resourceId"));
    }

    #[tokio::test]
    async fn dequeue_excludes_rows_whose_next_retry_is_in_the_future() {
        let tmp = tempfile::tempdir().unwrap();
        let pool = crate::db::init_db(tmp.path()).await.unwrap();
        seed_account(&pool, "acct-1").await;

        // next_retry_at far in the future → not due.
        sqlx::query(
            "INSERT INTO pending_operations (id, account_id, operation_type, resource_id, params, status, next_retry_at, created_at)
             VALUES ('snoozed', 'acct-1', 'a', 'r', '{}', 'pending', 99999999999, 100)",
        )
        .execute(&pool)
        .await
        .unwrap();
        // next_retry_at in the past → due.
        sqlx::query(
            "INSERT INTO pending_operations (id, account_id, operation_type, resource_id, params, status, next_retry_at, created_at)
             VALUES ('due', 'acct-1', 'a', 'r', '{}', 'pending', 1, 100)",
        )
        .execute(&pool)
        .await
        .unwrap();

        let ops = dequeue_pending(&pool, 50).await.unwrap();
        let ids: Vec<&str> = ops.iter().map(|o| o.id.as_str()).collect();
        assert_eq!(ids, vec!["due"]);
    }

    #[tokio::test]
    async fn mark_completed_deletes_the_row() {
        let tmp = tempfile::tempdir().unwrap();
        let pool = crate::db::init_db(tmp.path()).await.unwrap();
        seed_account(&pool, "acct-1").await;
        let id = enqueue(&pool, "acct-1", "a", "r", "{}").await.unwrap();

        mark_completed(&pool, &id).await.unwrap();

        let (cnt,): (i64,) = sqlx::query_as("SELECT COUNT(*) FROM pending_operations WHERE id = ?")
            .bind(&id)
            .fetch_one(&pool)
            .await
            .unwrap();
        assert_eq!(cnt, 0);
    }

    #[tokio::test]
    async fn mark_failed_uses_pre_increment_backoff_and_flips_status_at_max() {
        // Reproduce the TS pre-increment semantics. With retry_count=0 and
        // max_retries=10 (schema default):
        //   retry_count becomes 1
        //   next_retry_at = now + 60 * (1 << 0) = now + 60   (pre-increment!)
        //   status stays 'pending' (1 < 10)
        let tmp = tempfile::tempdir().unwrap();
        let pool = crate::db::init_db(tmp.path()).await.unwrap();
        seed_account(&pool, "acct-1").await;
        let id = enqueue(&pool, "acct-1", "a", "r", "{}").await.unwrap();

        mark_failed(&pool, &id, "boom").await.unwrap();

        let row: (i64, i64, String, Option<i64>) = sqlx::query_as(
            "SELECT retry_count, next_retry_at - unixepoch() AS delta, status, max_retries FROM pending_operations WHERE id = ?",
        )
        .bind(&id)
        .fetch_one(&pool)
        .await
        .unwrap();
        assert_eq!(row.0, 1, "retry_count incremented to 1");
        assert_eq!(row.2, "pending", "status still pending after 1 < 10");
        // delta ≈ 60 (pre-increment shift of 0). Allow ±5s for test runtime.
        assert!(
            (50..=70).contains(&row.1),
            "expected ~60s backoff, got {}",
            row.1
        );

        // Push retry_count up to max-1 and mark again → should flip to 'failed'.
        sqlx::query("UPDATE pending_operations SET retry_count = 9 WHERE id = ?")
            .bind(&id)
            .execute(&pool)
            .await
            .unwrap();
        mark_failed(&pool, &id, "boom-2").await.unwrap();
        let (status,): (String,) = sqlx::query_as("SELECT status FROM pending_operations WHERE id = ?")
            .bind(&id)
            .fetch_one(&pool)
            .await
            .unwrap();
        assert_eq!(status, "failed", "should flip to failed at retry_count+1 >= max");
    }

    #[tokio::test]
    async fn mark_failed_pre_increment_shift_uses_count_of_2_on_third_failure() {
        // Second failure with retry_count=2 pre-increment → shift of 2 → 4 min.
        // Verifies the pre-increment behavior is load-bearing (a post-increment
        // version would shift by 3 → 8 min).
        let tmp = tempfile::tempdir().unwrap();
        let pool = crate::db::init_db(tmp.path()).await.unwrap();
        seed_account(&pool, "acct-1").await;
        let id = enqueue(&pool, "acct-1", "a", "r", "{}").await.unwrap();
        sqlx::query("UPDATE pending_operations SET retry_count = 2 WHERE id = ?")
            .bind(&id)
            .execute(&pool)
            .await
            .unwrap();

        mark_failed(&pool, &id, "boom").await.unwrap();
        let (delta,): (i64,) = sqlx::query_as(
            "SELECT next_retry_at - unixepoch() FROM pending_operations WHERE id = ?",
        )
        .bind(&id)
        .fetch_one(&pool)
        .await
        .unwrap();
        // 60 * (1 << 2) = 240s. Allow ±10s for test runtime.
        assert!(
            (230..=250).contains(&delta),
            "expected ~240s backoff (pre-increment shift=2), got {delta}"
        );
    }
}
