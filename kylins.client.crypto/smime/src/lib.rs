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
mod chain;
mod cms_build;
mod cms_parse;

// G7 Task 3: cross-implementation (openssl) round-trip fixtures. Tests skip
// silently when openssl is not on PATH; see `interop_tests` module docs.
#[cfg(test)]
mod interop_tests;

use std::sync::Arc;

use async_trait::async_trait;

use crypto_core::{
    CryptoBackend, CryptoError, CryptoPolicy, DecryptedPayload, DecryptOp, DetachedSignature,
    EncryptedEnvelope, EncryptedPart, EncryptOp, Fingerprint, KeyGenParams, KeyHandle, KeyHandleRef,
    KeyId, KeyPacketRef, KeyStore, KeyUsage, PartId, PartKind, SecretBox, SerializationStrategy,
    SignOp, SignatureState, SignedEnvelope, Standard, StoredKey, TrustState, VerificationResult,
    VerifyOp,
};
use der::referenced::OwnedToRef;
use der::Decode;

pub const CRATE_NAME: &str = "crypto-smime";

// Task 5: public re-exports so the G5 receive orchestrator + the backend
// `mail/crypto.rs::validate_recipient_certs` helper can call cert-chain
// validation and consume its outcome. `RevocationState` is exposed because it
// is a field of `ChainOutcome`; callers (the orchestrator) read it to surface
// "unchecked revocation" warnings in the UI.
pub use chain::{validate_signer_chain, ChainOutcome, RevocationState};

