// Tauri commands for the SyncEngine lifecycle. The frontend invokes these to start
// polling on app launch, trigger a manual "check mail", and stop on quit.

use std::collections::HashMap;
use std::sync::Arc;

use sqlx::SqlitePool;
use tauri::State;

use super::engine::{BodiesWrittenEvent, SnippetUpdate, SyncEngine};
use super::{source_for_account, RemoteFolder};
use crate::db::{attachments, message_bodies, messages, mutations::MutationOp, queue};

#[tauri::command]
pub async fn sync_start(engine: State<'_, Arc<SyncEngine>>) -> Result<(), String> {
    engine.start().await
}

#[tauri::command]
pub async fn sync_stop(engine: State<'_, Arc<SyncEngine>>) -> Result<(), String> {
    engine.stop_all().await;
    Ok(())
}

#[tauri::command]
pub async fn sync_account_now(
    engine: State<'_, Arc<SyncEngine>>,
    account_id: String,
) -> Result<(), String> {
    engine.sync_account_now(account_id).await;
    Ok(())
}

/// Fetch full message bodies on demand (the second half of the headers-first
/// sync design). The folder sweep persists envelopes + flags only
/// (`sync_fetch_query`); bodies arrive here when the user opens a message whose
/// `message_bodies` row is missing.
///
/// **Task 2 — batch-per-folder:** message_ids are grouped by their
/// `imap_folder`, then for each folder we issue ONE `fetch_bodies_batch` call
/// (chunked internally at 50 UIDs) instead of opening a fresh connection per
/// UID. The derived snippet is written onto `messages.snippet` (mirrored to
/// `threads.snippet`), and ONE `sync:bodies-written` event is emitted at the
/// end carrying every `SnippetUpdate` so the frontend patches the list in a
/// single scroll-preserving pass.
///
/// Non-IMAP sources (EAS today) return `None` from
/// `MailSource::imap_config_for_folder` and fall back to the per-message
/// `fetch_body` path — batching EAS is its own workstream.
///
/// Best-effort: per-message failures are logged and skipped so one bad row
/// never aborts the whole batch.
///
/// The thin `State` wrapper delegates to [`request_bodies_inner`] so the logic
/// is unit-testable without a `State` harness (mirrors `apply_mutation_inner`).
#[tauri::command]
pub async fn sync_request_bodies(
    engine: State<'_, Arc<SyncEngine>>,
    pool: State<'_, SqlitePool>,
    account_id: String,
    message_ids: Vec<String>,
) -> Result<(), String> {
    log::info!("[sync] sync_request_bodies called: account={}, ids=[{}] ({})", account_id, message_ids.join(","), message_ids.len());
    request_bodies_inner(engine.inner().clone(), pool.inner(), &account_id, &message_ids).await
}

