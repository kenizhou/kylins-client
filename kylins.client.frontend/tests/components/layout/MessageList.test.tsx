import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, waitFor } from '@testing-library/react';
import { MessageList } from '../../../src/components/layout/MessageList';
import { useThreadStore } from '../../../src/stores/threadStore';
import { useFolderStore } from '../../../src/stores/folderStore';
import { getThreads } from '../../../src/services/db/threads';
import type { Thread } from '../../../src/services/db/threads';

// Render every item (no real virtualization) so row logic is testable in jsdom.
vi.mock('@tanstack/react-virtual', () => ({
  useVirtualizer: (opts: { count: number }) => ({
    getVirtualItems: () =>
      Array.from({ length: opts.count }, (_, i) => ({ key: String(i), index: i, start: i * 40 })),
    getTotalSize: () => opts.count * 40,
    measureElement: () => {},
  }),
}));

// Keep types/mappers real; stub getThreads so the real store doesn't hit the DB.
vi.mock('../../../src/services/db/threads', async () => {
  const actual = await vi.importActual<typeof import('../../../src/services/db/threads')>(
    '../../../src/services/db/threads',
  );
  return { ...actual, getThreads: vi.fn() };
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

beforeEach(() => {
  vi.mocked(getThreads).mockReset();
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

  it('shows the empty state when there are no threads', async () => {
    vi.mocked(getThreads).mockResolvedValue({ threads: [], nextCursor: null });
    useFolderStore.setState({ selected: { accountId: 'a1', labelId: 'inbox' } });
    const { getByText } = render(<MessageList />);
    await waitFor(() => expect(getByText('No messages in this folder.')).toBeInTheDocument());
  });

  it('reloads threads when the folder selection changes', async () => {
    vi.mocked(getThreads).mockResolvedValue({ threads: [], nextCursor: null });
    useFolderStore.setState({ selected: { accountId: 'a1', labelId: 'inbox' } });
    render(<MessageList />);
    await waitFor(() => expect(getThreads).toHaveBeenCalledWith('a1', { labelId: 'inbox' }));

    useFolderStore.setState({ selected: { accountId: 'a1', labelId: 'sent' } });
    await waitFor(() => expect(getThreads).toHaveBeenCalledWith('a1', { labelId: 'sent' }));
  });
});
