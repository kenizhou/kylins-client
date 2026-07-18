//! Pure CMS parsers for S/MIME receive (Plan 1b / Phase 1b Plan 1).
//!
//! Mirror of [`crate::cms_build`] in the receive direction: turns CMS
//! `EnvelopedData` DER produced by the send side back into the original
//! plaintext. Holds no state, does no I/O, never touches the keystore —
//! [`crate::SmimeBackend::decrypt`] is the glue that resolves keys and maps
//! to/from crypto-core's neutral envelopes.
//!
//! Two recipient-info paths are supported:
//! - **ktri** (key transport, RSA): PKCS#1v1.5 unwrap of the content-encryption key.
//! - **kari** (key agreement, ECC P-256): ephemeral-static ECDH with ANSI X9.63 KDF
//!   (SHA-1/224/256/384/512, dispatched on the kari KDF OID per RFC 5753 §7.2)
//!   to derive a KEK, then AES key-wrap (RFC 3394) unwrap of the CEK.
//!
//! The kari path is written fresh (no upstream consume-side template); it reverses
//! the build-side `KeyAgreeRecipientInfoBuilder<NistP256, DhSinglePassStdDhKdf<Sha256>,
//! AesKw<Aes192>, Aes128>` per RFC 5753.

use cms::cert::{CertificateChoices, IssuerAndSerialNumber};
use cms::content_info::ContentInfo;
use cms::enveloped_data::{EnvelopedData, RecipientInfo};
use cms::signed_data::{CertificateSet, SignedData, SignerIdentifier};
use crypto_core::{CryptoError, Result};
use der::asn1::OctetString;
use der::{Decode, Encode};
use spki::AlgorithmIdentifierOwned;
use x509_cert::Certificate;

// ──────────────────────────── KDF SharedInfo ────────────────────────────

/// RFC 5753 §7.2 `EccCmsSharedInfo` — the KDF `SharedInfo`. Mirrors the vendored
/// cms builder's private type byte-for-byte (it is not re-exported). The KDF
/// input is the DER encoding of this structure; mismatches here produce a wrong
/// KEK and the AES-KW integrity check fails.
#[derive(der::Sequence)]
struct EccCmsSharedInfo {
    /// Object identifier of the key-encryption (wrap) algorithm + any parameters.
    /// In this spec, AES key wraps have ABSENT parameters (RFC 3565 §2.3.2).
    key_info: AlgorithmIdentifierOwned,
    /// Optional user keying material (`ukm` from the kari). Maps to `kari.ukm`.
    #[asn1(
        context_specific = "0",
        tag_mode = "EXPLICIT",
        constructed = "true",
        optional = "true"
    )]
    entity_u_info: Option<OctetString>,
    /// Length of the generated KEK, in bits, as a 4-byte big-endian integer
    /// (e.g. `00 00 00 C0` for AES-192 = 192 bits).
    #[asn1(context_specific = "2", tag_mode = "EXPLICIT", constructed = "true")]
    supp_pub_info: OctetString,
}

// ────────────────────────────── error helper ─────────────────────────────

/// Map any cms/DER/crypto error into a `CryptoError::Malformed` with context,
/// mirroring [`crate::cms_build::cms_err`].
fn cms_err(context: &str, e: impl std::fmt::Display) -> CryptoError {
    CryptoError::Malformed(format!("cms {context}: {e}"))
}

// ─────────────────────────── public entry point ───────────────────────────

/// Decrypt a CMS `EnvelopedData` blob (wrapped in `ContentInfo`) back to the
/// original plaintext. The recipient is identified by its X.509 cert DER
/// (matched against the `RecipientInfo`'s IssuerAndSerialNumber), and the
/// private key is supplied as unencrypted PKCS#8 DER.
///
/// Supports both ktri (RSA, PKCS#1v1.5 key transport) and kari (ECC P-256,
/// ephemeral-static ECDH + AES key wrap) recipient infos. Content decryption
/// supports AES-128-CBC and AES-256-CBC (the build side always emits AES-128;
/// AES-256 is included for forward-compat with messages from other clients).
///
/// `recipient_priv_pkcs8_der` is sensitive — callers wrap it in
/// `zeroize::Zeroizing` (see `SmimeBackend::decrypt`); it is read here but never
/// copied beyond the plaintext output.
pub(crate) fn decrypt_enveloped(
    enveloped_der: &[u8],
    recipient_cert_der: &[u8],
    recipient_priv_pkcs8_der: &[u8],
) -> Result<Vec<u8>> {
    // 1. Parse ContentInfo → re-derive inner → EnvelopedData.
    //    The vendored cms stores the EnvelopedData as an `Any` inside the
    //    ContentInfo; re-deriving the Any content gives the raw EnvelopedData
    //    DER, which we then decode.
    let ci = ContentInfo::from_der(enveloped_der)
        .map_err(|e| cms_err("parse ContentInfo", e))?;
    let inner = ci
        .content
        .to_der()
        .map_err(|e| cms_err("re-derive ContentInfo content", e))?;
    let env = EnvelopedData::from_der(&inner)
        .map_err(|e| cms_err("parse EnvelopedData", e))?;

    // 2. Parse our recipient cert → IssuerAndSerialNumber for RecipientInfo match.
    let our_cert = <Certificate as Decode>::from_der(recipient_cert_der)
        .map_err(|e| cms_err("parse recipient cert", e))?;
    let our_iasn = IssuerAndSerialNumber {
        issuer: our_cert.tbs_certificate().issuer().clone(),
        serial_number: our_cert.tbs_certificate().serial_number().clone(),
    };

    // 3. Find our recipient and unwrap the content-encryption key (CEK).
    let cek = find_and_unwrap_cek(&env.recip_infos.0, &our_iasn, recipient_priv_pkcs8_der)?;

    // 4. AES-CBC decrypt the encrypted content using the CEK + IV from params.
    let eci = &env.encrypted_content;
    let iv = parse_aes_cbc_iv(&eci.content_enc_alg)?;
    let enc = eci.encrypted_content.as_ref().ok_or_else(|| {
        CryptoError::Malformed("EnvelopedData: encrypted_content absent".into())
    })?;
    aes_cbc_decrypt(&cek, &iv, &eci.content_enc_alg.oid, enc.as_bytes())
}

// ───────────────────────── recipient matching + CEK unwrap ────────────────

/// Walk the `RecipientInfos` SET, find the entry whose identifier matches
/// `our_iasn`, and unwrap the content-encryption key. ktri → RSA-unwrap;
/// kari → ECDH + KDF + AES-KW-unwrap. Returns `Malformed` if no recipient
/// matches (the message was not encrypted to us).
fn find_and_unwrap_cek(
    infos: &der::asn1::SetOfVec<RecipientInfo>,
    our_iasn: &IssuerAndSerialNumber,
    priv_pkcs8_der: &[u8],
) -> Result<Vec<u8>> {
    for ri in infos.iter() {
        match ri {
            RecipientInfo::Ktri(ktri) => {
                if ktri.rid
                    == cms::enveloped_data::RecipientIdentifier::IssuerAndSerialNumber(
                        our_iasn.clone(),
                    )
                {
                    return unwrap_ktri_cek(ktri, priv_pkcs8_der);
                }
            }
            RecipientInfo::Kari(kari) => {
                // kari carries a Vec of RecipientEncryptedKey; find ours by rid.
                for rek in &kari.recipient_enc_keys {
                    if rek.rid
                        == cms::enveloped_data::KeyAgreeRecipientIdentifier::IssuerAndSerialNumber(
                            our_iasn.clone(),
                        )
                    {
                        return unwrap_kari_cek(kari, rek, priv_pkcs8_der);
                    }
                }
            }
            // Kekri / Pwri / Ori — not supported; skip (may still match a later recipient).
            _ => continue,
        }
    }
    Err(CryptoError::Malformed(
        "no matching recipient in EnvelopedData".into(),
    ))
}

// ───────────────────────────── ktri (RSA) path ────────────────────────────

/// RSA PKCS#1v1.5 key transport unwrap: decrypt `ktri.enc_key` with the
/// recipient's RSA private key → CEK. The CEK size must match the content
/// cipher (16 bytes for AES-128); we validate that in `aes_cbc_decrypt`.
fn unwrap_ktri_cek(
    ktri: &cms::enveloped_data::KeyTransRecipientInfo,
    priv_pkcs8_der: &[u8],
) -> Result<Vec<u8>> {
    let rsa_priv = <rsa::RsaPrivateKey as rsa::pkcs8::DecodePrivateKey>::from_pkcs8_der(
        priv_pkcs8_der,
    )
    .map_err(|e| cms_err("parse RSA PKCS#8 private key", e))?;
    rsa_priv
        .decrypt(rsa::Pkcs1v15Encrypt, ktri.enc_key.as_bytes())
        .map_err(|e| cms_err("RSA PKCS#1v1.5 CEK unwrap", e))
}

// ─────────────────────────── kari (ECC P-256) path ────────────────────────

/// ECC P-256 ephemeral-static ECDH key-agreement unwrap, per RFC 5753 §3.1.2.
///
/// Reverses the build-side `KeyAgreeRecipientInfoBuilder` sequence:
/// 1. Recover the originator's ephemeral ECDH public key from `kari.originator`.
/// 2. ECDH: `diffie_hellman(our_static_secret, originator_ephemeral_pubkey)`.
/// 3. Reconstruct `EccCmsSharedInfo { key_info=kw_alg, entity_u_info=ukm, supp_pub_info=kek_bits }`
///    and DER-encode it — this is the KDF `SharedInfo`.
/// 4. ANSI X9.63 KDF, hash dispatched on `kari.key_enc_alg.oid`
///    (RFC 5753 §7.2 — SHA-1/224/256/384/512): derive the KEK from
///    `Z || SharedInfo`.
/// 5. AES-192-KW unwrap `rek.enc_key` → CEK (AES-128 key).
fn unwrap_kari_cek(
    kari: &cms::enveloped_data::KeyAgreeRecipientInfo,
    rek: &cms::enveloped_data::RecipientEncryptedKey,
    priv_pkcs8_der: &[u8],
) -> Result<Vec<u8>> {
    // 1. Originator ephemeral public key (SEC1 uncompressed point).
    let originator_pub = match &kari.originator {
        cms::enveloped_data::OriginatorIdentifierOrKey::OriginatorKey(ok) => ok,
        _ => {
            return Err(CryptoError::Malformed(
                "kari: originator is not OriginatorKey (only ephemeral-static ECDH supported)"
                    .into(),
            ));
        }
    };
    let originator_point_bytes = originator_pub.public_key.as_bytes().ok_or_else(|| {
        CryptoError::Malformed("kari: originator public key has non-byte-aligned bits".into())
    })?;
    let originator_point = p256::PublicKey::from_sec1_bytes(originator_point_bytes)
        .map_err(|e| cms_err("parse originator P-256 SEC1 point", e))?;

    // 2. Our static private key + ECDH.
    let our_secret = <p256::SecretKey as p256::pkcs8::DecodePrivateKey>::from_pkcs8_der(
        priv_pkcs8_der,
    )
    .map_err(|e| cms_err("parse P-256 PKCS#8 private key", e))?;
    let shared = p256::ecdh::diffie_hellman(
        our_secret.to_nonzero_scalar(),
        originator_point.as_affine(),
    );

    // 3. Reconstruct EccCmsSharedInfo. The key-encryption (wrap) algorithm is
    //    nested as an AlgorithmIdentifier inside `kari.key_enc_alg.parameters`.
    let kw_alg = parse_key_wrap_algorithm(&kari.key_enc_alg)?;
    let kek_byte_len = aes_kek_byte_len(&kw_alg.oid)?;
    let kek_bit_len: u32 = (kek_byte_len as u32) * 8;
    let shared_info = EccCmsSharedInfo {
        key_info: kw_alg,
        entity_u_info: kari.ukm.clone(),
        supp_pub_info: OctetString::new(kek_bit_len.to_be_bytes().to_vec())
            .map_err(|e| cms_err("build suppPubInfo", e))?,
    };
    let shared_info_der = shared_info
        .to_der()
        .map_err(|e| cms_err("encode EccCmsSharedInfo", e))?;

    // 4. ANSI X9.63 KDF (X9.63 / NIST SP 800-56A §5.8.1.2 "concatenation KDF"):
    //    K_i = Hash(Z || Counter_i || SharedInfo), Counter starts at 1 (32-bit BE).
    //
    //    Hash dispatch per RFC 5753 §7.2: the KDF hash is identified by
    //    `kari.key_enc_alg.oid` itself (the vendored cms builder writes
    //    `KA::OID` there — e.g. `dhSinglePass-stdDH-sha256kdf-scheme` for our
    //    build side, `dhSinglePass-stdDH-sha1kdf-scheme` for openssl's default).
    //    SHA-1 is the historical openssl/NSS default and the G7 T3 interop gap;
    //    SHA-256 is our build-side path. SHA-224/384/512 are included for
    //    forward-compat (RFC 5753 §7.2.1 MUST-implement list).
    let kek = ansi_x963_kdf_dispatch(
        &kari.key_enc_alg.oid,
        shared.raw_secret_bytes(),
        &shared_info_der,
        kek_byte_len,
    )?;

    // 5. AES-KW unwrap the CEK.
    aes_kw_unwrap(&kek, rek.enc_key.as_bytes())
}

