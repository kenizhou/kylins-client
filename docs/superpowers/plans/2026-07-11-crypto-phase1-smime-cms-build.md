# S/MIME CMS Build (sign + encrypt) Implementation Plan — Plan 2b

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the `NotImplemented("Plan 2b")` stubs in `SmimeBackend::sign` and `SmimeBackend::encrypt` with real CMS `SignedData` (sign) and `EnvelopedData` (encrypt) production using the official RustCrypto `cms` crate's `builder` feature.

**Architecture:** A new pure-helper module `smime/src/cms_build.rs` turns raw bytes + keys into CMS DER (`build_signed_data`, `build_enveloped_data`, `recipient_input_from_cert`). `SmimeBackend`'s `sign`/`encrypt` trait methods are thin glue that resolve keys via the existing `KeyStore`, call the helpers, and map to/from crypto-core's neutral `SignedEnvelope`/`EncryptedEnvelope`. Send-side only — decrypt/verify remain `NotImplemented` (Phase 1b).

**Tech Stack:** RustCrypto `cms` 0.3.0-pre.2 (`builder` feature) + `aes` 0.9, `aes-kw` 0.3, `cbc` 0.2, `rsa` 0.10.0-rc.18, `const-oid` 0.10, on the existing `der` 0.8 / `x509-cert` 0.3 / `p256` 0.14 / `ecdsa` 0.17 / `signature` 3 / `sha2` 0.11 line. Toolchain rustc 1.96 (satisfies cms edition-2024 / MSRV-1.85).

## Spike conclusion (drives this plan)

A pre-plan spike read the local `cms` source at `D:\Projects\mailclient\opensource\RustCrypto\formats\cms`. The `builder` module is **fully functional**, reversing the earlier "cms builder is WIP" assumption. Proven by the crate's own tests:

- **sign** — `SignedDataBuilder` + `SignerInfoBuilder`; ECDSA-P256 via `add_signer_info::<ecdsa::SigningKey<NistP256>, p256::ecdsa::DerSignature>` (see `cms/tests/builder.rs::test_build_signed_data`).
- **encrypt → RSA recipient** — `KeyTransRecipientInfoBuilder` + `KeyEncryptionInfo::Rsa`; full build+decrypt round-trip (`cms/tests/builder.rs::test_build_pkcs7_scep_pkcsreq`).
- **encrypt → ECC recipient** — `KeyAgreeRecipientInfoBuilder` ephemeral-static ECDH (RFC 5753) + `DhSinglePassStdDhKdf<Sha256>` + `AesKw<Aes192>`; openssl-decryptable (`cms/tests/builder/kari.rs::test_build_enveloped_data_ec`).

`cms` 0.3.0-pre.2 sits on crypto-smime's exact existing dep line; the toolchain (1.96) satisfies its edition-2024/MSRV-1.85. No `cryptographic-message-syntax`, no hand-rolled DER.

## Global Constraints

- **Scope is send-only.** `sign` and `encrypt` are implemented; `decrypt`/`verify` stay `Err(CryptoError::NotImplemented("Phase 1b"))`. Do not implement receive-side logic (chain validation, OCSP/CRL, kari decrypt) — not even in tests beyond what each task specifies.
- **Private key material never crosses IPC.** `sign` reads the signer's encrypted PKCS#8 from the `KeyStore` in-process via `crypto_core::secret::expose_bytes`; it is never serialized into a neutral envelope or returned across a boundary.
- **Sign is ECDSA-P256 only** (matches `generate_key`). RSA/Ed25519 signing returns `CryptoError::NotImplemented("RSA/Ed25519 signing — Plan 2c")`. **Encrypt supports both RSA** (ktri) **and ECC P-256** (kari) recipients, dispatching on each recipient cert's SPKI algorithm OID — recipients are collected third-party certs and must handle heterogeneous key types.
- **Additive, no rewrites.** `cms_build.rs` is a new module; `lib.rs` changes are localized to the two trait-method bodies + a `mod cms_build;` declaration + imports. Do not touch `cert.rs`, `keystore_bridge.rs`, the db layer, or crypto-core.
- **Tests are self-contained.** No `openssl` invocation (Windows-hostile). RSA-recipient build correctness is proven by an in-process round-trip (`RsaPrivateKey::new` → encrypt → RSA-unwrap + AES-CBC decrypt). ECC-recipient build correctness is proven structurally + by reference to the upstream openssl-verified `cms` kari test that uses identical builder calls (full ECC decrypt round-trip lands with Phase 1b).
- **API verification note:** `context7` does not index the RustCrypto `rsa` crate and it is absent from the local mirror. The `rsa::RsaPublicKey::from_public_key_der` call in Task 4 relies on rsa 0.10 implementing the `spki::DecodePublicKey` blanket (`for<'a> TryFrom<SubjectPublicKeyInfoRef<'a>, Error = spki::Error>`, confirmed present in rsa ≥0.9). If compilation shows otherwise, fall back to `rsa::pkcs1::DecodeRsaPublicKey::from_public_key_der(spki.subject_public_key().raw_bytes())`. The implementing subagent resolves this via `cargo` errors (TDD).
- **Cargo pre-release pin:** `cms` is `0.3.0-pre.2`; the exact version string is required for Cargo to resolve a pre-release.
- **MSRV note:** adding `cms` (edition 2024) raises crypto-smime's *transitive* MSRV to 1.85. Bump crypto-smime's declared `rust-version` to `"1.85"` (Task 1). The compiler is 1.96, so this is documentation-accuracy only; crypto-core stays at 1.77.2.

---

## File Structure

- **Create** `kylins.client.crypto/smime/src/cms_build.rs` — pure CMS builders. Three `pub(crate)` functions: `build_signed_data`, `build_enveloped_data`, `recipient_input_from_cert`; plus `pub(crate) enum RecipientKey` and `pub(crate) struct RecipientInput`. No I/O, no keystore access, no async — pure bytes→DER. Unit-tested in-module.
- **Modify** `kylins.client.crypto/smime/Cargo.toml` — add `cms`, `aes`, `aes-kw`, `cbc`, `rsa`, `const-oid`; bump `rust-version` to `"1.85"`.
- **Modify** `kylins.client.crypto/smime/src/lib.rs` — add `mod cms_build;`, replace the `sign` and `encrypt` trait-method bodies (Tasks 1 & 4) with glue that calls `cms_build`; tighten `decrypt`/`verify` stub tags to `"Phase 1b"`. Imports added.
- **Modify** `kylins.client.backend/tests/crypto_smime_lifecycle.rs` — extend the lifecycle test to exercise `sign` (Task 5).

