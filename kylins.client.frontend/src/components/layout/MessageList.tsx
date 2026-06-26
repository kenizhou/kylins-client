import { useEffect, useMemo, useRef } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import { useViewStore } from '../../features/view/viewStore';
import { COLUMN_REGISTRY } from '../../features/view/defaults';
import type { ColumnDef } from '../../features/view/types';
import { useThreadStore } from '../../stores/threadStore';
import { useFolderStore } from '../../stores/folderStore';
import type { Thread } from '../../services/db/threads';
import { getInitials, formatMessageTime } from '../../data/demoMessages';
import { openViewerWindow } from '../../utils/viewerWindow';
import { useClassification } from '../../features/classification/useClassification';
import { useSecurityIndicatorIcons } from '../../features/classification/useSecurityIndicatorIcons';
import { ClassificationIcon } from '../icons';

type MessageState = 'unread' | 'read' | 'flagged' | 'vip';

interface MessageRowProps {
  sender: string;
  subject: string;
  time: string;
  initials: string;
  state: MessageState;
  selected?: boolean;
  density: 'compact' | 'normal' | 'comfortable';
  classificationId: string | null;
  isEncrypted: boolean;
  isSigned: boolean;
  onClick?: () => void;
  onDoubleClick?: () => void;
}

const RIBBON_COLOR: Record<MessageState, string> = {
  unread: 'bg-[var(--primary)]',
  read: 'bg-[var(--border)]',
  flagged: 'bg-[var(--amber)]',
  vip: 'bg-[var(--green)]',
};

const DENSITY_ROW_CLASSES = {
  compact: 'min-h-[32px] py-1',
  normal: 'min-h-[40px] py-2',
  comfortable: 'min-h-[52px] py-3',
};

function MessageRow({
  sender,
  subject,
  time,
  initials,
  state,
  selected,
  density,
  classificationId,
  isEncrypted,
  isSigned,
  onClick,
  onDoubleClick,
}: MessageRowProps) {
  const unread = state === 'unread';
  const { getLevelById } = useClassification();
  const { encryptedIcon, signedIcon } = useSecurityIndicatorIcons();
  const level = getLevelById(classificationId);
  const showSecurity = isEncrypted || isSigned;
  return (
    <div
      role="button"
      tabIndex={0}
      onClick={onClick}
      onDoubleClick={onDoubleClick}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onClick?.();
        }
      }}
      className={`
        flex items-stretch gap-2.5 pr-3 pl-0 cursor-pointer
        ${DENSITY_ROW_CLASSES[density]}
        ${selected ? 'bg-[var(--selected)]' : 'hover:bg-[var(--hover)]'}
      `}
    >
      <div className={`w-[var(--radius-xs)] rounded-r-[var(--radius-xs)] ${RIBBON_COLOR[state]}`} />
      <div className="w-7 h-7 rounded-full bg-[var(--border)] grid place-items-center text-[10px] font-bold text-[var(--muted-text)] shrink-0">
        {initials}
      </div>
      <div className="flex-1 min-w-0 flex flex-col gap-[3px]">
        <div className="flex items-baseline justify-between gap-2 min-w-0">
          <span
            className={`text-[13px] truncate ${unread ? 'font-semibold text-[var(--text)]' : 'text-[var(--muted-text)]'}`}
          >
            {level && (
              <span className="inline-flex items-center gap-1 mr-1.5 align-[-2px]">
                <ClassificationIcon
                  icon={level.icon}
                  size={12}
                  className="shrink-0"
                  style={{ color: level.color }}
                />
                {!level.icon && (
                  <span
                    className="inline-block h-2 w-2 rounded-full shrink-0"
                    style={{ backgroundColor: level.color }}
                  />
                )}
              </span>
            )}
            {sender}
          </span>
          <span className="flex items-center gap-1 shrink-0">
            {showSecurity && (
              <span className="inline-flex items-center gap-0.5 text-[var(--muted-text)]">
                {isEncrypted && (
                  <span title="Encrypted" aria-label="Encrypted">
                    <ClassificationIcon icon={encryptedIcon} size={12} />
                  </span>
                )}
                {isSigned && (
                  <span title="Signed" aria-label="Signed">
                    <ClassificationIcon icon={signedIcon} size={12} />
                  </span>
                )}
              </span>
            )}
            <span className="text-[11px] font-mono text-[var(--muted-text)]">{time}</span>
          </span>
        </div>
        <span
          className={`text-[13px] truncate ${unread ? 'font-semibold text-[var(--text)]' : 'text-[var(--muted-text)]'}`}
        >
          {subject}
        </span>
      </div>
    </div>
  );
}

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

