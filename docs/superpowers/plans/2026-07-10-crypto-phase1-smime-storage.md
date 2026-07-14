# Crypto Phase 1 — S/MIME Storage Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stand up the `crypto-smime` crate skeleton, add a `NotImplemented` error variant to `crypto-core`, and ship the crypto key/trust/collected-keys DB layer (migration + `db::` modules + `db_*` commands) that later Phase-1 plans (CMS sign/encrypt, import, send hook, UI) build on.

**Architecture:** Three deliverables. (1) `kylins.client.crypto/smime/` — a new workspace member package `crypto-smime` (empty crate, no engine code yet — the `CryptoBackend` impl comes in Plan 2). (2) `crypto-core` gains a `CryptoError::NotImplemented` variant (the honest stub for the deferred receive side + a placeholder until the impl lands). (3) Backend gains the `crypto_keys` / `trust_decisions` / `collected_keys` tables + `db::` modules + `db_*` commands, with soft private-key blobs wrapped by the Phase-0 `crypto::encrypt_with_aad` (AAD binds `account_id + field + key_version`).

**Tech Stack:** Rust (edition 2021, rust-version 1.77.2); existing `sqlx`, `aes-gcm`, `keyring`, the Phase-0 `crypto-core` crate + backend `crypto::encrypt_with_aad`. No new engine deps in this plan.

## Global Constraints

- Rust edition **2021**, rust-version **1.77.2**.
- The crypto framework workspace is at repo-root **`kylins.client.crypto/`** (renamed from `crypto/`); crate names stay unprefixed (`crypto-core`, `crypto-smime`).
- Migrations are **additive-only** — a new `YYYYMMDDHHMMSS_<name>.sql` under `kylins.client.backend/migrations/`, never edit an applied one. Applied via `sqlx::migrate!("./migrations")`.
- **Secrets never plaintext in SQLite** — soft private-key blobs wrapped via `crate::crypto::encrypt_with_aad(blob, aad)` where `aad = format!("kylins:{account_id}:private_key:{key_version}")`; decrypted only in-Rust via `decrypt_with_aad`.
- `trust_decisions` is **append-only** (INSERT only, never UPDATE/DELETE).
- Private key material **never crosses the Tauri IPC boundary** — `db_*` commands return only public rows / metadata; the decrypting read is an in-Rust fn, not a command.
- TDD: failing test → red → implement → green. **Do NOT commit** — the user controls git; leave all changes in the working tree.
- Gates per task: `cargo test --manifest-path <crate> -- -D warnings` + `cargo clippy --all-targets -- -D warnings` clean.

## File Structure

**Framework (create):**
- `kylins.client.crypto/Cargo.toml` — add `smime` to workspace `members`.
- `kylins.client.crypto/smime/Cargo.toml` — package `crypto-smime` (dep `crypto-core` path; no engine deps yet).
- `kylins.client.crypto/smime/src/lib.rs` — module doc only (engine comes in Plan 2).

**Framework (modify):**
- `kylins.client.crypto/core/src/error.rs` — add `NotImplemented` variant + test.

**Backend (create):**
- `kylins.client.backend/migrations/20260710000001_crypto_keys.sql` — the 3 tables + 2 ALTERs.
- `kylins.client.backend/src/db/crypto_keys.rs` — `CryptoKeyRow`/`CryptoKeyRecord` + CRUD.
- `kylins.client.backend/src/db/trust_decisions.rs` — `TrustDecisionRow` + append-only put + latest get.
- `kylins.client.backend/src/db/collected_keys.rs` — `CollectedKeyRow` + stage/list/remove.

**Backend (modify):**
- `kylins.client.backend/src/db/mod.rs` — declare the 3 new modules.
- `kylins.client.backend/src/db/commands.rs` — the `db_*` Tauri commands (public-only returns).

---

### Task 1: `crypto-smime` crate skeleton + `crypto-core::NotImplemented`

**Files:**
- Create: `kylins.client.crypto/smime/Cargo.toml`, `kylins.client.crypto/smime/src/lib.rs`
- Modify: `kylins.client.crypto/Cargo.toml` (workspace members), `kylins.client.crypto/core/src/error.rs`

