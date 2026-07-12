# Plan 4b — S/MIME Composer Wiring + KeyManager Design

> **Status:** Draft (brainstormed 2026-07-12; extend-SecurityPreferences confirmed).
> **Parent:** `docs/superpowers/specs/2026-07-10-crypto-phase1-smime-design.md` §6 (UI scope) + **Plan 4a** (`docs/superpowers/specs/2026-07-11-crypto-phase1-smime-send-hook-design.md` — the backend send-hook, committed `456ec67`).
> **Decomposition:** Plan 4 = **4a (backend send-hook, DONE)** → **4b (this doc, composer wiring + KeyManager)**. The sent-row CryptoBadge (`is_encrypted`/`is_signed` propagation) is deferred — it needs the local-Sent-row vs receive-parse decision (separate design).

## 0. Decision log (locked this session)

| # | Decision | Choice |
|---|---|---|
| 1 | Scope | **Composer wiring + KeyManager** (sent-row CryptoBadge deferred). Makes the feature fully useful end-to-end: a user can manage S/MIME keys AND the existing composer Encrypt/Sign toggles produce real signed/encrypted mail. |
| 2 | KeyManager placement | **Extend `SecurityPreferences`** (add a "Your S/MIME Keys" `PreferencesSectionCard` below the icon picker). Natural home (same Security tab); avoids a new tab. |
| 3 | KeyManager UI pattern | **Mirror `SignaturesPreferences`** — account picker + master/detail list (rows: email/fingerprint/origin/has-private + "Default" chip) + action buttons. |
| 4 | Backend runtime | **Per-call `SmimeBackend`** in each new command (`SmimeBackend::new(Arc::new(SqliteKeyStore::new(pool, account_id)), policy)`) — consistent with `send_op`; cheap; no Tauri `State` plumbing. |
| 5 | Set-default atomicity | **New transactional `db_set_default_signing_key`** (un-flag previous default + flag new, in one tx). The current `db_upsert_crypto_key` path isn't atomic + leaves multiple rows flagged → `get_default_signing_key` (`LIMIT 1`) resolves ambiguously. |
| 6 | Import UX | **Single PEM bundle file** (one file-dialog pick; the file may contain both `CERTIFICATE` + `PRIVATE KEY` blocks — `parse_pem_blocks` already handles it). Separate cert/key files = fast-follow. |
| 7 | Import scope | **PEM, unencrypted only for v1.** Encrypted PKCS#8 / `.p12` is Plan 3 (the existing `SmimeBackend::import_key` returns `NotImplemented("encrypted PKCS#8 import — Plan 3")` for encrypted bundles). |
| 8 | Generate | `crypto_generate_key(account_id, email)` → `SmimeBackend::generate_key` (self-signed ECDSA-P256 cert, SAN=email). For local/testing use; real S/MIME certs arrive via import. |
| 9 | Composer intent derivation | **Any-true ⇒ smime**: `cryptoMethod = (isEncrypted \|\| isSigned) ? 'smime' : 'none'`. No `cryptoMethod` field in `composerStore` — the two booleans fully determine intent. |
| 10 | Private key boundary | Private bytes never leave the backend. Import/generate persist via `SmimeBackend.*` → `keystore.put` → `upsert_crypto_key` (private at-rest via the master key). `CryptoKeyRow` (the IPC type) is public-only (`hasPrivate: bool` flag, no bytes). |

## 1. Composer wiring (frontend, small)

The `ComposeRibbon` Encrypt/Sign `RibbonToggle`s + `composerStore.isEncrypted`/`isSigned` ALREADY EXIST (Plan 4a exploration). The gap: `sendEmail` (`services/composer/send.ts:79-84`) doesn't pass them to `buildSendDraft`'s 5th `crypto?: SendCryptoOptions` arg, so `SendDraft.crypto_method/sign/encrypt` always default false.

