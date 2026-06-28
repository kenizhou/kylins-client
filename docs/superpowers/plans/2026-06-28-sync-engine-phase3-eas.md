# Kylins Mail Sync Engine — Phase 3a: EAS WBXML Sync Parser

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `eas::client::sync()` return real parsed email data (not `SyncResult::default()`), and wire `EasSource.sync_folder` to deliver actual EAS messages through the existing engine — unblocking EAS as a functional mail provider.

**Architecture:** The WBXML Sync-response parser skeleton already exists in `eas/commands.rs` (parse_sync_response, parse_collection, parse_item, parse_application_data) but `parse_application_data` only extracts Subject/DateReceived/Read. This plan extends it to parse the full email ApplicationData (Body, From, To, Cc, Flag, Attachments), wires `client.sync()` to actually call it (3-line fix), extends `build_sync_request` to emit `BodyPreference` (without which bodies never arrive), and fills `EasSource.sync_folder` with a MoreAvailable loop that maps EAS items to `RemoteMessage` and returns a `FolderDelta` with the EAS cursor (sync_key). The engine's cursor-advance path (currently IMAP-only at `engine.rs:445`) gets the EAS branch.

**Tech Stack:** Rust (the existing WBXML codec `eas/wbxml/`, `eas::client`, `eas::commands`), `MailSource` trait + `EasSource`, `db::sync_state` (EAS cursors already built), `db::messages::apply_folder_delta` (engine applies the delta).

## Global Constraints

- **Do NOT touch the WBXML codec** (`eas/wbxml/`) — it's correct and stable. Use its public API (`WbxmlElement::tag_name()`, `.children`, `.value`, constructors) from the command-parser layer.
- **Tag dispatch via `tag_name()`:** match on `child.tag_name()` strings (e.g. `"Subject"`, `"From"`, `"Body"`) rather than raw token IDs — the code-page tables in `code_pages.rs` are authoritative and this is self-documenting.
- **EAS email field tags (from research, cross-validated):**
  - Page 2 (Email): `Subject` 0x14, `Read` 0x15, `To` 0x16, `Cc` 0x17, `From` 0x18, `DateReceived` 0x0F, `Flag` 0x3A, `ReplyTo` 0x19, `Importance` 0x12.
  - Page 17 (AirSyncBase): `Body` 0x0A → children `Type` 0x06, `Data` 0x0B, `Truncated` 0x0D, `Preview` 0x18; `Attachments` 0x0E → `Attachment` 0x0F → `DisplayName` 0x10, `FileReference` 0x11, `Method` 0x12, `ContentId` 0x13, `IsInline` 0x15, `ContentType` 0x17, `EstimatedDataSize` 0x0C.
  - Page 22 (Email2): `ConversationId` 0x09, `IsDraft` 0x15, `Bcc` 0x16.
- **EAS Sync status codes (recovery mapping):** `1` = success; `3` = invalid sync key → reset to `"0"` + re-sync; `12` = folder hierarchy changed → re-run FolderSync; `4/5/8` = abort (server error); `6` = continue (ignore); `7/9` = re-run FolderSync; `16` = retry. See `eas-sync-research.md §2.3`.
- **`MoreAvailable` loop:** repeat the Sync call with the SAME sync_key until `MoreAvailable` is absent from the response (the server windows the results). Accumulate all items.
- **ServerId → `RemoteMessage.uid`:** for Phase 3a MVP, use a stable hash of the EAS ServerId string → `u32` (FNV or `String::bytes().fold(0, |a,b| a.wrapping_mul(31).wrapping_add(b as u32))`). This avoids a new mapping table; collisions are rare and acceptable for MVP (the write-lock uses message_id, not uid). A proper `eas_server_id_map` table is a documented follow-up.
- **Address parsing:** EAS `From`/`To`/`Cc` arrive as RFC-5322 strings (`"Name" <addr@x>`). For MVP, pass through verbatim (the existing `parseAddresses` on the frontend handles splitting). Real structured parsing is a follow-up.
- **`build_sync_request` must emit `<Options><BodyPreference><Type>2</Type></BodyPreference></Options>`** (Type 2 = HTML) inside each `<Collection>`, or the server will not return bodies. This is the critical plumbing gap identified in the research.
- **No new dependencies.** All parsing is over the existing WBXML tree types.
- **Commit cadence:** one commit per task. `cargo test --lib` at each boundary.

