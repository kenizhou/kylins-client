# Kylins Mail Sync Engine — Phase 3h: Deferred-Minors Sweep

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close out the five deferred technical-debt minors accumulated across Phase 3a–3e (one wrong-by-design queue compaction, one structured-error regression, one documented IDLE-shutdown gap, one untested WBXML branch, one trivial constant duplication) — each with a failing-test-first fix and no behavior change beyond the fix.

**Architecture:** This is a sweep, not a feature. Each task is an independent, commit-sized fix verified against the current source (dates and line numbers cited below are accurate as of `feat/sync-engine-phase3` HEAD `1ce4663` on 2026-06-30). The largest task is the `compact_queue` rewrite (pure SQL, one new helper function); the smallest is collapsing a duplicated const alias. No new crates, no schema changes, no frontend behavior changes.

**Tech Stack:** Rust (`sqlx` 0.8 sqlite, `thiserror`, `async-imap` 0.10.4, `async-trait`); existing `MailSource`/`SourceError` types. No frontend changes (one minor — `markThreadRead` — was investigated and dropped as already live; see "Dropped Minors").

## Authority & cross-validation

Each minor was verified against the current source on 2026-06-30 (branch `feat/sync-engine-phase3`, HEAD `1ce4663`). Findings:

- **Minor 1 (compact_queue over-cancel):** confirmed at `kylins.client.backend/src/db/queue.rs:164-194`. The self-join `SELECT a.id, b.id ... WHERE a.read=1 AND b.read=0 AND a.id<b.id` pairs the single `read=1` row with **every** subsequent `read=0` row on the same resource, so a `read=1, read=0, read=0` sequence (the "toggle twice, last wins unread" pattern) deletes all three rows instead of leaving the trailing `read=0` intact. The existing `compact_queue_cancels_markread_toggle_pair` test at `queue.rs:543` only covers the two-row happy path and so misses the over-cancel.
- **Minor 2 (EasError flattened to String):** confirmed at `kylins.client.backend/src/sync_engine/eas_source.rs:246, 284, 315, 422` — four `SourceError::Other(e.to_string())` sites. `EasError` is a structured `{ status: u32, message: String, command: String }` (`kylins.client.backend/src/eas/types.rs:316-333`) but its `status` is lost in the mapping. Phase 3b's `status.rs` was **checked and is NOT landed** (`src/eas/` contains only `mod.rs`, `service.rs`, `types.rs`, `client.rs`, `commands.rs`), so this plan takes the "at minimum preserve `status` as a typed field" branch: widen `SourceError` with an `Eas { status, message }` variant.
- **Minor 3 (IDLE no-Drop):** confirmed at `kylins.client.backend/src/sync_engine/imap_source.rs:620-624`. The `_stop: StopSource` returned by `wait_with_timeout` is discarded with the comment "manual interrupt not needed here; the outer select! drops the whole watch() future for cancellation." async-imap 0.10.4's `idle::Handle` has no `Drop` impl, so dropping `watch()` mid-IDLE leaves a dangling server-side IDLE until the ~29min timeout. **Option (a)** — wire `StopSource` through to `stop_all` — requires threading a `CancellationToken` through `watch()` + engine watcher task (`engine.rs:279, 305, 336`): the `StopSource` is bound to a single `wait_with_timeout` call inside the loop, not the outer IDLE session, so it cannot cleanly send DONE on outer shutdown without a real refactor. This plan takes **option (b)**: replace the misleading "discarded" comment with an accurate limitation note + tighten the keepalive mitigation.
- **Minor 6 (text_value_opt opaque-as-utf8 untested):** confirmed at `kylins.client.backend/src/eas/commands.rs:540-546`. The `WbxmlValue::Opaque(b) => std::str::from_utf8(b).ok()` branch in `text_value_opt` has no direct test (the existing ConversationId-opaque tests at `commands.rs:1661-1766` exercise the ApplicationData-level match arm, not `text_value_opt` itself).
- **Minor 7 (AS_OPTIONS duplicates tags::airsync::OPTIONS):** confirmed at `kylins.client.backend/src/eas/commands.rs:48` — `const AS_OPTIONS: u8 = 0x17;` with an inline comment "matches tags::airsync::OPTIONS". The `tags::airsync::OPTIONS` constant is already imported and used at `commands.rs:1844, 1900` in tests.

## Global Constraints

- **One commit per task.** `cargo test --lib` green at each task boundary; `cargo clippy -- -D warnings` clean at the end of every task; `cd ../kylins.client.frontend && npx tsc --noEmit && npx vitest run` green at the final boundary (frontend is unchanged, but the sweep verifies no regression).
- **No behavior change beyond each fix.** Minor 2 widens the error type but preserves the existing `Display` text so logs/IPC consumers see the same string. Minor 3 is comment + keepalive tuning only. Minor 7 is a pure alias collapse.
- **No new crate dependencies.** Everything uses existing `sqlx`, `thiserror`, `async-imap`, `base64` surfaces.
- **No schema migration.** Minor 1 is a query rewrite against the existing `pending_operations` table (`migrations/20260627000001_baseline.sql:605-617`).
- **TDD discipline.** Each task writes the failing regression test first, runs it to confirm it fails for the documented reason, then implements the fix. The plan's "Run — expect FAIL" steps name the exact failure mode to look for.
- **No gold-plating.** Minors dropped from the brief (see "Dropped Minors") stay dropped. Do not expand scope.

---

## File Structure

