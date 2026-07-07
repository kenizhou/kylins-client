// Ported from velo (https://github.com/avihaymenahem/velo)
// Licensed under Apache-2.0. See ATTRIBUTIONS.md.

use crate::mail::imap::client as imap_client;
use crate::mail::imap::types::{
    DeltaCheckRequest, DeltaCheckResult, ImapConfig, ImapFetchResult, ImapFolder,
    ImapFolderSearchResult, ImapFolderStatus, ImapFolderSyncResult, ImapMessage,
};
use crate::mail::smtp::client as smtp_client;
use crate::mail::smtp::types::{SmtpConfig, SmtpSendResult};
use serde::Serialize;
use tauri::Manager;
use tauri_plugin_autostart::ManagerExt as _;
use tauri_plugin_notification::NotificationExt as _;

// ---------- App commands ----------

#[tauri::command]
pub fn set_tray_tooltip(app: tauri::AppHandle, tooltip: String) -> Result<(), String> {
    #[cfg(not(target_os = "linux"))]
    {
        use tauri::tray::TrayIconId;
        let tray = app
            .tray_by_id(&TrayIconId::new("main-tray"))
            .ok_or_else(|| "Tray icon not found".to_string())?;
        tray.set_tooltip(Some(&tooltip)).map_err(|e| e.to_string())
    }
    #[cfg(target_os = "linux")]
    {
        let _ = tooltip;
        let _ = app;
        log::debug!("set_tray_tooltip is not supported on Linux (KSNI tray)");
        Ok(())
    }
}

#[tauri::command]
pub fn open_devtools(app: tauri::AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        window.open_devtools();
    }
}

#[tauri::command]
pub fn encrypt_secret(plaintext: String) -> Result<String, String> {
    crate::crypto::encrypt(&plaintext)
}

#[tauri::command]
pub fn decrypt_secret(ciphertext: String) -> Result<String, String> {
    crate::crypto::decrypt(&ciphertext)
}

#[tauri::command]
pub fn read_text_file(path: String) -> Result<String, String> {
    std::fs::read_to_string(&path).map_err(|e| format!("failed to read {path}: {e}"))
}

#[tauri::command]
pub fn write_text_file(path: String, data: String) -> Result<(), String> {
    std::fs::write(&path, data).map_err(|e| format!("failed to write {path}: {e}"))
}

/// Write base64-decoded bytes to `path`. Used by the attachment download flow
/// (frontend `save()` dialog → this command) so the app doesn't need the
/// `@tauri-apps/plugin-fs` JS package for binary writes.
#[tauri::command]
pub fn write_binary_file(path: String, data_base64: String) -> Result<(), String> {
    let bytes = base64::Engine::decode(
        &base64::engine::general_purpose::STANDARD,
        data_base64.as_bytes(),
    )
    .map_err(|e| format!("invalid base64: {e}"))?;
    std::fs::write(&path, bytes).map_err(|e| format!("failed to write {path}: {e}"))
}

/// Result of staging a picked attachment: the absolute destination path the
/// frontend should reference on the `ComposerAttachment`, plus the inferred
/// mime type and the byte size, so the chip can render without a second IPC
/// round-trip.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StagedAttachment {
    pub file_path: String,
    pub mime_type: String,
    pub size: u64,
}

/// Stage a file picked via the dialog (`@tauri-apps/plugin-dialog` `open`)
/// into the per-draft outbox under `<appData>/outbox-attachments/{draft_id}/`.
///
/// The dialog returns paths the frontend `@tauri-apps/plugin-fs` capability
/// cannot read — the `fs:allow-appdata-read/write-recursive` scope in
/// `capabilities/default.json` only covers `$APPDATA`, so an arbitrary source
/// path picked from anywhere on disk cannot be `copyFile`'d by the frontend.
/// This command does the copy via `std::fs` which has full filesystem access.
///
/// The filename is sanitized (path separators / reserved chars stripped)
/// before joining onto the outbox so a hostile `filename` cannot escape the
/// directory. Returns the absolute dest path, the mime type inferred from the
/// extension, and the byte size from dest metadata.
#[tauri::command]
pub async fn stage_picked_attachment(
    src_path: String,
    draft_id: String,
    filename: String,
    app: tauri::AppHandle,
) -> Result<StagedAttachment, String> {
    let data_dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("failed to resolve app data dir: {e}"))?;
    let outbox = data_dir
        .join("outbox-attachments")
        .join(&draft_id);
    std::fs::create_dir_all(&outbox)
        .map_err(|e| format!("failed to create outbox dir {outbox:?}: {e}"))?;
    let safe_name = sanitize_attachment_filename(&filename);
    let dest = outbox.join(&safe_name);
    std::fs::copy(&src_path, &dest)
        .map_err(|e| format!("failed to copy attachment {src_path:?} -> {dest:?}: {e}"))?;
    let size = std::fs::metadata(&dest).map(|m| m.len()).unwrap_or(0);
    let mime_type = infer_mime_type(&safe_name);
    Ok(StagedAttachment {
        file_path: dest.to_string_lossy().into_owned(),
        mime_type,
        size,
    })
}

