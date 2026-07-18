# Plan — Persist + Use `.p12` Chain Intermediates

> Spec: `docs/superpowers/specs/2026-07-18-crypto-pkcs12-intermediates-design.md`.
> Strict SDD. Branch `fix/smime-receive-and-sign-details` (off `120ea4d`). UNCOMMITTED.

## Task 1 — `crypto-smime`: persist intermediates in `import_p12`

**Files:** `kylins.client.crypto/smime/src/lib.rs`.

1. RED: `import_p12_persists_intermediate_certs` — build a `.p12` with leaf + 1-2
   intermediates → import → StubKeyStore holds leaf (private) + each intermediate
   (cert-only).
2. RED: `import_p12_dedups_intermediates_by_fingerprint` — import twice → no dup.
3. RED: `import_p12_bag_with_only_leaf_writes_no_intermediates`.
4. GREEN: enumerate ALL certs from the bag (`p12_keystore::KeyStore::certs()` or
   equivalent); the leaf is the one paired with `private_key_chain()` (match by
   SPKI/fingerprint); persist each NON-leaf cert via a new `persist_intermediate(
   cert_der)` helper — cert-only `StoredKey` (`private_data=None`), fingerprint
   via the existing SKI method (dedup via the keystore's `ON CONFLICT`), reuses
   `algorithm_label`. Skip a cert that fails to parse with `log::warn!` + continue.

**Gates:** `cargo test -p crypto-smime` + `cargo clippy --all-targets -D warnings`.

## Task 2 — backend: `list_intermediate_certs` query

**Files:** `kylins.client.backend/src/db/crypto_keys.rs`.

1. RED: `list_intermediate_certs_returns_only_intermediate_rows` — seed leaf +
   intermediate + another account's intermediate → assert correct subset.
2. GREEN: `list_intermediate_certs(pool, account_id) -> Vec<Vec<u8>>` mirroring
   `list_trust_anchor_certs` but filtering `key_type='intermediate'`; hex-decode
   `public_data` → cert DER; soft-skip undecodable rows.

**Gates:** `cargo test --lib`.

## Task 3 — backend: `run_verify_path` merges stored intermediates

**Files:** `kylins.client.backend/src/mail/crypto.rs`.

1. RED: `run_verify_path_uses_stored_intermediates` — a SignedData whose chain
   needs an intermediate NOT in its cert set BUT stored as `key_type='intermediate'`
   → validates (previously failed). Mirror the existing `crypto_smime_lifecycle`
   harness.
2. GREEN: in `run_verify_path`, after `extract_intermediates(signed_data)`, also
   `list_intermediate_certs(pool, account_id)`, dedup the union by fingerprint
   (SHA-1-of-SPKI hex; reuse the existing `fingerprint_of_spki` / a shared helper),
   pass the merged `intermediate_ders` to `verify_with_context`. Soft-fail on the
   query error (log + SignedData-intermediates-only).

**Gates:** `cargo test --lib` + `cargo clippy` (no new issues; the pre-existing
imap clippy debt is out of scope).

## Task 4 — Final gates + controller review + ledger

1. All gates green. Manual e2e (import a real CA `.p12` with a chain → receive a
   message whose chain needs that intermediate) left to the user.
2. Dispatch `feature-dev:code-reviewer` on the diff (correctness/security focus:
   intermediates must NOT join the anchor set; dedup correctness; soft-fail).
3. Append the SDD ledger entry.

## Carry-forwards

Send-side intermediate resolution; KeyManager UI listing for intermediates;
cross-account sharing; CRL fetch over stored intermediates.
