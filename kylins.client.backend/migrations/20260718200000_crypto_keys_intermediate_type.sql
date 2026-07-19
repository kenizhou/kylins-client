-- Extend `crypto_keys.key_type` to admit `'intermediate'` and `crypto_keys.origin`
-- to admit `'p12-intermediate'`, so S/MIME intermediate CA certs from an imported
-- `.p12`/`.pfx` chain can be persisted (spec: 2026-07-18-crypto-pkcs12-intermediates-design.md).
--
-- Intermediates are stored with `key_type='intermediate'` — a NEW value the
-- original CHECK constraint rejected. The original constraint allowed only
-- `('public','private','cert')`; adding `'intermediate'` keeps intermediates
-- OUT of the trust-anchor candidate set (filtered by `key_type='cert'` in
-- `list_trust_anchor_certs`). An intermediate as an anchor would let any cert
-- it signs validate as "trusted" — a trust overreach (the G4 corporate-PKI
-- landmine the receive path documents). See `upsert_intermediate_cert` in
-- db/crypto_keys.rs.
--
-- SQLite cannot ALTER a column's CHECK in place; the table-rebuild dance
-- (CREATE new → INSERT … SELECT → DROP old → RENAME) is the standard pattern.
-- No other table REFERENCES crypto_keys (verified), so FK re-binding is a
-- non-issue and the rebuild runs inside the migration's own transaction.

CREATE TABLE crypto_keys__new (
    id               TEXT PRIMARY KEY,
    account_id       TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    standard         TEXT NOT NULL CHECK(standard IN ('openpgp','smime','sm')),
    key_type         TEXT NOT NULL CHECK(key_type IN ('public','private','cert','intermediate')),
    email            TEXT,
    fingerprint      TEXT NOT NULL,
    public_data      BLOB NOT NULL,            -- armored PGP / DER cert / SM2 cert
    private_data_enc BLOB,                     -- hex(0x01‖nonce‖ct) of soft private key; NULL for public-only/token
    token_serial     TEXT,
    token_key_id     TEXT,
    origin           TEXT NOT NULL CHECK(origin IN ('generated','imported','wkd','keyserver','autocrypt','contact','p12-intermediate')),
    is_default_sign    INTEGER NOT NULL DEFAULT 0,
    is_default_encrypt INTEGER NOT NULL DEFAULT 0,
    created_at       TEXT NOT NULL,
    expires_at       TEXT,
    policy_json      TEXT,
    UNIQUE(account_id, standard, fingerprint)
);

INSERT INTO crypto_keys__new (
    id, account_id, standard, key_type, email, fingerprint, public_data,
    private_data_enc, token_serial, token_key_id, origin,
    is_default_sign, is_default_encrypt, created_at, expires_at, policy_json
)
SELECT
    id, account_id, standard, key_type, email, fingerprint, public_data,
    private_data_enc, token_serial, token_key_id, origin,
    is_default_sign, is_default_encrypt, created_at, expires_at, policy_json
FROM crypto_keys;

DROP INDEX IF EXISTS idx_crypto_keys_email;
DROP INDEX IF EXISTS idx_crypto_keys_account;
DROP TABLE crypto_keys;
ALTER TABLE crypto_keys__new RENAME TO crypto_keys;

CREATE INDEX idx_crypto_keys_email    ON crypto_keys(standard, email);
CREATE INDEX idx_crypto_keys_account  ON crypto_keys(account_id, standard);