/// Extract the inner key-wrap `AlgorithmIdentifier` from `kari.key_enc_alg`.
/// The build side stores it as: `{ kdf_oid, parameters: DER(AlgorithmIdentifier{kw_oid}) }`.
fn parse_key_wrap_algorithm(key_enc_alg: &AlgorithmIdentifierOwned) -> Result<AlgorithmIdentifierOwned> {
    let params_any = key_enc_alg.parameters.as_ref().ok_or_else(|| {
        CryptoError::Malformed("kari: key_enc_alg missing wrap-algorithm parameters".into())
    })?;
    let params_der = params_any
        .to_der()
        .map_err(|e| cms_err("re-derive kari key_enc_alg parameters", e))?;
    AlgorithmIdentifierOwned::from_der(&params_der)
        .map_err(|e| cms_err("parse kari key-wrap AlgorithmIdentifier", e))
}

/// AES key-wrap OID → KEK byte length. Only the OIDs the build side emits are
/// supported here (AES-128/192/256-wrap); anything else is `Malformed`.
fn aes_kek_byte_len(oid: &der::asn1::ObjectIdentifier) -> Result<usize> {
    if *oid == const_oid::db::rfc5911::ID_AES_128_WRAP {
        Ok(16)
    } else if *oid == const_oid::db::rfc5911::ID_AES_192_WRAP {
        Ok(24)
    } else if *oid == const_oid::db::rfc5911::ID_AES_256_WRAP {
        Ok(32)
    } else {
        Err(CryptoError::Malformed(format!(
            "unsupported key-wrap algorithm OID: {oid}"
        )))
    }
}

/// Dispatch the ANSI X9.63 KDF over the hash identified by `kdf_oid`. Per
/// RFC 5753 §7.2, the KDF hash is identified by the `kari.key_enc_alg.oid`
/// itself (a `dhSinglePass-stdDH-shaXkdf-scheme` OID). Supports SHA-1 (openssl
/// / NSS historical default), SHA-256 (our build side), and SHA-224/384/512
/// (RFC 5753 §7.2.1 full list). Any other OID → `Malformed`.
///
/// This dispatch is the G7 T5 fix for the interop gap where openssl-encrypted
/// kari messages (SHA-1 KDF) failed to decrypt because the receive path
/// hardcoded SHA-256.
fn ansi_x963_kdf_dispatch(
    kdf_oid: &der::asn1::ObjectIdentifier,
    z: &[u8],
    shared_info: &[u8],
    out_len: usize,
) -> Result<Vec<u8>> {
    use const_oid::db::rfc5753 as kdf;
    if *kdf_oid == kdf::DH_SINGLE_PASS_STD_DH_SHA_1_KDF_SCHEME {
        ansi_x963_kdf::<sha1::Sha1>(z, shared_info, out_len)
    } else if *kdf_oid == kdf::DH_SINGLE_PASS_STD_DH_SHA_224_KDF_SCHEME {
        ansi_x963_kdf::<sha2::Sha224>(z, shared_info, out_len)
    } else if *kdf_oid == kdf::DH_SINGLE_PASS_STD_DH_SHA_256_KDF_SCHEME {
        ansi_x963_kdf::<sha2::Sha256>(z, shared_info, out_len)
    } else if *kdf_oid == kdf::DH_SINGLE_PASS_STD_DH_SHA_384_KDF_SCHEME {
        ansi_x963_kdf::<sha2::Sha384>(z, shared_info, out_len)
    } else if *kdf_oid == kdf::DH_SINGLE_PASS_STD_DH_SHA_512_KDF_SCHEME {
        ansi_x963_kdf::<sha2::Sha512>(z, shared_info, out_len)
    } else {
        Err(CryptoError::Malformed(format!(
            "kari: unsupported KDF scheme OID: {kdf_oid} \
             (supported: SHA-1/224/256/384/512 dhSinglePass-stdDH-shaXkdf-scheme)"
        )))
    }
}

/// ANSI X9.63 KDF generic over the hash `D`. Produces `out_len` key bytes from
/// `Z` (shared secret) and `shared_info` (DER). K_i = Hash(Z || Counter_i ||
/// SharedInfo), Counter_i = i as 32-bit big-endian starting at 1.
///
/// `D` is `sha2::Digest` (= `digest::Digest` from `digest 0.11`), shared by
/// `sha1::Sha1` and `sha2::Sha256` (both on the 0.11 line). This matches the
/// build-side `ansi_x963_kdf::derive_key_into::<D>` call exactly (same hash,
/// same counter layout, same SharedInfo bytes).
fn ansi_x963_kdf<D>(z: &[u8], shared_info: &[u8], out_len: usize) -> Result<Vec<u8>>
where
    D: sha2::Digest,
{
    if z.is_empty() || out_len == 0 {
        return Err(CryptoError::Malformed(
            "ansi_x963_kdf: empty secret or zero output length".into(),
        ));
    }
    let mut out = Vec::with_capacity(out_len);
    let mut counter: u32 = 1;
    while out.len() < out_len {
        let mut hasher = D::new();
        hasher.update(z);
        hasher.update(counter.to_be_bytes());
        hasher.update(shared_info);
        let block = hasher.finalize();
        let take = (out_len - out.len()).min(block.len());
        out.extend_from_slice(&block[..take]);
        counter = counter
            .checked_add(1)
            .ok_or_else(|| CryptoError::Malformed("ansi_x963_kdf: counter overflow".into()))?;
    }
    Ok(out)
}

// ─────────────────────────── AES key-wrap unwrap ─────────────────────────

/// AES key-wrap (RFC 3394) unwrap, dispatching on KEK size (16/24/32 → Aes128/
/// Aes192/Aes256). The wrapped key includes an 8-byte integrity IV, so the
/// output is 8 bytes shorter than the input. An integrity-check failure (wrong
/// KEK or corrupted ciphertext) returns `Malformed`.
fn aes_kw_unwrap(kek: &[u8], wrapped: &[u8]) -> Result<Vec<u8>> {
    use aes::cipher::KeyInit;

    // The unwrap output is the wrapped key minus the 8-byte semiblock IV.
    let out_len = wrapped
        .len()
        .checked_sub(aes_kw::IV_LEN)
        .filter(|&n| n > 0)
        .ok_or_else(|| CryptoError::Malformed("AES-KW: wrapped key too short".into()))?;
    let mut out = vec![0u8; out_len];

    let cek = match kek.len() {
        16 => {
            let key: &aes::cipher::Key<aes_kw::KwAes128> = kek
                .try_into()
                .map_err(|_| CryptoError::Malformed("AES-128 KEK size".into()))?;
            aes_kw::KwAes128::new(key)
                .unwrap_key(wrapped, &mut out)
                .map_err(|e| cms_err("AES-128-KW unwrap", e))?
        }
        24 => {
            let key: &aes::cipher::Key<aes_kw::KwAes192> = kek
                .try_into()
                .map_err(|_| CryptoError::Malformed("AES-192 KEK size".into()))?;
            aes_kw::KwAes192::new(key)
                .unwrap_key(wrapped, &mut out)
                .map_err(|e| cms_err("AES-192-KW unwrap", e))?
        }
        32 => {
            let key: &aes::cipher::Key<aes_kw::KwAes256> = kek
                .try_into()
                .map_err(|_| CryptoError::Malformed("AES-256 KEK size".into()))?;
            aes_kw::KwAes256::new(key)
                .unwrap_key(wrapped, &mut out)
                .map_err(|e| cms_err("AES-256-KW unwrap", e))?
        }
        other => {
            return Err(CryptoError::Malformed(format!(
                "AES-KW: unsupported KEK size {other} bytes"
            )));
        }
    };
    Ok(cek.to_vec())
}

// ───────────────────────── content decryption helpers ────────────────────

/// Parse the 16-byte AES-CBC IV from `content_enc_alg.parameters`, which is an
/// `OctetString` DER-encoded inside the `Any`. Any AES variant uses a 16-byte IV
/// (block size), so the validation is uniform.
fn parse_aes_cbc_iv(content_enc_alg: &AlgorithmIdentifierOwned) -> Result<[u8; 16]> {
    let params = content_enc_alg.parameters.as_ref().ok_or_else(|| {
        CryptoError::Malformed("content_enc_alg: missing IV parameters".into())
    })?;
    let params_der = params
        .to_der()
        .map_err(|e| cms_err("re-derive content_enc_alg parameters", e))?;
    let iv_oct = OctetString::from_der(&params_der)
        .map_err(|e| cms_err("parse IV OctetString", e))?;
    let iv_bytes = iv_oct.as_bytes();
    if iv_bytes.len() != 16 {
        return Err(CryptoError::Malformed(format!(
            "AES-CBC IV must be 16 bytes, got {}",
            iv_bytes.len()
        )));
    }
    let mut iv = [0u8; 16];
    iv.copy_from_slice(iv_bytes);
    Ok(iv)
}

/// AES-CBC decrypt with PKCS#7 padding, dispatching on the content-encryption
/// OID (AES-128-CBC / AES-256-CBC). AES-192-CBC is included for completeness.
fn aes_cbc_decrypt(
    cek: &[u8],
    iv: &[u8; 16],
    alg_oid: &der::asn1::ObjectIdentifier,
    ct: &[u8],
) -> Result<Vec<u8>> {
    // `cipher` is a transitive dep; we reach its types through `aes`'s
    // re-export to avoid promoting `cipher` from dev-dep to dep.
    use aes::cipher::block_padding::Pkcs7;
    use aes::cipher::{BlockModeDecrypt, KeyIvInit};

    // AES block size is always 16 bytes, so the Iv type is uniform across all
    // three variants — convert once.
    let iv_arr: &aes::cipher::Iv<cbc::Decryptor<aes::Aes128>> = iv.into();

    if *alg_oid == const_oid::db::rfc5911::ID_AES_128_CBC {
        type Dec = cbc::Decryptor<aes::Aes128>;
        let key: &aes::cipher::Key<Dec> = cek
            .try_into()
            .map_err(|_| CryptoError::Malformed("AES-128 CEK must be 16 bytes".into()))?;
        Dec::new(key, iv_arr)
            .decrypt_padded_vec::<Pkcs7>(ct)
            .map_err(|_| CryptoError::Malformed("AES-128-CBC decrypt failed (bad key/padding?)".into()))
    } else if *alg_oid == const_oid::db::rfc5911::ID_AES_192_CBC {
        type Dec = cbc::Decryptor<aes::Aes192>;
        let key: &aes::cipher::Key<Dec> = cek
            .try_into()
            .map_err(|_| CryptoError::Malformed("AES-192 CEK must be 24 bytes".into()))?;
        Dec::new(key, iv_arr)
            .decrypt_padded_vec::<Pkcs7>(ct)
            .map_err(|_| CryptoError::Malformed("AES-192-CBC decrypt failed (bad key/padding?)".into()))
    } else if *alg_oid == const_oid::db::rfc5911::ID_AES_256_CBC {
        type Dec = cbc::Decryptor<aes::Aes256>;
        let key: &aes::cipher::Key<Dec> = cek
            .try_into()
            .map_err(|_| CryptoError::Malformed("AES-256 CEK must be 32 bytes".into()))?;
        Dec::new(key, iv_arr)
            .decrypt_padded_vec::<Pkcs7>(ct)
            .map_err(|_| CryptoError::Malformed("AES-256-CBC decrypt failed (bad key/padding?)".into()))
    } else {
        Err(CryptoError::Malformed(format!(
            "unsupported content-encryption algorithm: {alg_oid}"
        )))
    }
}

