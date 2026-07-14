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

use crypto_core::{
    CryptoBackend, EncryptOp, Fingerprint, KeyHandle, KeyHandleRef, KeyId, KeyStore, KeyUsage, Part,
    PartId, PartKind, SerializationStrategy, SignOp, Standard,
};
use crypto_smime::SmimeBackend;

use crate::db::crypto_keys::DefaultKeyRow;
use crate::keystore_bridge::SqliteKeyStore;
use crate::mail::builder::{CryptoMethod, SendDraft};

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
    Backend(crypto_core::CryptoError),
    Mime(String),
}
impl std::fmt::Display for CryptoSendError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::NoSigningKey => write!(f, "no default S/MIME signing key for the account"),
            Self::MissingRecipientCert(e) => write!(f, "no S/MIME cert for recipient {e}"),
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
pub(crate) fn split_message(
    full: &[u8],
) -> Result<(MessageHeaders, EntityBytes), CryptoSendError> {
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

/// Apply S/MIME sign/encrypt to a built MIME message. Returns the wrapped bytes
/// (or the input unchanged when `crypto_method != Smime` or neither flag set).
///
/// - `sign`   → clear-sign `multipart/signed` over the body entity.
/// - `encrypt` → `application/pkcs7-mime; smime-type=enveloped-data` over the
///   (possibly signed) body entity; the sender (`account_email`) is added as a
///   recipient (encrypt-to-self).
/// - sign + encrypt → inner clear-sign, outer enveloped.
///
/// Fail-closed on missing recipient certs: any To/Cc/Bcc (or the sender) whose
/// cert `find_by_email` cannot resolve produces `MissingRecipientCert` and no
/// ciphertext is emitted.
pub(crate) async fn apply_crypto(
    backend: &SmimeBackend,
    keystore: &SqliteKeyStore,
    mime: &[u8],
    draft: &SendDraft,
    account_email: &str,
    default_signing_key: Option<&DefaultKeyRow>,
) -> Result<Vec<u8>, CryptoSendError> {
    if draft.crypto_method != CryptoMethod::Smime || (!draft.sign && !draft.encrypt) {
        return Ok(mime.to_vec());
    }

    let (outer, mut entity) = split_message(mime)?;

    // --- sign (clear-sign) ---
    if draft.sign {
        let signer_row = default_signing_key.ok_or(CryptoSendError::NoSigningKey)?;
        let signer = key_handle_ref(signer_row);
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
        let env = backend
            .encrypt(EncryptOp {
                parts: &[Part {
                    id: PartId("body".into()),
                    kind: PartKind::Body,
                    data: entity.0.clone(),
                }],
                serialization: SerializationStrategy::SingleMimeBlob,
                recipients: &recipients,
                sign_with: None,
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

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Arc;

    use sqlx::SqlitePool;
    use tempfile::TempDir;

    use crypto_core::{CryptoPolicy, KeyGenParams};
    use der::Encode;
    use sha2::Digest;

    use crate::db::crypto_keys::get_default_signing_key;
    use crate::db::init_db;
    use crate::mail::builder::{build_mime, AddressSpec};

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
        let part1_in_mime = part1_region.trim_start_matches('\r').trim_start_matches('\n');
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

    async fn make_harness(
        flag_default_signer: bool,
        extra_recipient_emails: &[&str],
    ) -> Harness {
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
        let p2 = s[p1_start..]
            .find(&first_marker)
            .expect("second boundary")
            + p1_start;
        let part1 = out[p1_start..p2].to_vec();

        // Part 2 begins right after the second marker; it has its own header
        // block + blank line + base64 body, ending at the closing marker.
        let p2_body_start = p2 + first_marker.len();
        let blank = s[p2_body_start..]
            .find("\r\n\r\n")
            .expect("part2 blank")
            + 4
            + p2_body_start;
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

        let ci: ContentInfo = <ContentInfo as Decode>::from_der(p7s_der).expect("parse ContentInfo");
        assert_eq!(ci.content_type, const_oid::db::rfc5911::ID_SIGNED_DATA);
        let sd: SignedData = <SignedData as Decode>::from_der(
            ci.content.to_der().expect("re-encode content").as_slice(),
        )
        .expect("parse SignedData");
        let signer = sd
            .signer_infos
            .0
            .get(0)
            .expect("exactly one signer info");
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
            .find(|l| l
                .to_ascii_lowercase()
                .starts_with("content-type: multipart/alternative"))
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
        let out = apply_crypto(
            &h.backend,
            h.keystore.as_ref(),
            &mime,
            &draft,
            &h.account_email,
            None,
        )
        .await
        .expect("apply_crypto encrypt");

        let s = std::str::from_utf8(&out).expect("output utf-8");
        assert!(s.contains("application/pkcs7-mime; smime-type=enveloped-data"));
        assert!(s.contains("Content-Transfer-Encoding: base64"));
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
        )
        .await
        .expect_err("must fail closed");
        assert!(
            matches!(err, CryptoSendError::MissingRecipientCert(ref e) if e.contains("nobody@kylins.com")),
            "expected MissingRecipientCert for nobody, got {err:?}"
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
        let cert_der = backend.export_public(&h.handle).await.expect("export_public");
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
}
