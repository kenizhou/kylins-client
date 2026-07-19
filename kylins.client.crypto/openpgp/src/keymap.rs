//! Sequoia `Cert` <-> framework `KeyHandleRef` / blob translations.
//!
//! Pure (de)serialization + handle-construction layer. No `KeyStore` trait
//! use (that lands in Task 8); the functions here convert between Sequoia's
//! [`openpgp::Cert`] and the framework's [`KeyHandleRef`] / binary TPK blobs.
//!
//! ## Verified Sequoia 2.4.1 API notes
//!
//! - [`Cert::serialize`] (via the `Marshal` trait,
//!   `sequoia_openpgp::serialize::Marshal`) emits **public packets only**
//!   (`serialize/cert.rs:100-191`: writes `PacketRef::PublicKey` /
//!   `PacketRef::PublicSubkey`). To serialize a Cert *with* its secret key
//!   material, wrap it via [`Cert::as_tsk`] first (`serialize/cert.rs:273`;
//!   the `TSK` Marshal impl at `serialize/cert.rs:695` writes
//!   `SecretKey`/`SecretSubkey` when `key.has_secret()`).
//! - [`Cert::armored`] returns `impl Serialize + SerializeInto` backed by an
//!   `Encoder::Cert` variant (`serialize/cert_armored.rs:84-88, 124-127`)
//!   that calls `cert.serialize(...)` under the hood — i.e. the armored form
//!   is also public-only. The armor `Kind` is `PublicKey`
//!   (`serialize/cert_armored.rs:161-162`).
//! - [`Cert::strip_secret_key_material`] (`cert.rs:3202`) is the verified
//!   equivalent of the brief's notional `strip_secret()` — no method named
//!   `strip_secret` exists on `Cert` in 2.4.1. Consumes `self`, returns a
//!   new `Cert` with secret material removed from the primary + every subkey.
//! - [`CertParser::from_bytes`] (via the `Parse` trait) auto-detects armor
//!   vs binary TPK form; validated by the Task 1 spike
//!   `spike_cert_armor_parse_roundtrip`.
use crypto_core::{Fingerprint, KeyHandle, KeyHandleRef, KeyId, KeyUsage, Standard};
use sequoia_openpgp as openpgp;
use sequoia_openpgp::cert::CertParser;
use sequoia_openpgp::parse::Parse;
use sequoia_openpgp::serialize::Marshal;

use crate::error::CryptoResult;

// All Sequoia results in this module route through `crate::error::map_sequoia`
// (the canonical mapper for `openpgp::Result<T>` = `Result<T, anyhow::Error>`).
// `anyhow::Error` does not implement `std::error::Error`, so the generic
// `crate::error::map_err` cannot accept it — see `error.rs` for details.

/// Framework fingerprint of a Cert's primary key (lowercase hex).
///
/// **Note:** Sequoia's `Fingerprint::to_hex()` returns UPPERCASE hex (per RFC
/// 4880 convention). `crypto_core::Fingerprint::new` lowercases on
/// construction, so the stored fingerprint is always lowercase regardless of
/// Sequoia's display format.
pub fn fingerprint_of(cert: &openpgp::Cert) -> Fingerprint {
    Fingerprint::new(cert.fingerprint().to_hex())
}

/// Build the framework handle for a Cert.
///
/// Cert-level handle: the engine's default Cert shape (produced by
/// `CertBuilder::add_signing_subkey()` + `add_transport_encryption_subkey()`,
/// see Task 1's `spike-notes.md`) carries both a signing subkey and a
/// transport-encryption subkey, so the usage is `SignAndEncrypt`.
pub fn cert_to_handle(cert: &openpgp::Cert) -> KeyHandleRef {
    let fp = fingerprint_of(cert);
    KeyHandleRef {
        handle: KeyHandle::Software(KeyId(format!("openpgp|{}", fp.as_str()))),
        standard: Standard::OpenPgp,
        fingerprint: fp,
        usage: KeyUsage::SignAndEncrypt,
        algorithm: "Ed25519/X25519".to_string(),
    }
}

