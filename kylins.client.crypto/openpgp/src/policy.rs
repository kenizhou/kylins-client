//! Bridge between `crypto_core::CryptoPolicy` and Sequoia's `StandardPolicy`.
//!
//! Translates the framework-wide algorithm allow-set into Sequoia's policy
//! mechanism for the **write** path (modern only) and a relaxed policy for the
//! **read** path (admits legacy algorithms so old mail still decrypts and
//! verifies). A weak-algorithm detector inspects the algorithms actually used
//! by a verified Signature and returns a human-readable warning string when a
//! legacy/weak algo is observed — without failing the read operation itself.
//!
//! ## Design choices (Task 4 controller decisions)
//!
//! - **Mutate `StandardPolicy`** rather than implementing a custom `dyn Policy`:
//!   the spike (see `spike-notes.md ## policy-customization`) verified that
//!   [`StandardPolicy::accept_hash`] / [`StandardPolicy::accept_symmetric_algo`]
//!   / [`StandardPolicy::accept_asymmetric_algo`] are sufficient to admit the
//!   legacy read-path set. This keeps both policies as concrete `StandardPolicy`
//!   instances so tests can query `hash_cutoff` and the trait methods directly,
//!   and Tasks 5–7 can pass `&dyn Policy` to Sequoia's encrypt/sign/decrypt/
//!   verify builders.
//! - **`PgpPolicy` retains the framework `CryptoPolicy`** so Task 8's
//!   `OpenpgpBackend::policy()` can return it by reference (the engine does
//!   not re-derive the framework view from Sequoia state).
//! - **`note_weak` inspects only Signature-attached algorithms** (hash family +
//!   pk family). RSA-with-small-bits is detected separately via
//!   [`WeakAlgoDetector::is_rsa_too_small`] once the engine has resolved the
//!   signing Cert's key material; `Signature::pk_algo()` does not carry bit
//!   length (spike-notes `## weak-alg-detection`).
use crypto_core::CryptoPolicy;
use sequoia_openpgp as openpgp;
use sequoia_openpgp::policy::{AsymmetricAlgorithm, Policy, StandardPolicy};
use sequoia_openpgp::types::{
    HashAlgorithm as SqHash, PublicKeyAlgorithm as SqPk, SymmetricAlgorithm as SqSym,
};

/// OpenPGP-engine policy bundle.
///
/// Holds the framework [`CryptoPolicy`] (so `OpenpgpBackend::policy()` can
/// return it directly, Task 8) alongside two Sequoia policies — a modern
/// `write` policy and a relaxed `read` policy — plus a weak-algorithm detector
/// configured from the same framework policy.
pub struct PgpPolicy {
    /// Framework-wide algorithm policy. Task 8's backend.policy() returns
    /// this by reference.
    core: CryptoPolicy,
    /// Modern allow-set: Ed25519/X25519/P-256/P-384/RSA>=3072 + AES + SHA-2.
    /// `StandardPolicy::new()` defaults already match this; we additionally
    /// tighten RSA to `core.min_rsa_bits` if it exceeds Sequoia's 2048-bit
    /// default floor.
    pub(crate) write: StandardPolicy<'static>,
    /// Relaxed policy that admits legacy algorithms (SHA-1, MD5, 3DES, RSA any
    /// size) so the read path can decrypt/verify old mail without failing the
    /// operation. Weak algos are *detected* separately via `note_weak`.
    pub(crate) read: StandardPolicy<'static>,
    /// Weak-algorithm detector configured from `core`.
    weak: WeakAlgoDetector,
}

/// Detector that flags legacy/weak algorithms observed on the read path.
///
/// Stateless except for the RSA minimum bit threshold (which comes from the
/// framework `CryptoPolicy::min_rsa_bits` and is consulted by
/// [`Self::is_rsa_too_small`]).
pub struct WeakAlgoDetector {
    /// RSA keys smaller than this many bits are flagged as weak.
    min_rsa_bits: u32,
}

