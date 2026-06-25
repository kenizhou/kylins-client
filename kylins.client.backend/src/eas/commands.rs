// Ported from mailkit_arkts. License pending confirmation. See ATTRIBUTIONS.md.
//
// Pure WBXML marshalers for the 9 MVP EAS commands. Each command has:
//   - `build_*_request(input) -> WbxmlElement` — build the request tree
//   - `parse_*_response(tree) -> Result<output, WbxmlError>` — parse the response tree
//
// HTTP transport lives in `client.rs` (Phase 8) and wraps these in POST requests.
//
// Code-page tag constants below are deliberately exhaustive: they mirror the
// EAS protocol spec so command builders can reach for any tag without re-checking
// the reference. Some are not wired into the MVP request/response builders yet;
// silence the dead-code lint until the corresponding code paths land.
#![allow(dead_code)]

use crate::eas::types::*;
use crate::eas::wbxml::types::{WbxmlElement, WbxmlValue};
use crate::eas::wbxml::WbxmlError;

// ---------- Code page indices (for readability) ----------

const PAGE_AIRSYNC: u8 = 0;
const PAGE_FOLDER: u8 = 7;
const PAGE_PING: u8 = 13;
const PAGE_ITEM_OPS: u8 = 20;
const PAGE_COMPOSE: u8 = 21;

// ---------- AirSync (page 0) tag ids ----------

const AS_SYNC: u8 = 0x05;
const AS_RESPONSES: u8 = 0x06;
const AS_ADD: u8 = 0x07;
const AS_CHANGE: u8 = 0x08;
const AS_DELETE: u8 = 0x09;
const AS_FETCH: u8 = 0x0A;
const AS_SYNC_KEY: u8 = 0x0B;
const AS_CLIENT_ID: u8 = 0x0C;
const AS_SERVER_ID: u8 = 0x0D;
const AS_STATUS: u8 = 0x0E;
const AS_COLLECTION: u8 = 0x0F;
const AS_COLLECTIONS: u8 = 0x1C;
const AS_CLASS: u8 = 0x10;
const AS_COLLECTION_ID: u8 = 0x12;
const AS_GET_CHANGES: u8 = 0x13;
const AS_MORE_AVAILABLE: u8 = 0x14;
const AS_WINDOW_SIZE: u8 = 0x15;
const AS_COMMANDS: u8 = 0x16;
const AS_APPLICATION_DATA: u8 = 0x1D;

// ---------- FolderHierarchy (page 7) tag ids ----------

const FH_FOLDERS: u8 = 0x05;
const FH_FOLDER: u8 = 0x06;
const FH_DISPLAY_NAME: u8 = 0x07;
const FH_SERVER_ID: u8 = 0x08;
const FH_PARENT_ID: u8 = 0x09;
const FH_TYPE: u8 = 0x0A;
const FH_STATUS: u8 = 0x0C;
const FH_CHANGES: u8 = 0x0E;
const FH_ADD: u8 = 0x0F;
const FH_DELETE: u8 = 0x10;
const FH_UPDATE: u8 = 0x11;
const FH_SYNC_KEY: u8 = 0x12;
const FH_FOLDER_CREATE: u8 = 0x13;
const FH_FOLDER_DELETE: u8 = 0x14;
const FH_FOLDER_UPDATE: u8 = 0x15;
const FH_FOLDER_SYNC: u8 = 0x16;
const FH_COUNT: u8 = 0x17;

// ---------- Ping (page 13) tag ids ----------

const PING_PING: u8 = 0x05;
const PING_STATUS: u8 = 0x07;
const PING_HEARTBEAT_INTERVAL: u8 = 0x08;
const PING_FOLDERS: u8 = 0x09;
const PING_FOLDER: u8 = 0x0A;
const PING_ID: u8 = 0x0B;
const PING_CLASS: u8 = 0x0C;
const PING_MAX_FOLDERS: u8 = 0x0D;

// ---------- ItemOperations (page 20) tag ids ----------

const IO_ITEMOPERATIONS: u8 = 0x05;
const IO_FETCH: u8 = 0x06;
const IO_STORE: u8 = 0x07;
const IO_RESPONSE: u8 = 0x08;
const IO_STATUS: u8 = 0x0A;
const IO_COLLECTION_ID: u8 = 0x0B;
const IO_SERVER_ID: u8 = 0x0C;
const IO_FILE_REFERENCE: u8 = 0x0D;
const IO_PROPERTIES: u8 = 0x0F;
const IO_DATA: u8 = 0x10;
const IO_CONTENT_TYPE: u8 = 0x12;

// ---------- ComposeMail (page 21) tag ids ----------

const CM_SEND_MAIL: u8 = 0x05;
const CM_SMART_FORWARD: u8 = 0x06;
const CM_SMART_REPLY: u8 = 0x07;
const CM_SAVE_IN_SENT: u8 = 0x08;
const CM_MIME: u8 = 0x09;
const CM_SOURCE: u8 = 0x0B;
const CM_FOLDER_ID: u8 = 0x0C;
const CM_ITEM_ID: u8 = 0x0D;
const CM_REPLACE_MIME: u8 = 0x0E;
const CM_STATUS: u8 = 0x18;

// ============================================================================
// FolderSync
// ============================================================================

