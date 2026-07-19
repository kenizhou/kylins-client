//! S/MIME MIME-wrapping layer for the send hook (Plan 4a). Pure byte
//! construction — no mail-builder dependency — so clear-sign part-1 byte
//! exactness is fully under our control (the signature must cover the exact
//! part-1 bytes incl. the trailing CRLF before the boundary).
//!
//! Byte structure validated against Thunderbird
//! (`mailnews/extensions/smime/nsMsgComposeSecure.cpp` + `nsCMS.cpp`):
//!   - sign-then-encrypt ordering (applied by the Task 5 orchestrator)
//!   - part 1 = the full body MIME entity (Content-Type **and**
//!     Content-Transfer-Encoding)
//!   - the signed bytes include exactly one trailing CRLF (the body's own
//!     terminator — do NOT double-add; `ensure_one_trailing_crlf` guarantees it)
//!   - header emit: **unquoted** `micalg=sha-256`, **quoted** `boundary="…"`,
//!     `"This is a cryptographically signed message in MIME format."` preamble,
//!     part-2 `Content-Description: S/MIME Cryptographic Signature`, and base64
//!     line-wrapped at column 72.
//!
//! # Dead-code allow
//! Task 5 shipped `apply_crypto` + its wrapper call graph as a fully tested
//! unit with no non-test caller; the module carried `#![allow(dead_code)]` so
//! the per-target analysis didn't flag the call graph. Task 6 wires
//! `apply_crypto` into `send_op`, so the allow is no longer needed at the
//! module level — every `pub(crate)` item is now reachable from a non-test
//! caller. If a future refactor drops the `send_op` call site, expect a
//! dead-code warning here as the prompt to either restore the call or remove
//! the item.

use base64::Engine;

use cms::content_info::ContentInfo;
use crypto_core::{
    CryptoBackend, DecryptOp, EncryptOp, EncryptedEnvelope, EncryptedPart, Fingerprint, KeyHandle,
    KeyHandleRef, KeyId, KeyStore, KeyUsage, Part, PartId, PartKind, SerializationStrategy, SignOp,
    SignatureState, SignedEnvelope, Standard, TrustState,
};
use crypto_smime::SmimeBackend;
use der::{Decode, Encode};
use sqlx::SqlitePool;

use crate::db::crypto_keys::{
    list_crypto_keys_for_account, list_intermediate_certs, list_trust_anchor_certs, DefaultKeyRow,
};
use crate::db::message_bodies::{get_message_ciphertext, get_message_signed_part};
use crate::db::message_crypto_results::{
    get_message_crypto_result, upsert_message_crypto_result, MessageCryptoResultRow,
};
use crate::db::trust_decisions::get_latest_trust_decision;
use crate::keystore_bridge::SqliteKeyStore;
use crate::mail::builder::{CryptoMethod, SendDraft};
use crate::mail::crypto_crl::fetch_crl_cached;
use crate::mail::imap::client::extract_attachments;
use crate::mail::imap::types::ImapAttachment;

/// The set of MIME *entity* headers that belong to a body part (move with the
/// body entity), not the outer RFC5322 message. Everything else (From/To/
/// Subject/Date/Message-ID/MIME-Version/…) stays outer.
const ENTITY_HEADERS: &[&str] = &[
    "content-type",
    "content-transfer-encoding",
    "content-disposition",
    "content-id",
    "content-description",
    "content-language",
];

#[derive(Debug, Clone)]
pub(crate) struct MessageHeaders {
    /// Outer message header lines, each `Name: value\r\n`-terminated, NO entity
    /// headers, NO trailing blank line.
    pub headers: String,
}

#[derive(Debug, Clone)]
pub(crate) struct EntityBytes(pub Vec<u8>);

/// Errors from the send-hook crypto layer.
#[derive(Debug)]
pub enum CryptoSendError {
    NoSigningKey,
    MissingRecipientCert(String),
    /// A recipient cert was found in the keystore but failed chain validation
    /// (expired, wrong-issuer, missing EKU/SAN, or no anchor could be loaded
    /// to confirm it). Fail-closed: no ciphertext is produced.
    InvalidRecipientCert(String),
    Backend(crypto_core::CryptoError),
    Mime(String),
}
impl std::fmt::Display for CryptoSendError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::NoSigningKey => write!(f, "no default S/MIME signing key for the account"),
            Self::MissingRecipientCert(e) => write!(f, "no S/MIME cert for recipient {e}"),
            Self::InvalidRecipientCert(e) => {
                write!(f, "invalid S/MIME recipient cert: {e}")
            }
            Self::Backend(e) => write!(f, "crypto backend: {e}"),
            Self::Mime(s) => write!(f, "mime: {s}"),
        }
    }
}
impl std::error::Error for CryptoSendError {}
impl From<crypto_core::CryptoError> for CryptoSendError {
    fn from(e: crypto_core::CryptoError) -> Self {
        Self::Backend(e)
    }
}

/// Split a built RFC5322 message into the outer message headers (no entity
/// headers) and the body entity (entity headers + blank line + body).
///
/// Folding-aware: a header line beginning with space or tab is an RFC 5322
/// continuation of the previous header and inherits the SAME bucket (outer vs
/// entity) as the line it continues. This matters because `mail-builder`
/// (`headers/content_type.rs:write_header`) folds long `Content-Type` values
/// (multipart `boundary` attributes push the line past 76 cols) onto a
/// following `\r\n\t`-prefixed line; without this rule the continuation would
/// be mis-classified as an outer header and leak out of the signed entity.
pub(crate) fn split_message(full: &[u8]) -> Result<(MessageHeaders, EntityBytes), CryptoSendError> {
    let s =
        std::str::from_utf8(full).map_err(|e| CryptoSendError::Mime(format!("not utf-8: {e}")))?;
    let blank = s
        .find("\r\n\r\n")
        .ok_or_else(|| CryptoSendError::Mime("no header/body blank line".into()))?;
    let header_block = &s[..blank];
    let body = &s[blank + 4..];

    let mut outer = String::new();
    let mut entity_headers = String::new();
    // Track the bucket the previous header line was routed to so a folded
    // continuation line (starts with space/tab) inherits it. Before the first
    // header line there's no preceding bucket, so continuations default outer.
    let mut last_was_entity = false;
    for line in header_block.split("\r\n") {
        let is_continuation = line.starts_with(' ') || line.starts_with('\t');
        let is_entity = if is_continuation {
            last_was_entity
        } else {
            let name = line
                .split(':')
                .next()
                .unwrap_or("")
                .trim()
                .to_ascii_lowercase();
            ENTITY_HEADERS.contains(&name.as_str())
        };
        let target = if is_entity {
            &mut entity_headers
        } else {
            &mut outer
        };
        if !target.is_empty() {
            target.push_str("\r\n");
        }
        target.push_str(line);
        last_was_entity = is_entity;
    }
    let entity = format!("{entity_headers}\r\n\r\n{body}").into_bytes();
    Ok((MessageHeaders { headers: outer }, EntityBytes(entity)))
}

/// Ensure `bytes` ends with exactly one `\r\n`. Clear-sign part-1 byte exactness.
/// Collapses any doubled trailing CRLFs (`…\r\n\r\n` → `…\r\n`) then adds a
/// single CRLF if none was present.
pub(crate) fn ensure_one_trailing_crlf(bytes: &[u8]) -> Vec<u8> {
    let mut out = bytes.to_vec();
    while out.ends_with(b"\r\n\r\n") {
        out.truncate(out.len() - 2); // collapse doubled trailing CRLF
    }
    if !out.ends_with(b"\r\n") {
        out.extend_from_slice(b"\r\n");
    }
    out
}

const SIGNED_BOUNDARY: &str = "----=_kylins_smime_signed_0001";

/// Build a `multipart/signed` MIME **entity** (Content-Type header + blank +
/// multipart body). Part 1 is EXACTLY `inner_entity_with_crlf` — the caller
/// signs that exact slice and passes the resulting detached SignedData DER.
///
/// Layout (Thunderbird-faithful):
/// ```text
/// Content-Type: multipart/signed; protocol="application/pkcs7-signature";
///    micalg=sha-256; boundary="----=_kylins_smime_signed_0001"
/// <blank>
/// This is a cryptographically signed message in MIME format.
/// --{boundary}
/// {part 1 = inner_entity_with_crlf, ending in exactly one CRLF}
/// --{boundary}
/// Content-Type: application/pkcs7-signature; name="smime.p7s"
/// Content-Transfer-Encoding: base64
/// Content-Disposition: attachment; filename="smime.p7s"
/// Content-Description: S/MIME Cryptographic Signature
/// <blank>
/// {base64(sha-256 detached signature), wrapped at 72 cols}
/// --{boundary}--
/// ```
pub(crate) fn wrap_multipart_signed(inner_entity_with_crlf: &[u8], signed_der: &[u8]) -> Vec<u8> {
    let sig_b64 = base64::engine::general_purpose::STANDARD.encode(signed_der);
    let mut out = Vec::new();
    out.extend_from_slice(
        format!(
            "Content-Type: multipart/signed; protocol=\"application/pkcs7-signature\"; \
             micalg=sha-256; boundary=\"{SIGNED_BOUNDARY}\"\r\n\r\n"
        )
        .as_bytes(),
    );
    out.extend_from_slice(b"This is a cryptographically signed message in MIME format.\r\n");
    // Part 1 — the signed body entity (exact bytes).
    out.extend_from_slice(format!("--{SIGNED_BOUNDARY}\r\n").as_bytes());
    out.extend_from_slice(inner_entity_with_crlf);
    // Part 2 — the detached signature.
    out.extend_from_slice(format!("--{SIGNED_BOUNDARY}\r\n").as_bytes());
    out.extend_from_slice(
        b"Content-Type: application/pkcs7-signature; name=\"smime.p7s\"\r\n\
          Content-Transfer-Encoding: base64\r\n\
          Content-Disposition: attachment; filename=\"smime.p7s\"\r\n\
          Content-Description: S/MIME Cryptographic Signature\r\n\r\n",
    );
    for chunk in sig_b64.as_bytes().chunks(72) {
        out.extend_from_slice(chunk);
        out.extend_from_slice(b"\r\n");
    }
    out.extend_from_slice(format!("--{SIGNED_BOUNDARY}--\r\n").as_bytes());
    out
}

/// Build an `application/pkcs7-mime` MIME **entity** (headers + blank + base64
/// body, 72-col wrapped). `smime_type` = `"enveloped-data"` (encryption) —
/// `"signed-data"` (opaque signing, unused in 4a but supported).
pub(crate) fn wrap_enveloped(cms_der: &[u8], smime_type: &str) -> Vec<u8> {
    let b64 = base64::engine::general_purpose::STANDARD.encode(cms_der);
    let mut out = Vec::new();
    out.extend_from_slice(
        format!(
            "Content-Type: application/pkcs7-mime; smime-type={smime_type}; name=\"smime.p7m\"\r\n\
             Content-Transfer-Encoding: base64\r\n\
             Content-Disposition: attachment; filename=\"smime.p7m\"\r\n\r\n"
        )
        .as_bytes(),
    );
    for chunk in b64.as_bytes().chunks(72) {
        out.extend_from_slice(chunk);
        out.extend_from_slice(b"\r\n");
    }
    out
}

// ──────────────────────────────────────────────────────────────────────────
// G5 Task 3 — receive orchestrator (`open_crypto_message`)
// ──────────────────────────────────────────────────────────────────────────

/// Result of opening a crypto-marked message. Plaintext fields are IN-MEMORY
/// ONLY — the caller (the Tauri command / G6 UI) renders them; they are NEVER
/// written back to SQLite. Only `crypto_result` (the verification outcome) is
/// persisted (via [`upsert_message_crypto_result`] inside the orchestrator).
///
/// `Serialize` (camelCase) so the `crypto_open_message` Tauri command (G5 T4)
/// can return it across the IPC boundary to the G6 UI. Plaintext crossing IPC
/// is correct — it's in-memory only and the UI renders it; the backend never
/// persists these fields.
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OpenCryptoResult {
    /// Decrypted + (if applicable) signature-verified HTML body, when present.
    pub plaintext_html: Option<String>,
    /// Decrypted + (if applicable) signature-verified text body, when present.
    pub plaintext_text: Option<String>,
    /// Attachments parsed from the decrypted plaintext MIME. Metadata-only
    /// (filename / mime_type / size / content_id / is_inline); the bytes are
    /// not retained in memory beyond the orchestrator call. Callers that need
    /// attachment bytes must persist them separately (G6 carry-forward).
    pub attachments: Vec<ImapAttachment>,
    /// The persisted crypto-verification outcome (decrypt + signature state,
    /// signer identity, chain validity, revocation state). Mirrors the row
    /// written to `message_crypto_results`.
    pub crypto_result: MessageCryptoResultRow,
}

// ──────────────────────────────────────────────────────────────────────────
// Signature details dialog (G6 follow-up): re-parse the cached CMS blob to
// surface signer cert + chain path for a read-only "Signature details…"
// dialog. Pure parse + DB reads — no decrypt, no network. Only `signed`
// (opaque `application/pkcs7-mime; smime-type=signed-data`) and clear-signed
// `multipart/signed` are re-parseable from the persisted CMS columns; for
// `encrypted-signed` the inner SignedData lives in decrypted in-memory-only
// bytes (not persisted), so `signer` is None there and the dialog shows the
// persisted verdict only.
// ──────────────────────────────────────────────────────────────────────────

/// Parsed signer leaf cert details. No DER crosses IPC — only the parsed
/// fields the dialog renders. `fingerprint` mirrors the persisted
/// `MessageCryptoResultRow.signer_fingerprint` (re-attached here so the dialog
/// has one self-contained record).
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SignerCertDetails {
    pub subject_cn: Option<String>,
    pub issuer_cn: Option<String>,
    pub serial_hex: String,
    pub fingerprint: String,
    pub not_before_unix: i64,
    pub not_after_unix: i64,
    /// Dotted OID string of the signer cert's SubjectPublicKeyInfo algorithm
    /// (e.g. `1.2.840.10045.2.1` for ECDSA-P256). The frontend maps to a label.
    pub public_key_algorithm_oid: String,
    /// Dotted OID string of the CMS `SignerInfo.signatureAlgorithm` (the
    /// algorithm used to produce the signature, e.g.
    /// `1.2.840.10045.4.3.2` for ecdsa-with-SHA256).
    pub signature_algorithm_oid: String,
    pub signing_time_unix: Option<i64>,
}

/// One entry in the certification path (intermediate or anchor). Parsed CNs
/// only; `is_anchor` flags entries from the account's imported trust-anchor set.
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChainPathEntry {
    pub subject_cn: Option<String>,
    pub issuer_cn: Option<String>,
    pub is_anchor: bool,
}

/// Full signer + verification record for the "Signature details…" dialog.
/// Re-derived by [`get_signer_details`] on dialog open. The persisted verdict
/// (`signature_state` / `chain_valid` / `revocation_state` / `verified_at`)
/// is the authoritative outcome from `open_crypto_message` open-time (which
/// had CRLs); we deliberately do NOT re-run chain validation here (without
/// fresh CRLs it would mis-report revocation as `unchecked`).
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SignerDetails {
    pub signature_state: String,
    pub decrypt_state: String,
    pub crypto_kind: String,
    /// Persisted nullable INTEGER → `Option<bool>`. `None` = unchecked.
    pub chain_valid: Option<bool>,
    pub revocation_state: String,
    pub verified_at: String,
    /// Re-resolved via [`resolve_signer_trust`] at dialog time (reflects any
    /// trust_decision written since the message was opened).
    pub trust_state: String,
    /// `None` for `encrypted-signed` (no re-parseable SignedData in the DB).
    pub signer: Option<SignerCertDetails>,
    pub chain_path: Vec<ChainPathEntry>,
    /// Persisted granular `ChainOutcome.failure_reason` (surfaced via
    /// `VerificationResult.failure_reason` → `message_crypto_results.failure_reason`).
    /// Falls back to the coarse `failure_reason_for_state` fixed map when the
    /// persisted column is NULL (pre-migration rows, the UnknownKey / sig-fail
    /// early-return arms, and all success states).
    pub failure_reason: Option<String>,
    /// Structured RFC 5280 §5.3.1 CRLReason name (e.g. `"KeyCompromise"`)
    /// when `revocation_state = 'revoked'` and the CRL entry carried a
    /// reasonCode extension. `None` for every other outcome. Surfaced from
    /// `VerificationResult.revocation_reason` →
    /// `message_crypto_results.revocation_reason` (2026-07-18 CRL-revocation-
    /// detail spec decision #4). Rendered as a distinct "Reason: <name>" line
    /// by the dialog (NOT buried inside `failure_reason`).
    pub revocation_reason: Option<String>,
}

/// Build a per-call [`SmimeBackend`] bound to `account_id`. Mirrors the helper
/// in `db/commands.rs:1356` — same construction pattern as `send_op`
/// (`engine.rs:1011`). `SqliteKeyStore` is not `Clone` but its constructor is
/// cheap (`Arc<SqlitePool>` bump + `String` clone), so we build one per call.
fn smime_backend(pool: &SqlitePool, account_id: &str) -> SmimeBackend {
    SmimeBackend::new(
        std::sync::Arc::new(SqliteKeyStore::new(
            std::sync::Arc::new(pool.clone()),
            account_id,
        )),
        crypto_core::CryptoPolicy::default_baseline(),
    )
}

/// Resolve a signer's [`TrustState`] for `verify_with_context`.
///
/// - If the signer fingerprint matches one of the account's OWN private keys
///   (encrypt-to-self / sent-to-self) → [`TrustState::Personal`].
/// - Otherwise look up the latest trust_decision for
///   `(account_id, signer_email, 'smime', fingerprint)` and map its lowercase
///   string to `TrustState`.
/// - Default [`TrustState::Undecided`] when no decision exists.
///
/// Detection of "our own key" is by checking the account's private keys
/// (`has_private=true`) — NOT by inspecting the anchor set. This is the
/// resolution to the `key_type='cert'` quirk flagged in T2: the anchor set
/// (returned by `list_trust_anchor_certs`) is filtered to `key_type='cert'`,
/// but `keystore_bridge::put` hardcodes `key_type='cert'` for ALL keys incl.
/// private signing keys, so the anchor set may include our own signing cert.
/// That's harmless for anchor-set use (an extra self-signed anchor just won't
/// match an external signer's chain); but for signer_trust detection we look
/// directly at `has_private`, which is unambiguous.
pub(crate) async fn resolve_signer_trust(
    pool: &SqlitePool,
    account_id: &str,
    signer_fingerprint: Option<&str>,
    signer_email: Option<&str>,
) -> TrustState {
    // (a) "Our own key" → Personal. Detected via `has_private` (the account's
    // private-key rows), NOT via the anchor set.
    if let Some(fp) = signer_fingerprint {
        if let Ok(keys) = list_crypto_keys_for_account(pool, account_id, "smime").await {
            for key in &keys {
                if key.has_private && key.fingerprint == fp {
                    return TrustState::Personal;
                }
            }
        }
    }

    // (b) Stored trust decision for (account_id, signer_email, 'smime', fp).
    if let (Some(email), Some(fp)) = (signer_email, signer_fingerprint) {
        if let Ok(Some(decision)) =
            get_latest_trust_decision(pool, account_id, email, "smime", fp).await
        {
            // trust_decisions.decision is lowercase (matches TrustState serde).
            return match decision.decision.as_str() {
                "rejected" => TrustState::Rejected,
                "undecided" => TrustState::Undecided,
                "unverified" => TrustState::Unverified,
                "verified" => TrustState::Verified,
                "personal" => TrustState::Personal,
                _ => TrustState::Undecided,
            };
        }
    }

    // (c) Default — no stored decision.
    TrustState::Undecided
}

/// Extract cRLDistributionPoints URLs from a cert via `x509-parser` (OID
/// `2.5.29.31`). Returns URLs in encounter order. Returns an empty Vec on
/// parse failure (soft — a malformed cert should not brick verification).
fn extract_crl_distribution_points(cert_der: &[u8]) -> Vec<String> {
    let (_rem, cert) = match x509_parser::parse_x509_certificate(cert_der) {
        Ok(r) => r,
        Err(_) => return Vec::new(),
    };
    let mut urls = Vec::new();
    for ext in cert.iter_extensions() {
        if let x509_parser::extensions::ParsedExtension::CRLDistributionPoints(cdps) =
            ext.parsed_extension()
        {
            for point in cdps.points.iter() {
                if let Some(x509_parser::extensions::DistributionPointName::FullName(names)) =
                    &point.distribution_point
                {
                    for gn in names {
                        if let x509_parser::extensions::GeneralName::URI(url) = gn {
                            urls.push((*url).to_string());
                        }
                    }
                }
            }
        }
    }
    urls
}

/// Collect CRL DERs for a set of certs (signer + intermediates). Extracts
/// cRLDistributionPoints URLs from each cert via `x509-parser`, then
/// `fetch_crl_cached` per URL (soft-fail on transport error — a network
/// failure returns `None`, which the caller treats as `RevocationState::Unchecked`).
///
/// The `reqwest::Client` is supplied by the caller — the orchestrator builds it
/// ONCE with a 30s timeout (G4 landmine #1: a hung CRL server would otherwise
/// block forever; the fetcher's soft-fail only fires on `Err`, not on a hung
/// `await`). Same client is reused for every URL.
async fn resolve_crls(
    pool: &SqlitePool,
    client: &reqwest::Client,
    cert_ders: &[Vec<u8>],
) -> Vec<Vec<u8>> {
    let mut crls = Vec::new();
    for cert_der in cert_ders {
        for url in extract_crl_distribution_points(cert_der) {
            if let Some(der) = fetch_crl_cached(pool, client, &url).await {
                crls.push(der);
            }
        }
    }
    crls
}

/// Build the row for `message_crypto_results` from the decrypt + signature
/// verdicts. `chain_valid` + `revocation_state` are inferred coarsely from the
/// `SignatureState`; `failure_reason` is the granular reason surfaced from
/// `ChainOutcome.failure_reason` via `VerificationResult.failure_reason` by
/// `SmimeBackend::verify_with_context` (None on the early-return arms and on
/// success states); `revocation_reason` is the structured RFC 5280 CRLReason
/// name from `ChainOutcome.revocation_reason` via
/// `VerificationResult.revocation_reason` (Some(<name>) only on a revoked-cert
/// hard-fail; None for every other outcome). The orchestrator threads them in
/// here.
#[allow(clippy::too_many_arguments)] // row-builder; bundling adds ceremony without clarity
fn build_crypto_result_row(
    account_id: &str,
    message_id: &str,
    crypto_kind: &str,
    decrypt_state: &str,
    signature_state: SignatureState,
    signer_fingerprint: Option<String>,
    signer_email: Option<String>,
    failure_reason: Option<String>,
    revocation_reason: Option<String>,
) -> MessageCryptoResultRow {
    let sig_str = match signature_state {
        SignatureState::NotSigned => "not-signed",
        SignatureState::ValidVerified => "valid-verified",
        SignatureState::ValidUnverified => "valid-unverified",
        SignatureState::Invalid => "invalid",
        SignatureState::UnknownKey => "unknown-key",
        SignatureState::Mismatch => "mismatch",
    };
    // Coarse chain/revocation inference from the SignatureState. The granular
    // ChainOutcome.failure_reason + .revocation_reason are threaded through
    // their own columns (2026-07-18 specs); the coarse `revocation_state`
    // remains an inference from the SignatureState. When a revoked-cert
    // outcome reaches this builder, the caller (run_verify_path →
    // finish_open_crypto) supplies the granular `revocation_reason` too; the
    // coarse state is "unchecked" because the Invalid SignatureState does not
    // distinguish revocation vs. other chain failures.
    let (chain_valid, revocation_state) = match signature_state {
        SignatureState::ValidVerified
        | SignatureState::ValidUnverified
        | SignatureState::Mismatch => (Some(1), "good"),
        SignatureState::Invalid => (Some(0), "unchecked"),
        SignatureState::UnknownKey | SignatureState::NotSigned => (None, "unchecked"),
    };
    MessageCryptoResultRow {
        account_id: account_id.to_string(),
        message_id: message_id.to_string(),
        crypto_kind: crypto_kind.to_string(),
        decrypt_state: decrypt_state.to_string(),
        signature_state: sig_str.to_string(),
        signer_fingerprint,
        signer_email,
        chain_valid,
        revocation_state: revocation_state.to_string(),
        verified_at: std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_secs().to_string())
            .unwrap_or_else(|_| "0".to_string()),
        failure_reason,
        revocation_reason,
    }
}

