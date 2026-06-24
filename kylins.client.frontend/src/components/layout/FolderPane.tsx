import { PaneHeader } from './PaneHeader';
import { MailIcon, SendIcon, FileTextIcon, BellIcon, TrashIcon } from '../icons';

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
      <div className="px-3 pb-1.5 text-[11px] font-bold uppercase tracking-[0.04em] text-[var(--muted-text)]">
        {title}
      </div>
      <div className="space-y-0.5 px-0">{children}</div>
    </div>
  );
}

export function FolderPane() {
  return (
    <div className="flex flex-col h-full bg-[var(--surface)] border border-[var(--series-300)] rounded-xl">
      <PaneHeader title="Folders" role="folder-pane:header" />
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
