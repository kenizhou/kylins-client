import { useEffect, useMemo, useRef, useState, memo } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import { useViewStore } from '../../features/view/viewStore';
import { COLUMN_REGISTRY } from '../../features/view/defaults';
import type { ColumnDef } from '../../features/view/types';
import { useThreadStore } from '../../stores/threadStore';
import { useFolderStore } from '../../stores/folderStore';
import { useAccountStore } from '../../stores/accountStore';
import { usePreferencesStore } from '../../stores/preferencesStore';
import { useViewportBodyPrefetch } from '../../hooks/useViewportBodyPrefetch';
import { useAutoHideScrollbar } from '../../hooks/useAutoHideScrollbar';
import type { Thread } from '../../services/db/threads';
import { getInitials, formatMessageTime } from '../../data/demoMessages';
import { openViewerWindow } from '../../utils/viewerWindow';
import { useClassification } from '../../features/classification/useClassification';
import { isProminent, levelStyle } from '../../features/classification/classificationStyle';
import { ClassificationBadge } from '../../features/classification/components/ClassificationBadge';
import { SecurityChips } from '../../features/classification/components/SecurityChips';
import {
  MailIcon,
  FlagIcon,
  WarningIcon,
  AttachmentIcon,
  TrashIcon,
  DeleteIcon,
  CopyIcon,
  FileTextIcon,
  ReplyIcon,
  ReplyAllIcon,
  MailSendIcon,
  TagIcon,
  SearchIcon,
  PreferencesMailRulesIcon,
  MoveIcon,
  ArchiveIcon,
  BellIcon,
} from '../icons';
import { ContextMenu } from '../ui/ContextMenu';
import { openComposerForThread } from '../../utils/composerActions';
import { FolderPickerMenu } from './ribbon/FolderPickerMenu';
import type { MailFolder } from '../../services/mail/folders/folderModel';
import { archiveThread, trashThread } from '../../services/mail/actions';

type MessageState = 'unread' | 'read' | 'flagged' | 'vip';

interface MessageRowProps {
  thread: Thread;
  selected?: boolean;
  density: 'compact' | 'normal' | 'comfortable';
  visibleColumns: ColumnDef[];
  onClick?: () => void;
  onDoubleClick?: () => void;
  onContextMenu?: (e: React.MouseEvent) => void;
}

function optionId(threadId: string): string {
  return `message-option-${threadId}`;
}

const RIBBON_COLOR: Record<MessageState, string> = {
  unread: 'bg-[var(--primary)]',
  read: 'bg-[var(--border)]',
  flagged: 'bg-[var(--amber)]',
  vip: 'bg-[var(--green)]',
};

const DENSITY_ROW_CLASSES = {
  compact: 'min-h-11 py-1',
  normal: 'min-h-11 py-1.5',
  comfortable: 'min-h-[52px] py-3',
};

interface QuickActionsProps {
  thread: Thread;
  visible: boolean;
  selected?: boolean;
}

