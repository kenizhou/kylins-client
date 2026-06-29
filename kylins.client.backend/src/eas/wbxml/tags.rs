// Ported from mailkit_arkts (https://github.com/nicehash/mailkit_arkts)
// License pending confirmation. See ATTRIBUTIONS.md.
//
// Tag constants and helper functions. Each constant packs a `(page, token)`
// pair into a `u16` — page in the high 8 bits, token in the low 8 bits —
// because that is what the ArkTS `Tags` class produces via `page << 6 | tag`.
// Callers can use these constants or pass `(page, token)` tuples directly to
// the serializer; either form is accepted via the `Into<Tag>` impl.
//
// Only the most commonly-used tags are enumerated here. The full table lives
// in `code_pages.rs`; for ad-hoc tags, construct `WbxmlElement::empty(page, token)`
// directly.

/// Code page indices (0..=25). Source: `Tags` constants in `tags.ts`.
pub mod pages {
    pub const AIRSYNC: u8 = 0x00;
    pub const CONTACTS: u8 = 0x01;
    pub const EMAIL: u8 = 0x02;
    pub const CALENDAR: u8 = 0x04;
    pub const MOVE: u8 = 0x05;
    pub const GIE: u8 = 0x06;
    pub const FOLDER: u8 = 0x07;
    pub const MREQ: u8 = 0x08;
    pub const TASK: u8 = 0x09;
    pub const RECIPIENTS: u8 = 0x0A;
    pub const VALIDATE: u8 = 0x0B;
    pub const CONTACTS2: u8 = 0x0C;
    pub const PING: u8 = 0x0D;
    pub const PROVISION: u8 = 0x0E;
    pub const SEARCH: u8 = 0x0F;
    pub const GAL: u8 = 0x10;
    pub const BASE: u8 = 0x11;
    pub const SETTINGS: u8 = 0x12;
    pub const DOCS: u8 = 0x13;
    pub const ITEMS: u8 = 0x14;
    pub const COMPOSE: u8 = 0x15;
    pub const EMAIL2: u8 = 0x16;
    pub const NOTES: u8 = 0x17;
    pub const RIGHTS: u8 = 0x18;
    pub const FIND: u8 = 0x19;
}

/// A few of the most-used AirSync (page 0) tag ids. Other pages are available
/// via the `pages` module and the `code_pages::code_page()` lookup.
pub mod airsync {
    pub const SYNC: u8 = 0x05;
    pub const RESPONSES: u8 = 0x06;
    pub const ADD: u8 = 0x07;
    pub const CHANGE: u8 = 0x08;
    pub const DELETE: u8 = 0x09;
    pub const FETCH: u8 = 0x0A;
    pub const SYNC_KEY: u8 = 0x0B;
    pub const CLIENT_ID: u8 = 0x0C;
    pub const SERVER_ID: u8 = 0x0D;
    pub const STATUS: u8 = 0x0E;
    pub const COLLECTION: u8 = 0x0F;
    pub const COLLECTIONS: u8 = 0x1C;
    pub const CLASS: u8 = 0x10;
    pub const COLLECTION_ID: u8 = 0x12;
    pub const GET_CHANGES: u8 = 0x13;
    pub const MORE_AVAILABLE: u8 = 0x14;
    pub const WINDOW_SIZE: u8 = 0x15;
    pub const COMMANDS: u8 = 0x16;
    pub const OPTIONS: u8 = 0x17;
    pub const APPLICATION_DATA: u8 = 0x1D;
}

/// FolderHierarchy (page 7) tag ids.
pub mod folder {
    pub const FOLDERS: u8 = 0x05;
    pub const FOLDER: u8 = 0x06;
    pub const DISPLAY_NAME: u8 = 0x07;
    pub const SERVER_ID: u8 = 0x08;
    pub const PARENT_ID: u8 = 0x09;
    pub const TYPE: u8 = 0x0A;
    pub const STATUS: u8 = 0x0C;
    pub const CHANGES: u8 = 0x0E;
    pub const ADD: u8 = 0x0F;
    pub const DELETE: u8 = 0x10;
    pub const UPDATE: u8 = 0x11;
    pub const SYNC_KEY: u8 = 0x12;
    pub const FOLDER_CREATE: u8 = 0x13;
    pub const FOLDER_DELETE: u8 = 0x14;
    pub const FOLDER_UPDATE: u8 = 0x15;
    pub const FOLDER_SYNC: u8 = 0x16;
    pub const COUNT: u8 = 0x17;
}

/// Ping (page 13) tag ids.
pub mod ping {
    pub const PING: u8 = 0x05;
    pub const STATUS: u8 = 0x07;
    pub const HEARTBEAT_INTERVAL: u8 = 0x08;
    pub const FOLDERS: u8 = 0x09;
    pub const FOLDER: u8 = 0x0A;
    pub const ID: u8 = 0x0B;
    pub const CLASS: u8 = 0x0C;
    pub const MAX_FOLDERS: u8 = 0x0D;
}

