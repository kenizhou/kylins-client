//! Proves the backend can consume the `crypto-core` crate across the path
//! dependency, and that the neutral envelope + key-handle types round-trip
//! across the serde boundary the IPC layer will use.

use crypto_core::{
    EncryptedEnvelope, EncryptedPart, Fingerprint, KeyHandle, KeyHandleRef, KeyId, KeyPacketRef,
    KeyUsage, PartId, PartKind, SerializationStrategy, Standard,
};

#[test]
fn neutral_envelope_roundtrips_through_serde() {
    let recipient = KeyHandleRef {
        handle: KeyHandle::Software(KeyId("sign-1".into())),
        standard: Standard::Smime,
        fingerprint: Fingerprint::new("AABBCCDD"),
        usage: KeyUsage::SignAndEncrypt,
        algorithm: "RSA-4096".into(),
    };
    let env = EncryptedEnvelope {
        standard: Standard::Smime,
        serialization: SerializationStrategy::SingleMimeBlob,
        parts: vec![EncryptedPart {
            id: PartId("body".into()),
            kind: PartKind::Body,
            ciphertext: vec![0xDE, 0xAD, 0xBE, 0xEF],
            signature: None,
        }],
        recipients: vec![KeyPacketRef {
            recipient,
            packet: vec![1, 2, 3, 4],
        }],
    };
    let json = serde_json::to_string(&env).expect("serialize envelope");
    let back: EncryptedEnvelope = serde_json::from_str(&json).expect("deserialize envelope");
    assert_eq!(back.parts.len(), 1);
    assert_eq!(back.serialization, SerializationStrategy::SingleMimeBlob);
    assert_eq!(back.standard, Standard::Smime);
}

#[test]
fn vault_aad_roundtrip_from_backend() {
    // The hardened v1 vault is usable from the backend's own crate root.
    let blob =
        kylins_client_lib::crypto::encrypt_with_aad(b"identity-key-blob", b"kylins:acct-1:smime:1")
            .expect("encrypt_with_aad");
    let pt = kylins_client_lib::crypto::decrypt_with_aad(&blob, b"kylins:acct-1:smime:1")
        .expect("decrypt_with_aad");
    assert_eq!(pt, b"identity-key-blob");
}