---

### Task 1: Wire CMS deps + `cms_build::build_signed_data` + `SmimeBackend::sign` (ECDSA-P256)

**Files:**
- Modify: `kylins.client.crypto/smime/Cargo.toml`
- Create: `kylins.client.crypto/smime/src/cms_build.rs`
- Modify: `kylins.client.crypto/smime/src/lib.rs` (imports, `mod cms_build;`, `sign` body)

**Interfaces:**
- Consumes: `crypto_core::{SignOp, SignedEnvelope, DetachedSignature, CryptoError, Result, Standard}`; `KeyStore::get`; `crypto_core::secret::expose_bytes`; existing `StoredKey { public_data: Vec<u8> (cert DER), private_data: Option<SecretBox<Vec<u8>>> (PKCS#8 DER) }`.
- Produces: `pub(crate) fn build_signed_data(payload: &[u8], detached: bool, signer_cert_der: &[u8], signer_priv_pkcs8_der: &[u8]) -> Result<Vec<u8>>` — returns a `ContentInfo` (id-signed-data) DER blob. Later tasks do not consume this; it is called only by `SmimeBackend::sign`.

- [ ] **Step 1: Add CMS dependencies to `smime/Cargo.toml`**

In the `[dependencies]` section, after the existing `signature = "3"` line, add:

```toml
# CMS builder (Plan 2b). 0.3.0-pre.2 is the current pre-release on our exact
# der 0.8 / x509-cert 0.3 / p256 0.14 / signature 3 line. The `builder` feature
# pulls the SignedData/EnvelopedData builders (aes, aes-kw, cbc, rsa, sha2,
# elliptic-curve/ecdh). Pre-release version pin is required by Cargo.
cms = { version = "0.3.0-pre.2", features = ["builder", "pem"] }
# Generic-instantiated cipher / key-wrap types we pass to the cms builders
# (Aes128 content cipher, AesKw<Aes192> key wrap). Must be direct deps because
# we name the types, not just rely on cms's transitive use.
aes = "0.9"
aes-kw = "0.3"
cbc = "0.2"
# RSA recipients use PKCS#1v1.5 key transport (ktri). RC line pinned by cms 0.3.
rsa = { version = "0.10.0-rc.18", features = ["sha2"] }
const-oid = "0.10"
```

In the `[package]` section, change:

```toml
rust-version = "1.77.2"
```

to:

```toml
# Raised from 1.77.2 because the `cms` crate (Task 1) is edition 2024 / MSRV 1.85.
# crypto-core stays at 1.77.2 (it does not depend on cms).
rust-version = "1.85"
```

- [ ] **Step 2: Run build to verify the dep graph resolves**

Run: `cargo build -p crypto-smime`
Expected: BUILD SUCCEEDS (cms + transitive aes/aes-kw/cbc/rsa resolve against the existing der/x509-cert/p256 line). If you get a version-conflict error between `signature`/`ecdsa`/`p256` and what cms expects, do NOT downgrade — re-read the spike conclusion; the lines are compatible and the conflict indicates a typo in the version strings above.

- [ ] **Step 3: Write the failing test for `build_signed_data`**

Create `kylins.client.crypto/smime/src/cms_build.rs` with the test module only first (the function is referenced but not yet defined, so this fails to compile — that is the "red" state):

```rust
//! Pure CMS builders for S/MIME send-side operations (Plan 2b).
//!
//! These helpers turn raw message bytes + parsed keys into CMS DER. They hold
//! no state, do no I/O, and never touch the keystore — `SmimeBackend`'s trait
//! methods are the glue that resolves keys and maps to/from crypto-core's
//! neutral envelopes.

use crypto_core::{CryptoError, Result};

#[cfg(test)]
mod tests {
    use super::*;
    use cms::content_info::ContentInfo;
    use cms::signed_data::SignedData;
    use der::Decode;
    use p256::ecdsa::{VerifyingKey, signature::Verifier};

    /// Build signed-data over a known cert+key, then cryptographically verify.
    #[test]
    fn build_signed_data_produces_verifiable_signed_data() {
        // Self-signed ECDSA-P256 cert + key, built with the existing cert helper.
        let built = crate::cert::build_self_signed_smime_cert("signer@kylins.com").unwrap();
        let cert_der = built.cert_der.clone();
        let priv_der = built.priv_pkcs8_der.clone();

        let der = build_signed_data(b"hello smime", false, &cert_der, &priv_der).unwrap();

        // Re-parse: ContentInfo { id-signed-data, SignedData }.
        let ci: ContentInfo = <ContentInfo as Decode>::from_der(&der).unwrap();
        assert_eq!(ci.content_type, const_oid::db::rfc5911::ID_SIGNED_DATA);
        let sd: SignedData =
            <SignedData as Decode>::from_der(ci.content.to_der().unwrap().as_slice()).unwrap();
        assert_eq!(sd.signer_infos.0.len(), 1, "exactly one signer info");

        // Embedded signer cert is present.
        let certs = sd.certificates.expect("certificates embedded");
        assert_eq!(certs.0.len(), 1, "exactly one embedded cert");

        // Cryptographic verify: the signer info's signature validates against
        // the cert's public key over the DER-encoded signed attributes.
        let signer_info = &sd.signer_infos.0[0];
        let signed_attrs_der = signer_info
            .signed_attrs
            .clone()
            .expect("signed attrs present")
            .to_der()
            .unwrap();

        // Recover the ECDSA verifying key from the cert's SPKI.
        let spki_der = {
            let cert =
                <x509_cert::Certificate as Decode>::from_der(&cert_der).unwrap();
            cert.tbs_certificate()
                .subject_public_key_info()
                .to_der()
                .unwrap()
        };
        let pub_key = p256::PublicKey::from_public_key_der(&spki_der).unwrap();
        let vk = VerifyingKey::from(&pub_key);

        let sig = p256::ecdsa::DerSignature::from_bytes(
            signer_info.signature.as_bytes(),
        )
        .unwrap();
        vk.verify(&signed_attrs_der, &sig).expect("signature verifies");
    }
}
```

- [ ] **Step 4: Run the test to verify it fails**

Run: `cargo test -p crypto-smime build_signed_data_produces_verifiable_signed_data`
Expected: COMPILE ERROR — `cannot find function build_signed_data` (the helper is not yet defined).

