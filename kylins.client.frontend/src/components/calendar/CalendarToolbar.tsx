// Calendar header: prev/next/today, view switcher, and a "New event" action.

import type { CalendarView } from '@/stores/calendarStore';
import { useCalendarStore } from '@/stores/calendarStore';
import { addDays } from './range';

const VIEWS: { key: CalendarView; label: string }[] = [
  { key: 'month', label: 'Month' },
  { key: 'week', label: 'Week' },
  { key: 'day', label: 'Day' },
  { key: 'agenda', label: 'Agenda' },
];

interface CalendarToolbarProps {
  onNewEvent: () => void;
}

export function CalendarToolbar({ onNewEvent }: CalendarToolbarProps) {
  const currentDate = useCalendarStore((s) => s.currentDate);
  const view = useCalendarStore((s) => s.view);
  const setCurrentDate = useCalendarStore((s) => s.setCurrentDate);
  const setView = useCalendarStore((s) => s.setView);

  const shift = (delta: number) => {
    if (view === 'month') {
      const d = new Date(currentDate);
      d.setMonth(d.getMonth() + delta);
      setCurrentDate(d);
    } else if (view === 'agenda') {
      setCurrentDate(addDays(currentDate, delta * 7));
    } else {
      setCurrentDate(addDays(currentDate, delta * (view === 'day' ? 1 : 7)));
    }
  };

  const title = currentDate.toLocaleDateString(undefined, {
    month: 'long',
    year: 'numeric',
  });

  return (
    <div className="flex items-center gap-2 border-b border-[var(--border)] bg-[var(--surface)] px-4 py-2">
      <button
        onClick={() => setCurrentDate(new Date())}
        className="rounded border border-[var(--border)] px-2 py-1 text-xs text-[var(--foreground)] hover:bg-[var(--hover)]"
      >
        Today
      </button>
      <div className="flex items-center">
        <button
          onClick={() => shift(-1)}
          className="rounded-l border border-[var(--border)] px-2 py-1 text-xs hover:bg-[var(--hover)]"
          aria-label="Previous"
        >
          ‹
        </button>
        <button
          onClick={() => shift(1)}
          className="rounded-r border-l-0 border-[var(--border)] px-2 py-1 text-xs hover:bg-[var(--hover)]"
          aria-label="Next"
        >
          ›
        </button>
      </div>
      <h2 className="ml-1 text-sm font-semibold text-[var(--foreground)]">{title}</h2>

      <div className="ml-auto flex items-center gap-2">
        <div className="flex overflow-hidden rounded border border-[var(--border)]">
          {VIEWS.map((v) => (
            <button
              key={v.key}
              onClick={() => setView(v.key)}
              className={`px-2 py-1 text-xs ${
                view === v.key
                  ? 'bg-[var(--primary)] text-[var(--primary-fg)]'
                  : 'text-[var(--foreground)] hover:bg-[var(--hover)]'
              }`}
            >
              {v.label}
            </button>
          ))}
        </div>
        <button
          onClick={onNewEvent}
          className="flex items-center gap-1 rounded bg-[var(--primary)] px-2.5 py-1 text-xs text-[var(--primary-fg)] hover:opacity-90"
        >
          New event
        </button>
      </div>
    </div>
  );
}
