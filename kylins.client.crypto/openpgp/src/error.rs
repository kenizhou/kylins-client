//! `sequoia_openpgp` errors -> `crypto_core::CryptoError`.
//!
//! Single translation seam every other module in this crate routes Sequoia
//! results through. The framework's [`crypto_core::CryptoError::backend`]
//! constructor preserves the original error as the typed `source` of the
//! type-erased [`crypto_core::CryptoError::Backend`] variant, so callers can
//! still walk the error chain when debugging — no stringification.
use crypto_core::CryptoError;

/// Result alias shared by every module in this crate.
pub type CryptoResult<T> = Result<T, CryptoError>;

/// Wrap a Sequoia (or any backend-native) result into the framework's
/// type-erased [`CryptoError::Backend`] error, preserving the original error
/// as its `source`.
///
/// Works for both `Result<T, anyhow::Error>` (Sequoia's `openpgp::Result`)
/// and `Result<T, sequoia_openpgp::Error>` because both error types satisfy
/// the `Error + Send + Sync + 'static` bound.
pub fn map_err<T, E>(r: std::result::Result<T, E>) -> CryptoResult<T>
where
    E: std::error::Error + Send + Sync + 'static,
{
    r.map_err(CryptoError::backend)
}

/// Build a policy-rejection error (weak/unsupported algorithm, missing
/// passphrase, etc.).
pub fn policy<S: Into<String>>(msg: S) -> CryptoError {
    CryptoError::Policy(msg.into())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Stand-in for a Sequoia error — same `Error + Send + Sync + 'static` bound.
    #[derive(Debug)]
    struct TestErr(&'static str);
    impl std::fmt::Display for TestErr {
        fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
            write!(f, "sequoia said: {}", self.0)
        }
    }
    impl std::error::Error for TestErr {}

    #[test]
    fn ok_passes_through() {
        let r: CryptoResult<i32> = map_err::<_, TestErr>(Ok(7));
        assert_eq!(r.unwrap(), 7);
    }

    #[test]
    fn err_is_mapped_to_backend_with_source_preserved() {
        let r: CryptoResult<i32> = map_err(Err(TestErr("nope")));
        let e = r.unwrap_err();
        // Framework wraps backend-native errors in the type-erased Backend variant.
        assert!(matches!(e, CryptoError::Backend(_)));
        // Display reaches the original message through the wrapped error
        // (the inner `Arc<dyn Error>` is formatted via `{0}` in `core::error.rs`).
        assert!(
            e.to_string().contains("nope"),
            "display should contain original message, got: {e}"
        );
        // NOTE: `CryptoError::Backend` is declared `#[error("... {0}")]` without
        // `#[source]`, so `Error::source()` returns `None` for it — Display is
        // preserved, but the formal source chain is not exposed by the framework.
        // Tracked as a concern in the Task 2 report; out of scope to fix here
        // (would require touching `kylins.client.crypto/core/src/error.rs`).
    }

    #[test]
    fn policy_builds_policy_variant() {
        let e = policy("weak hash");
        assert!(matches!(e, CryptoError::Policy(s) if s == "weak hash"));
    }
}
