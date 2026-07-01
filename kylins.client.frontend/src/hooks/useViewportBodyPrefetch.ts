// Viewport-aware batch body prefetch. Fires in three situations:
//   1. on mount / folder-switch (debounced),
//   2. when threads FINISH LOADING (the store transitions 0 → N — critical,
//      because loadThreads is async and at mount time the store is still
//      empty),
//   3. when the user scrolls (debounced, <=1 batch/sec).
//
// For each fire we compute the visible+buffer rows, map each to its
// message_id, filter via `getUncachedBodyMessageIds`, and invoke
// `sync_request_bodies` once. Best-effort: late-arriving batches still
// usefully fill the cache and patch snippets (patches are idempotent).
//
// ── Why the trigger surface is what it is ──────────────────────────────
// The setup effect depends on `[virtualizer, accountId, threads.length]`.
//   • `accountId` re-runs setup on folder/account switch.
//   • `threads.length` (a PRIMITIVE) re-runs setup when loadThreads lands.
//     We deliberately do NOT depend on the `threads` array itself —
//     `threadStore.patchSnippets` swaps the array reference on every snippet
//     patch, which would re-run this effect in a loop. `threads.length` only
//     changes when the count actually changes.
//   • The @tanstack/react-virtual `virtualizer` reference is STABLE across
//     scrolls — scrolling mutates its internal measurement state, not the
//     reference — so a scroll listener on the scroll element (attached in
//     setup, NOT a dep) is the only way to observe scroll. We reach the
//     scroll element via `virtualizer.options.getScrollElement()`.
//
// Robustness:
//   - First mount fires IMMEDIATELY (0-ms timeout) so the initial viewport
//     can prefetch on the next tick. Subsequent triggers keep the debounce.
//   - A min-interval throttle bounds the rate to <=1 batch/sec even when
//     scroll settles repeatedly inside one second (server-load guard).
//   - One pending timer at a time: a fast scroll storm coalesces into a
//     single batch fired once it settles.
//   - No supersede token: a late-arriving batch fired during fast scroll
//     still usefully fills the cache. Patches are idempotent (INSERT OR
//     REPLACE on the body; in-place map on the store), so applying a
//     "stale" result is correct, not a bug.
//
// Phase 0 (one thread per message): thread.id IS the message_id, so the
// "latest message_id for the thread" is just thread.id. When real
// conversation threading lands, expose `latest_message_id` on the Thread
// type and switch the mapping below (see `message-list-architecture.md`).

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
 * a fast scroll storm can't flood the IMAP server. */
const MIN_INTERVAL_MS = 1000;

/** Live Tauri check — read at effect time, NOT module load. The hook is
 * imported by tests that set `window.__TAURI_INTERNALS__` in `beforeEach`
 * (after import), so a module-level `const` would snapshot the pre-test value
 * (false) and never see the test's override. Reading inside the effect keeps
 * the no-op-outside-Tauri guarantee while staying testable. */
function isTauriEnv(): boolean {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
}

/** TEMPORARY diagnostic flag (body-prefetch not firing). Sprays a log at every
 * decision point so the browser console shows exactly where the hook stops.
 * Remove once the failure is localized. */
const PREFETCH_DEBUG = true;
function dbg(...args: unknown[]): void {
  if (PREFETCH_DEBUG) console.log('[prefetch]', ...args);
}

/**
 * Viewport-aware batch body prefetch. Skipped entirely when the account is
 * rate-limited (Phase 3f) — prefetch is low-priority and the next poll will
 * fill the cache.
 */
