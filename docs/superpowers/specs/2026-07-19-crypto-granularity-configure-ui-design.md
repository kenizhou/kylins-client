# Encryption Granularity Configure UI — Design Spec

> Follow-up to the `EncryptionGranularity` implementation (branch `feat/encryption-granularity` @ `ba35769`), which added the enum, DB column, `Account` field, `get_crypto_granularity` loader, and `send_op` resolution — but **no configure surface**. The column is read-only end-to-end; settable only via direct SQLite edit. This spec adds the UI + setter.
>
> Date: 2026-07-19. Parent design: `docs/security/crypto-architecture-design.md` §11.4.1. Parent plan: `docs/superpowers/plans/2026-07-19-encryption-granularity.md`.

## Goal

A per-account UI to set `accounts.crypto_granularity`, persisted via the existing `db_update_account` IPC path, so users can choose Granularity B (the one with a now-visible composition effect) without editing SQLite.

## Confirmed decisions

1. **UI location:** a new `PreferencesSectionCard` in `SecurityPreferences.tsx` containing a new `CryptoGranularitySection` component (account-picker `<select>` + granularity `<select>`). Mirrors the `KeyManagerSection` pattern (separate component, own account picker, mounted in a `SecurityPreferences` card). NOT in `AccountDetailsEditor`.
2. **Reset:** set-only — no "reset to NULL" option. Selecting WholeMessage writes `'whole_message'` (not NULL). Matches the `auth_type` precedent (`AccountUpdates` is single-`Option<T>` everywhere; no `Option<Option<T>>` trichotomy). NULL remains only for fresh/migrated accounts (functionally = WholeMessage).
3. **Granularity A:** all 3 options shown; A carries a caveat "No visible effect on standard S/MIME yet — for future E2EE." Honest about the §11.4.1 A-form limitation.

## Architecture

`CryptoGranularitySection` (new) → `updateAccount(id, { cryptoGranularity })` (existing `services/accounts.ts:71`) → `invoke('db_update_account', { id, updates })` → `db_update_account` (`db/commands.rs:54`) → `accounts::update` (`db/accounts.rs:550`) → `UPDATE accounts SET crypto_granularity = ? WHERE id = ?` (new `push_str!` line). The frontend reads `account.cryptoGranularity` (new TS field) to seed the dropdown.

No new IPC command, no new migration, no settings KV — the column, the `Account` field, the loader, and the `db_update_account` command all already exist. This spec only (a) makes the column **settable** via `AccountUpdates` and (b) exposes it in the UI.

## Components / data flow

### Backend (1 file, 2 edits) — `kylins.client.backend/src/db/accounts.rs`

1. **`AccountUpdates` struct** (near `auth_type` at `:259`): add
   ```rust
   #[serde(default, skip_serializing_if = "Option::is_none")]
   pub crypto_granularity: Option<String>,
   ```
