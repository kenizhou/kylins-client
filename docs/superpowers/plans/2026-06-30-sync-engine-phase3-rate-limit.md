# Kylins Mail Sync Engine — Phase 3f: Per-Account Rate-Limit Mode + Circuit Breaker

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop hammering a mail server that has told us to back off, and stop hot-looping an account whose connection is failing every 60 s. Today the engine's poll loop swallows every `run_sync_round` error with `let _ = …` and immediately re-arms the next 60 s tick; an HTTP 429 from EAS (or a Gmail/Graph 429 once Phase 3c/3d land) is logged and retried on the next tick regardless of `Retry-After`, and a persistent connectivity failure (dead socket, expired OAuth token) produces an indefinite stream of error-log noise with no cooldown. This plan adds (a) a per-account **rate-limit mode** keyed off a SQLite TTL row that the engine consults *before* scheduling a sync round, and (b) a per-account in-memory **circuit breaker** that escalates consecutive-failure backoff so a flapping account backs off for 15 s then 60 s instead of looping at full speed.

**Architecture:** The rate-limit state is a single SQLite table (`provider_rate_limit`) keyed by `account_id` with an absolute `retry_after` epoch. The engine reads it at the top of every poll/SyncNow wake; if `retry_after > now`, it emits `sync:status { state: "rate_limited", detail: retry_after }` and **returns without touching the source** — distinct from the normal `"error"` path so the UI can show "Rate limited — retrying at X" rather than a generic error. The TTL auto-expires: `get_rate_limit` lazy-deletes the row when the window has passed, so a stale limit never wedges an account. The circuit breaker is an in-memory `HashMap<AccountId, u32>` on the worker (not persisted — it resets to zero on restart, which is the correct fresh-start semantics). Each `run_sync_round` failure bumps the counter; thresholds 3 and 5 escalate the per-round cooldown (15 s, then 60 s) and at the higher threshold the remaining folders are skipped this round. A successful round resets the counter to zero.

**Tech Stack:** Rust; `sqlx` 0.8 (sqlite); existing `EventSink` / `sync:status` event; `tokio::time::sleep` for cooldowns; `reqwest::header::HeaderMap` for `Retry-After` (EAS client already uses `reqwest`). Reference pattern: `D:/Projects/mailclient/opensource/inbox-zero/apps/web/utils/email/rate-limit.ts` + `utils/redis/email-provider-rate-limit.ts` — on a 429, set `retryAt = now + delayMs` (delay from `Retry-After` or backoff); the entry auto-expires after the window. Desktop has no Redis → SQLite.

## Authority & cross-validation

- **HTTP semantics:** RFC 7231 §7.1.3 `Retry-After` (HTTP-date OR delta-seconds); the server MAY send it on `429 Too Many Requests` (RFC 6585 §4) and on `503 Service Unavailable`. We honor delta-seconds (the dominant form from Gmail/Graph/EAS gateways) and fall back to a fixed window when absent. HTTP-date parsing is **out of scope** (no `chrono`/`httpdate` runtime dep in this crate); we treat an unparseable header as "use the default window".
- **inbox-zero reference (verified locally):** `rate-limit.ts` keeps a Redis hash `rate-limit:{provider}` with `retryAt` (epoch ms). `assertProviderNotRateLimited` throws `RateLimitedError` when `retryAt > Date.now()`. The entry is set with a TTL equal to the window so Redis auto-expires it. **Desktop deviation:** SQLite has no native TTL, so we replicate the auto-expire via `retry_after < unixepoch()` ⇒ lazy-delete on read (Task 1).
- **Current engine state (verified in `engine.rs`):**
  - `spawn_worker` poll loop (engine.rs:313–328): 60 s `tokio::time::interval`; both tick and `SyncNow` branches do `let _ = run_sync_round(...)` — errors are dropped, loop continues. **Load-bearing for this plan:** we insert the rate-limit check *inside* `run_sync_round_with_source` (not the poll loop), so both paths benefit and the test seam stays intact.
  - `run_sync_round_with_source` (engine.rs:420): emits `"syncing"` at the top; `list_folders` fail → emit `"error"` + `return Err`; per-folder `sync_folder` fail → `log::warn!` + `continue`; `touch_last_sync` + emit `"idle"` on success.
  - `StatusEvent` struct (engine.rs:42–47) currently has only `account_id` + `state`. **We add an optional `detail` field** so `rate_limited` and `error` can carry the `retry_after` epoch / failure context. The field is `Option<i64>` (epoch seconds for rate-limit; omitted for plain syncing/idle) and serializes to `detail` in camelCase — the frontend reads it for the status-bar text in Phase 3g.
  - `run_replay_round` (engine.rs:379) is the per-account offline-op drain; it has its **own** failure accounting via `mark_failed` (per-op exponential backoff in `db/queue.rs:241`). **This plan does NOT touch replay backoff** — it is per-op, orthogonal to per-account-sync cooldown. The two layers compose.
- **EAS 429 surface (verified in `eas/client.rs:144-147`):** the HTTP layer rejects any `status != 200` with `EasError::HttpStatus { status, body }`, **discarding the response headers** — so `Retry-After` is currently unreachable. Task 5 widens `EasError::HttpStatus` to carry an optional `retry_after` and parses the header before constructing the error. The engine inspects it via `SourceError::Other(e.to_string())` today — Task 5 also adds a typed `SourceError::RateLimited { retry_after }` variant so the engine can `match` on it cleanly instead of string-matching.
- **Migration number:** `20260627000001_baseline.sql` is the only file in `kylins.client.backend/migrations/`. `20260630000001_rate_limit.sql` is the next free slot (today is 2026-06-30). Confirmed no clash.

## Global Constraints

- **SQLite, not Redis.** All rate-limit state lives in the same `mailclient.db`. No new runtime crate. The lazy-delete on read is the auto-expire equivalent; a periodic background sweeper is **not** added (a stale row costs one indexed SELECT per sync wake — negligible, and the next wake past the window deletes it).
- **Reuse the existing `EventSink` + `sync:status` event.** Do NOT add a new `sync:rate-limit` channel. The new state value `"rate_limited"` rides the existing event; the frontend already listens on `sync:status`. (Phase 3g renders it; here we only emit.)
- **Rate-limit check goes inside `run_sync_round_with_source`, not the poll loop.** This keeps the test seam (the function takes an explicit `src`) and covers both the tick path and the `SyncNow` path with one edit. A rate-limited round is a clean early-return `Ok(())` — it is NOT a failure (no `Err`, no breaker bump).
- **The breaker is in-memory only.** A `HashMap<AccountId, u32>` on the worker (well: on the `SyncEngine` behind its existing `Mutex`). Reset on restart is correct — a fresh process genuinely doesn't know the prior failure count, and starting at zero means the first post-restart round tries normally. Persisting it would survive a crash-loop but also wedge an account after a transient storm that crashed the app; the in-memory choice is the safer default. (Documented follow-up if crash-loops become a real problem.)
- **The breaker never skips the rate-limit check.** Order is: (1) rate-limit check (SQLite) → if limited, emit `rate_limited` + return `Ok`; (2) breaker check (in-memory) → if in cooldown, emit `error` + return `Ok` (do not bump the counter again); (3) normal round. This guarantees a server-told-us-to-wait signal always wins over our local failure counter.
- **No new crate dependencies.** `reqwest` (already in the EAS client) exposes `HeaderMap::get` + `HeaderValue::to_str` — sufficient for delta-seconds parsing. `httpdate` / `chrono` are NOT added (HTTP-date `Retry-After` falls back to the default window).
- **One commit per task. `cargo test --lib` green at each boundary.** Every task is TDD: failing test first (compile error or wrong behavior), then implement, then green.

---

## File Structure

