// Ported from mailkit_arkts. License pending confirmation. See ATTRIBUTIONS.md.
//
// Minimal EAS type set for MVP scope (9 commands: FolderSync, Sync, SendMail,
// SmartForward, SmartReply, ItemOperations, GetItemEstimate, Ping, FolderCreate/Delete/Update).
// Full type coverage (Provision, Settings, Search, ResolveRecipients, ValidateCert,
// Find, AutoDiscover, MeetingResponse) is deferred.

use serde::{Deserialize, Serialize};

// ---------- Configuration ----------

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct EasConfig {
    /// Full URL to the Exchange ActiveSync endpoint, e.g.
    /// `https://mail.kylins.com/Microsoft-Server-ActiveSync`.
    pub url: String,
    /// Username for Basic auth. For domain accounts use `DOMAIN\user` or `user@domain`.
    pub username: String,
    /// Plaintext password (transported over TLS; encrypted at rest via crypto::encrypt).
    pub password: String,
    /// Protocol version: `"2.5"`, `"12.0"`, `"12.1"`, `"14.0"`, `"14.1"`, `"16.0"`, `"16.1"`.
    /// Default `"16.1"` for Exchange 2016/2019/Online.
    #[serde(default = "default_protocol_version")]
    pub protocol_version: String,
    /// Device ID — alphanumeric, max 16 chars. Generated once per install, persisted
    /// in keyring alongside the master key. See `client::device_id()`.
    pub device_id: String,
    /// Device type — `"KylinsMail"` by convention. Sent in the X-MS-DeviceType header.
    #[serde(default = "default_device_type")]
    pub device_type: String,
    /// User-agent string. Defaults to `"KylinsMail/1.0"`.
    #[serde(default = "default_user_agent")]
    pub user_agent: String,
    /// Policy key returned by Provision command (MVP skips Provision, so this stays `"0"`).
    /// If the server demands provisioning, sync will return status 142; we surface that
    /// to the user as a "policy required" error.
    #[serde(default)]
    pub policy_key: String,
    /// Accept invalid TLS certs (self-signed Exchange servers). Default false.
    #[serde(default)]
    pub accept_invalid_certs: bool,
}

fn default_protocol_version() -> String {
    "16.1".to_string()
}

fn default_device_type() -> String {
    "KylinsMail".to_string()
}

fn default_user_agent() -> String {
    "KylinsMail/1.0".to_string()
}