/// Testable core of [`sync_request_bodies`]. Takes a borrowed pool + an
/// `Arc<SyncEngine>` (the engine is only used for the final event emission)
/// so unit tests can drive it without a `State<'_, SqlitePool>` harness.
pub async fn request_bodies_inner(
    engine: Arc<SyncEngine>,
    pool: &SqlitePool,
    account_id: &str,
    message_ids: &[String],
) -> Result<(), String> {
    if message_ids.is_empty() {
        return Ok(());
    }

    // 1. Build a per-folder map: folder -> Vec<(message_id, uid)>.
    //    One DB read per message_id (the existing helper). This is N small
    //    queries, not N connections — cheap relative to the network round-trip
    //    we are about to make. Missing rows / NULL UIDs are skipped (non-IMAP
    //    sources or partially-migrated data).
    let mut by_folder: HashMap<String, Vec<(String, u32)>> = HashMap::new();
    for mid in message_ids {
        match messages::get_folder_uid_for_message(pool, account_id, mid).await {
            Ok(Some((folder, uid))) => {
                by_folder.entry(folder).or_default().push((mid.clone(), uid));
            }
            Ok(None) => log::warn!(
                "[sync] request_bodies: no imap_folder/uid for message {mid}; skipping"
            ),
            Err(e) => log::warn!(
                "[sync] request_bodies: lookup failed for message {mid}: {e}; skipping"
            ),
        }
    }
    if by_folder.is_empty() {
        return Ok(());
    }

    // 2. Resolve the account's MailSource ONCE. The batch path does NOT call
    //    `source.fetch_body` — it asks the source for an `ImapConfig` via the
    //    new `imap_config_for_folder` trait method and hands it to
    //    `fetch_bodies_batch` directly. Non-IMAP sources return `None` and we
    //    fall back to the per-message `source.fetch_body` below.
    let src = match source_for_account(pool, account_id, &engine.session_manager).await {
        Ok(s) => s,
        Err(e) => {
            log::warn!("[sync] request_bodies: source for {account_id} failed: {e}");
            return Err(e);
        }
    };

    let mut updates: Vec<SnippetUpdate> = Vec::new();

    // 3. Per folder: one batched fetch (IMAP via the persistent session
    //    manager), or per-message fallback (EAS / non-IMAP).
    //
    //    The persistent session is reused for every body batch, so we avoid the
    //    raw-fallback path's fresh connect + LOGIN per folder. That is the fix
    //    for Yahoo's `a1 NO [LIMIT] LOGIN Rate limit hit` during body prefetch.
    for (folder, mid_uids) in by_folder {
        match src.imap_config_for_folder(&folder).await {
            Ok(Some(config)) => {
                let uids: Vec<u32> = mid_uids.iter().map(|(_, u)| *u).collect();
                match engine
                    .session_manager
                    .fetch_bodies_batch(account_id, &config, &folder, &uids, 50)
                    .await
                {
                    Ok(fetched) => {
                        // Index fetched bodies by uid for O(1) lookup.
                        let by_uid: HashMap<u32, &crate::mail::imap::types::FetchedBody> =
                            fetched.iter().map(|f| (f.uid, f)).collect();
                        for (mid, uid) in &mid_uids {
                            match by_uid.get(uid) {
                                Some(fb) => {
                                    // Persist body_html (prefers HTML; falls back to text).
                                    // For S/MIME opaque messages
                                    // (application/pkcs7-mime enveloped-data / opaque
                                    // signed-data) `body_html`/`body_text` are both
                                    // None because the body IS the CMS blob. We still
                                    // need a `message_bodies` row so the ciphertext
                                    // UPDATE below hits a row — persist an empty
                                    // placeholder in that case; the receive
                                    // orchestrator (G5 Task 3) overwrites it after
                                    // decrypt/verify.
                                    let body_str = fb
                                        .body_html
                                        .clone()
                                        .or_else(|| fb.body_text.clone());
                                    let body_to_persist = body_str.or_else(|| {
                                        fb.raw_ciphertext
                                            .as_ref()
                                            .map(|_| String::new())
                                    });
                                    if let Some(body) = body_to_persist.as_deref() {
                                        if let Err(e) = message_bodies::set_message_body(
                                            pool, account_id, mid, body,
                                        )
                                        .await
                                        {
                                            log::warn!(
                                                "[sync] request_bodies: persist body for {mid} (uid {uid} in {folder}) failed: {e}"
                                            );
                                            continue;
                                        }
                                    }
                                    // Cache the raw CMS ciphertext for the receive
                                    // orchestrator (Phase 1b G5 Task 1). This MUST
                                    // run AFTER set_message_body above — the helper
                                    // is an UPDATE that requires the row to exist.
                                    // Best-effort: a failure here leaves the body row
                                    // valid but without the cached ciphertext, so the
                                    // orchestrator will fall back to re-fetching.
                                    if let Some(ct) = fb.raw_ciphertext.as_deref() {
                                        if let Err(e) = message_bodies::set_message_ciphertext(
                                            pool, account_id, mid, ct,
                                        )
                                        .await
                                        {
                                            log::warn!(
                                                "[crypto] request_bodies: persist ciphertext for {mid} (uid {uid} in {folder}) failed: {e}"
                                            );
                                        }
                                    }
                                    // Write snippet onto messages + threads.
                                    if let Err(e) = messages::set_message_snippet(
                                        pool, account_id, mid, &fb.snippet,
                                    )
                                    .await
                                    {
                                        log::warn!(
                                            "[sync] request_bodies: snippet for {mid} failed: {e}"
                                        );
                                        continue;
                                    }
                                    // Persist attachment metadata parsed from
                                    // the same body (no extra fetch) so the
                                    // reading pane can list attachments +
                                    // resolve inline cid: images. Best-effort.
                                    if !fb.attachments.is_empty() {
                                        if let Err(e) = attachments::upsert_attachments(
                                            pool,
                                            account_id,
                                            mid,
                                            &fb.attachments,
                                        )
                                        .await
                                        {
                                            log::warn!(
                                                "[sync] request_bodies: upsert attachments for {mid} failed: {e}"
                                            );
                                        }
                                    }
                                    // Resolve thread_id for the event payload.
                                    match messages::get_thread_id_for_message(
                                        pool, account_id, mid,
                                    )
                                    .await
                                    {
                                        Ok(Some(tid)) => updates.push(SnippetUpdate {
                                            thread_id: tid,
                                            snippet: fb.snippet.clone(),
                                        }),
                                        Ok(None) => log::warn!(
                                            "[sync] request_bodies: no thread_id for {mid}; event patch skipped"
                                        ),
                                        Err(e) => log::warn!(
                                            "[sync] request_bodies: thread_id lookup for {mid} failed: {e}"
                                        ),
                                    }
                                }
                                None => log::info!(
                                    "[sync] request_bodies: uid {uid} in {folder} not in batch result; skipping"
                                ),
                            }
                        }
                    }
                    Err(e) => log::warn!(
                        "[sync] request_bodies: fetch_bodies_batch for {folder} failed: {e}"
                    ),
                }
            }
            Ok(None) => {
                // Non-IMAP source (EAS today): fall back to per-message.
                // The batch path is unavailable; each fetch_body opens its own
                // transport. Snippet is left empty for EAS until the EAS
                // client exposes a derived preview (deferred).
                for (mid, uid) in &mid_uids {
                    let folder_obj = RemoteFolder {
                        remote_id: folder.clone(),
                        ..Default::default()
                    };
                    match src.fetch_body(&folder_obj, *uid).await {
                        Ok(Some(html)) => {
                            if let Err(e) =
                                message_bodies::set_message_body(pool, account_id, mid, &html).await
                            {
                                log::warn!(
                                    "[sync] request_bodies (fallback): persist body for {mid} failed: {e}"
                                );
                                continue;
                            }
                            // EAS has no derived snippet yet; write empty so the
                            // thread row is consistent (and the column is NOT
                            // NULL, which db_get_threads would otherwise treat
                            // as "needs preview generation" later).
                            if let Err(e) =
                                messages::set_message_snippet(pool, account_id, mid, "").await
                            {
                                log::warn!(
                                    "[sync] request_bodies (fallback): snippet for {mid} failed: {e}"
                                );
                            }
                        }
                        Ok(None) => log::info!(
                            "[sync] request_bodies (fallback): uid {uid} in {folder} had no body"
                        ),
                        Err(e) => log::warn!(
                            "[sync] request_bodies (fallback): fetch_body for {mid} (uid {uid} in {folder}) failed: {e}"
                        ),
                    }
                }
            }
            Err(e) => log::warn!(
                "[sync] request_bodies: imap_config_for_folder for {folder} failed: {e}; falling back to per-message"
            ),
        }
    }

    // 4. Bounded cache: evict oldest bodies past the cap. Best-effort — log on
    //    error. Run unconditionally (even if this round wrote nothing) so the
    //    cache converges to the cap regardless of which call happens to push it
    //    over. `set_message_body`/`INSERT OR REPLACE` bumped the row count, so
    //    `maybe_evict` is the symmetric reclaim step that keeps `message_bodies`
    //    from growing unbounded across a long-running session.
    const BODY_CACHE_CAP_ROWS: i64 = 2000;
    if let Err(e) = message_bodies::maybe_evict(pool, BODY_CACHE_CAP_ROWS).await {
        log::warn!("[sync] request_bodies: maybe_evict failed (non-fatal): {e}");
    }

    // 5. Emit ONE bodies-written event with all updates so the frontend
    //    patches every thread in a single scroll-preserving pass.
    if !updates.is_empty() {
        engine.emit_bodies_written_public(BodiesWrittenEvent {
            account_id: account_id.to_string(),
            updates,
        });
    }
    Ok(())
}

