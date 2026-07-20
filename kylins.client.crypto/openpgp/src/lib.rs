//! OpenPGP crypto backend (Sequoia engine). Implements `crypto_core::CryptoBackend`.
//!
//! Task 8 wiring: [`OpenpgpBackend`] adapts the Sequoia engine (Tasks 5–7) to
//! the framework's [`crypto_core::CryptoBackend`] trait via the [`KeyStore`]
//! abstraction. Heavy Sequoia ops run inside [`tokio::task::spawn_blocking`] so
//! the async runtime's worker threads are not blocked by CPU-bound crypto.
//!
//! ## `KeyHandleRef` → `Cert` resolution
//!
//! Every op resolves its [`KeyHandleRef`]s to [`openpgp::Cert`]s via
//! `self.keystore`: `keystore.get(&ref.handle).await?` → `Option<StoredKey>`
//! → [`keymap::parse_certs`] → `Cert`. The PRIVATE blob is preferred for ops
//! that need secret material (decrypt, sign, inline-sign-then-encrypt); the
//! PUBLIC blob suffices for recipient-encrypt + verify. A `None` keystore hit
//! surfaces as [`CryptoError::KeyNotFound`].
//!
//! ## `spawn_blocking` rationale
//!
//! Sequoia's encrypt/decrypt/sign/verify are CPU-bound (public-key crypto +
//! hashing). Running them on a tokio worker thread would degrade the runtime's
//! ability to make progress on other futures (notably, sequential IPC calls).
//! We therefore wrap each heavy op in `tokio::task::spawn_blocking`. To make
//! the closure `'static`, the resolved `Cert`s and a cloned `Arc<PgpPolicy>`
//! are MOVED into the closure (no `&self` borrows cross the boundary).
//!
//! [`CryptoError::KeyNotFound`]: crypto_core::CryptoError::KeyNotFound

pub mod engine;
pub mod error;
pub mod keymap;
pub mod policy;

use async_trait::async_trait;
use crypto_core::{
    CryptoBackend, CryptoError, CryptoPolicy, DecryptedPayload, DecryptOp, EncryptedEnvelope,
    EncryptOp, KeyGenParams, KeyHandle, KeyHandleRef, KeyStore, Result, SecretBox, SignedEnvelope,
    SignOp, Standard, StoredKey, VerificationResult, VerifyOp,
};
use secrecy::ExposeSecret;
use sequoia_openpgp as openpgp;
use std::sync::Arc;

/// OpenPGP `CryptoBackend` adapter.
///
/// Fields:
/// - `keystore`: shared key-material store; resolves `KeyHandleRef` → `Cert`.
/// - `core_policy`: the framework-wide algorithm policy, returned by
///   [`CryptoBackend::policy`].
/// - `pgp_policy`: Sequoia-engine policy bundle (write/read policies + weak-algo
///   detector), derived from `core_policy` once at construction. Held in
///   `Arc` so a cheap clone can be moved into each `spawn_blocking` closure
///   without copying the underlying `StandardPolicy` state.
pub struct OpenpgpBackend {
    keystore: Arc<dyn KeyStore>,
    core_policy: CryptoPolicy,
    pgp_policy: Arc<policy::PgpPolicy>,
}

impl OpenpgpBackend {
    /// Construct a new backend over `keystore` with the framework-wide
    /// `core_policy`. The PGP policy bundle is derived from `core_policy` once
    /// (write/read policies + weak-algo detector) and shared across all calls.
    pub fn new(keystore: Arc<dyn KeyStore>, core_policy: CryptoPolicy) -> Self {
        let pgp_policy = Arc::new(policy::PgpPolicy::from_core(&core_policy));
        Self {
            keystore,
            core_policy,
            pgp_policy,
        }
    }

    /// Resolve a [`KeyHandleRef`] to an [`openpgp::Cert`] via the keystore.
    ///
    /// When `prefer_private` is true, the private blob is preferred (ops that
    /// need secret material — decrypt, sign). When false, the public blob is
    /// used (encrypt recipients, verify signers). If the keystore has no entry
    /// for `handle.handle`, returns [`CryptoError::KeyNotFound`].
    ///
    /// When `prefer_private=true` but the `StoredKey` is public-only
    /// (`private_data == None`), this falls back to the public blob; the engine
    /// call then fails with a clear "no usable signing/encryption subkey"
    /// error surfaced as [`CryptoError::Backend`].
    ///
    /// [`CryptoError::Backend`]: crypto_core::CryptoError::Backend
    /// [`CryptoError::KeyNotFound`]: crypto_core::CryptoError::KeyNotFound
    async fn resolve_cert(
        &self,
        handle: &KeyHandleRef,
        prefer_private: bool,
    ) -> Result<openpgp::Cert> {
        let stored = self.keystore.get(&handle.handle).await?.ok_or_else(|| {
            CryptoError::KeyNotFound(format!("OpenPGP key not found: {}", handle.fingerprint))
        })?;

        let blob: Vec<u8> = if prefer_private {
            stored
                .private_data
                .as_ref()
                .map(|p| p.expose_secret().clone())
                .unwrap_or_else(|| stored.public_data.clone())
        } else {
            stored.public_data.clone()
        };

        let certs = keymap::parse_certs(&blob)?;
        certs.into_iter().next().ok_or_else(|| {
            CryptoError::Malformed(format!(
                "OpenPGP blob for {} contained no certs",
                handle.fingerprint
            ))
        })
    }