/// Binary TPK serialization of a Cert **with** secret key material.
///
/// For at-rest storage only — never crosses the IPC boundary in plaintext.
/// Round-trips via [`parse_certs`].
///
/// **Note:** this MUST go through `cert.as_tsk().serialize(...)`. `Cert`'s
/// direct `Marshal` impl drops secret material (writes only `PublicKey` /
/// `PublicSubkey` packets); the `TSK` wrapper is what emits `SecretKey` /
/// `SecretSubkey` packets when the underlying key has secret material.
pub fn cert_to_secret_blob(cert: &openpgp::Cert) -> CryptoResult<Vec<u8>> {
    let mut buf = Vec::new();
    crate::error::map_sequoia(cert.as_tsk().serialize(&mut buf))?;
    Ok(buf)
}

/// Binary TPK serialization of a Cert with all secret key material REMOVED.
///
/// Safe to share/export (e.g. publish a public key to a keyserver). Uses
/// Sequoia's [`Cert::strip_secret_key_material`] (2.4.1, `cert.rs:3202`).
pub fn cert_to_public_blob(cert: &openpgp::Cert) -> CryptoResult<Vec<u8>> {
    // `strip_secret_key_material` consumes `self`; clone first so the caller's
    // `&Cert` is unaffected.
    let public_only = cert.clone().strip_secret_key_material();
    let mut buf = Vec::new();
    crate::error::map_sequoia(public_only.serialize(&mut buf))?;
    Ok(buf)
}

/// ASCII-armored serialization of a Cert's public packets.
///
/// Emits a `BEGIN PGP PUBLIC KEY BLOCK` frame: `cert.armored()` returns an
/// `Encoder::Cert` variant that delegates to `cert.serialize(...)`, which is
/// public-only by construction (see the module-level API notes).
pub fn cert_to_armored_public(cert: &openpgp::Cert) -> CryptoResult<Vec<u8>> {
    let mut buf = Vec::new();
    crate::error::map_sequoia(cert.armored().serialize(&mut buf))?;
    Ok(buf)
}

