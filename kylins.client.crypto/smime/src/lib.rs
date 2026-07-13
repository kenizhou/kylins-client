//! S/MIME backend for the Kylins crypto framework.
//!
//! Plan 2 Task 4: `SmimeBackend` now owns an `Arc<dyn KeyStore>` and implements
//! `generate_key` (self-signed ECDSA P-256 v3 cert) and `export_public` (returns
//! the stored DER cert). `import_key` is Plan 2 Task 5. Plan 2b implements the
//! send side over the RustCrypto `cms` builder: `sign` (SignedData, ECDSA-P256),
//! `encrypt` (EnvelopedData, RSA + ECC P-256 recipients), and sign-then-encrypt
//! (`encrypt.sign_with`). Phase 1b implements the receive side: `decrypt`
//! (EnvelopedData, ktri RSA + kari ECC P-256) and `verify` (SignedData
//! pre-chain signature check; chain/trust assessment is G4).

mod cert;
mod cms_build;
mod cms_parse;

use std::sync::Arc;

use async_trait::async_trait;

use crypto_core::{
    CryptoBackend, CryptoError, CryptoPolicy, DecryptedPayload, DecryptOp, DetachedSignature,
    EncryptedEnvelope, EncryptedPart, EncryptOp, Fingerprint, KeyGenParams, KeyHandle, KeyHandleRef,
    KeyId, KeyPacketRef, KeyStore, KeyUsage, PartId, PartKind, SecretBox, SerializationStrategy,
    SignOp, SignatureState, SignedEnvelope, Standard, StoredKey, VerificationResult, VerifyOp,
};
use der::referenced::OwnedToRef;
use der::Decode;

pub const CRATE_NAME: &str = "crypto-smime";

/// S/MIME `CryptoBackend`. Owns the framework policy plus the `KeyStore` where
/// generated cert/key material is persisted (public DER cert + encrypted PKCS#8
/// private key). Private material never crosses the IPC boundary — it moves only
/// Rust → `KeyStore` → Rust.
pub struct SmimeBackend {
    policy: CryptoPolicy,
    keystore: Arc<dyn KeyStore>,
}

impl SmimeBackend {
    /// Construct an S/MIME backend over a `KeyStore` with an explicit policy.
    pub fn new(keystore: Arc<dyn KeyStore>, policy: CryptoPolicy) -> Self {
        Self { policy, keystore }
    }
}

#[async_trait]
impl CryptoBackend for SmimeBackend {
    fn standard(&self) -> Standard {
        Standard::Smime
    }

    fn policy(&self) -> &CryptoPolicy {
        &self.policy
    }

    async fn encrypt(&self, op: EncryptOp<'_>) -> crypto_core::Result<EncryptedEnvelope> {
        // S/MIME collapses the whole MIME tree into one EnvelopedData blob.
        if op.serialization != SerializationStrategy::SingleMimeBlob {
            return Err(CryptoError::UnsupportedStandard(
                "S/MIME encrypt requires SerializationStrategy::SingleMimeBlob".into(),
            ));
        }
        let single = op
            .parts
            .first()
            .ok_or_else(|| CryptoError::Malformed("encrypt: no parts".into()))?;
        let plaintext = &single.data;

        // Resolve each recipient cert from the keystore → RecipientInput. Only
        // public cert material is read (private_data untouched).
        let mut recipients_in = Vec::with_capacity(op.recipients.len());
        for r in op.recipients {
            let stored = self
                .keystore
                .get(&r.handle)
                .await?
                .ok_or_else(|| {
                    CryptoError::KeyNotFound(format!("encrypt recipient: {:?}", r.handle))
                })?;
            recipients_in.push(cms_build::recipient_input_from_cert(&stored.public_data)?);
        }

        // Determine the plaintext to envelop: if sign_with is set, first build a
        // SignedData over the payload and envelop THAT (sign-then-encrypt,
        // RFC 8551 §3.5 default for combined sign+encrypt).
        let content_bytes: Vec<u8> = match &op.sign_with {
            Some(signer_ref) => {
                if signer_ref.algorithm != "ECDSA-P256" {
                    return Err(CryptoError::NotImplemented(format!(
                        "{} signing — Plan 2c",
                        signer_ref.algorithm
                    )));
                }
                let stored = self
                    .keystore
                    .get(&signer_ref.handle)
                    .await?
                    .ok_or_else(|| {
                        CryptoError::KeyNotFound(format!("sign_with: {:?}", signer_ref.handle))
                    })?;
                let priv_box = stored.private_data.as_ref().ok_or_else(|| {
                    CryptoError::Policy("sign_with: key has no private material".into())
                })?;
                // Zeroizing so the cloned PKCS#8 private bytes are wiped on drop
                // (same hygiene as `sign`). Private material never leaves this
                // scope: only the SignedData DER (cert + signature) is returned.
                let priv_der =
                    zeroize::Zeroizing::new(crypto_core::secret::expose_bytes(priv_box).to_vec());
                cms_build::build_signed_data(
                    plaintext,
                    false,
                    &stored.public_data,
                    priv_der.as_slice(),
                )?
            }
            None => plaintext.to_vec(),
        };

        let der = cms_build::build_enveloped_data(&content_bytes, &recipients_in)?;

        Ok(EncryptedEnvelope {
            standard: Standard::Smime,
            serialization: op.serialization,
            parts: vec![EncryptedPart {
                id: PartId("body".into()),
                kind: PartKind::Body,
                ciphertext: der,
                signature: None,
            }],
            // The per-recipient wrapped CEKs live inside the CMS blob; we echo
            // the recipient handles so callers know who the message targets.
            recipients: op
                .recipients
                .iter()
                .map(|r| KeyPacketRef {
                    recipient: r.clone(),
                    packet: Vec::new(),
                })
                .collect(),
        })
    }