/// Decoded attachment bytes (base64) returned by `sync_fetch_attachment` for
/// the inline-images path (small payloads — signature logos, emojis). The
/// regular attachment fetch now returns [`CachedAttachment`] (a file path, no
/// base64) — see `attachment_cache::get_or_fetch`.
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AttachmentBytes {
    pub mime_type: String,
    pub base64: String,
}

/// Resolve `(folder, uid, ImapConfig)` for a message — shared by
/// `sync_fetch_attachment_inner` and `sync_fetch_inline_images_inner`. Also
/// disconnects the persistent IMAP session first so the raw single-connection
/// fetch doesn't trip the server's concurrent-connection limit (same guard as
/// `request_bodies_inner`). Returns `Err` for non-IMAP sources (no config).
async fn resolve_imap_for_message(
    engine: &Arc<SyncEngine>,
    pool: &SqlitePool,
    account_id: &str,
    message_id: &str,
) -> Result<(String, u32, crate::mail::imap::types::ImapConfig), String> {
    let (folder, uid) = messages::get_folder_uid_for_message(pool, account_id, message_id)
        .await
        .map_err(|e| format!("lookup folder/uid for {message_id}: {e}"))?
        .ok_or_else(|| format!("no imap_folder/uid for message {message_id}"))?;
    let src = source_for_account(pool, account_id, &engine.session_manager)
        .await
        .map_err(|e| format!("source for {account_id}: {e}"))?;
    let config = src
        .imap_config_for_folder(&folder)
        .await
        .map_err(|e| format!("imap config for {folder}: {e}"))?
        .ok_or_else(|| format!("no IMAP config for {account_id} (non-IMAP source?)"))?;
    engine.session_manager.disconnect_account(account_id).await;
    Ok((folder, uid, config))
}

/// Testable core of [`sync_fetch_attachment`]. Cache-check → fetch-on-miss →
/// return a file path (no base64 over IPC). The first call fetches the MIME
/// part from IMAP, writes the decoded bytes to
/// `<appData>/attachment-cache/{account_id}/{shard}/{message_id}/`, and records
/// `local_path` in the `attachments` row; subsequent calls return the cached
/// path immediately (no network). See `attachment_cache` module + the design
/// spec for the full layout.
pub async fn sync_fetch_attachment_inner(
    engine: Arc<SyncEngine>,
    pool: &SqlitePool,
    account_id: &str,
    message_id: &str,
    part_id: &str,
) -> Result<crate::attachment_cache::CachedAttachment, String> {
    use crate::attachment_cache as cache;

    // 1. Look up the attachment metadata (id, filename, mime_type, size,
    //    local_path). If we have no row at all, the part_id is unknown —
    //    treat as a miss but with a synthesized filename.
    let meta = attachments::get_attachment_meta(pool, account_id, message_id, part_id)
        .await
        .map_err(|e| format!("lookup attachment meta for {message_id}/{part_id}: {e}"))?;

    let cache_root = engine.data_dir.join("attachment-cache");

    // 2. Cache hit: local_path set AND file exists → return immediately.
    if let Some(ref meta) = meta {
        if let Some(ref local_path) = meta.local_path {
            let path = std::path::Path::new(local_path);
            if path.exists() && cache::path_is_within_cache(path, &cache_root) {
                return Ok(cache::CachedAttachment {
                    file_path: local_path.clone(),
                    filename: meta.filename.clone().unwrap_or_else(|| "attachment".to_string()),
                    mime_type: meta
                        .mime_type
                        .clone()
                        .unwrap_or_else(|| "application/octet-stream".to_string()),
                    size: meta.size,
                });
            }
        }
    }

    // 3. Cache miss: fetch the part from IMAP via BODY.PEEK[<part_id>] partial
    //    fetch (Task C — Phase A's full-message fetch was replaced). Returns
    //    the decoded attachment bytes + mime type.
    let (folder, uid, config) =
        resolve_imap_for_message(&engine, pool, account_id, message_id).await?;
    let (mime_type, data) =
        crate::mail::imap::client::fetch_attachment_bytes(&config, &folder, uid, part_id).await?;

    // 4. Compute the cache path + write the file.
    let attachment_id = meta
        .as_ref()
        .map(|m| m.id.clone())
        .unwrap_or_else(|| format!("{account_id}_{message_id}_{part_id}"));
    let filename = meta
        .as_ref()
        .and_then(|m| m.filename.clone())
        .unwrap_or_else(|| "attachment".to_string());
    let size = if data.len() as i64 > 0 {
        data.len() as i64
    } else {
        meta.as_ref().map(|m| m.size).unwrap_or(0)
    };

    let file_path = cache::cache_file_path(
        &cache_root,
        account_id,
        message_id,
        &attachment_id,
        &filename,
    );
    let written = cache::write_cache_file(&file_path, &data)?;

    // 5. Record local_path + cache_size so the next call is a cache hit.
    let path_str = file_path.to_string_lossy().into_owned();
    if let Err(e) = attachments::set_cached_path(pool, &attachment_id, &path_str, written as i64).await {
        log::warn!("[attachment-cache] failed to record local_path for {attachment_id}: {e} — file cached but will be re-fetched next time");
    }

    Ok(cache::CachedAttachment {
        file_path: path_str,
        filename,
        mime_type,
        size,
    })
}

