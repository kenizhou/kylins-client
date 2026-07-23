import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { MailPreferences } from '../../../src/components/preferences/MailPreferences';
import { usePreferencesStore } from '../../../src/stores/preferencesStore';
import { useViewStore } from '../../../src/features/view/viewStore';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }));

beforeEach(() => {
  usePreferencesStore.setState({
    automaticallyLoadImages: true,
    showFullMessageHeaders: false,
    quoteStyle: 'outlook',
    alwaysShowCcBcc: false,
  });
  useViewStore.setState({
    conversationView: true,
  });
});

describe('MailPreferences', () => {
  it('renders reading and conversation controls', () => {
    render(<MailPreferences />);
    expect(screen.getByLabelText(/automatically load images/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/conversation view/i)).toBeInTheDocument();
  });

  it('renders the composing section with the quote-style select and Cc/Bcc toggle', () => {
    render(<MailPreferences />);
    expect(screen.getByText(/quote style for replies and forwards/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/always show cc and bcc/i)).toBeInTheDocument();
  });

  it('changing the quote style updates the preference', async () => {
    render(<MailPreferences />);
    fireEvent.click(screen.getByRole('button', { name: /quote style for replies and forwards/i }));
    fireEvent.click(await screen.findByRole('option', { name: /gmail \(indented quote\)/i }));
    expect(usePreferencesStore.getState().quoteStyle).toBe('gmail');
  });
});
