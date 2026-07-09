//! Filesystem cache for received attachment bytes.
//!
//! Completes the symmetry with T7b (send path): received attachments are
//! cached as **files** under `<appData>/attachment-cache/` so base64 never
//! crosses IPC. The first `sync_fetch_attachment` call fetches the part from
//! IMAP, writes the decoded bytes to a cache file, and returns the path;
//! subsequent calls return the path immediately (no network).
//!
//! Layout (sharded for scalability, per-message for trivial cleanup):
//! ```text
//! <appData>/attachment-cache/
//!   {account_id}/
//!     {message_id[..2]}/                         ← 1-level hex shard (~256 buckets)
//!       {message_id}/
//!         {attachment_id}_{safe_filename}         ← collision-proof, debuggable
//! ```
//!
//! See `docs/superpowers/specs/2026-07-04-attachment-cache-design.md` for the
//! full design (research: Thunderbird lazy + Mailspring sharding).

use std::path::{Path, PathBuf};

use serde::Serialize;

use crate::commands::sanitize_attachment_filename;

/// The cached attachment returned to the frontend — a file path, not base64.
/// `filePath` is the absolute path to the cached file under `<appData>/`;
/// the frontend `copyFile`s it (forward) or `copy_cached_attachment`s it
/// (download to an arbitrary save location).
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CachedAttachment {
    pub file_path: String,
    pub filename: String,
    pub mime_type: String,
    pub size: i64,
}

/// One cached inline `cid:` image returned by `sync_fetch_inline_images` — a
/// file path (served via `convertFileSrc` in the reading pane), not base64 over
/// IPC. The frontend builds its `cid → URL` map with `convertFileSrc(file_path)`.
/// `size` is the decoded byte count of the cached file.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CachedInlineImage {
    pub content_id: String,
    pub file_path: String,
    pub mime_type: String,
    pub size: u64,
}

/// Compute the cache directory for a message (all its attachments live here).
/// `<cache_root>/{account_id}/{message_id[..2]}/{message_id}/`
///
/// The `message_id[..2]` shard prevents flat directories at scale (~256
/// buckets instead of one dir with 50K entries for a large account). The
/// per-message grouping makes cleanup on delete trivial (`rm -rf`).
pub fn message_cache_dir(
    cache_root: &Path,
    account_id: &str,
    message_id: &str,
) -> PathBuf {
    // Sanitize account_id/message_id defensively — both are typically UUIDs but
    // could contain unexpected chars if a future provider assigns them differently.
    let safe_account = sanitize_path_segment(account_id);
    let safe_message = sanitize_path_segment(message_id);
    let shard = safe_message.get(..2).unwrap_or(&safe_message);
    cache_root
        .join(&safe_account)
        .join(shard)
        .join(&safe_message)
}

/// Compute the full path for a cached attachment file.
/// `.../{message_id}/{attachment_id}_{safe_filename}`
///
/// The `attachment_id` prefix prevents collisions when two attachments in the
/// same message share a filename (e.g., two `screenshot.png`). The id is
/// `{account_id}_{message_id}_{part_id}` (composite, unique per part).
pub fn cache_file_path(
    cache_root: &Path,
    account_id: &str,
    message_id: &str,
    attachment_id: &str,
    filename: &str,
) -> PathBuf {
    let dir = message_cache_dir(cache_root, account_id, message_id);
    let safe_name = sanitize_attachment_filename(filename);
    let safe_id = sanitize_path_segment(attachment_id);
    dir.join(format!("{safe_id}_{safe_name}"))
}

/// Verify a resolved path stays within the cache root (defense-in-depth
/// against symlink/path-traversal escapes). Uses `canonicalize` so symlinks
/// are resolved before the prefix check. Returns `false` if canonicalization
/// fails (the path doesn't exist yet) — the caller should treat that as
/// "not within cache" and refuse to serve it.
pub fn path_is_within_cache(path: &Path, cache_root: &Path) -> bool {
    let Ok(canonical_path) = path.canonicalize() else {
        return false;
    };
    let Ok(canonical_root) = cache_root.canonicalize() else {
        return false;
    };
    canonical_path.starts_with(&canonical_root)
}

