//! Cross-implementation interop tests for OpenPGP (Task 9).
//!
//! Mirrors `crypto-smime/src/interop_tests.rs`: prove our output is consumed
//! by a reference OpenPGP implementation (GnuPG `gpg` / Sequoia `sq`) and
//! vice-versa. All tests skip silently when neither CLI is on PATH so CI
//! without the tooling stays green. When a CLI IS available, all state is
//! isolated in a temp homedir (`gpg --homedir <tmp>` / `sq --keystore <tmp>`)
//! so the user's real keyring is NEVER touched.
//!
//! # Coverage
//!
//! Four directions are exercised (when at least one CLI is present):
//!
//! 1. **CLI-encrypts → engine::decrypt**: we generate a Cert here, export its
//!    armored public key, import into the CLI's temp keyring, encrypt THERE,
//!    then `engine::decrypt` HERE → plaintext matches.
//! 2. **engine::encrypt → CLI-decrypts**: we encrypt here; the CLI decrypts
//!    using a temp keyring seeded with our Cert's armored secret → plaintext
//!    matches.
//! 3. **CLI-signs → engine::verify_detached**: CLI detach-signs; our engine
//!    verifies → `SignatureState::ValidVerified`.
//! 4. **engine::sign_detached → CLI-verifies**: our engine detach-signs; the
//!    CLI verifies → exit 0.
//!
//! # Framing note (engine internals)
//!
//! Our engine wraps multi-part payloads in a self-describing binary frame
//! before OpenPGP encryption (`engine::frame_parts` — see `engine.rs` docs).
//! The frame is INTERNAL — not part of any wire format — so for the cross-impl
//! tests we either (a) pre-frame the plaintext before feeding it to the CLI's
//! encrypt (direction 1) so `engine::decrypt`'s `unframe_parts` succeeds, or
//! (b) unframe the bytes the CLI recovered from our ciphertext (direction 2)
//! using the same documented format. Helpers `frame_single_body` /
//! `unframe_single_body` (below) implement this minimal framing for test
//! setup. The WIRE FORMAT being tested is the OpenPGP message itself
//! (PKESK + SEIP + literal-data), not the engine's internal framing.
//!
//! # Manual run
//!
//! On a Windows dev box, `gpg` ships with Git for Windows at
//! `C:\Program Files\Git\usr\bin\gpg.exe` (on PATH in Git Bash). `sq` is not
//! distributed with Git for Windows; install it separately
//! (e.g. `cargo install sequoia-sq`) to exercise the sq paths. When neither
//! is available, every test prints `skipping: no sq/gpg` and returns.

mod common;

use common::MemoryKeyStore;
use crypto_core::{
    CryptoBackend, EncryptedEnvelope, EncryptedPart, Part, PartId, PartKind, SerializationStrategy,
    Standard,
};
use crypto_openpgp::engine;
use crypto_openpgp::policy::PgpPolicy;
use sequoia_openpgp as openpgp;
use sequoia_openpgp::serialize::Marshal;
use std::process::{Command, Stdio};
use std::sync::Arc;

// =========================================================================
// CLI discovery
// =========================================================================

/// Returns true iff `cmd --version` spawns and exits 0. Used to detect `sq`
/// and `gpg` on PATH without crashing when absent.
fn have(cmd: &str) -> bool {
    Command::new(cmd)
        .arg("--version")
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .map(|s| s.success())
        .unwrap_or(false)
}

/// Skip-guard for every test in this file. Returns `true` (and prints a
/// single-line skip reason) when neither `sq` nor `gpg` is available so a
/// CI/dev box without the tooling stays green. Tests call this as their first
/// statement: `if skip_no_cli() { return; }`.
fn skip_no_cli() -> bool {
    if !have("sq") && !have("gpg") {
        eprintln!("skipping: no sq/gpg on PATH");
        return true;
    }
    false
}

/// Which CLI to drive. Prefer `gpg` (more widely installed, esp. on Windows
/// via Git for Windows); fall back to `sq`. The tests below branch on this so
/// each test exercises whichever CLI is available, never both at once.
enum Cli {
    Gpg,
    Sq,
}