/// Strip path separators and shell-dangerous characters from a user-supplied
/// filename so it is safe to join onto the outbox/cache directory. Rejects `.`
/// and `..` (which would otherwise traverse the directory tree) and any name
/// that becomes empty after sanitization; both fall back to `attachment`.
pub(crate) fn sanitize_attachment_filename(name: &str) -> String {
    let cleaned: String = name
        .chars()
        .map(|c| match c {
            '\\' | '/' | ':' | '*' | '?' | '"' | '<' | '>' | '|' => '_',
            _ => c,
        })
        .collect::<String>()
        .trim()
        .to_owned();
    if cleaned.is_empty() || cleaned == "." || cleaned == ".." {
        "attachment".to_owned()
    } else {
        cleaned
    }
}

/// Map a filename extension to a mime type. Covers the common document,
/// image, archive, and media types a user is likely to attach; unknown
/// extensions fall back to `application/octet-stream`.
fn infer_mime_type(filename: &str) -> String {
    let lower = filename.to_ascii_lowercase();
    let ext = lower.rsplit('.').next().unwrap_or("");
    match ext {
        "pdf" => "application/pdf",
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "svg" => "image/svg+xml",
        "doc" => "application/msword",
        "docx" => "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        "xls" => "application/vnd.ms-excel",
        "xlsx" => "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        "ppt" => "application/vnd.ms-powerpoint",
        "pptx" => "application/vnd.openxmlformats-officedocument.presentationml.presentation",
        "zip" => "application/zip",
        "7z" => "application/x-7z-compressed",
        "tar" => "application/x-tar",
        "gz" => "application/gzip",
        "txt" => "text/plain",
        "md" => "text/markdown",
        "html" | "htm" => "text/html",
        "csv" => "text/csv",
        "json" => "application/json",
        "xml" => "application/xml",
        "mp3" => "audio/mpeg",
        "wav" => "audio/wav",
        "mp4" => "video/mp4",
        "avi" => "video/x-msvideo",
        "mov" => "video/quicktime",
        "eml" => "message/rfc822",
        _ => "application/octet-stream",
    }
    .to_owned()
}

// ---------- Startup / notification / storage commands ----------

#[tauri::command]
pub fn get_autostart_state(app: tauri::AppHandle) -> Result<bool, String> {
    app.autolaunch()
        .is_enabled()
        .map_err(|e| format!("failed to read autostart state: {e}"))
}

#[tauri::command]
pub fn set_autostart_enabled(app: tauri::AppHandle, enabled: bool) -> Result<(), String> {
    let autolaunch = app.autolaunch();
    if enabled {
        autolaunch.enable().map_err(|e| e.to_string())
    } else {
        autolaunch.disable().map_err(|e| e.to_string())
    }
}

/// Send a desktop notification from Rust so that Windows toast attribution uses
/// the correct AppUserModelID (com.mailclient.app) instead of "Windows PowerShell".
#[tauri::command]
pub fn send_desktop_notification(app: tauri::AppHandle, title: String, body: String) {
    let _ = app
        .notification()
        .builder()
        .title(&title)
        .body(&body)
        .show();
}

#[tauri::command]
pub fn request_notification_permission(app: tauri::AppHandle) -> Result<bool, String> {
    let state = app
        .notification()
        .permission_state()
        .map_err(|e| format!("failed to read notification permission: {e}"))?;
    let granted = matches!(state, tauri_plugin_notification::PermissionState::Granted);
    if granted {
        return Ok(true);
    }
    let requested = app
        .notification()
        .request_permission()
        .map_err(|e| format!("failed to request notification permission: {e}"))?;
    Ok(matches!(
        requested,
        tauri_plugin_notification::PermissionState::Granted
    ))
}