**Interfaces:**
- Consumes: `crypto-core` (Phase 0).
- Produces: a compiling `crypto-smime` crate (workspace member); `crypto_core::CryptoError::NotImplemented`.

- [ ] **Step 1: Add `smime` to the workspace**

`kylins.client.crypto/Cargo.toml`:
```toml
[workspace]
resolver = "2"
members = ["core", "smime"]
```

- [ ] **Step 2: Create `kylins.client.crypto/smime/Cargo.toml`**

```toml
[package]
name = "crypto-smime"
version = "0.1.0"
edition = "2021"
rust-version = "1.77.2"

[dependencies]
crypto-core = { path = "../core" }
async-trait = "0.1"
thiserror = "1"
```

- [ ] **Step 3: Create `kylins.client.crypto/smime/src/lib.rs`**

```rust
//! S/MIME backend for the Kylins crypto framework.
//!
//! Phase 1 Plan 2 will implement `crypto_core::CryptoBackend` here (CMS sign /
//! encrypt via the RustCrypto `cms` + `x509-cert` stack, `.p12`/PEM import).
//! This plan only stands the crate up so the storage layer + downstream crates
//! can depend on it.

pub const CRATE_NAME: &str = "crypto-smime";
```

- [ ] **Step 4: Add `NotImplemented` to `crypto-core::CryptoError`**

In `kylins.client.crypto/core/src/error.rs`, add a variant to the `CryptoError` enum (and a focused test). The enum currently has `Backend`, `Policy`, `KeyNotFound`, `UnsupportedStandard`, `Malformed`:

```rust
    #[error("not implemented: {0}")]
    NotImplemented(String),
```

Append to its `#[cfg(test)] mod tests`:
```rust
    #[test]
    fn not_implemented_variant_displays() {
        let e = CryptoError::NotImplemented("Phase 1b receive".into());
        assert!(format!("{e}").contains("Phase 1b receive"));
        assert!(matches!(e, CryptoError::NotImplemented(_)));
    }
```

- [ ] **Step 5: Run tests + clippy**

Run: `cargo test --manifest-path kylins.client.crypto/core/Cargo.toml` then `cargo build --manifest-path kylins.client.crypto/Cargo.toml -p crypto-smime` then `cargo clippy --manifest-path kylins.client.crypto/Cargo.toml --all-targets -- -D warnings`
Expected: crypto-core tests pass (incl. the new `not_implemented_variant_displays`); `crypto-smime` builds; clippy clean.

---

### Task 2: DB migration — `crypto_keys` + `trust_decisions` + `collected_keys` + account/contact columns

**Files:**
- Create: `kylins.client.backend/migrations/20260710000001_crypto_keys.sql`

**Interfaces:**
- Consumes: the existing `accounts` / `contacts` tables.
- Produces: the 3 new tables + columns, applied via `sqlx::migrate!`.

- [ ] **Step 1: Write the migration**