---

## File Structure

**Backend (Rust):**
- `src/eas/commands.rs` — extend `parse_application_data` (Body/Attachments/From/To/Cc/Flag); add `tags::email`/`tags::email2` constants; extend `build_sync_request` (BodyPreference).
- `src/eas/client.rs` — 3-line `sync()` fix (call `parse_sync_response`); add `const AS_SYNC: u8 = 0x05`.
- `src/eas/types.rs` — `EasItem` gains typed fields (from `HashMap<String,String>` → struct with `subject`, `from`, `to`, `cc`, `date_received`, `read`, `body_html`, `body_text`, `has_attachments`, `server_id`, `message_id`); `EasAttachment` gains `content_type`/`estimated_data_size`; `SyncResult` gains `status: u32`.
- `src/sync_engine/eas_source.rs` — fill `sync_folder` (MoreAvailable loop, EasItem→RemoteMessage, Cursor::Eas, status recovery).
- `src/sync_engine/engine.rs` — add EAS cursor advance branch in `run_sync_round_with_source` (currently IMAP-only at ~line 445).

---

## Task 1: EAS status enums + tag modules + type upgrades

**Files:** `src/eas/types.rs`, `src/eas/commands.rs` (tag constants)

**Interfaces:**
- Produces: `SyncResult { sync_key, added, updated, deleted_server_ids, more_available, status: u32 }`, `EasItem` with typed fields, `EasAttachment` with content_type/estimated_data_size, `tags::email::*` + `tags::email2::*` constants.

- [ ] **Step 1: Failing test** — `SyncResult` has a `status` field (default 1); `EasItem` has `subject: Option<String>` etc. (not a HashMap).

- [ ] **Step 2: Run — expect FAIL.**

- [ ] **Step 3: Implement.** Upgrade `EasItem` from `HashMap<String,String>` to a typed struct:
```rust
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct EasItem {
    pub server_id: String,
    pub subject: Option<String>,
    pub from: Option<String>,
    pub to: Option<String>,
    pub cc: Option<String>,
    pub bcc: Option<String>,
    pub reply_to: Option<String>,
    pub date_received: Option<String>,
    pub read: Option<bool>,
    pub flag: Option<bool>,
    pub importance: Option<u8>,
    pub body_html: Option<String>,
    pub body_text: Option<String>,
    pub body_truncated: Option<bool>,
    pub preview: Option<String>,
    pub has_attachments: bool,
    pub attachments: Vec<EasAttachment>,
    pub conversation_id: Option<Vec<u8>>,
    pub is_draft: Option<bool>,
    pub message_id: Option<String>,
}
```
Upgrade `EasAttachment`: add `content_type: Option<String>`, `estimated_data_size: Option<u32>`, `content_location: Option<String>`.
Upgrade `SyncResult`: add `pub status: u32` (default 1). Add `pub more_available: bool` if not present.

Add `tags::email` constants in `commands.rs` (page 2):
```rust
mod email_tags {
    pub const PAGE: u8 = 2;
    pub const DATE_RECEIVED: u8 = 0x0F;
    pub const SUBJECT: u8 = 0x14;
    pub const READ: u8 = 0x15;
    pub const TO: u8 = 0x16;
    pub const CC: u8 = 0x17;
    pub const FROM: u8 = 0x18;
    pub const REPLY_TO: u8 = 0x19;
    pub const IMPORTANCE: u8 = 0x12;
    pub const FLAG: u8 = 0x3A;
}
mod email2_tags {
    pub const PAGE: u8 = 22;
    pub const CONVERSATION_ID: u8 = 0x09;
    pub const IS_DRAFT: u8 = 0x15;
    pub const BCC: u8 = 0x16;
}
```
(AirSyncBase page 17 constants already exist as `tags::base::*` — reuse.)

