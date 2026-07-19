-- CRL Revocation Detail (2026-07-18 spec
-- `2026-07-18-crypto-crl-detail-design.md`).
--
-- Two schema changes for the price of one migration:
--
-- 1. New `revocation_reason TEXT` column — the structured RFC 5280 §5.3.1
--    CRLReason name (e.g. "KeyCompromise", "Superseded") surfaced as a
--    distinct column rather than buried inside the free-form `failure_reason`
--    text. Threaded end-to-end through `ChainOutcome.revocation_reason`
--    (crypto-smime) → `VerificationResult.revocation_reason` (crypto-core) →
--    this column → `get_signer_details` → the Signature Details dialog
--    (rendered as a distinct "Reason: <name>" line). Populated only when
--    `revocation_state = 'revoked'` AND the CRL entry carried a CRLReason
--    extension (a revoked cert whose CRL entry omitted reasonCode surfaces
--    `Some("Unspecified")` at the crypto layer, persisted here verbatim).
--    Nullable, no default, no backfill — pre-migration rows + all non-revoked
--    outcomes + the early-return arms where chain validation never ran
--    surface NULL. The dialog omits the "Reason: …" line when NULL.
--
-- 2. Relax the `revocation_state` CHECK constraint to accept the new
--    `'stale'` value (a CRL covered the cert but was unusable — expired past
--    nextUpdate / bad sig / out-of-scope / parse error). The spec decision #4
--    said "no schema change for the Stale variant (TEXT)" but that assumed
--    no CHECK constraint; the base migration (`20260712000001_crypto_receive.sql`)
--    DID add one allowing only ('good','revoked','unchecked'). Without
--    relaxing it, `build_crypto_result_row` would error trying to write
--    'stale'. The new CHECK allows all four values.
--
-- SQLite ALTER TABLE ADD COLUMN handles (1) directly. (2) requires recreating
-- the table (SQLite cannot ALTER a CHECK constraint in place). The standard
-- SQLite 12-step table-recreate pattern is used (see
-- https://www.sqlite.org/lang_altertable.html#otheralter). Because we're
-- recreating a CHILD table (FK from message_crypto_results → messages), and
-- the parent messages table is untouched, FK enforcement does not interfere.
-- sqlx::migrate! runs each migration in its own transaction; the data
-- round-trip is atomic.
--
-- This deviation from spec decision #4 is flagged in the implementer report.

-- Step 1: add the column via ALTER (cheap, in-place). The CHECK relaxation
-- in step 2 will preserve this column.
ALTER TABLE message_crypto_results ADD COLUMN revocation_reason TEXT;

-- Step 2: recreate the table with the relaxed CHECK constraint. The new
-- schema mirrors the original (20260712000001) + the failure_reason column
-- added by migration 20260718300000 + the revocation_reason column added
-- above, with the ONLY intentional change being the CHECK list (now includes
-- 'stale').
CREATE TABLE message_crypto_results_new (
    account_id         TEXT NOT NULL,
    message_id         TEXT NOT NULL,
    crypto_kind        TEXT NOT NULL CHECK(crypto_kind IN ('encrypted','signed','encrypted-signed')),
    decrypt_state      TEXT NOT NULL CHECK(decrypt_state IN ('ok','no-key','failed','n/a')),
    signature_state    TEXT NOT NULL CHECK(signature_state IN
                          ('not-signed','valid-verified','valid-unverified','invalid','unknown-key','mismatch')),
    signer_fingerprint TEXT,
    signer_email       TEXT,
    chain_valid        INTEGER,
    revocation_state   TEXT NOT NULL DEFAULT 'unchecked'
                        CHECK(revocation_state IN ('good','revoked','unchecked','stale')),
    verified_at        TEXT NOT NULL,
    failure_reason     TEXT,
    revocation_reason  TEXT,
    PRIMARY KEY (account_id, message_id),
    FOREIGN KEY (account_id, message_id) REFERENCES messages(account_id, id) ON DELETE CASCADE
);

-- Copy all existing rows + the new column's values (NULL for back-filled rows).
INSERT INTO message_crypto_results_new
    (account_id, message_id, crypto_kind, decrypt_state, signature_state,
     signer_fingerprint, signer_email, chain_valid, revocation_state, verified_at,
     failure_reason, revocation_reason)
SELECT account_id, message_id, crypto_kind, decrypt_state, signature_state,
       signer_fingerprint, signer_email, chain_valid, revocation_state, verified_at,
       failure_reason, revocation_reason
FROM message_crypto_results;

-- Swap in the new table. The 12-step procedure's "DROP old + RENAME new"
-- pair, omitting the optional index/trigger/view recreation steps because
-- the base migration declares neither on this table.
DROP TABLE message_crypto_results;
ALTER TABLE message_crypto_results_new RENAME TO message_crypto_results;
