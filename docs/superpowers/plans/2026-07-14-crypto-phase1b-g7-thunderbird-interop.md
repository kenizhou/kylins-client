# Crypto Phase 1b Plan 5 — S/MIME Thunderbird Interop (G7) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Validate + harden the S/MIME pipeline against real-world interop: confirm + fix the suspected `cms_build.rs` eContent double-wrap (a send-side interop bug), add the deferred clear-signed `multipart/signed` receive path, add cross-implementation (openssl-generated) round-trip tests, and document the manual Thunderbird end-to-end procedure. After this plan, Kylins↔Thunderbird S/MIME (sign/encrypt/decrypt/verify) is validated both ways.

**Architecture:** This is **Phase 1b Plan 5 (G7)** — the cross-implementation gate. Plans 1-4 (G1-G6) built + reviewed the full bidirectional pipeline against *self* round-trips; G7 closes the gap to *real* CMS produced/consumed by Thunderbird/OpenSSL. It's part code (the eContent fix, clear-signed receive, openssl fixtures) + part manual (the user-run Thunderbird e2e). The investigation task (T1) is load-bearing — its outcome determines whether the send-side produces RFC-conformant encapsulated SignedData.

**Tech Stack:** Rust; `crypto-smime` (`cms_build`, `cms_parse`); `openssl` CLI (via `std::process::Command` in tests, OR pre-generated fixtures) for cross-impl CMS; Tauri (manual e2e). Spec: `docs/superpowers/specs/2026-07-12-crypto-phase1b-smime-receive-design.md` §8 (interop gate). Local reference: Thunderbird S/MIME at `D:/Projects/mailclient/opensource/thunderbird-desktop/mailnews/extensions/smime/`; upstream RustCrypto cms at `D:/Projects/mailclient/opensource/RustCrypto/formats/cms/`.

## Global Constraints

- **User controls git — DO NOT COMMIT.** Skip "Commit" steps; leave changes uncommitted. Controller review still runs per task.
- **SDD workflow:** fresh implementer subagent per task + controller review + ledger entry.
- **Gates (every code task):** `cargo test -p crypto-smime` green; `cargo clippy --all-targets -- -D warnings` clean; backend/frontend gates where touched. Run from the relevant workspace.
- **The eContent investigation (T1) is genuinely uncertain** — the analysis suggests a double-wrap bug, but the cms crate's `EncapsulatedContentInfo` serialization must be confirmed before committing to a fix. If T1 finds the current code IS RFC-correct (the cms crate handles the wrapping internally), T1 becomes a no-fix confirmation + an added openssl reference test.
- **openssl availability:** if `openssl` isn't on PATH or fixture-generation in-test is fragile, fall back to pre-generated DER fixtures committed under `kylins.client.crypto/smime/tests/fixtures/` (generated once via `openssl smime`/`openssl asn1parse`, committed). Prefer in-test generation for reproducibility, but committed fixtures are acceptable.
- **Self-round-trip must stay green** — any fix must not break the existing build↔decrypt/verify round-trips (Plan 1/G4 tests). Both sides (build + parse) must move together if the eContent wrapping changes.

## File Structure