- [ ] **Step 4: Run — expect PASS.** `cargo build` clean.
- [ ] **Step 5: Commit** — `feat(eas): typed EasItem/EasAttachment + email tag constants + SyncResult.status`.

---

## Task 2: Extend `parse_application_data` (Body + From/To/Cc + Flag + Attachments)

**Files:** `src/eas/commands.rs`

**Interfaces:**
- Consumes: `tags::email::*`, `tags::base::*` (AirSyncBase Body/Attachments), `EasItem` typed fields.
- Produces: `parse_application_data(server_id, &app_data_element) -> EasItem` with all fields populated.

- [ ] **Step 1: Failing test** — build a `WbxmlElement` tree mimicking an EAS email ApplicationData (Subject + From + To + Read + Body with Type=2 + Data) and assert `parse_application_data` returns an `EasItem` with `subject`, `from`, `to`, `read`, `body_html` all populated.

- [ ] **Step 2: Run — expect FAIL.**

- [ ] **Step 3: Implement.** Rewrite `parse_application_data` (currently at ~`commands.rs:380-405`) to walk children via `child.tag_name()` dispatch:
```rust
fn parse_application_data(server_id: &str, elem: &WbxmlElement) -> Result<EasItem, WbxmlError> {
    let mut item = EasItem { server_id: server_id.to_string(), ..Default::default() };
    for child in &elem.children {
        match child.tag_name() {
            "Subject" => item.subject = text_value(child),
            "From" => item.from = text_value(child),
            "To" => item.to = text_value(child),
            "Cc" => item.cc = text_value(child),
            "Bcc" => item.bcc = text_value(child),
            "ReplyTo" => item.reply_to = text_value(child),
            "DateReceived" => item.date_received = text_value(child),
            "Read" => item.read = text_value(child).map(|s| s == "1"),
            "Flag" => item.flag = Some(child.children.iter().any(|c| c.tag_name() == "Status" && text_value(c).as_deref() == Some("2"))),
            "Importance" => item.importance = text_value(child).and_then(|s| s.parse().ok()),
            "Body" => { parse_body(child, &mut item)?; }
            "Attachments" => { parse_attachments(child, &mut item)?; }
            "ConversationId" => item.conversation_id = Some(opaque_value(child).unwrap_or_default()),
            "IsDraft" => item.is_draft = text_value(child).map(|s| s == "1"),
            "InternetCPID" | "ContentClass" | "ThreadTopic" | "MessageClass" | "Status" => {} // ignore for MVP
            _ => {} // unknown tags: ignore
        }
    }
    Ok(item)
}

fn parse_body(elem: &WbxmlElement, item: &mut EasItem) -> Result<(), WbxmlError> {
    let mut body_type: Option<u8> = None;
    let mut data: Option<String> = None;
    let mut truncated = false;
    let mut preview: Option<String> = None;
    for child in &elem.children {
        match child.tag_name() {
            "Type" => body_type = text_value(child).and_then(|s| s.parse().ok()),
            "Data" => data = text_value(child),
            "Truncated" => truncated = text_value(child).as_deref() == Some("1"),
            "Preview" => preview = text_value(child),
            "EstimatedDataSize" => {} // ignore
            _ => {}
        }
    }
    match body_type {
        Some(2) => item.body_html = data,   // Type 2 = HTML
        Some(1) => item.body_text = data,   // Type 1 = PlainText
        _ => { item.body_html = data.clone(); item.body_text = data; } // fallback
    }
    item.body_truncated = if truncated { Some(true) } else { None };
    item.preview = preview;
    Ok(())
}

fn parse_attachments(elem: &WbxmlElement, item: &mut EasItem) -> Result<(), WbxmlError> {
    for child in &elem.children {
        if child.tag_name() != "Attachment" { continue; }
        let mut att = EasAttachment::default();
        for field in &child.children {
            match field.tag_name() {
                "DisplayName" => att.filename = text_value(field).unwrap_or_default(),
                "FileReference" => att.file_reference = text_value(field).unwrap_or_default(),
                "Method" => att.method = text_value(field).and_then(|s| s.parse().ok()).unwrap_or(1),
                "ContentId" => att.content_id = text_value(field),
                "IsInline" => att.is_inline = text_value(field).as_deref() == Some("1"),
                "ContentType" => att.content_type = text_value(field),
                "EstimatedDataSize" => att.estimated_data_size = text_value(field).and_then(|s| s.parse().ok()),
                "ContentLocation" => att.content_location = text_value(field),
                _ => {}
            }
        }
        item.attachments.push(att);
    }
    item.has_attachments = !item.attachments.is_empty();
    Ok(())
}
```
Add helpers:
```rust
fn text_value(elem: &WbxmlElement) -> Option<String> {
    match &elem.value { WbxmlValue::Text(s) => Some(s.clone()), _ => None }
}
fn opaque_value(elem: &WbxmlElement) -> Option<Vec<u8>> {
    match &elem.value { WbxmlValue::Opaque(b) => Some(b.clone()), _ => None }
}
```

