# Sequoia API spike — verified call sequences

**Pinned version**: `sequoia-openpgp = "2"` resolves to **2.4.1** (July 2026).
The brief specified `features = ["crypto-rust"]`; on 2.4.1 the pure-Rust
RustCrypto backend is gated behind **two additional opt-in feature flags** that
each fail the build with a clear stderr message until enabled:

```toml
sequoia-openpgp = {
    version = "2",
    default-features = false,
    features = ["crypto-rust", "allow-experimental-crypto", "allow-variable-time-crypto"],
}
```

- `allow-experimental-crypto` — RustCrypto is not considered production-ready
  by upstream (no constant-time guarantees in the underlying primitives).
- `allow-variable-time-crypto` — RustCrypto does not provide constant-time
  operations; Sequoia makes you acknowledge this can leak secrets via timing
  and allow signature forgery.

Both flags are appropriate for a desktop mail client where signature
verification runs on user-supplied, locally-stored data (interactive setting).
Tasks 6/7 (sign/verify) and Task 8 (decrypt) will consume these features; they
should NOT be removed without replacing the backend (e.g. with
`crypto-nettle`/`crypto-botan`/`crypto-openssl`).

**`CertBuilder::add_signing_subkey()` exists** on 2.4.1 and, paired with
`add_transport_encryption_subkey()`, yields a Cert with a primary key
(certify+sign) and TWO dedicated subkeys (transport encryption, signing) —
matches the spec's "dedicated signing subkey separate from the certify+sign
primary" requirement. The spike's `gen()` helper composes exactly this shape.

`openpgp::Result<T>` is `Result<T, openpgp::anyhow::Error>` (Sequoia re-exports
`anyhow`); `openpgp::Error` is the fine-grained enum. To return a structured
error from a `VerificationHelper`, construct `openpgp::Error::InvalidArgument(s)`
and `.into()` it into the anyhow alias.

---

## detached-sign

```rust
// Resolve the signing keypair (dedicated signing subkey in the spike).
let keypair = cert.keys().unencrypted_secret()
    .with_policy(P_, None).supported().alive().revoked(false).for_signing()
    .next().unwrap().key().clone().into_keypair()?;

let mut sig = Vec::new();
let message = Message::new(&mut sig);
let signer = Signer::new(message, keypair)?;     // Signer::new(sink, signing_keypair)
let mut w = signer.detached().build()?;          // .detached() switches to detached mode
w.write_all(plaintext)?;                          // data is HASHED, not emitted
w.finalize()?;                                    // tears down the stack, writes sig packet
// `sig` now holds ONLY the detached signature packet.
```

Returns: `Signer::new(sink, keypair) -> Result<Signer<W, K>>`;
`signer.detached() -> SignerBuilder<...>`; `.build() -> Result<impl Write + Send + Sync>`.
`finalize()` flushes the writer stack and writes the signature packet to the
sink.

**Note (differs from brief):** there is no `Signer::detached(sink, &[keypair])`
constructor. The verified shape is `Signer::new(sink, keypair)?.detached().build()?`.
For multi-signer detached signatures, chain `.add_signer(k)?` on the `Signer`
*before* calling `.detached()`.

Verified against `openpgp/examples/sign-detached.rs` (Sequoia main, 2.4.1).

---

## inline-sign

```rust
let keypair = /* see detached-sign */;

let mut out = Vec::new();
let message = Message::new(&mut out);
let signer = Signer::new(message, keypair)?.build()?;  // NO .detached() → inline
let mut lw = LiteralWriter::new(signer).build()?;       // wraps in a Literal Data packet
lw.write_all(plaintext)?;
lw.finalize()?;
// `out` holds: OnePassSig + Literal Data + Signature packet (RFC 9580 §10.3).
```

Returns the same `Signer::new(...)` builder; calling `.build()` directly (without
`.detached()`) yields an inline signing writer. `LiteralWriter::new(signer).build()?`
emits the Literal Data packet and the signature packet is appended on
`finalize()`. Verified against `openpgp/examples/generate-sign-verify.rs`.

