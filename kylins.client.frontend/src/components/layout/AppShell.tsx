import { useMemo } from 'react';
import { useViewStore } from '../../features/view/viewStore';
import { TitleBar } from './TitleBar';
import { CommandRibbon } from './CommandRibbon';
import { ToolWindowBar } from './ToolWindowBar';
import { FolderPane } from './FolderPane';
import { MessageList } from './MessageList';
import { ReadingPane } from './ReadingPane';
import { StatusBar } from './StatusBar';
import { ReadingPaneLayout } from '../../features/view/components/ReadingPaneLayout';
import { Composer } from '../composer/Composer';
import { UndoSendToast } from '../composer/UndoSendToast';

export function AppShell() {
  const folderPaneVisible = useViewStore((s) => s.folderPaneVisible);
  const commandRibbonVisible = useViewStore((s) => s.commandRibbonVisible);
  const statusBarVisible = useViewStore((s) => s.statusBarVisible);
  const readingPanePosition = useViewStore((s) => s.readingPanePosition);

  const folderPane = useMemo(() => <FolderPane />, []);
  const messageList = useMemo(() => <MessageList />, []);
  const readingPane = useMemo(() => <ReadingPane />, []);

  return (
    <div className="flex flex-col h-screen w-screen overflow-hidden bg-[var(--background)] text-[var(--foreground)]">
      <TitleBar />
      {commandRibbonVisible && <CommandRibbon />}
      <div className="flex flex-1 overflow-hidden">
        <ToolWindowBar />
        <ReadingPaneLayout
          position={readingPanePosition}
          folderPaneVisible={folderPaneVisible}
          folderPane={folderPane}
          messageList={messageList}
          readingPane={readingPane}
        />
      </div>
      {statusBarVisible && <StatusBar />}
      <Composer />
      <UndoSendToast />
    </div>
  );
}