// ---------- Folders (FolderSync) ----------

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct EasFolder {
    pub server_id: String,
    pub parent_id: String,
    pub display_name: String,
    /// `"Email"`, `"Calendar"`, `"Contacts"`, `"Tasks"`, `"Notes"`, etc.
    pub class: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct FolderSyncResult {
    /// Updated sync key to persist for the next FolderSync call.
    pub sync_key: String,
    /// Folders added or updated since the last sync key.
    pub changes: Vec<EasFolder>,
    /// Server IDs of folders deleted since the last sync key.
    pub deletions: Vec<String>,
}

// ---------- Sync ----------

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SyncRequest {
    pub collection_id: String,
    pub sync_key: String,
    /// `"Email"`, `"Calendar"`, `"Contacts"`.
    pub class: String,
    /// Window size — number of items to fetch per round-trip.
    #[serde(default = "default_window_size")]
    pub window_size: u32,
    /// Optional filter: number of days back to sync (`0` = no filter).
    #[serde(default)]
    pub filter_age_days: u32,
    /// Whether to fetch bodies (`true`) or just headers (`false`).
    #[serde(default = "default_true")]
    pub fetch_body: bool,
}

fn default_window_size() -> u32 {
    50
}

fn default_true() -> bool {
    true
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct SyncResult {
    pub sync_key: String,
    pub added: Vec<EasItem>,
    pub updated: Vec<EasItem>,
    pub deleted_server_ids: Vec<String>,
    /// True if more items are available — caller should re-issue Sync with the new sync_key.
    pub more_available: bool,
}

/// Generic item envelope — fields vary by collection class. For MVP we keep the
/// payload as a flexible map so we don't have to enumerate every EAS field.
/// Phase 6+ work can specialize per class.
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct EasItem {
    pub server_id: String,
    pub class: String,
    /// Decoded item fields. Keys correspond to WBXML tag names (e.g. `"Subject"`, `"DateReceived"`).
    pub fields: std::collections::HashMap<String, String>,
    /// Raw body text (HTML or plain) if requested.
    pub body: Option<String>,
    /// Body type: `"text"`, `"html"`, `"rtf"`, `"mime"`.
    pub body_type: Option<String>,
    /// Preview snippet (first ~256 chars).
    pub preview: Option<String>,
    /// Attachments if fetched.
    pub attachments: Vec<EasAttachment>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct EasAttachment {
    pub file_reference: String,
    pub display_name: String,
    pub content_id: Option<String>,
    pub is_inline: bool,
    pub estimated_data_size: u64,
    pub method: u8, // 1=Normal, 5=EmbeddedMessage, 6=AttachOLE
}

// ---------- ItemOperations ----------

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ItemOperationsFetchRequest {
    /// Server ID of the item to fetch.
    pub server_id: String,
    /// Collection (folder) ID containing the item.
    pub collection_id: String,
    /// For attachment fetches: the FileReference returned in a prior Sync.
    pub file_reference: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct ItemOperationsFetchResult {
    pub status: u8,
    /// Raw base64-encoded bytes for attachment fetches, or item fields for item fetches.
    pub data: Option<String>,
    pub content_type: Option<String>,
}

// ---------- GetItemEstimate ----------

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GetItemEstimateRequest {
    pub collection_id: String,
    pub sync_key: String,
    pub class: String,
    pub filter_age_days: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct GetItemEstimateResult {
    pub count: u32,
    pub collection_id: String,
}

// ---------- Ping ----------

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PingRequest {
    /// Heartbeat interval in seconds (60-3540). Server will hold the connection
    /// for this duration or until a change occurs.
    pub heartbeat_interval: u32,
    /// Collections to monitor for changes.
    pub monitored_collections: Vec<PingCollection>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PingCollection {
    pub collection_id: String,
    pub class: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct PingResult {
    /// `"OK"` (changes detected), `"Timeout"` (heartbeat elapsed), or error status.
    pub status: String,
}

// ---------- SendMail / SmartForward / SmartReply ----------

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SendMailRequest {
    /// Base64-encoded RFC 2822 MIME message.
    pub mime_base64: String,
    /// If true, save a copy to the Sent folder.
    #[serde(default = "default_true")]
    pub save_to_sent: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SmartForwardRequest {
    pub mime_base64: String,
    /// Server ID of the message being forwarded.
    pub source_server_id: String,
    /// Collection ID (folder) containing the source message.
    pub source_collection_id: String,
    #[serde(default = "default_true")]
    pub save_to_sent: bool,
    /// If true, replace the source MIME rather than appending to it.
    #[serde(default)]
    pub replace_mime: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SmartReplyRequest {
    pub mime_base64: String,
    pub source_server_id: String,
    pub source_collection_id: String,
    #[serde(default = "default_true")]
    pub save_to_sent: bool,
    #[serde(default)]
    pub replace_mime: bool,
}

// ---------- Folder create/update/delete ----------

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FolderCreateRequest {
    pub parent_id: String,
    pub display_name: String,
    pub class: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FolderUpdateRequest {
    pub server_id: String,
    pub parent_id: Option<String>,
    pub display_name: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FolderDeleteRequest {
    pub server_id: String,
}

// ---------- Common status / errors ----------

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct EasError {
    pub status: u32,
    pub message: String,
    pub command: String,
}

impl std::fmt::Display for EasError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(
            f,
            "EAS {} status {}: {}",
            self.command, self.status, self.message
        )
    }
}

impl std::error::Error for EasError {}
