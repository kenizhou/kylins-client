// Month view — a 6-week grid. Occurrences are bucketed by local day and shown
// as EventCard chips (up to 3 per cell, with a "+N more" overflow).

import { useMemo } from 'react';
import { useCalendarStore } from '@/stores/calendarStore';
import { addDays, dayKey, groupOccurrencesByDay, startOfDay } from './range';
import { EventCard } from './EventCard';

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

export function MonthView() {
  const currentDate = useCalendarStore((s) => s.currentDate);
  const occurrences = useCalendarStore((s) => s.occurrences);
  const setCurrentDate = useCalendarStore((s) => s.setCurrentDate);
  const setView = useCalendarStore((s) => s.setView);

  const byDay = useMemo(() => groupOccurrencesByDay(occurrences), [occurrences]);

  const first = new Date(currentDate.getFullYear(), currentDate.getMonth(), 1);
  const gridStart = addDays(startOfDay(first), -first.getDay());
  const cells = Array.from({ length: 42 }, (_, i) => addDays(gridStart, i));
  const todayKey = dayKey(new Date());

  const handleMore = (date: Date) => {
    setCurrentDate(date);
    setView('day');
  };

  return (
    <div className="flex flex-1 flex-col overflow-hidden">
      <div className="grid grid-cols-7 border-b border-[var(--border-subtle)] bg-[var(--surface)] text-xs font-medium text-[var(--muted-text)]">
        {WEEKDAYS.map((d) => (
          <div key={d} className="px-2 py-1.5">
            {d}
          </div>
        ))}
      </div>
      <div className="grid flex-1 grid-cols-7 overflow-auto border-l border-t border-[var(--border-subtle)]">
        {cells.map((date) => {
          const k = dayKey(date);
          const inMonth = date.getMonth() === currentDate.getMonth();
          const items = byDay.get(k) ?? [];
          const isToday = k === todayKey;
          return (
            <div
              key={k}
              className={`min-h-[96px] border-b border-r border-[var(--border-subtle)] p-1 transition-colors ${
                inMonth
                  ? 'bg-[var(--background)] hover:bg-[var(--primary-subtle)]'
                  : 'bg-surface-elevated'
              }`}
            >
              <div
                className={`mb-1 flex h-5 w-5 items-center justify-center text-xs ${
                  isToday
                    ? 'rounded-full bg-[var(--primary)] font-medium text-[var(--primary-fg)]'
                    : inMonth
                      ? 'text-[var(--foreground)]'
                      : 'text-[var(--muted-text)]'
                }`}
              >
                {date.getDate()}
              </div>
              <div className="space-y-0.5">
                {items.slice(0, 3).map((o) => (
                  <EventCard key={`${o.uid}-${o.start.getTime()}`} occurrence={o} />
                ))}
                {items.length > 3 && (
                  <button
                    type="button"
                    onClick={() => handleMore(date)}
                    className="mt-0.5 w-full rounded px-1 py-0.5 text-left text-[0.625rem] font-medium text-[var(--muted-text)] transition-colors hover:bg-[var(--primary-subtle)] hover:text-[var(--foreground)]"
                  >
                    +{items.length - 3} more
                  </button>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
