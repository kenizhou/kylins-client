//! S/MIME cert-chain validation + revocation (Phase 1b Plan 2 / G4).
//!
//! Built on the `pkix-*` family (MarkAtwood's crate-pkix workspace):
//! - [`pkix_chain`] — ergonomic wrapper combining `pkix-path` (RFC 5280 §6.1
//!   path validation) with `pkix-revocation` (CRL/OCSP).
//! - [`pkix_profiles_cabf::SmimeProfile`] — CA/B Forum S/MIME BR reference
//!   policy (Mailbox-validated Strict generation; sets `emailProtection` EKU,
//!   `rfc822Name` SAN, 825-day validity cap, RSA ≥ 2048 bits, SHA-1 forbidden).
//! - [`pkix_identity`] — RFC 8398 From↔SAN mailbox binding (case-sensitive
//!   local-part, case-insensitive domain). Wired via `verify_smime_signer`.
//! - [`pkix_revocation`] — `RevocationChecker` trait + `CrlChecker`. Task 4
//!   supplies a `CrlChecker` built from fetched CRLs; Task 1 uses `NoRevocation`.
//!
//! A custom `SignatureVerifier` ([`SmimeVerifier`], Task 2) closes the RSA-PSS
//! gap in `DefaultVerifier` (PKIX-gphz). ECDSA-P384 is covered natively by
//! `DefaultVerifier` once the `rustcrypto` feature is enabled on `pkix-chain`
//! (transitively enables `pkix-path/p384`), so no custom P-384 code is needed.
//!
//! # Task 1 scope
//!
//! This module lands the **known-good path + the outcome types + the API pin**.
//! The spike test (`spike_validate_known_good_smime_chain`) builds a 3-cert
//! chain (root CA → intermediate CA → leaf S/MIME cert) via `x509-cert 0.3`'s
//! `CertificateBuilder`, re-parses each cert under the `x509-cert 0.2` line
//! that `pkix-chain` is built against, and calls `verify_smime_signer` with
//! `SmimeProfile` at a fixed verify-time. The negative spike confirms an
//! unrelated root is rejected.
//!
//! Tasks 2-5 build on this:
//! - Task 2 (DONE): [`SmimeVerifier`] wraps `DefaultVerifier` and adds RSA-PSS
//!   via `rsa::pss::VerifyingKey`. P-384 is delegated to `DefaultVerifier`
//!   (coverage enabled via the `rustcrypto` feature on `pkix-chain`).
//! - Task 3: surface a distinct `identity_match = false` outcome when
//!   `verify_smime_signer` fails with `Error::Identity` (vs `Error::Path`).
//! - Task 4: feed `_crls` to a `CrlChecker` and set `revocation_state`
//!   (`Good`/`Revoked`/`Unchecked`) accordingly.
//! - Task 5: trust-ladder → `SignatureState` mapping in `SmimeBackend::verify`.
//!
//! # x509-cert 0.2 ↔ 0.3 bridge
//!
//! `pkix-chain 0.4.1` depends on `pkix-path 0.3.2`, which depends on
//! `x509-cert 0.2` (and `der 0.7` / `spki 0.7`). Our crate builds certs with
//! `x509-cert 0.3` (required by the vendored `cms` builder). The two major
//! versions coexist in the dep graph; types are NOT shared. We bridge by
//! emitting DER from our 0.3 build stack and re-parsing under the aliased
//! `x509-cert-v02` dep (see `Cargo.toml`). The seam of this module is `&[u8]`
//! DER, so the bridge is local to `validate_signer_chain`.

// `pkix-chain` re-exports the building blocks we need: `verify_smime_signer`
// (use-case wrapper), `DefaultVerifier`, `NoRevocation`, `NoAiaFetcher`,
// `TrustAnchor`, and the `pkix_path`/`pkix_identity`/`pkix_revocation` modules.
// Task 2 also imports `SignatureVerifier` (the trait our `SmimeVerifier` impls).
use pkix_chain::{
    pkix_path::SignatureVerifier, verify_smime_signer, DefaultVerifier, NoAiaFetcher,
    NoRevocation, Profile, TrustAnchor,
};
use pkix_profiles_cabf::SmimeProfile;

// The 0.2 `Certificate` type `pkix-chain` expects (re-exported by `pkix-path`
// internally as `x509_cert::Certificate`, resolved through the aliased
// `x509-cert-v02` dep in `Cargo.toml`). Decoding requires the `der 0.7` Decode
// trait (the line `x509-cert 0.2` is built against), aliased as `der-07` so
// it does not collide with our build stack's `der 0.8::Decode`.
use der_07::Decode as DecodeV02;
use x509_cert_v02::Certificate as CertificateV02;

/// Revocation state for the validated chain.
///
/// Task 1 always returns `Unchecked` (no CRL wiring until Task 4). Task 4 will
/// populate `Good` / `Revoked` based on `pkix-revocation::CrlChecker` output
/// (hard-fail-on-revoked, soft-fail-on-transport).
//
// `Good` and `Revoked` are unused until Task 4 wires `CrlChecker`; the
// `allow(dead_code)` silences the warning for the Task 1 spike. Tasks 2-5 also
// consume `validate_signer_chain` / `ChainOutcome`, currently flagged analogously.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[allow(dead_code)]
pub(crate) enum RevocationState {
    /// CRL/OCSP reported the cert good.
    Good,
    /// CRL/OCSP reported the cert revoked (hard-fail).
    Revoked,
    /// No revocation check performed (no CRL supplied / stale CRL / soft-fail).
    Unchecked,
}

/// Outcome of cert-chain validation. Tasks 2-5 depend on these field names.
#[derive(Debug, Clone)]
#[allow(dead_code)]
pub(crate) struct ChainOutcome {
    /// `true` iff the leaf chains to a trust anchor under RFC 5280 §6.1 +
    /// `SmimeProfile`. Cryptographic signature failures, expired certs,
    /// broken issuer/subject linkage, and BR-profile violations all surface
    /// here as `false`.
    pub chain_valid: bool,
    /// `true` iff the signer cert's SAN matches `from_email` under RFC 8398
    /// (case-sensitive local-part, case-insensitive domain). Task 1 sets this
    /// from `verify_smime_signer`'s implicit identity binding — the call fails
    /// with `Error::Identity` if path validation succeeded but the SAN does not
    /// match. Task 3 will surface that case as `chain_valid=true,
    /// identity_match=false` (a `Mismatch` signature state).
    pub identity_match: bool,
    /// Revocation state. Task 1 always returns `Unchecked`.
    pub revocation_state: RevocationState,
    /// Human-readable failure reason when `chain_valid == false` or
    /// `identity_match == false`. Suitable for diagnostic logging; not parsed.
    pub failure_reason: Option<String>,
}

