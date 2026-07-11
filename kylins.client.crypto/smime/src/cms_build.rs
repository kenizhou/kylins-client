//! Pure CMS builders for S/MIME send-side operations (Plan 2b).
//!
//! These helpers turn raw message bytes + parsed keys into CMS DER. They hold
//! no state, do no I/O, and never touch the keystore — `SmimeBackend`'s trait
//! methods are the glue that resolves keys and maps to/from crypto-core's
//! neutral envelopes.

use crypto_core::{CryptoError, Result};
use cms::builder::{
    ContentEncryptionAlgorithm, DhSinglePassStdDhKdf, EcKeyEncryptionInfo, EnvelopedDataBuilder,
    KeyAgreeRecipientInfoBuilder, KeyEncryptionInfo, KeyTransRecipientInfoBuilder,
    SignedDataBuilder, SignerInfoBuilder,
};
use cms::cert::{CertificateChoices, IssuerAndSerialNumber};
use cms::content_info::ContentInfo;
use cms::signed_data::{EncapsulatedContentInfo, SignerIdentifier};
use der::asn1::OctetString;
use der::{Any, AnyRef, Decode, Encode, Tag};
use p256::NistP256;
use p256::pkcs8::DecodePrivateKey;
use spki::AlgorithmIdentifierOwned;
use spki::DecodePublicKey;
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
        .add_signer_info::<ecdsa::SigningKey<NistP256>, p256::ecdsa::DerSignature>(
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
    // An empty recipient list would produce a syntactically-valid but
    // undecryptable EnvelopedData blob — fail fast so callers can't silently
    // emit ciphertext nobody can read.
    if recipients.is_empty() {
        return Err(CryptoError::Malformed(
            "enveloped data: at least one recipient is required".into(),
        ));
    }
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
                let ri = KeyTransRecipientInfoBuilder::new(
                    rid,
                    KeyEncryptionInfo::Rsa(pk.clone()),
                )
                .map_err(|e| cms_err("ktri builder", e))?;
                builder
                    .add_recipient_info(ri)
                    .map_err(|e| cms_err("add ktri recipient", e))?;
            }
            RecipientKey::EcP256(pk) => {
                use cms::enveloped_data::KeyAgreeRecipientIdentifier;
                // kari uses a distinct identifier type from ktri — both have an
                // IssuerAndSerialNumber variant, but the enums differ.
                let rid = KeyAgreeRecipientIdentifier::IssuerAndSerialNumber(r.iasn.clone());
                // Ephemeral-static ECDH on P-256 (RFC 5753), AES-192 key wrap,
                // AES-128 content cipher. R (rng) is PhantomData and is inferred
                // from the `&mut rng` passed to `builder.build_with_rng` below,
                // so `_` is used there; the curve/KA/KW/Enc params are NOT
                // inferable from `new`'s args and must stay explicit.
                let ri = KeyAgreeRecipientInfoBuilder::<
                    _,
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

/// OIDs of the recipient public-key algorithms supported for S/MIME encryption.
/// `const_oid::ObjectIdentifier` (not `&str`) so dispatch compares by OID value
/// with no per-recipient heap allocation, and the values are compile-time-checked.
const OID_RSA_ENCRYPTION: const_oid::ObjectIdentifier =
    const_oid::ObjectIdentifier::new_unwrap("1.2.840.113549.1.1.1");
const OID_EC_PUBLIC_KEY: const_oid::ObjectIdentifier =
    const_oid::ObjectIdentifier::new_unwrap("1.2.840.10045.2.1");

/// Parse an X.509 certificate DER into a `RecipientInput`: extract the
/// issuer+serial (for the RecipientIdentifier) and the public key, dispatching
/// on the SPKI algorithm OID to the concrete type each cms recipient builder
/// needs (RSA → ktri key transport, EC P-256 → kari key agreement). Any other
/// algorithm (Ed25519, SM2, ...) is `UnsupportedStandard`. Only the recipient's
/// PUBLIC cert is needed — no private material is touched here.
pub(crate) fn recipient_input_from_cert(cert_der: &[u8]) -> Result<RecipientInput> {
    let cert = <Certificate as Decode>::from_der(cert_der)
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
    let key = if spki.algorithm.oid == OID_RSA_ENCRYPTION {
        let pk = <rsa::RsaPublicKey as DecodePublicKey>::from_public_key_der(&spki_der)
            .map_err(|e| cms_err("decode rsa public key", e))?;
        RecipientKey::Rsa(pk)
    } else if spki.algorithm.oid == OID_EC_PUBLIC_KEY {
        let pk = <p256::PublicKey as DecodePublicKey>::from_public_key_der(&spki_der)
            .map_err(|e| cms_err("decode ec public key", e))?;
        RecipientKey::EcP256(pk)
    } else {
        return Err(CryptoError::UnsupportedStandard(format!(
            "recipient public-key algorithm {} not supported for encryption",
            spki.algorithm.oid
        )));
    };
    Ok(RecipientInput { iasn, key })
}

#[cfg(test)]
mod tests {
    use super::*;
    use cms::signed_data::SignedData;
    use der::{Decode, Encode};
    use p256::ecdsa::{VerifyingKey, signature::Verifier};
    use spki::DecodePublicKey;

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
        let signer_info = &sd.signer_infos.0.as_slice()[0];
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
        let ktri = match env.recip_infos.0.get(0).unwrap() {
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
        let pt = Aes128CbcDec::new(
            cek.as_slice().try_into().unwrap(),
            iv_octet.as_bytes().try_into().unwrap(),
        )
        .decrypt_padded_vec::<Pkcs7>(ct.as_bytes())
        .expect("decrypt content");
        assert_eq!(pt, plaintext);
    }

    /// ECC P-256 recipient: build EnvelopedData via kari and assert structure.
    /// Full decrypt round-trip for kari arrives with Phase 1b (decrypt); the
    /// build path is cryptographically proven upstream by
    /// cms/tests/builder/kari.rs::test_build_enveloped_data_ec (openssl-decoded)
    /// using identical builder calls.
    #[test]
    fn build_enveloped_data_builds_kari_for_ec_recipient() {
        use cms::enveloped_data::RecipientInfo;
        use p256::elliptic_curve::Generate;

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
        match env.recip_infos.0.get(0).unwrap() {
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
        use p256::elliptic_curve::Generate;
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
        assert!(matches!(env.recip_infos.0.get(0).unwrap(), RecipientInfo::Ktri(_)));
        assert!(matches!(env.recip_infos.0.get(1).unwrap(), RecipientInfo::Kari(_)));
    }

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

    /// Malformed (non-cert) DER → Malformed. This exercises the cert-parse
    /// error path, NOT the unknown-OID match arm — constructing a cert whose
    /// SPKI algorithm OID is neither rsaEncryption nor ecPublicKey without an
    /// Ed25519 dep isn't practical. The unknown-OID else-arm is a trivial
    /// `match` return, covered by code inspection of `recipient_input_from_cert`.
    #[test]
    fn recipient_input_from_cert_rejects_malformed_der() {
        let garbage = [0x00u8; 4];
        // Match directly instead of `.unwrap_err()` so `RecipientInput` need not
        // derive Debug purely for this one test assertion.
        match recipient_input_from_cert(&garbage) {
            Err(err) => assert!(
                matches!(err, CryptoError::Malformed(_)),
                "non-cert input must be Malformed, got {err:?}"
            ),
            Ok(_) => panic!("non-cert input must error, got Ok"),
        }
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
}