`kylins.client.backend/migrations/20260710000001_crypto_keys.sql` (umbrella spec §4.2 SQL + CHECK/UNIQUE constraints):
```sql
-- Crypto identity keys/certs, trust decisions, and collected (staging) keys.
-- Soft private-key blobs are stored as the hex produced by crypto::encrypt_with_aad
-- (AES-256-GCM under the OS-keyring master key, AAD-bound). Token-backed keys
-- leave private_data_enc NULL and reference the device via token_serial/token_key_id.

CREATE TABLE crypto_keys (
    id               TEXT PRIMARY KEY,
    account_id       TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    standard         TEXT NOT NULL CHECK(standard IN ('openpgp','smime','sm')),
    key_type         TEXT NOT NULL CHECK(key_type IN ('public','private','cert')),
    email            TEXT,
    fingerprint      TEXT NOT NULL,
    public_data      BLOB NOT NULL,            -- armored PGP / DER cert / SM2 cert
    private_data_enc BLOB,                     -- hex(0x01‖nonce‖ct) of soft private key; NULL for public-only/token
    token_serial     TEXT,
    token_key_id     TEXT,
    origin           TEXT NOT NULL CHECK(origin IN ('generated','imported','wkd','keyserver','autocrypt','contact')),
    is_default_sign    INTEGER NOT NULL DEFAULT 0,
    is_default_encrypt INTEGER NOT NULL DEFAULT 0,
    created_at       TEXT NOT NULL,
    expires_at       TEXT,
    policy_json      TEXT,
    UNIQUE(account_id, standard, fingerprint)
);
CREATE INDEX idx_crypto_keys_email    ON crypto_keys(standard, email);
CREATE INDEX idx_crypto_keys_account  ON crypto_keys(account_id, standard);

-- Silent staging: keys seen via discovery but NOT yet accepted.
CREATE TABLE collected_keys (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    account_id   TEXT,
    peer_email   TEXT,
    standard     TEXT,
    fingerprint  TEXT,
    public_data  BLOB,
    source       TEXT,
    seen_at      TEXT NOT NULL
);
CREATE INDEX idx_collected_keys_peer ON collected_keys(account_id, peer_email, standard);

-- Append-only trust/acceptance audit history (never UPDATE/DELETE).
CREATE TABLE trust_decisions (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    account_id    TEXT NOT NULL,
    peer_email    TEXT NOT NULL,
    standard      TEXT NOT NULL,
    fingerprint   TEXT NOT NULL,
    decision      TEXT NOT NULL CHECK(decision IN ('rejected','undecided','unverified','verified','personal')),
    evidence_json TEXT,
    decided_at    TEXT NOT NULL
);
CREATE INDEX idx_trust_lookup ON trust_decisions(account_id, peer_email, standard, fingerprint, decided_at);

ALTER TABLE accounts ADD COLUMN crypto_method TEXT DEFAULT 'none';      -- none|openpgp|smime|sm
ALTER TABLE accounts ADD COLUMN crypto_policy_json TEXT;
ALTER TABLE contacts ADD COLUMN pinned_keys_json TEXT;                  -- [{standard, fingerprint, data}]
```

- [ ] **Step 2: Verify it applies**

Run: `cargo test --manifest-path kylins.client.backend/Cargo.toml db:: -- --nocapture`
Expected: the existing `db::` tests (which call `init_db` → `sqlx::migrate!`) still pass — proves the new migration applies cleanly over the baseline.

---

### Task 3: `db::crypto_keys` + `db::trust_decisions` + `db::collected_keys` + `db_*` commands

**Files:**
- Create: `kylins.client.backend/src/db/crypto_keys.rs`, `trust_decisions.rs`, `collected_keys.rs`
- Modify: `kylins.client.backend/src/db/mod.rs` (declare modules), `kylins.client.backend/src/db/commands.rs` (the `db_*` commands)

**Interfaces:**
- Consumes: Task 2 tables; `crate::crypto::{encrypt_with_aad, decrypt_with_aad}` (Phase 0 Group A); `crypto_core::{Standard, KeyHandle, KeyHandleRef, ...}` for the row types where useful.
- Produces:
  - `db::crypto_keys::{CryptoKeyRow (public-facing, no private), CryptoKeyRecord (internal, incl. plaintext private), upsert_crypto_key, get_crypto_key_public, get_crypto_key_full (in-Rust decrypt), list_crypto_keys_for_email, list_crypto_keys_for_account}`
  - `db::trust_decisions::{TrustDecisionRow, put_trust_decision, get_latest_trust_decision}`
  - `db::collected_keys::{CollectedKeyRow, stage_collected_key, list_collected_keys_for_peer, remove_collected_key}`
  - `db_*` Tauri commands (public-only returns; `get_crypto_key_full` is **not** a command).

- [ ] **Step 1: Write `db/crypto_keys.rs`**

Follow the canonical pattern in `src/db/attachments.rs` (Row struct `#[serde(rename_all="camelCase")]` + `row_to_X(&SqliteRow)` mapper + `pub async fn`s taking `&SqlitePool` returning `Result<_, String>` + `#[cfg(test)] mod tests` using `tempfile` + `crate::db::init_db`).

