//! Per-account rate-limit state (`provider_rate_limit` table).
//!
//! When a mail source returns a rate-limit error (HTTP 429 / 503 with
//! `Retry-After`, or an EAS protocol status indicating throttle), the engine
//! records `retry_after` (epoch seconds) here. Before scheduling each sync
//! round, the engine calls [`is_rate_limited`]; a live row skips the round and
//! emits `sync:status { state: "rate_limited", detail: retry_after }`.
//!
//! TTL: there is no background sweeper. [`get_rate_limit`] lazy-deletes an
//! expired row (one whose `retry_after <= unixepoch()`) the first time it is
//! read after expiry, returning `None`. This mirrors inbox-zero's Redis TTL
//! (`utils/redis/email-provider-rate-limit.ts`) without a Redis dependency.

use sqlx::SqlitePool;

/// Record (or replace) the rate-limit window for an account. UPSERT — the
/// latest server `Retry-After` is authoritative and must overwrite any prior
/// window in either direction.
pub async fn set_rate_limit(
    pool: &SqlitePool,
    account_id: &str,
    retry_after: i64,
) -> Result<(), String> {
    sqlx::query(
        "INSERT INTO provider_rate_limit (account_id, retry_after, updated_at)
         VALUES (?, ?, unixepoch())
         ON CONFLICT(account_id) DO UPDATE SET
           retry_after = excluded.retry_after,
           updated_at = excluded.updated_at",
    )
    .bind(account_id)
    .bind(retry_after)
    .execute(pool)
    .await
    .map_err(|e| e.to_string())?;
    Ok(())
}

/// Returns `Some(retry_after)` if the account is currently rate-limited, or
/// `None` if there is no row OR the row's window has passed (in which case the
/// expired row is lazy-deleted). Never panics; a DB error surfaces as `Err`.
pub async fn get_rate_limit(
    pool: &SqlitePool,
    account_id: &str,
) -> Result<Option<i64>, String> {
    let row: Option<(i64,)> = sqlx::query_as(
        "SELECT retry_after FROM provider_rate_limit WHERE account_id = ?",
    )
    .bind(account_id)
    .fetch_optional(pool)
    .await
    .map_err(|e| e.to_string())?;

    let Some((retry_after,)) = row else {
        return Ok(None);
    };

    let now: (i64,) = sqlx::query_as("SELECT unixepoch()")
        .fetch_one(pool)
        .await
        .map_err(|e| e.to_string())?;
    if retry_after > now.0 {
        Ok(Some(retry_after))
    } else {
        // Window passed — lazy-delete the stale row. Best-effort: a delete
        // failure does not change the answer (None), and the row will be
        // re-attempted for deletion on the next read.
        let _ = sqlx::query("DELETE FROM provider_rate_limit WHERE account_id = ?")
            .bind(account_id)
            .execute(pool)
            .await;
        Ok(None)
    }
}

/// Unconditionally remove the rate-limit row (manual clear / tests).
pub async fn clear_rate_limit(pool: &SqlitePool, account_id: &str) -> Result<(), String> {
    sqlx::query("DELETE FROM provider_rate_limit WHERE account_id = ?")
        .bind(account_id)
        .execute(pool)
        .await
        .map_err(|e| e.to_string())?;
    Ok(())
}

