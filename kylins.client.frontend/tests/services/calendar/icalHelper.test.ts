import { describe, it, expect } from 'vitest';
import { IcalHelper } from '../../../src/services/calendar/icalHelper';

const ICS = `BEGIN:VCALENDAR
VERSION:2.0
PRODID:-//Test//EN
METHOD:REQUEST
BEGIN:VEVENT
UID:u1@test
SUMMARY:Standup
DTSTART:20250620T140000Z
DTEND:20250620T143000Z
STATUS:CONFIRMED
ORGANIZER;CN=Boss:mailto:boss@corp.com
ATTENDEE;CN=Me;PARTSTAT=NEEDS-ACTION;RSVP=TRUE:mailto:me@corp.com
END:VEVENT
END:VCALENDAR`;

describe('IcalHelper.parseEvents', () => {
  it('parses summary, method, organizer, attendees, start', () => {
    const [ev] = IcalHelper.parseEvents(ICS);
    expect(ev).toBeDefined();
    expect(ev.summary).toBe('Standup');
    expect(ev.method).toBe('REQUEST');
    expect(ev.organizer?.email).toBe('boss@corp.com');
    expect(ev.organizer?.name).toBe('Boss');
    expect(ev.attendees[0]?.email).toBe('me@corp.com');
    expect(ev.attendees[0]?.partstat).toBe('NEEDS-ACTION');
    expect(ev.start.toISOString()).toBe('2025-06-20T14:00:00.000Z');
  });

  it('returns [] on unparseable input', () => {
    expect(IcalHelper.parseEvents('not ics at all')).toEqual([]);
  });
});

describe('IcalHelper.generateICS', () => {
  it('round-trips a simple event through parse', () => {
    const ics = IcalHelper.generateICS({
      uid: 'x',
      summary: 'Hi',
      start: new Date('2025-06-20T14:00:00Z'),
      end: new Date('2025-06-20T15:00:00Z'),
    });
    expect(ics).toContain('BEGIN:VCALENDAR');
    expect(ics).toContain('SUMMARY:Hi');
    const [parsed] = IcalHelper.parseEvents(ics);
    expect(parsed.summary).toBe('Hi');
    expect(parsed.start.toISOString()).toBe('2025-06-20T14:00:00.000Z');
  });

  it('serializes attendees with partstat', () => {
    const ics = IcalHelper.generateICS({
      uid: 'y',
      summary: 'M',
      start: new Date('2025-06-20T14:00:00Z'),
      end: new Date('2025-06-20T15:00:00Z'),
      attendees: [{ email: 'a@b.com', partstat: 'ACCEPTED', role: 'REQ-PARTICIPANT' }],
    });
    expect(ics).toContain('ATTENDEE');
    expect(ics).toContain('PARTSTAT=ACCEPTED');
  });
});

describe('IcalHelper.expandOccurrences', () => {
  it('expands a weekly RRULE across a 4-week range', () => {
    const events = IcalHelper.parseEvents(
      [
        'BEGIN:VCALENDAR',
        'VERSION:2.0',
        'BEGIN:VEVENT',
        'UID:r@test',
        'SUMMARY:Wk',
        'DTSTART:20250620T140000Z',
        'DTEND:20250620T143000Z',
        'RRULE:FREQ=WEEKLY',
        'END:VEVENT',
        'END:VCALENDAR',
      ].join('\r\n'),
    );
    const occ = IcalHelper.expandOccurrences(events, {
      start: new Date('2025-06-20T00:00:00Z'),
      end: new Date('2025-07-18T00:00:00Z'),
    });
    expect(occ.length).toBeGreaterThanOrEqual(4);
    expect(occ.length).toBeLessThanOrEqual(6);
    expect(occ.every((o) => o.uid === 'r@test')).toBe(true);
  });

  it('includes a non-recurring event that falls in range', () => {
    const events = IcalHelper.parseEvents(ICS);
    const occ = IcalHelper.expandOccurrences(events, {
      start: new Date('2025-06-20T00:00:00Z'),
      end: new Date('2025-06-21T00:00:00Z'),
    });
    expect(occ.length).toBe(1);
    expect(occ[0]!.start.toISOString()).toBe('2025-06-20T14:00:00.000Z');
  });
});
