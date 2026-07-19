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
//! - Task 3 (DONE): surface a distinct `identity_match = false` outcome when
//!   `verify_smime_signer` fails with `Error::Identity` (vs `Error::Path`).
//!   Path OK + From↔SAN mismatch → `chain_valid=true, identity_match=false`
//!   (caller maps to `SignatureState::Mismatch`, not `Invalid`).
//! - Task 4 (DONE): [`KylinsCrlChecker`] wraps one or more [`CrlChecker`]s
//!   built from the supplied CRL DERs. Maps results to `RevocationState`
//!   (hard-fail-on-revoked, soft-fail-on-transport). When no CRLs are
//!   supplied, the checker holds zero inner `CrlChecker`s — equivalent to
//!   `NoRevocation` → `Unchecked`.
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
// (use-case wrapper), `DefaultVerifier`, `NoAiaFetcher`, `TrustAnchor`, and the
// `pkix_path`/`pkix_identity`/`pkix_revocation` modules. Task 4 also imports
// `CrlChecker` (feature `crl`, already enabled on `pkix-chain`), and the
// `RevocationChecker` trait (needed to both impl our composite checker AND to
// call `check_revocation` on the inner `CrlChecker`s).
use std::cell::Cell;

use pkix_chain::{
    pkix_path::SignatureVerifier, pkix_revocation, verify_smime_signer, CrlChecker,
    DefaultVerifier, NoAiaFetcher, Profile, RevocationChecker, TrustAnchor,
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
/// Task 4 wires the CRL checker; the state is now populated per the spec §0.4
/// posture (hard-fail-on-revoked, soft-fail-on-transport):
/// - `Good` — a CRL covered the cert and the serial was not in the revoked list.
/// - `Revoked` — the CRL lists the cert's serial → `chain_valid = false`.
/// - `Unchecked` — no CRL supplied OR no CRL covered the cert (soft-fail —
///   chain proceeds, caller warns). Distinct from `Stale`: `Unchecked` means
///   we have NO revocation data for this cert at all.
/// - `Stale` — a CRL covered the cert but was unusable (expired past
///   `nextUpdate`, bad signature, out-of-scope, unparseable). The chain
///   still soft-fails (proceeds, caller warns), but the user can distinguish
///   "stale revocation data" from "no revocation data" — surfacing CRL-freshness
///   as a distinct warning. (2026-07-18 CRL-revocation-detail spec decision #1.)
///
/// Task 5: promoted from `pub(crate)` to `pub` so the backend's
/// `validate_recipient_certs` helper can read the outcome of
/// `validate_signer_chain` per recipient cert.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RevocationState {
    /// CRL reported the cert good (serial not in revoked list).
    Good,
    /// CRL reported the cert revoked (hard-fail → `chain_valid = false`).
    Revoked,
    /// No revocation check performed (no CRL supplied / no CRL covered the
    /// cert).
    Unchecked,
    /// A CRL covered the cert but was unusable (expired past `nextUpdate` /
    /// bad signature / out-of-scope / parse error). Soft-fail — chain
    /// proceeds. Distinguished from `Unchecked` (no CRL at all) so the UI
    /// can surface "stale revocation data" as a distinct warning.
    Stale,
}

/// Outcome of cert-chain validation. Tasks 2-5 depend on these field names.
///
/// Task 5: promoted from `pub(crate)` to `pub` so the G5 orchestrator and the
/// send-side `validate_recipient_certs` helper can consume it.
#[derive(Debug, Clone)]
pub struct ChainOutcome {
    /// `true` iff the leaf chains to a trust anchor under RFC 5280 §6.1 +
    /// `SmimeProfile`. Cryptographic signature failures, expired certs,
    /// broken issuer/subject linkage, and BR-profile violations all surface
    /// here as `false`.
    pub chain_valid: bool,
    /// `true` iff the signer cert's SAN matches `from_email` under RFC 8398
    /// (case-sensitive local-part, case-insensitive domain). Set from
    /// `verify_smime_signer`'s identity binding — when path validation succeeds
    /// but the SAN does not match, `verify_smime_signer` returns
    /// `Error::Identity`, which Task 3 surfaces as `chain_valid=true,
    /// identity_match=false` (a `Mismatch` signature state, not `Invalid`).
    pub identity_match: bool,
    /// Revocation state. Task 1 always returns `Unchecked`.
    pub revocation_state: RevocationState,
    /// Human-readable failure reason when `chain_valid == false` or
    /// `identity_match == false`. Suitable for diagnostic logging; not parsed.
    pub failure_reason: Option<String>,
    /// Structured RFC 5280 §5.3.1 CRLReason name when `revocation_state ==
    /// Revoked` (the stringified `pkix_revocation::CrlReason` variant, e.g.
    /// `"KeyCompromise"` / `"CaCompromise"` / `"AffiliationChanged"` /
    /// `"Superseded"` / `"CessationOfOperation"` / `"CertificateHold"` /
    /// `"RemoveFromCRL"` / `"PrivilegeWithdrawn"` / `"AaCompromise"` /
    /// `"Unspecified"`). Populated only when the chain hard-failed because of
    /// an explicit CRL revocation entry. `None` for every other outcome (Good /
    /// Unchecked / Stale / non-revocation chain failures). A revoked cert
    /// whose CRL entry omitted the reasonCode extension surfaces
    /// `Some("Unspecified")` (spec decision #5 — stable non-null signal).
    /// (2026-07-18 CRL-revocation-detail spec decision #2.)
    pub revocation_reason: Option<String>,
}

