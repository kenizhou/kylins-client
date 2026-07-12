// Verify `sendEmail` enqueues the IPC payload `{ type: 'send', draft }` and
// NOT the legacy `{ type: 'send', rawBase64url }`. This is the regression
// guard for the T7 cutover: the backend's `MutationOp::Send { draft }`
// expects the structured shape; if we regress, sending is broken silently
// (the invoke rejects with a deserialization error).
//
// T7b: sendEmail no longer deletes the persisted draft row — that's the
// composer's responsibility (the row id is distinct from the staging id).
// Tests updated accordingly.
//
// Tauri fs/path APIs are mocked so `buildSendDraft` can stage files without a
// runtime. `accountStore` is mocked to provide a fallback `from` address.

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { sendEmail, SEND_COMPLETE_EVENT } from '../../../src/services/composer/send';
import type { DraftInput } from '../../../src/services/composer/drafts';

// --- Mocks ---------------------------------------------------------------

const { mockInvoke, mockEmit } = vi.hoisted(() => ({ mockInvoke: vi.fn(), mockEmit: vi.fn() }));
vi.mock('@tauri-apps/api/core', () => ({ invoke: mockInvoke }));
vi.mock('@tauri-apps/api/event', () => ({ emit: mockEmit }));

vi.mock('@tauri-apps/api/path', () => ({
  appDataDir: async () => '/appdata',
  join: async (...parts: string[]) => parts.join('/').replace(/\/+/g, '/'),
}));

vi.mock('@tauri-apps/plugin-fs', () => ({
  mkdir: async () => undefined,
  writeFile: async () => undefined,
  copyFile: async () => undefined,
  exists: async () => false,
  remove: async () => undefined,
}));

vi.mock('@/stores/accountStore', () => ({
  useAccountStore: {
    getState: () => ({
      accounts: [{ id: 'acc-1', email: 'alice@example.com' }],
    }),
  },
}));

beforeEach(() => {
  mockInvoke.mockReset();
  mockInvoke.mockResolvedValue(undefined);
  mockEmit.mockReset();
  mockEmit.mockResolvedValue(undefined);
});

// --- Fixtures ------------------------------------------------------------

const baseInput: DraftInput = {
  accountId: 'acc-1',
  to: [{ name: 'bob@example.com', email: 'bob@example.com' }],
  subject: 'Hi',
  bodyHtml: '<p>Body</p>',
  fromEmail: 'alice@example.com',
};

// --- Tests ---------------------------------------------------------------

