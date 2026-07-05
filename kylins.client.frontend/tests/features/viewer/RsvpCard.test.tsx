import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { RsvpCard } from '../../../src/features/viewer/RsvpCard';
import type { ParsedEvent } from '../../../src/services/calendar/icalHelper';

const { mockSendEmail, mockStageAttachmentBytes, mockNewDraftId, mockInsertCalendarEvent } =
  vi.hoisted(() => ({
    mockSendEmail: vi.fn(),
    mockStageAttachmentBytes: vi.fn(),
    mockNewDraftId: vi.fn(),
    mockInsertCalendarEvent: vi.fn(),
  }));

vi.mock('@/services/composer/send', () => ({
  sendEmail: mockSendEmail,
}));

vi.mock('@/services/composer/attachments', () => ({
  stageAttachmentBytes: mockStageAttachmentBytes,
  newDraftId: mockNewDraftId,
}));

vi.mock('@/services/db/calendarEvents', () => ({
  insertCalendarEvent: mockInsertCalendarEvent,
}));

const baseEvent: ParsedEvent = {
  uid: 'invite-1',
  summary: 'Team Sync',
  description: 'Weekly sync',
  location: 'Conference Room A',
  start: new Date('2026-07-10T15:00:00Z'),
  end: new Date('2026-07-10T16:00:00Z'),
  allDay: false,
  status: 'CONFIRMED',
  organizer: { email: 'organizer@example.com', name: 'Organizer' },
  attendees: [{ email: 'alice@example.com', name: 'Alice', partstat: 'NEEDS-ACTION', rsvp: true }],
  method: 'REQUEST',
  sequence: 0,
};

describe('RsvpCard', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockNewDraftId.mockReturnValue('draft-rsvp-1');
    mockStageAttachmentBytes.mockResolvedValue({
      filePath: '/appdata/outbox-attachments/draft-rsvp-1/invite-reply.ics',
      filename: 'invite-reply.ics',
      mimeType: 'text/calendar; method=REPLY',
    });
    mockSendEmail.mockResolvedValue({ success: true, message: 'Queued' });
    mockInsertCalendarEvent.mockResolvedValue('event-1');
  });

  it('renders event details and RSVP actions', () => {
    render(
      <RsvpCard
        event={baseEvent}
        accountId="acc-1"
        accountEmail="alice@example.com"
        accountDisplayName="Alice"
      />,
    );

    expect(screen.getByText('Team Sync')).toBeInTheDocument();
    expect(screen.getByText(/Conference Room A/)).toBeInTheDocument();
    expect(screen.getByText('Accept')).toBeInTheDocument();
    expect(screen.getByText('Tentative')).toBeInTheDocument();
    expect(screen.getByText('Decline')).toBeInTheDocument();
  });

  it('sends an iMIP REPLY and writes the accepted event to the calendar', async () => {
    render(
      <RsvpCard
        event={baseEvent}
        accountId="acc-1"
        accountEmail="alice@example.com"
        accountDisplayName="Alice"
      />,
    );

    fireEvent.click(screen.getByText('Accept'));

    await waitFor(() => {
      expect(mockStageAttachmentBytes).toHaveBeenCalledWith(
        'draft-rsvp-1',
        'invite-reply.ics',
        'text/calendar; method=REPLY',
        expect.anything(),
      );
      const bytes = mockStageAttachmentBytes.mock.calls[0]?.[3];
      expect(ArrayBuffer.isView(bytes)).toBe(true);
      expect(bytes?.length).toBeGreaterThan(0);
    });

    await waitFor(() => {
      expect(mockSendEmail).toHaveBeenCalledWith(
        'acc-1',
        expect.objectContaining({
          accountId: 'acc-1',
          to: [{ name: 'Organizer', email: 'organizer@example.com' }],
          subject: 'Re: Team Sync',
          attachments: [
            expect.objectContaining({
              filename: 'invite-reply.ics',
              mimeType: 'text/calendar; method=REPLY',
            }),
          ],
          fromEmail: 'alice@example.com',
        }),
      );
    });

    await waitFor(() => {
      expect(mockInsertCalendarEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          accountId: 'acc-1',
          uid: 'invite-1',
          summary: 'Team Sync',
          status: 'CONFIRMED',
        }),
      );
    });

    expect(await screen.findByText('accepted')).toBeInTheDocument();
  });

  it('sends a REPLY but does not persist a declined event', async () => {
    render(
      <RsvpCard
        event={baseEvent}
        accountId="acc-1"
        accountEmail="alice@example.com"
        accountDisplayName="Alice"
      />,
    );

    fireEvent.click(screen.getByText('Decline'));

    await waitFor(() => {
      expect(mockSendEmail).toHaveBeenCalled();
    });
    expect(mockInsertCalendarEvent).not.toHaveBeenCalled();
    expect(await screen.findByText('declined')).toBeInTheDocument();
  });

  it('includes the optional comment in the reply body', async () => {
    render(
      <RsvpCard
        event={baseEvent}
        accountId="acc-1"
        accountEmail="alice@example.com"
        accountDisplayName="Alice"
      />,
    );

    const commentBox = screen.getByLabelText('Optional RSVP comment');
    fireEvent.change(commentBox, { target: { value: 'See you there' } });
    fireEvent.click(screen.getByText('Tentative'));

    await waitFor(() => {
      const sent = mockSendEmail.mock.calls[0]?.[1] as { bodyHtml: string } | undefined;
      expect(sent?.bodyHtml).toContain('See you there');
    });
    expect(mockInsertCalendarEvent).toHaveBeenCalled();
  });
});
