// Typed Tauri invoke wrappers for the crypto identity key commands. Mirrors
// the signatures.ts pattern: each function delegates to a Rust command and
// forwards camelCase args (Tauri auto-converts to the snake_case Rust params).
//
// `CryptoKeyRow` mirrors the Rust `CryptoKeyRow` in
// `kylins.client.backend/src/db/crypto_keys.rs` (serde camelCase). It is the
// PUBLIC-facing row — private key material never crosses the IPC boundary;
// only `hasPrivate: boolean` indicates whether a soft private blob exists
// at rest. Note: `createdAt` / `expiresAt` are strings (unix timestamps
// produced by SQLite `strftime('%s','now')`), matching the Rust
// `CryptoKeyRow { created_at: String, expires_at: Option<String> }`.

import { invoke } from '@tauri-apps/api/core';
import { readTextFile } from '@tauri-apps/plugin-fs';

/** Public-facing crypto key row (matches Rust `CryptoKeyRow`). */
export interface CryptoKeyRow {
  id: string;
  accountId: string;
  standard: string;
  keyType: string;
  email?: string | null;
  fingerprint: string;
  origin: string;
  isDefaultSign: boolean;
  isDefaultEncrypt: boolean;
  /** Unix timestamp as a string (SQLite strftime('%s','now') output). */
  createdAt: string;
  /** Unix timestamp as a string, or null when the key never expires. */
  expiresAt?: string | null;
  /** `true` when a soft private blob exists at rest (never exposes the blob). */
  hasPrivate: boolean;
  tokenSerial?: string | null;
  tokenKeyId?: string | null;
}

/** List public-facing key rows for an account + standard. */
export function listCryptoKeysForAccount(
  accountId: string,
  standard: string,
): Promise<CryptoKeyRow[]> {
  return invoke<CryptoKeyRow[]>('db_list_crypto_keys_for_account', { accountId, standard });
}

/** Fetch a single key row by `(standard, fingerprint)`, or null if missing. */
export function getCryptoKey(standard: string, fingerprint: string): Promise<CryptoKeyRow | null> {
  return invoke<CryptoKeyRow | null>('db_get_crypto_key', { standard, fingerprint });
}

/** Generate a fresh soft key/cert for `(accountId, email)`. Returns the new row. */
export function generateKey(accountId: string, email: string): Promise<CryptoKeyRow> {
  return invoke<CryptoKeyRow>('crypto_generate_key', { accountId, email });
}

/**
 * Import a key/cert from a local file path. Returns the resulting row.
 *
 * `passphrase` is forwarded to the Rust `crypto_import_key_from_path`
 * command (camelCased). Pass a string for passphrase-protected bundles
 * (`.p12`/`.pfx`, encrypted-PKCS#8 PEM); omit it for unencrypted PEM
 * bundles. `undefined` deserializes to Rust `None` (Tauri IPC is local
 * same-process — the passphrase is wrapped in a zeroizing `SecretBox` at
 * the `import_key` boundary on the Rust side, never logged nor persisted).
 */
export function importKeyFromPath(
  accountId: string,
  path: string,
  passphrase?: string,
): Promise<CryptoKeyRow> {
  return invoke<CryptoKeyRow>('crypto_import_key_from_path', {
    accountId,
    path,
    passphrase,
  });
}

/** Export the public half of a key to `outPath`. */
export function exportPublicToPath(
  accountId: string,
  standard: string,
  fingerprint: string,
  outPath: string,
): Promise<void> {
  return invoke<void>('crypto_export_public_to_path', {
    accountId,
    standard,
    fingerprint,
    outPath,
  });
}

/**
 * Export an S/MIME identity (cert + private key + the account's stored
 * intermediates) as a passphrase-protected `.p12`/`.pfx` to `outPath`. The
 * export mirror of [`importKeyFromPath`] (Plan 3b).
 *
 * `passphrase` is REQUIRED non-empty on the Rust side (an empty string or
 * `undefined` is refused with `Policy("p12 export requires a non-empty
 * passphrase")`). Wrap it in a confirm-passphrase prompt at the call site
 * (the standard "create a password that protects a key" UX) — the user's
 * chosen passphrase encrypts the PFX before it touches disk. The passphrase
 * is forwarded to the Rust `crypto_export_p12_to_path` command (camelCased)
 * and wrapped in a zeroizing `SecretBox` at the IPC boundary on the Rust side
 * (never logged nor persisted beyond the written file, which is itself
 * passphrase-encrypted).
 */
export function exportP12ToPath(
  accountId: string,
  standard: string,
  fingerprint: string,
  passphrase: string,
  outPath: string,
): Promise<void> {
  return invoke<void>('crypto_export_p12_to_path', {
    accountId,
    standard,
    fingerprint,
    passphrase,
    outPath,
  });
}

/** Delete a key by `(accountId, standard, fingerprint)`. Idempotent. */
export function deleteCryptoKey(
  accountId: string,
  standard: string,
  fingerprint: string,
): Promise<void> {
  return invoke<void>('db_delete_crypto_key', { accountId, standard, fingerprint });
}

/**
 * Atomically set the default signing key for `(accountId, standard)`:
 * un-flags any prior default, then flags the chosen fingerprint. Errors if
 * the target row does not exist (tx rolls back, prior default left intact).
 */
export function setDefaultSigningKey(
  accountId: string,
  standard: string,
  fingerprint: string,
): Promise<void> {
  return invoke<void>('db_set_default_signing_key', { accountId, standard, fingerprint });
}