/// Validate an S/MIME signer cert chain under the CA/B Forum S/MIME BR profile.
///
/// Builds the leaf-first `chain = [leaf, *intermediates]` expected by
/// `pkix-chain`, derives `TrustAnchor`s from the supplied root certs, and
/// invokes `pkix_chain::verify_smime_signer` with `SmimeProfile` at
/// `signing_time_unix` (the CMS `signingTime` signed attribute; falls back to
/// now() at the call site if absent).
///
/// # Task 1 / Task 2 behavior
///
/// - `_crls` is a no-op → `revocation_state = Unchecked`. Task 4 wires
///   `pkix-revocation::CrlChecker`.
/// - `from_email` is parsed into a `MailboxName` and passed to
///   `verify_smime_signer`, which runs RFC 8398 From↔SAN binding. Task 3 will
///   refine the outcome to distinguish `Error::Identity` (chain OK, mismatch)
///   from `Error::Path`.
/// - Signature verifier is [`SmimeVerifier`] (Task 2). It delegates
///   RSA-PKCS1v15 + ECDSA-P256/P384 to `DefaultVerifier`, and adds an RSA-PSS
///   arm via `rsa::pss::VerifyingKey` (SHA-256/384/512). RSA-PSS params are
///   parsed via `pkcs1::RsaPssParams` (spki 0.7 line, matching pkix-path).
/// - Profile is `KylinsSmimeProfile` (Task 2). It is `SmimeProfile` with
///   `id-RSASSA-PSS` appended to `allowed_signature_algs`. Without this, the
///   BR profile's allowlist rejects RSA-PSS at the policy gate before the
///   verifier runs.
///
/// # Inputs
///
/// - `signer_cert_der`   — leaf cert DER (the S/MIME signer's cert).
/// - `intermediates_der` — intermediate CA certs DER, any order (we trust the
///   caller's leaf-first ordering per pkix-chain's contract).
/// - `trust_anchor_ders` — trust anchor cert DERs (user-imported CA roots).
/// - `from_email`        — RFC 5322 `From:` address for SAN binding.
/// - `signing_time_unix` — CMS `signingTime` (signed attribute) as Unix seconds.
/// - `_crls`             — CRL DERs (unused in Task 1).
#[allow(dead_code, clippy::too_many_arguments)]
pub(crate) fn validate_signer_chain(
    signer_cert_der: &[u8],
    intermediates_der: &[&[u8]],
    trust_anchor_ders: &[Vec<u8>],
    from_email: Option<&str>,
    signing_time_unix: i64,
    _crls: &[Vec<u8>],
) -> ChainOutcome {
    // Parse each input DER with x509-cert **0.2** (pkix-chain's stack). Our
    // callers hold raw DER (from CMS SignedData or the keystore), and DER is
    // wire-compatible across the 0.2/0.3 line, so a single from_der per cert
    // bridges the two stacks. A parse failure on any input is a hard reject.
    //
    // The 0.2 `Certificate::from_der` resolves through `der 0.7::Decode`
    // (the line `x509-cert 0.2` is built against), imported here as
    // `DecodeV02` to avoid colliding with our build stack's `der 0.8::Decode`.
    let leaf = match <CertificateV02 as DecodeV02>::from_der(signer_cert_der) {
        Ok(c) => c,
        Err(e) => {
            return fail(format!("parse signer cert: {e}"));
        }
    };
    let mut chain: Vec<CertificateV02> = Vec::with_capacity(1 + intermediates_der.len());
    chain.push(leaf);
    for (i, der) in intermediates_der.iter().enumerate() {
        match <CertificateV02 as DecodeV02>::from_der(der) {
            Ok(c) => chain.push(c),
            Err(e) => {
                return fail(format!("parse intermediate #{i}: {e}"));
            }
        }
    }
    let anchors: Vec<TrustAnchor> = match build_anchors(trust_anchor_ders) {
        Ok(a) => a,
        Err(e) => return fail(e),
    };

    // pkix-chain takes `now_unix: u64`. CMS `signingTime` is i64 because the
    // framework's `VerifyOp` carries it as such; clamp negative (pre-1970,
    // meaningless for signed mail) to 0.
    let now_unix: u64 = if signing_time_unix < 0 {
        0
    } else {
        signing_time_unix as u64
    };

    // From↔SAN binding: parse the RFC 5322 From: into a MailboxName. When
    // `from_email` is None, skip identity binding by calling verify_chain_default
    // (pure path validation, no identity check) and hardcode identity_match=true.
    if let Some(email) = from_email {
        let mailbox = match pkix_identity::MailboxName::parse(email) {
            Ok(m) => m,
            Err(e) => {
                return fail(format!("parse from_email {email:?}: {e}"));
            }
        };
        match verify_smime_signer(
            &chain,
            &anchors,
            &mailbox,
            &KylinsSmimeProfile,
            now_unix,
            &SmimeVerifier,
            &NoRevocation,
            &NoAiaFetcher,
        ) {
            Ok(_validated) => ChainOutcome {
                chain_valid: true,
                identity_match: true,
                revocation_state: RevocationState::Unchecked,
                failure_reason: None,
            },
            // Task 3 will split this arm to surface Error::Identity as
            // chain_valid=true, identity_match=false.
            Err(e) => fail(format!("{e}")),
        }
    } else {
        // No identity binding requested (e.g. verify-without-from). Run pure
        // path validation under the same BR policy; identity_match is moot,
        // surface as true so the caller's `chain_valid && identity_match`
        // short-circuit doesn't false-negative. Use `verify_chain` (not
        // `verify_chain_default`) so `SmimeVerifier` — and therefore the
        // RSA-PSS arm — applies on this branch too; `verify_chain_default`
        // hardcodes `DefaultVerifier` (which has no RSA-PSS coverage).
        let policy = KylinsSmimeProfile.policy(now_unix);
        match pkix_chain::verify_chain(
            &chain,
            &anchors,
            &policy,
            &SmimeVerifier,
            &NoRevocation,
            &NoAiaFetcher,
        ) {
            Ok(_validated) => ChainOutcome {
                chain_valid: true,
                identity_match: true,
                revocation_state: RevocationState::Unchecked,
                failure_reason: None,
            },
            Err(e) => fail(format!("{e}")),
        }
    }
}