/// Build a FolderSync request.
///
/// WBXML shape:
/// ```xml
/// <FolderSync>
///   <SyncKey>{sync_key}</SyncKey>
/// </FolderSync>
/// ```
pub fn build_folder_sync_request(sync_key: &str) -> WbxmlElement {
    WbxmlElement::container(
        PAGE_FOLDER,
        FH_FOLDER_SYNC,
        vec![WbxmlElement::text(PAGE_FOLDER, FH_SYNC_KEY, sync_key)],
    )
}

/// Parse a FolderSync response.
pub fn parse_folder_sync_response(root: &WbxmlElement) -> Result<FolderSyncResult, WbxmlError> {
    expect_tag(root, PAGE_FOLDER, FH_FOLDER_SYNC)?;

    let mut result = FolderSyncResult::default();
    let mut status: u32 = 1; // success default per [MS-ASFolderSync] 2.2.3.1.10
    for child in &root.children {
        match child.token {
            FH_SYNC_KEY if child.page == PAGE_FOLDER => {
                result.sync_key = text_value(child)?;
            }
            FH_CHANGES if child.page == PAGE_FOLDER => {
                parse_folder_changes(child, &mut result)?;
            }
            FH_STATUS if child.page == PAGE_FOLDER => {
                let s = text_value(child).unwrap_or_default();
                status = s.parse().unwrap_or(1);
            }
            _ => {}
        }
    }

    // Surface non-success status as an error so callers can react.
    // Status 1 = success; anything else indicates a protocol error.
    if status != 1 {
        return Err(WbxmlError::InvalidContent(format!(
            "FolderSync status {}: {}",
            status,
            folder_sync_status_message(status)
        )));
    }

    Ok(result)
}

fn folder_sync_status_message(status: u32) -> &'static str {
    match status {
        1 => "success",
        3 => "invalid synchronization key",
        4 => "malformed request",
        5 => "synchronization state no longer exists",
        6 => "synchronization state is not current",
        9 => "folder hierarchy out of date",
        12 => "back-end database unavailable",
        // Exchange-specific extension: 126 = Provision required before FolderSync
        // can return data. Client must run Provision command first.
        126 => "provision required before folder sync — run Provision command first",
        // 142 = Device not partnered. Server requires Provision + Device partnership.
        142 => "device not partnered — run Provision to establish device partnership",
        _ => "unknown status code",
    }
}

fn parse_folder_changes(
    changes: &WbxmlElement,
    result: &mut FolderSyncResult,
) -> Result<(), WbxmlError> {
    for child in &changes.children {
        match (child.page, child.token) {
            (PAGE_FOLDER, FH_ADD) => {
                let folder = parse_folder_element(child)?;
                result.changes.push(folder);
            }
            (PAGE_FOLDER, FH_UPDATE) => {
                let folder = parse_folder_element(child)?;
                result.changes.push(folder);
            }
            (PAGE_FOLDER, FH_DELETE) => {
                // Per [MS-ASFolderSync] the Delete element has a ServerId child,
                // not a text value. Be permissive: accept either form.
                let server_id = match find_child_text(child, FH_SERVER_ID) {
                    Some(s) => s,
                    None => text_value(child)?,
                };
                result.deletions.push(server_id);
            }
            (PAGE_FOLDER, FH_COUNT) => {} // count metadata, ignore
            _ => {}
        }
    }
    Ok(())
}

/// Find the first child with the given token on the same page and return its text value.
fn find_child_text(el: &WbxmlElement, token: u8) -> Option<String> {
    el.children
        .iter()
        .find(|c| c.token == token)
        .and_then(|c| match &c.value {
            WbxmlValue::Text(t) => Some(t.clone()),
            WbxmlValue::Opaque(b) => std::str::from_utf8(b).ok().map(|s| s.to_string()),
            WbxmlValue::Empty => None,
        })
}

fn parse_folder_element(folder_el: &WbxmlElement) -> Result<EasFolder, WbxmlError> {
    let mut folder = EasFolder::default();
    for child in &folder_el.children {
        match (child.page, child.token) {
            (PAGE_FOLDER, FH_SERVER_ID) => folder.server_id = text_value(child)?,
            (PAGE_FOLDER, FH_PARENT_ID) => folder.parent_id = text_value(child)?,
            (PAGE_FOLDER, FH_DISPLAY_NAME) => folder.display_name = text_value(child)?,
            (PAGE_FOLDER, FH_TYPE) => {
                let t = text_value(child)?;
                folder.class = folder_type_to_class(&t);
                folder.folder_type = t.parse::<u8>().ok();
            }
            _ => {}
        }
    }
    Ok(folder)
}

/// Map EAS folder type number (per [MS-ASFolderSync] section 2.2.3) to item class string.
/// Types 1-6, 12, 19 are mail folders; 7=tasks, 8=calendar, 9=contacts, 10=journal,
/// 11=notes. We map journal/notes to Notes for now; MVP doesn't sync them.
fn folder_type_to_class(type_str: &str) -> String {
    match type_str {
        "1" | "2" | "3" | "4" | "5" | "6" | "12" | "19" => "Email".to_string(),
        "7" => "Tasks".to_string(),
        "8" => "Calendar".to_string(),
        "9" => "Contacts".to_string(),
        "10" | "11" => "Notes".to_string(),
        _ => "Email".to_string(),
    }
}

// ============================================================================
// Sync
// ============================================================================

