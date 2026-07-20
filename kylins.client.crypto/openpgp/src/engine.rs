//! OpenPGP engine: generate / import / export (non-streaming key ops).
//!
//! This is the ONLY module in the crate that imports `sequoia_openpgp` for
//! cryptographic operations. Tasks 6 (encrypt/decrypt) and 7 (sign/verify) add
//! streaming ops to this same file; Task 8 wires everything into the
//! `CryptoBackend` trait via `KeyStore`.
//!
//! ## Sequoia 2.4.1 API notes (verified)
//!
//! - **generate**: `CertBuilder::new().add_userid(u)`
//!   `.add_transport_encryption_subkey().add_signing_subkey().generate()`
//!   yields `(Cert, revocation)`. `CertBuilder::new()` defaults the primary
//!   to certify-only; `add_signing_subkey` + `add_transport_encryption_subkey`
//!   add dedicated subkeys. The default ciphersuite selects Ed25519 for
//!   primary/signing and X25519 for encryption — matches the engine contract.
//! - **import**: `parse_certs` (keymap) wraps `CertParser::from_bytes` which
//!   auto-detects armor vs binary. For encrypted-secret certs, the verified
//!   decryption pattern is at `sequoia_openpgp-2.4.1/src/cert.rs:6289` (test
//!   `decrypt_encrypt_secrets`) and `src/packet/key.rs:644-658` (doc example):
//!   iterate `cert.keys().encrypted_secret()`, clone each key, call
//!   `decrypt_secret(&password)`, and re-insert via `cert.insert_packets(...)`
//!   preserving each key's role via `KeyAmalgamation::primary()`.
//! - **export**: `cert.armored().serialize(...)` emits an ASCII-armored
//!   `PUBLIC KEY BLOCK` frame (delegates to `cert.serialize`, public-only by
//!   construction — see `keymap.rs` API notes).
//!
//! ## Passphrase handling
//!
//! The passphrase bytes enter as `crypto_core::SecretBox<String>` (heap-allocated,
//! zeroized on drop). To pass them to Sequoia's `decrypt_secret`, we expose them
//! via [`secrecy::ExposeSecret`], clone into a `String`, and immediately convert
//! to [`sequoia_openpgp::crypto::Password`] (which uses `mem::Encrypted`
//! internally — also zeroized on drop). The intermediate `String` is short-lived
//! (a single statement); the bytes never leave crypto-aware containers.

use crypto_core::SecretBox;
use secrecy::ExposeSecret;
use sequoia_openpgp as openpgp;
use sequoia_openpgp::cert::prelude::*;
use sequoia_openpgp::crypto::Password;

use crate::error::{map_sequoia, policy, CryptoResult};
use crate::keymap;

/// Generate a fresh OpenPGP Cert with the engine's standard key shape.
///
/// Composition (verified Task-1 spike):
/// - Ed25519 primary key (certify-only per `CertBuilder::new()` defaults)
/// - X25519 transport-encryption subkey
/// - Ed25519 signing subkey
///
/// No OpenPGP S2K passphrase is applied; at-rest protection is the framework's
/// master-key layer (OS keyring + AES-256-GCM in `kylins.client.backend::crypto`),
/// not Sequoia's. Generated secret material is therefore UNENCRYPTED within the
/// OpenPGP packet wiring — the engine contract is that the surrounding storage
/// layer applies at-rest protection.
///
/// **Revocation cert**: the second tuple element from `CertBuilder::generate()`
/// is discarded. Out of scope for engine-core; a later slice persists it
/// alongside the Cert so key revocation can be issued without re-deriving the
/// primary keypair.
pub fn generate(user_id: &str) -> CryptoResult<openpgp::Cert> {
    // `CertBuilder` uses Sequoia's modern `StandardPolicy` defaults internally,
    // which align with the crate's write policy (see `policy.rs`); no explicit
    // policy override is needed on the generate path.
    let (cert, _revocation) = map_sequoia(
        CertBuilder::new()
            .add_userid(user_id)
            .add_transport_encryption_subkey()
            .add_signing_subkey()
            .generate(),
    )?;
    Ok(cert)
}

