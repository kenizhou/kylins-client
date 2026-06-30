// Ported from mailkit_arkts. License pending confirmation. See ATTRIBUTIONS.md.
//
// Tauri command wrappers for the EAS client. Each function takes a typed
// request, constructs a fresh `EasClient` (cheap — reuses internal reqwest
// connection pool), and dispatches the command. Caller (frontend) passes
// `EasConfig` and command-specific input.

use crate::eas::client::{EasClient, EasError};
use crate::eas::types::*;

fn to_display(e: EasError) -> String {
    e.to_string()
}

#[tauri::command]
pub async fn eas_folder_sync(
    config: EasConfig,
    sync_key: String,
) -> Result<FolderSyncResult, String> {
    let client = EasClient::new(config);
    client.folder_sync(&sync_key).await.map_err(to_display)
}

#[tauri::command]
pub async fn eas_sync(config: EasConfig, request: SyncRequest) -> Result<SyncResult, String> {
    let client = EasClient::new(config);
    client.sync(&request).await.map_err(to_display)
}

#[tauri::command]
pub async fn eas_send_mail(config: EasConfig, request: SendMailRequest) -> Result<u32, String> {
    let client = EasClient::new(config);
    client.send_mail(&request).await.map_err(to_display)
}

#[tauri::command]
pub async fn eas_smart_forward(
    config: EasConfig,
    request: SmartForwardRequest,
) -> Result<u32, String> {
    let client = EasClient::new(config);
    client.smart_forward(&request).await.map_err(to_display)
}

#[tauri::command]
pub async fn eas_smart_reply(config: EasConfig, request: SmartReplyRequest) -> Result<u32, String> {
    let client = EasClient::new(config);
    client.smart_reply(&request).await.map_err(to_display)
}

#[tauri::command]
pub async fn eas_item_operations(
    config: EasConfig,
    request: ItemOperationsFetchRequest,
) -> Result<ItemOperationsFetchResult, String> {
    let client = EasClient::new(config);
    client.item_operations(&request).await.map_err(to_display)
}

#[tauri::command]
pub async fn eas_get_item_estimate(
    config: EasConfig,
    request: GetItemEstimateRequest,
) -> Result<GetItemEstimateResult, String> {
    let client = EasClient::new(config);
    client.get_item_estimate(&request).await.map_err(to_display)
}

#[tauri::command]
pub async fn eas_ping(config: EasConfig, request: PingRequest) -> Result<PingResult, String> {
    let client = EasClient::new(config);
    client.ping(&request).await.map_err(to_display)
}

#[tauri::command]
pub async fn eas_folder_create(
    config: EasConfig,
    request: FolderCreateRequest,
) -> Result<(u32, Option<String>), String> {
    let client = EasClient::new(config);
    client.folder_create(&request).await.map_err(to_display)
}

#[tauri::command]
pub async fn eas_folder_delete(
    config: EasConfig,
    request: FolderDeleteRequest,
) -> Result<(u32, Option<String>), String> {
    let client = EasClient::new(config);
    client.folder_delete(&request).await.map_err(to_display)
}

#[tauri::command]
pub async fn eas_folder_update(
    config: EasConfig,
    request: FolderUpdateRequest,
) -> Result<(u32, Option<String>), String> {
    let client = EasClient::new(config);
    client.folder_update(&request).await.map_err(to_display)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Sanity check: the `to_display` helper stringifies any EasError variant
    /// without panicking. Uses the HttpStatus variant as a representative.
    #[test]
    fn error_to_display_works() {
        let e = EasError::HttpStatus {
            status: 401,
            body: "Unauthorized".to_string(),
            retry_after: None,
        };
        let s = to_display(e);
        assert!(s.contains("401"));
        assert!(s.contains("Unauthorized"));
    }

    #[test]
    fn transport_error_stringifies() {
        let e = EasError::Transport("connection refused".to_string());
        let s = to_display(e);
        assert!(s.contains("transport"));
        assert!(s.contains("connection refused"));
    }

    #[test]
    fn unexpected_root_error_stringifies() {
        let e = EasError::UnexpectedRoot {
            page: 5,
            token: 0x10,
        };
        let s = to_display(e);
        assert!(s.contains("page 5"));
        assert!(s.contains("token 16"));
    }

    #[test]
    fn command_status_error_stringifies() {
        let e = EasError::CommandStatus {
            status: 142,
            message: "policy required".to_string(),
        };
        let s = to_display(e);
        assert!(s.contains("142"));
        assert!(s.contains("policy required"));
    }
}