// Task 2 (G5): re-export `extract_intermediates` so the backend receive
// orchestrator (G5 Task 3) can collect the intermediate CA cert DERs embedded
// in a received SignedData (minus the signer leaf) and pass them to
// `SmimeBackend::verify_with_context(intermediate_ders)`. The function is
// declared `pub` in the private `cms_parse` module (mirroring
// `chain::validate_signer_chain`'s visibility pattern) so it can be re-exported
// here; external callers reach it only through this crate-root alias, never via
// `cms_parse::extract_intermediates` directly.
pub use cms_parse::extract_intermediates;

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

    /// Full S/MIME verification with cert-chain, identity, revocation, and
    /// trust context (G4 Task 5). The G5 receive orchestrator calls this
    /// directly (NOT the `CryptoBackend::verify` trait method, which is the
    /// pre-chain fallback for callers that have no trust context).
    ///
    /// This is an **inherent method** (not a trait method) because the
    /// `CryptoBackend::verify` trait takes only `VerifyOp { signed: &SignedEnvelope }`
    /// — there is no way to pass trust anchors, the From: email, CRLs, or the
    /// signer's resolved `TrustState` through the trait signature. The G5
    /// orchestrator resolves those inputs (looks up the From: header, fetches
    /// trust anchors from the keystore, fetches CRLs from the cache, resolves
    /// the signer's trust_decision) and passes them in here.
    ///
    /// # Flow (spec §4.4 mapping)
    ///
    /// 1. Run the pre-chain cryptographic signature check via
    ///    `cms_parse::verify_signed`. If no signer cert is present in the
    ///    SignedData `certificates` set → `SignatureState::UnknownKey` (early
    ///    return; chain validation cannot run without a signer cert).
    /// 2. If `sig_ok == false` → `SignatureState::Invalid` (crypto fail).
    /// 3. Otherwise run `chain::validate_signer_chain` with the supplied
    ///    anchors / intermediates / from_email / signing_time / crls.
    /// 4. Map the `ChainOutcome` + the caller-supplied `signer_trust` to the
    ///    final `SignatureState`:
    ///    - `!chain_valid` (incl. revoked) → `Invalid`
    ///    - `chain_valid && !identity_match` (From↔SAN mismatch) → `Mismatch`
    ///    - `chain_valid && identity_match && signer_trust.may_encrypt_to()`
    ///      (Verified / Personal) → `ValidVerified`
    ///    - otherwise → `ValidUnverified`
    ///
    /// `signing_time_unix` falls back to `now()` when the CMS `signingTime`
    /// signed attribute is absent (spec decision #9: verify as-of-signing so
    /// a message still verifies after signer-cert expiry, with `now()` as the
    /// fallback when signingTime is missing).
    ///
    /// # Inputs
    ///
    /// - `signed`              — the SignedEnvelope to verify (the inner
    ///   `signature.signature` bytes are the SignedData DER).
    /// - `from_email`          — RFC 5322 `From:` address for SAN binding.
    ///   `None` skips identity binding (chain_valid alone decides; identity_match
    ///   defaults to `true` so a chain-valid / no-from result is `ValidVerified`
    ///   or `ValidUnverified`, NOT `Mismatch`).
    /// - `trust_anchor_ders`   — trust anchor cert DERs (user-imported CA roots
    ///   from the KeyManager's "Trusted CAs" store; the G5 orchestrator
    ///   resolves them).
    /// - `intermediate_ders`   — intermediate CA cert DERs (typically extracted
    ///   from the SignedData `certificates` set, or a separate CA cache).
    /// - `crls`                — CRL DERs (one per issuing CA; fetched +
    ///   cached by the G5 orchestrator).
    /// - `signer_trust`        — the resolved trust state for THIS signer
    ///   (looked up in `trust_decisions` by the signer fingerprint; or
    ///   `TrustState::Personal` for our own key).
    ///
    /// # Returns
    ///
    /// `Ok(VerificationResult { state, signer })` always — even on cryptographic
    /// failure, the result is `Invalid` (a verification verdict), not an
    /// `Err`. `Err` is reserved for parse failures (malformed CMS DER) and
    /// invariant violations (e.g. sig_ok but no signer cert). The `signer`
    /// `KeyHandleRef` is populated whenever a signer cert was located, so the
    /// caller can record a trust_decision for it.
    #[allow(clippy::too_many_arguments)]
    pub async fn verify_with_context(
        &self,
        signed: &SignedEnvelope,
        from_email: Option<&str>,
        trust_anchor_ders: &[Vec<u8>],
        intermediate_ders: &[Vec<u8>],
        crls: &[Vec<u8>],
        signer_trust: TrustState,
    ) -> crypto_core::Result<VerificationResult> {
        // Pre-chain signature check (Plan 1 / G3): cryptographic sig check
        // against the signer cert embedded in the SignedData. Identical to the
        // trait `verify` impl up to the chain-validation branch.
        let signed_data_der = &signed.signature.signature;
        let covered = Some(signed.payload.as_slice());
        let check = match cms_parse::verify_signed(signed_data_der, covered) {
            Ok(c) => c,
            Err(CryptoError::Malformed(msg)) if msg.contains("no signer cert") => {
                // No usable signer cert available to verify against — surface
                // as `UnknownKey` (caller can prompt the user to import).
                return Ok(VerificationResult {
                    state: SignatureState::UnknownKey,
                    signer: None,
                });
            }
            Err(e) => return Err(e),
        };

        // Build the signer KeyHandleRef whenever a signer cert was located
        // (independent of the chain outcome — even a chain-failed result wants
        // the signer ref so the UI can show "signed by unknown signer" and
        // offer a trust action).
        let signer = check.signer_fingerprint.map(|fp| KeyHandleRef {
            handle: KeyHandle::Software(KeyId(format!("smime|{fp}"))),
            standard: Standard::Smime,
            fingerprint: Fingerprint::new(fp),
            usage: KeyUsage::SignAndEncrypt,
            algorithm: "ECDSA-P256".into(),
        });

        // Step 2: sig crypto-fail → Invalid.
        if !check.sig_ok {
            return Ok(VerificationResult {
                state: SignatureState::Invalid,
                signer,
            });
        }

        // Step 3: sig OK → run cert-chain validation. The signer_cert_der is
        // guaranteed present here (sig_ok implies a signer cert was located
        // — verify_signed only sets sig_ok=true after parsing the signer cert
        // and verifying the signature against it).
        let signer_cert_der = check.signer_cert_der.ok_or_else(|| {
            CryptoError::Malformed(
                "verify_with_context: sig_ok=true but no signer cert (invariant violation)".into(),
            )
        })?;

        // signingTime fallback: CMS signingTime is the authoritative verify
        // time (spec §9 — message verifies the same today and in 10 years).
        // Falls back to now() only when the attribute is absent.
        let signing_time_unix = check.signing_time_unix.unwrap_or_else(|| {
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_secs() as i64)
                .unwrap_or(0)
        });

        // Build the intermediate slices as &[u8] — chain::validate_signer_chain
        // takes `&[&[u8]]` (caller supplies leaf separately; intermediates are
        // passed in caller's order per pkix-chain's contract).
        let intermediates: Vec<&[u8]> =
            intermediate_ders.iter().map(|v| v.as_slice()).collect();

        let outcome = chain::validate_signer_chain(
            &signer_cert_der,
            &intermediates,
            trust_anchor_ders,
            from_email,
            signing_time_unix,
            crls,
        );

        // Step 4: map ChainOutcome + signer_trust → SignatureState (spec §4.4).
        // Order matters: chain_valid gate first (revoked → chain_valid=false →
        // Invalid), then identity_match (Mismatch), then the trust ladder.
        let state = if !outcome.chain_valid {
            SignatureState::Invalid
        } else if !outcome.identity_match {
            SignatureState::Mismatch
        } else if signer_trust.may_encrypt_to() {
            SignatureState::ValidVerified
        } else {
            SignatureState::ValidUnverified
        };

        Ok(VerificationResult { state, signer })
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
        passphrase: Option<SecretBox<String>>,
    ) -> crypto_core::Result<KeyHandleRef> {
        // Content-sniff by content, NOT extension: PEM iff the bytes are UTF-8
        // starting with `-----BEGIN` (a `.crt`/`.cer`/`.p12`/`.pfx`/keyless
        // extension all route correctly). Binary PKCS#12 (DER SEQUENCE) routes
        // to the p12 arm; everything else that isn't a PEM bundle is a malformed
        // import (surfaced as Malformed in the PEM parse path).
        let is_pem = std::str::from_utf8(data)
            .map(|s| s.trim_start().starts_with("-----BEGIN"))
            .unwrap_or(false);

        if is_pem {
            let text = std::str::from_utf8(data).map_err(|e| {
                CryptoError::Malformed(format!("import_key: input not UTF-8: {e}"))
            })?;
            let blocks = parse_pem_blocks(text)?;

            let cert_der = blocks
                .iter()
                .find(|(label, _)| label == "CERTIFICATE")
                .map(|(_, der)| der.clone())
                .ok_or_else(|| CryptoError::Malformed("no CERTIFICATE PEM block".into()))?;

            // Private-key arm: ENCRYPTED PRIVATE KEY takes precedence over
            // PRIVATE KEY (a bundle shouldn't carry both, but if it does, the
            // encrypted block is the one the user means to import).
            let priv_der = if let Some((_, block)) = blocks
                .iter()
                .find(|(label, _)| label == "ENCRYPTED PRIVATE KEY")
            {
                decrypt_encrypted_pkcs8(block, expose_passphrase(&passphrase))?
            } else if let Some((_, block)) =
                blocks.iter().find(|(label, _)| label == "PRIVATE KEY")
            {
                block.clone()
            } else {
                return Err(CryptoError::Malformed(
                    "no PRIVATE KEY PEM block (expected 'PRIVATE KEY' or 'ENCRYPTED PRIVATE KEY')"
                        .into(),
                ));
            };

            self.persist_imported(cert_der, priv_der).await
        } else {
            // PKCS#12 / PFX binary arm (Plan 3 Task 1).
            self.import_p12(data, &passphrase).await
        }
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

impl SmimeBackend {
    /// Shared tail for `import_key`: build a `StoredKey` from the cert + private
    /// key DER (both PEM-extracted and p12-extracted paths converge here) and
    /// persist it via the keystore. Computes the SPKI algorithm label + the
    /// SubjectKeyIdentifier fingerprint via the SAME x509-cert 0.3 path as
    /// `generate_key`, so a re-imported cert produces an identical fingerprint
    /// (and `KeyId`) to a freshly-generated one. Private material is wrapped in
    /// a `SecretBox`; the keystore's at-rest AES-GCM layer (master key from the
    /// OS keyring) encrypts it before it touches SQLite — the bag passphrase is
    /// NOT persisted (it was consumed in the caller's decrypt step).
    async fn persist_imported(
        &self,
        cert_der: Vec<u8>,
        priv_der: Vec<u8>,
    ) -> crypto_core::Result<KeyHandleRef> {
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

    /// PKCS#12 / PFX binary import arm (Plan 3 Task 1). Parses the PFX, decrypts
    /// the bag PBE with the user's passphrase, extracts the leaf cert + private
    /// key as raw DER bytes, and funnels them through `persist_imported`.
    ///
    /// We touch ONLY `p12-keystore`'s `&[u8]`-returning surface
    /// (`KeyStore::from_pkcs12`, `private_key_chain`, `Certificate::as_der`,
    /// `PrivateKey::as_der`), so the crate's internal `der`/`spki`/`x509-cert`
    /// line is irrelevant to our 0.8 build stack — no 0.7-bridge is needed
    /// (unlike `chain.rs`'s pkix-* path, which must name the 0.2 types). The
    /// `p12_keystore::error::Error` enum is matched by variant name with wildcard
    /// inner payloads, so the transitive `der::Error` / `MacError` types never
    /// need to be named from this crate.
    async fn import_p12(
        &self,
        data: &[u8],
        passphrase: &Option<SecretBox<String>>,
    ) -> crypto_core::Result<KeyHandleRef> {
        // p12-keystore's `from_pkcs12` takes `password: &str`. An empty
        // passphrase is valid for unencrypted bags; `None` maps to "".
        let pass = expose_passphrase(passphrase).unwrap_or_default();
        let ks = p12_keystore::KeyStore::from_pkcs12(
            data,
            pass,
            // Relaxed: import everything (key + cert + chain) rather than
            // dropping "unmatched" entries under Strict. We only read the
            // first private-key chain, so extra certs (intermediates) are
            // ignored (carry-forward: intermediates in the .p12 chain —
            // spec §3 Out).
            p12_keystore::Pkcs12ImportPolicy::Relaxed,
        )
        .map_err(map_p12_error)?;

        let (_, chain) = ks
            .private_key_chain()
            .ok_or_else(|| CryptoError::Malformed("p12: no private key in bag".into()))?;
        let cert_der = chain
            .certs()
            .first()
            .ok_or_else(|| CryptoError::Malformed("p12: no certificate in keychain".into()))?
            .as_der()
            .to_vec();
        let priv_der = chain.key().as_der().to_vec();

        self.persist_imported(cert_der, priv_der).await
    }
}

/// Expose the passphrase `&str` from an `Option<SecretBox<String>>` for use
/// within `import_key` only. The `SecretBox` zeroizes its heap buffer on drop
/// at the end of `import_key`; this helper borrows it for the duration of the
/// decrypt call (no clone, no second buffer to zeroize).
fn expose_passphrase(pass: &Option<SecretBox<String>>) -> Option<&str> {
    use secrecy::ExposeSecret;
    pass.as_ref().map(|p| p.expose_secret().as_str())
}

/// Decrypt an `ENCRYPTED PRIVATE KEY` PEM block (Plan 3 Task 2 — retires the
/// `NotImplemented("encrypted PKCS#8 import — Plan 3")` stub). The block is
/// the DER bytes of an `EncryptedPrivateKeyInfo`; `pkcs8`'s `decrypt(password)`
/// runs the PBES2 KDF + symmetric decrypt. Wrong passphrase → `Policy`
/// (user-facing "passphrase incorrect"); missing/empty passphrase + encrypted
/// block → `Policy` (an encrypted bag needs a passphrase). Parse failure of
/// the `EncryptedPrivateKeyInfo` DER itself → `Malformed` (the file is not a
/// well-formed encrypted PKCS#8).
fn decrypt_encrypted_pkcs8(
    block: &[u8],
    pass: Option<&str>,
) -> crypto_core::Result<Vec<u8>> {
    use pkcs8::EncryptedPrivateKeyInfoOwned;
    // `EncryptedPrivateKeyInfoOwned` = `EncryptedPrivateKeyInfo<Bytes>` — the
    // concrete owned alias so `from_der` resolves without type-annotation hints
    // (the generic `EncryptedPrivateKeyInfo<Data>` is ambiguous).
    let info = EncryptedPrivateKeyInfoOwned::from_der(block)
        .map_err(|e| CryptoError::Malformed(format!("parse EncryptedPrivateKeyInfo: {e}")))?;
    // An encrypted block requires a non-empty passphrase. We treat empty string
    // the same as None (the spec's "empty passphrase + encrypted block →
    // Policy"); an unencrypted bag would have used a plain PRIVATE KEY block.
    let pass = pass
        .filter(|s| !s.is_empty())
        .ok_or_else(|| CryptoError::Policy("encrypted PKCS#8 requires a passphrase".into()))?;
    info.decrypt(pass)
        .map_err(|e| CryptoError::Policy(format!("encrypted PKCS#8 decrypt failed: {e}")))
        .map(|doc| doc.as_bytes().to_vec())
}

/// Map a `p12_keystore::error::Error` to a `CryptoError`, discriminating
/// wrong-passphrase (PBE/MAC failure) from structurally-malformed input.
///
/// - `MacError` — the PFX integrity MAC failed to verify; this is the canonical
///   wrong-passphrase signal (the MAC key is derived from the passphrase, so a
///   wrong passphrase produces a different MAC key → verification fails).
/// - `Pkcs5Error` / `UnpadError` — bag-content PBE decrypt produced invalid
///   padding; this also indicates a wrong passphrase (or a corrupt bag).
///
/// Everything else (DER parse errors, unsupported schemes, invalid version)
/// is a structural problem with the file → `Malformed`. The backend maps
/// `Policy` to a "passphrase incorrect" toast and `Malformed` to a "file
/// unreadable" toast (spec §6 decision #7).
fn map_p12_error(e: p12_keystore::error::Error) -> CryptoError {
    use p12_keystore::error::Error as P12Err;
    match e {
        P12Err::MacError(_)
        | P12Err::Pkcs5Error(_)
        | P12Err::UnpadError => {
            CryptoError::Policy("p12 passphrase incorrect".into())
        }
        _ => CryptoError::Malformed(format!("p12 parse: {e}")),
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

    // ─── Plan 3: .p12/.pfx + encrypted-PKCS#8 import (TDD) ───
    //
    // The encrypted-PKCS#8 PEM path was previously a NotImplemented stub; the
    // `import_key_rejects_encrypted_pkcs8` regression that asserted that stub has
    // been retired (superseded by `import_key_encrypted_pkcs8_pem_round_trips`
    // + `import_key_encrypted_pkcs8_wrong_passphrase_is_policy_error` below, which
    // exercise the real decrypt path both ways).

    /// Build a `.p12`/`.pfx` DER fixture in-test via `p12-keystore`'s OWN writer
    /// API (no openssl). Wraps a generated cert + private key (PKCS#8 DER) as a
    /// single `PrivateKeyChain` entry, encrypted under `password`. Lets the
    /// p12 round-trip tests assert that our `import_key` extracts the same cert
    /// + key back out regardless of the bag PBE layer.
    fn build_p12_fixture(cert_der: &[u8], priv_der: &[u8], password: &str) -> Vec<u8> {
        let mut ks = p12_keystore::KeyStore::new();
        let cert = p12_keystore::Certificate::from_der(cert_der)
            .expect("p12 fixture: cert from der");
        let key = p12_keystore::PrivateKey::from_der(priv_der)
            .expect("p12 fixture: priv from der");
        // Leaf cert is the first (and only) element of the chain (p12-keystore's
        // `PrivateKeyChain::new` docs require the entity cert be first).
        let chain = p12_keystore::PrivateKeyChain::new("smime-identity", key, vec![cert]);
        ks.add_entry(
            "smime-identity",
            p12_keystore::KeyStoreEntry::PrivateKeyChain(chain),
        );
        ks.writer(password)
            .encryption_algorithm(p12_keystore::EncryptionAlgorithm::PbeWithHmacSha256AndAes256)
            .mac_algorithm(p12_keystore::MacAlgorithm::HmacSha256)
            .write()
            .expect("p12 fixture: write")
    }

    /// Build an encrypted-PKCS#8 PEM (`ENCRYPTED PRIVATE KEY` + `CERTIFICATE`)
    /// bundle in-test via `pkcs8::PrivateKeyInfo::encrypt` (the `getrandom`
    /// feature pulls OS entropy so no RNG needs to be threaded). Returns the
    /// full PEM text so `import_key` can content-sniff it as PEM.
    fn build_encrypted_pkcs8_pem(cert_der: &[u8], priv_der: &[u8], password: &str) -> String {
        use pkcs8::{DecodePrivateKey, PrivateKeyInfoOwned};
        // Parse the unencrypted PKCS#8 DER (from generate_key) into a concrete
        // `PrivateKeyInfoOwned` (the `PrivateKeyInfo<Any, OctetString, BitString>`
        // alias) so `.encrypt(password)` resolves without type-annotation hints.
        let pki = PrivateKeyInfoOwned::from_pkcs8_der(priv_der)
            .expect("enc pkcs8 fixture: parse PrivateKeyInfo");
        let doc = pki
            .encrypt(password)
            .expect("enc pkcs8 fixture: encrypt");
        let enc_der = doc.as_bytes().to_vec();
        format!(
            "{}\n{}\n",
            pem_block("CERTIFICATE", cert_der),
            pem_block("ENCRYPTED PRIVATE KEY", &enc_der),
        )
    }

    #[tokio::test]
    async fn import_key_p12_round_trips_cert_and_key() {
        let b = backend();
        let gen = b
            .generate_key(KeyGenParams {
                standard: Standard::Smime,
                user_id: "p12-import@kylins.com".into(),
                algorithm: "ECDSA-P256".into(),
                passphrase: None,
            })
            .await
            .expect("generate_key ok");
        let cert_der = b.export_public(&gen.handle).await.expect("export cert");
        let stored = b
            .keystore
            .get(&gen.handle)
            .await
            .expect("keystore get")
            .expect("stored key present");
        let priv_der =
            crypto_core::secret::expose_bytes(stored.private_data.as_ref().unwrap()).to_vec();

        let pfx = build_p12_fixture(&cert_der, &priv_der, "test");

        // Import into a fresh backend so the key provably came from the .p12,
        // not memory. The passphrase is wrapped in a SecretBox exactly as the
        // backend IPC will thread it (Plan 3 Task 3).
        let b2 = backend();
        let pass = SecretBox::new(Box::new("test".to_string()));
        let imported = b2
            .import_key(&pfx, Some(pass))
            .await
            .expect("import_key (p12) ok");
        assert_eq!(imported.standard, Standard::Smime);
        // Same SKI fingerprint as the direct cert build (persist_imported uses
        // the same SubjectKeyIdentifier method as generate_key).
        assert_eq!(
            imported.fingerprint.as_str(),
            gen.fingerprint.as_str(),
            "p12-imported fingerprint must match the direct build"
        );
        let re_exported = b2.export_public(&imported.handle).await.expect("re-export");
        assert_eq!(re_exported, cert_der, "re-exported cert must match the original DER");
    }

    #[tokio::test]
    async fn import_key_p12_wrong_passphrase_is_policy_error() {
        let b = backend();
        let gen = b
            .generate_key(KeyGenParams {
                standard: Standard::Smime,
                user_id: "p12-wrong@kylins.com".into(),
                algorithm: "ECDSA-P256".into(),
                passphrase: None,
            })
            .await
            .expect("generate_key ok");
        let cert_der = b.export_public(&gen.handle).await.expect("export cert");
        let stored = b
            .keystore
            .get(&gen.handle)
            .await
            .expect("keystore get")
            .expect("stored key present");
        let priv_der =
            crypto_core::secret::expose_bytes(stored.private_data.as_ref().unwrap()).to_vec();

        let pfx = build_p12_fixture(&cert_der, &priv_der, "correct-pass");

        let b2 = backend();
        let wrong_pass = SecretBox::new(Box::new("wrong-pass".to_string()));
        let err = b2
            .import_key(&pfx, Some(wrong_pass))
            .await
            .expect_err("wrong passphrase must error");
        // MUST be Policy (user-facing "passphrase incorrect"), NOT Malformed.
        // A structurally-valid PFX whose MAC/PBE failed is a passphrase problem,
        // not a malformed-file problem (spec §6 decision #7).
        assert!(
            matches!(err, CryptoError::Policy(ref m) if m.contains("p12 passphrase incorrect")),
            "wrong passphrase must be Policy(\"p12 passphrase incorrect\"), got {err:?}"
        );
    }

    #[tokio::test]
    async fn import_key_encrypted_pkcs8_pem_round_trips() {
        let b = backend();
        let gen = b
            .generate_key(KeyGenParams {
                standard: Standard::Smime,
                user_id: "encpkcs8@kylins.com".into(),
                algorithm: "ECDSA-P256".into(),
                passphrase: None,
            })
            .await
            .expect("generate_key ok");
        let cert_der = b.export_public(&gen.handle).await.expect("export cert");
        let stored = b
            .keystore
            .get(&gen.handle)
            .await
            .expect("keystore get")
            .expect("stored key present");
        let priv_der =
            crypto_core::secret::expose_bytes(stored.private_data.as_ref().unwrap()).to_vec();

        let pem = build_encrypted_pkcs8_pem(&cert_der, &priv_der, "secret");

        let b2 = backend();
        let pass = SecretBox::new(Box::new("secret".to_string()));
        let imported = b2
            .import_key(pem.as_bytes(), Some(pass))
            .await
            .expect("import_key (encrypted PKCS#8) ok");
        assert_eq!(imported.standard, Standard::Smime);
        assert_eq!(
            imported.fingerprint.as_str(),
            gen.fingerprint.as_str(),
            "encrypted-PKCS#8-imported fingerprint must match the direct build"
        );
        let re_exported = b2.export_public(&imported.handle).await.expect("re-export");
        assert_eq!(re_exported, cert_der, "re-exported cert must match the original DER");
    }

    #[tokio::test]
    async fn import_key_encrypted_pkcs8_wrong_passphrase_is_policy_error() {
        let b = backend();
        let gen = b
            .generate_key(KeyGenParams {
                standard: Standard::Smime,
                user_id: "encpkcs8-wrong@kylins.com".into(),
                algorithm: "ECDSA-P256".into(),
                passphrase: None,
            })
            .await
            .expect("generate_key ok");
        let cert_der = b.export_public(&gen.handle).await.expect("export cert");
        let stored = b
            .keystore
            .get(&gen.handle)
            .await
            .expect("keystore get")
            .expect("stored key present");
        let priv_der =
            crypto_core::secret::expose_bytes(stored.private_data.as_ref().unwrap()).to_vec();

        let pem = build_encrypted_pkcs8_pem(&cert_der, &priv_der, "right");

        let b2 = backend();
        let wrong_pass = SecretBox::new(Box::new("wrong".to_string()));
        let err = b2
            .import_key(pem.as_bytes(), Some(wrong_pass))
            .await
            .expect_err("wrong passphrase must error");
        assert!(
            matches!(err, CryptoError::Policy(_)),
            "encrypted PKCS#8 wrong passphrase must be Policy, got {err:?}"
        );
    }

    /// Regression guard for the refactor: the existing unencrypted-PEM path
    /// (CERTIFICATE + PRIVATE KEY, no passphrase) must keep working after
    /// `import_key` is restructured to content-sniff + dispatch + share a
    /// `persist_imported` tail with the new p12 / encrypted-PKCS#8 arms.
    #[tokio::test]
    async fn import_key_unencrypted_pem_still_works() {
        let b = backend();
        let gen = b
            .generate_key(KeyGenParams {
                standard: Standard::Smime,
                user_id: "plain-pem@kylins.com".into(),
                algorithm: "ECDSA-P256".into(),
                passphrase: None,
            })
            .await
            .expect("generate_key ok");
        let cert_der = b.export_public(&gen.handle).await.expect("export cert");
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

        let b2 = backend();
        let imported = b2
            .import_key(pem.as_bytes(), None)
            .await
            .expect("import_key (unencrypted PEM) ok");
        assert_eq!(imported.standard, Standard::Smime);
        assert_eq!(imported.fingerprint.as_str(), gen.fingerprint.as_str());
        let re_exported = b2.export_public(&imported.handle).await.expect("re-export");
        assert_eq!(re_exported, cert_der);
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

    // ─── Task 5: SmimeBackend::verify_with_context mapping tests ───
    //
    // The mapping under test (spec §4.4):
    //
    //   | condition                                  | SignatureState   |
    //   |--------------------------------------------|------------------|
    //   | sig crypto-fail / chain invalid / revoked  | Invalid          |
    //   | sig OK + chain OK + From↔SAN mismatch      | Mismatch         |
    //   | sig OK + chain OK + identity + trusted     | ValidVerified    |
    //   | sig OK + chain OK + identity + untrusted   | ValidUnverified  |
    //   | no signer cert                             | UnknownKey       |
    //
    // Each test generates a key (`backend.generate_key`), signs a payload
    // (`backend.sign`), then calls `verify_with_context` with a specific
    // trust-anchor / from_email / signer_trust combination and asserts the
    // resulting `SignatureState`. The signer cert produced by
    // `cert::build_self_signed_smime_cert` is a self-signed S/MIME leaf
    // (KeyUsage=digitalSignature|keyEncipherment, EKU=emailProtection,
    // SAN=rfc822Name(email)); passing its own DER as the trust anchor lets
    // pkix-chain validate it as the chain root (leaf==anchor, signature
    // self-verifies).

    /// Helper: produce a `(backend, signer_KeyHandleRef, signer_cert_der,
    /// SignedEnvelope)` for the supplied `email`. The signer cert carries
    /// SAN=rfc822Name(`email`) so a matching `from_email` parameter passes the
    /// From↔SAN binding.
    async fn sign_with_self_signed(email: &str) -> (SmimeBackend, KeyHandleRef, Vec<u8>, SignedEnvelope) {
        let b = backend();
        let signer = b
            .generate_key(KeyGenParams {
                standard: Standard::Smime,
                user_id: email.into(),
                algorithm: "ECDSA-P256".into(),
                passphrase: None,
            })
            .await
            .expect("generate_key ok");
        let cert_der = b.export_public(&signer.handle).await.expect("export_public ok");
        let payload = b"task5-verify-payload".to_vec();
        let signed = b
            .sign(SignOp {
                signing_key: signer.clone(),
                payload: &payload,
                detached: false,
            })
            .await
            .expect("sign ok");
        (b, signer, cert_der, signed)
    }

    /// ValidVerified: sig OK + chain OK (self-signed signer as anchor) +
    /// identity match + `signer_trust = Verified` → `ValidVerified`.
    #[tokio::test]
    async fn verify_with_context_trusted_signer_yields_valid_verified() {
        let (b, _signer, cert_der, signed) =
            sign_with_self_signed("alice@kylins.com").await;

        let res = b
            .verify_with_context(
                &signed,
                Some("alice@kylins.com"),
                std::slice::from_ref(&cert_der),
                &[],
                &[],
                TrustState::Verified,
            )
            .await
            .expect("verify_with_context ok");

        assert_eq!(
            res.state,
            SignatureState::ValidVerified,
            "sig OK + chain OK + identity match + Verified trust → ValidVerified"
        );
        assert!(
            res.signer.is_some(),
            "signer KeyHandleRef must be populated on ValidVerified"
        );
    }

    /// ValidUnverified: same as ValidVerified but `signer_trust = Unverified`
    /// → `ValidUnverified` (the trust ladder — chain OK is not enough; the
    /// signer must be explicitly Verified/Personal for ValidVerified).
    #[tokio::test]
    async fn verify_with_context_untrusted_signer_yields_valid_unverified() {
        let (b, _signer, cert_der, signed) =
            sign_with_self_signed("bob@kylins.com").await;

        let res = b
            .verify_with_context(
                &signed,
                Some("bob@kylins.com"),
                std::slice::from_ref(&cert_der),
                &[],
                &[],
                TrustState::Unverified,
            )
            .await
            .expect("verify_with_context ok");

        assert_eq!(
            res.state,
            SignatureState::ValidUnverified,
            "sig OK + chain OK + identity match + Unverified trust → ValidUnverified"
        );
        assert!(res.signer.is_some());
    }

    /// Mismatch: sig OK + chain OK but `from_email` differs from the signer
    /// cert's SAN → `Mismatch` (not `Invalid` — the path is valid, only the
    /// identity binding failed; spec §4.4 + Task 3 split).
    #[tokio::test]
    async fn verify_with_context_from_email_mismatch_yields_mismatch() {
        let (b, _signer, cert_der, signed) =
            sign_with_self_signed("real@kylins.com").await;

        // SAN on the cert is real@kylins.com; pass a DIFFERENT from_email.
        let res = b
            .verify_with_context(
                &signed,
                Some("imposter@kylins.com"),
                std::slice::from_ref(&cert_der),
                &[],
                &[],
                TrustState::Verified,
            )
            .await
            .expect("verify_with_context ok");

        assert_eq!(
            res.state,
            SignatureState::Mismatch,
            "sig OK + chain OK + From↔SAN mismatch → Mismatch (not Invalid)"
        );
    }

    /// Invalid (chain fail): sig OK but the supplied trust anchor did NOT
    /// sign the signer cert (unrelated root) → chain_valid=false → `Invalid`.
    #[tokio::test]
    async fn verify_with_context_wrong_anchor_yields_invalid() {
        let (_b1, _signer1, unrelated_cert_der, _signed1) =
            sign_with_self_signed("unrelated-anchor@kylins.com").await;
        // Use a SECOND backend / key to produce the actual signed envelope,
        // then verify against the FIRST (unrelated) cert as the anchor.
        let (b2, _signer2, _cert2, signed2) =
            sign_with_self_signed("actual-signer@kylins.com").await;

        let res = b2
            .verify_with_context(
                &signed2,
                Some("actual-signer@kylins.com"),
                // unrelated_cert_der never signed the actual-signer cert.
                std::slice::from_ref(&unrelated_cert_der),
                &[],
                &[],
                TrustState::Verified,
            )
            .await
            .expect("verify_with_context ok");

        assert_eq!(
            res.state,
            SignatureState::Invalid,
            "sig OK but chain doesn't validate against unrelated anchor → Invalid"
        );
    }

    /// Invalid (sig crypto-fail): tamper the SignedData DER after signing →
    /// the cryptographic signature check fails → `Invalid` (regardless of the
    /// chain outcome — sig-fail short-circuits before chain validation).
    #[tokio::test]
    async fn verify_with_context_tampered_signature_yields_invalid() {
        let (b, _signer, cert_der, mut signed) =
            sign_with_self_signed("tamper-test@kylins.com").await;

        // Flip the last byte of the SignedData DER — either the parse fails
        // (Malformed) or the signature check fails (sig_ok=false → Invalid).
        let last = signed.signature.signature.len() - 1;
        signed.signature.signature[last] ^= 0xFF;

        let res = b
            .verify_with_context(
                &signed,
                Some("tamper-test@kylins.com"),
                std::slice::from_ref(&cert_der),
                &[],
                &[],
                TrustState::Verified,
            )
            .await;

        match res {
            Ok(v) => assert_eq!(
                v.state,
                SignatureState::Invalid,
                "tampered SignedData must map to Invalid (sig crypto-fail)"
            ),
            Err(e) => assert!(
                matches!(e, CryptoError::Malformed(_)),
                "expected Malformed on tampered DER, got {e:?}"
            ),
        }
    }

    /// UnknownKey: strip the SignedData `certificates` field so no signer cert
    /// can be located → `UnknownKey` (spec §4.4 — "no signer cert available").
    #[tokio::test]
    async fn verify_with_context_no_signer_cert_yields_unknown_key() {
        use cms::content_info::ContentInfo;
        use cms::signed_data::SignedData;
        use der::{Decode, Encode};

        let (b, _signer, _cert_der, signed) =
            sign_with_self_signed("no-cert@kylins.com").await;

        // Re-parse the SignedData, drop the `certificates` field, re-encode,
        // and patch it back into the SignedEnvelope.
        let ci = ContentInfo::from_der(&signed.signature.signature).expect("parse ContentInfo");
        let sd = SignedData::from_der(ci.content.to_der().unwrap().as_slice()).expect("parse SignedData");
        let stripped = SignedData {
            version: sd.version,
            digest_algorithms: sd.digest_algorithms.clone(),
            encap_content_info: sd.encap_content_info.clone(),
            certificates: None,
            crls: sd.crls.clone(),
            signer_infos: sd.signer_infos.clone(),
        };
        let stripped_ci = ContentInfo {
            content_type: const_oid::db::rfc5911::ID_SIGNED_DATA,
            content: der::Any::from_der(&stripped.to_der().unwrap()).unwrap(),
        };
        let mut stripped_signed = signed.clone();
        stripped_signed.signature.signature = stripped_ci.to_der().unwrap();

        // Use empty trust_anchor_ders — irrelevant for this test (early-return
        // on UnknownKey before chain validation runs).
        let res = b
            .verify_with_context(
                &stripped_signed,
                Some("no-cert@kylins.com"),
                &[],
                &[],
                &[],
                TrustState::Verified,
            )
            .await
            .expect("verify_with_context ok");

        assert_eq!(
            res.state,
            SignatureState::UnknownKey,
            "no signer cert in SignedData → UnknownKey"
        );
        assert!(
            res.signer.is_none(),
            "no signer ref when signer cert cannot be located"
        );
    }

    /// Trust-ladder granularity: `Personal` trust (our-own-key level) also
    /// qualifies for `ValidVerified` — `may_encrypt_to()` is true for both
    /// `Verified` and `Personal` (crypto-core::TrustState). Other levels
    /// (Rejected / Undecided) → `ValidUnverified`.
    #[tokio::test]
    async fn verify_with_context_personal_trust_also_yields_valid_verified() {
        let (b, _signer, cert_der, signed) =
            sign_with_self_signed("personal@kylins.com").await;

        let res = b
            .verify_with_context(
                &signed,
                Some("personal@kylins.com"),
                std::slice::from_ref(&cert_der),
                &[],
                &[],
                TrustState::Personal,
            )
            .await
            .expect("verify_with_context ok");

        assert_eq!(
            res.state,
            SignatureState::ValidVerified,
            "Personal trust also qualifies for ValidVerified (may_encrypt_to()=true)"
        );
    }

    /// No `from_email`: identity binding is skipped; a chain-valid result
    /// surfaces as `ValidVerified` / `ValidUnverified` (NOT `Mismatch`).
    /// Confirms the `from_email = None` branch in `validate_signer_chain`.
    #[tokio::test]
    async fn verify_with_context_no_from_email_skips_identity_binding() {
        let (b, _signer, cert_der, signed) =
            sign_with_self_signed("nofrom@kylins.com").await;

        let res = b
            .verify_with_context(
                &signed,
                None, // no identity binding
                std::slice::from_ref(&cert_der),
                &[],
                &[],
                TrustState::Verified,
            )
            .await
            .expect("verify_with_context ok");

        assert_eq!(
            res.state,
            SignatureState::ValidVerified,
            "no from_email → no identity binding → chain OK + trusted → ValidVerified (not Mismatch)"
        );
    }
}
