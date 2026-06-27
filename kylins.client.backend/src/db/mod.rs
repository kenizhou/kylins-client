//! Database layer for the Kylins Client backend.
//!
//! Owns the SQLite connection pool and the embedded sqlx migrations. The
//! frontend still uses `@tauri-apps/plugin-sql` for the time being; later tasks
//! in the mail-sync-engine Phase 0 will move all DB access here and remove the
//! plugin-sql dependency. For now this module only inits the pool, runs the
//! idempotent baseline migration, and exposes it via Tauri `State`.
//!
//! Submodules (`accounts`, `settings`, `labels`, ...) are per-domain query
//! layers filled in by later tasks. They are currently empty stubs so the
//! module compiles today.

pub mod accounts;
pub mod labels;
pub mod message_bodies;
pub mod messages;
pub mod settings;
pub mod sync_state;
pub mod threads;

use std::path::Path;
use sqlx::{
    sqlite::{SqliteConnectOptions, SqlitePoolOptions},
    SqlitePool,
};

/// Alias for the connection pool type used across the crate.
pub type DbPool = SqlitePool;

/// Open (or create) `mailclient.db` in `dir`, configure WAL + busy_timeout +
/// foreign_keys, and run embedded migrations. Idempotent — safe on a DB
/// already populated by the legacy frontend migrations because every object in
/// the baseline is created with `IF NOT EXISTS`.
///
/// Migrations live in `kylins.client.backend/migrations/` and are embedded at
/// compile time via `sqlx::migrate!`. sqlx tracks applied migrations in its own
/// `_sqlx_migrations` table, which is separate from the frontend's legacy
/// `_migrations` table.
pub async fn init_db(dir: &Path) -> Result<DbPool, sqlx::Error> {
    // Best-effort: ignore the error if the dir already exists or cannot be
    // created (connect_with below will surface a clearer error).
    std::fs::create_dir_all(dir).ok();

    let db_path = dir.join("mailclient.db");
    let opts = SqliteConnectOptions::new()
        .filename(&db_path)
        .create_if_missing(true)
        .journal_mode(sqlx::sqlite::SqliteJournalMode::Wal)
        .busy_timeout(std::time::Duration::from_secs(5))
        .foreign_keys(true);

    let pool = SqlitePoolOptions::new()
        .max_connections(5)
        .connect_with(opts)
        .await?;

    sqlx::migrate!("./migrations").run(&pool).await?;
    Ok(pool)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn migrations_apply_and_create_tables() {
        let tmp = tempfile::tempdir().unwrap();
        let pool = init_db(tmp.path()).await.unwrap();

        let row: (i64,) =
            sqlx::query_as("SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name='accounts'")
                .fetch_one(&pool)
                .await
                .unwrap();
        assert!(row.0 >= 1, "accounts table should exist");

        let row: (i64,) = sqlx::query_as(
            "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name='folder_sync_state'",
        )
        .fetch_one(&pool)
        .await
        .unwrap();
        assert_eq!(row.0, 1, "folder_sync_state table should exist");

        // Idempotent re-run must not error: the baseline uses IF NOT EXISTS and
        // sqlx records the migration as applied, so the second run is a no-op.
        sqlx::migrate!("./migrations").run(&pool).await.unwrap();
    }

    /// The legacy frontend DB already has all baseline tables (created by its
    /// own `_migrations` runner) but no `_sqlx_migrations` tracking table.
    /// Simulate that: pre-create `accounts` directly, then run init_db's
    /// baseline on top. It must succeed and leave the existing table intact.
    #[tokio::test]
    async fn baseline_is_idempotent_on_pre_populated_db() {
        let tmp = tempfile::tempdir().unwrap();
        // Stand up a DB with a hand-created accounts table, mimicking a legacy
        // user DB before sqlx ever touches it.
        {
            let path = tmp.path().join("mailclient.db");
            let opts = SqliteConnectOptions::new()
                .filename(&path)
                .create_if_missing(true);
            let pool = SqlitePoolOptions::new()
                .max_connections(1)
                .connect_with(opts)
                .await
                .unwrap();
            sqlx::query(
                "CREATE TABLE accounts (id TEXT PRIMARY KEY, email TEXT NOT NULL UNIQUE, foo TEXT)",
            )
            .execute(&pool)
            .await
            .unwrap();
            sqlx::query("INSERT INTO accounts (id, email, foo) VALUES ('a', 'a@b', 'keep-me')")
                .execute(&pool)
                .await
                .unwrap();
            // Legacy frontend migrations bookkeeping table (leave alone).
            sqlx::query("CREATE TABLE _migrations (version INTEGER PRIMARY KEY)")
                .execute(&pool)
                .await
                .unwrap();
            pool.close().await;
        }

        // Now run our baseline on top. The pre-existing `accounts` table must
        // be preserved (CREATE TABLE IF NOT EXISTS is a no-op; we do NOT ALTER
        // it, which is why the baseline is one consolidated snapshot).
        let pool = init_db(tmp.path()).await.unwrap();
        let row: (String, String) =
            sqlx::query_as("SELECT id, email FROM accounts WHERE id = 'a'")
                .fetch_one(&pool)
                .await
                .unwrap();
        assert_eq!(row.0, "a");
        assert_eq!(row.1, "a@b");

        // New tables from the baseline must be present.
        let row: (i64,) = sqlx::query_as(
            "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name='folder_sync_state'",
        )
        .fetch_one(&pool)
        .await
        .unwrap();
        assert_eq!(row.0, 1);
    }
}
