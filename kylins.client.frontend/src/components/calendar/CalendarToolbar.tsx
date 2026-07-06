// Calendar header: prev/next/today, view switcher, and a "New event" action.

import type { CalendarView } from '@/stores/calendarStore';
import { useCalendarStore } from '@/stores/calendarStore';
import { useViewStore } from '@/features/view/viewStore';
import {
  PlusIcon,
  ArrowLeftIcon,
  ArrowRightIcon,
  PanelLeftOpenIcon,
  PanelLeftCloseIcon,
} from '@/components/icons';
import { addDays } from './range';
import { Button } from 'react-aria-components';
import { SegmentedControl } from '@/components/ui/SegmentedControl';
import { InjectedComponentSet } from '@/components/plugins/InjectedComponentSet';

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
  const calendarPaneVisible = useViewStore((s) => s.calendarPaneVisible);
  const setCalendarPaneVisible = useViewStore((s) => s.setCalendarPaneVisible);

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
    <div className="flex items-center gap-2 border-b border-border bg-surface px-4 py-1.5">
      <Button
        onPress={() => setCurrentDate(new Date())}
        className="h-11 min-w-11 rounded-md border border-border px-3 text-xs font-medium text-foreground transition-colors hover:bg-hover"
      >
        Today
      </Button>
      <div className="flex items-center overflow-hidden rounded-md border border-border">
        <Button
          onPress={() => shift(-1)}
          aria-label="Previous period"
          className="relative flex h-11 w-11 items-center justify-center border-r border-border text-muted-text transition-colors hover:bg-hover hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <ArrowLeftIcon size={14} />
        </Button>
        <Button
          onPress={() => shift(1)}
          aria-label="Next period"
          className="relative flex h-11 w-11 items-center justify-center text-muted-text transition-colors hover:bg-hover hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <ArrowRightIcon size={14} />
        </Button>
      </div>
      <h2 className="ml-1 text-base font-semibold text-foreground">{title}</h2>

      <div className="ml-auto flex items-center gap-2">
        <Button
          onPress={() => setCalendarPaneVisible(!calendarPaneVisible)}
          aria-label={calendarPaneVisible ? 'Hide calendar pane' : 'Show calendar pane'}
          className="flex h-11 w-11 items-center justify-center rounded-md border border-border text-muted-text transition-colors hover:bg-hover hover:text-foreground"
        >
          {calendarPaneVisible ? <PanelLeftCloseIcon size={16} /> : <PanelLeftOpenIcon size={16} />}
        </Button>

        <InjectedComponentSet role="calendar:toolbar:actions" containersRequired={false} />

        <SegmentedControl
          options={VIEWS.map((v) => ({ value: v.key, label: v.label }))}
          value={view}
          onChange={(next) => setView(next)}
        />
        <Button
          onPress={onNewEvent}
          className="flex h-11 min-w-11 items-center gap-1 rounded-md bg-primary px-3 text-xs font-medium text-primary-fg transition-colors hover:opacity-90"
        >
          <PlusIcon size={13} />
          New event
        </Button>
      </div>
    </div>
  );
}
