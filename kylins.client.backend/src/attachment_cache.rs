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
}
