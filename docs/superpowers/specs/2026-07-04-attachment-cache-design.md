# Attachment Cache — Files, Not Base64 (Receive + Forward)

> **Status:** Design (revised 2026-07-07 after Thunderbird/Mailspring research + codebase audit). Completes the symmetry with T7b (send path: attachments are files, no base64 over IPC). Receive + forward currently round-trip base64 through the frontend; this spec makes them file-based too.

## Problem

The send path (T7b) stages attachments as **files** (`<appData>/outbox-attachments/{draftId}/`) and the backend `mail-builder` reads them at send time — **no base64 crosses IPC**. But the receive + forward paths still pass base64:

- **Receive** (`sync_fetch_attachment`): fetches the full message (`BODY.PEEK[]`) → parses MIME → extracts the part → returns `{ mimeType, base64 }` to the frontend → frontend decodes → writes to disk (download) or `data:` URL (inline images). A large attachment (~1.33× its size in base64) crosses IPC.
- **Forward**: fetches the original's attachment via `sync_fetch_attachment` (base64) → frontend decodes → stages as a file (`stageAttachmentBytes`) → on send, backend re-encodes. A pointless base64 decode-then-re-encode round-trip.

This is the same anti-pattern T7b removed for sending.

## Goal

**Attachments are always files; base64 never crosses IPC — send, receive, or forward.** The backend decodes + caches received attachments as files; the frontend + forward operate on file paths.

## Cache design

### Location + layout (sharded, collision-proof)

```
<appData>/attachment-cache/
  {account_id}/
    {message_id[..2]}/                              ← 1-level hex shard (~256 buckets)
      {message_id}/
        {attachment_id}_{safe_filename}              ← collision-proof, debuggable
```

- **Shard level** (`message_id[..2]`): prevents flat directories at scale (50K messages/account → ~200 dirs/bucket instead of one dir with 50K entries). Matches Mailspring's sharded-hash pattern; keeps NTFS/ext4 directory enumeration fast for orphan-reconcile and size queries.
- **Per-message grouping** (`{message_id}/`): makes cleanup on message delete trivial — `rm -rf {account_id}/{message_id[..2]}/{message_id}/`. This is the key advantage over Mailspring's sharded-only layout (which leaks files because cleanup requires a join).
- **Collision-proof filename** (`{attachment_id}_{safe_filename}`): the `attachments.id` is `{account_id}_{message_id}_{part_id}` (composite, unique per part) — prefixing prevents same-filename overwrites when a message has two `screenshot.png` parts.

### Schema (no migration needed)

The `attachments` table **already has** `local_path TEXT`, `cached_at INTEGER`, `cache_size INTEGER` columns (in `migrations/20260627000001_baseline.sql:177`) — they are dormant (the `AttachmentRow` struct + SELECT omit them). No migration is required; the cache module reads/writes them via dedicated queries.

`safe_filename` = sanitized (strip `\\/:*?"<>|`, reject `.`/`..`) — reuse `sanitize_attachment_filename` from `commands.rs` (made `pub(crate)` in Phase A).

### Path containment validation (security)