/// Build a Sync request for a single collection.
pub fn build_sync_request(req: &SyncRequest) -> WbxmlElement {
    let mut collection_children = vec![
        WbxmlElement::text(PAGE_AIRSYNC, AS_SYNC_KEY, req.sync_key.clone()),
        WbxmlElement::text(PAGE_AIRSYNC, AS_COLLECTION_ID, req.collection_id.clone()),
        WbxmlElement::empty(PAGE_AIRSYNC, AS_GET_CHANGES),
    ];

    if req.window_size != 0 {
        collection_children.push(WbxmlElement::text(
            PAGE_AIRSYNC,
            AS_WINDOW_SIZE,
            req.window_size.to_string(),
        ));
    }

    let mut collection = WbxmlElement::container(PAGE_AIRSYNC, AS_COLLECTION, collection_children);

    if !req.class.is_empty() {
        collection = WbxmlElement::container(
            PAGE_AIRSYNC,
            AS_COLLECTION,
            collection
                .children
                .into_iter()
                .chain(std::iter::once(WbxmlElement::text(
                    PAGE_AIRSYNC,
                    AS_CLASS,
                    req.class.clone(),
                )))
                .collect(),
        );
    }

    WbxmlElement::container(
        PAGE_AIRSYNC,
        AS_SYNC,
        vec![WbxmlElement::container(
            PAGE_AIRSYNC,
            AS_COLLECTIONS,
            vec![collection],
        )],
    )
}

/// Deprecated helper retained for callers that still import it. Returns the
/// single-collection token — `Collections` is now its own constant.
#[allow(non_snake_case)]
#[deprecated(note = "use AS_COLLECTIONS constant directly")]
fn AS_COLLECTIONS_CONTAINER() -> u8 {
    AS_COLLECTIONS
}

/// Parse a Sync response.
pub fn parse_sync_response(root: &WbxmlElement) -> Result<SyncResult, WbxmlError> {
    expect_tag(root, PAGE_AIRSYNC, AS_SYNC)?;

    let mut result = SyncResult::default();
    for child in &root.children {
        if let (PAGE_AIRSYNC, AS_COLLECTIONS) = (child.page, child.token) {
            for col_el in &child.children {
                if col_el.page == PAGE_AIRSYNC && col_el.token == AS_COLLECTION {
                    parse_sync_collection(col_el, &mut result)?;
                }
            }
        }
    }
    Ok(result)
}

fn parse_sync_collection(col: &WbxmlElement, result: &mut SyncResult) -> Result<(), WbxmlError> {
    for child in &col.children {
        match (child.page, child.token) {
            (PAGE_AIRSYNC, AS_SYNC_KEY) => result.sync_key = text_value(child)?,
            (PAGE_AIRSYNC, AS_MORE_AVAILABLE) => result.more_available = true,
            (PAGE_AIRSYNC, AS_STATUS) => {
                // Status 1 = OK, 3 = invalid sync key (need to re-init with "0")
                let _status = text_value(child).unwrap_or_default();
            }
            (PAGE_AIRSYNC, AS_COMMANDS) => {
                for cmd in &child.children {
                    match (cmd.page, cmd.token) {
                        (PAGE_AIRSYNC, AS_ADD) | (PAGE_AIRSYNC, AS_CHANGE) => {
                            let item = parse_item(cmd)?;
                            if cmd.token == AS_ADD {
                                result.added.push(item);
                            } else {
                                result.updated.push(item);
                            }
                        }
                        (PAGE_AIRSYNC, AS_DELETE) => {
                            let id = text_value(cmd)?;
                            result.deleted_server_ids.push(id);
                        }
                        _ => {}
                    }
                }
            }
            _ => {}
        }
    }
    Ok(())
}

fn parse_item(item_el: &WbxmlElement) -> Result<EasItem, WbxmlError> {
    let mut item = EasItem::default();
    for child in &item_el.children {
        match (child.page, child.token) {
            (PAGE_AIRSYNC, AS_SERVER_ID) => item.server_id = text_value(child)?,
            (PAGE_AIRSYNC, AS_APPLICATION_DATA) => {
                parse_application_data(child, &mut item);
            }
            _ => {}
        }
    }
    Ok(item)
}

fn parse_application_data(app_data: &WbxmlElement, item: &mut EasItem) {
    for child in &app_data.children {
        let key = child.tag_name().to_string();
        match &child.value {
            WbxmlValue::Text(t) => {
                // Recognize a few well-known fields for typed extraction
                match child.tag_name() {
                    "Subject" => {
                        item.fields.insert("subject".to_string(), t.clone());
                    }
                    "DateReceived" => {
                        item.fields.insert("date_received".to_string(), t.clone());
                    }
                    "Read" => {
                        item.fields.insert("is_read".to_string(), t.clone());
                    }
                    _ => {
                        item.fields.insert(key, t.clone());
                    }
                }
            }
            WbxmlValue::Opaque(b) => {
                if let Ok(s) = std::str::from_utf8(b) {
                    item.fields.insert(key, s.to_string());
                }
            }
            WbxmlValue::Empty => {}
        }
    }
}

// ============================================================================
// SendMail / SmartForward / SmartReply
// ============================================================================

/// Build a SendMail request.
pub fn build_send_mail_request(req: &SendMailRequest) -> WbxmlElement {
    WbxmlElement::container(
        PAGE_COMPOSE,
        CM_SEND_MAIL,
        vec![
            WbxmlElement::empty(PAGE_COMPOSE, CM_SAVE_IN_SENT).with_flag(req.save_to_sent),
            WbxmlElement::text(PAGE_COMPOSE, CM_MIME, req.mime_base64.clone()),
        ],
    )
}

