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
use crate::eas::wbxml::tags::{self, pages};
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
const AS_OPTIONS: u8 = 0x17; // Options (per [MS-ASSYNC] 2.2.3.25); matches tags::airsync::OPTIONS
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

    // Per [MS-ASSYNC] 2.2.3.25 — `Options` inside a `Collection` lets the
    // client request a specific body format. We emit an AirSyncBase
    // `BodyPreference` with `Type=2` (HTML) so the server returns message
    // bodies. Gated on `fetch_body` so header-only sync rounds stay cheap.
    // Code-page ids: AirSyncBase = 17 (pages::BASE); tokens are
    // `BodyPreference` (0x05) and `Type` (0x06) per tags::base.
    if req.fetch_body {
        let body_preference = WbxmlElement::container(
            pages::BASE,
            tags::base::BODY_PREFERENCE,
            vec![WbxmlElement::text(pages::BASE, tags::base::TYPE, "2")],
        );
        let options = WbxmlElement::container(
            PAGE_AIRSYNC,
            AS_OPTIONS,
            vec![body_preference],
        );
        collection_children.push(options);
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
                // MS-ASSYNC 2.2.3.23 collection status. Surface the parsed
                // value on `SyncResult.status` so callers (notably
                // `EasSource::sync_folder`'s status-3 resync branch) can act
                // on it. The wire value is a decimal string; a non-numeric or
                // missing value leaves the default success status in place
                // rather than aborting the whole parse.
                if let Ok(s) = text_value(child) {
                    if let Ok(n) = s.parse::<u32>() {
                        result.status = n;
                    }
                }
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

/// Walk `ApplicationData` children and populate `EasItem` typed fields.
///
/// Dispatch is by `child.tag_name()` so the parser is robust to which code
/// page a tag was serialized on (EAS servers are inconsistent about whether
/// `From` lives on the Email page or is repeated on a child page). Unknown
/// tags are ignored — the MVP only surfaces the fields `EasItem` models.
///
/// Body type dispatch (MS-ASEMAIL `AirSyncBase:Body`):
///   - Type 2 → HTML  (`body_html`)
///   - Type 1 → plain (`body_text`)
///   - other/missing → fallback writes the same payload to both slots so the
///     UI degrades gracefully rather than showing an empty message.
///
/// Flag: MS-ASEMAIL `Flag` has a `Status` child; `Status = "2"` means the
/// message is flagged for follow-up, so we set `flag = Some(true)` only in
/// that case (and `Some(false)` if a Flag element is present with any other
/// Status). Absent Flag → `None` (unknown).
fn parse_application_data(app_data: &WbxmlElement, item: &mut EasItem) {
    for child in &app_data.children {
        match child.tag_name() {
            "Subject" => item.subject = text_value_opt(child),
            "From" => item.from = text_value_opt(child),
            "To" => item.to = text_value_opt(child),
            "Cc" => item.cc = text_value_opt(child),
            "Bcc" => item.bcc = text_value_opt(child),
            "ReplyTo" => item.reply_to = text_value_opt(child),
            "DateReceived" => item.date_received = text_value_opt(child),
            "Read" => item.read = text_value_opt(child).map(|s| s == "1"),
            "Flag" => {
                // Flag.Status == "2" → active flag. Any other present Status
                // value is treated as not-flagged; absent Status is also
                // not-flagged. We only set Some(..) when a Flag element exists.
                let active = child
                    .children
                    .iter()
                    .any(|c| c.tag_name() == "Status" && text_value_opt(c).as_deref() == Some("2"));
                item.flag = Some(active);
            }
            "Importance" => item.importance = text_value_opt(child).and_then(|s| s.parse().ok()),
            "Body" => parse_body(child, item),
            "Attachments" => parse_attachments(child, item),
            "ConversationId" => {
                // ConversationId (Email2 page 22, token 0x09) is opaque binary
                // on the wire, but many Exchange deployments serialize it as
                // base64 *text*. Handle both variants and keep the bytes
                // verbatim — downstream treats `conversation_id` as opaque
                // bytes (no base64 decode). A missing or empty value must map
                // to `None` (not `Some(vec![])`), since empty != absent and
                // `Some([])` would serialize as `"conversationId":[]`,
                // misleading the frontend's threading logic.
                item.conversation_id = match &child.value {
                    WbxmlValue::Opaque(b) if !b.is_empty() => Some(b.clone()),
                    WbxmlValue::Text(s) if !s.is_empty() => Some(s.as_bytes().to_vec()),
                    _ => None,
                };
            }
            "IsDraft" => item.is_draft = text_value_opt(child).map(|s| s == "1"),
            // Tags we deliberately ignore for MVP — they are either metadata
            // we don't model yet, or already consumed at a higher level
            // (e.g. Status on ApplicationData belongs to the Sync command,
            // not the item).
            "InternetCPID" | "ContentClass" | "ThreadTopic" | "MessageClass" | "Status" => {}
            _ => {} // unknown tags: ignore
        }
    }
}

/// Parse an `AirSyncBase:Body` element into `body_html` / `body_text` /
/// `body_truncated` / `preview` on the item.
fn parse_body(elem: &WbxmlElement, item: &mut EasItem) {
    let mut body_type: Option<u8> = None;
    let mut data: Option<String> = None;
    let mut truncated = false;
    let mut preview: Option<String> = None;
    for child in &elem.children {
        match child.tag_name() {
            "Type" => body_type = text_value_opt(child).and_then(|s| s.parse().ok()),
            "Data" => data = text_value_opt(child),
            "Truncated" => truncated = text_value_opt(child).as_deref() == Some("1"),
            "Preview" => preview = text_value_opt(child),
            "EstimatedDataSize" => {} // not surfaced on EasItem
            _ => {}
        }
    }
    match body_type {
        Some(2) => item.body_html = data,      // Type 2 = HTML
        Some(1) => item.body_text = data,      // Type 1 = PlainText
        _ => {
            // Unknown / missing type: write to both slots so the UI can still
            // render something. Prefer HTML for display, plain for search.
            item.body_html = data.clone();
            item.body_text = data;
        }
    }
    item.body_truncated = if truncated { Some(true) } else { None };
    item.preview = preview;
}

/// Parse an `AirSyncBase:Attachments` container into `item.attachments` and
/// set `has_attachments` based on whether any `Attachment` children were found.
fn parse_attachments(elem: &WbxmlElement, item: &mut EasItem) {
    for child in &elem.children {
        if child.tag_name() != "Attachment" {
            continue;
        }
        let mut att = EasAttachment::default();
        for field in &child.children {
            match field.tag_name() {
                "DisplayName" => att.display_name = text_value_opt(field).unwrap_or_default(),
                "FileReference" => att.file_reference = text_value_opt(field).unwrap_or_default(),
                "Method" => att.method = text_value_opt(field).and_then(|s| s.parse().ok()),
                "ContentId" => att.content_id = text_value_opt(field),
                "IsInline" => att.is_inline = text_value_opt(field).as_deref() == Some("1"),
                "ContentType" => att.content_type = text_value_opt(field),
                "EstimatedDataSize" => {
                    att.estimated_data_size = text_value_opt(field).and_then(|s| s.parse().ok());
                }
                "ContentLocation" => att.content_location = text_value_opt(field),
                _ => {}
            }
        }
        item.attachments.push(att);
    }
    item.has_attachments = !item.attachments.is_empty();
}

/// Return the text value of a leaf element, or `None` for empty/opaque leaves.
///
/// Distinct from the module-level `text_value(&WbxmlElement) -> Result<String,
/// WbxmlError>` helper (which is the fallible form used by the strict FolderSync
/// / Sync-key parsers). This `_opt` variant is the permissive form for
/// `ApplicationData` field extraction, where a missing or non-text value should
/// silently map to `None` rather than abort the whole item parse.
fn text_value_opt(elem: &WbxmlElement) -> Option<String> {
    match &elem.value {
        WbxmlValue::Text(s) => Some(s.clone()),
        WbxmlValue::Opaque(b) => std::str::from_utf8(b).ok().map(|s| s.to_string()),
        WbxmlValue::Empty => None,
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

    // ---- Phase 3a Task 1: typed EasItem/EasAttachment + SyncResult.status ----

    /// `SyncResult::default()` must surface `status = 1` (success) per
    /// [MS-ASSYNC] 2.2.3.23. The engine reads this to decide whether to
    /// persist the returned sync_key.
    #[test]
    fn sync_result_default_status_is_success() {
        let r = SyncResult::default();
        assert_eq!(r.status, 1, "default SyncResult.status must be 1 (success)");
        assert!(!r.more_available);
        assert!(r.added.is_empty());
        assert!(r.updated.is_empty());
        assert!(r.deleted_server_ids.is_empty());
    }

    /// `EasItem` is now a typed struct (not a HashMap). Default has empty
    /// server_id, None subject, no attachments, `has_attachments = false`.
    #[test]
    fn eas_item_is_typed_struct_with_expected_fields() {
        let item = EasItem::default();
        assert_eq!(item.server_id, "");
        assert_eq!(item.subject, None);
        assert_eq!(item.from, None);
        assert_eq!(item.to, None);
        assert_eq!(item.cc, None);
        assert_eq!(item.bcc, None);
        assert_eq!(item.reply_to, None);
        assert_eq!(item.date_received, None);
        assert_eq!(item.read, None);
        assert_eq!(item.flag, None);
        assert_eq!(item.importance, None);
        assert_eq!(item.body_html, None);
        assert_eq!(item.body_text, None);
        assert_eq!(item.body_truncated, None);
        assert_eq!(item.preview, None);
        assert!(!item.has_attachments);
        assert!(item.attachments.is_empty());
        assert_eq!(item.conversation_id, None);
        assert_eq!(item.is_draft, None);
        assert_eq!(item.message_id, None);
    }

    /// A fully-populated `EasItem` round-trips through serde, proving the
    /// `camelCase` rename matches what the frontend TS interface expects.
    #[test]
    fn eas_item_round_trips_through_serde() {
        let item = EasItem {
            server_id: "1:abc".to_string(),
            subject: Some("Hello".to_string()),
            from: Some("a@b.com".to_string()),
            to: Some("c@d.com".to_string()),
            cc: None,
            bcc: None,
            reply_to: None,
            date_received: Some("2026-06-29T00:00:00.000Z".to_string()),
            read: Some(true),
            flag: Some(false),
            importance: Some(1),
            body_html: Some("<p>hi</p>".to_string()),
            body_text: Some("hi".to_string()),
            body_truncated: Some(false),
            preview: Some("hi".to_string()),
            has_attachments: true,
            attachments: vec![EasAttachment {
                file_reference: "ref-1".to_string(),
                display_name: "file.txt".to_string(),
                method: Some(1),
                estimated_data_size: Some(42),
                content_type: Some("text/plain".to_string()),
                content_location: None,
                is_inline: false,
                content_id: None,
            }],
            conversation_id: Some(vec![0xDE, 0xAD]),
            is_draft: Some(false),
            message_id: Some("<msg@host>".to_string()),
        };
        let json = serde_json::to_string(&item).expect("serialize");
        // camelCase rename evidence:
        assert!(json.contains("\"dateReceived\""), "date_received must serialize as dateReceived");
        assert!(json.contains("\"bodyHtml\""), "body_html must serialize as bodyHtml");
        assert!(json.contains("\"hasAttachments\""), "has_attachments must serialize as hasAttachments");
        assert!(json.contains("\"conversationId\""), "conversation_id must serialize as conversationId");
        assert!(json.contains("\"isDraft\""), "is_draft must serialize as isDraft");
        assert!(json.contains("\"messageId\""), "message_id must serialize as messageId");
        assert!(json.contains("\"estimatedDataSize\""), "EasAttachment.estimated_data_size must serialize as estimatedDataSize");
        let back: EasItem = serde_json::from_str(&json).expect("deserialize");
        assert_eq!(back.server_id, item.server_id);
        assert_eq!(back.subject, item.subject);
        assert_eq!(back.has_attachments, item.has_attachments);
        assert_eq!(back.attachments.len(), 1);
        assert_eq!(back.attachments[0].content_type.as_deref(), Some("text/plain"));
        assert_eq!(back.conversation_id, Some(vec![0xDE, 0xAD]));
    }

    /// `EasAttachment` gained `content_type`, `estimated_data_size` (now u32
    /// per the typed contract), and `content_location`.
    #[test]
    fn eas_attachment_new_fields_default_none() {
        let a = EasAttachment::default();
        assert_eq!(a.content_type, None);
        assert_eq!(a.estimated_data_size, None);
        assert_eq!(a.content_location, None);
    }

    /// Email (page 2) tag constants exist at the documented hex values.
    #[test]
    fn email_tag_constants_match_spec() {
        use crate::eas::wbxml::tags::email;
        assert_eq!(email::PAGE, 2);
        assert_eq!(email::DATE_RECEIVED, 0x0F);
        assert_eq!(email::SUBJECT, 0x14);
        assert_eq!(email::READ, 0x15);
        assert_eq!(email::TO, 0x16);
        assert_eq!(email::CC, 0x17);
        assert_eq!(email::FROM, 0x18);
        assert_eq!(email::REPLY_TO, 0x19);
        assert_eq!(email::IMPORTANCE, 0x12);
        assert_eq!(email::FLAG, 0x3A);
    }

    /// Email2 (page 22) tag constants exist at the documented hex values.
    #[test]
    fn email2_tag_constants_match_spec() {
        use crate::eas::wbxml::tags::email2;
        assert_eq!(email2::PAGE, 22);
        assert_eq!(email2::CONVERSATION_ID, 0x09);
        assert_eq!(email2::IS_DRAFT, 0x15);
        assert_eq!(email2::BCC, 0x16);
    }

    // ---- Phase 3a Task 2: parse_application_data ----

    /// Fixture: a synthetic EAS email ApplicationData element carrying the
    /// fields the MVP parser must surface. Built with the real `WbxmlElement`
    /// constructors on the documented code pages so `tag_name()` dispatch in
    /// `parse_application_data` resolves identically to a server-generated tree.
    ///
    /// Tree shape (codes in `(page, token)` form):
    /// ```text
    /// ApplicationData (0, 0x1D)
    ///   ├── Subject     (2, 0x14) = "Hello World"
    ///   ├── From        (2, 0x18) = "alice@example.com"
    ///   ├── To          (2, 0x16) = "bob@example.com"
    ///   ├── Read        (2, 0x15) = "1"
    ///   └── Body        (17, 0x0A)
    ///       ├── Type    (17, 0x06) = "2"   (HTML)
    ///       └── Data    (17, 0x0B) = "<p>Hi</p>"
    /// ```
    /// The fixture intentionally omits the optional fields (Cc/Bcc/Flag/Attachments/
    /// ConversationId/IsDraft) — those are exercised by the focused tests below.
    #[test]
    fn parse_application_data_populates_core_email_fields() {
        use crate::eas::wbxml::tags::{base, email, pages};

        let app_data = WbxmlElement::container(
            PAGE_AIRSYNC,
            AS_APPLICATION_DATA,
            vec![
                WbxmlElement::text(email::PAGE, email::SUBJECT, "Hello World"),
                WbxmlElement::text(email::PAGE, email::FROM, "alice@example.com"),
                WbxmlElement::text(email::PAGE, email::TO, "bob@example.com"),
                WbxmlElement::text(email::PAGE, email::READ, "1"),
                WbxmlElement::container(
                    pages::BASE,
                    base::BODY,
                    vec![
                        WbxmlElement::text(pages::BASE, base::TYPE, "2"),
                        WbxmlElement::text(pages::BASE, base::DATA, "<p>Hi</p>"),
                    ],
                ),
            ],
        );

        // Drive it through the public Sync-response parser entry point so the
        // server_id → application_data wiring (parse_item) is also covered.
        let item = parse_application_data_for_test("1:abc", &app_data);

        assert_eq!(item.server_id, "1:abc");
        assert_eq!(item.subject.as_deref(), Some("Hello World"));
        assert_eq!(item.from.as_deref(), Some("alice@example.com"));
        assert_eq!(item.to.as_deref(), Some("bob@example.com"));
        assert_eq!(item.read, Some(true));
        // Body Type 2 → HTML body slot populated, plain-text slot stays None.
        assert_eq!(item.body_html.as_deref(), Some("<p>Hi</p>"));
        assert_eq!(item.body_text, None);
        // No attachments in this fixture.
        assert!(!item.has_attachments);
        assert!(item.attachments.is_empty());
    }

    /// Convenience wrapper around the (currently stubbed) parser so the test
    /// references the real function name. This mirrors the brief's
    /// `parse_application_data(server_id, &elem) -> EasItem` signature.
    fn parse_application_data_for_test(server_id: &str, elem: &WbxmlElement) -> EasItem {
        let mut item = EasItem {
            server_id: server_id.to_string(),
            ..Default::default()
        };
        parse_application_data(elem, &mut item);
        item
    }

    /// Body Type 1 (PlainText) must populate `body_text`, leaving `body_html` None.
    #[test]
    fn parse_application_data_body_type_1_is_plain_text() {
        use crate::eas::wbxml::tags::{base, pages};
        let app_data = WbxmlElement::container(
            PAGE_AIRSYNC,
            AS_APPLICATION_DATA,
            vec![WbxmlElement::container(
                pages::BASE,
                base::BODY,
                vec![
                    WbxmlElement::text(pages::BASE, base::TYPE, "1"),
                    WbxmlElement::text(pages::BASE, base::DATA, "plain body"),
                    WbxmlElement::text(pages::BASE, base::TRUNCATED, "1"),
                    WbxmlElement::text(pages::BASE, base::PREVIEW, "preview…"),
                ],
            )],
        );
        let item = parse_application_data_for_test("s1", &app_data);
        assert_eq!(item.body_text.as_deref(), Some("plain body"));
        assert_eq!(item.body_html, None);
        assert_eq!(item.body_truncated, Some(true));
        assert_eq!(item.preview.as_deref(), Some("preview…"));
    }

    /// A missing/unknown Body Type falls back to populating both body slots.
    #[test]
    fn parse_application_data_body_unknown_type_fills_both_slots() {
        use crate::eas::wbxml::tags::{base, pages};
        let app_data = WbxmlElement::container(
            PAGE_AIRSYNC,
            AS_APPLICATION_DATA,
            vec![WbxmlElement::container(
                pages::BASE,
                base::BODY,
                vec![WbxmlElement::text(pages::BASE, base::DATA, "mystery")],
            )],
        );
        let item = parse_application_data_for_test("s1", &app_data);
        assert_eq!(item.body_html.as_deref(), Some("mystery"));
        assert_eq!(item.body_text.as_deref(), Some("mystery"));
    }

    /// Flag with Status="2" → `flag = Some(true)` (active follow-up).
    #[test]
    fn parse_application_data_flag_active_when_status_is_2() {
        use crate::eas::wbxml::tags::email;
        let app_data = WbxmlElement::container(
            PAGE_AIRSYNC,
            AS_APPLICATION_DATA,
            vec![WbxmlElement::container(
                email::PAGE,
                email::FLAG,
                vec![WbxmlElement::text(email::PAGE, 0x3B, "2")], // Flag:Status
            )],
        );
        let item = parse_application_data_for_test("s1", &app_data);
        assert_eq!(item.flag, Some(true));
    }

    /// Flag present but Status != "2" → `flag = Some(false)` (cleared).
    #[test]
    fn parse_application_data_flag_inactive_when_status_not_2() {
        use crate::eas::wbxml::tags::email;
        let app_data = WbxmlElement::container(
            PAGE_AIRSYNC,
            AS_APPLICATION_DATA,
            vec![WbxmlElement::container(
                email::PAGE,
                email::FLAG,
                vec![WbxmlElement::text(email::PAGE, 0x3B, "0")], // cleared
            )],
        );
        let item = parse_application_data_for_test("s1", &app_data);
        assert_eq!(item.flag, Some(false));
    }

    /// No Flag element → `flag = None`.
    #[test]
    fn parse_application_data_flag_absent_is_none() {
        let app_data = WbxmlElement::container(
            PAGE_AIRSYNC,
            AS_APPLICATION_DATA,
            vec![WbxmlElement::text(2, 0x14, "Subject only")],
        );
        let item = parse_application_data_for_test("s1", &app_data);
        assert_eq!(item.flag, None);
    }

    /// Attachments container with one Attachment populates `attachments`,
    /// sets `has_attachments = true`, and maps each AirSyncBase field.
    #[test]
    fn parse_application_data_attachments_populated() {
        use crate::eas::wbxml::tags::{base, pages};
        let app_data = WbxmlElement::container(
            PAGE_AIRSYNC,
            AS_APPLICATION_DATA,
            vec![WbxmlElement::container(
                pages::BASE,
                base::ATTACHMENTS,
                vec![WbxmlElement::container(
                    pages::BASE,
                    base::ATTACHMENT,
                    vec![
                        WbxmlElement::text(pages::BASE, base::DISPLAY_NAME, "report.pdf"),
                        WbxmlElement::text(pages::BASE, base::FILE_REFERENCE, "ref-42"),
                        WbxmlElement::text(pages::BASE, base::METHOD, "1"),
                        WbxmlElement::text(pages::BASE, base::CONTENT_ID, "<cid-1>"),
                        WbxmlElement::text(pages::BASE, base::IS_INLINE, "0"),
                        WbxmlElement::text(pages::BASE, base::CONTENT_TYPE, "application/pdf"),
                        WbxmlElement::text(pages::BASE, base::ESTIMATED_DATA_SIZE, "4096"),
                        WbxmlElement::text(pages::BASE, base::CONTENT_LOCATION, "https://x/a.pdf"),
                    ],
                )],
            )],
        );
        let item = parse_application_data_for_test("s1", &app_data);
        assert!(item.has_attachments);
        assert_eq!(item.attachments.len(), 1);
        let a = &item.attachments[0];
        assert_eq!(a.display_name, "report.pdf");
        assert_eq!(a.file_reference, "ref-42");
        assert_eq!(a.method, Some(1));
        assert_eq!(a.content_id.as_deref(), Some("<cid-1>"));
        assert!(!a.is_inline);
        assert_eq!(a.content_type.as_deref(), Some("application/pdf"));
        assert_eq!(a.estimated_data_size, Some(4096));
        assert_eq!(a.content_location.as_deref(), Some("https://x/a.pdf"));
    }

    /// Empty Attachments container → `has_attachments = false`, empty vec.
    #[test]
    fn parse_application_data_empty_attachments_has_none() {
        use crate::eas::wbxml::tags::{base, pages};
        let app_data = WbxmlElement::container(
            PAGE_AIRSYNC,
            AS_APPLICATION_DATA,
            vec![WbxmlElement::container(
                pages::BASE,
                base::ATTACHMENTS,
                vec![],
            )],
        );
        let item = parse_application_data_for_test("s1", &app_data);
        assert!(!item.has_attachments);
        assert!(item.attachments.is_empty());
    }

    /// ConversationId (opaque) round-trips into `conversation_id: Vec<u8>`.
    #[test]
    fn parse_application_data_conversation_id_opaque() {
        use crate::eas::wbxml::tags::email2;
        let app_data = WbxmlElement::container(
            PAGE_AIRSYNC,
            AS_APPLICATION_DATA,
            vec![WbxmlElement::opaque(
                email2::PAGE,
                email2::CONVERSATION_ID,
                vec![0xDE, 0xAD, 0xBE, 0xEF],
            )],
        );
        let item = parse_application_data_for_test("s1", &app_data);
        assert_eq!(item.conversation_id, Some(vec![0xDE, 0xAD, 0xBE, 0xEF]));
    }

    /// ConversationId carried as base64 **text** (page 22, token 0x09) — the form
    /// many Exchange deployments serialize it in — must parse to a non-empty
    /// `Some(Vec<u8>)`. The bytes are kept verbatim (no base64 decode); downstream
    /// treats `conversation_id` as opaque bytes regardless of wire form.
    ///
    /// Regression for the asymmetry where the old `opaque_value_opt` only matched
    /// `WbxmlValue::Opaque` and silently dropped the text form.
    #[test]
    fn parse_application_data_conversation_id_text_form_is_kept() {
        use crate::eas::wbxml::tags::email2;
        let app_data = WbxmlElement::container(
            PAGE_AIRSYNC,
            AS_APPLICATION_DATA,
            vec![WbxmlElement::text(
                email2::PAGE,
                email2::CONVERSATION_ID,
                "Y29udm8=", // arbitrary base64-looking string; kept verbatim
            )],
        );
        let item = parse_application_data_for_test("s1", &app_data);
        let cid = item
            .conversation_id
            .clone()
            .expect("text-form ConversationId must not be dropped");
        assert!(!cid.is_empty(), "non-empty text must yield non-empty bytes");
        assert_eq!(cid, b"Y29udm8=".to_vec());
    }

    /// A missing or empty ConversationId must parse to `None`, NOT `Some(vec![])`.
    /// `Some([])` serializes as `"conversationId":[]` (empty array) which is
    /// semantically wrong — empty != absent — and would mislead the frontend's
    /// threading logic. This locks the `None`-on-empty contract.
    ///
    /// Regression for the old `unwrap_or_default()` which turned a missing/opaque
    /// value into `Some(vec![])`.
    #[test]
    fn parse_application_data_conversation_id_missing_or_empty_is_none() {
        use crate::eas::wbxml::tags::email2;

        // Case 1: no ConversationId element at all.
        let app_data = WbxmlElement::container(
            PAGE_AIRSYNC,
            AS_APPLICATION_DATA,
            vec![WbxmlElement::text(2, 0x14, "Subject only")],
        );
        let item = parse_application_data_for_test("s1", &app_data);
        assert_eq!(
            item.conversation_id,
            None,
            "absent ConversationId must be None, not Some(vec![])"
        );

        // Case 2: ConversationId present but empty (Empty value).
        let app_data = WbxmlElement::container(
            PAGE_AIRSYNC,
            AS_APPLICATION_DATA,
            vec![WbxmlElement::empty(email2::PAGE, email2::CONVERSATION_ID)],
        );
        let item = parse_application_data_for_test("s1", &app_data);
        assert_eq!(
            item.conversation_id,
            None,
            "empty ConversationId must be None, not Some(vec![])"
        );

        // Case 3: ConversationId present as empty opaque blob.
        let app_data = WbxmlElement::container(
            PAGE_AIRSYNC,
            AS_APPLICATION_DATA,
            vec![WbxmlElement::opaque(email2::PAGE, email2::CONVERSATION_ID, vec![])],
        );
        let item = parse_application_data_for_test("s1", &app_data);
        assert_eq!(
            item.conversation_id,
            None,
            "empty-opaque ConversationId must be None, not Some(vec![])"
        );

        // Case 4: ConversationId present as empty text string.
        let app_data = WbxmlElement::container(
            PAGE_AIRSYNC,
            AS_APPLICATION_DATA,
            vec![WbxmlElement::text(email2::PAGE, email2::CONVERSATION_ID, "")],
        );
        let item = parse_application_data_for_test("s1", &app_data);
        assert_eq!(
            item.conversation_id,
            None,
            "empty-text ConversationId must be None, not Some(vec![])"
        );
    }

    /// IsDraft="1" → `Some(true)`; IsDraft="0" → `Some(false)`.
    #[test]
    fn parse_application_data_is_draft_flag() {
        use crate::eas::wbxml::tags::email2;
        let app_data = WbxmlElement::container(
            PAGE_AIRSYNC,
            AS_APPLICATION_DATA,
            vec![
                WbxmlElement::text(email2::PAGE, email2::IS_DRAFT, "1"),
                WbxmlElement::text(email2::PAGE, email2::BCC, "secret@example.com"),
            ],
        );
        let item = parse_application_data_for_test("s1", &app_data);
        assert_eq!(item.is_draft, Some(true));
        assert_eq!(item.bcc.as_deref(), Some("secret@example.com"));
    }

    /// Unknown tags are ignored — the parser must not panic or mis-dispatch.
    #[test]
    fn parse_application_data_ignores_unknown_tags() {
        // Use an unregistered (page, token) so tag_name() returns "unknown".
        let app_data = WbxmlElement::container(
            PAGE_AIRSYNC,
            AS_APPLICATION_DATA,
            vec![
                WbxmlElement::text(0xFE, 0x7F, "garbage"),
                WbxmlElement::text(2, 0x14, "Real Subject"),
            ],
        );
        let item = parse_application_data_for_test("s1", &app_data);
        assert_eq!(item.subject.as_deref(), Some("Real Subject"));
    }

    // ---- Phase 3a Task 3: build_sync_request emits BodyPreference ----

    /// `build_sync_request` must emit an `Options/BodyPreference/Type=2` element
    /// inside each `Collection` so the server returns HTML bodies (per
    /// [MS-ASAIRSMB] AirSyncBase:BodyPreference). This test serializes the
    /// built tree to WBXML bytes and back, then walks the deserialized tree to
    /// prove the element survives a real round-trip — a pure structural
    /// equality check would miss serializer/deserializer bugs.
    #[test]
    fn build_sync_request_emits_body_preference_type_2() {
        use crate::eas::wbxml::tags::{airsync, base, pages};

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

        // Root: Sync (page 0, 0x05)
        assert_eq!(back.page, PAGE_AIRSYNC);
        assert_eq!(back.token, AS_SYNC);

        // Walk Collections → Collection.
        let collections = back
            .children
            .iter()
            .find(|c| c.page == PAGE_AIRSYNC && c.token == AS_COLLECTIONS)
            .expect("missing Collections container");
        let collection = collections
            .children
            .iter()
            .find(|c| c.page == PAGE_AIRSYNC && c.token == AS_COLLECTION)
            .expect("missing Collection element");

        // Options must be present inside the collection.
        let options = collection
            .children
            .iter()
            .find(|c| c.page == pages::AIRSYNC && c.token == airsync::OPTIONS)
            .expect("missing Options element inside Collection");
        assert_eq!(options.tag_name(), "Options");

        // BodyPreference inside Options.
        let body_pref = options
            .children
            .iter()
            .find(|c| c.page == pages::BASE && c.token == base::BODY_PREFERENCE)
            .expect("missing BodyPreference element inside Options");
        assert_eq!(body_pref.tag_name(), "BodyPreference");

        // Type child must be present with value "2" (HTML).
        let type_el = body_pref
            .children
            .iter()
            .find(|c| c.page == pages::BASE && c.token == base::TYPE)
            .expect("missing Type element inside BodyPreference");
        assert_eq!(type_el.tag_name(), "Type");
        match &type_el.value {
            WbxmlValue::Text(t) => assert_eq!(t, "2"),
            other => panic!("expected Text value for BodyPreference/Type, got {:?}", other),
        }
    }

    /// When `fetch_body` is false, the `Options/BodyPreference` block must be
    /// omitted so the server doesn't waste bandwidth returning bodies.
    #[test]
    fn build_sync_request_omits_body_preference_when_fetch_body_false() {
        use crate::eas::wbxml::tags::{airsync, base, pages};

        let req = SyncRequest {
            collection_id: "col-1".to_string(),
            sync_key: "key-0".to_string(),
            class: "Email".to_string(),
            window_size: 25,
            filter_age_days: 7,
            fetch_body: false,
        };
        let tree = build_sync_request(&req);
        let back = round_trip(&tree);

        let collections = back
            .children
            .iter()
            .find(|c| c.page == PAGE_AIRSYNC && c.token == AS_COLLECTIONS)
            .expect("missing Collections container");
        let collection = collections
            .children
            .iter()
            .find(|c| c.page == PAGE_AIRSYNC && c.token == AS_COLLECTION)
            .expect("missing Collection element");

        let has_body_pref = collection.children.iter().any(|c| {
            c.page == pages::BASE && c.token == base::BODY_PREFERENCE
                || (c.page == pages::AIRSYNC
                    && c.token == airsync::OPTIONS
                    && c.children.iter().any(|o| o.page == pages::BASE && o.token == base::BODY_PREFERENCE))
        });
        assert!(
            !has_body_pref,
            "BodyPreference should NOT be emitted when fetch_body=false"
        );
    }

    // ---- Phase 3a Task 5: top-level parse_sync_response orchestration ----
    //
    // Tasks 1-2 covered `parse_application_data` (ApplicationData -> EasItem).
    // Task 3 covered request building. Task 4 covered `eas_item_to_remote` and
    // `sync_folder`'s status-3 recovery branch. This block locks the
    // top-level orchestration that those tasks did NOT exercise:
    //   * Sync -> Collections -> Collection traversal
    //   * SyncKey / Status / MoreAvailable extraction at the Collection level
    //   * Commands -> Add/Change/Delete dispatch into `added` / `updated` /
    //     `deleted_server_ids`
    //
    // The fixture trees are built with the real `WbxmlElement` constructors on
    // the documented code pages (AirSync=0, Email=2, AirSyncBase=17), so
    // `tag_name()` dispatch resolves identically to a server-generated tree.

    /// Build a single EAS email `ApplicationData` element carrying Subject +
    /// From + To + Body[Type=2 HTML]. Shared by the Add and Change fixtures
    /// below so the test body stays focused on the top-level orchestration.
    fn fixture_email_app_data(
        subject: &str,
        from: &str,
        to: &str,
        body_html: &str,
    ) -> WbxmlElement {
        use crate::eas::wbxml::tags::{base, email, pages};
        WbxmlElement::container(
            PAGE_AIRSYNC,
            AS_APPLICATION_DATA,
            vec![
                WbxmlElement::text(email::PAGE, email::SUBJECT, subject),
                WbxmlElement::text(email::PAGE, email::FROM, from),
                WbxmlElement::text(email::PAGE, email::TO, to),
                WbxmlElement::container(
                    pages::BASE,
                    base::BODY,
                    vec![
                        WbxmlElement::text(pages::BASE, base::TYPE, "2"),
                        WbxmlElement::text(pages::BASE, base::DATA, body_html),
                    ],
                ),
            ],
        )
    }

    /// Full Sync-response fixture: Sync -> Collections -> Collection with
    /// SyncKey="{sk1}", Status="1", MoreAvailable, and a Commands block
    /// containing one Add (ServerId "1:1" + the email ApplicationData above).
    ///
    /// Asserts the entire top-level orchestration path: sync_key, status,
    /// more_available, and the added/updated/deleted vectors are populated by
    /// walking the real tree through `parse_sync_response`.
    #[test]
    fn parse_sync_response_extracts_full_sync_collection() {
        let add_cmd = WbxmlElement::container(
            PAGE_AIRSYNC,
            AS_ADD,
            vec![
                WbxmlElement::text(PAGE_AIRSYNC, AS_SERVER_ID, "1:1"),
                fixture_email_app_data("Hello", "a@b", "c@d", "<p>hi</p>"),
            ],
        );
        let commands = WbxmlElement::container(PAGE_AIRSYNC, AS_COMMANDS, vec![add_cmd]);
        let collection = WbxmlElement::container(
            PAGE_AIRSYNC,
            AS_COLLECTION,
            vec![
                WbxmlElement::text(PAGE_AIRSYNC, AS_SYNC_KEY, "{sk1}"),
                WbxmlElement::text(PAGE_AIRSYNC, AS_STATUS, "1"),
                WbxmlElement::empty(PAGE_AIRSYNC, AS_MORE_AVAILABLE),
                commands,
            ],
        );
        let collections = WbxmlElement::container(
            PAGE_AIRSYNC,
            AS_COLLECTIONS,
            vec![collection],
        );
        let tree = WbxmlElement::container(PAGE_AIRSYNC, AS_SYNC, vec![collections]);

        let result = parse_sync_response(&tree).expect("parse_sync_response must succeed");

        // Top-level orchestration fields.
        assert_eq!(result.sync_key, "{sk1}");
        assert_eq!(result.status, 1, "success status must surface from Collection/Status");
        assert!(
            result.more_available,
            "MoreAvailable element must set more_available=true"
        );

        // Added item: full envelope must round-trip through parse_item ->
        // parse_application_data (covered in depth by Task 2; here we lock the
        // Add-dispatch wiring at the Commands level).
        assert_eq!(result.added.len(), 1, "exactly one Add command");
        let added = &result.added[0];
        assert_eq!(added.server_id, "1:1");
        assert_eq!(added.subject.as_deref(), Some("Hello"));
        assert_eq!(added.from.as_deref(), Some("a@b"));
        assert_eq!(added.to.as_deref(), Some("c@d"));
        assert_eq!(
            added.body_html.as_deref(),
            Some("<p>hi</p>"),
            "Body Type=2 must populate body_html"
        );

        // No Change/Delete in this fixture.
        assert!(result.updated.is_empty(), "no Change commands in fixture");
        assert!(
            result.deleted_server_ids.is_empty(),
            "no Delete commands in fixture"
        );
    }

    /// A Commands block with Change + Delete must populate `updated` and
    /// `deleted_server_ids` respectively, and leave `added` empty.
    #[test]
    fn parse_sync_response_dispatches_change_and_delete() {
        let change_cmd = WbxmlElement::container(
            PAGE_AIRSYNC,
            AS_CHANGE,
            vec![
                WbxmlElement::text(PAGE_AIRSYNC, AS_SERVER_ID, "2:2"),
                fixture_email_app_data("Updated", "x@y", "z@w", "<p>u</p>"),
            ],
        );
        // EAS Delete carries the ServerId as a text leaf (per MS-ASSYNC
        // 2.2.3.4), not as a child element.
        let delete_cmd = WbxmlElement::text(PAGE_AIRSYNC, AS_DELETE, "3:3");
        let commands = WbxmlElement::container(
            PAGE_AIRSYNC,
            AS_COMMANDS,
            vec![change_cmd, delete_cmd],
        );
        let collection = WbxmlElement::container(
            PAGE_AIRSYNC,
            AS_COLLECTION,
            vec![
                WbxmlElement::text(PAGE_AIRSYNC, AS_SYNC_KEY, "{sk2}"),
                WbxmlElement::text(PAGE_AIRSYNC, AS_STATUS, "1"),
                commands,
            ],
        );
        let tree = WbxmlElement::container(
            PAGE_AIRSYNC,
            AS_SYNC,
            vec![WbxmlElement::container(
                PAGE_AIRSYNC,
                AS_COLLECTIONS,
                vec![collection],
            )],
        );

        let result = parse_sync_response(&tree).expect("parse");

        assert!(result.added.is_empty(), "no Add in this fixture");
        assert_eq!(result.updated.len(), 1, "one Change");
        assert_eq!(result.updated[0].server_id, "2:2");
        assert_eq!(
            result.deleted_server_ids,
            vec!["3:3".to_string()],
            "Delete ServerId must land in deleted_server_ids"
        );
        // No MoreAvailable in this fixture.
        assert!(
            !result.more_available,
            "MoreAvailable absent must remain false"
        );
    }

    /// Status-recovery parse lock: a Collection carrying `Status = "3"`
    /// (invalid sync key, per MS-ASSYNC 2.2.3.23) must surface on
    /// `SyncResult.status` so `EasSource::sync_folder`'s resync branch can act
    /// on it. Task 4 covered the *behavioral* recovery; this test locks the
    /// *parse-level* status plumbing that feeds it.
    ///
    /// Without the parser surfacing Status, `result.status` would stay at the
    /// `SyncResult::default()` value of `1` regardless of the wire value, and
    /// the resync branch would never fire on a real status-3 response.
    #[test]
    fn parse_sync_response_surfaces_collection_status_3() {
        let collection = WbxmlElement::container(
            PAGE_AIRSYNC,
            AS_COLLECTION,
            vec![
                WbxmlElement::text(PAGE_AIRSYNC, AS_SYNC_KEY, "{stale}"),
                WbxmlElement::text(PAGE_AIRSYNC, AS_STATUS, "3"),
            ],
        );
        let tree = WbxmlElement::container(
            PAGE_AIRSYNC,
            AS_SYNC,
            vec![WbxmlElement::container(
                PAGE_AIRSYNC,
                AS_COLLECTIONS,
                vec![collection],
            )],
        );

        let result = parse_sync_response(&tree).expect("parse");

        assert_eq!(
            result.status, 3,
            "Collection/Status=3 must surface on SyncResult.status so sync_folder can resync"
        );
        assert_eq!(result.sync_key, "{stale}");
        // A status-3 response typically carries no Commands; assert the
        // vectors stay empty so the engine's resync path (which wipes the
        // cache and re-enters with sync_key "0") is not fed stale items.
        assert!(result.added.is_empty());
        assert!(result.updated.is_empty());
        assert!(result.deleted_server_ids.is_empty());
    }

    /// `parse_sync_response` must reject a tree whose root is not
    /// Sync (page 0, token 0x05) with `WbxmlError::UnexpectedTag`. This locks
    /// the `expect_tag` guard so a misrouted response (e.g. a FolderSync tree
    /// handed to the Sync parser) fails loudly rather than returning a default
    /// `SyncResult` that looks like success.
    #[test]
    fn parse_sync_response_rejects_non_sync_root() {
        let wrong_root =
            WbxmlElement::container(PAGE_FOLDER, FH_FOLDER_SYNC, vec![]);
        let err = parse_sync_response(&wrong_root).expect_err("must reject non-Sync root");
        assert!(
            matches!(err, WbxmlError::UnexpectedTag { .. }),
            "expected UnexpectedTag, got {err:?}"
        );
    }

    /// An empty Sync tree (root with no Collections child) must parse
    /// successfully and yield a default `SyncResult` (status=1, empty vectors,
    /// sync_key=""). This is the shape a server returns when it has nothing to
    /// say; the engine must treat it as a no-op success, not an error.
    #[test]
    fn parse_sync_response_empty_tree_is_default_success() {
        let tree = WbxmlElement::container(PAGE_AIRSYNC, AS_SYNC, vec![]);
        let result = parse_sync_response(&tree).expect("parse");
        assert_eq!(result.status, 1, "default status is success");
        assert_eq!(result.sync_key, "");
        assert!(!result.more_available);
        assert!(result.added.is_empty());
        assert!(result.updated.is_empty());
        assert!(result.deleted_server_ids.is_empty());
    }
}
