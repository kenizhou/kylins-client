import { useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import { useFolderStore } from '../../../stores/folderStore';
import type { MailFolder } from '../../../services/mail/folders/folderModel';
import { roleOrderIndex } from '../../../services/mail/folders/folderModel';
import { getFolderIcon } from '../../../utils/folderIcons';

export interface FolderPickerMenuProps {
  accountId: string;
  excludeLabelId?: string | null;
  onSelect: (folder: MailFolder) => void;
  onClose: () => void;
  className?: string;
  style?: React.CSSProperties;
}

export function FolderPickerMenu({
  accountId,
  excludeLabelId,
  onSelect,
  onClose,
  className = '',
  style,
}: FolderPickerMenuProps) {
  const ref = useRef<HTMLDivElement>(null);
  const folders = useFolderStore((s) => s.byAccount[accountId] ?? []);
  const getUnread = useFolderStore((s) => s.getUnread);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose();
    }
    function onPointer(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        onClose();
      }
    }
    document.addEventListener('keydown', onKey);
    document.addEventListener('mousedown', onPointer);
    return () => {
      document.removeEventListener('keydown', onKey);
      document.removeEventListener('mousedown', onPointer);
    };
  }, [onClose]);

  const choices = folders
    .filter((f) => f.id !== excludeLabelId)
    .slice()
    .sort((a, b) => {
      const roleDiff = roleOrderIndex(a.role) - roleOrderIndex(b.role);
      if (roleDiff !== 0) return roleDiff;
      return a.name.localeCompare(b.name);
    });

  return createPortal(
    <div
      ref={ref}
      className={`min-w-[200px] max-h-[320px] overflow-auto rounded-md border border-[var(--border)] bg-[var(--background)] py-1 shadow-lg ${className}`}
      style={style}
      role="menu"
      onClick={(e) => e.stopPropagation()}
      onContextMenu={(e) => e.preventDefault()}
    >
      {choices.length === 0 && (
        <div className="px-3 py-1.5 text-sm text-[var(--muted-text)]">No folders</div>
      )}
      {choices.map((folder) => {
        const Icon = getFolderIcon(folder.role);
        const unread = getUnread(folder.accountId, folder.id);
        return (
          <button
            key={folder.id}
            type="button"
            role="menuitem"
            onClick={() => {
              onSelect(folder);
              onClose();
            }}
            className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm text-[var(--foreground)] hover:bg-[var(--hover)]"
          >
            <span className="text-[var(--muted-text)]">
              <Icon size={16} />
            </span>
            <span className="flex-1 truncate">{folder.name}</span>
            {unread > 0 && (
              <span className="rounded bg-[var(--primary)] px-1.5 py-0.5 text-[10px] font-medium text-[var(--primary-fg)]">
                {unread}
              </span>
            )}
          </button>
        );
      })}
    </div>,
    document.body,
  );
}