**Create:**
- `kylins.client.crypto/smime/tests/fixtures/` — pre-generated openssl CMS (only if in-test generation isn't feasible).
- `docs/superpowers/manual-e2e/smime-thunderbird-interop.md` — the user-run Thunderbird e2e procedure (T4).

**Modify:**
- `kylins.client.crypto/smime/src/cms_build.rs` — the eContent fix (T1, if confirmed).
- `kylins.client.crypto/smime/src/cms_parse.rs` — if the eContent wrapping changes, the verify-side `econtent.value()` hash source must move in lockstep.
- `kylins.client.backend/src/mail/crypto.rs` (`open_crypto_message`) — clear-signed `multipart/signed` handling (T2).
- `kylins.client.frontend/` — clear-signed attachment rendering (T2, if needed).

---

## Task 1: eContent double-wrap investigation + fix

**Files:**
- Modify: `kylins.client.crypto/smime/src/cms_build.rs:60-74` (the encapsulated-content construction)
- Possibly modify: `kylins.client.crypto/smime/src/cms_parse.rs` (the verify-side hash source, if the wrapping changes)
- Test: `kylins.client.crypto/smime/src/cms_build.rs` (new interop test)

**Interfaces:** consumes the vendored cms `EncapsulatedContentInfo` + `SignedDataBuilder`; produces an RFC-5652-§5.4-conformant encapsulated SignedData.

- [ ] **Step 1: Confirm the double-wrap with an openssl/asn1parse reference**

Write a test that builds an encapsulated SignedData via `build_signed_data(payload, false, ...)` (the current code), serializes to DER, and either:
- (a) shells out to `openssl asn1parse -inform DER` on the bytes and asserts the OCTET STRING nesting, OR
- (b) re-parses the DER with the cms crate + walks to the eContent + asserts `econtent.value()` (the Any's value) — if it equals `04||len||payload` (the inner TLV) the double-wrap is confirmed; if it equals `payload` directly, the cms crate handles the wrapping + there's no bug.

**Expected:** the analysis predicts `econtent.value() == 04||len||payload` (double-wrap confirmed). If the test shows `econtent.value() == payload`, the current code is correct — close T1 as a no-fix + the test becomes a permanent RFC-conformance guard.

- [ ] **Step 2: If confirmed, fix `cms_build.rs`**

Change the encapsulated-content construction so the eContent is a single OCTET STRING whose value is the payload:
```rust
let econtent = if detached {
    None
} else {
    // RFC 5652 §3: eContent is [0] EXPLICIT OCTET STRING. The Any IS the
    // OCTET STRING (tag 0x04); its VALUE must be the raw payload bytes, NOT
    // the OCTET STRING's own DER (which would double-wrap and make the
    // messageDigest cover the inner TLV instead of the payload per §5.4).
    Some(Any::new(Tag::OctetString, payload.to_vec())
        .map_err(|e| cms_err("wrap payload any", e))?)
};
```
(Drop the `OctetString::new(...).to_der()` double-encode. Confirm against the cms crate's `EncapsulatedContentInfo` definition — the field is `Option<Any>` and the Any is the OCTET STRING.)

- [ ] **Step 3: Move the verify side in lockstep (if needed)**

If the eContent wrapping changes, `cms_parse::verify_signed`'s messageDigest hash source must match. Per RFC §5.4, the digest is over the OCTET STRING's *value* (the payload). After the fix, `econtent.value()` should return the payload directly — confirm `verify_signed` hashes `econtent.value()` (it does, per the Plan 1 Task 3 review) and that it now covers the payload, not the inner TLV. Update the encapsulated verify test if the expected bytes change.

- [ ] **Step 4: Re-verify all round-trips + the openssl reference**

Run: `cargo test -p crypto-smime` — ALL existing build↔decrypt/verify round-trips must pass (the fix moves both sides together). Re-run the asn1parse/parse reference: `econtent.value() == payload` now (single OCTET STRING). If feasible, build a SignedData + verify with `openssl smime -verify` (using the signer cert) → expect success.

- [ ] **Step 5: Gates + Commit (SKIPPED)**

`cargo test -p crypto-smime` green; `cargo clippy --all-targets -- -D warnings` clean.

---

## Task 2: Clear-signed `multipart/signed` receive path

**Files:**
- Modify: `kylins.client.backend/src/mail/crypto.rs::open_crypto_message` (handle `multipart/signed`)
- Possibly modify: `kylins.client.backend/src/mail/crypto.rs` (extract the detached `.p7s` signature + verify against the plaintext part)

**Interfaces:** consumes `cms_parse::verify_signed` (detached mode — `covered_content = Some(plaintext_part_bytes)`); produces a verified clear-signed result.

- [ ] **Step 1: Add the clear-signed branch to `open_crypto_message`**

G5's orchestrator handles `application/pkcs7-mime` (opaque enveloped/signed-data) only. For `multipart/signed` (clear-signed — the body is plaintext, the signature is a `smime.p7s` attachment), the orchestrator must:
1. Detect the message is `multipart/signed` (the `crypto_kind` is `Signed`; the body is plaintext, not ciphertext).
2. Locate the `smime.p7s` attachment (the detached SignedData signature).
3. Call `cms_parse::verify_signed` (or `verify_with_context`) with `covered_content = Some(<the plaintext part bytes>)` (detached mode — the signature is over the plaintext part 1, not encapsulated).
4. mail_parser already parsed the plaintext body (it's the body_html/body_text); the `.p7s` is in the attachments.

The detection: `open_crypto_message` is called for crypto-marked messages. For `multipart/signed`, there's no `body_mime_ciphertext` (T1 G5 set raw_ciphertext=None for multipart/signed). So the orchestrator's "no ciphertext" path must check `crypto_kind === Signed` + look for the `.p7s` attachment instead of returning `decrypt_state=failed`.

- [ ] **Step 2: Test**

A backend integration test: build a clear-signed `multipart/signed` message (via the send side's `apply_crypto` sign-only path, which produces `multipart/signed`), persist it, call `open_crypto_message` → asserts `signature_state` verifies (ValidVerified/ValidUnverified) + the plaintext renders. Mirror the G5 orchestrator test pattern.

- [ ] **Step 3: Gates + Commit (SKIPPED)**

---

## Task 3: Cross-implementation (openssl) round-trip fixtures

**Files:**
- Create: `kylins.client.crypto/smime/tests/interop_fixtures.rs` (or extend `cms_parse.rs`/`cms_build.rs` tests)
- Possibly create: `kylins.client.crypto/smime/tests/fixtures/` (committed openssl-generated DER)

**Interfaces:** none new — exercises the existing build/decrypt/verify against externally-produced CMS.

- [ ] **Step 1: openssl-generated kari decrypt test**

Generate (in-test via `openssl`, OR a committed fixture) an EnvelopedData encrypted to an ECC P-256 recipient (the same key type our build uses) via `openssl smime -encrypt`. Call `decrypt_enveloped` on it → assert it recovers the plaintext. This proves our kari decrypt (written fresh in Plan 1, only self-round-trip-tested) works against openssl's output. (If openssl kari generation is awkward, generate via a second independent path — e.g., a Python `cryptography` script committed as a fixture-generator — and commit the resulting DER.)

- [ ] **Step 2: openssl-generated SignedData verify test**

Generate a SignedData via `openssl smime -sign` (RSA + ECDSA) → call `verify_signed` (or `verify_with_context`) → assert `sig_ok`. This proves our verify works against openssl's signatures (covers the RSA-PSS + ECDSA arms).

- [ ] **Step 3: Our-build → openssl-verify test (the reverse direction)**

Build a SignedData via `build_signed_data` → verify with `openssl smime -verify -content <payload>` (detached) or `-verify` (encapsulated) → assert openssl accepts it. This is the OUR-SIGNS→OPENSSL-VERIFIES direction (the eContent double-wrap fix from T1 makes this pass).

- [ ] **Step 4: Gates + Commit (SKIPPED)**

If openssl isn't available in the test env, mark these `#[ignore]` with a documented manual run procedure + still ship the committed fixtures for local runs.

---

## Task 4: Manual Thunderbird e2e procedure doc

**Files:**
- Create: `docs/superpowers/manual-e2e/smime-thunderbird-interop.md`

- [ ] **Step 1: Write the procedure**

A step-by-step user-run guide:
1. **Setup:** `cargo tauri dev`; Preferences → Security → "Your S/MIME Keys" → Import PEM (or Generate self-signed) → Set default; "Trusted CAs" → import the signing CA root (if using a real CA-issued cert).
2. **Receive (Thunderbird → Kylins):** send a signed+encrypted mail from Thunderbird (with a real cert) to the Kylins IMAP account → open in Kylins → expect decrypt + verify → CryptoBadge shows the state. Test each: signed-only, encrypted-only, signed+encrypted, an untrusted signer (→ TrustDialog → trust → ValidVerified).
3. **Send (Kylins → Thunderbird):** compose in Kylins → toggle Encrypt+Sign → send → open in Thunderbird → expect decrypt + verify (this validates the eContent fix from T1 + the send pipeline).
4. **Decrypt-failure:** encrypt a mail to an account whose key is absent → open in Kylins → expect the "no matching private key" panel.
5. **Clear-signed:** receive a Thunderbird clear-signed (`multipart/signed`) mail → verify (validates T2).
6. **CRL (if a revoked cert is obtainable):** receive a mail signed by a revoked cert → expect `Invalid` (hard-fail) per G4.

Document the expected outcome for each + how to capture Thunderbird's S/MIME error UI for diagnosis.

- [ ] **Step 2: Commit (SKIPPED)**

---

## Task 5: Interop-bug triage + final gates

**Files:** depends on what the manual e2e (T4) surfaces.

- [ ] **Step 1: Triage any bugs found in T4**

If the manual e2e surfaces interop bugs (e.g., a cert-chain edge, a CRL issue, a rendering bug), triage + fix them in this task. Each fix follows TDD (a test pinning the bug, then the fix). If the e2e is clean, T5 is a no-op (document that in the report).

- [ ] **Step 2: Final consolidated gates**

Run: `cargo test` (crypto workspace) + backend `cargo test --lib` + frontend `npx tsc --noEmit && npx vitest run` + clippy/eslint all. All green.

- [ ] **Step 3: Update the ledger — Phase 1b COMPLETE**

G7 done → Phase 1b (S/MIME send + receive, full Thunderbird interop) complete. Document any remaining hardening carry-forwards (granular ChainOutcome UI, CRL nextUpdate, RSA-PSS saltLength, vendored-cms switch-back, bundled S/MIME CA root program, PGP/Phase 2).

- [ ] **Step 4: Commit (SKIPPED — user controls git)**

---

## Carry-forwards (post-Phase-1b hardening)

- **Granular ChainOutcome UI:** expose revoked-vs-unchecked in the CryptoBadge (G5 persists coarsely; G6 shows the coarse state).
- **CRL `nextUpdate` parsing** in `fetch_crl_cached` (currently 24h transport TTL).
- **RSA-PSS `saltLength`** parsed from params (currently defaults to digest size).
- **Vendored-cms switch-back** to crates.io `cms="0.3"` once a fixed version ships (re-apply the kari KEK-buffer fix + the cipher/ec API-drift patches, OR upstream them).
- **Bundled S/MIME CA root program** (Phase 1b uses user-imported roots only).
- **PGP / Phase 2** (OpenPGP backend per the umbrella spec).
- **`.p12`/PKCS#12 import** (Plan 3 carry-forward).

## Self-review

1. **Spec coverage:** §8 interop gate = T1 (eContent fix) + T3 (cross-impl fixtures) + T4 (Thunderbird e2e); the clear-signed path (G5/G6 carry-forward) = T2; interop triage = T5. All covered.
2. **Placeholders:** T1's fix is conditional on the investigation outcome (the step explicitly handles both "bug confirmed → fix" + "no bug → close"). T3's openssl generation has a documented fallback (committed fixtures / `#[ignore]`). T5 is explicitly contingent on T4's findings. No vague "add error handling."
3. **Type consistency:** no new cross-task types; T1/T2/T3 exercise the existing `build_signed_data`/`decrypt_enveloped`/`verify_signed`/`open_crypto_message` signatures.