impl PgpPolicy {
    /// Translate a framework [`CryptoPolicy`] into a Sequoia-engine policy bundle.
    ///
    /// Produces two `StandardPolicy` instances:
    /// - **write**: modern defaults, tightened to `p.min_rsa_bits` if it exceeds
    ///   Sequoia's default 2048-bit floor.
    /// - **read**: permissive — admits SHA-1, MD5, 3DES, and RSA of any size so
    ///   decrypt/verify of legacy mail succeeds. Detection of these weak algos
    ///   is delegated to [`PgpPolicy::note_weak`] so the engine can still
    ///   surface a UI warning without failing the operation.
    pub fn from_core(p: &CryptoPolicy) -> PgpPolicy {
        // ---- write policy: tighten RSA floor if the framework demands >=3072.
        // Sequoia's `StandardPolicy::new()` defaults already accept RSA2048 /
        // RSA3072 / RSA4096 and reject RSA1024 (cutoff Feb 2014, see
        // `policy.rs:719`). The framework baseline is `min_rsa_bits = 3072`,
        // so we tighten by rejecting RSA2048 explicitly. (RSA1024 is already
        // rejected by the default cutoff — no action needed for it.)
        let mut write = StandardPolicy::new();
        if p.min_rsa_bits >= 3072 {
            write.reject_asymmetric_algo(AsymmetricAlgorithm::RSA2048);
        }
        // NOTE: if the framework `min_rsa_bits` were ever lower than Sequoia's
        // default 2048 (e.g. 1024 for extreme legacy interop), we would need
        // `write.accept_asymmetric_algo(RSA1024)` here. The framework baseline
        // is 3072, so this branch is not exercised today; documenting for the
        // reviewer / future tuning.

        // ---- read policy: admit legacy algorithms so old mail decrypts.
        let mut read = StandardPolicy::new();
        // Hashes: SHA-1 (common in old mail) + MD5 (rare but seen).
        read.accept_hash(SqHash::SHA1);
        read.accept_hash(SqHash::MD5);
        // Symmetric: 3DES — very common in pre-AEAD OpenPGP messages.
        // TripleDes is marked deprecated by Sequoia (use newer algos for new
        // output); here we *accept* it for reading legacy mail only.
        #[allow(deprecated)]
        read.accept_symmetric_algo(SqSym::TripleDES);
        // Asymmetric: admit small RSA so keys generated in the 1990s/2000s
        // can still decrypt/verify. RSA1024 has a default cutoff (Y2014M2);
        // accept it wholesale for the read path. RSA2048+ is already accepted
        // by default.
        read.accept_asymmetric_algo(AsymmetricAlgorithm::RSA1024);

        PgpPolicy {
            core: p.clone(),
            write,
            read,
            weak: WeakAlgoDetector {
                min_rsa_bits: p.min_rsa_bits,
            },
        }
    }

    /// Sequoia `&dyn Policy` for the **write** path (encrypt/sign/generate).
    pub fn write_policy(&self) -> &dyn Policy {
        &self.write
    }

    /// Sequoia `&dyn Policy` for the **read** path (decrypt/verify).
    pub fn read_policy(&self) -> &dyn Policy {
        &self.read
    }

    /// Borrow the underlying framework policy. Task 8's
    /// `OpenpgpBackend::policy()` returns this.
    pub fn core(&self) -> &CryptoPolicy {
        &self.core
    }

    /// Borrow the weak-algorithm detector (for non-Signature checks such as
    /// the symmetric algorithm of a decrypted session key).
    pub fn weak(&self) -> &WeakAlgoDetector {
        &self.weak
    }

    /// Inspect a verified Signature's algorithms and return a human-readable
    /// warning string if any legacy/weak algorithm was used. Returns `None`
    /// when the signature uses only modern algorithms.
    ///
    /// This is the hook for the engine to surface a "this message was signed
    /// with SHA-1, treat with caution" UI warning **without** failing the
    /// verification operation itself (the read policy already admitted the
    /// algorithm).
    ///
    /// Detects:
    /// - **Hash**: SHA-1, MD5 (both collision-broken).
    /// - **Public-key family**: DSA (removed from OpenPGP in RFC 9580).
    ///
    /// Does NOT detect RSA<small — `Signature::pk_algo()` reports the family
    /// (RSA) but not the bit length. The engine should resolve the signing
    /// Cert and call [`WeakAlgoDetector::is_rsa_too_small`] separately.
    pub fn note_weak(&self, sig: &openpgp::packet::Signature) -> Option<String> {
        self.weak.note_weak_signature(sig)
    }
}

impl Default for PgpPolicy {
    fn default() -> Self {
        Self::from_core(&CryptoPolicy::default_baseline())
    }
}

