---
name: bugfix-unit-test
description: Ensures every bug fix is accompanied by a unit test that reproduces the root cause. Trigger proactively after fixing a bug — when the user says "fixed", "done", or after you apply a fix. Do not wait to be asked.
---

# Bugfix Unit Test (Kylins Mail)

Every bug fix MUST include a unit test that reproduces the original bug. The test should fail before the fix and pass after — serving as a regression guard.

## When to trigger

- After applying any bug fix
- When the user says "fixed", "done", "works now"
- After a root-cause analysis that resulted in a code change

## How to write the test

### 1. Identify the layer and location

Look at what the fix changed and find the nearest `#[cfg(test)] mod tests` block:

- **Rust backend** — tests live inside the same file (`src/<crate>/<module>.rs`) under `#[cfg(test)] mod tests { ... }`, or in `tests/<name>.rs` for integration tests.
- **TypeScript frontend** — tests live under `tests/` mirroring `src/` (e.g. `src/services/db/messages.ts` → `tests/services/db/messages.test.ts`).

### 2. Name the test descriptively

Rust: `snake_case` — describe what the bug WAS and what the test proves.

```
parent_id_uses_label_id_format_matching_parent_label
subfolder_parent_id_matches_inbox_label_id_not_raw_path
```

TypeScript: `camelCase` or `describe`/`it` blocks.

### 3. Reproduce the root cause

The test must exercise the EXACT scenario that was broken:

- What input triggered the bug?
- What was the incorrect behavior?
- What assertion proves the fix works?

For the `parent_id` bug:
- **Root cause**: `parent_id` stored raw IMAP path `"INBOX"` but label `id` was `"{account_id}:INBOX"`
- **Test**: create a parent + child folder pair, verify child's `parent_id` equals parent's `id`

### 4. Follow existing patterns

Match the surrounding test style:

- **Rust**: `tempfile::tempdir()` + `init_db(tmp.path())` + seed data + `sqlx::query_as` for assertions. Use `#[tokio::test]` for async tests. Use `use super::*;` to access private functions.
- **TypeScript**: `vi.mock('@/services/db/connection')` + in-memory test fixtures + `@testing-library` for UI tests.

### 5. Assert the fix

Each assertion should directly verify the bug cannot recur:

```rust
// Assert child's parent_id equals parent's database id (not raw path)
let (parent_id,): (Option<String>,) = sqlx::query_as(
    "SELECT parent_id FROM labels WHERE account_id = ? AND name = ?"
)
.bind(account_id).bind("KylinsTest")
.fetch_one(&pool).await.unwrap();

assert_eq!(parent_id, Some(format!("{account_id}:INBOX")));
```

### 6. Run tests

```bash
# Backend
cd kylins.client.backend && cargo test -- <test_name>

# Frontend
cd kylins.client.frontend && npx vitest run tests/<path>
```

All existing tests must still pass.

## Test template (Rust backend)

```rust
#[tokio::test]
async fn <descriptive_name_describing_the_bug>() {
    let tmp = tempfile::tempdir().unwrap();
    let pool = init_db(tmp.path()).await.unwrap();
    // seed account
    sqlx::query("INSERT INTO accounts (id, email, provider) VALUES (?, ?, 'imap')")
        .bind("acc").bind("acc@x.com").execute(&pool).await.unwrap();

    // <reproduce the bug scenario>
    // ...

    // <assert the fix>
    // ...
}
```

## Test template (TypeScript frontend)

```typescript
import { describe, it, expect, vi } from 'vitest';

describe('<feature-with-bug>', () => {
  it('<descriptive name describing the bug>', async () => {
    // <reproduce the bug scenario>
    // ...
    // <assert the fix>
  });
});
```

## Checklist

- [ ] Test name describes the bug, not just the function tested
- [ ] Test reproduces the root-cause scenario (input, broken output)
- [ ] Test assertions directly verify the fix
- [ ] Matches surrounding test patterns (imports, helpers, style)
- [ ] `cargo test` / `vitest run` passes with the fix
- [ ] No existing tests broken
