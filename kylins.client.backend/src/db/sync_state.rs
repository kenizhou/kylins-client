// Per-folder delta-sync cursors. Rust owns these (the legacy frontend tables
// `folder_sync_state` and `eas_sync_state` were dead schema before Phase 0; Task 8
// resurrects them as the engine's cache key).
//
// Invariants:
//   * IMAP `last_uid` advances MONOTONICALLY within a fixed UIDVALIDITY (a lagging sync
//     round can never regress the cursor). On UIDVALIDITY change the cursor is RESET
//     (cache key changed) rather than MAX-merged.
//   * EAS `sync_key` is an opaque server-issued token that changes every sync, so it is
//     overwritten (not merged) — there is no monotonic concept.

use sqlx::SqlitePool;

use crate::sync_engine::Cursor;

// --------------------------- IMAP (folder_sync_state) ---------------------------

/// Read the stored IMAP cursor for a folder, or `initial_imap()` (uidvalidity 0) if none.
pub async fn get_imap_cursor(pool: &SqlitePool, account_id: &str, folder_path: &str) -> Cursor {
    type ImapCursorRow = (Option<i64>, Option<i64>, Option<i64>);
    let row = sqlx::query_as::<_, ImapCursorRow>(
        "SELECT uidvalidity, last_uid, modseq FROM folder_sync_state WHERE account_id = ? AND folder_path = ?",
    )
    .bind(account_id)
    .bind(folder_path)
    .fetch_optional(pool)
    .await;

    match row {
        Ok(Some((uv, last_uid, modseq))) => Cursor::Imap {
            uidvalidity: uv.unwrap_or(0) as u32,
            highest_uid: last_uid.unwrap_or(0) as u32,
            highest_modseq: modseq.unwrap_or(0) as u64,
        },
        _ => Cursor::initial_imap(),
    }
}

/// Advance the IMAP cursor. Monotonic on `last_uid` while UIDVALIDITY is unchanged; a
/// UIDVALIDITY change (or first insert) writes the fresh values verbatim.
pub async fn advance_imap_cursor(
    pool: &SqlitePool,
    account_id: &str,
    folder_path: &str,
    new_uidvalidity: u32,
    new_highest_uid: u32,
    new_modseq: u64,
) -> Result<(), String> {
    sqlx::query(
        "INSERT INTO folder_sync_state (account_id, folder_path, uidvalidity, last_uid, modseq, last_sync_at)
         VALUES (?, ?, ?, ?, ?, unixepoch())
         ON CONFLICT(account_id, folder_path) DO UPDATE SET
           uidvalidity = excluded.uidvalidity,
           last_uid = CASE WHEN folder_sync_state.uidvalidity = excluded.uidvalidity
                           THEN MAX(excluded.last_uid, folder_sync_state.last_uid)
                           ELSE excluded.last_uid END,
           modseq = CASE WHEN folder_sync_state.uidvalidity = excluded.uidvalidity
                         THEN MAX(excluded.modseq, folder_sync_state.modseq)
                         ELSE excluded.modseq END,
           last_sync_at = excluded.last_sync_at",
    )
    .bind(account_id)
    .bind(folder_path)
    .bind(new_uidvalidity as i64)
    .bind(new_highest_uid as i64)
    .bind(new_modseq as i64)
    .execute(pool)
    .await
    .map_err(|e| e.to_string())?;
    Ok(())
}

// ----------------------------- EAS (eas_sync_state) ----------------------------

/// Read the stored EAS cursor (collection_id + sync_key) for a folder, or an initial
/// (sync_key "0" = full) cursor.
pub async fn get_eas_cursor(pool: &SqlitePool, account_id: &str, folder_id: &str) -> Cursor {
    let row: Result<Option<(Option<String>, Option<String>)>, _> = sqlx::query_as(
        "SELECT collection_id, sync_key FROM eas_sync_state WHERE account_id = ? AND folder_id = ?",
    )
    .bind(account_id)
    .bind(folder_id)
    .fetch_optional(pool)
    .await;

    match row {
        Ok(Some((cid, sk))) => Cursor::Eas {
            collection_id: cid.unwrap_or_default(),
            sync_key: sk.unwrap_or_else(|| "0".to_string()),
        },
        _ => Cursor::initial_eas(folder_id),
    }
}

