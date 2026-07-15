//! Per-mail-server provider profile — isolates ALL vendor-specific IMAP quirks
//! behind a single pure `detect()` function. The sync engine consults the profile
//! via clean accessor methods (`enable_requests()`, `idle_reports_expunges()`,
//! `message_limit()`, etc.); there is never an `if vendor == yahoo` branch in
//! `imap_source.rs` or `engine.rs`.
//!
//! Which Yahoo needs are handleable by pure capability-gating (MOVE, LIST-STATUS,
//! OBJECTID, CONDSTORE/QRESYNC — any server advertising the cap gets the
//! optimization) vs which REQUIRE a per-vendor profile (the decision to ENABLE
//! UIDONLY, the IDLE-expunge gap, MESSAGELIMIT truncation, the "All Mail" virtual
//! folder): see `docs/yahoo/yahoo-imap-optimization-plan.md`. This module covers
//! only the latter — the unadvertised quirks that no CAPABILITY token exposes.

use crate::sync_engine::Capabilities;

/// The server vendor, detected at connect from hostname + IMAP ID + caps.
/// Carried for logging/telemetry; the sync engine does NOT branch on it.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum Vendor {
    #[default]
    Generic,
    Yahoo,
    Gmail,
    NetEase,
    Exchange,
}

/// Which stable-ID scheme the server exposes (for `remote_email_id` /
/// `remote_thread_id` fields on `RemoteMessage`). Phase 2 (P4 OBJECTID).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum StableIdKind {
    #[default]
    None,
    /// RFC 8474 OBJECTID: EMAILID / THREADID.
    ObjectId,
    /// Gmail X-GM-EXT-1: X-GM-MSGID / X-GM-THRID.
    GmExt1,
}

/// Unadvertised server quirks + provider-specific knowledge. Detected once at
/// connect, held by the session actor, snapshotted to `ImapSource`.
#[derive(Debug, Clone)]
pub struct ProviderProfile {
    pub vendor: Vendor,
    /// Server `name` from the IMAP ID response (telemetry).
    pub id_name: Option<String>,
    /// Capabilities to request via ENABLE (self-filtered to advertised caps at
    /// the `setup_session` call site). Yahoo → `["UIDONLY"]`; generic → `[]`.
    enable_requests: Vec<&'static str>,
    /// Whether the server's IDLE reports EXPUNGE/VANISHED. Yahoo → false
    /// (Yahoo docs: "IDLE responses include only new messages and updates.
    /// Message deletes or EXPUNGE will not be available."). Everyone else → true.
    idle_reports_expunges: bool,
    /// Per-response cap if the server enforces MESSAGELIMIT (Yahoo UIDONLY).
    /// None = uncapped.
    message_limit: Option<u32>,
    /// Virtual "All Mail" folder path, if the server exposes one (opt-in P5).
    all_mail_folder: Option<&'static str>,
    /// Which stable-ID scheme to populate (P4, Phase 2).
    stable_id_kind: StableIdKind,
}

impl Default for ProviderProfile {
    fn default() -> Self {
        Self::generic()
    }
}

impl ProviderProfile {
    /// The default/generic profile — no quirks, no ENABLE, IDLE reports expunges.
    pub fn generic() -> Self {
        Self {
            vendor: Vendor::Generic,
            id_name: None,
            enable_requests: Vec::new(),
            idle_reports_expunges: true,
            message_limit: None,
            all_mail_folder: None,
            stable_id_kind: StableIdKind::None,
        }
    }

    pub fn enable_requests(&self) -> &[&'static str] {
        &self.enable_requests
    }
    pub fn idle_reports_expunges(&self) -> bool {
        self.idle_reports_expunges
    }
    pub fn message_limit(&self) -> Option<u32> {
        self.message_limit
    }
    pub fn all_mail_folder(&self) -> Option<&str> {
        self.all_mail_folder
    }
    pub fn stable_id_kind(&self) -> StableIdKind {
        self.stable_id_kind
    }
}