/// Write decoded attachment bytes to the cache file, creating parent dirs.
/// Returns the byte count (for `cache_size`). Best-effort atomicity: the file
/// is written directly to its final path; a crash mid-write leaves a partial
/// file that the next `sync_fetch_attachment` will overwrite on the next miss
/// (the existence check passes but the file is corrupt — a future hardening
/// could write to a `.tmp` and rename, but the current path matches T7b's
/// `stage_picked_attachment` approach).
pub fn write_cache_file(path: &Path, bytes: &[u8]) -> Result<u64, String> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| format!("failed to create cache dir {parent:?}: {e}"))?;
    }
    std::fs::write(path, bytes)
        .map_err(|e| format!("failed to write cache file {path:?}: {e}"))?;
    Ok(bytes.len() as u64)
}

/// Stats returned by [`reconcile_cache`]. Serializes to camelCase for the
/// Tauri command return so the frontend can destructure the fields directly.
#[derive(Debug, Clone, Default, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReconcileStats {
    /// Per-message cache directories removed (the level-3 `{message_id}` dirs
    /// whose `messages` row is gone). This is the primary "orphan bytes freed"
    /// signal — each one typically holds one or more cached attachment files.
    pub orphan_dirs_removed: u32,
    /// Individual cache files counted inside the removed orphan dirs
    /// (informational — surfaces the actual file count, not just dir count,
    /// so a "reclaimed 1 dir / 47 files" line in the cache UI is meaningful).
    pub orphan_files_removed: u32,
    /// `attachments.local_path` values NULLed because the file they pointed
    /// at no longer exists on disk (the message row is still alive — only the
    /// cache pointer is stale; a future fetch will re-cache).
    pub stale_paths_cleared: u32,
}

/// Walk the attachment cache directory and remove orphan entries (message
/// dirs whose `messages` row is gone), then NULL out `attachments.local_path`
/// values that point at files no longer on disk. Returns stats about what
/// was cleaned up.
///
/// **Layout walked:** `{cache_root}/{account_id}/{shard}/{message_id}/`. The
/// `{shard}` level is the first 2 chars of `message_id` (see
/// [`message_cache_dir`]); it is walked as-is without validating the shard
/// matches the message_id prefix — the level-3 dir name is the source of
/// truth for the message_id, so a manually-moved dir still reconciles.
///
/// **When to run:** startup backstop (Task D2) + explicit "clear cache" /
/// "reconcile" UI action. Not on any hot path — the walk is sync I/O.
///
/// **Best-effort:** per-dir errors (unreadable, race with writer) are logged
/// and skipped so one bad entry never aborts the whole pass. Idempotent: a
/// second run with no changes returns `Default::default()`.
///
/// **Two independent passes:**
/// 1. **Dir walk:** for each `{message_id}` dir, check `messages` by
///    `(account_id, id)`. No row → `remove_dir_all` + bump counters.
/// 2. **Stale-pointer scan:** for each `attachments.local_path` that does not
///    exist on disk, NULL it (plus `cached_at`, `cache_size`). This catches
///    the case where the file vanished but the message row is alive (e.g.
///    user manually deleted cache files, or a different account's cache was
///    wiped). Runs even if pass 1 found nothing.
pub async fn reconcile_cache(
    cache_root: &Path,
    pool: &sqlx::SqlitePool,
) -> Result<ReconcileStats, String> {
    let mut stats = ReconcileStats::default();

    // Pass 1: walk the on-disk tree and remove orphan message dirs.
    // The cache_root may not exist yet on a fresh install (no attachment ever
    // fetched) — that's the empty-stats short-circuit.
    if cache_root.exists() {
        walk_and_remove_orphans(cache_root, pool, &mut stats).await?;
    }

    // Pass 2: NULL stale local_path values. Independent of the dir walk —
    // a file can vanish while the message row persists (external deletion,
    // partial cleanup after a crash). Runs unconditionally so the cache
    // pointer converges to truth even when no orphans were found.
    clear_stale_local_paths(pool, &mut stats).await?;

    Ok(stats)
}