// ─────────────────────────── signature verify ────────────────────────────
//
// Mirror of the send-side `cms_build::build_signed_data` in the receive
// direction: turn a CMS `SignedData` blob back into a signature-check verdict.
// This is the **pre-chain** signature check (G3 / Task 3): the cryptographic
// signature is verified against the signer cert embedded in the SignedData;
// cert-chain validation, CRL checks, and trust assessment are G4 (which will
// refine the G3 `ValidUnverified` into `ValidVerified`/`Invalid`).

/// Outcome of a CMS SignedData signature check. `signer_cert_der` and
/// `signer_fingerprint` are `None` only when no usable signer cert was found
/// in the SignedData's `certificates` set (in which case `sig_ok` is `false`
/// and the backend maps the result to `SignatureState::UnknownKey`).
#[derive(Debug)]
pub(crate) struct CmsSigCheck {
    /// Whether the cryptographic signature verifies against the signer cert.
    pub sig_ok: bool,
    /// The matched signer cert DER, when one was located. Read by G4
    /// (cert-chain validation) and by tests; unused at the framework seam
    /// today, so suppressed for dead-code until G4 lands.
    #[allow(dead_code)]
    pub signer_cert_der: Option<Vec<u8>>,
    /// RFC 5280 method-1 SKI (SHA-1 of SPKI, hex-lower) of the signer cert,
    /// when one was located. Matches the framework's `Fingerprint` format.
    pub signer_fingerprint: Option<String>,
    /// CMS `signingTime` signed attribute (OID 1.2.840.113549.1.9.5) as Unix
    /// seconds. `None` when the attribute is absent; the caller (Task 5's
    /// `SmimeBackend::verify`) falls back to `now()` for cert-chain validation
    /// at the verify-time rather than at the signing-time.
    #[allow(dead_code)] // consumed by Task 5's SmimeBackend::verify
    pub signing_time_unix: Option<i64>,
}

/// SHA-256 OID (2.16.840.1.101.3.4.2.1) — matches the build side.
const ID_SHA_256: const_oid::ObjectIdentifier =
    const_oid::ObjectIdentifier::new_unwrap("2.16.840.1.101.3.4.2.1");

/// ECDSA-with-SHA-256 OID (1.2.840.10045.4.3.2) — matches the build side.
const ID_ECDSA_WITH_SHA_256: const_oid::ObjectIdentifier =
    const_oid::ObjectIdentifier::new_unwrap("1.2.840.10045.4.3.2");

/// messageDigest signed-attribute OID (1.2.840.113549.1.9.4, RFC 5652 §11.2).
const ID_MESSAGE_DIGEST: const_oid::ObjectIdentifier =
    const_oid::ObjectIdentifier::new_unwrap("1.2.840.113549.1.9.4");

/// signingTime signed-attribute OID (1.2.840.113549.1.9.5, RFC 5652 §11.3).
const ID_SIGNING_TIME: const_oid::ObjectIdentifier =
    const_oid::ObjectIdentifier::new_unwrap("1.2.840.113549.1.9.5");

// ─── G4-extend: full CMS signature-verify algorithm coverage ───
//
// Spec decision #10 (algorithm coverage): ECDSA P-256 + P-384 + RSA-PKCS1v1.5
// + RSA-PSS. P-521 / Ed25519 are deferred (negligible in deployed S/MIME).
// All OIDs are matched against the SignerInfo's `signatureAlgorithm` field
// (and, for ECDSA, the SPKI curve OID). Unsupported algorithms fall through to
// `sig_ok=false` (→ `SignatureState::Invalid`), NOT a hard `Err` — the
// "unknown algorithm = unverified, not broken" contract is load-bearing for
// the receive UI (a mail signed with an algorithm we don't ship yet must show
// "Invalid signature", not a parse error).

/// SHA-384 OID (2.16.840.1.101.3.4.2.2).
const ID_SHA_384: const_oid::ObjectIdentifier =
    const_oid::ObjectIdentifier::new_unwrap("2.16.840.1.101.3.4.2.2");

/// SHA-512 OID (2.16.840.1.101.3.4.2.3).
const ID_SHA_512: const_oid::ObjectIdentifier =
    const_oid::ObjectIdentifier::new_unwrap("2.16.840.1.101.3.4.2.3");

/// ECDSA-with-SHA-384 OID (1.2.840.10045.4.3.3) — P-384 signatures.
const ID_ECDSA_WITH_SHA_384: const_oid::ObjectIdentifier =
    const_oid::ObjectIdentifier::new_unwrap("1.2.840.10045.4.3.3");

/// ECDSA-with-SHA-512 OID (1.2.840.10045.4.3.4).
const ID_ECDSA_WITH_SHA_512: const_oid::ObjectIdentifier =
    const_oid::ObjectIdentifier::new_unwrap("1.2.840.10045.4.3.4");

/// sha256WithRSAEncryption OID (1.2.840.113549.1.1.11) — RSA-PKCS1v1.5 + SHA-256.
const ID_SHA256_WITH_RSA: const_oid::ObjectIdentifier =
    const_oid::ObjectIdentifier::new_unwrap("1.2.840.113549.1.1.11");

/// sha384WithRSAEncryption OID (1.2.840.113549.1.1.12) — RSA-PKCS1v1.5 + SHA-384.
const ID_SHA384_WITH_RSA: const_oid::ObjectIdentifier =
    const_oid::ObjectIdentifier::new_unwrap("1.2.840.113549.1.1.12");

/// sha512WithRSAEncryption OID (1.2.840.113549.1.1.13) — RSA-PKCS1v1.5 + SHA-512.
const ID_SHA512_WITH_RSA: const_oid::ObjectIdentifier =
    const_oid::ObjectIdentifier::new_unwrap("1.2.840.113549.1.1.13");

/// rsaEncryption OID (1.2.840.113549.1.1.1) — the generic RSA OID (RFC 3370
/// §3.2 legacy form). Some producers (openssl `cms -sign`, Thunderbird/NSS)
/// declare the signature algorithm as bare `rsaEncryption` and carry the hash
/// in the SignerInfo's `digestAlgorithm`; the combined OIDs above carry it in
/// the sig-alg OID itself. Treat both as RSA-PKCS1v1.5 over `digest_alg`.
const ID_RSA_ENCRYPTION: const_oid::ObjectIdentifier =
    const_oid::ObjectIdentifier::new_unwrap("1.2.840.113549.1.1.1");

/// id-RSASSA-PSS OID (1.2.840.113549.1.1.10) — RFC 8017 §8.1; the hash is in
/// the `AlgorithmIdentifier.parameters` (a `RSASSA-PSS-params` SEQUENCE).
const ID_RSASSA_PSS: const_oid::ObjectIdentifier =
    const_oid::ObjectIdentifier::new_unwrap("1.2.840.113549.1.1.10");

/// id-ecPublicKey OID (1.2.840.10045.2.1) — the SPKI algorithm for an ECDSA key;
/// the curve is named by the `parameters` OID (secp256r1 / secp384r1).
const ID_EC_PUBLIC_KEY: const_oid::ObjectIdentifier =
    const_oid::ObjectIdentifier::new_unwrap("1.2.840.10045.2.1");

/// secp256r1 (P-256) curve OID (1.2.840.10045.3.1.7).
const OID_SECP256R1: const_oid::ObjectIdentifier =
    const_oid::ObjectIdentifier::new_unwrap("1.2.840.10045.3.1.7");

/// secp384r1 (P-384) curve OID (1.3.132.0.34).
const OID_SECP384R1: const_oid::ObjectIdentifier =
    const_oid::ObjectIdentifier::new_unwrap("1.3.132.0.34");

/// Verify a CMS `SignedData` signature (wrapped in `ContentInfo`).
///
/// **Pre-chain check (G3):** the signature is verified against the signer
/// cert embedded in the SignedData; chain/trust assessment is G4.
///
/// # Inputs
/// - `signed_data_der`: DER bytes of the outer `ContentInfo` (id-signed-data),
///   exactly as produced by [`crate::cms_build::build_signed_data`].
/// - `covered_content`: `Some(b)` for a **detached** signature (the externally-
///   covered payload); `None` for an **encapsulated** signature (the payload
///   lives inside `encapContent.eContent`).
///
/// # Returns
/// A `CmsSigCheck`. `sig_ok` is `true` iff BOTH:
/// 1. The `messageDigest` signed attribute equals SHA-256 of the covered
///    content, AND
/// 2. The encryptedDigest verifies against the DER encoding of the signed
///    attributes under the signer cert's ECDSA-P256 public key.
///
/// If no signer cert can be located in the SignedData's `certificates` set,
/// `signer_cert_der`/`signer_fingerprint` are `None` and `sig_ok` is `false`;
/// the backend maps that to `SignatureState::UnknownKey`.
///
/// # Algorithm scope
/// ECDSA-P256 only this task. RSA / RSA-PSS / ECDSA-P384 are a documented
/// carry-forward to G4 (which lands the `p384` dep + needs them for
/// Thunderbird interop). For unsupported algorithms `sig_ok` returns `false`.
pub(crate) fn verify_signed(
    signed_data_der: &[u8],
    covered_content: Option<&[u8]>,
) -> Result<CmsSigCheck> {
    // 1. Parse ContentInfo → re-derive inner → SignedData (same idiom as the
    //    decrypt path: the cms crate stores SignedData as an `Any` inside the
    //    ContentInfo; re-deriving the Any content gives the raw SignedData DER).
    let ci = ContentInfo::from_der(signed_data_der)
        .map_err(|e| cms_err("parse ContentInfo", e))?;
    let inner = ci
        .content
        .to_der()
        .map_err(|e| cms_err("re-derive ContentInfo content", e))?;
    let sd = SignedData::from_der(&inner).map_err(|e| cms_err("parse SignedData", e))?;

    // 2. Recover covered content for the messageDigest check.
    //
    //    - **Encapsulated** (eContent present): hash `econtent.value()`, which
    //      is the raw payload (the cms builder stores the payload directly as
    //      the Any's value — see `cms_build::build_signed_data`'s RFC 5652 §3
    //      comment). Per RFC 5652 §5.4 the messageDigest is over the OCTET
    //      STRING's *value*, so this matches what an OpenSSL/Thunderbird
    //      verifier computes. The caller-supplied `covered_content` is IGNORED
    //      in this arm (the payload lives inside the SignedData).
    //    - **Detached** (eContent absent): the covered content is external;
    //      the caller MUST supply it via `covered_content`.
    let content_bytes: Vec<u8> = match sd.encap_content_info.econtent.as_ref() {
        Some(any) => any.value().to_vec(),
        None => match covered_content {
            Some(b) => b.to_vec(),
            None => {
                return Err(CryptoError::Malformed(
                    "SignedData: detached signature but no covered_content supplied".into(),
                ));
            }
        },
    };

    // 3. First signer info. (Multi-signer S/MIME is rare; G4 will loop if needed.)
    let signer_info = sd.signer_infos.0.get(0).ok_or_else(|| {
        CryptoError::Malformed("SignedData: no signer infos".into())
    })?;

    // 4. Locate the signer cert in the SignedData `certificates` set. If none
    //    is present at all, surface "no signer cert" so the backend can map to
    //    `SignatureState::UnknownKey`.
    let cert_set = sd.certificates.as_ref().ok_or_else(|| {
        CryptoError::Malformed("no signer cert (certificates set absent)".into())
    })?;
    let signer_cert_der = locate_signer_cert(cert_set, &signer_info.sid)?;
    let signer_cert = <Certificate as Decode>::from_der(&signer_cert_der)
        .map_err(|e| cms_err("parse signer cert", e))?;
    let fp = fingerprint_of_spki(&signer_cert)?;

    // 5. messageDigest signed attribute must equal SHA-256(covered content).
    let signed_attrs = signer_info.signed_attrs.as_ref().ok_or_else(|| {
        CryptoError::Malformed("SignedData: missing signed_attrs".into())
    })?;
    // Extract the CMS signingTime signed attribute (RFC 5652 §11.3). `None`
    // when absent — the caller (Task 5's `SmimeBackend::verify`) falls back to
    // `now()` for cert-chain validation. Extracted here (before the digest
    // check) so both the early-return (digest mismatch) and the final return
    // carry the same value.
    let signing_time_unix = find_signing_time(signed_attrs);
    let stored_digest = find_message_digest(signed_attrs).ok_or_else(|| {
        CryptoError::Malformed("SignedData: missing messageDigest attr".into())
    })?;
    // messageDigest attribute = hash(covered content) under the SignerInfo's
    // `digestAlgorithm` (RFC 5652 §11.2). SHA-256 for ECDSA-P256 / RSA-SHA256;
    // SHA-384 for ECDSA-P384 / RSA-SHA384; SHA-512 for the RSA-SHA512 arm.
    // Unsupported digest → cannot verify → sig_ok=false (NOT a hard error —
    // same "unknown algorithm = unverified" contract as the sig dispatch).
    let computed_digest = match compute_content_digest(&signer_info.digest_alg.oid, &content_bytes)
    {
        Some(d) => d,
        None => {
            return Ok(CmsSigCheck {
                sig_ok: false,
                signer_cert_der: Some(signer_cert_der),
                signer_fingerprint: Some(fp),
                signing_time_unix,
            });
        }
    };
    if stored_digest.as_slice() != computed_digest.as_slice() {
        // Content tampering or wrong covered content → cryptographic failure.
        return Ok(CmsSigCheck {
            sig_ok: false,
            signer_cert_der: Some(signer_cert_der),
            signer_fingerprint: Some(fp),
            signing_time_unix,
        });
    }

    // 6. Verify encryptedDigest over the DER encoding of the signed_attrs.
    //
    //    RFC 5652 §5.4: although `signedAttrs` is transmitted as `[0] IMPLICIT
    //    SET OF Attribute` (wire tag 0xA0), the signature is computed over a
    //    *separate* DER encoding that uses the EXPLICIT universal SET tag
    //    (0x31), NOT the IMPLICIT-[0] tag. Both the RustCrypto cms builder
    //    (`SetOfVec::encode_to_vec`, send side) and this verify path
    //    (`SetOfVec::to_der`) emit the 0x31 encoding, so both are
    //    RFC-conformant and agree — a Thunderbird/OpenSSL-signed ECDSA-P256
    //    SignedData verifies here (signedAttrs leg) with no re-tagging needed.
    let signed_attrs_der = signed_attrs
        .to_der()
        .map_err(|e| cms_err("encode signed_attrs", e))?;
    let sig_ok = verify_signer_signature(
        &signer_cert,
        &signed_attrs_der,
        signer_info.signature.as_bytes(),
        &signer_info.digest_alg,
        &signer_info.signature_algorithm,
    )?;

    Ok(CmsSigCheck {
        sig_ok,
        signer_cert_der: Some(signer_cert_der),
        signer_fingerprint: Some(fp),
        signing_time_unix,
    })
}