/// Validate an S/MIME signer cert chain under the CA/B Forum S/MIME BR profile.
///
/// Builds the leaf-first `chain = [leaf, *intermediates]` expected by
/// `pkix-chain`, derives `TrustAnchor`s from the supplied root certs, and
/// invokes `pkix_chain::verify_smime_signer` with `SmimeProfile` at
/// `signing_time_unix` (the CMS `signingTime` signed attribute; falls back to
/// now() at the call site if absent).
///
/// # Task 1 / Task 2 / Task 3 / Task 4 behavior
///
/// - `crls` (Task 4) — CRL DERs are parsed into [`KylinsCrlChecker`] (a
///   composite over one or more [`CrlChecker`]s). Unparseable CRLs are silently
///   skipped (soft-fail). When zero CRLs are supplied OR all fail to parse,
///   the checker holds zero inner `CrlChecker`s → equivalent to `NoRevocation`
///   → `RevocationState::Unchecked`. When a CRL covers the cert and the serial
///   is NOT in the revoked list → `Good`. When the serial IS revoked → `Revoked`
///   + `chain_valid = false` (hard-fail). When the CRL applies but is stale,
///     has a bad signature, or is otherwise unusable → `Unchecked` (soft-fail).
/// - `from_email` is parsed into a `MailboxName` and passed to
///   `verify_smime_signer`, which runs RFC 8398 From↔SAN binding. Task 3
///   splits the `Err` arm: `Error::Identity` (path OK, From↔SAN mismatch)
///   surfaces as `chain_valid=true, identity_match=false`; all other errors
///   surface as `chain_valid=false`.
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
/// - `crls`              — CRL DERs (one per issuing CA). Task 4 wires these
///   into the [`KylinsCrlChecker] passed as the `revocation` arg to
///   `verify_smime_signer` / `verify_chain`.
///
/// Task 5: promoted from `pub(crate)` to `pub` so the backend
/// `mail/crypto.rs::validate_recipient_certs` helper can call it per
/// recipient cert (closes the Plan 4a "unvalidated recipient cert"
/// carry-forward). The G5 receive orchestrator also calls this directly for
/// pre-encryption sender-cert sanity checks. The function is otherwise
/// unchanged from Task 4.
#[allow(clippy::too_many_arguments)]
pub fn validate_signer_chain(
    signer_cert_der: &[u8],
    intermediates_der: &[&[u8]],
    trust_anchor_ders: &[Vec<u8>],
    from_email: Option<&str>,
    signing_time_unix: i64,
    crls: &[Vec<u8>],
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

    // Build the CRL revocation checker (Task 4). `KylinsCrlChecker` wraps one
    // or more `pkix_revocation::CrlChecker`s, each built from a single CRL DER.
    // Unparseable CRLs are silently skipped (soft-fail — the transport layer's
    // responsibility is to supply DER bytes; a malformed CRL is treated like a
    // missing one). When zero CRLs parse, the checker holds zero inner
    // `CrlChecker`s — every `check_revocation` call iterates zero items and
    // returns `Ok(())`, exactly matching `NoRevocation` semantics.
    //
    // `SmimeVerifier` is `Copy`, so it can be freely duplicated into each
    // inner `CrlChecker` (each needs its own copy for CRL-signature
    // verification). The `now_unix` (signing time) is the correct time for
    // CRL-freshness checks under RFC 5280 §6.3: we validate the message as of
    // its signing time, so a CRL that was fresh at signing time is still
    // valid for this verification even if it has since expired at wall-clock
    // time.
    let checker = KylinsCrlChecker::new(crls, now_unix, SmimeVerifier);

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
            &checker,
            &NoAiaFetcher,
        ) {
            Ok(_validated) => ChainOutcome {
                chain_valid: true,
                identity_match: true,
                revocation_state: checker.revocation_state(),
                failure_reason: None,
                revocation_reason: None,
            },
            // Identity mismatch (path OK, From↔SAN binding failed): per spec
            // §4.4, surface as chain_valid=true, identity_match=false so the
            // caller (Task 5's SmimeBackend::verify) maps this to
            // `SignatureState::Mismatch`, not `Invalid`. `verify_smime_signer`
            // runs RFC 5280 path validation FIRST (including revocation),
            // then identity binding only on path success — so an
            // `Error::Identity` implies the chain itself is valid AND the CRL
            // check passed (otherwise it would have been an Error::Revocation
            // or Error::Path); only the mailbox binding failed.
            Err(pkix_chain::Error::Identity(e)) => ChainOutcome {
                chain_valid: true,
                identity_match: false,
                // Revocation already passed (path validation + revocation run
                // before identity binding). Reflect the checker's state.
                revocation_state: checker.revocation_state(),
                failure_reason: Some(format!("identity mismatch: {e}")),
                // Identity mismatch is not a revocation outcome — the CRL
                // check passed (otherwise we'd be in the Revoked arm).
                revocation_reason: None,
            },
            // CRL says revoked → hard-fail (spec §0.4). `KylinsCrlChecker`
            // only returns `Err(Revoked{..})` from `check_revocation`; all
            // other revocation errors (stale CRL, bad signature, etc.) are
            // swallowed to `Ok(())` internally (soft-fail). So this arm fires
            // only when a fetched CRL explicitly lists the cert's serial.
            Err(pkix_chain::Error::Revocation(rev_err)) => match rev_err {
                pkix_revocation::Error::Revoked { serial, reason_code } => {
                    let reason_str = match reason_code {
                        Some(r) => format!("certificate {serial} revoked ({r:?})"),
                        None => format!("certificate {serial} revoked"),
                    };
                    // Stringify the RFC 5280 §5.3.1 CRLReason at the chain.rs
                    // boundary (the pkix enum is 0.7-line; we don't leak it).
                    // `format!("{r:?}")` yields the enum variant name verbatim
                    // (e.g. "KeyCompromise"). `None` reasonCode → "Unspecified"
                    // (spec decision #5 — stable non-null signal that lets the
                    // dialog render "Reason: Unspecified" rather than dropping
                    // the line).
                    let revocation_reason = Some(match reason_code {
                        Some(r) => format!("{r:?}"),
                        None => "Unspecified".to_string(),
                    });
                    ChainOutcome {
                        chain_valid: false,
                        identity_match: false,
                        revocation_state: RevocationState::Revoked,
                        failure_reason: Some(reason_str),
                        revocation_reason,
                    }
                }
                // Defensive: `KylinsCrlChecker` converts all non-Revoked
                // errors to Ok(()) (soft-fail), so a non-Revoked
                // `Error::Revocation` is unreachable. If it ever surfaces
                // (e.g. a future code change in pkix-chain), treat it as a
                // chain failure with Unchecked revocation.
                other => fail(format!("revocation: {other}")),
            },
            // All other errors (Path / ProfileViolation / Aia /
            // PathBuild / OcspDelegation / AiaDepthExceeded) indicate a chain
            // failure, not an identity or revocation outcome. Surface as
            // chain_valid=false, Unchecked.
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
            &checker,
            &NoAiaFetcher,
        ) {
            Ok(_validated) => ChainOutcome {
                chain_valid: true,
                identity_match: true,
                revocation_state: checker.revocation_state(),
                failure_reason: None,
                revocation_reason: None,
            },
            Err(pkix_chain::Error::Revocation(rev_err)) => match rev_err {
                pkix_revocation::Error::Revoked { serial, reason_code } => {
                    let reason_str = match reason_code {
                        Some(r) => format!("certificate {serial} revoked ({r:?})"),
                        None => format!("certificate {serial} revoked"),
                    };
                    let revocation_reason = Some(match reason_code {
                        Some(r) => format!("{r:?}"),
                        None => "Unspecified".to_string(),
                    });
                    ChainOutcome {
                        chain_valid: false,
                        identity_match: false,
                        revocation_state: RevocationState::Revoked,
                        failure_reason: Some(reason_str),
                        revocation_reason,
                    }
                }
                other => fail(format!("revocation: {other}")),
            },
            Err(e) => fail(format!("{e}")),
        }
    }
}

