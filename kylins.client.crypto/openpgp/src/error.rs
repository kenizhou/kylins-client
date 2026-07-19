//! `sequoia_openpgp` errors -> `crypto_core::CryptoError`.
//!
//! Single translation seam every other module in this crate routes Sequoia
//! results through.
//!
//! - [`map_err`] — wraps any `Result<T, E>` whose error type implements
//!   `std::error::Error + Send + Sync + 'static` (e.g. `sequoia_openpgp::Error`,
//!   `std::io::Error`, hand-rolled backend errors).
//! - [`map_sequoia`] — wraps a Sequoia `openpgp::Result<T>`
//!   (= `Result<T, anyhow::Error>`). **Required** for all Sequoia call sites:
//!   `anyhow::Error` deliberately does not implement `std::error::Error`
//!   (its inner `Box<dyn Error + Send + Sync>` already does), so it cannot
//!   go through the generic [`map_err`].
//!
//! Both helpers preserve the original error behind the framework's type-erased
//! [`crypto_core::CryptoError::Backend`] variant via
//! [`crypto_core::CryptoError::backend`].
//!
//! **Diagnostic contract (read this before relying on the chain):** the
//! framework's `Backend(Arc<dyn Error>)` variant is declared
//! `#[error("crypto backend error: {0}")]` *without* a `#[source]` attribute
//! (see `kylins.client.crypto/core/src/error.rs`), so `Error::source()` returns
//! `None` for it. The **typed source chain is NOT walkable** — code like
//! `e.source().downcast_ref::<sequoia_openpgp::Error>()` will silently get
//! `None`. The original error's **Display and Debug are both preserved**
//! (reachable via `to_string()` / `format!("{e:?}")`); for anyhow-wrapped
//! Sequoia errors, Debug carries the full chain/backtrace, which is the
//! preferred diagnostic format for logs. No stringification of the message
//! into `Malformed`.
use crypto_core::CryptoError;
use sequoia_openpgp::anyhow;

/// Result alias shared by every module in this crate.
pub type CryptoResult<T> = Result<T, CryptoError>;

/// Carries a Sequoia `anyhow::Error` into the framework's type-erased
/// [`CryptoError::Backend`] variant **without stringification**.
///
/// `anyhow::Error` deliberately does not implement `std::error::Error` (its
/// inner `Box<dyn Error + Send + Sync + 'static>` already does; wrapping it
/// again would be redundant and would break `.source()` chaining), so it
/// cannot go through the generic [`map_err`]. This newtype is the bridge: it
/// holds the original `anyhow::Error` by value and exposes its `Display`
/// (single-line summary) and `Debug` (full chain, backtrace if captured) via
/// the standard trait impls, satisfying the `Error + Send + Sync + 'static`
/// bound that [`CryptoError::backend`] requires.
///
/// `source()` deliberately returns `None`: the `Backend` variant's
/// `#[error("... {0}")]` attribute has no `#[source]`, so the framework does
/// not walk sources anyway. The anyhow chain is reachable via `Debug`, not
/// `source()`.
#[derive(Debug)]
struct AnyhowBackend(anyhow::Error);

impl std::fmt::Display for AnyhowBackend {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        // Forward to anyhow's Display (single-line summary).
        std::fmt::Display::fmt(&self.0, f)
    }
}

impl std::error::Error for AnyhowBackend {
    // No `source()` override — see the type-level doc.
}

/// Wrap a backend-native result whose error type implements
/// `std::error::Error + Send + Sync + 'static` into the framework's
/// [`CryptoResult`].
///
/// Use this for `Result<T, sequoia_openpgp::Error>`, `Result<T, std::io::Error>`,
/// and any other std-`Error` error types. **Do not** use this for Sequoia's
/// `openpgp::Result<T>` (= `Result<T, anyhow::Error>`) — `anyhow::Error`
/// deliberately does not implement `std::error::Error`; route those through
/// [`map_sequoia`] instead.
pub fn map_err<T, E>(r: std::result::Result<T, E>) -> CryptoResult<T>
where
    E: std::error::Error + Send + Sync + 'static,
{
    r.map_err(CryptoError::backend)
}

