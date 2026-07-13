# Crypto Phase 1b Plan 2 — S/MIME Cert-Chain Validation + CRL (G4) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn `SmimeBackend::verify`'s pre-chain `ValidUnverified` (from Plan 1) into a real RFC 5280 cert-chain validation result, with CA/B Forum S/MIME BR policy enforcement, `From:`↔SAN identity binding, RSA-PSS + ECDSA-P384 signature coverage, and CRL revocation (hard-fail-on-revoked / soft-fail-on-transport), feeding the 5-rung `TrustState` ladder → final `SignatureState`.

**Architecture:** This is **Phase 1b Plan 2** (the spec's G4). It builds on Plan 1's `cms_parse::verify_signed` (the cryptographic signature check) and refines its `ValidUnverified` outcome into `ValidVerified`/`Invalid` via cert-chain validation. Engine = the `pkix-*` family (`pkix-chain` 0.4.x + `pkix-profiles-cabf::SmimeProfile` + `pkix-identity` + `pkix-revocation`) on our existing `x509-cert 0.3` types, with a custom `SignatureVerifier` adding the RSA-PSS + P-384 gaps. CRL via a `reqwest` fetcher + the Plan-1 `crl_cache` table. OCSP is deliberately skipped (deprecated; no turnkey Rust client — spec §0.4).

**Tech Stack:** Rust; `crypto-smime` + `crypto-core` (path crates); NEW deps `pkix-chain`, `pkix-profiles-cabf`, `pkix-identity`, `pkix-revocation`, `p384` (Task 1 pins exact versions); existing `x509-cert 0.3`, `der 0.8`, `spki 0.8`, `p256 0.14`, `rsa 0.10.0-rc.18`, `sha2 0.11`. Backend `reqwest` (already present) for CRL fetch. Spec: `docs/superpowers/specs/2026-07-12-crypto-phase1b-smime-receive-design.md` (§4.3, §4.4, §0.3, §0.4, §0.7, §0.9, §0.10). Plan 1 (committed `9402bf0`) provides `cms_parse::verify_signed`, `CmsSigCheck`, `db::crl_cache`, `CryptoKind`.

## Global Constraints

- **User controls git — DO NOT COMMIT.** Skip "Commit" steps; leave changes uncommitted. Controller review still runs per task.
- **SDD workflow:** fresh implementer subagent per task + controller review + ledger entry.
- **Gates (every task):** `cargo test -p crypto-smime` (and `-p crypto-core` where touched) green; `cargo clippy --all-targets -- -D warnings` clean; backend tasks also `cargo build` clean. Run from `kylins.client.crypto/` (crypto tasks) or `kylins.client.backend/` (backend tasks).
- **`pkix-*` API is novel** (first release May 2026). **Task 1 is an API-spike-and-pin task** — its report records the exact types/signatures the later tasks use. Later tasks reference "the API pinned in Task 1's report" for `pkix-*` call syntax. Each later-task implementer reads Task 1's report before writing `pkix-*` calls.
- **Private-key hygiene:** no change from Plan 1 (verify is public-key only; decrypt unchanged).
- **Scope:** OCSP out (skip). Cert-chain IN. CRL IN (hard-fail-on-revoked, soft-fail-on-transport). RSA-PSS + ECDSA-P384 verify IN (the `DefaultVerifier` gaps). P-521 / Ed25519 OUT (negligible in deployed S/MIME). Trust-anchor store IN (user-imported CA roots).
- **`pkix-*` versions:** Task 1 picks + pins compatible versions (target `pkix-chain 0.4.x`, `pkix-path 0.3.x`, `pkix-profiles-cabf`, `pkix-identity`, `pkix-revocation` latest as of the spike). Record exact versions in the Task 1 report + `Cargo.toml`.
- **Naming:** `SignatureState` / `TrustState` enum values stay exactly as defined in `crypto-core` (`ValidVerified | ValidUnverified | Invalid | UnknownKey | Mismatch` / `Rejected | Undecided | Unverified | Verified | Personal`).
- **Plan 1 carry-forwards folded in:** (a) the `multipart/signed` detection `protocol` param gate (PGP overlap) — fix in Task 5's detection touch-up if scope allows, else note; (b) the `"no signer cert"` string-match → keep for now (Task 5 may promote to a dedicated error if cheap).

## File Structure

**Create:**
- `kylins.client.crypto/smime/src/chain.rs` — pkix-chain wiring, custom `SignatureVerifier`, `SmimeProfile` validation, From↔SAN, CRL glue, `validate_signer_chain(...)`, trust→`SignatureState` mapping.
- `kylins.client.backend/src/mail/crypto.rs` *(modify — add `validate_recipient_certs` helper)* — closes the Plan 4a "unvalidated recipient cert" carry-forward (G5 will wire it into `apply_crypto`, but the helper lands here in Task 5 so it exists for G5).

**Modify:**
- `kylins.client.crypto/smime/Cargo.toml` — add `pkix-chain`, `pkix-profiles-cabf`, `pkix-identity`, `pkix-revocation`, `p384`.
- `kylins.client.crypto/smime/src/lib.rs` — `mod chain;` + refine `SmimeBackend::verify` to call chain validation.
- `kylins.client.crypto/smime/src/cms_parse.rs` — expose `CmsSigCheck` + signer cert for chain.rs (already pub(crate)); add `signing_time` extraction.
- `kylins.client.backend/src/db/crypto_keys.rs` *(maybe)* — CA-root store helpers (trust anchors) if not already covered by existing `list_crypto_keys_for_account`.

**Test files:** inline `#[cfg(test)] mod tests` in `chain.rs` (mirror `cms_parse.rs`'s test module). Backend CRL test in `db/crl_cache.rs`'s test module (table already exists from Plan 1).

---

## Interfaces (cross-task contract — implementers read this)

- **Task 1 (spike) produces** a `chain.rs` "API pin" section in its report: the exact `pkix-chain`/`SmimeProfile`/`pkix-identity`/`pkix-revocation` types, constructors, and method names used to (a) build a `TrustAnchor` from a root cert, (b) call the chain validator with `SmimeProfile` + verify-time, (c) match `From:`↔SAN, (d) feed a CRL. **All later `pkix-*` calls use the names Task 1 pinned.**
- **`chain::validate_signer_chain(signer_cert_der, intermediates_der, trust_anchor_ders, from_email: Option<&str>, signing_time_unix: i64, crls: &[Vec<u8>]) -> chain::ChainOutcome`** (Task 3 produces; Tasks 4-5 consume). `ChainOutcome { chain_valid: bool, identity_match: bool, revocation_state: RevocationState, failure_reason: Option<String> }` where `RevocationState { Good, Revoked, Unchecked }`.
- **`SmimeBackend::verify`** (Task 5 refines): after Plan 1's `verify_signed` sig-check, calls `validate_signer_chain` + the user's `trust_decisions`/trust-anchor store, maps to the final `SignatureState` per the table in §4.4 of the spec.
- **`db::crl_cache`** (Plan 1) — `upsert_crl(pool, url, der, issuer_dn, next_update)`, `get_crl(pool, url)`, `prune_stale_crls(pool, now)`. Task 4 consumes.
- **`TrustState`** (`crypto-core/trust.rs`) — the 5-rung ladder; `trust_decisions.decision` CHECK values already match.

---

## Task 1: pkix-* deps + p384 + API spike (pin the real API)

**Files:**
- Modify: `kylins.client.crypto/smime/Cargo.toml`
- Create: `kylins.client.crypto/smime/src/chain.rs` (skeleton + spike test only)

**Interfaces:**
- Consumes: Plan 1's `cms_parse::CmsSigCheck` (read-only, for the signer-cert shape); the existing `cert.rs::build_self_signed_smime_cert` (to generate a known-good chain for the spike).
- Produces: the `pkix-*` dependency set + the **API pin** (in the Task 1 report) that Tasks 2-5 build on. No production behavior yet.

- [ ] **Step 1: Add the deps**

Edit `kylins.client.crypto/smime/Cargo.toml` `[dependencies]` — add:
```toml
pkix-chain = "0.4"          # pin exact version the spike resolves to
pkix-profiles-cabf = "0.4"  # SmimeProfile (CA/B Forum S/MIME BR)
pkix-identity = "0.4"       # RFC 8398 From<->SAN mailbox binding
pkix-revocation = "0.4"     # CRL/OCSP revocation for pkix-chain
p384 = "0.14"               # ECDSA P-384 verify (features ["pem", "pkcs8"])
```
Run `cargo update -p pkix-chain` (and the others) and record the EXACT resolved versions from `Cargo.lock` into the report.

Run: `cd kylins.client.crypto && cargo build -p crypto-smime`
Expected: builds clean (deps resolve). If a `pkix-*` version doesn't exist or conflicts, pick the latest compatible and record it. **If the `pkix-*` crates do NOT compile against the workspace's `x509-cert 0.3` / `der 0.8` line, STOP and report BLOCKED** — the engine choice (spec §0.3) depends on version compatibility.

- [ ] **Step 2: Write the spike test — validate a known-good self-generated chain → Ok**

Create `kylins.client.crypto/smime/src/chain.rs`:
```rust
//! S/MIME cert-chain validation + revocation (Phase 1b Plan 2 / G4).
//!
//! Built on the `pkix-*` family (crate-pkix workspace): `pkix-chain` for
//! RFC 5280 §6.1 path validation, `pkix-profiles-cabf::SmimeProfile` for the
//! CA/B Forum S/MIME BR policy, `pkix-identity` for RFC 8398 From<->SAN
//! binding, `pkix-revocation` for CRL. A custom `SignatureVerifier` adds the
//! RSA-PSS + ECDSA-P384 gaps in `DefaultVerifier`.

// The exact pkix-* imports are established by THIS TASK's spike and recorded
// in the Task 1 report (the "API pin"). Tasks 2-5 read that report.

#[cfg(test)]
mod spike_tests {
    use super::*;

    /// Spike: build a 3-cert chain (root CA -> intermediate -> leaf smime cert),
    /// validate the leaf against the root via pkix-chain + SmimeProfile at a
    /// known verify-time, and assert the validation succeeds. This EXERCISES
    /// the real pkix-* API and pins it for the later tasks.
    #[test]
    fn spike_validate_known_good_smime_chain() {
        let (root_der, root_priv) = build_ca("Root CA", None);
        let (inter_der, inter_priv) = build_ca("Intermediate CA", Some((&root_der, &root_priv)));
        let leaf_der = build_smime_leaf("user@example.com", (&inter_der, &inter_priv));

        let outcome = validate_signer_chain(
            &leaf_der,
            &[inter_der.clone()],     // intermediates, leaf-first path
            &[root_der.clone()],      // trust anchors
            Some("user@example.com"), // from_email for SAN match
            /* signing_time_unix */ 1_780_272_000,
            &[],                      // no CRLs yet
        );

        assert!(outcome.chain_valid, "known-good chain must validate");
        assert!(outcome.identity_match, "from_email matches the leaf SAN");
        assert_eq!(outcome.revocation_state, RevocationState::Unchecked);
    }
}
```
(The `build_ca` / `build_smime_leaf` helpers generate test certs using `x509-cert`'s `CertificateBuilder` the same way `cert.rs::build_self_signed_smime_cert` does — write them as test-local helpers, or extend `cert.rs` with a test-only `build_subordinate_cert`.)

Run: `cd kylins.client.crypto && cargo test -p crypto-smime spike_validate_known_good_smime_chain`
Expected: FAIL — `validate_signer_chain` / `ChainOutcome` / `RevocationState` not yet defined.

- [ ] **Step 3: Implement the minimal spike — define the types + a pkix-chain call that validates**

In `chain.rs`, define the outcome types + a `validate_signer_chain` that calls `pkix-chain`'s validator with `SmimeProfile`. **The goal of this step is to make the spike test pass AND to discover the real `pkix-*` API** (constructors, method names, error types). Read the downloaded crate source (`~/.cargo/registry/src/.../pkix-chain-*/src/`, `pkix-profiles-cabf-*/src/`, `pkix-identity-*/src/`) to resolve exact signatures — do not guess. The lib.rs page for `pkix-path` shows the building blocks: `validate_path(&chain, &anchors, &policy, &verifier)`, `TrustAnchor::from_cert(...)`, `ValidationPolicy::new(unix_time)`, `DefaultVerifier`.

Minimal `validate_signer_chain` for the spike:
```rust
pub(crate) enum RevocationState { Good, Revoked, Unchecked }

pub(crate) struct ChainOutcome {
    pub chain_valid: bool,
    pub identity_match: bool,
    pub revocation_state: RevocationState,
    pub failure_reason: Option<String>,
}

pub(crate) fn validate_signer_chain(
    signer_cert_der: &[u8],
    intermediates_der: &[&[u8]],
    trust_anchor_ders: &[Vec<u8>],
    from_email: Option<&str>,
    signing_time_unix: i64,
    _crls: &[Vec<u8>],
) -> ChainOutcome {
    // Parse certs via x509-cert (our existing types), build pkix-chain inputs,
    // call the validator with SmimeProfile at signing_time, run pkix-identity
    // From<->SAN match. CRL is a no-op in this spike (Unchecked).
    // EXACT pkix-* call syntax: recorded in the report's "API pin" section.
    todo!("spike: resolve + pin the pkix-chain/SmimeProfile/pkix-identity API")
}
```
Resolve the `todo!` by reading the crate source. The spike test must pass.

- [ ] **Step 4: Run the spike test → GREEN, then write the API pin**

Run: `cd kylins.client.crypto && cargo test -p crypto-smime spike_validate_known_good_smime_chain`
Expected: PASS.

Also add a negative spike: validate the leaf with the WRONG root (not its issuer) → `chain_valid == false`. Assert.

- [ ] **Step 5: Record the API pin in the report + gates**

The Task 1 report MUST contain an **"API pin" section** listing, with the exact signatures read from the crate source:
- `pkix-chain`: the validator entry point (e.g. `validate_path` or `verify_chain_default`), the `TrustAnchor` constructor, the `ValidationPolicy`/`SmimeProfile` construction, the verifier trait, the error type.
- `pkix-profiles-cabf`: `SmimeProfile` constructor + how it plugs into the policy.
- `pkix-identity`: the `From:`↔SAN matcher entry point + its inputs/outputs.
- `pkix-revocation`: the `RevocationChecker` trait + how a CRL is supplied (for Task 4).
- Exact resolved versions of all five crates from `Cargo.lock`.

Gates: `cargo test -p crypto-smime` green; `cargo clippy --all-targets -- -D warnings` clean; `cargo build` clean.

- [ ] **Step 6: Commit (SKIPPED — user controls git)**

---

## Task 2: Custom SignatureVerifier (RSA-PSS + ECDSA-P384)

**Files:**
- Modify: `kylins.client.crypto/smime/src/chain.rs`

**Interfaces:**
- Consumes: the `SignatureVerifier` trait + `DefaultVerifier` from the Task 1 API pin. `rsa 0.10.0-rc.18` (`rsa::pss::VerifyingKey`), `p384 0.14` (`p384::ecdsa::VerifyingKey`).
- Produces: `pub(crate) struct SmimeVerifier` implementing `pkix-*`'s `SignatureVerifier`, dispatching RSA-PKCS1v15 + RSA-PSS + ECDSA-P256 + ECDSA-P384. Used by `validate_signer_chain` (Task 3 wires it in).

- [ ] **Step 1: Write the failing test — verifier accepts RSA-PSS + P-384**

Append to `chain.rs` tests. Build an RSA-PSS-signed cert + a P-384 ECDSA cert (test helpers), validate each chain → both must pass (the `DefaultVerifier` alone would reject them — the gap this task closes).

```rust
    #[test]
    fn spike_validate_rsa_pss_signed_chain() {
        // RSA-PSS-signed intermediate/leaf chain -> SmimeVerifier must accept.
        let (root_der, root_priv) = build_ca("Root CA", None);
        let leaf_der = build_smime_leaf_rsa_pss("rsa-pss@example.com", (&root_der, &root_priv));
        let outcome = validate_signer_chain(&leaf_der, &[], &[root_der], Some("rsa-pss@example.com"), 1_780_272_000, &[]);
        assert!(outcome.chain_valid, "RSA-PSS signed chain must validate via SmimeVerifier");
    }

    #[test]
    fn spike_validate_p384_signed_chain() {
        let (root_der, root_priv) = build_ca_p384("Root CA P384", None);
        let leaf_der = build_smime_leaf_p384("p384@example.com", (&root_der, &root_priv));
        let outcome = validate_signer_chain(&leaf_der, &[], &[root_der], Some("p384@example.com"), 1_780_272_000, &[]);
        assert!(outcome.chain_valid, "ECDSA-P384 chain must validate via SmimeVerifier");
    }
```

Run: `cargo test -p crypto-smime spike_validate_rsa_pss spike_validate_p384`
Expected: FAIL — `DefaultVerifier` (used by the Task 1 spike) rejects RSA-PSS / P-384; the custom `SmimeVerifier` doesn't exist yet.

- [ ] **Step 2: Implement `SmimeVerifier`**

Implement `SmimeVerifier` implementing the `SignatureVerifier` trait (exact trait shape from Task 1's pin). `verify_signature(algorithm, issuer_spki, message, signature)` dispatches on the algorithm OID:
- RSA-PKCS1v15-SHA256 → `rsa::pkcs1v15::VerifyingKey` (already in `DefaultVerifier` — delegate or reimplement).
- **RSA-PSS-SHA256** → `rsa::pss::VerifyingKey::<Sha256>::new(public_key)` + `.verify(sig, msg)`. NEW.
- ECDSA-P256-SHA256 → `p256::ecdsa::VerifyingKey` (already).
- **ECDSA-P384-SHA384** → `p384::ecdsa::VerifyingKey` + `.verify_digest(...)`. NEW.
- Other → `Err` (unsupported).

Wire `SmimeVerifier` into `validate_signer_chain` (replace the `DefaultVerifier` the spike used).

Run: `cargo test -p crypto-smime` → GREEN for both new tests + the Task 1 spike still passes.

- [ ] **Step 3: Gates + Commit (SKIPPED)**

`cargo test -p crypto-smime` green; `cargo clippy --all-targets -- -D warnings` clean.

---

## Task 3: From↔SAN binding + signingTime + SmimeProfile wiring

**Files:**
- Modify: `kylins.client.crypto/smime/src/chain.rs`
- Modify: `kylins.client.crypto/smime/src/cms_parse.rs` (expose `signing_time` in `CmsSigCheck`)

**Interfaces:**
- Consumes: `pkix-identity` (Task 1 pin) for From↔SAN matching; the CMS `signingTime` signed attribute (parse OID `1.2.840.113549.1.9.5`).
- Produces: `validate_signer_chain` now sets `identity_match` correctly via `pkix-identity`, and validates at the CMS `signingTime` (not wall-clock now). `CmsSigCheck` gains `signing_time_unix: Option<i64>`.

- [ ] **Step 1: Add `signing_time` extraction to `cms_parse::verify_signed`**

Extend `CmsSigCheck` with `pub signing_time_unix: Option<i64>`. In `verify_signed`, parse the `signingTime` signed attribute (OID `1.2.840.113549.1.9.5`) — an UTCTime/GeneralizedTime → Unix seconds. Fallback `None` if absent (caller uses now()).

- [ ] **Step 2: Wire `pkix-identity` From↔SAN + signingTime into `validate_signer_chain`**

Replace the Task-1 spike's identity-match stub with a real `pkix-identity` call: match `from_email` against the leaf cert's `rfc822Name` / `id-on-SmtpUTF8Mailbox` SANs (RFC 5280 §7.5: case-sensitive local-part, case-insensitive domain, no subaddress normalization). Set `identity_match`. Pass `signing_time_unix` (or now() fallback) to the validator's `ValidationPolicy`.

- [ ] **Step 3: Tests**

- `validate_signer_chain` with `from_email` NOT in the SAN → `identity_match == false` (chain still `valid`, but the caller maps this to `Mismatch`).
- signingTime present → validates at that time (a cert that is valid at signingTime but expired now still validates).
- signingTime absent → validates at now().

- [ ] **Step 4: Gates + Commit (SKIPPED)**

---

## Task 4: CRL revocation (fetcher + crl_cache + hard/soft-fail)

**Files:**
- Modify: `kylins.client.backend/src/sync_engine/` or new `kylins.client.backend/src/mail/crypto_crl.rs` — the CRL HTTP fetcher (reqwest).
- Modify: `kylins.client.crypto/smime/src/chain.rs` — accept CRLs + `pkix-revocation` integration, hard/soft-fail.
- Modify: `kylins.client.backend/src/db/crl_cache.rs` (Plan 1) — confirm helpers suffice.

**Interfaces:**
- Consumes: `pkix-revocation` (Task 1 pin); `reqwest` (backend); `db::crl_cache::{upsert_crl, get_crl, prune_stale_crls}` (Plan 1); `x509-parser` to extract `cRLDistributionPoints` from certs.
- Produces: `ChainOutcome.revocation_state == Good | Revoked | Unchecked`. A fetched CRL that says *revoked* → `Revoked` (hard-fail). CRL unreachable/stale → `Unchecked` (soft-fail).

- [ ] **Step 1: `chain.rs` — feed CRLs to pkix-revocation**

Extend `validate_signer_chain` to accept `_crls: &[Vec<u8>]` (already in the signature) and pass them to `pkix-revocation`'s `RevocationChecker` (exact API from Task 1 pin). Map the result: revoked → `RevocationState::Revoked`; good → `Good`; no CRLs supplied → `Unchecked`.

Test (crypto-smime, in-process, no network): synthesize a CRL that marks the leaf revoked (or use a test fixture) → `outcome.revocation_state == Revoked` + `chain_valid == false` (hard-fail). If synthesizing a CRL in-test is impractical, gate this test behind `#[ignore]` with a documented manual procedure + still ship the code path.

- [ ] **Step 2: Backend CRL fetcher**

New module `kylins.client.backend/src/mail/crypto_crl.rs`:
```rust
/// Fetch a CRL by URL (reqwest), cache it in `crl_cache`, return the DER bytes.
/// Best-effort: returns None on transport error / non-200 / parse failure
/// (the caller treats None as soft-fail `Unchecked`).
pub async fn fetch_crl_cached(
    pool: &sqlx::SqlitePool,
    client: &reqwest::Client,
    crl_url: &str,
) -> Option<Vec<u8>> {
    // 1. Check crl_cache for a fresh entry (next_update > now) -> return if fresh.
    // 2. Else reqwest GET crl_url -> on 200, parse DER, upsert_crl, return Some(der).
    // 3. On any error -> None (soft-fail).
    todo!()
}
```
(Exact reqwest + crl_cache usage — mirror existing backend http/cache patterns.) Register the module in `mail/mod.rs`.

- [ ] **Step 3: Test the fetcher's soft-fail behavior**

A unit test with a mocked/unreachable URL (or a `reqwest` client pointed at `http://127.0.0.1:1` — guaranteed refused) → `fetch_crl_cached` returns `None` (soft-fail), no panic. A test against a known fresh cache row → returns the cached DER without hitting the network.

- [ ] **Step 4: Gates + Commit (SKIPPED)**

`cargo test -p crypto-smime` green; backend `cargo test --lib` green (crl_cache + fetcher tests); `cargo clippy` clean both.

---

## Task 5: Trust-anchor store + `SmimeBackend::verify` chain refinement

**Files:**
- Modify: `kylins.client.crypto/smime/src/lib.rs` — refine `SmimeBackend::verify` to call `validate_signer_chain` + map trust → final `SignatureState`.
- Modify: `kylins.client.backend/src/db/crypto_keys.rs` *(if needed)* — CA-root (trust-anchor) helpers: `list_trust_anchor_certs(pool, account_id) -> Vec<Vec<u8>>` (CA roots = `crypto_keys` rows `standard='smime', key_type='cert'`, or whatever convention the KeyManager uses; confirm against Plan 4b's KeyManager).
- Modify: `kylins.client.backend/src/mail/crypto.rs` — add `validate_recipient_certs(recipient_cert_ders)` helper (closes Plan 4a carry-forward; G5 wires it into `apply_crypto`).

**Interfaces:**
- Consumes: `chain::validate_signer_chain` (Tasks 2-4); the user's `trust_decisions` for the signer (db::trust_decisions from Plan 1 / earlier); `TrustState` (crypto-core).
- Produces: the FINAL `SignatureState` mapping per spec §4.4.

- [ ] **Step 1: Refine `SmimeBackend::verify` → final `SignatureState`**

After Plan 1's `verify_signed` sig-check (which yields `CmsSigCheck { sig_ok, signer_cert_der, signing_time_unix, ... }`), if `sig_ok`:
1. Resolve the trust anchors (the caller — the G5 orchestrator — passes them; for the `SmimeBackend::verify` contract, accept them via the keystore or a new field — see note below).
2. Call `validate_signer_chain(signer_cert, intermediates, anchors, from_email, signing_time, crls)`.
3. Map to `SignatureState` per spec §4.4:
   - chain invalid OR revoked → `Invalid`.
   - chain valid + `identity_match == false` → `Mismatch`.
   - chain valid + identity match + signer explicitly trusted (`trust_decisions` Verified/Personal, or our own key) → `ValidVerified`.
   - chain valid + identity match + signer not explicitly trusted → `ValidUnverified`.
4. If `sig_ok == false` → `Invalid` (unchanged). No signer cert → `UnknownKey` (unchanged).

**Note on trust anchors + from_email + crls inputs:** the `CryptoBackend::verify` trait takes only `VerifyOp { signed }`. To pass anchors/from_email/crls, EITHER (a) extend `VerifyOp`/`SignedEnvelope` with an optional context struct (crypto-core change), OR (b) add a `SmimeBackend::verify_with_context` method that the G5 orchestrator calls directly (bypassing the trait). **Pick (b)** for G4 (smaller blast radius; the trait stays stable); the G5 orchestrator calls `verify_with_context`. Document this as a carry-forward for G5.

- [ ] **Step 2: Test the full mapping**

Backend integration test (in `lib.rs` or a new `tests/`): generate a key (`generate_key`), sign a message, `verify_with_context` with the signer's own cert as trust anchor + a Verified `trust_decision` → `ValidVerified`. Same chain, no trust_decision → `ValidUnverified`. Tampered chain → `Invalid`. From↔SAN mismatch → `Mismatch`.

- [ ] **Step 3: `validate_recipient_certs` helper (closes Plan 4a)**

In `mail/crypto.rs`:
```rust
/// Validate recipient certs before encrypting (closes the Plan 4a
/// "unvalidated recipient cert" carry-forward). Returns the first failure
/// or Ok(()) if all certs pass basic validity (notAfter + chain-to-anchor +
/// key usage emailProtection). G5 wires this into apply_crypto.
pub async fn validate_recipient_certs(
    pool: &sqlx::SqlitePool,
    recipient_cert_ders: &[Vec<u8>],
    trust_anchor_ders: &[Vec<u8>],
) -> Result<(), CryptoSendError> { /* delegate to chain::validate_signer_chain per cert */ }
```
Unit test: a valid recipient cert → Ok; an expired cert → Err.

- [ ] **Step 4: Gates + Commit (SKIPPED)**

---

## Task 6: Final gates + carry-forward docs

**Files:** none (verification + docs).

- [ ] **Step 1: Consolidated gates**

Run: `cd kylins.client.crypto && cargo test` (crypto-core + crypto-smime, vendor excluded) + `cargo clippy --all-targets -- -D warnings` clean.
Run: `cd kylins.client.backend && cargo test --lib` + `cargo clippy --all-targets -- -D warnings` clean.

- [ ] **Step 2: Document carry-forwards in the report**

G5 wires `validate_signer_chain` + `validate_recipient_certs` into the `open_crypto_message` orchestrator + `apply_crypto`. G6 UI consumes the final `SignatureState`. G7 Thunderbird interop (incl. the Plan-1 `cms_build.rs:65-68` eContent double-wrap). The `verify_with_context` method → G5 adopts (or refactor into the trait). OCSP skipped. P-521/Ed25519 deferred. Bundled S/MIME CA root program deferred.

- [ ] **Step 3: Commit (SKIPPED — user controls git)**

---

## Carry-forwards (from this plan → later Phase 1b plans)

- **G5 — backend orchestration:** wire `chain::validate_signer_chain` into `open_crypto_message`; wire `validate_recipient_certs` into `apply_crypto` (closes Plan 4a); adopt `verify_with_context` (or refactor the trait); CRL fetcher call site (extract CRLDistributionPoints from signer/chain certs → `fetch_crl_cached` → feed to validate_signer_chain).
- **G6 — frontend UI:** consume the final `SignatureState` in CryptoBadge + TrustDialog; the "Trusted CAs" KeyManager section feeds the trust-anchor store.
- **G7 — Thunderbird interop:** validate our-signs→Thunderbird-verifies (cms_build.rs:65-68 eContent double-wrap) + Thunderbird-signs→Kylins-verifies (real CA-issued cert chain); cross-impl kari decrypt (Plan 1 carry-forward).
- OCSP skipped (deprecated). P-521/Ed25519 deferred. Bundled S/MIME CA roots deferred. pkix-* → certval migration when RustCrypto upstreams (formats Issue #838).

## Self-review

1. **Spec coverage:** §4.3 cert-chain = Tasks 1-3; §4.4 trust→SignatureState = Task 5; §0.4 CRL hard/soft-fail = Task 4; §0.9 signingTime = Task 3; §0.10 RSA-PSS + P-384 = Task 2; §0.7 trust anchors = Task 5; Plan 4a recipient-cert carry-forward = Task 5 Step 3. OCSP explicitly out (§0.4). All covered.
2. **Placeholders:** the pkix-* exact call syntax is deliberately deferred to Task 1's API-spike-and-pin (the spike IS the task, not a placeholder — it produces the API surface). Test code is concrete. Helper names (`build_ca`, `build_smime_leaf`, etc.) are referenced with intent + construction guidance.
3. **Type consistency:** `ChainOutcome { chain_valid, identity_match, revocation_state, failure_reason }` + `RevocationState { Good, Revoked, Unchecked }` used consistently across Tasks 1-5. `CmsSigCheck.signing_time_unix` added in Task 3, consumed in Task 5. `validate_signer_chain` signature stable from Task 1.
