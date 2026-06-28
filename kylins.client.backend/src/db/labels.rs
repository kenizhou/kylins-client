//! Labels (folders) query layer.
//!
//! Rust port of `kylins.client.frontend/src/services/db/labels.ts`. The
//! `labels` table holds folders from every source (IMAP, Gmail, ActiveSync,
//! Graph, local); this module maps those rows to/from the canonical
//! [`MailFolder`] DTO so callers never touch SQL or provider-specific columns.
//!
//! The TS source of truth for the `MailFolder` shape is
//! `kylins.client.frontend/src/services/mail/folders/folderModel.ts:29-54`.
//! The TS source of truth for SQL + the snake→camel row mapping is
//! `kylins.client.frontend/src/services/db/labels.ts`.
//!
//! Note on naming: the table is `labels` and the TS service file is
//! `labels.ts`, but the row represents a *folder*; the DTO type is `MailFolder`
//! (source-agnostic). That mismatch is intentional and inherited from the
//! frontend — do not rename.

use std::collections::{HashMap, HashSet};

use serde::{Deserialize, Serialize};
use sqlx::{sqlite::SqliteRow, Row, SqlitePool};

/// Canonical, source-agnostic folder DTO.
///
/// Mirrors the TypeScript `MailFolder` interface at
/// `services/mail/folders/folderModel.ts:29-54` exactly. Field names are
/// camelCase in JSON (via `#[serde(rename_all)]`) so the JSON shape matches the
/// TS interface byte-for-byte. Rust field names stay snake_case.
///
/// `role` / `parentId` / `remoteId` / `delimiter` / `hierarchicalName` are
/// optional. The labels-specific columns the row can carry (`type`,
/// `colorBg`, `colorFg`, `imapFolderPath`, `imapSpecialUse`) are also optional
/// and surfaced for completeness — they are NOT populated by [`upsert_folders`]
/// (which mirrors `labels.ts:123-162` exactly) but may be present on rows
/// written by other code paths.
#[derive(Debug, Clone, Serialize, Deserialize, Default, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct MailFolder {
    /// Internal id (`labels.id`). Stable across re-syncs.
    pub id: String,
    pub account_id: String,
    /// Source adapter that produced this row. Defaults to `"local"` on read
    /// when the column is NULL (matches `rowToFolder` `?? 'local'`).
    pub source: String,
    /// Canonical special-folder role (`inbox`/`sent`/...), or `None` for a
    /// user-created folder.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub role: Option<String>,
    pub name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub parent_id: Option<String>,
    /// Provider-native folder id. On read, falls back to `id` when NULL
    /// (matches `rowToFolder` `?? row.id`).
    pub remote_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub delimiter: Option<String>,
    /// Live unread thread count (maintained by message sync, not by
    /// [`upsert_folders`]). Defaults to 0 on read.
    pub unread_count: i64,
    /// Live total thread count. Defaults to 0 on read.
    pub total_count: i64,
    pub sort_order: i64,
    /// Whether the folder appears in the folder pane. SQLite stores 0/1; the
    /// DTO surfaces a bool (matches `visible === 1` in `rowToFolder`). Defaults
    /// to `true` when the column is NULL.
    pub visible: bool,
    /// Full display path `"a/b/c"` when known.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub hierarchical_name: Option<String>,
    /// Coarse folder class. Defaults to `"mail"` on read.
    pub mail_class: String,

    // ---- labels-specific columns the row may carry ----
    /// `"system"` when `role` is set, else `"user"`. Populated by
    /// [`upsert_folders`] / [`create_folder`]; surfaced on read for callers
    /// that need it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[serde(rename = "type")]
    pub type_: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub color_bg: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub color_fg: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub imap_folder_path: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub imap_special_use: Option<String>,
}

