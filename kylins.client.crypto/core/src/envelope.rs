use serde::{Deserialize, Serialize};

use crate::handle::KeyHandleRef;
use crate::standard::Standard;

#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub struct PartId(pub String);

/// What a part represents inside a message.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "lowercase")]
pub enum PartKind {
    Body,
    Attachment {
        filename: String,
        mime: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        content_id: Option<String>,
    },
}

/// A plaintext input part (the body, or one attachment) feeding `encrypt_parts`.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Part {
    pub id: PartId,
    pub kind: PartKind,
    pub data: Vec<u8>,
}

/// A detached signature over a single part's ciphertext, so a forwarded part
/// can be verified independently of the body.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DetachedSignature {
    pub standard: Standard,
    pub signer: KeyHandleRef,
    pub signature: Vec<u8>,
}

/// One encrypted part. `ciphertext` is wire-format-agnostic; `signature` is
/// independent of the body's signature.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct EncryptedPart {
    pub id: PartId,
    pub kind: PartKind,
    pub ciphertext: Vec<u8>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub signature: Option<DetachedSignature>,
}

/// How a set of parts is serialized onto the wire. Form-A outbound is always
/// `SingleMimeBlob`; `SplitPerPart` is reserved for future internal paths.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SerializationStrategy {
    SplitPerPart,
    SingleMimeBlob,
}

/// One per-recipient key-wrap packet (opaque wire bytes).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct KeyPacketRef {
    pub recipient: KeyHandleRef,
    pub packet: Vec<u8>,
}

/// The neutral encrypted message the application layer holds regardless of
/// backend. For S/MIME, `parts` collapses to one (the CMS `EnvelopedData`
/// wraps the whole MIME tree).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct EncryptedEnvelope {
    pub standard: Standard,
    pub serialization: SerializationStrategy,
    pub parts: Vec<EncryptedPart>,
    pub recipients: Vec<KeyPacketRef>,
}

/// A signed payload (detached signature carried alongside plaintext).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SignedEnvelope {
    pub standard: Standard,
    pub payload: Vec<u8>,
    pub signature: DetachedSignature,
}

/// The decrypted plaintext parts, with the standard that produced them.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DecryptedPayload {
    pub standard: Standard,
    pub parts: Vec<Part>,
}

/// Signature outcome, decoupled from decryption so "decrypted OK, signature
/// unverified" is a real, distinct state.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SignatureState {
    NotSigned,
    ValidVerified,
    ValidUnverified,
    Invalid,
    UnknownKey,
    Mismatch,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct VerificationResult {
    pub state: SignatureState,
    /// The signer key, when one was identified.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub signer: Option<KeyHandleRef>,
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::handle::{KeyHandle, KeyUsage};
    use crate::ids::{Fingerprint, KeyId};

    fn dummy_ref() -> KeyHandleRef {
        KeyHandleRef {
            handle: KeyHandle::Software(KeyId("k1".into())),
            standard: Standard::Smime,
            fingerprint: Fingerprint::new("deadbeef"),
            usage: KeyUsage::SignAndEncrypt,
            algorithm: "RSA-4096".into(),
        }
    }

    #[test]
    fn envelope_serde_roundtrip_single_blob() {
        let env = EncryptedEnvelope {
            standard: Standard::Smime,
            serialization: SerializationStrategy::SingleMimeBlob,
            parts: vec![EncryptedPart {
                id: PartId("body".into()),
                kind: PartKind::Body,
                ciphertext: vec![1, 2, 3],
                signature: None,
            }],
            recipients: vec![KeyPacketRef {
                recipient: dummy_ref(),
                packet: vec![9, 9],
            }],
        };
        let json = serde_json::to_string(&env).unwrap();
        let back: EncryptedEnvelope = serde_json::from_str(&json).unwrap();
        assert_eq!(back.standard, Standard::Smime);
        assert_eq!(back.serialization, SerializationStrategy::SingleMimeBlob);
        assert_eq!(back.parts.len(), 1);
        assert_eq!(back.recipients.len(), 1);
    }

    #[test]
    fn verification_result_default_signer_none() {
        let v = VerificationResult {
            state: SignatureState::NotSigned,
            signer: None,
        };
        let json = serde_json::to_string(&v).unwrap();
        assert!(!json.contains("signer"), "None signer is skipped");
    }
}
