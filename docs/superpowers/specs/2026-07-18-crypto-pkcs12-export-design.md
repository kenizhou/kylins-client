# Kylins Client — Crypto Plan 3b: `.p12`/`.pfx` Export

> **Status:** Approved (2026-07-18). The export mirror of Plan 3 import (Phase 1
> spec deferred `.p12` export). Strict SDD. **Parent:** `2026-07-10-crypto-phase1-smime-design.md`
> + `2026-07-18-crypto-pkcs12-import-design.md`. **Layers:** crypto-smime + backend + frontend.

## Goal

Let the user **export** an S/MIME identity (cert + private key + chain
intermediates) as a passphrase-protected `.p12`/`.pfx` from the KeyManager — the
mirror of the Plan 3 import. Use case: back up an identity, move it to another
machine/client. Today only the public cert DER is exportable (`export_public`);
the private key has no export path.

## Background (verified)

- `SmimeBackend::export_public(handle) -> Vec<u8>` (smime/lib.rs) returns the cert
  DER. No private-key export exists.
- The Plan 3 import TESTS already build PFX via `p12-keystore`'s writer API
  (`smime/src/lib.rs:1189 build_p12_fixture`): `KeyStore::new()` →
  `add_entry(KeyStoreEntry::PrivateKeyChain(PrivateKeyChain::new(name, key,
  vec![leaf, ...intermediates])))` → `ks.writer(password).encryption_algorithm(
  PbeWithHmacSha256AndAes256).mac_algorithm(HmacSha256).write() -> Vec<u8>`. So
  the builder is proven + on our dep line. Export = productionize that builder.
- The account's stored intermediates are queryable via
  `db::crypto_keys::list_intermediate_certs(account_id)` (the Plan 3b-intermediates task).
- Backend `crypto_export_public_to_path_inner` (db/commands.rs:1442) is the export
  path to mirror; frontend `KeyManagerSection.onExport` (DER save dialog) is the
  UI to extend.

## Decision log (locked)

