// Agenda view — a chronological, day-grouped list across the loaded range.

import { useMemo } from 'react';
import { useCalendarStore } from '@/stores/calendarStore';
import { groupOccurrencesByDay, dayKey } from './range';
import { CalendarIcon } from '@/components/icons';

export function AgendaView() {
  const occurrences = useCalendarStore((s) => s.occurrences);

  const byDay = useMemo(() => {
    const sorted = occurrences.slice().sort((a, b) => a.start.getTime() - b.start.getTime());
    return groupOccurrencesByDay(sorted);
  }, [occurrences]);

  if (byDay.size === 0) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-2 text-sm text-[var(--muted-text)]">
        <div className="rounded-full bg-surface-elevated p-3">
          <CalendarIcon size={24} />
        </div>
        No upcoming events.
      </div>
    );
  }

  return (
    <div className="flex-1 overflow-auto p-4">
      {[...byDay.entries()].map(([k, items]) => {
        const [year, month, day] = k.split('-') as [string, string, string];
        const date = new Date(Number(year), Number(month) - 1, Number(day));
        const isToday = k === dayKey(new Date());
        return (
          <div key={k} className="mb-3">
            <div
              className={`sticky top-0 z-10 mb-1 bg-[var(--background)] pb-1 pt-1 ${
                isToday ? 'font-semibold text-primary' : 'text-[var(--muted-text)]'
              }`}
            >
              <span className="type-overline">
                {date.toLocaleDateString(undefined, { weekday: 'long' })}
              </span>{' '}
              <span className="tabular-nums">
                {date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}
              </span>
            </div>
            <div className="space-y-1">
              {items.map((o) => (
                <div
                  key={`${o.uid}-${o.start.getTime()}`}
                  className="group flex gap-3 rounded-lg border border-[var(--border-subtle)] border-l-[3px] border-l-[var(--primary)] bg-[var(--surface)] px-3 py-2 transition-colors hover:border-[var(--primary)] hover:bg-[var(--primary-subtle)]"
                >
                  <div className="type-caption w-24 shrink-0 tabular-nums text-[var(--muted-text)]">
                    {o.allDay ? (
                      <span className="rounded bg-[var(--primary-subtle)] px-1.5 py-0.5 text-[0.625rem] font-medium text-[var(--foreground)]">
                        All day
                      </span>
                    ) : (
                      o.start.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
                    )}
                  </div>
                  <div className="min-w-0 flex-1 text-sm text-[var(--foreground)]">
                    {o.summary ?? '(no title)'}
                  </div>
                </div>
              ))}
            </div>
          </div>
        );
      })}
    </div>
  );
}