/// Import a Cert from OpenPGP armored or binary TPK bytes.
///
/// [`keymap::parse_certs`] (which wraps `CertParser::from_bytes`) auto-detects
/// armor vs binary form. **Multi-cert input handling:** engine-core takes the
/// FIRST cert and discards the rest. The framework's keyring API (Task 8)
/// handles multi-cert input by calling `import` per cert; documenting the
/// choice here so it is explicit.
///
/// **Passphrase semantics:**
/// - If the parsed cert has ENCRYPTED secret material, a passphrase is
///   REQUIRED. Each encrypted secret is decrypted via
///   [`openpgp::packet::Key::decrypt_secret`] and merged back into the Cert
///   (preserving each key's role via `KeyAmalgamation::primary()`).
/// - If the cert's secrets are UNENCRYPTED (e.g. fresh
///   `CertBuilder::generate()` output) or absent (public-only cert), no
///   passphrase is needed; a supplied passphrase is silently ignored.
///
/// # Errors
///
/// - [`CryptoError::Policy`]`("import: no OpenPGP certs found in input")` if
///   the input parses to zero certs.
/// - [`CryptoError::Policy`]`("import requires a passphrase for encrypted
///   secret key material")` if the cert has encrypted secret material and no
///   passphrase was supplied.
/// - [`CryptoError::Backend`] if Sequoia parsing fails OR if a supplied
///   passphrase fails to decrypt the secret material (wrong passphrase or
///   corrupted packet).
///
/// [`CryptoError::Policy`]: crypto_core::CryptoError::Policy
/// [`CryptoError::Backend`]: crypto_core::CryptoError::Backend
pub fn import(data: &[u8], passphrase: Option<SecretBox<String>>) -> CryptoResult<openpgp::Cert> {
    let certs = keymap::parse_certs(data)?;
    let mut cert = certs
        .into_iter()
        .next()
        .ok_or_else(|| policy("import: no OpenPGP certs found in input"))?;

    // Only encrypted secrets require a passphrase. If none are encrypted, the
    // cert is either public-only or an unencrypted TSK — return early. A
    // supplied passphrase is intentionally ignored (matches the brief's
    // "ignore a supplied passphrase" semantics for unencrypted certs).
    let has_encrypted = cert.keys().encrypted_secret().next().is_some();
    if !has_encrypted {
        return Ok(cert);
    }

    // Encrypted secrets present → passphrase required.
    let pw = passphrase.ok_or_else(|| {
        policy("import requires a passphrase for encrypted secret key material")
    })?;

    // Convert `SecretBox<String>` → Sequoia `Password`. Bytes remain in
    // zeroizing containers throughout (see the module-level passphrased-handling
    // note): `SecretBox<String>` (drop zeroizes) → transient `String` →
    // `Password` (`mem::Encrypted`, drop zeroizes). The transient String is
    // consumed by `Password::from(String)` in the same statement.
    let password: Password = pw.expose_secret().clone().into();

    // Decrypt each encrypted secret and merge back into the Cert, preserving
    // each key's role. Verified pattern at
    // `sequoia_openpgp-2.4.1/src/cert.rs:6289` (test `decrypt_encrypt_secrets`)
    // and `src/packet/key.rs:644-658` (doc example).
    //
    // We snapshot the (role, key) pairs first because `Cert::insert_packets`
    // consumes `cert`, which would invalidate the ongoing `cert.keys()` borrow.
    let keys_to_decrypt: Vec<(bool, _)> = cert
        .keys()
        .encrypted_secret()
        .map(|ka| (ka.primary(), ka.key().clone()))
        .collect();

    for (is_primary, key) in keys_to_decrypt {
        // `decrypt_secret` consumes `key` and returns a new key with the same
        // role but unencrypted secret material. A wrong passphrase surfaces as
        // an `openpgp::Result::Err` → `CryptoError::Backend` via `map_sequoia`.
        let decrypted = map_sequoia(key.decrypt_secret(&password))?;
        // Re-insert with the original role: `role_into_primary` for the primary
        // key, `role_into_subordinate` for subkeys. `insert_packets` prefers
        // newer key versions, so the decrypted variant overrides the encrypted
        // one in the resulting Cert.
        //
        // The explicit `openpgp::Packet` target is required because multiple
        // `From<Key<…>>` impls exist (various role conversions + `Packet`);
        // without the annotation, `.into()` is ambiguous (E0283).
        let packet: openpgp::Packet = if is_primary {
            decrypted.role_into_primary().into()
        } else {
            decrypted.role_into_subordinate().into()
        };
        let (new_cert, _signatures_changed) = map_sequoia(cert.insert_packets(vec![packet]))?;
        cert = new_cert;
    }

    Ok(cert)
}

