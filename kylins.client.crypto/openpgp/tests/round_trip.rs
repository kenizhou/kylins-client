//! End-to-end integration tests for `OpenpgpBackend` against the in-memory
//! `MemoryKeyStore`. Drives the framework's `CryptoBackend` trait through the
//! Sequoia engine: generate → export → import, encrypt → decrypt (with and
//! without inline signing), detached sign → verify (ValidVerified / Invalid /
//! UnknownKey), and the keystore-persistence contract.
//!
//! These are the load-bearing proofs for the engine-core slice: they exercise
//! the full `CryptoBackend` trait + `KeyStore` plumbing, the
//! `KeyHandleRef`→`Cert` resolution, and the `spawn_blocking` wrappers around
//! the Sequoia engine.

mod common;

use common::MemoryKeyStore;
use crypto_core::{
    CryptoBackend, CryptoPolicy, KeyGenParams, KeyHandle, KeyStore, Part, PartId, PartKind,
    SerializationStrategy, SignatureState, Standard,
};
use crypto_openpgp::OpenpgpBackend;
use std::sync::Arc;

// ---------- fixtures ----------

fn backend() -> OpenpgpBackend {
    OpenpgpBackend::new(
        Arc::new(MemoryKeyStore::new()),
        CryptoPolicy::default_baseline(),
    )
}

fn body_part(id: &str, data: &[u8]) -> Part {
    Part {
        id: PartId(id.to_string()),
        kind: PartKind::Body,
        data: data.to_vec(),
    }
}

// ---------- generate_key → export_public → import_key round trip ----------

#[tokio::test]
async fn generate_then_export_public_then_import_yields_same_fingerprint() {
    let b = backend();

    let gen_handle = b
        .generate_key(KeyGenParams {
            standard: Standard::OpenPgp,
            user_id: "roundtrip@example.org".into(),
            algorithm: "default".into(),
            passphrase: None,
        })
        .await
        .expect("generate_key");

    let exported = b
        .export_public(&gen_handle.handle)
        .await
        .expect("export_public");

    // Armor frame sanity (kept from the Task-1 spike cert_armor_parse_roundtrip
    // assertion, which is one of the few spike checks worth folding in here).
    let s = std::str::from_utf8(&exported).expect("armored is utf8");
    assert!(
        s.contains("-----BEGIN PGP PUBLIC KEY BLOCK-----"),
        "export_public must emit a PUBLIC KEY BLOCK; got: {}",
        &s[..s.len().min(120)]
    );

    let imported_handle = b
        .import_key(&exported, None)
        .await
        .expect("import_key");

    // Fingerprint round-trips: generate → export → import yields the same fp.
    assert_eq!(
        imported_handle.fingerprint.as_str(),
        gen_handle.fingerprint.as_str(),
        "generate→export→import must preserve fingerprint"
    );
}

// ---------- generate persists to keystore (export by handle w/o re-import) ----------

#[tokio::test]
async fn generate_persists_to_keystore_so_export_by_handle_works_directly() {
    // Prove `generate_key` actually wrote to the keystore: a follow-up
    // export_public by the returned handle must succeed WITHOUT a re-import.
    let b = backend();
    let gen_handle = b
        .generate_key(KeyGenParams {
            standard: Standard::OpenPgp,
            user_id: "persist@example.org".into(),
            algorithm: "default".into(),
            passphrase: None,
        })
        .await
        .expect("generate_key");

    let exported = b
        .export_public(&gen_handle.handle)
        .await
        .expect("export_public after generate must succeed (keystore persistence)");
    assert!(
        !exported.is_empty(),
        "exported public key blob must be non-empty"
    );
}

// ---------- encrypt → decrypt round trip (no signer) ----------