/// Construct `TrustAnchor`s from raw cert DERs. Returns `Err` with the first
/// parse failure (caller surfaces as a chain-validation failure).
#[allow(dead_code)]
fn build_anchors(trust_anchor_ders: &[Vec<u8>]) -> Result<Vec<TrustAnchor>, String> {
    let mut out = Vec::with_capacity(trust_anchor_ders.len());
    for (i, der) in trust_anchor_ders.iter().enumerate() {
        let cert = <CertificateV02 as DecodeV02>::from_der(der)
            .map_err(|e| format!("parse trust anchor #{i}: {e}"))?;
        // `TrustAnchor::from_cert` silently drops malformed NameConstraints
        // (warned in pkix-path docs). Spike certs carry no NameConstraints, so
        // this is a non-issue here; Task 5 may switch to `try_from` for the
        // production path if user-imported roots ever carry malformed NCs.
        out.push(TrustAnchor::from_cert(cert));
    }
    Ok(out)
}

/// Build a `ChainOutcome` for a validation failure (chain_valid=false,
/// identity_match=false, Unchecked, failure_reason=Some).
#[allow(dead_code)]
fn fail(reason: String) -> ChainOutcome {
    ChainOutcome {
        chain_valid: false,
        identity_match: false,
        revocation_state: RevocationState::Unchecked,
        failure_reason: Some(reason),
    }
}

// ─────────────────── Task 2: SmimeVerifier (RSA-PSS) ────────────────────
//
// `DefaultVerifier` (pkix-path 0.3.2) covers RSA-PKCS1v15-SHA-{256,384,512}
// and ECDSA-P256-SHA256 unconditionally, plus ECDSA-P384-SHA384 when the
// `p384` feature is enabled (we enable it via `pkix-chain`'s `rustcrypto`
// feature). RSA-PSS (OID 1.2.840.113549.1.1.10) is tracked under PKIX-gphz
// and NOT covered. Real-world S/MIME chains (especially modern RSA roots)
// commonly use RSA-PSS, so we close the gap with a thin wrapper that:
//
// 1. Dispatches `id-RSASSA-PSS` to `rsa::pss::VerifyingKey::<Sha*>`, picking
//    the digest from the `AlgorithmIdentifier.parameters` (parsed as
//    `pkcs1::RsaPssParams`). SHA-256/384/512 supported; others → Err.
// 2. Delegates EVERYTHING ELSE to `DefaultVerifier` (so we transparently
//    inherit its RSA-PKCS1v15 + ECDSA-P256/P384 coverage).
//
// The verifier is verify-only (public keys); no private-key handling. The
// `rsa::pss::VerifyingKey` is constructed from the issuer's `RsaPublicKey`,
// never from a signing key.
//
// **Profile companion (`KylinsSmimeProfile`):** `SmimeProfile.policy()` sets
// `allowed_signature_algs` to `CABF_SMIME_BR_ALLOWED_ALGS` (RSA-PKCS1v15 +
// ECDSA only — pkix-profiles-cabf 0.2.0 pre-dates widespread RSA-PSS adoption
// in S/MIME BR). pkix-path's path validator checks this list BEFORE invoking
// the SignatureVerifier, so without an override the policy rejects RSA-PSS
// chains at the algorithm-allowlist gate regardless of `SmimeVerifier`.
// `KylinsSmimeProfile` adds `OID_RSASSA_PSS` to the allowed list, surfacing
// the verifier's RSA-PSS arm to the validator. Task 5 may refine this further
// (custom Profile / BasicSmimeProfile) for the 825-day-validity-cap gotcha.

/// `SignatureVerifier` for S/MIME chains: `DefaultVerifier` + an RSA-PSS arm.
///
/// Unit struct, like `DefaultVerifier`. Stateless; construction is free.
/// Wiring: `validate_signer_chain` passes `&SmimeVerifier` as the `V` arg to
/// `pkix_chain::verify_smime_signer` (from_email branch) and
/// `pkix_chain::verify_chain` (no-from branch).
#[derive(Debug, Clone, Copy, Default)]
#[allow(dead_code)]
pub(crate) struct SmimeVerifier;

/// `id-RSASSA-PSS` (1.2.840.113549.1.1.10) — RFC 8017 §8.1.
const OID_RSASSA_PSS: der_07::asn1::ObjectIdentifier =
    der_07::asn1::ObjectIdentifier::new_unwrap("1.2.840.113549.1.1.10");

/// Kylins S/MIME profile: `SmimeProfile` + `id-RSASSA-PSS` in
/// `allowed_signature_algs`.
///
/// The CA/B Forum S/MIME BR profile (`pkix-profiles-cabf::SmimeProfile`) sets
/// `allowed_signature_algs` to RSA-PKCS1v15-SHA-{256,384,512} + ECDSA-SHA-
/// {256,384,512} only. Real-world S/MIME chains commonly use RSA-PSS (modern
/// RSA roots cross-signing for PSS-capable clients); without this override,
/// pkix-path's policy gate rejects RSA-PSS chains before our `SmimeVerifier`
/// ever runs. Everything else (EKU, validity cap, min RSA bits) is inherited
/// from `SmimeProfile` unchanged.
///
/// Task 5 may fold this into a fuller custom profile that also addresses the
/// 825-day-validity-cap-on-roots gotcha (Task 1 carry-forward #2).
#[derive(Debug, Clone, Copy, Default)]
struct KylinsSmimeProfile;

impl Profile for KylinsSmimeProfile {
    fn id(&self) -> &'static str {
        "kylins.smime-with-rsa-pss"
    }

    fn version(&self) -> &'static str {
        "0.1"
    }

    fn policy(&self, now_unix: u64) -> pkix_chain::pkix_path::ValidationPolicy {
        let mut p = SmimeProfile.policy(now_unix);
        if let Some(algs) = p.allowed_signature_algs.as_mut() {
            algs.push(OID_RSASSA_PSS);
        }
        p
    }

    fn policy_oids(&self) -> &[der_07::asn1::ObjectIdentifier] {
        &[]
    }
}

impl SignatureVerifier for SmimeVerifier {
    fn verify_signature(
        &self,
        algorithm: spki_07::AlgorithmIdentifierRef<'_>,
        issuer_spki: spki_07::SubjectPublicKeyInfoRef<'_>,
        message: &[u8],
        signature: &[u8],
    ) -> Result<(), signature_2::Error> {
        if algorithm.oid == OID_RSASSA_PSS {
            verify_rsa_pss(algorithm, issuer_spki, message, signature)
        } else {
            // Delegate RSA-PKCS1v15 + ECDSA-P256/P384 (and any future alg
            // DefaultVerifier grows) to the stock pkix-path backend.
            DefaultVerifier.verify_signature(algorithm, issuer_spki, message, signature)
        }
    }
}