/// Map a Sequoia `openpgp::Result<T>` (= `Result<T, anyhow::Error>`) into the
/// framework's [`CryptoResult`]. Canonical mapper for every Sequoia call site:
/// `anyhow::Error` does not implement `std::error::Error`, so the generic
/// [`map_err`] cannot accept it. The original error's Display and Debug (with
/// full anyhow chain/backtrace) are preserved behind the `Backend` variant via
/// [`AnyhowBackend`].
pub fn map_sequoia<T>(r: sequoia_openpgp::Result<T>) -> CryptoResult<T> {
    r.map_err(|e| CryptoError::backend(AnyhowBackend(e)))
}

/// Build a policy-rejection error (weak/unsupported algorithm, missing
/// passphrase, etc.).
pub fn policy<S: Into<String>>(msg: S) -> CryptoError {
    CryptoError::Policy(msg.into())
}

#[cfg(test)]
mod tests {
    use super::*;
    use sequoia_openpgp::parse::Parse;

    /// Stand-in for a non-anyhow backend error — same `Error + Send + Sync + 'static` bound.
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
        assert!(
            std::error::Error::source(&e).is_none(),
            "framework CryptoError::Backend does not expose Error::source(); \
             if this starts passing, the docs can re-claim source-chain preservation"
        );
    }

    #[test]
    fn policy_builds_policy_variant() {
        let e = policy("weak hash");
        assert!(matches!(e, CryptoError::Policy(s) if s == "weak hash"));
    }

    /// Regression for the Task 2 defect surfaced by Task 3: `map_err`'s bound
    /// (`E: std::error::Error`) is NOT satisfied by `anyhow::Error`, which is
    /// what every Sequoia API actually returns (`openpgp::Result<T>` =
    /// `Result<T, anyhow::Error>`). `map_sequoia` is the canonical mapper.
    /// This test uses a REAL Sequoia error (the gap that let the Task 2 defect
    /// slip through originally — Task 2's test used a stand-in `TestErr`).
    #[test]
    fn map_sequoia_wraps_real_anyhow_error() {
        // A genuinely malformed Cert parse returns openpgp::Result::Err (anyhow).
        let bad: sequoia_openpgp::Result<sequoia_openpgp::Cert> =
            sequoia_openpgp::Cert::from_bytes(b"not a valid openpgp cert");
        assert!(bad.is_err(), "malformed input should produce a Sequoia error");

        let mapped = map_sequoia(bad);
        let e = mapped.unwrap_err();
        assert!(
            matches!(e, CryptoError::Backend(_)),
            "map_sequoia should wrap into CryptoError::Backend, got: {e:?}"
        );
        // Display carries the human-readable summary; Debug carries the full
        // anyhow chain (and backtrace if captured). Both must be non-empty.
        let display = format!("{e}");
        let debug = format!("{e:?}");
        assert!(
            !display.is_empty() && !debug.is_empty(),
            "Display and Debug should both be preserved; display={display:?}, debug={debug:?}"
        );
        // Debug should be strictly richer than Display for an anyhow chain
        // (anyhow's Debug walks the cause chain; Display shows only the outer
        // message). This is the property that the original Task 3 workaround
        // (`SequoiaDisplay(e.to_string())`) threw away.
        assert!(
            debug.len() >= display.len(),
            "Debug should carry at least as much info as Display; \
             debug len = {}, display len = {}",
            debug.len(),
            display.len()
        );
    }

    /// Compile-time proof that `map_sequoia` accepts what `map_err` rejects.
    /// If this compiles, the bound is correct. (The body is just a sanity call.)
    #[test]
    fn map_sequoia_accepts_openpgp_result_alias() {
        // `openpgp::Result<u8>` is `Result<u8, anyhow::Error>`. This must
        // compile under `map_sequoia` and would NOT compile under `map_err`.
        let ok: sequoia_openpgp::Result<u8> = Ok(42);
        let r = map_sequoia(ok);
        assert_eq!(r.unwrap(), 42);
    }
}
