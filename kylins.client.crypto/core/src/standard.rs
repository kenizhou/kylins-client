use serde::{Deserialize, Serialize};

use crate::error::CryptoError;

/// The crypto standard a key or message belongs to. Stored in the `standard`
/// column of `crypto_keys` and used to dispatch to the right `CryptoBackend`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Standard {
    OpenPgp,
    Smime,
    Sm,
}

impl Standard {
    pub fn as_str(self) -> &'static str {
        match self {
            Standard::OpenPgp => "openpgp",
            Standard::Smime => "smime",
            Standard::Sm => "sm",
        }
    }
}

impl std::fmt::Display for Standard {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(self.as_str())
    }
}

impl std::str::FromStr for Standard {
    type Err = CryptoError;
    fn from_str(s: &str) -> Result<Self, Self::Err> {
        match s {
            "openpgp" => Ok(Standard::OpenPgp),
            "smime" => Ok(Standard::Smime),
            "sm" => Ok(Standard::Sm),
            other => Err(CryptoError::UnsupportedStandard(other.to_string())),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn serde_roundtrip_preserves_variant() {
        for s in [Standard::OpenPgp, Standard::Smime, Standard::Sm] {
            let json = serde_json::to_string(&s).unwrap();
            let back: Standard = serde_json::from_str(&json).unwrap();
            assert_eq!(s, back);
        }
    }

    #[test]
    fn serde_uses_lowercase_keys() {
        assert_eq!(
            serde_json::to_string(&Standard::OpenPgp).unwrap(),
            "\"openpgp\""
        );
    }

    #[test]
    fn from_str_roundtrip() {
        let s: Standard = "smime".parse().unwrap();
        assert_eq!(s, Standard::Smime);
    }
}