/// ASCII-armored public-key serialization of a Cert.
///
/// Delegates to [`keymap::cert_to_armored_public`]. Emits a
/// `BEGIN PGP PUBLIC KEY BLOCK` frame (public-only — no secret material
/// crosses this boundary).
pub fn export_armored_public(cert: &openpgp::Cert) -> CryptoResult<Vec<u8>> {
    keymap::cert_to_armored_public(cert)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crypto_core::SecretBox;
    use sequoia_openpgp::policy::StandardPolicy as P;

    /// Permissive fixture policy for capability-flag assertions. The
    /// `for_*` filters (`for_signing`, `for_transport_encryption`,
    /// `for_certification`) live on `ValidKeyAmalgamationIter`
    /// (`sequoia_openpgp-2.4.1/src/cert/amalgamation/key/iter.rs:898`), reached
    /// via `cert.keys().with_policy(P_, None)`.
    const P_: &P = &P::new();

    /// Task-1 spike `gen()` pattern, duplicated per the no-cross-task-assumption
    /// rule (this crate's lib-tests must not depend on `tests/spike.rs`).
    /// Yields a Cert with primary (certify) + transport-encryption subkey +
    /// signing subkey — all with UNENCRYPTED secret material (no S2K).
    fn gen() -> openpgp::Cert {
        let (cert, _rev) = CertBuilder::new()
            .add_userid("engine-test@example.org")
            .add_transport_encryption_subkey()
            .add_signing_subkey()
            .generate()
            .expect("CertBuilder::generate");
        cert
    }

    /// Build a TSK with ALL secret material encrypted under `password`.
    /// `CertBuilder::set_password` applies S2K encryption to every key the
    /// builder produces (primary + subkeys) — verified at
    /// `sequoia_openpgp-2.4.1/src/cert.rs:6289` test `decrypt_encrypt_secrets`.
    fn gen_encrypted(password: &str) -> openpgp::Cert {
        let (cert, _rev) = CertBuilder::new()
            .add_userid("engine-encrypted@example.org")
            .add_transport_encryption_subkey()
            .add_signing_subkey()
            .set_password(Some(password.into()))
            .generate()
            .expect("CertBuilder::generate with password");
        cert
    }

    // ---- generate() --------------------------------------------------------

    #[test]
    fn generate_produces_cert_with_transport_encryption_and_signing_subkeys() {
        let cert = generate("alice@example.org").expect("generate");
        // Structural: primary + enc subkey + sign subkey.
        assert_eq!(
            cert.keys().count(),
            3,
            "generated cert must have primary + 2 subkeys"
        );
        // `for_*` capability filters live on `ValidKeyAmalgamationIter`
        // (sequoia-openpgp-2.4.1/src/cert/amalgamation/key/iter.rs:898); reach
        // them via `.with_policy(P_, None)`.
        // Primary is certify-only (CertBuilder::new() default).
        assert!(
            cert.keys()
                .with_policy(P_, None)
                .for_certification()
                .next()
                .is_some(),
            "cert must have a certification-capable primary"
        );
        // Transport-encryption subkey present.
        assert!(
            cert.keys()
                .with_policy(P_, None)
                .for_transport_encryption()
                .next()
                .is_some(),
            "cert must have a transport-encryption subkey"
        );
        // Signing subkey present.
        assert!(
            cert.keys()
                .with_policy(P_, None)
                .for_signing()
                .next()
                .is_some(),
            "cert must have a signing subkey"
        );
    }

    #[test]
    fn generate_cert_is_tsk_with_all_unencrypted_secrets() {
        // `CertBuilder::generate()` without `set_password(...)` yields a TSK
        // with UNENCRYPTED secret material. At-rest protection is the master
        // key's job (per the engine's design), so no OpenPGP S2K layer is
        // applied.
        let cert = generate("bob@example.org").expect("generate");
        assert!(cert.is_tsk(), "generated cert must be a TSK");
        assert_eq!(
            cert.keys().unencrypted_secret().count(),
            cert.keys().secret().count(),
            "all secrets in a generated cert must be unencrypted"
        );
        assert_eq!(
            cert.keys().encrypted_secret().count(),
            0,
            "no encrypted secrets in a generated cert"
        );
    }

    #[test]
    fn generate_user_id_is_attached() {
        let cert = generate("carol@example.org").expect("generate");
        let userids: Vec<String> =
            cert.userids().map(|u| u.userid().to_string()).collect();
        assert!(
            userids.iter().any(|u| u == "carol@example.org"),
            "user_id must be attached; got: {userids:?}"
        );
    }

    // ---- export_armored_public() -------------------------------------------

    #[test]
    fn export_armored_public_emits_public_key_block_frame() {
        let cert = gen();
        let armored = export_armored_public(&cert).expect("export");
        let s = std::str::from_utf8(&armored).expect("armored is utf8");
        assert!(
            s.contains("-----BEGIN PGP PUBLIC KEY BLOCK-----"),
            "must be a PUBLIC KEY BLOCK; got: {}",
            &s[..s.len().min(120)]
        );
    }

    // ---- import() round-trips (unencrypted path) ---------------------------

    #[test]
    fn import_public_only_cert_round_trips_with_no_passphrase() {
        let cert = gen();
        let armored = export_armored_public(&cert).expect("export");
        // Public-only cert → no passphrase needed; a supplied passphrase is
        // silently ignored (covered by passing None here).
        let imported = import(&armored, None).expect("import");
        assert_eq!(imported.fingerprint(), cert.fingerprint());
        assert!(
            !imported.is_tsk(),
            "imported public cert must NOT be a TSK"
        );
    }

    #[test]
    fn import_unencrypted_tsk_round_trips_with_no_passphrase() {
        let cert = gen();
        // Serialize as a binary TPK WITH secret material (TSK form) so we can
        // verify the no-passphrase fast-path returns a still-TSK cert.
        let blob = crate::keymap::cert_to_secret_blob(&cert).expect("secret blob");
        let imported = import(&blob, None).expect("import");
        assert_eq!(imported.fingerprint(), cert.fingerprint());
        assert!(
            imported.is_tsk(),
            "imported unencrypted TSK must remain a TSK"
        );
        assert_eq!(
            imported.keys().encrypted_secret().count(),
            0,
            "imported unencrypted TSK must have zero encrypted secrets"
        );
    }

    #[test]
    fn import_empty_input_returns_policy_error() {
        let err = import(&[], None).unwrap_err();
        assert!(
            matches!(err, crypto_core::CryptoError::Policy(ref s)
                if s.contains("no OpenPGP certs")),
            "empty input must produce a Policy error mentioning 'no OpenPGP certs'; got: {err}"
        );
    }

    // ---- import() encrypted-secret path ------------------------------------

    #[test]
    fn import_encrypted_cert_without_passphrase_is_policy_error() {
        let cert = gen_encrypted("hunter2");
        let blob = crate::keymap::cert_to_secret_blob(&cert).expect("secret blob");
        // Sanity: the blob really does contain encrypted secrets (guards
        // against a regression where set_password stops encrypting).
        let parsed = crate::keymap::parse_certs(&blob).expect("parse");
        assert_eq!(parsed.len(), 1);
        assert_eq!(
            parsed[0].keys().encrypted_secret().count(),
            parsed[0].keys().secret().count(),
            "encrypted fixture must have ALL secrets encrypted"
        );

        let err = import(&blob, None).unwrap_err();
        assert!(
            matches!(err, crypto_core::CryptoError::Policy(ref s)
                if s.contains("passphrase")),
            "encrypted cert without passphrase must be a Policy error mentioning 'passphrase'; got: {err}"
        );
    }

    #[test]
    fn import_encrypted_cert_with_correct_passphrase_decrypts_all_secrets() {
        let password = "correct horse battery staple";
        let cert = gen_encrypted(password);
        let blob = crate::keymap::cert_to_secret_blob(&cert).expect("secret blob");

        let pw_box: SecretBox<String> =
            SecretBox::new(Box::new(password.to_string()));
        let imported = import(&blob, Some(pw_box)).expect("import with passphrase");

        // Fingerprint round-trips.
        assert_eq!(
            imported.fingerprint(),
            cert.fingerprint(),
            "fingerprint must survive encrypt→decrypt round-trip"
        );
        // All secrets must now be UNENCRYPTED.
        assert_eq!(
            imported.keys().unencrypted_secret().count(),
            imported.keys().secret().count(),
            "all secrets must be decrypted after import with correct passphrase"
        );
        assert_eq!(
            imported.keys().encrypted_secret().count(),
            0,
            "no encrypted secrets must remain after import with correct passphrase"
        );
        // Cross-check: the cert is still a TSK (decryption reveals secrets,
        // it does not remove them).
        assert!(
            imported.is_tsk(),
            "imported-and-decrypted cert must still be a TSK"
        );
    }

    #[test]
    fn import_encrypted_cert_with_wrong_passphrase_is_backend_error() {
        let cert = gen_encrypted("right password");
        let blob = crate::keymap::cert_to_secret_blob(&cert).expect("secret blob");

        let wrong_pw: SecretBox<String> =
            SecretBox::new(Box::new("wrong password".to_string()));
        let err = import(&blob, Some(wrong_pw)).unwrap_err();
        // A wrong passphrase surfaces as a Sequoia error → CryptoError::Backend
        // (NOT Policy — the user supplied a passphrase; it just didn't match).
        assert!(
            matches!(err, crypto_core::CryptoError::Backend(_)),
            "wrong passphrase must surface as CryptoError::Backend; got: {err}"
        );
    }
}