/// Pass 1 of [`reconcile_cache`]: walk `{cache_root}/{account}/{shard}/{msg}/`
/// and `remove_dir_all` every `msg` dir whose `(account, msg)` has no row in
/// `messages`. Per-dir FS errors are logged and skipped; the DB query error
/// aborts the whole pass (surfaced to the caller).
async fn walk_and_remove_orphans(
    cache_root: &Path,
    pool: &sqlx::SqlitePool,
    stats: &mut ReconcileStats,
) -> Result<(), String> {
    let account_dirs = match std::fs::read_dir(cache_root) {
        Ok(it) => it,
        Err(e) => {
            log::warn!(
                "[attachment-cache] reconcile: read cache_root {cache_root:?} failed: {e}"
            );
            return Ok(());
        }
    };

    for account_entry in account_dirs.flatten() {
        let account_path = account_entry.path();
        if !account_path.is_dir() {
            continue;
        }
        // account_id is the raw dir-name segment — exactly what
        // `message_cache_dir` wrote. We do NOT canonicalize: the path's
        // existence IS the source of truth, and canonicalizing would resolve
        // symlinks in unexpected ways on some platforms.
        let account_id = match account_path.file_name().and_then(|n| n.to_str()) {
            Some(s) => s.to_owned(),
            None => continue,
        };

        let shard_dirs = match std::fs::read_dir(&account_path) {
            Ok(it) => it,
            Err(e) => {
                log::warn!(
                    "[attachment-cache] reconcile: read account dir {account_path:?} failed: {e}"
                );
                continue;
            }
        };

        for shard_entry in shard_dirs.flatten() {
            let shard_path = shard_entry.path();
            if !shard_path.is_dir() {
                continue;
            }
            let message_dirs = match std::fs::read_dir(&shard_path) {
                Ok(it) => it,
                Err(e) => {
                    log::warn!(
                        "[attachment-cache] reconcile: read shard dir {shard_path:?} failed: {e}"
                    );
                    continue;
                }
            };

            for msg_entry in message_dirs.flatten() {
                let msg_path = msg_entry.path();
                if !msg_path.is_dir() {
                    continue;
                }
                let message_id = match msg_path.file_name().and_then(|n| n.to_str()) {
                    Some(s) => s.to_owned(),
                    None => continue,
                };

                // Existence check: one indexed SELECT (PK on
                // messages(account_id, id)). Cheap relative to the FS walk.
                let exists: Option<(i64,)> =
                    sqlx::query_as("SELECT 1 FROM messages WHERE account_id = ? AND id = ?")
                        .bind(&account_id)
                        .bind(&message_id)
                        .fetch_optional(pool)
                        .await
                        .map_err(|e| {
                            format!("reconcile: check message {account_id}/{message_id}: {e}")
                        })?;

                if exists.is_some() {
                    continue;
                }

                // Orphan: count files first (for stats), then remove the dir.
                let file_count = count_files_in_dir(&msg_path);
                match std::fs::remove_dir_all(&msg_path) {
                    Ok(()) => {
                        stats.orphan_dirs_removed += 1;
                        stats.orphan_files_removed += file_count;
                        log::info!(
                            "[attachment-cache] reconcile: removed orphan cache dir \
                             {account_id}/{message_id} ({file_count} files)"
                        );
                    }
                    Err(e) => log::warn!(
                        "[attachment-cache] reconcile: remove orphan dir {msg_path:?} failed: {e}"
                    ),
                }
            }
        }
    }

    Ok(())
}

/// Pass 2 of [`reconcile_cache`]: NULL `attachments.local_path` (plus
/// `cached_at`, `cache_size`) for rows whose file no longer exists on disk.
/// Best-effort: per-row errors are logged and skipped so one bad row never
/// aborts the pass.
async fn clear_stale_local_paths(
    pool: &sqlx::SqlitePool,
    stats: &mut ReconcileStats,
) -> Result<(), String> {
    // Load every non-null local_path in one query (the attachments table is
    // small relative to messages — at most a few rows per message). For each,
    // a `Path::exists()` check; missing → UPDATE to NULL. A single aggregated
    // "WHERE local_path NOT IN (...)" would avoid per-row UPDATEs but breaks
    // on paths with special chars and is harder to read; the per-row path is
    // clear and correct.
    let rows: Vec<(String,)> = match sqlx::query_as(
        "SELECT local_path FROM attachments WHERE local_path IS NOT NULL",
    )
    .fetch_all(pool)
    .await
    {
        Ok(r) => r,
        Err(e) => {
            log::warn!("[attachment-cache] reconcile: list local_path failed: {e}");
            // Not fatal — pass 1 already did its job. Return Ok so the
            // caller sees the partial stats.
            return Ok(());
        }
    };

    for (local_path,) in rows {
        if Path::new(&local_path).exists() {
            continue;
        }
        match sqlx::query(
            "UPDATE attachments SET local_path = NULL, cached_at = NULL, cache_size = NULL \
             WHERE local_path = ?",
        )
        .bind(&local_path)
        .execute(pool)
        .await
        {
            Ok(r) => stats.stale_paths_cleared += r.rows_affected() as u32,
            Err(e) => log::warn!(
                "[attachment-cache] reconcile: clear stale local_path {local_path} failed: {e}"
            ),
        }
    }

    Ok(())
}

