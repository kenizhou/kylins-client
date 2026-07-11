//! Phase 1 Plan 2 Task 6 — backend S/MIME cert/key lifecycle smoke test.
//!
//! Proves the full cert/key lifecycle across the `crypto-smime` backend and the
//! db-backed `SqliteKeyStore`:
//! 1. `generate_key` (self-signed ECDSA-P256 cert) persists cert + encrypted
//!    private key into `crypto_keys` via the bridge.
//! 2. `export_public` returns the DER cert, which `x509-parser` re-parses to
//!    verify the SAN carries `rfc822Name=alice@kylins.com` and the EKU carries
//!    `emailProtection`.
//! 3. The stored cert + PKCS#8 private key, re-wrapped as PEM, round-trip back
//!    through `import_key` — the imported cert's SubjectKeyIdentifier
//!    fingerprint matches the generated cert's, byte-for-byte.
//!
//! No CMS sign/encrypt is exercised — those ops are `NotImplemented` (Plan 2b).

use std::sync::Arc;

use base64::Engine;
use sqlx::SqlitePool;

use crypto_core::{
    CryptoBackend, CryptoPolicy, KeyGenParams, KeyHandle, KeyId, KeyStore, Standard,
};
use crypto_smime::SmimeBackend;
use kylins_client_lib::db::init_db;
use kylins_client_lib::keystore_bridge::SqliteKeyStore;

const ACCOUNT_ID: &str = "acct-smime-lifecycle";
const ACCOUNT_EMAIL: &str = "alice@kylins.com";

/// Seed the FK row in `accounts` that `crypto_keys.account_id` references.
/// Mirrors the `seed_account` helper in `db::attachments::tests` and
/// `keystore_bridge::tests`.
async fn seed_account(pool: &SqlitePool) {
    sqlx::query(
        "INSERT INTO accounts (id, email, provider, is_active, is_default, sort_order, created_at, updated_at)
         VALUES (?, ?, 'imap', 1, 0, 0, strftime('%s','now'), strftime('%s','now'))",
    )
    .bind(ACCOUNT_ID)
    .bind(ACCOUNT_EMAIL)
    .execute(pool)
    .await
    .expect("seed account");
}

/// Wrap binary DER as a single RFC 7468 PEM block (base64 body, 64-col wrapped).
/// Mirrors the `pem_block` helper in `crypto-smime`'s unit tests so the PEM we
/// feed into `import_key` matches the encoding `import_key` parses.
fn pem_block(label: &str, der: &[u8]) -> String {
    let b64 = base64::engine::general_purpose::STANDARD.encode(der);
    let mut out = format!("-----BEGIN {label}-----");
    for chunk in b64.as_bytes().chunks(64) {
        out.push('\n');
        out.push_str(std::str::from_utf8(chunk).expect("base64 is ascii"));
    }
    out.push_str(&format!("\n-----END {label}-----"));
    out
}

/// Build the canonical db-lookup `KeyHandle` for a cert under a given
/// fingerprint. `SqliteKeyStore` encodes `standard|fingerprint` into the
/// `KeyId` so `get(&KeyHandle)` can recover the db lookup keys.
fn lookup_handle(standard: Standard, fingerprint: &str) -> KeyHandle {
    KeyHandle::Software(KeyId(format!("{}|{fingerprint}", standard.as_str())))
}

