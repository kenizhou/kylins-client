//! OpenPGP engine: generate / import / export (non-streaming key ops).
//!
//! This is the ONLY module in the crate that imports `sequoia_openpgp` for
//! cryptographic operations. Tasks 6 (encrypt/decrypt) and 7 (sign/verify) add
//! streaming ops to this same file; Task 8 wires everything into the
//! `CryptoBackend` trait via `KeyStore`.
//!
//! ## Sequoia 2.4.1 API notes (verified)
//!
//! - **generate**: `CertBuilder::new().add_userid(u)`
//!   `.add_transport_encryption_subkey().add_signing_subkey().generate()`
//!   yields `(Cert, revocation)`. `CertBuilder::new()` defaults the primary
//!   to certify-only; `add_signing_subkey` + `add_transport_encryption_subkey`
//!   add dedicated subkeys. The default ciphersuite selects Ed25519 for
//!   primary/signing and X25519 for encryption — matches the engine contract.
//! - **import**: `parse_certs` (keymap) wraps `CertParser::from_bytes` which
//!   auto-detects armor vs binary. For encrypted-secret certs, the verified
//!   decryption pattern is at `sequoia_openpgp-2.4.1/src/cert.rs:6289` (test
//!   `decrypt_encrypt_secrets`) and `src/packet/key.rs:644-658` (doc example):
//!   iterate `cert.keys().encrypted_secret()`, clone each key, call
//!   `decrypt_secret(&password)`, and re-insert via `cert.insert_packets(...)`
//!   preserving each key's role via `KeyAmalgamation::primary()`.
//! - **export**: `cert.armored().serialize(...)` emits an ASCII-armored
//!   `PUBLIC KEY BLOCK` frame (delegates to `cert.serialize`, public-only by
//!   construction — see `keymap.rs` API notes).
//!
//! ## Passphrase handling
//!
//! The passphrase bytes enter as `crypto_core::SecretBox<String>` (heap-allocated,
//! zeroized on drop). To pass them to Sequoia's `decrypt_secret`, we expose them
//! via [`secrecy::ExposeSecret`], clone into a `String`, and immediately convert
//! to [`sequoia_openpgp::crypto::Password`] (which uses `mem::Encrypted`
//! internally — also zeroized on drop). The intermediate `String` is short-lived
//! (a single statement); the bytes never leave crypto-aware containers.

use crypto_core::{
    DecryptedPayload, EncryptedEnvelope, EncryptedPart, KeyPacketRef, Part, PartId, PartKind,
    SecretBox, SerializationStrategy, Standard,
};
use secrecy::ExposeSecret;
use sequoia_openpgp as openpgp;
use sequoia_openpgp::cert::prelude::*;
use sequoia_openpgp::crypto::Password;
use sequoia_openpgp::parse::stream::{
    DecryptorBuilder, DecryptionHelper, MessageLayer, MessageStructure, VerificationHelper,
};
use sequoia_openpgp::parse::Parse;
use sequoia_openpgp::policy::Policy;
use sequoia_openpgp::serialize::stream::{Encryptor, LiteralWriter, Message, Signer};
use std::io::{Read, Write};

use crate::error::{map_err, map_sequoia, policy, CryptoResult};
use crate::keymap;

/// Generate a fresh OpenPGP Cert with the engine's standard key shape.
///
/// Composition (verified Task-1 spike):
/// - Ed25519 primary key (certify-only per `CertBuilder::new()` defaults)
/// - X25519 transport-encryption subkey
/// - Ed25519 signing subkey
///
/// No OpenPGP S2K passphrase is applied; at-rest protection is the framework's
/// master-key layer (OS keyring + AES-256-GCM in `kylins.client.backend::crypto`),
/// not Sequoia's. Generated secret material is therefore UNENCRYPTED within the
/// OpenPGP packet wiring — the engine contract is that the surrounding storage
/// layer applies at-rest protection.
///
/// **Revocation cert**: the second tuple element from `CertBuilder::generate()`
/// is discarded. Out of scope for engine-core; a later slice persists it
/// alongside the Cert so key revocation can be issued without re-deriving the
/// primary keypair.
pub fn generate(user_id: &str) -> CryptoResult<openpgp::Cert> {
    // `CertBuilder` uses Sequoia's modern `StandardPolicy` defaults internally,
    // which align with the crate's write policy (see `policy.rs`); no explicit
    // policy override is needed on the generate path.
    let (cert, _revocation) = map_sequoia(
        CertBuilder::new()
            .add_userid(user_id)
            .add_transport_encryption_subkey()
            .add_signing_subkey()
            .generate(),
    )?;
    Ok(cert)
}

/// Import a Cert from OpenPGP armored or binary TPK bytes.
///
/// [`keymap::parse_certs`] (which wraps `CertParser::from_bytes`) auto-detects
/// armor vs binary form. **Multi-cert input handling:** engine-core takes the
/// FIRST cert and discards the rest. The framework's keyring API (Task 8)
/// handles multi-cert input by calling `import` per cert; documenting the
/// choice here so it is explicit.
///
/// **Passphrase semantics:**
/// - If the parsed cert has ENCRYPTED secret material, a passphrase is
///   REQUIRED. Each encrypted secret is decrypted via
///   [`openpgp::packet::Key::decrypt_secret`] and merged back into the Cert
///   (preserving each key's role via `KeyAmalgamation::primary()`).
/// - If the cert's secrets are UNENCRYPTED (e.g. fresh
///   `CertBuilder::generate()` output) or absent (public-only cert), no
///   passphrase is needed; a supplied passphrase is silently ignored.
///
/// # Errors
///
/// - [`CryptoError::Policy`]`("import: no OpenPGP certs found in input")` if
///   the input parses to zero certs.
/// - [`CryptoError::Policy`]`("import requires a passphrase for encrypted
///   secret key material")` if the cert has encrypted secret material and no
///   passphrase was supplied.
/// - [`CryptoError::Backend`] if Sequoia parsing fails OR if a supplied
///   passphrase fails to decrypt the secret material (wrong passphrase or
///   corrupted packet).
///
/// [`CryptoError::Policy`]: crypto_core::CryptoError::Policy
/// [`CryptoError::Backend`]: crypto_core::CryptoError::Backend
pub fn import(data: &[u8], passphrase: Option<SecretBox<String>>) -> CryptoResult<openpgp::Cert> {
    let certs = keymap::parse_certs(data)?;
    let mut cert = certs
        .into_iter()
        .next()
        .ok_or_else(|| policy("import: no OpenPGP certs found in input"))?;

    // Only encrypted secrets require a passphrase. If none are encrypted, the
    // cert is either public-only or an unencrypted TSK — return early. A
    // supplied passphrase is intentionally ignored (matches the brief's
    // "ignore a supplied passphrase" semantics for unencrypted certs).
    let has_encrypted = cert.keys().encrypted_secret().next().is_some();
    if !has_encrypted {
        return Ok(cert);
    }

    // Encrypted secrets present → passphrase required.
    let pw = passphrase.ok_or_else(|| {
        policy("import requires a passphrase for encrypted secret key material")
    })?;

    // Convert `SecretBox<String>` → Sequoia `Password`. Bytes remain in
    // zeroizing containers throughout (see the module-level passphrased-handling
    // note): `SecretBox<String>` (drop zeroizes) → transient `String` →
    // `Password` (`mem::Encrypted`, drop zeroizes). The transient String is
    // consumed by `Password::from(String)` in the same statement.
    let password: Password = pw.expose_secret().clone().into();

    // Decrypt each encrypted secret and merge back into the Cert, preserving
    // each key's role. Verified pattern at
    // `sequoia_openpgp-2.4.1/src/cert.rs:6289` (test `decrypt_encrypt_secrets`)
    // and `src/packet/key.rs:644-658` (doc example).
    //
    // We snapshot the (role, key) pairs first because `Cert::insert_packets`
    // consumes `cert`, which would invalidate the ongoing `cert.keys()` borrow.
    let keys_to_decrypt: Vec<(bool, _)> = cert
        .keys()
        .encrypted_secret()
        .map(|ka| (ka.primary(), ka.key().clone()))
        .collect();

    for (is_primary, key) in keys_to_decrypt {
        // `decrypt_secret` consumes `key` and returns a new key with the same
        // role but unencrypted secret material. A wrong passphrase surfaces as
        // an `openpgp::Result::Err` → `CryptoError::Backend` via `map_sequoia`.
        let decrypted = map_sequoia(key.decrypt_secret(&password))?;
        // Re-insert with the original role: `role_into_primary` for the primary
        // key, `role_into_subordinate` for subkeys. `insert_packets` prefers
        // newer key versions, so the decrypted variant overrides the encrypted
        // one in the resulting Cert.
        //
        // The explicit `openpgp::Packet` target is required because multiple
        // `From<Key<…>>` impls exist (various role conversions + `Packet`);
        // without the annotation, `.into()` is ambiguous (E0283).
        let packet: openpgp::Packet = if is_primary {
            decrypted.role_into_primary().into()
        } else {
            decrypted.role_into_subordinate().into()
        };
        let (new_cert, _signatures_changed) = map_sequoia(cert.insert_packets(vec![packet]))?;
        cert = new_cert;
    }

    Ok(cert)
}

