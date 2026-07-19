# Encryption Granularity Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement the now-executable slice of the `EncryptionGranularity` design (`docs/security/crypto-architecture-design.md` §11.4.1): the enum, per-account DB plumbing, and Granularity B's merged-`multipart/mixed` composition on the S/MIME send path — with zero receive-side change and zero regression for `WholeMessage`/Granularity A.

**Architecture:** Granularity is resolved per-account at send time and threaded into `build_mime`. Under S/MIME A-form (the only backend today), `SmimeBackend::encrypt` still takes one body-entity part and emits one `EnvelopedData` (§11.6 hard rule 1) — so granularity's ONLY now-implementable effect is at the MIME-composition layer: Granularity B wraps all regular attachments into one nested `multipart/mixed` subtree (interop-safe; `mail_parser`+`extract_attachments` walk it recursively). Granularity A collapses to `WholeMessage` on the wire (its per-part benefit is `SplitPerPart`-only, future). `apply_crypto` is **untouched**. The `encrypt_parts(parts, granularity, serialization, …)` signature from the design doc is **not** added now (no consumer — YAGNI).

**Tech Stack:** Rust (Tauri v2 backend, `sqlx::migrate!`, `mail-builder`/`mail-parser`), `crypto-core` crate (`kylins.client.crypto/core/`).

## Global Constraints

