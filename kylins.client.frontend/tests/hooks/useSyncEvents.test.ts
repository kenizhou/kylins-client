// G6 Task 6: sync:crypto-result listener helper tests.
//
// The full `useSyncEvents` hook is guarded by an `isTauri` check and registers
// its listeners inside a React effect — both hard to drive from jsdom without
// fragile `__TAURI_INTERNALS__` stubs. To keep the crypto-result refresh logic
// unit-testable we extract it into the exported helper
// `applyCryptoResultToSelectedMessage(payload)`, which the listener calls.
// These tests drive that helper directly against a seeded viewStore.
//
// Contract under test (mirrors the threadStore crypto-field mapping at
// `stores/threadStore.ts:137-144`):
//   - no-op when `selectedMessage` is null
//   - no-op when payload.messageId does not match the selected message
//   - re-reads `getMessageCryptoResult(accountId, messageId)` and layers the
//     crypto fields onto a NEW selectedMessage object (Zustand must see a new
//     reference or the badge won't re-render)
//   - no-op when the re-read returns null (the row was never written)
//   - pushes a toast on the notable transition into 'valid-verified' (the
//     common case after a background re-verify following a CA-root import)

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { useViewStore, type MailMessage } from '../../src/features/view/viewStore';
import { useToastStore } from '../../src/stores/toastStore';
import { applyCryptoResultToSelectedMessage } from '../../src/hooks/useSyncEvents';
import { getMessageCryptoResult } from '../../src/services/db/cryptoReceive';
import type { MessageCryptoResult } from '../../src/services/db/cryptoReceive';

// Mock the cryptoReceive service — only `getMessageCryptoResult` is invoked by
// the helper. `openCryptoMessage` etc. are preserved via importActual so the
// module's type surface stays intact for other consumers.
vi.mock('../../src/services/db/cryptoReceive', async () => {
  const actual = await vi.importActual<typeof import('../../src/services/db/cryptoReceive')>(
    '../../src/services/db/cryptoReceive',
  );
  return { ...actual, getMessageCryptoResult: vi.fn() };
});

function makeMessage(over: Partial<MailMessage> = {}): MailMessage {
  return {
    id: 'msg-1',
    subject: 'Signed mail',
    from: { name: 'Alice', address: 'alice@example.com' },
    to: [{ name: 'Bob', address: 'bob@example.com' }],
    date: '2026-07-01T00:00:00Z',
    preview: '',
    html: null,
    text: null,
    classificationId: null,
    isEncrypted: false,
    isSigned: true,
    ...over,
  };
}

function makeResult(over: Partial<MessageCryptoResult> = {}): MessageCryptoResult {
  return {
    accountId: 'acct',
    messageId: 'msg-1',
    cryptoKind: 'signed',
    decryptState: 'n/a',
    signatureState: 'valid-verified',
    signerFingerprint: 'AB:CD:EF:01:02:03',
    signerEmail: 'alice@example.com',
    chainValid: 1,
    revocationState: 'good',
    verifiedAt: '1700000000',
    ...over,
  };
}

