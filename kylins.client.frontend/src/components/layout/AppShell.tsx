import { useMemo } from 'react';
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

export interface AppShellProps {
  /** Fired when the user clicks the "+ Add account" affordance in the toolbar. */
  onAddAccount?: () => void;
}

export function AppShell({ onAddAccount }: AppShellProps = {}) {
  const folderPaneVisible = useViewStore((s) => s.folderPaneVisible);
  const commandRibbonVisible = useViewStore((s) => s.commandRibbonVisible);
  const statusBarVisible = useViewStore((s) => s.statusBarVisible);
  const readingPanePosition = useViewStore((s) => s.readingPanePosition);
  const activeApp = useUIStore((s) => s.activeApp);

  const folderPane = useMemo(() => <FolderPane />, []);
  const messageList = useMemo(() => <MessageList />, []);
  const readingPane = useMemo(() => <ReadingPane />, []);

  return (
    <div className="relative flex flex-col h-screen w-screen overflow-hidden bg-[color-mix(in_oklab,var(--surface),black_12%)] text-[var(--foreground)]">
      {onAddAccount && (
        <button
          type="button"
          onClick={onAddAccount}
          className="absolute right-2 top-[112px] z-20 rounded px-3 py-1 text-sm text-[var(--foreground)] hover:bg-[var(--hover)] border border-[var(--border)] bg-[var(--card)]"
          title="Add another account"
        >
          + Add account
        </button>
      )}
      <TitleBar />
      <div className="flex flex-1 overflow-hidden">
        <ToolWindowBar />
        <div className="flex flex-1 flex-col min-w-0 overflow-hidden rounded-l-lg bg-[var(--surface)]">
          {commandRibbonVisible && <CommandRibbon />}
          <div className="flex flex-1 overflow-hidden">
            {activeApp === 'calendar' ? (
              <CalendarPage />
            ) : (
              <ReadingPaneLayout
                position={readingPanePosition}
                folderPaneVisible={folderPaneVisible}
                folderPane={folderPane}
                messageList={messageList}
                readingPane={readingPane}
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
