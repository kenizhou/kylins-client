# Kylins Client — Crypto: Persist + Use `.p12` Chain Intermediates

> **Status:** Approved (2026-07-18). Closes the `.p12` carry-forward "intermediate/root
> certs in the chain (leaf identity only is imported)" from the Plan 3 ledger.
> Strict SDD (spec → plan → implementer subagent → controller review → ledger).
> **Parent:** `docs/superpowers/specs/2026-07-18-crypto-pkcs12-import-design.md` (Plan 3).
> **Crate:** `kylins.client.crypto/smime` + backend `db/crypto_keys.rs` + `mail/crypto.rs`.

## Goal

When a user imports a `.p12`/`.pfx` that contains a leaf cert + intermediate(s)
(the normal CA-issued bundle), **persist the intermediates** and **feed them to
the receive cert-chain validator** so a chain requiring a stored intermediate
validates without the sender having to embed it in every SignedData. Today the
intermediates are dropped at import (`import_p12` reads only `private_key_chain()`
+ `certs()[0]`), so a corporate-PKI chain that needs the intermediate fails
unless the sender embedded it.

## Background (verified)

- `SmimeBackend::import_p12` (smime/src/lib.rs) calls `p12_keystore::KeyStore::from_pkcs12`,
  reads `private_key_chain()` (the key + its leaf cert) + `certs()[0]`, persists
  the leaf via `persist_imported`. **All other certs in the bag are dropped.**
- Receive path `run_verify_path` (mail/crypto.rs:567) resolves intermediates
  from the **SignedData certificates set** only (`extract_intermediates`) and
  anchors from `list_trust_anchor_certs` (every `key_type='cert'` row). It does
  NOT consult `crypto_keys` for stored intermediates.
- `crypto_keys.key_type` is a free `TEXT` column (no enum constraint) — values
  today: `'cert'` (trust anchors + the G4 "corporate-PKI landmine" candidate-anchor
  set) and `'private'`-ish (signing keys, though `keystore_bridge::put` hardcodes
  `'cert'` for all — a known quirk). A new `'intermediate'` value needs **no
  migration** (TEXT column).
- `list_trust_anchor_certs` (db/crypto_keys.rs:306) filters `key_type='cert'` →
  a new `list_intermediate_certs` filters `key_type='intermediate'` (mirror).

## Decision log (locked)

