import { Panel, Group } from 'react-resizable-panels';
import { useViewStore } from '../viewStore';
import { useWindowSize } from '@/hooks/useWindowSize';
import { FolderPaneDrawer } from '@/components/layout/FolderPaneDrawer';
import { VDivider } from './VDivider';

interface CalendarLayoutProps {
  folderPane: React.ReactNode;
  children: React.ReactNode;
}

export function CalendarLayout({ folderPane, children }: CalendarLayoutProps) {
  const visible = useViewStore((s) => s.calendarPaneVisible);
  const size = useViewStore((s) => s.calendarPaneSize);
  const setVisible = useViewStore((s) => s.setCalendarPaneVisible);
  const setSize = useViewStore((s) => s.setCalendarPaneSize);
  const { breakpoint } = useWindowSize();

  const isCompact = breakpoint === 'compact';
  const showPane = !isCompact && visible;
  const drawerOpen = isCompact && visible;

  function handleLayoutChanged(layout: Record<string, number>) {
    const next = layout['calendar-folder-pane'];
    if (typeof next === 'number' && next >= 10 && next <= 80) {
      setSize(next);
    }
  }

  return (
    <>
      <Group orientation="horizontal" className="flex-1 p-2" onLayoutChanged={handleLayoutChanged}>
        {showPane && (
          <Panel
            id="calendar-folder-pane"
            defaultSize={size}
            minSize={12}
            className="flex flex-col overflow-hidden rounded-xl border border-[var(--border)] bg-[var(--card)]"
          >
            {folderPane}
          </Panel>
        )}
        {showPane && <VDivider />}
        <Panel
          id="calendar-content"
          defaultSize={showPane ? 100 - size : 100}
          minSize={30}
          className="flex flex-col overflow-hidden"
        >
          {children}
        </Panel>
      </Group>

      {drawerOpen && (
        <FolderPaneDrawer open={drawerOpen} onClose={() => setVisible(false)}>
          {folderPane}
        </FolderPaneDrawer>
      )}
    </>
  );
}
