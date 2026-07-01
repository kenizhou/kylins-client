// Subscribes to Rust SyncEngine events and refreshes the relevant stores. The engine
// (Rust) owns all sync; the frontend is a reactive view layer.
//   sync:delta          -> a folder changed on disk -> reload folder list + open thread page
//   sync:new-mail       -> new unread in an Inbox-equivalent -> OS notification + tray refresh
//   sync:queue          -> pending-operations count changed -> uiStore.setPendingForAccount
//                          (StatusBar aggregates across accounts; legacy setPendingCount zeros
//                          the per-account map, so sync:queue no longer calls it)
//   sync:status         -> per-account state transition (syncing/idle/error/rate_limited)
//                          -> setSyncStateForAccount + setRateLimited (prefetch gate)
//   sync:bodies-written -> a viewport body-prefetch batch landed -> in-place snippet patch
//                          (scroll-preserving; never calls threadStore.refresh())
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
import { notifyNewMailBatchDeduped } from '../services/notifications/notificationManager';

/**
 * Per-account sync state, emitted by the Rust SyncEngine on every round
 * transition. Mirrors the `StatusEvent` struct in
 * `kylins.client.backend/src/sync_engine/engine.rs` (camelCase via serde).
 *
 * - `state`: one of `"syncing" | "idle" | "error" | "rate_limited"`.
 * - `detail`: epoch-seconds payload. Carries `retry_after` for `rate_limited`
 *   and `cooldown_until` for breaker-tripped `error`; `null`/absent for
 *   `syncing` / `idle` / non-breaker `error`. Phase 3g's StatusBar renders the
 *   "worst" state across accounts from this; useSyncEvents mirrors it into
 *   uiStore.setSyncStateForAccount (Task 3) + setRateLimited (Phase 3f).
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

        // Tray tooltip + (Task 5) notification dedupe refresh on every change
        // that could move the unread count. Best-effort; failures are swallowed
        // inside refreshTrayTooltip. Dynamic-imported so the tray module never
        // loads in jsdom (no Tauri runtime); the static string literal resolves
        // at build time and does NOT need the @vite-ignore plugin comment.
        const refreshTray = () => {
          import('../services/tray/traySync').then((m) => m.refreshTrayTooltip()).catch(() => {});
        };

        // A second sync:delta listener for the tray tooltip. Kept separate
        // from the store-reload listener above so concerns stay decoupled —
        // both fire on the same event; order is not guaranteed but neither
        // blocks the other. Skipped for label-only deltas (read state didn't
        // change, only the folder list did).
        unlisteners.push(
          await listen<{ accountId: string; labelId?: string; table?: string }>(
            'sync:delta',
            (e) => {
              if (e.payload.table !== 'labels') refreshTray();
            },
          ),
        );

        unlisteners.push(
          await listen<{
            accountId: string;
            folderId: string;
            count: number;
            // Stable message ids (`messages.id` shape) carried since Task 5;
            // absent/empty for sources that don't surface ids, in which case
            // notifyNewMailBatchDeduped falls back to the raw count.
            messageIds?: string[];
          }>('sync:new-mail', (e) => {
            // Per-message dedupe: the engine populates `messageIds` with the
            // just-arrived ids, so a re-fetch of the same UIDs (e.g. a folder
            // whose cursor didn't advance) doesn't re-notify. DND + the
            // new-unread toggle are honored inside the manager.
            notifyNewMailBatchDeduped(e.payload.count, e.payload.messageIds);
            refreshTray();
          }),
        );

        unlisteners.push(
          await listen<{ accountId: string; pending: number }>('sync:queue', (e) => {
            // Per-account pending count -> aggregated store. StatusBar reads
            // the sum (useUIStore.aggregatedPending), not just this account.
            // Do NOT call legacy setPendingCount here — it zeros the
            // per-account map, discarding other accounts' counts.
            useUIStore.getState().setPendingForAccount(e.payload.accountId, e.payload.pending);
          }),
        );

        unlisteners.push(
          await listen<StatusEvent>('sync:status', (e) => {
            // Per-account state transition (syncing / idle / error /
            // rate_limited). Phase 3g renders the status bar from
            // e.payload.detail (retry_after / cooldown_until). We mirror two
            // things into uiStore:
            //   1. setSyncStateForAccount — StatusBar renders the "worst"
            //      state across accounts (Task 4). 'rate_limited' is optional
            //      (Phase 3f); if never emitted, that value never surfaces.
            //   2. setRateLimited — the viewport body-prefetch hook skips any
            //      account the server has throttled (prefetch is low-priority;
            //      the next poll refills the cache once the cooldown lifts).
            useUIStore.getState().setSyncStateForAccount(e.payload.accountId, e.payload.state);
            useUIStore
              .getState()
              .setRateLimited(e.payload.accountId, e.payload.state === 'rate_limited');
          }),
        );

        unlisteners.push(
          await listen<{
            accountId: string;
            updates: { threadId: string; snippet: string }[];
          }>('sync:bodies-written', (e) => {
            // Viewport-aware body-prefetch (Task 2) just wrote N bodies. Patch
            // the matching threads' snippets in place so the list updates
            // without a scroll-resetting refresh() (react-virtualized #1837).
            useThreadStore.getState().patchSnippets(e.payload.updates);
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