/// Map a raw `labels` row to a [`MailFolder`], reproducing the defaults from
/// `rowToFolder` (`labels.ts:32-49`):
/// - `source ?? "local"`
/// - `remoteId ?? id`
/// - `unreadCount ?? 0`, `totalCount ?? 0`, `sortOrder ?? 0`
/// - `visible === 1` (NULL → 1, i.e. visible)
/// - `mailClass ?? "mail"`
fn row_to_folder(row: &SqliteRow) -> MailFolder {
    let id: String = row.try_get("id").unwrap_or_default();
    let source: Option<String> = row.try_get("source").ok().flatten();
    let remote_id: Option<String> = row.try_get("remote_id").ok().flatten();
    let role: Option<String> = row.try_get("role").ok().flatten();
    let type_: Option<String> = row.try_get("type").ok().flatten();
    MailFolder {
        id: id.clone(),
        account_id: row.try_get("account_id").unwrap_or_default(),
        source: source.unwrap_or_else(|| "local".to_string()),
        role,
        name: row.try_get("name").unwrap_or_default(),
        parent_id: row.try_get("parent_id").ok().flatten(),
        // remoteId falls back to id when NULL (matches TS `?? row.id`).
        remote_id: remote_id.unwrap_or(id),
        delimiter: row.try_get("delimiter").ok().flatten(),
        unread_count: row.try_get("unread_count").unwrap_or(0),
        total_count: row.try_get("total_count").unwrap_or(0),
        sort_order: row.try_get("sort_order").unwrap_or(0),
        // visible defaults to 1 in the schema; NULL/0 → false.
        visible: row.try_get::<i64, _>("visible").unwrap_or(1) == 1,
        hierarchical_name: row.try_get("hierarchical_name").ok().flatten(),
        mail_class: row
            .try_get("mail_class")
            .ok()
            .flatten()
            .unwrap_or_else(|| "mail".to_string()),
        type_,
        color_bg: row.try_get("color_bg").ok().flatten(),
        color_fg: row.try_get("color_fg").ok().flatten(),
        imap_folder_path: row.try_get("imap_folder_path").ok().flatten(),
        imap_special_use: row.try_get("imap_special_use").ok().flatten(),
    }
}

/// Return all visible mail folders for one account, system-first then user,
/// ready to render. Mirrors `getFoldersByAccount` (`labels.ts:62-70`) including
/// the `mail_class = 'mail' AND visible = 1` filter. Sorting (system-role
/// order, then `sort_order`, then name) is left to the caller — the TS layer
/// sorts in JS, and this module's contract is "return what's in the DB in
/// unspecified order" so the caller can apply the same `roleOrderIndex` rule
/// consistently.
pub async fn get_folders_by_account(
    pool: &SqlitePool,
    account_id: &str,
) -> Result<Vec<MailFolder>, String> {
    let rows = sqlx::query(
        "SELECT * FROM labels
         WHERE account_id = ? AND mail_class = 'mail' AND visible = 1",
    )
    .bind(account_id)
    .fetch_all(pool)
    .await
    .map_err(|e| e.to_string())?;
    Ok(rows.iter().map(row_to_folder).collect())
}

/// Return all visible mail folders across all accounts (caller groups by
/// account). Mirrors `getAllFolders` (`labels.ts:73-79`).
pub async fn get_all_folders(pool: &SqlitePool) -> Result<Vec<MailFolder>, String> {
    let rows = sqlx::query("SELECT * FROM labels WHERE mail_class = 'mail' AND visible = 1")
        .fetch_all(pool)
        .await
        .map_err(|e| e.to_string())?;
    Ok(rows.iter().map(row_to_folder).collect())
}

/// Find a special folder by canonical role for an account (e.g. the Inbox).
/// Mirrors `getFolderByRole` (`labels.ts:82-94`). Returns `None` if no row
/// matches. Note this does NOT filter on `visible = 1` (the TS source does
/// not either) so a hidden system folder can still be looked up by role.
pub async fn get_folder_by_role(
    pool: &SqlitePool,
    account_id: &str,
    role: &str,
) -> Result<Option<MailFolder>, String> {
    let row = sqlx::query(
        "SELECT * FROM labels
         WHERE account_id = ? AND role = ? AND mail_class = 'mail'
         LIMIT 1",
    )
    .bind(account_id)
    .bind(role)
    .fetch_optional(pool)
    .await
    .map_err(|e| e.to_string())?;
    Ok(row.as_ref().map(row_to_folder))
}

