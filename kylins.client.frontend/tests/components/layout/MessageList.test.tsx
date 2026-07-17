import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, waitFor, fireEvent, screen } from '@testing-library/react';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn(() => Promise.resolve([])) }));

import { MessageList } from '../../../src/components/layout/MessageList';
import { useThreadStore } from '../../../src/stores/threadStore';
import { useFolderStore } from '../../../src/stores/folderStore';
import { useAccountStore } from '../../../src/stores/accountStore';
import { useComposerStore } from '../../../src/stores/composerStore';
import { usePreferencesStore } from '../../../src/stores/preferencesStore';
import { useViewStore } from '../../../src/features/view/viewStore';
import { DEFAULT_VIEW_STATE } from '../../../src/features/view/defaults';
import { getThreads, getMessagesForThread } from '../../../src/services/db/threads';
import { getMessageBody } from '../../../src/services/db/messageBodies';
import type { Thread, DbMessageRow } from '../../../src/services/db/threads';
import type { Account } from '../../../src/types';

// Render every item (no real virtualization) so row logic is testable in jsdom.
vi.mock('@tanstack/react-virtual', () => ({
  useVirtualizer: (opts: { count: number }) => ({
    getVirtualItems: () =>
      Array.from({ length: opts.count }, (_, i) => ({ key: String(i), index: i, start: i * 40 })),
    getTotalSize: () => opts.count * 40,
    measureElement: () => {},
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
  is_encrypted: 0,
  is_signed: 0,
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

beforeEach(() => {
  vi.mocked(getThreads).mockReset();
  vi.mocked(getMessagesForThread).mockReset();
  vi.mocked(getMessageBody).mockReset();
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
  });

  it('marks a thread as unread from the context menu', async () => {
    vi.mocked(getThreads).mockResolvedValue({
      threads: [thread({ id: 't1', subject: 'Hello', isRead: true })],
      nextCursor: null,
    });
    useFolderStore.setState({ selected: { accountId: 'a1', labelId: 'inbox' } });
    const markThreadRead = vi.spyOn(useThreadStore.getState(), 'markThreadRead');
    render(<MessageList />);
    await waitFor(() => expect(screen.getByText('Hello')).toBeInTheDocument());

    fireEvent.contextMenu(screen.getByText('Hello'));
    const item = screen.getByRole('menuitem', { name: 'Mark as Unread' });
    fireEvent.click(item);
    expect(markThreadRead).toHaveBeenCalledWith(
      expect.objectContaining({ id: 't1', isRead: true }),
      false,
    );
    markThreadRead.mockRestore();
  });

  it('deletes a thread from the context menu', async () => {
    vi.mocked(getThreads).mockResolvedValue({
      threads: [thread({ id: 't1', subject: 'Hello' })],
      nextCursor: null,
    });
    vi.mocked(getMessagesForThread).mockResolvedValue([]);
    useFolderStore.setState({ selected: { accountId: 'a1', labelId: 'inbox' } });
    const deleteThread = vi.spyOn(useThreadStore.getState(), 'deleteThread');
    render(<MessageList />);
    await waitFor(() => expect(screen.getByText('Hello')).toBeInTheDocument());

    fireEvent.contextMenu(screen.getByText('Hello'));
    const item = screen.getByRole('menuitem', { name: 'Delete' });
    fireEvent.click(item);
    expect(deleteThread).toHaveBeenCalledWith(expect.objectContaining({ id: 't1' }));
    deleteThread.mockRestore();
  });

  it('toggles the star / follow-up flag from the context menu', async () => {
    vi.mocked(getThreads).mockResolvedValue({
      threads: [thread({ id: 't1', subject: 'Hello', isStarred: false })],
      nextCursor: null,
    });
    useFolderStore.setState({ selected: { accountId: 'a1', labelId: 'inbox' } });
    const toggleThreadStarred = vi.spyOn(useThreadStore.getState(), 'toggleThreadStarred');
    render(<MessageList />);
    await waitFor(() => expect(screen.getByText('Hello')).toBeInTheDocument());

    fireEvent.contextMenu(screen.getByText('Hello'));
    const item = screen.getByRole('menuitem', { name: 'Follow Up' });
    fireEvent.click(item);
    expect(toggleThreadStarred).toHaveBeenCalledWith(expect.objectContaining({ id: 't1' }));
    toggleThreadStarred.mockRestore();
  });

  it('opens the composer in reply mode from the context menu', async () => {
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
  });
});
