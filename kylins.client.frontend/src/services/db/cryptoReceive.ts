// Typed Tauri invoke wrappers for the S/MIME receive pipeline (G5 backend).
// Mirrors the `cryptoKeys.ts` / `messageBodies.ts` pattern: each function
// delegates to a Rust command and forwards the camelCase arg shape that Tauri
// auto-converts to the snake_case `#[tauri::command]` parameter names.
//
// SERDE WIRE CONTRACT (verified against the Rust sources — see task report):
//   - `OpenCryptoResult`        → camelCase (`crypto.rs:263` has `rename_all = "camelCase"`)
//   - `ImapAttachment`          → snake_case (`mail/imap/types.rs:69` has NO rename_all)
//   - `MessageCryptoResultRow`  → camelCase (`db/message_crypto_results.rs:22`)
//   - `TrustDecisionInput`      → camelCase (`db/commands.rs:1158`, used by db_put_trust_decision)
//   - `TrustDecisionRow`        → camelCase (`db/trust_decisions.rs:14`)
//
// CRITICAL: the previous task brief claimed `OpenCryptoResult` was snake_case
// on the wire. That is incorrect — `OpenCryptoResult` carries
// `#[serde(rename_all = "camelCase")]`, so the wire keys are `plaintextHtml`,
// `plaintextText`, `cryptoResult`. The nested `attachments: Vec<ImapAttachment>`
// array elements ARE snake_case (ImapAttachment has no rename_all). The test
// at the bottom of the sibling test file pins both halves of this contract.
//
// Plaintext fields (`plaintextHtml`, `plaintextText`) cross IPC correctly but
// are IN-MEMORY ONLY — the backend never persists them; the G6 UI renders and
// (optionally) caches them in the session `decryptedCache` on viewStore.

import { invoke } from '@tauri-apps/api/core';

// ──────────────────────────────────────────────────────────────────────────
// Result types
// ──────────────────────────────────────────────────────────────────────────

/**
 * Mirrors Rust `MessageCryptoResultRow`
 * (`kylins.client.backend/src/db/message_crypto_results.rs:23`, camelCase via
 * `#[serde(rename_all = "camelCase")]`). One row per opened crypto message;
 * the latest verification outcome for `(accountId, messageId)`.
 *
 * The string-literal union types are narrower than the Rust side (which uses
 * `String` to mirror the migration CHECK constraints). They document the only
 * legal values; a row from a well-formed backend always fits.
 */
export interface MessageCryptoResult {
  accountId: string;
  messageId: string;
  /** `'encrypted' | 'signed' | 'encrypted-signed'`. */
  cryptoKind: string;
  /** `'ok' | 'no-key' | 'failed' | 'n/a'`. */
  decryptState: string;
  /** `'not-signed' | 'valid-verified' | 'valid-unverified' | 'invalid' |
   *  `'unknown-key' | 'mismatch'`. */
  signatureState: string;
  signerFingerprint?: string | null;
  signerEmail?: string | null;
  /** `1` / `0` / `null` (unchecked) — SQLite INTEGER column. */
  chainValid?: number | null;
  /** `'good' | 'revoked' | 'unchecked'`. */
  revocationState: string;
  /** Epoch-seconds string (SQLite `strftime('%s','now')` output). */
  verifiedAt: string;
}

/**
 * Mirrors Rust `ImapAttachment`
 * (`kylins.client.backend/src/mail/imap/types.rs:69`). SNAKE_CASE on the wire
 * because the struct has NO `rename_all` attribute. Pinned by the test.
 */
export interface ImapAttachment {
  part_id: string;
  filename: string;
  mime_type: string;
  size: number;
  content_id?: string | null;
  is_inline: boolean;
}

/**
 * Mirrors Rust `OpenCryptoResult`
 * (`kylins.client.backend/src/mail/crypto.rs:264`). CAMELCASE on the wire
 * (the struct carries `#[serde(rename_all = "camelCase")]`).
 *
 * Plaintext fields are in-memory only — the backend never persists them. The
 * G6 UI may cache them in the session `decryptedCache` (viewStore); they must
 * never be written to disk.
 */
