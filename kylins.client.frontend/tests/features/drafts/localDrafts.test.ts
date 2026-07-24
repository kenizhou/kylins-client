import { describe, it, expect, vi, beforeEach } from 'vitest';
import { waitFor } from '@testing-library/react';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn(() => Promise.resolve([])) }));

const { mockDeleteDraft, mockCleanupAttachments } = vi.hoisted(() => ({
  mockDeleteDraft: vi.fn(async () => {}),
  mockCleanupAttachments: vi.fn(async () => {}),
}));

vi.mock('../../../src/services/composer/drafts', async () => {
  const actual = await vi.importActual<typeof import('../../../src/services/composer/drafts')>(
    '../../../src/services/composer/drafts',
  );
  return { ...actual, deleteDraft: mockDeleteDraft };
});

vi.mock('../../../src/services/composer/attachments', async () => {
  const actual = await vi.importActual<typeof import('../../../src/services/composer/attachments')>(
    '../../../src/services/composer/attachments',
  );
  return { ...actual, cleanupAttachments: mockCleanupAttachments };
});

import {
  deleteLocalDraft,
  draftToComposeWindowOptions,
  draftToThread,
  htmlToSnippet,
  openDraftInWindow,
  recipientSummary,
  stagingIdFromAttachmentPath,
  storedAttachments,
  LOCAL_DRAFT_ROW_PREFIX,
} from '../../../src/features/drafts/localDrafts';
import { useComposerStore } from '../../../src/stores/composerStore';
import { useInlineComposerStore } from '../../../src/stores/inlineComposerStore';
import type { DbDraft } from '../../../src/services/composer/drafts';

const dbDraft = (over: Partial<DbDraft> = {}): DbDraft => ({
  id: 'd1',
  account_id: 'a1',
  to_addresses: JSON.stringify(['Alice <alice@x.com>', 'bob@x.com']),
  cc_addresses: null,
  bcc_addresses: null,
  reply_to_addresses: null,
  subject: 'Quarterly plan',
  body_html: '<p>Hello <b>team</b></p>',
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
});

beforeEach(() => {
  mockDeleteDraft.mockClear();
  mockCleanupAttachments.mockClear();
  useComposerStore.getState().closeComposer();
  useInlineComposerStore.setState({ session: null });
});

describe('htmlToSnippet', () => {
  it('strips tags and collapses whitespace', () => {
    expect(htmlToSnippet('<p>Hello <b>team</b></p>\n<p>second   line</p>')).toBe(
      'Hello team second line',
    );
  });

  it('drops style blocks and handles null', () => {
    expect(htmlToSnippet('<style>p{color:red}</style><p>hi</p>')).toBe('hi');
    expect(htmlToSnippet(null)).toBe('');
  });
});

describe('recipientSummary', () => {
  it('joins To recipients', () => {
    expect(recipientSummary(dbDraft())).toBe('Alice <alice@x.com>, bob@x.com');
  });

  it('falls back when empty or corrupt', () => {
    expect(recipientSummary(dbDraft({ to_addresses: null }))).toBe('(no recipients)');
    expect(recipientSummary(dbDraft({ to_addresses: 'not json' }))).toBe('(no recipients)');
  });
});

describe('stagingIdFromAttachmentPath', () => {
  it('extracts the staging dir from posix and windows paths', () => {
    expect(stagingIdFromAttachmentPath('/appdata/outbox-attachments/draft-9/file.pdf')).toBe(
      'draft-9',
    );
    expect(stagingIdFromAttachmentPath('C:\\appdata\\outbox-attachments\\draft-9\\file.pdf')).toBe(
      'draft-9',
    );
  });

  it('returns null when the outbox segment is absent or trailing', () => {
    expect(stagingIdFromAttachmentPath('/tmp/other/file.pdf')).toBeNull();
    expect(stagingIdFromAttachmentPath('/appdata/outbox-attachments')).toBeNull();
  });
});

describe('storedAttachments', () => {
  it('parses the JSON column and tolerates junk', () => {
    const atts = storedAttachments(
      dbDraft({
        attachments: JSON.stringify([
          { filename: 'a.pdf', mimeType: 'application/pdf', filePath: '/x/a.pdf', size: 3 },
        ]),
      }),
    );
    expect(atts).toHaveLength(1);
    expect(storedAttachments(dbDraft({ attachments: '{bad' }))).toEqual([]);
    expect(storedAttachments(dbDraft())).toEqual([]);
  });
});

describe('draftToThread', () => {
  it('projects the row shape with a prefixed id and pinned read state', () => {
    const t = draftToThread(dbDraft());
    expect(t.id).toBe(`${LOCAL_DRAFT_ROW_PREFIX}d1`);
    expect(t.subject).toBe('Quarterly plan');
    expect(t.snippet).toBe('Hello team');
    expect(t.fromName).toBe('Alice <alice@x.com>, bob@x.com');
    expect(t.lastMessageAt).toBe(200);
    expect(t.isRead).toBe(true);
    expect(t.hasAttachments).toBe(false);
  });

  it('flags attachments and high importance', () => {
    const t = draftToThread(
      dbDraft({
        importance: 'high',
        attachments: JSON.stringify([
          { filename: 'a.pdf', mimeType: 'application/pdf', filePath: '/x/a.pdf', size: 3 },
        ]),
      }),
    );
    expect(t.hasAttachments).toBe(true);
    expect(t.isImportant).toBe(true);
  });
});