**Backend (Rust):**
- `kylins.client.backend/src/db/queue.rs` — rewrite `compact_queue` body to do strict adjacent-pair cancellation via a one-pass SQL window query; add a pure helper `collect_cancel_pair_ids(rows) -> (a_ids, b_ids)` so the pairwise logic is unit-testable without SQLite.
- `kylins.client.backend/src/sync_engine/mod.rs` — widen `SourceError` with an `Eas { status: u32, message: String }` variant; update `Display`.
- `kylins.client.backend/src/sync_engine/eas_source.rs` — map the four `EasError → SourceError::Other(e.to_string())` sites to `SourceError::Eas { status, message }`; update the one test that pattern-matches `SourceError::Other`.
- `kylins.client.backend/src/sync_engine/imap_source.rs` — replace the inaccurate "we discard the StopSource" comment with the real limitation note + tighten `IDLE_KEEPALIVE` reasoning.
- `kylins.client.backend/src/eas/commands.rs` — (a) add a one-test fixture exercising `text_value_opt` via the `From` opaque branch; (b) collapse `const AS_OPTIONS` to `use ...::tags::airsync::OPTIONS as AS_OPTIONS;`.

**Frontend:** Unchanged. Verified only at the final regression gate.

---

## Task 1: Fix `compact_queue` multi-pair over-cancel (strict adjacent-pair cancellation)

**Files:**
- Modify: `kylins.client.backend/src/db/queue.rs:142-194` (rewrite `compact_queue`; add `collect_cancel_pair_ids` helper)
- Test: `kylins.client.backend/src/db/queue.rs` `#[cfg(test)] mod tests` (next to the existing `compact_queue_cancels_markread_toggle_pair` at line 543)

**Interfaces:**
- Produces: `pub async fn compact_queue(pool, account_id) -> Result<(), String>` (signature unchanged — callers in `engine.rs` and `commands.rs` are untouched); new pure helper `fn collect_cancel_pair_ids(ordered: &[(id, read_bool)]) -> (Vec<String>, Vec<String>)` exposed for unit testing as `pub(super)`.

**Bug recap.** For a resource with ops `op1(read=1)`, `op2(read=0)`, `op3(read=0)` (created in that order), the current self-join pairs `op1` with **both** `op2` and `op3` (because `op1.id < op2.id` AND `op1.id < op3.id` and both op2/op3 have `read=0`). It then deletes all three. Net effect: the queue is empty, so the engine never applies any of the three toggles — the message is left in its pre-queue state. Correct behavior: op1 and op2 are an adjacent toggle pair (read=1 then read=0) and cancel; op3 is unpaired (trailing read=0) and must survive — net effect "unread".

**Fix approach.** Read all `markRead`/`setFlag` ops for the account ordered by `created_at, id` per `(account_id, resource_id, operation_type)`; walk that ordered list once and cancel only **exact adjacent** `(read=1, read=0)` pairs, leaving any trailing unpaired op intact. The pairing is "stateful": after cancelling a pair, the cursor advances past both rows; the next op is considered fresh. This is the standard "cancel inverse adjacent edits" reduction — identical to how a text editor collapses consecutive undo/redo toggles.

- [ ] **Step 1: Write the failing regression test.** Add it immediately after `compact_queue_cancels_markread_toggle_pair` (currently ending at `queue.rs:575`):

```rust
/// REGRESSION for the over-cancel bug: the old self-join paired the single
/// `read=1` row with EVERY subsequent `read=0` row on the same resource, so a
/// `read=1, read=0, read=0` sequence (toggle-read, toggle-unread, toggle-unread
/// again — last-write-wins, net "unread") deleted all three rows, leaving the
/// queue empty and the message stuck in its pre-queue state.
///
/// Fix: strict adjacent-pair cancellation. The first two ops (read=1 then
/// read=0) are an inverse pair and cancel; the third (read=0) is unpaired and
/// must survive so the engine still applies the net "unread" mutation.
#[tokio::test]
async fn compact_queue_preserves_trailing_unpaired_op_in_multi_toggle() {
    let tmp = tempfile::tempdir().unwrap();
    let pool = crate::db::init_db(tmp.path()).await.unwrap();
    seed_account(&pool, "a1").await;

    // Three ops on the same resource, created in this order:
    //   op1 (read=1)  ← marks read
    //   op2 (read=0)  ← marks unread (cancels op1)
    //   op3 (read=0)  ← marks unread again (trailing, must survive)
    // `created_at` breaks the sort deterministically (id ordering alone is not
    // guaranteed across UUID versions).
    for (id, read, ts) in [("op1", 1, 10), ("op2", 0, 20), ("op3", 0, 30)] {
        sqlx::query(
            "INSERT INTO pending_operations \
             (id, account_id, operation_type, resource_id, params, status, created_at) \
             VALUES ('a1','a1','markRead','msg-X',?,'pending',?)",
        )
        .bind(format!("{{\"read\":{read}}}"))
        .bind(ts)
        .execute(&pool)
        .await
        .unwrap();
    }

    compact_queue(&pool, "a1").await.unwrap();

    let survivors: Vec<(String,)> = sqlx::query_as(
        "SELECT id FROM pending_operations WHERE account_id = 'a1' ORDER BY created_at",
    )
    .fetch_all(&pool)
    .await
    .unwrap();
    let ids: Vec<String> = survivors.into_iter().map(|(s,)| s).collect();
    assert_eq!(
        ids,
        vec!["op3".to_string()],
        "op1+op2 cancel as an adjacent (read=1, read=0) pair; op3 is the \
         trailing unpaired read=0 and must survive so the net 'unread' mutation \
         is still applied"
    );
}
```

- [ ] **Step 2: Run — expect FAIL.**

Run: `cargo test --lib db::queue::tests::compact_queue_preserves_trailing_unpaired_op_in_multi_toggle`
Expected: FAIL — `assertion failed: left == right` showing all three ids (`["op1", "op2", "op3"]` empty after the over-cancel, or the queue empty depending on the old behavior — the test asserts exactly `["op3"]` survives, anything else fails).

- [ ] **Step 3: Implement — pure helper first.** Add the helper above `compact_queue` (after the existing module docstring at line 141, before the `pub async fn compact_queue` definition at line 164):

