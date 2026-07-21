//! OpenPGP/MIME (RFC 3156) framing layer for the OpenPGP Phase 2 send slice.
//! Pure byte construction — no `mail-builder` dependency — so
//! `multipart/signed` part-1 byte exactness is fully under our control,
//! mirroring the S/MIME path in [`crate::mail::crypto`] (which was validated
//! against Thunderbird).
//!
//! This module is the PGP analogue of [`crypto::wrap_multipart_signed`] /
//! [`crypto::wrap_enveloped`]: it frames the engine-core's OpenPGP message
//! bytes / detached-signature bytes into the MIME multipart structures
//! RFC 3156 specifies. It does NOT call the engine — Task 4's generalized
//! `apply_crypto` does that, then hands the resulting bytes here.
//!
//! # Structure
//!
//! - [`wrap_encrypted`] → `multipart/encrypted;
//!   protocol="application/pgp-encrypted"` (RFC 3156 §2). Part 1 =
//!   `application/pgp-encrypted` body `Version: 1`; part 2 =
//!   `application/octet-stream; name="encrypted.asc"` carrying the OpenPGP
//!   message bytes.
//! - [`wrap_signed`] → `multipart/signed;
//!   protocol="application/pgp-signature"; micalg=pgp-<hash>` (RFC 3156 §1).
//!   Part 1 = the canonicalized payload (exactly one trailing CRLF); part 2 =
//!   `application/pgp-signature; name="signature.asc"` carrying the detached
//!   signature.
//!
//! (sign-then-encrypt needs no separate wrapper — the engine's
//! `encrypt(sign_with=Some)` already produces a nested signed+encrypted
//! OpenPGP message; [`wrap_encrypted`] frames it.)
//!
//! # Armor-vs-binary decision
//!
//! The engine-core's `engine::encrypt` produces raw OpenPGP message bytes
//! (binary SEIPD packets); `sign_detached` produces raw detached-signature
//! packet bytes (binary). RFC 3156 allows the part-2 content to be binary
//! OR ASCII-armored. **This module base64-encodes the binary bytes with
//! `Content-Transfer-Encoding: base64`**, mirroring the S/MIME path's
//! approach (`crypto::wrap_multipart_signed` / `crypto::wrap_enveloped`
//! base64-encode the binary DER). This is always RFC-conformant and
//! universally interoperable.
//!
//! **Task 7's GnuPG/Thunderbird interop is the final arbiter.** If a real
//! GnuPG rejects base64-transported PGP parts, the fix is to ASCII-armor
//! the bytes in Task 4 (via Sequoia's armor) **before** passing them to
//! `wrap_*`. This module stays armor-agnostic: it operates on whatever
//! bytes the caller supplies; the base64 transport layer is invariant to
//! whether those bytes are binary packets or ASCII-armored text.
//!
//! # Dead-code allow
//!
//! Task 3 ships [`wrap_encrypted`] / [`wrap_signed`] as fully tested units
//! with NO non-test caller. Task 4 wires them into the generalized
//! `apply_crypto`; until then the module carries `#![allow(dead_code)]`
//! so the per-target analysis doesn't flag the call graph. The allow comes
//! off when Task 4 lands (mirrors the S/MIME path's lifecycle documented
//! in [`crypto`] at lines 18-26).

#![allow(dead_code)]

use base64::Engine;

use crypto_core::HashAlgorithm;

use crate::mail::crypto::ensure_one_trailing_crlf;

/// Boundary for `multipart/encrypted` (RFC 3156 §2). Mirrors the S/MIME
/// `SIGNED_BOUNDARY` pattern in [`crate::mail::crypto`].
const ENCRYPTED_BOUNDARY: &str = "----=_kylins_pgp_encrypted_0001";

/// Boundary for `multipart/signed` (RFC 3156 §1).
const SIGNED_BOUNDARY: &str = "----=_kylins_pgp_signed_0001";

