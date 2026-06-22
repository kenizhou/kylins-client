import { PaneHeader } from './PaneHeader';
import { MailIcon, SendIcon, FileTextIcon } from '../icons';

export function FolderPane() {
  return (
    <div className="flex flex-col h-full bg-[var(--surface)]">
      <PaneHeader title="Folders" role="folder-pane:header" />
      <div className="flex-1 overflow-auto py-2">
        <div className="folder-group pb-2 border-b border-[var(--border)]">
          <div className="px-3 pb-1.5 text-[11px] font-bold uppercase tracking-wide text-[var(--muted-text)]">Favorites</div>
          <ul className="space-y-0.5">
            <li className="flex items-center gap-2 px-3 h-7 rounded bg-[var(--selected-bg)] text-[var(--primary)] cursor-pointer text-sm">
              <MailIcon /> Inbox <span className="ml-auto text-[11px] font-mono px-1.5 py-0.5 rounded-full bg-[var(--primary)] text-[var(--primary-fg)]">9</span>
            </li>
            <li className="flex items-center gap-2 px-3 h-7 rounded hover:bg-[var(--hover)] text-[var(--muted-text)] hover:text-[var(--text)] cursor-pointer text-sm">
              <SendIcon /> Sent Items
            </li>
            <li className="flex items-center gap-2 px-3 h-7 rounded hover:bg-[var(--hover)] text-[var(--muted-text)] hover:text-[var(--text)] cursor-pointer text-sm">
              <FileTextIcon /> Drafts <span className="ml-auto text-[11px] font-mono px-1.5 py-0.5 rounded-full bg-[var(--border)] text-[var(--text)]">2</span>
            </li>
          </ul>
        </div>
      </div>
    </div>
  );
}
