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
      // Mark as read (optimistic UI + durable write via the sync engine).
      // The engine applies locally (threads+messages is_read=1) and enqueues a
      // per-message replay row so the IMAP \Seen flag is set server-side. uids
      // + folderPath are required for remote replay; fall back to empty/0 when
      // the message has no IMAP provenance (e.g. an EAS-sourced message row).
      if (!thread.isRead) {
        set((s) => ({
          threads: s.threads.map((t) => (t.id === thread.id ? { ...t, isRead: true } : t)),
        }));
        void invoke('sync_apply_mutation', {
          accountId: thread.accountId,
          op: {
            type: 'markRead',
            threadId: thread.id,
            messageIds: messages.map((m) => m.id),
            folderPath: messages[0]?.imap_folder ?? '',
            uids: messages.map((m) => m.imap_uid ?? 0),
            read: true,
          },
        }).catch((e) => console.error('sync_apply_mutation markRead failed', e));
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