/// Map a framework [`HashAlgorithm`] to its RFC 3156 `micalg` symbol (the
/// `pgp-<name>` value the `multipart/signed` `micalg` parameter carries).
///
/// Per RFC 4880 §9.4 + RFC 9580 hash algorithm table:
/// - SHA-256 → `pgp-sha256`, SHA-384 → `pgp-sha384`, SHA-512 → `pgp-sha512`
/// - SHA3-256 → `pgp-sha3-256` (RFC 9580)
/// - SM3 → `pgp-sm3` (GnuPG extension; hash ID 11 — no RFC-standard micalg
///   string exists, but `pgp-sm3` is the de-facto GnuPG spelling).
///
/// The framework [`HashAlgorithm`] does NOT include SHA-1 (banned for
/// signatures under the default baseline policy) — so this match is total
/// over the framework's hash set.
fn micalg_name(hash: HashAlgorithm) -> &'static str {
    match hash {
        HashAlgorithm::Sha256 => "pgp-sha256",
        HashAlgorithm::Sha384 => "pgp-sha384",
        HashAlgorithm::Sha512 => "pgp-sha512",
        HashAlgorithm::Sha3_256 => "pgp-sha3-256",
        HashAlgorithm::Sm3 => "pgp-sm3",
    }
}

/// Build a `multipart/encrypted` MIME **entity** (Content-Type header +
/// blank + multipart body) framing an OpenPGP message per RFC 3156 §2.
///
/// The caller supplies the raw OpenPGP message bytes (binary SEIPD packets
/// produced by `crypto_openpgp::engine::encrypt`). Part 1 is the fixed
/// `application/pgp-encrypted` body `Version: 1` (the RFC 3156 §2 control
/// part); part 2 carries the OpenPGP message as
/// `application/octet-stream; name="encrypted.asc"` with
/// `Content-Transfer-Encoding: base64` (see the module-level
/// armor-vs-binary doc for the rationale).
///
/// Layout (RFC 3156 §2):
/// ```text
/// Content-Type: multipart/encrypted;
///    protocol="application/pgp-encrypted";
///    boundary="----=_kylins_pgp_encrypted_0001"
/// <blank>
/// This is an OpenPGP/MIME encrypted message (RFC 3156)
/// --{boundary}
/// Content-Type: application/pgp-encrypted
/// <blank>
/// Version: 1
/// --{boundary}
/// Content-Type: application/octet-stream; name="encrypted.asc"
/// Content-Transfer-Encoding: base64
/// Content-Disposition: inline; filename="encrypted.asc"
/// <blank>
/// {base64(openpgp_message), wrapped at 72 cols}
/// --{boundary}--
/// ```
pub(crate) fn wrap_encrypted(openpgp_message: &[u8]) -> Vec<u8> {
    let b64 = base64::engine::general_purpose::STANDARD.encode(openpgp_message);
    let mut out = Vec::new();
    out.extend_from_slice(
        format!(
            "Content-Type: multipart/encrypted; \
             protocol=\"application/pgp-encrypted\"; \
             boundary=\"{ENCRYPTED_BOUNDARY}\"\r\n\r\n"
        )
        .as_bytes(),
    );
    out.extend_from_slice(b"This is an OpenPGP/MIME encrypted message (RFC 3156)\r\n");
    // Part 1 — the Version: 1 control part.
    out.extend_from_slice(format!("--{ENCRYPTED_BOUNDARY}\r\n").as_bytes());
    out.extend_from_slice(b"Content-Type: application/pgp-encrypted\r\n\r\nVersion: 1\r\n");
    // Part 2 — the OpenPGP message (base64-transported).
    out.extend_from_slice(format!("--{ENCRYPTED_BOUNDARY}\r\n").as_bytes());
    out.extend_from_slice(
        b"Content-Type: application/octet-stream; name=\"encrypted.asc\"\r\n\
          Content-Transfer-Encoding: base64\r\n\
          Content-Disposition: inline; filename=\"encrypted.asc\"\r\n\r\n",
    );
    for chunk in b64.as_bytes().chunks(72) {
        out.extend_from_slice(chunk);
        out.extend_from_slice(b"\r\n");
    }
    out.extend_from_slice(format!("--{ENCRYPTED_BOUNDARY}--\r\n").as_bytes());
    out
}

