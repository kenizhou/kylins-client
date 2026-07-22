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
import { useUIStore } from '../../../../src/stores/uiStore';

beforeEach(() => {
  useUIStore.setState({ sendProgress: { active: false, message: undefined } });
});

describe('ComposerStatusBar', () => {
  it('renders a footer landmark with word stats and the pickers', () => {
    render(<ComposerStatusBar editor={null} wordCount={12} charCount={80} />);
    expect(screen.getByRole('contentinfo')).toBeInTheDocument();
    expect(screen.getByText('12 words · 80 characters')).toBeInTheDocument();
    expect(screen.getByTestId('signature-selector')).toBeInTheDocument();
    expect(screen.getByTestId('template-picker')).toBeInTheDocument();
  });

  it('does not duplicate the account email (it lives in the From row)', () => {
    render(<ComposerStatusBar editor={null} wordCount={0} charCount={0} />);
    expect(screen.queryByText(/@/)).not.toBeInTheDocument();
  });

  it('shows the send-progress indicator only while sending', () => {
    const { rerender } = render(<ComposerStatusBar editor={null} wordCount={0} charCount={0} />);
    expect(screen.queryByText('Sending…')).not.toBeInTheDocument();
    useUIStore.setState({ sendProgress: { active: true, message: undefined } });
    rerender(<ComposerStatusBar editor={null} wordCount={0} charCount={0} />);
    expect(screen.getByText('Sending…')).toBeInTheDocument();
  });
});
