import { describe, it, expect, vi } from 'vitest';
import {
  openReplyComposer,
  openReplyAllComposer,
  openForwardComposer,
} from '../../src/utils/composerActions';
import * as composeWindow from '../../src/utils/composeWindow';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }));

vi.mock('../../src/services/db/sendAsAliases', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/services/db/sendAsAliases')>();
  return {
    ...actual,
    getAliasesForAccount: vi.fn(() => Promise.resolve([])),
  };
});

vi.mock('../../src/services/db/attachments', () => ({
  fetchInlineImages: vi.fn(() => Promise.resolve([])),
  cachedImageToDataUrl: vi.fn(() => Promise.resolve('')),
}));

const message = {
  id: 'm-1',
  subject: 'Hello',
  from: { name: 'A', address: 'a@example.com' },
  to: [{ name: 'B', address: 'b@example.com' }],
  date: new Date().toISOString(),
  preview: '',
  html: null,
  text: null,
  classificationId: null,
  isEncrypted: false,
  isSigned: false,
};

const account = { id: 'acc-1', email: 'b@example.com', displayName: 'B' };

describe('composerActions', () => {
  it('routes reply, reply-all and forward through the same open path', async () => {
    const openComposerWindow = vi
      .spyOn(composeWindow, 'openComposerWindow')
      .mockImplementation(() => {});
    openReplyComposer(message, account);
    await vi.waitFor(() => expect(openComposerWindow).toHaveBeenCalledTimes(1));
    expect(openComposerWindow.mock.calls[0]?.[0]?.mode).toBe('reply');

    openReplyAllComposer(message, account);
    await vi.waitFor(() => expect(openComposerWindow).toHaveBeenCalledTimes(2));
    expect(openComposerWindow.mock.calls[1]?.[0]?.mode).toBe('replyAll');

    openForwardComposer(message, account);
    await vi.waitFor(() => expect(openComposerWindow).toHaveBeenCalledTimes(3));
    expect(openComposerWindow.mock.calls[2]?.[0]?.mode).toBe('forward');
  });
});