After constructing the cache path, verify with `canonicalize()` that the resolved path starts with the cache root. This is defense-in-depth against symlink/path-traversal escapes if sanitization is ever bypassed (Mailspring's `quickpreview-ipc.ts` pattern).

### Fetch policy (user-locked: persistent, re-fetch on miss)

- `sync_fetch_attachment(account_id, message_id, part_id)`:
  1. Look up the `attachments` row (extended SELECT including `local_path`, `filename`, `mime_type`, `size`).
  2. If `local_path` is set AND the file exists (`std::path::Path::exists`) → **return the path immediately** (no network).
  3. Else (miss — never fetched, or file removed externally): fetch the bytes, **decode** the transfer encoding → write the bytes to the cache file → `UPDATE attachments SET local_path = ?, cached_at = now, cache_size = ?` → return the path.
- **No LRU eviction.** Attachments persist for the email's lifetime. The `cached_at`/`cache_size` columns are present for future LRU if persistent growth becomes a concern.
- Return shape: `{ filePath, filename, mimeType, size }` (serde camelCase) — **no base64**.

> **IMAP fetch note (Phase C):** the current miss-path uses `BODY.PEEK[]` (full message) then parses the MIME tree to extract one part — inherited from Velo, flagged as inefficient by the Thunderbird/Mailspring research. Phase C rewrites this to `BODY.PEEK[{part_id}]` (partial fetch). The cache works correctly without this optimization (it just means the miss-path is more expensive than necessary); the optimization layers on independently.

### Cleanup

- **On message deletion (Phase B)**: the engine's delete-messages path removes the per-message cache dir `<appData>/attachment-cache/{account_id}/{message_id[..2]}/{message_id}/` for each deleted message (the `attachments` rows already CASCADE-delete; this adds the file cleanup).
- **Periodic orphan-reconcile (Phase B)**: a startup pass (gated by the existing `cacheAutoCleanupEnabled` preference) scans the cache dir vs. the `attachments` table; deletes cache files whose `(account_id, message_id)` no longer has a message row. Guards against leaked files from crashes mid-delete.

## Frontend changes

### Download (AttachmentList)
- `handleDownload`: instead of fetching base64 + `write_binary_file`, the backend returns a `filePath`; the frontend `save()` dialog picks a destination + calls `copy_cached_attachment(srcPath, destPath)` (new backend command — the frontend fs plugin can't write outside appData, so the copy-to-arbitrary-save-location goes through Rust `std::fs`). No decode.

### Forward
- The forward seed (`Composer.tsx` + `InlineReply.tsx` includeOriginalAttachments branch): instead of `fetchAttachment` (base64) → `base64ToBytes` → `stageAttachmentBytes`, call `fetchAttachment` (now returns `filePath`) → copy the cached file into the draft outbox via `@tauri-apps/plugin-fs` `copyFile` (both source and dest are under appData, so plugin-fs has scope). No base64 round-trip.

### Inline `cid:` images (secondary — small payload)
- For now, **keep `data:` URLs** for inline images (they're small — signature logos, emojis). `sync_fetch_inline_images` can stay base64 (the payload is tiny).
- Future: switch to `convertFileSrc(filePath)` (asset protocol) for full consistency — requires an asset-protocol scope in the capability. **Out of scope here.**

## Backend changes (Phase A — core)

1. `src/commands.rs`: make `sanitize_attachment_filename` `pub(crate)`.
2. New module `src/attachment_cache.rs`:
   - `cache_path(app, account_id, message_id, attachment_id, filename) -> Result<PathBuf, String>` — computes the sharded path.
   - `path_is_within_cache(path, root) -> bool` — canonicalize containment check.
   - `get_or_fetch(pool, app, account_id, message_id, part_id) -> Result<CachedAttachment, String>` — cache-check-or-fetch logic.
3. `src/sync_engine/commands.rs`: rewrite `sync_fetch_attachment` + `sync_fetch_attachment_inner` to call `attachment_cache::get_or_fetch`; change return type from `AttachmentBytes { mimeType, base64 }` to `CachedAttachment { filePath, filename, mimeType, size }`.
4. `src/db/attachments.rs`: add `get_attachment_meta(pool, account_id, message_id, part_id) -> AttachmentMeta` (includes `id`, `local_path`, `filename`, `mime_type`, `size`) and `set_cached_path(pool, id, local_path, cache_size)`.
5. `src/commands.rs`: add `copy_cached_attachment(src_path, dest_path) -> Result<(), String>` for download (arbitrary save location).
6. `src/lib.rs`: register `copy_cached_attachment`.

## Backend changes (Phase B — cleanup)

7. `src/db/mutations.rs` (`apply_mutation_inner`, `MutationOp::Delete`): before deleting message rows, collect `(account_id, message_id)` pairs; after the DB delete, `remove_dir_all` each message's cache dir.
8. New command `reconcile_attachment_cache(app, pool) -> Result<ReconcileStats>` — walks `attachment-cache/`, deletes dirs whose `message_id` has no row in `messages`; NULLs stale `local_path` rows whose file is missing. Call on startup (gated by `cacheAutoCleanupEnabled`).

## Backend changes (Phase C — performance)

9. `src/mail/imap/client.rs`: add `fetch_part_bytes(config, folder, uid, part_id) -> (mime_type, Vec<u8>)` that issues `UID FETCH {uid} (BODY.PEEK[{part_id}])` and decodes the transfer encoding. Wire into `attachment_cache::get_or_fetch` as the miss-path, replacing the full-message fetch.

## Backend changes (Phase D — UI integration)

10. Extend `get_cache_size` (`commands.rs`) to also measure `<appData>/attachment-cache/`.
11. Extend `clear_cache` (`commands.rs`) to also `remove_dir_all(attachment-cache/)` and `UPDATE attachments SET local_path=NULL, cached_at=NULL, cache_size=NULL`.
12. Wire `cacheAutoCleanupEnabled` to gate the startup reconcile (Phase B #8). Wire `displayAttachmentThumbnails` for future preview generation.

## Migration / compatibility
- Old callers of `sync_fetch_attachment` that expect `{base64}` (`AttachmentList.handleDownload`, the Composer/InlineReply forward seed) are updated to the new `{filePath}` shape. No DB migration (the `local_path`/`cached_at`/`cache_size` columns already exist).
- The base64 return is **removed** (breaking change for those callers — all are updated in Phase A).

## Non-goals (deferred)
- **LRU eviction / size cap** — user explicitly wants persistent. The schema supports future LRU; a configurable max (Velo-style slider) is a follow-up if growth becomes a concern.
- **Inline images via `convertFileSrc`** — deferred; `data:` URLs kept for small payloads.
- **Preview thumbnails** (Mailspring `.png`-alongside pattern) — the dir structure accommodates it; deferred until `displayAttachmentThumbnails` is wired.
- **Open-to-temp-file** (Thunderbird `pid-{PID}` pattern with cleanup-on-exit) — follow-up for double-click-to-open; download (save) is covered in Phase A.
- **EAS attachment fetch** — needs a `MailSource::fetch_attachment` trait method + EAS ItemOperations; IMAP-only for now.
- **Caching message bodies** (the `message_bodies` LRU is a separate concern).

## Verification
- **Phase A**: unit test the cache-check (hit returns path, no fetch; miss fetches + writes + updates `local_path`) + path containment. `cargo test --lib` + `cargo clippy --all-targets -- -D warnings`. Frontend: download works (file copy); forward stages the cached file (no base64). `tsc --noEmit` + `vitest run`.
- **Phase B**: unit test cleanup-on-delete + orphan-reconcile with temp dirs.
- **Phase C**: unit test partial fetch against a mock IMAP server; confirm a single-part fetch doesn't pull the whole message.
- **Manual e2e**: open a received message with a large attachment → confirm the file is cached on first open (check `<appData>/attachment-cache/`) → no re-fetch on re-open → forward it → confirm no base64 in the flow (logs) → delete the message → confirm the cache dir is gone.
