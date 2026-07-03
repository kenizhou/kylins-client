// Calendar container: owns the create-event modal, derives the visible range
// from the store's cursor+view, and loads+expands occurrences for the active
// account. Renders the active view component.

import { useEffect, useState } from 'react';
import { useCalendarStore } from '@/stores/calendarStore';
import { useAccountStore } from '@/stores/accountStore';
import { getViewRange, toUnixSeconds } from './range';
import { CalendarToolbar } from './CalendarToolbar';
import { MonthView } from './MonthView';
import { WeekView } from './WeekView';
import { DayView } from './DayView';
import { AgendaView } from './AgendaView';
import { EventCreateModal } from './EventCreateModal';
import { CalendarIcon } from '../icons';

export function CalendarPage() {
  const currentDate = useCalendarStore((s) => s.currentDate);
  const view = useCalendarStore((s) => s.view);
  const loading = useCalendarStore((s) => s.loading);
  const error = useCalendarStore((s) => s.error);
  const loadOccurrences = useCalendarStore((s) => s.loadOccurrences);
  const activeAccountId = useAccountStore((s) => s.activeAccountId);
  const [showCreate, setShowCreate] = useState(false);

  const reload = () => {
    if (!activeAccountId) return;
    const { start, end } = getViewRange(view, currentDate);
    loadOccurrences(activeAccountId, toUnixSeconds(start), toUnixSeconds(end));
  };

  useEffect(() => {
    reload();
    // reload is stable enough (depends only on store actions + primitives); view
    // and currentDate drive re-loads.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeAccountId, currentDate, view, loadOccurrences]);

  if (!activeAccountId) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-2 text-sm text-[var(--muted-foreground)]">
        <div className="rounded-full bg-[var(--surface)] p-3">
          <CalendarIcon size={24} />
        </div>
        No account selected.
      </div>
    );
  }

  return (
    <div className="flex flex-1 flex-col overflow-hidden rounded-xl border border-[var(--border)] bg-[var(--card)]">
      <CalendarToolbar onNewEvent={() => setShowCreate(true)} />
      {error && (
        <div className="flex items-center gap-1.5 border-b border-[var(--destructive)]/30 bg-[var(--destructive)]/10 px-4 py-1.5 text-xs text-[var(--destructive)]">
          <span className="h-1.5 w-1.5 rounded-full bg-[var(--destructive)]" />
          {error}
        </div>
      )}
      <div className="relative flex flex-1 flex-col overflow-hidden">
        {loading && (
          <div className="absolute right-3 top-2 flex items-center gap-1.5 text-xs text-[var(--muted-foreground)]">
            <span className="inline-block h-3 w-3 animate-spin rounded-full border-2 border-current border-t-transparent" />
            Loading…
          </div>
        )}
        {view === 'month' && <MonthView />}
        {view === 'week' && <WeekView />}
        {view === 'day' && <DayView />}
        {view === 'agenda' && <AgendaView />}
      </div>
      {showCreate && (
        <EventCreateModal
          accountId={activeAccountId}
          onClose={() => setShowCreate(false)}
          onCreated={reload}
        />
      )}
    </div>
  );
}
