// Task 5 cutover: settings.ts now routes through `invoke('db_*')` instead of
// getDb(). These tests mock `@tauri-apps/api/core` invoke (shared helper) and
// assert the wrapper forwards the right command + args and passes the Rust
// return value through unchanged.

import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  getSetting,
  setSetting,
  getSettingBool,
  setSettingBool,
  getSettingNumber,
  setSettingNumber,
} from '../../src/services/settings';
import { wireDefaultDbResults } from '../../src/test/mockInvoke';

const { mockInvoke } = vi.hoisted(() => ({ mockInvoke: vi.fn() }));
vi.mock('@tauri-apps/api/core', () => ({ invoke: mockInvoke }));

beforeEach(() => wireDefaultDbResults(mockInvoke));

describe('settings', () => {
  it('returns a stored value via db_get_setting', async () => {
    mockInvoke.mockResolvedValueOnce('dark');
    const value = await getSetting('theme');
    expect(value).toBe('dark');
    expect(mockInvoke).toHaveBeenCalledWith('db_get_setting', { key: 'theme' });
  });

  it('returns null when key is missing', async () => {
    mockInvoke.mockResolvedValueOnce(null);
    const value = await getSetting('theme');
    expect(value).toBeNull();
  });

  it('sets a value via db_set_setting', async () => {
    await setSetting('theme', 'light');
    expect(mockInvoke).toHaveBeenCalledWith('db_set_setting', { key: 'theme', value: 'light' });
  });

  it('round-trips boolean true via db_set_setting_bool', async () => {
    await setSettingBool('launch_on_system_start', true);
    expect(mockInvoke).toHaveBeenCalledWith('db_set_setting_bool', {
      key: 'launch_on_system_start',
      value: true,
    });
  });

  it('round-trips boolean false via db_set_setting_bool', async () => {
    await setSettingBool('launch_on_system_start', false);
    expect(mockInvoke).toHaveBeenCalledWith('db_set_setting_bool', {
      key: 'launch_on_system_start',
      value: false,
    });
  });

  it('parses boolean from db_get_setting_bool', async () => {
    mockInvoke.mockResolvedValueOnce(true);
    const value = await getSettingBool('launch_on_system_start');
    expect(value).toBe(true);
  });

  it('returns null boolean when key is missing', async () => {
    mockInvoke.mockResolvedValueOnce(null);
    const value = await getSettingBool('launch_on_system_start');
    expect(value).toBeNull();
  });

  it('round-trips number values via db_set_setting_number', async () => {
    await setSettingNumber('undo_send_duration_seconds', 30);
    expect(mockInvoke).toHaveBeenCalledWith('db_set_setting_number', {
      key: 'undo_send_duration_seconds',
      value: 30,
    });
  });

  it('parses number from db_get_setting_number', async () => {
    mockInvoke.mockResolvedValueOnce(10);
    const value = await getSettingNumber('undo_send_duration_seconds');
    expect(value).toBe(10);
  });
});
