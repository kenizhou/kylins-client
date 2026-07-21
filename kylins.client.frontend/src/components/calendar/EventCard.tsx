// A single occurrence chip, used by all calendar views.

import type { Occurrence } from '@/services/calendar/icalHelper';

export function EventCard({ occurrence }: { occurrence: Occurrence }) {
  const time = occurrence.allDay
    ? 'all-day'
    : occurrence.start.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  const title = occurrence.summary ?? '(no title)';
  const accentColor = occurrence.color || 'var(--primary)';
  return (
    <div
      className="group flex cursor-pointer items-center gap-1 truncate rounded-md border-l-[3px] px-1.5 py-1 text-xs text-[var(--text)] transition-colors"
      style={{
        borderLeftColor: accentColor,
        backgroundColor: `color-mix(in srgb, ${accentColor} 12%, var(--surface-elevated))`,
      }}
      title={`${time} — ${title}`}
    >
      <span className="type-caption tabular-nums text-[var(--muted-text)]">{time}</span>
      <span className="truncate">{title}</span>
    </div>
  );
}
