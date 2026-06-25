import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { PrivacySecurityPreferences } from '../../../src/components/preferences/PrivacySecurityPreferences';
import { usePreferencesStore } from '../../../src/stores/preferencesStore';

vi.mock('../../../src/services/settings', () => ({
  getSetting: vi.fn(() => Promise.resolve(null)),
  setSetting: vi.fn(() => Promise.resolve()),
}));

describe('PrivacySecurityPreferences', () => {
  beforeEach(() => {
    usePreferencesStore.setState({
      automaticallyLoadImages: true,
      showFullMessageHeaders: false,
      shareDiagnosticsData: false,
    });
  });

  it('renders privacy and security sections', () => {
    render(<PrivacySecurityPreferences />);
    expect(screen.getByText('Privacy')).toBeInTheDocument();
    expect(screen.getByText('Security')).toBeInTheDocument();
  });

  it('toggles automatic image loading', async () => {
    render(<PrivacySecurityPreferences />);
    const checkbox = screen.getByLabelText('Automatically load images in viewed messages');
    fireEvent.click(checkbox);
    await waitFor(() => {
      expect(usePreferencesStore.getState().automaticallyLoadImages).toBe(false);
    });
  });
});