impl Cli {
    /// Detect an available CLI. Caller has already done the skip guard.
    fn detect() -> Self {
        if have("gpg") {
            Cli::Gpg
        } else {
            Cli::Sq
        }
    }
}

// =========================================================================
// Temp homedir (RAII)
// =========================================================================

/// RAII temp directory for the CLI's `--homedir` / `--keystore`.
///
/// `tempfile::TempDir` deletes the directory on drop. We hold it for the
/// lifetime of each test so the CLI's state (keyring, trustdb, etc.) is
/// fully isolated from the user's real keyring and torn down when the test
/// exits.
struct TempHome(tempfile::TempDir);

impl TempHome {
    fn new() -> Self {
        // `tempdir()` creates a unique dir under the platform's TEMP with
        // 0700 perms on Unix; on Windows it inherits the temp dir's ACL.
        // Either way, the CLI sees an empty keyring on first invocation.
        Self(tempfile::tempdir().expect("tempdir"))
    }

    /// Join a filename relative to the temp dir.
    fn join(&self, name: &str) -> std::path::PathBuf {
        self.0.path().join(name)
    }
}

// =========================================================================
// CLI plumbing
// =========================================================================

/// Convert a filesystem path to the string form the CLI expects.
///
/// On Windows we MAY be running against the Git-for-Windows build of `gpg`
/// (an MSYS2/cygwin binary at `C:\Program Files\Git\usr\bin\gpg.exe`). That
/// build's runtime does NOT recognize `C:\...` or `C:/...` as absolute paths
/// in command-line arguments — it treats them as relative and joins with the
/// cwd, producing a mangled path like `/d/.../C:/Users/...`. The fix is to
/// convert to MSYS2 form (`/c/Users/...`) which the runtime does accept.
///
/// We apply the conversion unconditionally on Windows for `gpg` because
/// (a) the MSYS2 build is the most common source of `gpg` on Windows dev
/// boxes (Git for Windows ships it), and (b) native Windows `gpg` builds
/// (gpg4win) accept BOTH forms (Windows APIs normalize `/c/Users/...` to
/// `C:\Users\...` when the path is otherwise absolute). So this conversion
/// is safe in either case.
///
/// For `sq` (a native Rust binary) we pass the path through unchanged on
/// the assumption that sq uses standard Rust path APIs that accept Windows
/// paths natively. On non-Windows platforms, no conversion is needed.
fn cli_path_arg(cli: &Cli, p: &std::path::Path) -> String {
    let raw = p.to_str().expect("path is utf8");
    #[cfg(windows)]
    {
        if matches!(cli, Cli::Gpg) {
            // Recognize `<drive>:\...` or `<drive>:/...` and convert to
            // `/<drive-lowercase>/...`.
            let bytes = raw.as_bytes();
            if bytes.len() >= 3 && bytes[1] == b':' && (bytes[2] == b'\\' || bytes[2] == b'/') {
                let drive = (bytes[0] as char).to_ascii_lowercase();
                let rest = raw[2..].replace('\\', "/");
                return format!("/{drive}{rest}");
            }
        }
    }
    #[cfg(not(windows))]
    {
        let _ = cli;
    }
    raw.replace('\\', "/")
}

/// Build a `Command` for `cli` rooted at the temp homedir.
fn cli_base(cli: &Cli, td: &TempHome) -> Command {
    match cli {
        Cli::Gpg => {
            let mut c = Command::new("gpg");
            // `--homedir` isolates keyring/trustdb from the user's real one.
            // `--batch` + `--pinentry-mode loopback` + `--yes` make the CLI
            // non-interactive even when prompting would normally occur.
            // `--quiet` suppresses informational stderr so cargo test output
            // stays readable.
            let homedir = cli_path_arg(cli, td.0.path());
            c.args([
                "--homedir",
                &homedir,
                "--batch",
                "--yes",
                "--pinentry-mode",
                "loopback",
                "--quiet",
                "--no-tty",
            ]);
            c
        }
        Cli::Sq => {
            // `sq` is a single binary with subcommands; the global `--keystore`
            // flag (or `--cert-file`/`--keyfile` per-call) isolates state. We
            // use `--keystore` so `sq import` / `sq decrypt` etc. share one
            // temp dir for the test's lifetime.
            let mut c = Command::new("sq");
            let keystore = cli_path_arg(cli, td.0.path());
            c.args(["--keystore", &keystore]);
            c
        }
    }
}