/// Count regular files that are immediate children of `dir` (non-recursive).
/// Returns 0 if the dir is unreadable or contains only subdirectories. Used
/// to populate `ReconcileStats::orphan_files_removed` before the parent dir
/// is removed (after removal we could not count).
fn count_files_in_dir(dir: &Path) -> u32 {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return 0;
    };
    let mut count = 0u32;
    for entry in entries.flatten() {
        if entry.path().is_file() {
            count += 1;
        }
    }
    count
}

/// Strip path separators from a segment that goes into the cache path
/// (account_id / message_id / attachment_id). These are typically UUIDs but
/// could contain dots (the RFC822 Message-ID format includes `@` and dots).
/// Replaces `\\/:*?"<>|` and `.` at the boundary with `_` to prevent the
/// segment from being interpreted as a path component. Does NOT fall back to
/// a default — the caller's ids are expected to be non-empty.
fn sanitize_path_segment(segment: &str) -> String {
    segment
        .chars()
        .map(|c| match c {
            '\\' | '/' | ':' | '*' | '?' | '"' | '<' | '>' | '|' => '_',
            _ => c,
        })
        .collect::<String>()
        .trim()
        .to_owned()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn message_cache_dir_shards_by_message_id_prefix() {
        let root = Path::new("/tmp/cache");
        let dir = message_cache_dir(root, "acc1", "abcdef1234");
        assert_eq!(
            dir,
            Path::new("/tmp/cache/acc1/ab/abcdef1234"),
            "shard should be the first 2 chars of message_id"
        );
    }

    #[test]
    fn cache_file_path_includes_attachment_id_and_sanitized_filename() {
        let root = Path::new("/tmp/cache");
        let path = cache_file_path(
            root,
            "acc1",
            "abcdef1234",
            "acc1_abcdef1234_2",
            "report (final).pdf",
        );
        assert_eq!(
            path,
            Path::new("/tmp/cache/acc1/ab/abcdef1234/acc1_abcdef1234_2_report (final).pdf")
        );
    }

    #[test]
    fn cache_file_path_strips_path_separators_from_filename() {
        let root = Path::new("/tmp/cache");
        let path = cache_file_path(
            root,
            "a",
            "m",
            "a_m_1",
            "../../etc/passwd",
        );
        // The sanitizer replaces \\ / : * ? " < > | with _, and the leading
        // ".." segments become "__" (not path traversal).
        let file_name = path.file_name().unwrap().to_str().unwrap();
        assert!(file_name.starts_with("a_m_1_"));
        assert!(!file_name.contains('/'));
        assert!(!file_name.contains('\\'));
        assert!(file_name.contains("etc_passwd") || file_name.contains("etc_passw_d"));
    }

    #[test]
    fn path_is_within_cache_accepts_subpath() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path();
        let sub = root.join("acc/shard/msg/file.bin");
        std::fs::create_dir_all(sub.parent().unwrap()).unwrap();
        std::fs::write(&sub, b"x").unwrap();
        assert!(path_is_within_cache(&sub, root));
    }

    #[test]
    fn path_is_within_cache_rejects_outside() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path();
        let outside = std::env::temp_dir().join("kylins-cache-test-outside.bin");
        std::fs::write(&outside, b"x").unwrap();
        assert!(!path_is_within_cache(&outside, root));
        let _ = std::fs::remove_file(&outside);
    }

    #[test]
    fn write_cache_file_creates_parent_dirs_and_returns_size() {
        let tmp = tempfile::tempdir().unwrap();
        let path = tmp.path().join("a/b/c/file.bin");
        let size = write_cache_file(&path, b"hello world").unwrap();
        assert_eq!(size, 11);
        assert!(path.exists());
        assert_eq!(std::fs::read(&path).unwrap(), b"hello world");
    }

    // ---- reconcile_cache (Task B2) ----
    //
    // The reconcile tests need a real SQLite DB (the function queries the
    // `messages` table), so they spin up `db::init_db` on a tempdir exactly
    // like the `db::attachments` tests do. Helpers `seed_account` /
    // `seed_message` mirror the ones in `db/attachments.rs::tests` — they are
    // small and kept local so this module's tests are self-contained.

    async fn seed_account(pool: &sqlx::SqlitePool, id: &str) {
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

    async fn seed_message(pool: &sqlx::SqlitePool, account_id: &str, thread_id: &str, message_id: &str) {
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

    /// Seed an `attachments` row with the given `local_path`. Used by the
    /// stale-path test to construct a row whose file does not exist on disk.
    async fn seed_attachment_with_local_path(
        pool: &sqlx::SqlitePool,
        id: &str,
        account_id: &str,
        message_id: &str,
        part_id: &str,
        local_path: &str,
    ) {
        sqlx::query(
            "INSERT INTO attachments (id, message_id, account_id, imap_part_id, local_path, cached_at, cache_size)
             VALUES (?, ?, ?, ?, ?, strftime('%s','now'), 123)",
        )
        .bind(id)
        .bind(message_id)
        .bind(account_id)
        .bind(part_id)
        .bind(local_path)
        .execute(pool)
        .await
        .unwrap();
    }

    /// Acceptance criterion #1 + #6: orphan message dir (no `messages` row)
    /// is removed; live dir (row exists) is preserved; stats reflect the
    /// removal. Two messages under the same account — one seeded in the DB,
    /// one not — so the orphan-vs-live contrast is in one pass.
    #[tokio::test]
    async fn reconcile_removes_orphan_dirs_and_preserves_live_ones() {
        let tmp = tempfile::tempdir().unwrap();
        let pool = crate::db::init_db(tmp.path()).await.unwrap();
        let cache_root = tmp.path().join("attachment-cache");

        seed_account(&pool, "acct").await;
        seed_message(&pool, "acct", "thr1", "msg1").await;
        // Note: msg2 has NO row in `messages` → its cache dir is an orphan.

        // Build the cache layout exactly as `message_cache_dir` would.
        let live_dir = message_cache_dir(&cache_root, "acct", "msg1");
        let orphan_dir = message_cache_dir(&cache_root, "acct", "msg2");
        std::fs::create_dir_all(&live_dir).unwrap();
        std::fs::create_dir_all(&orphan_dir).unwrap();

        // Place a dummy file in each (counted in `orphan_files_removed`).
        let live_file = live_dir.join("acct_msg1_1_report.pdf");
        let orphan_file = orphan_dir.join("acct_msg2_1_photo.png");
        std::fs::write(&live_file, b"live-bytes").unwrap();
        std::fs::write(&orphan_file, b"orphan-bytes").unwrap();

        let stats = reconcile_cache(&cache_root, &pool).await.unwrap();

        // Orphan removed; live preserved.
        assert!(!orphan_dir.exists(), "orphan cache dir must be removed");
        assert!(!orphan_file.exists(), "orphan cache file must be removed");
        assert!(live_dir.exists(), "live cache dir must be preserved");
        assert!(live_file.exists(), "live cache file must be preserved");

        // Stats reflect the single orphan dir + single file inside it.
        assert_eq!(stats.orphan_dirs_removed, 1, "exactly one orphan dir removed");
        assert_eq!(stats.orphan_files_removed, 1, "one file inside the orphan dir");
        assert_eq!(stats.stale_paths_cleared, 0, "no stale local_path rows in this scenario");
    }

    /// Acceptance criterion #2 + #5: an `attachments.local_path` pointing at
    /// a file that does not exist on disk is NULLed (along with `cached_at`
    /// and `cache_size`), and the count is reported. The message row stays
    /// alive — only the cache pointer is stale (e.g. user deleted the file
    /// externally but kept the message).
    #[tokio::test]
    async fn reconcile_clears_stale_local_path_when_file_missing() {
        let tmp = tempfile::tempdir().unwrap();
        let pool = crate::db::init_db(tmp.path()).await.unwrap();
        let cache_root = tmp.path().join("attachment-cache");
        seed_account(&pool, "acct").await;
        seed_message(&pool, "acct", "thr1", "msg1").await;

        // Attachment row points at a path that does NOT exist on disk.
        let ghost_path = cache_root
            .join("acct")
            .join("ms")
            .join("msg1")
            .join("acct_msg1_1_ghost.bin");
        assert!(
            !Path::new(&ghost_path).exists(),
            "precondition: ghost path must not exist"
        );
        seed_attachment_with_local_path(
            &pool,
            "acct_msg1_1",
            "acct",
            "msg1",
            "1",
            ghost_path.to_str().unwrap(),
        )
        .await;

        let stats = reconcile_cache(&cache_root, &pool).await.unwrap();

        assert_eq!(stats.stale_paths_cleared, 1, "one stale local_path NULLed");
        assert_eq!(stats.orphan_dirs_removed, 0, "no orphan dirs in this scenario");

        // Row's cache columns are now NULL.
        let (lp, ca, cs): (Option<String>, Option<i64>, Option<i64>) = sqlx::query_as(
            "SELECT local_path, cached_at, cache_size FROM attachments WHERE id = ?",
        )
        .bind("acct_msg1_1")
        .fetch_one(&pool)
        .await
        .unwrap();
        assert!(lp.is_none(), "local_path must be NULL");
        assert!(ca.is_none(), "cached_at must be NULL");
        assert!(cs.is_none(), "cache_size must be NULL");
    }

    /// Acceptance criterion #4: a non-existent cache root (fresh install,
    /// no attachment ever fetched) returns empty stats and never errors.
    #[tokio::test]
    async fn reconcile_nonexistent_cache_root_returns_empty_stats() {
        let tmp = tempfile::tempdir().unwrap();
        let pool = crate::db::init_db(tmp.path()).await.unwrap();
        // cache_root is never created — reconcile must short-circuit cleanly.
        let cache_root = tmp.path().join("attachment-cache");

        let stats = reconcile_cache(&cache_root, &pool).await.unwrap();

        assert_eq!(stats.orphan_dirs_removed, 0);
        assert_eq!(stats.orphan_files_removed, 0);
        assert_eq!(stats.stale_paths_cleared, 0);
    }

    /// Multiple orphans under different accounts + shards in one pass — pins
    /// that the walk descends every level and sums correctly across the tree
    /// (not just the first branch it finds).
    #[tokio::test]
    async fn reconcile_handles_multiple_orphans_across_accounts_and_shards() {
        let tmp = tempfile::tempdir().unwrap();
        let pool = crate::db::init_db(tmp.path()).await.unwrap();
        let cache_root = tmp.path().join("attachment-cache");

        seed_account(&pool, "a1").await;
        seed_account(&pool, "a2").await;
        // One live message per account.
        seed_message(&pool, "a1", "t1", "aaaa1").await;
        seed_message(&pool, "a2", "t2", "bbbb1").await;
        // Three orphans across two accounts and two shards.
        let orphans = [
            ("a1", "aaaa2"), // shard "aa"
            ("a1", "cccc9"), // shard "cc"
            ("a2", "bbbb2"), // shard "bb"
        ];
        for (acct, mid) in orphans {
            let dir = message_cache_dir(&cache_root, acct, mid);
            std::fs::create_dir_all(&dir).unwrap();
            // Two files in each orphan dir to exercise the file counter.
            std::fs::write(dir.join("f1.bin"), b"x").unwrap();
            std::fs::write(dir.join("f2.bin"), b"x").unwrap();
        }
        // And one live dir per account that must survive.
        let live1 = message_cache_dir(&cache_root, "a1", "aaaa1");
        let live2 = message_cache_dir(&cache_root, "a2", "bbbb1");
        std::fs::create_dir_all(&live1).unwrap();
        std::fs::create_dir_all(&live2).unwrap();
        std::fs::write(live1.join("keep.bin"), b"x").unwrap();
        std::fs::write(live2.join("keep.bin"), b"x").unwrap();

        let stats = reconcile_cache(&cache_root, &pool).await.unwrap();

        assert_eq!(stats.orphan_dirs_removed, 3, "three orphan dirs across accounts");
        assert_eq!(
            stats.orphan_files_removed, 6,
            "two files per orphan dir × three dirs"
        );
        assert!(live1.exists(), "live dir a1/aaaa1 preserved");
        assert!(live2.exists(), "live dir a2/bbbb1 preserved");
    }

    /// `count_files_in_dir` counts only immediate-file children (subdirs do
    /// not bump the counter). Pins the helper's contract since the stats rely
    /// on it.
    #[test]
    fn count_files_in_dir_counts_only_immediate_files() {
        let tmp = tempfile::tempdir().unwrap();
        let dir = tmp.path().join("d");
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("f1.bin"), b"x").unwrap();
        std::fs::write(dir.join("f2.bin"), b"x").unwrap();
        // A subdir is NOT a file — must be ignored by the counter.
        std::fs::create_dir_all(dir.join("subdir")).unwrap();
        std::fs::write(dir.join("subdir").join("nested.bin"), b"x").unwrap();

        assert_eq!(count_files_in_dir(&dir), 2);
    }
}