**Backend (Rust):**
- `migrations/20260630000001_rate_limit.sql` — NEW. Creates `provider_rate_limit (account_id TEXT PRIMARY KEY REFERENCES accounts(id) ON DELETE CASCADE, retry_after INTEGER NOT NULL, updated_at INTEGER DEFAULT (unixepoch()))`.
- `src/db/rate_limit.rs` — NEW. `set_rate_limit`, `get_rate_limit`, `clear_rate_limit`, `is_rate_limited`. Lazy-delete on read. sqlx tests.
- `src/db/mod.rs` — add `pub mod rate_limit;` to the module list.
- `src/sync_engine/mod.rs` — add `SourceError::RateLimited { retry_after: i64 }` variant.
- `src/sync_engine/engine.rs` — add `detail: Option<i64>` to `StatusEvent`; add `breakers: Mutex<HashMap<String, BreakerState>>` to `SyncEngine`; insert rate-limit check + breaker check at the top of `run_sync_round_with_source`; insert breaker-record-failure on the two `Err` paths (`list_folders` fail, end-of-round aggregate); add `db_get_rate_limit_info` Tauri command (in `db/commands.rs`).
- `src/eas/client.rs` — widen `EasError::HttpStatus` to carry `retry_after: Option<i64>`; parse `Retry-After` header (delta-seconds) before constructing the error.
- `src/sync_engine/eas_source.rs` — map `EasError::HttpStatus { status: 429|503, retry_after: Some(..) }` to `SourceError::RateLimited { retry_after }`.
- `src/db/commands.rs` — NEW command `db_get_rate_limit_info(pool, account_id) -> Option<i64>` for the status-bar (Phase 3g will consume it).
- `src/lib.rs` — register `db::commands::db_get_rate_limit_info` in `generate_handler!`.

**Frontend:** Unchanged (status-bar display is Phase 3g). The new `sync:status { state: "rate_limited", detail }` event arrives through the existing listener; verify only.

---

## Task 1: `provider_rate_limit` table + DB helpers (lazy-delete TTL)

**Files:** `migrations/20260630000001_rate_limit.sql` (NEW), `src/db/rate_limit.rs` (NEW), `src/db/mod.rs`

**Interfaces:**
- Produces:
  - `provider_rate_limit` table (PK `account_id`, `retry_after INTEGER NOT NULL`, `updated_at INTEGER`).
  - `db::rate_limit::set_rate_limit(pool, account_id, retry_after_epoch: i64) -> Result<(), String>` — UPSERT.
  - `db::rate_limit::get_rate_limit(pool, account_id) -> Result<Option<i64>, String>` — returns `Some(retry_after)` if a live row exists; `None` if no row OR row past its window (lazy-deleted in the latter case).
  - `db::rate_limit::clear_rate_limit(pool, account_id) -> Result<(), String>` — unconditional DELETE (used by tests + future manual-clear UI).
  - `db::rate_limit::is_rate_limited(pool, account_id) -> bool` — thin wrapper: `get_rate_limit(...).map(|o| o.is_some()).unwrap_or(false)`. Never errors (a DB error ⇒ `false`, i.e. let the round try — failing open is safer than wedging every account on a transient SQLite I/O blip).

- [ ] **Step 1: Write failing tests** in `src/db/rate_limit.rs` `#[cfg(test)] mod tests`:

```rust
use super::*;
use crate::db::init_db;

async fn seed_account(pool: &SqlitePool, id: &str) {
    sqlx::query(
        "INSERT INTO accounts (id, email, provider, is_active, is_default, sort_order, created_at, updated_at)
         VALUES (?, ?, 'imap', 1, 0, 0, strftime('%s','now'), strftime('%s','now'))",
    )
    .bind(id)
    .bind(format!("{id}@x.com"))
    .execute(pool)
    .await
    .unwrap();
}

#[tokio::test]
async fn set_then_get_rate_limit_returns_retry_after() {
    let tmp = tempfile::tempdir().unwrap();
    let pool = init_db(tmp.path()).await.unwrap();
    seed_account(&pool, "a").await;

    let future = sqlx::query_as::<_, (i64,)>("SELECT unixepoch() + 300")
        .fetch_one(&pool).await.unwrap().0;
    set_rate_limit(&pool, "a", future).await.unwrap();

    assert_eq!(get_rate_limit(&pool, "a").await.unwrap(), Some(future));
    assert!(is_rate_limited(&pool, "a").await);
}

#[tokio::test]
async fn get_rate_limit_returns_none_when_no_row() {
    let tmp = tempfile::tempdir().unwrap();
    let pool = init_db(tmp.path()).await.unwrap();
    seed_account(&pool, "a").await;

    assert_eq!(get_rate_limit(&pool, "a").await.unwrap(), None);
    assert!(!is_rate_limited(&pool, "a").await);
}

#[tokio::test]
async fn get_rate_limit_lazy_deletes_expired_row_and_returns_none() {
    // The TTL auto-expire: a row whose retry_after is in the past must be
    // treated as "no limit" AND physically removed so it doesn't linger.
    let tmp = tempfile::tempdir().unwrap();
    let pool = init_db(tmp.path()).await.unwrap();
    seed_account(&pool, "a").await;

    // Plant a row 100s in the past.
    let past = sqlx::query_as::<_, (i64,)>("SELECT unixepoch() - 100")
        .fetch_one(&pool).await.unwrap().0;
    set_rate_limit(&pool, "a", past).await.unwrap();
    // Sanity: the row exists before we read.
    let (cnt,): (i64,) = sqlx::query_as(
        "SELECT COUNT(*) FROM provider_rate_limit WHERE account_id = 'a'")
        .fetch_one(&pool).await.unwrap();
    assert_eq!(cnt, 1);

    // Read -> None (expired) + row lazy-deleted.
    assert_eq!(get_rate_limit(&pool, "a").await.unwrap(), None);
    let (cnt,): (i64,) = sqlx::query_as(
        "SELECT COUNT(*) FROM provider_rate_limit WHERE account_id = 'a'")
        .fetch_one(&pool).await.unwrap();
    assert_eq!(cnt, 0, "expired row must be lazy-deleted on read");
    assert!(!is_rate_limited(&pool, "a").await);
}

#[tokio::test]
async fn set_rate_limit_is_upsert_so_latest_window_wins() {
    // A second 429 with a SHORTER window must NOT be clobbered by a stale
    // longer window — the server's latest Retry-After is authoritative.
    // (And vice versa: a longer later window replaces a shorter one.)
    let tmp = tempfile::tempdir().unwrap();
    let pool = init_db(tmp.path()).await.unwrap();
    seed_account(&pool, "a").await;

    let t1 = sqlx::query_as::<_, (i64,)>("SELECT unixepoch() + 600")
        .fetch_one(&pool).await.unwrap().0;
    let t2 = sqlx::query_as::<_, (i64,)>("SELECT unixepoch() + 30")
        .fetch_one(&pool).await.unwrap().0;

    set_rate_limit(&pool, "a", t1).await.unwrap();
    set_rate_limit(&pool, "a", t2).await.unwrap();

    assert_eq!(get_rate_limit(&pool, "a").await.unwrap(), Some(t2),
        "latest set_rate_limit must win (UPSERT, not INSERT OR IGNORE)");
}

#[tokio::test]
async fn clear_rate_limit_removes_row() {
    let tmp = tempfile::tempdir().unwrap();
    let pool = init_db(tmp.path()).await.unwrap();
    seed_account(&pool, "a").await;
    let future = sqlx::query_as::<_, (i64,)>("SELECT unixepoch() + 300")
        .fetch_one(&pool).await.unwrap().0;
    set_rate_limit(&pool, "a", future).await.unwrap();
    assert!(is_rate_limited(&pool, "a").await);

    clear_rate_limit(&pool, "a").await.unwrap();
    assert!(!is_rate_limited(&pool, "a").await);
    assert_eq!(get_rate_limit(&pool, "a").await.unwrap(), None);
}
```

