import { useEffect, useMemo, useRef, useState, memo } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import { useViewStore } from '../../features/view/viewStore';
import { COLUMN_REGISTRY } from '../../features/view/defaults';
import type { ColumnDef, MessageListDensity } from '../../features/view/types';
import { useThreadStore } from '../../stores/threadStore';
import { useFolderStore } from '../../stores/folderStore';
import { useAccountStore } from '../../stores/accountStore';
import { usePreferencesStore } from '../../stores/preferencesStore';
import { useViewportBodyPrefetch } from '../../hooks/useViewportBodyPrefetch';
import { useAutoHideScrollbar, autoHideScrollbarClass } from '../../hooks/useAutoHideScrollbar';
import type { Thread } from '../../services/db/threads';
import { getInitials, formatMessageTime } from '../../data/demoMessages';
import { openViewerWindow } from '../../utils/viewerWindow';
import { useClassification } from '../../features/classification/useClassification';
import { isProminent } from '../../features/classification/classificationStyle';
import { ClassificationBadge } from '../../features/classification/components/ClassificationBadge';
import {
  MailIcon,
  FlagIcon,
  AttachmentIcon,
  TrashIcon,
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

type MessageState = 'unread' | 'read' | 'flagged' | 'vip';

interface MessageRowProps {
  thread: Thread;
  selected?: boolean;
  density: 'compact' | 'normal' | 'comfortable';
  onClick?: () => void;
  onDoubleClick?: () => void;
  onContextMenu?: (e: React.MouseEvent) => void;
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

function cellWidth(col: ColumnDef): React.CSSProperties {
  if (col.width) return { width: col.width, minWidth: col.width };
  return { width: 'auto', minWidth: 24 };
}

function MessageRowCell({
  col,
  thread,
  density,
}: {
  col: ColumnDef;
  thread: Thread;
  density: MessageListDensity;
}) {
  const { getLevelById } = useClassification();
  const level = getLevelById(thread.classificationId);
  const prominent = level ? isProminent(level) : false;
  const unread = !thread.isRead;

  switch (col.renderer) {
    case 'threadRibbon':
      return (
        <span className="flex h-full items-stretch" style={cellWidth(col)}>
          <span
            className={`w-[3px] rounded-r-[var(--radius-xs)] ${prominent ? '' : RIBBON_COLOR[thread.isRead ? 'read' : unread ? 'unread' : thread.isStarred ? 'flagged' : thread.isImportant ? 'vip' : 'read']}`}
            style={prominent && level ? { backgroundColor: level.color } : undefined}
          />
        </span>
      );
    case 'importance':
      return (
        <span className="flex items-center justify-center" style={cellWidth(col)}>
          {thread.isImportant && (
            <span title="Important" aria-label="Important" className="text-[var(--warning)]">
              !
            </span>
          )}
        </span>
      );
    case 'category':
      return (
        <span className="flex items-center" style={cellWidth(col)}>
          {level && (
            <ClassificationBadge level={level} size={density === 'compact' ? 'xs' : 'sm'} />
          )}
        </span>
      );
    case 'from': {
      const sender = thread.fromName ?? thread.fromAddress ?? 'Unknown';
      return (
        <span className="flex min-w-0 items-center gap-2" style={cellWidth(col)}>
          <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-[var(--border)] text-[10px] font-bold text-[var(--muted-text)]">
            {getInitials(sender)}
          </span>
          <span className={`truncate ${unread ? 'font-semibold' : ''}`}>{sender}</span>
        </span>
      );
    }
    case 'subject':
      return (
        <span className="flex min-w-0 flex-col justify-center" style={cellWidth(col)}>
          <span className={`truncate ${unread ? 'font-semibold' : ''}`}>
            {thread.subject ?? '(no subject)'}
          </span>
          {density === 'comfortable' && thread.snippet && (
            <span className="truncate text-[12px] text-[var(--muted-text)]">{thread.snippet}</span>
          )}
        </span>
      );
    case 'snippet':
      return (
        <span
          className="flex items-center truncate text-[12px] text-[var(--muted-text)]"
          style={cellWidth(col)}
        >
          {thread.snippet}
        </span>
      );
    case 'received':
      return (
        <span
          className="flex items-center justify-end text-[11px] font-mono text-[var(--muted-text)]"
          style={cellWidth(col)}
        >
          {thread.lastMessageAt != null
            ? formatMessageTime(new Date(thread.lastMessageAt * 1000).toISOString())
            : ''}
        </span>
      );
    case 'size':
      return (
        <span
          className="flex items-center justify-end text-[11px] text-[var(--muted-text)]"
          style={cellWidth(col)}
        />
      );
    case 'attachments':
      return (
        <span className="flex items-center justify-center" style={cellWidth(col)}>
          {thread.hasAttachments && (
            <span
              title="Has attachments"
              aria-label="Has attachments"
              className="text-[var(--muted-text)]"
            >
              <AttachmentIcon size={14} />
            </span>
          )}
        </span>
      );
    case 'flag':
      return (
        <span className="flex items-center justify-center" style={cellWidth(col)}>
          {thread.isStarred && (
            <span title="Flagged" aria-label="Flagged" className="text-[var(--amber)]">
              <FlagIcon size={14} />
            </span>
          )}
        </span>
      );
    case 'read':
      return (
        <span className="flex items-center justify-center" style={cellWidth(col)}>
          {!thread.isRead && (
            <span className="h-2 w-2 rounded-full bg-[var(--primary)]" aria-label="Unread" />
          )}
        </span>
      );
    default:
      return null;
  }
}

const MessageRow = memo(function MessageRow({
  thread,
  selected,
  density,
  ...handlers
}: MessageRowProps) {
  const visibleColumnIds = useViewStore((s) => s.visibleColumnIds);
  const visibleColumns = visibleColumnIds
    .map((id) => COLUMN_REGISTRY.get(id))
    .filter((c): c is ColumnDef => c != null);

  return (
    <div
      role="listitem"
      aria-selected={selected}
      tabIndex={0}
      {...handlers}
      className={`group flex cursor-pointer items-stretch gap-1 px-1 ${DENSITY_ROW_CLASSES[density]} ${selected ? 'bg-[var(--selected)]' : 'hover:bg-[var(--hover)]'}`}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          handlers.onClick?.();
        }
      }}
    >
      {visibleColumns.map((col) => (
        <div
          key={col.id}
          className={`message-list-col-${col.id} flex min-w-0 items-center`}
          style={cellWidth(col)}
        >
          <MessageRowCell col={col} thread={thread} density={density} />
        </div>
      ))}
    </div>
  );
});

