// Ported from mailkit_arkts. License pending confirmation. See ATTRIBUTIONS.md.
//
// EAS HTTP client. Wraps `reqwest` to send WBXML POST requests to an Exchange
// ActiveSync endpoint and parse WBXML responses. Each command (FolderSync,
// Sync, SendMail, etc.) has its own high-level method that delegates to the
// pure marshalers in `commands.rs`.

use crate::eas::commands;
use crate::eas::types::*;
use crate::eas::wbxml::{deserialize_to_tree, serialize_tree, WbxmlElement, WbxmlError};
use base64::Engine;

const PAGE_FOLDER: u8 = 7;
const PAGE_COMPOSE: u8 = 21;
const PAGE_ITEM_OPS: u8 = 20;
const PAGE_PING: u8 = 13;
const PAGE_AIRSYNC: u8 = 0;

/// AirSync (page 0) `Sync` root token. Used by the Sync response `expect_root`
/// check so a non-Sync response (server error page, OWA redirect, etc.) is
/// surfaced as `UnexpectedRoot` rather than a confusing parse failure.
const AS_SYNC: u8 = 0x05;

const FH_FOLDER_SYNC: u8 = 0x16;
const FH_FOLDER_CREATE: u8 = 0x13;
const FH_FOLDER_DELETE: u8 = 0x14;
const FH_FOLDER_UPDATE: u8 = 0x15;

const CM_SEND_MAIL: u8 = 0x05;
const CM_SMART_FORWARD: u8 = 0x06;
const CM_SMART_REPLY: u8 = 0x07;

const IO_ITEMOPERATIONS: u8 = 0x05;
const PING_PING: u8 = 0x05;

const GIE_ROOT: u8 = 0x05;

/// Error returned by any EAS operation. Combines transport, WBXML, and
/// protocol-level errors (status codes).
#[derive(Debug, thiserror::Error)]
pub enum EasError {
    #[error("HTTP transport error: {0}")]
    Transport(String),
    /// Non-200 HTTP response. `retry_after` carries the parsed `Retry-After`
    /// header (delta-seconds form, converted to absolute epoch) when the server
    /// sent one alongside a 429/503; `None` otherwise (including the HTTP-date
    /// form, which we do not parse — caller falls back to a default window).
    /// The EAS source promotes a 429/503 HttpStatus with `retry_after` to
    /// `SourceError::RateLimited`.
    #[error("HTTP {status}: {body}")]
    HttpStatus {
        status: u16,
        body: String,
        retry_after: Option<i64>,
    },
    #[error("WBXML codec error: {0}")]
    Wbxml(#[from] WbxmlError),
    #[error("unexpected response root: page {page} token {token}")]
    UnexpectedRoot { page: u8, token: u8 },
    #[error("command status {status}: {message}")]
    CommandStatus { status: u32, message: String },
    /// OAuth token refresh failed (network, non-2xx, or JSON parse error).
    /// Surfaces to the caller so it can prompt the user to re-authenticate.
    /// Basic auth never produces this error — `EasAuth::refresh()` is a no-op
    /// for Basic.
    #[error("OAuth token refresh failed: {0}")]
    AuthRefreshFailed(String),
}

impl From<reqwest::Error> for EasError {
    fn from(e: reqwest::Error) -> Self {
        EasError::Transport(e.to_string())
    }
}

/// High-level EAS client. Cheap to clone (just wraps a `reqwest::Client` and config).
#[derive(Clone)]
pub struct EasClient {
    config: EasConfig,
    http: reqwest::Client,
}

impl EasClient {
    pub fn new(config: EasConfig) -> Self {
        let mut builder = reqwest::Client::builder()
            .timeout(std::time::Duration::from_secs(120))
            .danger_accept_invalid_certs(config.accept_invalid_certs);
        // User-Agent
        let ua = config.user_agent.clone();
        if !ua.is_empty() {
            builder = builder.user_agent(&ua);
        }
        let http = builder.build().unwrap_or_else(|_| reqwest::Client::new());
        Self { config, http }
    }

