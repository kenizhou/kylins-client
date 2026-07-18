import { useMemo } from 'react';
import { useViewStore } from '../viewStore';
import { useWindowSize } from '@/hooks/useWindowSize';
import { FolderPaneDrawer } from '@/components/layout/FolderPaneDrawer';
import { ResizablePaneGroup } from '@/components/layout/ResizablePaneGroup';

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

  const panels = useMemo(
    () => [
      {
        id: 'calendar-folder-pane',
        content: folderPane,
        defaultSize: size,
        minSize: 12,
        maxSize: 80,
        visible: showPane,
        card: true,
      },
      {
        id: 'calendar-content',
        content: children,
        defaultSize: showPane ? 100 - size : 100,
        minSize: 30,
        card: false,
      },
    ],
    [folderPane, children, size, showPane],
  );

  return (
    <>
      <ResizablePaneGroup
        orientation="horizontal"
        className="flex-1 p-2"
        panels={panels}
        onLayoutChanged={(layout) => {
          const next = layout['calendar-folder-pane'];
          if (typeof next === 'number' && next >= 10 && next <= 80) setSize(next);
        }}
      />

      {drawerOpen && (
        <FolderPaneDrawer open={drawerOpen} onClose={() => setVisible(false)}>
          {folderPane}
        </FolderPaneDrawer>
      )}
    </>
  );
}
