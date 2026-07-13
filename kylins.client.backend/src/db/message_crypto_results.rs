//! Per-message crypto verification / decryption result query layer.
//!
//! Owns the `message_crypto_results` table CRUD (one row per message, keyed by
//! `(account_id, message_id)`). The table is the persistence target for the
//! receive-crypto pipeline (G2 decrypt + G3 verify in
//! `docs/superpowers/specs/2026-06-29-crypto-system-design.md`); this module
//! lands in Plan 1 (G1) so the schema + helper pair exists before later plans
//! write into it. The row carries the rich outcome (decrypt state, signature
//! state, signer identity, chain validity, revocation state) — the dormant
//! `messages.is_encrypted` / `is_signed` flag columns only carry the boolean
//! detection signal set during the headers-only sync.

use serde::{Deserialize, Serialize};
use sqlx::SqlitePool;

/// A crypto-result row. JSON keys are camelCase for the IPC boundary (the row
/// is returned across Tauri commands by later plans). The string-typed enums
/// mirror the migration's CHECK constraints verbatim — the DB rejects any value
/// outside the allowed set, so the strings here are always one of the
/// documented variants after a successful read.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, sqlx::FromRow)]
#[serde(rename_all = "camelCase")]
pub struct MessageCryptoResultRow {
    pub account_id: String,
    pub message_id: String,
    /// `'encrypted' | 'signed' | 'encrypted-signed'`.
    pub crypto_kind: String,
    /// `'ok' | 'no-key' | 'failed' | 'n/a'`.
    pub decrypt_state: String,
    /// `'not-signed' | 'valid-verified' | 'valid-unverified' | 'invalid' |
    /// `'unknown-key' | 'mismatch'`.
    pub signature_state: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub signer_fingerprint: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub signer_email: Option<String>,
    /// `1` / `0` / `None` (unchecked) — mirrors the SQLite INTEGER column.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub chain_valid: Option<i64>,
    /// `'good' | 'revoked' | 'unchecked'`.
    pub revocation_state: String,
    /// Epoch-seconds string (matches `strftime('%s','now')` written by the
    /// verify pipeline). The DB column is TEXT NOT NULL.
    pub verified_at: String,
}

