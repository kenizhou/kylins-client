import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { ComposingPreferences } from '../../../src/components/preferences/ComposingPreferences';
import { usePreferencesStore } from '../../../src/stores/preferencesStore';

vi.mock('../../../src/services/settings', () => ({
  getSetting: vi.fn(() => Promise.resolve(null)),
  setSetting: vi.fn(() => Promise.resolve()),
}));

describe('ComposingPreferences', () => {
  beforeEach(() => {
    usePreferencesStore.setState({
      enableRichText: true,
      checkSpelling: true,
      checkGrammar: false,
      spellcheckLanguage: 'system',
      messageSentSound: true,
      defaultSendBehavior: 'send',
      defaultReplyBehavior: 'reply-all',
      undoSendDuration: '5',
      sendNewMessagesFrom: 'selected-account',
    });
  });

  it('renders editor and sending sections', () => {
    render(<ComposingPreferences />);
    expect(screen.getByText('Editor')).toBeInTheDocument();
    expect(screen.getByText('Sending')).toBeInTheDocument();
    expect(screen.getByLabelText('Enable rich text and advanced editor features')).toBeInTheDocument();
  });

  it('toggles rich text', async () => {
    render(<ComposingPreferences />);
    const checkbox = screen.getByLabelText('Enable rich text and advanced editor features');
    fireEvent.click(checkbox);
    await waitFor(() => {
      expect(usePreferencesStore.getState().enableRichText).toBe(false);
    });
  });

  it('changes undo send duration', async () => {
    render(<ComposingPreferences />);
    const select = screen.getByLabelText('After sending, enable undo for:');
    fireEvent.change(select, { target: { value: '30' } });
    await waitFor(() => {
      expect(usePreferencesStore.getState().undoSendDuration).toBe('30');
    });
  });
});
