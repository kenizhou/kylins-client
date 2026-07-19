# Kylins Client — Crypto Plan 3: `.p12`/`.pfx` + Encrypted-PKCS#8 Import Design

> **Status:** Approved (2026-07-18). Closes the Phase 1 spec decision #3 primary
> import format (".p12/.pfx primary via p12-keystore") + the `import_key`
> "encrypted PKCS#8 import — Plan 3" NotImplemented stub. Strict SDD (user
> 2026-07-18 directive: spec → plan → implementer subagent → controller review
> → ledger).
> **Parent:** `docs/superpowers/specs/2026-07-10-crypto-phase1-smime-design.md`
> (decision #3) + `docs/superpowers/specs/2026-07-10-crypto-security-module-design.md`
> (§4.5 at-rest, §7 IPC). **Crate:** `kylins.client.crypto/smime` + backend IPC.

## Goal

Let a user import a CA-issued S/MIME identity from a **`.p12`/`.pfx`** file (the
format CAs actually distribute) — and, as a secondary path, an
**encrypted-PKCS#8 PEM** (`ENCRYPTED PRIVATE KEY` + `CERTIFICATE`) — via the
KeyManager UI, with a passphrase prompt. The imported cert + private key persist
to `crypto_keys` (private blob AES-GCM-encrypted at rest via the OS-keyring
master key, unchanged). Retires the `NotImplemented("encrypted PKCS#8 import —
Plan 3")` stub + the PEM-only limitation.

## Background (verified against current code)

- `SmimeBackend::import_key(data, _passphrase)` (`smime/src/lib.rs:490`) parses
  PEM blocks only (`CERTIFICATE` + `PRIVATE KEY`); rejects `ENCRYPTED PRIVATE
  KEY` with `CryptoError::NotImplemented("encrypted PKCS#8 import — Plan 3")`.
  The `passphrase` param is **ignored** (prefixed `_`).
- Backend `crypto_import_key_from_path_inner(pool, account_id, path)`
  (`db/commands.rs:1392`) reads the file + calls `import_key(&bytes, None)` —
  **no passphrase threading**.
- Frontend `KeyManagerSection.onImport` (`preferences/KeyManagerSection.tsx:89`)
  opens a file dialog with a **PEM-only filter** (`.pem/.crt/.cer/.key/.txt`) +
  calls `importKeyFromPath(accountId, path)` (`services/db/cryptoKeys.ts:56`) —
  no passphrase.
- At-rest: `SqliteKeyStore` (`keystore_bridge.rs`) AES-GCM-encrypts
  `private_data` via `encrypt_with_aad` (master key from the OS keyring). The
  bag passphrase is used ONLY to decrypt the bag in-memory; it is never persisted.
- Dep: `p12-keystore = "0.3.1"` (stable, 2026-06-19, pure-Rust, edition 2024,
  MSRV 1.85 — matches our line). **Verify the der/spki/x509-cert line it pulls at
  implementation start** (the registry didn't expose deps); if it lands on the 0.7
  line, bridge via raw DER bytes the way `chain.rs` does (re-parse the 0.3-built
  cert DER into the aliased `x509-cert-v02`). Fall back to the `pkcs12` crate
  only if `p12-keystore` fails to resolve.

## 1. Decision log (locked this session)

| # | Decision | Choice |
|---|---|---|
| 1 | Scope | `.p12`/`.pfx` (primary, per Phase 1 #3) **+** encrypted-PKCS#8 PEM (the Plan 3 NotImplemented stub) **+** keep the existing unencrypted-PEM path working. All three share the passphrase infra. |
| 2 | Format detection | By **content**, not extension. PEM iff the bytes are UTF-8 starting with `-----BEGIN`; else binary PKCS#12 (DER SEQUENCE). Lets a `.crt`/`.cer`/`.p12`/`.pfx`/keyless extension import correctly. |
| 3 | Passphrase handling | `SecretBox<String>` (the trait already takes `Option<SecretBox<String>>`). Zeroized on drop. Threaded UI → IPC → `import_key`. **Never logged, never persisted.** Empty/None passphrase supported (unencrypted bags + unencrypted PEM PKCS#8 still import). |
| 4 | Bag contents | Import the **leaf cert that pairs with the private key** as the identity row (matching the existing PEM path's one-cert-one-key model). Intermediates/root in the bag are a **carry-forward** (the receive orchestrator already extracts intermediates from SignedData; CA roots import separately via TrustedCasSection). |
| 5 | Key algorithm | The leaf cert's SPKI algorithm OID drives the `KeyHandleRef.algorithm` label (`algorithm_label` already maps ECDSA-P256/RSA/Ed25519). RSA certs import (useful for ktri **decryption**) even though `sign` still rejects non-P256 (pre-existing; not this task's concern). |
| 6 | At-rest | Unchanged. The decrypted private key bytes go into `KeyStore::put` as a `SecretBox`; `SqliteKeyStore` AES-GCM-encrypts via the master key. The bag passphrase is NOT stored. |
| 7 | Wrong passphrase | `CryptoError::Policy("p12 passphrase incorrect")` (a clear user-facing error → "Import failed: passphrase incorrect" toast). NOT `Malformed` (the CMS parsed fine; the PBE failed). Distinguish from structurally-malformed input (`Malformed`). |
| 8 | `.p12` export | Out of scope (Phase 1 spec explicitly defers `.p12` export). |

## 2. Goals

- `SmimeBackend::import_key` accepts `.p12`/`.pfx` binary + encrypted-PKCS#8 PEM
  (+ existing unencrypted PEM), decrypting the bag/PBE with the supplied
  passphrase, extracting the leaf cert + private key, persisting via `KeyStore`.
- Backend `crypto_import_key_from_path` threads a passphrase; frontend
  `importKeyFromPath` gains a passphrase param + a passphrase-prompt modal.
- The KeyManager file dialog accepts `.p12`/`.pfx` extensions.

## 3. Scope

**In:**
- `crypto-smime` `SmimeBackend::import_key` — content-sniff (PEM vs PKCS#12),
  `p12-keystore` parse + bag-PBE decrypt, encrypted-PKCS#8 PEM decrypt (`pkcs8`
  `EncryptedPrivateKeyInfo`), leaf-cert + private-key extraction, persist via
  the existing `KeyStore::put` path.
- Backend `crypto_import_key_from_path(_inner)` gains a `passphrase: Option<String>`
  param (the IPC carries a plaintext passphrase string — same channel as the
  existing path; Tauri IPC is local same-process, no network). Wrapped in a
  `SecretBox` at the `import_key` boundary.
- Frontend `services/db/cryptoKeys.ts#importKeyFromPath` gains a `passphrase`
  param; `KeyManagerSection.onImport` gains `.p12`/`.pfx` filter entries + a
  passphrase-prompt modal (a small inline input + OK/Cancel; ESC cancels). If
  the picked file is `.p12`/`.pfx` (or PEM `ENCRYPTED PRIVATE KEY`), prompt;
  unencrypted PEM skips the prompt.

**Out (carry-forwards):**
- Intermediate/root certs in the `.p12` chain (the leaf identity only).
- `.p12`/`.pfx` **export**.
- PFX SHA-1-only bags where the MAC is SHA-1 (p12-keystore's `pbes1` feature
  handles legacy PBE; flag if a specific bag shape fails — document, don't block).
- PGP / SM2/3/4; P-521/Ed25519; RSA/P-384/PSS build-side signing.

## 4. Architecture

### 4.1 `import_key` flow

```
import_key(data, passphrase)
  │
  ├─ is_pem(data)? ──► PEM path (existing, extended)
  │     │  parse_pem_blocks → blocks
  │     │  if ENCRYPTED PRIVATE KEY present:
  │     │     passphrase required → pkcs8::EncryptedPrivateKeyInfo::from_der
  │     │       .decrypt(passphrase) → priv_der
  │     │  else (PRIVATE KEY): priv_der = block bytes (existing)
  │     │  CERTIFICATE block → cert_der (existing)
  │     └─ build StoredKey → keystore.put
  │
  └─ else ──► PKCS#12 path (NEW)
        │  p12_keystore::p12::PfxUtils::parse_der(data)
        │    .map(|pfx| pfx.take_shrouded_key(passphrase))   // PBE decrypt
        │  → (cert_der, priv_der)
        │  build StoredKey (same as PEM path's tail) → keystore.put
```

The PEM + P12 paths converge on a shared `persist_imported(cert_der, priv_der)`
tail (extracts the SPKI algorithm label, computes the SKI fingerprint, builds
the `StoredKey`, calls `keystore.put`) — factored out of the current `import_key`
body so both paths share the at-rest + fingerprint logic.

### 4.2 Passphrase as `SecretBox`

The trait signature is fixed: `import_key(&self, data: &[u8], pass:
Option<SecretBox<String>>)`. The backend IPC wraps the incoming `String`:
`pass.map(|p| SecretBox::new(Box::new(p)))`. The `SecretBox` is `zeroize`d on
drop (crypto-core's `secret::expose_bytes` exposes it only within the
`import_key` scope). Private material never leaves `import_key`.

### 4.3 Wrong-passphrase discrimination

`p12-keystore` returns a typed error on PBE failure; map it to
`CryptoError::Policy("p12 passphrase incorrect")`. `pkcs8`'s
`EncryptedPrivateKeyInfo::decrypt` failure → same `Policy` mapping. A
structurally-malformed PFX/PEM → `CryptoError::Malformed`. The backend maps
`Policy` → a user-facing string; the frontend toast distinguishes "passphrase
incorrect" from "file unreadable".

## 5. Data

**No schema change.** The `crypto_keys` table + `SqliteKeyStore` at-rest path
are reused verbatim (the imported key lands as a `StoredKey` with
`public_data = cert_der`, `private_data = SecretBox(priv_der)`,
`key_type='sign+encrypt'`, `standard='smime'`). The bag passphrase is never
written to SQLite.

## 6. Failure modes

- Wrong passphrase → `Policy` → "passphrase incorrect" toast (user can retry).
- Malformed file → `Malformed` → "file unreadable" toast.
- Bag with no private key (cert-only `.p12`) → `Malformed("p12: no private key
  in bag")` (this is an identity-import flow; a cert-only bag belongs in the
  Trusted-CAs flow, not here).
- `p12-keystore` dep-line mismatch (0.7 vs 0.8) → bridge via raw DER (re-parse
  the 0.3 cert/key DER into aliased types) OR fall back to the `pkcs12` crate;
  decided at implementation time, documented in the ledger.

## 7. Security

- **Passphrase**: `SecretBox` + zeroize; never logged/persisted; IPC is local
  same-process (Tauri) — no network exposure. Same channel as the existing
  path-based import.
- **At-rest**: unchanged (master-key AES-GCM via `SqliteKeyStore`).
- **Private material**: never crosses the IPC boundary; only `KeyHandleRef`
  returns (public row).
- **No new SQL**; **no new HTML/sandbox**; the IPC command already exists
  (`crypto_import_key_from_path`) — only gains a param (no capability change
  needed; verify `capabilities/default.json` permits it, which it already does).
- Format sniff by content (not extension) avoids trusting the user's file
  extension for crypto-routing decisions.

## 8. Performance

Import is a one-shot user action (ms-scale PBE + AES). No caching concern. Runs
in the async Tauri command (the `import_key` impl is already async via the
`KeyStore` seam). No UI-thread work.

## 9. UX / A11y / i18n

- File dialog gains `.p12`/`.pfx` filter entries (alongside PEM).
- Passphrase prompt: a small modal with a labeled password input, OK/Cancel,
  ESC-to-cancel, Enter-to-submit. ARIA `dialog` + `label` on the input. Focus
  the input on open; return focus to the Import button on close.
- Toasts: "Key imported" (success), "Import failed: passphrase incorrect" /
  "Import failed: file unreadable" (error — distinguish the two).
- Strings externalization-ready (no hardcoded English in the hot path beyond
  the existing component's style).

## 10. Tests (TDD — inside the implementer subagent)

Unit (no openssl), in `smime/src/lib.rs` tests:
1. `import_key_p12_round_trips_cert_and_key` — build a `.p12` in-test via
   `p12-keystore`'s builder (if it exposes one) OR via the cms/pkcs8 stack
   (cert + key → `p12_keystore::p12` builder) with a known passphrase → import
   → re-export the cert + assert fingerprint matches a direct build.
2. `import_key_p12_wrong_passphrase_is_policy_error` — same `.p12`, wrong
   passphrase → `Err(CryptoError::Policy(_))` (not `Malformed`).
3. `import_key_encrypted_pkcs8_pem_round_trips` — PEM `ENCRYPTED PRIVATE KEY` +
   `CERTIFICATE` with a passphrase → import → round-trip.
4. `import_key_encrypted_pkcs8_wrong_passphrase_is_policy_error`.
5. `import_key_unencrypted_pem_still_works` — regression: the existing PEM path
   (no passphrase) still imports (guards against the refactor breaking it).

Interop (skip if openssl absent), in `smime/src/interop_tests.rs`:
6. `openssl_p12_imports_with_our_code` — `openssl pkcs12 -export -inkey … -in …
   -passout pass:test` → our `import_key` → round-trip the cert + key.

Frontend: extend `cryptoKeys.test` to assert `importKeyFromPath(accountId, path,
passphrase)` invokes `crypto_import_key_from_path` with the passphrase arg.

## 11. Gates

crypto-smime `cargo test` + `cargo clippy --all-targets -D warnings`; backend
`cargo test --lib` + clippy (the IPC + `SqliteKeyStore` path is backend-exercised
via `tests/crypto_smime_lifecycle.rs`); frontend `npx tsc --noEmit` + `npx
vitest run` + eslint + prettier (from `kylins.client.frontend/`).

## 12. Open questions

- `p12-keystore`'s exact builder API for the in-test `.p12` fixture (vs needing
  openssl) — resolve at implementation start; prefer the in-test builder so the
  unit tests don't depend on openssl.
- Whether `p12-keystore` pulls the 0.7 or 0.8 der line — bridge if 0.7.
