import { describe, it, expect, vi, beforeEach } from 'vitest';
import { getSetting, setSetting } from '../../src/services/settings';
import { getDb } from '../../src/services/db/connection';

vi.mock('../../src/services/db/connection', () => ({
  getDb: vi.fn(),
}));

const mockDb = {
  select: vi.fn(),
  execute: vi.fn(),
};

beforeEach(() => {
  vi.mocked(getDb).mockResolvedValue(mockDb as any);
  mockDb.select.mockReset();
  mockDb.execute.mockReset();
});

describe('settings', () => {
  it('returns a stored value', async () => {
    mockDb.select.mockResolvedValue([{ value: 'dark' }]);
    const value = await getSetting('theme');
    expect(value).toBe('dark');
  });

  it('sets a value', async () => {
    mockDb.execute.mockResolvedValue({ rowsAffected: 1 });
    await setSetting('theme', 'light');
    expect(mockDb.execute).toHaveBeenCalledWith(
      'INSERT OR REPLACE INTO settings (key, value) VALUES ($1, $2)',
      ['theme', 'light'],
    );
  });
});
