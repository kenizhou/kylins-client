import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, waitFor, fireEvent, screen, within } from '@testing-library/react';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn(() => Promise.resolve([])) }));

import { MessageList } from '../../../src/components/layout/MessageList';
import { useThreadStore } from '../../../src/stores/threadStore';
import { useFolderStore } from '../../../src/stores/folderStore';
import { useAccountStore } from '../../../src/stores/accountStore';
import { useComposerStore } from '../../../src/stores/composerStore';
import { useInlineComposerStore } from '../../../src/stores/inlineComposerStore';
import { useDraftIndexStore } from '../../../src/stores/draftIndexStore';
import { usePreferencesStore } from '../../../src/stores/preferencesStore';
import { useViewStore } from '../../../src/features/view/viewStore';
import { DEFAULT_VIEW_STATE } from '../../../src/features/view/defaults';
import { getThreads, getMessagesForThread } from '../../../src/services/db/threads';
import { getMessageBody } from '../../../src/services/db/messageBodies';
import { listDraftsForAccount, type DbDraft } from '../../../src/services/composer/drafts';
import { invoke } from '@tauri-apps/api/core';
import type { Thread, DbMessageRow } from '../../../src/services/db/threads';
import type { MailFolder } from '../../../src/services/mail/folders/folderModel';
import type { Account } from '../../../src/types';

// Render every item (no real virtualization) so row logic is testable in jsdom.
vi.mock('@tanstack/react-virtual', () => ({
  useVirtualizer: (opts: { count: number }) => ({
    getVirtualItems: () =>
      Array.from({ length: opts.count }, (_, i) => ({ key: String(i), index: i, start: i * 40 })),
    getTotalSize: () => opts.count * 40,
    measureElement: () => {},
    scrollToIndex: () => {},
  }),
}));

// Keep types/mappers real; stub getThreads and getMessagesForThread so the real store doesn't hit the DB.
vi.mock('../../../src/services/db/threads', async () => {
  const actual = await vi.importActual<typeof import('../../../src/services/db/threads')>(
    '../../../src/services/db/threads',
  );
  return { ...actual, getThreads: vi.fn(), getMessagesForThread: vi.fn() };
});

vi.mock('../../../src/services/db/messageBodies', () => ({
  getMessageBody: vi.fn(),
  setMessageBody: vi.fn(),
  evictBody: vi.fn(),
}));

// Keep the real drafts service (event constant, deleteDraft) but stub the
// account listing so the Drafts-folder rows are test-controlled.
vi.mock('../../../src/services/composer/drafts', async () => {
  const actual = await vi.importActual<typeof import('../../../src/services/composer/drafts')>(
    '../../../src/services/composer/drafts',
  );
  return { ...actual, listDraftsForAccount: vi.fn() };
});

const thread = (over: Partial<Thread> = {}): Thread => ({
  id: 't1',
  accountId: 'a1',
  subject: 'Hello',
  snippet: 'sn',
  lastMessageAt: 100,
  messageCount: 1,
  isRead: false,
  isStarred: false,
  isImportant: false,
  hasAttachments: false,
  isSnoozed: false,
  fromName: 'Bob',
  fromAddress: 'b@x.com',
  ...over,
});

const messageRow = (over: Partial<DbMessageRow> = {}): DbMessageRow => ({
  id: 'm1',
  account_id: 'a1',
  thread_id: 't1',
  from_address: 'b@x.com',
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
  imap_uid: 4242,
  imap_folder: 'INBOX',
  message_id_header: '<msg@m>',
  ...over,
});

const account = (over: Partial<Account> = {}): Account => ({
  id: 'a1',
  email: 'me@x.com',
  provider: 'imap',
  isActive: true,
  isDefault: true,
  sortOrder: 0,
  createdAt: 1,
  updatedAt: 1,
  displayName: 'Me',
  ...over,
});