/// Walk the `CertificateSet` looking for the cert identified by `sid`.
///
/// Our cms builder always emits `SignerIdentifier::IssuerAndSerialNumber`;
/// the `SubjectKeyIdentifier` arm is supported for forward-compat with
/// imported or third-party SignedData.
///
/// Returns `Malformed` with a "no signer cert" marker if no cert matches;
/// `SmimeBackend::verify` maps that to `SignatureState::UnknownKey`.
fn locate_signer_cert(certs: &CertificateSet, sid: &SignerIdentifier) -> Result<Vec<u8>> {
    for choice in certs.0.iter() {
        let cert = match choice {
            CertificateChoices::Certificate(c) => c,
            // OtherCertificateFormat is not a leaf cert — skip.
            _ => continue,
        };
        if cert_matches_signer_id(cert, sid)? {
            return cert
                .to_der()
                .map_err(|e| cms_err("encode signer cert", e));
        }
    }
    Err(CryptoError::Malformed(
        "no signer cert matching SignerIdentifier".into(),
    ))
}

/// Return `true` if `cert` matches the `SignerIdentifier` `sid`. Shared by
/// `locate_signer_cert` (find the signer leaf) and `extract_intermediates`
/// (exclude the signer leaf) so the two call sites cannot drift.
///
/// - `IssuerAndSerialNumber`: compare issuer Name + serialNumber.
/// - `SubjectKeyIdentifier`: compare the cert's SKI extension value (NOT the
///   SHA-1-of-SPKI fingerprint used as the framework `Fingerprint`).
///   Forward-compat only — our builder emits IssuerAndSerialNumber today.
fn cert_matches_signer_id(cert: &Certificate, sid: &SignerIdentifier) -> Result<bool> {
    let tbs = cert.tbs_certificate();
    Ok(match sid {
        SignerIdentifier::IssuerAndSerialNumber(target) => {
            let candidate = IssuerAndSerialNumber {
                issuer: tbs.issuer().clone(),
                serial_number: tbs.serial_number().clone(),
            };
            &candidate == target
        }
        SignerIdentifier::SubjectKeyIdentifier(target_ski) => {
            match tbs
                .get_extension::<x509_cert::ext::pkix::SubjectKeyIdentifier>()
                .map_err(|e| cms_err("SubjectKeyIdentifier ext lookup", e))?
                .map(|(_crit, ext_ski)| ext_ski)
            {
                Some(ext_ski) => ext_ski.0.as_bytes() == target_ski.0.as_bytes(),
                None => false,
            }
        }
    })
}

/// Extract every cert in the SignedData `certificates` set EXCEPT the signer
/// leaf — the intermediates the G5 receive orchestrator passes to
/// [`crate::SmimeBackend::verify_with_context`]'s `intermediate_ders`
/// argument. The signer leaf is identified by the first `SignerInfo`'s
/// `SignerIdentifier` (IssuerAndSerialNumber or SubjectKeyIdentifier),
/// mirroring `locate_signer_cert` via the shared `cert_matches_signer_id`
/// helper so the two call sites cannot drift.
///
/// # Returns
///
/// - `Ok(Vec<intermediate DERs>)` — every `CertificateChoices::Certificate(c)`
///   whose Issuer+Serial / SKI does NOT match the first signer info's `sid`.
///   Order follows the `CertificateSet` iteration order.
/// - `Ok(empty Vec)` when `certificates` is `None` / empty, OR when the signer
///   leaf is the only cert in the set, OR when there are no `signer_infos`
///   (nothing to exclude → returns every PKIX cert in the set).
/// - `Err(Malformed)` only on unparseable CMS DER. An absent `certificates`
///   field is NOT an error (returns empty).
///
/// `CertificateChoices::Other` (`OtherCertificateFormat`) entries are skipped
/// — only PKIX `Certificate(c)` leaves are collected, matching `locate_signer_cert`'s
/// filter.
///
/// Visibility: declared `pub` so it can be re-exported from the crate root
/// (`pub use cms_parse::extract_intermediates`) for the backend G5 orchestrator.
/// The `cms_parse` module itself is private (`mod cms_parse;` in lib.rs), so
/// external callers cannot reach `cms_parse::extract_intermediates` directly —
/// they go through `crypto_smime::extract_intermediates`. This mirrors the
/// existing `chain::validate_signer_chain` pattern.
pub fn extract_intermediates(signed_data_der: &[u8]) -> Result<Vec<Vec<u8>>> {
    // Parse ContentInfo → SignedData (same idiom as verify_signed and
    // decrypt_enveloped: the cms crate stores SignedData as an `Any` inside the
    // ContentInfo; re-deriving the Any content yields the raw SignedData DER).
    let ci = ContentInfo::from_der(signed_data_der)
        .map_err(|e| cms_err("parse ContentInfo", e))?;
    let inner = ci
        .content
        .to_der()
        .map_err(|e| cms_err("re-derive ContentInfo content", e))?;
    let sd = SignedData::from_der(&inner).map_err(|e| cms_err("parse SignedData", e))?;

    let Some(cert_set) = sd.certificates.as_ref() else {
        // No certificates set at all — nothing to extract.
        return Ok(Vec::new());
    };

    // Identify the signer leaf via the first SignerInfo's SignerIdentifier.
    // If there are no signer infos (degenerate but valid CMS), exclude nothing
    // — return every PKIX cert in the set. The orchestrator decides what to do
    // with them; we don't silently drop user-visible cert material.
    let signer_sid = sd.signer_infos.0.get(0).map(|si| &si.sid);

    let mut intermediates = Vec::new();
    for choice in cert_set.0.iter() {
        let cert = match choice {
            CertificateChoices::Certificate(c) => c,
            // OtherCertificateFormat (and any future non-PKIX variants) are
            // not intermediate CA certs — skip them entirely.
            _ => continue,
        };
        let is_signer = match signer_sid {
            Some(sid) => cert_matches_signer_id(cert, sid)?,
            None => false,
        };
        if !is_signer {
            let der = cert
                .to_der()
                .map_err(|e| cms_err("encode intermediate cert", e))?;
            intermediates.push(der);
        }
    }
    Ok(intermediates)
}

/// RFC 5280 method-1 SubjectKeyIdentifier = SHA-1 of the SPKI DER, hex-lower.
/// Mirrors `cert.rs::build_self_signed_smime_cert`'s SKI computation so a
/// generated cert's fingerprint round-trips.
fn fingerprint_of_spki(cert: &Certificate) -> Result<String> {
    use der::referenced::OwnedToRef;
    let spki_ref = cert
        .tbs_certificate()
        .subject_public_key_info()
        .owned_to_ref();
    let ski = x509_cert::ext::pkix::SubjectKeyIdentifier::try_from(spki_ref)
        .map_err(|e| cms_err("compute SubjectKeyIdentifier", e))?;
    Ok(crate::cert::to_hex_lower(ski.0.as_bytes()))
}

/// Find the messageDigest signed-attribute value (the OCTET STRING content
/// bytes, i.e. the digest itself, not the full TLV). Returns `None` if the
/// attribute is absent or malformed.
fn find_message_digest(attrs: &x509_cert::attr::Attributes) -> Option<Vec<u8>> {
    let md = attrs.iter().find(|a| a.oid == ID_MESSAGE_DIGEST)?;
    let val = md.values.get(0)?;
    let octets: OctetString = val.decode_as().ok()?;
    Some(octets.as_bytes().to_vec())
}

/// Find the signingTime signed-attribute value (RFC 5652 §11.3) and convert it
/// to Unix seconds. Returns `None` if the attribute is absent or malformed.
///
/// `signingTime` is a `Time` (CHOICE of UTCTime `tag 0x17` / GeneralizedTime
/// `tag 0x18`). The attribute value is stored as a `der::Any` wrapping the full
/// Time DER (tag + length + value). We re-encode the `Any` → `to_der()` →
/// decode as `x509_cert::time::Time`, which dispatches on the tag to the
/// matching arm. `Time::to_unix_duration()` yields seconds since `UNIX_EPOCH`.
fn find_signing_time(attrs: &x509_cert::attr::Attributes) -> Option<i64> {
    let attr = attrs.iter().find(|a| a.oid == ID_SIGNING_TIME)?;
    let val = attr.values.get(0)?;
    // Re-encode the Any to full DER (tag + length + value), then decode as
    // Time. The tag is load-bearing for the CHOICE dispatch (UTCTime vs
    // GeneralizedTime), so `decode_as` alone (which reads only the value
    // bytes) would not work — `to_der()` + `from_der()` round-trips the tag.
    let time_der = val.to_der().ok()?;
    let time = <x509_cert::time::Time as der::Decode>::from_der(&time_der).ok()?;
    Some(time.to_unix_duration().as_secs() as i64)
}

/// Dispatch the CMS `encryptedDigest` verification on the signer-info's
/// `signatureAlgorithm` OID (+ the SPKI curve OID for ECDSA).
///
/// # Algorithm scope (spec decision #10)
/// - ECDSA P-256 + SHA-256 (`ecdsa-with-SHA256`, SPKI `secp256r1`)
/// - ECDSA P-384 + SHA-384 (`ecdsa-with-SHA384`, SPKI `secp384r1`)
/// - RSA-PKCS1v1.5 + SHA-{256,384,512} (`sha{256,384,512}WithRSAEncryption`)
/// - RSA-PSS + SHA-{256,384,512} (`id-RSASSA-PSS`; hash from the PSS params)
///
/// Any other algorithm (P-521, Ed25519, SHA-1 PSS, …) returns `Ok(false)` —
/// `sig_ok=false` → `SignatureState::Invalid`. This is deliberate: a message
/// signed with an algorithm we don't ship must show "Invalid signature", not a
/// parse error. `Err` stays reserved for malformed CMS DER.
fn verify_signer_signature(
    cert: &Certificate,
    signed_attrs_der: &[u8],
    signature: &[u8],
    digest_alg: &AlgorithmIdentifierOwned,
    sig_alg: &AlgorithmIdentifierOwned,
) -> Result<bool> {
    let oid = sig_alg.oid;
    if oid == ID_ECDSA_WITH_SHA_256
        || oid == ID_ECDSA_WITH_SHA_384
        || oid == ID_ECDSA_WITH_SHA_512
    {
        verify_ecdsa_signature(cert, signed_attrs_der, signature, digest_alg)
    } else if oid == ID_SHA256_WITH_RSA
        || oid == ID_SHA384_WITH_RSA
        || oid == ID_SHA512_WITH_RSA
        || oid == ID_RSA_ENCRYPTION
    {
        verify_rsa_pkcs1v15_signature(cert, signed_attrs_der, signature, digest_alg)
    } else if oid == ID_RSASSA_PSS {
        verify_rsa_pss_signature(cert, signed_attrs_der, signature, sig_alg)
    } else {
        Ok(false)
    }
}