#[tokio::test]
async fn encrypt_then_decrypt_preserves_plaintext_no_signer() {
    let b = backend();
    let recipient = b
        .generate_key(KeyGenParams {
            standard: Standard::OpenPgp,
            user_id: "recipient@example.org".into(),
            algorithm: "default".into(),
            passphrase: None,
        })
        .await
        .expect("generate recipient");

    let plaintext = b"encrypt-me-please";
    let part = body_part("body", plaintext);
    let op = crypto_core::EncryptOp {
        parts: std::slice::from_ref(&part),
        serialization: SerializationStrategy::SingleMimeBlob,
        recipients: std::slice::from_ref(&recipient),
        sign_with: None,
    };
    let envelope = b.encrypt(op).await.expect("encrypt");
    assert_eq!(envelope.standard, Standard::OpenPgp);
    assert_eq!(envelope.parts.len(), 1);
    assert!(!envelope.recipients.is_empty());

    let dec_op = crypto_core::DecryptOp {
        envelope: &envelope,
        decryption_key: recipient,
    };
    let payload = b.decrypt(dec_op).await.expect("decrypt");
    assert_eq!(payload.standard, Standard::OpenPgp);
    assert_eq!(payload.parts.len(), 1);
    assert_eq!(payload.parts[0].data, plaintext);
}

// ---------- sign-then-encrypt → decrypt round trip ----------

#[tokio::test]
async fn sign_then_encrypt_then_decrypt_recovers_plaintext() {
    let b = backend();
    let signer = b
        .generate_key(KeyGenParams {
            standard: Standard::OpenPgp,
            user_id: "signer@example.org".into(),
            algorithm: "default".into(),
            passphrase: None,
        })
        .await
        .expect("generate signer");

    let plaintext = b"signed-then-encrypted payload";
    let part = body_part("body", plaintext);
    // Inline sign-then-encrypt: signer == recipient (engine-core helper only
    // knows the decryption cert; the framework wires the signer lookup).
    let op = crypto_core::EncryptOp {
        parts: std::slice::from_ref(&part),
        serialization: SerializationStrategy::SingleMimeBlob,
        recipients: std::slice::from_ref(&signer),
        sign_with: Some(signer.clone()),
    };
    let envelope = b.encrypt(op).await.expect("encrypt with sign_with");

    let dec_op = crypto_core::DecryptOp {
        envelope: &envelope,
        decryption_key: signer,
    };
    let payload = b.decrypt(dec_op).await.expect("decrypt must succeed");
    assert_eq!(payload.parts[0].data, plaintext);
}

// ---------- detached sign → verify round trip ----------

#[tokio::test]
async fn sign_detached_then_verify_round_trips_as_valid_verified() {
    let b = backend();
    let signer = b
        .generate_key(KeyGenParams {
            standard: Standard::OpenPgp,
            user_id: "signer-2@example.org".into(),
            algorithm: "default".into(),
            passphrase: None,
        })
        .await
        .expect("generate signer");

    let payload = b"detached-signed payload";
    let sign_op = crypto_core::SignOp {
        payload,
        signing_key: signer.clone(),
        detached: true,
    };
    let signed = b.sign(sign_op).await.expect("sign");
    assert_eq!(signed.standard, Standard::OpenPgp);
    assert_eq!(signed.signature.standard, Standard::OpenPgp);
    assert_eq!(signed.payload, payload);
    assert!(!signed.signature.signature.is_empty());

    let verify_op = crypto_core::VerifyOp {
        signed: &signed,
    };
    let result = b.verify(verify_op).await.expect("verify call");
    assert_eq!(
        result.state,
        SignatureState::ValidVerified,
        "detached sign→verify with matching signer must be ValidVerified; got {:?}",
        result
    );
    let signed_signer = result
        .signer
        .as_ref()
        .expect("ValidVerified must surface a signer handle");
    assert_eq!(
        signed_signer.fingerprint.as_str(),
        signer.fingerprint.as_str(),
        "verify signer must match the signing cert's fingerprint"
    );
}