/// Build a `multipart/signed` MIME **entity** (Content-Type header + blank +
/// multipart body) framing a detached OpenPGP signature per RFC 3156 §1.
///
/// `payload` is the body bytes to be signed; `payload_mime` is its
/// `Content-Type` value (e.g. `"text/plain; charset=utf-8"`). The signed
/// bytes — what the detached signature covers — are the full part-1 MIME
/// entity: `Content-Type: <payload_mime>\r\n\r\n<payload>` with exactly
/// one trailing CRLF. [`ensure_one_trailing_crlf`] canonicalizes the
/// payload to guarantee this; the canonicalization is idempotent, so
/// Task 4's caller may safely canonicalize the same bytes before signing
/// (the signature covers the same byte sequence wrap_signed emits).
///
/// `detached_sig` is the raw detached-signature packet bytes (binary,
/// produced by `crypto_openpgp::engine::sign_detached`). It is
/// base64-transported in part 2 (`Content-Transfer-Encoding: base64`),
/// mirroring the S/MIME path's handling of binary DER — see the module-level
/// armor-vs-binary doc.
///
/// `hash` is the signature's hash algorithm; it becomes the `micalg`
/// parameter value (`pgp-<name>`) per RFC 3156 §1 + RFC 4880 §9.4 (see
/// [`micalg_name`] for the exact spellings).
///
/// Layout (RFC 3156 §1):
/// ```text
/// Content-Type: multipart/signed;
///    protocol="application/pgp-signature";
///    micalg=pgp-<hash>; boundary="----=_kylins_pgp_signed_0001"
/// <blank>
/// This is an OpenPGP/MIME signed message (RFC 3156)
/// --{boundary}
/// Content-Type: <payload_mime>
/// <blank>
/// <payload body, exactly one trailing CRLF>
/// --{boundary}
/// Content-Type: application/pgp-signature; name="signature.asc"
/// Content-Transfer-Encoding: base64
/// Content-Disposition: attachment; filename="signature.asc"
/// <blank>
/// {base64(detached_sig), wrapped at 72 cols}
/// --{boundary}--
/// ```
pub(crate) fn wrap_signed(
    payload: &[u8],
    payload_mime: &str,
    detached_sig: &[u8],
    hash: HashAlgorithm,
) -> Vec<u8> {
    let sig_b64 = base64::engine::general_purpose::STANDARD.encode(detached_sig);
    let micalg = micalg_name(hash);
    let body_canonical = ensure_one_trailing_crlf(payload);
    let mut out = Vec::new();
    out.extend_from_slice(
        format!(
            "Content-Type: multipart/signed; \
             protocol=\"application/pgp-signature\"; \
             micalg={micalg}; \
             boundary=\"{SIGNED_BOUNDARY}\"\r\n\r\n"
        )
        .as_bytes(),
    );
    out.extend_from_slice(b"This is an OpenPGP/MIME signed message (RFC 3156)\r\n");
    // Part 1 — the signed body entity (Content-Type + blank + canonicalized
    // body, ending in exactly one CRLF).
    out.extend_from_slice(format!("--{SIGNED_BOUNDARY}\r\n").as_bytes());
    out.extend_from_slice(format!("Content-Type: {payload_mime}\r\n\r\n").as_bytes());
    out.extend_from_slice(&body_canonical);
    // Part 2 — the detached signature (base64-transported).
    out.extend_from_slice(format!("--{SIGNED_BOUNDARY}\r\n").as_bytes());
    out.extend_from_slice(
        b"Content-Type: application/pgp-signature; name=\"signature.asc\"\r\n\
          Content-Transfer-Encoding: base64\r\n\
          Content-Disposition: attachment; filename=\"signature.asc\"\r\n\r\n",
    );
    for chunk in sig_b64.as_bytes().chunks(72) {
        out.extend_from_slice(chunk);
        out.extend_from_slice(b"\r\n");
    }
    out.extend_from_slice(format!("--{SIGNED_BOUNDARY}--\r\n").as_bytes());
    out
}

