//! Secret-material wrappers.
//!
//! `SecretBox<T>` is a heap-allocated, zeroizing secret. Use it for raw key
//! material and session keys that transit the process temporarily. The
//! type-level `Locked` vs `Unlocked` private-key distinction (from
//! proton-crypto-rs) will be introduced in Phase 1 alongside the first
//! concrete `PrivateKey` type.
//!
//! NOTE: In secrecy 0.10 the `Secret` type was replaced by `SecretBox<T>`
//! (which boxes internally). The plan wrote `type SecretBox<T> = Secret<Box<T>>`
//! assuming the older API; we re-export secrecy 0.10's `SecretBox` directly,
//! which is semantically identical.

use secrecy::ExposeSecret;

/// Re-export of secrecy's heap-allocated, zeroizing secret wrapper.
///
/// In secrecy 0.10, `SecretBox<T>` stores a `Box<T>` internally and zeroizes
/// on drop. This is equivalent to the older `Secret<Box<T>>` the plan assumed.
pub use secrecy::SecretBox;

/// View the bytes inside a byte-vector secret.
pub fn expose_bytes(secret: &SecretBox<Vec<u8>>) -> &[u8] {
    secret.expose_secret().as_ref()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn secret_box_holds_and_exposes_bytes() {
        let s: SecretBox<Vec<u8>> = SecretBox::new(Box::new(b"raw-key".to_vec()));
        assert_eq!(expose_bytes(&s), b"raw-key");
    }
}