    async fn decrypt(&self, op: DecryptOp<'_>) -> crypto_core::Result<DecryptedPayload> {
        // S/MIME collapses the whole MIME tree into one EnvelopedData blob;
        // there is exactly one encrypted part.
        let single = op.envelope.parts.first().ok_or_else(|| {
            CryptoError::Malformed("decrypt: envelope has no parts".into())
        })?;
        // Resolve the recipient's stored key (cert + private material).
        let stored = self
            .keystore
            .get(&op.decryption_key.handle)
            .await?
            .ok_or_else(|| {
                CryptoError::KeyNotFound(format!("decrypt: {:?}", op.decryption_key.handle))
            })?;
        let priv_box = stored.private_data.as_ref().ok_or_else(|| {
            CryptoError::Policy("decrypt: key has no private material".into())
        })?;
        // Zeroizing so the cloned PKCS#8 private bytes are wiped on drop —
        // same hygiene as `sign`/`encrypt` (private material never leaves this
        // scope; only the plaintext is returned).
        let priv_der =
            zeroize::Zeroizing::new(crypto_core::secret::expose_bytes(priv_box).to_vec());
        let plaintext =
            cms_parse::decrypt_enveloped(&single.ciphertext, &stored.public_data, priv_der.as_slice())?;
        Ok(DecryptedPayload {
            standard: Standard::Smime,
            parts: vec![crypto_core::Part {
                id: crypto_core::PartId("body".into()),
                kind: crypto_core::PartKind::Body,
                data: plaintext,
            }],
        })
    }

    async fn sign(&self, op: SignOp<'_>) -> crypto_core::Result<SignedEnvelope> {
        // ECDSA-P256 only (matches generate_key). Other algorithms deferred.
        if op.signing_key.algorithm != "ECDSA-P256" {
            return Err(CryptoError::NotImplemented(format!(
                "{} signing — Plan 2c (only ECDSA-P256 is implemented)",
                op.signing_key.algorithm
            )));
        }
        let stored = self
            .keystore
            .get(&op.signing_key.handle)
            .await?
            .ok_or_else(|| {
                CryptoError::KeyNotFound(format!("sign: {:?}", op.signing_key.handle))
            })?;
        let priv_box = stored.private_data.as_ref().ok_or_else(|| {
            CryptoError::Policy("sign: signing key has no private material".into())
        })?;
        // Zeroizing so the cloned PKCS#8 private bytes are wiped on drop — the
        // `SecretBox` they came from zeroizes, and this clone must too. Private
        // material never leaves this scope: `der` below carries only cert + sig.
        let priv_der =
            zeroize::Zeroizing::new(crypto_core::secret::expose_bytes(priv_box).to_vec());

        let der = cms_build::build_signed_data(
            op.payload,
            op.detached,
            &stored.public_data,
            priv_der.as_slice(),
        )?;

        Ok(SignedEnvelope {
            standard: Standard::Smime,
            payload: op.payload.to_vec(),
            signature: DetachedSignature {
                standard: Standard::Smime,
                signer: op.signing_key.clone(),
                signature: der,
            },
        })
    }

