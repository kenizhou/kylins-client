# Kylins Client — Crypto: Granular Chain-Outcome in Signature Details

> **Status:** Approved (2026-07-18). Closes the G6/G7 carry-forward "granular
> ChainOutcome UI" + the `build_crypto_result_row` "fine-grained ChainOutcome
> surfacing is a G6 carry-forward" comment (mail/crypto.rs:502). Strict SDD.
> **Parent:** `docs/superpowers/specs/2026-07-12-crypto-phase1b-smime-receive-design.md`.
> **Layers:** crypto-core + crypto-smime + backend + frontend.

## Goal

Surface the **real** cert-chain failure reason (and success nuance) in the
Signature Details dialog — e.g. "certificate revoked (KeyCompromise)", "no issuer
cert found for intermediate CN=…", "BR profile: emailProtection EKU missing",
"identity mismatch: From alice@x vs SAN alice@y" — instead of today's fixed
5-string enum→map that shows the same "Signature did not verify…" text for every
`Invalid` cause. The granular `ChainOutcome.failure_reason` is computed today
(`chain.rs`) but **dropped at the persistence boundary** (`build_crypto_result_row`,
mail/crypto.rs:484); every downstream layer (DB row, TS type, dialog banner) is
capped at the coarse enum.

## Background (verified — Explore agent map)

- `ChainOutcome` (chain.rs:103) has `failure_reason: Option<String>` — the real,
  specific reason (revoked serial + CRL reason code, parse error on cert #N, BR
  policy violation, identity mismatch detail). Computed inside
  `SmimeBackend::verify_with_context` (smime/lib.rs) which maps ChainOutcome →
  `SignatureState` and **discards `failure_reason`** before returning
  `VerificationResult { state, signer }`.
- `VerificationResult` (crypto-core) = `{ state: SignatureState, signer: Option<KeyHandleRef> }` — no failure_reason field.
- `build_crypto_result_row` (mail/crypto.rs:484) writes `message_crypto_results`
  with `signature_state`, `chain_valid` (nullable INT), `revocation_state`
  (3-state) — **no failure_reason column**. Comment: "the granular ChainOutcome
  is internal to verify_with_context and not re-exposed… fine-grained ChainOutcome
  surfacing is a G6 carry-forward."
- `message_crypto_results` schema (migrations/20260712000001_crypto_receive.sql):
  `account_id, message_id, crypto_kind, decrypt_state, signature_state,
  signer_fingerprint, signer_email, chain_valid, revocation_state, verified_at`.
  No failure_reason column.
- Dialog: `SignatureDetailsDialog` (components/email/) renders a `failureReason`
  banner sourced from `failure_reason_for_state(state)` (mail/crypto.rs:1370) —
  a fixed 5-string map. The real reason is gone before it reaches the UI.

## Decision log (locked)

| # | Decision | Choice |
|---|---|---|
| 1 | What to surface | **`failure_reason: Option<String>`** — the ChainOutcome.failure_reason string. It already carries the CRL reason code (stringified), the identity-mismatch detail, and the BR-policy violation text — human-readable, sufficient. NO separate structured `revocation_reason_code` column (YAGNI — the string form is what the dialog shows). `identity_match` is NOT surfaced separately — the `Mismatch` SignatureState already signals it + the failure_reason carries the detail. |
| 2 | VerificationResult extension | Add `failure_reason: Option<String>` to crypto-core `VerificationResult` (flat field, not a nested struct — YAGNI; one field, minimal ripple). `verify_with_context` populates it from `ChainOutcome.failure_reason`; the early-return arms (UnknownKey, sig-fail Invalid) leave it `None`. |
| 3 | Persistence | New migration adds `failure_reason TEXT NULL` to `message_crypto_results`. `build_crypto_result_row` binds the VerificationResult.failure_reason (None → NULL). Idempotent `ALTER TABLE … ADD COLUMN` (SQLite-safe; the column is nullable, no backfill needed — existing rows get NULL → the dialog falls back to the fixed map for them). |
| 4 | Dialog source | `get_signer_details` (mail/crypto.rs) queries the persisted `message_crypto_results.failure_reason` for the message + returns it in `SignerDetails`. The dialog renders the REAL reason when non-NULL; falls back to the existing `failure_reason_for_state` fixed map when NULL (pre-migration rows + the early-return arms). Belt-and-suspenders — no regression for rows without a real reason. |
| 5 | Success states | For ValidVerified/ValidUnverified, failure_reason is None → the dialog shows no banner (success). No change to the success UX. |
| 6 | i18n | The failure_reason strings come from the Rust crypto layer (pkix errors, CRL reason names, identity-mismatch format) — they're diagnostic English, NOT currently externalized. Keeping them as-is (diagnostic) is acceptable for Phase 1b (matches the existing `failure_reason_for_state` English strings). A future i18n pass can map reason-codes to localized strings — carry-forward. |

