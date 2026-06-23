---
name: engineering-review
description: Enterprise engineering review for the Kylins Mail client. Use this whenever designing or implementing a new feature, module, service, or architecture change, AND whenever reviewing, checking, or refactoring code before a commit or PR. Adapts enterprise principles (scalability, reliability, security, maintainability, data integrity, UX & accessibility) to this local-first Tauri v2 desktop mail client. Trigger it proactively — do not wait to be asked — when the user mentions designing, architecting, building a feature, or reviewing/committing/PR-ing changes, even if they don't say "review" or "enterprise".
---

# Engineering Review (Kylins Mail)

This skill has two modes. Pick based on what the user is doing:

- **Mode A — Designing:** the user is about to build a new feature, component, service, or make an architecture decision. Run the design review *before* code is written and produce a short design note.
- **Mode B — Pre-commit:** the user is about to commit, push, or open a PR, or asks "is this ready / review my changes." Run the verification gates and the checklist.

Default to Mode B if changes already exist; Mode A if work hasn't started. When unsure, ask which mode — but don't stall: if there's a diff, review it.

## What good Kylins code looks like

Kylins is a **local-first desktop client** — Tauri v2 + WebView2, a Rust backend, a React 19 + TypeScript frontend, a local SQLite database, and IMAP/EAS/SMTP mail providers. There is no server fleet behind it, so "enterprise quality" here is not about scaling infrastructure. It is about: staying responsive with huge mailboxes, failing safely, keeping secrets and untrusted content isolated, and staying maintainable as features accumulate. Hold every change against these dimensions:

- **Performance & responsiveness.** Mailboxes can hold tens of thousands of messages — virtualize/window long lists (never render every row), paginate, lazy-load message bodies, and sync incrementally. Never do network or database work on the UI thread; it belongs in a Rust task invoked over IPC. Reuse what is already on disk — SQLite indexes, the `ai_cache` table, an in-memory LRU for hot data, and folder-status caching — and invalidate those caches deliberately rather than re-fetching.
- **Reliability.** When a provider, the network, or the database fails, keep showing cached data with a retry affordance — never a blank screen. Route retries through the SQLite-backed offline queue with exponential backoff. Wrap independent UI subtrees in React error boundaries so one pane's failure cannot take down the whole app. Prefer optimistic updates with a rollback path. Keep local storage crash-safe (SQLite WAL, idempotent migrations) so a kill or crash mid-sync does not corrupt data.
- **Security.** Secrets (tokens, passwords) live only in the OS keyring via the Rust `crypto` commands, stored as `nonce‖ciphertext` — never as plaintext in SQLite or JSON. Remote HTML renders in a sandboxed `<iframe>` (no `allow-same-origin`) and is sanitized with DOMPurify. All SQL is parameterized. IPC capabilities follow least privilege and are granted per method.
- **Maintainability & modularity.** Layered: Rust commands → `services/` → Zustand stores → UI. New capabilities live in `src/features/<feature>/` as self-contained modules. TypeScript is strict (`noUnusedLocals`, `noUncheckedIndexedAccess`) — no `any`. Tests mirror `src/` under `tests/`.
- **Data integrity.** Multi-statement writes go through `withTransaction()` (serialized). Migrations are versioned and **never edited after being applied** — add a new one instead. Foreign keys and constraints guard relations.
- **Auditability.** Sync state and an operation log for sent/moved/deleted mail record "who changed what when" for critical mutations.
- **UX.** Power users want efficiency: keyboard shortcuts, bulk selection, a command palette. Optimistic UI with clear loading/error states. No layout shift or re-render storms (see pitfall below).
- **Accessibility.** WCAG-minded: real ARIA roles on custom widgets (`role="separator"`, etc.), keyboard navigation, visible focus, managed color contrast.
- **Internationalization.** User-facing strings stay externalizable; format dates and times for the user's locale and timezone. Don't hardcode English when a string may surface in the UI.

## Mode A — Designing a feature

Before writing code, walk these dimensions and write a **design note** (see template). The point is to surface trade-offs early — enterprise bugs are expensive to fix after code is written.

Work through:

1. **Performance** — Will this scale to a large mailbox? Which data is lazy/paginated/virtualized? Does any network or DB work stay off the UI thread? What gets cached, and when is it invalidated?
2. **Reliability** — What happens when the network/provider/DB fails? Where is the retry/backoff? Which React subtree needs an error boundary? Is there an optimistic + rollback path?
3. **Security** — Any new secret? (→ keyring, never SQLite/JSON.) Any remote HTML? (→ sandbox + DOMPurify.) Any new IPC command? (→ validate inputs in Rust, add the capability.) Any new SQL? (→ parameterized.)
4. **Modularity** — Where does this live (`src/features/<feature>/`)? Which layer owns it? Does it cross the service/store/UI boundary cleanly? Does it touch the plugin contract?
5. **Data** — Schema change? (→ new versioned migration, never edit an applied one.) Multi-statement write? (→ `withTransaction`.) New constraints/FKs? Does it need an audit/operation-log entry?
6. **UX & A11y** — Keyboard path? ARIA roles/focus for new widgets? Loading/empty/error states? Will it cause layout shift or remounts under settings changes? Are strings i18n-ready?

