// A single occurrence chip, used by all calendar views.

import type { Occurrence } from '@/services/calendar/icalHelper';

export function EventCard({ occurrence }: { occurrence: Occurrence }) {
  const time = occurrence.allDay
    ? 'all-day'
    : occurrence.start.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  const title = occurrence.summary ?? '(no title)';
  return (
    <div
      className="truncate rounded bg-[var(--accent)] px-1.5 py-0.5 text-[0.6875rem] text-[var(--selected-text)]"
      title={`${time} — ${title}`}
    >
      <span className="font-medium">{time}</span> {title}
    </div>
  );
}
