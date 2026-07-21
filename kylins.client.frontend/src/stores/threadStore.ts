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
import { getMessageCryptoResult, openCryptoMessage } from '../services/db/cryptoReceive';
import { useViewStore, type MailMessage } from '../features/view/viewStore';
import { useFolderStore } from './folderStore';
import { useToastStore } from './toastStore';
import { getFolderByRole } from '../services/db/labels';
import type { FolderRole } from '../services/mail/folders';

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
  selectedThreadIds: string[];
  selectionAnchorId: string | null;
  isLoading: boolean;
  /** Cursor for the next page (null = no more). */
  cursor: ThreadCursor | null;
  currentQuery: ThreadQuery | null;

  loadThreads: (accountId: string, labelId: string | null) => Promise<void>;
  loadMore: () => Promise<void>;
  selectThread: (thread: Thread) => Promise<void>;
  setSelection: (ids: string[], anchorId: string | null) => Promise<void>;
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
  markThreadsRead: (threads: Thread[], read: boolean) => Promise<void>;
  toggleThreadStarred: (thread: Thread, messages?: DbMessageRow[]) => Promise<void>;
  deleteThread: (thread: Thread, messages?: DbMessageRow[]) => Promise<void>;
  moveThread: (
    thread: Thread,
    dstLabel: string,
    dstFolderPath: string,
    messages?: DbMessageRow[],
  ) => Promise<void>;
  moveThreadToRole: (thread: Thread, role: FolderRole, messages?: DbMessageRow[]) => Promise<void>;
}

