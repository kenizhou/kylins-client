import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { PreferencesDialog } from '../../../src/components/preferences/PreferencesDialog';
import { usePreferencesStore } from '../../../src/stores/preferencesStore';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }));

beforeEach(() => {
  usePreferencesStore.setState({ isOpen: true, activeTab: 'General' });
});

describe('PreferencesDialog accessibility', () => {
  it('tabs have an accessible tablist label', () => {
    render(<PreferencesDialog />);
    expect(screen.getByRole('tablist', { name: /preferences sections/i })).toBeInTheDocument();
  });

  it('skin swatches have accessible names when Appearance is open', () => {
    usePreferencesStore.setState({ activeTab: 'Appearance' });
    render(<PreferencesDialog />);
    expect(screen.getByRole('button', { name: /select iris skin/i })).toBeInTheDocument();
  });
});