- **Scope fence:** Implement ONLY what is listed below. Do NOT add `encrypt_parts`/`SplitPerPart`/per-part session keys/per-part lazy decrypt — those depend on the not-yet-existing OpenPGP backend (Phase 2) and `SmimeBackend::encrypt` rejects `SplitPerPart` (`kylins.client.crypto/smime/src/lib.rs:289-296`). They are a separate future plan.
- **No `SendDraft` change:** Per the design (§11.4.1 "选择器"), granularity is resolved from `accounts.crypto_granularity` at send time. `SendDraft` must NOT gain a granularity field. Frontend composer exposes no granularity UI in this plan.
- **No receive-side change:** `extract_attachments` (`kylins.client.backend/src/mail/imap/client.rs:3334`) already walks the MIME tree recursively. The Granularity-B merged `multipart/mixed` is a standard MIME subtree → parseable with zero receive change. (Task 4's round-trip test verifies this; if it fails, the fallback is a recursion fix in `extract_attachments` — but expect it to pass.)
- **Policy: granularity applies only when encrypting.** `send_op` passes `WholeMessage` for non-encrypting sends (plaintext / sign-only) — granularity is an *encryption* granularity. `build_mime` itself is pure composition (takes a `granularity` param, does not read `draft.encrypt`).
- **Migration location:** `kylins.client.backend/migrations/*.sql`, applied by `sqlx::migrate!("./migrations")` (`src/db/mod.rs:202`). The frontend `_migrations` table is legacy and must NOT be touched.
- **Granularity B merge threshold:** only merge when `attach_parts.len() >= 2`. For 0 or 1 attachment there is nothing to merge → behavior is identical to `WholeMessage` (no wrapper `multipart/mixed` around a single attachment).
- **Commit policy:** User controls all git commits. Each task ends with a `git add` + `git commit` step that the user approves; do not push.
- **Test runner:** `cargo test -p kylins-client-backend` and `cargo test -p crypto-core` from `kylins.client.backend` / `kylins.client.crypto/core` respectively. Run `cargo fmt` before each commit.
- **Existing patterns to mirror (do not invent new):**
  - `ALTER TABLE accounts ADD COLUMN` precedent: `migrations/20260701000002_add_accounts_auth_type.sql`, `20260704000001_add_accounts_smtp_username.sql`.
  - Loader fn precedent: `get_default_signing_key` (`src/db/crypto_keys.rs:449-471`).
  - `Account` struct + `row_to_account` mapping: `src/db/accounts.rs:34`, `:263`.
  - send_op inline `query_scalar` precedent: `account_email` fetch at `src/sync_engine/engine.rs:973`.
  - mail-builder nested multipart: `MimePart::new("multipart/mixed", BodyPart::Multipart(children))` (`src/mail/builder.rs:235`).

## File Structure

| File | Action | Responsibility |
|---|---|---|
| `kylins.client.crypto/core/src/envelope.rs` | Modify | Add `EncryptionGranularity` enum + `from_db_str`/`as_db_str` + unit tests. (Lives next to `SerializationStrategy` at `:54`.) |
| `kylins.client.backend/migrations/20260719000001_add_accounts_crypto_granularity.sql` | Create | Add nullable `accounts.crypto_granularity` column. |
| `kylins.client.backend/src/db/accounts.rs` | Modify | Add `crypto_granularity: Option<String>` to `Account` (`:34`), map it in `row_to_account` (`:263`), add `get_crypto_granularity` loader. |
| `kylins.client.backend/src/mail/builder.rs` | Modify | Split `build_mime` into a `WholeMessage` wrapper + `build_mime_with_granularity(draft, granularity)`; add `body_unit_no_inline` helper; add Granularity-B merged-`multipart/mixed` branch in both the inline and non-inline paths. |
| `kylins.client.backend/src/sync_engine/engine.rs` | Modify | `send_op`: resolve granularity (only when `draft.encrypt`), thread into `build_mime_with_granularity` at `:921`. Update `build_and_send` test seam at `:1290` only if its signature changes (it won't — it keeps calling `build_mime`). |

`apply_crypto` (`src/mail/crypto.rs:1282`) is **not modified** — it encrypts whatever composed bytes it receives as one blob.

---

## Task 1: `EncryptionGranularity` enum in `crypto-core`

**Files:**
- Modify: `kylins.client.crypto/core/src/envelope.rs` (add enum next to `SerializationStrategy` at `:54`).

**Interfaces:**
- Produces: `crypto_core::EncryptionGranularity` (enum), `EncryptionGranularity::from_db_str(Option<&str>) -> Self`, `EncryptionGranularity::as_db_str(Self) -> &'static str`. Consumed by Task 4 (`builder.rs`) and Task 5 (`engine.rs`).

- [ ] **Step 1: Write the failing test**

Append to `kylins.client.crypto/core/src/envelope.rs` (after the `SerializationStrategy` definition near `:54`):

```rust
/// Encryption granularity — how parts are grouped into encryption units
/// (session-key granularity). Orthogonal to `SerializationStrategy` (wire
/// layout). See docs/security/crypto-architecture-design.md §11.4.1.
///
/// Under S/MIME A-form (SingleMimeBlob), only `BodyInlineAndMergedAttachments`
/// has a now-implementable effect (merged multipart/mixed subtree in the
/// composed plaintext). The per-part session-key benefit of A/B is realized
/// only under SplitPerPart (future, E2EE-internal).
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum EncryptionGranularity {
    /// Standard: whole MIME tree as one encryption unit (one session key).
    /// Current behavior.
    WholeMessage,
    /// Granularity A: body+inline images as one unit; each regular attachment
    /// its own unit. (Per-part benefit is SplitPerPart-only; collapses to
    /// WholeMessage on the S/MIME wire today.)
    BodyInlineAndPerAttachment,
    /// Granularity B: body+inline images as one unit; all regular attachments
    /// merged into a single multipart/mixed entity as one unit.
    BodyInlineAndMergedAttachments,
}

impl EncryptionGranularity {
    /// Parse the DB column value. NULL / unknown / "whole_message" → WholeMessage.
    pub fn from_db_str(s: Option<&str>) -> Self {
        match s {
            Some("body_inline_per_attachment") => Self::BodyInlineAndPerAttachment,
            Some("body_inline_merged_attachments") => Self::BodyInlineAndMergedAttachments,
            _ => Self::WholeMessage,
        }
    }

    pub fn as_db_str(self) -> &'static str {
        match self {
            Self::WholeMessage => "whole_message",
            Self::BodyInlineAndPerAttachment => "body_inline_per_attachment",
            Self::BodyInlineAndMergedAttachments => "body_inline_merged_attachments",
        }
    }
}

#[cfg(test)]
mod granularity_tests {
    use super::EncryptionGranularity as G;

    #[test]
    fn from_db_str_round_trip() {
        for v in [G::WholeMessage, G::BodyInlineAndPerAttachment, G::BodyInlineAndMergedAttachments] {
            assert_eq!(G::from_db_str(Some(v.as_db_str())), v);
        }
    }

    #[test]
    fn from_db_str_defaults_to_whole_message() {
        assert_eq!(G::from_db_str(None), G::WholeMessage);
        assert_eq!(G::from_db_str(Some("")), G::WholeMessage);
        assert_eq!(G::from_db_str(Some("garbage")), G::WholeMessage);
        assert_eq!(G::from_db_str(Some("whole_message")), G::WholeMessage);
    }
}
```

- [ ] **Step 2: Run test to verify it fails (enum not yet wired if file lacks serde on the enum — but we just added it, so it should compile & pass first try; still, confirm the module builds)**

Run: `cargo test -p crypto-core granularity`
Expected: PASS (the enum and tests are added in one step; if the crate lacks the `serde` feature on `envelope.rs` types, it still builds because `Cargo.toml` already has `serde = { features = ["derive"] }` — confirmed).

- [ ] **Step 3: Confirm the crate builds clean**

Run: `cargo build -p crypto-core`
Expected: builds with no errors.

- [ ] **Step 4: Run the test to verify it passes**

Run: `cargo test -p crypto-core granularity`
Expected: `granularity_tests::from_db_str_round_trip ... ok`, `granularity_tests::from_db_str_defaults_to_whole_message ... ok`.

- [ ] **Step 5: Commit**

```bash
cd kylins.client.backend && cargo fmt --all  # fmt the workspace
git add kylins.client.crypto/core/src/envelope.rs
git commit -m "feat(crypto-core): add EncryptionGranularity enum (粒度 A/B + WholeMessage)"
```

---

## Task 2: DB migration — `accounts.crypto_granularity` column

**Files:**
- Create: `kylins.client.backend/migrations/20260719000001_add_accounts_crypto_granularity.sql`

**Interfaces:**
- Produces: a nullable `accounts.crypto_granularity TEXT` column. Consumed by Task 3's loader and `row_to_account`.

- [ ] **Step 1: Create the migration file**

`kylins.client.backend/migrations/20260719000001_add_accounts_crypto_granularity.sql`:

```sql
-- EncryptionGranularity: per-account default encryption scope (§11.4.1).
-- Values: 'whole_message' | 'body_inline_per_attachment' | 'body_inline_merged_attachments'.
-- NULL = application default (WholeMessage). Mirrors auth_type / smtp_username precedent.
ALTER TABLE accounts ADD COLUMN crypto_granularity TEXT;
```

(The filename timestamp `20260719000001` must sort after the current latest `20260718400000_crypto_receive_revocation_reason.sql`. `sqlx::migrate!("./migrations")` at `src/db/mod.rs:202` picks it up automatically — no registration step.)

- [ ] **Step 2: Verify the migration applies cleanly**

Run: `cargo test -p kylins-client-backend --test '*' db:: 2>&1 | tail -30` (or whichever db test target exercises migrations; the existing test at `src/db/mod.rs:266` runs `sqlx::migrate!` on a fresh temp DB).
Expected: migration applies with no error; the db-mod test still passes. If the test binary name differs, run `cargo test -p kylins-client-backend` and grep for `migrate`/`db::` failures.

- [ ] **Step 3: Commit**

```bash
git add kylins.client.backend/migrations/20260719000001_add_accounts_crypto_granularity.sql
git commit -m "feat(db): add accounts.crypto_granularity column (EncryptionGranularity)"
```

---

## Task 3: `Account` field + `get_crypto_granularity` loader

**Files:**
- Modify: `kylins.client.backend/src/db/accounts.rs` — struct at `:34`, `row_to_account` at `:263`, new loader near the other `get_by_*` fns (after `:385`).

**Interfaces:**
- Consumes: the `accounts.crypto_granularity` column (Task 2).
- Produces: `Account.crypto_granularity: Option<String>` (crosses IPC to frontend as `cryptoGranularity` — read-only display, no setter in this plan); `pub async fn get_crypto_granularity(pool, account_id) -> Result<Option<String>, sqlx::Error>`. Consumed by Task 5.

- [ ] **Step 1: Add the field to the `Account` struct**

In `src/db/accounts.rs`, inside `pub struct Account { ... }` (starts `:34`), add near the other `Option<String>` account-config fields (e.g. next to `auth_type` at `:108`):

```rust
    /// Per-account encryption granularity (§11.4.1). NULL = app default (WholeMessage).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub crypto_granularity: Option<String>,
```

- [ ] **Step 2: Map the column in `row_to_account`**

In `fn row_to_account(row: &SqliteRow) -> Result<Account, String>` at `:263`, add a line next to the other `.try_get(...).ok().flatten()` mappings (e.g. next to `auth_type` at `:311`):

```rust
        crypto_granularity: row.try_get("crypto_granularity").ok().flatten(),
```

- [ ] **Step 3: Add the loader fn**

After `get_by_email` (ends ~`:385`), add:

```rust
/// Load only `crypto_granularity` for an account. Mirrors `get_default_signing_key`
/// (db/crypto_keys.rs). NULL (or missing row) → None → caller falls back to WholeMessage.
///
/// NOTE: `.flatten()` forces the scalar type to `Option<String>` so a NULL column
/// decodes to `None` (Option<T> Decode checks is_null). Without it, scalar T=String
/// and sqlx-sqlite 0.8 decodes NULL TEXT as Some("") — see Task 3 report.
pub async fn get_crypto_granularity(
    pool: &SqlitePool,
    account_id: &str,
) -> Result<Option<String>, sqlx::Error> {
    Ok(
        sqlx::query_scalar("SELECT crypto_granularity FROM accounts WHERE id = ?")
            .bind(account_id)
            .fetch_optional(pool)
            .await?
            .flatten(),
    )
}
```

(If `SqlitePool` / `SqliteRow` are not already imported at the top of `accounts.rs`, they are — the existing loaders use them. Mirror exactly. The `.flatten()` is load-bearing for NULL→None semantics.)

- [ ] **Step 4: Write a failing test**

In the `accounts.rs` `#[cfg(test)]` module, add a test using the real test-pool helper `crate::db::init_db(tempfile::tempdir().unwrap().path())` (the actual helper used by every existing accounts test — NOT `crate::db::tests::setup_pool()` which is a placeholder). Insert a bare account row, then assert `get_crypto_granularity` returns `None` for the fresh account.

- [ ] **Step 5: Run test to verify it fails (fn not yet defined) then passes**

Run: `cargo test -p kylins-client-backend get_crypto_granularity`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
cd kylins.client.backend && cargo fmt --all
git add src/db/accounts.rs
git commit -m "feat(db): expose accounts.crypto_granularity on Account + loader"
```

---

## Task 4: `build_mime` Granularity-B composition

**Files:**
- Modify: `kylins.client.backend/src/mail/builder.rs` — split `build_mime` (`:123`), add `body_unit_no_inline` helper, add merged-`multipart/mixed` branch in both the non-inline path (`:194-205`) and the inline path (`:221-235`).
- Test: extend the `#[cfg(test)] mod tests` in `builder.rs` (tests exist at `:326, :366, :381, :409, :428`).

**Interfaces:**
- Consumes: `crypto_core::EncryptionGranularity` (Task 1).
- Produces: `pub async fn build_mime_with_granularity(draft: &SendDraft, granularity: EncryptionGranularity) -> Result<Vec<u8>, String>` (the existing `pub async fn build_mime(draft)` becomes a `WholeMessage` wrapper). Consumed by Task 5.

**Policy reminder (from Global Constraints):** merge only when `granularity == BodyInlineAndMergedAttachments && attach_parts.len() >= 2`. `WholeMessage` and `BodyInlineAndPerAttachment` produce byte-identical output to today (zero regression) — Granularity A is a no-op on the S/MIME wire (per-part benefit is future).

- [ ] **Step 1: Add the import at the top of `builder.rs`**

After the existing `use mail_builder::{...};` block (`:7-11`), add:

```rust
use crypto_core::EncryptionGranularity;
```

(If `crypto_core` isn't a dependency of the backend `Cargo.toml`, it is — `mail/crypto.rs:31` already `use crypto_core::{...}`. So the import resolves.)

- [ ] **Step 2: Write the failing test for Granularity B (non-inline, 3 attachments)**

In `builder.rs`'s `#[cfg(test)] mod tests`, add a test that builds a 3-attachment draft with `build_mime_with_granularity(draft, BodyInlineAndMergedAttachments)`, parses the output with `mail_parser::MessageParser`, and asserts the top-level `multipart/mixed` has exactly 2 children (body + merged container), and the 2nd child is a `multipart/mixed` holding all 3 attachments. **Before writing the test, read `extract_attachments` at `mail/imap/client.rs:3334` to learn the exact `mail_parser` traversal API this codebase uses** (e.g. `.attachment(0)` / `.attachments()` / `MessageAttachment` accessors) and mirror it — do not guess the API. Also read `builder.rs:42-90` for the exact `SendDraft` / `AddressSpec` / `AttachmentRef` field names and `CryptoMethod` variant.

- [ ] **Step 3: Run test to verify it fails**

Run: `cargo test -p kylins-client-backend build_mime_granularity_b`
Expected: FAIL — `build_mime_with_granularity` not defined yet.

- [ ] **Step 4: Implement — split `build_mime` + add the merge branch + helper**

Rename the existing `pub async fn build_mime` body to a new `pub async fn build_mime_with_granularity(draft: &SendDraft, granularity: EncryptionGranularity) -> Result<Vec<u8>, String>` and replace the old `build_mime` with a wrapper:

```rust
pub async fn build_mime(draft: &SendDraft) -> Result<Vec<u8>, String> {
    build_mime_with_granularity(draft, EncryptionGranularity::WholeMessage).await
}

pub async fn build_mime_with_granularity(
    draft: &SendDraft,
    granularity: EncryptionGranularity,
) -> Result<Vec<u8>, String> {
    let mut b = MessageBuilder::new();
    // ... (unchanged: address headers, subject, custom headers, threading —
    //      lines :124-:162 stay verbatim) ...

    // ... (unchanged: read inline_parts :164-:178, read attach_parts :184-:192) ...

    // Merge flag: Granularity B with ≥2 regular attachments. Otherwise the tree
    // is byte-identical to today (WholeMessage / A / B-with-<2-attachments).
    let merge = granularity == EncryptionGranularity::BodyInlineAndMergedAttachments
        && attach_parts.len() >= 2;

    if inline_parts.is_empty() {
        if merge {
            // Auto-structuring (.text_body/.html_body/.push_attachment) can't
            // express a nested container, so compose the tree by hand.
            let body_unit = body_unit_no_inline(draft);
            let merged = MimePart::new(
                "multipart/mixed",
                BodyPart::Multipart(attach_parts),
            );
            let top = MimePart::new(
                "multipart/mixed",
                BodyPart::Multipart(vec![body_unit, merged]),
            );
            b = b.body(top);
        } else {
            // Existing auto-structure path (unchanged).
            if let Some(text) = &draft.text_body {
                b = b.text_body(text.clone());
            }
            if let Some(html) = &draft.html_body {
                b = b.html_body(html.clone());
            }
            for part in attach_parts {
                b = push_attachment(b, part);
            }
        }
    } else {
        // Inline path (multipart/related) — unchanged EXCEPT the merge branch.
        let html_part = MimePart::new(
            "text/html",
            BodyPart::Text(draft.html_body.clone().unwrap_or_default().into()),
        );
        let mut related_children: Vec<MimePart<'_>> = Vec::with_capacity(1 + inline_parts.len());
        related_children.push(html_part);
        related_children.extend(inline_parts);
        let related = MimePart::new("multipart/related", BodyPart::Multipart(related_children));

        let top: MimePart<'_> = if !attach_parts.is_empty() {
            let mut mixed_children: Vec<MimePart<'_>> =
                Vec::with_capacity(2 + if merge { 1 } else { attach_parts.len() });
            if let Some(text) = &draft.text_body {
                let text_part = MimePart::new("text/plain", BodyPart::Text(text.clone().into()));
                let alt = MimePart::new(
                    "multipart/alternative",
                    BodyPart::Multipart(vec![text_part, related]),
                );
                mixed_children.push(alt);
            } else {
                mixed_children.push(related);
            }
            if merge {
                mixed_children.push(MimePart::new(
                    "multipart/mixed",
                    BodyPart::Multipart(attach_parts),
                ));
            } else {
                mixed_children.extend(attach_parts);
            }
            MimePart::new("multipart/mixed", BodyPart::Multipart(mixed_children))
        } else if let Some(text) = &draft.text_body {
            let text_part = MimePart::new("text/plain", BodyPart::Text(text.clone().into()));
            MimePart::new(
                "multipart/alternative",
                BodyPart::Multipart(vec![text_part, related]),
            )
        } else {
            related
        };
        b = b.body(top);
    }

    b.write_to_vec().map_err(|e| format!("mime build failed: {e}"))
}

/// Build the body unit when there are no inline images: text/html/alternative
/// per what's present. Used only on the Granularity-B non-inline merge path.
fn body_unit_no_inline<'x>(draft: &SendDraft) -> MimePart<'x> {
    let has_html = draft.html_body.as_deref().filter(|h| !h.is_empty()).is_some();
    let has_text = draft.text_body.as_deref().filter(|t| !t.is_empty()).is_some();
    match (has_text, has_html) {
        (true, true) => {
            let t = MimePart::new("text/plain", BodyPart::Text(draft.text_body.clone().unwrap().into()));
            let h = MimePart::new("text/html", BodyPart::Text(draft.html_body.clone().unwrap().into()));
            MimePart::new("multipart/alternative", BodyPart::Multipart(vec![t, h]))
        }
        (false, true) => MimePart::new("text/html", BodyPart::Text(draft.html_body.clone().unwrap().into())),
        (true, false) => MimePart::new("text/plain", BodyPart::Text(draft.text_body.clone().unwrap().into())),
        (false, false) => MimePart::new("text/plain", BodyPart::Text(String::new().into())),
    }
}
```

- [ ] **Step 5: Run the Task 4 test to verify it passes**

Run: `cargo test -p kylins-client-backend build_mime_granularity_b`
Expected: PASS.

- [ ] **Step 6: Add a regression test — WholeMessage & A are unchanged**

A test that builds the same 3-attachment draft with `WholeMessage` and `BodyInlineAndPerAttachment`, asserts they produce identical bytes, and asserts the top `multipart/mixed` has body + 3 sibling attachments (4 children, no merged container). Refactor the 3-attachment draft setup into a shared `async fn make_three_attachment_draft() -> SendDraft` helper.

- [ ] **Step 7: Run regression test**

Run: `cargo test -p kylins-client-backend build_mime_whole_and_a`
Expected: PASS.

- [ ] **Step 8: Run the full builder test suite to confirm zero regression**

Run: `cargo test -p kylins-client-backend mail::builder`
Expected: all pre-existing builder tests (`:326, :366, :381, :409, :428`) still pass — they call `build_mime(&draft)` which now delegates to `WholeMessage`, byte-identical to before.

- [ ] **Step 9: Commit**

```bash
cd kylins.client.backend && cargo fmt --all
git add src/mail/builder.rs
git commit -m "feat(mail): build_mime Granularity B merges attachments into nested multipart/mixed"
```

---

## Task 5: `send_op` resolves granularity + threads into `build_mime_with_granularity`

**Files:**
- Modify: `kylins.client.backend/src/sync_engine/engine.rs` — `send_op` at `:906`, build call at `:921`. (`build_and_send` at `:1290` is a test seam that still calls `build_mime(draft)` — no change needed since granularity is irrelevant when not encrypting.)

**Interfaces:**
- Consumes: `crypto_core::EncryptionGranularity` (Task 1), `crate::db::accounts::get_crypto_granularity` (Task 3), `build_mime_with_granularity` (Task 4).
- Produces: encrypted sends respect the account's `crypto_granularity` at composition time.

**Policy:** pass `WholeMessage` for non-encrypting sends (granularity is an *encryption* granularity).

- [ ] **Step 1: Write a failing test**

A round-trip test: `build_mime_with_granularity(draft, B)` → `apply_crypto(...encrypt=true...)` → `open_crypto_message(...)` → assert all 3 attachments survive (proving the merged `multipart/mixed` subtree round-trips through S/MIME encrypt/decrypt and `extract_attachments`). This is the real correctness proof. Prefer this narrower round-trip over a full `send_op` harness unless one is already factored for testing.

- [ ] **Step 2: Run test to verify it fails**

Run: `cargo test -p kylins-client-backend <test_name>`
Expected: FAIL — `send_op` still calls `build_mime(draft)` (WholeMessage), so no merged subtree.

- [ ] **Step 3: Implement — resolve granularity in `send_op`**

In `send_op` (`src/sync_engine/engine.rs`, the `:906` fn), immediately BEFORE the `let mime = match crate::mail::builder::build_mime(draft).await { ... }` block at `:921`, add a granularity resolution (only when `draft.encrypt`) and change the build call to `build_mime_with_granularity(draft, granularity)`. Mirror the `account_email` error arm at `engine.rs:973-980` for the `SendResultEvent` shape on the `get_crypto_granularity` error path.

```rust
    let granularity = if draft.encrypt {
        match crate::db::accounts::get_crypto_granularity(&engine.pool, account_id).await {
            Ok(Some(s)) => crypto_core::EncryptionGranularity::from_db_str(Some(s.as_str())),
            Ok(None) => crypto_core::EncryptionGranularity::WholeMessage,
            Err(e) => {
                let msg = format!("get_crypto_granularity: {e}");
                // mirror SendResultEvent shape from the account_email error arm at engine.rs:973-980
                engine.sink.emit_send_result(/* SendResultEvent { success: false, ... } */);
                return Err(crate::sync_engine::SourceError::Other(msg));
            }
        }
    } else {
        crypto_core::EncryptionGranularity::WholeMessage
    };
    let mime = match crate::mail::builder::build_mime_with_granularity(draft, granularity).await { ... };
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cargo test -p kylins-client-backend <test_name>`
Expected: PASS — merged `multipart/mixed` round-trips through S/MIME encrypt → decrypt → `extract_attachments`, returning all 3 attachments.

- [ ] **Step 5: Confirm the crypto-receive test suite still passes (zero regression)**

Run: `cargo test -p kylins-client-backend mail::crypto 2>&1 | tail -40`
Expected: all pre-existing `mail::crypto` tests still pass — they call `build_mime(&draft)` which delegates to `WholeMessage`.

- [ ] **Step 6: Commit**

```bash
cd kylins.client.backend && cargo fmt --all
git add src/sync_engine/engine.rs
git commit -m "feat(sync): send_op resolves per-account EncryptionGranularity into build_mime"
```

---

## Task 6: Full verification + smoke

**Files:** none modified — verification only.

- [ ] **Step 1: Full backend + crypto-core test run**

```bash
cd kylins.client.backend
cargo fmt --all -- --check
cargo test -p crypto-core
cargo test -p kylins-client-backend 2>&1 | tail -50
```
Expected: all green. No regressions in `mail::builder`, `mail::crypto`, `db`, `sync_engine`.

- [ ] **Step 2: Manual smoke (optional but recommended)**

```bash
cd kylins.client.backend && cargo tauri dev
```
In the running app: set a test account's `crypto_granularity = 'body_inline_merged_attachments'` directly in SQLite (no UI in this plan), compose an encrypted email with 3 attachments to `felixzhou@kylins.local` (test IMAP/SMTP creds per memory), send. On the receiving side, fetch and open — confirm the ReadingPane shows the body and all 3 attachments extract correctly (proving the merged `multipart/mixed` subtree round-trips end-to-end through real IMAP/SMTP, not just unit tests).

- [ ] **Step 3: Final commit if any test fixtures/fixups were needed**

```bash
git add -A
git commit -m "test(crypto): EncryptionGranularity end-to-end fixtures"
```

---

## Out of Scope (separate future plans — do NOT implement here)

- **`SplitPerPart` serialization + per-part session keys + per-part lazy decrypt / per-part forwarding / blast-radius isolation.** Depends on the OpenPGP backend (Phase 2 of the roadmap). `SmimeBackend::encrypt` rejects `SplitPerPart` (`kylins.client.crypto/smime/src/lib.rs:289-296`); Granularity A's per-part benefit is realized only here. Plan separately when OpenPGP lands.
- **`encrypt_parts(parts, granularity, serialization, recipients)` API.** Design-only (§11.4.1). No consumer today — adding it would be dead code (YAGNI).
- **Global settings KV `crypto.granularity` + `SecurityPreferences` UI.** The per-account column (NULL→WholeMessage) is the now-implementable selector. A global override + frontend UI is a follow-up that adds cross-layer config plumbing; defer until the per-account column is proven.
- **Granularity A composition effect under `SplitPerPart`.** A is a no-op on the S/MIME wire today (collapses to WholeMessage); its composition difference only matters when `SplitPerPart` produces 1+N parts. No work now.

## Self-Review Notes

- **Spec coverage:** §11.4.1 enum → Task 1; §10.2 column → Task 2; §10.2/§12.3 account field → Task 3; §11.1 composition step → Task 4; §11.1 `send_op` resolves granularity → Task 5; §11.2 receive-side "天然可解、零改动" → verified by Task 4/5 round-trip tests; §11.6 hard-rule1 (公网坍缩) → honored by NOT touching `apply_crypto` (still one EnvelopedData). The `encrypt_parts` signature from the design is intentionally NOT implemented (Out of Scope).
- **Type consistency:** `EncryptionGranularity` (Task 1) referenced as `crypto_core::EncryptionGranularity` in Tasks 4 and 5. `from_db_str(Option<&str>)` matches Task 5's `from_db_str(Some(s.as_str()))`. `build_mime_with_granularity(draft, granularity)` matches Task 4 def + Task 5 call. `get_crypto_granularity(pool, account_id) -> Result<Option<String>, sqlx::Error>` matches Task 5's `Ok(Some(s))/Ok(None)` match — with the load-bearing `.flatten()` for NULL→None.
