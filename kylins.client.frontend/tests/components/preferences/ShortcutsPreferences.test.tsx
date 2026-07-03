import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { ShortcutsPreferences } from '../../../src/components/preferences/ShortcutsPreferences';
import { useShortcutStore } from '../../../src/stores/shortcutStore';
import { shortcutManager } from '../../../src/services/shortcuts/shortcutManager';

vi.mock('../../../src/services/settings', () => ({
  getSetting: vi.fn(() => Promise.resolve(null)),
  setSetting: vi.fn(() => Promise.resolve()),
}));

describe('ShortcutsPreferences', () => {
  beforeEach(async () => {
    await shortcutManager.setActiveSet('win');
    await shortcutManager.resetAll();
    useShortcutStore.setState({
      activeSet: shortcutManager.getActiveSet(),
      keyMap: shortcutManager.getResolvedKeyMap(),
      overrides: shortcutManager.getOverrides(),
      isHydrated: true,
    });
  });

  it('renders the platform set and search field', () => {
    render(<ShortcutsPreferences />);
    expect(screen.getByRole('textbox', { name: /search shortcuts/i })).toBeInTheDocument();
  });

  it('filters command categories by search query', async () => {
    render(<ShortcutsPreferences />);
    const input = screen.getByRole('textbox', { name: /search shortcuts/i });
    fireEvent.change(input, { target: { value: 'new mail' } });
    await waitFor(() => {
      expect(screen.getByText('New Mail')).toBeInTheDocument();
    });
  });

  it('shows Reset all when a binding is customized', async () => {
    await shortcutManager.setBinding('app:new-mail', 'ctrl+shift+x');
    useShortcutStore.setState({
      keyMap: shortcutManager.getResolvedKeyMap(),
      overrides: shortcutManager.getOverrides(),
    });
    render(<ShortcutsPreferences />);
    expect(screen.getByRole('button', { name: /reset all/i })).toBeInTheDocument();
  });

  it('enters recording mode when the change shortcut button is pressed', async () => {
    render(<ShortcutsPreferences />);
    const changeButton = screen.getByRole('button', { name: /change shortcut for new mail/i });
    fireEvent.click(changeButton);
    expect(screen.getByRole('button', { name: /press keys/i })).toBeInTheDocument();
  });
});
