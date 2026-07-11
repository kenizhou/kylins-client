//! Shared utilities.

use subtle::ConstantTimeEq;

/// Constant-time byte comparison for MACs and fingerprints, so equality
/// checks do not leak via timing. Returns `true` iff the slices are equal.
pub fn constant_time_eq(a: &[u8], b: &[u8]) -> bool {
    a.ct_eq(b).into()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn equal_and_unequal() {
        assert!(constant_time_eq(b"abcdef", b"abcdef"));
        assert!(!constant_time_eq(b"abcdef", b"abcdeg"));
        assert!(!constant_time_eq(b"abc", b"abcd"));
    }
}