#[cfg(test)]
mod tests {
    use base64::Engine;
    use mail_parser::{MessageParser, MimeHeaders, PartType};

    /// Parse `bytes` as a MIME message and return `(root_content_type,
    /// child_ids)`. Panics if the root is not multipart.
    fn parse_multipart(bytes: &[u8]) -> (String, Vec<usize>, mail_parser::Message<'_>) {
        let parsed = MessageParser::default()
            .parse(bytes)
            .expect("output must parse as MIME");
        let root = parsed.parts.first().expect("root part exists");
        let ct = root.content_type().expect("Content-Type present");
        let full = match ct.subtype() {
            Some(sub) => format!("{}/{}", ct.ctype(), sub).to_lowercase(),
            None => ct.ctype().to_lowercase(),
        };
        let kids: Vec<usize> = match &root.body {
            PartType::Multipart(ids) => ids.to_vec(),
            _ => panic!("root must be multipart, got {:?}", root.body),
        };
        (full, kids, parsed)
    }

    /// Slice the raw bytes of a child part (header + body) from the parsed
    /// message using its offset metadata — byte-exact, including the part's
    /// terminating CRLF. Mirrors the idiom in `crypto::tests`'s
    /// `parse_clear_signed_blobs` (at `mail/crypto.rs:3043`).
    fn raw_part_bytes(parsed: &mail_parser::Message<'_>, idx: usize) -> Vec<u8> {
        let p = &parsed.parts[idx];
        let mut bytes = parsed.raw_message[p.offset_header..p.offset_end].to_vec();
        if !bytes.ends_with(b"\r\n") {
            bytes.extend_from_slice(b"\r\n");
        }
        bytes
    }

    /// Decode a binary part body (base64-decoded by mail-parser) to bytes.
    /// Falls through to base64-decoding a `Text` body defensively in case
    /// the parser labels an `application/octet-stream` part as Text.
    fn decode_binary_part(parsed: &mail_parser::Message<'_>, idx: usize) -> Vec<u8> {
        let p = &parsed.parts[idx];
        match &p.body {
            PartType::Binary(d) | PartType::InlineBinary(d) => d.as_ref().to_vec(),
            PartType::Text(t) => {
                let collapsed: String = t.chars().filter(|c| !c.is_whitespace()).collect();
                base64::engine::general_purpose::STANDARD
                    .decode(collapsed.as_bytes())
                    .expect("base64 decode")
            }
            _ => panic!("part {idx} must be Binary/InlineBinary/Text, got {:?}", p.body),
        }
    }

    /// Extract the body bytes of the `application/pgp-encrypted` control
    /// part (RFC 3156 §2 part 1). Stored as Text or Binary depending on
    /// parser heuristics (no CTE header → 7bit).
    fn control_part_body(parsed: &mail_parser::Message<'_>, idx: usize) -> Vec<u8> {
        let p = &parsed.parts[idx];
        match &p.body {
            PartType::Text(t) => t.as_bytes().to_vec(),
            PartType::Binary(d) | PartType::InlineBinary(d) => d.as_ref().to_vec(),
            _ => panic!("control part {idx} must be Text/Binary, got {:?}", p.body),
        }
    }

    /// Return the full `type/subtype` string for a part's Content-Type.
    /// mail-parser splits Content-Type into `c_type` (main) and `c_subtype`;
    /// assertions need the combined form. Case-insensitive comparison via
    /// lowercase normalization.
    fn full_content_type(parsed: &mail_parser::Message<'_>, idx: usize) -> String {
        let ct = parsed.parts[idx]
            .content_type()
            .expect("part has Content-Type");
        match ct.subtype() {
            Some(sub) => format!("{}/{}", ct.ctype(), sub).to_lowercase(),
            None => ct.ctype().to_lowercase(),
        }
    }

