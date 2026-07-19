# Plan — `.p12`/`.pfx` Export

> Spec: `docs/superpowers/specs/2026-07-18-crypto-pkcs12-export-design.md`. Strict SDD.
> Branch `fix/smime-receive-and-sign-details` (off `c941d64`). UNCOMMITTED.

## Task 1 — crypto-smime `export_p12`

**Files:** `kylins.client.crypto/smime/src/lib.rs`.

1. RED: `export_p12_round_trips_through_import` — generate key → `export_p12(handle,
   &[], passphrase)` → `import_key_with_chain(pfx, passphrase)` → leaf matches.
2. RED: `export_p12_bundles_intermediates`, `export_p12_refuses_empty_passphrase`,
   `export_p12_refuses_public_only_key`.
3. GREEN: `pub async fn export_p12(&self, handle, intermediate_ders, passphrase:
   Option<SecretBox<String>>) -> Result<Vec<u8>>` — read cert via the keystore
   (`export_public` path) + private via `keystore.get` (Zeroizing the priv clone,
   same hygiene as `sign`); require non-empty passphrase (`Policy`); require
   private present (`Policy`); build via `p12_keystore::KeyStore::new()` +
   `PrivateKeyChain::new("smime-identity", key, vec![leaf, ...intermediates])` +
   `ks.writer(pass).encryption_algorithm(PbeWithHmacSha256AndAes256)
   .mac_algorithm(HmacSha256).write()`. Map writer errors.

**Gates:** `cargo test -p crypto-smime` + clippy.

## Task 2 — backend IPC

**Files:** `kylins.client.backend/src/db/commands.rs`, `src/lib.rs`.

1. `crypto_export_p12_to_path_inner(pool, account_id, standard, fingerprint,
   passphrase: Option<String>, out_path)` — wrap passphrase as `SecretBox`,
   resolve intermediates (`list_intermediate_certs`), build the handle, call
   `export_p12`, `std::fs::write`. Register the `#[tauri::command]` in `lib.rs`.
2. RED→GREEN: `crypto_export_p12_to_path_writes_pfx` (round-trip via the inner fn).

**Gates:** `cargo test --lib` + `cargo clippy --all-targets` (stay green).

## Task 3 — frontend

**Files:** `cryptoKeys.ts`, `KeyManagerSection.tsx`, `PassphrasePrompt.tsx`.

1. `exportP12ToPath(accountId, standard, fingerprint, passphrase, outPath)`.
2. `PassphrasePrompt` gains an optional **confirm mode** (two inputs, must match,
   mismatch shows an inline error + blocks submit) — used for export (key-backup
   UX). Import keeps single-field.
3. `KeyManagerSection` row: add "Export .p12…" button (disabled for
   `has_private=false`) → PassphrasePrompt(confirm) → save dialog (`.p12`/`.pfx`,
   default `smime-<email>.p12`) → invoke.
4. Tests: export-p12 flow invokes the command; confirm-mismatch blocks; disabled
   on public-only.

**Gates:** tsc + eslint + prettier + vitest.

## Task 4 — Final gates + controller review + ledger

Manual e2e (export an identity → re-import on a fresh account / another client)
left to the user.

## Carry-forwards

Encrypted-PKCS#8 PEM export; per-export algorithm chooser; exporting another
account's intermediates; a KeyManager "export all" bulk action.
