import { Fragment, useEffect, useMemo, useRef, useState } from 'react';
import { PinIcon, PlusIcon, PencilIcon, TrashIcon, FolderIcon } from '../icons';
import { useAccountStore } from '../../stores/accountStore';
import { useFolderStore } from '../../stores/folderStore';
import type { MailFolder } from '../../services/mail/folders';
import { getFolderIcon } from '../../utils/folderIcons';
import { buildFolderTree, type FolderTreeNode } from '../../utils/folderTree';
import { ContextMenu, type ContextMenuItem } from '../ui/ContextMenu';

// ---- Inline create/rename input (Mailspring-style: in-place, not a modal) ----

interface InlineInputProps {
  depth: number;
  initialValue: string;
  placeholder: string;
  onSubmit: (value: string) => void;
  onCancel: () => void;
}

function InlineFolderInput({
  depth,
  initialValue,
  placeholder,
  onSubmit,
  onCancel,
}: InlineInputProps) {
  const [value, setValue] = useState(initialValue);
  const ref = useRef<HTMLInputElement>(null);
  // Focus + select on mount so rename can be retyped quickly.
  useEffect(() => {
    const t = setTimeout(() => {
      ref.current?.focus();
      ref.current?.select();
    }, 0);
    return () => clearTimeout(t);
  }, []);

  return (
    <div
      className="flex items-center gap-2.5 h-7 pr-2 text-[var(--foreground)]"
      style={{ paddingLeft: `${8 + depth * 14}px` }}
    >
      <FolderIcon size={18} className="shrink-0" />
      <input
        ref={ref}
        value={value}
        placeholder={placeholder}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            onSubmit(value.trim());
          } else if (e.key === 'Escape') {
            e.preventDefault();
            onCancel();
          }
        }}
        onBlur={() => onCancel()}
        className="flex-1 h-5 rounded border border-[var(--primary)] bg-[var(--background)] px-1.5 text-[13px] text-[var(--foreground)] outline-none"
      />
    </div>
  );
}

// ---- Chevron toggle for expand/collapse ----

function ChevronToggle({
  expanded,
  onClick,
}: {
  expanded: boolean;
  onClick: (e: React.MouseEvent) => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="shrink-0 flex items-center justify-center w-3 h-3 text-[var(--muted-text)] hover:text-[var(--foreground)]"
      aria-label={expanded ? 'Collapse folder' : 'Expand folder'}
    >
      <svg
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth={2.5}
        strokeLinecap="round"
        strokeLinejoin="round"
        className={`size-3 transition-transform ${expanded ? 'rotate-90' : ''}`}
      >
        <path d="M9 6l6 6-6 6" />
      </svg>
    </button>
  );
}

// ---- Folder row ----

interface FolderRowProps {
  icon: React.ReactNode;
  name: string;
  depth?: number;
  active?: boolean;
  unread?: number;
  onClick?: () => void;
  onContextMenu?: (e: React.MouseEvent) => void;
}

function FolderRow({
  icon,
  name,
  depth = 0,
  active = false,
  unread = 0,
  onClick,
  onContextMenu,
}: FolderRowProps) {
  return (
    <div
      role="button"
      tabIndex={0}
      onClick={onClick}
      onContextMenu={(e) => {
        e.preventDefault();
        onContextMenu?.(e);
      }}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onClick?.();
        }
      }}
      style={{ paddingLeft: `${8 + depth * 14}px` }}
      className={`
        group relative flex flex-1 min-w-0 items-center gap-2.5 pr-2 h-7 cursor-pointer
        ${active ? 'bg-[var(--selected)] text-[var(--selected-text)]' : 'text-[var(--text)] hover:bg-[var(--hover)]'}
      `}
    >
      {active && <span className="absolute left-0 top-0 bottom-0 w-[2px] bg-[var(--primary)]" />}
      <span className="shrink-0">{icon}</span>
      <span className="flex-1 truncate text-[13px]">{name}</span>
      {unread > 0 && (
        <span
          className={`font-mono text-[11px] px-1.5 py-0.5 rounded-full ${
            active
              ? 'bg-[var(--primary)] text-[var(--primary-foreground)]'
              : 'bg-[var(--border)] text-[var(--text)]'
          }`}
        >
          {unread}
        </span>
      )}
    </div>
  );
}

