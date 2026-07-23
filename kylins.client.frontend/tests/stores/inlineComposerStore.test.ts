// Tests for the docked inline composer store: session lifecycle (open with
// async seed, retention, discard cleanup, pop-out transfer), the alias-aware
// recipient seeding regression (bug: reply-all Cc'd the user's own aliases),
// and reply↔replyAll switching that preserves manually added recipients.

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { waitFor } from '@testing-library/react';

const { mockInvoke } = vi.hoisted(() => ({ mockInvoke: vi.fn() }));
vi.mock('@tauri-apps/api/core', () => ({ invoke: mockInvoke }));

vi.mock('@tauri-apps/api/path', () => ({
  appDataDir: vi.fn(async () => '/appdata'),
  join: vi.fn(async (...parts: string[]) => parts.join('/')),
}));

const { mockExists, mockRemove, mockReadFile } = vi.hoisted(() => ({
  mockExists: vi.fn(),
  mockRemove: vi.fn(),
  mockReadFile: vi.fn(),
}));
vi.mock('@tauri-apps/plugin-fs', () => ({
  exists: mockExists,
  remove: mockRemove,
  mkdir: vi.fn(async () => {}),
  copyFile: vi.fn(async () => {}),
  writeFile: vi.fn(async () => {}),
  readFile: mockReadFile,
}));

const { mockGetAttachments, mockFetchAttachment, mockFetchInlineImages } = vi.hoisted(() => ({
  mockGetAttachments: vi.fn(),
  mockFetchAttachment: vi.fn(),
  mockFetchInlineImages: vi.fn(),
}));
vi.mock('../../src/services/db/attachments', () => ({
  getAttachments: mockGetAttachments,
  fetchAttachment: mockFetchAttachment,
  fetchInlineImages: mockFetchInlineImages,
  cachedImageToDataUrl: vi.fn(async () => 'data:image/png;base64,x'),
}));

import { useInlineComposerStore } from '../../src/stores/inlineComposerStore';
import { useComposerStore } from '../../src/stores/composerStore';
import { usePreferencesStore } from '../../src/stores/preferencesStore';
import type { InlineIntent } from '../../src/features/composer/draftFactory';
import type { MailMessage } from '../../src/features/view/viewStore';

const account = { id: 'acc-1', email: 'me@example.com', displayName: 'Me' };

function makeMessage(overrides: Partial<MailMessage> = {}): MailMessage {
  return {
    id: 'msg-1',
    subject: 'Hello',
    from: { name: 'Bob', address: 'bob@example.com' },
    to: [{ name: 'Me', address: 'me@example.com' }],
    cc: [{ name: 'Carol', address: 'carol@example.com' }],
    replyTo: [],
    date: new Date('2026-07-05T10:00:00Z').toISOString(),
    preview: 'preview',
    html: '<p>Original body</p>',
    text: 'Original body',
    threadId: 't1',
    messageId: '<mid-1@example.com>',
    classificationId: null,
    isEncrypted: false,
    isSigned: false,
    ...overrides,
  };
}

function aliasRow(email: string) {
  return {
    id: `alias-${email}`,
    account_id: 'acc-1',
    email,
    display_name: null,
    reply_to_address: null,
    signature_id: null,
    is_primary: 0,
    is_default: 0,
    treat_as_alias: 1,
    verification_status: 'accepted',
    created_at: 1,
  };
}

async function openAndSettle(intent: InlineIntent, message: MailMessage) {
  useInlineComposerStore.getState().open(intent, message, account);
  await waitFor(() => {
    expect(useInlineComposerStore.getState().session?.seed).not.toBeNull();
  });
  return useInlineComposerStore.getState().session!;
}