/// Construct `TrustAnchor`s from raw cert DERs. Returns `Err` with the first
/// parse failure (caller surfaces as a chain-validation failure).
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
fn fail(reason: String) -> ChainOutcome {
    ChainOutcome {
        chain_valid: false,
        identity_match: false,
        revocation_state: RevocationState::Unchecked,
        failure_reason: Some(reason),
        // Not a revoked-cert outcome → no revocation reason to surface.
        revocation_reason: None,
    }
}

// ──────────────────────── Task 4: CRL revocation ────────────────────────
//
// `pkix-revocation`'s `CrlChecker` validates against a SINGLE pre-loaded CRL
// DER. Real-world S/MIME chains involve multiple issuers (root CA →
// intermediate CA → leaf), each with its own CRL. `KylinsCrlChecker` is a
// thin composite that holds a `Vec<CrlChecker>` and, for each `(cert, issuer)`
// pair, finds the CRL whose issuer DN matches (continuing past
// `CrlIssuerMismatch`), then delegates to it.
//
// **Revocation posture (spec §0.4):** hard-fail-on-revoked,
// soft-fail-on-transport.
//
// | CRL result for a matching CRL      | Our return | Outcome        |
// |-------------------------------------|------------|----------------|
// | `Ok(())` (serial not in CRL)       | `Ok(())`   | `Good`         |
// | `Err(Revoked{..})`                  | `Err(..)`  | `Revoked`      |
// | `Err(CrlExpired)`                   | `Ok(())`   | `Unchecked`    |
// | `Err(CrlSignatureInvalid)`          | `Ok(())`   | `Unchecked`    |
// | `Err(OutOfScope{..})`               | `Ok(())`   | `Unchecked`    |
// | `Err(CrlIssuerMismatch)`            | try next   | (see below)    |
// | No CRL in the set covers the cert   | `Ok(())`   | `Unchecked`    |
// |
// | `CrlIssuerMismatch` means the CRL's issuer DN does not match the cert's
// | issuer — the CRL is simply not relevant for this cert. The checker
// | continues to the next CRL. If none match → `Ok(())` (soft-fail).
//
// Interior mutability (`Cell`) tracks whether ANY `check_revocation` call
// found a matching CRL (`any_matched`) and whether ANY matching CRL was
// unusable (`any_unusable`). `validate_signer_chain` reads
// `checker.revocation_state()` after `verify_smime_signer` returns `Ok` to
// produce `Good` (all matching CRLs said good) vs `Unchecked` (no CRL covered
// the cert, or a CRL was stale/unusable). This is safe because
// `verify_chain`/`verify_smime_signer` are synchronous single-threaded calls
// — the checker is never accessed from multiple threads concurrently.

/// Composite CRL revocation checker for S/MIME cert chains (Task 4).
///
/// Wraps zero or more [`CrlChecker`]s, each built from a single CRL DER +
/// the shared [`SmimeVerifier`]. Holds interior-mutable tracking cells
/// ([`Cell`]) that `validate_signer_chain` reads after path validation to
/// determine the overall `RevocationState`.
///
/// When `crls` is empty (or all fail to parse), the checker holds zero inner
/// `CrlChecker`s — `check_revocation` iterates zero items and returns `Ok(())`,
/// exactly matching `NoRevocation`. This means `validate_signer_chain` can
/// always pass `&checker` without a conditional branch on `from_email`.
#[allow(dead_code)]
struct KylinsCrlChecker<V: SignatureVerifier> {
    /// Pre-parsed CRL checkers, one per successfully-parsed CRL DER.
    /// Empty when no CRLs were supplied or all failed to parse.
    crls: Vec<CrlChecker<V>>,
    /// `true` once any `check_revocation` / `check_revocation_against_anchor`
    /// call finds a CRL whose issuer matches the cert (regardless of whether
    /// the CRL said good, revoked, or unusable). Reset only by construction.
    any_matched: Cell<bool>,
    /// `true` once any matching CRL was unusable (expired, bad signature,
    /// out-of-scope, parse error). If `any_matched && !any_unusable` → `Good`.
    /// Otherwise → `Unchecked` (incomplete or unreliable coverage).
    any_unusable: Cell<bool>,
}

impl<V: SignatureVerifier + Copy> KylinsCrlChecker<V> {
    /// Build a composite checker from raw CRL DERs. Unparseable CRLs are
    /// silently skipped (soft-fail) — a malformed CRL is treated the same as
    /// a missing one. The verifier is copied into each inner `CrlChecker`
    /// (it must be `Copy`; `SmimeVerifier` and `DefaultVerifier` both are).
    fn new(crl_ders: &[Vec<u8>], now_unix: u64, verifier: V) -> Self {
        let mut crls = Vec::with_capacity(crl_ders.len());
        for der in crls_ders_iter(crl_ders) {
            // `CrlChecker::new` parses the DER once at construction time.
            // On parse error, skip the CRL entirely (soft-fail) — the
            // transport layer's job is to supply bytes; if the bytes aren't
            // a valid CRL, we don't have revocation data for this issuer.
            if let Ok(c) = CrlChecker::new(der, now_unix, verifier) {
                crls.push(c);
            }
        }
        Self {
            crls,
            any_matched: Cell::new(false),
            any_unusable: Cell::new(false),
        }
    }

    /// Produce the final [`RevocationState`] after path validation.
    /// Called only when `verify_smime_signer` / `verify_chain` returned `Ok`
    /// (no cert was revoked — a revoked cert surfaces as `Err` and is handled
    /// separately in `validate_signer_chain`).
    ///
    /// | `any_matched` | `any_unusable` | Result      |
    /// |---------------|----------------|-------------|
    /// | `true`        | `false`        | `Good`      |
    /// | `true`        | `true`         | `Stale`     |
    /// | `false`       | (n/a)          | `Unchecked` |
    ///
    /// `Stale` distinguishes "a CRL covered the cert but was unusable (expired
    /// past `nextUpdate`, bad sig, out-of-scope, parse error)" from
    /// `Unchecked`'s "no CRL covered the cert at all" (2026-07-18 CRL-revocation-
    /// detail spec decision #1). Both states soft-fail — the chain proceeds —
    /// but the UI surfaces them with distinct warnings.
    fn revocation_state(&self) -> RevocationState {
        if self.any_matched.get() {
            if self.any_unusable.get() {
                RevocationState::Stale
            } else {
                RevocationState::Good
            }
        } else {
            RevocationState::Unchecked
        }
    }
}