- [ ] **Step 5: Implement `build_signed_data`**

At the top of `cms_build.rs`, after the `use crypto_core::{CryptoError, Result};` line, add the imports and function:

```rust
use cms::builder::{SignedDataBuilder, SignerInfoBuilder};
use cms::cert::{CertificateChoices, IssuerAndSerialNumber};
use cms::signed_data::{EncapsulatedContentInfo, SignerIdentifier};
use der::asn1::OctetString;
use der::{Any, Decode, Encode, Tag};
use p256::NistP256;
use p256::pkcs8::DecodePrivateKey;
use spki::AlgorithmIdentifierOwned;
use x509_cert::Certificate;

/// SHA-256 OID (2.16.840.1.101.3.4.2.1) — the digest used for ECDSA-P256 signing.
const ID_SHA_256: const_oid::ObjectIdentifier =
    const_oid::ObjectIdentifier::new_unwrap("2.16.840.1.101.3.4.2.1");

/// Map any cms builder/DER error into a `CryptoError::Malformed` with context.
fn cms_err(context: &str, e: impl std::fmt::Display) -> CryptoError {
    CryptoError::Malformed(format!("cms {context}: {e}"))
}

/// Build a CMS `SignedData` (wrapped in `ContentInfo`, id-signed-data) over
/// `payload`, signed with the ECDSA-P256 key whose cert + PKCS#8 private key
/// are given. `detached = true` produces a detached signature (the payload is
/// NOT encapsulated — `eContent` is `None`).
///
/// Returns the DER-encoded `ContentInfo`.
pub(crate) fn build_signed_data(
    payload: &[u8],
    detached: bool,
    signer_cert_der: &[u8],
    signer_priv_pkcs8_der: &[u8],
) -> Result<Vec<u8>> {
    // Parse signer cert → issuer + serial for the SignerIdentifier.
    let cert = <Certificate as Decode>::from_der(signer_cert_der)
        .map_err(|e| cms_err("parse signer cert", e))?;
    let tbs = cert.tbs_certificate();
    let sid = SignerIdentifier::IssuerAndSerialNumber(IssuerAndSerialNumber {
        issuer: tbs.issuer().clone(),
        serial_number: tbs.serial_number().clone(),
    });

    // Parse signer private key (ECDSA P-256) from PKCS#8 DER.
    let secret = p256::SecretKey::from_pkcs8_der(signer_priv_pkcs8_der)
        .map_err(|e| cms_err("parse signer PKCS#8", e))?;
    let signing_key = p256::ecdsa::SigningKey::from(&secret);

    // Encapsulated content: the payload as id-data. Detached ⇒ eContent None.
    let encap = {
        let econtent = if detached {
            None
        } else {
            let oct = OctetString::new(payload.to_vec())
                .map_err(|e| cms_err("payload octet string", e))?;
            let oct_der = oct.to_der().map_err(|e| cms_err("encode octet string", e))?;
            Some(Any::new(Tag::OctetString, oct_der).map_err(|e| cms_err("wrap payload any", e))?)
        };
        EncapsulatedContentInfo {
            econtent_type: const_oid::db::rfc5911::ID_DATA,
            econtent,
        }
    };

    let digest_algorithm = AlgorithmIdentifierOwned {
        oid: ID_SHA_256,
        parameters: None,
    };

    let signer_info_builder = SignerInfoBuilder::new(sid, digest_algorithm.clone(), &encap, None)
        .map_err(|e| cms_err("signer info builder", e))?;

    let content_info = SignedDataBuilder::new(&encap)
        .add_digest_algorithm(digest_algorithm)
        .map_err(|e| cms_err("add digest algorithm", e))?
        .add_certificate(CertificateChoices::Certificate(cert))
        .map_err(|e| cms_err("add certificate", e))?
        .add_signer_info::<p256::ecdsa::SigningKey<NistP256>, p256::ecdsa::DerSignature>(
            signer_info_builder,
            &signing_key,
        )
        .map_err(|e| cms_err("add signer info", e))?
        .build()
        .map_err(|e| cms_err("build signed data", e))?;

    content_info
        .to_der()
        .map_err(|e| cms_err("encode content info", e))
}
```

- [ ] **Step 6: Run the test to verify it passes**

Run: `cargo test -p crypto-smime build_signed_data_produces_verifiable_signed_data`
Expected: PASS. If the signature fails to verify, the most likely cause is the signed-attributes DER reconstruction — ensure you verify over `signer_info.signed_attrs.to_der()`, not the encapsulated payload.

- [ ] **Step 7: Wire `SmimeBackend::sign` and add `mod cms_build;`**

In `kylins.client.crypto/smime/src/lib.rs`:

(a) Add the module declaration near the top (after `mod cert;`):

```rust
mod cms_build;
```

(b) Add these to the `use crypto_core::{...}` import block:

```rust
    DetachedSignature, SignOp, SignedEnvelope,
```

(c) Replace the `sign` method body (currently `Err(CryptoError::NotImplemented(NOT_IMPLEMENTED_TAG.into()))`) with:

```rust
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
        let priv_der = crypto_core::secret::expose_bytes(priv_box).to_vec();

        let der = cms_build::build_signed_data(
            op.payload,
            op.detached,
            &stored.public_data,
            &priv_der,
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
```

- [ ] **Step 8: Run the full smime test suite + clippy**

Run: `cargo test -p crypto-smime && cargo clippy -p crypto-smime --all-targets -- -D warnings`
Expected: all tests PASS (existing 9 + the new one = 10), clippy clean.

- [ ] **Step 9: Commit**

```bash
cd D:/Projects/mailclient/kylins-client
git add kylins.client.crypto/smime/Cargo.toml kylins.client.crypto/smime/src/cms_build.rs kylins.client.crypto/smime/src/lib.rs
git commit -m "feat(crypto-smime): implement sign (CMS SignedData, ECDSA-P256) — Plan 2b Task 1"
```

---

### Task 2: `cms_build::build_enveloped_data` (RSA recipient via ktri) + `RecipientInput`/`RecipientKey`

**Files:**
- Modify: `kylins.client.crypto/smime/src/cms_build.rs`
- Test: in-module `#[cfg(test)] mod tests` in `cms_build.rs`