/// Verify an RSA-PSS signature. Parses the hash algorithm from the
/// `AlgorithmIdentifier.parameters` (a `RSASSA-PSS-params` SEQUENCE), picks
/// the matching `rsa::pss::VerifyingKey::<D>`, and calls `.verify(...)`.
///
/// # Errors
///
/// Returns `signature::Error` (the `signature 2.x` type the trait expects) if:
/// - `algorithm.parameters` is absent (RFC 8017 default is SHA-1, but
///   `SmimeProfile.allowed_signature_algs` forbids SHA-1; fail-closed).
/// - The params are malformed.
/// - The hash OID is anything other than SHA-256/SHA-384/SHA-512.
/// - The issuer SPKI is not a valid RSA public key.
/// - The signature bytes are malformed or fail verification.
fn verify_rsa_pss(
    algorithm: spki_07::AlgorithmIdentifierRef<'_>,
    issuer_spki: spki_07::SubjectPublicKeyInfoRef<'_>,
    message: &[u8],
    signature: &[u8],
) -> Result<(), signature_2::Error> {
    use rsa::signature::Verifier as _;
    use rsa::{pkcs8::DecodePublicKey as _, pss::Signature as PssSignature, pss::VerifyingKey};

    // Bridge: issuer SPKI is a 0.7 ref → encode to DER → decode as rsa 0.10's
    // `RsaPublicKey`. SPKI DER is wire-compatible across the 0.7/0.8 line.
    let spki_der = der_07::Encode::to_der(&issuer_spki).map_err(|_| signature_2::Error::new())?;
    let pub_key =
        rsa::RsaPublicKey::from_public_key_der(&spki_der).map_err(|_| signature_2::Error::new())?;

    let sig = PssSignature::try_from(signature).map_err(|_| signature_2::Error::new())?;

    // Pick the digest specified in the RSA-PSS params. SHA-1 (RFC 8017 default
    // when hashAlgorithm is absent) is rejected — SHA-1 is cryptographically
    // broken (SHAttered), so we fail closed. This complements (does not
    // duplicate) `KylinsSmimeProfile.allowed_signature_algs`: that list gates
    // signature-ALGORITHM OIDs and is blind to the hash inside id-RSASSA-PSS,
    // so the verifier must enforce the hash itself.
    // `rsa::pss::VerifyingKey<D>` is generic over our build stack's `sha2 0.11`
    // types (D: Digest); the spki 0.7 line only carries the AlgorithmIdentifier
    // bytes, so there's no version conflict at the type level.
    match rsa_pss_hash_oid(algorithm.parameters)? {
        // SHA-256 (2.16.840.1.101.3.4.2.1).
        SHA256_OID => VerifyingKey::<sha2::Sha256>::new(pub_key)
            .verify(message, &sig)
            .map_err(|_| signature_2::Error::new()),
        // SHA-384 (2.16.840.1.101.3.4.2.2).
        SHA384_OID => VerifyingKey::<sha2::Sha384>::new(pub_key)
            .verify(message, &sig)
            .map_err(|_| signature_2::Error::new()),
        // SHA-512 (2.16.840.1.101.3.4.2.3).
        SHA512_OID => VerifyingKey::<sha2::Sha512>::new(pub_key)
            .verify(message, &sig)
            .map_err(|_| signature_2::Error::new()),
        // Unsupported hash (incl. SHA-1, SHA-512/224, SHA-512/256, etc.).
        _ => Err(signature_2::Error::new()),
    }
}

/// Parse the `hashAlgorithm.oid` from an RSA-PSS `AlgorithmIdentifier.parameters`.
///
/// Returns `Err` if `parameters` is absent (RFC 8017 default hash = SHA-1,
/// which we reject as broken) or malformed. The `pkcs1 0.7` line uses the
/// same `spki 0.7` / `der 0.7` types as `pkix-path`, so the decode is direct.
fn rsa_pss_hash_oid(
    parameters: Option<der_07::AnyRef<'_>>,
) -> Result<der_07::asn1::ObjectIdentifier, signature_2::Error> {
    let any = parameters.ok_or_else(signature_2::Error::new)?;
    // `decode_as` calls RsaPssParams's DecodeValue impl on the AnyRef's value
    // bytes (spki 0.7 / der 0.7 line — same stack pkix-path uses).
    let pss: pkcs1_07::RsaPssParams<'_> =
        any.decode_as().map_err(|_| signature_2::Error::new())?;
    Ok(pss.hash.oid)
}

/// SHA-256 OID (2.16.840.1.101.3.4.2.1).
const SHA256_OID: der_07::asn1::ObjectIdentifier =
    der_07::asn1::ObjectIdentifier::new_unwrap("2.16.840.1.101.3.4.2.1");
/// SHA-384 OID (2.16.840.1.101.3.4.2.2).
const SHA384_OID: der_07::asn1::ObjectIdentifier =
    der_07::asn1::ObjectIdentifier::new_unwrap("2.16.840.1.101.3.4.2.2");
/// SHA-512 OID (2.16.840.1.101.3.4.2.3).
const SHA512_OID: der_07::asn1::ObjectIdentifier =
    der_07::asn1::ObjectIdentifier::new_unwrap("2.16.840.1.101.3.4.2.3");

// ───────────────────────────── tests ─────────────────────────────

#[cfg(test)]
mod spike_tests {
    use super::*;

    use std::str::FromStr;
    use std::time::Duration;

    use der::Encode;
    use der::referenced::OwnedToRef;
    use p256::ecdsa::{DerSignature, SigningKey};
    use p256::elliptic_curve::Generate;
    use p256::pkcs8::DecodePrivateKey;
    use pkcs8::EncodePrivateKey;
    use x509_cert::builder::{Builder, CertificateBuilder};
    use x509_cert::builder::profile::BuilderProfile;
    use x509_cert::certificate::TbsCertificate;
    use x509_cert::ext::pkix::name::GeneralName;
    use x509_cert::ext::pkix::{
        BasicConstraints, ExtendedKeyUsage, KeyUsage, KeyUsages, SubjectAltName,
        SubjectKeyIdentifier,
    };
    use x509_cert::ext::Extension;
    use x509_cert::name::Name;
    use x509_cert::serial_number::SerialNumber;
    use x509_cert::time::Validity;
    use x509_cert::SubjectPublicKeyInfo;

    /// id-kp-emailProtection (1.3.6.1.5.5.7.3.4) — RFC 5280.
    const EKU_EMAIL_PROTECTION: der::asn1::ObjectIdentifier =
        der::asn1::ObjectIdentifier::new_unwrap("1.3.6.1.5.5.7.3.4");

    /// Validity window for spike certs. Kept well under SmimeProfile's 825-day
    /// cap (`max_validity_secs` applies to EVERY cert in the chain, including
    /// the root — see pkix-profiles-cabf::SmimeProfile rustdoc).
    const SPIKE_VALIDITY_SECS: u64 = 200 * 24 * 60 * 60;