/// Convenience: true iff a live rate-limit row exists. **Fails open** — a DB
/// error returns `false` so a transient SQLite blip does not wedge every
/// account's sync (the next round re-reads).
pub async fn is_rate_limited(pool: &SqlitePool, account_id: &str) -> bool {
    matches!(get_rate_limit(pool, account_id).await, Ok(Some(_)))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::init_db;
    use sqlx::SqlitePool;

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
    async fn set_then_get_rate_limit_returns_retry_after() {
        let tmp = tempfile::tempdir().unwrap();
        let pool = init_db(tmp.path()).await.unwrap();
        seed_account(&pool, "a").await;

        let future = sqlx::query_as::<_, (i64,)>("SELECT unixepoch() + 300")
            .fetch_one(&pool)
            .await
            .unwrap()
            .0;
        set_rate_limit(&pool, "a", future).await.unwrap();

        assert_eq!(get_rate_limit(&pool, "a").await.unwrap(), Some(future));
        assert!(is_rate_limited(&pool, "a").await);
    }

    #[tokio::test]
    async fn get_rate_limit_returns_none_when_no_row() {
        let tmp = tempfile::tempdir().unwrap();
        let pool = init_db(tmp.path()).await.unwrap();
        seed_account(&pool, "a").await;

        assert_eq!(get_rate_limit(&pool, "a").await.unwrap(), None);
        assert!(!is_rate_limited(&pool, "a").await);
    }

    #[tokio::test]
    async fn get_rate_limit_lazy_deletes_expired_row_and_returns_none() {
        // The TTL auto-expire: a row whose retry_after is in the past must be
        // treated as "no limit" AND physically removed so it doesn't linger.
        let tmp = tempfile::tempdir().unwrap();
        let pool = init_db(tmp.path()).await.unwrap();
        seed_account(&pool, "a").await;

        // Plant a row 100s in the past.
        let past = sqlx::query_as::<_, (i64,)>("SELECT unixepoch() - 100")
            .fetch_one(&pool)
            .await
            .unwrap()
            .0;
        set_rate_limit(&pool, "a", past).await.unwrap();
        // Sanity: the row exists before we read.
        let (cnt,): (i64,) =
            sqlx::query_as("SELECT COUNT(*) FROM provider_rate_limit WHERE account_id = 'a'")
                .fetch_one(&pool)
                .await
                .unwrap();
        assert_eq!(cnt, 1);

        // Read -> None (expired) + row lazy-deleted.
        assert_eq!(get_rate_limit(&pool, "a").await.unwrap(), None);
        let (cnt,): (i64,) =
            sqlx::query_as("SELECT COUNT(*) FROM provider_rate_limit WHERE account_id = 'a'")
                .fetch_one(&pool)
                .await
                .unwrap();
        assert_eq!(cnt, 0, "expired row must be lazy-deleted on read");
        assert!(!is_rate_limited(&pool, "a").await);
    }

    #[tokio::test]
    async fn set_rate_limit_is_upsert_so_latest_window_wins() {
        // A second 429 with a SHORTER window must NOT be clobbered by a stale
        // longer window — the server's latest Retry-After is authoritative.
        // (And vice versa: a longer later window replaces a shorter one.)
        let tmp = tempfile::tempdir().unwrap();
        let pool = init_db(tmp.path()).await.unwrap();
        seed_account(&pool, "a").await;

        let t1 = sqlx::query_as::<_, (i64,)>("SELECT unixepoch() + 600")
            .fetch_one(&pool)
            .await
            .unwrap()
            .0;
        let t2 = sqlx::query_as::<_, (i64,)>("SELECT unixepoch() + 30")
            .fetch_one(&pool)
            .await
            .unwrap()
            .0;

        set_rate_limit(&pool, "a", t1).await.unwrap();
        set_rate_limit(&pool, "a", t2).await.unwrap();

        assert_eq!(
            get_rate_limit(&pool, "a").await.unwrap(),
            Some(t2),
            "latest set_rate_limit must win (UPSERT, not INSERT OR IGNORE)"
        );
    }

    #[tokio::test]
    async fn clear_rate_limit_removes_row() {
        let tmp = tempfile::tempdir().unwrap();
        let pool = init_db(tmp.path()).await.unwrap();
        seed_account(&pool, "a").await;
        let future = sqlx::query_as::<_, (i64,)>("SELECT unixepoch() + 300")
            .fetch_one(&pool)
            .await
            .unwrap()
            .0;
        set_rate_limit(&pool, "a", future).await.unwrap();
        assert!(is_rate_limited(&pool, "a").await);

        clear_rate_limit(&pool, "a").await.unwrap();
        assert!(!is_rate_limited(&pool, "a").await);
        assert_eq!(get_rate_limit(&pool, "a").await.unwrap(), None);
    }
}