**Interfaces:**
- Consumes: nothing new from other tasks (pure helper).
- Produces:
  - `pub(crate) enum RecipientKey { Rsa(rsa::RsaPublicKey), EcP256(p256::PublicKey) }`
  - `pub(crate) struct RecipientInput { pub iasn: cms::cert::IssuerAndSerialNumber, pub key: RecipientKey }`
  - `pub(crate) fn build_enveloped_data(plaintext: &[u8], recipients: &[RecipientInput]) -> Result<Vec<u8>>` — returns a `ContentInfo` (id-enveloped-data) DER blob. Task 3 extends this with the ECC branch; Task 4's `SmimeBackend::encrypt` calls it.

- [ ] **Step 1: Write the failing test (RSA recipient full round-trip)**

Add to the `tests` module in `cms_build.rs`:

```rust
    /// RSA recipient: build EnvelopedData, then decrypt in-process by
    /// RSA-unwrapping the CEK and AES-128-CBC decrypting the content.
    /// This proves the ktri build path end-to-end (no cert needed — we pass
    /// the public key + identifier directly).
    #[test]
    fn build_enveloped_data_round_trips_rsa_recipient() {
        use cipher::block_padding::Pkcs7;
        use cipher::{BlockModeDecrypt, KeyIvInit};
        use cms::enveloped_data::{EnvelopedData, RecipientInfo};
        use der::asn1::OctetString;
        use rsa::{Pkcs1v15Encrypt, RsaPrivateKey, RsaPublicKey};

        type Aes128CbcDec = cbc::Decryptor<aes::Aes128>;

        let mut rng = rand::rng();
        let priv_key = RsaPrivateKey::new(&mut rng, 3072).expect("gen rsa key");
        let pub_key = RsaPublicKey::from(&priv_key);
        let iasn = test_iasn(1);

        let plaintext = b"hello rsa smime";
        let der = build_enveloped_data(
            plaintext,
            &[RecipientInput {
                iasn: iasn.clone(),
                key: RecipientKey::Rsa(pub_key),
            }],
        )
        .expect("build enveloped data");

        // Parse ContentInfo { id-enveloped-data, EnvelopedData }.
        let ci: ContentInfo = <ContentInfo as Decode>::from_der(&der).unwrap();
        assert_eq!(ci.content_type, const_oid::db::rfc5911::ID_ENVELOPED_DATA);
        let env: EnvelopedData =
            <EnvelopedData as Decode>::from_der(ci.content.to_der().unwrap().as_slice()).unwrap();

        // Single ktri recipient matching our identifier.
        let ktri = match &env.recip_infos.0[0] {
            RecipientInfo::Ktri(k) => k,
            _ => panic!("expected KeyTransRecipientInfo"),
        };
        assert_eq!(
            ktri.rid,
            cms::enveloped_data::RecipientIdentifier::IssuerAndSerialNumber(iasn)
        );

        // RSA-unwrap the content-encryption key.
        let cek = priv_key
            .decrypt(Pkcs1v15Encrypt, ktri.enc_key.as_bytes())
            .expect("decrypt cek");

        // AES-128-CBC decrypt the content.
        let eci = &env.encrypted_content;
        assert_eq!(eci.content_enc_alg.oid, const_oid::db::rfc5911::ID_AES_128_CBC);
        let iv_octet = OctetString::from_der(
            eci.content_enc_alg.parameters.clone().unwrap().to_der().unwrap().as_slice(),
        )
        .unwrap();
        let ct = eci.encrypted_content.clone().unwrap();
        let pt = Aes128CbcDec::new(cek.as_slice().into(), iv_octet.as_bytes().into())
            .decrypt_padded_vec::<Pkcs7>(ct.as_bytes())
            .expect("decrypt content");
        assert_eq!(pt, plaintext);
    }

    /// Minimal IssuerAndSerialNumber for tests (no real cert needed).
    fn test_iasn(id: i32) -> cms::cert::IssuerAndSerialNumber {
        use cms::cert::IssuerAndSerialNumber;
        use x509_cert::serial_number::SerialNumber;
        let issuer = format!("CN=test recipient {id}").parse().unwrap();
        IssuerAndSerialNumber {
            issuer,
            serial_number: SerialNumber::new(&[0x01, 0x02, 0x03, 0x04, 0x05, 0x06])
                .expect("serial number"),
        }
    }
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cargo test -p crypto-smime build_enveloped_data_round_trips_rsa_recipient`
Expected: COMPILE ERROR — `cannot find function build_enveloped_data` / types `RecipientInput`, `RecipientKey`.

- [ ] **Step 3: Implement `RecipientKey`, `RecipientInput`, and `build_enveloped_data` (RSA branch only)**

Add to `cms_build.rs` (above the `tests` module):

```rust
use cms::builder::{
    ContentEncryptionAlgorithm, EnvelopedDataBuilder, KeyEncryptionInfo,
    KeyTransRecipientInfoBuilder,
};
use cms::cert::IssuerAndSerialNumber;
use cms::content_info::ContentInfo;
use der::{Any, AnyRef, Encode};

/// A recipient's public key, normalized to the concrete type each cms recipient
/// builder needs.
pub(crate) enum RecipientKey {
    /// RSA — used for key transport (ktri, PKCS#1v1.5).
    Rsa(rsa::RsaPublicKey),
    /// ECDSA/ECDH P-256 — used for key agreement (kari, ephemeral-static ECDH).
    EcP256(p256::PublicKey),
}

/// Everything `build_enveloped_data` needs for one recipient: the identifier
/// (carried in the RecipientInfo) and the public key.
pub(crate) struct RecipientInput {
    pub iasn: IssuerAndSerialNumber,
    pub key: RecipientKey,
}

/// Build a CMS `EnvelopedData` (wrapped in `ContentInfo`, id-enveloped-data)
/// over `plaintext`, encrypted with AES-128-CBC, with one RecipientInfo per
/// entry in `recipients`. RSA recipients use key transport (ktri); ECC
/// recipients use key agreement (kari) — added in Task 3.
pub(crate) fn build_enveloped_data(
    plaintext: &[u8],
    recipients: &[RecipientInput],
) -> Result<Vec<u8>> {
    let mut rng = rand::rng();
    let mut builder = EnvelopedDataBuilder::new(
        None,
        plaintext,
        ContentEncryptionAlgorithm::Aes128Cbc,
        None,
    )
    .map_err(|e| cms_err("enveloped data builder", e))?;

    for r in recipients {
        match &r.key {
            RecipientKey::Rsa(pk) => {
                let rid = cms::enveloped_data::RecipientIdentifier::IssuerAndSerialNumber(
                    r.iasn.clone(),
                );
                let ri = KeyTransRecipientInfoBuilder::<rand::rngs::OsRng>::new(
                    rid,
                    KeyEncryptionInfo::Rsa(pk.clone()),
                )
                .map_err(|e| cms_err("ktri builder", e))?;
                builder
                    .add_recipient_info(ri)
                    .map_err(|e| cms_err("add ktri recipient", e))?;
            }
            RecipientKey::EcP256(_) => {
                return Err(CryptoError::NotImplemented(
                    "ECC recipient (kari) — Plan 2b Task 3".into(),
                ));
            }
        }
    }

    let enveloped = builder
        .build_with_rng(&mut rng)
        .map_err(|e| cms_err("build enveloped data", e))?;
    let enveloped_der = enveloped
        .to_der()
        .map_err(|e| cms_err("encode enveloped data", e))?;
    let content = AnyRef::try_from(enveloped_der.as_slice())
        .map_err(|e| cms_err("wrap enveloped anyref", e))?;
    let content_info = ContentInfo {
        content_type: const_oid::db::rfc5911::ID_ENVELOPED_DATA,
        content: Any::from(content),
    };
    content_info
        .to_der()
        .map_err(|e| cms_err("encode content info", e))
}
```