/// Persist the latest EAS sync_key (opaque token — overwrite, no merge).
pub async fn advance_eas_cursor(
    pool: &SqlitePool,
    account_id: &str,
    folder_id: &str,
    collection_id: &str,
    sync_key: &str,
) -> Result<(), String> {
    sqlx::query(
        "INSERT INTO eas_sync_state (account_id, folder_id, collection_id, sync_key, last_sync_at)
         VALUES (?, ?, ?, ?, unixepoch())
         ON CONFLICT(account_id, folder_id) DO UPDATE SET
           collection_id = excluded.collection_id,
           sync_key = excluded.sync_key,
           last_sync_at = excluded.last_sync_at",
    )
    .bind(account_id)
    .bind(folder_id)
    .bind(collection_id)
    .bind(sync_key)
    .execute(pool)
    .await
    .map_err(|e| e.to_string())?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::init_db;

    async fn seed(pool: &sqlx::SqlitePool, id: &str) {
        sqlx::query("INSERT INTO accounts (id, email, provider) VALUES (?, ?, 'imap')")
            .bind(id)
            .bind(format!("{id}@x.com"))
            .execute(pool)
            .await
            .unwrap();
    }

    #[tokio::test]
    async fn imap_cursor_roundtrips_and_advances_monotonically() {
        let tmp = tempfile::tempdir().unwrap();
        let pool = init_db(tmp.path()).await.unwrap();
        seed(&pool, "a").await;
        assert_eq!(
            get_imap_cursor(&pool, "a", "INBOX").await,
            Cursor::initial_imap()
        );
        advance_imap_cursor(&pool, "a", "INBOX", 100, 5, 1)
            .await
            .unwrap();
        let c = get_imap_cursor(&pool, "a", "INBOX").await;
        assert_eq!(
            c,
            Cursor::Imap {
                uidvalidity: 100,
                highest_uid: 5,
                highest_modseq: 1
            }
        );
        // Lower high (lagging sync) does NOT regress (monotonic).
        advance_imap_cursor(&pool, "a", "INBOX", 100, 3, 1)
            .await
            .unwrap();
        assert_eq!(
            get_imap_cursor(&pool, "a", "INBOX").await,
            Cursor::Imap {
                uidvalidity: 100,
                highest_uid: 5,
                highest_modseq: 1
            }
        );
        // Higher high advances.
        advance_imap_cursor(&pool, "a", "INBOX", 100, 9, 2)
            .await
            .unwrap();
        assert_eq!(
            get_imap_cursor(&pool, "a", "INBOX").await,
            Cursor::Imap {
                uidvalidity: 100,
                highest_uid: 9,
                highest_modseq: 2
            }
        );
    }

    #[tokio::test]
    async fn imap_cursor_modseq_advances_monotonically() {
        let tmp = tempfile::tempdir().unwrap();
        let pool = init_db(tmp.path()).await.unwrap();
        seed(&pool, "a").await;
        advance_imap_cursor(&pool, "a", "INBOX", 100, 5, 50)
            .await
            .unwrap();
        // A lagging round reports modseq 30 — must NOT regress to 30.
        advance_imap_cursor(&pool, "a", "INBOX", 100, 5, 30)
            .await
            .unwrap();
        let c = get_imap_cursor(&pool, "a", "INBOX").await;
        assert_eq!(
            c,
            Cursor::Imap {
                uidvalidity: 100,
                highest_uid: 5,
                highest_modseq: 50
            }
        );
        // A newer modseq advances.
        advance_imap_cursor(&pool, "a", "INBOX", 100, 8, 90)
            .await
            .unwrap();
        assert_eq!(
            get_imap_cursor(&pool, "a", "INBOX").await,
            Cursor::Imap {
                uidvalidity: 100,
                highest_uid: 8,
                highest_modseq: 90
            }
        );
    }

    #[tokio::test]
    async fn imap_cursor_resets_on_uidvalidity_change() {
        let tmp = tempfile::tempdir().unwrap();
        let pool = init_db(tmp.path()).await.unwrap();
        seed(&pool, "a").await;
        advance_imap_cursor(&pool, "a", "INBOX", 100, 50, 1)
            .await
            .unwrap();
        // UIDVALIDITY change -> CASE takes ELSE branch, writes excluded last_uid verbatim.
        advance_imap_cursor(&pool, "a", "INBOX", 200, 2, 0)
            .await
            .unwrap();
        assert_eq!(
            get_imap_cursor(&pool, "a", "INBOX").await,
            Cursor::Imap {
                uidvalidity: 200,
                highest_uid: 2,
                highest_modseq: 0
            }
        );
    }

    #[tokio::test]
    async fn eas_cursor_roundtrips_sync_key() {
        let tmp = tempfile::tempdir().unwrap();
        let pool = init_db(tmp.path()).await.unwrap();
        seed(&pool, "a").await;
        assert_eq!(
            get_eas_cursor(&pool, "a", "f1").await,
            Cursor::Eas {
                collection_id: "f1".into(),
                sync_key: "0".into()
            }
        );
        advance_eas_cursor(&pool, "a", "f1", "col1", "{abc}")
            .await
            .unwrap();
        assert_eq!(
            get_eas_cursor(&pool, "a", "f1").await,
            Cursor::Eas {
                collection_id: "col1".into(),
                sync_key: "{abc}".into()
            }
        );
        // Overwrites (no merge).
        advance_eas_cursor(&pool, "a", "f1", "col1", "{def}")
            .await
            .unwrap();
        assert_eq!(
            get_eas_cursor(&pool, "a", "f1").await,
            Cursor::Eas {
                collection_id: "col1".into(),
                sync_key: "{def}".into()
            }
        );
    }
}