    #[test]
    fn wrap_encrypted_round_trips_through_mail_parser() {
        // Arbitrary binary bytes — the unit test does NOT depend on the
        // armor-vs-binary decision (it verifies that whatever bytes go in
        // come back out after base64-decode).
        let openpgp_msg: &[u8] = &[
            0xC1, 0x03, 0x05, 0x0F, 0xAA, 0xBB, 0xCC, 0xDD, 0xEE, 0xFF, 0x00, 0x11, 0x22,
        ];
        let entity = super::wrap_encrypted(openpgp_msg);

        // Structure: top-level multipart/encrypted with the right protocol.
        let (full, kids, parsed) = parse_multipart(&entity);
        assert_eq!(full, "multipart/encrypted");
        assert_eq!(kids.len(), 2, "multipart/encrypted must have 2 parts");

        // Root Content-Type must carry protocol="application/pgp-encrypted".
        let root_ct = parsed
            .parts
            .first()
            .expect("root")
            .content_type()
            .expect("Content-Type");
        assert_eq!(
            root_ct.attribute("protocol"),
            Some("application/pgp-encrypted")
        );

        // Part 1: application/pgp-encrypted body "Version: 1" (RFC 3156 §2).
        assert_eq!(
            full_content_type(&parsed, kids[0]),
            "application/pgp-encrypted",
        );
        let p1_body = control_part_body(&parsed, kids[0]);
        let p1_str = String::from_utf8_lossy(&p1_body);
        assert_eq!(
            p1_str.trim(),
            "Version: 1",
            "part 1 body must be the RFC 3156 §2 'Version: 1' control literal"
        );

        // Part 2: application/octet-stream; name="encrypted.asc"; base64-decodes
        // back to the input OpenPGP message bytes.
        let p2 = &parsed.parts[kids[1]];
        assert_eq!(
            full_content_type(&parsed, kids[1]),
            "application/octet-stream",
        );
        assert_eq!(
            p2.content_type().and_then(|c| c.attribute("name")),
            Some("encrypted.asc"),
        );
        assert_eq!(
            p2.content_transfer_encoding().map(|s| s.to_lowercase()),
            Some("base64".to_string()),
        );
        let decoded = decode_binary_part(&parsed, kids[1]);
        assert_eq!(decoded, openpgp_msg);
    }

    #[test]
    fn wrap_signed_round_trips_through_mail_parser() {
        use crypto_core::HashAlgorithm;

        let payload = b"Hello, PGP world!";
        let payload_mime = "text/plain; charset=utf-8";
        let detached_sig: &[u8] =
            &[0x88, 0x04, 0x0A, 0x10, 0xDE, 0xAD, 0xBE, 0xEF, 0xCA, 0xFE];
        let entity = super::wrap_signed(payload, payload_mime, detached_sig, HashAlgorithm::Sha512);

        // Structure: top-level multipart/signed with the right protocol + micalg.
        let (full, kids, parsed) = parse_multipart(&entity);
        assert_eq!(full, "multipart/signed");
        assert_eq!(kids.len(), 2, "multipart/signed must have 2 parts");

        // Root Content-Type must carry protocol="application/pgp-signature"
        // and micalg=pgp-sha512 (SHA-512 is the engine-core's Ed25519 default
        // hash per the task brief).
        let root_ct = parsed
            .parts
            .first()
            .expect("root")
            .content_type()
            .expect("Content-Type");
        assert_eq!(
            root_ct.attribute("protocol"),
            Some("application/pgp-signature")
        );
        assert_eq!(root_ct.attribute("micalg"), Some("pgp-sha512"));

        // Part 1: the canonicalized payload entity. Byte-exact via raw_message
        // slicing (mail-parser may collapse body whitespace if read through
        // the typed PartType::Text API; raw slicing preserves the signed
        // bytes verbatim).
        let part1_raw = raw_part_bytes(&parsed, kids[0]);
        let expected_part1 =
            b"Content-Type: text/plain; charset=utf-8\r\n\r\nHello, PGP world!\r\n";
        assert_eq!(
            part1_raw,
            expected_part1,
            "part 1 must be the canonicalized payload entity with exactly one trailing CRLF"
        );

        // Part 2: application/pgp-signature; name="signature.asc"; base64-decodes
        // back to the input detached signature bytes.
        let p2 = &parsed.parts[kids[1]];
        assert_eq!(
            full_content_type(&parsed, kids[1]),
            "application/pgp-signature",
        );
        assert_eq!(
            p2.content_type().and_then(|c| c.attribute("name")),
            Some("signature.asc"),
        );
        assert_eq!(
            p2.content_transfer_encoding().map(|s| s.to_lowercase()),
            Some("base64".to_string()),
        );
        let decoded = decode_binary_part(&parsed, kids[1]);
        assert_eq!(decoded, detached_sig);
    }