function FolderGroup({
  title,
  children,
  collapsible,
}: {
  title: string;
  children: React.ReactNode;
  collapsible?: { expanded: boolean; onToggle: () => void };
}) {
  return (
    <div className="first:pt-3 pt-2 pb-2 last:pb-0">
      <button
        type="button"
        onClick={collapsible ? collapsible.onToggle : undefined}
        className={`flex w-full items-center gap-1 px-3 pb-1.5 text-left text-xs font-semibold text-[var(--foreground)] uppercase tracking-wide ${
          collapsible ? 'cursor-pointer hover:text-[var(--primary)]' : 'cursor-default'
        }`}
        aria-expanded={collapsible ? collapsible.expanded : undefined}
      >
        {collapsible && (
          <svg
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth={2.5}
            strokeLinecap="round"
            strokeLinejoin="round"
            className={`size-3 shrink-0 transition-transform ${collapsible.expanded ? 'rotate-90' : ''}`}
          >
            <path d="M9 6l6 6-6 6" />
          </svg>
        )}
        <span className="truncate">{title}</span>
      </button>
      {(!collapsible || collapsible.expanded) && <div className="space-y-0.5 px-0">{children}</div>}
    </div>
  );
}

// ---- Inline edit descriptor (create or rename, in-place) ----

type InlineEdit =
  | { kind: 'rename'; folder: MailFolder; name: string }
  | { kind: 'create'; accountId: string; parentId: string | null; name: string };

interface FolderNodesProps {
  nodes: FolderTreeNode[];
  depth: number;
  inline: InlineEdit | null;
  collapsed: Set<string>;
  toggleCollapsed: (folderId: string) => void;
  isSelected: (folder: MailFolder) => boolean;
  unreadFor: (folder: MailFolder) => number;
  onSelect: (folder: MailFolder) => void;
  onContextMenu: (folder: MailFolder, e: React.MouseEvent) => void;
  onCommitInline: (value: string) => void;
  onCancelInline: () => void;
}

function FolderNodes({
  nodes,
  depth,
  inline,
  collapsed,
  toggleCollapsed,
  isSelected,
  unreadFor,
  onSelect,
  onContextMenu,
  onCommitInline,
  onCancelInline,
}: FolderNodesProps) {
  return (
    <>
      {nodes.map((node) => {
        const Icon = getFolderIcon(node.folder.role);
        const renaming =
          inline &&
          inline.kind === 'rename' &&
          inline.folder.accountId === node.folder.accountId &&
          inline.folder.id === node.folder.id
            ? inline
            : null;
        const creatingChild =
          inline !== null && inline.kind === 'create' && inline.parentId === node.folder.remoteId;
        const hasChildren = node.children.length > 0;
        const expanded = !collapsed.has(node.folder.id);
        return (
          <Fragment key={`${node.folder.accountId}:${node.folder.id}`}>
            {renaming ? (
              <InlineFolderInput
                depth={depth}
                initialValue={renaming.name}
                placeholder="Folder name"
                onSubmit={onCommitInline}
                onCancel={onCancelInline}
              />
            ) : (
              <div
                className={`relative flex items-center ${
                  isSelected(node.folder) ? 'bg-[var(--selected)] text-[var(--selected-text)]' : ''
                }`}
                style={{ paddingLeft: `${8 + depth * 14}px` }}
              >
                {isSelected(node.folder) && (
                  <span className="absolute left-0 top-0 bottom-0 w-[2px] bg-[var(--primary)]" />
                )}
                {hasChildren ? (
                  <ChevronToggle
                    expanded={expanded}
                    onClick={(e) => {
                      e.stopPropagation();
                      toggleCollapsed(node.folder.id);
                    }}
                  />
                ) : (
                  <span className="w-3 shrink-0" />
                )}
                <FolderRow
                  icon={<Icon size={15} />}
                  name={node.folder.name}
                  depth={0}
                  active={false}
                  unread={unreadFor(node.folder)}
                  onClick={() => onSelect(node.folder)}
                  onContextMenu={(e) => onContextMenu(node.folder, e)}
                />
              </div>
            )}
            {hasChildren && expanded && (
              <FolderNodes
                nodes={node.children}
                depth={depth + 1}
                inline={inline}
                collapsed={collapsed}
                toggleCollapsed={toggleCollapsed}
                isSelected={isSelected}
                unreadFor={unreadFor}
                onSelect={onSelect}
                onContextMenu={onContextMenu}
                onCommitInline={onCommitInline}
                onCancelInline={onCancelInline}
              />
            )}
            {creatingChild && (
              <InlineFolderInput
                depth={depth + 1}
                initialValue=""
                placeholder="Folder name"
                onSubmit={onCommitInline}
                onCancel={onCancelInline}
              />
            )}
          </Fragment>
        );
      })}
    </>
  );
}

// ---- Pane ----