// ---------- tampered payload → Invalid ----------

#[tokio::test]
async fn verify_tampered_payload_is_invalid() {
    let b = backend();
    let signer = b
        .generate_key(KeyGenParams {
            standard: Standard::OpenPgp,
            user_id: "tampered@example.org".into(),
            algorithm: "default".into(),
            passphrase: None,
        })
        .await
        .expect("generate signer");

    let payload = b"original bytes";
    let sign_op = crypto_core::SignOp {
        payload,
        signing_key: signer.clone(),
        detached: true,
    };
    let mut signed = b.sign(sign_op).await.expect("sign");
    // Mutate the recovered payload (the verify path re-hashes it). The
    // signature bytes stay identical; only the payload differs.
    signed.payload = b"tampered bytes".to_vec();

    let result = b
        .verify(crypto_core::VerifyOp { signed: &signed })
        .await
        .expect("verify call");
    assert_eq!(
        result.state,
        SignatureState::Invalid,
        "tampered payload must verify as Invalid"
    );
    assert!(
        result.failure_reason.is_some(),
        "Invalid must surface a failure_reason"
    );
}

// ---------- unknown signer (cert removed from keystore) → UnknownKey ----------

#[tokio::test]
async fn verify_with_unknown_signer_is_unknown_key() {
    // Generate a signature with a signer, then REMOVE the signer from the
    // keystore. The backend's verify path resolves `signed.signature.signer`
    // via the keystore; with no cert available it must classify as UnknownKey.
    let ks = Arc::new(MemoryKeyStore::new());
    let b = OpenpgpBackend::new(ks.clone(), CryptoPolicy::default_baseline());

    let signer = b
        .generate_key(KeyGenParams {
            standard: Standard::OpenPgp,
            user_id: "removed@example.org".into(),
            algorithm: "default".into(),
            passphrase: None,
        })
        .await
        .expect("generate signer");

    let payload = b"signed but signer unknown";
    let sign_op = crypto_core::SignOp {
        payload,
        signing_key: signer.clone(),
        detached: true,
    };
    let signed = b.sign(sign_op).await.expect("sign");

    // Remove the signer from the keystore so the backend cannot resolve it
    // during `verify`.
    ks.remove(&signer.handle)
        .await
        .expect("remove signer from keystore");

    let result = b
        .verify(crypto_core::VerifyOp { signed: &signed })
        .await
        .expect("verify call");
    assert_eq!(
        result.state,
        SignatureState::UnknownKey,
        "signer absent from keystore → UnknownKey; got {:?}",
        result
    );
    assert!(
        result.failure_reason.is_none(),
        "UnknownKey has no failure_reason (no verification attempted)"
    );
}

// ---------- generate_key rejects non-default algorithm ----------

#[tokio::test]
async fn generate_key_rejects_non_default_algorithm() {
    let b = backend();
    let err = b
        .generate_key(KeyGenParams {
            standard: Standard::OpenPgp,
            user_id: "rsa@example.org".into(),
            algorithm: "RSA4096".into(),
            passphrase: None,
        })
        .await
        .expect_err("non-default algorithm must be rejected");
    assert!(
        matches!(err, crypto_core::CryptoError::Policy(ref s) if s.contains("algorithm")),
        "non-default algorithm must surface as a Policy error mentioning 'algorithm'; got: {err}"
    );
}

// ---------- sign with detached == false is rejected (engine-core scope) ----------

#[tokio::test]
async fn sign_inline_is_not_supported_in_engine_core() {
    let b = backend();
    let signer = b
        .generate_key(KeyGenParams {
            standard: Standard::OpenPgp,
            user_id: "inline@example.org".into(),
            algorithm: "default".into(),
            passphrase: None,
        })
        .await
        .expect("generate signer");

    let err = b
        .sign(crypto_core::SignOp {
            payload: b"inline sign payload",
            signing_key: signer,
            detached: false,
        })
        .await
        .expect_err("inline sign must be rejected");
    assert!(
        matches!(err, crypto_core::CryptoError::Policy(ref s) if s.contains("inline")),
        "inline sign must surface as a Policy error mentioning 'inline'; got: {err}"
    );
}

