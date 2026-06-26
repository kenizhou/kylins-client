import { useEffect, useRef } from 'react';
import { Panel, Group, Separator } from 'react-resizable-panels';
import type { ReadingPanePosition } from '../types';

interface ReadingPaneLayoutProps {
  position: ReadingPanePosition;
  folderPaneVisible: boolean;
  folderPane: React.ReactNode;
  messageList: React.ReactNode;
  readingPane: React.ReactNode;
}

function PanelCard({ children }: { children: React.ReactNode }) {
  return (
    <div
      className="relative h-full overflow-hidden rounded-xl border border-[var(--border)] bg-[var(--card)] shadow-md"
      style={{
        maskImage:
          'radial-gradient(circle at 0 100%, transparent 12px, black 12px), radial-gradient(circle at 100% 100%, transparent 12px, black 12px)',
        WebkitMaskImage:
          'radial-gradient(circle at 0 100%, transparent 12px, black 12px), radial-gradient(circle at 100% 100%, transparent 12px, black 12px)',
        maskComposite: 'add',
        WebkitMaskComposite: 'source-over',
      }}
    >
      {children}
    </div>
  );
}

/**
 * Vertical drag handle — a wider rounded bar. react-resizable-panels expands the
 * drag hit region to at least 10px (fine pointer) regardless of visual width,
 * so the bar can stay slim-looking while remaining easy to grab.
 */
function VDivider({ hidden = false }: { hidden?: boolean }) {
  if (hidden) {
    // Thin and colored to match the folder pane's surface so it disappears
    // against it. Still draggable — react-resizable-panels expands the hit
    // region to ≥10px regardless of visual width.
    return <Separator className="w-px bg-[var(--surface)]" />;
  }
  return (
    <Separator className="mx-1 w-1.5 rounded-full bg-[var(--border)] transition-colors hover:bg-[var(--series-300)]" />
  );
}

function HDivider() {
  return (
    <Separator className="my-1 h-1.5 rounded-full bg-[var(--border)] transition-colors hover:bg-[var(--series-300)]" />
  );
}

/**
 * Wraps a panel and exposes its screen position/size as CSS variables so the
 * title-bar search box can track the panel.
 */
function MeasuredPanelCard({ children }: { children: React.ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function update() {
      const el = ref.current;
      if (!el) return;
      const rect = el.getBoundingClientRect();
      document.documentElement.style.setProperty('--message-list-left', `${rect.left}px`);
      document.documentElement.style.setProperty('--message-list-width', `${rect.width}px`);
    }

    update();
    const observer = new ResizeObserver(update);
    if (ref.current) observer.observe(ref.current);
    window.addEventListener('resize', update);

    return () => {
      observer.disconnect();
      window.removeEventListener('resize', update);
    };
  }, []);

  return (
    <div ref={ref} className="h-full">
      <PanelCard>{children}</PanelCard>
    </div>
  );
}

export function ReadingPaneLayout({
  position,
  folderPaneVisible,
  folderPane,
  messageList,
  readingPane,
}: ReadingPaneLayoutProps) {
  // Flat layout: folder pane + message list only.
  if (position === 'off') {
    return (
      <Group orientation="horizontal" className="flex-1 p-2">
        {folderPaneVisible && (
          <Panel key="folder-pane" defaultSize="20%" minSize="12%" maxSize="40%">
            {folderPane}
          </Panel>
        )}
        {folderPaneVisible && <VDivider hidden />}
        <Panel key="message-list" defaultSize="80%" minSize="40%">
          <MeasuredPanelCard>{messageList}</MeasuredPanelCard>
        </Panel>
      </Group>
    );
  }

  // Flat layout: folder + message list + reading pane side by side.
  if (position === 'right') {
    return (
      <Group orientation="horizontal" className="flex-1 p-2">
        {folderPaneVisible && (
          <Panel key="folder-pane" defaultSize="20%" minSize="12%" maxSize="40%">
            {folderPane}
          </Panel>
        )}
        {folderPaneVisible && <VDivider hidden />}
        <Panel key="message-list" defaultSize="30%" minSize="18%" maxSize="50%">
          <MeasuredPanelCard>{messageList}</MeasuredPanelCard>
        </Panel>
        <VDivider />
        <Panel key="reading-pane" defaultSize="50%" minSize="30%">
          <PanelCard>{readingPane}</PanelCard>
        </Panel>
      </Group>
    );
  }

  // Bottom: folder | (message list / reading pane stacked vertically).
  // One level of nesting is unavoidable here, but every Group is flat
  // internally and has no collapsible/imperative panels.
  return (
    <Group orientation="horizontal" className="flex-1 p-2">
      {folderPaneVisible && (
        <Panel key="folder-pane" defaultSize="20%" minSize="12%" maxSize="40%">
          {folderPane}
        </Panel>
      )}
      {folderPaneVisible && <VDivider />}
      <Panel key="content" defaultSize="80%" minSize="30%">
        <Group orientation="vertical" className="h-full">
          <Panel key="message-list" defaultSize="60%" minSize="25%">
            <MeasuredPanelCard>{messageList}</MeasuredPanelCard>
          </Panel>
          <HDivider />
          <Panel key="reading-pane" defaultSize="40%" minSize="20%">
            <PanelCard>{readingPane}</PanelCard>
          </Panel>
        </Group>
      </Panel>
    </Group>
  );
}
