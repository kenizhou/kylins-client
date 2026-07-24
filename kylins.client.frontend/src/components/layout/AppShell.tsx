import { useViewStore } from '../../features/view/viewStore';
import { useUIStore } from '../../stores/uiStore';
import { useInlineComposerVisible } from '../../stores/inlineComposerStore';
import { TitleBar } from './TitleBar';
import { CommandRibbon } from './CommandRibbon';
import { ToolWindowBar } from './ToolWindowBar';
import { FolderPane } from './FolderPane';
import { MessageList } from './MessageList';
import { ReadingPane } from './ReadingPane';
import { StatusBar } from './StatusBar';
import { ReadingPaneLayout } from '../../features/view/components/ReadingPaneLayout';
import { CalendarPage } from '../calendar/CalendarPage';
import { CalendarPane } from '../calendar/CalendarPane';
import { CalendarLayout } from '../../features/view/components/CalendarLayout';
import { ContactsPage } from '../contacts/ContactsPage';
import { TasksPage } from '../tasks/TasksPage';

function MainContent({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex flex-1 flex-col min-w-0 overflow-hidden bg-[var(--surface)] p-2">
      {children}
    </div>
  );
}

export function AppShell() {
  const folderPaneVisible = useViewStore((s) => s.folderPaneVisible);
  const commandRibbonVisible = useViewStore((s) => s.commandRibbonVisible);
  const statusBarVisible = useViewStore((s) => s.statusBarVisible);
  // When the docked inline composer is visible in the ReadingPane, flip the
  // main CommandRibbon to compose mode so the compose actions (Attach,
  // Importance, Encrypt, …) act on the inline draft via
  // useActiveComposerTarget. The OS compose window renders its own internal
  // ComposeRibbon and does not affect this flag.
  const inlineComposerVisible = useInlineComposerVisible();
  const activeApp = useUIStore((s) => s.activeApp);

  return (
    <div className="relative flex flex-col h-screen w-screen overflow-hidden bg-[var(--chrome-tint)] text-[var(--foreground)]">
      <TitleBar />
      <div className="flex flex-1 overflow-hidden">
        <ToolWindowBar />
        <MainContent>
          {commandRibbonVisible && activeApp !== 'contacts' && (
            <CommandRibbon mode={inlineComposerVisible ? 'compose' : 'read'} />
          )}
          <div className="flex flex-1 overflow-hidden">
            {activeApp === 'calendar' ? (
              <CalendarLayout folderPane={<CalendarPane />}>
                <CalendarPage />
              </CalendarLayout>
            ) : activeApp === 'contacts' ? (
              <ContactsPage />
            ) : activeApp === 'tasks' ? (
              <TasksPage />
            ) : (
              <ReadingPaneLayout
                folderPaneVisible={folderPaneVisible}
                folderPane={<FolderPane />}
                messageList={<MessageList />}
                readingPane={<ReadingPane />}
              />
            )}
          </div>
        </MainContent>
      </div>
      {statusBarVisible && <StatusBar />}
    </div>
  );
}
