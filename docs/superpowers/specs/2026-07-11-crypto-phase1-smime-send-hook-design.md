# Plan 4a — S/MIME Send-Hook (Backend) Design

> **Status:** Draft (brainstormed 2026-07-11; clear-sign confirmed).
> **Parent:** `docs/superpowers/specs/2026-07-10-crypto-phase1-smime-design.md` — §2/§3/§5/§6 define the send hook, MIME wrapping (`multipart/signed`, `application/pkcs7-mime`), recipient resolution, fail-closed, and the CryptoBadge/KeyManager UI at design-target level. **This doc specializes the parent for the backend send-hook implementation.**
> **Decomposition:** Plan 4 = **4a (this doc, backend send-hook)** → **4b (CryptoBadge + KeyManager UI)**. 4a achieves the parent spec's Thunderbird-interop gate with no UI dependency.
> **Builds on:** crypto-smime `sign` + `encrypt` (Plan 2b, committed `c74a4ca`), the `SqliteKeyStore` bridge, `db::crypto_keys` (incl. `find_by_email`/`list_crypto_keys_for_email`), the `send_op` replay path.

---

## 0. Decision log (locked this session)

| # | Decision | Choice |
|---|---|---|
| 1 | `SmimeBackend` runtime location | **Per-send**, constructed inside `send_op` (`SqliteKeyStore::new(engine.pool, account_id)` + `SmimeBackend::new`). `send_op` already has `pool` + `account_id`. Rejected: Tauri `State<>` (per-account keystore switching), `SyncEngine` field (unnecessary lifetime plumbing). |
| 2 | Sign-only MIME format | **Clear-sign** (`multipart/signed; protocol="application/pkcs7-signature"; micalg="sha-256"`) — parent §3, Thunderbird default, readable by non-S/MIME clients. |
| 3 | Sign+encrypt composition | **Clear-sign inner** (`multipart/signed`) **+ enveloped outer** — one consistent signing mechanism (clear-sign whenever signing), then optionally encrypt. |
| 4 | Encrypt-to-self | **Yes** — the sender is added as an encryption recipient so their own Sent copy is decryptable. Standard S/MIME. |
| 5 | Missing recipient cert / signing key | **Fail-closed** — `apply_crypto` returns an error; `send_op` surfaces it via `sync:send-result{success:false}` immediately. These are **permanent** errors (a missing cert won't appear on retry), so the plan must avoid indefinite replay-worker backoff — either a permanent/non-retryable error classification on the pending op, or a surfacing path that lets the user dismiss/cancel it. No plaintext fallback. |
| 6 | Sent-folder copy | The **wrapped** (signed/encrypted) bytes feed the Sent-folder APPEND — `send_op` already reuses the same `mime` for send + append, so this is automatic once `apply_crypto` wraps before send. |
| 7 | `backend.encrypt(sign_with)` (opaque sign-then-encrypt, Plan 2b Task 5) | **Not used by 4a** — we compose clear-sign + encrypt at the MIME layer instead. That API remains valid (opaque mode) for future use. |

---

## 1. IPC contract (SendDraft gains crypto fields)

Add to `SendDraft` — Rust (`kylins.client.backend/src/mail/builder.rs`) + TS (`kylins.client.frontend/src/services/composer/types.ts`):

```rust
// Rust
pub enum CryptoMethod { None, Smime }   // serde rename_all="lowercase" → "none"/"smime"
pub struct SendDraft {
    // ...existing fields...
    #[serde(default)]
    pub crypto_method: CryptoMethod,   // default None
    #[serde(default)]
    pub sign: bool,
    #[serde(default)]
    pub encrypt: bool,
}
```

```ts
// TS
cryptoMethod: 'none' | 'smime'   // default 'none'
sign: boolean                     // default false
encrypt: boolean                  // default false
```

`buildSendDraft.ts` carries `cryptoMethod`/`sign`/`encrypt` from `composerStore` (which already has `isEncrypted`/`isSigned`; add `cryptoMethod`). **Backward-compatible** — `#[serde(default)]` / optional TS fields mean old callers keep working.

> The composer toggle's *default* (per-account `crypto_method`) is a Plan 4b UI concern; 4a only requires the per-message intent to reach the backend.

---

## 2. Components

1. **`SendDraft` crypto fields** — Rust + TS (§1).
2. **`db::crypto_keys::get_default_signing_key(account_id) -> Option<KeyHandleRef>`** — new helper returning the account's default `standard='smime'` signing key (the `is_default_sign` column exists + is upsertable; no reader today).
3. **`mail/crypto.rs::apply_crypto(...) -> Result<Vec<u8>>`** — the hook (§3). Pure-ish: takes a constructed `SmimeBackend` + the built MIME + draft + pool; returns the wrapped MIME.
4. **`send_op` wiring** — construct `SmimeBackend` per-send, call `apply_crypto` between `build_mime` (`engine.rs:934`) and `src.send` (`engine.rs:973`); the wrapped bytes then flow to both `src.send` and the Sent-folder `src.append` unchanged.
5. **`crypto-smime` fix** — `build_signed_data(detached=true)` must sign over the external content (§4). Without this, clear-sign produces a degenerate (contentless) SignedData.

---

## 3. `apply_crypto` data flow

```
apply_crypto(backend, mime, draft, account_id, pool):
  if draft.crypto_method != Smime OR (!sign AND !encrypt): return mime   // unchanged

  // --- sign (clear-sign) ---
  if draft.sign:
    signer = get_default_signing_key(account_id)
            ?? Err("no default S/MIME signing key for account")
    content_to_sign = mime + b"\r\n"            // RFC 5751 §3.4: trailing CRLF before boundary
    sig_env = backend.sign(SignOp{ payload: &content_to_sign,
                                   signing_key: signer, detached: true })?
    signed_der = sig_env.signature.signature    // detached SignedData (eContent=None, signed over content_to_sign)
    mime = build_multipart_signed(mime, signed_der)?   // §4 multipart/signed wrapper

  // --- encrypt ---
  if draft.encrypt:
    recipient_emails = draft.to ++ draft.cc ++ draft.bcc
                       ++ [account_email]   // encrypt-to-self: sender must read their own Sent copy.
                                           // account_email = accounts.email for account_id
                                           //   (the sender's cert is imported under that address).
    recipients = Vec::new()
    for email in recipient_emails:
      handles = keystore.find_by_email(Standard::Smime, email)?
      recipients.push(handles.first().ok_or("no S/MIME cert for {email}")?)   // fail-closed
    env = backend.encrypt(EncryptOp{ parts: &[Part{ data: mime, .. }],
                                     serialization: SingleMimeBlob,
                                     recipients: &recipients,
                                     sign_with: None })?                     // sign already applied above
    enveloped_der = env.parts[0].ciphertext
    mime = build_pkcs7_mime(enveloped_der, "enveloped-data")?                 // §4 application/pkcs7-mime wrapper

  return mime
```

- **Sign-only** → `multipart/signed`.
- **Encrypt-only** → `application/pkcs7-mime; smime-type=enveloped-data`.
- **Sign+encrypt** → inner `multipart/signed`, outer `application/pkcs7-mime; smime-type=enveloped-data`.

---

## 4. Clear-sign mechanics (the finicky part)

Two sub-problems, both required for `multipart/signed`:

**4a. Fix `build_signed_data(detached=true)`.** Currently when `detached=true` it sets `econtent=None` AND passes `external_message_digest=None` to `SignerInfoBuilder::new`, producing a **degenerate** SignedData (no digest). The fix: when `detached=true`, pass `external_message_digest=Some(payload)` (the cms builder computes the digest over external content — see `cms/src/builder.rs` finalize path). `backend.sign(detached=true)` then yields a valid detached SignedData whose signature covers `payload`.

**4b. Construct `multipart/signed`.** Structure (RFC 1847 / RFC 5751 §3.4):
```
Content-Type: multipart/signed; protocol="application/pkcs7-signature";
              micalg="sha-256"; boundary="----=_Part_..."

------=_Part_...
<inner MIME body — EXACT bytes that were signed, incl. the trailing CRLF>
------=_Part_...
Content-Type: application/pkcs7-signature; name="smime.p7s"
Content-Transfer-Encoding: base64
Content-Disposition: attachment; filename="smime.p7s"

<base64 of the detached SignedData DER>
------=_Part_...--
```
The bytes signed (passed to `backend.sign` as `payload`) are the inner MIME body **+ the trailing CRLF** that precedes the first boundary. **Spike (Task 0 of the plan):** does `mail-builder` 0.4 emit a correct `multipart/signed` (right `protocol`/`micalg` params, stable boundary, byte-exact part-1 content)? If yes, use it; if not, construct the `multipart/signed` bytes manually (straightforward — it's a deterministic wrapper). The same wrapper builds the `application/pkcs7-mime` body for encryption (simpler — one base64 part).

---

## 5. Verification gate

**Automated (the gate):**
- `apply_crypto` end-to-end: sign-only produces a `multipart/signed` whose detached signature **verifies** (recover the signer's verifying key from the embedded cert, recompute the digest over the part-1 bytes, verify the ECDSA signature) — proves byte-exactness of the signed content.
- Encrypt-only produces an `application/pkcs7-mime` whose body parses as `EnvelopedData` with one recipient per `To`/`Cc`/`Bcc` + sender.
- Sign+encrypt: outer `enveloped-data`, inner (after structural parse) `multipart/signed`.
- Fail-closed: missing recipient cert → error, no enveloped output.
- Existing crypto-smime (19) + backend lib (465+) tests stay green; clippy clean both workspaces.

**Manual (optional, not blocking):** generate a signed `.eml` (self-signed cert) and open in Thunderbird — expect "untrusted signer" but a structurally-valid signature. Full decrypt/verify interop waits for Phase 1b (our `decrypt`/`verify` are still stubs).

---

## 6. Non-goals (Plan 4b / later)

- **UI** (CryptoBadge composer+sent states, KeyManager import/default-identity/list) — Plan 4b.
- `.p12`/`.pfx` import — Plan 3 (PEM cert+PKCS#8 import already works from Plan 2).
- Recipient-cert discovery (`collected_keys` staging, LDAP/GAL/SMIMEA) — Phase 1b/2. 4a resolves certs only from `crypto_keys` by email (manual import).
- `decrypt`/`verify` + RFC 5280 chain validation — Phase 1b.
- Encrypted subject, SecurityPanel/TrustDialog — later.

---

## 7. Open risks

- **`multipart/signed` byte-exactness** — the signed content must include the trailing CRLF; getting this wrong → signature fails to verify in Thunderbird. Mitigated by the §5 automated verify-over-part-1-bytes test (catches it locally) + the Task 0 spike.
- **`mail-builder` 0.4 `multipart/signed` support** — may not expose the `protocol`/`micalg` params or guarantee byte-stable part content. Fallback: manual construction (Task 0 decides).
- **Self-signed signer certs** → Thunderbird reports "untrusted signer" (expected for `generate_key`-produced certs; a real CA cert is a user setup, not a 4a concern).
- **Encrypt-only to a recipient with no imported cert** → fail-closed error surfaces to the user via the existing `sync:send-result` failure path; KeyAssistant routing to help them import arrives in 4b.