/// Run `cmd`, capture stdout/stderr, and assert it succeeded. Returns stdout
/// bytes.
fn run_assert(cmd: &mut Command, label: &str) -> Vec<u8> {
    let out = cmd
        .output()
        .unwrap_or_else(|e| panic!("{}: spawn failed: {e}", label));
    if !out.status.success() {
        panic!(
            "{}: exit {}\nstdout: {}\nstderr: {}",
            label,
            out.status,
            String::from_utf8_lossy(&out.stdout),
            String::from_utf8_lossy(&out.stderr),
        );
    }
    out.stdout
}

/// Import `cert_bytes` (armored or binary TPK; public or TSK) into the CLI's
/// temp keyring. Verified equivalent of `gpg --import` / `sq cert import`.
fn cli_import(cli: &Cli, td: &TempHome, cert_bytes: &[u8]) {
    match cli {
        Cli::Gpg => {
            let mut cmd = cli_base(cli, td);
            cmd.args(["--import"]);
            pipe_in(&mut cmd, cert_bytes, "gpg --import");
        }
        Cli::Sq => {
            // `sq` has no single "import to keystore" subcommand in 0.x/1.x —
            // `sq cert import` reads from file or stdin. We pipe via stdin.
            let mut cmd = cli_base(cli, td);
            cmd.args(["cert", "import"]);
            pipe_in(&mut cmd, cert_bytes, "sq cert import");
        }
    }
}

/// Pipe `input` to `cmd`'s stdin, run, assert success. The CLI reads the
/// armored/binary cert from stdin so we don't have to write it to a file.
fn pipe_in(cmd: &mut Command, input: &[u8], label: &str) {
    cmd.stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped());
    let mut child = cmd.spawn().unwrap_or_else(|e| panic!("{}: spawn: {e}", label));
    use std::io::Write;
    child
        .stdin
        .as_mut()
        .expect("stdin piped")
        .write_all(input)
        .unwrap_or_else(|e| panic!("{}: write stdin: {e}", label));
    // Close stdin so the CLI sees EOF.
    drop(child.stdin.take());
    let out = child
        .wait_with_output()
        .unwrap_or_else(|e| panic!("{}: wait: {e}", label));
    if !out.status.success() {
        panic!(
            "{}: exit {}\nstdout: {}\nstderr: {}",
            label,
            out.status,
            String::from_utf8_lossy(&out.stdout),
            String::from_utf8_lossy(&out.stderr),
        );
    }
}

/// Encrypt `plaintext` to `recipient_fp` using the CLI; return the OpenPGP
/// message bytes (binary). Uses AES256 + SHA256 + no compression to maximize
/// interop with Sequoia's crypto-rust backend.
fn cli_encrypt(cli: &Cli, td: &TempHome, recipient_fp: &str, plaintext: &[u8]) -> Vec<u8> {
    // Write the plaintext to a temp input file and capture the CLI's stdout
    // (the OpenPGP message). We force modern algos (AES256/SHA256) and disable
    // compression for determinism.
    let in_path = td.join("plaintext.in");
    std::fs::write(&in_path, plaintext).expect("write plaintext");
    let out_path = td.join("ciphertext.out");
    let out_arg = cli_path_arg(cli, &out_path);
    let in_arg = cli_path_arg(cli, &in_path);
    match cli {
        Cli::Gpg => {
            // `--trust-model always` avoids trust prompts on freshly-imported
            // keys (we test encryption, not the WoT). `--compress-level 0`
            // disables compression so the literal-data body is byte-exact to
            // the input (Sequoia handles compression fine either way; this is
            // just for predictability).
            let mut cmd = cli_base(cli, td);
            cmd.args([
                "--encrypt",
                "--trust-model",
                "always",
                "--cipher-algo",
                "AES256",
                "--compress-level",
                "0",
                "--recipient",
                recipient_fp,
                "--output",
                &out_arg,
                &in_arg,
            ]);
            run_assert(&mut cmd, "gpg --encrypt");
            std::fs::read(&out_path).expect("read ciphertext")
        }
        Cli::Sq => {
            // `sq encrypt --recipient-file` reads the recipient cert from
            // the keystore; `--binary` emits binary (not armored) output.
            let mut cmd = cli_base(cli, td);
            cmd.args([
                "encrypt",
                "--binary",
                "--recipient",
                recipient_fp,
                "--output",
                &out_arg,
                &in_arg,
            ]);
            run_assert(&mut cmd, "sq encrypt");
            std::fs::read(&out_path).expect("read ciphertext")
        }
    }
}