    /// A test profile parameterised on subject + issuer (self-signed when they
    /// coincide). Returns no default extensions; every extension is added
    /// explicitly so the leaf vs CA shape is fully controlled by the helper.
    struct TestCertProfile {
        subject: Name,
        issuer: Name,
    }

    impl BuilderProfile for TestCertProfile {
        fn get_subject(&self) -> Name {
            self.subject.clone()
        }
        fn get_issuer(&self, _subject: &Name) -> Name {
            // Ignore the implicit `subject` arg; CA-signed certs carry their
            // own issuer (the parent CA's subject).
            self.issuer.clone()
        }
        fn build_extensions(
            &self,
            _spk: spki::SubjectPublicKeyInfoRef<'_>,
            _issuer_spk: spki::SubjectPublicKeyInfoRef<'_>,
            _tbs: &TbsCertificate,
        ) -> x509_cert::builder::Result<Vec<Extension>> {
            Ok(Vec::new())
        }
    }

    /// Built cert + private key for the spike.
    struct BuiltTestCert {
        cert_der: Vec<u8>,
        priv_pkcs8_der: Vec<u8>,
    }

    /// Build a CA cert (root if `parent` is None, intermediate otherwise).
    ///
    /// Extensions: `BasicConstraints { cA: true, path_len: None }` (critical),
    /// `KeyUsage = keyCertSign | cRLSign` (critical), `SubjectKeyIdentifier`.
    /// All certs are ECDSA-P256 (matches `DefaultVerifier`'s native coverage,
    /// keeping the spike focused on path validation rather than Task 2's
    /// custom-verifier work).
    fn build_ca(cn: &str, parent: Option<(&[u8], &[u8])>) -> BuiltTestCert {
        let mut rng = rand::rng();
        let signing_key = SigningKey::generate_from_rng(&mut rng);
        let verifying_key = signing_key.verifying_key();
        let pub_spki = SubjectPublicKeyInfo::from_key(verifying_key)
            .expect("spki from key");

        // Compute SubjectKeyIdentifier BEFORE the builder takes ownership of
        // `pub_spki` (matches the ordering in cert.rs::build_self_signed_smime_cert).
        let ski = SubjectKeyIdentifier::try_from(pub_spki.owned_to_ref()).expect("ski");

        let subject = Name::from_str(&format!("CN={cn}")).expect("subject name");
        let issuer = match parent {
            Some((parent_der, _)) => {
                let parent_cert =
                    <x509_cert::Certificate as der::Decode>::from_der(parent_der)
                        .expect("parse parent cert");
                parent_cert.tbs_certificate().subject().clone()
            }
            None => subject.clone(),
        };
        let profile = TestCertProfile { subject, issuer };

        let serial = SerialNumber::from(rand::random::<u32>());
        let validity = Validity::from_now(Duration::from_secs(SPIKE_VALIDITY_SECS))
            .expect("validity");

        let mut builder = CertificateBuilder::new(profile, serial, validity, pub_spki)
            .expect("cert builder");

        // BasicConstraints cA:TRUE (critical by x509-cert 0.3's Criticality impl).
        let bc = BasicConstraints {
            ca: true,
            path_len_constraint: None,
        };
        builder.add_extension(&bc).expect("bc ext");

        // KeyUsage: keyCertSign + cRLSign (CA). Critical.
        let key_usage = KeyUsage(KeyUsages::KeyCertSign | KeyUsages::CRLSign);
        builder.add_extension(&key_usage).expect("key usage ext");

        // SubjectKeyIdentifier (RFC 5280 method 1).
        builder.add_extension(&ski).expect("ski ext");

        // Sign with parent's key if given, else self-sign.
        let cert = match parent {
            Some((_, parent_priv)) => {
                let parent_sk = SigningKey::from_pkcs8_der(parent_priv).expect("parent key");
                builder
                    .build::<_, DerSignature>(&parent_sk)
                    .expect("cert build/sign")
            }
            None => builder
                .build::<_, DerSignature>(&signing_key)
                .expect("cert build/sign (self)"),
        };
        let cert_der = cert.to_der().expect("cert to_der");

        let priv_pkcs8_der = signing_key
            .to_pkcs8_der()
            .expect("pkcs8 der")
            .as_bytes()
            .to_vec();

        BuiltTestCert {
            cert_der,
            priv_pkcs8_der,
        }
    }

    /// Build an S/MIME leaf cert signed by `parent`.
    ///
    /// Extensions: `KeyUsage = digitalSignature | keyEncipherment`,
    /// `ExtendedKeyUsage = emailProtection`, `SubjectAltName = rfc822Name(email)`,
    /// `SubjectKeyIdentifier`. Matches the shape `cert.rs` produces for the
    /// self-signed case (so the SmimeProfile's leaf checks pass).
    fn build_smime_leaf(email: &str, parent: (&[u8], &[u8])) -> BuiltTestCert {
        let mut rng = rand::rng();
        let signing_key = SigningKey::generate_from_rng(&mut rng);
        let verifying_key = signing_key.verifying_key();
        let pub_spki = SubjectPublicKeyInfo::from_key(verifying_key)
            .expect("spki from key");

        // SKI must be computed before the builder takes ownership of pub_spki.
        let ski = SubjectKeyIdentifier::try_from(pub_spki.owned_to_ref()).expect("ski");

        let cn = email.split('@').next().filter(|s| !s.is_empty()).unwrap_or("smime");
        let subject = Name::from_str(&format!("CN={cn}")).expect("subject name");
        let parent_cert = <x509_cert::Certificate as der::Decode>::from_der(parent.0)
            .expect("parse parent cert");
        let issuer = parent_cert.tbs_certificate().subject().clone();
        let profile = TestCertProfile { subject, issuer };

        let serial = SerialNumber::from(rand::random::<u32>());
        let validity = Validity::from_now(Duration::from_secs(SPIKE_VALIDITY_SECS))
            .expect("validity");

        let mut builder = CertificateBuilder::new(profile, serial, validity, pub_spki)
            .expect("cert builder");

        // KeyUsage: digitalSignature + keyEncipherment (S/MIME signing + key transport).
        let key_usage = KeyUsage(KeyUsages::DigitalSignature | KeyUsages::KeyEncipherment);
        builder.add_extension(&key_usage).expect("key usage ext");

        // EKU: emailProtection.
        let eku = ExtendedKeyUsage(vec![EKU_EMAIL_PROTECTION]);
        builder.add_extension(&eku).expect("eku ext");

        // SAN: rfc822Name = email.
        let email_ia5 =
            der::asn1::Ia5String::new(email.as_bytes()).expect("san email ia5");
        let san = SubjectAltName(vec![GeneralName::Rfc822Name(email_ia5)]);
        builder.add_extension(&san).expect("san ext");

        // SubjectKeyIdentifier.
        builder.add_extension(&ski).expect("ski ext");

        let parent_sk = SigningKey::from_pkcs8_der(parent.1).expect("parent key");
        let cert = builder
            .build::<_, DerSignature>(&parent_sk)
            .expect("cert build/sign");
        let cert_der = cert.to_der().expect("cert to_der");

        let priv_pkcs8_der = signing_key
            .to_pkcs8_der()
            .expect("pkcs8 der")
            .as_bytes()
            .to_vec();

        BuiltTestCert {
            cert_der,
            priv_pkcs8_der,
        }
    }