function MessageRowQuickActions({ thread, visible, selected }: QuickActionsProps) {
  const markThreadRead = useThreadStore((s) => s.markThreadRead);
  const toggleThreadStarred = useThreadStore((s) => s.toggleThreadStarred);

  return (
    <span
      data-testid="message-quick-actions"
      className={`absolute right-2 top-1/2 z-10 -translate-y-1/2 items-center gap-0.5 rounded-md border border-[var(--border-subtle)] p-0.5 shadow-sm group-focus-within:flex ${visible ? 'flex' : 'hidden'} ${selected ? 'bg-[var(--surface-floating)]' : 'bg-[var(--surface-elevated)]'}`}
      onClick={(e) => e.stopPropagation()}
    >
      <button
        type="button"
        aria-label="Archive"
        title="Archive"
        className="inline-flex h-7 w-7 items-center justify-center rounded text-[var(--muted-text)] hover:bg-[var(--primary-subtle)] hover:text-[var(--foreground)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ring)]"
        onClick={() => void archiveThread(thread)}
      >
        <ArchiveIcon size={14} />
      </button>
      <button
        type="button"
        aria-label="Delete"
        title="Delete"
        className="inline-flex h-7 w-7 items-center justify-center rounded text-[var(--muted-text)] hover:bg-[var(--primary-subtle)] hover:text-[var(--destructive)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ring)]"
        onClick={() => void trashThread(thread)}
      >
        <DeleteIcon size={14} />
      </button>
      <button
        type="button"
        aria-label={thread.isStarred ? 'Unflag' : 'Flag'}
        title={thread.isStarred ? 'Unflag' : 'Flag'}
        className="inline-flex h-7 w-7 items-center justify-center rounded text-[var(--muted-text)] hover:bg-[var(--primary-subtle)] hover:text-[var(--amber)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ring)]"
        onClick={() => void toggleThreadStarred(thread)}
      >
        <FlagIcon size={14} className={thread.isStarred ? 'text-[var(--amber)]' : ''} />
      </button>
      <button
        type="button"
        aria-label={thread.isRead ? 'Mark unread' : 'Mark read'}
        title={thread.isRead ? 'Mark unread' : 'Mark read'}
        className="inline-flex h-7 w-7 items-center justify-center rounded text-[var(--muted-text)] hover:bg-[var(--primary-subtle)] hover:text-[var(--foreground)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ring)]"
        onClick={() => void markThreadRead(thread, !thread.isRead)}
      >
        <MailIcon size={14} />
      </button>
    </span>
  );
}

function visibleColumnIdsSet(visibleColumns: ColumnDef[]): Set<string> {
  return new Set(visibleColumns.map((c) => c.id));
}

const MessageRow = memo(function MessageRow({
  thread,
  selected,
  density,
  visibleColumns,
  ...handlers
}: MessageRowProps) {
  const { getLevelById } = useClassification();
  const level = getLevelById(thread.classificationId);
  const prominent = level ? isProminent(level) : false;
  const [isHovered, setIsHovered] = useState(false);

  const sender = thread.fromName ?? thread.fromAddress ?? 'Unknown';
  const unread = !thread.isRead;
  const cols = visibleColumnIdsSet(visibleColumns);
  const showImportance = cols.has('importance');
  const showCategory = cols.has('category');
  const showAttachments = cols.has('attachments');
  const showFlag = cols.has('flag');

  return (
    <div
      id={optionId(thread.id)}
      role="option"
      aria-selected={selected}
      {...handlers}
      onMouseEnter={() => setIsHovered(true)}
      onMouseLeave={() => setIsHovered(false)}
      style={
        {
          '--row-tint': prominent && level ? levelStyle(level).tint : undefined,
        } as React.CSSProperties
      }
      className={`group relative cursor-pointer ${DENSITY_ROW_CLASSES[density]} ${prominent && !selected ? 'bg-[var(--row-tint)]' : ''} ${selected ? 'bg-[var(--primary-muted)]' : 'hover:bg-[var(--primary-subtle)]'}`}
    >
      <div className="flex items-stretch px-1">
        {/* Left state ribbon */}
        <span className="flex h-full items-stretch">
          <span
            className={`w-[3px] rounded-r-[var(--radius-xs)] ${prominent ? '' : RIBBON_COLOR[unread ? 'unread' : thread.isStarred ? 'flagged' : thread.isImportant ? 'vip' : 'read']}`}
            style={prominent && level ? { backgroundColor: level.color } : undefined}
          />
        </span>

        {/* Main content column: sender / subject / preview + time */}
        <div className="flex-1 min-w-0 px-2 py-0.5">
          <div className="flex items-center justify-between gap-2">
            <div className="flex min-w-0 items-center gap-2">
              <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-[var(--border)] text-[10px] font-bold text-[var(--muted-text)]">
                {getInitials(sender)}
              </span>
              <span className={`truncate ${unread ? 'font-semibold' : ''}`}>{sender}</span>
              {showImportance && thread.isImportant && (
                <span title="Important" aria-label="Important" className="text-[var(--warning)]">
                  <WarningIcon size={14} />
                </span>
              )}
              {showCategory && level && (
                <ClassificationBadge level={level} size={density === 'compact' ? 'xs' : 'sm'} />
              )}
              <SecurityChips
                isEncrypted={thread.isEncrypted}
                isSigned={thread.isSigned}
                variant="icon"
                size={12}
              />
            </div>
            <span className="shrink-0 text-[11px] font-mono text-[var(--muted-text)]">
              {thread.lastMessageAt != null
                ? formatMessageTime(new Date(thread.lastMessageAt * 1000).toISOString())
                : ''}
            </span>
          </div>
          <div className={`truncate ${unread ? 'font-semibold' : ''}`}>
            {thread.subject ?? '(no subject)'}
          </div>
          {thread.snippet && (
            <div className="truncate text-[12px] text-[var(--muted-text)]">{thread.snippet}</div>
          )}
        </div>

        {/* Right metadata indicators */}
        <div className="flex shrink-0 flex-col items-end justify-center gap-1 pr-2">
          {showFlag && thread.isStarred && (
            <span title="Flagged" aria-label="Flagged" className="text-[var(--amber)]">
              <FlagIcon size={14} />
            </span>
          )}
          {showAttachments && thread.hasAttachments && (
            <span
              title="Has attachments"
              aria-label="Has attachments"
              className="text-[var(--muted-text)]"
            >
              <AttachmentIcon size={14} />
            </span>
          )}
        </div>
      </div>
      <MessageRowQuickActions
        thread={thread}
        visible={isHovered || !!selected}
        selected={!!selected}
      />
    </div>
  );
});

