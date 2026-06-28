// Task 5 cutover: the read paths (getThreads, getMessagesForThread,
// markThreadRead) now route through `invoke('db_*')`. Tests assert the wrapper
// forwards the right command + args and passes the Rust return value through.
// The pure helpers (parseAddresses, mapMessageToMailMessage) keep their
// original unit tests — they consume the snake_case MessageRow Rust returns.

import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  getThreads,
  getMessagesForThread,
  markThreadRead,
  parseAddresses,
  mapMessageToMailMessage,
  type ThreadCursor,
} from '../../../src/services/db/threads';
import { wireDefaultDbResults } from '../../../src/test/mockInvoke';

const { mockInvoke } = vi.hoisted(() => ({ mockInvoke: vi.fn() }));
vi.mock('@tauri-apps/api/core', () => ({ invoke: mockInvoke }));

beforeEach(() => wireDefaultDbResults(mockInvoke));

describe('getThreads', () => {
  it('invokes db_get_threads with accountId + opts (labelId passed through)', async () => {
    mockInvoke.mockResolvedValueOnce({ threads: [], nextCursor: null });
    await getThreads('a1', { labelId: 'inbox' });
    expect(mockInvoke).toHaveBeenCalledWith('db_get_threads', {
      accountId: 'a1',
      opts: { labelId: 'inbox', limit: undefined, cursor: null },
    });
  });

  it('passes the Rust return value through (threads + nextCursor)', async () => {
    const thread = {
      id: 't1',
      accountId: 'a1',
      subject: 'S',
      snippet: 'sn',
      lastMessageAt: 100,
      messageCount: 1,
      isRead: false,
      isStarred: true,
      isImportant: false,
      hasAttachments: false,
      isSnoozed: false,
      fromName: 'Bob',
      fromAddress: 'b@x.com',
      classificationId: null,
      isEncrypted: false,
      isSigned: false,
    };
    mockInvoke.mockResolvedValueOnce({ threads: [thread], nextCursor: null });
    const result = await getThreads('a1', { labelId: 'inbox' });
    expect(result.threads[0]!.isStarred).toBe(true);
    expect(result.threads[0]!.fromName).toBe('Bob');
    expect(result.nextCursor).toBeNull();
  });

  it('emits the cursor on subsequent pages (passed through to opts)', async () => {
    mockInvoke.mockResolvedValueOnce({ threads: [], nextCursor: null });
    const cursor: ThreadCursor = { date: 100, id: 't1' };
    await getThreads('a1', { cursor });
    const [, args] = mockInvoke.mock.calls[0]!;
    expect(args).toMatchObject({ opts: { cursor: { date: 100, id: 't1' } } });
  });

  it('forwards nextCursor from the Rust return shape', async () => {
    mockInvoke.mockResolvedValueOnce({
      threads: [],
      nextCursor: { date: 90, id: 't2' },
    });
    const { nextCursor } = await getThreads('a1', { limit: 2 });
    expect(nextCursor).toEqual({ date: 90, id: 't2' });
  });
});

describe('getMessagesForThread', () => {
  it('invokes db_get_messages_for_thread with (accountId, threadId)', async () => {
    mockInvoke.mockResolvedValueOnce([]);
    await getMessagesForThread('a1', 't1');
    expect(mockInvoke).toHaveBeenCalledWith('db_get_messages_for_thread', {
      accountId: 'a1',
      threadId: 't1',
    });
  });
});

describe('markThreadRead', () => {
  it('invokes db_mark_thread_read with (accountId, threadId)', async () => {
    await markThreadRead('a1', 't1');
    expect(mockInvoke).toHaveBeenCalledWith('db_mark_thread_read', {
      accountId: 'a1',
      threadId: 't1',
    });
  });
});

describe('parseAddresses', () => {
  it('parses bare and "Name <addr>" forms', () => {
    expect(parseAddresses('a@x.com')).toEqual([{ name: 'a@x.com', address: 'a@x.com' }]);
    expect(parseAddresses('Bob <b@x.com>, c@y.com')).toEqual([
      { name: 'Bob', address: 'b@x.com' },
      { name: 'c@y.com', address: 'c@y.com' },
    ]);
    expect(parseAddresses(null)).toEqual([]);
  });
});

describe('mapMessageToMailMessage', () => {
  it('maps a DB row + body to a MailMessage', () => {
    const m = mapMessageToMailMessage(
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
      },
      '<p>html</p>',
    );
    expect(m.from).toEqual({ name: 'Bob', address: 'b@x.com' });
    expect(m.to).toEqual([{ name: 'c@y.com', address: 'c@y.com' }]);
    expect(m.html).toBe('<p>html</p>');
    expect(m.text).toBe('txt');
    expect(m.threadId).toBe('t1');
    expect(new Date(m.date).getTime()).toBe(100 * 1000);
  });
});