describe('applyCryptoResultToSelectedMessage (sync:crypto-result helper)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useViewStore.getState().setSelectedMessage(null);
    useToastStore.setState({ toasts: [] });
  });

  it('is a no-op when no message is selected', async () => {
    await applyCryptoResultToSelectedMessage({ accountId: 'acct', messageId: 'msg-1' });
    expect(getMessageCryptoResult).not.toHaveBeenCalled();
    expect(useViewStore.getState().selectedMessage).toBeNull();
  });

  it('is a no-op when the payload messageId does not match the selection', async () => {
    useViewStore.getState().setSelectedMessage(makeMessage({ id: 'msg-OTHER' }));
    await applyCryptoResultToSelectedMessage({ accountId: 'acct', messageId: 'msg-1' });
    expect(getMessageCryptoResult).not.toHaveBeenCalled();
    // selectedMessage reference unchanged — no store update fired.
    const current = useViewStore.getState().selectedMessage;
    expect(current?.id).toBe('msg-OTHER');
    expect(current?.signatureState).toBeUndefined();
  });

  it('re-reads + layers crypto fields onto a NEW selectedMessage when ids match', async () => {
    const original = makeMessage({ id: 'msg-1' });
    useViewStore.getState().setSelectedMessage(original);
    vi.mocked(getMessageCryptoResult).mockResolvedValue(
      makeResult({
        signatureState: 'valid-verified',
        signerEmail: 'alice@example.com',
        signerFingerprint: 'AB:CD:EF:01',
        revocationState: 'good',
        decryptState: 'n/a',
      }),
    );

    await applyCryptoResultToSelectedMessage({ accountId: 'acct', messageId: 'msg-1' });

    expect(getMessageCryptoResult).toHaveBeenCalledWith('acct', 'msg-1');
    const updated = useViewStore.getState().selectedMessage;
    expect(updated).not.toBe(original); // new object reference → Zustand re-renders
    expect(updated?.signatureState).toBe('valid-verified');
    expect(updated?.signerEmail).toBe('alice@example.com');
    expect(updated?.signerFingerprint).toBe('AB:CD:EF:01');
    expect(updated?.revocationState).toBe('good');
    expect(updated?.decryptState).toBe('n/a');
  });

  it('is a no-op when the re-read returns null (row never written)', async () => {
    const original = makeMessage({ id: 'msg-1' });
    useViewStore.getState().setSelectedMessage(original);
    vi.mocked(getMessageCryptoResult).mockResolvedValue(null);

    await applyCryptoResultToSelectedMessage({ accountId: 'acct', messageId: 'msg-1' });

    expect(getMessageCryptoResult).toHaveBeenCalled();
    // selectedMessage reference unchanged.
    expect(useViewStore.getState().selectedMessage).toBe(original);
  });

  it('preserves all non-crypto fields on the updated selectedMessage', async () => {
    const original = makeMessage({
      id: 'msg-1',
      subject: 'Preserve me',
      preview: 'snippet',
      html: '<p>body</p>',
    });
    useViewStore.getState().setSelectedMessage(original);
    vi.mocked(getMessageCryptoResult).mockResolvedValue(makeResult());

    await applyCryptoResultToSelectedMessage({ accountId: 'acct', messageId: 'msg-1' });

    const updated = useViewStore.getState().selectedMessage;
    expect(updated?.subject).toBe('Preserve me');
    expect(updated?.preview).toBe('snippet');
    expect(updated?.html).toBe('<p>body</p>');
  });

  it('toasts on the transition into valid-verified (background re-verify success)', async () => {
    useViewStore
      .getState()
      .setSelectedMessage(makeMessage({ id: 'msg-1', signatureState: 'valid-unverified' }));
    vi.mocked(getMessageCryptoResult).mockResolvedValue(
      makeResult({ signatureState: 'valid-verified' }),
    );

    await applyCryptoResultToSelectedMessage({ accountId: 'acct', messageId: 'msg-1' });

    const toasts = useToastStore.getState().toasts;
    expect(toasts.some((t) => /verified|signature.*valid/i.test(t.message))).toBe(true);
  });

  it('does not toast when there is no state transition (e.g. stays valid-verified)', async () => {
    useViewStore
      .getState()
      .setSelectedMessage(makeMessage({ id: 'msg-1', signatureState: 'valid-verified' }));
    vi.mocked(getMessageCryptoResult).mockResolvedValue(
      makeResult({ signatureState: 'valid-verified' }),
    );

    await applyCryptoResultToSelectedMessage({ accountId: 'acct', messageId: 'msg-1' });

    const toasts = useToastStore.getState().toasts;
    expect(toasts.some((t) => /verified|signature.*valid/i.test(t.message))).toBe(false);
  });
});
