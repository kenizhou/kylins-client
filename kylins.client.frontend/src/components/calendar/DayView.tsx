// Day view — a single day's occurrences, sorted by start time, each with its
// time label. (Hour-grid absolute positioning is deferred alongside WeekView.)

import { useCalendarStore } from '@/stores/calendarStore';
import type { Occurrence } from '@/services/calendar/icalHelper';
import { dayKey, startOfDay } from './range';

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
      <h3 className="mb-3 text-sm font-semibold text-[var(--foreground)]">{header}</h3>
      <div className="space-y-2">
        {items.map((o) => (
          <div
            key={`${o.uid}-${o.start.getTime()}`}
            className="flex gap-3 rounded border border-[var(--border)] bg-[var(--surface)] px-3 py-2"
          >
            <div className="w-28 shrink-0 text-xs text-[var(--muted-text)]">{timeLabel(o)}</div>
            <div className="text-sm text-[var(--foreground)]">{o.summary ?? '(no title)'}</div>
          </div>
        ))}
        {items.length === 0 && (
          <div className="text-sm text-[var(--muted-foreground)]">No events.</div>
        )}
      </div>
    </div>
  );
}