/// Unread thread counts per label for an account, computed live from
/// `thread_labels × threads`. Returns a map `{ label_id -> unread_count }`
/// which serializes to a JSON object matching the TS `Record<string, number>`
/// return of `getUnreadCountsByAccount` (`labels.ts:101-116`).
///
/// Accurate for all locally-synced data today; Graph and EAS sync may
/// additionally cache counts on the labels row (not used here).
pub async fn get_unread_counts_by_account(
    pool: &SqlitePool,
    account_id: &str,
) -> Result<HashMap<String, i64>, String> {
    let rows: Vec<(String, i64)> = sqlx::query_as(
        "SELECT tl.label_id AS id, COUNT(*) AS unread
         FROM thread_labels tl
         JOIN threads t ON t.account_id = tl.account_id AND t.id = tl.thread_id
         WHERE tl.account_id = ? AND t.is_read = 0
         GROUP BY tl.label_id",
    )
    .bind(account_id)
    .fetch_all(pool)
    .await
    .map_err(|e| e.to_string())?;

    Ok(rows.into_iter().collect())
}

/// Persist canonical folders (from any source adapter) into the `labels`
/// table. Deterministic ids mean re-syncs upsert in place. Counts
/// (`unread_count` / `total_count`) are intentionally NOT overwritten on
/// conflict — they are maintained by message sync / live queries. Mirrors
/// `upsertFolders` (`labels.ts:123-162`) including the 13-column INSERT and
/// the `ON CONFLICT(account_id, id) DO UPDATE SET ...` clause.
///
/// Runs every upsert in one transaction. Empty input is a no-op.
pub async fn upsert_folders(pool: &SqlitePool, folders: &[MailFolder]) -> Result<(), String> {
    if folders.is_empty() {
        return Ok(());
    }

    let mut tx = pool.begin().await.map_err(|e| format!("begin tx: {e}"))?;

    for f in folders {
        // `type` is derived: system when a role is set, else user. Matches
        // `f.role ? 'system' : 'user'` in the TS source.
        let type_ = if f.role.is_some() { "system" } else { "user" };
        let visible: i64 = if f.visible { 1 } else { 0 };

        sqlx::query(
            "INSERT INTO labels (
               id, account_id, name, type, visible, sort_order,
               source, role, parent_id, remote_id, delimiter, mail_class, hierarchical_name
             ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
             ON CONFLICT(account_id, id) DO UPDATE SET
               name = excluded.name,
               type = excluded.type,
               visible = excluded.visible,
               sort_order = excluded.sort_order,
               source = excluded.source,
               role = excluded.role,
               parent_id = excluded.parent_id,
               remote_id = excluded.remote_id,
               delimiter = excluded.delimiter,
               mail_class = excluded.mail_class,
               hierarchical_name = excluded.hierarchical_name",
        )
        .bind(&f.id)
        .bind(&f.account_id)
        .bind(&f.name)
        .bind(type_)
        .bind(visible)
        .bind(f.sort_order)
        .bind(&f.source)
        .bind(&f.role)
        .bind(&f.parent_id)
        .bind(&f.remote_id)
        .bind(&f.delimiter)
        .bind(&f.mail_class)
        .bind(&f.hierarchical_name)
        .execute(&mut *tx)
        .await
        .map_err(|e| e.to_string())?;
    }

    tx.commit().await.map_err(|e| e.to_string())?;
    Ok(())
}

