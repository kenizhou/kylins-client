// Day view — a single day's occurrences, sorted by start time, each with its
// time label. (Hour-grid absolute positioning is deferred alongside WeekView.)

import { useCalendarStore } from '@/stores/calendarStore';
import type { Occurrence } from '@/services/calendar/icalHelper';
import { dayKey, startOfDay } from './range';
import { CalendarIcon } from '../icons';

function timeLabel(o: Occurrence): string {
  if (o.allDay) return 'All day';
  const fmt = { hour: 'numeric', minute: '2-digit' } as const;
  const start = o.start.toLocaleTimeString([], fmt);
  const end = o.end ? ` – ${o.end.toLocaleTimeString([], fmt)}` : '';
  return `${start}${end}`;
}

export function DayView() {
  const currentDate = useCalendarStore((s) => s.currentDate);
  const occurrences = useCalendarStore((s) => s.occurrences);

  const k = dayKey(startOfDay(currentDate));
  const items = occurrences
    .filter((o) => dayKey(o.start) === k)
    .sort((a, b) => a.start.getTime() - b.start.getTime());

  const header = currentDate.toLocaleDateString(undefined, {
    weekday: 'long',
    month: 'long',
    day: 'numeric',
  });

  return (
    <div className="flex-1 overflow-auto p-4">
      <h3 className="mb-4 text-base font-semibold text-[var(--foreground)]">{header}</h3>
      <div className="space-y-2">
        {items.map((o) => (
          <div
            key={`${o.uid}-${o.start.getTime()}`}
            className="group flex gap-3 rounded-lg border border-[var(--border-subtle)] border-l-[3px] border-l-[var(--primary)] bg-[var(--surface)] px-3 py-2 transition-colors hover:border-[var(--primary)] hover:bg-[var(--primary-subtle)]"
          >
            <div className="w-24 shrink-0 text-xs text-[var(--muted-text)]">
              {o.allDay ? (
                <span className="rounded bg-[var(--primary-subtle)] px-1.5 py-0.5 text-[0.625rem] font-medium text-[var(--foreground)]">
                  All day
                </span>
              ) : (
                timeLabel(o)
              )}
            </div>
            <div className="min-w-0 flex-1 text-sm text-[var(--foreground)]">
              {o.summary ?? '(no title)'}
            </div>
          </div>
        ))}
        {items.length === 0 && (
          <div className="flex flex-col items-center justify-center gap-2 py-8 text-sm text-[var(--muted-text)]">
            <div className="rounded-full bg-surface-elevated p-3">
              <CalendarIcon size={24} />
            </div>
            No events scheduled for this day.
          </div>
        )}
      </div>
    </div>
  );
}
