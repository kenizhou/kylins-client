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

import { useEffect, useRef } from 'react';
import { listen } from '@tauri-apps/api/event';
import { invoke } from '@tauri-apps/api/core';
import { useFolderStore } from '../stores/folderStore';
import { useThreadStore } from '../stores/threadStore';
import { useAccountStore } from '../stores/accountStore';
import { useUIStore } from '../stores/uiStore';
import { useToastStore } from '../stores/toastStore';
import { useViewStore } from '../features/view/viewStore';
import { SEND_COMPLETE_EVENT } from '../services/composer/send';
import { notifyNewMailBatchDeduped } from '../services/notifications/notificationManager';
import { getMessageCryptoResult } from '../services/db/cryptoReceive';

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

/**
 * G6 Task 6: apply a `sync:crypto-result` event to the currently-selected
 * message. Extracted from the listener closure so it is unit-testable in
 * jsdom (the full hook short-circuits via `isTauri` and is awkward to drive
 * from tests).
 *
 * Contract:
 *   - no-op when `selectedMessage` is null or the payload's `messageId`
 *     doesn't match the selected message's id (the event was for a different
 *     message — e.g. background re-verify on another message the user opened
 *     earlier).
 *   - re-reads `getMessageCryptoResult(accountId, messageId)` (the row is
 *     already written — `crypto_open_message` emits the event AFTER the
 *     write; see `db/commands.rs:1508`).
 *   - layers the crypto fields onto a NEW `selectedMessage` object and calls
 *     `setSelectedMessage` so Zustand sees a new reference (CryptoBadge
 *     re-renders). Non-crypto fields (subject, body, etc.) are preserved.
 *   - no-op when the re-read returns null (the row was never written — e.g.
 *     the event fired for a non-crypto message; the G5 orchestrator only
 *     emits after a successful write so this branch is defensive).
 *   - pushes a toast on the notable transition INTO 'valid-verified' (the
 *     common case after a background re-verify following a CA-root import —
 *     the user just saw "chain unverified" and now the badge flips). Stays
 *     quiet on every other transition (the badge update is enough).
 *
 * The field mapping mirrors the threadStore crypto branch
 * (`stores/threadStore.ts:137-144`) so the badge renders identically here.
 */
export async function applyCryptoResultToSelectedMessage(payload: {
  accountId: string;
  messageId: string;
}): Promise<void> {
  const current = useViewStore.getState().selectedMessage;
  if (!current) return;
  if (current.id !== payload.messageId) return;

  const cr = await getMessageCryptoResult(payload.accountId, payload.messageId);
  if (!cr) return;

  // TOCTOU re-check: the user may have navigated to a different message during
  // the IPC round-trip above. Don't clobber their new selection with `updated`
  // (built from the now-stale `current`). Re-verify the selection is still this
  // message before writing.
  if (useViewStore.getState().selectedMessage?.id !== payload.messageId) return;

  const priorSignatureState = current.signatureState;
  const updated = {
    ...current,
    signatureState: cr.signatureState as NonNullable<typeof current.signatureState>,
    decryptState: cr.decryptState as NonNullable<typeof current.decryptState>,
    signerEmail: cr.signerEmail ?? undefined,
    signerFingerprint: cr.signerFingerprint ?? undefined,
    revocationState: cr.revocationState as NonNullable<typeof current.revocationState>,
  };
  useViewStore.getState().setSelectedMessage(updated);

  // Toast only on the transition INTO 'valid-verified' — that's the signal a
  // user actually cares about ("the signed mail you're looking at is now
  // fully trusted"). Other transitions are silent (the badge updates).
  if (priorSignatureState !== 'valid-verified' && cr.signatureState === 'valid-verified') {
    useToastStore.getState().push('Signature verified', 'success');
  }
}

