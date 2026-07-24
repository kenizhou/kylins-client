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

import { useInlineComposerStore, anchorMessage } from '../../src/stores/inlineComposerStore';
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

/** Minimal persisted draft row; override per test. */
function draftRow(over: Record<string, unknown> = {}) {
  return {
    id: 'row-1',
    account_id: 'acc-1',
    to_addresses: JSON.stringify(['Bob <bob@example.com>']),
    cc_addresses: null,
    bcc_addresses: null,
    reply_to_addresses: null,
    subject: 'Re: Hello',
    body_html: '<p>typed</p>',
    reply_to_message_id: '<mid-1@example.com>',
    thread_id: 't1',
    from_email: 'me@example.com',
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
  } as never;
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
    expect(anchorMessage(s)?.id).toBe('msg-1');
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

  it('replacing a session for a DIFFERENT message preserves the outgoing draft (no confirm, no delete)', async () => {
    const confirmSpy = vi.spyOn(window, 'confirm');
    const s1 = await openAndSettle('reply', makeMessage());
    useInlineComposerStore.getState().setSubject('dirty');
    useInlineComposerStore.setState({
      session: { ...useInlineComposerStore.getState().session!, draftId: 'row-old' },
    });

    await useInlineComposerStore.getState().open('reply', makeMessage({ id: 'msg-2' }), account);

    // No confirm, no row deletion, no staging cleanup: the outgoing draft
    // lives on in the Drafts folder with its [Draft] chip.
    expect(confirmSpy).not.toHaveBeenCalled();
    expect(mockInvoke).not.toHaveBeenCalledWith('db_delete_draft', { id: 'row-old' });
    expect(mockRemove).not.toHaveBeenCalled();
    await waitFor(() =>
      expect(anchorMessage(useInlineComposerStore.getState().session)?.id).toBe('msg-2'),
    );
    expect(useInlineComposerStore.getState().session!.stagingDraftId).not.toBe(s1.stagingDraftId);
    confirmSpy.mockRestore();
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

  it('clearAfterSend deletes the persisted draft row (frontend-owned cleanup)', async () => {
    const s = await openAndSettle('reply', makeMessage());
    useInlineComposerStore.setState({ session: { ...s, draftId: 'row-8' } });
    useInlineComposerStore.getState().clearAfterSend();
    expect(useInlineComposerStore.getState().session).toBeNull();
    await waitFor(() =>
      expect(mockInvoke).toHaveBeenCalledWith('db_delete_draft', { id: 'row-8' }),
    );
  });

  it('discard deletes the persisted draft row alongside the staging dir', async () => {
    mockExists.mockResolvedValue(true);
    const s = await openAndSettle('reply', makeMessage());
    useInlineComposerStore.setState({ session: { ...s, draftId: 'row-7' } });
    useInlineComposerStore.getState().discard({ skipConfirm: true });
    expect(useInlineComposerStore.getState().session).toBeNull();
    await waitFor(() =>
      expect(mockInvoke).toHaveBeenCalledWith('db_delete_draft', { id: 'row-7' }),
    );
  });

  it('popOut deletes the persisted draft row (ownership moved to the pop-out)', async () => {
    const s = await openAndSettle('reply', makeMessage());
    useInlineComposerStore.setState({ session: { ...s, draftId: 'row-9' } });
    useInlineComposerStore.getState().popOut('<p>typed body</p>', undefined);
    await waitFor(() => expect(useComposerStore.getState().isOpen).toBe(true));
    await waitFor(() =>
      expect(mockInvoke).toHaveBeenCalledWith('db_delete_draft', { id: 'row-9' }),
    );
  });

  it('restoreFromDraft rebuilds a session from a persisted row (app-reload resume)', () => {
    useInlineComposerStore.getState().restoreFromDraft(
      {
        id: 'row-1',
        account_id: 'acc-1',
        to_addresses: JSON.stringify(['Bob <bob@example.com>']),
        cc_addresses: null,
        bcc_addresses: null,
        subject: 'Re: Hello',
        body_html: '<p>typed</p>',
        reply_to_message_id: '<mid-1@example.com>',
        thread_id: 't1',
        from_email: 'me@example.com',
        signature_id: null,
        remote_draft_id: null,
        attachments: JSON.stringify([
          {
            filename: 'a.txt',
            mimeType: 'text/plain',
            filePath: '/appdata/outbox-attachments/stage-9/a.txt',
            size: 5,
          },
        ]),
        classification_id: null,
        is_encrypted: 0,
        is_signed: 0,
        importance: 'normal',
        request_read_receipt: 0,
        deliver_at: null,
        prevent_copy: 0,
        extra_headers: null,
        created_at: 100,
        updated_at: 200,
        sync_status: 'local',
      },
      makeMessage(),
      account,
    );
    const s = useInlineComposerStore.getState().session!;
    expect(s.draftId).toBe('row-1');
    expect(s.pristine).toBe(true);
    expect(s.intent).toBe('reply');
    expect(s.to).toEqual([{ name: 'Bob', email: 'bob@example.com' }]);
    expect(s.subject).toBe('Re: Hello');
    expect(s.bodyHtml).toBe('<p>typed</p>');
    expect(s.threadId).toBe('t1');
    expect(s.inReplyToMessageId).toBe('<mid-1@example.com>');
    // Staging dir is recovered from the attachment path (no orphans on send).
    expect(s.stagingDraftId).toBe('stage-9');
    expect(s.attachments[0]).toMatchObject({ filename: 'a.txt', origin: 'picked' });
    // Seed is synthesized so the dock skips the skeleton.
    expect(s.seed).not.toBeNull();
    expect(s.seed?.bodyHtml).toBe('<p>typed</p>');
  });

  it('restoreFromDraft is a no-op when a session already exists', async () => {
    const existing = await openAndSettle('reply', makeMessage());
    useInlineComposerStore
      .getState()
      .restoreFromDraft({ id: 'row-1', thread_id: 't1' } as never, makeMessage(), account);
    const s = useInlineComposerStore.getState().session!;
    expect(s.stagingDraftId).toBe(existing.stagingDraftId);
    expect(s.draftId).toBeNull();
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

  it('same message, forward ↔ reply family change replaces the session (no confirm; outgoing draft preserved)', async () => {
    const confirmSpy = vi.spyOn(window, 'confirm');
    const s1 = await openAndSettle('reply', makeMessage());
    useInlineComposerStore.getState().setSubject('dirty');

    // Clicking Forward with a reply dock open must replace, not silently
    // ignore (bug: the family boundary used to be a no-op).
    await useInlineComposerStore.getState().open('forward', makeMessage(), account);
    expect(confirmSpy).not.toHaveBeenCalled();
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

  it('discard of a restored (persisted) draft confirms even when unedited', async () => {
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(false);
    await openAndSettle('reply', makeMessage());
    useInlineComposerStore.setState({
      session: { ...useInlineComposerStore.getState().session!, draftId: 'row-1', pristine: true },
    });
    useInlineComposerStore.getState().discard();
    // The row is the only copy — discarding it always confirms.
    expect(confirmSpy).toHaveBeenCalled();
    expect(useInlineComposerStore.getState().session).not.toBeNull();
    confirmSpy.mockRestore();
  });

  // ── Anchor model: standalone (message-less) sessions + resumeDraft ──────

  it('resumeDraft without a message builds a standalone new-message session', () => {
    useInlineComposerStore.getState().resumeDraft(draftRow({ thread_id: null }), account);
    const s = useInlineComposerStore.getState().session!;
    expect(s.anchor.kind).toBe('standalone');
    expect(anchorMessage(s)).toBeNull();
    expect(s.intent).toBe('new');
    expect(s.draftId).toBe('row-1');
    expect(s.pristine).toBe(true);
    expect(s.to).toEqual([{ name: 'Bob', email: 'bob@example.com' }]);
    expect(s.bodyHtml).toBe('<p>typed</p>');
    expect(s.threadId).toBeNull();
    expect(s.seed).not.toBeNull();
  });

  it('resumeDraft with a resolved message builds a reply-anchored session', () => {
    useInlineComposerStore.getState().resumeDraft(draftRow(), account, { message: makeMessage() });
    const s = useInlineComposerStore.getState().session!;
    expect(s.anchor.kind).toBe('reply');
    expect(anchorMessage(s)?.id).toBe('msg-1');
    expect(s.intent).toBe('reply');
    expect(s.threadId).toBe('t1');
  });

  it('resumeDraft on the SAME draft is a focus no-op (edits preserved)', async () => {
    useInlineComposerStore.getState().resumeDraft(draftRow(), account, {
      message: makeMessage(),
    });
    useInlineComposerStore.getState().setBodyHtml('<p>edited</p>', { userEdit: true });
    const before = useInlineComposerStore.getState().session!;
    useInlineComposerStore.getState().resumeDraft(draftRow(), account, {
      message: makeMessage(),
    });
    const after = useInlineComposerStore.getState().session!;
    expect(after.stagingDraftId).toBe(before.stagingDraftId);
    expect(after.bodyHtml).toBe('<p>edited</p>');
  });

  it('resumeDraft for a DIFFERENT draft replaces without confirming and preserves the outgoing row', async () => {
    const confirmSpy = vi.spyOn(window, 'confirm');
    await useInlineComposerStore.getState().resumeDraft(draftRow({ id: 'row-a' }), account);
    await useInlineComposerStore.getState().resumeDraft(draftRow({ id: 'row-b' }), account);

    expect(confirmSpy).not.toHaveBeenCalled();
    expect(useInlineComposerStore.getState().session?.draftId).toBe('row-b');
    // The outgoing draft's row is preserved — switching drafts must not
    // destroy the previous one.
    expect(mockInvoke).not.toHaveBeenCalledWith('db_delete_draft', { id: 'row-a' });
    confirmSpy.mockRestore();
  });

  it('resumeDraft restores the persisted forward intent (reply-anchored)', () => {
    useInlineComposerStore
      .getState()
      .resumeDraft(draftRow({ intent: 'forward' }), account, { message: makeMessage() });
    const s = useInlineComposerStore.getState().session!;
    expect(s.intent).toBe('forward');
    expect(s.anchor.kind).toBe('reply');
  });

  it('standalone resume keeps forward but downgrades reply intents to new', () => {
    useInlineComposerStore
      .getState()
      .resumeDraft(draftRow({ intent: 'forward', thread_id: null }), account);
    expect(useInlineComposerStore.getState().session?.intent).toBe('forward');
    expect(useInlineComposerStore.getState().session?.anchor.kind).toBe('standalone');

    useInlineComposerStore.getState().discard({ skipConfirm: true });
    useInlineComposerStore
      .getState()
      .resumeDraft(draftRow({ intent: 'reply', thread_id: null }), account);
    // A reply intent with no source message can't be honored standalone.
    expect(useInlineComposerStore.getState().session?.intent).toBe('new');
  });

  it('switchReplyKind is a no-op for standalone sessions', () => {
    useInlineComposerStore.getState().resumeDraft(draftRow({ thread_id: null }), account);
    const before = useInlineComposerStore.getState().session!;
    useInlineComposerStore.getState().switchReplyKind('replyAll');
    const after = useInlineComposerStore.getState().session!;
    expect(after.intent).toBe('new');
    expect(after.to).toEqual(before.to);
  });

  it('popOut of a standalone session targets mode=new with no threading', async () => {
    useInlineComposerStore
      .getState()
      .resumeDraft(draftRow({ thread_id: null, reply_to_message_id: null }), account);
    useInlineComposerStore.getState().popOut('<p>typed</p>', undefined);
    // Non-Tauri fallback hydrates the composer store via a dynamic import.
    await waitFor(() => expect(useComposerStore.getState().isOpen).toBe(true));
    const modal = useComposerStore.getState();
    expect(modal.mode).toBe('new');
    expect(modal.threadId).toBeNull();
    expect(modal.inReplyToMessageId).toBeNull();
    expect(modal.subject).toBe('Re: Hello');
  });
});
