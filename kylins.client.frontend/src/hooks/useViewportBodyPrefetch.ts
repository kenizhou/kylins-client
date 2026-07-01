// Viewport-aware batch body prefetch. When the message-list scroll settles
// (or on mount / folder-switch), compute the visible+buffer rows, map each to
// its message_id, filter via `getUncachedBodyMessageIds`, and invoke
// `sync_request_bodies` once. Best-effort: late-arriving batches still
// usefully fill the cache and patch snippets (patches are idempotent).
//
// Robustness (Task 3b):
//   - First mount fires IMMEDIATELY (0-ms timeout) so the initial viewport
//     shows snippets without waiting the 250 ms debounce. Subsequent triggers
//     (scroll / folder-switch) keep the debounce.
//   - A min-interval throttle bounds the rate to <=1 batch/sec even when scroll
//     settles repeatedly inside one second (server-load guard, Scenario 11).
//   - No supersede token: a late-arriving batch fired during fast scroll still
//     usefully fills the cache and patches snippets for threads that are very
//     likely still in the list. Patches are idempotent (INSERT OR REPLACE on
//     the body; in-place map on the store), so applying a "stale" result is
//     correct, not a bug. The debounce + 1-batch/sec throttle already prevent
//     flooding; nothing further is gained by dropping legitimate late arrivals.
//
// Phase 0 (one thread per message): thread.id IS the message_id, so the
// "latest message_id for the thread" is just thread.id. When real conversation
// threading lands, expose `latest_message_id` on the Thread type and switch
// the mapping below — see `message-list-architecture.md` (Deferred).

import { useEffect, useRef } from 'react';
import type { Virtualizer } from '@tanstack/react-virtual';
import { invoke } from '@tauri-apps/api/core';
import { useThreadStore } from '../stores/threadStore';
import { useUIStore } from '../stores/uiStore';
import { getUncachedBodyMessageIds } from '../services/db/messages';
import type { Thread } from '../services/db/threads';

interface Options {
  virtualizer: Virtualizer<HTMLDivElement, Element>;
  threads: Thread[];
  /** Account id for the currently-loaded list. */
  accountId: string | null;
}

/** Buffer (rows) added above/below the visible range when picking prefetch
 * candidates. ~5–8; tuned so a single scroll tick doesn't miss. */
const VIEWPORT_BUFFER = 6;
/** Hard cap on message_ids per prefetch invocation. */
const MAX_PREFETCH = 30;
/** Debounce window (ms). Lets a fast scroll settle before we fetch. */
const DEBOUNCE_MS = 250;
/** Min-interval between batches (ms). Bounds the prefetch rate to <=1/sec so
 * a fast scroll storm can't flood the IMAP server (Scenario 11). */
const MIN_INTERVAL_MS = 1000;

/** Live Tauri check — read at effect time, NOT module load. The hook is
 * imported by tests that set `window.__TAURI_INTERNALS__` in `beforeEach`
 * (after import), so a module-level `const` would snapshot the pre-test value
 * (false) and never see the test's override. Reading inside the effect keeps
 * the no-op-outside-Tauri guarantee while staying testable. */
function isTauriEnv(): boolean {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
}

/**
 * Viewport-aware batch body prefetch. Skipped entirely when the account is
 * rate-limited (Phase 3f) — prefetch is low-priority and the next poll will
 * fill the cache.
 *
 * Trigger surface: the effect depends on `[virtualizer, accountId]` plus a
 * `threadsRef` read inside the timeout. We deliberately do NOT put `threads`
 * in the dep array — `threadStore` patches `threads[i].snippet` in place on
 * every `sync:bodies-written` (Task 4), which would otherwise re-fire the
 * effect on every snippet patch (a feedback loop). `useThreadStore.getState()`
 * is stable and always returns the freshest array.
 */