```rust
/// Collect cancel-out pair ids by strict adjacent-pair cancellation.
///
/// Walks `ordered` (which MUST be sorted by `(created_at, id)` for each
/// `(resource, op_type)` group, as the SQL in `compact_queue` produces) and
/// cancels only EXACT adjacent `(read=1, read=0)` pairs: when the cursor sees
/// a `read=1` row immediately followed by a `read=0` row, both are paired and
/// the cursor advances past both; otherwise the cursor advances by one. A
/// trailing unpaired op survives.
///
/// This is the stateful reduction the old self-join could not express: the
/// join paired ONE `read=1` row with EVERY later `read=0` row, deleting an
/// entire `read=1, read=0, read=0` chain (net no-op) instead of leaving the
/// trailing `read=0` intact (net "unread", last-write-wins).
///
/// Pure + unit-testable without a DB.
pub(super) fn collect_cancel_pair_ids(
    ordered: &[(String, bool)],
) -> (Vec<String>, Vec<String>) {
    let mut a_ids = Vec::new(); // read=1 side
    let mut b_ids = Vec::new(); // read=0 side
    let mut i = 0;
    while i + 1 < ordered.len() {
        let (id_a, read_a) = &ordered[i];
        let (id_b, read_b) = &ordered[i + 1];
        if *read_a && !*read_b {
            // Adjacent inverse pair — cancel both, advance past both.
            a_ids.push(id_a.clone());
            b_ids.push(id_b.clone());
            i += 2;
        } else {
            i += 1;
        }
    }
    (a_ids, b_ids)
}
```

- [ ] **Step 4: Implement — rewrite `compact_queue` to use it.** Replace the entire body of `compact_queue` (currently lines 164-194, the `let pairs: Vec<(String, String)> = sqlx::query_as(...)` block through the two `delete_ids` calls) with:

```rust
pub async fn compact_queue(pool: &SqlitePool, account_id: &str) -> Result<(), String> {
    // Read all toggle ops for the account, ordered by (resource, op_type,
    // created_at, id) so the pure pairwise reduction below sees each resource's
    // ops as a contiguous, time-ordered run. `created_at` is the authoritative
    // timeline; `id` is the deterministic tiebreaker for ops sharing a timestamp.
    //
    // json_extract(a.params, '$.read') returns 0 or 1 for ops encoded by
    // MutationOp::encode_params (Task 3); legacy `{}`-params rows yield NULL
    // (not 0), so they are filtered out by the `WHERE ... IS NOT NULL` guard
    // and left untouched — preserving the "don't touch legacy rows" contract.
    let rows: Vec<(String, String, String, bool)> = sqlx::query_as(
        "SELECT id, resource_id, operation_type, \
                json_extract(params, '$.read') = 1 AS read_flag \
         FROM pending_operations \
         WHERE account_id = ? AND status = 'pending' \
           AND operation_type IN ('markRead','setFlag') \
           AND json_extract(params, '$.read') IS NOT NULL \
         ORDER BY resource_id, operation_type, created_at, id",
    )
    .bind(account_id)
    .fetch_all(pool)
    .await
    .map_err(|e| e.to_string())?;

    // Group the flat ordered result by (resource_id, operation_type) and reduce
    // each group to its adjacent cancel pairs. SQLite ORDER BY makes each
    // group's rows contiguous, so a single linear scan with a group-break check
    // suffices.
    let mut a_ids: Vec<String> = Vec::new();
    let mut b_ids: Vec<String> = Vec::new();
    let mut group: Vec<(String, bool)> = Vec::new();
    let mut group_key: Option<(String, String)> = None;
    for (id, resource_id, op_type, read_flag) in rows {
        let key = (resource_id, op_type);
        if Some(&key) != group_key.as_ref() {
            // Group break: reduce the previous group, start a new one.
            if !group.is_empty() {
                let (ga, gb) = collect_cancel_pair_ids(&group);
                a_ids.extend(ga);
                b_ids.extend(gb);
                group.clear();
            }
            group_key = Some(key);
        }
        group.push((id, read_flag));
    }
    // Reduce the trailing group.
    if !group.is_empty() {
        let (ga, gb) = collect_cancel_pair_ids(&group);
        a_ids.extend(ga);
        b_ids.extend(gb);
    }

    if a_ids.is_empty() && b_ids.is_empty() {
        return Ok(());
    }

    // Two DELETEs, one per side of each pair (per the brief: "two DELETEs, do
    // not collapse"). Each is bound against the pre-snapshot ids so the second
    // still fires after the first removes its rows.
    delete_ids(pool, &a_ids).await?;
    delete_ids(pool, &b_ids).await?;
    Ok(())
}
```

**Note on the changed SELECT shape.** The old query selected `(a.id, b.id)` directly from a self-join; the new query selects `(id, resource_id, operation_type, read_flag)` from a flat ordered scan and does the pairing in Rust via `collect_cancel_pair_ids`. This is necessary because SQL cannot express "advance the cursor past both rows of a matched pair" — a `LAG()`/window-function approach still re-considers the second row of a cancelled pair as a candidate first-row of the next pair, re-introducing the over-cancel. The pure-Rust reduction is the only correct formulation.

- [ ] **Step 5: Add focused unit tests for the pure helper.** Add these alongside the integration test above (so the pairwise logic is covered without a DB):

