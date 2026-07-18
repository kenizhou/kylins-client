# Plan — Granular Chain-Outcome in Signature Details

> Spec: `docs/superpowers/specs/2026-07-18-crypto-granular-chain-outcome-design.md`.
> Strict SDD. Branch `fix/smime-receive-and-sign-details` (off 120ea4d + Task A).
> UNCOMMITTED. One implementer dispatch (single field threaded through 4 layers).

## Task 1 — crypto-core: `VerificationResult.failure_reason`

**Files:** `kylins.client.crypto/core/src/...` (the VerificationResult definition).

1. RED (crypto-smime): `verify_with_context_surfaces_chain_failure_reason` — a
   wrong-anchor / revoked scenario → `result.failure_reason` is `Some` + contains
   "revoked"/"no issuer"/etc. RED (fails to compile — field absent).
2. GREEN: add `pub failure_reason: Option<String>` to `VerificationResult`. Update
   every construction site (the smime `verify` trait impl + `verify_with_context`
   set it; other backends/the trait default set `None`).
3. `verify_with_context` (smime/lib.rs): populate `failure_reason` from the
   `ChainOutcome.failure_reason` (it already computes `outcome`); early-return
   arms leave it `None`.
4. RED→GREEN: `verify_with_context_success_has_no_failure_reason` — ValidVerified → None.

**Gates:** crypto-core + crypto-smime `cargo test` + clippy.

## Task 2 — backend: persist + surface failure_reason

**Files:** `kylins.client.backend/migrations/20260718000000_crypto_receive_failure_reason.sql`
(new), `src/db/message_crypto_results.rs`, `src/mail/crypto.rs`.

1. Migration: `ALTER TABLE message_crypto_results ADD COLUMN failure_reason TEXT`
   (nullable, no default). Idempotent per the project's migration runner.
2. `build_crypto_result_row` (mail/crypto.rs:484): bind `failure_reason` from the
   VerificationResult (the orchestrator's `run_verify_path` already has the
   VerificationResult — thread it; or `open_crypto_message` passes it through).
3. RED→GREEN: `build_crypto_result_row_persists_failure_reason` — failing sig →
   row.failure_reason = the real reason.
4. `get_signer_details` (mail/crypto.rs:~1425): SELECT `failure_reason` from
   `message_crypto_results`; add `failureReason: Option<String>` to `SignerDetails`;
   populate from the row (None when NULL). The dialog falls back to the fixed
   `failure_reason_for_state` map when None.
5. RED→GREEN: `get_signer_details_returns_persisted_failure_reason`.

**Gates:** `cargo test --lib` + clippy (no new imap debt).

## Task 3 — frontend: render the real failure_reason

**Files:** `kylins.client.frontend/src/services/db/cryptoReceive.ts` (`SignerDetails`
+ `MessageCryptoResult` types), `src/components/email/SignatureDetailsDialog.tsx`.

1. TS types: `failureReason?: string | null` on `SignerDetails` + `MessageCryptoResult`.
2. `SignatureDetailsDialog`: render `signerDetails.failureReason ?? failureReasonForState(state)`
   (the real reason when present; the fixed-map fallback when null).
3. RED→GREEN test: real failureReason renders the string; null → fixed-map fallback.

**Gates:** `npx tsc --noEmit` + `npx eslint .` + `npx prettier --check .` + `npx vitest run`.

## Task 4 — Final gates + controller review + ledger

1. All gates green. Manual e2e (receive a revoked-cert / untrusted-signer mail →
   open Signature Details → see the real reason) left to the user.
2. Dispatch `feature-dev:code-reviewer` on the diff (correctness: the field is
   threaded end-to-end; security: failure_reason renders as plain text, no XSS;
   migration idempotent).
3. Append the SDD ledger entry.

## Carry-forwards

Structured CRL `reason_code` enum column; per-cert validity on chain-path entries;
verify-time `signingTime` re-export; i18n of reason strings; "which anchor
validated" flag.
