// Tests for the docked inline composer's local-draft autosave: dirty sessions
// persist to `local_drafts` (debounced), the row id is written back without
// re-arming the debounce, and pristine / unseeded sessions never save.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn(() => Promise.resolve([])) }));

const { mockSaveDraft } = vi.hoisted(() => ({ mockSaveDraft: vi.fn(async () => 'row-1') }));
vi.mock('../../../src/services/composer/drafts', async () => {
  const actual = await vi.importActual<typeof import('../../../src/services/composer/drafts')>(
    '../../../src/services/composer/drafts',
  );
  return { ...actual, saveDraft: mockSaveDraft };
});

import {
  startInlineDraftAutoSave,
  stopInlineDraftAutoSave,
} from '../../../src/services/composer/inlineDraftAutoSave';
import {
  useInlineComposerStore,
  type InlineSession,
} from '../../../src/stores/inlineComposerStore';
import type { DraftSeed } from '../../../src/features/composer/draftFactory';
import type { MailMessage } from '../../../src/features/view/viewStore';

function makeSession(over: Partial<InlineSession> = {}): InlineSession {
  return {
    anchor: {
      kind: 'reply',
      message: { id: 'msg-1', threadId: 't1', messageId: '<mid-1@example.com>' } as MailMessage,
    },
    accountId: 'acc-1',
    accountEmail: 'me@example.com',
    intent: 'reply',
    seed: {} as DraftSeed,
    seedError: null,
    stagingDraftId: 'stage-1',
    draftId: null,
    pristine: false,
    bodyHtml: '<p>typed text</p>',
    signatureId: undefined,
    classificationId: null,
    fromEmail: 'me@example.com',
    selfEmails: ['me@example.com'],
    includeOriginalAttachments: false,
    threadId: null,
    inReplyToMessageId: '<mid-1@example.com>',
    to: [{ name: 'Bob', email: 'bob@example.com' }],
    cc: [],
    bcc: [],
    replyTo: [],
    subject: 'Re: Hello',
    attachments: [],
    importance: 'normal',
    requestReadReceipt: false,
    requestDeliveryReceipt: false,
    deliverAt: null,
    preventCopy: false,
    isEncrypted: false,
    isSigned: false,
    ...over,
  };
}

describe('inlineDraftAutoSave', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    useInlineComposerStore.setState({ session: null });
    mockSaveDraft.mockClear();
    startInlineDraftAutoSave();
  });

  afterEach(() => {
    stopInlineDraftAutoSave();
    vi.useRealTimers();
  });

  it('saves a dirty session after the debounce and writes back the row id', async () => {
    useInlineComposerStore.setState({ session: makeSession() });
    expect(mockSaveDraft).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(3000);
    expect(mockSaveDraft).toHaveBeenCalledTimes(1);
    const [input, existingId] = mockSaveDraft.mock.calls[0]!;
    expect(existingId).toBeNull();
    expect(input).toMatchObject({
      accountId: 'acc-1',
      subject: 'Re: Hello',
      bodyHtml: '<p>typed text</p>',
      // threadId falls back to the replied-to message's conversation.
      threadId: 't1',
      inReplyToMessageId: '<mid-1@example.com>',
    });
    expect(useInlineComposerStore.getState().session?.draftId).toBe('row-1');
  });

  it('never saves pristine sessions (opened and abandoned without edits)', async () => {
    useInlineComposerStore.setState({ session: makeSession({ pristine: true }) });
    await vi.advanceTimersByTimeAsync(15000);
    expect(mockSaveDraft).not.toHaveBeenCalled();
  });

  it('never saves sessions whose seed has not resolved', async () => {
    useInlineComposerStore.setState({ session: makeSession({ seed: null }) });
    await vi.advanceTimersByTimeAsync(15000);
    expect(mockSaveDraft).not.toHaveBeenCalled();
  });

  it('the draftId write-back does not re-arm the debounce', async () => {
    useInlineComposerStore.setState({ session: makeSession() });
    await vi.advanceTimersByTimeAsync(3000);
    expect(mockSaveDraft).toHaveBeenCalledTimes(1);

    // The write-back (draftId only) must not schedule another save.
    await vi.advanceTimersByTimeAsync(30000);
    expect(mockSaveDraft).toHaveBeenCalledTimes(1);
  });

  it('re-saves under the same row id when content changes', async () => {
    useInlineComposerStore.setState({ session: makeSession() });
    await vi.advanceTimersByTimeAsync(3000);
    expect(mockSaveDraft).toHaveBeenCalledTimes(1);

    useInlineComposerStore.getState().setBodyHtml('<p>typed text, edited</p>', { userEdit: true });
    await vi.advanceTimersByTimeAsync(3000);
    expect(mockSaveDraft).toHaveBeenCalledTimes(2);
    expect(mockSaveDraft.mock.calls[1]![1]).toBe('row-1');
  });

  it('a restored (pristine) session does not save until a real edit', async () => {
    // Restored drafts start pristine: merely RESUMING a draft must not
    // re-save (an unedited save bumps updated_at and makes the draft jump to
    // the top of the Drafts folder).
    useInlineComposerStore.setState({ session: makeSession({ pristine: true, draftId: 'row-1' }) });
    await vi.advanceTimersByTimeAsync(10000);
    expect(mockSaveDraft).not.toHaveBeenCalled();

    // A real edit flips pristine and saves under the same row id.
    useInlineComposerStore.getState().setBodyHtml('<p>typed text, edited</p>', { userEdit: true });
    await vi.advanceTimersByTimeAsync(3000);
    expect(mockSaveDraft).toHaveBeenCalledTimes(1);
    expect(mockSaveDraft.mock.calls[0]![1]).toBe('row-1');
  });

  it('stops scheduling after stopInlineDraftAutoSave', async () => {
    useInlineComposerStore.setState({ session: makeSession() });
    stopInlineDraftAutoSave();
    await vi.advanceTimersByTimeAsync(10000);
    expect(mockSaveDraft).not.toHaveBeenCalled();
  });
});