    // ────── Task 2 cert builders: RSA-PSS + ECDSA-P384 chains ──────

    /// Build an RSA cert (CA if `parent` is None for root, intermediate if
    /// `parent` is Some). Signs with **RSA-PSS-SHA256** (the algorithm gap
    /// `DefaultVerifier` does NOT cover — exercised by the RSA-PSS chain test).
    ///
    /// Mirrors `build_ca`'s extension set: BasicConstraints cA:TRUE (critical),
    /// KeyUsage keyCertSign|cRLSign (critical), SubjectKeyIdentifier.
    fn build_ca_rsa_pss(cn: &str, parent: Option<(&[u8], &[u8])>) -> BuiltTestCert {
        use rsa::pss::{Signature as RsaPssSignature, SigningKey as RsaPssSigningKey};
        use rsa::{RsaPrivateKey, pkcs8::EncodePrivateKey as _};

        let mut rng = rand::rng();
        // RSA-2048 (SmimeProfile.min_rsa_key_bits = 2048).
        let signing_key = RsaPrivateKey::new(&mut rng, 2048).expect("rsa key gen");
        let pub_spki = SubjectPublicKeyInfo::from_key(&signing_key.to_public_key())
            .expect("spki from rsa pub");

        let ski = SubjectKeyIdentifier::try_from(pub_spki.owned_to_ref()).expect("ski");

        let subject = Name::from_str(&format!("CN={cn}")).expect("subject name");
        let issuer = match parent {
            Some((parent_der, _)) => {
                let parent_cert = <x509_cert::Certificate as der::Decode>::from_der(parent_der)
                    .expect("parse parent cert");
                parent_cert.tbs_certificate().subject().clone()
            }
            None => subject.clone(),
        };
        let profile = TestCertProfile { subject, issuer };

        let serial = SerialNumber::from(rand::random::<u32>());
        let validity = Validity::from_now(Duration::from_secs(SPIKE_VALIDITY_SECS))
            .expect("validity");

        let mut builder = CertificateBuilder::new(profile, serial, validity, pub_spki)
            .expect("cert builder");

        let bc = BasicConstraints {
            ca: true,
            path_len_constraint: None,
        };
        builder.add_extension(&bc).expect("bc ext");
        let key_usage = KeyUsage(KeyUsages::KeyCertSign | KeyUsages::CRLSign);
        builder.add_extension(&key_usage).expect("key usage ext");
        builder.add_extension(&ski).expect("ski ext");

        let cert = match parent {
            Some((_, parent_priv)) => {
                let parent_sk = RsaPrivateKey::from_pkcs8_der(parent_priv).expect("parent key");
                let parent_pss = RsaPssSigningKey::<sha2::Sha256>::new(parent_sk);
                builder
                    .build_with_rng::<_, RsaPssSignature, _>(&parent_pss, &mut rng)
                    .expect("cert build/sign")
            }
            None => {
                let pss = RsaPssSigningKey::<sha2::Sha256>::new(signing_key.clone());
                builder
                    .build_with_rng::<_, RsaPssSignature, _>(&pss, &mut rng)
                    .expect("cert build/sign (self)")
            }
        };
        let cert_der = cert.to_der().expect("cert to_der");

        let priv_pkcs8_der = signing_key
            .to_pkcs8_der()
            .expect("pkcs8 der")
            .as_bytes()
            .to_vec();

        BuiltTestCert {
            cert_der,
            priv_pkcs8_der,
        }
    }

    /// Build an S/MIME leaf cert whose own key is RSA-2048 and which is signed
    /// by `parent` using **RSA-PSS-SHA256**. Mirrors `build_smime_leaf`'s
    /// extension set (KeyUsage digitalSignature|keyEncipherment, EKU
    /// emailProtection, SAN rfc822Name, SKI).
    fn build_smime_leaf_rsa_pss(email: &str, parent: (&[u8], &[u8])) -> BuiltTestCert {
        use rsa::pss::{Signature as RsaPssSignature, SigningKey as RsaPssSigningKey};
        use rsa::{RsaPrivateKey, pkcs8::EncodePrivateKey as _};

        let mut rng = rand::rng();
        let signing_key = RsaPrivateKey::new(&mut rng, 2048).expect("rsa key gen");
        let pub_spki = SubjectPublicKeyInfo::from_key(&signing_key.to_public_key())
            .expect("spki from rsa pub");
        let ski = SubjectKeyIdentifier::try_from(pub_spki.owned_to_ref()).expect("ski");

        let cn = email.split('@').next().filter(|s| !s.is_empty()).unwrap_or("smime");
        let subject = Name::from_str(&format!("CN={cn}")).expect("subject name");
        let parent_cert = <x509_cert::Certificate as der::Decode>::from_der(parent.0)
            .expect("parse parent cert");
        let issuer = parent_cert.tbs_certificate().subject().clone();
        let profile = TestCertProfile { subject, issuer };

        let serial = SerialNumber::from(rand::random::<u32>());
        let validity = Validity::from_now(Duration::from_secs(SPIKE_VALIDITY_SECS))
            .expect("validity");

        let mut builder = CertificateBuilder::new(profile, serial, validity, pub_spki)
            .expect("cert builder");

        let key_usage = KeyUsage(KeyUsages::DigitalSignature | KeyUsages::KeyEncipherment);
        builder.add_extension(&key_usage).expect("key usage ext");
        let eku = ExtendedKeyUsage(vec![EKU_EMAIL_PROTECTION]);
        builder.add_extension(&eku).expect("eku ext");

        let email_ia5 =
            der::asn1::Ia5String::new(email.as_bytes()).expect("san email ia5");
        let san = SubjectAltName(vec![GeneralName::Rfc822Name(email_ia5)]);
        builder.add_extension(&san).expect("san ext");
        builder.add_extension(&ski).expect("ski ext");

        let parent_sk = RsaPrivateKey::from_pkcs8_der(parent.1).expect("parent key");
        let parent_pss = RsaPssSigningKey::<sha2::Sha256>::new(parent_sk);
        let cert = builder
            .build_with_rng::<_, RsaPssSignature, _>(&parent_pss, &mut rng)
            .expect("cert build/sign");
        let cert_der = cert.to_der().expect("cert to_der");

        let priv_pkcs8_der = signing_key
            .to_pkcs8_der()
            .expect("pkcs8 der")
            .as_bytes()
            .to_vec();

        BuiltTestCert {
            cert_der,
            priv_pkcs8_der,
        }
    }