    /// Persist a freshly-generated or freshly-imported `Cert` to the keystore
    /// as a [`StoredKey`] (public blob + private blob) and return the canonical
    /// [`KeyHandleRef`] (the one the keystore returns from `put`, which must
    /// match [`keymap::cert_to_handle`]).
    async fn persist_cert(&self, cert: openpgp::Cert) -> Result<KeyHandleRef> {
        let handle = keymap::cert_to_handle(&cert);
        let public_data = keymap::cert_to_public_blob(&cert)?;
        let private_data = keymap::cert_to_secret_blob(&cert)?;
        let stored = StoredKey {
            handle: handle.clone(),
            public_data,
            private_data: Some(SecretBox::new(Box::new(private_data))),
        };
        // `put` returns the canonical handle; for the memory store (and any
        // sane SQLite-backed implementation) this equals `handle`. The returned
        // reference is what the caller retains.
        self.keystore.put(stored).await
    }
}

/// Wrapper to give `tokio::task::JoinError` a `Display + std::error::Error`
/// impl that incorporates the panic payload's message. (JoinError implements
/// `Error` directly, but its `Display` is terse — wrapping here lets us add
/// the "spawn_blocking task" context the framework logs benefit from.)
#[derive(Debug)]
struct JoinErrorWrapper(tokio::task::JoinError);

impl std::fmt::Display for JoinErrorWrapper {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "spawn_blocking task failed: {}", self.0)
    }
}

impl std::error::Error for JoinErrorWrapper {}

/// Map a `tokio::task::JoinError` (panic in a spawned task) to a
/// [`CryptoError::Backend`]. Centralized so every `spawn_blocking` site has
/// the same panic-surfacing shape.
fn map_join_err(e: tokio::task::JoinError) -> CryptoError {
    CryptoError::backend(JoinErrorWrapper(e))
}

#[async_trait]
impl CryptoBackend for OpenpgpBackend {
    fn standard(&self) -> Standard {
        Standard::OpenPgp
    }

    fn policy(&self) -> &CryptoPolicy {
        &self.core_policy
    }

    async fn encrypt(&self, op: EncryptOp<'_>) -> Result<EncryptedEnvelope> {
        // Resolve recipient certs (public blob is sufficient for encryption).
        // Collect into an owned Vec so the spawn_blocking closure is 'static.
        let mut recipient_certs = Vec::with_capacity(op.recipients.len());
        for r in op.recipients {
            recipient_certs.push(self.resolve_cert(r, /* prefer_private */ false).await?);
        }
        // Resolve signer cert (private blob needed for the signing keypair).
        let signer_cert = match op.sign_with.as_ref() {
            Some(s) => Some(self.resolve_cert(s, /* prefer_private */ true).await?),
            None => None,
        };

        let parts: Vec<_> = op.parts.to_vec();
        let serialization = op.serialization;
        let pgp_policy = self.pgp_policy.clone();

        // Run CPU-bound Sequoia encrypt off the tokio worker thread.
        tokio::task::spawn_blocking(move || {
            engine::encrypt(
                &parts,
                serialization,
                &recipient_certs,
                signer_cert.as_ref(),
                &pgp_policy,
            )
        })
        .await
        .map_err(map_join_err)?
    }

    async fn decrypt(&self, op: DecryptOp<'_>) -> Result<DecryptedPayload> {
        let decryption_cert = self
            .resolve_cert(&op.decryption_key, /* prefer_private */ true)
            .await?;

        // Clone the envelope so the closure is 'static. The trait passes
        // `&envelope` tied to the caller's lifetime; `spawn_blocking` cannot
        // borrow from it.
        let envelope = op.envelope.clone();
        let pgp_policy = self.pgp_policy.clone();

        let (payload, _weak_warning) = tokio::task::spawn_blocking(move || {
            engine::decrypt(&envelope, &decryption_cert, &pgp_policy)
        })
        .await
        .map_err(map_join_err)??;

        // Drop the weak-algorithm warning. Surfacing it through
        // `VerificationResult.failure_reason` is reserved for the receive slice
        // (spec §7), which will add a dedicated channel rather than overload
        // the failure-reason string.
        Ok(payload)
    }