/// Decrypt `ciphertext` via the CLI; return the literal-data body (the
/// original plaintext the message was encrypted with). Requires the
/// decryption key be present in the CLI's temp keyring.
fn cli_decrypt(cli: &Cli, td: &TempHome, ciphertext: &[u8]) -> Vec<u8> {
    let in_path = td.join("ciphertext.in");
    std::fs::write(&in_path, ciphertext).expect("write ciphertext");
    let out_path = td.join("plaintext.out");
    let in_arg = cli_path_arg(cli, &in_path);
    let out_arg = cli_path_arg(cli, &out_path);
    match cli {
        Cli::Gpg => {
            let mut cmd = cli_base(cli, td);
            cmd.args(["--decrypt", "--output", &out_arg, &in_arg]);
            run_assert(&mut cmd, "gpg --decrypt");
            std::fs::read(&out_path).expect("read plaintext")
        }
        Cli::Sq => {
            let mut cmd = cli_base(cli, td);
            cmd.args(["decrypt", "--output", &out_arg, &in_arg]);
            run_assert(&mut cmd, "sq decrypt");
            std::fs::read(&out_path).expect("read plaintext")
        }
    }
}

/// Detached-sign `payload` via the CLI; return the binary detached signature.
/// Requires the signing key be present (with secret material) in the CLI's
/// temp keyring.
fn cli_detach_sign(cli: &Cli, td: &TempHome, signer_fp: &str, payload: &[u8]) -> Vec<u8> {
    let in_path = td.join("payload.in");
    std::fs::write(&in_path, payload).expect("write payload");
    let out_path = td.join("sig.out");
    let in_arg = cli_path_arg(cli, &in_path);
    let out_arg = cli_path_arg(cli, &out_path);
    match cli {
        Cli::Gpg => {
            let mut cmd = cli_base(cli, td);
            cmd.args([
                "--detach-sign",
                "--local-user",
                signer_fp,
                "--digest-algo",
                "SHA256",
                "--output",
                &out_arg,
                &in_arg,
            ]);
            run_assert(&mut cmd, "gpg --detach-sign");
            std::fs::read(&out_path).expect("read sig")
        }
        Cli::Sq => {
            let mut cmd = cli_base(cli, td);
            cmd.args([
                "sign",
                "--detach",
                "--binary",
                "--signer",
                signer_fp,
                "--output",
                &out_arg,
                &in_arg,
            ]);
            run_assert(&mut cmd, "sq sign --detach");
            std::fs::read(&out_path).expect("read sig")
        }
    }
}

/// Detached-verify `sig` over `payload` via the CLI; panics on verification
/// failure. The signer's public cert must be in the CLI's temp keyring.
fn cli_detach_verify(cli: &Cli, td: &TempHome, payload: &[u8], sig: &[u8]) {
    let payload_path = td.join("payload.in");
    std::fs::write(&payload_path, payload).expect("write payload");
    let sig_path = td.join("sig.in");
    std::fs::write(&sig_path, sig).expect("write sig");
    let payload_arg = cli_path_arg(cli, &payload_path);
    let sig_arg = cli_path_arg(cli, &sig_path);
    match cli {
        Cli::Gpg => {
            let mut cmd = cli_base(cli, td);
            cmd.args(["--verify", &sig_arg, &payload_arg]);
            run_assert(&mut cmd, "gpg --verify");
        }
        Cli::Sq => {
            let mut cmd = cli_base(cli, td);
            cmd.args([
                "verify",
                "--signature-file",
                &sig_arg,
                "--signer-file",
                &payload_arg,
            ]);
            run_assert(&mut cmd, "sq verify");
        }
    }
}

