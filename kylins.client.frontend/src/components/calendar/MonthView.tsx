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

  const byDay = useMemo(() => groupOccurrencesByDay(occurrences), [occurrences]);

  const first = new Date(currentDate.getFullYear(), currentDate.getMonth(), 1);
  const gridStart = addDays(startOfDay(first), -first.getDay());
  const cells = Array.from({ length: 42 }, (_, i) => addDays(gridStart, i));
  const todayKey = dayKey(new Date());

  return (
    <div className="flex flex-1 flex-col overflow-hidden">
      <div className="grid grid-cols-7 border-b border-[var(--border)] text-xs text-[var(--muted-foreground)]">
        {WEEKDAYS.map((d) => (
          <div key={d} className="px-2 py-1">
            {d}
          </div>
        ))}
      </div>
      <div className="grid flex-1 grid-cols-7 overflow-auto">
        {cells.map((date) => {
          const k = dayKey(date);
          const inMonth = date.getMonth() === currentDate.getMonth();
          const items = byDay.get(k) ?? [];
          return (
            <div
              key={k}
              className={`min-h-[80px] border-b border-r border-[var(--border)] p-1 ${
                inMonth ? '' : 'bg-[var(--surface)]'
              }`}
            >
              <div
                className={`mb-0.5 text-xs ${
                  k === todayKey
                    ? 'inline-flex h-5 w-5 items-center justify-center rounded-full bg-[var(--primary)] text-[var(--primary-fg)]'
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
                  <div className="text-[0.625rem] text-[var(--muted-foreground)]">
                    +{items.length - 3} more
                  </div>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
