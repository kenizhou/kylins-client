import { useState } from 'react';
import { Button, TextField, Input } from 'react-aria-components';
import { sendEmail } from '@/services/composer/send';
import { stageAttachmentBytes, newDraftId } from '@/services/composer/attachments';
import { insertCalendarEvent } from '@/services/db/calendarEvents';
import { buildRsvpReply, type RsvpPartStat } from '@/services/calendar/rsvpTask';
import type { ParsedEvent } from '@/services/calendar/icalHelper';
import { formatFullDate } from '@/utils/formatDate';

interface RsvpCardProps {
  event: ParsedEvent;
  accountId: string;
  accountEmail: string;
  accountDisplayName?: string | null;
  onRsvp?: () => void;
}

function partstatLabel(p: RsvpPartStat): string {
  switch (p) {
    case 'ACCEPTED':
      return 'Accept';
    case 'TENTATIVE':
      return 'Tentative';
    case 'DECLINED':
      return 'Decline';
  }
}

export function RsvpCard({
  event,
  accountId,
  accountEmail,
  accountDisplayName,
  onRsvp,
}: RsvpCardProps) {
  const [sending, setSending] = useState(false);
  const [sentPartstat, setSentPartstat] = useState<RsvpPartStat | null>(null);
  const [comment, setComment] = useState('');

  const organizer = event.organizer;
  const organizerName = organizer?.name ?? organizer?.email ?? 'Organizer';
  const startText = formatFullDate(event.start.toISOString());
  const endText = event.end ? formatFullDate(event.end.toISOString()) : undefined;

  async function handleRsvp(partstat: RsvpPartStat) {
    if (!organizer?.email) return;
    setSending(true);
    try {
      const ics = buildRsvpReply({
        uid: event.uid,
        summary: event.summary,
        start: event.start,
        end: event.end,
        allDay: event.allDay,
        organizerEmail: organizer.email,
        partstat,
        sequence: event.sequence,
        responder: { email: accountEmail, displayName: accountDisplayName ?? null },
      });
      const icsBytes = new TextEncoder().encode(ics);

      const stagingDraftId = newDraftId();
      const staged = await stageAttachmentBytes(
        stagingDraftId,
        'invite-reply.ics',
        'text/calendar; method=REPLY',
        icsBytes,
      );

      const commentHtml = comment.trim()
        ? `\n\n<p className="text-[var(--muted-text)]">Comment: ${comment.trim()}</p>`
        : '';

      await sendEmail(accountId, {
        accountId,
        to: [{ name: organizerName, email: organizer.email }],
        subject: `Re: ${event.summary ?? 'Meeting request'}`,
        bodyHtml: `<p>${accountDisplayName ?? accountEmail} has ${partstatLabel(partstat).toLowerCase()} the meeting invitation.</p>${commentHtml}`,
        attachments: [
          {
            filename: staged.filename,
            mimeType: 'text/calendar; method=REPLY',
            filePath: staged.filePath,
            size: icsBytes.length,
          },
        ],
        fromEmail: accountEmail,
      });

      // Persist accepted events to the local calendar; tentatives are stored too
      // so the calendar can show them as "tentative".
      if (partstat === 'ACCEPTED' || partstat === 'TENTATIVE') {
        const endTime = event.end
          ? Math.floor(event.end.getTime() / 1000)
          : Math.floor(event.start.getTime() / 1000);
        await insertCalendarEvent({
          accountId,
          uid: event.uid,
          summary: event.summary ?? null,
          description: event.description ?? null,
          location: event.location ?? null,
          startTime: Math.floor(event.start.getTime() / 1000),
          endTime,
          isAllDay: event.allDay,
          status: 'CONFIRMED',
          organizerEmail: organizer.email,
          attendeesJson: JSON.stringify(
            event.attendees.map((a) => ({
              email: a.email,
              name: a.name,
              partstat: a.partstat,
            })),
          ),
          icalData: ics,
        });
      }

      setSentPartstat(partstat);
      onRsvp?.();
    } catch (err) {
      console.error('[RsvpCard] RSVP send failed', err);
    } finally {
      setSending(false);
    }
  }

  if (sentPartstat) {
    return (
      <div className="rounded-lg border border-[var(--border)] bg-[var(--surface)] p-4 text-sm text-[var(--foreground)]">
        <div className="font-medium">{event.summary ?? 'Meeting request'}</div>
        <div className="mt-1 text-[var(--muted-text)]">
          You responded{' '}
          <span className="font-medium text-[var(--foreground)]">{sentPartstat.toLowerCase()}</span>
          .
        </div>
      </div>
    );
  }

  return (
    <div className="rounded-lg border border-[var(--border)] bg-[var(--surface)] p-4 text-sm">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="font-semibold text-[var(--foreground)]">
            {event.summary ?? 'Meeting request'}
          </div>
          <div className="mt-1 text-[var(--muted-text)]">
            {startText}
            {endText && ` – ${endText}`}
          </div>
          {event.location && (
            <div className="mt-0.5 text-[var(--muted-text)]">📍 {event.location}</div>
          )}
          {organizer && (
            <div className="mt-0.5 text-[var(--muted-text)]">
              Organizer: {organizer.name ? `${organizer.name} ` : ''}
              <span className="text-[var(--text)]">{organizer.email}</span>
            </div>
          )}
        </div>
      </div>

      <div className="mt-3 flex flex-col gap-2">
        <TextField className="w-full" aria-label="Optional RSVP comment">
          <Input
            type="text"
            value={comment}
            onChange={(e) => setComment(e.target.value)}
            placeholder="Add a comment (optional)"
            className="w-full rounded border border-[var(--border)] bg-[var(--background)] px-2 py-1 text-xs text-[var(--foreground)] outline-none placeholder:text-[var(--muted-foreground)]"
          />
        </TextField>
        <div className="flex items-center gap-2">
          {(['ACCEPTED', 'TENTATIVE', 'DECLINED'] as RsvpPartStat[]).map((p) => (
            <Button
              key={p}
              onPress={() => handleRsvp(p)}
              isDisabled={sending}
              className={`rounded px-3 py-1.5 text-xs font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ring)] disabled:opacity-50 ${
                p === 'ACCEPTED'
                  ? 'bg-[var(--green)] text-white'
                  : p === 'DECLINED'
                    ? 'bg-[var(--destructive)] text-white'
                    : 'bg-[var(--primary)] text-[var(--primary-fg)]'
              }`}
            >
              {sending ? 'Sending…' : partstatLabel(p)}
            </Button>
          ))}
        </div>
      </div>
    </div>
  );
}