## Scope

**In:**
- crypto-core: `VerificationResult` gains `failure_reason: Option<String>`.
- crypto-smime: `verify_with_context` populates it from `ChainOutcome.failure_reason`.
- backend migration: `message_crypto_results` gains `failure_reason TEXT NULL`.
- backend `build_crypto_result_row`: binds failure_reason.
- backend `get_signer_details` (SignerDetails): surfaces the persisted failure_reason.
- frontend `MessageCryptoResult` + `SignerDetails` TS types: `failureReason?: string | null`.
- frontend `SignatureDetailsDialog`: render the real failureReason (fallback to fixed map when null).

**Out (carry-forwards):** structured CRL `reason_code` enum column; per-cert
validity/expiry on chain-path entries; the verify-time `signingTime` (still
hardcoded None — separate `find_signing_time` re-export issue); i18n of reason
strings; the chain-path "which anchor actually validated" flag.

## Data

**Migration** (`ALTER TABLE message_crypto_results ADD COLUMN failure_reason TEXT`).
Nullable, no default, no backfill — existing rows NULL. Idempotent guard:
SQLite `ALTER TABLE ADD COLUMN` fails if the column exists; the migration
runner (`_migrations` table) ensures it runs once. (If the project's migration
helper requires a guard, wrap in the existing idempotent pattern.)

## Failure modes

- Pre-migration rows / rows where failure_reason is NULL → dialog falls back to
  `failure_reason_for_state` (no regression).
- The failure_reason string is untrusted content from the crypto layer — but
  it's diagnostic text generated locally (not from the network/message), so it
  renders as plain text (no HTML injection surface). The dialog already renders
  it in a non-HTML context.
- `verify_with_context` early-return arms (UnknownKey, sig-fail) → failure_reason
  None → the dialog's fixed-map fallback handles those states.

## Security

- No new secrets, no new IPC command (get_signer_details already exists — just
  returns one more field), no new SQL beyond the ALTER + a SELECT of the new
  column (parameterized — the existing query shape). No HTML rendering of the
  reason (plain text). No capability change.
- The failure_reason is local diagnostic text, not attacker-controlled (the CRL
  reason codes + pkix errors are from RFC-defined enums / our own format strings;
  even a malicious CMS can't inject arbitrary text into failure_reason beyond
  cert field CNs — and those render as plain text in the dialog, no XSS).

## Performance

One extra column read in `get_signer_details` (already queries the row). No new
queries. Negligible.

## UX / A11y

- The dialog's existing failureReason banner (already ARIA-labeled) now shows
  the real reason. Tone unchanged (warning/error per state).
- No layout shift (the banner slot already exists).

## Tests (TDD — implementer subagent)

crypto-smime:
1. `verify_with_context_surfaces_chain_failure_reason` — a revoked-cert / wrong-
   anchor scenario → `VerificationResult.failure_reason` is `Some` + contains the
   expected substring ("revoked" / "no issuer" / etc.).
2. `verify_with_context_success_has_no_failure_reason` — ValidVerified → failure_reason None.

backend:
3. `build_crypto_result_row_persists_failure_reason` — verify a failing signature
   → the `message_crypto_results` row's `failure_reason` column = the real reason
   (not NULL).
4. `get_signer_details_returns_persisted_failure_reason` — seed a row with a
   failure_reason → SignerDetails.failureReason mirrors it; a NULL row →
   SignerDetails.failureReason falls back to the fixed-map string.

frontend:
5. `SignatureDetailsDialog` test — a crypto result with a real failureReason
   renders that string; a result with null falls back to the fixed map.

## Gates

crypto-core + crypto-smime `cargo test` + clippy; backend `cargo test --lib` +
clippy; frontend tsc + eslint + prettier + vitest.

## Open questions

- Whether `get_signer_details` should DISTINCT the failure_reason source (persisted
  row vs re-derive) — decision #4 says persisted (cheaper, one source of truth).
  If the persisted row is stale (re-verify on a cache miss), the existing
  re-verify path updates it — confirm the dialog reads post-refresh.