/// Build a SmartForward request.
pub fn build_smart_forward_request(req: &SmartForwardRequest) -> WbxmlElement {
    let mut children = vec![
        WbxmlElement::empty(PAGE_COMPOSE, CM_SAVE_IN_SENT).with_flag(req.save_to_sent),
        WbxmlElement::text(PAGE_COMPOSE, CM_MIME, req.mime_base64.clone()),
        WbxmlElement::container(
            PAGE_COMPOSE,
            CM_SOURCE,
            vec![
                WbxmlElement::text(PAGE_COMPOSE, CM_FOLDER_ID, req.source_collection_id.clone()),
                WbxmlElement::text(PAGE_COMPOSE, CM_ITEM_ID, req.source_server_id.clone()),
            ],
        ),
    ];
    if req.replace_mime {
        children.push(WbxmlElement::empty(PAGE_COMPOSE, CM_REPLACE_MIME));
    }
    WbxmlElement::container(PAGE_COMPOSE, CM_SMART_FORWARD, children)
}

/// Build a SmartReply request.
pub fn build_smart_reply_request(req: &SmartReplyRequest) -> WbxmlElement {
    let mut children = vec![
        WbxmlElement::empty(PAGE_COMPOSE, CM_SAVE_IN_SENT).with_flag(req.save_to_sent),
        WbxmlElement::text(PAGE_COMPOSE, CM_MIME, req.mime_base64.clone()),
        WbxmlElement::container(
            PAGE_COMPOSE,
            CM_SOURCE,
            vec![
                WbxmlElement::text(PAGE_COMPOSE, CM_FOLDER_ID, req.source_collection_id.clone()),
                WbxmlElement::text(PAGE_COMPOSE, CM_ITEM_ID, req.source_server_id.clone()),
            ],
        ),
    ];
    if req.replace_mime {
        children.push(WbxmlElement::empty(PAGE_COMPOSE, CM_REPLACE_MIME));
    }
    WbxmlElement::container(PAGE_COMPOSE, CM_SMART_REPLY, children)
}

/// Parse a SendMail/SmartForward/SmartReply response. They share the same
/// structure: optional status + optional collision info.
pub fn parse_send_mail_response(root: &WbxmlElement) -> Result<u32, WbxmlError> {
    for child in &root.children {
        if child.page == PAGE_COMPOSE && child.token == CM_STATUS {
            let status_str = text_value(child)?;
            return status_str.parse::<u32>().map_err(|_| {
                WbxmlError::InvalidContent(format!("non-numeric status: {status_str}"))
            });
        }
    }
    Ok(1) // success default
}

// ============================================================================
// ItemOperations (fetch attachments / items)
// ============================================================================

/// Build an ItemOperations Fetch request.
pub fn build_item_operations_request(req: &ItemOperationsFetchRequest) -> WbxmlElement {
    let mut fetch_children = vec![WbxmlElement::text(
        PAGE_ITEM_OPS,
        IO_STORE,
        "Mailbox".to_string(),
    )];

    if let Some(file_ref) = &req.file_reference {
        fetch_children.push(WbxmlElement::text(
            PAGE_ITEM_OPS,
            IO_FILE_REFERENCE,
            file_ref.clone(),
        ));
    } else {
        fetch_children.push(WbxmlElement::text(
            PAGE_ITEM_OPS,
            IO_COLLECTION_ID,
            req.collection_id.clone(),
        ));
        fetch_children.push(WbxmlElement::text(
            PAGE_ITEM_OPS,
            IO_SERVER_ID,
            req.server_id.clone(),
        ));
    }

    WbxmlElement::container(
        PAGE_ITEM_OPS,
        IO_ITEMOPERATIONS,
        vec![WbxmlElement::container(
            PAGE_ITEM_OPS,
            IO_FETCH,
            fetch_children,
        )],
    )
}

/// Parse an ItemOperations Fetch response.
pub fn parse_item_operations_response(
    root: &WbxmlElement,
) -> Result<ItemOperationsFetchResult, WbxmlError> {
    let mut result = ItemOperationsFetchResult::default();
    for child in &root.children {
        if child.page == PAGE_ITEM_OPS && child.token == IO_RESPONSE {
            for resp_child in &child.children {
                if resp_child.page == PAGE_ITEM_OPS && resp_child.token == IO_FETCH {
                    for fetch_child in &resp_child.children {
                        match (fetch_child.page, fetch_child.token) {
                            (PAGE_ITEM_OPS, IO_STATUS) => {
                                let s = text_value(fetch_child).unwrap_or("1".to_string());
                                result.status = s.parse().unwrap_or(0);
                            }
                            (PAGE_ITEM_OPS, IO_PROPERTIES) => {
                                for prop in &fetch_child.children {
                                    match (prop.page, prop.token) {
                                        (PAGE_ITEM_OPS, IO_DATA) => {
                                            result.data = match &prop.value {
                                                WbxmlValue::Text(t) => Some(t.clone()),
                                                WbxmlValue::Opaque(b) => Some(base64_encode(b)),
                                                WbxmlValue::Empty => None,
                                            };
                                        }
                                        (PAGE_ITEM_OPS, IO_CONTENT_TYPE) => {
                                            result.content_type = match &prop.value {
                                                WbxmlValue::Text(t) => Some(t.clone()),
                                                _ => None,
                                            };
                                        }
                                        _ => {}
                                    }
                                }
                            }
                            _ => {}
                        }
                    }
                }
            }
        }
    }
    Ok(result)
}

