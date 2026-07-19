# Kylins Client — Crypto: CRL Revocation Detail (Staleness + Structured Reason-Code)

> **Status:** Approved (2026-07-18). Combines two G6/G7 carry-forwards: "CRL
> nextUpdate" + "structured CRL reason-code column". Strict SDD. **Parent:**
> `2026-07-12-crypto-phase1b-smime-receive-design.md` (decision #4 revocation
> posture). **Layers:** crypto-smime + crypto-core + backend + frontend.

## Goal

Surface TWO pieces of granular CRL-revocation detail that are computed today but
lost before the UI:
1. **Staleness** — distinguish "revocation unchecked because the CRL is
   stale/unusable (past nextUpdate / bad sig)" from "unchecked because no CRL
   was available". Today both collapse to `RevocationState::Unchecked`; the user
   can't tell whether their revocation data is merely missing vs. outdated.
2. **Structured revocation reason** — when a cert IS revoked, surface the RFC 5280
   CRLReason (KeyCompromise / CACompromise / Superseded / …) as a distinct field,
   not just stringified inside `failure_reason`. Lets the UI badge "Revoked
   (KeyCompromise)" instead of burying it in a sentence.

## Background (verified)

- `RevocationState` (chain.rs:89) = `Good | Revoked | Unchecked` (3-state).
- `KylinsCrlChecker` (chain.rs:428) ALREADY tracks `any_matched` + `any_unusable`
  (Cell<bool>) internally — `any_unusable` is set when a matching CRL is expired
  (past nextUpdate), bad-sig, out-of-scope, or unparseable. But `revocation_state()`
  (line 469) collapses `any_unusable` → `Unchecked`. So staleness is detected but
  not surfaced.
- `pkix_revocation::Error::Revoked { serial, reason_code: Option<RevocationReason> }`
  (chain.rs:286) carries the RFC 5280 CRLReason enum; chain.rs stringifies it via
  `format!("{r:?}")` into `failure_reason`. The structured enum is dropped.
- `ChainOutcome` (chain.rs:103) = `{ chain_valid, identity_match, revocation_state,
  failure_reason }`. `VerificationResult` (crypto-core) = `{ state, signer,
  failure_reason }` (the granular-outcome task added failure_reason). `message_crypto_results`
  has `revocation_state` (TEXT) + `failure_reason` (TEXT, the prior task). No
  `revocation_reason` column.
