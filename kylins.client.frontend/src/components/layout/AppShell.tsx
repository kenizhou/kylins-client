import { useViewStore } from '../../features/view/viewStore';
import { useUIStore } from '../../stores/uiStore';
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
import { CalendarPage } from '../calendar/CalendarPage';
import { ContactsPage } from '../contacts/ContactsPage';

export function AppShell() {
  const folderPaneVisible = useViewStore((s) => s.folderPaneVisible);
  const commandRibbonVisible = useViewStore((s) => s.commandRibbonVisible);
  const statusBarVisible = useViewStore((s) => s.statusBarVisible);
  const readingPanePosition = useViewStore((s) => s.readingPanePosition);
  const activeApp = useUIStore((s) => s.activeApp);

  return (
    <div className="relative flex flex-col h-screen w-screen overflow-hidden bg-[var(--chrome)] text-[var(--foreground)]">
      <TitleBar />
      <div className="flex flex-1 overflow-hidden">
        <ToolWindowBar />
        <div className="flex flex-1 flex-col min-w-0 overflow-hidden rounded-lg bg-[var(--surface)]">
          {commandRibbonVisible && <CommandRibbon />}
          <div className="flex flex-1 overflow-hidden">
            {activeApp === 'calendar' ? (
              <CalendarPage />
            ) : activeApp === 'contacts' ? (
              <ContactsPage />
            ) : (
              <ReadingPaneLayout
                position={readingPanePosition}
                folderPaneVisible={folderPaneVisible}
                folderPane={<FolderPane />}
                messageList={<MessageList />}
                readingPane={<ReadingPane />}
              />
            )}
          </div>
        </div>
      </div>
      {statusBarVisible && <StatusBar />}
      <Composer />
      <UndoSendToast />
    </div>
  );
}
