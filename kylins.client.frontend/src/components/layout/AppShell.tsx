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

export interface AppShellProps {
  /** Fired when the user clicks the "+ Add account" affordance in the toolbar. */
  onAddAccount?: () => void;
}

export function AppShell({ onAddAccount }: AppShellProps = {}) {
  const folderPaneVisible = useViewStore((s) => s.folderPaneVisible);
  const commandRibbonVisible = useViewStore((s) => s.commandRibbonVisible);
  const statusBarVisible = useViewStore((s) => s.statusBarVisible);
  const readingPanePosition = useViewStore((s) => s.readingPanePosition);

  const folderPane = useMemo(() => <FolderPane />, []);
  const messageList = useMemo(() => <MessageList />, []);
  const readingPane = useMemo(() => <ReadingPane />, []);

  return (
    <div className="relative flex flex-col h-screen w-screen overflow-hidden bg-[var(--background)] text-[var(--foreground)]">
      <TitleBar />
      {commandRibbonVisible && <CommandRibbon />}
      {onAddAccount && (
        <button
          type="button"
          onClick={onAddAccount}
          className="absolute right-2 top-[52px] z-20 rounded px-3 py-1 text-sm text-[var(--foreground)] hover:bg-[var(--hover)] border border-[var(--border)] bg-[var(--surface)]"
          title="Add another account"
        >
          + Add account
        </button>
      )}
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
    </div>
  );
}