/// Helper to iterate `&[Vec<u8>]` as `&[u8]` slices without lifetime issues.
fn crls_ders_iter(crls: &[Vec<u8>]) -> impl Iterator<Item = &[u8]> {
    crls.iter().map(|v| v.as_slice())
}

impl<V: SignatureVerifier> RevocationChecker for KylinsCrlChecker<V> {
    fn check_revocation(
        &self,
        cert: &CertificateV02,
        issuer: &CertificateV02,
    ) -> pkix_revocation::Result<()> {
        for crl in &self.crls {
            match RevocationChecker::check_revocation(crl, cert, issuer) {
                Ok(()) => {
                    // The CRL covers this cert and the serial is NOT revoked.
                    self.any_matched.set(true);
                    return Ok(());
                }
                Err(e) => match &e {
                    // Hard-fail: the cert's serial is in the CRL's revoked list.
                    // Propagate the error — `verify_chain` wraps it as
                    // `Error::Revocation(Revoked{..})`, and
                    // `validate_signer_chain` maps that to
                    // `RevocationState::Revoked` + `chain_valid=false`.
                    pkix_revocation::Error::Revoked { .. } => {
                        self.any_matched.set(true);
                        return Err(e);
                    }
                    // This CRL's issuer doesn't match the cert's issuer →
                    // the CRL is not relevant for this cert. Try the next CRL.
                    pkix_revocation::Error::CrlIssuerMismatch => continue,
                    // The CRL IS relevant (issuer matched) but is unusable:
                    // expired (`CrlExpired`), bad signature
                    // (`CrlSignatureInvalid`), out-of-scope (`OutOfScope`),
                    // or structurally broken (`CrlParseError`,
                    // `MalformedCertificate`). Soft-fail: the CRL applied but
                    // couldn't determine revocation → `Unchecked`.
                    _ => {
                        self.any_matched.set(true);
                        self.any_unusable.set(true);
                        return Ok(());
                    }
                },
            }
        }
        // No CRL in the set covers this cert → soft-fail (Unchecked). The
        // cert's issuer has no CRL in our set; we cannot make a revocation
        // determination. `any_matched` stays at its prior value (set only
        // when a CRL matches, not when none do).
        Ok(())
    }

