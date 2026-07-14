//! CRL HTTP fetcher with SQLite-backed cache (G4 Task 4).
//!
//! [`fetch_crl_cached`] fetches a CRL (Certificate Revocation List) by URL,
//! caching the raw DER in the Plan-1 `crl_cache` table. The cache is a
//! transport-level optimization: it stores the raw bytes for a fixed TTL
//! (default 24 h) to avoid re-fetching on every signed-message verification.
//! The CRL's own `thisUpdate`/`nextUpdate` validity window is enforced
//! independently by `pkix-revocation::CrlChecker` inside `chain.rs` —
//! a stale CRL that passes the fetcher's TTL but fails the CRL's own
//! `nextUpdate` is caught there and surfaces as a soft-fail `Unchecked`.
//!
//! # Soft-fail posture (spec §0.4)
//!
//! **NEVER block decryption/verification on a network failure.** The fetcher
//! returns `None` on ANY transport error (DNS failure, connection refused,
//! timeout, non-200 status) or parse error (response is not valid DER). The
//! caller (`chain.rs::validate_signer_chain`) treats `None` as soft-fail
//! `RevocationState::Unchecked` — the chain proceeds, and the caller warns.
//!
//! Only a fetched-and-parsed CRL that says **revoked** triggers a hard-fail
//! (`RevocationState::Revoked` + `chain_valid = false`). See `chain.rs` for
//! the hard/soft-fail mapping.
//!
//! # PEM handling
//!
//! CRL distribution points may serve DER (`application/pkix-crl`) or PEM
//! (`-----BEGIN X509 CRL-----`). The fetcher accepts both and normalizes to
//! DER before caching. PEM bodies are base64-decoded via the existing `base64`
//! crate (already a backend dep).

use sqlx::SqlitePool;

use crate::db::crl_cache::{get_crl, upsert_crl, CrlCacheRow};

/// CRL cache TTL in seconds (24 h). A cached entry is considered fresh if
/// `fetched_at + CRL_CACHE_TTL_SECS > now`. After the TTL, the fetcher
/// re-fetches from the network.
///
/// This is distinct from the CRL's own `nextUpdate` (enforced by the
/// `CrlChecker` in `chain.rs`). The TTL bounds how often we hit the network;
/// `nextUpdate` bounds the CRL's own freshness. Both must pass for a CRL to
/// produce a `Good` revocation outcome.
const CRL_CACHE_TTL_SECS: u64 = 24 * 60 * 60;

/// Fetch a CRL by URL, caching in the `crl_cache` table.
///
/// # Flow
///
/// 1. Check `crl_cache` for a fresh entry (`fetched_at + TTL > now`). If fresh,
///    return the cached DER without hitting the network.
/// 2. Otherwise, HTTP GET the URL. On 200, normalize the body to DER (accepting
///    both DER and PEM), cache it with a TTL-based `next_update`, and return
///    the DER.
/// 3. On ANY error (transport, non-200, parse failure) → `None` (soft-fail).
///
/// # Soft-fail contract
///
/// This function NEVER panics and NEVER returns an error. A `None` return means
/// "could not obtain a usable CRL" — the caller treats this as soft-fail
/// (`RevocationState::Unchecked`). This is the spec §0.4 soft-fail-on-transport
/// posture: a network failure must never block message verification.
pub async fn fetch_crl_cached(
    pool: &SqlitePool,
    client: &reqwest::Client,
    crl_url: &str,
) -> Option<Vec<u8>> {
    // Step 1: check cache for a fresh entry.
    if let Ok(Some(row)) = get_crl(pool, crl_url).await {
        if is_fresh(&row) {
            return Some(row.crl_der);
        }
    }

    // Step 2: HTTP GET the CRL distribution point.
    let response = client.get(crl_url).send().await.ok()?;
    if !response.status().is_success() {
        log::debug!(
            "CRL fetch non-200 status {} for {} — soft-fail",
            response.status(),
            crl_url
        );
        return None;
    }
    let bytes = response.bytes().await.ok()?;

    // Normalize to DER (accept DER or PEM). If neither → None (soft-fail).
    let der = normalize_to_der(&bytes)?;

    // Cache with a TTL-based next_update. This is a transport cache expiry,
    // NOT the CRL's own nextUpdate (which the CrlChecker in chain.rs enforces).
    let now_epoch = now_epoch_secs();
    let next_update = now_epoch + CRL_CACHE_TTL_SECS;
    let row = CrlCacheRow {
        crl_url: crl_url.to_string(),
        crl_der: der.clone(),
        issuer_dn: None,
        next_update: Some(next_update.to_string()),
        fetched_at: now_epoch.to_string(),
    };
    // Best-effort cache write: if it fails, we still return the DER; the next
    // call will simply re-fetch. A cache-write failure is not a reason to
    // soft-fail the revocation check.
    if let Err(e) = upsert_crl(pool, &row).await {
        log::warn!("CRL cache write failed for {} — continuing: {e}", crl_url);
    }

    Some(der)
}

