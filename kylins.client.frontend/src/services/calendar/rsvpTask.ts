// RFC 5546 single-attendee REPLY construction (Mailspring event-rsvp-task).
//
// Builds an iMIP REPLY (VCALENDAR METHOD:REPLY with one VEVENT carrying the
// responder's PARTSTAT) for the organizer. For EAS accounts, Exchange processes
// the response server-side via MeetingResponse (see easCalendarProvider); for
// IMAP/SMTP accounts the REPLY ICS is attached as a text/calendar MIME part and
// mailed (that MIME wiring is deferred with emailBuilder — see TODO).

import { IcalHelper, type PartStat } from './icalHelper';
import type { SendAsAlias } from '@/services/db/sendAsAliases';

/** The actionable RSVP responses a user can choose. */
export type RsvpPartStat = Extract<PartStat, 'ACCEPTED' | 'TENTATIVE' | 'DECLINED'>;

export interface RsvpInput {
  /** UID of the original meeting request (METHOD:REQUEST). */
  uid: string;
  summary?: string;
  start: Date;
  end?: Date;
  allDay?: boolean;
  organizerEmail: string;
  responder: SendAsAlias;
  partstat: RsvpPartStat;
  sequence?: number;
}

/** EAS MeetingResponse UserResponse code: 1=accept, 2=tentative, 3=decline. */
export function partstatToEasResponse(partstat: RsvpPartStat): '1' | '2' | '3' {
  switch (partstat) {
    case 'ACCEPTED':
      return '1';
    case 'TENTATIVE':
      return '2';
    case 'DECLINED':
      return '3';
  }
}

/** Build the iMIP REPLY ICS body (RFC 5546). */
export function buildRsvpReply(input: RsvpInput): string {
  return IcalHelper.generateICS({
    uid: input.uid,
    summary: input.summary,
    start: input.start,
    end: input.end,
    allDay: input.allDay,
    method: 'REPLY',
    sequence: input.sequence,
    organizer: { email: input.organizerEmail },
    attendees: [
      {
        email: input.responder.email,
        name: input.responder.displayName ?? undefined,
        partstat: input.partstat,
      },
    ],
  });
}
