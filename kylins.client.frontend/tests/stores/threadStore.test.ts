import { describe, it, expect, vi, beforeEach } from 'vitest';
import { useThreadStore } from '../../src/stores/threadStore';
import { useViewStore } from '../../src/features/view/viewStore';
import { getThreads, getMessagesForThread } from '../../src/services/db/threads';
import { getMessageBody } from '../../src/services/db/messageBodies';
import type { Thread } from '../../src/services/db/threads';
import { invoke } from '@tauri-apps/api/core';

// `selectThread` now routes mark-read through the Rust sync engine via
// `sync_apply_mutation` (the engine owns the durable write + replay). Mock the
// Tauri invoke at the service boundary so the test asserts the op shape.
vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn(() => Promise.resolve()) }));

vi.mock('../../src/services/db/threads', async () => {
  const actual = await vi.importActual<typeof import('../../src/services/db/threads')>(
    '../../src/services/db/threads',
  );
  return {
    ...actual,
    getThreads: vi.fn(),
    getMessagesForThread: vi.fn(),
  };
});

vi.mock('../../src/services/db/messageBodies', () => ({
  getMessageBody: vi.fn(),
  setMessageBody: vi.fn(),
  evictBody: vi.fn(),
}));

const thread = (over: Partial<Thread> = {}): Thread => ({
  id: 't1',
  accountId: 'a1',
  subject: 'S',
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

function reset() {
  useThreadStore.setState({
    threads: [],
    selectedThreadId: null,
    isLoading: false,
    cursor: null,
    currentQuery: null,
  });
  useViewStore.getState().setSelectedMessage(null);
}

beforeEach(() => {
  reset();
  vi.mocked(getThreads).mockReset();
  vi.mocked(getMessagesForThread).mockReset();
  vi.mocked(getMessageBody).mockReset();
  vi.mocked(invoke).mockReset();
  vi.mocked(invoke).mockResolvedValue(undefined as never);
});

describe('threadStore.loadThreads', () => {
  it('loads page 1 and stores the cursor', async () => {
    vi.mocked(getThreads).mockResolvedValue({
      threads: [thread({ id: 't1' }), thread({ id: 't2' })],
      nextCursor: { date: 90, id: 't2' },
    });
    await useThreadStore.getState().loadThreads('a1', 'inbox');
    expect(getThreads).toHaveBeenCalledWith('a1', { labelId: 'inbox' });
    expect(useThreadStore.getState().threads).toHaveLength(2);
    expect(useThreadStore.getState().cursor).toEqual({ date: 90, id: 't2' });
    expect(useThreadStore.getState().currentQuery).toEqual({ accountId: 'a1', labelId: 'inbox' });
  });
});

describe('threadStore.loadMore', () => {
  it('appends the next page using the cursor and clears it when done', async () => {
    vi.mocked(getThreads)
      .mockResolvedValueOnce({
        threads: [thread({ id: 't1' })],
        nextCursor: { date: 90, id: 't1' },
      })
      .mockResolvedValueOnce({ threads: [thread({ id: 't2' })], nextCursor: null });
    await useThreadStore.getState().loadThreads('a1', 'inbox');
    await useThreadStore.getState().loadMore();
    expect(getThreads).toHaveBeenNthCalledWith(2, 'a1', {
      labelId: 'inbox',
      cursor: { date: 90, id: 't1' },
    });
    expect(useThreadStore.getState().threads.map((t) => t.id)).toEqual(['t1', 't2']);
    expect(useThreadStore.getState().cursor).toBeNull();
  });

  it('does nothing without a cursor', async () => {
    vi.mocked(getThreads).mockResolvedValue({ threads: [], nextCursor: null });
    await useThreadStore.getState().loadThreads('a1', 'inbox'); // cursor ends up null
    await useThreadStore.getState().loadMore(); // no-op
    expect(getThreads).toHaveBeenCalledTimes(1); // only loadThreads
  });
});

describe('threadStore.selectThread', () => {
  it('loads the latest message + body, bridges to selectedMessage, marks unread read via sync_apply_mutation', async () => {
    useThreadStore.setState({ threads: [thread({ id: 't1', isRead: false })] });
    vi.mocked(getMessagesForThread).mockResolvedValue([
      {
        id: 'm1',
        account_id: 'a1',
        thread_id: 't1',
        from_address: 'b@x.com',
        from_name: 'Bob',
        to_addresses: 'c@y.com',
        cc_addresses: null,
        subject: 'S',
        snippet: 'sn',
        date: 100,
        is_read: 0,
        is_starred: 0,
        body_text: 'txt',
        imap_uid: 4242,
        imap_folder: 'INBOX',
      },
    ]);
    vi.mocked(getMessageBody).mockResolvedValue({
      accountId: 'a1',
      messageId: 'm1',
      bodyHtml: '<p>h</p>',
      fetchedAt: 1,
    });

    await useThreadStore.getState().selectThread(thread({ id: 't1', isRead: false }));

    expect(getMessagesForThread).toHaveBeenCalledWith('a1', 't1');
    expect(getMessageBody).toHaveBeenCalledWith('a1', 'm1');
    expect(useViewStore.getState().selectedMessage?.html).toBe('<p>h</p>');
    // The durable mark-read now flows through the sync engine (one invoke with
    // a MutationOp), NOT the legacy `db_mark_thread_read` invoke.
    expect(invoke).toHaveBeenCalledWith('sync_apply_mutation', {
      accountId: 'a1',
      op: {
        type: 'markRead',
        threadId: 't1',
        messageIds: ['m1'],
        folderPath: 'INBOX',
        uids: [4242],
        read: true,
      },
    });
    // optimistic read state
    expect(useThreadStore.getState().threads[0]!.isRead).toBe(true);
  });

  it('does NOT invoke sync_apply_mutation when the thread is already read', async () => {
    useThreadStore.setState({ threads: [thread({ id: 't1', isRead: true })] });
    vi.mocked(getMessagesForThread).mockResolvedValue([]);
    vi.mocked(getMessageBody).mockResolvedValue(null);

    await useThreadStore.getState().selectThread(thread({ id: 't1', isRead: true }));

    expect(invoke).not.toHaveBeenCalled();
  });
});

describe('threadStore.refresh', () => {
  it('re-runs the current query', async () => {
    vi.mocked(getThreads).mockResolvedValue({ threads: [], nextCursor: null });
    await useThreadStore.getState().loadThreads('a1', 'inbox');
    vi.mocked(getThreads).mockClear();
    vi.mocked(getThreads).mockResolvedValue({ threads: [thread({ id: 't9' })], nextCursor: null });
    await useThreadStore.getState().refresh();
    expect(getThreads).toHaveBeenCalledWith('a1', { labelId: 'inbox' });
    expect(useThreadStore.getState().threads[0]!.id).toBe('t9');
  });
});