    /// Check revocation for a cert issued directly by a trust anchor (the
    /// root-issued intermediate in a typical 3-cert chain). Mirrors
    /// [`check_revocation`][Self::check_revocation] but delegates to each
    /// inner `CrlChecker`'s `check_revocation_against_anchor` override.
    ///
    /// The default `RevocationChecker` impl returns `Ok(())` (skip). We
    /// override to ensure the anchor-issued cert is also CRL-checked when a
    /// matching CRL exists (e.g. a root's CRL that revokes an intermediate).
    fn check_revocation_against_anchor(
        &self,
        cert: &CertificateV02,
        anchor: &TrustAnchor,
    ) -> pkix_revocation::Result<()> {
        for crl in &self.crls {
            match RevocationChecker::check_revocation_against_anchor(crl, cert, anchor) {
                Ok(()) => {
                    self.any_matched.set(true);
                    return Ok(());
                }
                Err(e) => match &e {
                    pkix_revocation::Error::Revoked { .. } => {
                        self.any_matched.set(true);
                        return Err(e);
                    }
                    pkix_revocation::Error::CrlIssuerMismatch => continue,
                    _ => {
                        self.any_matched.set(true);
                        self.any_unusable.set(true);
                        return Ok(());
                    }
                },
            }
        }
        Ok(())
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
/// `allowed_signature_algs` + the 825-day cap DROPPED.
///
/// The CA/B Forum S/MIME BR profile (`pkix-profiles-cabf::SmimeProfile`) sets
/// `allowed_signature_algs` to RSA-PKCS1v15-SHA-{256,384,512} + ECDSA-SHA-
/// {256,384,512} only. Real-world S/MIME chains commonly use RSA-PSS (modern
/// RSA roots cross-signing for PSS-capable clients); without this override,
/// pkix-path's policy gate rejects RSA-PSS chains before our `SmimeVerifier`
/// ever runs. Everything else (EKU, min RSA bits, SAN) is inherited from
/// `SmimeProfile` unchanged.
///
/// # Task 5 carry-forward #2 — 825-day cap on roots
///
/// `SmimeProfile.policy()` sets `max_validity_secs = Some(825 days)`, and the
/// underlying `pkix_path::ValidationPolicy.max_validity_secs` field applies to
/// EVERY certificate in the chain, not just the leaf (confirmed in the
/// pkix-path 0.3.2 rustdoc — "Applied to every certificate in the chain, not
/// just the leaf"). Real CA roots (Sectigo, DigiCert, GlobalSign) have 10–20
/// year validity, well over 825 days; passing them as trust anchors under the
/// stock `SmimeProfile` causes path validation to fail on the anchor itself.
///
/// `ValidationPolicy` has no leaf-only validity field (the leaf-specific knobs
/// are `required_leaf_eku`, `required_leaf_policy_oids`,
/// `required_leaf_subject_dn_attrs` — none cap validity). The cleanest fix is
/// to set `max_validity_secs = None` and accept long-lived roots.
///
/// **Trade-off:** we lose the BR-mandated 825-day leaf cap. This is acceptable
/// because (a) the cap is a CA/B Forum contract with CAs about *issuance* —
/// "a CA shall not issue a Strict-tier S/MIME cert valid > 825 days" — not a
/// relying-party trust check. (b) Real-world clients (Thunderbird, Outlook,
/// Apple Mail) do not enforce this cap at verify time. (c) A leaf cert > 825
/// days is "this CA is out of BR compliance" — informational, not a security
/// guarantee we can usefully enforce at verify time. The cert's
/// `notBefore ≤ now ≤ notAfter` window is still checked by RFC 5280 §6.1
/// path validation (the `current_time_unix` field), so expired-or-not-yet-
/// valid certs are still rejected. We trade one informational check for
/// compatibility with the actual deployed CA ecosystem.
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
        // Task 2: allow RSA-PSS in addition to the SmimeProfile default algs.
        if let Some(algs) = p.allowed_signature_algs.as_mut() {
            algs.push(OID_RSASSA_PSS);
        }
        // Task 5: drop the BR 825-day cap. SmimeProfile sets
        // `max_validity_secs = Some(825 days)` which applies to EVERY cert in
        // the chain (per `ValidationPolicy.max_validity_secs` rustdoc) — real
        // CA roots (10–20yr validity) get rejected. `None` accepts long-lived
        // roots; we lose the informational 825-day leaf cap (BR issuance
        // policy, not a relying-party trust check — see the struct rustdoc
        // for the full trade-off). `notBefore ≤ now ≤ notAfter` is still
        // enforced by RFC 5280 §6.1 path validation.
        p.max_validity_secs = None;
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
    use x509_cert::builder::{Builder, CertificateBuilder, CrlBuilder};
    use x509_cert::builder::profile::BuilderProfile;
    use x509_cert::crl::RevokedCert as CrlRevokedCert;
    use x509_cert::ext::pkix::crl::CrlNumber;
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
    /// against `from_email = imposter@example.com`. Per Task 3, the path still
    /// validates (the cert chains to the root) but the identity binding fails
    /// (`verify_smime_signer` returns `Error::Identity`). Surface as
    /// `chain_valid=true, identity_match=false` so the caller maps this to
    /// `Mismatch` (not `Invalid`).
    #[test]
    fn spike_from_email_mismatch_yields_chain_ok_identity_miss() {
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

        // Task 3 split: path validation succeeded, so chain_valid=true. Only
        // the From↔SAN binding failed → identity_match=false. The caller maps
        // this to `SignatureState::Mismatch`, not `Invalid`.
        assert!(
            outcome.chain_valid,
            "path must still validate; only identity mismatches; got {:?}",
            outcome
        );
        assert!(
            !outcome.identity_match,
            "from_email imposter@example.com must not match SAN user@example.com; got {:?}",
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

    // ────── Task 4: CRL revocation ──────

    /// Build a CRL signed by `issuer` that revokes the given serial numbers.
    /// Returns DER bytes. The CRL is valid from now to now+7 days (covers the
    /// test's signing_time = now+1day). An empty `revoked_serials` produces a
    /// CRL with no revoked entries (cert's serial not in it → "good").
    ///
    /// The CRL is built with `x509-cert 0.3`'s `CrlBuilder` and consumed by
    /// `pkix-revocation 0.3.3`'s `CrlChecker` (which parses `x509-cert 0.2`'s
    /// `CertificateList`). DER is wire-compatible across the 0.2/0.3 line.
    fn build_crl(issuer: &BuiltTestCert, revoked_serials: &[SerialNumber]) -> Vec<u8> {
        let issuer_cert = <x509_cert::Certificate as der::Decode>::from_der(&issuer.cert_der)
            .expect("parse issuer for CRL");
        let issuer_sk = SigningKey::from_pkcs8_der(&issuer.priv_pkcs8_der)
            .expect("parse issuer key for CRL signing");

        // CrlNumber = 1 (INTEGER, DER: 02 01 01).
        let crl_number = CrlNumber(der::asn1::Uint::new(&[1u8]).expect("crl number uint"));

        // CRL validity window: now to now+7 days. The signing_time used in
        // tests is now+1 day, well within this window.
        let validity: Validity =
            Validity::from_now(Duration::from_secs(7 * 24 * 60 * 60)).expect("crl validity");

        let mut builder = CrlBuilder::new_with_this_update(
            &issuer_cert,
            crl_number,
            validity.not_before,
        )
        .expect("crl builder")
        .with_next_update(Some(validity.not_after));

        if !revoked_serials.is_empty() {
            let revoked: Vec<CrlRevokedCert> = revoked_serials
                .iter()
                .map(|s| CrlRevokedCert {
                    serial_number: s.clone(),
                    revocation_date: validity.not_before,
                    crl_entry_extensions: None,
                })
                .collect();
            builder = builder.with_certificates(revoked.into_iter());
        }

        let crl = builder
            .build::<_, DerSignature>(&issuer_sk)
            .expect("crl build/sign");
        crl.to_der().expect("crl to_der")
    }

    /// Extract the leaf cert's serial number (for CRL revocation entry).
    fn leaf_serial(leaf: &BuiltTestCert) -> SerialNumber {
        let parsed = <x509_cert::Certificate as der::Decode>::from_der(&leaf.cert_der)
            .expect("parse leaf for serial");
        parsed.tbs_certificate().serial_number().clone()
    }

    /// CRL with NO revoked entries → CRL covers the leaf (issuer matches) and
    /// the serial is NOT in the revoked list → `RevocationState::Good`.
    /// Chain still validates, identity matches.
    #[test]
    fn crl_empty_revocation_list_yields_good_state() {
        let root = build_ca("Kylins CRL Test Root CA", None);
        let inter = build_ca(
            "Kylins CRL Test Intermediate CA",
            Some((&root.cert_der, &root.priv_pkcs8_der)),
        );
        let leaf = build_smime_leaf(
            "crl-good@example.com",
            (&inter.cert_der, &inter.priv_pkcs8_der),
        );

        // CRL signed by the intermediate (the leaf's issuer), no revoked entries.
        let crl_der = build_crl(&inter, &[]);

        let signing_time_unix = (std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_secs()
            + 86_400) as i64;

        let outcome = validate_signer_chain(
            &leaf.cert_der,
            &[inter.cert_der.as_slice()],
            std::slice::from_ref(&root.cert_der),
            Some("crl-good@example.com"),
            signing_time_unix,
            std::slice::from_ref(&crl_der),
        );

        assert!(
            outcome.chain_valid,
            "chain must still validate with a non-revoking CRL; got {:?}",
            outcome.failure_reason
        );
        assert!(outcome.identity_match);
        assert_eq!(
            outcome.revocation_state,
            RevocationState::Good,
            "CRL covered the cert and serial is not revoked → Good"
        );
        assert!(outcome.failure_reason.is_none());
    }

    /// CRL that EXPLICITLY revokes the leaf's serial number → hard-fail.
    /// `chain_valid=false`, `revocation_state=Revoked`. This is the spec §0.4
    /// hard-fail-on-revoked path.
    #[test]
    fn crl_revokes_leaf_serial_yields_revoked_hard_fail() {
        let root = build_ca("Kylins CRL Test Root CA", None);
        let inter = build_ca(
            "Kylins CRL Test Intermediate CA",
            Some((&root.cert_der, &root.priv_pkcs8_der)),
        );
        let leaf = build_smime_leaf(
            "crl-revoked@example.com",
            (&inter.cert_der, &inter.priv_pkcs8_der),
        );

        // CRL signed by the intermediate that INCLUDES the leaf's serial.
        let serial = leaf_serial(&leaf);
        let crl_der = build_crl(&inter, std::slice::from_ref(&serial));

        let signing_time_unix = (std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_secs()
            + 86_400) as i64;

        let outcome = validate_signer_chain(
            &leaf.cert_der,
            &[inter.cert_der.as_slice()],
            std::slice::from_ref(&root.cert_der),
            Some("crl-revoked@example.com"),
            signing_time_unix,
            std::slice::from_ref(&crl_der),
        );

        assert!(
            !outcome.chain_valid,
            "revoked cert must hard-fail (chain_valid=false); got {:?}",
            outcome
        );
        assert_eq!(
            outcome.revocation_state,
            RevocationState::Revoked,
            "CRL says revoked → RevocationState::Revoked"
        );
        assert!(
            outcome.failure_reason.is_some(),
            "failure_reason must be populated for a revoked cert"
        );
        // The failure reason should mention "revoked".
        assert!(
            outcome
                .failure_reason
                .as_ref()
                .map(|r| r.to_lowercase().contains("revoke"))
                .unwrap_or(false),
            "failure_reason should mention revocation, got: {:?}",
            outcome.failure_reason
        );
    }

    /// No CRLs supplied → `RevocationState::Unchecked` (soft-fail — no
    /// revocation data available). Chain still validates. This matches the
    /// Task 1 behavior and is the spec §0.4 soft-fail-when-no-data posture.
    #[test]
    fn crl_empty_set_yields_unchecked_state() {
        let root = build_ca("Kylins CRL Test Root CA", None);
        let inter = build_ca(
            "Kylins CRL Test Intermediate CA",
            Some((&root.cert_der, &root.priv_pkcs8_der)),
        );
        let leaf = build_smime_leaf(
            "no-crl@example.com",
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
            Some("no-crl@example.com"),
            signing_time_unix,
            // Empty CRL set → KylinsCrlChecker holds zero inner CrlCheckers.
            &[],
        );

        assert!(outcome.chain_valid);
        assert_eq!(
            outcome.revocation_state,
            RevocationState::Unchecked,
            "no CRLs → Unchecked (soft-fail)"
        );
    }

    /// A CRL from a DIFFERENT issuer (unrelated CA) → `CrlIssuerMismatch` for
    /// every cert in the chain → no CRL covers the cert → soft-fail
    /// `Unchecked`. This tests the "CRL doesn't apply" iteration path.
    #[test]
    fn crl_wrong_issuer_yields_unchecked_soft_fail() {
        let root = build_ca("Kylins CRL Test Root CA", None);
        let inter = build_ca(
            "Kylins CRL Test Intermediate CA",
            Some((&root.cert_der, &root.priv_pkcs8_der)),
        );
        let leaf = build_smime_leaf(
            "wrong-crl@example.com",
            (&inter.cert_der, &inter.priv_pkcs8_der),
        );

        // An unrelated CA — signs a CRL, but it's for a DIFFERENT domain.
        let wrong_ca = build_ca("Unrelated CA", None);
        let wrong_crl_der = build_crl(&wrong_ca, &[]);

        let signing_time_unix = (std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_secs()
            + 86_400) as i64;

        let outcome = validate_signer_chain(
            &leaf.cert_der,
            &[inter.cert_der.as_slice()],
            std::slice::from_ref(&root.cert_der),
            Some("wrong-crl@example.com"),
            signing_time_unix,
            std::slice::from_ref(&wrong_crl_der),
        );

        assert!(
            outcome.chain_valid,
            "unrelated CRL must not fail the chain; got {:?}",
            outcome.failure_reason
        );
        assert_eq!(
            outcome.revocation_state,
            RevocationState::Unchecked,
            "wrong-issuer CRL → no coverage → Unchecked"
        );
    }

    // ────── CRL Revocation Detail (2026-07-18 spec) ──────
    //
    // Stale-vs-Unchecked revocation discrimination + structured RFC 5280
    // CRLReason threading. See `docs/superpowers/specs/2026-07-18-crypto-crl-detail-design.md`.
    // Four RED→GREEN tests:
    //   1. `revocation_state_stale_when_crl_expired` — CRL past nextUpdate
    //      covering the cert → `RevocationState::Stale` (was `Unchecked`).
    //   2. `revocation_state_unchecked_when_no_crl` — no CRL → `Unchecked`
    //      (regression guard; Stale must NOT appear when no CRL matched).
    //   3. `chain_outcome_carries_revocation_reason` — a revoked cert →
    //      `ChainOutcome.revocation_reason == Some("KeyCompromise")`.
    //   4. `verify_with_context_surfaces_revocation_reason` — the
    //      `VerificationResult.revocation_reason` mirrors ChainOutcome's.

    /// Build a CRL whose validity window ENDED in the past (nextUpdate <
    /// signing_time) so `CrlChecker` rejects it as `CrlExpired`. The CRL is
    /// signed by `issuer` (so its issuer DN matches a real cert's issuer —
    /// without that, the checker would skip it as `CrlIssuerMismatch`).
    ///
    /// Mirrors `build_crl` but flips the validity window into the past. The
    /// `thisUpdate` is 10 days ago, `nextUpdate` is 3 days ago. When
    /// `validate_signer_chain` is called with `signing_time = now`, the CRL is
    /// past its nextUpdate → `CrlExpired` → `KylinsCrlChecker` sets
    /// `any_unusable=true`. With the issuer matching the leaf's issuer
    /// (`any_matched=true`), the resulting state is `Stale`.
    fn build_stale_crl(issuer: &BuiltTestCert) -> Vec<u8> {
        let issuer_cert = <x509_cert::Certificate as der::Decode>::from_der(&issuer.cert_der)
            .expect("parse issuer for stale CRL");
        let issuer_sk = SigningKey::from_pkcs8_der(&issuer.priv_pkcs8_der)
            .expect("parse issuer key for stale CRL signing");

        let crl_number = CrlNumber(der::asn1::Uint::new(&[1u8]).expect("crl number uint"));

        // Validity window entirely in the past: started 10 days ago, ended 3
        // days ago. The signing_time used in the test is `now` — well past
        // `nextUpdate` — so the CRL is stale. `Time::try_from(SystemTime)`
        // is the x509-cert 0.3 conversion path (no `from_unix_seconds` on Time).
        let now = std::time::SystemTime::now();
        let this_update =
            x509_cert::time::Time::try_from(now - std::time::Duration::from_secs(10 * 24 * 60 * 60))
                .expect("this_update");
        let next_update =
            x509_cert::time::Time::try_from(now - std::time::Duration::from_secs(3 * 24 * 60 * 60))
                .expect("next_update");

        // `CrlBuilder::new_with_this_update` takes the `this_update` Time +
        // a separate `with_next_update(Some(time))` call; no `Validity<P>` is
        // needed, avoiding the Profile type-param inference issue. Turbofish
        // pins the Profile to Rfc5280 (the default for both Certificate and
        // CrlBuilder; the manual Time args above don't carry a Profile param,
        // so inference alone can't pick P).
        let mut builder =
            CrlBuilder::<x509_cert::certificate::Rfc5280>::new_with_this_update(
                &issuer_cert,
                crl_number,
                this_update,
            )
            .expect("stale crl builder")
            .with_next_update(Some(next_update));

        // No revoked entries — the CRL covers the cert but is stale.
        let _ = &mut builder;

        let crl = builder
            .build::<_, DerSignature>(&issuer_sk)
            .expect("stale crl build/sign");
        crl.to_der().expect("stale crl to_der")
    }

    /// A CRL past its nextUpdate covers the leaf (issuer matches) but is
    /// unusable → `RevocationState::Stale` (was `Unchecked` before this spec).
    /// Distinguishes "stale revocation data" from "no revocation data".
    #[test]
    fn revocation_state_stale_when_crl_expired() {
        let root = build_ca("Kylins Stale-CRL Root CA", None);
        let inter = build_ca(
            "Kylins Stale-CRL Intermediate CA",
            Some((&root.cert_der, &root.priv_pkcs8_der)),
        );
        let leaf = build_smime_leaf(
            "stale-crl@example.com",
            (&inter.cert_der, &inter.priv_pkcs8_der),
        );

        // CRL signed by the leaf's issuer (intermediate), validity in the past.
        let stale_crl_der = build_stale_crl(&inter);

        // signing_time = now (CRL's nextUpdate was 3 days ago → stale).
        let signing_time_unix = (std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_secs()) as i64;

        let outcome = validate_signer_chain(
            &leaf.cert_der,
            &[inter.cert_der.as_slice()],
            std::slice::from_ref(&root.cert_der),
            Some("stale-crl@example.com"),
            signing_time_unix,
            std::slice::from_ref(&stale_crl_der),
        );

        // Stale CRL soft-fails: chain still validates.
        assert!(
            outcome.chain_valid,
            "stale CRL must not fail the chain (soft-fail); got {:?}",
            outcome.failure_reason
        );
        // The CRL covered the cert but was unusable → Stale (NOT Unchecked).
        assert_eq!(
            outcome.revocation_state,
            RevocationState::Stale,
            "CRL past nextUpdate covering the cert → Stale (was Unchecked before)"
        );
    }

    /// No CRL in the set → `RevocationState::Unchecked` (regression guard).
    /// Stale must NOT appear when no CRL matched at all — both states previously
    /// collapsed to `Unchecked`; the new variant only fires for the
    /// "matched-but-unusable" case.
    #[test]
    fn revocation_state_unchecked_when_no_crl() {
        let root = build_ca("Kylins No-CRL Root CA", None);
        let inter = build_ca(
            "Kylins No-CRL Intermediate CA",
            Some((&root.cert_der, &root.priv_pkcs8_der)),
        );
        let leaf = build_smime_leaf(
            "unchecked-no-crl@example.com",
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
            Some("unchecked-no-crl@example.com"),
            signing_time_unix,
            // Empty CRL set — no coverage at all.
            &[],
        );

        assert!(outcome.chain_valid);
        assert_eq!(
            outcome.revocation_state,
            RevocationState::Unchecked,
            "no CRL matched → Unchecked (NOT Stale — Stale is matched-but-unusable only)"
        );
    }

    /// Build a CRL signed by `issuer` that revokes the given serial number WITH
    /// a reason-code CRL entry extension. Mirrors `build_crl` but adds the
    /// RFC 5280 §5.3.1 CRLReason to the revoked-cert entry's extensions.
    fn build_crl_with_reason(
        issuer: &BuiltTestCert,
        revoked_serial: &SerialNumber,
        reason: x509_cert::ext::pkix::crl::CrlReason,
    ) -> Vec<u8> {
        use der::Encode;
        let issuer_cert = <x509_cert::Certificate as der::Decode>::from_der(&issuer.cert_der)
            .expect("parse issuer for CRL");
        let issuer_sk = SigningKey::from_pkcs8_der(&issuer.priv_pkcs8_der)
            .expect("parse issuer key for CRL signing");

        let crl_number = CrlNumber(der::asn1::Uint::new(&[1u8]).expect("crl number uint"));
        let now = std::time::SystemTime::now();
        let this_update = x509_cert::time::Time::try_from(now).expect("this_update");
        let next_update = x509_cert::time::Time::try_from(
            now + std::time::Duration::from_secs(7 * 24 * 60 * 60),
        )
        .expect("next_update");

        // Build the CRLReason extension: the CrlReason enum carries its own
        // AssociatedOid (2.5.29.21), so encoding the enum yields the
        // SEQUENCE-wrapped extnValue OCTET STRING directly. We embed it in the
        // RevokedCert's `crl_entry_extensions`.
        let reason_ext = x509_cert::ext::Extension {
            extn_id: <x509_cert::ext::pkix::crl::CrlReason as const_oid::AssociatedOid>::OID,
            critical: false,
            extn_value: der::asn1::OctetString::new(reason.to_der().expect("encode CrlReason"))
                .expect("octet string"),
        };
        let revoked = vec![CrlRevokedCert {
            serial_number: revoked_serial.clone(),
            revocation_date: this_update,
            crl_entry_extensions: Some(vec![reason_ext]),
        }];

        let mut builder =
            CrlBuilder::<x509_cert::certificate::Rfc5280>::new_with_this_update(
                &issuer_cert,
                crl_number,
                this_update,
            )
            .expect("crl builder")
            .with_next_update(Some(next_update))
            .with_certificates(revoked.into_iter());

        let _ = &mut builder;

        let crl = builder
            .build::<_, DerSignature>(&issuer_sk)
            .expect("crl-with-reason build/sign");
        crl.to_der().expect("crl-with-reason to_der")
    }

    /// A revoked cert with a reason code → `ChainOutcome.revocation_reason`
    /// carries the stringified RFC 5280 CRLReason name. The structured enum is
    /// surfaced (not just stringified into `failure_reason`); `None` reason_code
    /// → `Some("Unspecified")` (spec decision #5).
    #[test]
    fn chain_outcome_carries_revocation_reason() {
        let root = build_ca("Kylins Reason Root CA", None);
        let inter = build_ca(
            "Kylins Reason Intermediate CA",
            Some((&root.cert_der, &root.priv_pkcs8_der)),
        );
        let leaf = build_smime_leaf(
            "reason@example.com",
            (&inter.cert_der, &inter.priv_pkcs8_der),
        );

        // CRL signed by the intermediate that revokes the leaf's serial with
        // CRLReason = KeyCompromise (RFC 5280 §5.3.1 code 1).
        let serial = leaf_serial(&leaf);
        let crl_der = build_crl_with_reason(
            &inter,
            &serial,
            x509_cert::ext::pkix::crl::CrlReason::KeyCompromise,
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
            Some("reason@example.com"),
            signing_time_unix,
            std::slice::from_ref(&crl_der),
        );

        assert!(!outcome.chain_valid, "revoked cert hard-fails");
        assert_eq!(outcome.revocation_state, RevocationState::Revoked);
        // Structured reason surfaces as a distinct field — the stringified
        // pkix enum name (debug-formatted, e.g. "KeyCompromise").
        assert_eq!(
            outcome.revocation_reason.as_deref(),
            Some("KeyCompromise"),
            "ChainOutcome.revocation_reason must carry the stringified RFC 5280 CRLReason name"
        );
        // The legacy failure_reason still carries the revocation summary
        // (unchanged from the prior behavior).
        assert!(
            outcome
                .failure_reason
                .as_ref()
                .map(|r| r.to_lowercase().contains("revoke"))
                .unwrap_or(false),
            "failure_reason should still mention revocation; got {:?}",
            outcome.failure_reason
        );
    }

    /// `RevocationReason == None` for non-revoked outcomes (Good / Unchecked /
    /// Stale). Guards against the field accidentally picking up a value when
    /// the chain did not hard-fail-on-revoked.
    #[test]
    fn chain_outcome_revocation_reason_none_for_non_revoked() {
        let root = build_ca("Kylins Reason-None Root CA", None);
        let inter = build_ca(
            "Kylins Reason-None Intermediate CA",
            Some((&root.cert_der, &root.priv_pkcs8_der)),
        );
        let leaf = build_smime_leaf(
            "reason-none@example.com",
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
            Some("reason-none@example.com"),
            signing_time_unix,
            // No CRL — Unchecked.
            &[],
        );

        assert!(outcome.chain_valid);
        assert_eq!(outcome.revocation_state, RevocationState::Unchecked);
        assert!(
            outcome.revocation_reason.is_none(),
            "revocation_reason must be None when the cert was not revoked; got {:?}",
            outcome.revocation_reason
        );
    }

    // ────── Task 5: SmimeProfile 825-day cap fix (carry-forward #2) ──────

    /// Regression for the SmimeProfile 825-day cap fix: a real CA root has
    /// 10–20 year validity (well over the BR 825-day cap). Before the fix,
    /// `SmimeProfile.policy()` set `max_validity_secs = Some(825 days)` which
    /// was applied to EVERY cert in the chain — including the root — and a
    /// 10-year root would be rejected with `Error::ValidityPeriodExceedsMax`
    /// at the policy gate. `KylinsSmimeProfile::policy()` now sets
    /// `max_validity_secs = None` (drop the BR cap entirely), so a long-lived
    /// root + a normal leaf chain cleanly to it.
    ///
    /// `LONG_ROOT_VALIDITY_SECS` = 10 years, far over the 825-day BR cap
    /// (825 days ≈ 71_280_000 secs). `SPIKE_VALIDITY_SECS` (200 days) stays
    /// well under the cap for the leaf, isolating the test's signal to the
    /// root's validity window.
    #[test]
    fn long_lived_root_chains_after_cap_fix() {
        const LONG_ROOT_VALIDITY_SECS: u64 = 10 * 365 * 24 * 60 * 60; // 10 years

        // Build a CA root with 10-year validity. We can't reuse `build_ca`
        // directly because it hardcodes `SPIKE_VALIDITY_SECS`; inline the
        // build with the long validity window. The extension set mirrors
        // `build_ca` (BasicConstraints cA:TRUE, KeyUsage keyCertSign|cRLSign,
        // SubjectKeyIdentifier).
        let mut rng = rand::rng();
        let signing_key = SigningKey::generate_from_rng(&mut rng);
        let verifying_key = signing_key.verifying_key();
        let pub_spki = SubjectPublicKeyInfo::from_key(verifying_key).expect("spki from key");
        let ski = SubjectKeyIdentifier::try_from(pub_spki.owned_to_ref()).expect("ski");

        let subject = Name::from_str("CN=Kylins Long-Lived Root CA").expect("subject name");
        let profile = TestCertProfile {
            subject: subject.clone(),
            issuer: subject.clone(),
        };
        let serial = SerialNumber::from(rand::random::<u32>());
        let validity = Validity::from_now(Duration::from_secs(LONG_ROOT_VALIDITY_SECS))
            .expect("long root validity");
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
        let cert = builder
            .build::<_, DerSignature>(&signing_key)
            .expect("cert build/sign (self)");
        let root_cert_der = cert.to_der().expect("cert to_der");
        let root_priv_der = signing_key
            .to_pkcs8_der()
            .expect("pkcs8 der")
            .as_bytes()
            .to_vec();

        // Intermediate + leaf use the standard 200-day validity.
        let inter = build_ca(
            "Kylins Intermediate for Long Root",
            Some((&root_cert_der, &root_priv_der)),
        );
        let leaf = build_smime_leaf(
            "long-root@example.com",
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
            std::slice::from_ref(&root_cert_der),
            Some("long-root@example.com"),
            signing_time_unix,
            &[],
        );

        assert!(
            outcome.chain_valid,
            "long-lived root (10y) must chain cleanly after the 825-day cap fix; got {:?}",
            outcome.failure_reason
        );
        assert!(outcome.identity_match);
    }
}
