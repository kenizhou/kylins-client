// Thread list state: keyset-paginated loading per selected folder, selection that
// bridges into viewStore.selectedMessage (so ReadingPane / viewer work unchanged),
// and mark-as-read on open. Bodies are lazy-fetched on selection.

import { create } from 'zustand';
import { invoke } from '@tauri-apps/api/core';
import {
  getThreads,
  getMessagesForThread,
  mapMessageToMailMessage,
  type Thread,
  type ThreadCursor,
  type DbMessageRow,
} from '../services/db/threads';
import { getMessageBody } from '../services/db/messageBodies';
import { useViewStore } from '../features/view/viewStore';
import { useFolderStore } from './folderStore';

async function getThreadMessages(
  thread: Thread,
  messages?: DbMessageRow[],
): Promise<DbMessageRow[]> {
  return messages ?? (await getMessagesForThread(thread.accountId, thread.id));
}

interface ThreadQuery {
  accountId: string;
  labelId: string | null;
}

interface ThreadState {
  threads: Thread[];
  selectedThreadId: string | null;
  isLoading: boolean;
  /** Cursor for the next page (null = no more). */
  cursor: ThreadCursor | null;
  currentQuery: ThreadQuery | null;

  loadThreads: (accountId: string, labelId: string | null) => Promise<void>;
  loadMore: () => Promise<void>;
  selectThread: (thread: Thread) => Promise<void>;
  refresh: () => Promise<void>;

  /**
   * Patch `snippet` on threads already loaded in `state.threads`, in place.
   * Scroll-preserving: unpatched thread objects keep their `===` reference so a
   * virtualized list (react-virtualized #1837) does not invalidate measured row
   * sizes. Only matching rows are replaced with `{ ...t, snippet }`. Never
   * triggers a `refresh()` (which would reset scroll).
   *
   * Fed by the `sync:bodies-written` event from the Rust SyncEngine after a
   * viewport-aware body-prefetch batch writes new bodies (Task 2 → Task 4).
   */
  patchSnippets: (updates: { threadId: string; snippet: string }[]) => void;

  // ---- User-driven thread mutations ----
  markThreadRead: (thread: Thread, read: boolean, messages?: DbMessageRow[]) => Promise<void>;
  toggleThreadStarred: (thread: Thread, messages?: DbMessageRow[]) => Promise<void>;
  deleteThread: (thread: Thread, messages?: DbMessageRow[]) => Promise<void>;
}