impl WeakAlgoDetector {
    /// Whether a symmetric algorithm used on the read path is considered weak.
    ///
    /// 3DES is the canonical legacy case (the pre-AEAD OpenPGP default for
    /// many implementations). AES-128 / AES-256 are modern and return `false`.
    #[allow(deprecated)] // TripleDes is deprecated; we test for it intentionally.
    pub fn is_weak_read_algo(&self, s: SqSym) -> bool {
        matches!(s, SqSym::TripleDES)
    }

    /// Whether a hash algorithm is considered weak (SHA-1 or MD5).
    ///
    /// Both are deprecated in Sequoia (their enum variants carry
    /// `#[deprecated]`), but they are still observable on legacy signatures;
    /// pattern-match is by value and does not construct a new one.
    #[allow(deprecated)]
    pub fn is_weak_hash(&self, h: SqHash) -> bool {
        matches!(h, SqHash::SHA1 | SqHash::MD5)
    }

    /// Whether a public-key algorithm family is legacy/weak (DSA).
    ///
    /// RSA-with-small-keys is detected separately via
    /// [`Self::is_rsa_too_small`] once the engine has resolved the signing
    /// key's bit length; `pk_algo()` alone reports only the family.
    #[allow(deprecated)] // DSA is deprecated; we test for it intentionally.
    pub fn is_weak_pk(&self, pk: SqPk) -> bool {
        matches!(pk, SqPk::DSA)
    }

    /// Whether an RSA key of `bits` is below the framework minimum.
    ///
    /// Call this after resolving the signing Cert's key material.
    pub fn is_rsa_too_small(&self, bits: u32) -> bool {
        bits < self.min_rsa_bits
    }