/// Create a local (app-only) user folder. Server round-trip (EAS/IMAP
/// CREATE/RENAME/DELETE) is deferred; the inserted row is `source = 'local'`.
/// Appends after the account's current max `sort_order` so new folders land
/// last. Mirrors `createFolder` (`labels.ts:169-207`).
pub async fn create_folder(
    pool: &SqlitePool,
    account_id: &str,
    name: &str,
    parent_id: Option<&str>,
) -> Result<MailFolder, String> {
    let id = uuid::Uuid::new_v4().to_string();
    let remote_id = id.clone();

    // Append after the account's current max sort_order so new folders land
    // last. Matches `(max ?? -1) + 1` in the TS source.
    let row: (Option<i64>,) =
        sqlx::query_as("SELECT MAX(sort_order) AS m FROM labels WHERE account_id = ?")
            .bind(account_id)
            .fetch_one(pool)
            .await
            .map_err(|e| e.to_string())?;
    let sort_order = row.0.unwrap_or(-1) + 1;

    sqlx::query(
        "INSERT INTO labels (
           id, account_id, name, type, visible, sort_order,
           source, role, parent_id, remote_id, mail_class
         ) VALUES (?, ?, ?, 'user', 1, ?, 'local', NULL, ?, ?, 'mail')",
    )
    .bind(&id)
    .bind(account_id)
    .bind(name)
    .bind(sort_order)
    .bind(parent_id)
    .bind(&remote_id)
    .execute(pool)
    .await
    .map_err(|e| e.to_string())?;

    Ok(MailFolder {
        id,
        account_id: account_id.to_string(),
        source: "local".to_string(),
        role: None,
        name: name.to_string(),
        parent_id: parent_id.map(|s| s.to_string()),
        remote_id,
        delimiter: None,
        unread_count: 0,
        total_count: 0,
        sort_order,
        visible: true,
        hierarchical_name: None,
        mail_class: "mail".to_string(),
        type_: Some("user".to_string()),
        color_bg: None,
        color_fg: None,
        imap_folder_path: None,
        imap_special_use: None,
    })
}

/// Rename a user folder. (System folders are protected at the UI layer.)
/// Mirrors `renameFolder` (`labels.ts:210-221`).
pub async fn rename_folder(
    pool: &SqlitePool,
    account_id: &str,
    label_id: &str,
    new_name: &str,
) -> Result<(), String> {
    sqlx::query("UPDATE labels SET name = ? WHERE account_id = ? AND id = ?")
        .bind(new_name)
        .bind(account_id)
        .bind(label_id)
        .execute(pool)
        .await
        .map_err(|e| e.to_string())?;
    Ok(())
}

/// Delete a folder. `thread_labels` has no FK to `labels`, so its rows are
/// removed explicitly in the same transaction to avoid orphans. Child folders
/// are left in place — they resurface as top-level in the tree once their
/// parent is gone. Mirrors `deleteFolder` (`labels.ts:228-236`).
pub async fn delete_folder(
    pool: &SqlitePool,
    account_id: &str,
    label_id: &str,
) -> Result<(), String> {
    let mut tx = pool.begin().await.map_err(|e| format!("begin tx: {e}"))?;
    sqlx::query("DELETE FROM thread_labels WHERE account_id = ? AND label_id = ?")
        .bind(account_id)
        .bind(label_id)
        .execute(&mut *tx)
        .await
        .map_err(|e| e.to_string())?;
    sqlx::query("DELETE FROM labels WHERE account_id = ? AND id = ?")
        .bind(account_id)
        .bind(label_id)
        .execute(&mut *tx)
        .await
        .map_err(|e| e.to_string())?;
    tx.commit().await.map_err(|e| e.to_string())?;
    Ok(())
}

