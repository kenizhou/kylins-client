import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }));

// Child pickers hit the DB — render stubs; they are covered by their own tests.
vi.mock('../../../../src/components/composer/SignatureSelector', () => ({
  SignatureSelector: () => <span data-testid="signature-selector" />,
}));
vi.mock('../../../../src/components/composer/TemplatePicker', () => ({
  TemplatePicker: () => <span data-testid="template-picker" />,
}));

import { ComposerStatusBar } from '../../../../src/components/composer/window/ComposerStatusBar';
import { useComposerStore } from '../../../../src/stores/composerStore';
import { useAccountStore } from '../../../../src/stores/accountStore';
import { useUIStore } from '../../../../src/stores/uiStore';

beforeEach(() => {
  useComposerStore.setState({ fromEmail: null, isSaving: false, lastSavedAt: null });
  useAccountStore.setState({
    accounts: [{ id: 'acc-1', email: 'a@example.com', displayName: 'A User', provider: 'imap' }],
    activeAccountId: 'acc-1',
  });
  useUIStore.setState({ sendProgress: { active: false, message: undefined } });
});

describe('ComposerStatusBar', () => {
  it('renders a footer landmark with the account email and word stats', () => {
    render(<ComposerStatusBar editor={null} wordCount={12} charCount={80} />);
    expect(screen.getByRole('contentinfo')).toBeInTheDocument();
    expect(screen.getByText('a@example.com')).toBeInTheDocument();
    expect(screen.getByText('12 words · 80 characters')).toBeInTheDocument();
    expect(screen.getByTestId('signature-selector')).toBeInTheDocument();
    expect(screen.getByTestId('template-picker')).toBeInTheDocument();
  });

  it('prefers the composer fromEmail over the account email', () => {
    useComposerStore.setState({ fromEmail: 'alias@example.com' });
    render(<ComposerStatusBar editor={null} wordCount={0} charCount={0} />);
    expect(screen.getByText('alias@example.com')).toBeInTheDocument();
    expect(screen.queryByText('a@example.com')).not.toBeInTheDocument();
  });

  it('shows the draft saving/saved indicator', () => {
    useComposerStore.setState({ isSaving: true });
    const { rerender } = render(<ComposerStatusBar editor={null} wordCount={0} charCount={0} />);
    expect(screen.getByText('Saving...')).toBeInTheDocument();
    useComposerStore.setState({ isSaving: false, lastSavedAt: 123 });
    rerender(<ComposerStatusBar editor={null} wordCount={0} charCount={0} />);
    expect(screen.getByText('Draft saved')).toBeInTheDocument();
  });

  it('shows the send-progress indicator only while sending', () => {
    const { rerender } = render(<ComposerStatusBar editor={null} wordCount={0} charCount={0} />);
    expect(screen.queryByText('Sending…')).not.toBeInTheDocument();
    useUIStore.setState({ sendProgress: { active: true, message: undefined } });
    rerender(<ComposerStatusBar editor={null} wordCount={0} charCount={0} />);
    expect(screen.getByText('Sending…')).toBeInTheDocument();
  });
});