**Changes:**
- `services/composer/drafts.ts` `DraftInput` type: add `isEncrypted?: boolean; isSigned?: boolean` (currently ad-hoc on the `input` literal at `Composer.tsx:530-531`).
- `services/composer/send.ts` `sendEmail`: derive + pass `crypto` to `buildSendDraft`:
  ```ts
  const crypto: SendCryptoOptions | undefined =
    input.isEncrypted || input.isSigned
      ? { cryptoMethod: 'smime', sign: !!input.isSigned, encrypt: !!input.isEncrypted }
      : undefined;
  const draft = await buildSendDraft(input, sendDraftId, account.email, account.displayName ?? undefined, crypto);
  ```
  (`SendCryptoOptions` + `buildSendDraft`'s 5th arg already exist from Plan 4a Task 1.)

**No new toggle UI.** The existing ribbon toggles + classification-driven side-effect (`ClassificationSelector`) now reach the backend.

## 2. Backend Tauri commands (medium)

Five new commands in `kylins.client.backend/src/db/commands.rs` (+ `lib.rs` registration). Each constructs a per-call `SmimeBackend` over a `SqliteKeyStore` bound to `account_id` (mirror `send_op`'s construction at `engine.rs:1011`):

```text
crypto_generate_key(account_id, email)             -> Result<CryptoKeyRow, String>
crypto_import_key(account_id, pem_bytes: Vec<u8>)  -> Result<CryptoKeyRow, String>
crypto_export_public(account_id, standard, fingerprint) -> Result<Vec<u8>, String>
db_delete_crypto_key(account_id, standard, fingerprint) -> Result<(), String>
db_set_default_signing_key(account_id, standard, fingerprint) -> Result<(), String>
```

- **`crypto_generate_key` / `crypto_import_key`**: wrap `SmimeBackend::generate_key` / `import_key` (which call `keystore.put` internally → persist to `crypto_keys`, private at-rest). After put, re-fetch + return the `CryptoKeyRow` (public-only) so the frontend gets the canonical row (id, fingerprint, hasPrivate, …) without a second round-trip.
- **`crypto_export_public`**: resolve the `KeyHandle` from `(standard, fingerprint)` (encode `KeyId` as `"standard|fingerprint"`, matching `SqliteKeyStore::encode_key_id`), call `SmimeBackend::export_public` → cert DER bytes. The frontend writes these to a user-chosen file (save dialog).
- **`db_delete_crypto_key`**: NEW db fn (`crypto_keys` has no delete path today) — `DELETE FROM crypto_keys WHERE account_id = ? AND standard = ? AND fingerprint = ?`. Also new: the `KeyStore::remove` trait path exists but is by-`KeyHandle`; the db-level delete is what the UI needs.
- **`db_set_default_signing_key`**: NEW transactional db fn — in one tx: `UPDATE crypto_keys SET is_default_sign = 0 WHERE account_id = ? AND standard = ?` (un-flag all), then `UPDATE crypto_keys SET is_default_sign = 1 WHERE account_id = ? AND standard = ? AND fingerprint = ?` (flag the chosen). Atomic; resolves the multiple-flagged ambiguity.

**Existing commands reused as-is:** `db_list_crypto_keys_for_account`, `db_get_crypto_key`, `db_upsert_crypto_key`.

## 3. KeyManager UI (frontend, medium)

**Placement:** extend `kylins.client.frontend/src/components/preferences/SecurityPreferences.tsx` with a new "Your S/MIME Keys" `PreferencesSectionCard` (below the existing classification + icon-picker sections).

**Layout** (mirror `SignaturesPreferences.tsx`):
- Account picker `<select>` (top).
- Master/detail: left = list of `CryptoKeyRow` for `(account, standard='smime')` via `db_list_crypto_keys_for_account`; each row shows email / fingerprint (truncated) / origin / `hasPrivate` chip / "Default" chip (when `isDefaultSign`). Right = action buttons.
- Actions per row: **Set default signing** (`db_set_default_signing_key`), **Export public cert** (`crypto_export_public` + save-dialog), **Delete** (`db_delete_crypto_key` + confirm).
- Section-level actions: **Import PEM…** (file-dialog `open()` → read bytes → `crypto_import_key`), **Generate self-signed** (`crypto_generate_key` with the account email).

**New frontend service:** `services/db/cryptoKeys.ts` — thin `invoke()` wrappers for the 5 new commands + the existing list/get (mirror `services/db/signatures.ts`).

**Feedback:** `useToastStore` for success/error toasts (import malformed PEM → error toast with the backend's message; generate success → toast + list refresh). Errors from the backend (`NotImplemented("encrypted PKCS#8 — Plan 3")`, `Malformed("no CERTIFICATE PEM block")`, etc.) surface verbatim.

## 4. Data flow

- **Import:** file pick → read bytes (frontend) → `crypto_import_key(accountId, bytes)` → `SmimeBackend::import_key` → `parse_pem_blocks` + fingerprint derivation + `keystore.put` (persists, private at-rest) → `CryptoKeyRow` returned → KeyManager list refreshes.
- **Generate:** button → `crypto_generate_key(accountId, accountEmail)` → `SmimeBackend::generate_key` (self-signed ECDSA-P256) → `keystore.put` → `CryptoKeyRow` → list refresh.
- **Set default:** button → `db_set_default_signing_key(accountId, 'smime', fingerprint)` → tx un-flag old + flag new → list refresh.
- **Send (end-to-end):** composer toggles → `sendEmail` derives `crypto` → `buildSendDraft` → `SendDraft{crypto_method, sign, encrypt}` → Plan 4a `send_op` → `apply_crypto` → CMS → transport.

## 5. Error handling

- **Malformed PEM / missing block** → `CryptoError::Malformed` from `import_key` → command returns `Err(String)` → toast.
- **Encrypted PKCS#8 / `.p12`** → `NotImplemented("encrypted PKCS#8 import — Plan 3")` → toast tells the user it's not supported yet.
- **Generate with no account email** → backend `Err` (the cert needs a SAN email) → toast.
- **Delete the only/default signing key** → allowed; the next sign send fails-closed with `NoSigningKey` (Plan 4a's `apply_crypto`) + a clear error. Warn in the confirm dialog ("this is your default signing key").
- **Set-default on a non-existent fingerprint** → tx flags nothing → no-op (idempotent) or `Err` if the row is missing (decide in plan: prefer `Err` so a stale UI is surfaced).

## 6. Verification gate

- **Backend:** `cargo test --lib` — each new command has a unit/integration test (generate → row persisted + `hasPrivate`; import a generated cert+key PEM bundle → row with matching fingerprint; export → cert DER re-parses; delete → gone; set-default → atomic, old `is_default_sign=0` + new `=1`). Private material never in the returned `CryptoKeyRow` (assert). `cargo clippy --all-targets -- -D warnings` clean.
- **Frontend:** `npx tsc --noEmit` clean; `npx vitest run` — `sendEmail` passes `cryptoMethod='smime'`+`sign`+`encrypt` when toggles set (and `undefined`/defaults when not); KeyManager renders the list, import calls `crypto_import_key`, set-default calls the transactional command, delete + confirm.
- **Manual e2e (user):** Preferences → Security → import a PEM cert+key (or generate self-signed) → set default → compose a mail → toggle Encrypt + Sign → send → the recipient (or self, via encrypt-to-self) gets a real S/MIME message. (Thunderbird interop: a sent signed mail verifies in Thunderbird, modulo self-signed "untrusted signer".)

## 7. Non-goals (deferred)

- **Sent-row CryptoBadge** — `is_encrypted`/`is_signed` are never set (hardcoded `0,0` on `messages`/`threads` insert; `send_op` does IMAP APPEND with no local row; no receive-side MIME parser). Making the badge light needs a design decision (local Sent row on send / receive parse / Message-ID match) — separate plan.
- **`.p12` / encrypted-PKCS#8 import** — Plan 3 (`p12-keystore`).
- **Recipient cert discovery** (LDAP/GAL/SMIMEA, `collected_keys` stager) — Phase 1b/2.
- **Cert validation** (chain, expiration, key-usage, revocation) — Phase 1b (spec decision #5). A minimal `notAfter` recipient-cert expiration check is a possible fast-follow (encrypting to an expired cert = undecryptable mail = UX, not a breach).
- **Export private key** (the `.p12` export path).
- **CryptoBadge receive-side states** (valid-unverified / invalid / unknown-key) — Phase 1b.
- **Bcc/Subject envelope exposure on encrypted sends** (Plan 4a carry-forward) — fast-follow before production BCC+encrypt.

## 8. Open risks

- **`SmimeBackend` per-call construction cost** — negligible (an `Arc<SqlitePool>` handle + `String` account_id per command); consistent with `send_op`. If key-heavy flows emerge, a managed `State` is the refactor.
- **PEM bundle variants** — some exports put cert + key in separate files or add chain certs. v1 handles the single-bundle case (`parse_pem_blocks` takes the first CERTIFICATE + first PRIVATE KEY). Separate-files / chain-certs = fast-follow.
- **`db_set_default_signing_key` race** — the tx makes the flag swap atomic, but a concurrent send reading the default mid-swap could see either old or new (single-user desktop → not a real concern; the tx still leaves a consistent state).
