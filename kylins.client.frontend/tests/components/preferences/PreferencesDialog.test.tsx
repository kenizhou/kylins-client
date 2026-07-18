import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { PreferencesDialog } from '../../../src/components/preferences/PreferencesDialog';
import { usePreferencesStore } from '../../../src/stores/preferencesStore';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }));

beforeEach(() => {
  usePreferencesStore.setState({ isOpen: true, activeTab: 'General' });
});

describe('PreferencesDialog', () => {
  it('renders exactly seven tabs', () => {
    render(<PreferencesDialog />);
    const tabs = screen.getAllByRole('tab');
    expect(tabs).toHaveLength(7);
  });

  it('does not contain any coming-soon text', () => {
    render(<PreferencesDialog />);
    expect(screen.queryByText(/coming soon/i)).not.toBeInTheDocument();
  });

  it('labels tabs with General, Accounts, Appearance, Mail, Calendar & Contacts, Shortcuts, About', () => {
    render(<PreferencesDialog />);
    [
      'General',
      'Accounts',
      'Appearance',
      'Mail',
      'Calendar & Contacts',
      'Shortcuts',
      'About',
    ].forEach((label) => expect(screen.getByRole('tab', { name: label })).toBeInTheDocument());
  });
});