function threadState(t: Thread): MessageState {
  if (!t.isRead) return 'unread';
  if (t.isStarred) return 'flagged';
  if (t.isImportant) return 'vip';
  return 'read';
}

export function MessageList() {
  const density = useViewStore((s) => s.messageListDensity);
  const visibleColumnIds = useViewStore((s) => s.visibleColumnIds);
  const conversationView = useViewStore((s) => s.conversationView);

  const selectedFolder = useFolderStore((s) => s.selected);
  const threads = useThreadStore((s) => s.threads);
  const selectedThreadId = useThreadStore((s) => s.selectedThreadId);
  const isLoading = useThreadStore((s) => s.isLoading);
  const cursor = useThreadStore((s) => s.cursor);
  const loadThreads = useThreadStore((s) => s.loadThreads);
  const loadMore = useThreadStore((s) => s.loadMore);
  const selectThread = useThreadStore((s) => s.selectThread);

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
  const virtualizer = useVirtualizer({
    count: items.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => 44,
    overscan: 12,
  });

  // Infinite scroll: when the user nears the end, fetch the next cursor page.
  // Depend on a stable `nearEnd` boolean rather than the virtualItems array
  // (a new array reference on every measure pass), so the effect doesn't
  // re-run on every scroll tick.
  const virtualItems = virtualizer.getVirtualItems();
  const nearEnd = (virtualItems.at(-1)?.index ?? -1) >= items.length - 6;
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

  const showEmpty = !isLoading && items.length === 0;

  return (
    <div className="flex flex-col h-full bg-[var(--card)]">
      {visibleColumns.length > 0 && (
        <div className="flex items-center gap-2 px-3 py-1.5 border-b border-[var(--border)] text-[11px] font-semibold uppercase tracking-wide text-[var(--muted-text)]">
          {visibleColumns.map((col) => (
            <span key={col.id} className="truncate" style={{ width: col.width }}>
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

      <div ref={scrollRef} className="flex-1 overflow-auto">
        {isLoading && items.length === 0 ? (
          <div className="px-3 py-6 text-center text-xs text-[var(--muted-text)]">Loading…</div>
        ) : showEmpty ? (
          <div className="px-3 py-6 text-center text-xs text-[var(--muted-text)]">
            No messages in this folder.
          </div>
        ) : (
          <div style={{ height: virtualizer.getTotalSize(), position: 'relative' }}>
            {virtualItems.map((vi) => {
              const item = items[vi.index];
              if (!item) return null;
              return (
                <div
                  key={vi.key}
                  data-index={vi.index}
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
                    <div className="py-1.5 px-3 border-b border-[var(--border)] font-[var(--text-overline)] uppercase tracking-[0.04em] text-[var(--muted-text)] text-[11px]">
                      {item.label}
                    </div>
                  ) : (
                    <MessageRow
                      sender={item.thread.fromName ?? item.thread.fromAddress ?? 'Unknown'}
                      subject={item.thread.subject ?? '(no subject)'}
                      time={
                        item.thread.lastMessageAt != null
                          ? formatMessageTime(
                              new Date(item.thread.lastMessageAt * 1000).toISOString(),
                            )
                          : ''
                      }
                      initials={getInitials(item.thread.fromName ?? item.thread.fromAddress ?? '?')}
                      state={threadState(item.thread)}
                      selected={selectedThreadId === item.thread.id}
                      density={density}
                      classificationId={item.thread.classificationId}
                      isEncrypted={item.thread.isEncrypted}
                      isSigned={item.thread.isSigned}
                      onClick={() => void selectThread(item.thread)}
                      onDoubleClick={() => void handleDoubleClick(item.thread)}
                    />
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