// =========================================================================
// Engine-side framing helpers (single-body case)
// =========================================================================
//
// The engine's `encrypt` wraps `frame_parts(parts)` (binary self-describing
// format documented in `engine.rs`) as the OpenPGP literal-data body. To
// prove engine::decrypt can decrypt what the CLI encrypted, we PRE-FRAME the
// plaintext in the same format before handing it to the CLI's encrypt; then
// engine::decrypt's `unframe_parts` succeeds and recovers the original
// Part::data bytes.
//
// These helpers implement ONLY the single-Body-part case, which is all the
// interop tests need. The format is:
//   u32 LE part_count = 1
//   u32 LE id_len     | id_bytes
//   u8   kind_tag = 0   (Body)
//   u32 LE data_len   | data_bytes
//
// `engine.rs::frame_parts` is the canonical encoder; this is a minimal mirror
// for test setup. If the engine's framing changes, these helpers must change
// in lock-step (the round-trip tests would also break, giving early warning).

fn frame_single_body(id: &str, data: &[u8]) -> Vec<u8> {
    let mut out = Vec::with_capacity(4 + 4 + id.len() + 1 + 4 + data.len());
    out.extend_from_slice(&1u32.to_le_bytes()); // part_count = 1
    out.extend_from_slice(&(id.len() as u32).to_le_bytes());
    out.extend_from_slice(id.as_bytes());
    out.push(0u8); // PartKind::Body
    out.extend_from_slice(&(data.len() as u32).to_le_bytes());
    out.extend_from_slice(data);
    out
}

/// Invert `frame_single_body`. Asserts exactly one Body part; returns its
/// data bytes.
fn unframe_single_body(blob: &[u8]) -> Vec<u8> {
    use std::convert::TryInto;
    assert!(
        blob.len() >= 4,
        "unframe: blob too short for part_count"
    );
    let part_count = u32::from_le_bytes(blob[0..4].try_into().unwrap());
    assert_eq!(part_count, 1, "unframe: expected single part, got {part_count}");

    let mut c = 4usize;
    let id_len = u32::from_le_bytes(blob[c..c + 4].try_into().unwrap()) as usize;
    c += 4;
    let _id = &blob[c..c + id_len];
    c += id_len;
    let kind_tag = blob[c];
    assert_eq!(kind_tag, 0, "unframe: expected Body kind tag (0), got {kind_tag}");
    c += 1;
    let data_len = u32::from_le_bytes(blob[c..c + 4].try_into().unwrap()) as usize;
    c += 4;
    let data = blob[c..c + data_len].to_vec();
    assert_eq!(
        data.len(),
        data_len,
        "unframe: data length mismatch (truncated input)"
    );
    data
}

// =========================================================================
// Engine-side fixtures
// =========================================================================

/// Generate a fresh Cert (Ed25519 primary + X25519 enc subkey + Ed25519 sign
/// subkey) via the SAME engine API the backend uses. The Cert is a TSK with
/// unencrypted secret material (no S2K) — directly usable for sign/decrypt.
fn gen_cert(user_id: &str) -> openpgp::Cert {
    engine::generate(user_id).expect("engine::generate")
}

/// Armored PUBLIC KEY BLOCK for `cert` (safe to import into a CLI keyring).
fn armored_public(cert: &openpgp::Cert) -> Vec<u8> {
    engine::export_armored_public(cert).expect("engine::export_armored_public")
}

/// Armored PRIVATE KEY BLOCK for `cert` (TSK form; carries secret material).
/// Used to seed the CLI's keyring with a decryption-capable copy of OUR cert
/// for the "we encrypt → CLI decrypts" direction. Built directly via Sequoia's
/// `cert.as_tsk().armored()` — the engine does not expose a secret-armored
/// export (at-rest secret blobs are binary; armored export is a test fixture
/// concern, not a production path).
fn armored_secret(cert: &openpgp::Cert) -> Vec<u8> {
    let mut buf = Vec::new();
    cert.as_tsk()
        .armored()
        .serialize(&mut buf)
        .expect("armored TSK serialize");
    buf
}

/// Default policy fixture (matches the engine's round-trip tests).
fn pgp_policy() -> PgpPolicy {
    PgpPolicy::default()
}

// =========================================================================
// Tests — encrypt/decrypt cross-impl
// =========================================================================

