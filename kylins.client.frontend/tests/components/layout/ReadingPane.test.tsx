import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, waitFor, act, screen } from '@testing-library/react';
import { readTextFile } from '@tauri-apps/plugin-fs';
import { ReadingPane } from '../../../src/components/layout/ReadingPane';
import { useViewStore } from '../../../src/features/view/viewStore';
import { useAccountStore } from '../../../src/stores/accountStore';
import { usePreferencesStore } from '../../../src/stores/preferencesStore';
import { useClassificationStore } from '../../../src/features/classification/classificationStore';
import { getAttachments, fetchAttachment } from '../../../src/services/db/attachments';
import type { MailMessage } from '../../../src/features/view/viewStore';

vi.mock('../../../src/components/plugins/InjectedComponentSet', () => ({
  InjectedComponentSet: () => null,
}));

vi.mock('../../../src/components/email/EmailRenderer', () => ({
  EmailRenderer: () => <div data-testid="email-renderer" />,
}));

vi.mock('../../../src/components/email/InlineReply', () => ({
  InlineReply: () => <div data-testid="inline-reply" />,
}));

vi.mock('../../../src/features/viewer/RsvpCard', () => ({
  RsvpCard: ({ event }: { event: { summary?: string } }) => (
    <div data-testid="rsvp-card">{event.summary ?? 'Meeting request'}</div>
  ),
}));

vi.mock('@tauri-apps/plugin-fs', () => ({
  readTextFile: vi.fn(),
}));

vi.mock('../../../src/services/db/attachments', () => ({
  getAttachments: vi.fn(),
  fetchAttachment: vi.fn(),
  fetchInlineImages: () => Promise.resolve([]),
  referencedCids: () => new Set<string>(),
}));

const message: MailMessage = {
  id: 'msg-1',
  subject: 'Test subject',
  from: { name: 'Test Sender', address: 'sender@example.com' },
  to: [{ name: 'You', address: 'you@example.com' }],
  date: new Date().toISOString(),
  preview: 'Preview text',
  html: '<p>Hello</p>',
  text: 'Hello',
  threadId: 'thread-1',
  classificationId: null,
  isEncrypted: false,
  isSigned: false,
};

describe('ReadingPane', () => {
  beforeEach(() => {
    vi.mocked(getAttachments).mockReset().mockResolvedValue([]);
    vi.mocked(fetchAttachment).mockReset();
    useViewStore.setState({ selectedMessage: null });
    useAccountStore.setState({
      accounts: [
        { id: 'acc-1', email: 'you@example.com' } as unknown as Parameters<
          typeof useAccountStore.setState
        >[0]['accounts'][number],
      ],
      activeAccountId: 'acc-1',
      defaultAccountId: 'acc-1',
    });
    usePreferencesStore.setState({ automaticallyLoadImages: false } as Parameters<
      typeof usePreferencesStore.setState
    >[0]);
    useClassificationStore.setState({
      levels: [
        { id: 'unclassified', name: 'Unclassified', color: '#6b7280', icon: null, order: 0 },
        { id: 'restricted', name: 'Restricted', color: '#f59e0b', icon: 'shield', order: 1 },
        { id: 'confidential', name: 'Confidential', color: '#ef4444', icon: 'lock', order: 2 },
      ],
      loaded: false,
    });
  });

  it('renders the selected message after starting with no selection', async () => {
    const { getByText, queryByText } = render(<ReadingPane />);
    expect(getByText('No message selected')).toBeInTheDocument();

    act(() => {
      useViewStore.setState({ selectedMessage: message });
    });

    await waitFor(() => {
      expect(queryByText('No message selected')).not.toBeInTheDocument();
      expect(getByText('Test subject')).toBeInTheDocument();
    });
  });

  it('renders an RSVP card for calendar-invite attachments', async () => {
    const ics = [
      'BEGIN:VCALENDAR',
      'VERSION:2.0',
      'METHOD:REQUEST',
      'PRODID:-//Test//EN',
      'BEGIN:VEVENT',
      'UID:invite-123',
      'SUMMARY:Project Kickoff',
      'DTSTART:20260710T150000Z',
      'DTEND:20260710T160000Z',
      'ORGANIZER:mailto:organizer@example.com',
      'END:VEVENT',
      'END:VCALENDAR',
    ].join('\r\n');

    vi.mocked(getAttachments).mockResolvedValue([
      {
        id: 'att-1',
        accountId: 'acc-1',
        messageId: 'msg-1',
        filename: 'invite.ics',
        mimeType: 'text/calendar; method=REQUEST',
        size: ics.length,
        isInline: false,
      },
    ]);
    vi.mocked(fetchAttachment).mockResolvedValue({
      filePath: '/appdata/attachment-cache/acc-1/ms/msg-1/invite.ics',
      filename: 'invite.ics',
      mimeType: 'text/calendar; method=REQUEST',
      size: ics.length,
    });
    vi.mocked(readTextFile).mockResolvedValue(ics);

    render(<ReadingPane />);
    act(() => {
      useViewStore.setState({ selectedMessage: message });
    });

    await waitFor(() => {
      expect(screen.getByTestId('rsvp-card')).toHaveTextContent('Project Kickoff');
    });
  });
});