const dbDraft = (over: Partial<DbDraft> = {}): DbDraft => ({
  id: 'd1',
  account_id: 'a1',
  to_addresses: JSON.stringify(['Alice <alice@x.com>']),
  cc_addresses: null,
  bcc_addresses: null,
  reply_to_addresses: null,
  subject: 'Saved draft subject',
  body_html: '<p>draft body preview</p>',
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

/** Select the Drafts folder (role-mapped) so local drafts surface. */
function selectDraftsFolder() {
  useFolderStore.setState({
    selected: { accountId: 'a1', labelId: 'drafts' },
    byAccount: {
      a1: [{ id: 'drafts', accountId: 'a1', role: 'drafts' } as MailFolder],
    },
  });
}

beforeEach(() => {
  vi.mocked(getThreads).mockReset();
  vi.mocked(getMessagesForThread).mockReset();
  vi.mocked(getMessageBody).mockReset();
  vi.mocked(listDraftsForAccount).mockReset();
  vi.mocked(listDraftsForAccount).mockResolvedValue([]);
  useViewStore.setState({
    ...DEFAULT_VIEW_STATE,
    selectedMessage: null,
    inlineReplyMode: null,
    isHydrated: false,
    selectedThreadIds: [],
  });
  useThreadStore.setState({
    threads: [],
    selectedThreadId: null,
    selectedThreadIds: [],
    selectionAnchorId: null,
    isLoading: false,
    cursor: null,
    currentQuery: null,
  });
  useFolderStore.setState({
    byAccount: {},
    favorites: new Set(),
    unreadCounts: {},
    selected: null,
    isLoading: false,
  });
  useAccountStore.setState({
    accounts: [],
    activeAccountId: null,
    defaultAccountId: null,
  });
  useComposerStore.getState().closeComposer();
  useInlineComposerStore.setState({ session: null });
  useDraftIndexStore.setState({ accountId: null, threadIds: new Set() });
});

describe('MessageList', () => {
  it('renders threads loaded from the store', async () => {
    vi.mocked(getThreads).mockResolvedValue({
      threads: [thread({ id: 't1', subject: 'Hello' }), thread({ id: 't2', subject: 'World' })],
      nextCursor: null,
    });
    useFolderStore.setState({ selected: { accountId: 'a1', labelId: 'inbox' } });
    const { getByText, getAllByText } = render(<MessageList />);
    await waitFor(() => expect(getByText('Hello')).toBeInTheDocument());
    expect(getByText('World')).toBeInTheDocument();
    expect(getAllByText('Bob')).toHaveLength(2); // sender appears on each row
  });

  it('renders only visible columns', async () => {
    vi.mocked(getThreads).mockResolvedValue({
      threads: [thread({ id: 't1', subject: 'Hello', fromName: 'Bob', isStarred: true })],
      nextCursor: null,
    });
    useViewStore.setState({ visibleColumnIds: ['from', 'subject', 'received'] });
    useFolderStore.setState({ selected: { accountId: 'a1', labelId: 'inbox' } });
    const { getByText, queryByLabelText } = render(<MessageList />);
    await waitFor(() => expect(getByText('Hello')).toBeInTheDocument());
    expect(getByText('Bob')).toBeInTheDocument();
    expect(queryByLabelText('Flagged')).not.toBeInTheDocument();
  });

  it('shows the empty state when there are no threads', async () => {
    vi.mocked(getThreads).mockResolvedValue({ threads: [], nextCursor: null });
    useFolderStore.setState({ selected: { accountId: 'a1', labelId: 'inbox' } });
    const { getByText } = render(<MessageList />);
    await waitFor(() => expect(getByText('No messages in this folder.')).toBeInTheDocument());
  });

  it('shows the preview snippet and flag icon for starred threads', async () => {
    vi.mocked(getThreads).mockResolvedValue({
      threads: [
        thread({ id: 't1', subject: 'Hello', snippet: 'Preview text', isStarred: true }),
        thread({ id: 't2', subject: 'World', snippet: 'Another preview', isStarred: false }),
      ],
      nextCursor: null,
    });
    useViewStore.setState({ messageListDensity: 'comfortable' });
    useFolderStore.setState({ selected: { accountId: 'a1', labelId: 'inbox' } });
    const { getByText, getByLabelText, queryAllByLabelText } = render(<MessageList />);
    await waitFor(() => expect(getByText('Preview text')).toBeInTheDocument());
    expect(getByText('Another preview')).toBeInTheDocument();
    expect(getByLabelText('Flagged')).toBeInTheDocument();
    expect(queryAllByLabelText('Flagged')).toHaveLength(1);
  });

  it('shows a [Draft] marker only on the thread with a retained inline draft', async () => {
    vi.mocked(getThreads).mockResolvedValue({
      threads: [
        thread({ id: 't1', subject: 'Hello', snippet: 'Preview text' }),
        thread({ id: 't2', subject: 'World', snippet: 'Another preview' }),
      ],
      nextCursor: null,
    });
    // Retained docked-composer session for t1 (user switched away mid-reply).
    useInlineComposerStore.setState({
      session: { anchor: { kind: 'reply', message: { threadId: 't1' } } } as never,
    });
    useFolderStore.setState({ selected: { accountId: 'a1', labelId: 'inbox' } });
    render(<MessageList />);
    await waitFor(() => expect(screen.getByText('Hello')).toBeInTheDocument());

    const markers = screen.getAllByText('[Draft]');
    expect(markers).toHaveLength(1);
    const draftedRow = screen.getByRole('option', { name: /Hello/ });
    expect(within(draftedRow).getByText('[Draft]')).toBeInTheDocument();
    // Snippet still renders after the marker.
    expect(within(draftedRow).getByText(/Preview text/)).toBeInTheDocument();

    // Clearing the session removes the marker.
    useInlineComposerStore.setState({ session: null });
    await waitFor(() => expect(screen.queryByText('[Draft]')).not.toBeInTheDocument());
  });

  it('shows the [Draft] marker even when the thread has no snippet', async () => {
    vi.mocked(getThreads).mockResolvedValue({
      threads: [thread({ id: 't1', subject: 'Hello', snippet: '' })],
      nextCursor: null,
    });
    useInlineComposerStore.setState({
      session: { anchor: { kind: 'reply', message: { threadId: 't1' } } } as never,
    });
    useFolderStore.setState({ selected: { accountId: 'a1', labelId: 'inbox' } });
    render(<MessageList />);
    await waitFor(() => expect(screen.getByText('[Draft]')).toBeInTheDocument());
  });

  it('shows the [Draft] marker on threads with a saved local draft (persists across reloads)', async () => {
    vi.mocked(getThreads).mockResolvedValue({
      threads: [thread({ id: 't1', subject: 'Hello' }), thread({ id: 't2', subject: 'World' })],
      nextCursor: null,
    });
    // The draft index is what survives an app restart: the inline session is
    // memory-only, but the persisted local_drafts row maps thread → chip.
    useDraftIndexStore.setState({ accountId: 'a1', threadIds: new Set(['t1']) });
    useFolderStore.setState({ selected: { accountId: 'a1', labelId: 'inbox' } });
    render(<MessageList />);
    await waitFor(() => expect(screen.getByText('Hello')).toBeInTheDocument());

    const markers = screen.getAllByText('[Draft]');
    expect(markers).toHaveLength(1);
    const draftedRow = screen.getByRole('option', { name: /Hello/ });
    expect(within(draftedRow).getByText('[Draft]')).toBeInTheDocument();

    // Removing the thread from the index clears the chip.
    useDraftIndexStore.setState({ accountId: 'a1', threadIds: new Set() });
    await waitFor(() => expect(screen.queryByText('[Draft]')).not.toBeInTheDocument());
  });

  it('lists saved local drafts in the Drafts folder with a [Draft] chip', async () => {
    vi.mocked(getThreads).mockResolvedValue({ threads: [], nextCursor: null });
    vi.mocked(listDraftsForAccount).mockResolvedValue([dbDraft()]);
    selectDraftsFolder();
    render(<MessageList />);
    await waitFor(() => expect(screen.getByText('Saved draft subject')).toBeInTheDocument());
    expect(screen.getByText('[Draft]')).toBeInTheDocument();
    // Recipients take the sender slot; the body becomes the snippet.
    expect(screen.getByText('Alice <alice@x.com>')).toBeInTheDocument();
    expect(screen.getByText('draft body preview')).toBeInTheDocument();
  });

  it('does not load local drafts outside the Drafts folder', async () => {
    vi.mocked(getThreads).mockResolvedValue({
      threads: [thread({ id: 't1', subject: 'Hello' })],
      nextCursor: null,
    });
    useFolderStore.setState({ selected: { accountId: 'a1', labelId: 'inbox' } });
    render(<MessageList />);
    await waitFor(() => expect(screen.getByText('Hello')).toBeInTheDocument());
    expect(listDraftsForAccount).not.toHaveBeenCalled();
  });

  it('single click resumes the saved draft in the reading pane (inline dock)', async () => {
    vi.mocked(getThreads).mockResolvedValue({ threads: [], nextCursor: null });
    vi.mocked(listDraftsForAccount).mockResolvedValue([dbDraft()]);
    selectDraftsFolder();
    render(<MessageList />);
    await waitFor(() => expect(screen.getByText('Saved draft subject')).toBeInTheDocument());

    fireEvent.click(screen.getByText('Saved draft subject'));
    await waitFor(() => expect(useInlineComposerStore.getState().session).not.toBeNull());
    const session = useInlineComposerStore.getState().session!;
    expect(session?.draftId).toBe('d1');
    expect(session?.subject).toBe('Saved draft subject');
    expect(session?.bodyHtml).toBe('<p>draft body preview</p>');
    expect(session?.to.map((r) => r.email)).toEqual(['alice@x.com']);
    // No thread on the fixture → standalone anchor; the draft row is the
    // reading-pane target (and no modal/window composer was opened).
    expect(session?.anchor.kind).toBe('standalone');
    expect(useViewStore.getState().selectedDraftId).toBe('d1');
    expect(useComposerStore.getState().isOpen).toBe(false);
  });

  it('double click opens the saved draft in the composer window', async () => {
    vi.mocked(getThreads).mockResolvedValue({ threads: [], nextCursor: null });
    vi.mocked(listDraftsForAccount).mockResolvedValue([dbDraft()]);
    selectDraftsFolder();
    render(<MessageList />);
    await waitFor(() => expect(screen.getByText('Saved draft subject')).toBeInTheDocument());

    fireEvent.doubleClick(screen.getByText('Saved draft subject'));
    // No live dock session → plain window open (non-Tauri fallback hydrates
    // the composer store). The inline dock stays empty.
    await waitFor(() => expect(useComposerStore.getState().isOpen).toBe(true));
    expect(useComposerStore.getState().draftId).toBe('d1');
    expect(useComposerStore.getState().subject).toBe('Saved draft subject');
    expect(useInlineComposerStore.getState().session).toBeNull();
  });

  it('deletes a saved draft from the context menu and removes the row', async () => {
    vi.mocked(getThreads).mockResolvedValue({ threads: [], nextCursor: null });
    vi.mocked(listDraftsForAccount).mockResolvedValueOnce([dbDraft()]).mockResolvedValue([]); // reload after DRAFTS_CHANGED
    selectDraftsFolder();
    render(<MessageList />);
    await waitFor(() => expect(screen.getByText('Saved draft subject')).toBeInTheDocument());

    fireEvent.contextMenu(screen.getByText('Saved draft subject'));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Delete Draft' }));

    await waitFor(() =>
      expect(vi.mocked(invoke)).toHaveBeenCalledWith('db_delete_draft', { id: 'd1' }),
    );
    await waitFor(() => expect(screen.queryByText('Saved draft subject')).not.toBeInTheDocument());
  });

  it('Delete Draft also discards the live dock session (no resurrection)', async () => {
    vi.mocked(getThreads).mockResolvedValue({ threads: [], nextCursor: null });
    vi.mocked(listDraftsForAccount).mockResolvedValueOnce([dbDraft()]).mockResolvedValue([]); // reload after DRAFTS_CHANGED
    selectDraftsFolder();
    render(<MessageList />);
    await waitFor(() => expect(screen.getByText('Saved draft subject')).toBeInTheDocument());

    // Resume the draft into the dock first.
    fireEvent.click(screen.getByText('Saved draft subject'));
    await waitFor(() => expect(useInlineComposerStore.getState().session).not.toBeNull());

    fireEvent.contextMenu(screen.getByText('Saved draft subject'));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Delete Draft' }));

    // The dock session is gone (its autosave can no longer resurrect the row)
    // and the row was deleted.
    expect(useInlineComposerStore.getState().session).toBeNull();
    await waitFor(() =>
      expect(vi.mocked(invoke)).toHaveBeenCalledWith('db_delete_draft', { id: 'd1' }),
    );
    await waitFor(() => expect(screen.queryByText('Saved draft subject')).not.toBeInTheDocument());
  });

  it('reloads threads when the folder selection changes', async () => {
    vi.mocked(getThreads).mockResolvedValue({ threads: [], nextCursor: null });
    useFolderStore.setState({ selected: { accountId: 'a1', labelId: 'inbox' } });
    render(<MessageList />);
    await waitFor(() => expect(getThreads).toHaveBeenCalledWith('a1', { labelId: 'inbox' }));

    useFolderStore.setState({ selected: { accountId: 'a1', labelId: 'sent' } });
    await waitFor(() => expect(getThreads).toHaveBeenCalledWith('a1', { labelId: 'sent' }));
  });

  it('opens an expanded Outlook-style context menu on right-click', async () => {
    vi.mocked(getThreads).mockResolvedValue({
      threads: [thread({ id: 't1', subject: 'Hello' })],
      nextCursor: null,
    });
    useFolderStore.setState({ selected: { accountId: 'a1', labelId: 'inbox' } });
    render(<MessageList />);
    await waitFor(() => expect(screen.getByText('Hello')).toBeInTheDocument());

    fireEvent.contextMenu(screen.getByText('Hello'));
    const items = screen.getAllByRole('menuitem');
    expect(items.map((i) => i.textContent)).toEqual([
      'Copy',
      'Quick Print',
      'Reply',
      'Reply All',
      'Forward',
      'Mark as Read',
      'Categorize',
      'Follow Up',
      'Find Related',
      'Rules',
      'Move',
      'Junk',
      'Delete',
      'Archive',
    ]);
    expect(items[0]).toHaveAttribute('aria-disabled', 'true'); // Copy placeholder
    expect(items[items.length - 2]).not.toHaveAttribute('aria-disabled', 'true'); // Delete
    expect(items[items.length - 1]).not.toHaveAttribute('aria-disabled', 'true'); // Archive
  });

  it('marks a thread as unread from the context menu', async () => {
    vi.mocked(getThreads).mockResolvedValue({
      threads: [thread({ id: 't1', subject: 'Hello', isRead: true })],
      nextCursor: null,
    });
    useFolderStore.setState({ selected: { accountId: 'a1', labelId: 'inbox' } });
    const markThreadsRead = vi.spyOn(useThreadStore.getState(), 'markThreadsRead');
    render(<MessageList />);
    await waitFor(() => expect(screen.getByText('Hello')).toBeInTheDocument());

    fireEvent.contextMenu(screen.getByText('Hello'));
    const item = screen.getByRole('menuitem', { name: 'Mark as Unread' });
    fireEvent.click(item);
    expect(markThreadsRead).toHaveBeenCalledWith(
      [expect.objectContaining({ id: 't1', isRead: true })],
      false,
    );
    markThreadsRead.mockRestore();
  });

  it('deletes a thread from the context menu', async () => {
    vi.mocked(getThreads).mockResolvedValue({
      threads: [thread({ id: 't1', subject: 'Hello' })],
      nextCursor: null,
    });
    vi.mocked(getMessagesForThread).mockResolvedValue([]);
    useFolderStore.setState({ selected: { accountId: 'a1', labelId: 'inbox' } });
    const deleteThreads = vi.spyOn(useThreadStore.getState(), 'deleteThreads');
    render(<MessageList />);
    await waitFor(() => expect(screen.getByText('Hello')).toBeInTheDocument());

    fireEvent.contextMenu(screen.getByText('Hello'));
    const item = screen.getByRole('menuitem', { name: 'Delete' });
    fireEvent.click(item);
    expect(deleteThreads).toHaveBeenCalledWith([expect.objectContaining({ id: 't1' })]);
    deleteThreads.mockRestore();
  });

  it('archives a thread from the context menu', async () => {
    vi.mocked(getThreads).mockResolvedValue({
      threads: [thread({ id: 't1', subject: 'Hello' })],
      nextCursor: null,
    });
    useFolderStore.setState({ selected: { accountId: 'a1', labelId: 'inbox' } });
    const archiveThreads = vi.spyOn(
      await import('../../../src/services/mail/actions'),
      'archiveThreads',
    );
    render(<MessageList />);
    await waitFor(() => expect(screen.getByText('Hello')).toBeInTheDocument());

    fireEvent.contextMenu(screen.getByText('Hello'));
    const item = screen.getByRole('menuitem', { name: 'Archive' });
    fireEvent.click(item);
    expect(archiveThreads).toHaveBeenCalledWith([expect.objectContaining({ id: 't1' })]);
    archiveThreads.mockRestore();
  });

  it('shows hover quick actions and archives on click', async () => {
    vi.mocked(getThreads).mockResolvedValue({
      threads: [thread({ id: 't1', subject: 'Hello', isRead: true })],
      nextCursor: null,
    });
    useFolderStore.setState({ selected: { accountId: 'a1', labelId: 'inbox' } });
    const archiveThread = vi.spyOn(
      await import('../../../src/services/mail/actions'),
      'archiveThread',
    );
    render(<MessageList />);
    await waitFor(() => expect(screen.getByText('Hello')).toBeInTheDocument());

    const row = screen.getByRole('option');
    const actions = within(row).getByTestId('message-quick-actions');
    expect(actions.classList.contains('hidden')).toBe(true);
    expect(actions.classList.contains('flex')).toBe(false);

    fireEvent.mouseEnter(row);
    expect(actions.classList.contains('hidden')).toBe(false);
    expect(actions.classList.contains('flex')).toBe(true);

    const archiveBtn = within(actions).getByRole('button', { name: 'Archive' });
    fireEvent.click(archiveBtn);
    expect(archiveThread).toHaveBeenCalledWith(expect.objectContaining({ id: 't1' }));
    archiveThread.mockRestore();
  });

  it('toggles the star / follow-up flag from the context menu', async () => {
    vi.mocked(getThreads).mockResolvedValue({
      threads: [thread({ id: 't1', subject: 'Hello', isStarred: false })],
      nextCursor: null,
    });
    useFolderStore.setState({ selected: { accountId: 'a1', labelId: 'inbox' } });
    const setThreadsStarred = vi.spyOn(useThreadStore.getState(), 'setThreadsStarred');
    render(<MessageList />);
    await waitFor(() => expect(screen.getByText('Hello')).toBeInTheDocument());

    fireEvent.contextMenu(screen.getByText('Hello'));
    const item = screen.getByRole('menuitem', { name: 'Follow Up' });
    fireEvent.click(item);
    expect(setThreadsStarred).toHaveBeenCalledWith([expect.objectContaining({ id: 't1' })], true);
    setThreadsStarred.mockRestore();
  });

  it('opens the composer window in reply mode from the context menu', async () => {
    vi.mocked(getThreads).mockResolvedValue({
      threads: [thread({ id: 't1', subject: 'Hello' })],
      nextCursor: null,
    });
    vi.mocked(getMessagesForThread).mockResolvedValue([messageRow()]);
    vi.mocked(getMessageBody).mockResolvedValue({
      accountId: 'a1',
      messageId: 'm1',
      bodyHtml: '<p>body</p>',
      fetchedAt: 1,
    });
    useAccountStore.setState({
      accounts: [account()],
      activeAccountId: 'a1',
      defaultAccountId: 'a1',
    });
    usePreferencesStore.setState({ defaultReplyBehavior: 'reply' });
    useFolderStore.setState({ selected: { accountId: 'a1', labelId: 'inbox' } });
    render(<MessageList />);
    await waitFor(() => expect(screen.getByText('Hello')).toBeInTheDocument());

    fireEvent.contextMenu(screen.getByText('Hello'));
    const item = screen.getByRole('menuitem', { name: 'Reply' });
    fireEvent.click(item);
    await waitFor(() => expect(useComposerStore.getState().isOpen).toBe(true));
    expect(useComposerStore.getState().mode).toBe('reply');
    expect(useComposerStore.getState().threadId).toBe('t1');
    // Ribbon/context-menu replies open the composer window — no dock session.
    expect(useInlineComposerStore.getState().session).toBeNull();
  });

  it('shows All/Unread tabs in the inbox and filters threads', async () => {
    vi.mocked(getThreads).mockResolvedValue({
      threads: [
        thread({ id: 't1', subject: 'Unread message', isRead: false }),
        thread({ id: 't2', subject: 'Read message', isRead: true }),
      ],
      nextCursor: null,
    });
    useFolderStore.setState({
      selected: { accountId: 'a1', labelId: 'inbox' },
      byAccount: {
        a1: [{ id: 'inbox', accountId: 'a1', role: 'inbox' } as MailFolder],
      },
    });
    render(<MessageList />);
    await waitFor(() => expect(screen.getByRole('tab', { name: 'All' })).toBeInTheDocument());
    expect(screen.getByText('Unread message')).toBeInTheDocument();
    expect(screen.getByText('Read message')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('tab', { name: 'Unread' }));
    await waitFor(() => expect(screen.queryByText('Read message')).not.toBeInTheDocument());
    expect(screen.getByText('Unread message')).toBeInTheDocument();
  });

  it('does not show All/Unread tabs outside the inbox', async () => {
    vi.mocked(getThreads).mockResolvedValue({
      threads: [thread({ id: 't1', subject: 'Hello', isRead: true })],
      nextCursor: null,
    });
    useFolderStore.setState({
      selected: { accountId: 'a1', labelId: 'sent' },
      byAccount: {
        a1: [{ id: 'sent', accountId: 'a1', role: 'sent' } as MailFolder],
      },
    });
    render(<MessageList />);
    await waitFor(() => expect(screen.getByText('Hello')).toBeInTheDocument());
    expect(screen.queryByRole('tab', { name: 'All' })).not.toBeInTheDocument();
    expect(screen.queryByRole('tab', { name: 'Unread' })).not.toBeInTheDocument();
  });

  it('shows the All/Unread empty state when the active tab is empty', async () => {
    vi.mocked(getThreads).mockResolvedValue({ threads: [], nextCursor: null });
    useFolderStore.setState({
      selected: { accountId: 'a1', labelId: 'inbox' },
      byAccount: {
        a1: [{ id: 'inbox', accountId: 'a1', role: 'inbox' } as MailFolder],
      },
    });
    render(<MessageList />);
    await waitFor(() => expect(screen.getByRole('tab', { name: 'All' })).toBeInTheDocument());
    expect(screen.getByText('No messages in this folder.')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('tab', { name: 'Unread' }));
    await waitFor(() => expect(screen.getByText('No unread messages.')).toBeInTheDocument());
  });

  it('keeps loading when the Unread tab is empty but more pages exist', async () => {
    vi.mocked(getThreads).mockResolvedValue({
      threads: [thread({ id: 't1', subject: 'Unread only', isRead: false })],
      nextCursor: 'cursor-1',
    });
    const loadMore = vi.spyOn(useThreadStore.getState(), 'loadMore').mockResolvedValue(undefined);
    useFolderStore.setState({
      selected: { accountId: 'a1', labelId: 'inbox' },
      byAccount: {
        a1: [{ id: 'inbox', accountId: 'a1', role: 'inbox' } as MailFolder],
      },
    });
    render(<MessageList />);
    await waitFor(() => expect(screen.getByText('Unread only')).toBeInTheDocument());

    fireEvent.click(screen.getByRole('tab', { name: 'Unread' }));
    await waitFor(() => expect(loadMore).toHaveBeenCalled());
    loadMore.mockRestore();
  });

  it('exposes aria-multiselectable on the listbox', async () => {
    vi.mocked(getThreads).mockResolvedValue({
      threads: [thread({ id: 't1', subject: 'Hello' })],
      nextCursor: null,
    });
    useFolderStore.setState({ selected: { accountId: 'a1', labelId: 'inbox' } });
    render(<MessageList />);
    await waitFor(() => expect(screen.getByText('Hello')).toBeInTheDocument());
    expect(screen.getByRole('listbox')).toHaveAttribute('aria-multiselectable', 'true');
  });

  it('ctrl+click toggles rows in and out of the selection', async () => {
    vi.mocked(getThreads).mockResolvedValue({
      threads: [thread({ id: 't1', subject: 'Hello' }), thread({ id: 't2', subject: 'World' })],
      nextCursor: null,
    });
    vi.mocked(getMessagesForThread).mockResolvedValue([]);
    useFolderStore.setState({ selected: { accountId: 'a1', labelId: 'inbox' } });
    render(<MessageList />);
    await waitFor(() => expect(screen.getByText('Hello')).toBeInTheDocument());

    fireEvent.click(screen.getByText('Hello'));
    await waitFor(() => expect(useThreadStore.getState().selectedThreadIds).toEqual(['t1']));

    fireEvent.click(screen.getByText('World'), { ctrlKey: true });
    await waitFor(() => expect(useThreadStore.getState().selectedThreadIds).toEqual(['t1', 't2']));
    // The ctrl-clicked-in row becomes the anchor (reading-pane target).
    expect(useThreadStore.getState().selectedThreadId).toBe('t2');
    const options = screen.getAllByRole('option');
    expect(options[0]).toHaveAttribute('aria-selected', 'true');
    expect(options[1]).toHaveAttribute('aria-selected', 'true');

    // Ctrl+click the anchor again: toggled out, anchor falls back to t1.
    fireEvent.click(screen.getByText('World'), { ctrlKey: true });
    await waitFor(() => expect(useThreadStore.getState().selectedThreadIds).toEqual(['t1']));
    expect(useThreadStore.getState().selectedThreadId).toBe('t1');
  });

  it('shift+click selects the range from the anchor', async () => {
    vi.mocked(getThreads).mockResolvedValue({
      threads: [
        thread({ id: 't1', subject: 'One' }),
        thread({ id: 't2', subject: 'Two' }),
        thread({ id: 't3', subject: 'Three' }),
      ],
      nextCursor: null,
    });
    vi.mocked(getMessagesForThread).mockResolvedValue([]);
    useFolderStore.setState({ selected: { accountId: 'a1', labelId: 'inbox' } });
    render(<MessageList />);
    await waitFor(() => expect(screen.getByText('One')).toBeInTheDocument());

    fireEvent.click(screen.getByText('One'));
    await waitFor(() => expect(useThreadStore.getState().selectedThreadIds).toEqual(['t1']));

    fireEvent.click(screen.getByText('Three'), { shiftKey: true });
    await waitFor(() =>
      expect(useThreadStore.getState().selectedThreadIds).toEqual(['t1', 't2', 't3']),
    );
    // The anchor does not move on shift+click.
    expect(useThreadStore.getState().selectionAnchorId).toBe('t1');
  });

  it('plain click collapses a multi-selection', async () => {
    vi.mocked(getThreads).mockResolvedValue({
      threads: [
        thread({ id: 't1', subject: 'One' }),
        thread({ id: 't2', subject: 'Two' }),
        thread({ id: 't3', subject: 'Three' }),
      ],
      nextCursor: null,
    });
    vi.mocked(getMessagesForThread).mockResolvedValue([]);
    useFolderStore.setState({ selected: { accountId: 'a1', labelId: 'inbox' } });
    render(<MessageList />);
    await waitFor(() => expect(screen.getByText('One')).toBeInTheDocument());

    fireEvent.click(screen.getByText('One'));
    fireEvent.click(screen.getByText('Two'), { ctrlKey: true });
    await waitFor(() => expect(useThreadStore.getState().selectedThreadIds).toEqual(['t1', 't2']));

    fireEvent.click(screen.getByText('Three'));
    await waitFor(() => expect(useThreadStore.getState().selectedThreadIds).toEqual(['t3']));
  });

  it('right-click on a selected row keeps the multi-selection', async () => {
    vi.mocked(getThreads).mockResolvedValue({
      threads: [thread({ id: 't1', subject: 'Hello' }), thread({ id: 't2', subject: 'World' })],
      nextCursor: null,
    });
    vi.mocked(getMessagesForThread).mockResolvedValue([]);
    useFolderStore.setState({ selected: { accountId: 'a1', labelId: 'inbox' } });
    render(<MessageList />);
    await waitFor(() => expect(screen.getByText('Hello')).toBeInTheDocument());

    fireEvent.click(screen.getByText('Hello'));
    fireEvent.click(screen.getByText('World'), { ctrlKey: true });
    await waitFor(() => expect(useThreadStore.getState().selectedThreadIds).toEqual(['t1', 't2']));

    fireEvent.contextMenu(screen.getByText('World'));
    expect(useThreadStore.getState().selectedThreadIds).toEqual(['t1', 't2']);
    expect(screen.getByRole('menuitem', { name: /Delete/ })).toBeInTheDocument();
  });

  it('right-click on an unselected row collapses to that row first', async () => {
    vi.mocked(getThreads).mockResolvedValue({
      threads: [
        thread({ id: 't1', subject: 'One' }),
        thread({ id: 't2', subject: 'Two' }),
        thread({ id: 't3', subject: 'Three' }),
      ],
      nextCursor: null,
    });
    vi.mocked(getMessagesForThread).mockResolvedValue([]);
    useFolderStore.setState({ selected: { accountId: 'a1', labelId: 'inbox' } });
    render(<MessageList />);
    await waitFor(() => expect(screen.getByText('One')).toBeInTheDocument());

    fireEvent.click(screen.getByText('One'));
    await waitFor(() => expect(useThreadStore.getState().selectedThreadIds).toEqual(['t1']));

    fireEvent.contextMenu(screen.getByText('Three'));
    await waitFor(() => expect(useThreadStore.getState().selectedThreadIds).toEqual(['t3']));
  });

  it('ctrl+A selects all loaded threads', async () => {
    vi.mocked(getThreads).mockResolvedValue({
      threads: [
        thread({ id: 't1', subject: 'One' }),
        thread({ id: 't2', subject: 'Two' }),
        thread({ id: 't3', subject: 'Three' }),
      ],
      nextCursor: null,
    });
    vi.mocked(getMessagesForThread).mockResolvedValue([]);
    useFolderStore.setState({ selected: { accountId: 'a1', labelId: 'inbox' } });
    render(<MessageList />);
    await waitFor(() => expect(screen.getByText('One')).toBeInTheDocument());

    fireEvent.keyDown(screen.getByRole('listbox'), { key: 'a', ctrlKey: true });

    await waitFor(() =>
      expect(useThreadStore.getState().selectedThreadIds).toEqual(['t1', 't2', 't3']),
    );
    // No prior anchor — falls back to the first row.
    expect(useThreadStore.getState().selectionAnchorId).toBe('t1');
  });

  it('shift+arrow extends and shrinks the selection from the anchor', async () => {
    vi.mocked(getThreads).mockResolvedValue({
      threads: [
        thread({ id: 't1', subject: 'One' }),
        thread({ id: 't2', subject: 'Two' }),
        thread({ id: 't3', subject: 'Three' }),
      ],
      nextCursor: null,
    });
    vi.mocked(getMessagesForThread).mockResolvedValue([]);
    useFolderStore.setState({ selected: { accountId: 'a1', labelId: 'inbox' } });
    render(<MessageList />);
    await waitFor(() => expect(screen.getByText('One')).toBeInTheDocument());

    fireEvent.click(screen.getByText('One'));
    await waitFor(() => expect(useThreadStore.getState().selectedThreadIds).toEqual(['t1']));

    const listbox = screen.getByRole('listbox');
    fireEvent.keyDown(listbox, { key: 'ArrowDown', shiftKey: true });
    await waitFor(() => expect(useThreadStore.getState().selectedThreadIds).toEqual(['t1', 't2']));

    fireEvent.keyDown(listbox, { key: 'ArrowDown', shiftKey: true });
    await waitFor(() =>
      expect(useThreadStore.getState().selectedThreadIds).toEqual(['t1', 't2', 't3']),
    );
    // Anchor fixed; reading pane keeps showing the anchor.
    expect(useThreadStore.getState().selectionAnchorId).toBe('t1');
    expect(useThreadStore.getState().selectedThreadId).toBe('t1');

    fireEvent.keyDown(listbox, { key: 'ArrowUp', shiftKey: true });
    await waitFor(() => expect(useThreadStore.getState().selectedThreadIds).toEqual(['t1', 't2']));
  });

  it('plain arrow collapses the selection to the next single row', async () => {
    vi.mocked(getThreads).mockResolvedValue({
      threads: [
        thread({ id: 't1', subject: 'One' }),
        thread({ id: 't2', subject: 'Two' }),
        thread({ id: 't3', subject: 'Three' }),
      ],
      nextCursor: null,
    });
    vi.mocked(getMessagesForThread).mockResolvedValue([]);
    useFolderStore.setState({ selected: { accountId: 'a1', labelId: 'inbox' } });
    render(<MessageList />);
    await waitFor(() => expect(screen.getByText('One')).toBeInTheDocument());

    fireEvent.click(screen.getByText('One'));
    fireEvent.click(screen.getByText('Two'), { ctrlKey: true });
    await waitFor(() => expect(useThreadStore.getState().selectedThreadIds).toEqual(['t1', 't2']));

    fireEvent.keyDown(screen.getByRole('listbox'), { key: 'ArrowDown' });
    await waitFor(() => expect(useThreadStore.getState().selectedThreadIds).toEqual(['t3']));
  });

  it('shows count labels and applies Delete to the whole multi-selection', async () => {
    vi.mocked(getThreads).mockResolvedValue({
      threads: [thread({ id: 't1', subject: 'Hello' }), thread({ id: 't2', subject: 'World' })],
      nextCursor: null,
    });
    vi.mocked(getMessagesForThread).mockResolvedValue([]);
    useFolderStore.setState({ selected: { accountId: 'a1', labelId: 'inbox' } });
    render(<MessageList />);
    await waitFor(() => expect(screen.getByText('Hello')).toBeInTheDocument());

    fireEvent.click(screen.getByText('Hello'));
    fireEvent.click(screen.getByText('World'), { ctrlKey: true });
    await waitFor(() => expect(useThreadStore.getState().selectedThreadIds).toEqual(['t1', 't2']));

    fireEvent.contextMenu(screen.getByText('World'));
    expect(screen.getByRole('menuitem', { name: 'Delete 2 conversations' })).toBeInTheDocument();
    expect(screen.getByRole('menuitem', { name: 'Archive 2 conversations' })).toBeInTheDocument();
    expect(screen.getByRole('menuitem', { name: 'Mark 2 as Read' })).toBeInTheDocument();
    expect(screen.getByRole('menuitem', { name: 'Follow up 2 conversations' })).toBeInTheDocument();
    expect(screen.getByRole('menuitem', { name: 'Move 2 conversations…' })).toBeInTheDocument();

    const deleteThreads = vi.spyOn(useThreadStore.getState(), 'deleteThreads');
    fireEvent.click(screen.getByRole('menuitem', { name: 'Delete 2 conversations' }));
    expect(deleteThreads).toHaveBeenCalledWith([
      expect.objectContaining({ id: 't1' }),
      expect.objectContaining({ id: 't2' }),
    ]);
    deleteThreads.mockRestore();
  });

  it('applies Mark as Unread to the whole multi-selection following the clicked row', async () => {
    vi.mocked(getThreads).mockResolvedValue({
      threads: [
        thread({ id: 't1', subject: 'Hello', isRead: true }),
        thread({ id: 't2', subject: 'World', isRead: false }),
      ],
      nextCursor: null,
    });
    vi.mocked(getMessagesForThread).mockResolvedValue([]);
    useFolderStore.setState({ selected: { accountId: 'a1', labelId: 'inbox' } });
    render(<MessageList />);
    await waitFor(() => expect(screen.getByText('Hello')).toBeInTheDocument());

    fireEvent.click(screen.getByText('Hello'));
    fireEvent.click(screen.getByText('World'), { ctrlKey: true });
    await waitFor(() => expect(useThreadStore.getState().selectedThreadIds).toEqual(['t1', 't2']));

    fireEvent.contextMenu(screen.getByText('Hello'));
    const markThreadsRead = vi.spyOn(useThreadStore.getState(), 'markThreadsRead');
    fireEvent.click(screen.getByRole('menuitem', { name: 'Mark 2 as Unread' }));
    expect(markThreadsRead).toHaveBeenCalledWith(
      [expect.objectContaining({ id: 't1' }), expect.objectContaining({ id: 't2' })],
      false,
    );
    markThreadsRead.mockRestore();
  });
});