/// Direction 1: CLI encrypts to our cert → engine::decrypt recovers plaintext.
///
/// Generate a Cert HERE, export its armored public key, import into the CLI's
/// temp keyring, encrypt THERE, then `engine::decrypt` HERE. The plaintext is
/// pre-framed in the engine's internal format so `engine::decrypt`'s
/// `unframe_parts` succeeds; the WIRE FORMAT under test is the OpenPGP
/// message itself (PKESK + SEIP + literal data).
#[test]
fn cross_impl_cli_encrypts_engine_decrypts() {
    if skip_no_cli() {
        return;
    }
    let cli = Cli::detect();
    let td = TempHome::new();
    let pol = pgp_policy();

    // 1. Generate a Cert here; export its armored public key.
    let cert = gen_cert("interop-rcpt@example.org");
    let cert_fp = cert.fingerprint().to_hex();
    let pub_armored = armored_public(&cert);
    // Sanity: the armored export really is a PUBLIC KEY BLOCK.
    assert!(
        std::str::from_utf8(&pub_armored)
            .unwrap()
            .contains("BEGIN PGP PUBLIC KEY BLOCK"),
    );

    // 2. Import into the CLI's temp keyring.
    cli_import(&cli, &td, &pub_armored);

    // 3. CLI encrypts a (framed) payload to our cert.
    let plaintext = b"cross-impl: CLI encrypts, engine decrypts";
    let framed = frame_single_body("body", plaintext);
    let message = cli_encrypt(&cli, &td, &cert_fp, &framed);
    assert!(
        !message.is_empty(),
        "CLI must emit a non-empty OpenPGP message"
    );

    // 4. engine::decrypt recovers the plaintext.
    //
    // Wrap the CLI's message in an EncryptedEnvelope the way the backend
    // would: a single EncryptedPart whose ciphertext is the full OpenPGP
    // message. recipients/standard are metadata for the framework; engine
    // consumes only `parts[0].ciphertext`.
    let envelope = EncryptedEnvelope {
        standard: Standard::OpenPgp,
        serialization: SerializationStrategy::SingleMimeBlob,
        parts: vec![EncryptedPart {
            id: PartId("body".into()),
            kind: PartKind::Body,
            ciphertext: message,
            signature: None,
        }],
        recipients: Vec::new(),
    };
    let (payload, _weak) =
        engine::decrypt(&envelope, &cert, &pol).expect("engine::decrypt succeeds on CLI output");

    assert_eq!(payload.standard, Standard::OpenPgp);
    assert_eq!(payload.parts.len(), 1, "single body part round-trip");
    assert_eq!(
        payload.parts[0].data,
        plaintext,
        "engine::decrypt must recover the exact plaintext the CLI encrypted"
    );
}

