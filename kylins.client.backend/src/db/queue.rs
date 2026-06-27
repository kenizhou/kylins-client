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

/// Like [`dequeue_pending`] but scoped to a single account. Used by the per-account
/// replay worker so a slow account's queue can't starve others.
pub async fn dequeue_pending_for_account(
    pool: &SqlitePool,
    account_id: &str,
    limit: i64,
) -> Result<Vec<PendingOperation>, String> {
    let rows = sqlx::query(
        "SELECT * FROM pending_operations
         WHERE account_id = ? AND status = 'pending'
           AND (next_retry_at IS NULL OR next_retry_at <= unixepoch())
         ORDER BY created_at ASC LIMIT ?",
    )
    .bind(account_id)
    .bind(limit)
    .fetch_all(pool)
    .await
    .map_err(|e| e.to_string())?;
    Ok(rows.iter().map(row_to_op).collect())
}

/// Count of `status='pending'` rows for an account — used by the UI to show
/// per-account pending state and by the worker to know when to back off.
pub async fn pending_count_for_account(pool: &SqlitePool, account_id: &str) -> Result<i64, String> {
    let (n,): (i64,) = sqlx::query_as(
        "SELECT COUNT(*) FROM pending_operations WHERE account_id = ? AND status = 'pending'",
    )
    .bind(account_id)
    .fetch_one(pool)
    .await
    .map_err(|e| e.to_string())?;
    Ok(n)
}

/// Resource write-lock helper: returns true if any pending op already targets
/// `(account_id, resource_id)`. The caller uses this to decide whether to
/// enqueue a new op or wait (avoiding interleaved mutations of the same row).
pub async fn has_pending_for_resource(
    pool: &SqlitePool,
    account_id: &str,
    resource_id: &str,
) -> bool {
    let row: Result<(i64,), _> = sqlx::query_as(
        "SELECT COUNT(*) FROM pending_operations
         WHERE account_id = ? AND resource_id = ? AND status = 'pending'",
    )
    .bind(account_id)
    .bind(resource_id)
    .fetch_one(pool)
    .await;
    matches!(row, Ok((n,)) if n > 0)
}

/// Compact an account's queue by dropping cancel-out toggle pairs:
/// a `markRead`/`setFlag` op with `params.read = 1` followed by one with
/// `params.read = 0` on the same `resource_id` (and same `operation_type`) are
/// mutually annihilated.
///
/// The pair is detected via a self-join on the table ordered by `id` (UUIDs are
/// monotonically ordered by creation in practice, but `a.id < b.id` keeps the
/// match deterministic across re-runs).
///
/// **Implementation note (deviation from a naive two-DELETE form):** We first
/// materialize the paired ids via a SELECT, then issue two DELETEs — one per
/// side of the pair — bound against that snapshot. A sequential pair of
/// `DELETE ... WHERE id IN (subquery)` statements is *not* sufficient here:
/// once the first DELETE removes the `a` (read=1) row, the second DELETE's
/// self-join has no `a` to match against `b`, so `b` would survive. Hoisting
/// the id collection makes both DELETEs order-independent while keeping them as
/// two separate statements (per the brief: "two DELETEs, do not collapse").
///
/// `params` JSON must carry a top-level `read` field (0/1) for the toggle to
/// match. Task 3's `MutationOp::encode_params` produces this for both
/// `markRead` and `setFlag`; legacy frontend rows using `{}` params are simply
/// left untouched (json_extract returns NULL, not 0).
pub async fn compact_queue(pool: &SqlitePool, account_id: &str) -> Result<(), String> {
    // Snapshot the cancel-out pairs up front. `a` is the read=1 side, `b` the
    // read=0 side; we collect both ids.
    let pairs: Vec<(String, String)> = sqlx::query_as(
        "SELECT a.id, b.id FROM pending_operations a
         JOIN pending_operations b
           ON a.account_id = b.account_id AND a.resource_id = b.resource_id
          AND a.operation_type = b.operation_type AND a.id < b.id
         WHERE a.account_id = ? AND a.status = 'pending' AND b.status = 'pending'
           AND a.operation_type IN ('markRead','setFlag')
           AND json_extract(a.params, '$.read') = 1
           AND json_extract(b.params, '$.read') = 0",
    )
    .bind(account_id)
    .fetch_all(pool)
    .await
    .map_err(|e| e.to_string())?;

    if pairs.is_empty() {
        return Ok(());
    }

    // Delete the read=1 sides, then the read=0 sides. Two separate DELETE
    // statements (do not collapse); each is bound against the pre-snapshot ids
    // so the second still fires even though the first already removed its rows.
    let a_ids: Vec<String> = pairs.iter().map(|(a, _)| a.clone()).collect();
    let b_ids: Vec<String> = pairs.iter().map(|(_, b)| b.clone()).collect();
    delete_ids(pool, &a_ids).await?;
    delete_ids(pool, &b_ids).await?;
    Ok(())
}