- [ ] **Step 4: Run — expect PASS** (the fixture test).
- [ ] **Step 5: Commit** — `feat(eas): parse_application_data — Body/From/To/Cc/Flag/Attachments`.

---

## Task 3: Wire `client.sync()` + extend `build_sync_request` (BodyPreference)

**Files:** `src/eas/client.rs`, `src/eas/commands.rs`

**Interfaces:**
- Consumes: `parse_sync_response` (commands.rs), `expect_root` pattern, `build_sync_request`.
- Produces: `EasClient::sync()` returns a real parsed `SyncResult`; `build_sync_request` emits `<Options><BodyPreference><Type>2</Type></BodyPreference></Options>`.

- [ ] **Step 1: Failing test** — build a Sync request, verify the serialized WBXML contains a `<BodyPreference><Type>2</Type></BodyPreference>` element inside `<Options>` inside `<Collection>`. (Parse the serialized bytes back via `deserialize_to_tree` and walk the tree.)

- [ ] **Step 2: Run — expect FAIL** (no BodyPreference emitted).

- [ ] **Step 3: Implement.**

In `build_sync_request` (`commands.rs:259-301`), add `<Options>` with `<BodyPreference>` inside each `<Collection>`:
```rust
// Inside the Collection element builder, AFTER <WindowSize>, add:
let options = WbxmlElement::container(
    tags::airsync::PAGE, 0x17, // Options
    vec![
        WbxmlElement::container(
            tags::base::PAGE, 0x05, // BodyPreference (AirSyncBase page 17)
            vec![
                WbxmlElement::text(tags::base::PAGE, tags::base::TYPE, "2"), // Type 2 = HTML
            ],
        ),
    ],
);
// Add `options` to the Collection's children vec.
```

In `client.rs::sync()` (~line 191), the 3-line fix:
```rust
pub async fn sync(&self, req: &SyncRequest) -> Result<SyncResult, EasError> {
    let tree = commands::build_sync_request(req);
    let resp = self.send_command("Sync", &tree).await?;
    // expect_root(resp, PAGE_AIRSYNC, AS_SYNC) — check the root is Sync.
    // If not, it's a server error page. Tolerate by attempting parse anyway.
    Ok(commands::parse_sync_response(&resp)?)
}
```
Add `const AS_SYNC: u8 = 0x05;` near the other constants in client.rs.

- [ ] **Step 4: Run — expect PASS** (BodyPreference in serialized output).
- [ ] **Step 5: Commit** — `feat(eas): wire client.sync() + BodyPreference in request`.

---

## Task 4: `EasSource.sync_folder` + engine EAS cursor advance

**Files:** `src/sync_engine/eas_source.rs`, `src/sync_engine/engine.rs`

**Interfaces:**
- Consumes: `eas::client::EasClient::sync`, `SyncResult`, `EasItem`, `Cursor::Eas`, `db::sync_state`.
- Produces: `EasSource.sync_folder` returns a `FolderDelta` with added RemoteMessages + next_cursor; the engine advances the EAS cursor.