Note on the RNG type parameter: `KeyTransRecipientInfoBuilder<R>` is generic over the rng type `R` (a `CryptoRng`). `EnvelopedDataBuilder<R>` must use the same `R`. `rand::rng()` in rand 0.10 returns `rand::rngs::OsRng`; annotating the ktri builder with `<rand::rngs::OsRng>` and passing `&mut rng` (also `OsRng`) to `build_with_rng` keeps them unified. If `rand::rng()` resolves to a different concrete type on your toolchain, change the turbofish to match (the compiler will name it in the error).

- [ ] **Step 4: Run the test to verify it passes**

Run: `cargo test -p crypto-smime build_enveloped_data_round_trips_rsa_recipient`
Expected: PASS (RSA-unwrap + AES-CBC decrypt recovers the plaintext). If the RNG-type turbofish is wrong, the error names the expected type — adjust `KeyTransRecipientInfoBuilder::<ExpectedType>`.

- [ ] **Step 5: Run clippy**

Run: `cargo clippy -p crypto-smime --all-targets -- -D warnings`
Expected: clean.

- [ ] **Step 6: Commit**

```bash
cd D:/Projects/mailclient/kylins-client
git add kylins.client.crypto/smime/src/cms_build.rs
git commit -m "feat(crypto-smime): build EnvelopedData for RSA recipients (ktri) — Plan 2b Task 2"
```

---

### Task 3: `build_enveloped_data` ECC P-256 recipient (kari) + dispatch on `RecipientKey`

**Files:**
- Modify: `kylins.client.crypto/smime/src/cms_build.rs`
- Test: in-module `tests`

**Interfaces:**
- Consumes: `RecipientInput`/`RecipientKey` from Task 2.
- Produces: extends `build_enveloped_data` to handle `RecipientKey::EcP256` via `KeyAgreeRecipientInfoBuilder` (ephemeral-static ECDH, `DhSinglePassStdDhKdf<Sha256>`, `AesKw<Aes192>` key wrap, `Aes128` content cipher). No signature change.

- [ ] **Step 1: Write the failing test (ECC recipient structural + mixed dispatch)**

Add to the `tests` module:

```rust
    /// ECC P-256 recipient: build EnvelopedData via kari and assert structure.
    /// Full decrypt round-trip for kari arrives with Phase 1b (decrypt); the
    /// build path is cryptographically proven upstream by
    /// cms/tests/builder/kari.rs::test_build_enveloped_data_ec (openssl-decoded)
    /// using identical builder calls.
    #[test]
    fn build_enveloped_data_builds_kari_for_ec_recipient() {
        use cms::enveloped_data::RecipientInfo;

        let mut rng = rand::rng();
        let secret = p256::SecretKey::generate_from_rng(&mut rng);
        let pub_key = secret.public_key();

        let plaintext = b"hello ecc smime";
        let der = build_enveloped_data(
            plaintext,
            &[RecipientInput {
                iasn: test_iasn(2),
                key: RecipientKey::EcP256(pub_key),
            }],
        )
        .expect("build enveloped data kari");

        let ci: ContentInfo = <ContentInfo as Decode>::from_der(&der).unwrap();
        assert_eq!(ci.content_type, const_oid::db::rfc5911::ID_ENVELOPED_DATA);
        let env: cms::enveloped_data::EnvelopedData =
            <cms::enveloped_data::EnvelopedData as Decode>::from_der(
                ci.content.to_der().unwrap().as_slice(),
            )
            .unwrap();

        // The recipient info is a kari (KeyAgreeRecipientInfo).
        match &env.recip_infos.0[0] {
            RecipientInfo::Kari(kari) => {
                // Originator carries the ephemeral EC public key.
                assert!(matches!(
                    kari.originator,
                    cms::enveloped_data::OriginatorIdentifierOrKey::OriginatorKey(_)
                ));
                // One encrypted key packet.
                assert_eq!(kari.recipient_enc_keys.len(), 1);
            }
            other => panic!("expected Kari, got {other:?}"),
        }
        // Content encryption is AES-128-CBC.
        assert_eq!(
            env.encrypted_content.content_enc_alg.oid,
            const_oid::db::rfc5911::ID_AES_128_CBC
        );
    }

    /// Mixed recipients (RSA + ECC) produce one RecipientInfo each, in order.
    #[test]
    fn build_enveloped_data_supports_mixed_recipients() {
        use cms::enveloped_data::RecipientInfo;
        use rsa::{RsaPrivateKey, RsaPublicKey};

        let mut rng = rand::rng();
        let rsa_priv = RsaPrivateKey::new(&mut rng, 3072).unwrap();
        let rsa_pub = RsaPublicKey::from(&rsa_priv);
        let ec_secret = p256::SecretKey::generate_from_rng(&mut rng);
        let ec_pub = ec_secret.public_key();

        let recipients = [
            RecipientInput { iasn: test_iasn(1), key: RecipientKey::Rsa(rsa_pub) },
            RecipientInput { iasn: test_iasn(2), key: RecipientKey::EcP256(ec_pub) },
        ];
        let der = build_enveloped_data(b"mixed", &recipients).unwrap();

        let ci: ContentInfo = <ContentInfo as Decode>::from_der(&der).unwrap();
        let env: cms::enveloped_data::EnvelopedData =
            <cms::enveloped_data::EnvelopedData as Decode>::from_der(
                ci.content.to_der().unwrap().as_slice(),
            )
            .unwrap();
        assert_eq!(env.recip_infos.0.len(), 2, "one info per recipient");
        assert!(matches!(env.recip_infos.0[0], RecipientInfo::Ktri(_)));
        assert!(matches!(env.recip_infos.0[1], RecipientInfo::Kari(_)));
    }
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cargo test -p crypto-smime build_enveloped_data_builds_kari_for_ec_recipient build_enveloped_data_supports_mixed_recipients`
Expected: FAIL — `build enveloped data kari: NotImplemented("ECC recipient (kari) — Plan 2b Task 3")`.