- `RevocationReason` is `pkix-revocation`-internal (0.7-line) — stringify at the
  chain.rs boundary (don't leak the pkix type across crates).

## Decision log (locked)

| # | Decision | Choice |
|---|---|---|
| 1 | Staleness surface | Add `RevocationState::Stale`. `revocation_state()` returns `Stale` when `any_matched && any_unusable` (a CRL covered the cert but was unusable — expired/stale is the common case); `Unchecked` only when no CRL covered the cert at all. Reuses the existing `any_unusable` flag — no new tracking. |
| 2 | Reason-code surface | Add `revocation_reason: Option<String>` to `ChainOutcome` — the RFC 5280 CRLReason name (string form: `"KeyCompromise"` / `"CACompromise"` / `"AffiliationChanged"` / `"Superseded"` / `"CessationOfOperation"` / `"CertificateHold"` / `"RemoveFromCRL"` / `"PrivilegeWithdrawn"` / `"AACompromise"` / `"Unspecified"`). Populated only when `Revoked` (None otherwise). Stringified at the chain.rs boundary (the pkix enum is 0.7-line; don't leak it). |
| 3 | VerificationResult | Add `revocation_reason: Option<String>` to crypto-core `VerificationResult` (mirrors the `failure_reason` field from the prior task). `verify_with_context` populates it from `ChainOutcome.revocation_reason`. |
| 4 | Persistence | Migration adds `revocation_reason TEXT NULL` to `message_crypto_results`. `build_crypto_result_row` binds it. The existing `revocation_state` TEXT column already holds the 4 states (Good/Revoked/Unchecked/Stale) — no schema change for the Stale variant (TEXT). `get_signer_details` surfaces `revocation_reason`. |
| 5 | UI | (a) The Signature Details dialog shows the structured reason as a distinct line/badge when revoked ("Reason: KeyCompromise") instead of only the failure_reason sentence. (b) A `Stale` revocation state shows a distinct warning ("Revocation data is stale — CRL past its nextUpdate / unusable") vs the Unchecked "no revocation data available". The `CryptoBadge` revocation overlay gains a Stale variant (warning tone, distinct from Unchecked). |
| 6 | Backward compat | Existing rows: `revocation_reason` NULL (the dialog omits the reason line); `revocation_state` values are unchanged (Good/Revoked/Unchecked — Stale only appears for newly-verified messages). No backfill. |

## Scope

**In:**
- crypto-smime: `RevocationState::Stale` + `revocation_state()` returns it; `ChainOutcome.revocation_reason`; the Revoked-arm populates it from `pkix_revocation::RevocationReason`.
- crypto-core: `VerificationResult.revocation_reason`.
- backend migration `ALTER TABLE message_crypto_results ADD COLUMN revocation_reason TEXT`; `build_crypto_result_row` + `get_signer_details` thread it; `VerificationResult` construction sites updated.
- frontend: `MessageCryptoResult` + `SignerDetails` TS gain `revocationReason?: string | null`; the dialog renders the reason line; `CryptoBadge` gains a `stale` revocation overlay state; the TS `revocationState` union gains `"stale"`.

**Out (carry-forwards):** the actual CRL `nextUpdate` TIMESTAMP display (we surface stale-vs-not, not the date — a follow-up could show "CRL last updated X, next update Y"); finer unusable-cause discrimination (CrlExpired vs CrlSignatureInvalid vs CrlParseError — all surface as `Stale`); re-fetching a stale CRL automatically; CRLite.

## Data

Migration `ALTER TABLE message_crypto_results ADD COLUMN revocation_reason TEXT` (nullable, no default, no backfill — sqlx::migrate! tracks by checksum, runs once). Sequences after `20260718300000_crypto_receive_failure_reason.sql`.

## Failure modes

- Pre-migration rows → `revocation_reason` NULL (dialog omits the line; no regression).
- A Revoked cert with `reason_code: None` (CRL didn't specify) → `revocation_reason = Some("Unspecified")` (or None — decision: `Some("Unspecified")` for a stable non-null signal; the UI shows "Reason: Unspecified").
- The Stale state never blocks message open (soft-fail, same as Unchecked) — it's informational.

## Security

No new secrets/IPC/capability/HTML. The reason-code + staleness are local-computed diagnostic data (revocation state from CRLs we fetched). Rendered as plain text. The Stale state is informational (does NOT weaken revocation — a stale CRL still soft-fails to "not fully checked", never to "trusted").

## Performance

Negligible (one more column read in `get_signer_details`; one more field on the wire).

## UX / A11y

- Dialog: "Reason: KeyCompromise" line (only when revoked + reason present). "Revocation: stale" warning (only when Stale).
- CryptoBadge: the existing revocation overlay (warning triangle) gains a Stale variant — distinct icon/tooltip from Unchecked. ARIA label "Revocation data stale".
- No layout shift (the slots exist).

## Tests (TDD — implementer subagent)

crypto-smime (`chain.rs` / `lib.rs` tests):
1. `revocation_state_stale_when_crl_expired` — a CRL past its nextUpdate covering the cert → `RevocationState::Stale` (was Unchecked).
2. `revocation_state_unchecked_when_no_crl` — no CRL → `Unchecked` (regression guard; Stale must NOT appear when no CRL matched).
3. `chain_outcome_carries_revocation_reason` — a revoked cert → `ChainOutcome.revocation_reason == Some("KeyCompromise")` (or whichever the fixture sets).
4. `verify_with_context_surfaces_revocation_reason` — the `VerificationResult.revocation_reason` mirrors ChainOutcome's.

backend:
5. `build_crypto_result_row_persists_revocation_reason` — revoked cert → row.revocation_reason = the reason.
6. `get_signer_details_returns_revocation_reason`.

frontend:
7. dialog renders the reason line when present; `CryptoBadge` renders the Stale overlay.

## Gates

crypto-core + crypto-smime `cargo test` + clippy; backend `cargo test --lib` + `cargo clippy --all-targets` (stay green); frontend tsc + eslint + prettier + vitest.

## Open questions

- `reason_code: None` → `Some("Unspecified")` vs `None`? Decision #5 chose `Some("Unspecified")` for a stable non-null signal; confirm at implementation (the RFC 5280 CRLReason enum has an explicit `Unspecified` variant, so mapping None→"Unspecified" is faithful).