    /// Issue a single EAS command request. Sends WBXML bytes, reads WBXML
    /// response, deserializes to a tree. Each command method wraps this.
    async fn send_command(
        &self,
        cmd_name: &str,
        request_root: &WbxmlElement,
    ) -> Result<WbxmlElement, EasError> {
        let wbxml_bytes = serialize_tree(request_root).map_err(EasError::Wbxml)?;

        let auth_value = base64::engine::general_purpose::STANDARD
            .encode(format!("{}:{}", self.config.username, self.config.password));

        // Query string per [MS-ASHTTP] section 2.1: Cmd + User + DeviceId + DeviceType.
        // Note: the server URL is typically
        // `https://host/Microsoft-Server-ActiveSync` (no trailing slash).
        let url = format!(
            "{}?Cmd={}&User={}&DeviceId={}&DeviceType={}",
            self.config.url.trim_end_matches('/'),
            cmd_name,
            urlencode(&self.config.username),
            urlencode(&self.config.device_id),
            urlencode(&self.config.device_type),
        );

        log::debug!("EAS POST {} ({} bytes wbxml)", url, wbxml_bytes.len());

        let response = self
            .http
            .post(&url)
            .header("Authorization", format!("Basic {}", auth_value))
            .header("MS-ASProtocolVersion", &self.config.protocol_version)
            .header("Content-Type", "application/vnd.ms-sync.wbxml")
            .header("Accept", "application/vnd.ms-sync.wbxml")
            .header("X-MS-DeviceType", &self.config.device_type)
            .header("X-MS-DeviceId", &self.config.device_id)
            .header(
                "X-MS-PolicyKey",
                if self.config.policy_key.is_empty() {
                    "0"
                } else {
                    &self.config.policy_key
                },
            )
            .header("User-Agent", &self.config.user_agent)
            .header("Connection", "keep-alive")
            .body(wbxml_bytes)
            .send()
            .await?;

        let status = response.status().as_u16();

        // Phase 3f Task 5: capture Retry-After (delta-seconds) before we
        // consume the body via `.text()`. HTTP-date form falls back to None
        // (caller uses the default rate-limit window). We use SystemTime (not
        // chrono or SQLite unixepoch()) because the EAS client does not hold a
        // SqlitePool and this is a transport-layer concern — the resulting
        // epoch is compared against SQLite's clock by the engine, which is
        // fine because both read the same wall clock (drift of a few ms is
        // immaterial for a >=60s backoff window).
        let now_epoch = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_secs() as i64)
            .unwrap_or(0);
        let retry_after = response
            .headers()
            .get("Retry-After")
            .and_then(|v| v.to_str().ok())
            .and_then(|s| parse_retry_after_delta(s, now_epoch));

        let content_type = response
            .headers()
            .get("Content-Type")
            .and_then(|v| v.to_str().ok())
            .unwrap_or("")
            .to_string();

        log::debug!(
            "EAS response: status={}, content-type={}",
            status,
            content_type
        );

        if status != 200 {
            let body = response.text().await.unwrap_or_default();
            return Err(EasError::HttpStatus {
                status,
                body,
                retry_after,
            });
        }
        // Check for command-level error in headers (MS-ASProtocolStatus)
        if let Some(proto_status) = response.headers().get("MS-ASProtocolStatus") {
            let s = proto_status.to_str().unwrap_or("0");
            if s != "0" {
                return Err(EasError::CommandStatus {
                    status: s.parse().unwrap_or(0),
                    message: format!("protocol error from server: {}", s),
                });
            }
        }
        // Detect non-WBXML response (server returning HTML error page or OWA login)
        if !content_type.contains("vnd.ms-sync.wbxml") {
            let body = response.bytes().await.unwrap_or_default();
            let preview = String::from_utf8_lossy(&body[..body.len().min(200)]);
            return Err(EasError::Transport(format!(
                "server returned non-WBXML content-type '{}'. First 200 bytes: {}",
                content_type, preview
            )));
        }