- `CryptoKeyRow` (frontend-facing; **no private material**): `id, account_id, standard, key_type, email: Option, fingerprint, origin, is_default_sign: bool, is_default_encrypt: bool, created_at, expires_at: Option, has_private: bool, token_serial: Option, token_key_id: Option` (`has_private` = `private_data_enc IS NOT NULL`).
- `CryptoKeyRecord` (internal; `Serialize+Deserialize` so it can be an upsert command input): all the above `+ public_data: String` (armored/PEM) `+ private_data: Option<String>` (plaintext armored/DER private — **the db layer encrypts it at rest via `encrypt_with_aad`**).
- `upsert_crypto_key(pool, &rec)`: bind booleans as `i64`; if `private_data` is `Some(pt)`, compute `aad = format!("kylins:{}:private_key:1", rec.account_id)` and store `encrypt_with_aad(pt.as_bytes(), aad.as_bytes())` as `private_data_enc` TEXT; else NULL. `ON CONFLICT(account_id, standard, fingerprint) DO UPDATE` (preserve `id` + `created_at`); `created_at = strftime('%s','now')` on insert.
- `get_crypto_key_public(pool, standard, fingerprint) -> Option<CryptoKeyRow>`.
- `get_crypto_key_full(pool, standard, fingerprint) -> Option<CryptoKeyRecord>` — **in-Rust only**: reads `private_data_enc`, decrypts via `decrypt_with_aad(&enc, aad.as_bytes())` (recompute the same AAD) → `private_data`.
- `list_crypto_keys_for_email(pool, standard, email) -> Vec<CryptoKeyRow>`; `list_crypto_keys_for_account(pool, account_id, standard) -> Vec<CryptoKeyRow>`.

Tests (seed an account first): upsert-with-private → `get_crypto_key_public` returns `has_private=true` + no private field; `get_crypto_key_full` returns `private_data` decrypted back to the original; **raw `SELECT private_data_enc` is opaque (≠ plaintext)**; re-upsert same fingerprint preserves `created_at`; cross-account isolation; `list_crypto_keys_for_email` filters.

- [ ] **Step 2: Write `db/trust_decisions.rs`**

- `TrustDecisionRow { id: i64, account_id, peer_email, standard, fingerprint, decision, evidence_json: Option, decided_at }` (serde camelCase).
- `put_trust_decision(pool, account_id, peer_email, standard, fingerprint, decision, evidence_json: Option<&str>)` — INSERT only (`decided_at = strftime('%s','now')`).
- `get_latest_trust_decision(pool, account_id, peer_email, standard, fingerprint) -> Option<TrustDecisionRow>` — `ORDER BY decided_at DESC, id DESC LIMIT 1`.

Tests: `put` twice (unverified→verified) → `get_latest` returns `verified`; raw `COUNT(*) == 2` (append-only asserted).

- [ ] **Step 3: Write `db/collected_keys.rs`**

- `CollectedKeyRow { id: i64, account_id: Option, peer_email: Option, standard: Option, fingerprint, public_data: Vec<u8>, source: Option, seen_at }`.
- `stage_collected_key(pool, ...)` — INSERT (`seen_at = strftime('%s','now')`); `list_collected_keys_for_peer(pool, account_id, peer_email, standard) -> Vec<CollectedKeyRow>`; `remove_collected_key(pool, id)`.

Tests: stage → list returns it → remove → list empty.

- [ ] **Step 4: Declare the modules + add the `db_*` commands**

`src/db/mod.rs`: add `pub mod collected_keys; pub mod crypto_keys; pub mod trust_decisions;` (alphabetical).

