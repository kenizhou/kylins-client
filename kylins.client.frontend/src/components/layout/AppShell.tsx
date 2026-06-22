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
        <ToolWindowBar position="left" />
        <Group orientation="horizontal" className="flex-1">
          <Panel defaultSize={20} minSize={15} maxSize={35}>
            <FolderPane />
          </Panel>
          <Separator className="w-1 hover:bg-[var(--ring)] transition-colors" />
          <Panel defaultSize={30} minSize={20} maxSize={50}>
            <MessageList />
          </Panel>
          <Separator className="w-1 hover:bg-[var(--ring)] transition-colors" />
          <Panel defaultSize={50} minSize={25}>
            <ReadingPane />
          </Panel>
        </Group>
        <ToolWindowBar position="right" />
      </div>
      <StatusBar />
    </div>
  );
}
