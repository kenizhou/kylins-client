import { describe, it, expect, vi, beforeEach } from 'vitest';
import { searchMessages } from '../../../src/services/db/search';
import { getDb } from '../../../src/services/db/connection';
import type Database from '@tauri-apps/plugin-sql';

vi.mock('../../../src/services/db/connection', () => ({ getDb: vi.fn() }));

const mockDb = { select: vi.fn() };

beforeEach(() => {
  vi.mocked(getDb).mockResolvedValue(mockDb as unknown as Database);
  mockDb.select.mockReset();
});

describe('searchMessages', () => {
  it('returns [] for an empty query without hitting the DB', async () => {
    expect(await searchMessages('a1', '   ')).toEqual([]);
    expect(mockDb.select).not.toHaveBeenCalled();
  });

  it('builds a MATCH + snippet + rank query', async () => {
    mockDb.select.mockResolvedValue([
      {
        id: 'm1',
        thread_id: 't1',
        subject: 'S',
        from_name: 'Bob',
        from_address: 'b@x.com',
        date: 100,
        preview: 'a <mark>match</mark> here',
        rank: -1,
      },
    ]);
    const results = await searchMessages('a1', 'match');
    const [sql, params] = mockDb.select.mock.calls[0]!;
    expect(String(sql)).toContain('messages_fts MATCH');
    expect(String(sql)).toContain('snippet(messages_fts');
    expect(String(sql)).toContain('ORDER BY rank');
    expect(params).toContain('match');
    expect(params).toContain('a1');
    expect(results[0]!.preview).toContain('<mark>');
  });
});
