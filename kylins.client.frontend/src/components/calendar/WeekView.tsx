// Week view — 7 day columns, each listing that day's occurrences. (Time-grid
// absolute positioning + overlap packing is deferred — see plan §6.3; this list
// layout is correct and readable while that math is ported.)

import { useMemo } from 'react';
import { useCalendarStore } from '@/stores/calendarStore';
import { addDays, dayKey, groupOccurrencesByDay, startOfDay } from './range';
import { EventCard } from './EventCard';

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

export function WeekView() {
  const currentDate = useCalendarStore((s) => s.currentDate);
  const occurrences = useCalendarStore((s) => s.occurrences);

  const byDay = useMemo(() => groupOccurrencesByDay(occurrences), [occurrences]);

  const start = startOfDay(currentDate);
  const weekStart = addDays(start, -start.getDay());
  const days = Array.from({ length: 7 }, (_, i) => addDays(weekStart, i));
  const todayKey = dayKey(new Date());

  return (
    <div className="grid flex-1 grid-cols-7 overflow-auto">
      {days.map((date) => {
        const k = dayKey(date);
        const items = (byDay.get(k) ?? [])
          .slice()
          .sort((a, b) => a.start.getTime() - b.start.getTime());
        const isToday = k === todayKey;
        return (
          <div key={k} className="flex min-h-[120px] flex-col border-r border-[var(--border)]">
            <div
              className={`border-b border-[var(--border)] px-2 py-1 text-xs ${
                isToday ? 'font-semibold text-[var(--primary)]' : 'text-[var(--muted-text)]'
              }`}
            >
              {WEEKDAYS[date.getDay()]} {date.getDate()}
            </div>
            <div className="space-y-1 p-1">
              {items.map((o) => (
                <EventCard key={`${o.uid}-${o.start.getTime()}`} occurrence={o} />
              ))}
              {items.length === 0 && (
                <div className="text-[0.625rem] text-[var(--muted-foreground)]">—</div>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}