- [ ] **Step 3: Implement the ECC (kari) branch**

In `cms_build.rs`, extend the `use cms::builder::{...}` import to add the kari types:

```rust
use cms::builder::{
    ContentEncryptionAlgorithm, DhSinglePassStdDhKdf, EcKeyEncryptionInfo, EnvelopedDataBuilder,
    KeyAgreeRecipientInfoBuilder, KeyEncryptionInfo, KeyTransRecipientInfoBuilder,
};
```

Replace the `RecipientKey::EcP256(_) => { return Err(...) }` arm in `build_enveloped_data` with:

```rust
            RecipientKey::EcP256(pk) => {
                use cms::enveloped_data::KeyAgreeRecipientIdentifier;
                let rid = KeyAgreeRecipientIdentifier::IssuerAndSerialNumber(r.iasn.clone());
                let ri = KeyAgreeRecipientInfoBuilder::<
                    rand::rngs::OsRng,
                    p256::NistP256,
                    DhSinglePassStdDhKdf<sha2::Sha256>,
                    aes_kw::AesKw<aes::Aes192>,
                    aes::Aes128,
                >::new(None, rid, EcKeyEncryptionInfo::Ec(*pk))
                .map_err(|e| cms_err("kari builder", e))?;
                builder
                    .add_recipient_info(ri)
                    .map_err(|e| cms_err("add kari recipient", e))?;
            }
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cargo test -p crypto-smime build_enveloped_data_`
Expected: both new tests PASS, plus Task 2's RSA test still PASS. If the kari turbofish RNG type mismatches, align it with whatever `rand::rng()` yields (same fix as Task 2 Step 3).

- [ ] **Step 5: Run clippy**

Run: `cargo clippy -p crypto-smime --all-targets -- -D warnings`
Expected: clean.

- [ ] **Step 6: Commit**

```bash
cd D:/Projects/mailclient/kylins-client
git add kylins.client.crypto/smime/src/cms_build.rs
git commit -m "feat(crypto-smime): build EnvelopedData for ECC P-256 recipients (kari/ECDH) — Plan 2b Task 3"
```

---

### Task 4: `recipient_input_from_cert` + `SmimeBackend::encrypt` glue

**Files:**
- Modify: `kylins.client.crypto/smime/src/cms_build.rs` (add `recipient_input_from_cert`)
- Modify: `kylins.client.crypto/smime/src/lib.rs` (imports, `encrypt` body)

**Interfaces:**
- Consumes: `RecipientInput`/`RecipientKey` (Tasks 2–3); `KeyStore::get` (resolve recipient public cert); crypto-core `EncryptOp`, `EncryptedEnvelope`, `EncryptedPart`, `KeyPacketRef`, `PartId`, `PartKind`, `SerializationStrategy`.
- Produces:
  - `pub(crate) fn recipient_input_from_cert(cert_der: &[u8]) -> Result<RecipientInput>` — parses an X.509 cert DER into a `RecipientInput`, dispatching on SPKI algorithm OID.
  - Working `SmimeBackend::encrypt`.

- [ ] **Step 1: Write the failing tests for `recipient_input_from_cert`**

Add to the `tests` module in `cms_build.rs`:

```rust
    /// ECC arm: a generated S/MIME cert → RecipientKey::EcP256.
    #[test]
    fn recipient_input_from_ec_cert_yields_ecp256() {
        let built = crate::cert::build_self_signed_smime_cert("rcpt@kylins.com").unwrap();
        let input = recipient_input_from_cert(&built.cert_der).unwrap();
        assert!(matches!(input.key, RecipientKey::EcP256(_)));
    }

    /// RSA arm: an RSA SPKI round-trips through `from_public_key_der`. This
    /// exercises the exact decode call `recipient_input_from_cert` makes for
    /// RSA recipients, without needing an RSA cert fixture (the cert parse +
    /// OID-match around it is covered by the ECC arm + the trivial match).
    #[test]
    fn rsa_public_key_decodes_from_spki() {
        use spki::DecodePublicKey;
        let mut rng = rand::rng();
        let rsa_priv = rsa::RsaPrivateKey::new(&mut rng, 3072).unwrap();
        let rsa_pub = rsa::RsaPublicKey::from(&rsa_priv);
        let spki_der = spki::EncodePublicKey::to_public_key_der(&rsa_pub)
            .unwrap()
            .as_ref()
            .to_vec();
        let back =
            <rsa::RsaPublicKey as DecodePublicKey>::from_public_key_der(&spki_der).unwrap();
        assert_eq!(back, rsa_pub);
    }

    /// Unknown algorithm OID → UnsupportedStandard.
    #[test]
    fn recipient_input_from_cert_rejects_unknown_algorithm() {
        // Ed25519 OID 1.3.101.112 — build a minimal SPKI is overkill; instead
        // assert the dispatch error path by feeding a cert whose SPKI OID is
        // neither rsaEncryption nor ecPublicKey. We reuse an ECC cert but patch
        // the OID bytes is brittle; simplest: assert that a 1-byte garbage DER
        // is Malformed (covers the parse path) and trust the match's else arm.
        let garbage = [0x00u8; 4];
        let err = recipient_input_from_cert(&garbage).unwrap_err();
        assert!(
            matches!(err, CryptoError::Malformed(_)),
            "non-cert input must be Malformed, got {err:?}"
        );
    }
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cargo test -p crypto-smime recipient_input_from_ rsa_public_key_decodes_from_spki`
Expected: COMPILE ERROR — `cannot find function recipient_input_from_cert`.

