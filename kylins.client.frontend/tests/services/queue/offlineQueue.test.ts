import { describe, it, expect, vi, beforeEach } from 'vitest';
import { OfflineQueue } from '../../../src/services/queue/offlineQueue';
import { getDb } from '../../../src/services/db/connection';
import type Database from '@tauri-apps/plugin-sql';

vi.mock('../../../src/services/db/connection', () => ({
  getDb: vi.fn(),
}));

const mockDb = {
  execute: vi.fn().mockResolvedValue({ rowsAffected: 1 }),
  select: vi.fn().mockResolvedValue([]),
};

beforeEach(() => {
  vi.mocked(getDb).mockResolvedValue(mockDb as unknown as Database);
  mockDb.execute.mockClear();
  mockDb.select.mockClear();
});

describe('OfflineQueue', () => {
  it('enqueues an operation', async () => {
    const queue = new OfflineQueue();
    await queue.enqueue({
      accountId: 'acc-1',
      operationType: 'archive',
      resourceId: 'thread-1',
      params: {},
    });
    expect(mockDb.execute).toHaveBeenCalledWith(
      expect.stringContaining('INSERT INTO pending_operations'),
      expect.any(Array),
    );
  });
});