/// Extract the encapsulated content (eContent) bytes from a SignedData DER.
/// Returns `None` when the content is absent (detached signature) or
/// unparseable. The bytes are the plaintext MIME that was signed — the
/// orchestrator parses them into html/text/attachments.
fn extract_signed_data_econtent(signed_data_der: &[u8]) -> Option<Vec<u8>> {
    let ci = ContentInfo::from_der(signed_data_der).ok()?;
    let inner = ci.content.to_der().ok()?;
    let sd = cms::signed_data::SignedData::from_der(&inner).ok()?;
    sd.encap_content_info
        .econtent
        .as_ref()
        .map(|any| any.value().to_vec())
}

/// Detect whether a CMS blob is id-signed-data (`application/pkcs7-mime;
/// smime-type=signed-data`). Used by the decrypt path to decide whether to
/// recurse into the verify path on the decrypted bytes.
fn is_signed_data(der: &[u8]) -> bool {
    let Ok(ci) = ContentInfo::from_der(der) else {
        return false;
    };
    ci.content_type == const_oid::db::rfc5911::ID_SIGNED_DATA
}

/// Merge two intermediate-cert sets, deduping by fingerprint. The
/// [`run_verify_path`] receiver concatenates the SignedData-embedded
/// intermediates (the sender's intent) with the receiver's stored
/// `crypto_keys.key_type='intermediate'` rows (the `.p12`-imported CA cache)
/// so a chain needing a stored intermediate validates. Without dedup a cert
/// present in both sets would be passed twice — harmless for path validation,
/// but wasteful and would distort the CRL fetch list.
///
/// Dedup key: SHA-1-of-SPKI hex via [`crypto_smime::fingerprint_of_cert_der`]
/// — the SAME computation `persist_imported` / `generate_key` use for the
/// leaf's `Fingerprint` and `upsert_intermediate_cert` uses for the
/// `(account_id, standard, fingerprint)` UNIQUE key. A cert whose fingerprint
/// cannot be computed is logged + skipped (the soft-fail discipline).
///
/// Order is preserved: SignedData intermediates first, then stored
/// intermediates not already present.
fn merge_intermediates_by_fingerprint(
    signed_data_intermediates: Vec<Vec<u8>>,
    stored_intermediates: Vec<Vec<u8>>,
) -> Vec<Vec<u8>> {
    let mut seen: std::collections::HashSet<String> = std::collections::HashSet::new();
    let mut merged: Vec<Vec<u8>> =
        Vec::with_capacity(signed_data_intermediates.len() + stored_intermediates.len());
    for der in signed_data_intermediates
        .iter()
        .chain(stored_intermediates.iter())
    {
        let fp = match crypto_smime::fingerprint_of_cert_der(der) {
            Ok(fp) => fp,
            Err(e) => {
                log::warn!(
                    "[crypto] intermediate fingerprint compute failed during merge; skipping: {e}"
                );
                continue;
            }
        };
        if seen.insert(fp) {
            merged.push(der.clone());
        }
    }
    merged
}

/// Run the verify path on a SignedData DER blob. Returns the plaintext MIME
/// bytes (the SignedData's encapsulated content, when present) + the
/// resolved `SignatureState`.
///
/// Inputs:
/// - `signed_data_der`: the DER bytes of the outer ContentInfo (id-signed-data).
/// - `from_email`: the RFC 5322 `From:` address for SAN binding (identity check).
/// - `covered_content`: `Some(bytes)` for a **detached** signature (a
///   `multipart/signed` clear-signed mail — the externally-supplied part-1
///   MIME entity bytes that the detached `.p7s` covers); `None` for an
///   **encapsulated** signature (opaque `application/pkcs7-mime;
///   smime-type=signed-data` — the payload lives inside the SignedData's
///   `encapContent.eContent` and `verify_signed` reads it directly).
///
/// Builds the `SignedEnvelope` (signature DER = SignedData; payload = covered
/// content when detached, empty otherwise), resolves trust anchors +
/// intermediates + CRLs + signer trust, then calls
/// `SmimeBackend::verify_with_context`.
async fn run_verify_path(
    backend: &SmimeBackend,
    pool: &SqlitePool,
    client: &reqwest::Client,
    account_id: &str,
    signed_data_der: &[u8],
    from_email: Option<&str>,
    covered_content: Option<&[u8]>,
) -> Result<VerifyOutcome, String> {
    // Intermediates from the SignedData certificates set (excludes the signer leaf).
    let signed_data_intermediates = crypto_smime::extract_intermediates(signed_data_der)
        .map_err(|e| format!("extract_intermediates: {e}"))?;

    // Stored intermediates: every `crypto_keys` row this account has with
    // `key_type='intermediate'` (persisted from a `.p12` bag's non-leaf chain
    // certs on import — see `upsert_intermediate_cert`). Soft-fail on DB
    // error: a query failure must NOT block message open; we proceed with
    // the SignedData intermediates only.
    let stored_intermediates = match list_intermediate_certs(pool, account_id).await {
        Ok(v) => v,
        Err(e) => {
            log::warn!(
                "[crypto] list_intermediate_certs failed for account {account_id}; \
                 proceeding with SignedData intermediates only: {e}"
            );
            Vec::new()
        }
    };

    // Merge the two intermediate sets, deduping by fingerprint (SHA-1-of-SPKI
    // hex via `crypto_smime::fingerprint_of_cert_der` — the SAME computation
    // the leaf's `persist_imported` uses, so a cert present in both sets is
    // passed to `verify_with_context` exactly once). The merge is order-
    // preserving: SignedData intermediates first (the sender's intent), then
    // stored intermediates not already present (the receiver's CA cache).
    // Errors computing a fingerprint are logged + the cert is skipped (one bad
    // cert must not break the chain — the soft-fail discipline established by
    // `list_intermediate_certs`'s hex-decode skip).
    let intermediates =
        merge_intermediates_by_fingerprint(signed_data_intermediates, stored_intermediates);

    // Trust anchors (user-imported CA roots for this account).
    let anchors = list_trust_anchor_certs(pool, account_id).await?;

    // Pre-parse the SignedData to extract the signer fingerprint + email (needed
    // for resolve_signer_trust BEFORE we have the VerificationResult). We run
    // a pre-chain verify here to get the signer fingerprint without duplicating
    // the chain logic; verify_with_context re-runs it with the full context.
    // The signer_email for trust-decision lookup comes from the message's
    // From header (the only sender identity we have for a received message).
    let signer_email_for_trust = from_email.map(|s| s.to_string());

    // The payload for the SignedEnvelope: the covered content for detached
    // signatures (passed through to `verify_signed` which uses it ONLY when the
    // SignedData has no eContent), or empty bytes for encapsulated
    // (verify_signed reads eContent itself).
    let signed = SignedEnvelope {
        standard: Standard::Smime,
        payload: covered_content.unwrap_or(&[]).to_vec(),
        signature: crypto_core::DetachedSignature {
            standard: Standard::Smime,
            signer: KeyHandleRef {
                handle: KeyHandle::Software(KeyId(String::new())),
                standard: Standard::Smime,
                fingerprint: Fingerprint::new(""),
                usage: KeyUsage::SignAndEncrypt,
                algorithm: "ECDSA-P256".into(),
            },
            signature: signed_data_der.to_vec(),
        },
    };

    // To resolve signer_trust we need the signer fingerprint BEFORE calling
    // verify_with_context. Run a pre-chain verify via the trait method (cheap;
    // no chain validation) to extract it. If the pre-check fails (no signer
    // cert), we pass Undecided as the trust; verify_with_context will surface
    // UnknownKey anyway.
    let pre_check = backend
        .verify(crypto_core::VerifyOp { signed: &signed })
        .await
        .map_err(|e| format!("pre-chain verify: {e}"))?;
    let signer_fp: Option<String> = pre_check
        .signer
        .as_ref()
        .map(|s| s.fingerprint.as_str().to_string());

    // Resolve signer trust. signer_email_for_trust is the From header (the
    // trust_decisions table is keyed on peer_email = the sender's email).
    let signer_trust = resolve_signer_trust(
        pool,
        account_id,
        signer_fp.as_deref(),
        signer_email_for_trust.as_deref(),
    )
    .await;

    // Resolve CRLs from the signer + intermediates. The signer cert DER is
    // extracted by verify_with_context internally; we surface it here by
    // re-parsing the SignedData. If that fails, fall back to using just the
    // intermediates.
    let mut crl_cert_ders = intermediates.clone();
    if let Ok(sci) = ContentInfo::from_der(signed_data_der) {
        if let Ok(sinner) = sci.content.to_der() {
            if let Ok(ssd) = cms::signed_data::SignedData::from_der(&sinner) {
                // Extract the signer leaf for CDP extraction.
                if let Some(cert_set) = ssd.certificates.as_ref() {
                    if let Some(first_signer_info) = ssd.signer_infos.0.get(0) {
                        for choice in cert_set.0.iter() {
                            if let cms::cert::CertificateChoices::Certificate(c) = choice {
                                // Quick SID match (IssuerAndSerialNumber): compare
                                // issuer + serial against the first signer info.
                                let tbs = c.tbs_certificate();
                                let candidate_iasn = cms::cert::IssuerAndSerialNumber {
                                    issuer: tbs.issuer().clone(),
                                    serial_number: tbs.serial_number().clone(),
                                };
                                if let cms::signed_data::SignerIdentifier::IssuerAndSerialNumber(
                                    ref target,
                                ) = first_signer_info.sid
                                {
                                    if &candidate_iasn == target {
                                        if let Ok(der) = c.to_der() {
                                            crl_cert_ders.insert(0, der);
                                        }
                                        break;
                                    }
                                }
                            }
                        }
                    }
                }
            }
        }
    }
    let crls = resolve_crls(pool, client, &crl_cert_ders).await;

    // Final verify with full context.
    let result = backend
        .verify_with_context(
            &signed,
            from_email,
            &anchors,
            &intermediates,
            &crls,
            signer_trust,
        )
        .await
        .map_err(|e| format!("verify_with_context: {e}"))?;

    // Extract the plaintext MIME. For encapsulated SignedData the eContent IS
    // the plaintext MIME (read it out of the DER). For detached signatures
    // (`multipart/signed` clear-signed) the SignedData has no eContent and
    // the plaintext IS the externally-supplied covered content — return it
    // directly. `run_verify_path` callers therefore always get back the
    // plaintext MIME bytes regardless of detached vs encapsulated shape.
    let plaintext = covered_content
        .map(|cc| cc.to_vec())
        .or_else(|| extract_signed_data_econtent(signed_data_der));

    let final_signer_fp = result
        .signer
        .as_ref()
        .map(|s| s.fingerprint.as_str().to_string())
        .or(signer_fp);
    Ok(VerifyOutcome {
        plaintext,
        signature_state: result.state,
        signer_fp: final_signer_fp,
        signer_email: signer_email_for_trust,
        // Granular ChainOutcome.failure_reason (2026-07-18 granular-chain-outcome
        // spec) — surfaced via `VerificationResult.failure_reason` by
        // `verify_with_context`. None on the early-return arms (UnknownKey,
        // sig-fail Invalid) and on success states; the real reason on chain
        // failures + Mismatch.
        failure_reason: result.failure_reason,
        // Structured RFC 5280 CRLReason (2026-07-18 CRL-revocation-detail spec)
        // — surfaced via `VerificationResult.revocation_reason` by
        // `verify_with_context`. Some(<name>) only on a revoked-cert hard-fail;
        // None for every other outcome.
        revocation_reason: result.revocation_reason,
    })
}

/// Outcome of [`run_verify_path`]: the values the orchestrator needs from a
/// verify-path run. Introduced (2026-07-18 CRL-revocation-detail spec) to
/// replace the prior 5-tuple return — adding `revocation_reason` would have
/// pushed the tuple to a 6-tuple smell (flagged by the controller), and the
/// struct shape is the documented future-ideal. Field names mirror the
/// `build_crypto_result_row` / `finish_open_crypto` args so the threading
/// reads cleanly at the call sites.
struct VerifyOutcome {
    /// Plaintext MIME bytes (SignedData eContent for encapsulated; the
    /// externally-supplied covered content for detached).
    plaintext: Option<Vec<u8>>,
    /// Final resolved signature state (Invalid / Mismatch / ValidVerified /
    /// ValidUnverified / UnknownKey).
    signature_state: SignatureState,
    /// Signer cert fingerprint, when one was located.
    signer_fp: Option<String>,
    /// Signer email (the From header), for trust-decision lookup + UI display.
    signer_email: Option<String>,
    /// Granular `ChainOutcome.failure_reason` surfaced via
    /// `VerificationResult.failure_reason`.
    failure_reason: Option<String>,
    /// Structured RFC 5280 CRLReason name surfaced via
    /// `VerificationResult.revocation_reason`. `Some(<name>)` only when the
    /// verification hard-failed because the CRL listed the cert as revoked.
    revocation_reason: Option<String>,
}

/// Open a crypto-marked message: decrypt + (if signed) verify it. Returns the
/// plaintext (in-memory, never persisted) + a persisted
/// `message_crypto_results` row capturing the verification outcome.
///
/// # Flow (spec §3.1)
///
/// 1. Load `messages.from_address` + `message_bodies.body_mime_ciphertext`.
///    If no ciphertext → `Err` (the message isn't crypto-marked or wasn't
///    fetched).
/// 2. Parse the CMS blob (`ContentInfo::from_der`) → branch on the content OID:
///    - id-enveloped-data → decrypt path (step 3).
///    - id-signed-data → opaque-signed verify path (step 4).
/// 3. **Decrypt:** iterate the account's S/MIME private keys (those with
///    `has_private=true`) and try `backend.decrypt` with each. If none match
///    → `decrypt_state=no-key`. If the decrypted bytes are themselves a
///    SignedData (`id-signed-data`), recurse into the verify path (the
///    sign-then-encrypt send-side composition).
/// 4. **Verify:** resolve trust anchors + intermediates + CRLs + signer trust
///    + from_email, call `verify_with_context` → `SignatureState`.
/// 5. Parse the final plaintext MIME → html/text/attachments.
/// 6. Upsert `message_crypto_results` (the verification outcome only —
///    plaintext is in-memory).
/// 7. Return `OpenCryptoResult`.
///
/// Plaintext is MEMORY-ONLY — it is never written back to SQLite by this
/// function. Only the `message_crypto_results` row (the verification outcome)
/// is persisted.
/// Outcome of dispatching over a crypto-marked message: the decrypted
/// plaintext MIME bytes (when recoverable) + the
/// `(crypto_kind, decrypt_state, signature_state, signer_*, failure_reason,
/// revocation_reason)` tuple each branch produces. Pure computation — no
/// `message_crypto_results` upsert, no `OpenCryptoResult` construction.
///
/// Produced by [`decrypt_message_with_outcome`] and consumed by two callers:
///   - [`open_crypto_message`] persists the tuple via [`finish_open_crypto`]
///     and returns an `OpenCryptoResult`.
///   - [`decrypt_message_mime_bytes`] extracts just `plaintext_mime` for
///     Task 2's `crypto_fetch_attachment` / `crypto_fetch_inline_images`
///     commands, which re-decrypt to extract attachment bytes without
///     re-running the orchestrator's persist + IPC-result shaping.
///
/// The early-return `no-ciphertext` and `no-key` cases are folded into this
/// outcome as `decrypt_state="failed"` / `"no-key"` with `plaintext_mime=None`
/// — `finish_open_crypto` then upserts the same row the inline paths used to
/// upsert directly, so the persisted `MessageCryptoResultRow` is unchanged.
struct CryptoOutcome {
    plaintext_mime: Option<Vec<u8>>,
    crypto_kind: &'static str,
    decrypt_state: &'static str,
    signature_state: SignatureState,
    signer_fp: Option<String>,
    signer_email: Option<String>,
    failure_reason: Option<String>,
    revocation_reason: Option<String>,
}

/// Dispatch over a crypto-marked message: fetch ciphertext + signed_part +
/// From header, build the per-call [`SmimeBackend`] + reqwest client, and
/// branch on clear-signed / enveloped / opaque-signed / no-ciphertext /
/// no-key. Returns the [`CryptoOutcome`] (plaintext bytes + the tuple each
/// branch produces).
///
/// This is the pure-decrypt helper extracted (behavior-preserving) from
/// `open_crypto_message`'s `:878-1176` dispatch arm. It does NOT upsert
/// `message_crypto_results` and does NOT build an `OpenCryptoResult` — both
/// are the caller's job (`finish_open_crypto` for the orchestrator; a thin
/// `.plaintext_mime` projection for `decrypt_message_mime_bytes`).
///
/// Branch order (must match the pre-refactor orchestrator):
/// 1. clear-signed (`multipart/signed`): both `signed_part` AND `ciphertext`
///    present → detached verify, plaintext = part-1 bytes.
/// 2. no-ciphertext: `ciphertext=None` (regardless of `signed_part`) →
///    outcome `("encrypted", "failed", NotSigned, …)` with no plaintext.
/// 3. enveloped-data: decrypt via the backend key loop; on no matching key,
///    outcome `("encrypted", "no-key", NotSigned, …)`. On decrypt OK, recurse
///    into `run_verify_path` when the inner is itself a SignedData
///    (sign-then-encrypt) → `("encrypted-signed", "ok", <state>, …)`;
///    otherwise plaintext MIME → `("encrypted", "ok", NotSigned, …)`.
/// 4. opaque signed-data: `run_verify_path` → `("signed", "n/a", <state>, …)`.
/// 5. otherwise: hard `Err` (unsupported CMS content type).
async fn decrypt_message_with_outcome(
    pool: &SqlitePool,
    account_id: &str,
    message_id: &str,
) -> Result<CryptoOutcome, String> {
    // Step 1: load ciphertext + From header + (Plan 5 / G7) signed_part.
    let ciphertext = get_message_ciphertext(pool, account_id, message_id).await?;
    let signed_part = get_message_signed_part(pool, account_id, message_id).await?;
    log::info!(
        "[crypto] decrypt_message_with_outcome: account={account_id} msg={message_id} \
         ciphertext_len={} signed_part_len={}",
        ciphertext.as_ref().map(|c| c.len()).unwrap_or(0),
        signed_part.as_ref().map(|s| s.len()).unwrap_or(0),
    );

    // messages.from_address — the RFC 5322 From: used for SAN identity binding
    // + the trust_decisions peer_email lookup. NULL when the column is NULL
    // (partially-migrated rows); verify_with_context treats None as "skip
    // identity binding".
    let from_address: Option<String> =
        sqlx::query_scalar("SELECT from_address FROM messages WHERE account_id = ? AND id = ?")
            .bind(account_id)
            .bind(message_id)
            .fetch_optional(pool)
            .await
            .map_err(|e| e.to_string())?
            .flatten();

    // G4 landmine #1: build the reqwest::Client ONCE with a 30s timeout so a
    // hung CRL server cannot block the orchestrator indefinitely.
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(30))
        .build()
        .map_err(|e| format!("build reqwest client: {e}"))?;

    // Per-call SmimeBackend (not Clone — constructed fresh; cheap).
    let backend = smime_backend(pool, account_id);

    // ── Plan 5 / G7 Task 2: clear-signed `multipart/signed` branch ───────
    //
    // When the message is clear-signed, `signed_part` carries the raw part-1
    // MIME entity bytes (the bytes the detached `.p7s` covers) and
    // `ciphertext` carries the `.p7s` SignedData DER (a detached CMS blob).
    // The branch runs `run_verify_path` in detached mode
    // (`covered_content = Some(part1)`) and uses the part-1 bytes as the
    // plaintext (clear-signed mail's body IS already plaintext — no decrypt
    // step). Falls through to the existing pkcs7-mime path when `signed_part`
    // is None.
    if let (Some(part1_bytes), Some(p7s_der)) = (signed_part.as_deref(), ciphertext.as_deref()) {
        let covered = part1_bytes.to_vec();
        let outcome = run_verify_path(
            &backend,
            pool,
            &client,
            account_id,
            p7s_der,
            from_address.as_deref(),
            Some(&covered),
        )
        .await?;
        // `plaintext` is `covered` itself (detached: no eContent) — but use
        // the value returned by run_verify_path for clarity.
        let plaintext_mime = outcome.plaintext.or(Some(covered));
        return Ok(CryptoOutcome {
            plaintext_mime,
            crypto_kind: "signed",
            decrypt_state: "n/a",
            signature_state: outcome.signature_state,
            signer_fp: outcome.signer_fp,
            signer_email: outcome.signer_email,
            failure_reason: outcome.failure_reason,
            revocation_reason: outcome.revocation_reason,
        });
    }

    // Existing opaque pkcs7-mime path.
    let ciphertext = match ciphertext {
        Some(c) => c,
        None => {
            // No ciphertext AND no signed_part → fold into a Failed outcome
            // (no plaintext). `finish_open_crypto` upserts the same row the
            // inline path used to upsert directly — behavior preserved.
            return Ok(CryptoOutcome {
                plaintext_mime: None,
                crypto_kind: "encrypted",
                decrypt_state: "failed",
                signature_state: SignatureState::NotSigned,
                signer_fp: None,
                signer_email: None,
                failure_reason: None,
                revocation_reason: None,
            });
        }
    };

    // Step 2: parse the CMS blob to dispatch on its content type.
    let ci = ContentInfo::from_der(&ciphertext).map_err(|e| format!("parse ContentInfo: {e}"))?;

    let is_enveloped = ci.content_type == const_oid::db::rfc5911::ID_ENVELOPED_DATA;
    let is_signed = ci.content_type == const_oid::db::rfc5911::ID_SIGNED_DATA;
    log::info!(
        "[crypto] ContentInfo parsed: content_type_oid={:?} is_enveloped={is_enveloped} is_signed={is_signed}",
        ci.content_type
    );

    if is_enveloped {
        // Step 3: decrypt path.
        let keys = list_crypto_keys_for_account(pool, account_id, "smime")
            .await
            .map_err(|e| format!("list account keys: {e}"))?;
        let priv_keys: Vec<_> = keys.iter().filter(|k| k.has_private).collect();
        log::info!(
            "[crypto] enveloped: {} total key(s), {} with private material; trying each",
            keys.len(),
            priv_keys.len()
        );

        // Build the EncryptedEnvelope ONCE outside the key loop — only the
        // decryption KeyHandleRef changes per iteration.
        let env = EncryptedEnvelope {
            standard: Standard::Smime,
            serialization: SerializationStrategy::SingleMimeBlob,
            parts: vec![EncryptedPart {
                id: PartId("body".into()),
                kind: PartKind::Body,
                ciphertext: ciphertext.clone(),
                signature: None,
            }],
            recipients: Vec::new(),
        };

        let mut decrypted: Option<Vec<u8>> = None;
        for key_row in &priv_keys {
            // Build the decryption KeyHandleRef. KeyId encoding matches
            // SqliteKeyStore::encode_key_id (`standard|fingerprint`). The
            // algorithm field is not load-bearing for decrypt (the keystore
            // resolves the real algorithm via policy_json on get()).
            let decryption_key = KeyHandleRef {
                handle: KeyHandle::Software(KeyId(format!("smime|{}", key_row.fingerprint))),
                standard: Standard::Smime,
                fingerprint: Fingerprint::new(&key_row.fingerprint),
                usage: KeyUsage::SignAndEncrypt,
                algorithm: "ECDSA-P256".into(),
            };
            let op = DecryptOp {
                envelope: &env,
                decryption_key,
            };
            match backend.decrypt(op).await {
                Ok(payload) => {
                    // S/MIME collapses the MIME tree into one part.
                    if let Some(part) = payload.parts.into_iter().next() {
                        log::info!(
                            "[crypto] decrypt OK with key fp={} ({} bytes plaintext)",
                            key_row.fingerprint,
                            part.data.len()
                        );
                        decrypted = Some(part.data);
                        break;
                    }
                    log::warn!(
                        "[crypto] decrypt returned Ok but no part for key fp={}",
                        key_row.fingerprint
                    );
                }
                Err(e) => {
                    // Log the ACTUAL error so a genuine decrypt failure is
                    // distinguishable from "not encrypted to this key". The
                    // orchestrator treats both as "try the next key", but the
                    // surface symptom (no-key) is identical either way —
                    // without this log the root cause is invisible.
                    log::warn!(
                        "[crypto] decrypt FAILED for key fp={}: {} ({:?})",
                        key_row.fingerprint,
                        e,
                        e
                    );
                    continue;
                }
            }
        }

        let Some(inner_bytes) = decrypted else {
            // No matching decryption key → fold into a no-key outcome (no
            // plaintext). `finish_open_crypto` upserts the same row the inline
            // path used to upsert directly — behavior preserved.
            log::warn!(
                "[crypto] no matching key → no-key (all {} private key(s) errored or no recipient matched)",
                priv_keys.len()
            );
            return Ok(CryptoOutcome {
                plaintext_mime: None,
                crypto_kind: "encrypted",
                decrypt_state: "no-key",
                signature_state: SignatureState::NotSigned,
                signer_fp: None,
                signer_email: None,
                failure_reason: None,
                revocation_reason: None,
            });
        };

        // Step 3c: if the inner is itself a SignedData (sign-then-encrypt
        // send-side composition), recurse into the verify path.
        if is_signed_data(&inner_bytes) {
            let outcome = run_verify_path(
                &backend,
                pool,
                &client,
                account_id,
                &inner_bytes,
                from_address.as_deref(),
                None, // encapsulated (eContent inside the SignedData)
            )
            .await?;
            Ok(CryptoOutcome {
                plaintext_mime: outcome.plaintext,
                crypto_kind: "encrypted-signed",
                decrypt_state: "ok",
                signature_state: outcome.signature_state,
                signer_fp: outcome.signer_fp,
                signer_email: outcome.signer_email,
                failure_reason: outcome.failure_reason,
                revocation_reason: outcome.revocation_reason,
            })
        } else {
            // Plaintext MIME — no inner signature.
            Ok(CryptoOutcome {
                plaintext_mime: Some(inner_bytes),
                crypto_kind: "encrypted",
                decrypt_state: "ok",
                signature_state: SignatureState::NotSigned,
                signer_fp: None,
                signer_email: None,
                failure_reason: None,
                revocation_reason: None,
            })
        }
    } else if is_signed {
        // Step 4: opaque-signed verify path (no decryption).
        let outcome = run_verify_path(
            &backend,
            pool,
            &client,
            account_id,
            &ciphertext,
            from_address.as_deref(),
            None, // encapsulated (eContent inside the SignedData)
        )
        .await?;
        Ok(CryptoOutcome {
            plaintext_mime: outcome.plaintext,
            crypto_kind: "signed",
            decrypt_state: "n/a",
            signature_state: outcome.signature_state,
            signer_fp: outcome.signer_fp,
            signer_email: outcome.signer_email,
            failure_reason: outcome.failure_reason,
            revocation_reason: outcome.revocation_reason,
        })
    } else {
        Err(format!(
            "decrypt_message_with_outcome: unsupported CMS content type OID: {}",
            ci.content_type
        ))
    }
}