/// Parse one or more Certs from armored OR binary TPK bytes.
///
/// `CertParser::from_bytes` auto-detects the format. Returns certs in stream
/// order. Errors from a malformed preamble or any individual cert are routed
/// through [`crate::error::map_sequoia`] (i.e. surfaced as `CryptoError::Backend`).
pub fn parse_certs(data: &[u8]) -> CryptoResult<Vec<openpgp::Cert>> {
    let parser = crate::error::map_sequoia(CertParser::from_bytes(data))?;
    let mut out = Vec::new();
    for cert in parser {
        out.push(crate::error::map_sequoia(cert)?);
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;
    use sequoia_openpgp::cert::prelude::*;

    /// Task-1 spike `gen()` pattern, duplicated per the no-cross-task-assumption
    /// rule (this crate's lib-tests must not depend on `tests/spike.rs`).
    /// Yields a Cert with a primary (certify+sign) key + transport-encryption
    /// subkey + signing subkey — `CertBuilder::generate()` always produces a
    /// TSK (secret material present on every key).
    fn gen() -> openpgp::Cert {
        let (cert, _rev) = CertBuilder::new()
            .add_userid("keymap-test@example.org")
            .add_transport_encryption_subkey()
            .add_signing_subkey()
            .generate()
            .expect("CertBuilder::generate");
        cert
    }

    #[test]
    fn cert_to_handle_fields() {
        let cert = gen();
        let h = cert_to_handle(&cert);
        assert_eq!(h.standard, Standard::OpenPgp);
        assert_eq!(h.usage, KeyUsage::SignAndEncrypt);
        assert_eq!(h.fingerprint, fingerprint_of(&cert));
        assert_eq!(h.algorithm, "Ed25519/X25519");
        // KeyId is the tuple-struct inner String. Must be `openpgp|<lc-hex-fp>`.
        // `fingerprint_of` returns the crypto_core lowercased form; derive the
        // expected KeyId from it so the assertion is independent of Sequoia's
        // uppercase display format.
        let expected = format!("openpgp|{}", fingerprint_of(&cert).as_str());
        match h.handle {
            KeyHandle::Software(ref id) => assert_eq!(
                id.0, expected,
                "KeyId must be `openpgp|<lowercase-hex-fingerprint>`"
            ),
            ref other => panic!("expected KeyHandle::Software, got {other:?}"),
        }
    }

    #[test]
    fn fingerprint_of_is_lowercase_hex_of_sequoia_fp() {
        let cert = gen();
        let fp = fingerprint_of(&cert);
        // Sequoia's `to_hex()` returns UPPERCASE hex (RFC 4880 convention);
        // crypto_core::Fingerprint::new lowercases on construction, so our fp
        // is the lowercased form of Sequoia's display.
        assert_eq!(fp.as_str(), cert.fingerprint().to_hex().to_ascii_lowercase());
        // Stability: pure projection, no mutation across calls.
        assert_eq!(fp, fingerprint_of(&cert));
        // Idempotency: lowercasing an already-lowercased value is a no-op.
        assert_eq!(fp.as_str(), fp.as_str().to_ascii_lowercase());
    }

    #[test]
    fn secret_blob_roundtrips_and_preserves_secret_material() {
        let cert = gen();
        let blob = cert_to_secret_blob(&cert).expect("secret blob serializes");
        let parsed = parse_certs(&blob).expect("secret blob parses");
        assert_eq!(parsed.len(), 1, "one cert in, one cert out");
        // Critical contract: the secret blob MUST preserve secret key material
        // so the at-rest blob is later usable for sign/decrypt. If this fires,
        // `cert_to_secret_blob` is accidentally emitting public-only packets
        // (i.e. went through `cert.serialize` instead of `cert.as_tsk().serialize`).
        assert!(
            parsed[0].is_tsk(),
            "parsed secret-blob cert must retain secret key material"
        );
        // Fingerprint round-trips.
        assert_eq!(parsed[0].fingerprint(), cert.fingerprint());
    }

    #[test]
    fn public_blob_roundtrips_and_strips_secret_material() {
        let cert = gen();
        let blob = cert_to_public_blob(&cert).expect("public blob serializes");
        let parsed = parse_certs(&blob).expect("public blob parses");
        assert_eq!(parsed.len(), 1);
        // The public blob must NOT carry secret material.
        assert!(
            !parsed[0].is_tsk(),
            "parsed public-blob cert must NOT have secret key material"
        );
        // Fingerprint is stable across the strip + serialize + parse round-trip.
        assert_eq!(parsed[0].fingerprint(), cert.fingerprint());
    }

    #[test]
    fn armored_public_roundtrips_and_is_public_only() {
        let cert = gen();
        let armored = cert_to_armored_public(&cert).expect("armored public serializes");
        // Armor frame must be a PUBLIC KEY BLOCK, not a PRIVATE KEY BLOCK.
        // `cert.armored()` always selects `armor::Kind::PublicKey` for a `Cert`
        // (vs. `SecretKey` for a `TSK`), verified at
        // `serialize/cert_armored.rs:160-168`.
        let s = std::str::from_utf8(&armored).expect("armored output is utf8");
        assert!(
            s.contains("-----BEGIN PGP PUBLIC KEY BLOCK-----"),
            "armored-public must be a PUBLIC KEY BLOCK, got: {}",
            &s[..s.len().min(120)]
        );
        let parsed = parse_certs(&armored).expect("armored public parses");
        assert_eq!(parsed.len(), 1);
        assert!(
            !parsed[0].is_tsk(),
            "armored-public cert must NOT have secret key material"
        );
        assert_eq!(parsed[0].fingerprint(), cert.fingerprint());
    }

    #[test]
    fn parse_certs_accepts_binary_tpk_form() {
        // `cert_to_secret_blob` emits binary TPK (no armor wrapper); this
        // verifies the CertParser auto-detection branch for binary input.
        let cert = gen();
        let binary = cert_to_secret_blob(&cert).expect("binary blob");
        let parsed = parse_certs(&binary).expect("parse binary");
        assert_eq!(parsed.len(), 1);
        assert_eq!(parsed[0].fingerprint(), cert.fingerprint());
    }

    #[test]
    fn parse_certs_returns_empty_for_empty_input() {
        // `CertParser::from_bytes(b"")` yields no certs and no error. This
        // pins the contract so a later change to error-on-empty doesn't sneak
        // through unnoticed.
        let parsed = parse_certs(&[]).expect("empty input is not an error");
        assert!(parsed.is_empty(), "empty input -> zero certs");
    }
}
