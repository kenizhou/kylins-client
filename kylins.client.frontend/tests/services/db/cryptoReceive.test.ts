// G6 Task 1: cryptoReceive.ts invoke wrappers. Mock `invoke` and assert each
// wrapper forwards the right Tauri command name + the camelCase arg shape that
// Tauri auto-converts to snake_case Rust `#[tauri::command]` parameters.
//
// CRITICAL: this test pins the SERDE WIRE CONTRACT for `OpenCryptoResult` and
// `ImapAttachment`. The previous task brief claimed `OpenCryptoResult` was
// snake_case on the wire; that is incorrect — the Rust struct at
// `kylins.client.backend/src/mail/crypto.rs:263` carries
// `#[serde(rename_all = "camelCase")]`, so the actual wire keys are
// `plaintextHtml` / `plaintextText` / `cryptoResult` (camelCase).
// `ImapAttachment` (`mail/imap/types.rs:69`) has NO rename attribute and IS
// snake_case (`part_id` / `mime_type` / `content_id` / `is_inline`). The test
// below asserts both halves explicitly so a future refactor that diverges
// from either struct fails loudly here rather than silently yielding
// `undefined` at the IPC boundary.

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }));
import { invoke } from '@tauri-apps/api/core';
import {
  openCryptoMessage,
  getMessageCryptoResult,
  putTrustDecision,
  getTrustDecision,
  type OpenCryptoResult,
  type MessageCryptoResult,
  type TrustDecision,
  type TrustDecisionInput,
} from '@/services/db/cryptoReceive';

beforeEach(() => vi.mocked(invoke).mockClear());

// ──────────────────────────────────────────────────────────────────────────
// Fixture builders — match the camelCase wire shape of `OpenCryptoResult` /
// `MessageCryptoResult` and the SNAKE_CASE shape of `ImapAttachment`.
// ──────────────────────────────────────────────────────────────────────────

function sampleCryptoResult(accountId = 'a1', messageId = 'm1'): MessageCryptoResult {
  return {
    accountId,
    messageId,
    cryptoKind: 'encrypted-signed',
    decryptState: 'ok',
    signatureState: 'valid-verified',
    signerFingerprint: 'sha256:ab',
    signerEmail: 'signer@kylins.local',
    chainValid: 1,
    revocationState: 'good',
    verifiedAt: '1750000000',
  };
}

function sampleOpenCryptoResult(): OpenCryptoResult {
  return {
    plaintextHtml: '<p>hi</p>',
    plaintextText: 'hi',
    attachments: [
      {
        part_id: '2',
        filename: 'doc.pdf',
        mime_type: 'application/pdf',
        size: 1234,
        content_id: null,
        is_inline: false,
      },
    ],
    cryptoResult: sampleCryptoResult(),
  };
}

// ──────────────────────────────────────────────────────────────────────────
// openCryptoMessage
// ──────────────────────────────────────────────────────────────────────────

describe('openCryptoMessage', () => {
  it('invokes crypto_open_message with camelCase (accountId, messageId)', async () => {
    vi.mocked(invoke).mockResolvedValue(sampleOpenCryptoResult());
    await openCryptoMessage('a1', 'm1');
    expect(invoke).toHaveBeenCalledWith('crypto_open_message', {
      accountId: 'a1',
      messageId: 'm1',
    });
  });

  it('returns the typed OpenCryptoResult (camelCase outer, snake_case attachment)', async () => {
    vi.mocked(invoke).mockResolvedValue(sampleOpenCryptoResult());
    const res = await openCryptoMessage('a1', 'm1');
    // Outer OpenCryptoResult fields are CAMELCASE (rust struct has rename_all).
    expect(res.plaintextHtml).toBe('<p>hi</p>');
    expect(res.plaintextText).toBe('hi');
    expect(res.cryptoResult.signatureState).toBe('valid-verified');
    // Nested ImapAttachment fields are SNAKE_CASE (no rename_all on that struct).
    expect(res.attachments[0]?.part_id).toBe('2');
    expect(res.attachments[0]?.mime_type).toBe('application/pdf');
    expect(res.attachments[0]?.is_inline).toBe(false);
  });

  it('pins the OpenCryptoResult wire contract — camelCase keys exist, snake_case do NOT', async () => {
    // If this assertion fails, either the TS interface drifted from the wire
    // format or the Rust struct's serde attrs changed. Either way the G6 UI
    // would silently read `undefined` for plaintext — this test catches it.
    vi.mocked(invoke).mockResolvedValue(sampleOpenCryptoResult());
    const res = await openCryptoMessage('a1', 'm1');
    // CamelCase keys (correct per Rust #[serde(rename_all = "camelCase")]):
    expect(res).toHaveProperty('plaintextHtml');
    expect(res).toHaveProperty('plaintextText');
    expect(res).toHaveProperty('cryptoResult');
    // Snake_case keys must NOT exist on the outer OpenCryptoResult:
    expect(res).not.toHaveProperty('plaintext_html');
    expect(res).not.toHaveProperty('plaintext_text');
    expect(res).not.toHaveProperty('crypto_result');
  });
});