- [ ] **Step 1: Failing test** — a MockSource-style test is hard for EAS (needs WBXML). Instead, write a UNIT test on `eas_item_to_remote` (the mapping function):
```rust
#[test]
fn eas_item_to_remote_maps_fields() {
    let item = EasItem {
        server_id: "1:123".into(),
        subject: Some("Hello".into()),
        from: Some("a@b.com".into()),
        to: Some("c@d.com".into()),
        read: Some(true),
        body_html: Some("<p>Hi</p>".into()),
        date_received: Some("2025-01-01T00:00:00.000Z".into()),
        ..Default::default()
    };
    let m = eas_item_to_remote(&item, "INBOX");
    assert_eq!(m.subject.as_deref(), Some("Hello"));
    assert_eq!(m.from_address.as_deref(), Some("a@b.com"));
    assert!(m.is_read);
    assert_eq!(m.body_html.as_deref(), Some("<p>Hi</p>"));
    assert_eq!(m.folder, "INBOX");
}
```

- [ ] **Step 2: Run — expect FAIL.**

- [ ] **Step 3: Implement.** In `eas_source.rs`:

```rust
fn eas_item_to_remote(item: &EasItem, folder: &str) -> RemoteMessage {
    // ServerId → u32 uid (FNV hash for MVP; a proper map table is a follow-up).
    let uid = item.server_id.bytes().fold(0u32, |a, b| a.wrapping_mul(31).wrapping_add(b as u32));
    RemoteMessage {
        uid,
        folder: folder.to_string(),
        message_id: None, // EAS doesn't expose RFC-Id in ApplicationData by default
        from_address: item.from.clone(),
        from_name: None, // MVP: pass the From string verbatim; structured parse is follow-up
        to_addresses: item.to.clone(),
        cc_addresses: item.cc.clone(),
        bcc_addresses: item.bcc.clone(),
        reply_to: item.reply_to.clone(),
        subject: item.subject.clone(),
        snippet: item.preview.clone(),
        date: parse_eas_date(item.date_received.as_deref()).unwrap_or(0),
        is_read: item.read.unwrap_or(false),
        is_starred: item.flag.unwrap_or(false),
        is_draft: item.is_draft.unwrap_or(false),
        body_html: item.body_html.clone(),
        body_text: item.body_text.clone(),
        raw_size: 0,
        has_attachments: item.has_attachments,
        ..Default::default()
    }
}

fn parse_eas_date(s: Option<&str>) -> Option<i64> {
    // EAS DateReceived: ISO-8601 like "2025-01-01T00:00:00.000Z".
    // Parse to unix-epoch seconds. Use a simple approach for MVP (chrono is a dev-dep only; use manual or skip).
    // For MVP: return None (the engine stores date=0; a follow-up adds proper parsing).
    // OR: use `time` / manual split. Document as a known MVP limitation.
    None // MVP: date parsing deferred; engine stores 0 which sorts as "oldest"
}
```

Fill `sync_folder`:
```rust
async fn sync_folder(&self, folder: &RemoteFolder, since: Cursor) -> Result<FolderDelta, SourceError> {
    let (collection_id, sync_key) = match &since {
        Cursor::Eas { collection_id, sync_key } => (collection_id.clone(), sync_key.clone()),
        _ => (folder.remote_id.clone(), "0".to_string()),
    };
    let client = EasClient::new(self.eas_config());
    let req = SyncRequest {
        collection_id: collection_id.clone(),
        sync_key: sync_key.clone(),
        class: "Email".into(),
        window_size: 50,
        filter_age_days: 0,
        fetch_body: true,
    };
    let result = client.sync(&req).await.map_err(|e| SourceError::Other(e.to_string()))?;
    // Status recovery: if status == 3 (invalid sync key), reset to "0" and signal resync.
    if result.status == 3 {
        return Ok(FolderDelta {
            added: vec![], updated: vec![], vanished_uids: vec![],
            next_cursor: Cursor::Eas { collection_id, sync_key: "0".into() },
            uidvalidity_changed: true, // engine wipes + resyncs
        });
    }
    if result.status != 1 && result.status != 6 {
        return Err(SourceError::Other(format!("EAS sync status {}", result.status)));
    }
    let added: Vec<RemoteMessage> = result.added.iter().map(|i| eas_item_to_remote(i, &folder.remote_id)).collect();
    let updated: Vec<RemoteMessage> = result.updated.iter().map(|i| eas_item_to_remote(i, &folder.remote_id)).collect();
    // MoreAvailable: for MVP, single round (the engine polls; full loop is a follow-up).
    // The next sync_key is always the one from the response.
    Ok(FolderDelta {
        added, updated,
        vanished_uids: vec![], // EAS deletes-as-moves: handled via deleted_server_ids (TODO: map to uids)
        next_cursor: Cursor::Eas { collection_id, sync_key: result.sync_key },
        uidvalidity_changed: false,
    })
}
```