2. **`update()` SQL generator** (near `push_str!("auth_type", ...)` at `:630`): add
   ```rust
   push_str!("crypto_granularity", updates.crypto_granularity);
   ```
   The existing `push_str!` macro binds `Some(v)` → `SqliteValue::Text(v)` and skips `None` (don't-touch). Set-only semantics, consistent with `auth_type`.

No `lib.rs` change — `db_update_account` is already registered (`lib.rs:124`).

### Frontend (3 files)

3. **`kylins.client.frontend/src/types/index.ts:77`** — add to the `Account` interface:
   ```ts
   cryptoGranularity?: string;
   ```
   (Also add the missing `authType?: string;` for consistency — the Rust `Account` already serializes it. Optional, low-risk.) `AccountUpdates` (`services/accounts.ts:51 = Partial<Omit<Account,'id'|'createdAt'>>`) auto-gains `cryptoGranularity?: string` — no edit there. `updateAccountInPlace` (`stores/accountStore.ts:60`) already accepts `Partial<Account>` — no edit.

4. **New `kylins.client.frontend/src/components/preferences/CryptoGranularitySection.tsx`** — structure mirroring `KeyManagerSection.tsx`:
   - Pull `accounts` from `useAccountStore`.
   - Local state: `pickedAccountId` (default first account), seeded granularity from the picked account's `cryptoGranularity ?? 'whole_message'`.
   - Account-picker `<select>` (mirror `KeyManagerSection.tsx:265-276`).
   - Granularity `<select>` with 3 `<option>`s:
     - `value="whole_message"` → "Whole message (standard)"
     - `value="body_inline_per_attachment"` → "Per-attachment" — with a caveat line below: "No visible effect on standard S/MIME yet — for future E2EE."
     - `value="body_inline_merged_attachments"` → "Merged attachments (one part)"
   - On granularity change: `await updateAccount(pickedAccountId, { cryptoGranularity: next }); useAccountStore.getState().updateAccountInPlace(pickedAccountId, { cryptoGranularity: next });` — mirror the `AccountDetailsEditor.tsx:93-100` commit pattern.
   - Error handling: surface `updateAccount` failure via a transient error `<span>` (mirror the existing preferences save-error pattern — check `AccountDetailsEditor` / `KeyManagerSection` for the convention).
   - When `pickedAccountId` changes, re-seed the granularity dropdown from the newly-picked account's value.

5. **`kylins.client.frontend/src/components/preferences/SecurityPreferences.tsx`** — add a new card mounting the section:
   ```tsx
   <PreferencesSectionCard title="Encryption granularity">
     <CryptoGranularitySection />
   </PreferencesSectionCard>
   ```

## Dropdown value mapping

| UI label | `cryptoGranularity` value | `EncryptionGranularity` | Now-visible effect |
|---|---|---|---|
| Whole message (standard) | `whole_message` | `WholeMessage` | current behavior (one EnvelopedData) |
| Per-attachment | `body_inline_per_attachment` | `BodyInlineAndPerAttachment` | **none on standard S/MIME** (per-part benefit is `SplitPerPart`-only, future) |
| Merged attachments (one part) | `body_inline_merged_attachments` | `BodyInlineAndMergedAttachments` | merges all regular attachments into one nested `multipart/mixed` subtree |

The caveat on A is the design-doc §11.4.1 A-form limitation made visible to the user.

## Testing

### Backend
- Extend the existing `accounts.rs` `update` tests: assert `update` with `AccountUpdates { crypto_granularity: Some("body_inline_merged_attachments".into()), ..Default::default() }` produces SQL containing `crypto_granularity = ?` and that a subsequent `get_crypto_granularity` returns `Some("body_inline_merged_attachments")`. Mirror the nearest existing `update` test.
- Assert `update` with `crypto_granularity: None` does NOT touch the column (don't-touch semantics) — i.e. a prior value persists.

### Frontend
- Vitest + Testing Library component test for `CryptoGranularitySection`: render with a mock account store (2 accounts, one with `cryptoGranularity: 'body_inline_merged_attachments'`, one undefined), select account 1 → dropdown shows B; change dropdown to WholeMessage → assert `updateAccount` called with `(id, { cryptoGranularity: 'whole_message' })` and `updateAccountInPlace` called. Mirror the existing preferences-component test style under `tests/`.
- `npx tsc --noEmit` clean (the new `Account.cryptoGranularity` field type-checks).

## Out of scope

- **Global `crypto.granularity` settings KV default + override.** Per-account column is the selector; a global default is a later follow-up if wanted.
- **Placement in `AccountDetailsEditor`.** User chose `SecurityPreferences` with account picker.
- **Reset-to-NULL.** Set-only, per the `auth_type` precedent.
- **Any change to `send_op` / `build_mime` / the crypto path.** Those already read + apply `crypto_granularity` (done in the parent feature). This spec only makes the column settable + visible.
- **Composer per-message granularity override.** Granularity is account-level only (parent design §11.4.1 "选择器").

## Self-review

- **Spec coverage:** setter (backend `AccountUpdates` + `push_str!`) ✓; UI (`CryptoGranularitySection` + `SecurityPreferences` card) ✓; TS `Account` field ✓; value mapping table ✓; A caveat ✓; tests (backend + frontend) ✓.
- **No placeholders:** all file:line anchors are from the explore map (`accounts.rs:259/630`, `types/index.ts:77`, `KeyManagerSection.tsx:265-276`, `AccountDetailsEditor.tsx:93-100`, `SecurityPreferences.tsx`, `services/accounts.ts:51/71`, `accountStore.ts:60`).
- **Consistency:** set-only semantics match `auth_type` precedent; no new IPC/migration; the `Account` field + loader + `send_op` resolution already exist (parent feature).
- **Scope:** focused on the configure surface only; no crypto-path changes.