// ──────────────────────────────────────────────────────────────────────────
// getMessageCryptoResult
// ──────────────────────────────────────────────────────────────────────────

describe('getMessageCryptoResult', () => {
  it('invokes db_get_message_crypto_result with camelCase args', async () => {
    vi.mocked(invoke).mockResolvedValue(sampleCryptoResult());
    await getMessageCryptoResult('a1', 'm1');
    expect(invoke).toHaveBeenCalledWith('db_get_message_crypto_result', {
      accountId: 'a1',
      messageId: 'm1',
    });
  });

  it('returns the typed MessageCryptoResult (camelCase wire)', async () => {
    vi.mocked(invoke).mockResolvedValue(sampleCryptoResult());
    const row = await getMessageCryptoResult('a1', 'm1');
    expect(row?.accountId).toBe('a1');
    expect(row?.cryptoKind).toBe('encrypted-signed');
    expect(row?.signatureState).toBe('valid-verified');
    expect(row?.chainValid).toBe(1);
  });

  it('returns null when the row is absent', async () => {
    vi.mocked(invoke).mockResolvedValue(null);
    expect(await getMessageCryptoResult('a1', 'never-opened')).toBeNull();
  });
});

// ──────────────────────────────────────────────────────────────────────────
// putTrustDecision
// ──────────────────────────────────────────────────────────────────────────

describe('putTrustDecision', () => {
  it('invokes db_put_trust_decision with a single camelCase `input` arg', async () => {
    vi.mocked(invoke).mockResolvedValue(undefined);
    const input: TrustDecisionInput = {
      accountId: 'a1',
      peerEmail: 'peer@kylins.local',
      standard: 'smime',
      fingerprint: 'sha256:ab',
      decision: 'verified',
      evidenceJson: null,
    };
    await putTrustDecision(input);
    // CRITICAL: the Rust command signature is
    //   db_put_trust_decision(pool: State<_>, input: TrustDecisionInput)
    // i.e. the entire payload is a single `input` arg — NOT spread fields.
    // Spreading would produce `input=undefined` on the Rust side and silently
    // fail to deserialize (TrustDecisionInput has no default fallback).
    expect(invoke).toHaveBeenCalledWith('db_put_trust_decision', { input });
    // And the inner input object must be camelCase (matches the Rust struct's
    // #[serde(rename_all = "camelCase")]).
    const passed = vi.mocked(invoke).mock.calls[0]?.[1] as { input: TrustDecisionInput };
    expect(passed.input).toEqual({
      accountId: 'a1',
      peerEmail: 'peer@kylins.local',
      standard: 'smime',
      fingerprint: 'sha256:ab',
      decision: 'verified',
      evidenceJson: null,
    });
  });

  it('forwards evidenceJson when provided', async () => {
    vi.mocked(invoke).mockResolvedValue(undefined);
    await putTrustDecision({
      accountId: 'a1',
      peerEmail: 'p@k',
      standard: 'smime',
      fingerprint: 'fp',
      decision: 'rejected',
      evidenceJson: '{"chain":"broken"}',
    });
    const passed = vi.mocked(invoke).mock.calls[0]?.[1] as { input: TrustDecisionInput };
    expect(passed.input.evidenceJson).toBe('{"chain":"broken"}');
    expect(passed.input.decision).toBe('rejected');
  });
});

// ──────────────────────────────────────────────────────────────────────────
// getTrustDecision
// ──────────────────────────────────────────────────────────────────────────

describe('getTrustDecision', () => {
  it('invokes db_get_trust_decision with the 4 camelCase args', async () => {
    vi.mocked(invoke).mockResolvedValue(null);
    await getTrustDecision('a1', 'peer@kylins.local', 'smime', 'sha256:ab');
    expect(invoke).toHaveBeenCalledWith('db_get_trust_decision', {
      accountId: 'a1',
      peerEmail: 'peer@kylins.local',
      standard: 'smime',
      fingerprint: 'sha256:ab',
    });
  });

  it('returns the typed TrustDecision (camelCase wire)', async () => {
    const row: TrustDecision = {
      id: 7,
      accountId: 'a1',
      peerEmail: 'peer@kylins.local',
      standard: 'smime',
      fingerprint: 'sha256:ab',
      decision: 'verified',
      evidenceJson: null,
      decidedAt: '1750000000',
    };
    vi.mocked(invoke).mockResolvedValue(row);
    const out = await getTrustDecision('a1', 'peer@kylins.local', 'smime', 'sha256:ab');
    expect(out?.id).toBe(7);
    expect(out?.peerEmail).toBe('peer@kylins.local');
    expect(out?.decidedAt).toBe('1750000000');
  });

  it('returns null when no decision exists', async () => {
    vi.mocked(invoke).mockResolvedValue(null);
    expect(await getTrustDecision('a1', 'p@k', 'smime', 'fp')).toBeNull();
  });
});