/// Fetch a single attachment part (by IMAP section `part_id`), returning a
/// cached file path (no base64 over IPC). Resolves the account's IMAP config
/// server-side so the frontend only needs accountId + messageId + partId.
/// First call fetches + caches; subsequent calls return the path (no network).
#[tauri::command]
pub async fn sync_fetch_attachment(
    engine: State<'_, Arc<SyncEngine>>,
    pool: State<'_, SqlitePool>,
    account_id: String,
    message_id: String,
    part_id: String,
) -> Result<crate::attachment_cache::CachedAttachment, String> {
    sync_fetch_attachment_inner(engine.inner().clone(), pool.inner(), &account_id, &message_id, &part_id)
        .await
}

/// Testable core of [`sync_fetch_inline_images`]. Cache-check → fetch-on-miss
/// → return a list of `CachedInlineImage` (file paths, no base64 over IPC).
///
/// **Cache check:** queries `attachments` for inline CID parts
/// (`is_inline = 1 AND content_id IS NOT NULL`). If every part has a
/// `local_path` whose file exists (and is within the cache root), returns the
/// paths immediately — no IMAP fetch. This is the "second open" fast path.
///
/// **Cache miss (any part uncached, or no attachment rows yet):** fetches the
/// full message once via `fetch_inline_cid_parts` (raw IMAP `BODY.PEEK[]`),
/// writes each CID part's decoded bytes to a cache file under
/// `<appData>/attachment-cache/`, records `local_path` in the `attachments`
/// row (so the next open is a cache hit), and returns the paths.
///
/// Matching: IMAP-fetched parts are matched to `attachments` rows by
/// `content_id`. A part with no DB row (body not yet fetched) still gets a
/// cache file (synthesized id) so the image renders, but its `local_path` can't
/// be recorded — the next open re-fetches until the body-fetch path populates
/// the row.
pub async fn sync_fetch_inline_images_inner(
    engine: Arc<SyncEngine>,
    pool: &SqlitePool,
    account_id: &str,
    message_id: &str,
) -> Result<Vec<crate::attachment_cache::CachedInlineImage>, String> {
    use crate::attachment_cache as cache;
    use std::collections::HashMap;

    let cache_root = engine.data_dir.join("attachment-cache");

    // 1. Query DB for inline CID parts (is_inline=1, content_id NOT NULL).
    let db_parts = attachments::list_inline_cid_parts(pool, account_id, message_id)
        .await
        .map_err(|e| format!("list inline parts for {message_id}: {e}"))?;

    // 2. Cache check: every part has local_path set AND file exists AND within
    //    cache root. If ALL parts are cached (and there's at least one), return
    //    immediately — no IMAP fetch. This is the second-open fast path.
    let mut cached: Vec<cache::CachedInlineImage> = Vec::new();
    let mut all_cached = !db_parts.is_empty();
    for part in &db_parts {
        if let Some(ref lp) = part.local_path {
            let path = std::path::Path::new(lp);
            if path.exists() && cache::path_is_within_cache(path, &cache_root) {
                cached.push(cache::CachedInlineImage {
                    content_id: part.content_id.clone(),
                    file_path: lp.clone(),
                    mime_type: part
                        .mime_type
                        .clone()
                        .unwrap_or_else(|| "application/octet-stream".to_string()),
                    size: part.size as u64,
                });
                continue;
            }
        }
        all_cached = false;
    }
    if all_cached {
        return Ok(cached);
    }

    // 3. Cache miss → IMAP fetch. Fetches the full message once and extracts
    //    all CID parts with their decoded bytes (no base64).
    let (folder, uid, config) =
        resolve_imap_for_message(&engine, pool, account_id, message_id).await?;
    let fetched =
        crate::mail::imap::client::fetch_inline_cid_parts(&config, &folder, uid).await?;

    // Build content_id → db_part lookup for cache-path construction + DB update.
    let db_by_cid: HashMap<&str, &attachments::InlineCidPartRow> =
        db_parts.iter().map(|p| (p.content_id.as_str(), p)).collect();

    let mut out: Vec<cache::CachedInlineImage> = Vec::with_capacity(fetched.len());
    for f in fetched {
        // Match to DB row by content_id for the cache filename + local_path
        // update. A part with no row still gets cached to a synthesized path.
        let (attachment_id, filename) = match db_by_cid.get(f.content_id.as_str()) {
            Some(row) => (
                row.id.clone(),
                row.filename
                    .clone()
                    .unwrap_or_else(|| derive_inline_filename(&f.mime_type)),
            ),
            None => {
                log::warn!(
                    "[inline-cache] no attachments row for {}/{}/cid={}: \
                     file cached but local_path not recorded",
                    account_id,
                    message_id,
                    f.content_id
                );
                (
                    format!("{account_id}_{message_id}_inline_{}", f.content_id),
                    derive_inline_filename(&f.mime_type),
                )
            }
        };

        let file_path = cache::cache_file_path(
            &cache_root,
            account_id,
            message_id,
            &attachment_id,
            &filename,
        );
        let written = cache::write_cache_file(&file_path, &f.bytes)?;
        let path_str = file_path.to_string_lossy().into_owned();

        // Record local_path so the next open is a cache hit. Only when we have
        // a DB row to UPDATE (content_id matched).
        if db_by_cid.contains_key(f.content_id.as_str()) {
            if let Err(e) =
                attachments::set_cached_path(pool, &attachment_id, &path_str, written as i64).await
            {
                log::warn!(
                    "[inline-cache] failed to record local_path for {attachment_id}: {e}"
                );
            }
        }

        out.push(cache::CachedInlineImage {
            content_id: f.content_id,
            file_path: path_str,
            mime_type: f.mime_type,
            size: written,
        });
    }

    Ok(out)
}

/// Map a MIME type to a fallback filename for an inline image with no DB
/// `filename` (e.g., a CID part whose Content-Disposition had no filename).
/// Keeps the cache path debuggable (`inline-image.png` vs `inline-image.bin`).
fn derive_inline_filename(mime_type: &str) -> String {
    let ext = match mime_type {
        "image/png" => "png",
        "image/jpeg" | "image/jpg" => "jpg",
        "image/gif" => "gif",
        "image/webp" => "webp",
        "image/svg+xml" => "svg",
        "image/bmp" => "bmp",
        "image/x-icon" | "image/vnd.microsoft.icon" => "ico",
        "image/tiff" => "tiff",
        _ => "bin",
    };
    format!("inline-image.{ext}")
}