// ---------- resolve_key missing → KeyNotFound ----------

#[tokio::test]
async fn encrypt_with_unknown_recipient_returns_key_not_found() {
    let b = backend();
    // A recipient handle that was never registered with the keystore.
    let bogus = bogus_handle();

    let part = body_part("body", b"data");
    let err = b
        .encrypt(crypto_core::EncryptOp {
            parts: std::slice::from_ref(&part),
            serialization: SerializationStrategy::SingleMimeBlob,
            recipients: std::slice::from_ref(&bogus),
            sign_with: None,
        })
        .await
        .expect_err("encrypt with unknown recipient must fail");
    assert!(
        matches!(err, crypto_core::CryptoError::KeyNotFound(_)),
        "unknown recipient must surface as KeyNotFound; got: {err}"
    );
}

/// Construct a KeyHandleRef whose `KeyHandle` is NOT in the backend's keystore.
/// Used only to prove the resolution path surfaces `KeyNotFound`.
fn bogus_handle() -> crypto_core::KeyHandleRef {
    use crypto_core::{KeyHandle, KeyId, KeyUsage};
    crypto_core::KeyHandleRef {
        handle: KeyHandle::Software(KeyId("openpgp|deadbeefdeadbeef".into())),
        standard: Standard::OpenPgp,
        fingerprint: crypto_core::Fingerprint::new("deadbeefdeadbeef"),
        usage: KeyUsage::SignAndEncrypt,
        algorithm: "Ed25519/X25519".into(),
    }
}

/// A placeholder so `KeyHandle` is referenced even if the bogus-handle helper
/// is reorganized later (keeps imports honest under `-D warnings`).
#[allow(dead_code)]
fn _kh_assert(_h: KeyHandle) {}

// ---------- MemoryKeyStore helper interop (put_cert / get_cert) ----------
//
// Exercises the helpers used to seed a Cert produced OUT-of-band (e.g. via
// `engine::generate` directly) into a backend's keystore, then verifies the
// backend sees the same Cert. This proves StoredKey construction is identical
// between the backend's persist path and the test helper (i.e. they agree on
// public + private blob layout).

#[tokio::test]
async fn memory_keystore_put_cert_then_backend_export_round_trips() {
    let ks = Arc::new(MemoryKeyStore::new());
    let b = OpenpgpBackend::new(ks.clone(), CryptoPolicy::default_baseline());

    // Generate a cert via the engine DIRECTLY (not via backend.generate_key),
    // then store it via the MemoryKeyStore helper. This proves the helper's
    // StoredKey construction is compatible with the backend's resolution path.
    let cert = crypto_openpgp::engine::generate("helper-interop@example.org")
        .expect("engine::generate");
    let handle = ks
        .put_cert(&cert)
        .expect("MemoryKeyStore::put_cert stores the cert");

    // The backend must be able to resolve + export the cert by handle.
    let exported = b
        .export_public(&handle.handle)
        .await
        .expect("backend.export_public resolves helper-stored handle");
    let s = std::str::from_utf8(&exported).expect("armored is utf8");
    assert!(
        s.contains("-----BEGIN PGP PUBLIC KEY BLOCK-----"),
        "helper-stored cert must export as a PUBLIC KEY BLOCK"
    );

    // get_cert round-trip: same cert comes back out of the helper's own
    // parse path.
    let recovered = ks
        .get_cert(&handle.handle)
        .expect("MemoryKeyStore::get_cert returns the stored cert");
    assert_eq!(
        recovered.fingerprint(),
        cert.fingerprint(),
        "MemoryKeyStore::get_cert fingerprint must match the stored cert"
    );
}
