import { createElement, useEffect, useMemo, useRef } from 'react';
import { createPortal } from 'react-dom';
import { useFolderStore } from '../../../stores/folderStore';
import type { MailFolder } from '../../../services/mail/folders/folderModel';
import { roleOrderIndex } from '../../../services/mail/folders/folderModel';
import { getFolderIcon } from '../../../utils/folderIcons';
import { ArrowDownIcon, ArrowRightIcon } from '../../icons';
import { Button, Collection, Tree, TreeItem, TreeItemContent } from 'react-aria-components';

export interface FolderPickerMenuProps {
  accountId: string;
  excludeLabelId?: string | null;
  onSelect: (folder: MailFolder) => void;
  onClose: () => void;
  className?: string;
  style?: React.CSSProperties;
  portal?: boolean;
}

interface TreeItemData {
  id: string;
  folder: MailFolder;
  children: TreeItemData[];
}

function folderSortKey(a: MailFolder, b: MailFolder): number {
  const roleDiff = roleOrderIndex(a.role) - roleOrderIndex(b.role);
  if (roleDiff !== 0) return roleDiff;
  if (a.sortOrder !== b.sortOrder) return a.sortOrder - b.sortOrder;
  return a.name.localeCompare(b.name);
}

function buildFolderTree(folders: MailFolder[]): TreeItemData[] {
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

  const build = (folder: MailFolder): TreeItemData => ({
    id: folder.id,
    folder,
    children: (childrenByParent.get(folder.id) ?? []).map(build),
  });

  return roots.map(build);
}

function findFolder(nodes: TreeItemData[], id: string): MailFolder | undefined {
  for (const node of nodes) {
    if (node.id === id) return node.folder;
    const child = findFolder(node.children, id);
    if (child) return child;
  }
  return undefined;
}

function allTreeIds(nodes: TreeItemData[]): string[] {
  return nodes.flatMap((node) => [node.id, ...allTreeIds(node.children)]);
}

export function FolderPickerMenu({
  accountId,
  excludeLabelId,
  onSelect,
  onClose,
  className = '',
  style,
  portal = true,
}: FolderPickerMenuProps) {
  const ref = useRef<HTMLDivElement>(null);
  const folders = useFolderStore((s) => s.byAccount[accountId] ?? []);
  const getUnread = useFolderStore((s) => s.getUnread);

  useEffect(() => {
    if (!portal) return;
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
  }, [onClose, portal]);

  const tree = useMemo(() => {
    const visible = folders.filter((f) => f.id !== excludeLabelId);
    return buildFolderTree(visible);
  }, [folders, excludeLabelId]);

  const defaultExpanded = useMemo(() => new Set(allTreeIds(tree)), [tree]);

  const renderItem = (node: TreeItemData) => {
    const icon = createElement(getFolderIcon(node.folder.role), { size: 16 });
    return (
      <TreeItem
        key={node.id}
        id={node.id}
        textValue={node.folder.name}
        className={({ isHovered }) =>
          `group flex items-center outline-none ${isHovered ? 'bg-hover' : ''}`
        }
      >
        <TreeItemContent>
          {({ isExpanded, hasChildItems, level }) => {
            const unread = getUnread(node.folder.accountId, node.folder.id);
            return (
              <div
                className="flex flex-1 items-center gap-2 py-1.5 pr-3 text-left text-sm text-foreground"
                style={{ paddingLeft: `${(level - 1) * 16 + 12}px` }}
              >
                {hasChildItems ? (
                  <Button
                    slot="chevron"
                    className="flex h-6 w-6 shrink-0 items-center justify-center rounded text-muted-text transition-colors hover:bg-hover"
                    aria-label={isExpanded ? 'Collapse folder' : 'Expand folder'}
                  >
                    {isExpanded ? <ArrowDownIcon size={12} /> : <ArrowRightIcon size={12} />}
                  </Button>
                ) : (
                  <span className="h-6 w-6 shrink-0" />
                )}
                <span className="text-muted-text">{icon}</span>
                <span className="flex-1 truncate">{node.folder.name}</span>
                {unread > 0 && (
                  <span className="rounded bg-primary px-1.5 py-0.5 text-[10px] font-medium text-primary-fg">
                    {unread}
                  </span>
                )}
              </div>
            );
          }}
        </TreeItemContent>
        <Collection items={node.children}>{renderItem}</Collection>
      </TreeItem>
    );
  };

  const content = (
    <div
      ref={ref}
      className={`min-w-[220px] max-h-[360px] overflow-auto rounded-md border border-border bg-background py-1 shadow-lg ${className}`}
      style={style}
      onClick={(e) => e.stopPropagation()}
      onContextMenu={(e) => e.preventDefault()}
    >
      {tree.length === 0 && <div className="px-3 py-1.5 text-sm text-muted-text">No folders</div>}
      {tree.length > 0 && (
        <Tree
          aria-label="Select folder"
          selectionMode="none"
          items={tree}
          defaultExpandedKeys={defaultExpanded}
          onAction={(key) => {
            const folder = findFolder(tree, String(key));
            if (folder) {
              onSelect(folder);
              onClose();
            }
          }}
          className="outline-none"
        >
          {renderItem}
        </Tree>
      )}
    </div>
  );

  return portal ? createPortal(content, document.body) : content;
}
