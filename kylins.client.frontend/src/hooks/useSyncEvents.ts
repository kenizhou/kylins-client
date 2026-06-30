// Subscribes to Rust SyncEngine events and refreshes the relevant stores. The engine
// (Rust) owns all sync; the frontend is a reactive view layer.
//   sync:delta   -> a folder changed on disk -> reload folder list + open thread page
//   sync:new-mail-> new unread in an Inbox-equivalent -> OS notification
//   sync:queue   -> pending-operations count changed -> update uiStore.pendingCount
//   sync:status  -> per-account state transition (syncing/idle/error/rate_limited)
//   tray-check-mail (tray menu) -> nudge every account to sync now
//
// No-op outside Tauri (tests/jsdom).

import { useEffect } from 'react';
import { listen } from '@tauri-apps/api/event';
import { invoke } from '@tauri-apps/api/core';
import { useFolderStore } from '../stores/folderStore';
import { useThreadStore } from '../stores/threadStore';
import { useAccountStore } from '../stores/accountStore';
import { useUIStore } from '../stores/uiStore';
import { notifyNewMailBatch } from '../services/notifications/notificationManager';

/**
 * Per-account sync state, emitted by the Rust SyncEngine on every round
 * transition. Mirrors the `StatusEvent` struct in
 * `kylins.client.backend/src/sync_engine/engine.rs` (camelCase via serde).
 *
 * - `state`: one of `"syncing" | "idle" | "error" | "rate_limited"`.
 * - `detail`: epoch-seconds payload. Carries `retry_after` for `rate_limited`
 *   and `cooldown_until` for breaker-tripped `error`; `null`/absent for
 *   `syncing` / `idle` / non-breaker `error`. Phase 3g renders the status bar
 *   from this; the listener currently only subscribes so the event is not
 *   dropped (no UI yet).
 */
export interface StatusEvent {
  accountId: string;
  state: 'syncing' | 'idle' | 'error' | 'rate_limited' | (string & {});
  detail?: number | null;
}

const isTauri = typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;

export function useSyncEvents(): void {
  useEffect(() => {
    if (!isTauri) return;
    const unlisteners: Array<() => void> = [];

    (async () => {
      try {
        unlisteners.push(
          await listen<{ accountId: string; labelId?: string; table?: string }>(
            'sync:delta',
            (e) => {
              // Always reload the folder list on any delta (labels, messages, etc.).
              useFolderStore
                .getState()
                .loadLabels()
                .catch(() => {});

              // Only refresh the thread list for actual message changes, not
              // folder-list changes. Replacing the entire threads array causes
              // the virtualized message list to flicker.
              if (e.payload.table === 'labels') return;

              const q = useThreadStore.getState().currentQuery;
              if (q)
                useThreadStore
                  .getState()
                  .refresh()
                  .catch(() => {});
            },
          ),
        );

        unlisteners.push(
          await listen<{ accountId: string; folderId: string; count: number }>(
            'sync:new-mail',
            (e) => {
              notifyNewMailBatch(e.payload.count);
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
          await listen<StatusEvent>('sync:status', (e) => {
            // Per-account state transition (syncing / idle / error /
            // rate_limited). Phase 3g will render the status bar from
            // e.payload.detail (retry_after / cooldown_until). Here we mirror
            // the rate-limit flag into uiStore so the viewport body-prefetch
            // hook can skip any account the server has throttled (prefetch is
            // low-priority — the next poll refills the cache once the cooldown
            // lifts).
            useUIStore
              .getState()
              .setRateLimited(e.payload.accountId, e.payload.state === 'rate_limited');
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
