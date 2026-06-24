// Agenda view — a chronological, day-grouped list across the loaded range.

import { useMemo } from 'react';
import { useCalendarStore } from '@/stores/calendarStore';
import { groupOccurrencesByDay } from './range';

export function AgendaView() {
  const occurrences = useCalendarStore((s) => s.occurrences);

  const byDay = useMemo(() => {
    const sorted = occurrences.slice().sort((a, b) => a.start.getTime() - b.start.getTime());
    return groupOccurrencesByDay(sorted);
  }, [occurrences]);

  if (byDay.size === 0) {
    return (
      <div className="flex flex-1 items-center justify-center text-sm text-[var(--muted-foreground)]">
        No upcoming events.
      </div>
    );
  }

  return (
    <div className="flex-1 overflow-auto p-4">
      {[...byDay.entries()].map(([k, items]) => {
        const date = new Date(k);
        return (
          <div key={k} className="mb-4">
            <div className="mb-1 text-xs font-semibold uppercase text-[var(--muted-foreground)]">
              {date.toLocaleDateString(undefined, {
                weekday: 'long',
                month: 'short',
                day: 'numeric',
              })}
            </div>
            <div className="space-y-1">
              {items.map((o) => (
                <div
                  key={`${o.uid}-${o.start.getTime()}`}
                  className="flex gap-3 rounded border border-[var(--border)] bg-[var(--surface)] px-3 py-1.5"
                >
                  <div className="w-28 shrink-0 text-xs text-[var(--muted-text)]">
                    {o.allDay
                      ? 'All day'
                      : o.start.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}
                  </div>
                  <div className="text-sm text-[var(--foreground)]">
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