describe('inlineComposerStore', () => {
  beforeEach(() => {
    useInlineComposerStore.setState({ session: null });
    useComposerStore.getState().closeComposer();
    usePreferencesStore.setState({ quoteStyle: 'outlook' });
    mockInvoke.mockReset();
    mockInvoke.mockImplementation(async (cmd: string) => {
      if (cmd === 'db_get_aliases_for_account') return [];
      return undefined;
    });
    mockGetAttachments.mockReset().mockResolvedValue([]);
    mockFetchAttachment.mockReset();
    mockFetchInlineImages.mockReset().mockResolvedValue([]);
    mockExists.mockReset().mockResolvedValue(false);
    mockRemove.mockReset().mockResolvedValue(undefined);
    vi.restoreAllMocks();
  });

  it('open creates a pristine session and resolves the seed (recipients, subject, outlook body)', async () => {
    const s = await openAndSettle('reply', makeMessage());
    expect(s.pristine).toBe(true);
    expect(s.messageId).toBe('msg-1');
    expect(s.to).toEqual([{ name: 'Bob', email: 'bob@example.com' }]);
    expect(s.subject).toBe('Re: Hello');
    expect(s.bodyHtml).toContain('<b>From:</b>');
    expect(s.bodyHtml).toContain('data-quote="original"');
    expect(s.fromEmail).toBe('me@example.com');
    expect(s.includeOriginalAttachments).toBe(false);
  });

  it('reply-all excludes the account address AND send-as aliases from Cc (regression)', async () => {
    mockInvoke.mockImplementation(async (cmd: string) => {
      if (cmd === 'db_get_aliases_for_account') return [aliasRow('alias@example.com')];
      return undefined;
    });
    const message = makeMessage({
      cc: [
        { name: 'Alias', address: 'alias@example.com' },
        { name: 'Me', address: 'me@example.com' },
        { name: 'Carol', address: 'carol@example.com' },
      ],
    });
    const s = await openAndSettle('replyAll', message);
    expect(s.cc).toEqual([{ name: 'Carol', email: 'carol@example.com' }]);
    expect(s.selfEmails).toContain('alias@example.com');
  });

  it('replyWithAttachments seeds original attachments tagged origin=seeded', async () => {
    mockGetAttachments.mockResolvedValue([
      {
        id: 'att-1',
        accountId: 'acc-1',
        messageId: 'msg-1',
        filename: 'report.pdf',
        mimeType: 'application/pdf',
        size: 100,
        isInline: false,
        imapPartId: '2',
      },
    ]);
    mockFetchAttachment.mockResolvedValue({
      filePath: '/cache/report.pdf',
      filename: 'report.pdf',
      mimeType: 'application/pdf',
      size: 100,
    });
    const s = await openAndSettle('replyWithAttachments', makeMessage());
    expect(s.includeOriginalAttachments).toBe(true);
    expect(s.attachments).toHaveLength(1);
    expect(s.attachments[0]).toMatchObject({ filename: 'report.pdf', origin: 'seeded' });
    // Reply (not forward) threading is preserved.
    expect(s.seed?.inReplyToMessageId).toBe('<mid-1@example.com>');
  });

  it('retention: opening for the same message keeps edits; pristine sessions replace silently', async () => {
    const s1 = await openAndSettle('reply', makeMessage());
    useInlineComposerStore.getState().setSubject('Re: edited');
    // Same message: open() is a no-op replacement guard — session stays.
    useInlineComposerStore.getState().open('reply', makeMessage(), account);
    const s2 = useInlineComposerStore.getState().session!;
    expect(s2.stagingDraftId).toBe(s1.stagingDraftId);
    expect(s2.subject).toBe('Re: edited');
  });

  it('a non-pristine session for a DIFFERENT message confirms before being discarded', async () => {
    mockExists.mockResolvedValue(true);
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(false);
    const s1 = await openAndSettle('reply', makeMessage());
    useInlineComposerStore.getState().setSubject('dirty');

    useInlineComposerStore.getState().open('reply', makeMessage({ id: 'msg-2' }), account);
    expect(confirmSpy).toHaveBeenCalled();
    expect(useInlineComposerStore.getState().session?.messageId).toBe('msg-1');

    confirmSpy.mockReturnValue(true);
    useInlineComposerStore.getState().open('reply', makeMessage({ id: 'msg-2' }), account);
    await waitFor(() => expect(useInlineComposerStore.getState().session?.messageId).toBe('msg-2'));
    // Old session's staging dir was cleaned on replacement (fire-and-forget).
    await waitFor(() =>
      expect(mockRemove).toHaveBeenCalledWith(
        expect.stringContaining(s1.stagingDraftId),
        expect.objectContaining({ recursive: true }),
      ),
    );
  });

  it('discard clears the session and deletes the staging directory', async () => {
    mockExists.mockResolvedValue(true);
    const s = await openAndSettle('reply', makeMessage());
    useInlineComposerStore.getState().discard();
    expect(useInlineComposerStore.getState().session).toBeNull();
    await waitFor(() =>
      expect(mockRemove).toHaveBeenCalledWith(
        expect.stringContaining(s.stagingDraftId),
        expect.objectContaining({ recursive: true }),
      ),
    );
  });

  it('popOut transfers staging dir + attachments to the composer window WITHOUT cleanup', async () => {
    const s = await openAndSettle('reply', makeMessage());
    useInlineComposerStore.getState().addAttachment({
      id: 'a1',
      filename: 'picked.txt',
      mimeType: 'text/plain',
      size: 5,
      filePath: '/outbox/picked.txt',
      origin: 'picked',
    });
    useInlineComposerStore.getState().popOut('<p>typed body</p>', 'sig-1');

    expect(useInlineComposerStore.getState().session).toBeNull();
    // openComposerWindow's non-Tauri fallback resolves through a dynamic
    // import before landing in the composer store.
    await waitFor(() => expect(useComposerStore.getState().isOpen).toBe(true));
    const modal = useComposerStore.getState();
    expect(modal.mode).toBe('reply');
    expect(modal.stagingDraftId).toBe(s.stagingDraftId);
    expect(modal.attachments).toHaveLength(1);
    expect(modal.bodyHtml).toBe('<p>typed body</p>');
    expect(modal.signatureId).toBe('sig-1');
    expect(modal.inReplyToMessageId).toBe('<mid-1@example.com>');
    expect(mockRemove).not.toHaveBeenCalled();
  });

  it('clearAfterSend drops the session without touching the staging dir', async () => {
    await openAndSettle('reply', makeMessage());
    useInlineComposerStore.getState().clearAfterSend();
    expect(useInlineComposerStore.getState().session).toBeNull();
    expect(mockRemove).not.toHaveBeenCalled();
  });

  it('switchReplyKind upgrades to reply-all adding missing participants, downgrade keeps manual ones', async () => {
    const s = await openAndSettle('reply', makeMessage());
    expect(s.to).toEqual([{ name: 'Bob', email: 'bob@example.com' }]);
    expect(s.cc).toEqual([]);

    // Upgrade: Carol joins via Cc.
    useInlineComposerStore.getState().switchReplyKind('replyAll');
    let cur = useInlineComposerStore.getState().session!;
    expect(cur.intent).toBe('replyAll');
    expect(cur.cc).toEqual([{ name: 'Carol', email: 'carol@example.com' }]);

    // User manually adds Dave, then downgrades: Dave stays, Carol goes.
    useInlineComposerStore
      .getState()
      .setCc([...cur.cc, { name: 'Dave', email: 'dave@example.com' }]);
    useInlineComposerStore.getState().switchReplyKind('reply');
    cur = useInlineComposerStore.getState().session!;
    expect(cur.intent).toBe('reply');
    expect(cur.cc).toEqual([{ name: 'Dave', email: 'dave@example.com' }]);
    expect(cur.to).toEqual([{ name: 'Bob', email: 'bob@example.com' }]);
  });

  it('switchReplyKind preserves the with-attachments intent variant', async () => {
    await openAndSettle('replyWithAttachments', makeMessage());
    useInlineComposerStore.getState().switchReplyKind('replyAll');
    expect(useInlineComposerStore.getState().session?.intent).toBe('replyAllWithAttachments');
  });

  it('forward checkbox toggle drops only seeded attachments, never picked ones', async () => {
    mockGetAttachments.mockResolvedValue([
      {
        id: 'att-1',
        accountId: 'acc-1',
        messageId: 'msg-1',
        filename: 'orig.pdf',
        mimeType: 'application/pdf',
        size: 100,
        isInline: false,
      },
    ]);
    mockFetchAttachment.mockResolvedValue({
      filePath: '/cache/orig.pdf',
      filename: 'orig.pdf',
      mimeType: 'application/pdf',
      size: 100,
    });
    const s = await openAndSettle('forward', makeMessage());
    expect(s.attachments).toHaveLength(1);

    useInlineComposerStore.getState().addAttachment({
      id: 'a1',
      filename: 'mine.txt',
      mimeType: 'text/plain',
      size: 5,
      filePath: '/outbox/mine.txt',
      origin: 'picked',
    });
    useInlineComposerStore.getState().setIncludeOriginalAttachments(false);
    const cur = useInlineComposerStore.getState().session!;
    expect(cur.attachments).toHaveLength(1);
    expect(cur.attachments[0]?.filename).toBe('mine.txt');
  });

  it('same message, forward ↔ reply family change replaces the session (with confirm when dirty)', async () => {
    mockExists.mockResolvedValue(true);
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true);
    const s1 = await openAndSettle('reply', makeMessage());
    useInlineComposerStore.getState().setSubject('dirty');

    // Clicking Forward with a reply dock open must replace, not silently
    // ignore (bug: the family boundary used to be a no-op).
    useInlineComposerStore.getState().open('forward', makeMessage(), account);
    await waitFor(() => expect(useInlineComposerStore.getState().session?.intent).toBe('forward'));
    const s2 = useInlineComposerStore.getState().session!;
    expect(s2.stagingDraftId).not.toBe(s1.stagingDraftId);
    expect(s2.subject).toBe('Fwd: Hello');
    confirmSpy.mockRestore();
  });

  it('same message, adding the with-attachment variant seeds on top of the open reply', async () => {
    mockGetAttachments.mockResolvedValue([
      {
        id: 'att-1',
        accountId: 'acc-1',
        messageId: 'msg-1',
        filename: 'orig.pdf',
        mimeType: 'application/pdf',
        size: 100,
        isInline: false,
      },
    ]);
    mockFetchAttachment.mockResolvedValue({
      filePath: '/cache/orig.pdf',
      filename: 'orig.pdf',
      mimeType: 'application/pdf',
      size: 100,
    });
    const s1 = await openAndSettle('reply', makeMessage());
    expect(s1.attachments).toHaveLength(0);

    useInlineComposerStore.getState().open('replyWithAttachments', makeMessage(), account);
    await waitFor(() =>
      expect(useInlineComposerStore.getState().session?.attachments).toHaveLength(1),
    );
    const s2 = useInlineComposerStore.getState().session!;
    // Same session (no replace), attachments seeded on top.
    expect(s2.stagingDraftId).toBe(s1.stagingDraftId);
    expect(s2.intent).toBe('reply'); // family unchanged; inclusion toggled
    expect(s2.includeOriginalAttachments).toBe(true);
  });

  it('discard confirms for a non-pristine session and aborts when declined', async () => {
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(false);
    await openAndSettle('reply', makeMessage());
    useInlineComposerStore.getState().setSubject('dirty');
    useInlineComposerStore.getState().discard();
    expect(useInlineComposerStore.getState().session).not.toBeNull();

    confirmSpy.mockReturnValue(true);
    useInlineComposerStore.getState().discard();
    expect(useInlineComposerStore.getState().session).toBeNull();
    confirmSpy.mockRestore();
  });

  it('discard of a pristine session does not confirm', async () => {
    const confirmSpy = vi.spyOn(window, 'confirm');
    await openAndSettle('reply', makeMessage());
    useInlineComposerStore.getState().discard();
    expect(confirmSpy).not.toHaveBeenCalled();
    expect(useInlineComposerStore.getState().session).toBeNull();
    confirmSpy.mockRestore();
  });
});