/// Delete labels for an account + source whose `remote_id` is NOT in
/// `keep_remote_ids`. Used after `list_folders` to remove labels that were
/// renamed or deleted on the server. Returns the number of labels deleted.
pub async fn prune_stale_labels(
    pool: &SqlitePool,
    account_id: &str,
    source: &str,
    keep_remote_ids: &HashSet<&str>,
) -> Result<u64, String> {
    let rows = sqlx::query(
        "SELECT id, remote_id FROM labels WHERE account_id = ? AND source = ? AND remote_id IS NOT NULL",
    )
    .bind(account_id)
    .bind(source)
    .fetch_all(pool)
    .await
    .map_err(|e| e.to_string())?;

    let mut deleted: u64 = 0;
    for row in &rows {
        let remote_id: String = row.try_get("remote_id").unwrap_or_default();
        if !keep_remote_ids.contains(remote_id.as_str()) {
            let id: String = row.try_get("id").unwrap_or_default();
            delete_folder(pool, account_id, &id).await?;
            log::info!("[labels] pruned stale label {id} (remote {remote_id})");
            deleted += 1;
        }
    }
    Ok(deleted)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Insert a bare account row directly, bypassing `accounts::create`, so
    /// label tests have a parent account_id without depending on the crypto
    /// keyring being available.
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

    /// Insert a thread + a thread_labels row to drive the unread-count query.
    async fn seed_thread_label(
        pool: &SqlitePool,
        account_id: &str,
        thread_id: &str,
        label_id: &str,
        is_read: bool,
    ) {
        sqlx::query(
            "INSERT INTO threads (id, account_id, is_read, last_message_at)
             VALUES (?, ?, ?, 0)",
        )
        .bind(thread_id)
        .bind(account_id)
        .bind(if is_read { 1 } else { 0 })
        .execute(pool)
        .await
        .unwrap();
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

    fn inbox(account_id: &str) -> MailFolder {
        MailFolder {
            id: "inbox".into(),
            account_id: account_id.into(),
            source: "imap".into(),
            role: Some("inbox".into()),
            name: "Inbox".into(),
            parent_id: None,
            remote_id: "INBOX".into(),
            delimiter: Some("/".into()),
            unread_count: 0,
            total_count: 0,
            sort_order: 0,
            visible: true,
            hierarchical_name: None,
            mail_class: "mail".into(),
            type_: None,
            color_bg: None,
            color_fg: None,
            imap_folder_path: None,
            imap_special_use: None,
        }
    }

    #[tokio::test]
    async fn upsert_then_get_folders_by_account_returns_them() {
        let tmp = tempfile::tempdir().unwrap();
        let pool = crate::db::init_db(tmp.path()).await.unwrap();
        seed_account(&pool, "acct-1").await;

        let folders = vec![
            inbox("acct-1"),
            MailFolder {
                id: "sent".into(),
                account_id: "acct-1".into(),
                source: "imap".into(),
                role: Some("sent".into()),
                name: "Sent".into(),
                sort_order: 1,
                ..inbox("acct-1")
            },
            // A hidden folder — should NOT come back from get_folders_by_account.
            MailFolder {
                id: "hidden".into(),
                account_id: "acct-1".into(),
                source: "imap".into(),
                role: None,
                name: "Hidden".into(),
                visible: false,
                sort_order: 2,
                ..inbox("acct-1")
            },
            // A non-mail class — should NOT come back either.
            MailFolder {
                id: "cal".into(),
                account_id: "acct-1".into(),
                source: "eas".into(),
                role: None,
                name: "Calendar".into(),
                mail_class: "calendar".into(),
                sort_order: 3,
                ..inbox("acct-1")
            },
        ];
        upsert_folders(&pool, &folders).await.unwrap();

        let got = get_folders_by_account(&pool, "acct-1").await.unwrap();
        let mut ids: Vec<&str> = got.iter().map(|f| f.id.as_str()).collect();
        ids.sort();
        assert_eq!(ids, vec!["inbox", "sent"]);
    }

    #[tokio::test]
    async fn upsert_is_idempotent_and_does_not_touch_counts() {
        let tmp = tempfile::tempdir().unwrap();
        let pool = crate::db::init_db(tmp.path()).await.unwrap();
        seed_account(&pool, "acct-1").await;

        upsert_folders(&pool, &[inbox("acct-1")]).await.unwrap();

        // Simulate a sync engine bumping the unread_count directly.
        sqlx::query(
            "UPDATE labels SET unread_count = 5, total_count = 10 WHERE account_id = ? AND id = ?",
        )
        .bind("acct-1")
        .bind("inbox")
        .execute(&pool)
        .await
        .unwrap();

        // Re-upsert the same folder (e.g. on a re-sync). Counts must survive.
        upsert_folders(&pool, &[inbox("acct-1")]).await.unwrap();

        let got = get_folders_by_account(&pool, "acct-1")
            .await
            .unwrap()
            .into_iter()
            .find(|f| f.id == "inbox")
            .unwrap();
        assert_eq!(got.unread_count, 5, "unread_count must not be overwritten");
        assert_eq!(got.total_count, 10, "total_count must not be overwritten");
    }

    #[tokio::test]
    async fn upsert_updates_name_and_role_on_conflict() {
        let tmp = tempfile::tempdir().unwrap();
        let pool = crate::db::init_db(tmp.path()).await.unwrap();
        seed_account(&pool, "acct-1").await;

        upsert_folders(&pool, &[inbox("acct-1")]).await.unwrap();

        // Same id, different name + role.
        let renamed = MailFolder {
            name: "Inbox Renamed".into(),
            role: Some("archive".into()),
            ..inbox("acct-1")
        };
        upsert_folders(&pool, &[renamed]).await.unwrap();

        let got = get_folder_by_role(&pool, "acct-1", "archive")
            .await
            .unwrap()
            .unwrap();
        assert_eq!(got.id, "inbox");
        assert_eq!(got.name, "Inbox Renamed");
        assert_eq!(got.role.as_deref(), Some("archive"));
    }

    #[tokio::test]
    async fn upsert_empty_input_is_noop() {
        let tmp = tempfile::tempdir().unwrap();
        let pool = crate::db::init_db(tmp.path()).await.unwrap();
        // Must not error and must not open a useless transaction.
        upsert_folders(&pool, &[]).await.unwrap();
        let got = get_all_folders(&pool).await.unwrap();
        assert!(got.is_empty());
    }

    #[tokio::test]
    async fn get_folder_by_role_returns_none_when_absent() {
        let tmp = tempfile::tempdir().unwrap();
        let pool = crate::db::init_db(tmp.path()).await.unwrap();
        seed_account(&pool, "acct-1").await;
        assert!(get_folder_by_role(&pool, "acct-1", "inbox")
            .await
            .unwrap()
            .is_none());
    }

    #[tokio::test]
    async fn get_all_folders_spans_accounts() {
        let tmp = tempfile::tempdir().unwrap();
        let pool = crate::db::init_db(tmp.path()).await.unwrap();
        seed_account(&pool, "a1").await;
        seed_account(&pool, "a2").await;
        upsert_folders(&pool, &[inbox("a1")]).await.unwrap();
        upsert_folders(
            &pool,
            &[MailFolder {
                id: "inbox".into(),
                account_id: "a2".into(),
                ..inbox("a2")
            }],
        )
        .await
        .unwrap();

        let all = get_all_folders(&pool).await.unwrap();
        assert_eq!(all.len(), 2);
        let accounts: Vec<&str> = all.iter().map(|f| f.account_id.as_str()).collect();
        assert!(accounts.contains(&"a1"));
        assert!(accounts.contains(&"a2"));
    }

    #[tokio::test]
    async fn unread_counts_join_threads_and_thread_labels() {
        let tmp = tempfile::tempdir().unwrap();
        let pool = crate::db::init_db(tmp.path()).await.unwrap();
        seed_account(&pool, "acct-1").await;

        // Two unread threads on `inbox`, one read thread on `inbox`, one
        // unread thread on `sent`.
        seed_thread_label(&pool, "acct-1", "t1", "inbox", false).await;
        seed_thread_label(&pool, "acct-1", "t2", "inbox", false).await;
        seed_thread_label(&pool, "acct-1", "t3", "inbox", true).await;
        seed_thread_label(&pool, "acct-1", "t4", "sent", false).await;

        let counts = get_unread_counts_by_account(&pool, "acct-1").await.unwrap();
        assert_eq!(counts.get("inbox").copied(), Some(2), "inbox unread");
        assert_eq!(counts.get("sent").copied(), Some(1), "sent unread");
        // Read thread must not be counted.
        assert!(!counts.contains_key("t3"));
    }

    #[tokio::test]
    async fn unread_counts_empty_when_no_threads() {
        let tmp = tempfile::tempdir().unwrap();
        let pool = crate::db::init_db(tmp.path()).await.unwrap();
        seed_account(&pool, "acct-1").await;
        let counts = get_unread_counts_by_account(&pool, "acct-1").await.unwrap();
        assert!(counts.is_empty());
    }

    #[tokio::test]
    async fn create_folder_appends_after_max_sort_order() {
        let tmp = tempfile::tempdir().unwrap();
        let pool = crate::db::init_db(tmp.path()).await.unwrap();
        seed_account(&pool, "acct-1").await;

        // Seed two folders with sort_order 0 and 5.
        upsert_folders(
            &pool,
            &[
                MailFolder {
                    sort_order: 0,
                    ..inbox("acct-1")
                },
                MailFolder {
                    id: "f5".into(),
                    sort_order: 5,
                    ..inbox("acct-1")
                },
            ],
        )
        .await
        .unwrap();

        let created = create_folder(&pool, "acct-1", "New Folder", None)
            .await
            .unwrap();
        assert_eq!(created.sort_order, 6, "should be max(0,5)+1");
        assert_eq!(created.source, "local");
        assert_eq!(created.mail_class, "mail");
        assert!(created.visible);
        assert!(created.role.is_none());
        assert_eq!(created.parent_id, None);
        // remoteId falls back to id.
        assert_eq!(created.remote_id, created.id);

        // Row is persisted.
        let by_id = sqlx::query_as::<_, (String, i64, String)>(
            "SELECT name, sort_order, source FROM labels WHERE account_id = ? AND id = ?",
        )
        .bind("acct-1")
        .bind(&created.id)
        .fetch_one(&pool)
        .await
        .unwrap();
        assert_eq!(by_id.0, "New Folder");
        assert_eq!(by_id.1, 6);
        assert_eq!(by_id.2, "local");
    }

    #[tokio::test]
    async fn create_folder_with_no_existing_rows_starts_at_zero() {
        let tmp = tempfile::tempdir().unwrap();
        let pool = crate::db::init_db(tmp.path()).await.unwrap();
        seed_account(&pool, "acct-1").await;

        let created = create_folder(&pool, "acct-1", "First", None).await.unwrap();
        // MAX(sort_order) is NULL → (NULL ?? -1) + 1 = 0.
        assert_eq!(created.sort_order, 0);
    }

    #[tokio::test]
    async fn rename_folder_updates_name_only() {
        let tmp = tempfile::tempdir().unwrap();
        let pool = crate::db::init_db(tmp.path()).await.unwrap();
        seed_account(&pool, "acct-1").await;
        upsert_folders(&pool, &[inbox("acct-1")]).await.unwrap();

        rename_folder(&pool, "acct-1", "inbox", "Boîte de réception")
            .await
            .unwrap();

        let got = get_folder_by_role(&pool, "acct-1", "inbox")
            .await
            .unwrap()
            .unwrap();
        assert_eq!(got.name, "Boîte de réception");
    }

    #[tokio::test]
    async fn delete_folder_removes_orphan_thread_labels_in_one_tx() {
        let tmp = tempfile::tempdir().unwrap();
        let pool = crate::db::init_db(tmp.path()).await.unwrap();
        seed_account(&pool, "acct-1").await;
        upsert_folders(&pool, &[inbox("acct-1")]).await.unwrap();
        seed_thread_label(&pool, "acct-1", "t1", "inbox", false).await;

        // Sanity: the thread_labels row exists.
        let (cnt,): (i64,) = sqlx::query_as(
            "SELECT COUNT(*) FROM thread_labels WHERE account_id = ? AND label_id = ?",
        )
        .bind("acct-1")
        .bind("inbox")
        .fetch_one(&pool)
        .await
        .unwrap();
        assert_eq!(cnt, 1);

        delete_folder(&pool, "acct-1", "inbox").await.unwrap();

        // Folder gone.
        assert!(get_folder_by_role(&pool, "acct-1", "inbox")
            .await
            .unwrap()
            .is_none());
        // thread_labels orphans gone too.
        let (cnt,): (i64,) = sqlx::query_as(
            "SELECT COUNT(*) FROM thread_labels WHERE account_id = ? AND label_id = ?",
        )
        .bind("acct-1")
        .bind("inbox")
        .fetch_one(&pool)
        .await
        .unwrap();
        assert_eq!(cnt, 0);
    }

    #[tokio::test]
    async fn row_to_folder_applies_ts_defaults() {
        // Hand-plant a row with NULLs on every nullable column to confirm the
        // defaults from `rowToFolder` (`?? 'local'`, `?? row.id`, `?? 0`,
        // `visible === 1`, `?? 'mail'`) all fire. We bypass the public getters
        // (which filter on `visible = 1` and `mail_class = 'mail'`) and read
        // the row directly via `row_to_folder`.
        //
        // `source` is NOT NULL in the schema (DEFAULT 'local'), so we omit it
        // from the INSERT to exercise the default. `mail_class` is also NOT
        // NULL with DEFAULT 'mail', so we omit it too. Other columns
        // (remote_id, parent_id, delimiter, etc.) are nullable.
        let tmp = tempfile::tempdir().unwrap();
        let pool = crate::db::init_db(tmp.path()).await.unwrap();
        seed_account(&pool, "acct-1").await;
        sqlx::query(
            "INSERT INTO labels (id, account_id, name, type)
             VALUES ('f', 'acct-1', 'F', 'user')",
        )
        .execute(&pool)
        .await
        .unwrap();

        let row = sqlx::query("SELECT * FROM labels WHERE account_id = ? AND id = ?")
            .bind("acct-1")
            .bind("f")
            .fetch_one(&pool)
            .await
            .unwrap();
        let f = row_to_folder(&row);
        // source schema default → 'local'.
        assert_eq!(f.source, "local");
        // NULL remote_id → falls back to id.
        assert_eq!(f.remote_id, "f");
        assert_eq!(f.unread_count, 0);
        assert_eq!(f.total_count, 0);
        assert_eq!(f.sort_order, 0);
        // visible schema default = 1 → true.
        assert!(f.visible);
        // mail_class schema default → 'mail'.
        assert_eq!(f.mail_class, "mail");
    }

    #[tokio::test]
    async fn row_to_folder_visible_default_via_schema_is_true() {
        // Clean version of the visible-default check: INSERT without specifying
        // visible, confirm schema default (1) reads back as visible=true.
        let tmp = tempfile::tempdir().unwrap();
        let pool = crate::db::init_db(tmp.path()).await.unwrap();
        seed_account(&pool, "acct-1").await;
        sqlx::query(
            "INSERT INTO labels (id, account_id, name, type, source, mail_class)
             VALUES ('f', 'acct-1', 'F', 'user', 'local', 'mail')",
        )
        .execute(&pool)
        .await
        .unwrap();
        let got = get_all_folders(&pool).await.unwrap();
        assert_eq!(got.len(), 1);
        assert!(got[0].visible, "schema default visible=1 → true");
    }

    #[tokio::test]
    async fn mail_folder_serializes_to_camel_case_json() {
        // Fixture with non-None values on the optional fields so we can assert
        // they appear in JSON. None-valued optionals are checked separately.
        let folder = MailFolder {
            id: "inbox".into(),
            account_id: "a1".into(),
            source: "imap".into(),
            role: Some("inbox".into()),
            name: "Inbox".into(),
            parent_id: Some("parent".into()),
            remote_id: "INBOX".into(),
            delimiter: Some("/".into()),
            unread_count: 3,
            total_count: 10,
            sort_order: 0,
            visible: true,
            hierarchical_name: Some("a/Inbox".into()),
            mail_class: "mail".into(),
            type_: Some("system".into()),
            color_bg: Some("#fff".into()),
            color_fg: None,
            imap_folder_path: None,
            imap_special_use: None,
        };
        let json = serde_json::to_value(&folder).unwrap();
        let obj = json.as_object().unwrap();
        // Spot-check the load-bearing camelCase keys from the TS interface
        // (all present because the fixture sets them).
        for key in [
            "id",
            "accountId",
            "source",
            "role",
            "name",
            "parentId",
            "remoteId",
            "delimiter",
            "unreadCount",
            "totalCount",
            "sortOrder",
            "visible",
            "hierarchicalName",
            "mailClass",
            "type",
            "colorBg",
        ] {
            assert!(obj.contains_key(key), "expected camelCase key {key}");
        }
        // snake_case must NOT leak.
        for key in [
            "account_id",
            "parent_id",
            "remote_id",
            "unread_count",
            "total_count",
            "sort_order",
            "hierarchical_name",
            "mail_class",
            "color_bg",
            "color_fg",
            "imap_folder_path",
            "imap_special_use",
            "type_",
        ] {
            assert!(!obj.contains_key(key), "snake_case key {key} leaked");
        }
        // None-valued optional fields should be skipped.
        assert!(!obj.contains_key("colorFg"));
        assert!(!obj.contains_key("imapFolderPath"));
        assert!(!obj.contains_key("imapSpecialUse"));
    }
}