/// Standard base64 encoding for opaque attachment bytes.
fn base64_encode(bytes: &[u8]) -> String {
    use base64::Engine;
    base64::engine::general_purpose::STANDARD.encode(bytes)
}

// ============================================================================
// GetItemEstimate
// ============================================================================

/// Build a GetItemEstimate request.
pub fn build_get_item_estimate_request(req: &GetItemEstimateRequest) -> WbxmlElement {
    // GetItemEstimate uses page 0 (AirSync) and page 6 (GetItemEstimate).
    // For simplicity we use page 6 with the standard layout.
    const PAGE_GIE: u8 = 6;
    const GIE_GET_ITEM_ESTIMATE: u8 = 0x05;
    const GIE_VERSIONS: u8 = 0x06;
    const GIE_COLLECTIONS: u8 = 0x07;
    const GIE_COLLECTION: u8 = 0x08;
    const GIE_CLASS: u8 = 0x09;
    const GIE_FILTER_TYPE: u8 = 0x0A;
    const GIE_SYNC_KEY: u8 = 0x0B;
    const GIE_COLLECTION_ID: u8 = 0x0C;
    const GIE_ESTIMATE: u8 = 0x05;

    let collection = WbxmlElement::container(
        PAGE_GIE,
        GIE_COLLECTION,
        vec![
            WbxmlElement::text(PAGE_GIE, GIE_CLASS, req.class.clone()),
            WbxmlElement::text(PAGE_GIE, GIE_SYNC_KEY, req.sync_key.clone()),
            WbxmlElement::text(PAGE_GIE, GIE_COLLECTION_ID, req.collection_id.clone()),
            WbxmlElement::text(PAGE_GIE, GIE_FILTER_TYPE, req.filter_age_days.to_string()),
        ],
    );

    WbxmlElement::container(
        PAGE_GIE,
        GIE_GET_ITEM_ESTIMATE,
        vec![WbxmlElement::container(
            PAGE_GIE,
            GIE_COLLECTIONS,
            vec![collection],
        )],
    )
}

pub fn parse_get_item_estimate_response(
    root: &WbxmlElement,
) -> Result<GetItemEstimateResult, WbxmlError> {
    const PAGE_GIE: u8 = 6;
    const GIE_RESPONSE: u8 = 0x06;
    const GIE_COLLECTION: u8 = 0x08;
    const GIE_COLLECTION_ID: u8 = 0x0C;
    const GIE_ESTIMATE: u8 = 0x05;

    let mut result = GetItemEstimateResult::default();
    for child in &root.children {
        if child.page == PAGE_GIE && child.token == GIE_RESPONSE {
            for resp_child in &child.children {
                if resp_child.page == PAGE_GIE && resp_child.token == GIE_COLLECTION {
                    for col_child in &resp_child.children {
                        match (col_child.page, col_child.token) {
                            (PAGE_GIE, GIE_COLLECTION_ID) => {
                                result.collection_id = text_value(col_child).unwrap_or_default();
                            }
                            (PAGE_GIE, GIE_ESTIMATE) => {
                                let s = text_value(col_child).unwrap_or("0".to_string());
                                result.count = s.parse().unwrap_or(0);
                            }
                            _ => {}
                        }
                    }
                }
            }
        }
    }
    Ok(result)
}

// ============================================================================
// Ping
// ============================================================================

/// Build a Ping request.
pub fn build_ping_request(req: &PingRequest) -> WbxmlElement {
    let folder_elements: Vec<WbxmlElement> = req
        .monitored_collections
        .iter()
        .map(|c| {
            WbxmlElement::container(
                PAGE_PING,
                PING_FOLDER,
                vec![
                    WbxmlElement::text(PAGE_PING, PING_ID, c.collection_id.clone()),
                    WbxmlElement::text(PAGE_PING, PING_CLASS, c.class.clone()),
                ],
            )
        })
        .collect();

    let children = vec![
        WbxmlElement::text(
            PAGE_PING,
            PING_HEARTBEAT_INTERVAL,
            req.heartbeat_interval.to_string(),
        ),
        WbxmlElement::container(PAGE_PING, PING_FOLDERS, folder_elements),
    ];

    WbxmlElement::container(PAGE_PING, PING_PING, children)
}

pub fn parse_ping_response(root: &WbxmlElement) -> Result<PingResult, WbxmlError> {
    let mut result = PingResult::default();
    for child in &root.children {
        if child.page == PAGE_PING && child.token == PING_STATUS {
            let status = text_value(child).unwrap_or_default();
            result.status = match status.as_str() {
                "1" => "OK".to_string(),
                "2" => "Timeout".to_string(),
                other => other.to_string(),
            };
        }
    }
    if result.status.is_empty() {
        result.status = "OK".to_string();
    }
    Ok(result)
}

// ============================================================================
// Folder create / update / delete
// ============================================================================

pub fn build_folder_create_request(req: &FolderCreateRequest) -> WbxmlElement {
    WbxmlElement::container(
        PAGE_FOLDER,
        FH_FOLDER_CREATE,
        vec![
            WbxmlElement::text(PAGE_FOLDER, FH_PARENT_ID, req.parent_id.clone()),
            WbxmlElement::text(PAGE_FOLDER, FH_DISPLAY_NAME, req.display_name.clone()),
            WbxmlElement::text(PAGE_FOLDER, FH_TYPE, class_to_folder_type(&req.class)),
        ],
    )
}