        let body = response.bytes().await?;
        if body.is_empty() {
            return Err(EasError::Transport("empty response body".into()));
        }

        let root = match deserialize_to_tree(&body) {
            Ok(tree) => tree,
            Err(e) => {
                log::warn!(
                    "EAS WBXML parse failed ({} bytes, first 64: {:02X?}): {}",
                    body.len(),
                    &body[..body.len().min(64)],
                    e
                );
                return Err(EasError::Wbxml(e));
            }
        };
        Ok(root)
    }

    /// FolderSync — full folder hierarchy sync.
    pub async fn folder_sync(&self, sync_key: &str) -> Result<FolderSyncResult, EasError> {
        let req = commands::build_folder_sync_request(sync_key);
        let resp = self.send_command("FolderSync", &req).await?;
        expect_root(&resp, PAGE_FOLDER, FH_FOLDER_SYNC)?;
        Ok(commands::parse_folder_sync_response(&resp)?)
    }

    /// Sync — single-collection item sync.
    pub async fn sync(&self, req: &SyncRequest) -> Result<SyncResult, EasError> {
        let tree = commands::build_sync_request(req);
        let resp = self.send_command("Sync", &tree).await?;
        // Verify the server returned a Sync element. A non-Sync root typically
        // means the server returned an error page or OWA redirect that the
        // transport layer couldn't detect — surface it rather than attempt a
        // misleading parse.
        expect_root(&resp, PAGE_AIRSYNC, AS_SYNC)?;
        Ok(commands::parse_sync_response(&resp)?)
    }

    /// SendMail — send a single MIME message.
    pub async fn send_mail(&self, req: &SendMailRequest) -> Result<u32, EasError> {
        let tree = commands::build_send_mail_request(req);
        let resp = self.send_command("SendMail", &tree).await?;
        expect_root(&resp, PAGE_COMPOSE, CM_SEND_MAIL)?;
        Ok(commands::parse_send_mail_response(&resp)?)
    }

    /// SmartForward — forward an existing server-side message with new MIME body.
    pub async fn smart_forward(&self, req: &SmartForwardRequest) -> Result<u32, EasError> {
        let tree = commands::build_smart_forward_request(req);
        let resp = self.send_command("SmartForward", &tree).await?;
        expect_root(&resp, PAGE_COMPOSE, CM_SMART_FORWARD)?;
        Ok(commands::parse_send_mail_response(&resp)?)
    }

    /// SmartReply — reply to an existing server-side message with new MIME body.
    pub async fn smart_reply(&self, req: &SmartReplyRequest) -> Result<u32, EasError> {
        let tree = commands::build_smart_reply_request(req);
        let resp = self.send_command("SmartReply", &tree).await?;
        expect_root(&resp, PAGE_COMPOSE, CM_SMART_REPLY)?;
        Ok(commands::parse_send_mail_response(&resp)?)
    }

    /// ItemOperations — fetch an attachment or item by server id.
    pub async fn item_operations(
        &self,
        req: &ItemOperationsFetchRequest,
    ) -> Result<ItemOperationsFetchResult, EasError> {
        let tree = commands::build_item_operations_request(req);
        let resp = self.send_command("ItemOperations", &tree).await?;
        expect_root(&resp, PAGE_ITEM_OPS, IO_ITEMOPERATIONS)?;
        Ok(commands::parse_item_operations_response(&resp)?)
    }

    /// GetItemEstimate — count of pending items for a collection.
    pub async fn get_item_estimate(
        &self,
        req: &GetItemEstimateRequest,
    ) -> Result<GetItemEstimateResult, EasError> {
        let tree = commands::build_get_item_estimate_request(req);
        let resp = self.send_command("GetItemEstimate", &tree).await?;
        // Root page for GetItemEstimate is 6; root token 0x05.
        expect_root(&resp, 6, GIE_ROOT)?;
        Ok(commands::parse_get_item_estimate_response(&resp)?)
    }