    /// Build a P-384 ECDSA cert (CA if `parent` is None for root, intermediate
    /// otherwise). Self-signs / is signed with **ECDSA-P384-SHA384**. Exercises
    /// `DefaultVerifier`'s `p384`-feature arm (enabled via `pkix-chain`'s
    /// `rustcrypto` feature).
    fn build_ca_p384(cn: &str, parent: Option<(&[u8], &[u8])>) -> BuiltTestCert {
        use p384::ecdsa::{DerSignature as P384DerSignature, SigningKey as P384SigningKey};
        use p384::elliptic_curve::Generate as _;
        use p384::pkcs8::DecodePrivateKey as _;

        let mut rng = rand::rng();
        let signing_key = P384SigningKey::generate_from_rng(&mut rng);
        let verifying_key = signing_key.verifying_key();
        let pub_spki =
            SubjectPublicKeyInfo::from_key(verifying_key).expect("spki from p384 pub");
        let ski = SubjectKeyIdentifier::try_from(pub_spki.owned_to_ref()).expect("ski");

        let subject = Name::from_str(&format!("CN={cn}")).expect("subject name");
        let issuer = match parent {
            Some((parent_der, _)) => {
                let parent_cert = <x509_cert::Certificate as der::Decode>::from_der(parent_der)
                    .expect("parse parent cert");
                parent_cert.tbs_certificate().subject().clone()
            }
            None => subject.clone(),
        };
        let profile = TestCertProfile { subject, issuer };

        let serial = SerialNumber::from(rand::random::<u32>());
        let validity = Validity::from_now(Duration::from_secs(SPIKE_VALIDITY_SECS))
            .expect("validity");

        let mut builder = CertificateBuilder::new(profile, serial, validity, pub_spki)
            .expect("cert builder");

        let bc = BasicConstraints {
            ca: true,
            path_len_constraint: None,
        };
        builder.add_extension(&bc).expect("bc ext");
        let key_usage = KeyUsage(KeyUsages::KeyCertSign | KeyUsages::CRLSign);
        builder.add_extension(&key_usage).expect("key usage ext");
        builder.add_extension(&ski).expect("ski ext");

        let cert = match parent {
            Some((_, parent_priv)) => {
                let parent_sk = P384SigningKey::from_pkcs8_der(parent_priv).expect("parent key");
                builder
                    .build::<_, P384DerSignature>(&parent_sk)
                    .expect("cert build/sign")
            }
            None => builder
                .build::<_, P384DerSignature>(&signing_key)
                .expect("cert build/sign (self)"),
        };
        let cert_der = cert.to_der().expect("cert to_der");

        let priv_pkcs8_der = signing_key
            .to_pkcs8_der()
            .expect("pkcs8 der")
            .as_bytes()
            .to_vec();

        BuiltTestCert {
            cert_der,
            priv_pkcs8_der,
        }
    }

    /// Build a P-384 S/MIME leaf cert signed by `parent` using ECDSA-P384.
    /// The leaf's own key is also P-384 (DefaultVerifier's native coverage
    /// post-`rustcrypto` feature).
    fn build_smime_leaf_p384(email: &str, parent: (&[u8], &[u8])) -> BuiltTestCert {
        use p384::ecdsa::{DerSignature as P384DerSignature, SigningKey as P384SigningKey};
        use p384::elliptic_curve::Generate as _;
        use p384::pkcs8::DecodePrivateKey as _;

        let mut rng = rand::rng();
        let signing_key = P384SigningKey::generate_from_rng(&mut rng);
        let verifying_key = signing_key.verifying_key();
        let pub_spki =
            SubjectPublicKeyInfo::from_key(verifying_key).expect("spki from p384 pub");
        let ski = SubjectKeyIdentifier::try_from(pub_spki.owned_to_ref()).expect("ski");

        let cn = email.split('@').next().filter(|s| !s.is_empty()).unwrap_or("smime");
        let subject = Name::from_str(&format!("CN={cn}")).expect("subject name");
        let parent_cert = <x509_cert::Certificate as der::Decode>::from_der(parent.0)
            .expect("parse parent cert");
        let issuer = parent_cert.tbs_certificate().subject().clone();
        let profile = TestCertProfile { subject, issuer };

        let serial = SerialNumber::from(rand::random::<u32>());
        let validity = Validity::from_now(Duration::from_secs(SPIKE_VALIDITY_SECS))
            .expect("validity");

        let mut builder = CertificateBuilder::new(profile, serial, validity, pub_spki)
            .expect("cert builder");

        let key_usage = KeyUsage(KeyUsages::DigitalSignature | KeyUsages::KeyEncipherment);
        builder.add_extension(&key_usage).expect("key usage ext");
        let eku = ExtendedKeyUsage(vec![EKU_EMAIL_PROTECTION]);
        builder.add_extension(&eku).expect("eku ext");

        let email_ia5 =
            der::asn1::Ia5String::new(email.as_bytes()).expect("san email ia5");
        let san = SubjectAltName(vec![GeneralName::Rfc822Name(email_ia5)]);
        builder.add_extension(&san).expect("san ext");
        builder.add_extension(&ski).expect("ski ext");

        let parent_sk = P384SigningKey::from_pkcs8_der(parent.1).expect("parent key");
        let cert = builder
            .build::<_, P384DerSignature>(&parent_sk)
            .expect("cert build/sign");
        let cert_der = cert.to_der().expect("cert to_der");

        let priv_pkcs8_der = signing_key
            .to_pkcs8_der()
            .expect("pkcs8 der")
            .as_bytes()
            .to_vec();

        BuiltTestCert {
            cert_der,
            priv_pkcs8_der,
        }
    }