fn dir_size(path: &std::path::Path) -> std::io::Result<u64> {
    let mut total: u64 = 0;
    let metadata = path.metadata()?;
    if metadata.is_file() {
        total += metadata.len();
    } else if metadata.is_dir() {
        for entry in std::fs::read_dir(path)? {
            let entry = entry?;
            let metadata = entry.metadata()?;
            if metadata.is_file() {
                total += metadata.len();
            } else if metadata.is_dir() {
                total += dir_size(&entry.path())?;
            }
        }
    }
    Ok(total)
}

#[tauri::command]
pub fn get_cache_size(app: tauri::AppHandle) -> Result<u64, String> {
    let cache_dir = app
        .path()
        .app_cache_dir()
        .map_err(|e| format!("failed to resolve cache dir: {e}"))?;
    if !cache_dir.exists() {
        return Ok(0);
    }
    dir_size(&cache_dir).map_err(|e| format!("failed to compute cache size: {e}"))
}

#[tauri::command]
pub fn clear_cache(app: tauri::AppHandle) -> Result<(), String> {
    let cache_dir = app
        .path()
        .app_cache_dir()
        .map_err(|e| format!("failed to resolve cache dir: {e}"))?;
    if !cache_dir.exists() {
        return Ok(());
    }
    for entry in
        std::fs::read_dir(&cache_dir).map_err(|e| format!("failed to read cache dir: {e}"))?
    {
        let entry = entry.map_err(|e| format!("failed to read cache entry: {e}"))?;
        let path = entry.path();
        if path.is_dir() {
            std::fs::remove_dir_all(&path)
                .map_err(|e| format!("failed to remove {path:?}: {e}"))?;
        } else {
            std::fs::remove_file(&path).map_err(|e| format!("failed to remove {path:?}: {e}"))?;
        }
    }
    Ok(())
}

/// Copy a cached attachment file to a user-chosen save location. The frontend
/// `@tauri-apps/plugin-fs` scope only covers appData; the cache lives under
/// appData but the save destination is arbitrary (the user's Downloads, a USB
/// stick, etc.), so the copy goes through `std::fs` which has full access.
/// This is the receive-path counterpart to `stage_picked_attachment` (send
/// path) — both exist because the frontend fs plugin can't bridge appData →
/// arbitrary-disk.
#[tauri::command]
pub fn copy_cached_attachment(src_path: String, dest_path: String) -> Result<(), String> {
    let src = std::path::Path::new(&src_path);
    if !src.exists() {
        return Err(format!("source file not found: {src_path}"));
    }
    if let Some(parent) = std::path::Path::new(&dest_path).parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| format!("failed to create dest dir {parent:?}: {e}"))?;
    }
    std::fs::copy(src, &dest_path)
        .map_err(|e| format!("failed to copy {src_path} -> {dest_path}: {e}"))?;
    Ok(())
}

#[tauri::command]
pub fn reveal_logs_directory(app: tauri::AppHandle) -> Result<(), String> {
    let log_dir = app
        .path()
        .app_log_dir()
        .map_err(|e| format!("failed to resolve log dir: {e}"))?;
    if !log_dir.exists() {
        std::fs::create_dir_all(&log_dir).map_err(|e| format!("failed to create log dir: {e}"))?;
    }
    tauri_plugin_opener::open_path(&log_dir, None::<&str>)
        .map_err(|e| format!("failed to open log dir: {e}"))
}

// ---------- IMAP commands ----------

#[tauri::command]
pub async fn imap_test_connection(config: ImapConfig) -> Result<String, String> {
    imap_client::test_connection(&config).await
}

#[tauri::command]
pub async fn imap_list_folders(config: ImapConfig) -> Result<Vec<ImapFolder>, String> {
    let mut session = imap_client::connect(&config).await?;
    let folders = imap_client::list_folders(&mut session).await?;
    let _ = session.logout().await;
    Ok(folders)
}