/// ASCII-armored public-key serialization of a Cert.
///
/// Delegates to [`keymap::cert_to_armored_public`]. Emits a
/// `BEGIN PGP PUBLIC KEY BLOCK` frame (public-only — no secret material
/// crosses this boundary).
pub fn export_armored_public(cert: &openpgp::Cert) -> CryptoResult<Vec<u8>> {
    keymap::cert_to_armored_public(cert)
}

// =========================================================================
// encrypt / decrypt (Task 6)
// =========================================================================
//
// Streaming encrypt/decrypt of `Part` bytes for the framework's
// `SingleMimeBlob` strategy. The engine sits BETWEEN the framework op
// (`EncryptOp` / `DecryptOp`) and Sequoia: Task 8 resolves the framework's
// `KeyHandleRef`s to `openpgp::Cert`s via `KeyStore` and then calls these
// functions.
//
// ## Scope (engine-core)
//
// - **`SingleMimeBlob` only.** All parts are framed into ONE plaintext blob
//   and encrypted as ONE OpenPGP message. `SplitPerPart` returns
//   [`CryptoError::Policy`]`("SplitPerPart not supported in engine-core")`;
//   wiring for it lands in a later slice.
// - **No MIME framing.** PGP/MIME multipart framing is the send slice's job;
//   here `Part::data` is opaque bytes.
// - **No standalone sign/verify.** Those land in Task 7. Inline
//   sign-then-encrypt IS in scope here (the embedded signature lives inside
//   the ciphertext stream and is verified on decrypt via the helper's
//   `VerificationHelper::check`).
//
// ## EncryptedEnvelope shape for OpenPGP
//
// The framework separates `parts[].ciphertext` from `recipients: Vec<KeyPacketRef>`,
// but OpenPGP embeds the per-recipient PKESK key-wrap packets inside the
// single encrypted-message blob (not cleanly separable). Resolution:
// - **`parts`**: a single [`EncryptedPart`] whose `ciphertext` carries the
//   full OpenPGP encrypted message (PKESKs + SEIP data). Its `id` / `kind`
//   mirror the FIRST input `Part` (a label; the SEIP body is the framing
//   blob, not the original part bytes).
// - **`recipients`**: populated INFORMATIVELY from the input `recipient_certs`
//   via [`keymap::cert_to_handle`]. The `packet` field is EMPTY — the actual
//   PKESK key-wrap bytes are embedded in `parts[0].ciphertext` and are not
//   extracted out in this slice. Documented mapping; a cleaner
//   per-recipient-packet separation is out of scope.
// - **`parts[].signature`** stays `None`. The embedded signature (when
//   `sign_with` is `Some`) lives in the ciphertext stream, verified on
//   decrypt via the helper's `check()`. Task 7's detached signatures are a
//   separate flow.
//
// [`CryptoError::Policy`]: crypto_core::CryptoError::Policy

/// Encode a slice of [`Part`]s into a single plaintext blob for
/// `SingleMimeBlob` encryption.
///
/// Framing (little-endian, self-describing, symmetric under decode):
/// ```text
/// u32 LE part_count
/// for each part:
///   u32 LE id_len || id_bytes
///   u8 kind_tag                                   // 0 = Body, 1 = Attachment
///   if Attachment:
///     u32 LE filename_len || filename_bytes
///     u32 LE mime_len      || mime_bytes
///     u8  content_id_present                       // 0 or 1
///     if present: u32 LE content_id_len || content_id_bytes
///   u32 LE data_len || data_bytes
/// ```
///
/// This is INTERNAL framing — not a wire format. The decode side is
/// [`unframe_parts`]; both sides live in this module so the contract is
/// local. Not MIME: PGP/MIME composition is the send slice's job.
fn frame_parts(parts: &[Part]) -> Vec<u8> {
    let mut out = Vec::new();
    out.extend_from_slice(&(parts.len() as u32).to_le_bytes());
    for p in parts {
        // id
        out.extend_from_slice(&(p.id.0.len() as u32).to_le_bytes());
        out.extend_from_slice(p.id.0.as_bytes());
        // kind
        match &p.kind {
            PartKind::Body => {
                out.push(0u8);
            }
            PartKind::Attachment {
                filename,
                mime,
                content_id,
            } => {
                out.push(1u8);
                out.extend_from_slice(&(filename.len() as u32).to_le_bytes());
                out.extend_from_slice(filename.as_bytes());
                out.extend_from_slice(&(mime.len() as u32).to_le_bytes());
                out.extend_from_slice(mime.as_bytes());
                match content_id {
                    Some(cid) => {
                        out.push(1u8);
                        out.extend_from_slice(&(cid.len() as u32).to_le_bytes());
                        out.extend_from_slice(cid.as_bytes());
                    }
                    None => out.push(0u8),
                }
            }
        }
        // data
        out.extend_from_slice(&(p.data.len() as u32).to_le_bytes());
        out.extend_from_slice(&p.data);
    }
    out
}

/// Invert [`frame_parts`]. Returns [`CryptoError::Malformed`] on any framing
/// violation (truncated length, bad kind tag, overflow).
fn unframe_parts(blob: &[u8]) -> CryptoResult<Vec<Part>> {
    use crypto_core::CryptoError;

    let mut cursor = 0usize;
    let read_u32 = |buf: &[u8], c: &mut usize| -> CryptoResult<u32> {
        if (*c + 4) > buf.len() {
            return Err(CryptoError::Malformed(
                "framing: truncated u32 length".into(),
            ));
        }
        let v = u32::from_le_bytes([
            buf[*c], buf[*c + 1], buf[*c + 2], buf[*c + 3],
        ]);
        *c += 4;
        Ok(v)
    };
    let read_bytes =
        |buf: &[u8], c: &mut usize, len: u32| -> CryptoResult<Vec<u8>> {
            let len = len as usize;
            if (*c + len) > buf.len() {
                return Err(CryptoError::Malformed(
                    "framing: truncated payload".into(),
                ));
            }
            let v = buf[*c..*c + len].to_vec();
            *c += len;
            Ok(v)
        };

    let count = read_u32(blob, &mut cursor)?;
    // Sanity-cap to avoid pathological allocations on a corrupt framing.
    if count > 1024 {
        return Err(CryptoError::Malformed(format!(
            "framing: part count {count} exceeds sane maximum (1024)"
        )));
    }

    let mut out = Vec::with_capacity(count as usize);
    for _ in 0..count {
        let id_len = read_u32(blob, &mut cursor)?;
        let id_bytes = read_bytes(blob, &mut cursor, id_len)?;
        let id = PartId(String::from_utf8(id_bytes).map_err(|_| {
            CryptoError::Malformed("framing: PartId is not valid UTF-8".into())
        })?);

        if cursor >= blob.len() {
            return Err(CryptoError::Malformed(
                "framing: truncated kind tag".into(),
            ));
        }
        let kind_tag = blob[cursor];
        cursor += 1;
        let kind = match kind_tag {
            0 => PartKind::Body,
            1 => {
                let fname_len = read_u32(blob, &mut cursor)?;
                let fname = read_bytes(blob, &mut cursor, fname_len)?;
                let mime_len = read_u32(blob, &mut cursor)?;
                let mime = read_bytes(blob, &mut cursor, mime_len)?;
                let cid_present = if cursor >= blob.len() {
                    return Err(CryptoError::Malformed(
                        "framing: truncated content_id flag".into(),
                    ));
                } else {
                    blob[cursor]
                };
                cursor += 1;
                let content_id = if cid_present != 0 {
                    let cid_len = read_u32(blob, &mut cursor)?;
                    let cid = read_bytes(blob, &mut cursor, cid_len)?;
                    Some(String::from_utf8(cid).map_err(|_| {
                        CryptoError::Malformed(
                            "framing: content_id is not valid UTF-8".into(),
                        )
                    })?)
                } else {
                    None
                };
                PartKind::Attachment {
                    filename: String::from_utf8(fname).map_err(|_| {
                        CryptoError::Malformed(
                            "framing: filename is not valid UTF-8".into(),
                        )
                    })?,
                    mime: String::from_utf8(mime).map_err(|_| {
                        CryptoError::Malformed(
                            "framing: mime is not valid UTF-8".into(),
                        )
                    })?,
                    content_id,
                }
            }
            other => {
                return Err(CryptoError::Malformed(format!(
                    "framing: unknown PartKind tag {other}"
                )));
            }
        };

        let data_len = read_u32(blob, &mut cursor)?;
        let data = read_bytes(blob, &mut cursor, data_len)?;
        out.push(Part { id, kind, data });
    }

    if cursor != blob.len() {
        return Err(CryptoError::Malformed(format!(
            "framing: trailing {} bytes after last part",
            blob.len() - cursor
        )));
    }
    Ok(out)
}

