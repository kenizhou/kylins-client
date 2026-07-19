# Encryption Granularity Configure UI Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a per-account UI to set `accounts.crypto_granularity` (the column the parent feature added but never made settable), persisted via the existing `db_update_account` IPC path.

**Architecture:** A new `CryptoGranularitySection` component (account-picker `<select>` + granularity `<select>`) mounted as a new `PreferencesSectionCard` in `SecurityPreferences.tsx`. On change → `updateAccount(id, { cryptoGranularity })` → `db_update_account` → `accounts::update` → `UPDATE accounts SET crypto_granularity = ?`. Backend: add `crypto_granularity` to `AccountUpdates` + one `push_str!` line (mirrors `auth_type`). Set-only (no reset); NULL only for fresh/migrated accounts. All 3 options shown; A carries a "no current effect on standard S/MIME — for future E2EE" caveat.

**Tech Stack:** Rust (Tauri v2 backend, `sqlx`), React 19 + TypeScript + Zustand + Vitest/Testing Library (frontend).

## Global Constraints

- **Branch:** `feat/encryption-granularity` (continues the parent feature; the configure UI is part of the same feature). Per-task commits, no push (user controls pushes).
- **Set-only semantics:** `AccountUpdates` is single-`Option<T>` everywhere (no `Option<Option<T>>` clear/don't-touch trichotomy). `Some(v)` = set; `None` = don't-touch. Selecting WholeMessage writes `'whole_message'` (not NULL). Matches the `auth_type` precedent (`accounts.rs:259`). NULL remains only for fresh/migrated accounts.
- **No new IPC command, no new migration, no settings KV.** The column, `Account` field, `get_crypto_granularity` loader, `send_op` resolution, and `db_update_account` command ALL already exist (parent feature @ `ba35769`). This plan only makes the column settable via `AccountUpdates` + exposes it in the UI.
- **No crypto-path changes.** Do NOT touch `send_op`, `build_mime`, `apply_crypto`, or the `EncryptionGranularity` enum. Those already read + apply the value.
- **Dropdown value mapping (exact strings — `from_db_str` recognizes these):** `'whole_message'` / `'body_inline_per_attachment'` / `'body_inline_merged_attachments'`. The TS field is `cryptoGranularity` (camelCase, mirroring Rust `#[serde(rename_all="camelCase")]`).
- **Git guardrail (STRICT — a prior implementer's `git clean`/`stash` destroyed an untracked file):** stage ONLY the specific files you changed (explicit `git add <paths>`). NEVER `git add -A`/`git add .`/`git stash -u`/`git clean -fd`. If `cargo fmt --all` / prettier reformats unrelated files, leave them unstaged. Do NOT push.
- **Test runners:** backend `cargo test -p kylins-client-backend` from `kylins.client.backend/`; frontend `npx vitest run <path>` and `npx tsc --noEmit` from `kylins.client.frontend/`.
- **Existing patterns to mirror (do not invent):**
  - Backend `push_str!` macro + `auth_type` precedent: `src/db/accounts.rs:630` (the `push_str!("auth_type", updates.auth_type)` line) and the `AccountUpdates` field at `:259`.
  - Backend test-pool helper: `crate::db::init_db(tempfile::tempdir().unwrap().path())` (used by every `accounts.rs` `#[tokio::test]`; defined `src/db/mod.rs:159`).
  - Frontend account-picker `<select>`: `components/preferences/KeyManagerSection.tsx:265-276`.
  - Frontend commit pattern: `AccountDetailsEditor.tsx:93-100` (`updateAccount(...)` + `useAccountStore.getState().updateAccountInPlace(...)`).
  - Frontend `Account` interface: `types/index.ts:39-78` (ends at `easUserAgent?: string;` line 77).

## File Structure

| File | Action | Responsibility |
|---|---|---|
| `kylins.client.backend/src/db/accounts.rs` | Modify | Add `crypto_granularity: Option<String>` to `AccountUpdates` (`:259`); add `push_str!("crypto_granularity", updates.crypto_granularity)` to `update` (`:630`); add 2 tests. |
| `kylins.client.frontend/src/types/index.ts` | Modify | Add `cryptoGranularity?: string;` to the `Account` interface (`:77`). (`AccountUpdates` auto-gains it via `Partial<Omit<Account,'id'|'createdAt'>>`.) |
| `kylins.client.frontend/src/components/preferences/CryptoGranularitySection.tsx` | Create | Account-picker + granularity dropdown; commits via `updateAccount` + `updateAccountInPlace`. |
| `kylins.client.frontend/src/components/preferences/SecurityPreferences.tsx` | Modify | Add a new `PreferencesSectionCard title="Encryption granularity"` mounting `<CryptoGranularitySection />`. |
| `kylins.client.frontend/tests/components/preferences/CryptoGranularitySection.test.tsx` | Create | Component test: account switch re-seeds; granularity change calls `updateAccount` with the right payload. |

---

## Task 1: Backend setter — `AccountUpdates.crypto_granularity` + `update`

**Files:**
- Modify: `kylins.client.backend/src/db/accounts.rs` — `AccountUpdates` struct (near `:259`), `update()` fn (near `:630`), test module.
- Test: extend the `#[cfg(test)] mod tests` in `accounts.rs`.

**Interfaces:**
- Consumes: `get_crypto_granularity` (`accounts.rs:421`, parent feature) for the assertion.
- Produces: `AccountUpdates.crypto_granularity: Option<String>` (set-only); `update()` now emits `crypto_granularity = ?` when `Some`. Consumed by Task 2's frontend `updateAccount` IPC call.

- [ ] **Step 1: Write the failing tests**

In `accounts.rs` `#[cfg(test)] mod tests`, add (mirror the nearest existing `update` test for the exact account-seed SQL + the `init_db` helper pattern):

```rust
#[tokio::test]
async fn update_sets_crypto_granularity_and_persists() {
    let tmp = tempfile::tempdir().unwrap();
    let pool = crate::db::init_db(tmp.path()).await.unwrap();
    sqlx::query("INSERT INTO accounts (id, email, created_at) VALUES ('acct-gran-upd', 'g@x', '0')")
        .execute(&pool).await.unwrap();

    let updates = crate::db::accounts::AccountUpdates {
        crypto_granularity: Some("body_inline_merged_attachments".into()),
        ..Default::default()
    };
    crate::db::accounts::update(&pool, "acct-gran-upd", updates).await.unwrap();

    let g = crate::db::accounts::get_crypto_granularity(&pool, "acct-gran-upd").await.unwrap();
    assert_eq!(g.as_deref(), Some("body_inline_merged_attachments"));
}

#[tokio::test]
async fn update_crypto_granularity_none_is_dont_touch() {
    let tmp = tempfile::tempdir().unwrap();
    let pool = crate::db::init_db(tmp.path()).await.unwrap();
    sqlx::query("INSERT INTO accounts (id, email, created_at) VALUES ('acct-gran-nt', 'g@x', '0')")
        .execute(&pool).await.unwrap();

    // set B first
    crate::db::accounts::update(&pool, "acct-gran-nt", crate::db::accounts::AccountUpdates {
        crypto_granularity: Some("body_inline_merged_attachments".into()),
        ..Default::default()
    }).await.unwrap();

    // update a DIFFERENT field with crypto_granularity: None — must NOT clear B.
    // (If `account_label` is not the right field name, use whatever the nearest
    //  existing `update` test sets — read that test first and mirror its field.)
    crate::db::accounts::update(&pool, "acct-gran-nt", crate::db::accounts::AccountUpdates {
        account_label: Some("renamed".into()),
        ..Default::default()
    }).await.unwrap();

    let g = crate::db::accounts::get_crypto_granularity(&pool, "acct-gran-nt").await.unwrap();
    assert_eq!(g.as_deref(), Some("body_inline_merged_attachments"),
        "crypto_granularity: None must be don't-touch, not clear");
}
```

**Before writing, verify:** read the nearest existing `update` test in `accounts.rs` to confirm (a) the `init_db(tempfile::tempdir().unwrap().path())` helper signature, (b) the `INSERT INTO accounts` minimum-column pattern, (c) that `account_label` is a real `AccountUpdates` field (it's edited by `AccountDetailsEditor` → `updateAccount({ accountLabel })`, so it should be). If the field name differs, substitute — the test's intent is "set some other field, leave crypto_granularity None, assert B persists."

- [ ] **Step 2: Run tests to verify they fail**

Run: `cargo test -p kylins-client-backend update_sets_crypto_granularity_and_persists update_crypto_granularity_none_is_dont_touch`
Expected: FAIL — `crypto_granularity` is not a field on `AccountUpdates` (compile error E0609 / "no field").

- [ ] **Step 3: Implement — add the field + the `push_str!` line**

(a) In the `AccountUpdates` struct (`accounts.rs:184-260`), immediately after the `auth_type` field (`:259`), add:

```rust
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub crypto_granularity: Option<String>,
```

(b) In `update()` (`accounts.rs:550-651`), immediately after the `push_str!("auth_type", updates.auth_type);` line (`:630`), add:

```rust
    push_str!("crypto_granularity", updates.crypto_granularity);
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cargo test -p kylins-client-backend update_sets_crypto_granularity update_crypto_granularity_none_is_dont_touch`
Expected: both PASS.

- [ ] **Step 5: Confirm zero regression in the db suite**

Run: `cargo test -p kylins-client-backend --lib db::`
Expected: all green (the new field is `Option` + `skip_serializing_if`, so existing `AccountUpdates` constructions without it still deserialize; `update` with `crypto_granularity: None` skips the column).

- [ ] **Step 6: Commit**

```bash
cd kylins.client.backend && cargo fmt --all
git add kylins.client.backend/src/db/accounts.rs
git commit -m "feat(db): make accounts.crypto_granularity settable via AccountUpdates"
```

---

## Task 2: Frontend — `CryptoGranularitySection` component + `Account` type + `SecurityPreferences` card

**Files:**
- Modify: `kylins.client.frontend/src/types/index.ts:77` (add `cryptoGranularity?: string;`).
- Create: `kylins.client.frontend/src/components/preferences/CryptoGranularitySection.tsx`.
- Modify: `kylins.client.frontend/src/components/preferences/SecurityPreferences.tsx` (add the card).
- Create: `kylins.client.frontend/tests/components/preferences/CryptoGranularitySection.test.tsx`.

**Interfaces:**
- Consumes: `updateAccount(id, updates)` (`services/accounts.ts:71`), `useAccountStore` (`stores/accountStore.ts` — `accounts` selector + `getState().updateAccountInPlace`), the `Account` interface (`types/index.ts`).
- Produces: `<CryptoGranularitySection />` mounted in `SecurityPreferences`.

- [ ] **Step 1: Add the TS field**

In `kylins.client.frontend/src/types/index.ts`, in the `Account` interface (ends `:77` with `easUserAgent?: string;`), add:

```ts
  cryptoGranularity?: string;
```

(Leave the existing `easUserAgent?: string;` line intact. `AccountUpdates` in `services/accounts.ts:51` is `Partial<Omit<Account, 'id' | 'createdAt'>>` — it auto-gains `cryptoGranularity?: string`, no edit there.)

- [ ] **Step 2: Write the failing component test**

Create `kylins.client.frontend/tests/components/preferences/CryptoGranularitySection.test.tsx`. **Before writing, find the nearest existing preferences-component test** (`grep -rl "testing-library/react" tests/ | head` and look for a preferences test) and mirror its mock-store + render pattern. Sketch:

```tsx
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { CryptoGranularitySection } from '@/components/preferences/CryptoGranularitySection';
import { useAccountStore } from '@/stores/accountStore';
import * as accountsApi from '@/services/accounts';

// Mock the account store with two accounts.
vi.mock('@/stores/accountStore', () => ({
  useAccountStore: {
    getState: () => ({ updateAccountInPlace: vi.fn() }),
  },
}));

const accounts = [
  { id: 'a1', email: 'one@x', displayName: 'One', cryptoGranularity: 'body_inline_merged_attachments' },
  { id: 'a2', email: 'two@x', displayName: 'Two', cryptoGranularity: undefined },
];

describe('CryptoGranularitySection', () => {
  beforeEach(() => {
    (useAccountStore as unknown as { setState: (s: unknown) => void }).setState({
      accounts, updateAccountInPlace: vi.fn(),
    });
  });

  it('seeds the dropdown from the picked account value', () => {
    render(<CryptoGranularitySection />);
    const select = screen.getByDisplayValue('Merged attachments (one part)');
    expect(select).toBeTruthy();
  });

  it('calls updateAccount with the chosen granularity', async () => {
    const spy = vi.spyOn(accountsApi, 'updateAccount').mockResolvedValue(undefined);
    render(<CryptoGranularitySection />);
    const select = screen.getByLabelText(/encryption granularity/i) as HTMLSelectElement;
    fireEvent.change(select, { target: { value: 'whole_message' } });
    await waitFor(() => {
      expect(spy).toHaveBeenCalledWith('a1', { cryptoGranularity: 'whole_message' });
    });
  });
});
```

**Verify-points (read the mirrored test + the component patterns first):** the exact store-mock pattern (Zustand `useAccountStore` mock — the sketch above is approximate; mirror the real one), the `getByLabelText`/`getByDisplayValue` queries (the component must render a `<label>` or `aria-label` for "Encryption granularity" so `getByLabelText` works — see Step 3's `<span>` + `aria`), and `@/` alias resolves in tests (it does — `vite.config.ts` + `tsconfig.json` map `@/*`).

- [ ] **Step 3: Run test to verify it fails**

Run: `cd kylins.client.frontend && npx vitest run tests/components/preferences/CryptoGranularitySection.test.tsx`
Expected: FAIL — `CryptoGranularitySection` module not found.

- [ ] **Step 4: Implement the component**

Create `kylins.client.frontend/src/components/preferences/CryptoGranularitySection.tsx`:

```tsx
import { useEffect, useState } from 'react';
import { useAccountStore } from '@/stores/accountStore';
import { updateAccount } from '@/services/accounts';

const GRANULARITY_OPTIONS = [
  { value: 'whole_message', label: 'Whole message (standard)' },
  { value: 'body_inline_per_attachment', label: 'Per-attachment' },
  { value: 'body_inline_merged_attachments', label: 'Merged attachments (one part)' },
] as const;

export function CryptoGranularitySection() {
  const accounts = useAccountStore((s) => s.accounts);
  const updateAccountInPlace = useAccountStore((s) => s.updateAccountInPlace);
  const [pickedAccountId, setPickedAccountId] = useState<string>('');
  const [granularity, setGranularity] = useState<string>('whole_message');
  const [error, setError] = useState<string | null>(null);

  // default to first account
  useEffect(() => {
    if (!pickedAccountId && accounts.length > 0) setPickedAccountId(accounts[0].id);
  }, [accounts, pickedAccountId]);

  // re-seed granularity when the picked account changes
  useEffect(() => {
    const picked = accounts.find((a) => a.id === pickedAccountId);
    setGranularity(picked?.cryptoGranularity ?? 'whole_message');
    setError(null);
  }, [pickedAccountId, accounts]);

  async function handleGranularityChange(next: string) {
    setGranularity(next);
    setError(null);
    try {
      await updateAccount(pickedAccountId, { cryptoGranularity: next });
      updateAccountInPlace(pickedAccountId, { cryptoGranularity: next });
    } catch (e) {
      setError(String(e));
      // revert to the persisted value
      const picked = accounts.find((a) => a.id === pickedAccountId);
      setGranularity(picked?.cryptoGranularity ?? 'whole_message');
    }
  }

  if (accounts.length === 0) {
    return (
      <span className="text-sm text-[var(--muted-text)]">
        Add an account first to set its encryption granularity.
      </span>
    );
  }

  // Verify the error color CSS var: check what other preferences components use
  // (e.g. grep "text-\[var(--" in components/preferences/). If no `--destructive`,
  // use the muted/red var the existing save-error displays use.
  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-col gap-1.5">
        <label htmlFor="crypto-granularity-account" className="text-xs text-[var(--muted-text)]">
          Choose account
        </label>
        <select
          id="crypto-granularity-account"
          value={pickedAccountId}
          onChange={(e) => setPickedAccountId(e.target.value)}
          className="h-11 px-3 text-sm rounded-lg border border-[var(--border)] bg-[var(--background)] text-[var(--foreground)] focus:border-[var(--primary)] focus:ring-2 focus:ring-[var(--ring)] outline-none"
        >
          {accounts.map((a) => (
            <option key={a.id} value={a.id}>
              {a.displayName ? `${a.displayName} (${a.email})` : a.email}
            </option>
          ))}
        </select>
      </div>
      <div className="flex flex-col gap-1.5">
        <label htmlFor="crypto-granularity" className="text-xs text-[var(--muted-text)]">
          Encryption granularity
        </label>
        <select
          id="crypto-granularity"
          value={granularity}
          onChange={(e) => handleGranularityChange(e.target.value)}
          className="h-11 px-3 text-sm rounded-lg border border-[var(--border)] bg-[var(--background)] text-[var(--foreground)] focus:border-[var(--primary)] focus:ring-2 focus:ring-[var(--ring)] outline-none"
        >
          {GRANULARITY_OPTIONS.map((o) => (
            <option key={o.value} value={o.value}>{o.label}</option>
          ))}
        </select>
        {granularity === 'body_inline_per_attachment' && (
          <span className="text-xs text-[var(--muted-text)]">
            No visible effect on standard S/MIME yet — for future E2EE.
          </span>
        )}
      </div>
      {error && (
        <span className="text-xs text-[var(--destructive)]">{error}</span>
      )}
    </div>
  );
}
```

**Verify-points:** (a) `useAccountStore` selector shape — confirm `accounts` and `updateAccountInPlace` are exposed (read `stores/accountStore.ts`); if the store uses `getState()` for actions, mirror `KeyManagerSection`'s exact access pattern. (b) the error-text CSS var — grep `components/preferences/` for an existing save-error color and use that var name (if `--destructive` isn't defined, use the one that is).

- [ ] **Step 5: Wire the card into `SecurityPreferences`**

In `kylins.client.frontend/src/components/preferences/SecurityPreferences.tsx`, add the import and a new card (mirror the existing `<PreferencesSectionCard>` usage — read the file first to match its exact JSX shape + import alias):

```tsx
import { CryptoGranularitySection } from './CryptoGranularitySection';
// ... and in the JSX, alongside the existing cards:
<PreferencesSectionCard title="Encryption granularity">
  <CryptoGranularitySection />
</PreferencesSectionCard>
```

- [ ] **Step 6: Run the component test to verify it passes**

Run: `cd kylins.client.frontend && npx vitest run tests/components/preferences/CryptoGranularitySection.test.tsx`
Expected: PASS — seeds from picked account; change calls `updateAccount('a1', { cryptoGranularity: 'whole_message' })`.

- [ ] **Step 7: Type-check + full frontend test suite**

Run: `cd kylins.client.frontend && npx tsc --noEmit && npx vitest run 2>&1 | tail -20`
Expected: `tsc` clean; all pre-existing frontend tests still pass (zero regression — the new `Account` field is optional).

- [ ] **Step 8: Commit**

```bash
cd kylins.client.frontend && npx prettier --write "src/components/preferences/CryptoGranularitySection.tsx" "tests/components/preferences/CryptoGranularitySection.test.tsx" 2>/dev/null || true
git add kylins.client.frontend/src/types/index.ts \
        kylins.client.frontend/src/components/preferences/CryptoGranularitySection.tsx \
        kylins.client.frontend/src/components/preferences/SecurityPreferences.tsx \
        kylins.client.frontend/tests/components/preferences/CryptoGranularitySection.test.tsx
git commit -m "feat(prefs): Encryption granularity dropdown in SecurityPreferences"
```

---

## Task 3: Full verification + smoke

**Files:** none modified — verification only.

- [ ] **Step 1: Full backend + frontend test run**

```bash
cd kylins.client.backend && cargo test -p kylins-client-backend --lib db:: 2>&1 | tail -15
cd ../kylins.client.frontend && npx tsc --noEmit && npx vitest run 2>&1 | tail -20
```
Expected: backend db suite green (incl. the 2 new Task 1 tests); frontend `tsc` clean + all tests green (incl. the new Task 2 test).

- [ ] **Step 2: Manual smoke (optional, recommended)**

```bash
cd kylins.client.backend && cargo tauri dev
```
In the app: open Settings → Security. Confirm the new "Encryption granularity" card shows an account picker + dropdown. Pick an account, set "Merged attachments (one part)". Verify via SQLite that the row updated:
```sql
SELECT id, email, crypto_granularity FROM accounts WHERE id = '<that account>';
```
Then compose an encrypted mail with ≥2 attachments from that account, send to `felixzhou@kylins.local`, and confirm on the receiving side that the merged `multipart/mixed` subtree round-trips (body + all attachments render) — proving the UI-set value flows through `send_op` → `build_mime_with_granularity`. (This is the parent feature's round-trip, now driven by a UI-set value.)

- [ ] **Step 3: Final commit if any smoke fixups needed**

```bash
git add <specific files>
git commit -m "test(prefs): EncryptionGranularity UI smoke fixups"
```

---

## Out of Scope (do NOT implement here)

- **Global `crypto.granularity` settings KV default + override.** Per-account column is the selector; global default is a later follow-up if wanted.
- **Placement in `AccountDetailsEditor`.** User chose `SecurityPreferences` with account picker.
- **Reset-to-NULL.** Set-only, per the `auth_type` precedent.
- **Any change to `send_op` / `build_mime` / `apply_crypto` / the `EncryptionGranularity` enum.** Those already read + apply the value (parent feature).
- **Composer per-message granularity override.** Granularity is account-level only.

## Self-Review

- **Spec coverage:** backend setter (`AccountUpdates` field + `push_str!`) → Task 1 ✓; TS `Account.cryptoGranularity` → Task 2 Step 1 ✓; `CryptoGranularitySection` component → Task 2 Step 4 ✓; `SecurityPreferences` card → Task 2 Step 5 ✓; value mapping table → Task 2 `GRANULARITY_OPTIONS` ✓; A caveat → Task 2 Step 4 (conditional `<span>`) ✓; backend + frontend tests → Task 1 Step 1 + Task 2 Step 2 ✓.
- **No placeholders:** verify-points are explicitly flagged with "read X first and mirror" where the exact name is codebase-specific (store mock pattern, error CSS var, `account_label` field) — the plan does not invent these.
- **Type consistency:** `cryptoGranularity` (TS) ↔ `crypto_granularity` (Rust, serde camelCase) ↔ DB column `crypto_granularity` ↔ `from_db_str` values (`'whole_message'` etc.). `updateAccount(id, { cryptoGranularity: next })` (TS) → `db_update_account` → `AccountUpdates.crypto_granularity` (Rust). The 3 value strings match `EncryptionGranularity::from_db_str` exactly.
