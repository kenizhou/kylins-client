//! In-memory `KeyStore` for OpenPGP backend integration tests.
//!
//! Backed by a `Mutex<HashMap<KeyHandle, StoredKey>>`. Sufficient for the
//! engine-core round-trip tests in `tests/round_trip.rs` (single-threaded
//! `#[tokio::test]` drivers, no persistence required).
//!
//! `find_by_email` returns `Ok(vec![])` — it is not exercised by the engine-core
//! round-trips (the backend resolves keys by `KeyHandle` only). A persistence
//! backend with email lookup lands in the receive/sync slice.

use async_trait::async_trait;
use crypto_core::{
    KeyHandle, KeyHandleRef, KeyStore, Result, Standard, StoredKey,
};
use secrecy::{ExposeSecret, SecretBox};
use sequoia_openpgp as openpgp;
use std::collections::HashMap;
use std::sync::Mutex;

/// Memory-backed `KeyStore`. Keyed by `KeyHandle` (the canonical lookup key
/// per the framework's `KeyStore::get` signature).
pub struct MemoryKeyStore {
    inner: Mutex<HashMap<KeyHandle, StoredKey>>,
}

impl MemoryKeyStore {
    pub fn new() -> Self {
        Self {
            inner: Mutex::new(HashMap::new()),
        }
    }

    /// Convenience helper for tests: serialize + store a Cert's full material
    /// (public blob + private blob) under its canonical KeyHandleRef, returning
    /// the handle. Mirrors the construction path that `OpenpgpBackend`'s
    /// `generate_key` / `import_key` use.
    ///
    /// Exposed so the round-trip tests can seed the keystore for cases that
    /// need to call `decrypt` / `sign` / `export_public` directly without
    /// first routing through `generate_key` (e.g. when feeding in a Cert
    /// produced by `engine::generate` for a focused unit-style test).
    pub fn put_cert(&self, cert: &openpgp::Cert) -> Result<KeyHandleRef> {
        let handle = crypto_openpgp::keymap::cert_to_handle(cert);
        let public_data = crypto_openpgp::keymap::cert_to_public_blob(cert)?;
        let private_data = crypto_openpgp::keymap::cert_to_secret_blob(cert)?;
        let stored = StoredKey {
            handle: handle.clone(),
            public_data,
            private_data: Some(SecretBox::new(Box::new(private_data))),
        };
        let mut guard = self.inner.lock().expect("MemoryKeyStore mutex poisoned");
        guard.insert(stored.handle.handle.clone(), stored);
        Ok(handle)
    }

    /// Convenience helper: parse the stored blob for `handle` back into a Cert.
    /// Uses the private blob when present (matches the backend's
    /// private-preferred resolution), else the public blob. Returns `None` if
    /// the handle is not in the store.
    pub fn get_cert(&self, handle: &KeyHandle) -> Option<openpgp::Cert> {
        let guard = self.inner.lock().expect("MemoryKeyStore mutex poisoned");
        let stored = guard.get(handle)?;
        let blob: Vec<u8> = stored
            .private_data
            .as_ref()
            .map(|s| s.expose_secret().clone())
            .unwrap_or_else(|| stored.public_data.clone());
        let certs = crypto_openpgp::keymap::parse_certs(&blob).ok()?;
        certs.into_iter().next()
    }
}

impl Default for MemoryKeyStore {
    fn default() -> Self {
        Self::new()
    }
}

#[async_trait]
impl KeyStore for MemoryKeyStore {
    async fn put(&self, key: StoredKey) -> Result<KeyHandleRef> {
        let mut guard = self.inner.lock().expect("MemoryKeyStore mutex poisoned");
        // Index by the KeyHandle embedded in the KeyHandleRef. `put` returns
        // the canonical `KeyHandleRef` for downstream retention.
        let handle_ref = key.handle.clone();
        guard.insert(key.handle.handle.clone(), key);
        Ok(handle_ref)
    }

    async fn get(&self, handle: &KeyHandle) -> Result<Option<StoredKey>> {
        let guard = self.inner.lock().expect("MemoryKeyStore mutex poisoned");
        // `StoredKey` owns a `SecretBox<Vec<u8>>` (not Clone in secrecy 0.10
        // for non-`CloneableSecret` targets). We clone the public data + handle
        // metadata and reconstruct the private field by re-wrapping the
        // exposed bytes. This is test-only code; the real SQLite-backed store
        // re-reads the bytes from disk.
        let stored = guard.get(handle);
        Ok(stored.map(|s| StoredKey {
            handle: s.handle.clone(),
            public_data: s.public_data.clone(),
            private_data: s.private_data.as_ref().map(|p| {
                let bytes = p.expose_secret().clone();
                SecretBox::new(Box::new(bytes))
            }),
        }))
    }

    async fn find_by_email(&self, _standard: Standard, _email: &str) -> Result<Vec<KeyHandleRef>> {
        // Email indexing is the receive/sync slice's concern. Returning an
        // empty Vec is the documented contract for the memory store; no
        // engine-core round-trip exercises this path.
        Ok(Vec::new())
    }

    async fn remove(&self, handle: &KeyHandle) -> Result<()> {
        let mut guard = self.inner.lock().expect("MemoryKeyStore mutex poisoned");
        guard.remove(handle);
        Ok(())
    }
}