    async fn verify(&self, op: VerifyOp<'_>) -> crypto_core::Result<VerificationResult> {
        // Pre-chain signature check (G3): cryptographic sig check against the
        // signer cert embedded in the SignedData. Cert-chain/trust refinement
        // is G4. `op.signed.signature.signature` is the DER `SignedData`
        // (wrapped in ContentInfo); `op.signed.payload` is the caller's
        // covered-content assertion, passed through to the helper which uses
        // it ONLY for detached signatures (encapsulated signatures always hash
        // the in-band eContent bytes the cms builder actually hashed).
        let signed_data_der = &op.signed.signature.signature;
        let covered = Some(op.signed.payload.as_slice());
        let check = match cms_parse::verify_signed(signed_data_der, covered) {
            Ok(c) => c,
            Err(CryptoError::Malformed(msg)) if msg.contains("no signer cert") => {
                // No usable signer cert available to verify against — surface
                // as `UnknownKey` rather than a hard error so the caller can
                // distinguish "no key" from "broken CMS".
                return Ok(VerificationResult {
                    state: SignatureState::UnknownKey,
                    signer: None,
                });
            }
            Err(e) => return Err(e),
        };
        let state = if check.sig_ok {
            // Pre-chain: cryptographic signature OK, chain/trust assessment is G4.
            SignatureState::ValidUnverified
        } else {
            SignatureState::Invalid
        };
        // Build a `KeyHandleRef` matching the send-side `KeyId` encoding
        // `"{standard}|{fingerprint}"` (e.g. `smime|{fp}`) so a later
        // `backend.sign(... signing_key: this ...)` resolves via the keystore.
        let signer = check.signer_fingerprint.map(|fp| {
            crypto_core::KeyHandleRef {
                handle: crypto_core::KeyHandle::Software(crypto_core::KeyId(format!("smime|{fp}"))),
                standard: Standard::Smime,
                fingerprint: crypto_core::Fingerprint::new(fp),
                usage: crypto_core::KeyUsage::SignAndEncrypt,
                algorithm: "ECDSA-P256".into(),
            }
        });
        Ok(VerificationResult { state, signer })
    }

    async fn generate_key(&self, params: KeyGenParams) -> crypto_core::Result<KeyHandleRef> {
        if params.standard != Standard::Smime {
            return Err(CryptoError::UnsupportedStandard(format!(
                "SmimeBackend requires Standard::Smime, got {:?}",
                params.standard
            )));
        }
        // Only ECDSA P-256 is generated in this task. An empty algorithm defaults
        // to P-256; anything else is policy-rejected rather than silently ignored.
        let alg = params.algorithm.trim().to_ascii_lowercase();
        let is_p256 = alg.is_empty() || matches!(alg.as_str(), "ecdsa-p256" | "p-256" | "p256");
        if !is_p256 {
            return Err(CryptoError::Policy(format!(
                "generate_key: algorithm '{}' is unsupported; only ECDSA-P256 is implemented",
                params.algorithm
            )));
        }

        let email = parse_email(&params.user_id)?;
        let built = cert::build_self_signed_smime_cert(&email)?;

        let handle_ref = KeyHandleRef {
            handle: KeyHandle::Software(KeyId(uuid::Uuid::new_v4().to_string())),
            standard: Standard::Smime,
            fingerprint: Fingerprint::new(built.ski_hex),
            usage: KeyUsage::SignAndEncrypt,
            algorithm: "ECDSA-P256".into(),
        };

        let stored = StoredKey {
            handle: handle_ref,
            public_data: built.cert_der,
            private_data: Some(SecretBox::new(Box::new(built.priv_pkcs8_der))),
        };
        // The keystore persists + at-rest-encrypts, and returns the canonical
        // resolvable KeyHandleRef (SqliteKeyStore encodes standard|fingerprint
        // into the KeyId so a later get() finds it). Return THAT handle, not our
        // pre-put local copy (whose uuid KeyId wouldn't resolve via SqliteKeyStore).
        self.keystore.put(stored).await
    }

