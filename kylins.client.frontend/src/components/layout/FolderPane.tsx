import { useEffect, useMemo, useRef, useState } from 'react';
import {
  PinIcon,
  PlusIcon,
  PencilIcon,
  TrashIcon,
  FolderIcon,
  ArrowDownIcon,
  ArrowRightIcon,
} from '../icons';
import { useAccountStore } from '../../stores/accountStore';
import { useFolderStore, favKey } from '../../stores/folderStore';
import type { MailFolder } from '../../services/mail/folders';
import { getFolderIcon } from '../../utils/folderIcons';
import { buildFolderTree, type FolderTreeNode } from '../../utils/folderTree';
import { useAutoHideScrollbar } from '../../hooks/useAutoHideScrollbar';
import { ContextMenu, type ContextMenuItem } from '../ui/ContextMenu';
import { Modal } from '../ui/Modal';
import {
  Button,
  Collection,
  Disclosure,
  DisclosurePanel,
  Input,
  TextField,
  Tree,
  TreeItem,
  TreeItemContent,
} from 'react-aria-components';

// ---- Inline create/rename input (Mailspring-style: in-place, not a modal) ----

interface InlineInputProps {
  padLeft?: boolean;
  depth?: number;
  initialValue: string;
  placeholder: string;
  onSubmit: (value: string) => void;
  onCancel: () => void;
}

function InlineFolderInput({
  padLeft = true,
  depth = 0,
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
      className="flex h-7 items-center gap-2.5 pr-2 text-foreground"
      style={padLeft ? { paddingLeft: `${8 + depth * 14}px` } : undefined}
      onPointerDown={(e) => e.stopPropagation()}
      onClick={(e) => e.stopPropagation()}
    >
      <FolderIcon size={18} className="shrink-0" />
      <TextField className="flex-1" aria-label={placeholder}>
        <Input
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
          className="h-5 w-full rounded border border-primary bg-background px-1.5 text-[13px] text-foreground outline-none"
        />
      </TextField>
    </div>
  );
}

// ---- Favorites / plain folder row (flat list, not a tree) ----

interface FolderRowProps {
  icon: React.ReactNode;
  name: string;
  active?: boolean;
  unread?: number;
  onClick?: () => void;
  onContextMenu?: (e: React.MouseEvent) => void;
}