---

## detached-verify

```rust
struct V<'a> { cert: &'a openpgp::Cert }
impl<'a> VerificationHelper for V<'a> {
    fn get_certs(&mut self, _ids: &[openpgp::KeyHandle]) -> openpgp::Result<Vec<openpgp::Cert>> {
        Ok(vec![self.cert.clone()])   // return the signer Cert(s) here
    }
    fn check(&mut self, structure: MessageStructure) -> openpgp::Result<()> {
        // Exactly one layer: a SignatureGroup containing one VerificationResult
        // per signature on the data. Implement the trust policy here.
        // VerificationResult = Result<GoodChecksum, VerificationError>.
        // GoodChecksum.sig: &Signature exposes hash_algo()/pk_algo() (see weak-alg-detection).
        for (i, layer) in structure.into_iter().enumerate() {
            match (i, layer) {
                (0, MessageLayer::SignatureGroup { results }) => {
                    if results.into_iter().next().is_some() { return Ok(()); }
                }
                _ => {}
            }
        }
        Err(openpgp::Error::InvalidArgument("no good signature".into()).into())
    }
}

let helper = V { cert: &cert };
let mut v = DetachedVerifierBuilder::from_bytes(&sig)?.with_policy(P_, None, helper)?;
v.verify_bytes(plaintext)?;   // Ok(()) iff data hashes to the signature AND check() accepted
```

Returns: `DetachedVerifierBuilder::from_bytes(&[u8]) -> Result<DetachedVerifierBuilder>`;
`.with_policy(&dyn Policy, Option<SystemTime>, H) -> Result<DetachedVerifier<H>>`;
`v.verify_bytes(B: AsRef<[u8]>) -> Result<()>`. The helper's `check()` is the
**policy seam**: a tampered payload produces no `GoodChecksum` in the
SignatureGroup, and `check()` returning `Err` propagates out of `verify_bytes`.
There are also `verify_reader`, `verify_file`, `verify_buffered_reader` for
streaming sources. Verified against `DetachedVerifier` rustdoc example
(docs.rs/sequoia-openpgp/2.4.1).

---

## inline-verify

```rust
let mut verifier = VerifierBuilder::from_bytes(signed_message)?
    .with_policy(P_, None, helper)?;
// helper: VerificationHelper (same trait as detached-verify) — get_certs returns
// the signer Cert, check() enforces the trust policy.
let mut plaintext = Vec::new();
io::copy(&mut verifier, &mut plaintext)?;   // reads verified plaintext; error if check fails
```

Returns: `VerifierBuilder::from_bytes(&[u8]) -> Result<VerifierBuilder>`;
`.with_policy(...) -> Result<Verifier<H>>`. `Verifier` implements `Read` so the
verified plaintext streams out; `check()` is invoked during the stream and a bad
signature surfaces as an `Err` from `io::copy` (or the final read). Verified
against `openpgp/examples/generate-sign-verify.rs`.

---

## policy-customization

Sequoia ships two policy flavors:

1. **`StandardPolicy<'a>`** — the default; rejects algorithms past their NIST/
   Sequoia-decided cutoff times (SHA-1 collision resistance rejected since 2013
   and completely since 2023; 3DES since 2017; RSA<2048 since 2014; SED packet
   since 2004). It is **mutable** via builder-style methods that override the
   cutoffs:
   - `accept_hash(h: HashAlgorithm)` — always consider `h` secure
   - `accept_asymmetric_algo(a: AsymmetricAlgorithm)` — always consider `a` secure
   - `accept_symmetric_algo(s: SymmetricAlgorithm)` — always consider `s` secure
   - `accept_hash_property(h, sec: HashAlgoSecurity)` — nuanced: accept `h` for a
     specific security property only (e.g. SHA-1 for second-preimage resistance
     but NOT collision resistance → OK for User ID binding signatures, NOT for
     data signatures).
   - Mirror `reject_*` / `reject_*_at(cutoff)` / `reject_all_*` exist.
   - `StandardPolicy::at(time)` constructs a policy pinned to a reference time
     (only meaningful when the signature was stored on tamper-proof medium;
     otherwise use the current time, which is the default).