/// Provision (page 14) tag ids.
pub mod provision {
    pub const PROVISION: u8 = 0x05;
    pub const POLICIES: u8 = 0x06;
    pub const POLICY: u8 = 0x07;
    pub const POLICY_TYPE: u8 = 0x08;
    pub const POLICY_KEY: u8 = 0x09;
    pub const DATA: u8 = 0x0A;
    pub const STATUS: u8 = 0x0B;
    pub const REMOTE_WIPE: u8 = 0x0C;
    pub const EAS_PROVISION_DOC: u8 = 0x0D;
}

/// Settings (page 18) tag ids.
pub mod settings {
    pub const SETTINGS: u8 = 0x05;
    pub const STATUS: u8 = 0x06;
    pub const GET: u8 = 0x07;
    pub const SET: u8 = 0x08;
    pub const OOF: u8 = 0x09;
    pub const DEVICE_INFORMATION: u8 = 0x16;
    pub const FRIENDLY_NAME: u8 = 0x19;
    pub const OS: u8 = 0x1A;
    pub const OS_LANGUAGE: u8 = 0x1B;
    pub const PHONE_NUMBER: u8 = 0x1C;
}

/// ItemOperations (page 20) tag ids.
pub mod item_operations {
    pub const ITEM_OPERATIONS: u8 = 0x05;
    pub const FETCH: u8 = 0x06;
    pub const STORE: u8 = 0x07;
    pub const OPTIONS: u8 = 0x08;
    pub const RANGE: u8 = 0x09;
    pub const TOTAL: u8 = 0x0A;
    pub const PROPERTIES: u8 = 0x0B;
    pub const DATA: u8 = 0x0C;
    pub const STATUS: u8 = 0x0D;
    pub const RESPONSE: u8 = 0x0E;
}

/// ComposeMail (page 21) tag ids.
pub mod compose {
    pub const SEND_MAIL: u8 = 0x05;
    pub const SMART_FORWARD: u8 = 0x06;
    pub const SMART_REPLY: u8 = 0x07;
    pub const SAVE_IN_SENT_ITEMS: u8 = 0x08;
    pub const REPLACE_MIME: u8 = 0x09;
    pub const SOURCE: u8 = 0x0B;
    pub const FOLDER_ID: u8 = 0x0C;
    pub const ITEM_ID: u8 = 0x0D;
    pub const LONG_ID: u8 = 0x0E;
    pub const INSTANCE_ID: u8 = 0x0F;
    pub const MIME: u8 = 0x10;
    pub const CLIENT_ID: u8 = 0x11;
    pub const STATUS: u8 = 0x12;
    pub const ACCOUNT_ID: u8 = 0x13;
}

/// AirSyncBase (page 17) tag ids.
pub mod base {
    pub const BODY_PREFERENCE: u8 = 0x05;
    pub const TYPE: u8 = 0x06;
    pub const TRUNCATION_SIZE: u8 = 0x07;
    pub const ALL_OR_NONE: u8 = 0x08;
    pub const BODY: u8 = 0x0A;
    pub const DATA: u8 = 0x0B;
    pub const ESTIMATED_DATA_SIZE: u8 = 0x0C;
    pub const TRUNCATED: u8 = 0x0D;
    pub const ATTACHMENTS: u8 = 0x0E;
    pub const ATTACHMENT: u8 = 0x0F;
    pub const DISPLAY_NAME: u8 = 0x10;
    pub const FILE_REFERENCE: u8 = 0x11;
    pub const METHOD: u8 = 0x12;
    pub const CONTENT_ID: u8 = 0x13;
    pub const CONTENT_LOCATION: u8 = 0x14;
    pub const IS_INLINE: u8 = 0x15;
    pub const NATIVE_BODY_TYPE: u8 = 0x16;
    pub const CONTENT_TYPE: u8 = 0x17;
    pub const PREVIEW: u8 = 0x18;
}

/// Email (page 2) tag ids. Source: [MS-ASEMAIL] 2.2.2.
/// Used by the Sync-response parser to extract well-known email fields
/// out of `ApplicationData`.
pub mod email {
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

/// Email2 (page 22) tag ids. Source: [MS-ASEMAIL] 2.2.3.
/// Conversations / drafts / BCC live here because they postdate the
/// original Email code page.
pub mod email2 {
    pub const PAGE: u8 = 22;
    pub const CONVERSATION_ID: u8 = 0x09;
    pub const IS_DRAFT: u8 = 0x15;
    pub const BCC: u8 = 0x16;
}