    /// Ping — block up to heartbeat_interval waiting for changes.
    pub async fn ping(&self, req: &PingRequest) -> Result<PingResult, EasError> {
        let tree = commands::build_ping_request(req);
        let resp = self.send_command("Ping", &tree).await?;
        expect_root(&resp, PAGE_PING, PING_PING)?;
        Ok(commands::parse_ping_response(&resp)?)
    }

    /// FolderCreate — create a new folder under a parent.
    pub async fn folder_create(
        &self,
        req: &FolderCreateRequest,
    ) -> Result<(u32, Option<String>), EasError> {
        let tree = commands::build_folder_create_request(req);
        let resp = self.send_command("FolderCreate", &tree).await?;
        expect_root(&resp, PAGE_FOLDER, FH_FOLDER_CREATE)?;
        Ok(commands::parse_folder_op_response(&resp)?)
    }

    /// FolderDelete — delete a folder by server id.
    pub async fn folder_delete(
        &self,
        req: &FolderDeleteRequest,
    ) -> Result<(u32, Option<String>), EasError> {
        let tree = commands::build_folder_delete_request(req);
        let resp = self.send_command("FolderDelete", &tree).await?;
        expect_root(&resp, PAGE_FOLDER, FH_FOLDER_DELETE)?;
        Ok(commands::parse_folder_op_response(&resp)?)
    }

    /// FolderUpdate — rename or move a folder.
    pub async fn folder_update(
        &self,
        req: &FolderUpdateRequest,
    ) -> Result<(u32, Option<String>), EasError> {
        let tree = commands::build_folder_update_request(req);
        let resp = self.send_command("FolderUpdate", &tree).await?;
        expect_root(&resp, PAGE_FOLDER, FH_FOLDER_UPDATE)?;
        Ok(commands::parse_folder_op_response(&resp)?)
    }

    /// Run the two-phase Provision handshake (MS-ASPROV) and persist the
    /// resulting permanent policy key into `self.config.policy_key`.
    /// Subsequent commands then send it via the X-MS-PolicyKey header (already
    /// wired in `send_command`).
    ///
    /// Takes `&mut self` because Phase 2 writes the permanent key. Other
    /// command methods remain `&self` — only Provision mutates config.
    ///
    /// Errors with `CommandStatus { status: 140, ... }` if either phase
    /// returns a `<RemoteWipe>` element — we surface, NEVER auto-execute
    /// (per Global Constraints). Other non-1 statuses surface as
    /// `CommandStatus` with the protocol status code.
    pub async fn provision(&mut self) -> Result<(), EasError> {
        // Phase 1: request the policy. Server returns a temp PolicyKey + the
        // policy XML in <Data>.
        let req1 = crate::eas::provision::build_provision_phase1_request();
        // TODO(3b T5): switch to send_command_no_retry once the retry wrapper lands.
        let resp1 = self.send_command("Provision", &req1).await?;
        let parsed1 = crate::eas::provision::parse_provision_response(&resp1)?;
        if parsed1.remote_wipe {
            return Err(EasError::CommandStatus {
                status: 140,
                message: "server requested RemoteWipe — refusing to auto-execute".into(),
            });
        }
        if parsed1.status != 1 {
            return Err(EasError::CommandStatus {
                status: parsed1.status,
                message: format!("Provision phase 1 status {}", parsed1.status),
            });
        }
        let temp_key = parsed1.policy_key.ok_or_else(|| {
            EasError::Transport("Provision phase 1 returned no PolicyKey".into())
        })?;

        // Phase 2: ack with the temp key and Status 1 (client compliant).
        // Server replies with the permanent PolicyKey.
        let req2 = crate::eas::provision::build_provision_phase2_request(&temp_key);
        // TODO(3b T5): switch to send_command_no_retry once the retry wrapper lands.
        let resp2 = self.send_command("Provision", &req2).await?;
        let parsed2 = crate::eas::provision::parse_provision_response(&resp2)?;
        if parsed2.remote_wipe {
            return Err(EasError::CommandStatus {
                status: 140,
                message: "server requested RemoteWipe in phase 2 — refusing".into(),
            });
        }
        if parsed2.status != 1 {
            return Err(EasError::CommandStatus {
                status: parsed2.status,
                message: format!("Provision phase 2 status {}", parsed2.status),
            });
        }
        let perm_key = parsed2.policy_key.ok_or_else(|| {
            EasError::Transport("Provision phase 2 returned no permanent PolicyKey".into())
        })?;
        self.config.policy_key = perm_key;
        Ok(())
    }
}

