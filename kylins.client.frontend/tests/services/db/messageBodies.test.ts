import { describe, it, expect, vi, beforeEach } from 'vitest';
import { getMessageBody, setMessageBody, evictBody } from '../../../src/services/db/messageBodies';
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

describe('getMessageBody', () => {
  it('queries message_bodies by (account_id, message_id)', async () => {
    mockDb.select.mockResolvedValue([{ body_html: '<p>h</p>', fetched_at: 5 }]);
    const body = await getMessageBody('a1', 'm1');
    const [sql, params] = mockDb.select.mock.calls[0]!;
    expect(String(sql)).toContain('FROM message_bodies');
    expect(params).toEqual(['a1', 'm1']);
    expect(body?.bodyHtml).toBe('<p>h</p>');
  });

  it('returns null when absent', async () => {
    mockDb.select.mockResolvedValue([]);
    expect(await getMessageBody('a1', 'm1')).toBeNull();
  });
});

describe('setMessageBody', () => {
  it('upserts message_bodies and sets body_cached=1', async () => {
    await setMessageBody('a1', 'm1', '<p>h</p>');
    expect(mockDb.execute).toHaveBeenCalledTimes(2);
    const [insertSql, insertParams] = mockDb.execute.mock.calls[0]!;
    expect(String(insertSql)).toContain('INSERT OR REPLACE INTO message_bodies');
    expect(insertParams).toContain('<p>h</p>');
    const [updateSql] = mockDb.execute.mock.calls[1]!;
    expect(String(updateSql)).toContain('body_cached = 1');
  });
});

describe('evictBody', () => {
  it('deletes the body and clears body_cached', async () => {
    await evictBody('a1', 'm1');
    expect(mockDb.execute).toHaveBeenCalledTimes(2);
    expect(String(mockDb.execute.mock.calls[0]![0])).toContain('DELETE FROM message_bodies');
    expect(String(mockDb.execute.mock.calls[1]![0])).toContain('body_cached = 0');
  });
});