    #[test]
    fn micalg_name_covers_all_framework_hashes() {
        use crypto_core::HashAlgorithm;

        assert_eq!(super::micalg_name(HashAlgorithm::Sha256), "pgp-sha256");
        assert_eq!(super::micalg_name(HashAlgorithm::Sha384), "pgp-sha384");
        assert_eq!(super::micalg_name(HashAlgorithm::Sha512), "pgp-sha512");
        assert_eq!(super::micalg_name(HashAlgorithm::Sha3_256), "pgp-sha3-256");
        assert_eq!(super::micalg_name(HashAlgorithm::Sm3), "pgp-sm3");
    }

    /// Byte-exactness of the trailing CRLF canonicalization — the S/MIME
    /// template's load-bearing invariant (signature covers exactly one
    /// CRLF before the boundary).
    #[test]
    fn wrap_signed_canonicalizes_doubled_trailing_crlf() {
        use crypto_core::HashAlgorithm;

        // Payload ends with `\r\n\r\n` — must be collapsed to exactly one
        // CRLF so the signature covers only one terminator.
        let payload = b"body\r\n\r\n";
        let entity = super::wrap_signed(payload, "text/plain", &[], HashAlgorithm::Sha512);

        // The second boundary marker terminates part 1. Locate it and verify
        // the byte just before is `\n` and the byte before THAT is NOT `\n`.
        let boundary_marker = b"------=_kylins_pgp_signed_0001\r\n";
        let marker_bytes = boundary_marker;
        let first = entity
            .windows(marker_bytes.len())
            .position(|w| w == marker_bytes)
            .expect("first boundary marker");
        let second_start = first
            + marker_bytes.len()
            + entity[first + marker_bytes.len()..]
                .windows(marker_bytes.len())
                .position(|w| w == marker_bytes)
                .expect("second boundary marker");
        assert_eq!(
            entity[second_start - 1],
            b'\n',
            "part 1 must end with exactly one CRLF"
        );
        assert_ne!(
            entity[second_start - 2],
            b'\n',
            "part 1 must NOT end with a doubled CRLF"
        );
    }

    /// If the payload has no trailing CRLF at all, wrap_signed adds exactly
    /// one (mirror of the S/MIME `ensure_one_trailing_crlf` contract).
    #[test]
    fn wrap_signed_adds_missing_trailing_crlf() {
        use crypto_core::HashAlgorithm;

        let payload = b"no-newline";
        let entity = super::wrap_signed(payload, "text/plain", &[], HashAlgorithm::Sha512);
        let boundary_marker = b"------=_kylins_pgp_signed_0001\r\n";
        let marker_bytes = boundary_marker;
        let first = entity
            .windows(marker_bytes.len())
            .position(|w| w == marker_bytes)
            .expect("first boundary marker");
        let second_start = first
            + marker_bytes.len()
            + entity[first + marker_bytes.len()..]
                .windows(marker_bytes.len())
                .position(|w| w == marker_bytes)
                .expect("second boundary marker");
        // Bytes immediately before the second boundary: `\r\n--boundary`.
        // CRLF is two bytes, so position -1 is `\n`, -2 is `\r`, and -3 is
        // the payload's last byte ('e' from "no-newline").
        assert_eq!(entity[second_start - 1], b'\n', "CRLF terminator");
        assert_eq!(entity[second_start - 2], b'\r', "CR half of CRLF");
        assert_eq!(
            entity[second_start - 3],
            b'e',
            "byte before the CRLF must be the payload's last byte"
        );
    }
}