fn expect_root(root: &WbxmlElement, page: u8, token: u8) -> Result<(), EasError> {
    if root.page == page && root.token == token {
        Ok(())
    } else {
        Err(EasError::UnexpectedRoot {
            page: root.page,
            token: root.token,
        })
    }
}

/// Minimal form-urlencoder for the handful of query string values we emit.
/// Avoids pulling in a `urlencoding` crate dependency.
fn urlencode(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for b in s.as_bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                out.push(*b as char);
            }
            _ => {
                out.push_str(&format!("%{:02X}", b));
            }
        }
    }
    out
}

/// Parse a `Retry-After` header value (delta-seconds form) into an absolute
/// epoch-seconds timestamp. Returns `None` for:
///   - the HTTP-date form (RFC 7231 §7.1.3, e.g. `Wed, 21 Oct 2026 07:28:00
///     GMT`) — we deliberately do NOT parse it; the caller falls back to the
///     default rate-limit window. This is an honest, documented limitation
///     (HTTP-date support is tracked as a follow-up).
///   - any non-integer / unparseable input.
///
/// Pure / no I/O — extracted from the HTTP-response handling path so it is
/// unit-testable without a live socket. The caller passes the current epoch
/// (`SystemTime::now()` at the response site) so the parser itself is
/// deterministic.
fn parse_retry_after_delta(header_value: &str, now_epoch: i64) -> Option<i64> {
    let delta: i64 = header_value.trim().parse().ok()?;
    Some(now_epoch + delta)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn urlencode_passes_alphanumeric() {
        assert_eq!(urlencode("abcXYZ123"), "abcXYZ123");
    }

    #[test]
    fn urlencode_escapes_special() {
        assert_eq!(urlencode("user@host"), "user%40host");
        assert_eq!(urlencode("a b"), "a%20b");
        assert_eq!(urlencode("kylins\\admin"), "kylins%5Cadmin");
    }

    #[test]
    fn urlencode_keeps_unreserved() {
        assert_eq!(urlencode("a-b_c.d~e"), "a-b_c.d~e");
    }

    #[test]
    fn urlencode_empty() {
        assert_eq!(urlencode(""), "");
    }

    // ---- Phase 3f Task 5: Retry-After (delta-seconds) parsing ----

    #[test]
    fn parse_retry_after_delta_seconds() {
        // Plain delta-seconds: result is now + delta.
        assert_eq!(parse_retry_after_delta("30", 1000), Some(1030));
        // Whitespace is tolerated (reqwest/HeaderValue strips most already, but
        // `trim()` makes the parser robust to a stray leading/trailing space).
        assert_eq!(parse_retry_after_delta("  120  ", 0), Some(120));
        // HTTP-date form (RFC 7231 §7.1.3) — we do NOT parse it; caller falls
        // back to the default window. Honest limitation.
        assert_eq!(
            parse_retry_after_delta("Wed, 21 Oct 2026 07:28:00 GMT", 0),
            None
        );
        // Non-numeric / empty -> None.
        assert_eq!(parse_retry_after_delta("garbage", 0), None);
        assert_eq!(parse_retry_after_delta("", 0), None);
    }
}
