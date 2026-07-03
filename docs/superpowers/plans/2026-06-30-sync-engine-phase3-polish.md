# Kylins Mail Sync Engine — Phase 3g: Tray / Notification / Status-Bar Polish

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the StatusBar, system tray, and desktop notifications reflect real sync state — replacing the hardcoded `"Synced · 3 accounts"` string with a live "Last synced 2m ago" + aggregated pending count + per-account status (idle/syncing/error/rate_limited), updating the tray tooltip with the aggregated unread count, and hardening new-mail notifications with dedupe + Do-Not-Disturb so the same message never notifies twice and the user can silence all notifications on demand.

**Architecture:** The backend already emits `sync:status` (`idle|syncing|error`, plus `rate_limited` once Phase 3f lands) and `sync:queue` (per-account pending count). The `accounts.last_sync_at` column is already stamped after every round by `touch_last_sync`, and `Account.last_sync_at` is already serialized to the frontend. The Rust commands `send_desktop_notification` and `set_tray_tooltip` already exist and are registered. This plan therefore **consumes** existing plumbing rather than building it: it adds (a) one new aggregated-unread DB read + Tauri command, (b) frontend aggregation of the per-account `sync:queue` event into a sum, (c) a dynamic StatusBar that reads `last_sync_at` + aggregated pending + status, (d) tray-tooltip updates driven off the aggregated unread count on every `sync:new-mail`/`sync:delta`, and (e) notification dedupe (message-id set, capped) + a DND setting wired through the existing settings KV.

**Tech Stack:** Rust (`sqlx` 0.8 sqlite, `tapi-plugin-notification` already in `Cargo.toml`); React 19 + TypeScript + Zustand (`uiStore`, `preferencesStore`); Tauri v2 IPC + event listeners (`@tauri-apps/api/event`); Vitest 4 + jsdom on the frontend; `cargo test --lib` on the backend.

## Authority & cross-validation

