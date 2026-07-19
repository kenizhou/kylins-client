//! Sequoia API spike — validates the exact call sequences Tasks 5–7 depend on.
//!
//! Throwaway: folded into round_trip.rs once the backend is complete. The three
//! tests here prove (1) generate→encrypt→decrypt, (2) armored Cert parse/serialize,
//! and (3) detached sign→verify (round-trip + tamper detection). Sign/verify call
//! sequences and `StandardPolicy` customization are recorded in `spike-notes.md`.
use sequoia_openpgp as openpgp;
use openpgp::cert::prelude::*;
use openpgp::parse::stream::*;
use openpgp::parse::Parse;
use openpgp::policy::StandardPolicy as P;
use openpgp::serialize::stream::*;
use openpgp::serialize::Marshal;
use std::io::{self, Write};

const P_: &P = &P::new();

fn gen() -> openpgp::Result<openpgp::Cert> {
    let (cert, _rev) = CertBuilder::new()
        .add_userid("spike@example.org")
        .add_transport_encryption_subkey()
        .add_signing_subkey()
        .generate()?;
    Ok(cert)
}

#[test]
fn spike_generate_encrypt_decrypt_roundtrip() -> openpgp::Result<()> {
    let cert = gen()?;
    let plaintext = b"hello sequoia";

    // encrypt
    let mut ct = Vec::new();
    let recipients = cert.keys().with_policy(P_, None).supported().alive()
        .revoked(false).for_transport_encryption();
    let msg = Encryptor::for_recipients(Message::new(&mut ct), recipients).build()?;
    let mut w = LiteralWriter::new(msg).build()?;
    w.write_all(plaintext)?;
    w.finalize()?;

    // decrypt (Helper providing the secret key + a permissive verifier)
    struct H<'a> { secret: &'a openpgp::Cert }
    impl<'a> VerificationHelper for H<'a> {
        fn get_certs(&mut self, _: &[openpgp::KeyHandle]) -> openpgp::Result<Vec<openpgp::Cert>> { Ok(vec![]) }
        fn check(&mut self, _: MessageStructure) -> openpgp::Result<()> { Ok(()) }
    }
    impl<'a> DecryptionHelper for H<'a> {
        fn decrypt(&mut self, pkesks: &[openpgp::packet::PKESK], _skesks: &[openpgp::packet::SKESK],
            sym_algo: Option<openpgp::types::SymmetricAlgorithm>,
            decrypt: &mut dyn FnMut(Option<openpgp::types::SymmetricAlgorithm>, &openpgp::crypto::SessionKey) -> bool)
            -> openpgp::Result<Option<openpgp::Cert>> {
            let key = self.secret.keys().unencrypted_secret().with_policy(P_, None)
                .for_transport_encryption().next().unwrap().key().clone();
            let mut pair = key.into_keypair()?;
            pkesks[0].decrypt(&mut pair, sym_algo).map(|(a, sk)| decrypt(a, &sk));
            Ok(None)
        }
    }
    let helper = H { secret: &cert };
    let mut pt = Vec::new();
    let mut dec = DecryptorBuilder::from_bytes(&ct)?.with_policy(P_, None, helper)?;
    io::copy(&mut dec, &mut pt)?;
    assert_eq!(pt, plaintext);
    Ok(())
}

#[test]
fn spike_cert_armor_parse_roundtrip() -> openpgp::Result<()> {
    let cert = gen()?;
    let mut armored = Vec::new();
    cert.armored().serialize(&mut armored)?;
    let parsed: Vec<openpgp::Cert> = CertParser::from_bytes(&armored)?
        .collect::<openpgp::Result<Vec<_>>>()?;
    assert_eq!(parsed.len(), 1);
    assert_eq!(parsed[0].fingerprint(), cert.fingerprint());
    Ok(())
}

/// Proves the verified detached sign→verify sequence from `spike-notes.md` and
/// confirms that tampering with the payload causes verification to fail. The
/// inline sign/verify API is exercised by Sequoia's own `generate-sign-verify`
/// example and shares the `Signer::new`/`VerifierBuilder` shape recorded in the
/// notes — only the detached path is round-tripped here because that is the
/// pattern Task 6 needs for `SignOp::Detach`.
#[test]
fn spike_sign_verify_roundtrip() -> openpgp::Result<()> {
    let cert = gen()?;
    let plaintext = b"hello signed sequoia";

    // Resolve the signing keypair from the dedicated signing subkey added by gen().
    let keypair = cert.keys().unencrypted_secret()
        .with_policy(P_, None).supported().alive().revoked(false).for_signing()
        .next().unwrap().key().clone().into_keypair()?;

    // Detached sign: Signer::new(msg, keypair)?.detached().build()? -> write -> finalize.
    // `sig` receives ONLY the detached signature packet (the data is hashed, not emitted).
    let mut sig = Vec::new();
    let message = Message::new(&mut sig);
    let signer = Signer::new(message, keypair)?;
    let mut w = signer.detached().build()?;
    w.write_all(plaintext)?;
    w.finalize()?;

    // Helper returns the signer's Cert from get_certs, and requires at least one
    // good (mathematically valid) signature in check(). This is what lets
    // tampered data fail verification: an altered payload produces no GoodChecksum
    // in the SignatureGroup, so check() returns Err and verify_bytes propagates it.
    struct V<'a> { cert: &'a openpgp::Cert }
    impl<'a> VerificationHelper for V<'a> {
        fn get_certs(&mut self, _: &[openpgp::KeyHandle]) -> openpgp::Result<Vec<openpgp::Cert>> {
            Ok(vec![self.cert.clone()])
        }
        fn check(&mut self, structure: MessageStructure) -> openpgp::Result<()> {
            let mut good = false;
            for (i, layer) in structure.into_iter().enumerate() {
                match (i, layer) {
                    (0, MessageLayer::SignatureGroup { results }) => {
                        for r in results {
                            match r {
                                Ok(_) => good = true,
                                // Surface the first failure verbatim so a bad
                                // signature is visible in the test output.
                                Err(e) => return Err(openpgp::Error::from(e).into()),
                            }
                        }
                    }
                    _ => return Err(openpgp::Error::InvalidArgument(
                        "unexpected message structure".into(),
                    ).into()),
                }
            }
            if good {
                Ok(())
            } else {
                Err(openpgp::Error::InvalidArgument("no good signature".into()).into())
            }
        }
    }

    // Round-trip: verify_bytes over the original plaintext must succeed.
    let helper = V { cert: &cert };
    let mut v = DetachedVerifierBuilder::from_bytes(&sig)?.with_policy(P_, None, helper)?;
    v.verify_bytes(plaintext)?;

    // Tamper: flipping a byte in the payload must make verification fail.
    let mut tampered = plaintext.to_vec();
    tampered[0] ^= 0xff;
    let helper = V { cert: &cert };
    let mut v = DetachedVerifierBuilder::from_bytes(&sig)?.with_policy(P_, None, helper)?;
    assert!(
        v.verify_bytes(&tampered).is_err(),
        "tampered payload must fail detached verification",
    );

    Ok(())
}