/// PURE detector — the ONLY place vendor branching lives in the codebase.
/// `hostname` should be lowercased by the caller; `id_name` is the server's ID
/// `name` field (None if ID unsupported / failed / NIL); `caps` is the advertised
/// set from `session_capabilities`.
pub fn detect(hostname: &str, id_name: Option<&str>, caps: &Capabilities) -> ProviderProfile {
    let host = hostname.to_ascii_lowercase();
    let idn = id_name.unwrap_or("");

    // ---- Yahoo / AOL ----
    // Host: imap.mail.yahoo.com, imap.aim.com, etc. ID name: "Y!IMAP" or
    // starts with "jimap" (the internal cluster name).
    if host.contains("yahoo") || host.contains("aol") || idn == "Y!IMAP" || idn.starts_with("jimap") {
        return ProviderProfile {
            vendor: Vendor::Yahoo,
            id_name: id_name.map(str::to_owned),
            enable_requests: vec!["UIDONLY"],
            idle_reports_expunges: false,
            // Yahoo's MESSAGELIMIT is 1000 (from the CAPABILITY token; the value
            // isn't extractable via has_str, so hardcode the known value).
            message_limit: Some(1000),
            all_mail_folder: Some("All Mail"),
            stable_id_kind: if caps.objectid { StableIdKind::ObjectId } else { StableIdKind::None },
        };
    }

    // ---- Gmail ---- (detected by the X-GM-EXT-1 cap, not hostname — same as
    // Thunderbird's approach)
    if caps.gm_ext1 {
        return ProviderProfile {
            vendor: Vendor::Gmail,
            id_name: id_name.map(str::to_owned),
            enable_requests: Vec::new(),
            idle_reports_expunges: true,
            message_limit: None,
            all_mail_folder: Some("[Gmail]/All Mail"),
            stable_id_kind: StableIdKind::GmExt1,
        };
    }

    // ---- NetEase (163/126) ----
    if host.contains("163.com") || host.contains("126.com") || host.contains("netease") {
        return ProviderProfile {
            vendor: Vendor::NetEase,
            id_name: id_name.map(str::to_owned),
            ..ProviderProfile::generic()
        };
    }

    // ---- Exchange (outlook.office365.com IMAP) ----
    if host.contains("outlook.office365") || host.contains("outlook.com") || idn.contains("Microsoft") {
        return ProviderProfile {
            vendor: Vendor::Exchange,
            id_name: id_name.map(str::to_owned),
            ..ProviderProfile::generic()
        };
    }

    ProviderProfile::generic()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn generic_caps() -> Capabilities {
        Capabilities::default()
    }

    #[test]
    fn detect_yahoo_by_hostname() {
        let caps = Capabilities { uidonly: true, enable: true, objectid: true, ..generic_caps() };
        let p = detect("imap.mail.yahoo.com", Some("Y!IMAP"), &caps);
        assert_eq!(p.vendor, Vendor::Yahoo);
        assert_eq!(p.enable_requests(), &["UIDONLY"]);
        assert!(!p.idle_reports_expunges());
        assert_eq!(p.message_limit(), Some(1000));
        assert_eq!(p.stable_id_kind(), StableIdKind::ObjectId);
        assert_eq!(p.all_mail_folder(), Some("All Mail"));
    }

    #[test]
    fn detect_yahoo_by_aol_hostname() {
        let p = detect("imap.aol.com", None, &generic_caps());
        assert_eq!(p.vendor, Vendor::Yahoo); // AOL shares Yahoo infra
        assert_eq!(p.enable_requests(), &["UIDONLY"]);
    }

    #[test]
    fn detect_gmail_by_cap() {
        let caps = Capabilities { gm_ext1: true, ..generic_caps() };
        let p = detect("imap.gmail.com", None, &caps);
        assert_eq!(p.vendor, Vendor::Gmail);
        assert_eq!(p.stable_id_kind(), StableIdKind::GmExt1);
        assert!(p.enable_requests().is_empty());
        assert_eq!(p.all_mail_folder(), Some("[Gmail]/All Mail"));
    }

    #[test]
    fn detect_netease() {
        let p = detect("imap.163.com", None, &generic_caps());
        assert_eq!(p.vendor, Vendor::NetEase);
    }

    #[test]
    fn detect_exchange() {
        let p = detect("outlook.office365.com", None, &generic_caps());
        assert_eq!(p.vendor, Vendor::Exchange);
    }

    #[test]
    fn detect_generic_fallback() {
        let p = detect("imap.fastmail.com", None, &generic_caps());
        assert_eq!(p.vendor, Vendor::Generic);
        assert!(p.enable_requests().is_empty());
        assert!(p.idle_reports_expunges());
    }

    #[test]
    fn generic_profile_defaults() {
        let p = ProviderProfile::generic();
        assert_eq!(p.vendor, Vendor::Generic);
        assert!(p.enable_requests().is_empty());
        assert!(p.idle_reports_expunges());
        assert!(p.message_limit().is_none());
        assert!(p.all_mail_folder().is_none());
        assert_eq!(p.stable_id_kind(), StableIdKind::None);
    }
}