/// `DELETE FROM pending_operations WHERE id IN (?, ?, ...)`. Used by
/// [`compact_queue`] to delete each side of a cancel-out pair. Empty input is
/// a no-op.
async fn delete_ids(pool: &SqlitePool, ids: &[String]) -> Result<(), String> {
    if ids.is_empty() {
        return Ok(());
    }
    let placeholders = std::iter::repeat("?")
        .take(ids.len())
        .collect::<Vec<_>>()
        .join(",");
    let sql = format!("DELETE FROM pending_operations WHERE id IN ({placeholders})");
    let mut q = sqlx::query(&sql);
    for id in ids {
        q = q.bind(id);
    }
    q.execute(pool).await.map_err(|e| e.to_string())?;
    Ok(())
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

    // ---- Phase 1: per-account queue reads + resource write-lock + compact ----

    #[tokio::test]
    async fn dequeue_pending_for_account_filters_by_account() {
        let tmp = tempfile::tempdir().unwrap();
        let pool = crate::db::init_db(tmp.path()).await.unwrap();
        seed_account(&pool, "a1").await;
        seed_account(&pool, "a2").await;
        for (id, acc) in [("o1", "a1"), ("o2", "a1"), ("o3", "a2")] {
            sqlx::query(
                "INSERT INTO pending_operations (id, account_id, operation_type, resource_id, params, status, created_at)
                 VALUES (?,?,'x','r','{}','pending', 1)",
            )
            .bind(id)
            .bind(acc)
            .execute(&pool)
            .await
            .unwrap();
        }
        let ops = dequeue_pending_for_account(&pool, "a1", 50).await.unwrap();
        let ids: Vec<&str> = ops.iter().map(|o| o.id.as_str()).collect();
        assert_eq!(ids, vec!["o1", "o2"]);
    }

    #[tokio::test]
    async fn pending_count_for_account_counts_only_pending_rows_for_account() {
        let tmp = tempfile::tempdir().unwrap();
        let pool = crate::db::init_db(tmp.path()).await.unwrap();
        seed_account(&pool, "a1").await;
        seed_account(&pool, "a2").await;
        for (id, acc, status) in [
            ("p1", "a1", "pending"),
            ("p2", "a1", "pending"),
            ("p3", "a1", "failed"),
            ("p4", "a2", "pending"),
        ] {
            sqlx::query(
                "INSERT INTO pending_operations (id, account_id, operation_type, resource_id, params, status, created_at)
                 VALUES (?,?,'x','r','{}',?, 1)",
            )
            .bind(id)
            .bind(acc)
            .bind(status)
            .execute(&pool)
            .await
            .unwrap();
        }
        assert_eq!(pending_count_for_account(&pool, "a1").await.unwrap(), 2);
        assert_eq!(pending_count_for_account(&pool, "a2").await.unwrap(), 1);
        assert_eq!(pending_count_for_account(&pool, "zzz").await.unwrap(), 0);
    }

    #[tokio::test]
    async fn has_pending_for_resource_is_exact() {
        let tmp = tempfile::tempdir().unwrap();
        let pool = crate::db::init_db(tmp.path()).await.unwrap();
        seed_account(&pool, "a1").await;
        assert!(!has_pending_for_resource(&pool, "a1", "msg-1").await);
        sqlx::query(
            "INSERT INTO pending_operations (id, account_id, operation_type, resource_id, params, status, created_at)
             VALUES ('p','a1','markRead','msg-1','{}','pending',1)",
        )
        .execute(&pool)
        .await
        .unwrap();
        assert!(has_pending_for_resource(&pool, "a1", "msg-1").await);
        assert!(!has_pending_for_resource(&pool, "a1", "msg-2").await);
        // 'failed' rows must NOT count as pending for a resource.
        sqlx::query(
            "INSERT INTO pending_operations (id, account_id, operation_type, resource_id, params, status, created_at)
             VALUES ('f','a1','markRead','msg-9','{}','failed',1)",
        )
        .execute(&pool)
        .await
        .unwrap();
        assert!(
            !has_pending_for_resource(&pool, "a1", "msg-9").await,
            "failed rows are not pending"
        );
    }

    #[tokio::test]
    async fn compact_queue_cancels_markread_toggle_pair() {
        let tmp = tempfile::tempdir().unwrap();
        let pool = crate::db::init_db(tmp.path()).await.unwrap();
        seed_account(&pool, "a1").await;
        // add=true first (id 'op-a' sorts before 'op-b'), add=false second.
        // The brief's compact join keys on `a.id < b.id` where `a` is the
        // read=1 row and `b` is the read=0 row, so the read=1 row must sort
        // first — matching how `enqueue` assigns monotonic-ish UUIDs in
        // practice (earlier op = smaller id).
        sqlx::query(
            "INSERT INTO pending_operations (id, account_id, operation_type, resource_id, params, status, created_at)
             VALUES ('op-a','a1','markRead','msg-1','{\"read\":1}','pending',10)",
        )
        .execute(&pool)
        .await
        .unwrap();
        sqlx::query(
            "INSERT INTO pending_operations (id, account_id, operation_type, resource_id, params, status, created_at)
             VALUES ('op-b','a1','markRead','msg-1','{\"read\":0}','pending',20)",
        )
        .execute(&pool)
        .await
        .unwrap();

        compact_queue(&pool, "a1").await.unwrap();

        let (cnt,): (i64,) = sqlx::query_as("SELECT COUNT(*) FROM pending_operations WHERE account_id = 'a1'")
            .fetch_one(&pool)
            .await
            .unwrap();
        assert_eq!(cnt, 0, "cancel-out pair should be fully dropped");
    }

    #[tokio::test]
    async fn compact_queue_is_noop_when_no_cancelable_pairs() {
        let tmp = tempfile::tempdir().unwrap();
        let pool = crate::db::init_db(tmp.path()).await.unwrap();
        seed_account(&pool, "a1").await;
        // Two unrelated markRead ops on different resources — no cancel pair.
        sqlx::query(
            "INSERT INTO pending_operations (id, account_id, operation_type, resource_id, params, status, created_at)
             VALUES ('r1','a1','markRead','msg-1','{\"read\":1}','pending',10)",
        )
        .execute(&pool)
        .await
        .unwrap();
        sqlx::query(
            "INSERT INTO pending_operations (id, account_id, operation_type, resource_id, params, status, created_at)
             VALUES ('r2','a1','markRead','msg-2','{\"read\":1}','pending',20)",
        )
        .execute(&pool)
        .await
        .unwrap();
        // A non-toggle op type must not be touched.
        sqlx::query(
            "INSERT INTO pending_operations (id, account_id, operation_type, resource_id, params, status, created_at)
             VALUES ('r3','a1','archive','msg-1','{\"read\":1}','pending',30)",
        )
        .execute(&pool)
        .await
        .unwrap();

        compact_queue(&pool, "a1").await.unwrap();

        let (cnt,): (i64,) = sqlx::query_as("SELECT COUNT(*) FROM pending_operations WHERE account_id = 'a1'")
            .fetch_one(&pool)
            .await
            .unwrap();
        assert_eq!(cnt, 3, "nothing should be removed");
    }
}