export interface OpenCryptoResult {
  plaintextHtml: string | null;
  plaintextText: string | null;
  /** Attachment metadata parsed from the decrypted MIME — snake_case per
   *  `ImapAttachment` (no `rename_all`). */
  attachments: ImapAttachment[];
  /** Persisted verification outcome (camelCase per `MessageCryptoResultRow`). */
  cryptoResult: MessageCryptoResult;
}

// ──────────────────────────────────────────────────────────────────────────
// Trust decision types
// ──────────────────────────────────────────────────────────────────────────

/**
 * Mirrors Rust `TrustDecisionInput`
 * (`kylins.client.backend/src/db/commands.rs:1159`, camelCase via
 * `#[serde(rename_all = "camelCase")]`). Used as the single `input` arg to
 * `db_put_trust_decision`. The append-only INSERT writes a fresh audit row;
 * the latest decision for a key is resolved by `decided_at DESC, id DESC`.
 */
export interface TrustDecisionInput {
  accountId: string;
  peerEmail: string;
  /** Always `'smime'` in Phase 1b (PGP/SM2 lands in later phases). */
  standard: 'smime';
  fingerprint: string;
  /** `'rejected' | 'undecided' | 'unverified' | 'verified' | 'personal'`. */
  decision: 'rejected' | 'undecided' | 'unverified' | 'verified' | 'personal';
  /** Optional opaque JSON blob (e.g. chain/revocation evidence snapshot). */
  evidenceJson?: string | null;
}

/**
 * Mirrors Rust `TrustDecisionRow`
 * (`kylins.client.backend/src/db/trust_decisions.rs:15`, camelCase). The
 * `standard` / `decision` fields are typed `string` (not union) to match the
 * Rust row — past rows may include values the current union doesn't cover.
 */
export interface TrustDecision {
  id: number;
  accountId: string;
  peerEmail: string;
  standard: string;
  fingerprint: string;
  decision: string;
  evidenceJson?: string | null;
  /** Epoch-seconds string (SQLite `strftime('%s','now')` output). */
  decidedAt: string;
}

// ──────────────────────────────────────────────────────────────────────────
// Wrappers
// ──────────────────────────────────────────────────────────────────────────

/**
 * Open (decrypt + verify) a crypto-marked message. Returns the in-memory
 * plaintext (html / text / attachment metadata) + the persisted verification
 * outcome (`cryptoResult`). The backend also emits `sync:crypto-result` after
 * the orchestrator runs so the G6 UI can refresh crypto badges without
 * re-decrypting. Plaintext is IN-MEMORY ONLY — never persisted by the backend.
 */
export function openCryptoMessage(accountId: string, messageId: string): Promise<OpenCryptoResult> {
  return invoke<OpenCryptoResult>('crypto_open_message', { accountId, messageId });
}

/**
 * Read the persisted `message_crypto_results` row for `(accountId, messageId)`,
 * or `null` if the message has never been opened/verified. Used by the list
 * view to render crypto badges without triggering a full decrypt.
 */
export function getMessageCryptoResult(
  accountId: string,
  messageId: string,
): Promise<MessageCryptoResult | null> {
  return invoke<MessageCryptoResult | null>('db_get_message_crypto_result', {
    accountId,
    messageId,
  });
}

/**
 * Append a trust decision (INSERT only — the audit history is never mutated).
 * Matches the Rust command signature
 * `db_put_trust_decision(input: TrustDecisionInput)` — the wrapper forwards
 * the entire input as a single `input` arg (Tauri then deserializes its
 * camelCase fields into the Rust struct via `#[serde(rename_all =
 * "camelCase")]`).
 */
export function putTrustDecision(input: TrustDecisionInput): Promise<void> {
  return invoke<void>('db_put_trust_decision', { input });
}

/**
 * Read the latest trust decision for a peer key, or `null`. The 4 args match
 * the positional Rust command parameters
 * `db_get_trust_decision(account_id, peer_email, standard, fingerprint)`.
 */
export function getTrustDecision(
  accountId: string,
  peerEmail: string,
  standard: string,
  fingerprint: string,
): Promise<TrustDecision | null> {
  return invoke<TrustDecision | null>('db_get_trust_decision', {
    accountId,
    peerEmail,
    standard,
    fingerprint,
  });
}