describe('draftToComposeWindowOptions', () => {
  it('maps persisted columns back to composer-window params', () => {
    const opts = draftToComposeWindowOptions(
      dbDraft({
        reply_to_message_id: '<m@x>',
        reply_to_addresses: JSON.stringify(['RT <rt@x.com>']),
        thread_id: 't1',
        is_encrypted: 1,
        request_read_receipt: 1,
        request_delivery_receipt: 1,
        importance: 'high',
      }),
    );
    expect(opts.mode).toBe('reply');
    expect(opts.draftId).toBe('d1');
    expect(opts.accountId).toBe('a1');
    expect(opts.subject).toBe('Quarterly plan');
    expect(opts.bodyHtml).toBe('<p>Hello <b>team</b></p>');
    expect(opts.threadId).toBe('t1');
    expect(opts.inReplyToMessageId).toBe('<m@x>');
    expect(opts.isEncrypted).toBe(true);
    expect(opts.requestReadReceipt).toBe(true);
    expect(opts.requestDeliveryReceipt).toBe(true);
    expect(opts.importance).toBe('high');
    expect(opts.replyTo).toEqual([{ name: 'RT', email: 'rt@x.com' }]);
    expect(opts.stagingDraftId).toBeUndefined();
  });

  it('restores the persisted intent as the window mode (forward stays forward)', () => {
    const opts = draftToComposeWindowOptions(
      dbDraft({
        intent: 'forward',
        reply_to_message_id: null,
        original_message_id: '<orig@x>',
        include_original_attachments: 1,
      }),
    );
    expect(opts.mode).toBe('forward');
    expect(opts.originalMessageId).toBe('<orig@x>');
    expect(opts.includeOriginalAttachments).toBe(true);
  });

  it('derives the staging id from the first attachment path', () => {
    const opts = draftToComposeWindowOptions(
      dbDraft({
        attachments: JSON.stringify([
          {
            filename: 'a.pdf',
            mimeType: 'application/pdf',
            filePath: '/appdata/outbox-attachments/draft-42/a.pdf',
            size: 3,
          },
        ]),
      }),
    );
    expect(opts.stagingDraftId).toBe('draft-42');
    expect(opts.attachments).toHaveLength(1);
    expect(opts.attachments?.[0]?.filePath).toBe('/appdata/outbox-attachments/draft-42/a.pdf');
  });

  it('openDraftInWindow hydrates the composer (non-Tauri fallback) with structured recipients', async () => {
    openDraftInWindow(dbDraft());
    await waitFor(() => expect(useComposerStore.getState().isOpen).toBe(true));
    const state = useComposerStore.getState();
    expect(state.draftId).toBe('d1');
    expect(state.fromEmail).toBe('me@x.com');
    expect(state.to.map((r) => r.email)).toEqual(['alice@x.com', 'bob@x.com']);
    expect(state.to[0]?.name).toBe('Alice');
  });

  it('openDraftInWindow transfers the staging dir when the draft is live in the dock', async () => {
    useInlineComposerStore.setState({
      session: {
        draftId: 'd1',
        stagingDraftId: 'stage-live',
        bodyHtml: '<p>live edit</p>',
        signatureId: undefined,
        intent: 'reply',
        anchor: { kind: 'reply', message: { id: 'm1', threadId: 't1' } },
        to: [{ name: 'Alice', email: 'alice@x.com' }],
        cc: [],
        bcc: [],
        replyTo: [],
        subject: 'Quarterly plan',
        attachments: [],
        accountId: 'a1',
        accountEmail: 'me@x.com',
      } as never,
    });
    openDraftInWindow(dbDraft());
    // popOut path: the dock session clears and the composer takes over the
    // SAME staging dir (no re-copy, no dual writers on the row).
    await waitFor(() => expect(useComposerStore.getState().isOpen).toBe(true));
    expect(useInlineComposerStore.getState().session).toBeNull();
    expect(useComposerStore.getState().stagingDraftId).toBe('stage-live');
    expect(useComposerStore.getState().bodyHtml).toBe('<p>live edit</p>');
  });
});

describe('deleteLocalDraft', () => {
  it('deletes the row and cleans the derived staging dir', async () => {
    await deleteLocalDraft(
      dbDraft({
        attachments: JSON.stringify([
          {
            filename: 'a.pdf',
            mimeType: 'application/pdf',
            filePath: '/appdata/outbox-attachments/draft-42/a.pdf',
            size: 3,
          },
        ]),
      }),
    );
    expect(mockDeleteDraft).toHaveBeenCalledWith('d1');
    expect(mockCleanupAttachments).toHaveBeenCalledWith('draft-42');
  });

  it('skips cleanup when the draft has no attachments', async () => {
    await deleteLocalDraft(dbDraft());
    expect(mockDeleteDraft).toHaveBeenCalledWith('d1');
    expect(mockCleanupAttachments).not.toHaveBeenCalled();
  });

  it('still resolves when staging cleanup fails (best-effort)', async () => {
    mockCleanupAttachments.mockRejectedValueOnce(new Error('fs gone'));
    await expect(
      deleteLocalDraft(
        dbDraft({
          attachments: JSON.stringify([
            {
              filename: 'a.pdf',
              mimeType: 'application/pdf',
              filePath: '/appdata/outbox-attachments/draft-42/a.pdf',
              size: 3,
            },
          ]),
        }),
      ),
    ).resolves.toBeUndefined();
  });
});