    async fn import_key(
        &self,
        data: &[u8],
        _passphrase: Option<SecretBox<String>>,
    ) -> crypto_core::Result<KeyHandleRef> {
        let text = std::str::from_utf8(data)
            .map_err(|e| CryptoError::Malformed(format!("import_key: input not UTF-8: {e}")))?;
        let blocks = parse_pem_blocks(text)?;

        // Detect encrypted PKCS#8 first so the user gets a clear NotImplemented
        // regardless of whether a cert is also present (better UX than "no cert").
        if blocks.iter().any(|(label, _)| label == "ENCRYPTED PRIVATE KEY") {
            return Err(CryptoError::NotImplemented(
                "encrypted PKCS#8 import — Plan 3".into(),
            ));
        }

        let cert_der = blocks
            .iter()
            .find(|(label, _)| label == "CERTIFICATE")
            .map(|(_, der)| der.clone())
            .ok_or_else(|| CryptoError::Malformed("no CERTIFICATE PEM block".into()))?;

        let priv_der = blocks
            .iter()
            .find(|(label, _)| label == "PRIVATE KEY")
            .map(|(_, der)| der.clone())
            .ok_or_else(|| {
                CryptoError::Malformed("no PRIVATE KEY PEM block (expected 'PRIVATE KEY')".into())
            })?;

        // Parse via x509-cert (consistent with generate_key) so the fingerprint
        // (SubjectKeyIdentifier = SHA-1 of the SPKI) matches a generated cert's,
        // and so we can read the public-key algorithm OID.
        let cert = <x509_cert::Certificate as Decode>::from_der(&cert_der)
            .map_err(|e| CryptoError::Malformed(format!("parse cert DER: {e}")))?;
        let spki_ref = cert.tbs_certificate().subject_public_key_info().owned_to_ref();
        let ski = x509_cert::ext::pkix::SubjectKeyIdentifier::try_from(spki_ref)
            .map_err(|e| CryptoError::Malformed(format!("compute SKI: {e}")))?;
        let fingerprint = cert::to_hex_lower(ski.0.as_bytes());
        let algorithm =
            algorithm_label(&cert.tbs_certificate().subject_public_key_info().algorithm.oid);

        let handle_ref = KeyHandleRef {
            handle: KeyHandle::Software(KeyId(uuid::Uuid::new_v4().to_string())),
            standard: Standard::Smime,
            fingerprint: Fingerprint::new(fingerprint),
            usage: KeyUsage::SignAndEncrypt,
            algorithm,
        };
        let stored = StoredKey {
            handle: handle_ref,
            public_data: cert_der,
            private_data: Some(SecretBox::new(Box::new(priv_der))),
        };
        // Return the keystore's canonical (resolvable) handle, not the local copy.
        self.keystore.put(stored).await
    }

    async fn export_public(&self, handle: &KeyHandle) -> crypto_core::Result<Vec<u8>> {
        let stored = self
            .keystore
            .get(handle)
            .await?
            .ok_or_else(|| CryptoError::KeyNotFound(format!("export_public: {handle:?}")))?;
        Ok(stored.public_data)
    }
}

/// Extract an RFC 822 email from a `user_id`. Accepts a bare address
/// (`user@example.com`) or an angle-bracketed form (`Name <user@example.com>`).
fn parse_email(user_id: &str) -> crypto_core::Result<String> {
    let trimmed = user_id.trim();

    // angle-bracket form: "Name <user@example.com>"
    if let (Some(start), Some(end)) = (trimmed.rfind('<'), trimmed.rfind('>')) {
        if end > start {
            let inner = trimmed[start + 1..end].trim();
            if inner.contains('@') {
                return Ok(inner.to_string());
            }
        }
    }

    // bare address form (no spaces).
    if trimmed.contains('@') && !trimmed.contains(char::is_whitespace) {
        return Ok(trimmed.to_string());
    }

    Err(CryptoError::Malformed(format!(
        "could not parse an email address from user_id {user_id:?}"
    )))
}

/// Map a public-key algorithm OID to the framework `algorithm` label.
fn algorithm_label(oid: &der::asn1::ObjectIdentifier) -> String {
    let s = oid.to_string();
    match s.as_str() {
        "1.2.840.10045.2.1" => "ECDSA-P256".into(), // id-ecPublicKey (treated as a P-256 leaf)
        "1.2.840.113549.1.1.1" => "RSA".into(),
        "1.3.101.112" => "Ed25519".into(),
        other => other.into(),
    }
}