// ──────────────────────────────────────────────────────────────────────────
// Trusted CA-root import path (G6 Task 6)
// ──────────────────────────────────────────────────────────────────────────
//
// CA-root trust anchors are stored as `crypto_keys` rows with
// `standard='smime'` AND `key_type='cert'`. G5's `list_trust_anchor_certs`
// (db/crypto_keys.rs:306) reads exactly that slice and feeds the DER bytes
// to the chain validator (`SmimeBackend::verify_with_context`).
//
// The existing `crypto_import_key_from_path` route is for cert+private-key
// BUNDLES (it calls `SmimeBackend::import_key`, which expects a signing
// identity). A CA root has no private key, so we use the lower-level
// `db_upsert_crypto_key` Tauri command and build the `CryptoKeyRecord` on
// the client. The cert DER is HEX-encoded into `publicData` to match the
// read path (`list_trust_anchor_certs` hex-decodes it back to DER).
//
// Wire shape: `db_upsert_crypto_key` takes a single `input: CryptoKeyRecord`
// arg. `CryptoKeyRecord` flattens `CryptoKeyRow` (camelCase via serde) +
// adds `publicData: String` (+ optional `privateData` / `policyJson`).
// `id: ''` + `createdAt: ''` cause the backend to generate a uuid + use
// `strftime('%s','now')` (see upsert_crypto_key at db/crypto_keys.rs:111).

/**
 * Input shape for `db_upsert_crypto_key`. Mirrors the Rust
 * `CryptoKeyRecord` (`db/crypto_keys.rs:62`, camelCase via serde + flattened
 * `CryptoKeyRow`). `id` / `createdAt` may be empty — the backend fills them.
 * `publicData` is HEX-encoded DER for cert rows; private blobs are encrypted
 * at rest by the db layer (never populated by the Trusted-CAs path).
 */
export interface CryptoKeyRecordInput {
  id?: string;
  accountId: string;
  standard: string;
  keyType: string;
  email?: string | null;
  fingerprint: string;
  origin: string;
  isDefaultSign?: boolean;
  isDefaultEncrypt?: boolean;
  createdAt?: string;
  expiresAt?: string | null;
  /** HEX-encoded DER (cert rows) or armored key material (PGP rows). */
  publicData: string;
  privateData?: string | null;
  policyJson?: string | null;
}

/**
 * Upsert a crypto key/cert row via the low-level `db_upsert_crypto_key`
 * command. Private material in `input.privateData` is encrypted at rest by
 * the db layer (never sent in plaintext across IPC AFTER the write — this
 * call IS the plaintext send; the backend wraps it before persisting).
 */
export function upsertCryptoKey(input: CryptoKeyRecordInput): Promise<void> {
  return invoke<void>('db_upsert_crypto_key', { input });
}

/**
 * Decode a PEM-encoded CERTIFICATE block to its raw DER bytes. Returns null
 * when no `-----BEGIN CERTIFICATE-----` block is present. Only the FIRST
 * block is decoded — multi-cert bundles (chains) use only the leaf here;
 * the user imports each anchor separately (matches the KeyManager pattern
 * where each row is one identity).
 */
export function pemCertificateToDer(pem: string): Uint8Array | null {
  const match = pem.match(/-----BEGIN CERTIFICATE-----\s*([\s\S]*?)-----END CERTIFICATE-----/);
  if (!match) return null;
  const b64 = match[1]!.replace(/\s+/g, '');
  if (!b64) return null;
  try {
    const binary = atob(b64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return bytes;
  } catch {
    return null;
  }
}

/** Hex-encode a Uint8Array (lowercase, no separators). */
export function bytesToHex(bytes: Uint8Array): string {
  let out = '';
  for (let i = 0; i < bytes.length; i++) {
    out += bytes[i]!.toString(16).padStart(2, '0');
  }
  return out;
}

/**
 * SHA-256(der) as a lowercase hex string. Uses the Web Crypto API
 * (`crypto.subtle.digest`), which is available in both the Tauri webview and
 * jsdom (Node ≥ 19). Mirrors the backend's `Sha256::digest(der)` fingerprint
 * computation so a cert imported here matches the fingerprint the G5
 * receive pipeline emits when verifying against this anchor.
 */
export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  // Copy into a fresh ArrayBuffer-backed view so the TS lib types accept it
  // as `BufferSource` (a `Uint8Array<ArrayBufferLike>` from a caller may be
  // backed by a `SharedArrayBuffer`, which `crypto.subtle.digest` rejects).
  const view = new Uint8Array(bytes);
  const digest = await crypto.subtle.digest('SHA-256', view);
  return bytesToHex(new Uint8Array(digest));
}

/**
 * Import a PEM-encoded CA-root certificate at `path` as a `crypto_keys` row
 * with `standard='smime'` + `key_type='cert'` (a trust anchor). The DER
 * bytes are HEX-encoded into `publicData` so G5's `list_trust_anchor_certs`
 * can hex-decode them back when feeding the chain validator. The fingerprint
 * is SHA-256(der) — computed client-side via the Web Crypto API.
 *
 * Throws when the file has no PEM CERTIFICATE block or the SHA-256 digest
 * is unavailable (older runtimes without `crypto.subtle`).
 */
export async function importTrustAnchorFromPath(accountId: string, path: string): Promise<void> {
  const pem = await readTextFile(path);
  const der = pemCertificateToDer(pem);
  if (!der) {
    throw new Error('No PEM CERTIFICATE block found in selected file');
  }
  const fingerprint = await sha256Hex(der);
  const publicData = bytesToHex(der);
  await upsertCryptoKey({
    id: '',
    accountId,
    standard: 'smime',
    keyType: 'cert',
    email: null,
    fingerprint,
    origin: 'imported',
    isDefaultSign: false,
    isDefaultEncrypt: false,
    createdAt: '',
    publicData,
  });
}