/// Resolve a Cert's dedicated signing subkey as a Sequoia [`openpgp::crypto::KeyPair`].
///
/// Mirrors the Task-1 spike `detached-sign` / `inline-sign` key-resolution
/// chain: `cert.keys().unencrypted_secret().with_policy(policy, None)
/// .supported().alive().revoked(false).for_signing()`. The returned keypair
/// is consumed by [`Signer::new`].
fn resolve_signing_keypair(
    cert: &openpgp::Cert,
    write_policy: &dyn Policy,
) -> CryptoResult<openpgp::crypto::KeyPair> {
    let ka = cert
        .keys()
        .unencrypted_secret()
        .with_policy(write_policy, None)
        .supported()
        .alive()
        .revoked(false)
        .for_signing()
        .next()
        .ok_or_else(|| {
            policy("encrypt: sign_with cert has no usable signing subkey")
        })?;
    let keypair = map_sequoia(ka.key().clone().into_keypair())?;
    Ok(keypair)
}

/// Streaming encrypt of `parts` into an [`EncryptedEnvelope`] (OpenPGP).
///
/// See the module-level docs above for the [`EncryptedEnvelope`] shape
/// mapping (single ciphertext blob + informative `recipients` list).
///
/// **Spawn-blocking is Task 8's concern** — this function is synchronous.
///
/// # Errors
///
/// - [`CryptoError::Policy`]`("SplitPerPart not supported in engine-core")`
///   if `serialization` is not `SingleMimeBlob`.
/// - [`CryptoError::Policy`]`("encrypt: at least one recipient required")`
///   if `recipient_certs` is empty.
/// - [`CryptoError::Policy`]`("encrypt: at least one part required")` if
///   `parts` is empty (the framing format is `part_count || …` so zero
///   parts would round-trip but produces a useless envelope; reject
///   upstream).
/// - [`CryptoError::Policy`]`("encrypt: sign_with cert has no usable
///   signing subkey")` if `sign_with` is `Some` and the cert lacks an
///   alive, unrevoked, policy-accepted signing subkey.
/// - [`CryptoError::Backend`] for any Sequoia error (encryptor build,
///   signer build, literal-writer build, write, finalize).
pub fn encrypt(
    parts: &[Part],
    serialization: SerializationStrategy,
    recipient_certs: &[openpgp::Cert],
    sign_with: Option<&openpgp::Cert>,
    pgp_policy: &crate::policy::PgpPolicy,
) -> CryptoResult<EncryptedEnvelope> {
    if matches!(serialization, SerializationStrategy::SplitPerPart) {
        return Err(policy("SplitPerPart not supported in engine-core"));
    }
    if recipient_certs.is_empty() {
        return Err(policy("encrypt: at least one recipient required"));
    }
    if parts.is_empty() {
        return Err(policy("encrypt: at least one part required"));
    }

    let write_policy = pgp_policy.write_policy();
    let plaintext = frame_parts(parts);

    // ---- OpenPGP message stack: Encryptor -> [Signer] -> LiteralWriter ----
    //
    // Sequoia's `Recipient` holds `&'a Key<…>` (borrows from the Cert), so we
    // cannot easily collect recipients across certs into a single Vec. The
    // `add_recipients` builder method takes a separate iterator and chains
    // it; we use that for the 2..N certs.
    let mut sink: Vec<u8> = Vec::new();
    let first_keys = recipient_certs[0]
        .keys()
        .with_policy(write_policy, None)
        .supported()
        .alive()
        .revoked(false)
        .for_transport_encryption();
    let mut encryptor_builder =
        Encryptor::for_recipients(Message::new(&mut sink), first_keys);
    for cert in &recipient_certs[1..] {
        let keys = cert
            .keys()
            .with_policy(write_policy, None)
            .supported()
            .alive()
            .revoked(false)
            .for_transport_encryption();
        encryptor_builder = encryptor_builder.add_recipients(keys);
    }
    let encryptor_msg = map_sequoia(encryptor_builder.build())?;

    // Optional inline-sign: wrap the encryptor's sink-output in a Signer
    // stream. The embedded signature is verified on decrypt by the helper's
    // `check()` (see `Helper::check` below).
    let signing_target: Message = if let Some(signer_cert) = sign_with {
        let keypair = resolve_signing_keypair(signer_cert, write_policy)?;
        let signer = map_sequoia(Signer::new(encryptor_msg, keypair))?;
        map_sequoia(signer.build())?
    } else {
        encryptor_msg
    };

    // Literal data packet wraps the plaintext (required for OpenPGP message
    // validity). `LiteralWriter::new(...).build()` returns a `Message`; the
    // `io::Write` impl feeds bytes into the encryption (and signing) pipeline.
    let mut literal = map_sequoia(LiteralWriter::new(signing_target).build())?;
    map_err(literal.write_all(&plaintext))?;
    map_sequoia(literal.finalize())?;

    // Drop is intentional: at this point the writer stack has been torn down
    // by `finalize()` and the OpenPGP message is complete in `sink`. We
    // assert non-empty as a defensive check.
    debug_assert!(!sink.is_empty(), "encrypt: ciphertext sink is empty");

    // ---- EncryptedEnvelope shape (see module-level docs) ----
    let first_part_id = parts[0].id.clone();
    let first_part_kind = parts[0].kind.clone();
    let recipients: Vec<KeyPacketRef> = recipient_certs
        .iter()
        .map(|c| KeyPacketRef {
            recipient: keymap::cert_to_handle(c),
            packet: Vec::new(), // PKESK bytes live inside the ciphertext blob.
        })
        .collect();

    Ok(EncryptedEnvelope {
        standard: Standard::OpenPgp,
        serialization: SerializationStrategy::SingleMimeBlob,
        parts: vec![EncryptedPart {
            id: first_part_id,
            kind: first_part_kind,
            ciphertext: sink,
            signature: None, // embedded sig (if any) is in the ciphertext stream.
        }],
        recipients,
    })
}

/// Streaming decrypt of an [`EncryptedEnvelope`] back into plaintext parts
/// plus an optional weak-algorithm warning.
///
/// Returns `(DecryptedPayload, Option<String>)` where the warning (if any)
/// is the first legacy/weak signature algorithm noticed by the read path's
/// `VerificationHelper::check` (see [`crate::policy::PgpPolicy::note_weak`]).
///
/// **Engine-core helper scope:** the embedded `VerificationHelper` returns
/// ONLY the decryption cert (the engine has no signer-cert lookup — that's
/// the framework's job in Task 8). This means a sign-then-encrypt message
/// where the signer is NOT the decryption cert will FAIL to verify here,
/// surfacing as [`CryptoError::Backend`]. For the engine-core round-trip
/// (signer == decryptor) it works.
///
/// **Spawn-blocking is Task 8's concern** — this function is synchronous.
pub fn decrypt(
    envelope: &EncryptedEnvelope,
    decryption_cert: &openpgp::Cert,
    pgp_policy: &crate::policy::PgpPolicy,
) -> CryptoResult<(DecryptedPayload, Option<String>)> {
    let read_policy = pgp_policy.read_policy();

    // For SingleMimeBlob the envelope has exactly one EncryptedPart whose
    // ciphertext is the full OpenPGP message. SplitPerPart is rejected in
    // encrypt(); defensively reject it here too.
    if matches!(
        envelope.serialization,
        SerializationStrategy::SplitPerPart
    ) {
        return Err(policy("SplitPerPart not supported in engine-core"));
    }
    let ciphertext = envelope
        .parts
        .first()
        .ok_or_else(|| policy("decrypt: envelope has no parts"))?
        .ciphertext
        .as_slice();

    let helper = Helper {
        cert: decryption_cert,
        pgp_policy,
        weak_warning: None,
    };
    // `DecryptorBuilder::from_bytes` returns `openpgp::Result<DecryptorBuilder>`;
    // `b.with_policy(...)` returns `openpgp::Result<Decryptor<...>>`. Route
    // each through `map_sequoia` separately (both surface as Backend errors).
    let builder = map_sequoia(DecryptorBuilder::from_bytes(ciphertext))?;
    let mut decryptor = map_sequoia(builder.with_policy(read_policy, None, helper))?;

    // Drain the OpenPGP literal-data packet into a plaintext buffer. The
    // Decryptor implements `io::Read`; `read_to_end` consumes the literal
    // data and triggers `check()` for any embedded signatures (buffered,
    // per Sequoia's DEFAULT_BUFFER_SIZE semantics).
    let mut plaintext = Vec::new();
    map_err(decryptor.read_to_end(&mut plaintext))?;

    // Recover the helper to surface the weak-algo warning captured during
    // `check()`. `into_helper` consumes the Decryptor.
    let helper = decryptor.into_helper();

    let parts = unframe_parts(&plaintext)?;
    Ok((
        DecryptedPayload {
            standard: Standard::OpenPgp,
            parts,
        },
        helper.weak_warning,
    ))
}