/// Re-decrypt an already-persisted crypto message to recover the plaintext
/// MIME bytes (without running the orchestrator's persist + IPC-result
/// shaping). Consumed by Task 2's `crypto_fetch_attachment` /
/// `crypto_fetch_inline_images` commands, which extract attachment bytes the
/// receive-side `open_crypto_message` orchestrator does not retain in memory.
///
/// Branch behavior matches [`open_crypto_message`] — the same dispatch
/// (clear-signed / enveloped / opaque-signed / no-ciphertext / no-key) runs
/// — but only the plaintext bytes are returned:
///   - clear-signed: the part-1 MIME entity bytes.
///   - enveloped + decrypt OK: the recovered inner MIME (possibly from
///     `run_verify_path` when the inner is itself a SignedData).
///   - opaque-signed: the encapsulated eContent (from `run_verify_path`).
///   - no-ciphertext / no-key / not-signed-inside: `Ok(None)`.
pub(crate) async fn decrypt_message_mime_bytes(
    pool: &SqlitePool,
    account_id: &str,
    message_id: &str,
) -> Result<Option<Vec<u8>>, String> {
    Ok(decrypt_message_with_outcome(pool, account_id, message_id)
        .await?
        .plaintext_mime)
}

pub async fn open_crypto_message(
    pool: &SqlitePool,
    account_id: &str,
    message_id: &str,
) -> Result<OpenCryptoResult, String> {
    // Delegate the full decrypt + dispatch arm to the pure helper; project
    // the outcome tuple into `finish_open_crypto` (which parses plaintext →
    // upserts `message_crypto_results` → returns `OpenCryptoResult`). The
    // `no-ciphertext` and `no-key` branches now round-trip through
    // `finish_open_crypto` with `plaintext=None` — same row, same upsert,
    // same return shape as the pre-refactor inline early-returns.
    let outcome = decrypt_message_with_outcome(pool, account_id, message_id).await?;
    finish_open_crypto(
        pool,
        account_id,
        message_id,
        outcome.plaintext_mime,
        outcome.crypto_kind,
        outcome.decrypt_state,
        outcome.signature_state,
        outcome.signer_fp,
        outcome.signer_email,
        // Granular ChainOutcome.failure_reason threaded from run_verify_path.
        // None for the not-signed / encrypt-only branch (no verify path ran).
        outcome.failure_reason,
        // Structured RFC 5280 CRLReason threaded from run_verify_path.
        // None for every non-revoked outcome.
        outcome.revocation_reason,
    )
    .await
}

/// Post-dispatch tail of [`open_crypto_message`]: parse the plaintext MIME
/// into (html, text, attachments), build + upsert the `message_crypto_results`
/// row, and return the in-memory `OpenCryptoResult`. Shared by the clear-signed
/// branch (G7 Task 2) and the existing opaque pkcs7-mime dispatch so both
/// paths converge on the same persist + return shape.
#[allow(clippy::too_many_arguments)] // orchestrator tail; bundling adds ceremony without clarity
async fn finish_open_crypto(
    pool: &SqlitePool,
    account_id: &str,
    message_id: &str,
    plaintext_mime: Option<Vec<u8>>,
    crypto_kind: &str,
    decrypt_state: &str,
    signature_state: SignatureState,
    signer_fp: Option<String>,
    signer_email: Option<String>,
    failure_reason: Option<String>,
    revocation_reason: Option<String>,
) -> Result<OpenCryptoResult, String> {
    // Parse the plaintext MIME → html/text/attachments.
    let (plaintext_html, plaintext_text, attachments) = match plaintext_mime.as_deref() {
        Some(bytes) => parse_plaintext_mime(bytes),
        None => (None, None, Vec::new()),
    };

    // Upsert the crypto-result row.
    let row = build_crypto_result_row(
        account_id,
        message_id,
        crypto_kind,
        decrypt_state,
        signature_state,
        signer_fp,
        signer_email,
        failure_reason,
        revocation_reason,
    );
    upsert_message_crypto_result(pool, &row).await?;

    // Return (plaintext in-memory).
    Ok(OpenCryptoResult {
        plaintext_html,
        plaintext_text,
        attachments,
        crypto_result: row,
    })
}

/// Parse a plaintext MIME blob into (html, text, attachments) via `mail_parser`.
/// Mirrors the body-text/html extraction in `mail::imap::client::parse_message`
/// (`body_text(0)` + `body_html(0)`) + the attachment metadata extraction in
/// `extract_attachments` (reused via the pub(crate) alias).
fn parse_plaintext_mime(
    mime_bytes: &[u8],
) -> (Option<String>, Option<String>, Vec<ImapAttachment>) {
    let parsed = match mail_parser::MessageParser::default().parse(mime_bytes) {
        Some(p) => p,
        None => return (None, None, Vec::new()),
    };
    let body_text = parsed.body_text(0).map(|s| s.to_string());
    let body_html = parsed.body_html(0).map(|s| s.to_string());
    let attachments = extract_attachments(&parsed, 0);
    (body_html, body_text, attachments)
}

/// Apply S/MIME sign/encrypt to a built MIME message. Returns the wrapped bytes
/// (or the input unchanged when `crypto_method != Smime` or neither flag set).
///
/// - `sign`   → clear-sign `multipart/signed` over the body entity.
/// - `encrypt` → `application/pkcs7-mime; smime-type=enveloped-data` over the
///   (possibly signed) body entity; the sender (`account_email`) is added as a
///   recipient (encrypt-to-self).
/// - sign + encrypt → inner clear-sign, outer enveloped.
///
/// Fail-closed on missing OR invalid recipient certs: any To/Cc/Bcc (or the
/// sender) whose cert `find_by_email` cannot resolve produces
/// `MissingRecipientCert`; any resolved recipient cert that does NOT chain to
/// a configured trust anchor for `account_id` (or is expired / missing the
/// S/MIME BR leaf shape) produces `InvalidRecipientCert`. In both cases no
/// ciphertext is emitted — `backend.encrypt` is never reached.
///
/// `pool` + `account_id` are used to resolve the trust-anchor set (option (c)
/// for the G4 "corporate-PKI intermediates" landmine — every `key_type='cert'`
/// row for the account acts as a candidate anchor, Thunderbird-equivalent).
#[allow(clippy::too_many_arguments)] // orchestrator surface; bundling adds ceremony without clarity
pub(crate) async fn apply_crypto(
    backend: &SmimeBackend,
    keystore: &SqliteKeyStore,
    mime: &[u8],
    draft: &SendDraft,
    account_email: &str,
    default_signing_key: Option<&DefaultKeyRow>,
    pool: &SqlitePool,
    account_id: &str,
) -> Result<Vec<u8>, CryptoSendError> {
    if draft.crypto_method != CryptoMethod::Smime || (!draft.sign && !draft.encrypt) {
        return Ok(mime.to_vec());
    }

    let (outer, mut entity) = split_message(mime)?;

    // Resolve the signing key up-front. Used by BOTH the encrypt-with-sign arm
    // (opaque SignedData inside EnvelopedData — Thunderbird-style
    // sign-then-encrypt) and the sign-only clear-sign arm below. `None` when
    // not signing.
    //
    // CRITICAL: when BOTH sign + encrypt we must NOT clear-sign-then-encrypt.
    // Clear-signing wraps the body in a `multipart/signed` MIME entity; the
    // receive orchestrator (`open_crypto_message` → `is_signed_data`) only
    // recurses into signature verification for an opaque CMS `SignedData`
    // (`id-signed-data` OID), NOT for a `multipart/signed` MIME structure — so
    // a clear-signed-then-encrypted message would be received as
    // `crypto_kind='encrypted'` + `signature_state='not-signed'` (the signature
    // silently dropped). Passing `sign_with` to `backend.encrypt` instead
    // composes opaque SignedData inside EnvelopedData — the shape the receiver
    // recognizes and recurses into (pinned by
    // `open_crypto_message_decrypts_and_verifies_enveloped_then_signed`).
    let signer: Option<KeyHandleRef> = if draft.sign {
        let signer_row = default_signing_key.ok_or(CryptoSendError::NoSigningKey)?;
        Some(key_handle_ref(signer_row))
    } else {
        None
    };

    // --- encrypt ---
    if draft.encrypt {
        // Recipient set = sender (encrypt-to-self) + To/Cc/Bcc. Dedup is the
        // keystore's job (duplicate handles are harmless to the cms builder).
        let recipient_emails: Vec<String> = std::iter::once(account_email.to_string())
            .chain(draft.to.iter().map(|a| a.email.clone()))
            .chain(draft.cc.iter().map(|a| a.email.clone()))
            .chain(draft.bcc.iter().map(|a| a.email.clone()))
            .collect();
        let mut recipients = Vec::with_capacity(recipient_emails.len());
        for email in &recipient_emails {
            let handles = keystore
                .find_by_email(Standard::Smime, email)
                .await
                .map_err(CryptoSendError::Backend)?;
            let h = handles
                .first()
                .cloned()
                .ok_or_else(|| CryptoSendError::MissingRecipientCert(email.clone()))?;
            recipients.push(h);
        }
        // Fail-closed: validate every recipient cert BEFORE `backend.encrypt`.
        // Closes the Plan 4a "unvalidated recipient cert" carry-forward: an
        // expired/wrong-issuer/wrong-EKU recipient cert would otherwise produce
        // ciphertext that the recipient can never decrypt. Resolution:
        //   1. Resolve each recipient `KeyHandleRef` → its cert DER via
        //      `backend.export_public` (reads `public_data` from the keystore).
        //   2. Resolve the account's trust-anchor set (option (c) for the G4
        //      "corporate-PKI intermediates" landmine — every `key_type='cert'`
        //      row, including any bundled intermediates G6's import stores, is
        //      a candidate anchor; Thunderbird-equivalent).
        //   3. `validate_recipient_certs` runs the same chain validator as the
        //      receive side (`crypto_smime::validate_signer_chain` under the
        //      `KylinsSmimeProfile`). On the first failure → `InvalidRecipientCert`
        //      and `apply_crypto` returns (no ciphertext produced). The
        //      existing `send_op` failure-emit path (engine.rs:1086-1108)
        //      surfaces it as `SendResultEvent{success:false}` + `Err`.
        let mut recipient_cert_ders = Vec::with_capacity(recipients.len());
        for h in &recipients {
            let der = backend
                .export_public(&h.handle)
                .await
                .map_err(CryptoSendError::Backend)?;
            recipient_cert_ders.push(der);
        }
        let trust_anchor_ders = list_trust_anchor_certs(pool, account_id)
            .await
            .map_err(CryptoSendError::InvalidRecipientCert)?;
        let now_unix = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_secs())
            .unwrap_or(0);
        validate_recipient_certs(&recipient_cert_ders, &trust_anchor_ders, now_unix)
            .await
            .map_err(CryptoSendError::InvalidRecipientCert)?;
        let env = backend
            .encrypt(EncryptOp {
                parts: &[Part {
                    id: PartId("body".into()),
                    kind: PartKind::Body,
                    data: entity.0.clone(),
                }],
                serialization: SerializationStrategy::SingleMimeBlob,
                recipients: &recipients,
                // `sign_with` = the resolved signer when `draft.sign` → opaque
                // SignedData inside EnvelopedData (sign-then-encrypt). `None`
                // → encrypt-only.
                sign_with: signer.clone(),
            })
            .await?;
        let enveloped_der = env
            .parts
            .first()
            .expect("encrypt returns exactly one part")
            .ciphertext
            .clone();
        let wrapped_entity = wrap_enveloped(&enveloped_der, "enveloped-data");
        // Final message = outer headers (no entity Content-Type) + the wrapped
        // entity (which carries its own application/pkcs7-mime Content-Type).
        let mut out = outer.headers.into_bytes();
        out.extend_from_slice(b"\r\n");
        out.extend_from_slice(&wrapped_entity);
        return Ok(out);
    }

    // --- sign-only (clear-sign) ---
    // Reached only when `draft.sign && !draft.encrypt` (the encrypt branch
    // above returns). Produces a `multipart/signed` MIME entity — the standard
    // clear-signed S/MIME shape (Thunderbird-interoperable).
    if let Some(signer) = signer {
        let part1 = ensure_one_trailing_crlf(&entity.0);
        let signed = backend
            .sign(SignOp {
                payload: &part1,
                signing_key: signer,
                detached: true,
            })
            .await?;
        entity.0 = wrap_multipart_signed(&part1, &signed.signature.signature);
    }

    // sign-only: outer headers + the multipart/signed entity (its own Content-Type).
    let mut out = outer.headers.into_bytes();
    out.extend_from_slice(b"\r\n");
    out.extend_from_slice(&entity.0);
    Ok(out)
}

/// Validate recipient certs before encrypting (Plan 4a carry-forward, closed
/// in G4 Task 5). For each recipient cert, runs cert-chain validation against
/// the supplied trust anchors at `now_unix`. Returns `Ok(())` if every cert
/// chains to an anchor AND is within its validity window AND has the S/MIME
/// BR leaf shape (KeyUsage + emailProtection EKU + rfc822Name SAN — enforced
/// by the `KylinsSmimeProfile`); `Err(msg)` on the first failure.
///
/// G5 will wire this into `apply_crypto`'s encrypt path so the send side
/// fails closed BEFORE producing ciphertext when a recipient cert is broken
/// (expired, wrong-issuer, missing EKU, etc.) — closing the Plan 4a
/// "unvalidated recipient cert" carry-forward. This Task 5 ships the helper
/// + its unit tests; the wiring into `apply_crypto` is G5.
///
/// Recipients are validated for **chain + validity + leaf shape**, NOT
/// identity binding (`from_email = None`). Recipients are NOT senders — their
/// SAN doesn't need to match anything in the send context. The
/// `KylinsSmimeProfile` still enforces that the cert HAS an rfc822Name SAN
/// (`require_rfc822_san = true`), just not any particular value.
///
/// Pool-free: the G5 orchestrator resolves trust anchors from the KeyManager
/// "Trusted CAs" store and passes them in. No DB access here keeps the helper
/// pure / testable without a `SqlitePool`.
pub async fn validate_recipient_certs(
    recipient_cert_ders: &[Vec<u8>],
    trust_anchor_ders: &[Vec<u8>],
    now_unix: u64,
) -> Result<(), String> {
    for (i, cert_der) in recipient_cert_ders.iter().enumerate() {
        // `validate_signer_chain` with `from_email=None` runs pure path
        // validation under the S/MIME BR profile. `intermediates_der=&[]`
        // because recipient certs in practice chain directly to a configured
        // trust anchor (G5 may extend this to pass CRLs / intermediates when
        // the orchestrator has them).
        let outcome = crypto_smime::validate_signer_chain(
            cert_der,
            &[],
            trust_anchor_ders,
            None,
            now_unix as i64,
            &[],
        );
        if !outcome.chain_valid {
            return Err(format!(
                "recipient cert #{} invalid: {}",
                i,
                outcome
                    .failure_reason
                    .as_deref()
                    .unwrap_or("(no failure reason)")
            ));
        }
    }
    Ok(())
}

/// Build a [`KeyHandleRef`] for the default signing key whose `KeyId` matches
/// `SqliteKeyStore`'s canonical `"standard|fingerprint"` encoding (so a later
/// `backend.sign(... signing_key: this ...)` resolves via `keystore.get`).
///
/// Mirrors [`SqliteKeyStore::encode_key_id`]. `algorithm` is fixed to
/// `ECDSA-P256` (the only signing algorithm `SmimeBackend::sign` currently
/// supports); a future P-384/Ed25519 arm will dispatch on `DefaultKeyRow`'s
/// algorithm column once it carries one.
fn key_handle_ref(row: &DefaultKeyRow) -> KeyHandleRef {
    KeyHandleRef {
        handle: KeyHandle::Software(KeyId(format!("{}|{}", row.standard, row.fingerprint))),
        standard: Standard::Smime,
        fingerprint: Fingerprint::new(&row.fingerprint),
        usage: KeyUsage::SignAndEncrypt,
        algorithm: "ECDSA-P256".into(),
    }
}

// ──────────────────────────────────────────────────────────────────────────
// Signature details dialog — re-parse the cached CMS blob on dialog open.
// Pure parse + DB reads; no decrypt, no network. See `SignerDetails` doc above.
// ──────────────────────────────────────────────────────────────────────────

/// Parsed cert fields surfaced by [`summarize_cert`]. Reused for the signer
/// leaf, intermediates, and anchors so the dialog renders them uniformly.
struct CertSummary {
    subject_cn: Option<String>,
    issuer_cn: Option<String>,
    serial_hex: String,
    not_before_unix: i64,
    not_after_unix: i64,
    public_key_algorithm_oid: String,
}

/// Parse a cert DER with `x509-parser` and extract the fields the dialog
/// renders. Returns `None` on parse failure (soft — a malformed cert in the
/// chain path is skipped, not fatal). Mirrors the `x509_parser` idiom in
/// [`extract_crl_distribution_points`].
fn summarize_cert(der: &[u8]) -> Option<CertSummary> {
    let (_rem, cert) = x509_parser::parse_x509_certificate(der).ok()?;
    let subject_cn = cert
        .subject()
        .iter_common_name()
        .next()
        .and_then(|cn| cn.as_str().ok())
        .map(str::to_string);
    let issuer_cn = cert
        .issuer()
        .iter_common_name()
        .next()
        .and_then(|cn| cn.as_str().ok())
        .map(str::to_string);
    let serial_hex = cert
        .raw_serial()
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect::<String>();
    let not_before_unix = cert.validity().not_before.timestamp();
    let not_after_unix = cert.validity().not_after.timestamp();
    let public_key_algorithm_oid = cert.public_key().algorithm.algorithm.to_string();
    Some(CertSummary {
        subject_cn,
        issuer_cn,
        serial_hex,
        not_before_unix,
        not_after_unix,
        public_key_algorithm_oid,
    })
}