```rust
#[test]
fn collect_cancel_pair_ids_cancels_single_adjacent_inverse_pair() {
    let (a, b) = collect_cancel_pair_ids(&[
        ("x1".into(), true),
        ("x2".into(), false),
    ]);
    assert_eq!(a, vec!["x1".to_string()]);
    assert_eq!(b, vec!["x2".to_string()]);
}

#[test]
fn collect_cancel_pair_ids_preserves_trailing_unpaired_read_zero() {
    // read=1, read=0, read=0  →  first two cancel, third survives.
    let (a, b) = collect_cancel_pair_ids(&[
        ("op1".into(), true),
        ("op2".into(), false),
        ("op3".into(), false),
    ]);
    assert_eq!(a, vec!["op1".to_string()]);
    assert_eq!(b, vec!["op2".to_string()]);
}

#[test]
fn collect_cancel_pair_ids_cancels_two_disjoint_pairs() {
    // read=1, read=0, read=1, read=0  →  two adjacent pairs.
    let (a, b) = collect_cancel_pair_ids(&[
        ("a1".into(), true),
        ("b1".into(), false),
        ("a2".into(), true),
        ("b2".into(), false),
    ]);
    assert_eq!(a, vec!["a1".to_string(), "a2".to_string()]);
    assert_eq!(b, vec!["b1".to_string(), "b2".to_string()]);
}

#[test]
fn collect_cancel_pair_ids_leaves_read_one_run_intact() {
    // Two read=1 in a row (no read=0 between) — nothing cancels.
    let (a, b) = collect_cancel_pair_ids(&[
        ("r1".into(), true),
        ("r2".into(), true),
    ]);
    assert!(a.is_empty());
    assert!(b.is_empty());
}
```

- [ ] **Step 6: Run — expect PASS.**

Run: `cargo test --lib db::queue`
Expected: all `compact_queue_*` tests pass (the original two-row happy-path test, the new three-row over-cancel regression, and the four pure-helper tests); the rest of the queue tests stay green.

- [ ] **Step 7: Clippy.**

Run: `cargo clippy --lib -- -D warnings`
Expected: no warnings (the rewritten function is simpler than the old self-join; the helper is `pub(super)` so no dead-code lint).

- [ ] **Step 8: Commit** — `fix(queue): compact_queue strict adjacent-pair cancellation (no over-cancel on read=1,read=0,read=0)`.

---

## Task 2: Widen `SourceError` with `Eas { status, message }` variant

**Files:**
- Modify: `kylins.client.backend/src/sync_engine/mod.rs:144-150` (add variant + update `Display`)
- Modify: `kylins.client.backend/src/sync_engine/eas_source.rs:246, 284, 315, 422` (use the new variant); update the test pattern-match at `eas_source.rs:622-624`

