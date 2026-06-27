// Tauri commands for the SyncEngine lifecycle. The frontend invokes these to start
// polling on app launch, trigger a manual "check mail", and stop on quit.

use std::sync::Arc;

use tauri::State;

use super::engine::SyncEngine;

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
pub async fn sync_account_now(engine: State<'_, Arc<SyncEngine>>, account_id: String) -> Result<(), String> {
    engine.sync_account_now(account_id).await;
    Ok(())
}

#[tauri::command]
pub async fn sync_request_bodies(
    _engine: State<'_, Arc<SyncEngine>>,
    _account_id: String,
    _message_ids: Vec<String>,
) -> Result<(), String> {
    // Phase 0: bodies are fetched inline during sync_folder. On-demand prefetch is Phase 2.
    Ok(())
}
