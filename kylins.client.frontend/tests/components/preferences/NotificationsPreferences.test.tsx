import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { NotificationsPreferences } from '../../../src/components/preferences/NotificationsPreferences';
import { usePreferencesStore } from '../../../src/stores/preferencesStore';

vi.mock('../../../src/services/settings', () => ({
  getSetting: vi.fn(() => Promise.resolve(null)),
  setSetting: vi.fn(() => Promise.resolve()),
}));

describe('NotificationsPreferences', () => {
  beforeEach(() => {
    usePreferencesStore.setState({
      showNotificationsForNewUnread: true,
      showNotificationsForRepeatedOpens: true,
      playSoundOnNewMail: true,
      resurfaceMessagesOnUnsnooze: true,
      appIconBadge: 'unread-count',
    });
  });

  it('renders notification options', () => {
    render(<NotificationsPreferences />);
    expect(screen.getByLabelText('Show notifications for new unread messages')).toBeInTheDocument();
    expect(screen.getByLabelText('Play sound when receiving new mail')).toBeInTheDocument();
  });

  it('toggles new unread notifications', async () => {
    render(<NotificationsPreferences />);
    const checkbox = screen.getByLabelText('Show notifications for new unread messages');
    fireEvent.click(checkbox);
    await waitFor(() => {
      expect(usePreferencesStore.getState().showNotificationsForNewUnread).toBe(false);
    });
  });

  it('changes badge behavior', async () => {
    render(<NotificationsPreferences />);
    const select = screen.getByLabelText('Show badge on the app icon:');
    fireEvent.change(select, { target: { value: 'off' } });
    await waitFor(() => {
      expect(usePreferencesStore.getState().appIconBadge).toBe('off');
    });
  });
});
