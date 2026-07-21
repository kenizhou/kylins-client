import { useThreadStore } from '@/stores/threadStore';
import type { Thread } from '@/services/db/threads';
import type { DbMessageRow } from '@/services/db/threads';

/**
 * Provider-agnostic thread-level mail actions. These functions resolve the
 * destination folder by canonical role (archive/trash/junk) and hand off to the
 * thread store, which optimistically updates the local list and enqueues a
 * `sync_apply_mutation` op for the backend replay worker.
 */

export async function archiveThread(thread: Thread, messages?: DbMessageRow[]): Promise<void> {
  await useThreadStore.getState().moveThreadToRole(thread, 'archive', messages);
}

export async function archiveThreads(threads: Thread[]): Promise<void> {
  await useThreadStore.getState().moveThreadsToRole(threads, 'archive');
}

export async function trashThread(thread: Thread, messages?: DbMessageRow[]): Promise<void> {
  await useThreadStore.getState().moveThreadToRole(thread, 'trash', messages);
}

export async function junkThread(thread: Thread, messages?: DbMessageRow[]): Promise<void> {
  await useThreadStore.getState().moveThreadToRole(thread, 'junk', messages);
}