    /// Spike (positive): build a 3-cert chain (root CA → intermediate CA → leaf
    /// S/MIME cert), validate the leaf against the root at a fixed verify-time
    /// under SmimeProfile, and assert the validation succeeds with
    /// identity_match (From: user@example.com matches the leaf SAN).
    ///
    /// This EXERCISES the real pkix-* API surface and pins it for Tasks 2-5
    /// (see the Task 1 report's "API pin" section).
    #[test]
    fn spike_validate_known_good_smime_chain() {
        let root = build_ca("Kylins Test Root CA", None);
        let inter = build_ca(
            "Kylins Test Intermediate CA",
            Some((&root.cert_der, &root.priv_pkcs8_der)),
        );
        let leaf = build_smime_leaf(
            "user@example.com",
            (&inter.cert_der, &inter.priv_pkcs8_der),
        );

        // Verify-time INSIDE the cert validity window and AFTER the notBefore
        // (cert.rs uses `Validity::from_now` so notBefore ≈ test execution time).
        // 1 day headroom avoids edge-case rejections when the test runs at the
        // exact second of issuance.
        let signing_time_unix = (std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_secs()
            + 86_400) as i64;

        let outcome = validate_signer_chain(
            &leaf.cert_der,
            &[inter.cert_der.as_slice()],
            std::slice::from_ref(&root.cert_der),
            Some("user@example.com"),
            signing_time_unix,
            &[],
        );

        assert!(outcome.chain_valid, "known-good chain must validate; got failure: {:?}", outcome.failure_reason);
        assert!(outcome.identity_match, "from_email matches the leaf SAN");
        assert_eq!(outcome.revocation_state, RevocationState::Unchecked);
        assert!(outcome.failure_reason.is_none());
    }

    /// Spike (negative): validate the leaf against an UNRELATED root (not its
    /// issuer) → must surface `chain_valid == false`. Proves the engine rejects
    /// non-chaining roots rather than trusting any supplied anchor.
    #[test]
    fn spike_validate_with_wrong_root_fails() {
        let root = build_ca("Kylins Test Root CA", None);
        let inter = build_ca(
            "Kylins Test Intermediate CA",
            Some((&root.cert_der, &root.priv_pkcs8_der)),
        );
        let leaf = build_smime_leaf(
            "user@example.com",
            (&inter.cert_der, &inter.priv_pkcs8_der),
        );
        // Unrelated second root — never signed the intermediate.
        let wrong_root = build_ca("Kylins UNRELATED Root CA", None);

        let signing_time_unix = (std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_secs()
            + 86_400) as i64;

        let outcome = validate_signer_chain(
            &leaf.cert_der,
            &[inter.cert_der.as_slice()],
            std::slice::from_ref(&wrong_root.cert_der),
            Some("user@example.com"),
            signing_time_unix,
            &[],
        );

        assert!(
            !outcome.chain_valid,
            "leaf must NOT validate against an unrelated root"
        );
        assert!(
            outcome.failure_reason.is_some(),
            "failure_reason must be populated on rejection"
        );
    }

    /// From↔SAN mismatch: a leaf cert with SAN=user@example.com, validated
    /// against `from_email = imposter@example.com`. Task 1's outcome is
    /// `chain_valid=false, identity_match=false` because `verify_smime_signer`
    /// surfaces the mismatch as `Error::Identity` (path OK, identity fails) and
    /// Task 1's fail-closed maps any Err to chain_valid=false. Task 3 will
    /// split this into `chain_valid=true, identity_match=false`.
    #[test]
    fn spike_from_email_mismatch_currently_fails_chain() {
        let root = build_ca("Kylins Test Root CA", None);
        let inter = build_ca(
            "Kylins Test Intermediate CA",
            Some((&root.cert_der, &root.priv_pkcs8_der)),
        );
        let leaf = build_smime_leaf(
            "user@example.com",
            (&inter.cert_der, &inter.priv_pkcs8_der),
        );

        let signing_time_unix = (std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_secs()
            + 86_400) as i64;

        let outcome = validate_signer_chain(
            &leaf.cert_der,
            &[inter.cert_der.as_slice()],
            std::slice::from_ref(&root.cert_der),
            // Different mailbox from the cert's SAN.
            Some("imposter@example.com"),
            signing_time_unix,
            &[],
        );

        // Task 1 fail-closed: the verify_smime_signer Err surfaces as
        // chain_valid=false. This pins Task 3's starting point: split the
        // Error::Identity arm into chain_valid=true, identity_match=false.
        assert!(
            !outcome.chain_valid || !outcome.identity_match,
            "Task 1 spike: From↔SAN mismatch must fail somewhere; got {:?}",
            outcome
        );
    }

    // ────── Task 2: RSA-PSS + ECDSA-P384 chain validation ──────

    /// RSA-PSS-SHA256 signed chain (root self-signed RSA-PSS + leaf signed by
    /// root with RSA-PSS). `DefaultVerifier` alone would reject this — RSA-PSS
    /// (OID 1.2.840.113549.1.1.10) is a documented gap (PKIX-gphz). The
    /// `SmimeVerifier` wrapper closes the gap via `rsa::pss::VerifyingKey`.
    #[test]
    fn spike_validate_rsa_pss_signed_chain() {
        let root = build_ca_rsa_pss("Kylins RSA-PSS Root CA", None);
        let leaf = build_smime_leaf_rsa_pss(
            "rsa-pss@example.com",
            (&root.cert_der, &root.priv_pkcs8_der),
        );

        let signing_time_unix = (std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_secs()
            + 86_400) as i64;

        let outcome = validate_signer_chain(
            &leaf.cert_der,
            &[],
            std::slice::from_ref(&root.cert_der),
            Some("rsa-pss@example.com"),
            signing_time_unix,
            &[],
        );

        assert!(
            outcome.chain_valid,
            "RSA-PSS signed chain must validate via SmimeVerifier; got failure: {:?}",
            outcome.failure_reason
        );
        assert!(outcome.identity_match, "from_email matches the leaf SAN");
        assert!(outcome.failure_reason.is_none());
    }

    /// ECDSA-P384-SHA384 signed chain (root self-signed P-384 + leaf signed by
    /// root with P-384). Coverage comes from `DefaultVerifier` once the
    /// `rustcrypto` feature is enabled on `pkix-chain` (transitively enables
    /// `pkix-path/p384`). `SmimeVerifier` delegates P-384 to `DefaultVerifier`.
    #[test]
    fn spike_validate_p384_signed_chain() {
        let root = build_ca_p384("Kylins P384 Root CA", None);
        let leaf = build_smime_leaf_p384(
            "p384@example.com",
            (&root.cert_der, &root.priv_pkcs8_der),
        );

        let signing_time_unix = (std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_secs()
            + 86_400) as i64;

        let outcome = validate_signer_chain(
            &leaf.cert_der,
            &[],
            std::slice::from_ref(&root.cert_der),
            Some("p384@example.com"),
            signing_time_unix,
            &[],
        );

        assert!(
            outcome.chain_valid,
            "ECDSA-P384 chain must validate via SmimeVerifier (delegated to DefaultVerifier); got failure: {:?}",
            outcome.failure_reason
        );
        assert!(outcome.identity_match, "from_email matches the leaf SAN");
        assert!(outcome.failure_reason.is_none());
    }
}
