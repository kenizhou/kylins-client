// Subscribes to Rust SyncEngine events and refreshes the relevant stores. The engine
// (Rust) owns all sync; the frontend is a reactive view layer.
//   sync:delta   -> a folder changed on disk -> reload folder list + open thread page
//   sync:new-mail-> new unread in an Inbox-equivalent -> OS notification
//   sync:queue   -> pending-operations count changed -> update uiStore.pendingCount
//   tray-check-mail (tray menu) -> nudge every account to sync now
//
// No-op outside Tauri (tests/jsdom).

import { useEffect } from 'react';
import { listen } from '@tauri-apps/api/event';
import { invoke } from '@tauri-apps/api/core';
import { sendNotification } from '@tauri-apps/plugin-notification';
import { useFolderStore } from '../stores/folderStore';
import { useThreadStore } from '../stores/threadStore';
import { useAccountStore } from '../stores/accountStore';
import { useUIStore } from '../stores/uiStore';

const isTauri = typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;

export function useSyncEvents(): void {
  useEffect(() => {
    if (!isTauri) return;
    const unlisteners: Array<() => void> = [];

    (async () => {
      try {
        unlisteners.push(
          await listen<{ accountId: string; labelId?: string }>('sync:delta', () => {
            // Folder unread counts / membership may have changed.
            useFolderStore
              .getState()
              .loadLabels()
              .catch(() => {});
            // Re-read the currently-open folder's threads, if any.
            const q = useThreadStore.getState().currentQuery;
            if (q)
              useThreadStore
                .getState()
                .refresh()
                .catch(() => {});
          }),
        );

        unlisteners.push(
          await listen<{ accountId: string; folderId: string; count: number }>(
            'sync:new-mail',
            (e) => {
              const n = e.payload.count;
              try {
                sendNotification({
                  title: 'New mail',
                  body: `${n} new message${n === 1 ? '' : 's'}`,
                });
              } catch {
                /* notifications are best-effort */
              }
            },
          ),
        );

        unlisteners.push(
          await listen<{ accountId: string; pending: number }>('sync:queue', (e) => {
            // Pending-operations count for this account changed. The status bar
            // shows the aggregate; we keep it simple and surface the latest
            // account's count (multi-account aggregation is a later refinement).
            useUIStore.getState().setPendingCount(e.payload.pending);
          }),
        );

        unlisteners.push(
          await listen('tray-check-mail', () => {
            // Tray "Check for Mail" -> nudge every account to sync immediately.
            useAccountStore
              .getState()
              .accounts.forEach((a) =>
                invoke('sync_account_now', { accountId: a.id }).catch(() => {}),
              );
          }),
        );
      } catch {
        // Event subscription is best-effort; never crash the UI.
      }
    })();

    return () => {
      unlisteners.forEach((u) => {
        try {
          u();
        } catch {
          /* ignore */
        }
      });
    };
  }, []);
}
