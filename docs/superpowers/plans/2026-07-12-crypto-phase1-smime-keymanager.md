# Plan 4b — S/MIME Composer Wiring + KeyManager Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the composer's existing Encrypt/Sign toggles drive Plan 4a's S/MIME backend, and add a KeyManager (import PEM / generate self-signed / set default / list / delete / export) in the Security preferences.

**Architecture:** (1) `sendEmail` threads the toggles into `buildSendDraft`'s crypto options (frontend, small). (2) Five backend Tauri commands wrap `SmimeBackend` (generate/import/export, constructed per-call like `send_op`) + add two db ops (delete, transactional set-default). (3) `services/db/cryptoKeys.ts` thin invoke wrappers. (4) KeyManager UI extends `SecurityPreferences`, mirroring `SignaturesPreferences` (account picker + master/detail).

**Tech Stack:** crypto-smime (Plan 2b) · Tauri v2 commands (`State<SqlitePool>`) · React 19 + Zustand + `@tauri-apps/plugin-dialog` (file pick/save) · vitest.

## Global Constraints

- **Private key material never leaves the backend.** Import/generate persist via `SmimeBackend::*` → `keystore.put` → `upsert_crypto_key` (private at-rest via the master key). The IPC type `CryptoKeyRow` is public-only (`hasPrivate: bool`, no bytes).
- **PEM, unencrypted only for v1.** Encrypted PKCS#8 / `.p12` returns `NotImplemented("encrypted PKCS#8 import — Plan 3")` from `SmimeBackend::import_key` — surface verbatim to the UI.
- **Per-call `SmimeBackend`** in each new command (`SmimeBackend::new(Arc::new(SqliteKeyStore::new(pool, account_id)), CryptoPolicy::default_baseline())`) — mirrors `send_op` (`engine.rs:1011`); no Tauri `State` plumbing.
- **Path-based import/export** (refinement of the spec's bytes-over-IPC): `crypto_import_key_from_path` / `crypto_export_public_to_path` take a filesystem path the backend reads/writes via `std::fs` — matches the proven `stage_picked_attachment` pattern and dodges the frontend `plugin-fs` appData-only scope. The frontend only does the dialog pick/save (returns a path).
- **Transactional set-default:** `db_set_default_signing_key` un-flags the previous default + flags the new in one tx (the current `upsert` path leaves multiple rows flagged → `get_default_signing_key` `LIMIT 1` resolves ambiguously).
- **Any-true ⇒ smime:** `cryptoMethod = (isEncrypted || isSigned) ? 'smime' : 'none'`. No `cryptoMethod` field in `composerStore`.
- **`DraftInput` already has `isEncrypted?`/`isSigned?`** (`services/composer/drafts.ts:61-62`) — do NOT re-add them.
- **Backward-compatible IPC:** new commands are additive; existing `db_list_crypto_keys_for_account`/`db_upsert_crypto_key`/`db_get_crypto_key` are reused as-is.
- **Plan per-task `git commit` steps are SKIPPED** — user controls git; implement + test only, leave uncommitted.

---

## File Structure

- **Modify** `kylins.client.frontend/src/services/composer/send.ts` — `sendEmail` derives + passes `crypto` to `buildSendDraft` (Task 1).
- **Modify** `kylins.client.backend/src/db/commands.rs` — 5 new `#[tauri::command]`s (Tasks 2–3).
- **Modify** `kylins.client.backend/src/db/crypto_keys.rs` — `delete_crypto_key` + `set_default_signing_key` db fns (Task 3).
- **Modify** `kylins.client.backend/src/lib.rs` — register the 5 new commands in `invoke_handler` (Tasks 2–3).
- **Create** `kylins.client.frontend/src/services/db/cryptoKeys.ts` — invoke wrappers (Task 4).
- **Modify** `kylins.client.frontend/src/components/preferences/SecurityPreferences.tsx` — add the "Your S/MIME Keys" `PreferencesSectionCard` (Task 5).

---

### Task 1: Composer wiring — `sendEmail` passes crypto intent

**Files:**
- Modify: `kylins.client.frontend/src/services/composer/send.ts:79-84`
- Test: `kylins.client.frontend/tests/services/composer/send.test.ts`

**Interfaces:**
- Consumes: `DraftInput.isEncrypted?`/`isSigned?` (already exist, `drafts.ts:61-62`); `buildSendDraft`'s 5th arg `crypto?: SendCryptoOptions` (exists from Plan 4a Task 1); `SendCryptoOptions` type (`buildSendDraft.ts`).
- Produces: none new — closes the gap so `SendDraft.crypto_method`/`sign`/`encrypt` reflect the toggles.

- [ ] **Step 1: Write the failing test**

Add to `send.test.ts` a case asserting the invoke payload carries crypto intent when the toggles are set. (Inspect the mocked `buildSendDraft` output OR the `invoke` payload.) The existing `send.test.ts` mocks `@tauri-apps/api/core` `invoke` + `@tauri-apps/api/event` `emit` + `useAccountStore` — match its harness.

```ts
it('passes cryptoMethod=smime + sign/encrypt when toggles set', async () => {
  // seed useAccountStore with an account; mock invoke to resolve.
  await sendEmail('acct-1', {
    accountId: 'acct-1', to: [{ email: 'b@k' }], subject: 'S', bodyHtml: 'x',
    isSigned: true, isEncrypted: true,
  } as DraftInput);
  const payload = invokeMock.mock.calls.find(c => c[0] === 'sync_apply_mutation')![1];
  const draft = (payload as any).op.draft;
  expect(draft.cryptoMethod).toBe('smime');
  expect(draft.sign).toBe(true);
  expect(draft.encrypt).toBe(true);
});

it('omits crypto (defaults) when toggles unset', async () => {
  await sendEmail('acct-1', { accountId: 'acct-1', to: [{ email: 'b@k' }], subject: 'S', bodyHtml: 'x' } as DraftInput);
  const payload = invokeMock.mock.calls.find(c => c[0] === 'sync_apply_mutation')![1];
  const draft = (payload as any).op.draft;
  expect(draft.cryptoMethod).toBe('none');
  expect(draft.sign).toBe(false);
  expect(draft.encrypt).toBe(false);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd kylins.client.frontend && npx vitest run tests/services/composer/send.test.ts`
Expected: FAIL — `draft.cryptoMethod` is `'none'` even when toggles set (sendEmail doesn't pass crypto).

- [ ] **Step 3: Implement**

In `send.ts`, import `SendCryptoOptions` (from `./buildSendDraft`) + change the `buildSendDraft` call (currently lines 79-84) to derive + pass `crypto`:

```ts
import { buildSendDraft, type SendCryptoOptions } from './buildSendDraft';
// ...
    const crypto: SendCryptoOptions | undefined =
      input.isEncrypted || input.isSigned
        ? { cryptoMethod: 'smime', sign: !!input.isSigned, encrypt: !!input.isEncrypted }
        : undefined;
    draft = await buildSendDraft(
      input,
      sendDraftId,
      account.email,
      account.displayName ?? undefined,
      crypto,
    );
```

(`buildSendDraft`'s 5th arg already defaults `crypto ?? 'none'`/false — passing `undefined` keeps the no-crypto path unchanged.)

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd kylins.client.frontend && npx vitest run tests/services/composer/send.test.ts`
Expected: PASS (both cases).

- [ ] **Step 5: Run frontend gates**

Run: `cd kylins.client.frontend && npx tsc --noEmit && npx vitest run`
Expected: tsc 0 errors; vitest green (no regression to the existing send tests).

---

### Task 2: Backend SmimeBackend-wrapping commands (generate / import / export)

**Files:**
- Modify: `kylins.client.backend/src/db/commands.rs` (3 new commands)
- Modify: `kylins.client.backend/src/lib.rs` (register them)
- Test: `kylins.client.backend/tests/crypto_smime_lifecycle.rs` (extend) OR a new integration test

**Interfaces:**
- Consumes: `crypto_smime::SmimeBackend::{generate_key, import_key, export_public}` (Plan 2b); `crate::keystore_bridge::SqliteKeyStore::new(pool, account_id)`; `crypto_core::{CryptoPolicy, KeyGenParams, Standard, KeyHandle}`; `crate::db::crypto_keys::get_crypto_key_public` (re-fetch the row); `crypto_keys::CryptoKeyRow`.
- Produces: `crypto_generate_key`, `crypto_import_key_from_path`, `crypto_export_public_to_path` Tauri commands.

- [ ] **Step 1: Write the failing test**

In `crypto_smime_lifecycle.rs` (it already builds a `SqliteKeyStore`-backed `SmimeBackend` + seeds an account), add a test that drives the COMMAND via the Tauri `test` harness OR — simpler, since commands are thin wrappers — test the underlying flow at the command-body level. **Preferred: extract each command's body into a `pub async fn` in `commands.rs` taking `&SqlitePool` (no `State`), and have the `#[tauri::command]` delegate to it.** Then test the body fn directly with a real pool (no Tauri runtime needed):

```rust
#[tokio::test]
async fn crypto_generate_key_command_persists_and_returns_row() {
    let pool = /* in-memory init_db + seed_account("acct","owner@k") */;
    let row = commands::crypto_generate_key_inner(&pool, "acct", "owner@k").await.unwrap();
    assert_eq!(row.standard, "smime");
    assert!(row.has_private);
    assert!(row.fingerprint.len() > 0);
    // re-fetch confirms persistence
    let again = crypto_keys::get_crypto_key_public(&pool, "smime", &row.fingerprint).await.unwrap();
    assert!(again.is_some());
}
```

(Add a 2nd test: `crypto_import_key_from_path_inner` writes a PEM bundle to a temp file (cert+key generated via `SmimeBackend::generate_key` + exported), imports it into a FRESH account, asserts the fingerprint matches + `has_private`. A 3rd: `crypto_export_public_to_path_inner` writes the cert DER to a temp path; assert the file re-parses as an X.509 cert.)

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd kylins.client.backend && cargo test --test crypto_smime_lifecycle crypto_generate_key_command`
Expected: COMPILE ERROR — `cannot find function crypto_generate_key_inner`.

- [ ] **Step 3: Implement the three command bodies + `#[tauri::command]` wrappers**

In `commands.rs`:

```rust
use crypto_core::{CryptoPolicy, KeyGenParams, Standard, KeyHandle, KeyId};
use crypto_smime::SmimeBackend;
use crate::keystore_bridge::SqliteKeyStore;

/// Build a per-call SmimeBackend bound to `account_id` (mirror send_op).
fn smime_backend(pool: &SqlitePool, account_id: &str) -> SmimeBackend {
    SmimeBackend::new(
        std::sync::Arc::new(SqliteKeyStore::new(pool.clone(), account_id)),
        CryptoPolicy::default_baseline(),
    )
}

pub async fn crypto_generate_key_inner(
    pool: &SqlitePool, account_id: &str, email: &str,
) -> Result<CryptoKeyRow, String> {
    let backend = smime_backend(pool, account_id);
    let h = backend.generate_key(KeyGenParams {
        standard: Standard::Smime, user_id: email.into(),
        algorithm: "ECDSA-P256".into(), passphrase: None,
    }).await.map_err(|e| e.to_string())?;
    crypto_keys::get_crypto_key_public(pool, h.standard.as_str(), h.fingerprint.as_str())
        .await?.ok_or_else(|| "generate_key: row not found after put".into())
}

pub async fn crypto_import_key_from_path_inner(
    pool: &SqlitePool, account_id: &str, path: &str,
) -> Result<CryptoKeyRow, String> {
    let bytes = std::fs::read(path).map_err(|e| format!("read {}: {e}", path))?;
    let backend = smime_backend(pool, account_id);
    let h = backend.import_key(&bytes, None).await.map_err(|e| e.to_string())?;
    crypto_keys::get_crypto_key_public(pool, h.standard.as_str(), h.fingerprint.as_str())
        .await?.ok_or_else(|| "import_key: row not found after put".into())
}

pub async fn crypto_export_public_to_path_inner(
    pool: &SqlitePool, account_id: &str, standard: &str, fingerprint: &str, out_path: &str,
) -> Result<(), String> {
    let backend = smime_backend(pool, account_id);
    let handle = KeyHandle::Software(KeyId(format!("{standard}|{fingerprint}")));
    let der = backend.export_public(&handle).await.map_err(|e| e.to_string())?;
    std::fs::write(out_path, &der).map_err(|e| format!("write {}: {e}", out_path))?;
    Ok(())
}

#[tauri::command]
pub async fn crypto_generate_key(pool: State<'_, SqlitePool>, account_id: String, email: String)
    -> Result<CryptoKeyRow, String> {
    crypto_generate_key_inner(&pool, &account_id, &email).await
}
#[tauri::command]
pub async fn crypto_import_key_from_path(pool: State<'_, SqlitePool>, account_id: String, path: String)
    -> Result<CryptoKeyRow, String> {
    crypto_import_key_from_path_inner(&pool, &account_id, &path).await
}
#[tauri::command]
pub async fn crypto_export_public_to_path(
    pool: State<'_, SqlitePool>, account_id: String, standard: String, fingerprint: String, out_path: String,
) -> Result<(), String> {
    crypto_export_public_to_path_inner(&pool, &account_id, &standard, &fingerprint, &out_path).await
}
```

(`SqlitePool::clone` is a cheap `Arc` bump. The `KeyHandle::Software(KeyId("standard|fingerprint"))` encoding matches `SqliteKeyStore::encode_key_id` so `export_public` → `keystore.get` resolves — verified in Plan 4a's final review.)

In `lib.rs`, add the 3 commands to the existing `invoke_handler!` list (near the other `db_*crypto*` registrations ~L242-250).

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd kylins.client.backend && cargo test --test crypto_smime_lifecycle && cargo test --lib && cargo clippy --all-targets -- -D warnings`
Expected: green + clippy clean.

---

### Task 3: Backend db commands — delete + transactional set-default

**Files:**
- Modify: `kylins.client.backend/src/db/crypto_keys.rs` (2 new db fns)
- Modify: `kylins.client.backend/src/db/commands.rs` (2 new commands)
- Modify: `kylins.client.backend/src/lib.rs` (register)
- Test: `crypto_keys.rs` in-module `#[cfg(test)] mod tests`

**Interfaces:**
- Produces: `crypto_keys::delete_crypto_key(pool, account_id, standard, fingerprint) -> Result<(), String>`; `crypto_keys::set_default_signing_key(pool, account_id, standard, fingerprint) -> Result<(), String>` (tx: un-flag all + flag the one; `Err` if the fingerprint doesn't exist). Plus the 2 `#[tauri::command]` wrappers `db_delete_crypto_key` + `db_set_default_signing_key`.

- [ ] **Step 1: Write the failing tests**

In `crypto_keys.rs` tests (reuse the existing `seed_account` + `sample_record` helpers):

```rust
    #[tokio::test]
    async fn delete_crypto_key_removes_the_row() {
        let pool = /* init_db + seed_account */;
        upsert_crypto_key(&pool, &sample_record("acct", "fp-del")).await.unwrap();
        delete_crypto_key(&pool, "acct", "smime", "fp-del").await.unwrap();
        let gone = get_crypto_key_public(&pool, "smime", "fp-del").await.unwrap();
        assert!(gone.is_none());
    }

    #[tokio::test]
    async fn set_default_signing_key_is_atomic_and_unflags_previous() {
        let pool = /* init_db + seed_account */;
        let mut a = sample_record("acct", "fp-a"); a.row.is_default_sign = true;
        let mut b = sample_record("acct", "fp-b"); b.row.is_default_sign = false;
        upsert_crypto_key(&pool, &a).await.unwrap();
        upsert_crypto_key(&pool, &b).await.unwrap();
        set_default_signing_key(&pool, "acct", "smime", "fp-b").await.unwrap();
        let ra = get_crypto_key_public(&pool, "smime", "fp-a").await.unwrap().unwrap();
        let rb = get_crypto_key_public(&pool, "smime", "fp-b").await.unwrap().unwrap();
        assert_eq!(ra.is_default_sign, false, "previous default un-flagged");
        assert_eq!(rb.is_default_sign, true, "new default flagged");
        // exactly one default
        let defaults = list_crypto_keys_for_account(&pool, "acct", "smime").await.unwrap()
            .into_iter().filter(|r| r.is_default_sign).count();
        assert_eq!(defaults, 1);
    }

    #[tokio::test]
    async fn set_default_signing_key_errors_on_missing_fingerprint() {
        let pool = /* init_db + seed_account */;
        let err = set_default_signing_key(&pool, "acct", "smime", "nope").await.unwrap_err();
        assert!(err.contains("no key"));
    }
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd kylins.client.backend && cargo test --lib delete_crypto_key set_default_signing_key`
Expected: COMPILE ERROR — `cannot find function delete_crypto_key`/`set_default_signing_key`.

- [ ] **Step 3: Implement the db fns + commands**

In `crypto_keys.rs`:

```rust
/// Delete a key by `(account_id, standard, fingerprint)`.
pub async fn delete_crypto_key(
    pool: &sqlx::SqlitePool, account_id: &str, standard: &str, fingerprint: &str,
) -> Result<(), String> {
    sqlx::query(
        "DELETE FROM crypto_keys WHERE account_id = ? AND standard = ? AND fingerprint = ?",
    )
    .bind(account_id).bind(standard).bind(fingerprint)
    .execute(pool).await
    .map_err(|e| e.to_string())?;
    Ok(())
}

/// Atomically set the default signing key: un-flag all, then flag the chosen.
/// Errors if the chosen fingerprint doesn't exist (so a stale UI is surfaced).
pub async fn set_default_signing_key(
    pool: &sqlx::SqlitePool, account_id: &str, standard: &str, fingerprint: &str,
) -> Result<(), String> {
    let mut tx = pool.begin().await.map_err(|e| e.to_string())?;
    sqlx::query("UPDATE crypto_keys SET is_default_sign = 0 WHERE account_id = ? AND standard = ?")
        .bind(account_id).bind(standard)
        .execute(&mut *tx).await.map_err(|e| e.to_string())?;
    let r = sqlx::query(
        "UPDATE crypto_keys SET is_default_sign = 1 WHERE account_id = ? AND standard = ? AND fingerprint = ?",
    )
    .bind(account_id).bind(standard).bind(fingerprint)
    .execute(&mut *tx).await.map_err(|e| e.to_string())?;
    if r.rows_affected() == 0 {
        return Err(format!("no key for {account_id}/{standard}/{fingerprint}"));
    }
    tx.commit().await.map_err(|e| e.to_string())?;
    Ok(())
}
```

In `commands.rs`:

```rust
#[tauri::command]
pub async fn db_delete_crypto_key(
    pool: State<'_, SqlitePool>, account_id: String, standard: String, fingerprint: String,
) -> Result<(), String> {
    crypto_keys::delete_crypto_key(&pool, &account_id, &standard, &fingerprint).await
}

#[tauri::command]
pub async fn db_set_default_signing_key(
    pool: State<'_, SqlitePool>, account_id: String, standard: String, fingerprint: String,
) -> Result<(), String> {
    crypto_keys::set_default_signing_key(&pool, &account_id, &standard, &fingerprint).await
}
```

Register both in `lib.rs` `invoke_handler!`.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd kylins.client.backend && cargo test --lib delete_crypto_key set_default_signing_key && cargo test --lib && cargo clippy --all-targets -- -D warnings`
Expected: green + clippy clean.

---

### Task 4: Frontend `services/db/cryptoKeys.ts` invoke wrappers

**Files:**
- Create: `kylins.client.frontend/src/services/db/cryptoKeys.ts`
- Test: `kylins.client.frontend/tests/services/db/cryptoKeys.test.ts`

**Interfaces:**
- Consumes: the 5 new commands (Tasks 2–3) + the existing `db_list_crypto_keys_for_account` / `db_get_crypto_key` / `db_upsert_crypto_key`.
- Produces: typed wrappers `listCryptoKeysForAccount`, `getCryptoKey`, `generateKey`, `importKeyFromPath`, `exportPublicToPath`, `deleteCryptoKey`, `setDefaultSigningKey` + a `CryptoKeyRow` TS type.

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }));
import { invoke } from '@tauri-apps/api/core';
import { listCryptoKeysForAccount, generateKey, importKeyFromPath, setDefaultSigningKey } from '@/services/db/cryptoKeys';

beforeEach(() => (invoke as any).mockClear());

it('listCryptoKeysForAccount invokes with snake_case args', async () => {
  (invoke as any).mockResolvedValue([]);
  await listCryptoKeysForAccount('acct', 'smime');
  expect(invoke).toHaveBeenCalledWith('db_list_crypto_keys_for_account', { accountId: 'acct', standard: 'smime' });
});

it('generateKey invokes crypto_generate_key', async () => {
  (invoke as any).mockResolvedValue({ id: 'x', standard: 'smime', fingerprint: 'fp', hasPrivate: true });
  await generateKey('acct', 'owner@k');
  expect(invoke).toHaveBeenCalledWith('crypto_generate_key', { accountId: 'acct', email: 'owner@k' });
});

it('setDefaultSigningKey invokes the transactional command', async () => {
  (invoke as any).mockResolvedValue(undefined);
  await setDefaultSigningKey('acct', 'smime', 'fp');
  expect(invoke).toHaveBeenCalledWith('db_set_default_signing_key', { accountId: 'acct', standard: 'smime', fingerprint: 'fp' });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd kylins.client.frontend && npx vitest run tests/services/db/cryptoKeys.test.ts`
Expected: FAIL — module `@/services/db/cryptoKeys` not found.

- [ ] **Step 3: Implement**

```ts
// services/db/cryptoKeys.ts
import { invoke } from '@tauri-apps/api/core';

/** Public-facing key row (matches Rust `CryptoKeyRow`; private bytes never cross IPC). */
export interface CryptoKeyRow {
  id: string;
  accountId: string;
  standard: string;
  keyType: string;
  email?: string | null;
  fingerprint: string;
  origin: string;
  isDefaultSign: boolean;
  isDefaultEncrypt: boolean;
  createdAt: number;
  expiresAt?: number | null;
  hasPrivate: boolean;
  tokenSerial?: string | null;
  tokenKeyId?: string | null;
}

export const listCryptoKeysForAccount = (accountId: string, standard: string) =>
  invoke<CryptoKeyRow[]>('db_list_crypto_keys_for_account', { accountId, standard });

export const getCryptoKey = (standard: string, fingerprint: string) =>
  invoke<CryptoKeyRow | null>('db_get_crypto_key', { standard, fingerprint });

export const generateKey = (accountId: string, email: string) =>
  invoke<CryptoKeyRow>('crypto_generate_key', { accountId, email });

export const importKeyFromPath = (accountId: string, path: string) =>
  invoke<CryptoKeyRow>('crypto_import_key_from_path', { accountId, path });

export const exportPublicToPath = (accountId: string, standard: string, fingerprint: string, outPath: string) =>
  invoke<void>('crypto_export_public_to_path', { accountId, standard, fingerprint, outPath });

export const deleteCryptoKey = (accountId: string, standard: string, fingerprint: string) =>
  invoke<void>('db_delete_crypto_key', { accountId, standard, fingerprint });

export const setDefaultSigningKey = (accountId: string, standard: string, fingerprint: string) =>
  invoke<void>('db_set_default_signing_key', { accountId, standard, fingerprint });
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd kylins.client.frontend && npx vitest run tests/services/db/cryptoKeys.test.ts`
Expected: PASS.

- [ ] **Step 5: Run gates**

Run: `cd kylins.client.frontend && npx tsc --noEmit && npx vitest run`
Expected: tsc 0; vitest green.

---

### Task 5: KeyManager UI — extend `SecurityPreferences`

**Files:**
- Modify: `kylins.client.frontend/src/components/preferences/SecurityPreferences.tsx`
- Test: `kylins.client.frontend/tests/components/preferences/KeyManager.test.tsx` (new) OR extend an existing preferences test

**Interfaces:**
- Consumes: `services/db/cryptoKeys.ts` (Task 4); `useAccountStore` (account picker); `@tauri-apps/plugin-dialog` `open`/`save` (file pick/save); `useToastStore` (feedback); `PreferencesSectionCard` (shell).
- Produces: a `<KeyManagerSection>` rendered inside `SecurityPreferences` (account picker + key list + Import/Generate/Set-default/Delete/Export actions).

- [ ] **Step 1: Write the failing test**

A vitest + Testing Library test rendering `<KeyManagerSection accountId="acct" />` with mocked `services/db/cryptoKeys`:

```tsx
it('lists keys + calls importKeyFromPath on Import', async () => {
  vi.mock('@/services/db/cryptoKeys', () => ({
    listCryptoKeysForAccount: vi.fn().mockResolvedValue([
      { id: '1', accountId: 'acct', standard: 'smime', keyType: 'cert', fingerprint: 'fp1abc...', origin: 'generated', isDefaultSign: true, isDefaultEncrypt: false, createdAt: 0, hasPrivate: true },
    ]),
    importKeyFromPath: vi.fn().mockResolvedValue(undefined),
    // … stub the rest
  }));
  vi.mock('@tauri-apps/plugin-dialog', () => ({ open: vi.fn().mockResolvedValue('/fake/cert.pem'), save: vi.fn() }));
  render(<KeyManagerSection accountId="acct" />);
  expect(await screen.findByText(/fp1abc/i)).toBeInTheDocument();
  await userEvent.click(screen.getByRole('button', { name: /import/i }));
  expect(importKeyFromPath).toHaveBeenCalledWith('acct', '/fake/cert.pem');
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd kylins.client.frontend && npx vitest run tests/components/preferences/KeyManager.test.tsx`
Expected: FAIL — `KeyManagerSection` not found.

- [ ] **Step 3: Implement `KeyManagerSection` + mount it in `SecurityPreferences`**

Create `KeyManagerSection` (inline in `SecurityPreferences.tsx` or a co-located `KeyManagerSection.tsx`) mirroring `SignaturesPreferences`'s master/detail. Core structure:

```tsx
import { open as openDialog, save as saveDialog } from '@tauri-apps/plugin-dialog';
import { useToastStore } from '@/stores/toastStore'; // match the real toast store import
import {
  listCryptoKeysForAccount, generateKey, importKeyFromPath,
  setDefaultSigningKey, deleteCryptoKey, exportPublicToPath, type CryptoKeyRow,
} from '@/services/db/cryptoKeys';

export function KeyManagerSection({ accountId }: { accountId: string }) {
  const [keys, setKeys] = useState<CryptoKeyRow[]>([]);
  const toast = useToastStore((s) => s.push);
  const refresh = () => listCryptoKeysForAccount(accountId, 'smime').then(setKeys).catch((e) => toast(`Failed to list keys: ${e}`, 'error'));
  useEffect(() => { refresh(); /* re-fetch when accountId changes */ }, [accountId]);

  const onImport = async () => {
    const path = await openDialog({ filters: [{ name: 'PEM', extensions: ['pem', 'crt', 'cer', 'key', 'txt'] }] });
    if (!path || Array.isArray(path)) return;
    try { await importKeyFromPath(accountId, path as string); toast('Key imported', 'success'); refresh(); }
    catch (e) { toast(`Import failed: ${e}`, 'error'); }
  };
  const onGenerate = async () => {
    const email = useAccountStore.getState().accounts.find((a) => a.id === accountId)?.email;
    if (!email) { toast('Account has no email', 'error'); return; }
    try { await generateKey(accountId, email); toast('Self-signed key generated', 'success'); refresh(); }
    catch (e) { toast(`Generate failed: ${e}`, 'error'); }
  };
  const onSetDefault = async (fp: string) => { try { await setDefaultSigningKey(accountId, 'smime', fp); toast('Default signing key set', 'success'); refresh(); } catch (e) { toast(`Failed: ${e}`, 'error'); } };
  const onDelete = async (fp: string) => { if (!confirm('Delete this key?')) return; try { await deleteCryptoKey(accountId, 'smime', fp); toast('Key deleted', 'success'); refresh(); } catch (e) { toast(`Delete failed: ${e}`, 'error'); } };
  const onExport = async (fp: string) => {
    const path = await saveDialog({ defaultPath: 'smime-cert.der', filters: [{ name: 'DER', extensions: ['der'] }] });
    if (!path) return;
    try { await exportPublicToPath(accountId, 'smime', fp, path); toast('Cert exported', 'success'); }
    catch (e) { toast(`Export failed: ${e}`, 'error'); }
  };

  return (
    <PreferencesSectionCard title="Your S/MIME Keys" icon={<ShieldCheckIcon size={16} />}>
      {/* account picker if SecurityPreferences doesn't already provide one; else use the accountId prop */}
      <div className="flex gap-2 mb-3">
        <RibbonButton-like onClick={onImport}>Import PEM…</RibbonButton-like>
        <RibbonButton-like onClick={onGenerate}>Generate self-signed</RibbonButton-like>
      </div>
      <ul>{keys.map((k) => (
        <li key={k.id} className="flex items-center justify-between py-1">
          <span>{k.email ?? '(no email)'} · {k.fingerprint.slice(0, 16)}… {k.hasPrivate ? '🔑' : ''} {k.isDefaultSign && <span className="chip">Default</span>}</span>
          <span className="flex gap-1">
            {!k.isDefaultSign && <button onClick={() => onSetDefault(k.fingerprint)}>Set default</button>}
            <button onClick={() => onExport(k.fingerprint)}>Export…</button>
            <button onClick={() => onDelete(k.fingerprint)}>Delete</button>
          </span>
        </li>
      ))}</ul>
      {keys.length === 0 && <p className="text-[var(--muted-text)]">No S/MIME keys yet. Import a PEM cert+key or generate a self-signed one.</p>}
    </PreferencesSectionCard>
  );
}
```

Mount it in `SecurityPreferences.tsx` (below the existing icon-picker section). Read `SecurityPreferences.tsx` first to match its section layout + how it reads the active account (if it has an account picker, reuse; if not, add one or read from `useAccountStore`). Match the existing button/styling primitives (`RibbonButton`-like or plain `<button>` with Tailwind classes the file already uses).

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd kylins.client.frontend && npx vitest run tests/components/preferences/KeyManager.test.tsx`
Expected: PASS.

- [ ] **Step 5: Run frontend gates**

Run: `cd kylins.client.frontend && npx tsc --noEmit && npx vitest run`
Expected: tsc 0; vitest green.

---

### Task 6: Final gates + manual e2e note

**Files:** none (verification + documentation).

- [ ] **Step 1: Full workspace gates**

Run:
```bash
cd kylins.client.backend && cargo test && cargo clippy --all-targets -- -D warnings
cd kylins.client.frontend && npx tsc --noEmit && npx vitest run
```
Expected: backend green (lib 480+ + new command/db tests + integration) + clippy clean; frontend tsc 0 + vitest green.

- [ ] **Step 2: Manual e2e (user-run, document in ledger)**

Preferences → Security → "Your S/MIME Keys" → Import a PEM cert+key (or Generate self-signed) → Set default signing → close. Compose a mail → toggle Encrypt + Sign → Send. Expected: the recipient (or self, via encrypt-to-self) gets a real S/MIME message (Plan 4a's backend produces it now that the toggles reach `SendDraft`). Thunderbird interop: a sent signed mail verifies in Thunderbird (self-signed → "untrusted signer").

- [ ] **Step 3: Update the SDD ledger**

Append to `.superpowers/sdd/progress.md`: Plan 4b complete (tasks + gates); carry-forwards: (1) sent-row CryptoBadge (needs the local-Sent-row vs receive-parse decision); (2) `.p12`/encrypted-PKCS#8 import (Plan 3); (3) Bcc/Subject envelope exposure (Plan 4a carry-forward); (4) cert validation (Phase 1b); (5) recipient-cert discovery (Phase 1b/2).

---

## Self-Review

**1. Spec coverage.** Spec §1 composer wiring → T1 ✅ (corrected: `DraftInput` already has the fields — T1 just threads sendEmail). §2 backend commands → T2 (generate/import/export) + T3 (delete/set-default) ✅. §3 KeyManager UI → T4 (wrappers) + T5 (UI) ✅. §4 data flow → exercised end-to-end in T6 manual e2e ✅. §5 error handling → import/generate/export errors surface via toast (T5); set-default `Err` on missing (T3) ✅. §6 verification → automated gates (each task) + manual e2e (T6) ✅. §7 non-goals respected (no sent-row badge, no .p12, no validation).

**2. Placeholder scan.** No TBD/TODO. T2/T3 use the `_inner` body-extraction pattern (testable without Tauri runtime) — the `#[tauri::command]` wrappers delegate. T5's button styling says "match the existing primitives" — the implementer reads `SecurityPreferences.tsx` for the exact primitives (acceptable; the file is the reference). The path-based import/export (vs the spec's bytes) is a noted refinement in Global Constraints (fs-scope).

**3. Type consistency.** `CryptoKeyRow` (Rust, Task 2/3) ↔ `CryptoKeyRow` (TS, Task 4) — field names camelCase match (serde `rename_all` on the Rust side). Command names: `crypto_generate_key`/`crypto_import_key_from_path`/`crypto_export_public_to_path`/`db_delete_crypto_key`/`db_set_default_signing_key` consistent across Tasks 2–4. `KeyHandle::Software(KeyId("standard|fingerprint"))` encoding matches `SqliteKeyStore::encode_key_id` (Plan 4a verified). `smime_backend(pool, account_id)` helper consistent across the 3 SmimeBackend-wrapping commands.

**Carry-forwards:** sent-row CryptoBadge · `.p12` import (Plan 3) · Bcc/Subject exposure · cert validation (Phase 1b) · recipient discovery (Phase 1b/2) · export private key.

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-07-12-crypto-phase1-smime-keymanager.md`. Two execution options:

**1. Subagent-Driven (recommended)** — fresh subagent per task + controller review.
**2. Inline Execution** — batch with checkpoints.

Which approach?
