// Tests for the single-click resume choreography: anchor resolution, the
// selection ordering guarantee, and the rapid-click sequence token (latest
// click wins — a slow resolution for an earlier row must never clobber a
// later session).

import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn(() => Promise.resolve([])) }));

const { mockGetMessagesForThread, mockGetMessageBody } = vi.hoisted(() => ({
  mockGetMessagesForThread: vi.fn(),
  mockGetMessageBody: vi.fn(),
}));
vi.mock('../../../src/services/db/threads', async () => {
  const actual = await vi.importActual<typeof import('../../../src/services/db/threads')>(
    '../../../src/services/db/threads',
  );
  return {
    ...actual,
    getMessagesForThread: mockGetMessagesForThread,
  };
});
vi.mock('../../../src/services/db/messageBodies', () => ({
  getMessageBody: mockGetMessageBody,
  setMessageBody: vi.fn(),
  evictBody: vi.fn(),
}));

import { resumeDraftInline } from '../../../src/features/drafts/resumeDraft';
import { useInlineComposerStore } from '../../../src/stores/inlineComposerStore';
import { useThreadStore } from '../../../src/stores/threadStore';
import { useViewStore } from '../../../src/features/view/viewStore';
import type { DbDraft } from '../../../src/services/composer/drafts';

const account = { id: 'a1', email: 'me@x.com', displayName: 'Me' };

const dbDraft = (over: Partial<DbDraft> = {}): DbDraft =>
  ({
    id: 'd1',
    account_id: 'a1',
    to_addresses: JSON.stringify(['Alice <alice@x.com>']),
    cc_addresses: null,
    bcc_addresses: null,
    reply_to_addresses: null,
    subject: 'Draft',
    body_html: '<p>body</p>',
    reply_to_message_id: null,
    thread_id: null,
    from_email: 'me@x.com',
    signature_id: null,
    remote_draft_id: null,
    attachments: null,
    classification_id: null,
    is_encrypted: 0,
    is_signed: 0,
    importance: 'normal',
    request_read_receipt: 0,
    request_delivery_receipt: 0,
    deliver_at: null,
    prevent_copy: 0,
    extra_headers: null,
    intent: null,
    original_message_id: null,
    include_original_attachments: 0,
    created_at: 100,
    updated_at: 200,
    sync_status: 'local',
    ...over,
  }) as DbDraft;

beforeEach(() => {
  mockGetMessagesForThread.mockReset();
  mockGetMessageBody.mockReset();
  useInlineComposerStore.setState({ session: null });
  useThreadStore.setState({ threads: [], selectedThreadId: null, selectedThreadIds: [] });
  useViewStore.setState({ selectedMessage: null, selectedDraftId: null });
});

describe('resumeDraftInline', () => {
  it('standalone draft: resumes the session and selects the draft row', async () => {
    await resumeDraftInline(dbDraft(), account);
    const s = useInlineComposerStore.getState().session!;
    expect(s.draftId).toBe('d1');
    expect(s.anchor.kind).toBe('standalone');
    expect(useViewStore.getState().selectedDraftId).toBe('d1');
    expect(useViewStore.getState().selectedMessage).toBeNull();
  });

  it('thread draft: anchors to the resolved latest message and selects it', async () => {
    mockGetMessagesForThread.mockResolvedValue([
      {
        id: 'm9',
        account_id: 'a1',
        thread_id: 't1',
        from_address: 'bob@x.com',
        from_name: 'Bob',
        to_addresses: 'me@x.com',
        cc_addresses: null,
        subject: 'Hello',
        snippet: 'sn',
        date: 100,
        is_read: 1,
        is_starred: 0,
        body_text: 'txt',
        classification_id: null,
        is_encrypted: false,
        is_signed: false,
        imap_uid: 1,
        imap_folder: 'INBOX',
        message_id_header: '<m9@x>',
      },
    ]);
    mockGetMessageBody.mockResolvedValue({
      accountId: 'a1',
      messageId: 'm9',
      bodyHtml: '<p>x</p>',
      fetchedAt: 1,
    });
    await resumeDraftInline(dbDraft({ thread_id: 't1', reply_to_message_id: '<m9@x>' }), account);
    const s = useInlineComposerStore.getState().session!;
    expect(s.anchor.kind).toBe('reply');
    expect(useViewStore.getState().selectedMessage?.id).toBe('m9');
    // The draft row is NOT the target for a reply-anchored resume.
    expect(useViewStore.getState().selectedDraftId).toBeNull();
  });

  it('rapid clicks on different rows: the LATEST click wins (no stale clobber)', async () => {
    // Draft A's anchor resolution is slow; B's is instant (standalone).
    let resolveA: ((rows: never[]) => void) | null = null;
    mockGetMessagesForThread.mockImplementationOnce(
      () =>
        new Promise((res) => {
          resolveA = res as never;
        }),
    );
    mockGetMessageBody.mockResolvedValue({
      accountId: 'a1',
      messageId: 'mA',
      bodyHtml: '<p>x</p>',
      fetchedAt: 1,
    });

    const a = resumeDraftInline(dbDraft({ id: 'dA', thread_id: 'tA' }), account);
    const b = resumeDraftInline(dbDraft({ id: 'dB' }), account);
    await b; // B lands first
    expect(useInlineComposerStore.getState().session?.draftId).toBe('dB');

    // A's slow resolution now completes — it must NOT clobber B's session.
    resolveA!([] as never);
    await a;
    expect(useInlineComposerStore.getState().session?.draftId).toBe('dB');
    expect(useViewStore.getState().selectedDraftId).toBe('dB');
  });

  it('replaces a dirty session without confirming and preserves its row', async () => {
    // Existing dirty session for another draft.
    await resumeDraftInline(dbDraft({ id: 'dA' }), account);
    useInlineComposerStore.getState().setBodyHtml('<p>dirty</p>', { userEdit: true });
    useViewStore.setState({ selectedMessage: null, selectedDraftId: 'dA' });

    const confirmSpy = vi.spyOn(window, 'confirm');
    await resumeDraftInline(dbDraft({ id: 'dB' }), account);

    // No confirm; the new draft owns the dock AND the selection; the outgoing
    // row is preserved (its [Draft] chip lives on).
    expect(confirmSpy).not.toHaveBeenCalled();
    expect(useInlineComposerStore.getState().session?.draftId).toBe('dB');
    expect(useViewStore.getState().selectedDraftId).toBe('dB');
    confirmSpy.mockRestore();
  });
});
