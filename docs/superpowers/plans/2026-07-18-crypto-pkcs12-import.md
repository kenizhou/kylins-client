# Plan — `.p12`/`.pfx` + Encrypted-PKCS#8 Import (Crypto Plan 3)

> Spec: `docs/superpowers/specs/2026-07-18-crypto-pkcs12-import-design.md`.
> Strict SDD: fresh implementer subagent per task → controller review → ledger.
> Branch: `fix/smime-receive-and-sign-details` (off `dd9f9ea`) — UNCOMMITTED
> (user controls git). 5 tasks; each RED→GREEN→REFACTOR inside the subagent.

## Task 1 — `crypto-smime`: `.p12`/`.pfx` parse + bag-PBE decrypt in `import_key`

**Files:** `kylins.client.crypto/smime/Cargo.toml`, `kylins.client.crypto/smime/src/lib.rs`.

1. RED: `import_key_p12_round_trips_cert_and_key` — build a `.p12` in-test (prefer
   `p12-keystore`'s own builder; else a minimal PFX via the cms/pkcs8 stack)
   with passphrase "test" → `import_key(data, Some("test"))` → re-export the
   cert + assert the fingerprint matches a direct cert build.
2. RED: `import_key_p12_wrong_passphrase_is_policy_error` — same fixture, wrong
   passphrase → `Err(CryptoError::Policy(_))`, NOT `Malformed`.
3. GREEN: add `p12-keystore = "0.3.1"` dep (verify der/spki line; bridge via raw
   DER if it's 0.7). Refactor `import_key` to: content-sniff PEM vs binary; the
   binary arm parses PFX → `take_shrouded_key(passphrase)` → (cert_der, priv_der)
   → shared `persist_imported` tail (extracted from the current body). Map the
   PBE-failure error to `CryptoError::Policy("p12 passphrase incorrect")`.
   Cert-only bag → `Malformed("p12: no private key in bag")`.
4. Verify RED→GREEN; keep the existing PEM path green.

**Gates:** `cargo test -p crypto-smime` + `cargo clippy --all-targets -D warnings`.

## Task 2 — `crypto-smime`: encrypted-PKCS#8 PEM arm

**Files:** `kylins.client.crypto/smime/src/lib.rs`.

1. RED: `import_key_encrypted_pkcs8_pem_round_trips` — PEM `ENCRYPTED PRIVATE
   KEY` + `CERTIFICATE` blocks (built in-test via `pkcs8::EncryptedPrivateKeyInfo`
   + a passphrase) → import → round-trip.
2. RED: `import_key_encrypted_pkcs8_wrong_passphrase_is_policy_error`.
3. GREEN: in the PEM arm, detect `ENCRYPTED PRIVATE KEY` →
   `pkcs8::EncryptedPrivateKeyInfo::from_der(block).decrypt(passphrase)` →
   priv_der (replaces the current NotImplemented stub). Map decrypt-failure →
   `CryptoError::Policy`. Empty/None passphrase + encrypted block →
   `Policy("encrypted PKCS#8 requires a passphrase")`.
4. RED: `import_key_unencrypted_pem_still_works` (regression guard on the refactor).

**Gates:** same.

## Task 3 — Backend IPC: thread the passphrase

**Files:** `kylins.client.backend/src/db/commands.rs`, `kylins.client.backend/src/lib.rs`.

1. `crypto_import_key_from_path_inner(pool, account_id, path, passphrase:
   Option<String>)` — wrap `passphrase.map(|p| SecretBox::new(Box::new(p)))` +
   pass to `import_key(&bytes, pass)`.
2. Tauri command `crypto_import_key_from_path(pool, account_id, path, passphrase:
   Option<String>)` mirrors. Register in `lib.rs` (already registered; signature
   change is compatible). Verify `capabilities/default.json` permits it (it does
   — the command is already allow-listed; only a param changes).
3. RED/verified: extend `tests/crypto_smime_lifecycle.rs` to import a `.p12`
   fixture (generated via openssl, skip-if-absent) through the command with a
   passphrase + assert a `crypto_keys` row lands.

**Gates:** `cargo test --lib` + `cargo clippy --all-targets -D warnings`.

## Task 4 — Frontend: `.p12`/`.pfx` filter + passphrase prompt + IPC param

**Files:** `kylins.client.frontend/src/services/db/cryptoKeys.ts`,
`kylins.client.frontend/src/components/preferences/KeyManagerSection.tsx`,
`kylins.client.frontend/src/components/preferences/PassphrasePrompt.tsx` (new).

1. `importKeyFromPath(accountId, path, passphrase?)` — pass `passphrase` to the
   invoke (camelCase: `{ accountId, path, passphrase }`).
2. `KeyManagerSection.onImport` — file-dialog filters gain `.p12`/`.pfx`. After
   picking, if the extension is `.p12`/`.pfx` (or sniff the file is non-PEM) OR
   the picked file is an encrypted PEM, open a `PassphrasePrompt` modal (labeled
   password input, OK/Cancel, ESC/Enter, ARIA `dialog`, focus management).
3. `PassphrasePrompt` — small modal component (mirrors the existing
   `LinkConfirmDialog`/modal pattern). Returns `string | null` (null = cancelled).
4. RED: `cryptoKeys.test` — assert `importKeyFromPath(a, p, 'secret')` invokes
   `crypto_import_key_from_path` with `{ accountId: a, path: p, passphrase:
   'secret' }`. `KeyManagerSection` test — picking a `.p12` opens the prompt.

**Gates:** `npx tsc --noEmit` + `npx eslint .` + `npx prettier --check .` +
`npx vitest run` (from `kylins.client.frontend/`).

## Task 5 — Final gates + controller review + ledger

1. Run all gates (crypto-smime + backend + frontend). Manual e2e left to the
   user (import a real Thunderbird-exported `.p12`).
2. Dispatch `feature-dev:code-reviewer` on the diff (correctness/security
   focus: fail-closed, passphrase zeroize, no plaintext-at-rest, no IPC
   capability gap). Record the verdict in the ledger.
3. Append the SDD ledger entry to `.superpowers/sdd/progress.md` (tasks 1-5,
   gates, deviations, carry-forwards: intermediates in the chain, `.p12`
   export, SHA-1-only bags).

## Carry-forwards (documented in the ledger)

- Intermediate/root certs in the `.p12` chain (leaf identity only).
- `.p12`/`.pfx` export.
- RSA/P-384/PSS build-side signing; PGP / Phase 2; SM2/3/4; P-521/Ed25519.