function FolderRow({
  icon,
  name,
  active = false,
  unread = 0,
  onClick,
  onContextMenu,
}: FolderRowProps) {
  return (
    <div
      onContextMenu={(e) => {
        e.preventDefault();
        onContextMenu?.(e);
      }}
    >
      <Button
        onPress={onClick}
        className={`
          group relative flex h-9 min-w-0 flex-1 items-center gap-2.5 px-3 pr-2 w-full text-left transition-colors duration-fast
          ${active ? 'bg-[var(--primary-muted)] text-[var(--selected-text)]' : 'text-foreground hover:bg-[var(--primary-subtle)]'}
        `}
      >
        {active && (
          <span className="absolute bottom-0 left-0 top-0 w-[3px] rounded-r-full iris-line" />
        )}
        <span className="shrink-0">{icon}</span>
        <span className="flex-1 truncate text-[13px]">{name}</span>
        {unread > 0 && (
          <span
            className={`rounded-full px-1.5 py-0.5 tabular-nums text-[11px] font-medium ${
              active
                ? 'bg-primary text-primary-fg'
                : 'bg-[var(--primary-subtle-solid)] text-primary'
            }`}
          >
            {unread}
          </span>
        )}
      </Button>
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
  const headerContent = (
    <>
      {collapsible && (
        <svg
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth={2.5}
          strokeLinecap="round"
          strokeLinejoin="round"
          className="size-3 shrink-0 transition-transform group-data-[expanded=true]:rotate-90"
        >
          <path d="M9 6l6 6-6 6" />
        </svg>
      )}
      <span className="truncate">{title}</span>
    </>
  );

  if (!collapsible) {
    return (
      <div className="pb-2 pt-2 first:pt-3 last:pb-0">
        <div className="flex w-full items-center gap-1 px-3 pb-1.5 text-left type-overline text-[var(--muted-text)]">
          {headerContent}
        </div>
        <div className="space-y-0.5 px-0">{children}</div>
      </div>
    );
  }

  return (
    <Disclosure
      isExpanded={collapsible.expanded}
      onExpandedChange={collapsible.onToggle}
      className="pb-2 pt-2 first:pt-3 last:pb-0"
    >
      <Button
        slot="trigger"
        className="group flex h-9 w-full items-center gap-1 px-3 text-left type-overline text-[var(--muted-text)] transition-colors hover:text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        {headerContent}
      </Button>
      <DisclosurePanel className="space-y-0.5 px-0">{children}</DisclosurePanel>
    </Disclosure>
  );
}

// ---- Account folder tree backed by react-aria-components ----

type InlineEdit =
  | { kind: 'rename'; folder: MailFolder; name: string }
  | { kind: 'create'; accountId: string; parentId: string | null; name: string };

type TreeItemData =
  | { type: 'folder'; id: string; folder: MailFolder; children: TreeItemData[] }
  | { type: 'create'; id: string; accountId: string; parentId: string | null; name: string };

function buildAccountTreeItems(
  nodes: FolderTreeNode[],
  accountId: string,
  inline: InlineEdit | null,
): TreeItemData[] {
  const rootCreate: TreeItemData | null =
    inline?.kind === 'create' && inline.accountId === accountId && inline.parentId === null
      ? {
          type: 'create',
          id: `__create-root-${accountId}`,
          accountId,
          parentId: null,
          name: '',
        }
      : null;

  const buildNode = (node: FolderTreeNode): TreeItemData => {
    const children = node.children.map(buildNode);
    if (
      inline?.kind === 'create' &&
      (inline.parentId === node.folder.remoteId || inline.parentId === node.folder.id)
    ) {
      children.push({
        type: 'create',
        id: `__create-${node.folder.id}`,
        accountId: node.folder.accountId,
        parentId: inline.parentId,
        name: '',
      });
    }
    return { type: 'folder', id: node.folder.id, folder: node.folder, children };
  };

  const roots = nodes.map(buildNode);
  if (rootCreate) roots.unshift(rootCreate);
  return roots;
}

function findFolder(items: TreeItemData[], id: string): MailFolder | undefined {
  for (const item of items) {
    if (item.type === 'folder') {
      if (item.id === id) return item.folder;
      const found = findFolder(item.children, id);
      if (found) return found;
    }
  }
  return undefined;
}

function allFolderIds(nodes: FolderTreeNode[]): string[] {
  return nodes.flatMap((n) => [n.folder.id, ...allFolderIds(n.children)]);
}

interface AccountFolderTreeProps {
  accountId: string;
  nodes: FolderTreeNode[];
  inline: InlineEdit | null;
  collapsed: Set<string>;
  selectedAccountId?: string | null;
  selectedLabelId?: string | null;
  onExpandedChange: (expanded: Set<string>) => void;
  onSelect: (folder: MailFolder) => void;
  onContextMenu: (folder: MailFolder, e: React.MouseEvent) => void;
  onCommitInline: (value: string) => void;
  onCancelInline: () => void;
}

function AccountFolderTree({
  nodes,
  inline,
  collapsed,
  selectedAccountId,
  selectedLabelId,
  accountId,
  onExpandedChange,
  onSelect,
  onContextMenu,
  onCommitInline,
  onCancelInline,
}: AccountFolderTreeProps) {
  // Subscribe to the counts MAP (new identity on every change) so badge
  // updates re-render immediately — selecting the `getUnread` action would
  // never re-render (stable function reference).
  const unreadCounts = useFolderStore((s) => s.unreadCounts);

  // unreadCounts is a renderItem input (badges), so it must be a dep here:
  // react-aria's Tree caches rows by item identity, and only fresh item
  // objects make it re-render a row when just the count changed.
  const items = useMemo(
    () => buildAccountTreeItems(nodes, accountId, inline),
    [nodes, accountId, inline, unreadCounts],
  );

  const selectedKeys = useMemo(() => {
    const set = new Set<string>();
    if (selectedAccountId === accountId && selectedLabelId) {
      function walk(list: TreeItemData[]) {
        for (const item of list) {
          if (item.type === 'folder') {
            if (item.id === selectedLabelId) set.add(item.id);
            walk(item.children);
          }
        }
      }
      walk(items);
    }
    return set;
  }, [items, selectedAccountId, selectedLabelId, accountId]);

  const expandedKeys = useMemo(() => {
    const set = new Set<string>();
    function walk(list: TreeItemData[]) {
      for (const item of list) {
        if (item.type === 'folder') {
          if (!collapsed.has(item.id)) set.add(item.id);
          walk(item.children);
        }
      }
    }
    walk(items);
    return set;
  }, [items, collapsed]);

  const disabledKeys = useMemo(() => {
    const set = new Set<string>();
    function walk(list: TreeItemData[]) {
      for (const item of list) {
        if (item.type !== 'folder') set.add(item.id);
        else walk(item.children);
      }
    }
    walk(items);
    return set;
  }, [items]);

  const handleSelectionChange = (keys: import('react-aria-components').Selection) => {
    if (keys === 'all') return;
    const key = String(Array.from(keys)[0]);
    const folder = findFolder(items, key);
    if (folder) onSelect(folder);
  };

  const handleExpandedChange = (keys: Set<React.Key>) => {
    const expanded = new Set<string>(Array.from(keys).map(String));
    onExpandedChange(expanded);
  };

  const renderItem = (item: TreeItemData) => {
    if (item.type === 'create') {
      return (
        <TreeItem
          key={item.id}
          id={item.id}
          textValue="New folder"
          isDisabled
          className="outline-none"
        >
          <TreeItemContent>
            {({ level }) => (
              <div
                className="flex items-center py-1 pr-3"
                style={{ paddingLeft: `${8 + (level - 1) * 14}px` }}
                onPointerDown={(e) => e.stopPropagation()}
                onClick={(e) => e.stopPropagation()}
              >
                <span className="w-5 shrink-0" />
                <InlineFolderInput
                  padLeft={false}
                  initialValue=""
                  placeholder="Folder name"
                  onSubmit={onCommitInline}
                  onCancel={onCancelInline}
                />
              </div>
            )}
          </TreeItemContent>
        </TreeItem>
      );
    }

    const { folder, children } = item;
    const Icon = getFolderIcon(folder.role);
    const renaming =
      inline?.kind === 'rename' &&
      inline.folder.id === folder.id &&
      inline.folder.accountId === folder.accountId;

    return (
      <TreeItem
        key={folder.id}
        id={folder.id}
        textValue={folder.name}
        className={({ isSelected, isHovered }) =>
          `group relative flex w-full items-center outline-none transition-colors duration-fast ${
            isSelected
              ? 'bg-[var(--primary-muted)] text-[var(--selected-text)]'
              : isHovered
                ? 'bg-[var(--primary-subtle)]'
                : ''
          }`
        }
      >
        <TreeItemContent>
          {({ isExpanded, hasChildItems, level, isSelected }) => {
            const unread = unreadCounts[favKey(folder.accountId, folder.id)] ?? 0;
            return (
              <div
                className="flex flex-1 items-center gap-2 h-9 pr-3"
                style={{ paddingLeft: `${8 + (level - 1) * 14}px` }}
                onContextMenu={(e) => {
                  e.preventDefault();
                  onContextMenu(folder, e);
                }}
              >
                {isSelected && (
                  <span className="absolute bottom-0 left-0 top-0 w-[3px] rounded-r-full iris-line" />
                )}
                {hasChildItems ? (
                  <Button
                    slot="chevron"
                    className="group relative flex h-9 w-9 shrink-0 items-center justify-center rounded text-muted-text transition-colors hover:bg-[var(--primary-subtle)] hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                    aria-label={isExpanded ? 'Collapse folder' : 'Expand folder'}
                  >
                    {isExpanded ? <ArrowDownIcon size={12} /> : <ArrowRightIcon size={12} />}
                  </Button>
                ) : (
                  <span className="w-11 shrink-0" />
                )}
                {renaming ? (
                  <div
                    className="flex-1"
                    onPointerDown={(e) => e.stopPropagation()}
                    onClick={(e) => e.stopPropagation()}
                  >
                    <InlineFolderInput
                      padLeft={false}
                      initialValue={inline.name}
                      placeholder="Folder name"
                      onSubmit={onCommitInline}
                      onCancel={onCancelInline}
                    />
                  </div>
                ) : (
                  <>
                    <span className="text-muted-text">
                      <Icon size={15} />
                    </span>
                    <span className="flex-1 truncate text-[13px]">{folder.name}</span>
                    {unread > 0 && (
                      <span
                        className={`rounded-full px-1.5 py-0.5 tabular-nums text-[11px] font-medium ${
                          isSelected
                            ? 'bg-primary text-primary-fg'
                            : 'bg-[var(--primary-subtle-solid)] text-primary'
                        }`}
                      >
                        {unread}
                      </span>
                    )}
                  </>
                )}
              </div>
            );
          }}
        </TreeItemContent>
        <Collection items={children}>{renderItem}</Collection>
      </TreeItem>
    );
  };

  return (
    <Tree
      aria-label="Folders"
      items={items}
      selectionMode="single"
      selectedKeys={selectedKeys}
      onSelectionChange={handleSelectionChange}
      expandedKeys={expandedKeys}
      onExpandedChange={handleExpandedChange}
      disabledKeys={disabledKeys}
      className="outline-none"
    >
      {renderItem}
    </Tree>
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
  const unreadCounts = useFolderStore((s) => s.unreadCounts);
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
  const scrollbarClass = useAutoHideScrollbar();

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
  const unreadFor = (folder: MailFolder) => unreadCounts[favKey(folder.accountId, folder.id)] ?? 0;
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
    <div className="flex h-full flex-col rounded-2xl bg-[var(--card)] border border-[var(--border-subtle)]">
      <div className={`flex-1 folder-pane-scroll ${scrollbarClass}`}>
        {totalFolders === 0 ? (
          <div className="px-3 py-6 text-center text-xs text-muted-text">
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

            {favoriteFolders.length > 0 && <div className="mx-3 h-px bg-[var(--border-subtle)]" />}

            {accounts.map((account) => {
              const folders = byAccount[account.id] ?? [];
              if (
                folders.length === 0 &&
                !(inline?.kind === 'create' && inline.accountId === account.id)
              ) {
                return null;
              }
              const allTree = folderTrees[account.id] ?? [];
              const title = account.accountLabel ?? account.email;
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
                  {accountExpanded && (
                    <AccountFolderTree
                      accountId={account.id}
                      nodes={allTree}
                      inline={inline}
                      collapsed={collapsed}
                      selectedAccountId={selected?.accountId}
                      selectedLabelId={selected?.labelId}
                      onExpandedChange={(expanded) =>
                        setCollapsed((prev) => {
                          const next = new Set(prev);
                          for (const id of allFolderIds(allTree)) {
                            if (expanded.has(id)) next.delete(id);
                            else next.add(id);
                          }
                          return next;
                        })
                      }
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

      <Modal
        isOpen={deleteTarget !== null}
        onClose={() => setDeleteTarget(null)}
        title={`Delete &ldquo;${deleteTarget?.name ?? ''}&rdquo;?`}
        size="md"
        footer={
          <>
            <Button
              onPress={() => setDeleteTarget(null)}
              className="h-11 rounded-md px-3 text-sm text-foreground transition-colors hover:bg-[var(--primary-subtle)]"
            >
              Cancel
            </Button>
            <Button
              onPress={() => {
                if (deleteTarget) {
                  void deleteFolderAction(deleteTarget.accountId, deleteTarget.id);
                }
                setDeleteTarget(null);
              }}
              className="h-11 rounded-md bg-destructive px-3 text-sm text-white transition-colors hover:opacity-90"
            >
              Delete
            </Button>
          </>
        }
      >
        <p className="text-xs text-muted-text">Deleting this folder cannot be undone.</p>
      </Modal>
    </div>
  );
}