/// Check whether a cached CRL row is still within the TTL window.
///
/// `fetched_at + CRL_CACHE_TTL_SECS > now` → fresh. Rows with unparseable
/// `fetched_at` are treated as stale (refetch).
fn is_fresh(row: &CrlCacheRow) -> bool {
    let fetched_at: u64 = match row.fetched_at.parse() {
        Ok(n) => n,
        Err(_) => return false,
    };
    let now = now_epoch_secs();
    fetched_at.saturating_add(CRL_CACHE_TTL_SECS) > now
}

/// Current time as Unix seconds. Saturates to 0 if the clock is before the
/// epoch (impossible in practice, but defensive).
fn now_epoch_secs() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

/// Normalize a CRL response body to DER bytes.
///
/// Accepts:
/// - Raw DER (starts with `0x30` = SEQUENCE tag).
/// - PEM (`-----BEGIN X509 CRL-----` / `-----END X509 CRL-----`), base64-decoded.
///
/// Returns `None` for unrecognized formats. The caller treats `None` as
/// soft-fail.
fn normalize_to_der(bytes: &[u8]) -> Option<Vec<u8>> {
    // DER: starts with SEQUENCE tag (0x30). This is the universal-class,
    // constructed, SEQUENCE tag — every CRL (a CertificateList SEQUENCE)
    // starts with it. PEM: starts with "-----BEGIN".
    if bytes.first() == Some(&0x30) {
        // Likely DER. A more thorough check would attempt a full DER parse,
        // but that requires pulling in x509-cert/x509-parser (not a backend
        // regular dep). The CrlChecker in chain.rs does the real parse and
        // will reject anything malformed. The fetcher's job is just to cache
        // bytes + normalize PEM.
        return Some(bytes.to_vec());
    }
    // Try PEM.
    if let Ok(s) = std::str::from_utf8(bytes) {
        if s.contains("-----BEGIN X509 CRL-----") {
            return pem_crl_to_der(s);
        }
        // Some servers use a generic label.
        if s.contains("-----BEGIN") && s.contains("CRL") {
            return pem_crl_to_der(s);
        }
    }
    None
}