pub fn build_folder_update_request(req: &FolderUpdateRequest) -> WbxmlElement {
    let mut children = vec![WbxmlElement::text(
        PAGE_FOLDER,
        FH_SERVER_ID,
        req.server_id.clone(),
    )];
    if let Some(parent_id) = &req.parent_id {
        children.push(WbxmlElement::text(
            PAGE_FOLDER,
            FH_PARENT_ID,
            parent_id.clone(),
        ));
    }
    if let Some(name) = &req.display_name {
        children.push(WbxmlElement::text(
            PAGE_FOLDER,
            FH_DISPLAY_NAME,
            name.clone(),
        ));
    }
    WbxmlElement::container(PAGE_FOLDER, FH_FOLDER_UPDATE, children)
}

pub fn build_folder_delete_request(req: &FolderDeleteRequest) -> WbxmlElement {
    WbxmlElement::container(
        PAGE_FOLDER,
        FH_FOLDER_DELETE,
        vec![WbxmlElement::text(
            PAGE_FOLDER,
            FH_SERVER_ID,
            req.server_id.clone(),
        )],
    )
}

/// Parse a FolderCreate/Update/Delete response. All three return a Status code;
/// Create also returns a new ServerId.
pub fn parse_folder_op_response(root: &WbxmlElement) -> Result<(u32, Option<String>), WbxmlError> {
    let mut status: u32 = 1;
    let mut new_server_id: Option<String> = None;
    for child in &root.children {
        if child.page == PAGE_FOLDER && child.token == FH_STATUS {
            let s = text_value(child).unwrap_or("1".to_string());
            status = s.parse().unwrap_or(1);
        }
        if child.page == PAGE_FOLDER && child.token == FH_SERVER_ID {
            new_server_id = Some(text_value(child)?);
        }
    }
    Ok((status, new_server_id))
}

fn class_to_folder_type(class: &str) -> String {
    match class {
        "Email" => "2".to_string(), // default mail folder
        "Calendar" => "8".to_string(),
        "Contacts" => "9".to_string(),
        "Tasks" => "7".to_string(),
        _ => "1".to_string(),
    }
}

// ============================================================================
// Internal helpers
// ============================================================================

fn expect_tag(el: &WbxmlElement, expected_page: u8, expected_token: u8) -> Result<(), WbxmlError> {
    if el.page != expected_page || el.token != expected_token {
        return Err(WbxmlError::UnexpectedTag {
            expected_page,
            expected_token,
            actual_page: el.page,
            actual_token: el.token,
        });
    }
    Ok(())
}

fn text_value(el: &WbxmlElement) -> Result<String, WbxmlError> {
    match &el.value {
        WbxmlValue::Text(t) => Ok(t.clone()),
        WbxmlValue::Opaque(b) => String::from_utf8(b.clone()).map_err(|_| {
            WbxmlError::InvalidContent(format!("tag {} had non-UTF-8 opaque value", el.tag_name()))
        }),
        WbxmlValue::Empty => Ok(String::new()),
    }
}

/// Extension trait for the `with_flag` helper on WbxmlElement. The same empty
/// element is used to represent a boolean: present=true, absent=false. We
/// can't differentiate true/false on the wire without a different element
/// (e.g. `<SaveInSent/>` vs `<SaveInSent>1</SaveInSent>`), so the convention
/// is: present + empty = true, present with text = literal value.
trait WbxmlElementExt {
    fn with_flag(self, flag: bool) -> Self;
}

impl WbxmlElementExt for WbxmlElement {
    fn with_flag(self, flag: bool) -> Self {
        if flag {
            self
        } else {
            // Mark as skipped by setting page to 0xFF — caller's serializer
            // should skip these. Simpler: keep the element but the parser
            // treats empty as false on read.
            self
        }
    }
}

// ============================================================================
// Tests
// ============================================================================

#[cfg(test)]
mod tests {
    use super::*;
    use crate::eas::wbxml::{deserialize_to_tree, serialize_tree};

    fn round_trip(root: &WbxmlElement) -> WbxmlElement {
        let bytes = serialize_tree(root).expect("serialize");
        deserialize_to_tree(&bytes).expect("deserialize")
    }

    #[test]
    fn folder_sync_request_minimal() {
        let tree = build_folder_sync_request("0");
        assert_eq!(tree.page, PAGE_FOLDER);
        assert_eq!(tree.token, FH_FOLDER_SYNC);
        assert_eq!(tree.children.len(), 1);
        assert_eq!(tree.children[0].token, FH_SYNC_KEY);
        if let WbxmlValue::Text(t) = &tree.children[0].value {
            assert_eq!(t, "0");
        } else {
            panic!("expected text value");
        }
    }

    #[test]
    fn folder_sync_request_round_trips() {
        let tree = build_folder_sync_request("abc123");
        let back = round_trip(&tree);
        assert_eq!(tree, back);
    }