- [ ] **Step 2: Run — expect FAIL** (no migration, no module, no functions).

Run: `cargo test --lib db::rate_limit`
Expected: compile error — `provider_rate_limit` table missing OR `rate_limit` module not found.

- [ ] **Step 3: Implement.**

Create `migrations/20260630000001_rate_limit.sql`:

```sql
-- Phase 3f: per-account rate-limit state. The engine consults this before
-- scheduling a sync round; a row whose retry_after > now causes the round to
-- be skipped and sync:status { state: "rate_limited", detail: retry_after }
-- to be emitted. Rows are lazy-deleted on read once the window passes
-- (db::rate_limit::get_rate_limit), so no background sweeper is needed.
--
-- ON DELETE CASCADE: dropping an account cleans its rate-limit row.
CREATE TABLE IF NOT EXISTS provider_rate_limit (
  account_id TEXT PRIMARY KEY REFERENCES accounts(id) ON DELETE CASCADE,
  retry_after INTEGER NOT NULL,
  updated_at INTEGER DEFAULT (unixepoch())
);
```

Add `pub mod rate_limit;` to `src/db/mod.rs` (alphabetical slot, after `pub mod queue;`).

Create `src/db/rate_limit.rs`:

```rust
//! Per-account rate-limit state (`provider_rate_limit` table).
//!
//! When a mail source returns a rate-limit error (HTTP 429 / 503 with
//! `Retry-After`, or an EAS protocol status indicating throttle), the engine
//! records `retry_after` (epoch seconds) here. Before scheduling each sync
//! round, the engine calls [`is_rate_limited`]; a live row skips the round and
//! emits `sync:status { state: "rate_limited", detail: retry_after }`.
//!
//! TTL: there is no background sweeper. [`get_rate_limit`] lazy-deletes an
//! expired row (one whose `retry_after <= unixepoch()`) the first time it is
//! read after expiry, returning `None`. This mirrors inbox-zero's Redis TTL
//! (`utils/redis/email-provider-rate-limit.ts`) without a Redis dependency.

use sqlx::SqlitePool;

/// Record (or replace) the rate-limit window for an account. UPSERT — the
/// latest server `Retry-After` is authoritative and must overwrite any prior
/// window in either direction.
pub async fn set_rate_limit(
    pool: &SqlitePool,
    account_id: &str,
    retry_after: i64,
) -> Result<(), String> {
    sqlx::query(
        "INSERT INTO provider_rate_limit (account_id, retry_after, updated_at)
         VALUES (?, ?, unixepoch())
         ON CONFLICT(account_id) DO UPDATE SET
           retry_after = excluded.retry_after,
           updated_at = excluded.updated_at",
    )
    .bind(account_id)
    .bind(retry_after)
    .execute(pool)
    .await
    .map_err(|e| e.to_string())?;
    Ok(())
}

/// Returns `Some(retry_after)` if the account is currently rate-limited, or
/// `None` if there is no row OR the row's window has passed (in which case the
/// expired row is lazy-deleted). Never panics; a DB error surfaces as `Err`.
pub async fn get_rate_limit(
    pool: &SqlitePool,
    account_id: &str,
) -> Result<Option<i64>, String> {
    let row: Option<(i64,)> = sqlx::query_as(
        "SELECT retry_after FROM provider_rate_limit WHERE account_id = ?",
    )
    .bind(account_id)
    .fetch_optional(pool)
    .await
    .map_err(|e| e.to_string())?;

    let Some((retry_after,)) = row else { return Ok(None) };

    let now: (i64,) = sqlx::query_as("SELECT unixepoch()")
        .fetch_one(pool)
        .await
        .map_err(|e| e.to_string())?;
    if retry_after > now.0 {
        Ok(Some(retry_after))
    } else {
        // Window passed — lazy-delete the stale row.
        let _ = sqlx::query("DELETE FROM provider_rate_limit WHERE account_id = ?")
            .bind(account_id)
            .execute(pool)
            .await;
        Ok(None)
    }
}

/// Unconditionally remove the rate-limit row (manual clear / tests).
pub async fn clear_rate_limit(pool: &SqlitePool, account_id: &str) -> Result<(), String> {
    sqlx::query("DELETE FROM provider_rate_limit WHERE account_id = ?")
        .bind(account_id)
        .execute(pool)
        .await
        .map_err(|e| e.to_string())?;
    Ok(())
}

/// Convenience: true iff a live rate-limit row exists. **Fails open** — a DB
/// error returns `false` so a transient SQLite blip does not wedge every
/// account's sync (the next round re-reads).
pub async fn is_rate_limited(pool: &SqlitePool, account_id: &str) -> bool {
    matches!(get_rate_limit(pool, account_id).await, Ok(Some(_)))
}
```

- [ ] **Step 4: Run — expect PASS.**

Run: `cargo test --lib db::rate_limit`
Expected: all 5 tests pass.

- [ ] **Step 5: Commit** — `feat(sync): provider_rate_limit table + lazy-delete TTL helpers`.

---

## Task 2: `StatusEvent.detail` + `SourceError::RateLimited` + engine rate-limit skip

**Files:** `src/sync_engine/mod.rs`, `src/sync_engine/engine.rs`

**Interfaces:**
- Produces:
  - `StatusEvent { account_id, state, detail: Option<i64> }` — `detail` carries the `retry_after` epoch for `rate_limited`, omitted (serialized as `null` / absent via `skip_serializing_if`) for `syncing`/`idle`. (Decision: serialize as `null` rather than omit — the frontend TS type stays a single optional field, simpler than a present/absent key. `skip_serializing_if = "Option::is_none"` is also acceptable; pick one and note it.)
  - `SourceError::RateLimited { retry_after: i64 }` — new variant; the engine pattern-matches it to record the rate limit then emit `rate_limited`.
  - The engine's `run_sync_round_with_source` consults `rate_limit::is_rate_limited` at the top; if limited, emits `rate_limited` + returns `Ok(())`.

- [ ] **Step 1: Write failing tests** in `src/sync_engine/engine.rs` `#[cfg(test)] mod tests`:

```rust
use crate::db::rate_limit;

/// When provider_rate_limit has a live row, run_sync_round_with_source MUST:
///   - emit exactly one sync:status { state: "rate_limited", detail: <epoch> }
///   - NOT call list_folders on the source (the source's recorded calls stay empty)
///   - return Ok(()) (rate-limiting is not an error)
///   - NOT advance the cursor or touch last_sync_at
#[tokio::test]
async fn run_round_skips_when_rate_limited_and_emits_status() {
    let tmp = tempfile::tempdir().unwrap();
    let pool = init_db(tmp.path()).await.unwrap();
    seed_account(&pool, "a").await;
    // Seed a live rate-limit window 300s in the future.
    let retry_after = sqlx::query_as::<_, (i64,)>("SELECT unixepoch() + 300")
        .fetch_one(&pool).await.unwrap().0;
    rate_limit::set_rate_limit(&pool, "a", retry_after).await.unwrap();

    let sink = Arc::new(TestSink::new());
    let engine = SyncEngine::new(pool.clone(), sink.clone());
    // MockSource with a folder + a message that must NEVER be fetched.
    let src = MockSource::new(
        vec![RemoteFolder { remote_id: "INBOX".into(), name: "INBOX".into(),
            delimiter: "/".into(), role: Some("inbox".into()), ..Default::default() }],
        vec![RemoteMessage { uid: 1, folder: "INBOX".into(),
            message_id: Some("<m1>".into()), ..Default::default() }],
    );

    run_sync_round_with_source(&engine, "a", "imap", &src).await.unwrap();

    // Source was never touched.
    assert!(src.recorded_calls().is_empty(),
        "rate-limited round must not call the source");
    // No messages landed in the DB.
    let (n,): (i64,) = sqlx::query_as("SELECT COUNT(*) FROM messages WHERE account_id = 'a'")
        .fetch_one(&pool).await.unwrap();
    assert_eq!(n, 0);

    // Exactly one status event, and it is rate_limited with the detail.
    let statuses = sink.statuses.lock().unwrap().clone();
    assert_eq!(statuses.len(), 1, "rate-limited round emits one status, not syncing+idle");
    assert_eq!(statuses[0].state, "rate_limited");
    assert_eq!(statuses[0].detail, Some(retry_after));
    assert_eq!(statuses[0].account_id, "a");
}

/// After the rate-limit window passes, the next round runs normally
/// (lazy-delete on read un-wedges the account without manual clear).
#[tokio::test]
async fn run_round_runs_normally_after_rate_limit_window_expires() {
    let tmp = tempfile::tempdir().unwrap();
    let pool = init_db(tmp.path()).await.unwrap();
    seed_account(&pool, "a").await;
    // Expired row.
    let past = sqlx::query_as::<_, (i64,)>("SELECT unixepoch() - 100")
        .fetch_one(&pool).await.unwrap().0;
    rate_limit::set_rate_limit(&pool, "a", past).await.unwrap();

    let sink = Arc::new(TestSink::new());
    let engine = SyncEngine::new(pool.clone(), sink.clone());
    let src = MockSource::new(
        vec![RemoteFolder { remote_id: "INBOX".into(), name: "INBOX".into(),
            delimiter: "/".into(), role: Some("inbox".into()), ..Default::default() }],
        vec![RemoteMessage { uid: 1, folder: "INBOX".into(),
            message_id: Some("<m1>".into()), ..Default::default() }],
    );

    run_sync_round_with_source(&engine, "a", "imap", &src).await.unwrap();

    // Normal round: syncing ... idle.
    let states: Vec<String> = sink.statuses.lock().unwrap()
        .iter().map(|s| s.state.clone()).collect();
    assert!(states.contains(&"syncing".to_string()));
    assert!(states.contains(&"idle".to_string()));
    assert!(!states.contains(&"rate_limited".to_string()));
    // And the stale row was lazy-deleted.
    let (cnt,): (i64,) = sqlx::query_as(
        "SELECT COUNT(*) FROM provider_rate_limit WHERE account_id = 'a'")
        .fetch_one(&pool).await.unwrap();
    assert_eq!(cnt, 0);
}
```

- [ ] **Step 2: Run — expect FAIL** (`StatusEvent` has no `detail` field; `rate_limited` state never emitted; `StatusEvent { ... }` literals in tests fail to compile).

Run: `cargo test --lib sync_engine::engine`
Expected: compile errors — `detail` field missing; `state: "rate_limited"` never produced.

- [ ] **Step 3: Implement.**

In `src/sync_engine/mod.rs`, extend `SourceError`:

```rust
#[derive(Debug, thiserror::Error)]
pub enum SourceError {
    #[error("source does not support this operation")]
    Unsupported,
    #[error("source rate-limited; retry after epoch {retry_after}")]
    RateLimited { retry_after: i64 },
    #[error("{0}")]
    Other(String),
}
```