/// Insert or update a per-message crypto result. On conflict (same
/// `account_id + message_id`) every mutable field updates; the primary key is
/// stable. Caller is responsible for supplying a valid `verified_at` (the
/// convention is `strftime('%s','now')` string epoch seconds, matching
/// `crypto_keys` / `trust_decisions`).
pub async fn upsert_message_crypto_result(
    pool: &SqlitePool,
    row: &MessageCryptoResultRow,
) -> Result<(), String> {
    sqlx::query(
        "INSERT INTO message_crypto_results
            (account_id, message_id, crypto_kind, decrypt_state, signature_state,
             signer_fingerprint, signer_email, chain_valid, revocation_state, verified_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(account_id, message_id) DO UPDATE SET
            crypto_kind = excluded.crypto_kind,
            decrypt_state = excluded.decrypt_state,
            signature_state = excluded.signature_state,
            signer_fingerprint = excluded.signer_fingerprint,
            signer_email = excluded.signer_email,
            chain_valid = excluded.chain_valid,
            revocation_state = excluded.revocation_state,
            verified_at = excluded.verified_at",
    )
    .bind(&row.account_id)
    .bind(&row.message_id)
    .bind(&row.crypto_kind)
    .bind(&row.decrypt_state)
    .bind(&row.signature_state)
    .bind(&row.signer_fingerprint)
    .bind(&row.signer_email)
    .bind(row.chain_valid)
    .bind(&row.revocation_state)
    .bind(&row.verified_at)
    .execute(pool)
    .await
    .map_err(|e| e.to_string())?;
    Ok(())
}

/// Read the per-message crypto result, or `None` if no row exists (the message
/// has not been through the verify pipeline yet).
pub async fn get_message_crypto_result(
    pool: &SqlitePool,
    account_id: &str,
    message_id: &str,
) -> Result<Option<MessageCryptoResultRow>, String> {
    let row: Option<MessageCryptoResultRow> = sqlx::query_as(
        "SELECT account_id, message_id, crypto_kind, decrypt_state, signature_state,
                signer_fingerprint, signer_email, chain_valid, revocation_state, verified_at
         FROM message_crypto_results WHERE account_id = ? AND message_id = ?",
    )
    .bind(account_id)
    .bind(message_id)
    .fetch_optional(pool)
    .await
    .map_err(|e| e.to_string())?;
    Ok(row)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Seed the `accounts` FK row the `threads`/`messages` FKs require. Mirrors
    /// the helper in `db/crypto_keys.rs` and `db/message_bodies.rs` (same
    /// column set + `strftime('%s','now')` timestamps).
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

    /// Seed the `threads` + `messages` rows that the `message_crypto_results`
    /// FK requires. Uses the placeholder-thread pattern (one thread per
    /// message) the same as the existing `message_bodies::tests::seed_message`.
    async fn seed_message(pool: &SqlitePool, account_id: &str, message_id: &str) {
        sqlx::query(
            "INSERT INTO threads (id, account_id, is_read, last_message_at)
             VALUES (?, ?, 0, 0)",
        )
        .bind(message_id)
        .bind(account_id)
        .execute(pool)
        .await
        .unwrap();
        sqlx::query(
            "INSERT INTO messages (id, account_id, thread_id, date, is_read, is_starred, body_cached)
             VALUES (?, ?, ?, 0, 0, 0, 0)",
        )
        .bind(message_id)
        .bind(account_id)
        .bind(message_id)
        .execute(pool)
        .await
        .unwrap();
    }

    fn sample_row(account_id: &str, message_id: &str) -> MessageCryptoResultRow {
        MessageCryptoResultRow {
            account_id: account_id.to_string(),
            message_id: message_id.to_string(),
            crypto_kind: "encrypted".to_string(),
            decrypt_state: "ok".to_string(),
            signature_state: "not-signed".to_string(),
            signer_fingerprint: Some("ABCD1234".to_string()),
            signer_email: Some("signer@x.com".to_string()),
            chain_valid: Some(1),
            revocation_state: "good".to_string(),
            verified_at: "1770000000".to_string(),
        }
    }

    #[tokio::test]
    async fn upsert_then_get_round_trips() {
        let tmp = tempfile::tempdir().unwrap();
        let pool = crate::db::init_db(tmp.path()).await.unwrap();
        seed_account(&pool, "a1").await;
        seed_message(&pool, "a1", "m1").await;

        let row = sample_row("a1", "m1");
        upsert_message_crypto_result(&pool, &row).await.unwrap();

        let got = get_message_crypto_result(&pool, "a1", "m1")
            .await
            .unwrap()
            .expect("row present");
        assert_eq!(got, row);
    }

    #[tokio::test]
    async fn upsert_replaces_on_conflict() {
        let tmp = tempfile::tempdir().unwrap();
        let pool = crate::db::init_db(tmp.path()).await.unwrap();
        seed_account(&pool, "a1").await;
        seed_message(&pool, "a1", "m1").await;

        let mut row = sample_row("a1", "m1");
        upsert_message_crypto_result(&pool, &row).await.unwrap();

        // Re-upsert with changed fields — every mutable column must update.
        row.decrypt_state = "failed".into();
        row.signature_state = "invalid".into();
        row.chain_valid = Some(0);
        row.revocation_state = "revoked".into();
        row.signer_email = None;
        upsert_message_crypto_result(&pool, &row).await.unwrap();

        let got = get_message_crypto_result(&pool, "a1", "m1")
            .await
            .unwrap()
            .expect("row present");
        assert_eq!(got.decrypt_state, "failed");
        assert_eq!(got.signature_state, "invalid");
        assert_eq!(got.chain_valid, Some(0));
        assert_eq!(got.revocation_state, "revoked");
        assert!(got.signer_email.is_none());
    }

    #[tokio::test]
    async fn get_returns_none_when_absent() {
        let tmp = tempfile::tempdir().unwrap();
        let pool = crate::db::init_db(tmp.path()).await.unwrap();
        // No row seeded — must be Ok(None), not an error.
        assert!(get_message_crypto_result(&pool, "a1", "nope")
            .await
            .unwrap()
            .is_none());
    }

    #[tokio::test]
    async fn row_serializes_to_camel_case_json() {
        let row = sample_row("a1", "m1");
        let json = serde_json::to_value(&row).unwrap();
        let obj = json.as_object().unwrap();
        for key in [
            "accountId",
            "messageId",
            "cryptoKind",
            "decryptState",
            "signatureState",
            "signerFingerprint",
            "signerEmail",
            "chainValid",
            "revocationState",
            "verifiedAt",
        ] {
            assert!(obj.contains_key(key), "expected camelCase key {key}");
        }
        // snake_case keys must NOT leak.
        for key in ["account_id", "message_id", "crypto_kind", "decrypt_state"] {
            assert!(!obj.contains_key(key), "snake_case key {key} leaked");
        }
    }
}