// =========================================================================
// sign / verify (Task 7)
// =========================================================================
//
// Detached sign + verify with the framework's `SignatureState` mapping.
// Inline signing for its own sake is NOT in scope here: Task 6's
// `encrypt(sign_with = Some)` already produces inline-signed ciphertext
// (verified on decrypt via [`Helper::check`]); these functions cover the
// "signature as a standalone artifact" flow (PGP/MIME detached signature
// parts, signing-only operations).
//
// ## `SignatureState` mapping (spec §8)
//
// - matching known-signer + `verify_bytes` OK        → `ValidVerified`
// - NO matching known-signer (filtered by sig issuer) → `UnknownKey`
// - matching known-signer but `verify_bytes` errors   → `Invalid`
// - `ValidUnverified` / `Mismatch`                    → not produced here
//   (receive/trust-slice states)
//
// The split between `UnknownKey` and `Invalid` is decided BEFORE invoking
// `DetachedVerifier`: we pre-filter `known_signers` by the sig packet's
// issuer fingerprint(s). If no signer matches, we skip verification entirely
// and return `UnknownKey` — this avoids relying on Sequoia's "No Key" error
// shape and gives a clean, engine-level state distinction.

/// Detached-sign `payload` with `signer_cert`'s dedicated signing subkey.
///
/// Verified Task-1 spike `## detached-sign` shape:
/// `Signer::new(Message::new(sink), keypair)?.detached().build()?`, then
/// `write_all(payload)` + `finalize()`. The data is HASHED, not emitted —
/// `signature` holds ONLY the detached signature packet.
///
/// The signing subkey is resolved via [`resolve_signing_keypair`] (same path
/// the Task 6 inline-sign uses), so the same policy / liveness / revocation
/// rules apply: an alive, unrevoked, policy-accepted signing subkey with
/// unencrypted secret material is required.
///
/// **Spawn-blocking is Task 8's concern** — this function is synchronous.
///
/// # Errors
///
/// - [`CryptoError::Policy`]`("encrypt: sign_with cert has no usable signing
///   subkey")` (shared with [`encrypt`]'s inline-sign path) if `signer_cert`
///   lacks an alive, unrevoked, policy-accepted signing subkey with
///   unencrypted secret material.
/// - [`CryptoError::Backend`] for any Sequoia error (keypair build, signer
///   builder, write, finalize).
///
/// [`CryptoError::Policy`]: crypto_core::CryptoError::Policy
/// [`CryptoError::Backend`]: crypto_core::CryptoError::Backend
pub fn sign_detached(
    payload: &[u8],
    signer_cert: &openpgp::Cert,
    pgp_policy: &crate::policy::PgpPolicy,
) -> CryptoResult<crypto_core::DetachedSignature> {
    let write_policy = pgp_policy.write_policy();
    let keypair = resolve_signing_keypair(signer_cert, write_policy)?;

    let mut sig_buf: Vec<u8> = Vec::new();
    let signer = map_sequoia(Signer::new(Message::new(&mut sig_buf), keypair))?;
    let mut writer = map_sequoia(signer.detached().build())?;
    map_err(writer.write_all(payload))?;
    map_sequoia(writer.finalize())?;

    debug_assert!(
        !sig_buf.is_empty(),
        "sign_detached: signature buffer is empty after finalize"
    );

    Ok(crypto_core::DetachedSignature {
        standard: Standard::OpenPgp,
        signer: keymap::cert_to_handle(signer_cert),
        signature: sig_buf,
    })
}

/// Verify a [`DetachedSignature`] over `payload`, mapping the outcome to a
/// [`SignatureState`] per spec §8.
///
/// See the module-level docs above for the full state-mapping table. The
/// load-bearing decision is `UnknownKey` vs `Invalid`: it is made by
/// pre-filtering `known_signers` against the signature packet's issuer
/// fingerprint(s) — if no known signer matches, `UnknownKey` is returned
/// WITHOUT invoking the verifier. Only when a matching key is available do
/// we run `DetachedVerifierBuilder::from_bytes(...)?.with_policy(read_policy,
/// None, helper)?.verify_bytes(payload)?` (the verified `## detached-verify`
/// shape).
///
/// **Weak-algorithm advisory:** [`crate::policy::PgpPolicy::note_weak`] is
/// called on the parsed `Signature` packet. If it returns a warning:
/// - on `ValidVerified`: the warning is folded into `failure_reason` as
///   advisory text (the framework docstring says `failure_reason` is `None`
///   on success states — engine-core extends this with a weak-algo advisory
///   because no separate channel exists yet; a cleaner surfacing path lands
///   with the receive slice's Web-of-Trust wiring). The state STAYS
///   `ValidVerified` — weak-but-valid is NOT a verification failure.
/// - on `Invalid`: the warning is appended to the failure reason after a
///   separator, providing additional context.
///
/// `revocation_reason` is always `None` (PGP key revocation handling arrives
/// with Web-of-Trust in the receive slice).
///
/// **Spawn-blocking is Task 8's concern** — this function is synchronous.
pub fn verify_detached(
    payload: &[u8],
    sig: &crypto_core::DetachedSignature,
    known_signers: &[openpgp::Cert],
    pgp_policy: &crate::policy::PgpPolicy,
) -> CryptoResult<crypto_core::VerificationResult> {
    let read_policy = pgp_policy.read_policy();

    // Parse the signature packet ONCE up front. Two consumers:
    //   (a) extract issuer fingerprint(s) for the UnknownKey pre-check and
    //       for the UnknownKey `signer` field;
    //   (b) feed to `note_weak` for the weak-algo advisory.
    //
    // We parse via `PacketParserBuilder::from_bytes(...).build()` + `recurse()`
    // (the same pattern `policy.rs::sign_fixture_with_hash` uses) rather than
    // `Signature::from_bytes`: the latter's `Parse` impl dispatches through
    // `Self::parse(parser)` which we found trips a "Malformed packet: unknown
    // version" error on a valid v4 Signature emitted by `Signer::detached()`
    // (the bytes start with `0xc2 0xbd 0x04 ...` = CTB New / Sig tag / len 189
    // / version 4). `PacketParser` correctly recognizes the same bytes.
    let sig_packet: openpgp::packet::Signature = parse_signature_packet(&sig.signature)?;
    let issuer_fps = extract_issuer_fingerprints(&sig_packet);

    // Pre-filter: do any known_signers match the sig's issuer fingerprint(s)?
    // We compare against EVERY key in the cert (primary + subkeys) because the
    // signature is typically made by a dedicated SIGNING SUBKEY — the sig
    // packet's IssuerFingerprint subpacket then carries the subkey's fp, not
    // the cert primary's fp (which is what `cert.fingerprint()` returns and
    // what `keymap::cert_to_handle` surfaces). Matching on the primary fp
    // alone would falsely classify a known signer as UnknownKey.
    //
    // Comparison is on `Fingerprint` (not `KeyHandle`) — the sig packet's
    // IssuerFingerprint subpacket is the strong form (RFC 9580 §5.2.3.28);
    // matching on it avoids false positives from short-KeyID collisions.
    let matching: Vec<&openpgp::Cert> = known_signers
        .iter()
        .filter(|c| {
            c.keys().any(|ka| {
                let ka_fp = ka.key().fingerprint();
                issuer_fps.iter().any(|fp| fp == &ka_fp)
            })
        })
        .collect();

    if matching.is_empty() {
        // UnknownKey: build a best-effort signer KeyHandleRef from the sig
        // packet's issuer fingerprint. `usage = Sign` because this IS a
        // signing key; `algorithm = "unknown"` because we do not have the
        // Cert's key material to read the public-key algorithm. The
        // fingerprint is the load-bearing field for UI trust prompts.
        let signer_ref = issuer_fps.first().map(|fp| {
            let hex = fp.to_hex();
            crypto_core::KeyHandleRef {
                handle: crypto_core::KeyHandle::Software(crypto_core::KeyId(
                    format!("openpgp|{}", hex),
                )),
                standard: Standard::OpenPgp,
                fingerprint: crypto_core::Fingerprint::new(hex),
                usage: crypto_core::KeyUsage::Sign,
                algorithm: "unknown".to_string(),
            }
        });
        return Ok(crypto_core::VerificationResult {
            state: crypto_core::SignatureState::UnknownKey,
            signer: signer_ref,
            failure_reason: None,
            revocation_reason: None,
        });
    }

    // Matching known-signer available → run the verifier. The helper hands
    // back the matching subset; `check()` enforces "at least one
    // GoodChecksum" so tampered data fails fast (mirrors spike-notes pattern).
    let helper = VerifyHelper {
        known_signers: matching.iter().map(|c| (*c).clone()).collect(),
    };
    let builder = map_sequoia(
        openpgp::parse::stream::DetachedVerifierBuilder::from_bytes(&sig.signature),
    )?;
    let mut verifier = map_sequoia(builder.with_policy(read_policy, None, helper))?;

    // `verify_bytes` runs the hash + comparison; the helper's `check()` is
    // invoked during this call (Sequoia buffers the signature group until the
    // data is fully hashed).
    let verify_outcome = verifier.verify_bytes(payload);

    // Signer handle from the FIRST matching cert (stable choice; multiple
    // matching certs is the multi-signer case, not in scope here).
    let signer_handle = keymap::cert_to_handle(matching[0]);

    // Weak-algo advisory is computed regardless of outcome — a tampered
    // signature over a weak-algo sig packet still surfaces the warning as
    // extra context.
    let weak_warning = pgp_policy.note_weak(&sig_packet);

    match verify_outcome {
        Ok(()) => Ok(crypto_core::VerificationResult {
            state: crypto_core::SignatureState::ValidVerified,
            signer: Some(signer_handle),
            // Advisory: `None` when the sig uses modern algos (the common
            // case). Engine-core convention — see the docstring above.
            failure_reason: weak_warning,
            revocation_reason: None,
        }),
        Err(e) => {
            // Fold the weak-algo warning (if any) into the failure reason as
            // additional context. The Sequoia error message is primary.
            let reason = match weak_warning {
                Some(w) => format!("{}; {}", e, w),
                None => format!("{}", e),
            };
            Ok(crypto_core::VerificationResult {
                state: crypto_core::SignatureState::Invalid,
                signer: Some(signer_handle),
                failure_reason: Some(reason),
                revocation_reason: None,
            })
        }
    }
}