2. **Custom `dyn Policy`** — implement the `Policy` trait directly to delegate
   to a `StandardPolicy` for most algorithms but special-case specific signature
   types/packets (Sequoia's own docs show a `RejectPersonaCertificationsPolicy`
   wrapper). This is how a strict engine would, e.g., reject all
   `BinaryDocument` signatures made with RSA-1024 while still accepting
   `KeyRevocation` signatures made with the same key.

**For the legacy read path (Task 6 verify)**: build a relaxed policy with
`let mut p = StandardPolicy::new(); p.accept_hash(HashAlgorithm::SHA1);` — this
admits SHA-1 globally. To admit it only for second-preimage contexts (safer),
use `p.accept_hash_property(HashAlgorithm::SHA1, HashAlgoSecurity::SecondPreImageResistance)`.
For 3DES: `p.accept_symmetric_algo(SymmetricAlgorithm::TripleDES)`. For
RSA<small: `p.accept_asymmetric_algo(AsymmetricAlgorithm::RSA2048)` etc.

```rust
use sequoia_openpgp as openpgp;
use openpgp::policy::{StandardPolicy, HashAlgoSecurity, Policy};
use openpgp::types::{HashAlgorithm, SymmetricAlgorithm};
use openpgp::policy::AsymmetricAlgorithm;

let mut p = StandardPolicy::new();
// Admit SHA-1 for contexts that only need second-preimage resistance
// (e.g. cert self-signatures) but reject it for data signatures.
p.accept_hash_property(HashAlgorithm::SHA1, HashAlgoSecurity::SecondPreImageResistance);
// Read legacy messages encrypted with 3DES.
p.accept_symmetric_algo(SymmetricAlgorithm::TripleDES);
let p_ref: &dyn Policy = &p;   // pass to .with_policy(p_ref, None, helper)
```

`StandardPolicy::new()` is `const fn` so the spike uses `const P_: &StandardPolicy = &StandardPolicy::new();`
as the strict read policy. The relaxed policy is built per-call inside the
verify path.

---

## weak-alg-detection

After verification, the `GoodChecksum` exposes the original `Signature` packet,
which in turn exposes the algorithms used. This is the hook for the engine's
weak-algorithm detector (Task 6/7 will surface a warning to the UI without
failing verification when a relaxed policy is in effect).

```rust
use sequoia_openpgp as openpgp;
use openpgp::parse::stream::{VerificationHelper, MessageStructure, GoodChecksum};

impl<'a> VerificationHelper for V<'a> {
    fn check(&mut self, structure: MessageStructure) -> openpgp::Result<()> {
        for layer in structure.into_iter() {
            if let openpgp::parse::stream::MessageLayer::SignatureGroup { results } = layer {
                for r in results {
                    if let Ok(good) = r {
                        let sig: &openpgp::Signature = good.sig;
                        let h = sig.hash_algo();    // -> openpgp::types::HashAlgorithm
                        let pk = sig.pk_algo();     // -> openpgp::types::PublicKeyAlgorithm
                        // e.g. h.is_secure(P_, HashAlgoSecurity::CollisionResistance)
                        //      → false for SHA-1, true for SHA-256
                    }
                }
            }
        }
        Ok(())
    }
}
```

`Signature::hash_algo() -> HashAlgorithm` lives at `packet/signature.rs:287`;
`Signature::pk_algo() -> PublicKeyAlgorithm` at `packet/signature.rs:2046` (both
confirmed in the 2.4.1 source). `HashAlgorithm` and `PublicKeyAlgorithm` are
re-exported from `openpgp::types` and are `Debug + Copy + Eq`. The
`StandardPolicy::hash_cutoff(h, security) -> Option<SystemTime>` method lets
the detector ask "was this algorithm past its cutoff when the signature was
created?" without implementing the `Policy` trait itself.
