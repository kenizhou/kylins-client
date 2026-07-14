use serde::{Deserialize, Serialize};

/// Five-value acceptance ladder (Thunderbird model). Only `Verified` and
/// `Personal` auto-qualify a recipient key for encryption; below that, the
/// composer routes the recipient to the Key Assistant.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum TrustState {
    Rejected,
    Undecided,
    Unverified,
    Verified,
    Personal,
}

impl TrustState {
    /// A key at this level may be used to encrypt to a recipient without an
    /// explicit per-send confirmation.
    pub fn may_encrypt_to(self) -> bool {
        matches!(self, TrustState::Verified | TrustState::Personal)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_verified_and_personal_auto_qualify() {
        assert!(!TrustState::Unverified.may_encrypt_to());
        assert!(TrustState::Verified.may_encrypt_to());
        assert!(TrustState::Personal.may_encrypt_to());
        assert!(!TrustState::Rejected.may_encrypt_to());
    }
}
