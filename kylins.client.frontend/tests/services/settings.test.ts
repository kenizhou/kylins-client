import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  getSetting,
  setSetting,
  getSettingBool,
  setSettingBool,
  getSettingNumber,
  setSettingNumber,
} from '../../src/services/settings';
import { getDb } from '../../src/services/db/connection';
import type Database from '@tauri-apps/plugin-sql';

vi.mock('../../src/services/db/connection', () => ({
  getDb: vi.fn(),
}));

const mockDb = {
  select: vi.fn(),
  execute: vi.fn(),
};

beforeEach(() => {
  vi.mocked(getDb).mockResolvedValue(mockDb as unknown as Database);
  mockDb.select.mockReset();
  mockDb.execute.mockReset();
});

describe('settings', () => {
  it('returns a stored value', async () => {
    mockDb.select.mockResolvedValue([{ value: 'dark' }]);
    const value = await getSetting('theme');
    expect(value).toBe('dark');
  });

  it('returns null when key is missing', async () => {
    mockDb.select.mockResolvedValue([]);
    const value = await getSetting('theme');
    expect(value).toBeNull();
  });

  it('sets a value', async () => {
    mockDb.execute.mockResolvedValue({ rowsAffected: 1 });
    await setSetting('theme', 'light');
    expect(mockDb.execute).toHaveBeenCalledWith(
      'INSERT OR REPLACE INTO settings (key, value) VALUES ($1, $2)',
      ['theme', 'light'],
    );
  });

  it('round-trips boolean true', async () => {
    mockDb.execute.mockResolvedValue({ rowsAffected: 1 });
    await setSettingBool('launch_on_system_start', true);
    expect(mockDb.execute).toHaveBeenCalledWith(
      'INSERT OR REPLACE INTO settings (key, value) VALUES ($1, $2)',
      ['launch_on_system_start', 'true'],
    );
  });

  it('round-trips boolean false', async () => {
    mockDb.execute.mockResolvedValue({ rowsAffected: 1 });
    await setSettingBool('launch_on_system_start', false);
    expect(mockDb.execute).toHaveBeenCalledWith(
      'INSERT OR REPLACE INTO settings (key, value) VALUES ($1, $2)',
      ['launch_on_system_start', 'false'],
    );
  });

  it('parses boolean from settings', async () => {
    mockDb.select.mockResolvedValue([{ value: 'true' }]);
    const value = await getSettingBool('launch_on_system_start');
    expect(value).toBe(true);
  });

  it('returns null boolean when key is missing', async () => {
    mockDb.select.mockResolvedValue([]);
    const value = await getSettingBool('launch_on_system_start');
    expect(value).toBeNull();
  });

  it('round-trips number values', async () => {
    mockDb.execute.mockResolvedValue({ rowsAffected: 1 });
    await setSettingNumber('undo_send_duration_seconds', 30);
    expect(mockDb.execute).toHaveBeenCalledWith(
      'INSERT OR REPLACE INTO settings (key, value) VALUES ($1, $2)',
      ['undo_send_duration_seconds', '30'],
    );
  });

  it('parses number from settings', async () => {
    mockDb.select.mockResolvedValue([{ value: '10' }]);
    const value = await getSettingNumber('undo_send_duration_seconds');
    expect(value).toBe(10);
  });
});
