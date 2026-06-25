import { InjectedComponentSet } from '../plugins/InjectedComponentSet';
import { MailIcon, SendIcon, FileTextIcon, BellIcon, TrashIcon, ArrowLeftIcon } from '../icons';
import { useViewStore } from '../../features/view/viewStore';

interface FolderRowProps {
  icon: React.ReactNode;
  name: string;
  count?: number;
  active?: boolean;
}

function FolderRow({ icon, name, count, active }: FolderRowProps) {
  return (
    <div
      className={`
        flex items-center gap-2 h-7 px-3 text-[13px] cursor-pointer
        ${
          active
            ? 'bg-[var(--selected)] text-[var(--primary)]'
            : 'text-[var(--muted-text)] hover:bg-[var(--hover)] hover:text-[var(--text)]'
        }
      `}
    >
      <span className="shrink-0">{icon}</span>
      <span className="flex-1 truncate">{name}</span>
      {count !== undefined && (
        <span
          className={`
            font-mono text-[11px] px-1.5 py-0.5 rounded-full
            ${active ? 'bg-[var(--primary)] text-[var(--primary-fg)]' : 'bg-[var(--border)] text-[var(--text)]'}
          `}
        >
          {count}
        </span>
      )}
    </div>
  );
}

function FolderGroup({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="py-2 last:pb-0">
      <div className="px-3 pb-1.5 font-[var(--text-overline)] uppercase tracking-[0.04em] text-[var(--muted-text)]">
        {title}
      </div>
      <div className="space-y-0.5 px-0">{children}</div>
    </div>
  );
}

export function FolderPane() {
  const setFolderPaneVisible = useViewStore((s) => s.setFolderPaneVisible);
  return (
    <div className="flex flex-col h-full bg-[var(--surface)] rounded-xl">
      <div className="flex h-[var(--pane-header-h)] shrink-0 items-center justify-between px-3">
        <span className="text-sm font-semibold text-[var(--foreground)]">Folders</span>
        <div className="flex items-center gap-1">
          <InjectedComponentSet role="folder-pane:header" containersRequired={false} />
          <button
            type="button"
            onClick={() => setFolderPaneVisible(false)}
            aria-label="Collapse folder pane"
            title="Collapse folder pane"
            className="flex h-6 w-6 items-center justify-center rounded text-[var(--muted-text)] transition-colors hover:bg-[var(--hover)] hover:text-[var(--foreground)]"
          >
            <ArrowLeftIcon size={14} />
          </button>
        </div>
      </div>
      <div className="flex-1 overflow-auto">
        <FolderGroup title="Favorites">
          <FolderRow icon={<MailIcon />} name="Inbox" count={9} active />
          <FolderRow icon={<SendIcon />} name="Sent" />
          <FolderRow icon={<FileTextIcon />} name="Drafts" count={2} />
        </FolderGroup>
        <FolderGroup title="kevin@example.com">
          <FolderRow icon={<MailIcon />} name="Inbox" count={142} />
          <FolderRow icon={<BellIcon />} name="Spam" />
          <FolderRow icon={<TrashIcon />} name="Trash" />
        </FolderGroup>
      </div>
    </div>
  );
}