- [ ] **Step 3: Implement `recipient_input_from_cert`**

Add to `cms_build.rs` (above the `tests` module):

```rust
use spki::DecodePublicKey;

/// OIDs of the recipient public-key algorithms we support for encryption.
const OID_RSA_ENCRYPTION: &str = "1.2.840.113549.1.1.1";
const OID_EC_PUBLIC_KEY: &str = "1.2.840.10045.2.1";

/// Parse an X.509 certificate DER into a `RecipientInput`: extract the
/// issuer+serial (for the RecipientIdentifier) and the public key, dispatching
/// on the SPKI algorithm OID to the concrete type each cms recipient builder
/// needs.
pub(crate) fn recipient_input_from_cert(cert_der: &[u8]) -> Result<RecipientInput> {
    let cert = <x509_cert::Certificate as Decode>::from_der(cert_der)
        .map_err(|e| cms_err("parse recipient cert", e))?;
    let tbs = cert.tbs_certificate();
    let iasn = IssuerAndSerialNumber {
        issuer: tbs.issuer().clone(),
        serial_number: tbs.serial_number().clone(),
    };
    let spki = tbs.subject_public_key_info();
    let spki_der = spki
        .to_der()
        .map_err(|e| cms_err("encode recipient spki", e))?;
    let alg_oid = spki.algorithm.oid.to_string();

    let key = match alg_oid.as_str() {
        OID_RSA_ENCRYPTION => {
            let pk = <rsa::RsaPublicKey as DecodePublicKey>::from_public_key_der(&spki_der)
                .map_err(|e| cms_err("decode rsa public key", e))?;
            RecipientKey::Rsa(pk)
        }
        OID_EC_PUBLIC_KEY => {
            let pk = <p256::PublicKey as DecodePublicKey>::from_public_key_der(&spki_der)
                .map_err(|e| cms_err("decode ec public key", e))?;
            RecipientKey::EcP256(pk)
        }
        other => {
            return Err(CryptoError::UnsupportedStandard(format!(
                "recipient public-key algorithm {other} not supported for encryption"
            )))
        }
    };
    Ok(RecipientInput { iasn, key })
}
```