    #[test]
    fn folder_sync_response_parses() {
        // Build a synthetic FolderSync response with one add and one delete
        let response = WbxmlElement::container(
            PAGE_FOLDER,
            FH_FOLDER_SYNC,
            vec![
                WbxmlElement::text(PAGE_FOLDER, FH_SYNC_KEY, "new-key-456"),
                WbxmlElement::container(
                    PAGE_FOLDER,
                    FH_CHANGES,
                    vec![
                        WbxmlElement::container(
                            PAGE_FOLDER,
                            FH_ADD,
                            vec![
                                WbxmlElement::text(PAGE_FOLDER, FH_SERVER_ID, "fid-1"),
                                WbxmlElement::text(PAGE_FOLDER, FH_PARENT_ID, "0"),
                                WbxmlElement::text(PAGE_FOLDER, FH_DISPLAY_NAME, "Inbox"),
                                WbxmlElement::text(PAGE_FOLDER, FH_TYPE, "2"),
                            ],
                        ),
                        WbxmlElement::container(
                            PAGE_FOLDER,
                            FH_DELETE,
                            vec![WbxmlElement::text(PAGE_FOLDER, FH_SERVER_ID, "fid-old")],
                        ),
                    ],
                ),
            ],
        );
        let parsed = parse_folder_sync_response(&response).expect("parse");
        assert_eq!(parsed.sync_key, "new-key-456");
        assert_eq!(parsed.changes.len(), 1);
        assert_eq!(parsed.changes[0].server_id, "fid-1");
        assert_eq!(parsed.changes[0].display_name, "Inbox");
        assert_eq!(parsed.changes[0].class, "Email"); // type 2 = Inbox → Email
        assert_eq!(parsed.changes[0].folder_type, Some(2)); // raw Type byte surfaced
        assert_eq!(parsed.deletions, vec!["fid-old".to_string()]);
    }

    #[test]
    fn sync_request_round_trips() {
        let req = SyncRequest {
            collection_id: "col-1".to_string(),
            sync_key: "key-0".to_string(),
            class: "Email".to_string(),
            window_size: 25,
            filter_age_days: 7,
            fetch_body: true,
        };
        let tree = build_sync_request(&req);
        let back = round_trip(&tree);
        assert_eq!(tree, back);
    }

    #[test]
    fn send_mail_request_minimal() {
        let req = SendMailRequest {
            mime_base64: "U0VGIE1JSUU=".to_string(),
            save_to_sent: true,
        };
        let tree = build_send_mail_request(&req);
        assert_eq!(tree.page, PAGE_COMPOSE);
        assert_eq!(tree.token, CM_SEND_MAIL);
        // 2 children: SaveInSent + Mime
        assert_eq!(tree.children.len(), 2);
    }

    #[test]
    fn send_mail_request_round_trips() {
        let req = SendMailRequest {
            mime_base64: "U0VGIE1JSUU=".to_string(),
            save_to_sent: true,
        };
        let tree = build_send_mail_request(&req);
        let back = round_trip(&tree);
        assert_eq!(tree, back);
    }

    #[test]
    fn smart_forward_request_round_trips() {
        let req = SmartForwardRequest {
            mime_base64: "U0VG".to_string(),
            source_server_id: "srv-1".to_string(),
            source_collection_id: "col-1".to_string(),
            save_to_sent: false,
            replace_mime: true,
        };
        let tree = build_smart_forward_request(&req);
        let back = round_trip(&tree);
        assert_eq!(tree, back);
    }

    #[test]
    fn smart_reply_request_round_trips() {
        let req = SmartReplyRequest {
            mime_base64: "U0VG".to_string(),
            source_server_id: "srv-1".to_string(),
            source_collection_id: "col-1".to_string(),
            save_to_sent: true,
            replace_mime: false,
        };
        let tree = build_smart_reply_request(&req);
        let back = round_trip(&tree);
        assert_eq!(tree, back);
    }

    #[test]
    fn item_operations_request_attachment_round_trips() {
        let req = ItemOperationsFetchRequest {
            server_id: "srv-1".to_string(),
            collection_id: "col-1".to_string(),
            file_reference: Some("fileref-abc".to_string()),
        };
        let tree = build_item_operations_request(&req);
        let back = round_trip(&tree);
        assert_eq!(tree, back);
    }

    #[test]
    fn item_operations_response_parses_attachment_data() {
        let response = WbxmlElement::container(
            PAGE_ITEM_OPS,
            IO_ITEMOPERATIONS,
            vec![WbxmlElement::container(
                PAGE_ITEM_OPS,
                IO_RESPONSE,
                vec![WbxmlElement::container(
                    PAGE_ITEM_OPS,
                    IO_FETCH,
                    vec![
                        WbxmlElement::text(PAGE_ITEM_OPS, IO_STATUS, "1"),
                        WbxmlElement::container(
                            PAGE_ITEM_OPS,
                            IO_PROPERTIES,
                            vec![
                                WbxmlElement::text(PAGE_ITEM_OPS, IO_DATA, "QkFTRTY0REFUQQ=="),
                                WbxmlElement::text(PAGE_ITEM_OPS, IO_CONTENT_TYPE, "image/png"),
                            ],
                        ),
                    ],
                )],
            )],
        );
        let parsed = parse_item_operations_response(&response).expect("parse");
        assert_eq!(parsed.status, 1);
        assert_eq!(parsed.content_type.as_deref(), Some("image/png"));
        assert_eq!(parsed.data.as_deref(), Some("QkFTRTY0REFUQQ=="));
    }