type ListItem = { kind: 'group'; label: string } | { kind: 'thread'; thread: Thread };

const EMPTY_FOLDERS: MailFolder[] = [];

function dayBucket(ts: number): string {
  const d = new Date(ts * 1000);
  const now = new Date();
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const dayMs = 86_400_000;
  if (d.getTime() >= startOfToday) return 'Today';
  if (d.getTime() >= startOfToday - dayMs) return 'Yesterday';
  return d.toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
    year: d.getFullYear() === now.getFullYear() ? undefined : 'numeric',
  });
}

function buildItems(threads: Thread[]): ListItem[] {
  const items: ListItem[] = [];
  let lastBucket = '';
  for (const t of threads) {
    const bucket = t.lastMessageAt != null ? dayBucket(t.lastMessageAt) : 'Earlier';
    if (bucket !== lastBucket) {
      items.push({ kind: 'group', label: bucket });
      lastBucket = bucket;
    }
    items.push({ kind: 'thread', thread: t });
  }
  return items;
}

export function MessageList() {
  const density = useViewStore((s) => s.messageListDensity);
  const visibleColumnIds = useViewStore((s) => s.visibleColumnIds);
  const conversationView = useViewStore((s) => s.conversationView);
  const defaultReplyBehavior = usePreferencesStore((s) => s.defaultReplyBehavior);

  const selectedFolder = useFolderStore((s) => s.selected);
  const folders = useFolderStore((s) =>
    selectedFolder ? (s.byAccount[selectedFolder.accountId] ?? EMPTY_FOLDERS) : EMPTY_FOLDERS,
  );
  const selectedRole = useMemo(
    () => folders.find((f) => f.id === selectedFolder?.labelId)?.role ?? null,
    [folders, selectedFolder],
  );
  const isInbox = selectedRole === 'inbox';
  const [inboxTab, setInboxTab] = useState<'all' | 'unread'>('all');

  useEffect(() => {
    setInboxTab('all');
  }, [selectedFolder?.labelId]);

  const threads = useThreadStore((s) => s.threads);
  const selectedThreadId = useThreadStore((s) => s.selectedThreadId);
  const isLoading = useThreadStore((s) => s.isLoading);
  const cursor = useThreadStore((s) => s.cursor);
  const accounts = useAccountStore((s) => s.accounts);
  const loadThreads = useThreadStore((s) => s.loadThreads);
  const loadMore = useThreadStore((s) => s.loadMore);
  const selectThread = useThreadStore((s) => s.selectThread);
  const markThreadRead = useThreadStore((s) => s.markThreadRead);
  const toggleThreadStarred = useThreadStore((s) => s.toggleThreadStarred);
  const deleteThread = useThreadStore((s) => s.deleteThread);
  const moveThread = useThreadStore((s) => s.moveThread);

  const visibleColumns = useMemo(
    () =>
      visibleColumnIds
        .map((id) => COLUMN_REGISTRY.get(id))
        .filter((c): c is ColumnDef => c != null),
    [visibleColumnIds],
  );

  // Load threads whenever the selected folder changes.
  useEffect(() => {
    if (selectedFolder) {
      void loadThreads(selectedFolder.accountId, selectedFolder.labelId);
    } else {
      useThreadStore.setState({ threads: [], currentQuery: null, cursor: null });
    }
  }, [selectedFolder, loadThreads]);

  const items = useMemo(() => buildItems(threads), [threads]);

  const filteredItems = useMemo(() => {
    if (!isInbox || inboxTab === 'all') return items;
    const result: ListItem[] = [];
    let pendingGroup: ListItem | null = null;
    for (const item of items) {
      if (item.kind === 'group') {
        pendingGroup = item;
        continue;
      }
      const t = item.thread;
      if (!t.isRead) {
        if (pendingGroup) {
          result.push(pendingGroup);
          pendingGroup = null;
        }
        result.push(item);
      }
    }
    if (result.length === items.length) return items;
    return result;
  }, [items, isInbox, inboxTab]);

  const scrollRef = useRef<HTMLDivElement>(null);
  const scrollbarClass = useAutoHideScrollbar();
  // TanStack Virtual returns mutable function references that React Compiler
  // cannot safely memoize. Suppress the compiler warning here; the virtualizer
  // is used locally and its outputs are not memoized downstream.
  // eslint-disable-next-line react-hooks/incompatible-library
  const virtualizer = useVirtualizer({
    count: filteredItems.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => (density === 'comfortable' ? 52 : 44),
    overscan: 12,
  });

  // Viewport-aware batch body prefetch: when scroll settles (or on mount /
  // folder-switch), request bodies for the visible + buffer rows that aren't
  // yet cached. Best-effort, debounced, and skipped while the account is
  // rate-limited. See `hooks/useViewportBodyPrefetch.ts`.
  useViewportBodyPrefetch({
    virtualizer,
    items: filteredItems,
    accountId: selectedFolder?.accountId ?? null,
  });

  // Infinite scroll: when the user nears the end, fetch the next cursor page.
  // Depend on a stable `nearEnd` boolean rather than the virtualItems array
  // (a new array reference on every measure pass), so the effect doesn't
  // re-run on every scroll tick.
  const virtualItems = virtualizer.getVirtualItems();
  const nearEnd =
    filteredItems.length > 0 && (virtualItems.at(-1)?.index ?? -1) >= filteredItems.length - 6;
  useEffect(() => {
    if (nearEnd && cursor && !isLoading) {
      void loadMore();
    }
  }, [nearEnd, cursor, isLoading, loadMore]);

  // If the active Unread tab filter empties out the currently loaded page
  // but the backend cursor still has more data, keep paginating so the user
  // isn't stuck on an empty screen while pages remain.
  useEffect(() => {
    if (isInbox && filteredItems.length === 0 && items.length > 0 && cursor && !isLoading) {
      void loadMore();
    }
  }, [isInbox, filteredItems.length, items.length, cursor, isLoading, loadMore]);

  const handleDoubleClick = async (thread: Thread) => {
    await selectThread(thread);
    const msg = useViewStore.getState().selectedMessage;
    if (msg) openViewerWindow(msg);
  };

  const [menu, setMenu] = useState<{ thread: Thread; x: number; y: number } | null>(null);
  const [moveMenu, setMoveMenu] = useState<{ thread: Thread; x: number; y: number } | null>(null);
  const [activeDescendantId, setActiveDescendantId] = useState<string | null>(null);

  // Keep the active descendant in sync with the selected thread so screen
  // readers always announce the current option when focus is on the listbox.
  useEffect(() => {
    setActiveDescendantId(selectedThreadId ? optionId(selectedThreadId) : null);
  }, [selectedThreadId]);

  const showEmpty = !isLoading && filteredItems.length === 0;
  const emptyMessage = isInbox
    ? inboxTab === 'unread'
      ? 'No unread messages.'
      : 'No messages in this folder.'
    : 'No messages in this folder.';

  const openContextMenu = (thread: Thread, e: React.MouseEvent) => {
    e.preventDefault();
    setMenu({ thread, x: e.clientX, y: e.clientY });
  };

  const menuItems = useMemo(() => {
    if (!menu) return [];
    const account = accounts.find((a) => a.id === menu.thread.accountId) ?? null;
    const replyMode = defaultReplyBehavior === 'reply-all' ? 'replyAll' : 'reply';
    return [
      { label: 'Copy', icon: CopyIcon, disabled: true },
      { label: 'Quick Print', icon: FileTextIcon, disabled: true },
      { separator: true },
      {
        label: 'Reply',
        icon: ReplyIcon,
        onSelect: () => {
          if (!account) return;
          void openComposerForThread(menu.thread, replyMode, account);
        },
      },
      {
        label: 'Reply All',
        icon: ReplyAllIcon,
        onSelect: () => {
          if (!account) return;
          void openComposerForThread(menu.thread, 'replyAll', account);
        },
      },
      {
        label: 'Forward',
        icon: MailSendIcon,
        onSelect: () => {
          if (!account) return;
          void openComposerForThread(menu.thread, 'forward', account);
        },
      },
      {
        label: menu.thread.isRead ? 'Mark as Unread' : 'Mark as Read',
        icon: MailIcon,
        onSelect: () => void markThreadRead(menu.thread, !menu.thread.isRead),
      },
      { separator: true },
      { label: 'Categorize', icon: TagIcon, disabled: true },
      {
        label: menu.thread.isStarred ? 'Clear Follow Up' : 'Follow Up',
        icon: FlagIcon,
        onSelect: () => void toggleThreadStarred(menu.thread),
      },
      { label: 'Find Related', icon: SearchIcon, disabled: true },
      { label: 'Rules', icon: PreferencesMailRulesIcon, disabled: true },
      { separator: true },
      {
        label: 'Move',
        icon: MoveIcon,
        onSelect: () => setMoveMenu({ thread: menu.thread, x: menu.x, y: menu.y }),
      },
      { label: 'Junk', icon: BellIcon, disabled: true },
      {
        label: 'Delete',
        icon: TrashIcon,
        danger: true,
        onSelect: () => void deleteThread(menu.thread),
      },
      {
        label: 'Archive',
        icon: ArchiveIcon,
        onSelect: () => {
          if (!menu.thread) return;
          void archiveThread(menu.thread);
        },
      },
    ];
  }, [menu, accounts, defaultReplyBehavior, markThreadRead, toggleThreadStarred, deleteThread]);

  return (
    <div className="message-list flex flex-col h-full bg-surface border-r border-[var(--border-subtle)]">
      {conversationView && (
        <div className="px-3 py-1 text-[11px] text-[var(--foreground)] bg-[var(--selected)]">
          Conversation view enabled
        </div>
      )}

      {isInbox && (
        <div
          role="tablist"
          aria-label="Inbox view"
          className="flex items-center gap-1 border-b border-[var(--border)] px-3 py-1.5"
        >
          <button
            type="button"
            role="tab"
            aria-selected={inboxTab === 'all'}
            onClick={() => setInboxTab('all')}
            className={`rounded px-2.5 py-1 text-xs font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ring)] ${inboxTab === 'all' ? 'bg-[var(--primary-muted)] text-[var(--foreground)]' : 'text-[var(--muted-text)] hover:bg-[var(--primary-subtle)]'}`}
          >
            All
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={inboxTab === 'unread'}
            onClick={() => setInboxTab('unread')}
            className={`rounded px-2.5 py-1 text-xs font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ring)] ${inboxTab === 'unread' ? 'bg-[var(--primary-muted)] text-[var(--foreground)]' : 'text-[var(--muted-text)] hover:bg-[var(--primary-subtle)]'}`}
          >
            Unread
          </button>
        </div>
      )}

      <div
        ref={scrollRef}
        tabIndex={0}
        role="listbox"
        aria-label="Messages"
        aria-busy={isLoading && filteredItems.length === 0 ? true : undefined}
        aria-activedescendant={activeDescendantId ?? undefined}
        className={`flex-1 flex flex-col overflow-auto outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[var(--ring)] ${scrollbarClass}`}
        onKeyDown={(e) => {
          if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
            e.preventDefault();
            const direction = e.key === 'ArrowDown' ? 1 : -1;
            const currentIndex = filteredItems.findIndex(
              (i) => i.kind === 'thread' && i.thread.id === selectedThreadId,
            );
            function nextThreadIndex(start: number, dir: 1 | -1): number | null {
              let i = start + dir;
              while (i >= 0 && i < filteredItems.length) {
                if (filteredItems[i]?.kind === 'thread') return i;
                i += dir;
              }
              return null;
            }
            const nextIndex =
              currentIndex === -1
                ? nextThreadIndex(direction === 1 ? -1 : filteredItems.length, direction)
                : nextThreadIndex(currentIndex, direction);
            if (nextIndex == null) return;
            const nextItem = filteredItems[nextIndex];
            if (!nextItem || nextItem.kind !== 'thread') return;
            setActiveDescendantId(optionId(nextItem.thread.id));
            void selectThread(nextItem.thread);
            virtualizer.scrollToIndex(nextIndex, { align: 'auto' });
            return;
          }

          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            const activeThreadId = activeDescendantId?.replace(/^message-option-/, '');
            const activeItem = activeThreadId
              ? filteredItems.find((i) => i.kind === 'thread' && i.thread.id === activeThreadId)
              : undefined;
            if (activeItem?.kind === 'thread') {
              void selectThread(activeItem.thread);
            }
          }
        }}
      >
        {isLoading && filteredItems.length === 0 ? (
          <div
            role="status"
            className="flex flex-1 flex-col items-center justify-center gap-2 px-3 py-10 text-center text-xs text-[var(--muted-text)]"
          >
            <MailIcon size={24} className="opacity-50" />
            <span>Loading messages…</span>
          </div>
        ) : showEmpty ? (
          <div
            role="status"
            className="flex flex-1 flex-col items-center justify-center gap-2 px-3 py-10 text-center text-xs text-[var(--muted-text)]"
          >
            <MailIcon size={24} className="opacity-50" />
            <span>{emptyMessage}</span>
            {!isInbox && (
              <span className="text-[10px] opacity-70">
                Select a different folder or check back later.
              </span>
            )}
          </div>
        ) : (
          <div
            role="presentation"
            style={{ height: virtualizer.getTotalSize(), position: 'relative' }}
          >
            {virtualItems.map((vi) => {
              const item = filteredItems[vi.index];
              if (!item) return null;
              return (
                <div
                  key={vi.key}
                  data-index={vi.index}
                  role="presentation"
                  ref={virtualizer.measureElement}
                  style={{
                    position: 'absolute',
                    top: 0,
                    left: 0,
                    width: '100%',
                    transform: `translateY(${vi.start}px)`,
                  }}
                >
                  {item.kind === 'group' ? (
                    <div
                      role="presentation"
                      className="py-1.5 px-3 border-b border-[var(--border-subtle)] font-bold uppercase tracking-[0.04em] text-[var(--muted-text)] text-[11px]"
                    >
                      {item.label}
                    </div>
                  ) : (
                    <MessageRow
                      thread={item.thread}
                      selected={selectedThreadId === item.thread.id}
                      density={density}
                      visibleColumns={visibleColumns}
                      onClick={() => {
                        setActiveDescendantId(optionId(item.thread.id));
                        void selectThread(item.thread);
                      }}
                      onDoubleClick={() => void handleDoubleClick(item.thread)}
                      onContextMenu={(e) => openContextMenu(item.thread, e)}
                    />
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>

      {menu && (
        <ContextMenu x={menu.x} y={menu.y} items={menuItems} onClose={() => setMenu(null)} />
      )}
      {moveMenu && (
        <FolderPickerMenu
          accountId={moveMenu.thread.accountId}
          excludeLabelId={selectedFolder?.labelId}
          style={{ position: 'fixed', left: moveMenu.x, top: moveMenu.y, zIndex: 80 }}
          onSelect={(folder: MailFolder) => {
            void moveThread(moveMenu.thread, folder.id, folder.remoteId ?? folder.name);
            setMoveMenu(null);
          }}
          onClose={() => setMoveMenu(null)}
        />
      )}
    </div>
  );
}