export const useThreadStore = create<ThreadState>((set, get) => ({
  threads: [],
  selectedThreadId: null,
  isLoading: false,
  cursor: null,
  currentQuery: null,

  loadThreads: async (accountId, labelId) => {
    set({
      isLoading: true,
      currentQuery: { accountId, labelId },
      threads: [],
      cursor: null,
    });
    try {
      const { threads, nextCursor } = await getThreads(accountId, { labelId });
      set({ threads, cursor: nextCursor });
    } finally {
      set({ isLoading: false });
    }
  },

  loadMore: async () => {
    const { currentQuery, cursor, isLoading } = get();
    if (!currentQuery || !cursor || isLoading) return;
    set({ isLoading: true });
    try {
      const { threads, nextCursor } = await getThreads(currentQuery.accountId, {
        labelId: currentQuery.labelId,
        cursor,
      });
      set((s) => ({ threads: [...s.threads, ...threads], cursor: nextCursor }));
    } finally {
      set({ isLoading: false });
    }
  },

  selectThread: async (thread) => {
    set({ selectedThreadId: thread.id });
    try {
      const messages = await getMessagesForThread(thread.accountId, thread.id);
      const latest = messages[messages.length - 1] ?? null;
      if (latest) {
        // Headers-first sync: the folder sweep no longer downloads bodies, so
        // open them on demand. If the body is uncached, ask the backend to
        // fetch it (sync_request_bodies → source.fetch_body → message_bodies
        // upsert) then re-read. Best-effort: on failure we render whatever the
        // cache has (null body → reading pane shows the text fallback).
        let body = await getMessageBody(thread.accountId, latest.id);
        if (!body || body.bodyHtml == null) {
          try {
            await invoke('sync_request_bodies', {
              accountId: thread.accountId,
              messageIds: [latest.id],
            });
            body = await getMessageBody(thread.accountId, latest.id);
          } catch (e) {
            console.error('on-demand body fetch failed:', e);
          }
        }
        useViewStore
          .getState()
          .setSelectedMessage(mapMessageToMailMessage(latest, body?.bodyHtml ?? null));
      } else {
        useViewStore.getState().setSelectedMessage(null);
      }
      // Opening a thread marks it read. Pass already-loaded messages so we don't
      // fetch them twice.
      if (!thread.isRead) {
        await get().markThreadRead(thread, true, messages);
      }
    } catch (e) {
      console.error('Failed to load thread messages:', e);
    }
  },

  refresh: async () => {
    const q = get().currentQuery;
    if (q) await get().loadThreads(q.accountId, q.labelId);
  },

  patchSnippets: (updates) => {
    if (updates.length === 0) return;
    const byId = new Map(updates.map((u) => [u.threadId, u.snippet]));
    set((s) => ({
      threads: s.threads.map((t) => (byId.has(t.id) ? { ...t, snippet: byId.get(t.id)! } : t)),
    }));
  },

  // ---- User-driven thread mutations ----

  markThreadRead: async (thread, read, messages) => {
    if (thread.isRead === read) return;
    const msgs = await getThreadMessages(thread, messages);
    set((s) => ({
      threads: s.threads.map((t) => (t.id === thread.id ? { ...t, isRead: read } : t)),
    }));
    void invoke('sync_apply_mutation', {
      accountId: thread.accountId,
      op: {
        type: 'markRead',
        threadId: thread.id,
        messageIds: msgs.map((m) => m.id),
        folderPath: msgs[0]?.imap_folder ?? '',
        uids: msgs.map((m) => m.imap_uid ?? 0),
        read,
      },
    }).catch((e) => console.error('sync_apply_mutation markRead failed', e));
    const labelId = get().currentQuery?.labelId;
    if (labelId) {
      const folderStore = useFolderStore.getState();
      if (read) folderStore.decrementUnread(thread.accountId, labelId);
      else folderStore.incrementUnread(thread.accountId, labelId);
    }
  },

  toggleThreadStarred: async (thread, messages) => {
    const nextStarred = !thread.isStarred;
    const msgs = await getThreadMessages(thread, messages);
    set((s) => ({
      threads: s.threads.map((t) => (t.id === thread.id ? { ...t, isStarred: nextStarred } : t)),
    }));
    void invoke('sync_apply_mutation', {
      accountId: thread.accountId,
      op: {
        type: 'setFlag',
        messageIds: msgs.map((m) => m.id),
        folderPath: msgs[0]?.imap_folder ?? '',
        uids: msgs.map((m) => m.imap_uid ?? 0),
        flag: '\\Flagged',
        add: nextStarred,
      },
    }).catch((e) => console.error('sync_apply_mutation setFlag failed', e));
  },

  deleteThread: async (thread, messages) => {
    const state = get();
    const wasSelected = state.selectedThreadId === thread.id;
    const idx = state.threads.findIndex((t) => t.id === thread.id);
    const nextThread =
      wasSelected && idx !== -1 ? (state.threads[idx + 1] ?? state.threads[idx - 1] ?? null) : null;

    set({
      threads: state.threads.filter((t) => t.id !== thread.id),
      selectedThreadId: nextThread?.id ?? (wasSelected ? null : state.selectedThreadId),
    });

    // If the deleted thread was being read, clear it and move the view to the
    // next thread. Otherwise, ensure the view store never points at a deleted
    // thread as a safety net.
    if (wasSelected) {
      useViewStore.getState().setSelectedMessage(null);
      if (nextThread) {
        await get().selectThread(nextThread);
      }
    } else if (useViewStore.getState().selectedMessage?.threadId === thread.id) {
      useViewStore.getState().setSelectedMessage(null);
    }

    const labelId = state.currentQuery?.labelId;
    if (labelId && !thread.isRead) {
      useFolderStore.getState().decrementUnread(thread.accountId, labelId);
    }

    const msgs = await getThreadMessages(thread, messages);
    void invoke('sync_apply_mutation', {
      accountId: thread.accountId,
      op: {
        type: 'delete',
        messageIds: msgs.map((m) => m.id),
        folderPath: msgs[0]?.imap_folder ?? '',
        uids: msgs.map((m) => m.imap_uid ?? 0),
      },
    }).catch((e) => console.error('sync_apply_mutation delete failed', e));

    // Notify other windows (e.g., standalone message viewers) that this thread
    // is gone so they can close instead of showing stale content.
    if (typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window) {
      const { emit } = await import('@tauri-apps/api/event');
      void emit('thread:deleted', { accountId: thread.accountId, threadId: thread.id });
    }
  },
}));