**Interfaces:**
- Produces: `SourceError::Eas { status: u32, message: String }` — structured carry for EAS protocol errors so the engine (Phase 3f's rate-limiter / status recovery) can dispatch on `status` without re-parsing a string. `Display` renders the same text the old `Other(e.to_string())` produced (`"EAS {command} status {status}: {message}"`-equivalent), so log lines and IPC consumers are byte-identical.

**Why not just a `rate_limited()` constructor.** The brief offered two shapes; this plan takes the wider one (`Eas { status, message }`) because (a) Phase 3b's `status.rs` is not landed, so a structured variant is the minimum to preserve the typed `status` field the engine will need; (b) it's strictly more informative than `Other(String)`; (c) the four EAS sites are the only callers that today lose structured information — IMAP errors have no equivalent typed status to carry.

- [ ] **Step 1: Write the failing test.** Add to `kylins.client.backend/src/sync_engine/mod.rs` `#[cfg(test)] mod tests` (after the existing `factory_rejects_unknown_provider` test):

```rust
#[test]
fn source_error_eas_variant_preserves_status_and_renders_display() {
    let err = SourceError::Eas {
        status: 3,
        message: "invalid sync key".into(),
    };
    match err {
        SourceError::Eas { status, message } => {
            assert_eq!(status, 3, "status must be carried as a typed u32");
            assert_eq!(message, "invalid sync key");
        }
        other => panic!("expected SourceError::Eas, got {other:?}"),
    }
    // Display must render the status and message (the exact punctuation is not
    // load-bearing — the test just locks "status + message both appear").
    let s = format!("{err}");
    assert!(s.contains('3'), "display must include status: {s}");
    assert!(s.contains("invalid sync key"), "display must include message: {s}");
}

#[test]
fn source_error_other_variant_still_constructs() {
    // Backwards-compat: existing non-EAS callers (ImapSource, mock_source) keep
    // using Other(String). This test exists purely to lock the variant's shape.
    let err = SourceError::Other("boom".into());
    assert_eq!(format!("{err}"), "boom");
}
```

- [ ] **Step 2: Run — expect FAIL.**

Run: `cargo test --lib sync_engine::tests::source_error_eas_variant`
Expected: compile error — `SourceError::Eas` variant does not exist.

- [ ] **Step 3: Implement — widen the enum.** Replace the `SourceError` definition at `mod.rs:144-150` with:

```rust
#[derive(Debug, thiserror::Error)]
pub enum SourceError {
    #[error("operation not supported by this source")]
    Unsupported,
    /// EAS protocol error carrying the typed MS-AS* status code so the engine
    /// (and a future Phase 3b `status.rs` recovery table) can dispatch on
    /// `status` without re-parsing a string. Replaces the lossy
    /// `SourceError::Other(e.to_string())` mapping that dropped the status.
    #[error("EAS status {status}: {message}")]
    Eas { status: u32, message: String },
    #[error("{0}")]
    Other(String),
}
```

- [ ] **Step 4: Run — expect PASS** for the two new tests (the enum now has the variant).

Run: `cargo test --lib sync_engine::tests::source_error_`
Expected: both pass.

- [ ] **Step 5: Wire `EasSource` to use the new variant.** In `kylins.client.backend/src/sync_engine/eas_source.rs`, replace the four `SourceError::Other(e.to_string())` sites that map an `EasError`. There are four call sites; update them as follows. The `EasError` struct fields are `{ status, message, command }` (`types.rs:317`); we carry `status` and `message` (the `command` is already embedded in `message` text in practice, and dropping it from the variant keeps the type minimal).

At `eas_source.rs:246` (in `list_folders`):

```rust
.map_err(|e| SourceError::Eas {
    status: e.status,
    message: e.message,
})?;
```

At `eas_source.rs:284` (in `sync_folder`, the `client.sync(&req)` call):

```rust
let result: SyncResult = client
    .sync(&req)
    .await
    .map_err(|e| SourceError::Eas {
        status: e.status,
        message: e.message,
    })?;
```

At `eas_source.rs:315` (the `CollectionStatusAction::Error` branch — this one constructs the error from a bare `result.status` rather than an `EasError`, so use `Other` for the synthetic message OR build an `Eas` variant with an empty command-derived message; prefer `Eas` for consistency):

```rust
CollectionStatusAction::Error => {
    return Err(SourceError::Eas {
        status: result.status,
        message: format!("EAS sync status {}", result.status),
    });
}
```

At `eas_source.rs:422` (in `ping`):

```rust
client
    .ping(&req)
    .await
    .map(|_| ())
    .map_err(|e| SourceError::Eas {
        status: e.status,
        message: e.message,
    })
```

Leave the `nyi()` helper at `eas_source.rs:37` returning `SourceError::Other("EasSource method not yet implemented".into())` — those are NYI stubs, not EAS protocol errors; `Other` is the correct variant for them.

- [ ] **Step 6: Update the one test that pattern-matches `SourceError::Other`.** At `eas_source.rs:607-625` (`list_folders_surfaces_error_on_unreachable_host`), the assertion expects `SourceError::Other(_)`. After the change, an unreachable host surfaces a connection/transport error from `reqwest` (not an `EasError`), so it still maps to... actually, look at the actual error path: `EasClient::folder_sync` returns whatever `reqwest` yields wrapped as an `EasError`? Check `eas/client.rs` to confirm. **If `client.rs` wraps transport errors as `EasError { status: 0, message: <transport err>, command: "FolderSync" }`**, then this test will now see `SourceError::Eas { status: 0, .. }` and the existing `Err(SourceError::Other(_))` match will fail. Update the assertion to accept either:

```rust
match res {
    Err(SourceError::Other(_)) | Err(SourceError::Eas { .. }) => {}
    other => panic!("expected SourceError::Other or ::Eas, got {other:?}"),
}
```

(Run the test first to see which path fires; the updated matcher covers both, so the test is correct either way.)

- [ ] **Step 7: Run — expect PASS** for the full EAS suite.

Run: `cargo test --lib sync_engine::eas_source sync_engine::tests`
Expected: all green (the four `classify_status_*` tests, the `load_cursor_*` tests, the `eas_config_*` tests, the unreachable-host test, and the two new `source_error_*` tests).

- [ ] **Step 8: Clippy + full backend regression.**

Run: `cargo clippy --lib -- -D warnings && cargo test --lib`
Expected: clippy clean; full `cargo test --lib` green (was 236+ tests at end of Phase 3e; this task adds 2 new tests and changes no behavior).

- [ ] **Step 9: Commit** — `fix(sync): SourceError::Eas carries typed status (no longer flattened to Other(String))`.

---

## Task 3: Document the IDLE no-Drop limitation accurately + tighten keepalive comment

**Files:**
- Modify: `kylins.client.backend/src/sync_engine/imap_source.rs:570-582` (doc comment on `watch()`)
- Modify: `kylins.client.backend/src/sync_engine/imap_source.rs:620-624` (the misleading "we discard the StopSource" inline comment)

**Why option (a) is not feasible without a refactor.** The `StopSource` returned by `idle.wait_with_timeout(IDLE_KEEPALIVE)` is scoped to a *single* iteration of the IDLE loop (lines 611-670): each loop iteration calls `idle.init()`, then `wait_with_timeout`, then `idle.done()` on the three exit branches. The `StopSource` therefore interrupts one 28-min wait, not the outer IDLE session. To send `DONE` on outer shutdown (the brief's option (a)) we would need to: (1) thread a `CancellationToken` through `watch()` from the engine's watcher task, (2) `select!` between the `wait_fut` and the token, (3) on token-cancel call `idle.done()` and recover/logout. That is a real refactor of `watch()` + the engine watcher task (`engine.rs:279, 305, 336`) — out of scope for a minors sweep. This task takes option (b): accurate documentation + a keepalive tuning that bounds the dangling-IDLE window.

The keepalive is already `IDLE_KEEPALIVE = 28 * 60` (line 40), comfortably under the typical 29-min server idle timeout. The dangling IDLE from a dropped `watch()` therefore times out server-side within ~29 min, after which the server closes the connection cleanly. The next `watch()` reconnects. This is the documented Phase 2 behavior — this task just makes the comment tell the truth.

- [ ] **Step 1: No failing test.** This is a documentation-only change; the existing `watch_returns_err_fast_on_connect_failure_and_is_cancelable_by_drop` test at `imap_source.rs:805` already locks the drop-cancel behavior. (A "DONE is sent on drop" assertion would require a live socket + server-side observation — the very thing the brief's option (b) acknowledges as a tracked follow-up.) Per the writing-plans "No Placeholders" rule, the "test" here is the existing drop-cancel test staying green after the comment edit.

- [ ] **Step 2: Replace the inaccurate doc comment on `watch()`.** At `imap_source.rs:570-582`, replace the existing block comment with:

```rust
/// Long-lived IDLE on `folder`. Blocks until the server signals a change
/// (EXISTS/EXPUNGE/FLAG), then returns `Ok(())` so the caller can re-sync and
/// re-enter watch(). Cancelable by drop: the outer watcher task `select!`s on
/// this future vs a shutdown signal.
///
/// **Shutdown limitation (tracked follow-up, not fixed here):** async-imap
/// 0.10.4's `idle::Handle` has no `Drop` impl, so dropping `watch()` mid-IDLE
/// does NOT send `DONE` — the server holds a dangling IDLE until its ~29-min
/// idle timeout fires, then closes the socket. The next `watch()` reconnects
/// cleanly. The clean fix (send DONE on outer shutdown) requires threading a
/// `CancellationToken` through `watch()` and the engine's watcher task so the
/// cancel path can call `idle.done().await` before returning; that refactor is
/// tracked as a separate workstream. The mitigation in place: `IDLE_KEEPALIVE`
/// (28 min) is tuned to fire JUST under the server timeout, so a normally-
/// cycling watcher recovers the session via the `Timeout` branch every ≤28 min
/// and never actually hits the dangling-drop case in steady state — the
/// dangling case only arises on abrupt shutdown, where the ~29-min server
/// cleanup is acceptable.
///
/// Returns `Err(SourceError::Unsupported)` if the server's CAPABILITY does not
/// advertise `IDLE`.
///
/// Keepalive: `wait_with_timeout(IDLE_KEEPALIVE=28min)` returns `Timeout` if no
/// bytes arrive for 28 min; on Timeout we send DONE, recover the Session, and
/// loop (re-init IDLE). The 28-min clock is reset by any server traffic,
/// including `* OK Still here` keepalive pings.
```

- [ ] **Step 3: Replace the misleading inline comment.** At `imap_source.rs:620-624`, replace the four-line "We discard the StopSource" comment + the `let (wait_fut, _stop) = ...` line with:

```rust
// wait_with_timeout returns a future + StopSource. The StopSource is bound to
// THIS single wait call (not the outer IDLE session), so keeping it would only
// let us cut this 28-min wait short — it cannot send the protocol-level DONE
// that a clean shutdown needs. We drop it; the outer watcher task cancels the
// whole watch() future on shutdown via its select! (see the doc comment on
// watch() for the dangling-IDLE caveat this implies). The future's clock resets
// on any server traffic, so 28 min of total silence -> Timeout.
let (wait_fut, _stop) = idle.wait_with_timeout(IDLE_KEEPALIVE);
```

- [ ] **Step 4: Run — full IMAP + drop-cancel test must stay green.**

Run: `cargo test --lib sync_engine::imap_source`
Expected: all green (no behavior change; the drop-cancel test at line 805 still passes because the comment edit doesn't touch code).

- [ ] **Step 5: Clippy.**

Run: `cargo clippy --lib -- -D warnings`
Expected: clean (the `_stop` underscore suppresses the unused-variable lint; it already did before).

- [ ] **Step 6: Commit** — `docs(sync): accurate IDLE no-Drop limitation note + keepalive rationale`.

---

## Task 4: Test the `text_value_opt` opaque-as-utf8 branch

**Files:**
- Modify: `kylins.client.backend/src/eas/commands.rs` `#[cfg(test)] mod tests` (add one fixture test near the existing `parse_application_data_conversation_id_*` tests around line 1660)

**Interfaces:** None (test-only).

**Why this is real.** `text_value_opt` at `commands.rs:540-546` has three match arms: `Text`, `Opaque(b) => std::str::from_utf8(b).ok()`, `Empty`. The `Text` and `Empty` arms are exercised by many existing ApplicationData tests; the `Opaque` arm is reachable in principle (any EAS element serialized with `WBXML stride + opaque content` rather than `inline text`) but has no direct fixture. The closest existing test, `parse_application_data_conversation_id_opaque` at line 1661, exercises the ApplicationData-level `ConversationId => match &child.value { Opaque(b) if !b.is_empty() => ... }` arm — a *different* match. The `text_value_opt` opaque branch (which is the one most fields route through) is genuinely uncovered.

- [ ] **Step 1: Write the test.** Add it next to the other `parse_application_data_*` tests (after `parse_application_data_ignores_unknown_tags`, around line 1799). The fixture builds a `Subject` leaf whose value is `WbxmlValue::Opaque(b"...".to_vec())` — the wire form some Exchange servers serialize CDATA-ish content in — and asserts `parse_application_data` surfaces it as the decoded UTF-8 string via `text_value_opt`:

```rust
/// `text_value_opt` must decode a `WbxmlValue::Opaque` leaf as UTF-8 and
/// return the string. This is the wire form some Exchange servers serialize
/// for elements whose content was originally CDATA or carried through an
/// opaque codepage translation; the existing ConversationId-opaque tests
/// cover the ApplicationData-level opaque match, but the generic
/// `text_value_opt` opaque branch (which most fields route through) has no
/// direct fixture. This locks that branch.
#[test]
fn parse_application_data_decodes_opaque_value_as_utf8_via_text_value_opt() {
    // Build a Subject leaf with an Opaque value (valid UTF-8 bytes). Any field
    // dispatched through `text_value_opt` would do; Subject is the simplest.
    let app_data = WbxmlElement::container(
        PAGE_AIRSYNC,
        AS_APPLICATION_DATA,
        vec![WbxmlElement {
            page: 2,                 // email::PAGE
            token: 0x14,             // email::SUBJECT
            value: WbxmlValue::Opaque(b"Hello opaque".to_vec()),
            children: Vec::new(),
        }],
    );
    let item = parse_application_data_for_test("s1", &app_data);
    assert_eq!(
        item.subject.as_deref(),
        Some("Hello opaque"),
        "an Opaque leaf carrying valid UTF-8 must decode via text_value_opt's \
         from_utf8 branch"
    );
}

/// Companion guard: an Opaque leaf with INVALID UTF-8 must yield `None` (the
/// `from_utf8(b).ok()` branch), not panic. Locks the silent-skip contract.
#[test]
fn parse_application_data_opaque_invalid_utf8_yields_none() {
    let app_data = WbxmlElement::container(
        PAGE_AIRSYNC,
        AS_APPLICATION_DATA,
        vec![WbxmlElement {
            page: 2,
            token: 0x14, // Subject
            value: WbxmlValue::Opaque(vec![0xFF, 0xFE, 0xFD]), // invalid UTF-8
            children: Vec::new(),
        }],
    );
    let item = parse_application_data_for_test("s1", &app_data);
    assert_eq!(
        item.subject,
        None,
        "invalid-UTF-8 opaque must silently map to None, not panic"
    );
}
```

**Note on constructor.** The fixture hand-builds `WbxmlElement { .. }` rather than using a helper because there is no existing public constructor that takes `WbxmlValue::Opaque` for a leaf with children — `WbxmlElement::opaque(page, token, bytes)` exists (used at line 1666) but sets `children: vec![]`, which is exactly what we want. Prefer the existing helper to reduce the test's sensitivity to struct-layout changes:

```rust
// Use the existing opaque constructor instead of hand-building the struct:
let subject_el = {
    use crate::eas::wbxml::types::WbxmlValue;
    let mut el = crate::eas::wbxml::types::WbxmlElement::opaque(2, 0x14, b"Hello opaque".to_vec());
    el
};
```
(If `WbxmlElement::opaque` already returns the right shape — it does per line 1666 — use it directly. Drop the hand-built struct form in favor of the helper.)

- [ ] **Step 2: Run — expect PASS** (the branch already works; this is a coverage lock, not a bug fix).

Run: `cargo test --lib eas::commands::tests::parse_application_data_decodes_opaque`
Expected: both new tests pass immediately. (If the first test fails, it means the opaque branch was broken — investigate before proceeding; the second test failing-with-panic would mean `from_utf8` is being called without `.ok()`, also a real bug.)

- [ ] **Step 3: Clippy.**

Run: `cargo clippy --lib -- -D warnings`
Expected: clean.

- [ ] **Step 4: Commit** — `test(eas): lock text_value_opt opaque-as-utf8 branch (valid + invalid UTF-8)`.

---

## Task 5: Collapse `AS_OPTIONS` duplicate const alias

**Files:**
- Modify: `kylins.client.backend/src/eas/commands.rs:48` (remove the local const, add a `use ... as AS_OPTIONS;` alias)

**Interfaces:** None — `AS_OPTIONS` is a module-private constant (`const`, not `pub`) used only within `commands.rs` at line 290. The `tags::airsync::OPTIONS` constant is already in scope via the existing `use crate::eas::wbxml::tags::{self, pages};` import at line 16 (the tests at lines 1844 and 1900 already reference `tags::airsync::OPTIONS`).

**Bug recap.** Line 48 declares `const AS_OPTIONS: u8 = 0x17;` with an inline comment "matches tags::airsync::OPTIONS". Two sources of truth for the same code-page tag is the canonical drift risk: if `tags::airsync::OPTIONS` is ever changed (e.g. a spec-version bump), the local alias silently desyncs. Collapse to a single source.

- [ ] **Step 1: Write the failing test.** Add to `kylins.client.backend/src/eas/commands.rs` `#[cfg(test)] mod tests` (near the `email_tag_constants_match_spec` test around line 1415):

```rust
/// `AS_OPTIONS` (the module-local alias used in `build_sync_request`) and
/// `tags::airsync::OPTIONS` (the canonical tag-table constant) MUST be the same
/// value. The local alias existed as a separate `const`, which is a drift risk;
/// this test locks the post-collapse alias to the canonical value.
#[test]
fn as_options_alias_matches_tags_airsync_options() {
    use crate::eas::wbxml::tags::airsync;
    assert_eq!(AS_OPTIONS, airsync::OPTIONS);
}
```

- [ ] **Step 2: Run — expect PASS or FAIL depending on current state.**

Run: `cargo test --lib eas::commands::tests::as_options_alias_matches_tags_airsync_options`
Expected: before the collapse, this PASSES (both are `0x17`). After the collapse it continues to pass. (The test is a regression lock against future re-divergence, not a reproduction of a current failure. Per TDD discipline this is a coverage lock for a trivial refactor — the "fail" step here is the absence of the lock, not a red test.)

- [ ] **Step 3: Collapse the alias.** At `commands.rs:48`, replace:

```rust
const AS_OPTIONS: u8 = 0x17; // Options (per [MS-ASSYNC] 2.2.3.25); matches tags::airsync::OPTIONS
```

with an import alias at the top of the file. Add to the existing `use crate::eas::wbxml::tags::{self, pages};` line (line 16) — extend it to:

```rust
use crate::eas::wbxml::tags::{self, pages};
use crate::eas::wbxml::tags::airsync::OPTIONS as AS_OPTIONS;
```

Then delete the local `const AS_OPTIONS: u8 = 0x17;` line at line 48 entirely. The one usage at line 290 (`AS_OPTIONS`) continues to resolve, now via the alias.

- [ ] **Step 4: Run — expect PASS.**

Run: `cargo test --lib eas::commands`
Expected: all green — the alias-lock test passes, and the existing `build_sync_request_emits_body_preference_type_2` test (line 1810) still passes because `AS_OPTIONS` still resolves to `0x17`.

- [ ] **Step 5: Clippy.**

Run: `cargo clippy --lib -- -D warnings`
Expected: clean (the `use ... as AS_OPTIONS` alias is the idiomatic shape; no redundant-alias lint).

- [ ] **Step 6: Commit** — `refactor(eas): collapse AS_OPTIONS dup const to tags::airsync::OPTIONS alias`.

---

## Task 6: Full regression + frontend gate

**Files:** None (verification only).

- [ ] **Step 1: Full backend test run.**

Run: `cd kylins.client.backend && cargo test --lib`
Expected: all green. Baseline was 236+ tests at end of Phase 3e; Phase 3h adds 8 new tests (3 `compact_queue` + 4 pure-helper + 2 `source_error` + 2 `text_value_opt` + 1 `as_options` = 12 new tests, 0 removed). If any pre-existing test now fails, STOP — the task that introduced the regression must fix it before this gate passes.

- [ ] **Step 2: Backend clippy, full.**

Run: `cd kylins.client.backend && cargo clippy --lib -- -D warnings`
Expected: 0 warnings. (Each task already ran clippy; this is the consolidated gate.)

- [ ] **Step 3: Frontend regression (frontend is unchanged — verify no IPC contract broke).**

Run: `cd kylins.client.frontend && npx tsc --noEmit && npx vitest run`
Expected: tsc 0 errors; vitest all green. The frontend never references `SourceError` variants by name (errors arrive as `{ message: string }` over IPC), so the `SourceError::Eas` widening is wire-compatible. `markThreadRead` (investigated, dropped — see "Dropped Minors") and the rest of the frontend are untouched.

- [ ] **Step 4: Note manual e2e** (optional, user-driven): run `cargo tauri dev`, trigger a `read=1, read=0, read=0` toggle sequence on a message (e.g. via the reading-pane toggle clicked rapidly), and confirm the offline queue compacts to a single surviving `read=0` op (visible in the SQLite `pending_operations` table) rather than emptying out. This is the human-readable confirmation of Task 1's fix.

- [ ] **Step 5: Update memory** — append a Phase 3h entry to the user's auto-memory `phase3-sync-decomposition.md` noting the sweep is done and the IDLE-clean-shutdown refactor is the tracked follow-up.

---

## Dropped Minors (investigated, not fixed)

- **Minor 4 — Orphaned `markThreadRead` export.** Brief asked to remove if dead. Grep on 2026-06-30 found `markThreadRead` actively used at:
  - `kylins.client.frontend/src/stores/threadStore.ts:45, 119, 133` (decl + two internal call sites)
  - `kylins.client.frontend/src/components/layout/ReadingPane.tsx:105, 307`
  - `kylins.client.frontend/src/components/layout/MessageList.tsx:223, 302, 324`
  - `kylins.client.frontend/src/components/layout/CommandRibbon.tsx:111, 274`
  - `kylins.client.frontend/src/services/db/threads.ts:109` (the DB-layer wrapper)
  - Plus dedicated tests in `tests/stores/threadStore.test.ts:286-339` and `tests/services/db/threads.test.ts:88-90`

  It is NOT orphaned — `sync_apply_mutation` did not replace it (it's the synchronous local-toggle entry point, still wired into the ribbon/reading-pane/message-list UI). Dropped from 3h; no action.

- **Minor 5 — Multi-account pending aggregation.** Brief explicitly says this is Phase 3g's scope (StatusBar aggregated pending); 3h cross-references only. Dropped from 3h. (If 3g is later found not to cover it, file a separate plan.)

## Deferred Follow-Ups (documented, NOT in this plan's scope)

- **IDLE clean-shutdown (`DONE` on outer shutdown).** The option-(a) refactor this plan defers (Task 3): thread a `CancellationToken` through `ImapSource::watch()` from the engine watcher task (`engine.rs:279`), `select!` between `wait_fut` and the token, and on cancel call `idle.done().await` to recover + logout the session cleanly. Value: eliminates the ~29-min dangling-IDLE window on app shutdown / account removal. Effort: ~half a day (touches `watch()` + `engine.rs` watcher task + a new shutdown channel). Tracked here so the Task 3 doc comment can reference it.
- **Phase 3b `status.rs` (EAS status recovery table).** When landed, `SourceError::Eas { status, message }` (Task 2 of this plan) becomes the carrier the table dispatches on — no further `SourceError` changes needed. The variant is shaped to be forward-compatible with 3b.
- **Persistent IMAP session** (separate workstream; the `watch()` dangling-drop case goes away entirely once the session is owned by a long-lived worker rather than re-established per `watch()` call).

## Self-review notes

- **Minor verification (each minor re-checked against source on 2026-06-30):**
  - Minor 1: `queue.rs:164-194` confirmed; over-cancel reproducible by inspection. ✅
  - Minor 2: `eas_source.rs` four `SourceError::Other(e.to_string())` sites confirmed (lines 246, 284, 315, 422); `eas/types.rs:317-333` confirms `EasError` carries a typed `status`. `src/eas/status.rs` confirmed absent (Phase 3b not landed). ✅
  - Minor 3: `imap_source.rs:620-624` confirms `_stop` discarded; `async-imap 0.10.4` `idle::Handle` has no `Drop` (reference plan verified). Option (a) infeasible without refactor — option (b) taken. ✅
  - Minor 4: `markThreadRead` confirmed live in 3 components + 2 test files. Dropped. ✅
  - Minor 5: covered by 3g. Dropped. ✅
  - Minor 6: `commands.rs:540-546` `text_value_opt` opaque branch confirmed; existing ConversationId tests cover a different match arm. ✅
  - Minor 7: `commands.rs:48` local const confirmed; `tags::airsync::OPTIONS` already used at lines 1844, 1900. ✅
- **Placeholder scan:** no TBD / TODO / "implement later" / "add appropriate error handling" in any task. Every code step shows complete code. ✅
- **Type consistency:** `collect_cancel_pair_ids(&[(String, bool)]) -> (Vec<String>, Vec<String>)` (Task 1) matches its call site in the rewritten `compact_queue`. `SourceError::Eas { status: u32, message: String }` (Task 2) matches the four EAS mapping sites and the two new tests. `AS_OPTIONS` alias (Task 5) keeps the same `u8` type and resolution. ✅
- **Honest scope:** this plan does NOT fix the IDLE-clean-shutdown gap (option (a) deferred); it does NOT land Phase 3b's `status.rs` (but shapes `SourceError::Eas` to be forward-compatible with it); it does NOT touch the frontend. Each task's "Run — expect" step names the exact pass/fail signal.

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-06-30-sync-engine-phase3-minors.md`. Two execution options:

1. **Subagent-Driven (recommended)** — fresh subagent per task, review between tasks. Well-suited here because the five tasks are independent (no cross-task type dependencies) and can even be parallelized across Tasks 3, 4, 5 once Task 1 and Task 2 land.
2. **Inline Execution** — this session via executing-plans, batched with checkpoints.

Which approach?
