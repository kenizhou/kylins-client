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
        const body = await getMessageBody(thread.accountId, latest.id);
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
    const msgs = await getThreadMessages(thread, messages);
    set((s) => ({
      threads: s.threads.filter((t) => t.id !== thread.id),
      selectedThreadId: s.selectedThreadId === thread.id ? null : s.selectedThreadId,
    }));
    void invoke('sync_apply_mutation', {
      accountId: thread.accountId,
      op: {
        type: 'delete',
        messageIds: msgs.map((m) => m.id),
        folderPath: msgs[0]?.imap_folder ?? '',
        uids: msgs.map((m) => m.imap_uid ?? 0),
      },
    }).catch((e) => console.error('sync_apply_mutation delete failed', e));
    const labelId = get().currentQuery?.labelId;
    if (labelId && !thread.isRead) {
      useFolderStore.getState().decrementUnread(thread.accountId, labelId);
    }
  },
}));