describe('composer/send', () => {
  it('invokes sync_apply_mutation with { type:"send", draft }', async () => {
    const res = await sendEmail('acc-1', baseInput, 'draft-1');
    expect(res.success).toBe(true);
    // sendEmail now also upserts the outgoing recipient as a mail-source
    // contact so autocomplete sees it before the Sent folder syncs back.
    expect(mockInvoke).toHaveBeenCalledTimes(3);
    const [cmd, payload] = mockInvoke.mock.calls[0]!;
    expect(cmd).toBe('sync_apply_mutation');
    expect(payload).toEqual({
      accountId: 'acc-1',
      op: {
        type: 'send',
        draft: expect.objectContaining({
          draftId: 'draft-1',
          from: { email: 'alice@example.com' },
          to: [{ email: 'bob@example.com' }],
          subject: 'Hi',
          htmlBody: '<p>Body</p>',
        }),
      },
    });
    // Regression: the legacy rawBase64url field is NOT present.
    expect(JSON.stringify(mockInvoke.mock.calls[0])).not.toContain('rawBase64url');

    const [settingCmd, settingPayload] = mockInvoke.mock.calls[1]!;
    expect(settingCmd).toBe('db_get_setting_bool');
    expect(settingPayload).toEqual({ key: 'auto_extract_contacts_from_mail' });

    const [upsertCmd, upsertPayload] = mockInvoke.mock.calls[2]!;
    expect(upsertCmd).toBe('db_upsert_contact');
    expect(upsertPayload).toEqual({
      email: 'bob@example.com',
      displayName: null,
    });
  });

  it('returns success:false + keeps message when invoke rejects', async () => {
    mockInvoke.mockReset();
    mockInvoke.mockRejectedValueOnce(new Error('network down'));
    const res = await sendEmail('acc-1', baseInput, 'draft-1');
    expect(res.success).toBe(false);
    expect(res.message).toContain('network down');
    // No send invoke succeeded; no draft-row cleanup is expected (composer owns it).
    const calls = mockInvoke.mock.calls.map((c) => c[0]);
    expect(calls).not.toContain('db_delete_draft');
  });

  it('returns failure when the account id is unknown', async () => {
    const res = await sendEmail('nope', baseInput, 'draft-1');
    expect(res.success).toBe(false);
    expect(mockInvoke).not.toHaveBeenCalled();
  });

  it('emits SEND_COMPLETE_EVENT on success with accountId (Tauri app-level event)', async () => {
    await sendEmail('acc-1', baseInput, 'draft-1');
    expect(mockEmit).toHaveBeenCalledWith(SEND_COMPLETE_EVENT, { accountId: 'acc-1' });
  });

  it('synthesizes a draftId when none is passed (outbox folder still stable)', async () => {
    await sendEmail('acc-1', baseInput, null);
    const payload = mockInvoke.mock.calls[0]![1] as {
      op: { draft: { draftId: string } };
    };
    expect(payload.op.draft.draftId).toBeTruthy();
    expect(payload.op.draft.draftId.length).toBeGreaterThan(8);
  });

  it('emits extraHeaders as a tuple-array (not a Record)', async () => {
    const res = await sendEmail(
      'acc-1',
      { ...baseInput, importance: 'high', requestReadReceipt: true },
      'draft-1',
    );
    expect(res.success).toBe(true);
    const payload = mockInvoke.mock.calls[0]![1] as {
      op: { draft: { extraHeaders?: Array<[string, string]> } };
    };
    expect(payload.op.draft.extraHeaders).toBeDefined();
    expect(Array.isArray(payload.op.draft.extraHeaders)).toBe(true);
    for (const row of payload.op.draft.extraHeaders!) {
      expect(Array.isArray(row)).toBe(true);
      expect(row).toHaveLength(2);
    }
    // Spot-check the X-Priority and Importance tuples.
    expect(payload.op.draft.extraHeaders).toEqual(
      expect.arrayContaining([
        ['X-Priority', '1'],
        ['Importance', 'high'],
        ['Disposition-Notification-To', 'alice@example.com'],
      ]),
    );
  });

  it('passes cryptoMethod=smime + sign/encrypt when DraftInput toggles set', async () => {
    // Plan 4b Task 1: sendEmail must thread DraftInput.isEncrypted/isSigned
    // through buildSendDraft's 5th `crypto` arg so the backend SendDraft
    // carries the user's crypto intent. Without this wiring the toggles are
    // silently dropped and Plan 4a's apply_crypto is a no-op passthrough.
    const res = await sendEmail(
      'acc-1',
      { ...baseInput, isSigned: true, isEncrypted: true },
      'draft-1',
    );
    expect(res.success).toBe(true);
    const payload = mockInvoke.mock.calls[0]![1] as {
      op: { draft: { cryptoMethod: string; sign: boolean; encrypt: boolean } };
    };
    expect(payload.op.draft.cryptoMethod).toBe('smime');
    expect(payload.op.draft.sign).toBe(true);
    expect(payload.op.draft.encrypt).toBe(true);
  });

  it('defaults cryptoMethod=none + sign/encrypt=false when toggles unset', async () => {
    // When neither toggle is set, sendEmail should pass NO crypto arg
    // (undefined) so buildSendDraft applies its 'none'/false defaults.
    const res = await sendEmail('acc-1', baseInput, 'draft-1');
    expect(res.success).toBe(true);
    const payload = mockInvoke.mock.calls[0]![1] as {
      op: { draft: { cryptoMethod: string; sign: boolean; encrypt: boolean } };
    };
    expect(payload.op.draft.cryptoMethod).toBe('none');
    expect(payload.op.draft.sign).toBe(false);
    expect(payload.op.draft.encrypt).toBe(false);
  });

  it('threads only sign when only isSigned is set (encrypt stays false)', async () => {
    // Asymmetry guard: one toggle ON must not flip the other. sign-only path.
    const res = await sendEmail(
      'acc-1',
      { ...baseInput, isSigned: true, isEncrypted: false },
      'draft-1',
    );
    expect(res.success).toBe(true);
    const payload = mockInvoke.mock.calls[0]![1] as {
      op: { draft: { cryptoMethod: string; sign: boolean; encrypt: boolean } };
    };
    expect(payload.op.draft.cryptoMethod).toBe('smime');
    expect(payload.op.draft.sign).toBe(true);
    expect(payload.op.draft.encrypt).toBe(false);
  });

  it('threads only encrypt when only isEncrypted is set (sign stays false)', async () => {
    // Asymmetry guard: encrypt-only path.
    const res = await sendEmail(
      'acc-1',
      { ...baseInput, isSigned: false, isEncrypted: true },
      'draft-1',
    );
    expect(res.success).toBe(true);
    const payload = mockInvoke.mock.calls[0]![1] as {
      op: { draft: { cryptoMethod: string; sign: boolean; encrypt: boolean } };
    };
    expect(payload.op.draft.cryptoMethod).toBe('smime');
    expect(payload.op.draft.sign).toBe(false);
    expect(payload.op.draft.encrypt).toBe(true);
  });
});
