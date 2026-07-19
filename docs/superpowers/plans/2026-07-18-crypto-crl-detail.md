# Plan — CRL Revocation Detail (Staleness + Structured Reason-Code)

> Spec: `docs/superpowers/specs/2026-07-18-crypto-crl-detail-design.md`. Strict SDD.
> Branch `fix/smime-receive-and-sign-details` (off c941d64 + .p12 export). UNCOMMITTED.

## Task 1 — crypto-smime + crypto-core: Stale state + revocation_reason

**Files:** `kylins.client.crypto/smime/src/chain.rs`, `kylins.client.crypto/core/src/envelope.rs`, `kylins.client.crypto/smime/src/lib.rs`.

1. RED: `revocation_state_stale_when_crl_expired`, `revocation_state_unchecked_when_no_crl`, `chain_outcome_carries_revocation_reason`, `verify_with_context_surfaces_revocation_reason`.
2. GREEN: `RevocationState::Stale` variant; `revocation_state()` returns `Stale` when `any_matched && any_unusable`; the Revoked-arm populates `ChainOutcome.revocation_reason` from `pkix_revocation::RevocationReason` (stringify the enum at the boundary; `None` → `Some("Unspecified")`). `VerificationResult.revocation_reason: Option<String>` (crypto-core, serde skip-if-none); `verify_with_context` populates it; all construction sites updated.

**Gates:** crypto-core + crypto-smime `cargo test` + clippy.

## Task 2 — backend: persist + surface revocation_reason

**Files:** `migrations/20260718400000_crypto_receive_revocation_reason.sql`, `src/db/message_crypto_results.rs`, `src/mail/crypto.rs`.

1. Migration `ALTER TABLE message_crypto_results ADD COLUMN revocation_reason TEXT`.
2. `build_crypto_result_row` threads `revocation_reason` from the VerificationResult (the orchestrator's 5-tuple → 6-tuple, OR a small struct — see deviation note); upsert binds it; get SELECTs it.
3. `get_signer_details` surfaces `revocation_reason`.
4. RED→GREEN: `build_crypto_result_row_persists_revocation_reason`, `get_signer_details_returns_revocation_reason`.

**Gates:** `cargo test --lib` + `cargo clippy --all-targets` (stay 0).

## Task 3 — frontend: render reason + Stale badge

**Files:** `services/db/cryptoReceive.ts`, `components/email/SignatureDetailsDialog.tsx`, `features/view/CryptoBadge.tsx`.

1. TS `revocationState` union gains `"stale"`; `MessageCryptoResult` + `SignerDetails` gain `revocationReason?: string | null`.
2. Dialog: "Reason: {revocationReason}" line when revoked + reason present.
3. `CryptoBadge`: a Stale revocation overlay (distinct tooltip/icon from Unchecked).
4. Tests.

**Gates:** tsc + eslint + prettier + vitest.

## Task 4 — Final gates + controller review + ledger

## Carry-forwards

CRL `nextUpdate` TIMESTAMP display (we surface stale-vs-not, not the date); finer unusable-cause discrimination; auto re-fetch stale CRLs; CRLite.