/// UI-level failure-reason fallback for the persisted `signature_state`. Used
/// by [`get_signer_details`] ONLY when the persisted
/// `message_crypto_results.failure_reason` column is NULL (pre-migration rows,
/// the UnknownKey / sig-fail early-return arms where `verify_with_context`
/// short-circuits before chain validation, and all success states). The real
/// `ChainOutcome.failure_reason` is otherwise surfaced verbatim from the row.
fn failure_reason_for_state(state: &str) -> Option<String> {
    match state {
        "invalid" => Some("Signature did not verify — content may have been altered.".into()),
        "mismatch" => Some("Signer identity does not match the message From header.".into()),
        "unknown-key" => Some("Signer certificate is not in your keyring.".into()),
        "valid-unverified" => {
            Some("Signature valid, but the chain does not root in a trusted anchor.".into())
        }
        _ => None,
    }
}

/// Re-parse the cached SignedData DER to extract `(signer_leaf_der,
/// signature_algorithm_oid)`. Returns `None` when the blob is not valid
/// SignedData or the signer leaf can't be located by IssuerAndSerialNumber.
/// Mirrors the IssuerAndSerialNumber match in [`run_verify_path`] (the CRL
/// extraction block) — factored out so the details dialog reuses the same
/// signer-leaf resolution without re-running verify.
fn extract_signer_leaf(signed_data_der: &[u8]) -> Option<(Vec<u8>, String)> {
    let sci = ContentInfo::from_der(signed_data_der).ok()?;
    let sinner = sci.content.to_der().ok()?;
    let ssd = cms::signed_data::SignedData::from_der(&sinner).ok()?;
    let cert_set = ssd.certificates.as_ref()?;
    let first_signer_info = ssd.signer_infos.0.get(0)?;
    let sig_alg_oid = first_signer_info.signature_algorithm.oid.to_string();
    for choice in cert_set.0.iter() {
        if let cms::cert::CertificateChoices::Certificate(c) = choice {
            let tbs = c.tbs_certificate();
            let candidate_iasn = cms::cert::IssuerAndSerialNumber {
                issuer: tbs.issuer().clone(),
                serial_number: tbs.serial_number().clone(),
            };
            if let cms::signed_data::SignerIdentifier::IssuerAndSerialNumber(ref target) =
                first_signer_info.sid
            {
                if &candidate_iasn == target {
                    if let Ok(der) = c.to_der() {
                        return Some((der, sig_alg_oid));
                    }
                }
            }
        }
    }
    None
}