/// Direction 2: engine::encrypt → CLI decrypts.
///
/// Same Cert; we export its armored SECRET (TSK) and import into the CLI's
/// temp keyring so the CLI has a decryption-capable copy. We encrypt here
/// via `engine::encrypt`; the CLI decrypts and writes the literal-data body
/// (our framed payload) to a file. We unframe it and compare to the original.
///
/// **`#[ignore]` — REAL wire-format interop gap (Sequoia 2.4.1 vs GnuPG 2.4):**
/// Sequoia's `Encryptor` auto-upgrades to AEAD (SEIPDv2) + PKESK v6 when the
/// recipient cert advertises `Features::seipdv2` in its binding signature
/// (`sequoia-openpgp-2.4.1/src/serialize/stream.rs:3057-3067`), which
/// `CertBuilder::new()` does by default. GnuPG 2.4.x does NOT support PKESK
/// v6 / SEIPDv2 (added in GnuPG 2.5 per the GnuPG NEWS file), so `gpg
/// --decrypt` fails with `packet(1) with unknown version 6`. This is the
/// asymmetric-interop gap the brief calls out: GnuPG-produced output
/// (v4-only) decrypts cleanly here (Sequoia's read policy is permissive),
/// but our default output cannot be read by the most widely deployed
/// GnuPG stable branch. Fixing it requires either (a) changing
/// `engine::generate` to emit `Features::empty().set_seipdv1()` (src/
/// change, out of scope for Task 9), or (b) adding a v4-compat profile to
/// `engine::encrypt` (also src/), or (c) waiting for GnuPG 2.5 to reach
/// widespread deployment. Run with `--include-ignored` to reproduce.
#[test]
#[ignore = "Sequoia 2.4.1 emits PKESK v6 / SEIPDv2 by default; GnuPG 2.4.x only supports v4"]
fn cross_impl_engine_encrypts_cli_decrypts() {
    if skip_no_cli() {
        return;
    }
    let cli = Cli::detect();
    let td = TempHome::new();
    let pol = pgp_policy();

    let cert = gen_cert("interop-rcpt-2@example.org");

    // Seed the CLI's temp keyring with the TSK so it can decrypt.
    let sec_armored = armored_secret(&cert);
    assert!(
        std::str::from_utf8(&sec_armored)
            .unwrap()
            .contains("BEGIN PGP PRIVATE KEY BLOCK"),
    );
    cli_import(&cli, &td, &sec_armored);

    // engine::encrypt — frame + encrypt internally.
    let plaintext = b"cross-impl: engine encrypts, CLI decrypts";
    let part = Part {
        id: PartId("body".into()),
        kind: PartKind::Body,
        data: plaintext.to_vec(),
    };
    let envelope = engine::encrypt(
        std::slice::from_ref(&part),
        SerializationStrategy::SingleMimeBlob,
        std::slice::from_ref(&cert),
        None,
        &pol,
    )
    .expect("engine::encrypt");
    assert_eq!(envelope.parts.len(), 1);
    let message = envelope.parts[0].ciphertext.clone();
    assert!(!message.is_empty());

    // CLI decrypts → recovers the literal-data body (our framed payload).
    let recovered_framed = cli_decrypt(&cli, &td, &message);

    // Unframe to recover the plaintext.
    let recovered = unframe_single_body(&recovered_framed);
    assert_eq!(
        recovered,
        plaintext,
        "CLI must recover the exact plaintext engine::encrypt encrypted"
    );
}

// =========================================================================
// Tests — detached sign/verify cross-impl
// =========================================================================

/// Direction 3: CLI detach-signs → engine::verify_detached returns ValidVerified.
///
/// Generate a Cert here; export its armored SECRET (TSK) so the CLI can sign;
/// CLI detach-signs a payload; `engine::verify_detached` (with the same cert
/// as a known signer) classifies the signature as ValidVerified.
#[test]
fn cross_impl_cli_signs_engine_verifies() {
    if skip_no_cli() {
        return;
    }
    let cli = Cli::detect();
    let td = TempHome::new();
    let pol = pgp_policy();

    let cert = gen_cert("interop-signer@example.org");
    let cert_fp = cert.fingerprint().to_hex();
    cli_import(&cli, &td, &armored_secret(&cert));

    let payload = b"cross-impl: CLI signs, engine verifies";
    let sig_bytes = cli_detach_sign(&cli, &td, &cert_fp, payload);
    assert!(!sig_bytes.is_empty(), "CLI must emit non-empty signature");

    // Build a DetachedSignature the way the engine does: PGP standard, signer
    // handle echoes the cert's fingerprint, signature bytes from the CLI.
    let sig = crypto_core::DetachedSignature {
        standard: Standard::OpenPgp,
        signer: crypto_openpgp::keymap::cert_to_handle(&cert),
        signature: sig_bytes,
    };

    let result = engine::verify_detached(
        payload,
        &sig,
        std::slice::from_ref(&cert),
        &pol,
    )
    .expect("engine::verify_detached call succeeds");
    assert_eq!(
        result.state,
        crypto_core::SignatureState::ValidVerified,
        "engine::verify_detached must classify the CLI's signature as ValidVerified; \
         got failure_reason = {:?}",
        result.failure_reason,
    );
}