#[tokio::test]
async fn smime_lifecycle_generate_export_reimport_round_trips() {
    // --- Fixture: temp db + account row (FK target for crypto_keys). --------
    let tmp = tempfile::tempdir().expect("tempdir");
    let pool = Arc::new(init_db(tmp.path()).await.expect("init_db"));
    seed_account(&pool).await;

    let ks = Arc::new(SqliteKeyStore::new(pool.clone(), ACCOUNT_ID));
    let backend = SmimeBackend::new(ks.clone(), CryptoPolicy::default_baseline());

    // --- 1. generate_key: self-signed ECDSA-P256 v3 cert -------------------
    let generated = backend
        .generate_key(KeyGenParams {
            standard: Standard::Smime,
            user_id: ACCOUNT_EMAIL.into(),
            algorithm: "ECDSA-P256".into(),
            passphrase: None,
        })
        .await
        .expect("generate_key");

    assert_eq!(generated.standard, Standard::Smime);
    assert_eq!(generated.algorithm, "ECDSA-P256");
    assert!(
        !generated.fingerprint.as_str().is_empty(),
        "fingerprint (cert SKI hex) must be non-empty"
    );

    // DEVIATION (see report): `SmimeBackend::generate_key` returns a handle
    // whose `KeyId` is a random uuid, but `SqliteKeyStore::get` decodes the
    // `KeyId` as "standard|fingerprint". The crypto-smime unit tests use an
    // in-memory `StubKeyStore` that keys by the raw uuid, so this mismatch
    // only surfaces against the db-backed store. Build the canonical lookup
    // handle from the returned fingerprint to exercise the rest of the
    // lifecycle (this is the same shape `SqliteKeyStore::put` returns).
    let canonical = lookup_handle(Standard::Smime, generated.fingerprint.as_str());

    // --- 2. export_public → DER → re-parse: SAN email + EKU emailProtection -
    let cert_der = backend
        .export_public(&canonical)
        .await
        .expect("export_public");
    assert!(!cert_der.is_empty(), "exported cert DER must be non-empty");

    let (_rem, cert) = x509_parser::parse_x509_certificate(&cert_der)
        .expect("x509-parser must re-parse the exported DER");

    // SAN must carry the email as an RFC822Name.
    let san = cert
        .subject_alternative_name()
        .expect("SAN extension lookup ok")
        .expect("SAN extension present")
        .value;
    let has_email = san.general_names.iter().any(
        |gn| matches!(gn, x509_parser::extensions::GeneralName::RFC822Name(s) if *s == ACCOUNT_EMAIL),
    );
    assert!(
        has_email,
        "SAN must contain rfc822Name={ACCOUNT_EMAIL}; got {:?}",
        san.general_names
    );

    // EKU must include emailProtection (S/MIME cert marker).
    let eku = cert
        .extended_key_usage()
        .expect("EKU extension lookup ok")
        .expect("EKU extension present")
        .value;
    assert!(
        eku.email_protection,
        "EKU must include emailProtection; got {eku:?}"
    );

    // --- 3. PEM round-trip: stored cert+key → import_key → fingerprint match
    let stored = ks
        .get(&canonical)
        .await
        .expect("keystore get")
        .expect("stored key present");
    assert_eq!(
        stored.public_data, cert_der,
        "StoredKey.public_data must equal the exported cert DER"
    );
    let priv_der = crypto_core::secret::expose_bytes(
        stored
            .private_data
            .as_ref()
            .expect("private material present after generate_key"),
    )
    .to_vec();
    assert!(
        !priv_der.is_empty(),
        "private PKCS#8 DER must be non-empty after at-rest decrypt round-trip"
    );

    let pem = format!(
        "{}\n{}\n",
        pem_block("CERTIFICATE", &cert_der),
        pem_block("PRIVATE KEY", &priv_der),
    );

    // A fresh backend (over the same store) proves the imported key came from
    // PEM, not memory. upsert_crypto_key is idempotent on
    // (account_id, standard, fingerprint) so the conflict with the generated
    // row is handled by ON CONFLICT DO UPDATE.
    let ks2 = Arc::new(SqliteKeyStore::new(pool.clone(), ACCOUNT_ID));
    let backend2 = SmimeBackend::new(ks2, CryptoPolicy::default_baseline());
    let imported = backend2
        .import_key(pem.as_bytes(), None)
        .await
        .expect("import_key");

    assert_eq!(imported.standard, Standard::Smime);
    // Same cert → same SubjectKeyIdentifier → same fingerprint.
    assert_eq!(
        imported.fingerprint.as_str(),
        generated.fingerprint.as_str(),
        "imported cert fingerprint (SKI) must match generated"
    );

    // Re-export the imported key's cert and confirm byte-for-byte equality.
    let re_exported = backend2
        .export_public(&lookup_handle(
            Standard::Smime,
            imported.fingerprint.as_str(),
        ))
        .await
        .expect("re-export imported cert");
    assert_eq!(
        re_exported, cert_der,
        "re-exported cert DER must match the original byte-for-byte"
    );
}

/// Plan 2b Task 5 — S/MIME `sign` through the db-backed `SmimeBackend` produces
/// a CMS `SignedData` (wrapped in `ContentInfo`, id-signed-data). Exercises the
/// full stack: SqliteKeyStore at-rest round-trip of the signer's private key,
/// then `build_signed_data` over the plaintext. Full verify is Phase 1b; here
/// we assert the outer CMS structure is well-formed signed-data.
#[tokio::test]
async fn smime_sign_produces_signed_data() {
    // --- Fixture: temp db + account row (FK target for crypto_keys). --------
    let tmp = tempfile::tempdir().expect("tempdir");
    let pool = Arc::new(init_db(tmp.path()).await.expect("init_db"));
    seed_account(&pool).await;

    let ks = Arc::new(SqliteKeyStore::new(pool.clone(), ACCOUNT_ID));
    let backend = SmimeBackend::new(ks, CryptoPolicy::default_baseline());

    // --- generate_key: self-signed ECDSA-P256 cert persisted to the db. -----
    // `SmimeBackend::generate_key` returns the keystore's canonical handle
    // (SqliteKeyStore encodes `standard|fingerprint` into the KeyId), so the
    // returned ref resolves directly via `get()` — no `lookup_handle` rebuild
    // needed (unlike the legacy deviation noted in the round-trip test above,
    // which predates generate_key delegating the handle to `put`).
    let generated = backend
        .generate_key(KeyGenParams {
            standard: Standard::Smime,
            user_id: ACCOUNT_EMAIL.into(),
            algorithm: "ECDSA-P256".into(),
            passphrase: None,
        })
        .await
        .expect("generate_key");

    // --- sign: CMS SignedData over the payload with the stored signer key. --
    let op = crypto_core::SignOp {
        payload: b"integration sign",
        signing_key: generated,
        detached: false,
    };
    let signed = backend.sign(op).await.expect("sign ok");
    assert_eq!(signed.standard, Standard::Smime);

    // The signature bytes are a ContentInfo (id-signed-data).
    let ci: cms::content_info::ContentInfo =
        <cms::content_info::ContentInfo as der::Decode>::from_der(&signed.signature.signature)
            .expect("parse content info");
    assert_eq!(ci.content_type, const_oid::db::rfc5911::ID_SIGNED_DATA);
}