type ListItem = { kind: 'group'; label: string } | { kind: 'thread'; thread: Thread };

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

  const visibleColumns = visibleColumnIds
    .map((id) => COLUMN_REGISTRY.get(id))
    .filter((c): c is ColumnDef => c != null);

  // Load threads whenever the selected folder changes.
  useEffect(() => {
    if (selectedFolder) {
      void loadThreads(selectedFolder.accountId, selectedFolder.labelId);
    } else {
      useThreadStore.setState({ threads: [], currentQuery: null, cursor: null });
    }
  }, [selectedFolder, loadThreads]);

  const items = useMemo(() => buildItems(threads), [threads]);

  const scrollRef = useRef<HTMLDivElement>(null);
  // TanStack Virtual returns mutable function references that React Compiler
  // cannot safely memoize. Suppress the compiler warning here; the virtualizer
  // is used locally and its outputs are not memoized downstream.
  // eslint-disable-next-line react-hooks/incompatible-library
  const virtualizer = useVirtualizer({
    count: items.length,
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
    items,
    accountId: selectedFolder?.accountId ?? null,
  });

  // Infinite scroll: when the user nears the end, fetch the next cursor page.
  // Depend on a stable `nearEnd` boolean rather than the virtualItems array
  // (a new array reference on every measure pass), so the effect doesn't
  // re-run on every scroll tick.
  const virtualItems = virtualizer.getVirtualItems();
  const nearEnd = items.length > 0 && (virtualItems.at(-1)?.index ?? -1) >= items.length - 6;
  useEffect(() => {
    if (nearEnd && cursor && !isLoading) {
      void loadMore();
    }
  }, [nearEnd, cursor, isLoading, loadMore]);

  const handleDoubleClick = async (thread: Thread) => {
    await selectThread(thread);
    const msg = useViewStore.getState().selectedMessage;
    if (msg) openViewerWindow(msg);
  };

  const [menu, setMenu] = useState<{ thread: Thread; x: number; y: number } | null>(null);
  const [moveMenu, setMoveMenu] = useState<{ thread: Thread; x: number; y: number } | null>(null);
  useAutoHideScrollbar(scrollRef);

  const showEmpty = !isLoading && items.length === 0;

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
      { label: 'Archive', icon: ArchiveIcon, disabled: true },
    ];
  }, [menu, accounts, defaultReplyBehavior, markThreadRead, toggleThreadStarred, deleteThread]);

  return (
    <div className="message-list flex flex-col h-full bg-[var(--card)]">
      {visibleColumns.length > 0 && (
        <div
          className="flex items-center gap-1 px-1 py-1.5 border-b border-[var(--border)] text-[11px] font-semibold uppercase tracking-wide text-[var(--muted-text)]"
          aria-rowcount={items.length}
        >
          {visibleColumns.map((col) => (
            <span
              key={col.id}
              className={`message-list-col-${col.id} truncate`}
              style={cellWidth(col)}
            >
              {col.label}
            </span>
          ))}
        </div>
      )}

      {conversationView && (
        <div className="px-3 py-1 text-[11px] text-[var(--foreground)] bg-[var(--selected)]">
          Conversation view enabled
        </div>
      )}

      <div
        ref={scrollRef}
        tabIndex={0}
        className={`flex-1 overflow-auto outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[var(--ring)] ${autoHideScrollbarClass}`}
        onKeyDown={(e) => {
          if (e.key !== 'ArrowUp' && e.key !== 'ArrowDown') return;
          e.preventDefault();
          const direction = e.key === 'ArrowDown' ? 1 : -1;
          const currentIndex = items.findIndex(
            (i) => i.kind === 'thread' && i.thread.id === selectedThreadId,
          );
          function nextThreadIndex(start: number, dir: 1 | -1): number | null {
            let i = start + dir;
            while (i >= 0 && i < items.length) {
              if (items[i]?.kind === 'thread') return i;
              i += dir;
            }
            return null;
          }
          const nextIndex =
            currentIndex === -1
              ? nextThreadIndex(direction === 1 ? -1 : items.length, direction)
              : nextThreadIndex(currentIndex, direction);
          if (nextIndex == null) return;
          const nextItem = items[nextIndex];
          if (!nextItem || nextItem.kind !== 'thread') return;
          void selectThread(nextItem.thread);
          virtualizer.scrollToIndex(nextIndex, { align: 'auto' });
        }}
      >
        {isLoading && items.length === 0 ? (
          <div className="flex flex-col items-center justify-center gap-2 px-3 py-10 text-center text-xs text-[var(--muted-text)]">
            <MailIcon size={24} className="opacity-50" />
            <span>Loading messages…</span>
          </div>
        ) : showEmpty ? (
          <div className="flex flex-col items-center justify-center gap-2 px-3 py-10 text-center text-xs text-[var(--muted-text)]">
            <MailIcon size={24} className="opacity-50" />
            <span>No messages in this folder.</span>
            <span className="text-[10px] opacity-70">
              Select a different folder or check back later.
            </span>
          </div>
        ) : (
          <div
            role="list"
            aria-rowcount={items.length}
            style={{ height: virtualizer.getTotalSize(), position: 'relative' }}
          >
            {virtualItems.map((vi) => {
              const item = items[vi.index];
              if (!item) return null;
              return (
                <div
                  key={vi.key}
                  data-index={vi.index}
                  aria-rowindex={vi.index + 1}
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
                    <div className="py-1.5 px-3 border-b border-[var(--border)] font-bold uppercase tracking-[0.04em] text-[var(--muted-text)] text-[11px]">
                      {item.label}
                    </div>
                  ) : (
                    <MessageRow
                      thread={item.thread}
                      selected={selectedThreadId === item.thread.id}
                      density={density}
                      onClick={() => void selectThread(item.thread)}
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
