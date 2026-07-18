import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MailPreferences } from '../../../src/components/preferences/MailPreferences';
import { usePreferencesStore } from '../../../src/stores/preferencesStore';
import { useViewStore } from '../../../src/features/view/viewStore';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }));

beforeEach(() => {
  usePreferencesStore.setState({
    automaticallyLoadImages: true,
    showFullMessageHeaders: false,
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
});
