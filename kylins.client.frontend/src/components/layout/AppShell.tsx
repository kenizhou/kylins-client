import { Panel, Group, Separator } from 'react-resizable-panels';
import { HeaderBar } from './HeaderBar';
import { CommandRibbon } from './CommandRibbon';
import { ToolWindowBar } from './ToolWindowBar';
import { FolderPane } from './FolderPane';
import { MessageList } from './MessageList';
import { ReadingPane } from './ReadingPane';
import { StatusBar } from './StatusBar';

export function AppShell() {
  return (
    <div className="flex flex-col h-screen w-screen overflow-hidden bg-[var(--background)] text-[var(--foreground)]">
      <HeaderBar />
      <CommandRibbon />
      <div className="flex flex-1 overflow-hidden">
        <ToolWindowBar />
        <Group orientation="horizontal" className="flex-1">
          <Panel defaultSize="18%" minSize="12%" maxSize="25%">
            <FolderPane />
          </Panel>
          <Separator className="w-[5px] hover:bg-[var(--ring)] transition-colors data-[dragging=true]:bg-[var(--ring)]" />
          <Panel defaultSize="27%" minSize="18%" maxSize="40%">
            <MessageList />
          </Panel>
          <Separator className="w-[5px] hover:bg-[var(--ring)] transition-colors data-[dragging=true]:bg-[var(--ring)]" />
          <Panel defaultSize="55%" minSize="30%">
            <ReadingPane />
          </Panel>
        </Group>
      </div>
      <StatusBar />
    </div>
  );
}
