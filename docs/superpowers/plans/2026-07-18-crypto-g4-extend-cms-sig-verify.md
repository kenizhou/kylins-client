# Crypto G4-extend — CMS Signature Verify: RSA-PKCS1v1.5 + RSA-PSS + ECDSA-P384

> **Status:** Approved (2026-07-18). Carry-forward from Phase 1b Plan 5 / G7
> final review (`progress.md` line 261): "RSA CMS sig verify (G4-extend
> carry-forward — wiring rsa/p384 into verify_signed for RSA-signed Thunderbird
> mail, common in enterprise)".
> **Parent spec:** `docs/superpowers/specs/2026-07-12-crypto-phase1b-smime-receive-design.md`
> decision #10 (algorithm coverage). **Crate:** `kylins.client.crypto/smime`.
> **Track:** Security/Crypto. Strict SDD, single-task.

## Goal

Extend the CMS pre-chain signature verifier (`cms_parse::verify_signed`) from
ECDSA-P256-only to the full algorithm set of spec decision #10 (minus P-521 /
Ed25519, which remain deferred). This closes the G4-extend carry-forward: an
incoming RSA-signed or P-384-signed Thunderbird message currently returns
`sig_ok=false` → `SignatureState::Invalid`, even though the cert-chain
validator (`chain.rs`, G4) already handles RSA-PSS + P-384. Receive-side only;
the build side (`cms_build.rs`) still emits ECDSA-P256 (our own signed mail is
unaffected — this is about *verifying others' mail*).

## Background (verified against current code)

- `cms_parse.rs:554 verify_signed` → `verify_ecdsa_p256_signature` (line 845)
  hard-guards `digest_alg.oid != ID_SHA_256 || sig_alg.oid != ID_ECDSA_WITH_SHA_256`
  → returns `sig_ok=false` for everything else.
- The messageDigest check (line 621) hardcodes `sha2::Sha256::digest`.
- `chain.rs` already parses RSA-PSS params (`verify_rsa_pss` / `rsa_pss_hash_oid`,
  lines 716-773) but on the pkix `SignatureVerifier` trait (spki 0.7 line, for
  cert-chain). The CMS pre-chain path is separate (spki 0.8 / der 0.8 line).
- `rsa v0.10.0-rc.18` → `pkcs1 v0.8.0-rc.4` (our 0.8 line) is already in the
  dep graph transitively; add `pkcs1 = "0.8"` as a direct dep to name
  `pkcs1::RsaPssParams` for PSS-param parsing (no new resolved version).
- `p384 v0.14`, `rsa v0.10` already direct deps.
- A `#[ignore]`d interop test exists: `interop_tests::openssl_sign_rsa_verifies_with_our_code`
  (`interop_tests.rs:385`) — written to pass once RSA verify lands; uses
  `openssl cms -sign` (default = RSA-PKCS1v1.5 + SHA-256).

## Design

### Dispatch in `verify_signed`

Replace the call to `verify_ecdsa_p256_signature` with a general
`verify_signer_signature(cert, signed_attrs_der, signature, digest_alg, sig_alg) -> Result<bool>`
that dispatches on `sig_alg.oid` (+ the SPKI curve OID for ECDSA):

| `sig_alg.oid` | algorithm | key source | hash source |
|---|---|---|---|
| `ecdsa-with-SHA256` (1.2.840.10045.4.3.2) | ECDSA P-256 | SPKI curve OID = P-256 | digest_alg (SHA-256) |
| `ecdsa-with-SHA384` (1.2.840.10045.4.3.3) | ECDSA P-384 | SPKI curve OID = P-384 | digest_alg (SHA-384) |
| `sha256WithRSAEncryption` (1.2.840.113549.1.1.11) | RSA-PKCS1v1.5 | SPKI RSA pub key | digest_alg (SHA-256) |
| `sha384WithRSAEncryption` (1.2.840.113549.1.1.12) | RSA-PKCS1v1.5 | SPKI RSA pub key | digest_alg (SHA-384) |
| `sha512WithRSAEncryption` (1.2.840.113549.1.1.13) | RSA-PKCS1v1.5 | SPKI RSA pub key | digest_alg (SHA-512) |
| `id-RSASSA-PSS` (1.2.840.113549.1.1.10) | RSA-PSS | SPKI RSA pub key | PSS-params `hashAlgorithm` (SHA-256/384/512) |
| anything else | unsupported → `Ok(false)` (sig_ok=false, NOT a hard error) |

For ECDSA, dispatch on the SPKI curve (not the sig-alg OID) so a P-384 key
signing with `ecdsa-with-SHA256` (legal) still works — match the curve in the
SPKI `parameters` and pick `p256`/`p384`. The hash comes from `digest_alg.oid`
(SHA-256/384/512).

### messageDigest dispatch

Generalize the content-digest computation to dispatch on
`signer_info.digest_alg.oid` (SHA-256 / SHA-384 / SHA-512). Unsupported digest
→ early-return `sig_ok=false` (same "unknown algorithm = sig_ok=false" contract
as the sig dispatch, not a hard `Malformed`). This is required because
ECDSA-P384 mail carries a SHA-384 messageDigest attribute, and RSA-SHA-384 /
SHA-512 mail carries the corresponding digest.

### RSA-PSS param parsing

Reuse the `chain.rs` pattern but on the 0.8 line:
`sig_alg.parameters.decode_as::<pkcs1::RsaPssParams>()` → `.hash.oid` → pick
`rsa::pss::VerifyingKey::<Sha256|Sha384|Sha512>`. SHA-1 in PSS params →
`Ok(false)` (security: SHA-1 sig is broken; do not verify). Soft handling
mirrors the cert-chain path.

### Build-side

Unchanged. `cms_build.rs` continues to emit ECDSA-P256 only. RSA/P-384/PSS
*signing* is a separate future task (low value — we sign with our generated
P-256 key). Tests build RSA/P-384/PSS SignedData via the cms builder directly
(mirroring `build_signed_data_with_signing_time`).

## Data

No schema change. No migration. Pure crypto-smime crate change + tests.

## Failure modes

- Unsupported algorithm → `sig_ok=false` → backend maps to `SignatureState::Invalid`
  (the existing contract). No new error paths; `Err` stays reserved for malformed
  CMS DER / invariant violations.
- RSA-PSS SHA-1 → `sig_ok=false` (do not verify a SHA-1 signature).
- Parse failure of PSS params → `Malformed` (broken CMS, not a sig verdict).

## Security

- Verify-only change; no new secrets, no new IPC, no new SQL, no new HTML.
- SHA-1 PSS is rejected (not silently verified).
- Private material untouched (this path only reads public cert SPKIs).
- All algorithm dispatch is fail-closed: unknown → `sig_ok=false` → `Invalid`.

## Performance

Pre-chain verify runs once per message-open (Stage B body fetch). RSA verify is
µs-scale; no caching concern. No UI-thread impact (runs in the Rust receive
orchestrator).

## Tests (TDD)

Unit round-trips in `cms_parse.rs` tests (no openssl needed):
1. `verify_round_trips_rsa_pkcs1v15_signed_data` — RSA-PKCS1v1.5 + SHA-256.
2. `verify_round_trips_p384_signed_data` — ECDSA-P384 + SHA-384.
3. `verify_round_trips_rsa_pss_signed_data` — RSA-PSS + SHA-256.
4. `verify_unsupported_algorithm_yields_sig_ok_false` — e.g. Ed25519 sig alg →
   `sig_ok=false` (not `Err`).
5. `verify_message_digest_dispatches_on_digest_alg` — P-384/SHA-384 messageDigest
   attribute matches (implicit in #2).

Interop (un-ignore):
6. Un-ignore `interop_tests::openssl_sign_rsa_verifies_with_our_code` (RSA-PKCS1v1.5).
   Add a sibling `openssl_sign_rsa_pss_verifies_with_our_code` (openssl `-keyopt
   rsa_pss_sign` or `-md` PSS) — `#[ignore]` until openssl-on-PATH CI is wired,
   mirroring the existing skip convention.

## Gates

`cd kylins.client.crypto && cargo test -p crypto-smime` + `cargo test -p
crypto-smime --all-targets` + `cargo clippy -p crypto-smime --all-targets -- -D
warnings`; backend `cargo test --lib` (no surface change but rebuilds the dep).
Frontend untouched.

## Out of scope (documented carry-forwards)

- RSA/P-384/PSS **signing** on the build side (low value; we sign P-256).
- P-521 + Ed25519 CMS sig verify (spec #10 deferred — negligible in deployed S/MIME).
- RSA-PSS saltLength validation beyond what `rsa::pss::VerifyingKey` enforces.
- Bundled S/MIME CA root program; PGP / Phase 2; `.p12` import.