export const useThreadStore = create<ThreadState>((set, get) => {
  /**
   * Load the anchor thread's latest message into `viewStore.selectedMessage`.
   * This is the exact pipeline formerly inlined in `selectThread` (crypto path
   * with session decryptedCache, plain path with on-demand body fetch). Shared
   * by setSelection and the bulk mutations that re-anchor the reading pane.
   */
  const openThreadBody = async (thread: Thread): Promise<void> => {
    try {
      const messages = await getMessagesForThread(thread.accountId, thread.id);
      const latest = messages[messages.length - 1] ?? null;
      if (latest) {
        // S/MIME crypto path (Phase 1b Plan 4): an encrypted/signed message is
        // opened through the decrypt + verify pipeline (`openCryptoMessage`)
        // instead of the plain body fetch. The decrypted plaintext is
        // SESSION-ONLY — it flows into `viewStore.selectedMessage.html`
        // (in-memory React state) + `viewStore.decryptedCache` (RAM) so
        // re-opening doesn't re-decrypt. NEVER written to disk. On decrypt
        // failure we set `decryptState: 'failed'` + push a toast so ReadingPane
        // (T4) shows the decrypt-failure panel; we do NOT crash the open flow.
        // Rust `MessageRow.is_encrypted`/`is_signed` are `bool` → JSON
        // `true`/`false` (NOT 0/1 ints — the read path was cut over from
        // plugin-sql to Rust db commands). Coerce truthily; `=== 1` would
        // silently never match a boolean, gating the crypto path off for EVERY
        // encrypted message (regression that left the smime.p7m envelope
        // rendering as a plain attachment instead of decrypting).
        const isCrypto = !!latest.is_encrypted || !!latest.is_signed;
        if (isCrypto) {
          const cached = useViewStore.getState().decryptedCache[latest.id];
          let mail: MailMessage;
          if (cached) {
            // Session cache hit — skip the crypto invoke entirely. The cached
            // plaintext (RAM) is the source of truth for re-open. Re-attach the
            // persisted verification outcome via getMessageCryptoResult (cheap
            // DB read, no decrypt; always-current — reflects any trust decision
            // since first open) so the CryptoBadge renders on re-open, not just
            // first open. Without this the badge vanishes on every re-open.
            mail = mapMessageToMailMessage(latest, cached.html);
            mail.text = cached.text;
            const cr = await getMessageCryptoResult(thread.accountId, latest.id);
            if (cr) {
              mail.signatureState = cr.signatureState as MailMessage['signatureState'];
              mail.decryptState = cr.decryptState as MailMessage['decryptState'];
              mail.signerEmail = cr.signerEmail ?? undefined;
              mail.signerFingerprint = cr.signerFingerprint ?? undefined;
              mail.revocationState = cr.revocationState as MailMessage['revocationState'];
            }
          } else {
            try {
              const result = await openCryptoMessage(thread.accountId, latest.id);
              // Cache the plaintext BEFORE mapping so a re-open in the same
              // session hits the cache even if setSelectedMessage throws below.
              useViewStore
                .getState()
                .setDecrypted(latest.id, result.plaintextHtml, result.plaintextText);
              mail = mapMessageToMailMessage(latest, result.plaintextHtml);
              mail.text = result.plaintextText;
              const cr = result.cryptoResult;
              // Layer the persisted verification outcome onto the MailMessage.
              // Casts narrow the backend's `string` fields to the MailMessage
              // literal unions — the Rust side emits exactly these variants per
              // the `message_crypto_results` CHECK constraints.
              mail.signatureState = cr.signatureState as MailMessage['signatureState'];
              mail.decryptState = cr.decryptState as MailMessage['decryptState'];
              mail.signerEmail = cr.signerEmail ?? undefined;
              mail.signerFingerprint = cr.signerFingerprint ?? undefined;
              mail.revocationState = cr.revocationState as MailMessage['revocationState'];
            } catch (e) {
              // Decrypt/verify failure: surface the failure panel + toast. The
              // base MailMessage (from the DB row) still carries isEncrypted /
              // isSigned so the ReadingPane knows it was a crypto message.
              console.error('[openThreadBody] crypto open failed:', e);
              useToastStore
                .getState()
                .push(`Decrypt failed: ${e instanceof Error ? e.message : String(e)}`, 'error');
              mail = mapMessageToMailMessage(latest, null);
              mail.decryptState = 'failed';
            }
          }
          useViewStore.getState().setSelectedMessage(mail);
        } else {
          // Plain path (unchanged) — headers-first body fetch. The folder sweep
          // no longer downloads bodies, so open them on demand. If the body is
          // uncached, ask the backend to fetch it (sync_request_bodies →
          // source.fetch_body → message_bodies upsert) then re-read. Best
          // effort: on failure we render whatever the cache has (null body →
          // reading pane shows the text fallback).
          let body = await getMessageBody(thread.accountId, latest.id);
          console.log(
            '[select] latestId=',
            latest.id,
            'accountId=',
            thread.accountId,
            'body=',
            body ? `${body.bodyHtml?.length ?? 'null'} chars` : 'null',
          );
          if (!body || body.bodyHtml == null) {
            console.log('[select] CACHE MISS for', latest.id, '— triggering sync_request_bodies');
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
        }
      } else {
        useViewStore.getState().setSelectedMessage(null);
      }
      // Note: opening a thread no longer marks it read here — that happens
      // when the user navigates away (see setSelection).
    } catch (e) {
      console.error('Failed to load thread messages:', e);
    }
  };

  return {
    threads: [],
    selectedThreadId: null,
    selectedThreadIds: [],
    selectionAnchorId: null,
    isLoading: false,
    cursor: null,
    currentQuery: null,

    loadThreads: async (accountId, labelId) => {
      set({
        isLoading: true,
        currentQuery: { accountId, labelId },
        threads: [],
        cursor: null,
        selectedThreadId: null,
        selectedThreadIds: [],
        selectionAnchorId: null,
      });
      useViewStore.getState().setSelectedThreadIds([]);
      useViewStore.getState().setSelectedMessage(null);
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
      if (get().selectedThreadId === thread.id) {
        await openThreadBody(thread);
      } else {
        await get().setSelection([thread.id], thread.id);
      }
    },

    setSelection: async (ids, anchorId) => {
      const prevAnchorId = get().selectedThreadId;
      // Only loaded threads are selectable (Ctrl+A ranges, stale ids after
      // pagination/filtering are dropped).
      const validIds = ids.filter((id) => get().threads.some((t) => t.id === id));
      const nextAnchorId =
        anchorId && validIds.includes(anchorId)
          ? anchorId
          : (validIds[validIds.length - 1] ?? null);

      set({
        selectedThreadIds: validIds,
        selectionAnchorId: nextAnchorId,
        selectedThreadId: nextAnchorId,
      });
      useViewStore.getState().setSelectedThreadIds(validIds);

      // Outlook-style read timing: the anchor being LEFT is marked read, not the
      // anchor being opened — so the unread styling (colorbar, bold) stays while
      // reading and is only consumed when the user moves on.
      if (prevAnchorId && prevAnchorId !== nextAnchorId) {
        const previous = get().threads.find((t) => t.id === prevAnchorId);
        if (previous && !previous.isRead) {
          await get().markThreadRead(previous, true);
        }
      }

      // Selection changed but the reading-pane target didn't — nothing to load.
      if (nextAnchorId === prevAnchorId) return;

      const anchorThread = nextAnchorId
        ? get().threads.find((t) => t.id === nextAnchorId)
        : undefined;
      if (!anchorThread) {
        useViewStore.getState().setSelectedMessage(null);
        return;
      }
      await openThreadBody(anchorThread);
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
      void messages;
      await get().markThreadsRead([thread], read);
    },

    markThreadsRead: async (threadsToMark, read) => {
      const targets = threadsToMark.filter((t) => t.isRead !== read);
      if (targets.length === 0) return;

      const msgsById = new Map<string, DbMessageRow[]>();
      await Promise.all(
        targets.map(async (t) => {
          msgsById.set(t.id, await getThreadMessages(t));
        }),
      );

      // One batched state update so a virtualized list re-renders once.
      const ids = new Set(targets.map((t) => t.id));
      set((s) => ({
        threads: s.threads.map((t) => (ids.has(t.id) ? { ...t, isRead: read } : t)),
      }));

      const labelId = get().currentQuery?.labelId;
      const folderStore = useFolderStore.getState();
      for (const t of targets) {
        const msgs = msgsById.get(t.id)!;
        void invoke('sync_apply_mutation', {
          accountId: t.accountId,
          op: {
            type: 'markRead',
            threadId: t.id,
            messageIds: msgs.map((m) => m.id),
            folderPath: msgs[0]?.imap_folder ?? '',
            uids: msgs.map((m) => m.imap_uid ?? 0),
            read,
          },
        }).catch((e) => console.error('sync_apply_mutation markRead failed', e));
        if (labelId) {
          if (read) folderStore.decrementUnread(t.accountId, labelId);
          else folderStore.incrementUnread(t.accountId, labelId);
        }
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
        wasSelected && idx !== -1
          ? (state.threads[idx + 1] ?? state.threads[idx - 1] ?? null)
          : null;

      set({
        threads: state.threads.filter((t) => t.id !== thread.id),
        selectedThreadId: nextThread?.id ?? (wasSelected ? null : state.selectedThreadId),
      });

      useViewStore
        .getState()
        .setSelectedThreadIds(get().selectedThreadId ? [get().selectedThreadId!] : []);

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

    moveThread: async (thread, dstLabel, dstFolderPath, messages) => {
      const state = get();
      const wasSelected = state.selectedThreadId === thread.id;
      const idx = state.threads.findIndex((t) => t.id === thread.id);
      const nextThread =
        wasSelected && idx !== -1
          ? (state.threads[idx + 1] ?? state.threads[idx - 1] ?? null)
          : null;

      set({
        threads: state.threads.filter((t) => t.id !== thread.id),
        selectedThreadId: nextThread?.id ?? (wasSelected ? null : state.selectedThreadId),
      });

      useViewStore
        .getState()
        .setSelectedThreadIds(get().selectedThreadId ? [get().selectedThreadId!] : []);

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

      // Resolve the source label/folder. The folder pane selection is the
      // authoritative source when it matches the thread's account; otherwise fall
      // back to the message's IMAP folder path.
      const selected = useFolderStore.getState().selected;
      let srcLabel = selected?.accountId === thread.accountId ? selected.labelId : null;
      const srcFolderPath = msgs[0]?.imap_folder ?? '';
      if (!srcLabel && srcFolderPath) {
        const folder = useFolderStore
          .getState()
          .byAccount[
            thread.accountId
          ]?.find((f) => f.remoteId === srcFolderPath || f.name === srcFolderPath);
        srcLabel = folder?.id ?? null;
      }

      void invoke('sync_apply_mutation', {
        accountId: thread.accountId,
        op: {
          type: 'move',
          messageIds: msgs.map((m) => m.id),
          srcLabel: srcLabel ?? '',
          dstLabel,
          srcFolderPath,
          dstFolderPath,
          uids: msgs.map((m) => m.imap_uid ?? 0),
        },
      }).catch((e) => console.error('sync_apply_mutation move failed', e));
    },

    moveThreadToRole: async (thread, role, messages) => {
      const folder = await getFolderByRole(thread.accountId, role);
      if (!folder) {
        console.error(`[threadStore] no ${role} folder for account ${thread.accountId}`);
        return;
      }
      await get().moveThread(thread, folder.id, folder.remoteId, messages);
    },
  };
});
