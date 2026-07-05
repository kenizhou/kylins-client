// Ported from velo (https://github.com/avihaymenahem/velo)
// Licensed under Apache-2.0. See ATTRIBUTIONS.md.

#[cfg(not(target_os = "linux"))]
use tauri::{
    menu::{Menu, MenuItem},
    tray::TrayIconBuilder,
};
use tauri::{Emitter, Manager};
use tauri_plugin_autostart::MacosLauncher;
// KeepAll rotation: the plugin's default is `KeepOne`, which DELETES the old log
// file once `max_file_size` is exceeded. On a chatty DEBUG log that rotates
// constantly, so history looks like it was overwritten. KeepAll preserves the
// rotated file as `{name}_{timestamp}.log; the 10 MB cap stops mid-session
// rotation under normal use. Targets: LogDir (OS log dir) + Stdout (dev console).
use tauri_plugin_log::{Target, TargetKind, RotationStrategy, TimezoneStrategy};

pub mod commands;
pub mod crypto;
pub mod db;
pub mod eas;
pub mod mail;
pub mod oauth;
pub mod sync;
pub mod sync_engine;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // Set explicit AUMID on Windows so toast notifications show the app name
    // instead of "Windows PowerShell". Changed from velo's com.velomail.app
    // to kylins's com.mailclient.app identifier.
    #[cfg(windows)]
    {
        use windows::core::w;
        use windows::Win32::UI::Shell::SetCurrentProcessExplicitAppUserModelID;
        unsafe {
            let _ = SetCurrentProcessExplicitAppUserModelID(w!("com.mailclient.app"));
        }
    }

    tauri::Builder::default()
        // Single instance MUST be first
        .plugin(tauri_plugin_single_instance::init(|app, argv, _cwd| {
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.show();
                let _ = window.set_focus();
                let _ = window.unminimize();
            }
            let _ = app.emit("single-instance-args", argv);
        }))
        .plugin(tauri_plugin_autostart::init(
            MacosLauncher::LaunchAgent,
            Some(vec!["--hidden"]),
        ))
        .plugin(tauri_plugin_deep_link::init())
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_http::init())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_os::init())
        .invoke_handler(tauri::generate_handler![
            commands::set_tray_tooltip,
            commands::open_devtools,
            commands::encrypt_secret,
            commands::decrypt_secret,
            commands::read_text_file,
            commands::write_text_file,
            commands::write_binary_file,
            commands::get_autostart_state,
            commands::set_autostart_enabled,
            commands::send_desktop_notification,
            commands::request_notification_permission,
            commands::get_cache_size,
            commands::clear_cache,
            commands::reveal_logs_directory,
            oauth::start_oauth_server,
            oauth::oauth_exchange_token,
            oauth::oauth_refresh_token,
            commands::imap_test_connection,
            commands::imap_list_folders,
            commands::imap_fetch_messages,
            commands::imap_fetch_new_uids,
            commands::imap_search_all_uids,
            commands::imap_fetch_message_body,
            commands::imap_fetch_raw_message,
            commands::imap_set_flags,
            commands::imap_move_messages,
            commands::imap_copy_messages,
            commands::imap_delete_messages,
            commands::imap_get_folder_status,
            commands::imap_append_message,
            commands::imap_create_folder,
            commands::imap_delete_folder,
            commands::imap_search_folder,
            commands::imap_sync_folder,
            commands::imap_raw_fetch_diagnostic,
            commands::imap_delta_check,
            commands::smtp_send_email,
            commands::smtp_test_connection,
            eas::service::eas_folder_sync,
            eas::service::eas_sync,
            eas::service::eas_send_mail,
            eas::service::eas_smart_forward,
            eas::service::eas_smart_reply,
            eas::service::eas_item_operations,
            eas::service::eas_get_item_estimate,
            eas::service::eas_ping,
            eas::service::eas_folder_create,
            eas::service::eas_folder_delete,
            eas::service::eas_folder_update,
            sync::contacts::commands::parse_vcard,
            sync::contacts::commands::export_vcard,
            db::commands::db_get_all_accounts,
            db::commands::db_get_account_by_id,
            db::commands::db_get_account_by_email,
            db::commands::db_create_account,
            db::commands::db_update_account,
            db::commands::db_delete_account,
            db::commands::db_delete_account_by_email,
            db::commands::db_get_account_count,
            db::commands::db_set_default_account,
            db::commands::db_get_default_account,
            db::commands::db_get_setting,
            db::commands::db_set_setting,
            db::commands::db_get_setting_bool,
            db::commands::db_set_setting_bool,
            db::commands::db_get_setting_number,
            db::commands::db_set_setting_number,
            db::commands::db_get_folders_by_account,
            db::commands::db_get_all_folders,
            db::commands::db_get_folder_by_role,
            db::commands::db_get_unread_counts_by_account,
            db::commands::db_get_total_unread,
            db::commands::db_upsert_folders,
            db::commands::db_create_folder,
            db::commands::db_rename_folder,
            db::commands::db_delete_folder,
            db::commands::db_get_threads,
            db::commands::db_get_messages_for_thread,
            db::commands::db_get_attachments,
            db::commands::db_mark_thread_read,
            db::commands::db_get_message_body,
            db::commands::db_set_message_body,
            db::commands::db_evict_body,
            db::commands::db_enqueue_op,
            db::commands::db_dequeue_pending,
            db::commands::db_mark_op_completed,
            db::commands::db_mark_op_failed,
            db::commands::db_list_contacts,
            db::commands::db_search_contacts,
            db::commands::db_get_contact_by_id,
            db::commands::db_get_contact_by_email,
            db::commands::db_get_contact_by_external_id,
            db::commands::db_create_contact,
            db::commands::db_update_contact,
            db::commands::db_delete_contact,
            db::commands::db_upsert_contact,
            db::commands::db_update_contact_avatar,
            db::commands::db_update_contact_notes,
            db::commands::db_get_contact_stats,
            db::commands::db_get_recent_threads_with_contact,
            db::commands::db_get_attachments_from_contact,
            db::commands::db_get_contacts_from_same_domain,
            db::commands::db_get_latest_auth_result,
            db::commands::db_get_contact_groups,
            db::commands::db_get_contact_group_by_id,
            db::commands::db_create_contact_group,
            db::commands::db_rename_contact_group,
            db::commands::db_delete_contact_group,
            db::commands::db_add_contact_to_group,
            db::commands::db_remove_contact_from_group,
            db::commands::db_get_contact_ids_for_group,
            db::commands::db_get_groups_for_contact,
            db::commands::db_get_signatures_for_account,
            db::commands::db_get_default_signature,
            db::commands::db_insert_signature,
            db::commands::db_update_signature,
            db::commands::db_delete_signature,
            db::commands::db_create_draft,
            db::commands::db_update_draft,
            db::commands::db_delete_draft,
            db::commands::db_get_draft,
            db::commands::db_list_drafts_for_account,
            db::commands::db_get_aliases_for_account,
            db::commands::db_insert_alias,
            db::commands::db_update_alias,
            db::commands::db_delete_alias,
            db::commands::db_search_messages,
            db::commands::db_get_calendar_events_for_account,
            db::commands::db_get_calendar_events_in_range,
            db::commands::db_get_calendar_event_by_id,
            db::commands::db_insert_calendar_event,
            db::commands::db_update_calendar_event,
            db::commands::db_delete_calendar_event,
            db::commands::db_get_tasks_for_account,
            db::commands::db_get_tasks_for_thread,
            db::commands::db_get_task_by_id,
            db::commands::db_insert_task,
            db::commands::db_update_task,
            db::commands::db_delete_task,
            db::commands::db_toggle_task_completed,
            db::commands::db_get_task_tags,
            db::commands::db_create_task_tag,
            db::commands::db_update_task_tag_color,
            db::commands::db_delete_task_tag,
            db::commands::db_get_pending_scheduled_emails,
            db::commands::db_get_scheduled_emails_for_account,
            db::commands::db_insert_scheduled_email,
            db::commands::db_update_scheduled_email_status,
            db::commands::db_delete_scheduled_email,
            db::commands::db_get_latest_scheduled_email_for_account,
            db::commands::db_set_scheduled_email_attachment_paths,
            db::commands::db_get_templates_for_account,
            db::commands::db_insert_template,
            db::commands::db_update_template,
            db::commands::db_delete_template,
            db::commands::db_get_contact_sync_state,
            db::commands::db_set_contact_sync_state,
            db::commands::db_add_to_image_allowlist,
            db::commands::db_is_image_allowlisted,
            db::commands::db_remove_from_image_allowlist,
            db::commands::db_get_cached_ai_result,
            db::commands::db_cache_ai_result,
            db::commands::db_get_rate_limit_info,
            db::commands::db_get_uncached_body_message_ids,
            sync_engine::commands::sync_start,
            sync_engine::commands::sync_stop,
            sync_engine::commands::sync_account_now,
            sync_engine::commands::sync_request_bodies,
            sync_engine::commands::sync_fetch_attachment,
            sync_engine::commands::sync_fetch_inline_images,
            sync_engine::commands::sync_apply_mutation,
        ])
        .setup(|app| {
            {
                let level = if cfg!(debug_assertions) {
                    log::LevelFilter::Debug
                } else {
                    log::LevelFilter::Info
                };
                app.handle().plugin(
                    tauri_plugin_log::Builder::default()
                        // FIRST in the chain (plugins-workspace #2262 workaround:
                        // timezone_strategy applied after `level`/`targets` in
                        // some versions silently no-ops). Default is Utc; without
                        // this, log timestamps are hours off from the local
                        // clock, which makes correlating log lines to user actions
                        // painful. Local timestamps match what `fern`/`env_logger`
                        // emit in dev so prod + dev logs read the same.
                        // (Variant is `UseLocal`, not `Local`, in v2.x — confirmed
                        // against tauri-plugin-log 2.8.0 which is pinned in
                        // Cargo.lock; the brief's `TimezoneStrategy::Local` was a
                        // slight misnomer.)
                        .timezone_strategy(TimezoneStrategy::UseLocal)
                        .level(level)
                        .level_for("sqlx::query", log::LevelFilter::Warn)
                        // Default is KeepOne (deletes the old log on rotation);
                        // KeepAll preserves rotated files as {name}_{timestamp}.log.
                        .rotation_strategy(RotationStrategy::KeepAll)
                        // 10 MB so a normal session doesn't rotate mid-run, while
                        // still bounding the log dir over a long-lived desktop app.
                        .max_file_size(10 * 1024 * 1024)
                        .targets([
                            Target::new(TargetKind::LogDir { file_name: None }),
                            Target::new(TargetKind::Stdout),
                        ])
                        .build(),
                )?;
            }

            // Panic hook: forward every panic (any thread, including spawned
            // tokio worker tasks — whose panics otherwise go only to stderr and
            // are silently swallowed by `tokio::spawn`'s detached JoinHandle)
            // into the log file via `log::error!`. The default hook is chained
            // afterward so the std panic print to stderr is preserved (Tauri's
            // terminal in dev, the crash handler in prod). Installed AFTER the
            // log plugin is up so `log::error!` has a subscriber; BEFORE the db
            // pool + sync engine spawn so a panic during init is captured too.
            {
                let default_hook = std::panic::take_hook();
                std::panic::set_hook(Box::new(move |info| {
                    let location = info
                        .location()
                        .map(|l| format!("{}:{}:{}", l.file(), l.line(), l.column()))
                        .unwrap_or_default();
                    let payload = info
                        .payload()
                        .downcast_ref::<&str>()
                        .copied()
                        .or_else(|| info.payload().downcast_ref::<String>().map(|s| s.as_str()))
                        .unwrap_or("<non-string panic payload>");
                    log::error!("PANIC at {location}: {payload}");
                    default_hook(info);
                }));
            }

            // Open the SQLite database (creates mailclient.db + WAL files if
            // absent) and run embedded sqlx migrations. The pool is exposed to
            // later Tauri commands via State<'_, DbPool>. Tauri's setup runs
            // synchronously, so we block on the async init here. Rust is the
            // sole writer of every table; the frontend `invoke`s the `db_*`
            // commands declared in `db::commands`.
            {
                let data_dir = app
                    .path()
                    .app_data_dir()
                    .expect("app data dir should be resolvable");
                let pool = tauri::async_runtime::block_on(async {
                    db::init_db(&data_dir).await.expect("db init")
                });
                app.manage(pool.clone());
                // SyncEngine owns one polling worker per account. The frontend starts
                // it (sync_start) once accounts are loaded; events flow via AppHandle.
                // `data_dir` is the SAME path the frontend resolves via
                // `@tauri-apps/api/path`'s `appDataDir()` — threaded through so
                // `send_op`'s attachment cleanup removes the dir the T7 frontend
                // staged under `<appData>/outbox-attachments/{draft_id}/`.
                let engine = sync_engine::engine::SyncEngine::new_tauri(
                    pool,
                    app.handle().clone(),
                    data_dir,
                );
                app.manage(engine);
            }

            #[cfg(not(target_os = "linux"))]
            {
                let show = MenuItem::with_id(app, "show", "Show Kylins Mail", true, None::<&str>)?;
                let check_mail =
                    MenuItem::with_id(app, "check_mail", "Check for Mail", true, None::<&str>)?;
                let quit = MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?;
                let menu = Menu::with_items(app, &[&show, &check_mail, &quit])?;

                let icon = app
                    .default_window_icon()
                    .cloned()
                    .expect("app should have a default icon configured in tauri.conf.json bundle");

                TrayIconBuilder::with_id("main-tray")
                    .icon(icon)
                    .tooltip("Kylins Mail")
                    .menu(&menu)
                    .show_menu_on_left_click(false)
                    .on_menu_event(|app, event| match event.id.as_ref() {
                        "show" => {
                            if let Some(window) = app.get_webview_window("main") {
                                let _ = window.show();
                                let _ = window.set_focus();
                            }
                        }
                        "check_mail" => {
                            if let Some(window) = app.get_webview_window("main") {
                                let _ = window.emit("tray-check-mail", ());
                            }
                        }
                        "quit" => {
                            app.exit(0);
                        }
                        _ => {}
                    })
                    .on_tray_icon_event(|tray, event| {
                        if let tauri::tray::TrayIconEvent::DoubleClick { .. } = event {
                            let app = tray.app_handle();
                            if let Some(window) = app.get_webview_window("main") {
                                let _ = window.show();
                                let _ = window.set_focus();
                            }
                        }
                    })
                    .build(app)?;
            }

            #[cfg(target_os = "linux")]
            {
                use tray_item::{IconSource, TrayItem};

                let app_handle = app.handle().clone();

                std::thread::spawn(move || {
                    let mut tray =
                        match TrayItem::new("Kylins Mail", IconSource::Resource("mail-read")) {
                            Ok(t) => t,
                            Err(e) => {
                                log::warn!("Failed to create system tray: {e}");
                                return;
                            }
                        };

                    let app_handle_show = app_handle.clone();
                    if let Err(e) = tray.add_menu_item("Show Kylins Mail", move || {
                        if let Some(window) = app_handle_show.get_webview_window("main") {
                            let _ = window.show();
                            let _ = window.set_focus();
                        }
                    }) {
                        log::warn!("Failed to add tray menu item 'Show Kylins Mail': {e}");
                    }

                    let app_handle_check = app_handle.clone();
                    if let Err(e) = tray.add_menu_item("Check for Mail", move || {
                        if let Some(window) = app_handle_check.get_webview_window("main") {
                            let _ = window.emit("tray-check-mail", ());
                        }
                    }) {
                        log::warn!("Failed to add tray menu item 'Check for Mail': {e}");
                    }

                    let app_handle_quit = app_handle.clone();
                    if let Err(e) = tray.add_menu_item("Quit", move || {
                        app_handle_quit.exit(0);
                    }) {
                        log::warn!("Failed to add tray menu item 'Quit': {e}");
                    }

                    loop {
                        std::thread::park();
                    }
                });
            }

            // Start hidden in tray if launched with --hidden (autostart)
            if std::env::args().any(|a| a == "--hidden") {
                if let Some(window) = app.get_webview_window("main") {
                    let _ = window.hide();
                }
            }

            Ok(())
        })
        .on_window_event(|window, event| {
            // Minimize to tray on close instead of quitting (main window only)
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                if window.label() == "main" {
                    let _ = window.hide();
                    api.prevent_close();
                }
            }
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");

    log::info!("Tauri application exited normally");
}
