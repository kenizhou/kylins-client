-- Crypto identity keys/certs, trust decisions, and collected (staging) keys.
-- Soft private-key blobs are stored as the hex produced by crypto::encrypt_with_aad
-- (AES-256-GCM under the OS-keyring master key, AAD-bound). Token-backed keys
-- leave private_data_enc NULL and reference the device via token_serial/token_key_id.

CREATE TABLE crypto_keys (
    id               TEXT PRIMARY KEY,
    account_id       TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    standard         TEXT NOT NULL CHECK(standard IN ('openpgp','smime','sm')),
    key_type         TEXT NOT NULL CHECK(key_type IN ('public','private','cert')),
    email            TEXT,
    fingerprint      TEXT NOT NULL,
    public_data      BLOB NOT NULL,            -- armored PGP / DER cert / SM2 cert
    private_data_enc BLOB,                     -- hex(0x01‖nonce‖ct) of soft private key; NULL for public-only/token
    token_serial     TEXT,
    token_key_id     TEXT,
    origin           TEXT NOT NULL CHECK(origin IN ('generated','imported','wkd','keyserver','autocrypt','contact')),
    is_default_sign    INTEGER NOT NULL DEFAULT 0,
    is_default_encrypt INTEGER NOT NULL DEFAULT 0,
    created_at       TEXT NOT NULL,
    expires_at       TEXT,
    policy_json      TEXT,
    UNIQUE(account_id, standard, fingerprint)
);
CREATE INDEX idx_crypto_keys_email    ON crypto_keys(standard, email);
CREATE INDEX idx_crypto_keys_account  ON crypto_keys(account_id, standard);

-- Silent staging: keys seen via discovery but NOT yet accepted.
CREATE TABLE collected_keys (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    account_id   TEXT,
    peer_email   TEXT,
    standard     TEXT,
    fingerprint  TEXT,
    public_data  BLOB,
    source       TEXT,
    seen_at      TEXT NOT NULL
);
CREATE INDEX idx_collected_keys_peer ON collected_keys(account_id, peer_email, standard);

-- Append-only trust/acceptance audit history (never UPDATE/DELETE).
CREATE TABLE trust_decisions (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    account_id    TEXT NOT NULL,
    peer_email    TEXT NOT NULL,
    standard      TEXT NOT NULL,
    fingerprint   TEXT NOT NULL,
    decision      TEXT NOT NULL CHECK(decision IN ('rejected','undecided','unverified','verified','personal')),
    evidence_json TEXT,
    decided_at    TEXT NOT NULL
);
CREATE INDEX idx_trust_lookup ON trust_decisions(account_id, peer_email, standard, fingerprint, decided_at);

ALTER TABLE accounts ADD COLUMN crypto_method TEXT DEFAULT 'none';      -- none|openpgp|smime|sm
ALTER TABLE accounts ADD COLUMN crypto_policy_json TEXT;
ALTER TABLE contacts ADD COLUMN pinned_keys_json TEXT;                  -- [{standard, fingerprint, data}]