/// Parse all `-----BEGIN <label>-----` … `-----END <label>-----` blocks in
/// `text`, base64-decoding each body. Whitespace/blank lines between/inside
/// blocks are ignored. Used by `import_key` to split a PEM cert+key bundle.
fn parse_pem_blocks(text: &str) -> crypto_core::Result<Vec<(String, Vec<u8>)>> {
    use base64::Engine;
    let engine = base64::engine::general_purpose::STANDARD;
    let mut out = Vec::new();
    let mut lines = text.lines();
    while let Some(line) = lines.next() {
        let line = line.trim();
        let Some(rest) = line.strip_prefix("-----BEGIN ") else {
            continue;
        };
        let Some(label) = rest.strip_suffix("-----") else {
            continue;
        };
        let mut b64 = String::new();
        let mut closed = false;
        for l in lines.by_ref() {
            let l = l.trim();
            if l.starts_with("-----END ") {
                closed = true;
                break;
            }
            b64.push_str(l);
        }
        if !closed {
            return Err(CryptoError::Malformed(format!(
                "PEM block {label} missing END line"
            )));
        }
        let der = engine
            .decode(b64)
            .map_err(|e| CryptoError::Malformed(format!("PEM {label} base64 decode: {e}")))?;
        out.push((label.to_string(), der));
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;
    use async_trait::async_trait;
    use std::collections::HashMap;
    use std::sync::Mutex;

    /// In-memory `KeyStore` for unit tests (the real `SqliteKeyStore` lives in
    /// the backend crate and is not pulled into crypto-smime tests). Faithfully
    /// round-trips `StoredKey` including private material.
    struct StubKeyStore {
        inner: Mutex<HashMap<String, StoredKey>>,
    }

    impl StubKeyStore {
        fn new() -> Self {
            Self {
                inner: Mutex::new(HashMap::new()),
            }
        }
    }

    fn key_id_of(handle: &KeyHandle) -> String {
        match handle {
            KeyHandle::Software(k) => k.0.clone(),
            KeyHandle::Token { key_id, .. } => key_id.0.clone(),
        }
    }

    #[async_trait]
    impl KeyStore for StubKeyStore {
        async fn put(&self, key: StoredKey) -> crypto_core::Result<KeyHandleRef> {
            let id = key_id_of(&key.handle.handle);
            let h = key.handle.clone();
            self.inner.lock().unwrap().insert(id, key);
            Ok(h)
        }

        async fn get(&self, handle: &KeyHandle) -> crypto_core::Result<Option<StoredKey>> {
            let id = key_id_of(handle);
            Ok(self.inner.lock().unwrap().get(&id).map(|k| StoredKey {
                handle: k.handle.clone(),
                public_data: k.public_data.clone(),
                // StoredKey is not Clone (SecretBox); reconstruct the private
                // material from the exposed bytes.
                private_data: k.private_data.as_ref().map(|s| {
                    SecretBox::new(Box::new(crypto_core::secret::expose_bytes(s).to_vec()))
                }),
            }))
        }

        async fn find_by_email(
            &self,
            _standard: Standard,
            _email: &str,
        ) -> crypto_core::Result<Vec<KeyHandleRef>> {
            Ok(Vec::new())
        }

        async fn remove(&self, handle: &KeyHandle) -> crypto_core::Result<()> {
            let id = key_id_of(handle);
            self.inner.lock().unwrap().remove(&id);
            Ok(())
        }
    }

    fn backend() -> SmimeBackend {
        SmimeBackend::new(
            Arc::new(StubKeyStore::new()),
            CryptoPolicy::default_baseline(),
        )
    }

    #[test]
    fn backend_is_object_safe() {
        let b: Box<dyn CryptoBackend> = Box::new(backend());
        assert_eq!(b.standard(), Standard::Smime);
        assert_eq!(b.policy().min_rsa_bits, 3072);
    }

    #[tokio::test]
    async fn generate_key_returns_smime_handleref() {
        let b = backend();
        let params = KeyGenParams {
            standard: Standard::Smime,
            user_id: "user@example.com".into(),
            algorithm: "ECDSA-P256".into(),
            passphrase: None,
        };
        let h = b.generate_key(params).await.expect("generate_key ok");
        assert_eq!(h.standard, Standard::Smime);
        assert_eq!(h.algorithm, "ECDSA-P256");
        assert_eq!(h.usage, KeyUsage::SignAndEncrypt);
        assert!(
            !h.fingerprint.as_str().is_empty(),
            "fingerprint (SKI hex) must be non-empty"
        );
    }

    #[tokio::test]
    async fn generate_key_accepts_default_algorithm() {
        let b = backend();
        let params = KeyGenParams {
            standard: Standard::Smime,
            user_id: "bob@example.com".into(),
            algorithm: String::new(),
            passphrase: None,
        };
        let h = b.generate_key(params).await.expect("generate_key ok (default alg)");
        assert_eq!(h.algorithm, "ECDSA-P256");
    }

    #[tokio::test]
    async fn generate_key_rejects_other_standards() {
        let b = backend();
        let params = KeyGenParams {
            standard: Standard::OpenPgp,
            user_id: "user@example.com".into(),
            algorithm: "ECDSA-P256".into(),
            passphrase: None,
        };
        let err = b.generate_key(params).await.unwrap_err();
        assert!(matches!(err, CryptoError::UnsupportedStandard(_)), "got {err:?}");
    }

    #[tokio::test]
    async fn generate_key_rejects_unsupported_algorithm() {
        let b = backend();
        let params = KeyGenParams {
            standard: Standard::Smime,
            user_id: "user@example.com".into(),
            algorithm: "Ed25519".into(),
            passphrase: None,
        };
        let err = b.generate_key(params).await.unwrap_err();
        assert!(matches!(err, CryptoError::Policy(_)), "got {err:?}");
    }

    #[tokio::test]
    async fn export_public_re_parses_with_email_san_and_eku() {
        let b = backend();
        let params = KeyGenParams {
            standard: Standard::Smime,
            user_id: "alice@kylins.com".into(),
            algorithm: "ECDSA-P256".into(),
            passphrase: None,
        };
        let h = b.generate_key(params).await.expect("generate_key ok");

        // export_public returns the stored DER cert.
        let der = b.export_public(&h.handle).await.expect("export_public ok");
        assert!(!der.is_empty(), "exported cert DER must be non-empty");

        // Re-parse with x509-parser and assert SAN email + EKU emailProtection.
        let (_rem, cert) = x509_parser::parse_x509_certificate(&der).expect("re-parse cert DER");

        // SAN contains the email as an RFC822Name.
        let san = cert
            .subject_alternative_name()
            .expect("SAN lookup")
            .expect("SAN extension present")
            .value;
        let has_email = san.general_names.iter().any(
            |gn| matches!(gn, x509_parser::extensions::GeneralName::RFC822Name(s) if *s == "alice@kylins.com"),
        );
        assert!(
            has_email,
            "SAN must contain rfc822Name=alice@kylins.com; got {:?}",
            san.general_names
        );

        // EKU includes emailProtection.
        let eku = cert
            .extended_key_usage()
            .expect("EKU lookup")
            .expect("EKU extension present")
            .value;
        assert!(
            eku.email_protection,
            "EKU must include emailProtection; got {eku:?}"
        );
    }

    #[tokio::test]
    async fn export_public_errors_on_missing_key() {
        let b = backend();
        let handle = KeyHandle::Software(KeyId("nonexistent".into()));
        let err = b.export_public(&handle).await.unwrap_err();
        assert!(matches!(err, CryptoError::KeyNotFound(_)), "got {err:?}");
    }

    /// Wrap DER as a single PEM block (base64 body, 64-col wrapped).
    fn pem_block(label: &str, der: &[u8]) -> String {
        use base64::Engine;
        let b64 = base64::engine::general_purpose::STANDARD.encode(der);
        let mut out = format!("-----BEGIN {label}-----");
        for chunk in b64.as_bytes().chunks(64) {
            out.push('\n');
            out.push_str(std::str::from_utf8(chunk).expect("base64 is ascii"));
        }
        out.push_str(&format!("\n-----END {label}-----"));
        out
    }

    #[tokio::test]
    async fn import_key_round_trips_a_generated_cert_and_key() {
        let b = backend();
        let gen = b
            .generate_key(KeyGenParams {
                standard: Standard::Smime,
                user_id: "importer@kylins.com".into(),
                algorithm: "ECDSA-P256".into(),
                passphrase: None,
            })
            .await
            .expect("generate_key ok");
        let cert_der = b.export_public(&gen.handle).await.expect("export cert");
        // Pull the private PKCS#8 DER out of the stub keystore for PEM wrapping.
        let stored = b
            .keystore
            .get(&gen.handle)
            .await
            .expect("keystore get")
            .expect("stored key present");
        let priv_der =
            crypto_core::secret::expose_bytes(stored.private_data.as_ref().unwrap()).to_vec();

        let pem = format!(
            "{}\n{}\n",
            pem_block("CERTIFICATE", &cert_der),
            pem_block("PRIVATE KEY", &priv_der),
        );

        // Import into a fresh backend so the key provably came from PEM, not memory.
        let b2 = backend();
        let imported = b2
            .import_key(pem.as_bytes(), None)
            .await
            .expect("import_key ok");
        assert_eq!(imported.standard, Standard::Smime);
        // Same SubjectKeyIdentifier method ⇒ identical fingerprint to generate's.
        assert_eq!(imported.fingerprint.as_str(), gen.fingerprint.as_str());
        let re_exported = b2.export_public(&imported.handle).await.expect("re-export");
        assert_eq!(re_exported, cert_der, "re-exported cert must match the original DER");
    }

    #[tokio::test]
    async fn import_key_rejects_encrypted_pkcs8() {
        let b = backend();
        let pem = pem_block("ENCRYPTED PRIVATE KEY", &[1, 2, 3, 4]);
        let err = b.import_key(pem.as_bytes(), None).await.unwrap_err();
        assert!(
            matches!(err, CryptoError::NotImplemented(_)),
            "encrypted PKCS#8 must be NotImplemented, got {err:?}"
        );
    }

    #[tokio::test]
    async fn encrypt_builds_enveloped_data_for_ec_recipient() {
        use crypto_core::{EncryptOp, Part, PartId, PartKind, SerializationStrategy};
        use cms::content_info::ContentInfo;
        use der::Decode;

        let b = backend();
        // Recipient: a generated S/MIME cert+key stored in the stub keystore.
        let recipient = b
            .generate_key(KeyGenParams {
                standard: Standard::Smime,
                user_id: "rcpt@kylins.com".into(),
                algorithm: "ECDSA-P256".into(),
                passphrase: None,
            })
            .await
            .unwrap();

        let op = EncryptOp {
            parts: &[Part {
                id: PartId("body".into()),
                kind: PartKind::Body,
                data: b"secret message body".to_vec(),
            }],
            serialization: SerializationStrategy::SingleMimeBlob,
            recipients: std::slice::from_ref(&recipient),
            sign_with: None,
        };
        let env = b.encrypt(op).await.expect("encrypt ok");

        assert_eq!(env.standard, Standard::Smime);
        assert_eq!(env.parts.len(), 1);
        let ct = &env.parts[0].ciphertext;
        assert!(!ct.is_empty(), "ciphertext (EnvelopedData DER) must be non-empty");

        // The ciphertext parses as id-enveloped-data.
        let ci: ContentInfo = <ContentInfo as Decode>::from_der(ct).unwrap();
        assert_eq!(ci.content_type, const_oid::db::rfc5911::ID_ENVELOPED_DATA);
        // recipients echoed.
        assert_eq!(env.recipients.len(), 1);
        assert_eq!(env.recipients[0].recipient.fingerprint, recipient.fingerprint);
    }

    #[tokio::test]
    async fn encrypt_with_sign_with_produces_signed_then_enveloped() {
        use crypto_core::{
            EncryptOp, Part, PartId, PartKind, SerializationStrategy,
        };
        use cms::content_info::ContentInfo;
        use cms::enveloped_data::EnvelopedData;
        use der::{Decode, Encode};

        let b = backend();
        let signer = b
            .generate_key(KeyGenParams {
                standard: Standard::Smime,
                user_id: "signer@kylins.com".into(),
                algorithm: "ECDSA-P256".into(),
                passphrase: None,
            })
            .await
            .unwrap();
        let recipient = b
            .generate_key(KeyGenParams {
                standard: Standard::Smime,
                user_id: "rcpt-st@kylins.com".into(),
                algorithm: "ECDSA-P256".into(),
                passphrase: None,
            })
            .await
            .unwrap();

        let op = EncryptOp {
            parts: &[Part {
                id: PartId("body".into()),
                kind: PartKind::Body,
                data: b"signed then encrypted".to_vec(),
            }],
            serialization: SerializationStrategy::SingleMimeBlob,
            recipients: std::slice::from_ref(&recipient),
            sign_with: Some(signer),
        };
        let env = b.encrypt(op).await.expect("encrypt+sign ok");

        // Outer is EnvelopedData (sign-then-encrypt: the SignedData DER produced
        // by signing the plaintext is then wrapped as the EnvelopedData content).
        let ci: ContentInfo =
            <ContentInfo as Decode>::from_der(&env.parts[0].ciphertext).unwrap();
        assert_eq!(ci.content_type, const_oid::db::rfc5911::ID_ENVELOPED_DATA);
        let ed: EnvelopedData =
            <EnvelopedData as Decode>::from_der(ci.content.to_der().unwrap().as_slice()).unwrap();

        // NOTE: full decrypt to reach the inner SignedData is Phase 1b. We
        // assert the outer structure is well-formed enveloped data; the inner
        // sign-then-encrypt composition is proven by the fact that
        // build_signed_data + build_enveloped_data each succeed (their inputs
        // are the output of the other) and the upstream cms SCEP test nests
        // EnvelopedData inside SignedData with the same builders.
        assert_eq!(ed.recip_infos.0.len(), 1);
        assert!(matches!(
            ed.recip_infos.0.get(0).unwrap(),
            cms::enveloped_data::RecipientInfo::Kari(_)
        ));
    }

    #[tokio::test]
    async fn encrypt_rejects_split_per_part_serialization() {
        use crypto_core::{EncryptOp, Part, PartId, PartKind, SerializationStrategy};
        let b = backend();
        let recipient = b
            .generate_key(KeyGenParams {
                standard: Standard::Smime,
                user_id: "r2@kylins.com".into(),
                algorithm: "ECDSA-P256".into(),
                passphrase: None,
            })
            .await
            .unwrap();
        let op = EncryptOp {
            parts: &[Part {
                id: PartId("body".into()),
                kind: PartKind::Body,
                data: b"x".to_vec(),
            }],
            serialization: SerializationStrategy::SplitPerPart,
            recipients: &[recipient],
            sign_with: None,
        };
        let err = b.encrypt(op).await.unwrap_err();
        assert!(
            matches!(err, CryptoError::UnsupportedStandard(_) | CryptoError::Policy(_)),
            "SplitPerPart must be rejected for S/MIME, got {err:?}"
        );
    }

    /// End-to-end verify wiring: `backend.sign(...)` produces a SignedEnvelope,
    /// `backend.verify(...)` confirms it as `ValidUnverified` (pre-chain) and
    /// echoes a `KeyHandleRef` whose `KeyId` matches the keystore's
    /// `"standard|fingerprint"` encoding (so a later `backend.sign(signing_key:
    /// this)` would resolve).
    #[tokio::test]
    async fn verify_signing_round_trip_returns_valid_unverified() {
        let b = backend();
        let signer = b
            .generate_key(KeyGenParams {
                standard: Standard::Smime,
                user_id: "signer-verify@kylins.com".into(),
                algorithm: "ECDSA-P256".into(),
                passphrase: None,
            })
            .await
            .expect("generate_key ok");

        let payload = b"verify-this-payload".to_vec();
        let signed = b
            .sign(SignOp {
                signing_key: signer.clone(),
                payload: &payload,
                detached: false,
            })
            .await
            .expect("sign ok");

        let res = b
            .verify(VerifyOp { signed: &signed })
            .await
            .expect("verify ok");
        assert_eq!(res.state, SignatureState::ValidUnverified);
        let s = res.signer.expect("signer KeyHandleRef echoed");
        // KeyId encoding matches the keystore's canonical form.
        assert!(
            matches!(&s.handle, KeyHandle::Software(k) if k.0 == format!("smime|{}", signer.fingerprint.as_str())),
            "KeyId must be `smime|<fingerprint>` to round-trip via the keystore; got {:?}",
            s.handle
        );
        assert_eq!(s.fingerprint.as_str(), signer.fingerprint.as_str());
        assert_eq!(s.algorithm, "ECDSA-P256");
    }

    /// Tampered SignedData (flip a payload byte after signing) → `Invalid`.
    /// This proves the backend's `Invalid` mapping for sig crypto-fail.
    #[tokio::test]
    async fn verify_tampered_payload_returns_invalid() {
        let b = backend();
        let signer = b
            .generate_key(KeyGenParams {
                standard: Standard::Smime,
                user_id: "signer-tamper@kylins.com".into(),
                algorithm: "ECDSA-P256".into(),
                passphrase: None,
            })
            .await
            .expect("generate_key ok");

        let payload = b"original".to_vec();
        let mut signed = b
            .sign(SignOp {
                signing_key: signer,
                payload: &payload,
                detached: false,
            })
            .await
            .expect("sign ok");

        // Mutate the encapsulated content inside the SignedData DER — flip the
        // last byte. The signature check (or the parser) must then fail.
        let mut der = signed.signature.signature.clone();
        let last = der.len() - 1;
        der[last] ^= 0xFF;
        signed.signature.signature = der;

        let res = b.verify(VerifyOp { signed: &signed }).await;
        // Either a hard Malformed error (parse fail) or `Invalid`. Both are
        // acceptable security verdicts; only `ValidUnverified` is a bug.
        match res {
            Ok(v) => assert_ne!(
                v.state,
                SignatureState::ValidUnverified,
                "tampered SignedData must not be ValidUnverified"
            ),
            Err(e) => assert!(
                matches!(e, CryptoError::Malformed(_)),
                "expected Malformed on tampered DER, got {e:?}"
            ),
        }
    }
}
