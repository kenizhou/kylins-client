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
      <div className="flex flex-1 items-center justify-center text-sm text-[var(--muted-foreground)]">
        No account selected.
      </div>
    );
  }

  return (
    <div className="flex flex-1 flex-col overflow-hidden">
      <CalendarToolbar onNewEvent={() => setShowCreate(true)} />
      {error && (
        <div className="bg-[var(--secondary)] px-4 py-1 text-xs text-[var(--destructive)]">
          {error}
        </div>
      )}
      <div className="relative flex flex-1 flex-col overflow-hidden">
        {loading && (
          <div className="absolute right-3 top-2 text-xs text-[var(--muted-foreground)]">
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
