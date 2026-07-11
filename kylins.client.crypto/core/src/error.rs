use std::sync::Arc;

/// Type-erased crypto error. Backend-native errors are wrapped here so the
/// core contract exposes exactly one error type across all backends.
#[derive(Debug, Clone, thiserror::Error)]
pub enum CryptoError {
    #[error("crypto backend error: {0}")]
    Backend(Arc<dyn std::error::Error + Send + Sync>),

    #[error("policy rejected algorithm: {0}")]
    Policy(String),

    #[error("key not found: {0}")]
    KeyNotFound(String),

    #[error("unsupported standard: {0}")]
    UnsupportedStandard(String),

    #[error("malformed input: {0}")]
    Malformed(String),

    #[error("not implemented: {0}")]
    NotImplemented(String),
}

impl CryptoError {
    /// Wrap a backend-native error behind the type-erased `Backend` variant.
    pub fn backend<E>(e: E) -> Self
    where
        E: std::error::Error + Send + Sync + 'static,
    {
        CryptoError::Backend(Arc::new(e))
    }
}

pub type Result<T> = std::result::Result<T, CryptoError>;

#[cfg(test)]
mod tests {
    use super::*;

    #[derive(Debug, thiserror::Error)]
    #[error("boom: {0}")]
    struct FakeBackendErr(String);

    #[test]
    fn backend_error_is_type_erased_and_cloneable() {
        let err = CryptoError::backend(FakeBackendErr("detached tag mismatch".into()));
        let cloned = err.clone();
        // Display round-trips through the Arc'd inner error.
        let msg = format!("{cloned}");
        assert!(msg.contains("detached tag mismatch"));
        // It is NOT one of the other variants.
        assert!(!matches!(err, CryptoError::Policy(_)));
    }

    #[test]
    fn not_implemented_variant_displays() {
        let e = CryptoError::NotImplemented("Phase 1b receive".into());
        assert!(format!("{e}").contains("Phase 1b receive"));
        assert!(matches!(e, CryptoError::NotImplemented(_)));
    }
}
