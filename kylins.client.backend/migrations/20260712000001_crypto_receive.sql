-- Per-message crypto verification/decryption result (one row per message).
-- Lands in Plan 1 (G1) as the persistence target for later receive-crypto plans
-- (G2 decrypt, G3 verify). The `messages.is_encrypted` / `is_signed` flag columns
-- already exist on `messages` + `threads` (baseline); this table holds the richer
-- per-message outcome (decrypt state, signature state, signer identity, chain
-- validity, revocation state) written by the verify/decrypt pipeline.
CREATE TABLE IF NOT EXISTS message_crypto_results (
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
                        CHECK(revocation_state IN ('good','revoked','unchecked')),
    verified_at        TEXT NOT NULL,
    PRIMARY KEY (account_id, message_id),
    FOREIGN KEY (account_id, message_id) REFERENCES messages(account_id, id) ON DELETE CASCADE
);

-- CRL cache (keyed by distribution-point URL). Populated by G4; table lands here
-- so the migration is paired with its module. `next_update` drives
-- `prune_stale_crls(now_epoch)` which deletes rows whose next_update < now.
CREATE TABLE IF NOT EXISTS crl_cache (
    crl_url     TEXT PRIMARY KEY,
    crl_der     BLOB NOT NULL,
    issuer_dn   TEXT,
    next_update TEXT,
    fetched_at  TEXT NOT NULL
);

-- Raw CMS payload for encrypted / opaque-signed mail (`application/pkcs7-mime`
-- smime.p7m / multipart-signed body part). Plaintext is NEVER persisted through
-- this column — it stores the opaque CMS blob exactly as received so the
-- decrypt/verify pipeline can re-process it on demand. Nullable: most bodies
-- are plain text/html and never populate this.
ALTER TABLE message_bodies ADD COLUMN body_mime_ciphertext BLOB;
