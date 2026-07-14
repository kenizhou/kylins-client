use async_trait::async_trait;

use crate::envelope::{
    DecryptedPayload, EncryptedEnvelope, Part, SerializationStrategy, SignedEnvelope,
    VerificationResult,
};
use crate::error::Result;
use crate::handle::{KeyHandle, KeyHandleRef};
use crate::policy::CryptoPolicy;
use crate::secret::SecretBox;
use crate::standard::Standard;

/// Parameters for an encrypt operation.
#[derive(Debug, Clone)]
pub struct EncryptOp<'a> {
    pub parts: &'a [Part],
    pub serialization: SerializationStrategy,
    pub recipients: &'a [KeyHandleRef],
    pub sign_with: Option<KeyHandleRef>,
}

#[derive(Debug, Clone)]
pub struct DecryptOp<'a> {
    pub envelope: &'a EncryptedEnvelope,
    pub decryption_key: KeyHandleRef,
}

#[derive(Debug, Clone)]
pub struct SignOp<'a> {
    pub payload: &'a [u8],
    pub signing_key: KeyHandleRef,
    pub detached: bool,
}

#[derive(Debug, Clone)]
pub struct VerifyOp<'a> {
    pub signed: &'a SignedEnvelope,
}

// NOTE: `Clone` is omitted because `SecretBox<String>` does not implement
// `Clone` in secrecy 0.10 (`String` is not `CloneableSecret`). The plan
// assumed the older secrecy API where `Secret<Box<T>>: Clone` for any
// `T: Clone`. KeyGenParams is consumed by-value by `generate_key` and never
// cloned.
#[derive(Debug)]
pub struct KeyGenParams {
    pub standard: Standard,
    pub user_id: String,
    pub algorithm: String,
    pub passphrase: Option<SecretBox<String>>,
}

/// The contract every standard backend implements. Verification is decoupled
/// from decryption — a message can be "decrypted OK, signature unverified".
///
/// Concrete backends (crypto-openpgp, crypto-smime, crypto-sm) are added in
/// later phases; this phase only proves the trait is usable and object-safe.
#[async_trait]
pub trait CryptoBackend: Send + Sync + 'static {
    fn standard(&self) -> Standard;
    fn policy(&self) -> &CryptoPolicy;

    async fn encrypt(&self, op: EncryptOp<'_>) -> Result<EncryptedEnvelope>;
    async fn decrypt(&self, op: DecryptOp<'_>) -> Result<DecryptedPayload>;
    async fn sign(&self, op: SignOp<'_>) -> Result<SignedEnvelope>;
    async fn verify(&self, op: VerifyOp<'_>) -> Result<VerificationResult>;

    async fn generate_key(&self, params: KeyGenParams) -> Result<KeyHandleRef>;
    async fn import_key(
        &self,
        data: &[u8],
        passphrase: Option<SecretBox<String>>,
    ) -> Result<KeyHandleRef>;
    async fn export_public(&self, handle: &KeyHandle) -> Result<Vec<u8>>;
}

/// A no-op backend used only to prove the trait compiles and is object-safe.
/// Real backends ship in later phases.
#[cfg(test)]
struct NoopBackend {
    policy: CryptoPolicy,
}

#[cfg(test)]
#[async_trait]
impl CryptoBackend for NoopBackend {
    fn standard(&self) -> Standard {
        Standard::OpenPgp
    }
    fn policy(&self) -> &CryptoPolicy {
        &self.policy
    }
    async fn encrypt(&self, _op: EncryptOp<'_>) -> Result<EncryptedEnvelope> {
        Err(crate::error::CryptoError::Malformed("noop backend".into()))
    }
    async fn decrypt(&self, _op: DecryptOp<'_>) -> Result<DecryptedPayload> {
        Err(crate::error::CryptoError::Malformed("noop backend".into()))
    }
    async fn sign(&self, _op: SignOp<'_>) -> Result<SignedEnvelope> {
        Err(crate::error::CryptoError::Malformed("noop backend".into()))
    }
    async fn verify(&self, _op: VerifyOp<'_>) -> Result<VerificationResult> {
        Err(crate::error::CryptoError::Malformed("noop backend".into()))
    }
    async fn generate_key(&self, _p: KeyGenParams) -> Result<KeyHandleRef> {
        Err(crate::error::CryptoError::Malformed("noop backend".into()))
    }
    async fn import_key(&self, _d: &[u8], _p: Option<SecretBox<String>>) -> Result<KeyHandleRef> {
        Err(crate::error::CryptoError::Malformed("noop backend".into()))
    }
    async fn export_public(&self, _h: &KeyHandle) -> Result<Vec<u8>> {
        Err(crate::error::CryptoError::Malformed("noop backend".into()))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn trait_is_object_safe_and_callable() {
        let backend: Box<dyn CryptoBackend> = Box::new(NoopBackend {
            policy: CryptoPolicy::default_baseline(),
        });
        assert_eq!(backend.standard(), Standard::OpenPgp);
        assert_eq!(backend.policy().min_rsa_bits, 3072);
        // Object-safe dispatch through the trait object.
        let op = SignOp {
            payload: b"",
            signing_key: KeyHandleRef {
                handle: KeyHandle::Software(crate::ids::KeyId("k".into())),
                standard: Standard::OpenPgp,
                fingerprint: crate::ids::Fingerprint::new("aa"),
                usage: crate::handle::KeyUsage::Sign,
                algorithm: "Ed25519".into(),
            },
            detached: true,
        };
        let res = backend.sign(op).await;
        assert!(res.is_err(), "noop backend always errors");
    }
}
