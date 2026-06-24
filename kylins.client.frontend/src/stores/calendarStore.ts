// Calendar UI store (Zustand). Extracted from velo's CalendarPage `useState` so
// view state survives navigation and multi-account aggregation can be layered on
// later. Holds the cursor date, active view, and the currently-expanded
// occurrences; loading occurrences from the DB is an explicit action.

import { create } from 'zustand';
import type { Occurrence } from '@/services/calendar/icalHelper';
import { getCalendarEventsInRange, type DbCalendarEvent } from '@/services/db/calendarEvents';
import { expandStoredEvents } from '@/services/calendar/recurrenceExpander';

export type CalendarView = 'month' | 'week' | 'day' | 'agenda';

export interface CalendarState {
  currentDate: Date;
  view: CalendarView;
  loading: boolean;
  occurrences: Occurrence[];
  /** The last raw rows loaded (for detail modals / editors). */
  events: DbCalendarEvent[];
  error: string | null;
  setCurrentDate: (date: Date) => void;
  setView: (view: CalendarView) => void;
  /** Load + expand occurrences for an account within a unix-seconds range. */
  loadOccurrences: (accountId: string, rangeStart: number, rangeEnd: number) => Promise<void>;
  clear: () => void;
}

export const useCalendarStore = create<CalendarState>((set) => ({
  currentDate: new Date(),
  view: 'month',
  loading: false,
  occurrences: [],
  events: [],
  error: null,

  setCurrentDate: (currentDate) => set({ currentDate }),
  setView: (view) => set({ view }),

  loadOccurrences: async (accountId, rangeStart, rangeEnd) => {
    set({ loading: true, error: null });
    try {
      const rows = await getCalendarEventsInRange(accountId, rangeStart, rangeEnd);
      const occurrences = expandStoredEvents(
        rows.map((r) => ({ uid: r.uid ?? r.id, icalData: r.ical_data })),
        {
          start: new Date(rangeStart * 1000),
          end: new Date(rangeEnd * 1000),
        },
      );
      set({ events: rows, occurrences, loading: false });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      set({ loading: false, error: message });
    }
  },

  clear: () => set({ occurrences: [], events: [], error: null }),
}));