export function useViewportBodyPrefetch({ virtualizer, threads, accountId }: Options): void {
  // First-mount gate: the very first setup uses a 0-ms timeout so the initial
  // viewport prefetches on the next tick. Subsequent setups debounce.
  const didMountRef = useRef(false);
  // Min-interval throttle: timestamp of the last successful invoke. Bounded
  // to <=1 batch/sec regardless of how often scroll settles.
  const lastFireRef = useRef(0);
  // At most one pending batch timer. Setup + every scroll tick funnel through
  // `scheduleBatch`, which is a no-op if a batch is already pending — the
  // pending batch reads the freshest viewport + store state when it fires.
  const pendingTimerRef = useRef<number | null>(null);
  // Mirror `threads` into a ref so the timeout reads the freshest array
  // WITHOUT `threads` being in the effect's dep array. Reason: `patchSnippets`
  // replaces `threads` with a new array reference on every snippet patch; if
  // `threads` were a dep, that would re-fire this effect in a loop. The ref
  // is updated in a dedicated effect (NOT during render — React anti-pattern).
  const threadsRef = useRef(threads);
  useEffect(() => {
    threadsRef.current = threads;
  }, [threads]);

  useEffect(() => {
    const tauri = isTauriEnv();
    dbg('effect run', { tauri, accountId, threadsLen: threads.length });
    if (!tauri || !accountId) {
      dbg('effect: bailed (no tauri or no accountId)');
      return;
    }

    // Run one prefetch batch against the CURRENT viewport + store state.
    const runBatch = async (): Promise<void> => {
      // Prefer the live store array when the caller is wired to threadStore
      // (production); fall back to the prop (unit tests that don't seed the
      // store). Both paths see the same data in production.
      const storeThreads = useThreadStore.getState().threads;
      const liveThreads =
        storeThreads && storeThreads.length > 0 ? storeThreads : threadsRef.current;
      dbg('runBatch entry', { storeLen: storeThreads?.length ?? 0, liveLen: liveThreads.length });
      if (liveThreads.length === 0) {
        dbg('runBatch: liveThreads empty, skip');
        return;
      }

      // Rate-limit gate.
      if (useUIStore.getState().rateLimitedAccountIds.has(accountId)) {
        dbg('runBatch: rate-limited, skip');
        return;
      }

      const visible = virtualizer.getVirtualItems();
      dbg('runBatch: visible items', visible.length);
      if (visible.length === 0) return;
      const firstIdx = Math.max(0, visible[0]!.index - VIEWPORT_BUFFER);
      const lastIdx = Math.min(
        liveThreads.length - 1,
        visible[visible.length - 1]!.index + VIEWPORT_BUFFER,
      );

      // Map visible thread rows to their latest message_id. Phase 0:
      // thread.id == message_id, so the latest message_id is thread.id.
      const candidateIds: string[] = [];
      for (let i = firstIdx; i <= lastIdx; i++) {
        const t = liveThreads[i];
        if (t) candidateIds.push(t.id);
        if (candidateIds.length >= MAX_PREFETCH) break;
      }
      dbg('runBatch: candidates', { firstIdx, lastIdx, count: candidateIds.length });
      if (candidateIds.length === 0) return;

      // Filter to uncached only — don't re-request what we already have.
      let uncached: string[];
      try {
        uncached = await getUncachedBodyMessageIds(accountId, candidateIds);
      } catch (e) {
        console.error('[prefetch] getUncachedBodyMessageIds failed', e);
        return;
      }
      dbg('runBatch: uncached', uncached.length, uncached.slice(0, 3));
      if (uncached.length === 0) {
        dbg('runBatch: all cached, skip invoke');
        return;
      }

      try {
        dbg('invoke sync_request_bodies', { accountId, count: uncached.length });
        await invoke('sync_request_bodies', {
          accountId,
          messageIds: uncached,
        });
        dbg('invoke ok');
        // Throttle bookkeeping: stamp the moment a batch successfully went
        // out so the next fire is delayed by the remaining MIN_INTERVAL_MS.
        lastFireRef.current = Date.now();
      } catch (e) {
        console.error('[prefetch] sync_request_bodies failed', e);
      }
      // The store patch happens via the sync:bodies-written listener
      // (Task 4). No supersede token — see the file-header rationale.
    };

    // Coalesce rapid triggers (scroll storm + setup) into a single batch fired
    // once things settle. If a batch is already pending, ignore further
    // triggers — the pending one will read the freshest state when it fires.
    const scheduleBatch = (forceImmediate: boolean): void => {
      if (pendingTimerRef.current != null) {
        dbg('scheduleBatch: already pending, skip');
        return;
      }
      let delay: number;
      if (forceImmediate) {
        delay = 0;
      } else {
        const elapsed = Date.now() - lastFireRef.current;
        delay = Math.max(DEBOUNCE_MS, MIN_INTERVAL_MS - elapsed);
        if (!Number.isFinite(delay) || delay < 0) delay = DEBOUNCE_MS;
      }
      dbg('scheduleBatch', { forceImmediate, delay });
      pendingTimerRef.current = window.setTimeout(() => {
        pendingTimerRef.current = null;
        void runBatch();
      }, delay);
    };

    // Fire once for the current viewport on setup. Immediate (0 ms) on the
    // very first mount ever; debounced thereafter. Re-running setup when
    // `threads.length` changes (below) is what makes prefetch fire AFTER
    // loadThreads populates the store.
    const isFirst = !didMountRef.current;
    didMountRef.current = true;
    scheduleBatch(isFirst);

    // Observe scroll. The virtualizer reference is stable across scrolls, so
    // a listener on the scroll container (not a dep) is required. Reach the
    // container via the options the parent passed to useVirtualizer. Guarded
    // because unit-test stubs don't expose `.options`.
    const opts = (
      virtualizer as unknown as {
        options?: { getScrollElement?: () => HTMLDivElement | null };
      }
    ).options;
    const getScrollEl = opts?.getScrollElement;
    const scrollEl = typeof getScrollEl === 'function' ? getScrollEl() : null;
    dbg('scroll listener', {
      hasOptions: !!opts,
      hasFn: typeof getScrollEl === 'function',
      attached: !!scrollEl,
    });
    const onScroll = (): void => scheduleBatch(false);
    if (scrollEl) {
      scrollEl.addEventListener('scroll', onScroll, { passive: true });
    }

    return () => {
      if (scrollEl) {
        scrollEl.removeEventListener('scroll', onScroll);
      }
      if (pendingTimerRef.current != null) {
        window.clearTimeout(pendingTimerRef.current);
        pendingTimerRef.current = null;
      }
    };
    // `threads.length` (primitive) fires setup when threads load or the folder
    // changes. NOT `threads` (patchSnippets swaps its reference per snippet).
  }, [virtualizer, accountId, threads.length]);
}
