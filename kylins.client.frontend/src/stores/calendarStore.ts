// Calendar UI store (Zustand). Holds the cursor date, active view, the calendar
// source list, and the expanded occurrences.

import { create } from 'zustand';
import type { Occurrence } from '@/services/calendar/icalHelper';
import {
  getCalendarEventsInRangeForCalendars,
  type DbCalendarEvent,
} from '@/services/db/calendarEvents';
import {
  createCalendar,
  deleteCalendar,
  getAllCalendars,
  setCalendarVisible,
  setPrimaryCalendar,
  updateCalendar,
  type DbCalendar,
  type UpsertCalendarInput,
} from '@/services/db/calendars';
import { expandStoredEvents } from '@/services/calendar/recurrenceExpander';

export type CalendarView = 'month' | 'week' | 'day' | 'agenda';

export interface CalendarState {
  currentDate: Date;
  view: CalendarView;
  loading: boolean;
  loadingCalendars: boolean;
  occurrences: Occurrence[];
  /** The last raw rows loaded (for detail modals / editors). */
  events: DbCalendarEvent[];
  /** All calendars across accounts. */
  calendars: DbCalendar[];
  /** The last range requested by loadOccurrences, used to refresh after metadata changes. */
  lastRange: { start: number; end: number } | null;
  error: string | null;
  setCurrentDate: (date: Date) => void;
  setView: (view: CalendarView) => void;
  /** Load the calendar source list from the backend. */
  loadCalendars: () => Promise<void>;
  /** Load + expand occurrences for the visible calendars within a unix-seconds range. */
  loadOccurrences: (rangeStart: number, rangeEnd: number) => Promise<void>;
  toggleCalendarVisibility: (id: string, visible: boolean) => Promise<void>;
  createCalendar: (input: {
    accountId: string;
    displayName: string;
    color?: string;
  }) => Promise<DbCalendar>;
  updateCalendar: (id: string, updates: Partial<DbCalendar>) => Promise<void>;
  deleteCalendar: (id: string) => Promise<void>;
  setPrimaryCalendar: (id: string, accountId: string) => Promise<void>;
  clear: () => void;
}

/** Counter used to discard stale in-flight range queries. */
let loadOccurrencesRequestId = 0;

export const useCalendarStore = create<CalendarState>((set, get) => ({
  currentDate: new Date(),
  view: 'month',
  loading: false,
  loadingCalendars: false,
  occurrences: [],
  events: [],
  calendars: [],
  lastRange: null,
  error: null,

  setCurrentDate: (currentDate) => set({ currentDate }),
  setView: (view) => set({ view }),

  loadCalendars: async () => {
    set({ loadingCalendars: true });
    try {
      const calendars = await getAllCalendars();
      set({ calendars, loadingCalendars: false });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      set({ loadingCalendars: false, error: message });
    }
  },

  loadOccurrences: async (rangeStart, rangeEnd) => {
    const visibleCalendarIds = new Set(
      get()
        .calendars.filter((c) => c.isVisible)
        .map((c) => c.id),
    );
    if (visibleCalendarIds.size === 0) {
      set({
        occurrences: [],
        events: [],
        loading: false,
        lastRange: { start: rangeStart, end: rangeEnd },
      });
      return;
    }

    const requestId = ++loadOccurrencesRequestId;
    set({ loading: true, error: null, lastRange: { start: rangeStart, end: rangeEnd } });
    try {
      const rows = await getCalendarEventsInRangeForCalendars(
        Array.from(visibleCalendarIds),
        rangeStart,
        rangeEnd,
      );
      if (requestId !== loadOccurrencesRequestId) return;

      const colorByCalendar = new Map(get().calendars.map((c) => [c.id, c.color ?? undefined]));
      const occurrences = expandStoredEvents(
        rows.map((r) => ({
          uid: r.uid ?? r.id,
          id: r.id,
          calendarId: r.calendar_id ?? undefined,
          color: r.calendar_id ? colorByCalendar.get(r.calendar_id) : undefined,
          icalData: r.ical_data,
        })),
        {
          start: new Date(rangeStart * 1000),
          end: new Date(rangeEnd * 1000),
        },
      );
      set({ events: rows, occurrences, loading: false });
    } catch (err) {
      if (requestId !== loadOccurrencesRequestId) return;
      const message = err instanceof Error ? err.message : String(err);
      set({ loading: false, error: message });
    }
  },

  toggleCalendarVisibility: async (id, visible) => {
    await setCalendarVisible(id, visible);
    const calendars = await getAllCalendars();
    set({ calendars });
    const { lastRange, loadOccurrences } = get();
    if (lastRange) {
      await loadOccurrences(lastRange.start, lastRange.end);
    }
  },

  createCalendar: async ({ accountId, displayName, color }) => {
    const created = await createCalendar({
      accountId,
      displayName,
      color: color ?? null,
      isVisible: true,
    });
    const calendars = await getAllCalendars();
    set({ calendars });
    const { lastRange, loadOccurrences } = get();
    if (lastRange) {
      await loadOccurrences(lastRange.start, lastRange.end);
    }
    return created;
  },

  updateCalendar: async (id, updates) => {
    await updateCalendar(id, updates as UpsertCalendarInput);
    const calendars = await getAllCalendars();
    set({ calendars });
    const { lastRange, loadOccurrences } = get();
    if (lastRange) {
      await loadOccurrences(lastRange.start, lastRange.end);
    }
  },

  deleteCalendar: async (id) => {
    await deleteCalendar(id);
    set((state) => ({
      calendars: state.calendars.filter((c) => c.id !== id),
    }));
    const { lastRange, loadOccurrences } = get();
    if (lastRange) {
      await loadOccurrences(lastRange.start, lastRange.end);
    }
  },

  setPrimaryCalendar: async (id, accountId) => {
    await setPrimaryCalendar(id, accountId);
    const calendars = await getAllCalendars();
    set({ calendars });
  },

  clear: () => set({ occurrences: [], events: [], calendars: [], lastRange: null, error: null }),
}));
