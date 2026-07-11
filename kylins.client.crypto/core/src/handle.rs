use serde::{Deserialize, Serialize};

use crate::ids::{Fingerprint, KeyId, TokenKeyId};
use crate::standard::Standard;

/// What a key may be used for. Stored per key; selectors pick the right key
/// for each operation so a signing key is never used to encrypt.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum KeyUsage {
    Sign,
    Encrypt,
    SignAndEncrypt,
}

/// Where a key's private half lives. Software keys expose encrypted bytes at
/// rest through a `KeyStore`; token keys never leave the device — operations
/// are delegated to the token by the backend.
#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
// NOTE: Adjacently-tagged (`tag` + `content`) rather than internally-tagged
// (`tag` only) because serde's internally-tagged representation cannot
// serialize newtype variants wrapping a non-struct/map type (Software(KeyId)
// where KeyId wraps String). This keeps the Rust types identical to the plan
// (no constructor changes) while preserving the `"kind":"software"` /
// `"kind":"token"` discriminator keys the tests assert on.
#[serde(tag = "kind", content = "data", rename_all = "lowercase")]
pub enum KeyHandle {
    Software(KeyId),
    Token {
        token_serial: String,
        key_id: TokenKeyId,
    },
}

/// A *reference* to a key — everything the application layer and the IPC
/// boundary ever see. Raw key bytes never appear here by construction.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct KeyHandleRef {
    pub handle: KeyHandle,
    pub standard: Standard,
    pub fingerprint: Fingerprint,
    pub usage: KeyUsage,
    pub algorithm: String,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn token_handle_serde_roundtrip() {
        let r = KeyHandleRef {
            handle: KeyHandle::Token {
                token_serial: "YubiKey-001".into(),
                key_id: TokenKeyId("slot-9a".into()),
            },
            standard: Standard::OpenPgp,
            fingerprint: Fingerprint::new("AB12CD34"),
            usage: KeyUsage::Sign,
            algorithm: "Ed25519".into(),
        };
        let json = serde_json::to_string(&r).unwrap();
        let back: KeyHandleRef = serde_json::from_str(&json).unwrap();
        assert_eq!(r, back);
        // Token handle is tagged "kind":"token".
        assert!(json.contains("\"kind\":\"token\""));
    }

    #[test]
    fn software_handle_tagged_software() {
        let h = KeyHandle::Software(KeyId("k1".into()));
        let json = serde_json::to_string(&h).unwrap();
        assert!(json.contains("\"kind\":\"software\""));
    }
}