/// Fetch every inline `cid:` image for a message. Cache-check → fetch-on-miss
/// → return file paths (no base64). First open fetches + caches; subsequent
/// opens return cached paths immediately (no network). The frontend builds a
/// `cid → convertFileSrc(path)` map for rendering.
#[tauri::command]
pub async fn sync_fetch_inline_images(
    engine: State<'_, Arc<SyncEngine>>,
    pool: State<'_, SqlitePool>,
    account_id: String,
    message_id: String,
) -> Result<Vec<crate::attachment_cache::CachedInlineImage>, String> {
    sync_fetch_inline_images_inner(engine.inner().clone(), pool.inner(), &account_id, &message_id)
        .await
}

/// Apply a mail mutation optimistically (local DB), then enqueue one
/// `pending_operations` row per affected message for the replay worker, then
/// nudge the worker. This is the single frontend entry point for every mail
/// write (mark-read, flag, move, delete, send).
///
/// **Order is load-bearing:** local-apply happens BEFORE the rows are enqueued,
/// so the UI reflects the change immediately even if the worker is mid-replay.
/// If enqueue fails after a partial local-apply, the user-visible state is
/// consistent with "applied locally, will sync later" — the next replay round
/// reconciles. We do NOT roll back the local write on enqueue failure because
/// the optimistic update is the whole point.
///
/// **Resource IDs:** one row per affected `message_id` (the per-message write
/// lock). `Send` has no message id yet, so a single row keyed by `send:{uuid}`
/// is enqueued instead.
///
/// The Tauri `State` wrapper is intentionally thin — all logic lives in
/// [`apply_mutation_inner`] so it is unit-testable without a `State` harness.
#[tauri::command]
pub async fn sync_apply_mutation(
    engine: State<'_, Arc<SyncEngine>>,
    pool: State<'_, SqlitePool>,
    account_id: String,
    op: MutationOp,
) -> Result<(), String> {
    apply_mutation_inner(engine.inner().clone(), pool.inner(), account_id, op).await
}

/// Testable core of [`sync_apply_mutation`]. Takes a borrowed pool and an
/// `Arc<SyncEngine>` (the engine is only used for the best-effort nudge).
pub async fn apply_mutation_inner(
    engine: Arc<SyncEngine>,
    pool: &SqlitePool,
    account_id: String,
    op: MutationOp,
) -> Result<(), String> {
    let op_type = op.op_type();
    // For Send the draft_id is the load-bearing trace id; for the other ops
    // the per-message resource_ids identify the affected rows.
    let trace_id = match &op {
        MutationOp::Send { draft } => format!("draft_id={}", draft.draft_id),
        _ => format!("affected={}", op.resource_id()),
    };
    log::info!(
        "[send] apply_mutation_inner ENTER account_id={account_id} op_type={op_type} {trace_id}"
    );

    // 1. Optimistic local write (single transaction; rolls back on error).
    let affected = op.local_writes(pool, &account_id).await?;

    // 1b. Best-effort filesystem cleanup of per-message attachment cache dirs
    //     for Delete. The DB rows cascade-delete (FK ON DELETE CASCADE); the
    //     cache files on disk do NOT — without this the bytes leak every time
    //     a message is deleted. Runs AFTER `local_writes` returns Ok so the
    //     transaction is committed; cleanup failure does NOT fail the mutation
    //     (the user's intent — delete the message — has already taken effect
    //     locally). `ErrorKind::NotFound` is silently OK: the message may have
    //     had no cached attachments (header-only fetch, never opened).
    if let MutationOp::Delete { message_ids, .. } = &op {
        let cache_root = engine.data_dir.join("attachment-cache");
        for mid in message_ids {
            let dir = crate::attachment_cache::message_cache_dir(&cache_root, &account_id, mid);
            if let Err(e) = std::fs::remove_dir_all(&dir) {
                if e.kind() != std::io::ErrorKind::NotFound {
                    log::warn!(
                        "[attachment-cache] failed to clean up cache dir for {mid}: {e}"
                    );
                }
            }
        }
    }

    // 2. Enqueue one row per affected message. Send has no message_id → one row
    //    keyed by a generated "send:{uuid}".
    let ids: Vec<String> = if affected.is_empty() {
        vec![format!("send:{}", uuid::Uuid::new_v4())]
    } else {
        affected.clone()
    };
    for rid in &ids {
        let params = op.encode_params(rid);
        log::info!(
            "[send] enqueued op account_id={account_id} op_type={op_type} resource_id={rid}"
        );
        queue::enqueue(pool, &account_id, op.op_type(), rid, &params).await?;
    }

    // 3. Nudge the worker to replay ONLY (best-effort, non-blocking). Mutations
    //    (markRead, send, etc.) don't need a full folder sync — just the replay
    //    worker to process the queued op. This avoids a folder sweep + StatusBar
    //    "syncing" flash when the user selects an unread message (markRead).
    log::info!(
        "[send] nudging worker account_id={account_id} op_type={op_type} (ReplayNow → run_replay_round ONLY)"
    );
    engine.sync_replay_now(account_id.clone()).await;
    log::info!(
        "[send] apply_mutation_inner EXIT account_id={account_id} op_type={op_type}"
    );
    Ok(())
}

