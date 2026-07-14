//! Neutral, engine-free crypto abstractions for the Kylins crypto framework.
//!
//! This crate defines the shared contract that every standard backend
//! (OpenPGP, S/MIME, 国密) and every key source (software, PKCS#11 token)
//! implements. It depends on NO cryptographic engine — only serde,
//! async-trait, thiserror, secrecy, zeroize, and subtle — so it compiles
//! standalone and lets the application hold one message type regardless of
//! backend.

pub mod backend;
pub mod envelope;
pub mod error;
pub mod handle;
pub mod ids;
pub mod keystore;
pub mod policy;
pub mod secret;
pub mod standard;
pub mod trust;
pub mod util;

pub use backend::{CryptoBackend, DecryptOp, EncryptOp, KeyGenParams, SignOp, VerifyOp};
pub use envelope::{
    DecryptedPayload, DetachedSignature, EncryptedEnvelope, EncryptedPart, KeyPacketRef, Part,
    PartId, PartKind, SerializationStrategy, SignatureState, SignedEnvelope, VerificationResult,
};
pub use error::{CryptoError, Result};
pub use handle::{KeyHandle, KeyHandleRef, KeyUsage};
pub use ids::{Fingerprint, KeyId, TokenKeyId};
pub use keystore::{KeyStore, StoredKey};
pub use policy::{
    AeadAlgorithm, CryptoPolicy, DosLimits, HashAlgorithm, PkAlgorithm, SymmetricAlgorithm,
};
pub use secret::SecretBox;
pub use standard::Standard;
pub use trust::TrustState;
pub use util::constant_time_eq;