| # | Decision | Choice |
|---|---|---|
| 1 | Format | PKCS#12/PFX via `p12-keystore` writer — **PbeWithHmacSha256AndAes256** content encryption + **HmacSha256** MAC (modern strong algorithms; matches the import fixtures; avoids legacy SHA-1/PBE1). |
| 2 | Passphrase | **REQUIRED, non-empty.** A `.p12` carrying a private key MUST be encrypted — refuse an empty passphrase (`CryptoError::Policy("p12 export requires a non-empty passphrase")`). `SecretBox<String>`-threaded like import; zeroized on drop; never logged/persisted beyond the written file (which is itself passphrase-encrypted). |
| 3 | Contents | Leaf cert + private key + the account's stored intermediates (`list_intermediate_certs`), leaf-first per `PrivateKeyChain::new`'s contract. Self-contained bundle (recipient can validate without re-fetching the chain). Symmetric with `import_key_with_chain`. |
| 4 | crypto-smime API | `SmimeBackend::export_p12(&self, handle, intermediate_ders: &[Vec<u8>], passphrase: &SecretBox<String>) -> Result<Vec<u8>>` — reads cert+key from the keystore (it owns it) + takes intermediates + passphrase as params. Pure build (the PFX is built in-memory; the file write is the backend's job, mirroring import's path-based I/O). |
| 5 | backend IPC | `crypto_export_p12_to_path(account_id, standard, fingerprint, passphrase: Option<String>, out_path)` — wraps the passphrase as `SecretBox` at the boundary, resolves intermediates, calls `export_p12`, writes the file. Path-based (dodges the plugin-fs appData scope, matching import/export_public). |
| 6 | Private-key presence | Export REFUSES a cert-only / public-only row (`has_private=false`) → `CryptoError::Policy("export_p12: key has no private material")` (can't build a PrivateKeyChain without the key). The UI grays-out the Export-.p12 button for public-only rows. |
| 7 | Build-side | NO `.p12` of a freshly-generated-only-cert without a key — same rule as #6. |

## Scope

**In:**
- crypto-smime `export_p12` (read cert+key from keystore + build PFX).
- backend `crypto_export_p12_to_path` command + registration.
- frontend `services/db/cryptoKeys.ts` `exportP12ToPath(...)`; `KeyManagerSection`
  gains an "Export .p12…" action (save dialog `.p12`/`.pfx` filter + `PassphrasePrompt`
  reuse + confirm-passphrase? — see Open Questions).

**Out (carry-forwards):** confirm-passphrase field (decide in Open Questions);
encrypted-PKCS#8 PEM export (only `.p12` for now); per-export encryption-algorithm
chooser (fixed strong default); exporting another account's intermediates.

## Data

No migration. Reads `crypto_keys` (the cert + private + intermediates) + writes a
user-chosen file. The passphrase never touches SQLite.

## Failure modes

- Empty passphrase → `Policy` (clear error).
- Public-only row (no private) → `Policy`.
- Wrong/nonexistent handle → `KeyNotFound` (existing pattern).
- File-write error → surfaced to the UI (existing `export_public_to_path` pattern).
- p12-keystore writer error → `Malformed`/`Policy` (mapped via the existing
  `map_p12_error`-style helper or a new `map_p12_write_error`).

## Security

- **Private key leaves the keystore ONLY inside `export_p12`'s scope** — read via
  `keystore.get`, wrapped in `Zeroizing<Vec<u8>>` (same hygiene as `sign`/`decrypt`),
  PFX-built, returned; the Zeroizing clone is wiped on drop. The backend writes the
  PFX bytes (already passphrase-encrypted) to the user-chosen path; plaintext
  private bytes never hit disk unencrypted.
- **Passphrase**: `SecretBox` + zeroize; never logged; required non-empty.
- **No new SQL/HTML/IPC-capability**: the command mirrors the existing
  `crypto_export_public_to_path` (already permitted); only a new command
  registration in `lib.rs` + the standard invoke permission.
- The exported file is attacker-accessible only if the user's filesystem is — and
  it's passphrase-encrypted (AES-256 + HMAC-SHA-256). Standard `.p12` threat model.

## Performance

One-shot user action (ms-scale PBE + AES). No caching. Async Tauri command.

## UX / A11y / i18n

- KeyManager row gains an "Export .p12…" button (alongside the existing DER-export
  icon). Disabled for `has_private=false` rows (tooltip "No private key to export").
- `PassphrasePrompt` reuse (the import prompt) — labeled "Choose a passphrase for
  the .p12 file". ARIA dialog, focus, ESC/Enter (the existing component).
- Save dialog `.p12`/`.pfx` filter, default filename `smime-<email>.p12`.
- Toasts: "Identity exported" / "Export failed: …".

## Tests (TDD — implementer subagent)

crypto-smime:
1. `export_p12_round_trips_through_import` — generate a key, export_p12 with
   "testpw", re-import_key_with_chain the PFX → the leaf cert + fingerprint match.
2. `export_p12_bundles_intermediates` — export with intermediates → re-import →
   the intermediates come back.
3. `export_p12_refuses_empty_passphrase` → `Policy`.
4. `export_p12_refuses_public_only_key` (no private) → `Policy`.

backend (`crypto_smime_lifecycle.rs` or unit):
5. `crypto_export_p12_to_path_writes_pfx` — round-trip via the IPC inner fn → file
   exists + re-imports.

frontend:
6. `KeyManagerSection` — "Export .p12" opens the passphrase prompt → save dialog →
   invokes `crypto_export_p12_to_path`; disabled for public-only rows.

## Gates

crypto-smime `cargo test` + clippy; backend `cargo test --lib` + `cargo clippy
--all-targets` (the now-green full gate); frontend tsc + eslint + prettier + vitest.

## Open questions

- **Confirm-passphrase field?** A single passphrase entry risks a typo (user
  locks themselves out of their backup). A confirm field (two inputs, must match)
  is the standard UX for "create a password that protects a key". Recommend YES
  (extend `PassphrasePrompt` with an optional confirm mode) — but it's a UX
  decision. Default: add the confirm field for export (not import — import
  validates against an existing passphrase).
