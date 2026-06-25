import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  getThreads,
  getMessagesForThread,
  markThreadRead,
  parseAddresses,
  mapMessageToMailMessage,
  type ThreadCursor,
} from '../../../src/services/db/threads';
import { getDb } from '../../../src/services/db/connection';
import type Database from '@tauri-apps/plugin-sql';

vi.mock('../../../src/services/db/connection', () => {
  const getDb = vi.fn();
  const withTransaction = vi.fn(async (fn: (db: unknown) => Promise<void>) => fn(await getDb()));
  return { getDb, withTransaction };
});

const mockDb = { select: vi.fn(), execute: vi.fn() };

beforeEach(() => {
  vi.mocked(getDb).mockResolvedValue(mockDb as unknown as Database);
  mockDb.select.mockReset();
  mockDb.execute.mockReset();
});

const row = (over: Record<string, unknown> = {}) => ({
  id: 't1',
  account_id: 'a1',
  subject: 'S',
  snippet: 'sn',
  last_message_at: 100,
  message_count: 1,
  is_read: 0,
  is_starred: 0,
  is_important: 0,
  has_attachments: 0,
  is_snoozed: 0,
  from_name: 'Bob',
  from_address: 'b@x.com',
  ...over,
});

describe('getThreads', () => {
  it('joins thread_labels + orders + limits on the first page (no cursor)', async () => {
    mockDb.select.mockResolvedValue([row({ is_starred: 1 })]);
    const { threads, nextCursor } = await getThreads('a1', { labelId: 'inbox' });
    expect(threads[0]!.isStarred).toBe(true);
    expect(threads[0]!.fromName).toBe('Bob');
    const [sql, params] = mockDb.select.mock.calls[0]!;
    expect(String(sql)).toContain('INNER JOIN thread_labels');
    expect(String(sql)).toContain('ORDER BY t.last_message_at DESC, t.id DESC');
    expect(String(sql)).toContain('LIMIT');
    expect(params).toContain('a1');
    expect(params).toContain('inbox');
    expect(nextCursor).toBeNull(); // 1 row < default limit 50
  });

  it('omits the label join when no labelId', async () => {
    mockDb.select.mockResolvedValue([]);
    await getThreads('a1', {});
    expect(String(mockDb.select.mock.calls[0]![0])).not.toContain('INNER JOIN thread_labels');
  });

  it('emits the cursor predicate on subsequent pages', async () => {
    mockDb.select.mockResolvedValue([]);
    const cursor: ThreadCursor = { date: 100, id: 't1' };
    await getThreads('a1', { cursor });
    const [sql, params] = mockDb.select.mock.calls[0]!;
    expect(String(sql)).toContain('t.last_message_at <');
    expect(params).toContain(100);
    expect(params).toContain('t1');
  });

  it('returns nextCursor from the last row when the page is full', async () => {
    mockDb.select.mockResolvedValue([
      row({ id: 't1', last_message_at: 100 }),
      row({ id: 't2', last_message_at: 90 }),
    ]);
    const { nextCursor } = await getThreads('a1', { limit: 2 });
    expect(nextCursor).toEqual({ date: 90, id: 't2' });
  });
});

describe('getMessagesForThread', () => {
  it('queries messages for a thread ordered oldest→newest', async () => {
    mockDb.select.mockResolvedValue([]);
    await getMessagesForThread('a1', 't1');
    const [sql, params] = mockDb.select.mock.calls[0]!;
    expect(String(sql)).toContain('FROM messages');
    expect(String(sql)).toContain('ORDER BY date ASC');
    expect(params).toEqual(['a1', 't1']);
  });
});

describe('markThreadRead', () => {
  it('updates the thread and its messages', async () => {
    await markThreadRead('a1', 't1');
    const sqls = mockDb.execute.mock.calls.map((c) => String(c[0]));
    expect(sqls.some((s) => s.includes('UPDATE threads'))).toBe(true);
    expect(sqls.some((s) => s.includes('UPDATE messages'))).toBe(true);
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