In `engine.rs`, add the EAS cursor-advance branch (currently only `Cursor::Imap` at ~line 445):
```rust
// After the Imap cursor advance block:
if let Cursor::Eas { collection_id, sync_key } = &delta.next_cursor {
    let _ = sync_state::advance_eas_cursor(
        &engine.pool, account_id, &f.remote_id, collection_id, sync_key,
    ).await;
}
```

- [ ] **Step 4: Run — expect PASS** (eas_item_to_remote test) + full `cargo test --lib` no regressions.
- [ ] **Step 5: Commit** — `feat(sync): EasSource.sync_folder delivers EAS messages + engine EAS cursor`.

---

## Task 5: Tests + regression

**Files:** tests in `eas/commands.rs` + `eas_source.rs` + `engine.rs`

- [ ] **Step 1: WBXML fixture test** — build a complete Sync-response WBXML tree (SyncKey + MoreAvailable + Status=1 + Commands/Add with ApplicationData containing Subject+From+To+Body) and assert `parse_sync_response` extracts all fields + the sync_key + status.
- [ ] **Step 2: Status-recovery test** — a Sync-response with Status=3 (invalid sync key) → assert `EasSource.sync_folder` returns `uidvalidity_changed=true` + sync_key="0".
- [ ] **Step 3: Full regression** — `cargo test --lib` (expect all green) + `cd ../kylins.client.frontend && npx tsc --noEmit && npx vitest run` (expect green — frontend unchanged).
- [ ] **Step 4: Commit** any fixes + update ledger.
- [ ] **Step 5: Note manual e2e** — requires a real EAS (Exchange) server. Document the manual steps for when one is available (add EAS account → folder pane → Inbox syncs messages → mark-read round-trips).

---

## Self-review notes

- **Spec coverage:** the kimi spec's Phase 1 (functional mail sync) maps: status enums = Task 1; parse_sync_response + ApplicationData = Tasks 1-2; client.sync wire + BodyPreference = Task 3; sync_folder + cursor = Task 4; tests = Task 5. The frontend pieces (kimi 1.7-1.9) are N/A (our architecture is Rust-engine). Cursor persistence (kimi 1.5) is ALREADY DONE (db::sync_state). ✅
- **Known MVP limitations (documented, not blocking):**
  - Date parsing (DateReceived ISO → epoch): deferred to a follow-up (engine stores 0 → sorts oldest).
  - MoreAvailable loop: single round for MVP (the engine polls every 60s; full in-one-round loop is a follow-up).
  - ServerId → uid: FNV hash (collision risk acceptable for MVP; proper map table is follow-up).
  - Address parsing: verbatim pass-through (frontend parseAddresses handles splitting).
  - DeletesAsMoves: EAS `deleted_server_ids` not yet mapped to vanished_uids (follow-up).
- **Type consistency:** `EasItem` typed fields used in Task 2 (parse) + Task 4 (eas_item_to_remote). `Cursor::Eas` used in Task 4 (sync_folder + engine advance). `SyncResult.status` used in Task 4 (status recovery).

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-06-28-sync-engine-phase3-eas.md`. Two execution options:

1. **Subagent-Driven (recommended)** — fresh subagent per task, review between tasks.
2. **Inline Execution** — this session via executing-plans, batched with checkpoints.

Which approach?