/// Compute `hash(content)` under the SignerInfo's `digestAlgorithm` for the
/// `messageDigest` attribute check (RFC 5652 §11.2). SHA-256 / SHA-384 /
/// SHA-512 supported; anything else → `None` (caller maps to `sig_ok=false`).
fn compute_content_digest(
    digest_oid: &const_oid::ObjectIdentifier,
    content: &[u8],
) -> Option<Vec<u8>> {
    use sha2::Digest;
    match *digest_oid {
        ID_SHA_256 => Some(sha2::Sha256::digest(content).to_vec()),
        ID_SHA_384 => Some(sha2::Sha384::digest(content).to_vec()),
        ID_SHA_512 => Some(sha2::Sha512::digest(content).to_vec()),
        _ => None,
    }
}

/// The ECDSA `Verifier::verify` impl on a curve's `VerifyingKey` hashes the
/// message with the curve's default digest (P-256 → SHA-256, P-384 → SHA-384).
/// So the caller MUST pair the curve with its matching `digest_alg`, else the
/// signature won't verify. This is the common case in deployed S/MIME
/// (Thunderbird/NSS pair P-256↔SHA-256, P-384↔SHA-384) and a mismatch yields
/// the safe `sig_ok=false` verdict (no false-positive).
fn verify_ecdsa_signature(
    cert: &Certificate,
    signed_attrs_der: &[u8],
    signature: &[u8],
    digest_alg: &AlgorithmIdentifierOwned,
) -> Result<bool> {
    let spki = cert.tbs_certificate().subject_public_key_info();
    // Only id-ecPublicKey SPKIs are ECDSA keys; the curve is named by the
    // `parameters` OID. A non-EC public-key SPKI here is a malformed signer
    // (the sig_alg OID was ECDSA-* but the key isn't EC) → sig_ok=false.
    if spki.algorithm.oid != ID_EC_PUBLIC_KEY {
        return Ok(false);
    }
    let params = spki.algorithm.parameters.as_ref().ok_or_else(|| {
        CryptoError::Malformed("ECDSA SPKI: missing curve parameters".into())
    })?;
    // `parameters` is an `Any` whose value is the curve OID. Re-derive its DER
    // and parse — bulletproof across the owned `Any` vs borrowed `AnyRef` split.
    let curve_der = params
        .to_der()
        .map_err(|e| cms_err("encode ECDSA curve params", e))?;
    let curve_oid: const_oid::ObjectIdentifier =
        <const_oid::ObjectIdentifier as der::Decode>::from_der(&curve_der)
            .map_err(|e| cms_err("decode ECDSA curve OID", e))?;
    if curve_oid == OID_SECP256R1 {
        if digest_alg.oid != ID_SHA_256 {
            return Ok(false);
        }
        verify_ecdsa_p256_signature_inner(cert, signed_attrs_der, signature)
    } else if curve_oid == OID_SECP384R1 {
        if digest_alg.oid != ID_SHA_384 {
            return Ok(false);
        }
        verify_ecdsa_p384_signature_inner(cert, signed_attrs_der, signature)
    } else {
        // secp521r1 / other curves — P-521 deferred per spec #10.
        Ok(false)
    }
}

/// ECDSA-P256 inner: recover the verifying key from the cert SPKI and verify
/// the DER-encoded signature over `signed_attrs_der`. The P-256 `Verifier`
/// hashes with SHA-256 internally (guarded by the caller).
fn verify_ecdsa_p256_signature_inner(
    cert: &Certificate,
    signed_attrs_der: &[u8],
    signature: &[u8],
) -> Result<bool> {
    use ecdsa::signature::Verifier;
    use p256::ecdsa::{DerSignature, VerifyingKey};
    use spki::DecodePublicKey;

    let spki_der = cert
        .tbs_certificate()
        .subject_public_key_info()
        .to_der()
        .map_err(|e| cms_err("encode signer SPKI", e))?;
    let pub_key = <p256::PublicKey as DecodePublicKey>::from_public_key_der(&spki_der)
        .map_err(|e| cms_err("decode signer P-256 public key", e))?;
    let vk = VerifyingKey::from(&pub_key);
    // A malformed ECDSA encryptedDigest (truncated r/s, wrong tag, …) is a
    // signature-verification failure → `sig_ok=false`, NOT a hard error — same
    // "unverifiable = Invalid, not a parse error" contract as the RSA arms
    // (a structurally well-formed SignedData with a bad signature must map to
    // `SignatureState::Invalid`, not surface as a parse error).
    let sig = match DerSignature::from_bytes(signature) {
        Ok(s) => s,
        Err(_) => return Ok(false),
    };
    Ok(vk.verify(signed_attrs_der, &sig).is_ok())
}

/// ECDSA-P384 inner: mirrors the P-256 arm over `p384::ecdsa::VerifyingKey`.
/// The P-384 `Verifier` hashes with SHA-384 internally (guarded by the caller).
fn verify_ecdsa_p384_signature_inner(
    cert: &Certificate,
    signed_attrs_der: &[u8],
    signature: &[u8],
) -> Result<bool> {
    use ecdsa::signature::Verifier;
    use p384::ecdsa::{DerSignature, VerifyingKey};
    use spki::DecodePublicKey;

    let spki_der = cert
        .tbs_certificate()
        .subject_public_key_info()
        .to_der()
        .map_err(|e| cms_err("encode signer SPKI", e))?;
    let pub_key = <p384::PublicKey as DecodePublicKey>::from_public_key_der(&spki_der)
        .map_err(|e| cms_err("decode signer P-384 public key", e))?;
    let vk = VerifyingKey::from(&pub_key);
    // Malformed encryptedDigest → sig_ok=false (see P-256 inner for rationale).
    let sig = match DerSignature::from_bytes(signature) {
        Ok(s) => s,
        Err(_) => return Ok(false),
    };
    Ok(vk.verify(signed_attrs_der, &sig).is_ok())
}

/// RSA-PKCS1v1.5 (`sha{256,384,512}WithRSAEncryption`): recover the RSA public
/// key from the cert SPKI and verify the PKCS#1v1.5 signature over the
/// `digest_alg` hash of `signed_attrs_der`. `rsa::pkcs1v15::VerifyingKey::<D>`
/// hashes internally with `D`, so we dispatch `D` on `digest_alg.oid`.
fn verify_rsa_pkcs1v15_signature(
    cert: &Certificate,
    signed_attrs_der: &[u8],
    signature: &[u8],
    digest_alg: &AlgorithmIdentifierOwned,
) -> Result<bool> {
    use rsa::pkcs1v15::{Signature as Pkcs1v15Signature, VerifyingKey};
    use rsa::signature::Verifier;
    use sha2::{Sha256, Sha384, Sha512};

    let spki_der = cert
        .tbs_certificate()
        .subject_public_key_info()
        .to_der()
        .map_err(|e| cms_err("encode signer SPKI", e))?;
    let pub_key = <rsa::RsaPublicKey as rsa::pkcs8::DecodePublicKey>::from_public_key_der(
        &spki_der,
    )
    .map_err(|e| cms_err("decode signer RSA public key", e))?;

    // Dispatch the verifying key's hash generic on the SignerInfo digest. Both
    // `VerifyingKey::<D>` arms impl `signature::Verifier<&[u8]>` and hash the
    // message with `D` internally.
    macro_rules! verify_with {
        ($d:ty) => {{
            let vk = VerifyingKey::<$d>::new(pub_key.clone());
            let sig = match Pkcs1v15Signature::try_from(signature) {
                Ok(s) => s,
                Err(_) => return Ok(false),
            };
            Ok(vk.verify(signed_attrs_der, &sig).is_ok())
        }};
    }
    match digest_alg.oid {
        ID_SHA_256 => verify_with!(Sha256),
        ID_SHA_384 => verify_with!(Sha384),
        ID_SHA_512 => verify_with!(Sha512),
        _ => Ok(false),
    }
}

/// RSA-PSS (`id-RSASSA-PSS`): the hash comes from the `RSASSA-PSS-params`
/// `hashAlgorithm` (RFC 8017 §8.1), parsed from `sig_alg.parameters`. SHA-1
/// (the RFC default) → `sig_ok=false` (do not verify a SHA-1 signature).
fn verify_rsa_pss_signature(
    cert: &Certificate,
    signed_attrs_der: &[u8],
    signature: &[u8],
    sig_alg: &AlgorithmIdentifierOwned,
) -> Result<bool> {
    use rsa::pss::{Signature as PssSignature, VerifyingKey};
    use rsa::signature::Verifier;
    use sha2::{Sha256, Sha384, Sha512};

    let spki_der = cert
        .tbs_certificate()
        .subject_public_key_info()
        .to_der()
        .map_err(|e| cms_err("encode signer SPKI", e))?;
    let pub_key = <rsa::RsaPublicKey as rsa::pkcs8::DecodePublicKey>::from_public_key_der(
        &spki_der,
    )
    .map_err(|e| cms_err("decode signer RSA public key", e))?;

    let hash_oid = rsa_pss_hash_oid(sig_alg)?;
    macro_rules! verify_with {
        ($d:ty) => {{
            let vk = VerifyingKey::<$d>::new(pub_key.clone());
            let sig = match PssSignature::try_from(signature) {
                Ok(s) => s,
                Err(_) => return Ok(false),
            };
            Ok(vk.verify(signed_attrs_der, &sig).is_ok())
        }};
    }
    match hash_oid {
        ID_SHA_256 => verify_with!(Sha256),
        ID_SHA_384 => verify_with!(Sha384),
        ID_SHA_512 => verify_with!(Sha512),
        // SHA-1 (RFC 8017 default) and any other hash → not verified.
        _ => Ok(false),
    }
}

/// Parse the `hashAlgorithm.oid` from an RSA-PSS `AlgorithmIdentifier.parameters`
/// (`RSASSA-PSS-params` SEQUENCE, RFC 8017 §8.1). Mirrors `chain.rs`'s 0.7-line
/// `rsa_pss_hash_oid` but on the 0.8 line (`pkcs1::RsaPssParams`).
/// `Malformed` when params are absent or unparseable (broken CMS).
fn rsa_pss_hash_oid(sig_alg: &AlgorithmIdentifierOwned) -> Result<const_oid::ObjectIdentifier> {
    let params_any = sig_alg.parameters.as_ref().ok_or_else(|| {
        CryptoError::Malformed("id-RSASSA-PSS AlgorithmIdentifier: missing parameters".into())
    })?;
    // Re-derive the raw params DER, then parse as RsaPssParams. Re-encoding via
    // `to_der` sidesteps the owned-vs-borrowed `Any` lifetime split on the 0.8
    // line (the params `Any` is owned; `RsaPssParams` decodes from `&[u8]`).
    let params_der = params_any
        .to_der()
        .map_err(|e| cms_err("encode RSA-PSS params", e))?;
    let pss: pkcs1::RsaPssParams<'_> = <pkcs1::RsaPssParams<'_> as der::Decode>::from_der(
        &params_der,
    )
    .map_err(|e| cms_err("parse RSA-PSS params", e))?;
    Ok(pss.hash.oid)
}


