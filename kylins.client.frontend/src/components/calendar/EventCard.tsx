// A single occurrence chip, used by all calendar views.

import type { Occurrence } from '@/services/calendar/icalHelper';

export function EventCard({ occurrence }: { occurrence: Occurrence }) {
  const time = occurrence.allDay
    ? 'all-day'
    : occurrence.start.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  const title = occurrence.summary ?? '(no title)';
  return (
    <div
      className="group flex cursor-pointer items-center gap-1 truncate rounded border-l-2 border-[var(--primary)] bg-[var(--secondary)] px-1.5 py-1 text-xs text-[var(--foreground)] transition-colors hover:bg-[var(--hover)]"
      title={`${time} — ${title}`}
    >
      <span className="font-medium text-[var(--muted-text)]">{time}</span>
      <span className="truncate">{title}</span>
    </div>
  );
}