    async fn sign(&self, op: SignOp<'_>) -> Result<SignedEnvelope> {
        // Only detached signing is supported in engine-core. Inline signing
        // for its own sake is unnecessary because `encrypt(sign_with=Some(..))`
        // already produces inline-signed ciphertext.
        if !op.detached {
            return Err(error::policy("inline sign not supported in engine-core"));
        }
        let signing_cert = self
            .resolve_cert(&op.signing_key, /* prefer_private */ true)
            .await?;

        let payload: Vec<u8> = op.payload.to_vec();
        let pgp_policy = self.pgp_policy.clone();

        // Move `payload` into the closure; keep a clone for the SignedEnvelope
        // so we don't re-expose `op.payload` (which borrows from the caller).
        let payload_for_envelope = payload.clone();
        let signature = tokio::task::spawn_blocking(move || {
            engine::sign_detached(&payload, &signing_cert, &pgp_policy)
        })
        .await
        .map_err(map_join_err)??;

        Ok(SignedEnvelope {
            standard: Standard::OpenPgp,
            payload: payload_for_envelope,
            signature,
        })
    }

    async fn verify(&self, op: VerifyOp<'_>) -> Result<VerificationResult> {
        // Resolve the signer via the keystore. If absent, pass an empty
        // known_signers slice — `engine::verify_detached` returns `UnknownKey`
        // in that case (engine-core contract; framework-level keyring lookup
        // is the receive slice's concern). We use the public blob here because
        // verify needs only the signing subkey's public material.
        let known_signer: Option<openpgp::Cert> = match self
            .keystore
            .get(&op.signed.signature.signer.handle)
            .await?
        {
            Some(stored) => {
                let certs = keymap::parse_certs(&stored.public_data)?;
                certs.into_iter().next()
            }
            None => None,
        };
        let known_signers: Vec<openpgp::Cert> = match known_signer {
            Some(c) => vec![c],
            None => Vec::new(),
        };

        let payload: Vec<u8> = op.signed.payload.clone();
        let sig = op.signed.signature.clone();
        let pgp_policy = self.pgp_policy.clone();

        tokio::task::spawn_blocking(move || {
            engine::verify_detached(&payload, &sig, &known_signers, &pgp_policy)
        })
        .await
        .map_err(map_join_err)?
    }

    async fn generate_key(&self, params: KeyGenParams) -> Result<KeyHandleRef> {
        if params.standard != Standard::OpenPgp {
            return Err(CryptoError::UnsupportedStandard(format!(
                "OpenpgpBackend.generate_key: expected openpgp, got {}",
                params.standard
            )));
        }
        // Engine-core ships only the default Ed25519/X25519 key shape. RSA
        // generation is not exercised by this slice (the write policy already
        // rejects RSA2048; RSA3072+ generation is reserved for a later slice
        // that also adds a keygen-policy decision tree).
        if params.algorithm != "default" {
            return Err(error::policy(format!(
                "OpenpgpBackend.generate_key: algorithm '{}' not supported in engine-core (use 'default')",
                params.algorithm
            )));
        }
        // `params.passphrase` is intentionally ignored: at-rest protection is
        // the master-key layer's job, not OpenPGP S2K. We surface this
        // explicitly by NOT forwarding the passphrase to `engine::generate`.
        let cert = engine::generate(&params.user_id)?;
        self.persist_cert(cert).await
    }

    async fn import_key(
        &self,
        data: &[u8],
        passphrase: Option<SecretBox<String>>,
    ) -> Result<KeyHandleRef> {
        // Parse + (optional) secret-key decryption. Parse is fast enough to
        // run on the worker thread; a future hardening pass may move this to
        // `spawn_blocking` if benchmarks show meaningful blocking.
        let data: Vec<u8> = data.to_vec();
        let cert = engine::import(&data, passphrase)?;
        self.persist_cert(cert).await
    }

    async fn export_public(&self, handle: &KeyHandle) -> Result<Vec<u8>> {
        let stored = self.keystore.get(handle).await?.ok_or_else(|| {
            CryptoError::KeyNotFound(format!(
                "OpenpgpBackend.export_public: key not found for handle {:?}",
                handle
            ))
        })?;

        let certs = keymap::parse_certs(&stored.public_data)?;
        let cert = certs.into_iter().next().ok_or_else(|| {
            CryptoError::Malformed(
                "OpenpgpBackend.export_public: public blob contained no certs".into(),
            )
        })?;

        engine::export_armored_public(&cert)
    }
}