export function useViewportBodyPrefetch({ virtualizer, threads, accountId }: Options): void {
  // First-mount gate: the very first run uses a 0-ms timeout so the initial
  // viewport prefetches without the debounce. Subsequent runs debounce.
  const didMount = useRef(false);
  // Min-interval throttle: timestamp of the last successful invoke. Bounded
  // to <=1 batch/sec regardless of how often scroll settles.
  const lastFireRef = useRef(0);
  // Mirror `threads` into a ref so the timeout reads the freshest array WITHOUT
  // `threads` being in the effect's dep array. Reason: `threadStore.patchSnippets`
  // (Task 4) replaces `threads` with a new array reference on every snippet
  // patch; if `threads` were a dep, that would re-fire this effect in a loop.
  // The ref is updated in a dedicated effect (NOT during render — that is a
  // React anti-pattern flagged by `react-hooks/refs`).
  const threadsRef = useRef(threads);
  useEffect(() => {
    threadsRef.current = threads;
  }, [threads]);

  useEffect(() => {
    if (!isTauriEnv() || !accountId) return;

    // Effective delay: 0 ms on the very first mount; otherwise the larger of
    // the debounce window and the remaining throttle window. Guard the
    // (Date.now() < lastFireRef.current) case (e.g. system clock jumped back)
    // by falling back to DEBOUNCE_MS so we never compute a negative delay.
    const isFirst = !didMount.current;
    didMount.current = true;
    let delay: number;
    if (isFirst) {
      delay = 0;
    } else {
      const elapsed = Date.now() - lastFireRef.current;
      delay = Math.max(DEBOUNCE_MS, MIN_INTERVAL_MS - elapsed);
      if (!Number.isFinite(delay) || delay < 0) delay = DEBOUNCE_MS;
    }

    const handle = window.setTimeout(() => {
      void (async () => {
        // Read the freshest threads via the ref (NOT a dep — see above).
        // Prefer the live store array when the caller is wired to threadStore
        // (production); fall back to the prop (unit tests that don't seed the
        // store). Both paths see the same data in production.
        const storeThreads = useThreadStore.getState().threads;
        const liveThreads =
          storeThreads && storeThreads.length > 0 ? storeThreads : threadsRef.current;
        if (liveThreads.length === 0) return;

        // Rate-limit gate.
        if (useUIStore.getState().rateLimitedAccountIds.has(accountId)) return;

        const visible = virtualizer.getVirtualItems();
        if (visible.length === 0) return;
        const firstIdx = Math.max(0, visible[0]!.index - VIEWPORT_BUFFER);
        const lastIdx = Math.min(
          liveThreads.length - 1,
          visible[visible.length - 1]!.index + VIEWPORT_BUFFER,
        );

        // Map visible thread rows to their latest message_id. Phase 0:
        // thread.id == message_id, so the latest message_id is thread.id.
        // (When real conversation threading lands, expose latest_message_id
        // on the Thread type — see Deferred in the file header.)
        const candidateIds: string[] = [];
        for (let i = firstIdx; i <= lastIdx; i++) {
          const t = liveThreads[i];
          if (t) candidateIds.push(t.id);
          if (candidateIds.length >= MAX_PREFETCH) break;
        }
        if (candidateIds.length === 0) return;

        // Filter to uncached only — don't re-request what we already have.
        let uncached: string[];
        try {
          uncached = await getUncachedBodyMessageIds(accountId, candidateIds);
        } catch (e) {
          console.error('[prefetch] getUncachedBodyMessageIds failed', e);
          return;
        }
        if (uncached.length === 0) return;

        try {
          await invoke('sync_request_bodies', {
            accountId,
            messageIds: uncached,
          });
          // Throttle bookkeeping: stamp the moment a batch successfully went
          // out so the next fire is delayed by the remaining MIN_INTERVAL_MS.
          lastFireRef.current = Date.now();
        } catch (e) {
          console.error('[prefetch] sync_request_bodies failed', e);
        }
        // The store patch happens via the sync:bodies-written listener
        // (Task 4). No supersede token — see the file-header rationale.
      })();
    }, delay);

    return () => {
      window.clearTimeout(handle);
    };
    // Deliberately exclude `threads` — read via threadsRef / store instead.
    // (See the hook doc-comment + threadsRef rationale above.)
  }, [virtualizer, accountId]);
}
