//! Trust decision audit query layer.
//!
//! Owns the `trust_decisions` table — the **append-only** trust/acceptance
//! history for a peer key. Each [`put_trust_decision`] is an INSERT (never
//! UPDATE/DELETE); the latest decision for a key is read back by
//! [`get_latest_trust_decision`] ordering by `decided_at DESC, id DESC`.

use serde::{Deserialize, Serialize};
use sqlx::{sqlite::SqliteRow, Row, SqlitePool};

/// One trust-decision row. Mirrors the `trust_decisions` table; JSON keys are
/// camelCase for the frontend.
#[derive(Debug, Clone, Serialize, Deserialize, Default, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct TrustDecisionRow {
    pub id: i64,
    pub account_id: String,
    pub peer_email: String,
    pub standard: String,
    pub fingerprint: String,
    pub decision: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub evidence_json: Option<String>,
    pub decided_at: String,
}

fn row_to_trust_decision(row: &SqliteRow) -> TrustDecisionRow {
    TrustDecisionRow {
        id: row.try_get("id").unwrap_or_default(),
        account_id: row.try_get("account_id").unwrap_or_default(),
        peer_email: row.try_get("peer_email").unwrap_or_default(),
        standard: row.try_get("standard").unwrap_or_default(),
        fingerprint: row.try_get("fingerprint").unwrap_or_default(),
        decision: row.try_get("decision").unwrap_or_default(),
        evidence_json: row.try_get("evidence_json").ok().flatten(),
        decided_at: row.try_get("decided_at").unwrap_or_default(),
    }
}

/// Append a new trust decision row (INSERT only — the table is an audit log,
/// so history is never mutated). `decided_at` is stamped server-side via
/// `strftime('%s','now')`.
pub async fn put_trust_decision(
    pool: &SqlitePool,
    account_id: &str,
    peer_email: &str,
    standard: &str,
    fingerprint: &str,
    decision: &str,
    evidence_json: Option<&str>,
) -> Result<(), String> {
    sqlx::query(
        "INSERT INTO trust_decisions \
         (account_id, peer_email, standard, fingerprint, decision, evidence_json, decided_at) \
         VALUES (?, ?, ?, ?, ?, ?, strftime('%s','now'))",
    )
    .bind(account_id)
    .bind(peer_email)
    .bind(standard)
    .bind(fingerprint)
    .bind(decision)
    .bind(evidence_json)
    .execute(pool)
    .await
    .map_err(|e| e.to_string())?;
    Ok(())
}

/// Return the latest trust decision for a peer key, or `None`. "Latest" is
/// `ORDER BY decided_at DESC, id DESC LIMIT 1` so a tie in `decided_at`
/// (second-resolution) breaks by insertion id.
pub async fn get_latest_trust_decision(
    pool: &SqlitePool,
    account_id: &str,
    peer_email: &str,
    standard: &str,
    fingerprint: &str,
) -> Result<Option<TrustDecisionRow>, String> {
    let row = sqlx::query(
        "SELECT id, account_id, peer_email, standard, fingerprint, decision, evidence_json, decided_at \
         FROM trust_decisions \
         WHERE account_id = ? AND peer_email = ? AND standard = ? AND fingerprint = ? \
         ORDER BY decided_at DESC, id DESC LIMIT 1",
    )
    .bind(account_id)
    .bind(peer_email)
    .bind(standard)
    .bind(fingerprint)
    .fetch_optional(pool)
    .await
    .map_err(|e| e.to_string())?;
    Ok(row.map(|r| row_to_trust_decision(&r)))
}

#[cfg(test)]
mod tests {
    use super::*;

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
    async fn put_twice_returns_latest_and_is_append_only() {
        let tmp = tempfile::tempdir().unwrap();
        let pool = crate::db::init_db(tmp.path()).await.unwrap();
        seed_account(&pool, "a1").await;

        put_trust_decision(&pool, "a1", "peer@x.com", "smime", "fp1", "unverified", None)
            .await
            .unwrap();
        // Yield so the second row's strftime('%s','now') is >= the first.
        tokio::time::sleep(std::time::Duration::from_secs(1)).await;
        put_trust_decision(&pool, "a1", "peer@x.com", "smime", "fp1", "verified", None)
            .await
            .unwrap();

        let latest = get_latest_trust_decision(&pool, "a1", "peer@x.com", "smime", "fp1")
            .await
            .unwrap()
            .expect("a decision exists");
        assert_eq!(latest.decision, "verified");

        // Append-only: two puts for the same key must yield exactly two rows.
        let (count,): (i64,) = sqlx::query_as(
            "SELECT COUNT(*) FROM trust_decisions WHERE account_id = ? AND peer_email = ? AND standard = ? AND fingerprint = ?",
        )
        .bind("a1")
        .bind("peer@x.com")
        .bind("smime")
        .bind("fp1")
        .fetch_one(&pool)
        .await
        .unwrap();
        assert_eq!(count, 2, "trust_decisions must be append-only (COUNT == 2)");
    }

    #[tokio::test]
    async fn get_latest_returns_none_when_absent() {
        let tmp = tempfile::tempdir().unwrap();
        let pool = crate::db::init_db(tmp.path()).await.unwrap();
        let got = get_latest_trust_decision(&pool, "a1", "nobody@x.com", "smime", "fpX")
            .await
            .unwrap();
        assert!(got.is_none());
    }

    #[tokio::test]
    async fn put_carries_evidence_json() {
        let tmp = tempfile::tempdir().unwrap();
        let pool = crate::db::init_db(tmp.path()).await.unwrap();
        seed_account(&pool, "a1").await;
        put_trust_decision(
            &pool,
            "a1",
            "peer@x.com",
            "smime",
            "fp1",
            "personal",
            Some(r#"{"source":"manual"}"#),
        )
        .await
        .unwrap();
        let latest = get_latest_trust_decision(&pool, "a1", "peer@x.com", "smime", "fp1")
            .await
            .unwrap()
            .unwrap();
        assert_eq!(latest.decision, "personal");
        assert_eq!(latest.evidence_json.as_deref(), Some(r#"{"source":"manual"}"#));
    }
}
