import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { StartupPreferences } from '../../../src/components/preferences/StartupPreferences';
import { usePreferencesStore } from '../../../src/stores/preferencesStore';

const enable = vi.fn();
const disable = vi.fn();
const isEnabled = vi.fn();

vi.mock('@tauri-apps/plugin-autostart', () => ({
  enable: (...args: unknown[]) => enable(...args),
  disable: (...args: unknown[]) => disable(...args),
  isEnabled: () => isEnabled(),
}));

vi.mock('../../../src/services/settings', () => ({
  getSetting: vi.fn(() => Promise.resolve(null)),
  setSetting: vi.fn(() => Promise.resolve()),
}));

describe('StartupPreferences', () => {
  beforeEach(() => {
    usePreferencesStore.setState({
      launchOnSystemStart: false,
      showIconInMenuBar: true,
    });
    enable.mockReset();
    disable.mockReset();
    isEnabled.mockResolvedValue(false);
  });

  it('renders startup options', () => {
    render(<StartupPreferences />);
    expect(screen.getByLabelText('Launch on system start')).toBeInTheDocument();
    expect(screen.getByLabelText('Show icon in menu bar / system tray')).toBeInTheDocument();
  });

  it('enables autostart when toggled on', async () => {
    render(<StartupPreferences />);
    const checkbox = screen.getByLabelText('Launch on system start');
    fireEvent.click(checkbox);
    await waitFor(() => {
      expect(usePreferencesStore.getState().launchOnSystemStart).toBe(true);
      expect(enable).toHaveBeenCalled();
    });
  });

  it('disables autostart when toggled off', async () => {
    usePreferencesStore.setState({ launchOnSystemStart: true });
    render(<StartupPreferences />);
    const checkbox = screen.getByLabelText('Launch on system start');
    fireEvent.click(checkbox);
    await waitFor(() => {
      expect(usePreferencesStore.getState().launchOnSystemStart).toBe(false);
      expect(disable).toHaveBeenCalled();
    });
  });
});
