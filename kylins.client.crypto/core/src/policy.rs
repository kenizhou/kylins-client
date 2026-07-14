use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum HashAlgorithm {
    Sha256,
    Sha384,
    Sha512,
    Sha3_256,
    Sm3,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum SymmetricAlgorithm {
    Aes128,
    Aes256,
    Aes128Gcm,
    Aes256Gcm,
    Sm4Cbc,
    Sm4Gcm,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum AeadAlgorithm {
    Ocb,
    Eax,
    Gcm,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum PkAlgorithm {
    Ed25519,
    X25519,
    EcdsaP256,
    EcdsaP384,
    Rsa3072Plus,
    Sm2,
}

/// Resource caps shared across backends to bound DoS exposure.
#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
pub struct DosLimits {
    pub max_message_size: u64,
    pub max_s2k_trials: u32,
}

/// Versioned allow/reject algorithm table. Every backend consults it before
/// operating. Override precedence (applied outside this crate): built-in →
/// global → per-account → per-operation.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CryptoPolicy {
    pub allowed_hashes: Vec<HashAlgorithm>,
    pub allowed_symmetric: Vec<SymmetricAlgorithm>,
    pub allowed_aead: Vec<AeadAlgorithm>,
    pub allowed_pk: Vec<PkAlgorithm>,
    pub rejected_hashes: Vec<HashAlgorithm>,
    pub rejected_symmetric: Vec<SymmetricAlgorithm>,
    pub rejected_pk: Vec<PkAlgorithm>,
    pub min_rsa_bits: u32,
    pub dos: DosLimits,
}

impl CryptoPolicy {
    /// A modern baseline across all three standards. Each backend intersects
    /// this with the subset relevant to its standard (e.g. 国密 reads SM entries).
    pub fn default_baseline() -> Self {
        use AeadAlgorithm::*;
        use HashAlgorithm::*;
        use PkAlgorithm::*;
        use SymmetricAlgorithm::*;
        Self {
            allowed_hashes: vec![Sha256, Sha384, Sha512, Sm3],
            allowed_symmetric: vec![Aes256Gcm, Aes128Gcm, Aes256, Aes128, Sm4Gcm, Sm4Cbc],
            allowed_aead: vec![Gcm, Ocb, Eax],
            allowed_pk: vec![Ed25519, X25519, EcdsaP256, EcdsaP384, Rsa3072Plus, Sm2],
            rejected_hashes: vec![],
            rejected_symmetric: vec![],
            rejected_pk: vec![],
            min_rsa_bits: 3072,
            dos: DosLimits {
                max_message_size: 50 * 1024 * 1024,
                max_s2k_trials: 5,
            },
        }
    }

    pub fn is_hash_allowed(&self, a: HashAlgorithm) -> bool {
        self.allowed_hashes.contains(&a) && !self.rejected_hashes.contains(&a)
    }

    pub fn is_symmetric_allowed(&self, a: SymmetricAlgorithm) -> bool {
        self.allowed_symmetric.contains(&a) && !self.rejected_symmetric.contains(&a)
    }

    pub fn is_pk_allowed(&self, a: PkAlgorithm) -> bool {
        self.allowed_pk.contains(&a) && !self.rejected_pk.contains(&a)
    }
}

impl Default for CryptoPolicy {
    fn default() -> Self {
        Self::default_baseline()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn baseline_allows_modern_rejects_via_reject_list() {
        let mut p = CryptoPolicy::default_baseline();
        assert!(p.is_pk_allowed(PkAlgorithm::Ed25519));
        assert!(p.is_hash_allowed(HashAlgorithm::Sm3));
        // Rejecting Sm3 flips it to disallowed even though it's in the allow list.
        p.rejected_hashes.push(HashAlgorithm::Sm3);
        assert!(!p.is_hash_allowed(HashAlgorithm::Sm3));
    }

    #[test]
    fn dos_caps_match_spec() {
        let p = CryptoPolicy::default_baseline();
        assert_eq!(p.dos.max_message_size, 50 * 1024 * 1024);
        assert_eq!(p.dos.max_s2k_trials, 5);
    }
}