- **Survey of current state (verified by reading the code, not assumed):**
  - `kylins.client.frontend/src/hooks/useSyncEvents.ts:62-69` — listens to `sync:queue` but stores only the latest account's `pending` (`useUIStore.getState().setPendingCount(e.payload.pending)`). Comment explicitly says "multi-account aggregation is a later refinement." ✅ This plan implements that refinement.
  - `kylins.client.frontend/src/components/layout/StatusBar.tsx:20` — hardcoded `<span>Synced · 3 accounts</span>`. ✅ This plan replaces it.
  - `kylins.client.backend/src/lib.rs:67-68` — `send_desktop_notification` and `request_notification_permission` ARE registered (the survey's "if missing" branch is closed: they exist). `set_tray_tooltip` is registered at `lib.rs:59`. ✅ Task 1 becomes verify + test, not create.
  - `kylins.client.backend/src/commands.rs:85-92` — `send_desktop_notification` body is correct: `app.notification().builder().title().body().show()`. The Windows AUMID (`com.mailclient.app`) is set at `lib.rs:26-33` via `SetCurrentProcessExplicitAppUserModelID`, so toasts attribute correctly. ✅
  - `kylins.client.backend/src/db/accounts.rs:660-669` — `touch_last_sync` already runs `UPDATE accounts SET last_sync_at = unixepoch(), updated_at = unixepoch()`. Called at `engine.rs:569` after every successful round. ✅
  - `kylins.client.backend/src/db/accounts.rs:57` — `last_sync_at: Option<i64>` is on the `Account` struct with `#[serde(default, skip_serializing_if = "Option::is_none")]`. The frontend already receives it via `db_get_all_accounts`. ✅ No new command needed to *read* it — just consume it in the StatusBar.
  - `kylins.client.backend/src/db/labels.rs:193-210` — `get_unread_counts_by_account` returns `HashMap<String, i64>` keyed by `label_id`. There is **no** aggregated sum. ✅ Task 2 adds `get_total_unread(account_id?) -> i64`.
  - `kylins.client.backend/src/sync_engine/engine.rs:42-56` — `StatusEvent { account_id, state }` (and `detail: Option<i64>` once 3f lands); `QueueEvent { account_id, pending }`. States today: `syncing` (engine.rs:428), `error` (engine.rs:437), `idle` (engine.rs:572). `rate_limited` is added by Phase 3f. ✅ StatusBar must handle all four and degrade gracefully if `rate_limited` never arrives.
- **Phase 3f dependency:** 3f (`docs/superpowers/plans/2026-06-30-sync-engine-phase3-rate-limit.md`) adds the `rate_limited` state + `detail: Option<i64>` (retry_after epoch). This plan's StatusBar renders it if present and silently ignores it if not (the `state` string match falls through to the generic "Synced" label). No hard dependency — both can land in either order.
- **No new crate dependencies.** Everything uses the existing `tauri-plugin-notification`, `sqlx`, `tokio`, and frontend `zustand` + `@tauri-apps/api`.

## Global Constraints

- **Do NOT rewrite the sync engine or the EAS/IMAP transports.** This plan only adds *reads* (aggregated unread) and *consumes* events the engine already emits. No new `sync:*` event channels.
- **Reuse the existing settings KV for DND.** The `settings` table + `db_get_setting_bool` / `db_set_setting_bool` commands are the established path (see `preferencesStore.ts`). Add one new key, do not invent a new table.
- **Tray tooltip updates are best-effort.** `set_tray_tooltip` is a no-op on Linux (`commands.rs:31` logs + returns Ok). The frontend invokes it unconditionally; Linux silently drops it. Do not gate the call on platform.
- **Notification dedupe is in-memory, frontend-side.** A bounded `Set<string>` of recently-notified message-ids in the notification manager. Not persisted — on restart, a sync burst may re-notify for messages the engine re-reports as new. This is acceptable (the engine's `sync:new-mail` only fires for genuinely new UIDs post-cursor, so restart re-notify is rare). Persisting dedupe across restarts is a documented deferred follow-up.
- **`rate_limited` is optional.** Phase 3f may or may not be merged before this plan. The StatusBar matches the `state` string; if `rate_limited` is never emitted, the UI never shows that label. Do not add a hard dependency or a build-time feature flag.
- **No new heavy deps.** Use the notification plugin already present. Do not add `chrono` / `date-fns` — relative time ("2m ago") is a 15-line pure function in `src/utils/relativeTime.ts`.
- **One commit per task.** `cargo test --lib` green at each backend boundary; `npx vitest run` green at each frontend boundary.

---

## File Structure

**Backend (Rust):**
- `src/db/labels.rs` — add `get_total_unread(pool, account_id: Option<&str>) -> Result<i64, String>` (SUM over the same join as `get_unread_counts_by_account`, optionally scoped to one account).
- `src/db/commands.rs` — add `db_get_total_unread(account_id: Option<String>) -> Result<i64, String>` Tauri command wrapping the above.
- `src/lib.rs` — register `db_get_total_unread` in `invoke_handler!`. (No other backend changes — `send_desktop_notification`, `set_tray_tooltip`, `last_sync_at` all already exist.)

**Frontend (TypeScript / React):**
- `src/utils/relativeTime.ts` — NEW. Pure `formatRelativeTime(unixSeconds: number | null, now?: number): string` ("just now", "2m ago", "3h ago", "yesterday", "Jun 28").
- `src/stores/uiStore.ts` — extend `UIState`: replace `pendingCount: number` with `pendingByAccount: Record<string, number>` + a derived `aggregatedPending` getter; add `syncStateByAccount: Record<string, string>` (idle/syncing/error/rate_limited); add `setPendingForAccount(id, n)`, `setSyncStateForAccount(id, state)`, and `clearAccount(id)` (for account removal). Keep `pendingCount` as a deprecated computed proxy for one release so the StatusBar refactor is the only consumer that has to change in this plan.
- `src/hooks/useSyncEvents.ts` — wire `sync:queue` → `setPendingForAccount`; wire `sync:status` → `setSyncStateForAccount` (NEW listener); leave `sync:new-mail` / `sync:delta` / `tray-check-mail` as today, except `sync:new-mail` and `sync:delta` now also refresh the tray tooltip.
- `src/services/notifications/notificationManager.ts` — add dedupe set (`recentlyNotifiedIds: Set<string>`, cap 500 LRU-ish via shift-on-size) and a DND check (`usePreferencesStore.getState().doNotDisturb`). `notifyNewMailBatch` grows an optional `messageIds?: string[]` arg; if all ids are already in the set, skip. Add `notifyNewMailBatchDeduped(count, ids)`.
- `src/services/tray/traySync.ts` — NEW. `refreshTrayTooltip()` reads aggregated unread via `invoke('db_get_total_unread', { accountId: null })` and calls `invoke('set_tray_tooltip', { tooltip })` with `"Kylins Mail — N unread"` (or `"Kylins Mail"` when 0). Best-effort, never throws.
- `src/components/layout/StatusBar.tsx` — replace the hardcoded span with a `<SyncStatusIndicator />` sub-component that reads `aggregatedPending` + `syncStateByAccount` + the default account's `last_sync_at`, polls `last_sync_at` every 30s (for the relative-time label to tick), and renders the right string.
- `src/services/settingsKeys.ts` — add `doNotDisturb: 'do_not_disturb'`.
- `src/stores/preferencesStore.ts` — add `doNotDisturb: boolean` (default `false`) to `BOOL_FIELDS` + state + setter, mirroring the existing boolean fields.
- `src/components/preferences/NotificationsPanel.tsx` (or wherever the notifications preference UI lives — search for `showNotificationsForNewUnread` to find the panel) — add a "Do Not Disturb (silence all notifications)" toggle bound to `doNotDisturb`.

**Tests:**
- `kylins.client.backend/src/db/labels.rs` `#[cfg(test)]` — `get_total_unread_*` (3 cases: no rows → 0, single account summed, all-accounts aggregate filters read threads only).
- `kylins.client.frontend/tests/utils/relativeTime.test.ts` — NEW. Pure-function tests for the relative-time formatter (just now / under 1h / hours / yesterday / old date / null).
- `kylins.client.frontend/tests/stores/uiStore.aggregation.test.ts` — NEW. `setPendingForAccount` aggregates correctly; `setSyncStateForAccount` stores latest state; clearing one account drops its pending from the sum.
- `kylins.client.frontend/tests/services/notificationManager.dedupe.test.ts` — NEW. Same message-id notified twice → one notification; DND on → zero notifications; batch with mixed new/seen ids → only the new count notifies.
- `kylins.client.frontend/tests/components/StatusBar.test.tsx` — NEW. Renders "Synced · just now" when default account `last_sync_at` is now; renders "Offline — 3 pending" when aggregatedPending=3; renders "Syncing…" when any account state is `syncing`; renders "Rate limited" when state is `rate_limited`.

---

## Task 1: Backend — `get_total_unread` + `db_get_total_unread` command

**Files:**
- Modify: `kylins.client.backend/src/db/labels.rs` (add `get_total_unread` near `get_unread_counts_by_account`, ~line 210)
- Modify: `kylins.client.backend/src/db/commands.rs` (add `db_get_total_unread` near `db_get_unread_counts_by_account`, ~line 177)
- Modify: `kylins.client.backend/src/lib.rs` (register the command in `invoke_handler!`, ~line 129)

**Interfaces:**
- Consumes: the `threads` + `thread_labels` tables (same join as `get_unread_counts_by_account`).
- Produces:
  - `pub async fn get_total_unread(pool: &SqlitePool, account_id: Option<&str>) -> Result<i64, String>` — returns the total unread count across all accounts (or one account when `Some`).
  - `#[tauri::command] pub async fn db_get_total_unread(pool: State<'_, SqlitePool>, account_id: Option<String>) -> Result<i64, String>` — Tauri wrapper; `accountId: null` in TS maps to `None` here.
- Downstream: Task 5's `refreshTrayTooltip()` calls `invoke<number>('db_get_total_unread', { accountId: null })`.

- [ ] **Step 1: Write failing tests** in `kylins.client.backend/src/db/labels.rs` `#[cfg(test)] mod tests` (the module already exists at line 678 of `accounts.rs`; in `labels.rs` the test module starts further down — find it with `grep -n "mod tests" src/db/labels.rs`). Add these inside the existing `mod tests` in `labels.rs`:

```rust
#[tokio::test]
async fn get_total_unread_zero_when_no_threads() {
    let tmp = tempfile::tempdir().unwrap();
    let pool = crate::db::init_db(tmp.path()).await.unwrap();
    // Seed an account so the table exists but has no threads.
    crate::db::accounts::create(
        &pool,
        crate::db::accounts::CreateAccountInput {
            email: "a@x.com".into(),
            provider: "imap".into(),
            ..Default::default()
        },
    ).await.unwrap();
    let total = get_total_unread(&pool, None).await.unwrap();
    assert_eq!(total, 0);
}

#[tokio::test]
async fn get_total_unread_sums_unread_across_labels_for_one_account() {
    let tmp = tempfile::tempdir().unwrap();
    let pool = crate::db::init_db(tmp.path()).await.unwrap();
    seed_two_accounts_with_unread(&pool).await;
    // seed_two_accounts_with_unread plants: acct-1 has 3 unread in INBOX + 2 in Trash;
    // acct-2 has 4 unread in INBOX. Total for acct-1 = 5.
    let one = get_total_unread(&pool, Some("acct-1")).await.unwrap();
    assert_eq!(one, 5);
}

#[tokio::test]
async fn get_total_unread_all_accounts_aggregates() {
    let tmp = tempfile::tempdir().unwrap();
    let pool = crate::db::init_db(tmp.path()).await.unwrap();
    seed_two_accounts_with_unread(&pool).await;
    // acct-1 (5) + acct-2 (4) = 9.
    let all = get_total_unread(&pool, None).await.unwrap();
    assert_eq!(all, 9);
}
```

And the helper (place near the other test helpers in `labels.rs` `mod tests`):

```rust
/// Plant two accounts with known unread counts so aggregation tests are stable.
/// acct-1: 3 unread in "INBOX", 2 in "Trash". acct-2: 4 unread in "INBOX".
async fn seed_two_accounts_with_unread(pool: &SqlitePool) {
    for id in ["acct-1", "acct-2"] {
        sqlx::query(
            "INSERT INTO accounts (id, email, provider, is_active, is_default, sort_order, created_at, updated_at)
             VALUES (?, ?, 'imap', 1, 0, 0, strftime('%s','now'), strftime('%s','now'))",
        )
        .bind(id)
        .bind(format!("{id}@x.com"))
        .execute(pool).await.unwrap();
    }
    // Folders (labels) — minimal columns; id is the deterministic "{acct}:{remote}".
    for (acct, label_id, remote) in [
        ("acct-1", "acct-1:INBOX", "INBOX"),
        ("acct-1", "acct-1:Trash", "Trash"),
        ("acct-2", "acct-2:INBOX", "INBOX"),
    ] {
        sqlx::query(
            "INSERT INTO labels (id, account_id, name, type, visible, sort_order, source, role, parent_id, remote_id, delimiter, mail_class, hierarchical_name)
             VALUES (?, ?, ?, 'system', 1, 0, 'imap', NULL, NULL, ?, '/', '', '')",
        )
        .bind(label_id).bind(acct).bind(remote).bind(remote)
        .execute(pool).await.unwrap();
    }
    // Helper to plant a thread + its thread_labels row as unread.
    let mut plant = |acct: &str, label_id: &str, thread_id: &str, unread: i64| async move {
        for i in 0..unread {
            let tid = format!("{thread_id}-{i}");
            sqlx::query("INSERT INTO threads (id, account_id, is_read) VALUES (?, ?, 0)")
                .bind(&tid).bind(acct).execute(pool).await.unwrap();
            sqlx::query("INSERT INTO thread_labels (account_id, thread_id, label_id) VALUES (?, ?, ?)")
                .bind(acct).bind(&tid).bind(label_id).execute(pool).await.unwrap();
        }
    };
    plant("acct-1", "acct-1:INBOX", "t-in", 3).await;
    plant("acct-1", "acct-1:Trash",  "t-tr", 2).await;
    plant("acct-2", "acct-2:INBOX", "t-in2", 4).await;
}
```

- [ ] **Step 2: Run — expect FAIL.**

Run: `cargo test --lib db::labels`
Expected: compile error — `get_total_unread` not found (and the test helper references columns/tables that may need the right order; if the helper itself fails to compile on `remote` being bound twice, fix the `bind(remote).bind(remote)` — the labels INSERT needs `remote_id` and the `id` already encodes it, so `remote_id` = `remote` once).

- [ ] **Step 3: Implement.** In `kylins.client.backend/src/db/labels.rs`, immediately after `get_unread_counts_by_account` (around line 210):

```rust
/// Total unread thread count across all accounts (or one account when `account_id`
/// is `Some`). This is the aggregate shown in the tray tooltip
/// ("Kylins Mail — N unread") and is the source of truth for the StatusBar's
/// pending badge numerator. Uses the same `thread_labels × threads` join as
/// [`get_unread_counts_by_account`] so the two stay consistent.
pub async fn get_total_unread(
    pool: &SqlitePool,
    account_id: Option<&str>,
) -> Result<i64, String> {
    let total: (i64,) = if let Some(id) = account_id {
        sqlx::query_as(
            "SELECT COUNT(*) AS total
             FROM thread_labels tl
             JOIN threads t ON t.account_id = tl.account_id AND t.id = tl.thread_id
             WHERE tl.account_id = ? AND t.is_read = 0",
        )
        .bind(id)
        .fetch_one(pool)
        .await
    } else {
        sqlx::query_as(
            "SELECT COUNT(*) AS total
             FROM thread_labels tl
             JOIN threads t ON t.account_id = tl.account_id AND t.id = tl.thread_id
             WHERE t.is_read = 0",
        )
        .fetch_one(pool)
        .await
    }
    .map_err(|e| e.to_string())?;
    Ok(total.0)
}
```

In `kylins.client.backend/src/db/commands.rs`, immediately after `db_get_unread_counts_by_account` (~line 177):

```rust
/// Total unread across all accounts (when `account_id` is None) or one account.
/// Used by the tray tooltip + StatusBar aggregate badge.
#[tauri::command]
pub async fn db_get_total_unread(
    pool: State<'_, SqlitePool>,
    account_id: Option<String>,
) -> Result<i64, String> {
    labels::get_total_unread(&pool, account_id.as_deref()).await
}
```

In `kylins.client.backend/src/lib.rs`, add one line to the `invoke_handler!` list (alphabetical-ish, right after `db_get_threads` near line 134 — actually place it adjacent to `db_get_unread_counts_by_account` at line 129):

```rust
            db::commands::db_get_unread_counts_by_account,
            db::commands::db_get_total_unread,   // NEW
```

- [ ] **Step 4: Run — expect PASS.**

Run: `cargo test --lib db::labels`
Expected: 3 new tests pass; existing `unread_counts_*` tests still green.

Run: `cargo build` (backend) to confirm the Tauri command registers.
Expected: compiles clean.

- [ ] **Step 5: Commit** — `feat(db): get_total_unread + db_get_total_unread command for tray/statusbar aggregation`.

---

## Task 2: Frontend — `relativeTime` util + uiStore aggregation (`pendingByAccount`, `syncStateByAccount`)

**Files:**
- Create: `kylins.client.frontend/src/utils/relativeTime.ts`
- Modify: `kylins.client.frontend/src/stores/uiStore.ts`
- Test: `kylins.client.frontend/tests/utils/relativeTime.test.ts` (NEW)
- Test: `kylins.client.frontend/tests/stores/uiStore.aggregation.test.ts` (NEW)

**Interfaces:**
- Produces:
  - `formatRelativeTime(unixSeconds: number | null, now?: number): string` — pure.
  - `uiStore` additions: `pendingByAccount: Record<string, number>`, `syncStateByAccount: Record<string, string>`, `aggregatedPending` (a `useUIStore.getState().aggregatedPending()` helper OR a derived selector — see step 3 for the chosen shape), `setPendingForAccount(id, n)`, `setSyncStateForAccount(id, state)`, `clearAccount(id)`.
- Downstream: Task 3's `useSyncEvents` calls `setPendingForAccount` / `setSyncStateForAccount`; Task 4's StatusBar reads `aggregatedPending` + `syncStateByAccount`.

- [ ] **Step 1: Write failing tests** for `relativeTime`:

`kylins.client.frontend/tests/utils/relativeTime.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { formatRelativeTime } from '../../src/utils/relativeTime';

describe('formatRelativeTime', () => {
  const NOW = 1_700_000_000; // fixed epoch so assertions are deterministic

  it('returns "never" for null', () => {
    expect(formatRelativeTime(null, NOW)).toBe('never');
  });

  it('returns "just now" for < 60s', () => {
    expect(formatRelativeTime(NOW - 30, NOW)).toBe('just now');
    expect(formatRelativeTime(NOW - 5, NOW)).toBe('just now');
  });

  it('returns minutes for < 1h', () => {
    expect(formatRelativeTime(NOW - 60, NOW)).toBe('1m ago');
    expect(formatRelativeTime(NOW - 120, NOW)).toBe('2m ago');
    expect(formatRelativeTime(NOW - 3599, NOW)).toBe('59m ago');
  });

  it('returns hours for < 24h', () => {
    expect(formatRelativeTime(NOW - 3600, NOW)).toBe('1h ago');
    expect(formatRelativeTime(NOW - 7200, NOW)).toBe('2h ago');
  });

  it('returns "yesterday" for 24–48h', () => {
    expect(formatRelativeTime(NOW - 86400, NOW)).toBe('yesterday');
    expect(formatRelativeTime(NOW - 100_000, NOW)).toBe('yesterday');
  });

  it('returns absolute date for >= 48h', () => {
    // 5 days ago -> "Jun 24" style (month + day). Don't over-assert; check shape.
    const out = formatRelativeTime(NOW - 5 * 86400, NOW);
    expect(out).toMatch(/^[A-Z][a-z]{2} \d{1,2}$/);
  });
});
```

`kylins.client.frontend/tests/stores/uiStore.aggregation.test.ts`:

```typescript
import { describe, it, expect, beforeEach } from 'vitest';
import { useUIStore } from '../../src/stores/uiStore';

describe('uiStore sync aggregation', () => {
  beforeEach(() => {
    useUIStore.getState().setPendingCount(0); // legacy reset; also clears via init
    useUIStore.setState({ pendingByAccount: {}, syncStateByAccount: {} });
  });

  it('aggregatedPending sums all accounts', () => {
    useUIStore.getState().setPendingForAccount('a', 2);
    useUIStore.getState().setPendingForAccount('b', 3);
    expect(useUIStore.getState().aggregatedPending).toBe(5);
  });

  it('aggregatedPending updates when one account changes', () => {
    useUIStore.getState().setPendingForAccount('a', 2);
    useUIStore.getState().setPendingForAccount('b', 3);
    useUIStore.getState().setPendingForAccount('a', 0);
    expect(useUIStore.getState().aggregatedPending).toBe(3);
  });

  it('setSyncStateForAccount stores the latest state', () => {
    useUIStore.getState().setSyncStateForAccount('a', 'syncing');
    useUIStore.getState().setSyncStateForAccount('a', 'idle');
    expect(useUIStore.getState().syncStateByAccount['a']).toBe('idle');
  });

  it('clearAccount removes both pending and state', () => {
    useUIStore.getState().setPendingForAccount('a', 5);
    useUIStore.getState().setSyncStateForAccount('a', 'error');
    useUIStore.getState().clearAccount('a');
    expect(useUIStore.getState().aggregatedPending).toBe(0);
    expect(useUIStore.getState().syncStateByAccount['a']).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run — expect FAIL.**

Run: `cd kylins.client.frontend && npx vitest run tests/utils/relativeTime.test.ts tests/stores/uiStore.aggregation.test.ts`
Expected: FAIL — `relativeTime` module not found; `setPendingForAccount` / `aggregatedPending` / `setSyncStateForAccount` / `clearAccount` undefined on the store.

- [ ] **Step 3: Implement.**

`kylins.client.frontend/src/utils/relativeTime.ts` (NEW):

```typescript
// Pure relative-time formatter used by the StatusBar ("just now", "2m ago", …).
// No external dep — date-fns/chrono are overkill for 5 buckets.

const MONTHS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];

export function formatRelativeTime(
  unixSeconds: number | null | undefined,
  now: number = Math.floor(Date.now() / 1000),
): string {
  if (unixSeconds == null) return 'never';
  const delta = now - unixSeconds;
  if (delta < 0) return 'just now'; // clock skew / future timestamp
  if (delta < 60) return 'just now';
  if (delta < 3600) return `${Math.floor(delta / 60)}m ago`;
  if (delta < 86400) return `${Math.floor(delta / 3600)}h ago`;
  if (delta < 172800) return 'yesterday'; // < 48h
  const d = new Date(unixSeconds * 1000);
  return `${MONTHS[d.getMonth()]} ${d.getDate()}`;
}
```

`kylins.client.frontend/src/stores/uiStore.ts` — add the new fields + setters. The `pendingCount` legacy field stays (one-release bridge). Add inside `UIState` interface (after `pendingCount: number;`):

```typescript
  /** Per-account pending count (aggregated across accounts for display). */
  pendingByAccount: Record<string, number>;
  /** Per-account sync state: 'idle' | 'syncing' | 'error' | 'rate_limited'. */
  syncStateByAccount: Record<string, string>;
  /** Sum of all pendingByAccount values. Updated on every setPendingForAccount. */
  aggregatedPending: number;
  setPendingForAccount: (accountId: string, pending: number) => void;
  setSyncStateForAccount: (accountId: string, state: string) => void;
  /** Remove an account's entries (call on account deletion). */
  clearAccount: (accountId: string) => void;
```

In the store factory (`create<UIState>((set) => ({ … }))`), add defaults + setters:

```typescript
  pendingByAccount: {},
  syncStateByAccount: {},
  aggregatedPending: 0,
  setPendingForAccount: (accountId, pending) =>
    set((state) => {
      const next = { ...state.pendingByAccount, [accountId]: pending };
      const aggregatedPending = Object.values(next).reduce((a, b) => a + b, 0);
      return { pendingByAccount: next, aggregatedPending, pendingCount: aggregatedPending };
    }),
  setSyncStateForAccount: (accountId, syncState) =>
    set((state) => ({
      syncStateByAccount: { ...state.syncStateByAccount, [accountId]: syncState },
    })),
  clearAccount: (accountId) =>
    set((state) => {
      const { [accountId]: _, ...restPending } = state.pendingByAccount;
      const { [accountId]: __, ...restState } = state.syncStateByAccount;
      const aggregatedPending = Object.values(restPending).reduce((a, b) => a + b, 0);
      return {
        pendingByAccount: restPending,
        syncStateByAccount: restState,
        aggregatedPending,
        pendingCount: aggregatedPending,
      };
    }),
```

(Keep the existing `pendingCount: 0` default and `setPendingCount` setter — both now route through `setPendingForAccount` semantics; `setPendingCount` remains as a deprecated escape hatch that sets `aggregatedPending` directly without an account key. Do not remove it in this task — it would break any external caller.)

- [ ] **Step 4: Run — expect PASS.**

Run: `cd kylins.client.frontend && npx vitest run tests/utils/relativeTime.test.ts tests/stores/uiStore.aggregation.test.ts`
Expected: both files green.

Run: `cd kylins.client.frontend && npx tsc --noEmit`
Expected: 0 errors.

- [ ] **Step 5: Commit** — `feat(ui): formatRelativeTime + uiStore per-account pending/state aggregation`.

---

## Task 3: Frontend — `useSyncEvents` wires `sync:queue` + `sync:status` into aggregated store + tray refresh

**Files:**
- Modify: `kylins.client.frontend/src/hooks/useSyncEvents.ts`
- Modify: `kylins.client.frontend/src/services/notifications/notificationManager.ts` (add `notifyNewMailBatchDeduped` + dedupe set + DND check — see Task 5 for the full unit; here we only wire the listener)
- Create: `kylins.client.frontend/src/services/tray/traySync.ts`
- Test: extend the manual smoke check at Step 4 (no new vitest file for the hook — it is a thin listener over an event API that jsdom cannot exercise; covered by the StatusBar + uiStore tests transitively)

**Interfaces:**
- Consumes: `useUIStore.setPendingForAccount` / `setSyncStateForAccount` (Task 2); `refreshTrayTooltip` (this task); `notifyNewMailBatchDeduped` (Task 5).
- Produces:
  - `refreshTrayTooltip(): Promise<void>` — reads `db_get_total_unread` (Task 1), calls `set_tray_tooltip` with the formatted string. Best-effort (try/catch, never throws).
  - Updated `useSyncEvents` that listens to `sync:queue`, `sync:status` (NEW), and refreshes the tray on `sync:new-mail` + `sync:delta`.

- [ ] **Step 1: Write a failing test for `refreshTrayTooltip`** (the only pure-ish unit in this task). The event listener itself is exercised in the StatusBar integration test (Task 4) — we do not mock the Tauri event API here.

`kylins.client.frontend/tests/services/traySync.test.ts` (NEW):

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock the Tauri invoke BEFORE importing the unit under test.
const invokeMock = vi.fn();
vi.mock('@tauri-apps/api/core', () => ({
  invoke: (cmd: string, args?: unknown) => invokeMock(cmd, args),
}));

import { refreshTrayTooltip } from '../../src/services/tray/traySync';

describe('refreshTrayTooltip', () => {
  beforeEach(() => invokeMock.mockReset());

  it('sets tooltip "Kylins Mail — N unread" with the aggregated count', async () => {
    invokeMock.mockImplementation(async (cmd: string) => {
      if (cmd === 'db_get_total_unread') return 7;
      return undefined;
    });
    await refreshTrayTooltip();
    expect(invokeMock).toHaveBeenCalledWith('db_get_total_unread', { accountId: null });
    expect(invokeMock).toHaveBeenCalledWith('set_tray_tooltip', { tooltip: 'Kylins Mail — 7 unread' });
  });

  it('omits the count when 0', async () => {
    invokeMock.mockImplementation(async (cmd: string) => {
      if (cmd === 'db_get_total_unread') return 0;
      return undefined;
    });
    await refreshTrayTooltip();
    expect(invokeMock).toHaveBeenCalledWith('set_tray_tooltip', { tooltip: 'Kylins Mail' });
  });

  it('never throws when invoke rejects', async () => {
    invokeMock.mockRejectedValue(new Error('boom'));
    await expect(refreshTrayTooltip()).resolves.toBeUndefined();
  });
});
```

- [ ] **Step 2: Run — expect FAIL.**

Run: `cd kylins.client.frontend && npx vitest run tests/services/traySync.test.ts`
Expected: FAIL — module `../../src/services/tray/traySync` not found.

- [ ] **Step 3: Implement.**

`kylins.client.frontend/src/services/tray/traySync.ts` (NEW):

```typescript
// Best-effort tray tooltip sync. Reads the aggregated unread count from the
// backend and pushes a formatted tooltip to the OS tray via set_tray_tooltip.
// On Linux set_tray_tooltip is a no-op (commands.rs:31), so this is safe to
// call unconditionally. Never throws — failures are swallowed + logged.

import { invoke } from '@tauri-apps/api/core';

export async function refreshTrayTooltip(): Promise<void> {
  try {
    const total = await invoke<number>('db_get_total_unread', { accountId: null });
    const tooltip =
      total > 0 ? `Kylins Mail — ${total} unread` : 'Kylins Mail';
    await invoke('set_tray_tooltip', { tooltip });
  } catch (err) {
    // Best-effort: a missing tray (early boot, headless) is not fatal.
    console.warn('[tray] refreshTrayTooltip failed:', err);
  }
}
```

In `kylins.client.frontend/src/hooks/useSyncEvents.ts`, replace the body of the `sync:queue` listener and add a NEW `sync:status` listener + tray refresh calls. The full updated listener block (lines 53–80 of the current file become):

```typescript
        unlisteners.push(
          await listen<{ accountId: string; pending: number }>('sync:queue', (e) => {
            // Per-account pending count -> aggregated store. StatusBar reads
            // the sum (useUIStore.aggregatedPending), not just this account.
            useUIStore.getState().setPendingForAccount(e.payload.accountId, e.payload.pending);
          }),
        );

        unlisteners.push(
          await listen<{ accountId: string; state: string }>('sync:status', (e) => {
            // Per-account state (idle|syncing|error|rate_limited). StatusBar
            // renders the "worst" state across accounts. 'rate_limited' is
            // optional (Phase 3f) — if never emitted, this never fires that value.
            useUIStore.getState().setSyncStateForAccount(e.payload.accountId, e.payload.state);
          }),
        );

        // Tray tooltip + (Task 5) notification dedupe refresh on every change
        // that could move the unread count. Best-effort; failures are swallowed
        // inside refreshTrayTooltip.
        const refreshTray = () => {
          import('../services/tray/traySync')
            .then((m) => m.refreshTrayTooltip())
            .catch(() => {});
        };

        unlisteners.push(
          await listen<{ accountId: string; folderId: string; count: number }>(
            'sync:new-mail',
            (e) => {
              // Notify with dedupe (Task 5 wires notifyNewMailBatchDeduped).
              // For now the simple count-based call stays; Task 5 swaps it.
              notifyNewMailBatch(e.payload.count);
              refreshTray();
            },
          ),
        );

        // Any delta could have changed read/unread state -> refresh tray.
        unlisteners.push(
          await listen<{ accountId: string; labelId?: string; table?: string }>(
            'sync:delta',
            (e) => {
              if (e.payload.table !== 'labels') refreshTray();
            },
          ),
        );

        unlisteners.push(
          await listen('tray-check-mail', () => {
            useAccountStore
              .getState()
              .accounts.forEach((a) =>
                invoke('sync_account_now', { accountId: a.id }).catch(() => {}),
              );
          }),
        );
```

(Note: the existing `sync:delta` listener at lines 28–51 already reloads folders/threads — we ADD a second listener for the tray refresh rather than mutating the existing one, to keep the concerns separated. Both will fire; order is not guaranteed but neither blocks the other.)

- [ ] **Step 4: Run — expect PASS + manual smoke.**

Run: `cd kylins.client.frontend && npx vitest run tests/services/traySync.test.ts`
Expected: 3 tests pass.

Run: `cd kylins.client.frontend && npx tsc --noEmit`
Expected: 0 errors (the dynamic `import('../services/tray/traySync')` is fine without `@vite-ignore` because it is a static string literal resolved at build time — it is not a plugin path).

- [ ] **Step 5: Commit** — `feat(sync): wire sync:queue aggregation + sync:status + tray tooltip refresh`.

---

## Task 4: Frontend — dynamic `StatusBar` (last synced, aggregated pending, sync state)

**Files:**
- Modify: `kylins.client.frontend/src/components/layout/StatusBar.tsx`
- Test: `kylins.client.frontend/tests/components/StatusBar.test.tsx` (NEW)

**Interfaces:**
- Consumes: `useUIStore.aggregatedPending`, `useUIStore.syncStateByAccount`, `formatRelativeTime` (Task 2), `useAccountStore` (default account's `last_sync_at`).
- Produces: a `<SyncStatusIndicator />` sub-component rendered in place of the hardcoded span.

- [ ] **Step 1: Write failing tests.**

`kylins.client.frontend/tests/components/StatusBar.test.tsx` (NEW):

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { StatusBar } from '../../src/components/layout/StatusBar';
import { useUIStore } from '../../src/stores/uiStore';
import { useAccountStore } from '../../src/stores/accountStore';

// InjectComponentSet is mocked away so we don't pull the plugin registry in.
vi.mock('../../src/components/plugins/InjectedComponentSet', () => ({
  InjectedComponentSet: () => null,
}));

describe('StatusBar sync indicator', () => {
  beforeEach(() => {
    useUIStore.setState({
      pendingByAccount: {},
      syncStateByAccount: {},
      aggregatedPending: 0,
    });
  });

  it('shows "Synced · just now" when default account synced seconds ago', () => {
    const now = Math.floor(Date.now() / 1000);
    useAccountStore.setState({
      accounts: [
        { id: 'a', isDefault: true, lastSyncAt: now - 10 } as never,
      ],
    });
    render(<StatusBar />);
    expect(screen.getByText(/Synced · just now/)).toBeInTheDocument();
  });

  it('shows "Syncing…" when any account is syncing', () => {
    useAccountStore.setState({ accounts: [] });
    useUIStore.getState().setSyncStateForAccount('a', 'syncing');
    render(<StatusBar />);
    expect(screen.getByText(/Syncing…/)).toBeInTheDocument();
  });

  it('shows "Offline — N pending" with aggregated pending > 0 and not syncing', () => {
    useAccountStore.setState({ accounts: [] });
    useUIStore.getState().setPendingForAccount('a', 3);
    render(<StatusBar />);
    expect(screen.getByText(/Offline — 3 pending/)).toBeInTheDocument();
  });

  it('shows "Rate limited" when state is rate_limited', () => {
    useAccountStore.setState({ accounts: [] });
    useUIStore.getState().setSyncStateForAccount('a', 'rate_limited');
    render(<StatusBar />);
    expect(screen.getByText(/Rate limited/)).toBeInTheDocument();
  });

  it('shows "Sync error" when state is error', () => {
    useAccountStore.setState({ accounts: [] });
    useUIStore.getState().setSyncStateForAccount('a', 'error');
    render(<StatusBar />);
    expect(screen.getByText(/Sync error/)).toBeInTheDocument();
  });
});
```

**Note on `lastSyncAt`:** confirm the `accountStore` shape — the existing `Account` type uses `last_sync_at` from Rust which `#[serde(rename_all = "camelCase")]` serializes to `lastSyncAt`. If the existing `accountStore` type uses snake_case, adjust the test to match. Grep `accountStore.ts` for `last_sync_at|lastSyncAt` first and use the actual field name.

- [ ] **Step 2: Run — expect FAIL.**

Run: `cd kylins.client.frontend && npx vitest run tests/components/StatusBar.test.tsx`
Expected: FAIL — "Synced · just now" not found (the component still renders the hardcoded `"Synced · 3 accounts"`).

- [ ] **Step 3: Implement.** Rewrite the left-hand cluster of `kylins.client.frontend/src/components/layout/StatusBar.tsx`. The `<SyncStatusIndicator />` sub-component (defined in the same file, above `StatusBar`) encapsulates the logic so it stays testable in isolation:

```tsx
import { useEffect, useState } from 'react';
import { InjectedComponentSet } from '../plugins/InjectedComponentSet';
import { useUIStore } from '../../stores/uiStore';
import { useAccountStore } from '../../stores/accountStore';
import { formatRelativeTime } from '../../utils/relativeTime';
import { PlusIcon, MinimizeIcon } from '../icons';

const MIN_ZOOM = 0.5;
const MAX_ZOOM = 2;

function clampZoom(z: number): number {
  return Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, z));
}

// Priority order: higher beats lower for the "worst state" StatusBar label.
// rate_limited > syncing > error > idle. (syncing wins over error because a
// syncing account with an error elsewhere still shows "Syncing…".)
const STATE_PRIORITY: Record<string, number> = {
  rate_limited: 4,
  syncing: 3,
  error: 2,
  idle: 1,
};

function pickWorstState(states: Record<string, string>): string | undefined {
  let worst: string | undefined;
  let worstPri = 0;
  for (const s of Object.values(states)) {
    const pri = STATE_PRIORITY[s] ?? 0;
    if (pri > worstPri) {
      worstPri = pri;
      worst = s;
    }
  }
  return worst;
}

function SyncStatusIndicator() {
  const aggregatedPending = useUIStore((s) => s.aggregatedPending);
  const syncStateByAccount = useUIStore((s) => s.syncStateByAccount);
  const accounts = useAccountStore((s) => s.accounts);

  // Tick every 30s so "2m ago" rolls forward without a sync event.
  const [, setTick] = useState(0);
  useEffect(() => {
    const id = window.setInterval(() => setTick((t) => t + 1), 30_000);
    return () => window.clearInterval(id);
  }, []);

  const worst = pickWorstState(syncStateByAccount);

  if (worst === 'rate_limited') {
    return <span title="A provider asked us to slow down">Rate limited</span>;
  }
  if (worst === 'syncing') {
    return <span>Syncing…</span>;
  }
  if (worst === 'error') {
    return (
      <span title="Last sync round failed for at least one account">Sync error</span>
    );
  }
  // idle or no state reported yet -> "Synced · {relative}".
  const def = accounts.find((a) => a.isDefault) ?? accounts[0];
  const rel = formatRelativeTime(def?.lastSyncAt ?? null);
  return (
    <span title={def?.lastSyncAt ? new Date(def.lastSyncAt * 1000).toLocaleString() : undefined}>
      {aggregatedPending > 0
        ? `Offline — ${aggregatedPending} pending`
        : `Synced · ${rel}`}
    </span>
  );
}

export function StatusBar() {
  const readerZoom = useUIStore((s) => s.readerZoom);
  const setReaderZoom = useUIStore((s) => s.setReaderZoom);

  return (
    <footer className="h-[var(--status-h)] flex items-center justify-between px-3 text-[11px] bg-[var(--chrome)] text-[var(--muted-text)] shrink-0">
      <div className="flex items-center gap-3">
        <SyncStatusIndicator />
        <span>1 selected</span>
      </div>
      <div className="flex items-center gap-3">
        <InjectedComponentSet role="status-bar" containersRequired={false} />
        <div className="flex items-center gap-0.5">
          <button
            type="button"
            onClick={() => setReaderZoom(clampZoom(+(readerZoom - 0.1).toFixed(1)))}
            aria-label="Zoom out"
            className="flex h-5 w-5 items-center justify-center rounded transition-colors hover:bg-[var(--hover)] hover:text-[var(--foreground)]"
          >
            <MinimizeIcon size={11} />
          </button>
          <button
            type="button"
            onClick={() => setReaderZoom(1)}
            className="min-w-[2.5rem] text-center tabular-nums transition-colors hover:text-[var(--foreground)]"
            title="Reset zoom"
          >
            {Math.round(readerZoom * 100)}%
          </button>
          <button
            type="button"
            onClick={() => setReaderZoom(clampZoom(+(readerZoom + 0.1).toFixed(1)))}
            aria-label="Zoom in"
            className="flex h-5 w-5 items-center justify-center rounded transition-colors hover:bg-[var(--hover)] hover:text-[var(--foreground)]"
          >
            <PlusIcon size={11} />
          </button>
        </div>
        <span>Compact</span>
        <span>Reading pane right</span>
      </div>
    </footer>
  );
}
```

**Note on the `lastSyncAt` field:** the existing `useAccountStore` `accounts` array element type must expose `lastSyncAt`. If the type currently uses `last_sync_at`, change the access to `def?.['last_sync_at']` or — preferred — fix the type to camelCase so it matches the Rust serde output. Confirm by reading `accountStore.ts`; if the type is wrong, fix it in this task (it's a one-line type fix, not a separate concern).

- [ ] **Step 4: Run — expect PASS.**

Run: `cd kylins.client.frontend && npx vitest run tests/components/StatusBar.test.tsx`
Expected: 5 tests pass.

Run: `cd kylins.client.frontend && npx tsc --noEmit && npx vitest run`
Expected: 0 type errors; full frontend test suite still green (the StatusBar was the only consumer of the removed hardcoded span; the zoom buttons are unchanged).

- [ ] **Step 5: Commit** — `feat(statusbar): dynamic sync status (last-synced relative time + aggregated pending + per-account state)`.

---

## Task 5: Frontend — notification dedupe (message-id set) + Do-Not-Disturb setting

**Files:**
- Modify: `kylins.client.frontend/src/services/settingsKeys.ts` (add `doNotDisturb`)
- Modify: `kylins.client.frontend/src/stores/preferencesStore.ts` (add the boolean field + setter)
- Modify: `kylins.client.frontend/src/services/notifications/notificationManager.ts` (dedupe set + DND gate)
- Modify: `kylins.client.frontend/src/hooks/useSyncEvents.ts` (swap `notifyNewMailBatch(count)` → `notifyNewMailBatchDeduped(count, messageIds)` once the engine includes ids; until then the count-only path stays dedupe-by-batch-throttle)
- Modify: the existing notifications preferences panel — find it via `grep -rn "showNotificationsForNewUnread" kylins.client.frontend/src/components` and add a "Do Not Disturb" toggle next to it
- Test: `kylins.client.frontend/tests/services/notificationManager.dedupe.test.ts` (NEW)

**Interfaces:**
- Consumes: `usePreferencesStore.doNotDisturb` + `showNotificationsForNewUnread` (existing); the existing `invoke('send_desktop_notification', …)` Rust command.
- Produces:
  - `notifyNewMailBatchDeduped(count: number, messageIds?: string[]): void` — drops the call entirely if DND is on; drops if every id in `messageIds` is already in the recently-notified set; otherwise fires the OS notification and records the ids.
  - `notifyNewMail(sender, subject, messageId?: string)` — same dedupe applied to single-message notifications (used by future callers; today only the batch path is wired).
  - `clearNotificationDedupe(): void` — test-only reset hook.

**Dedupe key choice:** message id (`messages.id` = `imap-{account}-{folder}-{uid}` for IMAP; `eas-{...}` for EAS). Stable across syncs. The engine does **not** currently include ids in `sync:new-mail` payloads — `NewMailEvent` is `{ accountId, folderId, count }`. Two paths:
  - **(Preferred) Add ids to the event payload** — small Rust change: `NewMailEvent { account_id, folder_id, count, message_ids: Vec<String> }` populated from the just-applied delta. This makes per-message dedupe correct. **This is a one-line addition in engine.rs around line 560** (the loop that builds `counts.added` already has the row ids in hand).
  - **(Fallback) Dedupe by batch fingerprint** — `${accountId}:${folderId}:${count}` is unstable (count collisions), so this path falls back to *batch throttling* instead: at most one `sync:new-mail` notification per `(accountId, folderId)` per 30s. Less precise but requires no Rust change.

This plan does **(Preferred)** — add `message_ids` to `NewMailEvent`. It is a 4-line Rust change and unblocks correct dedupe.

- [ ] **Step 1: Write failing tests.**

`kylins.client.frontend/tests/services/notificationManager.dedupe.test.ts` (NEW):

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';

const invokeMock = vi.fn();
vi.mock('@tauri-apps/api/core', () => ({
  invoke: (cmd: string, args?: unknown) => invokeMock(cmd, args),
}));
// isPermissionGranted/requestPermission short-circuit to "granted".
vi.mock('@tauri-apps/plugin-notification', () => ({
  isPermissionGranted: async () => true,
  requestPermission: async () => 'granted',
}));

import {
  notifyNewMailBatchDeduped,
  clearNotificationDedupe,
} from '../../src/services/notifications/notificationManager';
import { usePreferencesStore } from '../../src/stores/preferencesStore';

describe('notificationManager dedupe + DND', () => {
  beforeEach(() => {
    invokeMock.mockReset();
    invokeMock.mockResolvedValue(undefined);
    clearNotificationDedupe();
    usePreferencesStore.setState({
      showNotificationsForNewUnread: true,
      doNotDisturb: false,
    });
  });

  it('fires once for a fresh set of ids', () => {
    notifyNewMailBatchDeduped(3, ['m1', 'm2', 'm3']);
    expect(invokeMock).toHaveBeenCalledTimes(1);
    expect(invokeMock).toHaveBeenCalledWith('send_desktop_notification', {
      title: 'New mail',
      body: '3 new messages',
    });
  });

  it('does NOT fire when all ids were already notified', () => {
    notifyNewMailBatchDeduped(2, ['m1', 'm2']);
    notifyNewMailBatchDeduped(2, ['m1', 'm2']);
    expect(invokeMock).toHaveBeenCalledTimes(1);
  });

  it('fires with the count of NEW ids when the batch is partially seen', () => {
    notifyNewMailBatchDeduped(2, ['m1', 'm2']);
    invokeMock.mockClear();
    notifyNewMailBatchDeduped(3, ['m1', 'm2', 'm3']);
    // 1 new id -> body says "1 new message".
    expect(invokeMock).toHaveBeenCalledWith('send_desktop_notification', {
      title: 'New mail',
      body: '1 new message',
    });
  });

  it('does NOT fire when DND is on, even for fresh ids', () => {
    usePreferencesStore.setState({ doNotDisturb: true });
    notifyNewMailBatchDeduped(5, ['fresh1', 'fresh2']);
    expect(invokeMock).not.toHaveBeenCalled();
  });

  it('does NOT fire when showNotificationsForNewUnread is false', () => {
    usePreferencesStore.setState({ showNotificationsForNewUnread: false });
    notifyNewMailBatchDeduped(2, ['fresh1', 'fresh2']);
    expect(invokeMock).not.toHaveBeenCalled();
  });

  it('falls back to the raw count when ids are not supplied', () => {
    notifyNewMailBatchDeduped(4);
    expect(invokeMock).toHaveBeenCalledWith('send_desktop_notification', {
      title: 'New mail',
      body: '4 new messages',
    });
  });
});
```

- [ ] **Step 2: Run — expect FAIL.**

Run: `cd kylins.client.frontend && npx vitest run tests/services/notificationManager.dedupe.test.ts`
Expected: FAIL — `notifyNewMailBatchDeduped` / `clearNotificationDedupe` not exported; `doNotDisturb` undefined on the preferences store.

- [ ] **Step 3: Implement.**

**Rust — add `message_ids` to `NewMailEvent`.** In `kylins.client.backend/src/sync_engine/engine.rs`, extend the struct (around line 38, near `StatusEvent`):

```rust
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NewMailEvent {
    account_id: String,
    folder_id: String,
    count: i64,
    /// Stable message ids of the just-arrived messages, for frontend dedupe.
    /// Empty when the source did not surface ids (the frontend falls back to
    /// count-only dedupe in that case).
    #[serde(default)]
    message_ids: Vec<String>,
}
```

Update the emit site (`engine.rs` ~line 560) — the surrounding loop already has the row id in scope. Find the block that computes `counts.added` and collect the ids:

```rust
engine.sink.emit_new_mail(NewMailEvent {
    account_id: account_id.into(),
    folder_id: label_id,
    count: counts.added as i64,
    message_ids: added_ids.clone(),   // populated in Task 5 step 3 (see below)
});
```

(If the loop over `delta.added` that produces `counts.added` does not currently collect ids, extend it: `let mut added_ids: Vec<String> = Vec::new();` then `added_ids.push(m.id.clone());` for each unread message — `RemoteMessage` has an `id` field, or build the deterministic `format!("imap-{account_id}-{folder}-{uid}")` if it doesn't. Match the existing `messages.id` shape used in `db::messages::upsert_message`.)

**Frontend — DND setting.** In `kylins.client.frontend/src/services/settingsKeys.ts`, add inside `SETTING_KEYS` under the Notifications section:

```typescript
  doNotDisturb: 'do_not_disturb',
```

In `kylins.client.frontend/src/stores/preferencesStore.ts`:
- Add to `BOOL_FIELDS`:
```typescript
  doNotDisturb: { key: SETTING_KEYS.doNotDisturb, defaultValue: false },
```
- Add to the `PreferencesState` interface (in the Notifications cluster near `showNotificationsForNewUnread`):
```typescript
  doNotDisturb: boolean;
  setDoNotDisturb: (value: boolean) => void;
```
- Add the setter alongside the other notification setters:
```typescript
  setDoNotDisturb: (value) => {
    set({ doNotDisturb: value });
    persist(SETTING_KEYS.doNotDisturb, value);
  },
```

**Frontend — notificationManager dedupe.** Replace the body of `kylins.client.frontend/src/services/notifications/notificationManager.ts`:

```typescript
import { isPermissionGranted, requestPermission } from '@tauri-apps/plugin-notification';
import { invoke } from '@tauri-apps/api/core';
import { usePreferencesStore } from '../../stores/preferencesStore';

// ---- Dedupe set (in-memory, bounded) ----
// Stable message ids already notified this session. Capped at MAX_DEDUPE;
// when exceeded we drop the oldest entries (FIFO) to bound memory.
const MAX_DEDUPE = 500;
const recentlyNotifiedIds = new Set<string>();
const dedupeOrder: string[] = [];

function rememberId(id: string): void {
  if (recentlyNotifiedIds.has(id)) return;
  recentlyNotifiedIds.add(id);
  dedupeOrder.push(id);
  if (dedupeOrder.length > MAX_DEDUPE) {
    const oldest = dedupeOrder.shift();
    if (oldest) recentlyNotifiedIds.delete(oldest);
  }
}

/** Test-only hook: clear the dedupe set between cases. */
export function clearNotificationDedupe(): void {
  recentlyNotifiedIds.clear();
  dedupeOrder.length = 0;
}

async function ensurePermission(): Promise<boolean> {
  try {
    const granted = await isPermissionGranted();
    if (granted) return true;
    const result = await requestPermission();
    return result === 'granted';
  } catch (err) {
    console.error('Notification permission check failed:', err);
    return false;
  }
}

function sendNotification(title: string, body: string) {
  // Send via Rust command so Windows toast attribution uses the
  // correct AppUserModelID (com.mailclient.app) instead of "Windows PowerShell".
  invoke('send_desktop_notification', { title, body }).catch(() => {});
}

/** True iff the user wants notifications AND DND is off. */
function notificationsAllowed(): boolean {
  const prefs = usePreferencesStore.getState();
  return prefs.showNotificationsForNewUnread && !prefs.doNotDisturb;
}

export async function notifyNewMail(
  sender: string,
  subject: string,
  messageId?: string,
): Promise<void> {
  if (!notificationsAllowed()) return;
  if (messageId && recentlyNotifiedIds.has(messageId)) return;
  const permitted = await ensurePermission();
  if (!permitted) return;
  sendNotification('New message', `${sender}: ${subject}`);
  if (messageId) rememberId(messageId);
}

/**
 * Notify a batch of new messages, deduped by stable message id. If `messageIds`
 * is omitted, falls back to the raw `count` (no per-message dedupe — used by
 * sources that don't surface ids yet, or for the legacy event payload shape).
 */
export function notifyNewMailBatchDeduped(count: number, messageIds?: string[]): void {
  if (!notificationsAllowed()) return;

  let effectiveCount = count;
  if (messageIds && messageIds.length > 0) {
    const fresh = messageIds.filter((id) => !recentlyNotifiedIds.has(id));
    if (fresh.length === 0) return; // entire batch already notified
    effectiveCount = fresh.length;
    fresh.forEach(rememberId);
  }

  if (effectiveCount <= 0) return;
  sendNotification(
    'New mail',
    `${effectiveCount} new message${effectiveCount === 1 ? '' : 's'}`,
  );
}

/** Legacy count-only entry point. Prefer notifyNewMailBatchDeduped. */
export function notifyNewMailBatch(count: number): void {
  notifyNewMailBatchDeduped(count, undefined);
}

export async function notifyRepeatedOpen(sender: string, subject: string): Promise<void> {
  const { showNotificationsForRepeatedOpens, doNotDisturb } = usePreferencesStore.getState();
  if (!showNotificationsForRepeatedOpens || doNotDisturb) return;
  const permitted = await ensurePermission();
  if (!permitted) return;
  sendNotification('Message opened again', `${sender}: ${subject}`);
}
```

**Frontend — preferences UI.** Find the existing notifications preference panel (likely `kylins.client.frontend/src/components/preferences/NotificationsPanel.tsx` or a section in `GeneralPanel.tsx`):

```bash
grep -rn "showNotificationsForNewUnread" kylins.client.frontend/src/components
```

In that file, add a toggle bound to `doNotDisturb` next to the existing new-unread toggle, mirroring the same `<Toggle>` / `<input type="checkbox">` pattern. Label: **"Do Not Disturb (silence all notifications)"**. Help text under it: "When on, no desktop notifications will be shown, even for new mail."

**Frontend — wire dedupe into `useSyncEvents`.** In `kylins.client.frontend/src/hooks/useSyncEvents.ts`, update the `sync:new-mail` listener (added in Task 3) to pass the ids:

```typescript
        unlisteners.push(
          await listen<{
            accountId: string;
            folderId: string;
            count: number;
            messageIds?: string[];
          }>('sync:new-mail', (e) => {
            notifyNewMailBatchDeduped(e.payload.count, e.payload.messageIds);
            refreshTray();
          }),
        );
```

(Also update the `notifyNewMailBatch` import at the top of `useSyncEvents.ts` to import `notifyNewMailBatchDeduped` instead.)

- [ ] **Step 4: Run — expect PASS.**

Run (backend): `cargo test --lib sync_engine`
Expected: existing engine tests still green (the `NewMailEvent` field is additive; existing assertions on `state` or `count` are unaffected). If any test pattern-matches the full `NewMailEvent` struct literal, add `message_ids: vec![]`.

Run (frontend): `cd kylins.client.frontend && npx vitest run tests/services/notificationManager.dedupe.test.ts`
Expected: 6 tests pass.

Run (full regression): `cd kylins.client.frontend && npx tsc --noEmit && npx vitest run`
Expected: 0 type errors; all frontend tests green.

- [ ] **Step 5: Commit** — `feat(notifications): per-message dedupe + Do-Not-Disturb setting; NewMailEvent carries message_ids`.

---

## Task 6: Backend regression + frontend regression + manual e2e

**Files:** no new code; full test runs + a documented manual e2e.

- [ ] **Step 1: Full backend regression.**

Run: `cargo test --lib`
Expected: all green. New tests added: 3 in `db::labels` (Task 1). `NewMailEvent.message_ids` field is additive (Task 5) — if any existing engine test constructs a `NewMailEvent` literal, it must now include `message_ids: vec![]`; fix and re-run if so.

- [ ] **Step 2: Full frontend regression.**

Run: `cd kylins.client.frontend && npx tsc --noEmit && npx vitest run`
Expected: tsc 0 errors; vitest all green. New test files: `relativeTime.test.ts` (6), `uiStore.aggregation.test.ts` (4), `traySync.test.ts` (3), `StatusBar.test.tsx` (5), `notificationManager.dedupe.test.ts` (6) = 24 new frontend tests.

- [ ] **Step 3: Manual e2e** (user runs `cargo tauri dev` against `felixzhou@kylins.local` IMAP + one EAS account):

  1. **StatusBar "Last synced"**: trigger a manual "Check for Mail" from the tray. The StatusBar should read "Synced · just now", then "1m ago", "2m ago" (tick every 30s, label rolls over within a minute).
  2. **Aggregated pending**: put the app offline (or stop the IMAP server), mark a message read in the UI. Within one poll the StatusBar should read "Offline — N pending" (the offline-op enqueue fires `sync:queue`). With two accounts both pending, the count should be the SUM (not just the latest account).
  3. **Per-account status**: while a sync round runs, the StatusBar should briefly show "Syncing…". On a forced auth failure it should show "Sync error".
  4. **Tray tooltip**: receive new mail. The tray tooltip should update to "Kylins Mail — N unread" within the sync round. Read one message → tooltip count drops by 1 on the next `sync:delta`.
  5. **Notification dedupe**: trigger the same message-id twice (e.g. by simulating a re-sync) — only one toast fires. (Hard to force naturally; covered by the unit test for the regression guarantee.)
  6. **Do Not Disturb**: toggle DND on in Preferences. Receive new mail. No toast fires. Toggle DND off, receive mail → toast fires normally.
  7. **Rate-limited** (only if Phase 3f has landed): force a 429 from the EAS/Graph provider. StatusBar should show "Rate limited".

- [ ] **Step 4: Commit** any test fixes discovered during regression (typically zero; if the manual e2e surfaces a bug, it gets its own fix+test commit, not a squash into Task 5).

- [ ] **Step 5: Update memory** — append a Phase 3g entry to `.claude/projects/.../memory/phase3-sync-decomposition.md` (or the equivalent progress doc) noting: tray tooltip + StatusBar are now dynamic; DND setting added; `db_get_total_unread` is the new aggregation seam; `NewMailEvent.message_ids` is the dedupe key.

---

## Deferred Follow-Ups (documented, NOT in this plan's scope)

- **Persisted notification dedupe.** The in-memory `recentlyNotifiedIds` set (cap 500) resets on restart, so a sync that re-reports a message as new (rare — the engine's `sync:new-mail` only fires for post-cursor new UIDs) will re-notify once after a restart. Persisting the set to `settings` KV or a dedicated `notified_messages` table (with a 7-day TTL sweep) would close this. Not worth the SQLite churn today.
- **Per-account StatusBar drill-down.** Today the StatusBar shows the "worst" state across accounts + an aggregated pending count. A click-handler that opens a popover with per-account rows (account name + its state + its pending + its last-synced) is the obvious next step. Deferred to the UX-polish phase.
- **Tray icon badge** (the actual icon overlay with the unread count, not the tooltip text). Windows + macOS support badge overlays via Tauri's `set_badge_count`-equivalent APIs (the tray crate surface); Linux does not. Not blocking — the tooltip already carries the count. Implement when a designer picks the badge asset.
- **Notification body content.** `notifyNewMailBatchDeduped` shows a generic "N new messages" body. Surfacing the sender+subject of the first new message (Outlook-style "From Alice: subject") requires the engine to include a lightweight envelope summary in `NewMailEvent`, not just ids. A `Vec<{ id, from, subject }>` field is the shape; defer until the envelope cost is measured.
- **Sound on new mail.** `notificationManager.ts:34` has a `playSoundOnNewMail` placeholder (`console.log('would play…')`). Wiring an actual `.wav`/`.mp3` asset through Tauri's audio API is a separate asset+API task.
- **Rate-limit "retry in Nm" text.** Once Phase 3f lands `StatusEvent.detail` (retry_after epoch), the StatusBar's "Rate limited" label can read "Rate limited — retry in 12m". Today it shows the bare label; the enhancement is one line in `SyncStatusIndicator` once `detail` is in the payload.

## Self-review notes

- **Spec coverage:**
  - "Backend `send_desktop_notification` command (if missing)" → verified it EXISTS (`commands.rs:85`, registered `lib.rs:67`). Task 1 is the **only** new Rust IPC work (`db_get_total_unread`); `send_desktop_notification` is left untouched. The "if missing" branch was conditioned on a survey guess that turned out wrong — documented at the top of this plan. ✅
  - "`db_get_sync_status(account_id)` / aggregated reads" → the `last_sync_at` field is ALREADY on the `Account` struct serialized to the frontend, so no new command is needed for it. The aggregated pending is computed in the frontend (`uiStore.aggregatedPending`) from the per-account `sync:queue` event. The aggregated UNREAD (a different aggregation — for the tray tooltip) is the new `db_get_total_unread` (Task 1). ✅ This is the cleaner split: events drive the live counts, the DB read is for the tooltip (lower-frequency).
  - "Aggregated pending — pick the cleaner option" → frontend aggregation chosen. Engine emits per-account `sync:queue` unchanged (no new `sync:queue-aggregated` event); the store sums. This keeps the engine boundary clean (one event per account per change) and the aggregation logic testable in isolation. ✅
  - "StatusBar dynamic" → Task 4 replaces the hardcoded span with `SyncStatusIndicator`, covering last-synced relative time, aggregated pending ("Offline — N pending"), and all four states (idle/syncing/error/rate_limited). ✅
  - "Tray polish" → Task 1 (read) + Task 3 (wire) deliver the tooltip update on every `sync:new-mail`/`sync:delta`. Badge overlay is deferred (no asset). ✅
  - "Notification hardening — dedupe + DND + throttle" → Task 5 delivers per-message dedupe (stable id set, cap 500) + DND setting (settings KV) + the batch falls back to count-only when ids absent. "Throttle batch notifications" is subsumed by per-message dedupe (a re-burst of the same messages is dropped entirely). ✅
- **Phase 3f dependency handled gracefully:** the StatusBar matches the literal string `"rate_limited"`; if 3f is not landed, that state never arrives and the label never shows. No feature flag, no build-time gate. Documented in Global Constraints + Task 4 comments + Deferred Follow-Ups. ✅
- **Type consistency:**
  - `formatRelativeTime(unixSeconds, now?)` — defined Task 2, consumed Task 4. ✅
  - `setPendingForAccount(id, n)` / `setSyncStateForAccount(id, state)` / `clearAccount(id)` / `aggregatedPending` — defined Task 2, consumed Task 3 (hook) + Task 4 (StatusBar). ✅
  - `refreshTrayTooltip()` — defined Task 3, consumed Task 3 (hook). ✅
  - `notifyNewMailBatchDeduped(count, messageIds?)` + `clearNotificationDedupe()` — defined Task 5, consumed Task 3/5 (hook). The legacy `notifyNewMailBatch(count)` is kept as a thin wrapper for one release. ✅
  - `NewMailEvent.message_ids: Vec<String>` (Rust, camelCase → `messageIds`) — defined Task 5, consumed Task 5 (hook listener payload type). ✅
  - `doNotDisturb` (preferencesStore boolean) — defined Task 5, consumed Task 5 (notificationManager). ✅
- **Placeholder scan:** no TBD / TODO / "add appropriate" / "similar to Task N". Every code step shows the full code. ✅
- **Honest MVP limitations:** in-memory dedupe (restart re-notify), no badge overlay asset, generic notification body, no per-account drill-down popover, sound is still a placeholder. All listed under Deferred Follow-Ups.

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-06-30-sync-engine-phase3-polish.md`. Two execution options:

1. **Subagent-Driven (recommended)** — fresh subagent per task, review between tasks. Task ordering is strict: 1 → 2 → (3, 4, 5 can partially parallelize but share `uiStore` so serialize 2 first) → 6.
2. **Inline Execution** — this session via executing-plans, batched with checkpoints.

Which approach?
