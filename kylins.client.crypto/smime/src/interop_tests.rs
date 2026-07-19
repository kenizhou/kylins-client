//! Cross-implementation (openssl) round-trip fixtures for S/MIME CMS.
//!
//! G7 Task 3 (Crypto Phase 1b Plan 5): prove our `cms_build` / `cms_parse`
//! interoperate with an independent CMS implementation — the openssl 3.x CLI,
//! the proxy for Thunderbird/NSS (which uses NSS/OpenSSL-style CMS code under
//! the hood). Three directions are exercised:
//!
//! 1. **openssl-encrypt → our-decrypt** (ktri/RSA full; kari/EC full — G7 T5
//!    closed the SHA-1 KDF interop gap).
//! 2. **openssl-sign    → our-verify**  (ECDSA-P256 full; RSA `#[ignore]`).
//! 3. **our-build       → openssl-verify** (full positive — the G7 Task 1
//!    eContent double-wrap fix validation; if openssl accepts our signature,
//!    the fix is complete).
//!
//! All tests skip silently when openssl is not reachable on PATH (mirroring the
//! G7 T1 `openssl_asn1parse_confirms_single_octet_string_econtent` pattern in
//! `cms_build::tests`). When openssl IS available, fixtures are generated
//! in-test via `std::process::Command` so the suite is reproducible without
//! committing binary blobs.
//!
//! # Manual run procedure (when openssl is not on PATH)
//!
//! ```text
//! # 1. Install openssl (Windows: Git for Windows ships it at
//! #    C:\Program Files\Git\mingw64\bin\openssl.exe; add to PATH).
//! # 2. cargo test -p crypto-smime --test interop -- --include-ignored
//! # 3. For the remaining #[ignore] test (RSA sig verify), un-ignore once
//! #    the G4 RSA CMS signature-verify gap is closed.
//! ```

use crate::cms_build::{build_signed_data, recipient_input_from_cert};
use crate::cms_parse::{decrypt_enveloped, verify_signed};
use crate::cert::build_self_signed_smime_cert;

// ─────────────────────────── openssl discovery ───────────────────────────

/// Locate the openssl CLI binary. Returns `None` when openssl is neither on
/// `PATH` nor at the Windows Git-for-Windows fallback location.
///
/// The check runs `openssl version` and accepts any successful exit status.
/// Callers cache the result via `Option<PathBuf>` so the discovery cost is
/// paid once per test process.
fn openssl_path() -> Option<std::path::PathBuf> {
    // Try "openssl" on PATH first (covers Linux/macOS/Windows-with-openssl-on-PATH).
    let on_path = std::process::Command::new("openssl")
        .arg("version")
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .status()
        .map(|s| s.success())
        .unwrap_or(false);
    if on_path {
        return Some(std::path::PathBuf::from("openssl"));
    }
    // Windows fallback: Git for Windows ships openssl.exe at a known path.
    #[cfg(windows)]
    {
        let candidates: &[&str] = &[
            r"C:\Program Files\Git\mingw64\bin\openssl.exe",
            r"C:\Program Files (x86)\Git\mingw64\bin\openssl.exe",
        ];
        for c in candidates {
            if std::path::Path::new(c).exists() {
                return Some(std::path::PathBuf::from(c));
            }
        }
    }
    None
}

/// Build a `Command` for openssl, or skip the calling test silently.
/// Usage: `let mut cmd = openssl_cmd_or_skip()?;`
macro_rules! openssl_cmd_or_skip {
    () => {{
        let path = match openssl_path() {
            Some(p) => p,
            None => {
                eprintln!(
                    "openssl not available on PATH; skipping cross-impl test. \
                     See `interop_tests` module docs for the manual run procedure."
                );
                return;
            }
        };
        std::process::Command::new(path)
    }};
}

// ───────────────────────────── temp dir ──────────────────────────────────

/// A RAII temp directory. Created with a unique name (process id + nanos) and
/// removed (best-effort) on drop. Avoids pulling in the `tempfile` dev-dep —
/// std primitives are sufficient.
struct TempDir(std::path::PathBuf);