export function useSyncEvents(): void {
  // Trailing debounce for `threadStore.refresh()` on `sync:delta{messages}`.
  // The engine emits one delta per folder that changed in a round; on an
  // account with several dirty folders (or a CONDSTORE round touching INBOX +
  // Sent + Drafts) that's a burst of 2-5 deltas within a few hundred ms, each
  // previously triggering a full page reload (db_get_threads round-trip +
  // react-virtualized re-render — visible as a flicker + scroll reset).
  // Coalescing into one trailing reload 2s after the last delta collapses the
  // burst while staying well under a user's perception of "instant" (the
  // 60s poll cadence means 2s of extra latency on a refresh is negligible).
  // Lives in a ref so the timer survives re-renders and is cleared on unmount.
  const refreshDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (!isTauri) return;
    const unlisteners: Array<() => void> = [];

    // SEND_COMPLETE = the send was enqueued (invoke resolved). Turn the
    // StatusBar "Sending…" spinner ON; the actual SMTP/EAS transport fires
    // asynchronously in the backend. `sync:send-result` (onSendResult) turns
    // the spinner OFF + shows the Sent/Failed toast + nudges the Sent sync.
    // (send.ts also sets the spinner for the same-window inline case; this
    // listener covers popout sends crossing into the main window.)
    const onSendComplete = (e: { payload: { accountId?: string } }) => {
      console.log(
        '[send-fe] onSendComplete RECEIVED (send enqueued) accountId=',
        e.payload?.accountId,
      );
      useUIStore.getState().setSendProgress({ active: true, message: 'Sending…' });
    };

    // sync:send-result = the backend replay worker finished the SMTP/EAS send
    // (success or failure). Turn the spinner OFF + toast + nudge the Sent sync.
    const onSendResult = (e: {
      payload: { accountId?: string; draftId?: string; success?: boolean; error?: string | null };
    }) => {
      const { accountId, success, error } = e.payload;
      console.log('[send-fe] onSendResult RECEIVED success=', success, 'accountId=', accountId);
      useUIStore.getState().setSendProgress({ active: false });
      if (success) {
        useToastStore.getState().push('Message sent', 'success');
        if (accountId) {
          invoke('sync_account_now', { accountId }).catch(() => {
            /* best-effort; the next poll round still picks up the Sent copy */
          });
        }
      } else {
        useToastStore.getState().push(`Send failed: ${error ?? 'unknown error'}`, 'error');
      }
    };

    (async () => {
      try {
        unlisteners.push(await listen<{ accountId?: string }>(SEND_COMPLETE_EVENT, onSendComplete));
        console.log('[send-fe] SEND_COMPLETE_EVENT listener registered (Tauri app-level)');
        unlisteners.push(
          await listen<{
            accountId?: string;
            draftId?: string;
            success?: boolean;
            error?: string | null;
          }>('sync:send-result', onSendResult),
        );
        console.log('[send-fe] sync:send-result listener registered');
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
              if (!q) return;
              // Trailing debounce: clear any pending refresh and schedule a new
              // one 2s out. A burst of N deltas in <2s results in exactly one
              // reload (the last delta's timer wins). The guard above (`if (!q)
              // return`) already short-circuits when no folder is open, so this
              // path only fires when a refresh would actually be visible.
              if (refreshDebounceRef.current) {
                clearTimeout(refreshDebounceRef.current);
              }
              refreshDebounceRef.current = setTimeout(() => {
                refreshDebounceRef.current = null;
                useThreadStore
                  .getState()
                  .refresh()
                  .catch(() => {});
              }, 2000);
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
          await listen<{ accountId: string; messageId: string }>('sync:crypto-result', (e) => {
            // G6 Task 6: a crypto-marked message was just opened/verified
            // (the orchestrator emits AFTER the row write — see
            // db/commands.rs:1508). If it's the one the user is looking at,
            // re-read the persisted result + update selectedMessage's crypto
            // fields so the CryptoBadge refreshes without a full re-decrypt.
            // Best-effort: errors inside the helper are swallowed so a bad
            // row never crashes the event bus.
            void applyCryptoResultToSelectedMessage(e.payload).catch(() => {});
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
      // Cancel any pending trailing refresh so we don't fire a store update
      // after the hook (and its owning component) has unmounted.
      if (refreshDebounceRef.current) {
        clearTimeout(refreshDebounceRef.current);
        refreshDebounceRef.current = null;
      }
    };
  }, []);
}