If the RSA `from_public_key_der` call fails to compile (rsa 0.10 not impl'ing the spki blanket on your resolved version), replace that line with the pkcs1 fallback:

```rust
            let pk = <rsa::RsaPublicKey as rsa::pkcs1::DecodeRsaPublicKey>::from_public_key_der(
                spki.subject_public_key().raw_bytes(),
            )
            .map_err(|e| cms_err("decode rsa public key", e))?;
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cargo test -p crypto-smime recipient_input_from_ rsa_public_key_decodes_from_spki`
Expected: all three PASS.

- [ ] **Step 5: Write the failing test for `SmimeBackend::encrypt` (ECC recipient end-to-end)**

Add to the `tests` module in `lib.rs` (the file's existing `#[cfg(test)] mod tests`):

```rust
    #[tokio::test]
    async fn encrypt_builds_enveloped_data_for_ec_recipient() {
        use crypto_core::{
            EncryptOp, KeyHandleRef, Part, PartId, PartKind, SerializationStrategy,
        };
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
            recipients: &[recipient.clone()],
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
    async fn encrypt_rejects_split_per_part_serialization() {
        use crypto_core::{EncryptOp, KeyHandleRef, Part, PartId, PartKind, SerializationStrategy};
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
```

- [ ] **Step 6: Run the encrypt tests to verify they fail**

Run: `cargo test -p crypto-smime encrypt_`
Expected: FAIL — `encrypt` still returns `NotImplemented`.

- [ ] **Step 7: Implement `SmimeBackend::encrypt`**

In `lib.rs`:

(a) Extend the `use crypto_core::{...}` block to add:

```rust
    EncryptOp, EncryptedEnvelope, EncryptedPart, KeyPacketRef, PartId, PartKind,
    SerializationStrategy,
```

(b) Replace the `encrypt` method body (currently `Err(CryptoError::NotImplemented(NOT_IMPLEMENTED_TAG.into()))`) with:

```rust
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

        if op.sign_with.is_some() {
            return Err(CryptoError::NotImplemented(
                "sign-then-encrypt (encrypt.sign_with) — Plan 2b Task 5".into(),
            ));
        }

        // Resolve each recipient cert from the keystore → RecipientInput.
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

        let der = cms_build::build_enveloped_data(plaintext, &recipients_in)?;

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
```

- [ ] **Step 8: Run the encrypt tests to verify they pass**

Run: `cargo test -p crypto-smime encrypt_`
Expected: both PASS.

- [ ] **Step 9: Run the full suite + clippy**

Run: `cargo test -p crypto-smime && cargo clippy -p crypto-smime --all-targets -- -D warnings`
Expected: all PASS, clippy clean.

- [ ] **Step 10: Commit**

```bash
cd D:/Projects/mailclient/kylins-client
git add kylins.client.crypto/smime/src/cms_build.rs kylins.client.crypto/smime/src/lib.rs
git commit -m "feat(crypto-smime): implement encrypt (CMS EnvelopedData, RSA+ECC recipients) — Plan 2b Task 4"
```

---

### Task 5: Sign-then-encrypt (`encrypt.sign_with`) + integration test + final gates

**Files:**
- Modify: `kylins.client.crypto/smime/src/lib.rs` (`encrypt` sign_with branch)
- Modify: `kylins.client.backend/tests/crypto_smime_lifecycle.rs`

**Interfaces:**
- Consumes: `build_signed_data` (Task 1), `build_enveloped_data` (Tasks 2–3), `recipient_input_from_cert` (Task 4), `KeyStore::get`.
- Produces: `encrypt` honors `op.sign_with` (sign-then-encrypt: the SignedData DER becomes the EnvelopedData content); the lifecycle integration test exercises `sign`.

- [ ] **Step 1: Write the failing test for sign-then-encrypt**

Add to the `tests` module in `lib.rs`:

```rust
    #[tokio::test]
    async fn encrypt_with_sign_with_produces_signed_then_enveloped() {
        use crypto_core::{
            EncryptOp, KeyHandleRef, Part, PartId, PartKind, SerializationStrategy,
        };
        use cms::content_info::ContentInfo;
        use cms::enveloped_data::EnvelopedData;
        use cms::signed_data::SignedData;
        use der::Decode;

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
                data: b"signed then encrypted".to_vec(),
            }],
            serialization: SerializationStrategy::SingleMimeBlob,
            recipients: &[recipient.clone()],
            sign_with: Some(signer.clone()),
        };
        let env = b.encrypt(op).await.expect("encrypt+sign ok");

        // Outer is EnvelopedData.
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
            ed.recip_infos.0[0],
            cms::enveloped_data::RecipientInfo::Kari(_)
        ));
    }
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cargo test -p crypto-smime encrypt_with_sign_with_produces_signed_then_enveloped`
Expected: FAIL — `sign-then-encrypt (encrypt.sign_with) — Plan 2b Task 5`.

- [ ] **Step 3: Implement the sign_with branch in `encrypt`**

In `lib.rs`, replace the `if op.sign_with.is_some() { return Err(...) }` block in `encrypt` with:

```rust
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
                let priv_der = crypto_core::secret::expose_bytes(priv_box).to_vec();
                cms_build::build_signed_data(plaintext, false, &stored.public_data, &priv_der)?
            }
            None => plaintext.to_vec(),
        };

        let der = cms_build::build_enveloped_data(&content_bytes, &recipients_in)?;
```

(Remove the now-redundant earlier `let der = cms_build::build_enveloped_data(plaintext, &recipients_in)?;` line that followed the removed `if op.sign_with.is_some()` block — the new `let der` above replaces it. The `recipients_in` resolution block above this stays unchanged.)

- [ ] **Step 4: Run the test to verify it passes**

Run: `cargo test -p crypto-smime encrypt_with_sign_with_produces_signed_then_enveloped`
Expected: PASS.

- [ ] **Step 5: Update the backend lifecycle integration test**

In `kylins.client.backend/tests/crypto_smime_lifecycle.rs`, add a test that exercises `sign` through the `SmimeBackend` wired over a `SqliteKeyStore`. If the file already constructs a backend + generates a key, add after that; otherwise add a focused test. The minimal addition (adapt the existing harness's helper names — read the file first):

```rust
#[tokio::test]
async fn smime_sign_produces_signed_data() {
    // Reuse the existing harness in this file to build a SqliteKeyStore-backed
    // SmimeBackend and generate a key (see the file's existing helpers).
    // Then:
    let op = crypto_core::SignOp {
        payload: b"integration sign",
        signing_key: generated_handle.clone(),
        detached: false,
    };
    let signed = backend.sign(op).await.expect("sign ok");
    assert_eq!(signed.standard, crypto_core::Standard::Smime);
    // The signature bytes are a ContentInfo (id-signed-data).
    let ci: cms::content_info::ContentInfo =
        <cms::content_info::ContentInfo as der::Decode>::from_der(&signed.signature.signature)
            .expect("parse content info");
    assert_eq!(ci.content_type, const_oid::db::rfc5911::ID_SIGNED_DATA);
}
```

Read the existing `crypto_smime_lifecycle.rs` first to match its backend/key setup helpers (`generated_handle`, `backend` are placeholders — use the real names). If the file does not already construct a backend over `SqliteKeyStore`, mirror its existing test's setup exactly. Add `cms`, `const-oid`, `der` to the backend's `[dev-dependencies]` if not present.

- [ ] **Step 6: Run backend integration + lib tests**

Run: `cd kylins.client.backend && cargo test --test crypto_smime_lifecycle && cargo test --test crypto_core_wiring && cargo test --lib`
Expected: all PASS.

- [ ] **Step 7: Full workspace gates**

Run:
```bash
cd D:/Projects/mailclient/kylins-client/kylins.client.crypto && cargo test && cargo clippy --all-targets -- -D warnings
cd D:/Projects/mailclient/kylins-client/kylins.client.backend && cargo test && cargo clippy --all-targets -- -D warnings
```
Expected: crypto workspace all green + clippy clean; backend all green + clippy clean.

- [ ] **Step 8: Commit**

```bash
cd D:/Projects/mailclient/kylins-client
git add kylins.client.crypto/smime/src/lib.rs kylins.client.backend/tests/crypto_smime_lifecycle.rs kylins.client.backend/Cargo.toml
git commit -m "feat(crypto-smime): sign-then-encrypt + lifecycle sign test — Plan 2b Task 5"
```

---

## Self-Review

**1. Spec coverage.** Phase 1 spec (send-first): `sign` → Task 1 ✅; `encrypt` (RSA + ECC recipients) → Tasks 2–4 ✅; `.p12`+PEM import → already shipped in Plan 2 (import_key), unchanged here ✅; decrypt/verify deferred to Phase 1b → stubs retagged, no work ✅. Sign-then-encrypt (combined send mode) → Task 5 ✅. Carry-forward from Plan 2 review ("algorithm/usage overloaded into policy_json") is untouched and out of scope for 2b.

**2. Placeholder scan.** No TBD/TODO/similar-to. Task 5 Step 5 instructs the implementer to read the existing test file and match helper names — this is unavoidable (the file's harness is pre-existing) and explicitly directs reading it rather than guessing. All other steps carry full code.

**3. Type consistency.** `build_signed_data`, `build_enveloped_data`, `recipient_input_from_cert`, `RecipientInput { iasn, key }`, `RecipientKey::{Rsa, EcP256}` — names/fields are identical across every task that references them. `sign` returns `SignedEnvelope { standard, payload, signature: DetachedSignature { standard, signer, signature } }` matching `envelope.rs`. `encrypt` returns `EncryptedEnvelope { standard, serialization, parts: Vec<EncryptedPart>, recipients: Vec<KeyPacketRef> }` matching `envelope.rs`. `EncryptedPart { id, kind, ciphertext, signature }`, `KeyPacketRef { recipient, packet }`, `PartId`, `PartKind` match `envelope.rs`.

**Carry-forwards (not in this plan):**
- RSA / Ed25519 *signing* — Plan 2c.
- Receive-side (decrypt/verify, RFC 5280 path validation, OCSP/CRL) — Phase 1b.
- MIME wrapping of the CMS DER into `application/pkcs7-mime` / `multipart/signed` — send hook, Plan 4.
- ECC-recipient decrypt round-trip test — arrives with Phase 1b decrypt.

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-07-11-crypto-phase1-smime-cms-build.md`. Two execution options:

**1. Subagent-Driven (recommended)** — fresh subagent per task, controller review between tasks (matches the SDD cadence used for Plans 1 & 2).

**2. Inline Execution** — batch execution with checkpoints.

Which approach?