#[tauri::command]
pub async fn imap_fetch_messages(
    config: ImapConfig,
    folder: String,
    uids: Vec<u32>,
) -> Result<ImapFetchResult, String> {
    if uids.is_empty() {
        return Err("No UIDs provided".to_string());
    }

    let uid_set: String = uids
        .iter()
        .map(|u| u.to_string())
        .collect::<Vec<_>>()
        .join(",");

    let mut session = imap_client::connect(&config).await?;
    let result = imap_client::fetch_messages(&mut session, &folder, &uid_set).await;
    let _ = session.logout().await;

    match result {
        Ok(r) => Ok(r),
        Err(e) if e.starts_with("ASYNC_IMAP_EMPTY:") => {
            log::info!("Falling back to raw TCP fetch for folder {folder}");
            imap_client::raw_fetch_messages(&config, &folder, &uid_set).await
        }
        Err(e) => Err(e),
    }
}

#[tauri::command]
pub async fn imap_fetch_new_uids(
    config: ImapConfig,
    folder: String,
    since_uid: u32,
) -> Result<Vec<u32>, String> {
    let mut session = imap_client::connect(&config).await?;
    let uids = imap_client::fetch_new_uids(&mut session, &folder, since_uid).await?;
    let _ = session.logout().await;
    Ok(uids)
}

#[tauri::command]
pub async fn imap_search_all_uids(config: ImapConfig, folder: String) -> Result<Vec<u32>, String> {
    let mut session = imap_client::connect(&config).await?;
    let uids = imap_client::search_all_uids(&mut session, &folder).await?;
    let _ = session.logout().await;
    Ok(uids)
}

#[tauri::command]
pub async fn imap_fetch_message_body(
    config: ImapConfig,
    folder: String,
    uid: u32,
) -> Result<ImapMessage, String> {
    let mut session = imap_client::connect(&config).await?;
    let message = imap_client::fetch_message_body(&mut session, &folder, uid).await?;
    let _ = session.logout().await;
    Ok(message)
}

#[tauri::command]
pub async fn imap_fetch_raw_message(
    config: ImapConfig,
    folder: String,
    uid: u32,
) -> Result<String, String> {
    let mut session = imap_client::connect(&config).await?;
    let raw = imap_client::fetch_raw_message(&mut session, &folder, uid).await?;
    let _ = session.logout().await;
    Ok(raw)
}

#[tauri::command]
pub async fn imap_set_flags(
    config: ImapConfig,
    folder: String,
    uids: Vec<u32>,
    flags: Vec<String>,
    add: bool,
) -> Result<(), String> {
    if uids.is_empty() {
        return Ok(());
    }

    let mut session = imap_client::connect(&config).await?;

    let uid_set: String = uids
        .iter()
        .map(|u| u.to_string())
        .collect::<Vec<_>>()
        .join(",");

    let flag_op = if add { "+FLAGS" } else { "-FLAGS" };

    let flags_str = format!(
        "({})",
        flags
            .iter()
            .map(|f| {
                if f.starts_with('\\') {
                    f.clone()
                } else {
                    format!("\\{f}")
                }
            })
            .collect::<Vec<_>>()
            .join(" ")
    );

    imap_client::set_flags(&mut session, &folder, &uid_set, flag_op, &flags_str).await?;
    let _ = session.logout().await;
    Ok(())
}

#[tauri::command]
pub async fn imap_copy_messages(
    config: ImapConfig,
    folder: String,
    uids: Vec<u32>,
    destination: String,
) -> Result<(), String> {
    if uids.is_empty() {
        return Ok(());
    }
    let uid_set: String = uids
        .iter()
        .map(|u| u.to_string())
        .collect::<Vec<_>>()
        .join(",");
    let mut session = imap_client::connect(&config).await?;
    imap_client::copy_messages(&mut session, &folder, &uid_set, &destination).await?;
    let _ = session.logout().await;
    Ok(())
}

#[tauri::command]
pub async fn imap_move_messages(
    config: ImapConfig,
    folder: String,
    uids: Vec<u32>,
    destination: String,
) -> Result<(), String> {
    if uids.is_empty() {
        return Ok(());
    }

    let mut session = imap_client::connect(&config).await?;

    let uid_set: String = uids
        .iter()
        .map(|u| u.to_string())
        .collect::<Vec<_>>()
        .join(",");

    imap_client::move_messages(&mut session, &folder, &uid_set, &destination).await?;
    let _ = session.logout().await;
    Ok(())
}

