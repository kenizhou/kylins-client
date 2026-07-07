# Attachment Cache — Files, Not Base64 (Receive + Forward)

> **Status:** Design — 2026-07-04. Completes the symmetry with T7b (send path: attachments are files, no base64 over IPC). Receive + forward currently round-trip base64 through the frontend; this spec makes them file-based too.

## Problem

The send path (T7b) stages attachments as **files** (`<appData>/outbox-attachments/{draftId}/`) and the backend `mail-builder` reads them at send time — **no base64 crosses IPC**. But the receive + forward paths still pass base64:

- **Receive** (`sync_fetch_attachment`): fetches the raw MIME part → returns `{ mimeType, base64 }` to the frontend → frontend decodes → writes to disk (download) or `data:` URL (inline images). A large attachment (~1.33× its size in base64) crosses IPC.
- **Forward**: fetches the original's attachment via `sync_fetch_attachment` (base64) → frontend decodes → stages as a file (`stageAttachmentBytes`) → on send, backend re-encodes. A pointless base64 decode-then-re-encode round-trip.

This is the same anti-pattern T7b removed for sending.

## Goal

**Attachments are always files; base64 never crosses IPC — send, receive, or forward.** The backend decodes + caches received attachments as files; the frontend + forward operate on file paths.

## Cache design

### Location + schema
- Cache root: `<appData>/attachment-cache/{account_id}/{message_id}/{safe_filename}`.
- The `attachments` table **already has a `local_path TEXT` column** (currently unused/reserved) — store the cached absolute path there on first fetch. Also use the existing `cached_at` + `cache_size` columns for orphan-reconcile ordering.
- `safe_filename` = sanitized (strip `\\/:*?"<>|`, reject `.`/`..`) — reuse `sanitize_attachment_filename` from `commands.rs` (added in #2 Phase 1).

### Fetch policy (user-locked: persistent, re-fetch on miss)
- `sync_fetch_attachment(account_id, message_id, part_id)`:
  1. Look up the `attachments` row (has `local_path`, `filename`, `mime_type`, `size`).
  2. If `local_path` is set AND the file exists (`std::path::Path::exists`) → **return the path immediately** (no network).
  3. Else (miss — never fetched, or file removed externally): fetch the raw MIME part (`BODY.PEEK[<part_id>]`, existing path), **decode** the base64 transfer encoding → write the bytes to the cache file → `UPDATE attachments SET local_path = ?, cached_at = now` → return the path.
- **No LRU eviction.** Attachments persist for the email's lifetime.
- Return shape: `{ filePath, filename, mimeType, size }` (serde camelCase) — **no base64**.

### Cleanup
- **On message deletion**: the engine's delete-messages path removes the per-message cache dir `<appData>/attachment-cache/{account_id}/{message_id}/` for each deleted message (the `attachments` rows already CASCADE-delete; this adds the file cleanup).
- **Periodic orphan-reconcile (backstop)**: a startup or periodic pass scans the cache dir vs. the `attachments` table; deletes cache files whose `(account_id, message_id)` no longer has a message row. Guards against leaked files from crashes mid-delete.

## Frontend changes

### Download (AttachmentList)
- `handleDownload`: instead of fetching base64 + `write_binary_file`, the backend returns a `filePath`; the frontend `save()` dialog picks a destination + calls a **copy** command (`copy_cached_attachment` or reuse `copyFile` if the dest is in scope; likely a small backend `copy_file(src, dest)` command for the same fs-scope reason). No decode.

### Forward
- The forward seed (`Composer.tsx` includeOriginalAttachments branch): instead of `fetchAttachment` (base64) → `base64ToBytes` → `stageAttachmentBytes`, call `sync_fetch_attachment` (now returns `filePath`) → copy the cached file into the draft outbox (`<appData>/outbox-attachments/{stagingDraftId}/`) → `addAttachment`. No base64 round-trip.

### Inline `cid:` images (secondary — small payload)
- For now, **keep `data:` URLs** for inline images (they're small — signature logos, emojis). `sync_fetch_inline_images` can stay base64 (the payload is tiny). 
- Future: switch to `convertFileSrc(filePath)` (asset protocol) for full consistency — requires an asset-protocol scope in the capability. **Out of scope here.**

## Backend changes

1. **Rewrite `sync_fetch_attachment`** (`sync_engine/commands.rs`): cache-check → fetch-on-miss → decode → write file → return `{filePath, filename, mimeType, size}` (drop base64 from the return).
2. **`sync_fetch_inline_images`**: leave as-is (base64, small) OR optionally cache too — defer.
3. **Delete path**: add cache-dir cleanup when messages are deleted (find the engine's delete-messages code path).
4. **Orphan-reconcile**: a startup command/worker that scans the cache dir vs. `attachments` rows.
5. **`copy_file` command** (for download): a small `copy_file(src, dest)` backend command (the frontend fs plugin can't copy from the cache path if it's outside appData... but the cache IS under appData, so the frontend `copyFile` from `<appData>/attachment-cache/...` → `<user's save location>` — the DEST might be out of scope. So a backend `copy_file` is safer for the save-to-arbitrary-location case.)

## Migration / compatibility
- Old callers of `sync_fetch_attachment` that expect `{base64}` (`AttachmentList.handleDownload`, the Composer forward seed) are updated to the new `{filePath}` shape. No DB migration (the `local_path` column already exists).
- The base64 return is **removed** (breaking change for those two callers — both are updated in this refactor).

## Non-goals
- LRU eviction / size cap (user explicitly wants persistent — accept unbounded growth; a future "clear cache" UI is a follow-up).
- Inline images via `convertFileSrc` (deferred; `data:` URLs kept for small payloads).
- Caching message **bodies** (the `message_bodies` LRU is a separate concern — see #5; the same "persist until email deleted" principle could apply there too, but that's a separate decision).

## Verification
- Backend: unit test the cache-check (hit returns path, no fetch; miss fetches + writes + updates `local_path`) + the cleanup-on-delete. `cargo test --lib` + `cargo clippy --all-targets -- -D warnings`.
- Frontend: download works (file copy); forward stages the cached file (no base64). `tsc --noEmit` + `vitest run`.
- Manual e2e: open a received message with a large attachment → confirm the file is cached on first open (no re-fetch on re-open) → forward it → confirm no base64 in the flow (logs) → delete the message → confirm the cache dir is gone.