/// Parse a single binary Signature packet from `bytes`.
///
/// Mirrors the verified pattern in `policy.rs::sign_fixture_with_hash`:
/// `PacketParserBuilder::from_bytes(...)?.build()?` returns a
/// `PacketParserResult`; we match out the `Some(parser)` arm and call
/// `recurse()` to materialize the `Packet`. The packet MUST be a
/// `Packet::Signature` — anything else is a [`CryptoError::Malformed`].
///
/// We use this instead of [`openpgp::packet::Signature::from_bytes`] because
/// the latter's `Parse` impl dispatches through a `Self::parse` method that
/// we observed failing with "Malformed packet: unknown version" on a valid
/// v4 Signature produced by [`Signer::detached`] (verified: bytes start with
/// `0xc2 0xbd 0x04 ...` = CTB New / Signature tag / length 189 / version 4).
/// `PacketParser` parses the same bytes correctly. This is a Sequoia 2.4.1
/// quirk we route around rather than fight.
fn parse_signature_packet(bytes: &[u8]) -> CryptoResult<openpgp::packet::Signature> {
    use crypto_core::CryptoError;

    let ppr = map_sequoia(
        openpgp::parse::PacketParserBuilder::from_bytes(bytes)
            .and_then(|b| b.build()),
    )?;
    let pp = match ppr {
        openpgp::parse::PacketParserResult::Some(pp) => pp,
        _ => {
            return Err(CryptoError::Malformed(
                "signature packet: empty input".into(),
            ));
        }
    };
    let (packet, _) = map_sequoia(pp.recurse())?;
    match packet {
        openpgp::Packet::Signature(s) => Ok(s),
        other => Err(CryptoError::Malformed(format!(
            "signature packet: expected Signature, got {:?}",
            other.tag()
        ))),
    }
}

/// Extract distinct issuer fingerprints from a parsed `Signature` packet.
///
/// Wraps [`openpgp::packet::Signature::get_issuers`], which returns both
/// `Issuer` (KeyID) and `IssuerFingerprint` subpackets, Fingerprints first.
/// We keep only the `Fingerprint` variants and de-duplicate by hex so a sig
/// carrying redundant subpackets yields a clean `Vec<Fingerprint>`.
fn extract_issuer_fingerprints(
    sig: &openpgp::packet::Signature,
) -> Vec<openpgp::Fingerprint> {
    use std::collections::HashSet;

    let mut seen: HashSet<String> = HashSet::new();
    let mut out = Vec::new();
    for kh in sig.get_issuers() {
        if let openpgp::KeyHandle::Fingerprint(fp) = kh {
            let hex = fp.to_hex();
            if seen.insert(hex) {
                out.push(fp);
            }
        }
    }
    out
}

/// `VerificationHelper` for [`verify_detached`].
///
/// Holds the pre-filtered matching subset of `known_signers` (the engine has
/// already established that at least one matches the sig's issuer
/// fingerprint). `get_certs` hands them all back so Sequoia can resolve the
/// exact signing subkey by `KeyHandle`. `check` enforces "at least one
/// `GoodChecksum`" — a tampered payload yields no `GoodChecksum`, so `check`
/// returns `Err` and `verify_bytes` propagates it as `Err`.
struct VerifyHelper {
    known_signers: Vec<openpgp::Cert>,
}

impl VerificationHelper for VerifyHelper {
    fn get_certs(
        &mut self,
        _ids: &[openpgp::KeyHandle],
    ) -> sequoia_openpgp::Result<Vec<openpgp::Cert>> {
        // `_ids` is ignored: the engine has already filtered
        // `known_signers` to the matching subset. Returning all of them lets
        // Sequoia pick the right signing subkey by KeyHandle from the sig
        // packet.
        Ok(self.known_signers.clone())
    }

    fn check(
        &mut self,
        structure: openpgp::parse::stream::MessageStructure,
    ) -> sequoia_openpgp::Result<()> {
        for layer in structure.into_iter() {
            if let openpgp::parse::stream::MessageLayer::SignatureGroup { results } =
                layer
            {
                let mut found_good = false;
                for r in results {
                    match r {
                        Ok(_good) => found_good = true,
                        // Surface the first verification failure verbatim.
                        Err(e) => {
                            return Err(sequoia_openpgp::Error::from(e).into());
                        }
                    }
                }
                if !found_good {
                    return Err(sequoia_openpgp::Error::InvalidArgument(
                        "no valid signature in group".into(),
                    )
                    .into());
                }
            }
        }
        Ok(())
    }
}

/// `DecryptionHelper` + `VerificationHelper` for [`decrypt`].
///
/// Implements BOTH traits (Sequoia requires both for `DecryptorBuilder::
/// with_policy`). Captures the first weak-algorithm warning in
/// [`VerificationHelper::check`] by calling
/// [`crate::policy::PgpPolicy::note_weak`] on each `GoodChecksum`'s
/// signature; the engine function extracts it via [`Decryptor::into_helper`]
/// after the plaintext has been drained.
struct Helper<'a> {
    cert: &'a openpgp::Cert,
    pgp_policy: &'a crate::policy::PgpPolicy,
    /// First weak-algo warning observed during `check()`. `None` until a
    /// signature with a legacy/weak algorithm is verified.
    weak_warning: Option<String>,
}

impl<'a> VerificationHelper for Helper<'a> {
    fn get_certs(
        &mut self,
        _ids: &[openpgp::KeyHandle],
    ) -> sequoia_openpgp::Result<Vec<openpgp::Cert>> {
        // Engine-core knows only the decryption cert. Signer-cert lookup by
        // `KeyHandle` is the framework's responsibility (Task 8 wires the
        // keystore). For the round-trip case (signer == decryptor) this
        // suffices; cross-cert sign-then-encrypt is verified by the framework
        // layer in Task 8.
        Ok(vec![self.cert.clone()])
    }

    fn check(&mut self, structure: MessageStructure) -> sequoia_openpgp::Result<()> {
        for layer in structure.into_iter() {
            if let MessageLayer::SignatureGroup { results } = layer {
                let mut found_good = false;
                for r in results {
                    match r {
                        Ok(good) => {
                            found_good = true;
                            // Capture the FIRST weak-algo warning (engine-core
                            // surface; multiple-weak-algo aggregation lands
                            // with Task 8's framework wiring).
                            if self.weak_warning.is_none() {
                                if let Some(w) = self.pgp_policy.note_weak(good.sig) {
                                    self.weak_warning = Some(w);
                                }
                            }
                        }
                        // Surface the first verification failure verbatim.
                        // A bad embedded signature MUST fail the decrypt.
                        Err(e) => {
                            return Err(sequoia_openpgp::Error::from(e).into());
                        }
                    }
                }
                if !found_good {
                    return Err(sequoia_openpgp::Error::InvalidArgument(
                        "no valid signature in group".into(),
                    )
                    .into());
                }
            }
        }
        Ok(())
    }
}

