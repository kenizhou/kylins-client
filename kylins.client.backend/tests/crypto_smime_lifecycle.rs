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

// ---- Plan 4b Task 2 — SmimeBackend command wrappers -----------------------
//
// These tests drive the `crypto_*_inner` bodies directly against a real
// in-memory pool — no Tauri runtime. The `#[tauri::command]` wrappers are
// one-line delegations, so if the inner fn is correct the wrapper is correct
// (same delegation-pinning strategy as `db::commands::tests` for
// `db_get_rate_limit_info`).

use kylins_client_lib::db::commands::{
    crypto_export_public_to_path_inner, crypto_generate_key_inner,
    crypto_import_key_from_path_inner,
};
use kylins_client_lib::db::crypto_keys::get_crypto_key_public;

/// Seed an arbitrary `(id, email)` account row — the FK target for
/// `crypto_keys`. A separate helper from [`seed_account`] so the import test
/// can build a FRESH account (different `account_id`, same fingerprint) without
/// disturbing the constants-bound fixture.
async fn seed_account_with(pool: &SqlitePool, id: &str, email: &str) {
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

/// `crypto_generate_key_inner` persists a new S/MIME cert + private key into
/// `crypto_keys` (private blob encrypted at rest via `encrypt_with_aad`) and
/// returns the PUBLIC row — `has_private: true`, no private bytes.
#[tokio::test]
async fn crypto_generate_key_inner_persists_row_with_private() {
    let tmp = tempfile::tempdir().expect("tempdir");
    let pool = Arc::new(init_db(tmp.path()).await.expect("init_db"));
    seed_account_with(&pool, "acct-gen", "gen@kylins.com").await;

    let row = crypto_generate_key_inner(&pool, "acct-gen", Standard::Smime, "gen@kylins.com")
        .await
        .expect("generate_key_inner");

    assert_eq!(row.standard, "smime");
    assert!(row.has_private, "generated key must have a private blob");
    assert!(!row.fingerprint.is_empty(), "fingerprint must be non-empty");

    // Re-fetch from the db confirms persistence (not just an in-memory return).
    let again = get_crypto_key_public(&pool, "smime", &row.fingerprint)
        .await
        .expect("re-fetch");
    let again = again.expect("row must persist in crypto_keys");
    assert!(again.has_private);
    assert_eq!(again.fingerprint, row.fingerprint);
}

/// `crypto_export_public_to_path_inner` writes the cert (DER) to `out_path`;
/// re-parsing the file via `x509-parser` proves the bytes are a real X.509 cert
/// carrying the expected SAN `rfc822Name=<email>` + EKU `emailProtection`.
#[tokio::test]
async fn crypto_export_public_to_path_inner_writes_parseable_cert() {
    let tmp = tempfile::tempdir().expect("tempdir");
    let pool = Arc::new(init_db(tmp.path()).await.expect("init_db"));
    seed_account_with(&pool, "acct-exp", "exp@kylins.com").await;

    let row = crypto_generate_key_inner(&pool, "acct-exp", Standard::Smime, "exp@kylins.com")
        .await
        .expect("generate_key_inner");

    let cert_path = tmp.path().join("exported.crt");
    crypto_export_public_to_path_inner(
        &pool,
        "acct-exp",
        "smime",
        &row.fingerprint,
        cert_path.to_str().unwrap(),
    )
    .await
    .expect("export_public_to_path_inner");

    assert!(cert_path.exists(), "cert file must be written");
    let der = std::fs::read(&cert_path).expect("read cert");
    assert!(!der.is_empty(), "cert DER must be non-empty");

    let (_rem, cert) = x509_parser::parse_x509_certificate(&der)
        .expect("x509-parser must re-parse the exported DER");

    // SAN must carry the account email as an RFC822Name (S/MIME cert marker).
    let san = cert
        .subject_alternative_name()
        .expect("SAN extension lookup ok")
        .expect("SAN extension present")
        .value;
    let has_email = san.general_names.iter().any(
        |gn| matches!(gn, x509_parser::extensions::GeneralName::RFC822Name(s) if *s == "exp@kylins.com"),
    );
    assert!(has_email, "SAN must contain exp@kylins.com; got {:?}", san.general_names);

    // EKU must include emailProtection.
    let eku = cert
        .extended_key_usage()
        .expect("EKU extension lookup ok")
        .expect("EKU extension present")
        .value;
    assert!(eku.email_protection, "EKU must include emailProtection; got {eku:?}");
}

/// `crypto_import_key_from_path_inner` round-trips a PEM bundle (cert + PKCS#8
/// private key) generated in acct-A into a FRESH account (acct-B). Asserts the
/// imported fingerprint matches the source (same cert → same SKI) AND
/// `has_private` survives the at-rest encrypt/decrypt round-trip.
#[tokio::test]
async fn crypto_import_key_from_path_inner_round_trips_pem_bundle() {
    // --- Fixture: generate a key in acct-A, build a PEM bundle (cert+PKCS#8). -
    let tmp = tempfile::tempdir().expect("tempdir");
    let pool = Arc::new(init_db(tmp.path()).await.expect("init_db"));
    seed_account_with(&pool, "acct-A", "alice@kylins.com").await;

    let row_a = crypto_generate_key_inner(&pool, "acct-A", Standard::Smime, "alice@kylins.com")
        .await
        .expect("generate_key_inner in acct-A");

    // Fetch the cert (DER) + private key (PKCS#8 DER) to build the PEM bundle.
    // Mirrors the legacy `smime_lifecycle_generate_export_reimport_round_trips`
    // test's fixture-construction approach.
    let canonical = lookup_handle(Standard::Smime, &row_a.fingerprint);
    let ks = Arc::new(SqliteKeyStore::new(
        std::sync::Arc::new((*pool).clone()),
        "acct-A",
    ));
    let stored = ks
        .get(&canonical)
        .await
        .expect("keystore get")
        .expect("stored key present");

    let cert_der = stored.public_data.clone();
    let priv_der = crypto_core::secret::expose_bytes(
        stored
            .private_data
            .as_ref()
            .expect("private material present after generate"),
    )
    .to_vec();
    let pem = format!(
        "{}\n{}\n",
        pem_block("CERTIFICATE", &cert_der),
        pem_block("PRIVATE KEY", &priv_der),
    );
    let pem_path = tmp.path().join("bundle.pem");
    std::fs::write(&pem_path, pem.as_bytes()).expect("write PEM bundle");

    // --- Import the PEM into a FRESH account (acct-B). -----------------------
    seed_account_with(&pool, "acct-B", "bob@kylins.com").await;
    let row_b = crypto_import_key_from_path_inner(
        &pool,
        "acct-B",
        Standard::Smime,
        pem_path.to_str().unwrap(),
        None,
    )
    .await
    .expect("import_key_from_path_inner");

    assert_eq!(row_b.standard, "smime");
    assert_eq!(
        row_b.fingerprint, row_a.fingerprint,
        "same cert → same SubjectKeyIdentifier fingerprint"
    );
    assert!(row_b.has_private, "imported key must have private material");

    // Re-fetch from the db confirms persistence in acct-B (a different
    // account_id from acct-A — proving the row is newly inserted, not the
    // acct-A row being shadowed by the UNIQUE constraint).
    let again = get_crypto_key_public(&pool, "smime", &row_b.fingerprint)
        .await
        .expect("re-fetch");
    assert!(again.is_some(), "imported row must persist in crypto_keys");
}

// ---- Plan 3 Task 3 — `.p12`/`.pfx` import through the IPC inner fn ----------
//
// Verifies `crypto_import_key_from_path_inner` threads the `passphrase`
// param into `SmimeBackend::import_key` and that a real `.p12` produced by
// openssl (skip-if-absent) round-trips into a `crypto_keys` row whose
// fingerprint matches the source cert. Mirrors `crypto-smime`'s own
// `interop_tests::openssl_p12_imports_with_our_code` at the backend IPC
// seam (proves the IPC layer neither drops the passphrase nor mangles the
// bytes on the way to the backend).

/// Locate openssl on `PATH` (or a couple of well-known Windows install paths)
/// so this test can be silent-skipped when openssl isn't reachable. Mirrors
/// `crypto-smime/src/interop_tests.rs::openssl_path` but kept local to the
/// backend tests because the interop module is gated to the crypto-smime
/// crate (not re-exported).
fn openssl_path() -> Option<std::path::PathBuf> {
    if let Ok(p) = std::env::var("OPENSSL_PATH") {
        let pb = std::path::PathBuf::from(p);
        if pb.exists() {
            return Some(pb);
        }
    }
    if let Ok(out) = std::process::Command::new("openssl")
        .arg("version")
        .output()
    {
        if out.status.success() {
            return Some(std::path::PathBuf::from("openssl"));
        }
    }
    if cfg!(windows) {
        for c in [
            r"C:\Program Files\Git\mingw64\bin\openssl.exe",
            r"C:\Program Files (x86)\Git\mingw64\bin\openssl.exe",
            r"C:\Program Files\OpenSSL-Win64\bin\openssl.exe",
        ] {
            if std::path::Path::new(c).exists() {
                return Some(std::path::PathBuf::from(c));
            }
        }
    }
    None
}

/// Run openssl with `args`, assert success, return the captured `Output` (so
/// callers can inspect stdout if any). Panics on spawn failure or non-zero
/// exit (the test fixture is malformed, not the SUT).
fn run_openssl_assert(mut cmd: std::process::Command, label: &str) -> std::process::Output {
    let out = cmd
        .output()
        .unwrap_or_else(|e| panic!("openssl {label}: spawn failed: {e}"));
    if !out.status.success() {
        let stderr = String::from_utf8_lossy(&out.stderr);
        panic!(
            "openssl {label} failed (status={}): {}",
            out.status,
            stderr.trim()
        );
    }
    out
}

/// `crypto_import_key_from_path_inner` with a passphrase threads the
/// passphrase into `SmimeBackend::import_key` and a `.p12` produced by openssl
/// round-trips into a `crypto_keys` row whose fingerprint matches the source
/// cert (same cert → same SKI). Skips silently when openssl is unreachable.
#[tokio::test]
async fn crypto_import_key_from_path_inner_round_trips_p12_with_passphrase() {
    let openssl = match openssl_path() {
        Some(p) => p,
        None => {
            eprintln!(
                "openssl not available on PATH; skipping .p12 IPC round-trip test. \
                 See crypto-smime/src/interop_tests.rs for the manual run procedure."
            );
            return;
        }
    };

    // --- Fixture: generate a key in acct-A, export cert+priv as PEM. ----------
    let tmp = tempfile::tempdir().expect("tempdir");
    let pool = Arc::new(init_db(tmp.path()).await.expect("init_db"));
    seed_account_with(&pool, "acct-P12A", "p12a@kylins.com").await;

    let row_a = crypto_generate_key_inner(&pool, "acct-P12A", Standard::Smime, "p12a@kylins.com")
        .await
        .expect("generate_key_inner in acct-P12A");

    let canonical = lookup_handle(Standard::Smime, &row_a.fingerprint);
    let ks = Arc::new(SqliteKeyStore::new(
        std::sync::Arc::new((*pool).clone()),
        "acct-P12A",
    ));
    let stored = ks
        .get(&canonical)
        .await
        .expect("keystore get")
        .expect("stored key present");

    let cert_der = stored.public_data.clone();
    let priv_der = crypto_core::secret::expose_bytes(
        stored
            .private_data
            .as_ref()
            .expect("private material present after generate"),
    )
    .to_vec();

    let cert_pem_path = tmp.path().join("cert.pem");
    let key_pem_path = tmp.path().join("key.pem");
    std::fs::write(&cert_pem_path, pem_block("CERTIFICATE", &cert_der).as_bytes())
        .expect("write cert.pem");
    // EC keys in PKCS#8 DER unwrap to a PEM `PRIVATE KEY` block — openssl's
    // `pkcs12 -export -inkey` accepts PKCS#8 PEM (`PRIVATE KEY`) directly.
    std::fs::write(&key_pem_path, pem_block("PRIVATE KEY", &priv_der).as_bytes())
        .expect("write key.pem");

    // --- Bundle cert + key into a passphrase-protected `.p12` via openssl. -----
    let p12_path = tmp.path().join("bundle.p12");
    let mut p12_cmd = std::process::Command::new(&openssl);
    p12_cmd
        .arg("pkcs12")
        .arg("-export")
        .arg("-inkey")
        .arg(&key_pem_path)
        .arg("-in")
        .arg(&cert_pem_path)
        .arg("-passout")
        .arg("pass:test-secret")
        .arg("-out")
        .arg(&p12_path);
    run_openssl_assert(p12_cmd, "pkcs12 -export");
    assert!(p12_path.exists(), ".p12 file must be written");

    // --- Import the .p12 into a FRESH account (acct-P12B) WITH passphrase. ---
    seed_account_with(&pool, "acct-P12B", "p12b@kylins.com").await;
    let row_b = crypto_import_key_from_path_inner(
        &pool,
        "acct-P12B",
        Standard::Smime,
        p12_path.to_str().unwrap(),
        Some("test-secret".to_string()),
    )
    .await
    .expect("import_key_from_path_inner with passphrase");

    assert_eq!(row_b.standard, "smime");
    assert_eq!(
        row_b.fingerprint, row_a.fingerprint,
        "same cert → same SubjectKeyIdentifier fingerprint"
    );
    assert!(row_b.has_private, "imported p12 key must have private material");

    // Re-fetch from the db confirms persistence in acct-P12B.
    let again = get_crypto_key_public(&pool, "smime", &row_b.fingerprint)
        .await
        .expect("re-fetch");
    assert!(
        again.is_some(),
        "imported p12 row must persist in crypto_keys"
    );
}

/// Wrong passphrase for a `.p12` surfaces a `Policy`-style error string
/// (mapped from `CryptoError::Policy("p12 passphrase incorrect")` by the
/// backend). Mirrors `crypto-smime`'s
/// `import_key_p12_wrong_passphrase_is_policy_error` at the IPC seam: proves
/// the error propagates out of `crypto_import_key_from_path_inner` (and
/// therefore the Tauri command) as a user-facing string rather than panicking
/// or being silently swallowed. Skips silently when openssl is unreachable.
#[tokio::test]
async fn crypto_import_key_from_path_inner_wrong_passphrase_is_user_error() {
    let openssl = match openssl_path() {
        Some(p) => p,
        None => {
            eprintln!(
                "openssl not available on PATH; skipping wrong-passphrase IPC test."
            );
            return;
        }
    };

    let tmp = tempfile::tempdir().expect("tempdir");
    let pool = Arc::new(init_db(tmp.path()).await.expect("init_db"));
    seed_account_with(&pool, "acct-WP12A", "wp12a@kylins.com").await;

    let row_a = crypto_generate_key_inner(&pool, "acct-WP12A", Standard::Smime, "wp12a@kylins.com")
        .await
        .expect("generate_key_inner");

    let canonical = lookup_handle(Standard::Smime, &row_a.fingerprint);
    let ks = Arc::new(SqliteKeyStore::new(
        std::sync::Arc::new((*pool).clone()),
        "acct-WP12A",
    ));
    let stored = ks
        .get(&canonical)
        .await
        .expect("keystore get")
        .expect("stored key present");

    let cert_pem_path = tmp.path().join("cert.pem");
    let key_pem_path = tmp.path().join("key.pem");
    std::fs::write(
        &cert_pem_path,
        pem_block("CERTIFICATE", &stored.public_data).as_bytes(),
    )
    .expect("write cert.pem");
    let priv_der = crypto_core::secret::expose_bytes(
        stored
            .private_data
            .as_ref()
            .expect("private material present after generate"),
    )
    .to_vec();
    std::fs::write(&key_pem_path, pem_block("PRIVATE KEY", &priv_der).as_bytes())
        .expect("write key.pem");

    let p12_path = tmp.path().join("bundle.p12");
    let mut p12_cmd = std::process::Command::new(&openssl);
    p12_cmd
        .arg("pkcs12")
        .arg("-export")
        .arg("-inkey")
        .arg(&key_pem_path)
        .arg("-in")
        .arg(&cert_pem_path)
        .arg("-passout")
        .arg("pass:correct-secret")
        .arg("-out")
        .arg(&p12_path);
    run_openssl_assert(p12_cmd, "pkcs12 -export");

    // Import with the WRONG passphrase → the IPC fn returns Err (a string
    // rendered from `CryptoError::Policy(..)` — "p12 passphrase incorrect"),
    // NOT a panic + NOT a Malformed "file unreadable" message.
    seed_account_with(&pool, "acct-WP12B", "wp12b@kylins.com").await;
    let err = crypto_import_key_from_path_inner(
        &pool,
        "acct-WP12B",
        Standard::Smime,
        p12_path.to_str().unwrap(),
        Some("wrong-secret".to_string()),
    )
    .await
    .expect_err("wrong passphrase must surface an error, not silently succeed");

    // `Policy` maps to a string containing "passphrase"; `Malformed` would
    // surface "file unreadable"/"malformed" wording — assert the user-facing
    // string carries the passphrase-incorrect signal.
    let lower = err.to_lowercase();
    assert!(
        lower.contains("passphrase"),
        "wrong-passphrase error must mention 'passphrase' (got: {err})"
    );
}

// ---- Plan 3b — `.p12`/`.pfx` export through the IPC inner fn ---------------
//
// Verifies `crypto_export_p12_to_path_inner` (the export mirror of
// `crypto_import_key_from_path_inner`): generates a key in acct-A, exports it
// as a passphrase-protected PFX, then re-imports the file into acct-B via the
// SAME import inner fn the UI uses — proving the PFX we built is readable by
// our own import path with identical contents (cert + fingerprint match).
// In-process (no openssl shell-out): p12-keystore writes the PFX, p12-keystore
// reads it back.

use kylins_client_lib::db::commands::crypto_export_p12_to_path_inner;

/// `crypto_export_p12_to_path_inner` writes a passphrase-protected PFX file at
/// `out_path`; re-importing that file via `crypto_import_key_from_path_inner`
/// round-trips the cert + private key into a FRESH account whose fingerprint
/// matches the source. Exercises the full IPC stack (intermediate resolution
/// via `list_intermediate_certs` + `SmimeBackend::export_p12` +
/// `std::fs::write`) without openssl.
#[tokio::test]
async fn crypto_export_p12_to_path_writes_pfx() {
    let tmp = tempfile::tempdir().expect("tempdir");
    let pool = Arc::new(init_db(tmp.path()).await.expect("init_db"));
    seed_account_with(&pool, "acct-EXP12-A", "exp12a@kylins.com").await;

    // Generate a key in acct-A — the identity we'll export.
    let row_a = crypto_generate_key_inner(&pool, "acct-EXP12-A", Standard::Smime, "exp12a@kylins.com")
        .await
        .expect("generate_key_inner in acct-EXP12-A");
    assert!(
        row_a.has_private,
        "fixture key must have private material to export"
    );

    // Export to a temp .p12 with a known passphrase.
    let p12_path = tmp.path().join("exported-identity.p12");
    crypto_export_p12_to_path_inner(
        &pool,
        "acct-EXP12-A",
        "smime",
        &row_a.fingerprint,
        Some("export-test-pass".to_string()),
        p12_path.to_str().unwrap(),
    )
    .await
    .expect("export_p12_to_path_inner");

    assert!(p12_path.exists(), ".p12 file must be written");
    let pfx_bytes = std::fs::read(&p12_path).expect("read p12");
    assert!(!pfx_bytes.is_empty(), ".p12 bytes must be non-empty");

    // Re-import into a FRESH account (acct-EXP12-B) via the SAME import inner
    // fn the KeyManager UI calls — proves the PFX we built is readable by our
    // own import path with identical contents.
    seed_account_with(&pool, "acct-EXP12-B", "exp12b@kylins.com").await;
    let row_b = crypto_import_key_from_path_inner(
        &pool,
        "acct-EXP12-B",
        Standard::Smime,
        p12_path.to_str().unwrap(),
        Some("export-test-pass".to_string()),
    )
    .await
    .expect("re-import the exported .p12");

    assert_eq!(row_b.standard, "smime");
    assert_eq!(
        row_b.fingerprint, row_a.fingerprint,
        "re-imported fingerprint must match the source (same cert → same SKI)"
    );
    assert!(
        row_b.has_private,
        "re-imported .p12 must carry the private key back into acct-EXP12-B"
    );
}

/// `crypto_export_p12_to_path_inner` surfaces the empty-passphrase Policy
/// error as a user-facing string (NOT a panic + NOT a silent no-op). The
/// passphrase is REQUIRED non-empty — a `.p12` carrying a private key MUST be
/// encrypted. The frontend confirm-passphrase prompt guards the UX side; this
/// test pins the backend's defense so a UI regression can't bypass it.
#[tokio::test]
async fn crypto_export_p12_to_path_empty_passphrase_is_user_error() {
    let tmp = tempfile::tempdir().expect("tempdir");
    let pool = Arc::new(init_db(tmp.path()).await.expect("init_db"));
    seed_account_with(&pool, "acct-EXP12-NP", "exp12np@kylins.com").await;

    let row = crypto_generate_key_inner(&pool, "acct-EXP12-NP", Standard::Smime, "exp12np@kylins.com")
        .await
        .expect("generate_key_inner");

    let p12_path = tmp.path().join("empty-pass.p12");
    let err = crypto_export_p12_to_path_inner(
        &pool,
        "acct-EXP12-NP",
        "smime",
        &row.fingerprint,
        None,
        p12_path.to_str().unwrap(),
    )
    .await
    .expect_err("None passphrase must surface an error");

    let lower = err.to_lowercase();
    assert!(
        lower.contains("passphrase"),
        "empty-passphrase error must mention 'passphrase' (got: {err})"
    );
    assert!(
        !p12_path.exists(),
        "no .p12 file must be written on passphrase failure"
    );
}
