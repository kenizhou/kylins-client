import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { DbCalendar } from '@/services/db/calendars';
import type { DbCalendarEvent } from '@/services/db/calendarEvents';

const mockGetAllCalendars = vi.fn<() => Promise<DbCalendar[]>>();
const mockSetCalendarVisible = vi.fn<() => Promise<void>>();
const mockGetCalendarEventsInRangeForCalendars = vi.fn<() => Promise<DbCalendarEvent[]>>();
const mockExpandStoredEvents =
  vi.fn<typeof import('@/services/calendar/recurrenceExpander').expandStoredEvents>();

vi.mock('@/services/db/calendars', () => ({
  getAllCalendars: () => mockGetAllCalendars(),
  getCalendarsForAccount: vi.fn(),
  getCalendarById: vi.fn(),
  createCalendar: vi.fn(),
  updateCalendar: vi.fn(),
  deleteCalendar: vi.fn(),
  setCalendarVisible: (id: string, visible: boolean) => mockSetCalendarVisible(id, visible),
  setPrimaryCalendar: vi.fn(),
}));

vi.mock('@/services/db/calendarEvents', () => ({
  getCalendarEventsForAccount: vi.fn(),
  getCalendarEventsInRange: vi.fn(),
  getCalendarEventsInRangeForCalendars: (
    calendarIds: string[],
    rangeStart: number,
    rangeEnd: number,
  ) => mockGetCalendarEventsInRangeForCalendars(calendarIds, rangeStart, rangeEnd),
  getCalendarEventById: vi.fn(),
  insertCalendarEvent: vi.fn(),
  updateCalendarEvent: vi.fn(),
  deleteCalendarEvent: vi.fn(),
}));

vi.mock('@/services/calendar/recurrenceExpander', () => ({
  expandStoredEvents: (
    ...args: Parameters<typeof import('@/services/calendar/recurrenceExpander').expandStoredEvents>
  ) => mockExpandStoredEvents(...args),
}));

import { useCalendarStore } from '@/stores/calendarStore';

const ICS_EVENT = `BEGIN:VCALENDAR
VERSION:2.0
BEGIN:VEVENT
UID:store-test-event
DTSTART:20260705T090000Z
DTEND:20260705T100000Z
SUMMARY:Store test event
END:VEVENT
END:VCALENDAR`;

const RANGE_START = 1751232000; // 2026-07-01T00:00:00Z
const RANGE_END = 1754006400; // 2026-07-31T00:00:00Z

describe('calendarStore', () => {
  beforeEach(() => {
    useCalendarStore.getState().clear();
    mockGetAllCalendars.mockReset();
    mockSetCalendarVisible.mockReset();
    mockGetCalendarEventsInRangeForCalendars.mockReset();
    mockExpandStoredEvents.mockReset();
  });

  it('loadCalendars populates the calendar source list', async () => {
    mockGetAllCalendars.mockResolvedValue([
      makeCalendar('cal-1', 'Work', true, true),
      makeCalendar('cal-2', 'Personal', true, true),
      makeCalendar('cal-3', 'Hidden', false, false),
    ]);

    await useCalendarStore.getState().loadCalendars();
    const state = useCalendarStore.getState();

    expect(state.calendars).toHaveLength(3);
    expect(state.calendars[0].displayName).toBe('Work');
  });

  it('loadOccurrences queries only visible calendars and propagates calendar colors', async () => {
    mockGetAllCalendars.mockResolvedValue([
      makeCalendar('cal-1', 'Work', true, true, '#ef4444'),
      makeCalendar('cal-2', 'Personal', true, true, '#22c55e'),
      makeCalendar('cal-3', 'Hidden', false, false),
    ]);

    mockGetCalendarEventsInRangeForCalendars.mockResolvedValue([
      {
        id: 'event-1',
        account_id: 'acc-1',
        calendar_id: 'cal-1',
        google_event_id: null,
        remote_event_id: null,
        uid: 'store-test-event',
        summary: 'Store test event',
        description: null,
        location: null,
        start_time: 1751706000,
        end_time: 1751709600,
        is_all_day: 0,
        status: null,
        organizer_email: null,
        attendees_json: null,
        ical_data: ICS_EVENT,
        etag: null,
        recurrence_start: 1751706000,
        recurrence_end: 1751709600,
        updated_at: 1751706000,
      } satisfies DbCalendarEvent,
    ]);

    mockExpandStoredEvents.mockReturnValue([
      {
        uid: 'store-test-event',
        summary: 'Store test event',
        start: new Date('2026-07-05T09:00:00Z'),
        end: new Date('2026-07-05T10:00:00Z'),
        allDay: false,
        eventId: 'event-1',
        calendarId: 'cal-1',
        color: '#ef4444',
      },
    ]);

    await useCalendarStore.getState().loadCalendars();
    await useCalendarStore.getState().loadOccurrences(RANGE_START, RANGE_END);

    const state = useCalendarStore.getState();
    expect(mockGetCalendarEventsInRangeForCalendars).toHaveBeenCalledWith(
      expect.arrayContaining(['cal-1', 'cal-2']),
      RANGE_START,
      RANGE_END,
    );
    expect(mockGetCalendarEventsInRangeForCalendars).toHaveBeenCalledTimes(1);
    expect(mockExpandStoredEvents).toHaveBeenCalled();
    const passedRows = mockExpandStoredEvents.mock.calls[0][0];
    expect(passedRows).toHaveLength(1);
    expect(passedRows[0].id).toBe('event-1');
    expect(passedRows[0].calendarId).toBe('cal-1');
    expect(passedRows[0].color).toBe('#ef4444');
    expect(state.events).toHaveLength(1);
    expect(state.occurrences).toHaveLength(1);
    expect(state.occurrences[0].calendarId).toBe('cal-1');
    expect(state.occurrences[0].color).toBe('#ef4444');
    expect(state.lastRange).toEqual({ start: RANGE_START, end: RANGE_END });
  });

  it('toggleCalendarVisibility reloads the calendar list and refreshes the current range', async () => {
    mockGetAllCalendars.mockResolvedValue([
      makeCalendar('cal-1', 'Work', true, true),
      makeCalendar('cal-2', 'Personal', true, true),
    ]);
    mockGetCalendarEventsInRangeForCalendars.mockResolvedValue([]);
    mockExpandStoredEvents.mockReturnValue([]);

    await useCalendarStore.getState().loadCalendars();
    await useCalendarStore.getState().loadOccurrences(RANGE_START, RANGE_END);
    mockGetCalendarEventsInRangeForCalendars.mockClear();

    await useCalendarStore.getState().toggleCalendarVisibility('cal-1', false);

    expect(mockSetCalendarVisible).toHaveBeenCalledWith('cal-1', false);
    expect(mockGetCalendarEventsInRangeForCalendars).toHaveBeenCalledTimes(1);
  });
});

function makeCalendar(
  id: string,
  displayName: string,
  isVisible: boolean,
  isPrimary: boolean,
  color = '#3b82f6',
): DbCalendar {
  return {
    id,
    accountId: 'acc-1',
    provider: 'local',
    remoteId: '',
    displayName,
    color,
    isPrimary,
    isVisible,
    syncToken: null,
    ctag: null,
    createdAt: 0,
    updatedAt: 0,
  };
}
