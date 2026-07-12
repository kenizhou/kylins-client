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

/** Import a key/cert from a local file path. Returns the resulting row. */
export function importKeyFromPath(accountId: string, path: string): Promise<CryptoKeyRow> {
  return invoke<CryptoKeyRow>('crypto_import_key_from_path', { accountId, path });
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
