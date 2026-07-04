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
// The setup effect depends on `[virtualizer, accountId, items.length]`.
//   • `accountId` re-runs setup on folder/account switch.
//   • `items.length` (a PRIMITIVE) re-runs setup when loadThreads lands.
//     We deliberately do NOT depend on the `items` array itself —
//     `threadStore.patchSnippets` swaps the underlying threads array on every snippet
//     patch, which would re-run this effect in a loop. `items.length` only
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
import { useUIStore } from '../stores/uiStore';
import { getUncachedBodyMessageIds } from '../services/db/messages';
import type { Thread } from '../services/db/threads';

type ListItem = { kind: 'group'; label: string } | { kind: 'thread'; thread: Thread };

interface Options {
  virtualizer: Virtualizer<HTMLDivElement, Element>;
  /** Virtualized list items (threads interleaved with optional group headers). */
  items: ListItem[];
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

/**
 * Viewport-aware batch body prefetch. Skipped entirely when the account is
 * rate-limited (Phase 3f) — prefetch is low-priority and the next poll will
 * fill the cache.
 */
export function useViewportBodyPrefetch({ virtualizer, items, accountId }: Options): void {
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
  // Mirror `items` into a ref so the timeout reads the freshest list WITHOUT
  // `items` being in the effect's dep array. Reason: `patchSnippets`
  // replaces the underlying threads with a new array reference on every snippet
  // patch; if `items` were a dep, that would re-fire this effect in a loop.
  // The ref is updated in a dedicated effect (NOT during render — React anti-pattern).
  const itemsRef = useRef(items);
  useEffect(() => {
    itemsRef.current = items;
  }, [items]);

  useEffect(() => {
    if (!isTauriEnv() || !accountId) return;

    // Run one prefetch batch against the CURRENT viewport + list state.
    const runBatch = async (): Promise<void> => {
      const liveItems = itemsRef.current;
      if (liveItems.length === 0) return;

      // Rate-limit gate.
      if (useUIStore.getState().rateLimitedAccountIds.has(accountId)) return;

      const visible = virtualizer.getVirtualItems();
      if (visible.length === 0) return;
      const firstIdx = Math.max(0, visible[0]!.index - VIEWPORT_BUFFER);
      const lastIdx = Math.min(
        liveItems.length - 1,
        visible[visible.length - 1]!.index + VIEWPORT_BUFFER,
      );

      // Map visible rows to their latest message_id. Group headers are skipped.
      // Phase 0: thread.id == message_id, so the latest message_id is thread.id.
      const candidateIds: string[] = [];
      for (let i = firstIdx; i <= lastIdx; i++) {
        const item = liveItems[i];
        if (item?.kind === 'thread') candidateIds.push(item.thread.id);
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
    };

    // Coalesce rapid triggers (scroll storm + setup) into a single batch fired
    // once things settle. If a batch is already pending, ignore further
    // triggers — the pending one will read the freshest state when it fires.
    const scheduleBatch = (forceImmediate: boolean): void => {
      if (pendingTimerRef.current != null) return;
      let delay: number;
      if (forceImmediate) {
        delay = 0;
      } else {
        const elapsed = Date.now() - lastFireRef.current;
        delay = Math.max(DEBOUNCE_MS, MIN_INTERVAL_MS - elapsed);
        if (!Number.isFinite(delay) || delay < 0) delay = DEBOUNCE_MS;
      }
      pendingTimerRef.current = window.setTimeout(() => {
        pendingTimerRef.current = null;
        void runBatch();
      }, delay);
    };

    // Fire once for the current viewport on setup. Immediate (0 ms) on the
    // very first mount ever; debounced thereafter. Re-running setup when
    // `items.length` changes (below) is what makes prefetch fire AFTER
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
    // `items.length` (primitive) fires setup when items load or the folder
    // changes. NOT `items` (patchSnippets swaps its underlying array per snippet).
  }, [virtualizer, accountId, items.length]);
}
