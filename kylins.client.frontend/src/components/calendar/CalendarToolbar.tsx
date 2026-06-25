// Calendar header: prev/next/today, view switcher, and a "New event" action.

import type { CalendarView } from '@/stores/calendarStore';
import { useCalendarStore } from '@/stores/calendarStore';
import { PlusIcon, ArrowLeftIcon, ArrowRightIcon } from '../icons';
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
        className="rounded-md border border-[var(--border)] px-3 py-1.5 text-xs font-medium text-[var(--foreground)] transition-colors hover:bg-[var(--hover)]"
      >
        Today
      </button>
      <div className="flex items-center rounded-md border border-[var(--border)] overflow-hidden">
        <button
          onClick={() => shift(-1)}
          className="flex h-7 w-7 items-center justify-center border-r border-[var(--border)] text-[var(--muted-text)] transition-colors hover:bg-[var(--hover)] hover:text-[var(--foreground)]"
          aria-label="Previous"
        >
          <ArrowLeftIcon size={14} />
        </button>
        <button
          onClick={() => shift(1)}
          className="flex h-7 w-7 items-center justify-center text-[var(--muted-text)] transition-colors hover:bg-[var(--hover)] hover:text-[var(--foreground)]"
          aria-label="Next"
        >
          <ArrowRightIcon size={14} />
        </button>
      </div>
      <h2 className="ml-1 text-base font-semibold text-[var(--foreground)]">{title}</h2>

      <div className="ml-auto flex items-center gap-2">
        <div className="flex overflow-hidden rounded-md border border-[var(--border)] divide-x divide-[var(--border)]">
          {VIEWS.map((v) => (
            <button
              key={v.key}
              onClick={() => setView(v.key)}
              className={`px-2.5 py-1.5 text-xs transition-colors ${
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
          className="flex items-center gap-1 rounded-md bg-[var(--primary)] px-3 py-1.5 text-xs font-medium text-[var(--primary-fg)] transition-colors hover:opacity-90"
        >
          <PlusIcon size={13} />
          New event
        </button>
      </div>
    </div>
  );
}