(Verify the existing `SourceError` derives — if it does NOT currently use `thiserror`, mirror the existing style: the variant is the only thing that matters for the engine's `match`. Confirm `thiserror` is already a dependency; if not, hand-roll `Display` + `From` to match the existing pattern — do NOT add a new crate dep just for this.)

In `src/sync_engine/engine.rs`, widen `StatusEvent`:

```rust
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StatusEvent {
    pub account_id: String,
    pub state: String,
    /// Epoch-seconds payload. Carries `retry_after` for `rate_limited`,
    /// omitted (None) for `syncing` / `idle`. Phase 3g renders the status
    /// bar from this; here we only emit.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub detail: Option<i64>,
}
```

Update every existing `StatusEvent { account_id, state }` literal in `engine.rs` to add `detail: None`. (`cargo build` will list them — they are at: the `"syncing"` emit at the top of `run_sync_round_with_source`, the `"error"` emit on `list_folders` failure, and the `"idle"` emit at the end. The test helpers in `engine.rs::tests` construct `StatusEvent` only via the sink, so no test-helper edits are needed beyond the new tests above.)

At the very top of `run_sync_round_with_source`, before the existing `"syncing"` emit, insert the rate-limit check:

```rust
async fn run_sync_round_with_source(
    engine: &Arc<SyncEngine>,
    account_id: &str,
    provider: &str,
    src: &dyn MailSource,
) -> Result<(), String> {
    // ---- Phase 3f: rate-limit short-circuit ----
    // A live provider_rate_limit row skips the round entirely. This is NOT
    // an error: the server told us to back off, so we emit a distinct state
    // the UI can render ("Rate limited — retrying at X") and return Ok. The
    // breaker counter is NOT bumped on this path. get_rate_limit lazy-
    // deletes an expired row, so a stale window self-heals on the next wake.
    match crate::db::rate_limit::get_rate_limit(&engine.pool, account_id).await {
        Ok(Some(retry_after)) => {
            engine.sink.emit_status(StatusEvent {
                account_id: account_id.into(),
                state: "rate_limited".into(),
                detail: Some(retry_after),
            });
            return Ok(());
        }
        Ok(None) => {} // not limited — proceed
        Err(e) => log::warn!("[sync] {account_id} rate_limit read failed (fail-open): {e}"),
    }

    engine.sink.emit_status(StatusEvent {
        account_id: account_id.into(),
        state: "syncing".into(),
        detail: None,
    });
    // ... (rest of the existing function unchanged) ...
}
```

- [ ] **Step 4: Run — expect PASS.**

Run: `cargo test --lib sync_engine::engine`
Expected: both new tests pass; existing engine tests still green (the `detail: None` literal update is mechanical).

- [ ] **Step 5: Commit** — `feat(sync): StatusEvent.detail + rate-limit short-circuit before sync round`.

---

## Task 3: Circuit breaker — in-memory consecutive-failure counter + cooldown

**Files:** `src/sync_engine/engine.rs`

**Interfaces:**
- Produces:
  - `BreakerState { failures: u32, cooldown_until: i64 }` struct (private to engine).
  - `breakers: Mutex<HashMap<String, BreakerState>>` field on `SyncEngine`.
  - Constants: `BREAKER_THRESHOLD_SHORT = 3`, `BREAKER_THRESHOLD_LONG = 5`, `BREAKER_COOLDOWN_SHORT_SECS = 15`, `BREAKER_COOLDOWN_LONG_SECS = 60`.
  - At the top of `run_sync_round_with_source` (after the rate-limit check, before `"syncing"`), consult the breaker: if `now < cooldown_until`, emit `sync:status { state: "error", detail: Some(cooldown_until) }` and return `Ok(())` WITHOUT bumping the counter. On any failure path (`list_folders` Err; end-of-round if any folder failed and we choose to count aggregate — see decision below), bump the counter and recompute `cooldown_until`. On success, reset to zero.

- **Decision — what counts as a "failure" for the breaker?** A `list_folders` failure is unambiguous (the whole round is dead). A per-folder `sync_folder` failure today is `log::warn!` + `continue` — counting every folder failure would trip the breaker on a single bad folder. **Choice: count `list_folders` failure + `run_sync_round` returning `Err`** (which today only happens on `list_folders`). Per-folder failures do NOT bump the breaker (they are already best-effort + logged). This keeps the breaker focused on "the account is unreachable" storms, which is the stated goal (IMAP connectivity storms / dead sockets).

- [ ] **Step 1: Write failing tests** in `src/sync_engine/engine.rs` `#[cfg(test)] mod tests`. The breaker is driven by `list_folders` failing, so we use a `FailingSource` (the existing one in `run_replay_round_failure_retains_op…` is a model — write a minimal one that fails `list_folders`):

```rust
use async_trait::async_trait;

/// A MailSource whose list_folders always errors — simulates a dead socket /
/// expired token, the exact connectivity storm the breaker exists to calm.
struct ListFoldersFailingSource;
#[async_trait]
impl MailSource for ListFoldersFailingSource {
    fn capabilities(&self) -> crate::sync_engine::Capabilities {
        crate::sync_engine::Capabilities::default()
    }
    async fn list_folders(&self) -> Result<Vec<RemoteFolder>, crate::sync_engine::SourceError> {
        Err(crate::sync_engine::SourceError::Other("simulated outage".into()))
    }
    // sync_folder, fetch_body, set_flags, move_messages, delete_messages,
    // append, send — all `Err(Unsupported)` (copy the shape from the existing
    // FailingSource in run_replay_round_failure_retains_op…).
    // ... (elided for brevity — see existing FailingSource in this file)
}

/// After N consecutive list_folders failures the breaker enters cooldown:
/// the next round emits `error` + detail=cooldown_until and returns Ok
/// WITHOUT calling the source. Verify: source is not touched on the
/// cooldown-bypass round.
#[tokio::test]
async fn breaker_enters_cooldown_after_threshold_consecutive_failures() {
    let tmp = tempfile::tempdir().unwrap();
    let pool = init_db(tmp.path()).await.unwrap();
    seed_account(&pool, "a").await;
    let sink = Arc::new(TestSink::new());
    let engine = SyncEngine::new(pool.clone(), sink.clone());
    let src = ListFoldersFailingSource;

    // Drive 3 failing rounds (= BREAKER_THRESHOLD_SHORT). Each emits syncing+error.
    for _ in 0..3 {
        let _ = run_sync_round_with_source(&engine, "a", "imap", &src).await;
    }

    // The 4th round (still under cumulative failures >= threshold_short, now in
    // cooldown) must short-circuit: ONE status event = { error, detail=Some(..) }
    // and the source's list_folders is NOT called again.
    sink.statuses.lock().unwrap().clear();
    run_sync_round_with_source(&engine, "a", "imap", &src).await.unwrap();
    let statuses = sink.statuses.lock().unwrap().clone();
    assert_eq!(statuses.len(), 1, "cooldown round emits exactly one status");
    assert_eq!(statuses[0].state, "error");
    assert!(statuses[0].detail.is_some(), "breaker cooldown detail is an epoch");
}

/// A single successful round resets the breaker to zero failures, so a later
/// outage must accumulate fresh failures before tripping again.
#[tokio::test]
async fn breaker_resets_to_zero_on_successful_round() {
    let tmp = tempfile::tempdir().unwrap();
    let pool = init_db(tmp.path()).await.unwrap();
    seed_account(&pool, "a").await;
    let sink = Arc::new(TestSink::new());
    let engine = SyncEngine::new(pool.clone(), sink.clone());

    // Two failures (below threshold).
    for _ in 0..2 {
        let _ = run_sync_round_with_source(
            &engine, "a", "imap", &ListFoldersFailingSource).await;
    }
    // Then a successful round (MockSource with an empty folder list).
    let ok_src = MockSource::new(vec![], vec![]);
    run_sync_round_with_source(&engine, "a", "imap", &ok_src).await.unwrap();

    // Breaker should be reset. Two more failures must NOT trip the breaker yet
    // (would need a 3rd). Verify the 3rd round after reset still goes through
    // the normal syncing path rather than cooldown-bypass.
    sink.statuses.lock().unwrap().clear();
    for _ in 0..2 {
        let _ = run_sync_round_with_source(
            &engine, "a", "imap", &ListFoldersFailingSource).await;
    }
    let last_state = sink.statuses.lock().unwrap().last().unwrap().state.clone();
    assert_eq!(last_state, "error",
        "two failures after a reset must produce a normal error round, not a cooldown bypass");
    // The cooldown-bypass path emits ONLY one status; the normal-failure path
    // emits syncing THEN error (two). Distinguish by count.
    let len_after_two_failures = sink.statuses.lock().unwrap().len();
    assert!(len_after_two_failures >= 4,
        "two normal failure rounds each emit syncing+error (>=4 events); a cooldown bypass would emit 1");
}
```

- [ ] **Step 2: Run — expect FAIL** (no `breakers` field; `cooldown_until` logic absent; the 4th round still calls `list_folders`).

Run: `cargo test --lib sync_engine::engine`

- [ ] **Step 3: Implement.** In `src/sync_engine/engine.rs`:

Add near the top constants and the state struct:

```rust
const BREAKER_THRESHOLD_SHORT: u32 = 3;
const BREAKER_THRESHOLD_LONG: u32 = 5;
const BREAKER_COOLDOWN_SHORT_SECS: i64 = 15;
const BREAKER_COOLDOWN_LONG_SECS: i64 = 60;

#[derive(Clone, Copy, Default)]
struct BreakerState {
    failures: u32,
    cooldown_until: i64,
}
```

Add the field to `SyncEngine`:

```rust
pub struct SyncEngine {
    workers: Mutex<HashMap<String, WorkerHandle>>,
    pool: SqlitePool,
    sink: Arc<dyn EventSink>,
    /// Per-account consecutive-failure counter + cooldown. In-memory only —
    /// resets on restart, which is the correct fresh-start semantics (a fresh
    /// process doesn't know the prior failure count and should try once
    /// normally). See Phase 3f plan Global Constraints for the rationale.
    breakers: Mutex<HashMap<String, BreakerState>>,
}
```

(Update the `SyncEngine::new` initializer to add `breakers: Mutex::new(HashMap::new())`. `new_tauri` delegates to `new`, so no extra edit.)

Add helper functions (private, above `run_sync_round_with_source`):

```rust
/// Returns Some(cooldown_until) if the account is currently in breaker
/// cooldown, else None. Pure read — does not mutate the breaker state.
async fn breaker_cooldown(engine: &SyncEngine, account_id: &str) -> Option<i64> {
    let now = unix_now(&engine.pool).await;
    let bs = engine.breakers.lock().await;
    let state = bs.get(account_id).copied()?;
    if now < state.cooldown_until { Some(state.cooldown_until) } else { None }
}

/// Record a failed round: bump the failure counter and, at the short/long
/// thresholds, schedule a cooldown. Between thresholds the cooldown is the
/// one set at the last threshold crossing.
async fn breaker_record_failure(engine: &SyncEngine, account_id: &str) {
    let now = unix_now(&engine.pool).await;
    let mut bs = engine.breakers.lock().await;
    let state = bs.entry(account_id.to_string()).or_default();
    state.failures = state.failures.saturating_add(1);
    let cd = if state.failures >= BREAKER_THRESHOLD_LONG {
        BREAKER_COOLDOWN_LONG_SECS
    } else if state.failures >= BREAKER_THRESHOLD_SHORT {
        BREAKER_COOLDOWN_SHORT_SECS
    } else {
        0 // below threshold — no cooldown yet, just accumulate
    };
    if cd > 0 {
        state.cooldown_until = now + cd;
    }
}

/// Record a successful round: reset the counter to zero. A single success
/// after 4 failures clears the slate.
async fn breaker_record_success(engine: &SyncEngine, account_id: &str) {
    let mut bs = engine.breakers.lock().await;
    bs.remove(account_id);
}

async fn unix_now(pool: &SqlitePool) -> i64 {
    let (now,): (i64,) = sqlx::query_as("SELECT unixepoch()")
        .fetch_one(pool).await.unwrap_or((0,));
    now
}
```

Wire into `run_sync_round_with_source` — after the rate-limit check (Task 2) and before the `"syncing"` emit, add the breaker check; on the `list_folders` Err path, call `breaker_record_failure`; on success, call `breaker_record_success`:

```rust
    // ---- Phase 3f: circuit-breaker cooldown short-circuit ----
    // Distinct from rate-limit: this counts OUR consecutive failures, not a
    // server-told-us-to-stop signal. Cooldown-bypass emits `error` (not
    // `rate_limited`) and does NOT bump the counter again.
    if let Some(cooldown_until) = breaker_cooldown(engine, account_id).await {
        engine.sink.emit_status(StatusEvent {
            account_id: account_id.into(),
            state: "error".into(),
            detail: Some(cooldown_until),
        });
        return Ok(());
    }

    // (existing `syncing` emit stays here)

    let folders = match src.list_folders().await {
        Ok(f) => f,
        Err(e) => {
            log::warn!("[sync] {account_id} list_folders failed: {e}");
            breaker_record_failure(engine, account_id).await;
            engine.sink.emit_status(StatusEvent {
                account_id: account_id.into(),
                state: "error".into(),
                detail: None,
            });
            return Err(e.to_string());
        }
    };

    // ... (existing per-folder loop unchanged) ...

    let _ = accounts::touch_last_sync(&engine.pool, account_id).await;
    breaker_record_success(engine, account_id).await;   // NEW
    engine.sink.emit_status(StatusEvent {
        account_id: account_id.into(),
        state: "idle".into(),
        detail: None,
    });
    // ...
```

- [ ] **Step 4: Run — expect PASS.**

Run: `cargo test --lib sync_engine::engine`
Expected: both breaker tests pass; existing tests (which don't trigger repeated failures) unaffected.

- [ ] **Step 5: Commit** — `feat(sync): per-account circuit breaker with escalating cooldown`.

---

## Task 4: `db_get_rate_limit_info` Tauri command + frontend event verification

**Files:** `src/db/commands.rs`, `src/lib.rs`

**Interfaces:**
- Produces: `db_get_rate_limit_info(pool, account_id) -> Result<Option<i64>, String>` Tauri command (returns the live `retry_after` epoch or `None`). Registered in `generate_handler!`. The Phase 3g status bar will poll/subscribe this for the "Rate limited — retrying at X" text; here we only expose it + verify the `sync:status` event arrives in the frontend.

- [ ] **Step 1: Write failing test.** This is a Tauri command wrapper over an already-tested `rate_limit::get_rate_limit`, so the test is a thin "command delegates correctly" check. Add to `src/db/commands.rs` `#[cfg(test)]` (if absent, add a small `mod tests` that calls the command's underlying function — Tauri `State` is awkward in unit tests, so the convention here is to test the underlying `db::rate_limit::get_rate_limit` directly, which Task 1 already covers; this task's test is the **frontend event verification** below).

  Backend unit test (optional, cheap): assert the command exists and compiles by invoking the function with a constructed `State`. If `State<'_, SqlitePool>` is hard to construct in a `#[tokio::test]`, skip the unit test for the command itself — the function is a one-line delegation and the underlying logic is fully covered in Task 1. **Note the deviation in the commit message if you skip.**

- [ ] **Step 2: Implement.** In `src/db/commands.rs`:

```rust
// ---- rate-limit (Phase 3f) ----

/// Returns the account's current rate-limit window (`Some(retry_after)` epoch
/// seconds) if a live row exists, else `None`. The Phase 3g status bar polls
/// this to render "Rate limited — retrying at X". Lazy-deletes an expired row
/// on read (see `db::rate_limit::get_rate_limit`).
#[tauri::command]
pub async fn db_get_rate_limit_info(
    pool: State<'_, SqlitePool>,
    account_id: String,
) -> Result<Option<i64>, String> {
    crate::db::rate_limit::get_rate_limit(&pool, &account_id).await
}
```

In `src/lib.rs`, add `db::commands::db_get_rate_limit_info,` to the `generate_handler!` list (alphabetical slot, right after the other `db_*` entries — e.g. after `db_mark_op_failed,` or wherever the db::commands block ends; `cargo build` will not error on ordering, only on missing registration).

- [ ] **Step 3: Frontend verification (no source change expected).** Confirm the frontend's existing `sync:status` listener can receive the new state + field. The TS listener is in `kylins.client.frontend/src/services/mail/syncEngineListener.ts` (or wherever the existing `sync:status` handler lives — `grep -r "sync:status"`). The handler's `StatusEvent` TS type may need `detail?: number` added; if so, that is a one-line type widening, not a behavioral change. **Do NOT implement the status-bar UI** — that is Phase 3g. Verify only that the type compiles and the listener does not drop the event.

Run: `cd ../kylins.client.frontend && npx tsc --noEmit`
Expected: 0 errors (possibly after adding `detail?: number` to the TS `StatusEvent` type).

- [ ] **Step 4: Run — backend regression.**

Run: `cargo test --lib`
Expected: all green (Task 1–3 tests still pass; the new command adds no failing test if delegation-only).

- [ ] **Step 5: Commit** — `feat(sync): db_get_rate_limit_info command + frontend StatusEvent.detail type`.

---

## Task 5: EAS HTTP 429 → `SourceError::RateLimited` (Retry-After parsing)

**Files:** `src/eas/client.rs`, `src/sync_engine/eas_source.rs`

**Interfaces:**
- Produces:
  - `EasError::HttpStatus { status: u16, body: String, retry_after: Option<i64> }` — widened variant. The `retry_after` is parsed from the `Retry-After` response header (delta-seconds form only; HTTP-date falls back to `None`).
  - `EasClient` parses `Retry-After` from `response.headers()` before `response.text()` consumes the body (headers are accessible on `response` directly and remain accessible after `.text()` — but capturing up front is clearer).
  - `EasSource::list_folders` / `sync_folder` map `EasError::HttpStatus { status: 429 | 503, retry_after, .. }` to `SourceError::RateLimited { retry_after }` (with a sane default window when `retry_after` is `None`).
  - The engine's `run_sync_round_with_source` `list_folders` Err path detects `SourceError::RateLimited` and calls `rate_limit::set_rate_limit` before falling through to the breaker-failure path (so a 429 records the window AND does not bump the breaker — the server told us to wait, that is not a connection failure).

- **Decision — default window when `Retry-After` is absent:** 60 s. Matches the poll interval (one missed tick) and is conservative enough to shed load without wedging the account for minutes. The brief's inbox-zero reference uses an exponential default; we keep a flat 60 s because the breaker handles escalation for persistent failures.

- **Decision — where to call `set_rate_limit`:** in the engine, not the source. The source returns `SourceError::RateLimited { retry_after }`; the engine (which owns the `SqlitePool`) records it. This keeps `EasSource` free of DB access and makes the same recording path reusable for Gmail/Graph sources in Phase 3c/3d.

- [ ] **Step 1: Write failing tests.**

In `src/eas/client.rs` `#[cfg(test)]`, add a pure-parser test for `Retry-After` delta-seconds (the live HTTP path needs a mock server; the parser is the testable seam):

```rust
/// Parse a Retry-After header value into epoch seconds (now + delta). Pure.
/// Returns None for HTTP-date form or unparseable input (caller falls back
/// to the default window). Extracted from the response-handling path so it
/// is unit-testable without a live socket.
fn parse_retry_after_delta(header_value: &str, now_epoch: i64) -> Option<i64> {
    let delta: i64 = header_value.trim().parse().ok()?;
    Some(now_epoch + delta)
}

#[test]
fn parse_retry_after_delta_seconds() {
    assert_eq!(parse_retry_after_delta("30", 1000), Some(1030));
    assert_eq!(parse_retry_after_delta("  120  ", 0), Some(120));
    // HTTP-date form (RFC 7231 §7.1.3) — we do NOT parse it; caller falls
    // back to the default window. Honest limitation.
    assert_eq!(parse_retry_after_delta("Wed, 21 Oct 2026 07:28:00 GMT", 0), None);
    assert_eq!(parse_retry_after_delta("garbage", 0), None);
}
```

In `src/sync_engine/eas_source.rs` `#[cfg(test)]`, add a mapping test (the `EasError → SourceError` mapping is a pure function — factor it out of `sync_folder` so it is testable without a live `EasClient`):

```rust
/// Map an EasError to a SourceError, promoting a 429/503 HttpStatus to
/// RateLimited. Pure / no I/O — factored out of sync_folder for testability.
fn map_eas_error(err: crate::eas::client::EasError, default_window_secs: i64) -> SourceError {
    use crate::eas::client::EasError;
    match err {
        EasError::HttpStatus { status: 429 | 503, retry_after: Some(ra), .. } => {
            SourceError::RateLimited { retry_after: ra }
        }
        EasError::HttpStatus { status: 429 | 503, .. } => {
            SourceError::RateLimited { retry_after: default_window_secs }
        }
        other => SourceError::Other(other.to_string()),
    }
}

#[test]
fn map_eas_error_promotes_429_with_retry_after_to_rate_limited() {
    use crate::eas::client::EasError;
    let err = EasError::HttpStatus {
        status: 429, body: "Too Many Requests".into(), retry_after: Some(1234567890),
    };
    match map_eas_error(err, 60) {
        SourceError::RateLimited { retry_after } => assert_eq!(retry_after, 1234567890),
        other => panic!("expected RateLimited, got {other:?}"),
    }
}

#[test]
fn map_eas_error_promotes_503_without_retry_after_to_default_window() {
    use crate::eas::client::EasError;
    let err = EasError::HttpStatus { status: 503, body: "".into(), retry_after: None };
    match map_eas_error(err, 60) {
        SourceError::RateLimited { retry_after } => assert_eq!(retry_after, 60),
        other => panic!("expected RateLimited with default window, got {other:?}"),
    }
}

#[test]
fn map_eas_error_passes_other_http_status_through_as_other() {
    use crate::eas::client::EasError;
    let err = EasError::HttpStatus { status: 500, body: "boom".into(), retry_after: None };
    assert!(matches!(map_eas_error(err, 60), SourceError::Other(_)));
}
```

- [ ] **Step 2: Run — expect FAIL** (`EasError::HttpStatus` has no `retry_after` field; `parse_retry_after_delta` / `map_eas_error` undefined).

Run: `cargo test --lib eas::client sync_engine::eas_source`

- [ ] **Step 3: Implement.**

In `src/eas/client.rs`, widen the variant and parse the header. The variant change:

```rust
#[derive(Debug, thiserror::Error)]
pub enum EasError {
    // ... (other variants unchanged) ...

    #[error("HTTP {status}: {body}")]
    HttpStatus {
        status: u16,
        body: String,
        /// Parsed `Retry-After` delta-seconds, converted to epoch. Present
        /// only when the server sent a delta-seconds `Retry-After` header
        /// alongside a 429/503. None for HTTP-date form or absent header.
        retry_after: Option<i64>,
    },

    // ... (CommandStatus etc. unchanged) ...
}
```

(If `EasError` does not currently derive `thiserror::Error`, mirror the existing style — the only load-bearing part is the new field. Check the file's existing `#[derive(...)]` and `Display` impl; add `retry_after` to the literal construction sites. There is exactly one site: `client.rs:144-147`. `cargo build` will flag any others.)

At the HTTP-response site (`client.rs:130-147`), capture the header before consuming the body:

```rust
        let status = response.status().as_u16();

        // Phase 3f: capture Retry-After (delta-seconds) before we consume the
        // body. HTTP-date form falls back to None (caller uses default window).
        let retry_after = response
            .headers()
            .get("Retry-After")
            .and_then(|v| v.to_str().ok())
            .and_then(|s| {
                let now = chrono::Utc::now().timestamp();
                // Inline the pure parser tested above.
                s.trim().parse::<i64>().ok().map(|delta| now + delta)
            });

        let content_type = response
            .headers()
            .get("Content-Type")
            // ... (rest unchanged) ...

        if status != 200 {
            let body = response.text().await.unwrap_or_default();
            return Err(EasError::HttpStatus { status, body, retry_after });
        }
```

**`chrono` availability note:** `chrono` is currently a dev-dependency only (per the Phase 3a MVP-limitations note in `eas_source.rs`). For production code, prefer the same `SELECT unixepoch()` trick used in `engine.rs` (Task 3's `unix_now`) — but `eas/client.rs` does not hold a `SqlitePool`. Two clean options:
- **(A)** Use `std::time::SystemTime::now().duration_since(UNIX_EPOCH)` — no new dep. **Recommended.**
- **(B)** Pass `now_epoch: i64` into the EAS client from the caller (which has the pool). More plumbing.

Go with **(A)**: `SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs() as i64).unwrap_or(0)`. Note the choice in the commit message.

In `src/sync_engine/eas_source.rs`, add `map_eas_error` (above) and use it in `list_folders` and `sync_folder`:

```rust
    async fn list_folders(&self) -> Result<Vec<RemoteFolder>, SourceError> {
        let client = EasClient::new(self.eas_config());
        let result = client
            .folder_sync("0")
            .await
            .map_err(|e| map_eas_error(e, RATE_LIMIT_DEFAULT_WINDOW_SECS))?;
        // ...
    }

    async fn sync_folder(
        &self,
        folder: &RemoteFolder,
        since: Cursor,
    ) -> Result<FolderDelta, SourceError> {
        // ... (cursor resolution + SyncRequest build unchanged) ...
        let result: SyncResult = client
            .sync(&req)
            .await
            .map_err(|e| map_eas_error(e, RATE_LIMIT_DEFAULT_WINDOW_SECS))?;
        // ...
    }
```

Add the constant near the top of `eas_source.rs`:

```rust
/// Default rate-limit window (seconds) when the server returns 429/503
/// without a delta-seconds `Retry-After` header. Conservative: sheds one
/// poll tick (60s) without wedging the account for minutes.
const RATE_LIMIT_DEFAULT_WINDOW_SECS: i64 = 60;
```

Finally, wire the engine to RECORD the rate limit when `list_folders` returns `SourceError::RateLimited`. In `run_sync_round_with_source`, refine the `list_folders` Err arm:

```rust
        Err(e) => {
            log::warn!("[sync] {account_id} list_folders failed: {e}");
            // Phase 3f: if the source signalled a rate limit, persist the
            // window so the NEXT round short-circuits at the top via the
            // rate-limit check. This is NOT a breaker failure (server told
            // us to wait, not a dead socket), so do NOT bump the counter.
            match &e {
                crate::sync_engine::SourceError::RateLimited { retry_after } => {
                    if let Err(e2) = crate::db::rate_limit::set_rate_limit(
                        &engine.pool, account_id, *retry_after,
                    ).await {
                        log::warn!("[sync] {account_id} set_rate_limit failed: {e2}");
                    }
                }
                _ => breaker_record_failure(engine, account_id).await,
            }
            engine.sink.emit_status(StatusEvent {
                account_id: account_id.into(),
                state: "error".into(),
                detail: None,
            });
            return Err(e.to_string());
        }
```

(The same `RateLimited` detection should also cover `sync_folder`'s Err path — but per Global Constraints the per-folder path is best-effort and does NOT currently record anything. A `sync_folder` 429 is rare (the heavy command is `list_folders`/FolderSync); adding the recording there is a documented follow-up, not in this task's scope. Note it in the commit.)

- [ ] **Step 4: Run — expect PASS.**

Run: `cargo test --lib eas::client sync_engine::eas_source sync_engine::engine`
Expected: the parser test + the three mapping tests pass; the existing EAS + engine tests still green.

- [ ] **Step 5: Commit** — `feat(sync): EAS HTTP 429/503 Retry-After → SourceError::RateLimited + engine records it`.

---

## Task 6: Full regression + manual e2e notes

**Files:** no source; test runs + manual verification.

- [ ] **Step 1: Full backend regression.**

Run: `cargo test --lib`
Expected: all green. Baseline was ~236 tests at end of Phase 2; Phase 3a/3e added more. This plan adds ~10 new tests (5 in `db::rate_limit`, 2 in `engine` rate-limit, 2 in `engine` breaker, 1 in `eas::client`, 3 in `eas_source` mapping = 13). Update the count in the commit message.

- [ ] **Step 2: Frontend regression (frontend should be compile-clean only; the UI is Phase 3g).**

Run: `cd ../kylins.client.frontend && npx tsc --noEmit && npx vitest run`
Expected: tsc 0 errors (after adding `detail?: number` to the TS `StatusEvent` type in Task 4); vitest all green (no behavioral frontend change).

- [ ] **Step 3: Note manual e2e** (user runs `cargo tauri dev`):
  1. **Rate-limit path (synthetic):** from the dev console, `invoke('db_get_rate_limit_info', { accountId: 'X' })` returns `null`. Run `await db.execute('INSERT INTO provider_rate_limit ...')` (or a temporary scratch command) to plant a row 300 s in the future for the active account. Within one poll (≤60 s) the status bar shows the account as rate-limited (or, until Phase 3g lands, the dev-tools Tauri event log shows `sync:status { state: "rate_limited", detail: <epoch> }`) and the Inbox does NOT re-fetch. After the window passes, the next poll lazily deletes the row and sync resumes normally — verify `db_get_rate_limit_info` returns `null` again.
  2. **Breaker path (synthetic):** temporarily set the active account's `imap_host` to an unreachable address (e.g. `127.0.0.1:1`). Within 3 poll ticks (≤180 s) the account enters the 15 s cooldown; the dev-tools event log shows `sync:status { state: "error", detail: <epoch> }` with a single event per cooldown round (not the syncing+error pair of a normal failure round). Restore the host; the next successful round resets the breaker and sync resumes.
  3. **EAS 429 path (only if an EAS test server with a throttle is available):** drive the EAS client hard enough to trip a 429 (or mock it). Verify `provider_rate_limit` gains a row with `retry_after` set from `Retry-After`, and the next sync round short-circuits. If no throttling test server is available, the unit tests in Task 5 are the authoritative coverage; note "manual EAS 429 e2e skipped — no throttle test server" in the commit.

- [ ] **Step 4: Commit** any test-only fixes; update progress notes with the Phase 3f entry.

---

## Deferred Follow-Ups (documented, NOT in this plan's scope)

- **Per-folder `sync_folder` rate-limit recording.** Task 5 records the rate-limit window only on the `list_folders` Err path. A `sync_folder` that 429s mid-round is logged + `continue`d (best-effort) and does NOT persist a rate-limit row. Wiring it is symmetric (detect `SourceError::RateLimited` in the per-folder Err arm, call `set_rate_limit`, `break` out of the loop). Deferred because per-folder 429s are rare relative to FolderSync 429s and the breaker covers the storm case.
- **`Retry-After` HTTP-date form.** Task 5 parses delta-seconds only. Adding `httpdate`/`chrono`-based HTTP-date parsing is a one-function follow-up; deferred to avoid a new runtime dep for a marginal case (Gmail/Graph/EAS overwhelmingly send delta-seconds).
- **Persisted breaker state across restarts.** The breaker is in-memory by design (fresh-start semantics). If crash-loops become a real problem, a `breaker_state` SQLite table with the same shape is a small follow-up — but the rate-limit table already covers the "server told us to stop" persistent case, which is the dominant one.
- **Status-bar UI for `rate_limited` + `error` detail.** Phase 3g renders the "Rate limited — retrying at X" / "Connection error — retrying at X" text from the `sync:status` event + the `db_get_rate_limit_info` command exposed in Task 4. Not in this plan.
- **Graph/Gmail provider 429 mapping.** Once Phase 3c (Graph) and Phase 3d (Gmail) land, their `GraphError::is_rate_limit()` / `GmailError` 429 paths should map to `SourceError::RateLimited` the same way Task 5 does for EAS. The engine recording path (Task 5's `list_folders` Err arm) is provider-agnostic, so the only per-provider work is the error-mapping function.
- **`Retry-After` on `503 Service Unavailable`.** Task 5 maps both 429 and 503 to `RateLimited`. Strictly, 503 may indicate maintenance rather than throttling; the conservative choice (treat as rate-limit if `Retry-After` present) sheds load correctly during both. Revisit if a server uses 503 for non-throttle maintenance and the UI mislabels it.

## Self-review notes

- **Spec coverage (Phase 3 decomposition workstream 3d — rate-limit + circuit breaker):**
  - "Per-account rate-limit mode" → Tasks 1 (table + TTL helpers) + 2 (engine short-circuit + `rate_limited` state) + 4 (Tauri command for the UI) + 5 (429 detection in the source). ✅
  - "Circuit breaker (consecutive-failure cooldown)" → Task 3 (in-memory counter + escalating cooldown + reset-on-success). ✅
  - "Surfacing" → `sync:status { state: "rate_limited" | "error", detail }` + `db_get_rate_limit_info`. The status-bar DISPLAY is Phase 3g. ✅
- **inbox-zero pattern fidelity:** `set_rate_limit` = `setRateLimit` (Redis `HMSET` + `EXPIRE`); `is_rate_limited` = `assertProviderNotRateLimited` (returns/throws when `retryAt > now`); lazy-delete = Redis TTL. The semantics match; only the substrate differs (SQLite vs Redis), as the brief specifies. ✅
- **Type consistency across tasks:** `StatusEvent.detail` added in Task 2, consumed by every existing `StatusEvent { ... }` literal (mechanical `detail: None`/`Some(..)` updates). `SourceError::RateLimited` added in Task 2, produced in Task 5 (`map_eas_error`), consumed in Task 5 (engine `list_folders` Err arm). `BreakerState` + helpers added in Task 3, consumed in Task 3 (no cross-task dependency). `provider_rate_limit` schema (Task 1) is the single source of truth read by Task 2's short-circuit and Task 4's command. ✅
- **Global constraints honored:** SQLite only (no Redis, no new runtime dep — `SystemTime` for epoch in the EAS client, no `chrono`/`httpdate`); reuse `EventSink`/`sync:status` (no new event channel); rate-limit check inside `run_sync_round_with_source` (both tick + SyncNow paths); breaker in-memory (fresh-start); breaker never overrides rate-limit (rate-limit check runs first). ✅
- **Honest MVP limitations:** HTTP-date `Retry-After` unsupported (delta-seconds only); per-folder `sync_folder` 429 not recorded (only `list_folders`); breaker not persisted across restarts; status-bar UI is Phase 3g; Graph/Gmail 429 mapping deferred to Phase 3c/3d.

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-06-30-sync-engine-phase3-rate-limit.md`. Two execution options:

1. **Subagent-Driven (recommended)** — fresh subagent per task, review between tasks. Tasks 1–5 are sequentially dependent (Task 2 needs Task 1's table + helpers; Task 3 needs Task 2's `StatusEvent.detail`; Task 5 needs Task 2's `SourceError::RateLimited`); do NOT parallelize.
2. **Inline Execution** — this session via executing-plans, batched with checkpoints after Task 1, Task 3, and Task 5.

Which approach?
