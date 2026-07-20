// Ported from velo (https://github.com/avihaymenahem/velo)
// Licensed under Apache-2.0. See ATTRIBUTIONS.md.

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ImapConfig {
    pub host: String,
    pub port: u16,
    pub security: String, // "tls", "starttls", "none"
    pub username: String,
    pub password: String,    // plaintext password or OAuth2 access token
    pub auth_method: String, // "password" or "oauth2"
    #[serde(default)]
    pub accept_invalid_certs: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ImapFolder {
    pub path: String,
    pub raw_path: String,
    pub name: String,
    pub delimiter: String,
    pub special_use: Option<String>,
    pub exists: u32,
    pub unseen: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ImapMessage {
    pub uid: u32,
    pub folder: String,
    pub message_id: Option<String>,
    pub in_reply_to: Option<String>,
    pub references: Option<String>,
    pub from_address: Option<String>,
    pub from_name: Option<String>,
    pub to_addresses: Option<String>,
    pub cc_addresses: Option<String>,
    pub bcc_addresses: Option<String>,
    pub reply_to: Option<String>,
    pub subject: Option<String>,
    pub date: i64,
    pub is_read: bool,
    pub is_starred: bool,
    pub is_draft: bool,
    pub body_html: Option<String>,
    pub body_text: Option<String>,
    pub snippet: Option<String>,
    pub raw_size: u32,
    pub list_unsubscribe: Option<String>,
    pub list_unsubscribe_post: Option<String>,
    pub auth_results: Option<String>,
    pub attachments: Vec<ImapAttachment>,
    /// Lowercased full top-level Content-Type (e.g. `application/pkcs7-mime`,
    /// `multipart/signed`, `text/plain`). Populated by `parse_message` from
    /// `mail_parser::Message::content_type()` so the sync_engine IMAP adapter
    /// can derive `crypto_kind` without re-parsing the raw bytes. `None` when
    /// the parsed message had no Content-Type header (rare; malformed input).
    #[serde(default)]
    pub content_type: Option<String>,
    /// Lowercased `smime-type` parameter value (`enveloped-data`,
    /// `signed-data`, etc.) when the top-level Content-Type carried one.
    /// `None` when absent — including every non-S/MIME message.
    #[serde(default)]
    pub smime_type: Option<String>,
    /// Provider-stable message identifier parsed from the FETCH response:
    /// Yahoo OBJECTID `EMAILID` (RFC 8474, parenthesized string atom) or Gmail
    /// `X-GM-MSGID` (X-GM-EXT-1, bare number). `None` when the sync FETCH query
    /// did not request the attribute (server lacks the cap) or the parser could
    /// not extract it — the typed async-imap path cannot surface custom FETCH
    /// attributes, so this is populated only by the raw-TCP FETCH path.
    #[serde(default)]
    pub remote_email_id: Option<String>,
    /// Provider-stable thread identifier: Yahoo OBJECTID `THREADID` (RFC 8474)
    /// or Gmail `X-GM-THRID` (X-GM-EXT-1). Same population rules as
    /// `remote_email_id`.
    #[serde(default)]
    pub remote_thread_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct ImapAttachment {
    pub part_id: String,
    pub filename: String,
    pub mime_type: String,
    pub size: u32,
    pub content_id: Option<String>,
    pub is_inline: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ImapFolderStatus {
    pub uidvalidity: u32,
    pub uidnext: u32,
    pub exists: u32,
    pub unseen: u32,
    pub highest_modseq: Option<u64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ImapFetchResult {
    pub messages: Vec<ImapMessage>,
    pub folder_status: ImapFolderStatus,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ImapFolderSyncResult {
    pub uids: Vec<u32>,
    pub messages: Vec<ImapMessage>,
    pub folder_status: ImapFolderStatus,
}

/// One message body returned by `fetch_bodies_batch`. The `snippet` is the
/// ~200-char whitespace-collapsed preview derived from `body_text`; the engine
/// writes it onto `messages.snippet` so the thread list shows a preview without
/// a second read of the (large) `message_bodies` row. `attachments` carries the
/// parsed MIME attachment metadata (part_id/section, filename, mime_type, size,
/// content_id, is_inline) so the engine can persist it to the `attachments`
/// table without re-parsing.
///
/// `raw_ciphertext` carries the raw CMS payload (DER) when the top-level
/// Content-Type is `application/pkcs7-mime` (S/MIME enveloped-data OR opaque
/// signed-data) OR when the top-level Content-Type is `multipart/signed`
/// (clear-signed: the detached `smime.p7s` SignedData DER, which IS a CMS
/// blob). The engine persists it to `message_bodies.body_mime_ciphertext` so
/// the receive orchestrator (Phase 1b G5 Task 3 + G7 Task 2) can decrypt/verify
/// on open WITHOUT re-fetching from IMAP. `None` for ordinary mail.
///
/// `raw_signed_part` carries the raw part-1 MIME entity bytes for clear-signed
/// `multipart/signed` mail (the bytes the detached `.p7s` signature covers —
/// the part-1 entity including its MIME headers, blank line, body, and exactly
/// one trailing CRLF). Persisted to `message_bodies.body_mime_signed_part`.
/// `None` for ordinary mail AND for `application/pkcs7-mime` opaque S/MIME
/// (which has no detached signature — the signature is encapsulated in the CMS
/// blob). Plaintext is NEVER persisted via either path.
#[derive(Debug, Clone, PartialEq)]
pub struct FetchedBody {
    pub uid: u32,
    pub body_html: Option<String>,
    pub body_text: Option<String>,
    pub snippet: String,
    pub attachments: Vec<ImapAttachment>,
    /// Raw CMS DER: `smime.p7m` body bytes for `application/pkcs7-mime`
    /// messages, OR the detached `smime.p7s` SignedData DER for
    /// `multipart/signed` clear-signed messages. See the struct doc.
    pub raw_ciphertext: Option<Vec<u8>>,
    /// Raw part-1 MIME entity bytes (the bytes the detached signature covers)
    /// for `multipart/signed` clear-signed messages. `None` otherwise. See the
    /// struct doc.
    pub raw_signed_part: Option<Vec<u8>>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ImapFolderSearchResult {
    pub uids: Vec<u32>,
    pub folder_status: ImapFolderStatus,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DeltaCheckRequest {
    pub folder: String,
    pub last_uid: u32,
    pub uidvalidity: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DeltaCheckResult {
    pub folder: String,
    pub uidvalidity: u32,
    pub new_uids: Vec<u32>,
    pub uidvalidity_changed: bool,
}