/// Decode a PEM-encoded CRL to DER by stripping the header/footer and
/// base64-decoding the body. Minimal parser — does not validate the PEM
/// label or handle nested PEM blocks (CRL responses are single-block).
fn pem_crl_to_der(pem: &str) -> Option<Vec<u8>> {
    use base64::Engine as _;

    let b64: String = pem
        .lines()
        .filter(|line| !line.starts_with("-----"))
        .collect::<String>()
        .chars()
        .filter(|c| !c.is_whitespace())
        .collect();
    if b64.is_empty() {
        return None;
    }
    base64::engine::general_purpose::STANDARD.decode(b64).ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    use crate::db::crl_cache::CrlCacheRow;
    use crate::db::init_db;

    /// Build a reqwest client for tests. A bare `Client::new()` uses default
    /// settings (no proxy, 30s timeout). For the unreachable-URL test, the
    /// connection is refused at the TCP level, so no timeout is reached.
    fn test_client() -> reqwest::Client {
        reqwest::Client::builder()
            .timeout(std::time::Duration::from_secs(5))
            .build()
            .unwrap_or_else(|_| reqwest::Client::new())
    }

    /// Soft-fail: an unreachable URL (port 1 on loopback — guaranteed connection
    /// refused) must return `None` without panicking. This is the core
    /// spec §0.4 soft-fail-on-transport test.
    #[tokio::test]
    async fn fetch_crl_unreachable_url_returns_none_soft_fail() {
        let tmp = tempfile::tempdir().unwrap();
        let pool = init_db(tmp.path()).await.unwrap();
        let client = test_client();

        // Port 1 on loopback: no listener, TCP RST → connection refused.
        // This exercises the `.send().await.ok()?` → None path.
        let result = fetch_crl_cached(&pool, &client, "http://127.0.0.1:1/crl.der").await;

        assert!(
            result.is_none(),
            "unreachable URL must soft-fail to None, got Some"
        );
    }

    /// Cache hit: a fresh cached entry must be returned WITHOUT hitting the
    /// network. Seeds `crl_cache` with a valid DER + future `next_update`,
    /// then fetches — no network call is made (the test would fail/hang if it
    /// tried to reach the unreachable URL).
    #[tokio::test]
    async fn fetch_crl_cache_hit_returns_cached_without_network() {
        let tmp = tempfile::tempdir().unwrap();
        let pool = init_db(tmp.path()).await.unwrap();
        let client = test_client();

        // Seed a fresh cache entry (next_update well in the future).
        let cached_der = b"\x30\x82\x01\x00fake-crl-der".to_vec();
        let now = now_epoch_secs();
        let row = CrlCacheRow {
            crl_url: "http://127.0.0.1:1/crl.der".to_string(),
            crl_der: cached_der.clone(),
            issuer_dn: None,
            next_update: Some((now + 3600).to_string()),
            fetched_at: now.to_string(),
        };
        upsert_crl(&pool, &row).await.unwrap();

        // Fetch — the URL is unreachable, but the cache should short-circuit
        // before any HTTP call.
        let result = fetch_crl_cached(&pool, &client, "http://127.0.0.1:1/crl.der").await;

        assert_eq!(result, Some(cached_der), "cached entry must be returned");
    }

    /// Cache miss + unreachable: a stale cache entry (past TTL) triggers a
    /// refetch; when the refetch fails (unreachable URL), `None` is returned
    /// (soft-fail). The stale entry is NOT returned.
    #[tokio::test]
    async fn fetch_crl_stale_cache_refetch_fails_returns_none() {
        let tmp = tempfile::tempdir().unwrap();
        let pool = init_db(tmp.path()).await.unwrap();
        let client = test_client();

        let now = now_epoch_secs();
        // Stale entry: fetched_at + TTL is in the past.
        let stale_fetched_at = now.saturating_sub(CRL_CACHE_TTL_SECS + 100);
        let row = CrlCacheRow {
            crl_url: "http://127.0.0.1:1/crl.der".to_string(),
            crl_der: b"\x30\x00stale-crl".to_vec(),
            issuer_dn: None,
            next_update: Some(stale_fetched_at.to_string()),
            fetched_at: stale_fetched_at.to_string(),
        };
        upsert_crl(&pool, &row).await.unwrap();

        // Fetch — stale cache triggers refetch → unreachable → None.
        let result = fetch_crl_cached(&pool, &client, "http://127.0.0.1:1/crl.der").await;

        assert!(
            result.is_none(),
            "stale cache + unreachable must soft-fail to None"
        );
    }

    // ── normalize_to_der unit tests ──

    #[test]
    fn normalize_passthrough_for_der() {
        let der = b"\x30\x82\x01\x00some-crl-data";
        let result = normalize_to_der(der);
        assert_eq!(result.as_deref(), Some(der.as_slice()));
    }

    #[test]
    fn normalize_decodes_pem_crl() {
        // A minimal PEM block. The body is base64 of "hello" (68 65 6c 6c 6f).
        // The CrlChecker will reject this as a real CRL, but the fetcher's job
        // is just to normalize the encoding.
        let pem = b"-----BEGIN X509 CRL-----\naGVsbG8=\n-----END X509 CRL-----\n";
        let result = normalize_to_der(pem);
        assert_eq!(result.as_deref(), Some(b"hello".as_slice()));
    }

    #[test]
    fn normalize_returns_none_for_garbage() {
        assert!(normalize_to_der(b"not a crl").is_none());
        assert!(normalize_to_der(b"").is_none());
        assert!(normalize_to_der(b"\xFF\xFF").is_none());
    }

    // ── is_fresh unit tests ──

    #[test]
    fn is_fresh_true_for_future_expiry() {
        let now = now_epoch_secs();
        let row = CrlCacheRow {
            crl_url: "http://x/crl".into(),
            crl_der: vec![0x30],
            issuer_dn: None,
            next_update: Some((now + 3600).to_string()),
            fetched_at: now.to_string(),
        };
        assert!(is_fresh(&row));
    }

    #[test]
    fn is_fresh_false_for_past_expiry() {
        let now = now_epoch_secs();
        let stale_at = now.saturating_sub(CRL_CACHE_TTL_SECS + 1);
        let row = CrlCacheRow {
            crl_url: "http://x/crl".into(),
            crl_der: vec![0x30],
            issuer_dn: None,
            next_update: Some(stale_at.to_string()),
            fetched_at: stale_at.to_string(),
        };
        assert!(!is_fresh(&row));
    }

    #[test]
    fn is_fresh_false_for_unparseable_fetched_at() {
        let row = CrlCacheRow {
            crl_url: "http://x/crl".into(),
            crl_der: vec![0x30],
            issuer_dn: None,
            next_update: None,
            fetched_at: "garbage".into(),
        };
        assert!(!is_fresh(&row));
    }
}
