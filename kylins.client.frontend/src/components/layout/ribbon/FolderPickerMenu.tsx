import { createElement, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useFolderStore } from '../../../stores/folderStore';
import type { MailFolder } from '../../../services/mail/folders/folderModel';
import { roleOrderIndex } from '../../../services/mail/folders/folderModel';
import { getFolderIcon } from '../../../utils/folderIcons';
import { ArrowDownIcon, ArrowRightIcon } from '../../icons';

export interface FolderPickerMenuProps {
  accountId: string;
  excludeLabelId?: string | null;
  onSelect: (folder: MailFolder) => void;
  onClose: () => void;
  className?: string;
  style?: React.CSSProperties;
}

interface TreeNode {
  folder: MailFolder;
  children: TreeNode[];
}

function folderSortKey(a: MailFolder, b: MailFolder): number {
  const roleDiff = roleOrderIndex(a.role) - roleOrderIndex(b.role);
  if (roleDiff !== 0) return roleDiff;
  if (a.sortOrder !== b.sortOrder) return a.sortOrder - b.sortOrder;
  return a.name.localeCompare(b.name);
}

function buildFolderTree(folders: MailFolder[]): TreeNode[] {
  const byId = new Map(folders.map((f) => [f.id, f]));
  const childrenByParent = new Map<string, MailFolder[]>();

  for (const f of folders) {
    if (!f.parentId || !byId.has(f.parentId)) continue;
    const list = childrenByParent.get(f.parentId) ?? [];
    list.push(f);
    childrenByParent.set(f.parentId, list);
  }

  for (const list of childrenByParent.values()) {
    list.sort(folderSortKey);
  }

  const roots = folders.filter((f) => !f.parentId || !byId.has(f.parentId)).sort(folderSortKey);

  const build = (folder: MailFolder): TreeNode => ({
    folder,
    children: (childrenByParent.get(folder.id) ?? []).map(build),
  });

  return roots.map(build);
}

interface FolderNodeProps {
  node: TreeNode;
  depth: number;
  getUnread: (accountId: string, labelId: string) => number;
  onSelect: (folder: MailFolder) => void;
}

function FolderNode({ node, depth, getUnread, onSelect }: FolderNodeProps) {
  const [expanded, setExpanded] = useState(true);
  const hasChildren = node.children.length > 0;
  const icon = createElement(getFolderIcon(node.folder.role), { size: 16 });
  const unread = getUnread(node.folder.accountId, node.folder.id);
  const indent = 12 + depth * 16;

  return (
    <div>
      <div className="flex items-center">
        {hasChildren ? (
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              setExpanded((v) => !v);
            }}
            className="flex h-6 w-6 shrink-0 items-center justify-center text-[var(--muted-text)] hover:bg-[var(--hover)]"
            aria-label={expanded ? 'Collapse folder' : 'Expand folder'}
          >
            {expanded ? <ArrowDownIcon size={12} /> : <ArrowRightIcon size={12} />}
          </button>
        ) : (
          <span className="h-6 w-6 shrink-0" />
        )}
        <button
          type="button"
          role="menuitem"
          onClick={() => onSelect(node.folder)}
          className="flex flex-1 items-center gap-2 py-1.5 pr-3 text-left text-sm text-[var(--foreground)] hover:bg-[var(--hover)]"
          style={{ paddingLeft: indent }}
        >
          <span className="text-[var(--muted-text)]">{icon}</span>
          <span className="flex-1 truncate">{node.folder.name}</span>
          {unread > 0 && (
            <span className="rounded bg-[var(--primary)] px-1.5 py-0.5 text-[10px] font-medium text-[var(--primary-fg)]">
              {unread}
            </span>
          )}
        </button>
      </div>
      {expanded && hasChildren && (
        <div>
          {node.children.map((child) => (
            <FolderNode
              key={child.folder.id}
              node={child}
              depth={depth + 1}
              getUnread={getUnread}
              onSelect={onSelect}
            />
          ))}
        </div>
      )}
    </div>
  );
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

  const tree = useMemo(() => {
    const visible = folders.filter((f) => f.id !== excludeLabelId);
    return buildFolderTree(visible);
  }, [folders, excludeLabelId]);

  return createPortal(
    <div
      ref={ref}
      className={`min-w-[220px] max-h-[360px] overflow-auto rounded-md border border-[var(--border)] bg-[var(--background)] py-1 shadow-lg ${className}`}
      style={style}
      role="menu"
      onClick={(e) => e.stopPropagation()}
      onContextMenu={(e) => e.preventDefault()}
    >
      {tree.length === 0 && (
        <div className="px-3 py-1.5 text-sm text-[var(--muted-text)]">No folders</div>
      )}
      {tree.map((node) => (
        <FolderNode
          key={node.folder.id}
          node={node}
          depth={0}
          getUnread={getUnread}
          onSelect={(folder) => {
            onSelect(folder);
            onClose();
          }}
        />
      ))}
    </div>,
    document.body,
  );
}