/// Build the [`SignerDetails`] record for the "Signature details…" dialog.
/// Returns `Ok(None)` when the message has no persisted `message_crypto_results`
/// row (never opened through the crypto pipeline). For `signed` (opaque) and
/// clear-signed messages the signer leaf + chain path are re-parsed from the
/// cached CMS columns; for `encrypted-signed` the SignedData lives in
/// decrypted in-memory-only bytes (not persisted), so `signer` is `None`.
pub(crate) async fn get_signer_details(
    pool: &SqlitePool,
    account_id: &str,
    message_id: &str,
) -> Result<Option<SignerDetails>, String> {
    // 1. Persisted verdict (authoritative — has CRL-based revocation from
    //    open time). None ⇒ message was never opened through the crypto path.
    let Some(row) = get_message_crypto_result(pool, account_id, message_id).await? else {
        return Ok(None);
    };

    // 2. Cached CMS columns + From header (for trust resolution).
    let ciphertext = get_message_ciphertext(pool, account_id, message_id).await?;
    let signed_part = get_message_signed_part(pool, account_id, message_id).await?;
    let from_address: Option<String> =
        sqlx::query_scalar("SELECT from_address FROM messages WHERE account_id = ? AND id = ?")
            .bind(account_id)
            .bind(message_id)
            .fetch_optional(pool)
            .await
            .map_err(|e| e.to_string())?
            .flatten();

    // 3. Resolve the SignedData DER we can re-parse WITHOUT decrypting.
    //    - clear-signed (multipart/signed): the detached .p7s lives in
    //      body_mime_ciphertext; signed_part holds the covered part-1.
    //    - opaque signed (application/pkcs7-mime; signed-data): the CMS blob
    //      itself is the SignedData in body_mime_ciphertext.
    //    - enveloped / encrypted-signed: no re-parseable SignedData in the DB
    //      (the inner SignedData for encrypted-signed lives in decrypted
    //      in-memory-only bytes). Both shapes above resolve to `ciphertext`,
    //      so a single OR gate suffices.
    let signed_data_der: Option<Vec<u8>> = if signed_part.is_some() || row.crypto_kind == "signed" {
        ciphertext.clone()
    } else {
        None
    };

    // 4. Re-parse for signer leaf + intermediates (best-effort; None leaves
    //    the dialog with the persisted verdict only).
    let signer: Option<SignerCertDetails> = signed_data_der
        .as_deref()
        .and_then(extract_signer_leaf)
        .and_then(|(leaf_der, sig_alg_oid)| {
            let s = summarize_cert(&leaf_der)?;
            Some(SignerCertDetails {
                subject_cn: s.subject_cn,
                issuer_cn: s.issuer_cn,
                serial_hex: s.serial_hex,
                fingerprint: row.signer_fingerprint.clone().unwrap_or_default(),
                not_before_unix: s.not_before_unix,
                not_after_unix: s.not_after_unix,
                public_key_algorithm_oid: s.public_key_algorithm_oid,
                signature_algorithm_oid: sig_alg_oid,
                // signingTime lives in the CMS signedAttrs; the extractor
                // (`find_signing_time`) is pub(crate) in crypto_smime, not
                // re-exported — surfaced as None for v1 (verified_at covers
                // the verification time in the dialog's Verification section).
                signing_time_unix: None,
            })
        });

    // 5. Chain path: intermediates (from the SignedData cert set) + the
    //    account's trust anchors. Both parsed with summarize_cert.
    let mut chain_path: Vec<ChainPathEntry> = Vec::new();
    if let Some(der) = signed_data_der.as_deref() {
        if let Ok(intermediates) = crypto_smime::extract_intermediates(der) {
            for int_der in intermediates {
                if let Some(s) = summarize_cert(&int_der) {
                    chain_path.push(ChainPathEntry {
                        subject_cn: s.subject_cn,
                        issuer_cn: s.issuer_cn,
                        is_anchor: false,
                    });
                }
            }
        }
    }
    let anchors = list_trust_anchor_certs(pool, account_id).await?;
    for anchor_der in anchors {
        if let Some(s) = summarize_cert(&anchor_der) {
            chain_path.push(ChainPathEntry {
                subject_cn: s.subject_cn,
                issuer_cn: s.issuer_cn,
                is_anchor: true,
            });
        }
    }

    // 6. Trust state (re-resolved — reflects any trust decision since open).
    let trust_state = resolve_signer_trust(
        pool,
        account_id,
        row.signer_fingerprint.as_deref(),
        from_address.as_deref(),
    )
    .await;
    // TrustState serializes kebab-case via crypto_core; format explicitly so
    // the wire value matches the dialog's expectations (lowercase).
    let trust_state_str = format!("{trust_state:?}").to_lowercase();
    // Granular ChainOutcome.failure_reason (2026-07-18 spec): prefer the
    // persisted real reason (surfaced from `VerificationResult.failure_reason`
    // by `verify_with_context`); fall back to the coarse `failure_reason_for_state`
    // fixed map when the column is NULL (pre-migration rows, the
    // UnknownKey/sig-fail early-return arms, and all success states). This
    // belt-and-suspenders fallback preserves the dialog's existing banner for
    // rows that never had a real reason persisted.
    let failure_reason = row
        .failure_reason
        .clone()
        .or_else(|| failure_reason_for_state(&row.signature_state));

    Ok(Some(SignerDetails {
        signature_state: row.signature_state,
        decrypt_state: row.decrypt_state,
        crypto_kind: row.crypto_kind,
        chain_valid: row.chain_valid.map(|n| n != 0),
        revocation_state: row.revocation_state,
        verified_at: row.verified_at,
        trust_state: trust_state_str,
        signer,
        chain_path,
        failure_reason,
        // Structured RFC 5280 CRLReason (2026-07-18 CRL-revocation-detail
        // spec). Pass through verbatim — None for every non-revoked outcome;
        // Some(<name>) only when the cert was revoked AND the CRL entry
        // carried a reasonCode extension. No fixed-map fallback (unlike
        // failure_reason): the dialog renders the "Reason: …" line only when
        // this field is non-null.
        revocation_reason: row.revocation_reason,
    }))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Arc;

    use sqlx::SqlitePool;
    use tempfile::TempDir;

    use crypto_core::{CryptoPolicy, KeyGenParams};
    use der::Encode;
    use mail_parser::MimeHeaders;
    use sha2::Digest;

    use crate::db::crypto_keys::get_default_signing_key;
    use crate::db::init_db;
    use crate::mail::builder::{
        build_mime, build_mime_with_granularity, AddressSpec, AttachmentRef,
    };
    use crypto_core::EncryptionGranularity;

    // ---- existing Task 4 wrapper unit tests (unchanged) ----

    #[test]
    fn split_message_separates_headers_and_body_entity() {
        let full = b"From: a@k\r\nTo: b@k\r\nSubject: Hi\r\nMIME-Version: 1.0\r\nContent-Type: text/plain; charset=utf-8\r\n\r\nHello body\r\n";
        let (outer, entity) = split_message(full).unwrap();
        assert!(outer.headers.contains("From: a@k"));
        assert!(outer.headers.contains("MIME-Version: 1.0"));
        assert!(!outer.headers.contains("Content-Type:"));
        assert!(entity
            .0
            .starts_with(b"Content-Type: text/plain; charset=utf-8\r\n\r\nHello body"));
    }

    /// Regression for Task 5 folding fix: `mail-builder` folds long
    /// multipart Content-Type values (`boundary` pushes the line past 76 cols)
    /// onto a `\r\n\t`-prefixed continuation line. Without folding-aware
    /// splitting that continuation would be mis-classified as an outer header
    /// and leak out of the signed entity, corrupting the signature.
    #[test]
    fn split_message_keeps_folded_content_type_in_entity_bucket() {
        let full = b"From: a@k\r\nTo: b@k\r\nSubject: Hi\r\nMIME-Version: 1.0\r\n\
                     Content-Type: multipart/alternative;\r\n\tboundary=\"=_very_long_boundary_marker_0001_xyz\"\r\n\
                     \r\n--=_very_long_boundary_marker_0001_xyz\r\npart1\r\n";
        let (outer, entity) = split_message(full).unwrap();
        assert!(outer.headers.contains("From: a@k"));
        assert!(outer.headers.contains("MIME-Version: 1.0"));
        assert!(
            !outer.headers.contains("boundary"),
            "boundary continuation must NOT leak into outer headers"
        );
        assert!(
            !outer.headers.contains("multipart/alternative"),
            "Content-Type must NOT leak into outer headers"
        );
        assert!(
            entity.0.starts_with(
                b"Content-Type: multipart/alternative;\r\n\tboundary=\"=_very_long_boundary_marker_0001_xyz\"\r\n\r\n"
            ),
            "entity must retain the folded Content-Type verbatim"
        );
    }

    #[test]
    fn wrap_multipart_signed_part1_is_byte_exact_and_parses() {
        let part1 =
            ensure_one_trailing_crlf(b"Content-Type: text/plain; charset=utf-8\r\n\r\nbody\r\n");
        let signed_der = b"\x30\x02\x00\x00"; // opaque fixture; structure test only
        let entity = wrap_multipart_signed(&part1, signed_der);
        let s = std::str::from_utf8(&entity).unwrap();
        assert!(s.contains("multipart/signed"));
        assert!(s.contains("protocol=\"application/pkcs7-signature\""));
        assert!(s.contains("micalg=sha-256"));
        // part-1 bytes appear verbatim between the first boundary and the next.
        let boundary_line = s.lines().find(|l| l.starts_with("--")).unwrap();
        let after_first_bound = s.split_once(boundary_line).unwrap().1;
        let (part1_region, _rest) = after_first_bound.split_once(boundary_line).unwrap();
        // part1_region starts with a leading \n (from "--bound\r\n"); trim it.
        let part1_in_mime = part1_region
            .trim_start_matches('\r')
            .trim_start_matches('\n');
        assert_eq!(part1_in_mime.as_bytes(), &part1[..]);
    }

    #[test]
    fn wrap_enveloped_emits_pkcs7_mime_base64() {
        let entity = wrap_enveloped(&[0xDE, 0xAD, 0xBE, 0xEF], "enveloped-data");
        let s = std::str::from_utf8(&entity).unwrap();
        assert!(s.contains("application/pkcs7-mime; smime-type=enveloped-data"));
        assert!(s.contains("Content-Transfer-Encoding: base64"));
        assert!(s.contains("3q2+7w==")); // base64 of DEADBEEF
    }

    // ---- Task 5 apply_crypto integration tests ----

    const ACCOUNT_ID: &str = "acct-apply-crypto";
    const ACCOUNT_EMAIL: &str = "alice@kylins.com";

    async fn seed_account(pool: &SqlitePool, id: &str, email: &str) {
        sqlx::query(
            "INSERT INTO accounts (id, email, provider, is_active, is_default, sort_order, created_at, updated_at)
             VALUES (?, ?, 'imap', 1, 0, 0, strftime('%s','now'), strftime('%s','now'))",
        )
        .bind(id)
        .bind(email)
        .execute(pool)
        .await
        .expect("seed account");
    }

    fn addr(email: &str) -> AddressSpec {
        AddressSpec {
            name: None,
            email: email.into(),
        }
    }

    /// Test fixture: temp DB + seeded account(s) + an `SmimeBackend` over a
    /// db-backed `SqliteKeyStore`. Always generates the account's own S/MIME
    /// key (used as the signer when `flag_default_signer`, and as the
    /// encrypt-to-self recipient cert). `extra_recipient_emails` seeds extra
    /// recipient certs under their own accounts so `find_by_email` resolves
    /// them (put() stores the *account's* email, not the keygen `user_id`).
    struct Harness {
        backend: SmimeBackend,
        keystore: Arc<SqliteKeyStore>,
        #[allow(dead_code)]
        pool: Arc<SqlitePool>,
        account_email: String,
        signer_row: Option<DefaultKeyRow>,
        #[allow(dead_code)]
        _tmp: TempDir,
    }

    async fn make_harness(flag_default_signer: bool, extra_recipient_emails: &[&str]) -> Harness {
        let tmp = tempfile::tempdir().expect("tempdir");
        let pool = Arc::new(init_db(tmp.path()).await.expect("init_db"));
        seed_account(&pool, ACCOUNT_ID, ACCOUNT_EMAIL).await;

        let ks = Arc::new(SqliteKeyStore::new(pool.clone(), ACCOUNT_ID));
        let backend = SmimeBackend::new(ks.clone(), CryptoPolicy::default_baseline());

        // The account's own key — signer (if flagged) + encrypt-to-self cert.
        let own = backend
            .generate_key(KeyGenParams {
                standard: Standard::Smime,
                user_id: ACCOUNT_EMAIL.into(),
                algorithm: "ECDSA-P256".into(),
                passphrase: None,
            })
            .await
            .expect("generate own key");

        let signer_row = if flag_default_signer {
            sqlx::query("UPDATE crypto_keys SET is_default_sign = 1 WHERE fingerprint = ?")
                .bind(own.fingerprint.as_str())
                .execute(pool.as_ref())
                .await
                .expect("flag default signer");
            get_default_signing_key(pool.as_ref(), ACCOUNT_ID)
                .await
                .expect("query default signing key")
        } else {
            None
        };

        // Extra recipients: each under its own account so put() stores the
        // matching email. find_by_email queries globally (no account filter),
        // so apply_crypto's keystore (bound to ACCOUNT_ID) resolves them.
        for (i, email) in extra_recipient_emails.iter().enumerate() {
            let acct = format!("acct-rcpt-{i}");
            seed_account(&pool, &acct, email).await;
            let rcpt_ks = Arc::new(SqliteKeyStore::new(pool.clone(), acct));
            let rcpt_backend = SmimeBackend::new(rcpt_ks, CryptoPolicy::default_baseline());
            rcpt_backend
                .generate_key(KeyGenParams {
                    standard: Standard::Smime,
                    user_id: (*email).into(),
                    algorithm: "ECDSA-P256".into(),
                    passphrase: None,
                })
                .await
                .expect("generate recipient key");
        }

        Harness {
            backend,
            keystore: ks,
            pool,
            account_email: ACCOUNT_EMAIL.into(),
            signer_row,
            _tmp: tmp,
        }
    }

    /// Copy the most recent S/MIME cert from `source_account_id` into
    /// `dest_account_id`'s `crypto_keys` as a `key_type='cert'` trust-anchor
    /// row. Mirrors the KeyManager "import contact cert" path (G6): the
    /// recipient's cert becomes a candidate anchor for the destination
    /// account, so `validate_recipient_certs` (called from `apply_crypto`)
    /// accepts the recipient as chaining-to-anchor. Used by tests that need
    /// the "valid recipient" path (without it, an extra recipient seeded via
    /// `make_harness(extra_recipient_emails=…)` is NOT in ACCOUNT_ID's anchor
    /// set and the validation gate rejects it — see
    /// `apply_crypto_invalid_recipient_cert_fails_closed` for the negative
    /// case).
    async fn seed_anchor_from_account(
        pool: &SqlitePool,
        dest_account_id: &str,
        source_account_id: &str,
    ) {
        let row: (String, String) = sqlx::query_as(
            "SELECT public_data, fingerprint FROM crypto_keys
             WHERE account_id = ? AND standard = 'smime'
             ORDER BY created_at DESC LIMIT 1",
        )
        .bind(source_account_id)
        .fetch_one(pool)
        .await
        .expect("source account has a cert");
        sqlx::query(
            "INSERT INTO crypto_keys (
                id, account_id, standard, key_type, email, fingerprint, public_data,
                origin, is_default_sign, is_default_encrypt, created_at
             ) VALUES (?, ?, 'smime', 'cert', NULL, ?, ?, 'imported', 0, 0, strftime('%s','now'))",
        )
        .bind(format!("anchor-{source_account_id}"))
        .bind(dest_account_id)
        .bind(&row.1)
        .bind(&row.0)
        .execute(pool)
        .await
        .expect("insert anchor row");
    }

    /// Extract (part1 bytes, detached p7s DER) from a `multipart/signed`
    /// message produced by `apply_crypto` sign-only / `wrap_multipart_signed`.
    ///
    /// Part 1 is the slice between the first and second `--{boundary}\r\n`
    /// markers (it includes its own terminating CRLF, which is part of the
    /// signed byte sequence).
    fn extract_signed_parts(out: &[u8]) -> (Vec<u8>, Vec<u8>) {
        let s = std::str::from_utf8(out).expect("multipart output utf-8");
        let first_marker = format!("--{SIGNED_BOUNDARY}\r\n");
        let closing_marker = format!("--{SIGNED_BOUNDARY}--");
        let p1_start = s.find(&first_marker).expect("first boundary") + first_marker.len();
        // The second occurrence of the boundary marker terminates part 1.
        let p2 = s[p1_start..].find(&first_marker).expect("second boundary") + p1_start;
        let part1 = out[p1_start..p2].to_vec();

        // Part 2 begins right after the second marker; it has its own header
        // block + blank line + base64 body, ending at the closing marker.
        let p2_body_start = p2 + first_marker.len();
        let blank = s[p2_body_start..].find("\r\n\r\n").expect("part2 blank") + 4 + p2_body_start;
        let p2_end = s[blank..]
            .find(&format!("\r\n{closing_marker}"))
            .expect("closing marker")
            + blank;
        let p7s_b64: String = s[blank..p2_end]
            .chars()
            .filter(|c| !c.is_whitespace())
            .collect();
        let p7s_der = base64::engine::general_purpose::STANDARD
            .decode(p7s_b64)
            .expect("base64 decode p7s");
        (part1, p7s_der)
    }

    /// Parse a `SignedData` DER blob and return the `messageDigest` signed
    /// attribute (OID `1.2.840.113549.1.9.4`) value as raw bytes. This is the
    /// SHA-256 digest the signer computed over the external (detached) content —
    /// asserting it equals `SHA-256(part1)` independently proves the signature
    /// covers the wrapped part-1 bytes.
    fn extract_message_digest(p7s_der: &[u8]) -> Vec<u8> {
        use cms::content_info::ContentInfo;
        use cms::signed_data::SignedData;
        use der::Decode;

        let ci: ContentInfo =
            <ContentInfo as Decode>::from_der(p7s_der).expect("parse ContentInfo");
        assert_eq!(ci.content_type, const_oid::db::rfc5911::ID_SIGNED_DATA);
        let sd: SignedData = <SignedData as Decode>::from_der(
            ci.content.to_der().expect("re-encode content").as_slice(),
        )
        .expect("parse SignedData");
        let signer = sd.signer_infos.0.get(0).expect("exactly one signer info");
        let attrs = signer.signed_attrs.as_ref().expect("signed attrs present");
        let md = attrs
            .iter()
            .find(|a| a.oid.to_string() == "1.2.840.113549.1.9.4")
            .expect("messageDigest attribute present");
        let md_val = md.values.get(0).expect("messageDigest has a value");
        let oct: der::asn1::OctetString = md_val
            .decode_as()
            .expect("decode messageDigest as OctetString");
        oct.as_bytes().to_vec()
    }

    /// Sign-only path: builds a real `multipart/signed` over a multipart/
    /// alternative body (exercising `mail-builder`'s Content-Type folding),
    /// then cryptographically proves the detached signature's `messageDigest`
    /// covers the exact part-1 bytes.
    #[tokio::test]
    async fn apply_crypto_sign_only_produces_verifiable_multipart_signed() {
        let h = make_harness(true, &[]).await;
        let signer_row = h.signer_row.as_ref().expect("signer flagged");

        // BOTH text + html → multipart/alternative → folded Content-Type in
        // `build_mime` output. If `split_message` mis-splits the folded header,
        // the part-1 bytes extracted from the multipart won't match what was
        // signed and the messageDigest gate below fails.
        let draft = SendDraft {
            draft_id: "s1".into(),
            from: addr("alice@kylins.com"),
            to: vec![addr("bob@kylins.com")],
            subject: "Signed Multipart".into(),
            text_body: Some("plain alternative body".into()),
            html_body: Some("<p>html alternative body</p>".into()),
            crypto_method: CryptoMethod::Smime,
            sign: true,
            ..Default::default()
        };
        let mime = build_mime(&draft).await.expect("build_mime");
        // Sanity: confirm the Content-Type is folded across lines (otherwise
        // the test is degenerate — it would pass without exercising the fix).
        // mail-builder emits e.g. `multipart/alternative; \r\n\tboundary="…"`
        // — a CRLF between the c_type and the boundary attribute signals fold.
        let mime_str = std::str::from_utf8(&mime).expect("mime utf-8");
        let ct_line = mime_str
            .lines()
            .find(|l| {
                l.to_ascii_lowercase()
                    .starts_with("content-type: multipart/alternative")
            })
            .expect("multipart/alternative Content-Type present");
        let boundary_line = mime_str
            .lines()
            .find(|l| l.contains("boundary="))
            .expect("boundary attribute present");
        assert_ne!(
            ct_line, boundary_line,
            "test is degenerate: Content-Type and boundary must be on separate (folded) lines"
        );

        let out = apply_crypto(
            &h.backend,
            h.keystore.as_ref(),
            &mime,
            &draft,
            &h.account_email,
            Some(signer_row),
            h.pool.as_ref(),
            ACCOUNT_ID,
        )
        .await
        .expect("apply_crypto sign");

        let s = std::str::from_utf8(&out).expect("output utf-8");
        assert!(s.contains("multipart/signed"));
        assert!(s.contains("application/pkcs7-signature"));

        // CRYPTOGRAPHIC GATE (resolution #2): the p7s messageDigest signed
        // attribute must equal SHA-256(part1) — independently proving the
        // signature covers the wrapped part-1 bytes. (We do NOT compare two
        // signature blobs because `backend.sign` is non-deterministic across
        // calls — the cms SignerInfoBuilder auto-adds signingTime.)
        let (part1, p7s_der) = extract_signed_parts(&out);
        let md = extract_message_digest(&p7s_der);
        let expected = sha2::Sha256::digest(&part1);
        assert_eq!(
            md.as_slice(),
            &expected[..],
            "messageDigest signed attribute must equal SHA-256(part1); \
             split_message is mis-splitting folded headers if this fails"
        );
    }

    /// Encrypt-only path: resolves a recipient cert (To) + the sender cert
    /// (encrypt-to-self), produces `application/pkcs7-mime; smime-type=enveloped-data`.
    #[tokio::test]
    async fn apply_crypto_encrypt_only_produces_enveloped_data() {
        let h = make_harness(false, &["bob@kylins.com"]).await;
        let draft = SendDraft {
            draft_id: "e1".into(),
            from: addr("alice@kylins.com"),
            to: vec![addr("bob@kylins.com")],
            subject: "Secret".into(),
            text_body: Some("plain secret body".into()),
            crypto_method: CryptoMethod::Smime,
            encrypt: true,
            ..Default::default()
        };
        let mime = build_mime(&draft).await.expect("build_mime");
        // Seed bob's cert as a trust anchor for ACCOUNT_ID so the
        // recipient-cert validation gate passes (mirrors the KeyManager
        // "import contact cert" path). Without this, validate_recipient_certs
        // would reject bob — bob's cert is currently stored only under his own
        // account (`acct-rcpt-0`) and so is NOT in ACCOUNT_ID's anchor set.
        seed_anchor_from_account(h.pool.as_ref(), ACCOUNT_ID, "acct-rcpt-0").await;
        let out = apply_crypto(
            &h.backend,
            h.keystore.as_ref(),
            &mime,
            &draft,
            &h.account_email,
            None,
            h.pool.as_ref(),
            ACCOUNT_ID,
        )
        .await
        .expect("apply_crypto encrypt");

        let s = std::str::from_utf8(&out).expect("output utf-8");
        assert!(s.contains("application/pkcs7-mime; smime-type=enveloped-data"));
        assert!(s.contains("Content-Transfer-Encoding: base64"));
    }

    /// Sign + encrypt (both flags): MUST produce opaque SignedData inside
    /// EnvelopedData (sign-then-encrypt), NOT clear-signed-then-encrypted. The
    /// receive orchestrator only recurses into signature verification for an
    /// opaque CMS `SignedData` (`is_signed_data` checks the `id-signed-data`
    /// OID); a `multipart/signed` MIME inner would be received as
    /// `crypto_kind='encrypted'` + `signature_state='not-signed'` (signature
    /// silently dropped). This round-trip pins the fix: apply_crypto → persist
    /// → open_crypto_message → `crypto_kind='encrypted-signed'` +
    /// `signature_state='valid-verified'`.
    #[tokio::test]
    async fn apply_crypto_sign_and_encrypt_produces_enveloped_then_signed() {
        let h = make_harness(true, &["bob@kylins.com"]).await;
        let pool = h.pool.clone();
        let draft = SendDraft {
            draft_id: "se1".into(),
            from: addr("alice@kylins.com"),
            to: vec![addr("bob@kylins.com")],
            subject: "Signed+Encrypted".into(),
            text_body: Some("signed and encrypted body".into()),
            crypto_method: CryptoMethod::Smime,
            sign: true,
            encrypt: true,
            ..Default::default()
        };
        let mime = build_mime(&draft).await.expect("build_mime");
        // Seed bob's cert as a trust anchor for ACCOUNT_ID so the
        // recipient-cert validation gate passes (see encrypt-only test).
        seed_anchor_from_account(pool.as_ref(), ACCOUNT_ID, "acct-rcpt-0").await;
        let out = apply_crypto(
            &h.backend,
            h.keystore.as_ref(),
            &mime,
            &draft,
            &h.account_email,
            h.signer_row.as_ref(),
            pool.as_ref(),
            ACCOUNT_ID,
        )
        .await
        .expect("apply_crypto sign+encrypt");

        // Outer is enveloped-data (base64 single-part).
        let s = std::str::from_utf8(&out).expect("output utf-8");
        assert!(
            s.contains("application/pkcs7-mime; smime-type=enveloped-data"),
            "outer must be enveloped-data; got:\n{s}"
        );

        // Extract the enveloped CMS blob (mail_parser base64-decodes the root
        // part body) + round-trip through open_crypto_message.
        let parsed = mail_parser::MessageParser::default()
            .parse(&out)
            .expect("output parses as MIME");
        let root = parsed.parts.first().expect("root part");
        let ciphertext = match &root.body {
            mail_parser::PartType::Binary(d) | mail_parser::PartType::InlineBinary(d) => {
                d.as_ref().to_vec()
            }
            _ => panic!("root part must carry the enveloped CMS blob as Binary"),
        };
        // Outer CMS is enveloped-data.
        let ci = ContentInfo::from_der(&ciphertext).expect("parse ContentInfo");
        assert_eq!(ci.content_type, const_oid::db::rfc5911::ID_ENVELOPED_DATA);

        let message_id = "msg-sign-and-encrypt";
        seed_message_with_from(&pool, ACCOUNT_ID, message_id, ACCOUNT_EMAIL).await;
        persist_ciphertext(&pool, ACCOUNT_ID, message_id, &ciphertext).await;

        let result = open_crypto_message(&pool, ACCOUNT_ID, message_id)
            .await
            .expect("open_crypto_message ok");
        // THE load-bearing assertion: sign+encrypt round-trips as
        // encrypted-signed (not plain encrypted) — the inner SignedData was
        // recognized + verified.
        assert_eq!(
            result.crypto_result.crypto_kind, "encrypted-signed",
            "sign+encrypt must produce encrypted-signed on receive; got {:?}",
            result.crypto_result.crypto_kind
        );
        assert_eq!(
            result.crypto_result.signature_state, "valid-verified",
            "own key (Personal trust) → ValidVerified; got {:?}",
            result.crypto_result.signature_state
        );
        assert_eq!(result.crypto_result.decrypt_state, "ok");
    }

    /// Fail-closed: encrypting to a recipient with no cert in the keystore
    /// produces `MissingRecipientCert` and emits no ciphertext.
    #[tokio::test]
    async fn apply_crypto_missing_recipient_cert_fails_closed() {
        let h = make_harness(false, &[]).await;
        // nobody@kylins.com has no cert anywhere.
        let draft = SendDraft {
            draft_id: "e2".into(),
            from: addr("alice@kylins.com"),
            to: vec![addr("nobody@kylins.com")],
            subject: "Secret".into(),
            text_body: Some("plain body".into()),
            crypto_method: CryptoMethod::Smime,
            encrypt: true,
            ..Default::default()
        };
        let mime = build_mime(&draft).await.expect("build_mime");
        let err = apply_crypto(
            &h.backend,
            h.keystore.as_ref(),
            &mime,
            &draft,
            &h.account_email,
            None,
            h.pool.as_ref(),
            ACCOUNT_ID,
        )
        .await
        .expect_err("must fail closed");
        assert!(
            matches!(err, CryptoSendError::MissingRecipientCert(ref e) if e.contains("nobody@kylins.com")),
            "expected MissingRecipientCert for nobody, got {err:?}"
        );
    }

    /// Fail-closed (G5 Task 5): a recipient whose cert is RESOLVED (find_by_email
    /// succeeds) but does NOT chain to any configured trust anchor for the
    /// account → `Err(InvalidRecipientCert)` AND `backend.encrypt` is NOT
    /// reached (no ciphertext produced). Constructs the negative case by
    /// seeding bob under his own account (`acct-rcpt-0`) so the keystore
    /// resolves him, but NOT seeding his cert as a trust anchor for ACCOUNT_ID
    /// — so `validate_recipient_certs` rejects him. The negative assertion is
    /// "the function returned an `Err`" → no `backend.encrypt` call, no
    /// ciphertext, no plaintext leak (the existing send_op failure-emit path
    /// surfaces this as `SendResultEvent{success:false}` + `Err`).
    #[tokio::test]
    async fn apply_crypto_invalid_recipient_cert_fails_closed() {
        // bob is seeded under his own account; alice (ACCOUNT_ID) has NOT
        // imported his cert as a trust anchor.
        let h = make_harness(false, &["bob@kylins.com"]).await;
        let draft = SendDraft {
            draft_id: "e3-invalid-rcpt".into(),
            from: addr("alice@kylins.com"),
            to: vec![addr("bob@kylins.com")],
            subject: "Secret".into(),
            text_body: Some("plain body".into()),
            crypto_method: CryptoMethod::Smime,
            encrypt: true,
            ..Default::default()
        };
        let mime = build_mime(&draft).await.expect("build_mime");
        let err = apply_crypto(
            &h.backend,
            h.keystore.as_ref(),
            &mime,
            &draft,
            &h.account_email,
            None,
            h.pool.as_ref(),
            ACCOUNT_ID,
        )
        .await
        .expect_err("recipient cert with no matching anchor must fail-closed");
        assert!(
            matches!(err, CryptoSendError::InvalidRecipientCert(ref msg)
                     if msg.contains("recipient cert #")),
            "expected InvalidRecipientCert with a recipient-cert-indexed message; got {err:?}"
        );
        // Negative check: the recipient (bob) was RESOLVED (or we'd have gotten
        // MissingRecipientCert instead). The error must NOT mention "no S/MIME
        // cert for recipient" — that's a different failure mode.
        assert!(
            !err.to_string().contains("no S/MIME cert for recipient"),
            "must NOT be MissingRecipientCert (recipient IS resolved, just invalid): {err}"
        );
    }

    /// Positive counterpart to `apply_crypto_invalid_recipient_cert_fails_closed`:
    /// when bob's cert IS seeded as a trust anchor for ACCOUNT_ID
    /// (via `seed_anchor_from_account`, the KeyManager "import contact cert"
    /// path), `validate_recipient_certs` accepts him and `apply_crypto`
    /// proceeds to encrypt (no error, ciphertext emitted). Explicitly pins
    /// the GREEN path so the negative test above isn't ambiguous about which
    /// branch failed.
    #[tokio::test]
    async fn apply_crypto_valid_recipient_proceeds_to_encrypt() {
        let h = make_harness(false, &["bob@kylins.com"]).await;
        // Make bob's cert a trust anchor for ACCOUNT_ID ( Thunderbird-style
        // "imported contact cert"). Without this the validation gate rejects
        // bob — see `apply_crypto_invalid_recipient_cert_fails_closed`.
        seed_anchor_from_account(h.pool.as_ref(), ACCOUNT_ID, "acct-rcpt-0").await;
        let draft = SendDraft {
            draft_id: "e4-valid-rcpt".into(),
            from: addr("alice@kylins.com"),
            to: vec![addr("bob@kylins.com")],
            subject: "Secret".into(),
            text_body: Some("plain body".into()),
            crypto_method: CryptoMethod::Smime,
            encrypt: true,
            ..Default::default()
        };
        let mime = build_mime(&draft).await.expect("build_mime");
        let out = apply_crypto(
            &h.backend,
            h.keystore.as_ref(),
            &mime,
            &draft,
            &h.account_email,
            None,
            h.pool.as_ref(),
            ACCOUNT_ID,
        )
        .await
        .expect("valid recipient cert → must proceed to encrypt");
        let s = std::str::from_utf8(&out).expect("output utf-8");
        assert!(
            s.contains("application/pkcs7-mime; smime-type=enveloped-data"),
            "valid recipient → enveloped-data ciphertext; got:\n{s}"
        );
    }

    /// Passthrough: no S/MIME intent → bytes returned unchanged.
    #[tokio::test]
    async fn apply_crypto_passthrough_when_no_crypto() {
        let h = make_harness(false, &[]).await;
        let draft = SendDraft {
            draft_id: "p1".into(),
            from: addr("alice@kylins.com"),
            to: vec![addr("bob@kylins.com")],
            subject: "Plain".into(),
            text_body: Some("plain body".into()),
            ..Default::default()
        };
        let mime = build_mime(&draft).await.expect("build_mime");
        let out = apply_crypto(
            &h.backend,
            h.keystore.as_ref(),
            &mime,
            &draft,
            &h.account_email,
            None,
            h.pool.as_ref(),
            ACCOUNT_ID,
        )
        .await
        .expect("passthrough ok");
        assert_eq!(out, mime, "passthrough must return bytes unchanged");
    }

    // ─── Task 5: validate_recipient_certs unit tests ───
    //
    // These exercise the helper's wiring (chain_ok → Ok, chain_fail → Err with
    // a diagnostic message), NOT the chain engine's per-case coverage (already
    // pinned by chain.rs::spike_tests — expiry, EKU missing, etc.). The
    // "valid" path uses `backend.generate_key` + `export_public` to get a
    // real self-signed S/MIME cert; the "invalid" path uses the same cert
    // but passes an UNRELATED anchor (so the cert doesn't chain → Err).
    //
    // We don't build an "expired" cert inline because that would require
    // pulling `x509-cert` as a backend dev-dep; the "wrong-anchor → Err"
    // path exercises the same `chain_valid=false → Err` wiring in
    // `validate_recipient_certs`. The chain engine's `ValidityPeriod` rejection
    // (expired cert) is already pinned by `chain.rs::spike_tests` and is
    // surfaced identically (`chain_valid=false` + `failure_reason=Some(...)`).

    /// Build a self-signed S/MIME cert + matching DER via the real backend
    /// (uses `cert::build_self_signed_smime_cert` under the hood). The cert's
    /// own DER serves as its trust anchor (self-trust). Returns the cert DER
    /// and the `TempDir` owning the SqlitePool's file; the caller must hold
    /// the TempDir for the test's duration (otherwise the pool's file is
    /// removed mid-test).
    async fn make_cert(email: &str) -> (Vec<u8>, TempDir) {
        let tmp = tempfile::tempdir().expect("tempdir");
        let pool = Arc::new(init_db(tmp.path()).await.expect("init_db"));
        seed_account(&pool, "acct-validate", email).await;
        let ks = Arc::new(SqliteKeyStore::new(pool.clone(), "acct-validate"));
        let backend = SmimeBackend::new(ks.clone(), CryptoPolicy::default_baseline());
        let h = backend
            .generate_key(KeyGenParams {
                standard: Standard::Smime,
                user_id: email.into(),
                algorithm: "ECDSA-P256".into(),
                passphrase: None,
            })
            .await
            .expect("generate_key");
        let cert_der = backend
            .export_public(&h.handle)
            .await
            .expect("export_public");
        (cert_der, tmp)
    }

    /// Valid recipient cert that chains to the supplied anchor → Ok.
    #[tokio::test]
    async fn validate_recipient_certs_valid_returns_ok() {
        let (cert_der, _tmp) = make_cert("rcpt-valid@kylins.com").await;
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_secs();

        let res = validate_recipient_certs(
            std::slice::from_ref(&cert_der),
            // Self-signed cert's own DER is its trust anchor.
            std::slice::from_ref(&cert_der),
            now,
        )
        .await;

        assert!(res.is_ok(), "valid recipient cert → Ok; got Err: {:?}", res);
    }

    /// Recipient cert that does NOT chain to the supplied (unrelated) anchor
    /// → Err with a diagnostic message identifying the failing cert index.
    #[tokio::test]
    async fn validate_recipient_certs_wrong_anchor_returns_err() {
        let (cert_der, _tmp1) = make_cert("rcpt-wrong@kylins.com").await;
        let (unrelated_der, _tmp2) = make_cert("unrelated@kylins.com").await;
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_secs();

        let err = validate_recipient_certs(
            std::slice::from_ref(&cert_der),
            std::slice::from_ref(&unrelated_der),
            now,
        )
        .await
        .expect_err("wrong anchor → Err");

        assert!(
            err.contains("recipient cert #0"),
            "Err must identify the failing cert index; got: {err}"
        );
    }

    /// Multiple recipient certs, all valid → Ok. Exercises the loop.
    #[tokio::test]
    async fn validate_recipient_certs_multiple_valid_returns_ok() {
        let (cert1, _tmp1) = make_cert("rcpt-a@kylins.com").await;
        let (cert2, _tmp2) = make_cert("rcpt-b@kylins.com").await;
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_secs();

        // Pass BOTH certs as both recipients AND anchors (self-trust each).
        let recipients = vec![cert1.clone(), cert2.clone()];
        let anchors = vec![cert1, cert2];
        let res = validate_recipient_certs(&recipients, &anchors, now).await;
        assert!(res.is_ok(), "all-valid recipients → Ok; got Err: {:?}", res);
    }

    /// Multiple recipient certs, the SECOND is invalid → Err identifies #1.
    #[tokio::test]
    async fn validate_recipient_certs_second_invalid_returns_err_with_index() {
        let (cert1, _tmp1) = make_cert("rcpt-good@kylins.com").await;
        let (cert2, _tmp2) = make_cert("rcpt-bad@kylins.com").await;
        let (unrelated, _tmp3) = make_cert("unrelated@kylins.com").await;
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_secs();

        // cert1 chains to itself (OK); cert2 doesn't chain to any anchor →
        // Err on cert #1.
        let recipients = vec![cert1.clone(), cert2];
        let anchors = vec![cert1, unrelated]; // cert2 not in anchors
        let err = validate_recipient_certs(&recipients, &anchors, now)
            .await
            .expect_err("second cert invalid → Err");

        assert!(
            err.contains("recipient cert #1"),
            "Err must identify cert #1 as the failing index; got: {err}"
        );
    }

    /// Empty recipient list → Ok (vacuously true — no certs to validate).
    /// Edge case: `apply_crypto` may call this with `recipients=[]` when
    /// only the sender (encrypt-to-self) is in the loop, and the sender's
    /// cert is validated separately.
    #[tokio::test]
    async fn validate_recipient_certs_empty_list_returns_ok() {
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_secs();
        let res = validate_recipient_certs(&[], &[], now).await;
        assert!(res.is_ok(), "empty recipient list → Ok");
    }

    // ─── G5 Task 3: open_crypto_message orchestrator tests ───
    //
    // These are the load-bearing integration tests for the receive pipeline:
    // generate a key, encrypt (optionally sign) a MIME, persist the ciphertext
    // as `message_bodies.body_mime_ciphertext`, call `open_crypto_message` and
    // assert the decrypted/verified outcome. Three paths are pinned:
    //
    //   1. Encrypt-with-sign (enveloped-then-signed) → decrypt + recursive
    //      verify → decrypt_state=ok, signature_state=valid-verified (our own
    //      key → Personal trust).
    //   2. Encrypt-only (no inner signature) → decrypt_state=ok,
    //      signature_state=not-signed.
    //   3. Opaque-signed-only (no encryption) → decrypt_state=n/a,
    //      signature_state=valid-verified.
    //   4. No decryption key → decrypt_state=no-key.

    /// Test harness for `open_crypto_message`: temp DB + seeded account + a
    /// generated S/MIME key + helpers to persist a ciphertext under a synthetic
    /// message. Account email is `ACCOUNT_EMAIL`; the account's own key is both
    /// the signer (for sign-with) and the encrypt-to-self recipient.
    struct OpenCryptoHarness {
        backend: SmimeBackend,
        signer_handle: crypto_core::KeyHandleRef,
        #[allow(dead_code)]
        pool: Arc<SqlitePool>,
        _tmp: TempDir,
    }

    async fn make_open_crypto_harness() -> OpenCryptoHarness {
        let tmp = tempfile::tempdir().expect("tempdir");
        let pool = Arc::new(init_db(tmp.path()).await.expect("init_db"));
        seed_account(&pool, ACCOUNT_ID, ACCOUNT_EMAIL).await;

        let ks = Arc::new(SqliteKeyStore::new(pool.clone(), ACCOUNT_ID));
        let backend = SmimeBackend::new(ks.clone(), CryptoPolicy::default_baseline());

        // The account's own key — signer + encrypt-to-self recipient.
        let signer_handle = backend
            .generate_key(KeyGenParams {
                standard: Standard::Smime,
                user_id: ACCOUNT_EMAIL.into(),
                algorithm: "ECDSA-P256".into(),
                passphrase: None,
            })
            .await
            .expect("generate own key");

        OpenCryptoHarness {
            backend,
            signer_handle,
            pool,
            _tmp: tmp,
        }
    }

    /// Seed a `threads` + `messages` row with `from_address` set (the FK chain
    /// `message_bodies` requires). Mirrors the seed helpers in
    /// `db/message_bodies.rs::tests` and `db/message_crypto_results.rs::tests`.
    async fn seed_message_with_from(
        pool: &SqlitePool,
        account_id: &str,
        message_id: &str,
        from_address: &str,
    ) {
        sqlx::query(
            "INSERT INTO threads (id, account_id, is_read, last_message_at)
             VALUES (?, ?, 0, 0)",
        )
        .bind(message_id)
        .bind(account_id)
        .execute(pool)
        .await
        .expect("seed thread");
        sqlx::query(
            "INSERT INTO messages (id, account_id, thread_id, from_address, date, is_read, is_starred, body_cached)
             VALUES (?, ?, ?, ?, 0, 0, 0, 0)",
        )
        .bind(message_id)
        .bind(account_id)
        .bind(message_id)
        .bind(from_address)
        .execute(pool)
        .await
        .expect("seed message");
    }

    /// Persist a ciphertext + empty-body placeholder via the same sequence the
    /// IMAP body-fetch path uses: `set_message_body` (creates the row) →
    /// `set_message_ciphertext` (attaches the CMS blob).
    async fn persist_ciphertext(
        pool: &SqlitePool,
        account_id: &str,
        message_id: &str,
        ciphertext: &[u8],
    ) {
        use crate::db::message_bodies::{set_message_body, set_message_ciphertext};
        set_message_body(pool, account_id, message_id, "")
            .await
            .expect("placeholder body");
        set_message_ciphertext(pool, account_id, message_id, ciphertext)
            .await
            .expect("persist ciphertext");
    }

    /// Load-bearing send→receive round-trip: encrypt-with-sign via the
    /// `SmimeBackend::encrypt` `sign_with` arm (which produces
    /// enveloped-then-opaque-signed-data, the canonical S/MIME
    /// sign-then-encrypt composition), persist the ciphertext, call
    /// `open_crypto_message` → the orchestrator decrypts AND recursively
    /// verifies the inner SignedData.
    ///
    /// `signature_state=valid-verified` is the load-bearing assertion: the
    /// signer is the account's own key (Personal trust) so the trust ladder
    /// returns `ValidVerified` (sig OK + chain OK + identity match +
    /// `may_encrypt_to()=true`).
    #[tokio::test]
    async fn open_crypto_message_decrypts_and_verifies_enveloped_then_signed() {
        let h = make_open_crypto_harness().await;
        let pool = h.pool.clone();
        let message_id = "msg-sign-encrypt";

        // Encrypt-with-sign: enveloped-data whose content IS an opaque
        // SignedData (sign-then-encrypt). signer = recipient = own key.
        let plaintext_mime =
            b"Content-Type: text/plain; charset=utf-8\r\n\r\nhello signed+encrypted\r\n";
        let env = h
            .backend
            .encrypt(crypto_core::EncryptOp {
                parts: &[Part {
                    id: PartId("body".into()),
                    kind: PartKind::Body,
                    data: plaintext_mime.to_vec(),
                }],
                serialization: SerializationStrategy::SingleMimeBlob,
                recipients: std::slice::from_ref(&h.signer_handle),
                sign_with: Some(h.signer_handle.clone()),
            })
            .await
            .expect("encrypt+sign");
        let ciphertext = env.parts.first().expect("one part").ciphertext.clone();

        // Sanity: the ciphertext is enveloped-data.
        let ci = ContentInfo::from_der(&ciphertext).expect("parse ContentInfo");
        assert_eq!(ci.content_type, const_oid::db::rfc5911::ID_ENVELOPED_DATA);

        seed_message_with_from(&pool, ACCOUNT_ID, message_id, ACCOUNT_EMAIL).await;
        persist_ciphertext(&pool, ACCOUNT_ID, message_id, &ciphertext).await;

        let result = open_crypto_message(&pool, ACCOUNT_ID, message_id)
            .await
            .expect("open_crypto_message ok");

        assert_eq!(result.crypto_result.decrypt_state, "ok");
        assert_eq!(
            result.crypto_result.signature_state, "valid-verified",
            "own key (Personal trust) + chain OK + identity match → ValidVerified; got {:?}",
            result.crypto_result.signature_state
        );
        assert_eq!(result.crypto_result.crypto_kind, "encrypted-signed");
        // Plaintext round-trips.
        assert!(
            result
                .plaintext_text
                .as_deref()
                .unwrap_or("")
                .contains("hello signed+encrypted"),
            "decrypted text must contain the original body; got {:?}",
            result.plaintext_text
        );
        // Signer fingerprint populated.
        assert!(
            result.crypto_result.signer_fingerprint.is_some(),
            "signer_fingerprint must be populated on ValidVerified"
        );
        assert_eq!(
            result.crypto_result.signer_email.as_deref(),
            Some(ACCOUNT_EMAIL),
            "signer_email is the From: address"
        );
    }

    /// Encrypt-only (no inner signature) via `apply_crypto`. The orchestrator
    /// decrypts but does NOT run the verify path → `signature_state=not-signed`.
    #[tokio::test]
    async fn open_crypto_message_decrypts_encrypt_only_no_signature() {
        let h = make_open_crypto_harness().await;
        let pool = h.pool.clone();
        let message_id = "msg-encrypt-only";

        // Build the enveloped-data via apply_crypto (encrypt-only, sign=false).
        let draft = SendDraft {
            draft_id: "d1".into(),
            from: addr(ACCOUNT_EMAIL),
            to: vec![addr(ACCOUNT_EMAIL)], // encrypt-to-self
            subject: "Secret self-mail".into(),
            text_body: Some("plain encrypted body".into()),
            crypto_method: CryptoMethod::Smime,
            encrypt: true,
            ..Default::default()
        };
        let mime = build_mime(&draft).await.expect("build_mime");
        let wrapped = apply_crypto(
            &h.backend,
            &SqliteKeyStore::new(pool.clone(), ACCOUNT_ID),
            &mime,
            &draft,
            ACCOUNT_EMAIL,
            None,
            &pool,
            ACCOUNT_ID,
        )
        .await
        .expect("apply_crypto encrypt");

        // Extract the CMS DER from the wrapped MIME via mail_parser (same path
        // `extract_raw_ciphertext` uses in the IMAP body-fetch).
        let parsed = mail_parser::MessageParser::default()
            .parse(&wrapped)
            .expect("parse wrapped");
        let ciphertext = parsed
            .body_html(0)
            .or_else(|| parsed.body_text(0))
            .map(|s| s.as_bytes().to_vec())
            .or_else(|| {
                parsed
                    .attachments
                    .iter()
                    .filter_map(|&i| parsed.parts.get(i))
                    .next()
                    .and_then(|p| match &p.body {
                        mail_parser::PartType::Binary(d)
                        | mail_parser::PartType::InlineBinary(d) => Some(d.as_ref().to_vec()),
                        mail_parser::PartType::Text(t) => Some(t.as_bytes().to_vec()),
                        _ => None,
                    })
            })
            .expect("extract ciphertext bytes");
        // Sanity: parses as enveloped-data.
        let ci = ContentInfo::from_der(&ciphertext).expect("parse ContentInfo");
        assert_eq!(ci.content_type, const_oid::db::rfc5911::ID_ENVELOPED_DATA);

        seed_message_with_from(&pool, ACCOUNT_ID, message_id, ACCOUNT_EMAIL).await;
        persist_ciphertext(&pool, ACCOUNT_ID, message_id, &ciphertext).await;

        let result = open_crypto_message(&pool, ACCOUNT_ID, message_id)
            .await
            .expect("open_crypto_message ok");

        assert_eq!(result.crypto_result.decrypt_state, "ok");
        assert_eq!(result.crypto_result.crypto_kind, "encrypted");
        assert_eq!(
            result.crypto_result.signature_state, "not-signed",
            "encrypt-only → no inner signature → not-signed"
        );
        assert!(
            result
                .plaintext_text
                .as_deref()
                .unwrap_or("")
                .contains("plain encrypted body"),
            "decrypted text must contain the original body; got {:?}",
            result.plaintext_text
        );
    }

    /// Opaque-signed-only (no encryption) via `SmimeBackend::sign` (detached=false).
    /// The orchestrator skips decryption and runs the verify path directly →
    /// `decrypt_state=n/a`, `signature_state=valid-verified`.
    #[tokio::test]
    async fn open_crypto_message_verifies_opaque_signed_only() {
        let h = make_open_crypto_harness().await;
        let pool = h.pool.clone();
        let message_id = "msg-opaque-signed";

        // Build an opaque SignedData via backend.sign (detached=false →
        // encapsulated content). This is the `application/pkcs7-mime;
        // smime-type=signed-data` form.
        let plaintext_mime =
            b"Content-Type: text/plain; charset=utf-8\r\n\r\nopaque-signed body\r\n";
        let signed = h
            .backend
            .sign(crypto_core::SignOp {
                signing_key: h.signer_handle.clone(),
                payload: plaintext_mime,
                detached: false,
            })
            .await
            .expect("sign");
        let signed_data_der = signed.signature.signature.clone();

        // Sanity: parses as signed-data.
        let ci = ContentInfo::from_der(&signed_data_der).expect("parse ContentInfo");
        assert_eq!(ci.content_type, const_oid::db::rfc5911::ID_SIGNED_DATA);

        seed_message_with_from(&pool, ACCOUNT_ID, message_id, ACCOUNT_EMAIL).await;
        persist_ciphertext(&pool, ACCOUNT_ID, message_id, &signed_data_der).await;

        let result = open_crypto_message(&pool, ACCOUNT_ID, message_id)
            .await
            .expect("open_crypto_message ok");

        assert_eq!(
            result.crypto_result.decrypt_state, "n/a",
            "no encryption → decrypt_state=n/a"
        );
        assert_eq!(result.crypto_result.crypto_kind, "signed");
        assert_eq!(
            result.crypto_result.signature_state, "valid-verified",
            "own key (Personal trust) + chain OK → ValidVerified; got {:?}",
            result.crypto_result.signature_state
        );
        assert!(
            result
                .plaintext_text
                .as_deref()
                .unwrap_or("")
                .contains("opaque-signed body"),
            "verified text must contain the original body; got {:?}",
            result.plaintext_text
        );
    }

    /// No-decryption-key path: the message was encrypted for a key that is NOT
    /// in this account's keystore → `decrypt_state=no-key`. We simulate this by
    /// encrypting to a key on a DIFFERENT (throwaway) backend, then calling
    /// `open_crypto_message` on the original account which has its own key but
    /// NOT the throwaway one.
    #[tokio::test]
    async fn open_crypto_message_returns_no_key_when_no_matching_decryption_key() {
        let h = make_open_crypto_harness().await;
        let pool = h.pool.clone();
        let message_id = "msg-no-key";

        // Build a SECOND backend + account + key, encrypt to THAT key only.
        // The original account's key is NOT a recipient → no match.
        let other_email = "carol@kylins.com";
        seed_account(&pool, "acct-other", other_email).await;
        let other_ks = Arc::new(SqliteKeyStore::new(pool.clone(), "acct-other"));
        let other_backend = SmimeBackend::new(other_ks, CryptoPolicy::default_baseline());
        let other_handle = other_backend
            .generate_key(KeyGenParams {
                standard: Standard::Smime,
                user_id: other_email.into(),
                algorithm: "ECDSA-P256".into(),
                passphrase: None,
            })
            .await
            .expect("generate other key");

        let plaintext = b"Content-Type: text/plain\r\n\r\nnot for you\r\n";
        let env = other_backend
            .encrypt(crypto_core::EncryptOp {
                parts: &[Part {
                    id: PartId("body".into()),
                    kind: PartKind::Body,
                    data: plaintext.to_vec(),
                }],
                serialization: SerializationStrategy::SingleMimeBlob,
                // Recipient = ONLY the other key (not the account's own key).
                recipients: std::slice::from_ref(&other_handle),
                sign_with: None,
            })
            .await
            .expect("encrypt to other");
        let ciphertext = env.parts.first().expect("one part").ciphertext.clone();

        // Persist under the ORIGINAL account (ACCOUNT_ID) — its key was NOT a
        // recipient. from_address can be anything; this path doesn't reach
        // verify (decrypt_state=no-key early-returns).
        seed_message_with_from(&pool, ACCOUNT_ID, message_id, other_email).await;
        persist_ciphertext(&pool, ACCOUNT_ID, message_id, &ciphertext).await;

        let result = open_crypto_message(&pool, ACCOUNT_ID, message_id)
            .await
            .expect("open_crypto_message returns Ok with decrypt_state=no-key");

        assert_eq!(
            result.crypto_result.decrypt_state, "no-key",
            "no matching decryption key in the account's keystore → no-key"
        );
        assert!(
            result.plaintext_text.is_none() && result.plaintext_html.is_none(),
            "no-key → no plaintext returned"
        );
    }

    /// No-ciphertext edge case: a message with no `body_mime_ciphertext` (a
    /// plain message that wasn't crypto-marked) returns a `Failed` outcome +
    /// no plaintext, rather than an `Err` (so the caller can distinguish
    /// "nothing to do" from a real error).
    #[tokio::test]
    async fn open_crypto_message_no_ciphertext_returns_failed_outcome() {
        let h = make_open_crypto_harness().await;
        let pool = h.pool.clone();
        let message_id = "msg-plain";

        seed_message_with_from(&pool, ACCOUNT_ID, message_id, ACCOUNT_EMAIL).await;
        // No persist_ciphertext call — the row has no ciphertext.

        // The message_bodies row must exist for the orchestrator to find none.
        use crate::db::message_bodies::set_message_body;
        set_message_body(&pool, ACCOUNT_ID, message_id, "<p>plain</p>")
            .await
            .expect("placeholder body");

        let result = open_crypto_message(&pool, ACCOUNT_ID, message_id)
            .await
            .expect("returns Ok with decrypt_state=failed");
        assert_eq!(
            result.crypto_result.decrypt_state, "failed",
            "no ciphertext → decrypt_state=failed (not an Err)"
        );
        assert!(result.plaintext_text.is_none());
        assert!(result.plaintext_html.is_none());
    }

    // ─── G7 Task 2: open_crypto_message clear-signed `multipart/signed` path ───
    //
    // Clear-signed mail has a plaintext body (part 1 of the multipart) + a
    // detached `smime.p7s` signature (part 2). The orchestrator's
    // clear-signed branch:
    //   1. Loads `body_mime_signed_part` (the raw part-1 MIME entity bytes)
    //      AND `body_mime_ciphertext` (the detached p7s SignedData DER).
    //   2. Calls `run_verify_path` in detached mode (covered_content=Some(part1)).
    //   3. Parses part-1 bytes as the plaintext MIME (no decrypt step).
    //
    // These tests build a clear-signed mail via the send side's `apply_crypto`
    // (sign-only), persist both blobs (mirroring the IMAP body-fetch path),
    // and assert the orchestrator verifies the signature and surfaces the
    // plaintext. The cryptographic gate is `signature_state=valid-verified`
    // (the signer is the account's own key → Personal trust).

    /// Helper mirroring `mail::imap::client::extract_clear_signed_parts` for
    /// test setup: parse a built `multipart/signed` MIME and return
    /// `(part1_bytes, p7s_der)`. Used to derive the two blobs to persist from
    /// `apply_crypto`'s output, exactly as the IMAP body-fetch path would.
    fn parse_clear_signed_blobs(wrapped: &[u8]) -> (Vec<u8>, Vec<u8>) {
        let parsed = mail_parser::MessageParser::default()
            .parse(wrapped)
            .expect("multipart/signed output must parse");
        // Top-level Content-Type MUST be multipart/signed.
        let ct = parsed.content_type().expect("Content-Type present");
        let full = match ct.subtype() {
            Some(sub) => format!("{}/{}", ct.ctype(), sub).to_lowercase(),
            None => ct.ctype().to_lowercase(),
        };
        assert_eq!(
            full, "multipart/signed",
            "apply_crypto sign-only must produce multipart/signed"
        );
        let root = parsed.parts.first().expect("root part");
        let kids: &[usize] = match &root.body {
            mail_parser::PartType::Multipart(ids) => ids.as_ref(),
            _ => panic!("root must be multipart"),
        };
        assert_eq!(kids.len(), 2, "multipart/signed has exactly two parts");
        let p1 = &parsed.parts[kids[0]];
        // Slice raw part-1 entity bytes + canonicalize trailing CRLF (same
        // logic as `extract_clear_signed_parts` in `mail::imap::client`).
        let mut part1 = parsed.raw_message[p1.offset_header..p1.offset_end].to_vec();
        if !part1.ends_with(b"\r\n") {
            part1.extend_from_slice(b"\r\n");
        }
        let p7s_part = &parsed.parts[kids[1]];
        let p7s_der: Vec<u8> = match &p7s_part.body {
            mail_parser::PartType::Binary(d) | mail_parser::PartType::InlineBinary(d) => {
                d.as_ref().to_vec()
            }
            mail_parser::PartType::Text(t) => t.as_bytes().to_vec(),
            _ => panic!("p7s part must be Binary or Text"),
        };
        (part1, p7s_der)
    }

    /// Persist both blobs needed for the clear-signed branch: the raw part-1
    /// MIME entity bytes via `set_message_signed_part` AND the detached p7s
    /// SignedData DER via `set_message_ciphertext` (the column is overloaded
    /// across opaque pkcs7-mime and clear-signed multipart/signed — both carry
    /// a raw CMS blob the orchestrator must process).
    async fn persist_clear_signed(
        pool: &SqlitePool,
        account_id: &str,
        message_id: &str,
        part1: &[u8],
        p7s_der: &[u8],
    ) {
        use crate::db::message_bodies::{
            set_message_body, set_message_ciphertext, set_message_signed_part,
        };
        // Row must exist before the UPDATEs.
        set_message_body(pool, account_id, message_id, "")
            .await
            .expect("placeholder body");
        set_message_ciphertext(pool, account_id, message_id, p7s_der)
            .await
            .expect("persist p7s ciphertext");
        set_message_signed_part(pool, account_id, message_id, part1)
            .await
            .expect("persist signed part");
    }

    /// Load-bearing clear-signed round-trip: `apply_crypto` (sign-only) →
    /// persist both blobs → `open_crypto_message` →
    /// `decrypt_state=n/a`, `signature_state=valid-verified`, plaintext
    /// contains the original body. Proves the clear-signed branch verifies
    /// the detached signature over the raw part-1 MIME entity bytes.
    #[tokio::test]
    async fn open_crypto_message_verifies_clear_signed_multipart_signed() {
        let h = make_open_crypto_harness().await;
        let pool = h.pool.clone();
        let message_id = "msg-clear-signed";

        // Flag the account's own key as the default signing key so apply_crypto
        // can sign. (make_open_crypto_harness doesn't flag it by default.)
        let own_fp = h.signer_handle.fingerprint.as_str().to_string();
        sqlx::query("UPDATE crypto_keys SET is_default_sign = 1 WHERE fingerprint = ?")
            .bind(&own_fp)
            .execute(pool.as_ref())
            .await
            .expect("flag default signer");
        let signer_row = crate::db::crypto_keys::get_default_signing_key(pool.as_ref(), ACCOUNT_ID)
            .await
            .expect("query default signing key");

        // Build a clear-signed multipart/signed via apply_crypto (sign-only).
        let draft = SendDraft {
            draft_id: "clear1".into(),
            from: addr(ACCOUNT_EMAIL),
            to: vec![addr("bob@kylins.com")],
            subject: "Clear Signed".into(),
            text_body: Some("clear-signed plaintext body".into()),
            crypto_method: CryptoMethod::Smime,
            sign: true,
            ..Default::default()
        };
        let mime = build_mime(&draft).await.expect("build_mime");
        let wrapped = apply_crypto(
            &h.backend,
            &SqliteKeyStore::new(pool.clone(), ACCOUNT_ID),
            &mime,
            &draft,
            ACCOUNT_EMAIL,
            signer_row.as_ref(),
            &pool,
            ACCOUNT_ID,
        )
        .await
        .expect("apply_crypto sign-only");

        // Sanity: the wrapped output IS a multipart/signed.
        let wrapped_str = std::str::from_utf8(&wrapped).unwrap_or("");
        assert!(
            wrapped_str.contains("multipart/signed"),
            "apply_crypto sign-only must produce multipart/signed; got:\n{wrapped_str}"
        );
        assert!(
            wrapped_str.contains("application/pkcs7-signature"),
            "multipart/signed must carry the detached signature part"
        );

        // Derive the part-1 bytes + p7s DER from the wrapped output, exactly as
        // the IMAP body-fetch path would (extract_clear_signed_parts).
        let (part1, p7s_der) = parse_clear_signed_blobs(&wrapped);

        // Sanity: the p7s DER parses as a SignedData ContentInfo.
        let ci = ContentInfo::from_der(&p7s_der).expect("parse ContentInfo");
        assert_eq!(
            ci.content_type,
            const_oid::db::rfc5911::ID_SIGNED_DATA,
            "p7s must be id-signed-data"
        );

        seed_message_with_from(&pool, ACCOUNT_ID, message_id, ACCOUNT_EMAIL).await;
        persist_clear_signed(&pool, ACCOUNT_ID, message_id, &part1, &p7s_der).await;

        let result = open_crypto_message(&pool, ACCOUNT_ID, message_id)
            .await
            .expect("open_crypto_message ok");

        assert_eq!(
            result.crypto_result.crypto_kind, "signed",
            "clear-signed → crypto_kind=signed"
        );
        assert_eq!(
            result.crypto_result.decrypt_state, "n/a",
            "clear-signed → no decrypt step → decrypt_state=n/a"
        );
        assert_eq!(
            result.crypto_result.signature_state, "valid-verified",
            "clear-signed + own key (Personal trust) + chain OK + identity match → ValidVerified; got {:?}",
            result.crypto_result.signature_state
        );
        assert!(
            result.crypto_result.signer_fingerprint.is_some(),
            "signer_fingerprint must be populated on ValidVerified"
        );
        assert_eq!(
            result.crypto_result.signer_email.as_deref(),
            Some(ACCOUNT_EMAIL),
            "signer_email is the From: address"
        );
        // Plaintext round-trips — the part-1 MIME parses into text+html.
        assert!(
            result
                .plaintext_text
                .as_deref()
                .unwrap_or("")
                .contains("clear-signed plaintext body"),
            "decrypted text must contain the original body; got {:?}",
            result.plaintext_text
        );
    }

    /// `get_signer_details` returns `None` when the message has no persisted
    /// `message_crypto_results` row (never opened through the crypto path).
    /// Pins the prologue DB read.
    #[tokio::test]
    async fn get_signer_details_returns_none_when_no_crypto_result_row() {
        let h = make_open_crypto_harness().await;
        let pool = h.pool.clone();
        let message_id = "msg-no-row";
        seed_message_with_from(&pool, ACCOUNT_ID, message_id, ACCOUNT_EMAIL).await;
        use crate::db::message_bodies::set_message_body;
        set_message_body(&pool, ACCOUNT_ID, message_id, "")
            .await
            .expect("placeholder body");

        let details = get_signer_details(&pool, ACCOUNT_ID, message_id)
            .await
            .expect("get_signer_details ok");
        assert!(details.is_none(), "no persisted row → None");
    }

    /// `get_signer_details` re-parses the cached clear-signed p7s to surface
    /// the signer leaf cert + chain path. Mirrors the clear-signed round-trip
    /// (`open_crypto_message_verifies_clear_signed_multipart_signed`): build a
    /// signed multipart/signed via `apply_crypto`, persist part1 + p7s, open
    /// (writes the `message_crypto_results` row), then call
    /// `get_signer_details` and assert the signer cert + chain path parsed.
    #[tokio::test]
    async fn get_signer_details_parses_signer_for_clear_signed() {
        let h = make_open_crypto_harness().await;
        let pool = h.pool.clone();
        let message_id = "msg-signer-details";

        let own_fp = h.signer_handle.fingerprint.as_str().to_string();
        sqlx::query("UPDATE crypto_keys SET is_default_sign = 1 WHERE fingerprint = ?")
            .bind(&own_fp)
            .execute(pool.as_ref())
            .await
            .expect("flag default signer");
        let signer_row = crate::db::crypto_keys::get_default_signing_key(pool.as_ref(), ACCOUNT_ID)
            .await
            .expect("query default signing key");

        let draft = SendDraft {
            draft_id: "sd1".into(),
            from: addr(ACCOUNT_EMAIL),
            to: vec![addr("bob@kylins.com")],
            subject: "Signer Details".into(),
            text_body: Some("signer details body".into()),
            crypto_method: CryptoMethod::Smime,
            sign: true,
            ..Default::default()
        };
        let mime = build_mime(&draft).await.expect("build_mime");
        let wrapped = apply_crypto(
            &h.backend,
            &SqliteKeyStore::new(pool.clone(), ACCOUNT_ID),
            &mime,
            &draft,
            ACCOUNT_EMAIL,
            signer_row.as_ref(),
            &pool,
            ACCOUNT_ID,
        )
        .await
        .expect("apply_crypto sign-only");
        let (part1, p7s_der) = parse_clear_signed_blobs(&wrapped);

        seed_message_with_from(&pool, ACCOUNT_ID, message_id, ACCOUNT_EMAIL).await;
        persist_clear_signed(&pool, ACCOUNT_ID, message_id, &part1, &p7s_der).await;

        // Open first so the `message_crypto_results` row is written (signer
        // fingerprint, signature_state, etc.).
        let _ = open_crypto_message(&pool, ACCOUNT_ID, message_id)
            .await
            .expect("open_crypto_message ok");

        let details = get_signer_details(&pool, ACCOUNT_ID, message_id)
            .await
            .expect("get_signer_details ok")
            .expect("details present after open");

        // Persisted verdict surfaces straight through.
        assert_eq!(details.crypto_kind, "signed");
        assert_eq!(details.signature_state, "valid-verified");
        // The signer leaf re-parsed from the cached p7s.
        let signer = details
            .signer
            .as_ref()
            .expect("signer leaf parsed for clear-signed");
        assert!(signer.subject_cn.is_some(), "subject CN parsed");
        assert!(!signer.serial_hex.is_empty(), "serial parsed");
        assert!(!signer.fingerprint.is_empty(), "fingerprint attached");
        assert!(
            !signer.public_key_algorithm_oid.is_empty(),
            "pubkey alg OID parsed"
        );
        assert!(
            !signer.signature_algorithm_oid.is_empty(),
            "sig alg OID parsed"
        );
        assert!(
            signer.not_after_unix > signer.not_before_unix,
            "validity window sane"
        );
        // The account's own key is in the anchor set (keystore_bridge quirk),
        // so the chain path has at least one anchor entry.
        assert!(
            details.chain_path.iter().any(|e| e.is_anchor),
            "chain path must include the account's trust anchor; got {:?}",
            details.chain_path
        );
        // Own key → Personal trust.
        assert_eq!(details.trust_state, "personal", "own key → Personal trust");
    }

    // ─── Granular ChainOutcome persistence + retrieval (2026-07-18 spec) ───
    //
    // The granular `failure_reason` surfaced by `SmimeBackend::verify_with_context`
    // (now threaded through `VerificationResult.failure_reason`) MUST reach the
    // persisted `message_crypto_results.failure_reason` column, and
    // `get_signer_details` MUST return it (falling back to the fixed
    // `failure_reason_for_state` map when NULL — the dialog's null-fallback).

    /// `build_crypto_result_row` (called via `finish_open_crypto`) persists the
    /// real `VerificationResult.failure_reason` for a failing verification — NOT
    /// NULL, NOT the coarse fixed-map string. Driven via a real
    /// `open_crypto_message` call so the entire threading path
    /// (`run_verify_path` → `finish_open_crypto` → `build_crypto_result_row` →
    /// `upsert_message_crypto_result`) is exercised.
    ///
    /// Scenario: clear-signed mail signed by the account's own key (SAN =
    /// ACCOUNT_EMAIL), but the seeded `messages.from_address` is a DIFFERENT
    /// address. The orchestrator's identity binding (From↔SAN) fails →
    /// `signature_state=mismatch` + a granular reason containing
    /// "identity mismatch". Without end-to-end threading, the row's
    /// `failure_reason` would be NULL and the dialog would fall back to the
    /// generic "Signer identity does not match…" fixed-map string.
    #[tokio::test]
    async fn build_crypto_result_row_persists_failure_reason() {
        let h = make_open_crypto_harness().await;
        let pool = h.pool.clone();
        let message_id = "msg-fr-persist";

        let own_fp = h.signer_handle.fingerprint.as_str().to_string();
        sqlx::query("UPDATE crypto_keys SET is_default_sign = 1 WHERE fingerprint = ?")
            .bind(&own_fp)
            .execute(pool.as_ref())
            .await
            .expect("flag default signer");
        let signer_row = crate::db::crypto_keys::get_default_signing_key(pool.as_ref(), ACCOUNT_ID)
            .await
            .expect("query default signing key");

        // Sign with ACCOUNT_EMAIL (the own-key SAN).
        let draft = SendDraft {
            draft_id: "fr-persist".into(),
            from: addr(ACCOUNT_EMAIL),
            to: vec![addr("bob@kylins.com")],
            subject: "FailureReason Persist".into(),
            text_body: Some("clear-signed body for fr persistence".into()),
            crypto_method: CryptoMethod::Smime,
            sign: true,
            ..Default::default()
        };
        let mime = build_mime(&draft).await.expect("build_mime");
        let wrapped = apply_crypto(
            &h.backend,
            &SqliteKeyStore::new(pool.clone(), ACCOUNT_ID),
            &mime,
            &draft,
            ACCOUNT_EMAIL,
            signer_row.as_ref(),
            &pool,
            ACCOUNT_ID,
        )
        .await
        .expect("apply_crypto sign-only");
        let (part1, p7s_der) = parse_clear_signed_blobs(&wrapped);

        // Seed the message with a From address that does NOT match the signer's
        // SAN (ACCOUNT_EMAIL). The identity binding fails → Mismatch +
        // failure_reason = "identity mismatch: …".
        seed_message_with_from(&pool, ACCOUNT_ID, message_id, "imposter@kylins.com").await;
        persist_clear_signed(&pool, ACCOUNT_ID, message_id, &part1, &p7s_der).await;

        let result = open_crypto_message(&pool, ACCOUNT_ID, message_id)
            .await
            .expect("open_crypto_message ok");

        assert_eq!(
            result.crypto_result.signature_state, "mismatch",
            "From↔SAN mismatch → Mismatch; got {:?}",
            result.crypto_result.signature_state
        );
        // The persisted failure_reason is the granular reason (NOT NULL, NOT
        // the fixed-map string). Drives the dialog's real-reason banner.
        let persisted = result.crypto_result.failure_reason.as_ref().expect(
            "failure_reason column must be non-NULL for a Mismatch (the real reason was threaded through)",
        );
        assert!(
            persisted.to_lowercase().contains("identity mismatch"),
            "persisted failure_reason must carry the granular 'identity mismatch' detail; got {persisted:?}"
        );

        // Re-read from the DB to confirm the column actually holds the value
        // (not just the in-memory OpenCryptoResult.crypto_result echo).
        let row = crate::db::message_crypto_results::get_message_crypto_result(
            pool.as_ref(),
            ACCOUNT_ID,
            message_id,
        )
        .await
        .expect("get_message_crypto_result ok")
        .expect("row present");
        assert_eq!(
            row.failure_reason.as_deref(),
            result.crypto_result.failure_reason.as_deref(),
            "DB row failure_reason must mirror OpenCryptoResult.crypto_result.failure_reason"
        );
    }

    /// `get_signer_details` surfaces the persisted `failure_reason` straight
    /// through when the column is non-NULL (real reason wins over the
    /// fixed-map fallback). A NULL row → the dialog's null-fallback path
    /// (`failure_reason_for_state`) kicks in, returning the coarse map string.
    ///
    /// Two arms:
    ///   (a) row.failure_reason = Some("custom reason") → details.failure_reason
    ///       == Some("custom reason") (verbatim — no fixed-map fallback).
    ///   (b) row.failure_reason = None (pre-migration rows + early-return arms)
    ///       → details.failure_reason == failure_reason_for_state(signature_state)
    ///       (the coarse map — no regression for rows without a real reason).
    #[tokio::test]
    async fn get_signer_details_returns_persisted_failure_reason() {
        let h = make_open_crypto_harness().await;
        let pool = h.pool.clone();

        // ── (a) Real reason persisted → surfaces verbatim ──────────────────
        let msg_with_reason = "msg-details-with-reason";
        seed_message_with_from(&pool, ACCOUNT_ID, msg_with_reason, ACCOUNT_EMAIL).await;
        // Minimal row shape: invalid signature_state + a non-NULL failure_reason
        // value the dialog must render verbatim. The get_signer_details query
        // reads the row as-is — no transformation.
        let row_with = crate::db::message_crypto_results::MessageCryptoResultRow {
            account_id: ACCOUNT_ID.into(),
            message_id: msg_with_reason.into(),
            crypto_kind: "signed".into(),
            decrypt_state: "n/a".into(),
            signature_state: "invalid".into(),
            signer_fingerprint: Some("fp1".into()),
            signer_email: Some(ACCOUNT_EMAIL.into()),
            chain_valid: Some(0),
            revocation_state: "unchecked".into(),
            verified_at: "1770000000".into(),
            failure_reason: Some("certificate revoked (KeyCompromise)".into()),
            revocation_reason: None,
        };
        crate::db::message_crypto_results::upsert_message_crypto_result(pool.as_ref(), &row_with)
            .await
            .expect("seed row with failure_reason");

        let details_with = get_signer_details(pool.as_ref(), ACCOUNT_ID, msg_with_reason)
            .await
            .expect("get_signer_details ok (a)")
            .expect("details present (a)");
        assert_eq!(
            details_with.failure_reason.as_deref(),
            Some("certificate revoked (KeyCompromise)"),
            "(a) real failure_reason must surface verbatim, NOT the fixed-map string"
        );

        // ── (b) NULL failure_reason → fall back to the fixed-map ───────────
        let msg_null = "msg-details-null-reason";
        seed_message_with_from(&pool, ACCOUNT_ID, msg_null, ACCOUNT_EMAIL).await;
        let row_null = crate::db::message_crypto_results::MessageCryptoResultRow {
            account_id: ACCOUNT_ID.into(),
            message_id: msg_null.into(),
            crypto_kind: "signed".into(),
            decrypt_state: "n/a".into(),
            signature_state: "invalid".into(),
            signer_fingerprint: None,
            signer_email: None,
            chain_valid: Some(0),
            revocation_state: "unchecked".into(),
            verified_at: "1770000000".into(),
            failure_reason: None,
            revocation_reason: None,
        };
        crate::db::message_crypto_results::upsert_message_crypto_result(pool.as_ref(), &row_null)
            .await
            .expect("seed row with NULL failure_reason");

        let details_null = get_signer_details(pool.as_ref(), ACCOUNT_ID, msg_null)
            .await
            .expect("get_signer_details ok (b)")
            .expect("details present (b)");
        // NULL → fallback to the fixed-map string for `invalid`.
        assert_eq!(
            details_null.failure_reason.as_deref(),
            failure_reason_for_state("invalid").as_deref(),
            "(b) NULL failure_reason must fall back to the fixed-map string for the state"
        );
        assert_ne!(
            details_null.failure_reason, details_with.failure_reason,
            "(b) fallback must produce a different value than the real reason in (a)"
        );
    }

    // ─── CRL Revocation Detail persistence + retrieval (2026-07-18 spec) ───
    //
    // The structured RFC 5280 CRLReason surfaced by `SmimeBackend::verify_with_context`
    // (now threaded through `VerificationResult.revocation_reason`) MUST reach
    // the persisted `message_crypto_results.revocation_reason` column, and
    // `get_signer_details` MUST return it. The crypto-smime test
    // `verify_with_context_surfaces_revocation_reason` already pins the source
    // of the value at the crypto layer; these two backend tests pin the
    // persistence + retrieval round-trip.

    /// `build_crypto_result_row` persists the `revocation_reason` arg into the
    /// new `message_crypto_results.revocation_reason` column (not dropped).
    /// The row builder is the load-bearing boundary between
    /// `verify_with_context`'s `VerificationResult.revocation_reason` and the
    /// persisted column — a regression here would silently lose the structured
    /// reason. Driven via a direct call to `build_crypto_result_row` + a real
    /// `upsert_message_crypto_result` + `get_message_crypto_result` round-trip
    /// so the column actually exists and the value survives the SQL boundary.
    #[tokio::test]
    async fn build_crypto_result_row_persists_revocation_reason() {
        let tmp = tempfile::tempdir().expect("tempdir");
        let pool = Arc::new(init_db(tmp.path()).await.expect("init_db"));
        seed_account(&pool, ACCOUNT_ID, ACCOUNT_EMAIL).await;
        // Seed the FK thread + message the row's PK requires.
        seed_message_with_from(&pool, ACCOUNT_ID, "msg-rev-reason", ACCOUNT_EMAIL).await;

        // Build the row with a revoked-cert outcome: signature_state=Invalid,
        // revocation_reason=Some("KeyCompromise"). The row builder threads
        // this through to the new column.
        let row = build_crypto_result_row(
            ACCOUNT_ID,
            "msg-rev-reason",
            "signed",
            "n/a",
            SignatureState::Invalid,
            Some("fp-rev".into()),
            Some(ACCOUNT_EMAIL.into()),
            // failure_reason still threaded in parallel (unchanged).
            Some("certificate 0x123 revoked (KeyCompromise)".into()),
            // The structured RFC 5280 CRLReason name — the new field.
            Some("KeyCompromise".into()),
        );
        upsert_message_crypto_result(pool.as_ref(), &row)
            .await
            .expect("upsert row with revocation_reason");

        // Read back from the DB to confirm the column actually holds the value
        // (not just the in-memory row echo).
        let persisted = crate::db::message_crypto_results::get_message_crypto_result(
            pool.as_ref(),
            ACCOUNT_ID,
            "msg-rev-reason",
        )
        .await
        .expect("get_message_crypto_result ok")
        .expect("row present");
        assert_eq!(
            persisted.revocation_reason.as_deref(),
            Some("KeyCompromise"),
            "revocation_reason column must carry the structured CRLReason name verbatim"
        );
        // failure_reason is still threaded in parallel — both columns coexist.
        assert!(
            persisted
                .failure_reason
                .as_ref()
                .map(|r| r.to_lowercase().contains("revoke"))
                .unwrap_or(false),
            "failure_reason column should still carry the verbose revocation summary; got {:?}",
            persisted.failure_reason
        );

        // Also exercise the NULL arm: a non-revoked outcome (e.g. Mismatch)
        // threads revocation_reason=None through to the column. NULL is the
        // canonical "no reason" value — the dialog omits the "Reason: …" line.
        let row_null = build_crypto_result_row(
            ACCOUNT_ID,
            "msg-rev-reason-null",
            "signed",
            "n/a",
            SignatureState::Mismatch,
            Some("fp-mismatch".into()),
            Some(ACCOUNT_EMAIL.into()),
            Some("identity mismatch: ...".into()),
            // Non-revoked outcome → no revocation reason to surface.
            None,
        );
        seed_message_with_from(&pool, ACCOUNT_ID, "msg-rev-reason-null", ACCOUNT_EMAIL).await;
        upsert_message_crypto_result(pool.as_ref(), &row_null)
            .await
            .expect("upsert row with NULL revocation_reason");
        let persisted_null = crate::db::message_crypto_results::get_message_crypto_result(
            pool.as_ref(),
            ACCOUNT_ID,
            "msg-rev-reason-null",
        )
        .await
        .expect("get_message_crypto_result ok (null)")
        .expect("row present (null)");
        assert!(
            persisted_null.revocation_reason.is_none(),
            "non-revoked outcome must persist NULL revocation_reason; got {:?}",
            persisted_null.revocation_reason
        );
    }

    /// `get_signer_details` surfaces the persisted `revocation_reason` column
    /// straight through when non-NULL. The dialog renders it as a distinct
    /// "Reason: <name>" line (independent of the failure_reason banner).
    /// NULL row → the dialog's null-fallback path omits the reason line
    /// (no fixed-map fallback for revocation_reason — it's structured data,
    /// not free-form text).
    #[tokio::test]
    async fn get_signer_details_returns_revocation_reason() {
        let h = make_open_crypto_harness().await;
        let pool = h.pool.clone();

        // ── (a) Real reason persisted → surfaces verbatim ──────────────────
        let msg_with_reason = "msg-details-with-rev-reason";
        seed_message_with_from(&pool, ACCOUNT_ID, msg_with_reason, ACCOUNT_EMAIL).await;
        let row_with = crate::db::message_crypto_results::MessageCryptoResultRow {
            account_id: ACCOUNT_ID.into(),
            message_id: msg_with_reason.into(),
            crypto_kind: "signed".into(),
            decrypt_state: "n/a".into(),
            signature_state: "invalid".into(),
            signer_fingerprint: Some("fp1".into()),
            signer_email: Some(ACCOUNT_EMAIL.into()),
            chain_valid: Some(0),
            revocation_state: "revoked".into(),
            verified_at: "1770000000".into(),
            failure_reason: Some("certificate revoked (KeyCompromise)".into()),
            revocation_reason: Some("KeyCompromise".into()),
        };
        crate::db::message_crypto_results::upsert_message_crypto_result(pool.as_ref(), &row_with)
            .await
            .expect("seed row with revocation_reason");

        let details_with = get_signer_details(pool.as_ref(), ACCOUNT_ID, msg_with_reason)
            .await
            .expect("get_signer_details ok (a)")
            .expect("details present (a)");
        assert_eq!(
            details_with.revocation_reason.as_deref(),
            Some("KeyCompromise"),
            "(a) real revocation_reason must surface verbatim through get_signer_details"
        );

        // ── (b) NULL revocation_reason → surfaces as None ──────────────────
        let msg_null = "msg-details-null-rev-reason";
        seed_message_with_from(&pool, ACCOUNT_ID, msg_null, ACCOUNT_EMAIL).await;
        let row_null = crate::db::message_crypto_results::MessageCryptoResultRow {
            account_id: ACCOUNT_ID.into(),
            message_id: msg_null.into(),
            crypto_kind: "signed".into(),
            decrypt_state: "n/a".into(),
            signature_state: "invalid".into(),
            signer_fingerprint: None,
            signer_email: None,
            chain_valid: Some(0),
            revocation_state: "unchecked".into(),
            verified_at: "1770000000".into(),
            failure_reason: None,
            revocation_reason: None,
        };
        crate::db::message_crypto_results::upsert_message_crypto_result(pool.as_ref(), &row_null)
            .await
            .expect("seed row with NULL revocation_reason");

        let details_null = get_signer_details(pool.as_ref(), ACCOUNT_ID, msg_null)
            .await
            .expect("get_signer_details ok (b)")
            .expect("details present (b)");
        // NULL surfaces as None — no fixed-map fallback for revocation_reason
        // (unlike failure_reason). The dialog omits the "Reason: …" line.
        assert!(
            details_null.revocation_reason.is_none(),
            "(b) NULL revocation_reason must surface as None (no fixed-map fallback)"
        );
        assert_ne!(
            details_null.revocation_reason, details_with.revocation_reason,
            "(b) NULL must differ from the real reason in (a)"
        );
    }

    /// Clear-signed with a tampered part-1 byte (one byte flipped between
    /// persist and open) → the detached signature MUST NOT verify
    /// (`signature_state=invalid`). Pins the cryptographic gate: the
    /// orchestrator hashes the EXACT part-1 bytes, not a decoded/reserialized
    /// version (the load-bearing correctness property for Thunderbird interop).
    #[tokio::test]
    async fn open_crypto_message_clear_signed_tampered_part1_is_invalid() {
        let h = make_open_crypto_harness().await;
        let pool = h.pool.clone();
        let message_id = "msg-clear-tampered";

        let own_fp = h.signer_handle.fingerprint.as_str().to_string();
        sqlx::query("UPDATE crypto_keys SET is_default_sign = 1 WHERE fingerprint = ?")
            .bind(&own_fp)
            .execute(pool.as_ref())
            .await
            .expect("flag default signer");
        let signer_row = crate::db::crypto_keys::get_default_signing_key(pool.as_ref(), ACCOUNT_ID)
            .await
            .expect("query default signing key");

        let draft = SendDraft {
            draft_id: "clear-tamper".into(),
            from: addr(ACCOUNT_EMAIL),
            to: vec![addr("bob@kylins.com")],
            subject: "Tampered".into(),
            text_body: Some("original clear-signed body".into()),
            crypto_method: CryptoMethod::Smime,
            sign: true,
            ..Default::default()
        };
        let mime = build_mime(&draft).await.expect("build_mime");
        let wrapped = apply_crypto(
            &h.backend,
            &SqliteKeyStore::new(pool.clone(), ACCOUNT_ID),
            &mime,
            &draft,
            ACCOUNT_EMAIL,
            signer_row.as_ref(),
            &pool,
            ACCOUNT_ID,
        )
        .await
        .expect("apply_crypto sign-only");

        let (mut part1, p7s_der) = parse_clear_signed_blobs(&wrapped);

        // Tamper: flip a byte in the part-1 body region (well past the MIME
        // headers so it lands in the signed content, not a header). Find the
        // blank-line + body start.
        let blank_off = part1
            .windows(4)
            .position(|w| w == b"\r\n\r\n")
            .expect("part1 has a header/body blank");
        let body_start = blank_off + 4;
        // Flip a byte in the body (NOT the trailing CRLF).
        if part1.len() > body_start + 2 {
            part1[body_start] ^= 0x20; // flip case of a letter
        }

        seed_message_with_from(&pool, ACCOUNT_ID, message_id, ACCOUNT_EMAIL).await;
        persist_clear_signed(&pool, ACCOUNT_ID, message_id, &part1, &p7s_der).await;

        let result = open_crypto_message(&pool, ACCOUNT_ID, message_id)
            .await
            .expect("open_crypto_message ok (signature check fails soft)");

        assert_eq!(
            result.crypto_result.crypto_kind, "signed",
            "still crypto_kind=signed even when verify fails"
        );
        assert_eq!(
            result.crypto_result.signature_state, "invalid",
            "tampered part-1 bytes → signature must NOT verify (got {:?}); \
             this gate pins that the orchestrator hashes the EXACT persisted bytes \
             (not a re-decoded body_text), which is load-bearing for Thunderbird interop",
            result.crypto_result.signature_state
        );
    }

    // ─── Persist + Use .p12 Chain Intermediates (2026-07-18 spec) ───
    //
    // Drives `run_verify_path` directly (the private async fn the orchestrator
    // calls) so we can assert the merge of SignedData + stored intermediates
    // without going through the full `open_crypto_message` pipeline. The
    // fixture builds a real CA → leaf chain (CA self-signed, leaf signed by CA),
    // embeds ONLY the leaf in the SignedData cert set, and persists the CA as
    // a `key_type='intermediate'` row. Without the merge, the chain cannot
    // link leaf → CA → anchor and validation fails; with the merge it succeeds.

    /// `run_verify_path` merges stored intermediates: a SignedData whose chain
    /// NEEDS an intermediate NOT in its cert set BUT stored as
    /// `key_type='intermediate'` validates (previously failed). The negative
    /// case (no stored intermediate) is also asserted to confirm no trust
    /// weakening (the intermediate alone, with no anchor, must NOT validate).
    #[tokio::test]
    async fn run_verify_path_uses_stored_intermediates() {
        let tmp = tempfile::tempdir().expect("tempdir");
        let pool = Arc::new(init_db(tmp.path()).await.expect("init_db"));
        seed_account(&pool, ACCOUNT_ID, ACCOUNT_EMAIL).await;

        // 3-cert chain fixture: root (self-signed CA) → intermediate (signed
        // by root, CA:TRUE) → leaf (signed by intermediate, S/MIME leaf).
        // The root is the trust anchor; the intermediate is the cert we'll
        // persist as `key_type='intermediate'`; the leaf is the signer in the
        // SignedData. The SignedData embeds ONLY the leaf — the chain cannot
        // link leaf → root without the stored intermediate.
        let root = crypto_smime::testing::build_self_signed_ca("Test Chain Root");
        let intermediate =
            crypto_smime::testing::build_intermediate_signed_by("Test Chain Intermediate", &root);
        let leaf =
            crypto_smime::testing::build_leaf_signed_by("stored-inter@kylins.com", &intermediate);

        // Register the ROOT as the trust anchor (`key_type='cert'`).
        let anchor_fp =
            crypto_smime::fingerprint_of_cert_der(&root.cert_der).expect("root fingerprint");
        let anchor_row = crate::db::crypto_keys::CryptoKeyRecord {
            row: crate::db::crypto_keys::CryptoKeyRow {
                id: String::new(),
                account_id: ACCOUNT_ID.into(),
                standard: "smime".into(),
                key_type: "cert".into(),
                email: None,
                fingerprint: anchor_fp.clone(),
                origin: "imported".into(),
                ..Default::default()
            },
            public_data: hex::encode(&root.cert_der),
            private_data: None,
            policy_json: None,
        };
        crate::db::crypto_keys::upsert_crypto_key(&pool, &anchor_row)
            .await
            .expect("seed root as anchor");

        // Build a SignedData signed by the leaf, with ONLY the leaf in the
        // cert set (no intermediate embedded).
        let signed_data_der = crypto_smime::testing::build_signed_data_with_certs(
            b"stored-intermediate payload",
            &leaf.cert_der,
            &leaf.priv_pkcs8_der,
            &[],
        );

        let ks = Arc::new(SqliteKeyStore::new(pool.clone(), ACCOUNT_ID));
        let backend = SmimeBackend::new(ks, CryptoPolicy::default_baseline());

        // Negative case: with NO stored intermediate, the chain cannot link
        // leaf → root (no intermediate cert in either the SignedData or the
        // DB). Must NOT reach ValidVerified / ValidUnverified. This is the
        // no-trust-weakening guard (the leaf alone, with no path to the
        // anchor, must NOT validate).
        let neg = run_verify_path(
            &backend,
            &pool,
            &reqwest::Client::new(),
            ACCOUNT_ID,
            &signed_data_der,
            Some("stored-inter@kylins.com"),
            None,
        )
        .await
        .expect("run_verify_path (negative) ok");
        assert!(
            !matches!(
                neg.signature_state,
                SignatureState::ValidVerified | SignatureState::ValidUnverified
            ),
            "without the stored intermediate, the chain MUST NOT validate (got {:?}); \
             this is the no-trust-weakening guard",
            neg.signature_state
        );

        // Persist the INTERMEDIATE as `key_type='intermediate'` — the merge
        // source. (Root stays as the anchor; intermediate stays out of the
        // anchor set.)
        crate::db::crypto_keys::upsert_intermediate_cert(&pool, ACCOUNT_ID, &intermediate.cert_der)
            .await
            .expect("seed intermediate as `key_type='intermediate'`");

        // Positive case: the merge adds the stored intermediate to the
        // intermediates list → the validator builds
        // leaf → intermediate(stored) → root(anchor), chain validates.
        let pos = run_verify_path(
            &backend,
            &pool,
            &reqwest::Client::new(),
            ACCOUNT_ID,
            &signed_data_der,
            Some("stored-inter@kylins.com"),
            None,
        )
        .await
        .expect("run_verify_path (positive) ok");
        assert!(
            matches!(
                pos.signature_state,
                SignatureState::ValidUnverified | SignatureState::ValidVerified
            ),
            "with the stored intermediate, the chain MUST validate (got {:?}); \
             previously failed without the stored intermediate",
            pos.signature_state
        );

        // Cleanup (temp dir reclaims, but explicit for hygiene).
        let _ =
            crate::db::crypto_keys::delete_crypto_key(&pool, ACCOUNT_ID, "smime", &anchor_fp).await;
    }

    /// Task 5 load-bearing round-trip: `build_mime_with_granularity(draft, B)`
    /// → `SmimeBackend::encrypt` (SingleMimeBlob, no sign) → `SmimeBackend::decrypt`
    /// → parse with `mail_parser` → `extract_attachments` returns all 3
    /// attachments.
    ///
    /// This is the design's "receive-side zero change" correctness proof: the
    /// merged `multipart/mixed` subtree composed by Granularity B survives a
    /// CMS EnvelopedData encrypt/decrypt cycle and `extract_attachments` walks
    /// the nested multipart/mixed (a container-of-containers shape that does
    /// not appear under WholeMessage / Granularity A).
    ///
    /// Mirrors the harness + `SmimeBackend::encrypt`/`decrypt` patterns from
    /// `open_crypto_message_decrypts_enveloped_then_signed` (line ~2675) and
    /// `open_crypto_message_returns_no_key_when_no_matching_decryption_key`
    /// (line ~2890). Does NOT touch the DB — exercises `SmimeBackend::decrypt`
    /// directly so the composition is proven without `message_bodies` rows.
    #[tokio::test]
    async fn granularity_b_merged_multipart_round_trips_through_smime_encrypt_decrypt() {
        let h = make_open_crypto_harness().await;

        // 3-attachment draft mirroring builder.rs::make_three_attachment_draft
        // (text + html + 3 binary attachments) — the fixture that exercises
        // Granularity B's merge branch (≥2 regular attachments, no inline).
        let tmp = tempfile::tempdir().expect("tempdir");
        let dir = tmp.path();
        let p1 = dir.join("gb_a1.bin");
        let p2 = dir.join("gb_a2.bin");
        let p3 = dir.join("gb_a3.bin");
        std::fs::write(&p1, b"AAA").unwrap();
        std::fs::write(&p2, b"BBBB").unwrap();
        std::fs::write(&p3, b"CCCCC").unwrap();
        let draft = SendDraft {
            draft_id: "t5-roundtrip".into(),
            from: addr(ACCOUNT_EMAIL),
            to: vec![addr(ACCOUNT_EMAIL)], // encrypt-to-self
            subject: "Granularity B round-trip".into(),
            text_body: Some("plain body".into()),
            html_body: Some("<p>Html body</p>".into()),
            attachments: vec![
                AttachmentRef {
                    file_path: p1.to_string_lossy().into_owned(),
                    filename: "a1.bin".into(),
                    mime_type: "application/octet-stream".into(),
                    cid: None,
                },
                AttachmentRef {
                    file_path: p2.to_string_lossy().into_owned(),
                    filename: "a2.bin".into(),
                    mime_type: "application/octet-stream".into(),
                    cid: None,
                },
                AttachmentRef {
                    file_path: p3.to_string_lossy().into_owned(),
                    filename: "a3.bin".into(),
                    mime_type: "application/octet-stream".into(),
                    cid: None,
                },
            ],
            ..Default::default()
        };

        // Build with Granularity B → merged multipart/mixed subtree holding
        // all 3 attachments as one encryption unit.
        let mime = build_mime_with_granularity(
            &draft,
            EncryptionGranularity::BodyInlineAndMergedAttachments,
        )
        .await
        .expect("build_mime_with_granularity(B)");

        // Encrypt-to-self (SingleMimeBlob, no inner signature) — same shape
        // `apply_crypto` uses at mail/crypto.rs:1376-1390 when `sign=false`.
        let env = h
            .backend
            .encrypt(crypto_core::EncryptOp {
                parts: &[Part {
                    id: PartId("body".into()),
                    kind: PartKind::Body,
                    data: mime.clone(),
                }],
                serialization: SerializationStrategy::SingleMimeBlob,
                recipients: std::slice::from_ref(&h.signer_handle),
                sign_with: None,
            })
            .await
            .expect("encrypt");
        let ciphertext = env.parts.first().expect("one part").ciphertext.clone();

        // Sanity: ciphertext parses as EnvelopedData.
        let ci = ContentInfo::from_der(&ciphertext).expect("parse ContentInfo");
        assert_eq!(ci.content_type, const_oid::db::rfc5911::ID_ENVELOPED_DATA);

        // Decrypt directly via the backend (no DB / `open_crypto_message`).
        let payload = h
            .backend
            .decrypt(crypto_core::DecryptOp {
                envelope: &env,
                decryption_key: h.signer_handle.clone(),
            })
            .await
            .expect("decrypt");
        let plaintext = payload
            .parts
            .first()
            .expect("decrypted payload has one part")
            .data
            .clone();

        // The recovered plaintext must be byte-identical to the pre-encrypt
        // MIME (proving the merged subtree passed through CMS unchanged).
        assert_eq!(
            plaintext, mime,
            "decrypted plaintext must equal the pre-encrypt MIME bytes"
        );

        // Parse the decrypted bytes and walk `extract_attachments` — the
        // receive-side path. Must surface all 3 attachments (proving the
        // nested multipart/mixed is walked, not just the top container).
        let parsed = mail_parser::MessageParser::default()
            .parse(&plaintext)
            .expect("parse decrypted MIME");
        let attachments = extract_attachments(&parsed, 0);
        assert_eq!(
            attachments.len(),
            3,
            "extract_attachments must return all 3 attachments from the \
             decrypted merged multipart/mixed; got {:?}",
            attachments
                .iter()
                .map(|a| a.filename.clone())
                .collect::<Vec<_>>()
        );

        // Filename set round-trips (order-independent — multipart children
        // preserve order but the assertion guards against accidental dedupe
        // or merge into a single aggregate attachment).
        let mut names: Vec<String> = attachments.iter().map(|a| a.filename.clone()).collect();
        names.sort();
        assert_eq!(
            names,
            vec![
                "a1.bin".to_string(),
                "a2.bin".to_string(),
                "a3.bin".to_string()
            ],
            "attachment filenames must round-trip"
        );

        // Sizes match the fixture contents (sanity: no truncation / encoding
        // growth leaked into the attachment metadata).
        let mut sizes: Vec<u32> = attachments.iter().map(|a| a.size).collect();
        sizes.sort();
        assert_eq!(sizes, vec![3, 4, 5], "attachment sizes round-trip");
    }

    /// DA-Task 1: `decrypt_message_mime_bytes` on an encrypt-only enveloped
    /// message returns `Some(bytes)` that parse as MIME and contain the original
    /// plaintext body. Reuses the `open_crypto_message_decrypts_encrypt_only_no_signature`
    /// fixture shape (line ~2745): encrypt-to-self via `apply_crypto`, persist
    /// the ciphertext, then call the new helper (NOT `open_crypto_message`) and
    /// assert only that plaintext bytes are recoverable + parse as MIME.
    ///
    /// This is the load-bearing assertion for Task 2's `crypto_fetch_attachment`
    /// / `crypto_fetch_inline_images` commands: they re-decrypt via this helper
    /// to extract attachment bytes the receive-side `open_crypto_message`
    /// orchestrator does not retain.
    #[tokio::test]
    async fn decrypt_message_mime_bytes_returns_plaintext_for_enveloped_encrypt_only() {
        let h = make_open_crypto_harness().await;
        let pool = h.pool.clone();
        let message_id = "msg-da-task1-bytes";

        // Encrypt-only (no inner signature) via `apply_crypto` — identical
        // fixture shape to `open_crypto_message_decrypts_encrypt_only_no_signature`.
        let draft = SendDraft {
            draft_id: "da-t1".into(),
            from: addr(ACCOUNT_EMAIL),
            to: vec![addr(ACCOUNT_EMAIL)],
            subject: "DA Task 1 helper".into(),
            text_body: Some("plain encrypted body for helper".into()),
            crypto_method: CryptoMethod::Smime,
            encrypt: true,
            ..Default::default()
        };
        let mime = build_mime(&draft).await.expect("build_mime");
        let wrapped = apply_crypto(
            &h.backend,
            &SqliteKeyStore::new(pool.clone(), ACCOUNT_ID),
            &mime,
            &draft,
            ACCOUNT_EMAIL,
            None,
            &pool,
            ACCOUNT_ID,
        )
        .await
        .expect("apply_crypto encrypt");

        // Extract the CMS DER from the wrapped MIME (same path as the
        // encrypt-only test above).
        let parsed = mail_parser::MessageParser::default()
            .parse(&wrapped)
            .expect("parse wrapped");
        let ciphertext = parsed
            .body_html(0)
            .or_else(|| parsed.body_text(0))
            .map(|s| s.as_bytes().to_vec())
            .or_else(|| {
                parsed
                    .attachments
                    .iter()
                    .filter_map(|&i| parsed.parts.get(i))
                    .next()
                    .and_then(|p| match &p.body {
                        mail_parser::PartType::Binary(d)
                        | mail_parser::PartType::InlineBinary(d) => Some(d.as_ref().to_vec()),
                        mail_parser::PartType::Text(t) => Some(t.as_bytes().to_vec()),
                        _ => None,
                    })
            })
            .expect("extract ciphertext bytes");
        let ci = ContentInfo::from_der(&ciphertext).expect("parse ContentInfo");
        assert_eq!(ci.content_type, const_oid::db::rfc5911::ID_ENVELOPED_DATA);

        seed_message_with_from(&pool, ACCOUNT_ID, message_id, ACCOUNT_EMAIL).await;
        persist_ciphertext(&pool, ACCOUNT_ID, message_id, &ciphertext).await;

        // Call the helper under test (NOT the orchestrator).
        let bytes = decrypt_message_mime_bytes(&pool, ACCOUNT_ID, message_id)
            .await
            .expect("decrypt_message_mime_bytes ok");
        let bytes = bytes.expect("enveloped encrypt-only must yield Some(plaintext)");

        // The recovered bytes must parse as MIME and contain the original body.
        let parsed = mail_parser::MessageParser::default()
            .parse(&bytes)
            .expect("decrypted bytes parse as MIME");
        assert!(
            parsed
                .body_text(0)
                .map(|s| s.contains("plain encrypted body for helper"))
                .unwrap_or(false),
            "decrypted MIME text must contain the original body; got {:?}",
            bytes.iter().map(|b| *b as char).collect::<String>()
        );
    }

    // ─── DA-Task 2: crypto_fetch_attachment / crypto_fetch_inline_images ───
    //
    // These round-trip tests exercise the Task 2 backend Tauri command inner
    // functions, which live in `sync_engine::commands` but are `pub(crate)` so
    // they can be reached from this test module. The fixture shape mirrors
    // `granularity_b_merged_multipart_round_trips_through_smime_encrypt_decrypt`
    // (line ~3939) + the Task 1 helper test above: build a draft with binary
    // attachments (and, for the inline test, a `cid:`-tagged image), encrypt-
    // to-self via `apply_crypto`, persist the ciphertext, then call the inner
    // fn under test and assert the cached file contents equal the original
    // attachment bytes.
    //
    // The inner fns take a `cache_root: &Path` (NOT `Arc<SyncEngine>`) so they
    // are unit-testable without building a SyncEngine; the `#[tauri::command]`
    // wrappers in `sync_engine::commands.rs` resolve `cache_root` from
    // `engine.data_dir.join("attachment-cache")` at IPC boundary.

    /// Encrypt-only round-trip with 3 binary attachments: calling
    /// `crypto_fetch_attachment_inner(..., "a1.bin", None)` after persisting
    /// the ciphertext MUST return a `CachedAttachment` whose file exists and
    /// whose bytes equal `b"AAA"` (the original a1.bin content). Proves the
    /// re-decrypt + MIME walk + cache-write path recovers the right part.
    #[tokio::test]
    async fn crypto_fetch_attachment_returns_bytes() {
        let h = make_open_crypto_harness().await;
        let pool = h.pool.clone();
        let message_id = "msg-da-task2-attachment";

        let tmp = tempfile::tempdir().expect("tempdir");
        let dir = tmp.path();
        let p1 = dir.join("da2_a1.bin");
        let p2 = dir.join("da2_a2.bin");
        let p3 = dir.join("da2_a3.bin");
        std::fs::write(&p1, b"AAA").unwrap();
        std::fs::write(&p2, b"BBBB").unwrap();
        std::fs::write(&p3, b"CCCCC").unwrap();
        let draft = SendDraft {
            draft_id: "da-t2-att".into(),
            from: addr(ACCOUNT_EMAIL),
            to: vec![addr(ACCOUNT_EMAIL)], // encrypt-to-self
            subject: "DA Task 2 attachment fetch".into(),
            text_body: Some("plain body".into()),
            attachments: vec![
                AttachmentRef {
                    file_path: p1.to_string_lossy().into_owned(),
                    filename: "a1.bin".into(),
                    mime_type: "application/octet-stream".into(),
                    cid: None,
                },
                AttachmentRef {
                    file_path: p2.to_string_lossy().into_owned(),
                    filename: "a2.bin".into(),
                    mime_type: "application/octet-stream".into(),
                    cid: None,
                },
                AttachmentRef {
                    file_path: p3.to_string_lossy().into_owned(),
                    filename: "a3.bin".into(),
                    mime_type: "application/octet-stream".into(),
                    cid: None,
                },
            ],
            crypto_method: CryptoMethod::Smime,
            encrypt: true,
            ..Default::default()
        };

        let mime = build_mime(&draft).await.expect("build_mime");
        let wrapped = apply_crypto(
            &h.backend,
            &SqliteKeyStore::new(pool.clone(), ACCOUNT_ID),
            &mime,
            &draft,
            ACCOUNT_EMAIL,
            None,
            &pool,
            ACCOUNT_ID,
        )
        .await
        .expect("apply_crypto encrypt");

        // Extract the enveloped CMS blob from the wrapped MIME (same shape as
        // the Task 1 helper test): mail_parser parses the wrapper; the CMS is
        // the body of the single leaf part.
        let parsed = mail_parser::MessageParser::default()
            .parse(&wrapped)
            .expect("parse wrapped");
        let ciphertext = parsed
            .body_html(0)
            .or_else(|| parsed.body_text(0))
            .map(|s| s.as_bytes().to_vec())
            .or_else(|| {
                parsed
                    .attachments
                    .iter()
                    .filter_map(|&i| parsed.parts.get(i))
                    .next()
                    .and_then(|p| match &p.body {
                        mail_parser::PartType::Binary(d)
                        | mail_parser::PartType::InlineBinary(d) => Some(d.as_ref().to_vec()),
                        mail_parser::PartType::Text(t) => Some(t.as_bytes().to_vec()),
                        _ => None,
                    })
            })
            .expect("extract ciphertext bytes");
        let ci = ContentInfo::from_der(&ciphertext).expect("parse ContentInfo");
        assert_eq!(ci.content_type, const_oid::db::rfc5911::ID_ENVELOPED_DATA);

        seed_message_with_from(&pool, ACCOUNT_ID, message_id, ACCOUNT_EMAIL).await;
        persist_ciphertext(&pool, ACCOUNT_ID, message_id, &ciphertext).await;

        // Cache root under a temp dir (mirrors engine.data_dir/attachment-cache).
        let cache_tmp = tempfile::tempdir().expect("cache tempdir");
        let cache_root = cache_tmp.path().join("attachment-cache");

        let cached = crate::sync_engine::commands::crypto_fetch_attachment_inner(
            &pool,
            &cache_root,
            ACCOUNT_ID,
            message_id,
            "a1.bin",
            None,
        )
        .await
        .expect("crypto_fetch_attachment_inner ok");

        assert_eq!(cached.filename, "a1.bin");
        assert!(cached.size > 0);
        let file_path = std::path::Path::new(&cached.file_path);
        assert!(
            file_path.exists(),
            "cache file must exist at {}",
            cached.file_path
        );
        let bytes = std::fs::read(file_path).expect("read cached file");
        assert_eq!(bytes, b"AAA", "cached bytes must equal the original a1.bin");
    }

    /// Encrypt-only round-trip with one inline `cid:` image: calling
    /// `crypto_fetch_inline_images_inner` MUST return exactly one
    /// `CachedInlineImage` whose `content_id` matches the draft's cid and whose
    /// cached file bytes equal the original image content. Proves the inline
    /// CID extraction path works end-to-end through the re-decrypt + parse.
    #[tokio::test]
    async fn crypto_fetch_inline_images_returns_cid_parts() {
        let h = make_open_crypto_harness().await;
        let pool = h.pool.clone();
        let message_id = "msg-da-task2-inline";

        let tmp = tempfile::tempdir().expect("tempdir");
        let dir = tmp.path();
        let inline_path = dir.join("da2_inline.png");
        std::fs::write(&inline_path, b"\x89PNG\r\n\x1a\nfake-png-bytes").unwrap();
        let cid_value = "inline-image-001@kylins.local";
        let draft = SendDraft {
            draft_id: "da-t2-inline".into(),
            from: addr(ACCOUNT_EMAIL),
            to: vec![addr(ACCOUNT_EMAIL)], // encrypt-to-self
            subject: "DA Task 2 inline image fetch".into(),
            html_body: Some(format!(
                "<p>Body with inline image <img src=\"cid:{cid_value}\"/></p>"
            )),
            text_body: Some("plain body".into()),
            inline_images: vec![AttachmentRef {
                file_path: inline_path.to_string_lossy().into_owned(),
                filename: "inline.png".into(),
                mime_type: "image/png".into(),
                cid: Some(cid_value.to_string()),
            }],
            crypto_method: CryptoMethod::Smime,
            encrypt: true,
            ..Default::default()
        };

        let mime = build_mime(&draft).await.expect("build_mime");
        let wrapped = apply_crypto(
            &h.backend,
            &SqliteKeyStore::new(pool.clone(), ACCOUNT_ID),
            &mime,
            &draft,
            ACCOUNT_EMAIL,
            None,
            &pool,
            ACCOUNT_ID,
        )
        .await
        .expect("apply_crypto encrypt");

        let parsed = mail_parser::MessageParser::default()
            .parse(&wrapped)
            .expect("parse wrapped");
        let ciphertext = parsed
            .body_html(0)
            .or_else(|| parsed.body_text(0))
            .map(|s| s.as_bytes().to_vec())
            .or_else(|| {
                parsed
                    .attachments
                    .iter()
                    .filter_map(|&i| parsed.parts.get(i))
                    .next()
                    .and_then(|p| match &p.body {
                        mail_parser::PartType::Binary(d)
                        | mail_parser::PartType::InlineBinary(d) => Some(d.as_ref().to_vec()),
                        mail_parser::PartType::Text(t) => Some(t.as_bytes().to_vec()),
                        _ => None,
                    })
            })
            .expect("extract ciphertext bytes");
        let ci = ContentInfo::from_der(&ciphertext).expect("parse ContentInfo");
        assert_eq!(ci.content_type, const_oid::db::rfc5911::ID_ENVELOPED_DATA);

        seed_message_with_from(&pool, ACCOUNT_ID, message_id, ACCOUNT_EMAIL).await;
        persist_ciphertext(&pool, ACCOUNT_ID, message_id, &ciphertext).await;

        let cache_tmp = tempfile::tempdir().expect("cache tempdir");
        let cache_root = cache_tmp.path().join("attachment-cache");

        let images = crate::sync_engine::commands::crypto_fetch_inline_images_inner(
            &pool,
            &cache_root,
            ACCOUNT_ID,
            message_id,
        )
        .await
        .expect("crypto_fetch_inline_images_inner ok");

        assert_eq!(
            images.len(),
            1,
            "exactly one inline cid: image must be extracted; got {images:?}"
        );
        let img = &images[0];
        assert_eq!(img.content_id, cid_value, "content_id must round-trip");
        assert_eq!(img.mime_type, "image/png", "mime_type must round-trip");
        assert!(img.size > 0);
        let file_path = std::path::Path::new(&img.file_path);
        assert!(
            file_path.exists(),
            "cache file must exist at {}",
            img.file_path
        );
        let bytes = std::fs::read(file_path).expect("read cached inline file");
        assert_eq!(
            bytes,
            b"\x89PNG\r\n\x1a\nfake-png-bytes".as_slice(),
            "cached inline bytes must equal the original image"
        );
    }
}