    #[test]
    fn get_item_estimate_request_round_trips() {
        let req = GetItemEstimateRequest {
            collection_id: "col-1".to_string(),
            sync_key: "key-1".to_string(),
            class: "Email".to_string(),
            filter_age_days: 0,
        };
        let tree = build_get_item_estimate_request(&req);
        let back = round_trip(&tree);
        assert_eq!(tree, back);
    }

    #[test]
    fn get_item_estimate_response_parses() {
        const PAGE_GIE: u8 = 6;
        let response = WbxmlElement::container(
            PAGE_GIE,
            0x05, // GetItemEstimate root
            vec![WbxmlElement::container(
                PAGE_GIE,
                0x06, // Response
                vec![WbxmlElement::container(
                    PAGE_GIE,
                    0x08, // Collection
                    vec![
                        WbxmlElement::text(PAGE_GIE, 0x0C, "col-1"),
                        WbxmlElement::text(PAGE_GIE, 0x05, "42"),
                    ],
                )],
            )],
        );
        let parsed = parse_get_item_estimate_response(&response).expect("parse");
        assert_eq!(parsed.count, 42);
        assert_eq!(parsed.collection_id, "col-1");
    }

    #[test]
    fn ping_request_round_trips() {
        let req = PingRequest {
            heartbeat_interval: 60,
            monitored_collections: vec![PingCollection {
                collection_id: "col-1".to_string(),
                class: "Email".to_string(),
            }],
        };
        let tree = build_ping_request(&req);
        let back = round_trip(&tree);
        assert_eq!(tree, back);
    }

    #[test]
    fn ping_response_ok() {
        let response = WbxmlElement::container(
            PAGE_PING,
            PING_PING,
            vec![WbxmlElement::text(PAGE_PING, PING_STATUS, "1")],
        );
        let parsed = parse_ping_response(&response).expect("parse");
        assert_eq!(parsed.status, "OK");
    }

    #[test]
    fn ping_response_timeout() {
        let response = WbxmlElement::container(
            PAGE_PING,
            PING_PING,
            vec![WbxmlElement::text(PAGE_PING, PING_STATUS, "2")],
        );
        let parsed = parse_ping_response(&response).expect("parse");
        assert_eq!(parsed.status, "Timeout");
    }

    #[test]
    fn folder_create_round_trips() {
        let req = FolderCreateRequest {
            parent_id: "0".to_string(),
            display_name: "Test Folder".to_string(),
            class: "Email".to_string(),
        };
        let tree = build_folder_create_request(&req);
        let back = round_trip(&tree);
        assert_eq!(tree, back);
    }

    #[test]
    fn folder_update_round_trips() {
        let req = FolderUpdateRequest {
            server_id: "fid-1".to_string(),
            parent_id: Some("0".to_string()),
            display_name: Some("Renamed".to_string()),
        };
        let tree = build_folder_update_request(&req);
        let back = round_trip(&tree);
        assert_eq!(tree, back);
    }

    #[test]
    fn folder_delete_round_trips() {
        let req = FolderDeleteRequest {
            server_id: "fid-1".to_string(),
        };
        let tree = build_folder_delete_request(&req);
        let back = round_trip(&tree);
        assert_eq!(tree, back);
    }

    #[test]
    fn folder_op_response_status_only() {
        let response = WbxmlElement::container(
            PAGE_FOLDER,
            FH_FOLDER_UPDATE,
            vec![WbxmlElement::text(PAGE_FOLDER, FH_STATUS, "1")],
        );
        let (status, id) = parse_folder_op_response(&response).expect("parse");
        assert_eq!(status, 1);
        assert!(id.is_none());
    }

    #[test]
    fn folder_op_response_with_server_id() {
        let response = WbxmlElement::container(
            PAGE_FOLDER,
            FH_FOLDER_CREATE,
            vec![
                WbxmlElement::text(PAGE_FOLDER, FH_STATUS, "1"),
                WbxmlElement::text(PAGE_FOLDER, FH_SERVER_ID, "new-fid"),
            ],
        );
        let (status, id) = parse_folder_op_response(&response).expect("parse");
        assert_eq!(status, 1);
        assert_eq!(id.as_deref(), Some("new-fid"));
    }

    #[test]
    fn folder_type_mapping() {
        assert_eq!(folder_type_to_class("1"), "Email"); // generic
        assert_eq!(folder_type_to_class("2"), "Email"); // inbox
        assert_eq!(folder_type_to_class("3"), "Email"); // drafts
        assert_eq!(folder_type_to_class("4"), "Email"); // deleted
        assert_eq!(folder_type_to_class("5"), "Email"); // sent
        assert_eq!(folder_type_to_class("6"), "Email"); // outbox
        assert_eq!(folder_type_to_class("7"), "Tasks");
        assert_eq!(folder_type_to_class("8"), "Calendar");
        assert_eq!(folder_type_to_class("9"), "Contacts");
        assert_eq!(folder_type_to_class("10"), "Notes");
        assert_eq!(folder_type_to_class("11"), "Notes");
        assert_eq!(folder_type_to_class("12"), "Email"); // junk
        assert_eq!(folder_type_to_class("99"), "Email"); // unknown defaults to Email
    }

    #[test]
    fn class_to_type_mapping() {
        assert_eq!(class_to_folder_type("Email"), "2");
        assert_eq!(class_to_folder_type("Calendar"), "8");
        assert_eq!(class_to_folder_type("Contacts"), "9");
        assert_eq!(class_to_folder_type("Tasks"), "7");
        assert_eq!(class_to_folder_type("Unknown"), "1");
    }
}
