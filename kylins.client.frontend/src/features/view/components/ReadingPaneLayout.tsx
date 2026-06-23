import { Panel, Group, Separator } from 'react-resizable-panels';
import type { ReadingPanePosition } from '../types';

interface ReadingPaneLayoutProps {
  position: ReadingPanePosition;
  folderPaneVisible: boolean;
  folderPane: React.ReactNode;
  messageList: React.ReactNode;
  readingPane: React.ReactNode;
}

/**
 * Flat separator — a thin 1px line. react-resizable-panels expands the
 * drag hit region to at least 10px (fine pointer) regardless of visual
 * width, so the line stays crisp while remaining easy to grab.
 */
function VDivider() {
  return (
    <Separator className="w-px bg-[var(--border)] hover:bg-[var(--ring)] transition-colors data-[dragging=true]:bg-[var(--ring)]" />
  );
}

function HDivider() {
  return (
    <Separator className="h-px bg-[var(--border)] hover:bg-[var(--ring)] transition-colors data-[dragging=true]:bg-[var(--ring)]" />
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
      <Group orientation="horizontal" className="flex-1">
        {folderPaneVisible && (
          <Panel key="folder-pane" defaultSize="20%" minSize="12%" maxSize="40%">
            {folderPane}
          </Panel>
        )}
        {folderPaneVisible && <VDivider />}
        <Panel key="message-list" defaultSize="80%" minSize="40%">
          {messageList}
        </Panel>
      </Group>
    );
  }

  // Flat layout: folder + message list + reading pane side by side.
  if (position === 'right') {
    return (
      <Group orientation="horizontal" className="flex-1">
        {folderPaneVisible && (
          <Panel key="folder-pane" defaultSize="20%" minSize="12%" maxSize="40%">
            {folderPane}
          </Panel>
        )}
        {folderPaneVisible && <VDivider />}
        <Panel key="message-list" defaultSize="30%" minSize="18%" maxSize="50%">
          {messageList}
        </Panel>
        <VDivider />
        <Panel key="reading-pane" defaultSize="50%" minSize="30%">
          {readingPane}
        </Panel>
      </Group>
    );
  }

  // Bottom: folder | (message list / reading pane stacked vertically).
  // One level of nesting is unavoidable here, but every Group is flat
  // internally and has no collapsible/imperative panels.
  return (
    <Group orientation="horizontal" className="flex-1">
      {folderPaneVisible && (
        <Panel key="folder-pane" defaultSize="20%" minSize="12%" maxSize="40%">
          {folderPane}
        </Panel>
      )}
      {folderPaneVisible && <VDivider />}
      <Panel key="content" defaultSize="80%" minSize="30%">
        <Group orientation="vertical" className="h-full">
          <Panel key="message-list" defaultSize="60%" minSize="25%">
            {messageList}
          </Panel>
          <HDivider />
          <Panel key="reading-pane" defaultSize="40%" minSize="20%">
            {readingPane}
          </Panel>
        </Group>
      </Panel>
    </Group>
  );
}
