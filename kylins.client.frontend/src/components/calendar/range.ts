// Calendar view-range math. Given the cursor date and the active view, produce
// the [start, end) window the store should load occurrences for.

import type { CalendarView } from '@/stores/calendarStore';
import type { Occurrence } from '@/services/calendar/icalHelper';

export function startOfDay(d: Date): Date {
  const x = new Date(d);
  x.setHours(0, 0, 0, 0);
  return x;
}

export function addDays(d: Date, n: number): Date {
  const x = new Date(d);
  x.setDate(x.getDate() + n);
  return x;
}

export function getViewRange(view: CalendarView, cursor: Date): { start: Date; end: Date } {
  const s = startOfDay(cursor);
  if (view === 'day') return { start: s, end: addDays(s, 1) };
  if (view === 'agenda') return { start: s, end: addDays(s, 31) };
  if (view === 'week') {
    const dow = s.getDay();
    return { start: addDays(s, -dow), end: addDays(s, 7 - dow) };
  }
  // month: a 6-week grid starting on Sunday.
  const first = new Date(s.getFullYear(), s.getMonth(), 1);
  const gridStart = addDays(first, -first.getDay());
  return { start: gridStart, end: addDays(gridStart, 42) };
}

export function toUnixSeconds(d: Date): number {
  return Math.floor(d.getTime() / 1000);
}

/** Local YYYY-MM-DD key for grouping occurrences by day. */
export function dayKey(d: Date): string {
  const x = startOfDay(d);
  return `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, '0')}-${String(
    x.getDate(),
  ).padStart(2, '0')}`;
}

/** Group occurrences into a Map<dayKey, Occurrence[]> (unsorted).
 *  Multi-day events appear under every day they span.
 */
export function groupOccurrencesByDay(occurrences: Occurrence[]): Map<string, Occurrence[]> {
  const m = new Map<string, Occurrence[]>();
  for (const o of occurrences) {
    const startDay = startOfDay(o.start);
    const end = o.end ?? o.start;
    // Events ending exactly at midnight belong to the previous day; events
    // ending after midnight also belong to that day.
    const lastDay =
      end.getTime() > startDay.getTime() ? startOfDay(new Date(end.getTime() - 1)) : startDay;
    for (let d = new Date(startDay); d.getTime() <= lastDay.getTime(); d = addDays(d, 1)) {
      const k = dayKey(d);
      const arr = m.get(k);
      if (arr) arr.push(o);
      else m.set(k, [o]);
    }
  }
  return m;
}