    /// Inspect a Signature packet's algorithms and return a warning string for
    /// the first weak algorithm encountered (hash family first, then pk).
    ///
    /// Internal helper behind [`PgpPolicy::note_weak`]; kept on the detector so
    /// the detector is independently testable without constructing a full
    /// `PgpPolicy`.
    fn note_weak_signature(&self, sig: &openpgp::packet::Signature) -> Option<String> {
        let h = sig.hash_algo();
        if self.is_weak_hash(h) {
            return Some(format!(
                "signature uses deprecated hash algorithm {:?}; \
                 treat signature with caution",
                h
            ));
        }
        let pk = sig.pk_algo();
        if self.is_weak_pk(pk) {
            return Some(format!(
                "signature uses legacy public-key algorithm {:?}; \
                 treat signature with caution",
                pk
            ));
        }
        None
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crypto_core::CryptoPolicy;
    use sequoia_openpgp::cert::prelude::*;
    use sequoia_openpgp::parse::{Parse, PacketParserBuilder};
    use sequoia_openpgp::policy::HashAlgoSecurity;
    use sequoia_openpgp::serialize::stream::{Message, Signer};
    use sequoia_openpgp::types::{
        HashAlgorithm as SqHash, SymmetricAlgorithm as SqSym,
    };
    use std::io::Write;

    /// Generate a Cert with a dedicated signing subkey (Task-1 spike `gen()` shape).
    fn gen() -> openpgp::Cert {
        let (cert, _rev) = CertBuilder::new()
            .add_userid("policy-test@example.org")
            .add_signing_subkey()
            .add_transport_encryption_subkey()
            .generate()
            .expect("CertBuilder::generate");
        cert
    }

    /// Build a real detached `Signature` packet signed with `hash`.
    ///
    /// Uses a permissive fixture policy (just for fixture creation) so we can
    /// produce a SHA-1-signed signature even though the production write policy
    /// forbids it. The returned `Signature` carries the requested `hash_algo()`
    /// and a real `pk_algo()` (EdDSA on the Cert's signing subkey), which is
    /// exactly what `note_weak` inspects in production via `GoodChecksum.sig`.
    fn sign_fixture_with_hash(cert: &openpgp::Cert, hash: SqHash) -> openpgp::packet::Signature {
        // Permissive fixture policy so Sequoia will sign with the requested hash.
        let mut fixture_policy = StandardPolicy::new();
        fixture_policy.accept_hash(hash);

        let keypair = cert
            .keys()
            .unencrypted_secret()
            .with_policy(&fixture_policy, None)
            .supported()
            .alive()
            .revoked(false)
            .for_signing()
            .next()
            .expect("signing subkey exists")
            .key()
            .clone()
            .into_keypair()
            .expect("into_keypair");

        let mut buf = Vec::new();
        let msg = Message::new(&mut buf);
        let signer = Signer::new(msg, keypair)
            .expect("Signer::new")
            .hash_algo(hash)
            .expect("hash_algo setter");
        let mut w = signer.detached().build().expect("signer build");
        w.write_all(b"fixture payload").expect("write_all");
        w.finalize().expect("finalize");

        // `buf` holds a single detached Signature packet. Parse it out via
        // PacketParserBuilder (Parse::from_bytes) + build() + recurse().
        let ppr = PacketParserBuilder::from_bytes(&buf)
            .expect("PacketParserBuilder::from_bytes")
            .build()
            .expect("parser build");
        // PacketParserResult is `Some(PacketParser) | EOF`. Match out the parser
        // and call `recurse()` to materialize the Packet (verified at
        // `parse.rs:5638`).
        let pp = match ppr {
            openpgp::parse::PacketParserResult::Some(pp) => pp,
            _ => panic!("expected at least one packet in fixture"),
        };
        let (packet, _) = pp.recurse().expect("recurse");
        match packet {
            openpgp::Packet::Signature(s) => s,
            other => panic!("expected Signature packet, got {other:?}"),
        }
    }

    // ----- WeakAlgoDetector helper-function tests (pure) ---------------------

    #[test]
    fn is_weak_read_algo_flags_3des_not_aes() {
        let det = WeakAlgoDetector { min_rsa_bits: 3072 };
        // 3DES is the legacy symmetric algo old mail may use; flag it.
        #[allow(deprecated)]
        {
            assert!(
                det.is_weak_read_algo(SqSym::TripleDES),
                "3DES must be flagged as weak"
            );
        }
        // AES-256 / AES-128 are modern; must NOT be flagged.
        assert!(
            !det.is_weak_read_algo(SqSym::AES256),
            "AES-256 must NOT be flagged as weak"
        );
        assert!(
            !det.is_weak_read_algo(SqSym::AES128),
            "AES-128 must NOT be flagged as weak"
        );
    }

    #[test]
    fn is_weak_hash_flags_sha1_and_md5_not_sha256() {
        let det = WeakAlgoDetector { min_rsa_bits: 3072 };
        #[allow(deprecated)]
        {
            assert!(det.is_weak_hash(SqHash::SHA1), "SHA-1 is weak");
            assert!(det.is_weak_hash(SqHash::MD5), "MD5 is weak");
        }
        assert!(!det.is_weak_hash(SqHash::SHA256), "SHA-256 is not weak");
        assert!(!det.is_weak_hash(SqHash::SHA512), "SHA-512 is not weak");
    }

    #[test]
    fn is_rsa_too_small_uses_min_rsa_bits_threshold() {
        let det = WeakAlgoDetector { min_rsa_bits: 3072 };
        assert!(det.is_rsa_too_small(1024), "RSA-1024 < 3072");
        assert!(det.is_rsa_too_small(2048), "RSA-2048 < 3072");
        assert!(!det.is_rsa_too_small(3072), "RSA-3072 meets threshold");
        assert!(!det.is_rsa_too_small(4096), "RSA-4096 exceeds threshold");
    }

    // ----- PgpPolicy construction -------------------------------------------

    #[test]
    fn from_core_default_returns_pgp_policy_exposing_core() {
        // Smoke test: from_core must not panic on the baseline policy and the
        // accessors must round-trip the framework policy.
        let core = CryptoPolicy::default_baseline();
        let pgp = PgpPolicy::from_core(&core);
        // core() returns the same policy by reference.
        assert_eq!(pgp.core().min_rsa_bits, core.min_rsa_bits);
        assert_eq!(pgp.core().allowed_hashes.len(), core.allowed_hashes.len());
        // weak() returns the detector with the configured RSA threshold.
        assert_eq!(pgp.weak().min_rsa_bits, core.min_rsa_bits);
    }

    // ----- Write policy = modern (rejects SHA-1) ----------------------------

    #[test]
    fn write_policy_rejects_sha1_via_hash_cutoff() {
        // The write policy's `StandardPolicy` must have a SHA-1 cutoff for
        // CollisionResistance (i.e. SHA-1 is rejected for data signatures).
        // `hash_cutoff` is a `StandardPolicy`-specific method (NOT on the
        // `Policy` trait — verified at `policy.rs:1116`), so we use the
        // `pub(crate)` field access rather than the `&dyn Policy` accessor.
        let core = CryptoPolicy::default_baseline();
        let pgp = PgpPolicy::from_core(&core);
        let cutoff = pgp
            .write
            .hash_cutoff(SqHash::SHA1, HashAlgoSecurity::CollisionResistance);
        assert!(
            cutoff.is_some(),
            "write policy must have a SHA-1 cutoff (reject it for data signatures)"
        );
    }

    #[test]
    fn write_policy_tightens_rsa_to_3072() {
        // The framework baseline demands min_rsa_bits = 3072; the write policy
        // must reject RSA2048 (which `StandardPolicy::new()` accepts by default).
        let core = CryptoPolicy::default_baseline();
        assert_eq!(core.min_rsa_bits, 3072, "baseline demands RSA-3072");
        let pgp = PgpPolicy::from_core(&core);
        // RSA2048 should have a cutoff now (rejected). RSA3072 should have none.
        let rsa2048_cutoff = pgp
            .write
            .asymmetric_algo_cutoff(AsymmetricAlgorithm::RSA2048);
        let rsa3072_cutoff = pgp
            .write
            .asymmetric_algo_cutoff(AsymmetricAlgorithm::RSA3072);
        assert!(
            rsa2048_cutoff.is_some(),
            "write policy must reject RSA-2048 (cutoff set); got None"
        );
        assert!(
            rsa3072_cutoff.is_none(),
            "write policy must still accept RSA-3072 (no cutoff); got cutoff = {:?}",
            rsa3072_cutoff
        );
    }

    // ----- Read policy = permissive (admits SHA-1 + 3DES) -------------------

    #[test]
    fn read_policy_admits_sha1_and_3des() {
        let core = CryptoPolicy::default_baseline();
        let pgp = PgpPolicy::from_core(&core);

        // SHA-1: read policy must have NO cutoff (accept()-ed wholesale).
        let sha1_cutoff = pgp
            .read
            .hash_cutoff(SqHash::SHA1, HashAlgoSecurity::CollisionResistance);
        assert!(
            sha1_cutoff.is_none(),
            "read policy must admit SHA-1 (no cutoff); got cutoff = {:?}",
            sha1_cutoff
        );

        // 3DES: read policy must accept it. `Policy::symmetric_algorithm`
        // returns Ok(()) when acceptable (verified at `policy.rs:124`).
        let read_dyn: &dyn Policy = pgp.read_policy();
        #[allow(deprecated)]
        let verdict = read_dyn.symmetric_algorithm(SqSym::TripleDES);
        assert!(
            verdict.is_ok(),
            "read policy must accept 3DES for legacy decrypt; got err = {:?}",
            verdict.err()
        );
    }

    #[test]
    fn read_policy_admits_small_rsa() {
        // RSA1024 is rejected by StandardPolicy::new() (cutoff Feb 2014);
        // the read policy must accept it wholesale so legacy keys can decrypt.
        let core = CryptoPolicy::default_baseline();
        let pgp = PgpPolicy::from_core(&core);
        let rsa1024_cutoff = pgp
            .read
            .asymmetric_algo_cutoff(AsymmetricAlgorithm::RSA1024);
        assert!(
            rsa1024_cutoff.is_none(),
            "read policy must accept RSA-1024 (no cutoff); got cutoff = {:?}",
            rsa1024_cutoff
        );
    }

    // ----- note_weak detection ----------------------------------------------

    #[test]
    fn note_weak_flags_sha1_signature() {
        let cert = gen();
        let sha1_sig = sign_fixture_with_hash(&cert, SqHash::SHA1);
        // Sanity: the fixture really is SHA-1-signed.
        assert_eq!(
            sha1_sig.hash_algo(),
            SqHash::SHA1,
            "fixture must be SHA-1"
        );

        let core = CryptoPolicy::default_baseline();
        let pgp = PgpPolicy::from_core(&core);
        let warning = pgp
            .note_weak(&sha1_sig)
            .expect("SHA-1 signature must trigger a weak-algo warning");
        let lower = warning.to_lowercase();
        assert!(
            lower.contains("sha-1") || lower.contains("sha1"),
            "warning should name SHA-1; got: {warning}"
        );
    }

    #[test]
    fn note_weak_silent_on_modern_signature() {
        let cert = gen();
        let sha2_sig = sign_fixture_with_hash(&cert, SqHash::SHA256);
        assert_eq!(sha2_sig.hash_algo(), SqHash::SHA256);

        let core = CryptoPolicy::default_baseline();
        let pgp = PgpPolicy::from_core(&core);
        assert!(
            pgp.note_weak(&sha2_sig).is_none(),
            "modern (SHA-256 + EdDSA) signature must NOT trigger a warning"
        );
    }
}