// ───────────────────────────────── tests ─────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use crate::cms_build::{build_enveloped_data, recipient_input_from_cert};

    // ──── fixtures ────

    /// Build an RSA self-signed cert + PKCS#8 key for round-trip tests. Uses the
    /// same `SmimeLeafProfile` as the ECDSA cert builder but with an RSA
    /// signing key so `recipient_input_from_cert` takes the RSA (ktri) arm.
    fn rsa_test_cert_and_key(id: u32) -> (Vec<u8>, Vec<u8>) {
        use rsa::pkcs1v15::SigningKey;
        use sha2::Sha256;
        use std::str::FromStr;
        use std::time::Duration;
        use x509_cert::builder::profile::BuilderProfile;
        use x509_cert::builder::{Builder, CertificateBuilder};
        use x509_cert::certificate::TbsCertificate;
        use x509_cert::ext::pkix::{KeyUsage, KeyUsages};
        use x509_cert::name::Name;
        use x509_cert::serial_number::SerialNumber;
        use x509_cert::time::Validity;
        use x509_cert::SubjectPublicKeyInfo;
        // `verifying_key` comes from the `Keypair` trait; `to_pkcs8_der` from
        // `EncodePrivateKey`. Both are re-exported via `ecdsa` / `pkcs8`.
        use ecdsa::signature::Keypair;
        use pkcs8::EncodePrivateKey;

        /// Minimal self-signed profile for RSA test certs (mirrors
        /// `cert::SmimeLeafProfile` but with a public `subject` field so the
        /// test module can construct it).
        struct RsaTestProfile {
            subject: Name,
        }
        impl BuilderProfile for RsaTestProfile {
            fn get_subject(&self) -> Name {
                self.subject.clone()
            }
            fn get_issuer(&self, subject: &Name) -> Name {
                subject.clone()
            }
            fn build_extensions(
                &self,
                _spk: spki::SubjectPublicKeyInfoRef<'_>,
                _issuer_spk: spki::SubjectPublicKeyInfoRef<'_>,
                _tbs: &TbsCertificate,
            ) -> x509_cert::builder::Result<Vec<x509_cert::ext::Extension>> {
                Ok(Vec::new())
            }
        }

        let mut rng = rand::rng();
        let rsa_priv =
            rsa::RsaPrivateKey::new(&mut rng, 3072).expect("generate RSA key for test cert");
        let signing_key = SigningKey::<Sha256>::new(rsa_priv.clone());

        // Build SPKI from the RSA verifying key (implements EncodePublicKey).
        let pub_spki = SubjectPublicKeyInfo::from_key(&signing_key.verifying_key())
            .expect("build RSA SPKI for test cert");

        let subject = Name::from_str(&format!("CN=rsa-rcpt-{id}")).expect("subject name");
        let profile = RsaTestProfile { subject };
        let serial = SerialNumber::from(id);
        let validity =
            Validity::from_now(Duration::from_secs(365 * 24 * 60 * 60)).expect("validity");
        let mut builder =
            CertificateBuilder::new(profile, serial, validity, pub_spki).expect("cert builder");

        let key_usage = KeyUsage(KeyUsages::DigitalSignature | KeyUsages::KeyEncipherment);
        builder.add_extension(&key_usage).expect("key usage ext");

        let cert = builder
            .build::<_, rsa::pkcs1v15::Signature>(&signing_key)
            .expect("build + sign RSA cert");
        let cert_der = cert.to_der().expect("cert DER");

        let priv_doc = rsa_priv.to_pkcs8_der().expect("RSA PKCS#8 DER");
        (cert_der, priv_doc.as_bytes().to_vec())
    }

    /// Build an ECDSA-P256 self-signed cert + PKCS#8 key (reuses the production
    /// cert builder). The P-256 public key serves as the ECDH recipient key.
    fn p256_test_cert_and_key(id: u32) -> (Vec<u8>, Vec<u8>) {
        let built = crate::cert::build_self_signed_smime_cert(&format!("ecc-rcpt-{id}@kylins.com"))
            .expect("build P-256 test cert");
        (built.cert_der, built.priv_pkcs8_der)
    }

    // ──── RSA round-trip (ktri) ────

    #[test]
    fn decrypt_round_trips_rsa_recipient() {
        let (cert_der, priv_pkcs8) = rsa_test_cert_and_key(1);
        let plaintext = b"hello S/MIME RSA";
        let recip = recipient_input_from_cert(&cert_der).expect("recipient input");
        let enveloped_der =
            build_enveloped_data(plaintext, std::slice::from_ref(&recip)).expect("build enveloped");

        let recovered =
            decrypt_enveloped(&enveloped_der, &cert_der, &priv_pkcs8).expect("decrypt");
        assert_eq!(recovered.as_slice(), plaintext);
    }

    // ──── ECC round-trip (kari) ────

    #[test]
    fn decrypt_round_trips_ecc_recipient() {
        let (cert_der, priv_pkcs8) = p256_test_cert_and_key(1);
        let plaintext = b"hello S/MIME ECC kari";
        let recip = recipient_input_from_cert(&cert_der).expect("recipient input");
        let enveloped_der =
            build_enveloped_data(plaintext, std::slice::from_ref(&recip)).expect("build enveloped");

        let recovered =
            decrypt_enveloped(&enveloped_der, &cert_der, &priv_pkcs8).expect("decrypt");
        assert_eq!(recovered.as_slice(), plaintext);
    }

    // ──── no matching recipient ────

    #[test]
    fn decrypt_no_matching_recipient_returns_error() {
        let (cert_a, _) = rsa_test_cert_and_key(1);
        let (cert_b, priv_b) = rsa_test_cert_and_key(2); // different identity
        let recip = recipient_input_from_cert(&cert_a).expect("recipient input");
        let enveloped_der =
            build_enveloped_data(b"x", std::slice::from_ref(&recip)).expect("build enveloped");

        let err = decrypt_enveloped(&enveloped_der, &cert_b, &priv_b).unwrap_err();
        assert!(
            matches!(err, CryptoError::Malformed(ref m) if m.contains("no matching recipient")),
            "expected no-matching-recipient Malformed, got {err:?}"
        );
    }

    // ──── signature verify round-trip (encapsulated) ────

    #[test]
    fn verify_round_trips_encapsulated_signed_data() {
        let (cert_der, priv_pkcs8) = p256_test_cert_and_key(10);
        let payload = b"signed payload";
        let signed_data_der =
            crate::cms_build::build_signed_data(payload, /*detached=*/ false, &cert_der, &priv_pkcs8)
                .unwrap();
        let check = verify_signed(&signed_data_der, /*covered_content=*/ None).unwrap();
        assert!(check.sig_ok, "encapsulated signature must verify");
        assert!(check.signer_cert_der.is_some());
        assert!(check.signer_fingerprint.is_some());
    }

    // ──── signature verify round-trip (detached) ────

    #[test]
    fn verify_round_trips_detached_signed_data() {
        let (cert_der, priv_pkcs8) = p256_test_cert_and_key(11);
        let payload = b"detached payload";
        let signed_data_der =
            crate::cms_build::build_signed_data(payload, /*detached=*/ true, &cert_der, &priv_pkcs8)
                .unwrap();
        let check = verify_signed(&signed_data_der, /*covered_content=*/ Some(payload)).unwrap();
        assert!(check.sig_ok, "detached signature must verify");
        assert!(check.signer_cert_der.is_some());
    }

    // ──── tampered content → sig invalid or parse error ────

    #[test]
    fn verify_tampered_content_is_invalid() {
        let (cert_der, priv_pkcs8) = p256_test_cert_and_key(12);
        let signed_data_der =
            crate::cms_build::build_signed_data(b"original", false, &cert_der, &priv_pkcs8).unwrap();
        // Flip the last byte of the DER — either the parse fails (the byte may
        // land inside signature/cert/length octets) or the signature check
        // fails. Both outcomes are acceptable security verdicts.
        let mut tampered = signed_data_der.clone();
        let last = tampered.len() - 1;
        tampered[last] ^= 0xFF;
        let res = verify_signed(&tampered, None);
        assert!(
            res.is_err() || !res.as_ref().unwrap().sig_ok,
            "tampered SignedData must not verify: got {res:?}"
        );
    }

    // ──── no certificates set → UnknownKey marker ────

    #[test]
    fn verify_no_signer_cert_yields_unknown_key_marker() {
        let (cert_der, priv_pkcs8) = p256_test_cert_and_key(13);
        let signed_data_der =
            crate::cms_build::build_signed_data(b"x", false, &cert_der, &priv_pkcs8).unwrap();
        // Re-parse and rebuild the SignedData with the certificates field
        // stripped, so there is no signer cert to match. This simulates a
        // SignedData that lacks the signer's cert (received over a transport
        // that detached it, or a degenerate message) — the backend must map
        // this to `SignatureState::UnknownKey`.
        let ci = ContentInfo::from_der(&signed_data_der).unwrap();
        let sd = SignedData::from_der(ci.content.to_der().unwrap().as_slice()).unwrap();
        assert!(sd.certificates.is_some(), "fixture must include certs");
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
        let stripped_der = stripped_ci.to_der().unwrap();

        let err = verify_signed(&stripped_der, None).unwrap_err();
        assert!(
            matches!(err, CryptoError::Malformed(ref m) if m.contains("no signer cert")),
            "missing signer cert must surface as `no signer cert` Malformed (mapped to UnknownKey by the backend); got {err:?}"
        );
    }

    // ──── signingTime extraction (Task 3) ────

    /// Build a CMS SignedData that includes a `signingTime` signed attribute.
    ///
    /// The production `cms_build::build_signed_data` does NOT emit signingTime
    /// (the cms `SignerInfoBuilder` only auto-adds `messageDigest` +
    /// `contentType`). This helper mirrors `build_signed_data`'s sequence but
    /// calls `signer_info_builder.add_signed_attribute(
    /// create_signing_time_attribute()?)` to attach the attribute, producing a
    /// fixture that exercises `verify_signed`'s signingTime extraction.
    fn build_signed_data_with_signing_time(
        payload: &[u8],
        signer_cert_der: &[u8],
        signer_priv_pkcs8_der: &[u8],
    ) -> Vec<u8> {
        use cms::builder::{
            create_signing_time_attribute, SignedDataBuilder, SignerInfoBuilder,
        };
        use cms::cert::{CertificateChoices, IssuerAndSerialNumber};
        use cms::signed_data::{EncapsulatedContentInfo, SignerIdentifier};
        use der::Any;
        use pkcs8::DecodePrivateKey;
        use spki::AlgorithmIdentifierOwned;
        use x509_cert::Certificate;

        let cert = <Certificate as der::Decode>::from_der(signer_cert_der).unwrap();
        let tbs = cert.tbs_certificate();
        let sid = SignerIdentifier::IssuerAndSerialNumber(IssuerAndSerialNumber {
            issuer: tbs.issuer().clone(),
            serial_number: tbs.serial_number().clone(),
        });
        let secret = p256::SecretKey::from_pkcs8_der(signer_priv_pkcs8_der).unwrap();
        let signing_key = p256::ecdsa::SigningKey::from(&secret);

        // RFC 5652 §3 single-wrap: Any IS the OCTET STRING (tag 0x04), value =
        // the raw payload. Mirrors the production `build_signed_data` (G7 T1).
        let econtent = Some(Any::new(der::Tag::OctetString, payload.to_vec()).unwrap());
        let encap = EncapsulatedContentInfo {
            econtent_type: const_oid::db::rfc5911::ID_DATA,
            econtent,
        };
        let digest_algorithm = AlgorithmIdentifierOwned {
            oid: ID_SHA_256,
            parameters: None,
        };

        let mut signer_info_builder = SignerInfoBuilder::new(
            sid,
            digest_algorithm.clone(),
            &encap,
            None, // encapsulated → builder computes the digest
        )
        .unwrap();
        // Attach signingTime (the one attribute build_signed_data omits).
        signer_info_builder
            .add_signed_attribute(create_signing_time_attribute().unwrap())
            .unwrap();

        let content_info = SignedDataBuilder::new(&encap)
            .add_digest_algorithm(digest_algorithm)
            .unwrap()
            .add_certificate(CertificateChoices::Certificate(cert))
            .unwrap()
            .add_signer_info::<ecdsa::SigningKey<p256::NistP256>, p256::ecdsa::DerSignature>(
                signer_info_builder,
                &signing_key,
            )
            .unwrap()
            .build()
            .unwrap();
        content_info.to_der().unwrap()
    }

    /// `signingTime` present in the SignedData's signed_attrs →
    /// `CmsSigCheck.signing_time_unix` is `Some(unix_secs)` close to now.
    #[test]
    fn verify_extracts_signing_time_from_signed_attrs() {
        let (cert_der, priv_pkcs8) = p256_test_cert_and_key(20);
        let payload = b"signed with signingTime";

        let now_before = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_secs() as i64;

        let signed_data_der =
            build_signed_data_with_signing_time(payload, &cert_der, &priv_pkcs8);

        let now_after = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_secs() as i64;

        let check = verify_signed(&signed_data_der, None).unwrap();
        assert!(check.sig_ok, "signature must still verify with signingTime");
        let signing_time = check
            .signing_time_unix
            .expect("signingTime must be extracted when the attribute is present");
        // signingTime was captured during build (between now_before and
        // now_after). Allow a 5s slack for clock granularity / test latency.
        assert!(
            signing_time >= now_before && signing_time <= now_after + 5,
            "signing_time_unix {signing_time} must be within [{now_before}, {now_after}+5]"
        );
    }

    /// `signingTime` absent (production `build_signed_data` output) →
    /// `CmsSigCheck.signing_time_unix` is `None` (Task 5 falls back to now()).
    #[test]
    fn verify_signing_time_absent_yields_none() {
        let (cert_der, priv_pkcs8) = p256_test_cert_and_key(21);
        let payload = b"signed without signingTime";
        let signed_data_der =
            crate::cms_build::build_signed_data(payload, false, &cert_der, &priv_pkcs8).unwrap();

        let check = verify_signed(&signed_data_der, None).unwrap();
        assert!(check.sig_ok, "signature must still verify");
        assert!(
            check.signing_time_unix.is_none(),
            "signingTime absent → None (Task 5 falls back to now()); got {:?}",
            check.signing_time_unix
        );
    }

    // ─── Task 2 (G5): extract_intermediates ───

    /// Build a CMS SignedData over `payload`, signed by `signer_cert_der` +
    /// `signer_priv_pkcs8_der`, with the signer cert PLUS every entry in
    /// `extra_certs` embedded in the `certificates` set. Mirrors
    /// `build_signed_data_with_signing_time` but injects additional certs
    /// (the production `build_signed_data` only embeds the signer leaf).
    fn build_signed_data_with_extra_certs(
        payload: &[u8],
        signer_cert_der: &[u8],
        signer_priv_pkcs8_der: &[u8],
        extra_certs: &[Vec<u8>],
    ) -> Vec<u8> {
        use cms::builder::{SignedDataBuilder, SignerInfoBuilder};
        use cms::cert::{CertificateChoices, IssuerAndSerialNumber};
        use cms::signed_data::{EncapsulatedContentInfo, SignerIdentifier};
        use der::Any;
        use pkcs8::DecodePrivateKey;
        use spki::AlgorithmIdentifierOwned;
        use x509_cert::Certificate;

        let cert = <Certificate as der::Decode>::from_der(signer_cert_der).unwrap();
        let tbs = cert.tbs_certificate();
        let sid = SignerIdentifier::IssuerAndSerialNumber(IssuerAndSerialNumber {
            issuer: tbs.issuer().clone(),
            serial_number: tbs.serial_number().clone(),
        });
        let secret = p256::SecretKey::from_pkcs8_der(signer_priv_pkcs8_der).unwrap();
        let signing_key = p256::ecdsa::SigningKey::from(&secret);

        // RFC 5652 §3 single-wrap: Any IS the OCTET STRING (tag 0x04), value =
        // the raw payload. Mirrors the production `build_signed_data` (G7 T1).
        let econtent = Some(Any::new(der::Tag::OctetString, payload.to_vec()).unwrap());
        let encap = EncapsulatedContentInfo {
            econtent_type: const_oid::db::rfc5911::ID_DATA,
            econtent,
        };
        let digest_algorithm = AlgorithmIdentifierOwned {
            oid: ID_SHA_256,
            parameters: None,
        };

        let signer_info_builder = SignerInfoBuilder::new(
            sid,
            digest_algorithm.clone(),
            &encap,
            None, // encapsulated → builder computes the digest
        )
        .unwrap();

        // Step-by-step assembly (instead of a fluent chain) so the
        // intermediate builder is an owned `let` rather than a borrowed
        // temporary — `add_digest_algorithm` / `add_certificate` borrow
        // `&mut self`, and breaking the chain mid-way for the extra-certs
        // loop would otherwise drop the temporary at the end of the chain
        // statement (E0716).
        let mut builder = SignedDataBuilder::new(&encap);
        builder
            .add_digest_algorithm(digest_algorithm)
            .unwrap()
            .add_certificate(CertificateChoices::Certificate(cert))
            .unwrap();
        for extra_der in extra_certs {
            let extra_cert = <Certificate as der::Decode>::from_der(extra_der)
                .expect("extra cert DER parses");
            builder
                .add_certificate(CertificateChoices::Certificate(extra_cert))
                .unwrap();
        }
        let content_info = builder
            .add_signer_info::<ecdsa::SigningKey<p256::NistP256>, p256::ecdsa::DerSignature>(
                signer_info_builder,
                &signing_key,
            )
            .unwrap()
            .build()
            .unwrap();
        content_info.to_der().unwrap()
    }

    /// SignedData with signer + 1 intermediate → returns the intermediate DER,
    /// NOT the signer leaf.
    #[test]
    fn extract_intermediates_returns_non_signer_certs() {
        let (signer_der, signer_priv) = p256_test_cert_and_key(30);
        let (intermediate_der, _intermediate_priv) = p256_test_cert_and_key(31);

        let signed_data_der = build_signed_data_with_extra_certs(
            b"multi-cert payload",
            &signer_der,
            &signer_priv,
            std::slice::from_ref(&intermediate_der),
        );

        let intermediates =
            extract_intermediates(&signed_data_der).expect("extract ok");
        assert_eq!(
            intermediates.len(),
            1,
            "exactly one intermediate (signer leaf excluded)"
        );
        assert_eq!(
            intermediates[0], intermediate_der,
            "intermediate DER must round-trip verbatim"
        );
        assert_ne!(
            intermediates[0], signer_der,
            "signer leaf must NOT appear in the intermediates set"
        );
    }

    /// Multiple intermediates: all non-signer certs returned, signer excluded.
    #[test]
    fn extract_intermediates_returns_multiple_non_signer_certs() {
        let (signer_der, signer_priv) = p256_test_cert_and_key(32);
        let (int1, _) = p256_test_cert_and_key(33);
        let (int2, _) = p256_test_cert_and_key(34);

        let signed_data_der = build_signed_data_with_extra_certs(
            b"signer + 2 intermediates",
            &signer_der,
            &signer_priv,
            &[int1.clone(), int2.clone()],
        );

        let intermediates =
            extract_intermediates(&signed_data_der).expect("extract ok");
        assert_eq!(intermediates.len(), 2, "two intermediates");
        assert!(intermediates.contains(&int1), "intermediate 1 present");
        assert!(intermediates.contains(&int2), "intermediate 2 present");
        assert!(
            !intermediates.contains(&signer_der),
            "signer leaf excluded"
        );
    }

    /// Single-cert SignedData (only the signer leaf) → empty intermediates.
    #[test]
    fn extract_intermediates_empty_when_only_signer_present() {
        let (signer_der, signer_priv) = p256_test_cert_and_key(35);
        let signed_data_der = crate::cms_build::build_signed_data(
            b"single-cert",
            false,
            &signer_der,
            &signer_priv,
        )
        .unwrap();

        let intermediates =
            extract_intermediates(&signed_data_der).expect("extract ok");
        assert!(
            intermediates.is_empty(),
            "no intermediates when the signer leaf is the only cert"
        );
    }

    /// SignedData with the `certificates` field stripped → empty intermediates
    /// (not an error; the orchestrator passes an empty slice downstream).
    #[test]
    fn extract_intermediates_empty_when_cert_set_absent() {
        let (signer_der, signer_priv) = p256_test_cert_and_key(36);
        let signed_data_der = crate::cms_build::build_signed_data(
            b"no-certs",
            false,
            &signer_der,
            &signer_priv,
        )
        .unwrap();

        // Re-parse, drop `certificates`, re-encode (mirrors the
        // verify_no_signer_cert_yields_unknown_key_marker fixture pattern).
        let ci = ContentInfo::from_der(&signed_data_der).unwrap();
        let sd = SignedData::from_der(ci.content.to_der().unwrap().as_slice()).unwrap();
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
        let stripped_der = stripped_ci.to_der().unwrap();

        let intermediates = extract_intermediates(&stripped_der).expect("extract ok");
        assert!(
            intermediates.is_empty(),
            "no certificates set -> empty intermediates (not an error)"
        );
    }

    /// Malformed SignedData DER → `Malformed` error (no silent empty Vec on
    /// unparseable input — that would hide real corruption).
    #[test]
    fn extract_intermediates_malformed_input_is_error() {
        let garbage = [0x00u8; 4];
        let err = extract_intermediates(&garbage).unwrap_err();
        assert!(
            matches!(err, CryptoError::Malformed(_)),
            "non-CMS input must be Malformed, got {err:?}"
        );
    }

    // ─── G4-extend: RSA-PKCS1v1.5 / RSA-PSS / ECDSA-P384 signature verify ───
    //
    // The production `build_signed_data` only emits ECDSA-P256 (our own signed
    // mail). These tests build RSA / P-384 / PSS SignedData directly via the
    // cms builder (mirroring `build_signed_data_with_signing_time`) so the
    // *verify* dispatch can be exercised without openssl. The corresponding
    // openssl interop test is `openssl_sign_rsa_verifies_with_our_code`
    // (interop_tests.rs, un-ignored as part of this task).

    /// Build a P-384 self-signed S/MIME-leaf cert + PKCS#8 key for the
    /// P-384 signature round-trip. Mirrors `rsa_test_cert_and_key`'s
    /// `CertificateBuilder` sequence but with a `p384::ecdsa::SigningKey`.
    fn p384_test_cert_and_key(id: u32) -> (Vec<u8>, Vec<u8>) {
        use p384::ecdsa::{DerSignature as P384DerSignature, SigningKey as P384SigningKey};
        use p384::elliptic_curve::Generate as _;
        use pkcs8::EncodePrivateKey;
        use std::str::FromStr;
        use std::time::Duration;
        use x509_cert::builder::profile::BuilderProfile;
        use x509_cert::builder::{Builder, CertificateBuilder};
        use x509_cert::certificate::TbsCertificate;
        use x509_cert::ext::pkix::{KeyUsage, KeyUsages};
        use x509_cert::name::Name;
        use x509_cert::serial_number::SerialNumber;
        use x509_cert::time::Validity;
        use x509_cert::SubjectPublicKeyInfo;

        struct P384TestProfile {
            subject: Name,
        }
        impl BuilderProfile for P384TestProfile {
            fn get_subject(&self) -> Name {
                self.subject.clone()
            }
            fn get_issuer(&self, subject: &Name) -> Name {
                subject.clone()
            }
            fn build_extensions(
                &self,
                _spk: spki::SubjectPublicKeyInfoRef<'_>,
                _issuer_spk: spki::SubjectPublicKeyInfoRef<'_>,
                _tbs: &TbsCertificate,
            ) -> x509_cert::builder::Result<Vec<x509_cert::ext::Extension>> {
                Ok(Vec::new())
            }
        }

        let mut rng = rand::rng();
        let signing_key = P384SigningKey::generate_from_rng(&mut rng);
        let pub_spki = SubjectPublicKeyInfo::from_key(signing_key.verifying_key())
            .expect("build P-384 SPKI");

        let subject = Name::from_str(&format!("CN=p384-signer-{id}")).expect("subject name");
        let profile = P384TestProfile { subject };
        let serial = SerialNumber::from(id);
        let validity =
            Validity::from_now(Duration::from_secs(365 * 24 * 60 * 60)).expect("validity");
        let mut builder =
            CertificateBuilder::new(profile, serial, validity, pub_spki).expect("cert builder");
        let key_usage = KeyUsage(KeyUsages::DigitalSignature | KeyUsages::KeyEncipherment);
        builder.add_extension(&key_usage).expect("key usage ext");
        let cert = builder
            .build::<_, P384DerSignature>(&signing_key)
            .expect("build + sign P-384 cert");
        let cert_der = cert.to_der().expect("cert DER");
        // PKCS#8 DER of the P-384 private key (unencrypted).
        let priv_der = signing_key
            .to_pkcs8_der()
            .expect("P-384 PKCS#8 DER");
        (cert_der, priv_der.as_bytes().to_vec())
    }

    /// Build a CMS SignedData over `payload`, signed with **RSA-PKCS1v1.5 +
    /// SHA-256** by `signer_cert_der` + `signer_priv_pkcs8_der`. Mirrors
    /// `build_signed_data_with_signing_time` but swaps the p256 ecdsa signer
    /// for `rsa::pkcs1v15::SigningKey::<Sha256>`.
    fn build_rsa_pkcs1v15_signed_data(
        payload: &[u8],
        signer_cert_der: &[u8],
        signer_priv_pkcs8_der: &[u8],
    ) -> Vec<u8> {
        use cms::builder::{SignedDataBuilder, SignerInfoBuilder};
        use cms::cert::{CertificateChoices, IssuerAndSerialNumber};
        use cms::signed_data::{EncapsulatedContentInfo, SignerIdentifier};
        use der::Any;
        use pkcs8::DecodePrivateKey;
        use rsa::pkcs1v15::SigningKey;
        use sha2::Sha256;
        use spki::AlgorithmIdentifierOwned;
        use x509_cert::Certificate;

        let cert = <Certificate as der::Decode>::from_der(signer_cert_der).unwrap();
        let tbs = cert.tbs_certificate();
        let sid = SignerIdentifier::IssuerAndSerialNumber(IssuerAndSerialNumber {
            issuer: tbs.issuer().clone(),
            serial_number: tbs.serial_number().clone(),
        });
        let rsa_priv = rsa::RsaPrivateKey::from_pkcs8_der(signer_priv_pkcs8_der).unwrap();
        let signing_key = SigningKey::<Sha256>::new(rsa_priv);

        let econtent = Some(Any::new(der::Tag::OctetString, payload.to_vec()).unwrap());
        let encap = EncapsulatedContentInfo {
            econtent_type: const_oid::db::rfc5911::ID_DATA,
            econtent,
        };
        let digest_algorithm = AlgorithmIdentifierOwned {
            oid: ID_SHA_256,
            parameters: None,
        };
        let signer_info_builder = SignerInfoBuilder::new(
            sid,
            digest_algorithm.clone(),
            &encap,
            None,
        )
        .unwrap();
        let content_info = SignedDataBuilder::new(&encap)
            .add_digest_algorithm(digest_algorithm)
            .unwrap()
            .add_certificate(CertificateChoices::Certificate(cert))
            .unwrap()
            .add_signer_info::<SigningKey<Sha256>, rsa::pkcs1v15::Signature>(
                signer_info_builder,
                &signing_key,
            )
            .unwrap()
            .build()
            .unwrap();
        content_info.to_der().unwrap()
    }

    /// Build a CMS SignedData over `payload`, signed with **ECDSA-P384 +
    /// SHA-384** by `signer_cert_der` + `signer_priv_pkcs8_der`.
    fn build_p384_signed_data(
        payload: &[u8],
        signer_cert_der: &[u8],
        signer_priv_pkcs8_der: &[u8],
    ) -> Vec<u8> {
        use cms::builder::{SignedDataBuilder, SignerInfoBuilder};
        use cms::cert::{CertificateChoices, IssuerAndSerialNumber};
        use cms::signed_data::{EncapsulatedContentInfo, SignerIdentifier};
        use der::Any;
        use p384::ecdsa::{DerSignature as P384DerSignature, SigningKey as P384SigningKey};
        use pkcs8::DecodePrivateKey;
        use spki::AlgorithmIdentifierOwned;
        use x509_cert::Certificate;

        /// SHA-384 OID (2.16.840.1.101.3.4.2.2).
        const ID_SHA_384: const_oid::ObjectIdentifier =
            const_oid::ObjectIdentifier::new_unwrap("2.16.840.1.101.3.4.2.2");

        let cert = <Certificate as der::Decode>::from_der(signer_cert_der).unwrap();
        let tbs = cert.tbs_certificate();
        let sid = SignerIdentifier::IssuerAndSerialNumber(IssuerAndSerialNumber {
            issuer: tbs.issuer().clone(),
            serial_number: tbs.serial_number().clone(),
        });
        let secret = p384::SecretKey::from_pkcs8_der(signer_priv_pkcs8_der).unwrap();
        let signing_key = P384SigningKey::from(&secret);

        let econtent = Some(Any::new(der::Tag::OctetString, payload.to_vec()).unwrap());
        let encap = EncapsulatedContentInfo {
            econtent_type: const_oid::db::rfc5911::ID_DATA,
            econtent,
        };
        let digest_algorithm = AlgorithmIdentifierOwned {
            oid: ID_SHA_384,
            parameters: None,
        };
        let signer_info_builder = SignerInfoBuilder::new(
            sid,
            digest_algorithm.clone(),
            &encap,
            None,
        )
        .unwrap();
        let content_info = SignedDataBuilder::new(&encap)
            .add_digest_algorithm(digest_algorithm)
            .unwrap()
            .add_certificate(CertificateChoices::Certificate(cert))
            .unwrap()
            .add_signer_info::<ecdsa::SigningKey<p384::NistP384>, P384DerSignature>(
                signer_info_builder,
                &signing_key,
            )
            .unwrap()
            .build()
            .unwrap();
        content_info.to_der().unwrap()
    }

    /// Build a CMS SignedData over `payload`, signed with **RSA-PSS + SHA-256**
    /// by `signer_cert_der` + `signer_priv_pkcs8_der`. RSA-PSS is randomized,
    /// so it uses `add_signer_info_with_rng`.
    fn build_rsa_pss_signed_data(
        payload: &[u8],
        signer_cert_der: &[u8],
        signer_priv_pkcs8_der: &[u8],
    ) -> Vec<u8> {
        use cms::builder::{SignedDataBuilder, SignerInfoBuilder};
        use cms::cert::{CertificateChoices, IssuerAndSerialNumber};
        use cms::signed_data::{EncapsulatedContentInfo, SignerIdentifier};
        use der::Any;
        use pkcs8::DecodePrivateKey;
        use rsa::pss::SigningKey as PssSigningKey;
        use sha2::Sha256;
        use spki::AlgorithmIdentifierOwned;
        use x509_cert::Certificate;

        let cert = <Certificate as der::Decode>::from_der(signer_cert_der).unwrap();
        let tbs = cert.tbs_certificate();
        let sid = SignerIdentifier::IssuerAndSerialNumber(IssuerAndSerialNumber {
            issuer: tbs.issuer().clone(),
            serial_number: tbs.serial_number().clone(),
        });
        let rsa_priv = rsa::RsaPrivateKey::from_pkcs8_der(signer_priv_pkcs8_der).unwrap();
        let signing_key = PssSigningKey::<Sha256>::new(rsa_priv);

        let econtent = Some(Any::new(der::Tag::OctetString, payload.to_vec()).unwrap());
        let encap = EncapsulatedContentInfo {
            econtent_type: const_oid::db::rfc5911::ID_DATA,
            econtent,
        };
        let digest_algorithm = AlgorithmIdentifierOwned {
            oid: ID_SHA_256,
            parameters: None,
        };
        let signer_info_builder = SignerInfoBuilder::new(
            sid,
            digest_algorithm.clone(),
            &encap,
            None,
        )
        .unwrap();
        let mut rng = rand::rng();
        let content_info = SignedDataBuilder::new(&encap)
            .add_digest_algorithm(digest_algorithm)
            .unwrap()
            .add_certificate(CertificateChoices::Certificate(cert))
            .unwrap()
            .add_signer_info_with_rng::<PssSigningKey<Sha256>, rsa::pss::Signature, _>(
                signer_info_builder,
                &signing_key,
                &mut rng,
            )
            .unwrap()
            .build()
            .unwrap();
        content_info.to_der().unwrap()
    }

    /// RSA-PKCS1v1.5 + SHA-256 SignedData built in-test → `verify_signed`
    /// returns `sig_ok=true`. Closes the G4-extend RSA carry-forward (the
    /// `#[ignore]`d openssl sibling is `openssl_sign_rsa_verifies_with_our_code`).
    #[test]
    fn verify_round_trips_rsa_pkcs1v15_signed_data() {
        let (cert_der, priv_pkcs8) = rsa_test_cert_and_key(40);
        let payload = b"signed by RSA-PKCS1v1.5";
        let signed_data_der = build_rsa_pkcs1v15_signed_data(payload, &cert_der, &priv_pkcs8);
        let check = verify_signed(&signed_data_der, None).expect("parse RSA-signed CMS");
        assert!(
            check.sig_ok,
            "RSA-PKCS1v1.5 signature must verify; got check={check:?}"
        );
        assert!(check.signer_cert_der.is_some(), "signer cert located");
        assert!(
            check.signer_fingerprint.is_some(),
            "signer fingerprint populated"
        );
    }

    /// ECDSA-P384 + SHA-384 SignedData → `sig_ok=true` (the messageDigest
    /// attribute is SHA-384, exercising the digest dispatch).
    #[test]
    fn verify_round_trips_p384_signed_data() {
        let (cert_der, priv_pkcs8) = p384_test_cert_and_key(41);
        let payload = b"signed by ECDSA-P384";
        let signed_data_der = build_p384_signed_data(payload, &cert_der, &priv_pkcs8);
        let check = verify_signed(&signed_data_der, None).expect("parse P-384-signed CMS");
        assert!(
            check.sig_ok,
            "ECDSA-P384 signature must verify; got check={check:?}"
        );
    }

    /// RSA-PSS + SHA-256 SignedData → `sig_ok=true`. The signature algorithm
    /// is `id-RSASSA-PSS` with the hash in the PSS params; verifies the
    /// dispatch parses the PSS params and picks `rsa::pss::VerifyingKey`.
    #[test]
    fn verify_round_trips_rsa_pss_signed_data() {
        let (cert_der, priv_pkcs8) = rsa_test_cert_and_key(42);
        let payload = b"signed by RSA-PSS";
        let signed_data_der = build_rsa_pss_signed_data(payload, &cert_der, &priv_pkcs8);
        let check = verify_signed(&signed_data_der, None).expect("parse RSA-PSS-signed CMS");
        assert!(
            check.sig_ok,
            "RSA-PSS signature must verify; got check={check:?}"
        );
    }

    /// An unsupported signature algorithm (id-Ed25519, 1.3.101.112) must yield
    /// `sig_ok=false` — NOT an `Err`. The "unknown algorithm = unverified, not
    /// broken" contract is load-bearing: the backend maps it to
    /// `SignatureState::Invalid` (a verdict), distinct from a CMS parse failure.
    /// Exercises the catch-all `_ => Ok(false)` arm in `verify_signer_signature`.
    #[test]
    fn verify_unsupported_signature_algorithm_yields_sig_ok_false() {
        use spki::AlgorithmIdentifierOwned;
        let (cert_der, _) = p256_test_cert_and_key(43);
        let cert = <x509_cert::Certificate as der::Decode>::from_der(&cert_der)
            .expect("parse signer cert");
        let unsupported = AlgorithmIdentifierOwned {
            oid: const_oid::ObjectIdentifier::new_unwrap("1.3.101.112"), // id-Ed25519
            parameters: None,
        };
        let digest = AlgorithmIdentifierOwned {
            oid: ID_SHA_256,
            parameters: None,
        };
        let ok = verify_signer_signature(&cert, b"signed-attrs", b"sig", &digest, &unsupported)
            .expect("unsupported algorithm must not be a hard error");
        assert!(
            !ok,
            "unsupported algorithm must yield sig_ok=false, got {ok}"
        );
    }

    /// A structurally well-formed SignedData with a **malformed** ECDSA
    /// `encryptedDigest` (unparseable `DerSignature`) must yield `sig_ok=false`,
    /// NOT an `Err`. The "unverifiable = Invalid, not a parse error" contract
    /// must hold symmetrically for ECDSA and RSA (controller-review Important
    /// finding on the G4-extend task — the ECDSA inners originally propagated
    /// the parse failure as `Err(Malformed)` while the RSA arms returned
    /// `Ok(false)`).
    #[test]
    fn verify_malformed_ecdsa_signature_yields_sig_ok_false_not_error() {
        let (cert_der, _) = p256_test_cert_and_key(44);
        let cert = <x509_cert::Certificate as der::Decode>::from_der(&cert_der)
            .expect("parse P-256 cert");
        // A single 0x00 byte cannot parse as a DER ECDSA signature.
        let ok = verify_ecdsa_p256_signature_inner(&cert, b"signed-attrs", &[0x00])
            .expect("malformed P-256 sig must NOT be a hard error");
        assert!(!ok, "malformed P-256 signature must yield sig_ok=false");

        let (p384_der, _) = p384_test_cert_and_key(45);
        let p384_cert = <x509_cert::Certificate as der::Decode>::from_der(&p384_der)
            .expect("parse P-384 cert");
        let ok384 = verify_ecdsa_p384_signature_inner(&p384_cert, b"signed-attrs", &[0x00])
            .expect("malformed P-384 sig must NOT be a hard error");
        assert!(!ok384, "malformed P-384 signature must yield sig_ok=false");
    }
}