### Design note template

```
# [Feature name]
## Goal
One sentence.
## Layer & location
Which layer(s), which files/modules. Why there.
## Data
Schema/migration if any; transactions; caching; invalidation.
## Failure modes
Per provider/network/DB failure → graceful behavior.
## Security
Secrets, HTML sandboxing, IPC validation, capabilities, SQL parameterization.
## Performance
Virtualization/lazy/async placement; what runs off the UI thread.
## UX / A11y / i18n
Keyboard, ARIA, states, i18n-readiness.
## Open questions
```

Keep it proportional to the change's size — a one-line fix needs a one-line note; a new subsystem needs the whole template.

## Mode B — Pre-commit review

Run the **verification gates** first (these are objective and machine-checkable). Only then do the **checklist**.

### Verification gates (run these)

Frontend, from `kylins.client.frontend/`:

```bash
npx tsc --noEmit        # type-check, strict mode — must be clean
npx eslint .            # lint (flat config) — must be clean
npx prettier --check .  # formatting check — must be clean
npx vitest run          # all tests, not watch mode
```

Backend, from `kylins.client.backend/`:

```bash
cargo fmt --check                             # formatting — must be clean
cargo clippy --all-targets -- -D warnings     # lint (if changes touch Rust)
cargo test
```

If a gate fails, stop and fix it before reviewing further. Don't claim "done" with a failing gate.

### Hygiene checks

- No debug leftovers: `console.log`, `alert(`, commented-out blocks, `TODO` without an owner/issue.
- No secrets in the diff: tokens, passwords, private keys, `.env` contents. (Search the diff for `password`, `token`, `secret`, `AKIA`, `-----BEGIN`.)
- No `any` added to TypeScript; no `@ts-ignore`/`@ts-expect-error` without a real reason.
- No plaintext secret written to SQLite/JSON — secrets flow through `services/crypto.ts` → Rust `encrypt_secret`.
- If a new IPC command or window method was added, the matching permission is in `kylins.client.backend/capabilities/default.json` (least privilege).
- If the schema changed, a **new** migration was added (not an existing one edited), and it's idempotent (`CREATE ... IF NOT EXISTS`, `INSERT OR IGNORE`, `ALTER ... ADD COLUMN` guarded where possible).
- New interactive UI has ARIA roles/labels and a keyboard path; new user-facing strings aren't hardwired English where i18n matters.
- React: no new state-update loops or unnecessary remounts (see pitfall). Selectors subscribe to slices, not whole stores, unless intended.

### Correctness spot-checks

- New async/IPC calls have error handling (try/catch or `.catch`) and a user-visible failure state.
- Multi-statement DB writes use `withTransaction()`.
- Branches/loops handle the empty/undefined case (`noUncheckedIndexedAccess` means `arr[i]` is `T | undefined`).
- Off-main-thread: no new synchronous network/DB work on the UI thread.

### After review

Report what passed and what you fixed, with the actual command output for any gate run. Don't summarize "looks good" without evidence.

## Project-specific pitfalls (learned the hard way)

- **Re-render storms / UI shake.** Zustand `useStore()` with no selector returns the whole state and re-renders on every change; subscribe to slices instead. "Persistent" hooks that re-run on every state change (e.g. re-hydrating from storage on each update) create visible jitter loops. Memoize heavy children (`useMemo`) when a parent re-renders often.
- **`react-resizable-panels` resize can silently break.** Hit regions are computed from each `<Group>`'s *direct* children carrying `data-panel`/`data-separator`. Avoid nesting `<Group>` inside `<Panel>` plus `collapsible` + imperative `collapse()/expand()` — that combination can defeat hit-region computation. Keep layouts flat where possible; one nesting level is OK if each group is internally flat. Separators should be plain background-colored strips, not wrappers with absolutely-positioned children that intercept pointer events. The visible width can be 1px — the library expands the drag hit region to ≥10px regardless.
- **Migrations are append-only.** Editing an already-applied migration corrupts upgrade paths for existing installs. Add a new versioned entry.
- **`withTransaction` is required for atomic multi-statement writes** — the SQL plugin does not serialize concurrent callers by default.
- **Capabilities are per-method.** Adding a Tauri window/IPC call without its `core:*:allow-*` permission produces a confusing "not allowed" error at runtime, not at build time.
- **Dynamic plugin imports** need the `/* @vite-ignore */` comment — it's load-bearing for the build.
- **Split-package monorepo.** Run frontend commands from `kylins.client.frontend/` and `cargo tauri dev` from `kylins.client.backend/`. `tauri.conf.json` paths are relative to the backend crate.

When a pitfall is relevant to the current change, call it out explicitly in the review.

## Scope judgment

Not every change needs the full enterprise treatment. A typo fix or a one-line constant doesn't need a design note — running the gates and a quick hygiene scan is enough. Reserve Mode A's full template for new features, new modules, schema changes, security-sensitive paths (auth, secrets, HTML rendering, IPC), and anything touching the plugin contract or cross-cutting state. When in doubt, do the review and keep the note short.
