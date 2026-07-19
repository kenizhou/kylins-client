# Plan — Backend IMAP Clippy Cleanup

> Proportional SDD: this is mechanical lint remediation (not a feature/schema/
> security change), so the lints below ARE the spec — no separate design doc.
> Loop: implementer subagent → controller review → ledger. Branch
> `fix/smime-receive-and-sign-details` (off `07e87c1`). UNCOMMITTED.

## Goal

Clear the 5 pre-existing `cargo clippy --all-targets -- -D warnings` errors in
`src/mail/imap/{client.rs,session_manager.rs}` so the backend clippy gate is
fully green (these are the only blockers — all other backend files are clean).
NO behavior change; the fixes are idiomatic-lint or `#[allow]` with rationale.

## The 5 lints + chosen fix

| # | Location | Lint | Fix |
|---|---|---|---|
| 1 | `client.rs:2931` | `stripping a prefix manually` (`rest[1..]` after a `rest.starts_with('(')` check) | `let rest = rest.strip_prefix('(')?;` then index `rest`/`rest[..end]` — behavior-identical, RFC 8474 paren-wrapped OBJECTID parsing unchanged. |
| 2 | `client.rs:3582` | `unused import: extract_raw_ciphertext` (in `#[cfg(test)] mod tests` `use super::{…}`) | Remove `extract_raw_ciphertext` from the import list. |
| 3 | `session_manager.rs:338` | `called map(..).flatten() on Option` (`map.get(...).map(\|h\| h.setup.lock().unwrap().clone()).flatten()`) | `.and_then(\|h\| h.setup.lock().unwrap().clone())` — identical semantics (and_then = Option flatMap). |
| 4 | `session_manager.rs:622` `handle_msg` | `too_many_arguments (8/7)` | `#[allow(clippy::too_many_arguments)]` + a one-line comment: actor state-passing seam — each arg is a distinct piece of mutable actor state; bundling into a struct would mean create-then-immediately-destructure. Mirrors the project's `send_op` / `build_crypto_result_row` / `verify_with_context` allow pattern. |
| 5 | `session_manager.rs:660` `run_command` | `too_many_arguments (8/7)` | Same: `#[allow(clippy::too_many_arguments)]` + comment. Private internal fn, one call site (handle_msg:651); a param-object adds a type for marginal gain. |

## Discipline

- **No behavior change.** Each fix is provably equivalent (lint-suggested or a
  documented allow). The IMAP actor + OBJECTID parser are delicate — touch
  NOTHING beyond the 5 spots.
- For #1: carefully preserve the `?` early-return-on-no-`)` and the `trim()`.
  After `strip_prefix('(')`, the `end` index + slice bounds shift by −1 — get
  the arithmetic right (the value returned must be byte-identical to before).
- For #4/#5: the `#[allow]` goes on the `async fn` line (attribute above it).

## Gates (must be fully green — this task's whole point)
```
cargo clippy --all-targets -- -D warnings    # from kylins.client.backend/ → 0 errors
cargo test --lib                              # unchanged pass count (563)
```

## Carry-forwards

None (this is remediation). If a fix surfaces a real code smell worth a follow-up
(e.g. the actor-state bundle), note it in the ledger but don't expand scope.