| # | Decision | Choice |
|---|---|---|
| 1 | intermediate storage | New `key_type='intermediate'` rows in `crypto_keys` (cert-only: `public_data` = DER, NO `private_data`). **NOT** `key_type='cert'` — intermediates are NOT trust anchors; widening the G4 "every cert is a candidate anchor" landmine would be a trust overreach (an intermediate must not be treated as a root). |
| 2 | which certs to persist | Every cert in the `.p12` bag EXCEPT the leaf (the one paired with the private key). Dedup by fingerprint (SHA-1-of-SPKI, the existing `Fingerprint` method) so a re-import doesn't double-insert + so a cert that's both in the bag and already an anchor/intermediate isn't duplicated. |
| 3 | account scope | Per-account (`account_id`), matching the existing anchor model. Cross-account intermediates are NOT shared (acceptable; matches anchors). |
| 4 | receive-path merge | `run_verify_path` loads the account's stored intermediates (`list_intermediate_certs`) + concatenates with the SignedData intermediates → `verify_with_context(intermediate_ders = signed_data_intermediates ++ stored_intermediates)`. Dedup by fingerprint (a cert in both sets is passed once). |
| 5 | send side | OUT of scope. `validate_recipient_certs` (apply_crypto) keeps `intermediates_der=&[]` (recipient certs chain directly to a configured anchor in practice). Carry-forward. |
| 6 | KeyManager UI | The intermediates are NOT shown in the KeyManager "Your S/MIME Keys" list (that's identities). They're infra. A future "Trusted CAs / intermediates" view could list them; out of scope here. |

## Scope

**In:**
- `crypto-smime` `import_p12`: enumerate ALL certs from the bag, identify the
  leaf (matches the private key), persist the rest as `key_type='intermediate'`
  via a new `persist_intermediate(cert_der)` helper (fingerprint-dedup; cert-only
  `StoredKey` with `private_data=None`; `KeyUsage::VerifyOnly` or similar; reuses
  `algorithm_label`).
- backend `db/crypto_keys.rs`: `list_intermediate_certs(account_id) -> Vec<Vec<u8>>`
  (mirrors `list_trust_anchor_certs`; filters `key_type='intermediate'`).
- backend `mail/crypto.rs::run_verify_path`: load stored intermediates, dedup
  with SignedData intermediates by fingerprint, pass the merged set to
  `verify_with_context`.

**Out (carry-forwards):** send-side intermediate resolution; KeyManager UI for
intermediates; cross-account intermediate sharing; CRL for stored intermediates
(the CRL fetch already runs over signer + SignedData intermediates — extend to
stored intermediates in a follow-up if needed).

## Data

**No migration** (`key_type` is TEXT). New rows: `crypto_keys` with
`key_type='intermediate'`, `public_data` = cert DER (hex via the existing
`upsert_crypto_key` path), `private_data_enc = NULL`, `is_default_sign=0`,
`is_default_encrypt=0`, `origin='p12-intermediate'`. The `account_id` FK +
`(account_id, standard, fingerprint)` uniqueness (enforced by `upsert_crypto_key`'s
`ON CONFLICT`) gives idempotent re-import.

## Failure modes

- A bag with only a leaf (no intermediates) → no intermediate rows written (the
  common self-signed/generated case; no regression).
- An intermediate that fails to parse → `Malformed` (skip the whole import? or
  skip just that cert?). Decision: skip JUST that cert with a `log::warn!` +
  continue (a single bad intermediate shouldn't block the leaf import); the leaf
  + any good intermediates still land.
- `list_intermediate_certs` DB error → `run_verify_path` soft-fails (logs +
  proceeds with SignedData intermediates only); never blocks message open.

## Security

- Intermediates are public certs (no private material) — `private_data=None`.
  Persisting them is safe (they're shipped in the `.p12` / in SignedData anyway).
- **Critical:** intermediates must NOT be added to the trust-anchor set
  (`key_type='cert'`). An intermediate as an anchor would let any cert it signs
  validate as "trusted" — a trust overreach. `key_type='intermediate'` keeps them
  out of `list_trust_anchor_certs` (which filters `='cert'`).
- The merged intermediate set feeds `verify_with_context(intermediate_ders)` —
  pkix-path STILL requires the chain to terminate at a real trust anchor; extra
  intermediates only help build the path, they don't replace the anchor check.
  No trust weakening.

## Performance

- Import: one extra cert-parse + upsert per intermediate (ms-scale; one-shot).
- Receive: `list_intermediate_certs` is one indexed SELECT per message-open
  (cheap; the receive path already runs several such queries). The merged set is
  small (corporate PKIs have 1-3 intermediates).

## Tests (TDD — implementer subagent)

crypto-smime (`smime/src/lib.rs` tests):
1. `import_p12_persists_intermediate_certs` — build a `.p12` with leaf + 1-2
   intermediate certs (in-test via `p12-keystore` builder or a hand-rolled PFX)
   → import → assert the StubKeyStore holds the leaf (private) + each
   intermediate (cert-only, no private).
2. `import_p12_dedups_intermediates_by_fingerprint` — import the same `.p12`
   twice → intermediates not duplicated.
3. `import_p12_bag_with_only_leaf_writes_no_intermediates` — regression guard.

backend (`db/crypto_keys.rs` + `mail/crypto.rs` tests):
4. `list_intermediate_certs_returns_only_intermediate_rows` — seed leaf
   (`key_type='cert'`/private) + intermediate (`key_type='intermediate'`) + an
   unrelated account's intermediate → assert only this account's intermediate
   returned.
5. `run_verify_path_uses_stored_intermediates` — a SignedData whose chain needs
   an intermediate that is NOT in the SignedData cert set BUT is stored →
   validates (previously failed). (Integration test; mirror the existing
   `crypto_smime_lifecycle` harness.)

## Gates

crypto-smime `cargo test` + `cargo clippy --all-targets -D warnings`; backend
`cargo test --lib` + clippy (the new code must not add to the pre-existing imap
clippy debt).

## Open questions

- `p12_keystore`'s exact API for enumerating ALL certs in the bag (vs just
  `certs()[0]`) — resolve at implementation start (`KeyStore::certs()` returns
  the chain; the leaf is identifiable as the cert whose SPKI matches the private
  key, or simply `certs()[0]` is the leaf and the rest are intermediates per
  PFX convention — verify).