impl TempDir {
    fn new(test_name: &str) -> Self {
        let mut dir = std::env::temp_dir();
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0);
        dir.push(format!("kylins-smime-{}-{}-{}", test_name, std::process::id(), nanos));
        std::fs::create_dir_all(&dir).expect("create temp dir");
        Self(dir)
    }

    /// Join a filename relative to the temp dir.
    fn join(&self, name: &str) -> std::path::PathBuf {
        let mut p = self.0.clone();
        p.push(name);
        p
    }
}

impl Drop for TempDir {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

// ──────────────────────────── PEM helpers ───────────────────────────────

/// Wrap DER bytes as a single PEM block (`-----BEGIN <label>-----` ...).
/// 64-column body, trailing newline. Used to feed our DER cert/key to openssl
/// CLI commands that take PEM inputs (`-signer`, `-inkey`, `-CAfile`, ...).
fn der_to_pem(label: &str, der: &[u8]) -> String {
    use base64::Engine;
    let b64 = base64::engine::general_purpose::STANDARD.encode(der);
    let mut out = format!("-----BEGIN {label}-----\n");
    for chunk in b64.as_bytes().chunks(64) {
        out.push_str(std::str::from_utf8(chunk).expect("base64 is ascii"));
        out.push('\n');
    }
    out.push_str(&format!("-----END {label}-----\n"));
    out
}

/// Decode the first PEM block in `text` to DER. Used to read openssl-generated
/// cert/key/CMS output back into bytes our Rust code can consume.
fn pem_first_block_to_der(text: &str) -> Vec<u8> {
    use base64::Engine;
    let engine = base64::engine::general_purpose::STANDARD;
    let mut in_block = false;
    let mut b64 = String::new();
    for line in text.lines() {
        let line = line.trim();
        if line.starts_with("-----BEGIN ") {
            in_block = true;
            b64.clear();
        } else if line.starts_with("-----END ") {
            if in_block && !b64.is_empty() {
                return engine
                    .decode(&b64)
                    .unwrap_or_else(|e| panic!("PEM base64 decode: {e}"));
            }
            in_block = false;
        } else if in_block {
            b64.push_str(line);
        }
    }
    panic!("no PEM block found in text (len={})", text.len());
}

// ──────────────────── openssl subprocess plumbing ────────────────────────

/// Run openssl with `args`, capture stdout/stderr, and assert success.
/// Returns the captured stdout (often empty for our use cases — outputs go to
/// files via `-out`).
fn run_openssl_assert(
    mut cmd: std::process::Command,
    label: &str,
) -> std::process::Output {
    let out = cmd
        .output()
        .unwrap_or_else(|e| panic!("openssl {label}: spawn failed: {e}"));
    if !out.status.success() {
        panic!(
            "openssl {label} failed (status={}): {}",
            out.status,
            String::from_utf8_lossy(&out.stderr)
        );
    }
    out
}

// ───────────────────────────── tests ─────────────────────────────────────

// === Direction 1: openssl-encrypt → our-decrypt ===

/// ktri (RSA): openssl generates an RSA self-signed cert + key, encrypts a
/// payload to that cert with `openssl cms -encrypt -aes128`, and our
/// `decrypt_enveloped` recovers the plaintext. This proves our ktri decrypt
/// (PKCS#1v1.5 CEK unwrap + AES-128-CBC content decrypt) works against an
/// independent CMS implementation's output (Plan 1's ktri was only
/// self-round-trip-tested).
#[test]
fn openssl_encrypt_to_rsa_recipient_decrypts_with_our_code() {
    let _td = TempDir::new("openssl-ktri");
    let mut cmd = openssl_cmd_or_skip!();
    // 1. Generate RSA self-signed cert + unencrypted PKCS#8 key.
    cmd.args([
        "req", "-new", "-x509",
        "-keyout", _td.join("rsa_key.pem").to_str().unwrap(),
        "-out",    _td.join("rsa_cert.pem").to_str().unwrap(),
        "-days", "365",
        "-nodes",
        "-subj", "/CN=openssl-rsa-rcpt",
        "-newkey", "rsa:3072",
    ]);
    run_openssl_assert(cmd, "req (RSA cert)");

    // Read the cert + key PEMs back as DER for our decrypt path.
    let rsa_cert_pem = std::fs::read_to_string(_td.join("rsa_cert.pem")).unwrap();
    let rsa_cert_der = pem_first_block_to_der(&rsa_cert_pem);
    let rsa_key_pem = std::fs::read_to_string(_td.join("rsa_key.pem")).unwrap();
    let rsa_priv_der = pem_first_block_to_der(&rsa_key_pem);
    // openssl `req -keyout` writes a PKCS#8 "PRIVATE KEY" PEM block; this is
    // the unencrypted PKCS#8 DER our `decrypt_enveloped` expects.

    // 2. Encrypt a payload with openssl.
    let plaintext = b"hello openssl -> kylins ktri round-trip";
    std::fs::write(_td.join("plain.txt"), plaintext).unwrap();
    let mut cmd = openssl_cmd_or_skip!();
    cmd.args([
        "cms", "-encrypt",
        "-in",   _td.join("plain.txt").to_str().unwrap(),
        "-out",  _td.join("env.der").to_str().unwrap(),
        "-outform", "DER",
        "-aes128",
        _td.join("rsa_cert.pem").to_str().unwrap(),
    ]);
    run_openssl_assert(cmd, "cms -encrypt (RSA)");

    let env_der = std::fs::read(_td.join("env.der")).unwrap();

    // 3. Our decrypt path recovers the plaintext.
    let recovered = decrypt_enveloped(&env_der, &rsa_cert_der, &rsa_priv_der)
        .expect("our decrypt_enveloped recovers openssl-encrypted plaintext (ktri)");
    assert_eq!(
        recovered.as_slice(),
        plaintext,
        "ktri decrypt must recover the exact plaintext openssl encrypted"
    );
}

/// kari (EC P-256): openssl generates an EC self-signed cert + key, encrypts
/// a payload with `openssl cms -encrypt -aes128 -aes192-wrap`, and our
/// `decrypt_enveloped` recovers the plaintext.
///
/// openssl's default kari KDF is `dhSinglePass-stdDH-sha1kdf-scheme`
/// (1.3.133.16.840.63.0.2) with no CLI flag to force SHA-256 (the KDF is
/// chosen from the recipient cert's SMIMECapabilities extension, which our
/// `build_self_signed_smime_cert` does not emit). The G7 T5 fix in
/// `cms_parse::unwrap_kari_cek` dispatches the KDF hash on
/// `kari.key_enc_alg.oid` (RFC 5753 §7.2) — SHA-1 (openssl/NSS historical
/// default), SHA-256 (our build side), and SHA-224/384/512 — so this test now
/// passes. Previously `#[ignore]`d with the SHA-1 KDF gap as a documented
/// carry-forward; un-ignored when the dispatch landed.
#[test]
fn openssl_encrypt_to_ec_recipient_decrypts_with_our_code() {
    let _td = TempDir::new("openssl-kari");
    let mut cmd = openssl_cmd_or_skip!();
    // 1. Generate EC P-256 key (PKCS#8) + self-signed cert in one shot.
    //    Using `-newkey ec -pkeyopt ec_paramgen_curve:P-256` produces a
    //    `BEGIN PRIVATE KEY` PEM block (PKCS#8 PrivateKeyInfo), which is what
    //    our `decrypt_enveloped` expects via `p256::SecretKey::from_pkcs8_der`.
    //    The older `ecparam -genkey` two-step emits a SEC1 `EC PRIVATE KEY`
    //    block which our code does not parse.
    cmd.args([
        "req", "-new", "-x509",
        "-newkey", "ec",
        "-pkeyopt", "ec_paramgen_curve:P-256",
        "-keyout", _td.join("ec_key.pem").to_str().unwrap(),
        "-out",    _td.join("ec_cert.pem").to_str().unwrap(),
        "-days", "365",
        "-nodes",
        "-subj", "/CN=openssl-ec-rcpt",
    ]);
    run_openssl_assert(cmd, "req (EC cert + PKCS#8 key)");

    let ec_cert_pem = std::fs::read_to_string(_td.join("ec_cert.pem")).unwrap();
    let ec_cert_der = pem_first_block_to_der(&ec_cert_pem);
    let ec_key_pem = std::fs::read_to_string(_td.join("ec_key.pem")).unwrap();
    let ec_priv_der = pem_first_block_to_der(&ec_key_pem);

    // 2. Encrypt with AES-128 content + AES-192 key wrap (matches our build's
    //    kari structure). The KDF is still SHA-1 (openssl default) — the gap.
    let plaintext = b"hello openssl -> kylins kari round-trip";
    std::fs::write(_td.join("plain.txt"), plaintext).unwrap();
    let mut cmd = openssl_cmd_or_skip!();
    cmd.args([
        "cms", "-encrypt",
        "-in",   _td.join("plain.txt").to_str().unwrap(),
        "-out",  _td.join("env.der").to_str().unwrap(),
        "-outform", "DER",
        "-aes128", "-aes192-wrap",
        _td.join("ec_cert.pem").to_str().unwrap(),
    ]);
    run_openssl_assert(cmd, "cms -encrypt (EC kari)");

    let env_der = std::fs::read(_td.join("env.der")).unwrap();

    // 3. Our decrypt path. Currently fails because our KDF is hardcoded to
    //    SHA-256 and openssl emits SHA-1. When the dispatch lands, this
    //    assertion passes unchanged.
    let recovered = decrypt_enveloped(&env_der, &ec_cert_der, &ec_priv_der)
        .expect("our decrypt_enveloped recovers openssl-encrypted plaintext (kari)");
    assert_eq!(
        recovered.as_slice(),
        plaintext,
        "kari decrypt must recover the exact plaintext openssl encrypted"
    );
}

// === Direction 2: openssl-sign → our-verify ===

/// ECDSA-P256: openssl generates an ECDSA-P256 self-signed cert + key, signs
/// a payload with `openssl cms -sign -nodetach` (encapsulated, with default
/// signed attributes: contentType + messageDigest + signingTime), and our
/// `verify_signed` confirms `sig_ok`. This proves our CMS signature verify
/// path (signed-attrs DER encoding, ECDSA-P256 signature check, messageDigest
/// attribute comparison) works against an independent CMS implementation's
/// signatures.
#[test]
fn openssl_sign_ecdsa_p256_verifies_with_our_code() {
    let _td = TempDir::new("openssl-sign-ec");
    let mut cmd = openssl_cmd_or_skip!();
    // 1. Generate EC P-256 key (PKCS#8) + self-signed cert in one shot. The
    //    PEM block label is `PRIVATE KEY` (PKCS#8) — what downstream tooling
    //    and our code expect. (For this test only openssl reads the key; we
    //    only feed the cert + CMS to our `verify_signed`.)
    cmd.args([
        "req", "-new", "-x509",
        "-newkey", "ec",
        "-pkeyopt", "ec_paramgen_curve:P-256",
        "-keyout", _td.join("ec_key.pem").to_str().unwrap(),
        "-out",    _td.join("ec_cert.pem").to_str().unwrap(),
        "-days", "365",
        "-nodes",
        "-subj", "/CN=openssl-ec-signer",
    ]);
    run_openssl_assert(cmd, "req (EC signer cert + key)");

    let plaintext = b"signed by openssl -> verified by kylins";
    std::fs::write(_td.join("plain.txt"), plaintext).unwrap();
    let mut cmd = openssl_cmd_or_skip!();
    cmd.args([
        "cms", "-sign",
        "-in",   _td.join("plain.txt").to_str().unwrap(),
        "-out",  _td.join("signed.der").to_str().unwrap(),
        "-outform", "DER",
        "-signer", _td.join("ec_cert.pem").to_str().unwrap(),
        "-inkey",  _td.join("ec_key.pem").to_str().unwrap(),
        "-nodetach", // encapsulated: eContent carries the payload
    ]);
    run_openssl_assert(cmd, "cms -sign (ECDSA-P256)");

    let signed_der = std::fs::read(_td.join("signed.der")).unwrap();

    // Our verify path: encapsulated → covered_content is None (the payload
    // lives inside the eContent per RFC 5652 §3).
    let check = verify_signed(&signed_der, /*covered_content=*/ None)
        .expect("our verify_signed parses openssl-signed CMS");
    assert!(
        check.sig_ok,
        "openssl-signed ECDSA-P256 CMS must verify with our code; \
         signer_fp={:?}",
        check.signer_fingerprint
    );
}

/// RSA: openssl signs with an RSA key (PKCS#1v1.5 over SHA-256) → our
/// `verify_signed` confirms `sig_ok`. Un-ignored as part of the G4-extend
/// task (RSA-PKCS1v1.5 + RSA-PSS + ECDSA-P384 CMS sig verify); the in-test
/// unit round-trips (`cms_parse::tests::verify_round_trips_rsa_*`) cover the
/// no-openssl case. Skips silently when openssl is not on PATH.
#[test]
fn openssl_sign_rsa_verifies_with_our_code() {
    let _td = TempDir::new("openssl-sign-rsa");
    let mut cmd = openssl_cmd_or_skip!();
    cmd.args([
        "req", "-new", "-x509",
        "-keyout", _td.join("rsa_key.pem").to_str().unwrap(),
        "-out",    _td.join("rsa_cert.pem").to_str().unwrap(),
        "-days", "365",
        "-nodes",
        "-subj", "/CN=openssl-rsa-signer",
        "-newkey", "rsa:3072",
    ]);
    run_openssl_assert(cmd, "req (RSA signer cert)");

    let plaintext = b"signed by openssl RSA -> verified by kylins";
    std::fs::write(_td.join("plain.txt"), plaintext).unwrap();
    let mut cmd = openssl_cmd_or_skip!();
    cmd.args([
        "cms", "-sign",
        "-in",   _td.join("plain.txt").to_str().unwrap(),
        "-out",  _td.join("signed.der").to_str().unwrap(),
        "-outform", "DER",
        "-signer", _td.join("rsa_cert.pem").to_str().unwrap(),
        "-inkey",  _td.join("rsa_key.pem").to_str().unwrap(),
        "-nodetach",
    ]);
    run_openssl_assert(cmd, "cms -sign (RSA-PKCS1v15)");

    let signed_der = std::fs::read(_td.join("signed.der")).unwrap();

    let check = verify_signed(&signed_der, None)
        .expect("our verify_signed parses openssl RSA-signed CMS");
    assert!(
        check.sig_ok,
        "openssl RSA-PKCS1v1.5-signed CMS must verify with our code \
         (G4-extend: RSA sig verify landed). signer_fp={:?}",
        check.signer_fingerprint
    );
}

// === Direction 3: our-build → openssl-verify (the T1 eContent fix validation) ===

/// Build a SignedData via `cms_build::build_signed_data` (encapsulated,
/// post-T1-fix eContent = single OCTET STRING wrapping the raw payload), then
/// verify it with `openssl cms -verify -noverify -out <recovered>`. openssl
/// accepts the signature → the eContent double-wrap fix from G7 T1 is
/// complete and our SignedData is RFC-conformant.
///
/// `-noverify` skips the cert-chain check (we test the cryptographic
/// signature interop, not the trust path — our self-signed cert has no CA
/// chain to validate). The signature is still cryptographically verified.
#[test]
fn our_built_signed_data_verifies_with_openssl() {
    let _td = TempDir::new("our-build-openssl-verify");
    // Skip cleanly when openssl is unavailable — see manual-run docstring above.
    if openssl_path().is_none() {
        eprintln!(
            "openssl not available on PATH; skipping cross-impl test. \
             See `interop_tests` module docs for the manual run procedure."
        );
        return;
    }

    // 1. Build a SignedData via OUR production builder (post-T1 fix).
    let built = build_self_signed_smime_cert("t3-ourbuild@kylins.com").unwrap();
    let payload = b"hello thunderbird; please verify me (G7 T3 cross-impl)";
    let signed_der = build_signed_data(
        payload,
        /*detached=*/ false,
        &built.cert_der,
        &built.priv_pkcs8_der,
    )
    .expect("build_signed_data");

    // 2. Write the SignedData DER + signer cert PEM to temp files for openssl.
    std::fs::write(_td.join("signed.der"), &signed_der).unwrap();
    let cert_pem = der_to_pem("CERTIFICATE", &built.cert_der);
    std::fs::write(_td.join("signer.pem"), cert_pem).unwrap();

    // 3. openssl verifies. `-noverify` skips the chain check (self-signed cert,
    //    no CA chain); the cryptographic signature is still verified. `-out`
    //    captures the recovered encapsulated content.
    let recovered_path = _td.join("recovered.txt");
    let mut cmd = openssl_cmd_or_skip!();
    cmd.args([
        "cms", "-verify",
        "-in",      _td.join("signed.der").to_str().unwrap(),
        "-inform",  "DER",
        "-out",     recovered_path.to_str().unwrap(),
        "-noverify", // skip cert-chain (we test sig interop, not trust path)
    ]);
    let out = run_openssl_assert(cmd, "cms -verify (our-build → openssl)");

    // openssl writes "Verification successful" to stderr on success.
    let stderr = String::from_utf8_lossy(&out.stderr);
    eprintln!("openssl cms -verify stderr:\n{stderr}");
    assert!(
        stderr.contains("successful") || out.status.success(),
        "openssl must report successful verification; stderr={stderr}"
    );

    // 4. openssl recovered the encapsulated payload verbatim.
    let recovered = std::fs::read(&recovered_path).unwrap_or_default();
    assert_eq!(
        recovered.as_slice(),
        payload,
        "openssl must recover the exact payload our build_signed_data encapsulated; \
         this is the OUR-SIGNS→OPENSSL-VERIFIES invariant the G7 T1 eContent fix \
         makes pass. If this fails, the eContent double-wrap (or another \
         RFC 5652 §3 / §5.4 violation) is reintroduced."
    );
}

// === Direction 1 (reverse): our-build → openssl-decrypt ===
//
// Bonus: build an EnvelopedData with our `build_enveloped_data` to an
// openssl-generated recipient cert, then decrypt with `openssl cms -decrypt`.
// Proves our kari/ktri BUILD side is interoperable (openssl can decrypt what
// we encrypt). This is the OUR-ENCRYPTS→OPENSSL-DECRYPTS direction.

/// kari (EC P-256): our `build_enveloped_data` encrypts to an
/// openssl-generated EC P-256 cert → openssl decrypts with
/// `openssl cms -decrypt -recip ... -inkey ...`. Proves our kari build output
/// is RFC 5753-conformant (openssl's ECDH + AES-KW + KDF path accepts it).
#[test]
fn our_built_enveloped_data_decrypts_with_openssl_kari() {
    let _td = TempDir::new("our-build-openssl-decrypt-kari");

    // 1. Generate the EC P-256 recipient cert + key (PKCS#8) with openssl in
    //    one shot (independent cert/key source — proves our build handles an
    //    externally-produced recipient cert, not just our own).
    let mut cmd = openssl_cmd_or_skip!();
    cmd.args([
        "req", "-new", "-x509",
        "-newkey", "ec",
        "-pkeyopt", "ec_paramgen_curve:P-256",
        "-keyout", _td.join("ec_key.pem").to_str().unwrap(),
        "-out",    _td.join("ec_cert.pem").to_str().unwrap(),
        "-days", "365",
        "-nodes",
        "-subj", "/CN=openssl-ec-rcpt-for-our-build",
    ]);
    run_openssl_assert(cmd, "req (EC recipient cert + key)");

    let ec_cert_pem = std::fs::read_to_string(_td.join("ec_cert.pem")).unwrap();
    let ec_cert_der = pem_first_block_to_der(&ec_cert_pem);

    // 2. Our build side: build an EnvelopedData to the openssl-generated cert.
    let plaintext = b"hello openssl, please decrypt what kylins built (kari)";
    let recip = recipient_input_from_cert(&ec_cert_der).expect("recipient input");
    let enveloped_der = crate::cms_build::build_enveloped_data(
        plaintext,
        std::slice::from_ref(&recip),
    )
    .expect("build enveloped data (kari) to openssl-generated cert");

    // 3. Write the EnvelopedData DER + recipient cert PEM for openssl.
    std::fs::write(_td.join("env.der"), &enveloped_der).unwrap();
    std::fs::write(_td.join("recip.pem"), &ec_cert_pem).unwrap();

    // 4. openssl decrypts with the recipient key. `-recip` is the cert PEM,
    //    `-inkey` is the key PEM (unencrypted EC key from `ecparam`).
    let recovered_path = _td.join("recovered.txt");
    let mut cmd = openssl_cmd_or_skip!();
    cmd.args([
        "cms", "-decrypt",
        "-in",      _td.join("env.der").to_str().unwrap(),
        "-inform",  "DER",
        "-recip",   _td.join("recip.pem").to_str().unwrap(),
        "-inkey",   _td.join("ec_key.pem").to_str().unwrap(),
        "-out",     recovered_path.to_str().unwrap(),
    ]);
    let out = run_openssl_assert(cmd, "cms -decrypt (openssl decrypts our kari)");

    eprintln!(
        "openssl cms -decrypt stderr:\n{}",
        String::from_utf8_lossy(&out.stderr)
    );

    // 5. openssl recovered the plaintext our build encrypted.
    let recovered = std::fs::read(&recovered_path).unwrap_or_default();
    assert_eq!(
        recovered.as_slice(),
        plaintext,
        "openssl must decrypt the EnvelopedData our build_enveloped_data produced \
         (kari). If this fails, our kari build output is not RFC 5753-conformant \
         (KDF / key wrap / content encryption mismatch)."
    );
}

/// ktri (RSA): our `build_enveloped_data` encrypts to an openssl-generated
/// RSA cert → openssl decrypts. Proves our ktri build (PKCS#1v1.5 CEK wrap +
/// AES-128-CBC content) is RFC-conformant.
#[test]
fn our_built_enveloped_data_decrypts_with_openssl_ktri() {
    let _td = TempDir::new("our-build-openssl-decrypt-ktri");

    let mut cmd = openssl_cmd_or_skip!();
    cmd.args([
        "req", "-new", "-x509",
        "-keyout", _td.join("rsa_key.pem").to_str().unwrap(),
        "-out",    _td.join("rsa_cert.pem").to_str().unwrap(),
        "-days", "365",
        "-nodes",
        "-subj", "/CN=openssl-rsa-rcpt-for-our-build",
        "-newkey", "rsa:3072",
    ]);
    run_openssl_assert(cmd, "req (RSA recipient cert)");

    let rsa_cert_pem = std::fs::read_to_string(_td.join("rsa_cert.pem")).unwrap();
    let rsa_cert_der = pem_first_block_to_der(&rsa_cert_pem);

    let plaintext = b"hello openssl, please decrypt what kylins built (ktri)";
    let recip = recipient_input_from_cert(&rsa_cert_der).expect("recipient input");
    let enveloped_der = crate::cms_build::build_enveloped_data(
        plaintext,
        std::slice::from_ref(&recip),
    )
    .expect("build enveloped data (ktri) to openssl-generated cert");

    std::fs::write(_td.join("env.der"), &enveloped_der).unwrap();
    std::fs::write(_td.join("recip.pem"), &rsa_cert_pem).unwrap();

    let recovered_path = _td.join("recovered.txt");
    let mut cmd = openssl_cmd_or_skip!();
    cmd.args([
        "cms", "-decrypt",
        "-in",      _td.join("env.der").to_str().unwrap(),
        "-inform",  "DER",
        "-recip",   _td.join("recip.pem").to_str().unwrap(),
        "-inkey",   _td.join("rsa_key.pem").to_str().unwrap(),
        "-out",     recovered_path.to_str().unwrap(),
    ]);
    let out = run_openssl_assert(cmd, "cms -decrypt (openssl decrypts our ktri)");

    eprintln!(
        "openssl cms -decrypt stderr:\n{}",
        String::from_utf8_lossy(&out.stderr)
    );

    let recovered = std::fs::read(&recovered_path).unwrap_or_default();
    assert_eq!(
        recovered.as_slice(),
        plaintext,
        "openssl must decrypt the EnvelopedData our build_enveloped_data produced \
         (ktri). If this fails, our ktri build output is not RFC-conformant."
    );
}
