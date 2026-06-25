// Thread list state: keyset-paginated loading per selected folder, selection that
// bridges into viewStore.selectedMessage (so ReadingPane / viewer work unchanged),
// and mark-as-read on open. Bodies are lazy-fetched on selection.

import { create } from 'zustand';
import {
  getThreads,
  getMessagesForThread,
  markThreadRead,
  mapMessageToMailMessage,
  type Thread,
  type ThreadCursor,
} from '../services/db/threads';
import { getMessageBody } from '../services/db/messageBodies';
import { useViewStore } from '../features/view/viewStore';
import { useFolderStore } from './folderStore';

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
        const body = await getMessageBody(thread.accountId, latest.id);
        useViewStore
          .getState()
          .setSelectedMessage(mapMessageToMailMessage(latest, body?.bodyHtml ?? null));
      } else {
        useViewStore.getState().setSelectedMessage(null);
      }
      // Mark as read (optimistic UI + DB + decrement the folder's unread badge).
      if (!thread.isRead) {
        set((s) => ({
          threads: s.threads.map((t) => (t.id === thread.id ? { ...t, isRead: true } : t)),
        }));
        void markThreadRead(thread.accountId, thread.id);
        const labelId = get().currentQuery?.labelId;
        if (labelId) useFolderStore.getState().decrementUnread(thread.accountId, labelId);
      }
    } catch (e) {
      console.error('Failed to load thread messages:', e);
    }
  },

  refresh: async () => {
    const q = get().currentQuery;
    if (q) await get().loadThreads(q.accountId, q.labelId);
  },
}));