impl<'a> DecryptionHelper for Helper<'a> {
    fn decrypt(
        &mut self,
        pkesks: &[openpgp::packet::PKESK],
        _skesks: &[openpgp::packet::SKESK],
        sym_algo: Option<openpgp::types::SymmetricAlgorithm>,
        decrypt_fn: &mut dyn FnMut(
            Option<openpgp::types::SymmetricAlgorithm>,
            &openpgp::crypto::SessionKey,
        ) -> bool,
    ) -> sequoia_openpgp::Result<Option<openpgp::Cert>> {
        // Resolve the decryption cert's transport-encryption subkey. Use the
        // read policy (relaxed; admits legacy keys for decrypting old mail).
        let read_policy = self.pgp_policy.read_policy();
        let key = self
            .cert
            .keys()
            .unencrypted_secret()
            .with_policy(read_policy, None)
            .for_transport_encryption()
            .next()
            .ok_or_else(|| {
                sequoia_openpgp::Error::InvalidArgument(
                    "no usable transport-encryption subkey on decryption cert".into(),
                )
            })?
            .key()
            .clone();
        let mut pair = key.into_keypair()?;

        // Iterate every PKESK; the first one that successfully decrypts to a
        // session key that `decrypt_fn` accepts wins. For multi-recipient
        // messages the recipient matching THIS cert's subkey is somewhere in
        // the list.
        for pkesk in pkesks {
            if let Some((algo, sk)) = pkesk.decrypt(&mut pair, sym_algo) {
                if decrypt_fn(algo, &sk) {
                    // Returning `None` here means "we don't claim a specific
                    // intended-recipient cert"; engine-core does not enforce
                    // the Intended Recipient Fingerprint anti-Surreptitious-
                    // Forwarding check. That policy decision is the framework's.
                    return Ok(None);
                }
            }
        }
        Err(sequoia_openpgp::Error::InvalidArgument(
            "no PKESK matched the decryption cert's transport subkey".into(),
        )
        .into())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crypto_core::SecretBox;
    use sequoia_openpgp::policy::StandardPolicy as P;

    /// Permissive fixture policy for capability-flag assertions. The
    /// `for_*` filters (`for_signing`, `for_transport_encryption`,
    /// `for_certification`) live on `ValidKeyAmalgamationIter`
    /// (`sequoia_openpgp-2.4.1/src/cert/amalgamation/key/iter.rs:898`), reached
    /// via `cert.keys().with_policy(P_, None)`.
    const P_: &P = &P::new();

    /// Task-1 spike `gen()` pattern, duplicated per the no-cross-task-assumption
    /// rule (this crate's lib-tests must not depend on `tests/spike.rs`).
    /// Yields a Cert with primary (certify) + transport-encryption subkey +
    /// signing subkey — all with UNENCRYPTED secret material (no S2K).
    fn gen() -> openpgp::Cert {
        let (cert, _rev) = CertBuilder::new()
            .add_userid("engine-test@example.org")
            .add_transport_encryption_subkey()
            .add_signing_subkey()
            .generate()
            .expect("CertBuilder::generate");
        cert
    }

    /// Build a TSK with ALL secret material encrypted under `password`.
    /// `CertBuilder::set_password` applies S2K encryption to every key the
    /// builder produces (primary + subkeys) — verified at
    /// `sequoia_openpgp-2.4.1/src/cert.rs:6289` test `decrypt_encrypt_secrets`.
    fn gen_encrypted(password: &str) -> openpgp::Cert {
        let (cert, _rev) = CertBuilder::new()
            .add_userid("engine-encrypted@example.org")
            .add_transport_encryption_subkey()
            .add_signing_subkey()
            .set_password(Some(password.into()))
            .generate()
            .expect("CertBuilder::generate with password");
        cert
    }

    // ---- generate() --------------------------------------------------------

    #[test]
    fn generate_produces_cert_with_transport_encryption_and_signing_subkeys() {
        let cert = generate("alice@example.org").expect("generate");
        // Structural: primary + enc subkey + sign subkey.
        assert_eq!(
            cert.keys().count(),
            3,
            "generated cert must have primary + 2 subkeys"
        );
        // `for_*` capability filters live on `ValidKeyAmalgamationIter`
        // (sequoia-openpgp-2.4.1/src/cert/amalgamation/key/iter.rs:898); reach
        // them via `.with_policy(P_, None)`.
        // Primary is certify-only (CertBuilder::new() default).
        assert!(
            cert.keys()
                .with_policy(P_, None)
                .for_certification()
                .next()
                .is_some(),
            "cert must have a certification-capable primary"
        );
        // Transport-encryption subkey present.
        assert!(
            cert.keys()
                .with_policy(P_, None)
                .for_transport_encryption()
                .next()
                .is_some(),
            "cert must have a transport-encryption subkey"
        );
        // Signing subkey present.
        assert!(
            cert.keys()
                .with_policy(P_, None)
                .for_signing()
                .next()
                .is_some(),
            "cert must have a signing subkey"
        );
    }

    #[test]
    fn generate_cert_is_tsk_with_all_unencrypted_secrets() {
        // `CertBuilder::generate()` without `set_password(...)` yields a TSK
        // with UNENCRYPTED secret material. At-rest protection is the master
        // key's job (per the engine's design), so no OpenPGP S2K layer is
        // applied.
        let cert = generate("bob@example.org").expect("generate");
        assert!(cert.is_tsk(), "generated cert must be a TSK");
        assert_eq!(
            cert.keys().unencrypted_secret().count(),
            cert.keys().secret().count(),
            "all secrets in a generated cert must be unencrypted"
        );
        assert_eq!(
            cert.keys().encrypted_secret().count(),
            0,
            "no encrypted secrets in a generated cert"
        );
    }

    #[test]
    fn generate_user_id_is_attached() {
        let cert = generate("carol@example.org").expect("generate");
        let userids: Vec<String> =
            cert.userids().map(|u| u.userid().to_string()).collect();
        assert!(
            userids.iter().any(|u| u == "carol@example.org"),
            "user_id must be attached; got: {userids:?}"
        );
    }

    // ---- export_armored_public() -------------------------------------------

    #[test]
    fn export_armored_public_emits_public_key_block_frame() {
        let cert = gen();
        let armored = export_armored_public(&cert).expect("export");
        let s = std::str::from_utf8(&armored).expect("armored is utf8");
        assert!(
            s.contains("-----BEGIN PGP PUBLIC KEY BLOCK-----"),
            "must be a PUBLIC KEY BLOCK; got: {}",
            &s[..s.len().min(120)]
        );
    }

    // ---- import() round-trips (unencrypted path) ---------------------------

    #[test]
    fn import_public_only_cert_round_trips_with_no_passphrase() {
        let cert = gen();
        let armored = export_armored_public(&cert).expect("export");
        // Public-only cert → no passphrase needed; a supplied passphrase is
        // silently ignored (covered by passing None here).
        let imported = import(&armored, None).expect("import");
        assert_eq!(imported.fingerprint(), cert.fingerprint());
        assert!(
            !imported.is_tsk(),
            "imported public cert must NOT be a TSK"
        );
    }

    #[test]
    fn import_unencrypted_tsk_round_trips_with_no_passphrase() {
        let cert = gen();
        // Serialize as a binary TPK WITH secret material (TSK form) so we can
        // verify the no-passphrase fast-path returns a still-TSK cert.
        let blob = crate::keymap::cert_to_secret_blob(&cert).expect("secret blob");
        let imported = import(&blob, None).expect("import");
        assert_eq!(imported.fingerprint(), cert.fingerprint());
        assert!(
            imported.is_tsk(),
            "imported unencrypted TSK must remain a TSK"
        );
        assert_eq!(
            imported.keys().encrypted_secret().count(),
            0,
            "imported unencrypted TSK must have zero encrypted secrets"
        );
    }

    #[test]
    fn import_empty_input_returns_policy_error() {
        let err = import(&[], None).unwrap_err();
        assert!(
            matches!(err, crypto_core::CryptoError::Policy(ref s)
                if s.contains("no OpenPGP certs")),
            "empty input must produce a Policy error mentioning 'no OpenPGP certs'; got: {err}"
        );
    }

    // ---- import() encrypted-secret path ------------------------------------

    #[test]
    fn import_encrypted_cert_without_passphrase_is_policy_error() {
        let cert = gen_encrypted("hunter2");
        let blob = crate::keymap::cert_to_secret_blob(&cert).expect("secret blob");
        // Sanity: the blob really does contain encrypted secrets (guards
        // against a regression where set_password stops encrypting).
        let parsed = crate::keymap::parse_certs(&blob).expect("parse");
        assert_eq!(parsed.len(), 1);
        assert_eq!(
            parsed[0].keys().encrypted_secret().count(),
            parsed[0].keys().secret().count(),
            "encrypted fixture must have ALL secrets encrypted"
        );

        let err = import(&blob, None).unwrap_err();
        assert!(
            matches!(err, crypto_core::CryptoError::Policy(ref s)
                if s.contains("passphrase")),
            "encrypted cert without passphrase must be a Policy error mentioning 'passphrase'; got: {err}"
        );
    }

    #[test]
    fn import_encrypted_cert_with_correct_passphrase_decrypts_all_secrets() {
        let password = "correct horse battery staple";
        let cert = gen_encrypted(password);
        let blob = crate::keymap::cert_to_secret_blob(&cert).expect("secret blob");

        let pw_box: SecretBox<String> =
            SecretBox::new(Box::new(password.to_string()));
        let imported = import(&blob, Some(pw_box)).expect("import with passphrase");

        // Fingerprint round-trips.
        assert_eq!(
            imported.fingerprint(),
            cert.fingerprint(),
            "fingerprint must survive encrypt→decrypt round-trip"
        );
        // All secrets must now be UNENCRYPTED.
        assert_eq!(
            imported.keys().unencrypted_secret().count(),
            imported.keys().secret().count(),
            "all secrets must be decrypted after import with correct passphrase"
        );
        assert_eq!(
            imported.keys().encrypted_secret().count(),
            0,
            "no encrypted secrets must remain after import with correct passphrase"
        );
        // Cross-check: the cert is still a TSK (decryption reveals secrets,
        // it does not remove them).
        assert!(
            imported.is_tsk(),
            "imported-and-decrypted cert must still be a TSK"
        );
    }

    #[test]
    fn import_encrypted_cert_with_wrong_passphrase_is_backend_error() {
        let cert = gen_encrypted("right password");
        let blob = crate::keymap::cert_to_secret_blob(&cert).expect("secret blob");

        let wrong_pw: SecretBox<String> =
            SecretBox::new(Box::new("wrong password".to_string()));
        let err = import(&blob, Some(wrong_pw)).unwrap_err();
        // A wrong passphrase surfaces as a Sequoia error → CryptoError::Backend
        // (NOT Policy — the user supplied a passphrase; it just didn't match).
        assert!(
            matches!(err, crypto_core::CryptoError::Backend(_)),
            "wrong passphrase must surface as CryptoError::Backend; got: {err}"
        );
    }

    // ---- encrypt / decrypt (Task 6) ---------------------------------------

    /// Build a `PgpPolicy` fixture from the framework baseline. The engine's
    /// `encrypt`/`decrypt` take `&PgpPolicy` (Task 4 bridge between the
    /// framework policy and Sequoia's `StandardPolicy`).
    fn pgp_policy() -> crate::policy::PgpPolicy {
        crate::policy::PgpPolicy::default()
    }

    fn body_part(id: &str, data: &[u8]) -> crypto_core::Part {
        crypto_core::Part {
            id: crypto_core::PartId(id.to_string()),
            kind: crypto_core::PartKind::Body,
            data: data.to_vec(),
        }
    }

    fn attachment_part(
        id: &str,
        filename: &str,
        mime: &str,
        content_id: Option<&str>,
        data: &[u8],
    ) -> crypto_core::Part {
        crypto_core::Part {
            id: crypto_core::PartId(id.to_string()),
            kind: crypto_core::PartKind::Attachment {
                filename: filename.to_string(),
                mime: mime.to_string(),
                content_id: content_id.map(str::to_string),
            },
            data: data.to_vec(),
        }
    }

    #[test]
    fn encrypt_decrypt_round_trip_single_body_part() {
        let pol = pgp_policy();
        let cert = gen();
        let part = body_part("body", b"hi");

        let env = encrypt(
            std::slice::from_ref(&part),
            crypto_core::SerializationStrategy::SingleMimeBlob,
            std::slice::from_ref(&cert),
            None,
            &pol,
        )
        .expect("encrypt");

        // Shape: exactly one EncryptedPart, at least one KeyPacketRef.
        assert_eq!(
            env.parts.len(),
            1,
            "SingleMimeBlob must produce exactly one EncryptedPart"
        );
        assert!(
            !env.recipients.is_empty(),
            "envelope must list at least one recipient"
        );
        assert_eq!(env.standard, crypto_core::Standard::OpenPgp);
        assert_eq!(
            env.serialization,
            crypto_core::SerializationStrategy::SingleMimeBlob
        );

        let (payload, _weak) = decrypt(&env, &cert, &pol).expect("decrypt");
        assert_eq!(payload.standard, crypto_core::Standard::OpenPgp);
        assert_eq!(payload.parts.len(), 1, "one part in, one part out");
        assert_eq!(payload.parts[0].id, part.id, "PartId must round-trip");
        assert_eq!(payload.parts[0].data, part.data, "data must round-trip");
        assert!(
            matches!(payload.parts[0].kind, crypto_core::PartKind::Body),
            "PartKind::Body must round-trip"
        );
    }

    #[test]
    fn encrypt_decrypt_preserves_multiple_parts_and_attachment_kind() {
        let pol = pgp_policy();
        let cert = gen();
        let parts = vec![
            body_part("body", b"hello body"),
            attachment_part(
                "att-1",
                "report.pdf",
                "application/pdf",
                Some("<cid-1@example.org>"),
                b"pdf bytes go here",
            ),
            attachment_part("att-2", "photo.png", "image/png", None, b"png-bytes"),
        ];

        let env = encrypt(
            &parts,
            crypto_core::SerializationStrategy::SingleMimeBlob,
            std::slice::from_ref(&cert),
            None,
            &pol,
        )
        .expect("encrypt");

        let (payload, _weak) = decrypt(&env, &cert, &pol).expect("decrypt");
        assert_eq!(
            payload.parts.len(),
            parts.len(),
            "part count must round-trip"
        );
        for (i, expected) in parts.iter().enumerate() {
            assert_eq!(
                payload.parts[i].id, expected.id,
                "part {i} PartId must round-trip"
            );
            assert_eq!(
                payload.parts[i].data,
                expected.data,
                "part {i} data must round-trip"
            );
            assert_eq!(
                payload.parts[i].kind, expected.kind,
                "part {i} PartKind must round-trip"
            );
        }
    }

    #[test]
    fn encrypt_with_signer_then_decrypt_verifies_embedded_signature() {
        // Sign-then-encrypt with signer == decryptor (engine-core has only the
        // decryption cert available; framework-side signer lookup lands in
        // Task 8). The embedded signature MUST verify on decrypt, otherwise
        // `decrypt` returns Err.
        let pol = pgp_policy();
        let cert = gen();
        let part = body_part("body", b"signed then encrypted");

        let env = encrypt(
            std::slice::from_ref(&part),
            crypto_core::SerializationStrategy::SingleMimeBlob,
            std::slice::from_ref(&cert),
            Some(&cert),
            &pol,
        )
        .expect("encrypt with sign_with");

        // Sanity: encryption produced a single ciphertext blob.
        assert_eq!(env.parts.len(), 1);

        let (payload, _weak) = decrypt(&env, &cert, &pol).expect("decrypt must succeed");
        assert_eq!(payload.parts.len(), 1);
        assert_eq!(payload.parts[0].data, part.data);
    }

    #[test]
    fn decrypt_tampered_ciphertext_fails() {
        // If the encrypted blob is mutated, decryption must fail (Sequoia's
        // SEIP/MDC integrity detection). This is the load-bearing security
        // property of the decrypt path.
        let pol = pgp_policy();
        let cert = gen();
        let part = body_part("body", b"integrity-protected");

        let mut env = encrypt(
            std::slice::from_ref(&part),
            crypto_core::SerializationStrategy::SingleMimeBlob,
            std::slice::from_ref(&cert),
            None,
            &pol,
        )
        .expect("encrypt");

        // Flip a byte deep in the ciphertext (avoid the preamble to make sure
        // we hit the SEIP body, not the PKESK wrap).
        let ct_len = env.parts[0].ciphertext.len();
        assert!(ct_len > 8, "ciphertext must be non-trivially long");
        env.parts[0].ciphertext[ct_len - 1] ^= 0xff;

        let err = decrypt(&env, &cert, &pol).unwrap_err();
        assert!(
            matches!(err, crypto_core::CryptoError::Backend(_)),
            "tampered ciphertext must surface as Backend error; got: {err}"
        );
    }

    #[test]
    fn encrypt_multiple_recipients_decrypts_with_either() {
        // Each recipient cert must be able to decrypt a message encrypted to
        // both — Sequoia emits one PKESK per recipient inside the single
        // ciphertext blob.
        let pol = pgp_policy();
        let cert_a = gen();
        let cert_b = gen();
        let part = body_part("body", b"multi-recipient payload");

        let env = encrypt(
            std::slice::from_ref(&part),
            crypto_core::SerializationStrategy::SingleMimeBlob,
            &[cert_a.clone(), cert_b.clone()],
            None,
            &pol,
        )
        .expect("encrypt");

        // The informative recipients list must contain both.
        assert_eq!(
            env.recipients.len(),
            2,
            "recipients list must mirror the input recipient_certs"
        );

        // Each cert decrypts on its own.
        let (pa, _w) = decrypt(&env, &cert_a, &pol).expect("cert_a decrypts");
        assert_eq!(pa.parts[0].data, part.data);
        let (pb, _w) = decrypt(&env, &cert_b, &pol).expect("cert_b decrypts");
        assert_eq!(pb.parts[0].data, part.data);
    }

    #[test]
    fn encrypt_split_per_part_returns_policy_error() {
        let pol = pgp_policy();
        let cert = gen();
        let part = body_part("body", b"unsupported");

        let err = encrypt(
            &[part],
            crypto_core::SerializationStrategy::SplitPerPart,
            &[cert],
            None,
            &pol,
        )
        .unwrap_err();
        assert!(
            matches!(err, crypto_core::CryptoError::Policy(ref s)
                if s.contains("SplitPerPart")),
            "SplitPerPart must surface as Policy error mentioning SplitPerPart; got: {err}"
        );
    }

    #[test]
    fn encrypt_empty_recipient_list_returns_policy_error() {
        let pol = pgp_policy();
        let part = body_part("body", b"nobody to encrypt to");

        let err = encrypt(
            &[part],
            crypto_core::SerializationStrategy::SingleMimeBlob,
            &[],
            None,
            &pol,
        )
        .unwrap_err();
        assert!(
            matches!(err, crypto_core::CryptoError::Policy(ref s)
                if s.contains("recipient")),
            "no-recipients must surface as Policy error mentioning recipient; got: {err}"
        );
    }

    #[test]
    fn encrypt_empty_part_list_returns_policy_error() {
        let pol = pgp_policy();
        let cert = gen();

        let err = encrypt(
            &[],
            crypto_core::SerializationStrategy::SingleMimeBlob,
            &[cert],
            None,
            &pol,
        )
        .unwrap_err();
        assert!(
            matches!(err, crypto_core::CryptoError::Policy(ref s)
                if s.contains("part")),
            "no-parts must surface as Policy error mentioning part; got: {err}"
        );
    }

    // ---- sign / verify (Task 7) -------------------------------------------
    //
    // NOTE on fingerprint case: `crypto_core::Fingerprint::new()` normalizes
    // to lowercase, but Sequoia's `Fingerprint::to_hex()` returns UPPERCASE
    // (see `fingerprint.rs:224`). When comparing a known fixture fp against
    // `result.signer.fingerprint.as_str()` (which goes through
    // `keymap::cert_to_handle` → `Fingerprint::new`), use `expect_fp()`
    // (lowercases) instead of raw `cert.fingerprint().to_hex()`.

    /// Build the EXPECTED framework fingerprint for a cert, matching the
    /// lowercasing that `keymap::cert_to_handle` applies. Use this in tests
    /// when asserting against `result.signer.fingerprint.as_str()`.
    fn expect_fp(cert: &openpgp::Cert) -> String {
        cert.fingerprint().to_hex().to_ascii_lowercase()
    }

    /// Same as [`expect_fp`] but for a cert's signing SUBKEY fingerprint (the
    /// sig packet's IssuerFingerprint subpacket carries the subkey fp, not
    /// the cert primary's).
    fn expect_signing_subkey_fp(cert: &openpgp::Cert) -> String {
        cert.keys()
            .with_policy(P_, None)
            .for_signing()
            .next()
            .expect("signing subkey exists")
            .key()
            .fingerprint()
            .to_hex()
            .to_ascii_lowercase()
    }

    #[test]
    fn sign_detached_then_verify_round_trips_as_valid_verified() {
        let pol = pgp_policy();
        let cert = gen();
        let payload = b"signed payload";

        let sig = sign_detached(payload, &cert, &pol).expect("sign");
        // DetachedSignature shape: PGP standard, signer handle echoes the
        // signing cert's fingerprint, non-empty signature bytes.
        assert_eq!(sig.standard, Standard::OpenPgp);
        assert_eq!(sig.signer.fingerprint.as_str(), expect_fp(&cert));
        assert!(!sig.signature.is_empty());

        let result = verify_detached(payload, &sig, std::slice::from_ref(&cert), &pol)
            .expect("verify");
        assert_eq!(
            result.state,
            crypto_core::SignatureState::ValidVerified,
            "sign→verify with matching signer must be ValidVerified; got {:?}",
            result
        );
        let signer = result
            .signer
            .as_ref()
            .expect("ValidVerified must surface a signer handle");
        assert_eq!(
            signer.fingerprint.as_str(),
            expect_fp(&cert),
            "ValidVerified signer must be the matching known-signer"
        );
        assert!(
            result.revocation_reason.is_none(),
            "PGP engine-core never sets revocation_reason"
        );
        // No failure_reason when valid AND no weak-alga warning (modern fixture:
        // SHA-256 + EdDSA → note_weak returns None).
        assert!(
            result.failure_reason.is_none(),
            "ValidVerified on modern algos must have no failure_reason; got {:?}",
            result.failure_reason
        );
    }

    #[test]
    fn verify_detached_tampered_payload_is_invalid() {
        let pol = pgp_policy();
        let cert = gen();
        let payload = b"original payload bytes";
        let sig = sign_detached(payload, &cert, &pol).expect("sign");

        let tampered = b"tampered payload bytes";
        let result =
            verify_detached(tampered, &sig, std::slice::from_ref(&cert), &pol)
                .expect("verify");
        assert_eq!(
            result.state,
            crypto_core::SignatureState::Invalid,
            "tampered payload must be Invalid"
        );
        assert!(
            result.failure_reason.is_some(),
            "Invalid must surface a failure_reason"
        );
        // Signer is still the matching known-signer (we identified the right
        // key — the signature itself just doesn't verify).
        let signer = result
            .signer
            .as_ref()
            .expect("Invalid still surfaces the identified signer");
        assert_eq!(signer.fingerprint.as_str(), expect_fp(&cert));
    }

    #[test]
    fn verify_detached_with_empty_known_signers_is_unknown_key() {
        let pol = pgp_policy();
        let cert = gen();
        let payload = b"payload";
        let sig = sign_detached(payload, &cert, &pol).expect("sign");

        let result = verify_detached(payload, &sig, &[], &pol).expect("verify");
        assert_eq!(
            result.state,
            crypto_core::SignatureState::UnknownKey,
            "no known signers → UnknownKey"
        );
        assert!(
            result.failure_reason.is_none(),
            "UnknownKey has no failure_reason (no verification attempted)"
        );
        // Issuer fingerprint is still derivable from the sig packet → surfaced.
        // The sig's IssuerFingerprint subpacket carries the SIGNING SUBKEY's
        // fp (not the cert's primary) — extract it via the same path the
        // production code uses for cross-checking.
        let signer = result
            .signer
            .as_ref()
            .expect("UnknownKey surfaces the sig packet's issuer fingerprint");
        assert_eq!(
            signer.fingerprint.as_str(),
            expect_signing_subkey_fp(&cert),
            "UnknownKey signer fingerprint must be the sig's issuer (signing subkey fp)"
        );
    }

    #[test]
    fn verify_detached_with_mismatched_known_signer_is_unknown_key() {
        let pol = pgp_policy();
        let signer_cert = gen();
        let other_cert = gen(); // distinct signing cert (different fingerprint)
        let payload = b"payload";
        let sig = sign_detached(payload, &signer_cert, &pol).expect("sign");

        // Sanity: the two certs are actually distinct (primary fp differs).
        assert_ne!(
            signer_cert.fingerprint(),
            other_cert.fingerprint(),
            "fixture certs must differ"
        );

        let result =
            verify_detached(payload, &sig, std::slice::from_ref(&other_cert), &pol)
                .expect("verify");
        assert_eq!(
            result.state,
            crypto_core::SignatureState::UnknownKey,
            "mismatched known_signer → UnknownKey"
        );
        // The UnknownKey signer fingerprint is the SIG's issuer (the real
        // signer's signing SUBKEY fp), NOT the unrelated known-signer's.
        let signer = result
            .signer
            .as_ref()
            .expect("UnknownKey surfaces the sig packet's issuer");
        assert_eq!(
            signer.fingerprint.as_str(),
            expect_signing_subkey_fp(&signer_cert),
            "UnknownKey signer fp must come from the sig packet (signing subkey), not the unrelated known-signer"
        );
    }

    #[test]
    fn sign_detached_emits_only_signature_packet_with_default_hash() {
        // Sanity: signature bytes hold ONLY a detached Signature packet (no
        // literal data), and the default hash is a modern SHA-2 variant for
        // the engine's Ed25519 signing subkey under the write policy. Sequoia
        // actually picks SHA-512 for Ed25519 (per RFC 8032, which recommends
        // SHA-512 as the Ed25519 hash); both SHA-256 and SHA-512 are
        // acceptable modern choices that `note_weak` does NOT flag.
        let pol = pgp_policy();
        let cert = gen();
        let sig = sign_detached(b"any payload", &cert, &pol).expect("sign");
        let parsed = parse_signature_packet(&sig.signature).expect("parse");
        assert!(
            matches!(
                parsed.hash_algo(),
                openpgp::types::HashAlgorithm::SHA256
                    | openpgp::types::HashAlgorithm::SHA512
            ),
            "default write-policy hash for Ed25519 must be SHA-256 or SHA-512; got {:?}",
            parsed.hash_algo()
        );
        // Cross-check: the policy's weak-algo detector does not flag the sig.
        assert!(
            pol.note_weak(&parsed).is_none(),
            "default-algo sig must not trigger a weak-algo warning"
        );
    }

    #[test]
    fn verify_detached_valid_verified_silences_failure_reason_on_modern_algos() {
        // Mirrors `sign_detached_then_verify_round_trips_as_valid_verified` but
        // explicit about the no-weak-warning invariant: a modern-algo sig
        // produces a fully clean VerificationResult (no failure_reason).
        let pol = pgp_policy();
        let cert = gen();
        let sig = sign_detached(b"clean payload", &cert, &pol).expect("sign");
        let result = verify_detached(
            b"clean payload",
            &sig,
            std::slice::from_ref(&cert),
            &pol,
        )
        .expect("verify");
        assert_eq!(result.state, crypto_core::SignatureState::ValidVerified);
        assert!(
            result.failure_reason.is_none(),
            "modern-algo ValidVerified must have None failure_reason; got {:?}",
            result.failure_reason
        );
    }
}