#[tauri::command]
pub async fn imap_delete_messages(
    config: ImapConfig,
    folder: String,
    uids: Vec<u32>,
) -> Result<(), String> {
    if uids.is_empty() {
        return Ok(());
    }

    let mut session = imap_client::connect(&config).await?;

    let uid_set: String = uids
        .iter()
        .map(|u| u.to_string())
        .collect::<Vec<_>>()
        .join(",");

    imap_client::delete_messages(&mut session, &folder, &uid_set).await?;
    let _ = session.logout().await;
    Ok(())
}

#[tauri::command]
pub async fn imap_get_folder_status(
    config: ImapConfig,
    folder: String,
) -> Result<ImapFolderStatus, String> {
    let mut session = imap_client::connect(&config).await?;
    let status = imap_client::get_folder_status(&mut session, &folder).await?;
    let _ = session.logout().await;
    Ok(status)
}

#[tauri::command]
pub async fn imap_append_message(
    config: ImapConfig,
    folder: String,
    flags: Option<String>,
    raw_message: String,
) -> Result<(), String> {
    let mut session = imap_client::connect(&config).await?;

    let raw_bytes = base64url_decode(&raw_message)?;

    let flags_ref = flags.as_deref();
    imap_client::append_message(&mut session, &folder, flags_ref, &raw_bytes).await?;
    let _ = session.logout().await;
    Ok(())
}

#[tauri::command]
pub async fn imap_create_folder(config: ImapConfig, folder: String) -> Result<(), String> {
    let mut session = imap_client::connect(&config).await?;
    imap_client::create_folder(&mut session, &folder).await?;
    let _ = session.logout().await;
    Ok(())
}

#[tauri::command]
pub async fn imap_delete_folder(config: ImapConfig, folder: String) -> Result<(), String> {
    let mut session = imap_client::connect(&config).await?;
    imap_client::delete_folder(&mut session, &folder).await?;
    let _ = session.logout().await;
    Ok(())
}

fn base64url_decode(input: &str) -> Result<Vec<u8>, String> {
    use base64::Engine;
    let engine = base64::engine::general_purpose::URL_SAFE_NO_PAD;
    engine
        .decode(input)
        .map_err(|e| format!("base64url decode failed: {e}"))
}

#[tauri::command]
pub async fn imap_search_folder(
    config: ImapConfig,
    folder: String,
    since_date: Option<String>,
) -> Result<ImapFolderSearchResult, String> {
    let mut session = imap_client::connect(&config).await?;
    let result = imap_client::search_folder(&mut session, &folder, since_date).await;
    let _ = session.logout().await;
    result
}

#[tauri::command]
pub async fn imap_sync_folder(
    config: ImapConfig,
    folder: String,
    batch_size: u32,
    since_date: Option<String>,
) -> Result<ImapFolderSyncResult, String> {
    let mut session = imap_client::connect(&config).await?;
    let result = imap_client::sync_folder(&mut session, &folder, batch_size, since_date).await;
    let _ = session.logout().await;
    result
}

#[tauri::command]
pub async fn imap_raw_fetch_diagnostic(
    config: ImapConfig,
    folder: String,
    uid_range: String,
) -> Result<String, String> {
    imap_client::raw_fetch_diagnostic(&config, &folder, &uid_range).await
}

#[tauri::command]
pub async fn imap_delta_check(
    config: ImapConfig,
    folders: Vec<DeltaCheckRequest>,
) -> Result<Vec<DeltaCheckResult>, String> {
    let mut session = imap_client::connect(&config).await?;
    let results = imap_client::delta_check_folders(&mut session, &folders).await?;
    let _ = session.logout().await;
    Ok(results)
}

// ---------- SMTP commands ----------

#[tauri::command]
pub async fn smtp_send_email(
    config: SmtpConfig,
    raw_email: String,
) -> Result<SmtpSendResult, String> {
    // Frontend (smtpSender.ts) still sends base64url; decode here so the SMTP
    // client can take raw bytes. This is a separate path from the
    // `sync_apply_mutation` send (which decodes in db::mutations). T7 may
    // revisit this when the frontend send path is reworked.
    use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
    let raw_bytes = URL_SAFE_NO_PAD
        .decode(&raw_email)
        .map_err(|e| format!("base64url decode error: {e}"))?;
    smtp_client::send_raw_email(&config, &raw_bytes).await
}

#[tauri::command]
pub async fn smtp_test_connection(config: SmtpConfig) -> Result<SmtpSendResult, String> {
    smtp_client::test_connection(&config).await
}
