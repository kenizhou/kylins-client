import { describe, it, expect } from 'vitest';
import { expandStoredEvents } from '@/services/calendar/recurrenceExpander';

const SINGLE_ICS = `BEGIN:VCALENDAR
VERSION:2.0
PRODID:-//Kylins//Test//EN
BEGIN:VEVENT
UID:test-event-1
DTSTART:20260704T100000Z
DTEND:20260704T110000Z
SUMMARY:Team standup
END:VEVENT
END:VCALENDAR`;

const RECUR_ICS = `BEGIN:VCALENDAR
VERSION:2.0
PRODID:-//Kylins//Test//EN
BEGIN:VEVENT
UID:test-recur-1
DTSTART:20260706T090000Z
DTEND:20260706T100000Z
RRULE:FREQ=DAILY;COUNT=3
SUMMARY:Daily sync
END:VEVENT
END:VCALENDAR`;

describe('expandStoredEvents', () => {
  it('carries id, calendarId, and color onto single occurrences', () => {
    const occurrences = expandStoredEvents(
      [
        {
          uid: 'test-event-1',
          icalData: SINGLE_ICS,
          id: 'event-1',
          calendarId: 'cal-1',
          color: '#22c55e',
        },
      ],
      {
        start: new Date('2026-07-01T00:00:00Z'),
        end: new Date('2026-07-31T23:59:59Z'),
      },
    );

    expect(occurrences).toHaveLength(1);
    expect(occurrences[0].eventId).toBe('event-1');
    expect(occurrences[0].calendarId).toBe('cal-1');
    expect(occurrences[0].color).toBe('#22c55e');
    expect(occurrences[0].summary).toBe('Team standup');
  });

  it('carries metadata onto every expanded recurring occurrence', () => {
    const occurrences = expandStoredEvents(
      [
        {
          uid: 'test-recur-1',
          icalData: RECUR_ICS,
          id: 'event-2',
          calendarId: 'cal-2',
          color: '#ef4444',
        },
      ],
      {
        start: new Date('2026-07-05T00:00:00Z'),
        end: new Date('2026-07-10T23:59:59Z'),
      },
    );

    expect(occurrences.length).toBeGreaterThanOrEqual(3);
    for (const o of occurrences) {
      expect(o.eventId).toBe('event-2');
      expect(o.calendarId).toBe('cal-2');
      expect(o.color).toBe('#ef4444');
      expect(o.summary).toBe('Daily sync');
    }
  });

  it('skips rows without ical_data without throwing', () => {
    const occurrences = expandStoredEvents(
      [{ uid: 'empty', icalData: null, id: 'event-3', calendarId: 'cal-3', color: '#000' }],
      {
        start: new Date('2026-07-01T00:00:00Z'),
        end: new Date('2026-07-31T23:59:59Z'),
      },
    );

    expect(occurrences).toHaveLength(0);
  });
});
