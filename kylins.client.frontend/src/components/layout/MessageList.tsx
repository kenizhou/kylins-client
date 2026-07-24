import { useEffect, useMemo, useRef, useState, memo } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import { Button } from 'react-aria-components';
import { useViewStore } from '../../features/view/viewStore';
import { COLUMN_REGISTRY } from '../../features/view/defaults';
import type { ColumnDef } from '../../features/view/types';
import { useThreadStore } from '../../stores/threadStore';
import { useFolderStore } from '../../stores/folderStore';
import { useAccountStore } from '../../stores/accountStore';
import { useInlineComposerStore, anchorMessage } from '../../stores/inlineComposerStore';
import { useDraftIndexStore } from '../../stores/draftIndexStore';
import { usePreferencesStore } from '../../stores/preferencesStore';
import { useViewportBodyPrefetch } from '../../hooks/useViewportBodyPrefetch';
import { useAutoHideScrollbar } from '../../hooks/useAutoHideScrollbar';
import type { Thread } from '../../services/db/threads';
import { DRAFTS_CHANGED_EVENT, type DbDraft } from '../../services/composer/drafts';
import { listDraftsForAccount } from '../../services/composer/drafts';
import {
  deleteLocalDraft,
  draftToThread,
  openDraftInWindow,
} from '../../features/drafts/localDrafts';
import { resumeDraftInline, type DraftAccountInfo } from '../../features/drafts/resumeDraft';
import { formatMessageTime } from '../../data/demoMessages';
import { openViewerWindow } from '../../utils/viewerWindow';
import { useClassification } from '../../features/classification/useClassification';
import { isProminent, levelStyle } from '../../features/classification/classificationStyle';
import { ClassificationBadge } from '../../features/classification/components/ClassificationBadge';
import { SecurityChips } from '../../features/classification/components/SecurityChips';
import {
  MailIcon,
  ExternalLinkIcon,
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
import { archiveThread, archiveThreads, trashThread } from '../../services/mail/actions';

type MessageState = 'unread' | 'read' | 'flagged' | 'vip';

interface MessageRowProps {
  thread: Thread;
  selected?: boolean;
  density: 'compact' | 'normal' | 'comfortable';
  visibleColumns: ColumnDef[];
  /** Saved local draft row (Drafts folder): [Draft] chip, no thread actions. */
  isLocalDraft?: boolean;
  onClick?: (e: React.MouseEvent) => void;
  onDoubleClick?: () => void;
  onContextMenu?: (e: React.MouseEvent) => void;
}

function optionId(threadId: string): string {
  return `message-option-${threadId}`;
}

const RIBBON_COLOR: Record<MessageState, string> = {
  unread: 'bg-primary',
  read: 'group-hover:bg-[var(--series-300)]',
  flagged: 'group-hover:bg-[var(--series-300)]',
  vip: 'bg-[var(--green)]',
};

/** Right half of the bar: fills with the SAME color as the left half on bar hover. */
const RIBBON_HOVER_COLOR: Record<MessageState, string> = {
  unread: 'group-hover/bar:bg-primary',
  read: 'group-hover/bar:bg-[var(--series-300)]',
  flagged: 'group-hover/bar:bg-[var(--series-300)]',
  vip: 'group-hover/bar:bg-[var(--green)]',
};

const DENSITY_ROW_CLASSES = {
  compact: 'min-h-11',
  normal: 'min-h-12',
  comfortable: 'min-h-14',
};

const DENSITY_CONTENT_CLASSES = {
  compact: 'py-1 space-y-0.5',
  normal: 'py-2 space-y-[3px]',
  comfortable: 'py-3.5 space-y-1',
};

interface QuickActionsProps {
  thread: Thread;
  visible: boolean;
}

function MessageRowQuickActions({ thread, visible }: QuickActionsProps) {
  return (
    <span
      data-testid="message-quick-actions"
      className={`shrink-0 items-center gap-0.5 group-focus-within:flex ${visible ? 'flex' : 'hidden'}`}
      onClick={(e) => e.stopPropagation()}
    >
      <Button
        type="button"
        aria-label="Archive"
        className="inline-flex h-6 w-6 items-center justify-center rounded-md text-[var(--muted-text)] hover:bg-[var(--primary-subtle)] hover:text-[var(--foreground)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ring)]"
        onPress={() => void archiveThread(thread)}
      >
        {/* RAC Button strips `title`; keep the tooltip on the icon wrapper. */}
        <span title="Archive" className="inline-flex items-center justify-center">
          <ArchiveIcon size={14} />
        </span>
      </Button>
      <Button
        type="button"
        aria-label="Delete"
        className="inline-flex h-6 w-6 items-center justify-center rounded-md text-[var(--muted-text)] hover:bg-[var(--primary-subtle)] hover:text-[var(--destructive)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ring)]"
        onPress={() => void trashThread(thread)}
      >
        <span title="Delete" className="inline-flex items-center justify-center">
          <DeleteIcon size={14} />
        </span>
      </Button>
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
  isLocalDraft = false,
  ...handlers
}: MessageRowProps) {
  const { getLevelById } = useClassification();
  const level = getLevelById(thread.classificationId);
  const prominent = level ? isProminent(level) : false;
  const [isHovered, setIsHovered] = useState(false);
  const toggleThreadStarred = useThreadStore((s) => s.toggleThreadStarred);
  const markThreadRead = useThreadStore((s) => s.markThreadRead);

  const sender = thread.fromName ?? thread.fromAddress ?? 'Unknown';
  const unread = !thread.isRead;
  // A retained inline-composer session for this conversation (docked reply /
  // forward the user navigated away from) surfaces as Outlook/Gmail's red
  // "[Draft]" chip next to the sender. The selector returns a boolean, so the
  // memoized row only re-renders when the draft state actually flips. Saved
  // local drafts carry the same chip — via isLocalDraft on Drafts-folder rows,
  // and via the draft index on conversation rows (survives app reloads).
  const hasInlineDraft = useInlineComposerStore(
    (s) => anchorMessage(s.session)?.threadId === thread.id,
  );
  const hasSavedDraft = useDraftIndexStore((s) => s.threadIds.has(thread.id));
  const showDraftChip = isLocalDraft || hasInlineDraft || hasSavedDraft;
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
      className={`group relative ${DENSITY_ROW_CLASSES[density]} ${prominent && !selected ? 'bg-[var(--row-tint)]' : ''} ${selected ? 'bg-[var(--primary-muted)]' : 'hover:bg-[var(--primary-subtle)]'}`}
    >
      <div className="flex items-stretch pr-1">
        {/* Left state ribbon — double-width static hit area: the left half
            carries the state color, the right half stays transparent and
            fills with primary on bar hover. Click toggles read/unread.
            Draft rows have no read state: the ribbon is display-only. */}
        <button
          type="button"
          aria-label={unread ? 'Mark as read' : 'Mark as unread'}
          aria-hidden={isLocalDraft || undefined}
          tabIndex={isLocalDraft ? -1 : undefined}
          onClick={(e) => {
            e.stopPropagation();
            if (isLocalDraft) return;
            void markThreadRead(thread, !thread.isRead);
          }}
          className="group/bar relative z-10 my-[0.5px] flex w-2 shrink-0 cursor-pointer self-stretch"
          style={
            prominent && level
              ? ({ '--bar-prominent': level.color } as React.CSSProperties)
              : undefined
          }
        >
          <span
            className={`w-1 ${prominent ? 'bg-[var(--bar-prominent)]' : RIBBON_COLOR[unread ? 'unread' : thread.isStarred ? 'flagged' : thread.isImportant ? 'vip' : 'read']}`}
          />
          <span
            className={`w-1 transition-colors duration-fast ${prominent ? 'group-hover/bar:bg-[var(--bar-prominent)]' : RIBBON_HOVER_COLOR[unread ? 'unread' : thread.isStarred ? 'flagged' : thread.isImportant ? 'vip' : 'read']}`}
          />
        </button>

        {/* Main content column: sender / subject / preview + time */}
        <div className={`flex-1 min-w-0 px-4 ${DENSITY_CONTENT_CLASSES[density]}`}>
          {/* h-6 pins the sender line so hover-revealed quick actions (h-6)
              never stretch the row — prevents the 4px hover jitter. */}
          <div className="flex h-6 items-center justify-between gap-2">
            <div className="flex min-w-0 items-center gap-2">
              <span className={`truncate text-[var(--text)] ${unread ? 'font-semibold' : ''}`}>
                {sender}
              </span>
              {showDraftChip && (
                <span
                  className="shrink-0 text-xs font-medium text-[var(--destructive)]"
                  title={
                    isLocalDraft
                      ? 'Saved draft — click to resume editing'
                      : 'Unsent draft for this conversation'
                  }
                >
                  [Draft]
                </span>
              )}
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
            <span className="flex shrink-0 items-center gap-2">
              {!isLocalDraft && <MessageRowQuickActions thread={thread} visible={isHovered} />}
              <span className="text-[11px] tabular-nums text-[var(--muted-text)]">
                {thread.lastMessageAt != null
                  ? formatMessageTime(new Date(thread.lastMessageAt * 1000).toISOString())
                  : ''}
              </span>
            </span>
          </div>
          <div className={`truncate text-[var(--text)] ${unread ? 'font-semibold' : ''}`}>
            {thread.subject ?? '(no subject)'}
          </div>
          {thread.snippet && (
            <div className="truncate text-[12px] text-[var(--muted-text)]">{thread.snippet}</div>
          )}
        </div>

        {/* Right metadata indicators */}
        <div className="flex shrink-0 flex-col items-end justify-center gap-1 pr-2">
          {showFlag && !isLocalDraft && (
            <button
              type="button"
              title={thread.isStarred ? 'Unflag' : 'Flag'}
              aria-label={thread.isStarred ? 'Flagged' : 'Flag'}
              className={`inline-flex h-6 w-6 items-center justify-center rounded-md transition-colors hover:bg-[var(--primary-subtle)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ring)] ${
                // Always mounted (visibility-toggled) so a hover-revealed flag
                // never changes the row height.
                thread.isStarred || isHovered ? '' : 'invisible'
              } ${
                thread.isStarred
                  ? 'text-[var(--amber)]'
                  : 'text-[var(--muted-text)] hover:text-[var(--amber)]'
              }`}
              onClick={(e) => {
                e.stopPropagation();
                void toggleThreadStarred(thread);
              }}
            >
              <FlagIcon size={14} />
            </button>
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
    </div>
  );
});

type ListItem =
  | { kind: 'group'; label: string }
  | { kind: 'thread'; thread: Thread }
  | { kind: 'draft'; draft: DbDraft };

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

  // Saved local drafts surfaced in the Drafts folder (local-first drafts —
  // services/composer/drafts.ts). Reloaded whenever the drafts service fires
  // DRAFTS_CHANGED_EVENT (autosave, manual save, delete, send cleanup), so a
  // draft appears in the list as soon as it is saved. Rows are only rendered
  // while a drafts-role folder is selected; stale state is harmless otherwise.
  const isDraftsFolder = selectedRole === 'drafts';
  const [localDrafts, setLocalDrafts] = useState<DbDraft[]>([]);

  // Keep the saved-draft thread index fresh: it drives the [Draft] chips on
  // conversation rows (persisted drafts — survives app reloads, unlike the
  // in-memory inline session). Refreshes on account switch and on every
  // drafts-service change event (autosave / save / delete / send cleanup).
  const activeAccountId = useAccountStore((s) => s.activeAccountId);
  const refreshDraftIndex = useDraftIndexStore((s) => s.refresh);
  useEffect(() => {
    if (!activeAccountId) return;
    void refreshDraftIndex(activeAccountId);
    const onChanged = () => void refreshDraftIndex(activeAccountId);
    window.addEventListener(DRAFTS_CHANGED_EVENT, onChanged);
    return () => window.removeEventListener(DRAFTS_CHANGED_EVENT, onChanged);
  }, [activeAccountId, refreshDraftIndex]);

  useEffect(() => {
    if (!isDraftsFolder || !selectedFolder) return;
    const accountId = selectedFolder.accountId;
    let cancelled = false;
    const load = () => {
      listDraftsForAccount(accountId)
        .then((rows) => {
          if (!cancelled) setLocalDrafts(rows);
        })
        .catch((e) => console.error('[message-list] listDraftsForAccount failed', e));
    };
    load();
    window.addEventListener(DRAFTS_CHANGED_EVENT, load);
    return () => {
      cancelled = true;
      window.removeEventListener(DRAFTS_CHANGED_EVENT, load);
    };
  }, [isDraftsFolder, selectedFolder]);

  useEffect(() => {
    setInboxTab('all');
  }, [selectedFolder?.labelId]);

  const threads = useThreadStore((s) => s.threads);
  const selectedThreadId = useThreadStore((s) => s.selectedThreadId);
  const selectedThreadIds = useThreadStore((s) => s.selectedThreadIds);
  const selectionAnchorId = useThreadStore((s) => s.selectionAnchorId);
  const isLoading = useThreadStore((s) => s.isLoading);
  const cursor = useThreadStore((s) => s.cursor);
  const accounts = useAccountStore((s) => s.accounts);
  const loadThreads = useThreadStore((s) => s.loadThreads);
  const loadMore = useThreadStore((s) => s.loadMore);
  const selectThread = useThreadStore((s) => s.selectThread);
  const setSelection = useThreadStore((s) => s.setSelection);
  const markThreadsRead = useThreadStore((s) => s.markThreadsRead);
  const setThreadsStarred = useThreadStore((s) => s.setThreadsStarred);
  const deleteThreads = useThreadStore((s) => s.deleteThreads);
  const moveThreads = useThreadStore((s) => s.moveThreads);

  // Draft-row highlight state: the standalone-row selection and the draft the
  // live dock session is editing (covers reply-anchored resumes, where the
  // reading-pane target is the message rather than the draft row).
  const selectedDraftId = useViewStore((s) => s.selectedDraftId);
  const liveDraftId = useInlineComposerStore((s) => s.session?.draftId ?? null);

  /** Resolve the account a draft belongs to (fallback: active, then a bare
   *  id shell so resume never crashes on a stale account reference). */
  const draftAccount = (draft: DbDraft): DraftAccountInfo => {
    const found = accounts.find((a) => a.id === draft.account_id);
    if (found) return { id: found.id, email: found.email, displayName: found.displayName };
    const active = accounts.find((a) => a.id === activeAccountId);
    if (active) return { id: active.id, email: active.email, displayName: active.displayName };
    return { id: draft.account_id, email: '', displayName: null };
  };

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

  const items = useMemo(() => {
    const threadItems = buildItems(threads);
    // Drafts folder: saved local drafts first (newest save first — the
    // backend query already orders by updated_at DESC), then any server-side
    // drafts that synced down as regular threads.
    if (!isDraftsFolder || localDrafts.length === 0) return threadItems;
    return [...localDrafts.map((d): ListItem => ({ kind: 'draft', draft: d })), ...threadItems];
  }, [threads, isDraftsFolder, localDrafts]);

  const filteredItems = useMemo(() => {
    if (!isInbox || inboxTab === 'all') return items;
    const result: ListItem[] = [];
    let pendingGroup: ListItem | null = null;
    for (const item of items) {
      if (item.kind === 'group') {
        pendingGroup = item;
        continue;
      }
      // Draft rows only exist in the Drafts folder (never the inbox), but the
      // filter must still skip them — they have no read state.
      if (item.kind === 'draft') continue;
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

  const selectedIdSet = useMemo(() => new Set(selectedThreadIds), [selectedThreadIds]);

  // Thread-id range between two rows over the FILTERED list, skipping group
  // headers. Falls back to just the target when either end scrolled out of
  // the loaded pages.
  const rangeIds = (fromId: string, toId: string): string[] => {
    const idxOf = (id: string) =>
      filteredItems.findIndex((it) => it.kind === 'thread' && it.thread.id === id);
    const a = idxOf(fromId);
    const b = idxOf(toId);
    if (a === -1 || b === -1) return [toId];
    const [lo, hi] = a < b ? [a, b] : [b, a];
    return filteredItems
      .slice(lo, hi + 1)
      .flatMap((it) => (it.kind === 'thread' ? [it.thread.id] : []));
  };

  const handleRowClick = (t: Thread, e: React.MouseEvent) => {
    setActiveDescendantId(optionId(t.id));
    if (e.shiftKey && selectionAnchorId) {
      void setSelection(rangeIds(selectionAnchorId, t.id), selectionAnchorId);
      return;
    }
    if (e.ctrlKey || e.metaKey) {
      const next = new Set(selectedThreadIds);
      let nextAnchor = selectionAnchorId;
      if (next.has(t.id)) {
        next.delete(t.id);
        if (nextAnchor === t.id) nextAnchor = [...next].at(-1) ?? null;
      } else {
        next.add(t.id);
        nextAnchor = t.id;
      }
      void setSelection([...next], nextAnchor);
      return;
    }
    void selectThread(t);
  };

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

  const [menu, setMenu] = useState<{
    thread: Thread;
    targets: Thread[];
    x: number;
    y: number;
  } | null>(null);
  const [moveMenu, setMoveMenu] = useState<{ threads: Thread[]; x: number; y: number } | null>(
    null,
  );
  const [draftMenu, setDraftMenu] = useState<{ draft: DbDraft; x: number; y: number } | null>(null);
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
    setActiveDescendantId(optionId(thread.id));
    // Outlook behavior: right-click on a row inside a multi-selection targets
    // the whole selection; right-click elsewhere collapses to that row first.
    const keepSelection = selectedIdSet.has(thread.id) && selectedThreadIds.length > 1;
    if (!keepSelection) {
      void selectThread(thread);
    }
    const targets = keepSelection ? threads.filter((t) => selectedIdSet.has(t.id)) : [thread];
    setMenu({ thread, targets, x: e.clientX, y: e.clientY });
  };

  const menuItems = useMemo(() => {
    if (!menu) return [];
    const { thread: clicked, targets } = menu;
    const n = targets.length;
    const multi = n > 1;
    const account = accounts.find((a) => a.id === clicked.accountId) ?? null;
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
          void openComposerForThread(clicked, replyMode, account);
        },
      },
      {
        label: 'Reply All',
        icon: ReplyAllIcon,
        onSelect: () => {
          if (!account) return;
          void openComposerForThread(clicked, 'replyAll', account);
        },
      },
      {
        label: 'Forward',
        icon: MailSendIcon,
        onSelect: () => {
          if (!account) return;
          void openComposerForThread(clicked, 'forward', account);
        },
      },
      {
        label: multi
          ? clicked.isRead
            ? `Mark ${n} as Unread`
            : `Mark ${n} as Read`
          : clicked.isRead
            ? 'Mark as Unread'
            : 'Mark as Read',
        icon: MailIcon,
        onSelect: () => void markThreadsRead(targets, !clicked.isRead),
      },
      { separator: true },
      { label: 'Categorize', icon: TagIcon, disabled: true },
      {
        label: multi
          ? clicked.isStarred
            ? `Clear follow up on ${n} conversations`
            : `Follow up ${n} conversations`
          : clicked.isStarred
            ? 'Clear Follow Up'
            : 'Follow Up',
        icon: FlagIcon,
        onSelect: () => void setThreadsStarred(targets, !clicked.isStarred),
      },
      { label: 'Find Related', icon: SearchIcon, disabled: true },
      { label: 'Rules', icon: PreferencesMailRulesIcon, disabled: true },
      { separator: true },
      {
        label: multi ? `Move ${n} conversations…` : 'Move',
        icon: MoveIcon,
        onSelect: () => setMoveMenu({ threads: targets, x: menu.x, y: menu.y }),
      },
      { label: 'Junk', icon: BellIcon, disabled: true },
      {
        label: multi ? `Delete ${n} conversations` : 'Delete',
        icon: TrashIcon,
        danger: true,
        onSelect: () => void deleteThreads(targets),
      },
      {
        label: multi ? `Archive ${n} conversations` : 'Archive',
        icon: ArchiveIcon,
        onSelect: () => void archiveThreads(targets),
      },
    ];
  }, [
    menu,
    accounts,
    defaultReplyBehavior,
    markThreadsRead,
    setThreadsStarred,
    deleteThreads,
    archiveThreads,
  ]);

  return (
    <div className="message-list flex flex-col h-full border-r border-[var(--border-subtle)]">
      {conversationView && (
        <div className="px-3 py-1 text-[11px] text-[var(--foreground)] bg-[var(--primary-muted)]">
          Conversation view enabled
        </div>
      )}

      {isInbox && (
        <div
          role="tablist"
          aria-label="Inbox view"
          className="flex items-center gap-1 border-b border-[var(--border-subtle)] px-3 py-1.5"
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
        aria-multiselectable="true"
        aria-busy={isLoading && filteredItems.length === 0 ? true : undefined}
        aria-activedescendant={activeDescendantId ?? undefined}
        className={`flex-1 flex flex-col overflow-auto outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[var(--ring)] ${scrollbarClass}`}
        onKeyDown={(e) => {
          // Ctrl/Cmd+A — select every loaded thread (group headers excluded).
          if ((e.ctrlKey || e.metaKey) && (e.key === 'a' || e.key === 'A')) {
            e.preventDefault();
            const allIds = filteredItems.flatMap((it) =>
              it.kind === 'thread' ? [it.thread.id] : [],
            );
            if (allIds.length === 0) return;
            const anchor =
              selectionAnchorId && allIds.includes(selectionAnchorId)
                ? selectionAnchorId
                : allIds[0]!;
            setActiveDescendantId(optionId(anchor));
            void setSelection(allIds, anchor);
            return;
          }

          if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
            e.preventDefault();
            const direction = e.key === 'ArrowDown' ? 1 : -1;
            // In shift mode the moving edge is the active descendant when it
            // is part of the selection; otherwise the anchor. This lets a
            // range grow AND shrink around a fixed anchor.
            const edgeId = activeDescendantId?.replace(/^message-option-/, '') ?? null;
            const baseId =
              e.shiftKey && edgeId && selectedIdSet.has(edgeId) ? edgeId : selectedThreadId;
            const currentIndex = filteredItems.findIndex(
              (i) => i.kind === 'thread' && i.thread.id === baseId,
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
            if (e.shiftKey && selectionAnchorId) {
              void setSelection(rangeIds(selectionAnchorId, nextItem.thread.id), selectionAnchorId);
            } else {
              void selectThread(nextItem.thread);
            }
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
                      className="py-1.5 px-3 border-b border-[var(--border-subtle)] type-overline text-[var(--muted-text)]"
                    >
                      {item.label}
                    </div>
                  ) : item.kind === 'draft' ? (
                    <MessageRow
                      thread={draftToThread(item.draft)}
                      isLocalDraft
                      // Highlight while the draft is the reading-pane target —
                      // either the selected standalone draft row or the draft
                      // the live dock session is editing.
                      selected={selectedDraftId === item.draft.id || liveDraftId === item.draft.id}
                      density={density}
                      visibleColumns={visibleColumns}
                      // Single click: resume in the reading pane (composing mode).
                      onClick={() => void resumeDraftInline(item.draft, draftAccount(item.draft))}
                      // Double click: open in the OS composer window.
                      onDoubleClick={() => openDraftInWindow(item.draft)}
                      onContextMenu={(e) => {
                        e.preventDefault();
                        setDraftMenu({ draft: item.draft, x: e.clientX, y: e.clientY });
                      }}
                    />
                  ) : (
                    <MessageRow
                      thread={item.thread}
                      selected={selectedIdSet.has(item.thread.id)}
                      density={density}
                      visibleColumns={visibleColumns}
                      onClick={(e) => handleRowClick(item.thread, e)}
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
      {draftMenu && (
        <ContextMenu
          x={draftMenu.x}
          y={draftMenu.y}
          items={[
            {
              label: 'Open',
              icon: MailIcon,
              onSelect: () =>
                void resumeDraftInline(draftMenu.draft, draftAccount(draftMenu.draft)),
            },
            {
              label: 'Open in New Window',
              icon: ExternalLinkIcon,
              onSelect: () => openDraftInWindow(draftMenu.draft),
            },
            {
              label: 'Delete Draft',
              icon: TrashIcon,
              danger: true,
              onSelect: () => {
                // If the draft is live in the dock, drop that session FIRST —
                // otherwise its next autosave would resurrect the deleted row.
                const session = useInlineComposerStore.getState().session;
                if (session?.draftId === draftMenu.draft.id) {
                  useInlineComposerStore.getState().discard({ skipConfirm: true });
                }
                if (useViewStore.getState().selectedDraftId === draftMenu.draft.id) {
                  // Clears the draft-row selection (the row is going away).
                  useViewStore.getState().setSelectedMessage(null);
                }
                void deleteLocalDraft(draftMenu.draft);
              },
            },
          ]}
          onClose={() => setDraftMenu(null)}
        />
      )}
      {moveMenu && (
        <FolderPickerMenu
          accountId={moveMenu.threads[0]?.accountId ?? ''}
          excludeLabelId={selectedFolder?.labelId}
          style={{ position: 'fixed', left: moveMenu.x, top: moveMenu.y, zIndex: 80 }}
          onSelect={(folder: MailFolder) => {
            void moveThreads(moveMenu.threads, folder.id, folder.remoteId ?? folder.name);
            setMoveMenu(null);
          }}
          onClose={() => setMoveMenu(null)}
        />
      )}
    </div>
  );
}