export function FolderPane() {
  const accounts = useAccountStore((s) => s.accounts);
  const byAccount = useFolderStore((s) => s.byAccount);
  const selected = useFolderStore((s) => s.selected);
  const favorites = useFolderStore((s) => s.favorites);
  const selectLabel = useFolderStore((s) => s.selectLabel);
  const toggleFavorite = useFolderStore((s) => s.toggleFavorite);
  const getUnread = useFolderStore((s) => s.getUnread);
  const createFolder = useFolderStore((s) => s.createFolder);
  const renameFolderAction = useFolderStore((s) => s.renameFolder);
  const deleteFolderAction = useFolderStore((s) => s.deleteFolder);
  const syncFolder = useFolderStore((s) => s.syncFolder);

  const [menu, setMenu] = useState<{ folder: MailFolder; x: number; y: number } | null>(null);
  const [inline, setInline] = useState<InlineEdit | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<MailFolder | null>(null);
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [collapsedInitialized, setCollapsedInitialized] = useState(false);
  const [accountsCollapsed, setAccountsCollapsed] = useState<Set<string>>(new Set());

  const toggleCollapsed = (folderId: string) => {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(folderId)) next.delete(folderId);
      else next.add(folderId);
      return next;
    });
  };

  const toggleAccountCollapsed = (accountId: string) => {
    setAccountsCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(accountId)) next.delete(accountId);
      else next.add(accountId);
      return next;
    });
  };

  const expandFolder = (folderId: string) => {
    setCollapsed((prev) => {
      if (!prev.has(folderId)) return prev;
      const next = new Set(prev);
      next.delete(folderId);
      return next;
    });
  };

  const expandAccount = (accountId: string) => {
    setAccountsCollapsed((prev) => {
      if (!prev.has(accountId)) return prev;
      const next = new Set(prev);
      next.delete(accountId);
      return next;
    });
  };

  const isSelected = (folder: MailFolder) =>
    selected?.accountId === folder.accountId && selected.labelId === folder.id;
  const unreadFor = (folder: MailFolder) => getUnread(folder.accountId, folder.id);
  const isFavorite = (folder: MailFolder) => favorites.has(`${folder.accountId}__${folder.id}`);
  const onSelect = (folder: MailFolder) => selectLabel(folder.accountId, folder.id);
  const onToggleFavorite = (folder: MailFolder) => void toggleFavorite(folder.accountId, folder.id);
  const openMenu = (folder: MailFolder, e: React.MouseEvent) =>
    setMenu({ folder, x: e.clientX, y: e.clientY });

  const commitInline = (value: string) => {
    const cur = inline;
    setInline(null);
    if (!cur || !value) return;
    if (cur.kind === 'rename') {
      void renameFolderAction(cur.folder.accountId, cur.folder.id, value);
    } else {
      void createFolder(cur.accountId, value, cur.parentId);
    }
  };
  const cancelInline = () => setInline(null);

  const favoriteFolders: MailFolder[] = [];
  for (const folders of Object.values(byAccount)) {
    for (const f of folders) {
      if (favorites.has(`${f.accountId}__${f.id}`)) favoriteFolders.push(f);
    }
  }

  const folderTrees = useMemo(() => {
    const trees: Record<string, FolderTreeNode[]> = {};
    for (const [accountId, folders] of Object.entries(byAccount)) {
      trees[accountId] = buildFolderTree(folders);
    }
    return trees;
  }, [byAccount]);

  const totalFolders = Object.values(byAccount).reduce((sum, fs) => sum + fs.length, 0);

  // Fold folder levels by default on first load, but only once.
  if (!collapsedInitialized && totalFolders > 0) {
    const remoteToId = new Map<string, string>();
    for (const folders of Object.values(byAccount)) {
      for (const f of folders) {
        remoteToId.set(f.remoteId, f.id);
      }
    }
    const next = new Set<string>();
    for (const folders of Object.values(byAccount)) {
      for (const f of folders) {
        if (f.parentId) {
          const parentId = remoteToId.get(f.parentId);
          if (parentId) next.add(parentId);
        }
      }
    }
    setCollapsed(next);
    setCollapsedInitialized(true);
  }

  const menuItems: ContextMenuItem[] = menu
    ? [
        {
          label: 'Sync this folder',
          onSelect: () => void syncFolder(menu.folder),
          disabled: menu.folder.source === 'local',
        },
        { separator: true },
        {
          label: isFavorite(menu.folder) ? 'Remove from Favorites' : 'Add to Favorites',
          icon: PinIcon,
          onSelect: () => void onToggleFavorite(menu.folder),
        },
        {
          label: 'New Subfolder',
          icon: PlusIcon,
          onSelect: () => {
            const parent = menu.folder;
            setInline({
              kind: 'create',
              accountId: parent.accountId,
              parentId: parent.remoteId ?? parent.id,
              name: '',
            });
            expandFolder(parent.id);
            expandAccount(parent.accountId);
          },
        },
        {
          label: 'Rename Folder',
          icon: PencilIcon,
          disabled: menu.folder.role !== null,
          onSelect: () =>
            setInline({ kind: 'rename', folder: menu.folder, name: menu.folder.name }),
        },
        {
          label: 'Delete Folder',
          icon: TrashIcon,
          danger: true,
          disabled: menu.folder.role !== null,
          onSelect: () => setDeleteTarget(menu.folder),
        },
      ]
    : [];

  return (
    <div className="flex flex-col h-full bg-[var(--surface)] rounded-xl">
      <div className="flex-1 overflow-auto">
        {totalFolders === 0 ? (
          <div className="px-3 py-6 text-center text-xs text-[var(--muted-text)]">
            No folders yet. Add an account to get started.
          </div>
        ) : (
          <>
            {favoriteFolders.length > 0 && (
              <FolderGroup title="Favorites">
                {favoriteFolders.map((folder) => {
                  const Icon = getFolderIcon(folder.role);
                  return (
                    <FolderRow
                      key={`fav:${folder.accountId}:${folder.id}`}
                      icon={<Icon size={15} />}
                      name={folder.name}
                      active={isSelected(folder)}
                      unread={unreadFor(folder)}
                      onClick={() => onSelect(folder)}
                      onContextMenu={(e) => openMenu(folder, e)}
                    />
                  );
                })}
              </FolderGroup>
            )}

            {favoriteFolders.length > 0 && <div className="h-px bg-[var(--border)] mx-3" />}

            {accounts.map((account) => {
              const folders = byAccount[account.id] ?? [];
              if (
                folders.length === 0 &&
                !(inline?.kind === 'create' && inline.accountId === account.id)
              ) {
                return null;
              }
              // Tree pre-built in useMemo above — includes ALL folders so
              // user sub-folders of system folders can find their parent.
              const allTree = folderTrees[account.id] ?? [];
              const title = account.accountLabel ?? account.email;
              const topCreate =
                inline !== null &&
                inline.kind === 'create' &&
                inline.parentId === null &&
                inline.accountId === account.id;
              const accountExpanded = !accountsCollapsed.has(account.id);
              return (
                <FolderGroup
                  key={account.id}
                  title={title}
                  collapsible={{
                    expanded: accountExpanded,
                    onToggle: () => toggleAccountCollapsed(account.id),
                  }}
                >
                  {accountExpanded && topCreate && (
                    <InlineFolderInput
                      depth={0}
                      initialValue=""
                      placeholder="Folder name"
                      onSubmit={commitInline}
                      onCancel={cancelInline}
                    />
                  )}
                  {accountExpanded && (
                    <FolderNodes
                      nodes={allTree}
                      depth={0}
                      inline={inline}
                      collapsed={collapsed}
                      toggleCollapsed={toggleCollapsed}
                      isSelected={isSelected}
                      unreadFor={unreadFor}
                      onSelect={onSelect}
                      onContextMenu={openMenu}
                      onCommitInline={commitInline}
                      onCancelInline={cancelInline}
                    />
                  )}
                </FolderGroup>
              );
            })}
          </>
        )}
      </div>

      {menu && (
        <ContextMenu x={menu.x} y={menu.y} items={menuItems} onClose={() => setMenu(null)} />
      )}

      {deleteTarget && (
        <div
          className="fixed inset-0 z-[70] flex items-center justify-center bg-black/30"
          onClick={() => setDeleteTarget(null)}
        >
          <div
            onClick={(e) => e.stopPropagation()}
            className="w-80 rounded-md border border-[var(--border)] bg-[var(--background)] p-4 shadow-xl"
          >
            <h3 className="mb-2 text-sm font-medium text-[var(--foreground)]">
              Delete &ldquo;{deleteTarget.name}&rdquo;?
            </h3>
            <p className="mb-4 text-xs text-[var(--muted-text)]">
              Deleting this folder cannot be undone.
            </p>
            <div className="flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setDeleteTarget(null)}
                className="h-7 rounded px-3 text-sm text-[var(--foreground)] hover:bg-[var(--hover)]"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={() => {
                  void deleteFolderAction(deleteTarget.accountId, deleteTarget.id);
                  setDeleteTarget(null);
                }}
                className="h-7 rounded bg-red-600 px-3 text-sm text-white hover:opacity-90"
              >
                Delete
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
