//! Database layer for the Kylins Client backend.
//!
//! Owns the SQLite connection pool and the embedded sqlx migrations. As of the
//! plugin-sql clean cut (Task 5 Option C completion), Rust is the **sole**
//! writer of every table. The frontend `invoke`s the `db_*` commands declared
//! in [`commands`] for all subsystems: accounts, settings, labels/folders,
//! threads, message_bodies, pending_operations, contacts (+ groups),
//! signatures, drafts, send-as aliases, calendar_events, scheduled_emails,
//! templates, contact_sync_state, image_allowlist, ai_cache, and FTS5 search.
//! `@tauri-apps/plugin-sql` is no longer a dependency on either side.
//!
//! Migrations live in `kylins.client.backend/migrations/` and are embedded at
//! compile time via `sqlx::migrate!`.

pub mod accounts;
pub mod ai_cache;
pub mod attachments;
pub mod calendar_events;
pub mod calendars;
pub mod commands;
pub mod contact_sync_state;
pub mod contacts;
pub mod drafts;
pub mod image_allowlist;
pub mod labels;
pub mod message_bodies;
pub mod messages;
pub mod mutations;
pub mod queue;
pub mod rate_limit;
pub mod scheduled_emails;
pub mod search;
pub mod send_as_aliases;
pub mod settings;
pub mod signatures;
pub mod sync_state;
pub mod tasks;
pub mod templates;
pub mod threads;

use sqlx::{
    sqlite::{SqliteConnectOptions, SqlitePoolOptions},
    SqlitePool,
};
use std::path::Path;

/// Alias for the connection pool type used across the crate.
pub type DbPool = SqlitePool;

/// A typed, owned bind value used by the dynamic UPDATE builders in the
/// per-table modules. Each variant corresponds to a SQLite column type we
/// actually write. All variants implement `sqlx::Encode<Sqlite> + Type<Sqlite>`
/// so a `Vec<BindValue>` can be spread into `query.bind(...)` in order.
///
/// Using an owned enum (rather than `SqliteArgumentValue<'_>`) sidesteps the
/// lifetime gymnastics that the low-level argument API would require, and keeps
/// the dynamic SET-clause builders readable.
pub enum BindValue {
    Null,
    Int(i64),
    Text(String),
}

/// Build a dynamic `UPDATE {table} SET col1=$1, col2=$2, ... WHERE {id_col}=$n`
/// statement from `(column, BindValue)` pairs and execute it. Mirrors the TS
/// `buildDynamicUpdate` helper in `services/db/connection.ts`. Returns Ok(())
/// if `sets` is empty (no-op), matching the TS `if (fields.length === 0) return null`.
pub async fn exec_dynamic_update(
    pool: &SqlitePool,
    table: &str,
    id_col: &str,
    id_val: &str,
    sets: Vec<(&str, BindValue)>,
) -> Result<(), String> {
    if sets.is_empty() {
        return Ok(());
    }
    let clauses: Vec<String> = sets
        .iter()
        .enumerate()
        .map(|(i, (col, _))| format!("{} = ${}", col, i + 1))
        .collect();
    let id_idx = sets.len() + 1;
    let sql = format!(
        "UPDATE {} SET {} WHERE {} = ${}",
        table,
        clauses.join(", "),
        id_col,
        id_idx
    );
    let mut q = sqlx::query(&sql);
    for (_, v) in &sets {
        match v {
            BindValue::Null => q = q.bind(None::<String>),
            BindValue::Int(n) => q = q.bind(*n),
            BindValue::Text(s) => q = q.bind(s.clone()),
        }
    }
    q = q.bind(id_val);
    q.execute(pool).await.map_err(|e| e.to_string())?;
    Ok(())
}

/// Same as [`exec_dynamic_update`] but for a dynamic `SELECT * FROM {table}
/// WHERE ... LIMIT $n OFFSET $n+1` driven by filter pairs. Mirrors the
/// `getContacts` filter-building logic.
pub async fn exec_dynamic_select_filter(
    pool: &SqlitePool,
    table: &str,
    where_binds: Vec<(&str, BindValue)>,
    extra_where: Vec<String>,
    order_by: &str,
    limit: i64,
    offset: i64,
) -> Result<Vec<sqlx::sqlite::SqliteRow>, String> {
    let mut clauses: Vec<String> = where_binds
        .iter()
        .enumerate()
        .map(|(i, (col, _))| format!("{} = ${}", col, i + 1))
        .collect();
    clauses.extend(extra_where);
    let where_clause = if clauses.is_empty() {
        String::new()
    } else {
        format!("WHERE {}", clauses.join(" AND "))
    };
    let limit_idx = where_binds.len() + 1;
    let offset_idx = where_binds.len() + 2;
    let sql = format!(
        "SELECT * FROM {table} {where_clause} ORDER BY {order_by} LIMIT ${limit_idx} OFFSET ${offset_idx}"
    );
    let mut q = sqlx::query(&sql);
    for (_, v) in &where_binds {
        match v {
            BindValue::Null => q = q.bind(None::<String>),
            BindValue::Int(n) => q = q.bind(*n),
            BindValue::Text(s) => q = q.bind(s.clone()),
        }
    }
    q = q.bind(limit);
    q = q.bind(offset);
    q.fetch_all(pool).await.map_err(|e| e.to_string())
}

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
        // 30s busy_timeout: SQLite/WAL allows only ONE writer at a time; a
        // contending write blocks for up to `busy_timeout` before returning
        // SQLITE_BUSY (code 5). For a large folder (Deleted Items ≈ 13k+
        // messages) `apply_folder_delta` runs multi-second transactions, and a
        // second writer (frontend `db_*`, another account's worker, an
        // IDLE-nudged sync) waiting only 5s would spuriously fail with
        // "database is locked", dropping + retrying the delta (wasted work +
        // sync thrash). 30s is safe for a background desktop sync — the user
        // is never blocked on it because writes happen off the UI thread.
        // (apply_folder_delta also batches its writes into short chunks, so a
        // 30s ceiling is effectively never hit.)
        .busy_timeout(std::time::Duration::from_secs(30))
        .foreign_keys(true);

    let pool = SqlitePoolOptions::new()
        .max_connections(5)
        // 5s ceiling on *pool acquisition* — distinct from `busy_timeout` above,
        // which only governs the SQLite write lock on a connection we already
        // hold. `max_connections(5)` means at most 5 connections are checked out
        // at once; the 6th caller (a foreground `db_*` IPC during a large
        // `apply_folder_delta` write, or a second account's worker) parks on the
        // pool's semaphore. sqlx's default `acquire_timeout` is **forever**, so a
        // stuck transaction (or one that legitimately takes seconds on a 13k-
        // message folder) suspends every later caller indefinitely — the
        // "never times out, all suspended" symptom. 5s bounds the park: a
        // timed-out acquisition returns `PoolAcquire(TimedOut)`, which the IPC
        // layer already maps to `String` + logs as a soft error (the user gets a
        // "couldn't load right now, retry" rather than a permanent hang). 5s is
        // generous for a desktop app with at most a few concurrent writers.
        .acquire_timeout(std::time::Duration::from_secs(5))
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

        let row: (i64,) = sqlx::query_as(
            "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name='accounts'",
        )
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
                "CREATE TABLE accounts (id TEXT PRIMARY KEY, email TEXT NOT NULL UNIQUE, imap_username TEXT, foo TEXT)",
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
        let row: (String, String) = sqlx::query_as("SELECT id, email FROM accounts WHERE id = 'a'")
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