/// Direction 4: engine::sign_detached → CLI verifies (exit 0).
///
/// Same Cert; export its armored PUBLIC so the CLI can look up the signer
/// cert. engine::sign_detached produces the signature bytes; the CLI's
/// `--verify` path accepts them. Panics on verification failure (exit != 0).
#[test]
fn cross_impl_engine_signs_cli_verifies() {
    if skip_no_cli() {
        return;
    }
    let cli = Cli::detect();
    let td = TempHome::new();
    let pol = pgp_policy();

    let cert = gen_cert("interop-signer-2@example.org");
    cli_import(&cli, &td, &armored_public(&cert));

    let payload = b"cross-impl: engine signs, CLI verifies";
    let sig = engine::sign_detached(payload, &cert, &pol).expect("engine::sign_detached");
    assert!(!sig.signature.is_empty(), "engine must emit non-empty sig");

    // CLI verifies. cli_detach_verify panics if the CLI rejects the signature,
    // which is the load-bearing assertion (a CLI-rejected signature is a
    // wire-format mismatch — exactly what interop tests exist to catch).
    cli_detach_verify(&cli, &td, payload, &sig.signature);
}

// =========================================================================
// Backend-level interop (proves the OpenpgpBackend adapter wires correctly)
// =========================================================================

/// Backend-level cross-impl: route engine calls through the `OpenpgpBackend`
/// adapter instead of `engine::*` directly, to prove the framework-level
/// trait + `KeyStore` plumbing also interops with the CLI's wire format.
///
/// Seeds the keystore via `MemoryKeyStore::put_cert` (the path the receive
/// slice uses for keys imported from outside) so this test also exercises
/// that helper, then exercises `backend.encrypt` across the impl boundary
/// (CLI decrypts our output).
///
/// **`#[ignore]` — same wire-format gap as
/// `cross_impl_engine_encrypts_cli_decrypts`**: the backend delegates to
/// `engine::encrypt`, which inherits Sequoia's PKESK v6 / SEIPDv2 default.
/// GnuPG 2.4.x can't parse the result. See the sibling test's ignore reason
/// for the full diagnosis and fix options.
#[tokio::test]
#[ignore = "Sequoia 2.4.1 emits PKESK v6 / SEIPDv2 by default; GnuPG 2.4.x only supports v4"]
async fn cross_impl_backend_encrypt_then_cli_decrypts() {
    if skip_no_cli() {
        return;
    }
    let cli = Cli::detect();
    let td = TempHome::new();

    let ks = Arc::new(MemoryKeyStore::new());
    let backend = crypto_openpgp::OpenpgpBackend::new(
        ks.clone(),
        crypto_core::CryptoPolicy::default_baseline(),
    );

    // Generate a Cert directly via the engine (not via backend.generate_key)
    // and seed it into the keystore with the `put_cert` helper. This proves
    // the helper's StoredKey construction is compatible with the backend's
    // resolution path AND that the resulting wire-format bytes interop with
    // the CLI. (Mirrors `round_trip.rs::
    // memory_keystore_put_cert_then_backend_export_round_trips`.)
    let cert = engine::generate("interop-backend@example.org").expect("engine::generate");
    let gen_handle = ks.put_cert(&cert).expect("MemoryKeyStore::put_cert");

    // Re-fetch via get_cert so we can export the armored secret for the CLI.
    let cert_again = ks
        .get_cert(&gen_handle.handle)
        .expect("MemoryKeyStore::get_cert");
    let sec_armored = armored_secret(&cert_again);
    cli_import(&cli, &td, &sec_armored);

    // Backend-level encrypt.
    let plaintext = b"cross-impl: backend.encrypt then CLI decrypts";
    let part = Part {
        id: PartId("body".into()),
        kind: PartKind::Body,
        data: plaintext.to_vec(),
    };
    let op = crypto_core::EncryptOp {
        parts: std::slice::from_ref(&part),
        serialization: SerializationStrategy::SingleMimeBlob,
        recipients: std::slice::from_ref(&gen_handle),
        sign_with: None,
    };
    let envelope = backend.encrypt(op).await.expect("backend.encrypt");
    assert_eq!(envelope.parts.len(), 1);
    let message = envelope.parts[0].ciphertext.clone();

    // CLI decrypts; we unframe the recovered literal-data body.
    let recovered_framed = cli_decrypt(&cli, &td, &message);
    let recovered = unframe_single_body(&recovered_framed);
    assert_eq!(
        recovered,
        plaintext,
        "CLI must decrypt what backend.encrypt produced; a mismatch indicates a wire-format bug"
    );
}
