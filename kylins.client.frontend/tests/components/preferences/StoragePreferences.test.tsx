import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { StoragePreferences } from '../../../src/components/preferences/StoragePreferences';
import { usePreferencesStore } from '../../../src/stores/preferencesStore';

const invoke = vi.fn();

vi.mock('@tauri-apps/api/core', () => ({
  invoke: (...args: unknown[]) => invoke(...args),
}));

vi.mock('../../../src/services/settings', () => ({
  getSetting: vi.fn(() => Promise.resolve(null)),
  setSetting: vi.fn(() => Promise.resolve()),
}));

describe('StoragePreferences', () => {
  beforeEach(() => {
    usePreferencesStore.setState({
      openAttachmentFolder: false,
      displayAttachmentThumbnails: true,
      cacheAutoCleanupEnabled: false,
    });
    invoke.mockReset();
    invoke.mockImplementation((cmd: string) => {
      if (cmd === 'get_cache_size') return Promise.resolve(1024 * 1024);
      if (cmd === 'clear_cache') return Promise.resolve();
      if (cmd === 'reveal_logs_directory') return Promise.resolve();
      return Promise.reject(new Error(`Unknown command: ${cmd}`));
    });
  });

  it('renders storage sections and cache size', async () => {
    render(<StoragePreferences />);
    expect(await screen.findByText('Cache')).toBeInTheDocument();
    expect(await screen.findByText(/Using 1.0 MB/)).toBeInTheDocument();
  });

  it('clears cache when button is clicked', async () => {
    render(<StoragePreferences />);
    const button = await screen.findByRole('button', { name: /clear cache/i });
    fireEvent.click(button);
    await waitFor(() => {
      expect(invoke).toHaveBeenCalledWith('clear_cache');
    });
  });

  it('toggles auto cleanup', async () => {
    render(<StoragePreferences />);
    const checkbox = screen.getByLabelText(
      'Automatically clean up cached attachments and previews',
    );
    fireEvent.click(checkbox);
    await waitFor(() => {
      expect(usePreferencesStore.getState().cacheAutoCleanupEnabled).toBe(true);
    });
  });

  it('reveals logs directory', async () => {
    render(<StoragePreferences />);
    const button = await screen.findByRole('button', { name: /show logs/i });
    fireEvent.click(button);
    await waitFor(() => {
      expect(invoke).toHaveBeenCalledWith('reveal_logs_directory');
    });
  });
});