/// Walk the attachment cache directory and remove orphan entries (message
/// dirs whose `messages` row is gone), plus NULL out `attachments.local_path`
/// values that point at files no longer on disk. Returns [`ReconcileStats`]
/// describing what was cleaned up. Safe to call repeatedly — idempotent.
///
/// Intended as a startup backstop (Task D2 will wire it on app launch) and
/// as the engine behind a future "Reclaim cache space" UI action. Not on any
/// hot path — the reconcile pass is sync filesystem I/O + one indexed
/// `messages` SELECT per on-disk message dir.
///
/// Delegates to [`crate::attachment_cache::reconcile_cache`] with
/// `<data_dir>/attachment-cache/` as the cache root.
#[tauri::command]
pub async fn reconcile_attachment_cache(
    engine: State<'_, Arc<SyncEngine>>,
    pool: State<'_, SqlitePool>,
) -> Result<crate::attachment_cache::ReconcileStats, String> {
    let cache_root = engine.data_dir.join("attachment-cache");
    crate::attachment_cache::reconcile_cache(&cache_root, pool.inner()).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::init_db;
    use crate::sync_engine::engine::{
        BodiesWrittenEvent, CryptoResultEvent, DeltaEvent, EventSink, NewMailEvent, QueueEvent,
        SendResultEvent, StatusEvent, SyncEngine,
    };
    use std::sync::{Arc, Mutex};

    /// Sink that discards every event — we only need the engine to exist for the
    /// nudge; we do not assert on events here.
    struct NullSink;
    impl EventSink for NullSink {
        fn emit_delta(&self, _: DeltaEvent) {}
        fn emit_new_mail(&self, _: NewMailEvent) {}
        fn emit_status(&self, _: StatusEvent) {}
        fn emit_queue(&self, _: QueueEvent) {}
        fn emit_bodies_written(&self, _: BodiesWrittenEvent) {}
        fn emit_send_result(&self, _: SendResultEvent) {}
        fn emit_crypto_result(&self, _: CryptoResultEvent) {}
    }

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

    async fn seed_thread_with_message(
        pool: &SqlitePool,
        account_id: &str,
        thread_id: &str,
        folder: &str,
        uid: u32,
    ) {
        seed_thread_with_messages(pool, account_id, thread_id, folder, &[uid]).await;
    }

    /// Insert one thread row + a message row per uid. Reusable across the
    /// apply-mutation tests so multi-message ops (markRead on a 2-message
    /// thread) can be seeded in one call without tripping the threads UNIQUE
    /// constraint.
    async fn seed_thread_with_messages(
        pool: &SqlitePool,
        account_id: &str,
        thread_id: &str,
        folder: &str,
        uids: &[u32],
    ) {
        sqlx::query(
            "INSERT INTO threads (id, account_id, subject, is_read, is_starred)
             VALUES (?, ?, 'test', 0, 0)",
        )
        .bind(thread_id)
        .bind(account_id)
        .execute(pool)
        .await
        .unwrap();
        for uid in uids {
            let mid = format!("imap-{account_id}-{folder}-{uid}");
            sqlx::query(
                "INSERT INTO messages
                 (id, account_id, thread_id, subject, date, is_read, is_starred, imap_uid, imap_folder)
                 VALUES (?, ?, ?, 'm', 1000, 0, 0, ?, ?)",
            )
            .bind(&mid)
            .bind(account_id)
            .bind(thread_id)
            .bind(*uid as i64)
            .bind(folder)
            .execute(pool)
            .await
            .unwrap();
        }
    }

    fn msg_id(account_id: &str, folder: &str, uid: u32) -> String {
        format!("imap-{account_id}-{folder}-{uid}")
    }

    #[tokio::test]
    async fn apply_mutation_markread_applies_locally_and_enqueues_per_message() {
        let tmp = tempfile::tempdir().unwrap();
        let pool = init_db(tmp.path()).await.unwrap();
        seed_account(&pool, "acct").await;
        seed_thread_with_messages(&pool, "acct", "thr", "INBOX", &[10, 11]).await;
        let engine = SyncEngine::new(pool.clone(), Arc::new(NullSink));

        let mids = vec![msg_id("acct", "INBOX", 10), msg_id("acct", "INBOX", 11)];
        let op = MutationOp::MarkRead {
            thread_id: "thr".into(),
            message_ids: mids.clone(),
            folder_path: "INBOX".into(),
            uids: vec![10, 11],
            read: true,
        };
        apply_mutation_inner(engine, &pool, "acct".into(), op)
            .await
            .unwrap();

        // Local: thread + messages now read.
        let (tr,): (i64,) =
            sqlx::query_as("SELECT is_read FROM threads WHERE account_id='acct' AND id='thr'")
                .fetch_one(&pool)
                .await
                .unwrap();
        assert_eq!(tr, 1);

        // Queue: one row per affected message_id, op_type=markRead, params has read=1.
        let rows: Vec<(String, String, String)> = sqlx::query_as(
            "SELECT resource_id, operation_type, params FROM pending_operations
             WHERE account_id='acct' ORDER BY resource_id",
        )
        .fetch_all(&pool)
        .await
        .unwrap();
        assert_eq!(rows.len(), 2, "one row per affected message");
        let rids: Vec<&str> = rows.iter().map(|r| r.0.as_str()).collect();
        assert!(rids.contains(&mids[0].as_str()));
        assert!(rids.contains(&mids[1].as_str()));
        for (_, op_type, params) in &rows {
            assert_eq!(op_type, "markRead");
            let p: serde_json::Value = serde_json::from_str(params).unwrap();
            assert_eq!(p["read"], 1);
        }
    }

    #[tokio::test]
    async fn apply_mutation_send_enqueues_single_send_row_with_uuid_resource() {
        let tmp = tempfile::tempdir().unwrap();
        let pool = init_db(tmp.path()).await.unwrap();
        seed_account(&pool, "acct").await;
        let engine = SyncEngine::new(pool.clone(), Arc::new(NullSink));

        let op = MutationOp::Send {
            draft: Box::new(crate::mail::builder::SendDraft {
                draft_id: "d1".into(),
                from: crate::mail::builder::AddressSpec {
                    name: None,
                    email: "a@b".into(),
                },
                to: vec![crate::mail::builder::AddressSpec {
                    name: None,
                    email: "c@d".into(),
                }],
                subject: "s".into(),
                text_body: Some("body".into()),
                ..Default::default()
            }),
        };
        apply_mutation_inner(engine, &pool, "acct".into(), op)
            .await
            .unwrap();

        let rows: Vec<(String, String)> = sqlx::query_as(
            "SELECT resource_id, operation_type FROM pending_operations WHERE account_id='acct'",
        )
        .fetch_all(&pool)
        .await
        .unwrap();
        assert_eq!(rows.len(), 1, "Send enqueues exactly one row");
        assert!(
            rows[0].0.starts_with("send:"),
            "resource_id starts with 'send:'"
        );
        assert_eq!(rows[0].1, "send");
    }

    #[tokio::test]
    async fn apply_mutation_delete_removes_messages_and_enqueues_delete_rows() {
        let tmp = tempfile::tempdir().unwrap();
        let pool = init_db(tmp.path()).await.unwrap();
        seed_account(&pool, "acct").await;
        seed_thread_with_message(&pool, "acct", "thr", "INBOX", 5).await;
        let engine = SyncEngine::new(pool.clone(), Arc::new(NullSink));

        let mid = msg_id("acct", "INBOX", 5);
        let op = MutationOp::Delete {
            message_ids: vec![mid.clone()],
            folder_path: "INBOX".into(),
            uids: vec![5],
        };
        apply_mutation_inner(engine, &pool, "acct".into(), op)
            .await
            .unwrap();

        // Message gone.
        let (mn,): (i64,) = sqlx::query_as("SELECT COUNT(*) FROM messages WHERE account_id='acct'")
            .fetch_one(&pool)
            .await
            .unwrap();
        assert_eq!(mn, 0);

        // Queue row.
        let (rid, op_type): (String, String) = sqlx::query_as(
            "SELECT resource_id, operation_type FROM pending_operations WHERE account_id='acct'",
        )
        .fetch_one(&pool)
        .await
        .unwrap();
        assert_eq!(rid, mid);
        assert_eq!(op_type, "delete");
    }

    /// Task B1: deleting a message removes its per-message attachment cache
    /// dir from disk (best-effort). The DB rows cascade-delete via FK; the
    /// cache files on disk do NOT — without this cleanup the bytes would leak
    /// every time a message is deleted. Verifies the exact scenario from the
    /// B1 spec: a cache file exists on disk before the Delete op, and is gone
    /// after.
    ///
    /// Uses [`SyncEngine::with_data_dir`] so the engine's `data_dir` matches
    /// the tempdir the test seeds the cache under (`SyncEngine::new` defaults
    /// `data_dir` to `std::env::temp_dir()`, which would NOT match and the
    /// cleanup would target the wrong path — passing the test vacuously while
    /// leaving the real tempdir cache intact).
    #[tokio::test]
    async fn apply_mutation_delete_cleans_up_attachment_cache_dir() {
        use crate::attachment_cache::{cache_file_path, message_cache_dir};

        let tmp = tempfile::tempdir().unwrap();
        let pool = init_db(tmp.path()).await.unwrap();
        seed_account(&pool, "acct").await;
        seed_thread_with_message(&pool, "acct", "thr", "INBOX", 5).await;
        let engine = SyncEngine::with_data_dir(
            pool.clone(),
            Arc::new(NullSink),
            tmp.path().to_path_buf(),
        );

        let mid = msg_id("acct", "INBOX", 5);
        // Seed the per-message cache dir exactly as `sync_fetch_attachment`
        // would: `<data_dir>/attachment-cache/{account}/{shard}/{mid}/...`.
        let cache_root = tmp.path().join("attachment-cache");
        let msg_cache_dir = message_cache_dir(&cache_root, "acct", &mid);
        let cached_file = cache_file_path(
            &cache_root,
            "acct",
            &mid,
            "acct_imap-acct-INBOX-5_2",
            "report.pdf",
        );
        std::fs::create_dir_all(&msg_cache_dir).unwrap();
        std::fs::write(&cached_file, b"pretend-pdf-bytes").unwrap();
        assert!(cached_file.exists(), "precondition: cached file exists");
        assert!(msg_cache_dir.exists(), "precondition: cache dir exists");

        let op = MutationOp::Delete {
            message_ids: vec![mid.clone()],
            folder_path: "INBOX".into(),
            uids: vec![5],
        };
        apply_mutation_inner(engine, &pool, "acct".into(), op)
            .await
            .unwrap();

        // Cache dir + file are gone (best-effort cleanup ran).
        assert!(
            !msg_cache_dir.exists(),
            "per-message attachment cache dir must be removed on delete"
        );
        assert!(
            !cached_file.exists(),
            "cached attachment file must be removed on delete"
        );

        // Message row is gone too (cascade-delete contract from the original
        // delete test — we re-assert here so a regression in either the FS
        // cleanup OR the DB delete surfaces in this test).
        let (mn,): (i64,) =
            sqlx::query_as("SELECT COUNT(*) FROM messages WHERE account_id='acct'")
                .fetch_one(&pool)
                .await
                .unwrap();
        assert_eq!(mn, 0);
    }

    /// Task B1 negative case: deleting a message whose attachment cache dir
    /// does NOT exist (header-only fetch, never opened) must not fail the
    /// mutation. The `ErrorKind::NotFound` branch is silently OK. Pins
    /// acceptance criterion #2.
    #[tokio::test]
    async fn apply_mutation_delete_succeeds_when_cache_dir_missing() {
        let tmp = tempfile::tempdir().unwrap();
        let pool = init_db(tmp.path()).await.unwrap();
        seed_account(&pool, "acct").await;
        seed_thread_with_message(&pool, "acct", "thr", "INBOX", 7).await;
        let engine = SyncEngine::with_data_dir(
            pool.clone(),
            Arc::new(NullSink),
            tmp.path().to_path_buf(),
        );
        // Note: NO cache dir created under tmp/attachment-cache — the cleanup
        // will hit NotFound and must swallow it silently.

        let mid = msg_id("acct", "INBOX", 7);
        let op = MutationOp::Delete {
            message_ids: vec![mid.clone()],
            folder_path: "INBOX".into(),
            uids: vec![7],
        };
        apply_mutation_inner(engine, &pool, "acct".into(), op)
            .await
            .expect("delete must succeed when cache dir is absent");

        // Message row gone — proves the mutation committed despite the
        // NotFound from the cleanup attempt.
        let (mn,): (i64,) =
            sqlx::query_as("SELECT COUNT(*) FROM messages WHERE account_id='acct'")
                .fetch_one(&pool)
                .await
                .unwrap();
        assert_eq!(mn, 0);
    }

    // ---- sync_request_bodies (on-demand body fetch) ----

    /// Empty input is a no-op — never reaches the source factory (which would
    /// fail for an account whose provider has no row, e.g. a fresh test DB).
    #[tokio::test]
    async fn request_bodies_inner_empty_input_is_noop() {
        let tmp = tempfile::tempdir().unwrap();
        let pool = init_db(tmp.path()).await.unwrap();
        let engine = SyncEngine::new(
            pool.clone(),
            std::sync::Arc::new(NullSink),
        );
        // Note: no account seeded — the empty-input early return must fire
        // before `source_for_account` is ever called.
        request_bodies_inner(engine, &pool, "acct", &[])
            .await
            .expect("empty input must short-circuit to Ok");
    }

    /// Missing-message rows are skipped silently (the contract the frontend
    /// relies on: opening a not-yet-synced thread does not throw). Seeds the
    /// account so the source factory can resolve it, but passes message ids
    /// that have no `messages` row — every iteration hits the None branch.
    #[tokio::test]
    async fn request_bodies_inner_skips_missing_message_rows_without_aborting() {
        let tmp = tempfile::tempdir().unwrap();
        let pool = init_db(tmp.path()).await.unwrap();
        seed_account(&pool, "acct").await;
        let engine = SyncEngine::new(
            pool.clone(),
            std::sync::Arc::new(NullSink),
        );

        request_bodies_inner(
            engine,
            &pool,
            "acct",
            &["missing-1".into(), "missing-2".into()],
        )
        .await
        .expect("best-effort: missing rows must not abort the batch");

        // Nothing persisted.
        let (n,): (i64,) = sqlx::query_as("SELECT COUNT(*) FROM message_bodies")
            .fetch_one(&pool)
            .await
            .unwrap();
        assert_eq!(n, 0);
    }

    // ---- Task 2: batch-per-folder grouping + bodies-written emission ----

    /// EventSink that captures `BodiesWrittenEvent`s for assertion. The other
    /// event kinds are discarded — Task 2 only asserts on bodies-written.
    #[derive(Default, Clone)]
    struct CapturingSink {
        bodies: Arc<Mutex<Vec<BodiesWrittenEvent>>>,
    }
    impl EventSink for CapturingSink {
        fn emit_delta(&self, _: DeltaEvent) {}
        fn emit_new_mail(&self, _: NewMailEvent) {}
        fn emit_status(&self, _: StatusEvent) {}
        fn emit_queue(&self, _: QueueEvent) {}
        fn emit_bodies_written(&self, e: BodiesWrittenEvent) {
            self.bodies.lock().unwrap().push(e);
        }
        fn emit_send_result(&self, _: SendResultEvent) {}
        fn emit_crypto_result(&self, _: CryptoResultEvent) {}
    }

    /// Pure folder-grouping sanity: given a list of (message_id, folder, uid)
    /// tuples, produce a map folder -> [(message_id, uid)]. This is the shape
    /// `request_bodies_inner` builds before issuing one
    /// `fetch_bodies_batch` per folder. The end-to-end batched fetch needs a
    /// live IMAP socket (Task 5 ignored integration test), so this unit test
    /// pins only the bucketing the loop relies on.
    #[test]
    fn group_message_ids_by_folder_buckets_by_imap_folder() {
        use std::collections::HashMap;
        let inputs = vec![
            ("imap-a-INBOX-1", "INBOX", 1u32),
            ("imap-a-INBOX-2", "INBOX", 2),
            ("imap-a-Sent-9", "Sent", 9),
        ];
        let mut buckets: HashMap<&str, Vec<(&str, u32)>> = HashMap::new();
        for (mid, folder, uid) in &inputs {
            buckets.entry(folder).or_default().push((mid, *uid));
        }
        assert_eq!(buckets["INBOX"].len(), 2);
        assert_eq!(buckets["Sent"].len(), 1);
    }

    /// When `request_bodies_inner` resolves no source (e.g. the account's
    /// provider is not imap/eas) the call surfaces the factory's Err — but the
    /// sink must NOT have emitted any bodies-written event (we never reached
    /// the batch loop). Pins the "no partial emit on factory failure" contract
    /// the frontend relies on.
    #[tokio::test]
    async fn request_bodies_inner_does_not_emit_when_source_factory_fails() {
        let tmp = tempfile::tempdir().unwrap();
        let pool = init_db(tmp.path()).await.unwrap();
        // No account seeded -> source_for_account returns Err.
        let sink = Arc::new(CapturingSink::default());
        let engine = SyncEngine::new(pool.clone(), sink.clone());
        // Seed an account with an unsupported provider + a phantom thread +
        // messages row so by_folder is non-empty and we reach the source
        // factory. (Unsupported provider -> factory Err; no batch loop.) The
        // account row satisfies the FK on threads.account_id.
        sqlx::query(
            "INSERT INTO accounts (id, email, provider)
             VALUES ('acct', 'acct@x.com', 'carrier-pigeon')",
        )
        .execute(&pool)
        .await
        .unwrap();
        sqlx::query(
            "INSERT INTO threads (id, account_id, subject, is_read, is_starred)
             VALUES ('imap-acct-INBOX-1', 'acct', 'p', 0, 0)",
        )
        .execute(&pool)
        .await
        .unwrap();
        sqlx::query(
            "INSERT INTO messages (id, account_id, thread_id, date, is_read, is_starred,
                imap_uid, imap_folder)
             VALUES ('imap-acct-INBOX-1', 'acct', 'imap-acct-INBOX-1', 0, 0, 0, 1, 'INBOX')",
        )
        .execute(&pool)
        .await
        .unwrap();

        let _ = request_bodies_inner(
            engine,
            &pool,
            "acct",
            &["imap-acct-INBOX-1".into()],
        )
        .await;

        assert!(
            sink.bodies.lock().unwrap().is_empty(),
            "no bodies-written event when source factory fails"
        );
    }
}