`src/db/commands.rs` — add these `pub async fn db_*(pool: State<'_, SqlitePool>, ...) -> Result<_, String>` (mirror the existing `db_*` style; **public-only returns**):
```rust
pub async fn db_upsert_crypto_key(pool: State<'_, SqlitePool>, input: CryptoKeyRecord) -> Result<(), String>;
pub async fn db_get_crypto_key(pool: State<'_, SqlitePool>, standard: String, fingerprint: String) -> Result<Option<CryptoKeyRow>, String>;  // PUBLIC only
pub async fn db_list_crypto_keys_for_email(pool: State<'_, SqlitePool>, standard: String, email: String) -> Result<Vec<CryptoKeyRow>, String>;
pub async fn db_list_crypto_keys_for_account(pool: State<'_, SqlitePool>, account_id: String, standard: String) -> Result<Vec<CryptoKeyRow>, String>;
pub async fn db_put_trust_decision(pool: State<'_, SqlitePool>, input: TrustDecisionInput) -> Result<(), String>;  // TrustDecisionInput = serde camelCase struct of the put args
pub async fn db_get_trust_decision(pool: State<'_, SqlitePool>, account_id: String, peer_email: String, standard: String, fingerprint: String) -> Result<Option<TrustDecisionRow>, String>;
pub async fn db_stage_collected_key(pool: State<'_, SqlitePool>, input: CollectedKeyInput) -> Result<(), String>;
pub async fn db_list_collected_keys(pool: State<'_, SqlitePool>, account_id: String, peer_email: String, standard: String) -> Result<Vec<CollectedKeyRow>, String>;
pub async fn db_remove_collected_key(pool: State<'_, SqlitePool>, id: i64) -> Result<(), String>;
```
Define `TrustDecisionInput` + `CollectedKeyInput` as serde camelCase structs. **`db_get_crypto_key_full` must NOT exist as a command** (private material stays in Rust).

- [ ] **Step 5: Register the commands in `lib.rs`**

Add the 9 new `db::commands::db_*` to the `invoke_handler(tauri::generate_handler![…])` list in `kylins.client.backend/src/lib.rs`.

- [ ] **Step 6: Run gates**

Run: `cargo test --manifest-path kylins.client.backend/Cargo.toml` then `cargo clippy --manifest-path kylins.client.backend/Cargo.toml --all-targets -- -D warnings`
Expected: full backend suite green (existing + new db tests); clippy clean. Confirm via a raw-`SELECT` test assertion that `private_data_enc` is opaque, and that no command returns private material.

---

## Self-review

- **Spec coverage:** the storage-foundation subset of Phase 1 spec §4 (DB) is fully covered by Tasks 2–3; §0 decision #4 (NotImplemented) by Task 1. The CMS/import/send/UI parts are intentionally deferred to Plan 2+ (scope-check decomposition) — they are NOT gaps in THIS plan.
- **Placeholders:** none — Task 3 step 1–3 reference the canonical `attachments.rs` pattern + specify the exact structs/functions/tests (the row structs + SQL are fully enumerated); the implementer writes the `sqlx::query` bodies following `attachments.rs` line-for-line in style. The migration SQL (Task 2) is complete.
- **Type consistency:** `CryptoKeyRow` / `CryptoKeyRecord` / `TrustDecisionRow` / `CollectedKeyRow` names + fields are consistent across Task 3's Produces + the command signatures. `get_crypto_key_full` is in-Rust only (not a command) — consistent with the "private never crosses IPC" constraint.

## Phase 1 Plan 1 completion criteria

- `crypto-smime` crate compiles as a workspace member (no engine deps yet).
- `crypto_core::CryptoError::NotImplemented` exists + tested.
- `crypto_keys` / `trust_decisions` / `collected_keys` tables + `accounts.crypto_method`/`crypto_policy_json` / `contacts.pinned_keys_json` migrate cleanly.
- `db::crypto_keys` (public row + internal record + at-rest encryption via `encrypt_with_aad`), `db::trust_decisions` (append-only), `db::collected_keys` (staging) + 9 `db_*` commands (public-only) — all tested; private material never in a command return.
- All gates green; no regressions.

The next plan (Phase 1 Plan 2) implements `CryptoBackend` on `crypto-smime` (self-signed cert generate + PEM import + CMS sign + CMS encrypt), starting with a `cms`/`x509-cert` API spike.
